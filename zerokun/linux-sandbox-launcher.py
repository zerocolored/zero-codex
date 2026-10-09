#!/usr/bin/python3 -I
"""Linux counterpart of the macOS `sandbox-exec` attempt wrapper.

usage: linux-sandbox-launcher.py ALLOW_TAG DENY_TAG RECEIPT_DIR -- COMMAND [ARG ...]

macOS proves from the outside that a process still carries the attempt policy
(`sandbox_check` per PID, see seatbelt-fingerprint.ts). Linux has no such query,
so this launcher turns the verification around before it execs the command:

1. It re-executes itself inside a fresh per-attempt systemd scope
   (`zerokun-fp-<nonce>-<pid>.scope`). cgroup membership is inherited by every
   descendant, survives setsid/reparenting, and is visible from the outside via
   cgroup.procs, which is what the reaper reads.
2. It installs a Landlock domain that handles exactly one filesystem action,
   LANDLOCK_ACCESS_FS_MAKE_BLOCK, allowed only beneath the attempt directory.
   Nothing legitimate creates block devices without CAP_MKNOD, so the domain
   has no side effect on the workload, yet no descendant can drop it.
3. It proves the domain is live from the inside: mknod(S_IFBLK) beneath the
   attempt directory fails with EPERM (Landlock allowed it, only the capability
   is missing), while the same call beside it fails with EACCES (denied by the
   obligation). Landlock answers before the capability check, so the two
   errnos are distinguishable. Any other outcome is fail-closed.
4. It writes a receipt and execs the command in place (same PID).

Stdout/stderr/stdin and the environment pass through unchanged: the private
ZEROKUN_LINUX_SANDBOX_* variables used between the two stages and whatever
systemd-run added are removed before the exec. (Python itself may add
LC_CTYPE=C.UTF-8 when the caller passed no locale at all; that is benign.)
"""
import ctypes
import errno
import json
import os
import stat
import sys
import time

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1 << 0
LANDLOCK_RULE_PATH_BENEATH = 1
LANDLOCK_ACCESS_FS_MAKE_BLOCK = 1 << 11
PR_SET_NO_NEW_PRIVS = 38
STAGE_ENV = "ZEROKUN_LINUX_SANDBOX_STAGE"
# Variables stage one did not see but systemd-run / stage one add; stage two
# drops them again so the command inherits the caller's environment unchanged.
DROP_ENV = "ZEROKUN_LINUX_SANDBOX_DROP"
ADDED_BY_SCOPE = ("XDG_RUNTIME_DIR", "INVOCATION_ID")
SCOPE_PREFIX = "zerokun-fp-"
SYSTEMD_RUN = "/usr/bin/systemd-run"
NONCE_LENGTH = 32


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def fail(code, message):
    sys.stderr.write("linux-sandbox-launcher: %s\n" % message)
    sys.stderr.flush()
    os._exit(code)


def parse_args(argv):
    if len(argv) < 6 or argv[4] != "--":
        fail(64, "usage: ALLOW_TAG DENY_TAG RECEIPT_DIR -- COMMAND [ARG ...]")
    allow, deny, receipt_dir, command = argv[1], argv[2], argv[3], argv[5:]
    if not (os.path.isabs(allow) and os.path.isabs(deny) and os.path.isabs(receipt_dir)):
        fail(64, "tag and receipt paths must be absolute")
    attempt_dir = os.path.dirname(deny)
    if os.path.dirname(allow) != attempt_dir or os.path.basename(allow) != "allow" \
            or os.path.basename(deny) != "deny":
        fail(64, "tags must be the allow/deny pair of one attempt directory")
    nonce = os.path.basename(attempt_dir)
    if len(nonce) != NONCE_LENGTH or any(c not in "0123456789abcdef" for c in nonce):
        fail(64, "attempt nonce is invalid")
    return allow, deny, receipt_dir, attempt_dir, nonce, command


def current_cgroup():
    with open("/proc/self/cgroup", "r", encoding="utf-8") as handle:
        for line in handle:
            parts = line.rstrip("\n").split(":", 2)
            if len(parts) == 3 and parts[0] == "0":
                return parts[2]
    return None


def stage_one(unit, environment):
    """Re-exec inside a dedicated transient scope. systemd-run --scope execs in place."""
    environment = dict(environment)
    environment[STAGE_ENV] = "2"
    environment[DROP_ENV] = ",".join(name for name in ADDED_BY_SCOPE if name not in environment)
    if "XDG_RUNTIME_DIR" not in environment:
        environment["XDG_RUNTIME_DIR"] = "/run/user/%d" % os.getuid()
    if not os.path.exists(SYSTEMD_RUN):
        fail(69, "systemd-run is missing; the Linux sandbox needs systemd --user")
    argv = [
        SYSTEMD_RUN, "--user", "--scope", "--quiet", "--collect",
        "--unit", unit, "--",
        sys.executable, "-I", os.path.abspath(__file__), *sys.argv[1:],
    ]
    try:
        os.execve(SYSTEMD_RUN, argv, environment)
    except OSError as error:
        fail(69, "cannot exec systemd-run: %s" % error)


