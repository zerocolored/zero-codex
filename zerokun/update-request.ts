#!/usr/bin/env bun

import { randomUUID } from 'crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const REQUEST_FILE = 'update-request.json'
const WORKER_SESSION = 'zerokun-update-worker'
// 更新後のゼロくん本体が常駐する detached session。update.ts の sessionName 既定と同じ値。
const BOT_SESSION = 'zerokun-slack'
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000

export interface UpdateRequestInput {
  chatId: string
  threadTs: string
  messageId: string
  userId: string
}

export interface UpdateRequest extends UpdateRequestInput {
  id: string
  requestedAt: number
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
}

export interface UpdateWorkerResult {
  success: boolean
  exitCode: number
  notificationSent: boolean
}

const decoder = new TextDecoder()

function stateDir(): string {
  return process.env.SLACK_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'slack')
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
    const parsed = JSON.parse(readFileSync(requestPath(dir), 'utf8')) as UpdateRequest
    const requestedAt = Number(parsed.requestedAt)
    if (!Number.isFinite(requestedAt)) throw new Error('requestedAt is invalid')
    return {
      id: requireText(parsed.id, 'id'),
      chatId: requireText(parsed.chatId, 'chatId'),
      threadTs: requireText(parsed.threadTs, 'threadTs'),
      messageId: requireText(parsed.messageId, 'messageId'),
      userId: requireText(parsed.userId, 'userId'),
      requestedAt,
    }
  } catch {
    return undefined
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
    env: process.env,
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
    const age = now() - existing.requestedAt
    if (age <= (options.staleAfterMs ?? DEFAULT_STALE_MS) || isWorkerRunning()) {
      await options.onDuplicate?.(existing)
      return { accepted: false, duplicate: true, request: existing }
    }
    clearRequest(dir, existing.id)
  }

  const input = validateInput(rawInput)
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
    return { accepted: true, duplicate: false, request }
  } catch (error) {
    clearRequest(dir, request.id)
    throw error
  }
}

function loadSlackToken(dir: string): string {
  const envPath = join(dir, '.env')
  chmodSync(envPath, 0o600)
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^SLACK_BOT_TOKEN=(.*)$/)
    if (match?.[1]) return match[1]
  }
  throw new Error(`SLACK_BOT_TOKENがありません: ${envPath}`)
}

async function notifySlack(dir: string, request: UpdateRequest, text: string): Promise<void> {
  const token = loadSlackToken(dir)
  let lastError = 'unknown error'
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: request.chatId,
          thread_ts: request.threadTs,
          text,
        }),
      })
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

async function executeUpdater(updaterPath: string, logPath: string): Promise<number> {
  const logFd = openSync(logPath, 'a', 0o600)
  try {
    appendFileSync(logPath, `\n${new Date().toISOString()} update request started\n`, { mode: 0o600 })
    const proc = Bun.spawn([process.execPath, updaterPath], {
      stdin: 'ignore',
      stdout: logFd,
      stderr: logFd,
      env: process.env,
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
  const request = readRequest(dir)
  if (!request || request.id !== requestId) throw new Error(`更新依頼が見つかりません: ${requestId}`)
  const logPath = join(dir, 'update-request.log')
  const updaterPath = options.updaterPath ?? join(homedir(), '.local', 'bin', 'zerokun-update')
  const run = options.executeUpdater ?? (() => executeUpdater(updaterPath, logPath))
  const notify = options.notify ?? ((value: UpdateRequest, text: string) => notifySlack(dir, value, text))

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
    // 更新は再起動を伴うので、ゼロくんは起動元のタブから消えて detached tmux に移る。
    // 画面が見当たらず「どこで動いてる?」と毎回聞かせないため、開き方と抜け方まで書く。
    ? `✅ ゼロくん更新完了（request ${request.id.slice(0, 8)}）\n3リポの更新・テスト・setup・再起動が完了しました。\n画面を見る: tmux attach -t ${BOT_SESSION} （抜けるのは Ctrl-b → d。閉じてもゼロくんは止まりません）`
    : `❌ ゼロくん更新失敗（request ${request.id.slice(0, 8)}）\n${errorText}\nログ: ${logPath}`
  let notificationSent = false
  try {
    await notify(request, text)
    notificationSent = true
  } catch (error) {
    appendFileSync(
      logPath,
      `${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}\n`,
      { mode: 0o600 },
    )
  } finally {
    clearRequest(dir, request.id)
  }
  return { success, exitCode, notificationSent }
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
