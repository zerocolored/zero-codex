#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { Database } from 'bun:sqlite'
import {
  closeSync,
  constants,
  existsSync,
  chmodSync,
  copyFileSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  writeFileSync,
  type BigIntStats,
} from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { dirname, join, parse, relative, resolve, sep } from 'path'
import {
  blockProcessLockDelegate,
  delegateProcessLock,
  discardProcessLock,
  processLockOwnerMatches,
  processLockLeaseIsExclusive,
  protectProcessLockDelegateCleanup,
  stopProcessLockOwner,
  type ProcessLockDelegate,
  type ProcessLockLease,
  releaseProcessLock,
  tryAcquireProcessLock,
  undelegateProcessLock,
  encodeProcessLockDelegate,
} from './process-lock.ts'
import { resolveZeroJobDatabasePath, resolveZeroStateDir } from './state-dir.ts'
import { readGatewayReadiness } from './readiness.ts'
import {
  buildCandidateEnvironment,
  buildRuntimeServiceEnvironment,
  buildSetupEnvironment,
  buildUpdaterEnvironment,
} from './child-environment.ts'
import {
  ensureManagedDirectory,
  prepareManagedStateRoot,
  requireManagedDirectory,
} from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalPrivateFile } from './safe-file.ts'
import {
  captureTrackedProcesses,
  reapTrackedProcesses,
  seedTrackedProcess,
} from './process-tree.ts'
import {
  signalProcessGroupIfLeaderLive,
  signalProcessIfLive,
} from './process-generation.ts'
import {
  environmentForPinnedHerdrRuntime,
  readPinnedHerdrRuntime,
  verifyHerdrRuntimeIdentityAsync,
} from './herdr-runtime.ts'

interface Repository {
  label: string
  path: string
  branch: string
}

interface PinnedRepository extends Repository {
  targetHead: string
  originalHead: string
  originalBranch: string
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

type ProcessGroupLeaseCoordinator = {
  delegate: (pid: number) => ProcessLockDelegate
  undelegate: (delegate: ProcessLockDelegate) => void
  block: (delegate: ProcessLockDelegate) => void
  protect: (delegate: ProcessLockDelegate) => void
  quiescenceLockFile: string
  gateHelperRoot: string
  gateLockTool: string
}

const TRUSTED_TOOL_PATH = [
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  dirname(process.execPath),
  '/opt/homebrew/bin',
  '/usr/local/bin',
].join(':')

const MINIMUM_CODEX_VERSION = [0, 149, 0] as const

function trustedSystemTemporaryDirectory(): string {
  const physical = realpathSync('/tmp')
  const root = parse(physical).root
  let current = root
  for (const component of relative(root, physical).split(sep).filter(Boolean)) {
    current = join(current, component)
    const metadata = lstatSync(current)
    const writable = (metadata.mode & 0o022) !== 0
    const stickyRootDirectory = metadata.uid === 0 && (metadata.mode & 0o1000) !== 0
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0
      || (writable && !stickyRootDirectory)) {
      fail(`system temporary directoryが安全ではありません: ${physical}`)
    }
  }
  return physical
}

/** Ignore caller-controlled TMPDIR for executable/helper staging. */
export function createUpdaterTemporaryDirectory(prefix: string): string {
  if (!/^zerokun-[a-z0-9-]{1,64}-$/.test(prefix)) {
    fail(`temporary directory prefixが不正です: ${prefix}`)
  }
  const directory = mkdtempSync(join(trustedSystemTemporaryDirectory(), prefix))
  chmodSync(directory, 0o700)
  const metadata = lstatSync(directory)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownerMatches
    || (metadata.mode & 0o077) !== 0) {
    fail(`temporary directoryを安全に作成できません: ${directory}`)
  }
  return directory
}

interface SecureExecutableSnapshot {
  physical: string
  metadata: BigIntStats
}

function secureExecutableSnapshot(candidate: string): SecureExecutableSnapshot | null {
  try {
    const physical = realpathSync(candidate)
    const root = parse(physical).root
    let current = root
    for (const component of relative(root, dirname(physical)).split(sep).filter(Boolean)) {
      current = join(current, component)
      const parent = lstatSync(current)
      const parentOwnerAllowed = typeof process.getuid !== 'function'
        || parent.uid === process.getuid()
        || parent.uid === 0
      if (!parent.isDirectory() || parent.isSymbolicLink() || !parentOwnerAllowed
        || (parent.mode & 0o022) !== 0) return null
    }
    const metadata = lstatSync(physical, { bigint: true })
    const ownerAllowed = typeof process.getuid !== 'function'
      || metadata.uid === BigInt(process.getuid())
      || metadata.uid === 0n
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
      || !ownerAllowed || (metadata.mode & 0o022n) !== 0n
      || (metadata.mode & 0o111n) === 0n) return null
    return { physical, metadata }
  } catch {
    return null
  }
}

function secureExecutable(candidate: string): string | null {
  return secureExecutableSnapshot(candidate)?.physical ?? null
}

export function nativeExecutableHeaderSupported(
  header: Uint8Array,
  platform = process.platform,
  architecture = process.arch,
): boolean {
  if (header.byteLength < 4) return false
  const magic = [...header.subarray(0, 4)]
    .map(value => value.toString(16).padStart(2, '0')).join('')
  if (platform === 'darwin') {
    if (header.byteLength < 8) return false
    if (architecture !== 'arm64' && architecture !== 'x64') return false
    const cpu = [...header.subarray(4, 8)]
      .map(value => value.toString(16).padStart(2, '0')).join('')
    const expectedLittleEndianCpu = architecture === 'arm64' ? '0c000001' : '07000001'
    const expectedBigEndianCpu = architecture === 'arm64' ? '0100000c' : '01000007'
    return (magic === 'cffaedfe' && cpu === expectedLittleEndianCpu)
      || (magic === 'feedfacf' && cpu === expectedBigEndianCpu)
  }
  if (platform === 'linux') return magic === '7f454c46'
  return false
}

function copySecureExecutable(
  candidate: string,
  destination: string,
  beforeOpen: () => void = () => {},
  requireNative = false,
): void {
  const snapshot = secureExecutableSnapshot(candidate)
  if (!snapshot) fail(`実行fileを安全に読めません: ${candidate}`)
  const { physical, metadata: before } = snapshot
  let source = -1
  let target = -1
  let complete = false
  try {
    beforeOpen()
    source = openSync(physical, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(source, { bigint: true })
    const openedOwnerAllowed = typeof process.getuid !== 'function'
      || opened.uid === BigInt(process.getuid()) || opened.uid === 0n
    if (!opened.isFile() || opened.nlink !== 1n || !openedOwnerAllowed
      || (opened.mode & 0o022n) !== 0n || (opened.mode & 0o111n) === 0n
      || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mode !== before.mode
      || opened.uid !== before.uid || opened.mtimeNs !== before.mtimeNs
      || opened.ctimeNs !== before.ctimeNs) {
      fail(`実行fileが検証中に変化しました: ${candidate}`)
    }
    if (requireNative) {
      const header = Buffer.alloc(8)
      if (readSync(source, header, 0, header.length, 0) !== header.length
        || !nativeExecutableHeaderSupported(header)) {
        fail(`Codex executableがnative binaryではありません: ${candidate}`)
      }
    }
    target = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o500,
    )
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (true) {
      const size = readSync(source, buffer, 0, buffer.length, null)
      if (size === 0) break
      let offset = 0
      while (offset < size) {
        offset += writeSync(target, buffer, offset, size - offset)
      }
    }
    const after = fstatSync(source, { bigint: true })
    if (after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mode !== opened.mode
      || after.uid !== opened.uid || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs) {
      fail(`実行fileがcopy中に変化しました: ${candidate}`)
    }
    const copied = fstatSync(target)
    if (!copied.isFile() || copied.nlink !== 1
      || BigInt(copied.size) !== opened.size
      || (typeof process.getuid === 'function' && copied.uid !== process.getuid())) {
      fail(`staging実行fileが不正です: ${destination}`)
    }
    fchmodSync(target, 0o500)
    complete = true
  } finally {
    if (target >= 0) closeSync(target)
    if (source >= 0) closeSync(source)
    if (!complete) {
      try { rmSync(destination, { force: true }) } catch {}
    }
  }
}

/** Test-only deterministic race injection for the executable staging boundary. */
export function copySecureExecutableForTesting(
  candidate: string,
  destination: string,
  beforeOpen: () => void,
): void {
  copySecureExecutable(candidate, destination, beforeOpen)
}

function copyFrozenRuntimeFile(sourcePath: string, destination: string): void {
  let source = -1
  let target = -1
  try {
    source = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = fstatSync(source, { bigint: true })
    const ownerAllowed = typeof process.getuid !== 'function'
      || before.uid === BigInt(process.getuid()) || before.uid === 0n
    if (!before.isFile() || before.nlink !== 1n || !ownerAllowed
      || before.size <= 0n || before.size > 2n * 1024n * 1024n) {
      fail(`runtime helper sourceが不正です: ${sourcePath}`)
    }
    target = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400,
    )
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (true) {
      const size = readSync(source, buffer, 0, buffer.length, null)
      if (size === 0) break
      let offset = 0
      while (offset < size) offset += writeSync(target, buffer, offset, size - offset)
    }
    const after = fstatSync(source, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mode !== before.mode
      || after.uid !== before.uid || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs) {
      fail(`runtime helper sourceがcopy中に変化しました: ${sourcePath}`)
    }
    const copied = fstatSync(target)
    if (!copied.isFile() || copied.nlink !== 1
      || (typeof process.getuid === 'function' && copied.uid !== process.getuid())) {
      fail(`runtime helper copyが不正です: ${destination}`)
    }
    fchmodSync(target, 0o400)
  } finally {
    if (target >= 0) closeSync(target)
    if (source >= 0) closeSync(source)
  }
}

