/**
 * Pure access-policy helpers for the Slack channel plugin.
 *
 * Extracted from server.ts so the policy decisions can be unit-tested
 * without spinning up the Slack/MCP runtime. server.ts imports these.
 */

export type ChannelPolicy = {
  requireMention: boolean
  allowFrom: string[]
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

// ── Thread catch-up poller helpers ───────────────────────────────────────────
//
// The bridge only receives an inbound event for a channel message when the
// sender @mentions the bot (app_mention) — a follow-up reply in a thread the
// bot already owns, posted WITHOUT a re-mention, never reaches Claude. On top
// of that, Socket Mode has no durable queue, so any event that arrives while no
// Claude session is consuming is simply lost. The poller closes both gaps by
// periodically re-reading `conversations.replies` for the threads the bot
// already owns (the threads.json map is itself the subscription list) and
// delivering replies newer than a per-thread cursor. These pure helpers hold
// the ts arithmetic and the "which replies are new" decision so they can be
// unit-tested without the Slack runtime.

export type SlackReply = {
  ts?: string
  user?: string
  bot_id?: string
  subtype?: string
  text?: string
  files?: { id: string }[]
}

/** Slack ts ("1712345678.000200") → epoch milliseconds. */
export function slackTsToMs(ts: string): number {
  return Math.round(parseFloat(ts) * 1000)
}

/** Epoch milliseconds → Slack ts string, usable as a `conversations.replies` cursor. */
export function msToSlackTs(ms: number): string {
  return (ms / 1000).toFixed(6)
}

// Slack renders an addressed mention as a token, never as plain text:
// `<@U…>` / `<@U…|label>` for a user, `<!here>` / `<!channel>` / `<!everyone>`
// / `<!subteam^S…>` for a broadcast. Matching the bot's *display name* instead
// would misfire — the reply that first exposed this rule read
// "ゼロくんが作ってくれたCSV…" while being addressed at two humans.
const USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g
const BROADCAST_RE = /<!(?:here|channel|everyone)(?:\|[^>]*)?>|<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>/

// A mention inside a quote or a code span is a citation, not an address:
// "> <@alice> の案 / いいね、マージして" is still an instruction to us. Slack
// escapes a typed '>' to '&gt;' in the raw text, so both spellings count.
const QUOTED_SPAN_RE = /```[\s\S]*?```|`[^`\n]*`|^[ \t]*(?:&gt;|>)+.*$/gm

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
  // Quoted text is stripped first, so citing a colleague before instructing us
  // stays 'none' rather than being mistaken for mail addressed to them.
  const addressed = withoutQuotedSpans(text)
  let sawUserMention = false
  for (const m of addressed.matchAll(USER_MENTION_RE)) {
    if (botUserId && m[1] === botUserId) return 'bot'
    sawUserMention = true
  }
  if (sawUserMention) return 'others'
  return BROADCAST_RE.test(addressed) ? 'others' : 'none'
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
 * The poller's per-reply verdict, split out so the wiring — not just the
 * classifier — is covered by tests. `drop-others` is the noise rule; the
 * allowlist is checked first so an unknown channel reports the real reason.
 *
 * The noise rule only applies where `requireMention` is on. A channel with it
 * off has explicitly asked Claude to read everything, and the live path obeys
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

/**
 * Where to resume reading a thread.
 *
 * `seenTs` — the poller's own persisted high-water mark — is authoritative.
 * `lastActivityMs` (the dispatcher's wall clock, written AFTER a dispatch
 * finished) only seeds a thread we have never polled, so adopting an old
 * thread does not replay its human backlog. It deliberately does NOT act as a
 * floor afterwards: it sorts above replies posted while the agent was still
 * working, and using it as one made those replies unreachable forever.
 */
export function threadPollCursor(
  seenTs: string | undefined,
  lastActivityMs: number | undefined,
  threadTs: string,
): string {
  if (seenTs) return seenTs
  return lastActivityMs ? msToSlackTs(lastActivityMs) : threadTs
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
