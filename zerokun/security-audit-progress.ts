import type { JobRecord, JobExecutionContext } from './job-runner.ts'
import { codexProgressClientMessageId, latestDueCodexProgressSlot } from './codex-executor.ts'

/** Audit status uses the same durable progress cadence as ordinary jobs. */
export function createSecurityAuditProgress(
  job: Pick<JobRecord, 'id' | 'attempts'>,
  context: Pick<JobExecutionContext, 'progressActivatedAtMs' | 'beginProgressProbe' | 'reportProgress' | 'supersedeProgressProbe'>,
  mirror: (text: string) => void,
  warn: (message: string) => void,
  now = Date.now,
) {
  let text = '', nextSlot = 0, pendingSlot: number | null = null, closed = false
  const flush = () => {
    if (closed || !text) return
    const timestamp = now()
    const slot = latestDueCodexProgressSlot(context.progressActivatedAtMs, timestamp, nextSlot)
    if (slot === null) return
    try {
      if (pendingSlot !== null && pendingSlot < slot) context.supersedeProgressProbe(pendingSlot, slot)
      pendingSlot = slot
      if (!context.beginProgressProbe({ slot, clientMessageId: codexProgressClientMessageId(job.id, job.attempts, slot) })) return
      if (context.reportProgress({ slot, elapsedMs: timestamp - context.progressActivatedAtMs, text })) {
        nextSlot = slot + 1
        pendingSlot = null
      }
    } catch { warn('security audit progress delivery will retry through the existing job lifecycle') }
  }
  const timer = setInterval(flush, 30_000)
  timer.unref()
  return {
    report(message: string) {
      if (closed) return
      text = message
      mirror(message)
      flush()
    },
    flush,
    close() { closed = true; clearInterval(timer) },
  }
}
