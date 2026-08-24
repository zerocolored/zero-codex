#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, parse, relative, resolve, sep } from 'path'

interface FileIdentity {
  dev: string
  ino: string
  mode: string
  uid: string
  gid: string
  nlink: string
  size: string
  mtimeNs: string
  ctimeNs: string
}

type PathIdentity = Pick<FileIdentity, 'dev' | 'ino' | 'mode' | 'uid' | 'gid'>

interface PathNodeSnapshot {
  path: string
  kind: 'directory' | 'file' | 'symlink'
  identity: PathIdentity
  target?: string
  resolvedTarget?: string
}

export interface CodexExecutableResolution {
  physical: string
  resolutionPaths: string[]
}

export interface OfficialCodexSnapshot extends CodexExecutableResolution {
  version: 1
  packageVersion: string
  logical: string
  releaseDir: string
  nodes: PathNodeSnapshot[]
  manifestIdentity: FileIdentity
  leafIdentity: FileIdentity
}

interface WalkResult extends CodexExecutableResolution {
  nodes: PathNodeSnapshot[]
}

const MAX_SYMLINKS = 40
const MAX_COMPONENT_VISITS = 4096
const MAX_MANIFEST_BYTES = 64 * 1024
const MINIMUM_CODEX_VERSION = [0, 149, 0] as const
const OFFICIAL_MANIFEST_KEYS = [
  'entrypoint',
  'layoutVersion',
  'pathDir',
  'resourcesDir',
  'target',
  'variant',
  'version',
] as const

function identity(metadata: BigIntStats): FileIdentity {
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    mode: String(metadata.mode),
    uid: String(metadata.uid),
    gid: String(metadata.gid),
    nlink: String(metadata.nlink),
    size: String(metadata.size),
    mtimeNs: String(metadata.mtimeNs),
    ctimeNs: String(metadata.ctimeNs),
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right))
}

function pathIdentity(metadata: BigIntStats): PathIdentity {
  const value = identity(metadata)
  return {
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    uid: value.uid,
    gid: value.gid,
  }
}

function ownerAllowed(metadata: BigIntStats): boolean {
  return typeof process.getuid !== 'function'
    || metadata.uid === BigInt(process.getuid())
    || metadata.uid === 0n
}

function requireTrustedDirectory(path: string, metadata: BigIntStats): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownerAllowed(metadata)
    || (metadata.mode & 0o022n) !== 0n) {
    throw new Error(`Codex executable has an unsafe parent directory: ${path}`)
  }
}

function nativeExecutableHeaderSupported(header: Uint8Array): boolean {
  if (header.byteLength < 4) return false
  const magic = [...header.subarray(0, 4)]
    .map(value => value.toString(16).padStart(2, '0')).join('')
  if (process.platform === 'darwin') {
    if (header.byteLength < 8) return false
    // The official standalone release is a thin 64-bit Mach-O for the
    // package target. Reject fat binaries and a binary for the other CPU so
    // the manifest cannot claim a target that the executable does not match.
    const cpu = [...header.subarray(4, 8)]
      .map(value => value.toString(16).padStart(2, '0')).join('')
    const expectedLittleEndianCpu = process.arch === 'arm64' ? '0c000001' : '07000001'
    const expectedBigEndianCpu = process.arch === 'arm64' ? '0100000c' : '01000007'
    return (magic === 'cffaedfe' && cpu === expectedLittleEndianCpu)
      || (magic === 'feedfacf' && cpu === expectedBigEndianCpu)
  }
  if (process.platform === 'linux') return magic === '7f454c46'
  return false
}

function verifyExecutableLeaf(path: string, requireNative: boolean): FileIdentity {
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || !ownerAllowed(before) || (before.mode & 0o022n) !== 0n
    || (before.mode & 0o111n) === 0n) {
    throw new Error(`Codex executable is not a trusted regular file: ${path}`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (!sameIdentity(before, opened)) {
      throw new Error(`Codex executable changed while it was verified: ${path}`)
    }
    if (requireNative) {
      const header = Buffer.alloc(8)
      if (readSync(descriptor, header, 0, header.length, 0) !== header.length
        || !nativeExecutableHeaderSupported(header)) {
        throw new Error(`Codex executable is not a native binary: ${path}`)
      }
    }
    return identity(opened)
  } finally {
    closeSync(descriptor)
  }
}

