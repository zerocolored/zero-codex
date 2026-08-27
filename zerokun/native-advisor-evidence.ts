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
const SUBAGENT_ACTIVITY_KINDS = new Set([
  'started', 'interacted', 'interrupted', 'completed',
])

export function isNativeAdvisorAgentLabel(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
    || !/^\/?[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/.test(value)) {
    return false
  }
  return value.split('/').every(segment => segment !== '.' && segment !== '..')
}

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

/**
 * Resolve the model-visible collaboration agent labels recorded by the broker
 * to the physical App Server child thread IDs that own the durable responses.
 *
 * Codex exposes a canonical task path (for example
 * `/root/investigation_solution`) to the parent model, while its App Server history
 * endpoints accept the separate UUID-like `agentThreadId`.  The label is
 * therefore only a journal identity; it must never be sent to `thread/read`.
 * Every new direct child is instead matched exactly once by its official role,
 * round marker, and response digest.  Extra, missing, or ambiguous children
 * fail closed.
 */
export function resolveNativeAdvisorThreadIds(options: {
  attemptNonce: string
  parentThreadId: string
  repoPath: string
  rounds: NativeAdvisorRoundEvidence[]
  childResponses: Map<string, unknown>
}): NativeAdvisorRoundEvidence[] {
  const repo = realpathSync(options.repoPath)
  const candidates: Array<{
    threadId: string
    perspective: NativeAdvisorPerspective
    finalResponse: string
  }> = []
  for (const [threadId, response] of options.childResponses) {
    if (!THREAD_ID.test(threadId)) {
      throw new Error('native advisor physical thread identity is invalid')
    }
    const child = threadFromResponse(response, `native advisor physical thread ${threadId}`)
    const role = childRole(child)
    const perspective = role === 'solution_analyst'
      ? 'solution'
      : role === 'risk_reviewer'
        ? 'risk'
        : null
    if (child.id !== threadId || child.parentThreadId !== options.parentThreadId
      || childSourceParent(child) !== options.parentThreadId
      || perspective === null
      || physicalCwd(child.cwd, `native advisor physical thread ${threadId}`) !== repo) {
      throw new Error(`native advisor physical thread ${threadId} identity or role is invalid`)
    }
    candidates.push({
      threadId,
      perspective,
      finalResponse: completedFinalResponse(
        child,
        `native advisor physical thread ${threadId}`,
      ),
    })
  }

  const logicalAgentIds = new Set<string>()
  const matchedThreadIds = new Set<string>()
  const resolved = options.rounds.map(evidence => ({
    ...evidence,
    native: evidence.native.map(entry => {
      if (!isNativeAdvisorAgentLabel(entry.agentId) || logicalAgentIds.has(entry.agentId)
        || !/^[0-9a-f]{64}$/.test(entry.responseDigest)) {
        throw new Error('native advisor journal identities are not fresh and unique')
      }
      logicalAgentIds.add(entry.agentId)
      const marker = nativeAdvisorMarker(
        options.attemptNonce,
        evidence.inputRevision,
        evidence.inputDigest,
        evidence.phase,
        evidence.round,
        entry.perspective,
      )
      const matches = candidates.filter(candidate => (
        !matchedThreadIds.has(candidate.threadId)
        && candidate.perspective === entry.perspective
        && candidate.finalResponse.endsWith(marker)
        && nativeAdvisorResponseDigest(candidate.finalResponse) === entry.responseDigest
      ))
      if (matches.length !== 1) {
        throw new Error(
          `native advisor ${entry.agentId} did not resolve to exactly one physical thread`,
        )
      }
      const threadId = matches[0]!.threadId
      matchedThreadIds.add(threadId)
      return { ...entry, agentId: threadId }
    }),
  }))
  if (matchedThreadIds.size !== candidates.length) {
    throw new Error('native advisor history contains an unjournaled physical child thread')
  }
  return resolved
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
  if (!Array.isArray(thread.turns) || thread.turns.length < 1
    || thread.turns.length > 2) {
    throw new Error(`${label} must contain one completed turn and at most one interrupted precursor`)
  }
  let finalResponse: string | null = null
  for (const [turnIndex, rawTurn] of thread.turns.entries()) {
    const turn = record(rawTurn, `${label}.turn ${turnIndex}`)
    if ((turn.status !== 'completed' && turn.status !== 'interrupted')
      || turn.itemsView !== 'full' || !Array.isArray(turn.items)) {
      throw new Error(`${label} turn is not completed or interrupted with full evidence`)
    }
    const messages = turn.items.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const entry = item as Record<string, unknown>
      return isFinalAppServerAgentMessage(entry) ? [entry.text] : []
    })
    for (const rawItem of turn.items) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue
      const item = rawItem as Record<string, unknown>
      if (item.type !== 'subAgentActivity') continue
      if (typeof item.kind !== 'string' || !SUBAGENT_ACTIVITY_KINDS.has(item.kind)
        || typeof item.agentThreadId !== 'string' || !THREAD_ID.test(item.agentThreadId)) {
        throw new Error(`${label} contains invalid subagent activity`)
      }
      throw new Error(`${label} delegated to another subagent`)
    }
    if (turn.status === 'interrupted') {
      if (turnIndex !== 0 || messages.length !== 0 || finalResponse !== null) {
        throw new Error(`${label} interrupted precursor contains a final response`)
      }
      continue
    }
    if (turnIndex !== thread.turns.length - 1 || messages.length !== 1
      || !messages[0] || finalResponse !== null) {
      throw new Error(`${label} does not contain one final response`)
    }
    finalResponse = messages[0]
  }
  if (finalResponse === null) {
    throw new Error(`${label} does not contain one final response`)
  }
  return finalResponse
}

