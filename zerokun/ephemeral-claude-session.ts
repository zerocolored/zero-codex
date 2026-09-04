import { createHash, randomBytes } from 'crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import {
  environmentForPinnedHerdrRuntime,
  verifyHerdrRuntimeIdentityAsync,
  type HerdrRuntimeIdentity,
} from './herdr-runtime.ts'
import { resolveFifthAdvisorRecoveryHelper } from './install-fifth-advisor.ts'
import { resolveCodexExecutableDetails } from './standalone-codex.ts'
import {
  ensureManagedDirectory,
  requireManagedDirectory,
  requireManagedStateRoot,
} from './managed-path.ts'
import {
  assertDescriptorStillNamesPath,
  readOptionalBoundedOwnerOnlyRegularFile,
  readOptionalOwnerOnlyRegularFile,
} from './safe-file.ts'

export const EPHEMERAL_CLAUDE_STATE_ROOT = 'advisor-ephemeral' as const
export const EPHEMERAL_CLAUDE_TRASH_ROOT = 'advisor-ephemeral-closed' as const
export const EPHEMERAL_CLAUDE_CLOSED_RECEIPT = 'ephemeral-session-closed.json' as const
export const EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE = 'ephemeral-delivery.json' as const
export const MAX_EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE_BYTES = 4 * 1024
const EPHEMERAL_CLAUDE_INTENT = 'ephemeral-session-intent.json'
const EPHEMERAL_CLAUDE_WORKSPACE_RECEIPT = 'ephemeral-workspace-receipt.json'
const EPHEMERAL_CLAUDE_ATOMIC_RECORDS = [
  'protected-snapshot.json',
  EPHEMERAL_CLAUDE_INTENT,
  EPHEMERAL_CLAUDE_WORKSPACE_RECEIPT,
  'ephemeral-agent-start-intent.json',
  'ephemeral-agent-receipt.json',
  'ephemeral-send-receipt.json',
  EPHEMERAL_CLAUDE_CLOSED_RECEIPT,
  'ephemeral-process-mismatch.json',
] as const
const EPHEMERAL_CLAUDE_STAGED_REQUEST_FILES = new Set(
  EPHEMERAL_CLAUDE_ATOMIC_RECORDS.map(name => `.${name}.pending`),
)
const EPHEMERAL_CLAUDE_REQUEST_FILES = new Set([
  'prompt',
  'protected-snapshot.json',
  EPHEMERAL_CLAUDE_INTENT,
  EPHEMERAL_CLAUDE_WORKSPACE_RECEIPT,
  'ephemeral-agent-receipt.json',
  'ephemeral-agent-start-intent.json',
  'ephemeral-send-receipt.json',
  EPHEMERAL_CLAUDE_CLOSED_RECEIPT,
  'ephemeral-process-mismatch.json',
  ...EPHEMERAL_CLAUDE_STAGED_REQUEST_FILES,
])

const JOB_COMPONENT = /^[A-Za-z0-9._-]+$/
const ATTEMPT_COMPONENT = /^[0-9a-f]{32}$/
const REVISION_COMPONENT = /^revision-[1-9][0-9]*-[0-9a-f]{16}$/
const ROUND_COMPONENT = /^(?:investigation|design|review)-[123]$/
const TRASH_COMPONENT = /^closed-[0-9a-f]{32}$/
const AGENT_NAME = /^fifth-[0-9a-f]{20}$/
const WORKSPACE_ID = /^w[0-9A-Za-z]+$/
const PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/
const TAB_ID = /^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/
const TERMINAL_ID = /^term_[0-9a-f]+$/

export type EphemeralClaudeDeliveryEvidence = {
  version: 1
  status: 'delivery-possible'
  jobId: string
  attemptNonce: string
  receiptDigest: string
}

function encodeEphemeralClaudeDeliveryEvidence(
  evidence: EphemeralClaudeDeliveryEvidence,
): string {
  return `${JSON.stringify({
    version: evidence.version,
    status: evidence.status,
    jobId: evidence.jobId,
    attemptNonce: evidence.attemptNonce,
    receiptDigest: evidence.receiptDigest,
  })}\n`
}

