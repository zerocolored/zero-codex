#!/usr/bin/env bun

import { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'

export const SERIAL_WORKER_COUNT = 1 as const

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface EnqueueInput {
  chatId: string
  threadTs: string
  messageId: string
  userId: string
  repoPath: string
  task: string
}

export interface JobRecord {
  seq: number
  id: string
  idempotencyKey: string
  chatId: string
  threadTs: string
  messageId: string
  userId: string
  repoPath: string
  task: string
  status: JobStatus
  sessionId: string | null
  resumed: boolean
  workerId: string | null
  attempts: number
  result: string | null
  lastError: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

type JobRow = {
  seq: number
  id: string
  idempotency_key: string
  chat_id: string
  thread_ts: string
  message_id: string
  user_id: string
  repo_path: string
  task: string
  status: JobStatus
  session_id: string | null
  resumed: number
  worker_id: string | null
  attempts: number
  result: string | null
  last_error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

const JOB_SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  session_id TEXT,
  resumed INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_seq ON jobs(status, seq);
CREATE INDEX IF NOT EXISTS idx_jobs_thread_seq ON jobs(chat_id, thread_ts, seq);
`

function mapRow(row: JobRow): JobRecord {
  return {
    seq: row.seq,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    chatId: row.chat_id,
    threadTs: row.thread_ts,
    messageId: row.message_id,
    userId: row.user_id,
    repoPath: row.repo_path,
    task: row.task,
    status: row.status,
    sessionId: row.session_id,
    resumed: row.resumed === 1,
    workerId: row.worker_id,
    attempts: row.attempts,
    result: row.result,
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function requireText(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} is required`)
  return normalized
}

function positiveInteger(value: string | number | undefined, fallback: number): number {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback
}

function isSqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /database (?:table )?is locked|SQLITE_BUSY/i.test(message)
}

function retrySqlite<T>(action: () => T, attempts = 20): T {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return action()
    } catch (error) {
      if (!isSqliteBusy(error) || attempt === attempts - 1) throw error
      lastError = error
      Bun.sleepSync(Math.min(10 * (attempt + 1), 100))
    }
  }
  throw lastError
}

export class JobStore {
  private readonly db: Database

  constructor(readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
    try {
      chmodSync(dirname(dbPath), 0o700)
    } catch {}
    const previousUmask = process.umask(0o077)
    try {
      this.db = retrySqlite(() => {
        const db = new Database(dbPath, { create: true })
        try {
          db.exec('PRAGMA busy_timeout=5000')
          db.exec('PRAGMA journal_mode=WAL')
          db.exec('PRAGMA synchronous=NORMAL')
          db.exec(JOB_SCHEMA)
          return db
        } catch (error) {
          db.close()
          throw error
        }
      })
    } finally {
      process.umask(previousUmask)
    }
    try {
      chmodSync(dbPath, 0o600)
      chmodSync(`${dbPath}-wal`, 0o600)
      chmodSync(`${dbPath}-shm`, 0o600)
    } catch {}
  }

  close(): void {
    this.db.close()
  }

