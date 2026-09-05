#!/usr/bin/env python3
"""Fail-closed browser OAuth supervisor for the pinned Grok reviewer CLI."""

from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import selectors
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import termios
import time
from urllib.parse import parse_qsl, urlsplit


MAX_IDENTITY_BYTES = 4096
MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024
MAX_AUTH_BYTES = 1024 * 1024
MAX_HELP_BYTES = 64 * 1024
MAX_LOGIN_BYTES = 64 * 1024
MAX_OAUTH_URL_BYTES = 8192
HELP_TIMEOUT_SECONDS = 20
LOGIN_TIMEOUT_SECONDS = 600
TERMINATION_GRACE_SECONDS = 2
FINAL_REAP_SECONDS = 1
READ_CHUNK_BYTES = 16 * 1024
IDENTITY_FIELDS = (
    "st_dev",
    "st_ino",
    "st_mode",
    "st_uid",
    "st_gid",
    "st_nlink",
    "st_size",
    "st_mtime_ns",
    "st_ctime_ns",
)
AUTH_FIELDS = IDENTITY_FIELDS
DIRECTORY_IDENTITY_FIELDS = (
    "st_dev",
    "st_ino",
    "st_mode",
    "st_uid",
    "st_gid",
)
OAUTH_REQUIRED_KEYS = frozenset(
    {
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "nonce",
        "redirect_uri",
        "referrer",
        "response_type",
        "scope",
        "state",
    }
)
OAUTH_OPTIONAL_KEYS: frozenset[str] = frozenset()
OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
OAUTH_REFERRER = "grok-build"
OAUTH_SCOPE = (
    "openid profile email offline_access grok-cli:access api:access "
    "conversations:read conversations:write workspaces:read workspaces:write"
)
URL_TOKEN = re.compile(rb"https://[^\x00-\x20\x7f\x1b]{1,8192}")
OAUTH_CODE_CHALLENGE = re.compile(r"[A-Za-z0-9_-]{43}")
OAUTH_NONCE = re.compile(r"[A-Za-z0-9_-]{36}")
OAUTH_STATE = re.compile(r"[A-Za-z0-9_-]{32}")


class LoginFailure(Exception):
    def __init__(self, status: str, code: int = 126) -> None:
        super().__init__(status)
        self.status = status
        self.code = code


class LoginInterrupted(Exception):
    def __init__(self, signum: int) -> None:
        super().__init__(str(signum))
        self.signum = signum


class SuccessOutputFailure(Exception):
    """The final success record may have reached stdout; emit nothing else."""


_active_process: subprocess.Popen[bytes] | None = None
_active_processes: list[subprocess.Popen[bytes]] = []
_pending_signal: int | None = None
_success_committed = False


def _emit(status: str, *, error: bool = False) -> None:
    destination = sys.stderr if error else sys.stdout
    destination.write(json.dumps({"status": status}, separators=(",", ":")) + "\n")
    destination.flush()


def _signal_group(process: subprocess.Popen[bytes], signum: int) -> bool:
    try:
        os.killpg(process.pid, signum)
        return True
    except ProcessLookupError:
        return False
    except PermissionError as error:
        # A zero-signal EPERM still proves that the process group exists. A
        # real TERM/KILL EPERM means cleanup cannot be proven and must win over
        # any earlier operation result.
        if signum == 0:
            return True
        raise LoginFailure("oauth-login-process-cleanup-failed") from error
    except OSError as error:
        if error.errno == errno.ESRCH:
            return False
        raise


def _publish_process(process: subprocess.Popen[bytes]) -> None:
    global _active_process
    if not any(candidate is process for candidate in _active_processes):
        _active_processes.append(process)
    _active_process = process


def _release_process(process: subprocess.Popen[bytes]) -> None:
    global _active_process
    for index in range(len(_active_processes) - 1, -1, -1):
        if _active_processes[index] is process:
            del _active_processes[index]
            break
    _active_process = _active_processes[-1] if _active_processes else None


