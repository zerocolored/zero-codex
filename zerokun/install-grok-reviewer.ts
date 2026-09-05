#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'fs'
import type { BigIntStats } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { resolveCodexExecutableDetails } from './standalone-codex.ts'

function ensurePrivateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  let metadata = lstatSync(path)
  const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned
    || (metadata.mode & 0o022) !== 0) {
    throw new Error(`unsafe Grok reviewer directory: ${path}`)
  }
  chmodSync(path, 0o700)
  metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (metadata.mode & 0o077) !== 0) {
    throw new Error(`could not make Grok reviewer directory private: ${path}`)
  }
  return realpathSync(path)
}

function readInstallSource(path: string): Buffer {
  const metadata = lstatSync(path)
  const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !owned
    || (metadata.mode & 0o022) !== 0 || metadata.size <= 0 || metadata.size > 1024 * 1024) {
    throw new Error(`unsafe Grok reviewer source: ${path}`)
  }
  return readFileSync(path)
}

function atomicPrivateWrite(path: string, content: Uint8Array, mode: number): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    )
    let offset = 0
    while (offset < content.length) {
      const written = writeSync(descriptor, content, offset, content.length - offset)
      if (written <= 0) throw new Error(`short Grok reviewer installer write: ${path}`)
      offset += written
    }
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`unsafe Grok reviewer installer output: ${path}`)
    }
    closeSync(descriptor)
    descriptor = undefined
    chmodSync(temporary, mode)
    renameSync(temporary, path)
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
    try {
      rmSync(temporary, { force: true })
    } catch {}
    throw error
  }
}

function toml(value: string): string {
  return JSON.stringify(value)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function renderedGrokOAuthLauncher(
  grokPhysical: string,
  homePhysical: string,
): Buffer {
  const source = readInstallSource(join(import.meta.dir, 'grok-reviewer', 'grok-login-oauth'))
    .toString('utf8')
  const replacements: Record<string, string> = {
    __GROK_REAL_BIN_SH__: shellQuote(grokPhysical),
    __PYTHON_BIN_SH__: shellQuote(realpathSync('/usr/bin/python3')),
    __USER_HOME_SH__: shellQuote(homePhysical),
  }
  let rendered = source
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, value)
  }
  if (Object.keys(replacements).some(placeholder => rendered.includes(placeholder))) {
    throw new Error('unresolved placeholder in Grok OAuth launcher')
  }
  return Buffer.from(rendered)
}

function sameBigIntMetadata(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

export function renderedGrokIdentity(grokPhysical: string): Buffer {
  const before = lstatSync(grokPhysical, { bigint: true })
  const owned = typeof process.getuid !== 'function' || before.uid === BigInt(process.getuid())
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !owned
    || (before.mode & 0o022n) !== 0n || (before.mode & 0o111n) === 0n
    || before.size <= 0n || before.size > 1024n * 1024n * 1024n) {
    throw new Error('unsafe Grok executable identity source')
  }
  const descriptor = openSync(grokPhysical, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (!sameBigIntMetadata(before, opened)) {
      throw new Error('Grok executable changed before identity hashing')
    }
    const digest = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    let offset = 0
    while (offset < Number(opened.size)) {
      const count = readSync(
        descriptor, buffer, 0, Math.min(buffer.length, Number(opened.size) - offset), offset,
      )
      if (count <= 0) throw new Error('Grok executable ended during identity hashing')
      digest.update(buffer.subarray(0, count))
      offset += count
    }
    const after = fstatSync(descriptor, { bigint: true })
    if (!sameBigIntMetadata(opened, after) || offset !== Number(opened.size)) {
      throw new Error('Grok executable changed during identity hashing')
    }
    const fields = [
      ['st_dev', opened.dev], ['st_ino', opened.ino], ['st_mode', opened.mode],
      ['st_uid', opened.uid], ['st_gid', opened.gid], ['st_nlink', opened.nlink],
      ['st_size', opened.size], ['st_mtime_ns', opened.mtimeNs], ['st_ctime_ns', opened.ctimeNs],
    ] as const
    return Buffer.from([
      '{',
      `"version":1,"path":${JSON.stringify(grokPhysical)},`,
      `"sha256":"${digest.digest('hex')}",`,
      fields.map(([name, value]) => `"${name}":${value}`).join(','),
      '}\n',
    ].join(''))
  } finally {
    closeSync(descriptor)
  }
}

