import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

for (const mode of ['single', 'fork-abort', 'fork-parent-exit', 'supervised-abort', 'supervised-owner-death']) test.skipIf(process.platform !== 'darwin')(`isolated audit model reaps the owned process group (${mode})`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'audit-model-stop-')))
  const childPidPath = join(root, 'child.pid')
  try {
    const target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    const standalone = join(root, '.codex/packages/standalone')
    const release = join(standalone, `releases/0.160.0-${target}`)
    const binary = join(release, 'bin/codex')
    mkdirSync(join(release, 'bin'), { recursive: true, mode: 0o700 })
    mkdirSync(join(root, '.local/bin'), { recursive: true, mode: 0o700 })
    const nativeSource = `
      #include <unistd.h>
      #include <signal.h>
      #include <stdio.h>
      #include <string.h>
      int main(int argc, char **argv) {
        ${mode === 'single' ? '' : `
          int ready[2]; if (pipe(ready)) return 2;
          pid_t child = fork(); if (child < 0) return 3;
          if (!child) { signal(SIGTERM, SIG_IGN); close(ready[0]); write(ready[1], "1", 1); close(ready[1]); for (;;) pause(); }
          close(ready[1]); char value; read(ready[0], &value, 1); close(ready[0]);
          FILE *pidfile = fopen(${JSON.stringify(childPidPath)}, "w"); fprintf(pidfile, "%d", child); fclose(pidfile);
        `}
        ${mode === 'fork-parent-exit' ? `
          char input[4096]; while (read(0, input, sizeof(input)) > 0) {}
          for (int i = 1; i + 1 < argc; i++) if (!strcmp(argv[i], "--output-last-message")) { FILE *out = fopen(argv[i + 1], "w"); fputs("{}", out); fclose(out); }
          return 0;
        ` : 'for (;;) pause();'}
      }
    `
    const compiled = Bun.spawnSync(['/usr/bin/clang', '-x', 'c', '-', '-o', binary], {
      stdin: Buffer.from(nativeSource), stdout: 'pipe', stderr: 'pipe',
    })
    expect(compiled.exitCode).toBe(0)
    chmodSync(binary, 0o700)
    writeFileSync(join(release, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version: '0.160.0', target, variant: 'codex', entrypoint: 'bin/codex', resourcesDir: 'codex-resources', pathDir: 'codex-path' }), { mode: 0o600 })
    symlinkSync(release, join(standalone, 'current'))
    symlinkSync(join(standalone, 'current/bin/codex'), join(root, '.local/bin/codex'))
    const harness = join(root, 'harness.ts')
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { mode: 0o700 })
    writeFileSync(harness, `
      import { runIsolatedCodexJson } from ${JSON.stringify(new URL('./slack-thread-intent.ts', import.meta.url).pathname)};
      import { existsSync, writeFileSync } from 'fs';
      const controller = new AbortController();
      let pid = 0, exits = 0, errorName = '', gone = false;
      try {
        await runIsolatedCodexJson('synthetic audit input', {}, { independent: true, signal: controller.signal,
          ${mode.startsWith('supervised') ? `supervision: { jobId: 'audit-fixture', stateDir: ${JSON.stringify(stateDir)} },` : ''}
          onProcessId(value) { pid = value; ${mode === 'fork-parent-exit' ? '' : mode === 'single' ? 'setTimeout(() => controller.abort(), 100);' : `
            const deadline = Date.now() + 5000;
            const ready = setInterval(() => {
              if (existsSync(${JSON.stringify(childPidPath)}) || Date.now() >= deadline) {
                clearInterval(ready);
                ${mode === 'supervised-owner-death' ? `writeFileSync(${JSON.stringify(join(root, 'ready.json'))}, JSON.stringify({pid})); process.kill(process.pid, 'SIGKILL');` : 'controller.abort();'}
              }
            }, 10);
          `} },
          onProcessExit() { exits++; }, timeoutMs: 5000 });
      } catch (error) { errorName = error.name; }
      try { process.kill(pid, 0); } catch (error) { gone = error.code === 'ESRCH'; }
      console.log(JSON.stringify({ registered: pid > 0, exits, errorName, gone }));
    `, { mode: 0o600 })
    const child = Bun.spawn([process.execPath, '--no-env-file', harness], {
      cwd: root, env: { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: tmpdir() }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(stderr).toBe('')
    if (mode === 'supervised-owner-death') {
      expect(code).toBe(137)
      const supervisorPid = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8')).pid
      const childPid = Number(readFileSync(childPidPath, 'utf8'))
      const gone = (pid: number) => { try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' } }
      const deadline = Date.now() + 8000
      while ((!gone(supervisorPid) || !gone(childPid)) && Date.now() < deadline) await Bun.sleep(25)
      expect(gone(supervisorPid)).toBe(true)
      expect(gone(childPid)).toBe(true)
      const ledger = JSON.parse(readFileSync(join(stateDir, 'executors/audit-fixture.json'), 'utf8'))
      expect(ledger.phase).toBe('cleanup-confirmed')
      expect(ledger.jobId).toBe('audit-fixture')
      return
    }
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ registered: true, exits: 1, errorName: mode === 'fork-parent-exit' ? '' : 'AbortError', gone: true })
    if (mode !== 'single') {
      const pid = Number(readFileSync(childPidPath, 'utf8'))
      let gone = false
      try { process.kill(pid, 0) } catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH' }
      expect(gone).toBe(true)
    }
  } finally {
    if (existsSync(childPidPath)) { try { process.kill(Number(readFileSync(childPidPath, 'utf8')), 'SIGKILL') } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)
