import { randomUUID } from 'crypto'
import { dlopen, FFIType } from 'bun:ffi'
import {
  closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'fs'
import { basename, dirname, join } from 'path'
import {
  observeProcessGeneration,
  readBootSession,
  readProcessIdentity as readDarwinProcessIdentity,
  sameProcessGeneration,
  signalProcessIfLive,
  type ProcessIdentity as DarwinProcessIdentity,
} from './process-generation.ts'

type PreciseProcessGeneration = {
  bootSession: string
  startSec: number
  startUsec: number
}

export type ProcessLockLease = {
  /** v2 is read for an already-running pre-upgrade owner; new owners publish v3. */
  version: 2 | 3
  pid: number
  /** Legacy /bin/ps representation retained for the updater loaded before a self-update. */
  started: string
  /** Locale-independent owner identity used by current code. */
  canonicalStarted: string
  nonce: string
  device: number
  inode: number
  /** Required by v3; optional only while interoperating with an in-flight v2 owner. */
  bootSession?: string
  startSec?: number
  startUsec?: number
}

export type ProcessLockDelegate = {
  pid: number
  canonicalStarted: string
  nonce: string
  /** Present only after this PID was proven to be its process-group leader. */
  groupId?: number
  bootSession?: string
  startSec?: number
  startUsec?: number
  participant?: PreciseProcessGeneration & { pid: number }
  /** Restore a clean in-flight v2 owner after temporary v3 poison protection. */
  leaseVersion?: 2 | 3
  /** Cleanup uncertainty is durable and must never be auto-reclaimed. */
  blocked?: true
  /** Write-ahead teardown intent; the exact holder may clear it after a clean reap. */
  cleanupPending?: true
  /** The delegated leader proved its trusted process group was empty. */
  quiescent?: true
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
  | ({ status: 'alive'; started: string } & Partial<PreciseProcessGeneration>)
  | { status: 'dead'; reason: 'missing' | 'zombie' | 'reused' }
  | { status: 'unknown' }

export type ProcessGroupProbe =
  | { status: 'alive' }
  | { status: 'dead' }
  | { status: 'unknown' }

type LockSnapshot = {
  pid: number
  raw: string
  device: number
  inode: number
  links: number
}
type LegacyIdentity = { pid: number; started: string; nonce: string }
type ProcessLockIdentity = ProcessLockLease & { delegate?: ProcessLockDelegate }
type ParsedIdentity = ProcessLockIdentity | LegacyIdentity
type LockRead =
  | { kind: 'missing' }
  | { kind: 'valid'; snapshot: LockSnapshot }
  | { kind: 'unavailable' }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BOOT_SESSION_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const OWNER_PATTERN = /^(?:0*[1-9][0-9]*)\n?$/
const MAX_OWNER_BYTES = 64
const MAX_IDENTITY_BYTES = 4096
const MUTATION_GUARD_WAIT_MS = 100
const MUTATION_GUARD_DELAY_MS = 1
const MUTATION_RELEASE_GUARD_WAIT_MS = 5_000
const PROCESS_PROBE_TIMEOUT_MS = 2_000
const PS_ENV = { PATH: '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C', LANG: 'C' }
export const UPDATE_LOCK_OWNER_PATTERN = /(?:update\.ts|zerokun-update|setup\.sh)/

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

function parsePreciseGeneration(
  record: Record<string, unknown>,
): PreciseProcessGeneration | undefined | null {
  const present = [record.bootSession, record.startSec, record.startUsec]
    .filter(value => value !== undefined).length
  if (present === 0) return undefined
  if (present !== 3
    || typeof record.bootSession !== 'string'
    || !BOOT_SESSION_PATTERN.test(record.bootSession)
    || !Number.isSafeInteger(record.startSec) || (record.startSec as number) <= 0
    || !Number.isSafeInteger(record.startUsec) || (record.startUsec as number) < 0
    || (record.startUsec as number) > 999_999) return null
  return {
    bootSession: record.bootSession.toUpperCase(),
    startSec: record.startSec as number,
    startUsec: record.startUsec as number,
  }
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
  if (record.version === 2 || record.version === 3) {
    if (typeof record.canonicalStarted !== 'string' || record.canonicalStarted.length === 0
      || record.canonicalStarted.length > 128
      || !Number.isSafeInteger(record.device) || (record.device as number) < 0
      || !Number.isSafeInteger(record.inode) || (record.inode as number) <= 0) return undefined
    const precise = parsePreciseGeneration(record)
    if (precise === null || (record.version === 3 && !precise)) return undefined
    let delegate: ProcessLockDelegate | undefined
    if (record.delegate !== undefined) {
      if (!record.delegate || typeof record.delegate !== 'object') return undefined
      const candidate = record.delegate as Record<string, unknown>
      if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) <= 0
        || typeof candidate.canonicalStarted !== 'string'
        || candidate.canonicalStarted.length === 0
        || candidate.canonicalStarted.length > 128
        || typeof candidate.nonce !== 'string'
        || !UUID_PATTERN.test(candidate.nonce)) return undefined
      if (candidate.groupId !== undefined
        && (!Number.isSafeInteger(candidate.groupId) || (candidate.groupId as number) <= 1
          || candidate.groupId !== candidate.pid)) return undefined
      const delegatePrecise = parsePreciseGeneration(candidate)
      if (delegatePrecise === null
        || (record.version === 3 && !delegatePrecise)
        || (candidate.leaseVersion !== undefined
          && candidate.leaseVersion !== 2 && candidate.leaseVersion !== 3)
        || (record.version === 3 && candidate.leaseVersion === undefined)
        || (candidate.blocked !== undefined && candidate.blocked !== true)
        || (candidate.cleanupPending !== undefined && candidate.cleanupPending !== true)
        || (candidate.quiescent !== undefined && candidate.quiescent !== true)
        || ([candidate.blocked, candidate.cleanupPending, candidate.quiescent]
          .filter(value => value === true).length > 1)) return undefined
      let participant: ProcessLockDelegate['participant']
      if (candidate.participant !== undefined) {
        if (!candidate.participant || typeof candidate.participant !== 'object') return undefined
        const participantRecord = candidate.participant as Record<string, unknown>
        const participantPrecise = parsePreciseGeneration(participantRecord)
        if (!Number.isSafeInteger(participantRecord.pid)
          || (participantRecord.pid as number) <= 0 || !participantPrecise) return undefined
        participant = { pid: participantRecord.pid as number, ...participantPrecise }
      }
      delegate = {
        pid: candidate.pid as number,
        canonicalStarted: candidate.canonicalStarted,
        nonce: candidate.nonce,
        ...(delegatePrecise ? delegatePrecise : {}),
        ...(candidate.groupId === undefined
          ? {}
          : { groupId: candidate.groupId as number }),
        ...(participant ? { participant } : {}),
        ...(candidate.leaseVersion === 2 || candidate.leaseVersion === 3
          ? { leaseVersion: candidate.leaseVersion }
          : {}),
        ...(candidate.blocked === true ? { blocked: true as const } : {}),
        ...(candidate.cleanupPending === true ? { cleanupPending: true as const } : {}),
        ...(candidate.quiescent === true ? { quiescent: true as const } : {}),
      }
    }
    return {
      version: record.version,
      pid: record.pid as number,
      started: record.started,
      canonicalStarted: record.canonicalStarted,
      nonce: record.nonce,
      device: record.device as number,
      inode: record.inode as number,
      ...(precise ? precise : {}),
      ...(delegate ? { delegate } : {}),
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

function identityArtifactExists(lockFile: string): boolean {
  try {
    lstatSync(identityPath(lockFile))
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
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

function preciseExpected(
  pid: number,
  value: Partial<PreciseProcessGeneration>,
): DarwinProcessIdentity | undefined {
  if (typeof value.bootSession !== 'string'
    || !Number.isSafeInteger(value.startSec)
    || !Number.isSafeInteger(value.startUsec)) return undefined
  return {
    pid,
    ppid: 0,
    pgid: 0,
    status: 0,
    bootSession: value.bootSession,
    startSec: value.startSec!,
    startUsec: value.startUsec!,
    started: `${value.bootSession}:${value.startSec}:${String(value.startUsec).padStart(6, '0')}`,
  }
}

function observeProcess(
  pid: number,
  expectedStarted?: string,
  expectedGeneration?: Partial<PreciseProcessGeneration>,
): ProcessProbe {
  const expected = expectedGeneration ? preciseExpected(pid, expectedGeneration) : undefined
  const initial = expected
    ? observeProcessGeneration(expected)
    : (() => {
        const identity = readDarwinProcessIdentity(pid)
        if (identity) return { status: 'alive' as const, identity }
        try { process.kill(pid, 0) } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH'
            ? { status: 'dead' as const, reason: 'missing' as const }
            : { status: 'unknown' as const }
        }
        return { status: 'unknown' as const }
      })()
  if (initial.status === 'dead') return initial
  if (initial.status === 'unknown') return initial
  const result = Bun.spawnSync(
    ['/bin/ps', '-o', 'state=', '-o', 'lstart=', '-p', String(pid)],
    {
      stdout: 'pipe', stderr: 'ignore', env: PS_ENV,
      timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
    },
  )
  const classified = classifyProcessProbe(
    'alive', result.exitCode, new TextDecoder().decode(result.stdout),
    // Once a boot-session + microsecond generation is present it is the
    // authority. The legacy lstart string exists for the frozen v2 reader;
    // treating a mismatched compatibility field as PID reuse could reclaim a
    // lock whose exact process generation is still alive.
    expected ? undefined : expectedStarted,
  )
  if (classified.status !== 'alive') return classified
  const confirmed = readDarwinProcessIdentity(pid)
  if (!confirmed || !sameProcessGeneration(initial.identity, confirmed)) return { status: 'unknown' }
  return {
    ...classified,
    bootSession: confirmed.bootSession,
    startSec: confirmed.startSec,
    startUsec: confirmed.startUsec,
  }
}

/** Pure classifier used by deterministic process-group lease tests. */
export function classifyProcessGroupProbe(
  killResult: 'alive' | 'esrch' | 'unknown',
): ProcessGroupProbe {
  if (killResult === 'alive') return { status: 'alive' }
  if (killResult === 'esrch') return { status: 'dead' }
  return { status: 'unknown' }
}

/**
 * Signal 0 asks the kernel whether a process-group generation still exists.
 * POSIX forbids PGID reuse until that group's lifetime ends. This probe keeps
 * a leaderless generation covered; a separately confirmed leader PID reuse
 * proves that the old generation has already ended.
 */
function observeProcessGroup(groupId: number): ProcessGroupProbe {
  if (!Number.isSafeInteger(groupId) || groupId <= 1) return { status: 'unknown' }
  try {
    process.kill(-groupId, 0)
    return classifyProcessGroupProbe('alive')
  } catch (error) {
    return classifyProcessGroupProbe(
      (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'esrch' : 'unknown',
    )
  }
}

function writeIdentity(lockFile: string, identity: ProcessLockIdentity): void {
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
  try {
    const parent = lstatSync(dirname(lockFile))
    if (!parent.isDirectory() || parent.isSymbolicLink() || !ownerMatches(parent.uid)
      || (parent.mode & 0o022) !== 0) return undefined
  } catch {
    return undefined
  }
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

function prepareLockParent(lockFile: string): boolean {
  const parentPath = dirname(lockFile)
  try {
    lstatSync(parentPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    try {
      const grandparent = lstatSync(dirname(parentPath))
      if (!grandparent.isDirectory() || grandparent.isSymbolicLink()
        || !ownerMatches(grandparent.uid) || (grandparent.mode & 0o022) !== 0) return false
      mkdirSync(parentPath, { mode: 0o700 })
    } catch {
      return false
    }
  }
  try {
    const parent = lstatSync(parentPath)
    return parent.isDirectory() && !parent.isSymbolicLink()
      && ownerMatches(parent.uid) && (parent.mode & 0o022) === 0
  } catch {
    return false
  }
}

function removeIdentity(lockFile: string): void {
  try { unlinkSync(identityPath(lockFile)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

type UpdaterLockLookup =
  | { kind: 'missing' }
  | { kind: 'valid'; path: string; snapshot: LockSnapshot }
  | { kind: 'unavailable' }

function updaterLock(lockFile: string): UpdaterLockLookup {
  const direct = join(dirname(lockFile), 'update.lock', 'pid')
  const parent = join(dirname(dirname(lockFile)), 'update.lock', 'pid')
  for (const candidate of [direct, parent]) {
    if (candidate === lockFile) continue
    // A crash after link(2) but before candidate cleanup leaves nlink=2.
    // Read that stable inode without mutating the updater lock so service
    // publication can still classify a definitely dead/reused legacy owner.
    const read = readLock(candidate, 2)
    if (read.kind === 'valid') return { kind: 'valid', path: candidate, snapshot: read.snapshot }
    if (read.kind === 'unavailable') return { kind: 'unavailable' }
  }
  return { kind: 'missing' }
}

function processCommandMatches(pid: number, pattern: RegExp): boolean | undefined {
  const command = Bun.spawnSync(
    ['/bin/ps', '-ww', '-o', 'command=', '-p', String(pid)],
    {
      stdout: 'pipe', stderr: 'ignore', env: PS_ENV,
      timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
    },
  )
  if (command.exitCode !== 0) return undefined
  return new RegExp(pattern.source, pattern.flags)
    .test(new TextDecoder().decode(command.stdout))
}

function legacyStartedForPublication(
  lockFile: string,
  pid: number,
): string {
  const fallback = processStartedLegacy(pid)
  const updater = updaterLock(lockFile)
  if (updater.kind === 'missing') return fallback
  if (updater.kind === 'unavailable') return ''
  const identity = readIdentityForSnapshot(updater.path, updater.snapshot)
  if (!identity) {
    if (identityArtifactExists(updater.path)) return ''
    const unchangedWithoutIdentity = () => sameSnapshot(updater.path, updater.snapshot)
      && !identityArtifactExists(updater.path)
    const observation = observeProcess(updater.snapshot.pid)
    if (observation.status === 'dead') return unchangedWithoutIdentity() ? fallback : ''
    if (observation.status === 'unknown') return ''
    const updaterCommand = processCommandMatches(
      updater.snapshot.pid,
      UPDATE_LOCK_OWNER_PATTERN,
    )
    return updaterCommand === false && unchangedWithoutIdentity() ? fallback : ''
  }
  const unchanged = () => sameSnapshot(updater.path, updater.snapshot)
    && JSON.stringify(readIdentityForSnapshot(updater.path, updater.snapshot))
      === JSON.stringify(identity)
  // Current updaters validate canonicalStarted and need no legacy bridge.
  if ('version' in identity) return unchanged() ? fallback : ''
  const observation = observeProcess(identity.pid)
  if (observation.status === 'dead') return unchanged() ? fallback : ''
  if (observation.status === 'unknown') return ''
  // A loaded legacy updater compares ambient ps text. Re-rendering its own
  // start time in the candidate environment proves both processes use the
  // same timezone rules, including a DST transition between their starts.
  const updaterAmbientStarted = processStartedLegacy(identity.pid)
  if (!updaterAmbientStarted) return ''
  if (updaterAmbientStarted === identity.started) return unchanged() ? fallback : ''
  // A live PID with a different start and a non-updater command is a reused
  // legacy owner. Do not delete its lock here; only stop applying the timezone
  // bridge to an unrelated process. Ambiguous probes remain fail-closed.
  const updaterCommand = processCommandMatches(identity.pid, UPDATE_LOCK_OWNER_PATTERN)
  return updaterCommand === false && unchanged() ? fallback : ''
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
      version: 3,
      pid,
      started: legacyStarted,
      canonicalStarted: observation.started,
      bootSession: observation.bootSession!,
      startSec: observation.startSec!,
      startUsec: observation.startUsec!,
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
    && identity.bootSession === lease.bootSession
    && identity.startSec === lease.startSec
    && identity.startUsec === lease.startUsec
    && identity.nonce === lease.nonce && identity.device === lease.device
    && identity.inode === lease.inode)
}

type EffectiveOwnerObservation =
  | { status: 'alive'; pid: number }
  | { status: 'dead' }
  | { status: 'unknown' }

function observeDelegate(
  delegate: ProcessLockDelegate,
  options: { allowCleanupPending?: boolean } = {},
): EffectiveOwnerObservation {
  if (delegate.bootSession) {
    const currentBoot = readBootSession()
    if (!currentBoot) return { status: 'unknown' }
    if (currentBoot !== delegate.bootSession) return { status: 'dead' }
  }
  // Same-boot uncertainty remains fail-closed because a detached descendant
  // may have escaped the recorded PGID. A different boot proves that every
  // process from the old generation is gone and allows journal recovery.
  if (delegate.blocked) return { status: 'unknown' }
  if (delegate.cleanupPending && !options.allowCleanupPending) return { status: 'unknown' }
  const leader = observeProcess(delegate.pid, delegate.canonicalStarted, delegate)
  if (leader.status === 'alive') return { status: 'alive', pid: delegate.pid }
  // An older in-flight delegate did not prove that its PID was a PGID. Once
  // that PID disappears we cannot safely infer anything about descendants.
  if (delegate.groupId !== delegate.pid) return { status: 'unknown' }
  const group = observeProcessGroup(delegate.groupId)
  if (group.status === 'dead') return { status: 'dead' }
  if (group.status === 'unknown') return { status: 'unknown' }
  // The numeric leader PID may be reused by a process in another group while
  // descendants keep the old PGID alive. Only a reused process that is itself
  // the leader of this numeric group proves that the old generation ended.
  if (leader.status === 'dead' && leader.reason === 'reused'
    && processGroupPid(delegate.pid) === delegate.pid) return { status: 'dead' }
  return { status: 'alive', pid: delegate.groupId }
}

function observeEffectiveOwner(
  snapshot: LockSnapshot,
  identity: ParsedIdentity | undefined,
): EffectiveOwnerObservation {
  const primary = observeProcess(
    snapshot.pid,
    identity && 'version' in identity ? identity.canonicalStarted : undefined,
    identity && 'version' in identity ? identity : undefined,
  )
  if (primary.status === 'alive') return { status: 'alive', pid: snapshot.pid }
  let unknown = primary.status === 'unknown'
  if (identity && 'version' in identity && identity.delegate) {
    const delegated = observeDelegate(identity.delegate)
    if (delegated.status === 'alive') {
      return delegated
    }
    unknown ||= delegated.status === 'unknown'
    // `blocked` is handled by observeDelegate and remains permanently
    // fail-closed. Otherwise a fresh kernel ESRCH for a proven PGID is the
    // linearization point at which every trusted same-PGID mutator is gone.
    // Reclaim only unlinks the old lease; it never signals a possibly reused
    // numeric PGID, so a missing quiescence marker after SIGKILL is recoverable.
  }
  return unknown ? { status: 'unknown' } : { status: 'dead' }
}

function processGroupPid(pid: number): number | undefined {
  const result = Bun.spawnSync(
    ['/bin/ps', '-o', 'pgid=', '-p', String(pid)],
    {
      stdout: 'pipe', stderr: 'ignore', env: PS_ENV,
      timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
    },
  )
  if (result.exitCode !== 0) return undefined
  const group = Number(new TextDecoder().decode(result.stdout).trim())
  return Number.isSafeInteger(group) && group > 0 ? group : undefined
}

function createDelegate(
  identity: ProcessLockIdentity,
  delegatePid: number,
  expectedStarted?: string,
): ProcessLockDelegate | undefined {
  if (delegatePid === identity.pid) return undefined
  if (identity.delegate) {
    const current = observeDelegate(identity.delegate)
    if (current.status === 'alive') {
      return identity.delegate.pid === delegatePid ? identity.delegate : undefined
    }
    if (current.status === 'unknown') return undefined
  }
  const observation = observeProcess(delegatePid, expectedStarted)
  if (observation.status !== 'alive' || processGroupPid(delegatePid) !== delegatePid) {
    return undefined
  }
  const confirmed = observeProcess(delegatePid, observation.started, observation)
  if (confirmed.status !== 'alive' || processGroupPid(delegatePid) !== delegatePid) {
    return undefined
  }
  if (!confirmed.bootSession || confirmed.startSec === undefined
    || confirmed.startUsec === undefined) return undefined
  return {
    pid: delegatePid,
    canonicalStarted: confirmed.started,
    bootSession: confirmed.bootSession,
    startSec: confirmed.startSec,
    startUsec: confirmed.startUsec,
    nonce: randomUUID(),
    groupId: delegatePid,
    leaseVersion: identity.version,
  }
}

/** Add a setup participant while retaining the exact primary lease. */
export function delegateProcessLock(
  lockFile: string,
  lease: ProcessLockLease,
  delegatePid: number,
): ProcessLockDelegate | undefined {
  return withMutationGuard(lockFile, () => {
    const initial = readLock(lockFile, 2)
    if (initial.kind !== 'valid') return undefined
    const snapshot = finishInterruptedPublication(lockFile, initial.snapshot)
    if (!snapshot || snapshot.pid !== lease.pid
      || snapshot.device !== lease.device || snapshot.inode !== lease.inode) return undefined
    const identity = readIdentityForSnapshot(lockFile, snapshot)
    if (!identity || !('version' in identity) || !identityMatchesLease(identity, lease)) {
      return undefined
    }
    const delegate = createDelegate(identity, delegatePid)
    if (!delegate || !sameSnapshot(lockFile, snapshot)) return undefined
    writeIdentity(lockFile, { ...identity, delegate })
    return delegate
  }, 'release')
}

/** Remove only the exact delegated participant capability. */
export function undelegateProcessLock(
  lockFile: string,
  delegate: ProcessLockDelegate,
): boolean {
  return withMutationGuard(lockFile, () => {
    const initial = readLock(lockFile, 2)
    if (initial.kind !== 'valid') return false
    const snapshot = finishInterruptedPublication(lockFile, initial.snapshot)
    if (!snapshot) return false
    const identity = readIdentityForSnapshot(lockFile, snapshot)
    if (!identity && identityArtifactExists(lockFile)) return false
    if (!identity || !('version' in identity) || !identity.delegate
      || identity.delegate.pid !== delegate.pid
      || identity.delegate.canonicalStarted !== delegate.canonicalStarted
      || identity.delegate.bootSession !== delegate.bootSession
      || identity.delegate.startSec !== delegate.startSec
      || identity.delegate.startUsec !== delegate.startUsec
      || identity.delegate.nonce !== delegate.nonce
      || identity.delegate.blocked
      || !sameSnapshot(lockFile, snapshot)) return false
    if (observeDelegate(identity.delegate, { allowCleanupPending: true }).status !== 'dead'
      || !sameSnapshot(lockFile, snapshot)) return false
    const restoreVersion = identity.delegate.leaseVersion ?? identity.version
    const { delegate: _removed, ...primary } = identity
    writeIdentity(lockFile, { ...primary, version: restoreVersion })
    return true
  }, 'release') ?? false
}

function durableV3Identity(identity: ProcessLockIdentity): ProcessLockIdentity | undefined {
  if (identity.version === 3) return identity
  const owner = observeProcess(identity.pid, identity.canonicalStarted, identity)
  if (owner.status !== 'alive' || !owner.bootSession
    || owner.startSec === undefined || owner.startUsec === undefined) return undefined
  return {
    ...identity,
    version: 3,
    bootSession: owner.bootSession,
    startSec: owner.startSec,
    startUsec: owner.startUsec,
  }
}

/** Write-ahead protection before any cleanup that can outlive the coordinator. */
export function protectProcessLockDelegateCleanup(
  lockFile: string,
  delegate: ProcessLockDelegate,
): boolean {
  return withMutationGuard(lockFile, () => {
    const initial = readLock(lockFile, 2)
    if (initial.kind !== 'valid') return false
    const snapshot = finishInterruptedPublication(lockFile, initial.snapshot)
    if (!snapshot) return false
    const identity = readIdentityForSnapshot(lockFile, snapshot)
    if (!identity || !('version' in identity) || !identity.delegate
      || identity.delegate.pid !== delegate.pid
      || identity.delegate.canonicalStarted !== delegate.canonicalStarted
      || identity.delegate.nonce !== delegate.nonce
      || !sameSnapshot(lockFile, snapshot)) return false
    if (identity.delegate.blocked || identity.delegate.cleanupPending) return true
    if (identity.delegate.quiescent) return true
    const durable = durableV3Identity(identity)
    if (!durable) return false
    writeIdentity(lockFile, {
      ...durable,
      delegate: {
        ...identity.delegate,
        leaseVersion: identity.delegate.leaseVersion ?? identity.version,
        cleanupPending: true,
      },
    })
    return true
  }, 'release') ?? false
}

/** Persist cleanup uncertainty so neither release nor a later owner can reclaim it. */
export function blockProcessLockDelegate(
  lockFile: string,
  delegate: ProcessLockDelegate,
): boolean {
  return withMutationGuard(lockFile, () => {
    const initial = readLock(lockFile, 2)
    if (initial.kind !== 'valid') return false
    const snapshot = finishInterruptedPublication(lockFile, initial.snapshot)
    if (!snapshot) return false
    const identity = readIdentityForSnapshot(lockFile, snapshot)
    if (!identity || !('version' in identity) || !identity.delegate
      || identity.delegate.pid !== delegate.pid
      || identity.delegate.canonicalStarted !== delegate.canonicalStarted
      || identity.delegate.nonce !== delegate.nonce
      || !sameSnapshot(lockFile, snapshot)) return false
    if (identity.delegate.blocked) return true
    const durable = durableV3Identity(identity)
    if (!durable) return false
    const {
      quiescent: _quiescent,
      cleanupPending: _cleanupPending,
      ...active
    } = identity.delegate
    writeIdentity(lockFile, {
      ...durable,
      delegate: {
        ...active,
        leaseVersion: active.leaseVersion ?? identity.version,
        blocked: true,
      },
    })
    return true
  }, 'release') ?? false
}

/** Called only by the delegated gate after its command group drained. */
export function markProcessLockDelegateQuiescent(
  lockFile: string,
  delegate: ProcessLockDelegate,
  callerPid = process.pid,
  callerParentPid = process.ppid,
): boolean {
  return withMutationGuard(lockFile, () => {
    const initial = readLock(lockFile, 2)
    if (initial.kind !== 'valid') return false
    const snapshot = finishInterruptedPublication(lockFile, initial.snapshot)
    if (!snapshot) return false
    const identity = readIdentityForSnapshot(lockFile, snapshot)
    if (!identity || !('version' in identity) || !identity.delegate
      || identity.delegate.pid !== delegate.pid
      || identity.delegate.canonicalStarted !== delegate.canonicalStarted
      || identity.delegate.nonce !== delegate.nonce
      || identity.delegate.blocked
      || callerParentPid !== delegate.pid
      || processGroupPid(callerPid) !== delegate.pid
      || observeDelegate(identity.delegate).status !== 'alive'
      || !sameSnapshot(lockFile, snapshot)) return false
    if (identity.delegate.quiescent) return true
    writeIdentity(lockFile, {
      ...identity,
      delegate: { ...identity.delegate, quiescent: true },
    })
    return true
  }, 'release') ?? false
}

/** Verify that this exact live PID is already covered by the update lease. */
export function processLockDelegateMatches(lockFile: string, expectedPid: number): boolean {
  return withMutationGuard(lockFile, () => {
    const initial = readLock(lockFile, 2)
    if (initial.kind !== 'valid') return false
    const snapshot = finishInterruptedPublication(lockFile, initial.snapshot)
    if (!snapshot) return false
    const identity = readIdentityForSnapshot(lockFile, snapshot)
    if (!identity || !('version' in identity) || !identity.delegate) return false
    const expected = identity.delegate
    if (expected.blocked || expected.participant) return false
    const participant = observeProcess(expectedPid)
    if (participant.status !== 'alive' || !participant.bootSession
      || participant.startSec === undefined || participant.startUsec === undefined
      || observeProcess(expected.pid, expected.canonicalStarted, expected).status !== 'alive'
      || processGroupPid(expected.pid) !== expected.pid
      || processGroupPid(expectedPid) !== expected.pid
      || !sameSnapshot(lockFile, snapshot)) return false
    const current = readIdentityForSnapshot(lockFile, snapshot)
    if (!current || !('version' in current) || !current.delegate
      || current.delegate.pid !== expected.pid
      || current.delegate.canonicalStarted !== expected.canonicalStarted
      || current.delegate.nonce !== expected.nonce
      || current.delegate.participant || current.delegate.blocked
      || observeProcess(expectedPid, participant.started, participant).status !== 'alive'
      || processGroupPid(expectedPid) !== expected.pid) return false
    if (current.delegate.groupId !== undefined
      && current.delegate.groupId !== expected.pid) return false
    writeIdentity(lockFile, {
      ...current,
      delegate: {
        ...current.delegate,
        groupId: expected.pid,
        participant: {
          pid: expectedPid,
          bootSession: participant.bootSession,
          startSec: participant.startSec,
          startUsec: participant.startUsec,
        },
      },
    })
    return true
  }, 'release') ?? false
}

export function processLockOwnerMatches(
  lockFile: string,
  expectedPid: number,
  commandPattern: RegExp,
): boolean {
  const read = readLock(lockFile, 2)
  if (read.kind !== 'valid' || read.snapshot.pid !== expectedPid) return false
  const identity = readIdentityForSnapshot(lockFile, read.snapshot)
  if (!identity) return false
  const observation = observeProcess(
    expectedPid, 'version' in identity ? identity.canonicalStarted : undefined,
    'version' in identity ? identity : undefined,
  )
  if (observation.status !== 'alive') return false
  if (!('version' in identity) && identity.started !== processStartedLegacy(expectedPid)) return false
  return processCommandMatches(expectedPid, commandPattern) === true
    && sameSnapshot(lockFile, read.snapshot)
}

export type ProcessLockStopResult =
  | 'stopped'
  | 'owner-unavailable'
  | 'timeout'
  | 'aborted'

/**
 * Stop only the exact microsecond generation bound to a process lock. The
 * signal helper re-probes immediately before kill(2), and the wait loop never
 * follows a recycled numeric PID.
 */
export async function stopProcessLockOwner(
  lockFile: string,
  expectedPid: number,
  commandPattern: RegExp,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProcessLockStopResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 'owner-unavailable'
  if (!processLockOwnerMatches(lockFile, expectedPid, commandPattern)) {
    return 'owner-unavailable'
  }
  const expected = readDarwinProcessIdentity(expectedPid)
  if (!expected || !processLockOwnerMatches(lockFile, expectedPid, commandPattern)) {
    return 'owner-unavailable'
  }
  if (!signalProcessIfLive(expected, 'SIGTERM')) {
    const observation = observeProcessGeneration(expected)
    return observation.status === 'dead' ? 'stopped' : 'owner-unavailable'
  }
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (options.signal?.aborted) return 'aborted'
    const observation = observeProcessGeneration(expected)
    if (observation.status === 'dead') return 'stopped'
    if (observation.status === 'unknown') return 'owner-unavailable'
    if (Date.now() >= deadline) return 'timeout'
    await Bun.sleep(50)
  }
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
      bootSession: observation.bootSession,
      startSec: observation.startSec,
      startUsec: observation.startUsec,
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
    if (!identity && identityArtifactExists(lockFile)) return false
    const observation = observeEffectiveOwner(snapshot, identity)
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
  if (!prepareLockParent(lockFile)) {
    return { acquired: false, kind: 'owner-unavailable' }
  }
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
      if (!identity && identityArtifactExists(lockFile)) {
        return { acquired: false, kind: 'owner-unavailable' } as const
      }
      const observation = observeEffectiveOwner(snapshot, identity)
      if (observation.status === 'alive') {
        return { acquired: false, kind: 'held', heldPid: observation.pid } as const
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
    const identity = readIdentityForSnapshot(lockFile, snapshot)
    if (snapshot.pid !== lease.pid
      || snapshot.device !== lease.device || snapshot.inode !== lease.inode
      || !identityMatchesLease(identity, lease)) return false
    if (identity && 'version' in identity && identity.delegate) return false
    if (!sameSnapshot(lockFile, snapshot)) return false
    try { unlinkSync(lockFile) } catch { return false }
    removeIdentity(lockFile)
    return true
  }, 'release') ?? false
}

/**
 * Rollback may mutate the repository only while the exact primary lease has
 * no delegated setup generation. This is deliberately stricter than release:
 * even a definitely-dead but not-yet-removed delegate blocks the transition.
 */
export function processLockLeaseIsExclusive(
  lockFile: string,
  lease: ProcessLockLease,
): boolean {
  return withMutationGuard(lockFile, () => {
    const initial = readLock(lockFile, 2)
    if (initial.kind !== 'valid') return false
    const snapshot = finishInterruptedPublication(lockFile, initial.snapshot)
    if (!snapshot || snapshot.pid !== lease.pid
      || snapshot.device !== lease.device || snapshot.inode !== lease.inode) return false
    const identity = readIdentityForSnapshot(lockFile, snapshot)
    return Boolean(identity && 'version' in identity
      && identityMatchesLease(identity, lease)
      && !identity.delegate
      && sameSnapshot(lockFile, snapshot))
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
    if (identityArtifactExists(lockFile)) return { status: 'unknown', pid: read.snapshot.pid }
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
  if ('version' in identity) {
    const owner = observeEffectiveOwner(read.snapshot, identity)
    if (owner.status === 'alive') return { status: 'active', pid: owner.pid }
    if (owner.status === 'dead') return { status: 'stale', pid: read.snapshot.pid }
    return { status: 'unknown', pid: read.snapshot.pid }
  }
  const observation = observeProcess(
    read.snapshot.pid,
    undefined,
  )
  if (observation.status === 'dead') return { status: 'stale', pid: read.snapshot.pid }
  if (observation.status === 'unknown') return { status: 'unknown', pid: read.snapshot.pid }
  const legacyStarted = processStartedLegacy(read.snapshot.pid)
  if (!legacyStarted) return { status: 'unknown', pid: read.snapshot.pid }
  if (legacyStarted !== identity.started) {
    if (!legacyCommandPattern) return { status: 'unknown', pid: read.snapshot.pid }
    const commandMatches = processCommandMatches(read.snapshot.pid, legacyCommandPattern)
    if (commandMatches === undefined) return { status: 'unknown', pid: read.snapshot.pid }
    return commandMatches
      ? { status: 'active', pid: read.snapshot.pid }
      : { status: 'stale', pid: read.snapshot.pid }
  }
  return { status: 'active', pid: read.snapshot.pid }
}

export function encodeProcessLockLease(lease: ProcessLockLease): string {
  return Buffer.from(JSON.stringify(lease)).toString('base64url')
}

function decodeLease(value: string): ProcessLockLease | undefined {
  try {
    const parsed = parseIdentity(Buffer.from(value, 'base64url').toString('utf8'))
    return parsed && 'version' in parsed ? parsed : undefined
  } catch { return undefined }
}

export function encodeProcessLockDelegate(delegate: ProcessLockDelegate): string {
  return Buffer.from(JSON.stringify(delegate)).toString('base64url')
}

function decodeDelegate(value: string): ProcessLockDelegate | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const delegate = parsed as Record<string, unknown>
    if (!Number.isSafeInteger(delegate.pid) || (delegate.pid as number) <= 0
      || typeof delegate.canonicalStarted !== 'string'
      || delegate.canonicalStarted.length === 0
      || delegate.canonicalStarted.length > 128
      || typeof delegate.nonce !== 'string'
      || !UUID_PATTERN.test(delegate.nonce)) return undefined
    if (delegate.groupId !== undefined
      && (!Number.isSafeInteger(delegate.groupId) || (delegate.groupId as number) <= 1
        || delegate.groupId !== delegate.pid)) return undefined
    const precise = parsePreciseGeneration(delegate)
    if (precise === null
      || (delegate.leaseVersion !== undefined
        && delegate.leaseVersion !== 2 && delegate.leaseVersion !== 3)
      || (delegate.blocked !== undefined && delegate.blocked !== true)
      || (delegate.cleanupPending !== undefined && delegate.cleanupPending !== true)
      || (delegate.quiescent !== undefined && delegate.quiescent !== true)
      || ([delegate.blocked, delegate.cleanupPending, delegate.quiescent]
        .filter(value => value === true).length > 1)) return undefined
    let participant: ProcessLockDelegate['participant']
    if (delegate.participant !== undefined) {
      if (!delegate.participant || typeof delegate.participant !== 'object') return undefined
      const record = delegate.participant as Record<string, unknown>
      const participantPrecise = parsePreciseGeneration(record)
      if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
        || !participantPrecise) return undefined
      participant = { pid: record.pid as number, ...participantPrecise }
    }
    return {
      pid: delegate.pid as number,
      canonicalStarted: delegate.canonicalStarted,
      nonce: delegate.nonce,
      ...(precise ? precise : {}),
      ...(delegate.groupId === undefined
        ? {}
        : { groupId: delegate.groupId as number }),
      ...(participant ? { participant } : {}),
      ...(delegate.leaseVersion === 2 || delegate.leaseVersion === 3
        ? { leaseVersion: delegate.leaseVersion }
        : {}),
      ...(delegate.blocked === true ? { blocked: true as const } : {}),
      ...(delegate.cleanupPending === true ? { cleanupPending: true as const } : {}),
      ...(delegate.quiescent === true ? { quiescent: true as const } : {}),
    }
  } catch { return undefined }
}

if (import.meta.main) {
  const [command, lockFile, owner, participant, timeoutValue] = process.argv.slice(2)
  const validCommand = command === 'acquire' || command === 'release'
    || command === 'delegate' || command === 'undelegate' || command === 'delegate-active'
    || command === 'quiescent' || command === 'stop-owner'
  if (!lockFile || !owner || !validCommand) {
    process.stderr.write(
      'usage: process-lock.ts acquire <lock-file> <pid>\n'
      + '  | release <lock-file> <lease-token>\n'
      + '  | delegate <lock-file> <lease-token> <pid>\n'
      + '  | undelegate <lock-file> <delegate-token>\n'
      + '  | delegate-active <lock-file> <pid>\n'
      + '  | quiescent <lock-file> <delegate-token>\n'
      + '  | stop-owner <lock-file> <pid> <command-pattern> [timeout-ms]\n',
    )
    process.exit(2)
  }
  try {
    if (command === 'acquire') {
      const pid = Number(owner)
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid PID: ${owner}`)
      const result = tryAcquireProcessLock(lockFile, pid)
      if (result.acquired) {
        process.stdout.write(`${encodeProcessLockLease(result.lease)}\n`)
      } else {
        if (result.kind === 'held') process.stdout.write(`${result.heldPid}\n`)
        process.exitCode = 3
      }
    } else if (command === 'release') {
      const lease = decodeLease(owner)
      if (!lease) throw new Error('invalid process lock lease token')
      if (!releaseProcessLock(lockFile, lease)) process.exitCode = 3
    } else if (command === 'delegate') {
      const lease = decodeLease(owner)
      const pid = Number(participant)
      if (!lease) throw new Error('invalid process lock lease token')
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid PID: ${participant}`)
      const delegate = delegateProcessLock(lockFile, lease, pid)
      if (delegate) process.stdout.write(`${encodeProcessLockDelegate(delegate)}\n`)
      else process.exitCode = 3
    } else if (command === 'undelegate') {
      const delegate = decodeDelegate(owner)
      if (!delegate) throw new Error('invalid process lock delegate token')
      if (!undelegateProcessLock(lockFile, delegate)) process.exitCode = 3
    } else if (command === 'delegate-active') {
      const pid = Number(owner)
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid PID: ${owner}`)
      if (!processLockDelegateMatches(lockFile, pid)) process.exitCode = 3
    } else if (command === 'stop-owner') {
      const pid = Number(owner)
      const timeoutMs = timeoutValue === undefined ? 30_000 : Number(timeoutValue)
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid PID: ${owner}`)
      if (!participant) throw new Error('command pattern is required')
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid timeout')
      const result = await stopProcessLockOwner(
        lockFile,
        pid,
        new RegExp(participant),
        { timeoutMs },
      )
      if (result !== 'stopped') {
        process.stderr.write(`process lock owner stop failed: ${result}\n`)
        process.exitCode = 3
      }
    } else {
      const delegate = decodeDelegate(owner)
      if (!delegate) throw new Error('invalid process lock delegate token')
      if (!markProcessLockDelegateQuiescent(lockFile, delegate)) process.exitCode = 3
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
