#!/usr/bin/env -S bun --config=/dev/null --no-env-file
/**
 * Standalone Slack gateway for Codex.
 *
 * Self-contained gateway with DM pairing, membership-based channel access,
 * durable FIFO hand-off, and thread catch-up. Installations use
 * ~/.codex/zerokun/ unless ZEROKUN_STATE_DIR explicitly selects another state.
 */

import { App } from '@slack/bolt'
import { createHash, randomBytes } from 'crypto'
import {
  closeSync, constants, existsSync, openSync, writeFileSync,
  mkdirSync, readdirSync, rmSync, statSync, renameSync, realpathSync,
} from 'fs'
import { join, extname } from 'path'
import {
  decideChannelPolicy, isBotDMBlocked, threadPollCursor, planThreadPoll,
  planDirectMessageThreadPoll,
  classifyThreadReply, canUseActiveThreadAuthority, resolveIsMention,
  pruneDeliveredKeys, planCatchupSweep, msToSlackTs,
  effectiveDmAllowFrom, isExplicitUpdateRequest, catchupThreadParents,
  slackThreadKey, slackTsToMs,
  singleFlightAsync,
  roundRobinAfter,
  isInvalidSlackCursor,
  advanceReadCursor,
  retreatReadCursor,
  isTerminalSlackHistoryError,
  isSlackBotAuthored,
  slackReplyScanFailureDisposition,
  validateLegacyThreadMap,
  SLACK_USER_ID_RE,
} from './gate.ts'
import { requestUpdate, resumePendingUpdateWorker } from './zerokun/update-request.ts'
import { acquirePluginLock as claimPluginLock } from './plugin-lock.ts'
import {
  JobStore,
  SlackChannelRouteRequiredError,
  liveControlAcceptsInput,
  updateIsRunning,
  updateTransactionPending,
  type InboundDeliveryInput,
  type InboundDeliveryRecord,
  type LiveControlTarget,
} from './zerokun/job-runner.ts'
import { requireLegacyThreadRepoRoute } from './zerokun/routing.ts'
import { resolveZeroJobDatabasePath, resolveZeroStateDir } from './zerokun/state-dir.ts'
import {
  slackHttpTimeoutMs,
  slackWebClientOptions,
  openDirectSlackDownload,
  withSlackDeadline,
} from './zerokun/slack-http.ts'
import {
  clearGatewayReadiness,
  writeGatewayReadiness,
} from './zerokun/readiness.ts'
import { writeLastConnectedProject } from './zerokun/project-selection.ts'
import {
  ensureManagedDirectory,
  requireManagedStateRoot,
} from './zerokun/managed-path.ts'
import {
  AccessLockReleaseError,
  mutateAccess,
  readAccess,
  rememberChannel,
  type AccessConfig,
} from './zerokun/access.ts'
import { readOptionalPrivateFile } from './zerokun/safe-file.ts'
import {
  applyStateEnvironment,
  takeSlackTokensFromEnvironment,
} from './zerokun/child-environment.ts'
import { verifySlackAppTokenPair } from './zerokun/slack-app-identity.ts'
import {
  copyLiveControlAttachments,
  isSlackInterruptCommand,
  normalizeSlackInboundText,
  stripSlackUserMention,
} from './zerokun/live-control.ts'
import {
  loadCachedInboundAttachment,
  removeRenamedInboundAttachment,
  verifyInboundDownloadBeforeRename,
  writeAllSync,
  type InboundAttachmentIdentity,
} from './zerokun/inbound-attachment-cache.ts'

const STATE_DIR = resolveZeroStateDir()
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const LOCK_FILE = join(STATE_DIR, 'plugin.lock')
const THREADS_FILE = join(STATE_DIR, 'threads.json')
const UPDATE_JOURNAL_FILE = join(STATE_DIR, 'update-transaction.json')
const UPDATE_LOCK_DIR = join(STATE_DIR, 'update.lock')
const UPDATE_REQUEST_FILE = process.env.ZEROKUN_UPDATE_REQUEST ?? join(STATE_DIR, 'update-request.ts')
const READY_FILE = join(STATE_DIR, 'gateway-ready.json')

// Thread catch-up poller cadence and reach. Only threads whose dispatcher
// last_activity is within the active window are polled, to bound cost — the
// poll itself never invokes Codex; it only re-reads Slack history and enqueues
// genuinely new replies.
const THREAD_POLL_INTERVAL_MS = 60_000
const CATCHUP_SWEEP_INTERVAL_MS = 5 * 60_000
const UPDATE_RECOVERY_INTERVAL_MS = 5 * 60_000
const THREAD_ACTIVE_WINDOW_MS = 48 * 60 * 60 * 1000

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

type BudgetedSlackMethod = 'history' | 'replies' | 'list'
type SlackBudgetLane = 'catchup' | 'owned'
const SLACK_METHOD_BUDGETS: Record<BudgetedSlackMethod, number> = {
  history: 40,
  replies: 40,
  list: 10,
}
const slackMethodUsage = new Map<string, { windowStartedAt: number; used: number }>()

class SlackMethodBudgetExhausted extends Error {}

function takeSlackMethodBudget(method: BudgetedSlackMethod, lane: SlackBudgetLane = 'catchup'): void {
  const now = Date.now()
  // Replies are split into two reservations so active owned threads cannot
  // consume every token before offline catch-up (or vice versa).
  const budget = method === 'replies' ? Math.floor(SLACK_METHOD_BUDGETS.replies / 2) : SLACK_METHOD_BUDGETS[method]
  const key = method === 'replies' ? `${method}:${lane}` : method
  const current = slackMethodUsage.get(key)
  const usage = !current || now - current.windowStartedAt >= 60_000
    ? { windowStartedAt: now, used: 0 }
    : current
  if (usage.used >= budget) {
    throw new SlackMethodBudgetExhausted(`Slack ${method}/${lane} method budget exhausted`)
  }
  usage.used += 1
  slackMethodUsage.set(key, usage)
}

function isSlackBudgetError(error: unknown): boolean {
  if (error instanceof SlackMethodBudgetExhausted) return true
  const message = error instanceof Error ? error.message : String(error)
  return /rate[_ -]?limit|HTTP 429|status.?429/i.test(message)
}

function schedulerCursor(key: string): string | null {
  return jobStore.readSlackReadCursor('scheduler', key)?.cursor ?? null
}

function advanceSchedulerCursor(key: string, cursor: string | null, complete = false): void {
  jobStore.commitSlackReadCursorIfDurable('scheduler', key, cursor, complete, [])
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback
}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
requireManagedStateRoot(STATE_DIR)
ensureManagedDirectory(STATE_DIR, INBOX_DIR)

// The selected state's Slack tokens are authoritative; stale shell/tmux tokens
// must not reconnect this machine to another Zero-kun Slack App.
try {
  applyStateEnvironment(readOptionalPrivateFile(ENV_FILE) ?? '')
} catch (error) {
  process.stderr.write(`slack channel: unsafe or unreadable ${ENV_FILE}: ${error}\n`)
  process.exit(1)
}

const slackTokens = takeSlackTokensFromEnvironment()
const BOT_TOKEN = slackTokens.SLACK_BOT_TOKEN ?? ''
const APP_TOKEN = slackTokens.SLACK_APP_TOKEN ?? ''

if (!BOT_TOKEN || !APP_TOKEN) {
  process.stderr.write(
    `slack channel: SLACK_BOT_TOKEN and SLACK_APP_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format:\n` +
    `    SLACK_BOT_TOKEN=xoxb-...\n` +
    `    SLACK_APP_TOKEN=xapp-...\n`,
  )
  process.exit(1)
}

// Singleton lock — Slack Socket Mode delivers each event to exactly one
// connected consumer. Running multiple plugin processes against the same bot
// token splits inbound events randomly across them, causing missed messages in
// every consumer but one. The lock at STATE_DIR/plugin.lock ensures only one
// live process binds to Slack at a time.
function acquirePluginLock(): void {
  try {
    const result = claimPluginLock(LOCK_FILE, STATE_DIR)
    if (result.acquired === false) {
      const owner = result.kind === 'held'
        ? `another instance (PID ${result.heldPid})`
        : 'a lock with an unreadable owner'
      process.stderr.write(
        `slack channel: ${owner} already holds ${LOCK_FILE}\n` +
        `  this instance (PID ${process.pid}) will exit — Socket Mode is single-consumer,\n` +
        `  and running multiple plugin processes causes event fanout + missed messages.\n`,
      )
      process.exit(0)
    }
    if (result.reclaimedPid !== undefined) {
      process.stderr.write(`slack channel: stale lock from PID ${result.reclaimedPid}, reclaiming\n`)
    }
  } catch (err) {
    process.stderr.write(`slack channel: failed to write lock ${LOCK_FILE}: ${err}\n`)
    process.exit(1)
  }
}

acquirePluginLock()
clearGatewayReadiness(READY_FILE)

// The gateway owns inbound durability. The runner opens the same WAL database
// from another process and claims Codex jobs one at a time.
const jobStore = new JobStore(resolveZeroJobDatabasePath(STATE_DIR))
const recoveredInbound = jobStore.recoverInboundDeliveries()
if (recoveredInbound > 0) {
  process.stderr.write(`slack channel: recovered ${recoveredInbound} interrupted inbound delivery(s)\n`)
}

type Access = AccessConfig