def _wait_process(process: subprocess.Popen[bytes], seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return True
        time.sleep(0.05)
    return process.poll() is not None


def _group_exists(process: subprocess.Popen[bytes]) -> bool:
    return _signal_group(process, 0)


def _wait_group_exit(process: subprocess.Popen[bytes], seconds: float) -> bool:
    deadline = time.monotonic() + max(0.0, seconds)
    while True:
        leader_exited = process.poll() is not None
        if leader_exited and not _group_exists(process):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def _terminate_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None or _group_exists(process):
        _signal_group(process, signal.SIGTERM)
    if not _wait_group_exit(process, TERMINATION_GRACE_SECONDS):
        _signal_group(process, signal.SIGKILL)
        if not _wait_group_exit(process, FINAL_REAP_SECONDS):
            raise LoginFailure("oauth-login-process-cleanup-failed")
    if not _wait_process(process, FINAL_REAP_SECONDS):
        raise LoginFailure("oauth-login-process-cleanup-failed")


def _final_process_sweep() -> None:
    """Retry every retained child cleanup before the helper can exit."""
    active = list(_active_processes)
    if _active_process is not None and not any(
        candidate is _active_process for candidate in active
    ):
        active.append(_active_process)
    if not active:
        return

    first_error: BaseException | None = None
    for process in reversed(active):
        cleaned = True
        try:
            _terminate_group(process)
        except (LoginFailure, OSError) as error:
            first_error = first_error or error
            cleaned = False
        try:
            _close_streams(
                (
                    getattr(process, "stdin", None),
                    getattr(process, "stdout", None),
                    getattr(process, "stderr", None),
                ),
                status="oauth-login-process-cleanup-failed",
            )
        except LoginFailure as error:
            first_error = first_error or error
            cleaned = False
        if cleaned:
            _release_process(process)

    # Reaching this sweep means an inner lifecycle path failed to release a
    # child. Even when the retry succeeds, completion must remain fail-closed.
    if first_error is not None:
        raise LoginFailure("oauth-login-process-cleanup-failed") from first_error
    raise LoginFailure("oauth-login-process-cleanup-failed")


def _handle_signal(signum: int, _frame: object) -> None:
    global _pending_signal
    if _success_committed:
        return
    if _pending_signal is None:
        _pending_signal = signum
    active = list(_active_processes)
    if _active_process is not None and not any(
        candidate is _active_process for candidate in active
    ):
        active.append(_active_process)
    for process in reversed(active):
        try:
            _signal_group(process, signal.SIGTERM)
        except (LoginFailure, OSError):
            pass


def _raise_if_interrupted() -> None:
    if _pending_signal is not None:
        raise LoginInterrupted(_pending_signal)


def _close_descriptors(
    descriptors: tuple[int | None, ...],
    *,
    status: str = "oauth-login-cleanup-failed",
    allow_ebadf: bool = False,
) -> None:
    first_error: OSError | None = None
    for descriptor in descriptors:
        if descriptor is None:
            continue
        try:
            os.close(descriptor)
        except OSError as error:
            if allow_ebadf and error.errno == errno.EBADF:
                continue
            first_error = first_error or error
    if first_error is not None:
        raise LoginFailure(status) from first_error


def _close_streams(
    streams: tuple[object | None, ...],
    *,
    status: str = "oauth-login-cleanup-failed",
) -> None:
    first_error: BaseException | None = None
    for stream in streams:
        if stream is None or getattr(stream, "closed", False):
            continue
        try:
            stream.close()  # type: ignore[attr-defined]
        except (OSError, ValueError) as error:
            first_error = first_error or error
    if first_error is not None:
        raise LoginFailure(status) from first_error


def _safe_regular_bytes(path: Path, maximum: int, *, owner_only: bool) -> bytes:
    flags = os.O_RDONLY
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.getuid()
            or before.st_nlink != 1
            or before.st_size <= 0
            or before.st_size > maximum
            or (owner_only and stat.S_IMODE(before.st_mode) & 0o077)
        ):
            raise LoginFailure("oauth-login-unsafe-installation")
        raw = os.read(descriptor, maximum + 1)
        after = os.fstat(descriptor)
        if len(raw) != before.st_size or any(
            getattr(before, field) != getattr(after, field)
            for field in IDENTITY_FIELDS
        ):
            raise LoginFailure("oauth-login-unsafe-installation")
        return raw
    finally:
        _close_descriptors((descriptor,))


def _load_identity(reviewer_root: Path, grok: Path) -> dict[str, object]:
    raw = _safe_regular_bytes(
        reviewer_root / "grok-identity.json",
        MAX_IDENTITY_BYTES,
        owner_only=True,
    )
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError) as error:
        raise LoginFailure("oauth-login-unsafe-installation") from error
    expected_keys = {"version", "path", "sha256", *IDENTITY_FIELDS}
    if not isinstance(document, dict) or set(document) != expected_keys:
        raise LoginFailure("oauth-login-unsafe-installation")
    if document.get("version") != 1 or document.get("path") != str(grok):
        raise LoginFailure("oauth-login-unsafe-installation")
    digest = document.get("sha256")
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise LoginFailure("oauth-login-unsafe-installation")
    for field in IDENTITY_FIELDS:
        value = document.get(field)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise LoginFailure("oauth-login-unsafe-installation")
    return document


def _validate_executable(grok: Path, identity: dict[str, object]) -> None:
    if not grok.is_absolute() or grok.resolve(strict=True) != grok:
        raise LoginFailure("oauth-login-grok-identity-mismatch")
    flags = os.O_RDONLY
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(grok, flags)
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size <= 0
            or before.st_size > MAX_EXECUTABLE_BYTES
            or not before.st_mode & 0o111
            or any(getattr(before, field) != identity[field] for field in IDENTITY_FIELDS)
        ):
            raise LoginFailure("oauth-login-grok-identity-mismatch")
        digest = hashlib.sha256()
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise LoginFailure("oauth-login-grok-identity-mismatch")
            digest.update(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1) or digest.hexdigest() != identity["sha256"]:
            raise LoginFailure("oauth-login-grok-identity-mismatch")
        after = os.fstat(descriptor)
        if any(
            getattr(before, field) != getattr(after, field)
            for field in IDENTITY_FIELDS
        ):
            raise LoginFailure("oauth-login-grok-identity-mismatch")
    except OSError as error:
        raise LoginFailure("oauth-login-grok-identity-mismatch") from error
    finally:
        _close_descriptors((descriptor,))


