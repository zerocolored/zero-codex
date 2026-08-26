#!/usr/bin/env python3
"""Safely transport a fifth-advisor prompt and protect ignored secret paths."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import stat
import subprocess
import sys
from typing import Dict, List, Literal, Tuple, Union


PROMPT_NAME = "prompt"
SNAPSHOT_NAME = "protected-snapshot.json"
# The helper confirms only prompt transport. Model completion is acquired by
# the broker's unbounded Herdr poll, never by this socket request lifetime.
SOCKET_RESPONSE_TIMEOUT_SECONDS = 20
MAX_PROMPT_BYTES = 65_536
MAX_SOCKET_RESPONSE_BYTES = 1_048_576
MAX_SNAPSHOT_BYTES = 1_048_576
MAX_WALK_DEPTH = 64
PROTECTED_SNAPSHOT_VERSION = 4
PROTECTED_POLICY = "protected-components-v1"
PROTECTED_DIGEST_ALGORITHM = "sha256"
PROTECTED_DIGEST_DOMAIN = b"herdr-fifth-advisor-protected-metadata-v4\0"


class UnsafeRequest(ValueError):
    """The fifth-advisor attempt must be skipped before sending."""


class _PreparedSend:
    __slots__ = ("marker_line", "request", "request_id", "socket_path", "socket_identity", "target")

    def __init__(
        self,
        *,
        marker_line: str,
        request: bytes,
        request_id: str,
        socket_path: Path,
        socket_identity: Tuple[int, int, int, int, int],
        target: str,
    ) -> None:
        self.marker_line = marker_line
        self.request = request
        self.request_id = request_id
        self.socket_path = socket_path
        self.socket_identity = socket_identity
        self.target = target

    def __repr__(self) -> str:
        return "_PreparedSend(request=<redacted>)"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Safely send a Herdr fifth-advisor prompt and compare protected "
            "worktree metadata without reading protected file contents."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("snapshot", "verify"):
        child = subparsers.add_parser(command)
        child.add_argument("--project-root", required=True)
        child.add_argument("--request-dir", required=True)
    send = subparsers.add_parser("send")
    send.add_argument("--project-root", required=True)
    send.add_argument("--request-dir", required=True)
    send.add_argument("--target", required=True)
    send.add_argument("--socket-device", required=True, type=int)
    send.add_argument("--socket-inode", required=True, type=int)
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


def _request_directory(path_text: str, project_root: Path) -> Tuple[int, Path]:
    descriptor, physical = _open_physical_directory(Path(path_text))
    metadata = os.fstat(descriptor)
    try:
        if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
            raise UnsafeRequest("request directory must be owner-owned mode 0700")
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
    if name in {"sessions", "logs", "memories"}:
        return True
    if name.startswith(".env"):
        return True
    if any(fragment in name for fragment in ("auth", "credential", "token", "secret")):
        return True
    if name in {
        "history.jsonl",
        "active_sessions.json",
        "models_cache.json",
        "sandbox-events.jsonl",
    }:
        return True
    if name.endswith((".sqlite", ".sqlite3", ".db", ".sock")):
        return True
    return name.startswith("herdr") and name.endswith(".log")


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


def _write_snapshot(directory_descriptor: int, snapshot: Dict[str, object]) -> None:
    raw = (json.dumps(snapshot, ensure_ascii=True, sort_keys=True) + "\n").encode("utf-8")
    if len(raw) > MAX_SNAPSHOT_BYTES:
        raise UnsafeRequest("protected snapshot exceeds its limit")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    if not hasattr(os, "O_NOFOLLOW"):
        raise UnsafeRequest("required no-follow file operations are unavailable")
    flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(
            SNAPSHOT_NAME,
            flags,
            0o600,
            dir_fd=directory_descriptor,
        )
    except OSError as error:
        raise UnsafeRequest("protected snapshot state cannot be created safely") from error
    try:
        os.fchmod(descriptor, 0o600)
        view = memoryview(raw)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise UnsafeRequest("protected snapshot state could not be written")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _load_snapshot(
    directory_descriptor: int,
    project_root: Path,
    project_descriptor: int,
) -> Dict[str, object]:
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
    root_metadata = os.fstat(project_descriptor)
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
        or snapshot.get("project_root") != str(project_root)
        or snapshot.get("project_root_dev") != root_metadata.st_dev
        or snapshot.get("project_root_ino") != root_metadata.st_ino
        or type(protected_count) is not int
        or protected_count < 0
        or not isinstance(protected_digest, str)
        or len(protected_digest) != 64
        or any(character not in "0123456789abcdef" for character in protected_digest)
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
    candidate = shutil.which("herdr")
    if candidate is None:
        raise UnsafeRequest("Herdr is unavailable")
    try:
        resolved = Path(candidate).resolve(strict=True)
    except OSError as error:
        raise UnsafeRequest("Herdr cannot be resolved safely") from error
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise UnsafeRequest("Herdr is not an executable regular file")
    return str(resolved)


def _socket_identity(metadata: os.stat_result) -> Tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_nlink,
    )


def _herdr_socket(
    expected_device: int,
    expected_inode: int,
) -> Tuple[Path, Tuple[int, int, int, int, int]]:
    if expected_device < 0 or expected_inode < 0:
        raise UnsafeRequest("pinned Herdr socket identity is invalid")
    raw = os.environ.get("HERDR_SOCKET_PATH", "")
    path = Path(raw)
    if not raw or not path.is_absolute() or ".." in path.parts:
        raise UnsafeRequest("HERDR_SOCKET_PATH must identify the current Herdr socket")
    parent_descriptor = None
    try:
        parent_descriptor, physical_parent = _open_physical_directory(path.parent)
        parent_metadata = os.fstat(parent_descriptor)
        if parent_metadata.st_uid != os.geteuid() or parent_metadata.st_mode & 0o022:
            raise UnsafeRequest("Herdr socket directory is not owner-controlled")
        physical = physical_parent / path.name
        before = path.lstat()
        observed = physical.lstat()
        if (
            not stat.S_ISSOCK(before.st_mode)
            or before.st_uid != os.geteuid()
            or before.st_nlink != 1
            or before.st_mode & 0o077
            or (before.st_dev, before.st_ino) != (expected_device, expected_inode)
            or _socket_identity(before) != _socket_identity(observed)
        ):
            raise UnsafeRequest("Herdr socket does not match its pinned identity")
        return physical, _socket_identity(before)
    except OSError as error:
        raise UnsafeRequest("Herdr socket cannot be inspected safely") from error
    finally:
        _close_descriptors(parent_descriptor)


def _send_socket_request(
    prepared: _PreparedSend,
) -> Literal["accepted", "rejected", "ambiguous"]:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(SOCKET_RESPONSE_TIMEOUT_SECONDS)
        client.connect(os.fspath(prepared.socket_path))
        after = prepared.socket_path.lstat()
        if _socket_identity(after) != prepared.socket_identity:
            raise UnsafeRequest("Herdr socket changed while connecting")
        client.sendall(prepared.request + b"\n")
        buffered = bytearray()
        while len(buffered) <= MAX_SOCKET_RESPONSE_BYTES:
            chunk = client.recv(min(65_536, MAX_SOCKET_RESPONSE_BYTES - len(buffered) + 1))
            if not chunk:
                break
            buffered.extend(chunk)
            if len(buffered) > MAX_SOCKET_RESPONSE_BYTES:
                raise UnsafeRequest("Herdr socket response exceeded its limit")
            while b"\n" in buffered:
                raw, _, remainder = buffered.partition(b"\n")
                buffered = bytearray(remainder)
                if not raw:
                    continue
                try:
                    response = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise UnsafeRequest("Herdr returned an invalid socket response") from error
                if not isinstance(response, dict) or response.get("id") != prepared.request_id:
                    continue
                result = response.get("result")
                if (
                    "error" not in response
                    and isinstance(result, dict)
                    and result.get("type") == "agent_prompted"
                ):
                    return "accepted"
                error = response.get("error")
                if (
                    isinstance(error, dict)
                    and isinstance(error.get("code"), (str, int))
                    and isinstance(error.get("message"), str)
                    and bool(error.get("message"))
                ):
                    # Only an explicit, structured JSON-RPC error proves that
                    # Herdr rejected the command without enqueueing it. Unknown
                    # success shapes (or malformed/null errors) are ambiguous:
                    # treating them as known-unsent could cause a duplicate.
                    return "rejected"
                return "ambiguous"
        return "ambiguous"
    except (OSError, TimeoutError) as error:
        raise UnsafeRequest("Herdr socket prompt failed") from error
    finally:
        client.close()


def _snapshot_command(args: argparse.Namespace) -> int:
    root_descriptor, root = _physical_git_root(args.project_root)
    request_descriptor, _request = _request_directory(args.request_dir, root)
    try:
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
    _validate_target(args.target)
    # Keep the installed executable as an integrity prerequisite, while using
    # Herdr's documented newline-delimited socket API so the prompt body never
    # appears in this helper's or a child CLI process's argv.
    _herdr_binary()
    socket_path, socket_identity = _herdr_socket(
        args.socket_device,
        args.socket_inode,
    )
    root_descriptor = None
    request_descriptor = None
    try:
        root_descriptor, root = _open_physical_directory(Path(args.project_root))
        request_descriptor, _request = _request_directory(args.request_dir, root)
        _load_snapshot(request_descriptor, root, root_descriptor)
        body = _read_prompt(request_descriptor)
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
        request_id = f"zerokun_{secrets.token_hex(16)}"
        request = json.dumps(
            {
                "id": request_id,
                "method": "agent.prompt",
                "params": {"target": args.target, "text": instruction},
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(request) > MAX_PROMPT_BYTES * 2:
            raise UnsafeRequest("Herdr socket request exceeds its limit")
        prepared = _PreparedSend(
            marker_line=marker_line,
            request=request,
            request_id=request_id,
            socket_path=socket_path,
            socket_identity=socket_identity,
            target=args.target,
        )
    finally:
        _close_descriptors(request_descriptor, root_descriptor)
    return prepared


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
            outcome = _send_socket_request(prepared)
        except Exception:
            _write_json_record({"status": "prompt-command-timeout-or-error"})
            return 5
        if outcome == "rejected":
            _write_json_record({"status": "prompt-command-rejected"})
            return 6
        if outcome == "ambiguous":
            _write_json_record({"status": "prompt-command-timeout-or-error"})
            return 5
        _write_json_record(
            {"status": "prompt-command-returned", "returncode": 0}
        )
        return 0
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
        if args.command == "verify":
            return _verify_command(args)
        return _send_command(args)
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
