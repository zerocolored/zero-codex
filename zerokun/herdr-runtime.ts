#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { createHash } from 'crypto'
import { lstatSync, realpathSync, type Stats } from 'fs'
import { basename, dirname, isAbsolute, join } from 'path'
import { requireManagedStateRoot } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalPrivateFile } from './safe-file.ts'

export const HERDR_ENVIRONMENT_KEYS = [
  'HERDR_ENV',
  'HERDR_BIN_PATH',
  'HERDR_SOCKET_PATH',
  'HERDR_PANE_ID',
  'HERDR_TAB_ID',
  'HERDR_TERMINAL_ID',
  'HERDR_WORKSPACE_ID',
] as const

export type HerdrRuntimeIdentity = {
  binary: string
  binaryDevice: number
  binaryInode: number
  binaryMode: number
  binarySize: number
  binaryModifiedMs: number
  binaryChangedMs: number
  socketPath: string
  socketDevice: number
  socketInode: number
  paneId: string
  tabId: string
  terminalId: string
  workspaceId: string
}

export const HERDR_RUNTIME_IDENTITY_FILE = 'herdr-runtime.json' as const

type PaneEnvelope = {
  result?: {
    pane?: {
      pane_id?: string
      tab_id?: string
      terminal_id?: string
      workspace_id?: string
    }
  }
}

const HERDR_CURRENT_PANE_TIMEOUT_MS = 5_000
const HERDR_CURRENT_PANE_OUTPUT_LIMIT = 64 * 1024

function requireOwnedNode(path: string, kind: 'socket' | 'file'): Stats {
  const metadata = lstatSync(path) as Stats
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  const typeMatches = kind === 'socket' ? metadata.isSocket() : metadata.isFile()
  if (!typeMatches || metadata.isSymbolicLink() || !ownerMatches || (metadata.mode & 0o022) !== 0) {
    throw new Error(`unsafe Herdr ${kind}: ${path}`)
  }
  return metadata
}

function requireIdentifier(value: string | undefined, label: string, pattern: RegExp): string {
  if (!value || !pattern.test(value)) throw new Error(`invalid ${label}: ${value ?? ''}`)
  return value
}

const HERDR_RUNTIME_KEYS = [
  'binary', 'binaryDevice', 'binaryInode', 'binaryMode', 'binarySize',
  'binaryModifiedMs', 'binaryChangedMs', 'socketPath', 'socketDevice',
  'socketInode', 'paneId', 'tabId', 'terminalId', 'workspaceId',
] as const satisfies ReadonlyArray<keyof HerdrRuntimeIdentity>

function parseHerdrRuntimeIdentity(value: unknown): HerdrRuntimeIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pinned Herdr runtime identity is invalid')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('\n') !== [...HERDR_RUNTIME_KEYS].sort().join('\n')) {
    throw new Error('pinned Herdr runtime identity has unexpected fields')
  }
  for (const key of [
    'binaryDevice', 'binaryInode', 'binaryMode', 'binarySize',
    'binaryModifiedMs', 'binaryChangedMs', 'socketDevice', 'socketInode',
  ] as const) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key]) || record[key] < 0) {
      throw new Error(`pinned Herdr runtime identity has invalid ${key}`)
    }
  }
  if (typeof record.binary !== 'string' || !isAbsolute(record.binary)
    || typeof record.socketPath !== 'string' || !isAbsolute(record.socketPath)) {
    throw new Error('pinned Herdr runtime paths must be absolute')
  }
  const identity = record as HerdrRuntimeIdentity
  requireIdentifier(identity.paneId, 'Herdr pane ID', /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/)
  requireIdentifier(identity.tabId, 'Herdr tab ID', /^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/)
  requireIdentifier(identity.terminalId, 'Herdr terminal ID', /^term_[0-9a-f]+$/)
  requireIdentifier(identity.workspaceId, 'Herdr workspace ID', /^w[0-9A-Za-z]+$/)
  return identity
}

