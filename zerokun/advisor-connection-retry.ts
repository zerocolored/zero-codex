/** Retry observations only. Never wrap prompt delivery or external mutations. */
export async function retryAdvisorConnection<T>(options: {
  read: () => Promise<T>
  retryable: (error: unknown) => boolean
  onRetry?: (error: unknown, attempt: number) => void
  signal?: AbortSignal
  wait?: (ms: number) => Promise<unknown>
}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted()
    try { return await options.read() }
    catch (error) {
      options.signal?.throwIfAborted()
      if (!options.retryable(error)) throw error
      options.onRetry?.(error, attempt + 1)
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5))
      if (options.wait) await options.wait(delay)
      else await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(options.signal!.reason) }
        const timer = setTimeout(() => {
          options.signal?.removeEventListener('abort', cancel)
          resolve()
        }, delay)
        options.signal?.addEventListener('abort', cancel, { once: true })
        if (options.signal?.aborted) cancel()
      })
    }
  }
}