  enqueue(input: EnqueueInput): {
    job: JobRecord
    duplicate: boolean
    queuePosition: number
  } {
    const chatId = requireText(input.chatId, 'chatId')
    const threadTs = requireText(input.threadTs, 'threadTs')
    const messageId = requireText(input.messageId, 'messageId')
    const userId = requireText(input.userId, 'userId')
    const repoPath = requireText(input.repoPath, 'repoPath')
    const task = requireText(input.task, 'task')
    const idempotencyKey = `${chatId}:${messageId}`
    const id = randomUUID()

    const enqueueTransaction = this.db.transaction(() => {
      const result = this.db.run(
        `INSERT OR IGNORE INTO jobs (
           id, idempotency_key, chat_id, thread_ts, message_id, user_id,
           repo_path, task, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        [id, idempotencyKey, chatId, threadTs, messageId, userId, repoPath, task, Date.now()],
      )

      const row = this.db.query<JobRow, [string]>(
        'SELECT * FROM jobs WHERE idempotency_key = ?',
      ).get(idempotencyKey)
      if (!row) throw new Error('failed to read enqueued job')

      const position = this.db.query<{ position: number }, [number]>(
        `SELECT COUNT(*) AS position
         FROM jobs
         WHERE status = 'queued' AND seq <= ?`,
      ).get(row.seq)?.position ?? 0

      return {
        job: mapRow(row),
        duplicate: result.changes === 0,
        queuePosition: position,
      }
    })

    return retrySqlite(() => enqueueTransaction.immediate())
  }

  get(id: string): JobRecord | null {
    const row = this.db.query<JobRow, [string]>('SELECT * FROM jobs WHERE id = ?').get(id)
    return row ? mapRow(row) : null
  }

  list(limit = 100): JobRecord[] {
    return this.db.query<JobRow, [number]>(
      'SELECT * FROM jobs ORDER BY seq ASC LIMIT ?',
    ).all(limit).map(mapRow)
  }

  countActive(): number {
    return this.db.query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'running')`,
    ).get()?.count ?? 0
  }

  claimNext(workerId: string, maxJobsPerSession = 5): JobRecord | null {
    const sessionJobLimit = Math.max(1, Math.floor(maxJobsPerSession))
    const claim = this.db.transaction((claimingWorkerId: string): JobRecord | null => {
      const row = this.db.query<JobRow, []>(
        `SELECT * FROM jobs WHERE status = 'queued' ORDER BY seq ASC LIMIT 1`,
      ).get()
      if (!row) return null

      const prior = this.db.query<{ session_id: string }, [string, string, number]>(
        `SELECT session_id
         FROM jobs
         WHERE chat_id = ?
           AND thread_ts = ?
           AND seq < ?
           AND session_id IS NOT NULL
           AND status = 'completed'
         ORDER BY seq DESC
         LIMIT 1`,
      ).get(row.chat_id, row.thread_ts, row.seq)
      const sessionJobCount = prior
        ? this.db.query<{ count: number }, [string, string, string]>(
          `SELECT COUNT(*) AS count
           FROM jobs
           WHERE chat_id = ? AND thread_ts = ? AND session_id = ?`,
        ).get(row.chat_id, row.thread_ts, prior.session_id)?.count ?? 0
        : 0
      const canResume = prior !== null && sessionJobCount < sessionJobLimit
      const sessionId = canResume && prior ? prior.session_id : randomUUID()

      const update = this.db.run(
        `UPDATE jobs
         SET status = 'running',
             session_id = ?,
             resumed = ?,
             worker_id = ?,
             attempts = attempts + 1,
             started_at = ?,
             finished_at = NULL,
             last_error = NULL
         WHERE id = ? AND status = 'queued'`,
        [sessionId, canResume ? 1 : 0, claimingWorkerId, Date.now(), row.id],
      )
      if (update.changes !== 1) return null
      return this.get(row.id)
    })

    return claim.immediate(workerId)
  }

  complete(id: string, sessionId: string, result: string): void {
    this.db.run(
      `UPDATE jobs
       SET status = 'completed', session_id = ?, result = ?, last_error = NULL, finished_at = ?
       WHERE id = ?`,
      [sessionId, result, Date.now(), id],
    )
  }

  fail(id: string, error: string): void {
    this.db.run(
      `UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ? WHERE id = ?`,
      [error, Date.now(), id],
    )
  }

  requeue(id: string, reason: string): void {
    this.db.run(
      `UPDATE jobs
       SET status = 'queued', worker_id = NULL, started_at = NULL,
           finished_at = NULL, last_error = ?
       WHERE id = ?`,
      [reason, id],
    )
  }

  recoverInterrupted(): number {
    return this.db.run(
      `UPDATE jobs
       SET status = 'queued', worker_id = NULL, started_at = NULL,
           finished_at = NULL, last_error = 'daemon restarted while job was running'
       WHERE status = 'running'`,
    ).changes
  }
}

export function buildChildEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const child: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) child[key] = value
  }
  for (const sensitive of [
    'CLAUDECODE',
    'SLACK_APP_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_SIGNING_SECRET',
  ]) {
    delete child[sensitive]
  }
  return child
}

