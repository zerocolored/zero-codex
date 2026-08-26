#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { createHash, randomUUID } from 'crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'fs'
import { basename, isAbsolute, join } from 'path'
import type { JobRecord, JobStatus } from './job-runner.ts'
import {
  ensureManagedDirectory,
  requireManagedDirectory,
  requireManagedStateRoot,
} from './managed-path.ts'
import {
  parseProcessStartKey,
  observeProcessGeneration,
  processStartKey,
  sameProcessGeneration,
  type ProcessIdentity,
} from './process-generation.ts'
import { atomicWritePrivateFile, openSafeLog } from './safe-file.ts'
import {
  environmentForPinnedHerdrRuntime,
  herdrControlPlaneFingerprint,
  herdrRuntimeFingerprint,
  verifyHerdrRuntimeIdentityAsync,
  type HerdrRuntimeIdentity,
} from './herdr-runtime.ts'

const MONITOR_ROOT = 'job-monitors'
const CLOSED_MONITOR_ROOT = 'job-monitors-closed'
const MANIFEST_FILE = 'manifest.json'
const READY_FILE = 'ready.json'
const PROGRESS_FILE = 'progress.json'
const FEED_LIMIT_BYTES = 20 * 1024 * 1024
const STATUS_LIMIT_BYTES = 256 * 1024
const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024
const MAX_STATE_FILE_BYTES = 64 * 1024
const READY_TIMEOUT_MS = 30_000
const DRAIN_TIMEOUT_MS = 10_000
const VIEWER_STOP_TIMEOUT_MS = 5_000
const VIEWER_PROGRESS_STALE_MS = 5_000
const FEED_KINDS = ['stdout', 'stderr', 'status'] as const

export type HerdrMonitorFeedKind = typeof FEED_KINDS[number]
export type HerdrMonitorPhase =
  | 'create-intent'
  | 'tab-created'
  | 'run-intent'
  | 'active'
  | 'close-intent'

export interface HerdrMonitorTab {
  tabId: string
  workspaceId: string
  label: string
  paneCount: number
}

export interface HerdrMonitorPane {
  paneId: string
  tabId: string
  terminalId: string
  workspaceId: string
  cwd: string
  foregroundCwd?: string
  agent?: string
}

export interface HerdrMonitorForegroundProcess {
  pid: number
  argv: string[]
  cwd: string
}

export interface HerdrMonitorProcessInfo {
  paneId: string
  shellPid: number
  foregroundProcesses: HerdrMonitorForegroundProcess[]
}

export interface HerdrJobMonitorControl {
  verifyRuntime(): Promise<void> | void
  processGenerationStatus(process: ProcessIdentity): 'alive' | 'dead' | 'unknown'
  listWorkspaceIds(): Promise<string[]>
  createTab(input: {
    workspaceId: string
    cwd: string
    label: string
  }): Promise<{ tab: HerdrMonitorTab; pane: HerdrMonitorPane }>
  listTabs(workspaceId: string): Promise<HerdrMonitorTab[]>
  listPanes(workspaceId: string): Promise<HerdrMonitorPane[]>
  runPane(paneId: string, command: string): Promise<void>
  waitOutput(paneId: string, marker: string, timeoutMs: number): Promise<boolean>
  processInfo(paneId: string): Promise<HerdrMonitorProcessInfo>
  closeTab(tabId: string): Promise<void>
}

export class HerdrJobMonitorPendingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HerdrJobMonitorPendingError'
  }
}

type MonitorManifest = {
  version: 1
  jobId: string
  seq: number
  nonce: string
  operationId: string
  runtimeFingerprint: string
  controlPlaneFingerprint: string
  phase: HerdrMonitorPhase
  workspaceId: string
  label: string
  tabId: string | null
  paneId: string | null
  terminalId: string | null
  viewerProcess: ProcessIdentity | null
  viewerArgvDigest: string | null
  createdAt: number
  updatedAt: number
}

type ViewerReadyReceipt = {
  version: 1
  jobId: string
  operationId: string
  process: ProcessIdentity
}

type FeedEpoch = {
  version: 1
  generation: number
  rotating: boolean
  sealed: boolean
  droppedBytes: number
}

type FeedProgress = {
  generation: number
  offset: number
}

type ViewerProgressReceipt = {
  version: 1
  jobId: string
  operationId: string
  process: ProcessIdentity
  streams: Record<HerdrMonitorFeedKind, FeedProgress>
  updatedAt: number
}

type FeedTarget = {
  generation: number
  size: number
}

const MANIFEST_KEYS = [
  'version', 'jobId', 'seq', 'nonce', 'operationId', 'runtimeFingerprint',
  'controlPlaneFingerprint', 'phase',
  'workspaceId', 'label', 'tabId', 'paneId', 'terminalId', 'viewerProcess',
  'viewerArgvDigest', 'createdAt', 'updatedAt',
] as const
const PROCESS_KEYS = [
  'pid', 'ppid', 'pgid', 'status', 'bootSession', 'startSec', 'startUsec', 'started',
] as const
const PROCESS_KEYS_WITH_UID = [...PROCESS_KEYS, 'uid'] as const
const READY_KEYS = ['version', 'jobId', 'operationId', 'process'] as const
const EPOCH_KEYS = ['version', 'generation', 'rotating', 'sealed', 'droppedBytes'] as const
const PROGRESS_KEYS = ['version', 'jobId', 'operationId', 'process', 'streams', 'updatedAt'] as const
const STREAM_PROGRESS_KEYS = ['generation', 'offset'] as const

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\n') === [...keys].sort().join('\n')
}

function safeJobId(jobId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(jobId) || jobId === '.' || jobId === '..') {
    throw new Error(`invalid monitor job ID: ${jobId}`)
  }
  return jobId
}

function requireIdentifier(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`invalid ${label}`)
  }
  return value
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`invalid ${label}`)
  }
  return Number(value)
}

function requireProcessIdentity(value: unknown): ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (!exactKeys(value as Record<string, unknown>, PROCESS_KEYS)
      && !exactKeys(value as Record<string, unknown>, PROCESS_KEYS_WITH_UID))) {
    throw new Error('invalid monitor process identity')
  }
  const record = value as Record<string, unknown>
  const identity: ProcessIdentity = {
    pid: requireInteger(record.pid, 'monitor PID', 1),
    ppid: requireInteger(record.ppid, 'monitor parent PID'),
    pgid: requireInteger(record.pgid, 'monitor process group', 1),
    status: requireInteger(record.status, 'monitor process status'),
    ...(record.uid === undefined
      ? {}
      : { uid: requireInteger(record.uid, 'monitor process owner') }),
    bootSession: requireIdentifier(
      record.bootSession,
      /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i,
      'monitor boot session',
    ).toUpperCase(),
    startSec: requireInteger(record.startSec, 'monitor start seconds', 1),
    startUsec: requireInteger(record.startUsec, 'monitor start microseconds'),
    started: requireIdentifier(
      record.started,
      /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}:\d+:\d{6}$/i,
      'monitor process generation',
    ),
  }
  if (identity.startUsec > 999_999 || !parseProcessStartKey(identity.started)
    || processStartKey(identity) !== identity.started) {
    throw new Error('monitor process generation is inconsistent')
  }
  return identity
}

function readSmallOwnedFile(path: string, label: string): string | null {
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const metadata = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches
      || metadata.size > MAX_STATE_FILE_BYTES) {
      throw new Error(`unsafe ${label}: ${path}`)
    }
    const bytes = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new Error(`${label} changed while reading: ${path}`)
      offset += count
    }
    return bytes.toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

function readOwnedFileTail(
  path: string,
  maximumFileBytes: number,
  tailBytes: number,
  label: string,
): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || before.uid === process.getuid()
    if (!before.isFile() || before.nlink !== 1 || !ownerMatches
      || before.size > maximumFileBytes || tailBytes < 1 || tailBytes > maximumFileBytes) {
      throw new Error(`unsafe ${label}: ${path}`)
    }
    const length = Math.min(before.size, tailBytes)
    const bytes = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        length - offset,
        before.size - length + offset,
      )
      if (count <= 0) throw new Error(`${label} changed while reading: ${path}`)
      offset += count
    }
    const after = fstatSync(descriptor)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`${label} changed while reading: ${path}`)
    }
    return bytes
  } finally {
    closeSync(descriptor)
  }
}