export function reviewerConfig(home: string): string {
  return `[models]
default = "grok-4.6"
default_reasoning_effort = "xhigh"

[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.codex]
sessions = false

[skills]
ignore = [${toml(join(home, '.agents', 'skills'))}, ${toml(join(home, '.codex', 'skills'))}]
disabled = ["build-with-ai", "code-review", "create-skill", "create-workflow", "design", "dev", "execute-plan", "implement", "review"]

[workflows]
enabled = false

[session]
load_envrc = false

[shell_environment_policy]
inherit = "none"
ignore_default_excludes = false

[permission]
deny = [
  ${toml('Bash(claude *)')},
  ${toml('Bash(codex *)')},
  ${toml('Bash(grok *)')},
  ${toml(`Bash(${join(home, '.grok', 'bin', 'grok')} *)`)},
  ${toml(`Bash(${join(home, '.grok-reviewer', 'bin', 'grok')} *)`)},
]

[marketplace]
default_skills_installs_purged = true
official_marketplace_auto_installed = false
`
}

export function reviewerSandbox(home: string): string {
  const denied = [
    '/proc/**', '/sys/**', '/run/**',
    join(home, '.codex'), `${join(home, '.codex')}/**`,
    join(home, '.claude'), `${join(home, '.claude')}/**`,
    join(home, '.cursor'), `${join(home, '.cursor')}/**`,
    join(home, '.grok'), `${join(home, '.grok')}/**`,
    join(home, '.ssh'), `${join(home, '.ssh')}/**`,
    join(home, '.aws'), `${join(home, '.aws')}/**`,
    join(home, '.azure'), `${join(home, '.azure')}/**`,
    join(home, '.kube'), `${join(home, '.kube')}/**`,
    join(home, '.docker'), `${join(home, '.docker')}/**`,
    join(home, '.config', 'gh'), `${join(home, '.config', 'gh')}/**`,
    join(home, '.config', 'gcloud'), `${join(home, '.config', 'gcloud')}/**`,
    join(home, '.netrc'), join(home, '.npmrc'), join(home, '.pypirc'),
    join(home, '.git-credentials'),
  ]
  return `[profiles.reviewer]
extends = "strict"
restrict_network = ${process.platform === 'darwin' ? 'false' : 'true'}
read_only = [__ZEROKUN_REVIEW_ROOTS____ZEROKUN_FINGERPRINT_ALLOW_JSON____ZEROKUN_PROMPT_ROOT_JSON__]
deny = [
${denied.map(value => `  ${toml(value)},`).join('\n')}
__ZEROKUN_FINGERPRINT_DENY_JSON__
__ZEROKUN_REVIEW_DENIES__
]
`
}

export function reviewerRequirements(): string {
  return `[grok_com_config]
disable_api_key_auth = true
`
}

export function installGrokReviewer(homeInput = homedir()): string {
  const home = realpathSync(homeInput)
  const grok = join(home, '.grok', 'bin', 'grok')
  // Do not read the executable. The installed launcher/runtime revalidates it
  // immediately before each review.
  // The official installer exposes `grok` through a versioned or downloads
  // symlink, so use the hardened executable resolver for supported layouts.
  const grokPhysical = resolveCodexExecutableDetails(grok).physical

  const reviewerRoot = ensurePrivateDirectory(join(home, '.grok-reviewer'))
  const bin = ensurePrivateDirectory(join(reviewerRoot, 'bin'))
  const sourceRoot = join(import.meta.dir, 'grok-reviewer')
  atomicPrivateWrite(join(bin, 'grok'), readInstallSource(join(sourceRoot, 'grok')), 0o700)
  atomicPrivateWrite(
    join(bin, 'reviewer-runtime.py'),
    readInstallSource(join(sourceRoot, 'reviewer-runtime.py')),
    0o700,
  )
  atomicPrivateWrite(
    join(bin, 'oauth-login-runtime.py'),
    readInstallSource(join(sourceRoot, 'oauth-login-runtime.py')),
    0o700,
  )
  atomicPrivateWrite(
    join(bin, 'grok-login-oauth'),
    renderedGrokOAuthLauncher(grokPhysical, home),
    0o700,
  )
  atomicPrivateWrite(join(reviewerRoot, 'grok-identity.json'), renderedGrokIdentity(grokPhysical), 0o600)
  atomicPrivateWrite(join(reviewerRoot, 'config.toml'), Buffer.from(reviewerConfig(home)), 0o600)
  atomicPrivateWrite(join(reviewerRoot, 'sandbox.toml'), Buffer.from(reviewerSandbox(home)), 0o600)
  atomicPrivateWrite(
    join(reviewerRoot, 'requirements.toml'),
    Buffer.from(reviewerRequirements()),
    0o600,
  )
  return resolveCodexExecutableDetails(join(bin, 'grok')).physical
}

if (import.meta.main) {
  try {
    const command = process.argv[2]
    if (command !== 'install') throw new Error('usage: install-grok-reviewer.ts install')
    const launcher = installGrokReviewer()
    process.stdout.write(`dedicated Grok reviewer installed: ${launcher}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
