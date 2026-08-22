#!/usr/bin/env bun
/**
 * Standalone Slack gateway for Codex.
 *
 * Self-contained gateway with pairing, allowlists, per-channel policies,
 * durable FIFO hand-off, and thread catch-up. New installations use
 * ~/.codex/zerokun/. An existing ~/.claude/channels/slack/ is discovered only
 * for an in-place migration. ZEROKUN_STATE_DIR always takes precedence.
 */

import { App } from '@slack/bolt'
import { randomBytes } from 'crypto'
import {
  closeSync, constants, existsSync, openSync, writeFileSync, writeSync,
  mkdirSync, readdirSync, rmSync, statSync, renameSync, realpathSync,
} from 'fs'
import { join, extname } from 'path'
import {
  decideChannelPolicy, isBotDMBlocked, threadPollCursor, planThreadPoll,
  planDirectMessageThreadPoll,
  resolveIsMention, pruneDeliveredKeys, planCatchupSweep, msToSlackTs,
  effectiveDmAllowFrom, isExplicitUpdateRequest, catchupThreadParents,
  slackThreadKey, slackTsToMs,
  singleFlightAsync,
  roundRobinAfter,
  isInvalidSlackCursor,
  advanceReadCursor,
  retreatReadCursor,
  isTerminalSlackHistoryError,
  slackReplyScanFailureDisposition,
  validateLegacyThreadMap,
  type ChannelPolicy,
} from './gate.ts'
import { requestUpdate, resumePendingUpdateWorker } from './zerokun/update-request.ts'
import { acquirePluginLock as claimPluginLock } from './plugin-lock.ts'
import { JobStore, updateIsRunning, updateTransactionPending } from './zerokun/job-runner.ts'
import { requireLegacyThreadRepoRoute, requireRepoRoute } from './zerokun/routing.ts'
import { resolveZeroStateDir } from './zerokun/state-dir.ts'
import {
  slackHttpTimeoutMs,
  slackWebClientOptions,
  withSlackDeadline,
} from './zerokun/slack-http.ts'
import {
  clearGatewayReadiness,
  writeGatewayReadiness,
} from './zerokun/readiness.ts'
import {
  ensureManagedDirectory,
  requireManagedStateRoot,
} from './zerokun/managed-path.ts'
import {
  mutateAccess,
  readAccess,
  type AccessConfig,
} from './zerokun/access.ts'
import { readOptionalPrivateFile } from './zerokun/safe-file.ts'

const STATE_DIR = resolveZeroStateDir()
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const LOCK_FILE = join(STATE_DIR, 'plugin.lock')
const THREADS_FILE = join(STATE_DIR, 'threads.json')
const ROUTES_FILE = join(STATE_DIR, 'routes.json')
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

