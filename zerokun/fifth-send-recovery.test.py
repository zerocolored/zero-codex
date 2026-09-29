import json
import os
import runpy
import tempfile
import socket
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace


class SendRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.m = runpy.run_path(str(Path(__file__).with_name('fifth-advisor.py')), run_name='test')
        self.g = self.m['_attempt_send'].__globals__
        self.events = []
        self.records = []
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.receipt = Path(self.tmp.name) / 'claim'
        self.fail_send = False
        self.fail_announce = False
        self.reply = {"id": "req", "result": {}}
        owner = self
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def settimeout(self, value): pass
            def connect(self, value):
                assert owner.receipt.exists(), 'slow filesystem claim must finish before connect'
                owner.events.append('connect')
            def sendall(self, value):
                owner.events.append('send')
                assert owner.receipt.exists()
                if owner.fail_send: raise TimeoutError()
            def recv(self, size): return (json.dumps(owner.reply) + '\n').encode()
        self.g['socket'] = SimpleNamespace(socket=lambda *args: Connection(), AF_UNIX=1, SOCK_STREAM=1)
        def claim(prepared):
            fd = os.open(self.receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.write(fd, b'claimed')
            os.fsync(fd)
            os.close(fd)
            self.events.append('claim')
        def announce(prepared):
            self.events.append('announce')
            if self.fail_announce: raise BrokenPipeError()
        self.g['_persist_send_receipt'] = claim
        self.g['_announce_send'] = announce
        self.g['_write_json_record'] = self.records.append
        self.prepared = SimpleNamespace(socket_path='owned', request=b'prompt', request_id='req')

    def test_claim_precedes_send_and_repeated_call_cannot_resend(self):
        self.assertEqual(self.m['_attempt_send'](self.prepared), 0)
        self.assertEqual(self.events, ['claim', 'connect', 'send', 'announce'])
        self.assertEqual(self.m['_attempt_send'](self.prepared), 5)
        self.assertEqual(self.events.count('send'), 1)

    def test_partial_send_keeps_claim_and_does_not_resend(self):
        self.fail_send = True
        self.assertEqual(self.m['_attempt_send'](self.prepared), 5)
        self.assertTrue(self.receipt.exists())
        self.fail_send = False
        self.assertEqual(self.m['_attempt_send'](self.prepared), 5)
        self.assertEqual(self.events.count('send'), 1)

    def test_rejection_preserves_fixed_code_without_server_message(self):
        self.reply = {"id": "req", "error": {"code": "agent_not_ready", "message": "SECRET-SENTINEL"}}
        self.assertEqual(self.m['_attempt_send'](self.prepared), 5)
        self.assertEqual(self.records[-1], {"status": "prompt-command-returned", "returncode": 1, "code": "agent_not_ready"})
        self.assertNotIn('SECRET-SENTINEL', json.dumps(self.records))
        self.assertTrue(self.receipt.exists())

    def test_unknown_error_is_fixed_and_claim_still_prevents_resend(self):
        self.reply = {"id": "req", "error": {"code": "SECRET-SENTINEL", "message": "SECRET-SENTINEL"}}
        self.assertEqual(self.m['_attempt_send'](self.prepared), 5)
        self.assertEqual(self.records[-1]['code'], 'unknown-error')
        self.assertNotIn('SECRET-SENTINEL', json.dumps(self.records))
        self.assertEqual(self.m['_attempt_send'](self.prepared), 5)
        self.assertEqual(self.events.count('send'), 1)

    def test_lost_announcement_keeps_recoverable_claim_after_sending(self):
        self.fail_announce = True
        self.assertEqual(self.m['_attempt_send'](self.prepared), 5)
        self.assertTrue(self.receipt.exists())
        self.assertEqual(self.events.count('send'), 1)

    def test_slow_claim_does_not_consume_server_idle_connection_deadline(self):
        # A real socket server closes clients that connect but do not send.
        # Repository audit/fsync is deliberately slower than that deadline.
        self.g['socket'] = socket
        path = str(Path(self.tmp.name) / 'herdr.sock')
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(path)
        server.listen(1)
        server.settimeout(2)
        self.addCleanup(server.close)
        received = []
        def serve():
            try:
                connection, _ = server.accept()
                with connection:
                    connection.settimeout(0.1)
                    received.append(connection.recv(1024))
                    connection.sendall(b'{"id":"req","result":{}}\n')
            except (TimeoutError, OSError):
                pass
        thread = threading.Thread(target=serve)
        thread.start()
        claim = self.g['_persist_send_receipt']
        def slow_claim(prepared):
            time.sleep(0.3)
            claim(prepared)
        self.g['_persist_send_receipt'] = slow_claim
        self.prepared.socket_path = path
        try:
            self.assertEqual(self.m['_attempt_send'](self.prepared), 0)
            self.assertEqual(received, [b'prompt'])
        finally:
            thread.join(3)
        self.assertFalse(thread.is_alive())


class AnswerFileContractTests(unittest.TestCase):
    def setUp(self):
        self.m = runpy.run_path(str(Path(__file__).with_name('fifth-advisor.py')), run_name='test')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, self.fd)
        self.output = self.root / 'answer.md'
        self.marker = 'REQUEST_MARKER=' + 'A' * 32

    def test_only_precreated_empty_private_output_can_be_authorized(self):
        with self.assertRaises(FileNotFoundError):
            self.m['_answer_file_instruction'](self.fd, self.root, self.marker)
        self.output.touch(mode=0o600)
        prompt = self.m['_answer_file_instruction'](self.fd, self.root, self.marker)
        self.assertIn(str(self.output), prompt)
        self.assertIn('CLAUDE_ANSWER_BEGIN=' + 'A' * 32, prompt)
        self.assertIn('SHA256=<actual file SHA-256>', prompt)
        self.assertEqual(self.output.read_bytes(), b'')
        self.output.write_text('old answer')
        with self.assertRaises(self.m['UnsafeRequest']):
            self.m['_answer_file_instruction'](self.fd, self.root, self.marker)

    def test_unsafe_output_is_not_followed_or_authorized(self):
        other = self.root / 'other'
        other.write_text('unchanged')
        self.output.symlink_to(other)
        with self.assertRaises(OSError):
            self.m['_answer_file_instruction'](self.fd, self.root, self.marker)
        self.assertEqual(other.read_text(), 'unchanged')
        self.output.unlink()
        self.output.touch(mode=0o644)
        with self.assertRaises(self.m['UnsafeRequest']):
            self.m['_answer_file_instruction'](self.fd, self.root, self.marker)

    def test_long_instructions_are_preserved_with_one_short_execution_request(self):
        full = 'Review the synthetic task.\n' * 2000 + self.marker + '\n'
        prompt = self.m['_file_prompt_transport'](self.fd, self.root, full, self.marker)
        saved = self.root / 'instruction.md'
        self.assertEqual(saved.read_text(), full)
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        self.assertLess(len(prompt), 1000)
        self.assertEqual(len(prompt.splitlines()), 2)
        self.assertIn('Read and carry out my task instructions', prompt)
        self.assertEqual(prompt.splitlines()[-1], self.marker)
        with self.assertRaises(self.m['UnsafeRequest']):
            self.m['_file_prompt_transport'](self.fd, self.root, 'replacement', self.marker)
        self.assertEqual(saved.read_text(), full)


if __name__ == '__main__':
    unittest.main()