function parseManifest(raw: string): MonitorManifest {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('monitor manifest is not JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, MANIFEST_KEYS)) {
    throw new Error('monitor manifest has unexpected fields')
  }
  const record = value as Record<string, unknown>
  const phase = record.phase
  if (!['create-intent', 'tab-created', 'run-intent', 'active', 'close-intent'].includes(
    typeof phase === 'string' ? phase : '',
  )) throw new Error('monitor manifest has invalid phase')
  const nullableId = (input: unknown, pattern: RegExp, label: string): string | null => (
    input === null ? null : requireIdentifier(input, pattern, label)
  )
  const manifest: MonitorManifest = {
    version: record.version === 1 ? 1 : (() => { throw new Error('invalid monitor version') })(),
    jobId: safeJobId(requireIdentifier(
      record.jobId, /^[A-Za-z0-9._-]{1,128}$/, 'monitor job ID',
    )),
    seq: requireInteger(record.seq, 'monitor queue sequence', 1),
    nonce: requireIdentifier(record.nonce, /^[0-9a-f]{32}$/, 'monitor nonce'),
    operationId: requireIdentifier(record.operationId, /^[0-9a-f]{32}$/, 'monitor operation ID'),
    runtimeFingerprint: requireIdentifier(
      record.runtimeFingerprint, /^[0-9a-f]{64}$/, 'monitor runtime fingerprint',
    ),
    controlPlaneFingerprint: requireIdentifier(
      record.controlPlaneFingerprint, /^[0-9a-f]{64}$/, 'monitor control-plane fingerprint',
    ),
    phase: phase as HerdrMonitorPhase,
    workspaceId: requireIdentifier(record.workspaceId, /^w[0-9A-Za-z]+$/, 'workspace ID'),
    label: requireIdentifier(record.label, /^Zeroちゃん #[1-9]\d* \[[0-9a-f]{8}\]$/, 'monitor label'),
    tabId: nullableId(record.tabId, /^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/, 'tab ID'),
    paneId: nullableId(record.paneId, /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/, 'pane ID'),
    terminalId: nullableId(record.terminalId, /^term_[0-9a-f]+$/, 'terminal ID'),
    viewerProcess: record.viewerProcess === null ? null : requireProcessIdentity(record.viewerProcess),
    viewerArgvDigest: record.viewerArgvDigest === null
      ? null
      : requireIdentifier(record.viewerArgvDigest, /^[0-9a-f]{64}$/, 'viewer argv digest'),
    createdAt: requireInteger(record.createdAt, 'monitor created time', 1),
    updatedAt: requireInteger(record.updatedAt, 'monitor updated time', 1),
  }
  const bindingValues = [manifest.tabId, manifest.paneId, manifest.terminalId]
  const hasBinding = bindingValues.every(value => value !== null)
  if (!hasBinding && bindingValues.some(value => value !== null)) {
    throw new Error('monitor manifest has a partial pane binding')
  }
  if ((manifest.phase === 'create-intent') !== !hasBinding) {
    throw new Error('monitor manifest binding does not match phase')
  }
  if (manifest.phase === 'active'
    && (!manifest.viewerProcess || !manifest.viewerArgvDigest)) {
    throw new Error('active monitor lacks viewer identity')
  }
  if (manifest.viewerProcess === null !== (manifest.viewerArgvDigest === null)) {
    throw new Error('monitor viewer identity is incomplete')
  }
  return manifest
}

function parseReady(raw: string): ViewerReadyReceipt {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('monitor receipt is not JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, READY_KEYS)) {
    throw new Error('monitor receipt has unexpected fields')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new Error('invalid monitor receipt version')
  return {
    version: 1,
    jobId: safeJobId(requireIdentifier(
      record.jobId, /^[A-Za-z0-9._-]{1,128}$/, 'monitor receipt job ID',
    )),
    operationId: requireIdentifier(
      record.operationId, /^[0-9a-f]{32}$/, 'monitor receipt operation ID',
    ),
    process: requireProcessIdentity(record.process),
  }
}

function parseEpoch(raw: string | null): FeedEpoch {
  if (raw === null) {
    return { version: 1, generation: 0, rotating: false, sealed: false, droppedBytes: 0 }
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('monitor feed epoch is not JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, EPOCH_KEYS)) {
    throw new Error('monitor feed epoch has unexpected fields')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.rotating !== 'boolean'
    || typeof record.sealed !== 'boolean') {
    throw new Error('invalid monitor feed epoch')
  }
  return {
    version: 1,
    generation: requireInteger(record.generation, 'feed generation'),
    rotating: record.rotating,
    sealed: record.sealed,
    droppedBytes: requireInteger(record.droppedBytes, 'feed dropped bytes'),
  }
}

function parseProgress(raw: string): ViewerProgressReceipt {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('monitor progress is not JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, PROGRESS_KEYS)) {
    throw new Error('monitor progress has unexpected fields')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !record.streams || typeof record.streams !== 'object'
    || Array.isArray(record.streams)
    || !exactKeys(record.streams as Record<string, unknown>, FEED_KINDS)) {
    throw new Error('monitor progress is invalid')
  }
  const streams = {} as Record<HerdrMonitorFeedKind, FeedProgress>
  for (const kind of FEED_KINDS) {
    const input = (record.streams as Record<string, unknown>)[kind]
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || !exactKeys(input as Record<string, unknown>, STREAM_PROGRESS_KEYS)) {
      throw new Error(`monitor ${kind} progress is invalid`)
    }
    const stream = input as Record<string, unknown>
    streams[kind] = {
      generation: requireInteger(stream.generation, `${kind} progress generation`),
      offset: requireInteger(stream.offset, `${kind} progress offset`),
    }
  }
  return {
    version: 1,
    jobId: safeJobId(requireIdentifier(
      record.jobId, /^[A-Za-z0-9._-]{1,128}$/, 'monitor progress job ID',
    )),
    operationId: requireIdentifier(
      record.operationId, /^[0-9a-f]{32}$/, 'monitor progress operation ID',
    ),
    process: requireProcessIdentity(record.process),
    streams,
    updatedAt: requireInteger(record.updatedAt, 'monitor progress time', 1),
  }
}

function readViewerProgress(directory: string): ViewerProgressReceipt | null {
  const raw = readSmallOwnedFile(join(directory, PROGRESS_FILE), 'monitor progress')
  return raw === null ? null : parseProgress(raw)
}

function snapshotFeedTargets(directory: string): Record<HerdrMonitorFeedKind, FeedTarget> {
  const targets = {} as Record<HerdrMonitorFeedKind, FeedTarget>
  for (const kind of FEED_KINDS) {
    const epoch = parseEpoch(readSmallOwnedFile(epochPath(directory, kind), 'monitor feed epoch'))
    if (epoch.rotating) throw new Error(`monitor ${kind} feed is rotating`)
    const descriptor = openSync(
      feedPath(directory, kind, epoch.generation),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    try {
      const metadata = fstatSync(descriptor)
      const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
      if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches) {
        throw new Error(`unsafe monitor ${kind} feed`)
      }
      targets[kind] = { generation: epoch.generation, size: metadata.size }
    } finally {
      closeSync(descriptor)
    }
  }
  return targets
}

async function waitForViewerDrain(
  manifest: MonitorManifest,
  directory: string,
  control: HerdrJobMonitorControl,
  targets: Record<HerdrMonitorFeedKind, FeedTarget>,
): Promise<void> {
  if (!manifest.viewerProcess) {
    throw new Error(`monitor viewer identity is missing for job ${manifest.jobId}`)
  }
  const deadline = Date.now() + DRAIN_TIMEOUT_MS
  while (Date.now() <= deadline) {
    if (control.processGenerationStatus(manifest.viewerProcess) !== 'alive') {
      throw new Error(`monitor viewer stopped before draining job ${manifest.jobId}`)
    }
    const progress = readViewerProgress(directory)
    if (progress && progressMatchesManifest(progress, manifest)
      && FEED_KINDS.every(kind => (
        progress.streams[kind].generation === targets[kind].generation
        && progress.streams[kind].offset >= targets[kind].size
      ))) return
    await Bun.sleep(50)
  }
  throw new Error(`monitor viewer did not drain final output for job ${manifest.jobId}`)
}

function viewerProgressCovers(
  manifest: MonitorManifest,
  progress: ViewerProgressReceipt | null,
  targets: Record<HerdrMonitorFeedKind, FeedTarget>,
): boolean {
  return progress !== null
    && progressMatchesManifest(progress, manifest)
    && FEED_KINDS.every(kind => (
      progress.streams[kind].generation === targets[kind].generation
      && progress.streams[kind].offset >= targets[kind].size
    ))
}

function viewerProgressIsFresh(
  manifest: MonitorManifest,
  progress: ViewerProgressReceipt | null,
  directory: string,
  now = Date.now(),
): boolean {
  const targets = snapshotFeedTargets(directory)
  return progress !== null
    && progressMatchesManifest(progress, manifest)
    && FEED_KINDS.every(kind => (
      progress.streams[kind].generation === targets[kind].generation
      && progress.streams[kind].offset <= targets[kind].size
    ))
    && progress.updatedAt <= now + 1_000
    && now - progress.updatedAt <= VIEWER_PROGRESS_STALE_MS
}

async function waitForFreshViewerProgress(
  manifest: MonitorManifest,
  directory: string,
  control: HerdrJobMonitorControl,
  timeoutMs = VIEWER_PROGRESS_STALE_MS,
): Promise<void> {
  if (!manifest.viewerProcess) throw new Error('monitor viewer identity is missing')
  const deadline = Date.now() + Math.max(10, timeoutMs)
  while (Date.now() <= deadline) {
    if (control.processGenerationStatus(manifest.viewerProcess) !== 'alive') break
    if (viewerProgressIsFresh(manifest, readViewerProgress(directory), directory)) return
    await Bun.sleep(50)
  }
  throw new Error(`monitor viewer heartbeat is unavailable for job ${manifest.jobId}`)
}

async function waitForViewerStopped(
  processIdentity: ProcessIdentity | null,
  control: HerdrJobMonitorControl,
): Promise<void> {
  if (!processIdentity) return
  const deadline = Date.now() + VIEWER_STOP_TIMEOUT_MS
  while (Date.now() <= deadline) {
    const status = control.processGenerationStatus(processIdentity)
    if (status === 'dead') return
    if (status === 'unknown') break
    await Bun.sleep(50)
  }
  throw new Error('monitor viewer stop is unconfirmed')
}

function monitorDirectory(stateDirInput: string, jobIdInput: string, create = false): string {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const jobId = safeJobId(jobIdInput)
  const root = create
    ? ensureManagedDirectory(stateDir, join(stateDir, MONITOR_ROOT))
    : requireManagedDirectory(stateDir, join(stateDir, MONITOR_ROOT))
  return create
    ? ensureManagedDirectory(stateDir, join(root, jobId))
    : requireManagedDirectory(stateDir, join(root, jobId))
}

function fsyncManagedDirectory(stateDir: string, path: string): void {
  const directory = requireManagedDirectory(stateDir, path)
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  )
  try {
    const metadata = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isDirectory() || metadata.nlink < 1 || !ownerMatches) {
      throw new Error(`unsafe monitor directory fsync target: ${path}`)
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function validateMonitorArtifacts(directory: string, incompleteInitialization = false): void {
  const allowed = new Set([
    MANIFEST_FILE,
    READY_FILE,
    PROGRESS_FILE,
    ...FEED_KINDS.map(kind => `${kind}.epoch.json`),
  ])
  for (const name of readdirSync(directory)) {
    const manifestTemporary = /^manifest\.json\.tmp-\d+-[0-9a-f-]{36}$/.test(name)
    const temporary = manifestTemporary
      || /^(?:ready|progress|stdout\.epoch|stderr\.epoch|status\.epoch)\.json\.tmp-\d+-[0-9a-f-]+$/.test(name)
      || /^(?:stdout|stderr|status)\.\d+\.feed\.tmp-\d+-[0-9a-f-]{36}$/.test(name)
    const generationFeed = /^(?:stdout|stderr|status)\.\d+\.feed$/.test(name)
    if (incompleteInitialization
      ? !manifestTemporary
      : !allowed.has(name) && !temporary && !generationFeed) {
      throw new Error(`unexpected monitor artifact blocks cleanup: ${name}`)
    }
    const metadata = lstatSync(join(directory, name))
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !ownerMatches) {
      throw new Error(`unsafe monitor artifact blocks cleanup: ${name}`)
    }
  }
}

function purgeRetiredMonitorDirectory(stateDir: string, root: string, directory: string): void {
  try {
    validateMonitorArtifacts(directory)
    rmSync(directory, { recursive: true, force: false })
    fsyncManagedDirectory(stateDir, root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // The active namespace was already atomically committed. Retain a
      // private tombstone for deterministic startup scavenging rather than
      // turning post-close storage reclamation into a queue liveness failure.
      return
    }
  }
}

function retireMonitorDirectory(
  stateDir: string,
  directory: string,
  incompleteInitialization = false,
): void {
  requireManagedDirectory(stateDir, directory)
  validateMonitorArtifacts(directory, incompleteInitialization)
  const activeRoot = requireManagedDirectory(stateDir, join(stateDir, MONITOR_ROOT))
  const retiredRoot = ensureManagedDirectory(stateDir, join(stateDir, CLOSED_MONITOR_ROOT))
  const destination = join(
    retiredRoot,
    `${safeJobId(basename(directory))}.${randomUUID().replaceAll('-', '')}`,
  )
  renameSync(directory, destination)
  fsyncManagedDirectory(stateDir, retiredRoot)
  fsyncManagedDirectory(stateDir, activeRoot)
  purgeRetiredMonitorDirectory(stateDir, retiredRoot, destination)
}

function recoverIncompleteMonitorInitialization(stateDir: string, jobId: string): boolean {
  let directory: string
  try { directory = monitorDirectory(stateDir, jobId) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (readSmallOwnedFile(join(directory, MANIFEST_FILE), 'monitor manifest') !== null) return false
  retireMonitorDirectory(stateDir, directory, true)
  return true
}

function scavengeRetiredMonitorDirectories(stateDir: string): number {
  let root: string
  try { root = requireManagedDirectory(stateDir, join(stateDir, CLOSED_MONITOR_ROOT)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let removed = 0
  for (const name of readdirSync(root).sort()) {
    if (!/^[A-Za-z0-9._-]{1,128}\.[0-9a-f]{32}$/.test(name)) {
      throw new Error(`invalid retired monitor directory: ${name}`)
    }
    const directory = requireManagedDirectory(stateDir, join(root, name))
    validateMonitorArtifacts(directory)
    try {
      rmSync(directory, { recursive: true, force: false })
      removed += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
    }
  }
  fsyncManagedDirectory(stateDir, root)
  return removed
}

function readMonitorManifest(stateDir: string, jobId: string): MonitorManifest | null {
  const directory = monitorDirectory(stateDir, jobId)
  const raw = readSmallOwnedFile(join(directory, MANIFEST_FILE), 'monitor manifest')
  return raw === null ? null : parseManifest(raw)
}

function writeManifest(directory: string, manifest: MonitorManifest): MonitorManifest {
  const value = { ...manifest, updatedAt: Date.now() }
  // Refuse to persist a phase/process combination that this daemon could not
  // parse after a crash. This catches partial viewer identity adoption before
  // it becomes the only recovery source.
  parseManifest(JSON.stringify(value))
  atomicWritePrivateFile(join(directory, MANIFEST_FILE), `${JSON.stringify(value)}\n`)
  return value
}

function feedPath(
  directory: string,
  kind: HerdrMonitorFeedKind,
  generation: number,
): string {
  return join(directory, `${kind}.${generation}.feed`)
}

function epochPath(directory: string, kind: HerdrMonitorFeedKind): string {
  return join(directory, `${kind}.epoch.json`)
}

function feedMetadata(path: string, label: string): { size: number } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches) {
      throw new Error(`unsafe ${label}`)
    }
    return { size: metadata.size }
  } finally {
    closeSync(descriptor)
  }
}

function removeOwnedFeedArtifact(path: string, label: string): void {
  feedMetadata(path, label)
  unlinkSync(path)
}

function feedArtifactNames(directory: string, kind: HerdrMonitorFeedKind): {
  generations: number[]
  temporary: string[]
} {
  const generations: number[] = []
  const temporary: string[] = []
  const generationPattern = new RegExp(`^${kind}\\.(\\d+)\\.feed$`)
  const temporaryPattern = new RegExp(
    `^${kind}\\.\\d+\\.feed\\.tmp-\\d+-[0-9a-f-]{36}$`,
  )
  for (const name of readdirSync(directory)) {
    const generation = generationPattern.exec(name)
    if (generation) {
      const value = Number(generation[1])
      if (!Number.isSafeInteger(value)) throw new Error(`invalid monitor ${kind} generation`)
      generations.push(value)
    } else if (temporaryPattern.test(name)) {
      temporary.push(name)
    }
  }
  return { generations, temporary }
}

function initializeFeeds(directory: string, manifest: MonitorManifest): void {
  for (const kind of FEED_KINDS) {
    const statePath = epochPath(directory, kind)
    const epochRaw = readSmallOwnedFile(statePath, 'monitor feed epoch')
    if (epochRaw === null) {
      const initialPath = feedPath(directory, kind, 0)
      try {
        feedMetadata(initialPath, `monitor ${kind} feed`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        atomicWritePrivateFile(initialPath, new Uint8Array())
      }
      atomicWritePrivateFile(
        statePath,
        `${JSON.stringify({
          version: 1,
          generation: 0,
          rotating: false,
          sealed: false,
          droppedBytes: 0,
        })}\n`,
      )
    } else {
      let parsed = parseEpoch(epochRaw)
      if (parsed.rotating) {
        // Older in-place rotation could have crashed before, during, or after
        // truncation, so its bytes cannot be reconstructed safely.
        throw new Error(`monitor ${kind} feed has an unfinished legacy rotation`)
      }
      const currentPath = feedPath(directory, kind, parsed.generation)
      const current = feedMetadata(currentPath, `monitor ${kind} feed`)
      const pendingPath = feedPath(directory, kind, parsed.generation + 1)
      try {
        const pending = feedMetadata(pendingPath, `monitor ${kind} staged feed`)
        const limit = kind === 'status' ? STATUS_LIMIT_BYTES : FEED_LIMIT_BYTES
        if (pending.size > limit) throw new Error(`monitor ${kind} staged feed is oversized`)
        let droppedIncrement = current.size
        const progress = readViewerProgress(directory)
        const consumed = progress?.streams[kind]
        if (progress && progressMatchesManifest(progress, manifest)
          && consumed?.generation === parsed.generation && consumed.offset <= current.size) {
          if (consumed.offset === current.size) {
            droppedIncrement = current.size
          } else {
            const descriptor = openSync(currentPath, constants.O_RDONLY | constants.O_NOFOLLOW)
            try {
              const carry = readIncompleteUtf8Carry(currentPath, descriptor, consumed.offset)
              if (carry !== null && consumed.offset + carry.byteLength === current.size) {
                droppedIncrement = consumed.offset
              }
            } finally {
              closeSync(descriptor)
            }
          }
        }
        parsed = {
          version: 1,
          generation: parsed.generation + 1,
          rotating: false,
          sealed: false,
          droppedBytes: parsed.droppedBytes + droppedIncrement,
        }
        atomicWritePrivateFile(
          statePath,
          `${JSON.stringify(parsed)}\n`,
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }

    const current = parseEpoch(readSmallOwnedFile(statePath, 'monitor feed epoch'))
    feedMetadata(feedPath(directory, kind, current.generation), `monitor ${kind} feed`)
    const artifacts = feedArtifactNames(directory, kind)
    if (artifacts.generations.some(generation => generation > current.generation + 1)) {
      throw new Error(`monitor ${kind} feed has an impossible future generation`)
    }
    // Retain prior generations here. A viewer can read the old epoch and be
    // preempted before opening its feed; deleting that path immediately after
    // the pointer swap would race that open. appendFeed removes retired files
    // only after this exact viewer has acknowledged the selected generation.
    // A crash before atomic rename can leave only a private temp file. It was
    // never selected by the durable epoch, so remove it while retaining the
    // complete current generation.
    for (const name of artifacts.temporary) {
      removeOwnedFeedArtifact(join(directory, name), `monitor ${kind} staged temporary feed`)
    }
  }
}

function progressMatchesManifest(
  progress: ViewerProgressReceipt,
  manifest: MonitorManifest,
): boolean {
  return progress.jobId === manifest.jobId
    && progress.operationId === manifest.operationId
    && manifest.viewerProcess !== null
    && sameProcessGeneration(progress.process, manifest.viewerProcess)
}

function readIncompleteUtf8Carry(
  path: string,
  writeDescriptor: number,
  consumedOffset: number,
): Buffer | null {
  const writeMetadata = fstatSync(writeDescriptor)
  const length = writeMetadata.size - consumedOffset
  if (length < 1 || length > 3) return null
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches
      || metadata.dev !== writeMetadata.dev || metadata.ino !== writeMetadata.ino
      || metadata.size !== writeMetadata.size) {
      throw new Error('monitor feed changed while checking its UTF-8 carry')
    }
    const carry = Buffer.alloc(length)
    let offset = 0
    while (offset < carry.byteLength) {
      const count = readSync(
        descriptor,
        carry,
        offset,
        carry.byteLength - offset,
        consumedOffset + offset,
      )
      if (count <= 0) throw new Error('monitor feed changed while reading its UTF-8 carry')
      offset += count
    }
    const lead = carry[0]!
    const expected = lead >= 0xc2 && lead <= 0xdf ? 2
      : lead >= 0xe0 && lead <= 0xef ? 3
        : lead >= 0xf0 && lead <= 0xf4 ? 4
          : 0
    if (expected === 0 || carry.byteLength >= expected
      || carry.subarray(1).some(byte => (byte & 0xc0) !== 0x80)) return null
    return carry
  } finally {
    closeSync(descriptor)
  }
}

function appendFeed(
  directory: string,
  kind: HerdrMonitorFeedKind,
  value: Uint8Array,
  manifest: MonitorManifest,
): void {
  if (value.byteLength === 0) return
  const limit = kind === 'status' ? STATUS_LIMIT_BYTES : FEED_LIMIT_BYTES
  if (value.byteLength > limit) {
    throw new Error(`monitor ${kind} chunk exceeds its bounded feed`)
  }
  const statePath = epochPath(directory, kind)
  const previous = parseEpoch(readSmallOwnedFile(statePath, 'monitor feed epoch'))
  if (previous.rotating) throw new Error(`monitor ${kind} feed has an unfinished rotation`)
  if (previous.sealed) throw new Error(`monitor ${kind} feed is sealed`)
  const progress = readViewerProgress(directory)
  const artifacts = feedArtifactNames(directory, kind)
  if (progress && progressMatchesManifest(progress, manifest)
    && progress.streams[kind].generation === previous.generation) {
    for (const generation of artifacts.generations) {
      if (generation < previous.generation) {
        removeOwnedFeedArtifact(
          feedPath(directory, kind, generation),
          `monitor ${kind} retired feed`,
        )
      }
    }
  }
  const path = feedPath(directory, kind, previous.generation)
  const descriptor = openSafeLog(path, 'append')
  const writeAll = (bytes: Uint8Array): void => {
    let offset = 0
    while (offset < bytes.byteLength) {
      const count = writeSync(descriptor, bytes, offset, bytes.byteLength - offset)
      if (count <= 0) throw new Error(`monitor ${kind} feed write made no progress`)
      offset += count
    }
  }
  try {
    const metadata = fstatSync(descriptor)
    if (metadata.size + value.byteLength <= limit) {
      writeAll(value)
      fsyncSync(descriptor)
      return
    }
    const currentProgress = readViewerProgress(directory)
    const consumed = currentProgress?.streams[kind]
    if (!currentProgress || !progressMatchesManifest(currentProgress, manifest)
      || consumed?.generation !== previous.generation) {
      throw new Error(
        `monitor ${kind} feed reached its limit before the viewer drained it`,
      )
    }
    const carry = consumed.offset === metadata.size
      ? Buffer.alloc(0)
      : readIncompleteUtf8Carry(path, descriptor, consumed.offset)
    if (carry === null) {
      throw new Error(
        `monitor ${kind} feed reached its limit before the viewer drained it`,
      )
    }
    const marker = Buffer.from(
      `\n[Zeroちゃん: ${kind} の表示上限に達したため古い出力を省略しました]\n`,
      'utf8',
    )
    if (marker.byteLength + carry.byteLength + value.byteLength > limit) {
      throw new Error(`monitor ${kind} rotation marker leaves insufficient feed capacity`)
    }
    const next: FeedEpoch = {
      version: 1,
      generation: previous.generation + 1,
      rotating: false,
      sealed: false,
      droppedBytes: previous.droppedBytes + consumed.offset,
    }
    // Build the next immutable generation completely and durably before the
    // atomic epoch pointer selects it. The drained current generation remains
    // intact across every crash point; startup can finish a staged pointer
    // swap or discard only an incomplete temp file without truncating data.
    atomicWritePrivateFile(
      feedPath(directory, kind, next.generation),
      Buffer.concat([marker, carry, Buffer.from(value)]),
    )
    atomicWritePrivateFile(statePath, `${JSON.stringify(next)}\n`)
  } finally {
    closeSync(descriptor)
  }
}

function sealFeed(directory: string, kind: HerdrMonitorFeedKind): void {
  const statePath = epochPath(directory, kind)
  const epoch = parseEpoch(readSmallOwnedFile(statePath, 'monitor feed epoch'))
  if (epoch.rotating) throw new Error(`monitor ${kind} feed has an unfinished rotation`)
  if (epoch.sealed) return
  atomicWritePrivateFile(statePath, `${JSON.stringify({ ...epoch, sealed: true })}\n`)
}

export function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    .replace(/\r(?!\n)/g, '\n')
}

export function appendHerdrJobMonitorChunk(
  stateDir: string,
  jobId: string,
  kind: 'stdout' | 'stderr',
  value: Uint8Array,
): void {
  const directory = monitorDirectory(stateDir, jobId)
  const manifest = readMonitorManifest(stateDir, jobId)
  if (!manifest || !['run-intent', 'active'].includes(manifest.phase)) {
    throw new Error(`monitor is not accepting ${kind} for job ${jobId}`)
  }
  appendFeed(directory, kind, value, manifest)
}

export function appendHerdrJobMonitorStatus(
  stateDir: string,
  jobId: string,
  message: string,
): void {
  const directory = monitorDirectory(stateDir, jobId)
  const manifest = readMonitorManifest(stateDir, jobId)
  if (!manifest || !['create-intent', 'tab-created', 'run-intent', 'active'].includes(
    manifest.phase,
  )) throw new Error(`monitor is not accepting status for job ${jobId}`)
  const text = stripTerminalControls(message).trim().slice(0, 2_000)
  if (!text) return
  appendFeed(directory, 'status', Buffer.from(`[Zeroちゃん] ${text}\n`, 'utf8'), manifest)
}

function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('viewer command argument contains NUL')
  return `'${value.replaceAll("'", "'\\''")}'`
}

function requireTrustedExecutable(pathInput: string, label: string): string {
  const path = realpathSync(pathInput)
  const metadata = lstatSync(path)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || !ownerMatches || (metadata.mode & 0o022) !== 0) {
    throw new Error(`unsafe ${label}: ${path}`)
  }
  return path
}

