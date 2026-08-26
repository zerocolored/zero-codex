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
  processIdentityIsStopped,
  readProcessIdentity,
  readProcessTable,
  signalProcessIfLive,
  signalProcessGroupIfLeaderLive,
  type ProcessIdentity,
} from './process-generation.ts'
import { prepareManagedStateRoot, ensureManagedDirectory } from './managed-path.ts'
import { createSeatbeltFingerprint } from './seatbelt-fingerprint.ts'

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
    'seed前に停止gateが消えてもactive registrationとleaderを保持し回収できる',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'zerokun-supervisor-seed-failure-'))
      temporaryRoots.push(root)
      const registration = join(root, 'executor.json')
      const fakeCodex = join(root, 'fake-codex')
      writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
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
          ZEROKUN_SUPERVISOR_TEST_SEED_DELAY_MS: '1500',
          ZEROKUN_SUPERVISOR_TEST_UNVERIFIED: '1',
        },
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        detached: true,
      })
      const supervisorIdentity = readProcessIdentity(supervisor.pid)
      expect(supervisorIdentity).toBeDefined()
      liveSupervisors.push(supervisorIdentity!)
      await waitFor(() => existsSync(registration))
      let gateIdentity: ProcessIdentity | undefined
      await waitFor(() => {
        gateIdentity = readProcessTable().find(identity => (
          identity.ppid === supervisor.pid
          && identity.pgid === supervisor.pid
          && processIdentityIsStopped(identity)
        ))
        return gateIdentity !== undefined
      })
      expect(gateIdentity).toBeDefined()
      expect(JSON.parse(readFileSync(registration, 'utf8'))).toMatchObject({
        phase: 'active',
        cleanupPending: true,
        pid: supervisor.pid,
      })
      expect(signalProcessIfLive(gateIdentity!, 'SIGKILL')).toBe(true)
      await waitFor(() => observeProcessGeneration(gateIdentity!).status === 'dead')
      // Wait past the injected seed delay so seedTrackedProcess observes the
      // exact dead gate and the supervisor enters its retained-receipt loop.
      await Bun.sleep(1_600)
      expect(observeProcessGeneration(supervisorIdentity!).status).toBe('alive')
      expect(JSON.parse(readFileSync(registration, 'utf8'))).toMatchObject({
        phase: 'active',
        cleanupPending: true,
        pid: supervisor.pid,
      })

      expect(signalProcessGroupIfLeaderLive(supervisorIdentity!, 'SIGTERM')).toBe(true)
      await Bun.sleep(100)
      expect(observeProcessGeneration(supervisorIdentity!).status).toBe('alive')
      expect(signalProcessGroupIfLeaderLive(supervisorIdentity!, 'SIGKILL')).toBe(true)
      await Promise.race([supervisor.exited, Bun.sleep(2_000)])
      expect(observeProcessGeneration(supervisorIdentity!).status).toBe('dead')
      expect(existsSync(registration)).toBe(true)
      liveSupervisors.splice(0)
    },
    10_000,
  )

  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'stdioと親子関係を捨てたSeatbelt子もcleanup-confirmed前に回収する',
    async () => {
      const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zerokun-supervisor-seatbelt-')))
      temporaryRoots.push(root)
      ensureManagedDirectory(root, join(root, 'executors'))
      const registration = join(root, 'executors', 'seatbelt-job.json')
      const escapedPidPath = join(root, 'escaped.pid')
      const fakeCodex = join(root, 'fake-codex')
      const fingerprint = createSeatbeltFingerprint(root, 'seatbelt-job', 'c'.repeat(32))
      writeFileSync(fakeCodex, `#!/usr/bin/env bun
const code = [
  'import os,sys,time',
  'pid=os.fork()',
  'if pid:',
  ' open(sys.argv[1],"w").write(str(pid))',
  ' os._exit(0)',
  'os.setsid()',
  'os.close(0);os.close(1);os.close(2)',
  'time.sleep(60)',
].join('\\n')
const profile = [
  '(version 1)',
  '(allow default)',
  '(deny file-read-data (literal ' + JSON.stringify(process.env.FP_DENY) + '))',
].join('\\n')
const child = Bun.spawn(['/usr/bin/sandbox-exec','-p',profile,'/usr/bin/python3','-c',code,process.env.ESCAPED_PID], {
  stdin:'ignore',stdout:'ignore',stderr:'ignore',
})
await child.exited
`, { mode: 0o700 })
      const supervisor = Bun.spawn([
        process.execPath,
        '--config=/dev/null',
        '--no-env-file',
        join(import.meta.dir, 'codex-supervisor.ts'),
        'seatbelt-job',
        registration,
        '--seatbelt-fingerprint', fingerprint.allow.path, fingerprint.deny.path,
        '--unverified-for-tests',
        '--', fakeCodex,
      ], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: root,
          FP_DENY: fingerprint.deny.path,
          ESCAPED_PID: escapedPidPath,
          ZEROKUN_SUPERVISOR_TEST_UNVERIFIED: '1',
        },
        stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', detached: true,
      })
      const supervisorIdentity = readProcessIdentity(supervisor.pid)
      expect(supervisorIdentity).toBeDefined()
      liveSupervisors.push(supervisorIdentity!)
      expect(await supervisor.exited).toBe(0)
      liveSupervisors.splice(0)
      await waitFor(() => existsSync(escapedPidPath))
      const escapedPid = Number(readFileSync(escapedPidPath, 'utf8'))
      expect(readProcessIdentity(escapedPid)).toBeUndefined()
      expect(JSON.parse(readFileSync(registration, 'utf8'))).toMatchObject({
        version: 4,
        phase: 'cleanup-confirmed',
        fingerprint,
      })
    },
    10_000,
  )
})
