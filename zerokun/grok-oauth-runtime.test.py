"""Only synthetic credentials and child CLIs; never contacts OAuth or Chrome."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

source = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else Path(__file__).parent / "grok-reviewer/oauth-login-runtime.py"
spec = importlib.util.spec_from_file_location("oauth_runtime", source)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def oauth_url(state="01234567-89ab-cdef-0123-456789abcdef", **changes):
    values = dict(client_id=runtime.OAUTH_CLIENT_ID, code_challenge="c" * 43,
                  code_challenge_method="S256", nonce="n" * 36,
                  redirect_uri="http://127.0.0.1:12345/callback",
                  referrer=runtime.OAUTH_REFERRER, response_type="code",
                  scope=runtime.OAUTH_SCOPE, state=state)
    values.update(changes)
    return "https://auth.x.ai/oauth2/authorize?" + urlencode(values)


class OAuthTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="zero-oauth-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.live = self.root / "live"
        self.staged = self.root / "staged"
        for home in (self.live, self.staged):
            home.mkdir(mode=0o700)
            (home / ".grok").mkdir(mode=0o700)
        self.write_auth(self.live, b"old-fixture")
        self.write_auth(self.staged, b"new-fixture")
        runtime._pending_signal = None
        self.addCleanup(setattr, runtime, "_pending_signal", None)

    def write_auth(self, home, value):
        path = home / ".grok/auth.json"
        path.write_bytes(value)
        path.chmod(0o600)
        return path

    def assert_live(self, value=b"old-fixture"):
        self.assertEqual((self.live / ".grok/auth.json").read_bytes(), value)
        self.assertEqual(list((self.live / ".grok").glob(".oauth-auth-*")), [])

    def test_state_legacy_and_uuid(self):
        for state in ("s" * 32, "01234567-89ab-cdef-0123-456789abcdef"):
            with self.subTest(state_length=len(state)):
                url = oauth_url(state)
                self.assertEqual(runtime._validate_oauth_url(url), url)

    def test_url_rejects_unknown_duplicate_origin_and_invalid_state(self):
        urls = [oauth_url("s" * 36), oauth_url("s" * 31), oauth_url(extra="x"),
                oauth_url() + "&state=" + "s" * 32,
                oauth_url().replace("auth.x.ai", "example.invalid"),
                oauth_url(redirect_uri="https://example.invalid/callback")]
        for url in urls:
            with self.subTest(case=urls.index(url)), self.assertRaises(runtime.LoginFailure):
                runtime._validate_oauth_url(url)

    def test_ansi_presentation_and_every_chunk_boundary(self):
        raw = b"\x1b[32m" + oauth_url().encode() + b"\x1b[0m\r\x1b[2K\n"
        for end in range(len(raw) + 1):
            runtime._plain_pty_output(raw[:end])
        plain = runtime._plain_pty_output(raw, final=True)
        self.assertEqual(plain, oauth_url().encode() + b"\r\n")
        self.assertEqual(len(runtime._completed_url_tokens(plain)), 1)

    def test_ansi_does_not_allow_osc_cursor_controls_or_incomplete_final(self):
        for raw in (b"\x1b]52;c;fixture\x07", b"\x1b[2J", b"\x1b[H", b"\x00", b"\x1b[3"):
            with self.subTest(raw=repr(raw)), self.assertRaises(runtime.LoginFailure):
                runtime._plain_pty_output(raw, final=True)
        plain = runtime._plain_pty_output((oauth_url() + "\n" + oauth_url() + "\n").encode())
        self.assertEqual(runtime._url_token_count(plain), 2)

    def test_publish_success_is_private_atomic_and_opaque(self):
        before = runtime._auth_metadata(self.live)
        old_inode = (self.live / ".grok/auth.json").stat().st_ino
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            runtime._publish_auth(self.staged, self.live, before)
        self.assertEqual(output.getvalue(), "")
        self.assert_live(b"new-fixture")
        self.assertNotEqual((self.live / ".grok/auth.json").stat().st_ino, old_inode)
        self.assertEqual((self.live / ".grok/auth.json").stat().st_mode & 0o777, 0o600)

    def test_first_login(self):
        (self.live / ".grok/auth.json").unlink()
        runtime._publish_auth(self.staged, self.live, runtime._auth_metadata(self.live, allow_missing=True))
        self.assert_live(b"new-fixture")

    def test_concurrent_login_is_not_overwritten(self):
        for initially_present in (True, False):
            with self.subTest(initially_present=initially_present):
                path = self.live / ".grok/auth.json"
                if not initially_present:
                    path.unlink()
                before = runtime._auth_metadata(self.live, allow_missing=True)
                self.write_auth(self.live, b"concurrent-fixture")
                with self.assertRaises(runtime.LoginFailure):
                    runtime._publish_auth(self.staged, self.live, before)
                self.assert_live(b"concurrent-fixture")

    def test_prepublication_signal_and_fsync_failure_preserve_auth(self):
        before = runtime._auth_metadata(self.live)
        with patch.object(runtime, "_pending_signal", signal.SIGTERM):
            with self.assertRaises(runtime.LoginInterrupted):
                runtime._publish_auth(self.staged, self.live, before)
        self.assert_live()
        with patch.object(runtime.os, "fsync", side_effect=OSError("synthetic fsync")):
            with self.assertRaises(OSError):
                runtime._publish_auth(self.staged, self.live, before)
        self.assert_live()

    def test_postpublication_failure_does_not_restore_old_auth(self):
        before = runtime._auth_metadata(self.live)
        fsync = os.fsync
        calls = 0

        def fail_directory(fd):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("synthetic directory fsync")
            return fsync(fd)

        with patch.object(runtime.os, "fsync", side_effect=fail_directory):
            with self.assertRaises(OSError):
                runtime._publish_auth(self.staged, self.live, before)
        self.assert_live(b"new-fixture")

    def test_concurrent_change_during_copy_is_rechecked_before_replace(self):
        before = runtime._auth_metadata(self.live)
        fsync = os.fsync

        def concurrent_login(fd):
            fsync(fd)
            self.write_auth(self.live, b"newer-login-fixture")

        with patch.object(runtime.os, "fsync", side_effect=concurrent_login):
            with self.assertRaises(runtime.LoginFailure):
                runtime._publish_auth(self.staged, self.live, before)
        self.assert_live(b"newer-login-fixture")

    def test_interruption_after_copy_but_before_replace_preserves_auth(self):
        before = runtime._auth_metadata(self.live)
        fsync = os.fsync

        def interrupt(fd):
            fsync(fd)
            runtime._pending_signal = signal.SIGINT

        with patch.object(runtime.os, "fsync", side_effect=interrupt):
            with self.assertRaises(runtime.LoginInterrupted):
                runtime._publish_auth(self.staged, self.live, before)
        self.assert_live()

    def test_unsafe_staged_auth_is_rejected(self):
        before = runtime._auth_metadata(self.live)
        path = self.staged / ".grok/auth.json"
        for kind in ("symlink", "hardlink", "empty", "oversize", "public"):
            with self.subTest(kind=kind):
                path.unlink(missing_ok=True)
                if kind == "symlink":
                    path.symlink_to(self.live / ".grok/auth.json")
                elif kind == "hardlink":
                    os.link(self.live / ".grok/auth.json", path)
                else:
                    self.write_auth(self.staged, b"" if kind == "empty" else b"x" * (runtime.MAX_AUTH_BYTES + 1) if kind == "oversize" else b"fixture")
                    if kind == "public":
                        path.chmod(0o644)
                with self.assertRaises(runtime.LoginFailure):
                    runtime._publish_auth(self.staged, self.live, before)
                self.assert_live()

    def run_login_fixture(self, outcome):
        reviewer = self.root / "reviewer"
        reviewer.mkdir(mode=0o700)
        executable = self.root / "fake-grok"
        # Simulates CLI replacing its own HOME auth even on login failure.
        executable.write_text(f'''#!{sys.executable}
import os,sys,time
from pathlib import Path
if "--help" in sys.argv:
    print("  --oauth  Login")
    sys.exit(0)
home=Path(os.environ["HOME"])
(home/".grok").mkdir(mode=0o700, exist_ok=True)
auth=home/".grok/auth.json"
auth.unlink(missing_ok=True)
auth.write_bytes(b"new-cli-fixture")
auth.chmod(0o600)
print("\\x1b[32m" + {oauth_url()!r} + "\\x1b[0m\\r\\x1b[2K", flush=True)
if {outcome!r} == "timeout": time.sleep(30)
sys.exit(1 if {outcome!r} == "failure" else 0)
''')
        executable.chmod(0o700)
        observed = []
        output = io.StringIO()

        def opened(_url, _deadline):
            observed.append("opened")
            if outcome == "concurrent":
                self.write_auth(self.live, b"other-login-fixture")
            if outcome == "interrupt":
                raise runtime.LoginInterrupted(signal.SIGTERM)

        with contextlib.ExitStack() as stack:
            # Exercise the macOS helper contract on every test host; browser and
            # binary discovery are synthetic, while PTY/process cleanup is real.
            stack.enter_context(patch.object(runtime.sys, "platform", "darwin"))
            stack.enter_context(patch.object(runtime.Path, "home", return_value=self.live))
            stack.enter_context(patch.object(runtime, "_load_identity", return_value={}))
            stack.enter_context(patch.object(runtime, "_validate_executable"))
            stack.enter_context(patch.object(runtime, "_materialize_verified_executable", return_value=(executable, (), "fixture")))
            stack.enter_context(patch.object(runtime, "_validate_materialized_executable"))
            stack.enter_context(patch.object(runtime, "_open_chrome", side_effect=opened))
            stack.enter_context(patch.object(runtime, "LOGIN_TIMEOUT_SECONDS", 1 if outcome == "timeout" else 10))
            stack.enter_context(contextlib.redirect_stdout(output))
            stack.enter_context(contextlib.redirect_stderr(output))
            arguments = [str(reviewer), str(self.live), str(executable), "/usr/bin:/bin", "C"]
            if outcome == "success":
                self.assertEqual(runtime._main(arguments), 0)
            else:
                with self.assertRaises((runtime.LoginFailure, runtime.LoginInterrupted)):
                    runtime._main(arguments)
        self.assertEqual(observed, ["opened"])
        self.assertEqual(list(reviewer.glob("oauth.*")), [])
        self.assertFalse(runtime._active_processes)
        self.assertIsNone(runtime._active_process)
        self.assertNotIn("fixture", output.getvalue())
        self.assertNotIn("https://", output.getvalue())
        self.assert_live(b"new-cli-fixture" if outcome == "success" else b"other-login-fixture" if outcome == "concurrent" else b"old-fixture")

    def test_linux_helper_remains_unsupported_without_touching_auth(self):
        with patch.object(runtime.sys, "platform", "linux"):
            with self.assertRaises(runtime.LoginFailure) as failure:
                runtime._main(["unused"] * 5)
        self.assertEqual(failure.exception.status, "oauth-login-unsupported")
        self.assert_live()

    def test_real_pty_success_and_cleanup(self):
        self.run_login_fixture("success")

    def test_real_pty_nonzero_preserves_real_auth(self):
        self.run_login_fixture("failure")

    def test_real_pty_timeout_preserves_real_auth(self):
        self.run_login_fixture("timeout")

    def test_real_pty_interruption_preserves_real_auth(self):
        self.run_login_fixture("interrupt")

    def test_real_pty_concurrent_login_preserves_newer_auth(self):
        self.run_login_fixture("concurrent")


if __name__ == "__main__":
    unittest.main(verbosity=2)