// Load the selected state directory's .env into process.env. Real env wins.
try {
  for (const line of (readOptionalPrivateFile(ENV_FILE) ?? '').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch (error) {
  process.stderr.write(`slack channel: unsafe or unreadable ${ENV_FILE}: ${error}\n`)
  process.exit(1)
}

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const APP_TOKEN = process.env.SLACK_APP_TOKEN

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
      process.stderr.write(
        `slack channel: another instance (PID ${result.heldPid}) already holds ${LOCK_FILE}\n` +
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
const jobStore = new JobStore(process.env.ZEROKUN_JOB_DB ?? join(STATE_DIR, 'jobs.sqlite3'))
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

async function gate(senderId: string, channelId: string, channelType: string, isMention: boolean, isBot: boolean = false): Promise<GateResult> {
  return mutateAccess((access): GateResult => {
    pruneExpired(access)
    const isDM = channelType === 'im'

    if (access.dmPolicy === 'disabled' && isDM) return { action: 'drop' }
    if (isBotDMBlocked(isDM ? 'im' : 'channel', isBot)) return { action: 'drop' }

    if (isDM) {
      // Being on any opted-in channel's allowFrom carries into DMs — see effectiveDmAllowFrom.
      if (effectiveDmAllowFrom(access).includes(senderId)) return { action: 'deliver', access }
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
    }

    const decision = decideChannelPolicy(access.channels[channelId], senderId, isMention, isBot)
    return decision === 'drop' ? { action: 'drop' } : { action: 'deliver', access }
  }, ACCESS_FILE)
}

let slackApp: InstanceType<typeof App> | null = null

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
          text: "Paired! Say hi to Codex. Repository writes remain disabled until explicitly granted with zerokun-access write allow.",
        })
        rmSync(file, { force: true })
      } catch (err) {
        process.stderr.write(`slack channel: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      }
    })()
  }
}

setInterval(checkApprovals, 5000).unref()

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

type RouteEntry = { repo_path?: unknown; label?: unknown }

function configuredRepoPath(chatId: string): string | undefined {
  if (!chatId.startsWith('D')) {
    try {
      const content = readOptionalPrivateFile(ROUTES_FILE)
      const routes = content === null ? {} : JSON.parse(content) as Record<string, RouteEntry>
      const value = routes[chatId]?.repo_path
      if (typeof value === 'string' && value.trim()) return value
    } catch {}
  }
  return undefined
}

function resolveRepoPath(chatId: string, threadTs: string): string {
  const adopted = jobStore.getThread(chatId, threadTs)
  if (adopted) return realpathSync(adopted.repoPath)

  const configured = configuredRepoPath(chatId)
  const repoPath = realpathSync(requireRepoRoute(chatId, configured, process.cwd()))
  if (!statSync(repoPath).isDirectory()) throw new Error(`route is not a directory: ${repoPath}`)
  return repoPath
}

async function downloadInboundFiles(fileIds: string[], messageTs: string): Promise<string[]> {
  if (!/^\d+\.\d+$/.test(messageTs)) throw new Error(`invalid Slack message ts: ${messageTs}`)
  const paths: string[] = []
  for (const fileId of fileIds) {
    if (!/^F[A-Z0-9]+$/.test(fileId)) throw new Error(`invalid Slack file id: ${fileId}`)
    const localPath = await withSlackDeadline(async signal => {
      const info = await slackApp!.client.files.info({ file: fileId })
      const file = info.file
      if (!file?.url_private_download) throw new Error(`file ${fileId} is not downloadable`)
      if ((file.size ?? 0) > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file ${fileId} is larger than 50MB`)
      }
      const response = await fetch(file.url_private_download, {
        headers: { Authorization: `Bearer ${BOT_TOKEN}` },
        signal,
      })
      if (!response.ok) throw new Error(`file ${fileId} download failed: HTTP ${response.status}`)
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
      try {
        if (!response.body) throw new Error(`file ${fileId} download has no body`)
        const reader = response.body.getReader()
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > MAX_ATTACHMENT_BYTES) {
            await reader.cancel()
            throw new Error(`file ${fileId} is larger than 50MB`)
          }
          writeSync(descriptor, value)
        }
        closeSync(descriptor)
        renameSync(temporary, destination)
      } catch (error) {
        try { closeSync(descriptor) } catch {}
        rmSync(temporary, { force: true })
        throw error
      }
      return destination
    }, slackHttpTimeoutMs(), `Slack attachment ${fileId}`)
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
      onAccepted: async request => {
        await slackApp!.client.chat.postMessage({
          channel: chatId,
          thread_ts: threadTs,
          text: `🔄 Codex版ゼロくんの更新を受け付けました（request ${request.id.slice(0, 8)}）。実行中jobの完了後に更新し、このスレッドへ結果を通知します。`,
        })
      },
      onDuplicate: async request => {
        await slackApp!.client.chat.postMessage({
          channel: chatId,
          thread_ts: threadTs,
          text: `🔄 更新はすでに待機中または実行中です（request ${request.id.slice(0, 8)}）。`,
        })
      },
    },
  )
}

