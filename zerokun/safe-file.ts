import { randomUUID } from 'crypto'
import {
  closeSync, constants, fchmodSync, fstatSync, ftruncateSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'fs'

function requireSafeDescriptor(descriptor: number, path: string): void {
  const metadata = fstatSync(descriptor)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches) {
    throw new Error(`unsafe managed file: ${path}`)
  }
}

export function readOptionalPrivateFile(path: string): string | null {
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    requireSafeDescriptor(descriptor, path)
    fchmodSync(descriptor, 0o600)
    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

/** Read an owner-only-link regular file without changing its mode. */
export function readOptionalOwnedRegularFile(path: string): string | null {
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    requireSafeDescriptor(descriptor, path)
    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
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

export function atomicWritePrivateFile(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
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
