#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { createConnection, type Socket } from 'net'
import { dirname, isAbsolute, join } from 'path'
import { lstatSync, realpathSync } from 'fs'
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { verifyClaudeExecutable } from './claude-executable.ts'
import { acquireProcessGroupLeaderIdentity, observeProcessGeneration, readProcessIdentity,
  signalProcessIfLive, type ProcessIdentity } from './process-generation.ts'
import { ClaudePaneFrames, type ClaudePaneManifest, type ClaudePanePacket } from './claude-pane-protocol.ts'

export function readClaudePaneManifest(path: string): ClaudePaneManifest {
  const parent = lstatSync(dirname(path))
  if (!isAbsolute(path) || !parent.isDirectory() || parent.isSymbolicLink()
    || (parent.mode & 0o077) || parent.uid !== process.getuid?.()) throw new Error('unsafe Claude pane directory')
  const text = readOptionalBoundedOwnerOnlyRegularFile(path, 256 * 1024)
  if (!text) throw new Error('missing Claude pane manifest')
  const value = JSON.parse(text) as ClaudePaneManifest
  if (value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.nonce)
    || typeof value.jobId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value.jobId)
    || typeof value.cwd !== 'string' || !isAbsolute(value.cwd) || realpathSync(value.cwd) !== value.cwd
    || typeof value.socketPath !== 'string' || !isAbsolute(value.socketPath)
    || dirname(value.socketPath) !== dirname(path)
    || typeof value.registrationPath !== 'string' || !isAbsolute(value.registrationPath)
    || (value.fingerprint !== undefined && (typeof value.fingerprint?.allow !== 'string'
      || !isAbsolute(value.fingerprint.allow) || typeof value.fingerprint.deny !== 'string' || !isAbsolute(value.fingerprint.deny)))
    || !Array.isArray(value.arguments) || value.arguments.length > 128
    || value.arguments.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 65_536)
    || !value.environment || typeof value.environment !== 'object' || Array.isArray(value.environment)
    || Object.entries(value.environment).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      || typeof item !== 'string' || item.includes('\0') || item.length > 65_536)) {
    throw new Error('invalid Claude pane manifest')
  }
  verifyClaudeExecutable(value.executable)
  return value
}

function write(socket: Socket, packet: ClaudePanePacket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) { reject(new Error('Claude host disconnected')); return }
    socket.write(JSON.stringify(packet) + '\n', error => error ? reject(error) : resolve())
  })
}

/** The visible pane owns this bridge; the detached supervisor owns Claude and
 * its descendants. Reuse the same durable recovery ledger as Codex. */
export async function runClaudePane(path: string): Promise<number> {
  const manifest = readClaudePaneManifest(path)
  const identity = readProcessIdentity(process.pid)
  if (!identity) throw new Error('Claude pane process identity unavailable')
  const socket = createConnection(manifest.socketPath)
  socket.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve); socket.once('error', reject)
  })
  let child: ReturnType<typeof spawn> | undefined
  let childIdentity: ProcessIdentity | undefined
  let started = false, stopping = false, failed = false, completed = false
  let endInput = false
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let resolveDone!: (code: number) => void
  const done = new Promise<number>(resolve => { resolveDone = resolve })
  const stop = () => {
    if (completed) return
    stopping = true
    if (!child) { if (!started) resolveDone(1); return }
    try { child.stdin.end() } catch {}
    if (childIdentity) signalProcessIfLive(childIdentity, 'SIGTERM')
    else child.kill('SIGTERM') // still the exact newly spawned process handle
    stopTimer ??= setTimeout(() => {
      // The supervisor retains cleanup ownership; do not kill it while it is
      // reaping descendants. The host's recovery path can retire its ledger.
      if (childIdentity && observeProcessGeneration(childIdentity).status === 'alive') {
        process.stderr.write('Claudeの終了処理を継続しています。\n')
      }
    }, 15_000)
  }
  const spawn = () => Bun.spawn([
    process.execPath, '--config=/dev/null', '--no-env-file', join(import.meta.dir, 'codex-supervisor.ts'),
    manifest.jobId, manifest.registrationPath,
    ...(manifest.fingerprint ? ['--seatbelt-fingerprint', manifest.fingerprint.allow, manifest.fingerprint.deny] : []),
    '--claude-executable-snapshot',
    Buffer.from(JSON.stringify(manifest.executable)).toString('base64url'), '--',
    manifest.executable.physical, ...manifest.arguments,
  ], { cwd: manifest.cwd, env: manifest.environment, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true })
  const relay = async (stream: ReadableStream<Uint8Array>, type: 'stdout' | 'stderr') => {
    const reader = stream.getReader()
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) return
        if (!socket.destroyed) {
          try { await write(socket, { type, data: Buffer.from(next.value).toString('base64') }) }
          catch { stop() }
        }
      }
    } finally { reader.releaseLock() }
  }
  const start = async () => {
    try {
      verifyClaudeExecutable(manifest.executable)
      child = spawn()
      childIdentity = await acquireProcessGroupLeaderIdentity(child.pid)
      if (!childIdentity) throw new Error('Claude supervisor identity unavailable')
      if (stopping) stop()
      else await write(socket, { type: 'ready', identity: childIdentity })
      process.stdout.write('Claude Code主担当の実行を開始しました。\n')
      const streams = Promise.all([relay(child.stdout, 'stdout'), relay(child.stderr, 'stderr')])
      const code = await child.exited
      await streams
      if (stopTimer) clearTimeout(stopTimer)
      if (!socket.destroyed) await write(socket, { type: 'exit', code })
      resolveDone(code)
    } catch {
      failed = true
      stop()
      if (child) await child.exited
      if (!socket.destroyed) await write(socket, { type: 'failure', message: 'Claude pane startup or transport failed' }).catch(() => {})
      resolveDone(1)
    }
  }
  const frames = new ClaudePaneFrames(packet => {
    switch (packet.type) {
      case 'start':
        if (started || stopping) throw new Error('duplicate Claude pane start')
        started = true; void start(); break
      case 'input':
        if (!child || !childIdentity || endInput || stopping || typeof packet.data !== 'string') {
          throw new Error('Claude pane input before readiness or after close')
        }
        child.stdin.write(packet.data); break
      case 'end-input':
        if (!child || endInput) throw new Error('invalid Claude input close')
        endInput = true; child.stdin.end(); break
      case 'stop': stop(); break
      default: throw new Error('unexpected Claude pane packet')
    }
  })
  socket.on('data', chunk => {
    try { frames.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk) }
    catch { failed = true; socket.destroy(); stop() }
  })
  socket.once('close', () => {
    try { frames.finish() } catch { failed = true }
    stop()
  })
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop)
  await write(socket, { type: 'hello', nonce: manifest.nonce, identity })
  const code = await done
  completed = true
  if (stopTimer) clearTimeout(stopTimer)
  socket.end()
  process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('SIGHUP', stop)
  process.stdout.write('Claude Code主担当の実行を終了しました。\n')
  return failed ? 1 : code
}

if (import.meta.main) {
  try { process.exitCode = await runClaudePane(process.argv[2] ?? '') }
  catch { process.stderr.write('Claude Code主担当を起動できませんでした。\n'); process.exitCode = 1 }
}
