import { createHash, randomUUID } from 'crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmdirSync,
  rmSync,
  writeSync,
} from 'fs'
import { isAbsolute, join, relative, sep } from 'path'
import { ensureManagedDirectory, requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import {
  observeProcessGeneration,
  processIdentityIsStopped,
  readProcessTable,
  signalProcessIfLive,
  type ProcessIdentity,
} from './process-generation.ts'

const MAX_CANDIDATE_PROCESSES = 8_192
const MAX_TAG_BYTES = 256
const FINGERPRINT_DIRECTORY = 'sandbox-obligations'

export type SeatbeltTagIdentity = {
  path: string
  dev: string
  ino: string
  mode: string
  uid: string
  nlink: string
  size: string
  mtimeNs: string
  ctimeNs: string
  digest: string
}

export type SeatbeltFingerprint = {
  version: 1
  allow: SeatbeltTagIdentity
  deny: SeatbeltTagIdentity
}

type SandboxCheckResult = { pid: number; allow: number; deny: number }

const SANDBOX_CHECK_SCRIPT = String.raw`
import ctypes, json, os, sys

def main():
    if len(sys.argv) != 3:
        return 64
    allow = os.fsencode(sys.argv[1])
    deny = os.fsencode(sys.argv[2])
    request = json.load(sys.stdin)
    pids = request.get("pids") if isinstance(request, dict) else None
    if request.get("version") != 1 or not isinstance(pids, list) or len(pids) > 8192:
        return 65
    if len(set(pids)) != len(pids) or any(not isinstance(pid, int) or pid <= 1 for pid in pids):
        return 65
    library = ctypes.CDLL(None, use_errno=True)
    check = library.sandbox_check
    check.restype = ctypes.c_int
    check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    operation = ctypes.c_char_p(b"file-read-data")
    results = []
    for pid in pids:
        allow_result = check(pid, operation, 1, ctypes.c_char_p(allow))
        deny_result = check(pid, operation, 1, ctypes.c_char_p(deny))
        results.append({"pid": pid, "allow": allow_result, "deny": deny_result})
    json.dump({"version": 1, "results": results}, sys.stdout, separators=(",", ":"))
    return 0

raise SystemExit(main())
`

function ownerMatches(uid: bigint): boolean {
  return typeof process.getuid !== 'function' || uid === BigInt(process.getuid())
}

function tagIdentity(path: string): SeatbeltTagIdentity {
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || !ownerMatches(before.uid) || (before.mode & 0o077n) !== 0n
    || before.size < 1n || before.size > BigInt(MAX_TAG_BYTES)) {
    throw new Error(`unsafe Seatbelt fingerprint tag: ${path}`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    const fields = ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const
    if (fields.some(field => before[field] !== opened[field])) {
      throw new Error(`Seatbelt fingerprint tag changed while opening: ${path}`)
    }
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) throw new Error(`short Seatbelt fingerprint read: ${path}`)
      offset += count
    }
    const after = fstatSync(descriptor, { bigint: true })
    if (fields.some(field => opened[field] !== after[field])) {
      throw new Error(`Seatbelt fingerprint tag changed while reading: ${path}`)
    }
    return {
      path,
      ...Object.fromEntries(fields.map(field => [field, String(opened[field])])) as Omit<
        SeatbeltTagIdentity, 'path' | 'digest'
      >,
      digest: createHash('sha256').update(bytes).digest('hex'),
    }
  } finally {
    closeSync(descriptor)
  }
}

