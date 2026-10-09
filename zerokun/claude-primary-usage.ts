import { createHash } from 'crypto'
import { join } from 'path'
import { atomicWritePrivateFile } from './safe-file.ts'
import { ensureManagedDirectory } from './managed-path.ts'
import { claudeRootEvent, claudeResult, type ClaudeEvent } from './claude-control-session.ts'

/** Project only this job's new assistant-message counters. Never reread an
 * entire resumed conversation and charge preceding jobs for the same tokens. */
export class ClaudePrimaryUsage {
  private rows = new Map<string, { model: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } }>()
  private partial = false
  private active = false
  private path: string
  private sessionKey: string
  constructor(state: string, jobId: string, attempt: string) {
    const root = ensureManagedDirectory(state, join(state, 'task-usage-claude', jobId))
    this.path = join(root, `primary-${attempt}.json`)
    this.sessionKey = createHash('sha256').update(`${jobId}:${attempt}`).digest('hex')
  }
  begin(): void { this.active = true; this.persist() }
  observe(event: ClaudeEvent): void {
    if (!claudeRootEvent(event)) return
    if (event.type === 'assistant') {
      const message = event.message as any, usage = message?.usage
      if (event.error) return
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(message?.id ?? '')
        || !/^claude-[A-Za-z0-9._-]+$/.test(message?.model ?? '') || !usage) { this.partial = true; return }
      const tokens = { input: usage.input_tokens, output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 }
      if (Object.values(tokens).some(value => !Number.isSafeInteger(value) || value < 0) || this.rows.size >= 10_000) {
        this.partial = true; return
      }
      this.rows.set(message.id, { model: message.model, tokens })
      this.persist()
    }
    if (claudeResult(event)) { this.active = false; this.persist() }
  }
  close(): void { this.partial ||= this.active; this.persist() }
  private persist(): void {
    try {
      atomicWritePrivateFile(this.path, JSON.stringify({ version: 1, sessionKey: this.sessionKey,
        status: this.rows.size ? this.partial || this.active ? 'partial' : 'reported' : 'unavailable',
        rows: [...this.rows.values()] }))
    } catch { this.partial = true } // Accounting infrastructure is never task completion authority.
  }
}
