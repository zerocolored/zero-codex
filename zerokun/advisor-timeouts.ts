// Keep the model's budget and the outer drain deadline in the same contract.
export const GROK_REVIEW_TIMEOUT_MS = 60 * 60_000
export const GROK_OAUTH_TIMEOUT_MS = 10 * 60_000

// Existing OAuth recovery may run one initial attempt, one login, then one
// fresh attempt. The parent must not reap that last attempt before its hour.
// This also covers Claude's startup + one-hour acquisition + cleanup.
export const ADVISOR_SETTLEMENT_TIMEOUT_MS =
  2 * GROK_REVIEW_TIMEOUT_MS + GROK_OAUTH_TIMEOUT_MS + 5 * 60_000
