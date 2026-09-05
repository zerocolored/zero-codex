type JournalRecord = Record<string, unknown>

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
export function validTerminalNativeAttempts(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false
  const entries = value.map(record)
  if (entries.some(entry => entry === null)) return false
  const attempts = entries as JournalRecord[]
  const perspectives = new Set(attempts.map(entry => entry.perspective))
  if (perspectives.size !== 2 || !perspectives.has('solution') || !perspectives.has('risk')) {
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

/**
 * Version 6 records every isolated Grok slot as either an adopted response or
 * a safely-contained unavailable outcome. Availability is best-effort; an
 * uncontained process is never a terminal outcome.
 */
export function validTerminalGrokAttempts(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false
  const entries = value.map(record)
  if (entries.some(entry => entry === null)) return false
  const attempts = entries as JournalRecord[]
  const perspectives = new Set(attempts.map(entry => entry.perspective))
  if (perspectives.size !== 2 || !perspectives.has('solution') || !perspectives.has('risk')) {
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
