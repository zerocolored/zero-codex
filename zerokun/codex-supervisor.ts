#!/usr/bin/env -S bun --config=/dev/null --no-env-file

/**
 * Codex とその通常の子processを同じprocess group内で監督する小さなwrapper。
 * runnerがSIGKILLされてもこのleaderは残り、Codex終了後にbackground子を回収する。
 */

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import {
  captureTrackedProcesses,
  MAX_EXECUTOR_REGISTRATION_BYTES,
  readProcessIdentity,
  reapTrackedProcesses,
  seedTrackedProcess,
  synchronizeTrackedProcessLedger,
} from './process-tree.ts'
import {
  observeProcessGeneration,
  processIdentityIsStopped,
  signalProcessIfLive,
} from './process-generation.ts'
import { atomicWritePrivateFile } from './safe-file.ts'
import { verifyEncodedOfficialCodexSnapshot } from './standalone-codex.ts'
import { subprocessExitCode } from './process-exit-code.ts'
import {
  readSeatbeltFingerprint,
  reapSeatbeltFingerprint,
  type SeatbeltFingerprint,
} from './seatbelt-fingerprint.ts'

const LOGICAL_CLEANUP_EXIT_CODE = 86

function relayStream(
  stream: ReadableStream<Uint8Array>,
  destination: NodeJS.WriteStream,
): { done: Promise<void>; cancel: () => Promise<void> } {
  const reader = stream.getReader()
  let cancelled = false
  let completed = false
  let sinkClosed = destination.destroyed || destination.writableEnded
  let releasePendingWrite: (() => void) | undefined
  const closeSink = () => { sinkClosed = true }
  // A runner crash closes the supervisor's output pipes. EPIPE must only stop
  // forwarding; supervision and descendant cleanup must continue.
  destination.on('error', closeSink)
  destination.on('close', closeSink)
  const done = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        if (sinkClosed) continue
        try {
          await new Promise<void>(resolve => {
            let settledAlready = false
            const settled = () => {
              if (settledAlready) return
              settledAlready = true
              destination.off('error', settled)
              destination.off('close', settled)
              if (releasePendingWrite === settled) releasePendingWrite = undefined
              resolve()
            }
            releasePendingWrite = settled
            destination.once('error', settled)
            destination.once('close', settled)
            destination.write(value, settled)
          })
        } catch {
          sinkClosed = true
        }
      }
    } catch (error) {
      if (!cancelled) throw error
    } finally {
      completed = true
      // Keep the error listener for the supervisor lifetime: a pipe write may
      // report EPIPE after the source has already reached EOF.
      destination.off('close', closeSink)
      reader.releaseLock()
    }
  })()
  return {
    done,
    cancel: async () => {
      if (cancelled || completed) return
      cancelled = true
      // A pipe can be open but backpressured forever. Release the pending
      // destination callback as well as the source reader on explicit force.
      releasePendingWrite?.()
      try { await reader.cancel() } catch {}
    },
  }
}

