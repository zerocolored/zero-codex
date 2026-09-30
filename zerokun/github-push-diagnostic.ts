import type { PublicationCommandResult } from './github-publication.ts'

/** Classify transport output internally; never reflect remote text or paths. */
export function githubPushFailure(
  result: PublicationCommandResult,
  publicationState: 'not-confirmed' | 'unconfirmed',
) {
  const diagnostic = `${result.stdout}\n${result.stderr}`
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  let reasonCode = 'push_failed'
  let reason = 'GitHub rejected or could not complete the branch publication.'
  let nextAction = 'Preserve the commit. Inspect repository permissions and branch rules before retrying; do not force-push or repeat unchanged.'
  let retryable = false
  let requiredScope: 'workflow' | undefined
  if (result.exitCode === 0 && !result.timedOut) {
    reasonCode = 'publication_unconfirmed'
    reason = 'GitHub returned success, but the exact remote commit could not be confirmed.'
    nextAction = 'Reconcile the remote branch before another publication attempt; do not assume the write failed.'
  } else if (result.timedOut) {
    reasonCode = 'transport_timeout'
    reason = 'GitHub branch publication timed out.'
    nextAction = 'Check connectivity and reconcile the remote commit before retrying.'
    retryable = true
  } else if (/refusing to allow (?:an OAuth App|a Personal Access Token) to create or update workflow[^\r\n]*without [`'"]?workflow[`'"]? scope/i.test(diagnostic)) {
    reasonCode = 'workflow_scope_required'
    reason = 'GitHub refused a workflow file change because the current authentication lacks workflow scope.'
    requiredScope = 'workflow'
    nextAction = 'Have the operator complete gh auth refresh --hostname github.com --scopes workflow on the host, then retry the same commit. Do not remove the workflow change or broaden authentication automatically.'
  } else if (/GH006|GH013|protected branch hook declined|repository rule violations found/i.test(diagnostic)) {
    reasonCode = 'branch_policy_rejected'
    reason = 'GitHub branch protection or repository rules rejected the publication.'
    nextAction = 'Inspect the repository rules and use the permitted branch or pull-request flow. Do not bypass protection.'
  } else if (/\(non-fast-forward\)|\(fetch first\)|non-fast-forwards were rejected/i.test(diagnostic)) {
    reasonCode = 'non_fast_forward'
    reason = 'The remote branch contains commits that this publication would overwrite.'
    nextAction = 'Fetch and reconcile the remote changes while preserving both histories, then retry without force.'
  } else if (/authentication failed|invalid username or (?:password|token)|could not read Username|terminal prompts disabled/i.test(diagnostic)) {
    reasonCode = 'authentication_required'
    reason = 'GitHub could not authenticate the publication.'
    nextAction = 'Have the operator verify the host GitHub CLI login, then retry the same commit.'
  } else if (/permission to [^\r\n]+ denied|write access to repository not granted|requested URL returned error: 403/i.test(diagnostic)) {
    reasonCode = 'write_permission_denied'
    reason = 'GitHub denied write access with the current authentication.'
    nextAction = 'Verify the host account and repository write permissions. A generic denial does not identify a missing OAuth scope.'
  } else if (/could not resolve host|failed to connect|connection (?:timed out|reset)|SSL certificate problem|TLS/i.test(diagnostic)) {
    reasonCode = 'transport_error'
    reason = 'GitHub publication encountered a network or TLS error.'
    nextAction = 'Check connectivity and reconcile the remote commit before retrying.'
    retryable = true
  }
  return {
    complete: false,
    reasonCode,
    reason,
    exitCode: result.exitCode,
    publicationState,
    retryable,
    ...(requiredScope ? { requiredScope } : {}),
    nextAction,
  }
}
