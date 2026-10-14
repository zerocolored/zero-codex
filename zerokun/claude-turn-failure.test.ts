import { expect, test } from 'bun:test'
import { ClaudeTurnFailure } from './claude-turn-failure.ts'
import { claudeResult } from './claude-control-session.ts'
const failed = { type: 'result', subtype: 'success', is_error: true, result: 'error' }
test('native quota timestamp is retained only for an authoritative failed root result', () => {
  const state = new ClaudeTurnFailure()
  state.observe({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 200 } })
  state.observe({ type: 'assistant', error: 'rate_limit' })
  expect(state.terminal({ ...failed, api_error_status: 429 }, 100_000)).toEqual({ reason: 'rate-limit', resumeAt: 200_000 })
  expect(state.terminal({ ...failed, is_error: false })).toBeNull()
  expect(state.terminal({ ...failed, parent_tool_use_id: 'child' })).toBeNull()
  expect(state.terminal({ ...failed, api_error_status: 403 })).toBeNull()
})
test('model prose and unknown network failures never authorize a replay; structured server failures do', () => {
  const state = new ClaudeTurnFailure()
  state.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'rate limit 429' }] } })
  expect(state.terminal(failed)).toBeNull()
  expect(state.terminal({ ...failed, api_error_status: 529 }, 1_000)).toEqual({ reason: 'capacity', resumeAt: 31_000 })
  expect(state.terminal({ ...failed, api_error_status: 503 }, 1_000)?.reason).toBe('capacity')
  expect(state.terminal({ ...failed, api_error_status: 401 })).toBeNull()
})
test('background, peer and unknown injected results do not complete the host request', () => {
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'done' }
  for (const kind of ['task-notification', 'peer', 'future-kind']) expect(claudeResult({ ...result, origin: { kind } })).toBeNull()
  expect(claudeResult({ ...result, origin: { kind: 'human' } })).toEqual({ kind: 'success', text: 'done' })
})