function createEphemeralClaudeDeliveryEvidenceExclusive(
  attemptRoot: string,
  evidencePath: string,
  evidence: string,
): boolean {
  let descriptor: number
  try {
    descriptor = openSync(
      evidencePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  let failure: unknown
  try {
    fchmodSync(descriptor, 0o600)
    const metadata = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches
      || (metadata.mode & 0o077) !== 0) {
      throw new Error('ephemeral Claude delivery evidence file is unsafe')
    }
    const content = Buffer.from(evidence, 'utf8')
    let offset = 0
    while (offset < content.length) {
      const count = writeSync(descriptor, content, offset, content.length - offset)
      if (count <= 0) throw new Error('ephemeral Claude delivery evidence write stalled')
      offset += count
    }
    fsyncSync(descriptor)
  } catch (error) {
    failure = error
  } finally {
    closeSync(descriptor)
  }
  try {
    // Persist either the complete latch or a fail-closed partial sentinel. The
    // latter is never repaired automatically after an ambiguous delivery.
    syncOwnedDirectory(attemptRoot)
  } catch (error) {
    failure ??= error
  }
  if (failure) throw failure
  return true
}

function synchronizeExistingEphemeralClaudeDeliveryEvidence(
  attemptRoot: string,
  evidencePath: string,
  expectedJobId: string,
  expectedAttemptNonce: string,
): void {
  const descriptor = openSync(
    evidencePath,
    constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const before = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || before.uid === process.getuid()
    if (!before.isFile() || before.nlink !== 1 || !ownerMatches
      || (before.mode & 0o777) !== 0o600
      || before.size > MAX_EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE_BYTES) {
      throw new Error('existing ephemeral Claude delivery evidence is unsafe')
    }
    const content = Buffer.alloc(MAX_EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE_BYTES + 1)
    let offset = 0
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, null)
      if (count === 0) break
      offset += count
    }
    if (offset > MAX_EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE_BYTES) {
      throw new Error('existing ephemeral Claude delivery evidence is too large')
    }
    parseEphemeralClaudeDeliveryEvidence(
      content.subarray(0, offset).toString('utf8'),
      expectedJobId,
      expectedAttemptNonce,
    )
    fsyncSync(descriptor)
    const after = fstatSync(descriptor)
    for (const key of [
      'dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs',
    ] as const) {
      if (before[key] !== after[key]) {
        throw new Error('existing ephemeral Claude delivery evidence changed while syncing')
      }
    }
    assertDescriptorStillNamesPath(descriptor, evidencePath)
  } finally {
    closeSync(descriptor)
  }
  syncOwnedDirectory(attemptRoot)
}

export function parseEphemeralClaudeDeliveryEvidence(
  raw: string,
  expectedJobId: string,
  expectedAttemptNonce: string,
): EphemeralClaudeDeliveryEvidence {
  if (Buffer.byteLength(raw) > MAX_EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE_BYTES) {
    throw new Error('ephemeral Claude delivery evidence is too large')
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new Error('ephemeral Claude delivery evidence is invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ephemeral Claude delivery evidence is invalid')
  }
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).sort().join(',')
      !== 'attemptNonce,jobId,receiptDigest,status,version'
    || record.version !== 1
    || record.status !== 'delivery-possible'
    || record.jobId !== expectedJobId
    || record.attemptNonce !== expectedAttemptNonce
    || typeof record.receiptDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(record.receiptDigest)) {
    throw new Error('ephemeral Claude delivery evidence binding is invalid')
  }
  const evidence: EphemeralClaudeDeliveryEvidence = {
    version: 1,
    status: 'delivery-possible',
    jobId: expectedJobId,
    attemptNonce: expectedAttemptNonce,
    receiptDigest: record.receiptDigest,
  }
  if (raw !== encodeEphemeralClaudeDeliveryEvidence(evidence)) {
    throw new Error('ephemeral Claude delivery evidence is not canonical')
  }
  return evidence
}

export type EphemeralClaudeTarget = {
  target: string
  workspaceId: string
  paneId: string
  terminalId: string
  nativeSession: string
  stateChangeSeq: number
}

export class EphemeralClaudeCleanupPendingError extends Error {}
export class EphemeralClaudeOwnedProcessStillLiveError
  extends EphemeralClaudeCleanupPendingError {}

export function cleanupDiagnosticConfirmsOwnedProcessStillLive(stderr: string): boolean {
  return stderr.includes('ephemeral Claude process survived workspace cleanup')
    || stderr.includes('ephemeral owned workspace still exists')
    || stderr.includes('provisional owned workspace still exists')
}

type EphemeralClaudeIntent = {
  nonce: string
  label: string
  agentName: string
  projectRoot: string
  projectRootDevice: number
  projectRootInode: number
}

function jsonRecords(stdout: string): Record<string, unknown>[] {
  return stdout.split(/\r?\n/).flatMap(line => {
    try {
      const value = JSON.parse(line) as unknown
      return value && typeof value === 'object' && !Array.isArray(value)
        ? [value as Record<string, unknown>]
        : []
    } catch {
      return []
    }
  })
}

export function parseEphemeralClaudeOpen(stdout: string): EphemeralClaudeTarget {
  const matches = jsonRecords(stdout).filter(record => record.status === 'ephemeral-claude-ready')
  if (matches.length !== 1) throw new Error('helper did not return one ephemeral Claude identity')
  const record = matches[0]!
  if (typeof record.target !== 'string' || !AGENT_NAME.test(record.target)
    || typeof record.workspace_id !== 'string' || !WORKSPACE_ID.test(record.workspace_id)
    || typeof record.pane_id !== 'string' || !PANE_ID.test(record.pane_id)
    || typeof record.terminal_id !== 'string' || !TERMINAL_ID.test(record.terminal_id)
    || typeof record.native_session !== 'string' || !record.native_session
    || !Number.isSafeInteger(record.state_change_seq) || Number(record.state_change_seq) < 0) {
    throw new Error('helper returned an incomplete ephemeral Claude identity')
  }
  return {
    target: record.target,
    workspaceId: record.workspace_id,
    paneId: record.pane_id,
    terminalId: record.terminal_id,
    nativeSession: record.native_session,
    stateChangeSeq: Number(record.state_change_seq),
  }
}