def _materialize_verified_executable(
    grok: Path, identity: dict[str, object], runtime_root: Path
) -> tuple[Path, tuple[int, ...], str]:
    source_flags = os.O_RDONLY
    destination_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NONBLOCK"):
        source_flags |= os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        source_flags |= os.O_NOFOLLOW
        destination_flags |= os.O_NOFOLLOW
    executable_directory = runtime_root / "bin"
    destination_path = executable_directory / "grok"
    source = None
    destination = None
    try:
        source = os.open(grok, source_flags)
        executable_directory.mkdir(mode=0o700)
        before = os.fstat(source)
        if any(getattr(before, field) != identity[field] for field in IDENTITY_FIELDS):
            raise LoginFailure("oauth-login-grok-identity-mismatch")
        destination = os.open(destination_path, destination_flags, 0o500)
        digest = hashlib.sha256()
        remaining = before.st_size
        while remaining:
            chunk = os.read(source, min(1024 * 1024, remaining))
            if not chunk:
                raise LoginFailure("oauth-login-grok-identity-mismatch")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(destination, view)
                if written <= 0:
                    raise LoginFailure("oauth-login-runtime-error")
                view = view[written:]
            remaining -= len(chunk)
        if os.read(source, 1) or digest.hexdigest() != identity["sha256"]:
            raise LoginFailure("oauth-login-grok-identity-mismatch")
        os.fchmod(destination, 0o500)
        os.fsync(destination)
        source_after = os.fstat(source)
        if any(
            getattr(source_after, field) != identity[field]
            for field in IDENTITY_FIELDS
        ):
            raise LoginFailure("oauth-login-grok-identity-mismatch")
        copied = os.fstat(destination)
        copied_identity = tuple(
            getattr(copied, field) for field in IDENTITY_FIELDS
        )
        if (
            not stat.S_ISREG(copied.st_mode)
            or copied.st_uid != os.getuid()
            or copied.st_nlink != 1
            or stat.S_IMODE(copied.st_mode) != 0o500
            or copied.st_size != before.st_size
        ):
            raise LoginFailure("oauth-login-runtime-error")
        executable_directory.chmod(0o500)
        return destination_path, copied_identity, digest.hexdigest()
    except OSError as error:
        raise LoginFailure("oauth-login-runtime-error") from error
    finally:
        _close_descriptors(
            (destination, source),
            allow_ebadf=True,
        )


def _validate_materialized_executable(
    executable: Path, expected: tuple[int, ...], expected_digest: str
) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(executable, flags)
    try:
        before = os.fstat(descriptor)
        observed = tuple(getattr(before, field) for field in IDENTITY_FIELDS)
        if observed != expected:
            raise LoginFailure("oauth-login-grok-identity-mismatch")
        digest = hashlib.sha256()
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise LoginFailure("oauth-login-grok-identity-mismatch")
            digest.update(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1) or digest.hexdigest() != expected_digest:
            raise LoginFailure("oauth-login-grok-identity-mismatch")
        after = os.fstat(descriptor)
        if tuple(getattr(after, field) for field in IDENTITY_FIELDS) != expected:
            raise LoginFailure("oauth-login-grok-identity-mismatch")
    except OSError as error:
        raise LoginFailure("oauth-login-grok-identity-mismatch") from error
    finally:
        _close_descriptors((descriptor,))


def _auth_metadata(
    user_home: Path,
    *,
    allow_missing: bool = False,
    create_directory: bool = False,
) -> tuple[str, tuple[int, ...], tuple[int, ...] | None]:
    """Classify auth without reading it or following either path component."""

    directory_flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        directory_flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        directory_flags |= os.O_NOFOLLOW

    try:
        home_descriptor = os.open(user_home, directory_flags)
    except OSError as error:
        raise LoginFailure("oauth-login-unsafe-auth") from error
    grok_descriptor: int | None = None
    auth_descriptor: int | None = None
    try:
        home_before = os.fstat(home_descriptor)
        home_path = user_home.lstat()
        if (
            not stat.S_ISDIR(home_before.st_mode)
            or stat.S_ISLNK(home_path.st_mode)
            or home_before.st_uid != os.getuid()
            or stat.S_IMODE(home_before.st_mode) & 0o022
            or any(
                getattr(home_before, field) != getattr(home_path, field)
                for field in DIRECTORY_IDENTITY_FIELDS
            )
        ):
            raise LoginFailure("oauth-login-unsafe-auth")

        created_directory = False
        try:
            os.stat(".grok", dir_fd=home_descriptor, follow_symlinks=False)
        except FileNotFoundError:
            if not allow_missing:
                raise LoginFailure("oauth-login-unsafe-auth")
            if not create_directory:
                home_identity = tuple(
                    getattr(home_before, field)
                    for field in DIRECTORY_IDENTITY_FIELDS
                )
                return ("missing-directory", home_identity, None)
            try:
                os.mkdir(".grok", mode=0o700, dir_fd=home_descriptor)
                created_directory = True
                os.fsync(home_descriptor)
            except FileExistsError:
                pass

        grok_descriptor = os.open(
            ".grok", directory_flags, dir_fd=home_descriptor
        )
        directory = os.fstat(grok_descriptor)
        directory_path = os.stat(
            ".grok", dir_fd=home_descriptor, follow_symlinks=False
        )
        if created_directory:
            os.fchmod(grok_descriptor, 0o700)
            os.fsync(grok_descriptor)
            directory = os.fstat(grok_descriptor)
            directory_path = os.stat(
                ".grok", dir_fd=home_descriptor, follow_symlinks=False
            )
        if (
            not stat.S_ISDIR(directory.st_mode)
            or stat.S_ISLNK(directory_path.st_mode)
            or directory.st_uid != os.getuid()
            or stat.S_IMODE(directory.st_mode) & 0o022
            or any(
                getattr(directory, field) != getattr(directory_path, field)
                for field in DIRECTORY_IDENTITY_FIELDS
            )
        ):
            raise LoginFailure("oauth-login-unsafe-auth")
        directory_identity = tuple(
            getattr(directory, field) for field in DIRECTORY_IDENTITY_FIELDS
        )

        auth_flags = os.O_RDONLY
        if hasattr(os, "O_NONBLOCK"):
            auth_flags |= os.O_NONBLOCK
        if hasattr(os, "O_NOFOLLOW"):
            auth_flags |= os.O_NOFOLLOW
        try:
            auth_descriptor = os.open(
                "auth.json", auth_flags, dir_fd=grok_descriptor
            )
        except FileNotFoundError:
            if allow_missing:
                return ("missing", directory_identity, None)
            raise LoginFailure("oauth-login-unsafe-auth")
        except OSError as error:
            raise LoginFailure("oauth-login-unsafe-auth") from error

        metadata = os.fstat(auth_descriptor)
        observed = os.stat(
            "auth.json", dir_fd=grok_descriptor, follow_symlinks=False
        )
        if (
            not stat.S_ISREG(metadata.st_mode)
            or stat.S_ISLNK(observed.st_mode)
            or metadata.st_uid != os.getuid()
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) & 0o077
            or metadata.st_size <= 0
            or metadata.st_size > MAX_AUTH_BYTES
            or any(
                getattr(metadata, field) != getattr(observed, field)
                for field in AUTH_FIELDS
            )
        ):
            raise LoginFailure("oauth-login-unsafe-auth")
        stable = os.fstat(auth_descriptor)
        if any(
            getattr(metadata, field) != getattr(stable, field)
            for field in AUTH_FIELDS
        ):
            raise LoginFailure("oauth-login-unsafe-auth")
        auth_identity = tuple(
            getattr(metadata, field) for field in AUTH_FIELDS
        )
        return ("present", directory_identity, auth_identity)
    except OSError as error:
        raise LoginFailure("oauth-login-unsafe-auth") from error
    finally:
        _close_descriptors(
            (auth_descriptor, grok_descriptor, home_descriptor),
            allow_ebadf=True,
        )


