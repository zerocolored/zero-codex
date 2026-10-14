import type { CodexAppServerSession } from './codex-app-server-session.ts'

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
export type NativeGoal = { objective: string; status: GoalStatus }
type GoalSession = Pick<CodexAppServerSession, 'request'>

export async function readTaskGoal(session: GoalSession, threadId: string): Promise<NativeGoal | null> {
  const { result } = await session.request('thread/goal/get', { threadId }, { timeoutMs: 15_000 })
  if (result.goal === null) return null
  const goal = result.goal as Record<string, unknown> | undefined
  if (!goal || typeof goal.objective !== 'string'
    || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(String(goal.status))) {
    throw new Error('Codex returned an invalid task goal')
  }
  return goal as NativeGoal
}

export function taskGoalObjective(taskId: string): string {
  return `Complete the current Slack task (${taskId}) and its accepted follow-up instructions within the requested scope, including requested verification and delivery. Continue while actionable work remains; an interim summary or list of remaining tasks is not completion. Do not add unrelated improvements. Preserve prior work and approved decisions. If user judgment, authorization, authentication, or an external blocker is genuinely required, explain the specific blocker and leave the goal blocked or paused, not complete. Honor cancellation. The full task and attachments are in the conversation.`
}

export async function ensureTaskGoal(session: GoalSession, threadId: string, taskId: string): Promise<void> {
  const goal = await readTaskGoal(session, threadId)
  // A resumed unfinished thread keeps its objective and usage history. A completed
  // task receives a fresh goal, even if this is another request in the same thread.
  if (!goal || goal.status === 'complete') {
    await session.request('thread/goal/set', {
      threadId, objective: taskGoalObjective(taskId), status: 'active',
    }, { timeoutMs: 15_000 })
  } else if (goal.status === 'blocked' || goal.status === 'paused') {
    await session.request('thread/goal/set', { threadId, status: 'active' }, { timeoutMs: 15_000 })
  }
}

/** A complete parent must first collect its still-running delegated work. This
 * resumes the existing native goal, never starts a second synthetic user turn. */
export async function retainGoalForDelegation(session: GoalSession, threadId: string, taskId: string,
  goal: NativeGoal | null, delegationId: string | null): Promise<NativeGoal | null> {
  if (!delegationId || goal?.status !== 'complete') return goal
  const objective = taskGoalObjective(taskId) + ` Existing Claude delegation ${delegationId} is still running. Poll that same id with claude_delegate_poll, inspect its result and changes, then finish verification and delivery. Do not launch it again.`
  await session.request('thread/goal/set', { threadId, objective, status: 'active' }, { timeoutMs: 15_000 })
  return { objective, status: 'active' }
}

/** Reuse the existing round and native goal; real approval and quota waits stay put. */
export async function retainGoalForAdvisors(session: GoalSession, threadId: string, taskId: string,
  goal: NativeGoal | null, round: {phase: string; round: number; inputRevision: number}): Promise<NativeGoal | null> {
  if (goal?.status !== 'complete') return goal
  const objective = taskGoalObjective(taskId) + ` The existing ${round.phase} advisor round ${round.round} for input revision ${round.inputRevision} is still running. Use advisor_round_poll to collect that same round; while pending=true, keep polling within its existing deadline, then incorporate the available answers before your final report. Do not launch another round or replace unavailable reviewers. A terminal unavailable slot does not block the task. Preserve existing user approvals and any unresolved approval wait. Do not request approval again for an already approved direction.`
  await session.request('thread/goal/set', { threadId, objective, status: 'active' }, { timeoutMs: 15_000 })
  return { objective, status: 'active' }
}
