import { expect, test } from 'bun:test'
import { ensureTaskGoal, readTaskGoal, retainGoalForAdvisors, taskGoalObjective, type NativeGoal } from './codex-goal.ts'

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

test('completed parent collects its existing advisor round without launching a replacement', async () => {
  const goal = { objective: 'task', status: 'complete' as const }, session = fixture(goal)
  const result = await retainGoalForAdvisors(session, 'root', 'job', goal,
    { phase: 'investigation', round: 1, inputRevision: 2 })
  expect(result?.status).toBe('active')
  expect(session.calls).toHaveLength(1)
  expect(session.calls[0]!.params.objective).toContain('advisor_round_poll')
  expect(session.calls[0]!.params.objective).toContain('Do not launch another round')
  expect(session.calls[0]!.params.objective).toContain('unresolved approval wait')
})
test.each(['paused', 'blocked', 'usageLimited', 'budgetLimited', 'active'] as const)(
  'advisor collection preserves %s goal', async status => {
    const goal = { objective: 'task', status }, session = fixture(goal)
    expect(await retainGoalForAdvisors(session, 'root', 'job', goal,
      { phase: 'investigation', round: 1, inputRevision: 1 })).toEqual(goal)
    expect(session.calls).toHaveLength(0)
  })
