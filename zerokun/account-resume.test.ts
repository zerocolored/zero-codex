import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore, type JobRecord } from './job-runner.ts'
import { readAdvisorInputSnapshot } from './advisor-input.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture(beforeDelivery = false, beforeRequeue?: (store: JobStore, job: JobRecord) => void) {
  const root = mkdtempSync(join(tmpdir(), 'account-resume-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'jobs.sqlite3')
  let store = new JobStore(path)
  cleanup.push(() => store.close())
  store.enqueue({ chatId: 'C1', threadTs: '1.0', messageId: '1.0', userId: 'U1',
    repoPath: root, task: 'preserve original work', writeEnabled: true })
  const job = store.claimNext('worker')!
  const snapshot = readAdvisorInputSnapshot(root, job.id)
  const binding = { jobId: job.id, attempt: job.attempts, epoch: job.controlEpoch,
    executorNonce: 'a'.repeat(32), threadId: 'original-thread', requestId: 61 }
  const resetAt = Date.now() + 3_600_000
  if (!beforeDelivery) {
    store.beginInitialTurnDispatch({ ...binding, inputRevision: snapshot.revision, inputDigest: snapshot.digest })
    store.acknowledgeInitialTurnDispatch({ ...binding, workerId: job.workerId!, turnId: 'stopped-turn' })
    store.finishAppServerTurn({ ...binding, turnId: 'stopped-turn', retainInput: true,
      rateLimitResumeAt: resetAt, rateLimitReason: 'rate-limit', rateLimitSafeToReplay: false })
  }
  beforeRequeue?.(store, job)
  store.requeueAt(job.id, resetAt, 'usage limit', beforeDelivery ? undefined : binding.threadId)
  const input = { chatId: job.chatId, threadTs: job.threadTs, repoPath: root,
    messageId: `${(Date.now() + 1) / 1000}`, writeEnabled: true }
  return { root, path, job, resetAt, input, get store() { return store },
    reopen() { store.close(); store = new JobStore(path) },
    mutate(sql: string) { const db = new Database(path); try { db.run(sql) } finally { db.close() } } }
}

test('usage failure before initial delivery can retry without inventing a terminal receipt', () => {
  const f = fixture(true)
  expect(f.store.get(f.job.id)?.rateLimitRecovery).toBeNull()
  expect(f.store.resumeLocalRateLimitedJob(f.input)).toBe('resumed')
  expect(f.store.claimNext('new-account')).toMatchObject({ id: f.job.id, attempts: 2, rateLimitRecovery: null })
})

test('resume arriving during terminal cleanup is consumed when the worker requeues, without a restart', () => {
  const f = fixture(false, (store, job) => {
    expect(store.hasLocalRateLimitWait(job.chatId, job.threadTs)).toBe(true)
    const target = store.liveControlTarget(job.chatId, job.threadTs)!
    expect(store.stageThreadReply(target, { chatId: job.chatId, threadTs: job.threadTs,
      messageId: `${(Date.now() + 1) / 1000}`, userId: 'U1', writeEnabled: true, task: '再開して' })).toBe('staged')
    expect(store.listJobInterjections(job.id)[0]?.status).toBe('ready')
  })
  expect(f.store.get(f.job.id)?.notBefore).toBeNull()
  expect(f.store.listJobInterjections(f.job.id)[0]?.status).toBe('superseded')
  expect(f.store.claimNext('new-account')?.id).toBe(f.job.id)
})

test('explicit resume clears old delay, preserves unsafe-to-replay history and survives duplicate delivery/restart', () => {
  const f = fixture()
  const before = f.store.get(f.job.id)!
  expect(f.store.claimNext('too-early')).toBeNull()
  expect(f.store.resumeLocalRateLimitedJob(f.input)).toBe('resumed')
  expect(f.store.get(f.job.id)).toMatchObject({ task: before.task, inputRevision: before.inputRevision,
    sessionId: before.sessionId, rateLimitRecovery: before.rateLimitRecovery, notBefore: null })
  f.reopen()
  expect(f.store.resumeLocalRateLimitedJob(f.input)).toBe('duplicate')
  const notices = f.store.pendingStatusNotifications().filter(n => n.payload.includes('再開依頼'))
  expect(notices).toHaveLength(1)
  expect(f.store.claimNext('new-login')).toMatchObject({ id: f.job.id, attempts: 2, resumed: true,
    rateLimitRecovery: { safeToReplay: false } })
  expect(f.store.pendingStatusNotifications().filter(n => n.payload.includes('再開依頼'))).toHaveLength(1)
  expect(f.store.claimNext('duplicate-worker')).toBeNull()
})

for (const [name, sql] of [
  ['cancelled', 'UPDATE jobs SET cancel_requested_at=1'],
  ['active executor', 'UPDATE jobs SET executor_pid=123'],
  ['active turn', "UPDATE jobs SET active_turn_id='still-running'"],
  ['pending result', "UPDATE jobs SET pending_result='unfinished-delivery'"],
  ['UI approval', "UPDATE jobs SET ui_approval_request_id='waiting-for-approval'"],
  ['corrupt terminal', "UPDATE jobs SET rate_limit_terminal_json='{}'"],
  ['wrong epoch', 'UPDATE jobs SET control_epoch=control_epoch+1'],
  ['wrong session', "UPDATE jobs SET session_id='unrelated-thread'"],
] as const) test(`resume fails closed with a durable explanation: ${name}`, () => {
  const f = fixture(); f.mutate(sql)
  expect(f.store.resumeLocalRateLimitedJob(f.input)).toBe('blocked')
  expect(f.store.get(f.job.id)?.notBefore).toBe(f.resetAt)
  expect(f.store.pendingStatusNotifications().some(n => n.payload.includes('再開していません'))).toBe(true)
})

test('resume respects write authority and does not select another thread, repository or an older task', () => {
  const f = fixture()
  expect(f.store.resumeLocalRateLimitedJob({ ...f.input, threadTs: 'other' })).toBeNull()
  expect(f.store.resumeLocalRateLimitedJob({ ...f.input, repoPath: '/other' })).toBeNull()
  expect(f.store.resumeLocalRateLimitedJob({ ...f.input, writeEnabled: false })).toBe('blocked')
  expect(f.store.get(f.job.id)?.notBefore).toBe(f.resetAt)
  f.store.enqueue({ chatId: 'C1', threadTs: '1.0', messageId: 'later-task', userId: 'U1',
    repoPath: f.root, task: 'new task', writeEnabled: true })
  expect(f.store.resumeLocalRateLimitedJob({ ...f.input, messageId: `${Number(f.input.messageId) + 10}` })).toBeNull()
})

test('cloud-owned work remains on its ownership protocol and stale pre-limit messages cannot wake a new limit', () => {
  const f = fixture()
  expect(f.store.resumeLocalRateLimitedJob({ ...f.input, messageId: '2.0' })).toBe('blocked')
  expect(f.store.get(f.job.id)?.notBefore).toBe(f.resetAt)
  f.store.bindCloudHandoff(f.job.id, '11111111-1111-4111-8111-111111111111', 1, '{}')
  expect(f.store.resumeLocalRateLimitedJob(f.input)).toBeNull()
})

test('upgrade recovers the already acknowledged resume question once, while preserving ordinary pending questions', () => {
  const f = fixture(), target = f.store.liveControlTarget(f.input.chatId, f.input.threadTs)!
  expect(f.store.stageLiveInterjection(target, { ...f.input, userId: 'U1', task: '再開して' })).toBe('staged')
  const other = { ...f.input, messageId: `${Number(f.input.messageId) + 1}`, userId: 'U1', task: '進捗を教えて' }
  expect(f.store.stageLiveInterjection(target, other)).toBe('staged')
  expect(f.store.get(f.job.id)?.notBefore).toBe(f.resetAt)
  f.reopen()
  expect(f.store.recoverInterrupted()).toEqual({ requeued: 0, failedWrites: 0, failedUncertain: 0 })
  expect(f.store.recoverQueuedRateLimitResumes()).toBe(0)
  expect(f.store.get(f.job.id)?.notBefore).toBeNull()
  expect(f.store.listJobInterjections(f.job.id).map(i => [i.task, i.status])).toEqual([
    ['再開して', 'superseded'], ['進捗を教えて', 'ready'],
  ])
  expect(f.store.pendingStatusNotifications().filter(n => n.payload.includes('再開依頼'))).toHaveLength(1)
})

test('notification persistence failure rolls back wait release and event consumption together', () => {
  const f = fixture()
  f.mutate(`CREATE TRIGGER reject_resume_notification BEFORE INSERT ON status_notifications
    WHEN NEW.idempotency_key LIKE 'local-resume:%' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
  expect(() => f.store.resumeLocalRateLimitedJob(f.input)).toThrow('fixture failure')
  expect(f.store.get(f.job.id)?.notBefore).toBe(f.resetAt)
  expect(f.store.hasDurableEvent(`${f.input.chatId}:${f.input.messageId}`)).toBe(false)
  f.mutate('DROP TRIGGER reject_resume_notification')
  expect(f.store.resumeLocalRateLimitedJob(f.input)).toBe('resumed')
})

for (const config of [JSON.stringify({ slackAppId: null }), JSON.stringify({ slackAcceptAfter: Date.now() + 3_600_000 }), '{invalid json', JSON.stringify({ slackAcceptAfter: "invalid" })])
test(`startup preserves an old resume refused by project admission without blocking other work: ${JSON.stringify(config)}`, () => {
  const f = fixture(), target = f.store.liveControlTarget(f.input.chatId, f.input.threadTs)!
  f.store.stageLiveInterjection(target, { ...f.input, userId: 'U1', task: '再開して' })
  mkdirSync(join(f.root, '.zerochan'), { mode: 0o700 })
  writeFileSync(join(f.root, '.zerochan/config.json'), config, { mode: 0o600 })
  const otherRoot = mkdtempSync(join(tmpdir(), 'resume-other-'))
  cleanup.push(() => rmSync(otherRoot, { recursive: true, force: true }))
  const other = f.store.enqueue({ chatId: 'C2', threadTs: '2.0', messageId: '2.0', userId: 'U1',
    repoPath: otherRoot, task: 'independent work', writeEnabled: true }).job
  f.reopen()
  expect(() => f.store.recoverInterrupted()).not.toThrow()
  expect(f.store.get(f.job.id)?.notBefore).toBe(f.resetAt)
  expect(f.store.listJobInterjections(f.job.id)[0]?.status).toBe('ready')
  expect(f.store.claimNext('other-project')?.id).toBe(other.id)
})

test('normal pending questions do not shorten the reset; a resume admitted through the inbound drain does', () => {
  const f = fixture(), target = f.store.liveControlTarget(f.input.chatId, f.input.threadTs)!
  expect(f.store.stageThreadReply(target, { ...f.input, userId: 'U1', task: '進捗を教えて' })).toBe('staged')
  expect(f.store.get(f.job.id)?.notBefore).toBe(f.resetAt)
  const next = { ...f.input, messageId: `${Number(f.input.messageId) + 1}` }
  f.store.stageInboundDelivery({ ...next, userId: 'U1', text: '再開して' })
  expect(f.store.claimNextInboundDelivery()?.messageId).toBe(next.messageId)
  expect(f.store.stageThreadReply(target, { ...next, userId: 'U1', task: '再開して' })).toBe('staged')
  f.store.completeInboundDelivery(`${next.chatId}:${next.messageId}`)
  expect(f.store.get(f.job.id)?.notBefore).toBeNull()
  expect(f.store.hasDurableEvent(`${next.chatId}:${next.messageId}`)).toBe(true)
})

test('a new provider limit after an explicit retry stays deferred and old delivery cannot trigger a retry loop', () => {
  const f = fixture()
  expect(f.store.resumeLocalRateLimitedJob(f.input)).toBe('resumed')
  const job = f.store.claimNext('fresh-login')!
  const snapshot = readAdvisorInputSnapshot(f.root, job.id)
  const binding = { jobId: job.id, attempt: job.attempts, epoch: job.controlEpoch,
    executorNonce: 'b'.repeat(32), threadId: 'original-thread', requestId: 62 }
  f.store.beginInitialTurnDispatch({ ...binding, inputRevision: snapshot.revision, inputDigest: snapshot.digest })
  f.store.acknowledgeInitialTurnDispatch({ ...binding, workerId: job.workerId!, turnId: 'another-limit' })
  const resetAt = Date.now() + 7_200_000
  f.store.finishAppServerTurn({ ...binding, turnId: 'another-limit', retainInput: true,
    rateLimitResumeAt: resetAt, rateLimitReason: 'rate-limit', rateLimitSafeToReplay: false })
  f.store.requeueAt(job.id, resetAt, 'new account is also limited', binding.threadId)
  f.reopen()
  expect(f.store.resumeLocalRateLimitedJob(f.input)).toBe('duplicate')
  expect(f.store.recoverQueuedRateLimitResumes()).toBe(0)
  expect(f.store.claimNext('no-loop')).toBeNull()
  expect(f.store.get(job.id)?.notBefore).toBe(resetAt)
  expect(f.store.pendingStatusNotifications().some(n => n.payload.includes('使用量上限'))).toBe(true)
  // A later automatic attempt must not reuse an override for the old terminal.
  expect(f.store.claimNext('after-new-reset', 20, resetAt + 1)?.id).toBe(f.job.id)
  f.reopen()
  expect(f.store.recoverInterrupted().requeued).toBe(1)
  expect(f.store.get(f.job.id)?.notBefore).toBe(resetAt)
  expect(f.store.claimNext('old-override-must-not-wake')).toBeNull()
})

test('classifier bypass does not claim an ordinary running task without a terminal receipt', () => {
  const f = fixture(true, (store, job) => {
    expect(store.hasLocalRateLimitWait(job.chatId, job.threadTs)).toBe(false)
  })
  expect(f.store.hasLocalRateLimitWait(f.job.chatId, f.job.threadTs)).toBe(true)
})

test.each([false, true])('an accepted resume survives a runner restart after claim but before model delivery (initially undelivered: %s)', beforeDelivery => {
  const f = fixture(beforeDelivery)
  const receipt = f.store.get(f.job.id)!.rateLimitRecovery
  expect(f.store.resumeLocalRateLimitedJob(f.input)).toBe('resumed')
  expect(f.store.claimNext('crashes-before-send')?.id).toBe(f.job.id)
  f.reopen()
  expect(f.store.recoverInterrupted()).toEqual({ requeued: 1, failedWrites: 0, failedUncertain: 0 })
  expect(f.store.get(f.job.id)?.rateLimitRecovery).toEqual(receipt)
  expect(f.store.claimNext('recovered-runner')?.id).toBe(f.job.id)
})
