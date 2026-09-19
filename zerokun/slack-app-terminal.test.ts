import { expect, test } from 'bun:test'
import { join } from 'path'

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
