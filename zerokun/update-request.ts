#!/usr/bin/env bun

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
import { join } from 'path'
import { buildUpdaterEnvironment } from './child-environment.ts'
import { atomicWritePrivateFile, openSafeLog, readOptionalPrivateFile } from './safe-file.ts'
import { requireManagedStateRoot } from './managed-path.ts'
import { resolveZeroStateDir } from './state-dir.ts'

const REQUEST_FILE = 'update-request.json'
const WORKER_SESSION = 'zerokun-update-worker'
const BOT_SESSION_FALLBACK = 'zerokun-slack'
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000
const DEFAULT_SLACK_HTTP_TIMEOUT_MS = 120_000
const DEFAULT_UPDATE_NOTIFY_ATTEMPTS = 3

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
  staleAfterMs?: number
  now?: () => number
  idFactory?: () => string
  isWorkerRunning?: () => boolean
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
    return {
      id: requireText(parsed.id, 'id'),
      chatId: requireText(parsed.chatId, 'chatId'),
      threadTs: requireText(parsed.threadTs, 'threadTs'),
      messageId: requireText(parsed.messageId, 'messageId'),
      userId: requireText(parsed.userId, 'userId'),
      requestedAt,
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

export function launchDetachedUpdateWorker(
  request: UpdateRequest,
  options: {
    stateDir?: string
    workerFile?: string
    updaterPath?: string
    tmuxPath?: string
    tmuxSession?: string
  } = {},
): void {
  const dir = options.stateDir ?? stateDir()
  const workerFile = options.workerFile ?? join(dir, 'update-request.ts')
  const updaterPath = options.updaterPath ?? join(homedir(), '.local', 'bin', 'zerokun-update')
  const tmux = resolveTmuxPath(options.tmuxPath)
  const session = options.tmuxSession ?? WORKER_SESSION
  if (!existsSync(workerFile)) throw new Error(`update workerがありません: ${workerFile}`)
  if (!existsSync(updaterPath)) throw new Error(`zerokun-updateがありません: ${updaterPath}`)
  if (tmuxSessionExists(tmux, session)) throw new Error('別のゼロくん更新workerが実行中です')

  const launchCommand = [
    'exec',
    shellQuote(process.execPath),
    shellQuote(workerFile),
    'run',
    shellQuote(request.id),
    '--state-dir',
    shellQuote(dir),
    '--updater',
    shellQuote(updaterPath),
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
  const launch = options.launchWorker ?? ((value: UpdateRequest) => {
    launchDetachedUpdateWorker(value, {
      stateDir: dir,
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
    const running = isWorkerRunning()
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
    launch(request)
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
  const launch = options.launchWorker ?? ((value: UpdateRequest) => {
    launchDetachedUpdateWorker(value, {
      stateDir: dir,
      workerFile: options.workerFile,
      updaterPath: options.updaterPath,
      tmuxPath: options.tmuxPath,
      tmuxSession: session,
    })
  })
  launch(request)
  return true
}

function loadSlackToken(dir: string): string {
  const envPath = join(dir, '.env')
  for (const line of (readOptionalPrivateFile(envPath) ?? '').split('\n')) {
    const match = line.match(/^SLACK_BOT_TOKEN=(.*)$/)
    if (match?.[1]) return match[1]
  }
  throw new Error(`SLACK_BOT_TOKENがありません: ${envPath}`)
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

async function notifySlack(dir: string, request: UpdateRequest, text: string): Promise<void> {
  const token = loadSlackToken(dir)
  let lastError = 'unknown error'
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await withUpdateSlackDeadline(signal => fetch(
        'https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
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

async function executeUpdater(updaterPath: string, logPath: string): Promise<number> {
  const logFd = openSafeLog(logPath, 'append')
  try {
    writeFileSync(logFd, `\n${new Date().toISOString()} update request started\n`)
    const proc = Bun.spawn([process.execPath, updaterPath], {
      stdin: 'ignore',
      stdout: logFd,
      stderr: logFd,
      env: buildUpdaterEnvironment(),
    })
    return await proc.exited
  } finally {
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
  const run = options.executeUpdater ?? (() => executeUpdater(updaterPath, logPath))
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
      ? `✅ Codex版ゼロくん更新完了（request ${request.id.slice(0, 8)}）\n更新・テスト・setup・再起動が完了しました。\n画面を見る: tmux attach -t ${botSessionName(dir)} （抜けるのは Ctrl-b → d。閉じてもゼロくんは止まりません）`
      : `❌ ゼロくん更新失敗（request ${request.id.slice(0, 8)}）\n${errorText}\nログ: ${logPath}`
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
  if (args[0] !== 'run' || !args[1]) {
    throw new Error('usage: update-request.ts run <request-id> [--state-dir DIR] [--updater PATH]')
  }
  const result = await runUpdateWorker(args[1], {
    stateDir: optionValue(args, '--state-dir'),
    updaterPath: optionValue(args, '--updater'),
  })
  if (!result.success || !result.notificationSent) process.exitCode = 1
}

if (import.meta.main) {
  runCli().catch(error => {
    process.stderr.write(`zerokun update worker: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
