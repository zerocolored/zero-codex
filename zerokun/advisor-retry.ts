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
  beforeRun?: () => void
  wait?: (ms: number) => Promise<unknown>
}): Promise<T> {
  const run = async () => {
    // A previous terminal failure must not describe a new in-flight attempt.
    // Persist invalidation before any process or prompt can be started.
    options.beforeRun?.()
    return options.run()
  }
  let result = options.saved ?? await run()
  options.persist(result)
  for (let retry = 0; options.retryFinishedFailure !== false && retry < 2 && result.adopted !== true; retry += 1) {
    const { cause } = result.failure ?? classifyAdvisorFailure(options.advisor, String(result.reason ?? ''))
    // Authentication and configuration need repair, not blind repeated calls.
    if ((options.advisor === 'claude' && result.promptMayHaveBeenDelivered !== false)
      || result.containmentVerified !== true
      || !['startup', 'timeout', 'response', 'rate-limit', 'network', 'auth-check'].includes(cause)) break
    await (options.wait ?? Bun.sleep)(30_000 * 2 ** retry)
    options.beforeRetry?.(result)
    result = await run()
    options.persist(result)
  }
  return result
}