def _auth_transition_is_valid(
    before: tuple[str, tuple[int, ...], tuple[int, ...] | None],
    after: tuple[str, tuple[int, ...], tuple[int, ...] | None],
) -> bool:
    before_kind, before_directory, before_file = before
    after_kind, after_directory, after_file = after
    if after_kind != "present" or after_file is None:
        return False
    if before_directory != after_directory:
        return False
    if before_kind == "missing":
        return before_file is None
    if before_kind == "present" and before_file is not None:
        return before_file != after_file
    return False


def _minimal_environment(
    user_home: Path, runtime_root: Path, runtime_path: str, runtime_lang: str
) -> dict[str, str]:
    return {
        "HOME": str(user_home),
        "LANG": runtime_lang,
        "LC_ALL": runtime_lang,
        "PATH": runtime_path,
        "TERM": "dumb",
        "TMPDIR": str(runtime_root),
    }


def _capture_bounded(
    process: subprocess.Popen[bytes], maximum: int, deadline: float
) -> bytes:
    if process.stdout is None:
        raise LoginFailure("oauth-login-runtime-error")
    selector: selectors.BaseSelector | None = None
    captured = bytearray()
    try:
        descriptor = process.stdout.fileno()
        os.set_blocking(descriptor, False)
        selector = selectors.DefaultSelector()
        selector.register(descriptor, selectors.EVENT_READ)
        while selector.get_map():
            _raise_if_interrupted()
            if time.monotonic() >= deadline:
                raise LoginFailure("oauth-login-timeout", 124)
            events = selector.select(timeout=min(0.1, deadline - time.monotonic()))
            for key, _mask in events:
                try:
                    chunk = os.read(key.fd, READ_CHUNK_BYTES)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fd)
                    continue
                if len(captured) + len(chunk) > maximum:
                    raise LoginFailure("oauth-login-output-limit", 69)
                captured.extend(chunk)
            if process.poll() is not None and not events:
                try:
                    chunk = os.read(descriptor, READ_CHUNK_BYTES)
                except (BlockingIOError, OSError):
                    chunk = b""
                if not chunk:
                    selector.unregister(descriptor)
                elif len(captured) + len(chunk) > maximum:
                    raise LoginFailure("oauth-login-output-limit", 69)
                else:
                    captured.extend(chunk)
        _raise_if_interrupted()
        remaining = max(0.0, deadline - time.monotonic())
        process.wait(timeout=remaining)
        _raise_if_interrupted()
        remaining = max(0.0, deadline - time.monotonic())
        if not _wait_group_exit(process, min(FINAL_REAP_SECONDS, remaining)):
            raise LoginFailure("oauth-login-process-remained")
        return bytes(captured)
    except subprocess.TimeoutExpired as error:
        raise LoginFailure("oauth-login-timeout", 124) from error
    finally:
        cleanup_error: BaseException | None = None
        if selector is not None:
            try:
                selector.close()
            except (OSError, ValueError) as error:
                cleanup_error = error
        try:
            _close_streams((process.stdout,))
        except LoginFailure as error:
            cleanup_error = cleanup_error or error
        if cleanup_error is not None:
            raise LoginFailure("oauth-login-cleanup-failed") from cleanup_error