const INBOUND_RETRY_MS = 30_000
const INBOUND_MAX_ATTEMPTS = positiveInteger(process.env.ZEROKUN_INBOUND_MAX_ATTEMPTS, 5)
let inboundDrainActive = false
let inboundRetryTimer: ReturnType<typeof setTimeout> | undefined

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
      try {
        const attachments = await downloadInboundFiles(inbound.fileIds, inbound.messageId)
        const task = [
          inbound.text.trim() || '(添付ファイルを確認してください)',
          attachments.length > 0
            ? `\n添付ファイル（ローカル絶対パス）:\n${attachments.map(path => `- ${path}`).join('\n')}`
            : '',
        ].join('').trim()
        const result = jobStore.enqueue({
          chatId: inbound.chatId,
          threadTs: inbound.threadTs,
          messageId: inbound.messageId,
          userId: inbound.userId,
          repoPath: inbound.repoPath,
          task,
          attachments,
          writeEnabled: inbound.writeEnabled,
        })
        if (!result.duplicate) {
          await slackApp!.client.chat.postMessage({
            channel: inbound.chatId,
            thread_ts: inbound.threadTs,
            text: `🙌 Codexで受け付けました（queue ${result.queuePosition}）。`,
          }).catch(err => {
            process.stderr.write(
              `slack channel: acceptance reply failed for ${inbound.idempotencyKey}: ${err}\n`,
            )
          })
        }
        jobStore.completeInboundDelivery(inbound.idempotencyKey)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (inbound.attempts + 1 >= INBOUND_MAX_ATTEMPTS) {
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
    // Resolve before the detached-update branch too: an allow-list entry does
    // not authorize an otherwise unrouted channel to execute host operations.
    const repoPath = resolveRepoPath(chatId, resolvedThreadTs)
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
      jobStore.stageInboundDelivery({
        chatId,
        threadTs: resolvedThreadTs,
        messageId: messageTs,
        userId,
        repoPath,
        text,
        fileIds,
        writeEnabled,
      })
      scheduleInboundDrain()
    }
    rememberDelivered(key)
    return true
  })().catch(err => {
    process.stderr.write(`slack channel: failed to persist ${key} for Codex: ${err}\n`)
    return false
  }).finally(() => inFlight.delete(key))

  inFlight.set(key, handOver)
  return handOver
}