function prepareProcessGroupGateHelper(): { root: string; lockTool: string } {
  const root = createUpdaterTemporaryDirectory('zerokun-gate-helper-')
  const lockTool = join(root, 'process-lock.ts')
  try {
    copyFrozenRuntimeFile(join(import.meta.dir, 'process-lock.ts'), lockTool)
    copyFrozenRuntimeFile(
      join(import.meta.dir, 'process-generation.ts'),
      join(root, 'process-generation.ts'),
    )
    return { root, lockTool }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function codexVersionIsSupported(
  codexBin: string,
  source: Record<string, string | undefined>,
  requireNative = true,
): boolean {
  const stagingRoot = createUpdaterTemporaryDirectory('zerokun-codex-version-')
  const staged = join(stagingRoot, 'codex')
  try {
    copySecureExecutable(codexBin, staged, () => {}, requireNative)
    return stagedCodexVersionIsSupported(staged, source)
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

function stagedCodexVersionIsSupported(
  staged: string,
  source: Record<string, string | undefined>,
): boolean {
  const result = Bun.spawnSync([staged, '--version'], {
    env: {
      PATH: TRUSTED_TOOL_PATH,
      HOME: source.HOME ?? '/var/empty',
      CODEX_HOME: source.HOME ? join(source.HOME, '.codex') : '/var/empty',
      LANG: source.LANG ?? 'C',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
  })
  if (result.exitCode !== 0) return false
  const versionOutput = result.stdout.toString()
  const match = versionOutput.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/)
  if (!match) return false
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])]
  for (let index = 0; index < MINIMUM_CODEX_VERSION.length; index += 1) {
    if (actual[index]! > MINIMUM_CODEX_VERSION[index]!) return true
    if (actual[index]! < MINIMUM_CODEX_VERSION[index]!) return false
  }
  return true
}

export function resolveUpdaterCodexBinary(
  source: Record<string, string | undefined> = process.env,
  runtimeExecutable = process.execPath,
  allowScriptForTesting = false,
): string {
  const configured = source.ZEROKUN_CODEX_BIN
  if (configured && !configured.startsWith('/')) {
    fail('ZEROKUN_CODEX_BINは絶対pathで指定してください')
  }
  const home = source.HOME
  const candidates = configured
    ? [configured]
    : [
        ...(home ? [join(home, '.local', 'bin', 'codex')] : []),
        join(dirname(runtimeExecutable), 'codex'),
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
      ]
  for (const candidate of candidates) {
    const physical = secureExecutable(candidate)
    if (physical) {
      let native: string | null = null
      try { native = candidateCodexExecutable(physical) } catch {}
      if (native && codexVersionIsSupported(native, source, !allowScriptForTesting)) return physical
    }
    if (configured) {
      fail('ZEROKUN_CODEX_BINは安全なCodex CLI 0.149.0以上を指定してください')
    }
  }
  fail('信頼できるnative Codex CLI 0.149.0以上を解決できません。先にbootstrap-macos.shを実行してください')
}

export function updaterTrustedToolPath(trustedCodexDirectory: string): string {
  return [...new Set([trustedCodexDirectory, ...TRUSTED_TOOL_PATH.split(':')])].join(':')
}

function candidateCodexExecutable(codexBin: string): string {
  if (!codexBin.endsWith('.js')) return codexBin
  const packageRoot = dirname(dirname(codexBin))
  try {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      name?: unknown
    }
    if (packageJson.name !== '@openai/codex') fail('Codex npm package identityが不正です')
  } catch (error) {
    if (error instanceof Error && error.message === 'Codex npm package identityが不正です') throw error
    fail('Codex npm package identityを検証できません')
  }
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform
  const architecture = process.arch === 'arm64' ? 'arm64' : process.arch
  const target = process.platform === 'darwin'
    ? process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    : null
  if (!target) fail('candidate検証用Codex binaryをこのplatformで解決できません')
  const native = join(
    packageRoot,
    'node_modules',
    '@openai',
    `codex-${platform}-${architecture}`,
    'vendor',
    target,
    'bin',
    'codex',
  )
  const physical = secureExecutable(native)
  if (!physical) fail('candidate検証用Codex native binaryを安全に解決できません')
  return physical
}

export function stageVerifiedCandidateCodex(
  parent: string,
  codexBin: string,
  source: Record<string, string | undefined> = process.env,
): { directory: string; executable: string } {
  const directory = join(parent, 'trusted-bin')
  mkdirSync(directory, { mode: 0o700 })
  const executable = join(directory, 'codex')
  copySecureExecutable(candidateCodexExecutable(codexBin), executable, () => {}, true)
  if (!stagedCodexVersionIsSupported(executable, source)) {
    fail('stagingしたCodex CLIが0.149.0以上ではありません')
  }
  chmodSync(executable, 0o500)
  chmodSync(directory, 0o500)
  return { directory, executable }
}

type UpdatePhase = 'prepared' | 'fast-forwarded' | 'setup-applied' | 'rolling-back'

export interface UpdateJournal {
  version: 1
  id: string
  phase: UpdatePhase
  repoPath: string
  branch: string
  originalHead: string
  targetHead: string
  projectDir: string
  setupScript: string
  databasePath: string | null
  databaseBackup: string | null
  noRestart: boolean
}

const decoder = new TextDecoder()
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000
const DEFAULT_GIT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_VERIFY_TIMEOUT_MS = 30 * 60_000
export const DEFAULT_SETUP_WORK_MS = 15 * 60_000
export const DEFAULT_SETUP_DRAIN_SECONDS = 21_600
const MAX_SETUP_DRAIN_SECONDS = 7 * 24 * 60 * 60
interface UpdateExecutionPolicy {
  allowLocalRemotes: boolean
  skipCodexPermissionPreflight: boolean
}

const PRODUCTION_EXECUTION: Readonly<UpdateExecutionPolicy> = Object.freeze({
  allowLocalRemotes: false,
  skipCodexPermissionPreflight: false,
})
const TEST_EXECUTION: Readonly<UpdateExecutionPolicy> = Object.freeze({
  allowLocalRemotes: true,
  skipCodexPermissionPreflight: true,
})
let executionPolicy: Readonly<UpdateExecutionPolicy> = PRODUCTION_EXECUTION

/** Test harness entry: production CLI never selects this policy from environment or argv. */
export async function withUpdateTestPolicy<T>(action: () => T | Promise<T>): Promise<T> {
  if (executionPolicy !== PRODUCTION_EXECUTION) throw new Error('nested update test policy')
  executionPolicy = TEST_EXECUTION
  try {
    return await action()
  } finally {
    executionPolicy = PRODUCTION_EXECUTION
  }
}

function timeoutFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) fail(`${name}が不正です`)
  return Math.floor(value)
}

export function setupTimeoutBudgetMs(
  environment: Record<string, string | undefined> = process.env,
): number {
  if (environment.ZEROKUN_LEGACY_CUTOVER !== '1') return DEFAULT_SETUP_WORK_MS
  const raw = environment.ZEROKUN_SETUP_DRAIN_SECONDS
    ?? String(DEFAULT_SETUP_DRAIN_SECONDS)
  if (!/^\d+$/.test(raw)) fail('ZEROKUN_SETUP_DRAIN_SECONDSが不正です')
  const drainSeconds = Number(raw)
  if (!Number.isSafeInteger(drainSeconds)
    || drainSeconds < 0 || drainSeconds > MAX_SETUP_DRAIN_SECONDS) {
    fail('ZEROKUN_SETUP_DRAIN_SECONDSが不正です')
  }
  return drainSeconds * 1_000 + DEFAULT_SETUP_WORK_MS
}

export function resolveSetupTimeoutMs(
  environment: Record<string, string | undefined> = process.env,
  allowShortTestTimeout = false,
): number {
  const budget = setupTimeoutBudgetMs(environment)
  const raw = environment.ZEROKUN_UPDATE_SETUP_TIMEOUT_MS
  if (raw === undefined || raw === '') return budget
  const configured = Number(raw)
  if (!Number.isFinite(configured) || configured <= 0) {
    fail('ZEROKUN_UPDATE_SETUP_TIMEOUT_MSが不正です')
  }
  const normalized = Math.floor(configured)
  if (!allowShortTestTimeout && normalized < budget) {
    fail(`ZEROKUN_UPDATE_SETUP_TIMEOUT_MSは${budget}ms以上にしてください`)
  }
  return normalized
}

function gitConfigOverrides(): string[] {
  return [
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'credential.helper=',
    'core.sshCommand=/usr/bin/false',
    'http.proxy=',
    'http.sslVerify=true',
    'protocol.allow=never',
    'protocol.https.allow=always',
    `protocol.file.allow=${executionPolicy.allowLocalRemotes ? 'always' : 'never'}`,
  ]
}

function hardenedGitArgs(args: string[]): string[] {
  if (args[0] !== 'git') return args
  return ['/usr/bin/git', ...gitConfigOverrides().flatMap(value => ['-c', value]), ...args.slice(1)]
}

function hardenedGitEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...buildUpdaterEnvironment(source),
    PATH: TRUSTED_TOOL_PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GIT_PAGER: 'cat',
  }
}

function output(message: string): void {
  process.stdout.write(`${message}\n`)
}

function fail(message: string): never {
  throw new Error(message)
}

function command(
  args: string[],
  options: { cwd?: string; inherit?: boolean; env?: Record<string, string | undefined> } = {},
): CommandResult {
  const commandArgs = hardenedGitArgs(args)
  const result = Bun.spawnSync(commandArgs, {
    cwd: options.cwd,
    env: args[0] === 'git'
      ? hardenedGitEnvironment(options.env ?? process.env)
      : options.env ?? process.env,
    stdin: 'ignore',
    stdout: options.inherit ? 'inherit' : 'pipe',
    stderr: options.inherit ? 'inherit' : 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout ? decoder.decode(result.stdout).trim() : '',
    stderr: result.stderr ? decoder.decode(result.stderr).trim() : '',
  }
}

function requireCommand(
  args: string[],
  options: { cwd?: string; inherit?: boolean; env?: Record<string, string | undefined> } = {},
): string {
  const result = command(args, options)
  if (result.exitCode !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n')
    fail(`コマンド失敗: ${args.join(' ')}${detail ? `\n${detail}` : ''}`)
  }
  return result.stdout
}

async function collectCommandStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader()
  const outputDecoder = new TextDecoder()
  let output = ''
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      output = (output + outputDecoder.decode(value, { stream: true })).slice(-1_048_576)
    }
    return (output + outputDecoder.decode()).slice(-1_048_576)
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

const PROCESS_GROUP_GATE_SCRIPT = [
  'IFS= read -r zerokun_gate || exit 125',
  '[ "$zerokun_gate" = start ] || exit 125',
  'IFS= read -r zerokun_delegate_token || exit 125',
  'zerokun_bun=$1',
  'zerokun_lock_tool=$2',
  'zerokun_lock_file=$3',
  'zerokun_helper_root=$4',
  'shift 4',
  'zerokun_probe_dir="$(/usr/bin/mktemp -d /tmp/zerokun-command-group.XXXXXX)" || exit 125',
  '/bin/chmod 0700 "$zerokun_probe_dir" || exit 125',
  "trap '/bin/rm -rf -- \"$zerokun_probe_dir\"' EXIT",
  'zerokun_signal_status=0',
  "trap 'zerokun_signal_status=129' HUP",
  "trap 'zerokun_signal_status=130' INT",
  "trap 'zerokun_signal_status=143' TERM",
  'zerokun_command_status=0',
  '"$@" || zerokun_command_status=$?',
  '[ "$zerokun_signal_status" = 0 ] || zerokun_command_status="$zerokun_signal_status"',
  // Keep the delegated leader alive until every non-detached descendant in
  // its group exits. If reaping fails, the persisted delegate remains a
  // fail-closed barrier after the updater itself exits.
  'while :; do',
  '  /bin/ps -axo pid=,pgid= > "$zerokun_probe_dir/processes" &',
  '  zerokun_probe_pid=$!',
  '  wait "$zerokun_probe_pid" || { /bin/sleep 0.05; continue; }',
  "  /usr/bin/awk -v group=\"$$\" -v self=\"$$\" -v probe=\"$zerokun_probe_pid\" '",
  '    $2 == group { seen=1; if ($1 != self && $1 != probe) other=1 }',
  '    END { if (!seen) code=2; else if (other) code=0; else code=1; exit code }',
  "  ' \"$zerokun_probe_dir/processes\"",
  '  zerokun_group_status=$?',
  '  case "$zerokun_group_status" in',
  '    1) break ;;',
  '    *) /bin/sleep 0.05 ;;',
  '  esac',
  'done',
  '"$zerokun_bun" --config=/dev/null --no-env-file "$zerokun_lock_tool" quiescent "$zerokun_lock_file" "$zerokun_delegate_token" || exit 125',
  'exit "$zerokun_command_status"',
].join('\n')

