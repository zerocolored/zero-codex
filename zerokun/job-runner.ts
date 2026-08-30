#!/usr/bin/env -S bun --config=/dev/null --no-env-file

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
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path'
import { WebClient } from '@slack/web-api'
import {
  artifactDirForJob,
  CodexCleanupPendingError,
  CodexInterruptedError,
  CodexRateLimitError,
  CodexRepositoryChangedBeforeImplementationError,
  CodexUserCancelledError,
  codexRateLimitResumeAt,
  executeCodexJob,
  assertCodexChatGptSubscriptionLogin,
} from './codex-executor.ts'
import {
  resolveOfficialStandaloneCodex,
  verifyOfficialCodexSnapshot,
} from './standalone-codex.ts'
import {
  inspectProcessLock,
  releaseProcessLock,
  tryAcquireProcessLock,
  type ProcessLockLease,
} from './process-lock.ts'
import { resolveZeroJobDatabasePath, resolveZeroStateDir } from './state-dir.ts'
import { createAdvisorInputSnapshot, readAdvisorInputSnapshot } from './advisor-input.ts'
import {
  containsCredentialMaterial,
  normalizeImplementationGuardText,
  normalizePublicGuardText,
  redactCredentialMaterial,
} from './public-output-guard.ts'
import {
  applyStateEnvironment,
  parseStateSlackTokens,
  takeSlackTokensFromEnvironment,
} from './child-environment.ts'
import {
  assertDescriptorStillNamesPath,
  atomicWritePrivateFile,
  readOptionalPrivateFile,
} from './safe-file.ts'
import {
  completeSlackSideEffect,
  postDirectSlackApi,
  postDirectSlackUpload,
  requireSlackUploadUrl,
  slackWebClientOptions,
  withSlackDeadline,
} from './slack-http.ts'
import {
  appIdFromAppToken,
  slackTokenPairRuntimeIdentity,
  verifySlackAppTokenPair,
} from './slack-app-identity.ts'
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
import {
  captureTrackedProcesses,
  MAX_EXECUTOR_REGISTRATION_BYTES,
  MAX_TRACKED_PROCESSES,
  processIdentityIsLive,
  readProcessIdentity,
  type ProcessIdentity,
} from './process-tree.ts'
import {
  observeProcessGeneration,
  parseProcessStartKey,
  processIdentityIsStopped,
  readBootSession,
  signalProcessGroupIfLeaderLive,
  signalProcessIfLive,
} from './process-generation.ts'
import {
  decodeHerdrRuntimeIdentity,
  herdrRuntimeFingerprint,
  readPinnedHerdrRuntime,
  verifyHerdrRuntimeIdentityAsync,
  writePinnedHerdrRuntime,
} from './herdr-runtime.ts'
import { isSlackInterruptCommand } from './live-control.ts'
import {
  CodexUiApprovalRequiredError,
  isExplicitUiApprovalResponse,
  reencodeUiApprovalImages,
  type UiApprovalResumeContext,
} from './ui-approval.ts'
import { resolveAdvisorProjectLayout } from './advisor-snapshot.ts'
import { acknowledgeServiceControlPauseIfRequested } from './service-control-state.ts'

export class SlackChannelRouteRequiredError extends Error {
  constructor(readonly channelId: string) {
    super(`Slack channel is not connected to a Zeroちゃん project: ${channelId}`)
    this.name = 'SlackChannelRouteRequiredError'
  }
}

export class SlackChannelRouteChangedError extends Error {
  constructor(readonly channelId: string) {
    super(`Slack channel route changed while accepting an event: ${channelId}`)
    this.name = 'SlackChannelRouteChangedError'
  }
}

export class InboundInitialContextConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InboundInitialContextConflictError'
  }
}
import {
  EphemeralClaudeCleanupPendingError,
  reconcileEphemeralClaudeSessions,
} from './ephemeral-claude-session.ts'
import {
  finalizeRetiredAdvisorRounds,
  persistAdvisorClaudeCleanupOutcome,
  recordAdvisorExecutorRetirementForJob,
} from './advisor-round-recovery.ts'
import {
  appendHerdrJobMonitorStatus,
  closeHerdrJobMonitor,
  HerdrJobMonitorPendingError,
  openHerdrJobMonitor,
  reconcileHerdrJobMonitors,
  retainFailedHerdrJobMonitor,
  watchHerdrJobMonitor,
} from './herdr-job-monitor.ts'
import {
  recoverOrphanSeatbeltFingerprints,
  reapSeatbeltFingerprint,
  removeSeatbeltFingerprint,
  verifySeatbeltFingerprint,
  type SeatbeltFingerprint,
} from './seatbelt-fingerprint.ts'

export const SERIAL_WORKER_COUNT = 1 as const
export const JOB_RUNNER_HANDSHAKE = 'zerokun-codex-runner-v1' as const
export const DEFAULT_MAX_JOBS_PER_SESSION = 20 as const
export const CODEX_SESSION_PROTOCOL_VERSION = 2 as const
export const DEFAULT_MAX_REPOSITORY_DRIFT_RETRIES = 3 as const
const CLAIMABLE_CODEX_JOB_PREDICATE = `
  jobs.runtime = 'codex'
  AND jobs.status = 'queued'
  AND jobs.ui_approval_request_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM inbound_deliveries AS inbound
    WHERE inbound.chat_id = jobs.chat_id AND inbound.thread_ts = jobs.thread_ts
  )
  AND NOT EXISTS (
    SELECT 1 FROM jobs AS approval_wait
    WHERE approval_wait.runtime = 'codex'
      AND approval_wait.chat_id = jobs.chat_id
      AND approval_wait.thread_ts = jobs.thread_ts
      AND approval_wait.status = 'queued'
      AND approval_wait.ui_approval_request_id IS NOT NULL
      AND approval_wait.seq < jobs.seq
  )
`
const SLACK_DM_HISTORY_RETRY_BASE_MS = 24 * 60 * 60 * 1_000
const SLACK_DM_HISTORY_RETRY_MAX_MS = 7 * 24 * 60 * 60 * 1_000
const MONITOR_LOSS_RECOVERY_MESSAGE =
  '監視タブが失われたため、安全に処理状態を復旧できませんでした。'
  + '実行プロセスの停止を確認して、この依頼を失敗として終了しました。'
  + '必要なら再送してください。'

export function advisorAttemptMayHaveBeenDelivered(
  stateDirInput: string,
  jobId: string,
): boolean {
  try {
    const stateDir = requireManagedStateRoot(stateDirInput)
    const safeId = jobId.replace(/[^A-Za-z0-9._-]/g, '_')
    const jobRoot = join(stateDir, 'advisor-journal', safeId)
    let nonceNames: string[]
    try {
      requireManagedDirectory(stateDir, jobRoot)
      nonceNames = readdirSync(jobRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      return true
    }
    for (const nonce of nonceNames) {
      if (!/^[0-9a-f]{32}$/.test(nonce)) return true
      const nonceDir = join(jobRoot, nonce)
      try {
        requireManagedDirectory(stateDir, nonceDir)
        for (const name of readdirSync(nonceDir)) {
          if (!/^(?:investigation-1|design-1|review-[123])\.json$/.test(name)) return true
          const metadata = lstatSync(join(nonceDir, name))
          const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
          if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !owned) {
            return true
          }
          return true
        }
      } catch {
        return true
      }
    }
    return false
  } catch {
    return true
  }
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed'
export type JobTerminalOutcome = 'completed' | 'failed' | 'cancelled'
export type JobControlKind = 'steer' | 'interrupt'
export type JobControlStatus =
  | 'ready' | 'dispatching' | 'acknowledged' | 'observed'
  | 'superseded' | 'ambiguous'

export interface LiveControlTarget {
  jobId: string
  epoch: number
  repoPath: string
  writeEnabled: boolean
  awaitingUiApproval?: boolean
}

/** An active Slack thread is the live-control authority, including replies from other senders. */
export function liveControlAcceptsInput(
  _target: LiveControlTarget,
  _input: Pick<InboundDeliveryRecord, 'repoPath' | 'writeEnabled'> & { interrupt: boolean },
): boolean {
  return true
}

export interface JobControlRecord {
  seq: number
  id: string
  idempotencyKey: string
  jobId: string
  epoch: number
  inputRevision: number
  inputDigest: string
  kind: JobControlKind
  chatId: string
  threadTs: string
  messageId: string
  userId: string
  writeEnabled: boolean
  task: string
  attachments: string[]
  status: JobControlStatus
  requestId: number | null
  executorNonce: string | null
  threadId: string | null
  turnId: string | null
  lastError: string | null
  createdAt: number
  dispatchedAt: number | null
  acknowledgedAt: number | null
  observedAt: number | null
}

export type JobInterjectionStatus =
  | 'ready' | 'pausing' | 'paused' | 'answer-prepared' | 'answering'
  | 'answered' | 'delivered' | 'promoted' | 'superseded' | 'ambiguous'

export type JobInterjectionDisposition = 'answer-only' | 'task-update'

/**
 * A same-thread message is first handled as a conversational interjection.
 * It is deliberately kept out of the durable task transcript until Codex,
 * running read-only, classifies it as a task update.
 */
export interface JobInterjectionRecord {
  seq: number
  id: string
  idempotencyKey: string
  jobId: string
  epoch: number
  inputRevision: number
  inputDigest: string
  kind: 'interjection'
  chatId: string
  threadTs: string
  messageId: string
  userId: string
  writeEnabled: boolean
  task: string
  attachments: string[]
  status: JobInterjectionStatus
  pauseRequestId: number | null
  pauseExecutorNonce: string | null
  pauseThreadId: string | null
  pauseTurnId: string | null
  answerRequestId: number | null
  answerLogicalNonce: string | null
  answerThreadId: string | null
  answerTurnId: string | null
  disposition: JobInterjectionDisposition | null
  answer: string | null
  notificationId: string | null
  lastError: string | null
  createdAt: number
  pausedAt: number | null
  answeredAt: number | null
  deliveredAt: number | null
}

export type JobLiveInputRecord = JobControlRecord | JobInterjectionRecord

export interface EnqueueInput {
  chatId: string
  threadTs: string
  messageId: string
  userId: string
  repoPath: string
  task: string
  attachments?: string[]
  writeEnabled?: boolean
  notifyAccepted?: boolean
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
  isInterrupt?: boolean
}

export type InboundInitialContextState = 'none' | 'pending' | 'hydrated'

export interface InboundDownloadedFile {
  fileId: string
  ordinal: number
  path: string
  size: number
  digest: string
}

export interface InboundBootstrapEvent {
  messageId: string
  userId: string
  text: string
  fileIds: string[]
  writeEnabled: boolean
  isInterrupt: boolean
}

export interface LiveControlInput {
  chatId: string
  threadTs: string
  messageId: string
  userId: string
  writeEnabled?: boolean
  task: string
  attachments?: string[]
  kind: JobControlKind
  notifyAccepted?: boolean
}

export interface InboundDeliveryRecord extends InboundDeliveryInput {
  seq: number
  idempotencyKey: string
  fileIds: string[]
  writeEnabled: boolean
  isInterrupt: boolean
  attempts: number
  notBefore: number | null
  expectedControlJobId: string | null
  expectedControlEpoch: number | null
  downloadedFiles: InboundDownloadedFile[]
  initialContextState: InboundInitialContextState
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
  is_interrupt: number
  status: 'pending' | 'processing'
  attempts: number
  not_before: number | null
  created_at: number
  expected_control_job_id: string | null
  expected_control_epoch: number | null
  downloaded_files_json: string
  initial_context_state: InboundInitialContextState
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
  inputRevision: number
  attachments: string[]
  runtime: 'claude' | 'codex'
  writeEnabled: boolean
  status: JobStatus
  sessionId: string | null
  resumed: boolean
  workerId: string | null
  executorPid: number | null
  monitorState: 'none' | 'preparing' | 'required' | 'lost-staged'
  attempts: number
  repositoryDriftRetries: number
  notBefore: number | null
  result: string | null
  lastError: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  controlEpoch: number
  acceptsControl: boolean
  executorNonce: string | null
  activeThreadId: string | null
  activeTurnId: string | null
  cancelRequestedAt: number | null
  terminalOutcome: JobTerminalOutcome | null
  uiApprovalRequestId: string | null
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
  input_revision: number
  attachments_json: string
  runtime: 'claude' | 'codex'
  write_enabled: number
  status: JobStatus
  session_id: string | null
  resumed: number
  worker_id: string | null
  executor_pid: number | null
  monitor_state: number
  attempts: number
  repository_drift_retries: number
  not_before: number | null
  result: string | null
  pending_session_id: string | null
  pending_result: string | null
  last_error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  control_epoch: number
  accepts_control: number
  executor_nonce: string | null
  active_thread_id: string | null
  active_turn_id: string | null
  cancel_requested_at: number | null
  terminal_outcome: JobTerminalOutcome | null
  ui_approval_request_id: string | null
}

type UiApprovalRequestRow = {
  id: string
  job_id: string
  round: number
  input_revision: number
  input_digest: string
  repository_digest: string
  session_id: string
  proposal_text: string
  before_path: string
  after_path: string
  status: UiApprovalRequestRecord['status']
  response_message_id: string | null
  response_user_id: string | null
  response_text: string | null
  response_input_revision: number | null
  response_explicit_approval: number | null
  prompt_client_message_id: string
  prompt_delivery_started_at: number | null
  prompt_message_id: string | null
  prompt_delivered_at: number | null
  attempts: number
  not_before: number | null
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
  input_revision INTEGER NOT NULL DEFAULT 1,
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
  monitor_state INTEGER NOT NULL DEFAULT 0 CHECK (monitor_state IN (0, 1, 2, 3)),
  attempts INTEGER NOT NULL DEFAULT 0,
  repository_drift_retries INTEGER NOT NULL DEFAULT 0
    CHECK (repository_drift_retries >= 0),
  repository_drift_intent_attempt INTEGER,
  repository_drift_intent_reason TEXT,
  not_before INTEGER,
  result TEXT,
  pending_session_id TEXT,
  pending_result TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
  ,control_epoch INTEGER NOT NULL DEFAULT 0
  ,accepts_control INTEGER NOT NULL DEFAULT 0 CHECK (accepts_control IN (0, 1))
  ,executor_nonce TEXT
  ,active_thread_id TEXT
  ,active_turn_id TEXT
  ,cancel_requested_at INTEGER
  ,terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('completed', 'failed', 'cancelled'))
  ,ui_approval_request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_seq ON jobs(status, seq);
CREATE INDEX IF NOT EXISTS idx_jobs_thread_seq ON jobs(chat_id, thread_ts, seq);
CREATE TABLE IF NOT EXISTS codex_session_protocols (
  session_id TEXT PRIMARY KEY,
  protocol_version INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codex_session_job_uses (
  session_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, job_id),
  FOREIGN KEY (session_id) REFERENCES codex_session_protocols(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_codex_session_job_uses_session
  ON codex_session_job_uses(session_id, recorded_at);
CREATE TABLE IF NOT EXISTS codex_session_retirements (
  session_id TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES codex_session_protocols(session_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS slack_threads (
  chat_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  adopted_from_ts TEXT NOT NULL,
  last_activity_ms INTEGER NOT NULL,
  PRIMARY KEY (chat_id, thread_ts)
);
CREATE TABLE IF NOT EXISTS slack_channel_routes (
  app_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  configured_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_slack_channel_routes_repo
  ON slack_channel_routes(app_id, repo_path, channel_id);
CREATE TABLE IF NOT EXISTS slack_channel_route_state (
  app_id TEXT PRIMARY KEY,
  explicit_mode INTEGER NOT NULL DEFAULT 1 CHECK (explicit_mode = 1),
  activated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_catchup_floors (
  app_id TEXT PRIMARY KEY,
  oldest_ms INTEGER NOT NULL CHECK (oldest_ms > 0),
  created_at INTEGER NOT NULL
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
  body_delivered_at INTEGER,
  reaction_delivered_at INTEGER,
  delivered_at INTEGER,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_terminal_notifications_pending
  ON terminal_notifications(delivered_at, not_before, created_at);
CREATE TABLE IF NOT EXISTS lifecycle_notifications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('started', 'progress')),
  slot INTEGER NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  superseded_at INTEGER,
  UNIQUE (job_id, attempt, kind, slot),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_notifications_pending
  ON lifecycle_notifications(delivered_at, superseded_at, not_before, created_at);
CREATE TABLE IF NOT EXISTS commentary_notifications (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  source_key TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_commentary_notifications_pending
  ON commentary_notifications(delivered_at, not_before, seq);
CREATE TABLE IF NOT EXISTS status_notifications (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  job_id TEXT,
  chat_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'accepted', 'interrupt-accepted', 'closed-control',
    'inactive-interrupt', 'attachment-control-failed', 'rate-limited'
  )),
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  superseded_at INTEGER,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_status_notifications_pending
  ON status_notifications(delivered_at, superseded_at, not_before, created_at);
CREATE TABLE IF NOT EXISTS progress_probes (
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  client_message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reported_at INTEGER,
  superseded_at INTEGER,
  superseded_by_slot INTEGER,
  PRIMARY KEY (job_id, attempt, slot),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE TABLE IF NOT EXISTS monitor_failures (
  job_id TEXT PRIMARY KEY,
  reason_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE TABLE IF NOT EXISTS artifact_deliveries (
  job_id TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  remote_file_id TEXT,
  started_at INTEGER,
  ambiguity_checks INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  abandoned_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (job_id, artifact_path),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE TABLE IF NOT EXISTS ui_approval_requests (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  round INTEGER NOT NULL CHECK (round > 0),
  input_revision INTEGER NOT NULL CHECK (input_revision > 0),
  input_digest TEXT NOT NULL,
  repository_digest TEXT NOT NULL,
  session_id TEXT NOT NULL,
  proposal_text TEXT NOT NULL,
  before_path TEXT NOT NULL,
  after_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('publishing', 'awaiting', 'responded', 'superseded', 'cancelled')),
  response_message_id TEXT,
  response_user_id TEXT,
  response_text TEXT,
  response_input_revision INTEGER,
  response_explicit_approval INTEGER CHECK (response_explicit_approval IS NULL OR response_explicit_approval IN (0, 1)),
  prompt_client_message_id TEXT NOT NULL,
  prompt_delivery_started_at INTEGER,
  prompt_message_id TEXT,
  prompt_delivered_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  UNIQUE (job_id, round),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_ui_approval_requests_pending
  ON ui_approval_requests(status, not_before, created_at);
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
  is_interrupt INTEGER NOT NULL DEFAULT 0 CHECK (is_interrupt IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  expected_control_job_id TEXT,
  expected_control_epoch INTEGER,
  downloaded_files_json TEXT NOT NULL DEFAULT '[]',
  initial_context_state TEXT NOT NULL DEFAULT 'none'
    CHECK (initial_context_state IN ('none', 'pending', 'hydrated'))
);
CREATE INDEX IF NOT EXISTS idx_inbound_deliveries_seq
  ON inbound_deliveries(status, seq);
CREATE TABLE IF NOT EXISTS job_controls (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL,
  control_epoch INTEGER NOT NULL,
  input_revision INTEGER NOT NULL,
  input_digest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('steer', 'interrupt')),
  chat_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  write_enabled INTEGER NOT NULL DEFAULT 0 CHECK (write_enabled IN (0, 1)),
  task TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'dispatching', 'acknowledged', 'observed', 'superseded', 'ambiguous')),
  request_id INTEGER,
  executor_nonce TEXT,
  app_thread_id TEXT,
  turn_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  acknowledged_at INTEGER,
  observed_at INTEGER,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_job_controls_ready
  ON job_controls(job_id, control_epoch, status, seq);
CREATE TABLE IF NOT EXISTS job_interjections (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL,
  control_epoch INTEGER NOT NULL,
  input_revision INTEGER NOT NULL,
  input_digest TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  write_enabled INTEGER NOT NULL DEFAULT 0 CHECK (write_enabled IN (0, 1)),
  task TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN (
    'ready', 'pausing', 'paused', 'answer-prepared', 'answering',
    'answered', 'delivered', 'promoted', 'superseded', 'ambiguous'
  )),
  pause_request_id INTEGER,
  pause_executor_nonce TEXT,
  pause_thread_id TEXT,
  pause_turn_id TEXT,
  answer_request_id INTEGER,
  answer_logical_nonce TEXT,
  answer_thread_id TEXT,
  answer_turn_id TEXT,
  disposition TEXT CHECK (disposition IS NULL OR disposition IN ('answer-only', 'task-update')),
  answer_payload TEXT,
  notification_id TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  pause_dispatched_at INTEGER,
  pause_acknowledged_at INTEGER,
  paused_at INTEGER,
  answer_prepared_at INTEGER,
  answer_dispatched_at INTEGER,
  answer_acknowledged_at INTEGER,
  answered_at INTEGER,
  delivered_at INTEGER,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_job_interjections_ready
  ON job_interjections(job_id, control_epoch, status, seq);
CREATE INDEX IF NOT EXISTS idx_job_interjections_notifications
  ON job_interjections(delivered_at, not_before, answered_at);
CREATE TABLE IF NOT EXISTS job_initial_dispatches (
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  control_epoch INTEGER NOT NULL,
  input_revision INTEGER NOT NULL,
  input_digest TEXT NOT NULL DEFAULT '',
  client_user_message_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('prepared', 'dispatching', 'acknowledged', 'observed', 'rejected', 'ambiguous')),
  request_id INTEGER,
  executor_nonce TEXT,
  app_thread_id TEXT,
  turn_id TEXT,
  last_error TEXT,
  prepared_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  acknowledged_at INTEGER,
  observed_at INTEGER,
  PRIMARY KEY (job_id, attempt),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_job_initial_dispatches_status
  ON job_initial_dispatches(job_id, attempt, status);
CREATE TABLE IF NOT EXISTS job_phase_dispatches (
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  phase_sequence INTEGER NOT NULL,
  control_epoch INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('prepare', 'implementation', 'review')),
  logical_nonce TEXT NOT NULL,
  input_revision INTEGER NOT NULL,
  input_digest TEXT NOT NULL,
  client_user_message_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('prepared', 'dispatching', 'acknowledged', 'observed', 'rejected', 'ambiguous')),
  request_id INTEGER,
  app_thread_id TEXT NOT NULL,
  turn_id TEXT,
  last_error TEXT,
  prepared_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  acknowledged_at INTEGER,
  observed_at INTEGER,
  PRIMARY KEY (job_id, attempt, phase_sequence),
  UNIQUE (client_user_message_id),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_job_phase_dispatches_status
  ON job_phase_dispatches(job_id, attempt, status, phase_sequence);
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
CREATE TABLE IF NOT EXISTS slack_dm_history_retries (
  app_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  failure_count INTEGER NOT NULL CHECK (failure_count >= 1),
  error_code TEXT NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_slack_dm_history_retries_due
  ON slack_dm_history_retries(app_id, next_attempt_at, channel_id);
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
  if (!columns.some(column => column.name === 'monitor_state')) {
    try {
      db.exec('ALTER TABLE jobs ADD COLUMN monitor_state INTEGER NOT NULL DEFAULT 0 CHECK (monitor_state IN (0, 1, 2, 3))')
    } catch (error) {
      const migrated = db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all()
      if (!migrated.some(column => column.name === 'monitor_state')) throw error
    }
  }
  for (const [name, definition] of [
    ['pending_session_id', 'TEXT'],
    ['pending_result', 'TEXT'],
    [
      'repository_drift_retries',
      'INTEGER NOT NULL DEFAULT 0 CHECK (repository_drift_retries >= 0)',
    ],
    ['repository_drift_intent_attempt', 'INTEGER'],
    ['repository_drift_intent_reason', 'TEXT'],
    ['input_revision', 'INTEGER NOT NULL DEFAULT 1'],
    ['control_epoch', 'INTEGER NOT NULL DEFAULT 0'],
    ['accepts_control', 'INTEGER NOT NULL DEFAULT 0 CHECK (accepts_control IN (0, 1))'],
    ['executor_nonce', 'TEXT'],
    ['active_thread_id', 'TEXT'],
    ['active_turn_id', 'TEXT'],
    ['cancel_requested_at', 'INTEGER'],
    [
      'terminal_outcome',
      "TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('completed', 'failed', 'cancelled'))",
    ],
    ['ui_approval_request_id', 'TEXT'],
  ] as const) {
    const current = db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all()
    if (current.some(column => column.name === name)) continue
    try {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`)
    } catch (error) {
      const migrated = db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all()
      if (!migrated.some(column => column.name === name)) throw error
    }
  }
  for (const [name, definition] of [
    ['prompt_client_message_id', "TEXT NOT NULL DEFAULT ''"],
    ['prompt_delivery_started_at', 'INTEGER'],
    ['prompt_message_id', 'TEXT'],
  ] as const) {
    const current = db.query<{ name: string }, []>(
      'PRAGMA table_info(ui_approval_requests)',
    ).all()
    if (current.some(column => column.name === name)) continue
    try {
      db.exec(`ALTER TABLE ui_approval_requests ADD COLUMN ${name} ${definition}`)
    } catch (error) {
      const migrated = db.query<{ name: string }, []>(
        'PRAGMA table_info(ui_approval_requests)',
      ).all()
      if (!migrated.some(column => column.name === name)) throw error
    }
  }
  const legacyUiApprovalPrompts = db.query<{ id: string }, []>(
    "SELECT id FROM ui_approval_requests WHERE prompt_client_message_id = ''",
  ).all()
  for (const row of legacyUiApprovalPrompts) {
    db.run(
      'UPDATE ui_approval_requests SET prompt_client_message_id = ? WHERE id = ?',
      [slackClientMessageId(`ui-approval:${row.id}`, 0), row.id],
    )
  }
  // Older versions persisted only a local delivery timestamp. Re-enter the
  // publish reconciliation path so the stable client_msg_id can be located in
  // Slack before any response is treated as explicit approval.
  db.run(
    `UPDATE ui_approval_requests
     SET status = 'publishing', prompt_delivered_at = NULL,
         response_explicit_approval = CASE
           WHEN response_message_id IS NULL THEN NULL ELSE 0
         END
     WHERE prompt_message_id IS NULL AND status IN ('awaiting', 'responded')`,
  )
  const migrateCodexSessionUsageLedger = db.transaction(() => {
    if (db.query<{ present: number }, []>(
      "SELECT 1 AS present FROM migration_ledger WHERE name = 'codex-session-usage-ledger-v1'",
    ).get()) return
    const migratedAt = Date.now()
    // Existing protocol rows may already have lost job rows to retention, so
    // their true use count cannot be reconstructed. Retire them for new jobs
    // instead of silently treating the surviving COUNT(jobs) as authoritative.
    db.run(
      `INSERT OR IGNORE INTO codex_session_retirements (session_id, retired_at, reason)
       SELECT session_id, ?, 'pre-usage-ledger' FROM codex_session_protocols`,
      [migratedAt],
    )
    // Keep the observable remainder for audit and same-job retry idempotency;
    // retired sessions are still never selected for a distinct new job.
    db.run(
      `INSERT OR IGNORE INTO codex_session_job_uses (session_id, job_id, recorded_at)
       SELECT jobs.session_id, jobs.id, COALESCE(jobs.started_at, jobs.created_at)
       FROM jobs
       JOIN codex_session_protocols protocols ON protocols.session_id = jobs.session_id
       WHERE jobs.runtime = 'codex' AND jobs.session_id IS NOT NULL`,
    )
    db.run(
      `INSERT INTO migration_ledger (name, completed_at)
       VALUES ('codex-session-usage-ledger-v1', ?)`,
      [migratedAt],
    )
  })
  migrateCodexSessionUsageLedger.immediate()
  const initialDispatchColumns = db.query<{ name: string }, []>(
    'PRAGMA table_info(job_initial_dispatches)',
  ).all()
  if (!initialDispatchColumns.some(column => column.name === 'input_digest')) {
    try {
      db.exec("ALTER TABLE job_initial_dispatches ADD COLUMN input_digest TEXT NOT NULL DEFAULT ''")
    } catch (error) {
      const migrated = db.query<{ name: string }, []>(
        'PRAGMA table_info(job_initial_dispatches)',
      ).all()
      if (!migrated.some(column => column.name === 'input_digest')) throw error
    }
  }
  const controlColumns = db.query<{ name: string }, []>('PRAGMA table_info(job_controls)').all()
  for (const [name, definition] of [
    ['input_revision', 'INTEGER NOT NULL DEFAULT 1'],
    ['input_digest', "TEXT NOT NULL DEFAULT ''"],
    ['write_enabled', 'INTEGER NOT NULL DEFAULT 0 CHECK (write_enabled IN (0, 1))'],
  ] as const) {
    if (controlColumns.some(column => column.name === name)) continue
    try {
      db.exec(`ALTER TABLE job_controls ADD COLUMN ${name} ${definition}`)
    } catch (error) {
      const migrated = db.query<{ name: string }, []>('PRAGMA table_info(job_controls)').all()
      if (!migrated.some(column => column.name === name)) throw error
    }
  }
  const inboundColumns = db.query<{ name: string }, []>(
    'PRAGMA table_info(inbound_deliveries)',
  ).all()
  if (!inboundColumns.some(column => column.name === 'is_interrupt')) {
    try {
      db.exec(
        'ALTER TABLE inbound_deliveries ADD COLUMN is_interrupt '
        + 'INTEGER NOT NULL DEFAULT 0 CHECK (is_interrupt IN (0, 1))',
      )
    } catch (error) {
      const migrated = db.query<{ name: string }, []>(
        'PRAGMA table_info(inbound_deliveries)',
      ).all()
      if (!migrated.some(column => column.name === 'is_interrupt')) throw error
    }
  }
  for (const [name, definition] of [
    ['expected_control_job_id', 'TEXT'],
    ['expected_control_epoch', 'INTEGER'],
    ['downloaded_files_json', "TEXT NOT NULL DEFAULT '[]'"],
    [
      'initial_context_state',
      "TEXT NOT NULL DEFAULT 'none' CHECK (initial_context_state IN ('none', 'pending', 'hydrated'))",
    ],
  ] as const) {
    const current = db.query<{ name: string }, []>(
      'PRAGMA table_info(inbound_deliveries)',
    ).all()
    if (current.some(column => column.name === name)) continue
    try {
      db.exec(`ALTER TABLE inbound_deliveries ADD COLUMN ${name} ${definition}`)
    } catch (error) {
      const migrated = db.query<{ name: string }, []>(
        'PRAGMA table_info(inbound_deliveries)',
      ).all()
      if (!migrated.some(column => column.name === name)) throw error
    }
  }
  const migrateInboundInterruptClassification = db.transaction(() => {
    if (db.query<{ present: number }, []>(
      "SELECT 1 AS present FROM migration_ledger WHERE name = 'inbound-interrupt-classification-v1'",
    ).get()) return
    const deliveries = db.query<{ seq: number; text: string; is_interrupt: number }, []>(
      'SELECT seq, text, is_interrupt FROM inbound_deliveries ORDER BY seq',
    ).all()
    for (const delivery of deliveries) {
      if (delivery.is_interrupt === 0 && isSlackInterruptCommand(delivery.text)) {
        db.run('UPDATE inbound_deliveries SET is_interrupt = 1 WHERE seq = ?', [delivery.seq])
      }
    }
    db.run(
      `INSERT INTO migration_ledger (name, completed_at)
       VALUES ('inbound-interrupt-classification-v1', ?)`,
      [Date.now()],
    )
  })
  migrateInboundInterruptClassification.immediate()
  const migrateAdvisorInputLedger = db.transaction(() => {
    if (db.query<{ present: number }, []>(
      "SELECT 1 AS present FROM migration_ledger WHERE name = 'advisor-input-ledger-v1'",
    ).get()) return
      const jobs = db.query<{
        id: string
        message_id: string
        user_id: string
        write_enabled: number
        task: string
        attachments_json: string
        input_revision: number
      }, []>(
        `SELECT id, message_id, user_id, task, attachments_json, input_revision
         FROM jobs ORDER BY seq`,
      ).all()
      for (const job of jobs) {
        const controls = db.query<{
          id: string
          kind: JobControlKind
          input_revision: number
          input_digest: string
          message_id: string
          user_id: string
          task: string
          attachments_json: string
        }, [string]>(
          `SELECT id, kind, input_revision, input_digest,
                  message_id, user_id, task, attachments_json
           FROM job_controls WHERE job_id = ? ORDER BY seq`,
        ).all(job.id)
        let revision = 1
        const steers: Array<{
          input_revision: number
          message_id: string
          user_id: string
          task: string
          attachments_json: string
        }> = []
        for (const control of controls) {
          if (control.kind === 'steer') {
            revision += 1
            steers.push({
              input_revision: revision,
              message_id: control.message_id,
              user_id: control.user_id,
              task: control.task,
              attachments_json: control.attachments_json,
            })
          }
          const snapshot = createAdvisorInputSnapshot({
            ...job,
            input_revision: revision,
          }, steers, 1)
          if (control.input_digest !== '') {
            if (!/^[0-9a-f]{64}$/.test(control.input_digest)
              || control.input_revision !== revision
              || control.input_digest !== snapshot.digest) {
              throw new Error(`existing advisor input ledger conflicts for control ${control.id}`)
            }
          } else if (control.input_revision !== 1 && control.input_revision !== revision) {
            throw new Error(`legacy advisor input revision conflicts for control ${control.id}`)
          }
          db.run(
            'UPDATE job_controls SET input_revision = ?, input_digest = ? WHERE id = ?',
            [revision, snapshot.digest, control.id],
          )
        }
        const hasLegacyEmptyControl = controls.some(control => control.input_digest === '')
        if (job.input_revision !== revision
          && !(hasLegacyEmptyControl && job.input_revision === 1)) {
          throw new Error(`existing advisor input ledger conflicts for job ${job.id}`)
        }
        db.run('UPDATE jobs SET input_revision = ? WHERE id = ?', [revision, job.id])
      }
      db.run(
        `INSERT INTO migration_ledger (name, completed_at)
         VALUES ('advisor-input-ledger-v1', ?)`,
        [Date.now()],
      )
      db.run("DELETE FROM migration_ledger WHERE name = 'advisor-input-authority-v2'")
  })
  migrateAdvisorInputLedger.immediate()
  const migrateAdvisorInputAuthority = db.transaction(() => {
    if (db.query<{ present: number }, []>(
      "SELECT 1 AS present FROM migration_ledger WHERE name = 'advisor-input-authority-v2'",
    ).get()) return
    const jobs = db.query<{
      id: string
      message_id: string
      user_id: string
      write_enabled: number
      task: string
      attachments_json: string
      input_revision: number
    }, []>(
      `SELECT id, message_id, user_id, write_enabled, task, attachments_json, input_revision
       FROM jobs ORDER BY seq`,
    ).all()
    for (const job of jobs) {
      const controls = db.query<{
        id: string
        kind: JobControlKind
        input_revision: number
        message_id: string
        user_id: string
        write_enabled: number
        task: string
        attachments_json: string
      }, [string]>(
        `SELECT id, kind, input_revision, message_id, user_id, write_enabled,
                task, attachments_json
         FROM job_controls WHERE job_id = ? ORDER BY seq`,
      ).all(job.id)
      let revision = 1
      const steers: Array<{
        input_revision: number
        message_id: string
        user_id: string
        write_enabled: number
        task: string
        attachments_json: string
      }> = []
      const digests = new Map<number, string>()
      digests.set(1, createAdvisorInputSnapshot({ ...job, input_revision: 1 }, []).digest)
      for (const control of controls) {
        if (control.kind === 'steer') {
          revision += 1
          steers.push({
            input_revision: revision,
            message_id: control.message_id,
            user_id: control.user_id,
            write_enabled: control.write_enabled,
            task: control.task,
            attachments_json: control.attachments_json,
          })
        }
        const snapshot = createAdvisorInputSnapshot({
          ...job,
          input_revision: revision,
        }, steers)
        digests.set(revision, snapshot.digest)
        db.run(
          'UPDATE job_controls SET input_revision = ?, input_digest = ? WHERE id = ?',
          [revision, snapshot.digest, control.id],
        )
      }
      db.run('UPDATE jobs SET input_revision = ? WHERE id = ?', [revision, job.id])
      for (const [inputRevision, digest] of digests) {
        db.run(
          `UPDATE job_initial_dispatches SET input_digest = ?
           WHERE job_id = ? AND input_revision = ?`,
          [digest, job.id, inputRevision],
        )
        db.run(
          `UPDATE job_phase_dispatches SET input_digest = ?
           WHERE job_id = ? AND input_revision = ?`,
          [digest, job.id, inputRevision],
        )
      }
    }
    db.run(
      `INSERT INTO migration_ledger (name, completed_at)
       VALUES ('advisor-input-authority-v2', ?)`,
      [Date.now()],
    )
  })
  migrateAdvisorInputAuthority.immediate()
  const migrateQueuedLiveControl = db.transaction(() => {
    if (db.query<{ present: number }, []>(
      "SELECT 1 AS present FROM migration_ledger WHERE name = 'queued-live-control-v1'",
    ).get()) return
    db.run(
      `UPDATE jobs
       SET control_epoch = CASE WHEN control_epoch < 1 THEN 1 ELSE control_epoch END,
           accepts_control = CASE WHEN cancel_requested_at IS NULL THEN 1 ELSE 0 END
       WHERE runtime = 'codex' AND status = 'queued'`,
    )
    db.run(
      `INSERT INTO migration_ledger (name, completed_at)
       VALUES ('queued-live-control-v1', ?)`,
      [Date.now()],
    )
  })
  migrateQueuedLiveControl.immediate()
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_job_controls_steer_revision
     ON job_controls(job_id, input_revision) WHERE kind = 'steer'`,
  )
  const notificationColumns = db.query<{ name: string }, []>(
    'PRAGMA table_info(terminal_notifications)',
  ).all()
  if (!notificationColumns.some(column => column.name === 'body_delivered_at')) {
    try {
      db.exec('ALTER TABLE terminal_notifications ADD COLUMN body_delivered_at INTEGER')
    } catch (error) {
      const migrated = db.query<{ name: string }, []>(
        'PRAGMA table_info(terminal_notifications)',
      ).all()
      if (!migrated.some(column => column.name === 'body_delivered_at')) throw error
    }
  }
  if (!notificationColumns.some(column => column.name === 'reaction_delivered_at')) {
    try {
      db.exec('ALTER TABLE terminal_notifications ADD COLUMN reaction_delivered_at INTEGER')
    } catch (error) {
      const migrated = db.query<{ name: string }, []>(
        'PRAGMA table_info(terminal_notifications)',
      ).all()
      if (!migrated.some(column => column.name === 'reaction_delivered_at')) throw error
    }
  }
  const artifactColumns = db.query<{ name: string }, []>(
    'PRAGMA table_info(artifact_deliveries)',
  ).all()
  for (const [name, definition] of [
    ['remote_file_id', 'TEXT'],
    ['started_at', 'INTEGER'],
    ['ambiguity_checks', 'INTEGER NOT NULL DEFAULT 0'],
    ['abandoned_at', 'INTEGER'],
    ['last_error', 'TEXT'],
  ] as const) {
    if (artifactColumns.some(column => column.name === name)) continue
    try {
      db.exec(`ALTER TABLE artifact_deliveries ADD COLUMN ${name} ${definition}`)
    } catch (error) {
      const migrated = db.query<{ name: string }, []>('PRAGMA table_info(artifact_deliveries)').all()
      if (!migrated.some(column => column.name === name)) throw error
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_ready_seq ON jobs(status, not_before, seq)')
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_runtime_ready_seq ON jobs(runtime, status, not_before, seq)")
  db.exec('CREATE INDEX IF NOT EXISTS idx_job_controls_ready ON job_controls(job_id, control_epoch, status, seq)')
  const runningCodex = db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM jobs WHERE runtime = 'codex' AND status = 'running'",
  ).get()?.count ?? 0
  if (runningCodex > 1) {
    throw new Error(
      `job database has ${runningCodex} concurrent Codex jobs; refuse to weaken FIFO recovery`,
    )
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_single_running_codex "
      + "ON jobs((1)) WHERE runtime = 'codex' AND status = 'running'",
  )
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

function parseInboundDownloadedFiles(value: string): InboundDownloadedFile[] {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('inbound attachment manifest is invalid JSON') }
  if (!Array.isArray(parsed)) throw new Error('inbound attachment manifest is not an array')
  const files: InboundDownloadedFile[] = []
  const ordinals = new Set<number>()
  const fileIds = new Set<string>()
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('inbound attachment manifest entry is invalid')
    }
    const record = entry as Record<string, unknown>
    if (typeof record.fileId !== 'string' || !record.fileId
      || !Number.isSafeInteger(record.ordinal) || Number(record.ordinal) < 0
      || typeof record.path !== 'string' || !record.path
      || !Number.isSafeInteger(record.size) || Number(record.size) < 0
      || Number(record.size) > 50 * 1024 * 1024
      || typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) {
      throw new Error('inbound attachment manifest fields are invalid')
    }
    const ordinal = Number(record.ordinal)
    if (ordinals.has(ordinal) || fileIds.has(record.fileId)) {
      throw new Error('inbound attachment manifest has duplicate entries')
    }
    ordinals.add(ordinal)
    fileIds.add(record.fileId)
    files.push({
      fileId: record.fileId,
      ordinal,
      path: record.path,
      size: Number(record.size),
      digest: record.digest,
    })
  }
  return files.sort((left, right) => left.ordinal - right.ordinal)
}

function mapInboundDeliveryRow(row: InboundDeliveryRow): InboundDeliveryRecord {
  if (!['none', 'pending', 'hydrated'].includes(row.initial_context_state)) {
    throw new Error(`invalid initial context state for ${row.idempotency_key}`)
  }
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
    isInterrupt: row.is_interrupt === 1,
    attempts: row.attempts,
    notBefore: row.not_before,
    expectedControlJobId: row.expected_control_job_id,
    expectedControlEpoch: row.expected_control_epoch,
    downloadedFiles: parseInboundDownloadedFiles(row.downloaded_files_json),
    initialContextState: row.initial_context_state,
  }
}

function mapRow(row: JobRow): JobRecord {
  const monitorState = row.monitor_state === 0
    ? 'none'
    : row.monitor_state === 1
      ? 'preparing'
      : row.monitor_state === 2
        ? 'required'
        : row.monitor_state === 3
          ? 'lost-staged'
          : (() => { throw new Error(`invalid monitor_state for job ${row.id}`) })()
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
    inputRevision: row.input_revision,
    attachments: parseAttachments(row.attachments_json),
    runtime: row.runtime,
    writeEnabled: row.write_enabled === 1,
    status: row.status,
    sessionId: row.session_id,
    resumed: row.resumed === 1,
    workerId: row.worker_id,
    executorPid: row.executor_pid,
    monitorState,
    attempts: row.attempts,
    repositoryDriftRetries: row.repository_drift_retries,
    notBefore: row.not_before,
    result: row.result,
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    controlEpoch: row.control_epoch,
    acceptsControl: row.accepts_control === 1,
    executorNonce: row.executor_nonce,
    activeThreadId: row.active_thread_id,
    activeTurnId: row.active_turn_id,
    cancelRequestedAt: row.cancel_requested_at,
    terminalOutcome: row.terminal_outcome,
    uiApprovalRequestId: row.ui_approval_request_id,
  }
}

function mapUiApprovalRequest(row: UiApprovalRequestRow): UiApprovalRequestRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    round: row.round,
    inputRevision: row.input_revision,
    inputDigest: row.input_digest,
    repositoryDigest: row.repository_digest,
    sessionId: row.session_id,
    proposalText: row.proposal_text,
    beforePath: row.before_path,
    afterPath: row.after_path,
    status: row.status,
    responseMessageId: row.response_message_id,
    responseUserId: row.response_user_id,
    responseText: row.response_text,
    responseInputRevision: row.response_input_revision,
    responseExplicitApproval: row.response_explicit_approval === null
      ? null
      : row.response_explicit_approval === 1,
    promptClientMessageId: row.prompt_client_message_id,
    promptDeliveryStartedAt: row.prompt_delivery_started_at,
    promptMessageId: row.prompt_message_id,
    promptDeliveredAt: row.prompt_delivered_at,
    attempts: row.attempts,
    notBefore: row.not_before,
  }
}

type JobControlRow = {
  seq: number
  id: string
  idempotency_key: string
  job_id: string
  control_epoch: number
  input_revision: number
  input_digest: string
  kind: JobControlKind
  chat_id: string
  thread_ts: string
  message_id: string
  user_id: string
  write_enabled: number
  task: string
  attachments_json: string
  status: JobControlStatus
  request_id: number | null
  executor_nonce: string | null
  app_thread_id: string | null
  turn_id: string | null
  last_error: string | null
  created_at: number
  dispatched_at: number | null
  acknowledged_at: number | null
  observed_at: number | null
}

type JobInterjectionRow = {
  seq: number
  id: string
  idempotency_key: string
  job_id: string
  control_epoch: number
  input_revision: number
  input_digest: string
  chat_id: string
  thread_ts: string
  message_id: string
  user_id: string
  write_enabled: number
  task: string
  attachments_json: string
  status: JobInterjectionStatus
  pause_request_id: number | null
  pause_executor_nonce: string | null
  pause_thread_id: string | null
  pause_turn_id: string | null
  answer_request_id: number | null
  answer_logical_nonce: string | null
  answer_thread_id: string | null
  answer_turn_id: string | null
  disposition: JobInterjectionDisposition | null
  answer_payload: string | null
  notification_id: string | null
  attempts: number
  not_before: number | null
  last_error: string | null
  created_at: number
  paused_at: number | null
  answered_at: number | null
  delivered_at: number | null
}

function mapControlRow(row: JobControlRow): JobControlRecord {
  return {
    seq: row.seq,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    jobId: row.job_id,
    epoch: row.control_epoch,
    inputRevision: row.input_revision,
    inputDigest: row.input_digest,
    kind: row.kind,
    chatId: row.chat_id,
    threadTs: row.thread_ts,
    messageId: row.message_id,
    userId: row.user_id,
    writeEnabled: row.write_enabled === 1,
    task: row.task,
    attachments: parseAttachments(row.attachments_json),
    status: row.status,
    requestId: row.request_id,
    executorNonce: row.executor_nonce,
    threadId: row.app_thread_id,
    turnId: row.turn_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    acknowledgedAt: row.acknowledged_at,
    observedAt: row.observed_at,
  }
}

function mapInterjectionRow(row: JobInterjectionRow): JobInterjectionRecord {
  return {
    seq: row.seq,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    jobId: row.job_id,
    epoch: row.control_epoch,
    inputRevision: row.input_revision,
    inputDigest: row.input_digest,
    kind: 'interjection',
    chatId: row.chat_id,
    threadTs: row.thread_ts,
    messageId: row.message_id,
    userId: row.user_id,
    writeEnabled: row.write_enabled === 1,
    task: row.task,
    attachments: parseAttachments(row.attachments_json),
    status: row.status,
    pauseRequestId: row.pause_request_id,
    pauseExecutorNonce: row.pause_executor_nonce,
    pauseThreadId: row.pause_thread_id,
    pauseTurnId: row.pause_turn_id,
    answerRequestId: row.answer_request_id,
    answerLogicalNonce: row.answer_logical_nonce,
    answerThreadId: row.answer_thread_id,
    answerTurnId: row.answer_turn_id,
    disposition: row.disposition,
    answer: row.answer_payload,
    notificationId: row.notification_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    pausedAt: row.paused_at,
    answeredAt: row.answered_at,
    deliveredAt: row.delivered_at,
  }
}

function requireText(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} is required`)
  return normalized
}

function requireSlackAppId(value: string): string {
  const normalized = requireText(value, 'Slack app ID').toUpperCase()
  if (!/^A[A-Z0-9]+$/.test(normalized)) throw new Error(`invalid Slack app ID: ${value}`)
  return normalized
}

function requireSlackChannelId(value: string): string {
  const normalized = requireText(value, 'Slack channel ID').toUpperCase()
  if (!/^[CG][A-Z0-9]+$/.test(normalized)) {
    throw new Error(`invalid Slack channel ID: ${value}`)
  }
  return normalized
}

function requireSlackDirectMessageId(value: string): string {
  const normalized = requireText(value, 'Slack direct-message ID').toUpperCase()
  if (!/^D[A-Z0-9]+$/.test(normalized)) {
    throw new Error(`invalid Slack direct-message ID: ${value}`)
  }
  return normalized
}

function normalizeSlackChannelIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 128) {
    throw new Error('Slack channel route limit is 128 per project')
  }
  return [...new Set(values.map(requireSlackChannelId))].sort()
}

function positiveInteger(value: string | number | undefined, fallback: number): number {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback
}

/** Operator tuning may shorten a session, but never exceed the public 20-job contract. */
export function configuredMaxJobsPerSession(value: string | number | undefined): number {
  return Math.min(
    positiveInteger(value, DEFAULT_MAX_JOBS_PER_SESSION),
    DEFAULT_MAX_JOBS_PER_SESSION,
  )
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

export function requireSafeDatabasePath(dbPath: string): void {
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
          db.exec('PRAGMA synchronous=FULL')
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

  private supersedeLifecycleNotifications(jobId: string, now = Date.now()): void {
    this.db.run(
      `UPDATE lifecycle_notifications SET superseded_at = COALESCE(superseded_at, ?)
       WHERE job_id = ? AND delivered_at IS NULL AND superseded_at IS NULL`,
      [now, jobId],
    )
    this.db.run(
      `UPDATE progress_probes SET superseded_at = COALESCE(superseded_at, ?)
       WHERE job_id = ? AND reported_at IS NULL AND superseded_at IS NULL`,
      [now, jobId],
    )
    this.db.run(
      `UPDATE status_notifications SET superseded_at = COALESCE(superseded_at, ?)
       WHERE job_id = ? AND kind = 'rate-limited'
         AND delivered_at IS NULL AND superseded_at IS NULL`,
      [now, jobId],
    )
  }

  private stageStatusNotificationRow(input: {
    idempotencyKey: string
    jobId: string | null
    chatId: string
    threadTs: string
    kind: StatusNotificationKind
    payload: string
    createdAt: number
  }): void {
    const id = randomUUID()
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO status_notifications (
         id, idempotency_key, job_id, chat_id, thread_ts, kind, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.idempotencyKey,
        input.jobId,
        input.chatId,
        input.threadTs,
        input.kind,
        input.payload,
        input.createdAt,
      ],
    )
    if (inserted.changes === 1) return
    const existing = this.db.query<{
      job_id: string | null
      chat_id: string
      thread_ts: string
      kind: StatusNotificationKind
      payload: string
    }, [string]>(
      `SELECT job_id, chat_id, thread_ts, kind, payload
       FROM status_notifications WHERE idempotency_key = ?`,
    ).get(input.idempotencyKey)
    if (!existing
      || existing.job_id !== input.jobId
      || existing.chat_id !== input.chatId
      || existing.thread_ts !== input.threadTs
      || existing.kind !== input.kind
      || existing.payload !== input.payload) {
      throw new Error(`status notification identity collision: ${input.idempotencyKey}`)
    }
  }

  private recordCodexSessionUse(sessionId: string, jobId: string, recordedAt: number): void {
    const existing = this.db.query<{ protocol_version: number }, [string]>(
      'SELECT protocol_version FROM codex_session_protocols WHERE session_id = ?',
    ).get(sessionId)
    if (existing && existing.protocol_version !== CODEX_SESSION_PROTOCOL_VERSION) {
      throw new Error(`Codex session protocol changed for job ${jobId}`)
    }
    const retired = this.db.query<{ present: number }, [string]>(
      'SELECT 1 AS present FROM codex_session_retirements WHERE session_id = ?',
    ).get(sessionId)
    const sameJobContinuation = this.db.query<{ present: number }, [string, string]>(
      `SELECT 1 AS present FROM jobs
       WHERE id = ? AND runtime = 'codex' AND session_id = ? AND attempts > 0`,
    ).get(jobId, sessionId)
    if (retired && !sameJobContinuation) {
      throw new Error(`retired Codex session cannot bind a new job: ${jobId}`)
    }
    this.db.run(
      `INSERT INTO codex_session_protocols (session_id, protocol_version, recorded_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET recorded_at = excluded.recorded_at`,
      [sessionId, CODEX_SESSION_PROTOCOL_VERSION, recordedAt],
    )
    this.db.run(
      `INSERT OR IGNORE INTO codex_session_job_uses (session_id, job_id, recorded_at)
       VALUES (?, ?, ?)`,
      [sessionId, jobId, recordedAt],
    )
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

  listSlackChannelRoutes(appIdInput: string): Array<{
    appId: string
    channelId: string
    repoPath: string
    configuredAt: number
  }> {
    const appId = requireSlackAppId(appIdInput)
    return this.db.query<{
      app_id: string
      channel_id: string
      repo_path: string
      configured_at: number
    }, [string]>(
      `SELECT app_id, channel_id, repo_path, configured_at
       FROM slack_channel_routes WHERE app_id = ?
       ORDER BY channel_id`,
    ).all(appId).map(row => ({
      appId: row.app_id,
      channelId: row.channel_id,
      repoPath: row.repo_path,
      configuredAt: row.configured_at,
    }))
  }

  resolveSlackChannelRoute(appIdInput: string, channelIdInput: string): string | null {
    const appId = requireSlackAppId(appIdInput)
    const channelId = requireSlackChannelId(channelIdInput)
    return this.db.query<{ repo_path: string }, [string, string]>(
      `SELECT repo_path FROM slack_channel_routes
       WHERE app_id = ? AND channel_id = ?`,
    ).get(appId, channelId)?.repo_path ?? null
  }

  countSlackChannelRoutes(appIdInput: string): number {
    const appId = requireSlackAppId(appIdInput)
    return this.db.query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM slack_channel_routes WHERE app_id = ?',
    ).get(appId)?.count ?? 0
  }

  slackChannelRoutingIsExplicit(appIdInput: string): boolean {
    const appId = requireSlackAppId(appIdInput)
    return this.db.query<{ present: number }, [string]>(
      'SELECT 1 AS present FROM slack_channel_route_state WHERE app_id = ?',
    ).get(appId) !== null
  }

  /**
   * A fresh state has no durable idempotency ledger. Pin its first Slack
   * history read to the time the verified App was configured so reusing that
   * App on another Mac cannot replay requests completed by the old gateway.
   * Existing installations without this table row retain their established
   * cursors instead of silently moving the lower bound during an upgrade.
   */
  initializeSlackCatchupFloorIfPristine(
    appIdInput: string,
    now = Date.now(),
  ): { created: boolean; floorMs: number | null } {
    const appId = requireSlackAppId(appIdInput)
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('catch-up floor timestamp is invalid')
    const initialize = this.db.transaction(() => {
      const existing = this.db.query<{ oldest_ms: number }, [string]>(
        'SELECT oldest_ms FROM slack_catchup_floors WHERE app_id = ?',
      ).get(appId)
      if (existing) return { created: false, floorMs: existing.oldest_ms }

      const state = this.db.query<{ present: number }, []>(
        `SELECT (
          EXISTS(SELECT 1 FROM jobs)
          OR EXISTS(SELECT 1 FROM inbound_deliveries)
          OR EXISTS(SELECT 1 FROM job_controls)
          OR EXISTS(SELECT 1 FROM job_interjections)
          OR EXISTS(SELECT 1 FROM delivery_tombstones)
          OR EXISTS(SELECT 1 FROM update_request_ledger)
          OR EXISTS(SELECT 1 FROM slack_threads)
          OR EXISTS(SELECT 1 FROM slack_channel_routes)
          OR EXISTS(SELECT 1 FROM slack_channel_route_state)
          OR EXISTS(SELECT 1 FROM slack_read_cursors)
        ) AS present`,
      ).get()
      if (state?.present === 1) return { created: false, floorMs: null }

      this.db.run(
        `INSERT INTO slack_catchup_floors (app_id, oldest_ms, created_at)
         VALUES (?, ?, ?)`,
        [appId, now, now],
      )
      return { created: true, floorMs: now }
    })
    return retrySqlite(() => initialize.immediate())
  }

  slackCatchupFloor(appIdInput: string): number | null {
    const appId = requireSlackAppId(appIdInput)
    const floor = this.db.query<{ oldest_ms: number }, [string]>(
      'SELECT oldest_ms FROM slack_catchup_floors WHERE app_id = ?',
    ).get(appId)?.oldest_ms ?? null
    if (floor !== null && (!Number.isSafeInteger(floor) || floor <= 0)) {
      throw new Error('stored catch-up floor is invalid')
    }
    return floor
  }

  assertSlackChannelRoutesAvailable(
    appIdInput: string,
    repoPathInput: string,
    channelIdsInput: string[],
  ): void {
    const appId = requireSlackAppId(appIdInput)
    const repoPath = requireText(repoPathInput, 'repoPath')
    const channelIds = normalizeSlackChannelIds(channelIdsInput)
    for (const channelId of channelIds) {
      const existing = this.db.query<{ repo_path: string }, [string, string]>(
        `SELECT repo_path FROM slack_channel_routes
         WHERE app_id = ? AND channel_id = ?`,
      ).get(appId, channelId)
      if (existing && existing.repo_path !== repoPath) {
        throw new Error(
          `Slack channel ${channelId} is already connected to ${existing.repo_path}`,
        )
      }
    }
  }

  /**
   * Replace one project's derived channel index in a single immediate
   * transaction. The project-local config is the durable user declaration;
   * this table is the live daemon snapshot. A channel can never be silently
   * stolen by a different project.
   */
  syncSlackChannelRoutes(input: {
    appId: string
    repoPath: string
    channelIds: string[]
    configuredAt?: number
  }): { added: number; removed: number; unchanged: number } {
    const appId = requireSlackAppId(input.appId)
    const repoPath = requireText(input.repoPath, 'repoPath')
    const channelIds = normalizeSlackChannelIds(input.channelIds)
    const configuredAt = input.configuredAt ?? Date.now()
    if (!Number.isSafeInteger(configuredAt) || configuredAt <= 0) {
      throw new Error('channel route timestamp is invalid')
    }
    const desired = new Set(channelIds)
    const sync = this.db.transaction(() => {
      for (const channelId of channelIds) {
        const existing = this.db.query<{ repo_path: string }, [string, string]>(
          `SELECT repo_path FROM slack_channel_routes
           WHERE app_id = ? AND channel_id = ?`,
        ).get(appId, channelId)
        if (existing && existing.repo_path !== repoPath) {
          throw new Error(
            `Slack channel ${channelId} is already connected to ${existing.repo_path}`,
          )
        }
      }

      const owned = this.db.query<{ channel_id: string }, [string, string]>(
        `SELECT channel_id FROM slack_channel_routes
         WHERE app_id = ? AND repo_path = ?`,
      ).all(appId, repoPath).map(row => row.channel_id)
      let removed = 0
      for (const channelId of owned) {
        if (desired.has(channelId)) continue
        removed += this.db.run(
          `DELETE FROM slack_channel_routes
           WHERE app_id = ? AND channel_id = ? AND repo_path = ?`,
          [appId, channelId, repoPath],
        ).changes
      }

      let added = 0
      for (const channelId of channelIds) {
        added += this.db.run(
          `INSERT OR IGNORE INTO slack_channel_routes (
             app_id, channel_id, repo_path, configured_at
           ) VALUES (?, ?, ?, ?)`,
          [appId, channelId, repoPath, configuredAt],
        ).changes
      }
      if (channelIds.length > 0) {
        this.db.run(
          `INSERT OR IGNORE INTO slack_channel_route_state (
             app_id, explicit_mode, activated_at
           ) VALUES (?, 1, ?)`,
          [appId, configuredAt],
        )
      }
      return { added, removed, unchanged: channelIds.length - added }
    })
    return retrySqlite(() => sync.immediate())
  }

  /**
   * Existing Slack thread ownership wins before the current channel mapping.
   * New DMs retain the gateway bootstrap project. Channels retain the legacy
   * bootstrap fallback only until the first explicit channel route exists.
   */
  resolveOrAdoptSlackThreadRoute(input: {
    appId: string
    chatId: string
    threadTs: string
    defaultRepoPath: string
    adoptedFromTs: string
    lastActivityMs?: number
  }): {
    chatId: string
    threadTs: string
    repoPath: string
    adoptedFromTs: string
    lastActivityMs: number
  } {
    const appId = requireSlackAppId(input.appId)
    const chatId = requireText(input.chatId, 'chatId').toUpperCase()
    const threadTs = requireText(input.threadTs, 'threadTs')
    const defaultRepoPath = requireText(input.defaultRepoPath, 'defaultRepoPath')
    const adoptedFromTs = requireText(input.adoptedFromTs, 'adoptedFromTs')
    const lastActivityMs = input.lastActivityMs ?? Date.now()
    if (!Number.isSafeInteger(lastActivityMs) || lastActivityMs <= 0) {
      throw new Error('thread activity timestamp is invalid')
    }

    const select = this.db.transaction(() => {
      const existing = this.db.query<{
        chat_id: string
        thread_ts: string
        repo_path: string
        adopted_from_ts: string
        last_activity_ms: number
      }, [string, string]>(
        'SELECT * FROM slack_threads WHERE chat_id = ? AND thread_ts = ?',
      ).get(chatId, threadTs)
      if (existing) {
        return {
          chatId: existing.chat_id,
          threadTs: existing.thread_ts,
          repoPath: existing.repo_path,
          adoptedFromTs: existing.adopted_from_ts,
          lastActivityMs: existing.last_activity_ms,
        }
      }

      let repoPath = defaultRepoPath
      if (/^[CG][A-Z0-9]+$/.test(chatId)) {
        const explicit = this.db.query<{ repo_path: string }, [string, string]>(
          `SELECT repo_path FROM slack_channel_routes
           WHERE app_id = ? AND channel_id = ?`,
        ).get(appId, chatId)
        if (explicit) {
          repoPath = explicit.repo_path
        } else {
          const explicitMode = this.db.query<{ present: number }, [string]>(
            'SELECT 1 AS present FROM slack_channel_route_state WHERE app_id = ?',
          ).get(appId) !== null
          if (explicitMode) throw new SlackChannelRouteRequiredError(chatId)
        }
      } else if (!/^D[A-Z0-9]+$/.test(chatId)) {
        throw new Error(`invalid Slack conversation ID: ${chatId}`)
      }

      this.db.run(
        `INSERT OR IGNORE INTO slack_threads (
           chat_id, thread_ts, repo_path, adopted_from_ts, last_activity_ms
         ) VALUES (?, ?, ?, ?, ?)`,
        [chatId, threadTs, repoPath, adoptedFromTs, lastActivityMs],
      )
      const pinned = this.db.query<{
        chat_id: string
        thread_ts: string
        repo_path: string
        adopted_from_ts: string
        last_activity_ms: number
      }, [string, string]>(
        'SELECT * FROM slack_threads WHERE chat_id = ? AND thread_ts = ?',
      ).get(chatId, threadTs)
      if (!pinned) throw new Error('failed to pin Slack thread repository')
      return {
        chatId: pinned.chat_id,
        threadTs: pinned.thread_ts,
        repoPath: pinned.repo_path,
        adoptedFromTs: pinned.adopted_from_ts,
        lastActivityMs: pinned.last_activity_ms,
      }
    })
    return retrySqlite(() => select.immediate())
  }

  /** Resolve the current route without claiming the Slack thread. */
  resolveSlackThreadRoute(input: {
    appId: string
    chatId: string
    threadTs: string
    defaultRepoPath: string
  }): { repoPath: string; owned: boolean } {
    const appId = requireSlackAppId(input.appId)
    const chatId = requireText(input.chatId, 'chatId').toUpperCase()
    const threadTs = requireText(input.threadTs, 'threadTs')
    const defaultRepoPath = requireText(input.defaultRepoPath, 'defaultRepoPath')
    const existing = retrySqlite(() => this.db.query<{ repo_path: string }, [string, string]>(
      'SELECT repo_path FROM slack_threads WHERE chat_id = ? AND thread_ts = ?',
    ).get(chatId, threadTs))
    if (existing) return { repoPath: existing.repo_path, owned: true }
    if (/^[CG][A-Z0-9]+$/.test(chatId)) {
      const explicit = retrySqlite(() => this.db.query<{ repo_path: string }, [string, string]>(
        `SELECT repo_path FROM slack_channel_routes
         WHERE app_id = ? AND channel_id = ?`,
      ).get(appId, chatId))
      if (explicit) return { repoPath: explicit.repo_path, owned: false }
      const explicitMode = retrySqlite(() => this.db.query<{ present: number }, [string]>(
        'SELECT 1 AS present FROM slack_channel_route_state WHERE app_id = ?',
      ).get(appId)) !== null
      if (explicitMode) throw new SlackChannelRouteRequiredError(chatId)
      return { repoPath: defaultRepoPath, owned: false }
    }
    if (/^D[A-Z0-9]+$/.test(chatId)) return { repoPath: defaultRepoPath, owned: false }
    throw new Error(`invalid Slack conversation ID: ${chatId}`)
  }

  recordDeliveryTombstone(idempotencyKey: string, completedAt = Date.now()): void {
    const key = requireText(idempotencyKey, 'idempotencyKey')
    if (!Number.isSafeInteger(completedAt) || completedAt <= 0) {
      throw new Error('delivery tombstone timestamp is invalid')
    }
    retrySqlite(() => this.db.run(
      `INSERT OR IGNORE INTO delivery_tombstones (
         idempotency_key, write_enabled, completed_at
       ) VALUES (?, 0, ?)`,
      [key, completedAt],
    ))
  }

  stageInboundDelivery(input: InboundDeliveryInput): boolean {
    return this.stageInboundDeliveryInternal(input, null, false) === 'staged'
  }

  /**
   * Claim a previously unowned Slack thread and persist its first inbound row
   * in one IMMEDIATE transaction. The first eligible child mention alone gets
   * a pending initial-context hydration; concurrent later mentions see the
   * owned thread and retain ordinary FIFO semantics.
   */
  stageInboundDeliveryAndAdoptSlackThread(
    input: InboundDeliveryInput,
    options: {
      initialContextEligible: boolean
      appId?: string
      expectedRepoPath?: string | null
      lastActivityMs?: number
    },
  ): {
    outcome: 'staged' | 'duplicate'
    repoPath: string
    initialContextRequired: boolean
  } {
    const chatId = requireText(input.chatId, 'chatId').toUpperCase()
    const threadTs = requireText(input.threadTs, 'threadTs')
    const messageId = requireText(input.messageId, 'messageId')
    const userId = requireText(input.userId, 'userId')
    const candidateRepoPath = requireText(input.repoPath, 'repoPath')
    const fileIds = [...new Set(
      (input.fileIds ?? []).map(id => requireText(id, 'fileId')),
    )]
    const idempotencyKey = `${chatId}:${messageId}`
    const lastActivityMs = options.lastActivityMs ?? Date.now()
    if (!Number.isSafeInteger(lastActivityMs) || lastActivityMs <= 0) {
      throw new Error('thread activity timestamp is invalid')
    }

    const stage = this.db.transaction(() => {
      const existingThread = this.db.query<{ repo_path: string }, [string, string]>(
        'SELECT repo_path FROM slack_threads WHERE chat_id = ? AND thread_ts = ?',
      ).get(chatId, threadTs)
      let repoPath = existingThread?.repo_path ?? candidateRepoPath
      if (!existingThread && /^[CG][A-Z0-9]+$/.test(chatId)) {
        const appId = requireSlackAppId(options.appId ?? '')
        const explicit = this.db.query<{ repo_path: string }, [string, string]>(
          `SELECT repo_path FROM slack_channel_routes
           WHERE app_id = ? AND channel_id = ?`,
        ).get(appId, chatId)
        if (explicit) {
          repoPath = explicit.repo_path
        } else {
          const explicitMode = this.db.query<{ present: number }, [string]>(
            'SELECT 1 AS present FROM slack_channel_route_state WHERE app_id = ?',
          ).get(appId) !== null
          if (explicitMode) throw new SlackChannelRouteRequiredError(chatId)
        }
      } else if (!existingThread && !/^D[A-Z0-9]+$/.test(chatId)) {
        throw new Error(`invalid Slack conversation ID: ${chatId}`)
      }
      if (options.expectedRepoPath !== undefined) {
        if (options.expectedRepoPath === null
          || repoPath !== requireText(options.expectedRepoPath, 'expectedRepoPath')) {
          throw new SlackChannelRouteChangedError(chatId)
        }
      }
      const retained = this.db.query<{ present: number }, [string]>(
        'SELECT 1 AS present FROM delivery_tombstones WHERE idempotency_key = ?',
      ).get(idempotencyKey)
      const completedHandoff = this.db.query<{ present: number }, [string, string, string, string]>(
        `SELECT 1 AS present FROM jobs WHERE idempotency_key = ?
         UNION ALL SELECT 1 FROM job_controls WHERE idempotency_key = ?
         UNION ALL SELECT 1 FROM job_interjections WHERE idempotency_key = ?
         UNION ALL SELECT 1 FROM update_request_ledger WHERE idempotency_key = ?
         LIMIT 1`,
      ).get(idempotencyKey, idempotencyKey, idempotencyKey, idempotencyKey)
      if (retained || completedHandoff) {
        return { outcome: 'duplicate' as const, repoPath, initialContextRequired: false }
      }

      const pendingBootstrap = !existingThread
        ? this.db.query<{ present: number }, [string, string]>(
            `SELECT 1 AS present FROM inbound_deliveries
             WHERE chat_id = ? AND thread_ts = ? AND initial_context_state = 'pending'
             LIMIT 1`,
          ).get(chatId, threadTs) !== null
        : false
      const initialContextRequired = !existingThread
        && !pendingBootstrap
        && options.initialContextEligible
        && /^[CG][A-Z0-9]+$/.test(chatId)
        && threadTs !== messageId
        && !input.isInterrupt
      const inserted = this.db.run(
        `INSERT OR IGNORE INTO inbound_deliveries (
           idempotency_key, chat_id, thread_ts, message_id, user_id,
           repo_path, text, file_ids_json, write_enabled, is_interrupt, created_at,
           initial_context_state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          idempotencyKey,
          chatId,
          threadTs,
          messageId,
          userId,
          repoPath,
          input.text,
          JSON.stringify(fileIds),
          input.writeEnabled ? 1 : 0,
          input.isInterrupt ? 1 : 0,
          Date.now(),
          initialContextRequired ? 'pending' : 'none',
        ],
      ).changes
      if (inserted !== 1) {
        return { outcome: 'duplicate' as const, repoPath, initialContextRequired: false }
      }
      // A bootstrap candidate is only a pending claim. Publishing ordinary
      // thread ownership before its bounded root→mention snapshot succeeds
      // would let catch-up reinterpret failed context posts as new jobs.
      if (!existingThread && !initialContextRequired && !pendingBootstrap) {
        this.db.run(
          `INSERT INTO slack_threads (
             chat_id, thread_ts, repo_path, adopted_from_ts, last_activity_ms
           ) VALUES (?, ?, ?, ?, ?)`,
          [chatId, threadTs, repoPath, messageId, lastActivityMs],
        )
      }
      return { outcome: 'staged' as const, repoPath, initialContextRequired }
    })
    return retrySqlite(() => stage.immediate())
  }

  /**
   * Bind a delivery admitted through active-thread authority to the exact job
   * and epoch observed by the gateway. If that authority has already closed,
   * callers that relied on it get a durable tombstone instead of accidentally
   * turning the reply into a new FIFO job.
   */
  stageInboundDeliveryForControl(
    input: InboundDeliveryInput,
    expected: LiveControlTarget,
  ): 'bound' | 'staged' | 'duplicate' | 'authority-closed' {
    return this.stageInboundDeliveryInternal(input, expected, true)
  }

  private stageInboundDeliveryInternal(
    input: InboundDeliveryInput,
    expected: LiveControlTarget | null,
    authorityRequired: boolean,
  ): 'bound' | 'staged' | 'duplicate' | 'authority-closed' {
    const chatId = requireText(input.chatId, 'chatId')
    const messageId = requireText(input.messageId, 'messageId')
    const fileIds = (input.fileIds ?? []).map(id => requireText(id, 'fileId'))
    const idempotencyKey = `${chatId}:${messageId}`
    const expectedJobId = expected ? requireText(expected.jobId, 'expected control jobId') : null
    const expectedEpoch = expected ? Math.floor(expected.epoch) : null
    if (expectedEpoch !== null && (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1)) {
      throw new Error('expected control epoch is invalid')
    }
    const stage = this.db.transaction(() => {
      const retained = this.db.query<{ present: number }, [string]>(
        'SELECT 1 AS present FROM delivery_tombstones WHERE idempotency_key = ?',
      ).get(idempotencyKey)
      if (retained) return 'duplicate' as const
      const completedHandoff = this.db.query<{ present: number }, [string, string, string]>(
        `SELECT 1 AS present FROM jobs WHERE idempotency_key = ?
         UNION ALL SELECT 1 FROM job_controls WHERE idempotency_key = ?
         UNION ALL SELECT 1 FROM job_interjections WHERE idempotency_key = ?
         LIMIT 1`,
      ).get(idempotencyKey, idempotencyKey, idempotencyKey)
      if (completedHandoff) return 'duplicate' as const

      let boundJobId: string | null = null
      let boundEpoch: number | null = null
      if (expectedJobId !== null && expectedEpoch !== null) {
        const target = this.db.query<{ present: number }, [string, number, string, string, number]>(
          `SELECT 1 AS present FROM jobs
           WHERE id = ? AND control_epoch = ? AND runtime = 'codex'
             AND chat_id = ? AND thread_ts = ?
             AND status IN ('running', 'queued')
             AND cancel_requested_at IS NULL
             AND (? = 1 OR accepts_control = 1)`,
        ).get(
          expectedJobId,
          expectedEpoch,
          chatId,
          requireText(input.threadTs, 'threadTs'),
          input.isInterrupt ? 1 : 0,
        )
        if (target) {
          boundJobId = expectedJobId
          boundEpoch = expectedEpoch
        } else if (authorityRequired) {
          this.db.run(
            `INSERT INTO delivery_tombstones (idempotency_key, write_enabled, completed_at)
             VALUES (?, ?, ?)
             ON CONFLICT(idempotency_key) DO UPDATE SET
               write_enabled = MAX(write_enabled, excluded.write_enabled),
               completed_at = MAX(completed_at, excluded.completed_at)`,
            [idempotencyKey, input.writeEnabled ? 1 : 0, Date.now()],
          )
          return 'authority-closed' as const
        }
      }

      const inserted = this.db.run(
        `INSERT OR IGNORE INTO inbound_deliveries (
           idempotency_key, chat_id, thread_ts, message_id, user_id,
           repo_path, text, file_ids_json, write_enabled, is_interrupt, created_at,
           expected_control_job_id, expected_control_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.isInterrupt ? 1 : 0,
          Date.now(),
          boundJobId,
          boundEpoch,
        ],
      ).changes
      if (inserted !== 1) return 'duplicate' as const
      return boundJobId === null ? 'staged' as const : 'bound' as const
    })
    return retrySqlite(() => stage.immediate())
  }

  hasDurableEvent(idempotencyKey: string): boolean {
    const key = requireText(idempotencyKey, 'idempotencyKey')
    return retrySqlite(() => this.db.query<
      { present: number }, [string, string, string, string, string, string]
    >(
      `SELECT 1 AS present FROM inbound_deliveries WHERE idempotency_key = ?
       UNION ALL SELECT 1 FROM jobs WHERE idempotency_key = ?
       UNION ALL SELECT 1 FROM job_controls WHERE idempotency_key = ?
       UNION ALL SELECT 1 FROM job_interjections WHERE idempotency_key = ?
       UNION ALL SELECT 1 FROM delivery_tombstones WHERE idempotency_key = ?
       UNION ALL SELECT 1 FROM update_request_ledger WHERE idempotency_key = ?
       LIMIT 1`,
    ).get(key, key, key, key, key, key) !== null)
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
        const durable = this.db.query<
          { present: number }, [string, string, string, string, string, string]
        >(
          `SELECT 1 AS present FROM inbound_deliveries WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM jobs WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM job_controls WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM job_interjections WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM delivery_tombstones WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM update_request_ledger WHERE idempotency_key = ?
           LIMIT 1`,
        ).get(eventKey, eventKey, eventKey, eventKey, eventKey, eventKey)
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

  listPendingDirectMessageChannels(appIdInput?: string, now = Date.now()): string[] {
    if (appIdInput === undefined) {
      return retrySqlite(() => this.db.query<{ channel_id: string }, []>(
        'SELECT channel_id FROM slack_pending_dm_channels ORDER BY channel_id',
      ).all().map(row => row.channel_id))
    }
    const appId = requireSlackAppId(appIdInput)
    return retrySqlite(() => this.db.query<{ channel_id: string }, [string, number]>(
      `SELECT pending.channel_id
       FROM slack_pending_dm_channels AS pending
       WHERE NOT EXISTS (
         SELECT 1 FROM slack_dm_history_retries AS retry
         WHERE retry.app_id = ?
           AND retry.channel_id = pending.channel_id
           AND retry.next_attempt_at > ?
       )
       ORDER BY pending.channel_id`,
    ).all(appId, now).map(row => row.channel_id))
  }

  recordSlackDirectMessageHistoryFailure(
    appIdInput: string,
    channelIdInput: string,
    now = Date.now(),
  ): { firstFailure: boolean; failureCount: number; nextAttemptAt: number } {
    const appId = requireSlackAppId(appIdInput)
    const channelId = requireSlackDirectMessageId(channelIdInput)
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid retry timestamp')
    const record = this.db.transaction(() => {
      const existing = this.db.query<{
        failure_count: number
        next_attempt_at: number
      }, [string, string]>(
        `SELECT failure_count, next_attempt_at FROM slack_dm_history_retries
         WHERE app_id = ? AND channel_id = ?`,
      ).get(appId, channelId)
      // catch-up and owned-thread polling may have the same request in flight.
      // One observed outage must create one schedule, not advance once per caller.
      if (existing && existing.next_attempt_at > now) {
        return {
          firstFailure: false,
          failureCount: existing.failure_count,
          nextAttemptAt: existing.next_attempt_at,
        }
      }
      const failureCount = Math.min((existing?.failure_count ?? 0) + 1, 31)
      const delay = Math.min(
        SLACK_DM_HISTORY_RETRY_BASE_MS * (2 ** Math.min(failureCount - 1, 3)),
        SLACK_DM_HISTORY_RETRY_MAX_MS,
      )
      const nextAttemptAt = now + delay
      this.db.run(
        `INSERT INTO slack_dm_history_retries (
           app_id, channel_id, failure_count, error_code, next_attempt_at, updated_at
         ) VALUES (?, ?, ?, 'channel_not_found', ?, ?)
         ON CONFLICT(app_id, channel_id) DO UPDATE SET
           failure_count = excluded.failure_count,
           error_code = excluded.error_code,
           next_attempt_at = excluded.next_attempt_at,
           updated_at = excluded.updated_at`,
        [appId, channelId, failureCount, nextAttemptAt, now],
      )
      return {
        firstFailure: existing === null,
        failureCount,
        nextAttemptAt,
      }
    })
    return retrySqlite(() => record.immediate())
  }

  clearSlackDirectMessageHistoryFailure(appIdInput: string, channelIdInput: string): boolean {
    const appId = requireSlackAppId(appIdInput)
    const channelId = requireSlackDirectMessageId(channelIdInput)
    return retrySqlite(() => this.db.run(
      'DELETE FROM slack_dm_history_retries WHERE app_id = ? AND channel_id = ?',
      [appId, channelId],
    ).changes === 1)
  }

  slackDirectMessageHistoryIsDeferred(
    appIdInput: string,
    channelIdInput: string,
    now = Date.now(),
  ): boolean {
    const appId = requireSlackAppId(appIdInput)
    const channelId = requireSlackDirectMessageId(channelIdInput)
    return retrySqlite(() => this.db.query<{ present: number }, [string, string, number]>(
      `SELECT 1 AS present FROM slack_dm_history_retries
       WHERE app_id = ? AND channel_id = ? AND next_attempt_at > ?`,
    ).get(appId, channelId, now) !== null)
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

  listDueSlackReplyScans(appIdInput: string, limit = 20, now = Date.now()): SlackReplyScan[] {
    const appId = requireSlackAppId(appIdInput)
    const bounded = positiveInteger(limit, 20)
    return retrySqlite(() => this.db.query<{
      scan_key: string
      channel_id: string
      thread_ts: string
      oldest_ts: string
      cursor: string | null
    }, [string, number, number]>(
      `SELECT scan.scan_key, scan.channel_id, scan.thread_ts, scan.oldest_ts, scan.cursor
       FROM slack_reply_scans AS scan
       WHERE substr(scan.channel_id, 1, 1) <> 'D'
          OR NOT EXISTS (
            SELECT 1 FROM slack_dm_history_retries AS retry
            WHERE retry.app_id = ?
              AND retry.channel_id = scan.channel_id
              AND retry.next_attempt_at > ?
          )
       ORDER BY scan.updated_at, scan.scan_key LIMIT ?`,
    ).all(appId, now, bounded).map(row => ({
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
        if (!this.db.query<
          { present: number }, [string, string, string, string, string, string]
        >(
          `SELECT 1 AS present FROM inbound_deliveries WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM jobs WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM job_controls WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM job_interjections WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM delivery_tombstones WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM update_request_ledger WHERE idempotency_key = ?
           LIMIT 1`,
        ).get(eventKey, eventKey, eventKey, eventKey, eventKey, eventKey)) return false
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
      // Keep unrelated threads FIFO, but do not let an attachment retry in a
      // different thread freeze an active conversation. Ordinary messages
      // retain their order inside one thread; an exact interrupt may overtake
      // them because its only effect is to stop the active job safely.
      const priority = this.db.query<InboundDeliveryRow, [number]>(
        `SELECT inbound.*
         FROM inbound_deliveries AS inbound
         WHERE inbound.status = 'pending'
           AND (inbound.not_before IS NULL OR inbound.not_before <= ?)
           AND EXISTS (
             SELECT 1 FROM jobs
             WHERE jobs.runtime = 'codex'
               AND jobs.chat_id = inbound.chat_id
               AND jobs.thread_ts = inbound.thread_ts
               AND jobs.status IN ('running', 'queued')
               AND jobs.control_epoch > 0
               AND jobs.cancel_requested_at IS NULL
               AND (inbound.is_interrupt = 1 OR jobs.accepts_control = 1)
               AND (inbound.expected_control_job_id IS NULL
                 OR (jobs.id = inbound.expected_control_job_id
                   AND jobs.control_epoch = inbound.expected_control_epoch))
           )
           AND (
             inbound.is_interrupt = 1
             OR NOT EXISTS (
               SELECT 1 FROM inbound_deliveries AS earlier
               WHERE earlier.chat_id = inbound.chat_id
                 AND earlier.thread_ts = inbound.thread_ts
                 AND earlier.seq < inbound.seq
             )
           )
         ORDER BY inbound.is_interrupt DESC, inbound.seq ASC
         LIMIT 1`,
      ).get(now)
      const row = priority ?? this.db.query<InboundDeliveryRow, []>(
        `SELECT * FROM inbound_deliveries ORDER BY seq ASC LIMIT 1`,
      ).get()
      if (!row || (row.not_before !== null && row.not_before > now)) return null
      const updated = this.db.run(
        `UPDATE inbound_deliveries SET status = 'processing'
         WHERE seq = ? AND status = 'pending'`,
        [row.seq],
      )
      if (updated.changes !== 1) return null
      return mapInboundDeliveryRow(row)
    })
    return retrySqlite(() => claim.immediate())
  }

  /**
   * Publish a pending thread adoption only after Slack chronology has selected
   * the canonical first mention. The claimed row is rebased to that event,
   * context posts are tombstoned, and any later replies are staged in order in
   * the same transaction. A root that already addressed the App uses `none`
   * and is restored as an ordinary independent request instead of being merged.
   */
  finalizeInboundThreadBootstrap(
    idempotencyKey: string,
    input: {
      mode: 'context' | 'independent'
      canonical: InboundBootstrapEvent
      text: string
      fileIds: string[]
      consumedMessageTs: string[]
      followups: InboundBootstrapEvent[]
      lastActivityMs?: number
    },
  ): InboundDeliveryRecord {
    const key = requireText(idempotencyKey, 'idempotencyKey')
    if (typeof input.text !== 'string') throw new Error('initial context text is invalid')
    const text = input.text
    const fileIds = [...new Set(input.fileIds.map(id => requireText(id, 'fileId')))]
    if (fileIds.some(id => !/^F[A-Z0-9]+$/.test(id))) {
      throw new Error('initial context has an invalid Slack file ID')
    }
    const consumedMessageTs = [...new Set(
      input.consumedMessageTs.map(ts => requireText(ts, 'consumed message ts')),
    )]
    if (consumedMessageTs.some(ts => !/^\d+\.\d+$/.test(ts))) {
      throw new Error('initial context has an invalid Slack message timestamp')
    }

    const normalizeEvent = (event: InboundBootstrapEvent): InboundBootstrapEvent => {
      const messageId = requireText(event.messageId, 'bootstrap messageId')
      if (!/^\d+\.\d+$/.test(messageId)) throw new Error('bootstrap message timestamp is invalid')
      const eventFileIds = [...new Set(event.fileIds.map(id => requireText(id, 'fileId')))]
      if (eventFileIds.some(id => !/^F[A-Z0-9]+$/.test(id))) {
        throw new Error('bootstrap event has an invalid Slack file ID')
      }
      if (typeof event.text !== 'string') throw new Error('bootstrap event text is invalid')
      return {
        messageId,
        userId: requireText(event.userId, 'bootstrap userId'),
        text: event.text,
        fileIds: eventFileIds,
        writeEnabled: Boolean(event.writeEnabled),
        isInterrupt: Boolean(event.isInterrupt),
      }
    }
    const canonical = normalizeEvent(input.canonical)
    const followups = input.followups.map(normalizeEvent)
    const lastActivityMs = input.lastActivityMs ?? Date.now()
    if (!Number.isSafeInteger(lastActivityMs) || lastActivityMs <= 0) {
      throw new Error('thread activity timestamp is invalid')
    }

    const hydrate = this.db.transaction(() => {
      const row = this.db.query<InboundDeliveryRow, [string]>(
        `SELECT * FROM inbound_deliveries
         WHERE idempotency_key = ? AND status = 'processing'`,
      ).get(key)
      if (!row) throw new Error(`inbound delivery is no longer processing: ${key}`)
      if (row.initial_context_state === 'hydrated') return mapInboundDeliveryRow(row)
      if (row.initial_context_state !== 'pending') {
        throw new Error(`inbound delivery does not require initial context: ${key}`)
      }

      const canonicalNumber = Number(canonical.messageId)
      const originalNumber = Number(row.message_id)
      const threadNumber = Number(row.thread_ts)
      if (canonicalNumber < threadNumber || canonicalNumber > originalNumber) {
        throw new Error('canonical bootstrap event is outside the observed thread range')
      }
      let previous = canonicalNumber
      const replayKeys = new Set<string>()
      for (const followup of followups) {
        const timestamp = Number(followup.messageId)
        if (timestamp <= previous || timestamp > originalNumber) {
          throw new Error('bootstrap followups are not in strict Slack order')
        }
        previous = timestamp
        const followupKey = `${row.chat_id}:${followup.messageId}`
        if (replayKeys.has(followupKey)) throw new Error('bootstrap followup is duplicated')
        replayKeys.add(followupKey)
      }

      const completedOutsideInbound = (eventKey: string): boolean => (
        this.db.query<{ present: number }, [string, string, string, string, string]>(
          `SELECT 1 AS present FROM delivery_tombstones WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM jobs WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM job_controls WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM job_interjections WHERE idempotency_key = ?
           UNION ALL SELECT 1 FROM update_request_ledger WHERE idempotency_key = ?
           LIMIT 1`,
        ).get(eventKey, eventKey, eventKey, eventKey, eventKey) !== null
      )

      const canonicalKey = `${row.chat_id}:${canonical.messageId}`
      if (canonicalKey !== key) {
        if (completedOutsideInbound(canonicalKey)) {
          throw new InboundInitialContextConflictError(
            `Slackスレッドの最初の依頼 ${canonical.messageId} はすでに別の処理へ渡されています`,
          )
        }
        const canonicalInbound = this.db.query<
          { status: 'pending' | 'processing' }, [string]
        >(
          'SELECT status FROM inbound_deliveries WHERE idempotency_key = ?',
        ).get(canonicalKey)
        if (canonicalInbound?.status === 'processing') {
          throw new InboundInitialContextConflictError(
            `Slackスレッドの最初の依頼 ${canonical.messageId} はすでに処理中です`,
          )
        }
        if (canonicalInbound) {
          this.db.run(
            `DELETE FROM inbound_deliveries
             WHERE idempotency_key = ? AND status = 'pending'`,
            [canonicalKey],
          )
        }
      }

      for (const messageTs of consumedMessageTs) {
        const consumedKey = `${row.chat_id}:${messageTs}`
        if (consumedKey === key || consumedKey === canonicalKey) {
          throw new Error('initial context cannot consume its canonical trigger')
        }
        if (replayKeys.has(consumedKey)) {
          throw new Error('initial context cannot both consume and replay a message')
        }
        if (completedOutsideInbound(consumedKey)) {
          throw new InboundInitialContextConflictError(
            `Slackスレッドの投稿 ${messageTs} はすでに別の処理へ渡されています`,
          )
        }
        const otherInbound = this.db.query<
          { status: 'pending' | 'processing' }, [string]
        >(
          'SELECT status FROM inbound_deliveries WHERE idempotency_key = ?',
        ).get(consumedKey)
        if (otherInbound?.status === 'processing') {
          throw new InboundInitialContextConflictError(
            `Slackスレッドの投稿 ${messageTs} はすでに処理中です`,
          )
        }
        if (otherInbound) {
          this.db.run(
            `DELETE FROM inbound_deliveries
             WHERE idempotency_key = ? AND status = 'pending'`,
            [consumedKey],
          )
        }
        this.db.run(
          `INSERT INTO delivery_tombstones (
             idempotency_key, write_enabled, completed_at
           ) VALUES (?, 0, ?)
           ON CONFLICT(idempotency_key) DO NOTHING`,
          [consumedKey, Date.now()],
        )
      }

      const updated = this.db.run(
        `UPDATE inbound_deliveries
         SET idempotency_key = ?, message_id = ?, user_id = ?, text = ?,
             file_ids_json = ?, write_enabled = ?, is_interrupt = ?,
             downloaded_files_json = '[]', not_before = NULL, last_error = NULL,
             initial_context_state = ?
         WHERE idempotency_key = ? AND status = 'processing'
           AND initial_context_state = 'pending'`,
        [
          canonicalKey,
          canonical.messageId,
          canonical.userId,
          text,
          JSON.stringify(fileIds),
          canonical.writeEnabled ? 1 : 0,
          canonical.isInterrupt ? 1 : 0,
          input.mode === 'context' ? 'hydrated' : 'none',
          key,
        ],
      )
      if (updated.changes !== 1) {
        throw new Error(`initial context state changed while hydrating: ${key}`)
      }

      for (const followup of followups) {
        const followupKey = `${row.chat_id}:${followup.messageId}`
        if (completedOutsideInbound(followupKey)) continue
        const existing = this.db.query<
          { status: 'pending' | 'processing' }, [string]
        >(
          'SELECT status FROM inbound_deliveries WHERE idempotency_key = ?',
        ).get(followupKey)
        if (existing?.status === 'processing') {
          throw new InboundInitialContextConflictError(
            `Slackスレッドの返信 ${followup.messageId} はすでに処理中です`,
          )
        }
        if (existing) {
          this.db.run(
            `DELETE FROM inbound_deliveries
             WHERE idempotency_key = ? AND status = 'pending'`,
            [followupKey],
          )
        }
        this.db.run(
          `INSERT INTO inbound_deliveries (
             idempotency_key, chat_id, thread_ts, message_id, user_id,
             repo_path, text, file_ids_json, write_enabled, is_interrupt,
             status, attempts, created_at, initial_context_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 'none')`,
          [
            followupKey,
            row.chat_id,
            row.thread_ts,
            followup.messageId,
            followup.userId,
            row.repo_path,
            followup.text,
            JSON.stringify(followup.fileIds),
            followup.writeEnabled ? 1 : 0,
            followup.isInterrupt ? 1 : 0,
            Date.now(),
          ],
        )
      }

      const existingThread = this.db.query<{ repo_path: string }, [string, string]>(
        'SELECT repo_path FROM slack_threads WHERE chat_id = ? AND thread_ts = ?',
      ).get(row.chat_id, row.thread_ts)
      if (existingThread && existingThread.repo_path !== row.repo_path) {
        throw new InboundInitialContextConflictError(
          'Slackスレッドのprojectが初期文脈の確定中に変更されました',
        )
      }
      this.db.run(
        `INSERT INTO slack_threads (
           chat_id, thread_ts, repo_path, adopted_from_ts, last_activity_ms
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, thread_ts) DO UPDATE SET
           last_activity_ms = MAX(last_activity_ms, excluded.last_activity_ms)`,
        [row.chat_id, row.thread_ts, row.repo_path, canonical.messageId, lastActivityMs],
      )
      const hydrated = this.db.query<InboundDeliveryRow, [string]>(
        'SELECT * FROM inbound_deliveries WHERE idempotency_key = ?',
      ).get(canonicalKey)
      if (!hydrated) throw new Error(`hydrated inbound delivery disappeared: ${canonicalKey}`)
      return mapInboundDeliveryRow(hydrated)
    })
    return retrySqlite(() => hydrate.immediate())
  }

  deferInboundDelivery(idempotencyKey: string, error: string, notBefore: number): void {
    retrySqlite(() => this.db.run(
      `UPDATE inbound_deliveries
       SET status = 'pending', attempts = attempts + 1, not_before = ?, last_error = ?
       WHERE idempotency_key = ? AND status = 'processing'`,
      [notBefore, error, requireText(idempotencyKey, 'idempotencyKey')],
    ))
  }

  /** Backpressure is not a failed attempt; retain the same retry budget. */
  deferInboundDeliveryWithoutAttempt(
    idempotencyKey: string,
    error: string,
    notBefore: number,
  ): void {
    retrySqlite(() => this.db.run(
      `UPDATE inbound_deliveries
       SET status = 'pending', not_before = ?, last_error = ?
       WHERE idempotency_key = ? AND status = 'processing'`,
      [notBefore, error, requireText(idempotencyKey, 'idempotencyKey')],
    ))
  }

  /** Yield an in-flight attachment transfer to higher-priority live control. */
  releaseInboundDelivery(idempotencyKey: string): boolean {
    return retrySqlite(() => this.db.run(
      `UPDATE inbound_deliveries SET status = 'pending'
       WHERE idempotency_key = ? AND status = 'processing'`,
      [requireText(idempotencyKey, 'idempotencyKey')],
    ).changes === 1)
  }

  recordInboundDownloadedFile(
    idempotencyKey: string,
    file: InboundDownloadedFile,
  ): void {
    const key = requireText(idempotencyKey, 'idempotencyKey')
    const fileId = requireText(file.fileId, 'downloaded fileId')
    const path = requireText(file.path, 'downloaded file path')
    const ordinal = Math.floor(file.ordinal)
    const size = Math.floor(file.size)
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new Error('downloaded file ordinal is invalid')
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > 50 * 1024 * 1024) {
      throw new Error('downloaded file size is invalid')
    }
    if (!/^[0-9a-f]{64}$/.test(file.digest)) {
      throw new Error('downloaded file digest is invalid')
    }
    const record = this.db.transaction(() => {
      const row = this.db.query<{
        file_ids_json: string
        downloaded_files_json: string
      }, [string]>(
        `SELECT file_ids_json, downloaded_files_json FROM inbound_deliveries
         WHERE idempotency_key = ? AND status = 'processing'`,
      ).get(key)
      if (!row) throw new Error(`inbound delivery is no longer processing: ${key}`)
      const fileIds = parseAttachments(row.file_ids_json)
      if (fileIds[ordinal] !== fileId) {
        throw new Error('downloaded file does not match its inbound ordinal')
      }
      const files = parseInboundDownloadedFiles(row.downloaded_files_json)
        .filter(existing => existing.fileId !== fileId && existing.ordinal !== ordinal)
      files.push({ fileId, ordinal, path, size, digest: file.digest })
      files.sort((left, right) => left.ordinal - right.ordinal)
      const updated = this.db.run(
        `UPDATE inbound_deliveries SET downloaded_files_json = ?
         WHERE idempotency_key = ? AND status = 'processing'`,
        [JSON.stringify(files), key],
      )
      if (updated.changes !== 1) {
        throw new Error(`inbound delivery changed while recording attachment: ${key}`)
      }
    })
    retrySqlite(() => record.immediate())
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
      // A failed pending bootstrap never owned the thread. Publishing it here
      // would let catch-up replay root/intervening context as independent jobs.
      if (row.initial_context_state !== 'pending') {
        this.db.run(
          `INSERT INTO slack_threads (
             chat_id, thread_ts, repo_path, adopted_from_ts, last_activity_ms
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(chat_id, thread_ts) DO UPDATE SET
             last_activity_ms = excluded.last_activity_ms`,
          [row.chat_id, row.thread_ts, row.repo_path, row.message_id, now],
        )
      }
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

  tombstoneInboundDelivery(
    idempotencyKey: string,
    status?: {
      kind: 'closed-control' | 'inactive-interrupt' | 'attachment-control-failed'
      payload: string
    },
  ): void {
    const key = requireText(idempotencyKey, 'idempotencyKey')
    const payload = status ? requireText(status.payload, 'status notification payload') : null
    const consume = this.db.transaction(() => {
      const inbound = this.db.query<{
        chat_id: string
        thread_ts: string
      }, [string]>(
        `SELECT chat_id, thread_ts FROM inbound_deliveries
         WHERE idempotency_key = ? AND status = 'processing'`,
      ).get(key)
      const inserted = this.db.run(
        `INSERT INTO delivery_tombstones (idempotency_key, write_enabled, completed_at)
         SELECT idempotency_key, write_enabled, ? FROM inbound_deliveries
         WHERE idempotency_key = ? AND status = 'processing'
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [Date.now(), key],
      )
      if (inserted.changes !== 1) {
        const retained = this.db.query<{ present: number }, [string]>(
          'SELECT 1 AS present FROM delivery_tombstones WHERE idempotency_key = ?',
        ).get(key)
        if (!retained) throw new Error(`inbound delivery is no longer processing: ${key}`)
      }
      if (status && payload && inbound) {
        this.stageStatusNotificationRow({
          idempotencyKey: `${status.kind}:${key}`,
          jobId: null,
          chatId: inbound.chat_id,
          threadTs: inbound.thread_ts,
          kind: status.kind,
          payload,
          createdAt: Date.now(),
        })
      }
      this.db.run('DELETE FROM inbound_deliveries WHERE idempotency_key = ?', [key])
    })
    retrySqlite(() => consume.immediate())
  }

  liveControlTarget(chatIdInput: string, threadTsInput: string): LiveControlTarget | null {
    const chatId = requireText(chatIdInput, 'chatId')
    const threadTs = requireText(threadTsInput, 'threadTs')
    const row = retrySqlite(() => this.db.query<{
      id: string
      control_epoch: number
      repo_path: string
      write_enabled: number
      ui_approval_request_id: string | null
    }, [string, string]>(
      `SELECT id, control_epoch, repo_path, write_enabled, ui_approval_request_id FROM jobs
       WHERE runtime = 'codex' AND chat_id = ? AND thread_ts = ?
         AND accepts_control = 1 AND control_epoch > 0
         AND status IN ('running', 'queued')
       ORDER BY CASE
         WHEN ui_approval_request_id IS NOT NULL THEN 0
         WHEN status = 'running' THEN 1
         ELSE 2
       END, seq ASC
       LIMIT 1`,
    ).get(chatId, threadTs))
    return row ? {
      jobId: row.id,
      epoch: row.control_epoch,
      repoPath: row.repo_path,
      writeEnabled: row.write_enabled === 1,
      ...(row.ui_approval_request_id !== null ? { awaitingUiApproval: true } : {}),
    } : null
  }

  /**
   * Exact Slack cancellation remains addressable after the App Server input
   * barrier has closed.  At that point ordinary steer is intentionally
   * rejected, but the logical job can still be waiting for owned advisor
   * cleanup. Keep this lookup separate so non-interrupt replies never
   * reopen a sealed App Server phase.
   */
  interruptControlTarget(chatIdInput: string, threadTsInput: string): LiveControlTarget | null {
    const chatId = requireText(chatIdInput, 'chatId')
    const threadTs = requireText(threadTsInput, 'threadTs')
    const row = retrySqlite(() => this.db.query<{
      id: string
      control_epoch: number
      repo_path: string
      write_enabled: number
      ui_approval_request_id: string | null
    }, [string, string]>(
      `SELECT id, control_epoch, repo_path, write_enabled, ui_approval_request_id FROM jobs
       WHERE runtime = 'codex' AND chat_id = ? AND thread_ts = ?
         AND control_epoch > 0 AND cancel_requested_at IS NULL
         AND status IN ('running', 'queued')
       ORDER BY CASE
         WHEN ui_approval_request_id IS NOT NULL THEN 0
         WHEN status = 'running' THEN 1
         ELSE 2
       END, seq ASC
       LIMIT 1`,
    ).get(chatId, threadTs))
    return row ? {
      jobId: row.id,
      epoch: row.control_epoch,
      repoPath: row.repo_path,
      writeEnabled: row.write_enabled === 1,
      ...(row.ui_approval_request_id !== null ? { awaitingUiApproval: true } : {}),
    } : null
  }

  stageLiveControl(
    expected: LiveControlTarget,
    input: LiveControlInput,
  ): 'staged' | 'duplicate' | 'closed' {
    const jobId = requireText(expected.jobId, 'jobId')
    const epoch = Math.floor(expected.epoch)
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('control epoch is invalid')
    const chatId = requireText(input.chatId, 'chatId')
    const threadTs = requireText(input.threadTs, 'threadTs')
    const messageId = requireText(input.messageId, 'messageId')
    const userId = requireText(input.userId, 'userId')
    const task = requireText(input.task, 'task')
    const attachments = (input.attachments ?? []).map(path => requireText(path, 'attachment'))
    const key = `${chatId}:${messageId}`
    const stage = this.db.transaction((): 'staged' | 'duplicate' | 'closed' => {
      // The same Slack delivery can be observed again after the inbound row
      // was handed off to `jobs` but before that row was deleted. Never let
      // the already-running root request re-enter its own thread as a steer.
      if (this.db.query<{ present: number }, [string, string, string]>(
        `SELECT 1 AS present FROM job_controls WHERE idempotency_key = ?
         UNION ALL SELECT 1 FROM job_interjections WHERE idempotency_key = ?
         UNION ALL SELECT 1 FROM jobs WHERE idempotency_key = ?
         LIMIT 1`,
      ).get(key, key, key)) return 'duplicate'
      const target = this.db.query<{
        accepts_control: number
        control_epoch: number
        input_revision: number
        chat_id: string
        thread_ts: string
        status: JobStatus
        started_at: number | null
        monitor_state: number
        repo_path: string
        write_enabled: number
        cancel_requested_at: number | null
        ui_approval_request_id: string | null
      }, [string]>(
        `SELECT accepts_control, control_epoch, input_revision, chat_id, thread_ts, status, started_at,
                monitor_state, repo_path, write_enabled, cancel_requested_at,
                ui_approval_request_id
         FROM jobs WHERE id = ? AND runtime = 'codex'`,
      ).get(jobId)
      if (!target || target.control_epoch !== epoch
        || target.chat_id !== chatId || target.thread_ts !== threadTs
        || !(target.status === 'running' || target.status === 'queued')
        || (input.kind === 'steer' && target.accepts_control !== 1)
        || (input.kind === 'interrupt' && target.cancel_requested_at !== null)) return 'closed'
      const now = Date.now()
      let inputRevision = target.input_revision
      if (input.kind === 'interrupt') {
        // An exact interrupt is allowed to overtake ordinary inbound replies.
        // The active thread itself delegates control, so retire only older
        // ordinary replies that were durably bound to this exact job/epoch.
        // Unbound post-seal input and input bound to a later queued job are
        // independent FIFO work and must survive cancellation of this job.
        const interruptInbound = this.db.query<{ seq: number }, [string]>(
          'SELECT seq FROM inbound_deliveries WHERE idempotency_key = ?',
        ).get(key)
        if (interruptInbound) {
          this.db.run(
            `INSERT INTO delivery_tombstones (idempotency_key, write_enabled, completed_at)
             SELECT idempotency_key, write_enabled, ?
             FROM inbound_deliveries
             WHERE chat_id = ? AND thread_ts = ? AND seq < ? AND is_interrupt = 0
               AND expected_control_job_id = ? AND expected_control_epoch = ?
             ON CONFLICT(idempotency_key) DO UPDATE SET
               write_enabled = MAX(write_enabled, excluded.write_enabled),
               completed_at = MAX(completed_at, excluded.completed_at)`,
            [now, chatId, threadTs, interruptInbound.seq, jobId, epoch],
          )
          this.db.run(
            `DELETE FROM inbound_deliveries
             WHERE chat_id = ? AND thread_ts = ? AND seq < ? AND is_interrupt = 0
               AND expected_control_job_id = ? AND expected_control_epoch = ?`,
            [chatId, threadTs, interruptInbound.seq, jobId, epoch],
          )
        }
        this.db.run(
          `UPDATE job_controls SET status = 'superseded',
             last_error = 'superseded by a later Slack interrupt'
           WHERE job_id = ? AND control_epoch = ? AND kind = 'steer' AND status = 'ready'`,
          [jobId, epoch],
        )
        this.db.run(
          `UPDATE job_interjections SET status = 'superseded',
             last_error = 'superseded by a later Slack interrupt'
           WHERE job_id = ? AND control_epoch = ?
             AND status IN ('ready', 'paused', 'answer-prepared', 'answered')`,
          [jobId, epoch],
        )
        const closed = this.db.run(
          `UPDATE jobs SET accepts_control = 0, ui_approval_request_id = NULL,
             cancel_requested_at = COALESCE(cancel_requested_at, ?)
           WHERE id = ? AND control_epoch = ? AND cancel_requested_at IS NULL
             AND status IN ('running', 'queued')`,
          [now, jobId, epoch],
        )
        if (closed.changes !== 1) return 'closed'
        if (target.ui_approval_request_id) {
          this.db.run(
            `UPDATE ui_approval_requests SET status = 'cancelled', responded_at = COALESCE(responded_at, ?)
             WHERE id = ? AND job_id = ? AND status IN ('publishing', 'awaiting')`,
            [now, target.ui_approval_request_id, jobId],
          )
          this.settleUiApprovalArtifactsForTerminal(
            jobId,
            now,
            'UI/UX approval publication was cancelled by a Slack interrupt',
          )
        }
      } else {
        const advanced = this.db.run(
          `UPDATE jobs SET input_revision = input_revision + 1
           WHERE id = ? AND control_epoch = ? AND accepts_control = 1
             AND input_revision = ?`,
          [jobId, epoch, target.input_revision],
        )
        if (advanced.changes !== 1) return 'closed'
        inputRevision += 1
      }
      const controlId = randomUUID()
      const inserted = this.db.run(
        `INSERT OR IGNORE INTO job_controls (
           id, idempotency_key, job_id, control_epoch, input_revision, input_digest,
           kind, chat_id, thread_ts,
           message_id, user_id, write_enabled, task, attachments_json, status, created_at
         ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
        [
          controlId, key, jobId, epoch, inputRevision, input.kind, chatId, threadTs,
          messageId, userId, input.writeEnabled ? 1 : 0,
          task, JSON.stringify(attachments), now,
        ],
      )
      if (inserted.changes !== 1) return 'duplicate'
      const snapshotJob = this.db.query<{
        id: string
        message_id: string
        user_id: string
        write_enabled: number
        task: string
        attachments_json: string
        input_revision: number
      }, [string]>(
        `SELECT id, message_id, user_id, write_enabled, task, attachments_json, input_revision
         FROM jobs WHERE id = ?`,
      ).get(jobId)
      if (!snapshotJob) throw new Error(`advisor input job disappeared: ${jobId}`)
      const snapshotControls = this.db.query<Array<never>[number] & {
        input_revision: number
        message_id: string
        user_id: string
        write_enabled: number
        task: string
        attachments_json: string
      }, [string]>(
        `SELECT input_revision, message_id, user_id, write_enabled, task, attachments_json
         FROM job_controls WHERE job_id = ? AND kind = 'steer'
         ORDER BY input_revision ASC, seq ASC`,
      ).all(jobId)
      const snapshot = createAdvisorInputSnapshot(snapshotJob, snapshotControls)
      const digested = this.db.run(
        'UPDATE job_controls SET input_digest = ? WHERE id = ? AND input_digest = \'\'',
        [snapshot.digest, controlId],
      )
      if (digested.changes !== 1) throw new Error(`control input digest was not fixed: ${controlId}`)
      if (input.kind === 'steer') {
        this.db.run(
          `UPDATE job_interjections SET input_revision = ?, input_digest = ?
           WHERE job_id = ? AND control_epoch = ?
             AND status IN ('ready', 'paused', 'answer-prepared')`,
          [snapshot.revision, snapshot.digest, jobId, epoch],
        )
        if (target.ui_approval_request_id) {
          const prompt = this.db.query<{
            prompt_message_id: string | null
          }, [string, string]>(
            `SELECT prompt_message_id FROM ui_approval_requests
             WHERE id = ? AND job_id = ? AND status IN ('publishing', 'awaiting')`,
          ).get(target.ui_approval_request_id, jobId)
          if (!prompt) {
            throw new Error('UI/UX approval request disappeared before its response was staged')
          }
          const explicitApproval = isExplicitUiApprovalResponse(
            task,
            attachments.length > 0,
          ) && prompt.prompt_message_id !== null
            && slackMessageIsAfter(messageId, prompt.prompt_message_id)
          // While the prompt is still being published, more than one Slack
          // reply can be durably drained before the remote prompt receipt is
          // recorded. Keep the latest reply instead of binding this update to
          // the proposal's original input revision and discarding later input.
          const responded = this.db.run(
            `UPDATE ui_approval_requests
             SET response_message_id = ?, response_user_id = ?, response_text = ?,
                 response_input_revision = ?,
                 response_explicit_approval = CASE
                   WHEN prompt_message_id IS NULL THEN 0 ELSE ?
                 END,
                 responded_at = ?,
                 status = CASE WHEN prompt_message_id IS NULL THEN 'publishing' ELSE 'responded' END
             WHERE id = ? AND job_id = ? AND status IN ('publishing', 'awaiting')`,
            [
              messageId, userId, task, snapshot.revision, explicitApproval ? 1 : 0, now,
              target.ui_approval_request_id, jobId,
            ],
          )
          if (responded.changes !== 1) {
            throw new Error('UI/UX approval response no longer matches the active proposal')
          }
          this.db.run(
            `UPDATE jobs SET ui_approval_request_id = NULL
             WHERE id = ? AND ui_approval_request_id = ?
               AND EXISTS (
                 SELECT 1 FROM ui_approval_requests
                 WHERE id = ? AND status = 'responded'
               )`,
            [jobId, target.ui_approval_request_id, target.ui_approval_request_id],
          )
        }
      }
      if (input.kind === 'interrupt' && input.notifyAccepted) {
        this.stageStatusNotificationRow({
          idempotencyKey: `interrupt-accepted:${key}`,
          jobId,
          chatId,
          threadTs,
          kind: 'interrupt-accepted',
          payload: '中止を受け付けました。安全な後処理を開始します。',
          createdAt: now,
        })
      }
      this.db.run(
        `UPDATE lifecycle_notifications SET superseded_at = COALESCE(superseded_at, ?)
         WHERE job_id = ? AND attempt = (SELECT attempts FROM jobs WHERE id = ?)
           AND kind = 'progress' AND delivered_at IS NULL AND superseded_at IS NULL`,
        [now, jobId, jobId],
      )
      this.db.run(
        `UPDATE progress_probes SET superseded_at = COALESCE(superseded_at, ?)
         WHERE job_id = ? AND attempt = (SELECT attempts FROM jobs WHERE id = ?)
           AND reported_at IS NULL AND superseded_at IS NULL`,
        [now, jobId, jobId],
      )
      return 'staged'
    })
    return retrySqlite(() => stage.immediate())
  }

  stageLiveInterjection(
    expected: LiveControlTarget,
    input: Omit<LiveControlInput, 'kind'>,
  ): 'staged' | 'duplicate' | 'closed' {
    const jobId = requireText(expected.jobId, 'jobId')
    const epoch = Math.floor(expected.epoch)
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('control epoch is invalid')
    const chatId = requireText(input.chatId, 'chatId')
    const threadTs = requireText(input.threadTs, 'threadTs')
    const messageId = requireText(input.messageId, 'messageId')
    const userId = requireText(input.userId, 'userId')
    const task = requireText(input.task, 'task')
    const attachments = (input.attachments ?? []).map(path => requireText(path, 'attachment'))
    const key = `${chatId}:${messageId}`
    const stage = this.db.transaction((): 'staged' | 'duplicate' | 'closed' => {
      if (this.db.query<{ present: number }, [string, string, string]>(
        `SELECT 1 AS present FROM job_controls WHERE idempotency_key = ?
         UNION ALL SELECT 1 FROM job_interjections WHERE idempotency_key = ?
         UNION ALL SELECT 1 FROM jobs WHERE idempotency_key = ?
         LIMIT 1`,
      ).get(key, key, key)) return 'duplicate'
      const target = this.db.query<{
        accepts_control: number
        control_epoch: number
        input_revision: number
        chat_id: string
        thread_ts: string
        status: JobStatus
        cancel_requested_at: number | null
        id: string
        message_id: string
        user_id: string
        write_enabled: number
        task: string
        attachments_json: string
        ui_approval_request_id: string | null
      }, [string]>(
        `SELECT accepts_control, control_epoch, input_revision, chat_id, thread_ts,
                status, cancel_requested_at, id, message_id, user_id, write_enabled,
                task, attachments_json, ui_approval_request_id
         FROM jobs WHERE id = ? AND runtime = 'codex'`,
      ).get(jobId)
      if (!target || target.control_epoch !== epoch
        || target.chat_id !== chatId || target.thread_ts !== threadTs
        || !(target.status === 'running' || target.status === 'queued')
        || target.accepts_control !== 1 || target.cancel_requested_at !== null) return 'closed'
      if (target.ui_approval_request_id !== null) return 'closed'
      const snapshotControls = this.db.query<{
        input_revision: number
        message_id: string
        user_id: string
        write_enabled: number
        task: string
        attachments_json: string
      }, [string]>(
        `SELECT input_revision, message_id, user_id, write_enabled, task, attachments_json
         FROM job_controls WHERE job_id = ? AND kind = 'steer'
         ORDER BY input_revision ASC, seq ASC`,
      ).all(jobId)
      const snapshot = createAdvisorInputSnapshot(target, snapshotControls)
      if (snapshot.revision !== target.input_revision) {
        throw new Error(`interjection input revision changed for ${jobId}`)
      }
      const now = Date.now()
      const inserted = this.db.run(
        `INSERT OR IGNORE INTO job_interjections (
           id, idempotency_key, job_id, control_epoch, input_revision, input_digest,
           chat_id, thread_ts, message_id, user_id, write_enabled, task,
           attachments_json, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
        [
          randomUUID(), key, jobId, epoch, snapshot.revision, snapshot.digest,
          chatId, threadTs, messageId, userId, input.writeEnabled ? 1 : 0,
          task, JSON.stringify(attachments), now,
        ],
      )
      if (inserted.changes !== 1) return 'duplicate'
      this.db.run(
        `UPDATE lifecycle_notifications SET superseded_at = COALESCE(superseded_at, ?)
         WHERE job_id = ? AND attempt = (SELECT attempts FROM jobs WHERE id = ?)
           AND kind = 'progress' AND delivered_at IS NULL AND superseded_at IS NULL`,
        [now, jobId, jobId],
      )
      this.db.run(
        `UPDATE progress_probes SET superseded_at = COALESCE(superseded_at, ?)
         WHERE job_id = ? AND attempt = (SELECT attempts FROM jobs WHERE id = ?)
           AND reported_at IS NULL AND superseded_at IS NULL`,
        [now, jobId, jobId],
      )
      return 'staged'
    })
    return retrySqlite(() => stage.immediate())
  }

  /** Route a human same-thread reply through the current durable wait state. */
  stageThreadReply(
    expected: LiveControlTarget,
    input: Omit<LiveControlInput, 'kind'>,
  ): 'staged' | 'duplicate' | 'closed' {
    let target: LiveControlTarget | null = expected
    for (let attempt = 0; attempt < 2 && target; attempt += 1) {
      const disposition = target.awaitingUiApproval
        ? this.stageLiveControl(target, { ...input, kind: 'steer' })
        : this.stageLiveInterjection(target, input)
      if (disposition !== 'closed') return disposition
      const refreshed = this.liveControlTarget(input.chatId, input.threadTs)
      if (!refreshed || refreshed.jobId !== expected.jobId || refreshed.epoch !== expected.epoch
        || refreshed.awaitingUiApproval === target.awaitingUiApproval) return 'closed'
      target = refreshed
    }
    return 'closed'
  }

  listJobInterjections(jobIdInput: string): JobInterjectionRecord[] {
    const jobId = requireText(jobIdInput, 'jobId')
    return retrySqlite(() => this.db.query<JobInterjectionRow, [string]>(
      'SELECT * FROM job_interjections WHERE job_id = ? ORDER BY seq ASC',
    ).all(jobId).map(mapInterjectionRow))
  }

  listJobControls(jobIdInput: string): JobControlRecord[] {
    const jobId = requireText(jobIdInput, 'jobId')
    return retrySqlite(() => this.db.query<JobControlRow, [string]>(
      'SELECT * FROM job_controls WHERE job_id = ? ORDER BY seq ASC',
    ).all(jobId).map(mapControlRow))
  }

  hasJobControl(idempotencyKeyInput: string): boolean {
    return retrySqlite(() => this.db.query<{ present: number }, [string]>(
      'SELECT 1 AS present FROM job_controls WHERE idempotency_key = ?',
    ).get(requireText(idempotencyKeyInput, 'idempotencyKey')) !== null)
  }

  hasLiveInput(idempotencyKeyInput: string): boolean {
    const key = requireText(idempotencyKeyInput, 'idempotencyKey')
    return retrySqlite(() => this.db.query<{ present: number }, [string, string]>(
      `SELECT 1 AS present FROM job_controls WHERE idempotency_key = ?
       UNION ALL SELECT 1 FROM job_interjections WHERE idempotency_key = ?
       LIMIT 1`,
    ).get(key, key) !== null)
  }

  controlMayHaveBeenDelivered(jobIdInput: string): boolean {
    const jobId = requireText(jobIdInput, 'jobId')
    return retrySqlite(() => this.db.query<{ present: number }, [string, string]>(
      `SELECT 1 AS present FROM job_controls
       WHERE job_id = ? AND status IN ('dispatching', 'acknowledged', 'observed', 'ambiguous')
       UNION ALL
       SELECT 1 AS present FROM job_interjections
       WHERE job_id = ? AND status IN (
         'pausing', 'paused', 'answer-prepared', 'answering',
         'answered', 'delivered', 'promoted', 'ambiguous'
       )
       LIMIT 1`,
    ).get(jobId, jobId) !== null)
  }

  nextReadyControl(jobIdInput: string, epochInput: number): JobControlRecord | null {
    const jobId = requireText(jobIdInput, 'jobId')
    const epoch = Math.floor(epochInput)
    const row = retrySqlite(() => this.db.query<JobControlRow, [string, number]>(
      `SELECT controls.* FROM job_controls controls
       JOIN jobs ON jobs.id = controls.job_id
       WHERE controls.job_id = ? AND controls.control_epoch = ?
         AND controls.status = 'ready'
         AND (controls.turn_id IS NULL OR jobs.active_turn_id IS NULL
           OR controls.turn_id <> jobs.active_turn_id)
       ORDER BY CASE controls.kind WHEN 'interrupt' THEN 0 ELSE 1 END,
                controls.seq ASC LIMIT 1`,
    ).get(jobId, epoch))
    return row ? mapControlRow(row) : null
  }

  nextReadyLiveInput(jobIdInput: string, epochInput: number): JobLiveInputRecord | null {
    const jobId = requireText(jobIdInput, 'jobId')
    const epoch = Math.floor(epochInput)
    const interrupt = retrySqlite(() => this.db.query<JobControlRow, [string, number]>(
      `SELECT controls.* FROM job_controls controls
       JOIN jobs ON jobs.id = controls.job_id
       WHERE controls.job_id = ? AND controls.control_epoch = ?
         AND controls.kind = 'interrupt' AND controls.status = 'ready'
         AND (controls.turn_id IS NULL OR jobs.active_turn_id IS NULL
           OR controls.turn_id <> jobs.active_turn_id)
       ORDER BY controls.seq ASC LIMIT 1`,
    ).get(jobId, epoch))
    if (interrupt) return mapControlRow(interrupt)
    const [control, interjection] = retrySqlite(() => [
      this.db.query<JobControlRow, [string, number]>(
        `SELECT controls.* FROM job_controls controls
         JOIN jobs ON jobs.id = controls.job_id
         WHERE controls.job_id = ? AND controls.control_epoch = ?
           AND controls.kind = 'steer' AND controls.status = 'ready'
           AND (controls.turn_id IS NULL OR jobs.active_turn_id IS NULL
             OR controls.turn_id <> jobs.active_turn_id)
         ORDER BY controls.created_at ASC, controls.seq ASC LIMIT 1`,
      ).get(jobId, epoch),
      this.db.query<JobInterjectionRow, [string, number]>(
        `SELECT current.* FROM job_interjections AS current
         WHERE current.job_id = ? AND current.control_epoch = ? AND current.status = 'ready'
           AND NOT EXISTS (
             SELECT 1 FROM job_interjections AS prior
             WHERE prior.job_id = current.job_id
               AND prior.control_epoch = current.control_epoch
               AND prior.seq < current.seq
               AND prior.status NOT IN ('promoted', 'superseded')
           )
         ORDER BY created_at ASC, seq ASC LIMIT 1`,
      ).get(jobId, epoch),
    ])
    if (!control) return interjection ? mapInterjectionRow(interjection) : null
    if (!interjection) return mapControlRow(control)
    if (interjection.created_at < control.created_at
      || (interjection.created_at === control.created_at && interjection.id < control.id)) {
      return mapInterjectionRow(interjection)
    }
    return mapControlRow(control)
  }

  nextPendingInterjection(jobIdInput: string, epochInput: number): JobInterjectionRecord | null {
    const jobId = requireText(jobIdInput, 'jobId')
    const epoch = Math.floor(epochInput)
    const row = retrySqlite(() => this.db.query<JobInterjectionRow, [string, number]>(
      `SELECT current.* FROM job_interjections AS current
       WHERE current.job_id = ? AND current.control_epoch = ?
         AND current.status IN ('ready', 'paused')
         AND NOT EXISTS (
           SELECT 1 FROM job_interjections AS prior
           WHERE prior.job_id = current.job_id
             AND prior.control_epoch = current.control_epoch
             AND prior.seq < current.seq
             AND prior.status NOT IN ('promoted', 'superseded')
         )
       ORDER BY current.seq ASC LIMIT 1`,
    ).get(jobId, epoch))
    return row ? mapInterjectionRow(row) : null
  }

  bindAppServerTurn(
    jobIdInput: string,
    workerIdInput: string,
    epochInput: number,
    executorNonceInput: string,
    threadIdInput: string,
    turnIdInput: string,
  ): void {
    const updated = retrySqlite(() => this.db.run(
      `UPDATE jobs SET executor_nonce = ?, active_thread_id = ?, active_turn_id = ?
       WHERE id = ? AND runtime = 'codex' AND status = 'running' AND worker_id = ?
         AND control_epoch = ?
         AND (executor_nonce IS NULL OR executor_nonce = ?)
         AND (active_thread_id IS NULL OR active_thread_id = ?)`,
      [
        requireText(executorNonceInput, 'executorNonce'),
        requireText(threadIdInput, 'threadId'),
        requireText(turnIdInput, 'turnId'),
        requireText(jobIdInput, 'jobId'),
        requireText(workerIdInput, 'workerId'),
        Math.floor(epochInput),
        executorNonceInput,
        threadIdInput,
      ],
    ))
    if (updated.changes !== 1) throw new Error(`App Server turn binding changed for ${jobIdInput}`)
  }

  beginInitialTurnDispatch(options: {
    jobId: string
    attempt: number
    epoch: number
    executorNonce: string
    threadId: string
    requestId: number
    inputRevision: number
    inputDigest: string
  }): 'dispatching' | 'input-changed' | 'cancelled' {
    if (!Number.isSafeInteger(options.requestId) || options.requestId < 1) {
      throw new Error('App Server request id is invalid')
    }
    if (!Number.isSafeInteger(options.inputRevision) || options.inputRevision < 1
      || !/^[0-9a-f]{64}$/.test(options.inputDigest)) {
      throw new Error('initial App Server input binding is invalid')
    }
    const dispatch = this.db.transaction((): 'dispatching' | 'input-changed' | 'cancelled' => {
      const job = this.db.query<{
        input_revision: number
        cancel_requested_at: number | null
      }, [string, number, number]>(
        `SELECT input_revision, cancel_requested_at FROM jobs
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND attempts = ? AND control_epoch = ?`,
      ).get(
        requireText(options.jobId, 'jobId'),
        Math.floor(options.attempt),
        Math.floor(options.epoch),
      )
      if (!job) throw new Error(`initial App Server job binding changed for ${options.jobId}`)
      if (job.cancel_requested_at !== null) return 'cancelled'
      if (job.input_revision !== options.inputRevision) return 'input-changed'
      const now = Date.now()
      const receipt = this.db.run(
        `UPDATE job_initial_dispatches
         SET status = 'dispatching', input_revision = ?, input_digest = ?,
             request_id = ?, executor_nonce = ?, app_thread_id = ?, dispatched_at = ?
         WHERE job_id = ? AND attempt = ? AND control_epoch = ?
           AND status = 'prepared'`,
        [
          options.inputRevision,
          options.inputDigest,
          options.requestId,
          requireText(options.executorNonce, 'executorNonce'),
          requireText(options.threadId, 'threadId'),
          now,
          options.jobId,
          Math.floor(options.attempt),
          Math.floor(options.epoch),
        ],
      )
      if (receipt.changes !== 1) {
        throw new Error(`initial App Server dispatch binding changed for ${options.jobId}`)
      }
      this.db.run(
        `UPDATE job_controls
         SET status = 'dispatching', request_id = ?, executor_nonce = ?,
             app_thread_id = ?, turn_id = NULL, dispatched_at = ?,
             last_error = 'included in initial turn request'
         WHERE job_id = ? AND control_epoch = ? AND kind = 'steer'
           AND status = 'ready' AND input_revision <= ?`,
        [
          options.requestId,
          options.executorNonce,
          options.threadId,
          now,
          options.jobId,
          Math.floor(options.epoch),
          options.inputRevision,
        ],
      )
      return 'dispatching'
    })
    return retrySqlite(() => dispatch.immediate())
  }

  acknowledgeInitialTurnDispatch(options: {
    jobId: string
    workerId: string
    attempt: number
    epoch: number
    executorNonce: string
    threadId: string
    turnId: string
    requestId: number
  }): void {
    const acknowledge = this.db.transaction(() => {
      const receipt = this.db.run(
        `UPDATE job_initial_dispatches
         SET status = 'acknowledged', turn_id = ?, acknowledged_at = ?
         WHERE job_id = ? AND attempt = ? AND control_epoch = ?
           AND status = 'dispatching' AND request_id = ?
           AND executor_nonce = ? AND app_thread_id = ?`,
        [
          requireText(options.turnId, 'turnId'),
          Date.now(),
          requireText(options.jobId, 'jobId'),
          Math.floor(options.attempt),
          Math.floor(options.epoch),
          options.requestId,
          requireText(options.executorNonce, 'executorNonce'),
          requireText(options.threadId, 'threadId'),
        ],
      )
      if (receipt.changes !== 1) {
        throw new Error(`initial App Server receipt changed for ${options.jobId}`)
      }
      this.db.run(
        `UPDATE job_controls
         SET status = 'observed', turn_id = ?, acknowledged_at = ?, observed_at = ?
         WHERE job_id = ? AND control_epoch = ? AND kind = 'steer'
           AND status = 'dispatching' AND request_id = ?
           AND executor_nonce = ? AND app_thread_id = ? AND turn_id IS NULL`,
        [
          options.turnId,
          Date.now(),
          Date.now(),
          options.jobId,
          Math.floor(options.epoch),
          options.requestId,
          options.executorNonce,
          options.threadId,
        ],
      )
      const binding = this.db.run(
        `UPDATE jobs SET executor_nonce = ?, active_thread_id = ?, active_turn_id = ?
         WHERE id = ? AND runtime = 'codex' AND status = 'running' AND worker_id = ?
           AND attempts = ? AND control_epoch = ?
           AND executor_nonce IS NULL AND active_thread_id IS NULL AND active_turn_id IS NULL`,
        [
          options.executorNonce,
          options.threadId,
          options.turnId,
          options.jobId,
          requireText(options.workerId, 'workerId'),
          Math.floor(options.attempt),
          Math.floor(options.epoch),
        ],
      )
      if (binding.changes !== 1) {
        throw new Error(`initial App Server turn binding changed for ${options.jobId}`)
      }
    })
    retrySqlite(() => acknowledge.immediate())
  }

  markInitialTurnDispatchAmbiguous(options: {
    jobId: string
    attempt: number
    requestId: number
    error: string
  }): void {
    const ambiguous = this.db.transaction(() => {
      const updated = this.db.run(
        `UPDATE job_initial_dispatches SET status = 'ambiguous', last_error = ?
         WHERE job_id = ? AND attempt = ? AND status = 'dispatching' AND request_id = ?`,
        [options.error, options.jobId, Math.floor(options.attempt), options.requestId],
      )
      if (updated.changes !== 1) {
        throw new Error(`initial App Server ambiguity changed for ${options.jobId}`)
      }
      this.db.run(
        `UPDATE job_controls SET status = 'ambiguous', last_error = ?
         WHERE job_id = ? AND status = 'dispatching' AND request_id = ?
           AND turn_id IS NULL`,
        [options.error, options.jobId, options.requestId],
      )
    })
    retrySqlite(() => ambiguous.immediate())
  }

  markInitialTurnDispatchRejected(options: {
    jobId: string
    attempt: number
    requestId: number
    error: string
  }): void {
    const reject = this.db.transaction(() => {
      const updated = this.db.run(
        `UPDATE job_initial_dispatches SET status = 'rejected', last_error = ?
         WHERE job_id = ? AND attempt = ? AND status = 'dispatching' AND request_id = ?`,
        [options.error, options.jobId, Math.floor(options.attempt), options.requestId],
      )
      if (updated.changes !== 1) {
        throw new Error(`initial App Server rejection changed for ${options.jobId}`)
      }
      this.db.run(
        `UPDATE job_controls
         SET status = 'ready', request_id = NULL, executor_nonce = NULL,
             app_thread_id = NULL, turn_id = NULL, dispatched_at = NULL,
             last_error = ?
         WHERE job_id = ? AND status = 'dispatching' AND request_id = ?
           AND turn_id IS NULL`,
        [options.error, options.jobId, options.requestId],
      )
    })
    retrySqlite(() => reject.immediate())
  }

  initialTurnMayHaveBeenDelivered(jobIdInput: string): boolean {
    const jobId = requireText(jobIdInput, 'jobId')
    return retrySqlite(() => this.db.query<{ present: number }, [string]>(
      `SELECT 1 AS present
       FROM job_initial_dispatches receipts
       JOIN jobs ON jobs.id = receipts.job_id AND jobs.attempts = receipts.attempt
       WHERE receipts.job_id = ?
         AND receipts.status IN ('dispatching', 'acknowledged', 'observed', 'ambiguous')`,
    ).get(jobId) !== null)
  }

  initialTurnDispatchIsSafeToRetry(jobIdInput: string): boolean {
    const jobId = requireText(jobIdInput, 'jobId')
    return retrySqlite(() => this.db.query<{ present: number }, [string]>(
      `SELECT 1 AS present
       FROM job_initial_dispatches receipts
       JOIN jobs ON jobs.id = receipts.job_id AND jobs.attempts = receipts.attempt
       WHERE receipts.job_id = ? AND receipts.status IN ('prepared', 'rejected')`,
    ).get(jobId) !== null)
  }

  writePhaseMayHaveBeenDelivered(jobIdInput: string): boolean {
    const jobId = requireText(jobIdInput, 'jobId')
    return retrySqlite(() => this.db.query<{ present: number }, [string]>(
      `SELECT 1 AS present
       FROM job_phase_dispatches receipts
       WHERE receipts.job_id = ? AND receipts.stage = 'implementation'
         AND receipts.status IN ('dispatching', 'acknowledged', 'observed', 'ambiguous')`,
    ).get(jobId) !== null)
  }

  prepareAppServerPhaseDispatch(options: {
    jobId: string
    attempt: number
    epoch: number
    phaseSequence: number
    stage: 'prepare' | 'implementation' | 'review'
    logicalNonce: string
    threadId: string
    inputRevision: number
    inputDigest: string
  }): string {
    if (!Number.isSafeInteger(options.phaseSequence) || options.phaseSequence < 1
      || !Number.isSafeInteger(options.inputRevision) || options.inputRevision < 1
      || !/^[0-9a-f]{64}$/.test(options.inputDigest)) {
      throw new Error('App Server phase dispatch binding is invalid')
    }
    const clientUserMessageId = `${requireText(options.jobId, 'jobId')}:phase:${options.phaseSequence}`
    const prepare = this.db.transaction(() => {
      const job = this.db.query<{
        executor_nonce: string | null
        active_thread_id: string | null
        active_turn_id: string | null
        cancel_requested_at: number | null
        input_revision: number
      }, [string, number, number]>(
        `SELECT executor_nonce, active_thread_id, active_turn_id, cancel_requested_at,
                input_revision
         FROM jobs WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND attempts = ? AND control_epoch = ?`,
      ).get(options.jobId, Math.floor(options.attempt), Math.floor(options.epoch))
      if (!job || job.executor_nonce !== options.logicalNonce
        || job.active_thread_id !== options.threadId || job.active_turn_id !== null) {
        throw new Error(`App Server phase boundary changed for ${options.jobId}`)
      }
      if (job.cancel_requested_at !== null) return 'cancelled' as const
      if (job.input_revision !== options.inputRevision) return 'input-changed' as const
      this.db.run(
        `DELETE FROM job_phase_dispatches
         WHERE job_id = ? AND attempt = ? AND phase_sequence = ?
           AND status IN ('prepared', 'rejected')`,
        [options.jobId, Math.floor(options.attempt), options.phaseSequence],
      )
      const inserted = this.db.run(
        `INSERT INTO job_phase_dispatches (
           job_id, attempt, phase_sequence, control_epoch, stage, logical_nonce,
           input_revision, input_digest, client_user_message_id, status,
           app_thread_id, prepared_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
        [
          options.jobId, Math.floor(options.attempt), options.phaseSequence,
          Math.floor(options.epoch), options.stage, options.logicalNonce,
          options.inputRevision, options.inputDigest, clientUserMessageId,
          options.threadId, Date.now(),
        ],
      )
      if (inserted.changes !== 1) {
        throw new Error(`App Server phase receipt was not prepared for ${options.jobId}`)
      }
      return 'prepared' as const
    })
    const result = retrySqlite(() => prepare.immediate())
    if (result !== 'prepared') return result
    return clientUserMessageId
  }

  beginAppServerPhaseDispatch(options: {
    jobId: string
    attempt: number
    epoch: number
    phaseSequence: number
    logicalNonce: string
    threadId: string
    requestId: number
    inputRevision: number
    inputDigest: string
  }): 'dispatching' | 'input-changed' | 'cancelled' | 'pending-inbound' {
    if (!Number.isSafeInteger(options.requestId) || options.requestId < 1) {
      throw new Error('App Server phase request id is invalid')
    }
    const begin = this.db.transaction(() => {
      const job = this.db.query<{
        id: string
        message_id: string
        user_id: string
        task: string
        attachments_json: string
        input_revision: number
        cancel_requested_at: number | null
        chat_id: string
        thread_ts: string
        executor_nonce: string | null
        active_thread_id: string | null
        active_turn_id: string | null
      }, [string, number, number]>(
        `SELECT id, message_id, user_id, write_enabled, task, attachments_json, input_revision,
                cancel_requested_at, chat_id, thread_ts, executor_nonce,
                active_thread_id, active_turn_id
         FROM jobs WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND attempts = ? AND control_epoch = ?`,
      ).get(options.jobId, Math.floor(options.attempt), Math.floor(options.epoch))
      if (!job || job.executor_nonce !== options.logicalNonce
        || job.active_thread_id !== options.threadId || job.active_turn_id !== null) {
        throw new Error(`App Server phase dispatch binding changed for ${options.jobId}`)
      }
      if (job.cancel_requested_at !== null) return 'cancelled' as const
      const pendingInbound = this.db.query<{ count: number }, [string, string]>(
        `SELECT COUNT(*) AS count FROM inbound_deliveries
         WHERE chat_id = ? AND thread_ts = ?`,
      ).get(job.chat_id, job.thread_ts)?.count ?? 0
      if (pendingInbound > 0) return 'pending-inbound' as const
      const pendingInterjections = this.db.query<{ count: number }, [string, number]>(
        `SELECT COUNT(*) AS count FROM job_interjections
         WHERE job_id = ? AND control_epoch = ?
           AND status NOT IN ('promoted', 'superseded')`,
      ).get(options.jobId, Math.floor(options.epoch))?.count ?? 0
      if (pendingInterjections > 0) return 'pending-inbound' as const
      const controls = this.db.query<{
        input_revision: number
        message_id: string
        user_id: string
        write_enabled: number
        task: string
        attachments_json: string
      }, [string]>(
        `SELECT input_revision, message_id, user_id, write_enabled, task, attachments_json
         FROM job_controls WHERE job_id = ? AND kind = 'steer'
         ORDER BY input_revision ASC, seq ASC`,
      ).all(options.jobId)
      const snapshot = createAdvisorInputSnapshot(job, controls)
      if (snapshot.revision !== options.inputRevision
        || snapshot.digest !== options.inputDigest) return 'input-changed' as const
      const now = Date.now()
      const updated = this.db.run(
        `UPDATE job_phase_dispatches
         SET status = 'dispatching', request_id = ?, dispatched_at = ?
         WHERE job_id = ? AND attempt = ? AND phase_sequence = ?
           AND control_epoch = ? AND status = 'prepared' AND logical_nonce = ?
           AND app_thread_id = ? AND input_revision = ? AND input_digest = ?`,
        [
          options.requestId, now, options.jobId, Math.floor(options.attempt),
          options.phaseSequence, Math.floor(options.epoch), options.logicalNonce,
          options.threadId, options.inputRevision, options.inputDigest,
        ],
      )
      if (updated.changes !== 1) {
        throw new Error(`App Server phase receipt changed for ${options.jobId}`)
      }
      this.db.run(
        `UPDATE job_controls SET status = 'dispatching', request_id = ?,
           executor_nonce = ?, app_thread_id = ?, turn_id = NULL, dispatched_at = ?,
           last_error = 'included in phase turn request'
         WHERE job_id = ? AND control_epoch = ? AND kind = 'steer'
           AND status = 'ready' AND input_revision <= ?`,
        [
          options.requestId, options.logicalNonce, options.threadId, now,
          options.jobId, Math.floor(options.epoch), options.inputRevision,
        ],
      )
      return 'dispatching' as const
    })
    return retrySqlite(() => begin.immediate())
  }

  acknowledgeAppServerPhaseDispatch(options: {
    jobId: string
    workerId: string
    attempt: number
    epoch: number
    phaseSequence: number
    logicalNonce: string
    threadId: string
    turnId: string
    requestId: number
  }): void {
    const acknowledge = this.db.transaction(() => {
      const now = Date.now()
      const receipt = this.db.run(
        `UPDATE job_phase_dispatches
         SET status = 'acknowledged', turn_id = ?, acknowledged_at = ?
         WHERE job_id = ? AND attempt = ? AND phase_sequence = ?
           AND control_epoch = ? AND status = 'dispatching' AND request_id = ?
           AND logical_nonce = ? AND app_thread_id = ?`,
        [
          requireText(options.turnId, 'turnId'), now, options.jobId,
          Math.floor(options.attempt), options.phaseSequence, Math.floor(options.epoch),
          options.requestId, options.logicalNonce, options.threadId,
        ],
      )
      if (receipt.changes !== 1) {
        throw new Error(`App Server phase acknowledgement changed for ${options.jobId}`)
      }
      this.db.run(
        `UPDATE job_controls SET status = 'observed', turn_id = ?,
           acknowledged_at = ?, observed_at = ?
         WHERE job_id = ? AND control_epoch = ? AND kind = 'steer'
           AND status = 'dispatching' AND request_id = ? AND executor_nonce = ?
           AND app_thread_id = ? AND turn_id IS NULL`,
        [
          options.turnId, now, now, options.jobId, Math.floor(options.epoch),
          options.requestId, options.logicalNonce, options.threadId,
        ],
      )
      const binding = this.db.run(
        `UPDATE jobs SET active_turn_id = ?
         WHERE id = ? AND runtime = 'codex' AND status = 'running' AND worker_id = ?
           AND attempts = ? AND control_epoch = ? AND executor_nonce = ?
           AND active_thread_id = ? AND active_turn_id IS NULL`,
        [
          options.turnId, options.jobId, requireText(options.workerId, 'workerId'),
          Math.floor(options.attempt), Math.floor(options.epoch), options.logicalNonce,
          options.threadId,
        ],
      )
      if (binding.changes !== 1) {
        throw new Error(`App Server phase turn binding changed for ${options.jobId}`)
      }
    })
    retrySqlite(() => acknowledge.immediate())
  }

  markAppServerPhaseDispatchAmbiguous(options: {
    jobId: string
    attempt: number
    phaseSequence: number
    requestId: number
    error: string
  }): void {
    const updated = retrySqlite(() => this.db.run(
      `UPDATE job_phase_dispatches SET status = 'ambiguous', last_error = ?
       WHERE job_id = ? AND attempt = ? AND phase_sequence = ?
         AND status = 'dispatching' AND request_id = ?`,
      [options.error, options.jobId, Math.floor(options.attempt), options.phaseSequence,
        options.requestId],
    ))
    if (updated.changes !== 1) throw new Error(`App Server phase ambiguity changed for ${options.jobId}`)
  }

  markAppServerPhaseDispatchRejected(options: {
    jobId: string
    attempt: number
    phaseSequence: number
    requestId: number
    error: string
  }): void {
    const reject = this.db.transaction(() => {
      const updated = this.db.run(
        `UPDATE job_phase_dispatches SET status = 'rejected', last_error = ?
         WHERE job_id = ? AND attempt = ? AND phase_sequence = ?
           AND status = 'dispatching' AND request_id = ?`,
        [options.error, options.jobId, Math.floor(options.attempt), options.phaseSequence,
          options.requestId],
      )
      if (updated.changes !== 1) {
        throw new Error(`App Server phase rejection changed for ${options.jobId}`)
      }
      this.db.run(
        `UPDATE job_controls SET status = 'ready', request_id = NULL,
           executor_nonce = NULL, app_thread_id = NULL, turn_id = NULL,
           dispatched_at = NULL, last_error = ?
         WHERE job_id = ? AND status = 'dispatching' AND request_id = ?
           AND turn_id IS NULL`,
        [options.error, options.jobId, options.requestId],
      )
    })
    retrySqlite(() => reject.immediate())
  }

  beginControlDispatch(options: {
    controlId: string
    jobId: string
    epoch: number
    executorNonce: string
    threadId: string
    turnId?: string
    requestId: number
  }): void {
    if (!Number.isSafeInteger(options.requestId) || options.requestId < 1) {
      throw new Error('App Server request id is invalid')
    }
    const dispatch = this.db.transaction(() => {
      const binding = this.db.query<{
        executor_nonce: string | null
        active_thread_id: string | null
        active_turn_id: string | null
      }, [string, number]>(
        `SELECT executor_nonce, active_thread_id, active_turn_id FROM jobs
         WHERE id = ? AND runtime = 'codex' AND status = 'running' AND control_epoch = ?`,
      ).get(options.jobId, Math.floor(options.epoch))
      if (!binding || binding.executor_nonce !== options.executorNonce
        || binding.active_thread_id !== options.threadId
        || (options.turnId !== undefined && binding.active_turn_id !== options.turnId)) return false
      return this.db.run(
        `UPDATE job_controls SET status = 'dispatching', request_id = ?,
           executor_nonce = ?, app_thread_id = ?, turn_id = ?, dispatched_at = ?
         WHERE id = ? AND job_id = ? AND control_epoch = ? AND status = 'ready'`,
        [
          options.requestId, options.executorNonce, options.threadId,
          options.turnId ?? null, Date.now(), options.controlId,
          options.jobId, Math.floor(options.epoch),
        ],
      ).changes === 1
    })
    if (!retrySqlite(() => dispatch.immediate())) {
      throw new Error(`control dispatch binding changed for ${options.controlId}`)
    }
  }

  acknowledgeControl(
    controlIdInput: string,
    requestId: number,
    turnIdInput: string,
  ): void {
    const updated = retrySqlite(() => this.db.run(
      `UPDATE job_controls SET status = 'acknowledged', turn_id = ?, acknowledged_at = ?
       WHERE id = ? AND status = 'dispatching' AND request_id = ?`,
      [
        requireText(turnIdInput, 'turnId'), Date.now(),
        requireText(controlIdInput, 'controlId'), requestId,
      ],
    ))
    if (updated.changes !== 1) throw new Error(`control acknowledgement changed for ${controlIdInput}`)
  }

  markControlAmbiguous(controlIdInput: string, error: string): void {
    const updated = retrySqlite(() => this.db.run(
      `UPDATE job_controls SET status = 'ambiguous', last_error = ?
       WHERE id = ? AND status = 'dispatching'`,
      [error, requireText(controlIdInput, 'controlId')],
    ))
    if (updated.changes !== 1) {
      const current = this.db.query<{ status: JobControlStatus }, [string]>(
        'SELECT status FROM job_controls WHERE id = ?',
      ).get(controlIdInput)
      if (current?.status !== 'ambiguous') {
        throw new Error(`control ambiguity could not be persisted for ${controlIdInput}`)
      }
    }
  }

  deferControlToNextTurn(options: {
    controlId: string
    requestId: number
    executorNonce: string
    threadId: string
    turnId: string
    error: string
  }): void {
    const updated = retrySqlite(() => this.db.run(
      `UPDATE job_controls SET status = 'ready', last_error = ?
       WHERE id = ? AND kind = 'steer' AND status = 'dispatching'
         AND request_id = ? AND executor_nonce = ?
         AND app_thread_id = ? AND turn_id = ?`,
      [
        options.error,
        requireText(options.controlId, 'controlId'),
        options.requestId,
        requireText(options.executorNonce, 'executorNonce'),
        requireText(options.threadId, 'threadId'),
        requireText(options.turnId, 'turnId'),
      ],
    ))
    if (updated.changes !== 1) {
      throw new Error(`control deferral changed for ${options.controlId}`)
    }
  }

  beginInterjectionPause(options: {
    interjectionId: string
    jobId: string
    epoch: number
    executorNonce: string
    threadId: string
    turnId: string
    requestId: number
  }): void {
    if (!Number.isSafeInteger(options.requestId) || options.requestId < 1) {
      throw new Error('App Server request id is invalid')
    }
    const dispatch = this.db.transaction(() => {
      const binding = this.db.query<{
        executor_nonce: string | null
        active_thread_id: string | null
        active_turn_id: string | null
        cancel_requested_at: number | null
      }, [string, number]>(
        `SELECT executor_nonce, active_thread_id, active_turn_id, cancel_requested_at
         FROM jobs WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND control_epoch = ?`,
      ).get(options.jobId, Math.floor(options.epoch))
      if (!binding || binding.cancel_requested_at !== null
        || binding.executor_nonce !== options.executorNonce
        || binding.active_thread_id !== options.threadId
        || binding.active_turn_id !== options.turnId) return false
      return this.db.run(
        `UPDATE job_interjections SET status = 'pausing', pause_request_id = ?,
           pause_executor_nonce = ?, pause_thread_id = ?, pause_turn_id = ?,
           pause_dispatched_at = ?, last_error = NULL
         WHERE id = ? AND job_id = ? AND control_epoch = ? AND status = 'ready'`,
        [
          options.requestId, options.executorNonce, options.threadId, options.turnId,
          Date.now(), options.interjectionId, options.jobId, Math.floor(options.epoch),
        ],
      ).changes === 1
    })
    if (!retrySqlite(() => dispatch.immediate())) {
      throw new Error(`interjection pause binding changed for ${options.interjectionId}`)
    }
  }

  acknowledgeInterjectionPause(
    interjectionIdInput: string,
    requestId: number,
    turnIdInput: string,
  ): void {
    const updated = retrySqlite(() => this.db.run(
      `UPDATE job_interjections SET pause_turn_id = ?, pause_acknowledged_at = ?
       WHERE id = ? AND status = 'pausing' AND pause_request_id = ?`,
      [
        requireText(turnIdInput, 'turnId'), Date.now(),
        requireText(interjectionIdInput, 'interjectionId'), requestId,
      ],
    ))
    if (updated.changes !== 1) {
      throw new Error(`interjection pause acknowledgement changed for ${interjectionIdInput}`)
    }
  }

  markInterjectionAmbiguous(interjectionIdInput: string, error: string): void {
    const id = requireText(interjectionIdInput, 'interjectionId')
    const updated = retrySqlite(() => this.db.run(
      `UPDATE job_interjections SET status = 'ambiguous', last_error = ?
       WHERE id = ? AND status IN ('pausing', 'answering')`,
      [requireText(error, 'interjectionError').slice(0, 4_000), id],
    ))
    if (updated.changes !== 1) {
      const current = this.db.query<{ status: JobInterjectionStatus }, [string]>(
        'SELECT status FROM job_interjections WHERE id = ?',
      ).get(id)
      if (current?.status !== 'ambiguous') {
        throw new Error(`interjection ambiguity could not be persisted for ${id}`)
      }
    }
  }

  rejectInterjectionAnswer(options: {
    interjectionId: string
    requestId: number
    logicalNonce: string
    threadId: string
    error: string
  }): void {
    const updated = retrySqlite(() => this.db.run(
      `UPDATE job_interjections
       SET status = CASE WHEN paused_at IS NULL THEN 'ready' ELSE 'paused' END,
           answer_request_id = NULL, answer_logical_nonce = NULL,
           answer_thread_id = NULL, answer_turn_id = NULL,
           answer_prepared_at = NULL, answer_dispatched_at = NULL,
           answer_acknowledged_at = NULL, last_error = ?
       WHERE id = ? AND status = 'answering' AND answer_request_id = ?
         AND answer_logical_nonce = ? AND answer_thread_id = ?
         AND answer_turn_id IS NULL`,
      [
        requireText(options.error, 'interjectionError').slice(0, 4_000),
        requireText(options.interjectionId, 'interjectionId'),
        options.requestId,
        requireText(options.logicalNonce, 'logicalNonce'),
        requireText(options.threadId, 'threadId'),
      ],
    ))
    if (updated.changes !== 1) {
      throw new Error(`interjection answer rejection changed for ${options.interjectionId}`)
    }
  }

  deferInterjectionPause(options: {
    interjectionId: string
    requestId: number
    executorNonce: string
    threadId: string
    turnId: string
    error: string
  }): void {
    const updated = retrySqlite(() => this.db.run(
      `UPDATE job_interjections SET status = 'ready', last_error = ?,
         pause_request_id = NULL, pause_executor_nonce = NULL,
         pause_thread_id = NULL, pause_turn_id = NULL,
         pause_dispatched_at = NULL, pause_acknowledged_at = NULL
       WHERE id = ? AND status = 'pausing' AND pause_request_id = ?
         AND pause_executor_nonce = ? AND pause_thread_id = ? AND pause_turn_id = ?`,
      [
        requireText(options.error, 'interjectionError').slice(0, 4_000),
        requireText(options.interjectionId, 'interjectionId'), options.requestId,
        requireText(options.executorNonce, 'executorNonce'),
        requireText(options.threadId, 'threadId'), requireText(options.turnId, 'turnId'),
      ],
    ))
    if (updated.changes !== 1) {
      throw new Error(`interjection pause deferral changed for ${options.interjectionId}`)
    }
  }

  prepareInterjectionAnswer(options: {
    interjectionId: string
    jobId: string
    epoch: number
    logicalNonce: string
    threadId: string
  }): string | 'cancelled' | 'input-changed' {
    const clientUserMessageId = `${requireText(options.interjectionId, 'interjectionId')}:answer`
    const prepare = this.db.transaction(() => {
      const job = this.db.query<{
        input_revision: number
        cancel_requested_at: number | null
        executor_nonce: string | null
        active_thread_id: string | null
        active_turn_id: string | null
      }, [string, number]>(
        `SELECT input_revision, cancel_requested_at, executor_nonce,
                active_thread_id, active_turn_id
         FROM jobs WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND control_epoch = ?`,
      ).get(options.jobId, Math.floor(options.epoch))
      if (!job || job.executor_nonce !== options.logicalNonce
        || job.active_thread_id !== options.threadId || job.active_turn_id !== null) {
        throw new Error(`interjection answer boundary changed for ${options.interjectionId}`)
      }
      if (job.cancel_requested_at !== null) return 'cancelled' as const
      const row = this.db.query<JobInterjectionRow, [string, string, number]>(
        `SELECT current.* FROM job_interjections AS current
         WHERE current.id = ? AND current.job_id = ? AND current.control_epoch = ?
           AND NOT EXISTS (
             SELECT 1 FROM job_interjections AS prior
             WHERE prior.job_id = current.job_id
               AND prior.control_epoch = current.control_epoch
               AND prior.seq < current.seq
               AND prior.status NOT IN ('promoted', 'superseded')
           )`,
      ).get(options.interjectionId, options.jobId, Math.floor(options.epoch))
      if (!row || !['ready', 'paused'].includes(row.status)) {
        throw new Error(`interjection is not ready for an answer: ${options.interjectionId}`)
      }
      if (row.input_revision !== job.input_revision) return 'input-changed' as const
      const updated = this.db.run(
        `UPDATE job_interjections SET status = 'answer-prepared',
           answer_logical_nonce = ?, answer_thread_id = ?, answer_prepared_at = ?,
           answer_request_id = NULL, answer_turn_id = NULL, last_error = NULL
         WHERE id = ? AND status IN ('ready', 'paused')`,
        [options.logicalNonce, options.threadId, Date.now(), options.interjectionId],
      )
      if (updated.changes !== 1) {
        throw new Error(`interjection answer receipt was not prepared: ${options.interjectionId}`)
      }
      return 'prepared' as const
    })
    const result = retrySqlite(() => prepare.immediate())
    return result === 'prepared' ? clientUserMessageId : result
  }

  beginInterjectionAnswer(options: {
    interjectionId: string
    jobId: string
    epoch: number
    logicalNonce: string
    threadId: string
    requestId: number
  }): 'dispatching' | 'cancelled' | 'input-changed' {
    const begin = this.db.transaction(() => {
      const job = this.db.query<{
        input_revision: number
        cancel_requested_at: number | null
        executor_nonce: string | null
        active_thread_id: string | null
        active_turn_id: string | null
      }, [string, number]>(
        `SELECT input_revision, cancel_requested_at, executor_nonce,
                active_thread_id, active_turn_id
         FROM jobs WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND control_epoch = ?`,
      ).get(options.jobId, Math.floor(options.epoch))
      if (!job || job.executor_nonce !== options.logicalNonce
        || job.active_thread_id !== options.threadId || job.active_turn_id !== null) {
        throw new Error(`interjection answer dispatch boundary changed for ${options.interjectionId}`)
      }
      if (job.cancel_requested_at !== null) return 'cancelled' as const
      const row = this.db.query<{ input_revision: number }, [string, string, string]>(
        `SELECT input_revision FROM job_interjections
         WHERE id = ? AND status = 'answer-prepared' AND answer_logical_nonce = ?
           AND answer_thread_id = ?`,
      ).get(options.interjectionId, options.logicalNonce, options.threadId)
      if (!row) throw new Error(`interjection answer receipt changed: ${options.interjectionId}`)
      if (row.input_revision !== job.input_revision) return 'input-changed' as const
      const updated = this.db.run(
        `UPDATE job_interjections SET status = 'answering', answer_request_id = ?,
           answer_dispatched_at = ?
         WHERE id = ? AND status = 'answer-prepared'`,
        [options.requestId, Date.now(), options.interjectionId],
      )
      if (updated.changes !== 1) {
        throw new Error(`interjection answer dispatch changed: ${options.interjectionId}`)
      }
      return 'dispatching' as const
    })
    return retrySqlite(() => begin.immediate())
  }

  acknowledgeInterjectionAnswer(options: {
    interjectionId: string
    jobId: string
    workerId: string
    epoch: number
    logicalNonce: string
    threadId: string
    turnId: string
    requestId: number
  }): void {
    const acknowledge = this.db.transaction(() => {
      const now = Date.now()
      const receipt = this.db.run(
        `UPDATE job_interjections SET answer_turn_id = ?, answer_acknowledged_at = ?
         WHERE id = ? AND job_id = ? AND control_epoch = ? AND status = 'answering'
           AND answer_request_id = ? AND answer_logical_nonce = ? AND answer_thread_id = ?`,
        [
          options.turnId, now, options.interjectionId, options.jobId,
          Math.floor(options.epoch), options.requestId, options.logicalNonce, options.threadId,
        ],
      )
      if (receipt.changes !== 1) {
        throw new Error(`interjection answer acknowledgement changed: ${options.interjectionId}`)
      }
      const binding = this.db.run(
        `UPDATE jobs SET active_turn_id = ?
         WHERE id = ? AND runtime = 'codex' AND status = 'running' AND worker_id = ?
           AND control_epoch = ? AND executor_nonce = ? AND active_thread_id = ?
           AND active_turn_id IS NULL`,
        [
          options.turnId, options.jobId, requireText(options.workerId, 'workerId'),
          Math.floor(options.epoch), options.logicalNonce, options.threadId,
        ],
      )
      if (binding.changes !== 1) {
        throw new Error(`interjection answer turn binding changed: ${options.interjectionId}`)
      }
    })
    retrySqlite(() => acknowledge.immediate())
  }

  stageInterjectionAnswer(options: {
    interjectionId: string
    jobId: string
    epoch: number
    logicalNonce: string
    threadId: string
    turnId: string
    disposition: JobInterjectionDisposition
    answer: string
  }): 'staged' | 'duplicate' | 'cancelled' {
    const answer = requireText(options.answer, 'interjectionAnswer')
    if (answer.length > 12_000) throw new Error('interjection answer is too long')
    const stage = this.db.transaction(() => {
      const job = this.db.query<{
        cancel_requested_at: number | null
        executor_nonce: string | null
        active_thread_id: string | null
        active_turn_id: string | null
      }, [string, number]>(
        `SELECT cancel_requested_at, executor_nonce, active_thread_id, active_turn_id
         FROM jobs WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND control_epoch = ?`,
      ).get(options.jobId, Math.floor(options.epoch))
      if (!job || job.executor_nonce !== options.logicalNonce
        || job.active_thread_id !== options.threadId || job.active_turn_id !== options.turnId) {
        throw new Error(`interjection answer terminal binding changed: ${options.interjectionId}`)
      }
      const existing = this.db.query<JobInterjectionRow, [string]>(
        'SELECT * FROM job_interjections WHERE id = ?',
      ).get(options.interjectionId)
      if (existing?.status === 'answered' || existing?.status === 'delivered'
        || existing?.status === 'promoted') {
        if (existing.disposition !== options.disposition || existing.answer_payload !== answer) {
          throw new Error(`interjection answer changed after staging: ${options.interjectionId}`)
        }
        return 'duplicate' as const
      }
      if (!existing || existing.status !== 'answering'
        || existing.answer_logical_nonce !== options.logicalNonce
        || existing.answer_thread_id !== options.threadId
        || existing.answer_turn_id !== options.turnId) {
        throw new Error(`interjection answer receipt changed: ${options.interjectionId}`)
      }
      if (job.cancel_requested_at !== null) return 'cancelled' as const
      const notificationId = existing.notification_id ?? randomUUID()
      const now = Date.now()
      const updated = this.db.run(
        `UPDATE job_interjections SET status = 'answered', disposition = ?,
           answer_payload = ?, notification_id = ?, answered_at = ?,
           attempts = 0, not_before = NULL, last_error = NULL
         WHERE id = ? AND status = 'answering'`,
        [options.disposition, answer, notificationId, now, options.interjectionId],
      )
      if (updated.changes !== 1) {
        throw new Error(`interjection answer was not staged: ${options.interjectionId}`)
      }
      const released = this.db.run(
        `UPDATE jobs SET active_turn_id = NULL
         WHERE id = ? AND control_epoch = ? AND executor_nonce = ?
           AND active_thread_id = ? AND active_turn_id = ?`,
        [options.jobId, Math.floor(options.epoch), options.logicalNonce,
          options.threadId, options.turnId],
      )
      if (released.changes !== 1) {
        throw new Error(`interjection answer turn was not released: ${options.interjectionId}`)
      }
      return 'staged' as const
    })
    return retrySqlite(() => stage.immediate())
  }

  finishAppServerTurn(options: {
    jobId: string
    epoch: number
    executorNonce: string
    threadId: string
    turnId: string
    retainInput?: boolean
    rateLimitResumeAt?: number
  }): { closeInput: boolean; cancelled: boolean; pending: number; pendingInbound: number } {
    if (options.rateLimitResumeAt !== undefined
      && (!Number.isSafeInteger(options.rateLimitResumeAt)
        || options.rateLimitResumeAt <= 0)) {
      throw new Error('App Server rate-limit resume time is invalid')
    }
    const finish = this.db.transaction(() => {
      const job = this.db.query<{
        executor_nonce: string | null
        active_thread_id: string | null
        active_turn_id: string | null
        cancel_requested_at: number | null
        attempts: number
        chat_id: string
        thread_ts: string
      }, [string, number]>(
        `SELECT executor_nonce, active_thread_id, active_turn_id, cancel_requested_at, attempts,
                chat_id, thread_ts
         FROM jobs WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND control_epoch = ?`,
      ).get(options.jobId, Math.floor(options.epoch))
      if (!job || job.executor_nonce !== options.executorNonce
        || job.active_thread_id !== options.threadId || job.active_turn_id !== options.turnId) {
        throw new Error(`App Server terminal binding changed for ${options.jobId}`)
      }
      const now = Date.now()
      const initialReceipt = this.db.query<{
        status: string
        turn_id: string | null
      }, [string, number]>(
        `SELECT status, turn_id FROM job_initial_dispatches
         WHERE job_id = ? AND attempt = ?`,
      ).get(options.jobId, job.attempts)
      if (initialReceipt?.turn_id === options.turnId) {
        if (initialReceipt.status === 'acknowledged') {
          const observed = this.db.run(
            `UPDATE job_initial_dispatches SET status = 'observed', observed_at = ?
             WHERE job_id = ? AND attempt = ? AND status = 'acknowledged'
               AND executor_nonce = ? AND app_thread_id = ? AND turn_id = ?`,
            [
              now, options.jobId, job.attempts, options.executorNonce,
              options.threadId, options.turnId,
            ],
          )
          if (observed.changes !== 1) {
            throw new Error(`initial App Server terminal receipt changed for ${options.jobId}`)
          }
        } else if (initialReceipt.status !== 'observed') {
          throw new Error(`initial App Server terminal receipt changed for ${options.jobId}`)
        }
      }
      const phaseReceipt = this.db.query<{
        phase_sequence: number
        status: string
      }, [string, number, string]>(
        `SELECT phase_sequence, status FROM job_phase_dispatches
         WHERE job_id = ? AND attempt = ? AND turn_id = ?`,
      ).get(options.jobId, job.attempts, options.turnId)
      if (phaseReceipt) {
        if (phaseReceipt.status === 'acknowledged') {
          const observed = this.db.run(
            `UPDATE job_phase_dispatches SET status = 'observed', observed_at = ?
             WHERE job_id = ? AND attempt = ? AND phase_sequence = ?
               AND status = 'acknowledged' AND logical_nonce = ?
               AND app_thread_id = ? AND turn_id = ?`,
            [
              now, options.jobId, job.attempts, phaseReceipt.phase_sequence,
              options.executorNonce, options.threadId, options.turnId,
            ],
          )
          if (observed.changes !== 1) {
            throw new Error(`App Server phase terminal receipt changed for ${options.jobId}`)
          }
        } else if (phaseReceipt.status !== 'observed') {
          throw new Error(`App Server phase terminal receipt changed for ${options.jobId}`)
        }
      }
      this.db.run(
        `UPDATE job_controls SET status = 'observed', observed_at = ?
         WHERE job_id = ? AND control_epoch = ? AND status = 'acknowledged'
           AND executor_nonce = ? AND app_thread_id = ? AND turn_id = ?`,
        [
          now, options.jobId, Math.floor(options.epoch), options.executorNonce,
          options.threadId, options.turnId,
        ],
      )
      this.db.run(
        `UPDATE job_interjections SET status = 'paused', paused_at = ?
         WHERE job_id = ? AND control_epoch = ? AND status = 'pausing'
           AND pause_executor_nonce = ? AND pause_thread_id = ? AND pause_turn_id = ?`,
        [
          now, options.jobId, Math.floor(options.epoch), options.executorNonce,
          options.threadId, options.turnId,
        ],
      )
      const pendingControls = this.db.query<{ count: number }, [string, number]>(
        `SELECT COUNT(*) AS count FROM job_controls
         WHERE job_id = ? AND control_epoch = ? AND status = 'ready'`,
      ).get(options.jobId, Math.floor(options.epoch))?.count ?? 0
      const pendingInterjections = this.db.query<{ count: number }, [string, number]>(
        `SELECT COUNT(*) AS count FROM job_interjections
         WHERE job_id = ? AND control_epoch = ? AND status IN ('ready', 'paused')`,
      ).get(options.jobId, Math.floor(options.epoch))?.count ?? 0
      const pending = pendingControls + pendingInterjections
      const pendingInbound = this.db.query<{ count: number }, [string, string]>(
        `SELECT COUNT(*) AS count FROM inbound_deliveries
         WHERE chat_id = ? AND thread_ts = ?`,
      ).get(job.chat_id, job.thread_ts)?.count ?? 0
      const cancelled = job.cancel_requested_at !== null
      const retainInput = options.retainInput === true && !cancelled
      const closeInput = cancelled || (!retainInput && pending === 0 && pendingInbound === 0)
      // The inbound drain converts a Slack reply into a durable job_control
      // asynchronously.  Keep the just-finished turn bound while such rows
      // exist, even at a retainInput phase boundary, because the executor must
      // call finishAppServerTurn again after that conversion settles.  Once the
      // inbound ledger is empty the next call releases the terminal binding.
      const holdTerminalBinding = !cancelled && pendingInbound > 0
      this.db.run(
        `UPDATE jobs SET accepts_control = ?,
           active_turn_id = CASE WHEN ? THEN active_turn_id ELSE NULL END,
           not_before = COALESCE(?, not_before),
           session_id = CASE WHEN ? IS NULL THEN session_id ELSE ? END
         WHERE id = ? AND control_epoch = ?`,
        [
          cancelled ? 0 : (retainInput || pending > 0 || pendingInbound > 0 ? 1 : 0),
          holdTerminalBinding ? 1 : 0,
          options.rateLimitResumeAt ?? null,
          options.rateLimitResumeAt ?? null,
          options.threadId,
          options.jobId,
          Math.floor(options.epoch),
        ],
      )
      return { closeInput, cancelled, pending, pendingInbound }
    })
    return retrySqlite(() => finish.immediate())
  }

  sealAppServerPhaseResult(options: {
    jobId: string
    epoch: number
    logicalNonce: string
    threadId: string
    inputRevision: number
    inputDigest: string
  }): 'sealed' | 'input-changed' | 'cancelled' | 'pending-inbound' {
    const seal = this.db.transaction(() => {
      const job = this.db.query<{
        id: string
        message_id: string
        user_id: string
        write_enabled: number
        task: string
        attachments_json: string
        input_revision: number
        cancel_requested_at: number | null
        chat_id: string
        thread_ts: string
        executor_nonce: string | null
        active_thread_id: string | null
        active_turn_id: string | null
      }, [string, number]>(
        `SELECT id, message_id, user_id, write_enabled, task, attachments_json, input_revision,
                cancel_requested_at, chat_id, thread_ts, executor_nonce,
                active_thread_id, active_turn_id
         FROM jobs WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND control_epoch = ?`,
      ).get(options.jobId, Math.floor(options.epoch))
      if (!job || job.executor_nonce !== options.logicalNonce
        || job.active_thread_id !== options.threadId || job.active_turn_id !== null) {
        throw new Error(`App Server result seal binding changed for ${options.jobId}`)
      }
      if (job.cancel_requested_at !== null) return 'cancelled' as const
      const pendingInbound = this.db.query<{ count: number }, [string, string]>(
        `SELECT COUNT(*) AS count FROM inbound_deliveries
         WHERE chat_id = ? AND thread_ts = ?`,
      ).get(job.chat_id, job.thread_ts)?.count ?? 0
      if (pendingInbound > 0) return 'pending-inbound' as const
      const pendingInterjections = this.db.query<{ count: number }, [string, number]>(
        `SELECT COUNT(*) AS count FROM job_interjections
         WHERE job_id = ? AND control_epoch = ?
           AND status NOT IN ('promoted', 'superseded')`,
      ).get(options.jobId, Math.floor(options.epoch))?.count ?? 0
      if (pendingInterjections > 0) return 'pending-inbound' as const
      const ready = this.db.query<{ count: number }, [string, number]>(
        `SELECT COUNT(*) AS count FROM job_controls
         WHERE job_id = ? AND control_epoch = ? AND status = 'ready'`,
      ).get(options.jobId, Math.floor(options.epoch))?.count ?? 0
      if (ready > 0) return 'input-changed' as const
      const controls = this.db.query<{
        input_revision: number
        message_id: string
        user_id: string
        write_enabled: number
        task: string
        attachments_json: string
      }, [string]>(
        `SELECT input_revision, message_id, user_id, write_enabled, task, attachments_json
         FROM job_controls WHERE job_id = ? AND kind = 'steer'
         ORDER BY input_revision ASC, seq ASC`,
      ).all(options.jobId)
      const snapshot = createAdvisorInputSnapshot(job, controls)
      if (snapshot.revision !== options.inputRevision
        || snapshot.digest !== options.inputDigest) return 'input-changed' as const
      const updated = this.db.run(
        `UPDATE jobs SET accepts_control = 0
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND control_epoch = ? AND executor_nonce = ? AND active_thread_id = ?
           AND active_turn_id IS NULL AND cancel_requested_at IS NULL`,
        [options.jobId, Math.floor(options.epoch), options.logicalNonce, options.threadId],
      )
      if (updated.changes !== 1) throw new Error(`App Server result seal changed for ${options.jobId}`)
      return 'sealed' as const
    })
    return retrySqlite(() => seal.immediate())
  }

  recordAppServerRateLimit(options: {
    jobId: string
    epoch: number
    executorNonce: string
    threadId: string
    turnId: string
    resumeAt: number
  }): void {
    if (!Number.isSafeInteger(options.resumeAt) || options.resumeAt <= 0) {
      throw new Error('App Server rate-limit resume time is invalid')
    }
    const recordRateLimit = this.db.transaction(() => {
      const recordedAt = Date.now()
      const job = this.db.query<{
        attempts: number
        executor_nonce: string | null
        active_thread_id: string | null
        active_turn_id: string | null
        cancel_requested_at: number | null
      }, [string, number]>(
        `SELECT attempts, executor_nonce, active_thread_id, active_turn_id, cancel_requested_at
         FROM jobs WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND control_epoch = ?`,
      ).get(options.jobId, Math.floor(options.epoch))
      if (!job || job.executor_nonce !== options.executorNonce
        || job.active_thread_id !== options.threadId || job.active_turn_id !== options.turnId) {
        throw new Error(`App Server rate-limit binding changed for ${options.jobId}`)
      }
      this.recordCodexSessionUse(options.threadId, options.jobId, recordedAt)
      const receipt = this.db.query<{ status: string; turn_id: string | null }, [string, number]>(
        `SELECT status, turn_id FROM job_initial_dispatches
         WHERE job_id = ? AND attempt = ?`,
      ).get(options.jobId, job.attempts)
      if (!receipt) throw new Error(`initial App Server receipt is missing for ${options.jobId}`)
      if (receipt.turn_id === options.turnId && receipt.status === 'acknowledged') {
        const observed = this.db.run(
          `UPDATE job_initial_dispatches SET status = 'observed', observed_at = ?
           WHERE job_id = ? AND attempt = ? AND status = 'acknowledged'
             AND executor_nonce = ? AND app_thread_id = ? AND turn_id = ?`,
          [
            Date.now(), options.jobId, job.attempts, options.executorNonce,
            options.threadId, options.turnId,
          ],
        )
        if (observed.changes !== 1) {
          throw new Error(`initial App Server rate-limit receipt changed for ${options.jobId}`)
        }
      } else if (receipt.status !== 'observed') {
        throw new Error(`initial App Server rate-limit receipt is unsafe for ${options.jobId}`)
      }
      this.db.run(
        `UPDATE job_controls SET status = 'observed', observed_at = ?
         WHERE job_id = ? AND control_epoch = ? AND status = 'acknowledged'
           AND executor_nonce = ? AND app_thread_id = ? AND turn_id = ?`,
        [
          Date.now(), options.jobId, Math.floor(options.epoch), options.executorNonce,
          options.threadId, options.turnId,
        ],
      )
      this.db.run(
        `UPDATE job_interjections
         SET status = 'ready', pause_request_id = NULL,
             pause_executor_nonce = NULL, pause_thread_id = NULL, pause_turn_id = NULL,
             pause_dispatched_at = NULL, pause_acknowledged_at = NULL,
             last_error = 'pause turn reached an authoritative rate-limit terminal and may retry'
         WHERE job_id = ? AND control_epoch = ? AND status = 'pausing'
           AND pause_executor_nonce = ? AND pause_thread_id = ? AND pause_turn_id = ?`,
        [
          options.jobId, Math.floor(options.epoch), options.executorNonce,
          options.threadId, options.turnId,
        ],
      )
      this.db.run(
        `UPDATE job_interjections
         SET status = CASE WHEN paused_at IS NULL THEN 'ready' ELSE 'paused' END,
             answer_request_id = NULL, answer_logical_nonce = NULL,
             answer_thread_id = NULL, answer_turn_id = NULL,
             answer_prepared_at = NULL, answer_dispatched_at = NULL,
             answer_acknowledged_at = NULL,
             last_error = 'answer turn reached an authoritative rate-limit terminal and may retry'
         WHERE job_id = ? AND control_epoch = ? AND status = 'answering'
           AND answer_logical_nonce = ? AND answer_thread_id = ? AND answer_turn_id = ?`,
        [
          options.jobId, Math.floor(options.epoch), options.executorNonce,
          options.threadId, options.turnId,
        ],
      )
      const updated = this.db.run(
        `UPDATE jobs SET not_before = ?, session_id = ?,
           accepts_control = CASE WHEN cancel_requested_at IS NULL THEN 1 ELSE 0 END,
           active_turn_id = NULL
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND control_epoch = ?`,
        [options.resumeAt, options.threadId, options.jobId, Math.floor(options.epoch)],
      )
      if (updated.changes !== 1) {
        throw new Error(`App Server rate-limit state changed for ${options.jobId}`)
      }
    })
    retrySqlite(() => recordRateLimit.immediate())
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
           repo_path, task, attachments_json, runtime, write_enabled, status,
           control_epoch, accepts_control, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'codex', ?, 'queued', 1, 1, ?)`,
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
         WHERE ${CLAIMABLE_CODEX_JOB_PREDICATE} AND jobs.seq <= ?`,
      ).get(row.seq)?.position ?? 0
      const hasRunning = this.db.query<{ present: number }, []>(
        "SELECT 1 AS present FROM jobs WHERE runtime = 'codex' AND status = 'running' LIMIT 1",
      ).get() !== null

      if (result.changes === 1 && input.notifyAccepted) {
        const waitingPosition = Math.max(1, position)
        this.stageStatusNotificationRow({
          idempotencyKey: `accepted:${idempotencyKey}`,
          jobId: row.id,
          chatId,
          threadTs,
          kind: 'accepted',
          payload: hasRunning || waitingPosition > 1
            ? `🙌 受け付けました（待ち順 ${waitingPosition}）。`
            : '🙌 受け付けました。',
          createdAt: Date.now(),
        })
      }

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
    const head = this.db.query<{
      not_before: number | null
      cancel_requested_at: number | null
    }, []>(
      `SELECT not_before, cancel_requested_at FROM jobs
       WHERE ${CLAIMABLE_CODEX_JOB_PREDICATE}
       ORDER BY seq ASC LIMIT 1`,
    ).get()
    return head && (head.cancel_requested_at !== null
      || head.not_before === null || head.not_before <= now) ? 1 : 0
  }

  claimableHeadId(now = Date.now()): string | null {
    const head = this.db.query<{
      id: string
      not_before: number | null
      cancel_requested_at: number | null
    }, []>(
      `SELECT id, not_before, cancel_requested_at FROM jobs
       WHERE ${CLAIMABLE_CODEX_JOB_PREDICATE}
       ORDER BY seq ASC LIMIT 1`,
    ).get()
    return head && (head.cancel_requested_at !== null
      || head.not_before === null || head.not_before <= now) ? head.id : null
  }

  claimNext(
    workerId: string,
    maxJobsPerSession: number = DEFAULT_MAX_JOBS_PER_SESSION,
    now = Date.now(),
  ): JobRecord | null {
    const sessionJobLimit = Math.min(
      DEFAULT_MAX_JOBS_PER_SESSION,
      Math.max(1, Math.floor(maxJobsPerSession)),
    )
    const claim = this.db.transaction((claimingWorkerId: string, claimAt: number): JobRecord | null => {
      const active = this.db.query<{ present: number }, []>(
        "SELECT 1 AS present FROM jobs WHERE runtime = 'codex' AND status = 'running' LIMIT 1",
      ).get()
      if (active) return null
      const row = this.db.query<JobRow, []>(
        `SELECT * FROM jobs
         WHERE ${CLAIMABLE_CODEX_JOB_PREDICATE}
         ORDER BY seq ASC
         LIMIT 1`,
      ).get()
      if (!row) return null
      if (row.cancel_requested_at === null
        && row.not_before !== null && row.not_before > claimAt) return null

      const sessionUsesCurrentProtocol = (sessionId: string): boolean => (
        this.db.query<{ present: number }, [string, number]>(
          `SELECT 1 AS present FROM codex_session_protocols
           WHERE session_id = ? AND protocol_version = ?`,
        ).get(sessionId, CODEX_SESSION_PROTOCOL_VERSION) !== null
      )
      const isRetry = row.attempts > 0 && row.session_id !== null
        && sessionUsesCurrentProtocol(row.session_id)
      let sessionId: string | null
      let resumed: boolean
      if (isRetry) {
        sessionId = row.session_id!
        resumed = true
      } else {
        const prior = this.db.query<
          { session_id: string },
          [string, string, string, number, number]
        >(
          `SELECT jobs.session_id
           FROM jobs
           JOIN codex_session_protocols protocols
             ON protocols.session_id = jobs.session_id
            AND protocols.protocol_version = ${CODEX_SESSION_PROTOCOL_VERSION}
           LEFT JOIN codex_session_retirements retirements
             ON retirements.session_id = jobs.session_id
           WHERE jobs.runtime = 'codex'
             AND jobs.chat_id = ?
             AND jobs.thread_ts = ?
             AND jobs.repo_path = ?
             AND jobs.write_enabled = ?
             AND jobs.seq < ?
             AND jobs.session_id IS NOT NULL
             AND jobs.status = 'completed'
             AND retirements.session_id IS NULL
           ORDER BY jobs.seq DESC
           LIMIT 1`,
        ).get(
          row.chat_id,
          row.thread_ts,
          row.repo_path,
          row.write_enabled,
          row.seq,
        )
        const sessionJobCount = prior
          ? this.db.query<{ count: number }, [string]>(
            `SELECT COUNT(*) AS count
             FROM codex_session_job_uses
             WHERE session_id = ?`,
          ).get(prior.session_id)?.count ?? 0
          : 0
        resumed = prior !== null && sessionJobCount > 0 && sessionJobCount < sessionJobLimit
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
             pending_session_id = NULL,
             pending_result = NULL,
             last_error = NULL,
             control_epoch = CASE WHEN control_epoch = 0 THEN 1 ELSE control_epoch END,
             accepts_control = CASE WHEN cancel_requested_at IS NULL THEN 1 ELSE 0 END,
             executor_nonce = NULL,
             active_thread_id = NULL,
             active_turn_id = NULL,
             terminal_outcome = NULL
         WHERE id = ? AND status = 'queued' AND ui_approval_request_id IS NULL`,
        [sessionId, resumed ? 1 : 0, claimingWorkerId, claimAt, row.id],
      )
      if (update.changes !== 1) return null
      this.db.run(
        `INSERT INTO job_initial_dispatches (
           job_id, attempt, control_epoch, input_revision,
           client_user_message_id, status, prepared_at
         ) VALUES (?, ?, ?, ?, ?, 'prepared', ?)`,
        [
          row.id,
          row.attempts + 1,
          row.control_epoch === 0 ? 1 : row.control_epoch,
          row.input_revision,
          row.idempotency_key,
          claimAt,
        ],
      )
      return this.get(row.id)
    })

    return retrySqlite(() => claim.immediate(workerId, now))
  }

  complete(id: string, sessionId: string, result: string): void {
    const persistedSessionId = requireText(sessionId, 'sessionId')
    const complete = this.db.transaction(() => {
      const finishedAt = Date.now()
      this.recordCodexSessionUse(persistedSessionId, id, finishedAt)
      const updated = this.db.run(
        `UPDATE jobs
         SET status = 'completed', session_id = ?, result = ?, last_error = NULL,
             pending_session_id = NULL, pending_result = NULL,
             not_before = NULL, executor_pid = NULL,
             accepts_control = 0, executor_nonce = NULL,
             active_thread_id = NULL, active_turn_id = NULL,
             ui_approval_request_id = NULL,
             terminal_outcome = 'completed',
             finished_at = ?
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND cancel_requested_at IS NULL
           AND monitor_state != 3
           AND (executor_nonce IS NULL OR (accepts_control = 0 AND active_turn_id IS NULL))
           AND NOT EXISTS (SELECT 1 FROM monitor_failures WHERE job_id = jobs.id)
           AND NOT EXISTS (
             SELECT 1 FROM inbound_deliveries AS inbound
             WHERE inbound.chat_id = jobs.chat_id AND inbound.thread_ts = jobs.thread_ts
           )
           AND NOT EXISTS (
             SELECT 1 FROM job_interjections AS interjection
             WHERE interjection.job_id = jobs.id
               AND interjection.status NOT IN ('promoted', 'superseded')
           )`,
        [persistedSessionId, result, finishedAt, id],
      )
      if (updated.changes !== 1) throw new Error('job is no longer running: ' + id)
      this.db.run(
        `UPDATE ui_approval_requests SET status = 'superseded'
         WHERE job_id = ? AND status IN ('publishing', 'awaiting', 'responded')`,
        [id],
      )
      this.supersedeLifecycleNotifications(id, finishedAt)
      this.db.run(
        `INSERT INTO terminal_notifications (
           id, job_id, kind, payload, created_at
         ) VALUES (?, ?, 'completed', ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           kind = excluded.kind, payload = excluded.payload,
           attempts = 0, not_before = NULL, last_error = NULL,
           created_at = excluded.created_at, body_delivered_at = NULL,
           reaction_delivered_at = NULL, delivered_at = NULL`,
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

  stageExecutionResult(id: string, sessionId: string, result: string): void {
    const updated = retrySqlite(() => this.db.run(
      `UPDATE jobs
       SET pending_session_id = ?, pending_result = ?, executor_pid = NULL
       WHERE id = ? AND runtime = 'codex' AND status = 'running'
         AND pending_session_id IS NULL AND pending_result IS NULL`,
      [requireText(sessionId, 'sessionId'), result, id],
    ))
    if (updated.changes !== 1) throw new Error(`could not stage execution result for job ${id}`)
  }

  ensureExecutionResultStaged(id: string, sessionId: string, result: string): boolean {
    const persist = this.db.transaction(() => {
      const row = this.db.query<{
        status: JobStatus
        pending_session_id: string | null
        pending_result: string | null
      }, [string]>(
        `SELECT status, pending_session_id, pending_result FROM jobs
         WHERE id = ? AND runtime = 'codex'`,
      ).get(id)
      if (!row || row.status !== 'running') {
        throw new Error(`job is no longer running: ${id}`)
      }
      const persistedSession = requireText(sessionId, 'sessionId')
      if (row.pending_session_id !== null || row.pending_result !== null) {
        if (row.pending_session_id === persistedSession && row.pending_result === result) return false
        throw new Error(`job has a conflicting staged execution result: ${id}`)
      }
      const updated = this.db.run(
        `UPDATE jobs SET pending_session_id = ?, pending_result = ?, executor_pid = NULL
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND pending_session_id IS NULL AND pending_result IS NULL`,
        [persistedSession, result, id],
      )
      if (updated.changes !== 1) throw new Error(`could not stage execution result for job ${id}`)
      return true
    })
    return retrySqlite(() => persist.immediate())
  }

  assertExecutionResultStaged(id: string, sessionId: string, result: string): void {
    const row = this.db.query<{
      pending_session_id: string | null
      pending_result: string | null
    }, [string]>(
      `SELECT pending_session_id, pending_result FROM jobs
       WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
    ).get(id)
    if (row?.pending_session_id !== sessionId || row.pending_result !== result) {
      throw new Error(`executor returned before staging its result for job ${id}`)
    }
  }

  completeStagedExecution(id: string): void {
    const row = this.db.query<{
      pending_session_id: string | null
      pending_result: string | null
    }, [string]>(
      `SELECT pending_session_id, pending_result FROM jobs
       WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
    ).get(id)
    if (!row?.pending_session_id || row.pending_result === null) {
      throw new Error(`job has no staged execution result: ${id}`)
    }
    this.complete(id, row.pending_session_id, row.pending_result)
  }

  recoverStagedExecutions(): number {
    // A success checkpoint and a later durable Slack cancellation can coexist
    // if the daemon stops during owned advisor cleanup. Keep those rows in
    // stagedExecutionJobIds() so the monitor/advisor barriers still verify
    // them, but never publish the staged success. recoverInterrupted() will
    // terminalize the cancellation and discard the pending result afterward.
    const rows = this.db.query<{ id: string }, []>(
      `SELECT id FROM jobs
       WHERE runtime = 'codex' AND status = 'running'
         AND pending_session_id IS NOT NULL AND pending_result IS NOT NULL
         AND cancel_requested_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM inbound_deliveries AS inbound
           WHERE inbound.chat_id = jobs.chat_id AND inbound.thread_ts = jobs.thread_ts
         )
         AND NOT EXISTS (
           SELECT 1 FROM job_interjections AS interjection
           WHERE interjection.job_id = jobs.id
             AND interjection.status NOT IN ('promoted', 'superseded')
         )
       ORDER BY seq ASC`,
    ).all()
    for (const row of rows) this.completeStagedExecution(row.id)
    return rows.length
  }

  stagedExecutionJobIds(): string[] {
    return this.db.query<{ id: string }, []>(
      `SELECT id FROM jobs
       WHERE runtime = 'codex' AND status = 'running'
         AND pending_session_id IS NOT NULL AND pending_result IS NOT NULL
       ORDER BY seq ASC`,
    ).all().map(row => row.id)
  }

  hasStagedExecution(id: string): boolean {
    return this.db.query<{ present: number }, [string]>(
      `SELECT 1 AS present FROM jobs
       WHERE id = ? AND runtime = 'codex' AND status = 'running'
         AND pending_session_id IS NOT NULL AND pending_result IS NOT NULL`,
    ).get(id) !== null
  }

  beginMonitorPreparation(id: string, workerId: string): void {
    const updated = retrySqlite(() => this.db.run(
      `UPDATE jobs SET monitor_state = 1
       WHERE id = ? AND runtime = 'codex' AND status = 'running'
         AND worker_id = ? AND executor_pid IS NULL
         AND pending_session_id IS NULL AND pending_result IS NULL
         AND monitor_state = 0`,
      [id, workerId],
    ))
    if (updated.changes !== 1) {
      const current = this.get(id)
      if (current?.status !== 'running' || current.workerId !== workerId
        || !['preparing', 'required'].includes(current.monitorState)) {
        throw new Error(`could not begin Herdr monitor preparation for job ${id}`)
      }
    }
  }

  commitMonitorRequired(id: string, workerId: string): void {
    const updated = retrySqlite(() => this.db.run(
      `UPDATE jobs SET monitor_state = 2
       WHERE id = ? AND runtime = 'codex' AND status = 'running'
         AND worker_id = ? AND executor_pid IS NULL
         AND pending_session_id IS NULL AND pending_result IS NULL
         AND monitor_state = 1`,
      [id, workerId],
    ))
    if (updated.changes !== 1) {
      const current = this.get(id)
      if (current?.status !== 'running' || current.workerId !== workerId
        || current.monitorState !== 'required') {
        throw new Error(`could not commit Herdr monitor requirement for job ${id}`)
      }
    }
  }

  releaseUnarmedMonitorPreparation(id: string): boolean {
    return retrySqlite(() => this.db.run(
      `UPDATE jobs SET monitor_state = 0
       WHERE id = ? AND runtime = 'codex' AND status IN ('queued', 'running')
         AND monitor_state = 1 AND executor_pid IS NULL
         AND pending_session_id IS NULL AND pending_result IS NULL`,
      [id],
    )).changes === 1
  }

  retireMonitorObligation(id: string): void {
    retrySqlite(() => this.db.run(
      `UPDATE jobs SET monitor_state = 0
       WHERE id = ? AND runtime = 'codex'
         AND (status IN ('completed', 'failed')
           OR (status = 'queued' AND ui_approval_request_id IS NOT NULL))`,
      [id],
    ))
  }

  recordMonitorFailure(id: string, reason: string): void {
    const digest = createHash('sha256').update(reason).digest('hex')
    const inserted = retrySqlite(() => this.db.run(
      `INSERT INTO monitor_failures (job_id, reason_digest, created_at)
       SELECT id, ?, ? FROM jobs
       WHERE id = ? AND runtime = 'codex' AND monitor_state = 2
       ON CONFLICT(job_id) DO NOTHING`,
      [digest, Date.now(), id],
    ))
    if (inserted.changes !== 1) {
      const existing = this.db.query<{ reason_digest: string }, [string]>(
        'SELECT reason_digest FROM monitor_failures WHERE job_id = ?',
      ).get(id)
      if (!existing) throw new Error(`could not persist Herdr monitor failure for job ${id}`)
    }
  }

  monitorFailure(id: string): { reasonDigest: string; createdAt: number } | null {
    const row = this.db.query<{
      reason_digest: string
      created_at: number
    }, [string]>(
      'SELECT reason_digest, created_at FROM monitor_failures WHERE job_id = ?',
    ).get(id)
    return row ? { reasonDigest: row.reason_digest, createdAt: row.created_at } : null
  }

  markMonitorLostAfterStagedResult(id: string): boolean {
    return retrySqlite(() => this.db.run(
      `UPDATE jobs SET monitor_state = 3
       WHERE id = ? AND runtime = 'codex' AND status = 'running'
         AND monitor_state = 2
         AND pending_session_id IS NOT NULL AND pending_result IS NOT NULL`,
      [id],
    )).changes === 1
  }

  monitorObligations(): Array<{
    id: string
    status: JobStatus
    state: 'preparing' | 'required' | 'lost-staged'
  }> {
    const fault = this.db.query<{
      job_id: string
      reason_digest: string
    }, []>(
      `SELECT job_id, reason_digest FROM monitor_failures ORDER BY created_at ASC LIMIT 1`,
    ).get()
    if (fault) {
      throw new HerdrJobMonitorPendingError(
        `durable Herdr monitor failure blocks queue recovery for ${fault.job_id} (${fault.reason_digest})`,
      )
    }
    return this.db.query<{
      id: string
      status: JobStatus
      monitor_state: number
      executor_pid: number | null
      pending_session_id: string | null
      pending_result: string | null
    }, []>(
      `SELECT id, status, monitor_state, executor_pid, pending_session_id, pending_result FROM jobs
       WHERE runtime = 'codex' AND monitor_state IN (1, 2, 3)
       ORDER BY seq ASC`,
    ).all().map(row => {
      if (row.monitor_state === 3 && (row.status !== 'running'
        || row.executor_pid !== null || !row.pending_session_id || row.pending_result === null)) {
        throw new Error(`lost-staged monitor state is inconsistent for job ${row.id}`)
      }
      return {
        id: row.id,
        status: row.status,
        state: row.monitor_state === 1
          ? 'preparing' as const
          : row.monitor_state === 2 ? 'required' as const : 'lost-staged' as const,
      }
    })
  }

  saveSession(id: string, sessionId: string): void {
    const persistedSessionId = requireText(sessionId, 'sessionId')
    const save = this.db.transaction(() => {
      const recordedAt = Date.now()
      this.recordCodexSessionUse(persistedSessionId, id, recordedAt)
      const updated = this.db.run(
        `UPDATE jobs SET session_id = ?
         WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
        [persistedSessionId, id],
      )
      if (updated.changes !== 1) throw new Error(`job is no longer running: ${id}`)
    })
    retrySqlite(() => save.immediate())
  }

  saveExecutorPid(id: string, executorPid: number): void {
    if (!Number.isInteger(executorPid) || executorPid <= 0) {
      throw new Error('invalid executor PID: ' + executorPid)
    }
    const updated = retrySqlite(() => this.db.run(
      `UPDATE jobs SET executor_pid = ?
       WHERE id = ? AND runtime = 'codex' AND status = 'running' AND monitor_state = 2`,
      [executorPid, id],
    ))
    if (updated.changes !== 1) {
      throw new Error('job is not running with a durable Herdr monitor: ' + id)
    }
  }

  clearExecutorPid(id: string, executorPid: number): void {
    retrySqlite(() => this.db.run(
      `UPDATE jobs SET executor_pid = NULL
       WHERE id = ? AND runtime = 'codex' AND status = 'running' AND executor_pid = ?`,
      [id, executorPid],
    ))
  }

  clearExecutorPidAfterExit(id: string, executorPid: number): void {
    const updated = retrySqlite(() => this.db.run(
      `UPDATE jobs SET executor_pid = NULL
       WHERE id = ? AND runtime = 'codex' AND status = 'running' AND executor_pid = ?`,
      [id, executorPid],
    ))
    if (updated.changes !== 1) {
      throw new Error(`executor PID exit binding changed for job ${id}`)
    }
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

  /**
   * Pin a Slack thread to the first accepted repository before attachment I/O
   * or enqueueing begins. The immediate transaction makes concurrent gateway
   * generations converge on the row that won the first insert, so a project
   * switch cannot split one Slack thread across repositories.
   */
  resolveOrAdoptThread(input: {
    chatId: string
    threadTs: string
    repoPath: string
    adoptedFromTs: string
    lastActivityMs?: number
  }): {
    chatId: string
    threadTs: string
    repoPath: string
    adoptedFromTs: string
    lastActivityMs: number
  } {
    const chatId = requireText(input.chatId, 'chatId')
    const threadTs = requireText(input.threadTs, 'threadTs')
    const repoPath = requireText(input.repoPath, 'repoPath')
    const adoptedFromTs = requireText(input.adoptedFromTs, 'adoptedFromTs')
    const lastActivityMs = input.lastActivityMs ?? Date.now()
    if (!Number.isSafeInteger(lastActivityMs) || lastActivityMs <= 0) {
      throw new Error('thread activity timestamp is invalid')
    }
    const pin = this.db.transaction(() => {
      this.db.run(
        `INSERT OR IGNORE INTO slack_threads (
           chat_id, thread_ts, repo_path, adopted_from_ts, last_activity_ms
         ) VALUES (?, ?, ?, ?, ?)`,
        [chatId, threadTs, repoPath, adoptedFromTs, lastActivityMs],
      )
      const row = this.db.query<{
        chat_id: string
        thread_ts: string
        repo_path: string
        adopted_from_ts: string
        last_activity_ms: number
      }, [string, string]>(
        'SELECT * FROM slack_threads WHERE chat_id = ? AND thread_ts = ?',
      ).get(chatId, threadTs)
      if (!row) throw new Error('failed to pin Slack thread repository')
      return {
        chatId: row.chat_id,
        threadTs: row.thread_ts,
        repoPath: row.repo_path,
        adoptedFromTs: row.adopted_from_ts,
        lastActivityMs: row.last_activity_ms,
      }
    })
    return retrySqlite(() => pin.immediate())
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

  suspendUnavailableSlackThreadPoll(input: {
    chatId: string
    threadTs: string
    observedLastActivityMs: number
  }): boolean {
    const chatId = requireText(input.chatId, 'chatId')
    const threadTs = requireText(input.threadTs, 'threadTs')
    const observedLastActivityMs = input.observedLastActivityMs
    if (!Number.isSafeInteger(observedLastActivityMs) || observedLastActivityMs <= 1) {
      return false
    }
    return retrySqlite(() => this.db.run(
      `UPDATE slack_threads
       SET last_activity_ms = 1
       WHERE chat_id = ? AND thread_ts = ? AND last_activity_ms = ?`,
      [chatId, threadTs, observedLastActivityMs],
    ).changes === 1)
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

  private settleInterjectionsForTerminal(
    jobId: string,
    kind: 'failed' | 'cancelled',
    now: number,
  ): void {
    if (kind === 'cancelled') {
      this.db.run(
        `UPDATE job_interjections SET status = 'superseded',
           last_error = 'superseded by terminal Slack cancellation'
         WHERE job_id = ? AND status NOT IN ('promoted', 'superseded')`,
        [jobId],
      )
      return
    }
    this.db.run(
      `UPDATE job_interjections SET status = 'superseded',
         last_error = 'job failed before this interjection could be answered'
       WHERE job_id = ? AND status IN ('ready', 'paused', 'answer-prepared')`,
      [jobId],
    )
    this.db.run(
      `UPDATE job_interjections SET status = 'ambiguous',
         last_error = 'job failed while an interjection request might have been delivered'
       WHERE job_id = ? AND status IN ('pausing', 'answering')`,
      [jobId],
    )
    this.db.run(
      `UPDATE job_interjections SET status = 'superseded',
         last_error = 'job failed before the staged interjection answer could be delivered'
       WHERE job_id = ? AND status = 'answered' AND delivered_at IS NULL
         AND disposition = 'task-update'`,
      [jobId],
    )
    this.db.run(
      `UPDATE job_interjections SET status = 'promoted',
         last_error = COALESCE(last_error, 'answer-only interjection was delivered before job failure')
       WHERE job_id = ? AND status = 'delivered' AND disposition = 'answer-only'`,
      [jobId],
    )
    this.db.run(
      `UPDATE job_interjections SET status = 'superseded',
         last_error = 'task update answer was delivered but the job failed before promotion'
       WHERE job_id = ? AND status = 'delivered' AND disposition = 'task-update'`,
      [jobId],
    )
    void now
  }

  private settleUiApprovalArtifactsForTerminal(
    jobId: string,
    now: number,
    reason: string,
  ): number {
    return this.db.run(
      `UPDATE artifact_deliveries
       SET abandoned_at = COALESCE(abandoned_at, ?), last_error = COALESCE(last_error, ?)
       WHERE job_id = ? AND delivered_at IS NULL AND abandoned_at IS NULL
         AND artifact_path IN (
           SELECT before_path FROM ui_approval_requests WHERE job_id = ?
           UNION
           SELECT after_path FROM ui_approval_requests WHERE job_id = ?
         )`,
      [now, reason.slice(0, 4_000), jobId, jobId, jobId],
    ).changes
  }

  fail(id: string, error: string): void {
    const fail = this.db.transaction(() => {
      const finishedAt = Date.now()
      const updated = this.db.run(
        `UPDATE jobs
         SET status = 'failed', not_before = NULL, executor_pid = NULL,
             pending_session_id = NULL, pending_result = NULL,
             accepts_control = 0, executor_nonce = NULL,
             active_thread_id = NULL, active_turn_id = NULL,
             ui_approval_request_id = NULL,
             terminal_outcome = 'failed',
             last_error = ?, finished_at = ?
         WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
        [error, finishedAt, id],
      )
      if (updated.changes !== 1) throw new Error('job is no longer running: ' + id)
      this.db.run(
        `UPDATE ui_approval_requests SET status = 'superseded'
         WHERE job_id = ? AND status IN ('publishing', 'awaiting', 'responded')`,
        [id],
      )
      this.settleUiApprovalArtifactsForTerminal(
        id,
        finishedAt,
        'UI/UX approval publication was superseded by job failure',
      )
      this.supersedeLifecycleNotifications(id, finishedAt)
      this.settleInterjectionsForTerminal(id, 'failed', finishedAt)
      this.db.run(
        `INSERT INTO terminal_notifications (
           id, job_id, kind, payload, created_at
         ) VALUES (?, ?, 'failed', ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           kind = excluded.kind, payload = excluded.payload,
           attempts = 0, not_before = NULL, last_error = NULL,
           created_at = excluded.created_at, body_delivered_at = NULL,
           reaction_delivered_at = NULL, delivered_at = NULL`,
        [randomUUID(), id, error, finishedAt],
      )
    })
    retrySqlite(() => fail.immediate())
  }

  cancel(id: string, message = '中止しました。すでに完了した変更は自動では戻していません。'): void {
    const cancel = this.db.transaction(() => {
      const finishedAt = Date.now()
      const updated = this.db.run(
        `UPDATE jobs
         SET status = 'failed', not_before = NULL, executor_pid = NULL,
             pending_session_id = NULL, pending_result = NULL,
             accepts_control = 0, executor_nonce = NULL,
             active_thread_id = NULL, active_turn_id = NULL,
             ui_approval_request_id = NULL,
             terminal_outcome = 'cancelled',
             last_error = ?, finished_at = ?
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND cancel_requested_at IS NOT NULL`,
        [message, finishedAt, id],
      )
      if (updated.changes !== 1) throw new Error('job is no longer cancellable: ' + id)
      this.db.run(
        `UPDATE ui_approval_requests SET status = 'cancelled'
         WHERE job_id = ? AND status IN ('publishing', 'awaiting', 'responded')`,
        [id],
      )
      this.settleUiApprovalArtifactsForTerminal(
        id,
        finishedAt,
        'UI/UX approval publication was cancelled',
      )
      this.supersedeLifecycleNotifications(id, finishedAt)
      this.settleInterjectionsForTerminal(id, 'cancelled', finishedAt)
      // `finishAppServerTurn` is the sole authority that can move an
      // acknowledged interrupt to observed after a matching terminal.  A
      // terminal cancellation must not fabricate that audit evidence for a
      // request that was never written or whose write outcome is unknown.
      this.db.run(
        `UPDATE job_controls SET status = 'superseded',
           last_error = 'cancellation was accepted after the App Server turn became terminal; turn/interrupt was not dispatched'
         WHERE job_id = ? AND kind = 'interrupt' AND status = 'ready'`,
        [id],
      )
      this.db.run(
        `UPDATE job_controls SET status = 'ambiguous',
           last_error = 'cancellation terminalized while turn/interrupt acknowledgement was unknown'
         WHERE job_id = ? AND kind = 'interrupt' AND status = 'dispatching'`,
        [id],
      )
      this.db.run(
        `UPDATE job_controls SET status = 'superseded',
           last_error = 'superseded by the terminal Slack interrupt before dispatch'
         WHERE job_id = ? AND kind = 'steer' AND status = 'ready'`,
        [id],
      )
      this.db.run(
        `UPDATE job_controls SET status = 'ambiguous',
           last_error = 'terminal Slack interrupt arrived while turn/steer acknowledgement was unknown'
         WHERE job_id = ? AND kind = 'steer' AND status = 'dispatching'`,
        [id],
      )
      this.db.run(
        `UPDATE job_controls SET status = 'superseded', observed_at = COALESCE(observed_at, ?),
           last_error = 'superseded by the terminal Slack interrupt after acknowledgement'
         WHERE job_id = ? AND kind = 'steer' AND status = 'acknowledged'`,
        [finishedAt, id],
      )
      this.db.run(
        `INSERT INTO terminal_notifications (
           id, job_id, kind, payload, created_at
         ) VALUES (?, ?, 'failed', ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           kind = excluded.kind, payload = excluded.payload,
           attempts = 0, not_before = NULL, last_error = NULL,
           created_at = excluded.created_at, body_delivered_at = NULL,
           reaction_delivered_at = NULL, delivered_at = NULL`,
        [randomUUID(), id, message, finishedAt],
      )
    })
    retrySqlite(() => cancel.immediate())
  }

  failAfterMonitorLoss(id: string, error: string): boolean {
    const fail = this.db.transaction(() => {
      const finishedAt = Date.now()
      const updated = this.db.run(
        `UPDATE jobs
         SET status = 'failed', worker_id = NULL, not_before = NULL,
             executor_pid = NULL, monitor_state = 0,
             pending_session_id = NULL, pending_result = NULL,
             accepts_control = 0, executor_nonce = NULL,
             active_thread_id = NULL, active_turn_id = NULL,
             ui_approval_request_id = NULL,
             terminal_outcome = 'failed',
             last_error = ?, finished_at = ?
         WHERE id = ? AND runtime = 'codex' AND status IN ('queued', 'running')`,
        [error, finishedAt, id],
      )
      if (updated.changes === 0) return false
      this.db.run(
        `UPDATE ui_approval_requests SET status = 'superseded'
         WHERE job_id = ? AND status IN ('publishing', 'awaiting', 'responded')`,
        [id],
      )
      this.settleUiApprovalArtifactsForTerminal(
        id,
        finishedAt,
        'UI/UX approval publication was superseded after monitor loss',
      )
      this.supersedeLifecycleNotifications(id, finishedAt)
      this.settleInterjectionsForTerminal(id, 'failed', finishedAt)
      this.db.run(
        `INSERT INTO terminal_notifications (
           id, job_id, kind, payload, created_at
         ) VALUES (?, ?, 'failed', ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           kind = excluded.kind, payload = excluded.payload,
           attempts = 0, not_before = NULL, last_error = NULL,
           created_at = excluded.created_at, body_delivered_at = NULL,
           reaction_delivered_at = NULL, delivered_at = NULL`,
        [randomUUID(), id, error, finishedAt],
      )
      return true
    })
    return retrySqlite(() => fail.immediate())
  }

  activateJobLifecycle(
    jobIdInput: string,
    attemptInput: number,
    now = Date.now(),
  ): number {
    const jobId = requireText(jobIdInput, 'jobId')
    const attempt = Math.floor(attemptInput)
    if (!Number.isSafeInteger(attempt) || attempt < 1
      || !Number.isSafeInteger(now) || now <= 0) {
      throw new Error('job lifecycle activation is invalid')
    }
    const activate = this.db.transaction(() => {
      const job = this.db.query<{
        status: JobStatus
        attempts: number
        cancel_requested_at: number | null
      }, [string]>(
        'SELECT status, attempts, cancel_requested_at FROM jobs WHERE id = ?',
      ).get(jobId)
      if (job && job.cancel_requested_at !== null) {
        throw new CodexUserCancelledError()
      }
      if (!job || job.status !== 'running' || job.attempts !== attempt) {
        throw new Error(`job is not eligible for lifecycle activation: ${jobId}`)
      }
      const existing = this.db.query<{ created_at: number }, [string, number]>(
        `SELECT created_at FROM lifecycle_notifications
         WHERE job_id = ? AND attempt = ? AND kind = 'started' AND slot = -1
           AND superseded_at IS NULL`,
      ).get(jobId, attempt)
      if (existing) return existing.created_at
      this.db.run(
        `INSERT INTO lifecycle_notifications (
           id, job_id, attempt, kind, slot, payload, created_at
         ) VALUES (?, ?, ?, 'started', -1, '', ?)
         ON CONFLICT(job_id, attempt, kind, slot) DO UPDATE SET
           id = excluded.id, payload = '', attempts = 0, not_before = NULL,
           last_error = NULL, created_at = excluded.created_at,
           delivered_at = NULL, superseded_at = NULL`,
        [randomUUID(), jobId, attempt, now],
      )
      return now
    })
    return retrySqlite(() => activate.immediate())
  }

  stageProgressProbe(
    jobIdInput: string,
    attemptInput: number,
    slotInput: number,
    clientMessageIdInput: string,
    now = Date.now(),
  ): 'staged' | 'duplicate' | 'closed' {
    const jobId = requireText(jobIdInput, 'jobId')
    const attempt = Math.floor(attemptInput)
    const slot = Math.floor(slotInput)
    const clientMessageId = requireText(clientMessageIdInput, 'progress client message id')
    if (!Number.isSafeInteger(attempt) || attempt < 1
      || !Number.isSafeInteger(slot) || slot < 0
      || !/^[0-9a-f]{64}$/.test(clientMessageId)
      || !Number.isSafeInteger(now) || now <= 0) {
      throw new Error('progress probe is invalid')
    }
    const stage = this.db.transaction((): 'staged' | 'duplicate' | 'closed' => {
      const job = this.db.query<{
        status: JobStatus
        attempts: number
        cancel_requested_at: number | null
      }, [string]>(
        'SELECT status, attempts, cancel_requested_at FROM jobs WHERE id = ?',
      ).get(jobId)
      if (!job || job.status !== 'running' || job.attempts !== attempt
        || job.cancel_requested_at !== null) return 'closed'
      const existing = this.db.query<{
        client_message_id: string
        superseded_at: number | null
      }, [string, number, number]>(
        `SELECT client_message_id, superseded_at FROM progress_probes
         WHERE job_id = ? AND attempt = ? AND slot = ?`,
      ).get(jobId, attempt, slot)
      if (existing) {
        if (existing.client_message_id !== clientMessageId) {
          throw new Error(`progress probe identity changed: ${jobId}:${attempt}:${slot}`)
        }
        return existing.superseded_at === null ? 'duplicate' : 'closed'
      }
      this.db.run(
        `INSERT INTO progress_probes (
           job_id, attempt, slot, client_message_id, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
        [jobId, attempt, slot, clientMessageId, now],
      )
      return 'staged'
    })
    return retrySqlite(() => stage.immediate())
  }

  supersedeProgressProbe(
    jobIdInput: string,
    attemptInput: number,
    slotInput: number,
    supersededBySlotInput: number | null,
    now = Date.now(),
  ): void {
    const jobId = requireText(jobIdInput, 'jobId')
    const attempt = Math.floor(attemptInput)
    const slot = Math.floor(slotInput)
    const supersededBySlot = supersededBySlotInput === null
      ? null
      : Math.floor(supersededBySlotInput)
    if (!Number.isSafeInteger(attempt) || attempt < 1
      || !Number.isSafeInteger(slot) || slot < 0
      || (supersededBySlot !== null
        && (!Number.isSafeInteger(supersededBySlot) || supersededBySlot <= slot))
      || !Number.isSafeInteger(now) || now <= 0) {
      throw new Error('progress probe supersession is invalid')
    }
    retrySqlite(() => this.db.run(
      `UPDATE progress_probes
       SET superseded_at = COALESCE(superseded_at, ?),
           superseded_by_slot = COALESCE(superseded_by_slot, ?)
       WHERE job_id = ? AND attempt = ? AND slot = ?
         AND reported_at IS NULL AND superseded_at IS NULL`,
      [now, supersededBySlot, jobId, attempt, slot],
    ))
  }

  stageProgressNotification(
    jobIdInput: string,
    attemptInput: number,
    slotInput: number,
    payloadInput: string,
    now = Date.now(),
  ): 'staged' | 'duplicate' | 'closed' {
    const jobId = requireText(jobIdInput, 'jobId')
    const attempt = Math.floor(attemptInput)
    const slot = Math.floor(slotInput)
    const payload = payloadInput.trim()
    if (!Number.isSafeInteger(attempt) || attempt < 1
      || !Number.isSafeInteger(slot) || slot < 0
      || !payload || payload.length > 4_000
      || !Number.isSafeInteger(now) || now <= 0) {
      throw new Error('progress notification is invalid')
    }
    const stage = this.db.transaction((): 'staged' | 'duplicate' | 'closed' => {
      const job = this.db.query<{
        status: JobStatus
        attempts: number
        control_epoch: number
        cancel_requested_at: number | null
      }, [string]>(
        'SELECT status, attempts, control_epoch, cancel_requested_at FROM jobs WHERE id = ?',
      ).get(jobId)
      if (!job || job.status !== 'running' || job.attempts !== attempt
        || job.cancel_requested_at !== null) return 'closed'
      if (this.db.query<{ present: number }, [string, number]>(
        `SELECT 1 AS present FROM job_controls
         WHERE job_id = ? AND control_epoch = ? AND status IN ('ready', 'dispatching')
         LIMIT 1`,
      ).get(jobId, job.control_epoch)) return 'closed'
      if (this.db.query<{ present: number }, [string, number]>(
        `SELECT 1 AS present FROM job_interjections
         WHERE job_id = ? AND control_epoch = ?
           AND status IN ('ready', 'pausing', 'paused', 'answer-prepared', 'answering', 'answered')
         LIMIT 1`,
      ).get(jobId, job.control_epoch)) return 'closed'
      const probe = this.db.query<{
        reported_at: number | null
        superseded_at: number | null
      }, [string, number, number]>(
        `SELECT reported_at, superseded_at FROM progress_probes
         WHERE job_id = ? AND attempt = ? AND slot = ?`,
      ).get(jobId, attempt, slot)
      if (!probe || probe.superseded_at !== null) return 'closed'
      const activated = this.db.query<{ present: number }, [string, number]>(
        `SELECT 1 AS present FROM lifecycle_notifications
         WHERE job_id = ? AND attempt = ? AND kind = 'started' AND slot = -1`,
      ).get(jobId, attempt)
      if (!activated) throw new Error(`job lifecycle is not active: ${jobId}`)
      const duplicate = this.db.query<{ present: number }, [string, number, number]>(
        `SELECT 1 AS present FROM lifecycle_notifications
         WHERE job_id = ? AND attempt = ? AND kind = 'progress' AND slot = ?
           AND superseded_at IS NULL`,
      ).get(jobId, attempt, slot)
      if (duplicate) {
        this.db.run(
          `UPDATE progress_probes SET reported_at = COALESCE(reported_at, ?)
           WHERE job_id = ? AND attempt = ? AND slot = ?`,
          [now, jobId, attempt, slot],
        )
        return 'duplicate'
      }
      this.db.run(
        `UPDATE lifecycle_notifications SET superseded_at = ?
         WHERE job_id = ? AND attempt = ?
           AND delivered_at IS NULL AND superseded_at IS NULL
           AND (kind = 'started' OR (kind = 'progress' AND slot < ?))`,
        [now, jobId, attempt, slot],
      )
      this.db.run(
        `INSERT INTO lifecycle_notifications (
           id, job_id, attempt, kind, slot, payload, created_at
         ) VALUES (?, ?, ?, 'progress', ?, ?, ?)
         ON CONFLICT(job_id, attempt, kind, slot) DO UPDATE SET
           id = excluded.id, payload = excluded.payload, attempts = 0,
           not_before = NULL, last_error = NULL, created_at = excluded.created_at,
           delivered_at = NULL, superseded_at = NULL`,
        [randomUUID(), jobId, attempt, slot, payload, now],
      )
      this.db.run(
        `UPDATE progress_probes SET reported_at = COALESCE(reported_at, ?)
         WHERE job_id = ? AND attempt = ? AND slot = ?
           AND superseded_at IS NULL`,
        [now, jobId, attempt, slot],
      )
      return 'staged'
    })
    return retrySqlite(() => stage.immediate())
  }

  pendingLifecycleNotifications(now = Date.now(), limit = 20): LifecycleNotification[] {
    const rows = this.db.query<{
      id: string
      job_id: string
      attempt: number
      kind: 'started' | 'progress'
      slot: number
      payload: string
      attempts: number
    }, [number, number]>(
      `SELECT n.id, n.job_id, n.attempt, n.kind, n.slot, n.payload, n.attempts
       FROM lifecycle_notifications AS n
       JOIN jobs AS j ON j.id = n.job_id
       WHERE n.delivered_at IS NULL AND n.superseded_at IS NULL
         AND (n.not_before IS NULL OR n.not_before <= ?)
         AND j.status = 'running' AND j.cancel_requested_at IS NULL
         AND j.attempts = n.attempt
         AND NOT EXISTS (
           SELECT 1 FROM job_controls AS c
           WHERE c.job_id = j.id AND c.control_epoch = j.control_epoch
             AND c.status IN ('ready', 'dispatching')
         )
         AND NOT EXISTS (
           SELECT 1 FROM job_interjections AS i
           WHERE i.job_id = j.id AND i.control_epoch = j.control_epoch
             AND i.status IN ('ready', 'pausing', 'paused', 'answer-prepared', 'answering', 'answered')
         )
         AND NOT EXISTS (
           SELECT 1 FROM terminal_notifications AS t
           JOIN jobs AS prior ON prior.id = t.job_id
           WHERE t.delivered_at IS NULL
             AND prior.chat_id = j.chat_id AND prior.thread_ts = j.thread_ts
             AND prior.seq < j.seq
         )
         AND NOT EXISTS (
           SELECT 1 FROM status_notifications AS s
           WHERE s.job_id = j.id AND s.delivered_at IS NULL AND s.superseded_at IS NULL
         )
       ORDER BY n.created_at ASC LIMIT ?`,
    ).all(now, limit)
    return rows.flatMap(row => {
      const job = this.get(row.job_id)
      return job ? [{ ...row, jobId: row.job_id, job }] : []
    })
  }

  lifecycleNotificationDeliverable(idInput: string): boolean {
    const id = requireText(idInput, 'notificationId')
    return retrySqlite(() => this.db.query<{ present: number }, [string]>(
      `SELECT 1 AS present
       FROM lifecycle_notifications AS n
       JOIN jobs AS j ON j.id = n.job_id
       WHERE n.id = ? AND n.delivered_at IS NULL AND n.superseded_at IS NULL
         AND j.status = 'running' AND j.cancel_requested_at IS NULL
         AND j.attempts = n.attempt
         AND NOT EXISTS (
           SELECT 1 FROM job_controls AS c
           WHERE c.job_id = j.id AND c.control_epoch = j.control_epoch
             AND c.status IN ('ready', 'dispatching')
         )
         AND NOT EXISTS (
           SELECT 1 FROM job_interjections AS i
           WHERE i.job_id = j.id AND i.control_epoch = j.control_epoch
             AND i.status IN ('ready', 'pausing', 'paused', 'answer-prepared', 'answering', 'answered')
         )
         AND NOT EXISTS (
           SELECT 1 FROM terminal_notifications AS t
           JOIN jobs AS prior ON prior.id = t.job_id
           WHERE t.delivered_at IS NULL
             AND prior.chat_id = j.chat_id AND prior.thread_ts = j.thread_ts
             AND prior.seq < j.seq
         )
         AND NOT EXISTS (
           SELECT 1 FROM status_notifications AS s
           WHERE s.job_id = j.id AND s.delivered_at IS NULL AND s.superseded_at IS NULL
         )`,
    ).get(id) !== null)
  }

  markLifecycleNotificationDelivered(idInput: string): void {
    const id = requireText(idInput, 'notificationId')
    this.db.run(
      `UPDATE lifecycle_notifications
       SET delivered_at = ?, not_before = NULL, last_error = NULL
       WHERE id = ? AND delivered_at IS NULL AND superseded_at IS NULL`,
      [Date.now(), id],
    )
  }

  deferLifecycleNotification(
    idInput: string,
    errorInput: string,
    now = Date.now(),
    retryMs = 30_000,
  ): void {
    const id = requireText(idInput, 'notificationId')
    const error = requireText(errorInput, 'notificationError').slice(0, 4_000)
    this.db.run(
      `UPDATE lifecycle_notifications
       SET attempts = attempts + 1, not_before = ?, last_error = ?
       WHERE id = ? AND delivered_at IS NULL AND superseded_at IS NULL`,
      [now + Math.max(1, retryMs), error, id],
    )
  }

  lifecycleNotificationCount(): number {
    return this.db.query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM lifecycle_notifications
       WHERE delivered_at IS NULL AND superseded_at IS NULL`,
    ).get()?.count ?? 0
  }

  stageCommentaryNotification(
    jobIdInput: string,
    attemptInput: number,
    sourceKeyInput: string,
    payloadInput: string,
    now = Date.now(),
  ): 'staged' | 'duplicate' | 'closed' {
    const jobId = requireText(jobIdInput, 'jobId')
    const attempt = Math.floor(attemptInput)
    const sourceKey = requireText(sourceKeyInput, 'commentary source key')
    const payload = normalizePublicGuardText(payloadInput).trim()
    if (!Number.isSafeInteger(attempt) || attempt < 1
      || !/^[0-9a-f]{64}$/.test(sourceKey)
      || !payload.startsWith('💬 ') || payload.length > 700
      || containsCredentialMaterial(payload)
      || !Number.isSafeInteger(now) || now <= 0) {
      throw new Error('commentary notification is invalid')
    }
    const stage = this.db.transaction((): 'staged' | 'duplicate' | 'closed' => {
      const existing = this.db.query<{
        job_id: string
        attempt: number
        payload: string
      }, [string]>(
        `SELECT job_id, attempt, payload FROM commentary_notifications
         WHERE source_key = ?`,
      ).get(sourceKey)
      if (existing) {
        if (existing.job_id !== jobId || existing.attempt !== attempt
          || existing.payload !== payload) {
          throw new Error(`commentary source identity changed: ${sourceKey}`)
        }
        return 'duplicate'
      }
      const job = this.db.query<{
        status: JobStatus
        attempts: number
      }, [string]>(
        'SELECT status, attempts FROM jobs WHERE id = ?',
      ).get(jobId)
      if (!job || job.status !== 'running' || job.attempts !== attempt) return 'closed'
      this.db.run(
        `INSERT INTO commentary_notifications (
           id, source_key, job_id, attempt, payload, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), sourceKey, jobId, attempt, payload, now],
      )
      return 'staged'
    })
    return retrySqlite(() => stage.immediate())
  }

  pendingCommentaryNotifications(
    now = Date.now(),
    limit = 20,
  ): CommentaryNotification[] {
    const rows = this.db.query<{
      seq: number
      id: string
      source_key: string
      job_id: string
      attempt: number
      payload: string
      attempts: number
    }, [number, number]>(
      `SELECT c.seq, c.id, c.source_key, c.job_id, c.attempt, c.payload, c.attempts
       FROM commentary_notifications AS c
       JOIN jobs AS j ON j.id = c.job_id
       WHERE c.delivered_at IS NULL
         AND (c.not_before IS NULL OR c.not_before <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM commentary_notifications AS prior
           WHERE prior.job_id = c.job_id AND prior.seq < c.seq
             AND prior.delivered_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM lifecycle_notifications AS started
           WHERE started.job_id = c.job_id AND started.attempt = c.attempt
             AND started.kind = 'started' AND started.delivered_at IS NULL
             AND started.superseded_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM status_notifications AS status
           WHERE status.job_id = c.job_id AND status.delivered_at IS NULL
             AND status.superseded_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM job_interjections AS interjection
           WHERE interjection.job_id = c.job_id
             AND interjection.status = 'answered'
             AND interjection.delivered_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM terminal_notifications AS terminal
           JOIN jobs AS prior_job ON prior_job.id = terminal.job_id
           WHERE terminal.delivered_at IS NULL
             AND prior_job.chat_id = j.chat_id AND prior_job.thread_ts = j.thread_ts
             AND prior_job.seq < j.seq
         )
       ORDER BY c.seq ASC LIMIT ?`,
    ).all(now, limit)
    return rows.flatMap(row => {
      const job = this.get(row.job_id)
      return job ? [{
        id: row.id,
        sourceKey: row.source_key,
        jobId: row.job_id,
        attempt: row.attempt,
        payload: row.payload,
        attempts: row.attempts,
        job,
      }] : []
    })
  }

  commentaryNotificationDeliverable(idInput: string): boolean {
    const id = requireText(idInput, 'notificationId')
    return retrySqlite(() => this.db.query<{ present: number }, [string]>(
      `SELECT 1 AS present
       FROM commentary_notifications AS c
       JOIN jobs AS j ON j.id = c.job_id
       WHERE c.id = ? AND c.delivered_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM commentary_notifications AS prior
           WHERE prior.job_id = c.job_id AND prior.seq < c.seq
             AND prior.delivered_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM lifecycle_notifications AS started
           WHERE started.job_id = c.job_id AND started.attempt = c.attempt
             AND started.kind = 'started' AND started.delivered_at IS NULL
             AND started.superseded_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM status_notifications AS status
           WHERE status.job_id = c.job_id AND status.delivered_at IS NULL
             AND status.superseded_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM job_interjections AS interjection
           WHERE interjection.job_id = c.job_id
             AND interjection.status = 'answered'
             AND interjection.delivered_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM terminal_notifications AS terminal
           JOIN jobs AS prior_job ON prior_job.id = terminal.job_id
           WHERE terminal.delivered_at IS NULL
             AND prior_job.chat_id = j.chat_id AND prior_job.thread_ts = j.thread_ts
             AND prior_job.seq < j.seq
         )`,
    ).get(id) !== null)
  }

  markCommentaryNotificationDelivered(idInput: string): void {
    this.db.run(
      `UPDATE commentary_notifications
       SET delivered_at = ?, not_before = NULL, last_error = NULL
       WHERE id = ? AND delivered_at IS NULL`,
      [Date.now(), requireText(idInput, 'notificationId')],
    )
  }

  deferCommentaryNotification(
    idInput: string,
    errorInput: string,
    now = Date.now(),
    retryMs = 30_000,
  ): void {
    this.db.run(
      `UPDATE commentary_notifications
       SET attempts = attempts + 1, not_before = ?, last_error = ?
       WHERE id = ? AND delivered_at IS NULL`,
      [
        now + Math.max(1, retryMs),
        requireText(errorInput, 'notificationError').slice(0, 4_000),
        requireText(idInput, 'notificationId'),
      ],
    )
  }

  commentaryNotificationCount(): number {
    return this.db.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM commentary_notifications WHERE delivered_at IS NULL',
    ).get()?.count ?? 0
  }

  pendingInterjectionNotifications(now = Date.now(), limit = 20): InterjectionNotification[] {
    const rows = this.db.query<JobInterjectionRow, [number, number]>(
      `SELECT i.* FROM job_interjections AS i
       JOIN jobs AS j ON j.id = i.job_id
       WHERE i.status = 'answered' AND i.delivered_at IS NULL
         AND i.notification_id IS NOT NULL AND i.answer_payload IS NOT NULL
         AND (i.not_before IS NULL OR i.not_before <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM job_interjections AS prior
           WHERE prior.job_id = i.job_id AND prior.control_epoch = i.control_epoch
             AND prior.seq < i.seq
             AND prior.status NOT IN ('promoted', 'superseded')
         )
       ORDER BY i.answered_at ASC, i.seq ASC LIMIT ?`,
    ).all(now, limit)
    return rows.flatMap(row => {
      const job = this.get(row.job_id)
      if (!job || !row.notification_id || !row.answer_payload) return []
      const interjection = mapInterjectionRow(row)
      return [{
        id: row.notification_id,
        idempotencyKey: `interjection-answer:${row.idempotency_key}`,
        jobId: row.job_id,
        chatId: row.chat_id,
        threadTs: row.thread_ts,
        kind: 'interjection-answer' as const,
        payload: row.answer_payload,
        attempts: row.attempts,
        job,
        interjection,
      }]
    })
  }

  interjectionNotificationDeliverable(notificationIdInput: string): boolean {
    return retrySqlite(() => this.db.query<{ present: number }, [string]>(
      `SELECT 1 AS present FROM job_interjections AS current
       WHERE current.notification_id = ? AND current.status = 'answered'
         AND current.delivered_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM job_interjections AS prior
           WHERE prior.job_id = current.job_id
             AND prior.control_epoch = current.control_epoch
             AND prior.seq < current.seq
             AND prior.status NOT IN ('promoted', 'superseded')
         )`,
    ).get(requireText(notificationIdInput, 'notificationId')) !== null)
  }

  markInterjectionNotificationDelivered(notificationIdInput: string): void {
    const updated = this.db.run(
      `UPDATE job_interjections SET
         status = CASE
           WHEN disposition = 'answer-only' AND EXISTS (
             SELECT 1 FROM jobs
             WHERE jobs.id = job_interjections.job_id
               AND jobs.status IN ('completed', 'failed')
           ) THEN 'promoted'
           ELSE 'delivered'
         END,
         delivered_at = ?,
         not_before = NULL, last_error = NULL
       WHERE notification_id = ? AND status = 'answered' AND delivered_at IS NULL`,
      [Date.now(), requireText(notificationIdInput, 'notificationId')],
    )
    if (updated.changes !== 1) {
      const existing = this.db.query<{ delivered_at: number | null }, [string]>(
        'SELECT delivered_at FROM job_interjections WHERE notification_id = ?',
      ).get(notificationIdInput)
      if (existing?.delivered_at === null || existing === null) {
        throw new Error(`interjection notification delivery changed: ${notificationIdInput}`)
      }
    }
  }

  deferInterjectionNotification(
    notificationIdInput: string,
    errorInput: string,
    now = Date.now(),
    retryMs = 30_000,
  ): void {
    this.db.run(
      `UPDATE job_interjections SET attempts = attempts + 1, not_before = ?, last_error = ?
       WHERE notification_id = ? AND status = 'answered' AND delivered_at IS NULL`,
      [
        now + Math.max(1, retryMs), requireText(errorInput, 'notificationError').slice(0, 4_000),
        requireText(notificationIdInput, 'notificationId'),
      ],
    )
  }

  interjectionIsDelivered(interjectionIdInput: string): boolean {
    return retrySqlite(() => this.db.query<{ delivered_at: number | null }, [string]>(
      `SELECT delivered_at FROM job_interjections
       WHERE id = ? AND status IN ('delivered', 'promoted')`,
    ).get(requireText(interjectionIdInput, 'interjectionId'))?.delivered_at != null)
  }

  promoteDeliveredInterjection(
    interjectionIdInput: string,
  ): JobInterjectionDisposition {
    const interjectionId = requireText(interjectionIdInput, 'interjectionId')
    const promote = this.db.transaction((): JobInterjectionDisposition => {
      const row = this.db.query<JobInterjectionRow, [string]>(
        'SELECT * FROM job_interjections WHERE id = ?',
      ).get(interjectionId)
      if (!row || row.delivered_at === null || row.disposition === null) {
        throw new Error(`interjection is not delivered: ${interjectionId}`)
      }
      const earlier = this.db.query<{ present: number }, [string, number, number]>(
        `SELECT 1 AS present FROM job_interjections
         WHERE job_id = ? AND control_epoch = ? AND seq < ?
           AND status NOT IN ('promoted', 'superseded') LIMIT 1`,
      ).get(row.job_id, row.control_epoch, row.seq)
      if (earlier) {
        throw new Error(`an earlier interjection must finish before ${interjectionId}`)
      }
      if (row.disposition === 'answer-only') {
        if (row.status === 'delivered') {
          const completed = this.db.run(
            `UPDATE job_interjections SET status = 'promoted'
             WHERE id = ? AND status = 'delivered'`,
            [interjectionId],
          )
          if (completed.changes !== 1) {
            throw new Error(`interjection completion was not recorded: ${interjectionId}`)
          }
        } else if (row.status !== 'promoted') {
          throw new Error(`interjection completion state changed: ${interjectionId}`)
        }
        return 'answer-only'
      }
      if (row.status === 'promoted') return 'task-update'
      if (row.status !== 'delivered') {
        throw new Error(`interjection promotion state changed: ${interjectionId}`)
      }
      const job = this.db.query<{
        id: string
        message_id: string
        user_id: string
        write_enabled: number
        task: string
        attachments_json: string
        input_revision: number
        control_epoch: number
        cancel_requested_at: number | null
        status: JobStatus
      }, [string]>(
        `SELECT id, message_id, user_id, write_enabled, task, attachments_json,
                input_revision, control_epoch, cancel_requested_at, status
         FROM jobs WHERE id = ? AND runtime = 'codex'`,
      ).get(row.job_id)
      if (!job || job.status !== 'running' || job.cancel_requested_at !== null
        || job.control_epoch !== row.control_epoch) {
        throw new Error(`interjection target is no longer active: ${interjectionId}`)
      }
      const currentControls = this.db.query<{
        input_revision: number
        message_id: string
        user_id: string
        write_enabled: number
        task: string
        attachments_json: string
      }, [string]>(
        `SELECT input_revision, message_id, user_id, write_enabled, task, attachments_json
         FROM job_controls WHERE job_id = ? AND kind = 'steer'
         ORDER BY input_revision ASC, seq ASC`,
      ).all(row.job_id)
      const currentSnapshot = createAdvisorInputSnapshot(job, currentControls)
      if (currentSnapshot.revision !== row.input_revision
        || currentSnapshot.digest !== row.input_digest
        || currentSnapshot.revision !== job.input_revision) {
        throw new Error(`interjection input binding changed before promotion: ${interjectionId}`)
      }
      const nextRevision = job.input_revision + 1
      const advanced = this.db.run(
        `UPDATE jobs SET input_revision = ?
         WHERE id = ? AND control_epoch = ? AND input_revision = ?
           AND status = 'running' AND cancel_requested_at IS NULL`,
        [nextRevision, row.job_id, row.control_epoch, job.input_revision],
      )
      if (advanced.changes !== 1) {
        throw new Error(`interjection input revision could not advance: ${interjectionId}`)
      }
      const promotedControlId = randomUUID()
      const now = Date.now()
      this.db.run(
        `INSERT INTO job_controls (
           id, idempotency_key, job_id, control_epoch, input_revision, input_digest,
           kind, chat_id, thread_ts, message_id, user_id, write_enabled, task,
           attachments_json, status, created_at, observed_at, last_error
         ) VALUES (?, ?, ?, ?, ?, '', 'steer', ?, ?, ?, ?, ?, ?, ?, 'observed', ?, ?, ?)`,
        [
          promotedControlId, row.idempotency_key, row.job_id, row.control_epoch,
          nextRevision, row.chat_id, row.thread_ts, row.message_id, row.user_id,
          row.write_enabled, row.task, row.attachments_json, row.created_at, now,
          'promoted from a delivered conversational interjection',
        ],
      )
      const nextJob = { ...job, input_revision: nextRevision }
      const nextControls = [...currentControls, {
        input_revision: nextRevision,
        message_id: row.message_id,
        user_id: row.user_id,
        write_enabled: row.write_enabled,
        task: row.task,
        attachments_json: row.attachments_json,
      }]
      const nextSnapshot = createAdvisorInputSnapshot(nextJob, nextControls)
      const digested = this.db.run(
        `UPDATE job_controls SET input_digest = ?
         WHERE id = ? AND input_digest = ''`,
        [nextSnapshot.digest, promotedControlId],
      )
      if (digested.changes !== 1) {
        throw new Error(`promoted interjection digest was not fixed: ${interjectionId}`)
      }
      const completed = this.db.run(
        `UPDATE job_interjections SET status = 'promoted'
         WHERE id = ? AND status = 'delivered'`,
        [interjectionId],
      )
      if (completed.changes !== 1) {
        throw new Error(`interjection promotion was not recorded: ${interjectionId}`)
      }
      this.db.run(
        `UPDATE job_interjections SET input_revision = ?, input_digest = ?
         WHERE job_id = ? AND control_epoch = ?
           AND status IN ('ready', 'paused', 'answer-prepared')`,
        [nextRevision, nextSnapshot.digest, row.job_id, row.control_epoch],
      )
      return 'task-update'
    })
    return retrySqlite(() => promote.immediate())
  }

  pendingStatusNotifications(now = Date.now(), limit = 20): StatusNotification[] {
    const rows = this.db.query<{
      id: string
      idempotency_key: string
      job_id: string | null
      chat_id: string
      thread_ts: string
      kind: StatusNotificationKind
      payload: string
      attempts: number
    }, [number, number]>(
      `SELECT id, idempotency_key, job_id, chat_id, thread_ts, kind, payload, attempts
       FROM status_notifications
       WHERE delivered_at IS NULL AND superseded_at IS NULL
         AND (not_before IS NULL OR not_before <= ?)
       ORDER BY created_at ASC LIMIT ?`,
    ).all(now, limit)
    return rows.map(row => ({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      jobId: row.job_id,
      chatId: row.chat_id,
      threadTs: row.thread_ts,
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
    }))
  }

  statusNotificationDeliverable(idInput: string): boolean {
    return retrySqlite(() => this.db.query<{ present: number }, [string]>(
      `SELECT 1 AS present FROM status_notifications
       WHERE id = ? AND delivered_at IS NULL AND superseded_at IS NULL`,
    ).get(requireText(idInput, 'notificationId')) !== null)
  }

  markStatusNotificationDelivered(idInput: string): void {
    this.db.run(
      `UPDATE status_notifications
       SET delivered_at = ?, not_before = NULL, last_error = NULL
       WHERE id = ? AND delivered_at IS NULL AND superseded_at IS NULL`,
      [Date.now(), requireText(idInput, 'notificationId')],
    )
  }

  deferStatusNotification(
    idInput: string,
    errorInput: string,
    now = Date.now(),
    retryMs = 30_000,
  ): void {
    this.db.run(
      `UPDATE status_notifications
       SET attempts = attempts + 1, not_before = ?, last_error = ?
       WHERE id = ? AND delivered_at IS NULL AND superseded_at IS NULL`,
      [
        now + Math.max(1, retryMs),
        requireText(errorInput, 'notificationError').slice(0, 4_000),
        requireText(idInput, 'notificationId'),
      ],
    )
  }

  statusNotificationCount(): number {
    return this.db.query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM status_notifications
       WHERE delivered_at IS NULL AND superseded_at IS NULL`,
    ).get()?.count ?? 0
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
       FROM terminal_notifications AS terminal
       WHERE terminal.delivered_at IS NULL
         AND (terminal.not_before IS NULL OR terminal.not_before <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM job_interjections AS interjection
           WHERE interjection.job_id = terminal.job_id
             AND interjection.status = 'answered'
             AND interjection.delivered_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM status_notifications AS status
           WHERE status.job_id = terminal.job_id
             AND status.delivered_at IS NULL AND status.superseded_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM commentary_notifications AS commentary
           WHERE commentary.job_id = terminal.job_id
             AND commentary.delivered_at IS NULL
         )
       ORDER BY terminal.created_at ASC LIMIT ?`,
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

  terminalNotificationBodyDelivered(id: string): boolean {
    return this.db.query<{ delivered: number }, [string]>(
      `SELECT body_delivered_at IS NOT NULL AS delivered
       FROM terminal_notifications WHERE id = ?`,
    ).get(id)?.delivered === 1
  }

  markTerminalNotificationBodyDelivered(id: string): void {
    const updated = this.db.run(
      `UPDATE terminal_notifications SET body_delivered_at = COALESCE(body_delivered_at, ?)
       WHERE id = ? AND delivered_at IS NULL`,
      [Date.now(), id],
    )
    if (updated.changes !== 1 && !this.terminalNotificationBodyDelivered(id)) {
      throw new Error(`terminal notification is missing: ${id}`)
    }
  }

  terminalNotificationReactionDelivered(id: string): boolean {
    return this.db.query<{ delivered: number }, [string]>(
      `SELECT reaction_delivered_at IS NOT NULL AS delivered
       FROM terminal_notifications WHERE id = ?`,
    ).get(id)?.delivered === 1
  }

  markTerminalNotificationReactionDelivered(id: string): void {
    const updated = this.db.run(
      `UPDATE terminal_notifications
       SET reaction_delivered_at = COALESCE(reaction_delivered_at, ?)
       WHERE id = ? AND delivered_at IS NULL`,
      [Date.now(), id],
    )
    if (updated.changes !== 1 && !this.terminalNotificationReactionDelivered(id)) {
      throw new Error(`terminal notification is missing: ${id}`)
    }
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

  artifactDeliveryState(
    jobId: string,
    artifactPath: string,
  ): 'ready' | 'delivered' | 'ambiguous' | 'abandoned' {
    const row = this.db.query<{
      started_at: number | null
      delivered_at: number | null
      abandoned_at: number | null
    }, [string, string]>(
      `SELECT started_at, delivered_at, abandoned_at FROM artifact_deliveries
       WHERE job_id = ? AND artifact_path = ?`,
    ).get(jobId, artifactPath)
    if (!row) throw new Error(`artifact delivery row is missing: ${artifactPath}`)
    if (row.delivered_at !== null) return 'delivered'
    if (row.abandoned_at !== null) return 'abandoned'
    if (row.started_at !== null) return 'ambiguous'
    return 'ready'
  }

  artifactRemoteFileId(jobId: string, artifactPath: string): string | null {
    const row = this.db.query<{ remote_file_id: string | null }, [string, string]>(
      `SELECT remote_file_id FROM artifact_deliveries
       WHERE job_id = ? AND artifact_path = ?`,
    ).get(jobId, artifactPath)
    if (!row) throw new Error(`artifact delivery row is missing: ${artifactPath}`)
    return row.remote_file_id
  }

  beginArtifactDelivery(
    jobId: string,
    artifactPath: string,
    remoteFileId: string,
  ): 'started' | 'delivered' | 'ambiguous' | 'abandoned' {
    if (!/^[A-Za-z0-9._-]{1,256}$/.test(remoteFileId)) {
      throw new Error('Slack upload target returned an invalid file id')
    }
    const begin = this.db.transaction(() => {
      const updated = this.db.run(
        `UPDATE artifact_deliveries SET started_at = ?, remote_file_id = ?
         WHERE job_id = ? AND artifact_path = ?
           AND started_at IS NULL AND delivered_at IS NULL AND abandoned_at IS NULL`,
        [Date.now(), remoteFileId, jobId, artifactPath],
      )
      if (updated.changes === 1) return 'started' as const
      const row = this.db.query<{
        started_at: number | null
        delivered_at: number | null
        abandoned_at: number | null
      }, [string, string]>(
        `SELECT started_at, delivered_at, abandoned_at FROM artifact_deliveries
         WHERE job_id = ? AND artifact_path = ?`,
      ).get(jobId, artifactPath)
      if (!row) throw new Error(`artifact delivery row is missing: ${artifactPath}`)
      if (row.delivered_at !== null) return 'delivered' as const
      if (row.abandoned_at !== null) return 'abandoned' as const
      if (row.started_at !== null) return 'ambiguous' as const
      throw new Error(`artifact delivery intent could not be recorded: ${artifactPath}`)
    })
    return retrySqlite(() => begin.immediate())
  }

  recordArtifactAmbiguityCheck(jobId: string, artifactPath: string, error: string): number {
    const record = this.db.transaction(() => {
      const updated = this.db.run(
        `UPDATE artifact_deliveries
         SET ambiguity_checks = ambiguity_checks + 1, last_error = ?
         WHERE job_id = ? AND artifact_path = ? AND started_at IS NOT NULL
           AND delivered_at IS NULL AND abandoned_at IS NULL`,
        [error, jobId, artifactPath],
      )
      if (updated.changes !== 1) {
        const state = this.artifactDeliveryState(jobId, artifactPath)
        if (state === 'delivered' || state === 'abandoned') return 0
        throw new Error(`artifact ambiguity row is not active: ${artifactPath}`)
      }
      return this.db.query<{ ambiguity_checks: number }, [string, string]>(
        `SELECT ambiguity_checks FROM artifact_deliveries
         WHERE job_id = ? AND artifact_path = ?`,
      ).get(jobId, artifactPath)?.ambiguity_checks ?? 0
    })
    return retrySqlite(() => record.immediate())
  }

  abandonAmbiguousArtifacts(jobId: string, artifactPaths: readonly string[], error: string): number {
    const unique = [...new Set(artifactPaths)]
    const abandon = this.db.transaction(() => unique.reduce((count, artifactPath) => (
      count + this.db.run(
        `UPDATE artifact_deliveries SET abandoned_at = ?, last_error = ?
         WHERE job_id = ? AND artifact_path = ? AND started_at IS NOT NULL
           AND delivered_at IS NULL AND abandoned_at IS NULL`,
        [Date.now(), error, jobId, artifactPath],
      ).changes
    ), 0))
    return retrySqlite(() => abandon.immediate())
  }

  blockArtifactByPublicationPolicy(jobId: string, artifactPath: string): void {
    const block = this.db.transaction(() => {
      const updated = this.db.run(
        `UPDATE artifact_deliveries SET abandoned_at = ?, last_error = 'publication-policy'
         WHERE job_id = ? AND artifact_path = ? AND started_at IS NULL
           AND delivered_at IS NULL AND abandoned_at IS NULL`,
        [Date.now(), jobId, artifactPath],
      )
      if (updated.changes === 1) return
      const row = this.db.query<{
        started_at: number | null
        delivered_at: number | null
        abandoned_at: number | null
        last_error: string | null
      }, [string, string]>(
        `SELECT started_at, delivered_at, abandoned_at, last_error
         FROM artifact_deliveries WHERE job_id = ? AND artifact_path = ?`,
      ).get(jobId, artifactPath)
      if (row?.abandoned_at !== null && row?.last_error === 'publication-policy') return
      throw new Error('artifact publication state changed before it could be blocked')
    })
    retrySqlite(() => block.immediate())
  }

  unsettledArtifactCount(jobId: string): number {
    return this.db.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM artifact_deliveries
       WHERE job_id = ? AND delivered_at IS NULL AND abandoned_at IS NULL`,
    ).get(jobId)?.count ?? 0
  }

  abandonedArtifactCount(jobId: string): number {
    return this.db.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM artifact_deliveries
       WHERE job_id = ? AND abandoned_at IS NOT NULL
         AND COALESCE(last_error, '') != 'publication-policy'`,
    ).get(jobId)?.count ?? 0
  }

  publicationBlockedArtifactCount(jobId: string): number {
    return this.db.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM artifact_deliveries
       WHERE job_id = ? AND abandoned_at IS NOT NULL AND last_error = 'publication-policy'`,
    ).get(jobId)?.count ?? 0
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
             SELECT 1 FROM lifecycle_notifications AS n
             WHERE n.job_id = j.id AND n.delivered_at IS NULL AND n.superseded_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM commentary_notifications AS n
             WHERE n.job_id = j.id AND n.delivered_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM status_notifications AS n
             WHERE n.job_id = j.id AND n.delivered_at IS NULL AND n.superseded_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM job_interjections AS i
             WHERE i.job_id = j.id AND i.status = 'answered' AND i.delivered_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM artifact_deliveries AS a
             WHERE a.job_id = j.id AND a.delivered_at IS NULL AND a.abandoned_at IS NULL
           )`,
      ).all(cutoff)
      const prunedInterjectionAttachments: string[] = []
      for (const row of candidates) {
        this.db.run(
          `INSERT INTO delivery_tombstones (idempotency_key, write_enabled, completed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(idempotency_key) DO UPDATE SET
             write_enabled = MAX(write_enabled, excluded.write_enabled),
             completed_at = MAX(completed_at, excluded.completed_at)`,
          [row.idempotency_key, row.write_enabled, row.finished_at],
        )
        this.db.run('DELETE FROM ui_approval_requests WHERE job_id = ?', [row.id])
        this.db.run('DELETE FROM artifact_deliveries WHERE job_id = ?', [row.id])
        this.db.run('DELETE FROM progress_probes WHERE job_id = ?', [row.id])
        this.db.run('DELETE FROM lifecycle_notifications WHERE job_id = ?', [row.id])
        this.db.run('DELETE FROM commentary_notifications WHERE job_id = ?', [row.id])
        this.db.run('DELETE FROM status_notifications WHERE job_id = ?', [row.id])
        this.db.run('DELETE FROM terminal_notifications WHERE job_id = ?', [row.id])
        const controls = this.db.query<{
          idempotency_key: string
          write_enabled: number
          observed_at: number | null
          created_at: number
        }, [string]>(
          'SELECT idempotency_key, write_enabled, observed_at, created_at '
          + 'FROM job_controls WHERE job_id = ?',
        ).all(row.id)
        for (const control of controls) {
          this.db.run(
            `INSERT INTO delivery_tombstones (idempotency_key, write_enabled, completed_at)
             VALUES (?, ?, ?)
             ON CONFLICT(idempotency_key) DO UPDATE SET
               write_enabled = MAX(write_enabled, excluded.write_enabled),
               completed_at = MAX(completed_at, excluded.completed_at)`,
            [
              control.idempotency_key,
              control.write_enabled,
              control.observed_at ?? control.created_at,
            ],
          )
        }
        const interjections = this.db.query<{
          idempotency_key: string
          write_enabled: number
          delivered_at: number | null
          answered_at: number | null
          paused_at: number | null
          created_at: number
          attachments_json: string
        }, [string]>(
          `SELECT idempotency_key, write_enabled, delivered_at, answered_at,
                  paused_at, created_at, attachments_json
           FROM job_interjections WHERE job_id = ?`,
        ).all(row.id)
        for (const interjection of interjections) {
          this.db.run(
            `INSERT INTO delivery_tombstones (idempotency_key, write_enabled, completed_at)
             VALUES (?, ?, ?)
             ON CONFLICT(idempotency_key) DO UPDATE SET
               write_enabled = MAX(write_enabled, excluded.write_enabled),
               completed_at = MAX(completed_at, excluded.completed_at)`,
            [
              interjection.idempotency_key,
              interjection.write_enabled,
              interjection.delivered_at ?? interjection.answered_at
                ?? interjection.paused_at ?? interjection.created_at,
            ],
          )
          prunedInterjectionAttachments.push(
            ...parseAttachments(interjection.attachments_json),
          )
        }
        this.db.run('DELETE FROM job_interjections WHERE job_id = ?', [row.id])
        this.db.run('DELETE FROM job_controls WHERE job_id = ?', [row.id])
        this.db.run('DELETE FROM job_phase_dispatches WHERE job_id = ?', [row.id])
        this.db.run('DELETE FROM job_initial_dispatches WHERE job_id = ?', [row.id])
        this.db.run('DELETE FROM jobs WHERE id = ?', [row.id])
      }
      // Thread ownership is a security boundary: restarting zerochan from a
      // different project must never retarget an already-adopted Slack thread.
      // Keep these compact rows after job/result GC instead of re-resolving it.
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
      const liveInterjections = this.db.query<{ attachments_json: string }, []>(
        'SELECT attachments_json FROM job_interjections',
      ).all()
      return {
        candidates,
        prunedInterjectionAttachments,
        threads,
        tombstones,
        liveJobIds: new Set(liveJobs.map(row => row.id)),
        liveAttachments: new Set(
          [
            ...liveJobs.flatMap(row => parseAttachments(row.attachments_json)),
            ...liveInterjections.flatMap(row => parseAttachments(row.attachments_json)),
          ].map(path => resolve(path)),
        ),
      }
    })
    const result = retrySqlite(() => prune.immediate())
    const attachmentPaths = [
      ...result.candidates.flatMap(row => parseAttachments(row.attachments_json)),
      ...result.prunedInterjectionAttachments,
    ]
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
      `UPDATE artifact_deliveries SET delivered_at = ?, last_error = NULL
       WHERE job_id = ? AND artifact_path = ? AND started_at IS NOT NULL
         AND delivered_at IS NULL AND abandoned_at IS NULL`,
      [Date.now(), jobId, artifactPath],
    )
    if (updated.changes !== 1 && !this.artifactDelivered(jobId, artifactPath)) {
      throw new Error(`artifact delivery row is missing: ${artifactPath}`)
    }
  }

  uiApprovalRequest(idInput: string): UiApprovalRequestRecord | null {
    const row = this.db.query<UiApprovalRequestRow, [string]>(
      `SELECT id, job_id, round, input_revision, input_digest, repository_digest,
              session_id, proposal_text, before_path, after_path, status,
              response_message_id, response_user_id, response_text,
              response_input_revision, response_explicit_approval,
              prompt_client_message_id, prompt_delivery_started_at, prompt_message_id,
              prompt_delivered_at, attempts, not_before
       FROM ui_approval_requests WHERE id = ?`,
    ).get(requireText(idInput, 'UI approval request ID'))
    return row ? mapUiApprovalRequest(row) : null
  }

  latestUiApprovalContext(jobIdInput: string): UiApprovalResumeContext | undefined {
    const jobId = requireText(jobIdInput, 'jobId')
    const row = this.db.query<UiApprovalRequestRow, [string]>(
      `SELECT id, job_id, round, input_revision, input_digest, repository_digest,
              session_id, proposal_text, before_path, after_path, status,
              response_message_id, response_user_id, response_text,
              response_input_revision, response_explicit_approval,
              prompt_client_message_id, prompt_delivery_started_at, prompt_message_id,
              prompt_delivered_at, attempts, not_before
       FROM ui_approval_requests
       WHERE job_id = ? AND status = 'responded'
         AND response_message_id IS NOT NULL AND response_text IS NOT NULL
         AND response_input_revision IS NOT NULL AND response_explicit_approval IS NOT NULL
       ORDER BY round DESC LIMIT 1`,
    ).get(jobId)
    if (!row || row.response_message_id === null || row.response_text === null
      || row.response_input_revision === null || row.response_explicit_approval === null) {
      return undefined
    }
    return {
      requestId: row.id,
      requestInputRevision: row.input_revision,
      requestInputDigest: row.input_digest,
      responseInputRevision: row.response_input_revision,
      responseMessageId: row.response_message_id,
      responseText: row.response_text,
      explicitApproval: row.response_explicit_approval === 1,
      repositoryDigest: row.repository_digest,
    }
  }

  parkForUiApproval(input: {
    jobId: string
    sessionId: string
    inputRevision: number
    inputDigest: string
    repositoryDigest: string
    proposalText: string
    beforePath: string
    afterPath: string
  }): string {
    const jobId = requireText(input.jobId, 'jobId')
    const sessionId = requireText(input.sessionId, 'sessionId')
    const proposalText = requireText(input.proposalText, 'UI approval proposal')
      .slice(0, SLACK_CHUNK_CHARS - 160)
    if (!Number.isSafeInteger(input.inputRevision) || input.inputRevision < 1
      || !/^[0-9a-f]{64}$/.test(input.inputDigest)
      || !/^[0-9a-f]{64}$/.test(input.repositoryDigest)
      || !isAbsolute(input.beforePath) || !isAbsolute(input.afterPath)
      || input.beforePath === input.afterPath) {
      throw new Error('UI approval request binding is invalid')
    }
    const park = this.db.transaction(() => {
      const job = this.db.query<{
        input_revision: number
        session_id: string | null
        ui_approval_request_id: string | null
        chat_id: string
        thread_ts: string
        status: JobStatus
        cancel_requested_at: number | null
      }, [string]>(
        `SELECT input_revision, session_id, ui_approval_request_id, chat_id, thread_ts,
                status, cancel_requested_at
         FROM jobs WHERE id = ? AND runtime = 'codex'`,
      ).get(jobId)
      if (!job) {
        throw new Error('job disappeared before its UI/UX proposal could be parked')
      }
      if (job.cancel_requested_at !== null) {
        throw new UiApprovalParkingRaceError('cancelled')
      }
      if (job.status !== 'running' || job.input_revision !== input.inputRevision) {
        throw new UiApprovalParkingRaceError('input-changed')
      }
      if (job.session_id !== sessionId || job.ui_approval_request_id !== null) {
        throw new Error('job changed before its UI/UX proposal could be parked')
      }
      if (this.writePhaseMayHaveBeenDelivered(jobId)) {
        throw new Error('UI/UX approval cannot be requested after implementation may have started')
      }
      const pending = this.db.query<{ present: number }, [string, string, string]>(
        `SELECT 1 AS present FROM inbound_deliveries
         WHERE chat_id = ? AND thread_ts = ?
         UNION ALL
         SELECT 1 FROM job_interjections
         WHERE job_id = ? AND status NOT IN ('promoted', 'superseded')
         LIMIT 1`,
      ).get(job.chat_id, job.thread_ts, jobId)
      if (pending) throw new UiApprovalParkingRaceError('input-changed')
      const round = (this.db.query<{ round: number }, [string]>(
        'SELECT COALESCE(MAX(round), 0) + 1 AS round FROM ui_approval_requests WHERE job_id = ?',
      ).get(jobId)?.round ?? 1)
      const requestId = randomUUID()
      const now = Date.now()
      this.db.run(
        `UPDATE ui_approval_requests SET status = 'superseded'
         WHERE job_id = ? AND status = 'responded'`,
        [jobId],
      )
      this.db.run(
        `INSERT INTO ui_approval_requests (
           id, job_id, round, input_revision, input_digest, repository_digest,
           session_id, proposal_text, before_path, after_path, status,
           prompt_client_message_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'publishing', ?, ?)`,
        [
          requestId, jobId, round, input.inputRevision, input.inputDigest,
          input.repositoryDigest, sessionId, proposalText,
          input.beforePath, input.afterPath,
          slackClientMessageId(`ui-approval:${requestId}`, 0), now,
        ],
      )
      for (const path of [input.beforePath, input.afterPath]) {
        this.db.run(
          `INSERT INTO artifact_deliveries (job_id, artifact_path)
           VALUES (?, ?) ON CONFLICT(job_id, artifact_path) DO NOTHING`,
          [jobId, path],
        )
      }
      const updated = this.db.run(
        `UPDATE jobs
         SET status = 'queued', worker_id = NULL, started_at = NULL,
             executor_pid = NULL, pending_session_id = NULL, pending_result = NULL,
             not_before = NULL, finished_at = NULL, last_error = NULL,
             accepts_control = 1, executor_nonce = NULL,
             active_thread_id = NULL, active_turn_id = NULL,
             ui_approval_request_id = ?
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND input_revision = ? AND session_id = ? AND cancel_requested_at IS NULL`,
        [requestId, jobId, input.inputRevision, sessionId],
      )
      if (updated.changes !== 1) throw new Error('job could not enter UI/UX approval wait')
      this.supersedeLifecycleNotifications(jobId, now)
      return requestId
    })
    return retrySqlite(() => park.immediate())
  }

  pendingUiApprovalNotifications(now = Date.now(), limit = 20): UiApprovalNotification[] {
    const rows = this.db.query<UiApprovalRequestRow, [number, number]>(
      `SELECT id, job_id, round, input_revision, input_digest, repository_digest,
              session_id, proposal_text, before_path, after_path, status,
              response_message_id, response_user_id, response_text,
              response_input_revision, response_explicit_approval,
              prompt_client_message_id, prompt_delivery_started_at, prompt_message_id,
              prompt_delivered_at, attempts, not_before
       FROM ui_approval_requests
       WHERE status = 'publishing' AND (not_before IS NULL OR not_before <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM commentary_notifications AS commentary
           WHERE commentary.job_id = ui_approval_requests.job_id
             AND commentary.delivered_at IS NULL
         )
       ORDER BY created_at ASC LIMIT ?`,
    ).all(now, limit)
    return rows.flatMap(row => {
      const job = this.get(row.job_id)
      return job ? [{ id: row.id, jobId: row.job_id, job, request: mapUiApprovalRequest(row) }] : []
    })
  }

  uiApprovalNotificationDeliverable(idInput: string): boolean {
    return this.db.query<{ present: number }, [string]>(
      `SELECT 1 AS present FROM ui_approval_requests
       WHERE id = ? AND status = 'publishing'`,
    ).get(requireText(idInput, 'UI approval request ID')) !== null
  }

  beginUiApprovalPromptDelivery(idInput: string): {
    clientMessageId: string
    messageId: string | null
  } {
    const id = requireText(idInput, 'UI approval request ID')
    const begin = this.db.transaction(() => {
      const now = Date.now()
      const updated = this.db.run(
        `UPDATE ui_approval_requests
         SET prompt_delivery_started_at = COALESCE(prompt_delivery_started_at, ?)
         WHERE id = ? AND status = 'publishing'`,
        [now, id],
      )
      const row = this.db.query<{
        prompt_client_message_id: string
        prompt_message_id: string | null
        status: UiApprovalRequestRecord['status']
      }, [string]>(
        `SELECT prompt_client_message_id, prompt_message_id, status
         FROM ui_approval_requests WHERE id = ?`,
      ).get(id)
      if (!row || (!updated.changes && row.status !== 'publishing')) {
        throw new Error(`UI approval prompt is no longer publishable: ${id}`)
      }
      if (!/^[0-9a-f-]{36}$/.test(row.prompt_client_message_id)) {
        throw new Error(`UI approval prompt client message ID is invalid: ${id}`)
      }
      return {
        clientMessageId: row.prompt_client_message_id,
        messageId: row.prompt_message_id,
      }
    })
    return retrySqlite(() => begin.immediate())
  }

  recordUiApprovalPromptDelivered(idInput: string, messageIdInput: string): void {
    const id = requireText(idInput, 'UI approval request ID')
    const messageId = requireText(messageIdInput, 'Slack UI approval prompt timestamp')
    if (slackMessageOrdinal(messageId) === null) {
      throw new Error('Slack UI approval prompt timestamp is invalid')
    }
    const record = this.db.transaction(() => {
      const updated = this.db.run(
        `UPDATE ui_approval_requests
         SET prompt_message_id = ?, last_error = NULL
         WHERE id = ? AND status = 'publishing'
           AND prompt_delivery_started_at IS NOT NULL
           AND (prompt_message_id IS NULL OR prompt_message_id = ?)`,
        [messageId, id, messageId],
      )
      if (updated.changes === 1) return
      const row = this.db.query<{ prompt_message_id: string | null }, [string]>(
        'SELECT prompt_message_id FROM ui_approval_requests WHERE id = ?',
      ).get(id)
      if (row?.prompt_message_id !== messageId) {
        throw new Error(`UI approval prompt receipt changed before persistence: ${id}`)
      }
    })
    retrySqlite(() => record.immediate())
  }

  markUiApprovalPresented(idInput: string): void {
    const id = requireText(idInput, 'UI approval request ID')
    const present = this.db.transaction(() => {
      const now = Date.now()
      const updated = this.db.run(
        `UPDATE ui_approval_requests
         SET prompt_delivered_at = COALESCE(prompt_delivered_at, ?),
             status = CASE WHEN response_message_id IS NULL THEN 'awaiting' ELSE 'responded' END,
             not_before = NULL, last_error = NULL
         WHERE id = ? AND status = 'publishing' AND prompt_message_id IS NOT NULL`,
        [now, id],
      )
      if (updated.changes !== 1) {
        const row = this.uiApprovalRequest(id)
        if (row?.status === 'awaiting' || row?.status === 'responded') return
        throw new Error(`UI approval request is no longer publishable: ${id}`)
      }
      this.db.run(
        `UPDATE jobs SET ui_approval_request_id = NULL
         WHERE ui_approval_request_id = ?
           AND EXISTS (SELECT 1 FROM ui_approval_requests WHERE id = ? AND status = 'responded')`,
        [id, id],
      )
    })
    retrySqlite(() => present.immediate())
  }

  deferUiApprovalNotification(
    idInput: string,
    errorInput: string,
    now = Date.now(),
    retryMs = 30_000,
  ): void {
    this.db.run(
      `UPDATE ui_approval_requests
       SET attempts = attempts + 1, not_before = ?, last_error = ?
       WHERE id = ? AND status = 'publishing'`,
      [
        now + Math.max(1, retryMs),
        requireText(errorInput, 'UI approval notification error').slice(0, 4_000),
        requireText(idInput, 'UI approval request ID'),
      ],
    )
  }

  failUiApprovalWait(idInput: string, errorInput: string): boolean {
    const id = requireText(idInput, 'UI approval request ID')
    const error = requireText(errorInput, 'UI approval terminal error').slice(0, 4_000)
    const fail = this.db.transaction(() => {
      const request = this.db.query<{ job_id: string }, [string]>(
        `SELECT job_id FROM ui_approval_requests
         WHERE id = ? AND status = 'publishing'`,
      ).get(id)
      if (!request) return false
      const finishedAt = Date.now()
      const updated = this.db.run(
        `UPDATE jobs
         SET status = 'failed', worker_id = NULL, not_before = NULL,
             executor_pid = NULL, monitor_state = 0,
             pending_session_id = NULL, pending_result = NULL,
             accepts_control = 0, executor_nonce = NULL,
             active_thread_id = NULL, active_turn_id = NULL,
             ui_approval_request_id = NULL, terminal_outcome = 'failed',
             last_error = ?, finished_at = ?
         WHERE id = ? AND runtime = 'codex' AND status = 'queued'
           AND ui_approval_request_id = ?`,
        [error, finishedAt, request.job_id, id],
      )
      if (updated.changes !== 1) return false
      this.db.run(
        `UPDATE ui_approval_requests
         SET status = 'cancelled', responded_at = COALESCE(responded_at, ?),
             last_error = ?
         WHERE id = ? AND status = 'publishing'`,
        [finishedAt, error, id],
      )
      this.settleUiApprovalArtifactsForTerminal(
        request.job_id,
        finishedAt,
        'UI/UX approval upload could not be confirmed within its retry budget',
      )
      this.supersedeLifecycleNotifications(request.job_id, finishedAt)
      this.settleInterjectionsForTerminal(request.job_id, 'failed', finishedAt)
      this.db.run(
        `INSERT INTO terminal_notifications (
           id, job_id, kind, payload, created_at
         ) VALUES (?, ?, 'failed', ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           kind = excluded.kind, payload = excluded.payload,
           attempts = 0, not_before = NULL, last_error = NULL,
           created_at = excluded.created_at, body_delivered_at = NULL,
           reaction_delivered_at = NULL, delivered_at = NULL`,
        [randomUUID(), request.job_id, error, finishedAt],
      )
      return true
    })
    return retrySqlite(() => fail.immediate())
  }

  uiApprovalIsWaiting(jobIdInput: string): boolean {
    return this.db.query<{ present: number }, [string]>(
      `SELECT 1 AS present FROM jobs
       WHERE id = ? AND status = 'queued' AND ui_approval_request_id IS NOT NULL`,
    ).get(requireText(jobIdInput, 'jobId')) !== null
  }

  runningJobs(): JobRecord[] {
    return this.db.query<JobRow, []>(
      `SELECT * FROM jobs
       WHERE runtime = 'codex' AND status = 'running'
       ORDER BY seq ASC`,
    ).all().map(mapRow)
  }

  requeue(id: string, reason: string): void {
    const requeue = this.db.transaction(() => {
      const updated = this.db.run(
        `UPDATE jobs
         SET status = 'queued', worker_id = NULL, started_at = NULL,
             executor_pid = NULL, pending_session_id = NULL, pending_result = NULL,
             not_before = NULL, finished_at = NULL, last_error = ?,
             accepts_control = CASE WHEN cancel_requested_at IS NULL THEN 1 ELSE 0 END,
             executor_nonce = NULL,
             active_thread_id = NULL, active_turn_id = NULL
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND EXISTS (
             SELECT 1 FROM job_initial_dispatches receipts
             WHERE receipts.job_id = jobs.id AND receipts.attempt = jobs.attempts
               AND receipts.status IN ('prepared', 'rejected')
           )`,
        [reason, id],
      )
      if (updated.changes === 1) this.supersedeLifecycleNotifications(id)
      return updated.changes
    })
    if (retrySqlite(() => requeue.immediate()) !== 1) {
      throw new Error(`job ${id} cannot be safely requeued after initial App Server delivery`)
    }
  }

  requeueAfterUiApprovalRace(id: string): void {
    if (this.writePhaseMayHaveBeenDelivered(id)) {
      throw new Error('UI/UX approval race occurred after implementation may have started')
    }
    const job = this.get(id)
    if (!job || job.status !== 'running' || job.cancelRequestedAt !== null
      || job.uiApprovalRequestId !== null || this.hasStagedExecution(id)) {
      throw new Error(`job ${id} is not safely requeueable after UI/UX approval parking`)
    }
    this.requeue(id, 'new same-thread input arrived before UI/UX approval waiting began')
  }

  preparePreImplementationRepositoryDriftRetry(
    idInput: string,
    reasonInput: string,
    maxRetries = DEFAULT_MAX_REPOSITORY_DRIFT_RETRIES,
  ): 'prepared' | 'exhausted' | 'cancelled' | 'unsafe' {
    const id = requireText(idInput, 'jobId')
    const reason = requireText(reasonInput, 'repository drift reason').slice(0, 4_000)
    const retryLimit = positiveInteger(maxRetries, DEFAULT_MAX_REPOSITORY_DRIFT_RETRIES)
    const prepare = this.db.transaction(() => {
      const job = this.db.query<{
        attempts: number
        repository_drift_retries: number
        cancel_requested_at: number | null
        executor_pid: number | null
        active_turn_id: string | null
        pending_session_id: string | null
        pending_result: string | null
        ui_approval_request_id: string | null
      }, [string]>(
        `SELECT attempts, repository_drift_retries, cancel_requested_at,
                executor_pid, active_turn_id, pending_session_id, pending_result,
                ui_approval_request_id
         FROM jobs
         WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
      ).get(id)
      if (!job) return 'unsafe' as const
      if (job.cancel_requested_at !== null) return 'cancelled' as const
      if (job.executor_pid !== null || job.active_turn_id !== null
        || job.pending_session_id !== null || job.pending_result !== null
        || job.ui_approval_request_id !== null) return 'unsafe' as const
      const implementation = this.db.query<{ present: number }, [string]>(
        `SELECT 1 AS present FROM job_phase_dispatches
         WHERE job_id = ? AND stage = 'implementation'
           AND status IN ('dispatching', 'acknowledged', 'observed', 'ambiguous')
         LIMIT 1`,
      ).get(id)
      if (implementation) return 'unsafe' as const
      const monitorFailure = this.db.query<{ present: number }, [string]>(
        'SELECT 1 AS present FROM monitor_failures WHERE job_id = ? LIMIT 1',
      ).get(id)
      if (monitorFailure) return 'unsafe' as const
      const completedPreparation = this.db.query<
        { present: number }, [string, number, string, number]
      >(
        `SELECT 1 AS present
         WHERE EXISTS (
           SELECT 1 FROM job_initial_dispatches AS initial
           WHERE initial.job_id = ? AND initial.attempt = ? AND initial.status = 'observed'
         ) OR EXISTS (
           SELECT 1 FROM job_phase_dispatches AS phase
           WHERE phase.job_id = ? AND phase.attempt = ?
             AND phase.stage = 'prepare' AND phase.status = 'observed'
         )`,
      ).get(id, job.attempts, id, job.attempts)
      if (!completedPreparation) return 'unsafe' as const
      if (job.repository_drift_retries >= retryLimit) return 'exhausted' as const
      const updated = this.db.run(
        `UPDATE jobs
         SET repository_drift_intent_attempt = attempts,
             repository_drift_intent_reason = ?
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND cancel_requested_at IS NULL
           AND repository_drift_retries < ?
           AND executor_pid IS NULL AND active_turn_id IS NULL
           AND pending_session_id IS NULL AND pending_result IS NULL
           AND ui_approval_request_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM job_phase_dispatches AS phase
             WHERE phase.job_id = jobs.id AND phase.stage = 'implementation'
               AND phase.status IN ('dispatching', 'acknowledged', 'observed', 'ambiguous')
           )
           AND (
             EXISTS (
               SELECT 1 FROM job_initial_dispatches AS initial
               WHERE initial.job_id = jobs.id AND initial.attempt = jobs.attempts
                 AND initial.status = 'observed'
             ) OR EXISTS (
               SELECT 1 FROM job_phase_dispatches AS phase
               WHERE phase.job_id = jobs.id AND phase.attempt = jobs.attempts
                 AND phase.stage = 'prepare' AND phase.status = 'observed'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM monitor_failures WHERE monitor_failures.job_id = jobs.id
           )`,
        [reason, id, retryLimit],
      )
      if (updated.changes !== 1) return 'unsafe' as const
      return 'prepared' as const
    })
    return retrySqlite(() => prepare.immediate())
  }

  requeueAfterPreImplementationRepositoryDrift(
    idInput: string,
    maxRetries = DEFAULT_MAX_REPOSITORY_DRIFT_RETRIES,
  ): 'requeued' | 'exhausted' | 'cancelled' | 'unsafe' {
    const id = requireText(idInput, 'jobId')
    const retryLimit = positiveInteger(maxRetries, DEFAULT_MAX_REPOSITORY_DRIFT_RETRIES)
    const requeue = this.db.transaction(() => {
      const job = this.db.query<{
        attempts: number
        repository_drift_retries: number
        repository_drift_intent_attempt: number | null
        repository_drift_intent_reason: string | null
        cancel_requested_at: number | null
        executor_pid: number | null
        active_turn_id: string | null
        pending_session_id: string | null
        pending_result: string | null
        ui_approval_request_id: string | null
      }, [string]>(
        `SELECT attempts, repository_drift_retries,
                repository_drift_intent_attempt, repository_drift_intent_reason,
                cancel_requested_at, executor_pid, active_turn_id,
                pending_session_id, pending_result, ui_approval_request_id
         FROM jobs
         WHERE id = ? AND runtime = 'codex' AND status = 'running'`,
      ).get(id)
      if (!job) return 'unsafe' as const
      if (job.cancel_requested_at !== null) return 'cancelled' as const
      if (job.repository_drift_intent_attempt !== job.attempts
        || !job.repository_drift_intent_reason) return 'unsafe' as const
      if (job.executor_pid !== null || job.active_turn_id !== null
        || job.pending_session_id !== null || job.pending_result !== null
        || job.ui_approval_request_id !== null) return 'unsafe' as const
      if (this.writePhaseMayHaveBeenDelivered(id)) return 'unsafe' as const
      if (this.db.query<{ present: number }, [string]>(
        'SELECT 1 AS present FROM monitor_failures WHERE job_id = ? LIMIT 1',
      ).get(id)) return 'unsafe' as const
      const completedPreparation = this.db.query<
        { present: number }, [string, number, string, number]
      >(
        `SELECT 1 AS present
         WHERE EXISTS (
           SELECT 1 FROM job_initial_dispatches AS initial
           WHERE initial.job_id = ? AND initial.attempt = ? AND initial.status = 'observed'
         ) OR EXISTS (
           SELECT 1 FROM job_phase_dispatches AS phase
           WHERE phase.job_id = ? AND phase.attempt = ?
             AND phase.stage = 'prepare' AND phase.status = 'observed'
         )`,
      ).get(id, job.attempts, id, job.attempts)
      if (!completedPreparation) return 'unsafe' as const
      if (job.repository_drift_retries >= retryLimit) return 'exhausted' as const
      const now = Date.now()
      const updated = this.db.run(
        `UPDATE jobs
         SET status = 'queued', worker_id = NULL, started_at = NULL,
             executor_pid = NULL, pending_session_id = NULL, pending_result = NULL,
             not_before = NULL, finished_at = NULL,
             last_error = repository_drift_intent_reason,
             repository_drift_retries = repository_drift_retries + 1,
             repository_drift_intent_attempt = NULL,
             repository_drift_intent_reason = NULL,
             accepts_control = 1, executor_nonce = NULL,
             active_thread_id = NULL, active_turn_id = NULL,
             terminal_outcome = NULL
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND cancel_requested_at IS NULL
           AND repository_drift_retries < ?
           AND repository_drift_intent_attempt = attempts
           AND repository_drift_intent_reason IS NOT NULL
           AND executor_pid IS NULL AND active_turn_id IS NULL
           AND pending_session_id IS NULL AND pending_result IS NULL
           AND ui_approval_request_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM job_phase_dispatches AS phase
             WHERE phase.job_id = jobs.id AND phase.stage = 'implementation'
               AND phase.status IN ('dispatching', 'acknowledged', 'observed', 'ambiguous')
           )
           AND (
             EXISTS (
               SELECT 1 FROM job_initial_dispatches AS initial
               WHERE initial.job_id = jobs.id AND initial.attempt = jobs.attempts
                 AND initial.status = 'observed'
             ) OR EXISTS (
               SELECT 1 FROM job_phase_dispatches AS phase
               WHERE phase.job_id = jobs.id AND phase.attempt = jobs.attempts
                 AND phase.stage = 'prepare' AND phase.status = 'observed'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM monitor_failures WHERE monitor_failures.job_id = jobs.id
           )`,
        [id, retryLimit],
      )
      if (updated.changes !== 1) return 'unsafe' as const
      this.supersedeLifecycleNotifications(id, now)
      return 'requeued' as const
    })
    return retrySqlite(() => requeue.immediate())
  }

  releaseUnstartedClaim(id: string, workerId: string, reason: string): boolean {
    const release = this.db.transaction(() => {
      const job = this.db.query<{ attempts: number }, [string, string]>(
        `SELECT attempts FROM jobs
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND worker_id = ? AND executor_pid IS NULL`,
      ).get(id, workerId)
      if (!job || job.attempts < 1) return false
      const deleted = this.db.run(
        `DELETE FROM job_initial_dispatches
         WHERE job_id = ? AND attempt = ? AND status = 'prepared'`,
        [id, job.attempts],
      )
      if (deleted.changes !== 1) return false
      const updated = this.db.run(
        `UPDATE jobs
         SET status = 'queued',
             worker_id = NULL,
             started_at = NULL,
             executor_pid = NULL,
             pending_session_id = NULL,
             pending_result = NULL,
             not_before = NULL,
             finished_at = NULL,
             last_error = ?,
             executor_nonce = NULL,
             active_thread_id = NULL,
             active_turn_id = NULL,
             attempts = attempts - 1,
             session_id = CASE WHEN attempts = 1 THEN NULL ELSE session_id END,
             resumed = CASE WHEN attempts = 1 THEN 0 ELSE resumed END
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND worker_id = ? AND executor_pid IS NULL AND attempts = ?`,
        [reason, id, workerId, job.attempts],
      )
      if (updated.changes === 1) {
        this.db.run(
          `UPDATE lifecycle_notifications
           SET superseded_at = COALESCE(superseded_at, ?)
           WHERE job_id = ? AND attempt = ?
             AND delivered_at IS NULL AND superseded_at IS NULL`,
          [Date.now(), id, job.attempts],
        )
        this.db.run(
          `UPDATE progress_probes SET superseded_at = COALESCE(superseded_at, ?)
           WHERE job_id = ? AND attempt = ?
             AND reported_at IS NULL AND superseded_at IS NULL`,
          [Date.now(), id, job.attempts],
        )
      }
      return updated.changes === 1
    })
    return retrySqlite(() => release.immediate())
  }

  requeueAt(id: string, notBefore: number, reason: string, sessionId?: string): void {
    const persistedSessionId = sessionId === undefined
      ? undefined
      : requireText(sessionId, 'sessionId')
    const requeue = this.db.transaction(() => {
      if (persistedSessionId) {
        this.recordCodexSessionUse(persistedSessionId, id, Date.now())
      }
      const updated = this.db.run(
        `UPDATE jobs
         SET status = 'queued', worker_id = NULL, started_at = NULL,
             executor_pid = NULL, pending_session_id = NULL, pending_result = NULL,
             session_id = COALESCE(?, session_id), not_before = ?,
             finished_at = NULL, last_error = ?,
             accepts_control = CASE WHEN cancel_requested_at IS NULL THEN 1 ELSE 0 END,
             executor_nonce = NULL, active_thread_id = NULL, active_turn_id = NULL
         WHERE id = ? AND runtime = 'codex' AND status = 'running'
           AND EXISTS (
             SELECT 1 FROM job_initial_dispatches receipts
             WHERE receipts.job_id = jobs.id AND receipts.attempt = jobs.attempts
               AND receipts.status IN ('prepared', 'rejected', 'observed')
           )`,
        [persistedSessionId ?? null, notBefore, reason, id],
      )
      if (updated.changes === 1) {
        this.supersedeLifecycleNotifications(id)
        const job = this.db.query<{
          attempts: number
          chat_id: string
          thread_ts: string
        }, [string]>(
          'SELECT attempts, chat_id, thread_ts FROM jobs WHERE id = ?',
        ).get(id)
        if (!job) throw new Error(`rate-limited job disappeared: ${id}`)
        this.stageStatusNotificationRow({
          idempotencyKey: `rate-limited:${id}:${job.attempts}:${notBefore}`,
          jobId: id,
          chatId: job.chat_id,
          threadTs: job.thread_ts,
          kind: 'rate-limited',
          payload: slackRateLimitMessage(notBefore),
          createdAt: Date.now(),
        })
      }
      return updated.changes
    })
    const changes = retrySqlite(() => requeue.immediate())
    if (changes !== 1) {
      throw new Error(`job ${id} cannot be safely deferred after initial App Server delivery`)
    }
  }

  reconcileInterjectionsBeforeRecovery(): {
    preparedReset: number
    promoted: number
    blocked: number
  } {
    const preparedReset = retrySqlite(() => this.db.run(
      `UPDATE job_interjections
       SET status = CASE WHEN paused_at IS NULL THEN 'ready' ELSE 'paused' END,
           answer_request_id = NULL, answer_logical_nonce = NULL,
           answer_thread_id = NULL, answer_turn_id = NULL,
           answer_prepared_at = NULL, answer_dispatched_at = NULL,
           answer_acknowledged_at = NULL,
           last_error = 'daemon restarted before the answer request was written; safe to retry'
       WHERE status = 'answer-prepared'
         AND job_id IN (SELECT id FROM jobs WHERE status = 'running')`,
    ).changes)
    const delivered = retrySqlite(() => this.db.query<{ id: string }, []>(
      `SELECT i.id FROM job_interjections AS i
       JOIN jobs AS j ON j.id = i.job_id
       WHERE i.status = 'delivered' AND i.delivered_at IS NOT NULL
         AND j.status = 'running' AND j.cancel_requested_at IS NULL
       ORDER BY i.job_id ASC, i.seq ASC`,
    ).all())
    let promoted = 0
    let blocked = 0
    for (const row of delivered) {
      try {
        this.promoteDeliveredInterjection(row.id)
        promoted += 1
      } catch (error) {
        blocked += 1
        this.db.run(
          `UPDATE job_interjections SET last_error = ?
           WHERE id = ? AND status = 'delivered'`,
          [`startup promotion was blocked: ${String(error)}`.slice(0, 4_000), row.id],
        )
      }
    }
    return { preparedReset, promoted, blocked }
  }

  recoverInterrupted(advisorStateDir?: string): {
    requeued: number
    failedWrites: number
    failedUncertain: number
  } {
    let requeued = 0
    let failedWrites = 0
    let failedUncertain = 0
    for (const job of this.runningJobs()) {
      if (job.cancelRequestedAt !== null) {
        this.cancel(job.id)
        failedUncertain += 1
      } else if (job.writeEnabled) {
        const disposition = this.requeueAfterPreImplementationRepositoryDrift(
          job.id,
        )
        if (disposition === 'requeued') {
          requeued += 1
          continue
        }
        this.fail(
          job.id,
          'write-enabled job was interrupted after execution began; its external effects are uncertain. Review the repository and external services, then resend only if needed.',
        )
        failedWrites += 1
      } else if (job.notBefore !== null) {
        if (advisorStateDir && advisorAttemptMayHaveBeenDelivered(advisorStateDir, job.id)) {
          this.fail(
            job.id,
            'read-only job was interrupted after an advisor request may have been delivered; '
            + 'it will not be resent automatically. Send a new request if needed.',
          )
          failedUncertain += 1
        } else {
          this.requeueAt(
            job.id,
            job.notBefore,
            'daemon restarted after a durable Codex rate-limit receipt',
            job.sessionId ?? undefined,
          )
          requeued += 1
        }
      } else if (this.initialTurnMayHaveBeenDelivered(job.id)
        || !this.initialTurnDispatchIsSafeToRetry(job.id)
        || this.controlMayHaveBeenDelivered(job.id)
        || (advisorStateDir && advisorAttemptMayHaveBeenDelivered(advisorStateDir, job.id))) {
        this.fail(
          job.id,
          'read-only job was interrupted after an App Server, live control, or advisor request '
          + 'may have been delivered; '
          + 'it will not be resent automatically. Send a new request if needed.',
        )
        failedUncertain += 1
      } else {
        this.requeue(job.id, 'daemon restarted while read-only job was running')
        requeued += 1
      }
    }
    return { requeued, failedWrites, failedUncertain }
  }
}

export function createExecutorPidLifecycle(
  store: Pick<JobStore, 'saveExecutorPid' | 'clearExecutorPidAfterExit'>,
  jobIdInput: string,
): {
  onProcessId(processId: number): void
  onProcessExit(exitCode: number): void
} {
  const jobId = requireText(jobIdInput, 'jobId')
  let activeProcessId: number | null = null
  return {
    onProcessId(processId: number): void {
      if (activeProcessId !== null) {
        throw new Error(`executor PID ${activeProcessId} is still active for job ${jobId}`)
      }
      store.saveExecutorPid(jobId, processId)
      activeProcessId = processId
    },
    onProcessExit(_exitCode: number): void {
      if (activeProcessId === null) return
      const processId = activeProcessId
      store.clearExecutorPidAfterExit(jobId, processId)
      activeProcessId = null
    },
  }
}

export interface JobExecutionResult {
  sessionId: string
  result: string
}

export interface UiApprovalRequestRecord {
  id: string
  jobId: string
  round: number
  inputRevision: number
  inputDigest: string
  repositoryDigest: string
  sessionId: string
  proposalText: string
  beforePath: string
  afterPath: string
  status: 'publishing' | 'awaiting' | 'responded' | 'superseded' | 'cancelled'
  responseMessageId: string | null
  responseUserId: string | null
  responseText: string | null
  responseInputRevision: number | null
  responseExplicitApproval: boolean | null
  promptClientMessageId: string
  promptDeliveryStartedAt: number | null
  promptMessageId: string | null
  promptDeliveredAt: number | null
  attempts: number
  notBefore: number | null
}

export interface UiApprovalNotification {
  id: string
  jobId: string
  job: JobRecord
  request: UiApprovalRequestRecord
}

export interface TerminalNotification {
  id: string
  jobId: string
  kind: 'completed' | 'failed'
  payload: string
  attempts: number
  job: JobRecord
}

export interface LifecycleNotification {
  id: string
  jobId: string
  attempt: number
  kind: 'started' | 'progress'
  slot: number
  payload: string
  attempts: number
  job: JobRecord
}

export interface CommentaryNotification {
  id: string
  sourceKey: string
  jobId: string
  attempt: number
  payload: string
  attempts: number
  job: JobRecord
}

export type StatusNotificationKind =
  | 'accepted' | 'interrupt-accepted' | 'closed-control'
  | 'inactive-interrupt' | 'attachment-control-failed' | 'rate-limited'
  | 'interjection-answer'

export interface StatusNotification {
  id: string
  idempotencyKey: string
  jobId: string | null
  chatId: string
  threadTs: string
  kind: StatusNotificationKind
  payload: string
  attempts: number
}

export interface InterjectionNotification extends StatusNotification {
  kind: 'interjection-answer'
  jobId: string
  job: JobRecord
  interjection: JobInterjectionRecord
}

export interface JobExecutionContext {
  progressActivatedAtMs: number
  beginProgressProbe(probe: { slot: number; clientMessageId: string }): boolean
  supersedeProgressProbe(slot: number, supersededBySlot: number | null): void
  reportProgress(report: { slot: number; elapsedMs: number; text: string }): boolean
  reportCommentary(event: { sourceKey: string; text: string }): boolean
}

export type JobExecutor = (
  job: JobRecord,
  signal?: AbortSignal,
  context?: JobExecutionContext,
) => Promise<JobExecutionResult>

export interface JobNotifier {
  started?(job: JobRecord, notificationId?: string, signal?: AbortSignal): Promise<void>
  progress?(job: JobRecord, text: string, notificationId?: string, signal?: AbortSignal): Promise<void>
  completed?(job: JobRecord, result: string, notificationId?: string, signal?: AbortSignal): Promise<void>
  completionReaction?(job: JobRecord, notificationId?: string, signal?: AbortSignal): Promise<void>
  failed?(job: JobRecord, error: string, notificationId?: string, signal?: AbortSignal): Promise<void>
  artifactsAbandoned?(job: JobRecord, error: string, notificationId?: string, signal?: AbortSignal): Promise<void>
  uiApproval?(notification: UiApprovalNotification, signal?: AbortSignal): Promise<void>
  status?(notification: StatusNotification, signal?: AbortSignal): Promise<void>
  /** Wait until already-started lifecycle posts have either completed or reached their deadline. */
  settleLifecycleSideEffects?(): Promise<void>
  /** Wait until already-started, non-cancellable side effects have durable receipts. */
  settleStartedSideEffects?(): Promise<void>
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
  advisorStateDir?: string
  beforeClaim?: () => Promise<void>
  prepareExternalContext?: (job: JobRecord, signal?: AbortSignal) => Promise<void>
  settleExternalContext?: (job: JobRecord) => Promise<void>
  cancelExternalContext?: (job: JobRecord) => Promise<void>
  openJobMonitor?: (job: JobRecord, signal?: AbortSignal) => Promise<void>
  assertJobMonitorHealthy?: (job: JobRecord) => void
  quiesceJobMonitor?: (job: JobRecord) => Promise<void>
  updateJobMonitor?: (job: JobRecord, message: string) => Promise<void> | void
  recordJobMonitorFailure?: (job: JobRecord, error: unknown) => Promise<void> | void
  closeJobMonitor?: (job: JobRecord) => Promise<void>
  retainFailedJobMonitor?: (job: JobRecord) => Promise<void>
  executorStagesResult?: boolean
  signal?: AbortSignal
  onLog?: (message: string) => void
}

export const MAX_ARTIFACT_DELIVERY_ATTEMPTS = 5

export class ArtifactPublicationBlockedError extends Error {
  constructor() {
    super('artifact contains an obvious credential pattern')
    this.name = 'ArtifactPublicationBlockedError'
  }
}

export class ArtifactDeliveryAmbiguousError extends Error {
  readonly artifactPaths: string[]

  constructor(artifactPaths: readonly string[], cause?: unknown) {
    super(
      'artifact upload result is ambiguous; byte transfer will not be replayed',
      cause === undefined ? undefined : { cause },
    )
    this.name = 'ArtifactDeliveryAmbiguousError'
    this.artifactPaths = [...new Set(artifactPaths)]
  }
}

export class UiApprovalParkingRaceError extends Error {
  constructor(readonly disposition: 'input-changed' | 'cancelled') {
    super(
      disposition === 'cancelled'
        ? 'UI/UX approval parking was overtaken by cancellation'
        : 'UI/UX approval parking was overtaken by newer same-thread input',
    )
    this.name = 'UiApprovalParkingRaceError'
  }
}

export function publicJobFailureSummary(error: string): string {
  if (error.includes('repository changed before implementation')
    || error.includes('repository changed repeatedly before implementation')) {
    return '作業中に対象projectが別の変更で更新されたため、最新状態で安全に続行できませんでした。'
  }
  if (error.includes('write-enabled')
    && (error.includes('effects are uncertain') || error.includes('may already have changed'))) {
    return '変更処理の途中で失敗したため、一部の変更が残っている可能性があります。再送前に確認してください。'
  }
  if (error.includes('native advisor')
    || error.includes('native Codex advisor')
    || error.includes('advisor journal')) {
    return '補助レビューの回答と保存履歴を照合できませんでした。'
  }
  if (error.includes('Herdr monitor') || error.includes('monitor viewer')) {
    return '進捗表示との接続を維持できませんでした。'
  }
  if (error.includes('UI/UX approval') || error.includes('承認用画像')) {
    return 'Before／After画像をSlackへ確実に提示できませんでした。再度依頼してください。'
  }
  return '内部処理でエラーが発生しました。'
}

export class CodexResultPersistencePendingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexResultPersistencePendingError'
  }
}

async function runExternalContextBoundary(
  action: (() => Promise<void>) | undefined,
  label: string,
): Promise<void> {
  if (!action) return
  try {
    await action()
  } catch (error) {
    if (error instanceof EphemeralClaudeCleanupPendingError
      || error instanceof CodexCleanupPendingError
      || error instanceof CodexInterruptedError
      || error instanceof CodexUserCancelledError
      || error instanceof CodexResultPersistencePendingError
      || error instanceof HerdrJobMonitorPendingError) throw error
    throw new EphemeralClaudeCleanupPendingError(`${label}: ${error}`)
  }
}

async function updateMonitorRequired(
  action: (() => Promise<void> | void) | undefined,
  recordFailure: ((error: unknown) => Promise<void> | void) | undefined,
  log: (message: string) => void,
): Promise<void> {
  if (!action) return
  try { await action() } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`monitor status update failed: ${message}`)
    try { await recordFailure?.(error) } catch (recordError) {
      throw new HerdrJobMonitorPendingError(
        `monitor status update failed and its durable fault receipt is pending: ${recordError}`,
      )
    }
    if (error instanceof HerdrJobMonitorPendingError) throw error
    throw new HerdrJobMonitorPendingError(`monitor status update is pending: ${message}`)
  }
}

export async function flushLifecycleNotifications(
  store: JobStore,
  notifier: JobNotifier | undefined,
  log: (message: string) => void,
  retryMs = 30_000,
  signal?: AbortSignal,
): Promise<void> {
  if (!notifier) return
  for (const notification of store.pendingLifecycleNotifications()) {
    if (signal?.aborted) return
    if (!store.lifecycleNotificationDeliverable(notification.id)) continue
    try {
      if (notification.kind === 'started') {
        if (!notifier.started) continue
        await notifier.started(notification.job, notification.id, signal)
      } else {
        if (!notifier.progress) continue
        await notifier.progress(
          notification.job,
          notification.payload,
          notification.id,
          signal,
        )
      }
      if (signal?.aborted) return
      store.markLifecycleNotificationDelivered(notification.id)
    } catch (error) {
      if (signal?.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      const backoff = Math.min(
        retryMs * (2 ** Math.min(notification.attempts, 10)),
        6 * 60 * 60 * 1000,
      )
      store.deferLifecycleNotification(notification.id, message, Date.now(), backoff)
      log(`lifecycle notification ${notification.id} deferred: ${message}`)
    }
  }
}

export async function flushCommentaryNotifications(
  store: JobStore,
  notifier: JobNotifier | undefined,
  log: (message: string) => void,
  retryMs = 30_000,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!notifier?.progress) return false
  const maxDeliveriesPerPass = 50
  let deliveredCount = 0
  while (!signal?.aborted) {
    const pending = store.pendingCommentaryNotifications()
    if (pending.length === 0) return false
    let delivered = false
    for (const notification of pending) {
      if (signal?.aborted) return false
      if (!store.commentaryNotificationDeliverable(notification.id)) continue
      try {
        await notifier.progress(
          notification.job,
          notification.payload,
          notification.id,
          signal,
        )
        if (signal?.aborted) return false
        store.markCommentaryNotificationDelivered(notification.id)
        delivered = true
        deliveredCount += 1
      } catch (error) {
        if (signal?.aborted) return false
        const message = error instanceof Error ? error.message : String(error)
        const backoff = Math.min(
          retryMs * (2 ** Math.min(notification.attempts, 10)),
          6 * 60 * 60 * 1000,
        )
        store.deferCommentaryNotification(notification.id, message, Date.now(), backoff)
        log(`commentary notification ${notification.id} deferred: ${message}`)
      }
    }
    // A deferred head row blocks later commentary for that job until its
    // durable retry time. Stop instead of polling the same blocked queue.
    if (!delivered) return false
    // Yield to status/interjection/terminal traffic after a bounded burst.
    // A ready remainder asks the notification owner to begin another pass.
    if (deliveredCount >= maxDeliveriesPerPass) {
      return store.pendingCommentaryNotifications().length > 0
    }
  }
  return false
}

export async function flushStatusNotifications(
  store: JobStore,
  notifier: JobNotifier | undefined,
  log: (message: string) => void,
  retryMs = 30_000,
  signal?: AbortSignal,
): Promise<void> {
  if (!notifier?.status) return
  for (const notification of store.pendingStatusNotifications()) {
    if (signal?.aborted) return
    if (!store.statusNotificationDeliverable(notification.id)) continue
    try {
      await notifier.status(notification, signal)
      if (signal?.aborted) return
      store.markStatusNotificationDelivered(notification.id)
    } catch (error) {
      if (signal?.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      const backoff = Math.min(
        retryMs * (2 ** Math.min(notification.attempts, 10)),
        6 * 60 * 60 * 1000,
      )
      store.deferStatusNotification(notification.id, message, Date.now(), backoff)
      log(`status notification ${notification.id} deferred: ${message}`)
    }
  }
}

export async function flushInterjectionNotifications(
  store: JobStore,
  notifier: JobNotifier | undefined,
  log: (message: string) => void,
  retryMs = 30_000,
  signal?: AbortSignal,
): Promise<void> {
  if (!notifier?.status) return
  for (const notification of store.pendingInterjectionNotifications()) {
    if (signal?.aborted) return
    if (!store.interjectionNotificationDeliverable(notification.id)) continue
    try {
      await notifier.status(notification, signal)
      if (signal?.aborted) return
      store.markInterjectionNotificationDelivered(notification.id)
    } catch (error) {
      if (signal?.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      const backoff = Math.min(
        retryMs * (2 ** Math.min(notification.attempts, 10)),
        6 * 60 * 60 * 1000,
      )
      store.deferInterjectionNotification(notification.id, message, Date.now(), backoff)
      log(`interjection notification ${notification.id} deferred: ${message}`)
    }
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
      if (notification.kind === 'completed'
        && store.abandonedArtifactCount(notification.job.id) > 0
        && notifier.artifactsAbandoned) {
        await notifier.artifactsAbandoned(
          notification.job,
          'one or more ambiguous artifact uploads could not be confirmed',
          notification.id,
          signal,
        )
        if (signal?.aborted) return
      }
      if (notification.kind === 'completed' && notifier.completionReaction) {
        await notifier.completionReaction(notification.job, notification.id, signal)
        if (signal?.aborted) return
      }
      store.markTerminalNotificationDelivered(notification.id)
    } catch (error) {
      if (signal?.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof ArtifactDeliveryAmbiguousError
        && notification.kind === 'completed'
        && store.terminalNotificationBodyDelivered(notification.id)) {
        const exhausted = error.artifactPaths.filter(path => (
          store.recordArtifactAmbiguityCheck(notification.job.id, path, message)
            >= MAX_ARTIFACT_DELIVERY_ATTEMPTS
        ))
        if (exhausted.length > 0) {
          store.abandonAmbiguousArtifacts(notification.job.id, exhausted, message)
          log(`terminal notification ${notification.id}: ${exhausted.length} ambiguous artifact(s) abandoned`)
          if (store.unsettledArtifactCount(notification.job.id) === 0
            && notifier.artifactsAbandoned) {
            try {
              await notifier.artifactsAbandoned(
                notification.job, message, notification.id, signal,
              )
              if (signal?.aborted) return
              await notifier.completionReaction?.(
                notification.job, notification.id, signal,
              )
              if (signal?.aborted) return
              store.markTerminalNotificationDelivered(notification.id)
              continue
            } catch (fallbackError) {
              if (signal?.aborted) return
              const fallbackMessage = fallbackError instanceof Error
                ? fallbackError.message
                : String(fallbackError)
              const backoff = Math.min(
                retryMs * (2 ** Math.min(notification.attempts, 10)),
                6 * 60 * 60 * 1000,
              )
              store.deferTerminalNotification(
                notification.id, fallbackMessage, Date.now(), backoff,
              )
              log(`artifact abandonment notice ${notification.id} deferred: ${fallbackMessage}`)
              continue
            }
          }
        }
      }
      const backoff = Math.min(retryMs * (2 ** Math.min(notification.attempts, 10)), 6 * 60 * 60 * 1000)
      store.deferTerminalNotification(notification.id, message, Date.now(), backoff)
      log(`terminal notification ${notification.id} deferred: ${message}`)
      // A permanently broken artifact or Slack policy must not suppress every
      // later terminal result. This notification retains its own retry state.
      continue
    }
  }
}

export async function flushUiApprovalNotifications(
  store: JobStore,
  notifier: JobNotifier | undefined,
  log: (message: string) => void,
  retryMs = 30_000,
  signal?: AbortSignal,
): Promise<void> {
  if (!notifier?.uiApproval) return
  for (const notification of store.pendingUiApprovalNotifications()) {
    if (signal?.aborted) return
    if (!store.uiApprovalNotificationDeliverable(notification.id)) continue
    try {
      await notifier.uiApproval(notification, signal)
      if (signal?.aborted) return
      store.markUiApprovalPresented(notification.id)
    } catch (error) {
      if (signal?.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof ArtifactDeliveryAmbiguousError) {
        const exhausted = error.artifactPaths.filter(path => (
          store.recordArtifactAmbiguityCheck(notification.job.id, path, message)
            >= MAX_ARTIFACT_DELIVERY_ATTEMPTS
        ))
        if (exhausted.length > 0) {
          const terminalError = 'UI/UX approval images could not be confirmed in Slack '
            + `after ${MAX_ARTIFACT_DELIVERY_ATTEMPTS} checks`
          store.failUiApprovalWait(notification.id, terminalError)
          log(
            `UI approval notification ${notification.id}: `
            + `${exhausted.length} ambiguous attachment(s) exhausted and the wait was failed`,
          )
          continue
        }
      }
      const backoff = Math.min(
        retryMs * (2 ** Math.min(notification.request.attempts, 10)),
        6 * 60 * 60 * 1000,
      )
      store.deferUiApprovalNotification(notification.id, message, Date.now(), backoff)
      log(`UI approval notification ${notification.id} deferred: ${message}`)
    }
  }
}

export async function runQueuedJobs(options: RunQueuedJobsOptions): Promise<RunStats> {
  const pollMs = positiveInteger(options.pollMs, 1000)
  const maxJobsPerSession = positiveInteger(
    options.maxJobsPerSession,
    DEFAULT_MAX_JOBS_PER_SESSION,
  )
  const notificationRetryMs = positiveInteger(options.notificationRetryMs, 30_000)
  const stopWhenIdle = options.stopWhenIdle ?? false
  const log = options.onLog ?? (() => {})
  const stats: RunStats = { completed: 0, failed: 0, workersStarted: SERIAL_WORKER_COUNT }
  const workerId = `serial-worker-${randomUUID()}`
  const notificationController = new AbortController()
  const stopNotifications = () => notificationController.abort()
  options.signal?.addEventListener('abort', stopNotifications, { once: true })
  let notificationFlush: Promise<void> | null = null
  let notificationFlushRequested = false
  let lifecycleFlush: Promise<void> | null = null
  let lifecycleFlushRequested = false
  let lifecycleSchedulingOpen = false
  const scheduleNotificationFlush = () => {
    notificationFlushRequested = true
    if (notificationFlush) return
    notificationFlush = (async () => {
      while (notificationFlushRequested && !notificationController.signal.aborted) {
        notificationFlushRequested = false
        // Durable state replies, interjection answers, commentary, and terminal
        // results share a lane. SQL eligibility holds a terminal result until
        // every already-observed commentary item is delivered. Lifecycle
        // start/progress uses a separate lane below so an unrelated hanging
        // terminal post cannot prevent a newly claimed job from executing.
        await flushStatusNotifications(
          options.store,
          options.notifier,
          log,
          notificationRetryMs,
          notificationController.signal,
        )
        await flushInterjectionNotifications(
          options.store,
          options.notifier,
          log,
          notificationRetryMs,
          notificationController.signal,
        )
        await flushUiApprovalNotifications(
          options.store,
          options.notifier,
          log,
          notificationRetryMs,
          notificationController.signal,
        )
        await flushTerminalNotifications(
          options.store,
          options.notifier,
          log,
          notificationRetryMs,
          notificationController.signal,
        )
        const commentaryReady = await flushCommentaryNotifications(
          options.store,
          options.notifier,
          log,
          notificationRetryMs,
          notificationController.signal,
        )
        if (commentaryReady) notificationFlushRequested = true
      }
    })().finally(() => {
      notificationFlush = null
      if (notificationFlushRequested && !notificationController.signal.aborted) {
        scheduleNotificationFlush()
      }
    })
  }
  const scheduleLifecycleFlush = () => {
    if (!lifecycleSchedulingOpen || notificationController.signal.aborted) return
    lifecycleFlushRequested = true
    if (lifecycleFlush) return
    lifecycleFlush = (async () => {
      while (lifecycleFlushRequested
        && lifecycleSchedulingOpen
        && !notificationController.signal.aborted) {
        lifecycleFlushRequested = false
        await flushLifecycleNotifications(
          options.store,
          options.notifier,
          log,
          notificationRetryMs,
          notificationController.signal,
        )
      }
    })().finally(() => {
      lifecycleFlush = null
      // A delivered lifecycle start/progress row can make the next durable
      // commentary row eligible immediately. Wake that lane without waiting
      // for the periodic retry tick.
      if (!notificationController.signal.aborted) scheduleNotificationFlush()
      if (lifecycleFlushRequested
        && lifecycleSchedulingOpen
        && !notificationController.signal.aborted) {
        scheduleLifecycleFlush()
      }
    })
  }
  const notificationPump = setInterval(
    () => {
      scheduleNotificationFlush()
      scheduleLifecycleFlush()
    },
    Math.max(25, Math.min(notificationRetryMs, 1_000)),
  )
  notificationPump.unref()
  const updateMonitor = (job: JobRecord, message: string): Promise<void> => (
    updateMonitorRequired(
      options.updateJobMonitor ? () => options.updateJobMonitor!(job, message) : undefined,
      options.recordJobMonitorFailure
        ? error => options.recordJobMonitorFailure!(job, error)
        : undefined,
      log,
    )
  )

  log(`${workerId} started`)
  try {
    while (!options.signal?.aborted) {
      if (options.shouldPause?.()) {
        await Bun.sleep(pollMs)
        continue
      }
      scheduleNotificationFlush()

      if (options.store.countClaimable() > 0) await options.beforeClaim?.()

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

    let executionStarted = false
    let progressReportsOpen = false
    let progressActivatedAtMs = 0
    let unstartedMonitorClaimReleased = false
    let skipMonitorClose = false
    let closeRequeuedUiApprovalMonitor = false
    const quiesceLifecycleBeforeStateChange = async (): Promise<void> => {
      progressReportsOpen = false
      // Commentary is synchronously staged by the executor before it returns,
      // and terminal eligibility is blocked by every undelivered commentary
      // row. Do not await the shared Slack lane here: an unrelated hanging
      // terminal post must never stop the serial worker from claiming and
      // executing the next job.
      scheduleLifecycleFlush()
      if (lifecycleFlush) await lifecycleFlush
      lifecycleSchedulingOpen = false
      await options.notifier?.settleLifecycleSideEffects?.()
      await options.notifier?.settleStartedSideEffects?.()
    }
    const quiesceMonitorBeforeTerminal = async (): Promise<void> => {
      await quiesceLifecycleBeforeStateChange()
      await options.quiesceJobMonitor?.(job)
      options.assertJobMonitorHealthy?.(job)
    }
    try {
      if (job.cancelRequestedAt !== null) {
        if (job.monitorState === 'none') {
          skipMonitorClose = true
          options.store.cancel(job.id)
          stats.failed += 1
          log(`${workerId} cancelled fresh queued job ${job.id} without opening a monitor`)
          scheduleNotificationFlush()
          continue
        }
        await updateMonitor(job, '待機中のタスクに届いた中止要求を反映します')
        await runExternalContextBoundary(
          options.cancelExternalContext
            ? () => options.cancelExternalContext!(job)
            : options.settleExternalContext
              ? () => options.settleExternalContext!(job)
              : undefined,
          `advisor cancellation cleanup is pending for job ${job.id}`,
        )
        await updateMonitor(job, '一時的な補助セッションを終了しました')
        await quiesceMonitorBeforeTerminal()
        options.store.cancel(job.id)
        stats.failed += 1
        log(`${workerId} cancelled queued job ${job.id} without starting Codex`)
        scheduleNotificationFlush()
        continue
      }
      try {
        await runExternalContextBoundary(
          options.prepareExternalContext
            ? () => options.prepareExternalContext!(job, options.signal)
            : undefined,
          `advisor preparation is pending for job ${job.id}`,
        )
        await options.openJobMonitor?.(job, options.signal)
      } catch (error) {
        await runExternalContextBoundary(
          error instanceof CodexUserCancelledError && options.cancelExternalContext
            ? () => options.cancelExternalContext!(job)
            : options.settleExternalContext
              ? () => options.settleExternalContext!(job)
              : undefined,
          error instanceof CodexUserCancelledError
            ? `advisor cancellation cleanup is pending for job ${job.id}`
            : `advisor cleanup is pending for job ${job.id}`,
        )
        if (error instanceof CodexUserCancelledError) {
          skipMonitorClose = true
          options.store.cancel(job.id)
          stats.failed += 1
          log(`${workerId} cancelled ${job.id} while preparing its advisor context`)
          scheduleNotificationFlush()
          continue
        }
        if (error instanceof HerdrJobMonitorPendingError
          && !options.store.releaseUnstartedClaim(
            job.id,
            workerId,
            `Herdr monitor preparation will be reconciled before retry: ${error.message}`,
          )) {
          throw new CodexResultPersistencePendingError(
            `Herdr monitor failed before execution, but the unstarted claim could not be released: ${error.message}`,
          )
        }
        if (error instanceof HerdrJobMonitorPendingError) {
          unstartedMonitorClaimReleased = true
        }
        throw error
      }
      log(`${workerId} claimed ${job.id}`)
      if (options.store.get(job.id)?.cancelRequestedAt !== null) {
        throw new CodexUserCancelledError()
      }
      progressActivatedAtMs = options.store.activateJobLifecycle(job.id, job.attempts)
      progressReportsOpen = true
      lifecycleSchedulingOpen = true
      scheduleLifecycleFlush()
      options.assertJobMonitorHealthy?.(job)
      let execution: JobExecutionResult
      try {
        executionStarted = true
        execution = await options.executor(job, options.signal, {
          progressActivatedAtMs,
          beginProgressProbe: probe => {
            if (!progressReportsOpen) return false
            const disposition = options.store.stageProgressProbe(
              job.id,
              job.attempts,
              probe.slot,
              probe.clientMessageId,
            )
            return disposition === 'staged' || disposition === 'duplicate'
          },
          supersedeProgressProbe: (slot, supersededBySlot) => {
            options.store.supersedeProgressProbe(
              job.id,
              job.attempts,
              slot,
              supersededBySlot,
            )
          },
          reportProgress: report => {
            if (!progressReportsOpen) return false
            const disposition = options.store.stageProgressNotification(
              job.id,
              job.attempts,
              report.slot,
              report.text,
            )
            if (disposition === 'staged') scheduleLifecycleFlush()
            return disposition === 'staged' || disposition === 'duplicate'
          },
          reportCommentary: event => {
            if (!progressReportsOpen) return false
            const disposition = options.store.stageCommentaryNotification(
              job.id,
              job.attempts,
              event.sourceKey,
              event.text,
            )
            if (disposition === 'staged') scheduleNotificationFlush()
            return disposition === 'staged' || disposition === 'duplicate'
          },
        })
        progressReportsOpen = false
        await quiesceLifecycleBeforeStateChange()
        options.assertJobMonitorHealthy?.(job)
      } catch (error) {
        // A supervisor cleanup failure means Codex/advisor descendants are not
        // yet proven stopped. Preserve the running row and reconcile both
        // process and owned advisor boundaries on daemon restart.
        if (error instanceof CodexCleanupPendingError
          || error instanceof CodexResultPersistencePendingError
          || error instanceof CodexRateLimitError) throw error
        await runExternalContextBoundary(
          error instanceof CodexUserCancelledError && options.cancelExternalContext
            ? () => options.cancelExternalContext!(job)
            : options.settleExternalContext
              ? () => options.settleExternalContext!(job)
              : undefined,
          error instanceof CodexUserCancelledError
            ? `advisor cancellation cleanup is pending for job ${job.id}`
            : `advisor cleanup is pending for job ${job.id}`,
        )
        throw error
      }
      if (options.executorStagesResult) {
        try {
          options.store.assertExecutionResultStaged(job.id, execution.sessionId, execution.result)
        } catch (error) {
          throw new CodexResultPersistencePendingError(
            `executor result checkpoint is unconfirmed for job ${job.id}: ${error}`,
          )
        }
      } else {
        options.store.stageExecutionResult(job.id, execution.sessionId, execution.result)
      }
      options.assertJobMonitorHealthy?.(job)
      await updateMonitor(job, '実行結果を安全に保存しました')
      await runExternalContextBoundary(
        options.settleExternalContext ? () => options.settleExternalContext!(job) : undefined,
        `advisor cleanup is pending for job ${job.id}`,
      )
      if (options.store.get(job.id)?.cancelRequestedAt !== null) {
        throw new CodexUserCancelledError()
      }
      options.assertJobMonitorHealthy?.(job)
      await updateMonitor(job, '一時的な補助セッションを終了しました')
      await updateMonitor(job, 'キューの結果を確定します')
      // Stop and await the in-flight async Herdr probe, then synchronously
      // assert and commit in the same JS turn. A mere failure-flag read cannot
      // prove health while list/process-info is still pending.
      await quiesceMonitorBeforeTerminal()
      try {
        options.store.completeStagedExecution(job.id)
      } catch (error) {
        if (options.store.get(job.id)?.cancelRequestedAt !== null) {
          throw new CodexUserCancelledError()
        }
        throw new CodexResultPersistencePendingError(
          `advisor cleanup completed but the result remains staged for job ${job.id}: ${error}`,
        )
      }
      stats.completed += 1
      scheduleNotificationFlush()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof CodexUiApprovalRequiredError) {
        try {
          const current = options.store.get(job.id)
          if (!current) throw new Error(`UI/UX approval job disappeared: ${job.id}`)
          const parked = prepareUiApprovalForParking(
            current,
            error,
            options.advisorStateDir ?? dirname(options.store.dbPath),
          )
          await updateMonitor(job, 'Before／AfterをSlackへ提示し、回答待ちに移ります')
          await quiesceMonitorBeforeTerminal()
          const requestId = options.store.parkForUiApproval({ jobId: job.id, ...parked })
          log(`${workerId} parked ${job.id} for UI/UX approval request ${requestId}`)
          scheduleNotificationFlush()
          continue
        } catch (approvalError) {
          const approvalMessage = approvalError instanceof Error
            ? approvalError.message
            : String(approvalError)
          if (approvalError instanceof UiApprovalParkingRaceError) {
            const current = options.store.get(job.id)
            if (approvalError.disposition === 'cancelled'
              || current?.cancelRequestedAt != null) {
              await runExternalContextBoundary(
                options.cancelExternalContext
                  ? () => options.cancelExternalContext!(job)
                  : options.settleExternalContext
                    ? () => options.settleExternalContext!(job)
                    : undefined,
                `advisor cancellation cleanup is pending for job ${job.id}`,
              )
              options.store.cancel(job.id)
              stats.failed += 1
              log(`${workerId} cancelled ${job.id} while entering UI/UX approval wait`)
              scheduleNotificationFlush()
              continue
            }
            options.store.requeueAfterUiApprovalRace(job.id)
            closeRequeuedUiApprovalMonitor = true
            log(`${workerId} requeued ${job.id} after UI/UX proposal input changed`)
            continue
          }
          await updateMonitor(job, 'Before／Afterを安全に提示できないため失敗として確定します')
          await quiesceMonitorBeforeTerminal()
          options.store.fail(job.id, approvalMessage)
          stats.failed += 1
          scheduleNotificationFlush()
          continue
        }
      }
      if (error instanceof HerdrJobMonitorPendingError
        && !executionStarted && !unstartedMonitorClaimReleased) {
        // A lifecycle delivery may already be in flight if the monitor failed
        // after activation but before the executor started. Close the scheduler
        // and drain that delivery before the claim becomes queueable again.
        await quiesceLifecycleBeforeStateChange()
        await runExternalContextBoundary(
          options.settleExternalContext ? () => options.settleExternalContext!(job) : undefined,
          `advisor cleanup is pending for job ${job.id}`,
        )
        if (!options.store.releaseUnstartedClaim(
          job.id,
          workerId,
          `Herdr monitor failed before Codex execution: ${error.message}`,
        )) {
          throw new CodexResultPersistencePendingError(
            `Herdr monitor failed before execution, but the unstarted claim could not be released: ${error.message}`,
          )
        }
        unstartedMonitorClaimReleased = true
      }
      if (error instanceof CodexCleanupPendingError
        || error instanceof EphemeralClaudeCleanupPendingError
        || error instanceof CodexResultPersistencePendingError
        || error instanceof HerdrJobMonitorPendingError) throw error
      if (error instanceof CodexUserCancelledError) {
        if (!executionStarted) {
          await runExternalContextBoundary(
            options.cancelExternalContext
              ? () => options.cancelExternalContext!(job)
              : options.settleExternalContext
                ? () => options.settleExternalContext!(job)
                : undefined,
            `advisor cancellation cleanup is pending for job ${job.id}`,
          )
        }
        await updateMonitor(job, '中止要求を反映し、安全な後処理を完了しました')
        await quiesceMonitorBeforeTerminal()
        options.store.cancel(job.id)
        stats.failed += 1
        log(`${workerId} cancelled ${job.id}`)
        scheduleNotificationFlush()
        continue
      }
      if (error instanceof CodexRepositoryChangedBeforeImplementationError) {
        await updateMonitor(job, '対象projectが更新されたため、最新状態で調査をやり直します')
        await quiesceLifecycleBeforeStateChange()
        const prepared = options.store.preparePreImplementationRepositoryDriftRetry(
          job.id,
          error.message,
        )
        const disposition = prepared === 'prepared'
          ? options.store.requeueAfterPreImplementationRepositoryDrift(job.id)
          : prepared
        if (disposition === 'requeued') {
          log(`${workerId} requeued ${job.id} after pre-implementation repository drift`)
          continue
        }
        if (disposition === 'cancelled') {
          await updateMonitor(job, '中止要求を反映し、安全な後処理を完了しました')
          await quiesceMonitorBeforeTerminal()
          options.store.cancel(job.id)
          stats.failed += 1
          log(`${workerId} cancelled ${job.id} while recovering repository drift`)
          scheduleNotificationFlush()
          continue
        }
        const implementationMayHaveChanged = options.store.writePhaseMayHaveBeenDelivered(job.id)
        const failure = implementationMayHaveChanged
          ? 'write-enabled implementation may already have changed the repository or external '
            + 'services before later repository drift was detected. Review those effects, then '
            + 'resend only if needed.'
          : disposition === 'exhausted'
            ? 'repository changed repeatedly before implementation; '
              + 'automatic fresh preparation retry limit was reached'
            : 'repository changed before implementation, but safe automatic fresh preparation '
              + 'could not be proven'
        await updateMonitor(
          job,
          implementationMayHaveChanged
            ? '一部の変更が残っている可能性があるため失敗として確定します'
            : '最新状態での安全な再調査ができないため失敗として確定します',
        )
        await quiesceMonitorBeforeTerminal()
        options.store.fail(job.id, failure)
        stats.failed += 1
        log(`${workerId} failed repository drift recovery for ${job.id}: ${failure}`)
        scheduleNotificationFlush()
        continue
      }
      if (error instanceof CodexInterruptedError || options.signal?.aborted) {
        const appServerUncertain = options.store.initialTurnMayHaveBeenDelivered(job.id)
          || !options.store.initialTurnDispatchIsSafeToRetry(job.id)
          || options.store.controlMayHaveBeenDelivered(job.id)
        const advisorUncertain = !job.writeEnabled && options.advisorStateDir
          ? advisorAttemptMayHaveBeenDelivered(options.advisorStateDir, job.id)
          : false
        if (job.writeEnabled || appServerUncertain || advisorUncertain) {
          const uncertain = job.writeEnabled
            ? 'write-enabled job was interrupted after execution began; '
              + 'its external effects are uncertain. Review the repository and external services, '
              + 'then resend only if needed.'
            : 'read-only job was interrupted after an App Server, live control, or advisor '
              + 'request may have been delivered; '
              + 'it will not be resent automatically. Send a new request if needed.'
          await updateMonitor(job, '中断後の副作用が不確実なため失敗として確定します')
          await quiesceMonitorBeforeTerminal()
          options.store.fail(job.id, uncertain)
          stats.failed += 1
          log(`${workerId} failed interrupted uncertain job ${job.id}: ${message}`)
          scheduleNotificationFlush()
        } else {
          await updateMonitor(job, '中断されたため、同じ監視タブで再開を待ちます')
          await quiesceLifecycleBeforeStateChange()
          options.store.requeue(job.id, message || 'worker interrupted')
          log(`${workerId} requeued ${job.id}: ${message}`)
        }
        return stats
      }
      const rateLimitSafeBeforeInitialDelivery = error instanceof CodexRateLimitError
        && options.store.initialTurnDispatchIsSafeToRetry(job.id)
        && !options.store.controlMayHaveBeenDelivered(job.id)
      if (error instanceof CodexRateLimitError && job.writeEnabled
        && !rateLimitSafeBeforeInitialDelivery) {
        const uncertain = 'write-enabled job hit a rate limit after execution began; '
          + 'its external effects are uncertain. Review the repository and external services, '
          + 'then resend only if needed.'
        await runExternalContextBoundary(
          options.settleExternalContext ? () => options.settleExternalContext!(job) : undefined,
          `advisor cleanup is pending for rate-limited write job ${job.id}`,
        )
        await updateMonitor(job, '利用上限後の副作用が不確実なため失敗として確定します')
        await quiesceMonitorBeforeTerminal()
        options.store.fail(job.id, uncertain)
        stats.failed += 1
        log(`${workerId} failed rate-limited write job ${job.id}: ${message}`)
        scheduleNotificationFlush()
        continue
      }
      if (error instanceof CodexRateLimitError && options.advisorStateDir
        && advisorAttemptMayHaveBeenDelivered(options.advisorStateDir, job.id)) {
        const uncertain = 'read-only job hit a rate limit after an advisor request may have been '
          + 'delivered; it will not be resent automatically. Send a new request if needed.'
        await runExternalContextBoundary(
          options.settleExternalContext ? () => options.settleExternalContext!(job) : undefined,
          `advisor cleanup is pending for rate-limited advisor job ${job.id}`,
        )
        await updateMonitor(job, 'advisor 送信後の利用上限により失敗として確定します')
        await quiesceMonitorBeforeTerminal()
        options.store.fail(job.id, uncertain)
        stats.failed += 1
        log(`${workerId} failed rate-limited advisor job ${job.id}: ${message}`)
        scheduleNotificationFlush()
        continue
      }
      if (error instanceof CodexRateLimitError) {
        const resumeAt = codexRateLimitResumeAt(error.resetsAtMs)
        await updateMonitor(
          job,
          `利用上限のため ${new Date(resumeAt).toISOString()} まで待機します`,
        )
        await quiesceLifecycleBeforeStateChange()
        options.store.requeueAt(job.id, resumeAt, message, error.sessionId)
        log(`${workerId} deferred ${job.id} until ${new Date(resumeAt).toISOString()}: ${message}`)
        scheduleNotificationFlush()
        continue
      }
      const failure = job.writeEnabled && options.store.writePhaseMayHaveBeenDelivered(job.id)
        ? 'write-enabled implementation may already have changed the repository or external '
          + 'services before a later phase failed. Review those effects, then resend only if '
          + `needed. Underlying failure: ${message}`
        : message
      await updateMonitor(job, '失敗として確定します')
      await quiesceMonitorBeforeTerminal()
      options.store.fail(job.id, failure)
      stats.failed += 1
      scheduleNotificationFlush()
    } finally {
      const settled = options.store.get(job.id)
      if (!skipMonitorClose && settled
        && (settled.status === 'completed' || settled.status === 'failed'
          || (settled.status === 'queued'
            && (settled.uiApprovalRequestId !== null || closeRequeuedUiApprovalMonitor)))) {
        if (settled.status === 'failed' && settled.terminalOutcome === 'failed'
          && options.retainFailedJobMonitor) {
          await options.retainFailedJobMonitor(settled)
        } else {
          await options.closeJobMonitor?.(settled)
        }
      }
    }
    }
    return stats
  } finally {
    lifecycleSchedulingOpen = false
    clearInterval(notificationPump)
    // On a normal run-until-idle exit, let already-started durable deliveries
    // commit their receipts before aborting the notification signal. An
    // external shutdown still aborts immediately, and arbitrary notifiers
    // remain bounded by the existing one-second drain.
    if (!options.signal?.aborted) {
      if (notificationFlush) await Promise.race([notificationFlush, Bun.sleep(1_000)])
    }
    notificationController.abort()
    options.signal?.removeEventListener('abort', stopNotifications)
    if (notificationFlush) {
      await Promise.race([notificationFlush, Bun.sleep(1_000)])
    }
    // Arbitrary notifier failures must not block the FIFO forever, but the
    // production Slack uploader must finish any side effect it already began
    // and persist its receipt before the DB can be closed by the caller.
    await options.notifier?.settleStartedSideEffects?.()
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
  const dir = stateDir()
  return resolveZeroJobDatabasePath(dir)
}

function loadStateEnv(dir: string): void {
  const envFile = join(dir, '.env')
  applyStateEnvironment(readOptionalPrivateFile(envFile) ?? '')
}

/** A daemon must never keep claiming work after its selected Slack App changes. */
export function stateSlackTokenPairMatches(dir: string, expectedRuntimeId: string): boolean {
  try {
    const tokens = parseStateSlackTokens(readOptionalPrivateFile(join(dir, '.env')) ?? '')
    return Boolean(
      tokens.SLACK_BOT_TOKEN
      && tokens.SLACK_APP_TOKEN
      && slackTokenPairRuntimeIdentity(tokens.SLACK_BOT_TOKEN, tokens.SLACK_APP_TOKEN)
        === expectedRuntimeId,
    )
  } catch {
    return false
  }
}

/** Stop before a new claim when the selected credential pair changes. */
export function createSlackIdentityPauseGuard(
  dir: string,
  expectedRuntimeId: string | undefined,
  controller: AbortController,
  log: (message: string) => void,
): () => boolean {
  let reported = false
  return () => {
    if (!expectedRuntimeId || stateSlackTokenPairMatches(dir, expectedRuntimeId)) return false
    if (!reported) {
      log('selected Slack App changed; stopping this runner before claiming more work')
      reported = true
    }
    controller.abort()
    return true
  }
}

const SLACK_CHUNK_CHARS = 3_500
/** 1 通知が占有してよい Slack メッセージ数の上限。 */
const MAX_SLACK_MESSAGES = 5
const SLACK_TRUNCATION_NOTICE = '\n\n…(長すぎるため以降を省略しました。全文はこのMacの管理ログを確認してください)'

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
const ARTIFACT_CREDENTIAL_SCAN_CHUNK_BYTES = 256 * 1024
const ARTIFACT_CREDENTIAL_SCAN_OVERLAP_BYTES = 16 * 1024

function safeJobId(jobId: string): string {
  return jobId.replace(/[^A-Za-z0-9._-]/g, '_')
}

type ExecutionResultJournal = {
  version: 1
  jobId: string
  sessionId: string
  result: string
  createdAt: number
}

const MAX_EXECUTION_RESULT_JOURNAL_BYTES = 256 * 1024
const MAX_PERSISTED_RESULT_TEXT_CHARS = 12_000

function executionResultJournalPath(dirInput: string, jobId: string): string {
  const dir = requireManagedStateRoot(dirInput)
  if (safeJobId(jobId) !== jobId || !jobId) throw new Error('unsafe execution result job ID')
  const root = ensureManagedDirectory(dir, join(dir, 'execution-results'))
  return join(root, jobId)
}

function parseExecutionResultJournal(raw: string, expectedJobId: string): ExecutionResultJournal {
  if (Buffer.byteLength(raw) > MAX_EXECUTION_RESULT_JOURNAL_BYTES) {
    throw new Error('execution result journal is too large')
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('execution result journal is invalid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('execution result journal must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.jobId !== expectedJobId
    || typeof record.sessionId !== 'string' || !record.sessionId
    || typeof record.result !== 'string'
    || !Number.isSafeInteger(record.createdAt) || Number(record.createdAt) < 0) {
    throw new Error('execution result journal has invalid fields')
  }
  return {
    version: 1,
    jobId: expectedJobId,
    sessionId: record.sessionId,
    result: record.result,
    createdAt: Number(record.createdAt),
  }
}

export function persistExecutionResultJournal(
  dir: string,
  job: JobRecord,
  execution: JobExecutionResult,
): void {
  const path = executionResultJournalPath(dir, job.id)
  const existing = readOptionalPrivateFile(path)
  if (existing !== null) {
    const journal = parseExecutionResultJournal(existing, job.id)
    if (journal.sessionId !== execution.sessionId || journal.result !== execution.result) {
      throw new Error(`execution result journal conflicts for job ${job.id}`)
    }
    return
  }
  const serialized = `${JSON.stringify({
    version: 1,
    jobId: job.id,
    sessionId: requireText(execution.sessionId, 'sessionId'),
    result: execution.result,
    createdAt: Date.now(),
  } satisfies ExecutionResultJournal)}\n`
  if (Buffer.byteLength(serialized) > MAX_EXECUTION_RESULT_JOURNAL_BYTES) {
    throw new Error('execution result journal is too large')
  }
  atomicWritePrivateFile(path, serialized)
}

export function recoverExecutionResultJournals(store: JobStore, dir: string): number {
  let recovered = 0
  for (const job of store.runningJobs()) {
    const raw = readOptionalPrivateFile(executionResultJournalPath(dir, job.id))
    if (raw === null) continue
    const journal = parseExecutionResultJournal(raw, job.id)
    if (store.ensureExecutionResultStaged(job.id, journal.sessionId, journal.result)) recovered += 1
  }
  return recovered
}

export function sealedArtifactDirForJob(dir: string, jobId: string): string {
  return join(dir, 'sealed-artifacts', safeJobId(jobId))
}

export function extractArtifactPaths(result: string): { text: string; files: string[] } {
  const opening = /<zerokun_files>/i.exec(result)
  if (!opening) return { text: result, files: [] }
  const visibleText = result.slice(0, opening.index).trimEnd()
  const match = /^<zerokun_files>([\s\S]*?)<\/zerokun_files>\s*$/i.exec(
    result.slice(opening.index),
  )
  // The opening tag reserves the remainder for host-only artifact metadata.
  // Fail closed for a missing close tag, trailing junk, or a second marker so
  // no private outbox path can become Slack text.
  if (!match) return { text: visibleText, files: [] }
  try {
    const parsed = JSON.parse(match[1]!.trim())
    const files = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string').slice(0, 10)
      : []
    return { text: visibleText, files }
  } catch {
    // A malformed host-only marker must never be forwarded as user-visible
    // Slack text: it may contain the private outbox path and logical job ID.
    return { text: visibleText, files: [] }
  }
}

const INTERNAL_IMPLEMENTATION_NAME = /(?:\bOpenAI[ -]Codex\b|\bOpenAI(?:[ -]?API)?\b|\bCodex\b|\bClaude(?:[ -]Code)?\b|\bGrok\b|\bHerdr\b|\bApp[ -]Server\b|\bModel[ -]Context[ -]Protocol\b|\bMCP(?:[ -]?broker)?\b|\bGPT(?:[- ]?(?:\d+(?:\.\d+)*(?:[A-Za-z][A-Za-z0-9]*)?(?:-[A-Za-z0-9]+)*|oss(?:-[A-Za-z0-9]+)*))?\b|\bo\d+(?:[-.][A-Za-z0-9]+)*\b|\badvisor[ -]?panels?\b|\badvisors?\b|\bsub[ -]?agents?\b|\bbrokers?\b|\bJSON[ -]?RPC\b|\bSeatbelt\b|コーデックス|クロードコード|クロード|グロック|モデルコンテキストプロトコル|アドバイザー|サブエージェント|ブローカー)/i
const SELF_IMPLEMENTATION_NON_DISCLOSURE = '内部構成は公開していません。'

const INTERNAL_IMPLEMENTATION_ALIASES = [
  'OpenAI Codex', 'OpenAI API', 'OpenAI', 'Codex', 'Claude Code', 'Claude',
  'Grok', 'Herdr', 'App Server', 'Model Context Protocol', 'MCP broker', 'MCP',
  'GPT', 'advisor panel', 'advisor panels', 'advisor', 'advisors', 'subagent',
  'subagents', 'sub agent', 'sub agents', 'reviewer', 'reviewers', 'broker',
  'brokers', 'JSON RPC', 'Seatbelt',
] as const

const escapeRegularExpression = (value: string): string => (
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
)

const implementationSkeletonAlternatives = [
  ...INTERNAL_IMPLEMENTATION_ALIASES.flatMap(alias => [
    alias,
    alias.toLowerCase(),
    alias.toUpperCase(),
  ]),
].map(alias => normalizeImplementationGuardText(alias)
  .split(/[\s_-]+/)
  .map(escapeRegularExpression)
  .join('[\\s_-]*'))
  .sort((left, right) => right.length - left.length)

const implementationSkeletonLeftBoundary = '(?:(?<![\\p{L}\\p{N}_])|(?<=[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]))'
const implementationSkeletonRightBoundary = '(?=$|[^\\p{L}\\p{N}_]|[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}])'
const implementationStaticSkeletonCore = `(?:${implementationSkeletonAlternatives.join('|')})`
const INTERNAL_IMPLEMENTATION_SKELETON = new RegExp(
  `${implementationSkeletonLeftBoundary}${implementationStaticSkeletonCore}${implementationSkeletonRightBoundary}`,
  'iu',
)
const implementationDigitSkeletonValues = [...new Set(
  Array.from({ length: 10 }, (_value, digit) => (
    normalizeImplementationGuardText(String(digit))
  )),
)]
const implementationDigitSkeleton = implementationDigitSkeletonValues
  .map(escapeRegularExpression).join('|')
const IMPLEMENTATION_DIGIT_SKELETON_SET = new Set(implementationDigitSkeletonValues)
const gptSkeleton = escapeRegularExpression(normalizeImplementationGuardText('GPT'))
const oSkeleton = [
  normalizeImplementationGuardText('o'),
  normalizeImplementationGuardText('O'),
].map(escapeRegularExpression).join('|')
const implementationDynamicSkeletonCore = `(?:${gptSkeleton}(?:(?:[- ]?(?:${implementationDigitSkeleton})+(?:\\.(?:${implementationDigitSkeleton})+)*(?:[A-Za-z][A-Za-z0-9]*)?(?:-[A-Za-z0-9]+)*)|(?:[- ]?oss(?:-[A-Za-z0-9]+)*))|(?:${oSkeleton})(?:${implementationDigitSkeleton})+(?:[-.][A-Za-z0-9]+)*)`
const INTERNAL_DYNAMIC_IMPLEMENTATION_SKELETON = new RegExp(
  `${implementationSkeletonLeftBoundary}${implementationDynamicSkeletonCore}${implementationSkeletonRightBoundary}`,
  'iu',
)
const implementationRoleSuffix = '(?:Worker|Runner|Reviewer|Monitor|Runtime|Executor|Session|Queue|Broker|Server|Backend|Agent|Supervisor|Client|Window|Pane|Endpoint|Transport|Connection|Channel|Thread|Process)'
const INTERNAL_PROCESS_IDENTIFIER_SKELETON = new RegExp(
  `${implementationSkeletonLeftBoundary}(?:(?:${implementationStaticSkeletonCore}|${implementationDynamicSkeletonCore})[\\s_-]*${implementationRoleSuffix}s?|(?:serial|job|queue|task|thread|session)[\\s_-]*${implementationRoleSuffix}s?)${implementationSkeletonRightBoundary}`,
  'iu',
)
const INTERNAL_INFLECTED_IMPLEMENTATION_SKELETON = new RegExp(
  implementationStaticSkeletonCore,
  'iu',
)
const INTERNAL_INFLECTED_DYNAMIC_IMPLEMENTATION_SKELETON = new RegExp(
  `^${implementationDynamicSkeletonCore}[\\p{L}\\p{N}\\p{M}_]{1,4}$`,
  'iu',
)

const DISTINCTIVE_IMPLEMENTATION_IDENTIFIER = /(?:OpenAI|Codex|Claude|Grok|Herdr|Seatbelt|MCP|GPT)/gi
const INTERNAL_PRODUCT_ROLE_IDENTIFIER = /(?:OpenAI|Codex|Claude|Grok|Herdr|Seatbelt|MCP|GPT)(?:worker|runner|reviewer|monitor|runtime|executor|session|queue|broker|server|backend|agent|supervisor|client|window|pane|endpoint|transport|connection|channel|thread|process)s?/i
const INTERNAL_O_PRODUCT_ROLE_IDENTIFIER = /o\d+[A-Za-z0-9._-]*(?:worker|runner|reviewer|monitor|runtime|executor|session|queue|broker|server|backend|agent|supervisor|client|window|pane|endpoint|transport|connection|channel|thread|process)s?/i
const DISTINCTIVE_IMPLEMENTATION_IDENTIFIER_NAMES = [
  'openai', 'codex', 'claude', 'grok', 'herdr', 'seatbelt', 'mcp', 'gpt',
] as const

function containsAsciiImplementationIdentifier(value: string, allowedText = ''): boolean {
  const allowedTokens = new Set(
    (allowedText.match(/[A-Za-z0-9_]+/g) ?? []).map(token => token.toLowerCase()),
  )
  return (value.match(/[A-Za-z0-9_]+/g) ?? []).some(token => {
    const folded = token.toLowerCase()
    if (allowedTokens.has(folded)) return false
    if (DISTINCTIVE_IMPLEMENTATION_IDENTIFIER_NAMES.some(name => (
      folded !== name && folded.includes(name)
    ))) return true
    if (INTERNAL_PRODUCT_ROLE_IDENTIFIER.test(token)) return true
    if (INTERNAL_O_PRODUCT_ROLE_IDENTIFIER.test(token)) return true
    for (const match of token.matchAll(/o\d+/gi)) {
      const index = match.index ?? 0
      const end = index + match[0].length
      const previous = token[index - 1] ?? ''
      const next = token[end] ?? ''
      const startsSegment = index === 0 || previous === '_'
        || (/[a-z0-9]/.test(previous) && /[A-Z]/.test(token[index] ?? ''))
      const endsSegment = end === token.length || next === '_' || /[A-Z]/.test(next)
      if (startsSegment && endsSegment) return true
    }
    for (const match of token.matchAll(new RegExp(DISTINCTIVE_IMPLEMENTATION_IDENTIFIER.source, 'gi'))) {
      const index = match.index ?? 0
      const end = index + match[0].length
      const previous = token[index - 1] ?? ''
      const next = token[end] ?? ''
      const beginsCamelSegment = index > 0
        && (previous === '_' || /[A-Z]/.test(token[index] ?? ''))
      const endsAtSegmentBoundary = end === token.length || next === '_'
        || /[A-Z]/.test(next)
      if ((beginsCamelSegment && endsAtSegmentBoundary)
        || (index === 0 && end < token.length && /[A-Z_]/.test(next))) {
        return true
      }
    }
    return false
  })
}

function containsImplementationSkeleton(value: string, allowedIdentifierText = ''): boolean {
  const skeleton = normalizeImplementationGuardText(value)
  return containsAsciiImplementationIdentifier(value, allowedIdentifierText)
    || INTERNAL_IMPLEMENTATION_SKELETON.test(skeleton)
    || INTERNAL_DYNAMIC_IMPLEMENTATION_SKELETON.test(skeleton)
    || INTERNAL_PROCESS_IDENTIFIER_SKELETON.test(skeleton)
    || (value.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? []).some(token => {
      const tokenSkeleton = normalizeImplementationGuardText(token)
      if (tokenSkeleton === token.normalize('NFD')) return false
      if (INTERNAL_INFLECTED_IMPLEMENTATION_SKELETON.test(tokenSkeleton)
        || INTERNAL_INFLECTED_DYNAMIC_IMPLEMENTATION_SKELETON.test(tokenSkeleton)) {
        return true
      }
      const characters = [...token.normalize('NFD')]
      for (let start = 0; start < characters.length - 1; start += 1) {
        const source = characters[start] ?? ''
        const sourceSkeleton = normalizeImplementationGuardText(source)
        if (!/\p{L}/u.test(source) || !/^o$/i.test(sourceSkeleton)) continue
        // Interior ASCII `o` is common in public identifiers such as logo123.
        // Interior confusables are not: their skeleton change is the signal
        // that an o-family model name was embedded inside a larger token.
        if (start > 0 && sourceSkeleton === source.normalize('NFD')) continue
        let digitCount = 0
        for (const character of characters.slice(start + 1)) {
          if (!/\p{N}/u.test(character)
            || !IMPLEMENTATION_DIGIT_SKELETON_SET.has(
              normalizeImplementationGuardText(character),
            )) break
          digitCount += 1
        }
        if (digitCount > 0) return true
      }
      return false
    })
}

function containsInternalImplementationName(value: string): boolean {
  const normalized = normalizePublicGuardText(value)
  return INTERNAL_IMPLEMENTATION_NAME.test(normalized)
    || containsImplementationSkeleton(normalized)
}

function containsConfusableInternalImplementationName(
  value: string,
  allowedIdentifierText = '',
): boolean {
  const withoutExactNames = value.replace(
    new RegExp(INTERNAL_IMPLEMENTATION_NAME.source, 'gi'),
    match => ' '.repeat(match.length),
  )
  return containsImplementationSkeleton(withoutExactNames, allowedIdentifierText)
}

export function sanitizeExecutionTextForSlack(
  job: JobRecord,
  sessionId: string,
  text: string,
  dir: string,
  additionalSensitiveValues: readonly string[] = [],
): string {
  const normalizeGuardText = normalizePublicGuardText
  const slackAuthoredTask = (task: string, attachments: readonly string[]): string => {
    if (attachments.length === 0) return task
    // Compatibility for rows created before task/attachment authority was
    // separated. Strip exactly the suffix generated by the host, once; an
    // identical block genuinely typed by the user remains before this copy.
    const legacySuffix = `\n添付ファイル（ローカル絶対パス）:\n${attachments
      .map(path => `- ${path}`).join('\n')}`
    return task.endsWith(legacySuffix) ? task.slice(0, -legacySuffix.length) : task
  }
  const visible: string[] = []
  let insideHostBlock = false
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim().replace(/^>\s*/, '')
    if (/^--- Zero host (?:control|phase control|follow-up binding|write-phase preemption|progress check)\b/i.test(normalized)) {
      insideHostBlock = true
      continue
    }
    if (insideHostBlock) {
      if (/^--- end Zero host\b/i.test(normalized)) insideHostBlock = false
      continue
    }
    if (/^(?:Logical attempt nonce|Durable input revision|Durable input digest|Job ID|Slack thread|Slack message|Current sender|Sender|Project root|Artifact directory|Write authorized for this message):/i.test(normalized)) {
      continue
    }
    if (/^\[ZERO_[^\]\r\n]*\]$/i.test(normalized)) continue
    visible.push(line)
  }

  let sanitized = normalizeGuardText(visible.join('\n'))
  let inputEntries = [{
    task: job.task,
    attachments: job.attachments,
    messageId: job.messageId,
    userId: job.userId,
  }]
  try {
    inputEntries = readAdvisorInputSnapshot(dir, job.id).entries.map(entry => ({
      task: entry.task,
      attachments: entry.attachments,
      messageId: entry.messageId,
      userId: entry.userId,
    }))
  } catch {}
  const userText = normalizeGuardText(inputEntries
    .map(entry => slackAuthoredTask(entry.task, entry.attachments))
    .join('\n'))
  const latestEntry = inputEntries.at(-1)
  const latestUserText = normalizeGuardText(latestEntry
    ? slackAuthoredTask(latestEntry.task, latestEntry.attachments)
    : job.task)
  const sensitiveValues = [
    artifactDirForJob(dir, job.id),
    sealedArtifactDirForJob(dir, job.id),
    ...job.attachments,
    ...inputEntries.flatMap(entry => entry.attachments),
    ...inputEntries.map(entry => entry.messageId),
    ...inputEntries.map(entry => entry.userId),
    job.repoPath,
    dir,
    sessionId,
    job.id,
    `${job.chatId} / ${job.threadTs}`,
    job.messageId,
    job.threadTs,
    job.chatId,
    job.userId,
    job.executorNonce,
    ...additionalSensitiveValues,
  ].filter((value): value is string => typeof value === 'string' && value.length >= 4)
    .map(normalizeGuardText)
    .sort((left, right) => right.length - left.length)
  for (const value of new Set(sensitiveValues)) {
    sanitized = sanitized.split(value).join('（内部情報を省略）')
  }

  // A commit SHA is useful completion evidence, but a bare hex token is also
  // indistinguishable from Zero's runtime IDs. Preserve it only when the
  // answer labels it as a commit and Git confirms that it names a commit in
  // the repository handled by this job.
  const gitBinary = '/usr/bin/git'
  let commitVerificationRoots: string[] = []
  try {
    const layout = resolveAdvisorProjectLayout(job.repoPath)
    commitVerificationRoots = layout.gitRoots.length > 0
      ? layout.gitRoots
      : [job.repoPath]
  } catch {}
  const verifiedGitCommits = new Map<string, boolean>()
  const isVerifiedGitCommit = (value: string): boolean => {
    const normalized = value.toLowerCase()
    const cached = verifiedGitCommits.get(normalized)
    if (cached != null) return cached
    let verified = false
    if (/^[0-9a-f]{7,64}$/i.test(value)) {
      let matches = 0
      for (const root of commitVerificationRoots) try {
        const result = Bun.spawnSync([
          gitBinary, '-C', root, 'cat-file', '-e', `${value}^{commit}`,
        ], {
          env: {
            PATH: '/usr/bin:/bin',
            HOME: '/',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: '/usr/bin/false',
            GIT_OPTIONAL_LOCKS: '0',
            LC_ALL: 'C',
            LANG: 'C',
          },
          stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
        })
        if (result.exitCode === 0) matches += 1
      } catch {}
      // A short SHA that names commits in multiple independent repositories
      // is ambiguous in a project-wide Slack answer. Full object IDs remain
      // useful even when identical content happens to exist in two members.
      verified = matches === 1 || (matches > 0 && value.length >= 40)
    }
    verifiedGitCommits.set(normalized, verified)
    return verified
  }
  const protectedGitCommits: string[] = []
  const gitCommitPlaceholderNonce = [...randomUUID().replaceAll('-', '')]
    .map(character => String.fromCharCode(71 + Number.parseInt(character, 16)))
    .join('')
  sanitized = sanitized.replace(
    /(?<![A-Za-z0-9_])((?:commit(?:[ \t]*(?:id|sha|hash))?|コミット(?:[ \t]*(?:ID|SHA|ハッシュ))?)[ \t]*[:：#]?[ \t]*`?)([0-9a-f]{7,64})(`?)(?![0-9a-f])/gi,
    (match, prefix: string, value: string, suffix: string) => {
      if (!isVerifiedGitCommit(value)) return match
      const index = protectedGitCommits.push(value) - 1
      return `${prefix}\uE004${gitCommitPlaceholderNonce}_${index}\uE005${suffix}`
    },
  )

  // Strip path and runtime-identity shapes before replacing their component
  // implementation names. Otherwise `~/.codex/...` could become a partially
  // redacted path that still reveals the host layout.
  const redactPathUnlessUserAuthored = (value: string): string => (
    userText.includes(normalizeGuardText(value)) ? value : '（内部パスを省略）'
  )
  const pathCredential = /(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|credentials)(?:[\\/]|$)/i
  const conventionalLocalRoot = /(?:^|[\\/])(?:Users|home|private|tmp|var|etc|opt|usr|srv|System|Library|Applications|Volumes)(?:[\\/]|$)/i
  const homePathPrefix = /^(?:~|\$HOME|\$\{HOME\})(?:[\\/]|$)/i
  const absolutePlatformPath = /^(?:\\\\|[A-Za-z]:[\\/])/i
  const driveRelativePlatformPath = /^[A-Za-z]:[^\s`'"<>。、！？!?;,\)\]}]+/i
  const inspectPathSpelling = (value: string): { decoded: string; stable: boolean } => {
    const mapConfusableSeparators = (input: string): string => input
      .replace(/[\u2044\u2215\u2571\u27CB\u29F8]/g, '/')
      .replace(/[\u2216\u2572\u27CD\u29F5\u29F9]/g, '\\')
      .replace(/[\u2236\uA789]/g, ':')
    const decodeOnce = (input: string): string => input.replace(
      /(?:%[0-9a-f]{2})+/gi,
      run => {
        try {
          return decodeURIComponent(run)
        } catch {
          return run.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => (
            String.fromCharCode(Number.parseInt(hex, 16))
          ))
        }
      },
    )
    let decoded = mapConfusableSeparators(normalizeGuardText(value))
    for (let round = 0; round < 4; round += 1) {
      const next = mapConfusableSeparators(decodeOnce(decoded))
      if (next === decoded) return { decoded, stable: true }
      decoded = next
    }
    return { decoded, stable: decodeOnce(decoded) === decoded }
  }
  const containsDecodedInternalIdentity = (value: string): boolean => {
    const decoded = normalizeGuardText(value)
    return sensitiveValues.some(sensitive => decoded.includes(sensitive))
      || containsInternalImplementationName(decoded)
      || /\bw[A-Za-z0-9_-]+:[pt][A-Za-z0-9_-]+\b|\bterm_[A-Za-z0-9_-]+\b/.test(decoded)
      || /(?<![A-Za-z0-9_])"?(?:pid|process[ _-]?id|state[ _-]?change[ _-]?seq|duration[ _-]?ms)"?(?:\s*[:=]\s*|\s+(?:is\s+)?)"?\d+"?(?![A-Za-z0-9_])/i.test(decoded)
      || /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(decoded)
      || /\b[0-9a-f]{32,64}\b/i.test(decoded)
      || /\b[UCBWD][A-Z0-9]{8,}\b/.test(decoded)
  }
  const normalizedUrlPath = (value: string): string => {
    const inspection = inspectPathSpelling(value)
    return inspection.stable ? inspection.decoded.replace(/^\/+/, '/') : ''
  }
  const hostPathSegments = [
    'Users', 'home', 'private', 'tmp', 'var', 'etc', 'opt', 'usr', 'srv',
    'System', 'Library', 'Applications', 'Volumes', 'bin', 'sbin', 'lib',
    'libexec', 'local', 'share', 'homebrew', 'Application Support', 'Caches',
    'Preferences', 'Logs', 'LaunchAgents', 'LaunchDaemons', 'Desktop',
    'Documents', 'Downloads', 'Projects',
  ] as const
  const hostPathSegmentSkeletons = new Map(hostPathSegments.map(segment => [
    normalizeImplementationGuardText(segment),
    segment,
  ]))
  const canonicalHostPath = (value: string): string => normalizedUrlPath(value)
    .split('/')
    .map(segment => hostPathSegmentSkeletons.get(
      normalizeImplementationGuardText(segment),
    ) ?? segment)
    .join('/')
  const sensitiveHostHomePrefixes = new Set(sensitiveValues.flatMap(value => {
    const match = canonicalHostPath(value).match(/^\/(?:Users|home)\/[^/]+/)
    return match ? [match[0]] : []
  }))
  const sensitiveHostHomePrefixSkeletons = new Set(
    [...sensitiveHostHomePrefixes].map(normalizeImplementationGuardText),
  )
  const startsWithConventionalHostRoot = (value: string): boolean => (
    /^\/(?:Users|home|private|tmp|var|etc|opt|usr|srv|System|Library|Applications|Volumes)(?:\/|$)/.test(
      canonicalHostPath(value),
    )
  )
  const resemblesConventionalHostPath = (value: string): boolean => {
    if (value.length === 0) return false
    const inspection = inspectPathSpelling(value)
    if (!inspection.stable) return true
    const path = canonicalHostPath(value)
    const candidateHomePrefix = path.match(/^\/(?:Users|home)\/[^/]+/)?.[0]
    const fileLikeLeaf = /\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(path)
    return [...sensitiveHostHomePrefixes].some(prefix => (
      path === prefix || path.startsWith(`${prefix}/`)
    ))
      || (candidateHomePrefix != null
        && sensitiveHostHomePrefixSkeletons.has(
          normalizeImplementationGuardText(candidateHomePrefix),
        ))
      || /^\/private\/(?:tmp|var)(?:\/|$)/.test(path)
      || /^\/System\/(?:Volumes|Library)(?:\/|$)/.test(path)
      || /^\/etc(?:\/|$)/.test(path)
      || /^\/usr\/(?:bin|sbin|lib|libexec|local|share)(?:\/|$)/.test(path)
      || /^\/opt\/homebrew(?:\/|$)/.test(path)
      || /^\/Applications\/[^/]+\.app(?:\/|$)/.test(path)
      || /^\/Library\/(?:Application Support|Caches|Preferences|Logs|LaunchAgents|LaunchDaemons)(?:\/|$)/.test(path)
      || /^\/Volumes\/[^/]+(?:\/|$)/.test(path)
      || /^\/(?:Users|home)\/[^/]+\/(?:Desktop|Documents|Downloads|Library|Applications|Projects|\.config|\.ssh|\.aws|\.gnupg|\.kube|\.docker)(?:\/|$)/.test(path)
      || (/^\/(?:Users|home|tmp|var|srv)(?:\/|$)/.test(path) && fileLikeLeaf)
  }
  const redactPath = (value: string, always = false): string => {
    const normalized = normalizeGuardText(value)
    return always || pathCredential.test(normalized)
      ? '（内部パスを省略）'
      : redactPathUnlessUserAuthored(value)
  }
  // Home-relative credential/config paths are unsafe even when the sender
  // pasted them. Match through the enclosing clause so a path with spaces or
  // Unicode cannot leave a revealing suffix behind.
  sanitized = sanitized.replace(
    /\$\{(?:[A-Za-z0-9_]|%[0-9a-f]{2}){1,64}(?:\}|(?:%[0-9a-f]{2})+)[^\s`'"<>。、！？!?;,\)\]}]*/gim,
    value => {
      const inspection = inspectPathSpelling(value)
      return !inspection.stable || homePathPrefix.test(inspection.decoded)
        ? redactPath(value, true)
        : value
    },
  )
  sanitized = sanitized.replace(
    /(?:~|\$HOME|\$\{HOME\})(?:[\\/\u2044\u2215\u2216\u2571\u2572\u27CB\u27CD\u29F5\u29F8\u29F9]|%[0-9a-f]{2})+[^\r\n`'"<>。、！？!?;,\)\]}]*/gim,
    value => redactPath(value, true),
  )
  sanitized = sanitized.replace(
    /(?:~[\\/])?\.(?:codex|claude|zerokun|ssh|aws|gnupg|kube|docker)(?:[\\/][^\r\n`'"<>。、！？!?;,\)\]}]*)?/gim,
    value => redactPath(value, pathCredential.test(value)),
  )
  // Inspect every URL-like scheme as one unit. Decode separators only in the
  // detector, never in the visible text. Internal/local schemes and URLs that
  // embed a local root or credential path are removed as a whole, closing
  // host, triple-slash and percent-encoded variants without leaking suffixes.
  const protectedMimeTypes: string[] = []
  const mimePlaceholderNonce = randomUUID().replaceAll('-', '')
  sanitized = sanitized.replace(
    /\b(?:application|audio|font|image|message|model|multipart|text|video)\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}(?![A-Za-z0-9!#$&^_.+\\/%-])/gi,
    value => {
      const index = protectedMimeTypes.push(value) - 1
      return `\uE006${mimePlaceholderNonce}_${index}\uE007`
    },
  )
  const protectedPublicUrls: string[] = []
  const urlPlaceholderNonce = randomUUID().replaceAll('-', '')
  const isLocalHostname = (input: string): boolean => {
    const hostname = input.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase()
    return hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname === '0.0.0.0' || hostname === '::1' || /^127(?:\.|$)/.test(hostname)
      || hostname.endsWith('.local') || hostname.endsWith('.invalid')
      || hostname.endsWith('.test') || hostname.endsWith('.internal')
      || hostname.endsWith('.lan') || hostname.endsWith('.home')
      || hostname.endsWith('.home.arpa')
      || (!hostname.includes('.') && !hostname.includes(':'))
      || /^10\./.test(hostname) || /^192\.168\./.test(hostname)
      || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
      || /^169\.254\./.test(hostname)
      || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)
      || /^198\.(?:18|19)\./.test(hostname)
      || /^(?:fc|fd|fe[89ab])[0-9a-f]*:/i.test(hostname)
      || hostname === '::' || hostname.startsWith('::ffff:')
  }
  const isLocalEndpointSpelling = (input: string): boolean => {
    const inspection = inspectPathSpelling(input)
    if (!inspection.stable) return true
    const decoded = inspection.decoded
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(decoded)
    const hasEndpoint = /^(?:\[[0-9a-f:.%]+\]|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?::\d{1,5})?(?:[/?#])[^\s]*$/i.test(decoded)
    if (!hasScheme && !hasEndpoint) return false
    try {
      const parsed = new URL(hasScheme ? decoded : `http://${decoded}`)
      return isLocalHostname(parsed.hostname)
    } catch {
      return false
    }
  }
  const protectPublicUrl = (value: string, _encoded = false): string => {
    const inspection = inspectPathSpelling(value)
    let parsed: URL
    try {
      parsed = new URL(inspection.decoded.startsWith('//')
        ? `https:${inspection.decoded}`
        : inspection.decoded)
    } catch {
      return redactPath(value, true)
    }
    const protocol = parsed.protocol.toLowerCase()
    const publicProtocol = protocol === 'https:' || protocol === 'http:'
    const localHost = isLocalHostname(parsed.hostname)
    const payloadInspection = inspectPathSpelling(
      `${parsed.pathname}${parsed.search}${parsed.hash}`,
    )
    const queryInspection = inspectPathSpelling(`${parsed.search}${parsed.hash}`)
    const userAuthoredPublicUrl = userText.includes(normalizeGuardText(value))
    const unsafeHostPathParameter = (parameter: string): boolean => {
      const parameterInspection = inspectPathSpelling(parameter)
      return !parameterInspection.stable
        || startsWithConventionalHostRoot(parameterInspection.decoded)
        || /^(?:~|\$HOME|\$\{HOME\})(?:[\\/]|$)/i.test(parameterInspection.decoded)
        || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(parameterInspection.decoded)
        || pathCredential.test(parameterInspection.decoded)
    }
    const rawHash = parsed.hash.replace(/^#/, '')
    const hashUsesParameters = rawHash.includes('=') || rawHash.includes('&')
    const searchParts = [...parsed.searchParams.entries()].flat()
    const hashParts = hashUsesParameters
      ? [...new URLSearchParams(rawHash).entries()].flat()
      : []
    const modelOnlyHostPathParameter = !userAuthoredPublicUrl
      && (searchParts.some(unsafeHostPathParameter)
        || hashParts.some(unsafeHostPathParameter)
        || (!hashUsesParameters && resemblesConventionalHostPath(rawHash)))
    const modelOnlyHostPathname = !userAuthoredPublicUrl
      && resemblesConventionalHostPath(parsed.pathname)
    const localPathInPayload = pathCredential.test(payloadInspection.decoded)
      || /(?:^|[?&#=])(?:~|\$HOME|\$\{HOME\})(?:[\\/]|$)/i.test(payloadInspection.decoded)
      || /(?:^|[?&#=])(?:[A-Za-z]:[\\/]|\\\\)/.test(payloadInspection.decoded)
      || modelOnlyHostPathParameter || modelOnlyHostPathname
    const modelOnlyEncodedInternalIdentity = !userAuthoredPublicUrl
      && /%[0-9a-f]{2}/i.test(value)
      && containsDecodedInternalIdentity(inspection.decoded)
    const unsafe = !inspection.stable || !publicProtocol || localHost
      || parsed.username.length > 0 || parsed.password.length > 0
      || pathCredential.test(inspection.decoded)
      || containsCredentialMaterial(inspection.decoded)
      || !payloadInspection.stable || !queryInspection.stable || localPathInPayload
      || modelOnlyEncodedInternalIdentity
    if (unsafe) return redactPath(value, true)
    const index = protectedPublicUrls.push(value) - 1
    return `\uE000${urlPlaceholderNonce}_${index}\uE001`
  }
  sanitized = sanitized.replace(
    /[a-z][a-z0-9+.-]*:\/\/\[[0-9a-f:.%]+\](?::\d{1,5})?(?:[\/?#][^\s`'"<>。、！？!;,\)\]}]*)?/gim,
    value => protectPublicUrl(value),
  )
  sanitized = sanitized.replace(
    /[a-z][a-z0-9+.-]*:\/\/[^\s`'"<>。、！？!;,\)\]}]*/gim,
    value => protectPublicUrl(value),
  )
  sanitized = sanitized.replace(
    /[a-z][a-z0-9+.-]*:%[^\s`'"<>。、！？!;,\)\]}]*/gim,
    value => protectPublicUrl(value, true),
  )
  sanitized = sanitized.replace(
    /(^|[\s(\[])(\/\/(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d{1,5})?(?:\/[^\s`'"<>。、！？!;,\)\]}]*)?)/gim,
    (_value, prefix: string, url: string) => `${prefix}${protectPublicUrl(url)}`,
  )
  // Public URLs are placeholders at this point, so inspect every remaining
  // percent-mixed token as a single unit. This closes obfuscated product names
  // and runtime IDs without decoding or rewriting harmless public prose.
  sanitized = sanitized.replace(
    /[^\s`'"<>。、！？!?;,\(\)\[\]\{\}]*%[0-9a-f]{2}[^\s`'"<>。、！？!?;,\(\)\[\]\{\}]*/gim,
    value => {
      const inspection = inspectPathSpelling(value)
      if (!inspection.stable) return '（内部情報を省略）'
      if (userText.includes(normalizeGuardText(value))) return value
      return containsDecodedInternalIdentity(inspection.decoded)
        ? '（内部情報を省略）'
        : value
    },
  )
  sanitized = sanitized.replace(
    /(?<![A-Za-z0-9_.-])(?:\[[0-9a-f:.%]+\]|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?:(?:[:\u2236\uA789]\d{1,5})(?:[\/\u2044\u2215\u2571\u27CB\u29F8][^\s`'"<>。、！？!?;,\)\]}]*)?|[\/\u2044\u2215\u2571\u27CB\u29F8][^\s`'"<>。、！？!?;,\)\]}]+)(?![A-Za-z0-9_.-])/gim,
    value => {
      const inspection = inspectPathSpelling(value)
      let parsed: URL
      try {
        parsed = new URL(`http://${inspection.decoded}`)
      } catch {
        return value
      }
      const userAuthoredPublicUrl = userText.includes(normalizeGuardText(value))
      return !inspection.stable || isLocalHostname(parsed.hostname)
        || (!userAuthoredPublicUrl && resemblesConventionalHostPath(parsed.pathname))
        ? redactPath(value, true)
        : value
    },
  )
  // Mixed literal/percent-encoded HOME spellings must be decoded as one unit;
  // starting at the first percent sequence would otherwise omit the `$H` prefix.
  sanitized = sanitized.replace(
    /\$(?:[A-Za-z]*%[0-9a-f]{2}|%[0-9a-f]{2})[^\s`'"<>。、！？!?;,\)\]}]*/gim,
    value => {
      const inspection = inspectPathSpelling(value)
      return !inspection.stable || homePathPrefix.test(inspection.decoded)
        ? redactPath(value, true)
        : value
    },
  )
  // Inspect a percent-mixed URL/endpoint as one token, including the literal
  // host prefix. Starting at the first percent byte would miss private hosts
  // such as `10.0.%30.5` and leave a misleading prefix visible.
  sanitized = sanitized.replace(
    /(?<![A-Za-z0-9_.-])[A-Za-z0-9[\].:%-]*%[0-9a-f]{2}[A-Za-z0-9[\].:%/?#-]*/gim,
    value => {
      const inspection = inspectPathSpelling(value)
      return !inspection.stable || isLocalEndpointSpelling(inspection.decoded)
        ? redactPath(value, true)
        : value
    },
  )
  // Encoded absolute/home paths without a scheme must be classified as one
  // token. Inspect a bounded number of decoding layers and redact the original
  // spelling so no decoded suffix is exposed.
  sanitized = sanitized.replace(
    /(?:[A-Za-z]|\\{1,2})?%[0-9a-f]{2}[^\s`'"<>。、！？!?;,\)\]}]*/gim,
    value => {
      const inspection = inspectPathSpelling(value)
      return !inspection.stable || conventionalLocalRoot.test(inspection.decoded)
        || pathCredential.test(inspection.decoded)
        || homePathPrefix.test(inspection.decoded)
        || absolutePlatformPath.test(inspection.decoded)
        || driveRelativePlatformPath.test(inspection.decoded)
        || isLocalEndpointSpelling(inspection.decoded)
        || inspection.decoded.startsWith('/')
        ? redactPath(value, true)
        : value
    },
  )
  // Absolute and network-style paths use a deliberately fail-closed tail.
  // Spaces and non-ASCII components are indistinguishable from prose without
  // filesystem access, so redact to the next sentence delimiter instead of
  // exposing a partially matched suffix.
  sanitized = sanitized.replace(
    /(?<![A-Za-z0-9])\/{1,}[^\r\n`'"<>。、！？!?;,\)\]}]+/gm,
    value => redactPath(value, pathCredential.test(value)),
  )
  sanitized = sanitized.replace(
    /(?<![A-Za-z0-9])(?:\\\\\?\\UNC\\|\\\\\?\\)[^\r\n`'"<>。、！？!;,\)\]}]+/gm,
    value => redactPath(value, true),
  )
  sanitized = sanitized.replace(
    /(?<![A-Za-z0-9])(?:[A-Za-z][\u2236\uA789:](?=[^\r\n`'"<>。、！？!?;,\)\]}]+)|\\\\|[\u2216\u2572\u27CD\u29F5\u29F9]{2})[^\r\n`'"<>。、！？!?;,\)\]}]+/gm,
    value => redactPath(value, true),
  )
  sanitized = sanitized.replace(
    /(?<![A-Za-z0-9])[\u2044\u2215\u2571\u27CB\u29F8]{1,}[^\r\n`'"<>。、！？!?;,\)\]}]+/gm,
    value => redactPath(value, true),
  )
  sanitized = sanitized.replace(
    /(?<![A-Za-z0-9\\])(?:\\\/){1,}[^\r\n`'"<>。、！？!?;,\)\]}]+/gm,
    value => redactPath(value, pathCredential.test(value)),
  )
  sanitized = sanitized.replace(
    /\bw[A-Za-z0-9_-]+:[pt][A-Za-z0-9_-]+\b|\bterm_[A-Za-z0-9_-]+\b/g,
    value => userText.includes(value) ? value : '（内部IDを省略）',
  )
  sanitized = sanitized.replace(
    /(?<![A-Za-z0-9_])"?(?:pid|process[ _-]?id|state[ _-]?change[ _-]?seq|duration[ _-]?ms)"?(?:\s*[:=]\s*|\s+(?:is\s+)?)"?\d+"?(?![A-Za-z0-9_])/gi,
    value => userText.includes(value) ? value : '（内部情報を省略）',
  )
  protectedPublicUrls.forEach((url, index) => {
    sanitized = sanitized.replaceAll(`\uE000${urlPlaceholderNonce}_${index}\uE001`, url)
  })
  protectedMimeTypes.forEach((mimeType, index) => {
    sanitized = sanitized.replaceAll(`\uE006${mimePlaceholderNonce}_${index}\uE007`, mimeType)
  })

  // Credentials are never safe to echo into a shared Slack thread, even when
  // the sender pasted the same value in the request. Product-name exemptions
  // below must not turn user input into a credential allowlist.
  sanitized = redactCredentialMaterial(sanitized, '（認証情報を省略）')

  // Keep legitimate product comparisons when the user asked for them, but
  // drop clauses that describe Zeroちゃん's host/runtime wiring. A product
  // name appearing anywhere in the request must never globally authorize an
  // unrelated internal architecture disclosure in the response.
  const implementationName = INTERNAL_IMPLEMENTATION_NAME
  const internalSubject = /(?:Zeroちゃん|\bZero\b|ゼロ(?:ちゃん)?|当システム|本システム|このシステム|そのシステム|当サービス|本サービス|このサービス|このボット|当ボット|本ボット|この処理|その処理|当処理|本処理|内部では|裏側|中身|基盤として|技術スタック|使用技術|全(?:ての)?(?:回答|処理)|私の(?:回答|返答|処理|作業)|under\s+the\s+hood|behind\s+the\s+scenes|\b(?:requests?|responses?)\s+(?:are\s+)?handled\b|\b(?:every|each)\s+(?:request|response|question)\b|\ball\s+answers?\b|\b(?:the\s+)?answers?\s+in\s+this\s+Slack\s+thread\b|\bthis\s+Slack\s+thread\b|\bme\b|\bmy\s+(?:responses?|answers?|replies?|work)\b|(?:^|[\s、])(?:処理|回答|実行)(?:には|は|で)|私は|私たちは|こちら|\b(?:i|we|it)\b|\b(?:the|our|this|my|your)\s+(?:underlying\s+|reasoning\s+)?(?:system|service|application|agent|assistant|bot|implementation|model|engine|runtime|backend|worker|stack|architecture)\b|(?:^|[\s])(?:implementation|backend|runtime|model|engine|architecture|stack)\s*(?:is\b|uses?\b|[:=])|\bour\s+reasoning\s+engine\b)/i
  const internalRelationship = /(?:使用中|利用中|稼働中|で動いて|で動作|で構成|を使って(?:いる|います)|使(?:う|い|って|用し)|使用し|利用し|採用|動作し|稼働し|起動し|呼び出し|経由し|構成され|(?:は|=|:|：|（|\().{0,60}(?:です|である|だ|is\b|）|\))|(?:powered\s+by|runs?\s+(?:on|through)|(?:i|we)\s+use|i['’]?m\s+using|\buses?\b|\bused\b|based\s+on|built\s+(?:on|with)|composed\s+of|implemented\s+in|written\s+in|implementation\s+(?:uses?|is)|engine\s*(?:is|:)))/i
  const internalConfiguration = /(?:採用(?:エンジン|モデル|実装|構成)|(?:バックエンド|モデル|エンジン|実装|構成|ランタイム|基盤|中身|裏側))\s*(?:は|=|:|：)/i
  const externalTechnicalTarget = /(?:\b(?:repo(?:sitory)?|project|code(?:base)?|source|package\.json|readme|target\s+(?:app|application|service|system))\b|(?:この|その|対象|当該|現在の)?(?:リポジトリ|レポジトリ|プロジェクト|コード(?:ベース)?|ソースコード)|対象(?:アプリ|サービス|システム)|package\.json|README)/i
  const selfInquirySubject = /(?:Zeroちゃん|\bZero\b|ゼロ(?:ちゃん)?|当システム|本システム|このシステム|そのシステム|当サービス|本サービス|このサービス|このボット|当ボット|本ボット|あなた|君|お前|そちら|\b(?:you|your|yourself|this\s+(?:bot|assistant|agent|system|service))\b)/i
  const explicitResponseSelfIdentity = /(?:Zeroちゃん|\bZero\b|ゼロ(?:ちゃん)?|当システム|本システム|このシステム|そのシステム|当サービス|本サービス|このサービス|このボット|当ボット|本ボット|私は|私たちは|こちら|当方|ここ(?:で|では)|\b(?:i|we|me|my|our|us|here)\b|\b(?:this|our|my)\s+(?:bot|assistant|agent|system|service|application|app|backend|runtime|implementation)\b)/i
  const selfExecutionContext = /(?:\b(?:this|the\s+current)\s+(?:request|response|answer|reply)\b|\bthe\s+active\s+model\b|^\s*handled\s+by\b|\bhandled\s+(?:this|the\s+current)\s+request\b|\bran\s+through\b|\bgenerated\s+(?:this|the\s+current)\s+(?:answer|response)\b|(?:この|今回の)(?:依頼|回答|返答|応答|処理)|(?:担当|採用)(?:モデル|エンジン)|(?:が|で)(?:この)?(?:回答|返答|応答)を?生成|で回答(?:しました|した|しています))/i
  const subjectOmittedSelfQuestion = /(?:(?:何|なに)(?:で|の)?(?:動いて|動く|動作|モデル|エンジン|基盤|書かれて|できて|作られて)|(?:何|なに).{0,12}(?:使ってる|使う|製)|(?:どんな|どういう).{0,12}(?:技術|部品|構成要素|材料|仕組み|構成)(?:で動いてる|で動く|を使ってる|でできてる|なの|[?？])|どうやって.{0,16}(?:動いて|動く|動作|作られ|構築)|(?:仕組み|裏側|中身|部品|構成要素|土台|成り立ち|材料|依存関係)(?:は|を)?.{0,16}(?:[?？]|教えて|説明して)|使用(?:モデル|エンジン)|(?:what|which)\s+(?:model|engine|runtime|backend)\s*(?:are\s+you|do\s+you|is\s+it|does\s+it|[?？])|what\s+(?:do\s+you|does\s+it)\s+(?:run|use)|what\s+is\s+it\s+(?:made\s+of|written\s+in)|what\s+is\s+under\s+the\s+hood|how\s+was\s+it\s+built|what\s+dependencies\s+does\s+it\s+have|(?:what|how).{0,28}\byou\b.{0,28}(?:built|implemented|technology|using|use|powered)|what\s+powers?\s+you)/i
  const configurationInquiry = /(?:仕組み|構成|実装|アーキテクチャ|技術スタック|使用技術|裏側|中身|基盤|土台|部品|構成要素|成り立ち|材料|ライブラリ|ランタイム|バックエンド|モデル|エンジン|言語|フレームワーク|OS|設計|テクノロジー|技術|依存関係|依存|できて|作られて|作り|構築|runtime|backend|model|engine|stack|architecture|implementation|language|framework|librar|parts?|components?|building\s+blocks?|make\s*up|makeup|foundation|origin|operating\s+system|\bOS\b|design|technolog|dependenc|built|made|powering|tick)/i
  const questionIntent = /(?:[?？]|教えて|説明(?:して)?|開示|列挙|述べ|何|なに|どの|what|which|tell|show|explain|describe|list|reveal|disclose)/i
  const subjectOmittedImplementationRelation = /(?:で動いて(?:る|いる)?|で動く|を使って(?:る|いる)|を採用して(?:る|いる)|powered\s+by|runs?\s+on)\s*[?？]?/i
  const isSelfImplementationInquiry = (clause: string): boolean => {
    if (externalTechnicalTarget.test(clause) && !selfInquirySubject.test(clause)) return false
    return subjectOmittedSelfQuestion.test(clause)
      || (implementationName.test(clause)
        && subjectOmittedImplementationRelation.test(clause)
        && questionIntent.test(clause))
      || (selfInquirySubject.test(clause)
        && (implementationName.test(clause) || internalRelationship.test(clause)
          || internalConfiguration.test(clause)
          || (configurationInquiry.test(clause) && questionIntent.test(clause))))
  }
  const latestInputClauses = latestUserText.split(/\r?\n/)
    .flatMap(part => (part.match(/.*?(?:[。！？!?]|\.(?=\s|$)|$)/g) ?? [part])
      .map(clause => clause.trim()).filter(Boolean))
  const selfImplementationQuestion = latestInputClauses.some(isSelfImplementationInquiry)
  const externalTechnicalTask = !selfImplementationQuestion
    && latestInputClauses.some(clause => externalTechnicalTarget.test(clause))
  const canonicalImplementationName = (value: string): string => normalizeGuardText(value)
    .replace(/[\s_-]+/g, '')
    .toLowerCase()
  const userImplementationMatches = [
    ...latestUserText.matchAll(new RegExp(implementationName.source, 'gi')),
  ]
  const userImplementationNames = new Set(userImplementationMatches
    .map(match => canonicalImplementationName(match[0])))
  const userPublicProductPhrases = userImplementationMatches.map(match => {
    const end = (match.index ?? 0) + match[0].length
    const suffix = latestUserText.slice(end).match(
      /^(?:(?:-[A-Za-z0-9]+)|(?:[ \t]+[A-Za-z0-9][A-Za-z0-9._-]*)){0,4}/,
    )?.[0] ?? ''
    return `${match[0]}${suffix}`
      .replace(/\s+(?:and|versus|vs\.?|is|are|was|were|about|explain|describe|compare|difference|pricing|price|features?)\b.*$/i, '')
      .trim()
  }).filter(Boolean).sort((left, right) => right.length - left.length)
  const publicProductDiscussion = userImplementationNames.size > 0
    && /(?:説明|違い|比較|とは|について|機能|特徴|価格|料金|概要|何ができ|できること|使(?:う|い|って|用)|利用|設定|調査|実装|サンプル|例|書いて|explain|describe|overview|compare|difference|what\s+(?:is|are)|about|capabilit|features?|pricing|price|how\s+to|use|using|configure|configuration|investigate|implement|sample|example|write)/i.test(latestUserText)
  const userNamedProduct = (name: string): boolean => {
    const canonical = canonicalImplementationName(name)
    return userImplementationNames.has(canonical)
      || (canonical === 'jsonrpc' && userImplementationNames.has('mcp'))
      || (canonical === 'openaicodex' && userImplementationNames.has('codex'))
      || (canonical === 'codex' && userImplementationNames.has('openaicodex'))
      || (canonical === 'modelcontextprotocol' && userImplementationNames.has('mcp'))
      || (canonical === 'mcp' && userImplementationNames.has('modelcontextprotocol'))
  }
  const publicRelationship = /(?:\b(?:develops?|developed|creates?|created|makes?|made|maintains?|maintained|publishes?|published)\b|(?:開発|作成|提供|公開|保守)(?:する|した|している|される|された|元))/i
  const implementationExecutionDisclosure = (clause: string): boolean => {
    const name = `(?:${implementationName.source})`
    const englishWork = '(?:request|task|review|analysis|answer|response|reply|output|result|repository|project)'
    const englishVerb = '(?:handled|processed|generated|executed|analy[sz]ed|reviewed|inspected|examined|checked|ran|(?:is\\s+)?working\\s+on)'
    const japaneseWork = '(?:依頼|タスク|調査|回答|返答|応答|分析|レビュー|出力|結果|リポジトリ|プロジェクト)'
    const japaneseVerb = '(?:処理|生成|実行|担当|分析|解析|調査|確認|レビュー|作業)(?:しました|した|しています|する|済み)?'
    return new RegExp(`${name}.{0,80}${englishVerb}.{0,80}${englishWork}|${englishWork}.{0,80}${englishVerb}(?:\\s+by)?.{0,32}${name}|${name}.{0,80}${japaneseWork}.{0,80}${japaneseVerb}|${japaneseWork}.{0,80}${name}.{0,32}${japaneseVerb}`, 'i').test(clause)
  }
  const externalStaticTechnicalRelationship = (clause: string): boolean => {
    const plain = normalizeGuardText(clause)
      .trim()
      .replace(/^(?:(?:[-+*>]|\d+[.)])\s*)+/, '')
      .replace(/[*_`~]/g, '')
      .replace(/[。！？!?]|\.(?=\s*$)/g, '')
      .trim()
    if (!externalTechnicalTarget.test(plain) || !implementationName.test(plain)
      || explicitResponseSelfIdentity.test(plain) || selfExecutionContext.test(plain)) {
      return false
    }
    const names = [...plain.matchAll(new RegExp(implementationName.source, 'gi'))]
      .map(match => match[0])
    if (names.length === 0 || names.some(name => !isAllowedPublicProductName(name, plain))) {
      return false
    }
    let masked = plain.replace(
      new RegExp(`(?:(?:this|the|current|target)\\s+)?(?:${externalTechnicalTarget.source})`, 'gi'),
      'TARGET',
    )
    masked = masked.replace(new RegExp(implementationName.source, 'gi'), 'PRODUCT')
      .replace(/\s+/g, ' ')
      .trim()
    const englishRelation = '(?:uses?|configures?|depends on|imports?|requires?|pins?|integrates? with|supports?|is compatible with|contains?|declares?|references?|enables?)'
    const englishPassive = '(?:used|configured|imported|required|pinned|integrated|supported|declared|referenced|enabled)'
    const japaneseRelation = '(?:使(?:う|います|って(?:いる|います)?|われ(?:る|ています)?)|(?:使用|採用|設定|依存|連携|統合|対応|サポート|参照)(?:する|します|し|して(?:いる|います)?|され(?:る|ています)?)?|含(?:む|みます|んで(?:いる|います)?))'
    return new RegExp(`^TARGET ${englishRelation} PRODUCT(?:\\s*(?:,|and)\\s*(?:${englishRelation} )?PRODUCT)*$`, 'i').test(masked)
      || new RegExp(`^PRODUCT (?:is|are) ${englishPassive} (?:in|by|for) TARGET$`, 'i').test(masked)
      || new RegExp(`^TARGET(?:は|が|で|では|に|には)?PRODUCT(?:とPRODUCT)*(?:を|に|へ|が)?${japaneseRelation}$`).test(masked)
      || new RegExp(`^TARGETのPRODUCT(?:実装|設定|依存関係|対応|サポート)?を(?:確認|検証|調査)(?:しました|済みです|しています)$`).test(masked)
  }
  const isAllowedPublicProductName = (name: string, clause: string): boolean => {
    if (userNamedProduct(name)) return true
    if (canonicalImplementationName(name) !== 'openai'
      || !userImplementationNames.has('codex')) return false
    return /(?:\bOpenAI\s+(?:develops?|creates?|maintains?|publishes?)\s+(?:OpenAI[ -])?Codex\b|\b(?:OpenAI[ -])?Codex\b.{0,48}\b(?:developed|created|maintained|published)\s+by\s+OpenAI\b|\b(?:OpenAI[ -])?Codex\b.{0,48}\bis\s+an?\s+OpenAI\s+(?:coding\s+)?(?:agent|product|tool|model)\b)/i.test(clause)
  }
  const publicProductClause = (clause: string): boolean => {
    if (!publicProductDiscussion) return false
    if (implementationExecutionDisclosure(clause)) return false
    const plain = normalizeGuardText(clause)
      .trim()
      .replace(/^(?:(?:[-+*>]|\d+[.)])\s*)+/, '')
      .replace(/[*_`~]/g, '')
      .replace(/^(?:(?:一般に|一般論として|一般的には)[、,\s]+|(?:in\s+general|generally)[,\s]+)/i, '')
      .replace(/^the\s+/i, '')
    const implementationNamesInClause = [
      ...plain.matchAll(new RegExp(implementationName.source, 'gi')),
    ].map(match => match[0])
    if (implementationNamesInClause.some(name => !isAllowedPublicProductName(name, plain))) {
      return false
    }
    const plainFolded = plain.toLowerCase()
    const exactPublicPhrase = userPublicProductPhrases.find(phrase => {
      if (!plainFolded.startsWith(phrase.toLowerCase())) return false
      const remainder = plain.slice(phrase.length)
      return /^(?:\s|は|が|の|を|と|や|、|とは|という|について|[:,：]|$)/i.test(remainder)
    })
    const leading = new RegExp(implementationName.source, 'i').exec(plain)
    const requestedProductMatch = [...plain.matchAll(new RegExp(implementationName.source, 'gi'))]
      .find(match => userNamedProduct(match[0]))
    const containsRequestedProduct = requestedProductMatch !== undefined
    const leadingText = exactPublicPhrase
      ?? (leading && leading.index === 0 && userNamedProduct(leading[0]) ? leading[0] : null)
      ?? (leading && leading.index === 0 && containsRequestedProduct
        && publicRelationship.test(plain) ? leading[0] : null)
    if (!leadingText) return false
    const requestedProductIndex = plain.toLowerCase().indexOf(leadingText.toLowerCase())
    const unaliasedRemainder = requestedProductIndex === 0
      ? plain.slice(leadingText.length)
      : `${plain.slice(0, requestedProductIndex)} ${plain.slice(requestedProductIndex + leadingText.length)}`
    const remainder = unaliasedRemainder
      .replace(/^\s*\((?:MCP|Model[ -]Context[ -]Protocol)\)\s*/i, ' ')
    const selfDeictic = /(?:\b(?:my|me|our|us|here)\b|私|僕|俺|こちら|ここ|当方)/i
    const remainderWithoutProductAliases = remainder.replace(
      new RegExp(implementationName.source, 'gi'),
      '',
    )
    if (internalSubject.test(remainderWithoutProductAliases) || selfDeictic.test(plain)
      || selfExecutionContext.test(plain)) return false
    const selfDeploymentContext = /(?:\b(?:this|these|that|the\s+current|current)\s+(?:experience|environment|setup|deployment|system|service|application|app|assistant|bot|agent)\b|\b(?:power(?:ed|ing)?|behind|used\s+in|runs?\s+in)\s+(?:this|these|the\s+current|what\s+you\s+see)\b|(?:この|その|現在の|今の|利用中の|使用中の|稼働中の)(?:体験|環境|仕組み|システム|サービス|アプリ|ボット|アシスタント|エージェント|コード支援ツール|開発ツール|開発エージェント|ツール)|(?:この|その)(?:体験|環境|仕組み|システム|サービス|アプリ|ボット)を支える)/i
    if (selfDeploymentContext.test(plain)) return false
    if (selfImplementationQuestion
      && /(?:ここ|こちら|当方|現在|今|この環境|採用|使用中|利用中|使って|使用し|利用し|稼働|基盤|裏側|中身|powered\s+by|runs?\s+(?:on|through)|built\s+(?:on|with)|used\s+(?:here|by\s+us))/i.test(plain)) {
      return false
    }
    if (/^\s*(?:[-–—]?\s*(?:backed|powered)\b|inside\b|is\s+used\b)/i.test(remainder)) {
      return false
    }
    const selectedDeployment = /(?:\b(?:active|current|selected|chosen|in[- ]use)\s+(?:model|engine|tool|agent|assistant|backend|runtime)\b|\bis\s+(?:active|selected|chosen|in[- ]use)\b|(?:使用|担当|採用|選択|利用中|使用中)(?:モデル|エンジン|ツール|エージェント|アシスタント|バックエンド|ランタイム))/i
    if (selfImplementationQuestion && selectedDeployment.test(plain)) return false
    const publicDescriptor = /(?:製品|モデル|ツール|標準|規格|プロトコル|機能|特徴|価格|料金|役割|コード|開発|実装|ソフトウェア|エージェント|動作|仕組み|コマンド|API|ライブラリ|設定|サンプル|\b(?:product|model|tool|standard|protocol|feature|pricing|price|role|code|coding|software|developer|agent|assistant|implementation|capabilit(?:y|ies)?|public|open[- ]?weight|operation|command|api|library|configuration|sample|example)\b)/i
    const selfOutputContext = /(?:\b(?:responses?|replies?|answers?|messages?|outputs?|threads?|conversations?|channels?)\b|回答|返答|応答|メッセージ|出力|スレッド|会話|チャンネル)/i
    return (/^\s*(?:は|が|の|を|と|や|、|とは|という|について|向け(?:の)?|is\b|are\b|was\b|were\b|means?\b|refers?\b|provides?\b|supports?\b|helps?\b|can\b|does\b|has\b|offers?\b|uses?\b|and\b|vs\.?\b|versus\b|[:,：])/i.test(remainder)
        || publicRelationship.test(remainder))
      && (publicDescriptor.test(remainder) || publicRelationship.test(remainder))
      && !selfOutputContext.test(plain)
  }
  const internalTechnicalDisclosure = (clause: string): boolean => {
    if (!internalSubject.test(clause)) return false
    return internalRelationship.test(clause) || internalConfiguration.test(clause)
      || /(?:\b(?:backend|runtime|stack|architecture|implementation|model|engine)\b|(?:バックエンド|ランタイム|技術スタック|使用技術|構成|実装))\s*(?:[:=：]|\bis\b|\buses?\b|\bruns?\b)/i.test(clause)
  }
  const subjectOmittedInternalTechnicalDisclosure = (clause: string): boolean => {
    const value = normalizeGuardText(clause).trim()
    return /^(?:built\s+with|powered\s+by|runs?\s+on|implemented\s+in|written\s+in|using)\b/i.test(value)
      || /^(?:(?:[A-Za-z0-9_.+#-]+(?:\s*(?:と|、|,|and)\s*[A-Za-z0-9_.+#-]+)*)\s*(?:で動いて|で動作|を使って|を使用|で実装|で構成)|(?:基盤|バックエンド|ランタイム|実装|構成)\s*(?:は|[:=：]))/i.test(value)
  }
  const protectedProductNames: string[] = []
  const productPlaceholderNonce = randomUUID().replaceAll('-', '')
  const protectProductNames = (clause: string, protectAll = false): string => clause.replace(
    new RegExp(implementationName.source, 'gi'),
    value => {
      if (!protectAll && !isAllowedPublicProductName(value, clause)) return value
      const index = protectedProductNames.push(value) - 1
      return `\uE002${productPlaceholderNonce}:${index}\uE003`
    },
  )
  sanitized = sanitized.split(/(\r?\n)/).map(part => {
    if (/^\r?\n$/.test(part)) return part
    const clauses = (part.match(/.*?(?:[。！？!?]|\.(?=\s|$)|$)/g) ?? [part])
      .filter(clause => clause.length > 0)
    return clauses.map(clause => {
      if (containsConfusableInternalImplementationName(clause, userText)) return ''
      if (implementationExecutionDisclosure(clause)) return ''
      if (publicProductClause(clause)) return protectProductNames(clause)
      if (selfImplementationQuestion) return ''
      if (externalTechnicalTask && !explicitResponseSelfIdentity.test(clause)
        && !selfExecutionContext.test(clause)) {
        if (!implementationName.test(clause)) return clause
        if (externalStaticTechnicalRelationship(clause)) {
          return protectProductNames(clause)
        }
        return ''
      }
      if (implementationName.test(clause) || internalTechnicalDisclosure(clause)
        || subjectOmittedInternalTechnicalDisclosure(clause)) return ''
      return clause
    }).join('')
  }).join('')
  if (selfImplementationQuestion) {
    const nonDisclosure = SELF_IMPLEMENTATION_NON_DISCLOSURE
    const publicText = sanitized.split(/\r?\n/)
      .filter(line => line.trim() !== nonDisclosure)
      .join('\n')
      .trim()
    sanitized = publicText.length > 0
      ? `${publicText}\n${nonDisclosure}`
      : nonDisclosure
  }

  for (const pattern of [
    /\bOpenAI[ -]Codex\b/gi,
    /\bOpenAI(?:[ -]?API)?\b/gi,
    /\bCodex\b/gi,
    /\bClaude(?:[ -]Code)?\b/gi,
    /\bGrok\b/gi,
    /\bHerdr\b/gi,
    /\bApp[ -]Server\b/gi,
    /\bModel[ -]Context[ -]Protocol\b/gi,
    /\bMCP[ -]?broker\b/gi,
    /\bMCP\b/gi,
    /\badvisor[ -]?panels?\b/gi,
    /\badvisors?\b/gi,
    /\breviewers?\b/gi,
    /\bsub[ -]?agents?\b/gi,
    /\bbrokers?\b/gi,
    /\bJSON[ -]?RPC\b/gi,
    /\bSeatbelt\b/gi,
    /\bGPT(?:[- ]?(?:\d+(?:\.\d+)*(?:[A-Za-z][A-Za-z0-9]*)?(?:-[A-Za-z0-9]+)*|oss(?:-[A-Za-z0-9]+)*))?\b/gi,
    /\bo\d+(?:[-.][A-Za-z0-9]+)*\b/gi,
    /コーデックス/gi,
    /クロードコード/gi,
    /クロード/gi,
    /グロック/gi,
    /モデルコンテキストプロトコル/gi,
    /アドバイザー/g,
    /レビュアー/g,
    /サブエージェント/g,
    /ブローカー/g,
    /\bjob\b/gi,
    /\bworker\b/gi,
    /\bqueue\b/gi,
  ]) {
    const inputPattern = new RegExp(pattern.source, pattern.flags.replace('g', ''))
    const relatedPublicTerm = pattern.source.includes('JSON') && pattern.source.includes('RPC')
      && /(?:\bMCP\b|モデルコンテキストプロトコル)/i.test(latestUserText)
    const relatedOpenAICodex = pattern.source.includes('OpenAI')
      && /\bCodex\b/i.test(latestUserText) && /\bOpenAI[ -]Codex\b/i.test(sanitized)
    const relatedMcpLongName = pattern.source.includes('Model[ -]Context')
      && /\bMCP\b/i.test(latestUserText)
    if (!inputPattern.test(latestUserText) && !relatedPublicTerm
      && !relatedOpenAICodex && !relatedMcpLongName) {
      sanitized = sanitized.replace(pattern, '内部処理')
    }
  }
  protectedProductNames.forEach((name, index) => {
    sanitized = sanitized.replaceAll(`\uE002${productPlaceholderNonce}:${index}\uE003`, name)
  })
  const zeroMarker = /\[ZERO_/i.exec(sanitized)
  if (zeroMarker) sanitized = sanitized.slice(0, zeroMarker.index).trimEnd()
  sanitized = sanitized.replace(
    /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,
    value => userText.includes(value) ? value : '（内部IDを省略）',
  )
  sanitized = sanitized.replace(
    /\b[0-9a-f]{32,64}\b/gi,
    value => userText.includes(value) ? value : '（内部IDを省略）',
  )
  sanitized = sanitized.replace(
    /\b[UCBWD][A-Z0-9]{8,}\b/g,
    value => userText.includes(value) ? value : '（内部IDを省略）',
  )
  protectedGitCommits.forEach((commit, index) => {
    sanitized = sanitized.replaceAll(
      `\uE004${gitCommitPlaceholderNonce}_${index}\uE005`, commit,
    )
  })
  return sanitized.trim()
}

/**
 * Codex が書ける outbox から、runner だけが読める state 内へ内容をcopyする。
 * sourceはjob outboxの直下だけに限定し、O_NOFOLLOWで開いたfdから読むため、
 * 攻撃者が差し替えられるsymlinkをtraversalしない。destinationはjob/sourceごとに
 * 決定的なので、seal後・DB complete前にrunnerが落ちても同じ結果へ収束する。
 */
export function sealArtifactResult(job: JobRecord, result: string, dir = stateDir()): string {
  const output = extractArtifactPaths(result)
  if (output.files.length === 0) return output.text

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
            return metadata.isFile() && metadata.size > 0 && metadata.size <= MAX_ARTIFACT_BYTES
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
      if (metadata.size === 0) throw new Error(`artifact is empty: ${requested}`)
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
    const sealed = sealArtifactResult(job, execution.result, dir)
    const output = extractArtifactPaths(sealed)
    const sanitized = sanitizeExecutionTextForSlack(job, execution.sessionId, output.text, dir)
    const containsSelfNonDisclosure = sanitized.split(/\r?\n/)
      .some(line => line.trim() === SELF_IMPLEMENTATION_NON_DISCLOSURE)
    const marker = output.files.length > 0 && !containsSelfNonDisclosure
      ? `<zerokun_files>${JSON.stringify(output.files)}</zerokun_files>`
      : ''
    return {
      ...execution,
      result: normalizePersistedExecutionResult(
        job,
        execution.sessionId,
        marker ? `${sanitized}\n${marker}`.trim() : sanitized,
        dir,
      ),
    }
  } catch (error) {
    // Codex already exited successfully. A malformed/unsealable artifact
    // declaration is a delivery failure, not evidence that a write job itself
    // failed; marking it failed would invite duplicate external side effects.
    const text = sanitizeExecutionTextForSlack(
      job,
      execution.sessionId,
      extractArtifactPaths(execution.result).text,
      dir,
    )
    const message = error instanceof Error ? error.message : String(error)
    log(`artifact sealing failed for completed job ${job.id}: ${message}`)
    return {
      ...execution,
      result: normalizePersistedExecutionResult(
        job,
        execution.sessionId,
        `${text}\n\n⚠️ 成果物ファイルを安全に封印できなかったため、ファイル添付だけを省略しました。`
          + '\n詳細はこのMacの管理ログを確認してください。',
        dir,
      ),
    }
  }
}

export function prepareUiApprovalForParking(
  job: JobRecord,
  error: CodexUiApprovalRequiredError,
  dir: string,
): {
  sessionId: string
  inputRevision: number
  inputDigest: string
  repositoryDigest: string
  proposalText: string
  beforePath: string
  afterPath: string
} {
  const outbox = artifactDirForJob(dir, job.id)
  const images = reencodeUiApprovalImages({
    outbox,
    beforePath: error.approval.beforePath,
    afterPath: error.approval.afterPath,
  })
  const sealed = sealArtifactResult(
    job,
    `<zerokun_files>${JSON.stringify([images.beforePath, images.afterPath])}</zerokun_files>`,
    dir,
  )
  const paths = extractArtifactPaths(sealed).files
  if (paths.length !== 2 || paths[0] === paths[1]) {
    throw new Error('UI/UX approval images could not be sealed as an exact Before/After pair')
  }
  const proposalText = sanitizeExecutionTextForSlack(
    job,
    error.approval.sessionId,
    error.approval.text,
    dir,
    [
      error.approval.beforePath,
      error.approval.afterPath,
      images.beforePath,
      images.afterPath,
      ...paths,
    ],
  )
  if (!proposalText) throw new Error('UI/UX approval proposal is empty after sanitization')
  return {
    sessionId: error.approval.sessionId,
    inputRevision: error.approval.inputRevision,
    inputDigest: error.approval.inputDigest,
    repositoryDigest: error.approval.repositoryDigest,
    proposalText,
    beforePath: paths[0]!,
    afterPath: paths[1]!,
  }
}

function normalizePersistedExecutionResult(
  job: JobRecord,
  sessionId: string,
  result: string,
  dir: string,
): string {
  const output = extractArtifactPaths(result)
  const sanitized = sanitizeExecutionTextForSlack(job, sessionId, output.text, dir)
  const text = sanitized.length <= MAX_PERSISTED_RESULT_TEXT_CHARS
    ? sanitized
    : `${sanitized.slice(0, MAX_PERSISTED_RESULT_TEXT_CHARS)}\n\n…(長いため ${MAX_PERSISTED_RESULT_TEXT_CHARS} 字で打ち切りました)`
  const containsSelfNonDisclosure = sanitized.split(/\r?\n/)
    .some(line => line.trim() === SELF_IMPLEMENTATION_NON_DISCLOSURE)
  const marker = output.files.length > 0 && !containsSelfNonDisclosure
    ? `<zerokun_files>${JSON.stringify(output.files.slice(0, 10))}</zerokun_files>`
    : ''
  return marker ? `${text}\n${marker}`.trim() : text
}

export async function recoverExecutionCheckpointBeforeAdvisorCleanup(
  store: JobStore,
  dir: string,
  reconcileAdvisors: () => Promise<void>,
): Promise<{ journaled: number; completed: number }> {
  // A result journal is the process-exit checkpoint, but its SQLite stage must
  // exist before recovery may close a round-owned ephemeral advisor workspace.
  // Keep this order identical for daemon startup and explicit recovery.
  const journaled = recoverExecutionResultJournals(store, dir)
  await reconcileAdvisors()
  const completed = store.recoverStagedExecutions()
  return { journaled, completed }
}

export async function reconcileAdvisorsWithMonitorHealthBarrier(
  store: JobStore,
  reconcileMonitors: () => Promise<{ retainedJobIds: string[] }>,
  reconcileAdvisors: () => Promise<void>,
): Promise<void> {
  const verify = async (): Promise<void> => {
    const monitored = new Set((await reconcileMonitors()).retainedJobIds)
    for (const jobId of store.stagedExecutionJobIds()) {
      if (!monitored.has(jobId)) {
        throw new HerdrJobMonitorPendingError(
          `staged execution has no verified active Herdr monitor: ${jobId}`,
        )
      }
    }
  }
  // Do not close a round-owned advisor workspace after an already-lost
  // monitor. Re-verify after asynchronous cleanup and return directly to the
  // synchronous DB completion in the checkpoint helper above.
  await verify()
  await reconcileAdvisors()
  await verify()
}

export async function reconcileEphemeralAndRetiredAdvisorRounds(options: {
  stateDir: string
  runtime: ReturnType<typeof readPinnedHerdrRuntime>
  log?: (message: string) => void
}): Promise<void> {
  await reconcileEphemeralClaudeSessions({
    stateDir: options.stateDir,
    runtime: options.runtime,
    log: options.log,
    onReconciledRound: outcome => {
      const input = readAdvisorInputSnapshot(
        options.stateDir, outcome.jobId, outcome.inputRevision,
      )
      if (!input.digest.startsWith(outcome.inputDigestPrefix)) {
        throw new Error('reconciled Claude round input digest changed')
      }
      persistAdvisorClaudeCleanupOutcome(options.stateDir, {
        ...outcome,
        inputDigest: input.digest,
      })
    },
  })
  const result = finalizeRetiredAdvisorRounds(options.stateDir)
  if (result.finalized > 0) {
    options.log?.(`finalized ${result.finalized} interrupted advisor round(s)`)
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

/**
 * Lightweight internal-use guard: inspect the exact bytes that would be sent
 * for obvious credential spellings, while deliberately preserving arbitrary
 * binary formats. It does not unpack archives, decrypt content, or perform OCR.
 */
function artifactContainsObviousCredential(data: Buffer): boolean {
  for (let offset = 0; offset < data.byteLength; offset += ARTIFACT_CREDENTIAL_SCAN_CHUNK_BYTES) {
    const start = Math.max(0, offset - ARTIFACT_CREDENTIAL_SCAN_OVERLAP_BYTES)
    const end = Math.min(data.byteLength, offset + ARTIFACT_CREDENTIAL_SCAN_CHUNK_BYTES)
    const window = data.subarray(start, end)
    if (containsCredentialMaterial(window.toString('latin1'))
      || containsCredentialMaterial(window.toString('utf8'))) return true
  }
  return false
}

function slackVisibleArtifactFilename(job: JobRecord, filename: string, dir: string): string {
  const normalized = normalizePublicGuardText(filename)
  const internalValues = [
    job.id,
    job.sessionId,
    job.executorNonce,
    job.chatId,
    job.threadTs,
    job.messageId,
    job.userId,
  ].filter((value): value is string => typeof value === 'string' && value.length >= 4)
  const sanitized = sanitizeExecutionTextForSlack(
    job,
    job.sessionId ?? '',
    normalized,
    dir,
  )
  const unsafe = sanitized !== normalized
    || internalValues.some(value => normalized.includes(value.normalize('NFKC')))
    || containsInternalImplementationName(normalized)
    || /[\0\r\n/\\]/.test(normalized)
    || Buffer.byteLength(normalized) > 180
  if (!unsafe) return filename
  const extension = extname(normalized)
  const safeExtension = /^\.[A-Za-z0-9]{1,10}$/.test(extension)
    && !containsInternalImplementationName(extension)
    ? extension.toLowerCase()
    : ''
  return `result${safeExtension}`
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
    if (metadata.size === 0) throw new Error(`artifact is empty: ${file}`)
    if (metadata.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`artifact is larger than 50MB: ${file}`)
    }
    const encodedName = basename(candidate)
    const separator = encodedName.lastIndexOf('--')
    const filename = separator >= 0 ? encodedName.slice(separator + 2) : encodedName
    const data = readBoundedArtifact(descriptor, file)
    if (artifactContainsObviousCredential(data)) {
      throw new ArtifactPublicationBlockedError()
    }
    return {
      path: candidate,
      filename: slackVisibleArtifactFilename(job, filename, dir),
      data,
    }
  } finally {
    closeSync(descriptor)
  }
}

function slackClientMessageId(notificationId: string, chunk: number): string {
  const hex = createHash('sha256').update(`${notificationId}:${chunk}`).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}

function slackMessageOrdinal(value: string): bigint | null {
  const match = /^(\d{1,20})\.(\d{1,9})$/.exec(value)
  if (!match) return null
  try {
    return BigInt(match[1]!) * 1_000_000_000n
      + BigInt(match[2]!.padEnd(9, '0'))
  } catch {
    return null
  }
}

export function slackMessageIsAfter(candidate: string, boundary: string): boolean {
  const candidateOrdinal = slackMessageOrdinal(candidate)
  const boundaryOrdinal = slackMessageOrdinal(boundary)
  return candidateOrdinal !== null && boundaryOrdinal !== null
    && candidateOrdinal > boundaryOrdinal
}

export function slackRateLimitMessage(resumeAt: number): string {
  const time = new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(resumeAt))
  return `⏸ 使用量上限のため、一時停止しています。${time} に自動再開します。`
}

export function slackArtifactsAbandonedMessage(): string {
  return `成果物の添付状態を${MAX_ARTIFACT_DELIVERY_ATTEMPTS}回確認しましたが完了できなかったため、`
    + '添付を打ち切りました。必要なら再度依頼してください。'
    + '\n詳細はこのMacの管理ログを確認してください。'
}

export function slackArtifactPublicationBlockedMessage(): string {
  return '⚠️ 成果物に認証情報らしき文字列が含まれていたため、そのファイルだけ添付しませんでした。'
}

class ArtifactDeliverySuppressedError extends Error {
  constructor(readonly disposition: 'delivered' | 'abandoned') {
    super(`artifact delivery is already ${disposition}`)
    this.name = 'ArtifactDeliverySuppressedError'
  }
}

export interface SlackUploadDependencies {
  postMessage(input: {
    chatId: string
    threadTs: string
    text: string
    clientMessageId?: string
  }, signal?: AbortSignal): Promise<{ messageId: string } | void>
  inspectPostedMessage(input: {
    chatId: string
    threadTs: string
    clientMessageId: string
  }): Promise<string | null>
  requestUploadTarget(filename: string, length: number): Promise<{
    uploadUrl: string
    fileId: string
  }>
  uploadBytes(uploadUrl: URL, data: Buffer, beforeRequestWrite: () => void): Promise<void>
  completeUpload(input: {
    fileId: string
    filename: string
    chatId: string
    threadTs: string
  }): Promise<void>
  inspectUpload(input: {
    fileId: string
    chatId: string
    threadTs: string
  }): Promise<boolean>
  addReaction(input: {
    chatId: string
    messageId: string
    name: string
  }, signal?: AbortSignal): Promise<void>
}

export function slackFileIsSharedInThread(
  file: unknown,
  chatId: string,
  threadTs: string,
): boolean {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return false
  const shares = (file as Record<string, unknown>).shares
  if (!shares || typeof shares !== 'object' || Array.isArray(shares)) return false
  for (const visibility of Object.values(shares as Record<string, unknown>)) {
    if (!visibility || typeof visibility !== 'object' || Array.isArray(visibility)) continue
    const rows = (visibility as Record<string, unknown>)[chatId]
    if (!Array.isArray(rows)) continue
    if (rows.some(row => row && typeof row === 'object' && !Array.isArray(row)
      && (row as Record<string, unknown>).thread_ts === threadTs)) return true
  }
  return false
}

export class SlackNotifier implements JobNotifier {
  private readonly client: WebClient
  private readonly lifecycleSideEffects = new Set<Promise<unknown>>()
  private readonly startedSideEffects = new Set<Promise<unknown>>()
  private readonly uploadDependencies: SlackUploadDependencies

  constructor(
    private readonly token: string,
    private readonly log: (message: string) => void,
    private readonly store: JobStore,
    dependencies: Partial<SlackUploadDependencies> = {},
  ) {
    this.client = new WebClient(token, slackWebClientOptions())
    this.uploadDependencies = {
      postMessage: dependencies.postMessage ?? (async (input, signal) => {
        const result = await postDirectSlackApi('chat.postMessage', this.token, {
          channel: input.chatId,
          thread_ts: input.threadTs,
          text: input.text,
          ...(input.clientMessageId ? { client_msg_id: input.clientMessageId } : {}),
        }, signal)
        if (!result.ok) throw new Error(result.error ?? 'Slack chat.postMessage failed')
        if (typeof result.ts !== 'string' || slackMessageOrdinal(result.ts) === null) {
          throw new Error('Slack chat.postMessage omitted its message timestamp')
        }
        return { messageId: result.ts }
      }),
      inspectPostedMessage: dependencies.inspectPostedMessage ?? (async input => {
        let cursor: string | undefined
        for (let page = 0; page < 100; page += 1) {
          const response = await this.client.conversations.replies({
            channel: input.chatId,
            ts: input.threadTs,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          })
          if (response.ok !== true) throw new Error('Slack conversations.replies failed')
          for (const value of response.messages ?? []) {
            if (!value || typeof value !== 'object') continue
            const message = value as Record<string, unknown>
            if (message.client_msg_id !== input.clientMessageId) continue
            if (message.thread_ts !== input.threadTs
              || typeof message.ts !== 'string'
              || slackMessageOrdinal(message.ts) === null) {
              throw new Error('Slack approval prompt receipt has an invalid thread binding')
            }
            return message.ts
          }
          const next = response.response_metadata?.next_cursor?.trim()
          if (!next) return null
          cursor = next
        }
        throw new Error('Slack approval prompt reconciliation exceeded its page bound')
      }),
      requestUploadTarget: dependencies.requestUploadTarget ?? (async (filename, length) => {
        const response = await this.client.files.getUploadURLExternal({ filename, length })
        if (response.ok !== true
          || typeof response.upload_url !== 'string' || response.upload_url.length < 1
          || typeof response.file_id !== 'string' || response.file_id.length < 1) {
          throw new Error('Slack files.getUploadURLExternal omitted the upload target')
        }
        return { uploadUrl: response.upload_url, fileId: response.file_id }
      }),
      uploadBytes: dependencies.uploadBytes ?? (async (uploadUrl, data, beforeRequestWrite) => {
        await withSlackDeadline(
          signal => postDirectSlackUpload(uploadUrl, data, beforeRequestWrite, signal),
          undefined,
          'Slack external file upload',
        )
      }),
      completeUpload: dependencies.completeUpload ?? (async input => {
        const response = await this.client.files.completeUploadExternal({
          files: [{ id: input.fileId, title: input.filename }],
          channel_id: input.chatId,
          thread_ts: input.threadTs,
        })
        if (response.ok !== true) throw new Error('Slack files.completeUploadExternal failed')
      }),
      inspectUpload: dependencies.inspectUpload ?? (async input => {
        const response = await this.client.files.info({ file: input.fileId })
        if (response.ok !== true) throw new Error('Slack files.info failed')
        return slackFileIsSharedInThread(response.file, input.chatId, input.threadTs)
      }),
      addReaction: dependencies.addReaction ?? (async (input, signal) => {
        const result = await postDirectSlackApi('reactions.add', this.token, {
          channel: input.chatId,
          timestamp: input.messageId,
          name: input.name,
        }, signal)
        if (!result.ok && result.error !== 'already_reacted') {
          throw new Error(result.error ?? 'Slack reactions.add failed')
        }
      }),
    }
  }

  private completeStartedSideEffect<T>(
    operation: () => Promise<T>,
    label: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const pending = completeSlackSideEffect(operation, label, signal)
    this.startedSideEffects.add(pending)
    void pending.then(
      () => { this.startedSideEffects.delete(pending) },
      () => { this.startedSideEffects.delete(pending) },
    )
    return pending
  }

  async settleStartedSideEffects(): Promise<void> {
    while (this.startedSideEffects.size > 0) {
      await Promise.allSettled([...this.startedSideEffects])
    }
  }

  private trackLifecycleSideEffect<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation()
    this.lifecycleSideEffects.add(pending)
    void pending.then(
      () => { this.lifecycleSideEffects.delete(pending) },
      () => { this.lifecycleSideEffects.delete(pending) },
    )
    return pending
  }

  async settleLifecycleSideEffects(): Promise<void> {
    while (this.lifecycleSideEffects.size > 0) {
      await Promise.allSettled([...this.lifecycleSideEffects])
    }
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
      await withSlackDeadline(signal => this.uploadDependencies.postMessage({
        chatId: job.chatId,
        threadTs: job.threadTs,
        text: chunk,
        ...(notificationId
          ? { clientMessageId: slackClientMessageId(notificationId, index) }
          : {}),
      }, signal), undefined, 'Slack chat.postMessage', parentSignal)
    }
  }

  async started(
    job: JobRecord,
    notificationId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.trackLifecycleSideEffect(
      () => this.post(
        job,
        '確認します 👀',
        notificationId,
        signal,
      ),
    )
  }

  async progress(
    job: JobRecord,
    text: string,
    notificationId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const safeText = sanitizeExecutionTextForSlack(
      job,
      job.sessionId ?? '',
      text,
      dirname(this.store.dbPath),
    )
    const slackText = safeText.startsWith('💬 ')
      ? safeText.slice('💬 '.length)
      : safeText
    await this.trackLifecycleSideEffect(
      () => this.post(
        job,
        slackText || '少し時間がかかっていますが、まだ作業を続けています 🔍',
        notificationId,
        signal,
      ),
    )
  }

  async status(notification: StatusNotification, signal?: AbortSignal): Promise<void> {
    let payload = notification.payload
    if (notification.kind === 'interjection-answer' && notification.jobId) {
      const job = this.store.get(notification.jobId)
      const interjection = (notification as Partial<InterjectionNotification>).interjection
      if (!job || !interjection) {
        throw new Error('interjection notification lost its durable job binding')
      }
      payload = sanitizeExecutionTextForSlack(
        job,
        job.sessionId ?? '',
        payload,
        dirname(this.store.dbPath),
        [
          ...interjection.attachments,
          interjection.messageId,
          interjection.userId,
          interjection.id,
          interjection.idempotencyKey,
        ],
      ) || '確認した内容を元の作業へ反映して続けます。'
    }
    const chunks = splitSlackChunks(payload)
    for (let index = 0; index < chunks.length; index += 1) {
      await withSlackDeadline(childSignal => this.uploadDependencies.postMessage({
        chatId: notification.chatId,
        threadTs: notification.threadTs,
        text: chunks[index]!,
        clientMessageId: slackClientMessageId(notification.id, index),
      }, childSignal), undefined, 'Slack status chat.postMessage', signal)
    }
  }

  private async deliverSealedArtifact(
    job: JobRecord,
    requested: string,
    filename: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const deliveryState = this.store.artifactDeliveryState(job.id, requested)
    if (deliveryState === 'delivered') return
    if (deliveryState === 'abandoned') {
      throw new Error(`required Slack attachment was abandoned: ${filename}`)
    }
    if (deliveryState === 'ambiguous') {
      const fileId = this.store.artifactRemoteFileId(job.id, requested)
      if (fileId && await this.uploadDependencies.inspectUpload({
        fileId,
        chatId: job.chatId,
        threadTs: job.threadTs,
      })) {
        this.store.markArtifactDelivered(job.id, requested)
        return
      }
      throw new ArtifactDeliveryAmbiguousError([requested])
    }
    const file = readUploadableArtifact(job, requested, dirname(this.store.dbPath))
    await this.completeStartedSideEffect(async () => {
      const target = await this.uploadDependencies.requestUploadTarget(
        filename,
        file.data.byteLength,
      )
      const uploadUrl = requireSlackUploadUrl(target.uploadUrl)
      if (!target.fileId) throw new Error('Slack upload target omitted file id')
      if (signal?.aborted) throw new Error('Slack attachment upload aborted before byte transfer')
      let transferCommitted = false
      try {
        await this.uploadDependencies.uploadBytes(uploadUrl, file.data, () => {
          const delivery = this.store.beginArtifactDelivery(job.id, requested, target.fileId)
          if (delivery === 'delivered' || delivery === 'abandoned') {
            throw new ArtifactDeliverySuppressedError(delivery)
          }
          if (delivery === 'ambiguous') {
            throw new ArtifactDeliveryAmbiguousError([requested])
          }
          transferCommitted = true
        })
        if (!transferCommitted) {
          throw new Error('Slack upload transport skipped the durable transfer boundary')
        }
        await this.uploadDependencies.completeUpload({
          fileId: target.fileId,
          filename,
          chatId: job.chatId,
          threadTs: job.threadTs,
        })
        this.store.markArtifactDelivered(job.id, requested)
      } catch (error) {
        if (error instanceof ArtifactDeliverySuppressedError) return
        if (error instanceof ArtifactDeliveryAmbiguousError) throw error
        if (!transferCommitted) throw error
        throw new ArtifactDeliveryAmbiguousError([requested], error)
      }
    }, `Slack ${filename} delivery`, signal)
  }

  async uiApproval(notification: UiApprovalNotification, signal?: AbortSignal): Promise<void> {
    const { job, request } = notification
    if (!this.store.uiApprovalNotificationDeliverable(notification.id)) return
    await this.deliverSealedArtifact(job, request.beforePath, 'Before.png', signal)
    if (signal?.aborted) return
    if (!this.store.uiApprovalNotificationDeliverable(notification.id)) return
    await this.deliverSealedArtifact(job, request.afterPath, 'After.png', signal)
    if (signal?.aborted) return
    if (!this.store.uiApprovalNotificationDeliverable(notification.id)) return
    const safeText = sanitizeExecutionTextForSlack(
      job,
      request.sessionId,
      request.proposalText,
      dirname(this.store.dbPath),
      [request.beforePath, request.afterPath, request.id],
    )
    if (!safeText) throw new Error('UI/UX approval proposal became empty after sanitization')
    const promptText = `${safeText}\n\nこの方向で実装してよいですか？`
    if (promptText.length > SLACK_CHUNK_CHARS) {
      throw new Error('UI/UX approval proposal exceeds one durable Slack message')
    }
    const delivery = this.store.beginUiApprovalPromptDelivery(notification.id)
    let messageId = delivery.messageId
    if (messageId === null) {
      messageId = await withSlackDeadline(
        () => this.uploadDependencies.inspectPostedMessage({
          chatId: job.chatId,
          threadTs: job.threadTs,
          clientMessageId: delivery.clientMessageId,
        }),
        undefined,
        'Slack approval prompt reconciliation',
        signal,
      )
    }
    if (messageId === null) {
      const posted = await withSlackDeadline(childSignal => (
        this.uploadDependencies.postMessage({
          chatId: job.chatId,
          threadTs: job.threadTs,
          text: promptText,
          clientMessageId: delivery.clientMessageId,
        }, childSignal)
      ), undefined, 'Slack UI approval chat.postMessage', signal)
      if (!posted?.messageId) {
        throw new Error('Slack UI approval post omitted its durable message receipt')
      }
      messageId = posted.messageId
    }
    this.store.recordUiApprovalPromptDelivered(notification.id, messageId)
  }

  async completed(
    job: JobRecord,
    result: string,
    notificationId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const output = extractArtifactPaths(result)
    const safeText = sanitizeExecutionTextForSlack(
      job,
      job.sessionId ?? '',
      output.text,
      dirname(this.store.dbPath),
    )
    if (!notificationId || !this.store.terminalNotificationBodyDelivered(notificationId)) {
      await this.post(job, safeText || 'できました ✅', notificationId, signal)
      if (signal?.aborted) return
      if (notificationId) this.store.markTerminalNotificationBodyDelivered(notificationId)
    }
    const ambiguousPaths: string[] = []
    let ambiguityCause: unknown
    for (const requested of output.files) {
      const deliveryState = this.store.artifactDeliveryState(job.id, requested)
      if (deliveryState === 'delivered' || deliveryState === 'abandoned') continue
      if (deliveryState === 'ambiguous') {
        const fileId = this.store.artifactRemoteFileId(job.id, requested)
        if (fileId) {
          try {
            if (await this.uploadDependencies.inspectUpload({
              fileId,
              chatId: job.chatId,
              threadTs: job.threadTs,
            })) {
              this.store.markArtifactDelivered(job.id, requested)
              continue
            }
          } catch (error) {
            ambiguityCause ??= error
          }
        }
        ambiguousPaths.push(requested)
        continue
      }
      let file: ReturnType<typeof readUploadableArtifact>
      try {
        file = readUploadableArtifact(job, requested, dirname(this.store.dbPath))
      } catch (error) {
        if (!(error instanceof ArtifactPublicationBlockedError)) throw error
        this.store.blockArtifactByPublicationPolicy(job.id, requested)
        continue
      }
      try {
        await this.completeStartedSideEffect(async () => {
          // Requesting an upload URL cannot publish bytes. Keep the durable
          // delivery intent clear through this phase so explicit API rejection
          // and pre-transfer shutdown remain safely retryable.
          const target = await this.uploadDependencies.requestUploadTarget(
            file.filename,
            file.data.byteLength,
          )
          const uploadUrl = requireSlackUploadUrl(target.uploadUrl)
          if (!target.fileId) throw new Error('Slack upload target omitted file id')
          if (signal?.aborted) throw new Error('Slack artifact upload aborted before byte transfer')
          let transferCommitted = false
          try {
            // The transport invokes this synchronous callback after creating
            // the ClientRequest but immediately before request.end(data). Once
            // the durable checkpoint commits, no shutdown or error may replay
            // the possible byte transfer for this exact Slack file ID.
            await this.uploadDependencies.uploadBytes(uploadUrl, file.data, () => {
              const delivery = this.store.beginArtifactDelivery(job.id, requested, target.fileId)
              if (delivery === 'delivered' || delivery === 'abandoned') {
                throw new ArtifactDeliverySuppressedError(delivery)
              }
              if (delivery === 'ambiguous') {
                throw new ArtifactDeliveryAmbiguousError([requested])
              }
              transferCommitted = true
            })
            if (!transferCommitted) {
              throw new Error('Slack upload transport skipped the durable transfer boundary')
            }
            await this.uploadDependencies.completeUpload({
              fileId: target.fileId,
              filename: file.filename,
              chatId: job.chatId,
              threadTs: job.threadTs,
            })
            this.store.markArtifactDelivered(job.id, requested)
          } catch (error) {
            if (error instanceof ArtifactDeliverySuppressedError) return
            if (error instanceof ArtifactDeliveryAmbiguousError) throw error
            if (!transferCommitted) throw error
            throw new ArtifactDeliveryAmbiguousError([requested], error)
          }
        }, 'Slack artifact delivery', signal)
      } catch (error) {
        if (!(error instanceof ArtifactDeliveryAmbiguousError)) throw error
        ambiguousPaths.push(...error.artifactPaths)
        ambiguityCause ??= error.cause
      }
      if (signal?.aborted) return
    }
    if (this.store.publicationBlockedArtifactCount(job.id) > 0) {
      await this.post(
        job,
        slackArtifactPublicationBlockedMessage(),
        notificationId ? `${notificationId}:artifact-policy` : undefined,
        signal,
      )
      if (signal?.aborted) return
    }
    if (ambiguousPaths.length > 0) {
      throw new ArtifactDeliveryAmbiguousError(ambiguousPaths, ambiguityCause)
    }
  }

  async completionReaction(
    job: JobRecord,
    notificationId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!notificationId || !this.store.terminalNotificationReactionDelivered(notificationId)) {
      await this.completeStartedSideEffect(
        () => this.uploadDependencies.addReaction({
          chatId: job.chatId,
          messageId: job.messageId,
          name: 'white_check_mark',
        }, signal),
        'Slack completion reaction',
        signal,
      )
      if (signal?.aborted) return
      if (notificationId) this.store.markTerminalNotificationReactionDelivered(notificationId)
    }
  }

  async failed(job: JobRecord, error: string, notificationId?: string, signal?: AbortSignal): Promise<void> {
    const cancelled = job.terminalOutcome === 'cancelled'
    this.log(`job ${job.id} ${cancelled ? 'cancelled' : 'failed'}: ${error}`)
    if (!notificationId || !this.store.terminalNotificationBodyDelivered(notificationId)) {
      await this.post(
        job,
        cancelled
          ? '🛑 中止しました。すでに完了した変更は自動では戻していません。'
          : '🙇 うまく完了できませんでした。'
            + `\n原因: ${publicJobFailureSummary(error)}`
            + `\nキュー #${job.seq} の監視タブが残っている場合は、そこで直前の経過を確認できます。`,
        notificationId,
        signal,
      )
      if (signal?.aborted) return
      if (notificationId) this.store.markTerminalNotificationBodyDelivered(notificationId)
    }
  }

  async artifactsAbandoned(
    job: JobRecord,
    error: string,
    notificationId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.log(`job ${job.id} artifact delivery abandoned: ${error}`)
    await this.post(
      job,
      slackArtifactsAbandonedMessage(),
      notificationId ? `${notificationId}:artifacts-abandoned` : undefined,
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

function acquireDaemonLock(
  lockDir: string,
  stateRoot: string,
  appId?: string,
): ProcessLockLease | undefined {
  const pidFile = join(lockDir, 'pid')
  const versionFile = join(lockDir, 'runtime')
  ensureManagedDirectory(stateRoot, lockDir)
  const attempt = tryAcquireProcessLock(pidFile)
  if (!attempt.acquired) return undefined
  const runtime = appId ? `${JOB_RUNNER_HANDSHAKE}:${appId}` : JOB_RUNNER_HANDSHAKE
  atomicWritePrivateFile(versionFile, `${runtime}\n`)
  return attempt.lease
}

function releaseDaemonLock(lockDir: string, lease: ProcessLockLease): void {
  const lockFile = join(lockDir, 'pid')
  if (!releaseProcessLock(lockFile, lease)) {
    throw new Error(`failed to release job runner lock: ${lockFile}`)
  }
}

export function updateIsRunning(lockDir: string): boolean {
  const inspection = inspectProcessLock(
    join(lockDir, 'pid'),
    /(?:update\.ts|zerokun-update|setup\.sh)(?:\s|$)/,
  )
  return inspection.status !== 'missing' && inspection.status !== 'stale'
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

export type FallbackProcessState = 'alive' | 'dead' | 'unknown'

export function classifyFallbackProcessState(
  signalProbe: 'present' | 'missing' | 'unknown',
  psExitCode: number,
  psState: string,
): FallbackProcessState {
  if (signalProbe === 'missing') return 'dead'
  if (signalProbe === 'unknown') return 'unknown'
  const value = psState.trim().toUpperCase()
  if (psExitCode !== 0 || value.length === 0) return 'unknown'
  return value.startsWith('Z') ? 'dead' : 'alive'
}

function fallbackProcessState(pid: number): FallbackProcessState {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'
  }
  try {
    const state = Bun.spawnSync(
      ['/bin/ps', '-o', 'state=', '-p', String(pid)],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    return classifyFallbackProcessState(
      'present', state.exitCode, new TextDecoder().decode(state.stdout),
    )
  } catch {
    return 'unknown'
  }
}

export function classifyExecutorCommandProbe(
  exitCode: number,
  command: string,
): { status: 'known'; command: string } | { status: 'unknown' } {
  const value = command.trim()
  return exitCode === 0 && value.length > 0
    ? { status: 'known', command: value }
    : { status: 'unknown' }
}

function trackedExecutorCommand(
  pid: number,
): { status: 'known'; command: string } | { status: 'unknown' } {
  const result = Bun.spawnSync(
    ['/bin/ps', '-ww', '-o', 'command=', '-p', String(pid)],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  return classifyExecutorCommandProbe(
    result.exitCode,
    result.stdout ? new TextDecoder().decode(result.stdout) : '',
  )
}

function legacyExecutorIdentity(pid: number): { started: string; pgid: number } | undefined {
  const result = Bun.spawnSync(
    ['/bin/ps', '-o', 'state=', '-o', 'pgid=', '-o', 'lstart=', '-p', String(pid)],
    {
      stdout: 'pipe', stderr: 'ignore',
      // The previous release wrote `ps lstart` in the machine's ambient
      // timezone. Keep that exact compatibility rule during the one-time
      // legacy reconciliation; forcing UTC makes every non-UTC record stale.
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
    },
  )
  if (result.exitCode !== 0) return undefined
  const match = /^\s*(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(result.stdout.toString())
  if (!match || match[1]!.toUpperCase().startsWith('Z')) return undefined
  const pgid = Number(match[2])
  return Number.isSafeInteger(pgid) && pgid > 0
    ? { pgid, started: match[3]! }
    : undefined
}

function signalTrackedExecutor(identity: ProcessIdentity, signal: NodeJS.Signals): void {
  if (!processIdentityIsLive(identity)) return
  if (identity.pgid === identity.pid
    && signalProcessGroupIfLeaderLive(identity, signal)) return
  signalProcessIfLive(identity, signal)
}

function registeredProcessGroupState(groupId: number): FallbackProcessState {
  if (process.platform === 'win32' || !Number.isSafeInteger(groupId) || groupId <= 1) {
    return 'unknown'
  }
  try {
    process.kill(-groupId, 0)
    return 'alive'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'
  }
}

function serializeBoundedExecutorRegistration(value: unknown): string {
  const serialized = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(serialized) > MAX_EXECUTOR_REGISTRATION_BYTES) {
    throw new Error(
      `executor registration exceeded ${MAX_EXECUTOR_REGISTRATION_BYTES} bytes`,
    )
  }
  return serialized
}

export function synchronizeExecutorRecoveryLedger(
  ledger: Map<string, { pid: number; started: string }>,
  items: readonly { pid: number; started: string }[],
  mode: 'replace' | 'merge',
): void {
  if (mode === 'replace') ledger.clear()
  for (const item of items) ledger.set(`${item.pid}:${item.started}`, item)
  if (ledger.size > MAX_TRACKED_PROCESSES) {
    throw new Error(`executor tracked generation ledger exceeded ${MAX_TRACKED_PROCESSES}`)
  }
}

function readBoundedExecutorRegistration(path: string): string {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const before = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || before.uid === process.getuid()
    if (!before.isFile() || before.nlink !== 1 || !ownerMatches
      || before.size > MAX_EXECUTOR_REGISTRATION_BYTES) {
      throw new Error(`unsafe executor registration: ${path}`)
    }
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) throw new Error(`executor registration changed while reading: ${path}`)
      offset += count
    }
    const extra = Buffer.alloc(1)
    if (readSync(descriptor, extra, 0, 1, before.size) !== 0) {
      throw new Error(`executor registration exceeded its bounded read: ${path}`)
    }
    const after = fstatSync(descriptor)
    if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode
      || after.uid !== before.uid || after.gid !== before.gid || after.nlink !== before.nlink
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`executor registration changed while reading: ${path}`)
    }
    try {
      assertDescriptorStillNamesPath(descriptor, path)
    } catch {
      throw new Error(`executor registration path changed while reading: ${path}`)
    }
    return bytes.toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

export interface ExecutorRecoveryTestHooks {
  /** Deterministically exercise a supervisor write between the first read and freeze. */
  afterInitialRegistrationRead?(registrationPath: string): void
}

export async function terminateTrackedExecutors(
  store: JobStore,
  log: (message: string) => void,
  timeoutMs = 15_000,
  stateDirectory = stateDir(),
  testHooks: ExecutorRecoveryTestHooks = {},
): Promise<void> {
  const registrations = new Map<number, {
    jobId: string
    path?: string
    pgid?: number
    started?: string
    bootSession?: string
    startSec?: number
    startUsec?: number
    version?: number
    phase?: 'active' | 'recovery' | 'cleanup-confirmed'
    revision?: number
    tracked?: Array<{ pid: number; started: string }>
    fingerprint?: SeatbeltFingerprint
  }>()
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
      const value = JSON.parse(readBoundedExecutorRegistration(path)) as {
        jobId?: string
        pid?: number
        pgid?: number
        started?: string
        bootSession?: string
        startSec?: number
        startUsec?: number
        version?: number
        tracked?: unknown
        fingerprint?: unknown
      }
      if (typeof value.jobId !== 'string' || !Number.isInteger(value.pid) || Number(value.pid) <= 0) {
        throw new Error(`invalid executor registration: ${path}`)
      }
      if (value.started !== undefined && (typeof value.started !== 'string' || !value.started)) {
        throw new Error(`invalid executor registration identity: ${path}`)
      }
      const preciseCount = [value.bootSession, value.startSec, value.startUsec]
        .filter(item => item !== undefined).length
      if (preciseCount !== 0 && (preciseCount !== 3
        || typeof value.bootSession !== 'string'
        || !Number.isSafeInteger(value.startSec) || Number(value.startSec) <= 0
        || !Number.isSafeInteger(value.startUsec) || Number(value.startUsec) < 0
        || Number(value.startUsec) > 999_999)) {
        throw new Error(`invalid executor registration generation: ${path}`)
      }
      if (preciseCount === 3 && (!Number.isSafeInteger(value.pgid)
        || Number(value.pgid) !== Number(value.pid))) {
        throw new Error(`invalid executor process group: ${path}`)
      }
      let tracked: Array<{ pid: number; started: string }> | undefined
      let fingerprint: SeatbeltFingerprint | undefined
      if (value.version === 3 || value.version === 4) {
        if (!Array.isArray(value.tracked) || value.tracked.length < 1
          || value.tracked.length > MAX_TRACKED_PROCESSES) {
          throw new Error(`invalid executor tracked generations: ${path}`)
        }
        if (!['active', 'recovery', 'cleanup-confirmed'].includes(String(
          (value as { phase?: unknown }).phase,
        )) || !Number.isSafeInteger((value as { revision?: unknown }).revision)
          || Number((value as { revision?: unknown }).revision) < 0) {
          throw new Error(`invalid executor recovery phase: ${path}`)
        }
        tracked = []
        const trackedKeys = new Set<string>()
        for (const item of value.tracked) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`invalid executor tracked generation: ${path}`)
          }
          const record = item as Record<string, unknown>
          if (Object.keys(record).sort().join('\n') !== 'pid\nstarted'
            || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
            || typeof record.started !== 'string' || !parseProcessStartKey(record.started)) {
            throw new Error(`invalid executor tracked generation: ${path}`)
          }
          const key = `${Number(record.pid)}:${record.started}`
          if (trackedKeys.has(key)) throw new Error(`duplicate executor tracked generation: ${path}`)
          trackedKeys.add(key)
          tracked.push({ pid: Number(record.pid), started: record.started })
        }
        if (!tracked.some(item => item.pid === Number(value.pid) && item.started === value.started)) {
          throw new Error(`executor supervisor is absent from tracked generations: ${path}`)
        }
        if (value.version === 4) {
          if (!value.fingerprint || typeof value.fingerprint !== 'object'
            || Array.isArray(value.fingerprint)) {
            throw new Error(`executor Seatbelt fingerprint is missing: ${path}`)
          }
          fingerprint = value.fingerprint as SeatbeltFingerprint
          verifySeatbeltFingerprint(stateDirectory, fingerprint)
        }
      } else if (value.version !== undefined && value.version !== 2) {
        throw new Error(`unsupported executor registration version: ${path}`)
      }
      registrations.set(Number(value.pid), {
        jobId: value.jobId,
        path,
        ...(value.pgid !== undefined ? { pgid: Number(value.pgid) } : {}),
        started: value.started,
        ...(preciseCount === 3 ? {
          bootSession: value.bootSession,
          startSec: value.startSec,
          startUsec: value.startUsec,
        } : {}),
        ...(tracked ? { tracked } : {}),
        ...(value.version === 3 || value.version === 4 ? {
          version: value.version,
          phase: (value as { phase: 'active' | 'recovery' | 'cleanup-confirmed' }).phase,
          revision: Number((value as { revision: number }).revision),
        } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const reapDurablyTrackedDescendants = async (
    pid: number,
    registration: (typeof registrations extends Map<number, infer T> ? T : never),
  ): Promise<void> => {
    if (![3, 4].includes(registration.version ?? 0) || !registration.path || !registration.started
      || !registration.bootSession || registration.startSec === undefined
      || registration.startUsec === undefined || !registration.tracked) {
      if (registration.pgid === pid) {
        const group = registeredProcessGroupState(pid)
        if (group !== 'dead') {
          throw new Error(`legacy executor group ${pid}の終了を確認できません: ${group}`)
        }
      }
      return
    }
    const ledger = new Map<string, { pid: number; started: string }>()
    const mergeLedger = (items: Array<{ pid: number; started: string }>): void => {
      synchronizeExecutorRecoveryLedger(ledger, items, 'merge')
    }
    synchronizeExecutorRecoveryLedger(ledger, registration.tracked, 'replace')
    let phase = registration.phase ?? 'active'
    let revision = registration.revision ?? 0
    let recoveryWriterFrozen = false
    const readLatest = (): void => {
      const serialized = readBoundedExecutorRegistration(registration.path!)
      const latest = JSON.parse(serialized) as Record<string, unknown>
      if (![3, 4].includes(Number(latest.version))
        || latest.version !== registration.version
        || latest.jobId !== registration.jobId || latest.pid !== pid
        || latest.started !== registration.started || !Array.isArray(latest.tracked)
        || latest.tracked.length < 1 || latest.tracked.length > MAX_TRACKED_PROCESSES
        || !['active', 'recovery', 'cleanup-confirmed'].includes(String(latest.phase))
        || !Number.isSafeInteger(latest.revision) || Number(latest.revision) < revision) {
        throw new Error(`executor registration changed during cleanup: ${registration.path}`)
      }
      if (registration.version === 4) {
        if (JSON.stringify(latest.fingerprint) !== JSON.stringify(registration.fingerprint)) {
          throw new Error(`executor Seatbelt fingerprint changed during cleanup: ${registration.path}`)
        }
        verifySeatbeltFingerprint(stateDirectory, registration.fingerprint!)
      }
      const parsed: Array<{ pid: number; started: string }> = []
      const keys = new Set<string>()
      for (const item of latest.tracked) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error(`invalid executor tracked generation: ${registration.path}`)
        }
        const value = item as Record<string, unknown>
        if (Object.keys(value).sort().join('\n') !== 'pid\nstarted'
          || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
          || typeof value.started !== 'string' || !parseProcessStartKey(value.started)) {
          throw new Error(`invalid executor tracked generation: ${registration.path}`)
        }
        const key = `${Number(value.pid)}:${value.started}`
        if (keys.has(key)) throw new Error(`duplicate executor tracked generation: ${registration.path}`)
        keys.add(key)
        parsed.push({ pid: Number(value.pid), started: value.started })
      }
      synchronizeExecutorRecoveryLedger(
        ledger,
        parsed,
        recoveryWriterFrozen ? 'merge' : 'replace',
      )
      phase = latest.phase as typeof phase
      revision = Number(latest.revision)
    }
    readLatest()
    testHooks.afterInitialRegistrationRead?.(registration.path)
    const writeRecovery = (nextPhase: 'recovery' | 'cleanup-confirmed'): void => {
      if (!recoveryWriterFrozen) {
        throw new Error('executor recovery writer is not frozen')
      }
      // The daemon lock excludes another recovery writer and the exact
      // supervisor generation is stopped/dead. Re-read the current pathname
      // immediately before every replace so a newer durable revision can
      // never be overwritten from a stale in-memory snapshot.
      readLatest()
      if (phase === 'cleanup-confirmed') {
        throw new Error('executor cleanup was already confirmed before recovery write')
      }
      const nextRevision = revision + 1
      atomicWritePrivateFile(registration.path!, serializeBoundedExecutorRegistration({
        version: registration.version,
        phase: nextPhase,
        revision: nextRevision,
        cleanupPending: true,
        jobId: registration.jobId,
        pid,
        pgid: registration.pgid,
        started: registration.started,
        bootSession: registration.bootSession,
        startSec: registration.startSec,
        startUsec: registration.startUsec,
        tracked: [...ledger.values()].sort((left, right) => (
          left.pid - right.pid || left.started.localeCompare(right.started)
        )),
        ...(registration.fingerprint ? { fingerprint: registration.fingerprint } : {}),
      }))
      phase = nextPhase
      revision = nextRevision
    }
    const expectedIdentity = (item: { pid: number; started: string }): ProcessIdentity => {
      const generation = parseProcessStartKey(item.started)
      if (!generation) throw new Error(`invalid tracked generation for PID ${item.pid}`)
      return { pid: item.pid, ppid: 0, pgid: 0, status: 0, ...generation, started: item.started }
    }
    const liveTracked = (): Map<number, string> => {
      const live = new Map<number, string>()
      for (const item of ledger.values()) {
        const observation = observeProcessGeneration(expectedIdentity(item))
        if (observation.status === 'unknown') {
          throw new Error(`executor process ${item.pid} generation is unknown`)
        }
        if (observation.status !== 'alive') continue
        const prior = live.get(item.pid)
        if (prior && prior !== item.started) {
          throw new Error(`multiple live generations observed for PID ${item.pid}`)
        }
        live.set(item.pid, item.started)
      }
      return live
    }
    const supervisor = expectedIdentity({ pid, started: registration.started })
    const supervisorObservation = observeProcessGeneration(supervisor)
    if (supervisorObservation.status === 'unknown') {
      throw new Error(`executor supervisor ${pid} generation is unknown`)
    }
    const reapCleanupConfirmedReceipt = async (): Promise<boolean> => {
      if (phase !== 'cleanup-confirmed') return false
      // The supervisor publishes this phase only after every relay and exact
      // descendant cleanup has completed.  A runner-recovery pass may observe
      // that durable receipt in the tiny window before the supervisor's final
      // process.exit(), or while the host is heavily loaded.  Do not turn that
      // scheduling window into a FIFO startup failure: this is already the
      // explicit crash-recovery path, so terminate only the receipt's exact
      // process generations and then verify that none remain.  Normal jobs and
      // normal cleanup still have no automatic deadline.
      let receiptLive = liveTracked()
      for (const [trackedPid, started] of receiptLive) {
        signalProcessIfLive(expectedIdentity({ pid: trackedPid, started }), 'SIGKILL')
      }
      const deadline = Date.now() + Math.max(2_000, timeoutMs)
      while (receiptLive.size > 0 && Date.now() < deadline) {
        await Bun.sleep(25)
        receiptLive = liveTracked()
      }
      if (receiptLive.size > 0) {
        throw new Error('cleanup-confirmed executor still has live generations')
      }
      if (registration.version === 4) {
        await reapSeatbeltFingerprint({
          stateDir: stateDirectory,
          fingerprint: registration.fingerprint!,
          earliest: supervisor,
        })
      }
      return true
    }
    if (await reapCleanupConfirmedReceipt()) return
    if (supervisorObservation.status === 'alive') {
      // Freeze the exact group first. A live group leader is the only safe
      // authority for negative-PGID signalling; a recycled numeric PGID must
      // never be used after this generation exits.
      signalProcessGroupIfLeaderLive(supervisorObservation.identity, 'SIGSTOP')
    }
    // Detached descendants recorded by the supervisor may outlive (or leave
    // the process group before) the supervisor. Freeze every exact live ledger
    // generation regardless of root liveness, then discover from all of those
    // frozen roots. This closes the recovery gap where a dead/reused supervisor
    // previously caused us to skip fixed-point capture entirely.
    const freezeLedger = async (label: string): Promise<void> => {
      for (const item of ledger.values()) signalProcessIfLive(expectedIdentity(item), 'SIGSTOP')
      if (liveTracked().size === 0) return
      const stopDeadline = Date.now() + 2_000
      while (true) {
        const notStopped = [...ledger.values()].filter(item => {
          const observation = observeProcessGeneration(expectedIdentity(item))
          if (observation.status === 'unknown') {
            throw new Error(`executor process ${item.pid} generation is unknown while freezing`)
          }
          return observation.status === 'alive' && !processIdentityIsStopped(observation.identity)
        })
        if (notStopped.length === 0) break
        if (Date.now() >= stopDeadline) {
          throw new Error(`${label} executor generations did not stop: ${notStopped.map(item => item.pid).join(', ')}`)
        }
        await Bun.sleep(10)
      }
    }
    await freezeLedger('initial')
    // SIGSTOP is uncatchable and stops every thread in the exact supervisor.
    // Only after proving that writer stopped (or died) may recovery consume
    // the pathname's latest atomic revision and become its sole writer.
    const frozenSupervisor = observeProcessGeneration(supervisor)
    if (frozenSupervisor.status === 'unknown'
      || (frozenSupervisor.status === 'alive'
        && !processIdentityIsStopped(frozenSupervisor.identity))) {
      throw new Error(`executor supervisor ${pid} was not frozen before recovery refresh`)
    }
    readLatest()
    if (await reapCleanupConfirmedReceipt()) return
    await freezeLedger('refreshed')
    recoveryWriterFrozen = true
    if (liveTracked().size > 0) {
      let stablePasses = 0
      let previousSize = -1
      for (let pass = 0; pass < 100 && stablePasses < 2; pass += 1) {
        const tracked = liveTracked()
        const liveRoots = [...tracked.keys()]
        if (liveRoots.length > 0) {
          captureTrackedProcesses(liveRoots, pid, tracked)
        }
        mergeLedger([...tracked].map(([trackedPid, started]) => ({ pid: trackedPid, started })))
        writeRecovery('recovery')
        for (const [trackedPid, started] of tracked) {
          signalProcessIfLive(expectedIdentity({ pid: trackedPid, started }), 'SIGSTOP')
        }
        const passDeadline = Date.now() + 2_000
        while (true) {
          const notStopped = [...liveTracked()].filter(([trackedPid, started]) => {
            const observation = observeProcessGeneration(expectedIdentity({
              pid: trackedPid,
              started,
            }))
            return observation.status === 'alive' && !processIdentityIsStopped(observation.identity)
          })
          if (notStopped.length === 0) break
          if (Date.now() >= passDeadline) {
            throw new Error(`new executor generations did not stop: ${notStopped.map(item => item[0]).join(', ')}`)
          }
          await Bun.sleep(10)
        }
        if (ledger.size === previousSize) stablePasses += 1
        else stablePasses = 0
        previousSize = ledger.size
        await Bun.sleep(25)
      }
      if (stablePasses < 2) throw new Error('executor descendant freeze did not reach a fixed point')
    }
    writeRecovery('recovery')
    const live = liveTracked()
    for (const [trackedPid, started] of live) {
      signalProcessIfLive(expectedIdentity({ pid: trackedPid, started }), 'SIGKILL')
    }
    const deadline = Date.now() + 2_000
    let remaining = liveTracked()
    while (remaining.size > 0 && Date.now() < deadline) {
      await Bun.sleep(25)
      remaining = liveTracked()
    }
    if (remaining.size > 0) {
      throw new Error(`orphaned Codex descendants did not stop: ${[...remaining.keys()].join(', ')}`)
    }
    if (registration.version === 4) {
      await reapSeatbeltFingerprint({
        stateDir: stateDirectory,
        fingerprint: registration.fingerprint!,
        earliest: supervisor,
      })
    }
    writeRecovery('cleanup-confirmed')
  }

  const removeRegistrationArtifacts = (
    registration: (typeof registrations extends Map<number, infer T> ? T : never),
  ): void => {
    if (registration.fingerprint && registration.started && registration.bootSession
      && registration.startSec !== undefined && registration.startUsec !== undefined
      && registration.pgid !== undefined) {
      recordAdvisorExecutorRetirementForJob({
        stateDir: stateDirectory,
        jobId: registration.jobId,
        fingerprint: registration.fingerprint,
        supervisor: {
          pid: registration.pgid,
          pgid: registration.pgid,
          started: registration.started,
          bootSession: registration.bootSession,
          startSec: registration.startSec,
          startUsec: registration.startUsec,
        },
      })
    }
    if (registration.path) rmSync(registration.path, { force: true })
    if (registration.fingerprint) {
      removeSeatbeltFingerprint(stateDirectory, registration.fingerprint)
    }
  }

  for (const [pid, registration] of registrations) {
    const legacyRegistration = Boolean(registration.path && (!registration.bootSession
      || registration.startSec === undefined || registration.startUsec === undefined))
    if (!legacyRegistration && registration.bootSession) {
      const currentBoot = readBootSession()
      if (!currentBoot) {
        throw new Error(`executor PID ${pid}のboot sessionを確認できません`)
      }
      if (currentBoot !== registration.bootSession) {
        if (registration.version === 3 || registration.version === 4) {
          await reapDurablyTrackedDescendants(pid, registration)
        }
        store.clearExecutorPid(registration.jobId, pid)
        removeRegistrationArtifacts(registration)
        continue
      }
    }
    const initialIdentity = readProcessIdentity(pid)
    if (!initialIdentity) {
      if (fallbackProcessState(pid) !== 'dead') {
        throw new Error(`executor PID ${pid}のprecise generationを確認できません`)
      }
      if (!legacyRegistration && registration.pgid === pid) {
        await reapDurablyTrackedDescendants(pid, registration)
      }
      store.clearExecutorPid(registration.jobId, pid)
      removeRegistrationArtifacts(registration)
      continue
    }
    let initialLegacy: { started: string; pgid: number } | undefined
    let legacyIdentityMismatch = false
    if (legacyRegistration) {
      initialLegacy = legacyExecutorIdentity(pid)
      if (!initialLegacy) {
        throw new Error(`legacy executor PID ${pid}のidentityを確認できません`)
      }
      legacyIdentityMismatch = !registration.started
        || registration.started !== initialLegacy.started
        || initialLegacy.pgid !== initialIdentity.pgid
    } else if ((registration.started && registration.started !== initialIdentity.started)
      || (registration.bootSession && (registration.bootSession !== initialIdentity.bootSession
        || registration.startSec !== initialIdentity.startSec
        || registration.startUsec !== initialIdentity.startUsec))) {
      if (registration.version === 3 || registration.version === 4) {
        await reapDurablyTrackedDescendants(pid, registration)
      } else if (registration.pgid === pid && initialIdentity.pgid !== pid) {
        const group = registeredProcessGroupState(registration.pgid)
        if (group !== 'dead') {
          throw new Error(`stale executor group ${registration.pgid}の終了を確認できません: ${group}`)
        }
      }
      log(`discarding stale executor PID ${pid} for job ${registration.jobId}: start identity mismatch`)
      store.clearExecutorPid(registration.jobId, pid)
      removeRegistrationArtifacts(registration)
      continue
    }
    const commandProbe = trackedExecutorCommand(pid)
    if (commandProbe.status === 'unknown') {
      throw new Error(`executor PID ${pid}のcommandを確認できません`)
    }
    const command = commandProbe.command
    const supervised = command.includes('codex-supervisor') && command.includes(registration.jobId)
    const legacyDirect = command.includes(registration.jobId)
      && /(?:^|[\/\s])codex(?:[\/\s]|$)|codex-cli/i.test(command)
    if (!supervised && !legacyDirect) {
      // PID reuse must never make the FIFO permanently unstartable. Fail
      // closed by leaving the unrelated process alone, discard only our stale
      // registration, and let recoverInterrupted classify the job.
      log(`discarding stale executor PID ${pid} for job ${registration.jobId}: identity mismatch`)
      if (registration.version === 3 || registration.version === 4) {
        await reapDurablyTrackedDescendants(pid, registration)
      }
      store.clearExecutorPid(registration.jobId, pid)
      removeRegistrationArtifacts(registration)
      continue
    }
    if (legacyIdentityMismatch) {
      throw new Error(`legacy executor PID ${pid}のstart identityが一致しません`)
    }
    const signalIdentity = readProcessIdentity(pid)
    const signalLegacy = legacyRegistration ? legacyExecutorIdentity(pid) : undefined
    if (!signalIdentity || signalIdentity.started !== initialIdentity.started
      || signalIdentity.pgid !== initialIdentity.pgid
      || (legacyRegistration && (!signalLegacy || !initialLegacy
        || signalLegacy.started !== initialLegacy.started
        || signalLegacy.pgid !== initialLegacy.pgid))) {
      log(`discarding stale executor PID ${pid} for job ${registration.jobId}: identity changed before signal`)
      if (registration.version === 3 || registration.version === 4) {
        await reapDurablyTrackedDescendants(pid, registration)
      }
      store.clearExecutorPid(registration.jobId, pid)
      removeRegistrationArtifacts(registration)
      continue
    }
    log(`stopping orphaned Codex executor PID ${pid} for job ${registration.jobId}`)
    signalTrackedExecutor(signalIdentity, 'SIGTERM')
    const startedAt = Date.now()
    while (processIdentityIsLive(signalIdentity) && Date.now() - startedAt < timeoutMs) {
      await Bun.sleep(50)
    }
    if (processIdentityIsLive(signalIdentity)) {
      if (registration.version === 3 || registration.version === 4) {
        await reapDurablyTrackedDescendants(pid, registration)
      } else {
        signalTrackedExecutor(signalIdentity, 'SIGKILL')
        await Bun.sleep(100)
      }
    }
    if (processIdentityIsLive(signalIdentity)) {
      throw new Error(`orphaned Codex executor PID ${pid} did not stop`)
    }
    await reapDurablyTrackedDescendants(pid, registration)
    store.clearExecutorPid(registration.jobId, pid)
    removeRegistrationArtifacts(registration)
  }
  const recoveredFingerprintPids = await recoverOrphanSeatbeltFingerprints(stateDirectory)
  if (recoveredFingerprintPids.length > 0) {
    log(
      `stopped orphaned fingerprint processes: ${recoveredFingerprintPids.join(', ')}`,
    )
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
  if (command === 'validate-storage') {
    requireSafeDatabasePath(defaultDbPath())
    process.stdout.write('{"storage":"safe"}\n')
    return
  }
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
        claudeAdvisor: {
          lifecycle: 'fresh-ephemeral-per-round',
          existingPanesUntouched: true,
        },
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
    const lease = acquireDaemonLock(lockDir, dir)
    if (!lease) {
      store.close()
      throw new Error('job runner is still running; refuse legacy migration')
    }
    try {
      const migrated = store.migrateLegacyActive()
      process.stdout.write(`${JSON.stringify({ migrated })}\n`)
    } finally {
      store.close()
      releaseDaemonLock(lockDir, lease)
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

  if (command === 'initialize-slack-catchup-floor') {
    try {
      const tokens = parseStateSlackTokens(readOptionalPrivateFile(join(dir, '.env')) ?? '')
      if (!tokens.SLACK_APP_TOKEN) throw new Error('Slack App token is missing')
      const result = store.initializeSlackCatchupFloorIfPristine(
        appIdFromAppToken(tokens.SLACK_APP_TOKEN),
      )
      process.stdout.write(`${JSON.stringify(result)}\n`)
    } finally { store.close() }
    return
  }

  if (command === 'recover-interrupted') {
    const lockDir = join(dir, 'job-runner.lock')
    const lease = acquireDaemonLock(lockDir, dir)
    if (!lease) {
      store.close()
      throw new Error('job runner is still running; refuse interrupted-job recovery')
    }
    const log = (message: string) => process.stderr.write(`${message}\n`)
    try {
      const runtime = readPinnedHerdrRuntime(dir)
      await verifyHerdrRuntimeIdentityAsync(runtime)
      await terminateTrackedExecutors(store, log, 15_000, dir)
      const interjections = store.reconcileInterjectionsBeforeRecovery()
      if (interjections.preparedReset > 0 || interjections.promoted > 0
        || interjections.blocked > 0) {
        log(`reconciled conversational interjections: ${JSON.stringify(interjections)}`)
      }
      const recoverMissingMonitor = (
        jobId: string,
        status: JobStatus | 'missing',
        state: 'preparing' | 'required' | 'lost-staged',
      ): 'terminalized' | 'unarmed' | 'staged-result' => {
        if (state === 'preparing') {
          if (!store.releaseUnarmedMonitorPreparation(jobId)) {
            throw new HerdrJobMonitorPendingError(
              `could not release unarmed monitor preparation for ${jobId}`,
            )
          }
          return 'unarmed'
        }
        if (state === 'lost-staged') return 'staged-result'
        if (store.hasStagedExecution(jobId)) {
          if (!store.markMonitorLostAfterStagedResult(jobId)) {
            throw new HerdrJobMonitorPendingError(
              `could not preserve staged result after monitor loss for ${jobId}`,
            )
          }
          log(`preserved staged result for ${jobId} after proving its Herdr monitor was lost`)
          return 'staged-result'
        }
        if (status === 'queued' && store.uiApprovalIsWaiting(jobId)) {
          store.retireMonitorObligation(jobId)
          log(`retired ${jobId} monitor after entering UI/UX approval wait`)
          return 'terminalized'
        }
        if ((status === 'queued' || status === 'running')
          && store.failAfterMonitorLoss(jobId, MONITOR_LOSS_RECOVERY_MESSAGE)) {
          log(`failed ${jobId} after proving its Herdr monitor was lost and executors stopped`)
          return 'terminalized'
        }
        store.retireMonitorObligation(jobId)
        return 'terminalized'
      }
      const { journaled, completed } = await recoverExecutionCheckpointBeforeAdvisorCleanup(
        store,
        dir,
        () => reconcileAdvisorsWithMonitorHealthBarrier(
          store,
          () => reconcileHerdrJobMonitors({
            stateDir: dir,
            runtime,
            getJob: jobId => store.get(jobId),
            listMonitorObligations: () => store.monitorObligations(),
            recoverMissingBindingAfterExecutorsStopped: recoverMissingMonitor,
            onMonitorRetired: jobId => store.retireMonitorObligation(jobId),
            publicFailureReason: jobId => publicJobFailureSummary(
              store.get(jobId)?.lastError ?? '',
            ),
          }),
          async () => { await reconcileEphemeralAndRetiredAdvisorRounds({
            stateDir: dir,
            runtime,
            log,
          }) },
        ),
      )
      if (journaled > 0) log(`recovered ${journaled} durable execution result journal(s)`)
      if (completed > 0) log(`completed ${completed} staged execution(s) after advisor recovery`)
      const recovered = store.recoverInterrupted(dir)
      const monitors = await reconcileHerdrJobMonitors({
        stateDir: dir,
        runtime,
        getJob: jobId => store.get(jobId),
        listMonitorObligations: () => store.monitorObligations(),
        recoverMissingBindingAfterExecutorsStopped: recoverMissingMonitor,
        onMonitorRetired: jobId => store.retireMonitorObligation(jobId),
        publicFailureReason: jobId => publicJobFailureSummary(
          store.get(jobId)?.lastError ?? '',
        ),
      })
      if (monitors.closed > 0 || monitors.retained > 0) {
        log(`reconciled Herdr job monitors: ${JSON.stringify(monitors)}`)
      }
      process.stdout.write(`${JSON.stringify(recovered)}\n`)
    } finally {
      store.close()
      releaseDaemonLock(lockDir, lease)
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

  const log = (message: string) => process.stderr.write(`${new Date().toISOString()} ${message}\n`)
  loadStateEnv(dir)
  const slackTokens = takeSlackTokensFromEnvironment()
  const botToken = slackTokens.SLACK_BOT_TOKEN
  const appToken = slackTokens.SLACK_APP_TOKEN
  let notifier: SlackNotifier | undefined
  let slackRuntimeId: string | undefined
  let runnerRuntimeId: string | undefined
  const launchHerdrRuntime = process.env.ZEROKUN_LAUNCH_HERDR_RUNTIME
    ? decodeHerdrRuntimeIdentity(process.env.ZEROKUN_LAUNCH_HERDR_RUNTIME)
    : undefined
  delete process.env.ZEROKUN_LAUNCH_HERDR_RUNTIME
  const pinnedHerdrRuntime = launchHerdrRuntime ?? readPinnedHerdrRuntime(dir)
  await verifyHerdrRuntimeIdentityAsync(pinnedHerdrRuntime)
  const pinnedHerdrId = herdrRuntimeFingerprint(pinnedHerdrRuntime)
  try {
    const loginCodex = resolveOfficialStandaloneCodex()
    verifyOfficialCodexSnapshot(loginCodex)
    assertCodexChatGptSubscriptionLogin(loginCodex.physical)
    verifyOfficialCodexSnapshot(loginCodex)
  } catch (error) {
    store.close()
    throw error
  }
  if (botToken || appToken) {
    if (!botToken || !appToken) {
      store.close()
      throw new Error('Slack progress notifications require one Bot/App token pair')
    }
    try {
      const identityClient = new WebClient(botToken, slackWebClientOptions(10_000))
      await verifySlackAppTokenPair(appToken, {
        authTest: () => identityClient.auth.test({}),
        botsInfo: async bot => {
          const result = await identityClient.bots.info({ bot })
          return { app_id: result.bot?.app_id }
        },
      })
      slackRuntimeId = slackTokenPairRuntimeIdentity(botToken, appToken)
      runnerRuntimeId = `${slackRuntimeId}:${pinnedHerdrId}`
      notifier = new SlackNotifier(botToken, log, store)
    } catch (error) {
      store.close()
      throw error
    }
  } else {
    runnerRuntimeId = `no-slack:${pinnedHerdrId}`
    log('Slack Bot/App tokens not found; Slack progress notifications are disabled')
  }

  const lockDir = join(dir, 'job-runner.lock')
  const daemonLease = acquireDaemonLock(lockDir, dir, runnerRuntimeId)
  if (!daemonLease) {
    process.stderr.write(`zerokun job runner already running (${lockDir})\n`)
    store.close()
    return
  }
  // Publish only after winning the daemon lease. A concurrent losing launcher
  // can no longer replace the live runner's pane identity.
  if (launchHerdrRuntime) writePinnedHerdrRuntime(dir, launchHerdrRuntime)

  const updateJournal = join(dir, 'update-transaction.json')
  let startupRetainedMonitorJobIds: string[] = []
  if (!updateTransactionPending(updateJournal)) {
    await terminateTrackedExecutors(store, log, 15_000, dir)
    const interjections = store.reconcileInterjectionsBeforeRecovery()
    if (interjections.preparedReset > 0 || interjections.promoted > 0
      || interjections.blocked > 0) {
      log(`reconciled conversational interjections: ${JSON.stringify(interjections)}`)
    }
    const recoverMissingMonitor = (
      jobId: string,
      status: JobStatus | 'missing',
      state: 'preparing' | 'required' | 'lost-staged',
    ): 'terminalized' | 'unarmed' | 'staged-result' => {
      if (state === 'preparing') {
        if (!store.releaseUnarmedMonitorPreparation(jobId)) {
          throw new HerdrJobMonitorPendingError(
            `could not release unarmed monitor preparation for ${jobId}`,
          )
        }
        return 'unarmed'
      }
      if (state === 'lost-staged') return 'staged-result'
      if (store.hasStagedExecution(jobId)) {
        if (!store.markMonitorLostAfterStagedResult(jobId)) {
          throw new HerdrJobMonitorPendingError(
            `could not preserve staged result after monitor loss for ${jobId}`,
          )
        }
        log(`preserved staged result for ${jobId} after proving its Herdr monitor was lost`)
        return 'staged-result'
      }
      if (status === 'queued' && store.uiApprovalIsWaiting(jobId)) {
        store.retireMonitorObligation(jobId)
        log(`retired ${jobId} monitor after entering UI/UX approval wait`)
        return 'terminalized'
      }
      if ((status === 'queued' || status === 'running')
        && store.failAfterMonitorLoss(jobId, MONITOR_LOSS_RECOVERY_MESSAGE)) {
        log(`failed ${jobId} after proving its Herdr monitor was lost and executors stopped`)
        return 'terminalized'
      }
      store.retireMonitorObligation(jobId)
      return 'terminalized'
    }
    const { journaled, completed: staged } = await recoverExecutionCheckpointBeforeAdvisorCleanup(
      store,
      dir,
      () => reconcileAdvisorsWithMonitorHealthBarrier(
        store,
        () => reconcileHerdrJobMonitors({
          stateDir: dir,
          runtime: pinnedHerdrRuntime,
          getJob: jobId => store.get(jobId),
          listMonitorObligations: () => store.monitorObligations(),
          recoverMissingBindingAfterExecutorsStopped: recoverMissingMonitor,
          onMonitorRetired: jobId => store.retireMonitorObligation(jobId),
          publicFailureReason: jobId => publicJobFailureSummary(
            store.get(jobId)?.lastError ?? '',
          ),
        }),
        async () => { await reconcileEphemeralAndRetiredAdvisorRounds({
          stateDir: dir,
          runtime: pinnedHerdrRuntime,
          log,
        }) },
      ),
    )
    if (journaled > 0) log(`recovered ${journaled} durable execution result journal(s)`)
    if (staged > 0) log(`completed ${staged} staged execution(s) after advisor recovery`)
    const recovered = store.recoverInterrupted(dir)
    if (recovered.requeued > 0) {
      log(`requeued ${recovered.requeued} interrupted read-only job(s)`)
    }
    if (recovered.failedWrites > 0) {
      log(`failed ${recovered.failedWrites} interrupted write job(s) with uncertain effects`)
    }
    if (recovered.failedUncertain > 0) {
      log(`failed ${recovered.failedUncertain} interrupted read job(s) after advisor delivery`)
    }
    const monitors = await reconcileHerdrJobMonitors({
      stateDir: dir,
      runtime: pinnedHerdrRuntime,
      getJob: jobId => store.get(jobId),
      listMonitorObligations: () => store.monitorObligations(),
      recoverMissingBindingAfterExecutorsStopped: recoverMissingMonitor,
      onMonitorRetired: jobId => store.retireMonitorObligation(jobId),
      publicFailureReason: jobId => publicJobFailureSummary(
        store.get(jobId)?.lastError ?? '',
      ),
    })
    startupRetainedMonitorJobIds = monitors.retainedJobIds
    if (monitors.closed > 0 || monitors.retained > 0) {
      log(`reconciled Herdr job monitors: ${JSON.stringify(monitors)}`)
    }
  } else {
    log('update transaction pending; startup recovery and job execution are paused')
  }
  if (!updateTransactionPending(updateJournal)) {
    const initialMaintenance = maintainState(store, dir)
    log(`state maintenance: ${JSON.stringify(initialMaintenance)}`)
  }
  const controller = new AbortController()
  const stop = () => controller.abort()
  const ignoreInterrupt = () => {}
  if (command === 'daemon') process.on('SIGINT', ignoreInterrupt)
  else process.on('SIGINT', stop)
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

  const slackIdentityChanged = createSlackIdentityPauseGuard(
    dir, slackRuntimeId, controller, log,
  )
  let herdrIdentityInvalid = false
  let herdrIdentityCheck: Promise<void> | null = null
  const checkHerdrIdentity = (): void => {
    if (herdrIdentityInvalid || herdrIdentityCheck) return
    herdrIdentityCheck = verifyHerdrRuntimeIdentityAsync(pinnedHerdrRuntime)
      .catch(error => {
        herdrIdentityInvalid = true
        log(`Herdr runtime identity changed; stopping before claiming more work: ${error}`)
        controller.abort()
      })
      .finally(() => { herdrIdentityCheck = null })
  }
  const herdrIdentityTimer = setInterval(checkHerdrIdentity, 5_000)
  herdrIdentityTimer.unref()
  let serviceControlPauseWarning = ''
  const shouldPause = (): boolean => {
    if (slackIdentityChanged() || herdrIdentityInvalid) return true
    const paused = updateTransactionPending(updateJournal) || updateIsRunning(join(dir, 'update.lock'))
    if (paused) {
      try {
        acknowledgeServiceControlPauseIfRequested(dir)
        serviceControlPauseWarning = ''
      } catch (error) {
        const warning = error instanceof Error ? error.message : String(error)
        if (warning !== serviceControlPauseWarning) {
          log(`service control pause acknowledgement failed: ${warning}`)
          serviceControlPauseWarning = warning
        }
      }
    }
    return paused
  }

  type MonitorGuard = {
    controller: AbortController
    health: Promise<void>
    failure?: HerdrJobMonitorPendingError
    executionController?: AbortController
  }
  const monitorGuards = new Map<string, MonitorGuard>()
  let monitorFatal: HerdrJobMonitorPendingError | undefined
  const failMonitorGuard = (jobId: string, guard: MonitorGuard, error: unknown): void => {
    // Aborting the polling signal does not cancel an already-started Herdr
    // list/process-info probe. Its failure must still be recorded; only an
    // abort while sleeping exits watchHerdrJobMonitor normally without catch.
    if (guard.failure) return
    let persistenceError: unknown
    try { store.recordMonitorFailure(jobId, String(error)) } catch (recordError) {
      persistenceError = recordError
    }
    guard.failure = new HerdrJobMonitorPendingError(
      `Herdr monitor became unavailable for job ${jobId}: ${error}`
        + (persistenceError ? `; durable fault receipt failed: ${persistenceError}` : ''),
    )
    monitorFatal ??= guard.failure
    guard.executionController?.abort()
    controller.abort()
  }
  const ensureMonitorGuard = (jobId: string): MonitorGuard => {
    const existing = monitorGuards.get(jobId)
    if (existing) return existing
    const guard: MonitorGuard = {
      controller: new AbortController(),
      health: Promise.resolve(),
    }
    monitorGuards.set(jobId, guard)
    guard.health = watchHerdrJobMonitor({
      stateDir: dir,
      runtime: pinnedHerdrRuntime,
      jobId,
      signal: guard.controller.signal,
    }).catch(error => failMonitorGuard(jobId, guard, error))
    return guard
  }
  const assertMonitorGuard = (jobId: string): MonitorGuard => {
    const guard = monitorGuards.get(jobId)
    if (!guard) throw new HerdrJobMonitorPendingError(`Herdr monitor guard is missing for job ${jobId}`)
    if (guard.failure) throw guard.failure
    return guard
  }
  const quiesceMonitorGuard = async (jobId: string): Promise<void> => {
    const guard = assertMonitorGuard(jobId)
    guard.controller.abort()
    await guard.health
    if (guard.failure) throw guard.failure
  }
  const stopMonitorGuard = async (jobId: string): Promise<HerdrJobMonitorPendingError | undefined> => {
    const guard = monitorGuards.get(jobId)
    if (!guard) return undefined
    guard.controller.abort()
    await guard.health
    monitorGuards.delete(jobId)
    return guard.failure
  }
  const stopAllMonitorGuards = async (): Promise<void> => {
    const jobs = [...monitorGuards.keys()]
    await Promise.all(jobs.map(jobId => stopMonitorGuard(jobId)))
  }

  // A deferred FIFO head can stay queued for hours after a rate limit. Resume
  // continuous health monitoring immediately after startup reconciliation,
  // rather than waiting for notBefore to expire and the job to be claimed.
  for (const jobId of startupRetainedMonitorJobIds) ensureMonitorGuard(jobId)

  try {
    await runQueuedJobs({
      store,
      maxJobsPerSession: configuredMaxJobsPerSession(
        process.env.ZEROKUN_MAX_JOBS_PER_SESSION,
      ),
      pollMs: positiveInteger(process.env.ZEROKUN_JOB_POLL_MS, 1000),
      stopWhenIdle: command === 'run-until-idle',
      shouldPause,
      advisorStateDir: dir,
      beforeClaim: async () => { await reconcileEphemeralAndRetiredAdvisorRounds({
        stateDir: dir,
        runtime: pinnedHerdrRuntime,
        log,
      }) },
      settleExternalContext: async () => { await reconcileEphemeralAndRetiredAdvisorRounds({
        stateDir: dir,
        runtime: pinnedHerdrRuntime,
        log,
      }) },
      cancelExternalContext: async () => { await reconcileEphemeralAndRetiredAdvisorRounds({
        stateDir: dir,
        runtime: pinnedHerdrRuntime,
        log,
      }) },
      openJobMonitor: async job => {
        try {
          const current = store.get(job.id)
          if (!current?.workerId) throw new Error(`job ${job.id} has no claiming worker`)
          store.beginMonitorPreparation(job.id, current.workerId)
          await openHerdrJobMonitor({
            stateDir: dir,
            runtime: pinnedHerdrRuntime,
            job,
            beforeFirstHerdrMutation: () => {
              store.commitMonitorRequired(job.id, current.workerId!)
            },
          })
          if (store.get(job.id)?.monitorState !== 'required') {
            throw new Error(`Herdr monitor requirement is not durable for ${job.id}`)
          }
          const guard = ensureMonitorGuard(job.id)
          if (guard.failure) throw guard.failure
        } catch (error) {
          throw new HerdrJobMonitorPendingError(
            `Herdr monitor preparation is pending for job ${job.id}: ${error}`,
          )
        }
      },
      assertJobMonitorHealthy: job => { assertMonitorGuard(job.id) },
      quiesceJobMonitor: job => quiesceMonitorGuard(job.id),
      updateJobMonitor: (job, message) => {
        appendHerdrJobMonitorStatus(dir, job.id, message)
      },
      recordJobMonitorFailure: (job, error) => store.recordMonitorFailure(job.id, String(error)),
      closeJobMonitor: async job => {
        const guardFailure = await stopMonitorGuard(job.id)
        if (guardFailure) throw guardFailure
        await closeHerdrJobMonitor({
          stateDir: dir,
          runtime: pinnedHerdrRuntime,
          jobId: job.id,
          outcome: job.terminalOutcome === 'cancelled'
            ? 'cancelled'
            : job.status === 'failed'
              ? 'failed'
              : job.uiApprovalRequestId !== null ? 'waiting' : 'completed',
          onMonitorRetired: jobId => store.retireMonitorObligation(jobId),
        })
      },
      retainFailedJobMonitor: async job => {
        const guardFailure = await stopMonitorGuard(job.id)
        if (guardFailure) throw guardFailure
        await retainFailedHerdrJobMonitor({
          stateDir: dir,
          runtime: pinnedHerdrRuntime,
          jobId: job.id,
          publicReason: publicJobFailureSummary(job.lastError ?? ''),
          onMonitorRetired: jobId => store.retireMonitorObligation(jobId),
        })
      },
      signal: controller.signal,
      notifier,
      executorStagesResult: true,
      executor: async (job, signal, executionContext) => {
        if (!executionContext) throw new Error('job execution context is unavailable')
        const executionController = new AbortController()
        const guard = assertMonitorGuard(job.id)
        guard.executionController = executionController
        const forwardAbort = () => executionController.abort()
        if (signal?.aborted) forwardAbort()
        else signal?.addEventListener('abort', forwardAbort, { once: true })
        if (guard.failure) executionController.abort()
        const mirrorMonitorMessage = (message: string): void => {
          if (guard.failure) return
          try { appendHerdrJobMonitorStatus(dir, job.id, message) } catch (error) {
            failMonitorGuard(job.id, guard, error)
          }
        }
        try {
          const executorPidLifecycle = createExecutorPidLifecycle(store, job.id)
          const execution = await executeCodexJob(job, {
            signal: executionController.signal,
            stateDir: dir,
            logDir: join(dir, 'job-logs'),
            uiApproval: store.latestUiApprovalContext(job.id),
            ...executorPidLifecycle,
            onSessionId: sessionId => store.saveSession(job.id, sessionId),
            onSessionReset: () => store.clearSession(job.id),
            liveControls: {
              next: () => store.nextReadyLiveInput(job.id, job.controlEpoch),
              nextInterjection: () => store.nextPendingInterjection(job.id, job.controlEpoch),
              bindTurn: (executorNonce, threadId, turnId) => store.bindAppServerTurn(
                job.id,
                job.workerId!,
                job.controlEpoch,
                executorNonce,
                threadId,
                turnId,
              ),
              beginInitialDispatch: ({
                executorNonce, threadId, requestId, inputRevision, inputDigest,
              }) => (
                store.beginInitialTurnDispatch({
                  jobId: job.id,
                  attempt: job.attempts,
                  epoch: job.controlEpoch,
                  executorNonce,
                  threadId,
                  requestId,
                  inputRevision,
                  inputDigest,
                })
              ),
              acknowledgeInitialDispatch: ({
                executorNonce, threadId, turnId, requestId,
              }) => store.acknowledgeInitialTurnDispatch({
                jobId: job.id,
                workerId: job.workerId!,
                attempt: job.attempts,
                epoch: job.controlEpoch,
                executorNonce,
                threadId,
                turnId,
                requestId,
              }),
              initialDispatchAmbiguous: (requestId, error) => (
                store.markInitialTurnDispatchAmbiguous({
                  jobId: job.id,
                  attempt: job.attempts,
                  requestId,
                  error,
                })
              ),
              initialDispatchRejected: (requestId, error) => (
                store.markInitialTurnDispatchRejected({
                  jobId: job.id,
                  attempt: job.attempts,
                  requestId,
                  error,
                })
              ),
              preparePhaseDispatch: ({
                phaseSequence, stage, logicalNonce, threadId, inputRevision, inputDigest,
              }) => store.prepareAppServerPhaseDispatch({
                jobId: job.id,
                attempt: job.attempts,
                epoch: job.controlEpoch,
                phaseSequence,
                stage,
                logicalNonce,
                threadId,
                inputRevision,
                inputDigest,
              }),
              beginPhaseDispatch: ({
                phaseSequence, logicalNonce, threadId, requestId,
                inputRevision, inputDigest,
              }) => store.beginAppServerPhaseDispatch({
                jobId: job.id,
                attempt: job.attempts,
                epoch: job.controlEpoch,
                phaseSequence,
                logicalNonce,
                threadId,
                requestId,
                inputRevision,
                inputDigest,
              }),
              acknowledgePhaseDispatch: ({
                phaseSequence, logicalNonce, threadId, turnId, requestId,
              }) => store.acknowledgeAppServerPhaseDispatch({
                jobId: job.id,
                workerId: job.workerId!,
                attempt: job.attempts,
                epoch: job.controlEpoch,
                phaseSequence,
                logicalNonce,
                threadId,
                turnId,
                requestId,
              }),
              phaseDispatchAmbiguous: (phaseSequence, requestId, error) => (
                store.markAppServerPhaseDispatchAmbiguous({
                  jobId: job.id,
                  attempt: job.attempts,
                  phaseSequence,
                  requestId,
                  error,
                })
              ),
              phaseDispatchRejected: (phaseSequence, requestId, error) => (
                store.markAppServerPhaseDispatchRejected({
                  jobId: job.id,
                  attempt: job.attempts,
                  phaseSequence,
                  requestId,
                  error,
                })
              ),
              sealPhaseResult: ({ logicalNonce, threadId, inputRevision, inputDigest }) => (
                store.sealAppServerPhaseResult({
                  jobId: job.id,
                  epoch: job.controlEpoch,
                  logicalNonce,
                  threadId,
                  inputRevision,
                  inputDigest,
                })
              ),
              beginDispatch: ({
                control, executorNonce, threadId, turnId, requestId,
              }) => {
                if (control.kind === 'interjection') {
                  if (!turnId) throw new Error('interjection pause omitted its active turn')
                  store.beginInterjectionPause({
                    interjectionId: control.id,
                    jobId: job.id,
                    epoch: job.controlEpoch,
                    executorNonce,
                    threadId,
                    turnId,
                    requestId,
                  })
                  return
                }
                store.beginControlDispatch({
                  controlId: control.id,
                  jobId: job.id,
                  epoch: job.controlEpoch,
                  executorNonce,
                  threadId,
                  turnId,
                  requestId,
                })
              },
              acknowledge: (control, requestId, turnId) => {
                if (control.kind === 'interjection') {
                  store.acknowledgeInterjectionPause(control.id, requestId, turnId)
                  return
                }
                store.acknowledgeControl(control.id, requestId, turnId)
              },
              ambiguous: (control, error) => {
                if (control.kind === 'interjection') {
                  store.markInterjectionAmbiguous(control.id, error)
                  return
                }
                store.markControlAmbiguous(control.id, error)
              },
              deferToNextTurn: (
                control, requestId, executorNonce, threadId, turnId, error,
              ) => {
                if (control.kind === 'interjection') {
                  store.deferInterjectionPause({
                    interjectionId: control.id,
                    requestId,
                    executorNonce,
                    threadId,
                    turnId,
                    error,
                  })
                  return
                }
                store.deferControlToNextTurn({
                  controlId: control.id,
                  requestId,
                  executorNonce,
                  threadId,
                  turnId,
                  error,
                })
              },
              finishTurn: ({
                executorNonce, threadId, turnId, retainInput, rateLimitResumeAt,
              }) => store.finishAppServerTurn({
                jobId: job.id,
                epoch: job.controlEpoch,
                executorNonce,
                threadId,
                turnId,
                retainInput,
                rateLimitResumeAt,
              }),
              recordRateLimit: ({ executorNonce, threadId, turnId, resumeAt }) => (
                store.recordAppServerRateLimit({
                  jobId: job.id,
                  epoch: job.controlEpoch,
                  executorNonce,
                  threadId,
                  turnId,
                  resumeAt,
                })
              ),
              prepareInterjectionAnswer: ({ interjection, logicalNonce, threadId }) => (
                store.prepareInterjectionAnswer({
                  interjectionId: interjection.id,
                  jobId: job.id,
                  epoch: job.controlEpoch,
                  logicalNonce,
                  threadId,
                })
              ),
              beginInterjectionAnswer: ({
                interjection, logicalNonce, threadId, requestId,
              }) => store.beginInterjectionAnswer({
                interjectionId: interjection.id,
                jobId: job.id,
                epoch: job.controlEpoch,
                logicalNonce,
                threadId,
                requestId,
              }),
              acknowledgeInterjectionAnswer: ({
                interjection, logicalNonce, threadId, turnId, requestId,
              }) => store.acknowledgeInterjectionAnswer({
                interjectionId: interjection.id,
                jobId: job.id,
                workerId: job.workerId!,
                epoch: job.controlEpoch,
                logicalNonce,
                threadId,
                turnId,
                requestId,
              }),
              rejectInterjectionAnswer: ({
                interjection, logicalNonce, threadId, requestId, error,
              }) => store.rejectInterjectionAnswer({
                interjectionId: interjection.id,
                logicalNonce,
                threadId,
                requestId,
                error,
              }),
              stageInterjectionAnswer: ({
                interjection, logicalNonce, threadId, turnId, disposition, answer,
              }) => store.stageInterjectionAnswer({
                interjectionId: interjection.id,
                jobId: job.id,
                epoch: job.controlEpoch,
                logicalNonce,
                threadId,
                turnId,
                disposition,
                answer,
              }),
              interjectionDelivered: interjection => (
                store.interjectionIsDelivered(interjection.id)
              ),
              promoteInterjection: interjection => (
                store.promoteDeliveredInterjection(interjection.id)
              ),
              cancellationRequested: () => store.get(job.id)?.cancelRequestedAt != null,
            },
            onMonitorMessage: message => mirrorMonitorMessage(message),
            onCommentaryMessage: event => {
              if (executionContext.reportCommentary(event) !== true) {
                throw new Error('Codex commentary could not be staged for Slack delivery')
              }
            },
            onSuccessfulResult: rawExecution => {
              try {
                const finalized = finalizeSuccessfulExecution(
                  store.get(job.id) ?? job,
                  rawExecution,
                  dir,
                  log,
                )
                persistExecutionResultJournal(dir, job, finalized)
                store.ensureExecutionResultStaged(job.id, finalized.sessionId, finalized.result)
                if (guard.failure) {
                  throw new CodexResultPersistencePendingError(
                    `Codex result is durable but its Herdr monitor failed: ${guard.failure.message}`,
                  )
                }
                return finalized
              } catch (error) {
                if (error instanceof CodexResultPersistencePendingError) throw error
                throw new CodexResultPersistencePendingError(
                  `Codex completed but its durable result checkpoint is pending: ${error}`,
                )
              }
            },
          })
          if (guard.failure) {
            throw new CodexResultPersistencePendingError(
              `Codex result is staged but its Herdr monitor failed: ${guard.failure.message}`,
            )
          }
          return execution
        } catch (error) {
          if (guard.failure
            && !(error instanceof CodexCleanupPendingError)
            && !(error instanceof CodexResultPersistencePendingError)) {
            throw guard.failure
          }
          throw error
        } finally {
          guard.executionController = undefined
          signal?.removeEventListener('abort', forwardAbort)
        }
      },
      onLog: log,
    })
    if (monitorFatal) throw monitorFatal
  } finally {
    const interrupted = controller.signal.aborted && !monitorFatal
    clearInterval(maintenanceTimer)
    clearInterval(herdrIdentityTimer)
    const finalHerdrIdentityCheck = herdrIdentityCheck
    if (finalHerdrIdentityCheck) await finalHerdrIdentityCheck
    if (command === 'daemon') process.off('SIGINT', ignoreInterrupt)
    else process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await stopAllMonitorGuards()
    store.close()
    releaseDaemonLock(lockDir, daemonLease)
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
