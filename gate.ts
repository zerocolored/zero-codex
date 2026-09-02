/**
 * Pure access-policy helpers for the Slack channel plugin.
 *
 * Extracted from server.ts so the policy decisions can be unit-tested
 * without spinning up the Slack runtime. server.ts imports these.
 */

export type ChannelPolicy = {
  requireMention: boolean
  /** Legacy state only; ignored by channel authorization. */
  allowFrom?: string[]
}

export type LegacyThreadEntry = {
  channel_id: string
  repo_path?: string
  adopted_from_ts?: string
  last_activity_ms?: number
}

export type ValidLegacyThread = {
  threadTs: string
  entry: LegacyThreadEntry
}

/**
 * Validate the complete legacy threads.json shape without silently discarding
 * ownership records. Valid rows may be adopted immediately, but any structural
 * error keeps the migration marker unset so an operator can repair and retry.
 */
export function validateLegacyThreadMap(value: unknown): {
  valid: ValidLegacyThread[]
  invalidKeys: string[]
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: [], invalidKeys: ['<root>'] }
  }

  const valid: ValidLegacyThread[] = []
  const invalidKeys: string[] = []
  for (const [threadTs, candidate] of Object.entries(value)) {
    if (!/^\d+\.\d+$/.test(threadTs)
      || candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      invalidKeys.push(threadTs)
      continue
    }
    const entry = candidate as Record<string, unknown>
    if (typeof entry.channel_id !== 'string' || entry.channel_id.trim() === ''
      || (entry.repo_path !== undefined && typeof entry.repo_path !== 'string')
      || (entry.adopted_from_ts !== undefined
        && (typeof entry.adopted_from_ts !== 'string'
          || !/^\d+\.\d+$/.test(entry.adopted_from_ts)))
      || (entry.last_activity_ms !== undefined
        && (typeof entry.last_activity_ms !== 'number'
          || !Number.isFinite(entry.last_activity_ms)
          || entry.last_activity_ms < 0))) {
      invalidKeys.push(threadTs)
      continue
    }
    valid.push({ threadTs, entry: entry as LegacyThreadEntry })
  }
  return { valid, invalidKeys }
}

/**
 * Channel access is intentionally membership-based: Slack only delivers
 * channel events to an app that is present in that conversation, every human
 * participant is accepted, and bot-authored/unknown-sender events are always
 * rejected. New roots still need a real mention; an already adopted live
 * thread is the address for later human replies.
 */
export function decideChannelPolicy(
  policy: ChannelPolicy | undefined,
  senderId: string,
  isMention: boolean,
  isBot: boolean,
  activeHumanThreadAuthority = false,
): 'deliver' | 'drop' {
  if (isBot || !SLACK_USER_ID_RE.test(senderId)) return 'drop'
  const requireMention = policy?.requireMention ?? true
  if (requireMention && !isMention && !activeHumanThreadAuthority) return 'drop'
  return 'deliver'
}

/**
 * After the LLM has confirmed that a reply is for Zero, an active thread is a
 * delegated conversation boundary: any human participant may steer it. Bots,
 * completed threads and unrelated roots retain the ordinary access gate.
 */
export function canUseActiveThreadAuthority(options: {
  isBot: boolean
  hasLiveTarget: boolean
  hasInterruptTarget: boolean
  isInterrupt: boolean
}): boolean {
  if (options.isBot) return false
  return options.hasLiveTarget || (options.isInterrupt && options.hasInterruptTarget)
}

/**
 * Bot DMs are unconditionally dropped. Channel bot posts are rejected by
 * `decideChannelPolicy`, independently of any legacy access state.
 */
export function isBotDMBlocked(channelType: 'im' | 'channel', isBot: boolean): boolean {
  return isBot && channelType === 'im'
}

// Slack user ids are "U…", or "W…" on Enterprise Grid. Bot ids are "B…".
export const SLACK_USER_ID_RE = /^[UW][A-Z0-9]+$/

