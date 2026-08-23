import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  classifyProcessProbe,
  inspectProcessLock,
  releaseProcessLock,
  tryAcquireProcessLock,
} from './process-lock.ts'

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

describe('process lock contention states', () => {
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
      version: 2,
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

  test('旧updaterとtimezone ruleが異なるcandidateはinvalid identityを公開しない', () => {
    const state = fixture()
    const updaterLock = join(state, 'update.lock', 'pid')
    mkdirSync(join(state, 'update.lock'))
    writeFileSync(updaterLock, `${process.pid}\n`, { mode: 0o600 })
    writeFileSync(`${updaterLock}.identity`, `${JSON.stringify({
      pid: process.pid,
      started: 'Thu Jan  1 00:00:00 1970',
      nonce: '12345678-1234-4123-8123-123456789abc',
    })}\n`, { mode: 0o600 })

    const serviceLock = join(state, 'plugin.lock')
    expect(() => tryAcquireProcessLock(serviceLock)).toThrow('cannot identify legacy lock owner')
    expect(existsSync(serviceLock)).toBe(false)
    expect(existsSync(`${serviceLock}.identity`)).toBe(false)
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
})