export function processGroupCleanupIsUncertain(input: {
  remaining: readonly number[]
  terminationError?: unknown
  finalReapError?: unknown
  trackingError?: unknown
  cleanupProtectionError?: unknown
}): boolean {
  return input.remaining.length > 0
    || input.terminationError !== undefined
    || input.finalReapError !== undefined
    || input.trackingError !== undefined
    || input.cleanupProtectionError !== undefined
}

async function requireCommandAsync(
  args: string[],
  options: {
    cwd?: string
    inherit?: boolean
    env?: Record<string, string | undefined>
    signal?: AbortSignal
    timeoutMs?: number
    processGroupLease?: ProcessGroupLeaseCoordinator
  } = {},
): Promise<string> {
  if (options.signal?.aborted) fail('更新を中断しました')
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('command timeoutが不正です')
  const commandArgs = hardenedGitArgs(args)
  const spawnedArgs = options.processGroupLease
    ? [
        '/bin/bash', '-c', PROCESS_GROUP_GATE_SCRIPT, 'zerokun-command-gate',
        process.execPath, options.processGroupLease.gateLockTool,
        options.processGroupLease.quiescenceLockFile,
        options.processGroupLease.gateHelperRoot, ...commandArgs,
      ]
    : commandArgs
  const proc = Bun.spawn(spawnedArgs, {
    cwd: options.cwd,
    env: args[0] === 'git'
      ? hardenedGitEnvironment(options.env ?? process.env)
      : options.env ?? process.env,
    stdin: options.processGroupLease ? 'pipe' : 'ignore',
    stdout: options.inherit ? 'inherit' : 'pipe',
    stderr: options.inherit ? 'inherit' : 'pipe',
    detached: process.platform !== 'win32',
  })
  const tracked = new Map<number, string>()
  let rootIdentity: ReturnType<typeof seedTrackedProcess>
  try {
    rootIdentity = seedTrackedProcess(proc.pid, tracked)
    if (process.platform !== 'win32' && rootIdentity.pgid !== rootIdentity.pid) {
      throw new Error(`command gate ${proc.pid}を独立process groupへ起動できません`)
    }
  } catch (error) {
    try { proc.stdin?.end() } catch {}
    const exited = await Promise.race([
      proc.exited.then(() => true, () => true),
      Bun.sleep(500).then(() => false),
    ])
    if (!exited) {
      throw new Error(
        `command gate ${proc.pid}のgenerationを取得できず、安全に停止できません`,
        { cause: error },
      )
    }
    throw error
  }
  let tracking = true
  let trackingError: unknown
  let timedOut = false
  let termination: Promise<number[]> | undefined
  let terminationError: unknown
  let directTermination: Promise<void> | undefined
  let delegated: ProcessLockDelegate | undefined
  let cleanupProtected = false
  let cleanupProtectionError: unknown
  const protectCleanup = () => {
    if (!delegated || cleanupProtected) return
    try {
      options.processGroupLease!.protect(delegated)
      cleanupProtected = true
    } catch (error) {
      cleanupProtectionError = error
    }
  }
  const terminateDirect = () => {
    directTermination ??= (async () => {
      // The normal reaper already attempted graceful TERM. Its failure path
      // uses only the spawn-time exact generation and never a bare PID/PGID.
      if (!signalProcessGroupIfLeaderLive(rootIdentity, 'SIGKILL')) {
        signalProcessIfLive(rootIdentity, 'SIGKILL')
      }
      const exitedAfterKill = await Promise.race([
        proc.exited.then(() => true, () => true),
        Bun.sleep(5_000).then(() => false),
      ])
      if (!exitedAfterKill) throw new Error(`direct child ${proc.pid}を停止できません`)
    })()
  }
  const terminate = () => {
    protectCleanup()
    termination ??= reapTrackedProcesses({
      rootPids: [proc.pid],
      groupId: proc.pid,
      tracked,
      termGraceMs: 5_000,
    }).catch(error => {
      terminationError = error
      terminateDirect()
      return []
    })
  }
  const tracker = (async () => {
    try {
      while (tracking) {
        captureTrackedProcesses([proc.pid], proc.pid, tracked)
        await Bun.sleep(100)
      }
    } catch (error) {
      trackingError = error
      terminate()
    }
  })()
  options.signal?.addEventListener('abort', terminate, { once: true })
  if (options.signal?.aborted) terminate()
  const timeout = setTimeout(() => {
    if (proc.exitCode !== null) return
    timedOut = true
    terminate()
  }, timeoutMs)
  let gateError: unknown
  if (options.processGroupLease) {
    const gateInput = proc.stdin
    try {
      if (!gateInput) fail('process group gate stdinを作成できません')
      delegated = options.processGroupLease.delegate(proc.pid)
      gateInput.write(`start\n${encodeProcessLockDelegate(delegated)}\n`)
      gateInput.end()
    } catch (error) {
      gateError = error
      try { gateInput?.end() } catch {}
      terminate()
    }
  }
  const outputController = new AbortController()
  const stdoutPromise = options.inherit
    ? Promise.resolve('')
    : collectCommandStream(proc.stdout!, outputController.signal)
  const stderrPromise = options.inherit
    ? Promise.resolve('')
    : collectCommandStream(proc.stderr!, outputController.signal)
  const outputCompletion = Promise.all([stdoutPromise, stderrPromise])
  let exitCode = -1
  let exitError: unknown
  try {
    exitCode = await proc.exited
  } catch (error) {
    exitError = error
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', terminate)
    tracking = false
    await tracker
  }
  if (termination) await termination
  if (terminationError && directTermination) await directTermination
  // Even a natural gate exit may have skipped its quiescence write (for
  // example, external SIGKILL). Persist the cleanup intent before the final
  // generation-aware scan. A gate that already wrote quiescent is unchanged.
  protectCleanup()
  let remaining: number[] = []
  let finalReapError: unknown
  try {
    remaining = await reapTrackedProcesses({
      rootPids: [],
      groupId: proc.pid,
      tracked,
      signalGroup: false,
    })
  } catch (error) {
    finalReapError = error
  }
  await Promise.race([outputCompletion, Bun.sleep(500)])
  outputController.abort()
  let stdout = ''
  let stderr = ''
  let outputError: unknown
  try {
    [stdout, stderr] = await outputCompletion
  } catch (error) {
    outputError = error
  }
  const cleanupUncertain = processGroupCleanupIsUncertain({
    remaining,
    terminationError,
    finalReapError,
    trackingError,
    cleanupProtectionError,
  })
  if (cleanupUncertain) {
    const cleanupError = cleanupProtectionError ?? trackingError ?? terminationError ?? finalReapError
      ?? new Error(`子processを回収できませんでした: ${remaining.join(', ')}`)
    if (delegated) {
      try {
        options.processGroupLease!.block(delegated)
      } catch (blockError) {
        throw new Error(
          `子process cleanupが不確実でlockの永続blockにも失敗しました: ${String(blockError)}`,
          { cause: cleanupError },
        )
      }
    }
    throw cleanupError
  }
  // Only a clean final scan may remove the persisted delegate. Timeout and
  // command failures are evaluated afterwards so a verified-quiescent group
  // can still roll back safely.
  if (delegated) options.processGroupLease!.undelegate(delegated)
  if (gateError) throw gateError
  if (exitError) throw exitError
  if (outputError) throw outputError
  if (timedOut) fail(`コマンドが${timeoutMs}msでtimeoutしました: ${args.join(' ')}`)
  if (options.signal?.aborted) fail('更新を中断しました')
  if (exitCode !== 0) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
    fail(`コマンド失敗: ${args.join(' ')}${detail ? `\n${detail}` : ''}`)
  }
  return stdout.trim()
}

export function processStateIsAlive(state: string): boolean {
  const normalized = state.trim().toUpperCase()
  return normalized.length > 0 && !normalized.startsWith('Z')
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
  const state = command(['/bin/ps', '-o', 'state=', '-p', String(pid)])
  // kill(2) confirmed that the PID exists. A failed/empty ps observation is
  // unknown, not dead; callers must keep the lock and fail closed.
  return state.exitCode !== 0 || state.stdout.length === 0 || processStateIsAlive(state.stdout)
}