/**
 * worker に渡さないツール名パターン（`--disallowed-tools` へそのまま渡す）。
 *
 * 2026-08-17、job のレポートが bot ではなく **オーナー本人の Slack アカウント名義**
 * で投稿された。worker には `--mcp-config` を渡していないので bot 経路の
 * `mcp__slack-channel__*` はそもそも存在せず、task 本文の「Slack に報告しろ」に
 * 従おうとした worker が、唯一届いた claude.ai Slack コネクタ
 * （`mcp__claude_ai_Slack__slack_send_message` = 本人の OAuth）を使ったため。
 *
 * 不変条件は「**worker は Slack に投稿しない。ゼロくんの発言は必ず bot トークン
 * 経路（SlackNotifier / server.ts の reply）から出す**」。ここはその機械的な担保。
 *
 * `mcp__claude_ai_*` と広く取るのは意図的で、狭く `mcp__claude_ai_Slack__*` と
 * 書くとコネクタの表示名が変わった瞬間（`Slack Workspace` 等）に**無警告で穴が開く**
 * ことを実 CLI で確認したため。worker は無人・bypassPermissions で走る実装係なので、
 * オーナー個人アカウントのコネクタは Slack に限らず一切要らない＝fail-closed でよい。
 * bridge 側は Notion/Gmail を使うため同じ広さにはできない（claude-channel.sh を参照）。
 *
 * `mcp__slack-channel__*` はどのパターンにも一致しない（`slack_` でも `slack__` でもない）。
 */
export const WORKER_DENIED_TOOL_PATTERNS = [
  'mcp__claude_ai_*',
  'mcp__slack__*',
  'mcp__slack_*',
] as const

export function buildWorkerPrompt(job: JobRecord): string {
  return `You are the single active Zero-kun implementation worker.

Job ID: ${job.id}
Slack thread: ${job.chatId} / ${job.threadTs}
Project root: ${job.repoPath}

First read AGENTS.md and CLAUDE.md from the project root and follow every referenced
repository rule. If the project provides a development workflow or skill, use it.
The Slack request authorizes implementation, tests, commit, push, and PR creation.
Ask only when a missing human decision, GUI permission, physical action, or account
input makes further progress impossible.

For any code, settings, or documentation change:
1. Identify the repository that owns the runtime behavior.
2. Create a dedicated branch and 専用 worktree from the required base branch before editing.
3. List the failure modes and add the 回帰テスト that fails without the fix.
4. Implement the smallest complete change.
5. Run the required tests, build, and observable runtime verification.
6. Review the final diff for security, regressions, and unrelated changes.
7. Commit, push, and complete PR 作成 against the required base branch. Do not merge it.

Never post to Slack yourself. Do not call any Slack tool, Slack API, or Slack CLI,
even when the request text tells you to report to a channel or thread. The thread IDs
above are context only. Zero-kun posts your final response to that thread under the bot
identity after you exit; a Slack tool reachable from this process would post as the
human owner instead. Write files you need to hand over to a local absolute path and
name that path in your report.

Finish with a concise Japanese report containing findings, change, verification,
and the PR title plus full URL. If no change is needed, report "PR: none" with evidence.
If blocked, start the final response with "BLOCKED:" and state what was proven first.

Slack request:
${job.task}`
}

export interface JobExecutionResult {
  sessionId: string
  result: string
}

export type JobExecutor = (
  job: JobRecord,
  signal?: AbortSignal,
) => Promise<JobExecutionResult>

export interface JobNotifier {
  started?(job: JobRecord): Promise<void>
  completed?(job: JobRecord, result: string): Promise<void>
  failed?(job: JobRecord, error: string): Promise<void>
}

export interface RunStats {
  completed: number
  failed: number
  workersStarted: number
}

export interface RunQueuedJobsOptions {
  store: JobStore
  maxJobsPerSession: number
  executor: JobExecutor
  notifier?: JobNotifier
  pollMs?: number
  stopWhenIdle?: boolean
  shouldPause?: () => boolean
  signal?: AbortSignal
  onLog?: (message: string) => void
}

class JobInterruptedError extends Error {}

