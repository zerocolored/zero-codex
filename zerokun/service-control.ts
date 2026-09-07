#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { closeSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import {
  acquireUpdateLock,
  activeJobCountsFromDatabase,
  closeRecordedHerdrServiceTab,
  startBotInHerdr,
  stopLockedProcess,
  waitForStableHealth,
} from './update.ts'
import {
  discardProcessLock,
  inspectProcessLock,
  processLockOwnerMatches,
  stopProcessLockOwner,
} from './process-lock.ts'
import {
  acquireProcessGroupLeaderIdentity,
  observeProcessGeneration,
  processIdentityIsStopped,
  readProcessIdentity,
  readProcessTable,
  sameProcessGeneration,
  signalProcessGroupIfLeaderLive,
  signalProcessIfLive,
  type ProcessIdentity,
} from './process-generation.ts'
import { freezeAndKillTrackedProcessTree } from './process-tree.ts'
import { readGatewayReadiness } from './readiness.ts'
import { requireManagedStateRoot } from './managed-path.ts'
import { resolveZeroJobDatabasePath } from './state-dir.ts'
import {
  environmentForPinnedHerdrRuntime,
  herdrControlPlaneFingerprint,
  herdrRuntimeFingerprint,
  readPinnedHerdrRuntime,
  requireHerdrRuntime,
  verifyHerdrRuntimeIdentityAsync,
  writePinnedHerdrRuntime,
  type HerdrRuntimeIdentity,
} from './herdr-runtime.ts'
import { openSafeLog, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import {
  clearAbandonedRunnerLaunchIntent,
  clearRunnerLaunchReceiptAfterReap,
  readRunnerLaunchReceipt,
  waitForPublishedRunnerLaunchReceipt,
  type RunnerLaunchReceipt,
} from './runner-launch-receipt.ts'
import {
  clearIntentionalServiceStop,
  clearServiceControlPauseRequest,
  createServiceControlPauseRequest,
  serviceControlPauseAcknowledged,
  writeIntentionalServiceStop,
} from './service-control-state.ts'

type ManagedProcess = {
  label: string
  lockFile: string
  pattern: RegExp
  pid: number | null
}

type StartedRunnerLauncher = {
  pid: number
  identity: ProcessIdentity
}

type ServiceControlHooks = {
  controlRuntime?: HerdrRuntimeIdentity
  verifyControlRuntime?: (runtime: HerdrRuntimeIdentity) => Promise<void>
  closeRecordedTab?: typeof closeRecordedHerdrServiceTab
  startBot?: typeof startBotInHerdr
  sleep?: (milliseconds: number) => Promise<void>
  pauseTimeoutMs?: number
  forceStopTimeoutMs?: number
  recoverForcedJobs?: (input: {
    stateDir: string
    runtime: HerdrRuntimeIdentity
  }) => Promise<{ completed: number; failed: number; queued: number }>
  startRunnerLauncher?: (input: {
    rootRepo: string
    stateDir: string
    runtime: HerdrRuntimeIdentity
    sleep: (milliseconds: number) => Promise<void>
  }) => Promise<StartedRunnerLauncher>
  runnerLauncherStartTimeoutMs?: number
  runnerLauncherCleanupGraceMs?: number
}

export type StopManagedServiceOptions = {
  force?: boolean
}

const APP_ID_PATTERN = /^A[A-Z0-9]+$/
const SERVICE_MUTATION_PATTERN = /(?:update\.ts|zerokun-update|setup\.sh|service-control\.ts)(?:\s|$)/

export type ServiceControlResult = {
  status: 'already-running' | 'started' | 'already-stopped' | 'stopped'
  gatewayPid?: number
  runnerPid?: number
  launcherPid?: number
  paneId?: string
  tabCleanup?: 'none' | 'closed' | 'missing' | 'current-tab' | 'retained'
}

export type ManagedServiceStatus = {
  status: 'running' | 'stopped' | 'partial'
  gatewayPid?: number
  runnerPid?: number
  launcherPid?: number
}

function fail(message: string): never {
  throw new Error(message)
}

function activeJobStopRefusal(running: number): string {
  return `実行中のタスクが${running}件あるため停止しませんでした。`
    + '完了後に zerochan stop を再実行してください。'
    + '緊急時は zerochan stop --force で中断できます。'
    + '履歴とCodexセッションは保持され、同じSlackスレッドから再開できますが、'
    + '完了済みの変更や外部操作は元に戻りません。'
}

function inspectManagedProcess(
  lockFile: string,
  label: string,
  pattern: RegExp,
): ManagedProcess {
  const inspection = inspectProcessLock(lockFile, pattern)
  if (inspection.status === 'missing' || inspection.status === 'stale') {
    return { label, lockFile, pattern, pid: null }
  }
  if (inspection.status !== 'active' || !inspection.pid
    || !processLockOwnerMatches(lockFile, inspection.pid, pattern)) {
    fail(`${label}のprocess generationを安全に確認できません`)
  }
  return { label, lockFile, pattern, pid: inspection.pid }
}

function activeCounts(stateDir: string): { queued: number; running: number } {
  const database = resolveZeroJobDatabasePath(stateDir)
  return existsSync(database)
    ? activeJobCountsFromDatabase(database)
    : { queued: 0, running: 0 }
}

function serviceProcesses(stateDir: string): {
  gateway: ManagedProcess
  runner: ManagedProcess
} {
  return {
    gateway: inspectManagedProcess(
      join(stateDir, 'plugin.lock'),
      'Slack gateway',
      /server\.ts(?:\s|$)/,
    ),
    runner: inspectManagedProcess(
      join(stateDir, 'job-runner.lock', 'pid'),
      'job runner',
      /job-runner\.ts\s+daemon(?:\s|$)/,
    ),
  }
}

export function inspectManagedServiceStatus(stateDirInput: string): ManagedServiceStatus {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const services = serviceProcesses(stateDir)
  const launcher = runnerLauncherProcess(stateDir)
  const receipt = runnerLaunchReceiptProcesses(stateDir)
  if (services.gateway.pid && services.runner.pid && launcher.pid) {
    return {
      status: 'running',
      gatewayPid: services.gateway.pid,
      runnerPid: services.runner.pid,
      launcherPid: launcher.pid,
    }
  }
  const runnerPid = services.runner.pid ?? receipt.runner?.pid
  const launcherPid = launcher.pid ?? receipt.launcher?.pid
  if (!services.gateway.pid && !runnerPid && !launcherPid && !receipt.present) {
    return { status: 'stopped' }
  }
  return {
    status: 'partial',
    gatewayPid: services.gateway.pid ?? undefined,
    runnerPid: runnerPid ?? undefined,
    ...(launcherPid ? { launcherPid } : {}),
  }
}

function readRunnerRuntime(stateDir: string): string | null {
  return readOptionalBoundedOwnerOnlyRegularFile(
    join(stateDir, 'job-runner.lock', 'runtime'),
    4 * 1024,
  )?.trim() ?? null
}

function requireExpectedAppId(value: string): string {
  if (!APP_ID_PATTERN.test(value)) fail('Slack App identityが不正です')
  return value
}

export function assertServiceMutationIdle(stateDirInput: string): void {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const inspection = inspectProcessLock(
    join(stateDir, 'update.lock', 'pid'),
    SERVICE_MUTATION_PATTERN,
  )
  if (inspection.status === 'active') {
    fail(`別のservice操作または更新が実行中です (PID ${inspection.pid})`)
  }
  if (inspection.status === 'unknown') {
    fail('service操作lockの所有者を安全に確認できません')
  }
}

function runnerLauncherProcess(stateDir: string): ManagedProcess {
  return inspectManagedProcess(
    join(stateDir, 'job-runner-starter.lock'),
    'job runner launcher',
    /runner-launcher\.ts(?:\s|$)/,
  )
}

function runnerLaunchReceiptProcesses(stateDir: string): {
  present: boolean
  launcher?: ProcessIdentity
  runner?: ProcessIdentity
} {
  const receipt = readRunnerLaunchReceipt(stateDir)
  if (!receipt) return { present: false }
  const launcher = observeProcessGeneration(receipt.launcher)
  if (launcher.status === 'unknown') {
    fail('runner launch receiptのlauncher generationを確認できません')
  }
  let runner: ProcessIdentity | undefined
  if (receipt.state === 'published') {
    const observation = observeProcessGeneration(receipt.runner)
    if (observation.status === 'unknown') {
      fail('runner launch receiptのrunner generationを確認できません')
    }
    if (observation.status === 'alive') runner = observation.identity
  }
  return {
    present: true,
    ...(launcher.status === 'alive' ? { launcher: launcher.identity } : {}),
    ...(runner ? { runner } : {}),
  }
}

async function stopSpawnedRunnerLauncher(
  child: ReturnType<typeof Bun.spawn> | undefined,
  identity: ProcessIdentity | undefined,
  stateDir: string,
  sleep: (milliseconds: number) => Promise<void>,
  gracefulTimeoutMs = 4_000,
  baselineRunner?: ProcessIdentity,
): Promise<void> {
  const launcherPid = identity?.pid ?? child?.pid
  if (!launcherPid) fail('再構築launcherのPIDを確認できません')
  const starterLock = join(stateDir, 'job-runner-starter.lock')
  const runnerLock = join(stateDir, 'job-runner.lock', 'pid')
  const launcherPattern = /runner-launcher\.ts(?:\s|$)/
  const runnerPattern = /job-runner\.ts\s+daemon(?:\s|$)/
  const descendants = new Map<number, ProcessIdentity>()
  const publishedRunnerPids = new Set<number>()
  const ownedReceipts = new Map<string, RunnerLaunchReceipt>()
  let receiptReadError: unknown

  const captureDescendants = (): void => {
    if (identity) {
      try {
        const table = readProcessTable()
        const ancestry = new Set<number>([identity.pid, ...descendants.keys()])
        let changed = true
        while (changed) {
          changed = false
          for (const candidate of table) {
            if (candidate.pid === process.pid || descendants.has(candidate.pid)
              || !ancestry.has(candidate.ppid)) continue
            descendants.set(candidate.pid, candidate)
            ancestry.add(candidate.pid)
            changed = true
          }
        }
      } catch {
        // The lock-bound runner probe below remains available on non-Darwin
        // hosts. This command is installed only on macOS, where libproc also
        // captures pre-lock startup descendants.
      }
    }
    try {
      const receipt = readRunnerLaunchReceipt(stateDir)
      receiptReadError = undefined
      if (receipt && identity && sameProcessGeneration(receipt.launcher, identity)) {
        ownedReceipts.set(receipt.intentId, receipt)
        if (receipt.state === 'published') {
          const observation = observeProcessGeneration(receipt.runner)
          if (observation.status === 'alive') {
            descendants.set(observation.identity.pid, observation.identity)
            publishedRunnerPids.add(observation.identity.pid)
          }
        }
      }
    } catch (error) {
      // Do not let receipt diagnostics prevent the TERM-first contract.  The
      // launcher and every independently observed generation are still reaped;
      // the unreadable receipt is reported only after that bounded cleanup.
      receiptReadError ??= error
    }
    const runner = inspectProcessLock(runnerLock, runnerPattern)
    if (runner.status !== 'active' || !runner.pid
      || !processLockOwnerMatches(runnerLock, runner.pid, runnerPattern)) return
    const runnerIdentity = readProcessIdentity(runner.pid)
    if (!runnerIdentity) return
    const isBaseline = Boolean(baselineRunner
      && sameProcessGeneration(baselineRunner, runnerIdentity))
    if ((!isBaseline && baselineRunner)
      || runnerIdentity.ppid === launcherPid
      || descendants.has(runnerIdentity.pid)) {
      descendants.set(runnerIdentity.pid, runnerIdentity)
      publishedRunnerPids.add(runnerIdentity.pid)
    }
  }

  // Give the launcher its normal shutdown path first. Its SIGTERM handler
  // forwards the signal to the detached runner generation and reaps it before
  // releasing the launcher lease. SIGKILL-first would orphan that child.
  captureDescendants()
  if (identity) {
    signalProcessIfLive(identity, 'SIGTERM')
  } else if (child) {
    try { child.kill('SIGTERM') } catch {}
  }

  const gracefulDeadline = Date.now() + Math.max(100, gracefulTimeoutMs)
  const pendingReceipt = [...ownedReceipts.values()].find(
    receipt => receipt.state === 'prepared',
  )
  if (pendingReceipt?.state === 'prepared') {
    try {
      const published = await waitForPublishedRunnerLaunchReceipt(stateDir, {
        intentId: pendingReceipt.intentId,
        launcher: pendingReceipt.launcher,
        timeoutMs: Math.min(2_000, Math.max(0, gracefulDeadline - Date.now())),
        pollMs: 10,
      })
      if (published) ownedReceipts.set(published.intentId, published)
    } catch (error) {
      receiptReadError ??= error
    }
  }
  while (Date.now() <= gracefulDeadline) {
    captureDescendants()
    const launcherAlive = identity
      ? observeProcessGeneration(identity).status === 'alive'
      : child?.exitCode === null
    const descendantAlive = [...descendants.values()].some(
      descendant => observeProcessGeneration(descendant).status === 'alive',
    )
    const publicationPending = [...ownedReceipts.values()].some(
      receipt => receipt.state === 'prepared',
    )
    if (!launcherAlive && !descendantAlive && !publicationPending) break
    await sleep(25)
  }

  const reapExactRunnerTree = async (
    expected: Pick<ProcessIdentity, 'pid' | 'bootSession' | 'startSec' | 'startUsec'>,
  ): Promise<void> => {
    const observation = observeProcessGeneration(expected)
    if (observation.status === 'dead') return
    if (observation.status === 'unknown') {
      fail(`runner launcher配下PID ${expected.pid} のgenerationを再確認できません`)
    }
    descendants.set(observation.identity.pid, observation.identity)
    publishedRunnerPids.add(observation.identity.pid)
    const remaining = await freezeAndKillTrackedProcessTree({
      root: observation.identity,
      excludePids: new Set([process.pid]),
    })
    if (remaining.length > 0) {
      fail(`runner launcher配下のprocessを回収できません: ${remaining.join(', ')}`)
    }
  }

  // A runner can ignore TERM or the launcher can fail before its async reaper
  // completes. Reclaim every exact descendant generation captured while the
  // launcher was still its parent, including detached grandchildren.
  for (const descendant of [...descendants.values()]) {
    await reapExactRunnerTree(descendant)
  }

  if (identity && observeProcessGeneration(identity).status === 'alive') {
    const groupSignalled = process.platform !== 'win32'
      && identity.pgid === identity.pid
      && signalProcessGroupIfLeaderLive(identity, 'SIGKILL')
    if (!groupSignalled) signalProcessIfLive(identity, 'SIGKILL')
  } else if (!identity && child?.exitCode === null) {
    try { child.kill('SIGKILL') } catch {}
  }
  const exited = child
    ? await Promise.race([
        child.exited.then(() => true).catch(() => true),
        Bun.sleep(2_000).then(() => false),
      ])
    : await (async () => {
        if (!identity) return false
        const deadline = Date.now() + 2_000
        while (Date.now() <= deadline) {
          if (observeProcessGeneration(identity).status === 'dead') return true
          await sleep(25)
        }
        return false
      })()
  if (!exited || (identity && observeProcessGeneration(identity).status !== 'dead')) {
    fail('再構築に失敗したrunner launcherを回収できません')
  }

  // A child can outlive its launcher before it publishes the daemon lock. The
  // receipt mutation lock makes this a closed race: either cancellation removes
  // the prepared intent first (so the bootstrap must fail before exec), or the
  // publisher wins and leaves an exact generation that we reap here.
  let finalReceipt: RunnerLaunchReceipt | null = null
  try {
    finalReceipt = readRunnerLaunchReceipt(stateDir)
    receiptReadError = undefined
    if (finalReceipt && identity
      && sameProcessGeneration(finalReceipt.launcher, identity)) {
      if (finalReceipt.state === 'prepared') {
        try {
          clearAbandonedRunnerLaunchIntent(stateDir, finalReceipt)
          finalReceipt = null
        } catch (error) {
          finalReceipt = readRunnerLaunchReceipt(stateDir)
          if (!finalReceipt || !sameProcessGeneration(finalReceipt.launcher, identity)) {
            throw error
          }
        }
      }
      if (finalReceipt?.state === 'published') {
        await reapExactRunnerTree(finalReceipt.runner)
        clearRunnerLaunchReceiptAfterReap(stateDir, finalReceipt, finalReceipt.runner)
        finalReceipt = null
      }
    }
  } catch (error) {
    receiptReadError ??= error
  }
  for (const descendant of descendants.values()) {
    if (observeProcessGeneration(descendant).status !== 'dead') {
      fail(`runner launcher配下PID ${descendant.pid} の停止を確認できません`)
    }
  }

  const clearDeadLease = (
    lockFile: string,
    pattern: RegExp,
    expectedPids: ReadonlySet<number>,
    requireMissing: boolean,
  ): void => {
    const current = inspectProcessLock(lockFile, pattern)
    if (current.status === 'stale' && current.pid) {
      if (!discardProcessLock(lockFile, current.pid)) {
        fail(`${lockFile} の停止済みleaseを回収できません`)
      }
    } else if (current.status === 'unknown') {
      fail(`${lockFile} の停止確認が不明です`)
    } else if (current.status === 'active'
      && (requireMissing || (current.pid !== undefined && expectedPids.has(current.pid)))) {
      fail(`${lockFile} のprocessが停止後も残っています`)
    }
    if (requireMissing && inspectProcessLock(lockFile, pattern).status !== 'missing') {
      fail(`${lockFile} のlease消失を確認できません`)
    }
  }
  clearDeadLease(starterLock, launcherPattern, new Set([launcherPid]), true)
  if (publishedRunnerPids.size > 0) {
    clearDeadLease(runnerLock, runnerPattern, publishedRunnerPids, true)
  }
  if (receiptReadError) {
    fail(
      'runner launch receiptの停止確認に失敗しました: '
      + (receiptReadError instanceof Error ? receiptReadError.message : String(receiptReadError)),
    )
  }
  const unresolvedReceipt = readRunnerLaunchReceipt(stateDir)
  if (unresolvedReceipt && identity
    && sameProcessGeneration(unresolvedReceipt.launcher, identity)) {
    fail('再構築launcherのrunner launch receiptが停止後も残っています')
  }
}

async function startRunnerLauncherForExistingService(input: {
  rootRepo: string
  stateDir: string
  runtime: HerdrRuntimeIdentity
  sleep: (milliseconds: number) => Promise<void>
  startupTimeoutMs?: number
  cleanupGraceMs?: number
  baselineRunner?: ProcessIdentity
}): Promise<StartedRunnerLauncher> {
  const runner = realpathSync(join(input.rootRepo, 'zerokun', 'job-runner.ts'))
  const launcher = realpathSync(join(input.rootRepo, 'zerokun', 'runner-launcher.ts'))
  const starterLock = join(input.stateDir, 'job-runner-starter.lock')
  const existing = runnerLauncherProcess(input.stateDir)
  if (existing.pid) {
    const existingIdentity = readProcessIdentity(existing.pid)
    if (!existingIdentity) fail('既存runner launcher generationを固定できません')
    return { pid: existing.pid, identity: existingIdentity }
  }

  const logDescriptor = openSafeLog(join(input.stateDir, 'job-runner.log'), 'append')
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([
      process.execPath,
      '--config=/dev/null',
      '--no-env-file',
      launcher,
      runner,
      input.stateDir,
      join(input.stateDir, 'job-runner.log'),
      starterLock,
    ], {
      stdin: 'ignore',
      stdout: logDescriptor,
      stderr: logDescriptor,
      detached: process.platform !== 'win32',
      env: environmentForPinnedHerdrRuntime(input.runtime),
    })
  } finally {
    closeSync(logDescriptor)
  }

  const identity = await acquireProcessGroupLeaderIdentity(child.pid)
  if (!identity) {
    const exactIdentity = readProcessIdentity(child.pid)
    await stopSpawnedRunnerLauncher(
      child,
      exactIdentity,
      input.stateDir,
      input.sleep,
      input.cleanupGraceMs,
      input.baselineRunner,
    )
    fail('runner launcher再構築generationを固定できません')
  }
  const deadline = Date.now() + (input.startupTimeoutMs ?? 10_000)
  try {
    while (Date.now() <= deadline) {
      const inspection = inspectProcessLock(starterLock, /runner-launcher\.ts(?:\s|$)/)
      if (inspection.status === 'active' && inspection.pid === child.pid
        && processLockOwnerMatches(
          starterLock,
          child.pid,
          /runner-launcher\.ts(?:\s|$)/,
        )) {
        child.unref()
        return { pid: child.pid, identity }
      }
      if (child.exitCode !== null) {
        fail(`runner launcher再構築processが終了しました (code ${child.exitCode})`)
      }
      await input.sleep(25)
    }
    fail('runner launcher再構築を10秒以内に確認できません')
  } catch (error) {
    await stopSpawnedRunnerLauncher(
      child,
      identity,
      input.stateDir,
      input.sleep,
      input.cleanupGraceMs,
      input.baselineRunner,
    )
    throw error
  }
}

