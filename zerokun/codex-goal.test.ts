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

test('blocked goal asks only for a necessary permitted action and preserves consent', () => {
  const objective = taskGoalObjective('job-1')
  expect(objective).toContain('Only when a necessary and permitted user action remains')
  expect(objective).toContain('お願い: <who> が <what> してください')
  expect(objective).toContain('do not request the same approval again')
  expect(objective).toContain('do not turn it into a request for the user to run the denied command')
  expect(objective).toContain('report the actual blocker instead of inventing an ask')
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

test('legacy goals retain their exact objective and usage; developer context supersedes old reply guidance', async () => {
  const legacy = "If user judgment, authorization, authentication, or an external blocker is genuinely required, leave the goal blocked or paused, not complete, and open your Slack reply with one line naming the single concrete action the reader must take, in the form `お願い: <who> が <what> してください`. Name the person or role, the exact command, file path, screen, or setting, and where it is. Do not open with what you investigated, what you confirmed, or internal execution records; those belong after that line. If you truly need nothing from the reader, say so in that first line instead."
  for (const status of ['active', 'blocked', 'paused', 'usageLimited', 'budgetLimited'] as const) {
    const objective = 'Original approved task. ' + legacy + ' Existing delegation abc: collect its result.'
    const session = fixture({ objective, status })
    await ensureTaskGoal(session, 'root', 'different-job')
    if (status === 'blocked' || status === 'paused') {
      expect(session.calls[1]!.params).toEqual({ threadId: 'root', status: 'active' })
    } else {
      expect(session.calls).toHaveLength(1)
    }
  }
})