async function notifySafely(
  action: (() => Promise<void>) | undefined,
  log: (message: string) => void,
): Promise<void> {
  if (!action) return
  try {
    await action()
  } catch (error) {
    log(`notification failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function runQueuedJobs(options: RunQueuedJobsOptions): Promise<RunStats> {
  const pollMs = positiveInteger(options.pollMs, 1000)
  const maxJobsPerSession = positiveInteger(options.maxJobsPerSession, 5)
  const stopWhenIdle = options.stopWhenIdle ?? false
  const log = options.onLog ?? (() => {})
  const stats: RunStats = { completed: 0, failed: 0, workersStarted: SERIAL_WORKER_COUNT }
  const workerId = 'serial-worker'

  log(`${workerId} started`)
  while (!options.signal?.aborted) {
    if (options.shouldPause?.()) {
      await Bun.sleep(pollMs)
      continue
    }

    const job = options.store.claimNext(workerId, maxJobsPerSession)
    if (!job) {
      if (stopWhenIdle && options.store.countActive() === 0) return stats
      await Bun.sleep(pollMs)
      continue
    }

    log(`${workerId} claimed ${job.id}`)
    await notifySafely(
      options.notifier?.started ? () => options.notifier!.started!(job) : undefined,
      log,
    )

    try {
      const execution = await options.executor(job, options.signal)
      options.store.complete(job.id, execution.sessionId, execution.result)
      stats.completed += 1
      await notifySafely(
        options.notifier?.completed
          ? () => options.notifier!.completed!(job, execution.result)
          : undefined,
        log,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof JobInterruptedError || options.signal?.aborted) {
        options.store.requeue(job.id, message || 'worker interrupted')
        log(`${workerId} requeued ${job.id}: ${message}`)
        return stats
      }
      options.store.fail(job.id, message)
      stats.failed += 1
      await notifySafely(
        options.notifier?.failed ? () => options.notifier!.failed!(job, message) : undefined,
        log,
      )
    }
  }
  return stats
}

/**
 * 完了通知に載せる本文の上限。Slack は 3500 字ずつ分割投稿するので、
 * これを超えると 1 ジョブの報告がスレッドを何十通も占有する。
 */
const MAX_RESULT_CHARS = 12_000
/** 形を解釈できなかった時に添える stdout 末尾の量。 */
const RAW_FALLBACK_TAIL_CHARS = 2_000

function capResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result
  return `${result.slice(0, MAX_RESULT_CHARS)}\n\n…(長いため ${MAX_RESULT_CHARS} 字で打ち切りました)`
}

function findResultEvent(events: unknown[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as { type?: unknown; result?: unknown } | null
    if (!event || typeof event !== 'object') continue
    if (event.type === 'result' && typeof event.result === 'string') return event.result
  }
  // type を持たない実装差に備えた二段目の探索。
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as { result?: unknown } | null
    if (event && typeof event === 'object' && typeof event.result === 'string') return event.result
  }
  return null
}

/**
 * Claude の最終メッセージだけを stdout から取り出す。
 *
 * `--output-format json` の形は `--verbose` の有無で変わる:
 *   - verbose 無し … `{ "type": "result", "result": "..." }` の単一オブジェクト
 *   - verbose 有り … 全イベントを含む配列 `[ {...}, ..., { "type": "result", ... } ]`
 * 実装差で JSONL(1 行 1 イベント)になる経路もある。
 *
 * 旧実装は配列形でも `.result`(配列には無い)だけを見ており、取れないと raw 全文へ
 * フォールバックしていた。そのため 2026-08-17 の job 4c8501fb で 2.6MB の
 * セッション全ログが完了通知として Slack へ流れ、70 通投稿された時点で
 * rate limit に当たって停止した。形に依存せず result イベントを探し、
 * 解釈できない場合も raw 全文は絶対に返さない。
 */
export function parseClaudeResult(stdout: string, logPath?: string): string {
  const trimmed = stdout.trim()
  if (!trimmed) return '(Claude returned no text output)'

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) {
      const found = findResultEvent(parsed)
      if (found !== null) return capResult(found)
    } else if (parsed && typeof parsed === 'object') {
      const result = (parsed as { result?: unknown }).result
      if (typeof result === 'string') return capResult(result)
    }
  } catch {
    const events: unknown[] = []
    for (const line of trimmed.split('\n')) {
      const text = line.trim()
      if (!text) continue
      try {
        events.push(JSON.parse(text))
      } catch {}
    }
    const found = findResultEvent(events)
    if (found !== null) return capResult(found)
  }

  return [
    '(Claude の最終メッセージを stdout から取り出せませんでした)',
    `全文ログ: ${logPath ?? 'job-logs/<job-id>.stdout.log'}`,
    `--- stdout 末尾 ${RAW_FALLBACK_TAIL_CHARS} 字 ---`,
    trimmed.slice(-RAW_FALLBACK_TAIL_CHARS),
  ].join('\n')
}

/** 失敗通知に載せる本文の上限。Slack で読めない長さの JSON を貼らないための上限。 */
const MAX_FAILURE_CHARS = 600

/**
 * stdout のイベント列から、人が読める失敗理由を組み立てる。
 *
 * 成功時の本文は parseClaudeResult が最終メッセージだけを取り出すのに対し、
 * 失敗時は stdout / stderr の末尾 2000 字を素で貼っていた。そのため使用量上限
 * (429)で落ちた時に、Slack へ `tus":"rejected","resetsAt":...` のような JSON の
 * 途中から始まる読めない文字列が流れていた(2026-08-17 job 9c5efaef)。
 * 理由が分かるものは日本語 1 行にし、分からないものだけ末尾を短く添える。
 */
export function describeFailure(
  exitCode: number,
  stdout: string,
  stderr: string,
  logPath?: string,
): string {
  const events: Array<Record<string, unknown>> = []
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') events.push(value as Record<string, unknown>)
  }
  const trimmed = stdout.trim()
  try {
    collect(JSON.parse(trimmed))
  } catch {
    for (const line of trimmed.split('\n')) {
      const text = line.trim()
      if (!text) continue
      try {
        collect(JSON.parse(text))
      } catch {}
    }
  }

  // Claude が返す人間向けの一文(「You've hit your session limit · resets 3:50pm」等)を拾う。
  let reason: string | null = null
  let rateLimited = false
  for (const event of events) {
    if (event.error === 'rate_limit' || event.api_error_status === 429) rateLimited = true
    if (typeof event.rateLimitType === 'string') rateLimited = true
    if (typeof event.result === 'string' && event.result.trim() && event.is_error !== false) {
      reason = event.result.trim()
    }
    const message = event.message as { content?: unknown } | undefined
    const content = message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        const text = (block as { type?: unknown; text?: unknown })?.text
        if ((block as { type?: unknown })?.type === 'text' && typeof text === 'string' && text.trim()) {
          reason = text.trim()
        }
      }
    }
  }

  if (reason) {
    const head = rateLimited ? '使用量の上限に達したため中断しました。' : 'Claude が異常終了しました。'
    return `${head}\n${reason.slice(0, MAX_FAILURE_CHARS)}`
  }

  const fallback = (stderr.trim() || trimmed).slice(-MAX_FAILURE_CHARS)
  return [
    `Claude が exit code ${exitCode} で終了しました。`,
    fallback,
    `全文ログ: ${logPath ?? 'job-logs/<job-id>.stdout.log'}`,
  ].join('\n')
}

