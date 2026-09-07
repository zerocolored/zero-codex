#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { randomUUID } from 'crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  unlinkSync,
} from 'fs'
import { join } from 'path'
import { requireManagedStateRoot } from './managed-path.ts'
import {
  acquireProcessGroupLeaderIdentity,
  observeProcessGeneration,
  processStartKey,
  readProcessIdentity,
  sameProcessGeneration,
  type ProcessIdentity,
} from './process-generation.ts'
import {
  atomicWritePrivateFile,
  readOptionalBoundedOwnerOnlyRegularFile,
} from './safe-file.ts'
import {
  releaseProcessLock,
  tryAcquireProcessLock,
} from './process-lock.ts'

const RECEIPT_BASENAME = 'job-runner-launch.json'
const MUTATION_LOCK_BASENAME = 'job-runner-launch-mutation.lock'
const MAX_RECEIPT_BYTES = 4 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BOOT_SESSION_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export interface RunnerLaunchProcessGeneration {
  pid: number
  pgid: number
  uid: number
  bootSession: string
  startSec: number
  startUsec: number
  started: string
}

export interface PreparedRunnerLaunchReceipt {
  version: 1
  state: 'prepared'
  intentId: string
  preparedAt: number
  launcher: RunnerLaunchProcessGeneration
}

export interface PublishedRunnerLaunchReceipt {
  version: 1
  state: 'published'
  intentId: string
  preparedAt: number
  publishedAt: number
  launcher: RunnerLaunchProcessGeneration
  runner: RunnerLaunchProcessGeneration
}

export type RunnerLaunchReceipt =
  | PreparedRunnerLaunchReceipt
  | PublishedRunnerLaunchReceipt

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length
    && actual.every((value, index) => value === wanted[index])
}

function parseProcessGeneration(value: unknown): RunnerLaunchProcessGeneration | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (!exactKeys(record, [
    'pid', 'pgid', 'uid', 'bootSession', 'startSec', 'startUsec', 'started',
  ])) return undefined
  if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 1
    || !Number.isSafeInteger(record.pgid) || Number(record.pgid) <= 1
    || !Number.isSafeInteger(record.uid) || Number(record.uid) < 0
    || typeof record.bootSession !== 'string'
    || !BOOT_SESSION_PATTERN.test(record.bootSession)
    || !Number.isSafeInteger(record.startSec) || Number(record.startSec) <= 0
    || !Number.isSafeInteger(record.startUsec) || Number(record.startUsec) < 0
    || Number(record.startUsec) > 999_999
    || typeof record.started !== 'string') return undefined
  const generation = {
    pid: Number(record.pid),
    pgid: Number(record.pgid),
    uid: Number(record.uid),
    bootSession: record.bootSession.toUpperCase(),
    startSec: Number(record.startSec),
    startUsec: Number(record.startUsec),
    started: record.started,
  }
  try {
    if (processStartKey(generation) !== generation.started) return undefined
  } catch {
    return undefined
  }
  if (typeof process.getuid === 'function' && generation.uid !== process.getuid()) {
    return undefined
  }
  return generation
}

function processGeneration(identity: ProcessIdentity): RunnerLaunchProcessGeneration {
  if (!Number.isSafeInteger(identity.uid) || Number(identity.uid) < 0) {
    throw new Error(`process ${identity.pid} owner identity is unavailable`)
  }
  const generation = parseProcessGeneration({
    pid: identity.pid,
    pgid: identity.pgid,
    uid: identity.uid,
    bootSession: identity.bootSession,
    startSec: identity.startSec,
    startUsec: identity.startUsec,
    started: identity.started,
  })
  if (!generation) throw new Error(`process ${identity.pid} generation is invalid`)
  return generation
}

function sameGeneration(
  left: RunnerLaunchProcessGeneration,
  right: RunnerLaunchProcessGeneration,
): boolean {
  return sameProcessGeneration(left, right)
    && left.started === right.started
    && left.pgid === right.pgid
    && left.uid === right.uid
}

