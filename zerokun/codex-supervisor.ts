#!/usr/bin/env -S bun --config=/dev/null --no-env-file

/**
 * Codex とその通常の子processを同じprocess group内で監督する小さなwrapper。
 * runnerがSIGKILLされてもこのleaderは残り、Codex終了後にbackground子を回収する。
 */

import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { dirname } from 'path'
import {
  captureTrackedProcesses,
  readProcessIdentity,
  reapTrackedProcesses,
  seedTrackedProcess,
} from './process-tree.ts'
import {
  observeProcessGeneration,
  processIdentityIsStopped,
  signalProcessIfLive,
} from './process-generation.ts'
import { atomicWritePrivateFile } from './safe-file.ts'
import { verifyEncodedOfficialCodexSnapshot } from './standalone-codex.ts'
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
      // Keep the error listener for the supervisor lifetime: a pipe write may
      // report EPIPE after the source has already reached EOF.
      destination.off('close', closeSink)
      reader.releaseLock()
    }
  })()
  return {
    done,
    cancel: async () => {
      cancelled = true
      // An open but unread runner pipe emits neither drain nor close. Release
      // that wait explicitly so descendant cleanup never depends on the
      // runner consuming supervisor output.
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
    for (const [pid, started] of tracked) {
      trackedLedger.set(`${pid}:${started}`, { pid, started })
    }
    if (trackedLedger.size > 4_096) {
      throw new Error('Codex tracked generation ledger exceeded 4096 entries')
    }
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
  writeFileSync(registrationPath, JSON.stringify(registration()), { mode: 0o600, flag: 'wx' })
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
    atomicWritePrivateFile(registrationPath, JSON.stringify(registration()))
    persistedTracked = nextTracked
  }
  const persistCleanupConfirmed = (): void => {
    mergeTrackedLedger()
    registrationPhase = 'cleanup-confirmed'
    revision += 1
    atomicWritePrivateFile(registrationPath, JSON.stringify(registration()))
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
      // cancelled explicitly below before descendant cleanup.
      onExit: (_subprocess, exitCode, signalCode, error) => {
        if (error) {
          rejectDirectExit(error)
          return
        }
        resolveDirectExit(exitCode ?? (signalCode === null ? 1 : 128 + signalCode))
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
    const testChildGrace = Number(process.env.ZEROKUN_SUPERVISOR_TEST_CHILD_GRACE_MS)
    const childGraceMs = hasTestOverride
      && Number.isSafeInteger(testChildGrace)
      && testChildGrace > 0
      && testChildGrace <= 5_000
      ? testChildGrace
      : 5_000
    const terminateChild = (): boolean => {
      const delivered = signalProcessIfLive(childIdentity, 'SIGTERM')
      forceKillTimer ??= setTimeout(() => {
        signalProcessIfLive(childIdentity, 'SIGKILL')
      }, childGraceMs)
      return delivered
    }
    const tracker = (async () => {
      try {
        while (tracking) {
          captureTrackedProcesses([process.pid, child.pid], process.pid, tracked, excluded)
          persistTracked()
          await Bun.sleep(100)
        }
      } catch (error) {
        trackingError = error
        terminateChild()
      }
    })()
    // group宛signalはCodexにも届く。wrapper自身は子孫の終了と後始末を待つ。
    const forwardSignal = () => terminateChild()
    // The executor sends SIGUSR2 only after sealing a matching top-level
    // turn.completed event and final response file. Keep this distinct from
    // runner abort/timeout signals; the executor alone decides whether the
    // resulting non-zero Codex exit is a logically completed success.
    let logicalStopDelivered = false
    const finishCompletedTurn = () => {
      logicalStopDelivered = terminateChild() || logicalStopDelivered
    }
    process.on('SIGINT', forwardSignal)
    process.on('SIGTERM', forwardSignal)
    process.on('SIGUSR2', finishCompletedTurn)
    const exitCode = await directExit
    if (forceKillTimer) clearTimeout(forceKillTimer)
    tracking = false
    await tracker
    // Reap inherited descriptor holders before deciding that the JSONL relay
    // is stuck. Cancelling the relay first can discard a buffered terminal
    // event while a completed subagent or MCP descendant still owns the pipe.
    captureTrackedProcesses([process.pid], process.pid, tracked, excluded)
    persistTracked()
    const remaining = await reapTrackedProcesses({
      rootPids: [process.pid],
      groupId: process.pid,
      tracked,
      excludePids: excluded,
      signalGroup: false,
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
      })
    }
    const relayResults = await Promise.race([
      relayCompletion,
      Bun.sleep(2_000).then(() => undefined),
    ])
    if (!relayResults) {
      // An untracked process may have detached before the polling tracker saw
      // it while retaining a JSONL pipe. Cancel only to release the parent
      // reader; never convert this uncertainty into a publishable success.
      await Promise.all([stdoutRelay.cancel(), stderrRelay.cancel()])
      const cancelledRelayResults = await Promise.race([
        relayCompletion,
        Bun.sleep(1_000).then(() => undefined),
      ])
      if (!cancelledRelayResults) {
        throw new Error('Codex output relay remained open after descendant cleanup')
      }
      const cancelledRelayFailure = cancelledRelayResults.find(
        result => result.status === 'rejected',
      )
      if (cancelledRelayFailure?.status === 'rejected') throw cancelledRelayFailure.reason
    }
    const relayFailure = relayResults?.find(result => result.status === 'rejected')
    if (relayFailure?.status === 'rejected') throw relayFailure.reason
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
    process.stderr.write(
      `Codex cleanup is pending; retaining supervisor registration: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    )
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
