#!/usr/bin/env python3
"""Safely transport a fifth-advisor prompt and protect ignored secret paths."""

from __future__ import annotations

import argparse
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from typing import Dict, List, Optional, Tuple, Union


PROMPT_NAME = "prompt"
SNAPSHOT_NAME = "protected-snapshot.json"
SESSION_INTENT_NAME = "ephemeral-session-intent.json"
WORKSPACE_RECEIPT_NAME = "ephemeral-workspace-receipt.json"
AGENT_START_INTENT_NAME = "ephemeral-agent-start-intent.json"
AGENT_RECEIPT_NAME = "ephemeral-agent-receipt.json"
SEND_RECEIPT_NAME = "ephemeral-send-receipt.json"
CLOSED_RECEIPT_NAME = "ephemeral-session-closed.json"
PROCESS_MISMATCH_RECEIPT_NAME = "ephemeral-process-mismatch.json"
ATOMIC_RECORD_NAMES = frozenset(
    {
        SNAPSHOT_NAME,
        SESSION_INTENT_NAME,
        WORKSPACE_RECEIPT_NAME,
        AGENT_START_INTENT_NAME,
        AGENT_RECEIPT_NAME,
        SEND_RECEIPT_NAME,
        CLOSED_RECEIPT_NAME,
        PROCESS_MISMATCH_RECEIPT_NAME,
    }
)
ATOMIC_RECORD_STAGE_SUFFIX = ".pending"
DARWIN_RENAME_EXCL = 0x00000004
DARWIN_RENAME_NOFOLLOW_ANY = 0x00000010
PROMPT_WAIT_MS = 120_000
PROMPT_SOCKET_TIMEOUT_SECONDS = 130
MAX_PROMPT_BYTES = 2 * 1024 * 1024
MAX_SOCKET_REQUEST_BYTES = 4 * 1024 * 1024
MAX_SOCKET_RESPONSE_BYTES = 1024 * 1024
MAX_SNAPSHOT_BYTES = 1_048_576
MAX_WALK_DEPTH = 64
PROTECTED_SNAPSHOT_VERSION = 4
PROTECTED_POLICY = "protected-components-v1"
PROTECTED_DIGEST_ALGORITHM = "sha256"
PROTECTED_DIGEST_DOMAIN = b"herdr-fifth-advisor-protected-metadata-v4\0"
EPHEMERAL_SESSION_VERSION = 2
PROCESS_MISMATCH_VERSION = 2
PROCESS_MISMATCH_POLICY = "claude-process-identity-mismatch-v2"
AGENT_START_STATE_PROTOCOL = "durable-agent-start-intent-v1"
MAX_SESSION_STATE_BYTES = 131_072
MAX_PROCESS_MISMATCH_BYTES = 65_536
MAX_PROCESS_COUNT = 32
MAX_DIAGNOSTIC_ARGUMENTS = 8
MAX_DIAGNOSTIC_STRING_CHARS = 512
HERDR_COMMAND_TIMEOUT_SECONDS = 20
CLAUDE_START_TIMEOUT_MS = 300_000
CLAUDE_START_PROCESS_TIMEOUT_SECONDS = 310
CLAUDE_SETTLE_TIMEOUT_SECONDS = 120
PROVISIONAL_RECONCILE_SECONDS = 30
CLAUDE_ARGUMENTS = (
    "--dangerously-skip-permissions",
    "--safe-mode",
    "--no-chrome",
    "--disable-slash-commands",
)
CLAUDE_OBSERVED_ARGUMENT_FORMS = (
    CLAUDE_ARGUMENTS,
    ("--effort", "max", *CLAUDE_ARGUMENTS),
)
OWNED_PROCESS_IDENTITY_KEYS = (
    "shell_pid",
    "claude_pid",
    "process_group_id",
    "argv",
    "argv0",
    "executable",
)
OPEN_TERMINATION_SIGNALS = (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)
_HERDR_CHILD_SIGNALS_PROTECTED = False


class UnsafeRequest(ValueError):
    """The required fifth-advisor attempt cannot safely continue."""


class _ClaudeInvocationMismatch(UnsafeRequest):
    """Carry a bounded mismatch observation without exposing raw process values."""

    __slots__ = (
        "diagnostic",
        "process_group_id",
        "process_ids",
        "diagnostic_recorded",
    )

    def __init__(
        self,
        diagnostic: Dict[str, object],
        process_ids: List[int],
        process_group_id: int,
    ) -> None:
        super().__init__("ephemeral Claude executable arguments are not exact")
        self.diagnostic = diagnostic
        self.process_ids = list(process_ids)
        self.process_group_id = process_group_id
        self.diagnostic_recorded: Optional[bool] = None

    def __str__(self) -> str:
        message = str(self.args[0])
        if self.diagnostic_recorded is True:
            return f"{message}; sanitized diagnostic receipt recorded"
        if self.diagnostic_recorded is False:
            return f"{message}; diagnostic receipt could not be recorded safely"
        return message

    def __repr__(self) -> str:
        return "_ClaudeInvocationMismatch(<redacted>)"


class _OpenSignal(BaseException):
    """A termination signal received while an ephemeral workspace may exist."""

    def __init__(self, signum: int) -> None:
        super().__init__(signum)
        self.signum = signum
        self.cleanup_attempted = False
        self.cleanup_error: Optional[BaseException] = None


class _PreparedSend:
    __slots__ = ("request", "request_id", "socket_path", "marker_line", "target")

    def __init__(
        self,
        *,
        request: bytes,
        request_id: str,
        socket_path: str,
        marker_line: str,
        target: str,
    ) -> None:
        self.request = request
        self.request_id = request_id
        self.socket_path = socket_path
        self.marker_line = marker_line
        self.target = target

    def __repr__(self) -> str:
        return "_PreparedSend(request=<redacted>)"


def _same_owned_process_identity(
    observed: Dict[str, object], recorded: Dict[str, object]
) -> bool:
    return all(
        observed.get(key) == recorded.get(key)
        for key in OWNED_PROCESS_IDENTITY_KEYS
    )


def _valid_executable_metadata(value: object, *, kinds: Tuple[str, ...]) -> bool:
    expected_keys = {
        "kind",
        "file_type",
        "mode",
        "uid",
        "gid",
        "nlink",
        "size",
        "dev",
        "ino",
        "rdev",
        "mtime_ns",
        "ctime_ns",
    }
    return (
        isinstance(value, dict)
        and set(value) == expected_keys
        and value.get("kind") in kinds
        and all(
            type(value.get(key)) is int
            for key in expected_keys - {"kind"}
        )
        and int(value.get("nlink", 0)) >= 1
        and int(value.get("dev", 0)) >= 0
        and int(value.get("ino", 0)) > 0
    )


def _valid_executable_identity(value: object) -> bool:
    if not isinstance(value, dict) or set(value) != {
        "lookup_path",
        "lookup_metadata",
        "resolved_path",
        "resolved_metadata",
    }:
        return False
    lookup_path = value.get("lookup_path")
    resolved_path = value.get("resolved_path")
    if (
        not isinstance(lookup_path, str)
        or not isinstance(resolved_path, str)
        or not Path(lookup_path).is_absolute()
        or not Path(resolved_path).is_absolute()
        or "\x00" in lookup_path
        or "\x00" in resolved_path
    ):
        return False
    return _valid_executable_metadata(
        value.get("lookup_metadata"), kinds=("regular", "symlink")
    ) and _valid_executable_metadata(
        value.get("resolved_metadata"), kinds=("regular",)
    )


def _valid_claude_invocation(
    argv: object,
    argv0: object,
    executable: object,
) -> bool:
    if (
        not isinstance(argv, list)
        or not all(isinstance(value, str) for value in argv)
        or tuple(argv[1:]) not in CLAUDE_OBSERVED_ARGUMENT_FORMS
        or argv0 != "claude"
        or not _valid_executable_identity(executable)
    ):
        return False
    assert isinstance(executable, dict)
    return argv[0] in {
        "claude",
        executable["lookup_path"],
        executable["resolved_path"],
    }


