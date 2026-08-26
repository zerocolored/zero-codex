#!/usr/bin/env python3
"""Dependency-free lifecycle and credential copier for Zero's Grok reviewer."""

from __future__ import annotations

import errno
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time


AUTH_COPY_TIMEOUT_SECONDS = 5
MAX_AUTH_BYTES = 1024 * 1024
MAX_PROMPT_BYTES = 2 * 1024 * 1024
TERMINATION_GRACE_SECONDS = 2
FINAL_REAP_SECONDS = 1
OFFICIAL_GROK_NAME = re.compile(r"grok-[0-9]+\.[0-9]+\.[0-9]+")
MAX_GROK_BYTES = 1024 * 1024 * 1024


class AuthCopyTimeout(Exception):
    pass


def _same(left: os.stat_result, right: os.stat_result) -> bool:
    fields = (
        "st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink",
        "st_size", "st_mtime_ns", "st_ctime_ns",
    )
    return all(getattr(left, field) == getattr(right, field) for field in fields)


def _safe_regular(
    path: Path, *, executable: bool, maximum: int, private: bool = False
) -> os.stat_result:
    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or metadata.st_nlink != 1
        or metadata.st_mode & 0o022
        or not metadata.st_mode & 0o400
        or metadata.st_size <= 0
        or metadata.st_size > maximum
        or (executable and not metadata.st_mode & 0o100)
        or (private and metadata.st_mode & 0o077)
    ):
        raise OSError(f"unsafe regular file: {path}")
    return metadata


def _read_safe_regular(
    path: Path, *, executable: bool = False, private: bool = False,
    maximum: int = 1024 * 1024,
) -> bytes:
    before = _safe_regular(
        path, executable=executable, maximum=maximum, private=private
    )
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        opened = os.fstat(descriptor)
        if not _same(before, opened):
            raise OSError(f"file changed while opening: {path}")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(65_536, maximum - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > maximum:
                raise OSError(f"file is too large: {path}")
            chunks.append(chunk)
        if not _same(opened, os.fstat(descriptor)):
            raise OSError(f"file changed while reading: {path}")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _write_private_exclusive(path: Path, content: bytes) -> None:
    _safe_owned_directory(path.parent, private=True)
    descriptor: int | None = None
    completed = False
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        os.fchmod(descriptor, 0o600)
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError(f"short write: {path}")
            view = view[written:]
        os.fsync(descriptor)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_uid != os.getuid()
            or metadata.st_mode & 0o077
        ):
            raise OSError(f"unsafe written file: {path}")
        completed = True
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if not completed:
            try:
                path.unlink()
            except OSError:
                pass


def _safe_owned_directory(path: Path, *, private: bool = False) -> os.stat_result:
    metadata = path.lstat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or metadata.st_mode & 0o022
        or (private and metadata.st_mode & 0o077)
    ):
        raise OSError(f"unsafe directory: {path}")
    return metadata


def _expected_grok_cpu_type() -> int:
    architecture = os.uname().machine
    if architecture == "x86_64":
        try:
            translated = subprocess.run(
                ["/usr/sbin/sysctl", "-in", "sysctl.proc_translated"],
                check=False,
                capture_output=True,
                timeout=2,
            )
            if translated.returncode == 0 and translated.stdout.strip() == b"1":
                architecture = "arm64"
        except (OSError, subprocess.SubprocessError):
            pass
    expected = {"arm64": 0x0100000C, "x86_64": 0x01000007}.get(architecture)
    if expected is None:
        raise OSError("unsupported Grok Build architecture")
    return expected


