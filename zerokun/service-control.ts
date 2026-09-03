#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { existsSync, realpathSync } from 'fs'
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
  inspectProcessLock,
  processLockOwnerMatches,
  stopProcessLockOwner,
} from './process-lock.ts'
import {
  observeProcessGeneration,
  processIdentityIsStopped,
  readProcessIdentity,
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
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
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
  paneId?: string
  tabCleanup?: 'none' | 'closed' | 'missing' | 'current-tab' | 'retained'
}

export type ManagedServiceStatus = {
  status: 'running' | 'stopped' | 'partial'
  gatewayPid?: number
  runnerPid?: number
}

function fail(message: string): never {
  throw new Error(message)
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
  if (services.gateway.pid && services.runner.pid) {
    return {
      status: 'running',
      gatewayPid: services.gateway.pid,
      runnerPid: services.runner.pid,
    }
  }
  if (!services.gateway.pid && !services.runner.pid) return { status: 'stopped' }
  return {
    status: 'partial',
    gatewayPid: services.gateway.pid ?? undefined,
    runnerPid: services.runner.pid ?? undefined,
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
    const runnerPid = await forceKillCurrentRunner(stateDir, sleep, captureBoundary)
    stoppedAny = Boolean(runnerPid) || stoppedAny
    const launcher = runnerLauncherProcess(stateDir)
    if (launcher.pid) {
      await forceStopLockedProcess(launcher, timeoutMs)
      stoppedAny = true
    }
    await sleep(25)
    if (!serviceProcesses(stateDir).runner.pid && !runnerLauncherProcess(stateDir).pid) {
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
      fail(`実行中のタスクが${counts.running}件あるため停止しませんでした。完了後に zerochan stop を再実行してください`)
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
      fail(`実行中のタスクが${counts.running}件あるため停止しませんでした。完了後に zerochan stop を再実行してください`)
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
    let stoppedAny = Boolean(initial.gateway.pid || initial.runner.pid)
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
      if (stopped.gateway.pid || stopped.runner.pid || runnerLauncherProcess(stateDir).pid) {
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
      fail(`実行中のタスクが${before.running}件あるため停止しませんでした。完了後に zerochan stop を再実行してください`)
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
    if (stopped.gateway.pid || stopped.runner.pid) {
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
): Promise<{ gatewayPid: number; runnerPid: number }> {
  const release = releaseForRoot(rootRepo)
  let observedGateway = 0
  let observedRunner = 0
  await waitForStableHealth({
    requiredConsecutive: 5,
    maxChecks: 60,
    sleep: () => Bun.sleep(250),
    observe: () => {
      const services = serviceProcesses(stateDir)
      const readiness = readGatewayReadiness(join(stateDir, 'gateway-ready.json'))
      observedGateway = services.gateway.pid ?? 0
      observedRunner = services.runner.pid ?? 0
      return Boolean(observedGateway && observedRunner
        && readiness?.pid === observedGateway
        && readiness.slackAppId === expectedAppId
        && readiness.release === release
        && realpathSync(readiness.projectDir) === projectDir)
    },
  })
  return { gatewayPid: observedGateway, runnerPid: observedRunner }
}

async function requireRunningServiceCompatible(
  stateDir: string,
  controlRuntime: HerdrRuntimeIdentity,
  expectedAppId: string,
  gatewayPid: number,
): Promise<void> {
  const readiness = readGatewayReadiness(join(stateDir, 'gateway-ready.json'))
  if (!readiness || readiness.pid !== gatewayPid || readiness.slackAppId !== expectedAppId) {
    fail('稼働中serviceのSlack App identityまたはreadinessが一致しません。zerochan stop を実行してください')
  }
  const pinned = readPinnedHerdrRuntime(stateDir)
  await verifyHerdrRuntimeIdentityAsync(
    pinned,
    environmentForPinnedHerdrRuntime(pinned),
  )
  if (herdrControlPlaneFingerprint(pinned) !== herdrControlPlaneFingerprint(controlRuntime)) {
    fail('稼働中serviceと現在のHerdr control planeが一致しません')
  }
  const runnerRuntime = readRunnerRuntime(stateDir)
  const prefix = `zerokun-codex-runner-v1:${expectedAppId}:`
  const suffix = `:${herdrRuntimeFingerprint(pinned)}`
  if (!runnerRuntime?.startsWith(prefix) || !runnerRuntime.endsWith(suffix)) {
    fail('稼働中job runnerのSlack AppまたはHerdr runtimeが一致しません')
  }
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
    if (services.gateway.pid && services.runner.pid) {
      await requireRunningServiceCompatible(
        stateDir,
        controlRuntime,
        expectedAppId,
        services.gateway.pid,
      )
      clearIntentionalServiceStop(stateDir)
      return {
        status: 'already-running',
        gatewayPid: services.gateway.pid,
        runnerPid: services.runner.pid,
      }
    }
    if (services.gateway.pid || services.runner.pid) {
      fail('serviceが部分起動状態です。zerochan stop の後に zerochan start を実行してください')
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
      if (services.runner.pid || services.gateway.pid) {
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
      if (remaining.gateway.pid || remaining.runner.pid || activeCounts(stateDir).running > 0) {
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
  process.stdout.write(`   gateway: PID ${result.gatewayPid} / runner: PID ${result.runnerPid}\n`)
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
