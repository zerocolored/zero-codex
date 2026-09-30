import { expect, test } from 'bun:test'
import { githubPushFailure } from './github-push-diagnostic.ts'

test('workflow refusal returns fixed facts without remote secrets, filenames or URLs', () => {
  const failure = githubPushFailure({ exitCode: 1, stdout: 'private output', stderr:
    '\x1b[31mremote: refusing to allow an OAuth App to create or update workflow `secret-path.yml` without `workflow` scope\x1b[0m\n' +
    'https://user:password@example.invalid ghp_privateToken Authorization: Bearer private-value' }, 'not-confirmed')
  expect(failure).toMatchObject({ reasonCode: 'workflow_scope_required', requiredScope: 'workflow', retryable: false })
  expect(failure.nextAction).toContain('gh auth refresh --hostname github.com --scopes workflow')
  for (const value of ['secret-path', 'password', 'privateToken', 'private-value', 'example.invalid', 'private output']) {
    expect(JSON.stringify(failure)).not.toContain(value)
  }
})

test.each([
  ['remote: refusing to allow a Personal Access Token to create or update workflow `x` without `workflow` scope', 'workflow_scope_required'],
  ['fatal: requested URL returned error: 403', 'write_permission_denied'],
  ['! rejected (non-fast-forward)', 'non_fast_forward'],
  ['! rejected (fetch first)', 'non_fast_forward'],
  ['remote: GH013: Repository rule violations found', 'branch_policy_rejected'],
  ['remote: GH006: Protected branch update failed', 'branch_policy_rejected'],
  ['fatal: Authentication failed for private URL', 'authentication_required'],
  ['fatal: Could not resolve host: private-host', 'transport_error'],
  ['private unknown error', 'push_failed'],
])('classifies %s without guessing extra OAuth permissions', (stderr, reasonCode) => {
  const failure = githubPushFailure({ exitCode: 1, stdout: '', stderr }, 'unconfirmed')
  expect(failure.reasonCode).toBe(reasonCode)
  expect(failure.publicationState).toBe('unconfirmed')
  if (reasonCode !== 'workflow_scope_required') expect(failure.requiredScope).toBeUndefined()
})

test('timeout remains distinct from remote rejection', () => {
  expect(githubPushFailure({ exitCode: 1, stdout: '', stderr: '', timedOut: true }, 'unconfirmed'))
    .toMatchObject({ reasonCode: 'transport_timeout', retryable: true, publicationState: 'unconfirmed' })
})

test('successful transport with uncertain remote state is not reported as a rejected push', () => {
  expect(githubPushFailure({ exitCode: 0, stdout: 'ok', stderr: '' }, 'unconfirmed'))
    .toMatchObject({ reasonCode: 'publication_unconfirmed', retryable: false, publicationState: 'unconfirmed' })
})