def _macho_cpu_types(header: bytes) -> set[int]:
    if len(header) < 8:
        raise OSError("truncated Grok Build executable")
    magic = header[:4]
    if magic == b"\xcf\xfa\xed\xfe":
        return {struct.unpack_from("<I", header, 4)[0]}
    if magic == b"\xfe\xed\xfa\xcf":
        return {struct.unpack_from(">I", header, 4)[0]}
    fat_layout = {
        b"\xca\xfe\xba\xbe": (">", 20),
        b"\xbe\xba\xfe\xca": ("<", 20),
        b"\xca\xfe\xba\xbf": (">", 32),
        b"\xbf\xba\xfe\xca": ("<", 32),
    }.get(magic)
    if fat_layout is None:
        raise OSError("Grok Build executable is not native Mach-O")
    byte_order, record_size = fat_layout
    count = struct.unpack_from(f"{byte_order}I", header, 4)[0]
    if count <= 0 or count > 32 or len(header) < 8 + count * record_size:
        raise OSError("invalid Grok Build universal executable")
    return {
        struct.unpack_from(f"{byte_order}I", header, 8 + index * record_size)[0]
        for index in range(count)
    }


def _validate_native_grok(path: Path) -> os.stat_result:
    before = _safe_regular(
        path, executable=True, maximum=MAX_GROK_BYTES, private=False
    )
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        opened = os.fstat(descriptor)
        if not _same(before, opened):
            raise OSError("Grok Build executable changed while opening")
        header = os.read(descriptor, 4096)
        if _expected_grok_cpu_type() not in _macho_cpu_types(header):
            raise OSError("Grok Build executable does not contain the host CPU")
        if not _same(opened, os.fstat(descriptor)) or not _same(opened, path.lstat()):
            raise OSError("Grok Build executable changed during validation")
        return opened
    finally:
        os.close(descriptor)


def _resolve_official_grok(real_home: Path, logical: Path) -> Path:
    home = real_home.resolve(strict=True)
    _safe_owned_directory(home)
    expected_bin = home / ".grok" / "bin"
    if logical != expected_bin / "grok":
        raise OSError("unexpected Grok Build path")
    _safe_owned_directory(home / ".grok")
    _safe_owned_directory(expected_bin)

    logical_before = logical.lstat()
    if (
        not stat.S_ISLNK(logical_before.st_mode)
        or logical_before.st_uid != os.getuid()
        or logical_before.st_nlink != 1
        or logical_before.st_size <= 0
        or logical_before.st_size > 255
    ):
        raise OSError("unsafe Grok Build launcher")
    raw_target = os.readlink(logical)
    logical_after = logical.lstat()
    if not _same(logical_before, logical_after):
        raise OSError("Grok Build launcher changed during resolution")
    architecture = "arm64" if _expected_grok_cpu_type() == 0x0100000C else "x86_64"
    current_official_target = {
        "arm64": "../downloads/grok-macos-aarch64",
        "x86_64": "../downloads/grok-macos-x86_64",
    }.get(architecture)
    if OFFICIAL_GROK_NAME.fullmatch(raw_target):
        target = expected_bin / raw_target
    elif current_official_target is not None and raw_target == current_official_target:
        downloads = home / ".grok" / "downloads"
        _safe_owned_directory(downloads)
        target = downloads / Path(raw_target).name
    else:
        raise OSError("unexpected Grok Build launcher target")
    _validate_native_grok(target)
    return target


