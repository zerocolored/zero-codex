#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { createHash, randomUUID } from 'crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join } from 'path'
import { fileURLToPath } from 'url'
import { buildUpdaterEnvironment, parseStateSlackTokens } from './child-environment.ts'
import { atomicWritePrivateFile, openSafeLog, readOptionalPrivateFile } from './safe-file.ts'
import { requireManagedStateRoot } from './managed-path.ts'
import { resolveZeroJobDatabasePath, resolveZeroStateDir } from './state-dir.ts'
import { verifySlackAppTokenPair } from './slack-app-identity.ts'
import { inspectProcessLock } from './process-lock.ts'
import {
  acquireProcessGroupLeaderIdentity,
  observeProcessGeneration,
  processStartKey,
  readProcessIdentity,
  sameProcessGeneration,
  signalProcessGroupIfLeaderLive,
  signalProcessIfLive,
  type ProcessIdentity,
} from './process-generation.ts'

const REQUEST_FILE = 'update-request.json'
const WORKER_SESSION = 'zerokun-update-worker'
const BOT_SESSION_FALLBACK = 'zerokun-slack'
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000
const DEFAULT_SLACK_HTTP_TIMEOUT_MS = 120_000
const DEFAULT_UPDATE_NOTIFY_ATTEMPTS = 3
const DEFAULT_UPDATE_WORKER_TIMEOUT_MS = 8 * 60 * 60 * 1000
const DEFAULT_UPDATE_WORKER_TERM_GRACE_MS = 30 * 60_000
const DEFAULT_UPDATE_GATE_HANDSHAKE_TIMEOUT_MS = 5_000
const DEFAULT_UPDATE_GATE_KILL_WAIT_MS = 5_000
const UPDATE_GATE_PROTOCOL = 1
const UPDATE_GATE_START = 'START'
const NOTIFICATION_NETWORK_OVERRIDE_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
] as const

function botSessionName(stateDir: string): string {
  try {
    const content = readOptionalPrivateFile(join(stateDir, 'tmux-session.json'))
    if (content === null) return BOT_SESSION_FALLBACK
    const parsed = JSON.parse(content) as { version?: unknown; name?: unknown }
    if (parsed.version === 1 && typeof parsed.name === 'string'
      && /^[A-Za-z0-9_-]{1,128}$/.test(parsed.name)) return parsed.name
  } catch {}
  return BOT_SESSION_FALLBACK
}

export interface UpdateRequestInput {
  chatId: string
  threadTs: string
  messageId: string
  userId: string
}

export interface UpdateRequest extends UpdateRequestInput {
  id: string
  requestedAt: number
  projectDir?: string
  gate?: ProcessIdentity
  outcome?: {
    success: boolean
    exitCode: number
    text: string
    completedAt: number
    notifiedAt?: number
  }
}

