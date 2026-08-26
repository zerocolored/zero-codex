import { createHash } from 'crypto'
import { realpathSync } from 'fs'
import {
  parseAppServerSessionSource,
  isFinalAppServerAgentMessage,
  sameAppServerSessionSource,
  type AppServerSessionSource,
} from './codex-app-server-session.ts'

export type NativeAdvisorPerspective = 'solution' | 'risk'

export type NativeAdvisorJournalEntry = {
  perspective: NativeAdvisorPerspective
  agentId: string
  responseDigest: string
}

export type NativeAdvisorRoundEvidence = {
  inputRevision: number
  inputDigest: string
  phase: 'investigation' | 'design' | 'review'
  round: 1 | 2 | 3
  native: NativeAdvisorJournalEntry[]
}

const THREAD_ID = /^[A-Za-z0-9._:-]{1,256}$/
const ATTEMPT_NONCE = /^[0-9a-f]{32}$/

export function nativeAdvisorMarker(
  attemptNonce: string,
  inputRevision: number,
  inputDigest: string,
  phase: NativeAdvisorRoundEvidence['phase'],
  round: NativeAdvisorRoundEvidence['round'],
  perspective: NativeAdvisorPerspective,
): string {
  if (!ATTEMPT_NONCE.test(attemptNonce)) throw new Error('native advisor attempt nonce is invalid')
  if (!Number.isSafeInteger(inputRevision) || inputRevision < 1
    || !/^[0-9a-f]{64}$/.test(inputDigest)) {
    throw new Error('native advisor input binding is invalid')
  }
  return `[ZERO_NATIVE_ADVISOR:${attemptNonce}:r${inputRevision}:${inputDigest}:${phase}:${round}:${perspective}]`
}

export function nativeAdvisorResponseDigest(response: string): string {
  return createHash('sha256').update(response).digest('hex')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value as Record<string, unknown>
}

function threadFromResponse(value: unknown, label: string): Record<string, unknown> {
  return record(record(value, label).thread, `${label}.thread`)
}

function physicalCwd(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new Error(`${label} cwd is invalid`)
  }
  try { return realpathSync(value) } catch {
    throw new Error(`${label} cwd cannot be resolved`)
  }
}

function childRole(thread: Record<string, unknown>): string | null {
  if (typeof thread.agentRole === 'string') return thread.agentRole
  const source = thread.source
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const subAgent = (source as Record<string, unknown>).subAgent
  if (!subAgent || typeof subAgent !== 'object' || Array.isArray(subAgent)) return null
  const spawn = (subAgent as Record<string, unknown>).thread_spawn
  if (!spawn || typeof spawn !== 'object' || Array.isArray(spawn)) return null
  const role = (spawn as Record<string, unknown>).agent_role
  return typeof role === 'string' ? role : null
}

function childSourceParent(thread: Record<string, unknown>): string | null {
  const source = thread.source
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const subAgent = (source as Record<string, unknown>).subAgent
  if (!subAgent || typeof subAgent !== 'object' || Array.isArray(subAgent)) return null
  const spawn = (subAgent as Record<string, unknown>).thread_spawn
  if (!spawn || typeof spawn !== 'object' || Array.isArray(spawn)) return null
  const parent = (spawn as Record<string, unknown>).parent_thread_id
  const depth = (spawn as Record<string, unknown>).depth
  return typeof parent === 'string' && depth === 1 ? parent : null
}

function completedFinalResponse(thread: Record<string, unknown>, label: string): string {
  if (!Array.isArray(thread.turns) || thread.turns.length !== 1) {
    throw new Error(`${label} must contain exactly one fresh turn`)
  }
  const turn = record(thread.turns[0], `${label}.turn`)
  if (turn.status !== 'completed' || !Array.isArray(turn.items)) {
    throw new Error(`${label} turn is not completed`)
  }
  const messages = turn.items.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const entry = item as Record<string, unknown>
    return isFinalAppServerAgentMessage(entry) ? [entry.text] : []
  })
  if (messages.length !== 1 || !messages[0]) {
    throw new Error(`${label} does not contain one final response`)
  }
  if (turn.items.some(item => item && typeof item === 'object' && !Array.isArray(item)
    && (item as Record<string, unknown>).type === 'subAgentActivity'
    && (item as Record<string, unknown>).kind === 'started')) {
    throw new Error(`${label} delegated to another subagent`)
  }
  return messages[0]
}

/**
 * Validate the model's native-advisor journal against Codex-owned App Server
 * history. The caller supplies only responses read from the official local
 * Codex binary after the parent App Server/exec thread has reached its terminal
 * turn. Every child created by this job attempt must have a durable journal;
 * this also binds children from earlier input revisions and earlier turns.
 */