export function ephemeralClaudeAgentMatches(
  value: {
    agent?: string
    agent_session?: { value?: string } | null
    cwd?: string
    pane_id?: string
    terminal_id?: string
    workspace_id?: string
    state_change_seq?: number
  },
  target: EphemeralClaudeTarget,
  projectRoot: string,
): boolean {
  const nativeSessionMatches = target.nativeSession === 'N/A:safe-mode'
    ? value.agent_session == null
    : value.agent_session?.value === target.nativeSession
  return value.agent === 'claude'
    && nativeSessionMatches
    && value.cwd === projectRoot
    && value.pane_id === target.paneId
    && value.terminal_id === target.terminalId
    && value.workspace_id === target.workspaceId
    && Number.isSafeInteger(value.state_change_seq)
}

export function parseEphemeralClaudeClose(
  stdout: string,
  target: EphemeralClaudeTarget,
): { processIdentityWarning: boolean } {
  const matches = jsonRecords(stdout).filter(record => (
    record.status === 'ephemeral-workspace-closed'
    || record.status === 'ephemeral-workspace-already-closed'
  ))
  if (matches.length !== 1) throw new Error('helper did not confirm ephemeral workspace cleanup')
  const record = matches[0]!
  if (record.workspace_id !== target.workspaceId || record.pane_id !== target.paneId
    || record.agent_name !== target.target
    || (record.process_identity_warning !== undefined
      && typeof record.process_identity_warning !== 'boolean')) {
    throw new Error('helper cleanup receipt does not match the owned ephemeral workspace')
  }
  return { processIdentityWarning: record.process_identity_warning === true }
}

export function readEphemeralClaudeCleanupReceipt(
  requestDir: string,
  target: EphemeralClaudeTarget,
): { digest: string; status: string } {
  const raw = readOptionalOwnerOnlyRegularFile(join(requestDir, EPHEMERAL_CLAUDE_CLOSED_RECEIPT))
  if (raw === null || Buffer.byteLength(raw) > 128 * 1024) {
    throw new Error('ephemeral Claude cleanup receipt is missing or too large')
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new Error('ephemeral Claude cleanup receipt is invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ephemeral Claude cleanup receipt is invalid')
  }
  const receipt = parsed as Record<string, unknown>
  const intent = readEphemeralClaudeIntent(requestDir)
  const exactOwnedAbsence = receipt.close_target_verified === true
    && receipt.workspace_absent === true
    && receipt.pane_absent === true
    && receipt.agent_absent === true
  const legacyExactCleanup = receipt.caller_restored === true
    && receipt.focus_verified === true
    && receipt.catalog_restored === true
    && receipt.agent_identity_verified === true
    && receipt.project_location_verified === true
    && receipt.protected_unchanged === true
  if (receipt.version !== 2
    || receipt.nonce !== intent.nonce
    || receipt.status !== 'closed-and-verified'
    || receipt.workspace_id !== target.workspaceId
    || receipt.pane_id !== target.paneId
    || receipt.agent_name !== target.target
    || (!exactOwnedAbsence && !legacyExactCleanup)
    || receipt.processes_exited !== true) {
    throw new Error('ephemeral Claude cleanup receipt did not verify exact cleanup')
  }
  return {
    digest: createHash('sha256').update(raw).digest('hex'),
    status: String(receipt.status),
  }
}

export function readEphemeralClaudeWorkspaceTarget(
  requestDir: string,
  projectRoot: string,
): EphemeralClaudeTarget | null {
  const raw = readOptionalOwnerOnlyRegularFile(
    join(requestDir, EPHEMERAL_CLAUDE_WORKSPACE_RECEIPT),
  )
  if (raw === null) return null
  if (Buffer.byteLength(raw) > 128 * 1024) {
    throw new Error('ephemeral Claude workspace receipt is too large')
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new Error('ephemeral Claude workspace receipt is invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ephemeral Claude workspace receipt is invalid')
  }
  const receipt = parsed as Record<string, unknown>
  const intent = readEphemeralClaudeIntent(requestDir)
  if (intent.projectRoot !== projectRoot
    || receipt.version !== 2 || receipt.nonce !== intent.nonce
    || receipt.label !== intent.label || receipt.agent_name !== intent.agentName
    || receipt.project_root !== intent.projectRoot
    || receipt.project_root_dev !== intent.projectRootDevice
    || receipt.project_root_ino !== intent.projectRootInode
    || typeof receipt.agent_name !== 'string' || !AGENT_NAME.test(receipt.agent_name)
    || typeof receipt.workspace_id !== 'string' || !WORKSPACE_ID.test(receipt.workspace_id)
    || typeof receipt.tab_id !== 'string' || !TAB_ID.test(receipt.tab_id)
    || typeof receipt.pane_id !== 'string' || !PANE_ID.test(receipt.pane_id)
    || typeof receipt.terminal_id !== 'string' || !TERMINAL_ID.test(receipt.terminal_id)) {
    throw new Error('ephemeral Claude workspace receipt is incomplete')
  }
  return {
    target: receipt.agent_name,
    workspaceId: receipt.workspace_id,
    paneId: receipt.pane_id,
    terminalId: receipt.terminal_id,
    nativeSession: 'N/A:safe-mode',
    stateChangeSeq: 0,
  }
}

