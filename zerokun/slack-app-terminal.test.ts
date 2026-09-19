import { expect, test } from 'bun:test'
import { join } from 'path'

test('real PTY echoes selection and edits but keeps subsequent registration tokens hidden', () => {
  const program = String.raw`
import os, pty, select, subprocess, sys, termios, time
for action in ('number', 'new', 'ctrlc', 'ctrld'):
    master, slave = pty.openpty()
    before = termios.tcgetattr(slave)
    proc = subprocess.Popen([sys.argv[1], '--no-env-file', '-e', sys.argv[2]], stdin=slave, stdout=slave, stderr=slave)
    output = b''
    def wait_for(marker):
        global output
        deadline = time.monotonic() + 10
        while marker not in output and time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]: output += os.read(master, 4096)
        assert marker in output, 'expected terminal output missing'
    try:
        wait_for(b' n: ')
        time.sleep(.05)
        assert not termios.tcgetattr(slave)[3] & termios.ECHO
        start = len(output)
        # Empty backspace must not erase the prompt; arrow controls must not echo.
        os.write(master, b'\x7f\x1b[A12\x7f\b' + (b'n' if action == 'new' else b'1'))
        wait_for(b'12\b \b\b \b' + (b'n' if action == 'new' else b'1'))
        assert output[start:] == b'12\b \b\b \b' + (b'n' if action == 'new' else b'1'), 'selection echo mismatch'
        os.write(master, b'\x03' if action == 'ctrlc' else b'\x04' if action == 'ctrld' else b'\r')
        if action == 'new':
            wait_for('Bot Token xoxb-（非表示）: '.encode())
            time.sleep(.05)
            os.write(master, b'xoxb-synthetic-only-12345\r')
            wait_for('App-Level Token xapp-（非表示）: '.encode())
            time.sleep(.05)
            os.write(master, b'xapp-1-ANEW-synthetic-only-12345\r')
        proc.wait(timeout=10)
        while select.select([master], [], [], .05)[0]: output += os.read(master, 4096)
        assert b'xoxb-synthetic-only-12345' not in output and b'xapp-1-ANEW-synthetic-only-12345' not in output, 'token echoed'
        flags = termios.ECHO | termios.ICANON | termios.ISIG
        assert termios.tcgetattr(slave)[3] & flags == before[3] & flags, 'terminal not restored'
        assert proc.returncode == (1 if action in ('ctrlc', 'ctrld') else 0)
        if action in ('number', 'new'): assert ('Slackアプリ登録: ' + ('ANEW' if action == 'new' else 'ATEST')).encode() in output
    finally:
        if proc.poll() is None: proc.kill(); proc.wait()
        os.close(master); os.close(slave)
print('4 command PTY scenarios passed')
`
  const javascript = `
    import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'fs';
    import { tmpdir } from 'os'; import { join } from 'path';
    import { runSlackAppCommand } from ${JSON.stringify(join(import.meta.dir, 'slack-app-command.ts'))};
    import { registerSlackApp } from ${JSON.stringify(join(import.meta.dir, 'slack-app-registry.ts'))};
    import { prepareManagedStateRoot } from ${JSON.stringify(join(import.meta.dir, 'managed-path.ts'))};
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'zero-input-pty-')));
    try {
      const project = join(home, 'outside'); mkdirSync(project);
      registerSlackApp('ATEST', prepareManagedStateRoot(join(home, 'state')), home);
      await runSlackAppCommand(project, { home, prepare: () => {}, installWatchdog: () => {}, verify: async (bot, app) => {
        if (bot !== 'xoxb-synthetic-only-12345' || app !== 'xapp-1-ANEW-synthetic-only-12345') throw new Error('synthetic input mismatch');
        return { appId: 'ANEW' };
      }});
    } catch { process.exitCode = 1; } finally { rmSync(home, { recursive: true, force: true }); }
  `
  const result = Bun.spawnSync(['/usr/bin/python3', '-c', program, process.execPath, javascript], { timeout: 45_000 })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString()).toContain('4 command PTY scenarios passed')
}, 50_000)

test('real PTY hides input and restores echo after enter, Ctrl-C and termination', () => {
  const program = String.raw`
import os, pty, select, signal, subprocess, sys, termios, time
for action in ('enter', 'paste', 'ctrlc', 'term'):
    master, slave = pty.openpty()
    before = termios.tcgetattr(slave)
    proc = subprocess.Popen([sys.argv[1], '--no-env-file', '-e', sys.argv[2]], stdin=slave, stdout=slave, stderr=slave)
    output = b''
    deadline = time.monotonic() + 10
    try:
        while b'INPUT: ' not in output and time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]: output += os.read(master, 4096)
        assert b'INPUT: ' in output, 'prompt unavailable'
        time.sleep(.05)
        assert not termios.tcgetattr(slave)[3] & termios.ECHO, 'echo enabled while reading'
        if action == 'paste': os.write(master, b'\x1b[200~')
        os.write(master, b'synthetic-private-value')
        if action == 'paste': os.write(master, b'\x1b[201~')
        if action in ('enter', 'paste'): os.write(master, b'\r')
        elif action == 'ctrlc': os.write(master, b'\x03')
        else: proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=10)
        while select.select([master], [], [], .05)[0]: output += os.read(master, 4096)
        assert b'synthetic-private-value' not in output, 'input leaked'
        assert termios.tcgetattr(slave)[3] & termios.ECHO == before[3] & termios.ECHO, 'echo not restored'
        assert proc.returncode == (0 if action in ('enter', 'paste') else 1), 'wrong exit'
    finally:
        if proc.poll() is None: proc.kill(); proc.wait()
        os.close(master); os.close(slave)
print('4 PTY scenarios passed')
`
  const javascript = `import { terminalInput } from ${JSON.stringify(join(import.meta.dir, 'slack-app-command.ts'))}; try { const value = await terminalInput('INPUT'); if (value !== 'synthetic-private-value') process.exitCode = 2; } catch { process.exitCode = 1; }`
  const result = Bun.spawnSync(['/usr/bin/python3', '-c', program, process.execPath, javascript], { timeout: 35_000 })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString()).toContain('4 PTY scenarios passed')
}, 40_000)
