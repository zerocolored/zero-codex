import { modelSelectionProcessFailure, type ModelSelectionRuntimeReason } from './model-selection-runtime.ts'
import { STORAGE_FAILURE } from './storage-failure.ts'

/** Persist only a bounded reason, never native diagnostics or the user's text. */
export class SlackThreadIntentRuntimeError extends Error {
  readonly code?: 'ENOSPC'
  constructor(readonly reason: ModelSelectionRuntimeReason, readonly exitCode?: number) {
    super(reason === 'disk-full' ? STORAGE_FAILURE
      : `ZERO_THREAD_INTENT_RUNTIME:${reason}${exitCode === undefined ? '' : ` (exit=${exitCode})`}`)
    this.name = 'SlackThreadIntentRuntimeError'
    if (reason === 'disk-full') this.code = 'ENOSPC'
  }
}

export function slackThreadIntentProcessFailure(exitCode: number, diagnostic: string): SlackThreadIntentRuntimeError {
  return new SlackThreadIntentRuntimeError(modelSelectionProcessFailure(exitCode, diagnostic).reason, exitCode)
}

/** Keep saved posts retrying promptly after recovery, even after a long outage. */
export function slackThreadIntentRetryDelay(attempt: number): number {
  return attempt <= 1 ? 30_000 : 60_000
}
