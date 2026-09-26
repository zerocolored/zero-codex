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
        self.g['_agent_information'] = lambda _: ({}, {'state_change_seq': 1, 'agent_status': 'idle', 'interactive_ready': True})
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

    def test_send_preflight_rechecks_ui_after_startup(self):
        # Synthetic owned receipt; keep the real screen classifier and complete
        # _owned_target path so readiness alone cannot bypass an auth dialog.
        self.g['_validate_workspace_receipt'] = lambda *args: None
        self.g['_current_pane'] = lambda: {}
        self.g['_same_caller'] = lambda *args: True
        self.g['_valid_recorded_process_ids'] = lambda *args: True
        self.g['_valid_claude_invocation'] = lambda *args: True
        self.g['_process_receipt'] = lambda *args: {}
        self.g['_same_owned_process_identity'] = lambda *args: True
        workspace = dict(agent_name='owned', workspace_id='w1', pane_id='w1:p1', terminal_id='t1', nonce='n', project_root='/tmp/project')
        receipt = {k: workspace[k] for k in ['agent_name', 'workspace_id', 'pane_id', 'terminal_id', 'nonce']}
        receipt.update(version=self.m['EPHEMERAL_SESSION_VERSION'], native_session='N/A:safe-mode', state_change_seq=1,
                       shell_pid=1, claude_pid=2, process_group_id=2, process_ids=[2], argv=[], argv0='claude', executable={})
        for screen in ['Password:\n❯', 'Sign in\n❯', self.effort,
                       'Accessing workspace:\n/tmp/project\n❯ Yes, I trust this folder\nNo, exit\nEnter to confirm · Esc to cancel']:
            self.g['_read_visible'] = lambda _, text=screen: text
            with self.assertRaises(self.m['UnsafeRequest']):
                self.m['_owned_target']({'caller': {}}, workspace, receipt)
        for screen in ['❯', '❯ Try "approve payment changes"']:
            self.g['_read_visible'] = lambda _, text=screen: text
            self.assertEqual(self.m['_owned_target']({'caller': {}}, workspace, receipt), 'owned')
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

    def test_empty_visible_prompt_waits_for_metadata(self):
        frames = iter([{'state_change_seq': 1, 'agent_status': 'unknown'}] * 2
                      + [{'state_change_seq': 2, 'agent_status': 'idle', 'interactive_ready': True}] * 2)
        self.g['_agent_information'] = lambda _: ({}, next(frames))
        self.g['_read_visible'] = lambda _: '❯'
        result = self.m['_settle_visible_ready']('owned', {})
        self.assertEqual(result['state_change_seq'], 2)
        self.assertEqual(self.keys, [])

    def test_trust_then_effort_then_ready(self):
        trust = ('Accessing workspace:\n/tmp/project\nUpdated explanation\n'
                 '❯ 1. Yes, I trust this folder\n2. No, exit\nEnter to confirm · Esc to cancel')
        blocked = {'state_change_seq': 1, 'agent_status': 'blocked', 'launch_pending': True}
        effort = dict(blocked, state_change_seq=2)
        ready = {'state_change_seq': 3, 'agent_status': 'idle', 'interactive_ready': True}
        frames = iter([blocked, blocked, effort, effort, ready, ready])
        screens = iter([trust, trust, self.effort, self.effort, '❯', '❯'])
        self.g['_agent_information'] = lambda _: ({}, next(frames))
        self.g['_read_visible'] = lambda _: next(screens)
        result = self.m['_settle_after_trust']('owned', {'project_root': '/tmp/project'})
        self.assertEqual(result, ready)
        self.assertEqual(self.keys, [['agent', 'send-keys', 'owned', 'Enter']] * 2)

    def test_trust_copy_is_not_a_gate_but_target_and_choices_are(self):
        screen = ('Accessing workspace:\n/tmp/project\nNew release explanation\n'
                  '❯ 1. Yes, I trust this folder\n2. No, exit\nEnter to confirm · Esc to cancel')
        check = self.m['_strict_trust_screen']
        self.assertTrue(check(screen, '/tmp/project'))
        for bad in [screen.replace('/tmp/project', '/tmp/foreign'),
                    screen.replace('❯ 1.', '1.').replace('2. No', '❯ 2. No'),
                    screen.replace('New release explanation', 'Password required'),
                    screen.replace('2. No, exit', '2. No, exit\n3. Approve')]:
            self.assertFalse(check(bad, '/tmp/project'))

    def test_trust_metadata_ready_before_effort_screen_does_not_end_startup(self):
        trust = ('Accessing workspace:\n/tmp/project\nNew explanation\n'
                 '❯ 1. Yes, I trust this folder\n2. No, exit\nEnter to confirm · Esc to cancel')
        blocked = {'state_change_seq': 1, 'agent_status': 'blocked', 'launch_pending': True}
        ready = {'state_change_seq': 2, 'agent_status': 'idle', 'interactive_ready': True}
        frames = iter([blocked] * 2 + [ready] * 6)
        screens = iter([trust] * 2 + [self.effort] * 4 + ['❯'] * 2)
        self.g['_agent_information'] = lambda _: ({}, next(frames))
        self.g['_read_visible'] = lambda _: next(screens)
        self.m['_settle_visible_ready']('owned', {'project_root': '/tmp/project'})
        self.assertEqual(len(self.keys), 2)

    def test_benign_prompt_placeholder_does_not_trigger_a_prohibited_ui(self):
        self.g['_read_visible'] = lambda _: '❯ Try "approve payment changes"'
        self.m['_settle_visible_ready']('owned', {})
        self.assertEqual(self.keys, [])

    def test_trust_lingering_after_confirmation_is_never_confirmed_twice(self):
        trust = ('Accessing workspace:\n/tmp/project\nNew explanation\n'
                 '❯ 1. Yes, I trust this folder\n2. No, exit\nEnter to confirm · Esc to cancel')
        self.g['_agent_information'] = lambda _: ({}, {'state_change_seq': 1, 'agent_status': 'blocked', 'launch_pending': True})
        self.g['_read_visible'] = lambda _: trust
        with self.assertRaises(self.m['UnsafeRequest']):
            self.m['_settle_visible_ready']('owned', {'project_root': '/tmp/project'})
        self.assertEqual(len(self.keys), 1)

    def test_current_unnumbered_trust_moves_once_then_rechecks_before_enter(self):
        exit_selected = ('Accessing workspace:\n\n/tmp/pro\nject\n\nQuick safety check\n'
                         '❯ No, exit\n  Yes, I trust this folder\n\nEnter to confirm · Esc to cancel')
        trust_selected = exit_selected.replace('❯ No, exit', '  No, exit').replace('  Yes,', '❯ Yes,')
        blocked = {'state_change_seq': 1, 'agent_status': 'blocked', 'launch_pending': True}
        ready = {'state_change_seq': 3, 'agent_status': 'idle', 'interactive_ready': True}
        frames = iter([blocked] * 4 + [dict(blocked, state_change_seq=2)] * 4 + [ready] * 2)
        screens = iter([exit_selected] * 4 + [trust_selected] * 4 + ['❯'] * 2)
        self.g['_agent_information'] = lambda _: ({}, next(frames))
        self.g['_read_visible'] = lambda _: next(screens)
        self.m['_settle_visible_ready']('owned', {'project_root': '/tmp/project'})
        self.assertEqual(self.keys, [['agent', 'send-keys', 'owned', 'Down'],
                                     ['agent', 'send-keys', 'owned', 'Enter']])

    def test_trust_selection_key_is_not_repeated_if_screen_does_not_change(self):
        screen = ('Accessing workspace:\n/tmp/project\nExplanation\n'
                  'Yes, I trust this folder\n❯ No, exit\nEnter to confirm · Esc to cancel')
        self.g['_agent_information'] = lambda _: ({}, {'state_change_seq': 1, 'agent_status': 'blocked', 'launch_pending': True})
        self.g['_read_visible'] = lambda _: screen
        with self.assertRaisesRegex(self.m['UnsafeRequest'], 'trust-exit'):
            self.m['_settle_visible_ready']('owned', {'project_root': '/tmp/project'})
        self.assertEqual(self.keys, [['agent', 'send-keys', 'owned', 'Up']])

    def test_new_trust_rejects_foreign_path_or_additional_choice(self):
        screen = ('Accessing workspace:\n/tmp/project\nExplanation\n'
                  '❯ No, exit\nYes, I trust this folder\nEnter to confirm · Esc to cancel')
        for bad in [screen.replace('/tmp/project', '/tmp/foreign'),
                    screen.replace('Explanation', 'Enter password'),
                    screen.replace('Yes, I trust this folder', 'Yes, I trust this folder\nContinue')]:
            self.assertIsNone(self.m['_trust_screen_choice'](bad, '/tmp/project'))

    def test_harmless_changing_banner_does_not_prevent_ready(self):
        screens = iter(['Update check 1\n❯', 'Update check 2\n❯'])
        self.g['_read_visible'] = lambda _: next(screens)
        self.m['_settle_visible_ready']('owned', {})
        self.assertEqual(self.keys, [])

    def test_startup_diagnostic_is_fixed_code_without_error_payload(self):
        classify = self.m['_startup_failure_code']
        self.assertEqual(classify(Exception('ephemeral Claude visible ready prompt did not settle (trust-exit)')), 'trust-confirmation-timeout')
        self.assertEqual(classify(Exception('ephemeral Claude has a prohibited startup UI')), 'prohibited-ui')
        self.assertEqual(classify(Exception('private arbitrary error payload')), 'startup-failed')


if __name__ == '__main__':
    unittest.main()
