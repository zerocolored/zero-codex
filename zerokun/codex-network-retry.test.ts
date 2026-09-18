import { expect, test } from 'bun:test'
import { CODEX_NETWORK_RETRY_DELAYS_MS, isTransientCodexNetworkError } from './codex-network-retry.ts'
import { publicJobFailureSummary } from './job-runner.ts'

test('network retry uses bounded backoff and reports exhaustion specifically', () => {
  expect(CODEX_NETWORK_RETRY_DELAYS_MS).toEqual([5000, 15000, 30000])
  expect(publicJobFailureSummary('Codex network recovery exhausted after 3 retries.')).toContain('自動再試行3回')
})

test('classifies structured upstream failures, not assistant prose or permanent failures', () => {
  for (const variant of ['responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts', 'httpConnectionFailed', 'internalServerError']) {
    expect(isTransientCodexNetworkError({ codexErrorInfo: variant })).toBe(true)
    expect(isTransientCodexNetworkError({ codexErrorInfo: { [variant]: { httpStatusCode: null } } })).toBe(true)
    for (const status of [408, 500, 502, 503, 504]) {
      expect(isTransientCodexNetworkError({ codexErrorInfo: { [variant]: { httpStatusCode: status } } })).toBe(true)
    }
    for (const status of [400, 401, 403, 404, 409, 422, 429, 501]) {
      expect(isTransientCodexNetworkError({ codexErrorInfo: { [variant]: { httpStatusCode: status } } })).toBe(false)
    }
  }
  for (const codexErrorInfo of ['other', 'badRequest', 'unauthorized', 'usageLimitExceeded', 'sandboxError', null]) {
    expect(isTransientCodexNetworkError({ codexErrorInfo, message: 'network timeout ECONNRESET 503' })).toBe(false)
  }
  expect(isTransientCodexNetworkError({ codexErrorInfo: 'other', code: 'unsupported_parameter', message: 'The access_programs parameter is not enabled for this organization.' })).toBe(false)
  expect(isTransientCodexNetworkError({ codexErrorInfo: 'responseStreamDisconnected', code: 'unsupported_parameter' })).toBe(false)
  expect(isTransientCodexNetworkError({ codexErrorInfo: { badRequest: { httpStatusCode: 503 } } })).toBe(false)
})