/**
 * Who may reach the bot through a DM.
 *
 * Legacy channel allowlists are migrated into the global list by access.ts.
 * Runtime checks therefore consult only `allowFrom`; channel participation no
 * longer grants or revokes DM access implicitly.
 *
 * `dmPolicy` still outranks this list: 'disabled' turns DMs off wholesale
 * before it is consulted, and under 'pairing' it is the set that skips pairing
 * rather than the set that is allowed at all.
 */
export function effectiveDmAllowFrom(access: {
  allowFrom?: string[]
}): string[] {
  const allowed = new Set<string>()
  for (const id of access.allowFrom ?? []) {
    if (SLACK_USER_ID_RE.test(id)) allowed.add(id)
  }
  return [...allowed]
}

// ── Thread catch-up poller helpers ───────────────────────────────────────────
//
// The bridge only receives an inbound event for a channel message when the
// sender @mentions the bot (app_mention) — a follow-up reply in a thread the
// bot already owns, posted WITHOUT a re-mention, never reaches the worker. On top
// of that, Socket Mode has no durable queue, so any event that arrives while no
// gateway is consuming is simply lost. The poller closes both gaps by
// periodically re-reading `conversations.replies` for the threads the bot
// already owns (the threads.json map is itself the subscription list) and
// delivering replies newer than a per-thread cursor. These pure helpers hold
// the ts arithmetic and the "which replies are new" decision so they can be
// unit-tested without the Slack runtime.

export type SlackReply = {
  ts?: string
  thread_ts?: string
  reply_count?: number
  latest_reply?: string
  user?: string
  bot_id?: string
  bot_profile?: unknown
  subtype?: string
  text?: string
  files?: { id: string }[]
}

/** Slack can identify bot-authored history with any of these three shapes. */
export function isSlackBotAuthored(message: SlackReply): boolean {
  return Boolean(
    message.bot_id
    || message.bot_profile
    || message.subtype === 'bot_message',
  )
}

/**
 * `conversations.history` omits reply bodies. Select parents whose newest
 * reply may fall inside the catch-up window so server.ts can expand them via
 * `conversations.replies`. Otherwise an offline mention in an unadopted thread
 * never reaches the durable queue.
 */
export function catchupThreadParents(history: SlackReply[], oldestMs: number): string[] {
  const parents = new Set<string>()
  for (const message of history) {
    if (!message.ts || !Number.isFinite(message.reply_count) || message.reply_count! <= 0) continue
    if (message.thread_ts && message.thread_ts !== message.ts) continue
    const latestReplyMs = message.latest_reply ? slackTsToMs(message.latest_reply) : Number.NaN
    if (Number.isFinite(latestReplyMs) && latestReplyMs < oldestMs) continue
    parents.add(message.ts)
  }
  return [...parents]
}

/** Slack ts ("1712345678.000200") → epoch milliseconds. */
export function slackTsToMs(ts: string): number {
  return Math.round(parseFloat(ts) * 1000)
}

/** Epoch milliseconds → Slack ts string, usable as a `conversations.replies` cursor. */
export function msToSlackTs(ms: number): string {
  return (ms / 1000).toFixed(6)
}

export function slackThreadKey(chatId: string, threadTs: string): string {
  return JSON.stringify([chatId, threadTs])
}

export function singleFlightAsync(
  operation: () => Promise<void>,
  onError: (error: unknown) => void = () => {},
): () => Promise<void> {
  let inFlight: Promise<void> | null = null
  return () => {
    if (inFlight) return inFlight
    inFlight = operation().catch(onError).finally(() => { inFlight = null })
    return inFlight
  }
}

/**
 * Return one durable round-robin ordering. The caller persists the last item
 * it actually completed; a restart can therefore resume after that item
 * without depending on in-memory array position.
 */
export function roundRobinAfter<T>(items: T[], lastCompleted: T | null): T[] {
  if (lastCompleted === null) return items
  const index = items.indexOf(lastCompleted)
  return index < 0
    ? items
    : [...items.slice(index + 1), ...items.slice(0, index + 1)]
}

