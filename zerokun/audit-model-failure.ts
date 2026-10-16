/** Diagnostics are classified in memory; raw model stderr never enters a report. */
export class AuditModelError extends Error {
  readonly retryable: boolean
  readonly reason: string
  constructor(readonly exitCode: number, diagnostic: string) {
    const reason = /no space left|ENOSPC/i.test(diagnostic) ? 'disk-full'
      : /insufficient.quota|usage.limit|quota.exhausted/i.test(diagnostic) ? 'quota'
      : /unauthori[sz]ed|not signed in|authentication|\b401\b|\b403\b/i.test(diagnostic) ? 'authentication'
      : /rate.limit|too many requests|\b429\b/i.test(diagnostic) ? 'throttled'
      : /at capacity|overloaded|\b50[234]\b/i.test(diagnostic) ? 'capacity'
      : /timeout|timed out|connection reset|ECONNRESET|stream disconnected|TLS|DNS/i.test(diagnostic) ? 'transport'
      : 'unclassified'
    super(`監査モデルの実行失敗 (exit=${exitCode}; reason=${reason})`)
    this.name = 'AuditModelError'
    this.reason = reason
    this.retryable = ['throttled', 'capacity', 'transport'].includes(reason)
  }
}

export async function collectAuditModelDiagnostic(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let tail = Buffer.alloc(0)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // Drain continuously to avoid a full pipe blocking the model. Bound retained bytes.
      tail = Buffer.concat([tail, value.subarray(Math.max(0, value.length - 32_768))]).subarray(-32_768)
    }
  } finally { reader.releaseLock() }
  return tail.toString('utf8')
}

export async function auditRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('model interrupted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, ms)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new DOMException('model interrupted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