def install_landlock(attempt_dir):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    abi = libc.syscall(SYS_LANDLOCK_CREATE_RULESET, None, 0, LANDLOCK_CREATE_RULESET_VERSION)
    if abi < 1:
        fail(70, "Landlock is unavailable on this kernel (%s)" % os.strerror(ctypes.get_errno()))
    ruleset_attr = RulesetAttr(LANDLOCK_ACCESS_FS_MAKE_BLOCK)
    ruleset_fd = libc.syscall(
        SYS_LANDLOCK_CREATE_RULESET, ctypes.byref(ruleset_attr), ctypes.sizeof(ruleset_attr), 0,
    )
    if ruleset_fd < 0:
        fail(70, "landlock_create_ruleset failed: %s" % os.strerror(ctypes.get_errno()))
    parent_fd = os.open(attempt_dir, os.O_PATH | os.O_CLOEXEC | os.O_DIRECTORY)
    try:
        rule = PathBeneathAttr(LANDLOCK_ACCESS_FS_MAKE_BLOCK, parent_fd)
        if libc.syscall(SYS_LANDLOCK_ADD_RULE, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH,
                        ctypes.byref(rule), 0) != 0:
            fail(70, "landlock_add_rule failed: %s" % os.strerror(ctypes.get_errno()))
    finally:
        os.close(parent_fd)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        fail(70, "PR_SET_NO_NEW_PRIVS failed: %s" % os.strerror(ctypes.get_errno()))
    if libc.syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, 0) != 0:
        fail(70, "landlock_restrict_self failed: %s" % os.strerror(ctypes.get_errno()))
    os.close(ruleset_fd)
    return abi


def probe(directory):
    """Name the kernel's answer to creating a block device beneath `directory`."""
    path = os.path.join(directory, ".landlock-probe-%d" % os.getpid())
    try:
        os.mknod(path, stat.S_IFBLK | 0o600, 0)
    except OSError as error:
        return errno.errorcode.get(error.errno, str(error.errno))
    # Only CAP_MKNOD holders get here; never leave a device node behind.
    os.unlink(path)
    return "created"


def write_receipt(receipt_dir, receipt):
    os.makedirs(receipt_dir, mode=0o700, exist_ok=True)
    path = os.path.join(receipt_dir, "%d.json" % os.getpid())
    descriptor = os.open(
        path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(receipt, handle, separators=(",", ":"), sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())


def main():
    allow, deny, receipt_dir, attempt_dir, nonce, command = parse_args(sys.argv)
    environment = dict(os.environ)
    unit = "%s%s-%d" % (SCOPE_PREFIX, nonce, os.getpid())
    if environment.pop(STAGE_ENV, None) != "2":
        stage_one(unit, environment)
    for name in environment.pop(DROP_ENV, "").split(","):
        if name in ADDED_BY_SCOPE:
            environment.pop(name, None)
    cgroup = current_cgroup()
    if not cgroup or not cgroup.endswith("/%s.scope" % unit):
        fail(70, "not inside the attempt scope %s (cgroup=%s)" % (unit, cgroup))
    for tag in (allow, deny):
        if not os.path.isfile(tag):
            fail(66, "fingerprint tag is missing: %s" % tag)
    abi = install_landlock(attempt_dir)
    allow_probe = probe(attempt_dir)
    deny_probe = probe(os.path.dirname(attempt_dir))
    if allow_probe not in ("EPERM", "created") or deny_probe != "EACCES":
        fail(71, "Landlock obligation is not enforced (allow=%s deny=%s)" % (allow_probe, deny_probe))
    write_receipt(receipt_dir, {
        "version": 1,
        "platform": "linux",
        "unit": unit,
        "cgroup": cgroup,
        "landlockAbi": abi,
        "allowProbe": allow_probe,
        "denyProbe": deny_probe,
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "command": command[0],
        "writtenAt": int(time.time() * 1000),
    })
    try:
        if os.path.isabs(command[0]):
            os.execve(command[0], command, environment)
        else:
            os.execvpe(command[0], command, environment)
    except OSError as error:
        fail(126, "cannot exec %s: %s" % (command[0], error))


if __name__ == "__main__":
    main()
