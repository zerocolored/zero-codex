/** A throttle response is not evidence that the subscription quota is exhausted. */
export type CodexRateLimitReason = 'rate-limit' | 'capacity' | 'throttled'
export type CodexRateLimitInfo = {
  rateLimited: boolean
  resetsAtMs: number | null
  reason: CodexRateLimitReason | null
}

export const THROTTLE_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000] as const
export const THROTTLE_NOTICE_INTERVAL_MS = 15 * 60_000

export function throttleRetryDelay(previousFailures = 0): number {
  const index = Number.isFinite(previousFailures) ? Math.max(0, Math.floor(previousFailures)) : 0
  return THROTTLE_RETRY_DELAYS_MS[Math.min(index, THROTTLE_RETRY_DELAYS_MS.length - 1)]!
}

function resetCandidates(value: unknown, now: number, depth = 0): number[] {
  if (depth > 6 || !value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(item => resetCandidates(item, now, depth + 1))
  const record = value as Record<string, unknown>
  const direct = Object.entries(record).flatMap(([key, value]) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return []
    let time: number
    if (key === 'retry_after' || key === 'retryAfter') time = now + value * 1000
    else if (['resets_at', 'reset_at', 'resetsAt', 'resetAt'].includes(key)) {
      time = value >= 1_000_000_000_000 ? value : value * 1000
    } else return []
    return Number.isSafeInteger(Math.floor(time)) ? [Math.floor(time)] : []
  })
  return [...direct, ...Object.values(record).flatMap(item => resetCandidates(item, now, depth + 1))]
}

/** Input must be a projected failure record, never conversation/tool content. */
export function classifyCodexFailure(
  failure: Record<string, unknown> | undefined,
  now = Date.now(),
  previousFailures = 0,
): CodexRateLimitInfo {
  const text = JSON.stringify(failure ?? {})
  const usage = /(?:usage[ _-]?limit|insufficient[ _-]?quota|quota[ _-]?(?:exceeded|exhausted)|exceeded[^\n]{0,30}quota)/i.test(text)
  const capacity = /(?:selected model is at capacity|model[^\n]{0,80}\bat capacity\b|temporarily (?:overloaded|unavailable)|server (?:is )?overloaded)/i.test(text)
  const throttle = /(?:rate[ _-]?limit|too many requests|\b429\b)/i.test(text)
  const reason = usage ? 'rate-limit' : capacity ? 'capacity' : throttle ? 'throttled' : null
  if (!reason) return { rateLimited: false, resetsAtMs: null, reason: null }
  const times = resetCandidates(failure, now)
  const reset = times.length ? Math.max(...times) : null
  return {
    rateLimited: true,
    reason,
    resetsAtMs: reset !== null && (reason !== 'throttled' || reset > now) ? reset
      : now + (reason === 'rate-limit' ? 3_600_000 : reason === 'capacity' ? 60_000 : throttleRetryDelay(previousFailures)),
  }
}

export function codexRateLimitResumeAt(
  resetsAtMs: number,
  now = Date.now(),
  reason: CodexRateLimitReason = 'rate-limit',
): number {
  if (!Number.isFinite(resetsAtMs) || !Number.isFinite(now)) throw new Error('Codex rate-limit time is invalid')
  // A locally selected throttle backoff already includes its entire wait.
  // Preserve the existing quota/capacity cushion and honor provider Retry-After.
  return Math.max(Math.floor(now) + (reason === 'throttled' ? 1000 : 100),
    Math.floor(resetsAtMs) + (reason === 'throttled' ? 0 : 60_000))
}

/** Only recover the exact old transport-429 diagnostic, with no provider reset. */
export function legacyTransportThrottle(error: string | null): boolean {
  if (!error || error.length > 16_384) return false
  const lines = error.split('\n')
  if (!/^Codex が exit code \d+ で終了しました。$/.test(lines[0] ?? '')) return false
  let record: Record<string, unknown>
  try { record = JSON.parse(lines[1] ?? '') } catch { return false }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false
  const failure = record.error as Record<string, unknown> | undefined
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)
    || failure.message !== 'exceeded retry limit, last status: 429 Too Many Requests') return false
  const info = failure.codexErrorInfo as Record<string, unknown> | undefined
  const attempts = info?.responseTooManyFailedAttempts as Record<string, unknown> | undefined
  if (attempts?.httpStatusCode !== 429) return false
  // Do not infer missing timing information from a truncated or partial diagnostic.
  if (/"(?:retry_after|retryAfter|reset_at|resets_at|resetAt|resetsAt)"\s*:/.test(lines[1]!)) return false
  return classifyCodexFailure(record).reason === 'throttled'
}
