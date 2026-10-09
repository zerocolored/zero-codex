import { claudeRootEvent, claudeResult, type ClaudeEvent } from './claude-control-session.ts'

/** Only structured native evidence classifies a wait. Model prose, a socket
 * failure or a lost ACK never authorizes replay or authentication changes. */
export class ClaudeTurnFailure {
  private error: string | undefined
  private resetAt: number | undefined
  observe(event: ClaudeEvent): void {
    if (!claudeRootEvent(event)) return
    if (event.type === 'assistant' && typeof event.error === 'string') this.error = event.error
    if (event.type === 'rate_limit_event') {
      const info = event.rate_limit_info as Record<string, unknown> | undefined
      if (info?.status === 'rejected' && typeof info.resetsAt === 'number'
        && Number.isSafeInteger(info.resetsAt) && info.resetsAt > 0
        && Number.isSafeInteger(info.resetsAt * 1000)) this.resetAt = info.resetsAt * 1000
      else if (info?.status === 'allowed') this.resetAt = undefined
    }
  }
  terminal(event: ClaudeEvent, now = Date.now()): { reason: 'rate-limit' | 'capacity'; resumeAt: number } | null {
    if (claudeResult(event)?.kind !== 'failed') return null
    const status = event.api_error_status
    if (status === 401 || status === 402 || status === 403
      || ['authentication_failed', 'billing_error', 'invalid_request'].includes(this.error ?? '')) return null
    if (status === 429 || this.error === 'rate_limit') {
      return { reason: 'rate-limit', resumeAt: this.resetAt && this.resetAt > now
        && this.resetAt < now + 366 * 24 * 60 * 60 * 1000 ? this.resetAt : now + 5 * 60 * 1000 }
    }
    if (typeof status === 'number' && [500, 502, 503, 504, 529].includes(status)) {
      return { reason: 'capacity', resumeAt: now + 30_000 }
    }
    return null
  }
}
