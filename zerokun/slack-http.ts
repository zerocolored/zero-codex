export const DEFAULT_SLACK_HTTP_TIMEOUT_MS = 120_000

export function slackHttpTimeoutMs(value = process.env.ZEROKUN_SLACK_HTTP_TIMEOUT_MS): number {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed >= 100 ? parsed : DEFAULT_SLACK_HTTP_TIMEOUT_MS
}

export function slackWebClientOptions(timeout = slackHttpTimeoutMs()): {
  timeout: number
  retryConfig: { retries: number }
} {
  return { timeout, retryConfig: { retries: 0 } }
}

export async function withSlackDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeout = slackHttpTimeoutMs(),
  label = 'Slack request',
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  let rejectTimeout: ((error: Error) => void) | undefined
  const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject })
  const interrupted = () => {
    controller.abort()
    rejectTimeout?.(new Error(`${label} aborted`))
  }
  if (parentSignal?.aborted) interrupted()
  else parentSignal?.addEventListener('abort', interrupted, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    rejectTimeout?.(new Error(`${label} timed out after ${timeout}ms`))
  }, timeout)
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise])
  } catch (error) {
    if (timedOut) throw new Error(`${label} timed out after ${timeout}ms`)
    throw error
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', interrupted)
    controller.abort()
  }
}
