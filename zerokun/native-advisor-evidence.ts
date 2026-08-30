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
  /** Omitted on legacy v5-v7 evidence, where every native slot was adopted. */
  attempted?: boolean
  /** Omitted on legacy v5-v7 evidence, where every native slot was adopted. */
  adopted?: boolean
  agentId?: string
  responseDigest?: string
  responseTransportDigest?: string
  reasonDigest?: string
}

function nativeAdvisorEntryAdopted(entry: NativeAdvisorJournalEntry): boolean {
  return entry.adopted !== false
}

export class NativeAdvisorFinalMaterializationPending extends Error {}

export function retryableNativeAdvisorHistoryMaterialization(
  error: unknown,
): boolean {
  return error instanceof NativeAdvisorFinalMaterializationPending
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
 * Hash the only transport rewrite observed between collaboration output and
 * App Server history: Markdown hard-break spaces can be removed before LF.
 * Keep every other byte significant, including code blocks, indented code,
 * tabs, Unicode whitespace, CRLF, and one/three-or-more trailing spaces.
 */
export function nativeAdvisorResponseTransportDigest(response: string): string {
  return createHash('sha256').update(canonicalNativeAdvisorTransport(response)).digest('hex')
}

function canonicalNativeAdvisorTransport(response: string): string {
  const lines = response.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let fence: { character: '`' | '~'; length: number } | null = null
  return lines.map(line => {
    const hasLf = line.endsWith('\n')
    const body = hasLf ? line.slice(0, -1) : line
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body)
    const wasInFence = fence !== null
    let nextFence = fence
    if (fenceMatch) {
      const sequence = fenceMatch[1]!
      const character = sequence[0] as '`' | '~'
      if (!fence) {
        nextFence = { character, length: sequence.length }
      } else if (character === fence.character && sequence.length >= fence.length
        && /^ *$/.test(fenceMatch[2]!)) {
        nextFence = null
      }
    }
    // Nested Markdown containers can contain fenced or indented code whose
    // trailing spaces are data.  Do not try to parse those containers here;
    // fail closed by limiting the rewrite to column-zero prose.  A plain
    // Markdown list item remains prose, while an unspaced +/- line keeps the
    // conservative patch protection used by existing journals.
    const nestedOrIndented = /^\s/u.test(body) || /^ {0,3}>/.test(body)
    const patchLine = /^(?:diff --git |index |@@ |--- |\+\+\+ |[+-](?! ))/.test(body)
    const normalized = hasLf && !wasInFence && !fenceMatch
      && !nestedOrIndented && !patchLine && /\S {2}$/u.test(body)
      ? body.slice(0, -2)
      : body
    fence = nextFence
    return normalized + (hasLf ? '\n' : '')
  }).join('')
}

export function nativeAdvisorResponseHasExactMarker(response: string, marker: string): boolean {
  const first = response.indexOf(marker)
  return first >= 0
    && first === response.lastIndexOf(marker)
    && (response === marker || response.endsWith(`\n${marker}`))
}