export interface UpdateRequestResult {
  accepted: boolean
  duplicate: boolean
  request: UpdateRequest
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface RequestOptions {
  stateDir?: string
  workerFile?: string
  updaterPath?: string
  tmuxPath?: string
  tmuxSession?: string
  legacyCutover?: boolean
  projectDir?: string
  staleAfterMs?: number
  now?: () => number
  idFactory?: () => string
  isWorkerRunning?: () => boolean
  isUpdateRunning?: () => boolean
  launchWorker?: (request: UpdateRequest) => void
  onAccepted?: (request: UpdateRequest) => Promise<void>
  onDuplicate?: (request: UpdateRequest) => Promise<void>
}

interface WorkerOptions {
  stateDir?: string
  updaterPath?: string
  executeUpdater?: () => Promise<number>
  notify?: (request: UpdateRequest, text: string) => Promise<void>
  maxNotifyAttempts?: number
  notificationRetryMs?: number
  updaterTimeoutMs?: number
  updaterTermGraceMs?: number
  legacyCutover?: boolean
  projectDir?: string
}

interface ExecuteUpdaterOptions {
  gateScriptPath?: string
  gateHandshakeTimeoutMs?: number
  gateKillWaitMs?: number
  onGateIdentity?: (identity: ProcessIdentity) => void
  onGateExit?: (identity: ProcessIdentity) => void
}

interface UpdaterGateOptions {
  identityReader?: (pid: number) => ProcessIdentity | undefined
  identityAttempts?: number
  identityRetryMs?: number
  ackTimeoutMs?: number
}

interface UpdateGateHandshake {
  version: typeof UPDATE_GATE_PROTOCOL
  identity: ProcessIdentity
}

export interface UpdateWorkerResult {
  success: boolean
  exitCode: number
  notificationSent: boolean
}

const decoder = new TextDecoder()

function stateDir(): string {
  return resolveZeroStateDir()
}

function requestPath(dir: string): string {
  return join(dir, REQUEST_FILE)
}

function requireText(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} is required`)
  return normalized
}

function validateInput(input: UpdateRequestInput): UpdateRequestInput {
  return {
    chatId: requireText(input.chatId, 'chatId'),
    threadTs: requireText(input.threadTs, 'threadTs'),
    messageId: requireText(input.messageId, 'messageId'),
    userId: requireText(input.userId, 'userId'),
  }
}

function readRequest(dir: string): UpdateRequest | undefined {
  try {
    const content = readOptionalPrivateFile(requestPath(dir))
    if (content === null) return undefined
    const parsed = JSON.parse(content) as UpdateRequest
    const requestedAt = Number(parsed.requestedAt)
    if (!Number.isFinite(requestedAt)) throw new Error('requestedAt is invalid')
    const gate = parsed.gate && typeof parsed.gate === 'object'
      ? parsed.gate as Partial<ProcessIdentity>
      : undefined
    const validGate = gate
      && Number.isSafeInteger(gate.pid) && Number(gate.pid) > 1
      && Number.isSafeInteger(gate.ppid) && Number(gate.ppid) >= 0
      && gate.pgid === gate.pid
      && Number.isSafeInteger(gate.status)
      && typeof gate.bootSession === 'string'
      && Number.isSafeInteger(gate.startSec) && Number(gate.startSec) > 0
      && Number.isSafeInteger(gate.startUsec) && Number(gate.startUsec) >= 0
      && Number(gate.startUsec) <= 999_999
      && typeof gate.started === 'string'
      && processStartKey({
        bootSession: gate.bootSession,
        startSec: Number(gate.startSec),
        startUsec: Number(gate.startUsec),
      }) === gate.started
    if (gate && !validGate) throw new Error('gate identity is invalid')
    return {
      id: requireText(parsed.id, 'id'),
      chatId: requireText(parsed.chatId, 'chatId'),
      threadTs: requireText(parsed.threadTs, 'threadTs'),
      messageId: requireText(parsed.messageId, 'messageId'),
      userId: requireText(parsed.userId, 'userId'),
      requestedAt,
      ...(typeof parsed.projectDir === 'string' && isAbsolute(parsed.projectDir)
        ? { projectDir: requireText(parsed.projectDir, 'projectDir') }
        : {}),
      ...(validGate ? { gate: gate as ProcessIdentity } : {}),
      ...(parsed.outcome && typeof parsed.outcome.text === 'string'
        ? {
          outcome: {
            success: parsed.outcome.success === true,
            exitCode: Number(parsed.outcome.exitCode),
            text: parsed.outcome.text,
            completedAt: Number(parsed.outcome.completedAt),
            ...(Number.isFinite(Number(parsed.outcome.notifiedAt))
              ? { notifiedAt: Number(parsed.outcome.notifiedAt) }
              : {}),
          },
        }
        : {}),
    }
  } catch {
    return undefined
  }
}

function persistRequest(dir: string, request: UpdateRequest): void {
  const path = requestPath(dir)
  atomicWritePrivateFile(path, JSON.stringify(request, null, 2) + '\n')
  chmodSync(path, 0o600)
}

function appendUpdateLog(path: string, content: string): void {
  const descriptor = openSafeLog(path, 'append')
  try {
    writeFileSync(descriptor, content)
  } finally {
    closeSync(descriptor)
  }
}

function clearRequest(dir: string, requestId: string): void {
  const current = readRequest(dir)
  if (current?.id !== requestId) return
  try {
    unlinkSync(requestPath(dir))
  } catch {}
}

function command(args: string[]): CommandResult {
  const result = Bun.spawnSync(args, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: buildUpdaterEnvironment(),
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout ? decoder.decode(result.stdout).trim() : '',
    stderr: result.stderr ? decoder.decode(result.stderr).trim() : '',
  }
}

function requireCommand(args: string[]): string {
  const result = command(args)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `command failed: ${args.join(' ')}`)
  }
  return result.stdout
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function resolveTmuxPath(configured?: string): string {
  if (configured && existsSync(configured)) return configured
  for (const candidate of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']) {
    if (existsSync(candidate)) return candidate
  }
  const found = command(['/usr/bin/which', 'tmux'])
  if (found.exitCode === 0 && found.stdout) return found.stdout
  throw new Error('tmuxがありません。brew install tmux を実行してください')
}

function tmuxSessionExists(tmux: string, session: string): boolean {
  return command([tmux, 'has-session', '-t', session]).exitCode === 0
}

function updateMutationIsRunning(dir: string): boolean {
  const inspection = inspectProcessLock(
    join(dir, 'update.lock', 'pid'),
    /(?:update\.ts|zerokun-update|setup\.sh)(?:\s|$)/,
  )
  return inspection.status !== 'missing' && inspection.status !== 'stale'
}

export function launchDetachedUpdateWorker(
  request: UpdateRequest,
  options: {
    stateDir?: string
    workerFile?: string
    updaterPath?: string
    tmuxPath?: string
    tmuxSession?: string
    legacyCutover?: boolean
    projectDir?: string
  } = {},
): void {
  const dir = options.stateDir ?? stateDir()
  const workerFile = options.workerFile ?? join(dir, 'update-request.ts')
  const updaterPath = options.updaterPath ?? join(homedir(), '.local', 'bin', 'zerokun-update')
  const tmux = resolveTmuxPath(options.tmuxPath)
  const session = options.tmuxSession ?? WORKER_SESSION
  if (!existsSync(workerFile)) throw new Error(`update workerがありません: ${workerFile}`)
  if (!existsSync(updaterPath)) throw new Error(`zerokun-updateがありません: ${updaterPath}`)
  if (tmuxSessionExists(tmux, session)) throw new Error('別のZeroちゃん更新workerが実行中です')
  const legacyCutover = options.legacyCutover
    ?? process.env.ZEROKUN_LEGACY_CUTOVER === '1'
  const projectDir = request.projectDir ?? options.projectDir ?? process.env.ZEROKUN_PROJECT_DIR
  const launchEnvironment = {
    ...buildUpdaterEnvironment(),
    ZEROKUN_JOB_DB: resolveZeroJobDatabasePath(dir),
    ZEROKUN_STATE_DIR: dir,
    ZEROKUN_LEGACY_CUTOVER: legacyCutover ? '1' : '0',
    ...(projectDir ? { ZEROKUN_PROJECT_DIR: projectDir } : {}),
  }

  const launchCommand = [
    'exec /usr/bin/env -i',
    ...Object.entries(launchEnvironment).map(([key, value]) => `${key}=${shellQuote(value)}`),
    shellQuote(process.execPath),
    '--config=/dev/null',
    '--no-env-file',
    shellQuote(workerFile),
    'run',
    shellQuote(request.id),
    '--state-dir',
    shellQuote(dir),
    '--updater',
    shellQuote(updaterPath),
    '--legacy-cutover',
    legacyCutover ? '1' : '0',
    ...(projectDir ? ['--project-dir', shellQuote(projectDir)] : []),
  ].join(' ')
  requireCommand([
    tmux,
    'new-session',
    '-d',
    '-s',
    session,
    '-x',
    '100',
    '-y',
    '30',
    '-c',
    dir,
    launchCommand,
  ])
}

export async function requestUpdate(
  rawInput: UpdateRequestInput,
  options: RequestOptions = {},
): Promise<UpdateRequestResult> {
  const dir = options.stateDir ?? stateDir()
  const now = options.now ?? Date.now
  const session = options.tmuxSession ?? WORKER_SESSION
  const isWorkerRunning = options.isWorkerRunning
    ?? (() => tmuxSessionExists(resolveTmuxPath(options.tmuxPath), session))
  const isUpdateRunning = options.isUpdateRunning ?? (() => updateMutationIsRunning(dir))
  const launch = options.launchWorker ?? ((value: UpdateRequest) => {
    launchDetachedUpdateWorker(value, {
      stateDir: dir,
      legacyCutover: options.legacyCutover,
      projectDir: options.projectDir,
      workerFile: options.workerFile,
      updaterPath: options.updaterPath,
      tmuxPath: options.tmuxPath,
      tmuxSession: session,
    })
  })
  const input = validateInput(rawInput)
  let existing = readRequest(dir)
  if (!existing && existsSync(requestPath(dir))) {
    // Another process may still be finishing its small atomic reservation write.
    // Re-read once before treating the file as abandoned corruption.
    await Bun.sleep(25)
    existing = readRequest(dir)
    if (!existing && existsSync(requestPath(dir))) {
      if (isWorkerRunning()) {
        throw new Error('更新予約ファイルが壊れていますがworkerは実行中です')
      }
      unlinkSync(requestPath(dir))
    }
  }
  if (existing) {
    if (existing.outcome?.notifiedAt) {
      if (existing.chatId === input.chatId && existing.messageId === input.messageId) {
        await options.onDuplicate?.(existing)
        return { accepted: false, duplicate: true, request: existing }
      }
      clearRequest(dir, existing.id)
      existing = undefined
    }
  }
  if (existing) {
    const age = now() - existing.requestedAt
    let running = isWorkerRunning()
    if (!running && existing.gate) {
      const gate = observeProcessGeneration(existing.gate)
      if (gate.status === 'dead') {
        const { gate: _finishedGate, ...withoutGate } = existing
        persistRequest(dir, withoutGate)
        existing = withoutGate
      } else {
        running = true
      }
    }
    running ||= isUpdateRunning()
    if (age <= (options.staleAfterMs ?? DEFAULT_STALE_MS) || running || existing.outcome) {
      if (!running) launch(existing)
      await options.onDuplicate?.(existing)
      return { accepted: false, duplicate: true, request: existing }
    }
    clearRequest(dir, existing.id)
  }

  const request: UpdateRequest = {
    ...input,
    id: options.idFactory?.() ?? randomUUID(),
    requestedAt: now(),
    ...(options.projectDir ? { projectDir: options.projectDir } : {}),
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(requestPath(dir), JSON.stringify(request, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    const raced = readRequest(dir)
    if (!raced) throw error
    await options.onDuplicate?.(raced)
    return { accepted: false, duplicate: true, request: raced }
  }

  try {
    await options.onAccepted?.(request)
    if (!isUpdateRunning()) launch(request)
    return { accepted: true, duplicate: false, request }
  } catch (error) {
    clearRequest(dir, request.id)
    throw error
  }
}

export function resumePendingUpdateWorker(options: RequestOptions = {}): boolean {
  const dir = options.stateDir ?? stateDir()
  const request = readRequest(dir)
  if (!request || request.outcome?.notifiedAt) return false
  const session = options.tmuxSession ?? WORKER_SESSION
  const running = options.isWorkerRunning
    ? options.isWorkerRunning()
    : tmuxSessionExists(resolveTmuxPath(options.tmuxPath), session)
  if (running) return false
  if (request.gate) {
    const gate = observeProcessGeneration(request.gate)
    if (gate.status !== 'dead') return false
    const current = readRequest(dir)
    if (!current || current.id !== request.id || current.outcome) return false
    const { gate: _finishedGate, ...withoutGate } = current
    persistRequest(dir, withoutGate)
  }
  const isUpdateRunning = options.isUpdateRunning ?? (() => updateMutationIsRunning(dir))
  if (isUpdateRunning()) return false
  const launch = options.launchWorker ?? ((value: UpdateRequest) => {
    launchDetachedUpdateWorker(value, {
      stateDir: dir,
      legacyCutover: options.legacyCutover,
      projectDir: value.projectDir ?? options.projectDir,
      workerFile: options.workerFile,
      updaterPath: options.updaterPath,
      tmuxPath: options.tmuxPath,
      tmuxSession: session,
    })
  })
  launch(request)
  return true
}

function loadSlackTokens(dir: string): { botToken: string; appToken: string } {
  const envPath = join(dir, '.env')
  const tokens = parseStateSlackTokens(readOptionalPrivateFile(envPath) ?? '')
  if (tokens.SLACK_BOT_TOKEN && tokens.SLACK_APP_TOKEN) {
    return { botToken: tokens.SLACK_BOT_TOKEN, appToken: tokens.SLACK_APP_TOKEN }
  }
  throw new Error(`Slack Bot/App token pairがありません: ${envPath}`)
}

export async function withUpdateSlackDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeout = DEFAULT_SLACK_HTTP_TIMEOUT_MS,
): Promise<T> {
  const deadline = Math.max(1, Math.floor(timeout))
  const controller = new AbortController()
  let rejectTimeout: ((error: Error) => void) | undefined
  const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject })
  const timer = setTimeout(() => {
    controller.abort()
    rejectTimeout?.(new Error(`Slack update notification timed out after ${deadline}ms`))
  }, deadline)
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export async function withoutUpdateNotificationNetworkOverrides<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string>()
  for (const key of NOTIFICATION_NETWORK_OVERRIDE_KEYS) {
    const value = process.env[key]
    if (value !== undefined) saved.set(key, value)
    delete process.env[key]
  }
  try {
    return await operation()
  } finally {
    for (const key of NOTIFICATION_NETWORK_OVERRIDE_KEYS) delete process.env[key]
    for (const [key, value] of saved) process.env[key] = value
  }
}

async function notifySlack(dir: string, request: UpdateRequest, text: string): Promise<void> {
  const { botToken, appToken } = loadSlackTokens(dir)
  await withoutUpdateNotificationNetworkOverrides(async () => {
    const callIdentityApi = async (
      method: 'auth.test' | 'bots.info',
      fields: Record<string, string> = {},
    ): Promise<Record<string, any>> => {
      const response = await withUpdateSlackDeadline(signal => fetch(
        `https://slack.com/api/${method}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          },
          body: new URLSearchParams(fields),
          signal,
        },
      ), 10_000)
      const result = await response.json() as Record<string, any>
      if (!result.ok) throw new Error(result.error ?? `Slack ${method} HTTP ${response.status}`)
      return result
    }
    await verifySlackAppTokenPair(appToken, {
      authTest: async () => {
        const result = await callIdentityApi('auth.test')
        return {
          app_id: result.app_id,
          bot_id: result.bot_id,
          user_id: result.user_id,
        }
      },
      botsInfo: async bot => {
        const result = await callIdentityApi('bots.info', { bot })
        return { app_id: result.bot?.app_id as string | undefined }
      },
    })
  })
  let lastError = 'unknown error'
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await withoutUpdateNotificationNetworkOverrides(() => (
        withUpdateSlackDeadline(signal => fetch(
          'https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            channel: request.chatId,
            thread_ts: request.threadTs,
            text,
            client_msg_id: updateNotificationClientId(request.id),
          }),
          signal,
        }), Number(process.env.ZEROKUN_SLACK_HTTP_TIMEOUT_MS) || DEFAULT_SLACK_HTTP_TIMEOUT_MS)
      ))
      const result = await response.json() as { ok?: boolean; error?: string }
      if (result.ok) return
      lastError = result.error ?? `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (attempt < 3) await Bun.sleep(attempt * 1_000)
  }
  throw new Error(`Slack完了通知に失敗しました: ${lastError}`)
}

function updateNotificationClientId(requestId: string): string {
  const hex = createHash('sha256').update(`zerokun-update:${requestId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function signalProcessGroup(
  identity: ProcessIdentity,
  signal: NodeJS.Signals,
): boolean {
  if (signalProcessGroupIfLeaderLive(identity, signal)) return true
  return signalProcessIfLive(identity, signal)
}

function parseUpdateGateHandshake(value: string): UpdateGateHandshake | undefined {
  try {
    const parsed = JSON.parse(value) as { version?: unknown; identity?: Partial<ProcessIdentity> }
    const identity = parsed.identity
    if (parsed.version !== UPDATE_GATE_PROTOCOL || !identity
      || !Number.isSafeInteger(identity.pid) || Number(identity.pid) <= 1
      || !Number.isSafeInteger(identity.ppid) || Number(identity.ppid) < 0
      || !Number.isSafeInteger(identity.pgid) || Number(identity.pgid) <= 1
      || !Number.isSafeInteger(identity.status) || Number(identity.status) < 0
      || typeof identity.bootSession !== 'string'
      || !Number.isSafeInteger(identity.startSec) || Number(identity.startSec) <= 0
      || !Number.isSafeInteger(identity.startUsec) || Number(identity.startUsec) < 0
      || Number(identity.startUsec) > 999_999
      || typeof identity.started !== 'string') return undefined
    const complete = identity as ProcessIdentity
    if (complete.started !== processStartKey(complete)) return undefined
    return { version: UPDATE_GATE_PROTOCOL, identity: complete }
  } catch {
    return undefined
  }
}

async function readControlLine(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
  maxBytes = 4_096,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('control timeoutが不正です')
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void reader.cancel()
      reject(new Error('update gate handshakeがtimeoutしました'))
    }, timeoutMs)
  })
  try {
    while (true) {
      const item = await Promise.race([reader.read(), timeout])
      if (item.done) throw new Error('update gate handshakeが完了前に閉じました')
      total += item.value.byteLength
      if (total > maxBytes) throw new Error('update gate handshakeが上限を超えました')
      chunks.push(item.value)
      const combined = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
      const newline = combined.indexOf(0x0a)
      if (newline >= 0) return combined.subarray(0, newline).toString('utf8')
    }
  } finally {
    if (timer) clearTimeout(timer)
    try { reader.releaseLock() } catch {}
  }
}

