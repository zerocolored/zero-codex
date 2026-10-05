import { classifyAdvisorFailure, type AdvisorFailure } from './advisor-availability.ts'

export type RetryableAdvisorResult = {
  adopted?: boolean
  containmentVerified?: boolean
  reason?: unknown
  failure?: AdvisorFailure
  promptMayHaveBeenDelivered?: boolean
}

/** Retry a finished, contained failure, never an in-flight or adopted slot. */
export async function recoverAdvisorSlot<T extends RetryableAdvisorResult>(options: {
  advisor: 'grok' | 'claude'
  retryFinishedFailure?: boolean
  run: () => Promise<T>
  saved?: T
  persist: (result: T) => void
  beforeRetry?: (result: T) => void
  onWaiting?: (result: T) => void
  beforeRun?: () => void
  wait?: (ms: number) => Promise<unknown>
  signal?: AbortSignal
}): Promise<T> {
  const run = async () => {
    options.signal?.throwIfAborted()
    // A previous terminal failure must not describe a new in-flight attempt.
    // Persist invalidation before any process or prompt can be started.
    options.beforeRun?.()
    return options.run()
  }
  let result = options.saved ?? await run()
  options.persist(result)
  for (let retry = 0; options.retryFinishedFailure !== false && result.adopted !== true; retry += 1) {
    options.signal?.throwIfAborted()
    const { cause } = result.failure ?? classifyAdvisorFailure(options.advisor, String(result.reason ?? ''))
    // Recheck contained authentication failures after repair. OAuth remains
    // single-flight and independently budgeted by the panel.
    if ((options.advisor === 'claude' && result.promptMayHaveBeenDelivered !== false)
      || result.containmentVerified !== true
      || !['startup', 'timeout', 'response', 'rate-limit', 'network', 'auth-check', 'connection', 'authentication'].includes(cause)) break
    options.onWaiting?.(result)
    const delay = Math.min(300_000, 30_000 * 2 ** Math.min(retry, 4))
    if (options.wait) await options.wait(delay)
    else {
      const { setTimeout } = await import('node:timers/promises')
      await setTimeout(delay, undefined, { signal: options.signal })
    }
    options.signal?.throwIfAborted()
    options.beforeRetry?.(result)
    result = await run()
    options.persist(result)
  }
  return result
}