/** Slack SDK PlatformError keeps the authoritative Web API code in `data.error`. */
export function structuredSlackApiErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object') {
    const data = (error as { data?: unknown }).data
    if (data && typeof data === 'object'
      && typeof (data as { error?: unknown }).error === 'string') {
      return (data as { error: string }).error.toLowerCase()
    }
  }
  return null
}

/** Best-effort diagnostic code; destructive/durable decisions use the structured variant. */
export function slackApiErrorCode(error: unknown): string | null {
  const structured = structuredSlackApiErrorCode(error)
  if (structured) return structured
  if (error && typeof error === 'object') {
    if (typeof (error as { code?: unknown }).code === 'string') {
      return (error as { code: string }).code.toLowerCase()
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/(?:^|\b)(invalid_cursor|channel_not_found|thread_not_found|not_in_channel|is_archived)(?:\b|$)/i)
  return match?.[1]?.toLowerCase() ?? null
}

export function isInvalidSlackCursor(error: unknown): boolean {
  return slackApiErrorCode(error) === 'invalid_cursor'
}

/** A missing DM/channel identifier cannot recover without discovering a new ID. */
export function isTerminalSlackHistoryError(error: unknown): boolean {
  return structuredSlackApiErrorCode(error) === 'channel_not_found'
}

/** A missing channel or thread makes this exact durable reply-scan key unusable. */
export function isTerminalSlackReplyScanError(error: unknown): boolean {
  return ['channel_not_found', 'thread_not_found'].includes(
    structuredSlackApiErrorCode(error) ?? '',
  )
}

export function slackReplyScanFailureDisposition(error: unknown): 'discard' | 'defer' {
  return isTerminalSlackReplyScanError(error) ? 'discard' : 'defer'
}

const PERMANENT_INITIAL_CONTEXT_SLACK_ERRORS = new Set([
  'account_inactive',
  'channel_not_found',
  'invalid_auth',
  'is_archived',
  'missing_scope',
  'no_permission',
  'not_authed',
  'not_in_channel',
  'thread_not_found',
  'token_revoked',
])

const TRANSIENT_INITIAL_CONTEXT_SLACK_ERRORS = new Set([
  'fatal_error',
  'internal_error',
  'ratelimited',
  'request_timeout',
  'service_unavailable',
  'temporarily_unavailable',
])

/**
 * Classify the initial root→mention read without interpreting user-authored
 * text. Known permanent platform errors fail that one inbound row; known
 * backpressure/transport errors keep its finite attempt budget intact.
 */
export function slackInitialThreadContextFailureDisposition(
  error: unknown,
): 'fail' | 'defer' | 'retry' {
  const structured = structuredSlackApiErrorCode(error)
  if (structured && PERMANENT_INITIAL_CONTEXT_SLACK_ERRORS.has(structured)) return 'fail'
  if (structured && TRANSIENT_INITIAL_CONTEXT_SLACK_ERRORS.has(structured)) return 'defer'

  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; statusCode?: unknown; status?: unknown }
    const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : ''
    if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETDOWN', 'ENETUNREACH']
      .includes(code)) return 'defer'
    const status = typeof candidate.statusCode === 'number'
      ? candidate.statusCode
      : typeof candidate.status === 'number'
        ? candidate.status
        : null
    if (status === 429 || (status !== null && status >= 500 && status <= 599)) return 'defer'
  }
  const message = error instanceof Error ? error.message : ''
  if (/\b(?:timed out|timeout|socket hang up|HTTP 429|status.?429)\b/i.test(message)) {
    return 'defer'
  }
  return 'retry'
}

/** Only a real Slack PlatformError for a DM may alter its durable retry schedule. */
export function slackDirectMessageFailureDisposition(
  channelId: string,
  error: unknown,
): 'backoff' | 'defer' {
  return /^D[A-Z0-9]+$/.test(channelId)
    && structuredSlackApiErrorCode(error) === 'channel_not_found'
    ? 'backoff'
    : 'defer'
}