/** Resolve every component without hiding directory symlinks behind dirname(realpath). */
function walkExecutable(candidate: string): WalkResult {
  const absolute = resolve(candidate)
  const paths = new Set<string>([absolute])
  const nodes: PathNodeSnapshot[] = []
  let root = parse(absolute).root
  let current = root
  let pending = relative(root, absolute).split(sep).filter(Boolean)
  let symlinkCount = 0
  let componentVisits = 0

  const rootMetadata = lstatSync(root, { bigint: true })
  requireTrustedDirectory(root, rootMetadata)
  nodes.push({ path: root, kind: 'directory', identity: pathIdentity(rootMetadata) })

  while (pending.length > 0) {
    componentVisits += 1
    if (componentVisits > MAX_COMPONENT_VISITS) {
      throw new Error(`Codex executable path has too many components: ${candidate}`)
    }
    const component = pending.shift()!
    const node = join(current, component)
    paths.add(node)
    const before = lstatSync(node, { bigint: true })
    if (before.isSymbolicLink()) {
      symlinkCount += 1
      if (symlinkCount > MAX_SYMLINKS || !ownerAllowed(before) || before.nlink !== 1n) {
        throw new Error(`Codex executable has an unsafe symbolic link: ${node}`)
      }
      const target = readlinkSync(node)
      const after = lstatSync(node, { bigint: true })
      if (!sameIdentity(before, after)) {
        throw new Error(`Codex executable symlink changed while it was verified: ${node}`)
      }
      const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(current, target)
      nodes.push({
        path: node,
        kind: 'symlink',
        identity: pathIdentity(after),
        target,
        resolvedTarget,
      })
      paths.add(resolvedTarget)
      root = parse(resolvedTarget).root
      current = root
      pending = [
        ...relative(root, resolvedTarget).split(sep).filter(Boolean),
        ...pending,
      ]
      continue
    }

    const final = pending.length === 0
    if (!final) requireTrustedDirectory(node, before)
    nodes.push({
      path: node,
      kind: final ? 'file' : 'directory',
      identity: pathIdentity(before),
    })
    current = node
  }

  const physical = current
  if (realpathSync(absolute) !== physical) {
    throw new Error(`Codex executable changed while its path was verified: ${candidate}`)
  }
  paths.add(physical)
  return { physical, resolutionPaths: [...paths], nodes }
}

function executableCandidate(requested: string): string {
  if (!requested || requested.includes('\0')) {
    throw new Error('Codex executable must be a non-empty command or absolute path')
  }
  const candidate = isAbsolute(requested)
    ? requested
    : requested.includes(sep)
      ? null
      : Bun.which(requested)
  if (!candidate || !isAbsolute(candidate)) {
    throw new Error(`Codex executable could not be resolved: ${requested}`)
  }
  return candidate
}

/** Test-only/general verifier. Production Slack jobs use resolveOfficialStandaloneCodex. */
export function resolveCodexExecutableDetails(
  requested: string,
  options: { requireNative?: boolean } = {},
): CodexExecutableResolution {
  try {
    const walked = walkExecutable(executableCandidate(requested))
    verifyExecutableLeaf(walked.physical, options.requireNative === true)
    return { physical: walked.physical, resolutionPaths: walked.resolutionPaths }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Codex executable ')) throw error
    throw new Error(`Codex executable could not be verified: ${requested}`)
  }
}

export function resolveCodexExecutable(
  requested: string,
  options: { requireNative?: boolean } = {},
): string {
  return resolveCodexExecutableDetails(requested, options).physical
}

function readTrustedManifest(path: string): { value: Record<string, unknown>; identity: FileIdentity } {
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || !ownerAllowed(before) || (before.mode & 0o022n) !== 0n
    || before.size <= 0n || before.size > BigInt(MAX_MANIFEST_BYTES)) {
    throw new Error(`Codex standalone manifest is not trusted: ${path}`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (!sameIdentity(before, opened)) {
      throw new Error(`Codex standalone manifest changed while it was verified: ${path}`)
    }
    const size = Number(opened.size)
    const bytes = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset)
      if (count === 0) break
      offset += count
    }
    const trailing = Buffer.alloc(1)
    const trailingCount = readSync(descriptor, trailing, 0, 1, size)
    const after = fstatSync(descriptor, { bigint: true })
    if (offset !== size || trailingCount !== 0 || !sameIdentity(opened, after)) {
      throw new Error(`Codex standalone manifest changed while it was read: ${path}`)
    }
    return {
      value: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>,
      identity: identity(after),
    }
  } finally {
    closeSync(descriptor)
  }
}

function expectedStandaloneTarget(): string {
  if (process.platform !== 'darwin') {
    throw new Error('Codex official standalone runtime is currently supported only on macOS')
  }
  if (process.arch === 'arm64') return 'aarch64-apple-darwin'
  if (process.arch === 'x64') return 'x86_64-apple-darwin'
  throw new Error(`Codex official standalone does not support architecture ${process.arch}`)
}