function listedDirectChildren(
  value: unknown,
  parentThreadId: string,
  label: string,
): string[] {
  const listing = record(value, label)
  if (!Array.isArray(listing.data) || listing.nextCursor !== null) {
    throw new Error(`${label} is incomplete`)
  }
  const ids = listing.data.map((rawChild, index) => {
    const child = record(rawChild, `${label} child ${index}`)
    if (typeof child.id !== 'string' || !THREAD_ID.test(child.id)
      || child.parentThreadId !== parentThreadId) {
      throw new Error(`${label} contains an unrelated thread`)
    }
    return child.id
  })
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicates`)
  }
  return ids
}

/**
 * Validate the model's native-advisor journal against Codex-owned App Server
 * history. The caller supplies only responses read from the official local
 * Codex binary after the parent App Server/exec thread has reached its terminal
 * turn. The pre-turn child baseline separates historical children from this
 * job attempt; every newly listed direct child must have a durable journal,
 * and every claimed advisor must have an empty direct-child listing. This also
 * binds children from earlier input revisions and earlier turns in this job.
 */
export function assertNativeAdvisorEvidence(options: {
  attemptNonce: string
  parentThreadId: string
  expectedParentSource: AppServerSessionSource
  repoPath: string
  rounds: NativeAdvisorRoundEvidence[]
  parentResponse: unknown
  childrenListResponse: unknown
  parentChildBaseline: string[]
  childResponses: Map<string, unknown>
  childChildrenListResponses: Map<string, unknown>
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
  const observedChildren = new Set<string>()
  for (const [turnIndex, rawTurn] of parent.turns.entries()) {
    const turn = record(rawTurn, `native advisor parent turn ${turnIndex}`)
    if (turn.status !== 'completed' || turn.itemsView !== 'full'
      || !Array.isArray(turn.items)) {
      throw new Error('native advisor parent thread is not terminal')
    }
    for (const rawItem of turn.items) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue
      const item = rawItem as Record<string, unknown>
      if (item.type !== 'subAgentActivity') continue
      if (typeof item.kind !== 'string' || !SUBAGENT_ACTIVITY_KINDS.has(item.kind)
        || typeof item.agentThreadId !== 'string' || !THREAD_ID.test(item.agentThreadId)) {
        throw new Error('native advisor parent contains invalid subagent activity')
      }
      observedChildren.add(item.agentThreadId)
    }
  }
  const listedIds = listedDirectChildren(
    options.childrenListResponse,
    options.parentThreadId,
    'native advisor child listing',
  )
  if (!Array.isArray(options.parentChildBaseline)
    || new Set(options.parentChildBaseline).size !== options.parentChildBaseline.length
    || options.parentChildBaseline.some(id => !THREAD_ID.test(id))) {
    throw new Error('native advisor parent child baseline is invalid')
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
      const descendants = options.childChildrenListResponses.get(entry.agentId)
      if (!descendants) {
        throw new Error(`native advisor ${entry.agentId} descendant listing is missing`)
      }
      if (listedDirectChildren(
        descendants,
        entry.agentId,
        `native advisor ${entry.agentId} descendant listing`,
      ).length !== 0) {
        throw new Error(`native advisor ${entry.agentId} delegated to another subagent`)
      }
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
  if (options.childResponses.size !== claimed.size
    || [...options.childResponses.keys()].some(id => !claimed.has(id))
    || options.childChildrenListResponses.size !== claimed.size
    || [...options.childChildrenListResponses.keys()].some(id => !claimed.has(id))) {
    throw new Error('native advisor history contains an unclaimed child response')
  }
  const baseline = new Set(options.parentChildBaseline)
  if ([...claimed].some(id => baseline.has(id))) {
    throw new Error('native advisor identity was already present before this job attempt')
  }
  const expectedListed = new Set([...baseline, ...claimed])
  if (claimed.size !== observedChildren.size
    || [...observedChildren].some(id => !claimed.has(id))
    || listedIds.length !== expectedListed.size
    || listedIds.some(id => !expectedListed.has(id))) {
    throw new Error('Codex job attempt spawned unjournaled or missing native advisors')
  }
}