def _validate_oauth_url(raw: str) -> str:
    if not 1 <= len(raw.encode("ascii", "strict")) <= MAX_OAUTH_URL_BYTES:
        raise LoginFailure("oauth-login-url-rejected")
    if re.fullmatch(r"[A-Za-z0-9._~:/?\[\]@!$&'()*+,;=%#-]+", raw) is None:
        raise LoginFailure("oauth-login-url-rejected")
    parsed = urlsplit(raw)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "auth.x.ai"
        or parsed.hostname != "auth.x.ai"
        or parsed.port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/oauth2/authorize"
        or not parsed.query
        or parsed.fragment
    ):
        raise LoginFailure("oauth-login-url-rejected")
    try:
        raw_keys = []
        for field in parsed.query.split("&"):
            key, separator, _value = field.partition("=")
            if separator != "=" or re.fullmatch(r"[a-z_]+", key) is None:
                raise LoginFailure("oauth-login-url-rejected")
            raw_keys.append(key)
        pairs = parse_qsl(
            parsed.query,
            keep_blank_values=True,
            strict_parsing=True,
            max_num_fields=16,
        )
    except ValueError as error:
        raise LoginFailure("oauth-login-url-rejected") from error
    if len(pairs) != len({key for key, _value in pairs}):
        raise LoginFailure("oauth-login-url-rejected")
    values = dict(pairs)
    keys = set(values)
    if not OAUTH_REQUIRED_KEYS <= keys or not keys <= (
        OAUTH_REQUIRED_KEYS | OAUTH_OPTIONAL_KEYS
    ):
        raise LoginFailure("oauth-login-url-rejected")
    if values["response_type"] != "code" or values["code_challenge_method"] != "S256":
        raise LoginFailure("oauth-login-url-rejected")
    if raw_keys != [key for key, _value in pairs]:
        raise LoginFailure("oauth-login-url-rejected")
    if values["client_id"] != OAUTH_CLIENT_ID:
        raise LoginFailure("oauth-login-url-rejected")
    if OAUTH_STATE.fullmatch(values["state"]) is None or OAUTH_CODE_CHALLENGE.fullmatch(
        values["code_challenge"]
    ) is None:
        raise LoginFailure("oauth-login-url-rejected")
    if OAUTH_NONCE.fullmatch(values["nonce"]) is None:
        raise LoginFailure("oauth-login-url-rejected")
    redirect = urlsplit(values["redirect_uri"])
    try:
        redirect_port = redirect.port
    except ValueError as error:
        raise LoginFailure("oauth-login-url-rejected") from error
    if (
        redirect.scheme != "http"
        or redirect.hostname != "127.0.0.1"
        or redirect.username is not None
        or redirect.password is not None
        or redirect.netloc != f"127.0.0.1:{redirect_port}"
        or redirect_port is None
        or not 1024 <= redirect_port <= 65535
        or redirect.path != "/callback"
        or redirect.query
        or redirect.fragment
    ):
        raise LoginFailure("oauth-login-url-rejected")
    if values["scope"] != OAUTH_SCOPE or values["referrer"] != OAUTH_REFERRER:
        raise LoginFailure("oauth-login-url-rejected")
    return raw


def _completed_url_tokens(captured: bytes) -> list[bytes]:
    result = []
    for match in URL_TOKEN.finditer(captured):
        if match.end() == len(captured):
            continue
        following = captured[match.end()]
        if following > 0x20 and following not in {0x7F, 0x1B}:
            continue
        result.append(match.group(0))
    return result


def _url_token_count(captured: bytes) -> int:
    return sum(1 for _match in URL_TOKEN.finditer(captured))


def _open_chrome(url: str, deadline: float) -> None:
    if '"' in url or "\\" in url or "\n" in url or "\r" in url:
        raise LoginFailure("oauth-login-url-rejected")
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise LoginFailure("oauth-login-timeout", 124)
    script = f'tell application "Google Chrome" to open location "{url}"\n'
    process: subprocess.Popen[bytes] | None = None
    try:
        _raise_if_interrupted()
        process = subprocess.Popen(
            ["/usr/bin/osascript", "-"],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/bin"},
            cwd="/",
            start_new_session=True,
            close_fds=True,
        )
        _publish_process(process)
        _raise_if_interrupted()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise LoginFailure("oauth-login-timeout", 124)
        process.communicate(
            input=script.encode("ascii"), timeout=min(20.0, remaining)
        )
        _raise_if_interrupted()
    except subprocess.TimeoutExpired as error:
        if time.monotonic() >= deadline:
            raise LoginFailure("oauth-login-timeout", 124) from error
        raise LoginFailure("oauth-login-browser-open-failed") from error
    except OSError as error:
        raise LoginFailure("oauth-login-browser-open-failed") from error
    finally:
        cleanup_error: BaseException | None = None
        if process is not None:
            try:
                _close_streams(
                    (process.stdin,),
                    status="oauth-login-process-cleanup-failed",
                )
            except LoginFailure as error:
                cleanup_error = error
            try:
                _terminate_group(process)
            except (LoginFailure, OSError) as error:
                cleanup_error = cleanup_error or error
        if cleanup_error is None and process is not None:
            _release_process(process)
        if cleanup_error is not None:
            raise LoginFailure(
                "oauth-login-process-cleanup-failed"
            ) from cleanup_error
    _raise_if_interrupted()
    if time.monotonic() >= deadline:
        raise LoginFailure("oauth-login-timeout", 124)
    if process is None or process.returncode != 0:
        raise LoginFailure("oauth-login-browser-open-failed")