async function stopRunnerLauncherIfPresent(stateDir: string): Promise<number | null> {
  const launcher = runnerLauncherProcess(stateDir)
  if (!launcher.pid) return null
  await stopLockedProcess(
    launcher.lockFile,
    launcher.pid,
    launcher.label,
    launcher.pattern,
    undefined,
    10_000,
  )
  return launcher.pid
}

async function forceStopLockedProcess(
  process: ManagedProcess,
  timeoutMs: number,
): Promise<number | null> {
  if (!process.pid) return null
  const result = await stopProcessLockOwner(
    process.lockFile,
    process.pid,
    process.pattern,
    { timeoutMs, forceKill: true, killWaitMs: 2_000 },
  )
  if (result === 'stopped') return process.pid
  if (result === 'timeout') fail(`${process.label} PID ${process.pid} を強制停止できません`)
  fail(`${process.label} PID ${process.pid} の停止generationを再確認できません`)
}

async function forceKillCurrentRunner(
  stateDir: string,
  sleep: (milliseconds: number) => Promise<void>,
  onFrozen: () => Promise<void> | void,
): Promise<number | null> {
  const runner = serviceProcesses(stateDir).runner
  if (!runner.pid) return null
  if (!processLockOwnerMatches(runner.lockFile, runner.pid, runner.pattern)) {
    fail('job runnerの強制停止generationを固定できません')
  }
  const identity = readProcessIdentity(runner.pid)
  if (!identity || !processLockOwnerMatches(runner.lockFile, runner.pid, runner.pattern)) {
    fail('job runnerの強制停止generation identityを確認できません')
  }
  const remaining = await freezeAndKillTrackedProcessTree({
    root: identity,
    excludePids: new Set([process.pid]),
    onFrozen: async () => {
      if (!processLockOwnerMatches(runner.lockFile, runner.pid!, runner.pattern)) {
        fail('job runnerの強制停止generationを再確認できません')
      }
      await onFrozen()
    },
  })
  if (remaining.length > 0) {
    fail(`job runner配下のprocessを強制停止できません: ${remaining.join(', ')}`)
  }
  // Keep the injected sleep contract used by service-control fixtures while
  // the production helper itself performs generation-aware waits.
  await sleep(0)
  return runner.pid
}