function readPid(path: string): number | undefined {
  try {
    const content = readOptionalPrivateFile(path)
    if (content === null) return undefined
    const pid = Number(content.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function resolveRootRepo(): string {
  if (process.env.ZEROKUN_REPO_DIR) return realpathSync(process.env.ZEROKUN_REPO_DIR)
  const invoked = process.argv[1] ? realpathSync(process.argv[1]) : import.meta.path
  return realpathSync(join(dirname(invoked), '..'))
}

type UpdateLockCoordinator = ProcessGroupLeaseCoordinator & {
  path: string
  assertExclusive: () => void
  release: () => void
}

function acquireUpdateLock(stateDir: string): UpdateLockCoordinator {
  prepareManagedStateRoot(stateDir)
  const lockPath = join(stateDir, 'update.lock')
  const pidPath = join(lockPath, 'pid')
  ensureManagedDirectory(stateDir, lockPath)
  const attempt = tryAcquireProcessLock(pidPath)
  if (attempt.acquired === false) {
    if (attempt.kind === 'held') {
      fail(`別のzerokun-updateが実行中です (PID ${attempt.heldPid})`)
    }
    fail('zerokun-update lockの所有者を確認できません。安全のため更新を中止します')
  }
  let gateHelper: ReturnType<typeof prepareProcessGroupGateHelper>
  try {
    gateHelper = prepareProcessGroupGateHelper()
  } catch (error) {
    releaseProcessLock(pidPath, attempt.lease)
    throw error
  }
  let held = true
  let activeDelegate: ProcessLockDelegate | undefined
  const lease: ProcessLockLease = attempt.lease
  return {
    path: lockPath,
    quiescenceLockFile: pidPath,
    gateHelperRoot: gateHelper.root,
    gateLockTool: gateHelper.lockTool,
    delegate: (pid: number) => {
      if (!held) fail('zerokun-update lockは既に解放されています')
      if (activeDelegate) fail('zerokun-update lockには既に実行中の委譲があります')
      const delegated = delegateProcessLock(pidPath, lease, pid)
      if (!delegated) fail('子processへzerokun-update lockを安全に委譲できません')
      activeDelegate = delegated
      return delegated
    },
    undelegate: (delegate: ProcessLockDelegate) => {
      if (!held || !undelegateProcessLock(pidPath, delegate)) {
        fail('子processのzerokun-update lock委譲を安全に解除できません')
      }
      activeDelegate = undefined
    },
    block: (delegate: ProcessLockDelegate) => {
      if (!held || !activeDelegate
        || activeDelegate.pid !== delegate.pid
        || activeDelegate.nonce !== delegate.nonce
        || !blockProcessLockDelegate(pidPath, delegate)) {
        fail('子process cleanup不確実性をzerokun-update lockへ記録できません')
      }
    },
    protect: (delegate: ProcessLockDelegate) => {
      if (!held || !activeDelegate
        || activeDelegate.pid !== delegate.pid
        || activeDelegate.nonce !== delegate.nonce
        || !protectProcessLockDelegateCleanup(pidPath, delegate)) {
        fail('子process cleanupのwrite-ahead保護を記録できません')
      }
    },
    assertExclusive: () => {
      if (!held || activeDelegate || !processLockLeaseIsExclusive(pidPath, lease)) {
        fail('実行中または観測不能な子processが残っているためrollbackを開始できません')
      }
    },
    release: () => {
      if (!held) return
      if (activeDelegate || !releaseProcessLock(pidPath, lease)) {
        fail('zerokun-update lockを安全に解放できません')
      }
      held = false
      rmSync(gateHelper.root, { recursive: true, force: true })
    },
  }
}

async function requireSetupCommandAsync(
  setupScript: string,
  updateLock: UpdateLockCoordinator,
  options: {
    cwd: string
    inherit: boolean
    env: Record<string, string | undefined>
    signal?: AbortSignal
    timeoutMs: number
  },
): Promise<void> {
  await requireCommandAsync(['/bin/bash', setupScript], {
    ...options,
    processGroupLease: updateLock,
  })
}

/** Behavioral harness for the production gate→delegate topology. */
export async function runLeasedCommandForTests(
  args: string[],
  stateDir: string,
  options: {
    cwd?: string
    env?: Record<string, string | undefined>
    timeoutMs?: number
  } = {},
): Promise<{ output: string; groupId: number }> {
  const coordinator = acquireUpdateLock(stateDir)
  let groupId = 0
  const lease: ProcessGroupLeaseCoordinator = {
    quiescenceLockFile: coordinator.quiescenceLockFile,
    gateHelperRoot: coordinator.gateHelperRoot,
    gateLockTool: coordinator.gateLockTool,
    delegate: pid => {
      const delegated = coordinator.delegate(pid)
      groupId = delegated.groupId ?? delegated.pid
      return delegated
    },
    undelegate: delegate => coordinator.undelegate(delegate),
    block: delegate => coordinator.block(delegate),
    protect: delegate => coordinator.protect(delegate),
  }
  try {
    const output = await requireCommandAsync(args, {
      ...options,
      processGroupLease: lease,
    })
    if (groupId <= 1) fail('test command groupを取得できません')
    return { output, groupId }
  } finally {
    coordinator.release()
  }
}

export function activeJobCounts(raw: string): { queued: number; running: number } {
  const jobs = JSON.parse(raw) as Array<{ status?: string; runtime?: string }>
  if (!Array.isArray(jobs)) fail('job statusが配列ではありません')
  // The first Codex update may still call an older installed runner whose
  // records have no runtime field, so those remain relevant. Once migrated,
  // explicit Claude history must not block Codex updates forever.
  const relevant = jobs.filter(job => job.runtime === undefined || job.runtime === 'codex')
  return {
    queued: relevant.filter(job => job.status === 'queued').length,
    running: relevant.filter(job => job.status === 'running').length,
  }
}

export function activeJobCountsFromDatabase(dbPath: string): {
  queued: number
  running: number
} {
  const db = new Database(dbPath, { readonly: true })
  try {
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all()
    const hasRuntime = columns.some(column => column.name === 'runtime')
    const rows = db.query<{ status: string; count: number }, []>(
      `SELECT status, COUNT(*) AS count FROM jobs
       WHERE status IN ('queued', 'running')${hasRuntime ? " AND runtime = 'codex'" : ''}
       GROUP BY status`,
    ).all()
    return {
      queued: rows.find(row => row.status === 'queued')?.count ?? 0,
      running: rows.find(row => row.status === 'running')?.count ?? 0,
    }
  } finally {
    db.close()
  }
}

function requireSafeDatabaseSource(
  databasePath: string,
): NonNullable<ReturnType<typeof lstatSync>> {
  const parent = dirname(databasePath)
  const parentMetadata = lstatSync(parent)
  const parentOwner = typeof process.getuid !== 'function' || parentMetadata.uid === process.getuid()
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || !parentOwner
    || (Number(parentMetadata.mode) & 0o022) !== 0) {
    fail(`unsafe SQLite parent directory: ${parent}`)
  }
  let databaseMetadata: NonNullable<ReturnType<typeof lstatSync>> | undefined
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    let metadata: NonNullable<ReturnType<typeof lstatSync>>
    try { metadata = lstatSync(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path !== databasePath) continue
      throw error
    }
    const owner = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !owner) {
      fail(`unsafe SQLite file: ${path}`)
    }
    if (path === databasePath) databaseMetadata = metadata
  }
  if (!databaseMetadata) fail(`SQLite database does not exist: ${databasePath}`)
  return databaseMetadata!
}

async function waitForRunningJobs(
  stateDir: string,
  timeoutSeconds: number,
  jobRunnerFile: string,
  signal?: AbortSignal,
): Promise<void> {
  const dbPath = resolveZeroJobDatabasePath(stateDir)
  if (!existsSync(dbPath)) {
    output('   queue: 未導入（初回更新）')
    return
  }
  requireSafeDatabaseSource(dbPath)

  const startedAt = Date.now()
  while (true) {
    if (signal?.aborted) fail('更新を中断しました')
    let counts: { queued: number; running: number }
    try {
      counts = activeJobCountsFromDatabase(dbPath)
    } catch (error) {
      fail(`queue状態を取得できません: ${error}`)
    }
    if (counts.running === 0) {
      output(`   queue: 実行中0件 / 待機${counts.queued}件（更新中はclaim停止）`)
      return
    }
    const runnerPid = readPid(join(stateDir, 'job-runner.lock', 'pid'))
    const runnerCommand = runnerPid
      ? command(['/bin/ps', '-o', 'command=', '-p', String(runnerPid)])
      : { exitCode: 1, stdout: '', stderr: '' }
    const runnerAlive = Boolean(
      runnerPid && pidIsAlive(runnerPid) && runnerCommand.exitCode === 0
      && /job-runner\.ts\s+daemon(?:\s|$)/.test(runnerCommand.stdout),
    )
    if (Date.now() - startedAt >= timeoutSeconds * 1000) {
      fail(`実行中job ${counts.running}件があるため更新を停止しました`)
    }
    if (!runnerAlive) {
      output(`   queue: 停止したrunnerの実行中job ${counts.running}件を安全に回収します`)
      requireCommand([process.execPath, jobRunnerFile, 'recover-interrupted'], {
        env: { ...process.env, ZEROKUN_STATE_DIR: stateDir },
      })
      continue
    }
    output(`   queue: 実行中job ${counts.running}件の完了待ち...`)
    await Bun.sleep(5_000)
  }
}

function assertRepositoryClean(repo: Repository): void {
  if (!existsSync(join(repo.path, '.git'))) fail(`${repo.label} のcloneがありません: ${repo.path}`)
  const dirty = requireCommand(['git', 'status', '--porcelain'], { cwd: repo.path })
  if (dirty) fail(`${repo.label} に未コミット変更があります。更新せず停止しました`)
}

export function assertSafeLocalGitConfig(
  repo: Repository,
  options: { requireTracking?: boolean } = {},
): void {
  const entries = requireCommand(
    ['git', 'config', '--local', '--no-includes', '--null', '--list'],
    { cwd: repo.path },
  ).split('\0').filter(Boolean)
  const safeCore = /^core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)$/i
  const safeRemote = /^remote\.origin\.(?:url|fetch)$/i
  const safeBranch = /^branch\..+\.(?:remote|merge)$/i
  const safeUser = /^user\.(?:name|email)$/i
  for (const entry of entries) {
    const key = entry.split(/\n|=/, 1)[0] ?? ''
    if (![safeCore, safeRemote, safeBranch, safeUser].some(pattern => pattern.test(key))) {
      fail(`${repo.label} のlocal Git configに許可されていない設定があります: ${key}`)
    }
  }
  const values = (key: string): string[] => {
    const result = command(
      ['git', 'config', '--local', '--no-includes', '--null', '--get-all', key],
      { cwd: repo.path },
    )
    if (result.exitCode === 1) return []
    if (result.exitCode !== 0) fail(`${repo.label} のlocal Git configを検証できません: ${key}`)
    return result.stdout.split('\0').filter(Boolean)
  }
  const requireOnly = (key: string, expected: string): void => {
    const actual = values(key)
    if (actual.length !== 1 || actual[0] !== expected) {
      fail(`${repo.label} のlocal Git configが安全な値ではありません: ${key}`)
    }
  }
  requireOnly('remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
  const configuredBranches = new Set<string>()
  for (const entry of entries) {
    const key = entry.split(/\n|=/, 1)[0] ?? ''
    const match = /^branch\.(.+)\.(?:remote|merge)$/i.exec(key)
    if (match) configuredBranches.add(match[1]!)
  }
  for (const branch of configuredBranches) {
    requireOnly(`branch.${branch}.remote`, 'origin')
    requireOnly(`branch.${branch}.merge`, `refs/heads/${branch}`)
  }
  const branchRemoteKey = `branch.${repo.branch}.remote`
  const branchMergeKey = `branch.${repo.branch}.merge`
  const hasTracking = values(branchRemoteKey).length > 0 || values(branchMergeKey).length > 0
  if (options.requireTracking !== false || hasTracking) {
    requireOnly(branchRemoteKey, 'origin')
    requireOnly(branchMergeKey, `refs/heads/${repo.branch}`)
  }
}

export function assertExpectedOrigin(repo: Repository): void {
  const remote = requireCommand(['git', 'remote', 'get-url', 'origin'], { cwd: repo.path })
  if (executionPolicy.allowLocalRemotes) return
  if (remote !== 'https://github.com/zerocolored/zero-codex.git'
    && remote !== 'https://github.com/zerocolored/zero-codex') {
    fail(`${repo.label} のoriginは公開Codex版のHTTPS URLではありません: ${remote}`)
  }
}

function refExists(repo: Repository, ref: string): boolean {
  return command(['git', 'show-ref', '--verify', '--quiet', ref], { cwd: repo.path }).exitCode === 0
}

function isAncestor(repo: Repository, ancestor: string, descendant: string): boolean {
  return command(['git', 'merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repo.path,
  }).exitCode === 0
}