function nativeAdvisorResponseMatches(
  response: string,
  marker: string,
  entry: NativeAdvisorJournalEntry,
): 'raw' | 'transport' | null {
  if (!nativeAdvisorResponseHasExactMarker(response, marker)) return null
  if (nativeAdvisorResponseDigest(response) === entry.responseDigest) return 'raw'
  if (entry.responseTransportDigest
    && nativeAdvisorResponseTransportDigest(response) === entry.responseTransportDigest) {
    return 'transport'
  }
  return null
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
  parentResponse: unknown
  childResponses: Map<string, unknown>
}): NativeAdvisorRoundEvidence[] {
  const repo = realpathSync(options.repoPath)
  const inheritedParentTurns = parentTurnOrder(
    options.parentResponse,
    options.parentThreadId,
  )
  const childThreads: Array<{
    threadId: string
    perspective: NativeAdvisorPerspective
    thread: Record<string, unknown>
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
    childThreads.push({
      threadId,
      perspective,
      thread: child,
    })
  }
  const directChildIds = new Set(childThreads.map(child => child.threadId))
  const parentActivityTimeline = parentSubagentActivityTimeline(
    options.parentResponse,
    options.parentThreadId,
  )
  const unavailableSlots = new Map<NativeAdvisorPerspective, number>([
    ['solution', 0],
    ['risk', 0],
  ])
  for (const evidence of options.rounds) {
    for (const entry of evidence.native) {
      if (!nativeAdvisorEntryAdopted(entry)) {
        unavailableSlots.set(entry.perspective, (unavailableSlots.get(entry.perspective) ?? 0) + 1)
      }
    }
  }
  const candidates = childThreads.map(child => {
    const label = `native advisor physical thread ${child.threadId}`
    const abandonedGeneration = abandonedPauseGeneration(
      child.thread,
      label,
      options.parentThreadId,
      directChildIds,
      parentActivityTimeline,
      inheritedParentTurns,
    )
    let finalResponse: string | null = null
    try {
      finalResponse = completedFinalResponse(
        child.thread,
        label,
        options.parentThreadId,
        directChildIds,
        inheritedParentActivitiesForChild(
          parentActivityTimeline,
          child.threadId,
          directChildIds,
        ),
        inheritedParentTurns,
      )
    } catch (error) {
      if (abandonedGeneration === null && !terminalUnavailableAdvisor(
        child.thread,
        label,
        options.parentThreadId,
        directChildIds,
        parentActivityTimeline,
        inheritedParentTurns,
      )) throw error
    }
    return {
      threadId: child.threadId,
      perspective: child.perspective,
      finalResponse,
      abandonedGeneration,
    }
  })

  const logicalAgentIds = new Set<string>()
  const matchedThreadIds = new Set<string>()
  const resolved = options.rounds.map(evidence => ({
    ...evidence,
    native: evidence.native.map(entry => {
      if (!nativeAdvisorEntryAdopted(entry)) {
        if (entry.attempted !== true || entry.adopted !== false
          || !/^[0-9a-f]{64}$/.test(String(entry.reasonDigest))
          || entry.responseDigest !== undefined
          || entry.responseTransportDigest !== undefined
          || entry.agentId !== undefined) {
          throw new Error('native advisor unavailable outcome is invalid')
        }
        return entry
      }
      if (!isNativeAdvisorAgentLabel(entry.agentId) || logicalAgentIds.has(entry.agentId)
        || !/^[0-9a-f]{64}$/.test(String(entry.responseDigest))
        || (entry.responseTransportDigest !== undefined
          && !/^[0-9a-f]{64}$/.test(entry.responseTransportDigest))) {
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
      const eligible = candidates.filter(candidate => (
        !matchedThreadIds.has(candidate.threadId)
        && candidate.perspective === entry.perspective
        && candidate.finalResponse !== null
      ))
      const rawMatches = eligible.filter(candidate => (
        nativeAdvisorResponseMatches(candidate.finalResponse!, marker, entry) === 'raw'
      ))
      let matches = rawMatches.length > 0
        ? rawMatches
        : eligible.filter(candidate => (
            nativeAdvisorResponseMatches(candidate.finalResponse!, marker, entry) === 'transport'
          ))
      const activeGenerationMatches = matches.filter(candidate => (
        candidate.abandonedGeneration === null
      ))
      if (activeGenerationMatches.length > 0) matches = activeGenerationMatches
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
  const abandonedSlots = new Set<string>()
  const consumedUnavailable = new Map<NativeAdvisorPerspective, number>([
    ['solution', 0],
    ['risk', 0],
  ])
  for (const candidate of candidates) {
    if (matchedThreadIds.has(candidate.threadId)) continue
    if (candidate.abandonedGeneration !== null) {
      const slot = `${candidate.abandonedGeneration}\0${candidate.perspective}`
      if (abandonedSlots.has(slot)) {
        throw new Error('native advisor paused generation spawned duplicate perspective children')
      }
      abandonedSlots.add(slot)
      continue
    }
    if (candidate.finalResponse === null) {
      const consumed = consumedUnavailable.get(candidate.perspective) ?? 0
      const available = unavailableSlots.get(candidate.perspective) ?? 0
      if (consumed < available) {
        consumedUnavailable.set(candidate.perspective, consumed + 1)
        continue
      }
    }
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

function subagentActivityFingerprint(item: Record<string, unknown>): string | null {
  if (typeof item.id !== 'string' || !THREAD_ID.test(item.id)
    || typeof item.kind !== 'string' || !SUBAGENT_ACTIVITY_KINDS.has(item.kind)
    || typeof item.agentThreadId !== 'string' || !THREAD_ID.test(item.agentThreadId)) {
    return null
  }
  return JSON.stringify([item.id, item.kind, item.agentThreadId])
}

type ParentSubagentActivity = {
  fingerprint: string
  kind: string
  agentThreadId: string
  ordinal: number
  parentTurnKey: string
  parentTurnPaused: boolean
}

function interjectionPauseGeneration(turn: Record<string, unknown>): string | null {
  if (turn.status !== 'completed' || turn.itemsView !== 'full' || !Array.isArray(turn.items)) {
    return null
  }
  const finals = turn.items.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const entry = item as Record<string, unknown>
    return isFinalAppServerAgentMessage(entry) ? [entry.text.replace(/\r\n/g, '\n').trim()] : []
  })
  if (finals.length !== 1) return null
  const markers = finals[0]!.match(/\[ZERO_INTERJECTION_PAUSED:[A-Za-z0-9._:-]{1,256}\]/g) ?? []
  return markers.length === 1 && finals[0]!.split('\n').at(-1)?.trim() === markers[0]
    ? markers[0]!
    : null
}

function parentSubagentActivityTimeline(
  response: unknown,
  parentThreadId: string,
): ParentSubagentActivity[] {
  const parent = threadFromResponse(response, 'native advisor parent activity source')
  if (parent.id !== parentThreadId || !Array.isArray(parent.turns)) {
    throw new Error('native advisor parent activity source is invalid')
  }
  const timeline: ParentSubagentActivity[] = []
  const itemIds = new Set<string>()
  const pauseGenerations = new Set<string>()
  let ordinal = 0
  for (const [turnIndex, rawTurn] of parent.turns.entries()) {
    if (!rawTurn || typeof rawTurn !== 'object' || Array.isArray(rawTurn)) continue
    const turn = rawTurn as Record<string, unknown>
    if (!Array.isArray(turn.items)) continue
    const rawTurnId = turn.id
    if (rawTurnId !== undefined && (typeof rawTurnId !== 'string' || !THREAD_ID.test(rawTurnId))) {
      throw new Error('native advisor parent activity turn identity is invalid')
    }
    const pauseGeneration = interjectionPauseGeneration(turn)
    if (pauseGeneration !== null) {
      if (pauseGenerations.has(pauseGeneration)) {
        throw new Error('native advisor parent pause generation is duplicated')
      }
      pauseGenerations.add(pauseGeneration)
    }
    const parentTurnKey = pauseGeneration
      ?? (typeof rawTurnId === 'string' ? rawTurnId : `projection-${turnIndex}`)
    const parentTurnPaused = pauseGeneration !== null
    for (const rawItem of turn.items) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue
      const item = rawItem as Record<string, unknown>
      if (item.type !== 'subAgentActivity') continue
      const fingerprint = subagentActivityFingerprint(item)
      if (fingerprint === null) continue
      if (itemIds.has(item.id as string)) {
        throw new Error('native advisor parent activity item identity is duplicated')
      }
      itemIds.add(item.id as string)
      timeline.push({
        fingerprint,
        kind: item.kind as string,
        agentThreadId: item.agentThreadId as string,
        ordinal,
        parentTurnKey,
        parentTurnPaused,
      })
      ordinal += 1
    }
  }
  return timeline
}

function parentTurnOrder(
  response: unknown,
  parentThreadId: string,
): ReadonlyMap<string, number> {
  const parent = threadFromResponse(response, 'native advisor parent turn source')
  if (parent.id !== parentThreadId || !Array.isArray(parent.turns)) {
    throw new Error('native advisor parent turn source is invalid')
  }
  const order = new Map<string, number>()
  for (const [index, rawTurn] of parent.turns.entries()) {
    if (!rawTurn || typeof rawTurn !== 'object' || Array.isArray(rawTurn)) continue
    const id = (rawTurn as Record<string, unknown>).id
    // Older App Server projections and focused unit fixtures can omit turn IDs.
    // Those inputs retain the legacy one-precursor validation below.
    if (id === undefined || id === null) continue
    if (typeof id !== 'string' || !THREAD_ID.test(id) || order.has(id)) {
      throw new Error('native advisor parent turn identity is invalid or duplicated')
    }
    order.set(id, index)
  }
  return order
}

function inheritedParentActivitiesForChild(
  timeline: readonly ParentSubagentActivity[],
  currentThreadId: string,
  directChildIds: ReadonlySet<string>,
): Set<string> {
  const currentStarts = timeline.filter(activity => (
    activity.kind === 'started' && activity.agentThreadId === currentThreadId
  ))
  if (currentStarts.length !== 1) return new Set()
  const currentStartOrdinal = currentStarts[0]!.ordinal
  return new Set(timeline.filter(activity => (
    activity.ordinal < currentStartOrdinal
    && activity.agentThreadId !== currentThreadId
    && directChildIds.has(activity.agentThreadId)
  )).map(activity => activity.fingerprint))
}

function ownedAdvisorTurns(
  thread: Record<string, unknown>,
  label: string,
  expectedParentThreadId: string,
  inheritedParentTurns: ReadonlyMap<string, number>,
): Array<Record<string, unknown>> {
  if (!THREAD_ID.test(expectedParentThreadId)
    || thread.parentThreadId !== expectedParentThreadId) {
    throw new Error(`${label} parent binding is invalid`)
  }
  if (!Array.isArray(thread.turns) || thread.turns.length < 1) {
    throw new Error(`${label} must contain one completed turn and at most one interrupted precursor`)
  }
  const ownedTurns: Array<Record<string, unknown>> = []
  let lastInheritedOrdinal = -1
  let observedOwnedTurn = false
  for (const [turnIndex, rawTurn] of thread.turns.entries()) {
    const turn = record(rawTurn, `${label}.turn ${turnIndex}`)
    const inheritedOrdinal = typeof turn.id === 'string'
      ? inheritedParentTurns.get(turn.id)
      : undefined
    if (inheritedOrdinal === undefined) {
      observedOwnedTurn = true
      ownedTurns.push(turn)
      continue
    }
    if (observedOwnedTurn || inheritedOrdinal <= lastInheritedOrdinal
      || (turn.status !== 'completed' && turn.status !== 'interrupted')
      || turn.itemsView !== 'full' || !Array.isArray(turn.items)) {
      throw new Error(`${label} inherited parent turn history is invalid`)
    }
    // App Server forks a native advisor from the complete parent history. A
    // long-running Zeroちゃん job can therefore project several completed
    // parent turns plus the current interrupted parent turn before the one
    // advisor-owned response. Their stable parent turn IDs and chronological
    // order distinguish that inherited prefix from repeated advisor prompts.
    lastInheritedOrdinal = inheritedOrdinal
  }
  return ownedTurns
}

/**
 * A same-thread interjection can interrupt the current root turn after its
 * native advisors were spawned. App Server keeps those owned child threads in
 * the durable child listing even though a resumed root turn launches a fresh,
 * journaled pair. Treat only the exact terminal/no-answer/no-descendant shape
 * as an unavailable advisor attempt; every completed, active, delegated, or
 * ambiguously bound extra child remains a hard evidence failure.
 */
function terminalUnavailableAdvisor(
  thread: Record<string, unknown>,
  label: string,
  expectedParentThreadId: string,
  directChildIds: ReadonlySet<string>,
  parentActivityTimeline: readonly ParentSubagentActivity[],
  inheritedParentTurns: ReadonlyMap<string, number>,
): boolean {
  try {
    const ownedTurns = ownedAdvisorTurns(
      thread,
      label,
      expectedParentThreadId,
      inheritedParentTurns,
    )
    if (ownedTurns.length !== 1) return false
    const turn = ownedTurns[0]!
    if (!['interrupted', 'failed'].includes(String(turn.status)) || turn.itemsView !== 'full'
      || !Array.isArray(turn.items)) return false
    for (const rawItem of turn.items) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue
      const item = rawItem as Record<string, unknown>
      if (isFinalAppServerAgentMessage(item)) return false
      if (item.type === 'subAgentActivity') {
        if (typeof item.kind !== 'string' || !SUBAGENT_ACTIVITY_KINDS.has(item.kind)
          || typeof item.agentThreadId !== 'string' || !THREAD_ID.test(item.agentThreadId)) {
          return false
        }
        // An interrupted fork can project an earlier sibling activity from
        // the parent. Reuse the exact stable-item proof used for adopted
        // advisors; all other activity is a real delegation/interaction.
        const fingerprint = subagentActivityFingerprint(item)
        const inherited = fingerprint !== null
          && item.agentThreadId !== thread.id
          && directChildIds.has(item.agentThreadId)
          && inheritedParentActivitiesForChild(
            parentActivityTimeline,
            String(thread.id),
            directChildIds,
          ).has(fingerprint)
        if (!inherited) return false
      }
    }
    const lifecycle = parentActivityTimeline.filter(activity => (
      activity.agentThreadId === thread.id
    ))
    if (lifecycle.length < 1 || lifecycle[0]!.kind !== 'started'
      || lifecycle.filter(activity => activity.kind === 'started').length !== 1
      || lifecycle.some(activity => activity.kind === 'completed')) return false
    // Current App Server history records only `started` on the parent for a
    // child whose owned turn later becomes interrupted. Accept that observed
    // terminal shape. Some versions may additionally project one explicit
    // interrupted event. Any interaction or completion is stronger evidence
    // than the observed abandoned fork and remains a hard failure.
    return lifecycle.length === 1
      || (lifecycle.length === 2 && lifecycle[1]!.kind === 'interrupted')
  } catch {
    return false
  }
}

function abandonedPauseGeneration(
  thread: Record<string, unknown>,
  label: string,
  expectedParentThreadId: string,
  directChildIds: ReadonlySet<string>,
  parentActivityTimeline: readonly ParentSubagentActivity[],
  inheritedParentTurns: ReadonlyMap<string, number>,
): string | null {
  try {
    const lifecycle = parentActivityTimeline.filter(activity => (
      activity.agentThreadId === thread.id
    ))
    if (lifecycle.length < 1 || lifecycle[0]!.kind !== 'started'
      || !lifecycle[0]!.parentTurnPaused
      || lifecycle.filter(activity => activity.kind === 'started').length !== 1
      || lifecycle.some(activity => activity.parentTurnKey !== lifecycle[0]!.parentTurnKey
        || activity.kind === 'interacted')) return null
    const ownedTurns = ownedAdvisorTurns(
      thread,
      label,
      expectedParentThreadId,
      inheritedParentTurns,
    )
    if (ownedTurns.length !== 1) return null
    const turn = ownedTurns[0]!
    if (!['completed', 'interrupted', 'failed'].includes(String(turn.status))
      || turn.itemsView !== 'full' || !Array.isArray(turn.items)) return null
    if (turn.status === 'completed') {
      completedFinalResponse(
        thread,
        label,
        expectedParentThreadId,
        directChildIds,
        inheritedParentActivitiesForChild(
          parentActivityTimeline,
          String(thread.id),
          directChildIds,
        ),
        inheritedParentTurns,
      )
    } else if (!terminalUnavailableAdvisor(
      thread,
      label,
      expectedParentThreadId,
      directChildIds,
      parentActivityTimeline,
      inheritedParentTurns,
    )) return null
    if (turn.status === 'completed'
      && lifecycle.some(activity => !['started', 'completed'].includes(activity.kind))) return null
    if (turn.status !== 'completed'
      && lifecycle.some(activity => !['started', 'interrupted'].includes(activity.kind))) return null
    return lifecycle[0]!.parentTurnKey
  } catch {
    return null
  }
}

function completedFinalResponse(
  thread: Record<string, unknown>,
  label: string,
  expectedParentThreadId: string,
  directChildIds: ReadonlySet<string> = new Set(),
  inheritedParentActivities: ReadonlySet<string> = new Set(),
  inheritedParentTurns: ReadonlyMap<string, number> = new Map(),
): string {
  const ownedTurns = ownedAdvisorTurns(
    thread,
    label,
    expectedParentThreadId,
    inheritedParentTurns,
  )
  if (ownedTurns.length < 1 || ownedTurns.length > 2) {
    throw new Error(`${label} must contain one completed turn and at most one interrupted precursor`)
  }
  let finalResponse: string | null = null
  let parentInteractionCount = 0
  for (const [turnIndex, rawTurn] of ownedTurns.entries()) {
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
      const fingerprint = subagentActivityFingerprint(item)
      if (turn.status === 'interrupted' && item.agentThreadId !== thread.id
        && directChildIds.has(item.agentThreadId) && fingerprint !== null
        && inheritedParentActivities.has(fingerprint)) {
        // Codex forks a child from the parent's current turn. App Server can
        // therefore project an already-recorded sibling activity into the
        // child's single interrupted precursor. It is inherited history, not
        // a delegation by this advisor. Exact parent item identity plus the
        // direct-sibling lineage distinguishes it from a real grandchild.
        continue
      }
      if (turn.status === 'completed' && parentInteractionCount === 0
        && item.kind === 'interacted' && fingerprint !== null
        && item.agentThreadId === expectedParentThreadId
        && item.agentThreadId !== thread.id
        && !directChildIds.has(item.agentThreadId)
        && item.agentPath === '/root') {
        // A native advisor can send one progress/result interaction back to
        // the primary root during its final turn.  The target is the already
        // verified parent, not a newly delegated descendant.  Keep this
        // observed shape exact; listed child threads remain the independent
        // backstop for real recursive delegation.
        parentInteractionCount += 1
        continue
      }
      throw new Error(`${label} delegated to another subagent`)
    }
    if (turn.status === 'interrupted') {
      if (turnIndex !== 0 || messages.length !== 0 || finalResponse !== null) {
        throw new Error(`${label} interrupted precursor contains a final response`)
      }
      continue
    }
    if (turnIndex !== ownedTurns.length - 1 || messages.length > 1
      || finalResponse !== null) {
      throw new Error(`${label} does not contain one final response`)
    }
    if (messages.length === 0) {
      throw new NativeAdvisorFinalMaterializationPending(
        `${label} does not contain one final response; final response is not materialized yet`,
      )
    }
    if (!messages[0]) throw new Error(`${label} does not contain one final response`)
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
  const directChildIds = new Set(options.childResponses.keys())
  const parentActivityTimeline = parentSubagentActivityTimeline(
    options.parentResponse,
    options.parentThreadId,
  )
  const inheritedParentTurns = parentTurnOrder(
    options.parentResponse,
    options.parentThreadId,
  )
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
  const unavailableSlots = new Map<NativeAdvisorPerspective, number>([
    ['solution', 0],
    ['risk', 0],
  ])
  for (const evidence of options.rounds) {
    if (!Array.isArray(evidence.native) || evidence.native.length !== 2) {
      throw new Error(`native advisor ${evidence.phase}-${evidence.round} count is invalid`)
    }
    const perspectives = new Set(evidence.native.map(entry => entry.perspective))
    if (perspectives.size !== 2 || !perspectives.has('solution') || !perspectives.has('risk')) {
      throw new Error(`native advisor ${evidence.phase}-${evidence.round} roles are invalid`)
    }
    for (const entry of evidence.native) {
      if (!nativeAdvisorEntryAdopted(entry)) {
        if (entry.attempted !== true || entry.adopted !== false
          || !/^[0-9a-f]{64}$/.test(String(entry.reasonDigest))
          || entry.responseDigest !== undefined
          || entry.responseTransportDigest !== undefined
          || entry.agentId !== undefined) {
          throw new Error('native advisor unavailable outcome is invalid')
        }
        unavailableSlots.set(entry.perspective, (unavailableSlots.get(entry.perspective) ?? 0) + 1)
        continue
      }
      if (typeof entry.agentId !== 'string' || !THREAD_ID.test(entry.agentId)
        || claimed.has(entry.agentId)
        || !/^[0-9a-f]{64}$/.test(String(entry.responseDigest))
        || (entry.responseTransportDigest !== undefined
          && !/^[0-9a-f]{64}$/.test(entry.responseTransportDigest))) {
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
      const finalResponse = completedFinalResponse(
        child,
        `native advisor ${entry.agentId}`,
        options.parentThreadId,
        directChildIds,
        inheritedParentActivitiesForChild(
          parentActivityTimeline,
          entry.agentId,
          directChildIds,
        ),
        inheritedParentTurns,
      )
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
      if (nativeAdvisorResponseMatches(finalResponse, marker, entry) === null) {
        throw new Error(`native advisor ${entry.agentId} response is not bound to this round`)
      }
    }
  }
  const safelyAccounted = new Set<string>()
  const abandonedSlots = new Set<string>()
  const consumedUnavailable = new Map<NativeAdvisorPerspective, number>([
    ['solution', 0],
    ['risk', 0],
  ])
  for (const [threadId, response] of options.childResponses) {
    if (claimed.has(threadId)) continue
    const label = `native advisor unclaimed thread ${threadId}`
    const child = threadFromResponse(response, label)
    const descendants = options.childChildrenListResponses.get(threadId)
    const role = childRole(child)
    const perspective: NativeAdvisorPerspective | null = role === 'solution_analyst'
      ? 'solution'
      : role === 'risk_reviewer'
        ? 'risk'
        : null
    if (child.id !== threadId || child.parentThreadId !== options.parentThreadId
      || childSourceParent(child) !== options.parentThreadId
      || perspective === null
      || physicalCwd(child.cwd, label) !== repo
      || !descendants || listedDirectChildren(
      descendants,
      threadId,
      `${label} descendant listing`,
    ).length !== 0) {
      throw new Error('native advisor history contains an unclaimed child response')
    }
    const generation = abandonedPauseGeneration(
      child,
      label,
      options.parentThreadId,
      directChildIds,
      parentActivityTimeline,
      inheritedParentTurns,
    )
    if (generation !== null) {
      const slot = `${generation}\0${perspective}`
      if (abandonedSlots.has(slot)) {
        throw new Error('native advisor paused generation spawned duplicate perspective children')
      }
      abandonedSlots.add(slot)
      safelyAccounted.add(threadId)
      continue
    }
    if (terminalUnavailableAdvisor(
      child,
      label,
      options.parentThreadId,
      directChildIds,
      parentActivityTimeline,
      inheritedParentTurns,
    )) {
      const consumed = consumedUnavailable.get(perspective) ?? 0
      const available = unavailableSlots.get(perspective) ?? 0
      if (consumed < available) {
        consumedUnavailable.set(perspective, consumed + 1)
        safelyAccounted.add(threadId)
        continue
      }
    }
    throw new Error('native advisor history contains an unclaimed child response')
  }
  const accounted = new Set([...claimed, ...safelyAccounted])
  if (options.childResponses.size !== accounted.size
    || [...options.childResponses.keys()].some(id => !accounted.has(id))
    || options.childChildrenListResponses.size !== accounted.size
    || [...options.childChildrenListResponses.keys()].some(id => !accounted.has(id))) {
    throw new Error('native advisor history contains an unclaimed child response')
  }
  const baseline = new Set(options.parentChildBaseline)
  if ([...accounted].some(id => baseline.has(id))) {
    throw new Error('native advisor identity was already present before this job attempt')
  }
  const expectedListed = new Set([...baseline, ...accounted])
  if (accounted.size !== observedChildren.size
    || [...observedChildren].some(id => !accounted.has(id))
    || listedIds.length !== expectedListed.size
    || listedIds.some(id => !expectedListed.has(id))) {
    throw new Error('Codex job attempt spawned unjournaled or missing native advisors')
  }
}