function discardStoppedReceiptLease(
  lockFile: string,
  pattern: RegExp,
  expectedPid: number,
): void {
  const inspection = inspectProcessLock(lockFile, pattern)
  if (inspection.status === 'stale' && inspection.pid === expectedPid) {
    if (!discardProcessLock(lockFile, expectedPid)) {
      fail(`${lockFile} の停止済みreceipt leaseを回収できません`)
    }
    return
  }
  if ((inspection.status === 'active' || inspection.status === 'unknown')
    && inspection.pid === expectedPid) {
    fail(`${lockFile} のreceipt process停止を確認できません`)
  }
}

async function stopRunnerLaunchReceipt(
  stateDir: string,
  onFrozen: () => Promise<void> | void,
): Promise<boolean> {
  let stoppedAny = false
  for (let pass = 0; pass < 5; pass += 1) {
    const receipt = readRunnerLaunchReceipt(stateDir)
    if (!receipt) return stoppedAny

    const stopExactLauncher = async (
      expected: Pick<ProcessIdentity, 'pid' | 'bootSession' | 'startSec' | 'startUsec'>,
    ): Promise<void> => {
      const observation = observeProcessGeneration(expected)
      if (observation.status === 'dead') return
      if (observation.status === 'unknown') {
        fail('runner launcherのreceipt generationを確認できません')
      }
      if (!signalProcessIfLive(observation.identity, 'SIGSTOP')) {
        if (observeProcessGeneration(expected).status === 'dead') return
        fail('runner launcherのreceipt processを停止境界へ固定できません')
      }
      const stopDeadline = Date.now() + 2_000
      let stoppedIdentity: ProcessIdentity | undefined
      while (Date.now() <= stopDeadline) {
        const current = observeProcessGeneration(expected)
        if (current.status === 'dead') return
        if (current.status === 'unknown') {
          fail('runner launcherのreceipt generationを一時停止後に確認できません')
        }
        if (processIdentityIsStopped(current.identity)) {
          stoppedIdentity = current.identity
          break
        }
        await Bun.sleep(10)
      }
      if (!stoppedIdentity || !signalProcessIfLive(stoppedIdentity, 'SIGKILL')) {
        if (stoppedIdentity) signalProcessIfLive(stoppedIdentity, 'SIGCONT')
        fail('runner launcherのreceipt processを強制停止できません')
      }
      const killDeadline = Date.now() + 2_000
      while (Date.now() <= killDeadline) {
        if (observeProcessGeneration(expected).status === 'dead') {
          stoppedAny = true
          return
        }
        await Bun.sleep(10)
      }
      fail('runner launcherのreceipt process終了を確認できません')
    }

    const stopExactRunner = async (
      expected: Pick<ProcessIdentity, 'pid' | 'bootSession' | 'startSec' | 'startUsec'>,
    ): Promise<void> => {
      const observation = observeProcessGeneration(expected)
      if (observation.status === 'dead') return
      if (observation.status === 'unknown') {
        fail('job runnerのreceipt generationを確認できません')
      }
      const remaining = await freezeAndKillTrackedProcessTree({
        root: observation.identity,
        excludePids: new Set([process.pid]),
        onFrozen,
      })
      if (remaining.length > 0) {
        fail(`job runnerのreceipt processを回収できません: ${remaining.join(', ')}`)
      }
      stoppedAny = true
    }

    // Freeze and terminate only the launcher generation first. Killing its
    // whole tree here would cross the job-state boundary before the receipt
    // runner is frozen and `onFrozen` records the authoritative DB snapshot.
    await stopExactLauncher(receipt.launcher)
    let current = readRunnerLaunchReceipt(stateDir)
    if (!current) return true
    if (current.intentId !== receipt.intentId
      || !sameProcessGeneration(current.launcher, receipt.launcher)) {
      continue
    }
    if (current.state === 'prepared') {
      clearAbandonedRunnerLaunchIntent(stateDir, current)
    } else {
      await stopExactRunner(current.runner)
      const runner = observeProcessGeneration(current.runner)
      if (runner.status === 'unknown') {
        fail('job runnerのreceipt generationを停止後に確認できません')
      }
      if (runner.status === 'alive') continue
      clearRunnerLaunchReceiptAfterReap(stateDir, current, current.runner)
      discardStoppedReceiptLease(
        join(stateDir, 'job-runner.lock', 'pid'),
        /job-runner\.ts\s+daemon(?:\s|$)/,
        current.runner.pid,
      )
    }
    discardStoppedReceiptLease(
      join(stateDir, 'job-runner-starter.lock'),
      /runner-launcher\.ts(?:\s|$)/,
      current.launcher.pid,
    )
    if (!readRunnerLaunchReceipt(stateDir)) return true
  }
  fail('runner launch receiptの停止を確認できません')
}