export async function preflightRepositories(
  repositories: Repository[],
  signal?: AbortSignal,
  processGroupLease?: ProcessGroupLeaseCoordinator,
): Promise<PinnedRepository[]> {
  for (const repo of repositories) {
    assertSafeLocalGitConfig(repo)
    assertExpectedOrigin(repo)
    assertRepositoryClean(repo)
  }
  const originalStates = new Map(repositories.map(repo => [repo.path, {
    originalHead: requireCommand(['git', 'rev-parse', 'HEAD'], { cwd: repo.path }),
    originalBranch: requireCommand(['git', 'branch', '--show-current'], { cwd: repo.path }),
  }]))
  for (const repo of repositories) {
    output(`   fetch: ${repo.label}`)
    await requireCommandAsync([
      'git', 'fetch', '--no-tags', '--prune', 'origin',
      `+refs/heads/${repo.branch}:refs/remotes/origin/${repo.branch}`,
    ], {
      cwd: repo.path,
      signal,
      processGroupLease,
      timeoutMs: timeoutFromEnvironment('ZEROKUN_UPDATE_GIT_TIMEOUT_MS', DEFAULT_GIT_TIMEOUT_MS),
    })
  }

  return repositories.map(repo => {
    const remoteRef = `refs/remotes/origin/${repo.branch}`
    if (!refExists(repo, remoteRef)) {
      fail(`${repo.label} に origin/${repo.branch} がありません`)
    }
    const currentBranch = requireCommand(['git', 'branch', '--show-current'], { cwd: repo.path })
    if (!currentBranch) fail(`${repo.label} はdetached HEADです`)
    if (currentBranch !== repo.branch) {
      fail(`${repo.label} は ${repo.branch} branchで更新してください（現在: ${currentBranch}）`)
    }
    const targetHead = requireCommand(['git', 'rev-parse', remoteRef], { cwd: repo.path })
    if (!isAncestor(repo, 'HEAD', targetHead)) {
      fail(`${repo.label} の ${currentBranch} は origin/${repo.branch}へ未反映です。更新せず停止しました`)
    }
    if (
      refExists(repo, `refs/heads/${repo.branch}`)
      && !isAncestor(repo, repo.branch, targetHead)
    ) {
      fail(`${repo.label} のlocal ${repo.branch}がorigin/${repo.branch}から分岐しています`)
    }
    return { ...repo, targetHead, ...originalStates.get(repo.path)! }
  })
}

export function assertPinnedRepositoryState(repo: PinnedRepository): void {
  assertRepositoryClean(repo)
  const branch = requireCommand(['git', 'branch', '--show-current'], { cwd: repo.path })
  const head = requireCommand(['git', 'rev-parse', 'HEAD'], { cwd: repo.path })
  if (branch !== repo.originalBranch || head !== repo.originalHead) {
    fail(
      `${repo.label} は候補検証中にbranchまたはHEADが変更されました。`
      + ' ユーザー作業を保持するため更新せず停止します',
    )
  }
}

export function fastForwardRepositories(repositories: PinnedRepository[]): void {
  for (const repo of repositories) {
    output(`   update: ${repo.label}`)
    if (refExists(repo, `refs/heads/${repo.branch}`)) {
      requireCommand(['git', 'switch', '--quiet', repo.branch], { cwd: repo.path })
    } else {
      requireCommand(
        ['git', 'switch', '--quiet', '--create', repo.branch, '--track', `origin/${repo.branch}`],
        { cwd: repo.path },
      )
    }
    requireCommand(['git', 'merge', '--quiet', '--ff-only', repo.targetHead], {
      cwd: repo.path,
    })
    const applied = requireCommand(['git', 'rev-parse', 'HEAD'], { cwd: repo.path })
    if (applied !== repo.targetHead) {
      fail(`${repo.label} の適用commitが検証済みSHAと一致しません`)
    }
  }
}

function journalPath(stateDir: string): string {
  return join(stateDir, 'update-transaction.json')
}

function writeJournal(stateDir: string, journal: UpdateJournal): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const path = journalPath(stateDir)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(journal, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function readJournal(
  stateDir: string,
  expected: { repoPath: string; projectDir: string; setupScript: string },
): UpdateJournal | null {
  const path = journalPath(stateDir)
  if (!existsSync(path)) return null
  const metadata = lstatSync(path)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !ownerMatches) {
    fail(`更新transaction journalが安全な通常fileではありません: ${path}`)
  }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateJournal>
  const databasePath = resolveZeroJobDatabasePath(stateDir)
  const backupPath = typeof value.id === 'string'
    ? resolve(stateDir, 'update-rollback', value.id, 'jobs.sqlite3')
    : ''
  const databasePairIsValid = (
    (value.databasePath === null && value.databaseBackup === null)
    || (value.databasePath === databasePath && value.databaseBackup === backupPath)
  )
  if (value.version !== 1 || typeof value.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
    || !['prepared', 'fast-forwarded', 'setup-applied', 'rolling-back'].includes(value.phase ?? '')
    || value.repoPath !== expected.repoPath || typeof value.branch !== 'string'
    || !/^[0-9a-f]{40,64}$/.test(value.originalHead ?? '')
    || !/^[0-9a-f]{40,64}$/.test(value.targetHead ?? '')
    || value.projectDir !== expected.projectDir || value.setupScript !== expected.setupScript
    || typeof value.noRestart !== 'boolean' || !databasePairIsValid) {
    fail(`更新transaction journalが不正です: ${path}`)
  }
  return value as UpdateJournal
}

function snapshotDatabase(stateDir: string, id: string): {
  databasePath: string | null
  databaseBackup: string | null
} {
  const databasePath = resolveZeroJobDatabasePath(stateDir)
  if (!existsSync(databasePath)) return { databasePath: null, databaseBackup: null }
  const beforeOpen = requireSafeDatabaseSource(databasePath)
  const rollbackRoot = ensureManagedDirectory(stateDir, join(stateDir, 'update-rollback'))
  const backupDir = ensureManagedDirectory(stateDir, join(rollbackRoot, id))
  const databaseBackup = join(backupDir, 'jobs.sqlite3')
  const db = new Database(databasePath)
  try {
    const afterOpen = requireSafeDatabaseSource(databasePath)
    if (beforeOpen.dev !== afterOpen.dev || beforeOpen.ino !== afterOpen.ino) {
      fail(`SQLite database changed while opening: ${databasePath}`)
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const escaped = databaseBackup.replaceAll("'", "''")
    db.exec(`VACUUM INTO '${escaped}'`)
  } finally {
    db.close()
  }
  const metadata = lstatSync(databaseBackup)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !ownerMatches) {
    fail(`rollback DB backupが安全な通常fileではありません: ${databaseBackup}`)
  }
  chmodSync(databaseBackup, 0o600)
  return { databasePath, databaseBackup }
}

export function restoreRollbackDatabase(
  journal: Pick<UpdateJournal, 'databasePath' | 'databaseBackup'>,
): void {
  if (!journal.databasePath || !journal.databaseBackup) return
  if (!existsSync(journal.databaseBackup)) fail(`rollback DB backupがありません: ${journal.databaseBackup}`)
  const metadata = lstatSync(journal.databaseBackup)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !ownerMatches) {
    fail(`rollback DB backupが安全な通常fileではありません: ${journal.databaseBackup}`)
  }
  const temporary = `${journal.databasePath}.${process.pid}.rollback`
  rmSync(temporary, { force: true })
  copyFileSync(journal.databaseBackup, temporary)
  chmodSync(temporary, 0o600)
  rmSync(`${journal.databasePath}-wal`, { force: true })
  rmSync(`${journal.databasePath}-shm`, { force: true })
  renameSync(temporary, journal.databasePath)
}

