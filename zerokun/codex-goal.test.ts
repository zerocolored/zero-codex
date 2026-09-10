import { expect, test } from 'bun:test'
import { ensureTaskGoal, readTaskGoal, taskGoalObjective, type NativeGoal } from './codex-goal.ts'

function fixture(goal: NativeGoal | null) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  return { calls, request: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    return { requestId: calls.length, result: { goal } }
  } }
}
test('new task creates a bounded native goal without an implicit token budget', async () => {
  const session = fixture(null)
  await ensureTaskGoal(session, 'root', 'job-1')
  expect(session.calls[1]).toEqual({ method: 'thread/goal/set', params: {
    threadId: 'root', objective: taskGoalObjective('job-1'), status: 'active',
  } })
  expect(taskGoalObjective('job-1').length).toBeLessThan(4000)
})
test('active goal and native quota states preserve objective and usage', async () => {
  for (const status of ['active', 'usageLimited', 'budgetLimited'] as const) {
    const session = fixture({ objective: 'previous task', status })
    await ensureTaskGoal(session, 'root', 'job-2')
    expect(session.calls).toHaveLength(1)
  }
})
test('user continuation reactivates waiting goal without replacing objective', async () => {
  for (const status of ['blocked', 'paused'] as const) {
    const session = fixture({ objective: 'previous task', status })
    await ensureTaskGoal(session, 'root', 'job-2')
    expect(session.calls[1]?.params).toEqual({ threadId: 'root', status: 'active' })
  }
})
test('completed goal is replaced for the next request', async () => {
  const session = fixture({ objective: 'old', status: 'complete' })
  await ensureTaskGoal(session, 'root', 'job-2')
  expect(session.calls[1]?.params.objective).toBe(taskGoalObjective('job-2'))
})
test('malformed goal is not treated as completed', async () => {
  const session = fixture({ objective: 'old', status: 'invalid' as any })
  await expect(readTaskGoal(session, 'root')).rejects.toThrow('invalid task goal')
})