async function forceStopRunnerAndLauncher(
  stateDir: string,
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMs: number,
  onStoppedBoundary: () => Promise<void> | void,
): Promise<boolean> {
  let stoppedAny = false
  let boundaryCaptured = false
  const captureBoundary = async (): Promise<void> => {
    if (boundaryCaptured) return
    await onStoppedBoundary()
    boundaryCaptured = true
  }
  for (let pass = 0; pass < 3; pass += 1) {
    stoppedAny = await stopRunnerLaunchReceipt(
      stateDir,
      // The durable receipt can name a launcher while a different lock-bound
      // runner generation is still alive. Do not publish the force-stop DB
      // boundary from the receipt subtree alone; capture it only after the
      // ordinary runner below is frozen or every source is proven absent.
      async () => {},
    ) || stoppedAny
    const runnerPid = await forceKillCurrentRunner(stateDir, sleep, captureBoundary)
    stoppedAny = Boolean(runnerPid) || stoppedAny
    const launcher = runnerLauncherProcess(stateDir)
    if (launcher.pid) {
      await forceStopLockedProcess(launcher, timeoutMs)
      stoppedAny = true
    }
    await sleep(25)
    const receiptProcesses = runnerLaunchReceiptProcesses(stateDir)
    if (!serviceProcesses(stateDir).runner.pid && !runnerLauncherProcess(stateDir).pid
      && !receiptProcesses.present) {
      await captureBoundary()
      return stoppedAny
    }
  }
  fail('job runnerまたはlauncherの強制停止を確認できません')
}

