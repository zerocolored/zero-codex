import { expect, test } from 'bun:test'
import { assertClaudeAuthStatus } from './claude-auth-status.ts'
import { AdvisorFailureError, advisorFailureMessage, type AdvisorFailure } from './advisor-availability.ts'
import { recoverAdvisorSlot } from './advisor-retry.ts'

const ready = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' })
function failure(result: Parameters<typeof assertClaudeAuthStatus>[0]): AdvisorFailure {
  try { assertClaudeAuthStatus(result) } catch (error) {
    expect(error).toBeInstanceOf(AdvisorFailureError)
    return (error as AdvisorFailureError).failure
  }
  throw new Error('Expected failed authentication check')
}

test('exit 1の有効JSONを捨てず未ログインを明示する', () => {
  const result = { exitCode: 1, stderr: '', stdout: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', email: 'private@example.invalid' }) }
  expect(failure(result).cause).toBe('authentication')
  expect(advisorFailureMessage(failure(result))).toContain('ログイン')
  expect(advisorFailureMessage(failure(result))).not.toContain('private@')
  expect(() => assertClaudeAuthStatus(result)).not.toThrow('private@')
})

test('正常subscriptionだけ許可し非zeroの成功JSONは許可しない', () => {
  expect(() => assertClaudeAuthStatus({ exitCode: 0, stdout: ready, stderr: '' })).not.toThrow()
  expect(failure({ exitCode: 1, stdout: ready, stderr: '' }).cause).toBe('auth-check')
  expect(failure({ exitCode: 0, stdout: ready.replace('claude.ai', 'api_key'), stderr: '' }).cause).toBe('configuration')
})

test('不完全な実行結果や不正JSONを未ログインと断定しない', () => {
  const base = { exitCode: 1, stdout: '{"loggedIn":false}', stderr: '' }
  expect(failure({ ...base, timedOut: true }).cause).toBe('timeout')
  expect(failure({ ...base, forcedCleanup: true }).cause).toBe('auth-check')
  expect(failure({ ...base, outputTruncated: true }).cause).toBe('auth-check')
  expect(failure({ ...base, stdout: 'not JSON' }).cause).toBe('auth-check')
  expect(failure({ ...base, exitCode: null }).cause).toBe('auth-check')
})

test('明示された課金・通信・制限だけを分類しraw診断は公開しない', () => {
  for (const [stderr, cause] of [['Payment Required: secret-dummy', 'billing'], ['ECONNRESET secret-dummy', 'network'], ['429 quota secret-dummy', 'rate-limit']] as const) {
    const result = { exitCode: 1, stdout: '', stderr }
    expect(failure(result).cause).toBe(cause)
    expect(advisorFailureMessage(failure(result))).not.toContain('secret-dummy')
    expect(() => assertClaudeAuthStatus(result)).not.toThrow('secret-dummy')
  }
  expect(failure({ exitCode: 0, stdout: '{"loggedIn":true,"subscriptionType":null}', stderr: '' }).cause).toBe('configuration')
})

test('認証・課金・設定は1回、通信・確認障害は30秒60秒で再試行する', async () => {
  for (const cause of ['authentication', 'billing', 'configuration', 'network', 'auth-check'] as const) {
    let calls = 0
    const waits: number[] = []
    const retryable = cause === 'network' || cause === 'auth-check'
    const result = await recoverAdvisorSlot({ advisor: 'claude',
      run: async () => ({ adopted: ++calls === 3, containmentVerified: true, promptMayHaveBeenDelivered: false, reason: 'opaque', failure: { advisor: 'claude' as const, cause } }),
      persist: () => {}, wait: async ms => { waits.push(ms) },
    })
    expect(calls).toBe(retryable ? 3 : 1)
    expect(waits).toEqual(retryable ? [30_000, 60_000] : [])
    expect(result.adopted).toBe(retryable)
  }
})
