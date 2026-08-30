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
        || attempt.reasonDigest !== undefined) return false
    } else if (attempt.agentId !== undefined
      || !sha256(attempt.reasonDigest)
      || attempt.responseDigest !== undefined
      || attempt.responseTransportDigest !== undefined) return false
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
  const adoptedProcessIds = new Set<number>()
  let adoptedCount = 0
  for (const attempt of attempts) {
    if (attempt.attempted !== true || attempt.containmentVerified !== true
      || typeof attempt.adopted !== 'boolean') return false
    if (attempt.adopted) {
      if (!positiveInteger(attempt.processId) || !sha256(attempt.responseDigest)
        || attempt.reasonDigest !== undefined) return false
      adoptedCount += 1
      adoptedProcessIds.add(Number(attempt.processId))
    } else if (!sha256(attempt.reasonDigest)
      || attempt.processId !== undefined || attempt.responseDigest !== undefined) {
      return false
    }
  }
  return adoptedProcessIds.size === adoptedCount
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
    || attempt.containmentVerified !== true) return false
  if (attempt.adopted) {
    return attempt.workspaceCreationAttempted === true
      && attempt.freshEphemeral === true
      && attempt.cleanupVerified === true
      && attempt.cleanupStatus === 'closed-and-verified'
      && sha256(attempt.responseDigest)
      && sha256(attempt.cleanupReceiptDigest)
      && attempt.reasonDigest === undefined
  }
  if (!sha256(attempt.reasonDigest) || attempt.responseDigest !== undefined) return false
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