def _run_login(
    grok: Path,
    copied_identity: tuple[int, ...],
    copied_digest: str,
    environment: dict[str, str],
    runtime_root: Path,
    deadline: float,
) -> None:
    _validate_materialized_executable(grok, copied_identity, copied_digest)
    master, slave = pty.openpty()
    process: subprocess.Popen[bytes] | None = None
    slave_open = True
    try:
        _raise_if_interrupted()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 32767, 0, 0))
        process = subprocess.Popen(
            [str(grok), "login", "--oauth"],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=runtime_root,
            env=environment,
            start_new_session=True,
            close_fds=True,
        )
        _publish_process(process)
        _raise_if_interrupted()
        _close_descriptors(
            (slave,),
            status="oauth-login-process-cleanup-failed",
        )
        slave_open = False
        captured = bytearray()
        browser_opened = False
        pty_eof = False
        os.set_blocking(master, False)
        _validate_materialized_executable(grok, copied_identity, copied_digest)
        while True:
            _raise_if_interrupted()
            if time.monotonic() >= deadline:
                raise LoginFailure("oauth-login-timeout", 124)
            try:
                chunk = os.read(master, READ_CHUNK_BYTES)
            except BlockingIOError:
                chunk = b""
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
                pty_eof = True
            else:
                if not chunk:
                    pty_eof = True
            if chunk:
                if len(captured) + len(chunk) > MAX_LOGIN_BYTES:
                    raise LoginFailure("oauth-login-output-limit", 69)
                captured.extend(chunk)
                if b"\x1b" in captured or any(
                    byte < 0x20 and byte not in {0x09, 0x0A, 0x0D}
                    for byte in captured
                ):
                    raise LoginFailure("oauth-login-control-sequence-rejected")
                if _url_token_count(bytes(captured)) > 1:
                    raise LoginFailure("oauth-login-url-rejected")
                tokens = _completed_url_tokens(bytes(captured))
                if len(tokens) > 1:
                    raise LoginFailure("oauth-login-url-rejected")
                if tokens and not browser_opened:
                    try:
                        candidate = tokens[0].decode("ascii")
                    except UnicodeDecodeError as error:
                        raise LoginFailure("oauth-login-url-rejected") from error
                    candidate = _validate_oauth_url(candidate)
                    _open_chrome(candidate, deadline)
                    _raise_if_interrupted()
                    browser_opened = True
                    _emit("oauth-browser-opened")
            if process.poll() is not None and pty_eof:
                break
            time.sleep(0.05)
        _raise_if_interrupted()
        try:
            bytes(captured).decode("utf-8")
        except UnicodeDecodeError as error:
            raise LoginFailure("oauth-login-control-sequence-rejected") from error
        if (
            not browser_opened
            or process.returncode != 0
            or len(_completed_url_tokens(bytes(captured))) != 1
        ):
            raise LoginFailure("oauth-login-failed", 1)
        remaining = max(0.0, deadline - time.monotonic())
        if not _wait_group_exit(process, min(FINAL_REAP_SECONDS, remaining)):
            _terminate_group(process)
            raise LoginFailure("oauth-login-process-remained")
        _raise_if_interrupted()
        _validate_materialized_executable(grok, copied_identity, copied_digest)
    finally:
        cleanup_error: BaseException | None = None
        process_cleanup_succeeded = process is None
        if slave_open:
            try:
                _close_descriptors(
                    (slave,),
                    status="oauth-login-process-cleanup-failed",
                    allow_ebadf=True,
                )
            except LoginFailure as error:
                cleanup_error = error
        if process is not None:
            try:
                _terminate_group(process)
            except (LoginFailure, OSError) as error:
                cleanup_error = cleanup_error or error
            else:
                process_cleanup_succeeded = True
        try:
            _close_descriptors(
                (master,),
                status="oauth-login-process-cleanup-failed",
                allow_ebadf=True,
            )
        except LoginFailure as error:
            cleanup_error = cleanup_error or error
        if (
            cleanup_error is None
            and process_cleanup_succeeded
            and process is not None
        ):
            _release_process(process)
        if cleanup_error is not None:
            raise LoginFailure("oauth-login-process-cleanup-failed") from cleanup_error


def _remove_empty_runtime_root(
    reviewer_root: Path,
    runtime_root: Path,
    identity: tuple[int, int] | None,
) -> None:
    metadata = os.stat(runtime_root, follow_symlinks=False)
    if (
        runtime_root.parent != reviewer_root
        or not runtime_root.name.startswith("oauth.")
        or not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or (identity is not None and (metadata.st_dev, metadata.st_ino) != identity)
    ):
        raise LoginFailure("oauth-login-cleanup-failed")
    os.rmdir(runtime_root)
    try:
        os.stat(runtime_root, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise LoginFailure("oauth-login-cleanup-failed")


def _safe_runtime_root(reviewer_root: Path) -> tuple[Path, tuple[int, int]]:
    runtime_root = Path(tempfile.mkdtemp(prefix="oauth.", dir=reviewer_root))
    identity: tuple[int, int] | None = None
    descriptor: int | None = None
    try:
        metadata = os.stat(runtime_root, follow_symlinks=False)
        if (
            runtime_root.parent != reviewer_root
            or not runtime_root.name.startswith("oauth.")
            or not stat.S_ISDIR(metadata.st_mode)
            or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_uid != os.getuid()
        ):
            raise LoginFailure("oauth-login-runtime-error")
        identity = (metadata.st_dev, metadata.st_ino)
        flags = os.O_RDONLY
        if hasattr(os, "O_DIRECTORY"):
            flags |= os.O_DIRECTORY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(runtime_root, flags)
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or opened.st_uid != os.getuid()
            or (opened.st_dev, opened.st_ino) != identity
        ):
            raise LoginFailure("oauth-login-runtime-error")
        os.fchmod(descriptor, 0o700)
        final = os.fstat(descriptor)
        if (
            (final.st_dev, final.st_ino) != identity
            or stat.S_IMODE(final.st_mode) != 0o700
        ):
            raise LoginFailure("oauth-login-runtime-error")
        _close_descriptors((descriptor,))
        descriptor = None
        return runtime_root, identity
    except BaseException as operation_error:
        cleanup_error: BaseException | None = None
        if descriptor is not None:
            try:
                _close_descriptors((descriptor,), allow_ebadf=True)
            except LoginFailure as error:
                cleanup_error = error
        try:
            _remove_empty_runtime_root(reviewer_root, runtime_root, identity)
        except (LoginFailure, OSError) as error:
            cleanup_error = cleanup_error or error
        if cleanup_error is not None:
            raise LoginFailure("oauth-login-cleanup-failed") from cleanup_error
        if isinstance(operation_error, LoginFailure):
            raise
        raise LoginFailure("oauth-login-runtime-error") from operation_error


