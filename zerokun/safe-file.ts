import { randomUUID } from 'crypto'
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync,
  lstatSync, readSync, renameSync, unlinkSync, writeFileSync,
} from 'fs'
import { dirname } from 'path'

const ATOMIC_OWNED_READ_ATTEMPTS = 4

function requireSafeDescriptor(descriptor: number, path: string): void {
  const metadata = fstatSync(descriptor)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches) {
    throw new Error(`unsafe managed file: ${path}`)
  }
}

/**
 * Prove that an already-open descriptor still names the file currently
 * reachable at `path`. Atomic rename keeps the old descriptor readable, so a
 * same-FD before/after fstat alone cannot detect a pathname replacement.
 */
export function assertDescriptorStillNamesPath(descriptor: number, path: string): void {
  const descriptorMetadata = fstatSync(descriptor)
  const pathMetadata = lstatSync(path)
  const ownerMatches = typeof process.getuid !== 'function'
    || pathMetadata.uid === process.getuid()
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()
    || pathMetadata.nlink !== 1 || !ownerMatches
    || pathMetadata.dev !== descriptorMetadata.dev
    || pathMetadata.ino !== descriptorMetadata.ino
    || pathMetadata.mode !== descriptorMetadata.mode
    || pathMetadata.uid !== descriptorMetadata.uid
    || pathMetadata.gid !== descriptorMetadata.gid
    || pathMetadata.nlink !== descriptorMetadata.nlink
    || pathMetadata.size !== descriptorMetadata.size
    || pathMetadata.mtimeMs !== descriptorMetadata.mtimeMs
    || pathMetadata.ctimeMs !== descriptorMetadata.ctimeMs) {
    throw new Error(`managed file path changed while open: ${path}`)
  }
}

export function readOptionalPrivateFile(path: string): string | null {
  let descriptor: number
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    requireSafeDescriptor(descriptor, path)
    fchmodSync(descriptor, 0o600)
    const content = readFileSync(descriptor, 'utf8')
    assertDescriptorStillNamesPath(descriptor, path)
    return content
  } finally {
    closeSync(descriptor)
  }
}

function readOptionalOwnedFile(
  path: string,
  requireOwnerOnly: boolean,
  maxBytes?: number,
): string | null {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error(`invalid managed file size bound: ${path}`)
  }
  let descriptor: number
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    requireSafeDescriptor(descriptor, path)
    const metadata = fstatSync(descriptor)
    if (requireOwnerOnly && (metadata.mode & 0o077) !== 0) {
      throw new Error(`managed file is not owner-only: ${path}`)
    }
    if (maxBytes === undefined) {
      const content = readFileSync(descriptor, 'utf8')
      assertDescriptorStillNamesPath(descriptor, path)
      return content
    }
    if (metadata.size > maxBytes) throw new Error(`managed file exceeds size bound: ${path}`)
    const content = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, null)
      if (count === 0) break
      offset += count
    }
    if (offset > maxBytes) throw new Error(`managed file exceeds size bound: ${path}`)
    const result = content.subarray(0, offset).toString('utf8')
    assertDescriptorStillNamesPath(descriptor, path)
    return result
  } finally {
    closeSync(descriptor)
  }
}

/** Read an owner-owned, single-link regular file without changing its mode. */
export function readOptionalOwnedRegularFile(path: string): string | null {
  return readOptionalOwnedFile(path, false)
}

/** Read an owner-only, single-link regular file without changing its mode. */
export function readOptionalOwnerOnlyRegularFile(path: string): string | null {
  return readOptionalOwnedFile(path, true)
}

/** Read a bounded owner-only, single-link regular file without changing its mode. */
export function readOptionalBoundedOwnerOnlyRegularFile(
  path: string,
  maxBytes: number,
): string | null {
  return readOptionalOwnedFile(path, true, maxBytes)
}

/**
 * Read a bounded owner-owned file that is published with atomic rename.
 *
 * If rename wins after open but before fstat, the opened old inode is a
 * regular, owner-owned file with nlink=0. That is an expected detached
 * snapshot, not a hardlink. Close it without consuming the bytes and reopen
 * the current pathname a bounded number of times. Every other safety failure
 * remains fail-closed.
 */
