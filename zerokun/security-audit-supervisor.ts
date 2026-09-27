#!/usr/bin/env -S bun --config=/dev/null --no-env-file
/** Keep a live group leader and durable process identities until scanner descendants exit. */
import { dirname } from 'path'
import { lstatSync } from 'fs'
import { atomicWritePrivateFile } from './safe-file.ts'
import {
  captureTrackedProcesses,
  reapTrackedProcesses,
  seedTrackedProcess,
  synchronizeTrackedProcessLedger,
} from './process-tree.ts'
import {
  readProcessIdentity,
  signalProcessIfLive,
} from './process-generation.ts'

async function main() {
  const [jobId, path, ...command] = process.argv.slice(2)
  if (!jobId || !path || !command.length)
    throw Error('scanner supervisor arguments missing')
  const parent = lstatSync(dirname(path))
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  )
    throw Error('unsafe scanner registration')
  const tracked = new Map<number, string>(),
    ledger = new Map<string, { pid: number; started: string }>()
  const self = seedTrackedProcess(process.pid, tracked)
  if (self.pgid !== self.pid)
    throw Error('scanner supervisor requires own process group')
  let revision = 0,
    stopping = false,
    phase = 'active',
    child: Bun.Subprocess | undefined
  const persist = () => {
    synchronizeTrackedProcessLedger(tracked, ledger)
    atomicWritePrivateFile(
      path,
      JSON.stringify({
        version: 3,
        jobId,
        pid: self.pid,
        pgid: self.pgid,
        started: self.started,
        bootSession: self.bootSession,
        startSec: self.startSec,
        startUsec: self.startUsec,
        phase,
        revision: revision++,
        tracked: [...ledger.values()],
      }),
    )
  }
  const capture = () => {
    captureTrackedProcesses([self.pid], self.pgid, tracked)
    persist()
  }
  const stop = () => {
    stopping = true
    if (child) {
      const identity = readProcessIdentity(child.pid)
      if (identity && tracked.get(child.pid) === identity.started)
        signalProcessIfLive(identity, 'SIGTERM')
    }
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.on('SIGHUP', stop)
  persist()
  const originalParent = process.ppid
  child = Bun.spawn(command, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  })
  if (readProcessIdentity(child.pid)) seedTrackedProcess(child.pid, tracked)
  capture()
  const interval = setInterval(() => {
    try {
      capture()
      if (process.ppid !== originalParent) stop()
    } catch {
      stop()
    }
  }, 100)
  let stoppedAt: number | undefined
  const forcePoll = setInterval(() => {
    if (!stopping) return
    stoppedAt ??= Date.now()
    if (Date.now() - stoppedAt < 1500) return
    for (const [pid, started] of tracked) {
      if (pid === self.pid) continue
      const identity = readProcessIdentity(pid)
      if (identity?.started === started)
        signalProcessIfLive(identity, 'SIGKILL')
    }
  }, 100)
  try {
    const code = await child.exited
    clearInterval(interval)
    clearInterval(forcePoll)
    capture()
    const remaining = await reapTrackedProcesses({
      rootPids: [self.pid],
      groupId: self.pgid,
      tracked,
      excludePids: new Set([self.pid]),
      termGraceMs: 500,
      killWaitMs: 3000,
      signalGroup: false,
    })
    if (remaining.length) throw Error('scanner descendant cleanup pending')
    phase = 'cleanup-confirmed'
    persist()
    process.exitCode = stopping ? 130 : code
  } finally {
    clearInterval(interval)
    clearInterval(forcePoll)
  }
}
if (import.meta.main)
  main().catch(() => {
    process.stderr.write('scanner supervision/cleanup failed\n')
    process.exitCode = 86
  })
