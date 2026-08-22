#!/usr/bin/env bun

import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { WebClient } from '@slack/web-api'
import {
  artifactDirForJob,
  CodexInterruptedError,
  CodexRateLimitError,
  executeCodexJob,
} from './codex-executor.ts'
import {
  processLockOwnerMatches,
  releaseProcessLock,
  tryAcquireProcessLock,
} from './process-lock.ts'
import { resolveZeroStateDir } from './state-dir.ts'
import { atomicWritePrivateFile, readOptionalPrivateFile } from './safe-file.ts'
import { slackWebClientOptions, withSlackDeadline } from './slack-http.ts'
import {
  capRuntimeLogs,
  removeOrphanedJobState,
  removeSettledJobState,
} from './state-maintenance.ts'
import {
  ensureManagedDirectory,
  requireManagedDirectory,
  requireManagedStateRoot,
} from './managed-path.ts'

export const SERIAL_WORKER_COUNT = 1 as const
export const JOB_RUNNER_HANDSHAKE = 'zerokun-codex-runner-v1' as const

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface EnqueueInput {
  chatId: string
  threadTs: string
  messageId: string
  userId: string
  repoPath: string
  task: string
  attachments?: string[]
  writeEnabled?: boolean
}

export interface InboundDeliveryInput {
  chatId: string
  threadTs: string
  messageId: string
  userId: string
  repoPath: string
  text: string
  fileIds?: string[]
  writeEnabled?: boolean
}

export interface InboundDeliveryRecord extends InboundDeliveryInput {
  seq: number
  idempotencyKey: string
  fileIds: string[]
  writeEnabled: boolean
  attempts: number
  notBefore: number | null
}

export type SlackReadCursorScope = 'owned-thread' | 'catchup-recent' | 'catchup-parent' | 'scheduler'
export type SlackReadCursor = {
  cursor: string | null
  complete: boolean
  cycleOldestTs: string | null
  cycleStartedTs: string | null
}

export type SlackReplyScan = {
  scanKey: string
  channelId: string
  threadTs: string
  oldestTs: string
  cursor: string | null
}

type InboundDeliveryRow = {
  seq: number
  idempotency_key: string
  chat_id: string
  thread_ts: string
  message_id: string
  user_id: string
  repo_path: string
  text: string
  file_ids_json: string
  write_enabled: number
  status: 'pending' | 'processing'
  attempts: number
  not_before: number | null
  created_at: number
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
  attachments: string[]
  runtime: 'claude' | 'codex'
  writeEnabled: boolean
  status: JobStatus
  sessionId: string | null
  resumed: boolean
  workerId: string | null
  executorPid: number | null
  attempts: number
  notBefore: number | null
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
  attachments_json: string
  runtime: 'claude' | 'codex'
  write_enabled: number
  status: JobStatus
  session_id: string | null
  resumed: number
  worker_id: string | null
  executor_pid: number | null
  attempts: number
  not_before: number | null
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
  attachments_json TEXT NOT NULL DEFAULT '[]',
  runtime TEXT NOT NULL DEFAULT 'codex'
    CHECK (runtime IN ('claude', 'codex')),
  write_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  session_id TEXT,
  resumed INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  executor_pid INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  result TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_seq ON jobs(status, seq);
CREATE INDEX IF NOT EXISTS idx_jobs_thread_seq ON jobs(chat_id, thread_ts, seq);
CREATE TABLE IF NOT EXISTS slack_threads (
  chat_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  adopted_from_ts TEXT NOT NULL,
  last_activity_ms INTEGER NOT NULL,
  PRIMARY KEY (chat_id, thread_ts)
);
CREATE TABLE IF NOT EXISTS terminal_notifications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('completed', 'failed')),
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_terminal_notifications_pending
  ON terminal_notifications(delivered_at, not_before, created_at);