export function createEphemeralClaudeRequestDirectory(options: {
  stateDir: string
  jobId: string
  attemptNonce: string
  inputRevision: number
  inputDigest: string
  phase: 'investigation' | 'design' | 'review'
  round: 1 | 2 | 3
}): string {
  const stateDir = requireManagedStateRoot(options.stateDir)
  if (!JOB_COMPONENT.test(options.jobId) || !ATTEMPT_COMPONENT.test(options.attemptNonce)
    || !Number.isSafeInteger(options.inputRevision) || options.inputRevision < 1
    || !/^[0-9a-f]{64}$/.test(options.inputDigest)) {
    throw new Error('ephemeral Claude request binding is invalid')
  }
  const root = ensureManagedDirectory(stateDir, join(stateDir, EPHEMERAL_CLAUDE_STATE_ROOT))
  const jobRoot = ensureManagedDirectory(stateDir, join(root, options.jobId))
  const attemptRoot = ensureManagedDirectory(stateDir, join(jobRoot, options.attemptNonce))
  const revisionRoot = ensureManagedDirectory(
    stateDir,
    join(attemptRoot, `revision-${options.inputRevision}-${options.inputDigest.slice(0, 16)}`),
  )
  const requestDir = join(revisionRoot, `${options.phase}-${options.round}`)
  try { mkdirSync(requestDir, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new EphemeralClaudeCleanupPendingError(
        'this advisor round already owns an ephemeral Claude request directory',
      )
    }
    throw error
  }
  chmodSync(requestDir, 0o700)
  return requireManagedDirectory(stateDir, requestDir)
}

export function resolveClaudeExecutableLookup(options: {
  pathLookup?: string | null
  homeDirectory?: string
} = {}): string {
  const candidates = options.pathLookup === undefined
    ? [
        Bun.which('claude'),
        join(options.homeDirectory ?? homedir(), '.local', 'bin', 'claude'),
      ]
    : [options.pathLookup]
  const visited = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate || visited.has(candidate) || !isAbsolute(candidate)
      || candidate !== resolve(candidate) || basename(candidate) !== 'claude') continue
    visited.add(candidate)
    try {
      resolveCodexExecutableDetails(candidate)
      return candidate
    } catch {}
  }
  throw new Error('Claude executable is unavailable')
}

function verifiedClaudeLookup(): string {
  try {
    return resolveClaudeExecutableLookup()
  } catch {
    throw new EphemeralClaudeCleanupPendingError('Claude executable is unavailable for cleanup')
  }
}

