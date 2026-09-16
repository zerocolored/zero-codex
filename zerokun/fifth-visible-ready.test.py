import runpy
import unittest
from pathlib import Path
from types import SimpleNamespace


class VisibleReadyTests(unittest.TestCase):
    def setUp(self):
        self.m = runpy.run_path(str(Path(__file__).with_name('fifth-advisor.py')), run_name='test')
        self.g = self.m['_settle_visible_ready'].__globals__
        self.clock = iter(range(10000))
        self.g['time'] = SimpleNamespace(monotonic=lambda: next(self.clock), sleep=lambda _: None)
        self.g['_validate_owned_agent'] = lambda *args, **kwargs: None
        self.g['_validate_owned_topology'] = lambda *args: None
        self.g['_agent_information'] = lambda _: ({}, {'state_change_seq': 1})
        self.keys = []
        self.g['_run_herdr'] = lambda args: (self.keys.append(args) or SimpleNamespace(returncode=0))
        self.effort = 'Use Fable 5.1 at high effort by default?\n❯ Keep xhigh\nSwitch Fable 5.1 to high effort'

    def test_keep_once_even_if_confirmed_screen_lingers(self):
        reads = iter([self.effort] * 4 + ['❯'] * 2)
        self.g['_read_visible'] = lambda _: next(reads)
        self.m['_settle_visible_ready']('owned', {})
        self.assertEqual(self.keys, [['agent', 'send-keys', 'owned', 'Enter']])

    def test_prohibited_ui_never_ready_or_clicked(self):
        for label in ['Password:', 'Passkey', 'CAPTCHA', 'Payment', 'Permission required', 'Sign in', 'MFA', 'Sign\x1b[0m in', 'Pass\x1b[1mword:']:
            for screen in [label + '\n❯', label + '\n' + self.effort]:
                self.g['_read_visible'] = lambda _, text=screen: text
                with self.assertRaises(self.m['UnsafeRequest']):
                    self.m['_settle_visible_ready']('owned', {})
                self.assertEqual(self.keys, [])

    def test_transient_startup_frame_waits_for_ready(self):
        reads = iter(['Starting…'] * 2 + ['❯'] * 2)
        self.g['_read_visible'] = lambda _: next(reads)
        self.m['_settle_visible_ready']('owned', {})
        self.assertEqual(self.keys, [])

    def test_changed_selection_is_not_confirmed(self):
        screen = self.effort.replace('❯ Keep xhigh', 'Keep xhigh').replace('\nSwitch', '\n❯ Switch')
        self.g['_read_visible'] = lambda _: screen
        with self.assertRaises(self.m['UnsafeRequest']):
            self.m['_settle_visible_ready']('owned', {})
        self.assertEqual(self.keys, [])


if __name__ == '__main__':
    unittest.main()
