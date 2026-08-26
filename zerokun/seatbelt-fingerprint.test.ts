import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { prepareManagedStateRoot } from './managed-path.ts'
import { observeProcessGeneration, readProcessIdentity } from './process-generation.ts'
import {
  createSeatbeltFingerprint,
  recoverOrphanSeatbeltFingerprints,
  reapSeatbeltFingerprint,
  removeSeatbeltFingerprint,
  verifySeatbeltFingerprint,
} from './seatbelt-fingerprint.ts'

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function waitFor(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10)
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`)
}

describe('Seatbelt descendant fingerprint', () => {
  test('tagの置換をcleanup evidenceとして受理しない', () => {
    const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-seatbelt-tags-')))
    temporaryDirs.push(root)
    const fingerprint = createSeatbeltFingerprint(root, 'job-1', 'a'.repeat(32))
    expect(() => verifySeatbeltFingerprint(root, fingerprint)).not.toThrow()
    rmSync(fingerprint.allow.path)
    expect(() => verifySeatbeltFingerprint(root, fingerprint)).toThrow()
  })

  test('旧版retirement中断で残ったdeny単独tagをstartup recoveryで除去する', async () => {
    const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-seatbelt-retire-')))
    temporaryDirs.push(root)
    const fingerprint = createSeatbeltFingerprint(root, 'job-retire', 'd'.repeat(32))
    rmSync(fingerprint.allow.path)

    expect(await recoverOrphanSeatbeltFingerprints(root)).toEqual([])
    expect(existsSync(fingerprint.deny.path)).toBe(false)
    expect(await recoverOrphanSeatbeltFingerprints(root)).toEqual([])
  })

  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'setsidしてPID 1へreparentされたsandbox子をkernel signatureで回収する',
    async () => {
      const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-seatbelt-reap-')))
      temporaryDirs.push(root)
      const fingerprint = createSeatbeltFingerprint(root, 'job-2', 'b'.repeat(32))
      const pidPath = join(root, 'escaped.pid')
      const script = [
        'import os,sys,time',
        'pid=os.fork()',
        'if pid:',
        ' open(sys.argv[1],"w").write(str(pid))',
        ' os._exit(0)',
        'os.setsid()',
        'os.close(0);os.close(1);os.close(2)',
        'time.sleep(60)',
      ].join('\n')
      const profile = [
        '(version 1)',
        '(allow default)',
        `(deny file-read-data (literal ${JSON.stringify(fingerprint.deny.path)}))`,
      ].join('\n')
      const earliest = readProcessIdentity(process.pid)
      expect(earliest).toBeDefined()
      const launcher = Bun.spawn([
        '/usr/bin/sandbox-exec', '-p', profile,
        '/usr/bin/python3', '-c', script, pidPath,
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
      expect(await launcher.exited).toBe(0)
      await waitFor(pidPath)
      const escapedPid = Number(readFileSync(pidPath, 'utf8'))
      const escaped = readProcessIdentity(escapedPid)
      expect(escaped).toBeDefined()
      expect(escaped!.ppid).toBe(1)

      const reaped = await reapSeatbeltFingerprint({
        stateDir: root,
        fingerprint,
        earliest: earliest!,
      })
      expect(reaped).toContain(escapedPid)
      expect(observeProcessGeneration(escaped!).status).toBe('dead')
      removeSeatbeltFingerprint(root, fingerprint)
    },
    10_000,
  )

  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'executor登録前にcrashしたfingerprint子もstartup scanで回収する',
    async () => {
      const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-seatbelt-orphan-')))
      temporaryDirs.push(root)
      const fingerprint = createSeatbeltFingerprint(root, 'job-preflight', 'c'.repeat(32))
      const pidPath = join(root, 'preflight-escaped.pid')
      const script = [
        'import os,sys,time',
        'pid=os.fork()',
        'if pid:',
        ' open(sys.argv[1],"w").write(str(pid))',
        ' os._exit(0)',
        'os.setsid()',
        'os.close(0);os.close(1);os.close(2)',
        'time.sleep(60)',
      ].join('\n')
      const profile = [
        '(version 1)',
        '(allow default)',
        `(deny file-read-data (literal ${JSON.stringify(fingerprint.deny.path)}))`,
      ].join('\n')
      const launcher = Bun.spawn([
        '/usr/bin/sandbox-exec', '-p', profile,
        '/usr/bin/python3', '-c', script, pidPath,
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
      expect(await launcher.exited).toBe(0)
      await waitFor(pidPath)
      const escapedPid = Number(readFileSync(pidPath, 'utf8'))
      const escaped = readProcessIdentity(escapedPid)
      expect(escaped).toBeDefined()

      expect(await recoverOrphanSeatbeltFingerprints(root)).toContain(escapedPid)
      expect(observeProcessGeneration(escaped!).status).toBe('dead')
      expect(existsSync(fingerprint.allow.path)).toBe(false)
      expect(await recoverOrphanSeatbeltFingerprints(root)).toEqual([])
    },
    10_000,
  )
})