export function clearJournal(
  stateDir: string,
  journal: UpdateJournal,
  warn: (message: string) => void = output,
): void {
  // The journal is the rollback authority, so removing it is the transaction's
  // commit point. A crash after this unlink can leave only an inert orphan
  // backup; deleting the backup first could instead leave an unrecoverable
  // journal that permanently blocks the gateway.
  rmSync(journalPath(stateDir), { force: true })
  if (!journal.databaseBackup) return
  try {
    const rollbackRoot = requireManagedDirectory(stateDir, join(stateDir, 'update-rollback'))
    const backupDir = requireManagedDirectory(stateDir, join(rollbackRoot, journal.id))
    rmSync(backupDir, { recursive: true, force: true })
  } catch (error) {
    warn(`⚠️ rollback backupの後処理を省略しました: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function validateRemoteTargets(
  repositories: PinnedRepository[],
  stateDir: string,
  processGroupLease: ProcessGroupLeaseCoordinator,
  signal?: AbortSignal,
): Promise<void> {
  for (const repo of repositories) {
    const parent = createUpdaterTemporaryDirectory('zerokun-update-candidate-')
    const checkout = join(parent, 'checkout')
    const isolatedHome = join(parent, 'home')
    try {
      mkdirSync(isolatedHome, { mode: 0o700 })
      mkdirSync(join(isolatedHome, 'tmp'), { recursive: true, mode: 0o700 })
      const remote = requireCommand(['git', 'remote', 'get-url', 'origin'], { cwd: repo.path })
      await requireCommandAsync(
        ['git', 'clone', '--quiet', '--no-local', '--no-checkout', remote, checkout],
        {
          signal,
          processGroupLease,
          timeoutMs: timeoutFromEnvironment('ZEROKUN_UPDATE_GIT_TIMEOUT_MS', DEFAULT_GIT_TIMEOUT_MS),
        },
      )
      await requireCommandAsync(['git', 'checkout', '--quiet', '--detach', repo.targetHead], {
        cwd: checkout,
        signal,
        processGroupLease,
        timeoutMs: timeoutFromEnvironment('ZEROKUN_UPDATE_GIT_TIMEOUT_MS', DEFAULT_GIT_TIMEOUT_MS),
      })
      await validateZero(checkout, isolatedHome, repo.path, stateDir, processGroupLease, signal)
    } finally {
      try { chmodSync(join(parent, 'trusted-bin'), 0o700) } catch {}
      let cleanupError: unknown
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          rmSync(parent, { recursive: true, force: true })
          cleanupError = undefined
          break
        } catch (error) {
          cleanupError = error
          await Bun.sleep(100)
        }
      }
      if (cleanupError) throw cleanupError
    }
  }
}

async function requireEffectiveCodexPermissionPreflight(
  codexBin: string,
  cwd: string,
  isolatedHome: string,
  overrides: string[],
  profile: string,
  environment: Record<string, string>,
  processGroupLease: ProcessGroupLeaseCoordinator,
  stateDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const specPath = join(isolatedHome, 'zerokun-effective-config-preflight.json')
  const resultPath = join(isolatedHome, 'zerokun-effective-config-preflight-result.json')
  const trustedHelper = realpathSync(join(import.meta.dir, 'codex-executor.ts'))
  atomicWritePrivateFile(specPath, JSON.stringify({
    version: 3,
    codexBin,
    cwd,
    overrides,
    profile,
    stateDir,
    resultPath,
  }) + '\n')
  try {
    await requireCommandAsync([
      process.execPath,
      '--config=/dev/null',
      '--no-env-file',
      trustedHelper,
      'verify-effective-config',
      specPath,
    ], {
      cwd,
      inherit: true,
      env: environment,
      signal,
      processGroupLease,
      timeoutMs: timeoutFromEnvironment(
        'ZEROKUN_UPDATE_VERIFY_TIMEOUT_MS',
        DEFAULT_VERIFY_TIMEOUT_MS,
      ),
    })
    const content = readOptionalPrivateFile(resultPath)
    if (content === null || content.length > 8 * 1024 * 1024) {
      fail('Codex config preflightの検証済み設定を取得できません')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      fail('Codex config preflightの検証済み設定が不正です')
    }
    const resolved = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { version?: unknown; overrides?: unknown }).overrides
      : undefined
    if ((parsed as { version?: unknown } | null)?.version !== 1
      || !Array.isArray(resolved)
      || resolved.length !== overrides.length
      || resolved.some(value => typeof value !== 'string'
        || value.length === 0 || value.length > 65_536 || value.includes('\0'))) {
      fail('Codex config preflightの検証済み設定が不正です')
    }
    return validateResolvedCandidatePermissionOverrides(overrides, resolved as string[])
  } finally {
    rmSync(specPath, { force: true })
    rmSync(resultPath, { force: true })
  }
}

export function validateResolvedCandidatePermissionOverrides(
  overrides: string[],
  resolved: string[],
): string[] {
  const originalMcp = overrides.findIndex(value => value.startsWith('mcp_servers='))
  const resolvedMcp = resolved.findIndex(value => value.startsWith('mcp_servers='))
  if (originalMcp < 0 || overrides[originalMcp] !== 'mcp_servers={}'
    || resolvedMcp !== originalMcp
    || overrides.filter(value => value.startsWith('mcp_servers=')).length !== 1
    || resolved.filter(value => value.startsWith('mcp_servers=')).length !== 1
    || resolved.some((value, index) => index !== originalMcp && value !== overrides[index])) {
    fail('Codex config preflightが許可外の設定を変更しました')
  }
  let document: Record<string, unknown>
  try {
    document = Bun.TOML.parse(resolved[resolvedMcp]!) as Record<string, unknown>
  } catch {
    fail('Codex config preflightのMCP設定が不正です')
  }
  if (Object.keys(document).length !== 1 || !Object.hasOwn(document, 'mcp_servers')) {
    fail('Codex config preflightのMCP設定が不正です')
  }
  const table = document.mcp_servers
  if (table === null || typeof table !== 'object' || Array.isArray(table)
    || Object.keys(table).length > 128) {
    fail('Codex config preflightのMCP設定が不正です')
  }
  for (const server of Object.values(table as Record<string, unknown>)) {
    if (server === null || typeof server !== 'object' || Array.isArray(server)) {
      fail('Codex config preflightのMCP設定が不正です')
    }
    const record = server as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const stdio = record.enabled === false
      && record.command === '/usr/bin/false'
      && Array.isArray(record.args) && record.args.length === 0
      && JSON.stringify(keys) === JSON.stringify(['args', 'command', 'enabled'])
    const http = record.enabled === false
      && record.url === 'http://127.0.0.1:9'
      && JSON.stringify(keys) === JSON.stringify(['enabled', 'url'])
    if (stdio === http) fail('Codex config preflightのMCP設定が不正です')
  }
  return resolved
}

export function buildCandidatePermissionOverrides(
  profile: string,
  filesystemToml: string,
): string[] {
  return [
    `permissions.${profile}.filesystem={${filesystemToml}}`,
    `permissions.${profile}.network.enabled=true`,
    `permissions.${profile}.network.domains={"*"="allow"}`,
    `default_permissions=${JSON.stringify(profile)}`,
    'approval_policy="never"',
    'notify=[]',
    'model_provider="openai"',
    'model_providers={}',
    'web_search="disabled"',
    'tools.web_search=false',
    'apps._default.enabled=false',
    'apps._default.default_tools_enabled=false',
    'apps._default.open_world_enabled=false',
    'apps._default.destructive_enabled=false',
    'features.network_proxy=true',
    'features.apps=false',
    'features.plugins=false',
    'features.remote_plugin=false',
    'features.hooks=false',
    'features.goals=false',
    'features.browser_use=false',
    'features.browser_use_external=false',
    'features.browser_use_full_cdp_access=false',
    'features.computer_use=false',
    'features.in_app_browser=false',
    'features.multi_agent=false',
    'features.skill_mcp_dependency_install=false',
    'shell_environment_policy.inherit="core"',
    'shell_environment_policy.exclude=["*TOKEN*","*SECRET*","*PASSWORD*","*KEY*","*PROXY*","SLACK_*","ZEROKUN_*","CODEX_HOME"]',
    'mcp_servers={}',
    'hooks={}',
  ]
}

async function validateZero(
  rootRepo: string,
  isolatedHome: string,
  liveRepo: string,
  stateDir: string,
  processGroupLease: ProcessGroupLeaseCoordinator,
  signal?: AbortSignal,
): Promise<void> {
  const verifyScript = join(rootRepo, 'zerokun', 'verify.sh')
  if (!existsSync(verifyScript)) fail(`候補commitに公開検証scriptがありません: ${verifyScript}`)
  output('   validate: frozen install + tests + typecheck + build + shell syntax')
  const codexBin = resolveUpdaterCodexBinary()
  const stagedCodex = stageVerifiedCandidateCodex(dirname(isolatedHome), codexBin)
  const trustedToolDirectory = stagedCodex.directory
  const stagedCodexBin = stagedCodex.executable
  const profile = `zerokun_update_${randomUUID().replaceAll('-', '')}`
  const filesystem = new Map<string, 'deny' | 'read' | 'write'>([
    [':minimal', 'read'],
    [realpathSync(homedir()), 'deny'],
    [realpathSync(liveRepo), 'deny'],
    [realpathSync(stateDir), 'deny'],
    [realpathSync(process.execPath), 'read'],
    [realpathSync(trustedToolDirectory), 'read'],
    [realpathSync(rootRepo), 'write'],
    [realpathSync(isolatedHome), 'write'],
  ])
  const filesystemToml = [...filesystem]
    .map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`)
    .join(',')
  const candidateEnvironment = buildCandidateEnvironment(isolatedHome)
  candidateEnvironment.PATH = updaterTrustedToolPath(trustedToolDirectory)
  let permissionOverrides = buildCandidatePermissionOverrides(profile, filesystemToml)
  if (!executionPolicy.skipCodexPermissionPreflight) {
    permissionOverrides = await requireEffectiveCodexPermissionPreflight(
      stagedCodexBin,
      rootRepo,
      isolatedHome,
      permissionOverrides,
      profile,
      candidateEnvironment,
      processGroupLease,
      stateDir,
      signal,
    )
  }
  await requireCommandAsync([
    stagedCodexBin,
    '-a', 'never',
    'sandbox',
    '-C', rootRepo,
    ...permissionOverrides.flatMap(value => ['-c', value]),
    '-P', profile,
    '--include-managed-config',
    '--',
    '/usr/bin/env', 'ZERO_CODEX_CANDIDATE_SANDBOX=1',
    '/bin/bash', verifyScript, '--candidate-sandbox',
  ], {
    cwd: rootRepo,
    inherit: true,
    signal,
    processGroupLease,
    timeoutMs: timeoutFromEnvironment(
      'ZEROKUN_UPDATE_VERIFY_TIMEOUT_MS',
      DEFAULT_VERIFY_TIMEOUT_MS,
    ),
    env: candidateEnvironment,
  })
}

export async function stopLockedProcess(
  lockFile: string,
  pid: number,
  label: string,
  commandPattern: RegExp,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<void> {
  if (!pidIsAlive(pid)) {
    if (!discardProcessLock(lockFile, pid) && readPid(lockFile) !== undefined) {
      fail(`${label} lockが停止確認中に変化したため更新を停止します`)
    }
    return
  }
  if (!processLockOwnerMatches(lockFile, pid, commandPattern)) {
    const currentLockPid = Number(readFileSync(lockFile, 'utf8').trim())
    const command = trackedProcessCommand(pid)
    if (currentLockPid === pid && commandPattern.test(command)) {
      fail(
        `${label} PID ${pid} は期待するprocessですがlock identityを検証できません。`
        + ' 稼働processを残したまま更新を停止します',
      )
    }
    output(`   stale lock: ${label} PID ${pid} は期待するprocessではないため停止しません`)
    if (!discardProcessLock(lockFile, pid)) {
      fail(`${label} lockの所有者が生存中または確認不能なため更新を停止します`)
    }
    return
  }
  output(`   stop: ${label} PID ${pid}`)
  const result = await stopProcessLockOwner(
    lockFile,
    pid,
    commandPattern,
    { signal, timeoutMs },
  )
  if (result === 'stopped') return
  if (result === 'aborted') fail('更新を中断しました')
  if (result === 'timeout') fail(`${label} PID ${pid} が正常終了しません`)
  fail(`${label} PID ${pid} のidentityをsignal直前に検証できません`)
}

function trackedProcessCommand(pid: number): string {
  const result = command(['/bin/ps', '-ww', '-o', 'command=', '-p', String(pid)])
  return result.exitCode === 0 ? result.stdout : ''
}

function matchingPids(pattern: string): number[] {
  const found = command(['/usr/bin/pgrep', '-f', pattern])
  if (found.exitCode !== 0 || !found.stdout) return []
  return found.stdout
    .split(/\s+/)
    .map(Number)
    .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
}

export async function waitForStableHealth(options: {
  observe: () => boolean
  requiredConsecutive: number
  maxChecks: number
  sleep: () => Promise<void>
}): Promise<void> {
  let consecutive = 0
  for (let check = 0; check < options.maxChecks; check += 1) {
    consecutive = options.observe() ? consecutive + 1 : 0
    if (consecutive >= options.requiredConsecutive) return
    await options.sleep()
  }
  fail('bot・bridge・runnerの安定稼働を確認できません')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function resolveTmuxPath(): string {
  const configured = process.env.ZEROKUN_TMUX_PATH
  if (configured && existsSync(configured)) return configured
  for (const candidate of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']) {
    if (existsSync(candidate)) return candidate
  }
  const found = command(['/usr/bin/which', 'tmux'])
  if (found.exitCode === 0 && found.stdout) return found.stdout
  fail('tmuxがありません。brew install tmux を実行してから再試行してください')
}

export function assertTmuxSessionAvailableOrOwned(options: {
  tmuxPath: string
  sessionName: string
  stateDir: string
}): void {
  if (command([options.tmuxPath, 'has-session', '-t', options.sessionName]).exitCode !== 0) return
  const panes = command([
    options.tmuxPath, 'list-panes', '-t', options.sessionName, '-F', '#{pane_pid}',
  ])
  const panePids = panes.exitCode === 0
    ? panes.stdout.split(/\s+/).map(Number).filter(pid => Number.isInteger(pid) && pid > 0)
    : []
  const lockFile = join(options.stateDir, 'plugin.lock')
  const gatewayPid = readPid(lockFile)
  if (panePids.length === 1 && gatewayPid === panePids[0]
    && processLockOwnerMatches(lockFile, gatewayPid, /server\.ts(?:\s|$)/)) return
  fail(
    `tmux session ${options.sessionName} は既に存在します。`
    + ' Zeroちゃんの所有権を確認できないsessionを停止せず、更新を中断します',
  )
}

export async function startBotInTmux(options: {
  rootRepo: string
  stateDir?: string
  projectDir: string
  logPath: string
  sessionName?: string
  startupTimeoutMs?: number
  tmuxPath?: string
  replaceTokenFile?: string
  legacyCutover?: boolean
}): Promise<number> {
  const tmux = options.tmuxPath ?? resolveTmuxPath()
  const sessionName = options.sessionName ?? 'zerokun-slack'
  const timeoutMs = Math.max(1_000, options.startupTimeoutMs ?? 10_000)
  const launcher = join(options.rootRepo, 'codex-channel.sh')
  // 稼働中gatewayの入れ替えは、更新処理が今発行したワンタイムトークンだけに許す。
  const replaceTokenFile = options.replaceTokenFile
    ?? join(resolveZeroStateDir(), 'replace-token')
  const stateDir = options.stateDir ?? dirname(replaceTokenFile)
  assertTmuxSessionAvailableOrOwned({ tmuxPath: tmux, sessionName, stateDir })
  const replaceToken = randomUUID()
  const release = command(['git', 'rev-parse', 'HEAD'], { cwd: options.rootRepo }).stdout || 'unknown'
  ensureManagedDirectory(stateDir, dirname(replaceTokenFile))
  atomicWritePrivateFile(replaceTokenFile, replaceToken)
  const launchEnvironment = {
    ...buildRuntimeServiceEnvironment(),
    ZEROKUN_JOB_DB: resolveZeroJobDatabasePath(stateDir),
    ZEROKUN_REPLACE: '1',
    ZEROKUN_UPDATE_RESTART: '1',
    ZEROKUN_LEGACY_CUTOVER: (options.legacyCutover
      ?? process.env.ZEROKUN_LEGACY_CUTOVER === '1') ? '1' : '0',
    ZEROKUN_STATE_DIR: stateDir,
    ZEROKUN_PROJECT_DIR: options.projectDir,
    ZEROKUN_REPLACE_TOKEN: replaceToken,
    ZEROKUN_REPLACE_TOKEN_FILE: replaceTokenFile,
    ZEROKUN_RELEASE_COMMIT: release,
  }
  const launchCommand = [
    'exec /usr/bin/env -i',
    ...Object.entries(launchEnvironment).map(([key, value]) => `${key}=${shellQuote(value)}`),
    shellQuote(launcher),
    shellQuote(options.projectDir),
  ].join(' ')

  requireCommand([
    tmux,
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-x',
    '120',
    '-y',
    '40',
    '-c',
    stateDir,
    launchCommand,
  ])

  try {
    requireCommand([
      tmux,
      'pipe-pane',
      '-o',
      '-t',
      sessionName,
      [
        shellQuote(process.execPath),
        '--config=/dev/null',
        '--no-env-file',
        shellQuote(join(options.rootRepo, 'zerokun', 'safe-log-sink.ts')),
        shellQuote(stateDir),
        shellQuote(options.logPath),
      ].join(' '),
    ])
    const maxChecks = Math.ceil(timeoutMs / 100)
    for (let check = 0; check < maxChecks; check += 1) {
      const panePid = Number(command([
        tmux,
        'list-panes',
        '-t',
        sessionName,
        '-F',
        '#{pane_pid}',
      ]).stdout)
      if (Number.isInteger(panePid) && panePid > 0) {
        atomicWritePrivateFile(
          join(stateDir, 'tmux-session.json'),
          JSON.stringify({ version: 1, name: sessionName, panePid, release }) + '\n',
        )
        return panePid
      }
      await Bun.sleep(100)
    }
    fail(`Codex版gatewayのtmux sessionを${timeoutMs / 1_000}秒以内に確認できませんでした`)
  } catch (error) {
    command([tmux, 'kill-session', '-t', sessionName])
    throw error
  }
}

export async function startBotInHerdr(options: {
  rootRepo: string
  stateDir: string
  projectDir: string
  startupTimeoutMs?: number
  replaceTokenFile?: string
  legacyCutover?: boolean
}): Promise<{ paneId: string; gatewayPid: number }> {
  const runtime = readPinnedHerdrRuntime(options.stateDir)
  const pinnedHerdrEnvironment = environmentForPinnedHerdrRuntime(runtime)
  const timeoutMs = Math.max(1_000, options.startupTimeoutMs ?? 10_000)
  const launcher = join(options.rootRepo, 'codex-channel.sh')
  const replaceTokenFile = options.replaceTokenFile ?? join(options.stateDir, 'replace-token')
  const replaceToken = randomUUID()
  const release = command(['git', 'rev-parse', 'HEAD'], { cwd: options.rootRepo }).stdout || 'unknown'
  ensureManagedDirectory(options.stateDir, dirname(replaceTokenFile))
  atomicWritePrivateFile(replaceTokenFile, replaceToken)
  const launchEnvironment = {
    ...buildRuntimeServiceEnvironment(pinnedHerdrEnvironment),
    ZEROKUN_JOB_DB: resolveZeroJobDatabasePath(options.stateDir),
    ZEROKUN_REPLACE: '1',
    ZEROKUN_UPDATE_RESTART: '1',
    ZEROKUN_LEGACY_CUTOVER: (options.legacyCutover
      ?? process.env.ZEROKUN_LEGACY_CUTOVER === '1') ? '1' : '0',
    ZEROKUN_STATE_DIR: options.stateDir,
    ZEROKUN_PROJECT_DIR: options.projectDir,
    ZEROKUN_REPLACE_TOKEN: replaceToken,
    ZEROKUN_REPLACE_TOKEN_FILE: replaceTokenFile,
    ZEROKUN_RELEASE_COMMIT: release,
  }
  await verifyHerdrRuntimeIdentityAsync(runtime, pinnedHerdrEnvironment)
  requireCommand([
    runtime.binary,
    'pane',
    'run',
    runtime.paneId,
    '/usr/bin/env',
    '-i',
    ...Object.entries(launchEnvironment).map(([key, value]) => `${key}=${value}`),
    launcher,
    options.projectDir,
  ], { env: pinnedHerdrEnvironment })

  const maxChecks = Math.ceil(timeoutMs / 100)
  for (let check = 0; check < maxChecks; check += 1) {
    const gatewayPid = readPid(join(options.stateDir, 'plugin.lock'))
    if (gatewayPid && processLockOwnerMatches(
      join(options.stateDir, 'plugin.lock'), gatewayPid, /server\.ts(?:\s|$)/,
    )) {
      const pinned = readPinnedHerdrRuntime(options.stateDir)
      if (JSON.stringify(pinned) !== JSON.stringify(runtime)) {
        fail('起動したjob runnerのHerdr runtime identityが更新元paneと一致しません')
      }
      return { paneId: runtime.paneId, gatewayPid }
    }
    await Bun.sleep(100)
  }
  fail(`ZeroちゃんのHerdr再起動を${timeoutMs / 1_000}秒以内に確認できませんでした`)
}

async function stopServices(
  stateDir: string,
  signal?: AbortSignal,
): Promise<void> {
  ensureManagedDirectory(stateDir, join(stateDir, 'job-runner.lock'))
  const runnerLock = join(stateDir, 'job-runner.lock', 'pid')
  const runnerPid = readPid(runnerLock)
  if (runnerPid) {
    await stopLockedProcess(runnerLock, runnerPid, 'job runner', /job-runner\.ts\s+daemon(?:\s|$)/, signal)
  }

  const bridgeLock = join(stateDir, 'plugin.lock')
  const bridgePid = readPid(bridgeLock)
  if (bridgePid) await stopLockedProcess(bridgeLock, bridgePid, 'Slack gateway', /server\.ts(?:\s|$)/, signal)
}

async function restartServices(
  rootRepo: string,
  stateDir: string,
  projectDir: string,
  signal?: AbortSignal,
): Promise<void> {
  await stopServices(stateDir, signal)

  if (signal?.aborted) fail('更新を中断しました')
  const logPath = join(stateDir, 'zerokun.log')
  const started = await startBotInHerdr({
    rootRepo,
    stateDir,
    projectDir,
    startupTimeoutMs: Math.max(
      1_000,
      Number(process.env.ZEROKUN_UPDATE_STARTUP_TIMEOUT_MS) || 60_000,
    ),
    replaceTokenFile: join(stateDir, 'replace-token'),
  })
  output(`   Herdr pane: ${started.paneId} (gateway PID ${started.gatewayPid})`)

  await waitForStableHealth({
    requiredConsecutive: Number(process.env.ZEROKUN_HEALTH_CONSECUTIVE ?? 10),
    maxChecks: Number(process.env.ZEROKUN_HEALTH_MAX_CHECKS ?? 60),
    sleep: () => Bun.sleep(Number(process.env.ZEROKUN_HEALTH_SLEEP_MS ?? 500)),
    observe: () => {
      const newRunnerPid = readPid(join(stateDir, 'job-runner.lock', 'pid'))
      const newBridgePid = readPid(join(stateDir, 'plugin.lock'))
      const readiness = readGatewayReadiness(join(stateDir, 'gateway-ready.json'))
      const expectedRelease = command(['git', 'rev-parse', 'HEAD'], { cwd: rootRepo }).stdout
      return Boolean(newRunnerPid && processLockOwnerMatches(
        join(stateDir, 'job-runner.lock', 'pid'), newRunnerPid, /job-runner\.ts\s+daemon(?:\s|$)/,
      )) && Boolean(newBridgePid && processLockOwnerMatches(
        join(stateDir, 'plugin.lock'), newBridgePid, /server\.ts(?:\s|$)/,
      )) && Boolean(readiness && readiness.pid === newBridgePid
        && readiness.release === expectedRelease)
    },
  }).catch(error => {
    fail(`${error instanceof Error ? error.message : String(error)}。ログ: ${logPath}`)
  })
  const newRunnerPid = readPid(join(stateDir, 'job-runner.lock', 'pid'))
  const newBridgePid = readPid(join(stateDir, 'plugin.lock'))
  output(`   start: Slack gateway PID ${newBridgePid} + Codex job runner PID ${newRunnerPid}`)
}

async function rollbackUpdate(
  stateDir: string,
  journal: UpdateJournal,
  options: { restart: boolean; testing: boolean; updateLock: UpdateLockCoordinator },
): Promise<void> {
  if (realpathSync(journal.repoPath) !== journal.repoPath) {
    fail(`rollback repository pathがcanonicalではありません: ${journal.repoPath}`)
  }
  options.updateLock.assertExclusive()
  const assertRollbackState = () => {
    const currentBranch = requireCommand(['git', 'branch', '--show-current'], {
      cwd: journal.repoPath,
    })
    if (currentBranch !== journal.branch) {
      fail(
        `rollback前にbranchが変更されています (${currentBranch || 'detached HEAD'})。`
        + ` ${journal.branch} へ戻してから再実行してください`,
      )
    }
    const currentHead = requireCommand(['git', 'rev-parse', 'HEAD'], { cwd: journal.repoPath })
    if (currentHead !== journal.originalHead && currentHead !== journal.targetHead) {
      fail(
        `rollback開始後に別commitが作成されています (${currentHead.slice(0, 12)})。`
        + ' 未完了journalを保持したまま停止します',
      )
    }
    const dirty = requireCommand(['git', 'status', '--porcelain'], { cwd: journal.repoPath })
    if (dirty) {
      fail(
        'rollback開始後に未コミット変更が作成されています。'
        + ' ユーザー作業を保持するため自動resetせず、未完了journalを残します',
      )
    }
  }
  assertRollbackState()
  writeJournal(stateDir, { ...journal, phase: 'rolling-back' })
  output(`▶ 更新を ${journal.originalHead.slice(0, 12)} へロールバック`)
  await stopServices(stateDir)
  assertRollbackState()
  requireCommand(['git', 'reset', '--hard', journal.originalHead], { cwd: journal.repoPath })
  restoreRollbackDatabase(journal)
  await requireSetupCommandAsync(journal.setupScript, options.updateLock, {
    cwd: journal.repoPath,
    inherit: !options.testing,
    env: {
      ...buildSetupEnvironment(),
      ZEROKUN_STATE_DIR: stateDir,
      ZEROKUN_UPDATE_IN_PROGRESS: '1',
    },
    timeoutMs: resolveSetupTimeoutMs(process.env, options.testing),
  })
  if (options.restart) {
    await restartServices(journal.repoPath, stateDir, journal.projectDir)
  }
  clearJournal(stateDir, journal)
  output('✅ 旧Codex版へのロールバック完了')
}

async function superviseStandaloneSetup(testing = false): Promise<void> {
  if (!['', '0'].includes(process.env.ZEROKUN_UPDATE_IN_PROGRESS ?? '')) {
    fail('updater配下からstandalone setup supervisorは起動できません')
  }
  const rootRepo = resolveRootRepo()
  // Direct setup must meet the same executable trust boundary as every later
  // self-update. Reject Homebrew/npm wrappers before creating state or taking
  // the update lock; the bootstrap installs the official standalone binary.
  if (!testing) resolveUpdaterCodexBinary()
  const stateDir = prepareManagedStateRoot(resolveZeroStateDir())
  const setupScript = process.env.ZEROKUN_SETUP_SCRIPT ?? join(rootRepo, 'zerokun', 'setup.sh')
  if (!existsSync(setupScript)) fail(`setup.shがありません: ${setupScript}`)
  const updateLock = acquireUpdateLock(stateDir)
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    const pendingJournal = journalPath(stateDir)
    try {
      lstatSync(pendingJournal)
      fail(
        '未完了の更新transactionがあります。standalone setupを開始せず、'
        + '先に zerokun-update --recover-only を実行してください',
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    output('▶ Codex版standalone setup')
    const setupEnvironment = buildSetupEnvironment()
    for (const key of [
      'ZEROKUN_BOOTSTRAP',
      'ZEROKUN_SETUP_DRAIN_SECONDS',
      'ZEROKUN_SKIP_WATCHDOG_LAUNCHD',
    ]) {
      const value = process.env[key]
      if (value !== undefined) setupEnvironment[key] = value
    }
    await requireSetupCommandAsync(setupScript, updateLock, {
      cwd: rootRepo,
      // The standalone coordinator is itself the user-facing command. Keep
      // the delegated setup's stdout/stderr attached in tests as well so the
      // harness verifies the same warnings and progress messages users see.
      inherit: true,
      env: {
        ...setupEnvironment,
        ZEROKUN_STATE_DIR: stateDir,
        ZEROKUN_UPDATE_IN_PROGRESS: '1',
      },
      signal: controller.signal,
      timeoutMs: resolveSetupTimeoutMs(process.env, testing),
    })
  } finally {
    try {
      updateLock.release()
    } finally {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', interrupt)
    }
  }
}

async function main(testing = false, argv = process.argv.slice(2)): Promise<void> {
  const args = new Set(argv)
  const skipTests = args.has('--skip-tests')
  const noRestart = args.has('--no-restart')
  const recoverOnly = args.has('--recover-only')
  if (skipTests && !testing) fail('--skip-tests はテスト環境でのみ使用できます')
  if (noRestart && !testing) fail('--no-restart はテスト環境でのみ使用できます')
  const unknown = [...args].filter(arg => ![
    '--skip-tests', '--no-restart', '--recover-only',
  ].includes(arg))
  if (unknown.length > 0) fail(`不明なオプション: ${unknown.join(', ')}`)

  const rootRepo = resolveRootRepo()
  // Use one physical state identity for journals, DB snapshots, candidate
  // setup, restart, and crash recovery even when an ancestor is a symlink.
  const stateDir = prepareManagedStateRoot(resolveZeroStateDir())
  const projectDir = process.env.ZEROKUN_PROJECT_DIR
    ?? rootRepo
  const setupScript = process.env.ZEROKUN_SETUP_SCRIPT ?? join(rootRepo, 'zerokun', 'setup.sh')
  const waitSeconds = Number(process.env.ZEROKUN_UPDATE_WAIT_SECONDS ?? 21_600)
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) fail('ZEROKUN_UPDATE_WAIT_SECONDSが不正です')
  if (!existsSync(projectDir)) fail(`作業ディレクトリがありません: ${projectDir}`)
  if (!existsSync(setupScript)) fail(`setup.shがありません: ${setupScript}`)

  const branch = process.env.ZEROKUN_UPDATE_BRANCH ?? 'main'
  const repositories: Repository[] = [{ label: 'zero-codex', path: rootRepo, branch }]

  const updateLock = acquireUpdateLock(stateDir)
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  const throwIfInterrupted = () => {
    if (controller.signal.aborted) fail('更新を中断しました')
  }
  const cleanup = () => updateLock.release()
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    output('▶ zerokun-update')
    const interrupted = readJournal(stateDir, { repoPath: rootRepo, projectDir, setupScript })
    if (interrupted) {
      if (realpathSync(interrupted.repoPath) !== rootRepo) {
        fail(`別repositoryの未完了更新があります: ${interrupted.repoPath}`)
      }
      await rollbackUpdate(stateDir, interrupted, {
        restart: !recoverOnly && !interrupted.noRestart,
        testing,
        updateLock,
      })
      output('   未完了だった更新transactionを復旧しました')
      if (!recoverOnly) {
        fail(
          '未完了だった更新を旧Codex版へロールバックしました。'
          + '今回の更新は適用されていないため、状態を確認してから新しい更新依頼を送ってください',
        )
      }
      return
    }
    if (recoverOnly) {
      output('   未完了の更新transactionはありません')
      return
    }
    await waitForRunningJobs(
      stateDir,
      waitSeconds,
      process.env.ZEROKUN_JOB_RUNNER ?? join(rootRepo, 'zerokun', 'job-runner.ts'),
      controller.signal,
    )
    throwIfInterrupted()
    output(`▶ Codex版リポを事前検査 (${branch})`)
    const pinnedRepositories = await preflightRepositories(
      repositories,
      controller.signal,
      updateLock,
    )
    throwIfInterrupted()
    if (!skipTests) {
      output('▶ 候補commitを一時worktreeで検証')
      await validateRemoteTargets(
        pinnedRepositories,
        stateDir,
        updateLock,
        controller.signal,
      )
    }
    throwIfInterrupted()
    for (const repo of pinnedRepositories) assertPinnedRepositoryState(repo)
    // The updater lock has remained held since the first drain. A runner that
    // observed the pre-lock state immediately before claiming is therefore
    // either visible as running here or has already finished. Once this second
    // drain returns, the runner's post-claim barrier check prevents new work.
    await waitForRunningJobs(
      stateDir,
      waitSeconds,
      process.env.ZEROKUN_JOB_RUNNER ?? join(rootRepo, 'zerokun', 'job-runner.ts'),
      controller.signal,
    )
    throwIfInterrupted()
    const transactionId = randomUUID()
    let journal: UpdateJournal = {
      version: 1,
      id: transactionId,
      phase: 'prepared',
      repoPath: rootRepo,
      branch,
      originalHead: pinnedRepositories[0]!.originalHead,
      targetHead: pinnedRepositories[0]!.targetHead,
      projectDir,
      setupScript,
      databasePath: null,
      databaseBackup: null,
      noRestart,
    }
    writeJournal(stateDir, journal)
    try {
      output('▶ gatewayとrunnerを停止してrollback snapshotを作成')
      await stopServices(stateDir, controller.signal)
      for (const repo of pinnedRepositories) assertPinnedRepositoryState(repo)
      journal = { ...journal, ...snapshotDatabase(stateDir, transactionId) }
      writeJournal(stateDir, journal)
      throwIfInterrupted()
      output(`▶ origin/${branch}へfast-forward`)
      fastForwardRepositories(pinnedRepositories)
      journal = { ...journal, phase: 'fast-forwarded' }
      writeJournal(stateDir, journal)
      throwIfInterrupted()
      output('▶ setupを反映')
      await requireSetupCommandAsync(setupScript, updateLock, {
        cwd: rootRepo,
        inherit: !testing,
        env: {
          ...buildSetupEnvironment(),
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_UPDATE_IN_PROGRESS: '1',
        },
        signal: controller.signal,
        timeoutMs: resolveSetupTimeoutMs(process.env, testing),
      })
      assertRepositoryClean(repositories[0]!)
      journal = { ...journal, phase: 'setup-applied' }
      writeJournal(stateDir, journal)
      throwIfInterrupted()
      if (!noRestart) {
        output('▶ Zeroちゃんとjob runnerを再起動')
        await restartServices(rootRepo, stateDir, projectDir, controller.signal)
      }
      clearJournal(stateDir, journal)
      output(noRestart
        ? '✅ Codex版更新・setup完了（テスト用 --no-restart）'
        : '✅ Codex版更新・検証・再起動完了')
    } catch (error) {
      const original = error instanceof Error ? error.message : String(error)
      try {
        await rollbackUpdate(stateDir, journal, { restart: !noRestart, testing, updateLock })
      } catch (rollbackError) {
        const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        fail(`更新失敗: ${original}\nロールバックも失敗: ${rollback}`)
      }
      fail(`更新失敗: ${original}\n旧Codex版へ自動ロールバックしました`)
    }
  } finally {
    cleanup()
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
}

export async function runUpdateForTests(argv = process.argv.slice(1)): Promise<void> {
  await withUpdateTestPolicy(() => main(true, argv))
}

export async function runStandaloneSetupForTests(): Promise<void> {
  await superviseStandaloneSetup(true)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const action = argv[0] === '--setup-supervisor'
    ? argv.length === 1
      ? superviseStandaloneSetup(false)
      : Promise.reject(new Error('--setup-supervisorに追加オプションは指定できません'))
    : main(false, argv)
  action.catch(error => {
    process.stderr.write(`❌ ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