function parseReceipt(raw: string): RunnerLaunchReceipt {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('runner launch receipt is not JSON') }
  if (!value || typeof value !== 'object') throw new Error('runner launch receipt is invalid')
  const record = value as Record<string, unknown>
  const commonValid = record.version === 1
    && typeof record.intentId === 'string'
    && UUID_PATTERN.test(record.intentId)
    && Number.isSafeInteger(record.preparedAt)
    && Number(record.preparedAt) > 0
  if (!commonValid) throw new Error('runner launch receipt is invalid')
  const launcher = parseProcessGeneration(record.launcher)
  if (!launcher) throw new Error('runner launch receipt launcher is invalid')
  if (record.state === 'prepared') {
    if (!exactKeys(record, ['version', 'state', 'intentId', 'preparedAt', 'launcher'])) {
      throw new Error('runner launch receipt has unexpected fields')
    }
    return {
      version: 1,
      state: 'prepared',
      intentId: record.intentId as string,
      preparedAt: Number(record.preparedAt),
      launcher,
    }
  }
  if (record.state !== 'published'
    || !exactKeys(record, [
      'version', 'state', 'intentId', 'preparedAt', 'publishedAt', 'launcher', 'runner',
    ])
    || !Number.isSafeInteger(record.publishedAt)
    || Number(record.publishedAt) < Number(record.preparedAt)) {
    throw new Error('runner launch receipt is invalid')
  }
  const runner = parseProcessGeneration(record.runner)
  if (!runner || runner.pgid !== runner.pid
    || runner.uid !== launcher.uid
    || runner.bootSession !== launcher.bootSession) {
    throw new Error('runner launch receipt runner is invalid')
  }
  return {
    version: 1,
    state: 'published',
    intentId: record.intentId as string,
    preparedAt: Number(record.preparedAt),
    publishedAt: Number(record.publishedAt),
    launcher,
    runner,
  }
}

function receiptPath(stateDir: string): { stateDir: string; path: string } {
  const canonicalState = requireManagedStateRoot(stateDir)
  return { stateDir: canonicalState, path: join(canonicalState, RECEIPT_BASENAME) }
}

function withReceiptMutation<T>(stateDir: string, operation: () => T): T {
  const canonicalState = requireManagedStateRoot(stateDir)
  const lockPath = join(canonicalState, MUTATION_LOCK_BASENAME)
  const deadline = Date.now() + 2_000
  while (true) {
    const attempted = tryAcquireProcessLock(lockPath, process.pid)
    if (attempted.acquired) {
      try {
        return operation()
      } finally {
        if (!releaseProcessLock(lockPath, attempted.lease)) {
          throw new Error('runner launch receipt mutation lock could not be released')
        }
      }
    }
    if (attempted.kind === 'owner-unavailable') {
      throw new Error('runner launch receipt mutation owner cannot be verified')
    }
    if (Date.now() >= deadline) {
      throw new Error('runner launch receipt mutation is busy')
    }
    Bun.sleepSync(5)
  }
}

function writeReceipt(path: string, receipt: RunnerLaunchReceipt): void {
  atomicWritePrivateFile(path, `${JSON.stringify(receipt)}\n`)
}

function synchronizeDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const metadata = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isDirectory() || !ownerMatches) {
      throw new Error(`unsafe managed directory: ${path}`)
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function runnerLaunchReceiptPath(stateDir: string): string {
  return receiptPath(stateDir).path
}

export function readRunnerLaunchReceipt(stateDir: string): RunnerLaunchReceipt | null {
  const { path } = receiptPath(stateDir)
  const raw = readOptionalBoundedOwnerOnlyRegularFile(path, MAX_RECEIPT_BYTES)
  return raw === null ? null : parseReceipt(raw)
}

export function prepareRunnerLaunchReceipt(
  stateDir: string,
  launcherIdentity: ProcessIdentity,
  now = Date.now(),
): PreparedRunnerLaunchReceipt {
  if (launcherIdentity.pid !== process.pid) {
    throw new Error('runner launch intent must be prepared by the launcher generation itself')
  }
  const liveLauncher = readProcessIdentity(process.pid)
  if (!liveLauncher || !sameProcessGeneration(launcherIdentity, liveLauncher)) {
    throw new Error('runner launcher generation changed before intent publication')
  }
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('runner launch time is invalid')
  return withReceiptMutation(stateDir, () => {
    const { path } = receiptPath(stateDir)
    if (readRunnerLaunchReceipt(stateDir) !== null) {
      throw new Error('an unresolved runner launch receipt already exists')
    }
    const receipt: PreparedRunnerLaunchReceipt = {
      version: 1,
      state: 'prepared',
      intentId: randomUUID(),
      preparedAt: now,
      launcher: processGeneration(liveLauncher),
    }
    writeReceipt(path, receipt)
    const stored = readRunnerLaunchReceipt(stateDir)
    if (!stored || stored.state !== 'prepared' || stored.intentId !== receipt.intentId
      || !sameGeneration(stored.launcher, receipt.launcher)) {
      throw new Error('runner launch intent could not be durably verified')
    }
    return stored
  })
}

export function publishRunnerLaunchReceipt(
  stateDir: string,
  intentId: string,
  runnerIdentity: ProcessIdentity,
  now = Date.now(),
): PublishedRunnerLaunchReceipt {
  if (!UUID_PATTERN.test(intentId)) throw new Error('runner launch intent ID is invalid')
  const runner = processGeneration(runnerIdentity)
  if (runner.pgid !== runner.pid) {
    throw new Error('runner launch generation is not a process-group leader')
  }
  return withReceiptMutation(stateDir, () => {
    const current = readRunnerLaunchReceipt(stateDir)
    if (!current || current.intentId !== intentId) {
      throw new Error('runner launch intent is unavailable')
    }
    if (runner.uid !== current.launcher.uid
      || runner.bootSession !== current.launcher.bootSession) {
      throw new Error('runner launch generation is not owned by the launcher session')
    }
    if (current.state === 'published') {
      if (!sameGeneration(current.runner, runner)) {
        throw new Error('runner launch intent is already bound to another generation')
      }
      return current
    }
    if (!Number.isSafeInteger(now) || now < current.preparedAt) {
      throw new Error('runner launch publication time is invalid')
    }
    const receipt: PublishedRunnerLaunchReceipt = {
      ...current,
      state: 'published',
      publishedAt: now,
      runner,
    }
    const { path } = receiptPath(stateDir)
    writeReceipt(path, receipt)
    const stored = readRunnerLaunchReceipt(stateDir)
    if (!stored || stored.state !== 'published' || stored.intentId !== intentId
      || !sameGeneration(stored.runner, runner)
      || !sameGeneration(stored.launcher, current.launcher)) {
      throw new Error('runner launch publication could not be durably verified')
    }
    return stored
  })
}

export async function waitForPublishedRunnerLaunchReceipt(
  stateDir: string,
  options: {
    intentId?: string
    launcher?: RunnerLaunchProcessGeneration
    timeoutMs?: number
    pollMs?: number
  } = {},
): Promise<PublishedRunnerLaunchReceipt | null> {
  const timeoutMs = options.timeoutMs ?? 2_000
  const pollMs = options.pollMs ?? 10
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0
    || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error('runner launch receipt wait is invalid')
  }
  const deadline = Date.now() + timeoutMs
  while (true) {
    const receipt = readRunnerLaunchReceipt(stateDir)
    if (!receipt) return null
    if ((options.intentId && receipt.intentId !== options.intentId)
      || (options.launcher && !sameGeneration(receipt.launcher, options.launcher))) {
      throw new Error('runner launch receipt changed while waiting')
    }
    if (receipt.state === 'published') return receipt
    if (Date.now() >= deadline) return null
    await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

function removeExactReceipt(
  stateDir: string,
  expected: RunnerLaunchReceipt,
): boolean {
  return withReceiptMutation(stateDir, () => {
    const current = readRunnerLaunchReceipt(stateDir)
    if (!current) return false
    if (current.intentId !== expected.intentId || current.state !== expected.state
      || !sameGeneration(current.launcher, expected.launcher)
      || (current.state === 'published'
        && (expected.state !== 'published' || !sameGeneration(current.runner, expected.runner)))) {
      throw new Error('runner launch receipt changed before cleanup')
    }
    const { stateDir: canonicalState, path } = receiptPath(stateDir)
    unlinkSync(path)
    synchronizeDirectory(canonicalState)
    if (readRunnerLaunchReceipt(stateDir) !== null) {
      throw new Error('runner launch receipt cleanup was not durable')
    }
    return true
  })
}

export function clearUnspawnedRunnerLaunchIntent(
  stateDir: string,
  expected: PreparedRunnerLaunchReceipt,
): boolean {
  const launcher = readProcessIdentity(process.pid)
  if (process.pid !== expected.launcher.pid || !launcher
    || !sameProcessGeneration(expected.launcher, launcher)) {
    throw new Error('only the live launcher generation may clear an unspawned intent')
  }
  return removeExactReceipt(stateDir, expected)
}

export function clearAbandonedRunnerLaunchIntent(
  stateDir: string,
  expected: PreparedRunnerLaunchReceipt,
): boolean {
  const launcher = observeProcessGeneration(expected.launcher)
  if (launcher.status !== 'dead') {
    throw new Error(launcher.status === 'unknown'
      ? 'abandoned runner launcher generation cannot be confirmed'
      : 'live runner launcher intent cannot be abandoned')
  }
  return removeExactReceipt(stateDir, expected)
}

export function clearRunnerLaunchReceiptAfterReap(
  stateDir: string,
  expected: RunnerLaunchReceipt,
  knownRunner?: Pick<ProcessIdentity, 'pid' | 'bootSession' | 'startSec' | 'startUsec'>,
): boolean {
  const runner = expected.state === 'published' ? expected.runner : knownRunner
  if (!runner) throw new Error('reaped runner generation is required')
  if (expected.state === 'published' && knownRunner
    && !sameProcessGeneration(expected.runner, knownRunner)) {
    throw new Error('reaped runner generation does not match the launch receipt')
  }
  const observation = observeProcessGeneration(runner)
  if (observation.status !== 'dead') {
    throw new Error(observation.status === 'unknown'
      ? 'reaped runner generation cannot be confirmed'
      : 'runner launch receipt cannot be cleared before child reap')
  }
  return removeExactReceipt(stateDir, expected)
}

async function publishChildFromEnvironment(stateDir: string): Promise<void> {
  const intentId = process.env.ZEROKUN_RUNNER_LAUNCH_INTENT
  if (!intentId || !UUID_PATTERN.test(intentId)) {
    throw new Error('runner launch child intent is unavailable')
  }
  const identity = await acquireProcessGroupLeaderIdentity(process.ppid)
  if (!identity) throw new Error('runner launch child generation could not be pinned')
  publishRunnerLaunchReceipt(stateDir, intentId, identity)
}

if (import.meta.main) {
  const [command, stateDir] = process.argv.slice(2)
  if (command !== 'publish-child' || !stateDir) {
    process.stderr.write('usage: runner-launch-receipt.ts publish-child STATE_DIR\n')
    process.exit(2)
  }
  try {
    await publishChildFromEnvironment(stateDir)
  } catch (error) {
    process.stderr.write(
      `runner launch receipt publication failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  }
}
