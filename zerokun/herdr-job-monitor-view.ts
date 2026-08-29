#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'fs'
import { join } from 'path'
import { readProcessIdentity } from './process-generation.ts'
import { atomicWritePrivateFile, readOptionalBoundedAtomicOwnedFile } from './safe-file.ts'
import {
  HERDR_MONITOR_READY_TEXT,
  stripTerminalControls,
} from './herdr-job-monitor.ts'

const MAX_STATE_FILE_BYTES = 64 * 1024
const MAX_READ_BYTES = 256 * 1024
const FEED_KINDS = ['status', 'stdout', 'stderr'] as const

type Manifest = {
  version: 1
  jobId: string
  seq: number
  operationId: string
  phase: string
}

type Epoch = {
  version: 1
  generation: number
  rotating: boolean
  sealed: boolean
  droppedBytes: number
}

function readOwned(path: string, maxBytes = MAX_STATE_FILE_BYTES): Buffer | null {
  return readOptionalBoundedAtomicOwnedFile(path, maxBytes, 'monitor file')
}

function readManifest(directory: string): Manifest {
  const raw = readOwned(join(directory, 'manifest.json'))
  if (!raw) throw new Error('monitor manifest is missing')
  const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  if (value.version !== 1
    || typeof value.jobId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.jobId)
    || !Number.isSafeInteger(value.seq) || Number(value.seq) < 1
    || typeof value.operationId !== 'string' || !/^[0-9a-f]{32}$/.test(value.operationId)
    || typeof value.phase !== 'string') {
    throw new Error('monitor manifest is invalid')
  }
  return value as unknown as Manifest
}

function readEpoch(directory: string, kind: typeof FEED_KINDS[number]): Epoch {
  const raw = readOwned(join(directory, `${kind}.epoch.json`))
  if (!raw) throw new Error(`monitor ${kind} epoch is missing`)
  const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  if (value.version !== 1 || !Number.isSafeInteger(value.generation)
    || Number(value.generation) < 0 || typeof value.rotating !== 'boolean'
    || typeof value.sealed !== 'boolean'
    || !Number.isSafeInteger(value.droppedBytes) || Number(value.droppedBytes) < 0) {
    throw new Error(`monitor ${kind} epoch is invalid`)
  }
  return value as unknown as Epoch
}

function readFeedChunk(path: string, offset: number): {
  bytes: Buffer
  nextOffset: number
  size: number
} {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches) {
      throw new Error(`unsafe monitor feed: ${path}`)
    }
    const start = Math.min(offset, metadata.size)
    const length = Math.min(MAX_READ_BYTES, metadata.size - start)
    const bytes = Buffer.alloc(length)
    let count = 0
    if (length > 0) count = readSync(descriptor, bytes, 0, length, start)
    return { bytes: bytes.subarray(0, count), nextOffset: start + count, size: metadata.size }
  } finally { closeSync(descriptor) }
}