async function quiesceRunnerAndLauncher(
  stateDir: string,
  sleep: (milliseconds: number) => Promise<void>,
  pauseTimeoutMs = 15_000,
): Promise<boolean> {
  let stoppedAny = false
  let runner = serviceProcesses(stateDir).runner

  // A launcher may be between acquiring its lease and publishing the daemon
  // lock. Let a supported child publish under the already-held update barrier
  // so it can acknowledge the between-job pause instead of killing an
  // unobserved child through its parent.
  if (!runner.pid && runnerLauncherProcess(stateDir).pid) {
    const deadline = Date.now() + Math.max(100, pauseTimeoutMs)
    while (Date.now() <= deadline) {
      runner = serviceProcesses(stateDir).runner
      if (runner.pid || !runnerLauncherProcess(stateDir).pid) break
      await sleep(50)
    }
  }

  if (runner.pid) {
    stoppedAny = Boolean(await pauseAndStopCurrentRunner(
      stateDir,
      sleep,
      pauseTimeoutMs,
    )) || stoppedAny
  }
  stoppedAny = Boolean(await stopRunnerLauncherIfPresent(stateDir)) || stoppedAny

  stoppedAny = await stopRunnerLaunchReceipt(stateDir, () => {
    const counts = activeCounts(stateDir)
    if (counts.running > 0) fail(activeJobStopRefusal(counts.running))
  }) || stoppedAny

  // Close the publication race between the last runner snapshot and launcher
  // teardown. A late child is still behind the update barrier and must ack the
  // same between-job pause before it is signalled.
  if (serviceProcesses(stateDir).runner.pid) {
    stoppedAny = Boolean(await pauseAndStopCurrentRunner(
      stateDir,
      sleep,
      pauseTimeoutMs,
    )) || stoppedAny
  }
  if (runnerLauncherProcess(stateDir).pid) {
    fail('job runner launcherの停止を確認できません')
  }
  const receiptProcesses = runnerLaunchReceiptProcesses(stateDir)
  if (receiptProcesses.present) {
    fail('runner launch receiptのprocess停止を確認できません')
  }
  return stoppedAny
}

async function pauseAndStopCurrentRunner(
  stateDir: string,
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMs = 15_000,
): Promise<number | null> {
  let runner = serviceProcesses(stateDir).runner
  if (!runner.pid) return null
  const request = createServiceControlPauseRequest(stateDir, runner.pid)
  try {
    const deadline = Date.now() + Math.max(100, timeoutMs)
    while (Date.now() <= deadline) {
      const current = inspectManagedProcess(
        runner.lockFile,
        runner.label,
        runner.pattern,
      )
      if (!current.pid) return runner.pid
      if (current.pid !== runner.pid) {
        fail('job runner generationが停止確認中に変わりました')
      }
      if (serviceControlPauseAcknowledged(stateDir, request)) break
      await sleep(50)
    }
    runner = inspectManagedProcess(runner.lockFile, runner.label, runner.pattern)
    if (runner.pid && !serviceControlPauseAcknowledged(stateDir, request)) {
      // A runner that was already alive when this release was installed does
      // not have the service-control acknowledgement hook. Freeze that exact
      // process generation first, then inspect SQLite while it cannot claim a
      // job. SIGTERM is queued while stopped and SIGCONT only releases it to
      // handle that pending termination, so there is no claim window between
      // the final zero-running observation and shutdown.
      return await stopRunnerAtFrozenBoundary(stateDir, runner, sleep)
    }
    const counts = activeCounts(stateDir)
    if (counts.running > 0) {
      fail(activeJobStopRefusal(counts.running))
    }
    if (runner.pid) {
      await stopLockedProcess(
        runner.lockFile,
        runner.pid,
        runner.label,
        runner.pattern,
      )
    }
    return runner.pid
  } finally {
    clearServiceControlPauseRequest(stateDir, request)
  }
}

async function waitForProcessState(
  identity: ProcessIdentity,
  expected: 'stopped' | 'dead',
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const observed = observeProcessGeneration(identity)
    if (expected === 'dead' && observed.status === 'dead') return true
    if (expected === 'stopped' && observed.status === 'alive'
      && processIdentityIsStopped(observed.identity)) return true
    if (observed.status === 'unknown'
      || (expected === 'stopped' && observed.status === 'dead')) return false
    await sleep(25)
  }
  return false
}