function loadAccess(): Access {
  return readAccess(ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

function safeName(name: string): string {
  return name.replace(/[\[\]\r\n;<>]/g, '_')
}

// ── Task 3: Access Control Gate ──────────────────────────────────────────────

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

async function gate(
  senderId: string,
  channelId: string,
  channelType: string,
  isMention: boolean,
  isBot: boolean = false,
  activeThreadAuthority = false,
): Promise<GateResult> {
  const isDM = channelType === 'im'
  if (isBot || !SLACK_USER_ID_RE.test(senderId)) return { action: 'drop' }
  if (!isDM) {
    const access = loadAccess()
    const decision = decideChannelPolicy(
      access.channels[channelId], senderId, isMention, isBot, activeThreadAuthority,
    )
    if (decision === 'drop') return { action: 'drop' }
    try {
      rememberChannel(channelId, ACCESS_FILE)
      return { action: 'deliver', access: loadAccess() }
    } catch (error) {
      if (error instanceof AccessLockReleaseError) {
        process.stderr.write(`slack channel: fatal access lock release failure: ${error.message}\n`)
        shutdown()
      }
      throw error
    }
  }
  try {
    return mutateAccess((access): GateResult => {
      pruneExpired(access)

      if (access.dmPolicy === 'disabled') return { action: 'drop' }
      if (isBotDMBlocked('im', isBot)) return { action: 'drop' }

      if (activeThreadAuthority && !isBot) {
        return { action: 'deliver', access }
      }
      if (effectiveDmAllowFrom(access).includes(senderId)) {
        return { action: 'deliver', access }
      }
      if (access.dmPolicy === 'allowlist') return { action: 'drop' }

      for (const [code, pending] of Object.entries(access.pending)) {
        if (pending.senderId !== senderId) continue
        if ((pending.replies ?? 1) >= 2) return { action: 'drop' }
        pending.replies = (pending.replies ?? 1) + 1
        return { action: 'pair', code, isResend: true }
      }
      if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

      const code = randomBytes(3).toString('hex')
      const now = Date.now()
      access.pending[code] = {
        senderId,
        chatId: channelId,
        createdAt: now,
        expiresAt: now + 60 * 60 * 1000,
        replies: 1,
      }
      return { action: 'pair', code, isResend: false }
    }, ACCESS_FILE)
  } catch (error) {
    if (error instanceof AccessLockReleaseError) {
      process.stderr.write(`slack channel: fatal access lock release failure: ${error.message}\n`)
      shutdown()
    }
    throw error
  }
}

let slackApp: InstanceType<typeof App> | null = null

function activeThreadAuthorityTarget(
  channelId: string,
  threadTs: string | undefined,
  text: string,
  isDM: boolean,
  isBot: boolean,
): LiveControlTarget | null {
  if (!threadTs) return null
  const normalized = normalizeSlackInboundText(text, botUserId, isDM)
  const interrupt = isSlackInterruptCommand(normalized)
  const liveTarget = jobStore.liveControlTarget(channelId, threadTs)
  const interruptTarget = interrupt
    ? jobStore.interruptControlTarget(channelId, threadTs)
    : null
  const authorized = canUseActiveThreadAuthority({
    isBot,
    isDM,
    text,
    botUserId,
    hasLiveTarget: liveTarget !== null,
    hasInterruptTarget: interruptTarget !== null,
    isInterrupt: interrupt,
  })
  if (!authorized) return null
  return interrupt ? (interruptTarget ?? liveTarget) : liveTarget
}

async function acknowledgeSlackDelivery(
  channel: string,
  timestamp: string,
  access: Pick<AccessConfig, 'ackReaction'>,
): Promise<void> {
  const reaction = access.ackReaction ?? 'eyes'
  if (!reaction || !slackApp) return
  try {
    await slackApp.client.reactions.add({ channel, name: reaction, timestamp })
  } catch {}
}

function checkApprovals(): void {
  if (!slackApp) return
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch { return }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    let dmChannelId: string
    try {
      dmChannelId = (readOptionalPrivateFile(file) ?? '').trim()
    } catch {
      rmSync(file, { force: true })
      continue
    }
    if (!dmChannelId) {
      rmSync(file, { force: true })
      continue
    }

    void (async () => {
      try {
        await slackApp!.client.chat.postMessage({
          channel: dmChannelId,
          text: "ペアリングが完了しました。Zeroちゃんに話しかけてください。リポジトリへの書込みは、管理者が明示的に許可するまで無効です。",
        })
        rmSync(file, { force: true })
      } catch (err) {
        process.stderr.write(`slack channel: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      }
    })()
  }
}

// ── Slack App Connection and Inbound Events ──────────────────────────────────

// This process is the long-lived Slack parent and writes every authorized
// event to SQLite. Codex runs only as a short-lived child of the queue worker.

// Initialize Slack Bolt app with Socket Mode
slackApp = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  socketMode: true,
  clientOptions: slackWebClientOptions(),
})

let botUserId: string | undefined
let slackAppId: string | undefined

class SlackProjectUnavailableError extends Error {
  constructor(readonly chatId: string) {
    super(`Slack project is unavailable for ${chatId}`)
    this.name = 'SlackProjectUnavailableError'
  }
}

// Dedup of delivered messages, keyed by `${chatId}:${messageTs}`. A single
// Slack message can reach us more than once: an @mention fires BOTH
// `app_mention` and `message`, and the thread catch-up poller re-reads pages
// that include replies the live path already delivered. Slack's message ts is
// stable across all of these, so collapsing on it enqueues each message once.
//
// This set is deliberately process-local. Durable idempotency belongs to the
// SQLite inbound/jobs/update ledgers; trusting an independently-persisted JSON
// skip list after reboot could lose an event if a power failure preserved that
// file but not a synchronous=NORMAL WAL commit. After restart catch-up may
// re-stage a message, and SQLite safely collapses it to the existing hand-off.
// `inFlight` remains separate so concurrent Socket/catch-up paths join the same
// still-running promise instead of starting duplicate external work.
const DELIVERED_KEY_LIMIT = 1000
const delivered = new Set<string>()
const inFlight = new Map<string, Promise<boolean>>()

function rememberDelivered(key: string): void {
  delivered.add(key)
  if (delivered.size > DELIVERED_KEY_LIMIT) {
    const kept = pruneDeliveredKeys(delivered, DELIVERED_KEY_LIMIT)
    delivered.clear()
    for (const k of kept) delivered.add(k)
  }
}

function resolveRepoPath(chatId: string, threadTs: string, adoptedFromTs: string): string {
  if (!slackAppId) throw new Error('Slack app identity is unavailable')
  const pinned = jobStore.resolveOrAdoptSlackThreadRoute({
    appId: slackAppId,
    chatId,
    threadTs,
    defaultRepoPath: process.cwd(),
    adoptedFromTs,
  })
  try {
    const repoPath = realpathSync(pinned.repoPath)
    if (!statSync(repoPath).isDirectory()) throw new Error('not a directory')
    return repoPath
  } catch {
    throw new SlackProjectUnavailableError(chatId)
  }
}

async function downloadInboundFiles(
  inbound: InboundDeliveryRecord,
  parentSignal?: AbortSignal,
): Promise<string[]> {
  const { fileIds, messageId: messageTs } = inbound
  if (!/^\d+\.\d+$/.test(messageTs)) throw new Error(`invalid Slack message ts: ${messageTs}`)
  const paths: string[] = []
  for (let ordinal = 0; ordinal < fileIds.length; ordinal += 1) {
    const fileId = fileIds[ordinal]!
    if (!/^F[A-Z0-9]+$/.test(fileId)) throw new Error(`invalid Slack file id: ${fileId}`)
    const manifest = inbound.downloadedFiles.find(file => (
      file.fileId === fileId && file.ordinal === ordinal
    ))
    const cached = loadCachedInboundAttachment({
      inboxDir: INBOX_DIR,
      messageTs,
      fileId,
      ordinal,
      ...(manifest ? { manifest } : {}),
    })
    if (cached) {
      if (!manifest) jobStore.recordInboundDownloadedFile(inbound.idempotencyKey, cached)
      paths.push(cached.path)
      continue
    }
    const localPath = await withSlackDeadline(async signal => {
      if (signal.aborted) throw new Error(`Slack attachment ${fileId} aborted`)
      const info = await slackApp!.client.files.info({ file: fileId })
      if (signal.aborted) throw new Error(`Slack attachment ${fileId} aborted`)
      const file = info.file
      if (!file?.url_private_download) throw new Error(`file ${fileId} is not downloadable`)
      const expectedSize = file.size
      if (expectedSize !== undefined
        && (!Number.isSafeInteger(expectedSize) || expectedSize < 0
          || expectedSize > MAX_ATTACHMENT_BYTES)) {
        throw new Error(`file ${fileId} is larger than 50MB`)
      }
      const response = await openDirectSlackDownload(file.url_private_download, BOT_TOKEN, signal)
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        throw new Error(`file ${fileId} download failed: HTTP ${response.statusCode ?? 'unknown'}`)
      }
      const name = safeName(file.name ?? fileId)
      const extension = extname(name) || '.bin'
      const directory = join(INBOX_DIR, messageTs.replace(/[^0-9.]/g, '_'))
      ensureManagedDirectory(STATE_DIR, directory)
      const destination = join(directory, `${fileId}${extension}`)
      const temporary = `${destination}.partial-${process.pid}-${randomBytes(6).toString('hex')}`
      const descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      )
      let received = 0
      const digest = createHash('sha256')
      let descriptorOpen = true
      let renamedIdentity: InboundAttachmentIdentity | undefined
      let renamed = false
      try {
        for await (const value of response) {
          const chunk = typeof value === 'string' ? Buffer.from(value) : value
          received += chunk.byteLength
          if (received > MAX_ATTACHMENT_BYTES) {
            response.destroy()
            throw new Error(`file ${fileId} is larger than 50MB`)
          }
          digest.update(chunk)
          writeAllSync(descriptor, chunk)
        }
        renamedIdentity = verifyInboundDownloadBeforeRename(
          descriptor,
          received,
          expectedSize,
        )
        closeSync(descriptor)
        descriptorOpen = false
        renameSync(temporary, destination)
        renamed = true
        const completed = loadCachedInboundAttachment({
          inboxDir: INBOX_DIR,
          messageTs,
          fileId,
          ordinal,
        })
        if (!completed || completed.size !== received
          || completed.digest !== digest.digest('hex')) {
          throw new Error(`file ${fileId} failed its completed-download verification`)
        }
        jobStore.recordInboundDownloadedFile(inbound.idempotencyKey, completed)
      } catch (error) {
        if (descriptorOpen) {
          try { closeSync(descriptor) } catch {}
        }
        if (renamed && renamedIdentity) {
          removeRenamedInboundAttachment(destination, renamedIdentity)
        } else {
          rmSync(temporary, { force: true })
        }
        throw error
      }
      return destination
    }, slackHttpTimeoutMs(), `Slack attachment ${fileId}`, parentSignal)
    paths.push(localPath)
  }
  return paths
}

async function enqueueUpdate(
  chatId: string,
  threadTs: string,
  messageTs: string,
  userId: string,
): Promise<void> {
  await requestUpdate(
    { chatId, threadTs, messageId: messageTs, userId },
    {
      stateDir: STATE_DIR,
      workerFile: UPDATE_REQUEST_FILE,
      // A self-update must preserve the shared gateway's bootstrap/default
      // project. The Slack thread's project remains pinned independently in
      // SQLite and must not become the new DM/default destination.
      projectDir: process.cwd(),
      onAccepted: async _request => {
        await slackApp!.client.chat.postMessage({
          channel: chatId,
          thread_ts: threadTs,
          text: '🔄 Zeroちゃんの更新を受け付けました。現在の処理が終わり次第更新し、このスレッドへ結果を通知します。',
        })
      },
      onDuplicate: async _request => {
        await slackApp!.client.chat.postMessage({
          channel: chatId,
          thread_ts: threadTs,
          text: '🔄 Zeroちゃんの更新はすでに待機中または実行中です。',
        })
      },
    },
  )
}

const INBOUND_RETRY_MS = 30_000
const INBOUND_MAX_ATTEMPTS = positiveInteger(process.env.ZEROKUN_INBOUND_MAX_ATTEMPTS, 5)
let inboundDrainActive = false
let inboundRetryTimer: ReturnType<typeof setTimeout> | undefined
type ActiveInboundDownload = {
  inbound: InboundDeliveryRecord
  controller: AbortController
  preempted: boolean
}
let activeInboundDownload: ActiveInboundDownload | null = null

function preemptInboundDownloadForLiveControl(input: InboundDeliveryInput): void {
  const active = activeInboundDownload
  if (!active || active.preempted) return
  const sameThread = active.inbound.chatId === input.chatId
    && active.inbound.threadTs === input.threadTs
  // Ordinary same-thread replies retain FIFO order. An exact interrupt may
  // overtake them; any live control may overtake an unrelated attachment job.
  if (!input.isInterrupt && sameThread) return
  active.preempted = true
  active.controller.abort()
}

function scheduleInboundDrain(delayMs = 0): void {
  if (inboundDrainActive && delayMs === 0) return
  if (inboundRetryTimer) clearTimeout(inboundRetryTimer)
  inboundRetryTimer = setTimeout(() => {
    inboundRetryTimer = undefined
    void drainInboundDeliveries().catch(error => {
      process.stderr.write(`slack channel: inbound drain crashed: ${error}\n`)
      try {
        const recovered = jobStore.recoverInboundDeliveries()
        process.stderr.write(`slack channel: recovered ${recovered} stuck inbound delivery(s)\n`)
      } catch (recoveryError) {
        process.stderr.write(`slack channel: inbound recovery failed: ${recoveryError}\n`)
      }
      scheduleInboundDrain(INBOUND_RETRY_MS)
    })
  }, delayMs)
  inboundRetryTimer.unref()
}

async function drainInboundDeliveries(): Promise<void> {
  if (inboundDrainActive) return
  inboundDrainActive = true
  try {
    while (!shuttingDown) {
      const inbound = jobStore.claimNextInboundDelivery()
      if (!inbound) return
      let download: ActiveInboundDownload | null = null
      try {
        const interrupt = inbound.isInterrupt
        let attachments: string[] = []
        if (!interrupt) {
          download = { inbound, controller: new AbortController(), preempted: false }
          activeInboundDownload = download
          try {
            attachments = await downloadInboundFiles(
              inbound,
              download.controller.signal,
            )
          } finally {
            if (activeInboundDownload === download) activeInboundDownload = null
          }
        }
        // Keep the durable task as the Slack-authored text only. Attachment
        // paths already have their own authoritative column and are rendered
        // into the Codex transcript by the host; mixing them into `task`
        // makes host paths indistinguishable from user-authored text later.
        const taskFor = () => inbound.text.trim() || '(添付ファイルを確認してください)'
        const task = taskFor()
        const target = inbound.expectedControlJobId !== null
          && inbound.expectedControlEpoch !== null
          ? {
              jobId: inbound.expectedControlJobId,
              epoch: inbound.expectedControlEpoch,
              repoPath: inbound.repoPath,
              writeEnabled: inbound.writeEnabled,
            }
          : interrupt
            ? jobStore.interruptControlTarget(inbound.chatId, inbound.threadTs)
            : jobStore.liveControlTarget(inbound.chatId, inbound.threadTs)
        if (target && liveControlAcceptsInput(target, {
          repoPath: inbound.repoPath,
          writeEnabled: inbound.writeEnabled,
          interrupt,
        })) {
          const controlAttachments = interrupt || attachments.length === 0
            ? []
            : copyLiveControlAttachments({
              stateDir: STATE_DIR,
              jobId: target.jobId,
              messageId: inbound.messageId,
              attachments,
            })
          const staged = jobStore.stageLiveControl(target, {
            chatId: inbound.chatId,
            threadTs: inbound.threadTs,
            messageId: inbound.messageId,
            userId: inbound.userId,
            writeEnabled: inbound.writeEnabled,
            task: interrupt ? '中止' : taskFor(),
            attachments: controlAttachments,
            kind: interrupt ? 'interrupt' : 'steer',
            notifyAccepted: interrupt,
          })
          if (staged !== 'closed') {
            jobStore.completeInboundDelivery(inbound.idempotencyKey)
            continue
          }
        }
        // A crash after staging an interrupt closes its target epoch before
        // the inbound row is deleted. On recovery, do not reinterpret that
        // already-durable control as an inactive cancellation or a new FIFO job.
        if (jobStore.hasJobControl(inbound.idempotencyKey)) {
          jobStore.completeInboundDelivery(inbound.idempotencyKey)
          continue
        }
        // A reply admitted through active-thread authority belongs only to the
        // exact job/epoch persisted with it. Never reinterpret it as a sibling
        // FIFO job after cancellation or another terminal race.
        if (inbound.expectedControlJobId !== null) {
          jobStore.tombstoneInboundDelivery(inbound.idempotencyKey, {
            kind: 'closed-control',
            payload: 'この返信を反映する前に現在の処理が終了しました。必要なら新しい依頼として送ってください。',
          })
          continue
        }
        // Exact cancellation is a host command, never an ordinary task. If
        // the accepting epoch closed between lookup and staging (or no job is
        // active), consume it as a deterministic no-op instead of enqueueing
        // a new Codex job whose task text happens to be "中止".
        if (isSlackInterruptCommand(inbound.text)) {
          jobStore.tombstoneInboundDelivery(inbound.idempotencyKey, {
            kind: 'inactive-interrupt',
            payload: '現在このスレッドで実行中のタスクはありません。',
          })
          continue
        }
        jobStore.enqueue({
          chatId: inbound.chatId,
          threadTs: inbound.threadTs,
          messageId: inbound.messageId,
          userId: inbound.userId,
          repoPath: inbound.repoPath,
          task,
          attachments,
          writeEnabled: inbound.writeEnabled,
          notifyAccepted: true,
        })
        jobStore.completeInboundDelivery(inbound.idempotencyKey)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (download?.preempted) {
          if (!jobStore.releaseInboundDelivery(inbound.idempotencyKey)) {
            throw new Error(`preempted inbound delivery lost its processing lease: ${inbound.idempotencyKey}`)
          }
          continue
        }
        if (inbound.attempts + 1 >= INBOUND_MAX_ATTEMPTS) {
          if (inbound.expectedControlJobId !== null) {
            jobStore.tombstoneInboundDelivery(inbound.idempotencyKey, {
              kind: 'attachment-control-failed',
              payload: '添付ファイルを取得できなかったため、この返信は現在の処理へ反映できませんでした。もう一度送ってください。',
            })
            process.stderr.write(
              `slack channel: live-control inbound ${inbound.idempotencyKey} abandoned after attachment retries\n`,
            )
            continue
          }
          jobStore.failInboundDelivery(
            inbound.idempotencyKey,
            `Slack添付の取得を${INBOUND_MAX_ATTEMPTS}回試みましたが失敗しました: ${message}`,
          )
          process.stderr.write(
            `slack channel: inbound ${inbound.idempotencyKey} moved to dead-letter: ${message}\n`,
          )
          continue
        }
        jobStore.deferInboundDelivery(inbound.idempotencyKey, message, Date.now() + INBOUND_RETRY_MS)
        process.stderr.write(
          `slack channel: inbound ${inbound.idempotencyKey} deferred: ${message}\n`,
        )
        scheduleInboundDrain(INBOUND_RETRY_MS)
        return
      }
    }
  } finally {
    inboundDrainActive = false
  }
}

/**
 * Makes one authorized Slack event durable in SQLite. The memory-only cache is
 * updated after that commit, so a crash can cause a harmless retry but can
 * never permanently suppress a request after its durable row was lost.
 */
function deliver(
  chatId: string,
  messageTs: string,
  userId: string,
  text: string,
  threadTs?: string,
  fileIds?: string[],
  authority?: { target: LiveControlTarget },
): Promise<boolean> {
  // During self-update the candidate gateway must connect for readiness, but
  // its database can still be rolled back to the pre-update snapshot. Do not
  // commit an event (or its external delivered marker) until the journal is
  // cleared. The periodic catch-up sweep will recover it afterward.
  if (updateTransactionPending(UPDATE_JOURNAL_FILE)) return Promise.resolve(false)
  const key = `${chatId}:${messageTs}`
  if (delivered.has(key)) return Promise.resolve(true)
  const pending = inFlight.get(key)
  if (pending) return pending
  const resolvedThreadTs = threadTs ?? messageTs
  const handOver = (async () => {
    const access = loadAccess()
    const writeEnabled = access.writeAllowFrom.includes(userId)
    // Pin before detached update or attachment I/O so a concurrent zerochan
    // project switch cannot split one Slack thread across repositories.
    const repoPath = resolveRepoPath(chatId, resolvedThreadTs, messageTs)
    if (writeEnabled && isExplicitUpdateRequest(text)) {
      if (!jobStore.hasUpdateRequest(key)) {
        // The request file is the recoverable pre-launch state. Record the
        // permanent SQLite tombstone only after requestUpdate has persisted it
        // and launched (or recovered) the detached worker.
        await enqueueUpdate(chatId, resolvedThreadTs, messageTs, userId)
        jobStore.reserveUpdateRequest(key)
      }
    } else {
      // Persist Slack metadata before any file/network I/O. The single inbound
      // drain preserves arrival order and retries the head item after failures.
      const inbound: InboundDeliveryInput = {
        chatId,
        threadTs: resolvedThreadTs,
        messageId: messageTs,
        userId,
        repoPath,
        text,
        fileIds,
        writeEnabled,
        isInterrupt: isSlackInterruptCommand(text),
      }
      const staged = authority
          ? jobStore.stageInboundDeliveryForControl(
            inbound,
            authority.target,
          )
        : jobStore.stageInboundDelivery(inbound) ? 'staged' : 'duplicate'
      if (staged === 'authority-closed') {
        await slackApp!.client.chat.postMessage({
          channel: chatId,
          thread_ts: resolvedThreadTs,
          text: '返信を受け付けた時点の処理はすでに終了していました。必要なら新しい依頼として送ってください。',
        }).catch(err => {
          process.stderr.write(`slack channel: expired thread authority notice failed for ${key}: ${err}\n`)
        })
      } else {
        if (staged === 'bound') preemptInboundDownloadForLiveControl(inbound)
        scheduleInboundDrain()
      }
    }
    rememberDelivered(key)
    return true
  })().catch(async err => {
    if (err instanceof SlackChannelRouteRequiredError
      || err instanceof SlackProjectUnavailableError) {
      try {
        await slackApp!.client.chat.postMessage({
          channel: chatId,
          thread_ts: resolvedThreadTs,
          text: err instanceof SlackChannelRouteRequiredError
            ? `🔗 このチャンネルはプロジェクト未設定です。対象projectで \`zerochan set slack-channel ${err.channelId}\` を実行してください。`
            : '📁 このスレッドのprojectが見つかりません。PC側でprojectを復旧し、もう一度メッセージを送ってください。',
        })
        jobStore.recordDeliveryTombstone(key)
        rememberDelivered(key)
        // The event is durably handled, but no task was accepted. Returning
        // false suppresses the eyes acknowledgement; catch-up observes the
        // tombstone on its next bounded sweep and advances without reposting.
        return false
      } catch (noticeError) {
        process.stderr.write(
          `slack channel: failed to report missing route for ${key}: ${noticeError}\n`,
        )
        return false
      }
    }
    process.stderr.write(`slack channel: failed to persist ${key} for Codex: ${err}\n`)
    return false
  }).finally(() => inFlight.delete(key))

  inFlight.set(key, handOver)
  return handOver
}

