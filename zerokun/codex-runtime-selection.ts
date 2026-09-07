/**
 * Zeroちゃんのprimary Codex runtime selection.
 *
 * Keep this in release code instead of environment or user Codex config so
 * every installed machine starts the same primary workflow. Advisor model
 * selection is governed separately by AGENTS.md.
 */
export const ZEROCHAN_PRIMARY_CODEX_MODEL = 'gpt-6-astra' as const
export const ZEROCHAN_PRIMARY_CODEX_REASONING_EFFORT = 'low' as const