async function writeControlLine(value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${value}\n`, error => error ? reject(error) : resolve())
  })
}

export async function acquireDetachedLeaderIdentity(
  pid: number,
  identityReader: (pid: number) => ProcessIdentity | undefined = readProcessIdentity,
  attempts = 100,
  retryMs = 10,
): Promise<ProcessIdentity | undefined> {
  return acquireProcessGroupLeaderIdentity(pid, identityReader, attempts, retryMs)
}

export async function runUpdaterGate(
  updaterPath: string,
  logPath: string,
  environment: Record<string, string | undefined> = process.env,
  options: UpdaterGateOptions = {},
): Promise<number> {
  const identity = await acquireDetachedLeaderIdentity(
    process.pid,
    options.identityReader,
    options.identityAttempts,
    options.identityRetryMs,
  )
  if (!identity) throw new Error('update gateのexact process identityを取得できません')
  await writeControlLine(JSON.stringify({ version: UPDATE_GATE_PROTOCOL, identity }))
  const ack = await readControlLine(
    Bun.stdin.stream(),
    options.ackTimeoutMs ?? DEFAULT_UPDATE_GATE_HANDSHAKE_TIMEOUT_MS,
    64,
  )
  if (ack !== UPDATE_GATE_START) throw new Error('update gate start確認が不正です')

  const logFd = openSafeLog(logPath, 'append')
  const retainLeader = () => {}
  process.on('SIGINT', retainLeader)
  process.on('SIGTERM', retainLeader)
  try {
    const updaterEnvironment = buildUpdaterEnvironment(environment)
    if (environment.ZEROKUN_STATE_DIR) {
      updaterEnvironment.ZEROKUN_JOB_DB = resolveZeroJobDatabasePath(
        environment.ZEROKUN_STATE_DIR,
        environment,
      )
    }
    const proc = Bun.spawn([
      process.execPath, '--config=/dev/null', '--no-env-file', updaterPath,
    ], {
      cwd: environment.ZEROKUN_STATE_DIR ?? dirname(updaterPath),
      stdin: 'ignore',
      stdout: logFd,
      stderr: logFd,
      env: updaterEnvironment,
    })
    return await proc.exited
  } finally {
    process.off('SIGINT', retainLeader)
    process.off('SIGTERM', retainLeader)
    closeSync(logFd)
  }
}

type TrackedExitState = 'stopped' | 'alive' | 'unknown'

async function waitForTrackedExit(
  exited: Promise<number>,
  identity: ProcessIdentity,
  timeoutMs: number,
): Promise<TrackedExitState> {
  let processExited = false
  void exited.then(
    () => { processExited = true },
    () => { processExited = true },
  )
  const deadline = Date.now() + Math.max(1, timeoutMs)
  let last: TrackedExitState = 'alive'
  while (!processExited && Date.now() < deadline) {
    const observation = observeProcessGeneration(identity)
    if (observation.status === 'dead') return 'stopped'
    last = observation.status === 'unknown' ? 'unknown' : 'alive'
    await Bun.sleep(Math.min(50, Math.max(1, deadline - Date.now())))
  }
  if (processExited) return 'stopped'
  const finalObservation = observeProcessGeneration(identity)
  if (finalObservation.status === 'dead') return 'stopped'
  return finalObservation.status === 'unknown' ? 'unknown' : last
}

export async function executeUpdater(
  updaterPath: string,
  logPath: string,
  timeoutMs = Number(process.env.ZEROKUN_UPDATE_WORKER_TIMEOUT_MS)
    || DEFAULT_UPDATE_WORKER_TIMEOUT_MS,
  termGraceMs = DEFAULT_UPDATE_WORKER_TERM_GRACE_MS,
  environment: Record<string, string | undefined> = process.env,
  options: ExecuteUpdaterOptions = {},
): Promise<number> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('updater worker timeoutが不正です')
  }
  if (!Number.isFinite(termGraceMs) || termGraceMs <= 0) {
    throw new Error('updater worker TERM graceが不正です')
  }
  const logFd = openSafeLog(logPath, 'append')
  let registeredGate: ProcessIdentity | undefined
  let gateExitConfirmed = false
  try {
    writeFileSync(logFd, `\n${new Date().toISOString()} update request started\n`)
    const childEnvironment = buildUpdaterEnvironment(environment)
    if (environment.ZEROKUN_STATE_DIR) {
      childEnvironment.ZEROKUN_JOB_DB = resolveZeroJobDatabasePath(
        environment.ZEROKUN_STATE_DIR,
        environment,
      )
    }
    const gateScriptPath = options.gateScriptPath ?? fileURLToPath(import.meta.url)
    const proc = Bun.spawn([
      process.execPath, '--config=/dev/null', '--no-env-file', gateScriptPath,
      'updater-gate', updaterPath, '--log', logPath,
    ], {
      cwd: environment.ZEROKUN_STATE_DIR ?? dirname(updaterPath),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: logFd,
      env: childEnvironment,
      detached: process.platform !== 'win32',
    })
    if (!proc.stdout || !proc.stdin || typeof proc.stdin === 'number') {
      throw new Error('update gate control pipeを作成できません')
    }
    let updaterIdentity: ProcessIdentity
    try {
      const line = await readControlLine(
        proc.stdout,
        options.gateHandshakeTimeoutMs ?? DEFAULT_UPDATE_GATE_HANDSHAKE_TIMEOUT_MS,
      )
      const handshake = parseUpdateGateHandshake(line)
      const current = handshake ? readProcessIdentity(proc.pid) : undefined
      if (!handshake || handshake.identity.pid !== proc.pid
        || handshake.identity.pgid !== proc.pid || !current
        || !sameProcessGeneration(handshake.identity, current)) {
        throw new Error('update gateのexact process identityを検証できません')
      }
      updaterIdentity = handshake.identity
      options.onGateIdentity?.(updaterIdentity)
      registeredGate = updaterIdentity
      proc.stdin.write(`${UPDATE_GATE_START}\n`)
      await proc.stdin.flush()
      proc.stdin.end()
    } catch (error) {
      try { proc.stdin.end() } catch {}
      await Promise.race([
        proc.exited,
        Bun.sleep(options.gateHandshakeTimeoutMs ?? DEFAULT_UPDATE_GATE_HANDSHAKE_TIMEOUT_MS),
      ])
      throw error
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'timeout'>(resolve => {
      timeout = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const naturalExit = proc.exited.then(exitCode => ({ kind: 'exit' as const, exitCode }))
    const outcome = await Promise.race([naturalExit, deadline])
    if (timeout) clearTimeout(timeout)
    if (outcome !== 'timeout') {
      gateExitConfirmed = true
      return outcome.exitCode
    }

    if (!signalProcessGroup(updaterIdentity, 'SIGTERM')) {
      const stopped = await waitForTrackedExit(proc.exited, updaterIdentity, 100)
      if (stopped !== 'stopped') {
        throw new Error('timeoutしたupdate gateへgeneration-safeなSIGTERMを送れません')
      }
    }
    const afterTerm = await waitForTrackedExit(proc.exited, updaterIdentity, termGraceMs)
    if (afterTerm !== 'stopped') {
      if (!signalProcessGroup(updaterIdentity, 'SIGKILL')) {
        const stopped = await waitForTrackedExit(proc.exited, updaterIdentity, 100)
        if (stopped !== 'stopped') {
          throw new Error('timeoutしたupdate gateへgeneration-safeなSIGKILLを送れません')
        }
      }
      const afterKill = await waitForTrackedExit(
        proc.exited,
        updaterIdentity,
        options.gateKillWaitMs ?? DEFAULT_UPDATE_GATE_KILL_WAIT_MS,
      )
      if (afterKill !== 'stopped') {
        throw new Error(`timeoutしたupdate gateの停止を確認できません: ${afterKill}`)
      }
    }
    gateExitConfirmed = true
    throw new Error(`zerokun-updateが${timeoutMs}msでtimeoutしました`)
  } finally {
    if (registeredGate && gateExitConfirmed) options.onGateExit?.(registeredGate)
    closeSync(logFd)
  }
}

export async function runUpdateWorker(
  requestId: string,
  options: WorkerOptions = {},
): Promise<UpdateWorkerResult> {
  const dir = options.stateDir ?? stateDir()
  requireManagedStateRoot(dir)
  const request = readRequest(dir)
  if (!request || request.id !== requestId) throw new Error(`更新依頼が見つかりません: ${requestId}`)
  const logPath = join(dir, 'update-request.log')
  const updaterPath = options.updaterPath ?? join(homedir(), '.local', 'bin', 'zerokun-update')
  const legacyCutover = options.legacyCutover
    ?? process.env.ZEROKUN_LEGACY_CUTOVER === '1'
  const projectDir = request.projectDir ?? options.projectDir ?? process.env.ZEROKUN_PROJECT_DIR
  const updaterEnvironment = {
    ...buildUpdaterEnvironment(),
    ZEROKUN_JOB_DB: resolveZeroJobDatabasePath(dir),
    ZEROKUN_STATE_DIR: dir,
    ZEROKUN_LEGACY_CUTOVER: legacyCutover ? '1' : '0',
    ...(projectDir ? { ZEROKUN_PROJECT_DIR: projectDir } : {}),
  }
  const run = options.executeUpdater ?? (() => executeUpdater(
    updaterPath,
    logPath,
    options.updaterTimeoutMs,
    options.updaterTermGraceMs,
    updaterEnvironment,
    {
      onGateIdentity: gate => {
        const current = readRequest(dir)
        if (!current || current.id !== request.id || current.outcome) {
          throw new Error('update gateを現在のrequestへ永続化できません')
        }
        persistRequest(dir, { ...current, gate })
      },
      onGateExit: gate => {
        const current = readRequest(dir)
        if (!current || current.id !== request.id || !current.gate
          || !sameProcessGeneration(current.gate, gate)) return
        const { gate: _finishedGate, ...withoutGate } = current
        persistRequest(dir, withoutGate)
      },
    },
  ))
  const notify = options.notify ?? ((value: UpdateRequest, text: string) => notifySlack(dir, value, text))

  let outcome = request.outcome
  if (!outcome) {
    let exitCode = 1
    let success = false
    let errorText = ''
    try {
      exitCode = await run()
      success = exitCode === 0
      if (!success) errorText = `zerokun-updateが終了コード${exitCode}で失敗しました。`
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error)
    }
    const text = success
      ? '✅ Zeroちゃんの更新完了\n更新・テスト・setup・再起動が完了しました。'
      : '❌ Zeroちゃんの更新失敗\n詳細はこのMacの管理ログを確認してください。'
    outcome = { success, exitCode, text, completedAt: Date.now() }
    persistRequest(dir, { ...request, outcome })
  }

  const maxAttempts = Math.max(1, Math.floor(
    options.maxNotifyAttempts ?? DEFAULT_UPDATE_NOTIFY_ATTEMPTS,
  ))
  const retryMs = Math.max(1, options.notificationRetryMs ?? 60_000)
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await notify(request, outcome.text)
      outcome = { ...outcome, notifiedAt: Date.now() }
      persistRequest(dir, { ...request, outcome })
      return { success: outcome.success, exitCode: outcome.exitCode, notificationSent: true }
    } catch (error) {
      appendUpdateLog(
        logPath,
        `${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}\n`,
      )
      if (attempt < maxAttempts) await Bun.sleep(retryMs)
    }
  }
  return { success: outcome.success, exitCode: outcome.exitCode, notificationSent: false }
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === 'updater-gate') {
    if (!args[1] || !optionValue(args, '--log')) {
      throw new Error('usage: update-request.ts updater-gate <updater-path> --log <log-path>')
    }
    const exitCode = await runUpdaterGate(args[1], optionValue(args, '--log')!)
    if (exitCode !== 0) process.exitCode = exitCode
    return
  }
  if (args[0] !== 'run' || !args[1]) {
    throw new Error('usage: update-request.ts run <request-id> [--state-dir DIR] [--updater PATH]')
  }
  const legacyCutover = optionValue(args, '--legacy-cutover')
  const projectDir = optionValue(args, '--project-dir')
  if (legacyCutover !== undefined && legacyCutover !== '0' && legacyCutover !== '1') {
    throw new Error('--legacy-cutoverは0または1で指定してください')
  }
  const result = await runUpdateWorker(args[1], {
    stateDir: optionValue(args, '--state-dir'),
    updaterPath: optionValue(args, '--updater'),
    legacyCutover: legacyCutover === undefined ? undefined : legacyCutover === '1',
    projectDir,
  })
  if (!result.success || !result.notificationSent) process.exitCode = 1
}

if (import.meta.main) {
  runCli().catch(error => {
    process.stderr.write(`zerokun update worker: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
