import { dlopen, FFIType } from 'bun:ffi'

const PROC_PIDTBSDINFO = 3
const PROC_BSDINFO_SIZE = 136
const PROC_STATUS_OFFSET = 4
const PROC_PID_OFFSET = 12
const PROC_PPID_OFFSET = 16
const PROC_UID_OFFSET = 20
const PROC_PGID_OFFSET = 100
const PROC_START_SEC_OFFSET = 120
const PROC_START_USEC_OFFSET = 128
const ZOMBIE_STATUS = 5
const STOPPED_STATUS = 4
const INITIAL_PID_CAPACITY = 4_096
const MAX_PID_CAPACITY = 131_072

const libproc = process.platform === 'darwin'
  ? dlopen('/usr/lib/libSystem.B.dylib', {
      proc_listallpids: {
        args: [FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    })
  : undefined

let cachedBootSession: string | undefined

export interface ProcessIdentity {
  pid: number
  ppid: number
  pgid: number
  status: number
  /** Effective UID reported by proc_bsdinfo (Darwin). */
  uid?: number
  bootSession: string
  startSec: number
  startUsec: number
  /** Stable, JSON-safe generation key used by in-memory trackers. */
  started: string
}

export type ProcessGenerationProbe =
  | { status: 'alive'; identity: ProcessIdentity }
  | { status: 'dead'; reason: 'missing' | 'zombie' | 'reused' }
  | { status: 'unknown' }

export function processStartKey(input: {
  bootSession: string
  startSec: number
  startUsec: number
}): string {
  if (!input.bootSession || input.bootSession.length > 128
    || !Number.isSafeInteger(input.startSec) || input.startSec <= 0
    || !Number.isSafeInteger(input.startUsec)
    || input.startUsec < 0 || input.startUsec > 999_999) {
    throw new Error('invalid process generation')
  }
  return `${input.bootSession}:${input.startSec}:${String(input.startUsec).padStart(6, '0')}`
}

export function parseProcessStartKey(value: string): {
  bootSession: string
  startSec: number
  startUsec: number
} | undefined {
  const match = /^([0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}):(\d+):(\d{6})$/i.exec(value)
  if (!match) return undefined
  const startSec = Number(match[2])
  const startUsec = Number(match[3])
  if (!Number.isSafeInteger(startSec) || startSec <= 0
    || !Number.isSafeInteger(startUsec) || startUsec > 999_999) return undefined
  return { bootSession: match[1]!.toUpperCase(), startSec, startUsec }
}

export function sameProcessGeneration(
  expected: Pick<ProcessIdentity, 'pid' | 'bootSession' | 'startSec' | 'startUsec'>,
  current: Pick<ProcessIdentity, 'pid' | 'bootSession' | 'startSec' | 'startUsec'>,
): boolean {
  return expected.pid === current.pid
    && expected.bootSession === current.bootSession
    && expected.startSec === current.startSec
    && expected.startUsec === current.startUsec
}

function systemBootSession(): string | undefined {
  if (process.platform !== 'darwin') {
    return undefined
  }
  const result = Bun.spawnSync(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'], {
    env: { PATH: '/usr/sbin:/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 2_000,
    killSignal: 'SIGKILL',
  })
  const value = result.exitCode === 0 ? result.stdout.toString().trim().toUpperCase() : ''
  return /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(value)
    ? value
    : undefined
}

/**
 * Return the current boot identity. A transient sysctl failure is deliberately
 * not cached: one failed probe must not disable generation checks for the
 * lifetime of a long-running runner.
 */
export function readBootSession(
  probe: () => string | undefined = systemBootSession,
): string | undefined {
  if (cachedBootSession !== undefined) return cachedBootSession
  const value = probe()?.trim().toUpperCase()
  if (!value || !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(value)) {
    return undefined
  }
  cachedBootSession = value
  return cachedBootSession
}

/** Test-only cache reset; production callers never need to invalidate a boot UUID. */
export function resetBootSessionCacheForTests(): void {
  cachedBootSession = undefined
}

function rawProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!libproc || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  const session = readBootSession()
  if (!session) return undefined
  const buffer = new Uint8Array(PROC_BSDINFO_SIZE)
  const size = libproc.symbols.proc_pidinfo(
    pid, PROC_PIDTBSDINFO, 0n, buffer, buffer.byteLength,
  )
  if (size !== PROC_BSDINFO_SIZE) return undefined
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const observedPid = view.getUint32(PROC_PID_OFFSET, true)
  const ppid = view.getUint32(PROC_PPID_OFFSET, true)
  const uid = view.getUint32(PROC_UID_OFFSET, true)
  const pgid = view.getUint32(PROC_PGID_OFFSET, true)
  const status = view.getUint32(PROC_STATUS_OFFSET, true)
  const startSecBig = view.getBigUint64(PROC_START_SEC_OFFSET, true)
  const startUsecBig = view.getBigUint64(PROC_START_USEC_OFFSET, true)
  if (observedPid !== pid
    || startSecBig > BigInt(Number.MAX_SAFE_INTEGER)
    || startUsecBig > 999_999n) return undefined
  const startSec = Number(startSecBig)
  const startUsec = Number(startUsecBig)
  if (startSec <= 0 || pgid <= 0) return undefined
  return {
    pid: observedPid,
    ppid,
    pgid,
    status,
    uid,
    bootSession: session,
    startSec,
    startUsec,
    started: processStartKey({ bootSession: session, startSec, startUsec }),
  }
}

export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  const identity = rawProcessIdentity(pid)
  return identity?.status === ZOMBIE_STATUS ? undefined : identity
}