function viewerArguments(): string[] {
  const bun = requireTrustedExecutable(process.execPath, 'Bun executable')
  const viewer = requireTrustedExecutable(
    join(import.meta.dir, 'herdr-job-monitor-view.ts'),
    'monitor viewer',
  )
  return [bun, '--config=/dev/null', '--no-env-file', viewer]
}

function viewerCommand(args: string[]): string {
  return [
    'exec /usr/bin/env -i PATH=/usr/bin:/bin TERM=dumb',
    ...args.map(shellQuote),
  ].join(' ')
}

function argvDigest(argv: string[]): string {
  return createHash('sha256').update(JSON.stringify(argv)).digest('hex')
}

function parseJsonOutput(value: Uint8Array, label: string): Record<string, unknown> {
  if (value.byteLength > MAX_CONTROL_OUTPUT_BYTES) {
    throw new Error(`${label} returned excessive output`)
  }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(value).toString('utf8')) } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} returned an invalid envelope`)
  }
  return parsed as Record<string, unknown>
}

export function buildHerdrMonitorControlEnvironment(
  runtime: HerdrRuntimeIdentity,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return environmentForPinnedHerdrRuntime(runtime, {
    HOME: source.HOME,
    USER: source.USER,
    LOGNAME: source.LOGNAME,
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    TERM: 'dumb',
    NO_COLOR: '1',
  })
}

async function invokeHerdr(
  runtime: HerdrRuntimeIdentity,
  args: string[],
  timeout = 15_000,
  allowFailure = false,
): Promise<Record<string, unknown> | null> {
  await verifyHerdrRuntimeIdentityAsync(runtime)
  const child = Bun.spawn([runtime.binary, ...args], {
    env: buildHerdrMonitorControlEnvironment(runtime),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { child.kill('SIGKILL') } catch {}
  }, timeout)
  let stdout: Uint8Array
  let stderr: Uint8Array
  let exitCode: number
  try {
    const [stdoutBuffer, stderrBuffer, exited] = await Promise.all([
      readBoundedHerdrOutput(child.stdout),
      readBoundedHerdrOutput(child.stderr),
      child.exited,
    ])
    stdout = stdoutBuffer
    stderr = stderrBuffer
    exitCode = exited
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) {
      try { child.kill('SIGKILL') } catch {}
      try { await child.exited } catch {}
    }
  }
  if (timedOut || exitCode !== 0) {
    if (allowFailure) return null
    const detail = Buffer.from(stderr).toString('utf8').trim().slice(-2_000)
    throw new Error(
      `Herdr ${args.slice(0, 2).join(' ')} ${timedOut ? 'timed out' : 'failed'}: ${detail}`,
    )
  }
  return parseJsonOutput(stdout, `Herdr ${args.slice(0, 2).join(' ')}`)
}

export async function readBoundedHerdrOutput(
  stream: ReadableStream<Uint8Array>,
  maximum = MAX_CONTROL_OUTPUT_BYTES,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximum) throw new Error('Herdr control output exceeded its bound')
      chunks.push(value)
    }
  } finally {
    try { await reader.cancel() } catch {}
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total)
}

function envelopeResult(value: Record<string, unknown>): Record<string, unknown> {
  const result = value.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Herdr response omitted result')
  }
  return result as Record<string, unknown>
}

function parseTab(value: unknown): HerdrMonitorTab {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Herdr returned invalid tab')
  }
  const record = value as Record<string, unknown>
  return {
    tabId: requireIdentifier(record.tab_id, /^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/, 'tab ID'),
    workspaceId: requireIdentifier(record.workspace_id, /^w[0-9A-Za-z]+$/, 'workspace ID'),
    label: typeof record.label === 'string' ? record.label : '',
    paneCount: requireInteger(record.pane_count, 'tab pane count', 1),
  }
}

function parsePane(value: unknown): HerdrMonitorPane {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Herdr returned invalid pane')
  }
  const record = value as Record<string, unknown>
  if (typeof record.cwd !== 'string' || !isAbsolute(record.cwd)) {
    throw new Error('Herdr pane omitted absolute cwd')
  }
  return {
    paneId: requireIdentifier(record.pane_id, /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/, 'pane ID'),
    tabId: requireIdentifier(record.tab_id, /^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/, 'tab ID'),
    terminalId: requireIdentifier(record.terminal_id, /^term_[0-9a-f]+$/, 'terminal ID'),
    workspaceId: requireIdentifier(record.workspace_id, /^w[0-9A-Za-z]+$/, 'workspace ID'),
    cwd: record.cwd,
    foregroundCwd: typeof record.foreground_cwd === 'string' ? record.foreground_cwd : undefined,
    agent: typeof record.agent === 'string' ? record.agent : undefined,
  }
}

export function createProductionHerdrJobMonitorControl(
  runtime: HerdrRuntimeIdentity,
): HerdrJobMonitorControl {
  return {
    async verifyRuntime() { await verifyHerdrRuntimeIdentityAsync(runtime) },
    processGenerationStatus(process) {
      return observeProcessGeneration(process).status
    },
    async listWorkspaceIds() {
      const result = envelopeResult((await invokeHerdr(runtime, ['workspace', 'list']))!)
      if (!Array.isArray(result.workspaces)) {
        throw new Error('Herdr workspace list omitted workspaces')
      }
      const identifiers = result.workspaces.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Herdr returned invalid workspace')
        }
        return requireIdentifier(
          (value as Record<string, unknown>).workspace_id,
          /^w[0-9A-Za-z]+$/,
          'workspace ID',
        )
      })
      if (new Set(identifiers).size !== identifiers.length) {
        throw new Error('Herdr workspace list contains duplicate IDs')
      }
      return identifiers
    },
    async createTab(input) {
      const result = envelopeResult((await invokeHerdr(runtime, [
        'tab', 'create', '--workspace', input.workspaceId, '--cwd', input.cwd,
        '--label', input.label, '--no-focus',
      ]))!)
      return { tab: parseTab(result.tab), pane: parsePane(result.root_pane) }
    },
    async listTabs(workspaceId) {
      const result = envelopeResult((await invokeHerdr(
        runtime, ['tab', 'list', '--workspace', workspaceId],
      ))!)
      if (!Array.isArray(result.tabs)) throw new Error('Herdr tab list omitted tabs')
      return result.tabs.map(parseTab)
    },
    async listPanes(workspaceId) {
      const result = envelopeResult((await invokeHerdr(
        runtime, ['pane', 'list', '--workspace', workspaceId],
      ))!)
      if (!Array.isArray(result.panes)) throw new Error('Herdr pane list omitted panes')
      return result.panes.map(parsePane)
    },
    async runPane(paneId, command) {
      await invokeHerdr(runtime, ['pane', 'run', paneId, command])
    },
    async waitOutput(paneId, marker, timeoutMs) {
      return await invokeHerdr(runtime, [
        'pane', 'wait-output', '--match', marker, '--source', 'recent-unwrapped',
        '--lines', '120', '--timeout', String(timeoutMs), paneId,
      ], timeoutMs + 5_000, true) !== null
    },
    async processInfo(paneId) {
      const result = envelopeResult((await invokeHerdr(
        runtime, ['pane', 'process-info', '--pane', paneId],
      ))!)
      const input = result.process_info
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Herdr process-info omitted process identity')
      }
      const record = input as Record<string, unknown>
      if (!Array.isArray(record.foreground_processes)) {
        throw new Error('Herdr process-info omitted foreground processes')
      }
      return {
        paneId: requireIdentifier(record.pane_id, /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/, 'pane ID'),
        shellPid: requireInteger(record.shell_pid, 'pane shell PID', 1),
        foregroundProcesses: record.foreground_processes.map(value => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Herdr returned invalid foreground process')
          }
          const processRecord = value as Record<string, unknown>
          if (!Array.isArray(processRecord.argv)
            || processRecord.argv.some(item => typeof item !== 'string')
            || typeof processRecord.cwd !== 'string' || !isAbsolute(processRecord.cwd)) {
            throw new Error('Herdr returned incomplete foreground process')
          }
          return {
            pid: requireInteger(processRecord.pid, 'foreground PID', 1),
            argv: processRecord.argv as string[],
            cwd: processRecord.cwd,
          }
        }),
      }
    },
    async closeTab(tabId) {
      await invokeHerdr(runtime, ['tab', 'close', tabId])
    },
  }
}

function requireTabBinding(
  manifest: MonitorManifest,
  directory: string,
  runtime: HerdrRuntimeIdentity,
  tabs: HerdrMonitorTab[],
  panes: HerdrMonitorPane[],
): { tab: HerdrMonitorTab; pane: HerdrMonitorPane } {
  const matchingTabs = tabs.filter(tab => tab.label === manifest.label)
  const tab = manifest.tabId
    ? matchingTabs.find(value => value.tabId === manifest.tabId)
    : matchingTabs.length === 1 ? matchingTabs[0] : undefined
  if (!tab || matchingTabs.length !== 1 || tab.workspaceId !== manifest.workspaceId
    || tab.paneCount !== 1 || tab.tabId === runtime.tabId) {
    throw new Error(`monitor tab binding is ambiguous for job ${manifest.jobId}`)
  }
  const matchingPanes = panes.filter(pane => pane.tabId === tab.tabId)
  const pane = manifest.paneId
    ? matchingPanes.find(value => value.paneId === manifest.paneId)
    : matchingPanes.length === 1 ? matchingPanes[0] : undefined
  if (!pane || matchingPanes.length !== 1
    || pane.workspaceId !== manifest.workspaceId
    || pane.paneId === runtime.paneId || pane.terminalId === runtime.terminalId
    || pane.agent !== undefined
    || realpathSync(pane.cwd) !== directory
    || (pane.foregroundCwd !== undefined && realpathSync(pane.foregroundCwd) !== directory)) {
    throw new Error(`monitor pane binding is unsafe for job ${manifest.jobId}`)
  }
  if (manifest.tabId && (pane.tabId !== manifest.tabId
    || pane.paneId !== manifest.paneId || pane.terminalId !== manifest.terminalId)) {
    throw new Error(`monitor pane identity changed for job ${manifest.jobId}`)
  }
  return { tab, pane }
}

async function findOrVerifyBinding(
  manifest: MonitorManifest,
  directory: string,
  runtime: HerdrRuntimeIdentity,
  control: HerdrJobMonitorControl,
): Promise<{ tab: HerdrMonitorTab; pane: HerdrMonitorPane }> {
  const [tabs, panes] = await Promise.all([
    control.listTabs(manifest.workspaceId),
    control.listPanes(manifest.workspaceId),
  ])
  return requireTabBinding(manifest, directory, runtime, tabs, panes)
}

async function findManifestEvidenceAcrossWorkspaces(
  manifest: MonitorManifest,
  directory: string,
  control: HerdrJobMonitorControl,
): Promise<{ tabs: HerdrMonitorTab[]; panes: HerdrMonitorPane[] }> {
  const workspaceIds = [...new Set([
    manifest.workspaceId,
    ...(await control.listWorkspaceIds()),
  ])]
  const tabs: HerdrMonitorTab[] = []
  const panes: HerdrMonitorPane[] = []
  for (const workspaceId of workspaceIds) {
    const [workspaceTabs, workspacePanes] = await Promise.all([
      control.listTabs(workspaceId),
      control.listPanes(workspaceId),
    ])
    tabs.push(...workspaceTabs.filter(tab => (
      tab.label === manifest.label || tab.tabId === manifest.tabId
    )))
    panes.push(...workspacePanes.filter(pane => {
      if (pane.paneId === manifest.paneId || pane.terminalId === manifest.terminalId
        || pane.tabId === manifest.tabId) return true
      try {
        return realpathSync(pane.cwd) === directory
          || (pane.foregroundCwd !== undefined && realpathSync(pane.foregroundCwd) === directory)
      } catch {
        return false
      }
    }))
  }
  return { tabs, panes }
}

async function proveManifestBindingAbsent(
  manifest: MonitorManifest,
  directory: string,
  control: HerdrJobMonitorControl,
): Promise<void> {
  const evidence = await findManifestEvidenceAcrossWorkspaces(manifest, directory, control)
  if (evidence.tabs.length > 0 || evidence.panes.length > 0) {
    throw new Error(`monitor binding moved or changed for job ${manifest.jobId}`)
  }
}

async function verifyViewer(
  manifest: MonitorManifest,
  directory: string,
  control: HerdrJobMonitorControl,
  expectedArgv: string[],
): Promise<{ process: ProcessIdentity; digest: string }> {
  const raw = readSmallOwnedFile(join(directory, READY_FILE), 'monitor ready receipt')
  if (raw === null) throw new Error(`monitor viewer receipt is missing for job ${manifest.jobId}`)
  const receipt = parseReady(raw)
  if (receipt.jobId !== manifest.jobId || receipt.operationId !== manifest.operationId) {
    throw new Error(`monitor viewer receipt does not match job ${manifest.jobId}`)
  }
  if (control.processGenerationStatus(receipt.process) !== 'alive') {
    throw new Error(`monitor viewer process generation is not live for job ${manifest.jobId}`)
  }
  if (!manifest.paneId) throw new Error(`monitor pane is missing for job ${manifest.jobId}`)
  const info = await control.processInfo(manifest.paneId)
  const matching = info.foregroundProcesses.filter(processInfo => (
    processInfo.pid === receipt.process.pid
    && JSON.stringify(processInfo.argv) === JSON.stringify(expectedArgv)
    && realpathSync(processInfo.cwd) === directory
  ))
  if (info.paneId !== manifest.paneId
    || matching.length !== 1 || info.foregroundProcesses.length !== 1) {
    throw new Error(`monitor viewer process is not uniquely bound for job ${manifest.jobId}`)
  }
  return { process: receipt.process, digest: argvDigest(matching[0]!.argv) }
}

export async function verifyHerdrJobMonitorActive(input: {
  stateDir: string
  runtime: HerdrRuntimeIdentity
  jobId: string
  progressGraceMs?: number
  control?: HerdrJobMonitorControl
}): Promise<void> {
  const stateDir = requireManagedStateRoot(input.stateDir)
  const control = input.control ?? createProductionHerdrJobMonitorControl(input.runtime)
  await control.verifyRuntime()
  const directory = monitorDirectory(stateDir, input.jobId)
  const manifest = readMonitorManifest(stateDir, input.jobId)
  if (!manifest || manifest.phase !== 'active'
    || manifest.controlPlaneFingerprint !== herdrControlPlaneFingerprint(input.runtime)) {
    throw new Error(`monitor is not active for job ${input.jobId}`)
  }
  await findOrVerifyBinding(manifest, directory, input.runtime, control)
  const viewer = await verifyViewer(manifest, directory, control, viewerArguments())
  if (viewer.digest !== manifest.viewerArgvDigest
    || !sameProcessGeneration(viewer.process, manifest.viewerProcess!)) {
    throw new Error(`active monitor viewer changed for job ${input.jobId}`)
  }
  if (!viewerProgressIsFresh(manifest, readViewerProgress(directory), directory)) {
    // Sleep/wake or a brief event-loop stall can make one otherwise healthy
    // heartbeat look stale. Require the same exact viewer to miss a bounded
    // fresh-heartbeat grace period before treating monitoring as unavailable.
    await waitForFreshViewerProgress(manifest, directory, control, input.progressGraceMs)
  }
}

async function waitForMonitorPoll(signal: AbortSignal, intervalMs: number): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, intervalMs)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export async function watchHerdrJobMonitor(input: {
  stateDir: string
  runtime: HerdrRuntimeIdentity
  jobId: string
  signal: AbortSignal
  intervalMs?: number
  progressGraceMs?: number
  control?: HerdrJobMonitorControl
}): Promise<void> {
  const intervalMs = Math.max(10, input.intervalMs ?? 1_000)
  while (!input.signal.aborted) {
    await verifyHerdrJobMonitorActive(input)
    await waitForMonitorPoll(input.signal, intervalMs)
  }
}

async function activateViewer(
  manifestInput: MonitorManifest,
  directory: string,
  runtime: HerdrRuntimeIdentity,
  control: HerdrJobMonitorControl,
): Promise<MonitorManifest> {
  let manifest = manifestInput
  let runError: unknown
  if (manifest.phase === 'tab-created') {
    manifest = writeManifest(directory, { ...manifest, phase: 'run-intent' })
    const args = viewerArguments()
    try {
      await control.runPane(manifest.paneId!, viewerCommand(args))
    } catch (error) {
      // pane.run can lose its response after terminal delivery. Never resend:
      // the one-time terminal marker and ready receipt decide the outcome.
      runError = error
    }
  }
  if (manifest.phase !== 'run-intent') {
    throw new Error(`monitor is not ready to activate for job ${manifest.jobId}`)
  }
  const marker = `ZEROCHAN_MONITOR_READY:${manifest.operationId}`
  const markerSeen = await control.waitOutput(manifest.paneId!, marker, READY_TIMEOUT_MS)
  const args = viewerArguments()
  let viewer: { process: ProcessIdentity; digest: string }
  try {
    viewer = await verifyViewer(manifest, directory, control, args)
  } catch (error) {
    if (runError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; `
        + `initial pane delivery returned: ${runError instanceof Error ? runError.message : String(runError)}`,
      )
    }
    throw error
  }
  // The terminal marker is useful operational evidence, but it is ephemeral.
  // A durable receipt plus exact live process/argv/cwd binding is authoritative
  // after restart or scrollback truncation.
  if (!markerSeen) {
    appendFeed(
      directory,
      'status',
      Buffer.from('[Zeroちゃん] 起動markerは画面履歴から取得できませんでした\n', 'utf8'),
      manifest,
    )
  }
  const activeManifest: MonitorManifest = {
    ...manifest,
    phase: 'active',
    viewerProcess: viewer.process,
    viewerArgvDigest: viewer.digest,
  }
  await waitForFreshViewerProgress(activeManifest, directory, control)
  return writeManifest(directory, activeManifest)
}

