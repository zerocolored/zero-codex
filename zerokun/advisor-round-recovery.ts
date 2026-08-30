import { createHash, randomBytes } from 'crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'fs'
import { basename, dirname, join } from 'path'
import { readAdvisorInputSnapshot } from './advisor-input.ts'
import {
  advisorRepositoryDigest,
  resolveAdvisorProjectLayout,
  snapshotAdvisorRepository,
} from './advisor-snapshot.ts'
import type { ReconciledEphemeralClaudeRound } from './ephemeral-claude-session.ts'
import { ensureManagedDirectory, requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { assertDescriptorStillNamesPath, atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import type { SeatbeltFingerprint } from './seatbelt-fingerprint.ts'

const MAX_RECORD_BYTES = 64 * 1024
const SHA256 = /^[0-9a-f]{64}$/
const NONCE = /^[0-9a-f]{32}$/
const REVISION = /^revision-([1-9][0-9]*)-([0-9a-f]{16})$/
const ROUND = /^(investigation|design|review)-([123])\.json$/

type FileSnapshot = {
  dev: number
  ino: number
  digest: string
  raw: string
}

type ExecutorIdentity = {
  pid: number
  pgid: number
  started: string
  bootSession: string
  startSec: number
  startUsec: number
}

type RetirementRecord = {
  version: 1
  status: 'supervisor-retired' | 'round-finalized'
  recoveryId: string
  jobId: string
  attemptNonce: string
  processNonce: string
  contextDigest: string
  inputRevision: number
  inputDigest: string
  phase: 'investigation' | 'design' | 'review'
  round: 1 | 2 | 3
  journalDigest: string
  lockDigest: string
  lockDev: number
  lockIno: number
  fingerprintDigest: string
  supervisor: ExecutorIdentity
  seatbeltCleanupVerified: true
  retiredAt: number
  finalizedAt?: number
  terminalJournalDigest?: string
}

export type AdvisorClaudeCleanupOutcome = ReconciledEphemeralClaudeRound & {
  inputDigest: string
}

function safeJob(jobId: string): string {
  const value = jobId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (!value || value.length > 256) throw new Error('advisor recovery job ID is invalid')
  return value
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function readFileSnapshot(path: string): FileSnapshot | null {
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const before = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || before.uid === process.getuid()
    if (!before.isFile() || before.nlink !== 1 || !ownerMatches
      || (before.mode & 0o077) !== 0 || before.size > MAX_RECORD_BYTES) {
      throw new Error(`unsafe advisor recovery file: ${path}`)
    }
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) throw new Error(`advisor recovery file changed while reading: ${path}`)
      offset += count
    }
    const extra = Buffer.alloc(1)
    if (readSync(descriptor, extra, 0, 1, before.size) !== 0) {
      throw new Error(`advisor recovery file exceeded its bound: ${path}`)
    }
    assertDescriptorStillNamesPath(descriptor, path)
    const after = fstatSync(descriptor)
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`advisor recovery file changed while reading: ${path}`)
    }
    const raw = bytes.toString('utf8')
    return { dev: before.dev, ino: before.ino, digest: sha256(raw), raw }
  } finally {
    closeSync(descriptor)
  }
}

function parseObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error(`${label} is invalid JSON`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} is invalid`)
  }
  return parsed as Record<string, unknown>
}

function writeIdempotent(path: string, value: Record<string, unknown>): void {
  const serialized = `${JSON.stringify(value)}\n`
  let descriptor: number
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = readFileSnapshot(path)
    if (existing?.raw !== serialized) {
      throw new Error(`advisor recovery record conflicts: ${path}`)
    }
    return
  }
  try {
    const bytes = Buffer.from(serialized)
    let offset = 0
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset)
      if (count <= 0) throw new Error(`advisor recovery record write stalled: ${path}`)
      offset += count
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(parent) } finally { closeSync(parent) }
  if (readFileSnapshot(path)?.raw !== serialized) {
    throw new Error(`advisor recovery record was not durable: ${path}`)
  }
}

function cleanupOutcomePath(
  stateDir: string,
  binding: Pick<AdvisorClaudeCleanupOutcome, 'jobId' | 'attemptNonce' | 'inputRevision' | 'inputDigest' | 'phase' | 'round'>,
): string {
  const root = ensureManagedDirectory(stateDir, join(stateDir, 'advisor-round-cleanup'))
  const jobRoot = ensureManagedDirectory(stateDir, join(root, safeJob(binding.jobId)))
  const attemptRoot = ensureManagedDirectory(stateDir, join(jobRoot, binding.attemptNonce))
  const revisionRoot = ensureManagedDirectory(
    stateDir,
    join(attemptRoot, `revision-${binding.inputRevision}-${binding.inputDigest.slice(0, 16)}`),
  )
  return join(revisionRoot, `${binding.phase}-${binding.round}.json`)
}

export function persistAdvisorClaudeCleanupOutcome(
  stateDirInput: string,
  outcome: AdvisorClaudeCleanupOutcome,
): void {
  const stateDir = requireManagedStateRoot(stateDirInput)
  if (!NONCE.test(outcome.attemptNonce) || !Number.isSafeInteger(outcome.inputRevision)
    || outcome.inputRevision < 1 || !SHA256.test(outcome.inputDigest)
    || !/^[0-9a-f]{16}$/.test(outcome.inputDigestPrefix)
    || outcome.inputDigest.slice(0, 16) !== outcome.inputDigestPrefix
    || !['investigation', 'design', 'review'].includes(outcome.phase)
    || ![1, 2, 3].includes(outcome.round)) {
    throw new Error('advisor Claude cleanup binding is invalid')
  }
  // Both the broker's normal cleanup path and the runner's crash-recovery
  // path may publish this same receipt.  Build the serialized object in one
  // fixed order so an equivalent replay remains byte-idempotent regardless
  // of the caller's object insertion order.
  const value: Record<string, unknown> = {
    version: 1,
    jobId: outcome.jobId,
    attemptNonce: outcome.attemptNonce,
    inputRevision: outcome.inputRevision,
    inputDigest: outcome.inputDigest,
    inputDigestPrefix: outcome.inputDigestPrefix,
    phase: outcome.phase,
    round: outcome.round,
    workspaceCreationAttempted: outcome.workspaceCreationAttempted,
    freshEphemeral: outcome.freshEphemeral,
    cleanupVerified: outcome.cleanupVerified,
    ...(outcome.cleanupStatus === undefined
      ? {} : { cleanupStatus: outcome.cleanupStatus }),
    ...(outcome.cleanupReceiptDigest === undefined
      ? {} : { cleanupReceiptDigest: outcome.cleanupReceiptDigest }),
    promptMayHaveBeenDelivered: outcome.promptMayHaveBeenDelivered,
  }
  writeIdempotent(cleanupOutcomePath(stateDir, outcome), value)
}

function readCleanupOutcome(
  stateDir: string,
  journal: Record<string, unknown>,
): AdvisorClaudeCleanupOutcome | null {
  const binding = {
    jobId: String(journal.jobId ?? ''),
    attemptNonce: String(journal.attemptNonce ?? ''),
    inputRevision: Number(journal.inputRevision),
    inputDigest: String(journal.inputDigest ?? ''),
    phase: journal.phase as 'investigation' | 'design' | 'review',
    round: Number(journal.round) as 1 | 2 | 3,
  }
  const snapshot = readFileSnapshot(cleanupOutcomePath(stateDir, binding))
  if (!snapshot) return null
  const value = parseObject(snapshot.raw, 'advisor Claude cleanup outcome')
  if (value.version !== 1 || value.jobId !== binding.jobId
    || value.attemptNonce !== binding.attemptNonce
    || value.inputRevision !== binding.inputRevision || value.inputDigest !== binding.inputDigest
    || value.inputDigestPrefix !== binding.inputDigest.slice(0, 16)
    || value.phase !== binding.phase || value.round !== binding.round
    || typeof value.workspaceCreationAttempted !== 'boolean'
    || typeof value.freshEphemeral !== 'boolean'
    || typeof value.cleanupVerified !== 'boolean'
    || typeof value.promptMayHaveBeenDelivered !== 'boolean') {
    throw new Error('advisor Claude cleanup outcome does not match its journal')
  }
  return value as AdvisorClaudeCleanupOutcome
}

function processNonceFromFingerprint(fingerprint: SeatbeltFingerprint): string {
  const allowParent = dirname(fingerprint.allow.path)
  if (allowParent !== dirname(fingerprint.deny.path) || basename(fingerprint.allow.path) !== 'allow'
    || basename(fingerprint.deny.path) !== 'deny' || !NONCE.test(basename(allowParent))) {
    throw new Error('advisor recovery fingerprint path is invalid')
  }
  return basename(allowParent)
}

function validExecutorIdentity(value: ExecutorIdentity): boolean {
  return Number.isSafeInteger(value.pid) && value.pid > 0 && value.pgid === value.pid
    && typeof value.started === 'string' && value.started.length > 0
    && typeof value.bootSession === 'string' && value.bootSession.length > 0
    && Number.isSafeInteger(value.startSec) && value.startSec > 0
    && Number.isSafeInteger(value.startUsec) && value.startUsec >= 0
    && value.startUsec <= 999_999
}

function requestedRound(
  stateDir: string,
  jobId: string,
  attemptNonce: string,
  processNonce: string,
): { path: string; journal: Record<string, unknown>; snapshot: FileSnapshot } | null {
  const attemptRootPath = join(
    stateDir, 'advisor-journal', safeJob(jobId), attemptNonce,
  )
  if (!existsSync(attemptRootPath)) return null
  const attemptRoot = requireManagedDirectory(stateDir, attemptRootPath)
  const matches: Array<{ path: string; journal: Record<string, unknown>; snapshot: FileSnapshot }> = []
  for (const entry of readdirSync(attemptRoot, { withFileTypes: true })) {
    if (!REVISION.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
    const revisionRoot = requireManagedDirectory(stateDir, join(attemptRoot, entry.name))
    for (const journalEntry of readdirSync(revisionRoot, { withFileTypes: true })) {
      if (!ROUND.test(journalEntry.name) || !journalEntry.isFile() || journalEntry.isSymbolicLink()) continue
      const path = join(revisionRoot, journalEntry.name)
      const snapshot = readFileSnapshot(path)
      if (!snapshot) continue
      const journal = parseObject(snapshot.raw, 'advisor requested journal')
      if (journal.version === 8 && journal.status === 'requested'
        && journal.jobId === jobId && journal.attemptNonce === attemptNonce
        && journal.processNonce === processNonce) {
        matches.push({ path, journal, snapshot })
      }
    }
  }
  if (matches.length > 1) throw new Error('multiple requested advisor rounds share one process')
  return matches[0] ?? null
}

function retirementRoot(stateDir: string, jobId: string, attemptNonce: string): string {
  const root = ensureManagedDirectory(stateDir, join(stateDir, 'advisor-retirement'))
  const jobRoot = ensureManagedDirectory(stateDir, join(root, safeJob(jobId)))
  return ensureManagedDirectory(stateDir, join(jobRoot, attemptNonce))
}

export function recordAdvisorExecutorRetirement(options: {
  stateDir: string
  jobId: string
  attemptNonce: string
  contextDigest: string
  fingerprint: SeatbeltFingerprint
  supervisor: ExecutorIdentity
  retiredAt?: number
}): { recorded: boolean; processNonce: string } {
  const stateDir = requireManagedStateRoot(options.stateDir)
  if (!NONCE.test(options.attemptNonce) || !SHA256.test(options.contextDigest)
    || !validExecutorIdentity(options.supervisor)) {
    throw new Error('advisor executor retirement binding is invalid')
  }
  const processNonce = processNonceFromFingerprint(options.fingerprint)
  const requested = requestedRound(
    stateDir, options.jobId, options.attemptNonce, processNonce,
  )
  if (!requested) return { recorded: false, processNonce }
  const journal = requested.journal
  if (journal.contextDigest !== options.contextDigest
    || journal.brokerProcessId === undefined || !Number.isSafeInteger(journal.brokerProcessId)
    || Number(journal.brokerProcessId) <= 0 || !SHA256.test(String(journal.inputDigest ?? ''))
    || !Number.isSafeInteger(journal.inputRevision) || Number(journal.inputRevision) < 1
    || !['investigation', 'design', 'review'].includes(String(journal.phase))
    || ![1, 2, 3].includes(Number(journal.round))) {
    throw new Error('requested advisor journal cannot be bound to its executor')
  }
  const attemptRoot = dirname(dirname(requested.path))
  const lockPath = join(attemptRoot, 'active-round.lock')
  const lock = readFileSnapshot(lockPath)
  if (!lock) throw new Error('requested advisor round omitted its active claim')
  const lockValue = parseObject(lock.raw, 'advisor active claim')
  if (lockValue.version !== 2 || lockValue.jobId !== options.jobId
    || lockValue.attemptNonce !== options.attemptNonce || lockValue.processNonce !== processNonce
    || lockValue.contextDigest !== options.contextDigest
    || lockValue.phase !== journal.phase || lockValue.round !== journal.round
    || lockValue.inputRevision !== journal.inputRevision || lockValue.inputDigest !== journal.inputDigest
    || lockValue.brokerProcessId !== journal.brokerProcessId) {
    throw new Error('advisor active claim does not match its requested journal')
  }
  const recoveryId = randomBytes(32).toString('hex')
  const retiredAt = options.retiredAt ?? Date.now()
  if (!Number.isSafeInteger(retiredAt) || retiredAt <= 0) {
    throw new Error('advisor executor retirement time is invalid')
  }
  const path = join(retirementRoot(stateDir, options.jobId, options.attemptNonce), `${processNonce}.json`)
  const existing = readFileSnapshot(path)
  if (existing) {
    const value = parseObject(existing.raw, 'advisor retirement receipt') as RetirementRecord
    if (value.version !== 1 || value.jobId !== options.jobId
      || value.attemptNonce !== options.attemptNonce || value.processNonce !== processNonce
      || value.contextDigest !== options.contextDigest
      || value.journalDigest !== requested.snapshot.digest || value.lockDigest !== lock.digest
      || value.lockDev !== lock.dev || value.lockIno !== lock.ino
      || value.fingerprintDigest !== sha256(JSON.stringify(options.fingerprint))
      || JSON.stringify(value.supervisor) !== JSON.stringify(options.supervisor)
      || value.seatbeltCleanupVerified !== true) {
      throw new Error('advisor retirement receipt conflicts with the executor generation')
    }
    return { recorded: true, processNonce }
  }
  const receipt: RetirementRecord = {
    version: 1,
    status: 'supervisor-retired',
    recoveryId,
    jobId: options.jobId,
    attemptNonce: options.attemptNonce,
    processNonce,
    contextDigest: options.contextDigest,
    inputRevision: Number(journal.inputRevision),
    inputDigest: String(journal.inputDigest),
    phase: journal.phase as RetirementRecord['phase'],
    round: Number(journal.round) as RetirementRecord['round'],
    journalDigest: requested.snapshot.digest,
    lockDigest: lock.digest,
    lockDev: lock.dev,
    lockIno: lock.ino,
    fingerprintDigest: sha256(JSON.stringify(options.fingerprint)),
    supervisor: options.supervisor,
    seatbeltCleanupVerified: true,
    retiredAt,
  }
  writeIdempotent(path, receipt as unknown as Record<string, unknown>)
  return { recorded: true, processNonce }
}

export function recordAdvisorExecutorRetirementForJob(options: {
  stateDir: string
  jobId: string
  fingerprint: SeatbeltFingerprint
  supervisor: ExecutorIdentity
  retiredAt?: number
}): { recorded: boolean; processNonce: string } {
  const stateDir = requireManagedStateRoot(options.stateDir)
  const processNonce = processNonceFromFingerprint(options.fingerprint)
  const jobRootPath = join(stateDir, 'advisor-journal', safeJob(options.jobId))
  if (!existsSync(jobRootPath)) return { recorded: false, processNonce }
  const jobRoot = requireManagedDirectory(stateDir, jobRootPath)
  const bindings: Array<{ attemptNonce: string; contextDigest: string }> = []
  for (const entry of readdirSync(jobRoot, { withFileTypes: true })) {
    if (!NONCE.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
    const requested = requestedRound(stateDir, options.jobId, entry.name, processNonce)
    if (!requested) continue
    if (!SHA256.test(String(requested.journal.contextDigest ?? ''))) {
      throw new Error('requested advisor journal context digest is invalid')
    }
    bindings.push({
      attemptNonce: entry.name,
      contextDigest: String(requested.journal.contextDigest),
    })
  }
  if (bindings.length > 1) {
    throw new Error('one executor generation is bound to multiple advisor attempts')
  }
  const binding = bindings[0]
  if (!binding) return { recorded: false, processNonce }
  return recordAdvisorExecutorRetirement({
    ...options,
    ...binding,
  })
}

function parseRetirement(raw: string): RetirementRecord {
  const value = parseObject(raw, 'advisor retirement receipt') as RetirementRecord
  if (value.version !== 1 || !['supervisor-retired', 'round-finalized'].includes(value.status)
    || !SHA256.test(value.recoveryId) || !NONCE.test(value.attemptNonce)
    || !NONCE.test(value.processNonce) || !SHA256.test(value.contextDigest)
    || !SHA256.test(value.inputDigest) || !SHA256.test(value.journalDigest)
    || !SHA256.test(value.lockDigest) || !SHA256.test(value.fingerprintDigest)
    || !Number.isSafeInteger(value.inputRevision) || value.inputRevision < 1
    || !['investigation', 'design', 'review'].includes(value.phase)
    || ![1, 2, 3].includes(value.round) || !validExecutorIdentity(value.supervisor)
    || value.seatbeltCleanupVerified !== true || !Number.isSafeInteger(value.retiredAt)
    || value.retiredAt <= 0) {
    throw new Error('advisor retirement receipt is invalid')
  }
  return value
}

function contextRepositoryDigest(
  stateDir: string,
  receipt: RetirementRecord,
): string {
  const contextPath = join(
    stateDir, 'advisor-context', safeJob(receipt.jobId), `${receipt.attemptNonce}.json`,
  )
  const snapshot = readFileSnapshot(contextPath)
  if (!snapshot) throw new Error('advisor recovery context is missing')
  const context = parseObject(snapshot.raw, 'advisor recovery context')
  if (context.version !== 4 || context.jobId !== receipt.jobId
    || context.attemptNonce !== receipt.attemptNonce
    || sha256(JSON.stringify(context)) !== receipt.contextDigest
    || typeof context.repoPath !== 'string') {
    throw new Error('advisor recovery context does not match its receipt')
  }
  return advisorRepositoryDigest(snapshotAdvisorRepository(
    resolveAdvisorProjectLayout(String(context.repoPath)),
  ))
}

function releaseLockExact(path: string, receipt: RetirementRecord): void {
  const lock = readFileSnapshot(path)
  if (!lock) return
  if (lock.dev !== receipt.lockDev || lock.ino !== receipt.lockIno
    || lock.digest !== receipt.lockDigest) {
    throw new Error('advisor active claim changed before recovered release')
  }
  const metadata = lstatSync(path)
  if (metadata.dev !== receipt.lockDev || metadata.ino !== receipt.lockIno) {
    throw new Error('advisor active claim path changed before recovered release')
  }
  unlinkSync(path)
}

function recoveredClaudeJournal(outcome: AdvisorClaudeCleanupOutcome | null): Record<string, unknown> {
  const reasonDigest = sha256('ephemeral Claude round ended with its retired Codex generation')
  if (!outcome) {
    return {
      attempted: true,
      required: true,
      lifecycle: 'ephemeral-v2',
      adopted: false,
      workspaceCreationAttempted: false,
      freshEphemeral: false,
      cleanupVerified: false,
      containmentVerified: true,
      promptMayHaveBeenDelivered: false,
      reasonDigest,
    }
  }
  return {
    attempted: true,
    required: true,
    lifecycle: 'ephemeral-v2',
    adopted: false,
    workspaceCreationAttempted: outcome.workspaceCreationAttempted,
    freshEphemeral: outcome.freshEphemeral,
    cleanupVerified: outcome.cleanupVerified,
    cleanupStatus: outcome.cleanupStatus,
    cleanupReceiptDigest: outcome.cleanupReceiptDigest,
    containmentVerified: !outcome.workspaceCreationAttempted || outcome.cleanupVerified,
    promptMayHaveBeenDelivered: outcome.promptMayHaveBeenDelivered,
    reasonDigest,
  }
}

export function finalizeRetiredAdvisorRounds(stateDirInput: string): { finalized: number } {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const rootPath = join(stateDir, 'advisor-retirement')
  if (!existsSync(rootPath)) return { finalized: 0 }
  const root = requireManagedDirectory(stateDir, rootPath)
  let finalized = 0
  for (const jobEntry of readdirSync(root, { withFileTypes: true })) {
    if (!jobEntry.isDirectory() || jobEntry.isSymbolicLink()) continue
    const jobRoot = requireManagedDirectory(stateDir, join(root, jobEntry.name))
    for (const attemptEntry of readdirSync(jobRoot, { withFileTypes: true })) {
      if (!NONCE.test(attemptEntry.name) || !attemptEntry.isDirectory()
        || attemptEntry.isSymbolicLink()) continue
      const attemptRoot = requireManagedDirectory(stateDir, join(jobRoot, attemptEntry.name))
      for (const receiptEntry of readdirSync(attemptRoot, { withFileTypes: true })) {
        if (!/^[0-9a-f]{32}\.json$/.test(receiptEntry.name)
          || !receiptEntry.isFile() || receiptEntry.isSymbolicLink()) continue
        const receiptPath = join(attemptRoot, receiptEntry.name)
        const receiptSnapshot = readFileSnapshot(receiptPath)
        if (!receiptSnapshot) continue
        const receipt = parseRetirement(receiptSnapshot.raw)
        if (receipt.status === 'round-finalized') continue
        const revisionRoot = join(
          stateDir, 'advisor-journal', safeJob(receipt.jobId), receipt.attemptNonce,
          `revision-${receipt.inputRevision}-${receipt.inputDigest.slice(0, 16)}`,
        )
        const journalPath = join(revisionRoot, `${receipt.phase}-${receipt.round}.json`)
        const lockPath = join(dirname(revisionRoot), 'active-round.lock')
        const journalSnapshot = readFileSnapshot(journalPath)
        if (!journalSnapshot) throw new Error('retired advisor journal is missing')
        const journal = parseObject(journalSnapshot.raw, 'retired advisor journal')
        if (['reviewers-completed', 'stale-input'].includes(String(journal.status))
          && journal.recoveredAfterInterruption === true
          && journal.recoveryId === receipt.recoveryId) {
          releaseLockExact(lockPath, receipt)
        } else {
          if (journalSnapshot.digest !== receipt.journalDigest || journal.status !== 'requested'
            || journal.processNonce !== receipt.processNonce
            || journal.contextDigest !== receipt.contextDigest) {
            throw new Error('retired advisor journal changed before terminal recovery')
          }
          const latestInput = readAdvisorInputSnapshot(stateDir, receipt.jobId)
          const inputUnchanged = latestInput.revision === receipt.inputRevision
            && latestInput.digest === receipt.inputDigest
          const repositoryDigestAfter = contextRepositoryDigest(stateDir, receipt)
          const repositoryUnchanged = repositoryDigestAfter === journal.repositoryDigest
          const cleanupOutcome = readCleanupOutcome(stateDir, {
            ...journal,
            jobId: receipt.jobId,
          })
          if (!cleanupOutcome && existsSync(join(
            stateDir, 'advisor-ephemeral', receipt.jobId, receipt.attemptNonce,
            `revision-${receipt.inputRevision}-${receipt.inputDigest.slice(0, 16)}`,
            `${receipt.phase}-${receipt.round}`,
          ))) {
            throw new Error('retired advisor Claude workspace cleanup is still pending')
          }
          const claude = recoveredClaudeJournal(cleanupOutcome)
          const terminalStatus = inputUnchanged && repositoryUnchanged
            ? 'reviewers-completed'
            : 'stale-input'
          const finishedAt = Math.max(Date.now(), Number(journal.startedAt) || 0)
          const reason = 'reviewer process ended at a verified interjection generation boundary'
          const grok = (['solution', 'risk'] as const).map(perspective => ({
            attempted: true,
            adopted: false,
            perspective,
            containmentVerified: true,
            reasonDigest: sha256(reason),
          }))
          atomicWritePrivateFile(journalPath, `${JSON.stringify({
            ...journal,
            status: terminalStatus,
            repositoryDigestAfter,
            inputUnchanged,
            recoveredAfterInterruption: true,
            recoveryId: receipt.recoveryId,
            finishedAt,
            grok,
            claude,
          })}\n`)
          const terminal = readFileSnapshot(journalPath)
          if (!terminal) throw new Error('recovered advisor terminal journal is missing')
          const terminalValue = parseObject(terminal.raw, 'recovered advisor terminal journal')
          if (terminalValue.status !== terminalStatus
            || terminalValue.recoveryId !== receipt.recoveryId) {
            throw new Error('recovered advisor terminal journal was not durable')
          }
          releaseLockExact(lockPath, receipt)
        }
        const terminal = readFileSnapshot(journalPath)
        if (!terminal) throw new Error('recovered advisor terminal journal disappeared')
        const finalizedAt = Date.now()
        atomicWritePrivateFile(receiptPath, `${JSON.stringify({
          ...receipt,
          status: 'round-finalized',
          finalizedAt,
          terminalJournalDigest: terminal.digest,
        })}\n`)
        finalized += 1
      }
    }
  }
  return { finalized }
}