// Handle @mentions in channels
slackApp.event('app_mention', async ({ event }) => {
  if (updateTransactionPending(UPDATE_JOURNAL_FILE)) return
  // Symmetric with the message handler: bot posts that @mention this app are
  // rejected by the same membership-based gate instead of gaining an implicit
  // automation-to-automation control path.
  const ev = event as any
  const isBot = isSlackBotAuthored(ev)
  const senderId: string | undefined = isBot ? ev.bot_id : ev.user
  if (!senderId) return
  const channelId = event.channel
  const threadTs = event.thread_ts || event.ts
  const text = stripSlackUserMention(event.text, botUserId).trim()
  const threadAuthorityTarget = activeThreadAuthorityTarget(
    channelId, event.thread_ts, event.text, false, isBot,
  )

  const result = await gate(
    senderId, channelId, 'channel', true, isBot, threadAuthorityTarget !== null,
  )
  if (result.action === 'drop') return
  if (result.action === 'pair') return

  const fileIds = ((event as any).files ?? []).map((f: any) => f.id)
  const handedOver = await deliver(
    channelId, event.ts, senderId, text, threadTs,
    fileIds.length > 0 ? fileIds : undefined,
    threadAuthorityTarget
      ? { target: threadAuthorityTarget }
      : undefined,
  )
  if (!handedOver) return
  await acknowledgeSlackDelivery(channelId, event.ts, result.access)
})