export async function openHerdrJobMonitor(input: {
  stateDir: string
  runtime: HerdrRuntimeIdentity
  job: JobRecord
  progressGraceMs?: number
  beforeFirstHerdrMutation?: () => Promise<void> | void
  control?: HerdrJobMonitorControl
}): Promise<void> {
  const stateDir = requireManagedStateRoot(input.stateDir)
  safeJobId(input.job.id)
  const control = input.control ?? createProductionHerdrJobMonitorControl(input.runtime)
  await control.verifyRuntime()
  const retainedObligation = input.job.monitorState === 'required'
    || input.job.monitorState === 'lost-staged'
  if (retainedObligation) {
    try {
      requireManagedDirectory(stateDir, join(stateDir, MONITOR_ROOT))
      monitorDirectory(stateDir, input.job.id)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HerdrJobMonitorPendingError(
          `required monitor directory is missing for ${input.job.id}`,
        )
      }
      throw error
    }
  } else {
    ensureManagedDirectory(stateDir, join(stateDir, MONITOR_ROOT))
    recoverIncompleteMonitorInitialization(stateDir, input.job.id)
  }
  const directory = monitorDirectory(stateDir, input.job.id, !retainedObligation)
  let manifest = readMonitorManifest(stateDir, input.job.id)
  let createdManifest = false
  if (!manifest) {
    if (retainedObligation) {
      throw new HerdrJobMonitorPendingError(
        `required monitor manifest is missing for ${input.job.id}`,
      )
    }
    createdManifest = true
    const nonce = randomUUID().replaceAll('-', '')
    const now = Date.now()
    manifest = writeManifest(directory, {
      version: 1,
      jobId: input.job.id,
      seq: input.job.seq,
      nonce,
      operationId: randomUUID().replaceAll('-', ''),
      runtimeFingerprint: herdrRuntimeFingerprint(input.runtime),
      controlPlaneFingerprint: herdrControlPlaneFingerprint(input.runtime),
      phase: 'create-intent',
      workspaceId: input.runtime.workspaceId,
      label: `Zeroちゃん #${input.job.seq} [${nonce.slice(0, 8)}]`,
      tabId: null,
      paneId: null,
      terminalId: null,
      viewerProcess: null,
      viewerArgvDigest: null,
      createdAt: now,
      updatedAt: now,
    })
    initializeFeeds(directory, manifest)
    appendHerdrJobMonitorStatus(stateDir, input.job.id, `キュー #${input.job.seq} を準備しています`)
    appendHerdrJobMonitorStatus(
      stateDir,
      input.job.id,
      `依頼: ${stripTerminalControls(input.job.task).replace(/\s+/g, ' ').slice(0, 500)}`,
    )
  } else {
    if (manifest.seq !== input.job.seq
      || manifest.controlPlaneFingerprint !== herdrControlPlaneFingerprint(input.runtime)) {
      throw new Error(`existing monitor does not match job ${input.job.id}`)
    }
    initializeFeeds(directory, manifest)
  }

  // Persist the DB-side requirement before any Herdr mutation or adoption.
  // Repeating this for an already-required retained monitor is idempotent.
  await input.beforeFirstHerdrMutation?.()

  if (manifest.phase === 'close-intent') {
    throw new Error(`monitor close is pending for job ${input.job.id}`)
  }
  if (manifest.phase === 'create-intent') {
    let binding: { tab: HerdrMonitorTab; pane: HerdrMonitorPane }
    if (createdManifest) {
      try {
        binding = await control.createTab({
          workspaceId: manifest.workspaceId,
          cwd: directory,
          label: manifest.label,
        })
        binding = requireTabBinding(
          manifest,
          directory,
          input.runtime,
          [binding.tab],
          [binding.pane],
        )
      } catch (error) {
        try {
          binding = await findOrVerifyBinding(manifest, directory, input.runtime, control)
        } catch {
          throw error
        }
      }
    } else {
      // A prior process may have delivered tab.create before losing its
      // response. The durable intent makes a second create unsafe.
      binding = await findOrVerifyBinding(manifest, directory, input.runtime, control)
    }
    manifest = writeManifest(directory, {
      ...manifest,
      phase: 'tab-created',
      tabId: binding.tab.tabId,
      paneId: binding.pane.paneId,
      terminalId: binding.pane.terminalId,
    })
  } else {
    await findOrVerifyBinding(manifest, directory, input.runtime, control)
  }

  if (manifest.phase === 'active') {
    await verifyHerdrJobMonitorActive({
      stateDir,
      runtime: input.runtime,
      jobId: input.job.id,
      progressGraceMs: input.progressGraceMs,
      control,
    })
    appendHerdrJobMonitorStatus(stateDir, input.job.id, 'キュー処理を再開します')
    return
  }
  manifest = await activateViewer(manifest, directory, input.runtime, control)
  if (manifest.phase !== 'active') throw new Error(`monitor failed to activate for ${input.job.id}`)
  appendHerdrJobMonitorStatus(stateDir, input.job.id, '実行を開始します')
}

