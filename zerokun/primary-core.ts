/** The old `claude` runtime belongs to the retired bridge, never the new core. */
export type PrimaryCore = 'codex' | 'claude-code'
export type JobRuntime = PrimaryCore | 'claude'

export const DEFAULT_PRIMARY_CORE: PrimaryCore = 'codex'

export function isPrimaryCore(value: unknown): value is PrimaryCore {
  return value === 'codex' || value === 'claude-code'
}

export function parsePrimaryCore(value: string): PrimaryCore {
  if (value === 'claude') return 'claude-code'
  if (isPrimaryCore(value)) return value
  throw new Error('主担当は codex または claude を指定してください')
}

export function primaryCoreLabel(core: PrimaryCore): string {
  return core === 'claude-code' ? 'Claude Code（最新Opus）' : 'Codex'
}
