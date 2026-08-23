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
} from './process-tree.ts'

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
  writeFileSync(temporary, JSON.stringify({
    jobId,
    pid: supervisorIdentity.pid,
    pgid: supervisorIdentity.pgid,
    started: supervisorIdentity.started,
  }), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, registrationPath)
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
    const stdoutRelay = relayStream(child.stdout, process.stdout)
    const stderrRelay = relayStream(child.stderr, process.stderr)
    const relayCompletion = Promise.allSettled([stdoutRelay.done, stderrRelay.done])
    const tracked = new Map<number, string>()
    const excluded = new Set([process.pid])
    let tracking = true
    let trackingError: unknown
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    const terminateChild = () => {
      try { child.kill('SIGTERM') } catch {}
      forceKillTimer ??= setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
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
    if (!relayResults) throw new Error('Codex output relay did not stop after cancellation')
    const relayFailure = relayResults.find(result => result.status === 'rejected')
    if (relayFailure?.status === 'rejected') throw relayFailure.reason
    if (trackingError) throw trackingError
    process.exitCode = exitCode
  } finally {
    try {
      const current = JSON.parse(readFileSync(registrationPath, 'utf8')) as { pid?: number }
      if (current.pid === process.pid) rmSync(registrationPath, { force: true })
    } catch {}
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
