#!/usr/bin/env -S bun --config=/dev/null --no-env-file

/**
 * Codex とその通常の子processを同じprocess group内で監督する小さなwrapper。
 * runnerがSIGKILLされてもこのleaderは残り、Codex終了後にbackground子を回収する。
 */

import { randomUUID } from 'crypto'
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  captureTrackedProcesses,
  readProcessIdentity,
  reapTrackedProcesses,
  seedTrackedProcess,
} from './process-tree.ts'
import { signalProcessIfLive } from './process-generation.ts'

function relayStream(
  stream: ReadableStream<Uint8Array>,
  destination: NodeJS.WriteStream,
): { done: Promise<void>; cancel: () => Promise<void> } {
  const reader = stream.getReader()
  let cancelled = false
  let sinkClosed = destination.destroyed || destination.writableEnded
  let releaseBackpressure: (() => void) | undefined
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
          if (!destination.write(value)) {
            await new Promise<void>(resolve => {
              const settled = () => {
                destination.off('drain', settled)
                destination.off('error', settled)
                destination.off('close', settled)
                if (releaseBackpressure === settled) releaseBackpressure = undefined
                resolve()
              }
              releaseBackpressure = settled
              destination.once('drain', settled)
              destination.once('error', settled)
              destination.once('close', settled)
            })
          }
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
      releaseBackpressure?.()
      try { await reader.cancel() } catch {}
    },
  }
}

async function main(): Promise<void> {
  const [jobId, registrationPath, codexBin, ...args] = process.argv.slice(2)
  if (!jobId || !registrationPath || !codexBin) {
    throw new Error('usage: codex-supervisor.ts JOB_ID REGISTRATION_PATH CODEX_BIN [ARG ...]')
  }
  const registrationDirectory = lstatSync(dirname(registrationPath))
  const ownerMatches = typeof process.getuid !== 'function'
    || registrationDirectory.uid === process.getuid()
  if (!registrationDirectory.isDirectory() || registrationDirectory.isSymbolicLink()
    || !ownerMatches) {
    throw new Error(`unsafe executor registration directory: ${dirname(registrationPath)}`)
  }
  const temporary = `${registrationPath}.${process.pid}.${randomUUID()}.tmp`
  const supervisorIdentity = readProcessIdentity(process.pid)
  if (!supervisorIdentity) throw new Error('supervisor process identityを取得できません')
  if (supervisorIdentity.pgid !== supervisorIdentity.pid) {
    throw new Error('supervisorが独立process group leaderではありません')
  }
  writeFileSync(temporary, JSON.stringify({
    version: 2,
    cleanupPending: true,
    jobId,
    pid: supervisorIdentity.pid,
    pgid: supervisorIdentity.pgid,
    started: supervisorIdentity.started,
    bootSession: supervisorIdentity.bootSession,
    startSec: supervisorIdentity.startSec,
    startUsec: supervisorIdentity.startUsec,
  }), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, registrationPath)
  let cleanupConfirmed = false
  try {
    const child = Bun.spawn([codexBin, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdin: 'inherit',
      // Keep Codex descendants away from the supervisor's own stdout/stderr
      // descriptors. If a daemonized descendant inherits these pipes, the
      // supervisor can cancel them after the direct Codex process exits and
      // the executor still receives EOF promptly.
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const seedDelayMs = Number(process.env.ZEROKUN_SUPERVISOR_TEST_SEED_DELAY_MS)
    if (Number.isFinite(seedDelayMs) && seedDelayMs > 0) await Bun.sleep(seedDelayMs)
    const tracked = new Map<number, string>([[process.pid, supervisorIdentity.started]])
    const childIdentity = seedTrackedProcess(child.pid, tracked)
    const stdoutRelay = relayStream(child.stdout, process.stdout)
    const stderrRelay = relayStream(child.stderr, process.stderr)
    const relayCompletion = Promise.allSettled([stdoutRelay.done, stderrRelay.done])
    const excluded = new Set([process.pid])
    let tracking = true
    let trackingError: unknown
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    const terminateChild = () => {
      signalProcessIfLive(childIdentity, 'SIGTERM')
      forceKillTimer ??= setTimeout(() => {
        signalProcessIfLive(childIdentity, 'SIGKILL')
      }, 5_000)
    }
    const tracker = (async () => {
      try {
        while (tracking) {
          captureTrackedProcesses([process.pid, child.pid], process.pid, tracked, excluded)
          await Bun.sleep(100)
        }
      } catch (error) {
        trackingError = error
        terminateChild()
      }
    })()
    // group宛signalはCodexにも届く。wrapper自身は子孫の終了と後始末を待つ。
    const forwardSignal = () => terminateChild()
    process.on('SIGINT', forwardSignal)
    process.on('SIGTERM', forwardSignal)
    const exitCode = await child.exited
    if (forceKillTimer) clearTimeout(forceKillTimer)
    tracking = false
    await tracker
    await Promise.race([relayCompletion, Bun.sleep(250)])
    await Promise.all([stdoutRelay.cancel(), stderrRelay.cancel()])
    const relayResults = await Promise.race([
      relayCompletion,
      Bun.sleep(1_000).then(() => undefined),
    ])
    captureTrackedProcesses([process.pid], process.pid, tracked, excluded)
    const remaining = await reapTrackedProcesses({
      rootPids: [process.pid],
      groupId: process.pid,
      tracked,
      excludePids: excluded,
      signalGroup: false,
    })
    process.off('SIGINT', forwardSignal)
    process.off('SIGTERM', forwardSignal)
    if (remaining.length > 0) {
      throw new Error(`Codexの子processを回収できませんでした: ${remaining.join(', ')}`)
    }
    if (trackingError) throw trackingError
    cleanupConfirmed = true
    if (!relayResults) throw new Error('Codex output relay did not stop after cancellation')
    const relayFailure = relayResults.find(result => result.status === 'rejected')
    if (relayFailure?.status === 'rejected') throw relayFailure.reason
    process.exitCode = exitCode
  } catch (error) {
    if (cleanupConfirmed) throw error
    // Keep the exact group leader and durable registration alive whenever
    // cleanup is uncertain. The executor/next runner can then TERM and KILL
    // the still-verifiable group without following a recycled numeric PGID.
    process.stderr.write(
      `Codex cleanup is pending; retaining supervisor registration: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    )
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
    process.on('SIGINT', () => {})
    process.on('SIGTERM', () => {})
    while (true) await Bun.sleep(60_000)
  } finally {
    if (cleanupConfirmed) {
      try {
        const current = JSON.parse(readFileSync(registrationPath, 'utf8')) as { pid?: number }
        if (current.pid === process.pid) rmSync(registrationPath, { force: true })
      } catch {}
    }
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