function manifestBindingPresent(
  manifest: MonitorManifest,
  tabs: HerdrMonitorTab[],
): boolean {
  return manifest.tabId !== null && tabs.some(tab => tab.tabId === manifest.tabId)
}

function removeClosedMonitorDirectory(stateDir: string, directory: string): void {
  retireMonitorDirectory(stateDir, directory)
}

function finalDrainMarker(manifest: MonitorManifest): string {
  return `ZEROCHAN_MONITOR_DRAINED:${manifest.operationId}`
}

async function requireFinalDrainObserved(
  manifest: MonitorManifest,
  control: HerdrJobMonitorControl,
): Promise<void> {
  if (!manifest.paneId
    || !await control.waitOutput(manifest.paneId, finalDrainMarker(manifest), DRAIN_TIMEOUT_MS)) {
    throw new Error(`Herdr did not observe final monitor output for job ${manifest.jobId}`)
  }
}

function requireDurableFinalDrainMarker(
  manifest: MonitorManifest,
  directory: string,
): void {
  const statusEpoch = parseEpoch(
    readSmallOwnedFile(epochPath(directory, 'status'), 'monitor status feed epoch'),
  )
  if (!statusEpoch.sealed) {
    throw new Error(`dead monitor viewer lacks a sealed final marker for job ${manifest.jobId}`)
  }
  const expected = Buffer.from(`[Zeroちゃん] ${finalDrainMarker(manifest)}\n`, 'utf8')
  const statusTail = readOwnedFileTail(
    feedPath(directory, 'status', statusEpoch.generation),
    STATUS_LIMIT_BYTES,
    expected.byteLength,
    'monitor status feed',
  )
  if (!statusTail.equals(expected)) {
    throw new Error(`dead monitor viewer lacks a durable final marker for job ${manifest.jobId}`)
  }
}