function supportedVersion(version: string): boolean {
  const parts = version.split('.').map(Number)
  if (parts.length !== 3 || parts.some(part => !Number.isSafeInteger(part) || part < 0)) {
    return false
  }
  for (let index = 0; index < MINIMUM_CODEX_VERSION.length; index += 1) {
    if (parts[index]! > MINIMUM_CODEX_VERSION[index]!) return true
    if (parts[index]! < MINIMUM_CODEX_VERSION[index]!) return false
  }
  return true
}

/**
 * Resolve only the layout installed by bootstrap-macos.sh. No PATH, Homebrew,
 * npm wrapper, or ZEROKUN_CODEX_BIN fallback is part of this production trust
 * boundary.
 */
function resolveOfficialStandaloneCodexAtHome(homeDirectory: string): OfficialCodexSnapshot {
  try {
    const home = realpathSync(homeDirectory)
    const logical = join(home, '.local', 'bin', 'codex')
    const standalone = join(home, '.codex', 'packages', 'standalone')
    const current = join(standalone, 'current')
    const releases = join(standalone, 'releases')
    const walked = walkExecutable(logical)
    const links = walked.nodes.filter(node => node.kind === 'symlink')
    if (links.length !== 2 || links[0]?.path !== logical || links[1]?.path !== current) {
      throw new Error('Codex official standalone symlink layout is not supported')
    }
    if (links[0].resolvedTarget !== join(current, 'bin', 'codex')) {
      throw new Error('Codex official standalone entry link has an unexpected target')
    }

    const relativePhysical = relative(releases, walked.physical)
    const parts = relativePhysical.split(sep)
    if (parts.length !== 3 || parts[1] !== 'bin' || parts[2] !== 'codex'
      || !/^[A-Za-z0-9._-]+$/.test(parts[0]!) || parts[0] === '.' || parts[0] === '..') {
      throw new Error('Codex official standalone executable is outside the release layout')
    }
    const releaseDir = join(releases, parts[0]!)
    if (links[1].resolvedTarget !== releaseDir) {
      throw new Error('Codex official standalone current link has an unexpected target')
    }
    const target = expectedStandaloneTarget()
    const manifest = readTrustedManifest(join(releaseDir, 'codex-package.json'))
    const version = manifest.value.version
    if (JSON.stringify(Object.keys(manifest.value).sort()) !== JSON.stringify(OFFICIAL_MANIFEST_KEYS)
      || manifest.value.layoutVersion !== 1 || manifest.value.variant !== 'codex'
      || manifest.value.entrypoint !== 'bin/codex'
      || manifest.value.resourcesDir !== 'codex-resources'
      || manifest.value.pathDir !== 'codex-path'
      || manifest.value.target !== target
      || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)
      || !supportedVersion(version)
      || parts[0] !== `${version}-${target}`) {
      throw new Error('Codex official standalone manifest does not match the release layout')
    }
    const leafIdentity = verifyExecutableLeaf(walked.physical, true)
    return {
      version: 1,
      packageVersion: version,
      logical,
      physical: walked.physical,
      releaseDir,
      resolutionPaths: walked.resolutionPaths,
      nodes: walked.nodes,
      manifestIdentity: manifest.identity,
      leafIdentity,
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Codex ')) throw error
    throw new Error(
      'Codex official standalone could not be verified; rerun bash zerokun/bootstrap-macos.sh --skip-slack',
    )
  }
}

export function resolveOfficialStandaloneCodex(): OfficialCodexSnapshot {
  return resolveOfficialStandaloneCodexAtHome(homedir())
}

/** Test fixture entrypoint; production callers must use resolveOfficialStandaloneCodex. */
export function resolveOfficialStandaloneCodexForTesting(
  homeDirectory: string,
): OfficialCodexSnapshot {
  return resolveOfficialStandaloneCodexAtHome(homeDirectory)
}

export function verifyOfficialCodexSnapshot(
  expected: OfficialCodexSnapshot,
): OfficialCodexSnapshot {
  if (!expected || expected.version !== 1 || typeof expected.physical !== 'string') {
    throw new Error('Codex official standalone snapshot is invalid')
  }
  const current = resolveOfficialStandaloneCodex()
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error('Codex official standalone changed after it was verified')
  }
  return current
}

export function encodeOfficialCodexSnapshot(snapshot: OfficialCodexSnapshot): string {
  return Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64url')
}

export function verifyEncodedOfficialCodexSnapshot(encoded: string): OfficialCodexSnapshot {
  if (!encoded || encoded.length > 256 * 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('Codex official standalone snapshot encoding is invalid')
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Codex official standalone snapshot encoding is invalid')
  }
  return verifyOfficialCodexSnapshot(value as OfficialCodexSnapshot)
}

if (import.meta.main) {
  const command = process.argv[2]
  if (command !== 'version' || process.argv.length !== 3) {
    throw new Error('usage: standalone-codex.ts version')
  }
  process.stdout.write(`${resolveOfficialStandaloneCodex().packageVersion}\n`)
}