CREATE TABLE IF NOT EXISTS artifact_deliveries (
  job_id TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  delivered_at INTEGER,
  PRIMARY KEY (job_id, artifact_path),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE TABLE IF NOT EXISTS update_request_ledger (
  idempotency_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_tombstones (
  idempotency_key TEXT PRIMARY KEY,
  write_enabled INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS migration_ledger (
  name TEXT PRIMARY KEY,
  completed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inbound_deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  text TEXT NOT NULL,
  file_ids_json TEXT NOT NULL DEFAULT '[]',
  write_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbound_deliveries_seq
  ON inbound_deliveries(status, seq);
CREATE TABLE IF NOT EXISTS slack_read_cursors (
  scope TEXT NOT NULL CHECK (scope IN ('owned-thread', 'catchup-recent', 'catchup-parent', 'scheduler')),
  cursor_key TEXT NOT NULL,
  cursor TEXT,
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  cycle_oldest_ts TEXT,
  cycle_started_ts TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, cursor_key)
);
CREATE TABLE IF NOT EXISTS slack_pending_dm_channels (
  channel_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_reply_scans (
  scan_key TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  oldest_ts TEXT NOT NULL,
  cursor TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slack_reply_scans_updated
  ON slack_reply_scans(updated_at, scan_key);
`

function ensureJobSchemaMigrations(db: Database): void {
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all()
  if (!columns.some(column => column.name === 'not_before')) {
    try {
      db.exec('ALTER TABLE jobs ADD COLUMN not_before INTEGER')
    } catch (error) {
      // enqueue CLI と daemon が古いDBを同時に開く場合、片方が先に追加しうる。
      const migrated = db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all()
      if (!migrated.some(column => column.name === 'not_before')) throw error
    }
  }
  if (!columns.some(column => column.name === 'runtime')) {
    try {
      // Existing rows contain Claude Code session IDs. Marking them explicitly
      // prevents the Codex worker from ever trying to resume one.
      db.exec("ALTER TABLE jobs ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude'")
    } catch (error) {
      const migrated = db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all()
      if (!migrated.some(column => column.name === 'runtime')) throw error
    }
  }
  if (!columns.some(column => column.name === 'write_enabled')) {
    try {
      db.exec('ALTER TABLE jobs ADD COLUMN write_enabled INTEGER NOT NULL DEFAULT 0')
    } catch (error) {
      const migrated = db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all()
      if (!migrated.some(column => column.name === 'write_enabled')) throw error
    }
  }
  if (!columns.some(column => column.name === 'attachments_json')) {
    try {
      db.exec("ALTER TABLE jobs ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'")
    } catch (error) {
      const migrated = db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all()
      if (!migrated.some(column => column.name === 'attachments_json')) throw error
    }
  }
  if (!columns.some(column => column.name === 'executor_pid')) {
    try {
      db.exec('ALTER TABLE jobs ADD COLUMN executor_pid INTEGER')
    } catch (error) {
      const migrated = db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all()
      if (!migrated.some(column => column.name === 'executor_pid')) throw error
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_ready_seq ON jobs(status, not_before, seq)')
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_runtime_ready_seq ON jobs(runtime, status, not_before, seq)")
}

function parseAttachments(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

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
    attachments: parseAttachments(row.attachments_json),
    runtime: row.runtime,
    writeEnabled: row.write_enabled === 1,
    status: row.status,
    sessionId: row.session_id,
    resumed: row.resumed === 1,
    workerId: row.worker_id,
    executorPid: row.executor_pid,
    attempts: row.attempts,
    notBefore: row.not_before,
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

function requireSafeDatabasePath(dbPath: string): void {
  const parent = dirname(dbPath)
  const parentMetadata = lstatSync(parent)
  const parentOwner = typeof process.getuid !== 'function' || parentMetadata.uid === process.getuid()
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || !parentOwner
    || (Number(parentMetadata.mode) & 0o022) !== 0) {
    throw new Error(`unsafe SQLite parent directory: ${parent}`)
  }
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      const metadata = lstatSync(path)
      const owner = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !owner) {
        throw new Error(`unsafe SQLite file: ${path}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export class JobStore {
  private readonly db: Database

  constructor(readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
    requireSafeDatabasePath(dbPath)
    const previousUmask = process.umask(0o077)
    try {
      this.db = retrySqlite(() => {
        const db = new Database(dbPath, { create: true })
        try {
          db.exec('PRAGMA busy_timeout=5000')
          db.exec('PRAGMA foreign_keys=ON')
          db.exec('PRAGMA auto_vacuum=INCREMENTAL')
          db.exec('PRAGMA journal_mode=WAL')
          db.exec('PRAGMA synchronous=NORMAL')
          db.exec(JOB_SCHEMA)
          ensureJobSchemaMigrations(db)
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
      requireSafeDatabasePath(dbPath)
      chmodSync(dbPath, 0o600)
      chmodSync(`${dbPath}-wal`, 0o600)
      chmodSync(`${dbPath}-shm`, 0o600)
    } catch {}
  }

  /** Run only while gateway/runner are stopped; upgrades legacy DBs so incremental GC reclaims disk. */
  enableIncrementalVacuum(): void {
    const current = this.db.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()
      ?.auto_vacuum ?? 0
    if (current === 2) return
    retrySqlite(() => {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      this.db.exec('PRAGMA journal_mode=DELETE')
      this.db.exec('PRAGMA auto_vacuum=INCREMENTAL')
      this.db.exec('VACUUM')
      this.db.exec('PRAGMA journal_mode=WAL')
    }, 2)
  }

  close(): void {
    this.db.close()
  }

  stageInboundDelivery(input: InboundDeliveryInput): boolean {
    const chatId = requireText(input.chatId, 'chatId')
    const messageId = requireText(input.messageId, 'messageId')
    const fileIds = (input.fileIds ?? []).map(id => requireText(id, 'fileId'))
    const idempotencyKey = `${chatId}:${messageId}`
    const stage = this.db.transaction(() => {
      const retained = this.db.query<{ present: number }, [string]>(
        'SELECT 1 AS present FROM delivery_tombstones WHERE idempotency_key = ?',
      ).get(idempotencyKey)
      if (retained) return false
      const completedHandoff = this.db.query<{ present: number }, [string]>(
        'SELECT 1 AS present FROM jobs WHERE idempotency_key = ?',
      ).get(idempotencyKey)
      if (completedHandoff) return false
      return this.db.run(
        `INSERT OR IGNORE INTO inbound_deliveries (
           idempotency_key, chat_id, thread_ts, message_id, user_id,
           repo_path, text, file_ids_json, write_enabled, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          idempotencyKey,
          chatId,
          requireText(input.threadTs, 'threadTs'),
          messageId,
          requireText(input.userId, 'userId'),
          requireText(input.repoPath, 'repoPath'),
          input.text,
          JSON.stringify(fileIds),
          input.writeEnabled ? 1 : 0,
          Date.now(),
        ],
      ).changes === 1
    })
    return retrySqlite(() => stage.immediate())
  }

  hasDurableEvent(idempotencyKey: string): boolean {
    const key = requireText(idempotencyKey, 'idempotencyKey')
    return retrySqlite(() => this.db.query<{ present: number }, [string, string, string, string]>(
      `SELECT 1 AS present FROM inbound_deliveries WHERE idempotency_key = ?
       UNION ALL SELECT 1 FROM jobs WHERE idempotency_key = ?
       UNION ALL SELECT 1 FROM delivery_tombstones WHERE idempotency_key = ?
       UNION ALL SELECT 1 FROM update_request_ledger WHERE idempotency_key = ?
       LIMIT 1`,
    ).get(key, key, key, key) !== null)
  }

  readSlackReadCursor(scope: SlackReadCursorScope, cursorKey: string): SlackReadCursor | null {
    const key = requireText(cursorKey, 'cursorKey')
    const row = retrySqlite(() => this.db.query<{
      cursor: string | null
      complete: number
      cycle_oldest_ts: string | null
      cycle_started_ts: string | null
    }, [SlackReadCursorScope, string]>(
      `SELECT cursor, complete, cycle_oldest_ts, cycle_started_ts
       FROM slack_read_cursors WHERE scope = ? AND cursor_key = ?`,
    ).get(scope, key))
    return row ? {
      cursor: row.cursor,
      complete: row.complete === 1,
      cycleOldestTs: row.cycle_oldest_ts,
      cycleStartedTs: row.cycle_started_ts,
    } : null
  }

  /**
   * Advance a Slack API read position only while every event it covers is in
   * this same SQLite ledger. WAL ordering then cannot preserve the cursor
   * while losing an earlier event commit, unlike the former JSON sidecars.
   */
  commitSlackReadCursorIfDurable(
    scope: SlackReadCursorScope,
    cursorKey: string,
    cursor: string | null,
    complete: boolean,
    requiredEventKeys: Iterable<string>,
    cycle?: { oldestTs: string; startedTs: string },
  ): boolean {
    const key = requireText(cursorKey, 'cursorKey')
    if (cursor !== null && (!cursor || cursor.length > 2048)) {
      throw new Error('Slack read cursor is invalid')
    }
    const eventKeys = [...new Set(requiredEventKeys)].map(value => requireText(value, 'eventKey'))
    const commit = this.db.transaction(() => {
      for (const eventKey of eventKeys) {
        const durable = this.db.query<{ present: number }, [string, string, string, string]>(
          `SELECT 1 AS present FROM inbound_deliveries WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM jobs WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM delivery_tombstones WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM update_request_ledger WHERE idempotency_key = ?
           LIMIT 1`,
        ).get(eventKey, eventKey, eventKey, eventKey)
        if (!durable) return false
      }
      this.db.run(
        `INSERT INTO slack_read_cursors (
           scope, cursor_key, cursor, complete, cycle_oldest_ts, cycle_started_ts, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, cursor_key) DO UPDATE SET
           cursor = excluded.cursor,
           complete = excluded.complete,
           cycle_oldest_ts = excluded.cycle_oldest_ts,
           cycle_started_ts = excluded.cycle_started_ts,
           updated_at = excluded.updated_at`,
        [
          scope, key, cursor, complete ? 1 : 0,
          cycle?.oldestTs ?? null, cycle?.startedTs ?? null, Date.now(),
        ],
      )
      return true
    })
    return retrySqlite(() => commit.immediate())
  }

  restartCompletedSlackReadCursor(
    scope: SlackReadCursorScope,
    cursorKey: string,
    nextCycleStartedTs: string,
    nextCycleOldestTs?: string,
  ): boolean {
    const key = requireText(cursorKey, 'cursorKey')
    const started = requireText(nextCycleStartedTs, 'nextCycleStartedTs')
    return retrySqlite(() => this.db.run(
      `UPDATE slack_read_cursors
       SET cursor = NULL,
           complete = 0,
           cycle_oldest_ts = COALESCE(?, cycle_started_ts, cycle_oldest_ts),
           cycle_started_ts = ?,
           updated_at = ?
       WHERE scope = ? AND cursor_key = ? AND complete = 1`,
      [nextCycleOldestTs ?? null, started, Date.now(), scope, key],
    ).changes === 1)
  }

  resetSlackReadCursor(scope: SlackReadCursorScope, cursorKey: string): boolean {
    return retrySqlite(() => this.db.run(
      `UPDATE slack_read_cursors
       SET cursor = NULL, complete = 0, updated_at = ?
       WHERE scope = ? AND cursor_key = ?`,
      [Date.now(), scope, requireText(cursorKey, 'cursorKey')],
    ).changes === 1)
  }

  deleteSlackReadCursorsExcept(scope: SlackReadCursorScope, cursorKeys: Iterable<string>): number {
    const retained = new Set([...cursorKeys].map(value => requireText(value, 'cursorKey')))
    const remove = this.db.transaction(() => {
      let changes = 0
      const rows = this.db.query<{ cursor_key: string }, [SlackReadCursorScope]>(
        'SELECT cursor_key FROM slack_read_cursors WHERE scope = ?',
      ).all(scope)
      for (const row of rows) {
        if (retained.has(row.cursor_key)) continue
        changes += this.db.run(
          'DELETE FROM slack_read_cursors WHERE scope = ? AND cursor_key = ?',
          [scope, row.cursor_key],
        ).changes
      }
      return changes
    })
    return retrySqlite(() => remove.immediate())
  }

  /** Stage a complete Slack DM-list page before advancing its opaque cursor. */
  stageSlackDirectMessagePage(
    channelIds: Iterable<string>,
    nextCursor: string | null,
    complete: boolean,
  ): void {
    const channels = [...new Set(channelIds)].map(value => requireText(value, 'channelId'))
    if (nextCursor !== null && (!nextCursor || nextCursor.length > 2048)) {
      throw new Error('Slack DM list cursor is invalid')
    }
    const stage = this.db.transaction(() => {
      const now = Date.now()
      for (const channelId of channels) {
        this.db.run(
          `INSERT OR IGNORE INTO slack_pending_dm_channels (channel_id, created_at)
           VALUES (?, ?)`,
          [channelId, now],
        )
      }
      this.db.run(
        `INSERT INTO slack_read_cursors (
           scope, cursor_key, cursor, complete, cycle_oldest_ts, cycle_started_ts, updated_at
         ) VALUES ('scheduler', 'dm-list', ?, ?, NULL, NULL, ?)
         ON CONFLICT(scope, cursor_key) DO UPDATE SET
           cursor = excluded.cursor,
           complete = excluded.complete,
           cycle_oldest_ts = NULL,
           cycle_started_ts = NULL,
           updated_at = excluded.updated_at`,
        [nextCursor, complete ? 1 : 0, now],
      )
    })
    retrySqlite(() => stage.immediate())
  }

  listPendingDirectMessageChannels(): string[] {
    return retrySqlite(() => this.db.query<{ channel_id: string }, []>(
      'SELECT channel_id FROM slack_pending_dm_channels ORDER BY channel_id',
    ).all().map(row => row.channel_id))
  }

  completePendingDirectMessageChannel(channelId: string): boolean {
    return retrySqlite(() => this.db.run(
      'DELETE FROM slack_pending_dm_channels WHERE channel_id = ?',
      [requireText(channelId, 'channelId')],
    ).changes === 1)
  }

  /** Persist history parents independently so the history page may advance. */
  stageSlackReplyScans(
    scans: Iterable<{ channelId: string; threadTs: string; oldestTs: string }>,
  ): number {
    const rows = [...scans].map(scan => ({
      channelId: requireText(scan.channelId, 'channelId'),
      threadTs: requireText(scan.threadTs, 'threadTs'),
      oldestTs: requireText(scan.oldestTs, 'oldestTs'),
    }))
    const stage = this.db.transaction(() => {
      let changes = 0
      const now = Date.now()
      for (const row of rows) {
        const scanKey = JSON.stringify([row.channelId, row.threadTs, row.oldestTs])
        changes += this.db.run(
          `INSERT OR IGNORE INTO slack_reply_scans (
             scan_key, channel_id, thread_ts, oldest_ts, cursor, updated_at
           ) VALUES (?, ?, ?, ?, NULL, ?)`,
          [scanKey, row.channelId, row.threadTs, row.oldestTs, now],
        ).changes
      }
      return changes
    })
    return retrySqlite(() => stage.immediate())
  }

  listSlackReplyScans(limit = 20): SlackReplyScan[] {
    const bounded = positiveInteger(limit, 20)
    return retrySqlite(() => this.db.query<{
      scan_key: string
      channel_id: string
      thread_ts: string
      oldest_ts: string
      cursor: string | null
    }, [number]>(
      `SELECT scan_key, channel_id, thread_ts, oldest_ts, cursor
       FROM slack_reply_scans ORDER BY updated_at, scan_key LIMIT ?`,
    ).all(bounded).map(row => ({
      scanKey: row.scan_key,
      channelId: row.channel_id,
      threadTs: row.thread_ts,
      oldestTs: row.oldest_ts,
      cursor: row.cursor,
    })))
  }

  commitSlackReplyScanPageIfDurable(
    scanKey: string,
    nextCursor: string | null,
    requiredEventKeys: Iterable<string>,
  ): boolean {
    const key = requireText(scanKey, 'scanKey')
    if (nextCursor !== null && (!nextCursor || nextCursor.length > 2048)) {
      throw new Error('Slack reply cursor is invalid')
    }
    const eventKeys = [...new Set(requiredEventKeys)].map(value => requireText(value, 'eventKey'))
    const commit = this.db.transaction(() => {
      for (const eventKey of eventKeys) {
        if (!this.db.query<{ present: number }, [string, string, string, string]>(
          `SELECT 1 AS present FROM inbound_deliveries WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM jobs WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM delivery_tombstones WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM update_request_ledger WHERE idempotency_key = ?
           LIMIT 1`,
        ).get(eventKey, eventKey, eventKey, eventKey)) return false
      }
      if (nextCursor === null) {
        return this.db.run('DELETE FROM slack_reply_scans WHERE scan_key = ?', [key]).changes === 1
      }
      return this.db.run(
        `UPDATE slack_reply_scans
         SET cursor = ?,
             updated_at = (SELECT COALESCE(MAX(updated_at), 0) + 1 FROM slack_reply_scans)
         WHERE scan_key = ?`,
        [nextCursor, key],
      ).changes === 1
    })
    return retrySqlite(() => commit.immediate())
  }

  deferSlackReplyScan(scanKey: string): void {
    retrySqlite(() => this.db.run(
      `UPDATE slack_reply_scans
       SET updated_at = (SELECT COALESCE(MAX(updated_at), 0) + 1 FROM slack_reply_scans)
       WHERE scan_key = ?`,
      [requireText(scanKey, 'scanKey')],
    ))
  }

  discardSlackReplyScan(scanKey: string): boolean {
    return retrySqlite(() => this.db.run(
      'DELETE FROM slack_reply_scans WHERE scan_key = ?',
      [requireText(scanKey, 'scanKey')],
    ).changes === 1)
  }

  recoverInboundDeliveries(): number {
    return retrySqlite(() => this.db.run(
      `UPDATE inbound_deliveries SET status = 'pending'
       WHERE status = 'processing'`,
    ).changes)
  }

  claimNextInboundDelivery(now = Date.now()): InboundDeliveryRecord | null {
    const claim = this.db.transaction(() => {
      const row = this.db.query<InboundDeliveryRow, []>(
        `SELECT * FROM inbound_deliveries ORDER BY seq ASC LIMIT 1`,
      ).get()
      if (!row || (row.not_before !== null && row.not_before > now)) return null
      const updated = this.db.run(
        `UPDATE inbound_deliveries SET status = 'processing'
         WHERE seq = ? AND status = 'pending'`,
        [row.seq],
      )
      if (updated.changes !== 1) return null
      return {
        seq: row.seq,
        idempotencyKey: row.idempotency_key,
        chatId: row.chat_id,
        threadTs: row.thread_ts,
        messageId: row.message_id,
        userId: row.user_id,
        repoPath: row.repo_path,
        text: row.text,
        fileIds: parseAttachments(row.file_ids_json),
        writeEnabled: row.write_enabled === 1,
        attempts: row.attempts,
        notBefore: row.not_before,
      }
    })
    return retrySqlite(() => claim.immediate())
  }

  deferInboundDelivery(idempotencyKey: string, error: string, notBefore: number): void {
    retrySqlite(() => this.db.run(
      `UPDATE inbound_deliveries
       SET status = 'pending', attempts = attempts + 1, not_before = ?, last_error = ?
       WHERE idempotency_key = ? AND status = 'processing'`,
      [notBefore, error, requireText(idempotencyKey, 'idempotencyKey')],
    ))
  }

  failInboundDelivery(idempotencyKey: string, error: string): string {
    const fail = this.db.transaction(() => {
      const key = requireText(idempotencyKey, 'idempotencyKey')
      const row = this.db.query<InboundDeliveryRow, [string]>(
        'SELECT * FROM inbound_deliveries WHERE idempotency_key = ? AND status = \'processing\'',
      ).get(key)
      if (!row) throw new Error(`inbound delivery is no longer processing: ${key}`)
      const now = Date.now()
      const jobId = randomUUID()
      this.db.run(
        `INSERT INTO jobs (
           id, idempotency_key, chat_id, thread_ts, message_id, user_id,
           repo_path, task, attachments_json, runtime, write_enabled,
           status, attempts, last_error, created_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 'codex', ?, 'failed', ?, ?, ?, ?)`,
        [
          jobId, key, row.chat_id, row.thread_ts, row.message_id, row.user_id,
          row.repo_path, row.text || '(attachment delivery failed)', row.write_enabled,
          row.attempts + 1, error, row.created_at, now,
        ],
      )
      this.db.run(
        `INSERT INTO slack_threads (
           chat_id, thread_ts, repo_path, adopted_from_ts, last_activity_ms
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, thread_ts) DO UPDATE SET
           last_activity_ms = excluded.last_activity_ms`,
        [row.chat_id, row.thread_ts, row.repo_path, row.message_id, now],
      )
      this.db.run(
        `INSERT INTO terminal_notifications (id, job_id, kind, payload, created_at)
         VALUES (?, ?, 'failed', ?, ?)`,
        [randomUUID(), jobId, error, now],
      )
      this.db.run('DELETE FROM inbound_deliveries WHERE idempotency_key = ?', [key])
      return jobId
    })
    return retrySqlite(() => fail.immediate())
  }

  completeInboundDelivery(idempotencyKey: string): void {
    retrySqlite(() => this.db.run(
      `DELETE FROM inbound_deliveries WHERE idempotency_key = ?`,
      [requireText(idempotencyKey, 'idempotencyKey')],
    ))
  }

  inboundDeliveryCount(): number {
    return this.db.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM inbound_deliveries',
    ).get()?.count ?? 0
  }

  /**
   * Convert active Claude rows only after the legacy gateway and runner are
   * stopped under the cutover lock. Ordinary reads and gateway startup must
   * never mutate a job that the legacy runner may still be executing.
   */
  migrateLegacyActive(): number {
    const migrate = this.db.transaction(() => {
      const now = Date.now()
      const uncertain = this.db.query<{ id: string }, []>(
        "SELECT id FROM jobs WHERE runtime = 'claude' AND status = 'running'",
      ).all()
      const queued = this.db.run(`
        UPDATE jobs
        SET runtime = 'codex', session_id = NULL, resumed = 0, worker_id = NULL,
            executor_pid = NULL, not_before = NULL,
            last_error = 'migrated from Claude Code queue to Codex'
        WHERE runtime = 'claude' AND status = 'queued'
      `).changes
      const failure = '旧Claude runner停止時に実行中だったため、自動再実行していません。依頼を確認して再送してください。'
      const failed = this.db.run(`
        UPDATE jobs
        SET status = 'failed', executor_pid = NULL, not_before = NULL,
            last_error = ?, finished_at = ?
        WHERE runtime = 'claude' AND status = 'running'
      `, [failure, now]).changes
      for (const row of uncertain) {
        this.db.run(
          `INSERT INTO terminal_notifications (id, job_id, kind, payload, created_at)
           VALUES (?, ?, 'failed', ?, ?)
           ON CONFLICT(job_id) DO NOTHING`,
          [randomUUID(), row.id, failure, now],
        )
      }
      return queued + failed
    })
    return retrySqlite(() => migrate.immediate())
  }

  countLegacyActive(): number {
    return this.db.query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM jobs
       WHERE runtime = 'claude' AND status IN ('queued', 'running')`,
    ).get()?.count ?? 0
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
    const attachments = (input.attachments ?? []).map(path => requireText(path, 'attachment'))
    // Keep the legacy key shape so a Slack event already persisted by the
    // Claude runner cannot be enqueued a second time during cutover.
    const idempotencyKey = `${chatId}:${messageId}`
    const id = randomUUID()

    const enqueueTransaction = this.db.transaction(() => {
      const retained = this.db.query<{ present: number }, [string]>(
        'SELECT 1 AS present FROM delivery_tombstones WHERE idempotency_key = ?',
      ).get(idempotencyKey)
      if (retained) throw new Error(`event already completed and retained: ${idempotencyKey}`)
      const result = this.db.run(
        `INSERT OR IGNORE INTO jobs (
           id, idempotency_key, chat_id, thread_ts, message_id, user_id,
           repo_path, task, attachments_json, runtime, write_enabled, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'codex', ?, 'queued', ?)`,
        [
          id,
          idempotencyKey,
          chatId,
          threadTs,
          messageId,
          userId,
          repoPath,
          task,
          JSON.stringify(attachments),
          input.writeEnabled ? 1 : 0,
          Date.now(),
        ],
      )

      this.db.run(
        `INSERT INTO slack_threads (
           chat_id, thread_ts, repo_path, adopted_from_ts, last_activity_ms
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, thread_ts) DO UPDATE SET
           last_activity_ms = excluded.last_activity_ms`,
        [chatId, threadTs, repoPath, messageId, Date.now()],
      )

      const row = this.db.query<JobRow, [string]>(
        'SELECT * FROM jobs WHERE idempotency_key = ?',
      ).get(idempotencyKey)
      if (!row) throw new Error('failed to read enqueued job')

      const position = this.db.query<{ position: number }, [number]>(
        `SELECT COUNT(*) AS position
         FROM jobs
         WHERE runtime = 'codex' AND status = 'queued' AND seq <= ?`,
      ).get(row.seq)?.position ?? 0

      return {
        job: mapRow(row),
        duplicate: result.changes === 0,
        queuePosition: position,
      }
    })

    return retrySqlite(() => enqueueTransaction.immediate())
  }

  reserveUpdateRequest(idempotencyKey: string): boolean {
    return this.db.run(
      `INSERT OR IGNORE INTO update_request_ledger (idempotency_key, created_at)
       VALUES (?, ?)`,
      [requireText(idempotencyKey, 'idempotencyKey'), Date.now()],
    ).changes === 1
  }

  migrationApplied(name: string): boolean {
    return this.db.query<{ present: number }, [string]>(
      'SELECT 1 AS present FROM migration_ledger WHERE name = ?',
    ).get(requireText(name, 'migration name')) !== null
  }

  markMigrationApplied(name: string): void {
    this.db.run(
      'INSERT OR IGNORE INTO migration_ledger (name, completed_at) VALUES (?, ?)',
      [requireText(name, 'migration name'), Date.now()],
    )
  }

  hasUpdateRequest(idempotencyKey: string): boolean {
    return this.db.query<{ present: number }, [string]>(
      `SELECT 1 AS present FROM update_request_ledger WHERE idempotency_key = ?`,
    ).get(requireText(idempotencyKey, 'idempotencyKey')) !== null
  }

  releaseUpdateRequest(idempotencyKey: string): void {
    this.db.run('DELETE FROM update_request_ledger WHERE idempotency_key = ?', [idempotencyKey])
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
      `SELECT COUNT(*) AS count FROM jobs
       WHERE runtime = 'codex' AND status IN ('queued', 'running')`,
    ).get()?.count ?? 0
  }

  countClaimable(now = Date.now()): number {
    const head = this.db.query<{ not_before: number | null }, []>(
      `SELECT not_before FROM jobs
       WHERE runtime = 'codex' AND status = 'queued'
       ORDER BY seq ASC LIMIT 1`,
    ).get()
    return head && (head.not_before === null || head.not_before <= now) ? 1 : 0
  }

  claimNext(workerId: string, maxJobsPerSession = 5, now = Date.now()): JobRecord | null {
    const sessionJobLimit = Math.max(1, Math.floor(maxJobsPerSession))
    const claim = this.db.transaction((claimingWorkerId: string, claimAt: number): JobRecord | null => {
      const row = this.db.query<JobRow, []>(
        `SELECT * FROM jobs
         WHERE runtime = 'codex'
           AND status = 'queued'
         ORDER BY seq ASC
         LIMIT 1`,
      ).get()
      if (!row) return null
      if (row.not_before !== null && row.not_before > claimAt) return null

      const isRetry = row.attempts > 0 && row.session_id !== null
      let sessionId: string | null
      let resumed: boolean
      if (isRetry) {
        sessionId = row.session_id!
        resumed = true
      } else {
        const prior = this.db.query<
          { session_id: string },
          [string, string, string, string, number, number]
        >(
          `SELECT session_id
           FROM jobs
           WHERE runtime = 'codex'
             AND chat_id = ?
             AND thread_ts = ?
             AND repo_path = ?
             AND user_id = ?
             AND write_enabled = ?
             AND seq < ?
             AND session_id IS NOT NULL
             AND status = 'completed'
           ORDER BY seq DESC
           LIMIT 1`,
        ).get(
          row.chat_id,
          row.thread_ts,
          row.repo_path,
          row.user_id,
          row.write_enabled,
          row.seq,
        )
        const sessionJobCount = prior
          ? this.db.query<{ count: number }, [string, string, string, string, string]>(
            `SELECT COUNT(*) AS count
             FROM jobs
             WHERE runtime = 'codex' AND chat_id = ? AND thread_ts = ?
               AND repo_path = ? AND user_id = ? AND session_id = ?`,
          ).get(
            row.chat_id,
            row.thread_ts,
            row.repo_path,
            row.user_id,
            prior.session_id,
          )?.count ?? 0
          : 0
        resumed = prior !== null && sessionJobCount < sessionJobLimit
        sessionId = resumed && prior ? prior.session_id : null
      }

      const update = this.db.run(
        `UPDATE jobs
         SET status = 'running',
             session_id = ?,
             resumed = ?,
             worker_id = ?,
             executor_pid = NULL,
             attempts = attempts + 1,
             started_at = ?,
             not_before = NULL,
             finished_at = NULL,
             last_error = NULL
         WHERE id = ? AND status = 'queued'`,
        [sessionId, resumed ? 1 : 0, claimingWorkerId, claimAt, row.id],
      )
      if (update.changes !== 1) return null
      return this.get(row.id)
    })

    return claim.immediate(workerId, now)
  }

  complete(id: string, sessionId: string, result: string): void {
    const complete = this.db.transaction(() => {
      const finishedAt = Date.now()
      const updated = this.db.run(
        `UPDATE jobs
         SET status = 'completed', session_id = ?, result = ?, last_error = NULL,
             not_before = NULL, executor_pid = NULL, finished_at = ?
         WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
        [sessionId, result, finishedAt, id],
      )
      if (updated.changes !== 1) throw new Error('job is no longer running: ' + id)
      this.db.run(
        `INSERT INTO terminal_notifications (
           id, job_id, kind, payload, created_at
         ) VALUES (?, ?, 'completed', ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           kind = excluded.kind, payload = excluded.payload,
           attempts = 0, not_before = NULL, last_error = NULL,
           created_at = excluded.created_at, delivered_at = NULL`,
        [randomUUID(), id, result, finishedAt],
      )
      for (const artifactPath of extractArtifactPaths(result).files) {
        this.db.run(
          `INSERT INTO artifact_deliveries (job_id, artifact_path)
           VALUES (?, ?) ON CONFLICT(job_id, artifact_path) DO NOTHING`,
          [id, artifactPath],
        )
      }
    })
    retrySqlite(() => complete.immediate())
  }

  saveSession(id: string, sessionId: string): void {
    this.db.run(
      `UPDATE jobs SET session_id = ? WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
      [requireText(sessionId, 'sessionId'), id],
    )
  }

  saveExecutorPid(id: string, executorPid: number): void {
    if (!Number.isInteger(executorPid) || executorPid <= 0) {
      throw new Error('invalid executor PID: ' + executorPid)
    }
    const updated = this.db.run(
      `UPDATE jobs SET executor_pid = ?
       WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
      [executorPid, id],
    )
    if (updated.changes !== 1) throw new Error('job is no longer running: ' + id)
  }

  clearExecutorPid(id: string, executorPid: number): void {
    this.db.run(
      `UPDATE jobs SET executor_pid = NULL
       WHERE id = ? AND runtime = 'codex' AND status = 'running' AND executor_pid = ?`,
      [id, executorPid],
    )
  }

  clearSession(id: string): void {
    this.db.run(
      `UPDATE jobs SET session_id = NULL, resumed = 0
       WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
      [id],
    )
  }

  getThread(chatId: string, threadTs: string): {
    chatId: string
    threadTs: string
    repoPath: string
    adoptedFromTs: string
    lastActivityMs: number
  } | null {
    const row = this.db.query<{
      chat_id: string
      thread_ts: string
      repo_path: string
      adopted_from_ts: string
      last_activity_ms: number
    }, [string, string]>(
      'SELECT * FROM slack_threads WHERE chat_id = ? AND thread_ts = ?',
    ).get(chatId, threadTs)
    return row ? {
      chatId: row.chat_id,
      threadTs: row.thread_ts,
      repoPath: row.repo_path,
      adoptedFromTs: row.adopted_from_ts,
      lastActivityMs: row.last_activity_ms,
    } : null
  }

  listThreads(): Array<{
    chatId: string
    threadTs: string
    repoPath: string
    adoptedFromTs: string
    lastActivityMs: number
  }> {
    return this.db.query<{
      chat_id: string
      thread_ts: string
      repo_path: string
      adopted_from_ts: string
      last_activity_ms: number
    }, []>('SELECT * FROM slack_threads').all().map(row => ({
      chatId: row.chat_id,
      threadTs: row.thread_ts,
      repoPath: row.repo_path,
      adoptedFromTs: row.adopted_from_ts,
      lastActivityMs: row.last_activity_ms,
    }))
  }

  adoptThread(input: {
    chatId: string
    threadTs: string
    repoPath: string
    adoptedFromTs: string
    lastActivityMs: number
  }): void {
    this.db.run(
      `INSERT OR IGNORE INTO slack_threads (
         chat_id, thread_ts, repo_path, adopted_from_ts, last_activity_ms
       ) VALUES (?, ?, ?, ?, ?)`,
      [input.chatId, input.threadTs, input.repoPath, input.adoptedFromTs, input.lastActivityMs],
    )
  }

  fail(id: string, error: string): void {
    const fail = this.db.transaction(() => {
      const finishedAt = Date.now()
      const updated = this.db.run(
        `UPDATE jobs
         SET status = 'failed', not_before = NULL, executor_pid = NULL,
             last_error = ?, finished_at = ?
         WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
        [error, finishedAt, id],
      )
      if (updated.changes !== 1) throw new Error('job is no longer running: ' + id)
      this.db.run(
        `INSERT INTO terminal_notifications (
           id, job_id, kind, payload, created_at
         ) VALUES (?, ?, 'failed', ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           kind = excluded.kind, payload = excluded.payload,
           attempts = 0, not_before = NULL, last_error = NULL,
           created_at = excluded.created_at, delivered_at = NULL`,
        [randomUUID(), id, error, finishedAt],
      )
    })
    retrySqlite(() => fail.immediate())
  }

  pendingTerminalNotifications(now = Date.now(), limit = 20): TerminalNotification[] {
    const rows = this.db.query<{
      id: string
      job_id: string
      kind: 'completed' | 'failed'
      payload: string
      attempts: number
      not_before: number | null
    }, [number, number]>(
      `SELECT id, job_id, kind, payload, attempts, not_before
       FROM terminal_notifications
       WHERE delivered_at IS NULL AND (not_before IS NULL OR not_before <= ?)
       ORDER BY created_at ASC LIMIT ?`,
    ).all(now, limit)
    return rows.flatMap(row => {
      const job = this.get(row.job_id)
      return job ? [{ ...row, jobId: row.job_id, job }] : []
    })
  }

  markTerminalNotificationDelivered(id: string): void {
    this.db.run(
      `UPDATE terminal_notifications
       SET delivered_at = ?, not_before = NULL, last_error = NULL
       WHERE id = ? AND delivered_at IS NULL`,
      [Date.now(), id],
    )
  }

  deferTerminalNotification(
    id: string,
    error: string,
    now = Date.now(),
    retryMs = 30_000,
  ): void {
    this.db.run(
      `UPDATE terminal_notifications
       SET attempts = attempts + 1, not_before = ?, last_error = ?
       WHERE id = ? AND delivered_at IS NULL`,
      [now + Math.max(1, retryMs), error, id],
    )
  }

  terminalNotificationCount(): number {
    return this.db.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM terminal_notifications WHERE delivered_at IS NULL',
    ).get()?.count ?? 0
  }

  artifactDelivered(jobId: string, artifactPath: string): boolean {
    const row = this.db.query<{ delivered_at: number | null }, [string, string]>(
      `SELECT delivered_at FROM artifact_deliveries
       WHERE job_id = ? AND artifact_path = ?`,
    ).get(jobId, artifactPath)
    return row !== null && row.delivered_at !== null
  }

  pruneSettled(options: {
    stateDir: string
    now?: number
    retentionMs: number
    tombstoneRetentionMs: number
  }): {
    jobs: number
    threads: number
    tombstones: number
    files: number
  } {
    const now = options.now ?? Date.now()
    const cutoff = now - Math.max(1, options.retentionMs)
    const tombstoneCutoff = now - Math.max(options.retentionMs, options.tombstoneRetentionMs)
    const prune = this.db.transaction(() => {
      const candidates = this.db.query<{
        id: string
        idempotency_key: string
        write_enabled: number
        attachments_json: string
        finished_at: number
      }, [number]>(
        `SELECT id, idempotency_key, write_enabled, attachments_json, finished_at
         FROM jobs AS j
         WHERE status IN ('completed', 'failed') AND finished_at IS NOT NULL AND finished_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM terminal_notifications AS n
             WHERE n.job_id = j.id AND n.delivered_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM artifact_deliveries AS a
             WHERE a.job_id = j.id AND a.delivered_at IS NULL
           )`,
      ).all(cutoff)
      for (const row of candidates) {
        this.db.run(
          `INSERT INTO delivery_tombstones (idempotency_key, write_enabled, completed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(idempotency_key) DO UPDATE SET
             write_enabled = MAX(write_enabled, excluded.write_enabled),
             completed_at = MAX(completed_at, excluded.completed_at)`,
          [row.idempotency_key, row.write_enabled, row.finished_at],
        )
        this.db.run('DELETE FROM artifact_deliveries WHERE job_id = ?', [row.id])
        this.db.run('DELETE FROM terminal_notifications WHERE job_id = ?', [row.id])
        this.db.run('DELETE FROM jobs WHERE id = ?', [row.id])
      }
      // Thread ownership is a security boundary: changing routes.json later
      // must never retarget an already-adopted Slack thread. Keep these compact
      // rows even after job/result GC instead of silently re-resolving a route.
      const threads = 0
      const tombstones = this.db.run(
        'DELETE FROM delivery_tombstones WHERE completed_at < ?',
        [tombstoneCutoff],
      ).changes + this.db.run(
        'DELETE FROM update_request_ledger WHERE created_at < ?',
        [tombstoneCutoff],
      ).changes
      const liveJobs = this.db.query<{ id: string; attachments_json: string }, []>(
        'SELECT id, attachments_json FROM jobs',
      ).all()
      return {
        candidates,
        threads,
        tombstones,
        liveJobIds: new Set(liveJobs.map(row => row.id)),
        liveAttachments: new Set(
          liveJobs.flatMap(row => parseAttachments(row.attachments_json)).map(path => resolve(path)),
        ),
      }
    })
    const result = retrySqlite(() => prune.immediate())
    const attachmentPaths = result.candidates.flatMap(row => parseAttachments(row.attachments_json))
    let files = removeSettledJobState({
      stateDir: options.stateDir,
      jobIds: result.candidates.map(row => row.id),
      attachmentPaths,
      stillReferencedAttachments: result.liveAttachments,
    })
    files += removeOrphanedJobState({
      stateDir: options.stateDir,
      liveJobIds: result.liveJobIds,
      liveAttachmentPaths: result.liveAttachments,
      olderThan: cutoff,
    })
    retrySqlite(() => {
      this.db.exec('PRAGMA optimize')
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
      this.db.exec('PRAGMA incremental_vacuum(2000)')
    })
    return {
      jobs: result.candidates.length,
      threads: result.threads,
      tombstones: result.tombstones,
      files,
    }
  }

  markArtifactDelivered(jobId: string, artifactPath: string): void {
    const updated = this.db.run(
      `UPDATE artifact_deliveries SET delivered_at = ?
       WHERE job_id = ? AND artifact_path = ? AND delivered_at IS NULL`,
      [Date.now(), jobId, artifactPath],
    )
    if (updated.changes !== 1 && !this.artifactDelivered(jobId, artifactPath)) {
      throw new Error(`artifact delivery row is missing: ${artifactPath}`)
    }
  }

  runningJobs(): JobRecord[] {
    return this.db.query<JobRow, []>(
      `SELECT * FROM jobs
       WHERE runtime = 'codex' AND status = 'running'
       ORDER BY seq ASC`,
    ).all().map(mapRow)
  }

  requeue(id: string, reason: string): void {
    this.db.run(
      `UPDATE jobs
       SET status = 'queued', worker_id = NULL, started_at = NULL,
           executor_pid = NULL, not_before = NULL, finished_at = NULL, last_error = ?
       WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
      [reason, id],
    )
  }

  releaseUnstartedClaim(id: string, workerId: string, reason: string): boolean {
    return this.db.run(
      `UPDATE jobs
       SET status = 'queued',
           worker_id = NULL,
           started_at = NULL,
           executor_pid = NULL,
           not_before = NULL,
           finished_at = NULL,
           last_error = ?,
           attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
           session_id = CASE WHEN attempts = 1 THEN NULL ELSE session_id END,
           resumed = CASE WHEN attempts = 1 THEN 0 ELSE resumed END
       WHERE id = ? AND runtime = 'codex' AND status = 'running'
         AND worker_id = ? AND executor_pid IS NULL`,
      [reason, id, workerId],
    ).changes === 1
  }

  requeueAt(id: string, notBefore: number, reason: string, sessionId?: string): void {
    this.db.run(
      `UPDATE jobs
       SET status = 'queued', worker_id = NULL, started_at = NULL,
           executor_pid = NULL, session_id = COALESCE(?, session_id), not_before = ?,
           finished_at = NULL, last_error = ?
       WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
      [sessionId ?? null, notBefore, reason, id],
    )
  }

  recoverInterrupted(): { requeued: number; failedWrites: number } {
    let requeued = 0
    let failedWrites = 0
    for (const job of this.runningJobs()) {
      if (job.writeEnabled) {
        this.fail(
          job.id,
          'write-enabled job was interrupted after execution began; its external effects are uncertain. Review the repository and external services, then resend only if needed.',
        )
        failedWrites += 1
      } else {
        this.requeue(job.id, 'daemon restarted while read-only job was running')
        requeued += 1
      }
    }
    return { requeued, failedWrites }
  }
}

export interface JobExecutionResult {
  sessionId: string
  result: string
}

export interface TerminalNotification {
  id: string
  jobId: string
  kind: 'completed' | 'failed'
  payload: string
  attempts: number
  job: JobRecord
}

export type JobExecutor = (
  job: JobRecord,
  signal?: AbortSignal,
) => Promise<JobExecutionResult>

export interface JobNotifier {
  started?(job: JobRecord, signal?: AbortSignal): Promise<void>
  completed?(job: JobRecord, result: string, notificationId?: string, signal?: AbortSignal): Promise<void>
  failed?(job: JobRecord, error: string, notificationId?: string, signal?: AbortSignal): Promise<void>
  rateLimited?(job: JobRecord, resumeAt: number, reason: string, signal?: AbortSignal): Promise<void>
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
  notificationRetryMs?: number
  stopWhenIdle?: boolean
  shouldPause?: () => boolean
  signal?: AbortSignal
  onLog?: (message: string) => void
}

export const MAX_RATE_LIMIT_ATTEMPTS = 5

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

export async function flushTerminalNotifications(
  store: JobStore,
  notifier: JobNotifier | undefined,
  log: (message: string) => void,
  retryMs = 30_000,
  signal?: AbortSignal,
): Promise<void> {
  if (!notifier) return
  for (const notification of store.pendingTerminalNotifications()) {
    if (signal?.aborted) return
    try {
      if (notification.kind === 'completed') {
        if (!notifier.completed) continue
        await notifier.completed(notification.job, notification.payload, notification.id, signal)
      } else {
        if (!notifier.failed) continue
        await notifier.failed(notification.job, notification.payload, notification.id, signal)
      }
      if (signal?.aborted) return
      store.markTerminalNotificationDelivered(notification.id)
    } catch (error) {
      if (signal?.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      store.deferTerminalNotification(notification.id, message, Date.now(), retryMs)
      log(`terminal notification ${notification.id} deferred: ${message}`)
      // A permanently broken artifact or Slack policy must not suppress every
      // later terminal result. This notification retains its own retry state.
      continue
    }
  }
}

export async function runQueuedJobs(options: RunQueuedJobsOptions): Promise<RunStats> {
  const pollMs = positiveInteger(options.pollMs, 1000)
  const maxJobsPerSession = positiveInteger(options.maxJobsPerSession, 5)
  const notificationRetryMs = positiveInteger(options.notificationRetryMs, 30_000)
  const stopWhenIdle = options.stopWhenIdle ?? false
  const log = options.onLog ?? (() => {})
  const stats: RunStats = { completed: 0, failed: 0, workersStarted: SERIAL_WORKER_COUNT }
  const workerId = 'serial-worker'
  const notificationController = new AbortController()
  const stopNotifications = () => notificationController.abort()
  options.signal?.addEventListener('abort', stopNotifications, { once: true })
  let terminalFlush: Promise<void> | null = null
  const scheduleTerminalFlush = () => {
    if (terminalFlush) return
    terminalFlush = flushTerminalNotifications(
      options.store,
      options.notifier,
      log,
      notificationRetryMs,
      notificationController.signal,
    ).finally(() => { terminalFlush = null })
  }

  log(`${workerId} started`)
  try {
    while (!options.signal?.aborted) {
      if (options.shouldPause?.()) {
        await Bun.sleep(pollMs)
        continue
      }
      scheduleTerminalFlush()

    const job = options.store.claimNext(workerId, maxJobsPerSession)
    if (!job) {
      if (stopWhenIdle && options.store.countClaimable() === 0) return stats
      await Bun.sleep(pollMs)
      continue
    }

    // Close the file-barrier/SQLite-claim race. If an updater acquired its
    // lock after the pre-claim check, put the untouched job back before any
    // notification, Codex process, or external side effect starts.
    if (options.shouldPause?.()) {
      if (!options.store.releaseUnstartedClaim(
        job.id, workerId, 'update barrier appeared while claiming job',
      )) {
        throw new Error(`could not release unstarted job ${job.id} at update barrier`)
      }
      await Bun.sleep(pollMs)
      continue
    }

    log(`${workerId} claimed ${job.id}`)
    await notifySafely(
      options.notifier?.started ? () => options.notifier!.started!(job, options.signal) : undefined,
      log,
    )

    try {
      const execution = await options.executor(job, options.signal)
      options.store.complete(job.id, execution.sessionId, execution.result)
      stats.completed += 1
      scheduleTerminalFlush()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof CodexInterruptedError || options.signal?.aborted) {
        if (job.writeEnabled) {
          const uncertain = 'write-enabled job was interrupted after execution began; '
            + 'its external effects are uncertain. Review the repository and external services, '
            + 'then resend only if needed.'
          options.store.fail(job.id, uncertain)
          stats.failed += 1
          log(`${workerId} failed interrupted write job ${job.id}: ${message}`)
          scheduleTerminalFlush()
        } else {
          options.store.requeue(job.id, message || 'worker interrupted')
          log(`${workerId} requeued ${job.id}: ${message}`)
        }
        return stats
      }
      if (error instanceof CodexRateLimitError && job.writeEnabled) {
        const uncertain = 'write-enabled job hit a rate limit after execution began; '
          + 'its external effects are uncertain. Review the repository and external services, '
          + 'then resend only if needed.'
        options.store.fail(job.id, uncertain)
        stats.failed += 1
        log(`${workerId} failed rate-limited write job ${job.id}: ${message}`)
        scheduleTerminalFlush()
        continue
      }
      if (error instanceof CodexRateLimitError && job.attempts < MAX_RATE_LIMIT_ATTEMPTS) {
        const resumeAt = error.resetsAtMs + 60_000
        options.store.requeueAt(job.id, resumeAt, message, error.sessionId)
        log(`${workerId} deferred ${job.id} until ${new Date(resumeAt).toISOString()}: ${message}`)
        await notifySafely(
          options.notifier?.rateLimited
            ? () => options.notifier!.rateLimited!(job, resumeAt, message, options.signal)
            : undefined,
          log,
        )
        continue
      }
      options.store.fail(job.id, message)
      stats.failed += 1
      scheduleTerminalFlush()
    }
    }
    return stats
  } finally {
    notificationController.abort()
    options.signal?.removeEventListener('abort', stopNotifications)
    if (terminalFlush) {
      await Promise.race([terminalFlush, Bun.sleep(1_000)])
    }
  }
}

function stateDir(): string {
  return resolveZeroStateDir()
}

const DAY_MS = 24 * 60 * 60 * 1000

export function maintainState(
  store: JobStore,
  dir = stateDir(),
  now = Date.now(),
): { jobs: number; threads: number; tombstones: number; files: number; logs: number } {
  const retentionMs = positiveInteger(process.env.ZEROKUN_RETENTION_DAYS, 30) * DAY_MS
  const tombstoneRetentionMs = positiveInteger(
    process.env.ZEROKUN_IDEMPOTENCY_RETENTION_DAYS,
    3650,
  ) * DAY_MS
  const logs = capRuntimeLogs(
    dir,
    positiveInteger(process.env.ZEROKUN_RUNTIME_LOG_MAX_BYTES, 20 * 1024 * 1024),
  )
  const pruned = store.pruneSettled({
    stateDir: dir,
    now,
    retentionMs,
    tombstoneRetentionMs,
  })
  return {
    ...pruned,
    logs,
  }
}

function defaultDbPath(): string {
  return process.env.ZEROKUN_JOB_DB ?? join(stateDir(), 'jobs.sqlite3')
}

function loadStateEnv(dir: string): void {
  const envFile = join(dir, '.env')
  for (const line of (readOptionalPrivateFile(envFile) ?? '').split('\n')) {
    const match = line.match(/^(\w+)=(.*)$/)
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2]
    }
  }
}

const SLACK_CHUNK_CHARS = 3_500
/** 1 通知が占有してよい Slack メッセージ数の上限。 */
const MAX_SLACK_MESSAGES = 5
const SLACK_TRUNCATION_NOTICE = '\n\n…(長すぎるため以降を省略しました。全文は job-logs を参照)'

/**
 * 通知本文を Slack の投稿単位へ分割する。何があっても MAX_SLACK_MESSAGES 通を超えない。
 * executor 側でも長さを抑えているが、想定外の入力が来ても
 * スレッドを埋め尽くさないための最後の防波堤としてここでも切る。
 */
export function splitSlackChunks(text: string): string[] {
  const limit = SLACK_CHUNK_CHARS * MAX_SLACK_MESSAGES
  const body = text.length <= limit
    ? text
    : text.slice(0, limit - SLACK_TRUNCATION_NOTICE.length) + SLACK_TRUNCATION_NOTICE
  return body.match(new RegExp(`[\\s\\S]{1,${SLACK_CHUNK_CHARS}}`, 'g')) ?? ['']
}

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
const ARTIFACT_READ_CHUNK_BYTES = 64 * 1024

function safeJobId(jobId: string): string {
  return jobId.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function sealedArtifactDirForJob(dir: string, jobId: string): string {
  return join(dir, 'sealed-artifacts', safeJobId(jobId))
}

export function extractArtifactPaths(result: string): { text: string; files: string[] } {
  const match = /\s*<zerokun_files>([\s\S]*?)<\/zerokun_files>\s*$/i.exec(result)
  if (!match) return { text: result, files: [] }
  try {
    const parsed = JSON.parse(match[1]!.trim())
    const files = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string').slice(0, 10)
      : []
    return { text: result.slice(0, match.index).trimEnd(), files }
  } catch {
    return { text: result, files: [] }
  }
}

/**
 * Codex が書ける outbox から、runner だけが読める state 内へ内容をcopyする。
 * sourceはjob outboxの直下だけに限定し、O_NOFOLLOWで開いたfdから読むため、
 * 攻撃者が差し替えられるsymlinkをtraversalしない。destinationはjob/sourceごとに
 * 決定的なので、seal後・DB complete前にrunnerが落ちても同じ結果へ収束する。
 */
export function sealArtifactResult(job: JobRecord, result: string, dir = stateDir()): string {
  const output = extractArtifactPaths(result)
  if (output.files.length === 0) return result

  const outbox = resolve(artifactDirForJob(dir, job.id))
  requireManagedDirectory(dir, outbox)
  const outboxMetadata = lstatSync(outbox)
  if (!outboxMetadata.isDirectory()) {
    throw new Error(`job artifact outbox is not a directory: ${outbox}`)
  }
  const sealedRoot = resolve(sealedArtifactDirForJob(dir, job.id))
  ensureManagedDirectory(dir, sealedRoot)
  const sealedMetadata = lstatSync(sealedRoot)
  if (!sealedMetadata.isDirectory()) {
    throw new Error(`sealed artifact root is not a directory: ${sealedRoot}`)
  }

  const sealed: string[] = []
  for (const requested of [...new Set(output.files)]) {
    if (!isAbsolute(requested)) throw new Error(`artifact path is not absolute: ${requested}`)
    const source = resolve(requested)
    if (dirname(source) !== outbox) {
      throw new Error(`artifact must be directly inside this job's outbox: ${requested}`)
    }
    const sourceKey = createHash('sha256').update(source).digest('hex').slice(0, 32)
    let descriptor: number
    try {
      descriptor = openSync(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new Error(`artifact is not a regular file: ${requested}`)
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const prefix = `${sourceKey}--`
        const suffix = `--${basename(source)}`
        const candidates = readdirSync(sealedRoot)
          .filter(name => name.startsWith(prefix) && name.endsWith(suffix))
          .map(name => join(sealedRoot, name))
          .filter(path => {
            const metadata = lstatSync(path)
            return metadata.isFile() && metadata.size <= MAX_ARTIFACT_BYTES
          })
        if (candidates.length === 1) {
          sealed.push(candidates[0]!)
          continue
        }
        if (candidates.length > 1) {
          throw new Error(`artifact recovery is ambiguous: ${requested}`)
        }
      }
      throw error
    }
    let data: Buffer
    try {
      const metadata = fstatSync(descriptor)
      if (!metadata.isFile()) throw new Error(`artifact is not a regular file: ${requested}`)
      if (metadata.nlink !== 1) {
        throw new Error(`artifact must not have multiple hard links: ${requested}`)
      }
      if (metadata.size > MAX_ARTIFACT_BYTES) {
        throw new Error(`artifact is larger than 50MB: ${requested}`)
      }
      data = readBoundedArtifact(descriptor, requested)
    } finally {
      closeSync(descriptor)
    }

    const contentKey = createHash('sha256').update(data).digest('hex').slice(0, 32)
    const destination = join(sealedRoot, `${sourceKey}--${contentKey}--${basename(source)}`)
    try {
      const existing = lstatSync(destination)
      if (!existing.isFile()) throw new Error(`sealed artifact is not a regular file: ${requested}`)
      if (existing.size > MAX_ARTIFACT_BYTES) {
        throw new Error(`artifact is larger than 50MB: ${requested}`)
      }
      sealed.push(destination)
      continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const temporary = join(sealedRoot, `.${sourceKey}.${contentKey}.${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, destination)
    } finally {
      rmSync(temporary, { force: true })
    }
    const after = lstatSync(destination)
    if (!after.isFile()) throw new Error(`sealed artifact is not a regular file: ${requested}`)
    sealed.push(destination)
  }

  const marker = `<zerokun_files>${JSON.stringify(sealed)}</zerokun_files>`
  return output.text ? `${output.text}\n${marker}` : marker
}

export function finalizeSuccessfulExecution(
  job: JobRecord,
  execution: JobExecutionResult,
  dir: string,
  log: (message: string) => void = () => {},
): JobExecutionResult {
  try {
    return { ...execution, result: sealArtifactResult(job, execution.result, dir) }
  } catch (error) {
    // Codex already exited successfully. A malformed/unsealable artifact
    // declaration is a delivery failure, not evidence that a write job itself
    // failed; marking it failed would invite duplicate external side effects.
    const text = extractArtifactPaths(execution.result).text
    const message = error instanceof Error ? error.message : String(error)
    log(`artifact sealing failed for completed job ${job.id}: ${message}`)
    return {
      ...execution,
      result: `${text}\n\n⚠️ 成果物ファイルを安全に封印できなかったため、ファイル添付だけを省略しました: ${message}`,
    }
  }
}

function readBoundedArtifact(descriptor: number, file: string): Buffer {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= MAX_ARTIFACT_BYTES) {
    const remaining = MAX_ARTIFACT_BYTES + 1 - total
    const chunk = Buffer.allocUnsafe(Math.min(ARTIFACT_READ_CHUNK_BYTES, remaining))
    const count = readSync(descriptor, chunk, 0, chunk.length, null)
    if (count === 0) break
    chunks.push(chunk.subarray(0, count))
    total += count
  }
  if (total > MAX_ARTIFACT_BYTES) throw new Error(`artifact is larger than 50MB: ${file}`)
  return Buffer.concat(chunks, total)
}

export function readUploadableArtifact(
  job: JobRecord,
  file: string,
  dir = stateDir(),
): { path: string; filename: string; data: Buffer } {
  if (!isAbsolute(file)) throw new Error(`artifact path is not absolute: ${file}`)
  const candidate = resolve(file)
  const allowedRoot = resolve(sealedArtifactDirForJob(dir, job.id))
  requireManagedDirectory(dir, allowedRoot)
  if (dirname(candidate) !== allowedRoot) {
    throw new Error(`artifact is outside this job's sealed directory: ${file}`)
  }
  const descriptor = openSync(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile()) throw new Error(`artifact is not a regular file: ${file}`)
    if (metadata.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`artifact is larger than 50MB: ${file}`)
    }
    const encodedName = basename(candidate)
    const separator = encodedName.lastIndexOf('--')
    return {
      path: candidate,
      filename: separator >= 0 ? encodedName.slice(separator + 2) : encodedName,
      data: readBoundedArtifact(descriptor, file),
    }
  } finally {
    closeSync(descriptor)
  }
}

function slackClientMessageId(notificationId: string, chunk: number): string {
  const hex = createHash('sha256').update(`${notificationId}:${chunk}`).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}

class SlackNotifier implements JobNotifier {
  private readonly client: WebClient

  constructor(
    private readonly token: string,
    private readonly log: (message: string) => void,
    private readonly store: JobStore,
  ) {
    this.client = new WebClient(token, slackWebClientOptions())
  }

  private async post(
    job: JobRecord,
    text: string,
    notificationId?: string,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    const chunks = splitSlackChunks(text)
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!
      const response = await withSlackDeadline(signal => fetch(
        'https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            channel: job.chatId,
            thread_ts: job.threadTs,
            text: chunk,
            ...(notificationId
              ? { client_msg_id: slackClientMessageId(notificationId, index) }
              : {}),
          }),
          signal,
        },
      ), undefined, 'Slack chat.postMessage', parentSignal)
      const result = await response.json() as { ok?: boolean; error?: string }
      if (!result.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
    }
  }

  async started(job: JobRecord, signal?: AbortSignal): Promise<void> {
    await this.post(
      job,
      `ゼロくん job ${job.id.slice(0, 8)} を開始しました。`
      + ` worker=${job.workerId} / project=${basename(job.repoPath)}`,
      undefined,
      signal,
    )
  }

  async completed(
    job: JobRecord,
    result: string,
    notificationId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const output = extractArtifactPaths(result)
    await this.post(job, output.text || 'Codexの処理が完了しました。', notificationId, signal)
    for (const requested of output.files) {
      if (this.store.artifactDelivered(job.id, requested)) continue
      const file = readUploadableArtifact(job, requested)
      await withSlackDeadline(async () => this.client.files.uploadV2({
          channel_id: job.chatId,
          thread_ts: job.threadTs,
          filename: file.filename,
          file: file.data,
        }), undefined, 'Slack files.uploadV2', signal)
      if (signal?.aborted) return
      this.store.markArtifactDelivered(job.id, requested)
    }
  }

  async failed(job: JobRecord, error: string, notificationId?: string, signal?: AbortSignal): Promise<void> {
    this.log(`job ${job.id} failed: ${error}`)
    await this.post(
      job,
      `ゼロくん job ${job.id.slice(0, 8)} は失敗しました。\n${error.slice(0, 1500)}`,
      notificationId,
      signal,
    )
  }

  async rateLimited(job: JobRecord, resumeAt: number, _reason: string, signal?: AbortSignal): Promise<void> {
    const time = new Intl.DateTimeFormat('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(resumeAt))
    await this.post(
      job,
      `⏸ ゼロくん job ${job.id.slice(0, 8)} は使用量上限のため一時停止しました。`
      + `${time} に自動再開します。`,
      undefined,
      signal,
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
    attachments: Array.isArray(value.attachments)
      ? value.attachments.filter((item): item is string => typeof item === 'string')
      : [],
    writeEnabled: value.writeEnabled === true,
  }
}

function acquireDaemonLock(lockDir: string, stateRoot: string): boolean {
  const pidFile = join(lockDir, 'pid')
  const versionFile = join(lockDir, 'runtime')
  ensureManagedDirectory(stateRoot, lockDir)
  const attempt = tryAcquireProcessLock(pidFile)
  if (!attempt.acquired) return false
  atomicWritePrivateFile(versionFile, `${JOB_RUNNER_HANDSHAKE}\n`)
  return true
}

function releaseDaemonLock(lockDir: string): void {
  releaseProcessLock(join(lockDir, 'pid'))
}

export function updateIsRunning(lockDir: string): boolean {
  try {
    const lockFile = join(lockDir, 'pid')
    const updaterPid = Number(readFileSync(lockFile, 'utf8').trim())
    if (updaterPid <= 0) return false
    process.kill(updaterPid, 0)
    if (processLockOwnerMatches(
      lockFile,
      updaterPid,
      /(?:update\.ts|zerokun-update|setup\.sh)(?:\s|$)/,
    )) {
      return true
    }
    // Backward compatibility for a live setup created before identity files.
    const command = trackedExecutorCommand(updaterPid)
    return /setup\.sh(?:\s|$)/.test(command)
  } catch {
    return false
  }
}

/**
 * A transaction journal is the authoritative write barrier. The updater PID
 * may disappear after a crash while candidate services are still alive;
 * treating any existing (including unsafe) entry as pending prevents a write
 * job from running before rollback restores the pre-update database snapshot.
 */
export function updateTransactionPending(journalFile: string): boolean {
  try {
    lstatSync(journalFile)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

function processStateIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const state = Bun.spawnSync(
    ['ps', '-o', 'state=', '-p', String(pid)],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  const value = new TextDecoder().decode(state.stdout).trim().toUpperCase()
  return state.exitCode === 0 && value.length > 0 && !value.startsWith('Z')
}

function trackedExecutorCommand(pid: number): string {
  const result = Bun.spawnSync(
    ['ps', '-ww', '-o', 'command=', '-p', String(pid)],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout) : ''
}

function signalTrackedExecutor(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch {}
  }
  try { process.kill(pid, signal) } catch {}
}

export async function terminateTrackedExecutors(
  store: JobStore,
  log: (message: string) => void,
  timeoutMs = 5_000,
  stateDirectory = stateDir(),
): Promise<void> {
  const registrations = new Map<number, { jobId: string; path?: string }>()
  for (const job of store.runningJobs()) {
    if (job.executorPid !== null) registrations.set(job.executorPid, { jobId: job.id })
  }
  const registrationDir = join(stateDirectory, 'executors')
  try {
    const root = lstatSync(registrationDir)
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error(`unsafe executor registration directory: ${registrationDir}`)
    }
    for (const name of readdirSync(registrationDir)) {
      if (!name.endsWith('.json')) continue
      const path = join(registrationDir, name)
      const metadata = lstatSync(path)
      const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || metadata.size > 4096 || !ownerMatches) {
        throw new Error(`unsafe executor registration: ${path}`)
      }
      const value = JSON.parse(readFileSync(path, 'utf8')) as { jobId?: string; pid?: number }
      if (typeof value.jobId !== 'string' || !Number.isInteger(value.pid) || Number(value.pid) <= 0) {
        throw new Error(`invalid executor registration: ${path}`)
      }
      registrations.set(Number(value.pid), { jobId: value.jobId, path })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  for (const [pid, registration] of registrations) {
    if (!processStateIsAlive(pid)) {
      if (registration.path) rmSync(registration.path, { force: true })
      continue
    }
    const command = trackedExecutorCommand(pid)
    const supervised = command.includes('codex-supervisor') && command.includes(registration.jobId)
    const legacyDirect = command.includes(registration.jobId)
      && /(?:^|[\/\s])codex(?:[\/\s]|$)|codex-cli/i.test(command)
    if (!supervised && !legacyDirect) {
      // PID reuse must never make the FIFO permanently unstartable. Fail
      // closed by leaving the unrelated process alone, discard only our stale
      // registration, and let recoverInterrupted classify the job.
      log(`discarding stale executor PID ${pid} for job ${registration.jobId}: identity mismatch`)
      store.clearExecutorPid(registration.jobId, pid)
      if (registration.path) rmSync(registration.path, { force: true })
      continue
    }
    log(`stopping orphaned Codex executor PID ${pid} for job ${registration.jobId}`)
    signalTrackedExecutor(pid, 'SIGTERM')
    const startedAt = Date.now()
    while (processStateIsAlive(pid) && Date.now() - startedAt < timeoutMs) {
      await Bun.sleep(50)
    }
    if (processStateIsAlive(pid)) {
      signalTrackedExecutor(pid, 'SIGKILL')
      await Bun.sleep(100)
    }
    if (processStateIsAlive(pid)) {
      throw new Error(`orphaned Codex executor PID ${pid} did not stop`)
    }
    if (registration.path) rmSync(registration.path, { force: true })
  }
}

async function readJsonStdin(): Promise<unknown> {
  return new Response(Bun.stdin.stream()).json()
}

async function runCli(): Promise<void> {
  const command = process.argv[2] ?? 'status'
  const dir = stateDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  requireManagedStateRoot(dir)
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

  if (command === 'runtime-info') {
    try {
      process.stdout.write(`${JSON.stringify({
        runtime: 'codex',
        handshake: JOB_RUNNER_HANDSHAKE,
        active: store.countActive(),
        pendingNotifications: store.terminalNotificationCount(),
      })}\n`)
    } finally {
      store.close()
    }
    return
  }

  if (command === 'gc') {
    try {
      process.stdout.write(`${JSON.stringify(maintainState(store, dir))}\n`)
    } finally {
      store.close()
    }
    return
  }

  if (command === 'migrate-legacy') {
    const lockDir = join(dir, 'job-runner.lock')
    if (!acquireDaemonLock(lockDir, dir)) {
      store.close()
      throw new Error('job runner is still running; refuse legacy migration')
    }
    try {
      const migrated = store.migrateLegacyActive()
      process.stdout.write(`${JSON.stringify({ migrated })}\n`)
    } finally {
      store.close()
      releaseDaemonLock(lockDir)
    }
    return
  }
  if (command === 'prepare-storage') {
    try {
      store.enableIncrementalVacuum()
      process.stdout.write(`${JSON.stringify({ autoVacuum: 'incremental' })}\n`)
    } finally { store.close() }
    return
  }

  if (command === 'recover-interrupted') {
    const lockDir = join(dir, 'job-runner.lock')
    if (!acquireDaemonLock(lockDir, dir)) {
      store.close()
      throw new Error('job runner is still running; refuse interrupted-job recovery')
    }
    const log = (message: string) => process.stderr.write(`${message}\n`)
    try {
      await terminateTrackedExecutors(store, log, 5_000, dir)
      const recovered = store.recoverInterrupted()
      process.stdout.write(`${JSON.stringify(recovered)}\n`)
    } finally {
      store.close()
      releaseDaemonLock(lockDir)
    }
    return
  }

  if (command !== 'daemon' && command !== 'run-until-idle') {
    store.close()
    throw new Error(`unknown command: ${command}`)
  }

  const legacyActive = store.countLegacyActive()
  if (legacyActive > 0) {
    store.close()
    throw new Error(
      `${legacyActive} active Claude job(s) remain; run bash zerokun/setup.sh for safe cutover`,
    )
  }

  const lockDir = join(dir, 'job-runner.lock')
  if (!acquireDaemonLock(lockDir, dir)) {
    process.stderr.write(`zerokun job runner already running (${lockDir})\n`)
    store.close()
    return
  }

  const log = (message: string) => process.stderr.write(`${new Date().toISOString()} ${message}\n`)
  const updateJournal = join(dir, 'update-transaction.json')
  if (!updateTransactionPending(updateJournal)) {
    await terminateTrackedExecutors(store, log, 5_000, dir)
    const recovered = store.recoverInterrupted()
    if (recovered.requeued > 0) {
      log(`requeued ${recovered.requeued} interrupted read-only job(s)`)
    }
    if (recovered.failedWrites > 0) {
      log(`failed ${recovered.failedWrites} interrupted write job(s) with uncertain effects`)
    }
  } else {
    log('update transaction pending; startup recovery and job execution are paused')
  }
  loadStateEnv(dir)
  if (!updateTransactionPending(updateJournal)) {
    const initialMaintenance = maintainState(store, dir)
    log(`state maintenance: ${JSON.stringify(initialMaintenance)}`)
  }
  const token = process.env.SLACK_BOT_TOKEN
  const notifier = token ? new SlackNotifier(token, log, store) : undefined
  if (!notifier) log('SLACK_BOT_TOKEN not found; Slack progress notifications are disabled')

  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const maintenanceTimer = setInterval(() => {
    if (updateTransactionPending(updateJournal)) return
    try {
      log(`state maintenance: ${JSON.stringify(maintainState(store, dir))}`)
    } catch (error) {
      log(`state maintenance failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, positiveInteger(process.env.ZEROKUN_GC_INTERVAL_MS, 6 * 60 * 60 * 1000))
  maintenanceTimer.unref()

  try {
    await runQueuedJobs({
      store,
      maxJobsPerSession: positiveInteger(process.env.ZEROKUN_MAX_JOBS_PER_SESSION, 5),
      pollMs: positiveInteger(process.env.ZEROKUN_JOB_POLL_MS, 1000),
      stopWhenIdle: command === 'run-until-idle',
      shouldPause: () => updateTransactionPending(updateJournal)
        || updateIsRunning(join(dir, 'update.lock')),
      signal: controller.signal,
      notifier,
      executor: async (job, signal) => {
        const execution = await executeCodexJob(job, {
          signal,
          stateDir: dir,
          logDir: join(dir, 'job-logs'),
          onProcessId: processId => store.saveExecutorPid(job.id, processId),
          onSessionId: sessionId => store.saveSession(job.id, sessionId),
          onSessionReset: () => store.clearSession(job.id),
        })
        return finalizeSuccessfulExecution(job, execution, dir, log)
      },
      onLog: log,
    })
  } finally {
    const interrupted = controller.signal.aborted
    clearInterval(maintenanceTimer)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    store.close()
    releaseDaemonLock(lockDir)
    // Slack SDK uploads do not expose AbortSignal. After DB/lock cleanup, force the
    // daemon to drop any orphaned HTTP socket so updater shutdown cannot exceed 30s.
    if (interrupted) process.exit(0)
  }
}

if (import.meta.main) {
  runCli().catch(error => {
    process.stderr.write(`zerokun job runner: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
