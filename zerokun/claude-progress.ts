import { codexProgressClientMessageId, latestDueCodexProgressSlot, type CodexProgressSchedule, type CodexProgressReport } from './codex-executor.ts'
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'

/** Publish only an actual primary-model update. Cadence, durable outbox and
 * control priority stay host-owned; no extra model turn interrupts the work. */
export class ClaudeProgress {
  private nextSlot = 0
  private retryAt = 0
  private lastPublishedAt = 0
  private begun = new Set<number>()
  constructor(private options: {
    jobId: string; attempt: number; path: string; activatedAt: number
    schedule?: CodexProgressSchedule
    begin?(probe: { slot: number; clientMessageId: string }): boolean
    publish?(report: CodexProgressReport): boolean
  }) {}
  tick(priorityPending: boolean, now = Date.now()): void {
    const o = this.options
    if (priorityPending || !o.publish || now < this.retryAt) return
    const slot = latestDueCodexProgressSlot(o.activatedAt, now, this.nextSlot, o.schedule)
    if (slot === null) return
    try {
      const raw = readOptionalBoundedOwnerOnlyRegularFile(o.path, 32 * 1024)
      if (!raw) return
      const value = JSON.parse(raw)
      if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 3000
        || !Number.isSafeInteger(value.updatedAt) || value.updatedAt <= this.lastPublishedAt || value.updatedAt > now) return
      if (!this.begun.has(slot)) {
        if (o.begin?.({ slot, clientMessageId: codexProgressClientMessageId(o.jobId, o.attempt, slot) }) === false) return
        this.begun.add(slot)
      }
      if (o.publish({ slot, elapsedMs: now - o.activatedAt, text: value.text }) !== true) { this.retryAt = now + 1000; return }
      this.nextSlot = slot + 1
      this.lastPublishedAt = value.updatedAt
      this.retryAt = 0
    } catch { this.retryAt = now + 1000 }
  }
}