/** Availability bookkeeping must never suppress an already-arrived Slack event. */
export function refreshSlackDirectMessageAvailability(
  clear: () => boolean,
): 'restored' | 'unchanged' | 'retry' {
  try {
    return clear() ? 'restored' : 'unchanged'
  } catch {
    return 'retry'
  }
}

// Slack renders an explicit bot mention as a token. This helper only detects
// that structural fact for top-level channel routing and initial-context
// bookkeeping; semantic thread audience is decided exclusively by the LLM
// admission gate in server.ts.
const USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g

/** Whether `text` carries an explicit `<@bot>` mention token. */
export function mentionsBot(text: string, botUserId: string | undefined): boolean {
  if (!botUserId) return false
  for (const m of text.matchAll(USER_MENTION_RE)) {
    if (m[1] === botUserId) return true
  }
  return false
}

/** Live channel path: a DM is self-addressed, a channel post must name us. */
export function resolveIsMention(
  isDM: boolean,
  text: string,
  botUserId: string | undefined,
): boolean {
  return isDM || mentionsBot(text, botUserId)
}

/**
 * Detached self-update is a privileged side effect, so only a short imperative
 * utterance is accepted. Questions and explanatory mentions stay in the
 * normal read-only/FIFO path instead of accidentally updating the bot.
 */
export function isExplicitUpdateRequest(text: string): boolean {
  const normalized = text
    .trim()
    // `message.channels` and `app_mention` can race for the same Slack post.
    // Accept the same explicit command whether its leading mention was already
    // stripped by the app_mention handler or not.
    .replace(/^(?:<@[UW][A-Z0-9]+(?:\|[^>]+)?>[ \t]*)+/i, '')
    .toLowerCase()
    .replace(/[。．.!！]+$/g, '')
    .replace(/\s+/g, ' ')
  const japanese = /^(?:Zeroちゃん|ゼロちゃん|ゼロくん|zero-?kun|zerokun|このアプリ|あなた自身)(?:を|の)?(?:最新版(?:へ|に)?|本体(?:を)?|コード(?:を)?)?(?:更新|アップデート)(?:して|してください|して下さい|をお願い|お願い|お願いします|をお願いします|を実行して|を実行してください)$/i
  const english = /^(?:please )?(?:(?:update|upgrade) (?:zero[ -]?kun|zerokun|this app|yourself)|(?:zero[ -]?kun|zerokun|this app) (?:update|upgrade))(?: now)?$/i
  return japanese.test(normalized) || english.test(normalized)
}

export type CatchupSweepPolicy = {
  channelId: string
  channelType: 'im' | 'channel'
  channelPolicy?: ChannelPolicy
  oldestMs: number
  limit?: number
}

/** Combine the rolling recovery window with durable App/route cutover floors. */
export function resolveCatchupOldestMs(
  windowOldestMs: number,
  ...floors: Array<number | null | undefined>
): number {
  const values = [windowOldestMs, ...floors.filter((value): value is number => value != null)]
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('catch-up lower bound is invalid')
  }
  return Math.max(...values)
}

/**
 * 起動時に履歴から回収するメッセージを決める。Slack I/O と access.json の
 * DM allowlist 判定は server.ts に残し、ここではlive handlerと同じメッセージ形状・
 * mention・channel policy・dedup・時間窓・件数上限を固定する。
 */