// Handle DMs and thread replies
slackApp.event('message', async ({ event }) => {
  if (updateTransactionPending(UPDATE_JOURNAL_FILE)) return
  const msg = event as any
  // Slack distinguishes bot posts in two ways depending on app age:
  //   1. Modern apps (granular permissions) post with NO subtype, but
  //      bot_id and bot_profile are populated.
  //   2. Legacy / incoming-webhook integrations post with
  //      subtype === 'bot_message' and bot_id populated.
  // We accept both paths and drop every other subtype (channel_join,
  // message_changed, thread_broadcast, etc.) — the existing
  // upstream behaviour for non-bot-message subtypes.
  //
  // EXCEPTION: 'file_share' must pass. When a user uploads a file/image,
  // Slack may deliver it either as a plain message with a `files` array and
  // NO subtype (modern previewable images — already handled) OR as a message
  // with subtype === 'file_share' (e.g. binary/RAW files Slack can't preview,
  // like camera RAW). Blanket-dropping file_share meant image/file uploads
  // silently never reached the worker ("画像のとき発火しない"). The downstream
  // code already extracts msg.files and forwards file_ids, so letting
  // file_share through is sufficient.
  const isBot = isSlackBotAuthored(msg)
  if (msg.subtype && msg.subtype !== 'bot_message' && msg.subtype !== 'file_share') return
  if (msg.user === botUserId) return

  // For bots, identify by bot_id (B-prefix) since msg.user may be unset on
  // classic incoming-webhook posts. The gate rejects every bot sender.
  const senderId = isBot ? (msg.bot_id as string) : (msg.user as string)
  if (!senderId) return
  const channelId = msg.channel as string
  const channelType = msg.channel_type as string
  const threadTs = msg.thread_ts

  const isDM = channelType === 'im'
  const text = msg.text as string ?? ''
  const normalizedText = normalizeSlackInboundText(text, botUserId, isDM)
  // A DM needs no mention — the DM *is* the address. In a channel the mention
  // has to be real for a new root message. Once Zeroちゃん owns a thread, its
  // human replies are live input and must not wait for the 60-second
  // catch-up poller; exact cancellation in particular cannot survive that lag.
  const ownedThread = typeof threadTs === 'string'
    && jobStore.getThread(channelId, threadTs) !== null
  if (ownedThread && !isDM
    && (loadAccess().channels[channelId]?.requireMention ?? true)
    && classifyThreadReply(text, botUserId) === 'others') return
  const isMention = resolveIsMention(isDM, text, botUserId) || ownedThread
  const threadAuthorityTarget = activeThreadAuthorityTarget(
    channelId, typeof threadTs === 'string' ? threadTs : undefined, text, isDM, isBot,
  )

  const result = await gate(
    senderId,
    channelId,
    isDM ? 'im' : 'channel',
    isMention,
    isBot,
    threadAuthorityTarget !== null,
  )

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend
      ? 'Zeroちゃんとのペアリング待ちです'
      : 'Zeroちゃんとのペアリングが必要です'
    try {
      await slackApp!.client.chat.postMessage({
        channel: channelId,
        text: `${lead}。ターミナルで次を実行してください。\n\n\`zerochan-access pair ${result.code}\``,
      })
    } catch (err) {
      process.stderr.write(`slack channel: failed to send pairing code: ${err}\n`)
    }
    return
  }

  const fileIds = (msg.files ?? []).map((f: any) => f.id)
  const handedOver = await deliver(
    channelId,
    msg.ts,
    senderId,
    normalizedText,
    threadTs || msg.ts,
    fileIds.length > 0 ? fileIds : undefined,
    threadAuthorityTarget
      ? { target: threadAuthorityTarget }
      : undefined,
  )
  if (!handedOver) return
  await acknowledgeSlackDelivery(channelId, msg.ts, result.access)
})