// Handle @mentions in channels
slackApp.event('app_mention', async ({ event }) => {
  if (updateTransactionPending(UPDATE_JOURNAL_FILE)) return
  // Symmetric with the message handler: bot posts that @mention this app
  // are routed through the same allowFrom-based opt-in. In practice bots
  // rarely @mention apps (forwarder/digest workflows are the main cases),
  // but keeping the rule consistent avoids a hidden second policy.
  const ev = event as any
  const isBot = !!ev.bot_id
  const senderId: string | undefined = isBot ? ev.bot_id : ev.user
  if (!senderId) return
  const channelId = event.channel
  const threadTs = event.thread_ts || event.ts

  const result = await gate(senderId, channelId, 'channel', true, isBot)
  if (result.action === 'drop') return
  if (result.action === 'pair') return

  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()

  const fileIds = ((event as any).files ?? []).map((f: any) => f.id)
  const handedOver = await deliver(
    channelId, event.ts, senderId, text, threadTs,
    fileIds.length > 0 ? fileIds : undefined,
  )
  if (!handedOver) return
  const ackReaction = result.access.ackReaction ?? 'eyes'
  if (ackReaction) {
    try {
      await slackApp!.client.reactions.add({
        channel: channelId,
        name: ackReaction,
        timestamp: event.ts,
      })
    } catch {}
  }
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
  const isBot = !!msg.bot_id
  if (msg.subtype && msg.subtype !== 'bot_message' && msg.subtype !== 'file_share') return
  if (msg.user === botUserId) return

  // For bots, identify by bot_id (B-prefix) since msg.user may be unset on
  // classic incoming-webhook posts. Operators allowlist bot ids in a channel's
  // allowFrom to opt them in.
  const senderId = isBot ? (msg.bot_id as string) : (msg.user as string)
  if (!senderId) return
  const channelId = msg.channel as string
  const channelType = msg.channel_type as string
  const threadTs = msg.thread_ts

  const isDM = channelType === 'im'
  const text = msg.text as string ?? ''
  // A DM needs no mention — the DM *is* the address. In a channel the mention
  // has to be real: treating every channel message as mentioning us would make
  // `requireMention` dead config, and this handler sees ALL channel traffic
  // whenever `message.channels` is subscribed (README tells operators to
  // subscribe it). Un-mentioned follow-ups in threads we own are not lost —
  // the catch-up poller picks those up.
  const isMention = resolveIsMention(isDM, text, botUserId)

  const result = await gate(senderId, channelId, isDM ? 'im' : 'channel', isMention, isBot)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      await slackApp!.client.chat.postMessage({
        channel: channelId,
        text: `${lead} — run in your terminal:\n\n\`zerokun-access pair ${result.code}\``,
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
    text,
    threadTs || msg.ts,
    fileIds.length > 0 ? fileIds : undefined,
  )
  if (!handedOver) return
  const ackReaction = result.access.ackReaction ?? 'eyes'
  if (ackReaction) {
    try {
      await slackApp!.client.reactions.add({
        channel: channelId,
        name: ackReaction,
        timestamp: msg.ts,
      })
    } catch {}
  }
})

// Handle being added to a channel — host-side routing is deliberately not delegated to Codex.
slackApp.event('member_joined_channel', async ({ event }) => {
  if (event.user !== botUserId) return

  const channelId = event.channel

  let isRouted = false
  try {
    const content = readOptionalPrivateFile(ROUTES_FILE)
    const routes = content === null ? {} : JSON.parse(content)
    isRouted = channelId in routes
  } catch {}
  if (isRouted) return

  try {
    await slackApp!.client.chat.postMessage({
      channel: channelId,
      text: [
        `:wave: Hi, I'm *Zero-kun for Codex*. I've been added to this channel but I'm not configured for it yet.`,
        ``,
        `A Mac administrator must register this channel from Terminal:`,
        ``,
        `> \`zerokun-access channel add ${channelId}\``,
        ``,
        `Then add this channel ID and its absolute \`repo_path\` to \`routes.json\` in the Zero-kun state directory.`,
        `Messages in an unrouted channel are intentionally ignored.`,
      ].join('\n'),
    })
  } catch (err) {
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
      const isBot = !!message.bot_id
      const senderId = isBot ? message.bot_id : message.user
      if (!senderId || !message.ts) continue
      const text = message.text ?? ''
      const result = await gate(
        senderId,
        scan.channelId,
        isDM ? 'im' : 'channel',
        resolveIsMention(isDM, text, botUserId),
        isBot,
      )
      if (result.action === 'drop') {
        outstanding.delete(message.ts)
        if (candidateTimestamps.has(message.ts)) {
          requiredEventKeys.delete(`${scan.channelId}:${message.ts}`)
        }
        continue
      }
      if (result.action === 'pair') {
        const lead = result.isResend ? 'Still pending' : 'Pairing required'
        try {
          await slackApp.client.chat.postMessage({
            channel: scan.channelId,
            text: `${lead} — run in your terminal:\n\n\`zerokun-access pair ${result.code}\``,
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
        isDM ? text : text.replace(/<@[A-Z0-9]+>/g, '').trim(),
        message.thread_ts || scan.threadTs,
        fileIds.length > 0 ? fileIds : undefined,
      )
      if (handedOver) {
        deliveredCount += 1
        outstanding.delete(message.ts)
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
      const isBot = !!message.bot_id
      const senderId = isBot ? message.bot_id : message.user
      if (!senderId || !message.ts) continue
      const text = message.text ?? ''
      const result = await gate(
        senderId,
        channelId,
        isDM ? 'im' : 'channel',
        resolveIsMention(isDM, text, botUserId),
        isBot,
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
        const lead = result.isResend ? 'Still pending' : 'Pairing required'
        try {
          await slackApp.client.chat.postMessage({
            channel: channelId,
            text: `${lead} — run in your terminal:\n\n\`zerokun-access pair ${result.code}\``,
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
        isDM ? text : text.replace(/<@[A-Z0-9]+>/g, '').trim(),
        message.thread_ts || message.ts,
        fileIds.length > 0 ? fileIds : undefined,
      )
      if (handedOver) deliveredCount += 1
      if (handedOver) {
        outstandingScanReplies.delete(message.ts)
        outstandingRecentMessages.delete(message.ts)
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
          configuredRepoPath(entry.channel_id),
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

      const plan = channelId.startsWith('D')
        ? planDirectMessageThreadPoll(
          replies,
          cursorTs,
          access.dmPolicy === 'disabled' ? [] : effectiveDmAllowFrom(access),
          botUserId,
        )
        : planThreadPoll(replies, cursorTs, access.channels[channelId], botUserId)

      for (const { reply, reason } of plan.skipped) {
        process.stderr.write(
          `slack channel: poll skip (${reason}) thread=${threadTs} ts=${reply.ts}\n`,
        )
      }
      const handedOver = await confirmedWithin(plan.deliver.map((r) => {
        const fileIds = (r.files ?? []).map((f: any) => f.id)
        return deliver(channelId, r.ts!, r.user!, r.text ?? '', threadTs, fileIds.length ? fileIds : undefined)
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
  await slackApp.start()
  const authResult = await slackApp.client.auth.test({})
  botUserId = authResult.user_id
  writeGatewayReadiness(
    READY_FILE,
    process.env.ZEROKUN_RELEASE_COMMIT ?? 'manual',
  )
  process.stderr.write(`slack channel: connected as ${authResult.user} (${botUserId})\n`)

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
