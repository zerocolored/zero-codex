import { expect, test } from 'bun:test'
import { retryAdvisorConnection } from './advisor-connection-retry.ts'
import { retryableClaudeObservation } from './advisor-broker.ts'
import { HerdrObservationUnavailableError } from './herdr-runtime.ts'
import { ClaudeReadError } from './claude-response-diagnostic.ts'

test('接続確認は従来の回数を超えて回復まで待ち、間隔には上限を設ける', async () => {
  let calls = 0
  const waits: number[] = []
  const result = await retryAdvisorConnection({
    read: async () => { if (++calls < 9) throw new HerdrObservationUnavailableError('probe unavailable'); return 'same target' },
    retryable: retryableClaudeObservation, wait: async ms => { waits.push(ms) },
  })
  expect(result).toBe('same target')
  expect(calls).toBe(9)
  expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
})

test('一時的な観測失敗だけを再試行し、foreign targetや秘密検出を隠さない', () => {
  expect(retryableClaudeObservation(new HerdrObservationUnavailableError('probe failed'))).toBe(true)
  expect(retryableClaudeObservation(new ClaudeReadError({ stage: 'transcript', kind: 'command', timedOut: true }))).toBe(true)
  for (const code of ['agent_not_found', 'pane_not_found', 'invalid_params'] as const) {
    expect(retryableClaudeObservation(new ClaudeReadError({ stage: 'transcript', kind: 'command', code }))).toBe(false)
  }
  expect(retryableClaudeObservation(new Error('owned identity changed'))).toBe(false)
  expect(retryableClaudeObservation(new Error('credential material'))).toBe(false)
})

test('接続再試行のsleepは中止直後に終了し、新しいreadを送らない', async () => {
  const controller = new AbortController()
  let calls = 0
  const stopped = new Error('explicit cancellation')
  const pending = retryAdvisorConnection({
    signal: controller.signal,
    read: async () => { calls++; throw new HerdrObservationUnavailableError('unavailable') },
    retryable: retryableClaudeObservation,
    onRetry: () => { setTimeout(() => controller.abort(stopped), 10) },
  })
  await expect(pending).rejects.toBe(stopped)
  expect(calls).toBe(1)
})