// Channel membership is the host-side access grant. Record it for restart
// catch-up, then explain the only remaining interaction rule: mention the bot
// for a new root.
slackApp.event('member_joined_channel', async ({ event }) => {
  if (event.user !== botUserId) return

  const channelId = event.channel
  try {
    const firstObservation = rememberChannel(channelId, ACCESS_FILE)
    if (!firstObservation) return
    const routeReady = slackAppId
      && (jobStore.resolveSlackChannelRoute(slackAppId, channelId) !== null
        || !jobStore.slackChannelRoutingIsExplicit(slackAppId))
    await slackApp!.client.chat.postMessage({
      channel: channelId,
      text: routeReady
        ? [
          `:wave: *Zeroちゃん*です。このチャンネルから利用できます。`,
          ``,
          `新しい依頼は \`@Zeroちゃん\` とメンションしてください。`,
          `同じスレッドの続きは、再メンションなしで受け取ります。`,
        ].join('\n')
        : [
          `:wave: *Zeroちゃん*です。`,
          `対象projectで \`zerochan set slack-channel ${channelId}\` を実行すると、このチャンネルから利用できます。`,
        ].join('\n'),
    })
  } catch (err) {
    if (err instanceof AccessLockReleaseError) {
      process.stderr.write(`slack channel: fatal access lock release failure: ${err.message}\n`)
      shutdown()
      return
    }
    process.stderr.write(`slack channel: failed to send onboarding greeting to ${channelId}: ${err}\n`)
  }
})

// Lifecycle — clean shutdown
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('slack channel: shutting down\n')
  clearGatewayReadiness(READY_FILE)
  // Keep the singleton lock and SQLite handle until the process exits. Releasing
  // either while Bolt still owns a Socket Mode connection allows a replacement
  // gateway to overlap with this one and split Slack events.
  setTimeout(() => process.exit(0), 2000)
  void slackApp?.stop().finally(() => process.exit(0))
}

function stopOrphanedUpdateCandidate(): void {
  if (!updateTransactionPending(UPDATE_JOURNAL_FILE) || updateIsRunning(UPDATE_LOCK_DIR)) return
  process.stderr.write(
    'slack channel: updater stopped while transaction journal remains; '
    + 'candidate gateway is exiting so watchdog can report recovery is required\n',
  )
  shutdown()
}
// ── Thread catch-up poller ───────────────────────────────────────────────────
//
// Re-reads the threads the gateway has durably adopted in SQLite and delivers
// human replies that arrived without a re-mention, or while the gateway was
// offline. Cheap by construction: it
// only touches recently-active threads, only calls the Slack API, and only
// enqueues a job when there is a genuinely new reply. Empty polls do not start
// a Codex process.

type ThreadEntry = {
  channel_id?: string
  repo_path?: string
  /**
   * ts of the message that adopted this thread. Written once and never moved,
   * because it is where the poller starts reading a thread it has not polled
   * yet — a mark that crept forward with each dispatch would step over replies
   * behind it during that first window.
   */
  adopted_from_ts?: string
  /** Wall clock of the last dispatch. Drives the active window. */
  last_activity_ms?: number
}

// How long a sweep waits to hear that its messages got out. Writing to stdout
// has no timeout of its own — a reader that stops draining would park the
// sweep forever, and with it `pollInFlight`, killing catch-up for good. Giving
// up on the wait is not giving up on the message: the hand-off stays in flight,
// the read position stays put, and the next sweep joins the same attempt rather
// than starting a second one.
const DELIVERY_CONFIRM_TIMEOUT_MS = 10_000

async function confirmedWithin(handOffs: Promise<boolean>[]): Promise<boolean[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DELIVERY_CONFIRM_TIMEOUT_MS)
  })
  try {
    return await Promise.race([Promise.all(handOffs), gaveUp])
  } finally {
    clearTimeout(timer)
  }
}

async function stageDirectMessageChannelPages(): Promise<void> {
  if (!slackApp) return
  const key = 'dm-list'
  let entry = jobStore.readSlackReadCursor('scheduler', key)
  if (entry?.complete) {
    advanceSchedulerCursor(key, null, false)
    entry = jobStore.readSlackReadCursor('scheduler', key)
  }
  let cursor = entry?.cursor || undefined
  let resetInvalidCursor = false
  for (let page = 0; page < SLACK_METHOD_BUDGETS.list; page += 1) {
    takeSlackMethodBudget('list')
    let response: Awaited<ReturnType<typeof slackApp.client.conversations.list>>
    try {
      response = await slackApp.client.conversations.list({
        types: 'im',
        limit: 200,
        ...(cursor ? { cursor } : {}),
      })
    } catch (error) {
      if (cursor && !resetInvalidCursor && isInvalidSlackCursor(error)) {
        jobStore.resetSlackReadCursor('scheduler', key)
        cursor = undefined
        resetInvalidCursor = true
        continue
      }
      throw error
    }
    const channels = (response.channels ?? [])
      .flatMap(channel => channel.id ? [channel.id] : [])
    const nextCursor = response.response_metadata?.next_cursor || null
    jobStore.stageSlackDirectMessagePage(channels, nextCursor, nextCursor === null)
    if (nextCursor === null) break
    cursor = nextCursor
  }
}

function beginCatchupReadCycle(
  scope: 'catchup-recent' | 'catchup-parent',
  channel: string,
  initialOldest: string,
): { cursor: string | null; complete: boolean; cycleOldestTs: string; cycleStartedTs: string } {
  const startedTs = msToSlackTs(Date.now())
  let entry = jobStore.readSlackReadCursor(scope, channel)
  if (!entry) {
    const overlappedOldest = msToSlackTs(Math.max(0, slackTsToMs(initialOldest) - 1_000))
    jobStore.commitSlackReadCursorIfDurable(
      scope, channel, null, false, [], { oldestTs: overlappedOldest, startedTs },
    )
    entry = jobStore.readSlackReadCursor(scope, channel)
  } else if (entry.complete) {
    const overlappedOldest = msToSlackTs(
      Math.max(0, slackTsToMs(entry.cycleStartedTs ?? initialOldest) - 1_000),
    )
    jobStore.restartCompletedSlackReadCursor(scope, channel, startedTs, overlappedOldest)
    entry = jobStore.readSlackReadCursor(scope, channel)
  }
  if (!entry?.cycleOldestTs || !entry.cycleStartedTs) {
    throw new Error(`Slack catch-up cycle metadata is missing for ${scope}:${channel}`)
  }
  return entry as typeof entry & { cycleOldestTs: string; cycleStartedTs: string }
}

async function channelHistory(channel: string, oldest: string): Promise<{
  messages: any[]
  oldest: string
  commit: (requiredEventKeys: Iterable<string>) => boolean
}> {
  if (!slackApp) return { messages: [], oldest, commit: () => false }
  const entry = beginCatchupReadCycle('catchup-recent', channel, oldest)
  const pageBudget = positiveInteger(process.env.ZEROKUN_CATCHUP_HISTORY_PAGES_PER_SWEEP, 1)
  const messages: any[] = []
  let latest = entry.cursor ?? entry.cycleStartedTs
  let nextCursor: string | null = entry.cursor
  let complete = entry.complete
  for (let page = 0; page < pageBudget; page += 1) {
    takeSlackMethodBudget('history')
    const response = await slackApp.client.conversations.history({
      channel,
      oldest: entry.cycleOldestTs,
      latest,
      inclusive: false,
      limit: 200,
    })
    const pageMessages = (response.messages ?? []) as any[]
    messages.push(...pageMessages)
    jobStore.stageSlackReplyScans(
      catchupThreadParents(pageMessages, slackTsToMs(entry.cycleOldestTs)).map(threadTs => ({
        channelId: channel, threadTs, oldestTs: entry.cycleOldestTs,
      })),
    )
    const hasMore = Boolean(response.has_more || response.response_metadata?.next_cursor)
    const boundary = retreatReadCursor(pageMessages, latest)
    if (hasMore && boundary === latest) throw new Error(`Slack history page made no progress for ${channel}`)
    nextCursor = hasMore ? boundary : null
    complete = !hasMore
    if (complete) break
    latest = boundary
  }
  return {
    messages,
    oldest: entry.cycleOldestTs,
    commit: requiredEventKeys => jobStore.commitSlackReadCursorIfDurable(
      'catchup-recent', channel, nextCursor, complete, requiredEventKeys,
      { oldestTs: entry.cycleOldestTs!, startedTs: entry.cycleStartedTs! },
    ),
  }
}