export function readOptionalBoundedAtomicOwnedFile(
  path: string,
  maxBytes: number,
  label = 'atomic managed file',
): Buffer | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`invalid ${label} size bound: ${path}`)
  }
  for (let attempt = 0; attempt < ATOMIC_OWNED_READ_ATTEMPTS; attempt += 1) {
    let descriptor: number
    try {
      descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const metadata = fstatSync(descriptor)
      const ownerMatches = typeof process.getuid !== 'function'
        || metadata.uid === process.getuid()
      if (!metadata.isFile() || !ownerMatches || metadata.size > maxBytes) {
        throw new Error(`unsafe ${label}: ${path}`)
      }
      if (metadata.nlink === 0) continue
      if (metadata.nlink !== 1) throw new Error(`unsafe ${label}: ${path}`)
      const bytes = Buffer.alloc(metadata.size)
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
        if (count === 0) throw new Error(`${label} changed while reading: ${path}`)
        offset += count
      }
      return bytes
    } finally {
      closeSync(descriptor)
    }
  }
  throw new Error(`${label} was repeatedly replaced while reading: ${path}`)
}

export function openSafeLog(path: string, mode: 'truncate' | 'append'): number {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
      | (mode === 'append' ? constants.O_APPEND : 0),
    0o600,
  )
  try {
    requireSafeDescriptor(descriptor, path)
    fchmodSync(descriptor, 0o600)
    if (mode === 'truncate') ftruncateSync(descriptor, 0)
    return descriptor
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

export function atomicWritePrivateFile(path: string, content: string | Uint8Array): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  let temporaryDescriptor: number | undefined
  let parentDescriptor: number | undefined
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' })
    temporaryDescriptor = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW)
    requireSafeDescriptor(temporaryDescriptor, temporary)
    fsyncSync(temporaryDescriptor)
    closeSync(temporaryDescriptor)
    temporaryDescriptor = undefined
    renameSync(temporary, path)
    // Persist the rename as well as the file contents. Queue boundary files
    // use this writer as an external-side-effect journal, so a process or
    // machine crash must not roll a durable external-cleanup intent backward.
    parentDescriptor = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW)
    const parent = fstatSync(parentDescriptor)
    const ownerMatches = typeof process.getuid !== 'function' || parent.uid === process.getuid()
    if (!parent.isDirectory() || !ownerMatches) {
      throw new Error(`unsafe managed directory: ${dirname(path)}`)
    }
    fsyncSync(parentDescriptor)
  } finally {
    if (temporaryDescriptor !== undefined) {
      try { closeSync(temporaryDescriptor) } catch {}
    }
    if (parentDescriptor !== undefined) {
      try { closeSync(parentDescriptor) } catch {}
    }
    try { unlinkSync(temporary) } catch {}
  }
}

if (import.meta.main) {
  const [command, ...paths] = process.argv.slice(2)
  if ((command === 'validate-existing' && paths.length === 0)
    || (command === 'validate-owned-regular' && paths.length === 0)
    || (command === 'read-owned-regular' && paths.length !== 1)
    || (command === 'atomic-write-private' && paths.length !== 1)
    || !['validate-existing', 'validate-owned-regular', 'read-owned-regular',
      'atomic-write-private'].includes(command)) {
    process.stderr.write(
      'usage: safe-file.ts validate-existing <path>... | validate-owned-regular <path>... '
      + '| read-owned-regular <path> | atomic-write-private <path>\n',
    )
    process.exit(2)
  }
  try {
    if (command === 'validate-existing') {
      for (const path of paths) readOptionalPrivateFile(path)
    } else if (command === 'validate-owned-regular') {
      for (const path of paths) readOptionalOwnedRegularFile(path)
    } else if (command === 'read-owned-regular') {
      const content = readOptionalOwnedRegularFile(paths[0])
      if (content === null) throw new Error(`managed file does not exist: ${paths[0]}`)
      process.stdout.write(content)
    } else {
      atomicWritePrivateFile(paths[0], await Bun.stdin.text())
    }
  } catch (error) {
    process.stderr.write(`unsafe managed file: ${error}\n`)
    process.exit(1)
  }
}