function cleanupEnvironment(
  runtime: HerdrRuntimeIdentity,
  claudeLookup = verifiedClaudeLookup(),
): Record<string, string> {
  if (!isAbsolute(claudeLookup)) {
    throw new EphemeralClaudeCleanupPendingError('Claude executable lookup is invalid')
  }
  return environmentForPinnedHerdrRuntime(runtime, {
    HOME: homedir(),
    PATH: `${dirname(runtime.binary)}:${dirname(claudeLookup)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ZEROKUN_CLAUDE_BIN_PATH: claudeLookup,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'en_US.UTF-8',
    TERM: 'dumb',
  })
}

async function runHelper(
  helper: string,
  command: 'verify' | 'close' | 'recover',
  projectRoot: string,
  requestDir: string,
  environment: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([
    '/usr/bin/python3', helper, command,
    '--project-root', projectRoot,
    '--request-dir', requestDir,
  ], {
    cwd: '/', env: environment, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

export function parseEphemeralClaudeProvisionalRecovery(stdout: string): void {
  const matches = jsonRecords(stdout).filter(record => (
    record.status === 'ephemeral-provisional-reconciled'
    || record.status === 'ephemeral-provisional-already-reconciled'
  ))
  if (matches.length !== 1) {
    throw new Error('helper did not confirm provisional workspace reconciliation')
  }
  const workspaceId = matches[0]!.workspace_id
  if (!(workspaceId === null || (typeof workspaceId === 'string' && WORKSPACE_ID.test(workspaceId)))) {
    throw new Error('helper returned an invalid provisional workspace identity')
  }
}

export function readEphemeralClaudeProvisionalCleanupReceipt(
  requestDir: string,
): { digest: string; status: string } {
  const raw = readOptionalOwnerOnlyRegularFile(join(requestDir, EPHEMERAL_CLAUDE_CLOSED_RECEIPT))
  if (raw === null || Buffer.byteLength(raw) > 128 * 1024) {
    throw new Error('ephemeral Claude provisional cleanup receipt is missing or too large')
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new Error('ephemeral Claude provisional cleanup receipt is invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ephemeral Claude provisional cleanup receipt is invalid')
  }
  const receipt = parsed as Record<string, unknown>
  const intent = readEphemeralClaudeIntent(requestDir)
  const closedWorkspace = receipt.status === 'provisional-workspace-closed'
  const notCreated = receipt.status === 'provisional-workspace-not-created'
  const exactAbsence = receipt.workspace_absent === true && receipt.label_absent === true
  const legacyVerification = receipt.caller_restored === true
    && receipt.catalog_restored === true
    && receipt.project_location_verified === true
    && receipt.protected_unchanged === true
  if (receipt.version !== 2 || receipt.nonce !== intent.nonce
    || (!closedWorkspace && !notCreated)
    || (closedWorkspace
      ? typeof receipt.workspace_id !== 'string' || !WORKSPACE_ID.test(receipt.workspace_id)
        || !['caller', 'owned'].includes(String(receipt.focus_before))
      : receipt.workspace_id !== null)
    || (!exactAbsence && !legacyVerification)) {
    throw new Error('ephemeral Claude provisional cleanup was not fully verified')
  }
  return {
    digest: createHash('sha256').update(raw).digest('hex'),
    status: String(receipt.status),
  }
}

export function persistEphemeralClaudeDeliveryEvidence(
  stateDirInput: string,
  requestDir: string,
): void {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const lifecycleRoot = requireManagedDirectory(
    stateDir,
    join(stateDir, EPHEMERAL_CLAUDE_STATE_ROOT),
  )
  const components = relative(lifecycleRoot, requestDir).split(sep)
  if (components.length !== 4
    || !JOB_COMPONENT.test(components[0]!)
    || !ATTEMPT_COMPONENT.test(components[1]!)
    || !REVISION_COMPONENT.test(components[2]!)
    || !ROUND_COMPONENT.test(components[3]!)) {
    throw new EphemeralClaudeCleanupPendingError('ephemeral Claude delivery path is invalid')
  }
  requireManagedDirectory(stateDir, requestDir)
  const sendReceipt = readOptionalOwnerOnlyRegularFile(join(requestDir, 'ephemeral-send-receipt.json'))
  if (sendReceipt === null) return
  if (Buffer.byteLength(sendReceipt) > 128 * 1024) {
    throw new EphemeralClaudeCleanupPendingError('ephemeral Claude send receipt is too large')
  }
  let parsed: unknown
  try { parsed = JSON.parse(sendReceipt) } catch {
    throw new EphemeralClaudeCleanupPendingError('ephemeral Claude send receipt is invalid JSON')
  }
  const intent = readEphemeralClaudeIntent(requestDir)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed as Record<string, unknown>).sort().join(',')
      !== 'marker,nonce,status,target,version'
    || (parsed as Record<string, unknown>).version !== 2
    || (parsed as Record<string, unknown>).nonce !== intent.nonce
    || (parsed as Record<string, unknown>).target !== intent.agentName
    || typeof (parsed as Record<string, unknown>).marker !== 'string'
    || !/^REQUEST_MARKER=[0-9A-F]{32}$/.test(
      String((parsed as Record<string, unknown>).marker),
    )
    || (parsed as Record<string, unknown>).status !== 'delivery-possible') {
    throw new EphemeralClaudeCleanupPendingError('ephemeral Claude send receipt is invalid')
  }
  const jobRoot = ensureManagedDirectory(stateDir, join(stateDir, 'advisor-journal', components[0]!))
  const attemptRoot = ensureManagedDirectory(stateDir, join(jobRoot, components[1]!))
  const evidencePath = join(attemptRoot, EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE)
  const evidence = encodeEphemeralClaudeDeliveryEvidence({
    version: 1,
    status: 'delivery-possible',
    jobId: components[0]!,
    attemptNonce: components[1]!,
    receiptDigest: createHash('sha256').update(sendReceipt).digest('hex'),
  })
  let created: boolean
  try {
    created = createEphemeralClaudeDeliveryEvidenceExclusive(
      attemptRoot,
      evidencePath,
      evidence,
    )
  } catch (error) {
    throw new EphemeralClaudeCleanupPendingError(
      `ephemeral Claude delivery evidence could not be persisted: ${error}`,
    )
  }
  if (!created) {
    try {
      synchronizeExistingEphemeralClaudeDeliveryEvidence(
        attemptRoot,
        evidencePath,
        components[0]!,
        components[1]!,
      )
    } catch (error) {
      throw new EphemeralClaudeCleanupPendingError(
        `ephemeral Claude delivery evidence conflicts: ${error}`,
      )
    }
    // This is an attempt-level may-have-delivered latch. Later fresh rounds
    // intentionally keep the first valid receipt digest instead of conflicting.
    return
  }
  try {
    const persisted = readOptionalBoundedOwnerOnlyRegularFile(
      evidencePath,
      MAX_EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE_BYTES,
    )
    if (persisted === null) throw new Error('evidence disappeared after persistence')
    parseEphemeralClaudeDeliveryEvidence(persisted, components[0]!, components[1]!)
  } catch (error) {
    throw new EphemeralClaudeCleanupPendingError(
      `ephemeral Claude delivery evidence could not be verified: ${error}`,
    )
  }
}

function readEphemeralClaudeIntent(requestDir: string): EphemeralClaudeIntent {
  const raw = readOptionalOwnerOnlyRegularFile(join(requestDir, EPHEMERAL_CLAUDE_INTENT))
  if (raw === null) throw new Error('ephemeral Claude intent is missing')
  if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('ephemeral Claude intent is too large')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('ephemeral Claude intent is invalid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ephemeral Claude intent is invalid')
  }
  const intent = parsed as Record<string, unknown>
  const caller = intent.caller
  const baseline = intent.baseline_workspace_ids
  const projectRoot = intent.project_root
  const nonce = intent.nonce
  if (intent.version !== 2
    || typeof nonce !== 'string' || !ATTEMPT_COMPONENT.test(nonce)
    || intent.label !== `fifth-advisor-${nonce}`
    || intent.agent_name !== `fifth-${nonce.slice(0, 20)}`
    || typeof projectRoot !== 'string' || !isAbsolute(projectRoot) || projectRoot.includes('\0')
    || !Number.isSafeInteger(intent.project_root_dev) || Number(intent.project_root_dev) < 0
    || !Number.isSafeInteger(intent.project_root_ino) || Number(intent.project_root_ino) <= 0
    || !caller || typeof caller !== 'object' || Array.isArray(caller)
    || typeof (caller as Record<string, unknown>).workspace_id !== 'string'
    || !WORKSPACE_ID.test(String((caller as Record<string, unknown>).workspace_id))
    || typeof (caller as Record<string, unknown>).pane_id !== 'string'
    || !PANE_ID.test(String((caller as Record<string, unknown>).pane_id))
    || typeof (caller as Record<string, unknown>).terminal_id !== 'string'
    || !TERMINAL_ID.test(String((caller as Record<string, unknown>).terminal_id))
    || !Array.isArray(baseline) || baseline.length === 0
    || baseline.some(value => typeof value !== 'string' || !WORKSPACE_ID.test(value))
    || new Set(baseline).size !== baseline.length
    || !baseline.includes((caller as Record<string, unknown>).workspace_id)) {
    throw new Error('ephemeral Claude intent has an invalid project root')
  }
  return {
    nonce,
    label: String(intent.label),
    agentName: String(intent.agent_name),
    projectRoot,
    projectRootDevice: Number(intent.project_root_dev),
    projectRootInode: Number(intent.project_root_ino),
  }
}

function boundedIntentProjectRoot(requestDir: string): string | null {
  if (readOptionalOwnerOnlyRegularFile(join(requestDir, EPHEMERAL_CLAUDE_INTENT)) === null) return null
  return readEphemeralClaudeIntent(requestDir).projectRoot
}

function managedChildren(stateDir: string, root: string, pattern: RegExp): string[] {
  if (!existsSync(root)) return []
  requireManagedDirectory(stateDir, root)
  return readdirSync(root, { withFileTypes: true }).map(entry => {
    if (!pattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new EphemeralClaudeCleanupPendingError(
        `ephemeral Claude state contains an unsafe entry: ${entry.name}`,
      )
    }
    const path = requireManagedDirectory(stateDir, join(root, entry.name))
    const metadata = lstatSync(path)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!ownerMatches || (metadata.mode & 0o077) !== 0) {
      throw new EphemeralClaudeCleanupPendingError(
        `ephemeral Claude state directory is not owner-only: ${entry.name}`,
      )
    }
    return path
  })
}

function removeEmptyParents(paths: string[]): void {
  for (const path of paths) {
    try { rmdirSync(path) } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
}

function requireEphemeralRequestDirectory(stateDir: string, requestDir: string): string {
  const base = requireManagedStateRoot(stateDir)
  const path = requireManagedDirectory(base, requestDir)
  const components = relative(base, path).split(sep)
  if (components.length !== 5 || components[0] !== EPHEMERAL_CLAUDE_STATE_ROOT
    || !JOB_COMPONENT.test(components[1]!) || !ATTEMPT_COMPONENT.test(components[2]!)
    || !REVISION_COMPONENT.test(components[3]!) || !ROUND_COMPONENT.test(components[4]!)) {
    throw new EphemeralClaudeCleanupPendingError(
      'ephemeral Claude request path is outside the fixed lifecycle layout',
    )
  }
  const metadata = lstatSync(path)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownerMatches
    || (metadata.mode & 0o077) !== 0) {
    throw new EphemeralClaudeCleanupPendingError(
      'ephemeral Claude request directory is not owner-only',
    )
  }
  return path
}

function verifyRemovableRequestFiles(requestDir: string): void {
  for (const entry of readdirSync(requestDir, { withFileTypes: true })) {
    if (!EPHEMERAL_CLAUDE_REQUEST_FILES.has(entry.name)) {
      throw new EphemeralClaudeCleanupPendingError(
        `ephemeral Claude request contains an unexpected entry: ${entry.name}`,
      )
    }
    const path = join(requestDir, entry.name)
    const metadata = lstatSync(path)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!entry.isFile() || entry.isSymbolicLink() || !metadata.isFile()
      || metadata.isSymbolicLink() || metadata.nlink !== 1 || !ownerMatches
      || (metadata.mode & 0o077) !== 0) {
      throw new EphemeralClaudeCleanupPendingError(
        `ephemeral Claude request contains an unsafe file: ${entry.name}`,
      )
    }
  }
}

function syncOwnedDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isDirectory() || !ownerMatches || (metadata.mode & 0o077) !== 0) {
      throw new EphemeralClaudeCleanupPendingError(
        `ephemeral Claude directory cannot be durably synchronized: ${path}`,
      )
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function discardStagedEphemeralClaudeRecords(requestDir: string): void {
  let removed = false
  for (const name of EPHEMERAL_CLAUDE_STAGED_REQUEST_FILES) {
    const path = join(requestDir, name)
    let metadata: ReturnType<typeof lstatSync>
    try { metadata = lstatSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || !ownerMatches || (metadata.mode & 0o777) !== 0o600) {
      throw new EphemeralClaudeCleanupPendingError(
        `staged ephemeral Claude record is unsafe: ${name}`,
      )
    }
    unlinkSync(path)
    removed = true
  }
  if (removed) syncOwnedDirectory(requestDir)
}

function purgeEphemeralClaudeTrashDirectory(stateDir: string, path: string): void {
  const root = requireManagedDirectory(stateDir, join(stateDir, EPHEMERAL_CLAUDE_TRASH_ROOT))
  const relativePath = relative(root, requireManagedDirectory(stateDir, path))
  if (relativePath.includes(sep) || !TRASH_COMPONENT.test(relativePath)) {
    throw new EphemeralClaudeCleanupPendingError('invalid ephemeral Claude closed-state path')
  }
  verifyRemovableRequestFiles(path)
  for (const entry of readdirSync(path)) unlinkSync(join(path, entry))
  rmdirSync(path)
}

function drainEphemeralClaudeTrash(stateDir: string): void {
  const root = join(stateDir, EPHEMERAL_CLAUDE_TRASH_ROOT)
  if (!existsSync(root)) return
  for (const path of managedChildren(stateDir, root, TRASH_COMPONENT)) {
    purgeEphemeralClaudeTrashDirectory(stateDir, path)
  }
  removeEmptyParents([root])
}

export function removeVerifiedEphemeralClaudeRequestDirectory(
  stateDir: string,
  requestDir: string,
): void {
  const state = requireManagedStateRoot(stateDir)
  const source = requireEphemeralRequestDirectory(state, requestDir)
  verifyRemovableRequestFiles(source)
  const trashRoot = ensureManagedDirectory(state, join(state, EPHEMERAL_CLAUDE_TRASH_ROOT))
  const trash = join(trashRoot, `closed-${randomBytes(16).toString('hex')}`)
  renameSync(source, trash)
  syncOwnedDirectory(dirname(source))
  syncOwnedDirectory(trashRoot)
  purgeEphemeralClaudeTrashDirectory(state, trash)
  removeEmptyParents([trashRoot])
}

export type EphemeralClaudeReconcileDependencies = {
  resolveHelper?: () => string
  resolveClaudeLookup?: () => string
  runHelper?: typeof runHelper
  verifyRuntime?: typeof verifyHerdrRuntimeIdentityAsync
}

export type ReconciledEphemeralClaudeRound = {
  jobId: string
  attemptNonce: string
  inputRevision: number
  inputDigestPrefix: string
  phase: 'investigation' | 'design' | 'review'
  round: 1 | 2 | 3
  workspaceCreationAttempted: boolean
  freshEphemeral: boolean
  cleanupVerified: boolean
  cleanupStatus?: string
  cleanupReceiptDigest?: string
  promptMayHaveBeenDelivered: boolean
}

export async function reconcileEphemeralClaudeSessions(options: {
  stateDir: string
  runtime: HerdrRuntimeIdentity
  log?: (message: string) => void
  onReconciledRound?: (outcome: ReconciledEphemeralClaudeRound) => void
}, dependencies: EphemeralClaudeReconcileDependencies = {}): Promise<{
  closed: number
  discardedBeforeOpen: number
}> {
  const stateDir = requireManagedStateRoot(options.stateDir)
  drainEphemeralClaudeTrash(stateDir)
  const root = join(stateDir, EPHEMERAL_CLAUDE_STATE_ROOT)
  if (!existsSync(root)) return { closed: 0, discardedBeforeOpen: 0 }
  let environment: Record<string, string> | undefined
  const helperEnvironment = (): Record<string, string> => {
    environment ??= cleanupEnvironment(
      options.runtime,
      dependencies.resolveClaudeLookup?.() ?? verifiedClaudeLookup(),
    )
    return environment
  }
  const verifyRuntime = dependencies.verifyRuntime ?? verifyHerdrRuntimeIdentityAsync
  const run = async (
    command: 'verify' | 'close' | 'recover',
    projectRoot: string,
    requestDir: string,
  ): ReturnType<typeof runHelper> => {
    const helper = (dependencies.resolveHelper ?? resolveFifthAdvisorRecoveryHelper)()
    return (dependencies.runHelper ?? runHelper)(
      helper, command, projectRoot, requestDir, helperEnvironment(),
    )
  }
  let closed = 0
  let discardedBeforeOpen = 0
  let pendingError: EphemeralClaudeCleanupPendingError | undefined
  for (const jobRoot of managedChildren(stateDir, root, JOB_COMPONENT)) {
    for (const attemptRoot of managedChildren(stateDir, jobRoot, ATTEMPT_COMPONENT)) {
      for (const revisionRoot of managedChildren(stateDir, attemptRoot, REVISION_COMPONENT)) {
        for (const requestDir of managedChildren(stateDir, revisionRoot, ROUND_COMPONENT)) {
          try {
            let retainProvisionalAbsenceGuard = false
            discardStagedEphemeralClaudeRecords(requestDir)
            const relativeComponents = relative(root, requestDir).split(sep)
            const revisionMatch = /^revision-([1-9][0-9]*)-([0-9a-f]{16})$/
              .exec(relativeComponents[2] ?? '')
            const roundMatch = /^(investigation|design|review)-([123])$/
              .exec(relativeComponents[3] ?? '')
            if (relativeComponents.length !== 4 || !revisionMatch || !roundMatch) {
              throw new EphemeralClaudeCleanupPendingError(
                'ephemeral Claude reconciliation binding is invalid',
              )
            }
            const binding = {
              jobId: relativeComponents[0]!,
              attemptNonce: relativeComponents[1]!,
              inputRevision: Number(revisionMatch[1]),
              inputDigestPrefix: revisionMatch[2]!,
              phase: roundMatch[1] as 'investigation' | 'design' | 'review',
              round: Number(roundMatch[2]) as 1 | 2 | 3,
            }
            const projectRoot = boundedIntentProjectRoot(requestDir)
            if (projectRoot === null) {
              options.onReconciledRound?.({
                ...binding,
                workspaceCreationAttempted: false,
                freshEphemeral: false,
                cleanupVerified: false,
                promptMayHaveBeenDelivered: false,
              })
              removeVerifiedEphemeralClaudeRequestDirectory(stateDir, requestDir)
              discardedBeforeOpen += 1
              continue
            }
            const target = readEphemeralClaudeWorkspaceTarget(requestDir, projectRoot)
            const cleanupEnvironment = helperEnvironment()
            let cleanupStatus: string
            let cleanupReceiptDigest: string
            let freshEphemeral: boolean
            await verifyRuntime(options.runtime, cleanupEnvironment)
            if (target === null) {
              const recovered = await run('recover', projectRoot, requestDir)
              if (recovered.exitCode !== 0) {
                if (cleanupDiagnosticConfirmsOwnedProcessStillLive(recovered.stderr)) {
                  throw new EphemeralClaudeOwnedProcessStillLiveError(
                    'owned ephemeral Claude process remains live after provisional cleanup',
                  )
                }
                throw new EphemeralClaudeCleanupPendingError(
                  `ephemeral Claude provisional cleanup is pending: ${recovered.stderr.trim().slice(-2_000)}`,
                )
              }
              parseEphemeralClaudeProvisionalRecovery(recovered.stdout)
              const provisional = readEphemeralClaudeProvisionalCleanupReceipt(requestDir)
              cleanupStatus = provisional.status
              cleanupReceiptDigest = provisional.digest
              freshEphemeral = provisional.status === 'provisional-workspace-closed'
              retainProvisionalAbsenceGuard = provisional.status
                === 'provisional-workspace-not-created'
            } else {
              const close = await run('close', projectRoot, requestDir)
              if (close.exitCode !== 0) {
                if (cleanupDiagnosticConfirmsOwnedProcessStillLive(close.stderr)) {
                  throw new EphemeralClaudeOwnedProcessStillLiveError(
                    'owned ephemeral Claude process remains live after workspace cleanup',
                  )
                }
                throw new EphemeralClaudeCleanupPendingError(
                  `ephemeral Claude cleanup is pending: ${close.stderr.trim().slice(-2_000)}`,
                )
              }
              parseEphemeralClaudeClose(close.stdout, target)
              const cleanup = readEphemeralClaudeCleanupReceipt(requestDir, target)
              cleanupStatus = cleanup.status
              cleanupReceiptDigest = cleanup.digest
              freshEphemeral = true
            }
            persistEphemeralClaudeDeliveryEvidence(stateDir, requestDir)
            await verifyRuntime(options.runtime, cleanupEnvironment)
            options.onReconciledRound?.({
              ...binding,
              workspaceCreationAttempted: true,
              freshEphemeral,
              cleanupVerified: true,
              cleanupStatus,
              cleanupReceiptDigest,
              promptMayHaveBeenDelivered: readOptionalOwnerOnlyRegularFile(
                join(requestDir, 'ephemeral-send-receipt.json'),
              ) !== null,
            })
            if (!retainProvisionalAbsenceGuard) {
              removeVerifiedEphemeralClaudeRequestDirectory(stateDir, requestDir)
            }
            closed += 1
            options.log?.(retainProvisionalAbsenceGuard
              ? 'revalidated one retained provisional Claude absence guard'
              : 'recovered one owned ephemeral Claude workspace')
          } catch (error) {
            const failure = error instanceof EphemeralClaudeCleanupPendingError
              ? error
              : new EphemeralClaudeCleanupPendingError(
                `ephemeral Claude cleanup verification is pending: ${error}`,
              )
            pendingError ??= failure
            options.log?.(failure.message)
          }
        }
        removeEmptyParents([revisionRoot])
      }
      removeEmptyParents([attemptRoot])
    }
    removeEmptyParents([jobRoot])
  }
  removeEmptyParents([root])
  if (pendingError) throw pendingError
  return { closed, discardedBeforeOpen }
}