async function confirmDeadViewerDrain(
  manifest: MonitorManifest,
  directory: string,
  paneId: string,
  control: HerdrJobMonitorControl,
  recovered = false,
): Promise<void> {
  requireDurableFinalDrainMarker(manifest, directory)
  const targets = snapshotFeedTargets(directory)
  if (!viewerProgressCovers(manifest, readViewerProgress(directory), targets)) {
    throw new Error(
      `${recovered ? 'dead recovered' : 'dead'} monitor viewer had undrained output for job ${manifest.jobId}`,
    )
  }
  await requireFinalDrainObserved(manifest, control)
  const info = await control.processInfo(paneId)
  if (info.paneId !== paneId || info.foregroundProcesses.length !== 0) {
    throw new Error(
      `${recovered ? 'dead recovered' : 'dead'} monitor viewer was replaced before close for job ${manifest.jobId}`,
    )
  }
}

async function confirmLiveViewerDrain(
  manifest: MonitorManifest,
  directory: string,
  runtime: HerdrRuntimeIdentity,
  control: HerdrJobMonitorControl,
): Promise<void> {
  // First wait until every output stream write callback is complete. Then put
  // a stable marker behind those writes, wait for the viewer ACK, and finally
  // require Herdr's pane reader itself to observe that marker before close.
  sealFeed(directory, 'stdout')
  sealFeed(directory, 'stderr')
  await waitForViewerDrain(manifest, directory, control, snapshotFeedTargets(directory))
  const statusEpoch = parseEpoch(
    readSmallOwnedFile(epochPath(directory, 'status'), 'monitor status feed epoch'),
  )
  if (!statusEpoch.sealed) {
    appendFeed(
      directory,
      'status',
      Buffer.from(`[Zeroちゃん] ${finalDrainMarker(manifest)}\n`, 'utf8'),
      manifest,
    )
    sealFeed(directory, 'status')
  }
  await waitForViewerDrain(manifest, directory, control, snapshotFeedTargets(directory))
  await requireFinalDrainObserved(manifest, control)
  await findOrVerifyBinding(manifest, directory, runtime, control)
  const finalViewer = await verifyViewer(manifest, directory, control, viewerArguments())
  if (finalViewer.digest !== manifest.viewerArgvDigest
    || !sameProcessGeneration(finalViewer.process, manifest.viewerProcess!)) {
    throw new Error(`monitor viewer changed after final drain for job ${manifest.jobId}`)
  }
}

