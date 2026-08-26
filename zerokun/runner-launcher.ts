#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { closeSync, lstatSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, join } from 'path'
import { requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { releaseProcessLock, tryAcquireProcessLock } from './process-lock.ts'
import {
  observeProcessGeneration,
  readProcessIdentity,
  signalProcessGroupIfLeaderLive,
  signalProcessIfLive,
  type ProcessIdentity,
} from './process-generation.ts'
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

try {
  // Keep the launcher and runner in the Herdr pane's process tree. Acquire the
  // exact launcher lease before any potentially slow Herdr probe so the shell
  // can always cancel this precise startup attempt.
  const herdrRuntime = requireHerdrRuntime()
  // Open the managed log before spawning so the child never evaluates a shell
  // redirection and never follows a user-controlled log symlink.
  const logDescriptor = openSafeLog(logPath, 'append')
  let daemon: ReturnType<typeof Bun.spawn> | undefined
  let daemonIdentity: ProcessIdentity | undefined
  try {
    daemon = Bun.spawn([
      process.execPath, '--config=/dev/null', '--no-env-file', runner, 'daemon',
    ], {
      stdin: 'ignore',
      stdout: logDescriptor,
      stderr: logDescriptor,
      // A dedicated group lets this parent terminate the complete pre-lock
      // startup generation without signalling the Herdr pane or gateway shell.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        // Only the daemon-lock winner may publish this identity to shared state.
        // Passing the non-secret identity through the child environment avoids
        // a losing concurrent launcher overwriting the live daemon's pin.
        ZEROKUN_LAUNCH_HERDR_RUNTIME: encodeHerdrRuntimeIdentity(herdrRuntime),
      },
    })
    daemonIdentity = readProcessIdentity(daemon.pid)
    if (!daemonIdentity || (process.platform !== 'win32'
      && daemonIdentity.pgid !== daemonIdentity.pid)) {
      throw new Error('job runner startup generation could not be pinned')
    }
  } catch (error) {
    if (daemonIdentity) {
      if (process.platform !== 'win32') {
        signalProcessGroupIfLeaderLive(daemonIdentity, 'SIGKILL')
      } else {
        signalProcessIfLive(daemonIdentity, 'SIGKILL')
      }
    } else if (daemon) {
      try { daemon.kill('SIGKILL') } catch {}
      await Promise.race([daemon.exited.catch(() => 1), Bun.sleep(1_000)])
    }
    throw error
  } finally {
    closeSync(logDescriptor)
  }

  process.stdout.write(`${daemon.pid}\n`)
  let shutdownStarted = false
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined
  const stop = (signal: NodeJS.Signals) => {
    if (shutdownStarted) return
    shutdownStarted = true
    if (process.platform !== 'win32') {
      signalProcessGroupIfLeaderLive(daemonIdentity!, signal)
    } else {
      signalProcessIfLive(daemonIdentity!, signal)
    }
    forceKillTimer = setTimeout(() => {
      if (observeProcessGeneration(daemonIdentity!).status !== 'alive') return
      if (process.platform !== 'win32') {
        signalProcessGroupIfLeaderLive(daemonIdentity!, 'SIGKILL')
      } else {
        signalProcessIfLive(daemonIdentity!, 'SIGKILL')
      }
    }, 3_000)
  }
  const stopInt = () => stop('SIGINT')
  const stopTerm = () => stop('SIGTERM')
  process.on('SIGINT', stopInt)
  process.on('SIGTERM', stopTerm)
  const exitCode = await daemon.exited
  if (forceKillTimer) clearTimeout(forceKillTimer)
  process.off('SIGINT', stopInt)
  process.off('SIGTERM', stopTerm)
  process.exitCode = exitCode
} finally {
  if (!releaseProcessLock(canonicalStarterLock, starterLease)) {
    throw new Error(`runner launcher could not release ${canonicalStarterLock}`)
  }
}