def _remove_runtime_root(
    reviewer_root: Path, runtime_root: Path, identity: tuple[int, int]
) -> None:
    metadata = runtime_root.lstat()
    if (
        runtime_root.parent != reviewer_root
        or not runtime_root.name.startswith("oauth.")
        or not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or (metadata.st_dev, metadata.st_ino) != identity
    ):
        raise LoginFailure("oauth-login-cleanup-failed")
    executable_directory = runtime_root / "bin"
    try:
        executable_metadata = executable_directory.lstat()
    except FileNotFoundError:
        pass
    else:
        if (
            not stat.S_ISDIR(executable_metadata.st_mode)
            or stat.S_ISLNK(executable_metadata.st_mode)
            or executable_metadata.st_uid != os.getuid()
        ):
            raise LoginFailure("oauth-login-cleanup-failed")
        executable_directory.chmod(0o700)
    shutil.rmtree(runtime_root)
    if runtime_root.exists() or runtime_root.is_symlink():
        raise LoginFailure("oauth-login-cleanup-failed")


def _acquire_lock(reviewer_root: Path) -> int:
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(reviewer_root / "oauth-login.lock", flags, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) & 0o077
        ):
            raise LoginFailure("oauth-login-unsafe-installation")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise LoginFailure("oauth-login-already-running", 75) from error
        return descriptor
    except BaseException:
        try:
            _close_descriptors((descriptor,), allow_ebadf=True)
        except LoginFailure:
            raise
        raise