async function fullHistoryParentCatchup(
  channel: string,
  oldest: string,
): Promise<{
  replies: any[]
  oldest: string
  commit: ((requiredEventKeys: Iterable<string>) => boolean) | null
}> {
  if (!slackApp) return { replies: [], oldest, commit: null }
  const entry = beginCatchupReadCycle('catchup-parent', channel, oldest)
  const pageBudget = positiveInteger(process.env.ZEROKUN_CATCHUP_PARENT_PAGES_PER_SWEEP, 1)
  const replies: any[] = []
  let latest = entry.cursor ?? entry.cycleStartedTs
  let nextEntry: { cursor: string | null; complete: boolean } = {
    cursor: entry.cursor,
    complete: entry.complete,
  }
  for (let page = 0; page < pageBudget; page += 1) {
    takeSlackMethodBudget('history')
    const response = await slackApp.client.conversations.history({
      channel,
      latest,
      inclusive: false,
      limit: 200,
    })
    const history = (response.messages ?? []) as any[]
    jobStore.stageSlackReplyScans(
      catchupThreadParents(history, slackTsToMs(entry.cycleOldestTs)).map(threadTs => ({
        channelId: channel, threadTs, oldestTs: entry.cycleOldestTs,
      })),
    )
    const hasMore = Boolean(response.has_more || response.response_metadata?.next_cursor)
    const boundary = retreatReadCursor(history, latest)
    if (hasMore && boundary === latest) throw new Error(`Slack parent history page made no progress for ${channel}`)
    nextEntry = { cursor: hasMore ? boundary : null, complete: !hasMore }
    if (!hasMore) break
    latest = boundary
  }
  return {
    replies,
    oldest: entry.cycleOldestTs,
    // Cursor advancement is a commit record: the caller invokes it only after
    // every eligible reply from these pages is durably staged (or explicitly
    // handled). A crash before that point safely re-fetches the same page.
    commit: requiredEventKeys => jobStore.commitSlackReadCursorIfDurable(
      'catchup-parent', channel, nextEntry.cursor, nextEntry.complete, requiredEventKeys,
      { oldestTs: entry.cycleOldestTs, startedTs: entry.cycleStartedTs },
    ),
  }
}

async function channelThreadReplyPage(
  channel: string,
  threadTs: string,
  oldest: string,
  lane: SlackBudgetLane = 'catchup',
): Promise<{ messages: any[]; hasMore: boolean }> {
  if (!slackApp) return { messages: [], hasMore: false }
  takeSlackMethodBudget('replies', lane)
  const response = await slackApp.client.conversations.replies({
    channel,
    ts: threadTs,
    oldest,
    inclusive: false,
    limit: 200,
  })
  return {
    messages: (response.messages ?? []) as any[],
    hasMore: Boolean(response.has_more || response.response_metadata?.next_cursor),
  }
}

async function channelCatchupMessages(channel: string, oldest: string, oldestMs: number): Promise<{
  messages: any[]
  recentMessages: any[]
  scanReplies: any[]
  oldestMs: number
  commitRecentScan: ((requiredEventKeys: Iterable<string>) => boolean) | null
  commitParentScan: ((requiredEventKeys: Iterable<string>) => boolean) | null
}> {
  const historyScan = await channelHistory(channel, oldest)
  const history = historyScan.messages
  const byTimestamp = new Map<string, any>()
  const recentByTimestamp = new Map<string, any>()
  for (const message of history) {
    if (message.ts) {
      byTimestamp.set(message.ts, message)
      recentByTimestamp.set(message.ts, message)
    }
  }
  // Slack orders history by root timestamp, so a recent reply to an old root
  // is absent from the bounded query above. Walk old parent pages under a
  // durable cursor and a strict per-sweep page budget; do not rescan hundreds
  // of pages every five minutes.
  const parentScan = await fullHistoryParentCatchup(channel, oldest)
  for (const reply of parentScan.replies) {
    if (reply.ts) byTimestamp.set(reply.ts, reply)
  }
  return {
    messages: [...byTimestamp.values()],
    recentMessages: [...recentByTimestamp.values()],
    scanReplies: parentScan.replies,
    oldestMs: Math.min(slackTsToMs(historyScan.oldest), slackTsToMs(parentScan.oldest), oldestMs),
    commitRecentScan: historyScan.commit,
    commitParentScan: parentScan.commit,
  }
}

async function processPendingReplyScanPages(
  access: AccessConfig,
  configuredLimit: string | undefined,
): Promise<{ delivered: number; candidates: number }> {
  if (!slackApp) return { delivered: 0, candidates: 0 }
  const pageBudget = positiveInteger(process.env.ZEROKUN_CATCHUP_REPLY_PAGES_PER_SWEEP, 20)
  const blocked = new Set<string>()
  let deliveredCount = 0
  let candidateCount = 0

  for (let page = 0; page < pageBudget; page += 1) {
    const scan = jobStore.listSlackReplyScans(pageBudget + blocked.size)
      .find(candidate => !blocked.has(candidate.scanKey))
    if (!scan) break
    let response: Awaited<ReturnType<typeof channelThreadReplyPage>>
    try {
      response = await channelThreadReplyPage(
        scan.channelId, scan.threadTs, scan.cursor ?? scan.oldestTs, 'catchup',
      )
    } catch (error) {
      if (isSlackBudgetError(error)) break
      process.stderr.write(`slack channel: reply scan failed for ${scan.channelId}/${scan.threadTs}: ${error}\n`)
      if (slackReplyScanFailureDisposition(error) === 'discard') {
        jobStore.discardSlackReplyScan(scan.scanKey)
        if (scan.channelId.startsWith('D')) {
          jobStore.completePendingDirectMessageChannel(scan.channelId)
        }
        continue
      }
      jobStore.deferSlackReplyScan(scan.scanKey)
      blocked.add(scan.scanKey)
      continue
    }

    const isDM = scan.channelId.startsWith('D')
    const sweepPolicy = {
      channelId: scan.channelId,
      channelType: isDM ? 'im' : 'channel',
      channelPolicy: access.channels[scan.channelId],
      oldestMs: slackTsToMs(scan.oldestTs),
      limit: configuredLimit
        ? positiveInteger(configuredLimit, response.messages.length || 1)
        : response.messages.length,
    } as const
    const durablyHandled = new Set(delivered)
    for (const message of response.messages) {
      if (message.ts && jobStore.hasDurableEvent(`${scan.channelId}:${message.ts}`)) {
        durablyHandled.add(`${scan.channelId}:${message.ts}`)
      }
    }
    const allCandidates = planCatchupSweep(
      response.messages,
      new Set(),
      { ...sweepPolicy, limit: response.messages.length || 1 },
      botUserId,
    )
    const requiredEventKeys = new Set(
      allCandidates.map(message => `${scan.channelId}:${message.ts!}`),
    )
    const candidateTimestamps = new Set(allCandidates.map(message => message.ts!))
    const outstanding = new Set(planCatchupSweep(
      response.messages,
      durablyHandled,
      { ...sweepPolicy, limit: response.messages.length || 1 },
      botUserId,
    ).map(message => message.ts!))
    const plan = planCatchupSweep(
      response.messages, durablyHandled, sweepPolicy, botUserId,
    )
    candidateCount += plan.length

    for (const message of plan) {
      const isBot = isSlackBotAuthored(message)
      const senderId = isBot ? message.bot_id : message.user
      if (!senderId || !message.ts) continue
      const text = message.text ?? ''
      const normalizedText = normalizeSlackInboundText(text, botUserId, isDM)
      const resolvedThreadTs = message.thread_ts || scan.threadTs
      const threadAuthorityTarget = activeThreadAuthorityTarget(
        scan.channelId, resolvedThreadTs, text, isDM, isBot,
      )
      const result = await gate(
        senderId,
        scan.channelId,
        isDM ? 'im' : 'channel',
        resolveIsMention(isDM, text, botUserId),
        isBot,
        threadAuthorityTarget !== null,
      )
      if (result.action === 'drop') {
        outstanding.delete(message.ts)
        if (candidateTimestamps.has(message.ts)) {
          requiredEventKeys.delete(`${scan.channelId}:${message.ts}`)
        }
        continue
      }
      if (result.action === 'pair') {
        const lead = result.isResend
          ? 'Zeroちゃんとのペアリング待ちです'
          : 'Zeroちゃんとのペアリングが必要です'
        try {
          await slackApp.client.chat.postMessage({
            channel: scan.channelId,
            text: `${lead}。ターミナルで次を実行してください。\n\n\`zerochan-access pair ${result.code}\``,
          })
          outstanding.delete(message.ts)
          if (candidateTimestamps.has(message.ts)) {
            requiredEventKeys.delete(`${scan.channelId}:${message.ts}`)
          }
        } catch (error) {
          process.stderr.write(`slack channel: reply scan pairing notice failed for ${scan.channelId}: ${error}\n`)
        }
        continue
      }
      const fileIds = (message.files ?? []).map((file: any) => file.id)
      const handedOver = await deliver(
        scan.channelId,
        message.ts,
        senderId,
        normalizedText,
        resolvedThreadTs,
        fileIds.length > 0 ? fileIds : undefined,
        threadAuthorityTarget
          ? { target: threadAuthorityTarget }
          : undefined,
      )
      if (handedOver) {
        deliveredCount += 1
        outstanding.delete(message.ts)
        await acknowledgeSlackDelivery(scan.channelId, message.ts, result.access)
      }
    }

    if (outstanding.size === 0) {
      const nextOldest = advanceReadCursor(
        response.messages, scan.cursor ?? scan.oldestTs,
      )
      if (response.hasMore && nextOldest === (scan.cursor ?? scan.oldestTs)) {
        process.stderr.write(`slack channel: reply scan made no timestamp progress for ${scan.scanKey}\n`)
        jobStore.deferSlackReplyScan(scan.scanKey)
        blocked.add(scan.scanKey)
        continue
      }
      if (!jobStore.commitSlackReplyScanPageIfDurable(
        scan.scanKey, response.hasMore ? nextOldest : null, requiredEventKeys,
      )) {
        process.stderr.write(`slack channel: reply scan cursor held for ${scan.scanKey}\n`)
        jobStore.deferSlackReplyScan(scan.scanKey)
        blocked.add(scan.scanKey)
      }
    } else {
      jobStore.deferSlackReplyScan(scan.scanKey)
      blocked.add(scan.scanKey)
    }
  }
  return { delivered: deliveredCount, candidates: candidateCount }
}