export async function executeClaudeJob(
  job: JobRecord,
  options: {
    claudeBin?: string
    model?: string
    timeoutMs?: number
    logDir?: string
    signal?: AbortSignal
  } = {},
): Promise<JobExecutionResult> {
  if (!job.sessionId) throw new Error(`job ${job.id} has no session ID`)
  const claudeBin = options.claudeBin ?? process.env.ZEROKUN_CLAUDE_BIN ?? 'claude'
  const model = options.model ?? process.env.ZEROKUN_JOB_MODEL ?? 'opus'
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? process.env.ZEROKUN_JOB_TIMEOUT_MS,
    6 * 60 * 60 * 1000,
  )
  const logDir = options.logDir ?? join(dirname(defaultDbPath()), 'job-logs')
  mkdirSync(logDir, { recursive: true, mode: 0o700 })

  const args = [
    claudeBin,
    '--model', model,
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'json',
    '--verbose',
    '--setting-sources', 'user,project,local',
    '--disallowed-tools', ...WORKER_DENIED_TOOL_PATTERNS,
    ...(job.resumed ? ['--resume', job.sessionId] : ['--session-id', job.sessionId]),
    '-p',
    buildWorkerPrompt(job),
  ]
  const proc = Bun.spawn(args, {
    cwd: job.repoPath,
    env: buildChildEnvironment(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const abort = () => proc.kill()
  options.signal?.addEventListener('abort', abort, { once: true })

  const exitCode = await proc.exited
  clearTimeout(timer)
  options.signal?.removeEventListener('abort', abort)
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  const stdoutPath = join(logDir, `${job.id}.stdout.log`)
  writeFileSync(stdoutPath, stdout, { mode: 0o600 })
  writeFileSync(join(logDir, `${job.id}.stderr.log`), stderr, { mode: 0o600 })

  if (options.signal?.aborted) {
    throw new JobInterruptedError('job runner stopped while Claude was running')
  }
  if (timedOut) throw new Error(`Claude timed out after ${timeoutMs}ms`)
  if (exitCode !== 0) {
    throw new Error(describeFailure(exitCode, stdout, stderr, stdoutPath))
  }

  return { sessionId: job.sessionId, result: parseClaudeResult(stdout, stdoutPath) }
}

function stateDir(): string {
  return process.env.SLACK_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'slack')
}

function defaultDbPath(): string {
  return process.env.ZEROKUN_JOB_DB ?? join(stateDir(), 'jobs.sqlite3')
}

function loadStateEnv(dir: string): void {
  const envFile = join(dir, '.env')
  try {
    chmodSync(envFile, 0o600)
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const match = line.match(/^(\w+)=(.*)$/)
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2]
      }
    }
  } catch {}
}

