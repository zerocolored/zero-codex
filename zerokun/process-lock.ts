import { randomUUID } from 'crypto'
import { dlopen, FFIType } from 'bun:ffi'
import {
  closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'fs'
import { basename, dirname, join } from 'path'

export type ProcessLockLease = {
  version: 2
  pid: number
  /** Legacy /bin/ps representation retained for the updater loaded before a self-update. */
  started: string
  /** Locale-independent owner identity used by current code. */
  canonicalStarted: string
  nonce: string
  device: number
  inode: number
}

export type ProcessLockInspection =
  | { status: 'missing' }
  | { status: 'active'; pid: number }
  | { status: 'stale'; pid: number }
  | { status: 'unknown'; pid?: number }

export type ProcessLockAttempt =
  | { acquired: true; lease: ProcessLockLease; previousPid?: number }
  | { acquired: false; kind: 'held'; heldPid: number }
  | { acquired: false; kind: 'owner-unavailable' }

export type ProcessProbe =
  | { status: 'alive'; started: string }
  | { status: 'dead'; reason: 'missing' | 'zombie' | 'reused' }
  | { status: 'unknown' }

type LockSnapshot = {
  pid: number
  raw: string
  device: number
  inode: number
  links: number
}
type LegacyIdentity = { pid: number; started: string; nonce: string }
type ParsedIdentity = ProcessLockLease | LegacyIdentity
type LockRead =
  | { kind: 'missing' }
  | { kind: 'valid'; snapshot: LockSnapshot }
  | { kind: 'unavailable' }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OWNER_PATTERN = /^(?:0*[1-9][0-9]*)\n?$/
const MAX_OWNER_BYTES = 64
const MAX_IDENTITY_BYTES = 4096
const MUTATION_GUARD_WAIT_MS = 100
const MUTATION_GUARD_DELAY_MS = 1
const MUTATION_RELEASE_GUARD_WAIT_MS = 5_000
const PROCESS_PROBE_TIMEOUT_MS = 2_000
const PS_ENV = { PATH: '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C', LANG: 'C' }

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8
const libSystem = dlopen('/usr/lib/libSystem.B.dylib', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})

function ownerMatches(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid()
}

function identityPath(lockFile: string): string {
  return `${lockFile}.identity`
}

function guardPath(lockFile: string): string {
  return `${lockFile}.guard`
}

function parseOwner(raw: string): number | undefined {
  if (!OWNER_PATTERN.test(raw)) return undefined
  const pid = Number(raw.trim())
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function readLock(lockFile: string, allowedLinks: 1 | 2 = 1): LockRead {
  let descriptor: number
  try {
    descriptor = openSync(lockFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unavailable' }
  }
  try {
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || !ownerMatches(metadata.uid)
      || metadata.nlink < 1 || metadata.nlink > allowedLinks
      || metadata.size <= 0 || metadata.size > MAX_OWNER_BYTES) {
      return { kind: 'unavailable' }
    }
    if (metadata.nlink === 1) {
      fchmodSync(descriptor, 0o600)
    } else if ((metadata.mode & 0o077) !== 0) {
      return { kind: 'unavailable' }
    }
    const raw = readFileSync(descriptor, 'utf8')
    const pid = parseOwner(raw)
    if (pid === undefined) return { kind: 'unavailable' }
    return {
      kind: 'valid',
      snapshot: {
        pid,
        raw,
        device: metadata.dev,
        inode: metadata.ino,
        links: metadata.nlink,
      },
    }
  } catch {
    return { kind: 'unavailable' }
  } finally {
    closeSync(descriptor)
  }
}

function sameSnapshot(lockFile: string, expected: LockSnapshot): boolean {
  const current = readLock(lockFile, expected.links === 2 ? 2 : 1)
  return current.kind === 'valid'
    && current.snapshot.pid === expected.pid
    && current.snapshot.raw === expected.raw
    && current.snapshot.device === expected.device
    && current.snapshot.inode === expected.inode
    && current.snapshot.links === expected.links
}

function parseIdentity(raw: string): ParsedIdentity | undefined {
  if (raw.length === 0 || raw.length > MAX_IDENTITY_BYTES) return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { return undefined }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
    || typeof record.started !== 'string' || record.started.length === 0
    || record.started.length > 128
    || typeof record.nonce !== 'string' || !UUID_PATTERN.test(record.nonce)) return undefined
  if (record.version === 2) {
    if (typeof record.canonicalStarted !== 'string' || record.canonicalStarted.length === 0
      || record.canonicalStarted.length > 128
      || !Number.isSafeInteger(record.device) || (record.device as number) < 0
      || !Number.isSafeInteger(record.inode) || (record.inode as number) <= 0) return undefined
    return {
      version: 2,
      pid: record.pid as number,
      started: record.started,
      canonicalStarted: record.canonicalStarted,
      nonce: record.nonce,
      device: record.device as number,
      inode: record.inode as number,
    }
  }
  if ('version' in record || 'device' in record || 'inode' in record) return undefined
  return {
    pid: record.pid as number,
    started: record.started,
    nonce: record.nonce,
  }
}