/** Socket Mode停止中に失われた新規mentionとDMを、起動直後に一度だけ回収する。 */
async function catchupSweep(): Promise<void> {
  if (!slackApp) return
  if (updateTransactionPending(UPDATE_JOURNAL_FILE)) return
  const windowHours = positiveInteger(process.env.ZEROKUN_CATCHUP_WINDOW_H, 48)
  const configuredLimit = process.env.ZEROKUN_CATCHUP_LIMIT
  const oldestMs = Date.now() - windowHours * 60 * 60 * 1000
  const access = loadAccess()
  const channelIds = new Set(Object.keys(access.channels))
  for (const thread of jobStore.listThreads()) {
    if (!thread.chatId.startsWith('D')) channelIds.add(thread.chatId)
  }
  const dmChannels = new Set<string>()

  try {
    await stageDirectMessageChannelPages()
  } catch (err) {
    process.stderr.write(`slack channel: catch-up DM list failed: ${err}\n`)
  }
  for (const channelId of jobStore.listPendingDirectMessageChannels()) {
    dmChannels.add(channelId)
    channelIds.add(channelId)
  }

  let deliveredCount = 0
  let candidateCount = 0
  const orderedChannels = [...channelIds].sort()
  const scheduledChannels = roundRobinAfter(
    orderedChannels,
    schedulerCursor('catchup-channels'),
  )
  const channelBudget = positiveInteger(process.env.ZEROKUN_CATCHUP_CHANNELS_PER_SWEEP, 10)
  let processedChannels = 0
  for (const channelId of scheduledChannels) {
    if (processedChannels >= channelBudget) break
    const isDM = dmChannels.has(channelId)
    let catchup: Awaited<ReturnType<typeof channelCatchupMessages>>
    try {
      catchup = await channelCatchupMessages(channelId, msToSlackTs(oldestMs), oldestMs)
    } catch (err) {
      process.stderr.write(`slack channel: catch-up history failed for ${channelId}: ${err}\n`)
      if (isSlackBudgetError(err)) break
      if (isDM && isTerminalSlackHistoryError(err)) {
        jobStore.completePendingDirectMessageChannel(channelId)
      }
      advanceSchedulerCursor('catchup-channels', channelId)
      processedChannels += 1
      continue
    }

    const sweepPolicy = {
      channelId,
      channelType: isDM ? 'im' : 'channel',
      channelPolicy: access.channels[channelId],
      oldestMs: catchup.oldestMs,
      limit: configuredLimit
        ? positiveInteger(configuredLimit, catchup.messages.length || 1)
        : catchup.messages.length,
    } as const
    const durablyHandled = new Set(delivered)
    for (const message of catchup.messages) {
      if (message.ts && jobStore.hasDurableEvent(`${channelId}:${message.ts}`)) {
        durablyHandled.add(`${channelId}:${message.ts}`)
      }
    }
    const plan = planCatchupSweep(catchup.messages, durablyHandled, sweepPolicy, botUserId)
    const allRecentCandidates = planCatchupSweep(
      catchup.recentMessages,
      new Set(),
      { ...sweepPolicy, limit: catchup.recentMessages.length || 1 },
      botUserId,
    )
    const recentCandidateTimestamps = new Set(allRecentCandidates.map(message => message.ts!))
    const requiredRecentEventKeys = new Set(
      allRecentCandidates.map(message => `${channelId}:${message.ts!}`),
    )
    const outstandingRecentMessages = new Set(planCatchupSweep(
      catchup.recentMessages,
      durablyHandled,
      { ...sweepPolicy, limit: catchup.recentMessages.length || 1 },
      botUserId,
    ).map(message => message.ts!))
    const allScanCandidates = planCatchupSweep(
      catchup.scanReplies,
      new Set(),
      { ...sweepPolicy, limit: catchup.scanReplies.length || 1 },
      botUserId,
    )
    const scanCandidateTimestamps = new Set(allScanCandidates.map(message => message.ts!))
    const requiredScanEventKeys = new Set(
      allScanCandidates.map(message => `${channelId}:${message.ts!}`),
    )
    const outstandingScanReplies = new Set(planCatchupSweep(
      catchup.scanReplies,
      durablyHandled,
      { ...sweepPolicy, limit: catchup.scanReplies.length || 1 },
      botUserId,
    ).map(message => message.ts!))
    candidateCount += plan.length

    for (const message of plan) {
      const isBot = isSlackBotAuthored(message)
      const senderId = isBot ? message.bot_id : message.user
      if (!senderId || !message.ts) continue
      const text = message.text ?? ''
      const normalizedText = normalizeSlackInboundText(text, botUserId, isDM)
      const resolvedThreadTs = message.thread_ts || message.ts
      const threadAuthorityTarget = activeThreadAuthorityTarget(
        channelId, message.thread_ts, text, isDM, isBot,
      )
      const result = await gate(
        senderId,
        channelId,
        isDM ? 'im' : 'channel',
        resolveIsMention(isDM, text, botUserId),
        isBot,
        threadAuthorityTarget !== null,
      )
      if (result.action === 'drop') {
        outstandingScanReplies.delete(message.ts)
        outstandingRecentMessages.delete(message.ts)
        if (scanCandidateTimestamps.has(message.ts)) {
          requiredScanEventKeys.delete(`${channelId}:${message.ts}`)
        }
        if (recentCandidateTimestamps.has(message.ts)) {
          requiredRecentEventKeys.delete(`${channelId}:${message.ts}`)
        }
        continue
      }
      if (result.action === 'pair') {
        const lead = result.isResend
          ? 'Zeroちゃんとのペアリング待ちです'
          : 'Zeroちゃんとのペアリングが必要です'
        try {
          await slackApp.client.chat.postMessage({
            channel: channelId,
            text: `${lead}。ターミナルで次を実行してください。\n\n\`zerochan-access pair ${result.code}\``,
          })
          outstandingScanReplies.delete(message.ts)
          outstandingRecentMessages.delete(message.ts)
          if (scanCandidateTimestamps.has(message.ts)) {
            requiredScanEventKeys.delete(`${channelId}:${message.ts}`)
          }
          if (recentCandidateTimestamps.has(message.ts)) {
            requiredRecentEventKeys.delete(`${channelId}:${message.ts}`)
          }
        } catch (err) {
          process.stderr.write(`slack channel: catch-up pairing notice failed for ${channelId}: ${err}\n`)
        }
        continue
      }

      const fileIds = (message.files ?? []).map(file => file.id)
      const handedOver = await deliver(
        channelId,
        message.ts,
        senderId,
        normalizedText,
        resolvedThreadTs,
        fileIds.length > 0 ? fileIds : undefined,
        threadAuthorityTarget
          ? { target: threadAuthorityTarget }
          : undefined,
      )
      if (handedOver) deliveredCount += 1
      if (handedOver) {
        outstandingScanReplies.delete(message.ts)
        outstandingRecentMessages.delete(message.ts)
        await acknowledgeSlackDelivery(channelId, message.ts, result.access)
      }
    }
    if (catchup.commitRecentScan && outstandingRecentMessages.size === 0) {
      if (!catchup.commitRecentScan(requiredRecentEventKeys)) {
        process.stderr.write(
          `slack channel: recent scan cursor held for non-durable events channel=${channelId}\n`,
        )
      }
    }
    if (catchup.commitParentScan && outstandingScanReplies.size === 0) {
      if (!catchup.commitParentScan(requiredScanEventKeys)) {
        process.stderr.write(
          `slack channel: parent scan cursor held for non-durable events channel=${channelId}\n`,
        )
      }
    }
    advanceSchedulerCursor('catchup-channels', channelId)
    if (isDM) jobStore.completePendingDirectMessageChannel(channelId)
    processedChannels += 1
  }

  const replyScan = await processPendingReplyScanPages(access, configuredLimit)
  deliveredCount += replyScan.delivered
  candidateCount += replyScan.candidates

  process.stderr.write(
    `slack channel: catch-up sweep delivered=${deliveredCount}`
    + ` candidates=${candidateCount} channels=${channelIds.size} window=${windowHours}h\n`,
  )
}

const scheduleCatchupSweep = singleFlightAsync(catchupSweep, error => {
  process.stderr.write(`slack channel: catch-up sweep failed: ${error}\n`)
})

function recoverUpdateNotificationWorker(): void {
  try { resumePendingUpdateWorker({ stateDir: STATE_DIR, workerFile: UPDATE_REQUEST_FILE }) }
  catch (error) {
    process.stderr.write(`slack channel: update worker recovery failed: ${error}\n`)
  }
}

let legacyThreadsImported = false
const LEGACY_THREADS_MIGRATION = 'legacy-threads-json-v1'