def _main(arguments: list[str]) -> int:
    if len(arguments) != 5 or sys.platform != "darwin":
        raise LoginFailure("oauth-login-unsupported", 64)
    reviewer_root = Path(arguments[0])
    user_home = Path(arguments[1])
    grok = Path(arguments[2])
    runtime_path = arguments[3]
    runtime_lang = arguments[4]
    if (
        not reviewer_root.is_absolute()
        or not user_home.is_absolute()
        or not grok.is_absolute()
        or "\x00" in runtime_path
        or not runtime_path
        or len(runtime_lang) > 128
    ):
        raise LoginFailure("oauth-login-invalid-invocation", 64)
    reviewer_root = reviewer_root.resolve(strict=True)
    user_home = user_home.resolve(strict=True)
    root_metadata = reviewer_root.lstat()
    if (
        not stat.S_ISDIR(root_metadata.st_mode)
        or stat.S_ISLNK(root_metadata.st_mode)
        or root_metadata.st_uid != os.getuid()
        or stat.S_IMODE(root_metadata.st_mode) & 0o022
        or user_home != Path.home().resolve(strict=True)
    ):
        raise LoginFailure("oauth-login-unsafe-installation")
    lock = _acquire_lock(reviewer_root)
    runtime_root: Path | None = None
    runtime_identity: tuple[int, int] | None = None
    try:
        overall_deadline = time.monotonic() + LOGIN_TIMEOUT_SECONDS
        identity = _load_identity(reviewer_root, grok)
        _validate_executable(grok, identity)
        # A phase may authorize recovery from either a safe existing file that
        # became unauthenticated or a safe first-login absence.  Normalize a
        # missing .grok directory to an owned 0700 directory before Grok runs.
        auth_before = _auth_metadata(
            user_home, allow_missing=True, create_directory=True
        )
        runtime_root, runtime_identity = _safe_runtime_root(reviewer_root)
        pinned_grok, copied_identity, copied_digest = (
            _materialize_verified_executable(grok, identity, runtime_root)
        )
        _validate_executable(grok, identity)
        environment = _minimal_environment(
            user_home, runtime_root, runtime_path, runtime_lang
        )
        _validate_materialized_executable(
            pinned_grok, copied_identity, copied_digest
        )
        help_process: subprocess.Popen[bytes] | None = None
        try:
            _raise_if_interrupted()
            help_process = subprocess.Popen(
                [str(pinned_grok), "login", "--help"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                cwd=runtime_root,
                env=environment,
                start_new_session=True,
                close_fds=True,
            )
            _publish_process(help_process)
            _raise_if_interrupted()
            help_output = _capture_bounded(
                help_process,
                MAX_HELP_BYTES,
                min(
                    overall_deadline,
                    time.monotonic() + HELP_TIMEOUT_SECONDS,
                ),
            )
        finally:
            cleanup_error = None
            process_cleanup_succeeded = help_process is None
            if help_process is not None:
                try:
                    _terminate_group(help_process)
                except (LoginFailure, OSError) as error:
                    cleanup_error = error
                else:
                    process_cleanup_succeeded = True
                if help_process.stdout is not None and not help_process.stdout.closed:
                    try:
                        _close_streams(
                            (help_process.stdout,),
                            status="oauth-login-process-cleanup-failed",
                        )
                    except LoginFailure as error:
                        cleanup_error = cleanup_error or error
            if (
                cleanup_error is None
                and process_cleanup_succeeded
                and help_process is not None
            ):
                _release_process(help_process)
            if cleanup_error is not None:
                raise LoginFailure(
                    "oauth-login-process-cleanup-failed"
                ) from cleanup_error
        _raise_if_interrupted()
        _validate_materialized_executable(
            pinned_grok, copied_identity, copied_digest
        )
        try:
            help_text = help_output.decode("utf-8")
        except UnicodeDecodeError as error:
            raise LoginFailure("oauth-login-help-rejected") from error
        if help_process.returncode != 0 or re.search(
            r"(?m)^[\t ]*--oauth(?:[\t ]|$)", help_text
        ) is None:
            raise LoginFailure("oauth-login-help-rejected")
        if time.monotonic() >= overall_deadline:
            raise LoginFailure("oauth-login-timeout", 124)
        auth_at_login = _auth_metadata(user_home, allow_missing=True)
        if auth_at_login != auth_before:
            raise LoginFailure("oauth-login-auth-changed-before-start", 1)
        _run_login(
            pinned_grok,
            copied_identity,
            copied_digest,
            environment,
            runtime_root,
            overall_deadline,
        )
        _validate_executable(grok, identity)
        auth_after = _auth_metadata(user_home)
        if auth_after == auth_before:
            raise LoginFailure("oauth-login-auth-unchanged", 1)
        if not _auth_transition_is_valid(auth_before, auth_after):
            raise LoginFailure("oauth-login-unsafe-auth")
        if time.monotonic() >= overall_deadline:
            raise LoginFailure("oauth-login-timeout", 124)
    finally:
        cleanup_error: BaseException | None = None
        try:
            _final_process_sweep()
        except LoginFailure as error:
            cleanup_error = error
        active_process_remains = bool(_active_processes) or _active_process is not None
        if runtime_root is not None and runtime_identity is not None:
            if active_process_remains:
                cleanup_error = cleanup_error or LoginFailure(
                    "oauth-login-process-cleanup-failed"
                )
            else:
                try:
                    _remove_runtime_root(
                        reviewer_root, runtime_root, runtime_identity
                    )
                except (LoginFailure, OSError) as error:
                    cleanup_error = cleanup_error or error
        try:
            _close_descriptors((lock,), allow_ebadf=True)
        except LoginFailure as error:
            cleanup_error = cleanup_error or error
        if cleanup_error is not None:
            if isinstance(cleanup_error, LoginFailure):
                raise cleanup_error
            raise LoginFailure("oauth-login-cleanup-failed") from cleanup_error
    _raise_if_interrupted()
    if time.monotonic() >= overall_deadline:
        raise LoginFailure("oauth-login-timeout", 124)
    return 0


def _commit_success() -> None:
    global _success_committed
    handled = tuple(sorted({signal.SIGHUP, signal.SIGINT, signal.SIGTERM}))
    try:
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, set(handled))
    except (OSError, ValueError) as error:
        raise LoginFailure("oauth-login-cleanup-failed") from error
    mask_restored = False
    previous_handlers: dict[int, object] = {}
    ignored_handlers: list[int] = []
    try:
        pending = _pending_signal
        if pending is None:
            operating_system_pending = signal.sigpending() & set(handled)
            if operating_system_pending:
                pending = min(operating_system_pending)
        if pending is not None:
            raise LoginInterrupted(pending)

        for signum in handled:
            previous_handlers[signum] = signal.getsignal(signum)

        # This assignment is the operation's linearization point. Signals
        # observed before it fail above. Signals after it are post-commit and
        # remain ignored through the final, potentially ambiguous stdout write.
        _success_committed = True
        for signum in handled:
            signal.signal(signum, signal.SIG_IGN)
            ignored_handlers.append(signum)
        try:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        except (OSError, ValueError) as error:
            raise LoginFailure("oauth-login-cleanup-failed") from error
        mask_restored = True
    except BaseException as operation_error:
        cleanup_error: BaseException | None = None
        for signum in reversed(ignored_handlers):
            try:
                signal.signal(signum, previous_handlers[signum])
            except (OSError, ValueError) as error:
                cleanup_error = cleanup_error or error
        if not mask_restored:
            try:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            except (OSError, ValueError) as error:
                cleanup_error = cleanup_error or error
        _success_committed = False
        if cleanup_error is not None:
            raise LoginFailure("oauth-login-cleanup-failed") from cleanup_error
        if isinstance(operation_error, (OSError, ValueError)):
            raise LoginFailure("oauth-login-cleanup-failed") from operation_error
        raise operation_error

    # All cleanup is complete before the success record begins. If the text
    # stream reports an error after accepting any bytes, emitting a second
    # status would create a success/failure protocol collision. Preserve the
    # committed state, return nonzero, and emit nothing further.
    try:
        _emit("oauth-login-complete")
    except (OSError, ValueError) as error:
        raise SuccessOutputFailure from error


def main() -> int:
    global _pending_signal, _success_committed
    _pending_signal = None
    _success_committed = False
    for handled in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(handled, _handle_signal)
    try:
        try:
            status = _main(sys.argv[1:])
        finally:
            # A second top-level pass covers failures before `_main` acquires
            # its lock as well as retained handles from any unexpected path.
            _final_process_sweep()
        if status == 0:
            _commit_success()
        return status
    except SuccessOutputFailure:
        return 126
    except LoginInterrupted as error:
        _emit("oauth-login-interrupted", error=True)
        return 128 + error.signum
    except LoginFailure as error:
        _emit(error.status, error=True)
        return error.code
    except (OSError, ValueError, subprocess.SubprocessError):
        _emit("oauth-login-runtime-error", error=True)
        return 126


if __name__ == "__main__":
    raise SystemExit(main())