export function assertNativeAdvisorEvidence(options: {
  attemptNonce: string
  parentThreadId: string
  expectedParentSource: AppServerSessionSource
  repoPath: string
  rounds: NativeAdvisorRoundEvidence[]
  parentResponse: unknown
  childrenListResponse: unknown
  childResponses: Map<string, unknown>
}): void {
  if (!ATTEMPT_NONCE.test(options.attemptNonce)
    || !THREAD_ID.test(options.parentThreadId)) {
    throw new Error('native advisor parent binding is invalid')
  }
  const repo = realpathSync(options.repoPath)
  const parent = threadFromResponse(options.parentResponse, 'native advisor parent response')
  const parentSource = parseAppServerSessionSource(
    parent.source,
    'native advisor parent source',
  )
  if (parent.id !== options.parentThreadId || parent.parentThreadId !== null
    || !sameAppServerSessionSource(parentSource, options.expectedParentSource)
    || physicalCwd(parent.cwd, 'native advisor parent') !== repo) {
    throw new Error('native advisor parent thread does not match this Codex exec')
  }
  if (!Array.isArray(parent.turns) || parent.turns.length < 1) {
    throw new Error('native advisor parent thread is not terminal')
  }
  const startedChildren = new Set<string>()
  for (const [turnIndex, rawTurn] of parent.turns.entries()) {
    const turn = record(rawTurn, `native advisor parent turn ${turnIndex}`)
    if (turn.status !== 'completed' || !Array.isArray(turn.items)) {
      throw new Error('native advisor parent thread is not terminal')
    }
    for (const rawItem of turn.items) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue
      const item = rawItem as Record<string, unknown>
      if (item.type === 'subAgentActivity' && item.kind === 'started'
        && typeof item.agentThreadId === 'string') startedChildren.add(item.agentThreadId)
    }
  }
  const listing = record(options.childrenListResponse, 'native advisor child listing')
  if (!Array.isArray(listing.data) || listing.nextCursor !== null) {
    throw new Error('native advisor child listing is incomplete')
  }
  const listedIds = listing.data.map((value, index) => {
    const child = record(value, `native advisor listed child ${index}`)
    if (typeof child.id !== 'string' || !THREAD_ID.test(child.id)
      || child.parentThreadId !== options.parentThreadId) {
      throw new Error('native advisor child listing contains an unrelated thread')
    }
    return child.id
  })
  if (new Set(listedIds).size !== listedIds.length) {
    throw new Error('native advisor child listing contains duplicates')
  }

  const claimed = new Set<string>()
  for (const evidence of options.rounds) {
    if (!Array.isArray(evidence.native) || evidence.native.length !== 2) {
      throw new Error(`native advisor ${evidence.phase}-${evidence.round} count is invalid`)
    }
    const perspectives = new Set(evidence.native.map(entry => entry.perspective))
    if (perspectives.size !== 2 || !perspectives.has('solution') || !perspectives.has('risk')) {
      throw new Error(`native advisor ${evidence.phase}-${evidence.round} roles are invalid`)
    }
    for (const entry of evidence.native) {
      if (!THREAD_ID.test(entry.agentId) || claimed.has(entry.agentId)
        || !/^[0-9a-f]{64}$/.test(entry.responseDigest)) {
        throw new Error('native advisor identities are not fresh and unique')
      }
      claimed.add(entry.agentId)
      const response = options.childResponses.get(entry.agentId)
      if (!response) throw new Error(`native advisor ${entry.agentId} history is missing`)
      const child = threadFromResponse(response, `native advisor ${entry.agentId}`)
      const expectedRole = entry.perspective === 'solution' ? 'solution_analyst' : 'risk_reviewer'
      if (child.id !== entry.agentId || child.parentThreadId !== options.parentThreadId
        || childSourceParent(child) !== options.parentThreadId
        || childRole(child) !== expectedRole
        || physicalCwd(child.cwd, `native advisor ${entry.agentId}`) !== repo) {
        throw new Error(`native advisor ${entry.agentId} identity or role is invalid`)
      }
      const finalResponse = completedFinalResponse(child, `native advisor ${entry.agentId}`)
      const marker = nativeAdvisorMarker(
        options.attemptNonce, evidence.inputRevision, evidence.inputDigest,
        evidence.phase, evidence.round, entry.perspective,
      )
      if (!finalResponse.endsWith(marker)
        || nativeAdvisorResponseDigest(finalResponse) !== entry.responseDigest) {
        throw new Error(`native advisor ${entry.agentId} response is not bound to this round`)
      }
    }
  }
  if (claimed.size !== startedChildren.size
    || [...startedChildren].some(id => !claimed.has(id))
    || [...claimed].some(id => !listedIds.includes(id))) {
    throw new Error('Codex job attempt spawned unjournaled or missing native advisors')
  }
}
