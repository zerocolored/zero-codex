#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'fs'
import type { Stats } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  reviewerConfig,
  reviewerRequirements,
  reviewerSandbox,
} from './install-grok-reviewer.ts'
import { resolveCodexExecutableDetails } from './standalone-codex.ts'

export const DEDICATED_GROK_RELATIVE_PATH = '.grok-reviewer/bin/grok' as const

function sameMetadata(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function readTrustedFile(path: string, options: { executable?: boolean; private?: boolean } = {}): Buffer {
  const before = lstatSync(path)
  const owned = typeof process.getuid !== 'function' || before.uid === process.getuid()
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !owned
    || (before.mode & 0o022) !== 0 || before.size <= 0 || before.size > 1024 * 1024
    || (before.mode & 0o400) === 0
    || (options.executable && (before.mode & 0o100) === 0)
    || (options.private && (before.mode & 0o077) !== 0)) {
    throw new Error(`unsafe dedicated Grok reviewer file: ${path}`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor)
    const content = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    if (!sameMetadata(before, opened) || !sameMetadata(opened, after)
      || content.length !== before.size) {
      throw new Error(`dedicated Grok reviewer file changed during verification: ${path}`)
    }
    return content
  } finally {
    closeSync(descriptor)
  }
}

function requirePrivateDirectory(path: string): void {
  const metadata = lstatSync(path)
  const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned
    || (metadata.mode & 0o077) !== 0) {
    throw new Error(`unsafe dedicated Grok reviewer directory: ${path}`)
  }
}

function requireExactFile(path: string, expected: Buffer, options: { executable?: boolean; private?: boolean } = {}): void {
  if (!readTrustedFile(path, options).equals(expected)) {
    throw new Error(`dedicated Grok reviewer integrity mismatch: ${path}`)
  }
}

/**
 * Resolve the fixed, account-owned Grok reviewer launcher with the same
 * no-follow component and executable checks used for the Codex executable.
 * The launcher itself establishes the isolated reviewer HOME/cwd/tool policy.
 */
export function resolveDedicatedGrokLauncher(home = homedir()): string {
  const homePhysical = realpathSync(home)
  const reviewerRoot = join(homePhysical, '.grok-reviewer')
  const reviewerBin = join(reviewerRoot, 'bin')
  const requested = join(homePhysical, DEDICATED_GROK_RELATIVE_PATH)
  try {
    requirePrivateDirectory(reviewerRoot)
    requirePrivateDirectory(reviewerBin)
    const launcher = resolveCodexExecutableDetails(requested).physical
    if (launcher !== requested) throw new Error('dedicated Grok reviewer launcher must not be a symlink')
    const runtimeRequested = join(reviewerBin, 'reviewer-runtime.py')
    const runtime = resolveCodexExecutableDetails(runtimeRequested).physical
    if (runtime !== runtimeRequested) throw new Error('dedicated Grok reviewer runtime must not be a symlink')
    requireExactFile(
      launcher,
      readTrustedFile(join(import.meta.dir, 'grok-reviewer', 'grok')),
      { executable: true },
    )
    requireExactFile(
      runtime,
      readTrustedFile(join(import.meta.dir, 'grok-reviewer', 'reviewer-runtime.py')),
      { executable: true },
    )
    requireExactFile(
      join(reviewerRoot, 'config.toml'),
      Buffer.from(reviewerConfig(homePhysical)),
      { private: true },
    )
    requireExactFile(
      join(reviewerRoot, 'sandbox.toml'),
      Buffer.from(reviewerSandbox(homePhysical)),
      { private: true },
    )
    requireExactFile(
      join(reviewerRoot, 'requirements.toml'),
      Buffer.from(reviewerRequirements()),
      { private: true },
    )
    const verification = Bun.spawnSync([
      '/usr/bin/python3', '-I', runtime, 'verify-install',
      reviewerRoot,
      homePhysical,
      join(homePhysical, '.grok', 'bin', 'grok'),
      join(homePhysical, '.grok', 'auth.json'),
    ], {
      env: {
        HOME: '/var/empty',
        PATH: '/usr/bin:/bin',
        TMPDIR: '/tmp',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    if (verification.exitCode !== 0) {
      throw new Error('dedicated Grok reviewer runtime verification failed')
    }
    return launcher
  } catch {
    throw new Error(
      `専用Grok reviewerが未導入または安全ではありません: ${requested}`,
    )
  }
}

if (import.meta.main) {
  try {
    const [command] = process.argv.slice(2)
    if (command !== 'verify-grok') {
      throw new Error('usage: advisor-prerequisites.ts verify-grok')
    }
    resolveDedicatedGrokLauncher()
    process.stdout.write('dedicated Grok reviewer: ready\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