export async function acquireProcessGroupLeaderIdentity(
  pid: number,
  identityReader: (pid: number) => ProcessIdentity | undefined = readProcessIdentity,
  attempts = 100,
  retryMs = 10,
): Promise<ProcessIdentity | undefined> {
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const identity = identityReader(pid)
    if (identity?.pid === pid && identity.pgid === pid) return identity
    if (attempt + 1 < attempts) await Bun.sleep(Math.max(1, retryMs))
  }
  return undefined
}

function pidProbe(pid: number): 'alive' | 'missing' | 'unknown' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'missing' : 'unknown'
  }
}

export function observeProcessGeneration(
  expected: Pick<ProcessIdentity, 'pid' | 'bootSession' | 'startSec' | 'startUsec'>,
): ProcessGenerationProbe {
  const firstProbe = pidProbe(expected.pid)
  if (firstProbe === 'missing') return { status: 'dead', reason: 'missing' }
  if (firstProbe === 'unknown') return { status: 'unknown' }
  let current = rawProcessIdentity(expected.pid)
  for (let attempt = 0; !current && attempt < 2; attempt += 1) {
    Bun.sleepSync(1)
    current = rawProcessIdentity(expected.pid)
  }
  if (!current) {
    const secondProbe = pidProbe(expected.pid)
    if (secondProbe === 'missing') return { status: 'dead', reason: 'missing' }
    const state = Bun.spawnSync(['/bin/ps', '-o', 'state=', '-p', String(expected.pid)], {
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 1_000,
      killSignal: 'SIGKILL',
    })
    const value = state.exitCode === 0 ? state.stdout.toString().trim().toUpperCase() : ''
    if (value.startsWith('Z')) return { status: 'dead', reason: 'zombie' }
    if (state.exitCode !== 0 && pidProbe(expected.pid) === 'missing') {
      return { status: 'dead', reason: 'missing' }
    }
    return { status: 'unknown' }
  }
  if (current.status === ZOMBIE_STATUS) return { status: 'dead', reason: 'zombie' }
  if (!sameProcessGeneration(expected, current)) return { status: 'dead', reason: 'reused' }
  return { status: 'alive', identity: current }
}

export function processIdentityIsLive(expected: ProcessIdentity): boolean {
  return observeProcessGeneration(expected).status === 'alive'
}

export function processIdentityIsStopped(identity: Pick<ProcessIdentity, 'status'>): boolean {
  return identity.status === STOPPED_STATUS
}

