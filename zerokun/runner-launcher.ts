#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { closeSync, lstatSync, realpathSync, writeSync } from 'fs'
import { basename, dirname, isAbsolute, join } from 'path'
import { requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import {
  inspectProcessLock,
  releaseProcessLock,
  tryAcquireProcessLock,
} from './process-lock.ts'
import {
  acquireProcessGroupLeaderIdentity,
  observeProcessGeneration,
  readProcessIdentity,
  sameProcessGeneration,
  signalProcessGroupIfLeaderLive,
  signalProcessIfLive,
  type ProcessIdentity,
} from './process-generation.ts'
import {
  clearAbandonedRunnerLaunchIntent,
  clearRunnerLaunchReceiptAfterReap,
  clearUnspawnedRunnerLaunchIntent,
  prepareRunnerLaunchReceipt,
  publishRunnerLaunchReceipt,
  readRunnerLaunchReceipt,
  waitForPublishedRunnerLaunchReceipt,
  type PreparedRunnerLaunchReceipt,
  type PublishedRunnerLaunchReceipt,
} from './runner-launch-receipt.ts'
import { openSafeLog } from './safe-file.ts'
import { encodeHerdrRuntimeIdentity, requireHerdrRuntime } from './herdr-runtime.ts'

const [runnerInput, stateInput, logInput, starterLockInput] = process.argv.slice(2)
if (!runnerInput || !stateInput || !logInput || !starterLockInput) {
  throw new Error('usage: runner-launcher.ts RUNNER STATE_DIR LOG_PATH STARTER_LOCK')
}
if (![runnerInput, stateInput, logInput, starterLockInput].every(isAbsolute)) {
  throw new Error('runner launcher paths must be absolute')
}

const runner = realpathSync(runnerInput)
const stateDir = requireManagedStateRoot(stateInput)
const starterLock = join(stateDir, 'job-runner-starter.lock')
const starterLockParent = realpathSync(dirname(starterLockInput))
const canonicalStarterLock = join(starterLockParent, basename(starterLockInput))
if (canonicalStarterLock !== starterLock) throw new Error('runner starter lock path is invalid')
const logParent = realpathSync(dirname(logInput))
requireManagedDirectory(stateDir, logParent)
const logPath = join(logParent, basename(logInput))
const runnerMetadata = lstatSync(runner)
if (!runnerMetadata.isFile() || runnerMetadata.isSymbolicLink()) {
  throw new Error(`job runner is not a regular file: ${runner}`)
}
const starterLeaseResult = tryAcquireProcessLock(canonicalStarterLock, process.pid)
if (!starterLeaseResult.acquired) {
  throw new Error(`another runner launcher owns ${starterLock}`)
}
const starterLease = starterLeaseResult.lease

const RESTART_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const
const HEALTHY_RUN_MS = 30_000
const RUNNER_LOCK = join(stateDir, 'job-runner.lock', 'pid')
const RUNNER_COMMAND_PATTERN = /job-runner\.ts\s+daemon(?:\s|$)/
const RECEIPT_HELPER = realpathSync(join(import.meta.dir, 'runner-launch-receipt.ts'))
const RUNNER_BOOTSTRAP = `set -euo pipefail
[ "$#" -eq 4 ] || { echo "runner bootstrap arguments are invalid" >&2; exit 64; }
bun_bin="$1"
receipt_helper="$2"
state_dir="$3"
runner="$4"
"$bun_bin" --config=/dev/null --no-env-file "$receipt_helper" publish-child "$state_dir"
unset ZEROKUN_RUNNER_LAUNCH_INTENT
exec "$bun_bin" --config=/dev/null --no-env-file "$runner" daemon
`

function appendLauncherLog(message: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSafeLog(logPath, 'append')
    writeSync(
      descriptor,
      `${new Date().toISOString()} runner launcher: ${message}\n`,
    )
  } catch (error) {
    process.stderr.write(
      `runner launcher diagnostic unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

async function reapFailedStartup(
  child: ReturnType<typeof Bun.spawn>,
  identity: ProcessIdentity | undefined,
): Promise<void> {
  let signalled = false
  if (identity) {
    if (process.platform !== 'win32' && identity.pgid === identity.pid) {
      signalled = signalProcessGroupIfLeaderLive(identity, 'SIGKILL')
    }
    // A detached spawn can be observed before it becomes its own process-group
    // leader. In that state a group signal is intentionally rejected; fall
    // back to the exact process generation rather than leaving it alive and
    // starting an overlapping retry.
    if (!signalled) signalled = signalProcessIfLive(identity, 'SIGKILL')
  } else {
    try {
      child.kill('SIGKILL')
      signalled = true
    } catch {}
  }

  let exited = await Promise.race([
    child.exited.then(() => true).catch(() => true),
    Bun.sleep(1_000).then(() => false),
  ])
  if (!exited && identity && observeProcessGeneration(identity).status === 'alive') {
    signalProcessIfLive(identity, 'SIGKILL')
    exited = await Promise.race([
      child.exited.then(() => true).catch(() => true),
      Bun.sleep(1_000).then(() => false),
    ])
  }
  if (!exited) {
    throw new Error(
      `job runner startup process ${child.pid} could not be reaped after ${
        signalled ? 'SIGKILL' : 'an unavailable signal boundary'
      }`,
    )
  }
}

try {
  // Keep the launcher and runner in the Herdr pane's process tree. Acquire the
  // exact launcher lease before any potentially slow Herdr probe so the shell
  // can always cancel this precise startup attempt.
  const herdrRuntime = requireHerdrRuntime()
  // Open the managed log before spawning so the child never evaluates a shell
  // redirection and never follows a user-controlled log symlink.
  let shutdownStarted = false
  let daemon: ReturnType<typeof Bun.spawn> | undefined
  let daemonIdentity: ProcessIdentity | undefined
  let daemonReceipt: PublishedRunnerLaunchReceipt | undefined
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined
  let wakeRestartDelay: (() => void) | undefined
  let standbyObservation = ''

  const waitInterruptibly = async (delayMs: number): Promise<void> => {
    await new Promise<void>(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        wakeRestartDelay = undefined
        resolve()
      }
      timer = setTimeout(finish, delayMs)
      wakeRestartDelay = finish
      if (shutdownStarted) finish()
    })
  }

  const signalDaemon = (signal: NodeJS.Signals): void => {
    if (!daemonIdentity) return
    if (process.platform !== 'win32') {
      if (!signalProcessGroupIfLeaderLive(daemonIdentity, signal)) {
        signalProcessIfLive(daemonIdentity, signal)
      }
    } else {
      signalProcessIfLive(daemonIdentity, signal)
    }
  }
  const stop = (signal: NodeJS.Signals) => {
    if (shutdownStarted) return
    shutdownStarted = true
    wakeRestartDelay?.()
    signalDaemon(signal)
    if (daemonIdentity) {
      const expected = daemonIdentity
      forceKillTimer = setTimeout(() => {
        if (observeProcessGeneration(expected).status !== 'alive') return
        if (process.platform !== 'win32') {
          if (!signalProcessGroupIfLeaderLive(expected, 'SIGKILL')) {
            signalProcessIfLive(expected, 'SIGKILL')
          }
        } else {
          signalProcessIfLive(expected, 'SIGKILL')
        }
      }, 3_000)
    }
  }
  const stopInt = () => stop('SIGINT')
  const stopTerm = () => stop('SIGTERM')
  process.on('SIGINT', stopInt)
  process.on('SIGTERM', stopTerm)
  let restartAttempt = 0
  let firstPidPublished = false
  try {
    while (!shutdownStarted) {
      // A launcher can be rebuilt around a still-running orphan runner. Do not
      // spawn lock-losing competitors: job-runner validates Codex and Slack
      // credentials before it acquires the daemon lease. Repeated competitors
      // would therefore cause needless external authentication traffic. Keep
      // the exact live lock under observation and start one replacement only
      // after that generation is definitely gone. Unknown stays fail-closed.
      const existingRunner = inspectProcessLock(RUNNER_LOCK, RUNNER_COMMAND_PATTERN)
      if (existingRunner.status === 'active' || existingRunner.status === 'unknown') {
        const observation = existingRunner.status === 'active'
          ? `active:${existingRunner.pid}`
          : `unknown:${existingRunner.pid ?? 'unavailable'}`
        if (standbyObservation !== observation) {
          appendLauncherLog(existingRunner.status === 'active'
            ? `adopted existing job runner ${existingRunner.pid}; standing by for its exit`
            : 'existing job runner ownership is temporarily unknown; standing by without spawning')
          standbyObservation = observation
        }
        if (existingRunner.status === 'active' && !firstPidPublished) {
          process.stdout.write(`${existingRunner.pid}\n`)
          firstPidPublished = true
        }
        await waitInterruptibly(250)
        continue
      }
      const unresolvedLaunch = readRunnerLaunchReceipt(stateDir)
      if (unresolvedLaunch) {
        if (unresolvedLaunch.state === 'published') {
          const observation = observeProcessGeneration(unresolvedLaunch.runner)
          if (observation.status === 'dead') {
            clearRunnerLaunchReceiptAfterReap(stateDir, unresolvedLaunch)
          } else if (observation.status === 'unknown') {
            const receiptObservation = 'receipt:unknown'
            if (standbyObservation !== receiptObservation) {
              appendLauncherLog(
                'pre-lock job runner generation is temporarily unknown; standing by without spawning',
              )
              standbyObservation = receiptObservation
            }
            await waitInterruptibly(250)
            continue
          } else {
            // The previous launcher may have died after its bootstrap child
            // published but before the child acquired the daemon lock. Adopt
            // that exact generation as this launcher's managed runner. This
            // lets SIGTERM reach it even while it is still invisible to the
            // ordinary runner lock, and lets a later exit trigger one normal
            // replacement instead of leaving a permanent orphan.
            daemonIdentity = observation.identity
            daemonReceipt = unresolvedLaunch
            if (standbyObservation !== `receipt:${unresolvedLaunch.runner.pid}`) {
              appendLauncherLog(
                `adopted pre-lock job runner ${unresolvedLaunch.runner.pid} from durable launch receipt`,
              )
              standbyObservation = `receipt:${unresolvedLaunch.runner.pid}`
            }
            if (!firstPidPublished) {
              process.stdout.write(`${unresolvedLaunch.runner.pid}\n`)
              firstPidPublished = true
            }
            while (observeProcessGeneration(unresolvedLaunch.runner).status === 'alive') {
              if (shutdownStarted) await Bun.sleep(25)
              else await waitInterruptibly(100)
            }
            clearRunnerLaunchReceiptAfterReap(
              stateDir,
              unresolvedLaunch,
              observation.identity,
            )
            daemonIdentity = undefined
            daemonReceipt = undefined
            if (shutdownStarted) break
            appendLauncherLog('adopted job runner exited; automatic recovery will start a replacement')
            standbyObservation = ''
            continue
          }
        } else {
          const oldLauncher = observeProcessGeneration(unresolvedLaunch.launcher)
          if (oldLauncher.status === 'dead') {
            // The old launcher may have died immediately after spawning its
            // bootstrap shell. Give that shell one bounded chance to publish
            // its exact generation. Publication and abandonment serialize on
            // the receipt mutation lease, so a late helper can never resurrect
            // a cancelled intent and exec an unowned runner.
            const published = await waitForPublishedRunnerLaunchReceipt(stateDir, {
              intentId: unresolvedLaunch.intentId,
              launcher: unresolvedLaunch.launcher,
              timeoutMs: 2_000,
              pollMs: 10,
            })
            if (!published) {
              clearAbandonedRunnerLaunchIntent(stateDir, unresolvedLaunch)
              appendLauncherLog('discarded abandoned pre-spawn runner intent from a dead launcher')
              continue
            }
            continue
          }
          // A child-side helper replaces this prepared intent before it execs
          // the real runner. Retain an active or temporarily unknown owner;
          // overwriting it could make a reparented pre-lock runner unowned.
          const receiptObservation = oldLauncher.status === 'alive'
            ? `intent:${unresolvedLaunch.intentId}`
            : `intent-unknown:${unresolvedLaunch.intentId}`
          if (standbyObservation !== receiptObservation) {
            appendLauncherLog(oldLauncher.status === 'alive'
              ? 'runner launch publication is pending; standing by without spawning'
              : 'runner launch owner is temporarily unknown; standing by without spawning')
            standbyObservation = receiptObservation
          }
          await waitInterruptibly(25)
          continue
        }
      }
      if (standbyObservation) {
        appendLauncherLog('adopted job runner exited; automatic recovery will start a replacement')
        standbyObservation = ''
      }
      let logDescriptor: number | undefined
      const startedAt = Date.now()
      let launchIntent: PreparedRunnerLaunchReceipt | undefined
      daemon = undefined
      daemonIdentity = undefined
      daemonReceipt = undefined
      try {
        logDescriptor = openSafeLog(logPath, 'append')
        const launcherIdentity = readProcessIdentity(process.pid)
        if (!launcherIdentity) throw new Error('runner launcher generation could not be pinned')
        launchIntent = prepareRunnerLaunchReceipt(stateDir, launcherIdentity)
        daemon = Bun.spawn([
          '/bin/bash', '--noprofile', '--norc', '-c', RUNNER_BOOTSTRAP,
          'zerokun-runner-bootstrap', process.execPath, RECEIPT_HELPER, stateDir, runner,
        ], {
          stdin: 'ignore',
          stdout: logDescriptor,
          stderr: logDescriptor,
          // A dedicated group lets this parent terminate the complete pre-lock
          // startup generation without signalling the Herdr pane or gateway shell.
          detached: process.platform !== 'win32',
          env: {
            ...process.env,
            ZEROKUN_RUNNER_LAUNCH_INTENT: launchIntent.intentId,
            // Only the daemon-lock winner may publish this identity to shared state.
            // Passing the non-secret identity through the child environment avoids
            // a losing concurrent launcher overwriting the live daemon's pin.
            ZEROKUN_LAUNCH_HERDR_RUNTIME: encodeHerdrRuntimeIdentity(herdrRuntime),
          },
        })
        daemonIdentity = readProcessIdentity(daemon.pid)
        if (!daemonIdentity) {
          throw new Error('job runner startup generation could not be pinned')
        }
        if (process.platform !== 'win32' && daemonIdentity.pgid !== daemonIdentity.pid) {
          daemonIdentity = await acquireProcessGroupLeaderIdentity(daemon.pid)
        }
        if (!daemonIdentity || (process.platform !== 'win32'
          && daemonIdentity.pgid !== daemonIdentity.pid)) {
          throw new Error('job runner startup process group could not be pinned')
        }
        daemonReceipt = publishRunnerLaunchReceipt(
          stateDir,
          launchIntent.intentId,
          daemonIdentity,
        )
      } catch (error) {
        if (daemon) {
          await reapFailedStartup(daemon, daemonIdentity)
        }
        if (launchIntent) {
          const receipt = readRunnerLaunchReceipt(stateDir)
          if (receipt?.intentId === launchIntent.intentId) {
            if (daemonIdentity) {
              clearRunnerLaunchReceiptAfterReap(stateDir, receipt, daemonIdentity)
            } else if (!daemon) {
              clearUnspawnedRunnerLaunchIntent(stateDir, launchIntent)
            }
          }
        }
        daemon = undefined
        daemonIdentity = undefined
        daemonReceipt = undefined
        if (shutdownStarted) break
        appendLauncherLog(
          `job runner startup failed; automatic recovery will retry: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      } finally {
        if (logDescriptor !== undefined) closeSync(logDescriptor)
      }

      if (daemonIdentity && daemon) {
        if (!firstPidPublished) {
          process.stdout.write(`${daemon.pid}\n`)
          firstPidPublished = true
        }
        const exitCode = await daemon.exited.catch(() => 1)
        const reapedIdentity = daemonIdentity
        const receipt = daemonReceipt ?? readRunnerLaunchReceipt(stateDir)
        if (receipt && launchIntent && receipt.intentId === launchIntent.intentId) {
          clearRunnerLaunchReceiptAfterReap(stateDir, receipt, reapedIdentity)
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer)
          forceKillTimer = undefined
        }
        daemon = undefined
        daemonIdentity = undefined
        daemonReceipt = undefined
        if (shutdownStarted) {
          process.exitCode = exitCode
          break
        }
        if (Date.now() - startedAt >= HEALTHY_RUN_MS) restartAttempt = 0
        appendLauncherLog(
          `job runner exited unexpectedly (code ${exitCode}); automatic recovery will retry`,
        )
      }

      const delayMs = RESTART_BACKOFF_MS[
        Math.min(restartAttempt, RESTART_BACKOFF_MS.length - 1)
      ]!
      restartAttempt += 1
      await waitInterruptibly(delayMs)
    }
  } finally {
    if (forceKillTimer) clearTimeout(forceKillTimer)
    process.off('SIGINT', stopInt)
    process.off('SIGTERM', stopTerm)
  }
} finally {
  if (!releaseProcessLock(canonicalStarterLock, starterLease)) {
    throw new Error(`runner launcher could not release ${canonicalStarterLock}`)
  }
}