function readIdentity(lockFile: string): ParsedIdentity | undefined {
  const path = identityPath(lockFile)
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch { return undefined }
  try {
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches(metadata.uid)
      || metadata.size <= 0 || metadata.size > MAX_IDENTITY_BYTES) return undefined
    fchmodSync(descriptor, 0o600)
    return parseIdentity(readFileSync(descriptor, 'utf8'))
  } catch { return undefined } finally { closeSync(descriptor) }
}

function readIdentityForSnapshot(lockFile: string, snapshot: LockSnapshot): ParsedIdentity | undefined {
  const identity = readIdentity(lockFile)
  if (!identity || identity.pid !== snapshot.pid) return undefined
  if ('version' in identity
    && (identity.device !== snapshot.device || identity.inode !== snapshot.inode)) return undefined
  return identity
}

function processStartedLegacy(
  pid: number,
  environment: Record<string, string | undefined> = process.env,
): string {
  const result = Bun.spawnSync(
    ['/bin/ps', '-o', 'lstart=', '-p', String(pid)],
    {
      stdout: 'pipe', stderr: 'ignore', env: environment,
      timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
    },
  )
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : ''
}

/** Pure classifier used by deterministic contract tests. */
export function classifyProcessProbe(
  killResult: 'alive' | 'esrch' | 'unknown',
  psExitCode: number,
  psOutput: string,
  expectedStarted?: string,
): ProcessProbe {
  if (killResult === 'esrch') return { status: 'dead', reason: 'missing' }
  if (killResult === 'unknown' || psExitCode !== 0) return { status: 'unknown' }
  const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(psOutput)
  if (!match) return { status: 'unknown' }
  const state = match[1].toUpperCase()
  const started = match[2]
  if (state.startsWith('Z')) return { status: 'dead', reason: 'zombie' }
  if (expectedStarted !== undefined && started !== expectedStarted) {
    return { status: 'dead', reason: 'reused' }
  }
  return { status: 'alive', started }
}

function observeProcess(pid: number, expectedStarted?: string): ProcessProbe {
  try { process.kill(pid, 0) } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
      ? { status: 'dead', reason: 'missing' }
      : { status: 'unknown' }
  }
  const result = Bun.spawnSync(
    ['/bin/ps', '-o', 'state=', '-o', 'lstart=', '-p', String(pid)],
    {
      stdout: 'pipe', stderr: 'ignore', env: PS_ENV,
      timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
    },
  )
  return classifyProcessProbe(
    'alive', result.exitCode, new TextDecoder().decode(result.stdout), expectedStarted,
  )
}

