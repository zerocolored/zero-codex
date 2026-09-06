import { createHash } from 'crypto'

type JournalRecord = Record<string, unknown>

export const THREE_ADVISOR_JOURNAL_VERSION = 9 as const
export const THREE_ADVISOR_POLICY = 'three-phase-specific-conditional-final-v2' as const
export type AdvisorPhase = 'investigation' | 'design' | 'review'
export type AdvisorPerspective = 'solution' | 'risk'

/** Current v9 policy: one initial round and at most two final-review rounds. */
export function validThreeAdvisorPhaseRound(phase: unknown, round: unknown): boolean {
  return (phase === 'investigation' && round === 1)
    || (phase === 'review' && (round === 1 || round === 2))
}

export function threeAdvisorRepositoryDeltaDigest(
  baselineDigest: unknown,
  currentDigest: unknown,
  changedRepositoryCount: unknown,
): string | null {
  if (!sha256(baselineDigest) || !sha256(currentDigest)
    || baselineDigest === currentDigest || !positiveInteger(changedRepositoryCount)) return null
  return createHash('sha256').update(JSON.stringify({
    contract: 'zerochan-three-advisor-host-repository-delta-v1',
    baselineDigest,
    currentDigest,
    changedRepositoryCount,
  })).digest('hex')
}

export function threeAdvisorTaskOwnedFixPathsDigest(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) return null
  const entries = value.map(record)
  if (entries.some(entry => entry === null)) return null
  const normalized = (entries as JournalRecord[]).map(entry => {
    if (Object.keys(entry).sort().join('\0') !== 'path\0repository'
      || typeof entry.repository !== 'string' || typeof entry.path !== 'string'
      || entry.repository.length < 1 || entry.repository.length > 512
      || entry.path.length < 1 || entry.path.length > 512
      || entry.repository.includes('\0') || entry.path.includes('\0')
      || /[\r\n]/.test(entry.repository) || /[\r\n]/.test(entry.path)
      || entry.repository.startsWith('/') || entry.path.startsWith('/')
      || entry.repository.split('/').some(part => part === '' || part === '..')
      || entry.path.split('/').some(part => part === '' || part === '.' || part === '..')) {
      return null
    }
    return { repository: entry.repository, path: entry.path }
  })
  if (normalized.some(entry => entry === null)) return null
  const paths = normalized as Array<{ repository: string, path: string }>
  const keys = paths.map(entry => `${entry.repository}\0${entry.path}`)
  if (new Set(keys).size !== keys.length
    || JSON.stringify(keys) !== JSON.stringify([...keys].sort())) return null
  return createHash('sha256').update(JSON.stringify({
    contract: 'zerochan-three-advisor-task-owned-fix-paths-v1',
    paths,
  })).digest('hex')
}

export function validThreeAdvisorRoundTwoBasis(value: unknown): boolean {
  const basis = record(value)
  if (!basis || !sha256(basis.reviewOneJournalDigest)
    || !sha256(basis.mandatoryFindingDigest)
    || !sha256(basis.taskOwnedFixDeltaDigest)
    || !sha256(basis.repositoryBaselineDigest)
    || !sha256(basis.repositoryCurrentDigest)
    || basis.repositoryBaselineDigest === basis.repositoryCurrentDigest
    || !positiveInteger(basis.changedRepositoryCount)
    || !positiveInteger(basis.taskOwnedFixPathCount)
    || basis.taskOwnedFixPathCount !== (Array.isArray(basis.taskOwnedFixPaths)
      ? basis.taskOwnedFixPaths.length : -1)
    || !sha256(basis.taskOwnedFixPathsDigest)
    || !Array.isArray(basis.roundOneSources)
    || basis.roundOneSources.length < 1 || basis.roundOneSources.length > 3) return false
  if (basis.taskOwnedFixDeltaDigest !== threeAdvisorRepositoryDeltaDigest(
    basis.repositoryBaselineDigest,
    basis.repositoryCurrentDigest,
    basis.changedRepositoryCount,
  )) return false
  if (basis.taskOwnedFixPathsDigest
    !== threeAdvisorTaskOwnedFixPathsDigest(basis.taskOwnedFixPaths)) return false
  if (new Set((basis.taskOwnedFixPaths as JournalRecord[])
    .map(entry => entry.repository)).size !== basis.changedRepositoryCount) return false
  const sources = basis.roundOneSources
  if (sources.some(source => !['native', 'grok', 'claude'].includes(String(source)))
    || new Set(sources).size !== sources.length) return false
  const responseDigests = record(basis.roundOneResponseDigests)
  if (!responseDigests || Object.keys(responseDigests).length !== sources.length) return false
  return sources.every(source => sha256(responseDigests[String(source)]))
}