const SLACK_CHUNK_CHARS = 3_500
/** 1 通知が占有してよい Slack メッセージ数の上限。 */
const MAX_SLACK_MESSAGES = 5
const SLACK_TRUNCATION_NOTICE = '\n\n…(長すぎるため以降を省略しました。全文は job-logs を参照)'

/**
 * 通知本文を Slack の投稿単位へ分割する。何があっても MAX_SLACK_MESSAGES 通を超えない。
 * parseClaudeResult 側でも長さを抑えているが、想定外の入力が来ても
 * スレッドを埋め尽くさないための最後の防波堤としてここでも切る。
 */
export function splitSlackChunks(text: string): string[] {
  const limit = SLACK_CHUNK_CHARS * MAX_SLACK_MESSAGES
  const body = text.length <= limit
    ? text
    : text.slice(0, limit - SLACK_TRUNCATION_NOTICE.length) + SLACK_TRUNCATION_NOTICE
  return body.match(new RegExp(`[\\s\\S]{1,${SLACK_CHUNK_CHARS}}`, 'g')) ?? ['']
}

class SlackNotifier implements JobNotifier {
  constructor(private readonly token: string, private readonly log: (message: string) => void) {}

  private async post(job: JobRecord, text: string): Promise<void> {
    for (const chunk of splitSlackChunks(text)) {
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: job.chatId, thread_ts: job.threadTs, text: chunk }),
      })
      const result = await response.json() as { ok?: boolean; error?: string }
      if (!result.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
    }
  }

  async started(job: JobRecord): Promise<void> {
    await this.post(
      job,
      `ゼロくん job ${job.id.slice(0, 8)} を開始しました。`
      + ` worker=${job.workerId} / project=${basename(job.repoPath)}`,
    )
  }

  async completed(job: JobRecord, result: string): Promise<void> {
    await this.post(job, `ゼロくん job ${job.id.slice(0, 8)} 完了\n\n${result}`)
  }

  async failed(job: JobRecord, error: string): Promise<void> {
    this.log(`job ${job.id} failed: ${error}`)
    await this.post(
      job,
      `ゼロくん job ${job.id.slice(0, 8)} は失敗しました。\n${error.slice(0, 1500)}`,
    )
  }
}

