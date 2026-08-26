import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  blockProcessLockDelegate,
  classifyProcessGroupProbe,
  classifyProcessProbe,
  delegateProcessLock,
  discardProcessLock,
  inspectProcessLock,
  processLockDelegateMatches,
  processLockLeaseIsExclusive,
  protectProcessLockDelegateCleanup,
  releaseProcessLock,
  stopProcessLockOwner,
  tryAcquireProcessLock,
  undelegateProcessLock,
} from './process-lock.ts'
import {
  readProcessIdentity,
  signalProcessGroupIfLeaderLive,
  signalProcessIfLive,
  type ProcessIdentity,
} from './process-generation.ts'
import {
  releaseProcessLock as releaseFrozenV2ProcessLock,
  tryAcquireProcessLock as tryAcquireFrozenV2ProcessLock,
} from './test-fixtures/process-lock-v2.ts'

const directories: string[] = []

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zerokun-process-lock-'))
  directories.push(dir)
  return dir
}

function processStart(pid: number, timezone: string): string {
  const result = Bun.spawnSync(['/bin/ps', '-o', 'lstart=', '-p', String(pid)], {
    env: { PATH: '/usr/bin:/bin', TZ: timezone, LC_ALL: 'C', LANG: 'C' },
    stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString().trim()
}

function ambientProcessStart(pid: number): string {
  const result = Bun.spawnSync(['/bin/ps', '-o', 'lstart=', '-p', String(pid)], {
    env: process.env,
    stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString().trim()
}

function spawnGuardHolder(lock: string, ready: string, holdMs: number) {
  return Bun.spawn([
    process.execPath,
    '--config=/dev/null',
    '--no-env-file',
    '-e',
    [
      "import { dlopen, FFIType } from 'bun:ffi'",
      "import { closeSync, constants, openSync, writeFileSync } from 'fs'",
      'const [guard, ready, holdMs] = process.argv.slice(-3)',
      "const library = dlopen('/usr/lib/libSystem.B.dylib', {",
      '  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },',
      '})',
      'const descriptor = openSync(guard, constants.O_RDWR | constants.O_NOFOLLOW)',
      'if (library.symbols.flock(descriptor, 2) !== 0) process.exit(2)',
      "writeFileSync(ready, 'ready\\n')",
      'await Bun.sleep(Number(holdMs))',
      'library.symbols.flock(descriptor, 8)',
      'closeSync(descriptor)',
    ].join('\n'),
    `${lock}.guard`,
    ready,
    String(holdMs),
  ], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
}

async function waitUntilReady(path: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(5)
  expect(existsSync(path)).toBe(true)
}

function killFixtureGroup(_proc: Bun.Subprocess, identity?: ProcessIdentity): void {
  if (identity && signalProcessGroupIfLeaderLive(identity, 'SIGKILL')) return
  if (identity) signalProcessIfLive(identity, 'SIGKILL')
}

describe('process lock contention states', () => {
  test('TERMを無視するownerも同一generationだけをKILLして停止する', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const ready = join(dir, 'force-stop-ready')
    const child = Bun.spawn([
      process.execPath,
      '--config=/dev/null',
      '--no-env-file',
      '-e',
      `import { writeFileSync } from 'fs'; process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(ready)}, 'ready'); await Bun.sleep(30_000)`,
      'zerokun-force-stop-fixture',
    ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    try {
      await waitUntilReady(ready)
      const acquired = tryAcquireProcessLock(lock, child.pid)
      expect(acquired.acquired).toBe(true)
      expect(await stopProcessLockOwner(
        lock,
        child.pid,
        /zerokun-force-stop-fixture/,
        { timeoutMs: 100, forceKill: true, killWaitMs: 2_000 },
      )).toBe('stopped')
      expect(await child.exited).not.toBe(0)
    } finally {
      try { child.kill('SIGKILL') } catch {}
      await child.exited
    }
  })

  test('公開中hardlinkのownerを読めなくても例外化やreclaimをしない', () => {
    const dir = fixture()
    const candidate = join(dir, 'candidate')
    const lock = join(dir, 'lock')
    writeFileSync(candidate, `${process.pid}\n`, { mode: 0o600 })
    linkSync(candidate, lock)

    expect(tryAcquireProcessLock(lock)).toEqual({
      acquired: false,
      kind: 'owner-unavailable',
    })
    expect(existsSync(candidate)).toBe(true)
    expect(existsSync(lock)).toBe(true)
    expect(readFileSync(candidate, 'utf8')).toBe(`${process.pid}\n`)
  })

  test('不正なowner内容は取得成功や削除として扱わない', () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    writeFileSync(lock, 'invalid-owner\n', { mode: 0o600 })

    expect(tryAcquireProcessLock(lock)).toEqual({
      acquired: false,
      kind: 'owner-unavailable',
    })
    expect(readFileSync(lock, 'utf8')).toBe('invalid-owner\n')
  })

  test('kill成功後のps失敗や空出力をdeadにしない', () => {
    expect(classifyProcessProbe('alive', 1, '')).toEqual({ status: 'unknown' })
    expect(classifyProcessProbe('alive', 0, '')).toEqual({ status: 'unknown' })
    expect(classifyProcessProbe('unknown', 0, 'S started')).toEqual({ status: 'unknown' })
    expect(classifyProcessProbe('esrch', 1, '')).toEqual({
      status: 'dead',
      reason: 'missing',
    })
    expect(classifyProcessProbe('alive', 0, 'Z  Sun Aug 23 00:00:00 2026')).toEqual({
      status: 'dead',
      reason: 'zombie',
    })
  })

  test('process groupはESRCHだけを自動回収可能なdeadとみなす', () => {
    expect(classifyProcessGroupProbe('alive')).toEqual({ status: 'alive' })
    expect(classifyProcessGroupProbe('esrch')).toEqual({ status: 'dead' })
    expect(classifyProcessGroupProbe('unknown')).toEqual({ status: 'unknown' })
  })

  test('正規化start時刻の一致とPID再利用を区別する', () => {
    const output = 'S  Sun Aug 23 00:00:00 2026\n'
    expect(classifyProcessProbe('alive', 0, output, 'Sun Aug 23 00:00:00 2026')).toEqual({
      status: 'alive',
      started: 'Sun Aug 23 00:00:00 2026',
    })
    expect(classifyProcessProbe('alive', 0, output, 'Sat Aug 22 00:00:00 2026')).toEqual({
      status: 'dead',
      reason: 'reused',
    })
  })

  test('main PIDは一行互換のままidentityをinodeへbindする', () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const attempt = tryAcquireProcessLock(lock)
    expect(attempt.acquired).toBe(true)
    if (!attempt.acquired) return
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`)
    const metadata = lstatSync(lock)
    const identity = JSON.parse(readFileSync(`${lock}.identity`, 'utf8'))
    expect(identity).toMatchObject({
      version: 3,
      pid: process.pid,
      canonicalStarted: processStart(process.pid, 'UTC'),
      device: metadata.dev,
      inode: metadata.ino,
    })
    expect(inspectProcessLock(lock)).toEqual({ status: 'active', pid: process.pid })
    expect(releaseProcessLock(lock, attempt.lease)).toBe(true)
    expect(inspectProcessLock(lock)).toEqual({ status: 'missing' })
    expect(existsSync(lock)).toBe(false)
    expect(existsSync(`${lock}.identity`)).toBe(false)
  })

  test('新規publicationは旧readerがfail-closedするv3とmicrosecond generationを使う', () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const acquired = tryAcquireProcessLock(lock)
    expect(acquired.acquired).toBe(true)
    if (!acquired.acquired) return
    const identity = JSON.parse(readFileSync(`${lock}.identity`, 'utf8'))
    const live = readProcessIdentity(process.pid)!
    expect(identity.version).toBe(3)
    expect(identity.canonicalStarted).toBeTruthy()
    expect(identity.bootSession).toBe(live.bootSession)
    expect(identity.startSec).toBe(live.startSec)
    expect(identity.startUsec).toBe(live.startUsec)
    expect(releaseProcessLock(lock, acquired.lease)).toBe(true)
  })

  test('凍結した旧v2 readerは高精度追加fieldを無視できv3はfail-closedにする', () => {
    const frozenV2Reader = (value: Record<string, unknown>): boolean => {
      if (value.version !== 2) return false
      return Number.isSafeInteger(value.pid)
        && typeof value.started === 'string'
        && typeof value.canonicalStarted === 'string'
        && typeof value.nonce === 'string'
        && Number.isSafeInteger(value.device)
        && Number.isSafeInteger(value.inode)
    }
    const compatible = {
      version: 2,
      pid: 42,
      started: 'legacy',
      canonicalStarted: 'canonical',
      nonce: '12345678-1234-4123-8123-123456789abc',
      device: 1,
      inode: 2,
      bootSession: '11111111-1111-4111-8111-111111111111',
      startSec: 1_800_000_000,
      startUsec: 123,
    }
    expect(frozenV2Reader(compatible)).toBe(true)
    expect(frozenV2Reader({ ...compatible, version: 3 })).toBe(false)
  })

  test('凍結した旧v2 ownerは新版setupのclean/rollback委譲後に自分のleaseを解放できる', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const runCase = async (protectedCleanup: boolean) => {
      const acquired = tryAcquireFrozenV2ProcessLock(lock)
      expect(acquired.acquired).toBe(true)
      if (!acquired.acquired) return
      const identityPath = `${lock}.identity`
      const legacyLease = acquired.lease
      const leader = Bun.spawn(['/bin/sleep', '30'], { detached: true })
      const leaderIdentity = readProcessIdentity(leader.pid)
      try {
        const delegated = delegateProcessLock(lock, legacyLease, leader.pid)
        expect(delegated?.leaseVersion).toBe(2)
        if (!delegated) return
        if (protectedCleanup) {
          expect(protectProcessLockDelegateCleanup(lock, delegated)).toBe(true)
          const poisoned = JSON.parse(readFileSync(identityPath, 'utf8'))
          expect(poisoned.version).toBe(3)
          expect(poisoned.delegate.cleanupPending).toBe(true)
          // The frozen v2 parser treats a known identity artifact with an
          // unknown version as owner-unavailable rather than reclaiming it.
          expect(poisoned.version === 2 ? 'read-v2' : 'owner-unavailable')
            .toBe('owner-unavailable')
        }
        killFixtureGroup(leader, leaderIdentity)
        await leader.exited
        expect(undelegateProcessLock(lock, delegated)).toBe(true)
        expect(JSON.parse(readFileSync(identityPath, 'utf8')).version).toBe(2)
        expect(releaseFrozenV2ProcessLock(lock, legacyLease)).toBe(true)
      } finally {
        killFixtureGroup(leader, leaderIdentity)
        await leader.exited
        rmSync(lock, { force: true })
        rmSync(identityPath, { force: true })
      }
    }
    await runCase(false)
    await runCase(true)
  })

  test('同じ秒でもmicrosecondが違うv2 ownerを同じgenerationとみなさない', () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const acquired = tryAcquireProcessLock(lock)
    expect(acquired.acquired).toBe(true)
    if (!acquired.acquired) return
    const identityPath = `${lock}.identity`
    const identity = JSON.parse(readFileSync(identityPath, 'utf8'))
    identity.startUsec = (identity.startUsec + 1) % 1_000_000
    writeFileSync(identityPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 })
    expect(inspectProcessLock(lock)).toEqual({ status: 'stale', pid: process.pid })
    expect(releaseProcessLock(lock, acquired.lease)).toBe(false)
  })

  test('古いleaseは同じPIDが再取得した新lockを削除できない', () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const first = tryAcquireProcessLock(lock)
    expect(first.acquired).toBe(true)
    if (!first.acquired) return
    expect(releaseProcessLock(lock, first.lease)).toBe(true)
    const second = tryAcquireProcessLock(lock)
    expect(second.acquired).toBe(true)
    if (!second.acquired) return
    expect(releaseProcessLock(lock, first.lease)).toBe(false)
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`)
    expect(releaseProcessLock(lock, second.lease)).toBe(true)
  })

  test('link後の中断で残った正規candidateだけを回収してlockを維持する', () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const acquired = tryAcquireProcessLock(lock)
    expect(acquired.acquired).toBe(true)
    if (!acquired.acquired) return
    const candidate = `${lock}.candidate-${process.pid}-${acquired.lease.nonce}`
    linkSync(lock, candidate)
    expect(lstatSync(lock).nlink).toBe(2)

    expect(tryAcquireProcessLock(lock)).toEqual({
      acquired: false,
      kind: 'held',
      heldPid: process.pid,
    })
    expect(existsSync(candidate)).toBe(false)
    expect(lstatSync(lock).nlink).toBe(1)
    expect(releaseProcessLock(lock, acquired.lease)).toBe(true)
  })

  test('candidate cleanup中断でnlink=2でもlease所有者は安全に解放できる', () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const acquired = tryAcquireProcessLock(lock)
    expect(acquired.acquired).toBe(true)
    if (!acquired.acquired) return
    const candidate = `${lock}.candidate-${process.pid}-${acquired.lease.nonce}`
    linkSync(lock, candidate)

    expect(releaseProcessLock(lock, acquired.lease)).toBe(true)
    expect(existsSync(lock)).toBe(false)
    expect(existsSync(`${lock}.identity`)).toBe(false)
    expect(lstatSync(candidate).nlink).toBe(1)
  })

  test('releaseは100msを超えるguard競合でもlockを孤児化しない', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const acquired = tryAcquireProcessLock(lock)
    expect(acquired.acquired).toBe(true)
    if (!acquired.acquired) return
    const ready = join(dir, 'guard-ready')
    const holder = spawnGuardHolder(lock, ready, 300)
    await waitUntilReady(ready)

    const startedAt = Date.now()
    expect(releaseProcessLock(lock, acquired.lease)).toBe(true)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
    expect(await holder.exited).toBe(0)
    expect(existsSync(lock)).toBe(false)
  })

  test('停止したguard ownerでもreleaseは有限時間でfail-closedに戻る', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const acquired = tryAcquireProcessLock(lock)
    expect(acquired.acquired).toBe(true)
    if (!acquired.acquired) return
    const ready = join(dir, 'guard-stopped')
    const holder = spawnGuardHolder(lock, ready, 30_000)
    await waitUntilReady(ready)
    process.kill(holder.pid, 'SIGSTOP')
    try {
      const startedAt = Date.now()
      expect(releaseProcessLock(lock, acquired.lease)).toBe(false)
      const elapsed = Date.now() - startedAt
      expect(elapsed).toBeGreaterThanOrEqual(4_500)
      expect(elapsed).toBeLessThan(7_000)
      expect(existsSync(lock)).toBe(true)
    } finally {
      holder.kill('SIGKILL')
      await holder.exited
    }
    expect(releaseProcessLock(lock, acquired.lease)).toBe(true)
  }, 10_000)

  test('v2 start時刻が違うlive PIDは再利用済みlockとしてだけ回収する', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const child = Bun.spawn(['/bin/sleep', '30'])
    try {
      await Bun.sleep(20)
      writeFileSync(lock, `${child.pid}\n`, { mode: 0o600 })
      const metadata = lstatSync(lock)
      writeFileSync(`${lock}.identity`, `${JSON.stringify({
        version: 2,
        pid: child.pid,
        started: 'Thu Jan  1 00:00:00 1970',
        canonicalStarted: 'Thu Jan  1 00:00:00 1970',
        nonce: '12345678-1234-4123-8123-123456789abc',
        device: metadata.dev,
        inode: metadata.ino,
      })}\n`, { mode: 0o600 })

      const attempt = tryAcquireProcessLock(lock)
      expect(attempt.acquired).toBe(true)
      if (!attempt.acquired) return
      expect(attempt.previousPid).toBe(child.pid)
      expect(() => process.kill(child.pid, 0)).not.toThrow()
      expect(releaseProcessLock(lock, attempt.lease)).toBe(true)
    } finally {
      child.kill()
      await child.exited
    }
  })

  test('旧updaterと同じtimezone ruleを新service identityへ引き継ぐ', () => {
    const state = fixture()
    const updaterLock = join(state, 'update.lock', 'pid')
    mkdirSync(join(state, 'update.lock'))
    writeFileSync(updaterLock, `${process.pid}\n`, { mode: 0o600 })
    writeFileSync(`${updaterLock}.identity`, `${JSON.stringify({
      pid: process.pid,
      started: ambientProcessStart(process.pid),
      nonce: '12345678-1234-4123-8123-123456789abc',
    })}\n`, { mode: 0o600 })

    const serviceLock = join(state, 'plugin.lock')
    const attempt = tryAcquireProcessLock(serviceLock)
    expect(attempt.acquired).toBe(true)
    if (!attempt.acquired) return
    expect(attempt.lease.canonicalStarted).toBe(processStart(process.pid, 'UTC'))
    expect(attempt.lease.started).toBe(ambientProcessStart(process.pid))
    expect(releaseProcessLock(serviceLock, attempt.lease)).toBe(true)
  })

  test('旧updaterとtimezone ruleが異なるcandidateはinvalid identityを公開しない', async () => {
    const state = fixture()
    const updaterLock = join(state, 'update.lock', 'pid')
    mkdirSync(join(state, 'update.lock'))
    const updater = join(state, 'zerokun-update')
    symlinkSync('/bin/sleep', updater)
    const child = Bun.spawn([updater, '30'])
    try {
      await Bun.sleep(20)
      writeFileSync(updaterLock, `${child.pid}\n`, { mode: 0o600 })
      writeFileSync(`${updaterLock}.identity`, `${JSON.stringify({
        pid: child.pid,
        started: 'Thu Jan  1 00:00:00 1970',
        nonce: '12345678-1234-4123-8123-123456789abc',
      })}\n`, { mode: 0o600 })

      const serviceLock = join(state, 'plugin.lock')
      expect(() => tryAcquireProcessLock(serviceLock)).toThrow('cannot identify legacy lock owner')
      expect(existsSync(serviceLock)).toBe(false)
      expect(existsSync(`${serviceLock}.identity`)).toBe(false)
    } finally {
      child.kill()
      await child.exited
    }
  })

  test('dead legacy update lockはservice lock公開を妨げない', () => {
    const state = fixture()
    const updaterLock = join(state, 'update.lock', 'pid')
    mkdirSync(join(state, 'update.lock'))
    const deadPid = 2_147_483_647
    writeFileSync(updaterLock, `${deadPid}\n`, { mode: 0o600 })
    writeFileSync(`${updaterLock}.identity`, `${JSON.stringify({
      pid: deadPid,
      started: 'Thu Jan  1 00:00:00 1970',
      nonce: '12345678-1234-4123-8123-123456789abc',
    })}\n`, { mode: 0o600 })

    const serviceLock = join(state, 'plugin.lock')
    const attempt = tryAcquireProcessLock(serviceLock)
    expect(attempt.acquired).toBe(true)
    if (attempt.acquired) expect(releaseProcessLock(serviceLock, attempt.lease)).toBe(true)
  })

  test('公開途中nlink=2で停止したdead legacy update lockもservice公開を妨げない', () => {
    const state = fixture()
    const updaterLock = join(state, 'update.lock', 'pid')
    mkdirSync(join(state, 'update.lock'))
    const deadPid = 2_147_483_647
    const candidate = `${updaterLock}.candidate-${deadPid}-12345678-1234-4123-8123-123456789abc`
    writeFileSync(candidate, `${deadPid}\n`, { mode: 0o600 })
    linkSync(candidate, updaterLock)
    writeFileSync(`${updaterLock}.identity`, `${JSON.stringify({
      pid: deadPid,
      started: 'Thu Jan  1 00:00:00 1970',
      nonce: '12345678-1234-4123-8123-123456789abc',
    })}\n`, { mode: 0o600 })

    const serviceLock = join(state, 'plugin.lock')
    const attempt = tryAcquireProcessLock(serviceLock)
    expect(attempt.acquired).toBe(true)
    expect(lstatSync(updaterLock).nlink).toBe(2)
    if (attempt.acquired) expect(releaseProcessLock(serviceLock, attempt.lease)).toBe(true)
  })

  test('identity未作成のdead legacy update lockもservice公開を妨げない', () => {
    const state = fixture()
    const updaterLock = join(state, 'update.lock', 'pid')
    mkdirSync(join(state, 'update.lock'))
    writeFileSync(updaterLock, '2147483647\n', { mode: 0o600 })

    const serviceLock = join(state, 'plugin.lock')
    const attempt = tryAcquireProcessLock(serviceLock)
    expect(attempt.acquired).toBe(true)
    if (attempt.acquired) expect(releaseProcessLock(serviceLock, attempt.lease)).toBe(true)
  })

  test('別commandへ再利用されたlegacy update PIDはservice lock公開を妨げない', async () => {
    const state = fixture()
    const updaterLock = join(state, 'update.lock', 'pid')
    mkdirSync(join(state, 'update.lock'))
    const child = Bun.spawn(['/bin/sleep', '30'])
    try {
      await Bun.sleep(20)
      writeFileSync(updaterLock, `${child.pid}\n`, { mode: 0o600 })
      writeFileSync(`${updaterLock}.identity`, `${JSON.stringify({
        pid: child.pid,
        started: 'Thu Jan  1 00:00:00 1970',
        nonce: '12345678-1234-4123-8123-123456789abc',
      })}\n`, { mode: 0o600 })
      const serviceLock = join(state, 'plugin.lock')
      const attempt = tryAcquireProcessLock(serviceLock)
      expect(attempt.acquired).toBe(true)
      expect(() => process.kill(child.pid, 0)).not.toThrow()
      if (attempt.acquired) expect(releaseProcessLock(serviceLock, attempt.lease)).toBe(true)
    } finally {
      child.kill()
      await child.exited
    }
  })

  test('identity未作成PIDが別commandへ再利用されてもservice公開を妨げない', async () => {
    const state = fixture()
    const updaterLock = join(state, 'update.lock', 'pid')
    mkdirSync(join(state, 'update.lock'))
    const child = Bun.spawn(['/bin/sleep', '30'])
    try {
      await Bun.sleep(20)
      writeFileSync(updaterLock, `${child.pid}\n`, { mode: 0o600 })
      const serviceLock = join(state, 'plugin.lock')
      const attempt = tryAcquireProcessLock(serviceLock)
      expect(attempt.acquired).toBe(true)
      expect(() => process.kill(child.pid, 0)).not.toThrow()
      if (attempt.acquired) expect(releaseProcessLock(serviceLock, attempt.lease)).toBe(true)
    } finally {
      child.kill()
      await child.exited
    }
  })

  test('delegateは専用process group leaderだけを登録する', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const ordinaryChild = Bun.spawn(['/bin/sleep', '30'])
    try {
      const acquired = tryAcquireProcessLock(lock)
      expect(acquired.acquired).toBe(true)
      if (!acquired.acquired) return
      expect(delegateProcessLock(lock, acquired.lease, ordinaryChild.pid)).toBeUndefined()
      expect(processLockLeaseIsExclusive(lock, acquired.lease)).toBe(true)
      expect(releaseProcessLock(lock, acquired.lease)).toBe(true)
    } finally {
      ordinaryChild.kill('SIGKILL')
      await ordinaryChild.exited
    }
  })

  test('primary死亡後もlive setup delegateがupdate lockを保持する', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const primary = Bun.spawn(['/bin/sleep', '30'])
    const setup = Bun.spawn(['/bin/sleep', '30'], { detached: true })
    const setupIdentity = readProcessIdentity(setup.pid)
    try {
      await Bun.sleep(20)
      const acquired = tryAcquireProcessLock(lock, primary.pid)
      expect(acquired.acquired).toBe(true)
      if (!acquired.acquired) return
      const delegated = delegateProcessLock(lock, acquired.lease, setup.pid)
      expect(delegated?.pid).toBe(setup.pid)
      expect(releaseProcessLock(lock, acquired.lease)).toBe(false)

      primary.kill('SIGKILL')
      await primary.exited
      expect(tryAcquireProcessLock(lock)).toEqual({
        acquired: false,
        kind: 'held',
        heldPid: setup.pid,
      })
      expect(inspectProcessLock(lock)).toEqual({ status: 'active', pid: setup.pid })

      expect(delegated && undelegateProcessLock(lock, delegated)).toBe(false)
      killFixtureGroup(setup, setupIdentity)
      await setup.exited
      const recovered = tryAcquireProcessLock(lock)
      expect(recovered.acquired).toBe(true)
      if (recovered.acquired) expect(recovered.previousPid).toBe(primary.pid)
      if (recovered.acquired) expect(releaseProcessLock(lock, recovered.lease)).toBe(true)
    } finally {
      try { primary.kill('SIGKILL') } catch {}
      killFixtureGroup(setup, setupIdentity)
      await Promise.all([primary.exited, setup.exited])
    }
  })

  test('高精度generationが一致するdelegateはlegacy時刻を改ざんされても回収しない', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const primary = Bun.spawn(['/bin/sleep', '30'])
    const reusedGroup = Bun.spawn(['/bin/sleep', '30'], { detached: true })
    const reusedGroupIdentity = readProcessIdentity(reusedGroup.pid)
    try {
      await Bun.sleep(20)
      const acquired = tryAcquireProcessLock(lock, primary.pid)
      expect(acquired.acquired).toBe(true)
      if (!acquired.acquired) return
      const delegated = delegateProcessLock(lock, acquired.lease, reusedGroup.pid)
      expect(delegated?.groupId).toBe(reusedGroup.pid)
      const identityPath = `${lock}.identity`
      const identity = JSON.parse(readFileSync(identityPath, 'utf8'))
      identity.delegate.canonicalStarted = 'Thu Jan  1 00:00:00 1970'
      writeFileSync(identityPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 })

      primary.kill('SIGKILL')
      await primary.exited
      const recovered = tryAcquireProcessLock(lock)
      expect(recovered).toEqual({
        acquired: false,
        kind: 'held',
        heldPid: reusedGroup.pid,
      })
      expect(() => process.kill(reusedGroup.pid, 0)).not.toThrow()
    } finally {
      try { primary.kill('SIGKILL') } catch {}
      killFixtureGroup(reusedGroup, reusedGroupIdentity)
      await Promise.all([primary.exited, reusedGroup.exited])
    }
  })

  test('PGID未証明delegateのPID再利用は全mutationをfail-closedにする', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const primary = Bun.spawn(['/bin/sleep', '30'])
    const reusedPid = Bun.spawn(['/bin/sleep', '30'], { detached: true })
    const reusedPidIdentity = readProcessIdentity(reusedPid.pid)
    try {
      await Bun.sleep(20)
      const acquired = tryAcquireProcessLock(lock, primary.pid)
      expect(acquired.acquired).toBe(true)
      if (!acquired.acquired) return
      const delegated = delegateProcessLock(lock, acquired.lease, reusedPid.pid)
      expect(delegated?.groupId).toBe(reusedPid.pid)
      if (!delegated) return
      const unscoped = {
        pid: delegated.pid,
        canonicalStarted: 'Thu Jan  1 00:00:00 1970',
        nonce: delegated.nonce,
      }
      const identityPath = `${lock}.identity`
      const identity = JSON.parse(readFileSync(identityPath, 'utf8'))
      identity.delegate = unscoped
      writeFileSync(identityPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 })

      primary.kill('SIGKILL')
      await primary.exited
      expect(inspectProcessLock(lock)).toEqual({ status: 'unknown', pid: primary.pid })
      expect(tryAcquireProcessLock(lock)).toEqual({
        acquired: false,
        kind: 'owner-unavailable',
      })
      expect(releaseProcessLock(lock, acquired.lease)).toBe(false)
      expect(undelegateProcessLock(lock, unscoped)).toBe(false)
      expect(discardProcessLock(lock, primary.pid)).toBe(false)
      expect(processLockLeaseIsExclusive(lock, acquired.lease)).toBe(false)
      expect(processLockDelegateMatches(lock, reusedPid.pid)).toBe(false)
      expect(() => process.kill(reusedPid.pid, 0)).not.toThrow()
    } finally {
      try { primary.kill('SIGKILL') } catch {}
      killFixtureGroup(reusedPid, reusedPidIdentity)
      await Promise.all([primary.exited, reusedPid.exited])
    }
  })

  test('delegate group leaderと同じprocess groupのsetup子だけを認可する', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const childPidFile = join(dir, 'group-child-pid')
    const leader = Bun.spawn([
      '/bin/bash',
      '-c',
      'sleep 30 & printf "%s\\n" "$!" > "$1"; wait',
      'zerokun-group-leader',
      childPidFile,
    ], { detached: true })
    const leaderIdentity = readProcessIdentity(leader.pid)
    try {
      await waitUntilReady(childPidFile)
      const childPid = Number(readFileSync(childPidFile, 'utf8').trim())
      const acquired = tryAcquireProcessLock(lock)
      expect(acquired.acquired).toBe(true)
      if (!acquired.acquired) return
      const delegated = delegateProcessLock(lock, acquired.lease, leader.pid)
      expect(delegated?.pid).toBe(leader.pid)
      const identityPath = `${lock}.identity`
      const identity = JSON.parse(readFileSync(identityPath, 'utf8'))
      delete identity.delegate.groupId
      writeFileSync(identityPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 })
      expect(processLockDelegateMatches(lock, childPid)).toBe(true)
      expect(processLockDelegateMatches(lock, childPid)).toBe(false)
      expect(JSON.parse(readFileSync(identityPath, 'utf8')).delegate.groupId).toBe(leader.pid)
      expect(processLockDelegateMatches(lock, process.pid)).toBe(false)
      expect(processLockLeaseIsExclusive(lock, acquired.lease)).toBe(false)
      expect(delegated && undelegateProcessLock(lock, delegated)).toBe(false)
      killFixtureGroup(leader, leaderIdentity)
      await leader.exited
      expect(delegated && undelegateProcessLock(lock, delegated)).toBe(true)
      expect(processLockLeaseIsExclusive(lock, acquired.lease)).toBe(true)
      expect(releaseProcessLock(lock, acquired.lease)).toBe(true)
    } finally {
      killFixtureGroup(leader, leaderIdentity)
      await leader.exited
    }
  })

  test('cleanup uncertaintyをblockしたdelegateは全process終了後も自動回収しない', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const primary = Bun.spawn(['/bin/sleep', '30'])
    const leader = Bun.spawn(['/bin/sleep', '30'], { detached: true })
    try {
      await Bun.sleep(20)
      const acquired = tryAcquireProcessLock(lock, primary.pid)
      expect(acquired.acquired).toBe(true)
      if (!acquired.acquired) return
      const identityPath = `${lock}.identity`
      const initial = JSON.parse(readFileSync(identityPath, 'utf8'))
      writeFileSync(identityPath, `${JSON.stringify({ ...initial, version: 2 })}\n`, { mode: 0o600 })
      const legacyLease = { ...acquired.lease, version: 2 as const }
      const delegated = delegateProcessLock(lock, legacyLease, leader.pid)
      expect(delegated).toBeDefined()
      if (!delegated) return
      expect(blockProcessLockDelegate(lock, delegated)).toBe(true)
      const poisoned = JSON.parse(readFileSync(identityPath, 'utf8'))
      expect(poisoned.version).toBe(3)
      expect(poisoned.delegate.blocked).toBe(true)
      primary.kill('SIGKILL')
      leader.kill('SIGKILL')
      await Promise.all([primary.exited, leader.exited])
      expect(inspectProcessLock(lock)).toEqual({ status: 'unknown', pid: primary.pid })
      expect(tryAcquireProcessLock(lock)).toEqual({
        acquired: false,
        kind: 'owner-unavailable',
      })
      expect(undelegateProcessLock(lock, delegated)).toBe(false)
      expect(releaseProcessLock(lock, legacyLease)).toBe(false)
    } finally {
      try { primary.kill('SIGKILL') } catch {}
      try { leader.kill('SIGKILL') } catch {}
      await Promise.all([primary.exited, leader.exited])
    }
  })

  test('別boot sessionのblocked delegateは旧process不在が確定するため回収する', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const primary = Bun.spawn(['/bin/sleep', '30'])
    const leader = Bun.spawn(['/bin/sleep', '30'], { detached: true })
    try {
      const acquired = tryAcquireProcessLock(lock, primary.pid)
      expect(acquired.acquired).toBe(true)
      if (!acquired.acquired) return
      const delegated = delegateProcessLock(lock, acquired.lease, leader.pid)
      expect(delegated).toBeDefined()
      if (!delegated) return
      expect(blockProcessLockDelegate(lock, delegated)).toBe(true)
      primary.kill('SIGKILL')
      leader.kill('SIGKILL')
      await Promise.all([primary.exited, leader.exited])
      const identityPath = `${lock}.identity`
      const identity = JSON.parse(readFileSync(identityPath, 'utf8'))
      identity.delegate.bootSession = '11111111-1111-4111-8111-111111111111'
      writeFileSync(identityPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 })
      const recovered = tryAcquireProcessLock(lock)
      expect(recovered.acquired).toBe(true)
      if (recovered.acquired) expect(releaseProcessLock(lock, recovered.lease)).toBe(true)
    } finally {
      try { primary.kill('SIGKILL') } catch {}
      try { leader.kill('SIGKILL') } catch {}
      await Promise.all([primary.exited, leader.exited])
    }
  })

  test('symlink lock parentではguardをstate外へ作成しない', () => {
    const dir = fixture()
    const external = join(dir, 'external')
    const state = join(dir, 'state')
    mkdirSync(external)
    mkdirSync(state)
    symlinkSync(external, join(state, 'update.lock'))
    const lock = join(state, 'update.lock', 'pid')
    expect(tryAcquireProcessLock(lock)).toEqual({
      acquired: false,
      kind: 'owner-unavailable',
    })
    expect(existsSync(join(external, 'pid.guard'))).toBe(false)
  })

  test('primaryとdelegate leader死亡後も同PGID子が全mutationを止める', async () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const childPidFile = join(dir, 'orphan-group-child-pid')
    const primary = Bun.spawn(['/bin/sleep', '30'])
    const leader = Bun.spawn([
      '/bin/bash',
      '-c',
      '/bin/bash -c "trap \'\' HUP TERM; while :; do sleep 1; done" & '
        + 'printf "%s\\n" "$!" > "$1"; wait',
      'zerokun-orphan-group-leader',
      childPidFile,
    ], { detached: true })
    let childPid = 0
    try {
      await waitUntilReady(childPidFile)
      childPid = Number(readFileSync(childPidFile, 'utf8').trim())
      const acquired = tryAcquireProcessLock(lock, primary.pid)
      expect(acquired.acquired).toBe(true)
      if (!acquired.acquired) return
      const delegated = delegateProcessLock(lock, acquired.lease, leader.pid)
      expect(delegated?.groupId).toBe(leader.pid)

      primary.kill('SIGKILL')
      leader.kill('SIGKILL')
      await Promise.all([primary.exited, leader.exited])
      expect(() => process.kill(childPid, 0)).not.toThrow()
      expect(tryAcquireProcessLock(lock)).toEqual({
        acquired: false,
        kind: 'held',
        heldPid: leader.pid,
      })
      expect(inspectProcessLock(lock)).toEqual({ status: 'active', pid: leader.pid })
      expect(releaseProcessLock(lock, acquired.lease)).toBe(false)
      expect(delegated && undelegateProcessLock(lock, delegated)).toBe(false)
      expect(discardProcessLock(lock, primary.pid)).toBe(false)
      expect(processLockLeaseIsExclusive(lock, acquired.lease)).toBe(false)

      process.kill(childPid, 'SIGKILL')
      const stopped = Date.now() + 2_000
      while (Date.now() < stopped) {
        try { process.kill(-leader.pid, 0); await Bun.sleep(5) } catch { break }
      }
      const recovered = tryAcquireProcessLock(lock)
      expect(recovered.acquired).toBe(true)
      if (recovered.acquired) expect(recovered.previousPid).toBe(primary.pid)
      if (recovered.acquired) expect(releaseProcessLock(lock, recovered.lease)).toBe(true)
    } finally {
      try { primary.kill('SIGKILL') } catch {}
      killFixtureGroup(leader, readProcessIdentity(leader.pid))
      if (childPid > 0) try { process.kill(childPid, 'SIGKILL') } catch {}
      await Promise.all([primary.exited, leader.exited])
    }
  })

  test('identity欠損はlive PIDでもactiveと推測せずunknownにする', () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 })
    expect(inspectProcessLock(lock)).toEqual({ status: 'unknown', pid: process.pid })
  })

  test('identity作成前に停止したPID lockはstaleと判定する', () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const deadPid = 2_147_483_647
    writeFileSync(lock, `${deadPid}\n`, { mode: 0o600 })
    expect(inspectProcessLock(lock)).toEqual({ status: 'stale', pid: deadPid })
  })

  test('壊れたidentity artifactはdead PIDでもfail-closedにする', () => {
    const dir = fixture()
    const lock = join(dir, 'lock')
    const deadPid = 2_147_483_647
    writeFileSync(lock, `${deadPid}\n`, { mode: 0o600 })
    writeFileSync(`${lock}.identity`, '{broken\n', { mode: 0o600 })
    expect(tryAcquireProcessLock(lock)).toEqual({
      acquired: false,
      kind: 'owner-unavailable',
    })
    expect(inspectProcessLock(lock)).toEqual({ status: 'unknown', pid: deadPid })
    expect(readFileSync(lock, 'utf8')).toBe(`${deadPid}\n`)
  })
})