export function herdrRuntimeFingerprint(identity: HerdrRuntimeIdentity): string {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/** Stable binary/socket identity shared by every pane on one Herdr control plane. */
export function herdrControlPlaneFingerprint(identity: HerdrRuntimeIdentity): string {
  return createHash('sha256').update(JSON.stringify({
    binary: identity.binary,
    binaryDevice: identity.binaryDevice,
    binaryInode: identity.binaryInode,
    binaryMode: identity.binaryMode,
    binarySize: identity.binarySize,
    binaryModifiedMs: identity.binaryModifiedMs,
    binaryChangedMs: identity.binaryChangedMs,
    socketPath: identity.socketPath,
    socketDevice: identity.socketDevice,
    socketInode: identity.socketInode,
  })).digest('hex')
}

export function verifyPinnedHerdrControlPlane(
  stateDir: string,
  source: Record<string, string | undefined> = process.env,
): void {
  const pinned = readPinnedHerdrRuntime(stateDir)
  const current = requireHerdrRuntime(source)
  if (herdrControlPlaneFingerprint(pinned) !== herdrControlPlaneFingerprint(current)) {
    throw new Error('Herdr control plane changed after Zeroちゃん startup')
  }
}

/** Pass a verified launch identity to the daemon without mutating shared state first. */
export function encodeHerdrRuntimeIdentity(identity: HerdrRuntimeIdentity): string {
  return Buffer.from(JSON.stringify(parseHerdrRuntimeIdentity(identity)), 'utf8').toString('base64url')
}

export function decodeHerdrRuntimeIdentity(encoded: string): HerdrRuntimeIdentity {
  if (!encoded || encoded.length > 16 * 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('encoded Herdr runtime identity is invalid')
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new Error('encoded Herdr runtime identity is invalid')
  }
  return parseHerdrRuntimeIdentity(value)
}

export function environmentForPinnedHerdrRuntime(
  identity: HerdrRuntimeIdentity,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return {
    ...environment,
    HERDR_ENV: '1',
    HERDR_BIN_PATH: identity.binary,
    HERDR_SOCKET_PATH: identity.socketPath,
    HERDR_PANE_ID: identity.paneId,
    HERDR_TAB_ID: identity.tabId,
    HERDR_TERMINAL_ID: identity.terminalId,
    HERDR_WORKSPACE_ID: identity.workspaceId,
    PATH: `${dirname(identity.binary)}:${environment.PATH ?? '/usr/bin:/bin'}`,
  }
}

export function writePinnedHerdrRuntime(
  stateDirInput: string,
  identity: HerdrRuntimeIdentity,
): string {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const validated = parseHerdrRuntimeIdentity(identity)
  const path = join(stateDir, HERDR_RUNTIME_IDENTITY_FILE)
  atomicWritePrivateFile(path, `${JSON.stringify(validated)}\n`)
  return path
}

export function readPinnedHerdrRuntime(stateDirInput: string): HerdrRuntimeIdentity {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const path = join(stateDir, HERDR_RUNTIME_IDENTITY_FILE)
  const raw = readOptionalPrivateFile(path)
  if (raw === null) throw new Error('pinned Herdr runtime identity is missing')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new Error('pinned Herdr runtime identity is not valid JSON')
  }
  return parseHerdrRuntimeIdentity(parsed)
}

function currentPaneEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string> {
  const allowed = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM',
    'NO_COLOR', 'XDG_CONFIG_HOME', 'HERDR_CONFIG_PATH', ...HERDR_ENVIRONMENT_KEYS,
  ])
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => (
      entry[1] !== undefined && (allowed.has(entry[0]) || entry[0].startsWith('LC_'))
    )),
  )
}

function parseCurrentPane(stdout: Uint8Array): NonNullable<NonNullable<PaneEnvelope['result']>['pane']> {
  let parsed: PaneEnvelope
  try {
    parsed = JSON.parse(Buffer.from(stdout).toString('utf8')) as PaneEnvelope
  } catch {
    throw new Error('Herdr current pane verification returned invalid JSON')
  }
  if (!parsed.result?.pane) throw new Error('Herdr current pane verification omitted pane identity')
  return parsed.result.pane
}

function readCurrentPane(
  binary: string,
  environment: Record<string, string | undefined>,
): NonNullable<NonNullable<PaneEnvelope['result']>['pane']> {
  const result = Bun.spawnSync([binary, 'pane', 'current', '--current'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: currentPaneEnvironment(environment),
    timeout: HERDR_CURRENT_PANE_TIMEOUT_MS,
    maxBuffer: HERDR_CURRENT_PANE_OUTPUT_LIMIT,
  })
  if (result.exitCode !== 0) {
    throw new Error(`Herdr current pane verification failed: ${result.stderr.toString().trim()}`)
  }
  return parseCurrentPane(result.stdout)
}

async function readBoundedCurrentPaneOutput(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > HERDR_CURRENT_PANE_OUTPUT_LIMIT) {
        throw new Error('Herdr current pane verification returned excessive output')
      }
      chunks.push(value)
    }
  } finally {
    try { await reader.cancel() } catch {}
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total)
}