function writeIdentity(lockFile: string, identity: ProcessLockLease): void {
  if (!parseIdentity(JSON.stringify(identity))) {
    throw new Error(`invalid process lock identity: ${lockFile}`)
  }
  const path = identityPath(lockFile)
  const temporary = `${path}.${identity.pid}.${identity.nonce}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(identity)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch {}
  }
}

function candidatePath(lockFile: string, pid: number, nonce: string): string {
  return `${lockFile}.candidate-${pid}-${nonce}`
}

function finishInterruptedPublication(lockFile: string, snapshot: LockSnapshot): LockSnapshot | undefined {
  if (snapshot.links === 1) return snapshot
  const directory = dirname(lockFile)
  const prefix = `${basename(lockFile)}.candidate-${snapshot.pid}-`
  const identity = readIdentityForSnapshot(lockFile, snapshot)
  const expectedName = identity && 'version' in identity
    ? basename(candidatePath(lockFile, snapshot.pid, identity.nonce))
    : undefined
  let matches: string[]
  try {
    matches = readdirSync(directory).filter(name => {
      if (!name.startsWith(prefix)) return false
      const nonce = name.slice(prefix.length)
      if (!UUID_PATTERN.test(nonce) || (expectedName && name !== expectedName)) return false
      try {
        const metadata = lstatSync(`${directory}/${name}`)
        return metadata.isFile() && !metadata.isSymbolicLink() && ownerMatches(metadata.uid)
          && metadata.nlink === 2 && (metadata.mode & 0o077) === 0
          && metadata.dev === snapshot.device && metadata.ino === snapshot.inode
      } catch { return false }
    })
  } catch { return undefined }
  if (matches.length !== 1 || !sameSnapshot(lockFile, snapshot)) return undefined
  try { unlinkSync(`${directory}/${matches[0]}`) } catch { return undefined }
  const normalized = readLock(lockFile)
  return normalized.kind === 'valid'
    && normalized.snapshot.pid === snapshot.pid
    && normalized.snapshot.raw === snapshot.raw
    && normalized.snapshot.device === snapshot.device
    && normalized.snapshot.inode === snapshot.inode
    ? normalized.snapshot
    : undefined
}

function withMutationGuard<T>(
  lockFile: string,
  action: () => T,
  wait: 'bounded' | 'release' = 'bounded',
): T | undefined {
  let descriptor: number
  try {
    descriptor = openSync(
      guardPath(lockFile),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    )
  } catch { return undefined }
  let locked = false
  try {
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches(metadata.uid)) return undefined
    fchmodSync(descriptor, 0o600)
    const waitMs = wait === 'release'
      ? MUTATION_RELEASE_GUARD_WAIT_MS
      : MUTATION_GUARD_WAIT_MS
    const deadline = performance.now() + waitMs
    while (true) {
      if (libSystem.symbols.flock(descriptor, LOCK_EX | LOCK_NB) === 0) {
        locked = true
        return action()
      }
      if (performance.now() >= deadline) return undefined
      Bun.sleepSync(MUTATION_GUARD_DELAY_MS)
    }
  } finally {
    if (locked) libSystem.symbols.flock(descriptor, LOCK_UN)
    closeSync(descriptor)
  }
}

function removeIdentity(lockFile: string): void {
  try { unlinkSync(identityPath(lockFile)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function updaterLockPath(lockFile: string): string | undefined {
  const direct = join(dirname(lockFile), 'update.lock', 'pid')
  const parent = join(dirname(dirname(lockFile)), 'update.lock', 'pid')
  for (const candidate of [direct, parent]) {
    if (candidate !== lockFile && readLock(candidate).kind === 'valid') return candidate
  }
  return undefined
}

function legacyStartedForPublication(
  lockFile: string,
  pid: number,
): string {
  const fallback = processStartedLegacy(pid)
  const updaterPath = updaterLockPath(lockFile)
  if (!updaterPath) return fallback
  const updater = readLock(updaterPath)
  if (updater.kind !== 'valid') return fallback
  const identity = readIdentityForSnapshot(updaterPath, updater.snapshot)
  if (!identity) return fallback
  // Current updaters validate canonicalStarted and need no legacy bridge.
  if ('version' in identity) return fallback
  // A loaded legacy updater compares ambient ps text. Re-rendering its own
  // start time in the candidate environment proves both processes use the
  // same timezone rules, including a DST transition between their starts.
  const updaterAmbientStarted = processStartedLegacy(identity.pid)
  return updaterAmbientStarted === identity.started ? fallback : ''
}

function publishLock(lockFile: string, pid: number): ProcessLockLease {
  const observation = observeProcess(pid)
  if (observation.status !== 'alive') throw new Error(`cannot identify lock owner PID ${pid}`)
  const nonce = randomUUID()
  const candidate = candidatePath(lockFile, pid, nonce)
  writeFileSync(candidate, `${pid}\n`, { mode: 0o600, flag: 'wx' })
  let linked = false
  try {
    const metadata = lstatSync(candidate)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || !ownerMatches(metadata.uid) || (metadata.mode & 0o077) !== 0) {
      throw new Error(`unsafe process lock candidate: ${candidate}`)
    }
    const legacyStarted = legacyStartedForPublication(lockFile, pid)
    if (!legacyStarted) throw new Error(`cannot identify legacy lock owner PID ${pid}`)
    const lease: ProcessLockLease = {
      version: 2,
      pid,
      started: legacyStarted,
      canonicalStarted: observation.started,
      nonce,
      device: metadata.dev,
      inode: metadata.ino,
    }
    writeIdentity(lockFile, lease)
    linkSync(candidate, lockFile)
    linked = true
    try {
      unlinkSync(candidate)
    } catch (cleanupError) {
      // A post-link failure must not strand a live owner without its lease.
      // Roll back main first; if that is impossible, return the local lease so
      // the caller can still release the exact inode later.
      try { unlinkSync(lockFile) } catch { return lease }
      removeIdentity(lockFile)
      throw cleanupError
    }
    return lease
  } catch (error) {
    if (!linked) removeIdentity(lockFile)
    throw error
  } finally {
    try { unlinkSync(candidate) } catch {}
  }
}

function identityMatchesLease(identity: ParsedIdentity | undefined, lease: ProcessLockLease): boolean {
  return Boolean(identity && 'version' in identity
    && identity.pid === lease.pid && identity.started === lease.started
    && identity.canonicalStarted === lease.canonicalStarted
    && identity.nonce === lease.nonce && identity.device === lease.device
    && identity.inode === lease.inode)
}

export function processLockOwnerMatches(
  lockFile: string,
  expectedPid: number,
  commandPattern: RegExp,
): boolean {
  const read = readLock(lockFile)
  if (read.kind !== 'valid' || read.snapshot.pid !== expectedPid) return false
  const identity = readIdentityForSnapshot(lockFile, read.snapshot)
  if (!identity) return false
  const observation = observeProcess(
    expectedPid, 'version' in identity ? identity.canonicalStarted : undefined,
  )
  if (observation.status !== 'alive') return false
  if (!('version' in identity) && identity.started !== processStartedLegacy(expectedPid)) return false
  const command = Bun.spawnSync(
    ['/bin/ps', '-ww', '-o', 'command=', '-p', String(expectedPid)],
    {
      stdout: 'pipe', stderr: 'ignore', env: PS_ENV,
      timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
    },
  )
  return command.exitCode === 0 && commandPattern.test(new TextDecoder().decode(command.stdout))
}

/** Bind a legacy lock to the exact currently-running script and inode. */
export function adoptLegacyProcessIdentity(
  lockFile: string,
  expectedPid: number,
  expectedFragments: string[],
): void {
  const adopted = withMutationGuard(lockFile, () => {
    const read = readLock(lockFile)
    if (read.kind !== 'valid' || read.snapshot.pid !== expectedPid) return false
    const observation = observeProcess(expectedPid)
    if (observation.status !== 'alive') return false
    const processInfo = Bun.spawnSync(
      ['/bin/ps', '-ww', '-o', 'command=', '-p', String(expectedPid)],
      {
        stdout: 'pipe', stderr: 'ignore', env: PS_ENV,
        timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
      },
    )
    const command = processInfo.exitCode === 0 ? new TextDecoder().decode(processInfo.stdout) : ''
    if (!command || expectedFragments.some(fragment => !command.includes(fragment))) return false
    const legacyStarted = processStartedLegacy(expectedPid)
    if (!legacyStarted) return false
    const identity: ProcessLockLease = {
      version: 2,
      pid: expectedPid,
      started: legacyStarted,
      canonicalStarted: observation.started,
      nonce: randomUUID(),
      device: read.snapshot.device,
      inode: read.snapshot.inode,
    }
    if (!sameSnapshot(lockFile, read.snapshot)) return false
    writeIdentity(lockFile, identity)
    return true
  }, 'release')
  if (adopted !== true) throw new Error(`unsafe legacy process lock: ${lockFile}`)
}

/** Remove only a definitely dead/reused owner while holding the OS mutation guard. */
export function discardProcessLock(lockFile: string, expectedPid: number): boolean {
  return withMutationGuard(lockFile, () => {
    const initial = readLock(lockFile, 2)
    if (initial.kind !== 'valid' || initial.snapshot.pid !== expectedPid) return false
    const snapshot = finishInterruptedPublication(lockFile, initial.snapshot)
    if (!snapshot) return false
    const identity = readIdentityForSnapshot(lockFile, snapshot)
    const observation = observeProcess(
      expectedPid, identity && 'version' in identity ? identity.canonicalStarted : undefined,
    )
    if (observation.status !== 'dead' || !sameSnapshot(lockFile, snapshot)) return false
    try { unlinkSync(lockFile) } catch { return false }
    removeIdentity(lockFile)
    return true
  }, 'release') ?? false
}

/** Publish a numeric PID lock and bind it to a nonce/start-time/inode lease. */
export function tryAcquireProcessLock(
  lockFile: string,
  currentPid = process.pid,
): ProcessLockAttempt {
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 })
  return withMutationGuard(lockFile, () => {
    const initial = readLock(lockFile, 2)
    if (initial.kind === 'unavailable') {
      return { acquired: false, kind: 'owner-unavailable' } as const
    }
    let previousPid: number | undefined
    if (initial.kind === 'valid') {
      const snapshot = finishInterruptedPublication(lockFile, initial.snapshot)
      if (!snapshot) return { acquired: false, kind: 'owner-unavailable' } as const
      const identity = readIdentityForSnapshot(lockFile, snapshot)
      const observation = observeProcess(
        snapshot.pid, identity && 'version' in identity ? identity.canonicalStarted : undefined,
      )
      if (observation.status === 'alive') {
        return { acquired: false, kind: 'held', heldPid: snapshot.pid } as const
      }
      if (observation.status === 'unknown' || !sameSnapshot(lockFile, snapshot)) {
        return { acquired: false, kind: 'owner-unavailable' } as const
      }
      try { unlinkSync(lockFile) } catch {
        return { acquired: false, kind: 'owner-unavailable' } as const
      }
      removeIdentity(lockFile)
      previousPid = snapshot.pid
    }
    const lease = publishLock(lockFile, currentPid)
    return previousPid === undefined
      ? { acquired: true, lease } as const
      : { acquired: true, lease, previousPid } as const
  }) ?? { acquired: false, kind: 'owner-unavailable' }
}

export function releaseProcessLock(lockFile: string, lease: ProcessLockLease): boolean {
  return withMutationGuard(lockFile, () => {
    const initial = readLock(lockFile, 2)
    if (initial.kind !== 'valid') return false
    const snapshot = initial.snapshot
    if (snapshot.pid !== lease.pid
      || snapshot.device !== lease.device || snapshot.inode !== lease.inode
      || !identityMatchesLease(readIdentityForSnapshot(lockFile, snapshot), lease)) return false
    if (!sameSnapshot(lockFile, snapshot)) return false
    try { unlinkSync(lockFile) } catch { return false }
    removeIdentity(lockFile)
    return true
  }, 'release') ?? false
}

/** Inspect a process lock without reclaiming it. Unknown input stays fail-closed. */
export function inspectProcessLock(
  lockFile: string,
  legacyCommandPattern?: RegExp,
): ProcessLockInspection {
  const read = readLock(lockFile, 2)
  if (read.kind === 'missing') return { status: 'missing' }
  if (read.kind === 'unavailable') return { status: 'unknown' }
  const identity = readIdentityForSnapshot(lockFile, read.snapshot)
  if (!identity) {
    const observation = observeProcess(read.snapshot.pid)
    if (observation.status === 'dead') return { status: 'stale', pid: read.snapshot.pid }
    if (observation.status === 'unknown' || !legacyCommandPattern) {
      return { status: 'unknown', pid: read.snapshot.pid }
    }
    const command = Bun.spawnSync(
      ['/bin/ps', '-ww', '-o', 'command=', '-p', String(read.snapshot.pid)],
      {
        stdout: 'pipe', stderr: 'ignore', env: PS_ENV,
        timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
      },
    )
    if (command.exitCode !== 0) return { status: 'unknown', pid: read.snapshot.pid }
    return legacyCommandPattern.test(new TextDecoder().decode(command.stdout))
      ? { status: 'active', pid: read.snapshot.pid }
      : { status: 'stale', pid: read.snapshot.pid }
  }
  const observation = observeProcess(
    read.snapshot.pid,
    'version' in identity ? identity.canonicalStarted : undefined,
  )
  if (observation.status === 'dead') return { status: 'stale', pid: read.snapshot.pid }
  if (observation.status === 'unknown') return { status: 'unknown', pid: read.snapshot.pid }
  if (!('version' in identity)) {
    const legacyStarted = processStartedLegacy(read.snapshot.pid)
    if (!legacyStarted) return { status: 'unknown', pid: read.snapshot.pid }
    if (legacyStarted !== identity.started) {
      if (!legacyCommandPattern) return { status: 'unknown', pid: read.snapshot.pid }
      const command = Bun.spawnSync(
        ['/bin/ps', '-ww', '-o', 'command=', '-p', String(read.snapshot.pid)],
        {
          stdout: 'pipe', stderr: 'ignore', env: PS_ENV,
          timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
        },
      )
      if (command.exitCode !== 0) return { status: 'unknown', pid: read.snapshot.pid }
      return legacyCommandPattern.test(new TextDecoder().decode(command.stdout))
        ? { status: 'active', pid: read.snapshot.pid }
        : { status: 'stale', pid: read.snapshot.pid }
    }
  }
  return { status: 'active', pid: read.snapshot.pid }
}

function encodeLease(lease: ProcessLockLease): string {
  return Buffer.from(JSON.stringify(lease)).toString('base64url')
}

function decodeLease(value: string): ProcessLockLease | undefined {
  try {
    const parsed = parseIdentity(Buffer.from(value, 'base64url').toString('utf8'))
    return parsed && 'version' in parsed ? parsed : undefined
  } catch { return undefined }
}

if (import.meta.main) {
  const [command, lockFile, owner] = process.argv.slice(2)
  if (!lockFile || !owner || (command !== 'acquire' && command !== 'release')) {
    process.stderr.write(
      'usage: process-lock.ts acquire <lock-file> <pid> | release <lock-file> <lease-token>\n',
    )
    process.exit(2)
  }
  try {
    if (command === 'acquire') {
      const pid = Number(owner)
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid PID: ${owner}`)
      const result = tryAcquireProcessLock(lockFile, pid)
      if (result.acquired) {
        process.stdout.write(`${encodeLease(result.lease)}\n`)
      } else {
        if (result.kind === 'held') process.stdout.write(`${result.heldPid}\n`)
        process.exitCode = 3
      }
    } else {
      const lease = decodeLease(owner)
      if (!lease) throw new Error('invalid process lock lease token')
      if (!releaseProcessLock(lockFile, lease)) process.exitCode = 3
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
