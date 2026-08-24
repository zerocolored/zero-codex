import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readProcessIdentity,
  signalProcessGroupIfLeaderLive,
  type ProcessIdentity,
} from './process-generation.ts'

const processGroups: ProcessIdentity[] = []
const directories: string[] = []

afterEach(async () => {
  for (const leader of processGroups.splice(0)) {
    signalProcessGroupIfLeaderLive(leader, 'SIGTERM')
    await Bun.sleep(50)
    signalProcessGroupIfLeaderLive(leader, 'SIGKILL')
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function processGroup(pid: number): number {
  const result = Bun.spawnSync(['/bin/ps', '-o', 'pgid=', '-p', String(pid)], {
    stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return Number(result.stdout.toString().trim())
}

describe('detached runner launcher', () => {
  test('runnerをgatewayとは別process groupへ起動する', async () => {
    if (process.platform !== 'darwin') return
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-runner-launcher-'))
    directories.push(dir)
    chmodSync(dir, 0o700)
    const state = join(dir, 'state')
    mkdirSync(state, { mode: 0o700 })
    const pidFile = join(dir, 'runner.pid')
    const runner = join(dir, 'fake-runner.ts')
    writeFileSync(runner, [
      "import { writeFileSync } from 'fs'",
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      "process.on('SIGINT', () => {})",
      "process.on('SIGTERM', () => process.exit(0))",
      'await Bun.sleep(60_000)',
      '',
    ].join('\n'), { mode: 0o700 })
    const launched = Bun.spawnSync([
      process.execPath, '--config=/dev/null', '--no-env-file',
      join(import.meta.dir, 'runner-launcher.ts'), runner, state, join(state, 'runner.log'),
    ], { stdout: 'pipe', stderr: 'pipe' })
    expect(launched.exitCode, launched.stderr.toString()).toBe(0)
    const leaderPid = Number(launched.stdout.toString().trim())
    expect(leaderPid).toBeGreaterThan(0)
    const leaderIdentity = readProcessIdentity(leaderPid)
    expect(leaderIdentity).toBeDefined()
    processGroups.push(leaderIdentity!)
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) await Bun.sleep(20)
    expect(existsSync(pidFile)).toBe(true)
    const runnerPid = Number(readFileSync(pidFile, 'utf8'))
    expect(processGroup(leaderPid)).toBe(leaderPid)
    expect(processGroup(runnerPid)).toBe(leaderPid)
    expect(processGroup(process.pid)).not.toBe(leaderPid)
    expect(signalProcessGroupIfLeaderLive(leaderIdentity!, 'SIGINT')).toBe(true)
    await Bun.sleep(100)
    expect(() => process.kill(runnerPid, 0)).not.toThrow()
  })
})