function sameTag(left: SeatbeltTagIdentity, right: SeatbeltTagIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateFingerprintLocation(stateDir: string, fingerprint: SeatbeltFingerprint): string {
  const state = requireManagedStateRoot(stateDir)
  const root = requireManagedDirectory(state, join(state, FINGERPRINT_DIRECTORY))
  const allowRelative = relative(root, fingerprint.allow.path)
  const denyRelative = relative(root, fingerprint.deny.path)
  const validRelative = (value: string, leaf: 'allow' | 'deny'): boolean => {
    const components = value.split(sep)
    return components.length === 3
      && /^[A-Za-z0-9._-]{1,256}$/.test(components[0]!)
      && /^[0-9a-f]{32}$/.test(components[1]!)
      && components[2] === leaf
      && !isAbsolute(value) && !value.startsWith(`..${sep}`)
  }
  if (!validRelative(allowRelative, 'allow') || !validRelative(denyRelative, 'deny')
    || allowRelative.split(sep).slice(0, 2).join(sep)
      !== denyRelative.split(sep).slice(0, 2).join(sep)) {
    throw new Error('Seatbelt fingerprint paths are outside their job attempt')
  }
  requireManagedDirectory(state, join(root, ...allowRelative.split(sep).slice(0, 2)))
  return state
}

export function verifySeatbeltFingerprint(
  stateDir: string,
  fingerprint: SeatbeltFingerprint,
): void {
  if (fingerprint.version !== 1) throw new Error('unsupported Seatbelt fingerprint version')
  validateFingerprintLocation(stateDir, fingerprint)
  if (!sameTag(tagIdentity(fingerprint.allow.path), fingerprint.allow)
    || !sameTag(tagIdentity(fingerprint.deny.path), fingerprint.deny)) {
    throw new Error('Seatbelt fingerprint identity changed')
  }
}

export function readSeatbeltFingerprint(
  stateDir: string,
  allowPath: string,
  denyPath: string,
): SeatbeltFingerprint {
  const fingerprint: SeatbeltFingerprint = {
    version: 1,
    allow: tagIdentity(allowPath),
    deny: tagIdentity(denyPath),
  }
  verifySeatbeltFingerprint(stateDir, fingerprint)
  return fingerprint
}

function writePrivateTag(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const content = Buffer.from(`${randomUUID()}\n`)
    let offset = 0
    while (offset < content.length) {
      const count = writeSync(descriptor, content, offset, content.length - offset)
      if (count <= 0) throw new Error(`short Seatbelt fingerprint write: ${path}`)
      offset += count
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function createSeatbeltFingerprint(
  stateDir: string,
  jobId: string,
  attemptNonce: string,
): SeatbeltFingerprint {
  if (!/^[0-9a-f]{32}$/.test(attemptNonce)) {
    throw new Error('Seatbelt fingerprint attempt nonce is invalid')
  }
  const state = requireManagedStateRoot(stateDir)
  const safeJob = jobId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (!safeJob || safeJob.length > 256) throw new Error('Seatbelt fingerprint job ID is invalid')
  const directory = ensureManagedDirectory(
    state,
    join(state, FINGERPRINT_DIRECTORY, safeJob, attemptNonce),
  )
  const allowPath = join(directory, 'allow')
  const denyPath = join(directory, 'deny')
  writePrivateTag(allowPath)
  try {
    writePrivateTag(denyPath)
  } catch (error) {
    rmSync(allowPath, { force: true })
    throw error
  }
  return { version: 1, allow: tagIdentity(allowPath), deny: tagIdentity(denyPath) }
}

export function removeSeatbeltFingerprint(
  stateDir: string,
  fingerprint: SeatbeltFingerprint,
): void {
  verifySeatbeltFingerprint(stateDir, fingerprint)
  // Registration is removed first by the caller. Leftover tags after a crash
  // are inert, while removing tags before the durable receipt would destroy
  // the only recovery key.
  rmSync(fingerprint.deny.path)
  rmSync(fingerprint.allow.path)
  rmdirSync(join(fingerprint.allow.path, '..'))
}

function querySandboxChecksForPaths(
  candidates: readonly ProcessIdentity[],
  allowPath: string,
  denyPath: string,
): SandboxCheckResult[] {
  if (process.platform !== 'darwin') throw new Error('Seatbelt fingerprint requires macOS')
  if (!isAbsolute(allowPath) || !isAbsolute(denyPath) || allowPath === denyPath) {
    throw new Error('Seatbelt fingerprint paths are invalid')
  }
  if (candidates.length > MAX_CANDIDATE_PROCESSES) {
    throw new Error(`Seatbelt candidate count exceeds ${MAX_CANDIDATE_PROCESSES}`)
  }
  const result = Bun.spawnSync([
    '/usr/bin/python3', '-I', '-c', SANDBOX_CHECK_SCRIPT,
    allowPath, denyPath,
  ], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdin: Buffer.from(JSON.stringify({ version: 1, pids: candidates.map(value => value.pid) })),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  })
  if (result.exitCode !== 0) {
    throw new Error(`Seatbelt kernel query failed (${result.exitCode}): ${result.stderr.toString().slice(-1000)}`)
  }
  let value: unknown
  try { value = JSON.parse(result.stdout.toString()) } catch {
    throw new Error('Seatbelt kernel query returned invalid JSON')
  }
  const rows = (value as { version?: unknown; results?: unknown })?.results
  if ((value as { version?: unknown })?.version !== 1 || !Array.isArray(rows)
    || rows.length !== candidates.length) {
    throw new Error('Seatbelt kernel query result is incomplete')
  }
  const expected = new Set(candidates.map(candidate => candidate.pid))
  const seen = new Set<number>()
  const parsed: SandboxCheckResult[] = rows.map(row => {
    const record = row as Record<string, unknown>
    if (!record || !Number.isSafeInteger(record.pid) || !expected.has(Number(record.pid))
      || seen.has(Number(record.pid)) || !Number.isSafeInteger(record.allow)
      || !Number.isSafeInteger(record.deny)) {
      throw new Error('Seatbelt kernel query contains an invalid process result')
    }
    seen.add(Number(record.pid))
    return { pid: Number(record.pid), allow: Number(record.allow), deny: Number(record.deny) }
  })
  if (seen.size !== expected.size) throw new Error('Seatbelt kernel query omitted a process')
  return parsed
}

function querySandboxChecks(
  candidates: readonly ProcessIdentity[],
  fingerprint: SeatbeltFingerprint,
): SandboxCheckResult[] {
  return querySandboxChecksForPaths(
    candidates,
    fingerprint.allow.path,
    fingerprint.deny.path,
  )
}

export function processCarriesSeatbeltFingerprint(
  allowPath: string,
  denyPath: string,
  pid = process.pid,
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Seatbelt process PID is invalid')
  const candidate = readProcessTable().find(identity => identity.pid === pid)
  if (!candidate) throw new Error(`Seatbelt process ${pid} is absent`)
  const [result] = querySandboxChecksForPaths([candidate], allowPath, denyPath)
  return result?.pid === pid && result.allow === 0 && result.deny !== 0
}

function atOrAfter(identity: ProcessIdentity, earliest: ProcessIdentity): boolean {
  return identity.bootSession === earliest.bootSession
    && (identity.startSec > earliest.startSec
      || (identity.startSec === earliest.startSec && identity.startUsec >= earliest.startUsec))
}

function expectedFrom(identity: ProcessIdentity): ProcessIdentity {
  return { ...identity }
}

async function waitStopped(identities: Iterable<ProcessIdentity>, timeoutMs = 2_000): Promise<void> {
  const expected = [...identities]
  const deadline = Date.now() + timeoutMs
  while (true) {
    const active = expected.flatMap(identity => {
      const observation = observeProcessGeneration(identity)
      if (observation.status === 'unknown') {
        throw new Error(`Seatbelt process ${identity.pid} generation is unknown while freezing`)
      }
      return observation.status === 'alive' && !processIdentityIsStopped(observation.identity)
        ? [observation.identity]
        : []
    })
    if (active.length === 0) return
    if (Date.now() >= deadline) {
      throw new Error(`Seatbelt processes did not stop: ${active.map(value => value.pid).join(', ')}`)
    }
    await Bun.sleep(10)
  }
}

async function waitDead(identities: Iterable<ProcessIdentity>, timeoutMs = 2_000): Promise<void> {
  const expected = [...identities]
  const deadline = Date.now() + timeoutMs
  while (true) {
    const live = expected.filter(identity => {
      const observation = observeProcessGeneration(identity)
      if (observation.status === 'unknown') {
        throw new Error(`Seatbelt process ${identity.pid} generation is unknown after KILL`)
      }
      return observation.status === 'alive'
    })
    if (live.length === 0) return
    if (Date.now() >= deadline) {
      throw new Error(`Seatbelt processes remain after KILL: ${live.map(value => value.pid).join(', ')}`)
    }
    await Bun.sleep(20)
  }
}

/**
 * Reap ordinary Codex/Grok command descendants even after setsid/reparent.
 * Direct runtime roots still use the exact generation ledger; this closes the
 * polling gap for the inherited macOS Seatbelt policy.
 */
export async function reapSeatbeltFingerprint(options: {
  stateDir: string
  fingerprint: SeatbeltFingerprint
  earliest?: ProcessIdentity
  excludePids?: ReadonlySet<number>
}): Promise<number[]> {
  verifySeatbeltFingerprint(options.stateDir, options.fingerprint)
  const owner = typeof process.getuid === 'function' ? process.getuid() : undefined
  const excluded = options.excludePids ?? new Set<number>()
  const caught = new Map<number, ProcessIdentity>()
  let stablePasses = 0
  let previous = ''
  for (let pass = 0; pass < 100 && stablePasses < 2; pass += 1) {
    verifySeatbeltFingerprint(options.stateDir, options.fingerprint)
    const candidates = readProcessTable().filter(identity => (
      !excluded.has(identity.pid)
      && !caught.has(identity.pid)
      && (owner === undefined || identity.uid === owner)
      && (options.earliest === undefined || atOrAfter(identity, options.earliest))
    ))
    const byPid = new Map(candidates.map(identity => [identity.pid, identity]))
    const matches = querySandboxChecks(candidates, options.fingerprint)
      .filter(result => result.allow === 0 && result.deny !== 0)
      .flatMap(result => byPid.get(result.pid) ? [byPid.get(result.pid)!] : [])
    for (const identity of matches) {
      const observation = observeProcessGeneration(expectedFrom(identity))
      if (observation.status === 'unknown') {
        throw new Error(`Seatbelt process ${identity.pid} generation is unknown before STOP`)
      }
      if (observation.status !== 'alive') continue
      caught.set(identity.pid, observation.identity)
      if (!signalProcessIfLive(observation.identity, 'SIGSTOP')) {
        const after = observeProcessGeneration(observation.identity)
        if (after.status === 'unknown' || after.status === 'alive') {
          throw new Error(`Seatbelt process ${identity.pid} could not be stopped`)
        }
      }
    }
    await waitStopped(caught.values())
    const signature = [...caught.values()].map(value => `${value.pid}:${value.started}`).sort().join('|')
    if (signature === previous) stablePasses += 1
    else stablePasses = 0
    previous = signature
    await Bun.sleep(25)
  }
  if (stablePasses < 2) throw new Error('Seatbelt descendant freeze did not reach a fixed point')
  for (const identity of caught.values()) {
    const observation = observeProcessGeneration(identity)
    if (observation.status === 'unknown') {
      throw new Error(`Seatbelt process ${identity.pid} generation is unknown before KILL`)
    }
    if (observation.status === 'alive' && !signalProcessIfLive(observation.identity, 'SIGKILL')) {
      const after = observeProcessGeneration(observation.identity)
      if (after.status !== 'dead') throw new Error(`Seatbelt process ${identity.pid} could not be killed`)
    }
  }
  await waitDead(caught.values())
  for (let pass = 0; pass < 3; pass += 1) {
    verifySeatbeltFingerprint(options.stateDir, options.fingerprint)
    const candidates = readProcessTable().filter(identity => (
      !excluded.has(identity.pid)
      && (owner === undefined || identity.uid === owner)
      && (options.earliest === undefined || atOrAfter(identity, options.earliest))
    ))
    const byPid = new Map(candidates.map(identity => [identity.pid, identity]))
    const escaped = querySandboxChecks(candidates, options.fingerprint)
      .filter(result => result.allow === 0 && result.deny !== 0)
      .flatMap(result => byPid.get(result.pid) ? [byPid.get(result.pid)!] : [])
    if (escaped.length > 0) {
      throw new Error(`new Seatbelt descendants appeared after cleanup: ${escaped.map(value => value.pid).join(', ')}`)
    }
    await Bun.sleep(25)
  }
  verifySeatbeltFingerprint(options.stateDir, options.fingerprint)
  return [...caught.keys()].sort((left, right) => left - right)
}

/**
 * Recover fingerprints created before an executor registration became
 * durable. The random allow/deny tag pair is itself the durable obligation:
 * no unrelated process can carry that exact kernel policy, so startup can
 * scan all same-owner processes without guessing a PID or process group.
 * Registered attempts are removed by executor recovery before this runs.
 */
export async function recoverOrphanSeatbeltFingerprints(
  stateDirInput: string,
): Promise<number[]> {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const root = join(stateDir, FINGERPRINT_DIRECTORY)
  try {
    requireManagedDirectory(stateDir, root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const recovered: number[] = []
  for (const jobName of readdirSync(root).sort()) {
    if (!/^[A-Za-z0-9._-]{1,256}$/.test(jobName) || jobName === '.' || jobName === '..') {
      throw new Error(`unsafe Seatbelt obligation job directory: ${jobName}`)
    }
    const jobDirectory = join(root, jobName)
    requireManagedDirectory(stateDir, jobDirectory)
    for (const nonce of readdirSync(jobDirectory).sort()) {
      if (!/^[0-9a-f]{32}$/.test(nonce)) {
        throw new Error(`unsafe Seatbelt obligation attempt directory: ${nonce}`)
      }
      const attemptDirectory = join(jobDirectory, nonce)
      requireManagedDirectory(stateDir, attemptDirectory)
      const entries = readdirSync(attemptDirectory).sort()
      if (entries.length === 0) {
        rmdirSync(attemptDirectory)
        continue
      }
      if (entries.join('\n') === 'allow') {
        // createSeatbeltFingerprint writes allow first and never returns until
        // deny is durable. Retirement removes deny first. In either case a
        // lone validated allow tag cannot still be the two-tag policy carried
        // by an escaped process.
        tagIdentity(join(attemptDirectory, 'allow'))
        rmSync(join(attemptDirectory, 'allow'))
        rmdirSync(attemptDirectory)
        continue
      }
      if (entries.join('\n') === 'deny') {
        // Older Zeroちゃん releases retired allow before deny. A crash in
        // that narrow window left this validated deny-only state after the
        // process cleanup and durable registration removal had completed.
        tagIdentity(join(attemptDirectory, 'deny'))
        rmSync(join(attemptDirectory, 'deny'))
        rmdirSync(attemptDirectory)
        continue
      }
      if (entries.join('\n') !== 'allow\ndeny') {
        throw new Error(`unsafe Seatbelt obligation contents: ${attemptDirectory}`)
      }
      const fingerprint = readSeatbeltFingerprint(
        stateDir,
        join(attemptDirectory, 'allow'),
        join(attemptDirectory, 'deny'),
      )
      recovered.push(...await reapSeatbeltFingerprint({ stateDir, fingerprint }))
      removeSeatbeltFingerprint(stateDir, fingerprint)
    }
    if (readdirSync(jobDirectory).length === 0) rmdirSync(jobDirectory)
  }
  return recovered.sort((left, right) => left - right)
}