export function planCatchupSweep(
  history: SlackReply[],
  deliveredKeys: Iterable<string>,
  policy: CatchupSweepPolicy,
  botUserId: string | undefined,
): SlackReply[] {
  const delivered = new Set(deliveredKeys)
  const limit = Math.max(1, Math.floor(policy.limit ?? 20))
  const candidates = history.filter((message) => {
    if (!message.ts) return false
    const messageMs = slackTsToMs(message.ts)
    if (!Number.isFinite(messageMs) || messageMs < policy.oldestMs) return false
    if (delivered.has(`${policy.channelId}:${message.ts}`)) return false
    if (message.subtype
      && message.subtype !== 'bot_message'
      && message.subtype !== 'file_share'
      && message.subtype !== 'thread_broadcast') {
      return false
    }
    if (botUserId && message.user === botUserId) return false

    const isBot = isSlackBotAuthored(message)
    const senderId = isBot ? message.bot_id : message.user
    if (!senderId) return false
    if (isBotDMBlocked(policy.channelType, isBot)) return false
    if (policy.channelType === 'im') return true

    // Child replies are re-checked by the runtime gate because an active Zero
    // thread may accept unmentioned human input. Root messages still need the
    // ordinary mention rule here.
    if (!isBot && message.thread_ts && message.thread_ts !== message.ts) return true
    const isMention = resolveIsMention(false, message.text ?? '', botUserId)
    return decideChannelPolicy(policy.channelPolicy, senderId, isMention, isBot) === 'deliver'
  }).sort((a, b) => parseFloat(a.ts!) - parseFloat(b.ts!))

  return candidates.slice(-limit)
}

/**
 * The poller's structural per-reply verdict. Semantic audience is deliberately
 * absent: server.ts sends every eligible human reply to the durable LLM gate.
 */
export function decideThreadReplyDelivery(
  policy: ChannelPolicy | undefined,
  reply: SlackReply,
  _botUserId: string | undefined,
): 'deliver' | 'drop-policy' {
  if (decideChannelPolicy(policy, reply.user!, true, false) !== 'deliver') return 'drop-policy'
  // Semantic audience is intentionally not decided here. Every human channel
  // reply is passed to the durable LLM gate in server.ts before it can produce
  // any reaction, queue item, control message or attachment download.
  return 'deliver'
}

/**
 * How far the poller has now READ, which is not the same as how far it has
 * delivered. Every reply on the page counts — the bot's own posts, system
 * subtypes and replies the later LLM gate ignores. Advancing only past delivered
 * replies lets a page that happens to hold 50 of the bot's own messages pin
 * the cursor forever, and every human reply behind it becomes unreachable.
 */
export function advanceReadCursor(replies: SlackReply[], cursorTs: string): string {
  let maxTs = cursorTs
  for (const r of replies) {
    if (r.ts && parseFloat(r.ts) > parseFloat(maxTs)) maxTs = r.ts
  }
  return maxTs
}

/** Oldest timestamp in a newest-first history page, for stable time pagination. */
export function retreatReadCursor(messages: SlackReply[], latestTs: string): string {
  let minTs = latestTs
  for (const message of messages) {
    if (message.ts && parseFloat(message.ts) < parseFloat(minTs)) minTs = message.ts
  }
  return minTs
}

export type ThreadPollPlan = {
  /** How far the thread has now been read, delivered or not. */
  cursor: string
  deliver: SlackReply[]
  skipped: { reply: SlackReply; reason: 'policy' }[]
}

/**
 * Everything the poller decides about one page of a thread. Kept whole and
 * pure so the decisions are testable: server.ts is left with the I/O — fetch
 * the page, hand the plan to deliver(), persist the cursor — and cannot
 * quietly diverge from the rules by dropping a check.
 */
export function planThreadPoll(
  replies: SlackReply[],
  cursorTs: string,
  policy: ChannelPolicy | undefined,
  botUserId: string | undefined,
): ThreadPollPlan {
  const plan: ThreadPollPlan = {
    cursor: advanceReadCursor(replies, cursorTs),
    deliver: [],
    skipped: [],
  }
  for (const reply of selectNewReplies(replies, cursorTs, botUserId)) {
    const verdict = decideThreadReplyDelivery(policy, reply, botUserId)
    if (verdict === 'deliver') plan.deliver.push(reply)
    else plan.skipped.push({ reply, reason: 'policy' })
  }
  return plan
}

