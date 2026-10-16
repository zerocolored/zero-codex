import { expect, test } from 'bun:test'
import { classifyCodexFailure, codexRateLimitResumeAt, legacyTransportThrottle, throttleRetryDelay } from './codex-rate-limit.ts'
import { extractCodexRateLimit, describeCodexFailure } from './codex-executor.ts'

const incident = { error: {
  message: 'exceeded retry limit, last status: 429 Too Many Requests',
  codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
  additionalDetails: null,
} }

test('incident 429 without quota/reset uses 30 seconds, not a fabricated 61-minute reset', () => {
  const now = 1791969902206
  const info = classifyCodexFailure(incident, now)
  expect(info).toEqual({ rateLimited: true, reason: 'throttled', resetsAtMs: now + 30_000 })
  expect(codexRateLimitResumeAt(info.resetsAtMs!, now, info.reason!)).toBe(now + 30_000)
  expect([0, 1, 2, 3, 4, 100].map(throttleRetryDelay)).toEqual([30_000, 60_000, 120_000, 300_000, 300_000, 300_000])
})

test('explicit quota wins over 429 and capacity and retains its reset', () => {
  for (const signal of ['usageLimitExceeded', 'usage_limit_reached', 'insufficient_quota', 'quota exhausted']) {
    expect(classifyCodexFailure({ error: { code: signal, message: '429 model is at capacity', resets_at: 1791970000 } }, 1791969900000))
      .toEqual({ rateLimited: true, reason: 'rate-limit', resetsAtMs: 1791970000000 })
  }
})

test('provider timing is honored separately from relative backoff and stale timestamps do not spin', () => {
  const now = 1791969900000
  for (const timing of [{ retry_after: 900 }, { retryAfter: 900 }, { resets_at: (now + 900_000) / 1000 }, { resetsAt: now + 900_000 }]) {
    const info = classifyCodexFailure({ error: { message: '429', ...timing } }, now, 3)
    expect(codexRateLimitResumeAt(info.resetsAtMs!, now, info.reason!)).toBe(now + 900_000)
  }
  expect(codexRateLimitResumeAt(now - 1, now, 'throttled')).toBe(now + 1000)
  expect(classifyCodexFailure({ error: { message: '429', reset_at: (now - 1000) / 1000 } }, now, 2).resetsAtMs)
    .toBe(now + 120_000)
  expect(classifyCodexFailure({ error: { message: 'Selected model is at capacity.' } }, now).reason).toBe('capacity')
})

test('conversation prose and earlier failures cannot classify a later unrelated terminal', () => {
  const prose = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'usage_limit_reached 429' } })
  expect(extractCodexRateLimit(prose).rateLimited).toBe(false)
  const errors = [JSON.stringify({ type: 'error', ...incident }), JSON.stringify({ type: 'turn.failed', error: { message: 'invalid request' } })].join('\n')
  expect(extractCodexRateLimit(errors).rateLimited).toBe(false)
})

test('legacy migration requires the complete exact transport diagnostic, not a duration or guessed quota', () => {
  const diagnostic = (record: unknown) => describeCodexFailure(1, JSON.stringify({ type: 'turn.failed', ...record as object }), '')
  expect(legacyTransportThrottle(diagnostic(incident))).toBe(true)
  expect(legacyTransportThrottle(diagnostic({ error: { ...incident.error, retry_after: 3600 } }))).toBe(false)
  expect(legacyTransportThrottle(diagnostic({ error: { ...incident.error, code: 'usage_limit_reached' } }))).toBe(false)
  expect(legacyTransportThrottle('429 Too Many Requests')).toBe(false)
  expect(legacyTransportThrottle(diagnostic(incident).slice(0, 100))).toBe(false)
})
