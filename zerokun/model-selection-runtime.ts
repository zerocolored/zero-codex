import { AuditModelError, collectAuditModelDiagnostic } from './audit-model-failure.ts'
import { STORAGE_FAILURE } from './storage-failure.ts'

export type ModelSelectionRuntimeReason = 'transport' | 'throttled' | 'capacity' | 'unclassified'
  | 'invalid-output' | 'authentication' | 'quota' | 'disk-full' | 'configuration' | 'runtime'

/** Infrastructure is not an unresolved user model choice. Never retain raw stderr. */
export class ModelSelectionRuntimeError extends Error {
  readonly retryable: boolean
  readonly code?: 'ENOSPC'
  constructor(readonly reason: ModelSelectionRuntimeReason, readonly exitCode?: number, readonly exhausted = false) {
    super(reason === 'disk-full' ? STORAGE_FAILURE
      : `ZERO_INPUT_CHECK_RUNTIME:${reason}${exitCode === undefined ? '' : ` (exit=${exitCode})`}`)
    this.name = 'ModelSelectionRuntimeError'
    this.retryable = !exhausted && ['transport', 'throttled', 'capacity', 'unclassified', 'invalid-output', 'quota'].includes(reason)
    if (reason === 'disk-full') this.code = 'ENOSPC'
  }
}

export function modelSelectionProcessFailure(exitCode: number, diagnostic: string): ModelSelectionRuntimeError {
  const classified = new AuditModelError(exitCode, diagnostic).reason as ModelSelectionRuntimeReason
  const reason = classified === 'unclassified'
    && /unexpected argument|unknown (?:argument|option|flag)|unsupported_parameter|invalid_request_error|model.*(?:not found|not supported|does not exist)/i.test(diagnostic)
    ? 'configuration' : classified
  return new ModelSelectionRuntimeError(reason, exitCode)
}

/** Human-readable stderr echoes the user's prompt. Only native JSON error
 * events are evidence of failure, never assistant text or prompt examples. */
export async function collectModelSelectionDiagnostic(stream: ReadableStream<Uint8Array>): Promise<string> {
  const tail = await collectAuditModelDiagnostic(stream)
  let diagnostic = ''
  for (const line of tail.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue
      const message = event.type === 'error' ? event.message
        : event.type === 'turn.failed' ? event.error?.message : undefined
      if (typeof message === 'string') diagnostic = message
    } catch { /* A truncated event is not evidence about the failure cause. */ }
  }
  return diagnostic
}

export function modelSelectionRetryDelay(attempt: number): number {
  return [5_000, 15_000, 30_000][attempt] ?? 60_000
}

export function publicModelSelectionRuntimeFailure(error: string): string | null {
  const reason = /ZERO_INPUT_CHECK_RUNTIME:([a-z-]+)(?=[\s"\\}]|$)/.exec(error)?.[1]
  if (!reason) return null
  if (reason === 'authentication') return '入力の確認処理でCodexの認証に失敗しました。依頼と作業内容は保持しています。認証の復旧後、同じスレッドで再開できます。'
  if (reason === 'quota') return '入力の確認処理でCodexの利用上限が報告されました。依頼と作業内容は保持しています。利用可能になった後、同じスレッドで再開できます。'
  return '入力の確認処理を実行できませんでした。依頼と作業内容は保持しています。実行環境の復旧後、同じスレッドで再開できます。'
}