export function advisorPerspectiveForPhase(phase: AdvisorPhase): AdvisorPerspective {
  return phase === 'review' ? 'risk' : 'solution'
}

function record(value: unknown): JournalRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JournalRecord
    : null
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nativeAgentId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256
    && /^\/?[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/.test(value)
    && value.split('/').every(segment => segment !== '.' && segment !== '..')
}

const executionStates = new Set([
  'unavailable-before-start',
  'start-unconfirmed',
  'started-no-response',
  'response-obtained',
])

function validExecutionState(value: unknown): boolean {
  return typeof value === 'string' && executionStates.has(value)
}

/**
 * Version 8 gives both native Codex slots the same best-effort terminal model
 * as the external reviewers. A missing model response is publishable only
 * when the primary records a bounded attempted/unavailable outcome; it is
 * never presented as an adopted review.
 */
function validTerminalNativeAttemptsFor(
  value: unknown,
  expectedPerspectives: readonly AdvisorPerspective[],
): boolean {
  if (!Array.isArray(value) || value.length !== expectedPerspectives.length) return false
  const entries = value.map(record)
  if (entries.some(entry => entry === null)) return false
  const attempts = entries as JournalRecord[]
  const perspectives = new Set(attempts.map(entry => entry.perspective))
  if (perspectives.size !== expectedPerspectives.length
    || expectedPerspectives.some(perspective => !perspectives.has(perspective))) {
    return false
  }
  const agentIds = attempts.flatMap(attempt => (
    attempt.agentId === undefined ? [] : [attempt.agentId]
  ))
  if (agentIds.some(value => !nativeAgentId(value))
    || new Set(agentIds).size !== agentIds.length) return false
  for (const attempt of attempts) {
    if (attempt.attempted !== true || typeof attempt.adopted !== 'boolean') return false
    if (attempt.adopted) {
      if (!nativeAgentId(attempt.agentId)
        || !sha256(attempt.responseDigest)
        || !sha256(attempt.responseTransportDigest)
        || attempt.reasonDigest !== undefined
        || (attempt.executionState !== undefined
          && attempt.executionState !== 'response-obtained')) return false
    } else if (attempt.agentId !== undefined
      || !sha256(attempt.reasonDigest)
      || attempt.responseDigest !== undefined
      || attempt.responseTransportDigest !== undefined
      || (attempt.started !== undefined && typeof attempt.started !== 'boolean')
      || (attempt.executionState !== undefined && !validExecutionState(attempt.executionState))
      || (attempt.executionState !== undefined
        && attempt.executionState !== (attempt.started === true
          ? 'started-no-response'
          : 'unavailable-before-start'))) return false
  }
  return true
}

export function validTerminalNativeAttempts(value: unknown): boolean {
  return validTerminalNativeAttemptsFor(value, ['solution', 'risk'])
}

export function validThreeAdvisorNativeAttempts(
  value: unknown,
  phase: AdvisorPhase,
): boolean {
  return validTerminalNativeAttemptsFor(value, [advisorPerspectiveForPhase(phase)])
}

/**
 * Version 6 records every isolated Grok slot as either an adopted response or
 * a safely-contained unavailable outcome. Availability is best-effort; an
 * uncontained process is never a terminal outcome.
 */