async function main(): Promise<void> {
  const [jobId, registrationPath, ...command] = process.argv.slice(2)
  const hasFingerprint = command[0] === '--seatbelt-fingerprint'
  const allowTagPath = hasFingerprint ? command[1] : undefined
  const denyTagPath = hasFingerprint ? command[2] : undefined
  const runtimeCommand = hasFingerprint ? command.slice(3) : command
  const hasOfficialSnapshot = runtimeCommand[0] === '--official-codex-snapshot'
  const hasTestOverride = runtimeCommand[0] === '--unverified-for-tests'
  const encodedOfficialSnapshot = hasOfficialSnapshot ? runtimeCommand[1] : undefined
  const separatorIndex = hasOfficialSnapshot ? 2 : hasTestOverride ? 1 : -1
  const codexBin = separatorIndex >= 0 && runtimeCommand[separatorIndex] === '--'
    ? runtimeCommand[separatorIndex + 1]
    : undefined
  const args = separatorIndex >= 0 ? runtimeCommand.slice(separatorIndex + 2) : []
  if (!jobId || !registrationPath || !codexBin) {
    throw new Error(
      'usage: codex-supervisor.ts JOB_ID REGISTRATION_PATH '
      + '[--seatbelt-fingerprint ALLOW_TAG DENY_TAG] '
      + '(--official-codex-snapshot SNAPSHOT | --unverified-for-tests) -- CODEX_BIN [ARG ...]',
    )
  }
  if (!hasOfficialSnapshot && (!hasTestOverride
    || process.env.ZEROKUN_SUPERVISOR_TEST_UNVERIFIED !== '1')) {
    throw new Error('Codex supervisor requires a verified official standalone snapshot')
  }
  if (hasOfficialSnapshot && (!hasFingerprint || !allowTagPath || !denyTagPath)) {
    throw new Error('official Codex supervisor requires a Seatbelt fingerprint')
  }
  if (hasOfficialSnapshot) {
    if (!encodedOfficialSnapshot) {
      throw new Error('Codex official standalone snapshot is required')
    }
    const verified = verifyEncodedOfficialCodexSnapshot(encodedOfficialSnapshot)
    if (verified.physical !== codexBin) {
      throw new Error('Codex official standalone snapshot does not match the requested executable')
    }
  }
  const registrationDirectory = lstatSync(dirname(registrationPath))
  const ownerMatches = typeof process.getuid !== 'function'
    || registrationDirectory.uid === process.getuid()
  if (!registrationDirectory.isDirectory() || registrationDirectory.isSymbolicLink()
    || !ownerMatches) {
    throw new Error(`unsafe executor registration directory: ${dirname(registrationPath)}`)
  }
  const stateDir = dirname(dirname(registrationPath))
  const fingerprint: SeatbeltFingerprint | undefined = hasFingerprint
    && allowTagPath && denyTagPath
    ? readSeatbeltFingerprint(stateDir, allowTagPath, denyTagPath)
    : undefined
  const supervisorIdentity = readProcessIdentity(process.pid)
  if (!supervisorIdentity) throw new Error('supervisor process identityを取得できません')
  if (supervisorIdentity.pgid !== supervisorIdentity.pid) {
    throw new Error('supervisorが独立process group leaderではありません')
  }
  const tracked = new Map<number, string>([[process.pid, supervisorIdentity.started]])
  const trackedLedger = new Map<string, { pid: number; started: string }>([[
    `${process.pid}:${supervisorIdentity.started}`,
    { pid: process.pid, started: supervisorIdentity.started },
  ]])
  let registrationPhase: 'active' | 'cleanup-confirmed' = 'active'
  let revision = 0
  const mergeTrackedLedger = (): void => {
    synchronizeTrackedProcessLedger(tracked, trackedLedger)
  }
  const registration = () => ({
    version: fingerprint ? 4 as const : 3 as const,
    phase: registrationPhase,
    revision,
    cleanupPending: true,
    jobId,
    pid: supervisorIdentity.pid,
    pgid: supervisorIdentity.pgid,
    started: supervisorIdentity.started,
    bootSession: supervisorIdentity.bootSession,
    startSec: supervisorIdentity.startSec,
    startUsec: supervisorIdentity.startUsec,
    tracked: [...trackedLedger.values()].sort((left, right) => (
      left.pid - right.pid || left.started.localeCompare(right.started)
    )),
    ...(fingerprint ? { fingerprint } : {}),
  })
  const serializedRegistration = (): string => {
    const value = JSON.stringify(registration())
    if (Buffer.byteLength(value) > MAX_EXECUTOR_REGISTRATION_BYTES) {
      throw new Error(
        `Codex executor registration exceeded ${MAX_EXECUTOR_REGISTRATION_BYTES} bytes`,
      )
    }
    return value
  }
  writeFileSync(registrationPath, serializedRegistration(), { mode: 0o600, flag: 'wx' })
  let registrationDescriptor = openSync(
    registrationPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  let registrationParentDescriptor = openSync(
    dirname(registrationPath),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    fsyncSync(registrationDescriptor)
    fsyncSync(registrationParentDescriptor)
  } finally {
    closeSync(registrationDescriptor)
    closeSync(registrationParentDescriptor)
  }
  let persistedTracked = JSON.stringify(registration().tracked)
  const persistTracked = (): void => {
    mergeTrackedLedger()
    const nextTracked = JSON.stringify(registration().tracked)
    if (nextTracked === persistedTracked) return
    revision += 1
    atomicWritePrivateFile(registrationPath, serializedRegistration())
    persistedTracked = nextTracked
  }
  const persistCleanupConfirmed = (): void => {
    mergeTrackedLedger()
    registrationPhase = 'cleanup-confirmed'
    revision += 1
    atomicWritePrivateFile(registrationPath, serializedRegistration())
    persistedTracked = JSON.stringify(registration().tracked)
  }
  const clearOwnRegistration = (): void => {
    const current = JSON.parse(readFileSync(registrationPath, 'utf8')) as {
      pid?: number
      started?: string
      phase?: string
    }
    if (current.pid !== process.pid || current.started !== supervisorIdentity.started
      || !['active', 'cleanup-confirmed'].includes(current.phase ?? '')) {
      throw new Error('executor registration identity changed before cleanup')
    }
    rmSync(registrationPath, { force: true })
  }
  let cleanupConfirmed = false
  let childStarted = false
  try {
    if (encodedOfficialSnapshot !== undefined) {
      const verified = verifyEncodedOfficialCodexSnapshot(encodedOfficialSnapshot)
      if (verified.physical !== codexBin) {
        throw new Error('Codex official standalone changed before child spawn')
      }
    }
    let resolveDirectExit!: (exitCode: number) => void
    let rejectDirectExit!: (error: unknown) => void
    const directExit = new Promise<number>((resolve, reject) => {
      resolveDirectExit = resolve
      rejectDirectExit = reject
    })
    const child = Bun.spawn([
      '/bin/sh', '-c', 'kill -STOP $$ || exit 125; exec "$@"',
      'zerokun-codex-gate', codexBin, ...args,
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdin: 'inherit',
      // Keep Codex descendants away from the supervisor's own stdout/stderr
      // descriptors. If a daemonized descendant inherits these pipes, the
      // supervisor can cancel them after the direct Codex process exits and
      // the executor still receives EOF promptly.
      stdout: 'pipe',
      stderr: 'pipe',
      // Bun's `subprocess.exited` may wait for inherited stdout/stderr pipe
      // writers. Codex's shared code-mode host can outlive the direct CLI and
      // retain those descriptors after a multi-agent turn. The waitpid-backed
      // callback is the authoritative direct-process exit boundary; relays are
      // kept open until their real EOF; explicit cancellation instead enters
      // the parent-owned bounded process cleanup path.
      onExit: (_subprocess, exitCode, signalCode, error) => {
        if (error) {
          rejectDirectExit(error)
          return
        }
        resolveDirectExit(subprocessExitCode(exitCode, signalCode))
      },
    })
    childStarted = true
    const seedDelayMs = Number(process.env.ZEROKUN_SUPERVISOR_TEST_SEED_DELAY_MS)
    if (Number.isFinite(seedDelayMs) && seedDelayMs > 0) await Bun.sleep(seedDelayMs)
    const childIdentity = seedTrackedProcess(child.pid, tracked)
    const gateDeadline = Date.now() + 2_000
    while (true) {
      const gate = observeProcessGeneration(childIdentity)
      if (gate.status === 'unknown') throw new Error('Codex gate generation is unknown')
      if (gate.status === 'dead') throw new Error('Codex gate exited before durable registration')
      if (processIdentityIsStopped(gate.identity)) break
      if (Date.now() >= gateDeadline) throw new Error('Codex gate did not stop before registration')
      await Bun.sleep(5)
    }
    persistTracked()
    if (!signalProcessIfLive(childIdentity, 'SIGCONT')) {
      throw new Error('Codex gateを追跡情報の永続化後に開始できません')
    }
    const stdoutRelay = relayStream(child.stdout, process.stdout)
    const stderrRelay = relayStream(child.stderr, process.stderr)
    const relayCompletion = Promise.allSettled([stdoutRelay.done, stderrRelay.done])
    const excluded = new Set([process.pid])
    let tracking = true
    let trackingError: unknown
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let forceCleanupRequested = false
    let resolveForceCleanup!: () => void
    const forceCleanupSignal = new Promise<void>(resolve => {
      resolveForceCleanup = resolve
    })
    const requestForceCleanup = (): void => {
      if (forceCleanupRequested) return
      forceCleanupRequested = true
      resolveForceCleanup()
    }
    const testChildGrace = Number(process.env.ZEROKUN_SUPERVISOR_TEST_CHILD_GRACE_MS)
    const childGraceMs = hasTestOverride
      && Number.isSafeInteger(testChildGrace)
      && testChildGrace > 0
      && testChildGrace <= 5_000
      ? testChildGrace
      : 5_000
    const signalChildTermination = (forceAfterGrace: boolean): boolean => {
      const delivered = signalProcessIfLive(childIdentity, 'SIGTERM')
      if (forceAfterGrace) {
        forceKillTimer ??= setTimeout(() => {
          signalProcessIfLive(childIdentity, 'SIGKILL')
        }, childGraceMs)
      }
      return delivered
    }
    const terminateChild = (): boolean => signalChildTermination(true)
    const tracker = (async () => {
      try {
        while (tracking) {
          captureTrackedProcesses([process.pid, child.pid], process.pid, tracked, excluded)
          persistTracked()
          if (hasTestOverride
            && process.env.ZEROKUN_SUPERVISOR_TEST_FORCE_TRACKER_ERROR === '1'
            && existsSync(join(stateDir, '.test-force-tracker-error-ready'))) {
            throw new Error('forced supervisor tracker error for tests')
          }
          await Bun.sleep(100)
        }
      } catch (error) {
        trackingError = error
        // Tracker failure is an explicit cleanup fault, not ordinary cleanup.
        // Bound the recovery path even when a descendant ignores TERM.
        requestForceCleanup()
        terminateChild()
      }
    })()
    // group宛signalはCodexにも届く。wrapper自身は子孫の終了と後始末を待つ。
    const forwardSignal = () => {
      requestForceCleanup()
      return terminateChild()
    }
    // The executor sends SIGUSR2 only after sealing a matching top-level
    // turn.completed event and final response file. Keep this distinct from
    // runner abort/timeout signals; the executor alone decides whether the
    // resulting non-zero Codex exit is a logically completed success.
    let logicalStopDelivered = false
    const finishCompletedTurn = () => {
      // A sealed logical completion is not an abort deadline. Give the direct
      // child unlimited time to emit a delayed terminal event and close its
      // relays. A later explicit parent SIGINT/SIGTERM still enters the
      // bounded terminateChild TERM-to-KILL path above.
      logicalStopDelivered = signalChildTermination(false) || logicalStopDelivered
    }
    process.on('SIGINT', forwardSignal)
    process.on('SIGTERM', forwardSignal)
    process.on('SIGUSR2', finishCompletedTurn)
    const exitCode = await directExit
    if (forceKillTimer) clearTimeout(forceKillTimer)
    tracking = false
    await tracker
    if (hasTestOverride
      && process.env.ZEROKUN_SUPERVISOR_TEST_FORCE_RETAIN_AFTER_CHILD_EXIT === '1') {
      throw new Error('forced supervisor retained-state for tests')
    }
    // Reap inherited descriptor holders before waiting for the JSONL relay.
    // Cancelling a slow relay can discard a buffered terminal event while a
    // completed subagent or MCP descendant still owns the pipe.
    captureTrackedProcesses([process.pid], process.pid, tracked, excluded)
    persistTracked()
    const remaining = await reapTrackedProcesses({
      rootPids: [process.pid],
      groupId: process.pid,
      tracked,
      excludePids: excluded,
      signalGroup: false,
      waitForForce: () => forceCleanupRequested,
    })
    // Keep SIGUSR2 handled until the supervisor process itself exits. The
    // executor may seal the final file while this wrapper is draining relays
    // after the direct Codex child already exited; removing the handler here
    // would turn that benign race into an exit-by-SIGUSR2 (159 on macOS).
    if (remaining.length > 0) {
      throw new Error(`Codexの子processを回収できませんでした: ${remaining.join(', ')}`)
    }
    if (trackingError) throw trackingError
    if (fingerprint) {
      await reapSeatbeltFingerprint({
        stateDir,
        fingerprint,
        earliest: supervisorIdentity,
        excludePids: new Set([process.pid]),
        waitForForce: () => forceCleanupRequested,
      })
    }
    // A logical job has no relay deadline. After an explicit force request,
    // first reap every exact tracked/Seatbelt generation above and still give
    // their pipes a bounded natural-EOF grace. Only a pipe that remains open
    // after that proof is cancelled, and cancellation is retained as cleanup
    // uncertainty rather than promoted to a publishable receipt.
    const relayBoundary = await Promise.race([
      relayCompletion.then(results => ({ kind: 'complete' as const, results })),
      forceCleanupSignal.then(() => ({ kind: 'force' as const })),
    ])
    let relayResults: PromiseSettledResult<void>[]
    if (relayBoundary.kind === 'complete') {
      relayResults = relayBoundary.results
    } else {
      const forcedRelayResults = await Promise.race([
        relayCompletion,
        Bun.sleep(childGraceMs).then(() => null),
      ])
      if (forcedRelayResults === null) {
        await Promise.race([
          Promise.allSettled([stdoutRelay.cancel(), stderrRelay.cancel()]),
          Bun.sleep(1_000),
        ])
        throw new Error('Codex output relay remained open after explicit cleanup')
      }
      relayResults = forcedRelayResults
    }
    const relayFailure = relayResults.find(result => result.status === 'rejected')
    if (relayFailure?.status === 'rejected') throw relayFailure.reason
    if (hasTestOverride && process.env.ZEROKUN_SUPERVISOR_TEST_CLEANUP_GATE === '1') {
      // Deterministically hold the test-only supervisor after every real cleanup
      // step but before the durable self-confirm receipt.  Derive both names
      // from the private managed state root and this exact supervisor PID so a
      // caller cannot turn the gate into an arbitrary-path write primitive.
      const gateBase = join(stateDir, `.test-cleanup-gate-${process.pid}`)
      const readyPath = `${gateBase}.ready`
      const releasePath = `${gateBase}.release`
      writeFileSync(readyPath, '', { mode: 0o600, flag: 'wx' })
      try {
        while (!existsSync(releasePath)) await Bun.sleep(10)
        const release = lstatSync(releasePath)
        const releaseOwnerMatches = typeof process.getuid !== 'function'
          || release.uid === process.getuid()
        if (!release.isFile() || release.isSymbolicLink() || release.nlink !== 1
          || release.size !== 0 || !releaseOwnerMatches) {
          throw new Error('unsafe supervisor test cleanup gate release')
        }
      } finally {
        rmSync(readyPath, { force: true })
        rmSync(releasePath, { force: true })
      }
    }
    process.off('SIGINT', forwardSignal)
    process.off('SIGTERM', forwardSignal)
    cleanupConfirmed = true
    persistCleanupConfirmed()
    // All relays and exact-descendant cleanup are complete. Exit explicitly so
    // the SIGUSR2 handler kept for the cleanup race does not keep Bun's event
    // loop alive.
    process.exit(logicalStopDelivered ? LOGICAL_CLEANUP_EXIT_CODE : exitCode)
  } catch (error) {
    if (!childStarted) cleanupConfirmed = true
    if (cleanupConfirmed) throw error
    // Keep the exact group leader and durable registration alive whenever
    // cleanup is uncertain. The executor/next runner can then TERM and KILL
    // the still-verifiable group without following a recycled numeric PGID.
    // Wake the parent's ordered App Server reader before retaining this exact
    // group leader. Merely closing Bun's process.stdout wrapper is not an EOF
    // guarantee while the process remains alive, so use a fixed internal
    // notification that the session rejects as a cleanup fault.
    try {
      writeSync(1, '{"method":"zerokun/supervisor-retained","params":{"version":1}}\n')
    } catch {}
    try {
      writeSync(
        2,
        `Codex cleanup is pending; retaining supervisor registration: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      )
    } catch {}
    // The exact leader stays alive so the parent/recovery path can still use
    // its generation and group. Close both relay outputs, however, so the
    // executor can distinguish retained cleanup from a legitimately slow
    // normal cleanup and enter its bounded explicit-recovery path.
    // Bun keeps process.stdout/process.stderr stream wrappers alive after
    // end() while this supervisor intentionally remains resident. Closing the
    // exact inherited pipe descriptors is the OS-level EOF sentinel required
    // by the parent; no repository or arbitrary descriptor is affected.
    try { process.stdout.destroy() } catch {}
    try { process.stderr.destroy() } catch {}
    try { closeSync(1) } catch {}
    try { closeSync(2) } catch {}
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGUSR2')
    process.on('SIGINT', () => {})
    process.on('SIGTERM', () => {})
    process.on('SIGUSR2', () => {})
    while (true) await Bun.sleep(60_000)
  } finally {
    if (cleanupConfirmed && !childStarted) {
      try {
        if (lstatSync(registrationPath)) clearOwnRegistration()
      } catch {}
    }
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
