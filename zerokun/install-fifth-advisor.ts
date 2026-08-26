#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { randomUUID } from 'crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'fs'
import type { Stats } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const MAX_HELPER_BYTES = 1024 * 1024

function owned(metadata: Stats): boolean {
  return typeof process.getuid !== 'function' || metadata.uid === process.getuid()
}

function ensureOwnedDirectory(path: string, ownerOnly: boolean): string {
  mkdirSync(path, { recursive: true, mode: ownerOnly ? 0o700 : 0o755 })
  let metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned(metadata)
    || (metadata.mode & 0o022) !== 0) {
    throw new Error(`unsafe fifth-advisor directory: ${path}`)
  }
  if (ownerOnly) chmodSync(path, 0o700)
  metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned(metadata)
    || (metadata.mode & (ownerOnly ? 0o077 : 0o022)) !== 0) {
    throw new Error(`fifth-advisor directory permissions are unsafe: ${path}`)
  }
  return realpathSync(path)
}

function readStableOwnedFile(path: string, expectedMode?: number): Buffer {
  const supplied = lstatSync(path)
  if (!supplied.isFile() || supplied.isSymbolicLink() || supplied.nlink !== 1
    || !owned(supplied) || (supplied.mode & 0o022) !== 0
    || supplied.size <= 0 || supplied.size > MAX_HELPER_BYTES
    || (expectedMode !== undefined && (supplied.mode & 0o777) !== expectedMode)) {
    throw new Error(`unsafe fifth-advisor file: ${path}`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor)
    const content = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    for (const key of ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const) {
      if (supplied[key] !== opened[key] || opened[key] !== after[key]) {
        throw new Error(`fifth-advisor file changed during verification: ${path}`)
      }
    }
    if (content.length !== supplied.size) {
      throw new Error(`fifth-advisor file read was incomplete: ${path}`)
    }
    return content
  } finally {
    closeSync(descriptor)
  }
}

function atomicOwnerExecutable(path: string, content: Uint8Array): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o700,
    )
    let offset = 0
    while (offset < content.length) {
      const count = writeSync(descriptor, content, offset, content.length - offset)
      if (count <= 0) throw new Error(`short fifth-advisor helper write: ${path}`)
      offset += count
    }
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || metadata.nlink !== 1 || !owned(metadata)) {
      throw new Error(`unsafe fifth-advisor helper output: ${path}`)
    }
    closeSync(descriptor)
    descriptor = undefined
    chmodSync(temporary, 0o700)
    renameSync(temporary, path)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { rmSync(temporary, { force: true }) } catch {}
    throw error
  }
}

function sourceHelper(): { content: Buffer; path: string } {
  const path = join(import.meta.dir, 'fifth-advisor.py')
  return { path, content: readStableOwnedFile(path) }
}

export function installFifthAdvisorHelper(homeInput = homedir()): string {
  const home = realpathSync(homeInput)
  const zerokunDirectory = ensureOwnedDirectory(join(home, '.zerokun'), true)
  const runtimeDirectory = ensureOwnedDirectory(join(zerokunDirectory, 'runtime'), true)
  const target = join(runtimeDirectory, 'fifth-advisor.py')
  const source = sourceHelper()
  atomicOwnerExecutable(target, source.content)
  return resolveFifthAdvisorHelper(homeInput)
}

export function resolveFifthAdvisorHelper(homeInput = homedir()): string {
  const home = realpathSync(homeInput)
  const zerokunDirectory = join(home, '.zerokun')
  const zerokunMetadata = lstatSync(zerokunDirectory)
  if (!zerokunMetadata.isDirectory() || zerokunMetadata.isSymbolicLink()
    || !owned(zerokunMetadata) || (zerokunMetadata.mode & 0o077) !== 0) {
    throw new Error(`unsafe fifth-advisor directory: ${zerokunDirectory}`)
  }
  const runtimeDirectory = join(zerokunDirectory, 'runtime')
  const runtimeMetadata = lstatSync(runtimeDirectory)
  if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()
    || !owned(runtimeMetadata) || (runtimeMetadata.mode & 0o077) !== 0) {
    throw new Error(`unsafe fifth-advisor directory: ${runtimeDirectory}`)
  }
  const installed = join(runtimeDirectory, 'fifth-advisor.py')
  const expected = sourceHelper().content
  const actual = readStableOwnedFile(installed, 0o700)
  if (!actual.equals(expected)) throw new Error(`fifth-advisor helper integrity mismatch: ${installed}`)
  return realpathSync(installed)
}

if (import.meta.main) {
  try {
    const command = process.argv[2]
    if (command === 'install') {
      process.stdout.write(`fifth-advisor helper installed: ${installFifthAdvisorHelper()}\n`)
    } else if (command === 'verify') {
      process.stdout.write(`fifth-advisor helper ready: ${resolveFifthAdvisorHelper()}\n`)
    } else {
      throw new Error('usage: install-fifth-advisor.ts install|verify')
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