function validTerminalGrokAttemptsFor(
  value: unknown,
  expectedPerspectives: readonly AdvisorPerspective[],
): boolean {
  if (!Array.isArray(value) || value.length !== expectedPerspectives.length) return false
  const entries = value.map(record)
  if (entries.some(entry => entry === null)) return false
  const attempts = entries as JournalRecord[]
  const perspectives = new Set(attempts.map(entry => entry.perspective))
  if (perspectives.size !== expectedPerspectives.length
    || expectedPerspectives.some(perspective => !perspectives.has(perspective))) {
    return false
  }
  const startedProcessIds = new Set<number>()
  let startedCount = 0
  for (const attempt of attempts) {
    if (attempt.attempted !== true || typeof attempt.adopted !== 'boolean') return false
    if (attempt.containmentVerified !== true) {
      if (attempt.containmentVerified !== false || attempt.adopted
        || attempt.containmentStatus !== 'unverified-bounded-residual'
        || !sha256(attempt.reasonDigest)
        || attempt.processId !== undefined || attempt.responseDigest !== undefined
        || !['unavailable-before-start', 'start-unconfirmed']
          .includes(String(attempt.executionState))) return false
      continue
    }
    if (attempt.adopted) {
      if (!positiveInteger(attempt.processId) || !sha256(attempt.responseDigest)
        || attempt.reasonDigest !== undefined
        || (attempt.executionState !== undefined
          && attempt.executionState !== 'response-obtained')) return false
      startedCount += 1
      startedProcessIds.add(Number(attempt.processId))
    } else if (attempt.executionState === 'started-no-response') {
      if (!positiveInteger(attempt.processId) || !sha256(attempt.reasonDigest)
        || attempt.responseDigest !== undefined) return false
      startedCount += 1
      startedProcessIds.add(Number(attempt.processId))
    } else if (!sha256(attempt.reasonDigest)
      || attempt.processId !== undefined || attempt.responseDigest !== undefined
      || (attempt.executionState !== undefined && !validExecutionState(attempt.executionState))
      || (attempt.executionState !== undefined
        && !['unavailable-before-start', 'start-unconfirmed']
          .includes(String(attempt.executionState)))) {
      return false
    }
  }
  return startedProcessIds.size === startedCount
}

export function validTerminalGrokAttempts(value: unknown): boolean {
  return validTerminalGrokAttemptsFor(value, ['solution', 'risk'])
}

export function validThreeAdvisorGrokAttempts(
  value: unknown,
  phase: AdvisorPhase,
): boolean {
  return validTerminalGrokAttemptsFor(value, [advisorPerspectiveForPhase(phase)])
}