function validateEnqueueInput(raw: unknown): EnqueueInput {
  if (!raw || typeof raw !== 'object') throw new Error('enqueue input must be a JSON object')
  const value = raw as Record<string, unknown>
  const repoInput = requireText(String(value.repoPath ?? ''), 'repoPath')
  const repoPath = realpathSync(repoInput)
  if (!statSync(repoPath).isDirectory()) throw new Error(`repoPath is not a directory: ${repoPath}`)
  return {
    chatId: requireText(String(value.chatId ?? ''), 'chatId'),
    threadTs: requireText(String(value.threadTs ?? ''), 'threadTs'),
    messageId: requireText(String(value.messageId ?? ''), 'messageId'),
    userId: requireText(String(value.userId ?? ''), 'userId'),
    repoPath,
    task: requireText(String(value.task ?? ''), 'task'),
  }
}

function acquireDaemonLock(lockDir: string): boolean {
  const pidFile = join(lockDir, 'pid')
  try {
    mkdirSync(lockDir, { mode: 0o700 })
    writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })
    return true
  } catch {
    let existingPid = 0
    try {
      existingPid = Number(readFileSync(pidFile, 'utf8').trim())
      if (existingPid > 0) process.kill(existingPid, 0)
      const processInfo = Bun.spawnSync(
        ['ps', '-o', 'command=', '-p', String(existingPid)],
        { stdout: 'pipe', stderr: 'ignore' },
      )
      const command = new TextDecoder().decode(processInfo.stdout)
      if (processInfo.exitCode === 0 && /job-runner\.ts\s+daemon/.test(command)) return false
      throw new Error('stale job runner PID')
    } catch {
      rmSync(lockDir, { recursive: true, force: true })
      try {
        mkdirSync(lockDir, { mode: 0o700 })
        writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })
        return true
      } catch {
        return false
      }
    }
  }
}

function updateIsRunning(lockDir: string): boolean {
  try {
    const updaterPid = Number(readFileSync(join(lockDir, 'pid'), 'utf8').trim())
    if (updaterPid <= 0) return false
    process.kill(updaterPid, 0)
    return true
  } catch {
    return false
  }
}

async function readJsonStdin(): Promise<unknown> {
  return new Response(Bun.stdin.stream()).json()
}

async function runCli(): Promise<void> {
  const command = process.argv[2] ?? 'status'
  const dir = stateDir()
  const store = new JobStore(defaultDbPath())

  if (command === 'enqueue') {
    try {
      const result = store.enqueue(validateEnqueueInput(await readJsonStdin()))
      process.stdout.write(`${JSON.stringify({
        id: result.job.id,
        status: result.job.status,
        duplicate: result.duplicate,
        queuePosition: result.queuePosition,
      })}\n`)
    } finally {
      store.close()
    }
    return
  }

  if (command === 'status') {
    try {
      process.stdout.write(`${JSON.stringify(store.list(), null, 2)}\n`)
    } finally {
      store.close()
    }
    return
  }

  if (command !== 'daemon' && command !== 'run-until-idle') {
    store.close()
    throw new Error(`unknown command: ${command}`)
  }

  const lockDir = join(dir, 'job-runner.lock')
  if (!acquireDaemonLock(lockDir)) {
    process.stderr.write(`zerokun job runner already running (${lockDir})\n`)
    store.close()
    return
  }

  const log = (message: string) => process.stderr.write(`${new Date().toISOString()} ${message}\n`)
  const recovered = store.recoverInterrupted()
  if (recovered > 0) log(`requeued ${recovered} interrupted job(s)`)
  loadStateEnv(dir)
  const token = process.env.SLACK_BOT_TOKEN
  const notifier = token ? new SlackNotifier(token, log) : undefined
  if (!notifier) log('SLACK_BOT_TOKEN not found; Slack progress notifications are disabled')

  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  try {
    await runQueuedJobs({
      store,
      maxJobsPerSession: positiveInteger(process.env.ZEROKUN_MAX_JOBS_PER_SESSION, 5),
      pollMs: positiveInteger(process.env.ZEROKUN_JOB_POLL_MS, 1000),
      stopWhenIdle: command === 'run-until-idle',
      shouldPause: () => updateIsRunning(join(dir, 'update.lock')),
      signal: controller.signal,
      notifier,
      executor: (job, signal) => executeClaudeJob(job, { signal }),
      onLog: log,
    })
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    store.close()
    rmSync(lockDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  runCli().catch(error => {
    process.stderr.write(`zerokun job runner: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
