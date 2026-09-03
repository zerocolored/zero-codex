#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { createHash, randomUUID } from 'crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'fs'
import { basename, isAbsolute, join } from 'path'
import { ensureManagedDirectory, requireManagedStateRoot } from './managed-path.ts'

export const UPDATE_RUNTIME_FILES = [
  'update-request.ts',
  'process-generation.ts',
  'process-lock.ts',
  'child-environment.ts',
  'safe-file.ts',
  'managed-path.ts',
  'state-dir.ts',
  'slack-http.ts',
  'slack-app-identity.ts',
  'tmux-command.ts',
] as const

export type UpdateRuntimeInstallPhase = 'staged' | 'published' | 'activated'

function ownerAllowed(uid: number | bigint): boolean {
  return typeof process.getuid !== 'function'
    || uid === process.getuid() || uid === BigInt(process.getuid()) || uid === 0 || uid === 0n
}

function copyFrozenSource(
  sourcePath: string,
  destination: string,
  executable: boolean,
): string {
  let source = -1
  let target = -1
  const digest = createHash('sha256')
  try {
    source = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = fstatSync(source, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || !ownerAllowed(before.uid)
      || before.size <= 0n || before.size > 2n * 1024n * 1024n) {
      throw new Error(`unsafe update runtime source: ${sourcePath}`)
    }
    target = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      executable ? 0o700 : 0o600,
    )
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (true) {
      const size = readSync(source, buffer, 0, buffer.length, null)
      if (size === 0) break
      digest.update(buffer.subarray(0, size))
      let offset = 0
      while (offset < size) offset += writeSync(target, buffer, offset, size - offset)
    }
    const after = fstatSync(source, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mode !== before.mode
      || after.uid !== before.uid || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs) {
      throw new Error(`update runtime source changed while copying: ${sourcePath}`)
    }
    const copied = fstatSync(target)
    if (!copied.isFile() || copied.nlink !== 1 || !ownerAllowed(copied.uid)) {
      throw new Error(`unsafe update runtime copy: ${destination}`)
    }
    fchmodSync(target, executable ? 0o700 : 0o600)
    return digest.digest('hex')
  } finally {
    if (target >= 0) closeSync(target)
    if (source >= 0) closeSync(source)
  }
}

function validateExistingEntrypoint(path: string): void {
  let metadata: ReturnType<typeof lstatSync>
  try { metadata = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (metadata.isSymbolicLink()) {
    const target = readlinkSync(path)
    if (!/^update-runtime\/bundle-[0-9a-f-]+\/update-request\.ts$/i.test(target)) {
      throw new Error(`unsafe existing update runtime link: ${path}`)
    }
    return
  }
  if (!metadata.isFile() || metadata.nlink !== 1 || !ownerAllowed(metadata.uid)) {
    throw new Error(`unsafe existing update runtime entrypoint: ${path}`)
  }
}

/**
 * Publish a complete immutable runtime directory, then atomically switch the
 * stable worker entrypoint. A crash exposes either the prior bundle or the
 * fully written new bundle, never a mixed import graph.
 */
export function installUpdateRequestRuntime(
  sourceDirectory: string,
  stateDirectory: string,
  options: { onPhase?: (phase: UpdateRuntimeInstallPhase) => void } = {},
): string {
  if (!isAbsolute(sourceDirectory) || !isAbsolute(stateDirectory)) {
    throw new Error('update runtime paths must be absolute')
  }
  const source = realpathSync(sourceDirectory)
  const state = requireManagedStateRoot(stateDirectory)
  const runtimeRoot = ensureManagedDirectory(state, join(state, 'update-runtime'))
  chmodSync(runtimeRoot, 0o700)
  const runtimeMetadata = lstatSync(runtimeRoot)
  if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()
    || !ownerAllowed(runtimeMetadata.uid) || (runtimeMetadata.mode & 0o077) !== 0) {
    throw new Error(`unsafe update runtime root: ${runtimeRoot}`)
  }
  const staging = mkdtempSync(join(runtimeRoot, '.stage-'))
  chmodSync(staging, 0o700)
  const stagingMetadata = lstatSync(staging)
  if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()
    || !ownerAllowed(stagingMetadata.uid) || (stagingMetadata.mode & 0o077) !== 0) {
    throw new Error(`unsafe update runtime staging directory: ${staging}`)
  }
  const bundleName = `bundle-${randomUUID()}`
  const bundle = join(runtimeRoot, bundleName)
  const entrypoint = join(state, 'update-request.ts')
  const temporaryLink = join(state, `.update-request.${randomUUID()}.tmp`)
  let published = false
  try {
    const files: Record<string, { sha256: string; mode: string }> = {}
    for (const name of UPDATE_RUNTIME_FILES) {
      const executable = name === 'update-request.ts'
      files[name] = {
        sha256: copyFrozenSource(join(source, name), join(staging, name), executable),
        mode: executable ? '0700' : '0600',
      }
    }
    writeFileSync(
      join(staging, 'manifest.json'),
      `${JSON.stringify({ version: 1, files }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    )
    options.onPhase?.('staged')
    renameSync(staging, bundle)
    published = true
    options.onPhase?.('published')
    validateExistingEntrypoint(entrypoint)
    symlinkSync(join('update-runtime', bundleName, 'update-request.ts'), temporaryLink)
    renameSync(temporaryLink, entrypoint)
    options.onPhase?.('activated')
    return join(bundle, 'update-request.ts')
  } finally {
    try { rmSync(temporaryLink, { force: true }) } catch {}
    if (!published) {
      const currentName = basename(staging)
      if (currentName.startsWith('.stage-')) {
        try { rmSync(staging, { recursive: true, force: true }) } catch {}
      }
    }
  }
}

if (import.meta.main) {
  const [command, sourceDirectory, stateDirectory] = process.argv.slice(2)
  if (command !== 'install' || !sourceDirectory || !stateDirectory) {
    process.stderr.write('usage: update-runtime.ts install <source-directory> <state-directory>\n')
    process.exit(2)
  }
  try {
    process.stdout.write(`${installUpdateRequestRuntime(sourceDirectory, stateDirectory)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
