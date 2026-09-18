/** Classify only a bound App Server error, never assistant/tool output. */
export function isTransientCodexNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false
  const record = error as Record<string, unknown>
  const info = record.codexErrorInfo
  const variant = typeof info === 'string' ? info
    : info && typeof info === 'object' && !Array.isArray(info) ? Object.keys(info)[0] : null
  if (!['responseStreamConnectionFailed', 'responseStreamDisconnected',
    'responseTooManyFailedAttempts', 'httpConnectionFailed', 'internalServerError'].includes(variant ?? '')) return false
  if (['unsupported_parameter', 'invalid_request_error', 'invalid_api_key', 'permission_denied'].includes(String(record.code ?? ''))) return false
  const details = info && typeof info === 'object' && !Array.isArray(info)
    ? Object.values(info)[0] : null
  const status = details && typeof details === 'object'
    ? (details as Record<string, unknown>).httpStatusCode : undefined
  // An HTTP response is stronger evidence than a connection-failure label.
  // Quota is handled separately; bad requests/auth/config cannot heal by waiting.
  if (typeof status === 'number') return status === 408 || [500, 502, 503, 504].includes(status)
  return true
}

export const CODEX_NETWORK_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const

export const CODEX_NETWORK_CONTINUATION = [
  '--- Transport recovery: continue the SAME task, not a new request ---',
  'The previous turn ended with a transient upstream connection failure.',
  'Retain this thread history, completed work, approvals, advisor answers, and existing files.',
  'First reconcile the last tool outcome and current local/remote state. Do not blindly replay',
  'commands, commits, merges, deployments, API writes, or Slack posts that may already have succeeded.',
  'Continue only the remaining work. Do not restart design/review just because transport recovered.',
  'The following current binding/input updates context; it is NOT a request to repeat completed work.',
].join('\n')
