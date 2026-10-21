import { randomUUID } from 'crypto'
import { AdvisorFailureError } from './advisor-availability.ts'
import { prepareClaudeJobContext } from './claude-job-context.ts'
import { assertClaudeMainlineReady } from './claude-mainline-runtime.ts'
import { ClaudeControlSession, ClaudeDeliveryUnknownError, ClaudeProtocolError, claudeRootEvent, claudeResult, type ClaudeEvent } from './claude-control-session.ts'
import { openClaudeHerdrTransport } from './claude-herdr-transport.ts'
import { claudeQuotaScope } from './claude-quota-fallback.ts'
import type { DelegationContext } from './claude-delegation-broker.ts'

type Stage = 'authentication' | 'preparation' | 'startup' | 'initialize' | 'dispatch' | 'execution' | 'cleanup' | 'persistence'
const REASONS = {
  'fable-quota': 'Fable の利用上限に達しています。',
  'rate-limit': 'Claude の利用上限またはリクエスト制限に達しています。',
  authentication: 'Claude の認証を確認できませんでした。',
  preparation: 'Claude の実行設定を準備できませんでした。',
  startup: 'Claude の起動を確認できませんでした。',
  protocol: 'Claude との通信または指定モデルの照合に失敗しました。',
  'delivery-unknown': 'Claude への依頼の送達を確認できません。重複実行を避けるため再送していません。',
  'native-error': 'Claude が依頼をエラーで終了しました。',
  cleanup: 'Claude の終了処理を確認できないため、別モデルを起動していません。',
  cancelled: 'Claude への依頼を中断しました。',
  persistence: '実行記録または切替通知を保存できないため、追加の実行を停止しました。',
  unknown: 'Claude の委譲処理で内部エラーが発生しました。',
} as const
export type DelegationFailure = {
  stage: Stage; code: keyof typeof REASONS; reason: string
  quotaScope?: 'fable' | 'other'; retrySafe: boolean; cleanupVerified: boolean
  priorCode?: keyof typeof REASONS
}
export function delegationFailure(stage: Stage, code: keyof typeof REASONS): DelegationFailure {
  return { stage, code, reason: REASONS[code], retrySafe: false, cleanupVerified: false }
}
export class ClaudeDelegationError extends Error {
  constructor(readonly failure: DelegationFailure) { super(failure.reason) }
}

/** Observe native errors only. Never classify quotes, tool output or normal assistant text as a quota rejection. */
export class DelegationAttemptObservation {
  private worked = false
  private quota?: 'fable' | 'other'
  private nativeError = false
  observe(event: ClaudeEvent): void {
    if (event.type === 'assistant' && claudeRootEvent(event)) {
      const message = event.message as { model?: unknown; content?: Array<{ type?: string; text?: string }> } | undefined
      if (typeof event.error === 'string' && message?.model === '<synthetic>'
        && event.isApiErrorMessage !== false) {
        this.nativeError = true
        if (event.error === 'rate_limit') {
          const text = Array.isArray(message.content) ? message.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') : ''
          this.quota = claudeQuotaScope(text) ?? 'other'
        }
        return
      }
      this.worked = true
    } else if (['assistant', 'stream_event', 'tool_use', 'tool_result', 'tool_progress', 'control_request'].includes(event.type)) {
      this.worked = true
    }
  }
  failure(): DelegationFailure {
    const failure = delegationFailure('execution', this.quota === 'fable' ? 'fable-quota'
      : this.quota ? 'rate-limit' : 'native-error')
    failure.quotaScope = this.quota
    failure.retrySafe = this.nativeError && this.quota === 'fable' && !this.worked
    return failure
  }
}

type Fixtures = {
  executable?: typeof assertClaudeMainlineReady
  prepare?: typeof prepareClaudeJobContext
  transport?: typeof openClaudeHerdrTransport
}

/** Each attempt uses a fresh session; cleanup must succeed before the broker can select another model. */
export async function runClaudeDelegation(context: DelegationContext, id: string,
  request: { model: string; prompt: string }, signal: AbortSignal, fixtures: Fixtures = {}): Promise<string> {
  const job = { ...context.job, id: `delegate-${id}`, task: request.prompt, runtime: 'claude-code' as const, sessionId: null }
  let stage: Stage = 'authentication'
  let prepared: ReturnType<typeof prepareClaudeJobContext> | undefined
  let transport: Awaited<ReturnType<typeof openClaudeHerdrTransport>> | undefined
  let session: ClaudeControlSession | undefined
  let failure: DelegationFailure | undefined, text = ''
  const observation = new DelegationAttemptObservation()
  const closeOnAbort = () => { void transport?.close().catch(() => {}) }
  try {
    signal.throwIfAborted()
    const executable = (fixtures.executable ?? assertClaudeMainlineReady)(job.repoPath)
    stage = 'preparation'
    prepared = (fixtures.prepare ?? prepareClaudeJobContext)(job, context.stateDir, { model: request.model, parentJobId: context.job.id })
    stage = 'startup'
    signal.throwIfAborted()
    const sessionId = randomUUID()
    transport = await (fixtures.transport ?? openClaudeHerdrTransport)({ stateDir: context.stateDir, jobId: job.id,
      sequence: job.seq, cwd: prepared.jobRepo, executable,
      arguments: prepared.argumentsFor(sessionId, false), signal,
      fingerprint: { allow: prepared.fingerprint.allow.path, deny: prepared.fingerprint.deny.path } })
    session = new ClaudeControlSession(transport.input, transport.output, sessionId, {
      expectedModel: request.model, onEvent: event => observation.observe(event),
      onControlRequest: async () => {
        observation.observe({ type: 'control_request' })
        return { behavior: 'deny', message: 'This delegated host has no handler for this request.' }
      },
    })
    signal.addEventListener('abort', closeOnAbort, { once: true })
    stage = 'initialize'; await session.initialize(); signal.throwIfAborted()
    stage = 'dispatch'; await session.sendUser({ messageId: randomUUID(), content: request.prompt })
    stage = 'execution'
    while (true) {
      signal.throwIfAborted()
      const event = await session.nextEvent(200), result = event && claudeResult(event)
      if (!result) continue
      if (session.model !== request.model) throw new ClaudeProtocolError('delegated model mismatch')
      if (result.kind !== 'success') throw new ClaudeDelegationError(result.kind === 'cancelled'
        ? delegationFailure(stage, 'cancelled') : observation.failure())
      text = result.text; break
    }
  } catch (error) {
    failure = error instanceof ClaudeDelegationError ? error.failure
      : delegationFailure(stage, signal.aborted ? 'cancelled'
        : error instanceof ClaudeDeliveryUnknownError ? 'delivery-unknown'
        : error instanceof ClaudeProtocolError ? 'protocol'
        : error instanceof AdvisorFailureError || stage === 'authentication' ? 'authentication'
        : stage === 'preparation' ? 'preparation' : stage === 'startup' ? 'startup' : 'unknown')
  } finally {
    signal.removeEventListener('abort', closeOnAbort)
    try { await session?.endInput() } catch { /* The transport owns termination. */ }
    try {
      await transport?.close(); await session?.close(); prepared?.retire()
      if (failure) failure.cleanupVerified = true
    } catch {
      const prior = failure
      failure = { ...delegationFailure('cleanup', 'cleanup'), priorCode: prior?.code, quotaScope: prior?.quotaScope }
    }
  }
  if (failure) throw new ClaudeDelegationError(failure)
  return text
}