function importLegacyThreads(): void {
  if (legacyThreadsImported) return
  legacyThreadsImported = true
  // A fresh Codex state must never adopt a copied Claude-era thread map just
  // because the file exists. Only the explicit, setup-validated in-place
  // cutover path is authorized to read and import legacy routing history.
  if (process.env.ZEROKUN_LEGACY_CUTOVER !== '1') return
  if (jobStore.migrationApplied(LEGACY_THREADS_MIGRATION)) return
  let content: string | null
  try {
    content = readOptionalPrivateFile(THREADS_FILE)
  } catch (error) {
    process.stderr.write(`slack channel: legacy threads are unreadable; will retry after restart: ${error}\n`)
    return
  }
  if (content === null) {
    jobStore.markMigrationApplied(LEGACY_THREADS_MIGRATION)
    return
  }
  let legacy: unknown
  try {
    legacy = JSON.parse(content) as unknown
  } catch (error) {
    process.stderr.write(`slack channel: legacy threads JSON is invalid; will retry after restart: ${error}\n`)
    return
  }
  const validation = validateLegacyThreadMap(legacy)
  let failedEntries = validation.invalidKeys.length
  for (const invalidKey of validation.invalidKeys) {
    process.stderr.write(`slack channel: invalid legacy thread ${invalidKey}; will retry after restart\n`)
  }
  for (const { threadTs, entry } of validation.valid) {
    try {
      const repoPath = realpathSync(
        requireLegacyThreadRepoRoute(
          entry.channel_id,
          entry.repo_path,
          undefined,
          process.cwd(),
        ),
      )
      if (!statSync(repoPath).isDirectory()) throw new Error(`route is not a directory: ${repoPath}`)
      jobStore.adoptThread({
        chatId: entry.channel_id,
        threadTs,
        repoPath,
        adoptedFromTs: entry.adopted_from_ts ?? threadTs,
        lastActivityMs: entry.last_activity_ms ?? Date.now(),
      })
    } catch (err) {
      failedEntries += 1
      process.stderr.write(`slack channel: skipped legacy thread ${threadTs}: ${err}\n`)
    }
  }
  if (failedEntries === 0) {
    jobStore.markMigrationApplied(LEGACY_THREADS_MIGRATION)
  } else {
    process.stderr.write(`slack channel: ${failedEntries} legacy thread(s) will retry after restart\n`)
  }
}

/** Thread ownership is durable in the same SQLite database as inbound jobs. */
function loadThreads(): Array<ThreadEntry & { channel_id: string; thread_ts: string }> {
  importLegacyThreads()
  return jobStore.listThreads().map(thread => ({
    channel_id: thread.chatId,
    thread_ts: thread.threadTs,
    repo_path: thread.repoPath,
    adopted_from_ts: thread.adoptedFromTs,
    last_activity_ms: thread.lastActivityMs,
  }))
}

let pollInFlight = false

async function pollThreads(): Promise<void> {
  if (pollInFlight || !slackApp) return
  pollInFlight = true
  try {
    const threads = loadThreads().sort((left, right) => (
      slackThreadKey(left.channel_id, left.thread_ts)
        .localeCompare(slackThreadKey(right.channel_id, right.thread_ts))
    ))
    const access = loadAccess()
    const now = Date.now()
    const livePollKeys = new Set(threads.map(entry => (
      slackThreadKey(entry.channel_id, entry.thread_ts)
    )))
    const byPollKey = new Map(threads.map(entry => [
      slackThreadKey(entry.channel_id, entry.thread_ts), entry,
    ]))
    const scheduledThreads = roundRobinAfter(
      [...byPollKey.keys()], schedulerCursor('owned-threads'),
    ).map(key => byPollKey.get(key)!)

    for (const entry of scheduledThreads) {
      const channelId = entry.channel_id
      const threadTs = entry.thread_ts
      const pollKey = slackThreadKey(channelId, threadTs)
      const lastActivity = entry.last_activity_ms ?? 0
      if (now - lastActivity > THREAD_ACTIVE_WINDOW_MS) {
        advanceSchedulerCursor('owned-threads', pollKey)
        continue
      }

      const storedCursor = jobStore.readSlackReadCursor('owned-thread', pollKey)
      const cursorTs = threadPollCursor(
        storedCursor?.cursor ?? undefined, entry.adopted_from_ts, lastActivity, threadTs,
      )

      let replies: any[]
      try {
        replies = (await channelThreadReplyPage(
          channelId, threadTs, cursorTs, 'owned',
        )).messages
      } catch (err) {
        process.stderr.write(`slack channel: poll replies failed for ${threadTs}: ${err}\n`)
        if (isSlackBudgetError(err)) break
        advanceSchedulerCursor('owned-threads', pollKey)
        continue
      }

      const planned = channelId.startsWith('D')
        ? planDirectMessageThreadPoll(
          replies,
          cursorTs,
          access.dmPolicy === 'disabled' ? [] : effectiveDmAllowFrom(access),
          botUserId,
        )
        : planThreadPoll(replies, cursorTs, access.channels[channelId], botUserId)

      const policyExists = channelId.startsWith('D')
        ? access.dmPolicy !== 'disabled'
        : true
      const promotedAuthorities = new Map<string, LiveControlTarget>()
      const promoted = planned.skipped.filter(({ reply, reason }) => {
        if (reason !== 'policy' || !policyExists || !reply.ts) return false
        const target = activeThreadAuthorityTarget(
          channelId,
          threadTs,
          reply.text ?? '',
          channelId.startsWith('D'),
          Boolean(reply.bot_id),
        )
        if (!target) return false
        promotedAuthorities.set(reply.ts, target)
        return true
      }).map(({ reply }) => reply)
      const promotedTs = new Set(promoted.map(reply => reply.ts))
      const plan = {
        ...planned,
        deliver: [...planned.deliver, ...promoted]
          .sort((left, right) => parseFloat(left.ts!) - parseFloat(right.ts!)),
        skipped: planned.skipped.filter(({ reply }) => !promotedTs.has(reply.ts)),
      }

      for (const { reply, reason } of plan.skipped) {
        process.stderr.write(
          `slack channel: poll skip (${reason}) thread=${threadTs} ts=${reply.ts}\n`,
        )
      }
      const handedOver = await confirmedWithin(plan.deliver.map(async (r) => {
        const fileIds = (r.files ?? []).map((f: any) => f.id)
        const promotedTarget = promotedAuthorities.get(r.ts!)
        const ordinaryTarget = promotedTarget ?? activeThreadAuthorityTarget(
          channelId,
          threadTs,
          r.text ?? '',
          channelId.startsWith('D'),
          Boolean(r.bot_id),
        )
        const accepted = await deliver(
          channelId,
          r.ts!,
          r.user!,
          normalizeSlackInboundText(r.text ?? '', botUserId, channelId.startsWith('D')),
          threadTs,
          fileIds.length ? fileIds : undefined,
          ordinaryTarget
            ? { target: ordinaryTarget }
            : undefined,
        )
        if (accepted) await acknowledgeSlackDelivery(channelId, r.ts!, access)
        return accepted
      }))

      // Moving the read position means "these are dealt with", so hold it where
      // it is unless every one of them is confirmed out — the next sweep
      // re-reads the page and tries again. Persist on first sight even when the
      // page was empty, so the seed is computed once rather than each sweep.
      if (!handedOver?.every(Boolean)) {
        advanceSchedulerCursor('owned-threads', pollKey)
        continue
      }
      if (plan.cursor !== cursorTs || storedCursor === null) {
        const requiredEventKeys = plan.deliver.map(reply => `${channelId}:${reply.ts!}`)
        if (!jobStore.commitSlackReadCursorIfDurable(
          'owned-thread', pollKey, plan.cursor, false, requiredEventKeys,
        )) {
          process.stderr.write(
            `slack channel: owned thread cursor held for non-durable events thread=${pollKey}\n`,
          )
        }
      }
      advanceSchedulerCursor('owned-threads', pollKey)
    }

    // Forget threads the dispatcher has dropped. Without this the read
    // position outlives its thread, so a thread pruned from threads.json and
    // later re-adopted would resume from a cursor weeks old and replay all of
    // it — and poll-state would grow forever besides.
    jobStore.deleteSlackReadCursorsExcept('owned-thread', livePollKeys)
  } catch (err) {
    process.stderr.write(`slack channel: pollThreads error: ${err}\n`)
  } finally {
    pollInFlight = false
  }
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Start the Slack app
try {
  // Import legacy ownership before Socket Mode can deliver a competing event.
  // The first durable thread row must win independently of startup timing.
  importLegacyThreads()
  // Verify both credentials belong to the same Slack App before opening the
  // Socket Mode connection. A mixed old/new pair must never receive events
  // from one App while posting as another bot.
  const identity = await verifySlackAppTokenPair(APP_TOKEN, {
    authTest: () => slackApp.client.auth.test({}),
    botsInfo: async bot => {
      const result = await slackApp.client.bots.info({ bot })
      return { app_id: result.bot?.app_id }
    },
  })
  botUserId = identity.botUserId
  slackAppId = identity.appId
  await slackApp.start()
  setInterval(checkApprovals, 5_000).unref()
  const connectedProjectDir = realpathSync(process.cwd())
  writeLastConnectedProject(STATE_DIR, connectedProjectDir)
  writeGatewayReadiness(
    READY_FILE,
    process.env.ZEROKUN_RELEASE_COMMIT ?? 'manual',
    process.pid,
    connectedProjectDir,
    identity.appId,
  )
  process.stderr.write(`slack channel: connected (${botUserId}) app=${identity.appId}\n`)

  // Sweep once on startup for new mentions/DMs, and recover replies in owned threads.
  scheduleInboundDrain()
  void scheduleCatchupSweep()
  recoverUpdateNotificationWorker()
  // then keep a light timer for near-real-time follow-ups in owned threads.
  void pollThreads()
  setInterval(() => { void pollThreads() }, THREAD_POLL_INTERVAL_MS).unref()
  setInterval(() => { void scheduleCatchupSweep() }, CATCHUP_SWEEP_INTERVAL_MS).unref()
  setInterval(recoverUpdateNotificationWorker, UPDATE_RECOVERY_INTERVAL_MS).unref()
  setInterval(() => scheduleInboundDrain(), 5_000).unref()
  setInterval(stopOrphanedUpdateCandidate, 5_000).unref()
} catch (err) {
  process.stderr.write(`slack channel: failed to start: ${err}\n`)
  process.exit(1)
}
