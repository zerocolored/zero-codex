import { AdvisorFailureError, classifyAdvisorFailure, type AdvisorFailure } from './advisor-availability.ts'

type AuthCommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
  forcedCleanup?: boolean
  outputTruncated?: boolean
}

export function claudeSubscriptionStatusIsReady(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value as Record<string, unknown>
  return status.loggedIn === true && status.authMethod === 'claude.ai'
    && status.apiProvider === 'firstParty'
    && typeof status.subscriptionType === 'string' && status.subscriptionType.length > 0
}

/** No account identifiers or raw command output may escape this boundary. */
export function assertClaudeAuthStatus(result: AuthCommandResult): void {
  const fail = (cause: AdvisorFailure['cause'], diagnostic: string): never => {
    throw new AdvisorFailureError({ advisor: 'claude', cause }, diagnostic)
  }
  if (result.timedOut) fail('timeout', 'Claude authentication status timed out')
  if (result.forcedCleanup || result.outputTruncated) fail('auth-check', 'Claude subscription login could not be verified: incomplete command result')
  let parsed: unknown
  try { parsed = JSON.parse(result.stdout) } catch {}
  // Claude auth status intentionally exits 1 when logged out. Inspect its JSON
  // before the generic nonzero check, but never accept nonzero as ready.
  if ((result.exitCode === 0 || result.exitCode === 1) && parsed && typeof parsed === 'object'
    && !Array.isArray(parsed) && (parsed as Record<string, unknown>).loggedIn === false) {
    fail('authentication', 'Claude first-party subscription authentication required: not logged in')
  }
  if (result.exitCode === 0 && claudeSubscriptionStatusIsReady(parsed)) return
  const diagnostic = classifyAdvisorFailure('claude', result.stderr)
  if (['billing', 'network', 'rate-limit', 'authentication', 'timeout'].includes(diagnostic.cause)) {
    fail(diagnostic.cause, `Claude authentication status failed: ${diagnostic.cause}`)
  }
  if (result.exitCode === 0 && parsed && typeof parsed === 'object'
    && (parsed as Record<string, unknown>).loggedIn === true) {
    fail('configuration', 'Claude first-party subscription configuration required')
  }
  fail('auth-check', 'Claude subscription login could not be verified: command failed or invalid status')
}