async function verifyExactCloseTarget(
  manifest: MonitorManifest,
  directory: string,
  runtime: HerdrRuntimeIdentity,
  control: HerdrJobMonitorControl,
): Promise<void> {
  const binding = await findOrVerifyBinding(manifest, directory, runtime, control)
  if (manifest.viewerProcess) {
    const status = control.processGenerationStatus(manifest.viewerProcess)
    if (status === 'alive') {
      const viewer = await verifyViewer(manifest, directory, control, viewerArguments())
      if (viewer.digest !== manifest.viewerArgvDigest
        || !sameProcessGeneration(viewer.process, manifest.viewerProcess)) {
        throw new Error(`monitor viewer changed immediately before close for job ${manifest.jobId}`)
      }
      return
    }
    if (status === 'unknown') {
      throw new Error(`monitor viewer state is unknown immediately before close for job ${manifest.jobId}`)
    }
  }
  const info = await control.processInfo(binding.pane.paneId)
  if (info.paneId !== binding.pane.paneId || info.foregroundProcesses.length !== 0) {
    throw new Error(`monitor pane was occupied immediately before close for job ${manifest.jobId}`)
  }
}

export async function closeHerdrJobMonitor(input: {
  stateDir: string
  runtime: HerdrRuntimeIdentity
  jobId: string
  outcome?: 'completed' | 'failed' | 'cancelled'
  onMonitorRetired?: (jobId: string) => Promise<void> | void
  control?: HerdrJobMonitorControl
}): Promise<void> {
  const stateDir = requireManagedStateRoot(input.stateDir)
  const control = input.control ?? createProductionHerdrJobMonitorControl(input.runtime)
  await control.verifyRuntime()
  let directory: string
  try { directory = monitorDirectory(stateDir, input.jobId) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HerdrJobMonitorPendingError(
        `monitor state disappeared before close for job ${input.jobId}`,
      )
    }
    throw error
  }
  const existingManifest = readMonitorManifest(stateDir, input.jobId)
  if (!existingManifest) throw new Error(`monitor manifest is missing for job ${input.jobId}`)
  let manifest: MonitorManifest = existingManifest
  // A crash can occur after the next immutable feed generation is durable but
  // before its epoch pointer is swapped. Adopt that generation before taking
  // any terminal drain snapshot, otherwise close could discard staged output.
  initializeFeeds(directory, manifest)
  const tabs = await control.listTabs(manifest.workspaceId)
  const canDiscoverCreateIntent = manifest.phase === 'create-intent'
    && tabs.filter(tab => tab.label === manifest.label).length === 1
  if (!manifestBindingPresent(manifest, tabs) && !canDiscoverCreateIntent) {
    await proveManifestBindingAbsent(manifest, directory, control)
    if (manifest.phase !== 'close-intent' && manifest.phase !== 'create-intent') {
      throw new HerdrJobMonitorPendingError(
        `monitor binding disappeared before a durable close intent for job ${input.jobId}`,
      )
    }
    await waitForViewerStopped(manifest.viewerProcess, control)
    await input.onMonitorRetired?.(input.jobId)
    removeClosedMonitorDirectory(stateDir, directory)
    return
  }
  const binding = await findOrVerifyBinding(manifest, directory, input.runtime, control)
  manifest = {
    ...manifest,
    tabId: binding.tab.tabId,
    paneId: binding.pane.paneId,
    terminalId: binding.pane.terminalId,
  }
  if (manifest.phase === 'active'
    || (manifest.phase === 'close-intent' && manifest.viewerProcess !== null)) {
    const processStatus = control.processGenerationStatus(manifest.viewerProcess!)
    if (processStatus === 'alive') {
      const viewer = await verifyViewer(manifest, directory, control, viewerArguments())
      if (viewer.digest !== manifest.viewerArgvDigest
        || !sameProcessGeneration(viewer.process, manifest.viewerProcess!)) {
        throw new Error(`monitor viewer identity changed before close for job ${input.jobId}`)
      }
    } else if (processStatus === 'dead') {
      // A dead viewer cannot emit a new terminal marker. Only accept one that
      // had already ACKed the sealed marker and whose exact Herdr pane still
      // exposes that marker. A feed offset alone proves a read, not a render.
      await confirmDeadViewerDrain(
        manifest,
        directory,
        binding.pane.paneId,
        control,
      )
    } else {
      throw new Error(`monitor viewer state is unknown before close for job ${input.jobId}`)
    }
    if (processStatus === 'alive') {
      const statusEpoch = parseEpoch(
        readSmallOwnedFile(epochPath(directory, 'status'), 'monitor status feed epoch'),
      )
      if (manifest.phase === 'active' && !statusEpoch.sealed) {
        appendHerdrJobMonitorStatus(
          stateDir,
          input.jobId,
          input.outcome === 'failed'
            ? 'タスク処理は失敗として終了しました'
            : input.outcome === 'cancelled'
              ? 'タスク処理は中止されました'
              : 'タスク処理が完了しました',
        )
      }
      await confirmLiveViewerDrain(manifest, directory, input.runtime, control)
    }
  } else {
    const ready = readSmallOwnedFile(join(directory, READY_FILE), 'monitor ready receipt')
    if (ready !== null) {
      // runPane may have delivered a viewer before its response was lost. A
      // terminal recovery may close that tab only after adopting the exact
      // receipt/process/argv/cwd generation and draining all selected feeds.
      const receipt = parseReady(ready)
      if (receipt.jobId !== manifest.jobId || receipt.operationId !== manifest.operationId) {
        throw new Error(`monitor viewer receipt does not match job ${manifest.jobId}`)
      }
      manifest = {
        ...manifest,
        viewerProcess: receipt.process,
        viewerArgvDigest: argvDigest(viewerArguments()),
      }
      const processStatus = control.processGenerationStatus(receipt.process)
      if (processStatus === 'alive') {
        const viewer = await verifyViewer(manifest, directory, control, viewerArguments())
        manifest = { ...manifest, viewerArgvDigest: viewer.digest }
        await confirmLiveViewerDrain(manifest, directory, input.runtime, control)
      } else if (processStatus === 'dead') {
        await confirmDeadViewerDrain(
          manifest,
          directory,
          binding.pane.paneId,
          control,
          true,
        )
      } else {
        throw new Error(`recovered monitor viewer state is unknown for job ${input.jobId}`)
      }
    } else {
      // No viewer receipt means no task process is expected. Re-check the
      // exact pane immediately before close and refuse to close a foreign
      // foreground process, including on a close-intent retry.
      const info = await control.processInfo(binding.pane.paneId)
      if (info.paneId !== binding.pane.paneId || info.foregroundProcesses.length !== 0) {
        throw new Error(`monitor pane was occupied before close for job ${input.jobId}`)
      }
    }
  }
  manifest = writeManifest(directory, { ...manifest, phase: 'close-intent' })
  // The durable close intent itself creates a scheduling window. Re-prove the
  // exact live viewer generation or exact empty pane after that fsync, then
  // issue the close immediately. Herdr has no compare-and-close primitive, so
  // this is the narrowest available race boundary.
  await verifyExactCloseTarget(manifest, directory, input.runtime, control)
  // Unlike create/run, close targets an already verified exact tab/pane/
  // terminal binding. If a prior close response was lost while the exact
  // binding still exists, repeating this destructive operation cannot create
  // a duplicate viewer or target a replacement pane.
  try { await control.closeTab(binding.tab.tabId) } catch {
    // A close response can be lost after Herdr accepted it. Absence below is
    // the only success criterion. A later reconciliation may retry only after
    // re-proving this same exact binding and final-drain marker.
  }
  await proveManifestBindingAbsent(manifest, directory, control)
  await waitForViewerStopped(manifest.viewerProcess, control)
  await input.onMonitorRetired?.(input.jobId)
  removeClosedMonitorDirectory(stateDir, directory)
}

