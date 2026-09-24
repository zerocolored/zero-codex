import json
import os
import runpy
import tempfile
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
        owner = self
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def settimeout(self, value): pass
            def connect(self, value): owner.events.append('connect')
            def sendall(self, value):
                owner.events.append('send')
                assert owner.receipt.exists()
                if owner.fail_send: raise TimeoutError()
            def recv(self, size): return b'{"id":"req","result":{}}\n'
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
        self.assertEqual(self.events, ['connect', 'claim', 'send', 'announce'])
        self.assertEqual(self.m['_attempt_send'](self.prepared), 5)
        self.assertEqual(self.events.count('send'), 1)

    def test_partial_send_keeps_claim_and_does_not_resend(self):
        self.fail_send = True
        self.assertEqual(self.m['_attempt_send'](self.prepared), 5)
        self.assertTrue(self.receipt.exists())
        self.fail_send = False
        self.assertEqual(self.m['_attempt_send'](self.prepared), 5)
        self.assertEqual(self.events.count('send'), 1)

    def test_lost_announcement_keeps_recoverable_claim_after_sending(self):
        self.fail_announce = True
        self.assertEqual(self.m['_attempt_send'](self.prepared), 5)
        self.assertTrue(self.receipt.exists())
        self.assertEqual(self.events.count('send'), 1)


if __name__ == '__main__':
    unittest.main()