async function readCurrentPaneAsync(
  binary: string,
  environment: Record<string, string | undefined>,
  timeoutMs = HERDR_CURRENT_PANE_TIMEOUT_MS,
): Promise<NonNullable<NonNullable<PaneEnvelope['result']>['pane']>> {
  const child = Bun.spawn([binary, 'pane', 'current', '--current'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: currentPaneEnvironment(environment),
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { child.kill('SIGKILL') } catch {}
  }, timeoutMs)
  let stdout: Uint8Array
  let stderr: Uint8Array
  let exitCode: number
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      readBoundedCurrentPaneOutput(child.stdout),
      readBoundedCurrentPaneOutput(child.stderr),
      child.exited,
    ])
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) {
      try { child.kill('SIGKILL') } catch {}
      try { await child.exited } catch {}
    }
  }
  if (timedOut || exitCode !== 0) {
    const detail = Buffer.from(stderr).toString('utf8').trim().slice(-2_000)
    throw new Error(
      `Herdr current pane verification ${timedOut ? 'timed out' : 'failed'}: ${detail}`,
    )
  }
  return parseCurrentPane(stdout)
}

/**
 * Bind Zero-chan to the Herdr pane that launched it. The detached runner keeps
 * this exact control-plane identity and every Codex job revalidates it before
 * starting; stale copied HERDR_* variables therefore fail closed.
 */
export function requireHerdrRuntime(
  source: Record<string, string | undefined> = process.env,
): HerdrRuntimeIdentity {
  if (source.HERDR_ENV !== '1') {
    throw new Error('ZeroちゃんはHerdr内から起動してください（HERDR_ENV=1 が必要です）')
  }
  const socketInput = source.HERDR_SOCKET_PATH
  if (!socketInput || !isAbsolute(socketInput)) throw new Error('HERDR_SOCKET_PATH must be absolute')
  const socketPath = join(realpathSync(dirname(socketInput)), basename(socketInput))
  const socket = requireOwnedNode(socketPath, 'socket')

  const binaryInput = source.HERDR_BIN_PATH || Bun.which('herdr', { PATH: source.PATH })
  if (!binaryInput || !isAbsolute(binaryInput)) throw new Error('HERDR_BIN_PATH must be absolute')
  const binary = realpathSync(binaryInput)
  const binaryMetadata = requireOwnedNode(binary, 'file')

  const pane = readCurrentPane(binary, source)
  const paneId = requireIdentifier(pane.pane_id, 'Herdr pane ID', /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/)
  const tabId = requireIdentifier(pane.tab_id, 'Herdr tab ID', /^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/)
  const terminalId = requireIdentifier(pane.terminal_id, 'Herdr terminal ID', /^term_[0-9a-f]+$/)
  const workspaceId = requireIdentifier(pane.workspace_id, 'Herdr workspace ID', /^w[0-9A-Za-z]+$/)

  return {
    binary,
    binaryDevice: Number(binaryMetadata.dev),
    binaryInode: Number(binaryMetadata.ino),
    binaryMode: Number(binaryMetadata.mode),
    binarySize: Number(binaryMetadata.size),
    binaryModifiedMs: Number(binaryMetadata.mtimeMs),
    binaryChangedMs: Number(binaryMetadata.ctimeMs),
    socketPath,
    socketDevice: Number(socket.dev),
    socketInode: Number(socket.ino),
    paneId,
    tabId,
    terminalId,
    workspaceId,
  }
}

export function verifyHerdrRuntimeIdentity(
  expected: HerdrRuntimeIdentity,
  source: Record<string, string | undefined> = process.env,
): void {
  const binary = requireOwnedNode(expected.binary, 'file')
  const socket = requireOwnedNode(expected.socketPath, 'socket')
  if (
    Number(binary.dev) !== expected.binaryDevice
    || Number(binary.ino) !== expected.binaryInode
    || Number(binary.mode) !== expected.binaryMode
    || Number(binary.size) !== expected.binarySize
    || Number(binary.mtimeMs) !== expected.binaryModifiedMs
    || Number(binary.ctimeMs) !== expected.binaryChangedMs
    || Number(socket.dev) !== expected.socketDevice
    || Number(socket.ino) !== expected.socketInode
  ) {
    throw new Error('Herdr runtime identity changed after Zeroちゃん startup')
  }
  const current = requireHerdrRuntime(source)
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error('Herdr runtime identity changed after Zeroちゃん startup')
  }
}