export async function reconcileHerdrJobMonitors(input: {
  stateDir: string
  runtime: HerdrRuntimeIdentity
  getJob(jobId: string): Pick<JobRecord, 'status'> | null
  listMonitorObligations?: () => Array<{
    id: string
    status: JobStatus
    state: 'preparing' | 'required' | 'lost-staged'
  }>
  recoverMissingBindingAfterExecutorsStopped?: (
    jobId: string,
    status: JobStatus | 'missing',
    state: 'preparing' | 'required' | 'lost-staged',
  ) => 'terminalized' | 'unarmed' | 'staged-result'
  onMonitorRetired?: (jobId: string) => Promise<void> | void
  progressGraceMs?: number
  control?: HerdrJobMonitorControl
}): Promise<{ retained: number; closed: number; retainedJobIds: string[] }> {
  const stateDir = requireManagedStateRoot(input.stateDir)
  const control = input.control ?? createProductionHerdrJobMonitorControl(input.runtime)
  await control.verifyRuntime()
  scavengeRetiredMonitorDirectories(stateDir)
  const obligations = (): Map<string, {
    status: JobStatus
    state: 'preparing' | 'required' | 'lost-staged'
  }> => {
    const values = input.listMonitorObligations?.() ?? []
    const result = new Map<string, {
      status: JobStatus
      state: 'preparing' | 'required' | 'lost-staged'
    }>()
    for (const value of values) {
      safeJobId(value.id)
      if (result.has(value.id)) throw new Error(`duplicate monitor obligation: ${value.id}`)
      result.set(value.id, { status: value.status, state: value.state })
    }
    return result
  }
  const recoverObligation = (
    jobId: string,
    status: JobStatus | 'missing',
    state: 'preparing' | 'required' | 'lost-staged',
  ): 'terminalized' | 'unarmed' | 'staged-result' => {
    const disposition = input.recoverMissingBindingAfterExecutorsStopped?.(
      jobId, status, state,
    )
    if (!disposition) {
      throw new HerdrJobMonitorPendingError(
        `monitor recovery callback is unavailable for ${jobId}`,
      )
    }
    const current = obligations().get(jobId)
    const recoveredStatus = input.getJob(jobId)?.status ?? 'missing'
    if (disposition === 'terminalized'
      && (recoveredStatus === 'queued' || recoveredStatus === 'running')) {
      throw new HerdrJobMonitorPendingError(
        `monitor loss recovery did not terminalize non-terminal job ${jobId}`,
      )
    }
    if (disposition === 'unarmed' && current !== undefined) {
      throw new HerdrJobMonitorPendingError(
        `monitor preparation recovery did not remove obligation for ${jobId}`,
      )
    }
    if (disposition === 'staged-result' && current?.state !== 'lost-staged') {
      throw new HerdrJobMonitorPendingError(
        `staged monitor loss recovery was not durable for ${jobId}`,
      )
    }
    return disposition
  }
  let root: string
  try { root = requireManagedDirectory(stateDir, join(stateDir, MONITOR_ROOT)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const retainedJobIds: string[] = []
      for (const [jobId, obligation] of obligations()) {
        if (obligation.state === 'lost-staged') {
          throw new HerdrJobMonitorPendingError(
            `staged execution remains blocked after losing its Herdr monitor: ${jobId}`,
          )
        }
        if (obligation.state === 'preparing') {
          recoverObligation(jobId, obligation.status, obligation.state)
          continue
        }
        throw new HerdrJobMonitorPendingError(
          `required monitor state directory is missing for ${jobId}`,
        )
      }
      return { retained: 0, closed: 0, retainedJobIds }
    }
    throw error
  }
  let retained = 0
  let closed = 0
  const retainedJobIds: string[] = []
  const names = readdirSync(root).sort()
  const nameSet = new Set(names)
  for (const [jobId, obligation] of obligations()) {
    if (nameSet.has(jobId)) continue
    if (obligation.state === 'lost-staged') {
      throw new HerdrJobMonitorPendingError(
        `staged execution remains blocked after losing its Herdr monitor: ${jobId}`,
      )
    }
    if (obligation.state === 'preparing') {
      recoverObligation(jobId, obligation.status, obligation.state)
      continue
    }
    throw new HerdrJobMonitorPendingError(
      `required monitor directory is missing for ${jobId}`,
    )
  }
  for (const name of names) {
    safeJobId(name)
    const directory = requireManagedDirectory(stateDir, join(root, name))
    if (basename(directory) !== name) throw new Error(`monitor directory moved: ${name}`)
    const obligationBeforeRecovery = obligations().get(name)
    if (obligationBeforeRecovery?.state === 'required'
      || obligationBeforeRecovery?.state === 'lost-staged') {
      const rawManifest = readSmallOwnedFile(join(directory, MANIFEST_FILE), 'monitor manifest')
      if (rawManifest === null) {
        throw new HerdrJobMonitorPendingError(
          `required monitor manifest is missing for ${name}`,
        )
      }
    } else if (recoverIncompleteMonitorInitialization(stateDir, name)) {
      if (obligationBeforeRecovery?.state === 'preparing') {
        recoverObligation(name, obligationBeforeRecovery.status, obligationBeforeRecovery.state)
      }
      continue
    }
    const manifest = readMonitorManifest(stateDir, name)
    if (!manifest || manifest.jobId !== name
      || manifest.controlPlaneFingerprint !== herdrControlPlaneFingerprint(input.runtime)) {
      throw new Error(`monitor state is invalid for job ${name}`)
    }
    // Reconcile staged generation files even when the DB row became terminal
    // during earlier result/advisor-cleanup recovery, and before a queued
    // rate-limit job is considered healthy again.
    initializeFeeds(directory, manifest)
    const job = input.getJob(name)
    const status: JobStatus | 'missing' = job?.status ?? 'missing'
    const obligation = obligations().get(name)
    if (input.recoverMissingBindingAfterExecutorsStopped) {
      const localTabs = await control.listTabs(manifest.workspaceId)
      const bindingCouldExist = manifestBindingPresent(manifest, localTabs)
        || (manifest.phase === 'create-intent'
          && localTabs.some(tab => tab.label === manifest.label))
      if (!bindingCouldExist) {
        // This callback is intentionally available only to the runner's
        // startup/recover-interrupted path after tracked Codex and advisor
        // processes were terminated. Prove global absence and viewer death;
        // never recreate a tab because that would hide an unobserved interval.
        await proveManifestBindingAbsent(manifest, directory, control)
        await waitForViewerStopped(manifest.viewerProcess, control)
        if (manifest.phase === 'close-intent') {
          await closeHerdrJobMonitor({
            stateDir,
            runtime: input.runtime,
            jobId: name,
            outcome: status === 'failed' ? 'failed' : 'completed',
            onMonitorRetired: input.onMonitorRetired,
            control,
          })
          closed += 1
          continue
        }
        if (obligation?.state !== 'preparing') {
          throw new HerdrJobMonitorPendingError(
            `required monitor binding disappeared before its final output was observed for ${name}`,
          )
        }
        const state = obligation?.state ?? 'required'
        const disposition = recoverObligation(name, status, state)
        if (disposition === 'staged-result') {
          throw new HerdrJobMonitorPendingError(
            `staged execution remains blocked after losing its Herdr monitor: ${name}`,
          )
        }
        removeClosedMonitorDirectory(stateDir, directory)
        closed += 1
        continue
      }
    }
    if (obligation?.state === 'preparing') {
      throw new HerdrJobMonitorPendingError(
        `unarmed monitor preparation has a Herdr binding for ${name}`,
      )
    }
    if (obligation?.state === 'lost-staged') {
      throw new HerdrJobMonitorPendingError(
        `lost-staged monitor unexpectedly has a Herdr binding for ${name}`,
      )
    }
    if (status === 'completed' || status === 'failed' || status === 'missing') {
      await closeHerdrJobMonitor({
        stateDir,
        runtime: input.runtime,
        jobId: name,
        outcome: status === 'failed' ? 'failed' : 'completed',
        onMonitorRetired: input.onMonitorRetired,
        control,
      })
      closed += 1
      continue
    }
    let retainedManifest = manifest
    if (manifest.phase === 'active') {
      try {
        await verifyHerdrJobMonitorActive({
          stateDir,
          runtime: input.runtime,
          jobId: name,
          progressGraceMs: input.progressGraceMs,
          control,
        })
      } catch (error) {
        // A queued/running DB row is not terminal. Losing its mandatory
        // monitor must stop recovery and preserve both the job and tab state;
        // silently closing and later recreating a tab would hide an execution
        // interval and violate the single continuous monitor contract.
        throw new HerdrJobMonitorPendingError(
          `active Herdr monitor cannot be retained for non-terminal job ${name}: ${error}`,
        )
      }
    } else if (manifest.phase === 'create-intent') {
      // Never resend tab.create after a durable intent. Adopt only one exact
      // response-loss binding, then continue through the one-time run intent.
      const binding = await findOrVerifyBinding(
        manifest,
        directory,
        input.runtime,
        control,
      )
      retainedManifest = writeManifest(directory, {
        ...manifest,
        phase: 'tab-created',
        tabId: binding.tab.tabId,
        paneId: binding.pane.paneId,
        terminalId: binding.pane.terminalId,
      })
      retainedManifest = await activateViewer(
        retainedManifest,
        directory,
        input.runtime,
        control,
      )
    } else if (manifest.phase === 'tab-created' || manifest.phase === 'run-intent') {
      await findOrVerifyBinding(manifest, directory, input.runtime, control)
      retainedManifest = await activateViewer(manifest, directory, input.runtime, control)
    } else if (manifest.phase === 'close-intent') {
      throw new Error(`monitor close is unresolved for queued job ${name}`)
    }
    if (retainedManifest.phase !== 'active') {
      throw new Error(`monitor recovery did not activate job ${name}`)
    }
    retained += 1
    retainedJobIds.push(name)
  }
  return { retained, closed, retainedJobIds }
}
