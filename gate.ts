/**
 * Pure access-policy helpers for the Slack channel plugin.
 *
 * Extracted from server.ts so the policy decisions can be unit-tested
 * without spinning up the Slack runtime. server.ts imports these.
 */

export type ChannelPolicy = {
  requireMention: boolean
  allowFrom: string[]
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
 * Decide whether a channel message passes the channel-level access policy.
 *
 * Two senders are distinguished:
 *
 *   - Humans (Slack user ids, "U…") are default-allow. An empty `allowFrom`
 *     permits any sender; a populated `allowFrom` restricts to listed ids.
 *
 *   - Bots (Slack bot ids, "B…") are default-deny. The bot's id must be
 *     explicitly listed in `allowFrom` for delivery. Empty `allowFrom`
 *     blocks all bots, populated `allowFrom` blocks any bot whose id is
 *     not on the list.
 *
 * Both senders still respect `requireMention`.
 */
export function decideChannelPolicy(
  policy: ChannelPolicy | undefined,
  senderId: string,
  isMention: boolean,
  isBot: boolean,
): 'deliver' | 'drop' {
  if (!policy) return 'drop'
  const allowFrom = policy.allowFrom ?? []
  if (isBot) {
    if (!allowFrom.includes(senderId)) return 'drop'
  } else if (allowFrom.length > 0 && !allowFrom.includes(senderId)) {
    return 'drop'
  }
  if (policy.requireMention && !isMention) return 'drop'
  return 'deliver'
}

/**
 * Bots may only reach the bot through opted-in channels. Bot DMs are
 * unconditionally dropped; the access skill cannot opt a bot into DMs.
 */
export function isBotDMBlocked(channelType: 'im' | 'channel', isBot: boolean): boolean {
  return isBot && channelType === 'im'
}

// Slack user ids are "U…", or "W…" on Enterprise Grid. Bot ids are "B…".
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]+$/

/**
 * Who may reach the bot through a DM.
 *
 * Channel opt-in IS DM opt-in: the global `allowFrom` and every channel's
 * `allowFrom` are one list. Keeping them separate only created bookkeeping —
 * somebody added to a channel would be dropped in DMs, and would silently never
 * receive a permission prompt, because those are delivered by DM. There is no
 * threat the split defended against: a user trusted to drive the bot from an
 * opted-in channel can already say the same thing there.
 *
 * Only user ids survive the union. A channel's `allowFrom` doubles as its bot
 * opt-in list ("B…"), and a bot must never reach the DM surface — `gate()`
 * stops bot DMs via isBotDMBlocked, but the permission-relay recipients and the
 * permission button check read this list directly and have no such guard.
 *
 * `dmPolicy` still outranks this list: 'disabled' turns DMs off wholesale
 * before it is consulted, and under 'pairing' it is the set that skips pairing
 * rather than the set that is allowed at all.
 */