async function stopRunnerAtFrozenBoundary(
  stateDir: string,
  runner: ManagedProcess,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<number> {
  if (!runner.pid || !processLockOwnerMatches(runner.lockFile, runner.pid, runner.pattern)) {
    fail('job runnerの停止generationを固定できません')
  }
  const identity = readProcessIdentity(runner.pid)
  if (!identity || !processLockOwnerMatches(runner.lockFile, runner.pid, runner.pattern)) {
    fail('job runnerの停止generation identityを確認できません')
  }

  let suspended = false
  let terminationQueued = false
  try {
    if (!signalProcessIfLive(identity, 'SIGSTOP')) {
      fail('job runnerを安全な停止境界で一時停止できません')
    }
    suspended = true
    if (!await waitForProcessState(identity, 'stopped', sleep, 2_000)
      || !processLockOwnerMatches(runner.lockFile, runner.pid, runner.pattern)) {
      fail('job runnerの一時停止generationを再確認できません')
    }
    const counts = activeCounts(stateDir)
    if (counts.running > 0) {
      fail(activeJobStopRefusal(counts.running))
    }

    // Queue termination before releasing SIGSTOP. The runner therefore never
    // returns to its claim loop after the authoritative SQLite observation.
    if (!signalProcessIfLive(identity, 'SIGTERM')) {
      fail('一時停止したjob runnerへ終了signalを送れません')
    }
    terminationQueued = true
    if (!signalProcessIfLive(identity, 'SIGCONT')) {
      fail('一時停止したjob runnerを終了処理へ移せません')
    }
    suspended = false
    if (!await waitForProcessState(identity, 'dead', sleep, 5_000)) {
      if (!signalProcessIfLive(identity, 'SIGKILL')
        || !await waitForProcessState(identity, 'dead', sleep, 2_000)) {
        fail('一時停止したjob runnerの終了を確認できません')
      }
    }
    return runner.pid
  } finally {
    // Before SIGTERM is queued, every failure must restore the exact runner so
    // a refused stop cannot leave the service silently frozen. Once queued,
    // resuming is part of completing the requested stop rather than rollback.
    if (suspended && !terminationQueued) signalProcessIfLive(identity, 'SIGCONT')
  }
}

async function cleanupRecordedTab(
  stateDir: string,
  controlRuntime: HerdrRuntimeIdentity,
  projectDir: string | undefined,
  close: typeof closeRecordedHerdrServiceTab,
): Promise<ServiceControlResult['tabCleanup']> {
  try {
    return await close({
      stateDir,
      controlRuntime,
      projectDir,
      idleTimeoutMs: 10_000,
    })
  } catch (error) {
    process.stderr.write(
      `⚠️  runtime tabは安全な所有確認ができないため残しました: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 'retained'
  }
}

function requireNoInterruptedUpdate(stateDir: string): void {
  if (existsSync(join(stateDir, 'update-transaction.json'))) {
    fail('未完了の自己更新があります。先に zerochan update --recover-only を実行してください')
  }
}

export async function stopManagedService(
  rootRepoInput: string,
  stateDirInput: string,
  hooks: ServiceControlHooks = {},
  options: StopManagedServiceOptions = {},
): Promise<ServiceControlResult> {
  // Resolve the repository even though stop is global. This prevents a copied
  // helper from signalling services owned by a different installation.
  realpathSync(rootRepoInput)
  const stateDir = requireManagedStateRoot(stateDirInput)
  const controlRuntime = hooks.controlRuntime ?? requireHerdrRuntime()
  await (hooks.verifyControlRuntime ?? verifyHerdrRuntimeIdentityAsync)(controlRuntime)
  const close = hooks.closeRecordedTab ?? closeRecordedHerdrServiceTab
  const sleep = hooks.sleep ?? (milliseconds => Bun.sleep(milliseconds))
  const operation = acquireUpdateLock(stateDir)
  try {
    requireNoInterruptedUpdate(stateDir)
    const initial = serviceProcesses(stateDir)
    const initialReceipt = runnerLaunchReceiptProcesses(stateDir)
    let stoppedAny = Boolean(
      initial.gateway.pid || initial.runner.pid
      || initialReceipt.present,
    )
    const runningReadiness = readGatewayReadiness(join(stateDir, 'gateway-ready.json'))
    const before = activeCounts(stateDir)
    if (options.force) {
      const forceTimeoutMs = hooks.forceStopTimeoutMs ?? 5_000
      if (initial.gateway.pid) {
        await forceStopLockedProcess(initial.gateway, forceTimeoutMs)
        stoppedAny = true
      }
      let forceBaseline: { queued: number; running: number } | null = null
      stoppedAny = await forceStopRunnerAndLauncher(
        stateDir,
        sleep,
        forceTimeoutMs,
        () => {
          // The gateway is dead and every exact runner descendant is frozen.
          // No enqueue or claim can cross this authoritative SQLite snapshot.
          forceBaseline = activeCounts(stateDir)
          writeIntentionalServiceStop(stateDir)
          writePinnedHerdrRuntime(stateDir, controlRuntime)
        },
      ) || stoppedAny
      const capturedForceBaseline = forceBaseline as {
        queued: number
        running: number
      } | null
      if (!capturedForceBaseline) fail('強制停止時のjob境界を取得できません')
      const stopped = serviceProcesses(stateDir)
      const stoppedReceipt = runnerLaunchReceiptProcesses(stateDir)
      if (stopped.gateway.pid || stopped.runner.pid || runnerLauncherProcess(stateDir).pid
        || stoppedReceipt.present) {
        fail('gateway、job runner、またはlauncherの強制停止を確認できません')
      }

      // The intentional-stop marker was published at the frozen boundary. If
      // recovery reports an exact ownership problem, watchdog must not undo
      // the user's requested stop while the durable job state is inspected.
      const recover = hooks.recoverForcedJobs ?? (async input => {
        const module = await import('./job-runner.ts')
        return module.recoverForcedServiceStop(input)
      })
      let recovered: Awaited<ReturnType<typeof recover>>
      try {
        recovered = await recover({ stateDir, runtime: controlRuntime })
      } catch (error) {
        fail(
          'service本体は停止しましたが、実行中タスクの回収を完了できませんでした。'
          + ` zerochan stop --force を再実行できます: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      const after = activeCounts(stateDir)
      if (after.running > 0) fail('強制停止後も実行中タスクが残っています')
      if (after.queued !== capturedForceBaseline.queued
        || recovered.queued !== capturedForceBaseline.queued) {
        fail('強制停止中に待機中タスクの件数が変わりました')
      }
      const tabCleanup = await cleanupRecordedTab(
        stateDir,
        controlRuntime,
        runningReadiness?.projectDir,
        close,
      )
      return {
        status: stoppedAny || capturedForceBaseline.running > 0 || recovered.completed > 0
          || recovered.failed > 0 ? 'stopped' : 'already-stopped',
        tabCleanup,
      }
    }
    if (before.running > 0) {
      fail(activeJobStopRefusal(before.running))
    }

    // First pause the runner at its between-job claim barrier, then retire its
    // launcher. Stopping the launcher first would signal the child and could
    // interrupt a claim that raced the initial SQLite snapshot.
    stoppedAny = await quiesceRunnerAndLauncher(
      stateDir,
      sleep,
      hooks.pauseTimeoutMs,
    ) || stoppedAny
    const afterRunner = activeCounts(stateDir)
    if (afterRunner.running > 0) {
      fail(`実行中のタスクが${afterRunner.running}件残っているため、gatewayは停止していません`)
    }
    if (serviceProcesses(stateDir).runner.pid) {
      fail('job runnerが停止境界で再起動したため、gatewayは停止していません')
    }

    // Stop intake only after the runner is fully quiescent. If runner teardown
    // fails, the gateway remains available and no partial gateway-down/runner-
    // live state is exposed when the operation lock is released.
    const { gateway } = serviceProcesses(stateDir)
    if (gateway.pid) {
      await stopLockedProcess(
        gateway.lockFile,
        gateway.pid,
        gateway.label,
        gateway.pattern,
      )
    }

    // A supported launcher refuses the active update lock. Recheck once after
    // gateway shutdown as a bounded guard for a starter already past that gate.
    stoppedAny = await quiesceRunnerAndLauncher(
      stateDir,
      sleep,
      hooks.pauseTimeoutMs,
    ) || stoppedAny

    const stopped = serviceProcesses(stateDir)
    const stoppedReceipt = runnerLaunchReceiptProcesses(stateDir)
    if (stopped.gateway.pid || stopped.runner.pid
      || stoppedReceipt.present) {
      fail('gatewayまたはjob runnerの停止を確認できません')
    }
    if (activeCounts(stateDir).running > 0) {
      fail('service停止後も実行中タスクが残っています')
    }
    writeIntentionalServiceStop(stateDir)
    // The service runtime tab is about to disappear. Pin the verified caller
    // pane so a later zerokun-update still has a live Herdr restart target.
    writePinnedHerdrRuntime(stateDir, controlRuntime)
    const tabCleanup = await cleanupRecordedTab(
      stateDir,
      controlRuntime,
      runningReadiness?.projectDir,
      close,
    )
    return {
      status: stoppedAny || gateway.pid ? 'stopped' : 'already-stopped',
      tabCleanup,
    }
  } finally {
    operation.release()
  }
}

function releaseForRoot(rootRepo: string): string {
  const releaseResult = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: rootRepo,
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  if (releaseResult.exitCode !== 0) fail('起動releaseを確認できません')
  const release = releaseResult.stdout.toString().trim()
  if (!/^[0-9a-f]{40}$/.test(release)) fail('起動releaseが不正です')
  return release
}

function sameRuntime(left: HerdrRuntimeIdentity, right: HerdrRuntimeIdentity): boolean {
  return herdrRuntimeFingerprint(left) === herdrRuntimeFingerprint(right)
}

function publishedAttemptRuntimeMatches(
  stateDir: string,
  attemptedRuntime: HerdrRuntimeIdentity,
): boolean {
  try {
    return sameRuntime(readPinnedHerdrRuntime(stateDir), attemptedRuntime)
  } catch {
    return false
  }
}

function runnerBelongsToAttempt(
  stateDir: string,
  attemptedRuntime: HerdrRuntimeIdentity,
  expectedAppId: string,
): boolean {
  const runtime = readRunnerRuntime(stateDir)
  return Boolean(runtime
    && runtime.startsWith(`zerokun-codex-runner-v1:${expectedAppId}:`)
    && runtime.endsWith(`:${herdrRuntimeFingerprint(attemptedRuntime)}`))
}

function gatewayBelongsToAttempt(
  rootRepo: string,
  stateDir: string,
  projectDir: string,
  expectedAppId: string,
  gatewayPid: number,
): boolean {
  const readiness = readGatewayReadiness(join(stateDir, 'gateway-ready.json'))
  if (!readiness || readiness.pid !== gatewayPid
    || readiness.slackAppId !== expectedAppId
    || readiness.release !== releaseForRoot(rootRepo)) return false
  try {
    return realpathSync(readiness.projectDir) === projectDir
  } catch {
    return false
  }
}

async function stableServiceHealth(
  rootRepo: string,
  stateDir: string,
  projectDir: string,
  expectedAppId: string,
): Promise<{ gatewayPid: number; runnerPid: number; launcherPid: number }> {
  const release = releaseForRoot(rootRepo)
  let observedGateway = 0
  let observedRunner = 0
  let observedLauncher = 0
  await waitForStableHealth({
    requiredConsecutive: 5,
    maxChecks: 60,
    sleep: () => Bun.sleep(250),
    observe: () => {
      const services = serviceProcesses(stateDir)
      const launcher = runnerLauncherProcess(stateDir)
      const readiness = readGatewayReadiness(join(stateDir, 'gateway-ready.json'))
      observedGateway = services.gateway.pid ?? 0
      observedRunner = services.runner.pid ?? 0
      observedLauncher = launcher.pid ?? 0
      return Boolean(observedGateway && observedRunner && observedLauncher
        && readiness?.pid === observedGateway
        && readiness.slackAppId === expectedAppId
        && readiness.release === release
        && realpathSync(readiness.projectDir) === projectDir)
    },
  })
  return {
    gatewayPid: observedGateway,
    runnerPid: observedRunner,
    launcherPid: observedLauncher,
  }
}

async function stableRepairedSupervisorHealth(
  stateDir: string,
  projectDir: string,
  expectedAppId: string,
  expected: {
    gatewayPid: number
    launcherPid: number
    runtime: HerdrRuntimeIdentity
  },
  sleep: (milliseconds: number) => Promise<void>,
): Promise<{ gatewayPid: number; runnerPid: number; launcherPid: number }> {
  let previousRunnerPid = 0
  let observedRunnerPid = 0
  await waitForStableHealth({
    requiredConsecutive: 5,
    maxChecks: 60,
    sleep: () => sleep(250),
    observe: () => {
      const services = serviceProcesses(stateDir)
      const launcher = runnerLauncherProcess(stateDir)
      const readiness = readGatewayReadiness(join(stateDir, 'gateway-ready.json'))
      let sameProject = false
      let samePinnedRuntime = false
      try {
        sameProject = Boolean(readiness && realpathSync(readiness.projectDir) === projectDir)
        samePinnedRuntime = sameRuntime(readPinnedHerdrRuntime(stateDir), expected.runtime)
      } catch {}
      const runnerPid = services.runner.pid ?? 0
      const sameRunnerGeneration = runnerPid > 0 && runnerPid === previousRunnerPid
      previousRunnerPid = runnerPid
      observedRunnerPid = runnerPid
      return services.gateway.pid === expected.gatewayPid
        && launcher.pid === expected.launcherPid
        && readiness?.pid === expected.gatewayPid
        && readiness.slackAppId === expectedAppId
        && sameProject
        && samePinnedRuntime
        && runnerBelongsToAttempt(stateDir, expected.runtime, expectedAppId)
        && sameRunnerGeneration
    },
  })
  return {
    gatewayPid: expected.gatewayPid,
    runnerPid: observedRunnerPid,
    launcherPid: expected.launcherPid,
  }
}

async function requireRunningServiceCompatible(
  stateDir: string,
  controlRuntime: HerdrRuntimeIdentity,
  expectedAppId: string,
  gatewayPid: number,
  verifyRuntime: (runtime: HerdrRuntimeIdentity) => Promise<void>,
): Promise<string> {
  const readiness = readGatewayReadiness(join(stateDir, 'gateway-ready.json'))
  if (!readiness || readiness.pid !== gatewayPid || readiness.slackAppId !== expectedAppId) {
    fail('稼働中serviceのSlack App identityまたはreadinessが一致しません。zerochan stop を実行してください')
  }
  let runningProjectDir: string
  try {
    runningProjectDir = realpathSync(readiness.projectDir)
  } catch {
    fail('稼働中serviceのproject identityを確認できません')
  }
  const pinned = readPinnedHerdrRuntime(stateDir)
  await verifyRuntime(pinned)
  if (herdrControlPlaneFingerprint(pinned) !== herdrControlPlaneFingerprint(controlRuntime)) {
    fail('稼働中serviceと現在のHerdr control planeが一致しません')
  }
  const runnerRuntime = readRunnerRuntime(stateDir)
  const prefix = `zerokun-codex-runner-v1:${expectedAppId}:`
  const suffix = `:${herdrRuntimeFingerprint(pinned)}`
  if (!runnerRuntime?.startsWith(prefix) || !runnerRuntime.endsWith(suffix)) {
    fail('稼働中job runnerのSlack AppまたはHerdr runtimeが一致しません')
  }
  return runningProjectDir
}

export async function startManagedService(
  rootRepoInput: string,
  stateDirInput: string,
  projectDirInput: string,
  expectedAppIdInput: string,
  hooks: ServiceControlHooks = {},
): Promise<ServiceControlResult> {
  const rootRepo = realpathSync(rootRepoInput)
  const stateDir = requireManagedStateRoot(stateDirInput)
  const projectDir = realpathSync(projectDirInput)
  const expectedAppId = requireExpectedAppId(expectedAppIdInput)
  const controlRuntime = hooks.controlRuntime ?? requireHerdrRuntime()
  await (hooks.verifyControlRuntime ?? verifyHerdrRuntimeIdentityAsync)(controlRuntime)
  const close = hooks.closeRecordedTab ?? closeRecordedHerdrServiceTab
  const startBot = hooks.startBot ?? startBotInHerdr
  const operation = acquireUpdateLock(stateDir)
  let launchAttempted = false
  let attemptedRuntime: HerdrRuntimeIdentity | undefined
  try {
    requireNoInterruptedUpdate(stateDir)
    const services = serviceProcesses(stateDir)
    const launcher = runnerLauncherProcess(stateDir)
    const launchReceipt = runnerLaunchReceiptProcesses(stateDir)
    if (services.gateway.pid && services.runner.pid) {
      const baselineRunner = readProcessIdentity(services.runner.pid)
      if (!baselineRunner
        || !processLockOwnerMatches(
          services.runner.lockFile,
          services.runner.pid,
          services.runner.pattern,
        )) {
        fail('launcher修復前のjob runner generationを固定できません')
      }
      const runningProjectDir = await requireRunningServiceCompatible(
        stateDir,
        controlRuntime,
        expectedAppId,
        services.gateway.pid,
        hooks.verifyControlRuntime
          ?? (runtime => verifyHerdrRuntimeIdentityAsync(
            runtime,
            environmentForPinnedHerdrRuntime(runtime),
          )),
      )
      if (launcher.pid) {
        clearIntentionalServiceStop(stateDir)
        return {
          status: 'already-running',
          gatewayPid: services.gateway.pid,
          runnerPid: services.runner.pid,
          launcherPid: launcher.pid,
        }
      }
      const pinnedRuntime = readPinnedHerdrRuntime(stateDir)
      const startedLauncher = await (
        hooks.startRunnerLauncher ?? startRunnerLauncherForExistingService
      )({
        rootRepo,
        stateDir,
        runtime: pinnedRuntime,
        sleep: hooks.sleep ?? (milliseconds => Bun.sleep(milliseconds)),
        startupTimeoutMs: hooks.runnerLauncherStartTimeoutMs,
        cleanupGraceMs: hooks.runnerLauncherCleanupGraceMs,
        baselineRunner,
      })
      const launcherPid = startedLauncher.pid
      const repairLauncherIdentity = startedLauncher.identity
      if (!repairLauncherIdentity
        || !processLockOwnerMatches(
          join(stateDir, 'job-runner-starter.lock'),
          launcherPid,
          /runner-launcher\.ts(?:\s|$)/,
        )) {
        if (repairLauncherIdentity) {
          await stopSpawnedRunnerLauncher(
            undefined,
            repairLauncherIdentity,
            stateDir,
            hooks.sleep ?? (milliseconds => Bun.sleep(milliseconds)),
            hooks.runnerLauncherCleanupGraceMs,
            baselineRunner,
          )
        }
        fail('再構築したrunner launcher generationを固定できません')
      }
      let repaired: { gatewayPid: number; runnerPid: number; launcherPid: number }
      try {
        repaired = await stableRepairedSupervisorHealth(
          stateDir,
          runningProjectDir,
          expectedAppId,
          {
            gatewayPid: services.gateway.pid,
            launcherPid,
            runtime: pinnedRuntime,
          },
          hooks.sleep ?? (milliseconds => Bun.sleep(milliseconds)),
        )
      } catch (error) {
        try {
          await stopSpawnedRunnerLauncher(
            undefined,
            repairLauncherIdentity,
            stateDir,
            hooks.sleep ?? (milliseconds => Bun.sleep(milliseconds)),
            hooks.runnerLauncherCleanupGraceMs,
            baselineRunner,
          )
        } catch (cleanupError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}`
            + `\n修復launcherの回収にも失敗しました: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          )
        }
        throw error
      }
      clearIntentionalServiceStop(stateDir)
      return {
        status: 'already-running',
        gatewayPid: repaired.gatewayPid,
        runnerPid: repaired.runnerPid,
        launcherPid: repaired.launcherPid,
      }
    }
    if (services.gateway.pid || services.runner.pid || launcher.pid || launchReceipt.present) {
      fail('serviceが部分起動状態です。zerochan stop --force の後に zerochan start を実行してください')
    }

    const tabCleanup = await cleanupRecordedTab(stateDir, controlRuntime, projectDir, close)
    if (tabCleanup === 'retained') {
      fail('既存runtime tabを安全に回収できないため、新しいtabは作成していません')
    }
    launchAttempted = true
    const started = await startBot({
      rootRepo,
      stateDir,
      projectDir,
      startupTimeoutMs: 60_000,
      replaceTokenFile: join(stateDir, 'replace-token'),
      controlRuntime,
      reuseRecordedTab: false,
      onRuntimeSelected: runtime => { attemptedRuntime = runtime },
    })
    const health = await stableServiceHealth(
      rootRepo,
      stateDir,
      projectDir,
      expectedAppId,
    )
    if (started.gatewayPid !== health.gatewayPid) {
      fail('起動確認中にgateway generationが変わりました')
    }
    clearIntentionalServiceStop(stateDir)
    return {
      status: 'started',
      gatewayPid: health.gatewayPid,
      runnerPid: health.runnerPid,
      launcherPid: health.launcherPid,
      paneId: started.paneId,
    }
  } catch (error) {
    if (!launchAttempted) throw error
    let cleanup = ''
    try {
      const services = serviceProcesses(stateDir)
      const published = attemptedRuntime
        ? publishedAttemptRuntimeMatches(stateDir, attemptedRuntime)
        : false
      if (services.runner.pid && (!attemptedRuntime || !published
        || !runnerBelongsToAttempt(stateDir, attemptedRuntime, expectedAppId))) {
        fail('起動失敗後のjob runnerが今回の起動generationだと確認できないため停止していません')
      }
      if (services.gateway.pid && (!attemptedRuntime || !published
        || !gatewayBelongsToAttempt(
          rootRepo,
          stateDir,
          projectDir,
          expectedAppId,
          services.gateway.pid,
        ))) {
        fail('起動失敗後のgatewayが今回の起動generationだと確認できないため停止していません')
      }
      if (services.runner.pid || services.gateway.pid || runnerLauncherProcess(stateDir).pid) {
        await quiesceRunnerAndLauncher(
          stateDir,
          hooks.sleep ?? (milliseconds => Bun.sleep(milliseconds)),
          hooks.pauseTimeoutMs,
        )
        const afterRunner = serviceProcesses(stateDir)
        if (afterRunner.gateway.pid) {
          await stopLockedProcess(
            afterRunner.gateway.lockFile,
            afterRunner.gateway.pid,
            afterRunner.gateway.label,
            afterRunner.gateway.pattern,
          )
        }
      }
      await quiesceRunnerAndLauncher(
        stateDir,
        hooks.sleep ?? (milliseconds => Bun.sleep(milliseconds)),
        hooks.pauseTimeoutMs,
      )
      const remaining = serviceProcesses(stateDir)
      if (remaining.gateway.pid || remaining.runner.pid
        || runnerLauncherProcess(stateDir).pid
        || activeCounts(stateDir).running > 0) {
        fail('起動失敗generationの完全停止を確認できません')
      }
      writeIntentionalServiceStop(stateDir)
      if (attemptedRuntime) {
        const tabCleanup = await cleanupRecordedTab(
          stateDir,
          controlRuntime,
          projectDir,
          close,
        )
        if (tabCleanup === 'retained') {
          cleanup = '\n起動失敗generationのruntime tabは安全確認のため残しました'
        }
      }
    } catch (cleanupError) {
      cleanup = `\n起動失敗後の停止確認にも失敗しました: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}${cleanup}`)
  } finally {
    operation.release()
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'assert-idle') {
    if (args.length !== 1) fail('usage: service-control.ts assert-idle STATE_DIR')
    assertServiceMutationIdle(args[0]!)
    return
  }
  if (command !== 'start' && command !== 'stop') {
    fail('usage: service-control.ts start ROOT_REPO STATE_DIR PROJECT_DIR APP_ID | stop ROOT_REPO STATE_DIR [--force] | assert-idle STATE_DIR')
  }
  const [rootRepo, stateDir, projectDir, expectedAppId, ...extra] = args
  const forceStop = command === 'stop' && projectDir === '--force'
  if (!rootRepo || !stateDir || extra.length > 0
    || (command === 'start' && (!projectDir || !expectedAppId))
    || (command === 'stop' && (expectedAppId !== undefined
      || (projectDir !== undefined && !forceStop)))) {
    fail('usage: service-control.ts start ROOT_REPO STATE_DIR PROJECT_DIR APP_ID | stop ROOT_REPO STATE_DIR [--force] | assert-idle STATE_DIR')
  }
  if (command === 'stop') {
    const result = await stopManagedService(rootRepo, stateDir, {}, { force: forceStop })
    process.stdout.write(result.status === 'already-stopped'
      ? '✅ 既に停止しています。\n'
      : '✅ 停止しました。\n')
    if (result.tabCleanup === 'current-tab') {
      process.stdout.write('   現在のtabは自分自身のため残しました。必要なら手動で閉じてください。\n')
    } else if (result.tabCleanup === 'retained') {
      process.stdout.write('   所有確認できないruntime tabは安全のため残しました。\n')
    }
    return
  }
  const result = await startManagedService(
    rootRepo,
    stateDir,
    projectDir!,
    expectedAppId!,
  )
  if (result.status === 'already-running') {
    process.stdout.write('✅ 既に稼働中です。\n')
    process.stdout.write('   ログtabを作り直す場合は zerochan stop → zerochan start を実行してください。\n')
    return
  }
  process.stdout.write('✅ 起動しました。\n')
  process.stdout.write(`   runtime tab: Zeroちゃん runtime (${result.paneId})\n`)
  process.stdout.write(`   gateway: PID ${result.gatewayPid} / runner: PID ${result.runnerPid} / recovery: PID ${result.launcherPid}\n`)
}

async function runCli(): Promise<void> {
  let deferredSignal: 'SIGINT' | 'SIGTERM' | undefined
  const deferInt = () => { deferredSignal ??= 'SIGINT' }
  const deferTerm = () => { deferredSignal ??= 'SIGTERM' }
  process.on('SIGINT', deferInt)
  process.on('SIGTERM', deferTerm)
  try {
    await main()
  } catch (error) {
    process.stderr.write(`❌ ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  } finally {
    process.off('SIGINT', deferInt)
    process.off('SIGTERM', deferTerm)
  }
  if (deferredSignal) {
    process.stderr.write(`⚠️ ${deferredSignal}はserviceの安定状態を確定した後に反映しました。\n`)
    process.exitCode = deferredSignal === 'SIGINT' ? 130 : 143
  }
}

if (import.meta.main) {
  void runCli()
}
