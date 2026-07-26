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