def _valid_recorded_process_ids(receipt: Dict[str, object]) -> bool:
    process_ids = receipt.get("process_ids")
    if (
        not isinstance(process_ids, list)
        or not process_ids
        or len(process_ids) > 32
        or any(type(process_id) is not int or process_id <= 1 for process_id in process_ids)
        or process_ids != sorted(set(process_ids))
    ):
        return False
    return (
        all(
            type(receipt.get(key)) is int and receipt.get(key) in process_ids
            for key in ("shell_pid", "claude_pid")
        )
        and type(receipt.get("process_group_id")) is int
        and int(receipt["process_group_id"]) > 1
        and int(receipt["process_group_id"]) != os.getpgrp()
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Safely send a Herdr fifth-advisor prompt and compare protected "
            "worktree metadata without reading protected file contents."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in (
        "snapshot", "verify", "open", "close", "recover", "diagnose"
    ):
        child = subparsers.add_parser(command)
        child.add_argument("--project-root", required=True)
        child.add_argument("--request-dir", required=True)
    send = subparsers.add_parser("send")
    send.add_argument("--project-root", required=True)
    send.add_argument("--request-dir", required=True)
    send.add_argument("--owned", action="store_true", required=True)
    return parser.parse_args()


def _directory_flags() -> int:
    required = ("O_DIRECTORY", "O_NOFOLLOW")
    if any(not hasattr(os, name) for name in required):
        raise UnsafeRequest("required no-follow directory operations are unavailable")
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


def _close_descriptors(*descriptors: Union[int, None]) -> None:
    first_error = None
    for descriptor in descriptors:
        if descriptor is None:
            continue
        try:
            os.close(descriptor)
        except Exception as error:
            if first_error is None:
                first_error = error
    if first_error is not None:
        raise UnsafeRequest("send preflight descriptors could not be closed") from first_error


def _open_physical_directory(path: Path) -> Tuple[int, Path]:
    if not path.is_absolute() or ".." in path.parts:
        raise UnsafeRequest("directory paths must be absolute without '..'")
    try:
        supplied = path.lstat()
        physical = path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise UnsafeRequest("directory cannot be resolved safely") from error
    if not stat.S_ISDIR(supplied.st_mode) or stat.S_ISLNK(supplied.st_mode):
        raise UnsafeRequest("the supplied directory must not be a symlink")

    anchor = Path(physical.anchor)
    descriptor = os.open(anchor, _directory_flags())
    try:
        for part in physical.relative_to(anchor).parts:
            next_descriptor = os.open(
                part,
                _directory_flags(),
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (supplied.st_dev, supplied.st_ino)
        ):
            raise UnsafeRequest("directory changed while it was opened")
        return descriptor, physical
    except BaseException:
        os.close(descriptor)
        raise


def _owner_request_directory(path_text: str) -> Tuple[int, Path]:
    descriptor, physical = _open_physical_directory(Path(path_text))
    metadata = os.fstat(descriptor)
    try:
        if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
            raise UnsafeRequest("request directory must be owner-owned mode 0700")
        return descriptor, physical
    except BaseException:
        os.close(descriptor)
        raise


def _request_directory(path_text: str, project_root: Path) -> Tuple[int, Path]:
    descriptor, physical = _owner_request_directory(path_text)
    try:
        try:
            physical.relative_to(project_root)
        except ValueError:
            pass
        else:
            raise UnsafeRequest("request directory must be outside the project worktree")
        return descriptor, physical
    except BaseException:
        os.close(descriptor)
        raise


def _git_binary() -> str:
    candidate = shutil.which("git")
    if candidate is None:
        raise UnsafeRequest("Git is unavailable")
    try:
        resolved = Path(candidate).resolve(strict=True)
    except OSError as error:
        raise UnsafeRequest("Git cannot be resolved safely") from error
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise UnsafeRequest("Git is not an executable regular file")
    return str(resolved)


def _run_git(root: Path, arguments: List[str]) -> bytes:
    try:
        result = subprocess.run(
            [_git_binary(), "-C", str(root), *arguments],
            cwd="/",
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise UnsafeRequest("Git metadata acquisition failed") from error
    if result.returncode != 0:
        raise UnsafeRequest("Git metadata acquisition failed")
    return result.stdout


def _physical_git_root(path_text: str) -> Tuple[int, Path]:
    descriptor, physical = _open_physical_directory(Path(path_text))
    try:
        raw_root = _run_git(physical, ["rev-parse", "--show-toplevel"])
        decoded = os.fsdecode(raw_root.rstrip(b"\r\n"))
        if not decoded:
            raise UnsafeRequest("project is not a Git worktree")
        reported = Path(decoded).resolve(strict=True)
        if reported != physical:
            raise UnsafeRequest("project root must be the physical Git worktree root")
        return descriptor, physical
    except BaseException:
        os.close(descriptor)
        raise


def _is_protected_component(name: str) -> bool:
    folded = name.casefold()
    if folded in {"sessions", "logs", "memories"}:
        return True
    if folded.startswith(".env"):
        return True
    if any(
        fragment in folded
        for fragment in ("auth", "credential", "token", "secret")
    ):
        return True
    if folded in {
        "history.jsonl",
        "active_sessions.json",
        "models_cache.json",
        "sandbox-events.jsonl",
    }:
        return True
    if folded.endswith((".sqlite", ".sqlite3", ".db", ".sock")):
        return True
    return folded.startswith("herdr") and folded.endswith(".log")


def _metadata(metadata: os.stat_result) -> Dict[str, Union[int, str]]:
    file_type = stat.S_IFMT(metadata.st_mode)
    if stat.S_ISREG(metadata.st_mode):
        kind = "regular"
    elif stat.S_ISDIR(metadata.st_mode):
        kind = "directory"
    elif stat.S_ISLNK(metadata.st_mode):
        kind = "symlink"
    elif stat.S_ISFIFO(metadata.st_mode):
        kind = "fifo"
    elif stat.S_ISSOCK(metadata.st_mode):
        kind = "socket"
    elif stat.S_ISCHR(metadata.st_mode):
        kind = "character-device"
    elif stat.S_ISBLK(metadata.st_mode):
        kind = "block-device"
    else:
        if file_type == 0:
            raise UnsafeRequest("protected path type metadata is invalid")
        kind = f"special-{file_type:o}"
    if not stat.S_ISDIR(metadata.st_mode) and metadata.st_nlink != 1:
        raise UnsafeRequest("protected non-directory paths must have link count one")
    return {
        "kind": kind,
        "file_type": file_type,
        "mode": stat.S_IMODE(metadata.st_mode),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "nlink": metadata.st_nlink,
        "size": metadata.st_size,
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "rdev": metadata.st_rdev,
        "mtime_ns": metadata.st_mtime_ns,
        "ctime_ns": metadata.st_ctime_ns,
    }


def _update_protected_digest(
    digest: "hashlib._Hash",
    relative: str,
    metadata: Dict[str, Union[int, str]],
) -> None:
    record = json.dumps(
        {"metadata": metadata, "path": relative},
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")
    digest.update(len(record).to_bytes(8, "big"))
    digest.update(record)


def _same_directory_metadata(
    expected: os.stat_result,
    observed: os.stat_result,
) -> bool:
    return (
        stat.S_ISDIR(observed.st_mode)
        and _metadata(expected) == _metadata(observed)
    )


def _filesystem_protected_digest(root_descriptor: int) -> Tuple[int, str]:
    digest = hashlib.sha256()
    digest.update(PROTECTED_DIGEST_DOMAIN)
    protected_count = 0

    def visit(
        descriptor: int,
        prefix: Tuple[str, ...],
        protected_ancestor: bool,
    ) -> None:
        nonlocal protected_count
        try:
            directory_before = os.fstat(descriptor)
        except OSError as error:
            raise UnsafeRequest("worktree directory metadata is unavailable") from error
        if not stat.S_ISDIR(directory_before.st_mode):
            raise UnsafeRequest("worktree directory changed during inventory")
        try:
            names = sorted(os.listdir(descriptor), key=os.fsencode)
        except OSError as error:
            raise UnsafeRequest("worktree metadata inventory failed") from error
        for name in names:
            if not prefix and name == ".git":
                continue
            parts = (*prefix, name)
            try:
                metadata = os.stat(
                    name,
                    dir_fd=descriptor,
                    follow_symlinks=False,
                )
            except OSError as error:
                raise UnsafeRequest("worktree metadata inventory raced") from error
            protected = protected_ancestor or _is_protected_component(
                name.casefold()
            )
            if protected:
                protected_metadata = _metadata(metadata)
                _update_protected_digest(
                    digest,
                    "/".join(parts),
                    protected_metadata,
                )
                protected_count += 1
            if not stat.S_ISDIR(metadata.st_mode):
                if protected:
                    try:
                        observed = os.stat(
                            name,
                            dir_fd=descriptor,
                            follow_symlinks=False,
                        )
                    except OSError as error:
                        raise UnsafeRequest(
                            "protected path metadata changed during inventory"
                        ) from error
                    if protected_metadata != _metadata(observed):
                        raise UnsafeRequest(
                            "protected path metadata changed during inventory"
                        )
                continue
            if len(parts) > MAX_WALK_DEPTH:
                raise UnsafeRequest("worktree metadata inventory is too deep")
            child = None
            try:
                child = os.open(name, _directory_flags(), dir_fd=descriptor)
                opened = os.fstat(child)
            except OSError as error:
                if child is not None:
                    os.close(child)
                raise UnsafeRequest("worktree directory cannot be opened safely") from error
            try:
                if not _same_directory_metadata(metadata, opened):
                    raise UnsafeRequest("worktree directory changed while opening")
                visit(child, parts, protected)
            finally:
                os.close(child)
            try:
                observed = os.stat(
                    name,
                    dir_fd=descriptor,
                    follow_symlinks=False,
                )
            except OSError as error:
                raise UnsafeRequest("worktree metadata inventory raced") from error
            if not _same_directory_metadata(metadata, observed):
                raise UnsafeRequest("worktree directory changed during inventory")
        try:
            directory_after = os.fstat(descriptor)
        except OSError as error:
            raise UnsafeRequest("worktree directory metadata is unavailable") from error
        if not _same_directory_metadata(directory_before, directory_after):
            raise UnsafeRequest("worktree directory changed during inventory")

    visit(root_descriptor, tuple(), False)
    return protected_count, digest.hexdigest()


def _protected_snapshot(root_descriptor: int, root: Path) -> Dict[str, object]:
    root_metadata = os.fstat(root_descriptor)
    protected_count, protected_digest = _filesystem_protected_digest(root_descriptor)
    return {
        "version": PROTECTED_SNAPSHOT_VERSION,
        "policy": PROTECTED_POLICY,
        "digest_algorithm": PROTECTED_DIGEST_ALGORITHM,
        "project_root": str(root),
        "project_root_dev": root_metadata.st_dev,
        "project_root_ino": root_metadata.st_ino,
        "protected_count": protected_count,
        "protected_metadata_digest": protected_digest,
    }


def _regular_read(
    directory_descriptor: int,
    name: str,
    maximum: int,
    *,
    require_mode: int,
) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
    if not hasattr(os, "O_NOFOLLOW"):
        raise UnsafeRequest("required no-follow file operations are unavailable")
    flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(name, flags, dir_fd=directory_descriptor)
    except OSError as error:
        raise UnsafeRequest("required request file cannot be opened safely") from error
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.geteuid()
            or before.st_nlink != 1
            or stat.S_IMODE(before.st_mode) != require_mode
            or not 1 <= before.st_size <= maximum
        ):
            raise UnsafeRequest("required request file is unsafe")
        raw = os.read(descriptor, maximum + 1)
        after = os.fstat(descriptor)
        stable_fields = (
            "st_dev",
            "st_ino",
            "st_mode",
            "st_uid",
            "st_nlink",
            "st_size",
            "st_mtime_ns",
            "st_ctime_ns",
        )
        if len(raw) != before.st_size or any(
            getattr(before, field) != getattr(after, field) for field in stable_fields
        ):
            raise UnsafeRequest("required request file changed while reading")
        return raw
    finally:
        os.close(descriptor)


def _record_stage_name(name: str) -> str:
    if name not in ATOMIC_RECORD_NAMES:
        raise UnsafeRequest("ephemeral record name is not managed")
    return f".{name}{ATOMIC_RECORD_STAGE_SUFFIX}"


@contextmanager
def _record_directory_lock(directory_descriptor: int):
    try:
        fcntl.flock(directory_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        raise UnsafeRequest("ephemeral record publisher is already active") from error
    try:
        yield
    finally:
        fcntl.flock(directory_descriptor, fcntl.LOCK_UN)


def _discard_staged_record_locked(
    directory_descriptor: int,
    stage_name: str,
) -> bool:
    try:
        metadata = os.stat(
            stage_name,
            dir_fd=directory_descriptor,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        return False
    except OSError as error:
        raise UnsafeRequest("staged ephemeral record metadata is unavailable") from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        raise UnsafeRequest("staged ephemeral record is unsafe")
    try:
        os.unlink(stage_name, dir_fd=directory_descriptor)
    except OSError as error:
        raise UnsafeRequest("staged ephemeral record could not be discarded") from error
    return True


def _discard_staged_records(directory_descriptor: int) -> None:
    with _record_directory_lock(directory_descriptor):
        removed = False
        for name in sorted(ATOMIC_RECORD_NAMES):
            removed = _discard_staged_record_locked(
                directory_descriptor,
                _record_stage_name(name),
            ) or removed
        if removed:
            try:
                os.fsync(directory_descriptor)
            except OSError as error:
                raise UnsafeRequest(
                    "discarded record state could not be synchronized"
                ) from error


def _discard_request_staged_records(request_dir: str) -> None:
    request_descriptor, _request = _owner_request_directory(request_dir)
    try:
        _discard_staged_records(request_descriptor)
    finally:
        os.close(request_descriptor)


def _rename_staged_record_no_replace(
    directory_descriptor: int,
    stage_name: str,
    destination_name: str,
) -> None:
    if sys.platform != "darwin":
        raise UnsafeRequest("atomic no-replace record publication is unavailable")
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        rename = libc.renameatx_np
    except (AttributeError, OSError) as error:
        raise UnsafeRequest("atomic no-replace record publication is unavailable") from error
    rename.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    rename.restype = ctypes.c_int
    ctypes.set_errno(0)
    result = rename(
        directory_descriptor,
        os.fsencode(stage_name),
        directory_descriptor,
        os.fsencode(destination_name),
        DARWIN_RENAME_EXCL | DARWIN_RENAME_NOFOLLOW_ANY,
    )
    if result == 0:
        return
    error_number = ctypes.get_errno()
    message = (
        "ephemeral record already exists"
        if error_number == errno.EEXIST
        else "ephemeral record could not be published atomically"
    )
    raise UnsafeRequest(message) from OSError(
        error_number,
        os.strerror(error_number),
    )


def _exclusive_bytes_record(
    directory_descriptor: int,
    name: str,
    raw: bytes,
    maximum: int,
) -> None:
    if not 1 <= len(raw) <= maximum:
        raise UnsafeRequest("ephemeral record exceeds its managed limit")
    stage_name = _record_stage_name(name)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    if not hasattr(os, "O_NOFOLLOW"):
        raise UnsafeRequest("required no-follow file operations are unavailable")
    flags |= os.O_NOFOLLOW
    with _record_directory_lock(directory_descriptor):
        removed = _discard_staged_record_locked(directory_descriptor, stage_name)
        if removed:
            try:
                os.fsync(directory_descriptor)
            except OSError as error:
                raise UnsafeRequest(
                    "discarded record state could not be synchronized"
                ) from error
        try:
            os.stat(
                name,
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            pass
        except OSError as error:
            raise UnsafeRequest("ephemeral record metadata is unavailable") from error
        else:
            raise UnsafeRequest("ephemeral record already exists")

        published = False
        try:
            try:
                descriptor = os.open(
                    stage_name,
                    flags,
                    0o600,
                    dir_fd=directory_descriptor,
                )
            except OSError as error:
                raise UnsafeRequest(
                    "staged ephemeral record cannot be created safely"
                ) from error
            try:
                os.fchmod(descriptor, 0o600)
                view = memoryview(raw)
                while view:
                    written = os.write(descriptor, view)
                    if written <= 0:
                        raise UnsafeRequest(
                            "staged ephemeral record could not be written"
                        )
                    view = view[written:]
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            _rename_staged_record_no_replace(
                directory_descriptor,
                stage_name,
                name,
            )
            published = True
            os.fsync(directory_descriptor)
        except BaseException:
            if not published:
                discarded = _discard_staged_record_locked(
                    directory_descriptor,
                    stage_name,
                )
                if discarded:
                    try:
                        os.fsync(directory_descriptor)
                    except OSError:
                        pass
            raise


def _write_snapshot(directory_descriptor: int, snapshot: Dict[str, object]) -> None:
    raw = (json.dumps(snapshot, ensure_ascii=True, sort_keys=True) + "\n").encode("utf-8")
    if len(raw) > MAX_SNAPSHOT_BYTES:
        raise UnsafeRequest("protected snapshot exceeds its limit")
    _exclusive_bytes_record(
        directory_descriptor,
        SNAPSHOT_NAME,
        raw,
        MAX_SNAPSHOT_BYTES,
    )


def _read_snapshot_document(directory_descriptor: int) -> Dict[str, object]:
    raw = _regular_read(
        directory_descriptor,
        SNAPSHOT_NAME,
        MAX_SNAPSHOT_BYTES,
        require_mode=0o600,
    )
    try:
        snapshot = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UnsafeRequest("protected snapshot state is invalid") from error
    expected_keys = {
        "version",
        "policy",
        "digest_algorithm",
        "project_root",
        "project_root_dev",
        "project_root_ino",
        "protected_count",
        "protected_metadata_digest",
    }
    protected_count = snapshot.get("protected_count") if isinstance(snapshot, dict) else None
    protected_digest = (
        snapshot.get("protected_metadata_digest")
        if isinstance(snapshot, dict)
        else None
    )
    if (
        not isinstance(snapshot, dict)
        or set(snapshot) != expected_keys
        or snapshot.get("version") != PROTECTED_SNAPSHOT_VERSION
        or snapshot.get("policy") != PROTECTED_POLICY
        or snapshot.get("digest_algorithm") != PROTECTED_DIGEST_ALGORITHM
        or not isinstance(snapshot.get("project_root"), str)
        or type(snapshot.get("project_root_dev")) is not int
        or type(snapshot.get("project_root_ino")) is not int
        or type(protected_count) is not int
        or protected_count < 0
        or not isinstance(protected_digest, str)
        or len(protected_digest) != 64
        or any(character not in "0123456789abcdef" for character in protected_digest)
    ):
        raise UnsafeRequest("protected snapshot state is invalid")
    return snapshot


def _load_snapshot(
    directory_descriptor: int,
    project_root: Path,
    project_descriptor: int,
) -> Dict[str, object]:
    snapshot = _read_snapshot_document(directory_descriptor)
    root_metadata = os.fstat(project_descriptor)
    if (
        snapshot.get("project_root") != str(project_root)
        or snapshot.get("project_root_dev") != root_metadata.st_dev
        or snapshot.get("project_root_ino") != root_metadata.st_ino
    ):
        raise UnsafeRequest("protected snapshot state does not match this project")
    return snapshot


def _compare_snapshots(before: Dict[str, object], after: Dict[str, object]) -> bool:
    return (
        before["protected_count"] != after["protected_count"]
        or before["protected_metadata_digest"]
        != after["protected_metadata_digest"]
    )


def _read_prompt(directory_descriptor: int) -> str:
    raw = _regular_read(
        directory_descriptor,
        PROMPT_NAME,
        MAX_PROMPT_BYTES,
        require_mode=0o600,
    )
    try:
        body = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise UnsafeRequest("prompt must be valid UTF-8") from error
    if "\x00" in body or "\r" in body or any(
        (ord(character) < 32 and character not in "\n\t") or ord(character) == 127
        for character in body
    ):
        raise UnsafeRequest("prompt contains unsupported control characters")
    if not body or body[0].isspace() or body[0] in "/!#-":
        raise UnsafeRequest("prompt must begin with ordinary natural-language text")
    return body


def _validate_target(target: str) -> None:
    if (
        not target
        or len(target) > 256
        or target.startswith("-")
        or any(ord(character) < 33 or ord(character) == 127 for character in target)
    ):
        raise UnsafeRequest("target is invalid")


def _herdr_binary() -> str:
    candidate = os.environ.get("HERDR_BIN_PATH")
    if (
        not candidate
        or not os.path.isabs(candidate)
        or candidate != os.path.normpath(candidate)
    ):
        raise UnsafeRequest("pinned Herdr executable is unavailable")
    discovered = shutil.which("herdr")
    if discovered is None or os.path.normpath(discovered) != candidate:
        raise UnsafeRequest("PATH does not resolve the pinned Herdr executable")
    try:
        resolved = Path(candidate).resolve(strict=True)
    except OSError as error:
        raise UnsafeRequest("Herdr cannot be resolved safely") from error
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise UnsafeRequest("Herdr is not an executable regular file")
    return str(resolved)


def _herdr_socket_path() -> str:
    candidate = os.environ.get("HERDR_SOCKET_PATH")
    if (
        not candidate
        or not os.path.isabs(candidate)
        or candidate != os.path.normpath(candidate)
        or "\x00" in candidate
    ):
        raise UnsafeRequest("pinned Herdr socket is unavailable")
    supplied = Path(candidate)
    try:
        parent = supplied.parent.resolve(strict=True)
        physical = parent / supplied.name
        metadata = os.lstat(physical)
    except (OSError, RuntimeError) as error:
        raise UnsafeRequest("Herdr socket cannot be resolved safely") from error
    if (
        str(physical) != candidate
        or not stat.S_ISSOCK(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) & 0o077
    ):
        raise UnsafeRequest("Herdr socket identity is unsafe")
    return candidate


def _exclusive_json_record(
    directory_descriptor: int,
    name: str,
    payload: Dict[str, object],
) -> None:
    raw = (json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n").encode(
        "utf-8"
    )
    _exclusive_bytes_record(
        directory_descriptor,
        name,
        raw,
        MAX_SESSION_STATE_BYTES,
    )


def _write_request_record(
    project_root: str,
    request_dir: str,
    name: str,
    payload: Dict[str, object],
) -> None:
    root_descriptor, root = _physical_git_root(project_root)
    request_descriptor, _request = _request_directory(request_dir, root)
    try:
        _load_snapshot(request_descriptor, root, root_descriptor)
        _exclusive_json_record(request_descriptor, name, payload)
    finally:
        os.close(request_descriptor)
        os.close(root_descriptor)


def _write_process_mismatch_record(
    project_root: str,
    request_dir: str,
    intent: Dict[str, object],
    workspace: Dict[str, object],
    mismatch: _ClaudeInvocationMismatch,
) -> None:
    payload = {
        "version": PROCESS_MISMATCH_VERSION,
        "session_version": EPHEMERAL_SESSION_VERSION,
        "policy": PROCESS_MISMATCH_POLICY,
        "status": "identity-mismatch-before-prompt",
        "nonce": intent["nonce"],
        "agent_name": workspace["agent_name"],
        "workspace_id": workspace["workspace_id"],
        "pane_id": workspace["pane_id"],
        "terminal_id": workspace["terminal_id"],
        "diagnostic": mismatch.diagnostic,
    }
    encoded = (json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n").encode(
        "utf-8"
    )
    if len(encoded) > MAX_PROCESS_MISMATCH_BYTES:
        raise UnsafeRequest("ephemeral process mismatch diagnostic exceeds its limit")
    _write_request_record(
        project_root,
        request_dir,
        PROCESS_MISMATCH_RECEIPT_NAME,
        payload,
    )


def _record_process_mismatch_best_effort(
    project_root: str,
    request_dir: str,
    intent: Dict[str, object],
    workspace: Dict[str, object],
    mismatch: _ClaudeInvocationMismatch,
) -> None:
    try:
        _write_process_mismatch_record(
            project_root,
            request_dir,
            intent,
            workspace,
            mismatch,
        )
    except Exception:
        mismatch.diagnostic_recorded = False
    else:
        mismatch.diagnostic_recorded = True


def _load_request_record(
    project_root: str,
    request_dir: str,
    name: str,
) -> Dict[str, object]:
    root_descriptor, root = _physical_git_root(project_root)
    request_descriptor, _request = _request_directory(request_dir, root)
    try:
        _load_snapshot(request_descriptor, root, root_descriptor)
        return _read_request_record(request_descriptor, name)
    finally:
        os.close(request_descriptor)
        os.close(root_descriptor)


def _read_request_record(
    request_descriptor: int,
    name: str,
) -> Dict[str, object]:
    raw = _regular_read(
        request_descriptor,
        name,
        MAX_SESSION_STATE_BYTES,
        require_mode=0o600,
    )
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UnsafeRequest("ephemeral session state is invalid") from error
    if not isinstance(value, dict):
        raise UnsafeRequest("ephemeral session state is invalid")
    return value


def _read_process_mismatch_record(directory_descriptor: int) -> Dict[str, object]:
    raw = _regular_read(
        directory_descriptor,
        PROCESS_MISMATCH_RECEIPT_NAME,
        MAX_PROCESS_MISMATCH_BYTES,
        require_mode=0o600,
    )
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UnsafeRequest("ephemeral process mismatch receipt is invalid") from error
    if not isinstance(value, dict):
        raise UnsafeRequest("ephemeral process mismatch receipt is invalid")
    return value


def _request_entry_exists(directory_descriptor: int, name: str) -> bool:
    try:
        os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        return False
    except OSError as error:
        raise UnsafeRequest("ephemeral session state cannot be inspected safely") from error
    return True


def _run_herdr(
    arguments: List[str],
    *,
    timeout: int = HERDR_COMMAND_TIMEOUT_SECONDS,
) -> subprocess.CompletedProcess[str]:
    if os.environ.get("HERDR_ENV") != "1":
        raise UnsafeRequest("HERDR_ENV is not active")
    try:
        protect_child = _HERDR_CHILD_SIGNALS_PROTECTED

        def configure_child_signals() -> None:
            handled = set(OPEN_TERMINATION_SIGNALS)
            for signum in OPEN_TERMINATION_SIGNALS:
                signal.signal(
                    signum,
                    signal.SIG_IGN if protect_child else signal.SIG_DFL,
                )
            inherited = signal.pthread_sigmask(signal.SIG_BLOCK, set())
            signal.pthread_sigmask(signal.SIG_SETMASK, set(inherited) - handled)

        result = subprocess.run(
            [_herdr_binary(), *arguments],
            cwd="/",
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
            preexec_fn=configure_child_signals,
            start_new_session=protect_child,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise UnsafeRequest("Herdr lifecycle command failed or timed out") from error
    if len(result.stdout) > 1_048_576 or len(result.stderr) > 65_536:
        raise UnsafeRequest("Herdr lifecycle response exceeds its limit")
    return result


def _json_document(result: subprocess.CompletedProcess[str]) -> Dict[str, object]:
    source = result.stdout.strip() or result.stderr.strip()
    try:
        document = json.loads(source)
    except json.JSONDecodeError as error:
        raise UnsafeRequest("Herdr returned invalid lifecycle JSON") from error
    if not isinstance(document, dict):
        raise UnsafeRequest("Herdr returned invalid lifecycle JSON")
    return document


def _successful_result(result: subprocess.CompletedProcess[str]) -> Dict[str, object]:
    document = _json_document(result)
    value = document.get("result")
    if result.returncode != 0 or not isinstance(value, dict):
        raise UnsafeRequest("Herdr lifecycle command was not successful")
    return value


def _error_code(result: subprocess.CompletedProcess[str]) -> Optional[str]:
    try:
        document = _json_document(result)
    except UnsafeRequest:
        return None
    error = document.get("error")
    code = error.get("code") if isinstance(error, dict) else None
    return code if isinstance(code, str) else None


def _current_pane() -> Dict[str, object]:
    result = _successful_result(_run_herdr(["pane", "current", "--current"]))
    pane = result.get("pane")
    if not isinstance(pane, dict):
        raise UnsafeRequest("Herdr current pane identity is unavailable")
    for key in ("workspace_id", "pane_id", "terminal_id"):
        value = pane.get(key)
        if not isinstance(value, str):
            raise UnsafeRequest("Herdr current pane identity is invalid")
        _validate_target(value)
    return pane


def _workspace_catalog() -> Dict[str, Dict[str, object]]:
    result = _successful_result(_run_herdr(["workspace", "list"]))
    workspaces = result.get("workspaces")
    if not isinstance(workspaces, list):
        raise UnsafeRequest("Herdr workspace catalog is unavailable")
    catalog: Dict[str, Dict[str, object]] = {}
    for workspace in workspaces:
        if not isinstance(workspace, dict):
            raise UnsafeRequest("Herdr workspace catalog is invalid")
        workspace_id = workspace.get("workspace_id")
        if not isinstance(workspace_id, str) or workspace_id in catalog:
            raise UnsafeRequest("Herdr workspace catalog is invalid")
        _validate_target(workspace_id)
        catalog[workspace_id] = workspace
    return catalog


def _agent_information(target: str) -> Tuple[subprocess.CompletedProcess[str], Optional[Dict[str, object]]]:
    result = _run_herdr(["agent", "get", target])
    if result.returncode != 0:
        return result, None
    document = _successful_result(result)
    agent = document.get("agent")
    if not isinstance(agent, dict):
        raise UnsafeRequest("Herdr agent identity is unavailable")
    return result, agent


def _executable_node_metadata(metadata: os.stat_result) -> Dict[str, Union[int, str]]:
    if stat.S_ISREG(metadata.st_mode):
        kind = "regular"
    elif stat.S_ISLNK(metadata.st_mode):
        kind = "symlink"
    else:
        raise UnsafeRequest("Claude executable node type is invalid")
    return {
        "kind": kind,
        "file_type": stat.S_IFMT(metadata.st_mode),
        "mode": stat.S_IMODE(metadata.st_mode),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "nlink": metadata.st_nlink,
        "size": metadata.st_size,
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "rdev": metadata.st_rdev,
        "mtime_ns": metadata.st_mtime_ns,
        "ctime_ns": metadata.st_ctime_ns,
    }


def _claude_executable_identity() -> Dict[str, object]:
    candidate = os.environ.get("ZEROKUN_CLAUDE_BIN_PATH")
    if (
        not candidate
        or not os.path.isabs(candidate)
        or candidate != os.path.normpath(candidate)
        or Path(candidate).name != "claude"
    ):
        raise UnsafeRequest("pinned Claude executable is unavailable")
    discovered = shutil.which("claude")
    if discovered is None or os.path.normpath(discovered) != candidate:
        raise UnsafeRequest("PATH does not resolve the pinned Claude executable")
    lookup_path = Path(candidate)
    if (
        not lookup_path.is_absolute()
        or lookup_path.name != "claude"
        or str(lookup_path) != os.path.normpath(str(lookup_path))
    ):
        raise UnsafeRequest("Claude executable lookup path is invalid")
    try:
        lookup_metadata = _executable_node_metadata(os.lstat(lookup_path))
        resolved_path = lookup_path.resolve(strict=True)
        resolved_metadata = _executable_node_metadata(os.lstat(resolved_path))
    except (OSError, RuntimeError) as error:
        raise UnsafeRequest("Claude executable cannot be resolved safely") from error
    if (
        lookup_metadata["kind"] not in {"regular", "symlink"}
        or resolved_metadata["kind"] != "regular"
        or not os.access(resolved_path, os.X_OK)
    ):
        raise UnsafeRequest("Claude executable identity is invalid")
    identity = {
        "lookup_path": str(lookup_path),
        "lookup_metadata": lookup_metadata,
        "resolved_path": str(resolved_path),
        "resolved_metadata": resolved_metadata,
    }
    if not _valid_executable_identity(identity):
        raise UnsafeRequest("Claude executable identity is invalid")
    return identity


_SAFE_DIAGNOSTIC_FLAG = re.compile(r"--[A-Za-z0-9][A-Za-z0-9-]{0,63}\Z")


def _has_unsupported_diagnostic_control(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def _diagnostic_launcher_identity(
    executable: Dict[str, object],
) -> Optional[Dict[str, object]]:
    resolved_path = str(executable["resolved_path"])
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if not hasattr(os, "O_NOFOLLOW"):
        return None
    flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(resolved_path, flags)
    except OSError:
        return None
    try:
        before = os.fstat(descriptor)
        if _executable_node_metadata(before) != executable["resolved_metadata"]:
            return None
        prefix = os.read(descriptor, 256)
        after = os.fstat(descriptor)
        if _executable_node_metadata(after) != executable["resolved_metadata"]:
            return None
    except (OSError, UnsafeRequest):
        return None
    finally:
        os.close(descriptor)
    first_line = prefix.split(b"\n", 1)[0]
    if not first_line.startswith(b"#!"):
        return None
    try:
        shebang = first_line[2:].decode("ascii").strip().split()
    except UnicodeDecodeError:
        return None
    if shebang == ["/usr/bin/env", "node"]:
        candidate = shutil.which("node")
    elif len(shebang) == 1 and Path(shebang[0]).is_absolute() and Path(shebang[0]).name == "node":
        candidate = shebang[0]
    else:
        return None
    if candidate is None:
        return None
    lookup_path = Path(candidate)
    if (
        not lookup_path.is_absolute()
        or lookup_path.name != "node"
        or str(lookup_path) != os.path.normpath(str(lookup_path))
    ):
        return None
    try:
        lookup_metadata = _executable_node_metadata(os.lstat(lookup_path))
        launcher_resolved = lookup_path.resolve(strict=True)
        resolved_metadata = _executable_node_metadata(os.lstat(launcher_resolved))
    except (OSError, RuntimeError, UnsafeRequest):
        return None
    identity = {
        "lookup_path": str(lookup_path),
        "lookup_metadata": lookup_metadata,
        "resolved_path": str(launcher_resolved),
        "resolved_metadata": resolved_metadata,
    }
    if (
        not _valid_executable_identity(identity)
        or not os.access(launcher_resolved, os.X_OK)
    ):
        return None
    return {"bare_name": "node", "executable": identity}


def _diagnostic_command_shape(
    value: object,
    executable: Dict[str, object],
    launcher: Optional[Dict[str, object]],
) -> Dict[str, object]:
    if value is None:
        return {"kind": "null"}
    if not isinstance(value, str):
        return {"kind": type(value).__name__}
    shape: Dict[str, object] = {"kind": "string", "length": len(value)}
    if len(value) > MAX_DIAGNOSTIC_STRING_CHARS:
        shape["form"] = "oversized"
        return shape
    if _has_unsupported_diagnostic_control(value):
        shape["form"] = "control-character"
        return shape
    if value == "claude":
        form = "bare-claude"
    elif value == executable["lookup_path"]:
        form = "lookup-path"
    elif value == executable["resolved_path"]:
        form = "resolved-path"
    elif launcher is not None and value == launcher["bare_name"]:
        form = "launcher-bare"
    elif launcher is not None and value == launcher["executable"]["lookup_path"]:
        form = "launcher-lookup-path"
    elif launcher is not None and value == launcher["executable"]["resolved_path"]:
        form = "launcher-resolved-path"
    elif os.path.isabs(value):
        form = "other-absolute-path"
    elif "/" in value:
        form = "other-relative-path"
    else:
        form = "other-command"
    shape["form"] = form
    return shape


def _known_argument_positions(value: object) -> List[int]:
    if not isinstance(value, str):
        return []
    return sorted(
        {
            position
            for form in CLAUDE_OBSERVED_ARGUMENT_FORMS
            for position, expected in enumerate(form, start=1)
            if value == expected
        }
    )


def _diagnostic_argument_shape(
    value: object,
    position: int,
    executable: Dict[str, object],
) -> Dict[str, object]:
    if value is None:
        return {"kind": "null", "position": position}
    if not isinstance(value, str):
        return {"kind": type(value).__name__, "position": position}
    shape: Dict[str, object] = {
        "kind": "string",
        "length": len(value),
        "position": position,
    }
    if len(value) > MAX_DIAGNOSTIC_STRING_CHARS:
        shape["form"] = "oversized"
        return shape
    if _has_unsupported_diagnostic_control(value):
        shape["form"] = "control-character"
        return shape
    expected_positions = _known_argument_positions(value)
    shape["equals_expected_at_position"] = position in expected_positions
    if value == executable["lookup_path"]:
        shape["form"] = "claude-entrypoint-lookup-path"
        return shape
    if value == executable["resolved_path"]:
        shape["form"] = "claude-entrypoint-resolved-path"
        return shape
    if expected_positions and value.startswith("--"):
        shape["form"] = "known-claude-flag"
        shape["safe_flag"] = value
        shape["expected_positions"] = expected_positions
        return shape
    if expected_positions:
        shape["form"] = "known-claude-value"
        shape["safe_value"] = value
        shape["expected_positions"] = expected_positions
        return shape
    flag_name, separator, _flag_value = value.partition("=")
    if _SAFE_DIAGNOSTIC_FLAG.fullmatch(flag_name):
        shape["form"] = "unknown-flag"
        shape["has_inline_value"] = bool(separator)
        return shape
    if os.path.isabs(value):
        shape["form"] = "absolute-path"
    elif "/" in value:
        shape["form"] = "relative-path"
    else:
        shape["form"] = "opaque-value"
    return shape


def _process_mismatch_diagnostic(
    inventory: Dict[str, object],
    executable: Dict[str, object],
) -> Dict[str, object]:
    launcher = _diagnostic_launcher_identity(executable)
    launcher_values = (
        {
            launcher["executable"]["lookup_path"],
            launcher["executable"]["resolved_path"],
        }
        if launcher is not None
        else set()
    )
    observed = []
    exact_match_count = 0
    for process in inventory["processes"]:
        argv = process["argv"]
        argv0 = process["argv0"]
        exact_match = _valid_claude_invocation(argv, argv0, executable)
        exact_match_count += int(exact_match)
        entry: Dict[str, object] = {
            "pid": process["pid"],
            "argv0": _diagnostic_command_shape(argv0, executable, launcher),
            "exact_match": exact_match,
            "canonical_launcher_match": False,
        }
        if isinstance(argv, list):
            entry["argv_kind"] = "list"
            entry["argument_count"] = len(argv)
            if argv:
                entry["argv_head"] = _diagnostic_command_shape(
                    argv[0], executable, launcher
                )
                entry["arguments"] = [
                    _diagnostic_argument_shape(value, position, executable)
                    for position, value in enumerate(
                        argv[1:MAX_DIAGNOSTIC_ARGUMENTS],
                        start=1,
                    )
                ]
                entry["truncated_argument_count"] = max(
                    0,
                    len(argv) - MAX_DIAGNOSTIC_ARGUMENTS,
                )
                entry["canonical_launcher_match"] = bool(
                    launcher is not None
                    and len(argv) >= 2
                    and isinstance(argv0, str)
                    and isinstance(argv[0], str)
                    and isinstance(argv[1], str)
                    and argv0 in launcher_values
                    and argv[0] in launcher_values
                    and argv[1] in {
                        executable["lookup_path"],
                        executable["resolved_path"],
                    }
                    and tuple(argv[2:]) in CLAUDE_OBSERVED_ARGUMENT_FORMS
                )
            else:
                entry["argv_head"] = {"kind": "missing"}
                entry["arguments"] = []
                entry["truncated_argument_count"] = 0
        elif argv is None:
            entry["argv_kind"] = "null"
        elif isinstance(argv, str):
            entry["argv_kind"] = "string"
            entry["argv_string"] = _diagnostic_command_shape(
                argv, executable, launcher
            )
        else:
            entry["argv_kind"] = type(argv).__name__
        observed.append(entry)
    return {
        "shell_pid": inventory["shell_pid"],
        "process_group_id": inventory["process_group_id"],
        "process_ids": inventory["process_ids"],
        "process_count": len(observed),
        "exact_match_count": exact_match_count,
        "expected": {
            "argv0_form": "bare-claude",
            "argv_head_forms": ["bare-claude", "lookup-path", "resolved-path"],
            "argument_forms": [
                list(form) for form in CLAUDE_OBSERVED_ARGUMENT_FORMS
            ],
            "canonical_launcher_available": launcher is not None,
        },
        "processes": observed,
    }


def _process_inventory(workspace: Dict[str, object]) -> Dict[str, object]:
    result = _successful_result(
        _run_herdr(
            ["pane", "process-info", "--pane", str(workspace["pane_id"])]
        )
    )
    process_info = result.get("process_info")
    if not isinstance(process_info, dict) or process_info.get("pane_id") != workspace.get(
        "pane_id"
    ):
        raise UnsafeRequest("ephemeral Claude process identity is unavailable")
    shell_pid = process_info.get("shell_pid")
    process_group_id = process_info.get("foreground_process_group_id")
    foreground = process_info.get("foreground_processes")
    if (
        type(shell_pid) is not int
        or shell_pid <= 1
        or type(process_group_id) is not int
        or process_group_id <= 1
        or process_group_id == os.getpgrp()
        or not isinstance(foreground, list)
        or len(foreground) > MAX_PROCESS_COUNT
    ):
        raise UnsafeRequest("ephemeral Claude process identity is invalid")
    process_ids = {shell_pid}
    foreground_process_ids = set()
    processes = []
    for process in foreground:
        if not isinstance(process, dict):
            raise UnsafeRequest("ephemeral Claude process identity is invalid")
        pid = process.get("pid")
        if type(pid) is not int or pid <= 1 or pid in foreground_process_ids:
            raise UnsafeRequest("ephemeral Claude process identity is invalid")
        foreground_process_ids.add(pid)
        process_ids.add(pid)
        processes.append(
            {
                "pid": pid,
                "argv": process.get("argv"),
                "argv0": process.get("argv0"),
            }
        )
    if len(process_ids) > MAX_PROCESS_COUNT:
        raise UnsafeRequest("ephemeral Claude process identity is invalid")
    return {
        "shell_pid": shell_pid,
        "process_group_id": process_group_id,
        "process_ids": sorted(process_ids),
        "processes": processes,
    }


def _process_receipt(workspace: Dict[str, object]) -> Dict[str, object]:
    inventory = _process_inventory(workspace)
    executable = _claude_executable_identity()
    claude_matches = [
        process
        for process in inventory["processes"]
        if _valid_claude_invocation(
            process["argv"], process["argv0"], executable
        )
    ]
    if len(claude_matches) != 1:
        raise _ClaudeInvocationMismatch(
            _process_mismatch_diagnostic(inventory, executable),
            list(inventory["process_ids"]),
            int(inventory["process_group_id"]),
        )
    matched = claude_matches[0]
    return {
        "shell_pid": inventory["shell_pid"],
        "claude_pid": matched["pid"],
        "process_group_id": inventory["process_group_id"],
        "process_ids": inventory["process_ids"],
        "argv": matched["argv"],
        "argv0": matched["argv0"],
        "executable": executable,
    }


def _wait_for_process_exit(
    process_ids: List[int],
    process_group_ids: Union[int, List[int]],
) -> bool:
    if type(process_group_ids) is int:
        groups = [process_group_ids]
    else:
        groups = list(process_group_ids)
    if (
        not groups
        or len(groups) > 32
        or any(type(group) is not int or group <= 1 for group in groups)
    ):
        return False
    groups = sorted(set(groups))
    deadline = time.monotonic() + 30.0
    while True:
        active = []
        for process_id in process_ids:
            try:
                os.kill(process_id, 0)
            except ProcessLookupError:
                continue
            except PermissionError:
                active.append(process_id)
            else:
                active.append(process_id)
        active_groups = []
        for process_group_id in groups:
            try:
                os.killpg(process_group_id, 0)
            except ProcessLookupError:
                continue
            except PermissionError:
                active_groups.append(process_group_id)
            else:
                active_groups.append(process_group_id)
        if not active and not active_groups:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def _same_caller(before: Dict[str, object], after: Dict[str, object]) -> bool:
    return all(
        before.get(key) == after.get(key)
        for key in ("workspace_id", "pane_id", "terminal_id")
    )


def _validate_owned_agent(
    agent: Dict[str, object],
    workspace: Dict[str, object],
    *,
    require_ready: bool,
    require_project_path: bool = True,
) -> None:
    expected = {
        "name": workspace["agent_name"],
        "workspace_id": workspace["workspace_id"],
        "pane_id": workspace["pane_id"],
        "terminal_id": workspace["terminal_id"],
    }
    if require_project_path:
        expected["cwd"] = workspace["project_root"]
    if agent.get("agent") != "claude" or any(
        agent.get(key) != value for key, value in expected.items()
    ):
        raise UnsafeRequest("ephemeral Claude identity does not match its receipt")
    if require_ready and (
        agent.get("agent_status") not in {"idle", "done"}
        or agent.get("interactive_ready") is not True
        or agent.get("launch_pending") is True
    ):
        raise UnsafeRequest("ephemeral Claude is not at an empty ready prompt")


def _read_visible(target: str) -> str:
    result = _run_herdr(["agent", "read", target, "--source", "visible", "--lines", "120"])
    if result.returncode != 0:
        raise UnsafeRequest("ephemeral Claude screen could not be read")
    return result.stdout.replace("\r\n", "\n")


_ANSI_SEQUENCE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
_TRUST_DECORATION = re.compile(r"[\u2500-\u257f❯›▶▷◉●○◆◇]")
_TRUST_SELECTION = re.compile(r"[❯›▶▷]")
_FIRST_CHOICE_SELECTED = re.compile(r"^[\s\u2500-\u257f]*[❯›▶▷][\s\u2500-\u257f]*1\.")
_EMPTY_PROMPT_LINE = re.compile(r"^\s*❯\s*$")
_INTERACTIVE_HINT = re.compile(
    r"(?i)(?:\b(?:press|hit|choose|select|confirm|cancel|continue|proceed|approve|deny|allow)\b.*\b(?:enter|return|esc|escape|key|option)\b|"
    r"\b(?:enter|return|esc|escape)\b.*\b(?:confirm|cancel|continue|select|submit)\b|"
    r"^\s*[0-9]+[.)]\s+)"
)


def _semantic_terminal_line(line: str) -> str:
    return " ".join(_TRUST_DECORATION.sub(" ", line).split())


def _empty_claude_prompt_screen(text: str) -> bool:
    plain = _ANSI_SEQUENCE.sub("", text).replace("\r", "")
    lines = plain.splitlines()
    prompt_lines = [index for index, line in enumerate(lines) if "❯" in line]
    if not prompt_lines:
        return False
    return _EMPTY_PROMPT_LINE.fullmatch(lines[prompt_lines[-1]]) is not None


def _strict_trust_screen(text: str, project_root: str) -> bool:
    plain = _ANSI_SEQUENCE.sub("", text).replace("\r", "")
    lines = plain.splitlines()
    starts = [index for index, line in enumerate(lines) if "Accessing workspace:" in line]
    ends = [
        index
        for index, line in enumerate(lines)
        if "Enter to confirm · Esc to cancel" in line
    ]
    if len(starts) != 1 or len(ends) != 1 or starts[0] > ends[0]:
        return False
    prefix = [_semantic_terminal_line(line) for line in lines[: starts[0]]]
    suffix = [_semantic_terminal_line(line) for line in lines[ends[0] + 1 :]]
    if any(_INTERACTIVE_HINT.search(line) for line in prefix if line):
        return False
    if any(line for line in suffix):
        return False
    active_lines = lines[starts[0] : ends[0] + 1]
    if sum(len(_TRUST_SELECTION.findall(line)) for line in active_lines) != 1:
        return False
    if not any(_FIRST_CHOICE_SELECTED.search(line) for line in active_lines):
        return False
    active_tail = "\n".join(lines[starts[0] :])
    choices = re.findall(r"(?m)^\s*[\u2500-\u257f❯›▶▷◉●○◆◇]*\s*[0-9]+\.", active_tail)
    if len(choices) != 2:
        return False
    semantic_lines = []
    for line in lines[starts[0] : ends[0] + 1]:
        normalized = _semantic_terminal_line(line)
        if normalized:
            semantic_lines.append(normalized)
    observed = " ".join(semantic_lines)
    legacy_expected = " ".join(
        (
            "Accessing workspace:",
            project_root,
            "Quick safety check: Is this a project you created or one you trust?",
            "1. Yes, I trust this folder",
            "2. No, exit",
            "Enter to confirm · Esc to cancel",
        )
    )
    claude_2_1_246_expected = " ".join(
        (
            "Accessing workspace:",
            project_root,
            "Quick safety check: Is this a project you created or one you trust? "
            "(Like your own code, a well-known open source project, or work from your team). "
            "If not, take a moment to review what's in this folder first.",
            "Claude Code'll be able to read, edit, and execute files here.",
            "Security guide",
            "1. Yes, I trust this folder",
            "2. No, exit",
            "Enter to confirm · Esc to cancel",
        )
    )
    return observed in {legacy_expected, claude_2_1_246_expected}


def _settle_after_trust(
    target: str,
    workspace: Dict[str, object],
) -> Dict[str, object]:
    _result, first_agent = _agent_information(target)
    if first_agent is None:
        raise UnsafeRequest("ephemeral Claude disappeared at its trust screen")
    _validate_owned_agent(first_agent, workspace, require_ready=False)
    if first_agent.get("agent_status") != "blocked" or first_agent.get("launch_pending") is not True:
        raise UnsafeRequest("ephemeral Claude startup blocker is not the trust screen")
    first_text = _read_visible(target)
    if not _strict_trust_screen(first_text, str(workspace["project_root"])):
        raise UnsafeRequest("ephemeral Claude startup blocker is not the exact trust screen")
    first_sequence = first_agent.get("state_change_seq")
    if type(first_sequence) is not int:
        raise UnsafeRequest("ephemeral Claude trust screen state is invalid")
    time.sleep(1.0)
    _result, second_agent = _agent_information(target)
    second_text = _read_visible(target)
    if second_agent is not None:
        _validate_owned_agent(second_agent, workspace, require_ready=False)
    if (
        second_agent is None
        or second_agent.get("agent_status") != "blocked"
        or second_agent.get("launch_pending") is not True
        or type(second_agent.get("state_change_seq")) is not int
        or second_agent.get("state_change_seq") != first_sequence
        or second_text != first_text
        or not _strict_trust_screen(second_text, str(workspace["project_root"]))
    ):
        raise UnsafeRequest("ephemeral Claude trust screen did not settle")
    accepted = _run_herdr(["agent", "send-keys", target, "Enter"])
    if accepted.returncode != 0:
        raise UnsafeRequest("ephemeral Claude trust confirmation failed")

    deadline = time.monotonic() + CLAUDE_SETTLE_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        _result, agent = _agent_information(target)
        if agent is None:
            raise UnsafeRequest("ephemeral Claude disappeared after trust confirmation")
        _validate_owned_agent(agent, workspace, require_ready=False)
        if (
            agent.get("agent_status") in {"idle", "done"}
            and agent.get("interactive_ready") is True
            and agent.get("launch_pending") is not True
        ):
            return agent
        if agent.get("agent_status") == "blocked":
            blocked_text = _read_visible(target)
            if (
                agent.get("launch_pending") is True
                and agent.get("state_change_seq") == first_sequence
                and blocked_text == first_text
                and _strict_trust_screen(
                    blocked_text,
                    str(workspace["project_root"]),
                )
            ):
                # Herdr can briefly report the already-confirmed trust screen
                # until Claude consumes the single Enter key. Never resend it.
                time.sleep(0.25)
                continue
            raise UnsafeRequest("ephemeral Claude reached another blocked startup UI")
        time.sleep(0.25)
    raise UnsafeRequest("ephemeral Claude did not become ready after trust confirmation")


def _settle_after_agent_not_ready(
    target: str,
    workspace: Dict[str, object],
) -> Dict[str, object]:
    _result, first_agent = _agent_information(target)
    if first_agent is None:
        raise UnsafeRequest("ephemeral Claude disappeared after startup")
    _validate_owned_agent(first_agent, workspace, require_ready=False)
    if (
        first_agent.get("agent_status") == "blocked"
        and first_agent.get("launch_pending") is True
    ):
        return _settle_after_trust(target, workspace)

    _validate_owned_agent(first_agent, workspace, require_ready=True)
    first_sequence = first_agent.get("state_change_seq")
    first_text = _read_visible(target)
    if type(first_sequence) is not int or not _empty_claude_prompt_screen(first_text):
        raise UnsafeRequest("ephemeral Claude is not at the exact empty ready prompt")
    time.sleep(1.0)
    _result, second_agent = _agent_information(target)
    second_text = _read_visible(target)
    if second_agent is None:
        raise UnsafeRequest("ephemeral Claude disappeared at its ready prompt")
    _validate_owned_agent(second_agent, workspace, require_ready=True)
    if (
        second_agent.get("state_change_seq") != first_sequence
        or second_text != first_text
        or not _empty_claude_prompt_screen(second_text)
    ):
        raise UnsafeRequest("ephemeral Claude ready prompt did not settle")
    return second_agent


def _protected_unchanged(project_root: str, request_dir: str) -> bool:
    root_descriptor, root = _physical_git_root(project_root)
    request_descriptor, _request = _request_directory(request_dir, root)
    try:
        changed, _before_count, _after_count = _verify_unchanged(
            root_descriptor,
            root,
            request_descriptor,
        )
        return not changed
    finally:
        os.close(request_descriptor)
        os.close(root_descriptor)


def _validate_session_intent(intent: Dict[str, object]) -> None:
    intent_keys = {
        "version",
        "nonce",
        "label",
        "agent_name",
        "project_root",
        "project_root_dev",
        "project_root_ino",
        "caller",
        "baseline_workspace_ids",
    }
    caller = intent.get("caller")
    baseline_values = intent.get("baseline_workspace_ids")
    nonce = intent.get("nonce")
    label = intent.get("label")
    agent_name = intent.get("agent_name")
    project_root = intent.get("project_root")
    if (
        set(intent) != intent_keys
        or intent.get("version") != EPHEMERAL_SESSION_VERSION
        or not isinstance(nonce, str)
        or re.fullmatch(r"[0-9a-f]{32}", nonce) is None
        or label != f"fifth-advisor-{nonce}"
        or agent_name != f"fifth-{nonce[:20]}"
        or not isinstance(project_root, str)
        or not Path(project_root).is_absolute()
        or ".." in Path(project_root).parts
        or type(intent.get("project_root_dev")) is not int
        or type(intent.get("project_root_ino")) is not int
        or not isinstance(caller, dict)
        or set(caller) != {"workspace_id", "pane_id", "terminal_id"}
        or not isinstance(baseline_values, list)
        or not baseline_values
        or not all(isinstance(value, str) for value in baseline_values)
        or len(set(baseline_values)) != len(baseline_values)
        or caller.get("workspace_id") not in baseline_values
    ):
        raise UnsafeRequest("ephemeral session intent is invalid")
    for value in (*baseline_values, *caller.values()):
        _validate_target(str(value))
    return None


def _validate_workspace_receipt(
    intent: Dict[str, object],
    workspace: Dict[str, object],
) -> None:
    _validate_session_intent(intent)
    baseline_values = intent["baseline_workspace_ids"]
    assert isinstance(baseline_values, list)
    required = {
        "version",
        "nonce",
        "label",
        "agent_name",
        "project_root",
        "project_root_dev",
        "project_root_ino",
        "workspace_id",
        "tab_id",
        "pane_id",
        "terminal_id",
    }
    recorded_keys = frozenset(workspace)
    current_protocol = workspace.get("start_state_protocol")
    if (
        recorded_keys not in {frozenset(required), frozenset(required | {"start_state_protocol"})}
        or (
            "start_state_protocol" in recorded_keys
            and current_protocol != AGENT_START_STATE_PROTOCOL
        )
        or workspace.get("version") != EPHEMERAL_SESSION_VERSION
        or workspace.get("nonce") != intent.get("nonce")
        or workspace.get("label") != intent.get("label")
        or workspace.get("agent_name") != intent.get("agent_name")
        or workspace.get("project_root") != intent.get("project_root")
        or workspace.get("project_root_dev") != intent.get("project_root_dev")
        or workspace.get("project_root_ino") != intent.get("project_root_ino")
        or workspace.get("workspace_id") in baseline_values
    ):
        raise UnsafeRequest("ephemeral workspace receipt is invalid")
    for key in ("workspace_id", "tab_id", "pane_id", "terminal_id", "agent_name"):
        value = workspace.get(key)
        if not isinstance(value, str):
            raise UnsafeRequest("ephemeral workspace receipt is invalid")
        _validate_target(value)


def _agent_start_was_attempted(
    request_dir: str,
    intent: Dict[str, object],
    workspace: Dict[str, object],
) -> bool:
    # Version-2 receipts created before the durable protocol remain
    # conservative: missing state cannot prove that start was not attempted.
    if workspace.get("start_state_protocol") != AGENT_START_STATE_PROTOCOL:
        return True
    request_descriptor, _request = _owner_request_directory(request_dir)
    try:
        if not _request_entry_exists(request_descriptor, AGENT_START_INTENT_NAME):
            return False
        recorded = _read_request_record(request_descriptor, AGENT_START_INTENT_NAME)
    finally:
        os.close(request_descriptor)
    expected = {
        "version": EPHEMERAL_SESSION_VERSION,
        "nonce": intent["nonce"],
        "agent_name": workspace["agent_name"],
        "workspace_id": workspace["workspace_id"],
        "pane_id": workspace["pane_id"],
        "status": "start-will-be-attempted",
    }
    if recorded != expected:
        raise UnsafeRequest("ephemeral Claude start intent is invalid")
    return True


def _validate_diagnostic_command_shape(
    value: object,
    *,
    allow_missing: bool = False,
) -> None:
    if not isinstance(value, dict) or "kind" not in value:
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
    kind = value.get("kind")
    scalar_kinds = {"null", "dict", "list", "int", "float", "bool"}
    if allow_missing:
        scalar_kinds.add("missing")
    if kind in scalar_kinds:
        if set(value) != {"kind"}:
            raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
        return
    forms = {
        "oversized",
        "control-character",
        "bare-claude",
        "lookup-path",
        "resolved-path",
        "launcher-bare",
        "launcher-lookup-path",
        "launcher-resolved-path",
        "other-absolute-path",
        "other-relative-path",
        "other-command",
    }
    if (
        kind != "string"
        or set(value) != {"kind", "length", "form"}
        or type(value.get("length")) is not int
        or not 0 <= int(value["length"]) <= 1_048_576
        or value.get("form") not in forms
    ):
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
    length = int(value["length"])
    form = str(value["form"])
    if (
        (form == "oversized" and length <= MAX_DIAGNOSTIC_STRING_CHARS)
        or (form != "oversized" and length > MAX_DIAGNOSTIC_STRING_CHARS)
        or (form == "bare-claude" and length != len("claude"))
        or (form == "launcher-bare" and length != len("node"))
    ):
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")


def _validate_diagnostic_argument_shape(
    value: object,
    position: int,
) -> Optional[str]:
    if not isinstance(value, dict) or value.get("position") != position:
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
    kind = value.get("kind")
    if kind in {"null", "dict", "list", "int", "float", "bool"}:
        if set(value) != {"kind", "position"}:
            raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
        return None
    if (
        kind != "string"
        or type(value.get("length")) is not int
        or not 0 <= int(value["length"]) <= 1_048_576
        or not isinstance(value.get("form"), str)
    ):
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
    form = str(value["form"])
    known_literal: Optional[str] = None
    if form in {"oversized", "control-character"}:
        expected_keys = {"kind", "length", "position", "form"}
    elif form == "known-claude-flag":
        expected_keys = {
            "kind",
            "length",
            "position",
            "form",
            "equals_expected_at_position",
            "safe_flag",
            "expected_positions",
        }
        safe_flag = value.get("safe_flag")
        expected_positions = value.get("expected_positions")
        if (
            not isinstance(safe_flag, str)
            or not safe_flag.startswith("--")
            or not isinstance(expected_positions, list)
            or expected_positions != _known_argument_positions(safe_flag)
            or not expected_positions
        ):
            raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
        known_literal = safe_flag
    elif form == "known-claude-value":
        expected_keys = {
            "kind",
            "length",
            "position",
            "form",
            "equals_expected_at_position",
            "safe_value",
            "expected_positions",
        }
        safe_value = value.get("safe_value")
        expected_positions = value.get("expected_positions")
        if (
            not isinstance(safe_value, str)
            or safe_value.startswith("--")
            or not isinstance(expected_positions, list)
            or expected_positions != _known_argument_positions(safe_value)
            or not expected_positions
        ):
            raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
        known_literal = safe_value
    elif form == "unknown-flag":
        expected_keys = {
            "kind",
            "length",
            "position",
            "form",
            "equals_expected_at_position",
            "has_inline_value",
        }
        if type(value.get("has_inline_value")) is not bool:
            raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
    elif form in {
        "claude-entrypoint-lookup-path",
        "claude-entrypoint-resolved-path",
        "absolute-path",
        "relative-path",
        "opaque-value",
    }:
        expected_keys = {
            "kind",
            "length",
            "position",
            "form",
            "equals_expected_at_position",
        }
    else:
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
    if (
        set(value) != expected_keys
        or (
            "equals_expected_at_position" in value
            and type(value.get("equals_expected_at_position")) is not bool
        )
    ):
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
    length = int(value["length"])
    if (
        (form == "oversized" and length <= MAX_DIAGNOSTIC_STRING_CHARS)
        or (form != "oversized" and length > MAX_DIAGNOSTIC_STRING_CHARS)
        or (
            known_literal is not None
            and length != len(known_literal)
        )
        or (
            "equals_expected_at_position" in value
            and value["equals_expected_at_position"]
            != (position in _known_argument_positions(known_literal))
        )
    ):
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
    return known_literal


def _validate_process_mismatch_diagnostic(value: object) -> None:
    required = {
        "shell_pid",
        "process_group_id",
        "process_ids",
        "process_count",
        "exact_match_count",
        "expected",
        "processes",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
    process_ids = value.get("process_ids")
    processes = value.get("processes")
    if (
        type(value.get("shell_pid")) is not int
        or int(value["shell_pid"]) <= 1
        or type(value.get("process_group_id")) is not int
        or int(value["process_group_id"]) <= 1
        or not isinstance(process_ids, list)
        or not process_ids
        or len(process_ids) > MAX_PROCESS_COUNT
        or any(type(pid) is not int or pid <= 1 for pid in process_ids)
        or process_ids != sorted(set(process_ids))
        or value["shell_pid"] not in process_ids
        or not isinstance(processes, list)
        or len(processes) > MAX_PROCESS_COUNT
        or value.get("process_count") != len(processes)
        or type(value.get("exact_match_count")) is not int
        or not 0 <= int(value["exact_match_count"]) <= len(processes)
        or value.get("exact_match_count") == 1
    ):
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
    expected = value.get("expected")
    if (
        not isinstance(expected, dict)
        or set(expected)
        != {
            "argv0_form",
            "argv_head_forms",
            "argument_forms",
            "canonical_launcher_available",
        }
        or expected.get("argv0_form") != "bare-claude"
        or expected.get("argv_head_forms")
        != ["bare-claude", "lookup-path", "resolved-path"]
        or expected.get("argument_forms")
        != [list(form) for form in CLAUDE_OBSERVED_ARGUMENT_FORMS]
        or type(expected.get("canonical_launcher_available")) is not bool
    ):
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
    exact_count = 0
    seen_pids = set()
    for process in processes:
        if not isinstance(process, dict):
            raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
        common = {
            "pid",
            "argv0",
            "exact_match",
            "canonical_launcher_match",
            "argv_kind",
        }
        pid = process.get("pid")
        if (
            type(pid) is not int
            or pid not in process_ids
            or pid in seen_pids
            or type(process.get("exact_match")) is not bool
            or type(process.get("canonical_launcher_match")) is not bool
        ):
            raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
        seen_pids.add(pid)
        argv0_shape = process.get("argv0")
        _validate_diagnostic_command_shape(argv0_shape)
        argv0_form = (
            argv0_shape.get("form")
            if isinstance(argv0_shape, dict)
            else None
        )
        derived_exact_match = False
        derived_launcher_match = False
        argv_kind = process.get("argv_kind")
        if argv_kind == "list":
            required_process_keys = common | {
                "argument_count",
                "argv_head",
                "arguments",
                "truncated_argument_count",
            }
            arguments = process.get("arguments")
            argument_count = process.get("argument_count")
            if (
                set(process) != required_process_keys
                or type(argument_count) is not int
                or not 0 <= int(argument_count) <= 1_048_576
                or not isinstance(arguments, list)
                or len(arguments)
                != max(0, min(int(argument_count) - 1, MAX_DIAGNOSTIC_ARGUMENTS - 1))
                or process.get("truncated_argument_count")
                != max(0, int(argument_count) - MAX_DIAGNOSTIC_ARGUMENTS)
            ):
                raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
            argv_head = process.get("argv_head")
            _validate_diagnostic_command_shape(
                argv_head,
                allow_missing=True,
            )
            argv_head_form = (
                argv_head.get("form")
                if isinstance(argv_head, dict)
                else None
            )
            argument_literals = []
            for position, argument in enumerate(arguments, start=1):
                argument_literals.append(
                    _validate_diagnostic_argument_shape(argument, position)
                )
            observed_literals = tuple(argument_literals)
            derived_exact_match = bool(
                argument_count == len(observed_literals) + 1
                and process.get("truncated_argument_count") == 0
                and argv0_form == "bare-claude"
                and argv_head_form
                in {"bare-claude", "lookup-path", "resolved-path"}
                and observed_literals in CLAUDE_OBSERVED_ARGUMENT_FORMS
            )
            derived_launcher_match = bool(
                expected["canonical_launcher_available"]
                and argument_count == len(observed_literals) + 1
                and process.get("truncated_argument_count") == 0
                and argv0_form
                in {"launcher-lookup-path", "launcher-resolved-path"}
                and argv_head_form
                in {"launcher-lookup-path", "launcher-resolved-path"}
                and bool(arguments)
                and isinstance(arguments[0], dict)
                and arguments[0].get("form")
                in {
                    "claude-entrypoint-lookup-path",
                    "claude-entrypoint-resolved-path",
                }
                and tuple(argument_literals[1:])
                in CLAUDE_OBSERVED_ARGUMENT_FORMS
            )
        elif argv_kind == "string":
            if set(process) != common | {"argv_string"}:
                raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
            _validate_diagnostic_command_shape(process.get("argv_string"))
        elif argv_kind in {"null", "dict", "int", "float", "bool"}:
            if set(process) != common:
                raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
        else:
            raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
        if (
            process["exact_match"] != derived_exact_match
            or process["canonical_launcher_match"] != derived_launcher_match
            or (
                not expected["canonical_launcher_available"]
                and (
                    argv0_form
                    in {
                        "launcher-bare",
                        "launcher-lookup-path",
                        "launcher-resolved-path",
                    }
                    or (
                        argv_kind == "list"
                        and isinstance(process.get("argv_head"), dict)
                        and process["argv_head"].get("form")
                        in {
                            "launcher-bare",
                            "launcher-lookup-path",
                            "launcher-resolved-path",
                        }
                    )
                )
            )
        ):
            raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
        exact_count += int(derived_exact_match)
    if exact_count != value["exact_match_count"]:
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")
    if process_ids != sorted({value["shell_pid"], *seen_pids}):
        raise UnsafeRequest("ephemeral process mismatch diagnostic is invalid")


def _validate_process_mismatch_receipt(
    receipt: object,
    intent: Dict[str, object],
    workspace: Dict[str, object],
) -> Dict[str, object]:
    required = {
        "version",
        "session_version",
        "policy",
        "status",
        "nonce",
        "agent_name",
        "workspace_id",
        "pane_id",
        "terminal_id",
        "diagnostic",
    }
    if (
        not isinstance(receipt, dict)
        or set(receipt) != required
        or receipt.get("version") != PROCESS_MISMATCH_VERSION
        or receipt.get("session_version") != EPHEMERAL_SESSION_VERSION
        or receipt.get("policy") != PROCESS_MISMATCH_POLICY
        or receipt.get("status") != "identity-mismatch-before-prompt"
        or receipt.get("nonce") != intent.get("nonce")
        or any(
            receipt.get(key) != workspace.get(key)
            for key in ("agent_name", "workspace_id", "pane_id", "terminal_id")
        )
    ):
        raise UnsafeRequest("ephemeral process mismatch receipt is invalid")
    _validate_process_mismatch_diagnostic(receipt.get("diagnostic"))
    return receipt


def _validate_closed_receipt_for_diagnostic(
    closed: object,
    workspace: Dict[str, object],
    diagnostic: Dict[str, object],
) -> None:
    required = {
        "version",
        "nonce",
        "workspace_id",
        "pane_id",
        "agent_name",
        "status",
        "close_target_verified",
        "workspace_absent",
        "pane_absent",
        "agent_absent",
        "caller_restored",
        "focus_before",
        "focus_immediately_before",
        "focus_verified",
        "catalog_restored",
        "agent_identity_verified",
        "project_location_verified",
        "protected_unchanged",
        "processes_exited",
        "process_ids",
        "process_group_id",
        "process_group_ids",
    }
    boolean_keys = {
        "close_target_verified",
        "workspace_absent",
        "pane_absent",
        "agent_absent",
        "caller_restored",
        "focus_verified",
        "catalog_restored",
        "agent_identity_verified",
        "project_location_verified",
        "protected_unchanged",
    }
    process_group_id = diagnostic["process_group_id"]
    if (
        not isinstance(closed, dict)
        or set(closed) != required
        or closed.get("version") != EPHEMERAL_SESSION_VERSION
        or any(
            closed.get(key) != workspace.get(key)
            for key in ("nonce", "workspace_id", "pane_id", "agent_name")
        )
        or closed.get("status") != "closed-and-verified"
        or any(type(closed.get(key)) is not bool for key in boolean_keys)
        or any(
            closed.get(key) is not True
            for key in (
                "close_target_verified",
                "workspace_absent",
                "pane_absent",
                "agent_absent",
            )
        )
        or closed.get("focus_before")
        not in {"caller", "owned", "foreign", "unavailable"}
        or closed.get("focus_immediately_before")
        not in {"caller", "owned", "foreign", "unavailable"}
        or closed.get("processes_exited") is not True
        or closed.get("process_ids") != diagnostic["process_ids"]
        or closed.get("process_group_id") != process_group_id
        or closed.get("process_group_ids") != [process_group_id]
    ):
        raise UnsafeRequest("ephemeral cleanup receipt is invalid for diagnostic use")


def _load_cleanup_records(
    project_root: str,
    request_dir: str,
) -> Tuple[
    Dict[str, object],
    Dict[str, object],
    Optional[Dict[str, object]],
    Optional[Exception],
]:
    request_descriptor, request = _owner_request_directory(request_dir)
    try:
        snapshot = _read_snapshot_document(request_descriptor)
        intent = _read_request_record(request_descriptor, SESSION_INTENT_NAME)
        workspace = _read_request_record(request_descriptor, WORKSPACE_RECEIPT_NAME)
        _validate_workspace_receipt(intent, workspace)
        recorded_root_text = intent.get("project_root")
        supplied_root = Path(project_root)
        recorded_root = Path(str(recorded_root_text))
        if (
            not isinstance(recorded_root_text, str)
            or not supplied_root.is_absolute()
            or ".." in supplied_root.parts
            or not recorded_root.is_absolute()
            or ".." in recorded_root.parts
            or str(supplied_root) != recorded_root_text
            or snapshot.get("project_root") != recorded_root_text
            or snapshot.get("project_root_dev") != intent.get("project_root_dev")
            or snapshot.get("project_root_ino") != intent.get("project_root_ino")
        ):
            raise UnsafeRequest(
                "cleanup receipts do not match the protected project snapshot"
            )
        try:
            request.relative_to(recorded_root)
        except ValueError:
            pass
        else:
            raise UnsafeRequest("request directory must be outside the project worktree")
        try:
            agent_receipt = _read_request_record(
                request_descriptor,
                AGENT_RECEIPT_NAME,
            )
            agent_error: Optional[Exception] = None
        except Exception as error:
            agent_receipt = None
            agent_error = error
        return intent, workspace, agent_receipt, agent_error
    finally:
        os.close(request_descriptor)


def _write_cleanup_record(
    project_root: str,
    request_dir: str,
    intent: Dict[str, object],
    workspace: Dict[str, object],
    payload: Dict[str, object],
) -> None:
    observed_intent, observed_workspace, _agent, _agent_error = (
        _load_cleanup_records(project_root, request_dir)
    )
    if observed_intent != intent or observed_workspace != workspace:
        raise UnsafeRequest("cleanup receipts changed before close was recorded")
    request_descriptor, _request = _owner_request_directory(request_dir)
    try:
        _exclusive_json_record(request_descriptor, CLOSED_RECEIPT_NAME, payload)
    finally:
        os.close(request_descriptor)


def _validate_owned_topology(
    workspace: Dict[str, object],
    *,
    allow_focused: bool = False,
    require_project_path: bool = True,
    require_focus_state: bool = True,
) -> bool:
    workspace_id = str(workspace["workspace_id"])
    workspace_result = _successful_result(
        _run_herdr(["workspace", "get", workspace_id])
    )
    observed_workspace = workspace_result.get("workspace")
    if not isinstance(observed_workspace, dict):
        raise UnsafeRequest("owned workspace topology is unavailable")
    if (
        observed_workspace.get("workspace_id") != workspace_id
        or observed_workspace.get("label") != workspace.get("label")
        or observed_workspace.get("active_tab_id") != workspace.get("tab_id")
        or (
            require_focus_state
            and observed_workspace.get("focused") is not allow_focused
        )
        or observed_workspace.get("pane_count") != 1
        or observed_workspace.get("tab_count") != 1
        or observed_workspace.get("worktree") is not None
    ):
        raise UnsafeRequest("owned workspace topology changed before cleanup")

    tab_result = _successful_result(
        _run_herdr(["tab", "list", "--workspace", workspace_id])
    )
    tabs = tab_result.get("tabs")
    if not isinstance(tabs, list) or len(tabs) != 1:
        raise UnsafeRequest("owned workspace tab topology changed before cleanup")
    tab = tabs[0]
    if (
        not isinstance(tab, dict)
        or tab.get("workspace_id") != workspace_id
        or tab.get("tab_id") != workspace.get("tab_id")
        or tab.get("pane_count") != 1
        or (require_focus_state and tab.get("focused") is not allow_focused)
    ):
        raise UnsafeRequest("owned workspace tab topology changed before cleanup")

    pane_result = _successful_result(
        _run_herdr(["pane", "list", "--workspace", workspace_id])
    )
    panes = pane_result.get("panes")
    if not isinstance(panes, list) or len(panes) != 1:
        raise UnsafeRequest("owned workspace pane topology changed before cleanup")
    pane = panes[0]
    project_path_matches = (
        isinstance(pane, dict)
        and pane.get("cwd") == workspace.get("project_root")
        and pane.get("foreground_cwd") == workspace.get("project_root")
    )
    if (
        not isinstance(pane, dict)
        or pane.get("workspace_id") != workspace_id
        or pane.get("tab_id") != workspace.get("tab_id")
        or pane.get("pane_id") != workspace.get("pane_id")
        or pane.get("terminal_id") != workspace.get("terminal_id")
        or (require_project_path and not project_path_matches)
        or (require_focus_state and pane.get("focused") is not allow_focused)
    ):
        raise UnsafeRequest("owned workspace pane topology changed before cleanup")
    return project_path_matches


def _validate_owned_or_absent_agent(
    workspace: Dict[str, object],
    *,
    require_project_path: bool = True,
) -> Tuple[bool, bool]:
    result = _run_herdr(["agent", "get", str(workspace["agent_name"])])
    if result.returncode != 0:
        if _error_code(result) == "agent_not_found":
            return True, True
        return False, False
    try:
        document = _successful_result(result)
        agent = document.get("agent")
        if not isinstance(agent, dict):
            return False, False
        _validate_owned_agent(
            agent,
            workspace,
            require_ready=False,
            require_project_path=False,
        )
    except Exception:
        return False, False
    project_path_matches = agent.get("cwd") == workspace.get("project_root")
    if require_project_path and not project_path_matches:
        raise UnsafeRequest("ephemeral Claude identity does not match its receipt")
    return True, project_path_matches


def _require_absent_agent(workspace: Dict[str, object]) -> None:
    result = _run_herdr(["agent", "get", str(workspace["agent_name"])])
    if result.returncode == 0 or _error_code(result) != "agent_not_found":
        raise UnsafeRequest("ephemeral Claude name is already occupied before startup")


def _validate_provisional_topology(
    workspace_id: str,
    label: str,
    project_root: str,
    *,
    allow_focused: bool,
    require_project_path: bool = True,
    require_focus_state: bool = True,
) -> bool:
    workspace_result = _successful_result(
        _run_herdr(["workspace", "get", workspace_id])
    )
    workspace = workspace_result.get("workspace")
    if (
        not isinstance(workspace, dict)
        or workspace.get("workspace_id") != workspace_id
        or workspace.get("label") != label
        or (require_focus_state and workspace.get("focused") is not allow_focused)
        or workspace.get("pane_count") != 1
        or workspace.get("tab_count") != 1
        or workspace.get("worktree") is not None
    ):
        raise UnsafeRequest("provisional workspace topology is not owned")
    tabs_result = _successful_result(
        _run_herdr(["tab", "list", "--workspace", workspace_id])
    )
    panes_result = _successful_result(
        _run_herdr(["pane", "list", "--workspace", workspace_id])
    )
    tabs = tabs_result.get("tabs")
    panes = panes_result.get("panes")
    if not isinstance(tabs, list) or len(tabs) != 1:
        raise UnsafeRequest("provisional workspace tab topology is not owned")
    if not isinstance(panes, list) or len(panes) != 1:
        raise UnsafeRequest("provisional workspace pane topology is not owned")
    tab = tabs[0]
    pane = panes[0]
    project_path_matches = (
        isinstance(pane, dict)
        and pane.get("cwd") == project_root
        and pane.get("foreground_cwd") == project_root
    )
    if (
        not isinstance(tab, dict)
        or not isinstance(pane, dict)
        or tab.get("workspace_id") != workspace_id
        or tab.get("pane_count") != 1
        or (require_focus_state and tab.get("focused") is not allow_focused)
        or pane.get("workspace_id") != workspace_id
        or pane.get("tab_id") != tab.get("tab_id")
        or pane.get("terminal_id") is None
        or (require_project_path and not project_path_matches)
        or (require_focus_state and pane.get("focused") is not allow_focused)
    ):
        raise UnsafeRequest("provisional workspace topology is not owned")
    return project_path_matches


def _project_path_matches_receipt(
    project_root: str,
    receipt: Dict[str, object],
) -> bool:
    descriptor: Optional[int] = None
    try:
        descriptor, root = _physical_git_root(project_root)
        metadata = os.fstat(descriptor)
        return (
            str(root) == receipt.get("project_root")
            and metadata.st_dev == receipt.get("project_root_dev")
            and metadata.st_ino == receipt.get("project_root_ino")
        )
    except Exception:
        return False
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _require_open_root_identity(
    project_root: str,
    root: Path,
    root_descriptor: int,
    root_metadata: os.stat_result,
) -> None:
    try:
        held_metadata = os.fstat(root_descriptor)
    except OSError as error:
        raise UnsafeRequest(
            "project root identity is unavailable before ephemeral Claude startup"
        ) from error
    expected = {
        "project_root": str(root),
        "project_root_dev": root_metadata.st_dev,
        "project_root_ino": root_metadata.st_ino,
    }
    if (
        (held_metadata.st_dev, held_metadata.st_ino)
        != (root_metadata.st_dev, root_metadata.st_ino)
        or not _project_path_matches_receipt(project_root, expected)
    ):
        raise UnsafeRequest(
            "project root identity changed before ephemeral Claude startup"
        )


def _focus_location(
    caller: Dict[str, object],
    workspace: Dict[str, object],
    current: Optional[Dict[str, object]],
) -> str:
    if current is None:
        return "unavailable"
    if _same_caller(caller, current):
        return "caller"
    if workspace.get("workspace_id") == current.get("workspace_id") and (
        not all(
            isinstance(workspace.get(key), str)
            for key in ("pane_id", "terminal_id")
        )
        or _same_caller(workspace, current)
    ):
        return "owned"
    return "foreign"


def _require_owned_workspace_absent(workspace: Dict[str, object]) -> None:
    workspace_id = str(workspace["workspace_id"])
    checks = (
        (["workspace", "get", workspace_id], "workspace_not_found"),
        (["pane", "get", str(workspace["pane_id"])], "pane_not_found"),
        (["agent", "get", str(workspace["agent_name"])], "agent_not_found"),
    )
    for command, expected in checks:
        result = _run_herdr(command)
        if result.returncode == 0 or _error_code(result) != expected:
            raise UnsafeRequest("ephemeral owned identity is not absent")
    catalog = _workspace_catalog()
    if workspace_id in catalog:
        raise UnsafeRequest("ephemeral owned workspace still exists")
    if any(
        candidate.get("label") == workspace.get("label")
        for candidate in catalog.values()
    ):
        raise UnsafeRequest("ephemeral owned workspace label reappeared")


def _validate_final_cleanup_record(
    intent: Dict[str, object],
    workspace: Dict[str, object],
    receipt: Dict[str, object],
) -> None:
    new_keys = {
        "version",
        "nonce",
        "workspace_id",
        "pane_id",
        "agent_name",
        "status",
        "close_target_verified",
        "workspace_absent",
        "pane_absent",
        "agent_absent",
        "caller_restored",
        "focus_before",
        "focus_immediately_before",
        "focus_verified",
        "catalog_restored",
        "agent_identity_verified",
        "project_location_verified",
        "protected_unchanged",
        "processes_exited",
        "process_ids",
        "process_group_id",
        "process_group_ids",
    }
    legacy_keys = new_keys - {
        "close_target_verified",
        "workspace_absent",
        "pane_absent",
        "agent_absent",
    }
    audit_boolean_keys = {
        "caller_restored",
        "focus_verified",
        "catalog_restored",
        "agent_identity_verified",
        "project_location_verified",
        "protected_unchanged",
    }
    exact_absence = all(
        receipt.get(key) is True
        for key in (
            "close_target_verified",
            "workspace_absent",
            "pane_absent",
            "agent_absent",
        )
    )
    legacy_exact = all(
        receipt.get(key) is True
        for key in (
            "caller_restored",
            "focus_verified",
            "catalog_restored",
            "agent_identity_verified",
            "project_location_verified",
            "protected_unchanged",
        )
    )
    process_ids = receipt.get("process_ids")
    process_group_id = receipt.get("process_group_id")
    process_group_ids = receipt.get("process_group_ids")
    no_process_started = (
        process_ids is None
        and process_group_id is None
        and process_group_ids is None
    )
    recorded_processes_valid = (
        isinstance(process_ids, list)
        and bool(process_ids)
        and len(process_ids) <= 32
        and process_ids == sorted(set(process_ids))
        and all(type(value) is int and value > 1 for value in process_ids)
        and type(process_group_id) is int
        and process_group_id > 1
        and isinstance(process_group_ids, list)
        and bool(process_group_ids)
        and len(process_group_ids) <= 32
        and process_group_ids == sorted(set(process_group_ids))
        and all(type(value) is int and value > 1 for value in process_group_ids)
        and process_group_id in process_group_ids
    )
    if (
        frozenset(receipt) not in {frozenset(new_keys), frozenset(legacy_keys)}
        or
        receipt.get("version") != EPHEMERAL_SESSION_VERSION
        or receipt.get("nonce") != intent.get("nonce")
        or receipt.get("status") != "closed-and-verified"
        or any(
            receipt.get(key) != workspace.get(key)
            for key in ("workspace_id", "pane_id", "agent_name")
        )
        or receipt.get("processes_exited") is not True
        or any(type(receipt.get(key)) is not bool for key in audit_boolean_keys)
        or receipt.get("focus_before")
        not in {"caller", "owned", "foreign", "unavailable"}
        or receipt.get("focus_immediately_before")
        not in {"caller", "owned", "foreign", "unavailable"}
        or not (no_process_started or recorded_processes_valid)
        or not (
            set(receipt) == new_keys and exact_absence
            or set(receipt) == legacy_keys and legacy_exact
        )
    ):
        raise UnsafeRequest("ephemeral cleanup receipt is invalid")


def _existing_final_cleanup_record(
    project_root: str,
    request_dir: str,
    intent: Dict[str, object],
    workspace: Dict[str, object],
) -> Optional[Dict[str, object]]:
    request_descriptor, _request = _owner_request_directory(request_dir)
    try:
        if not _request_entry_exists(request_descriptor, CLOSED_RECEIPT_NAME):
            return None
        receipt = _read_request_record(request_descriptor, CLOSED_RECEIPT_NAME)
    finally:
        os.close(request_descriptor)
    _validate_final_cleanup_record(intent, workspace, receipt)
    _require_owned_workspace_absent(workspace)
    process_ids = receipt.get("process_ids")
    process_group_ids = receipt.get("process_group_ids")
    if isinstance(process_ids, list) and isinstance(process_group_ids, list):
        if not _wait_for_process_exit(process_ids, process_group_ids):
            raise UnsafeRequest("ephemeral Claude process reappeared after cleanup")
    return receipt


def _close_owned_workspace(
    project_root: str,
    request_dir: str,
    intent: Dict[str, object],
    workspace: Dict[str, object],
    *,
    record: bool,
    process_ids: Optional[List[int]] = None,
    process_group_id: Optional[int] = None,
    process_group_ids: Optional[List[int]] = None,
    no_process_started: bool = False,
    project_path_verified: bool = True,
) -> bool:
    _validate_workspace_receipt(intent, workspace)
    caller = intent.get("caller")
    if not isinstance(caller, dict):
        raise UnsafeRequest("ephemeral session caller identity is invalid")
    try:
        current_before: Optional[Dict[str, object]] = _current_pane()
    except Exception:
        current_before = None
    focus_before = _focus_location(caller, workspace, current_before)
    workspace_id = str(workspace["workspace_id"])
    baseline = set(intent["baseline_workspace_ids"])
    catalog = _workspace_catalog()
    observed = catalog.get(workspace_id)
    already_absent = observed is None
    if observed is not None and (
        observed.get("label") != workspace.get("label")
        or observed.get("pane_count") != 1
        or observed.get("tab_count") != 1
    ):
        raise UnsafeRequest("owned workspace topology changed before cleanup")

    catalog_before_exact = set(catalog) == baseline | ({workspace_id} if observed else set())
    if already_absent:
        _require_owned_workspace_absent(workspace)
        topology_project_path_verified = True
        agent_identity_verified = True
        agent_project_path_verified = True
    else:
        topology_project_path_verified = bool(_validate_owned_topology(
            workspace,
            allow_focused=False,
            require_project_path=False,
            require_focus_state=False,
        ))
        (
            agent_identity_verified,
            agent_project_path_verified,
        ) = _validate_owned_or_absent_agent(
            workspace,
            require_project_path=False,
        )
        if not agent_identity_verified:
            raise UnsafeRequest("ephemeral Claude occupant changed before cleanup")
    project_location_verified = (
        project_path_verified
        and topology_project_path_verified
        and agent_project_path_verified
    )
    try:
        current_immediately_before: Optional[Dict[str, object]] = _current_pane()
    except Exception:
        current_immediately_before = None
    focus_immediately_before = _focus_location(
        caller, workspace, current_immediately_before
    )
    focus_verified = (
        focus_before in {"caller", "owned"}
        and focus_immediately_before in {"caller", "owned"}
    )

    if not already_absent:
        closed = _run_herdr(["workspace", "close", workspace_id])
        if closed.returncode != 0:
            raise UnsafeRequest("owned workspace could not be closed")
    catalog_after = _workspace_catalog()
    _require_owned_workspace_absent(workspace)
    try:
        current_after: Optional[Dict[str, object]] = _current_pane()
    except Exception:
        current_after = None
    caller_restored = current_after is not None and _same_caller(caller, current_after)
    catalog_restored = catalog_before_exact and set(catalog_after) == baseline
    if project_path_verified:
        try:
            protected_unchanged = _protected_unchanged(project_root, request_dir)
        except Exception:
            protected_unchanged = False
    else:
        protected_unchanged = False
    cleanup_process_group_ids = (
        sorted(set(process_group_ids))
        if process_group_ids is not None
        else [process_group_id]
        if process_group_id is not None
        else None
    )
    if no_process_started and process_ids is None and cleanup_process_group_ids is None:
        processes_exited = True
    elif process_ids is None or cleanup_process_group_ids is None:
        processes_exited = None
    else:
        processes_exited = _wait_for_process_exit(
            process_ids,
            cleanup_process_group_ids,
        )
    if processes_exited is None:
        raise UnsafeRequest(
            "owned workspace was closed, but the ephemeral Claude process identity "
            "could not be verified"
        )
    if not processes_exited:
        raise UnsafeRequest("ephemeral Claude process survived workspace cleanup")
    record_error: Optional[Exception] = None
    if record:
        try:
            _write_cleanup_record(
                project_root,
                request_dir,
                intent,
                workspace,
                {
                    "version": EPHEMERAL_SESSION_VERSION,
                    "nonce": workspace["nonce"],
                    "workspace_id": workspace_id,
                    "pane_id": workspace["pane_id"],
                    "agent_name": workspace["agent_name"],
                    "status": "closed-and-verified",
                    "close_target_verified": True,
                    "workspace_absent": True,
                    "pane_absent": True,
                    "agent_absent": True,
                    "caller_restored": caller_restored,
                    "focus_before": focus_before,
                    "focus_immediately_before": focus_immediately_before,
                    "focus_verified": focus_verified,
                    "catalog_restored": catalog_restored,
                    "agent_identity_verified": agent_identity_verified,
                    "project_location_verified": project_location_verified,
                    "protected_unchanged": protected_unchanged,
                    "processes_exited": processes_exited,
                    "process_ids": process_ids,
                    "process_group_id": process_group_id,
                    "process_group_ids": cleanup_process_group_ids,
                },
            )
        except Exception as error:
            record_error = error
    if record_error is not None:
        raise UnsafeRequest(
            "owned workspace was closed, but cleanup receipt could not be recorded"
        ) from record_error
    return already_absent


def _close_provisional_workspace(
    project_root: str,
    request_dir: str,
    intent: Dict[str, object],
    baseline: Dict[str, Dict[str, object]],
) -> Optional[str]:
    label = intent.get("label")
    caller = intent.get("caller")
    if not isinstance(label, str) or not isinstance(caller, dict):
        raise UnsafeRequest("ephemeral session intent is invalid")
    deadline = time.monotonic() + PROVISIONAL_RECONCILE_SECONDS
    catalog: Dict[str, Dict[str, object]] = {}
    matches: List[str] = []
    while time.monotonic() < deadline:
        catalog = _workspace_catalog()
        matches = [
            workspace_id
            for workspace_id, workspace in catalog.items()
            if workspace_id not in baseline and workspace.get("label") == label
        ]
        if matches:
            break
        time.sleep(0.1)
    if len(matches) != 1:
        if not matches:
            return None
        raise UnsafeRequest("created workspace identity could not be reconciled safely")
    workspace_id = matches[0]
    project_root = intent.get("project_root")
    if not isinstance(project_root, str):
        raise UnsafeRequest("ephemeral session intent is invalid")
    provisional_workspace = {"workspace_id": workspace_id}
    try:
        current_before: Optional[Dict[str, object]] = _current_pane()
    except Exception:
        current_before = None
    focus_before = _focus_location(caller, provisional_workspace, current_before)
    project_path_verified = _project_path_matches_receipt(project_root, intent)
    topology_project_path_verified = bool(_validate_provisional_topology(
        workspace_id,
        label,
        project_root,
        allow_focused=False,
        require_project_path=False,
        require_focus_state=False,
    ))
    project_location_verified = (
        project_path_verified and topology_project_path_verified
    )
    closed = _run_herdr(["workspace", "close", workspace_id])
    if closed.returncode != 0:
        raise UnsafeRequest("provisional owned workspace could not be closed")
    _verify_provisional_workspace_absent(
        intent,
        {"workspace_id": workspace_id},
    )
    after = _workspace_catalog()
    try:
        current_after: Optional[Dict[str, object]] = _current_pane()
    except Exception:
        current_after = None
    caller_restored = current_after is not None and _same_caller(caller, current_after)
    try:
        protected_unchanged = _protected_unchanged(project_root, request_dir)
    except Exception:
        protected_unchanged = False
    catalog_restored = set(after) == set(baseline)
    record_error: Optional[Exception] = None
    try:
        _write_provisional_cleanup_record(
            request_dir,
            intent,
            {
                "version": EPHEMERAL_SESSION_VERSION,
                "nonce": intent["nonce"],
                "workspace_id": workspace_id,
                "status": "provisional-workspace-closed",
                "close_target_verified": True,
                "workspace_absent": True,
                "label_absent": True,
                "focus_before": focus_before,
                "caller_restored": caller_restored,
                "catalog_restored": catalog_restored,
                "project_location_verified": project_location_verified,
                "protected_unchanged": protected_unchanged,
            },
        )
    except Exception as error:
        record_error = error
    if record_error is not None:
        raise UnsafeRequest(
            "provisional workspace was closed, but cleanup receipt could not be recorded"
        ) from record_error
    return workspace_id


def _write_provisional_cleanup_record(
    request_dir: str,
    intent: Dict[str, object],
    payload: Dict[str, object],
) -> None:
    request_descriptor, _request = _owner_request_directory(request_dir)
    try:
        snapshot = _read_snapshot_document(request_descriptor)
        observed_intent = _read_request_record(
            request_descriptor,
            SESSION_INTENT_NAME,
        )
        _validate_session_intent(observed_intent)
        if (
            observed_intent != intent
            or snapshot.get("project_root") != intent.get("project_root")
            or snapshot.get("project_root_dev") != intent.get("project_root_dev")
            or snapshot.get("project_root_ino") != intent.get("project_root_ino")
            or _request_entry_exists(request_descriptor, WORKSPACE_RECEIPT_NAME)
        ):
            raise UnsafeRequest(
                "provisional cleanup state changed before receipt recording"
            )
        _exclusive_json_record(request_descriptor, CLOSED_RECEIPT_NAME, payload)
    finally:
        os.close(request_descriptor)


def _suppress_open_signals() -> None:
    global _HERDR_CHILD_SIGNALS_PROTECTED
    blocked_signals = set(OPEN_TERMINATION_SIGNALS)
    signal.pthread_sigmask(signal.SIG_BLOCK, blocked_signals)
    for handled in OPEN_TERMINATION_SIGNALS:
        signal.signal(handled, signal.SIG_IGN)
    _HERDR_CHILD_SIGNALS_PROTECTED = True


@contextmanager
def _noninterruptible_close():
    global _HERDR_CHILD_SIGNALS_PROTECTED
    blocked_signals = set(OPEN_TERMINATION_SIGNALS)
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, blocked_signals)
    previous_handlers = {
        handled: signal.getsignal(handled) for handled in OPEN_TERMINATION_SIGNALS
    }
    previous_child_protection = _HERDR_CHILD_SIGNALS_PROTECTED
    try:
        for handled in OPEN_TERMINATION_SIGNALS:
            signal.signal(handled, signal.SIG_IGN)
        _HERDR_CHILD_SIGNALS_PROTECTED = True
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, blocked_signals)
        _HERDR_CHILD_SIGNALS_PROTECTED = previous_child_protection
        for handled, previous in previous_handlers.items():
            signal.signal(handled, previous)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def _run_open_with_signal_cleanup(
    args: argparse.Namespace,
    root_descriptor: int,
    root: Path,
    root_metadata: os.stat_result,
) -> int:
    global _HERDR_CHILD_SIGNALS_PROTECTED
    handled_signals = OPEN_TERMINATION_SIGNALS
    blocked_signals = set(handled_signals)
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, blocked_signals)
    active_mask = set(previous_mask) - blocked_signals
    previous_handlers: Dict[int, object] = {}
    previous_child_protection = _HERDR_CHILD_SIGNALS_PROTECTED

    def interrupt(signum: int, _frame: object) -> None:
        for handled in handled_signals:
            signal.signal(handled, signal.SIG_IGN)
        raise _OpenSignal(signum)

    try:
        for handled in handled_signals:
            previous_handlers[handled] = signal.getsignal(handled)
            signal.signal(handled, interrupt)
        signal.pthread_sigmask(signal.SIG_SETMASK, active_mask)
        return _open_ephemeral_workspace(
            args,
            root_descriptor,
            root,
            root_metadata,
        )
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, blocked_signals)
        _HERDR_CHILD_SIGNALS_PROTECTED = previous_child_protection
        for handled, previous in previous_handlers.items():
            signal.signal(handled, previous)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def _open_command(args: argparse.Namespace) -> int:
    if os.environ.get("HERDR_ENV") != "1":
        raise UnsafeRequest("HERDR_ENV is not active")
    root_descriptor, root = _physical_git_root(args.project_root)
    try:
        if str(Path(args.project_root)) != str(root):
            raise UnsafeRequest("project root must use its canonical physical path")
        request_descriptor, _request = _request_directory(args.request_dir, root)
        try:
            _discard_staged_records(request_descriptor)
            changed, _before_count, _after_count = _verify_unchanged(
                root_descriptor,
                root,
                request_descriptor,
            )
            if changed:
                raise UnsafeRequest("protected metadata changed before workspace creation")
            root_metadata = os.fstat(root_descriptor)
        finally:
            os.close(request_descriptor)
        return _run_open_with_signal_cleanup(
            args,
            root_descriptor,
            root,
            root_metadata,
        )
    finally:
        os.close(root_descriptor)


def _validate_provisional_closed_receipt(
    intent: Dict[str, object],
    receipt: Dict[str, object],
) -> None:
    _validate_session_intent(intent)
    common = {
        "version",
        "nonce",
        "workspace_id",
        "status",
        "workspace_absent",
        "label_absent",
        "caller_restored",
        "catalog_restored",
        "project_location_verified",
        "protected_unchanged",
    }
    status = receipt.get("status")
    expected = common | (
        {"focus_before", "close_target_verified"}
        if status == "provisional-workspace-closed"
        else set()
    )
    if (
        set(receipt) != expected
        or receipt.get("version") != EPHEMERAL_SESSION_VERSION
        or receipt.get("nonce") != intent.get("nonce")
        or status
        not in {"provisional-workspace-closed", "provisional-workspace-not-created"}
        or receipt.get("workspace_absent") is not True
        or receipt.get("label_absent") is not True
        or any(
            type(receipt.get(key)) is not bool
            for key in (
                "caller_restored",
                "catalog_restored",
                "project_location_verified",
                "protected_unchanged",
            )
        )
    ):
        raise UnsafeRequest("provisional cleanup receipt is invalid")
    workspace_id = receipt.get("workspace_id")
    if status == "provisional-workspace-closed":
        if (
            not isinstance(workspace_id, str)
            or workspace_id in intent["baseline_workspace_ids"]
            or receipt.get("focus_before")
            not in {"caller", "owned", "foreign", "unavailable"}
            or receipt.get("close_target_verified") is not True
        ):
            raise UnsafeRequest("provisional cleanup receipt is invalid")
        _validate_target(workspace_id)
    elif workspace_id is not None:
        raise UnsafeRequest("provisional cleanup receipt is invalid")


def _verify_provisional_workspace_absent(
    intent: Dict[str, object],
    receipt: Dict[str, object],
) -> None:
    workspace_id = receipt.get("workspace_id")
    if isinstance(workspace_id, str):
        result = _run_herdr(["workspace", "get", workspace_id])
        if result.returncode == 0 or _error_code(result) != "workspace_not_found":
            raise UnsafeRequest("provisional owned workspace still exists")
    catalog = _workspace_catalog()
    if isinstance(workspace_id, str) and workspace_id in catalog:
        raise UnsafeRequest("provisional owned workspace still exists")
    baseline = set(intent["baseline_workspace_ids"])
    label = intent["label"]
    if any(
        workspace_id not in baseline and workspace.get("label") == label
        for workspace_id, workspace in catalog.items()
    ):
        raise UnsafeRequest("provisional owned workspace identity reappeared")


def _recover_provisional_command(args: argparse.Namespace) -> int:
    if os.environ.get("HERDR_ENV") != "1":
        raise UnsafeRequest("HERDR_ENV is not active")
    request_descriptor, request = _owner_request_directory(args.request_dir)
    try:
        _discard_staged_records(request_descriptor)
        intent = _read_request_record(request_descriptor, SESSION_INTENT_NAME)
        _validate_session_intent(intent)
        snapshot = _read_snapshot_document(request_descriptor)
        supplied_root = Path(args.project_root)
        recorded_root = intent.get("project_root")
        if (
            not isinstance(recorded_root, str)
            or not supplied_root.is_absolute()
            or ".." in supplied_root.parts
            or str(supplied_root) != recorded_root
            or snapshot.get("project_root") != recorded_root
            or snapshot.get("project_root_dev") != intent.get("project_root_dev")
            or snapshot.get("project_root_ino") != intent.get("project_root_ino")
        ):
            raise UnsafeRequest("provisional cleanup state identity changed")
        try:
            request.relative_to(supplied_root)
        except ValueError:
            pass
        else:
            raise UnsafeRequest("request directory must be outside the project worktree")
        if _request_entry_exists(request_descriptor, WORKSPACE_RECEIPT_NAME):
            raise UnsafeRequest(
                "durable workspace identity exists; exact close is required"
            )
        if _request_entry_exists(request_descriptor, CLOSED_RECEIPT_NAME):
            receipt = _read_request_record(
                request_descriptor,
                CLOSED_RECEIPT_NAME,
            )
            _validate_provisional_closed_receipt(intent, receipt)
            _verify_provisional_workspace_absent(intent, receipt)
            print(
                json.dumps(
                    {
                        "status": "ephemeral-provisional-already-reconciled",
                        "workspace_id": receipt["workspace_id"],
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
            return 0
        baseline_values = intent["baseline_workspace_ids"]
        assert isinstance(baseline_values, list)
        baseline = {str(workspace_id): {} for workspace_id in baseline_values}
    finally:
        os.close(request_descriptor)

    with _noninterruptible_close():
        workspace_id = _close_provisional_workspace(
            args.project_root,
            args.request_dir,
            intent,
            baseline,
        )
        if workspace_id is None:
            caller = intent["caller"]
            assert isinstance(caller, dict)
            try:
                caller_restored = _same_caller(caller, _current_pane())
            except Exception:
                caller_restored = False
            current_catalog = _workspace_catalog()
            catalog_restored = set(current_catalog) == set(baseline)
            if any(
                candidate_id not in baseline
                and candidate.get("label") == intent["label"]
                for candidate_id, candidate in current_catalog.items()
            ):
                raise UnsafeRequest(
                    "provisional owned workspace label appeared before cleanup receipt"
                )
            project_location_verified = _project_path_matches_receipt(
                args.project_root,
                intent,
            )
            try:
                protected_unchanged = _protected_unchanged(
                    args.project_root,
                    args.request_dir,
                )
            except Exception:
                protected_unchanged = False
            _write_provisional_cleanup_record(
                args.request_dir,
                intent,
                {
                    "version": EPHEMERAL_SESSION_VERSION,
                    "nonce": intent["nonce"],
                    "workspace_id": None,
                    "status": "provisional-workspace-not-created",
                    "workspace_absent": True,
                    "label_absent": True,
                    "caller_restored": caller_restored,
                    "catalog_restored": catalog_restored,
                    "project_location_verified": project_location_verified,
                    "protected_unchanged": protected_unchanged,
                },
            )
        final_descriptor, _final_request = _owner_request_directory(
            args.request_dir
        )
        try:
            receipt = _read_request_record(
                final_descriptor,
                CLOSED_RECEIPT_NAME,
            )
        finally:
            os.close(final_descriptor)
        _validate_provisional_closed_receipt(intent, receipt)
        _verify_provisional_workspace_absent(intent, receipt)
        print(
            json.dumps(
                {
                    "status": "ephemeral-provisional-reconciled",
                    "workspace_id": receipt["workspace_id"],
                },
                sort_keys=True,
            ),
            flush=True,
        )
    return 0


def _open_ephemeral_workspace(
    args: argparse.Namespace,
    root_descriptor: int,
    root: Path,
    root_metadata: os.stat_result,
) -> int:
    caller = _current_pane()
    baseline = _workspace_catalog()
    caller_workspace_id = caller.get("workspace_id")
    if (
        not isinstance(caller_workspace_id, str)
        or caller_workspace_id not in baseline
    ):
        raise UnsafeRequest("calling workspace is absent from the workspace catalog")
    nonce = secrets.token_hex(16)
    label = f"fifth-advisor-{nonce}"
    agent_name = f"fifth-{nonce[:20]}"
    intent: Dict[str, object] = {
        "version": EPHEMERAL_SESSION_VERSION,
        "nonce": nonce,
        "label": label,
        "agent_name": agent_name,
        "project_root": str(root),
        "project_root_dev": root_metadata.st_dev,
        "project_root_ino": root_metadata.st_ino,
        "caller": {
            key: caller[key] for key in ("workspace_id", "pane_id", "terminal_id")
        },
        "baseline_workspace_ids": sorted(baseline),
    }
    _write_request_record(
        args.project_root,
        args.request_dir,
        SESSION_INTENT_NAME,
        intent,
    )

    workspace_receipt: Optional[Dict[str, object]] = None
    workspace_validated = False
    workspace_receipt_recorded = False
    create_attempted = False
    start_attempted = False
    try:
        _require_open_root_identity(
            args.project_root,
            root,
            root_descriptor,
            root_metadata,
        )
        create_attempted = True
        created = _successful_result(
            _run_herdr(
                [
                    "workspace",
                    "create",
                    "--cwd",
                    str(root),
                    "--label",
                    label,
                    "--no-focus",
                ]
            )
        )
        workspace_info = created.get("workspace")
        tab_info = created.get("tab")
        pane_info = created.get("root_pane")
        if not all(isinstance(value, dict) for value in (workspace_info, tab_info, pane_info)):
            raise UnsafeRequest("Herdr did not return a complete workspace receipt")
        assert isinstance(workspace_info, dict)
        assert isinstance(tab_info, dict)
        assert isinstance(pane_info, dict)
        workspace_id = workspace_info.get("workspace_id")
        tab_id = tab_info.get("tab_id")
        pane_id = pane_info.get("pane_id")
        terminal_id = pane_info.get("terminal_id")
        identifiers = (workspace_id, tab_id, pane_id, terminal_id)
        if not all(isinstance(value, str) for value in identifiers):
            raise UnsafeRequest("Herdr returned invalid workspace identifiers")
        for value in identifiers:
            _validate_target(str(value))
        if workspace_id in baseline or workspace_info.get("label") != label:
            raise UnsafeRequest("Herdr created a workspace with unexpected identity")
        workspace_receipt = {
            "version": EPHEMERAL_SESSION_VERSION,
            "start_state_protocol": AGENT_START_STATE_PROTOCOL,
            "nonce": nonce,
            "label": label,
            "agent_name": agent_name,
            "project_root": str(root),
            "project_root_dev": root_metadata.st_dev,
            "project_root_ino": root_metadata.st_ino,
            "workspace_id": str(workspace_id),
            "tab_id": str(tab_id),
            "pane_id": str(pane_id),
            "terminal_id": str(terminal_id),
        }
        if (
            workspace_info.get("pane_count") != 1
            or workspace_info.get("tab_count") != 1
            or tab_info.get("workspace_id") != workspace_id
            or pane_info.get("workspace_id") != workspace_id
            or pane_info.get("tab_id") != tab_id
        ):
            raise UnsafeRequest("Herdr created a workspace with unexpected identity")
        workspace_validated = True
        _require_open_root_identity(
            args.project_root,
            root,
            root_descriptor,
            root_metadata,
        )
        if (
            workspace_info.get("focused") is not False
            or pane_info.get("cwd") != str(root)
            or pane_info.get("foreground_cwd") != str(root)
            or pane_info.get("focused") is not False
        ):
            raise UnsafeRequest("Herdr created a workspace with unexpected identity")
        after_create = _workspace_catalog()
        if set(after_create) != set(baseline) | {str(workspace_id)}:
            raise UnsafeRequest("Herdr workspace creation changed more than one workspace")
        if not _same_caller(caller, _current_pane()):
            raise UnsafeRequest("Herdr workspace creation changed the calling pane")
        _write_request_record(
            args.project_root,
            args.request_dir,
            WORKSPACE_RECEIPT_NAME,
            workspace_receipt,
        )
        workspace_receipt_recorded = True

        _require_open_root_identity(
            args.project_root,
            root,
            root_descriptor,
            root_metadata,
        )
        _validate_owned_topology(workspace_receipt)
        _require_absent_agent(workspace_receipt)
        if not _same_caller(caller, _current_pane()):
            raise UnsafeRequest(
                "ephemeral Claude preflight changed the calling pane"
            )
        _write_request_record(
            args.project_root,
            args.request_dir,
            AGENT_START_INTENT_NAME,
            {
                "version": EPHEMERAL_SESSION_VERSION,
                "nonce": nonce,
                "agent_name": agent_name,
                "workspace_id": workspace_id,
                "pane_id": pane_id,
                "status": "start-will-be-attempted",
            },
        )
        start_attempted = True
        started = _run_herdr(
            [
                "agent",
                "start",
                agent_name,
                "--kind",
                "claude",
                "--pane",
                str(pane_id),
                "--timeout",
                str(CLAUDE_START_TIMEOUT_MS),
                "--",
                *CLAUDE_ARGUMENTS,
            ],
            timeout=CLAUDE_START_PROCESS_TIMEOUT_SECONDS,
        )
        _require_open_root_identity(
            args.project_root,
            root,
            root_descriptor,
            root_metadata,
        )
        if started.returncode == 0:
            _result, agent = _agent_information(agent_name)
            if agent is None:
                raise UnsafeRequest("ephemeral Claude was not registered after startup")
            _validate_owned_agent(agent, workspace_receipt, require_ready=True)
        elif _error_code(started) == "agent_not_ready":
            agent = _settle_after_agent_not_ready(agent_name, workspace_receipt)
        else:
            raise UnsafeRequest("ephemeral Claude could not start")

        _validate_owned_topology(workspace_receipt)
        if not _same_caller(caller, _current_pane()):
            raise UnsafeRequest("ephemeral Claude startup changed the calling pane")

        session = agent.get("agent_session")
        native_session = (
            session.get("value")
            if isinstance(session, dict)
            else "N/A:safe-mode"
        )
        sequence = agent.get("state_change_seq")
        if not isinstance(native_session, str) or not native_session or type(sequence) is not int:
            raise UnsafeRequest("ephemeral Claude native identity is incomplete")
        _require_open_root_identity(
            args.project_root,
            root,
            root_descriptor,
            root_metadata,
        )
        processes = _process_receipt(workspace_receipt)
        _write_request_record(
            args.project_root,
            args.request_dir,
            AGENT_RECEIPT_NAME,
            {
                "version": EPHEMERAL_SESSION_VERSION,
                "nonce": nonce,
                "agent_name": agent_name,
                "workspace_id": workspace_id,
                "pane_id": pane_id,
                "terminal_id": terminal_id,
                "native_session": native_session,
                "state_change_seq": sequence,
                "shell_pid": processes["shell_pid"],
                "claude_pid": processes["claude_pid"],
                "process_group_id": processes["process_group_id"],
                "process_ids": processes["process_ids"],
                "argv": processes["argv"],
                "argv0": processes["argv0"],
                "executable": processes["executable"],
            },
        )
        if not _protected_unchanged(args.project_root, args.request_dir):
            raise UnsafeRequest("protected metadata changed while starting ephemeral Claude")
        _suppress_open_signals()
        print(
            json.dumps(
                {
                    "status": "ephemeral-claude-ready",
                    "target": agent_name,
                    "workspace_id": workspace_id,
                    "pane_id": pane_id,
                    "terminal_id": terminal_id,
                    "native_session": native_session,
                    "state_change_seq": sequence,
                },
                sort_keys=True,
            ),
            flush=True,
        )
        return 0
    except BaseException as startup_error:
        _suppress_open_signals()
        if workspace_validated and workspace_receipt is not None:
            cleanup_process_ids = None
            cleanup_process_group_id = None
            process_identity_error = None
            mismatch = (
                startup_error
                if isinstance(startup_error, _ClaudeInvocationMismatch)
                else None
            )
            if mismatch is not None:
                _record_process_mismatch_best_effort(
                    args.project_root,
                    args.request_dir,
                    intent,
                    workspace_receipt,
                    mismatch,
                )
            if start_attempted:
                if mismatch is not None:
                    cleanup_process_ids = list(mismatch.process_ids)
                    cleanup_process_group_id = mismatch.process_group_id
                else:
                    try:
                        cleanup_processes = _process_inventory(workspace_receipt)
                        cleanup_process_ids = list(cleanup_processes["process_ids"])
                        cleanup_process_group_id = int(
                            cleanup_processes["process_group_id"]
                        )
                    except Exception as error:
                        process_identity_error = error
            try:
                _close_owned_workspace(
                    args.project_root,
                    args.request_dir,
                    intent,
                    workspace_receipt,
                    record=workspace_receipt_recorded,
                    process_ids=cleanup_process_ids,
                    process_group_id=cleanup_process_group_id,
                    no_process_started=not start_attempted,
                    project_path_verified=_project_path_matches_receipt(
                        args.project_root,
                        workspace_receipt,
                    ),
                )
            except Exception as cleanup_error:
                if isinstance(startup_error, _OpenSignal):
                    startup_error.cleanup_attempted = True
                    startup_error.cleanup_error = cleanup_error
                    raise startup_error
                raise UnsafeRequest(
                    "ephemeral Claude startup failed and owned workspace cleanup failed: "
                    f"{startup_error}; cleanup: {cleanup_error}"
                ) from cleanup_error
            if process_identity_error is not None:
                if isinstance(startup_error, _OpenSignal):
                    startup_error.cleanup_attempted = True
                    startup_error.cleanup_error = process_identity_error
                    raise startup_error
                raise UnsafeRequest(
                    "ephemeral Claude startup failed; the owned workspace was closed "
                    "but process identity could not be verified"
                ) from process_identity_error
        elif create_attempted:
            try:
                _close_provisional_workspace(
                    args.project_root,
                    args.request_dir,
                    intent,
                    baseline,
                )
            except Exception as cleanup_error:
                if isinstance(startup_error, _OpenSignal):
                    startup_error.cleanup_attempted = True
                    startup_error.cleanup_error = cleanup_error
                    raise startup_error
                raise UnsafeRequest(
                    "ephemeral workspace creation failed and provisional cleanup failed: "
                    f"{startup_error}; cleanup: {cleanup_error}"
                ) from cleanup_error
        if isinstance(startup_error, _OpenSignal):
            startup_error.cleanup_attempted = True
        raise


def _close_command_noninterruptible(args: argparse.Namespace) -> int:
    _discard_request_staged_records(args.request_dir)
    intent, workspace, agent_receipt, agent_receipt_error = _load_cleanup_records(
        args.project_root,
        args.request_dir,
    )
    existing_cleanup = _existing_final_cleanup_record(
        args.project_root,
        args.request_dir,
        intent,
        workspace,
    )
    if existing_cleanup is not None:
        print(
            json.dumps(
                {
                    "status": "ephemeral-workspace-already-closed",
                    "workspace_id": workspace["workspace_id"],
                    "pane_id": workspace["pane_id"],
                    "agent_name": workspace["agent_name"],
                },
                sort_keys=True,
            ),
            flush=True,
        )
        return 0
    start_attempted = _agent_start_was_attempted(
        args.request_dir,
        intent,
        workspace,
    )
    if agent_receipt is not None and not start_attempted:
        raise UnsafeRequest(
            "ephemeral Claude agent receipt exists without a durable start intent"
        )
    no_process_started = agent_receipt is None and not start_attempted
    process_ids: Optional[List[int]] = None
    process_group_id: Optional[int] = None
    process_group_ids: Optional[List[int]] = None
    process_identity_error: Optional[Exception] = (
        None if no_process_started else agent_receipt_error
    )
    if agent_receipt is not None:
        try:
            candidate_process_ids = agent_receipt.get("process_ids")
            candidate_process_group_id = agent_receipt.get("process_group_id")
            if (
                agent_receipt.get("nonce") != workspace.get("nonce")
                or not _valid_recorded_process_ids(agent_receipt)
                or type(candidate_process_group_id) is not int
                or candidate_process_group_id <= 1
            ):
                raise UnsafeRequest("ephemeral Claude process receipt is invalid")
            process_ids = list(candidate_process_ids)
            process_group_id = candidate_process_group_id
            process_group_ids = [candidate_process_group_id]
            try:
                observed_processes = _process_receipt(workspace)
                if not _same_owned_process_identity(observed_processes, agent_receipt):
                    process_identity_error = UnsafeRequest(
                        "ephemeral Claude process changed before cleanup"
                    )
                process_ids = sorted(
                    set(process_ids) | set(observed_processes["process_ids"])
                )
                process_group_ids = sorted(
                    set(process_group_ids)
                    | {int(observed_processes["process_group_id"])}
                )
            except Exception as error:
                process_identity_error = error
        except Exception as error:
            process_identity_error = error
    if not no_process_started and (process_identity_error is not None or process_ids is None):
        try:
            cleanup_inventory = _process_inventory(workspace)
            observed_ids = list(cleanup_inventory["process_ids"])
            observed_group = int(cleanup_inventory["process_group_id"])
            process_ids = sorted(set(process_ids or []) | set(observed_ids))
            process_group_ids = sorted(
                set(process_group_ids or []) | {observed_group}
            )
            if process_group_id is None:
                process_group_id = observed_group
            if agent_receipt is None and observed_ids == [cleanup_inventory["shell_pid"]]:
                _result, observed_agent = _agent_information(
                    str(workspace["agent_name"])
                )
                if observed_agent is None:
                    process_identity_error = None
        except Exception as inventory_error:
            if process_identity_error is None:
                process_identity_error = inventory_error
    project_path_verified = _project_path_matches_receipt(
        args.project_root,
        workspace,
    )
    with _noninterruptible_close():
        already_absent = _close_owned_workspace(
            args.project_root,
            args.request_dir,
            intent,
            workspace,
            record=True,
            process_ids=process_ids,
            process_group_id=process_group_id,
            process_group_ids=process_group_ids,
            no_process_started=no_process_started,
            project_path_verified=project_path_verified,
        )
        if process_identity_error is not None and not already_absent:
            raise UnsafeRequest(
                "ephemeral Claude process identity changed, but the owned workspace "
                "was closed"
            ) from process_identity_error
        print(
            json.dumps(
                {
                    "status": (
                        "ephemeral-workspace-already-closed"
                        if already_absent
                        else "ephemeral-workspace-closed"
                    ),
                    "workspace_id": workspace["workspace_id"],
                    "pane_id": workspace["pane_id"],
                    "agent_name": workspace["agent_name"],
                },
                sort_keys=True,
            ),
            flush=True,
        )
    return 0


def _close_command(args: argparse.Namespace) -> int:
    # Once cleanup is requested, keep the ownership preflight, exact close,
    # disappearance checks, durable receipt, and flushed result in one bounded
    # critical section.  Protected Herdr children run in a detached session and
    # ignore terminal termination signals; subprocess timeouts still bound them.
    with _noninterruptible_close():
        return _close_command_noninterruptible(args)


def _owned_target(
    intent: Dict[str, object],
    workspace: Dict[str, object],
    agent_receipt: Dict[str, object],
) -> str:
    _validate_workspace_receipt(intent, workspace)
    caller = intent.get("caller")
    if not isinstance(caller, dict) or not _same_caller(caller, _current_pane()):
        raise UnsafeRequest("calling pane identity changed before fifth-advisor prompt")
    expected_agent_keys = {
        "version",
        "nonce",
        "agent_name",
        "workspace_id",
        "pane_id",
        "terminal_id",
        "native_session",
        "state_change_seq",
        "shell_pid",
        "claude_pid",
        "process_group_id",
        "process_ids",
        "argv",
        "argv0",
        "executable",
    }
    if (
        set(agent_receipt) != expected_agent_keys
        or agent_receipt.get("version") != EPHEMERAL_SESSION_VERSION
        or agent_receipt.get("nonce") != workspace.get("nonce")
        or any(
            agent_receipt.get(key) != workspace.get(key)
            for key in ("agent_name", "workspace_id", "pane_id", "terminal_id")
        )
        or not isinstance(agent_receipt.get("native_session"), str)
        or type(agent_receipt.get("state_change_seq")) is not int
        or type(agent_receipt.get("shell_pid")) is not int
        or type(agent_receipt.get("claude_pid")) is not int
        or type(agent_receipt.get("process_group_id")) is not int
        or not _valid_recorded_process_ids(agent_receipt)
        or not _valid_claude_invocation(
            agent_receipt.get("argv"),
            agent_receipt.get("argv0"),
            agent_receipt.get("executable"),
        )
    ):
        raise UnsafeRequest("ephemeral Claude receipt is invalid")
    target = str(workspace["agent_name"])
    _result, agent = _agent_information(target)
    if agent is None:
        raise UnsafeRequest("ephemeral Claude disappeared before fifth-advisor prompt")
    _validate_owned_agent(agent, workspace, require_ready=True)
    session = agent.get("agent_session")
    recorded_session = agent_receipt.get("native_session")
    session_matches = (
        isinstance(session, dict) and session.get("value") == recorded_session
    ) or (session is None and recorded_session == "N/A:safe-mode")
    if not session_matches or agent.get("state_change_seq") != agent_receipt.get(
        "state_change_seq"
    ):
        raise UnsafeRequest("ephemeral Claude identity changed before fifth-advisor prompt")
    if not _empty_claude_prompt_screen(_read_visible(target)):
        raise UnsafeRequest("ephemeral Claude is not at an empty visible prompt")
    processes = _process_receipt(workspace)
    if not _same_owned_process_identity(processes, agent_receipt):
        raise UnsafeRequest("ephemeral Claude process changed before fifth-advisor prompt")
    _result, final_agent = _agent_information(target)
    if final_agent is None:
        raise UnsafeRequest("ephemeral Claude disappeared before fifth-advisor prompt")
    _validate_owned_agent(final_agent, workspace, require_ready=True)
    final_session = final_agent.get("agent_session")
    final_session_matches = (
        isinstance(final_session, dict) and final_session.get("value") == recorded_session
    ) or (final_session is None and recorded_session == "N/A:safe-mode")
    if (
        not final_session_matches
        or final_agent.get("state_change_seq") != agent_receipt.get("state_change_seq")
    ):
        raise UnsafeRequest("ephemeral Claude identity changed before fifth-advisor prompt")
    final_processes = _process_receipt(workspace)
    if not _same_owned_process_identity(final_processes, agent_receipt):
        raise UnsafeRequest("ephemeral Claude process changed before fifth-advisor prompt")
    return target


def _snapshot_command(args: argparse.Namespace) -> int:
    root_descriptor, root = _physical_git_root(args.project_root)
    request_descriptor, _request = _request_directory(args.request_dir, root)
    try:
        _discard_staged_records(request_descriptor)
        snapshot = _protected_snapshot(root_descriptor, root)
        _write_snapshot(request_descriptor, snapshot)
        print(
            json.dumps(
                {
                    "status": "snapshot-recorded",
                    "protected_count": snapshot["protected_count"],
                },
                sort_keys=True,
            )
        )
        return 0
    finally:
        os.close(request_descriptor)
        os.close(root_descriptor)


def _verify_unchanged(
    root_descriptor: int,
    root: Path,
    request_descriptor: int,
) -> Tuple[bool, int, int]:
    before = _load_snapshot(request_descriptor, root, root_descriptor)
    after = _protected_snapshot(root_descriptor, root)
    return (
        _compare_snapshots(before, after),
        int(before["protected_count"]),
        int(after["protected_count"]),
    )


def _verify_command(args: argparse.Namespace) -> int:
    root_descriptor, root = _physical_git_root(args.project_root)
    request_descriptor, _request = _request_directory(args.request_dir, root)
    try:
        changed, before_count, after_count = _verify_unchanged(
            root_descriptor,
            root,
            request_descriptor,
        )
        if changed:
            print(
                json.dumps(
                    {
                        "status": "protected-metadata-changed",
                        "protected_count_before": before_count,
                        "protected_count_after": after_count,
                    },
                    ensure_ascii=True,
                    sort_keys=True,
                )
            )
            return 4
        print(json.dumps({"status": "snapshot-unchanged"}, sort_keys=True))
        return 0
    finally:
        os.close(request_descriptor)
        os.close(root_descriptor)


def _diagnose_command(args: argparse.Namespace) -> int:
    root_descriptor, root = _physical_git_root(args.project_root)
    request_descriptor, _request = _request_directory(args.request_dir, root)
    try:
        _discard_staged_records(request_descriptor)
        if str(Path(args.project_root)) != str(root):
            raise UnsafeRequest("project root must use its canonical physical path")
        changed, _before_count, _after_count = _verify_unchanged(
            root_descriptor,
            root,
            request_descriptor,
        )
        if changed:
            raise UnsafeRequest(
                "protected metadata changed before mismatch diagnosis"
            )
        snapshot = _read_snapshot_document(request_descriptor)
        intent = _read_request_record(request_descriptor, SESSION_INTENT_NAME)
        workspace = _read_request_record(
            request_descriptor,
            WORKSPACE_RECEIPT_NAME,
        )
        _validate_workspace_receipt(intent, workspace)
        root_metadata = os.fstat(root_descriptor)
        if (
            intent.get("project_root") != str(root)
            or intent.get("project_root_dev") != root_metadata.st_dev
            or intent.get("project_root_ino") != root_metadata.st_ino
            or snapshot.get("project_root") != intent.get("project_root")
            or snapshot.get("project_root_dev") != intent.get("project_root_dev")
            or snapshot.get("project_root_ino") != intent.get("project_root_ino")
        ):
            raise UnsafeRequest(
                "mismatch receipts do not match the protected project snapshot"
            )
        if any(
            _request_entry_exists(request_descriptor, name)
            for name in (AGENT_RECEIPT_NAME, SEND_RECEIPT_NAME)
        ):
            raise UnsafeRequest(
                "mismatch diagnosis conflicts with prompt authorization receipts"
            )
        receipt = _validate_process_mismatch_receipt(
            _read_process_mismatch_record(request_descriptor),
            intent,
            workspace,
        )
        closed = _read_request_record(request_descriptor, CLOSED_RECEIPT_NAME)
        diagnostic = receipt["diagnostic"]
        assert isinstance(diagnostic, dict)
        _validate_closed_receipt_for_diagnostic(
            closed,
            workspace,
            diagnostic,
        )
        print(
            json.dumps(
                {
                    "status": "ephemeral-process-mismatch-diagnostic",
                    "receipt": receipt,
                    "cleanup_status": closed["status"],
                },
                ensure_ascii=True,
                sort_keys=True,
            )
        )
        return 0
    finally:
        os.close(request_descriptor)
        os.close(root_descriptor)


def _write_json_record(payload: Dict[str, object]) -> None:
    raw = (json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n").encode("utf-8")
    sys.stdout.flush()
    descriptor = sys.stdout.fileno()
    view = memoryview(raw)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("status record could not be written")
        view = view[written:]


def _prepare_send(args: argparse.Namespace) -> _PreparedSend:
    if os.environ.get("HERDR_ENV") != "1":
        raise UnsafeRequest("HERDR_ENV is not active")
    if getattr(args, "owned", False) is not True:
        raise UnsafeRequest("the ephemeral Claude send path requires --owned")
    _herdr_binary()
    socket_path = _herdr_socket_path()
    root_descriptor = None
    request_descriptor = None
    owned_records = None
    try:
        root_descriptor, root = _open_physical_directory(Path(args.project_root))
        request_descriptor, _request = _request_directory(args.request_dir, root)
        _discard_staged_records(request_descriptor)
        changed, _before_count, _after_count = _verify_unchanged(
            root_descriptor,
            root,
            request_descriptor,
        )
        if changed:
            raise UnsafeRequest("protected metadata changed before fifth-advisor prompt")
        if _request_entry_exists(
            request_descriptor,
            PROCESS_MISMATCH_RECEIPT_NAME,
        ):
            raise UnsafeRequest(
                "ephemeral process mismatch conflicts with prompt authorization"
            )
        body = _read_prompt(request_descriptor)
        owned_records = (
            _read_request_record(request_descriptor, SESSION_INTENT_NAME),
            _read_request_record(request_descriptor, WORKSPACE_RECEIPT_NAME),
            _read_request_record(request_descriptor, AGENT_RECEIPT_NAME),
        )
        marker = secrets.token_hex(16).upper()
        marker_line = f"REQUEST_MARKER={marker}"
        while marker_line in body.splitlines():
            marker = secrets.token_hex(16).upper()
            marker_line = f"REQUEST_MARKER={marker}"
        instruction = body
        if not instruction.endswith("\n"):
            instruction += "\n"
        instruction += (
            "\n応答の最後の独立行に、次のrequest markerをそのまま記載してください。\n"
            f"{marker_line}\n"
        )
        claimed_target = owned_records[1].get("agent_name")
        claimed_nonce = owned_records[1].get("nonce")
        if not isinstance(claimed_target, str) or not isinstance(claimed_nonce, str):
            raise UnsafeRequest("ephemeral Claude receipts are unavailable")
        _validate_target(claimed_target)
        _exclusive_json_record(
            request_descriptor,
            SEND_RECEIPT_NAME,
            {
                "version": EPHEMERAL_SESSION_VERSION,
                "nonce": claimed_nonce,
                "target": claimed_target,
                "marker": marker_line,
                "status": "delivery-possible",
            },
        )
    finally:
        _close_descriptors(request_descriptor, root_descriptor)
    if owned_records is None:
        raise UnsafeRequest("ephemeral Claude receipts are unavailable")
    target = _owned_target(*owned_records)
    request_id = f"fifth_prompt_{secrets.token_hex(16)}"
    request = (
        json.dumps(
            {
                "id": request_id,
                "method": "agent.prompt",
                "params": {
                    "target": target,
                    "text": instruction,
                    "wait": {
                        "until": ["idle", "done", "blocked"],
                        "timeout_ms": PROMPT_WAIT_MS,
                    },
                },
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
    )
    if len(request) > MAX_SOCKET_REQUEST_BYTES:
        raise UnsafeRequest("Herdr prompt request exceeds its managed limit")
    return _PreparedSend(
        request=request,
        request_id=request_id,
        socket_path=socket_path,
        marker_line=marker_line,
        target=target,
    )


def _announce_send(prepared: _PreparedSend) -> None:
    try:
        _write_json_record(
            {
                "status": "prompt-started",
                "marker": prepared.marker_line,
                "target": prepared.target,
            }
        )
    except Exception as error:
        raise UnsafeRequest("prompt marker could not be delivered to the caller") from error


def _attempt_send(prepared: _PreparedSend) -> int:
    try:
        try:
            response = bytearray()
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(PROMPT_SOCKET_TIMEOUT_SECONDS)
                connection.connect(prepared.socket_path)
                connection.sendall(prepared.request)
                while b"\n" not in response:
                    chunk = connection.recv(65_536)
                    if not chunk:
                        raise UnsafeRequest("Herdr socket closed before a response")
                    response.extend(chunk)
                    if len(response) > MAX_SOCKET_RESPONSE_BYTES:
                        raise UnsafeRequest("Herdr prompt response exceeds its limit")
            line, separator, trailing = bytes(response).partition(b"\n")
            if separator != b"\n" or trailing:
                raise UnsafeRequest("Herdr prompt returned an invalid response envelope")
            document = json.loads(line.decode("utf-8"))
            if (
                not isinstance(document, dict)
                or document.get("id") != prepared.request_id
                or ("result" in document) == ("error" in document)
            ):
                raise UnsafeRequest("Herdr prompt returned an invalid response envelope")
            succeeded = isinstance(document.get("result"), dict)
        except Exception:
            _write_json_record({"status": "prompt-command-timeout-or-error"})
            return 5
        _write_json_record(
            {"status": "prompt-command-returned", "returncode": 0 if succeeded else 1}
        )
        return 0 if succeeded else 5
    except Exception:
        return 5


def _send_command(args: argparse.Namespace) -> int:
    prepared = _prepare_send(args)
    _announce_send(prepared)
    try:
        return _attempt_send(prepared)
    except Exception:
        return 5


def main() -> int:
    args = _parse_args()
    try:
        if args.command == "snapshot":
            return _snapshot_command(args)
        if args.command == "open":
            return _open_command(args)
        if args.command == "verify":
            return _verify_command(args)
        if args.command == "recover":
            return _recover_provisional_command(args)
        if args.command == "diagnose":
            return _diagnose_command(args)
        if args.command == "close":
            return _close_command(args)
        return _send_command(args)
    except _OpenSignal as interrupted:
        print(
            (
                "fifth advisor unavailable: interrupted; exact cleanup could not be "
                "verified"
                if interrupted.cleanup_error is not None
                else "fifth advisor unavailable: interrupted after exact cleanup"
            ),
            file=sys.stderr,
        )
        return 128 + interrupted.signum
    except UnsafeRequest as error:
        if args.command == "verify":
            print(
                "fifth advisor response rejected: protected verification failed",
                file=sys.stderr,
            )
            return 4
        print(f"fifth advisor unavailable: {error}", file=sys.stderr)
        return 3
    except Exception:
        if args.command == "verify":
            print(
                "fifth advisor response rejected: protected verification failed",
                file=sys.stderr,
            )
            return 4
        print("fifth advisor unavailable: local safety check failed", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