def _pin_official_grok(
    reviewer_root: Path, run_root: Path, real_home: Path, logical: Path
) -> int:
    destination: Path | None = None
    source_descriptor: int | None = None
    destination_descriptor: int | None = None
    completed = False
    try:
        reviewer_root = reviewer_root.resolve(strict=True)
        run_root = run_root.resolve(strict=True)
        if not _is_direct_run_directory(reviewer_root, run_root):
            return 7
        _safe_owned_directory(reviewer_root, private=True)
        _safe_owned_directory(run_root, private=True)
        source = _resolve_official_grok(real_home, logical)
        source_before = _validate_native_grok(source)
        source_descriptor = os.open(
            source,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        )
        source_opened = os.fstat(source_descriptor)
        if not _same(source_before, source_opened):
            return 7
        destination = run_root / "official-grok"
        destination_descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o700,
        )
        os.fchmod(destination_descriptor, 0o700)
        total = 0
        while True:
            chunk = os.read(source_descriptor, min(1024 * 1024, MAX_GROK_BYTES - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_GROK_BYTES:
                return 7
            view = memoryview(chunk)
            while view:
                written = os.write(destination_descriptor, view)
                if written <= 0:
                    return 7
                view = view[written:]
        os.fsync(destination_descriptor)
        destination_opened = os.fstat(destination_descriptor)
        if (
            total != source_opened.st_size
            or destination_opened.st_size != total
            or destination_opened.st_uid != os.getuid()
            or destination_opened.st_nlink != 1
            or destination_opened.st_mode & 0o077
            or not _same(source_opened, os.fstat(source_descriptor))
            or not _same(source_opened, source.lstat())
        ):
            return 7
        os.close(destination_descriptor)
        destination_descriptor = None
        _validate_native_grok(destination)
        completed = True
        print(os.fspath(destination))
        return 0
    except OSError:
        return 7
    finally:
        if source_descriptor is not None:
            os.close(source_descriptor)
        if destination_descriptor is not None:
            os.close(destination_descriptor)
        if not completed and destination is not None:
            try:
                destination.unlink()
            except OSError:
                pass


def _copy_auth(source: Path, destination: Path) -> int:
    def handle_alarm(_signum: int, _frame: object) -> None:
        raise AuthCopyTimeout("auth copy timed out")

    source_fd = None
    destination_fd = None
    copied = False
    previous_alarm = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, handle_alarm)
    signal.setitimer(signal.ITIMER_REAL, AUTH_COPY_TIMEOUT_SECONDS)
    try:
        source_before = _safe_regular(
            source, executable=False, maximum=MAX_AUTH_BYTES, private=True
        )
        source_flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
        source_fd = os.open(source, source_flags)
        source_opened = os.fstat(source_fd)
        if not _same(source_before, source_opened):
            return 5

        destination_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        destination_fd = os.open(destination, destination_flags, 0o600)
        os.fchmod(destination_fd, 0o600)

        total = 0
        while True:
            chunk = os.read(source_fd, min(65_536, MAX_AUTH_BYTES - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_AUTH_BYTES:
                return 5
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                if written <= 0:
                    return 5
                view = view[written:]
        if not _same(source_opened, os.fstat(source_fd)):
            return 5
        os.fsync(destination_fd)
        copied = total > 0
        return 0 if copied else 5
    except (AuthCopyTimeout, OSError):
        return 5
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_alarm)
        if source_fd is not None:
            os.close(source_fd)
        if destination_fd is not None:
            os.close(destination_fd)
        if not copied:
            try:
                destination.unlink()
            except OSError:
                pass


def _is_direct_run_directory(reviewer_root: Path, candidate: Path) -> bool:
    try:
        return (
            candidate.parent == reviewer_root
            and candidate.name.startswith("run.")
            and candidate.is_dir()
            and not candidate.is_symlink()
        )
    except OSError:
        return False


def _remove_run_directory(reviewer_root: Path, candidate: Path) -> bool:
    if not _is_direct_run_directory(reviewer_root, candidate):
        return False
    try:
        shutil.rmtree(candidate)
        return not candidate.exists() and not candidate.is_symlink()
    except OSError:
        return False


def _pid_is_active(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _process_group_is_active(group_id: int) -> bool:
    try:
        os.killpg(group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError as error:
        if error.errno == errno.ESRCH:
            return False
        raise
    return True


def _read_small_decimal(path: Path) -> int:
    content = _read_safe_regular(path, private=True, maximum=32)
    try:
        text = content.decode("ascii").strip()
    except UnicodeError as error:
        raise OSError(f"invalid decimal file: {path}") from error
    if not text.isdecimal():
        raise OSError(f"invalid decimal file: {path}")
    value = int(text)
    if value <= 1:
        raise OSError(f"invalid process id: {path}")
    return value


def _open_startup_lock(reviewer_root: Path) -> int:
    lock_path = reviewer_root / ".startup.lock"
    descriptor = os.open(
        lock_path,
        os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or metadata.st_nlink != 1
            or metadata.st_mode & 0o077
        ):
            raise OSError("unsafe Grok reviewer startup lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        opened = os.fstat(descriptor)
        if not _same(metadata, opened) or not _same(lock_path.lstat(), opened):
            raise OSError("Grok reviewer startup lock changed while locking")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _cleanup_stale_unlocked(reviewer_root: Path) -> int:
    try:
        entries = [entry for entry in reviewer_root.iterdir() if entry.name.startswith("run.")]
    except OSError:
        return 6
    for entry in entries:
        if not _is_direct_run_directory(reviewer_root, entry):
            return 6
        try:
            _safe_owned_directory(entry, private=True)
            try:
                owner_pid = _read_small_decimal(entry / "owner.pid")
            except FileNotFoundError:
                # Legacy launchers could crash after mktemp and before the
                # owner receipt. No child was started before that receipt. The
                # startup lock proves that no current creator is in that old
                # window, so this direct ownerless run is safely recoverable
                # unless it records a still-live child process group.
                try:
                    group_id = _read_small_decimal(entry / "child.pgid")
                except FileNotFoundError:
                    group_id = 0
                if group_id > 1 and _process_group_is_active(group_id):
                    return 6
                if not _remove_run_directory(reviewer_root, entry):
                    return 6
                continue
            if _pid_is_active(owner_pid):
                continue
            group_path = entry / "child.pgid"
            try:
                group_id = _read_small_decimal(group_path)
            except FileNotFoundError:
                group_id = 0
            if group_id > 1 and _process_group_is_active(group_id):
                return 6
            if not _remove_run_directory(reviewer_root, entry):
                return 6
        except OSError:
            return 6
    return 0


def _cleanup_stale(reviewer_root: Path) -> int:
    descriptor = -1
    try:
        reviewer_root = reviewer_root.resolve(strict=True)
        _safe_owned_directory(reviewer_root, private=True)
        descriptor = _open_startup_lock(reviewer_root)
        return _cleanup_stale_unlocked(reviewer_root)
    except OSError:
        return 6
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _create_run(reviewer_root: Path, owner_pid_text: str) -> int:
    descriptor = -1
    run_root: Path | None = None
    try:
        if not owner_pid_text.isdecimal() or int(owner_pid_text) <= 1:
            return 6
        owner_pid = int(owner_pid_text)
        if not _pid_is_active(owner_pid):
            return 6
        reviewer_root = reviewer_root.resolve(strict=True)
        _safe_owned_directory(reviewer_root, private=True)
        descriptor = _open_startup_lock(reviewer_root)
        if _cleanup_stale_unlocked(reviewer_root) != 0:
            return 6
        run_root = Path(tempfile.mkdtemp(prefix="run.", dir=reviewer_root))
        os.chmod(run_root, 0o700)
        if not _is_direct_run_directory(reviewer_root, run_root):
            raise OSError("invalid Grok reviewer run directory")
        _safe_owned_directory(run_root, private=True)
        _write_private_exclusive(
            run_root / "owner.pid",
            f"{owner_pid}\n".encode("ascii"),
        )
        print(os.fspath(run_root))
        return 0
    except OSError:
        if run_root is not None:
            _remove_run_directory(reviewer_root, run_root)
        return 6
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _stage_prompt(reviewer_root: Path, run_root: Path) -> int:
    try:
        reviewer_root = reviewer_root.resolve(strict=True)
        run_root = run_root.resolve(strict=True)
        if not _is_direct_run_directory(reviewer_root, run_root):
            return 9
        _safe_owned_directory(reviewer_root, private=True)
        _safe_owned_directory(run_root, private=True)
        workspace = run_root / "workspace"
        _safe_owned_directory(workspace, private=True)
        raw = sys.stdin.buffer.read(MAX_PROMPT_BYTES + 1)
        if not raw or len(raw) > MAX_PROMPT_BYTES or b"\x00" in raw:
            return 9
        try:
            body = raw.decode("utf-8")
        except UnicodeDecodeError:
            return 9
        if "\r" in body or any(
            (ord(character) < 32 and character not in "\n\t")
            or ord(character) == 127
            for character in body
        ):
            return 9
        _write_private_exclusive(workspace / "review-prompt", raw)
        return 0
    except OSError:
        return 9


def _fingerprint_paths(
    allow_input: Path | None, deny_input: Path | None
) -> tuple[str, str] | None:
    if allow_input is None and deny_input is None:
        return None
    if allow_input is None or deny_input is None or sys.platform != "darwin":
        raise OSError("incomplete Seatbelt fingerprint")
    allow_path = Path(os.path.abspath(os.fspath(allow_input)))
    deny_path = Path(os.path.abspath(os.fspath(deny_input)))
    if (
        allow_path.name != "allow"
        or deny_path.name != "deny"
        or allow_path.parent != deny_path.parent
    ):
        raise OSError("invalid Seatbelt fingerprint paths")
    _safe_regular(allow_path, executable=False, maximum=256, private=True)
    _safe_regular(deny_path, executable=False, maximum=256, private=True)
    _safe_owned_directory(allow_path.parent, private=True)
    # Grok's strict sandbox accepts directories in read_only, not individual
    # files. The generated profile explicitly denies the sibling deny tag, so
    # allowing this private attempt directory yields allow=0/deny!=0 without
    # nesting Grok's sandbox inside another Seatbelt profile.
    return os.fspath(allow_path.parent), os.fspath(deny_path)


def _prepare_run_home(
    reviewer_root: Path,
    run_root: Path,
    review_root: Path,
    prompt_input: Path | None = None,
    allow_path: Path | None = None,
    deny_path: Path | None = None,
) -> int:
    try:
        reviewer_root = reviewer_root.resolve(strict=True)
        run_root = run_root.resolve(strict=True)
        review_root = review_root.resolve(strict=True)
        if not _is_direct_run_directory(reviewer_root, run_root):
            return 8
        _safe_owned_directory(reviewer_root, private=True)
        _safe_owned_directory(run_root, private=True)
        _safe_owned_directory(review_root)
        review_text = os.fspath(review_root)
        if (
            not review_text.startswith("/")
            or review_text != review_text.strip()
            or any(character in review_text for character in "*?[")
            or any(ord(character) < 32 for character in review_text)
        ):
            return 8

        grok_home = run_root / "user-home" / ".grok"
        _safe_owned_directory(run_root / "user-home", private=True)
        _safe_owned_directory(grok_home, private=True)
        config = _read_safe_regular(reviewer_root / "config.toml", private=True)
        requirements = _read_safe_regular(
            reviewer_root / "requirements.toml", private=True
        )
        template = _read_safe_regular(
            reviewer_root / "sandbox.toml", private=True
        ).decode("utf-8")
        root_placeholder = "__ZEROKUN_REVIEW_ROOT_JSON__"
        fingerprint_placeholder = "__ZEROKUN_FINGERPRINT_ALLOW_JSON__"
        fingerprint_deny_placeholder = "__ZEROKUN_FINGERPRINT_DENY_JSON__"
        prompt_placeholder = "__ZEROKUN_PROMPT_ROOT_JSON__"
        deny_placeholder = "__ZEROKUN_REVIEW_DENIES__"
        if (
            template.count(root_placeholder) != 1
            or template.count(fingerprint_placeholder) != 1
            or template.count(fingerprint_deny_placeholder) != 1
            or template.count(prompt_placeholder) != 1
            or template.count(deny_placeholder) != 1
        ):
            return 8
        fingerprint = _fingerprint_paths(allow_path, deny_path)
        prompt_root = run_root / "workspace"
        _safe_owned_directory(prompt_root, private=True)
        if prompt_input is not None:
            if not prompt_input.is_absolute():
                return 8
            _safe_owned_directory(prompt_input.parent, private=True)
            prompt = _read_safe_regular(
                prompt_input, private=True, maximum=MAX_PROMPT_BYTES
            )
            _write_private_exclusive(prompt_root / "review-prompt", prompt)
        else:
            _safe_regular(
                prompt_root / "review-prompt",
                executable=False,
                private=True,
                maximum=MAX_PROMPT_BYTES,
            )
        protected = [
            f"{review_text}/.env",
            f"{review_text}/.env.*",
            f"{review_text}/**/.env",
            f"{review_text}/**/.env.*",
            f"{review_text}/private/moshi-webhook-token",
            f"{review_text}/**/moshi-webhook-token",
            f"{review_text}/**/*credential*",
            f"{review_text}/**/*Credential*",
            f"{review_text}/**/*CREDENTIAL*",
            f"{review_text}/**/*secret*",
            f"{review_text}/**/*Secret*",
            f"{review_text}/**/*SECRET*",
            f"{review_text}/**/*token*",
            f"{review_text}/**/*Token*",
            f"{review_text}/**/*TOKEN*",
            f"{review_text}/**/*.pem",
            f"{review_text}/**/*.key",
            f"{review_text}/**/id_rsa*",
            "/tmp/**",
            "/private/tmp/**",
            "/var/tmp/**",
        ]
        deny_lines = "\n".join(f"  {json.dumps(path)}," for path in protected)
        sandbox = template.replace(root_placeholder, json.dumps(review_text)).replace(
            fingerprint_placeholder,
            "" if fingerprint is None else f", {json.dumps(fingerprint[0])}",
        ).replace(
            fingerprint_deny_placeholder,
            "" if fingerprint is None else f"  {json.dumps(fingerprint[1])},",
        ).replace(
            prompt_placeholder,
            f", {json.dumps(os.fspath(prompt_root))}",
        ).replace(
            deny_placeholder, deny_lines,
        )
        if "__ZEROKUN_" in sandbox:
            return 8
        _write_private_exclusive(grok_home / "config.toml", config)
        _write_private_exclusive(grok_home / "requirements.toml", requirements)
        _write_private_exclusive(grok_home / "sandbox.toml", sandbox.encode("utf-8"))
        return 0
    except (OSError, UnicodeError, ValueError):
        return 8


def _signal_group(group_id: int, signum: int) -> bool:
    try:
        os.killpg(group_id, signum)
        return True
    except ProcessLookupError:
        return False
    except OSError as error:
        if error.errno != errno.ESRCH:
            raise
        return False


def _wait_until_exit(process: subprocess.Popen[bytes], seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return True
        time.sleep(0.05)
    return process.poll() is not None


def _wait_until_group_gone(group_id: int, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not _process_group_is_active(group_id):
            return True
        time.sleep(0.05)
    return not _process_group_is_active(group_id)


def _terminate_group(process: subprocess.Popen[bytes], signum: int) -> bool:
    group_id = process.pid
    if not _signal_group(group_id, signum):
        _wait_until_exit(process, FINAL_REAP_SECONDS)
        return True
    if _wait_until_group_gone(group_id, TERMINATION_GRACE_SECONDS):
        _wait_until_exit(process, FINAL_REAP_SECONDS)
        return True
    _signal_group(group_id, signal.SIGKILL)
    group_gone = _wait_until_group_gone(group_id, FINAL_REAP_SECONDS)
    _wait_until_exit(process, FINAL_REAP_SECONDS)
    return group_gone


def _run_supervised(reviewer_root: Path, run_root: Path, command: list[str]) -> int:
    reviewer_root = reviewer_root.resolve(strict=True)
    run_root = run_root.resolve(strict=True)
    if not _is_direct_run_directory(reviewer_root, run_root) or not command:
        return 64
    pinned_grok = run_root / "official-grok"
    if Path(command[0]) != pinned_grok:
        return 64
    try:
        _validate_native_grok(pinned_grok)
    except OSError:
        return 126

    blocked_signals = {signal.SIGHUP, signal.SIGINT, signal.SIGTERM}
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, blocked_signals)
    process: subprocess.Popen[bytes] | None = None
    received_signal: int | None = None
    result = 126
    cleanup_confirmed = False
    try:
        def restore_child_signal_mask() -> None:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)

        process = subprocess.Popen(
            command,
            start_new_session=True,
            restore_signals=True,
            preexec_fn=restore_child_signal_mask,
        )
        _write_private_exclusive(
            run_root / "child.pgid", f"{process.pid}\n".encode("ascii")
        )

        def forward(signum: int, _frame: object) -> None:
            nonlocal received_signal
            if received_signal is not None:
                return
            received_signal = signum

        for handled in blocked_signals:
            signal.signal(handled, forward)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        while process.poll() is None and received_signal is None:
            time.sleep(0.05)
        if received_signal is not None:
            cleanup_confirmed = _terminate_group(process, received_signal)
            result = 128 + received_signal
        else:
            returncode = process.returncode if process.returncode is not None else 126
            cleanup_confirmed = not _process_group_is_active(process.pid)
            if not cleanup_confirmed:
                cleanup_confirmed = _terminate_group(process, signal.SIGTERM)
            result = returncode if returncode >= 0 else 128 - returncode
    except OSError:
        result = 126
    finally:
        try:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        except OSError:
            pass
        if process is not None and not cleanup_confirmed:
            try:
                cleanup_confirmed = _terminate_group(process, signal.SIGTERM)
            except OSError:
                cleanup_confirmed = False
        if cleanup_confirmed:
            cleanup_confirmed = _remove_run_directory(reviewer_root, run_root)
    return result if cleanup_confirmed else 125


def _verify_install(reviewer_root: Path, real_home: Path, grok: Path, auth: Path) -> int:
    try:
        if reviewer_root.resolve(strict=True).parent != real_home.resolve(strict=True):
            return 7
        _resolve_official_grok(real_home, grok)
        _safe_regular(auth, executable=False, maximum=MAX_AUTH_BYTES, private=True)
        _safe_owned_directory(reviewer_root, private=True)
        _safe_owned_directory(reviewer_root / "bin", private=True)
        for required in (
            reviewer_root / "bin" / "grok",
            reviewer_root / "bin" / "reviewer-runtime.py",
            reviewer_root / "config.toml",
            reviewer_root / "sandbox.toml",
            reviewer_root / "requirements.toml",
        ):
            _safe_regular(
                required,
                executable=required.parent.name == "bin",
                maximum=1024 * 1024,
                private=required.parent.name != "bin",
            )
        return 0
    except OSError:
        return 7


def _print_resolved_grok(real_home: Path, grok: Path) -> int:
    try:
        print(os.fspath(_resolve_official_grok(real_home, grok)))
        return 0
    except OSError:
        return 7


def main() -> int:
    if len(sys.argv) == 4 and sys.argv[1] == "copy-auth":
        return _copy_auth(Path(sys.argv[2]), Path(sys.argv[3]))
    if len(sys.argv) == 3 and sys.argv[1] == "cleanup-stale":
        return _cleanup_stale(Path(sys.argv[2]))
    if len(sys.argv) == 4 and sys.argv[1] == "create-run":
        return _create_run(Path(sys.argv[2]), sys.argv[3])
    if len(sys.argv) == 4 and sys.argv[1] == "stage-prompt":
        return _stage_prompt(Path(sys.argv[2]), Path(sys.argv[3]))
    if len(sys.argv) in (5, 7) and sys.argv[1] == "prepare-run-home":
        values = [Path(value) for value in sys.argv[2:]]
        return _prepare_run_home(
            values[0], values[1], values[2], None, *values[3:]
        )
    if len(sys.argv) in (6, 8) and sys.argv[1] == "prepare-run-home":
        values = [Path(value) for value in sys.argv[2:]]
        return _prepare_run_home(
            values[0], values[1], values[2], values[3], *values[4:]
        )
    if len(sys.argv) == 6 and sys.argv[1] == "verify-install":
        return _verify_install(*(Path(value) for value in sys.argv[2:]))
    if len(sys.argv) == 6 and sys.argv[1] == "pin-grok":
        return _pin_official_grok(*(Path(value) for value in sys.argv[2:]))
    if len(sys.argv) == 4 and sys.argv[1] == "resolve-grok":
        return _print_resolved_grok(Path(sys.argv[2]), Path(sys.argv[3]))
    if len(sys.argv) >= 6 and sys.argv[1] == "run" and sys.argv[4] == "--":
        return _run_supervised(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[5:])
    print("Invalid reviewer runtime invocation.", file=sys.stderr)
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
