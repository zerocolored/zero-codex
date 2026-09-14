import { classifyAdvisorFailure } from './advisor-availability.ts'

export type RetryableAdvisorResult = {
  adopted?: boolean
  containmentVerified?: boolean
  reason?: unknown
}

/** Retry a finished, contained failure, never an in-flight or adopted slot. */
export async function recoverAdvisorSlot<T extends RetryableAdvisorResult>(options: {
  advisor: 'grok' | 'claude'
  run: () => Promise<T>
  saved?: T
  persist: (result: T) => void
  beforeRetry?: (result: T) => void
  wait?: (ms: number) => Promise<unknown>
}): Promise<T> {
  let result = options.saved ?? await options.run()
  options.persist(result)
  for (let retry = 0; retry < 2 && result.adopted !== true; retry += 1) {
    const { cause } = classifyAdvisorFailure(options.advisor, String(result.reason ?? ''))
    // Authentication and configuration need repair, not blind repeated calls.
    if (result.containmentVerified !== true
      || !['startup', 'timeout', 'response', 'rate-limit'].includes(cause)) break
    await (options.wait ?? Bun.sleep)(30_000 * 2 ** retry)
    options.beforeRetry?.(result)
    result = await options.run()
    options.persist(result)
  }
  return result
}