/**
 * DM threads have no channel policy entry. They still need catch-up, but only
 * for currently authorized human senders. Keeping this separate prevents the
 * channel helper's default-deny rule from silently dropping every DM reply.
 */
export function planDirectMessageThreadPoll(
  replies: SlackReply[],
  cursorTs: string,
  allowedUsers: Iterable<string>,
  botUserId: string | undefined,
): ThreadPollPlan {
  const allowed = new Set(allowedUsers)
  const plan: ThreadPollPlan = {
    cursor: advanceReadCursor(replies, cursorTs),
    deliver: [],
    skipped: [],
  }
  for (const reply of selectNewReplies(replies, cursorTs, botUserId)) {
    if (reply.user && allowed.has(reply.user)) plan.deliver.push(reply)
    else plan.skipped.push({ reply, reason: 'policy' })
  }
  return plan
}

/**
 * Where to resume reading a thread.
 *
 * `seenTs` — how far the poller itself has read — is the only running
 * position, and it only moves forward. Nothing the dispatcher records is
 * allowed to push it: what the live path handled is NOT a read position, it is
 * a single point that can sit anywhere ahead of unread replies, so treating it
 * as a floor skips whatever is behind it. ("これ見て" then "@ゼロくん やって"
 * seconds later would bury the first message.) Re-reading what the live path
 * already delivered is fine — `deliverKeyLimit`-bounded dedup on (chat, ts)
 * makes redelivery a no-op, across restarts too.
 *
 * The dispatcher's marks are therefore only a starting point for a thread that
 * has never been polled, and exist to stop an adopted thread from replaying its
 * whole human backlog: `adoptedFromTs`, the ts the thread was taken on, or the
 * older wall-clock stamp. `adoptedFromTs` must be fixed at adoption — a mark
 * that moved with each dispatch would be a floor again for as long as the
 * first poll has not landed, and would step over anything behind it.
 */
export function threadPollCursor(
  seenTs: string | undefined,
  adoptedFromTs: string | undefined,
  lastActivityMs: number | undefined,
  threadTs: string,
): string {
  if (seenTs) return seenTs
  if (adoptedFromTs) return adoptedFromTs
  return lastActivityMs ? msToSlackTs(lastActivityMs) : threadTs
}

/**
 * Which delivery keys to keep once the set outgrows `limit`: the newest
 * `limit / 2`, in insertion order. Bounded so the on-disk record of what has
 * already been handed to Codex cannot grow forever, halved rather than
 * trimmed by one so the pruning is amortised.
 */
export function pruneDeliveredKeys(keys: Iterable<string>, limit: number): string[] {
  const all = [...keys]
  return all.length > limit ? all.slice(all.length - Math.floor(limit / 2)) : all
}

/**
 * From every reply in a thread, pick the ones the poller should deliver:
 * strictly newer than `cursorTs`, authored by a human (not the bot itself and
 * not another bot — bots reach the bridge through the live app_mention path),
 * and not a system subtype (channel_join, message_changed, …). `file_share`
 * and human `thread_broadcast` are kept so uploads and “also send to channel”
 * replies in a followed thread still come through exactly once. Returned
 * oldest-first so delivery preserves chronological order.
 */
export function selectNewReplies(
  replies: SlackReply[],
  cursorTs: string,
  botUserId: string | undefined,
): SlackReply[] {
  const cursor = parseFloat(cursorTs)
  return replies
    .filter((r) => {
      if (!r.ts) return false
      if (parseFloat(r.ts) <= cursor) return false
      if (isSlackBotAuthored(r)) return false
      if (!r.user || !SLACK_USER_ID_RE.test(r.user)) return false
      if (botUserId && r.user === botUserId) return false
      if (r.subtype && r.subtype !== 'file_share' && r.subtype !== 'thread_broadcast') return false
      return true
    })
    .sort((a, b) => parseFloat(a.ts!) - parseFloat(b.ts!))
}
