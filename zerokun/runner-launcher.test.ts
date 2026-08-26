import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readProcessIdentity,
  signalProcessIfLive,
  type ProcessIdentity,
} from './process-generation.ts'
import { readPinnedHerdrRuntime } from './herdr-runtime.ts'

const processes: ProcessIdentity[] = []
const directories: string[] = []

afterEach(async () => {
  for (const processIdentity of processes.splice(0)) {
    signalProcessIfLive(processIdentity, 'SIGTERM')
    await Bun.sleep(50)
    signalProcessIfLive(processIdentity, 'SIGKILL')
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function parentPid(pid: number): number {
  const result = Bun.spawnSync(['/bin/ps', '-o', 'ppid=', '-p', String(pid)], {
    stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return Number(result.stdout.toString().trim())
}

describe('Herdr-owned runner launcher', () => {
  test('runnerをlauncherの子として保持しsignalを転送する', async () => {
    if (process.platform !== 'darwin') return
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-runner-launcher-'))
    directories.push(dir)
    chmodSync(dir, 0o700)
    const state = join(dir, 'state')
    mkdirSync(state, { mode: 0o700 })
    const pidFile = join(dir, 'runner.pid')
    const pinObservation = join(dir, 'pin-observation')
    const herdrSocket = join(dir, 'herdr.sock')
    const herdrServer = Bun.listen({
      unix: herdrSocket,
      socket: { data() {} },
    })
    chmodSync(herdrSocket, 0o600)
    const herdr = join(dir, 'herdr')
    writeFileSync(herdr, [
      '#!/bin/sh',
      `printf '%s\\n' ${JSON.stringify(JSON.stringify({
        id: 'test:pane:current',
        result: { pane: {
          pane_id: 'wT:p1',
          tab_id: 'wT:t1',
          terminal_id: 'term_abcdef012345',
          workspace_id: 'wT',
        }, type: 'pane_current' },
      }))}`,
      '',
    ].join('\n'), { mode: 0o700 })
    const runner = join(dir, 'fake-runner.ts')
    writeFileSync(runner, [
      "import { existsSync, writeFileSync } from 'fs'",
      `import { decodeHerdrRuntimeIdentity, writePinnedHerdrRuntime } from ${JSON.stringify(join(import.meta.dir, 'herdr-runtime.ts'))}`,
      "const encoded = process.env.ZEROKUN_LAUNCH_HERDR_RUNTIME",
      "if (!encoded) throw new Error('launch runtime was not passed')",
      `writeFileSync(${JSON.stringify(pinObservation)}, existsSync(${JSON.stringify(join(state, 'herdr-runtime.json'))}) ? 'present' : 'absent')`,
      `writePinnedHerdrRuntime(${JSON.stringify(state)}, decodeHerdrRuntimeIdentity(encoded))`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      "process.on('SIGINT', () => {})",
      "process.on('SIGTERM', () => process.exit(0))",
      'await Bun.sleep(60_000)',
      '',
    ].join('\n'), { mode: 0o700 })
    const launched = Bun.spawn([
      process.execPath, '--config=/dev/null', '--no-env-file',
      join(import.meta.dir, 'runner-launcher.ts'), runner, state, join(state, 'runner.log'),
      join(state, 'job-runner-starter.lock'),
    ], {
      stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        HERDR_ENV: '1',
        HERDR_BIN_PATH: herdr,
        HERDR_SOCKET_PATH: herdrSocket,
        HERDR_PANE_ID: 'wT:p1',
        HERDR_TAB_ID: 'wT:t1',
        HERDR_TERMINAL_ID: 'term_abcdef012345',
        HERDR_WORKSPACE_ID: 'wT',
      },
    })
    const launcherIdentity = readProcessIdentity(launched.pid)
    expect(launcherIdentity).toBeDefined()
    processes.push(launcherIdentity!)
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) await Bun.sleep(20)
    if (!existsSync(pidFile)) {
      const stderr = await new Response(launched.stderr).text()
      const runnerLog = existsSync(join(state, 'runner.log'))
        ? readFileSync(join(state, 'runner.log'), 'utf8')
        : '(missing)'
      throw new Error(`runner did not publish its PID\nlauncher stderr: ${stderr}\nrunner log: ${runnerLog}`)
    }
    expect(readFileSync(pinObservation, 'utf8')).toBe('absent')
    const pinned = readPinnedHerdrRuntime(state)
    expect(pinned.paneId).toBe('wT:p1')
    expect(pinned.terminalId).toBe('term_abcdef012345')
    const runnerPid = Number(readFileSync(pidFile, 'utf8'))
    expect(parentPid(runnerPid)).toBe(launched.pid)
    expect(signalProcessIfLive(launcherIdentity!, 'SIGTERM')).toBe(true)
    expect(await Promise.race([
      launched.exited.then(() => true),
      Bun.sleep(2_000).then(() => false),
    ])).toBe(true)
    expect(() => process.kill(runnerPid, 0)).toThrow()
    herdrServer.stop(true)
  })
})
