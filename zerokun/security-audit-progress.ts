import type { JobRecord, JobExecutionContext } from './job-runner.ts'
import { codexProgressClientMessageId, latestDueCodexProgressSlot } from './codex-executor.ts'
import { createHash } from 'crypto'
import { checkAuditInterrupted } from './security-audit-tools.ts'

/** Queue acknowledgement alone is insufficient: scanning waits for the Slack delivery receipt. */
export async function deliverAuditMilestone(
  job: Pick<JobRecord, 'id' | 'attempts'>,
  phase: 'checking' | 'ready',
  text: string,
  context: Pick<JobExecutionContext, 'reportCommentary'>,
  delivered: (sourceKey: string) => boolean,
  controls: { signal?: AbortSignal; cancelled?: () => boolean } = {},
  timeoutMs = 120_000,
): Promise<void> {
  const sourceKey = createHash('sha256').update(`security-audit-v2\0${job.id}\0${job.attempts}\0${phase}`).digest('hex')
  checkAuditInterrupted(controls)
  if (!context.reportCommentary({ sourceKey, text })) throw Error('利用可能チェックの案内を保存できないため、本検査を開始しません。')
  const deadline = Date.now() + timeoutMs
  while (!delivered(sourceKey)) {
    checkAuditInterrupted(controls)
    if (Date.now() >= deadline) throw Error('利用可能チェックの案内をSlackへ配信できたことを確認できないため、本検査を開始しません。')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  checkAuditInterrupted(controls)
}

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