function writeTerminal(stream: NodeJS.WriteStream, value: string): Promise<void> {
  if (!value) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    stream.write(value, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function main(): Promise<void> {
  const lexicalDirectory = process.cwd()
  const metadata = lstatSync(lexicalDirectory)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownerMatches
    || (metadata.mode & 0o077) !== 0 || realpathSync(lexicalDirectory) !== lexicalDirectory) {
    throw new Error('monitor working directory is unsafe')
  }
  const manifest = readManifest(lexicalDirectory)
  if (!['run-intent', 'active'].includes(manifest.phase)) {
    throw new Error('monitor was started outside its run intent')
  }
  const identity = readProcessIdentity(process.pid)
  if (!identity) throw new Error('monitor process generation is unavailable')
  atomicWritePrivateFile(join(lexicalDirectory, 'ready.json'), `${JSON.stringify({
    version: 1,
    jobId: manifest.jobId,
    operationId: manifest.operationId,
    process: identity,
  })}\n`)
  // Herdr runs the viewer through the pane's interactive shell, which echoes
  // the launch command and prompt before this process starts. Clear both the
  // visible screen and scrollback before presenting the user-safe timeline so
  // command paths and the managed monitor directory never remain visible.
  await writeTerminal(process.stdout, '\x1b[3J\x1b[2J\x1b[H')
  await writeTerminal(process.stdout, `Zeroちゃん / キュー #${manifest.seq}\n`)
  await writeTerminal(process.stdout, `[Zeroちゃん] ${HERDR_MONITOR_READY_TEXT}\n`)

  const states = new Map<typeof FEED_KINDS[number], {
    generation: number
    offset: number
  }>()
  for (const kind of FEED_KINDS) {
    states.set(kind, { generation: -1, offset: 0 })
  }
  let lastProgressAt = 0
  while (true) {
    let wrote = false
    let progressed = false
    let allSealedAndDrained = true
    for (const kind of FEED_KINDS) {
      const epoch = readEpoch(lexicalDirectory, kind)
      if (epoch.rotating) {
        allSealedAndDrained = false
        continue
      }
      const state = states.get(kind)!
      if (state.generation !== epoch.generation) {
        if (state.generation >= 0) {
          await writeTerminal(
            process.stdout,
            `[Zeroちゃん] ${kind} の古い表示を省略しました（累計 ${epoch.droppedBytes} bytes）\n`,
          )
        }
        state.generation = epoch.generation
        state.offset = 0
        progressed = true
      }
      const chunk = readFeedChunk(
        join(lexicalDirectory, `${kind}.${epoch.generation}.feed`),
        state.offset,
      )
      if (chunk.bytes.length === 0) {
        if (!epoch.sealed || state.offset !== chunk.size) allSealedAndDrained = false
        continue
      }
      // ACK only a complete UTF-8 prefix. TextDecoder's streaming API hides
      // trailing carry bytes, so advancing to chunk.nextOffset would claim
      // bytes that have not reached the terminal and allow rotation to drop
      // them. Re-read the bounded suffix after its continuation arrives.
      const completeLength = epoch.sealed
        ? chunk.bytes.byteLength
        : completeUtf8PrefixLength(chunk.bytes)
      if (completeLength === 0) {
        allSealedAndDrained = false
        continue
      }
      const text = stripTerminalControls(
        new TextDecoder().decode(chunk.bytes.subarray(0, completeLength)),
      )
      await writeTerminal(kind === 'stderr' ? process.stderr : process.stdout, text)
      state.offset += completeLength
      progressed = true
      if (text) wrote = true
      if (!epoch.sealed || state.offset !== chunk.size) {
        allSealedAndDrained = false
      }
    }
    const now = Date.now()
    if ((progressed || now - lastProgressAt >= 1_000)
      && FEED_KINDS.every(kind => states.get(kind)!.generation >= 0)) {
      const streams = Object.fromEntries(FEED_KINDS.map(kind => {
        const state = states.get(kind)!
        return [kind, { generation: state.generation, offset: state.offset }]
      }))
      atomicWritePrivateFile(join(lexicalDirectory, 'progress.json'), `${JSON.stringify({
        version: 1,
        jobId: manifest.jobId,
        operationId: manifest.operationId,
        process: identity,
        streams,
        updatedAt: now,
      })}\n`)
      lastProgressAt = now
    }
    if (allSealedAndDrained
      && FEED_KINDS.every(kind => states.get(kind)!.generation >= 0)) {
      // Keep the exact viewer generation alive so the retained tab cannot
      // fall back to an interactive shell, but stop polling and heartbeat
      // writes once every sealed byte is on screen.
      while (true) await Bun.sleep(60_000)
    }
    await Bun.sleep(wrote ? 20 : 100)
  }
}

export function completeUtf8PrefixLength(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0
  let lead = bytes.byteLength - 1
  let continuationCount = 0
  while (lead >= 0 && continuationCount < 3 && (bytes[lead]! & 0xc0) === 0x80) {
    continuationCount += 1
    lead -= 1
  }
  if (lead < 0) return bytes.byteLength
  const first = bytes[lead]!
  let expected = 1
  if (first >= 0xc2 && first <= 0xdf) expected = 2
  else if (first >= 0xe0 && first <= 0xef) expected = 3
  else if (first >= 0xf0 && first <= 0xf4) expected = 4
  else return bytes.byteLength
  const available = bytes.byteLength - lead
  return available < expected ? lead : bytes.byteLength
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write('[Zeroちゃん] 監視表示を継続できません\n')
    process.exitCode = 1
  })
}