export function readProcessTable(): ProcessIdentity[] {
  if (!libproc) throw new Error('Darwin process table is unavailable')
  let capacity = INITIAL_PID_CAPACITY
  while (true) {
    const pids = new Int32Array(capacity)
    const count = libproc.symbols.proc_listallpids(pids, pids.byteLength)
    if (count <= 0) throw new Error('process tableを取得できません')
    if (count >= capacity) {
      if (capacity >= MAX_PID_CAPACITY) throw new Error('process tableが上限を超えました')
      capacity = Math.min(capacity * 2, MAX_PID_CAPACITY)
      continue
    }
    const table: ProcessIdentity[] = []
    for (let index = 0; index < count; index += 1) {
      const pid = pids[index]!
      if (pid <= 1) continue
      const identity = rawProcessIdentity(pid)
      // libproc lists protected system processes and processes that can exit
      // before the per-PID read. Critical tracked PIDs are re-probed directly
      // by the reaper, so omitting an unreadable unrelated entry is safe.
      if (identity && identity.status !== ZOMBIE_STATUS) table.push(identity)
    }
    return table
  }
}

export function signalProcessIfLive(
  expected: ProcessIdentity,
  signal: NodeJS.Signals,
): boolean {
  if (observeProcessGeneration(expected).status !== 'alive') return false
  try {
    process.kill(expected.pid, signal)
    return true
  } catch {
    return false
  }
}

/** Pure signal-time decision used by delayed-KILL contract tests. */
export function processGroupSignalAllowed(
  expectedLeader: ProcessIdentity,
  current: ProcessIdentity | undefined,
): boolean {
  return Boolean(current
    && sameProcessGeneration(expectedLeader, current)
    && current.pid === expectedLeader.pid
    && current.pgid === expectedLeader.pid)
}

export function signalProcessGroupIfLeaderLive(
  expectedLeader: ProcessIdentity,
  signal: NodeJS.Signals,
): boolean {
  if (process.platform === 'win32' || expectedLeader.pid <= 1) return false
  const observation = observeProcessGeneration(expectedLeader)
  if (observation.status !== 'alive'
    || !processGroupSignalAllowed(expectedLeader, observation.identity)) return false
  try {
    process.kill(-expectedLeader.pid, signal)
    return true
  } catch {
    return false
  }
}

export type ExactProcessStopResult = 'stopped' | 'unavailable' | 'timeout'

function processCommandMatches(pid: number, pattern: RegExp): boolean | undefined {
  const result = Bun.spawnSync(
    ['/bin/ps', '-ww', '-o', 'command=', '-p', String(pid)],
    {
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 2_000,
      killSignal: 'SIGKILL',
    },
  )
  if (result.exitCode !== 0) return undefined
  return new RegExp(pattern.source, pattern.flags).test(result.stdout.toString())
}

/** Stop a matching command without ever following a recycled numeric PID. */
export async function stopMatchingProcess(
  pid: number,
  commandPattern: RegExp,
  timeoutMs = 30_000,
): Promise<ExactProcessStopResult> {
  if (!Number.isSafeInteger(pid) || pid <= 1
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return 'unavailable'
  if (processCommandMatches(pid, commandPattern) !== true) return 'unavailable'
  const expected = readProcessIdentity(pid)
  if (!expected || processCommandMatches(pid, commandPattern) !== true) return 'unavailable'
  if (!signalProcessIfLive(expected, 'SIGTERM')) {
    return observeProcessGeneration(expected).status === 'dead' ? 'stopped' : 'unavailable'
  }
  const deadline = Date.now() + timeoutMs
  while (true) {
    const observation = observeProcessGeneration(expected)
    if (observation.status === 'dead') return 'stopped'
    if (observation.status === 'unknown') return 'unavailable'
    if (Date.now() >= deadline) return 'timeout'
    await Bun.sleep(50)
  }
}

if (import.meta.main) {
  const [command, pidValue, patternValue, timeoutValue] = process.argv.slice(2)
  if (command !== 'stop-matching' || !pidValue || !patternValue) {
    process.stderr.write(
      'usage: process-generation.ts stop-matching <pid> <command-pattern> [timeout-ms]\n',
    )
    process.exit(2)
  }
  try {
    const timeoutMs = timeoutValue === undefined ? 30_000 : Number(timeoutValue)
    const result = await stopMatchingProcess(
      Number(pidValue), new RegExp(patternValue), timeoutMs,
    )
    if (result !== 'stopped') {
      process.stderr.write(`exact process stop failed: ${result}\n`)
      process.exitCode = 3
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
