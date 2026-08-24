import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  observeProcessGeneration,
  readProcessIdentity,
  signalProcessGroupIfLeaderLive,
  type ProcessIdentity,
} from './process-generation.ts'

const temporaryRoots: string[] = []
const liveSupervisors: ProcessIdentity[] = []

afterEach(async () => {
  for (const identity of liveSupervisors.splice(0)) {
    signalProcessGroupIfLeaderLive(identity, 'SIGKILL')
  }
  await Bun.sleep(50)
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20)
  expect(predicate()).toBe(true)
}

describe('Codex stable supervisor gate', () => {
  test.skipIf(process.platform !== 'darwin')(
    '独立process group leaderでなければregistration作成前に停止する',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'zerokun-supervisor-group-check-'))
      temporaryRoots.push(root)
      const registration = join(root, 'executor.json')
      const childStarted = join(root, 'child-started')
      const fakeCodex = join(root, 'fake-codex')
      writeFileSync(fakeCodex, `#!/bin/sh\ntouch '${childStarted}'\n`, { mode: 0o700 })
      const supervisor = Bun.spawn([
        process.execPath,
        '--config=/dev/null',
        '--no-env-file',
        join(import.meta.dir, 'codex-supervisor.ts'),
        'non-leader-job',
        registration,
        '--unverified-for-tests',
        '--',
        fakeCodex,
      ], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: root,
          ZEROKUN_SUPERVISOR_TEST_UNVERIFIED: '1',
        },
        stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
      })
      expect(await supervisor.exited).not.toBe(0)
      expect(existsSync(registration)).toBe(false)
      expect(existsSync(childStarted)).toBe(false)
    },
  )

  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'seed前にCodexが終了してもregistrationとleaderを保持しgroup全体を回収できる',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'zerokun-supervisor-seed-failure-'))
      temporaryRoots.push(root)
      const registration = join(root, 'executor.json')
      const childPidFile = join(root, 'child.pid')
      const fakeCodex = join(root, 'fake-codex')
      writeFileSync(fakeCodex, `#!/usr/bin/env bun
const child = Bun.spawn([
  process.execPath,
  '--no-env-file',
  '-e',
  "process.on('SIGTERM', () => {}); await Bun.sleep(30_000)",
], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
child.unref()
await Bun.write(process.env.CHILD_PID_FILE!, String(child.pid))
`, { mode: 0o700 })
      chmodSync(fakeCodex, 0o700)
      const supervisor = Bun.spawn([
        process.execPath,
        '--config=/dev/null',
        '--no-env-file',
        join(import.meta.dir, 'codex-supervisor.ts'),
        'seed-failure-job',
        registration,
        '--unverified-for-tests',
        '--',
        fakeCodex,
      ], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: root,
          CHILD_PID_FILE: childPidFile,
          ZEROKUN_SUPERVISOR_TEST_SEED_DELAY_MS: '300',
          ZEROKUN_SUPERVISOR_TEST_UNVERIFIED: '1',
        },
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        detached: true,
      })
      const supervisorIdentity = readProcessIdentity(supervisor.pid)
      expect(supervisorIdentity).toBeDefined()
      liveSupervisors.push(supervisorIdentity!)
      await waitFor(() => existsSync(registration) && existsSync(childPidFile))
      const childPid = Number(readFileSync(childPidFile, 'utf8'))
      const childIdentity = readProcessIdentity(childPid)
      expect(childIdentity).toBeDefined()
      await Bun.sleep(500)
      expect(observeProcessGeneration(supervisorIdentity!).status).toBe('alive')
      expect(observeProcessGeneration(childIdentity!).status).toBe('alive')
      expect(JSON.parse(readFileSync(registration, 'utf8'))).toMatchObject({
        cleanupPending: true,
        pid: supervisor.pid,
      })

      expect(signalProcessGroupIfLeaderLive(supervisorIdentity!, 'SIGTERM')).toBe(true)
      await Bun.sleep(100)
      expect(observeProcessGeneration(supervisorIdentity!).status).toBe('alive')
      expect(signalProcessGroupIfLeaderLive(supervisorIdentity!, 'SIGKILL')).toBe(true)
      await Promise.race([supervisor.exited, Bun.sleep(2_000)])
      await waitFor(() => observeProcessGeneration(childIdentity!).status === 'dead')
      expect(observeProcessGeneration(supervisorIdentity!).status).toBe('dead')
      expect(existsSync(registration)).toBe(true)
      liveSupervisors.splice(0)
    },
    10_000,
  )
})