/** A Claude failure is terminal only before a workspace existed or after its exact cleanup. */
export function validTerminalClaudeAttempt(value: unknown): boolean {
  const attempt = record(value)
  if (!attempt || attempt.attempted !== true || attempt.required !== true
    || attempt.lifecycle !== 'ephemeral-v2' || typeof attempt.adopted !== 'boolean'
    || typeof attempt.workspaceCreationAttempted !== 'boolean'
    || typeof attempt.freshEphemeral !== 'boolean'
    || typeof attempt.cleanupVerified !== 'boolean'
    || typeof attempt.promptMayHaveBeenDelivered !== 'boolean'
    || typeof attempt.containmentVerified !== 'boolean') return false
  if (attempt.adopted) {
    return attempt.workspaceCreationAttempted === true
      && attempt.freshEphemeral === true
      && attempt.promptMayHaveBeenDelivered === true
      && attempt.cleanupVerified === true
      && attempt.cleanupStatus === 'closed-and-verified'
      && sha256(attempt.responseDigest)
      && sha256(attempt.cleanupReceiptDigest)
      && (attempt.executionState === undefined
        || attempt.executionState === 'response-obtained')
      && attempt.reasonDigest === undefined
  }
  if (!sha256(attempt.reasonDigest) || attempt.responseDigest !== undefined) return false
  if (attempt.executionState !== undefined && !validExecutionState(attempt.executionState)) {
    return false
  }
  if (attempt.executionState === 'response-obtained') return false
  const fallbackExecutionState = attempt.promptMayHaveBeenDelivered
    ? 'started-no-response'
    : attempt.workspaceCreationAttempted
      ? 'start-unconfirmed'
      : 'unavailable-before-start'
  const allowedExecutionStates = attempt.promptMayHaveBeenDelivered
    ? ['start-unconfirmed', 'started-no-response']
    : [fallbackExecutionState]
  if (attempt.executionState !== undefined
    && !allowedExecutionStates.includes(String(attempt.executionState))) return false
  // A positive observation of an owned live process is never a bounded
  // residual. It must not become terminal merely because a retirement marker
  // or an otherwise accepted cleanup status is also present.
  if (attempt.containmentStatus === 'owned-process-still-live') return false
  if (attempt.containmentVerified === false) {
    if (attempt.executionState !== undefined
      && !allowedExecutionStates.includes(String(attempt.executionState))) return false
    if (attempt.cleanupStatus === 'unverified-after-retirement') {
      return attempt.cleanupVerified === false
        && attempt.cleanupReceiptDigest === undefined
    }
    if (attempt.containmentStatus !== 'unverified-bounded-residual') return false
    if (attempt.cleanupVerified === false) return attempt.cleanupReceiptDigest === undefined
    return attempt.cleanupVerified === true
      && sha256(attempt.cleanupReceiptDigest)
      && ['closed-and-verified', 'provisional-workspace-closed',
        'provisional-workspace-not-created'].includes(String(attempt.cleanupStatus))
  }
  if (attempt.workspaceCreationAttempted) {
    if (!attempt.cleanupVerified || !sha256(attempt.cleanupReceiptDigest)) return false
    return attempt.freshEphemeral
      ? ['closed-and-verified', 'provisional-workspace-closed']
        .includes(String(attempt.cleanupStatus))
      : attempt.cleanupStatus === 'provisional-workspace-not-created'
  }
  return attempt.freshEphemeral === false
    && attempt.promptMayHaveBeenDelivered === false
    && attempt.cleanupVerified === false
    && attempt.cleanupStatus === undefined
    && attempt.cleanupReceiptDigest === undefined
}

/**
 * Bind the optional second final-review round to one fully observed current-policy
 * first round. Repository/input digests may differ because the mandatory fix is
 * precisely what creates the round-2 delta.
 */
