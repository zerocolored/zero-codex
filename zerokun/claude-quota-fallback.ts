import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'

export const FABLE_ADVISOR_MODEL = 'claude-fable-5-1' as const
export const OPUS_ADVISOR_MODEL = 'claude-opus-5-5' as const
export type ClaudeAdvisorModel = typeof FABLE_ADVISOR_MODEL | typeof OPUS_ADVISOR_MODEL
export const CLAUDE_QUOTA_FALLBACK_NOTICE = 'Fable の利用上限のため Opus 5.5 に切り替えました。'

/** The round lock owns this file. Claim durably before starting any Opus process.
 * An interrupted claimed attempt is never replayed: delivery may have happened.
 * Other advisors and the primary task retain their usual continuation policy.
 */
export async function withClaudeQuotaFallback(options: {
  path: string
  run: (model: ClaudeAdvisorModel) => Promise<Record<string, unknown>>
  retire: (fable: Record<string, unknown>) => void
}): Promise<Record<string, unknown>> {
  const raw = readOptionalBoundedOwnerOnlyRegularFile(options.path, 8 * 1024 * 1024)
  if (raw !== null) {
    const saved = JSON.parse(raw)
    if (saved.version !== 1 || !['claimed', 'finished'].includes(saved.status)) throw new Error('Invalid Claude fallback state')
    if (saved.status === 'finished') return saved.result
    return { attempted: true, adopted: false, required: true, lifecycle: 'ephemeral-v2',
      model: OPUS_ADVISOR_MODEL, fallbackFrom: FABLE_ADVISOR_MODEL, fallbackReason: 'fable-quota',
      executionState: 'start-unconfirmed', promptMayHaveBeenDelivered: true,
      failure: { advisor: 'claude', cause: 'interrupted' },
      reason: 'Opus fallback was already claimed; preserve its retained execution without resending',
      fableAttempt: saved.fableAttempt }
  }
  const fable = await options.run(FABLE_ADVISOR_MODEL)
  if (fable.adopted === true || fable.quotaScope !== 'fable'
    || fable.cleanupVerified !== true || fable.containmentVerified !== true) return fable
  atomicWritePrivateFile(options.path, JSON.stringify({ version: 1, status: 'claimed', fableAttempt: fable }))
  options.retire(fable)
  const opus = await options.run(OPUS_ADVISOR_MODEL)
  const result = { ...opus, model: OPUS_ADVISOR_MODEL, fallbackFrom: FABLE_ADVISOR_MODEL,
    fallbackReason: 'fable-quota', fallbackNotice: CLAUDE_QUOTA_FALLBACK_NOTICE, fableAttempt: fable }
  atomicWritePrivateFile(options.path, JSON.stringify({ version: 1, status: 'finished', result }))
  return result
}