/**
 * Event-loop-safe runtime verification for every live job/control-plane path.
 * The synchronous variant remains for the startup CLI and compatibility tests,
 * but is itself bounded; long-running workers must await this variant.
 */
export async function verifyHerdrRuntimeIdentityAsync(
  expected: HerdrRuntimeIdentity,
  source: Record<string, string | undefined> = process.env,
  timeoutMs = HERDR_CURRENT_PANE_TIMEOUT_MS,
): Promise<void> {
  const binary = requireOwnedNode(expected.binary, 'file')
  const socket = requireOwnedNode(expected.socketPath, 'socket')
  if (
    Number(binary.dev) !== expected.binaryDevice
    || Number(binary.ino) !== expected.binaryInode
    || Number(binary.mode) !== expected.binaryMode
    || Number(binary.size) !== expected.binarySize
    || Number(binary.mtimeMs) !== expected.binaryModifiedMs
    || Number(binary.ctimeMs) !== expected.binaryChangedMs
    || Number(socket.dev) !== expected.socketDevice
    || Number(socket.ino) !== expected.socketInode
  ) {
    throw new Error('Herdr runtime identity changed after Zeroちゃん startup')
  }
  if (source.HERDR_ENV !== '1') {
    throw new Error('ZeroちゃんはHerdr内から起動してください（HERDR_ENV=1 が必要です）')
  }
  const socketInput = source.HERDR_SOCKET_PATH
  if (!socketInput || !isAbsolute(socketInput)) throw new Error('HERDR_SOCKET_PATH must be absolute')
  const socketPath = join(realpathSync(dirname(socketInput)), basename(socketInput))
  const binaryInput = source.HERDR_BIN_PATH || Bun.which('herdr', { PATH: source.PATH })
  if (!binaryInput || !isAbsolute(binaryInput)) throw new Error('HERDR_BIN_PATH must be absolute')
  const resolvedBinary = realpathSync(binaryInput)
  if (socketPath !== expected.socketPath || resolvedBinary !== expected.binary) {
    throw new Error('Herdr runtime identity changed after Zeroちゃん startup')
  }
  const pane = await readCurrentPaneAsync(expected.binary, source, timeoutMs)
  if (
    requireIdentifier(pane.pane_id, 'Herdr pane ID', /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/) !== expected.paneId
    || requireIdentifier(pane.tab_id, 'Herdr tab ID', /^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/) !== expected.tabId
    || requireIdentifier(pane.terminal_id, 'Herdr terminal ID', /^term_[0-9a-f]+$/) !== expected.terminalId
    || requireIdentifier(pane.workspace_id, 'Herdr workspace ID', /^w[0-9A-Za-z]+$/) !== expected.workspaceId
  ) {
    throw new Error('Herdr runtime identity changed after Zeroちゃん startup')
  }
}

if (import.meta.main) {
  try {
    const [command, stateDir] = process.argv.slice(2)
    if (command === 'pin') {
      if (!stateDir) throw new Error('usage: herdr-runtime.ts pin STATE_DIR')
      const identity = requireHerdrRuntime()
      writePinnedHerdrRuntime(stateDir, identity)
      process.stdout.write(`${herdrRuntimeFingerprint(identity)}\n`)
    } else if (command === 'verify-pinned') {
      if (!stateDir) throw new Error('usage: herdr-runtime.ts verify-pinned STATE_DIR')
      const identity = readPinnedHerdrRuntime(stateDir)
      verifyHerdrRuntimeIdentity(identity)
      process.stdout.write(`${herdrRuntimeFingerprint(identity)}\n`)
    } else if (command === 'runtime-id') {
      process.stdout.write(`${herdrRuntimeFingerprint(requireHerdrRuntime())}\n`)
    } else if (command === 'control-plane-id') {
      process.stdout.write(`${herdrControlPlaneFingerprint(requireHerdrRuntime())}\n`)
    } else if (command === 'verify-control-plane') {
      if (!stateDir) throw new Error('usage: herdr-runtime.ts verify-control-plane STATE_DIR')
      verifyPinnedHerdrControlPlane(stateDir)
      process.stdout.write(`${herdrControlPlaneFingerprint(requireHerdrRuntime())}\n`)
    } else if (command) {
      throw new Error(`unknown command: ${command}`)
    } else {
      const identity = requireHerdrRuntime()
      process.stdout.write(
        `Herdr runtime: ${identity.workspaceId}/${identity.paneId} (${identity.terminalId})\n`,
      )
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