export function validThreeAdvisorReviewSequence(
  reviewOneValue: unknown,
  reviewTwoValue: unknown,
): boolean {
  const reviewOne = record(reviewOneValue)
  const reviewTwo = record(reviewTwoValue)
  if (!reviewOne || !reviewTwo
    || reviewOne.version !== THREE_ADVISOR_JOURNAL_VERSION
    || reviewTwo.version !== THREE_ADVISOR_JOURNAL_VERSION
    || reviewOne.advisorPolicy !== THREE_ADVISOR_POLICY
    || reviewTwo.advisorPolicy !== THREE_ADVISOR_POLICY
    || reviewOne.status !== 'completed'
    || reviewOne.phase !== 'review' || reviewOne.round !== 1
    || reviewTwo.phase !== 'review' || reviewTwo.round !== 2
    || !['requested', 'reviewers-completed', 'completed', 'required-reviewer-failed', 'stale-input']
      .includes(String(reviewTwo.status))
    || reviewOne.attemptNonce !== reviewTwo.attemptNonce
    || reviewOne.contextDigest !== reviewTwo.contextDigest
    || !positiveInteger(reviewOne.startedAt) || !positiveInteger(reviewOne.finishedAt)
    || Number(reviewOne.finishedAt) < Number(reviewOne.startedAt)
    || !positiveInteger(reviewOne.receiptIssuedAt)
    || Number(reviewOne.receiptIssuedAt) < Number(reviewOne.finishedAt)
    || !positiveInteger(reviewOne.pollObservedAt)
    || Number(reviewOne.pollObservedAt) < Number(reviewOne.receiptIssuedAt)
    || !sha256(reviewOne.receiptDigest)
    || !positiveInteger(reviewTwo.startedAt)
    || Number(reviewTwo.startedAt) < Number(reviewOne.finishedAt)
    || !validThreeAdvisorNativeAttempts(reviewOne.native, 'review')
    || !validThreeAdvisorGrokAttempts(reviewOne.grok, 'review')
    || !validTerminalClaudeAttempt(reviewOne.claude)
    || !validThreeAdvisorNativeAttempts(reviewTwo.native, 'review')
    || !validThreeAdvisorRoundTwoBasis(reviewTwo.roundTwoBasis)) return false
  const basis = reviewTwo.roundTwoBasis as JournalRecord
  if (basis.reviewOneJournalDigest !== createHash('sha256')
    .update(JSON.stringify(reviewOne)).digest('hex')) return false
  if (reviewOne.repositoryDeltaBaselineDigest !== basis.repositoryBaselineDigest
    || reviewTwo.repositoryDeltaCurrentDigest !== basis.repositoryCurrentDigest) return false
  const responseDigests = basis.roundOneResponseDigests as JournalRecord
  const sourceValue = (source: unknown): unknown => source === 'native'
    ? reviewOne.native
    : source === 'grok' ? reviewOne.grok : reviewOne.claude
  const adoptedResponseMatches = (source: unknown): boolean => {
    const candidate = sourceValue(source)
    const adopted = Array.isArray(candidate)
      ? candidate.find(entry => record(entry)?.adopted === true)
      : record(candidate)?.adopted === true ? candidate : undefined
    const adoptedRecord = record(adopted)
    return adoptedRecord !== null
      && adoptedRecord.responseDigest === responseDigests[String(source)]
  }
  if (!(basis.roundOneSources as unknown[]).every(adoptedResponseMatches)) return false
  const roundOneIds = new Set((reviewOne.native as unknown[]).flatMap(entry => {
    const value = record(entry)
    return typeof value?.agentId === 'string' ? [value.agentId] : []
  }))
  if ((reviewTwo.native as unknown[]).some(entry => {
    const value = record(entry)
    return typeof value?.agentId === 'string' && roundOneIds.has(value.agentId)
  })) return false
  if (reviewTwo.status !== 'requested') {
    if (!positiveInteger(reviewTwo.finishedAt)
      || Number(reviewTwo.finishedAt) < Number(reviewTwo.startedAt)
      || reviewTwo.repositoryDeltaCurrentDigestAfter !== basis.repositoryCurrentDigest
      || !validThreeAdvisorGrokAttempts(reviewTwo.grok, 'review')
      || !validTerminalClaudeAttempt(reviewTwo.claude)) return false
  }
  return true
}

/** Version 5 remains readable only under its original all-adopted contract. */
export function validLegacyAdoptedGrok(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false
  const entries = value.map(record)
  if (entries.some(entry => entry === null)) return false
  const attempts = entries as JournalRecord[]
  const perspectives = new Set(attempts.map(entry => entry.perspective))
  const processIds = new Set(attempts.map(entry => entry.processId))
  return perspectives.size === 2 && perspectives.has('solution') && perspectives.has('risk')
    && processIds.size === 2
    && attempts.every(entry => entry.adopted === true
      && positiveInteger(entry.processId) && sha256(entry.responseDigest))
}

export function validLegacyAdoptedClaude(value: unknown): boolean {
  const attempt = record(value)
  return Boolean(attempt
    && attempt.attempted === true
    && attempt.required === true
    && attempt.lifecycle === 'ephemeral-v2'
    && attempt.adopted === true
    && attempt.freshEphemeral === true
    && attempt.cleanupVerified === true
    && attempt.cleanupStatus === 'closed-and-verified'
    && sha256(attempt.responseDigest)
    && sha256(attempt.cleanupReceiptDigest))
}
