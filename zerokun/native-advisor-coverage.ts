import { realpathSync } from 'node:fs'
import type { AdvisorExecutionState } from './advisor-broker.ts'
import { isFinalAppServerAgentMessage } from './codex-app-server-session.ts'
import {
  nativeAdvisorMarker,
  nativeAdvisorResponseHasExactMarker,
  nativeAdvisorResponseDigest,
  type NativeAdvisorRoundEvidence,
  type NativeAdvisorPerspective,
} from './native-advisor-evidence.ts'

export type NativeAdvisorObservation = {
  attemptNonce: string
  inputRevision: number
  inputDigest: string
  phase: NativeAdvisorRoundEvidence['phase']
  round: NativeAdvisorRoundEvidence['round']
  perspective: NativeAdvisorPerspective
  state: AdvisorExecutionState
  threadId?: string
  responseDigest?: string
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : {}
)
const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(record) : []
const spawnSource = (thread: RecordValue): RecordValue => {
  const source = record(thread.source)
  return record(record(source.subAgent ?? source.subagent).thread_spawn)
}

/**
 * Observe execution, not byte-for-byte adoption of a review. The parent may
 * legitimately summarize a response before giving it to the broker. That
 * does not undo the child's execution or its persisted final answer.
 *
 * The supplied reader must turn unavailable RPCs into undefined (but propagate
 * cancellation/owned-process failures). Per-child read failures then preserve
 * the independently observed slots. No model turn is started here.
 */
export async function observeNativeAdvisorCoverage(options: {
  attemptNonce: string
  parentThreadId: string
  repoPath: string
  parentChildBaseline: string[]
  rounds: NativeAdvisorRoundEvidence[]
  read: (method: 'thread/list' | 'thread/read', params: RecordValue) => Promise<RecordValue | undefined>
}): Promise<NativeAdvisorObservation[]> {
  const observations = options.rounds.flatMap(round => round.native.map(entry => ({
    attemptNonce: options.attemptNonce,
    inputRevision: round.inputRevision,
    inputDigest: round.inputDigest,
    phase: round.phase,
    round: round.round,
    perspective: entry.perspective,
    state: 'start-unconfirmed' as AdvisorExecutionState,
  })))
  const children = new Map<string, RecordValue>()
  const baseline = new Set(options.parentChildBaseline)
  const cursors = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < 100; page++) {
    const result = await options.read('thread/list', {
      parentThreadId: options.parentThreadId, sourceKinds: ['subAgent'],
      limit: 100, sortDirection: 'asc', cursor,
    })
    if (!result) break
    for (const child of records(result.data)) {
      if (typeof child.id === 'string' && child.parentThreadId === options.parentThreadId
        && !baseline.has(child.id)) children.set(child.id, child)
    }
    if (typeof result.nextCursor !== 'string' || !result.nextCursor
      || cursors.has(result.nextCursor)) break
    cursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  const repo = realpathSync(options.repoPath)
  const threads = new Map<string, RecordValue>()
  for (const observation of observations) {
    const role = observation.perspective === 'solution' ? 'solution_analyst' : 'risk_reviewer'
    const candidates = [...children.values()].filter(child => {
      const source = spawnSource(child)
      return (child.agentRole ?? source.agent_role) === role
    })
    // A logical name alone is not execution evidence; an attempt-specific
    // marker in this child's own input or final answer binds it to the slot.
    const matched: NativeAdvisorObservation[] = []
    for (const candidate of candidates) {
      const id = String(candidate.id)
      if (!threads.has(id)) {
        const response = await options.read('thread/read', { threadId: id, includeTurns: true })
        threads.set(id, record(response?.thread))
      }
      const thread = threads.get(id)!
      const source = spawnSource(thread)
      if (thread.id !== id || thread.parentThreadId !== options.parentThreadId
        || source.parent_thread_id !== options.parentThreadId
        || (thread.agentRole ?? source.agent_role) !== role) continue
      try {
        if (typeof thread.cwd !== 'string' || realpathSync(thread.cwd) !== repo) continue
      } catch { continue }
      const marker = nativeAdvisorMarker(options.attemptNonce, observation.inputRevision,
        observation.inputDigest, observation.phase, observation.round, observation.perspective)
      const finals: string[] = []
      let inputObserved = false
      for (const turn of records(thread.turns)) {
        for (const item of records(turn.items)) {
          if (item.type === 'userMessage' && records(item.content).some(content => (
            typeof content.text === 'string' && content.text.includes(marker)
          ))) inputObserved = true
          if (turn.status === 'completed'
            && isFinalAppServerAgentMessage(item)
            && nativeAdvisorResponseHasExactMarker(item.text.trimEnd(), marker)) {
            finals.push(item.text)
          }
        }
      }
      const distinctFinals = [...new Set(finals)]
      if (distinctFinals.length === 1) {
        matched.push({ ...observation, state: 'response-obtained', threadId: id,
          responseDigest: nativeAdvisorResponseDigest(distinctFinals[0]!) })
      } else if (inputObserved) {
        matched.push({ ...observation, state: 'started-no-response', threadId: id })
      }
    }
    if (matched.length === 1) Object.assign(observation, matched[0])
  }
  return observations
}
