import { createHash } from 'crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'fs'
import { basename, dirname, join, resolve } from 'path'
import type { InboundDownloadedFile } from './job-runner.ts'

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const HASH_CHUNK_BYTES = 64 * 1024

export interface InboundAttachmentIdentity {
  dev: number
  ino: number
}

export function writeAllSync(
  descriptor: number,
  chunk: Uint8Array,
  writer: (
    descriptor: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => number = writeSync,
): void {
  let offset = 0
  while (offset < chunk.byteLength) {
    const count = writer(descriptor, chunk, offset, chunk.byteLength - offset)
    if (!Number.isSafeInteger(count) || count <= 0 || count > chunk.byteLength - offset) {
      throw new Error('inbound attachment write did not make valid progress')
    }
    offset += count
  }
}

export function verifyInboundDownloadBeforeRename(
  descriptor: number,
  received: number,
  expectedSize?: number,
): InboundAttachmentIdentity {
  if (!Number.isSafeInteger(received) || received < 0 || received > MAX_ATTACHMENT_BYTES) {
    throw new Error('inbound attachment received size is invalid')
  }
  if (expectedSize !== undefined
    && (!Number.isSafeInteger(expectedSize) || expectedSize < 0
      || expectedSize > MAX_ATTACHMENT_BYTES || received !== expectedSize)) {
    throw new Error('inbound attachment size does not match Slack metadata')
  }
  const metadata = fstatSync(descriptor)
  const owner = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.nlink !== 1 || !owner || (metadata.mode & 0o077) !== 0
    || metadata.size !== received) {
    throw new Error('inbound attachment temporary file metadata is unsafe')
  }
  return { dev: metadata.dev, ino: metadata.ino }
}

/** Remove only the exact regular inode that was atomically renamed by us. */
export function removeRenamedInboundAttachment(
  path: string,
  identity: InboundAttachmentIdentity,
): boolean {
  let metadata: ReturnType<typeof lstatSync>
  try {
    metadata = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const owner = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (metadata.dev !== identity.dev || metadata.ino !== identity.ino
    || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !owner) {
    return false
  }
  rmSync(path)
  return true
}

function safeMessageDirectory(inboxDir: string, messageTs: string): string {
  if (!/^\d+\.\d+$/.test(messageTs)) throw new Error('invalid Slack message ts')
  return resolve(join(inboxDir, messageTs.replace(/[^0-9.]/g, '_')))
}

function safeFileId(fileId: string): string {
  if (!/^F[A-Z0-9]+$/.test(fileId)) throw new Error('invalid Slack file id')
  return fileId
}

function stableFileMetadata(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function inspectCandidate(
  inboxDir: string,
  messageTs: string,
  fileId: string,
  ordinal: number,
  pathInput: string,
): InboundDownloadedFile | null {
  const directory = safeMessageDirectory(inboxDir, messageTs)
  const candidate = resolve(pathInput)
  const name = basename(candidate)
  if (dirname(candidate) !== directory
    || !name.startsWith(`${safeFileId(fileId)}.`)
    || name.includes('.partial-')) {
    throw new Error('cached inbound attachment path is outside its managed slot')
  }
  let descriptor: number
  try {
    descriptor = openSync(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('cached inbound attachment cannot be opened safely')
  }
  try {
    const before = fstatSync(descriptor)
    const owner = typeof process.getuid !== 'function' || before.uid === process.getuid()
    if (!before.isFile() || before.nlink !== 1 || !owner || before.mode & 0o077
      || before.size < 0 || before.size > MAX_ATTACHMENT_BYTES) {
      throw new Error('cached inbound attachment metadata is unsafe')
    }
    const digest = createHash('sha256')
    let total = 0
    while (total <= MAX_ATTACHMENT_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, MAX_ATTACHMENT_BYTES + 1 - total))
      const count = readSync(descriptor, chunk, 0, chunk.length, null)
      if (count === 0) break
      digest.update(chunk.subarray(0, count))
      total += count
    }
    if (total > MAX_ATTACHMENT_BYTES) throw new Error('cached inbound attachment is too large')
    const after = fstatSync(descriptor)
    if (!stableFileMetadata(before, after) || total !== before.size) {
      throw new Error('cached inbound attachment changed while reading')
    }
    const leaf = lstatSync(candidate)
    if (leaf.dev !== before.dev || leaf.ino !== before.ino || !leaf.isFile()
      || leaf.isSymbolicLink() || leaf.nlink !== 1) {
      throw new Error('cached inbound attachment changed after reading')
    }
    if (realpathSync(dirname(candidate)) !== realpathSync(directory)) {
      throw new Error('cached inbound attachment parent changed')
    }
    return {
      fileId,
      ordinal,
      path: candidate,
      size: total,
      digest: digest.digest('hex'),
    }
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Reuse an atomically completed Slack file. A durable manifest is preferred;
 * if the gateway crashed after rename but before the SQLite record, exactly
 * one deterministic file-id destination may be safely adopted.
 */
export function loadCachedInboundAttachment(options: {
  inboxDir: string
  messageTs: string
  fileId: string
  ordinal: number
  manifest?: InboundDownloadedFile
}): InboundDownloadedFile | null {
  const { inboxDir, messageTs, fileId, ordinal, manifest } = options
  if (manifest) {
    if (manifest.fileId !== fileId || manifest.ordinal !== ordinal) {
      throw new Error('cached inbound attachment manifest binding is invalid')
    }
    const inspected = inspectCandidate(inboxDir, messageTs, fileId, ordinal, manifest.path)
    if (!inspected) return null
    if (inspected.size !== manifest.size || inspected.digest !== manifest.digest) {
      throw new Error('cached inbound attachment does not match its manifest')
    }
    return inspected
  }

  const directory = safeMessageDirectory(inboxDir, messageTs)
  let names: string[]
  try {
    const metadata = lstatSync(directory)
    const owner = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    // Directory link counts are normally 2 + the number of child directories
    // on Unix, so unlike regular files they must not be constrained to one.
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1 || !owner
      || (metadata.mode & 0o077) !== 0) {
      throw new Error('cached inbound attachment directory is unsafe')
    }
    names = readdirSync(directory).filter(name => (
      name.startsWith(`${safeFileId(fileId)}.`) && !name.includes('.partial-')
    ))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (names.length === 0) return null
  if (names.length !== 1) throw new Error('cached inbound attachment adoption is ambiguous')
  return inspectCandidate(inboxDir, messageTs, fileId, ordinal, join(directory, names[0]!))
}
