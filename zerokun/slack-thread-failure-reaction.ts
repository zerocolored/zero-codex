import { WebClient } from '@slack/web-api'
import { structuredSlackApiErrorCode } from '../gate.ts'
import type { JobStore, SlackThreadFailureReaction } from './job-runner.ts'

/** Keep 429/Retry-After off the gateway's shared request queue. The SDK's
 * retries: 0 alone still pauses its entire client queue on a 429 response. */
export function createSlackThreadFailureReactionApplier(
  token: string,
  options: { slackApiUrl?: string; timeout?: number } = {},
): (reaction: SlackThreadFailureReaction) => Promise<void> {
  const client = new WebClient(token, {
    ...options,
    timeout: options.timeout ?? 10_000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  })
  return async reaction => {
    const input = { channel: reaction.chatId, timestamp: reaction.messageId, name: 'x' }
    const response = reaction.desired
      ? await client.reactions.add(input)
      : await client.reactions.remove(input)
    if (!response.ok) throw { data: { error: response.error } }
  }
}

/** An independent, durable outbox. Reaction outages never gate admission. */
export function createSlackThreadFailureReactionDrainer(options: {
  store: JobStore
  apply: (reaction: SlackThreadFailureReaction) => Promise<void>
  now?: () => number
  warn?: () => void
}): () => Promise<void> {
  const now = options.now ?? Date.now
  let running: Promise<void> | null = null
  return () => {
    if (running) return running
    const sync = async () => {
      // A second bounded pass promptly removes an x whose add was in flight
      // when classification recovered. Per-message calls never overlap.
      for (let pass = 0; pass < 2; pass++) {
        const due = options.store.listDueSlackThreadFailureReactions(now())
        await Promise.all(due.map(async reaction => {
          try {
            try {
              await options.apply(reaction)
            } catch (error) {
              const code = structuredSlackApiErrorCode(error)
              // A deleted message has no reaction left to synchronize. Keep an
              // active failure receipt until classification settles, as for a
              // successful add, so repeated failures do not re-add forever.
              if (code !== 'message_not_found'
                && code !== (reaction.desired ? 'already_reacted' : 'no_reaction')) throw error
            }
            options.store.settleSlackThreadFailureReaction(reaction)
          } catch {
            options.store.deferSlackThreadFailureReaction(reaction, now() + 30_000)
            options.warn?.()
          }
        }))
      }
    }
    running = sync().catch(() => { options.warn?.() }).finally(() => { running = null })
    return running
  }
}