export function effectiveDmAllowFrom(access: {
  allowFrom?: string[]
  channels?: Record<string, ChannelPolicy | undefined>
}): string[] {
  // Insertion order keeps the global list first, so the permission relay still
  // DMs the long-standing operators before anyone gained via a channel.
  const allowed = new Set<string>()
  for (const id of access.allowFrom ?? []) {
    if (SLACK_USER_ID_RE.test(id)) allowed.add(id)
  }
  for (const policy of Object.values(access.channels ?? {})) {
    for (const id of policy?.allowFrom ?? []) {
      if (SLACK_USER_ID_RE.test(id)) allowed.add(id)
    }
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
  subtype?: string
  text?: string
  files?: { id: string }[]
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

/** Slack SDK PlatformError keeps the Web API code in `data.error`. */
export function slackApiErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object') {
    const data = (error as { data?: unknown }).data
    if (data && typeof data === 'object'
      && typeof (data as { error?: unknown }).error === 'string') {
      return (data as { error: string }).error
    }
    if (typeof (error as { code?: unknown }).code === 'string') {
      return (error as { code: string }).code
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
  return slackApiErrorCode(error) === 'channel_not_found'
}

/** A missing channel or thread makes this exact durable reply-scan key unusable. */
export function isTerminalSlackReplyScanError(error: unknown): boolean {
  return ['channel_not_found', 'thread_not_found'].includes(
    slackApiErrorCode(error) ?? '',
  )
}

export function slackReplyScanFailureDisposition(error: unknown): 'discard' | 'defer' {
  return isTerminalSlackReplyScanError(error) ? 'discard' : 'defer'
}

// Slack renders an addressed mention as a token, never as plain text:
// `<@U…>` / `<@U…|label>` for a user, `<!here>` / `<!channel>` / `<!everyone>`
// / `<!subteam^S…>` for a broadcast. Matching the bot's *display name* instead
// would misfire — the reply that first exposed this rule read
// "ゼロくんが作ってくれたCSV…" while being addressed at two humans.
const USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g
// Same pattern without /g: `test` on a global regex carries lastIndex between
// calls, which would make the answer depend on what was asked before it.
const ANY_USER_MENTION_RE = /<@[UW][A-Z0-9]+(?:\|[^>]*)?>/
const BROADCAST_RE = /<!(?:here|channel|everyone)(?:\|[^>]*)?>|<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>/

// A mention inside a quote or a code span is a citation, not an address:
// "> <@alice> の案 / いいね、マージして" is still an instruction to us. Slack
// escapes a typed '>' to '&gt;' in the raw text, so both spellings count.
// An unclosed fence runs to the end, which is how Slack renders it too —
// without that alternative the tail reads as ordinary prose and a mention
// inside it would look like an address.
const QUOTED_SPAN_RE = /```[\s\S]*?```|```[\s\S]*$|`[^`\n]*`|^[ \t]*(?:&gt;|>)+.*$/gm

function withoutQuotedSpans(text: string): string {
  return text.replace(QUOTED_SPAN_RE, ' ')
}

/** Whether `text` carries an explicit `<@bot>` mention token. */
export function mentionsBot(text: string, botUserId: string | undefined): boolean {
  if (!botUserId) return false
  for (const m of text.matchAll(USER_MENTION_RE)) {
    if (m[1] === botUserId) return true
  }
  return false
}

/**
 * Who a thread reply is talking to:
 *
 *   - 'bot'    — mentions the bot (possibly alongside humans). Always for us.
 *   - 'others' — mentions somebody else, or broadcasts, without naming the bot.
 *                Humans @ing each other in a thread the bot happens to own; the
 *                bot chiming in is pure noise.
 *   - 'none'   — no mention at all. In an owned thread the thread itself is the
 *                addressing ("いいね、マージして"), so this stays ours.
 */
export type ThreadReplyAudience = 'bot' | 'others' | 'none'

export function classifyThreadReply(
  text: string,
  botUserId: string | undefined,
): ThreadReplyAudience {
  // Quoted text is set aside first, so citing a colleague before instructing us
  // stays ours rather than being mistaken for mail addressed to them.
  const addressed = withoutQuotedSpans(text)
  if (mentionsBot(addressed, botUserId)) return 'bot'
  if (ANY_USER_MENTION_RE.test(addressed)) return 'others'
  if (BROADCAST_RE.test(addressed)) return 'others'
  // Nobody was addressed in the open. A mention of us that only survives in a
  // quote or code span still counts here — quoting back an old request to us,
  // or a stray backtick shifting every span, must not silently eat a message
  // — but it never outranks somebody else being addressed plainly above.
  return mentionsBot(text, botUserId) ? 'bot' : 'none'
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
  const japanese = /^(?:ゼロくん|zero-?kun|zerokun)(?:を|の)?(?:最新版(?:へ|に)?|本体(?:を)?|コード(?:を)?)?(?:更新|アップデート)(?:して|してください|して下さい|をお願い|お願い|お願いします|をお願いします|を実行して|を実行してください)$/i
  const english = /^(?:please )?(?:(?:update|upgrade) (?:zero[ -]?kun|zerokun)|(?:zero[ -]?kun|zerokun) (?:update|upgrade))(?: now)?$/i
  return japanese.test(normalized) || english.test(normalized)
}

export type CatchupSweepPolicy = {
  channelId: string
  channelType: 'im' | 'channel'
  channelPolicy?: ChannelPolicy
  oldestMs: number
  limit?: number
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
    if (message.subtype && message.subtype !== 'bot_message' && message.subtype !== 'file_share') {
      return false
    }
    if (botUserId && message.user === botUserId) return false

    const isBot = !!message.bot_id
    const senderId = isBot ? message.bot_id : message.user
    if (!senderId) return false
    if (isBotDMBlocked(policy.channelType, isBot)) return false
    if (policy.channelType === 'im') return true

    const isMention = resolveIsMention(false, message.text ?? '', botUserId)
    return decideChannelPolicy(policy.channelPolicy, senderId, isMention, isBot) === 'deliver'
  }).sort((a, b) => parseFloat(a.ts!) - parseFloat(b.ts!))

  return candidates.slice(-limit)
}

/**
 * The poller's per-reply verdict, split out so the wiring — not just the
 * classifier — is covered by tests. `drop-others` is the noise rule; the
 * allowlist is checked first so an unknown channel reports the real reason.
 *
 * The noise rule only applies where `requireMention` is on. A channel with it
 * off has explicitly asked Codex to read everything, and the live path obeys
 * that; filtering here too would make the two paths disagree about the same
 * message depending on which one happened to see it first.
 */
export function decideThreadReplyDelivery(
  policy: ChannelPolicy | undefined,
  reply: SlackReply,
  botUserId: string | undefined,
): 'deliver' | 'drop-policy' | 'drop-others' {
  if (decideChannelPolicy(policy, reply.user!, true, false) !== 'deliver') return 'drop-policy'
  if (!policy?.requireMention) return 'deliver'
  return classifyThreadReply(reply.text ?? '', botUserId) === 'others' ? 'drop-others' : 'deliver'
}

/**
 * How far the poller has now READ, which is not the same as how far it has
 * delivered. Every reply on the page counts — the bot's own posts, system
 * subtypes, replies aimed at other people. Advancing only past delivered
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
  skipped: { reply: SlackReply; reason: 'policy' | 'others' }[]
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
    else plan.skipped.push({ reply, reason: verdict === 'drop-policy' ? 'policy' : 'others' })
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
 * and not a system subtype (channel_join, message_changed, …). `file_share` is
 * kept so image/file uploads in a followed thread still come through. Returned
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
      if (r.bot_id) return false
      if (!r.user) return false
      if (botUserId && r.user === botUserId) return false
      if (r.subtype && r.subtype !== 'file_share') return false
      return true
    })
    .sort((a, b) => parseFloat(a.ts!) - parseFloat(b.ts!))
}
