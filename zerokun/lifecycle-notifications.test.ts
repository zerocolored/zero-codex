import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  JobStore,
  SLACK_QUEUE_WAIT_MESSAGE,
  SLACK_RATE_LIMIT_WAIT_MESSAGE,
  SlackNotifier,
  flushCommentaryNotifications,
  flushInterjectionNotifications,
  flushLifecycleNotifications,
  flushStatusNotifications,
  flushTerminalNotifications,
  runQueuedJobs,
  sealArtifactResult,
} from './job-runner.ts'
import { artifactDirForJob, CodexInterruptedError } from './codex-executor.ts'
import { readAdvisorInputSnapshot } from './advisor-input.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runningJob(): { root: string; store: JobStore; job: NonNullable<ReturnType<JobStore['claimNext']>> } {
  const root = mkdtempSync(join(tmpdir(), 'zerochan-lifecycle-'))
  roots.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const store = new JobStore(join(root, 'state', 'jobs.sqlite3'))
  store.enqueue({
    chatId: 'D1', threadTs: '1.0', messageId: '1.0', userId: 'U1',
    repoPath: repo, task: 'hello', writeEnabled: true,
  })
  const job = store.claimNext('worker-1')
  if (!job) throw new Error('fixture job was not claimed')
  return { root, store, job }
}

function completeWriteFixture(
  store: JobStore,
  job: NonNullable<ReturnType<JobStore['claimNext']>>,
  sessionId: string,
  result: string,
): void {
  const input = readAdvisorInputSnapshot(dirname(store.dbPath), job.id)
  store.ensureExecutionResultStaged(job.id, sessionId, result, {
    version: 1,
    jobId: job.id,
    jobAttempt: job.attempts,
    logicalNonce: '0'.repeat(32),
    inputRevision: input.revision,
    inputDigest: input.digest,
    reviewRound: 1,
    reviewedRepositoryDigest: '1'.repeat(64),
    baselineDigest: '2'.repeat(64),
    plans: [],
  })
  store.completeStagedExecution(job.id)
}

function stageAnsweredInterjection(
  store: JobStore,
  job: NonNullable<ReturnType<JobStore['claimNext']>>,
  disposition: 'answer-only' | 'task-update',
) {
  const target = store.liveControlTarget(job.chatId, job.threadTs)
  if (!target || !job.workerId) throw new Error('fixture live target is unavailable')
  expect(store.stageLiveInterjection(target, {
    chatId: job.chatId,
    threadTs: job.threadTs,
    messageId: '1.1',
    userId: 'U2',
    task: disposition === 'answer-only' ? '今どこですか？' : '追加条件を反映してください',
  })).toBe('staged')
  const interjection = store.listJobInterjections(job.id)[0]!
  const logicalNonce = 'a'.repeat(32)
  const threadId = 'thread-1'
  const originalTurnId = 'turn-original'
  store.bindAppServerTurn(
    job.id, job.workerId, job.controlEpoch, logicalNonce, threadId, originalTurnId,
  )
  store.beginInterjectionPause({
    interjectionId: interjection.id,
    jobId: job.id,
    epoch: job.controlEpoch,
    executorNonce: logicalNonce,
    threadId,
    turnId: originalTurnId,
    requestId: 10,
  })
  store.acknowledgeInterjectionPause(interjection.id, 10, originalTurnId)
  store.finishAppServerTurn({
    jobId: job.id,
    epoch: job.controlEpoch,
    executorNonce: logicalNonce,
    threadId,
    turnId: originalTurnId,
    retainInput: true,
  })
  expect(store.prepareInterjectionAnswer({
    interjectionId: interjection.id,
    jobId: job.id,
    epoch: job.controlEpoch,
    logicalNonce,
    threadId,
  })).toBe(`${interjection.id}:answer`)
  expect(store.beginInterjectionAnswer({
    interjectionId: interjection.id,
    jobId: job.id,
    epoch: job.controlEpoch,
    logicalNonce,
    threadId,
    requestId: 11,
  })).toBe('dispatching')
  store.acknowledgeInterjectionAnswer({
    interjectionId: interjection.id,
    jobId: job.id,
    workerId: job.workerId,
    epoch: job.controlEpoch,
    logicalNonce,
    threadId,
    turnId: 'turn-answer',
    requestId: 11,
  })
  expect(store.stageInterjectionAnswer({
    interjectionId: interjection.id,
    jobId: job.id,
    epoch: job.controlEpoch,
    logicalNonce,
    threadId,
    turnId: 'turn-answer',
    disposition,
    answer: disposition === 'answer-only' ? '確認中です 🔎' : '反映して続けます 🛠️',
  })).toBe('staged')
  return store.listJobInterjections(job.id)[0]!
}

function stageRecoverableInterjection(
  store: JobStore,
  job: NonNullable<ReturnType<JobStore['claimNext']>>,
  targetState: 'answer-prepared' | 'answering' | 'answered' | 'delivered',
) {
  const target = store.liveControlTarget(job.chatId, job.threadTs)
  if (!target || !job.workerId) throw new Error('fixture live target is unavailable')
  expect(store.stageLiveInterjection(target, {
    chatId: job.chatId,
    threadTs: job.threadTs,
    messageId: '1.9',
    userId: 'U9',
    task: 'この追加条件も反映してください',
  })).toBe('staged')
  const interjection = store.listJobInterjections(job.id)[0]!
  const logicalNonce = 'b'.repeat(32)
  const threadId = 'thread-recovery'
  const originalTurnId = 'turn-recovery-original'
  store.bindAppServerTurn(
    job.id, job.workerId, job.controlEpoch, logicalNonce, threadId, originalTurnId,
  )
  store.beginInterjectionPause({
    interjectionId: interjection.id,
    jobId: job.id,
    epoch: job.controlEpoch,
    executorNonce: logicalNonce,
    threadId,
    turnId: originalTurnId,
    requestId: 90,
  })
  store.acknowledgeInterjectionPause(interjection.id, 90, originalTurnId)
  store.finishAppServerTurn({
    jobId: job.id,
    epoch: job.controlEpoch,
    executorNonce: logicalNonce,
    threadId,
    turnId: originalTurnId,
    retainInput: true,
  })
  expect(store.prepareInterjectionAnswer({
    interjectionId: interjection.id,
    jobId: job.id,
    epoch: job.controlEpoch,
    logicalNonce,
    threadId,
  })).toBe(`${interjection.id}:answer`)
  if (targetState === 'answer-prepared') return interjection

  expect(store.beginInterjectionAnswer({
    interjectionId: interjection.id,
    jobId: job.id,
    epoch: job.controlEpoch,
    logicalNonce,
    threadId,
    requestId: 91,
  })).toBe('dispatching')
  if (targetState === 'answering') return interjection

  const answerTurnId = 'turn-recovery-answer'
  store.acknowledgeInterjectionAnswer({
    interjectionId: interjection.id,
    jobId: job.id,
    workerId: job.workerId,
    epoch: job.controlEpoch,
    logicalNonce,
    threadId,
    turnId: answerTurnId,
    requestId: 91,
  })
  expect(store.stageInterjectionAnswer({
    interjectionId: interjection.id,
    jobId: job.id,
    epoch: job.controlEpoch,
    logicalNonce,
    threadId,
    turnId: answerTurnId,
    disposition: 'task-update',
    answer: '追加条件を反映して続けます 🛠️',
  })).toBe('staged')
  if (targetState === 'answered') return interjection

  const notification = store.pendingInterjectionNotifications()[0]
  if (!notification) throw new Error('fixture interjection notification is unavailable')
  store.markInterjectionNotificationDelivered(notification.id)
  return interjection
}

describe('durable lifecycle notifications', () => {
  test('通常受付は本文を送らず、先行jobがある場合だけ待機通知を一度stageする', () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-queue-wait-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(root, 'state', 'jobs.sqlite3'))
    const first = store.enqueue({
      chatId: 'D1', threadTs: 'queue-first', messageId: 'queue-first', userId: 'U1',
      repoPath: repo, task: 'first', writeEnabled: false, notifyAccepted: true,
    })
    expect(first.queuePosition).toBe(1)
    expect(store.pendingStatusNotifications()).toEqual([])

    const secondInput = {
      chatId: 'D2', threadTs: 'queue-second', messageId: 'queue-second', userId: 'U2',
      repoPath: repo, task: 'second', writeEnabled: false, notifyAccepted: true,
    }
    const second = store.enqueue(secondInput)
    expect(second.queuePosition).toBe(2)
    expect(store.pendingStatusNotifications()).toHaveLength(1)
    expect(store.pendingStatusNotifications()[0]).toMatchObject({
      jobId: second.job.id,
      kind: 'accepted',
      payload: SLACK_QUEUE_WAIT_MESSAGE,
    })
    expect(store.enqueue(secondInput).duplicate).toBe(true)
    expect(store.pendingStatusNotifications()).toHaveLength(1)
    store.close()
  })

  test('job別status送信は完了まで追跡し、無関係なjobの待機を巻き込まない', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-status-side-effect-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(root, 'state', 'jobs.sqlite3'))
    const first = store.enqueue({
      chatId: 'D1', threadTs: 'status-first', messageId: 'status-first', userId: 'U1',
      repoPath: repo, task: 'first', writeEnabled: false,
    }).job
    const second = store.enqueue({
      chatId: 'D2', threadTs: 'status-second', messageId: 'status-second', userId: 'U2',
      repoPath: repo, task: 'second', writeEnabled: false, notifyAccepted: true,
    }).job
    const notification = store.pendingStatusNotifications()[0]!
    let announceStarted!: () => void
    const started = new Promise<void>(resolve => { announceStarted = resolve })
    let releasePost!: () => void
    const released = new Promise<void>(resolve => { releasePost = resolve })
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      postMessage: async () => {
        announceStarted()
        await released
      },
    })
    const posting = notifier.status(notification)
    await started
    await notifier.settleStatusSideEffects(first.id)
    let secondSettled = false
    const settlingSecond = notifier.settleStatusSideEffects(second.id)
      .then(() => { secondSettled = true })
    await Bun.sleep(10)
    expect(secondSettled).toBe(false)
    releasePost()
    await Promise.all([posting, settlingSecond])
    expect(secondSettled).toBe(true)
    store.close()
  })

  test('送信中の待機通知を追い越して対象jobをclaimしない', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-queue-wait-order-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(root, 'state', 'jobs.sqlite3'))
    const first = store.enqueue({
      chatId: 'D1', threadTs: 'order-first', messageId: 'order-first', userId: 'U1',
      repoPath: repo, task: 'first', writeEnabled: false,
    }).job
    const second = store.enqueue({
      chatId: 'D2', threadTs: 'order-second', messageId: 'order-second', userId: 'U2',
      repoPath: repo, task: 'second', writeEnabled: false, notifyAccepted: true,
    }).job
    let announceWaitPost!: () => void
    const waitPostStarted = new Promise<void>(resolve => { announceWaitPost = resolve })
    let releaseWaitPost!: () => void
    const waitPostReleased = new Promise<void>(resolve => { releaseWaitPost = resolve })
    const order: string[] = []
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      postMessage: async input => {
        if (input.text === SLACK_QUEUE_WAIT_MESSAGE) {
          order.push('queue-wait-started')
          announceWaitPost()
          await waitPostReleased
          order.push('queue-wait-finished')
        }
      },
      addReaction: async () => {},
    })
    const running = runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      stopWhenIdle: true,
      pollMs: 1,
      notificationRetryMs: 5,
      notifier,
      executor: async job => {
        order.push(`executed:${job.id}`)
        return { sessionId: `session-${job.id}`, result: 'done' }
      },
    })
    await waitPostStarted
    for (let attempt = 0; attempt < 100 && !order.includes(`executed:${first.id}`); attempt += 1) {
      await Bun.sleep(2)
    }
    expect(order).toContain(`executed:${first.id}`)
    await Bun.sleep(20)
    expect(order).not.toContain(`executed:${second.id}`)
    releaseWaitPost()
    await running
    expect(order.indexOf('queue-wait-finished'))
      .toBeLessThan(order.indexOf(`executed:${second.id}`))
    store.close()
  })

  test('旧releaseの未配信受付本文を起動migrationで無効化する', () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-legacy-acceptance-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const dbPath = join(root, 'state', 'jobs.sqlite3')
    let store = new JobStore(dbPath)
    const job = store.enqueue({
      chatId: 'D1', threadTs: 'legacy', messageId: 'legacy', userId: 'U1',
      repoPath: repo, task: 'legacy', writeEnabled: false,
    }).job
    store.close()

    const db = new Database(dbPath)
    db.run("DELETE FROM migration_ledger WHERE name = 'queue-wait-notifications-v1'")
    db.run(
      `INSERT INTO status_notifications (
         id, idempotency_key, job_id, chat_id, thread_ts, kind, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)`,
      ['legacy-acceptance', 'accepted:legacy', job.id, 'D1', 'legacy',
        '🙌 受け付けました（待ち順 1）。', 1_000],
    )
    db.close()

    store = new JobStore(dbPath)
    expect(store.migrationApplied('queue-wait-notifications-v1')).toBe(true)
    expect(store.pendingStatusNotifications()).toEqual([])
    store.close()
  })

  test('旧releaseの未配信固定非公開progressを起動migrationで無効化する', () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-legacy-progress-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const dbPath = join(root, 'state', 'jobs.sqlite3')
    let store = new JobStore(dbPath)
    const job = store.enqueue({
      chatId: 'D1', threadTs: 'legacy-progress', messageId: 'legacy-progress', userId: 'U1',
      repoPath: repo, task: 'legacy progress', writeEnabled: false,
    }).job
    const running = store.claimNext('legacy-progress-worker')!
    expect(running.id).toBe(job.id)
    expect(store.stageCommentaryNotification(
      running.id,
      running.attempts,
      '9'.repeat(64),
      '💬 内部構成は公開していません。',
      1_000,
    )).toBe('staged')
    store.close()

    const db = new Database(dbPath)
    db.run(
      "DELETE FROM migration_ledger WHERE name = 'progress-nondisclosure-tombstones-v1'",
    )
    db.close()

    store = new JobStore(dbPath)
    expect(store.migrationApplied('progress-nondisclosure-tombstones-v1')).toBe(true)
    expect(store.pendingCommentaryNotifications()).toEqual([])
    expect(store.commentaryNotificationCount()).toBe(0)
    store.fail(job.id, 'fixture complete')
    store.close()
  })

  test('旧releaseの未配信routine commentaryを節目通知への移行時に無効化する', () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-legacy-commentary-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const dbPath = join(root, 'state', 'jobs.sqlite3')
    let store = new JobStore(dbPath)
    const job = store.enqueue({
      chatId: 'D1', threadTs: 'legacy-commentary', messageId: 'legacy-commentary',
      userId: 'U1', repoPath: repo, task: 'legacy commentary', writeEnabled: false,
    }).job
    const running = store.claimNext('legacy-commentary-worker')!
    expect(store.stageCommentaryNotification(
      running.id, running.attempts, '8'.repeat(64), '💬 ファイルを確認しています。', 1_000,
    )).toBe('staged')
    store.close()

    const db = new Database(dbPath)
    db.run("DELETE FROM migration_ledger WHERE name = 'commentary-milestone-cutover-v1'")
    db.close()

    store = new JobStore(dbPath)
    expect(store.migrationApplied('commentary-milestone-cutover-v1')).toBe(true)
    expect(store.pendingCommentaryNotifications()).toEqual([])
    expect(store.commentaryNotificationCount()).toBe(0)
    store.fail(job.id, 'fixture complete')
    store.close()
  })

  test('開始lifecycleは内部で完了するがSlack本文を投稿しない', async () => {
    const { store, job } = runningJob()
    const posted: string[] = []
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      postMessage: async input => { posted.push(input.text) },
    })
    await notifier.started(job, 'started-no-body')
    expect(posted).toEqual([])
    store.close()
  })

  test('interjection回答は同じIDで再送しSlack配送後だけtask-updateへ昇格する', async () => {
    const { store, job } = runningJob()
    const interjection = stageAnsweredInterjection(store, job, 'task-update')
    expect(store.get(job.id)?.inputRevision).toBe(1)
    expect(store.listJobControls(job.id)).toHaveLength(0)
    const notificationId = store.pendingInterjectionNotifications()[0]!.id
    const attempts: string[] = []
    let first = true
    const notifier = {
      status: async (notification: { id: string }) => {
        attempts.push(notification.id)
        if (first) {
          first = false
          throw new Error('temporary Slack failure')
        }
      },
    }
    await flushInterjectionNotifications(store, notifier, () => {}, 1)
    expect(store.get(job.id)?.inputRevision).toBe(1)
    expect(store.listJobControls(job.id)).toHaveLength(0)
    expect(store.listJobInterjections(job.id)[0]?.status).toBe('answered')
    await Bun.sleep(2)
    await flushInterjectionNotifications(store, notifier, () => {}, 1)
    expect(attempts).toEqual([notificationId, notificationId])
    expect(store.listJobInterjections(job.id)[0]?.status).toBe('delivered')
    expect(store.get(job.id)?.inputRevision).toBe(1)
    expect(store.promoteDeliveredInterjection(interjection.id)).toBe('task-update')
    expect(store.get(job.id)?.inputRevision).toBe(2)
    expect(store.listJobControls(job.id)).toHaveLength(1)
    expect(store.listJobControls(job.id)[0]).toMatchObject({
      status: 'observed',
      inputRevision: 2,
      task: '追加条件を反映してください',
    })
    store.close()
  })

  test('失敗したjobの未配送interjection回答は投稿せずsupersedeする', () => {
    const { store, job } = runningJob()
    stageAnsweredInterjection(store, job, 'task-update')
    expect(store.pendingInterjectionNotifications()).toHaveLength(1)
    store.fail(job.id, 'fixture failure')
    expect(store.pendingInterjectionNotifications()).toEqual([])
    expect(store.listJobInterjections(job.id)[0]).toMatchObject({
      status: 'superseded',
      disposition: 'task-update',
    })
    expect(store.pendingTerminalNotifications()).toHaveLength(1)
    store.close()
  })

  test('daemon再起動後も生成済みanswer-only回答を同じIDで届けてからfailureを通知する', async () => {
    const { root, store, job } = runningJob()
    stageAnsweredInterjection(store, job, 'answer-only')
    const notificationId = store.pendingInterjectionNotifications()[0]!.id
    store.close()

    const restarted = new JobStore(join(root, 'state', 'jobs.sqlite3'))
    expect(restarted.reconcileInterjectionsBeforeRecovery()).toEqual({
      preparedReset: 0,
      promoted: 0,
      blocked: 0,
    })
    expect(restarted.recoverInterrupted()).toEqual({
      requeued: 0,
      failedWrites: 1,
      failedUncertain: 0,
    })
    expect(restarted.get(job.id)?.status).toBe('failed')
    expect(restarted.pendingInterjectionNotifications().map(row => row.id))
      .toEqual([notificationId])
    expect(restarted.pendingTerminalNotifications()).toEqual([])

    const attempts: string[] = []
    let first = true
    const notifier = {
      status: async (notification: { id: string }) => {
        attempts.push(notification.id)
        if (first) {
          first = false
          throw new Error('temporary Slack failure')
        }
      },
    }
    await flushInterjectionNotifications(restarted, notifier, () => {}, 1)
    expect(restarted.listJobInterjections(job.id)[0]?.status).toBe('answered')
    expect(restarted.pendingTerminalNotifications()).toEqual([])
    await Bun.sleep(2)
    await flushInterjectionNotifications(restarted, notifier, () => {}, 1)

    expect(attempts).toEqual([notificationId, notificationId])
    expect(restarted.listJobInterjections(job.id)[0]).toMatchObject({
      status: 'promoted',
      disposition: 'answer-only',
    })
    expect(restarted.pendingTerminalNotifications()).toHaveLength(1)
    restarted.close()
  })

  test('exact中止は生成済みだが未配送のinterjection回答を同じtransactionでsupersedeする', () => {
    const { store, job } = runningJob()
    stageAnsweredInterjection(store, job, 'answer-only')
    const notificationId = store.pendingInterjectionNotifications()[0]!.id
    const target = store.liveControlTarget(job.chatId, job.threadTs)
    if (!target) throw new Error('fixture live target is unavailable')

    expect(store.stageLiveControl(target, {
      chatId: job.chatId,
      threadTs: job.threadTs,
      messageId: '1.2',
      userId: 'U3',
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')

    expect(store.get(job.id)?.cancelRequestedAt).not.toBeNull()
    expect(store.interjectionNotificationDeliverable(notificationId)).toBe(false)
    expect(store.pendingInterjectionNotifications()).toEqual([])
    expect(store.listJobInterjections(job.id)[0]?.status).toBe('superseded')
    store.close()
  })

  test('同じthreadの2件目は1件目のSlack配送とpromoteが終わるまで回答を開始しない', () => {
    const { store, job } = runningJob()
    const first = stageAnsweredInterjection(store, job, 'answer-only')
    const target = store.liveControlTarget(job.chatId, job.threadTs)
    if (!target) throw new Error('fixture live target is unavailable')
    expect(store.stageLiveInterjection(target, {
      chatId: job.chatId,
      threadTs: job.threadTs,
      messageId: '1.2',
      userId: 'U3',
      task: '続けて、あと何分ぐらいですか？',
    })).toBe('staged')

    const interjections = store.listJobInterjections(job.id)
    expect(interjections.map(item => item.status)).toEqual(['answered', 'ready'])
    expect(store.nextReadyLiveInput(job.id, job.controlEpoch)).toBeNull()
    expect(store.nextPendingInterjection(job.id, job.controlEpoch)).toBeNull()
    expect(() => store.prepareInterjectionAnswer({
      interjectionId: interjections[1]!.id,
      jobId: job.id,
      epoch: job.controlEpoch,
      logicalNonce: 'a'.repeat(32),
      threadId: 'thread-1',
    })).toThrow('interjection is not ready for an answer')

    const notification = store.pendingInterjectionNotifications()[0]!
    store.deferInterjectionNotification(notification.id, 'temporary Slack failure', 1_000, 1)
    expect(store.pendingInterjectionNotifications(1_000)).toEqual([])
    expect(store.pendingInterjectionNotifications(1_001).map(row => row.id))
      .toEqual([notification.id])
    expect(store.nextPendingInterjection(job.id, job.controlEpoch)).toBeNull()
    store.markInterjectionNotificationDelivered(notification.id)
    expect(store.nextPendingInterjection(job.id, job.controlEpoch)).toBeNull()
    expect(store.pendingInterjectionNotifications()).toEqual([])
    expect(store.promoteDeliveredInterjection(first.id)).toBe('answer-only')
    expect(store.nextPendingInterjection(job.id, job.controlEpoch)?.messageId).toBe('1.2')
    store.close()
  })

  for (const scenario of [
    { state: 'answer-prepared', reset: 1, promoted: 0, final: 'superseded', revision: 1 },
    { state: 'answering', reset: 0, promoted: 0, final: 'ambiguous', revision: 1 },
    { state: 'answered', reset: 0, promoted: 0, final: 'superseded', revision: 1 },
    { state: 'delivered', reset: 0, promoted: 1, final: 'promoted', revision: 2 },
  ] as const) {
    test(`daemon再起動時の${scenario.state} interjectionを重複実行せず安全に閉じる`, () => {
      const { store, job } = runningJob()
      stageRecoverableInterjection(store, job, scenario.state)
      expect(store.listJobInterjections(job.id)[0]?.status).toBe(scenario.state)

      expect(store.reconcileInterjectionsBeforeRecovery()).toEqual({
        preparedReset: scenario.reset,
        promoted: scenario.promoted,
        blocked: 0,
      })
      expect(store.recoverInterrupted()).toEqual({
        requeued: 0,
        failedWrites: 1,
        failedUncertain: 0,
      })
      expect(store.get(job.id)).toMatchObject({
        status: 'failed',
        inputRevision: scenario.revision,
      })
      expect(store.listJobInterjections(job.id)[0]?.status).toBe(scenario.final)
      expect(store.pendingInterjectionNotifications()).toEqual([])
      expect(store.pendingTerminalNotifications()).toHaveLength(1)
      if (scenario.state === 'delivered') {
        expect(store.listJobControls(job.id)).toHaveLength(1)
      } else {
        expect(store.listJobControls(job.id)).toHaveLength(0)
      }
      store.close()
    })
  }

  test('commentaryをFIFOでdurable配送しterminalを追い越さない', async () => {
    const { store, job } = runningJob()
    store.activateJobLifecycle(job.id, job.attempts, 1_000)
    expect(store.stageCommentaryNotification(
      job.id, job.attempts, 'a'.repeat(64), '💬 原因を確認しています 🔎', 1_100,
    )).toBe('staged')
    expect(store.stageCommentaryNotification(
      job.id, job.attempts, 'e'.repeat(64), '💬 原因を確認しています 🔎', 1_150,
    )).toBe('duplicate')
    expect(store.stageCommentaryNotification(
      job.id, job.attempts, 'b'.repeat(64), '💬 修正内容を検証しています 🧪', 1_200,
    )).toBe('staged')
    // The suppressed source identity must remain durable. Replaying it after
    // an intervening message must not resurrect the older public body.
    expect(store.stageCommentaryNotification(
      job.id, job.attempts, 'e'.repeat(64), '💬 原因を確認しています 🔎', 1_250,
    )).toBe('duplicate')
    expect(store.stageCommentaryNotification(
      job.id, job.attempts, 'a'.repeat(64), '💬 原因を確認しています 🔎', 1_300,
    )).toBe('duplicate')
    expect(() => store.stageCommentaryNotification(
      job.id, job.attempts, 'a'.repeat(64), '💬 別の内容', 1_400,
    )).toThrow('source identity changed')

    // 開始通知を追い越さず、先頭commentaryだけが配送候補になる。
    expect(store.pendingCommentaryNotifications(2_000)).toEqual([])
    const started = store.pendingLifecycleNotifications(2_000)[0]!
    store.markLifecycleNotificationDelivered(started.id)
    const firstId = store.pendingCommentaryNotifications(2_000)[0]?.id
    expect(firstId).toBeTruthy()
    completeWriteFixture(store, job, 'commentary-session', 'done')
    expect(store.pendingTerminalNotifications(2_000)).toEqual([])

    const delivered: Array<{ id: string; text: string }> = []
    let attempts = 0
    const notifier = {
      progress: async (_job: unknown, text: string, id?: string) => {
        delivered.push({ id: id ?? '', text })
        attempts += 1
        if (attempts === 1) throw new Error('temporary commentary failure')
      },
    }
    await flushCommentaryNotifications(store, notifier, () => {}, 1)
    expect(store.commentaryNotificationCount()).toBe(2)
    expect(store.pendingTerminalNotifications()).toEqual([])
    await Bun.sleep(2)
    await flushCommentaryNotifications(store, notifier, () => {}, 1)
    expect(delivered.map(item => item.text)).toEqual([
      '💬 原因を確認しています 🔎',
      '💬 原因を確認しています 🔎',
      '💬 修正内容を検証しています 🧪',
    ])
    expect(delivered[0]?.id).toBe(firstId)
    expect(delivered[1]?.id).toBe(firstId)
    expect(store.commentaryNotificationCount()).toBe(0)
    expect(store.pendingTerminalNotifications()).toHaveLength(1)
    store.close()
  })

  test('節目commentaryはjob・入力revision・kindごとに再試行と文面を跨いで一度だけ送る', () => {
    const { store, job } = runningJob()
    expect(store.stageMilestoneCommentaryNotification(
      job.id, job.attempts, 1, 'PLAN', '💬 原因と方針を確定しました。', 1_000,
    )).toBe('staged')
    expect(store.stageMilestoneCommentaryNotification(
      job.id, job.attempts, 1, 'PLAN', '💬 同じ方針を別表現で再掲します。', 1_100,
    )).toBe('duplicate')
    expect(store.stageMilestoneCommentaryNotification(
      job.id, job.attempts, 1, 'VERIFY', '💬 実装が終わり、検証へ進みます。', 1_200,
    )).toBe('staged')
    expect(store.stageMilestoneCommentaryNotification(
      job.id, job.attempts, 2, 'PLAN', '💬 追加依頼の方針を確定しました。', 1_300,
    )).toBe('staged')
    expect(store.commentaryNotificationCount()).toBe(3)
    store.fail(job.id, 'fixture complete')
    store.close()
  })

  test('一度のflushでburst commentaryをFIFOのまま全件drainする', async () => {
    const { store, job } = runningJob()
    store.activateJobLifecycle(job.id, job.attempts, 1_000)
    store.markLifecycleNotificationDelivered(
      store.pendingLifecycleNotifications(1_000)[0]!.id,
    )
    const expected = Array.from({ length: 5 }, (_value, index) => (
      `💬 状況 ${index + 1} を確認しています`
    ))
    for (const [index, text] of expected.entries()) {
      expect(store.stageCommentaryNotification(
        job.id,
        job.attempts,
        String(index + 1).repeat(64),
        text,
        1_100 + index,
      )).toBe('staged')
    }
    const delivered: string[] = []
    await flushCommentaryNotifications(store, {
      progress: async (_job, text) => { delivered.push(text) },
    }, () => {})
    expect(delivered).toEqual(expected)
    expect(store.commentaryNotificationCount()).toBe(0)
    store.close()
  })

  test('大量commentaryは優先通知へ制御を返して次passでFIFOを継続する', async () => {
    const { store, job } = runningJob()
    store.activateJobLifecycle(job.id, job.attempts, 1_000)
    store.markLifecycleNotificationDelivered(
      store.pendingLifecycleNotifications(1_000)[0]!.id,
    )
    const expected = Array.from({ length: 60 }, (_value, index) => (
      `💬 大量状況 ${index + 1}`
    ))
    for (const [index, text] of expected.entries()) {
      expect(store.stageCommentaryNotification(
        job.id,
        job.attempts,
        (index + 1).toString(16).padStart(64, '0'),
        text,
        1_100 + index,
      )).toBe('staged')
    }
    const delivered: string[] = []
    const notifier = {
      progress: async (_job: unknown, text: string) => { delivered.push(text) },
    }
    expect(await flushCommentaryNotifications(store, notifier, () => {})).toBe(true)
    expect(delivered).toHaveLength(50)
    expect(store.commentaryNotificationCount()).toBe(10)
    expect(await flushCommentaryNotifications(store, notifier, () => {})).toBe(false)
    expect(delivered).toEqual(expected)
    expect(store.commentaryNotificationCount()).toBe(0)
    store.close()
  })

  test('runnerは投影されたcommentaryを完了報告より前にすべて送る', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-commentary-runner-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(root, 'state', 'jobs.sqlite3'))
    store.enqueue({
      chatId: 'D1', threadTs: '1.5', messageId: '1.5', userId: 'U1',
      repoPath: repo, task: 'commentary task', writeEnabled: false,
    })
    const events: string[] = []
    const stats = await runQueuedJobs({
      store,
      stopWhenIdle: true,
      pollMs: 5,
      notificationRetryMs: 5,
      notifier: {
        started: async () => { events.push('started') },
        progress: async (_job, text) => { events.push(text) },
        completed: async () => { events.push('completed') },
      },
      executor: async (_job, _signal, context) => {
        expect(context?.reportCommentary({
          sourceKey: 'c'.repeat(64), text: '💬 一つ目の状況です 🔎',
        })).toBe(true)
        expect(context?.reportCommentary({
          sourceKey: 'd'.repeat(64), text: '💬 二つ目の状況です 🧪',
        })).toBe(true)
        return { sessionId: 'commentary-runner-session', result: 'done' }
      },
    })
    expect(stats.completed).toBe(1)
    expect(events).toEqual([
      'started',
      '💬 一つ目の状況です 🔎',
      '💬 二つ目の状況です 🧪',
      'completed',
    ])
    expect(store.commentaryNotificationCount()).toBe(0)
    expect(store.terminalNotificationCount()).toBe(0)
    store.close()
  })

  test('runnerは自己構成依頼の固定非公開文を捨て、有意なcommentaryだけを一度送る', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-commentary-sanitize-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(root, 'state', 'jobs.sqlite3'))
    store.enqueue({
      chatId: 'D1', threadTs: '1.6', messageId: '1.6', userId: 'U1',
      repoPath: repo,
      task: '当システムの内部構成による遅延原因を調べてください。',
      writeEnabled: false,
    })
    const events: string[] = []
    const stats = await runQueuedJobs({
      store,
      stopWhenIdle: true,
      pollMs: 5,
      notificationRetryMs: 5,
      notifier: {
        started: async () => { events.push('started') },
        progress: async (_job, text) => { events.push(text) },
        completed: async () => { events.push('completed') },
      },
      executor: async (_job, _signal, context) => {
        expect(context?.reportCommentary({
          sourceKey: '1'.repeat(64), text: '💬 内部構成は公開していません。',
        })).toBe(true)
        expect(context?.reportCommentary({
          sourceKey: '2'.repeat(64), text: '💬 遅延条件を再現して計測しています 🔎',
        })).toBe(true)
        expect(context?.reportCommentary({
          sourceKey: '3'.repeat(64), text: '💬 遅延条件を再現して計測しています 🔎',
        })).toBe(true)
        return { sessionId: 'commentary-sanitize-session', result: '調査しました' }
      },
    })
    expect(stats.completed).toBe(1)
    expect(events).toEqual([
      'started',
      '💬 遅延条件を再現して計測しています 🔎',
      'completed',
    ])
    expect(store.commentaryNotificationCount()).toBe(0)
    store.close()
  })

  test('stages start, supersedes stale start/progress, and closes on terminal', () => {
    const { store, job } = runningJob()
    const activatedAt = store.activateJobLifecycle(job.id, job.attempts, 1_000)
    expect(activatedAt).toBe(1_000)
    expect(store.pendingLifecycleNotifications(1_000).map(row => row.kind)).toEqual(['started'])
    expect(store.stageProgressProbe(job.id, job.attempts, 0, 'a'.repeat(64), 1_500))
      .toBe('staged')
    expect(store.stageProgressNotification(job.id, job.attempts, 0, '最初の進捗', 2_000))
      .toBe('staged')
    expect(store.stageProgressProbe(job.id, job.attempts, 1, 'b'.repeat(64), 2_500))
      .toBe('staged')
    expect(store.stageProgressNotification(job.id, job.attempts, 1, '新しい進捗', 3_000))
      .toBe('staged')
    const pending = store.pendingLifecycleNotifications(3_000)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.kind).toBe('progress')
    expect(pending[0]?.slot).toBe(1)
    expect(store.stageProgressNotification(job.id, job.attempts, 1, '重複', 3_001))
      .toBe('duplicate')
    expect(store.get(job.id)?.status).toBe('running')
    store.fail(job.id, 'fixture failure')
    expect(store.pendingLifecycleNotifications(10_000)).toEqual([])
    expect(store.lifecycleNotificationCount()).toBe(0)
  })

  test('retries with the same durable notification id', async () => {
    const { store, job } = runningJob()
    store.activateJobLifecycle(job.id, job.attempts, 1_000)
    const ids: string[] = []
    let calls = 0
    await flushLifecycleNotifications(store, {
      started: async (_job, id) => {
        ids.push(id ?? '')
        calls += 1
        if (calls === 1) throw new Error('temporary')
      },
    }, () => {}, 1)
    await Bun.sleep(2)
    await flushLifecycleNotifications(store, {
      started: async (_job, id) => { ids.push(id ?? '') },
    }, () => {}, 1)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(store.lifecycleNotificationCount()).toBe(0)
    expect(store.terminalNotificationCount()).toBe(0)
  })

  test('retries a failed start notification while the executor is still running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-lifecycle-pump-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(root, 'state', 'jobs.sqlite3'))
    store.enqueue({
      chatId: 'D1', threadTs: '2.0', messageId: '2.0', userId: 'U1',
      repoPath: repo, task: 'long task', writeEnabled: false,
    })
    const ids: string[] = []
    let calls = 0
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      stopWhenIdle: true,
      pollMs: 5,
      notificationRetryMs: 25,
      notifier: {
        started: async (_job, id) => {
          ids.push(id ?? '')
          calls += 1
          if (calls === 1) throw new Error('temporary start failure')
        },
        completed: async () => {},
      },
      executor: async () => {
        await Bun.sleep(120)
        return { sessionId: 'session-pump', result: 'done' }
      },
    })
    expect(stats.completed).toBe(1)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(store.lifecycleNotificationCount()).toBe(0)
    store.close()
  })

  test('retries an older terminal notification while the next executor is still running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-terminal-pump-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(root, 'state', 'jobs.sqlite3'))
    const first = store.enqueue({
      chatId: 'D1', threadTs: '3.0', messageId: '3.0', userId: 'U1',
      repoPath: repo, task: 'first task', writeEnabled: false,
    }).job
    const firstRunning = store.claimNext('fixture-worker')!
    store.complete(firstRunning.id, 'session-first', '最初のタスク完了')
    store.enqueue({
      chatId: 'D1', threadTs: '4.0', messageId: '4.0', userId: 'U1',
      repoPath: repo, task: 'long second task', writeEnabled: false,
    })
    const firstAttemptTimes: number[] = []
    let executorFinishedAt = Number.POSITIVE_INFINITY
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      stopWhenIdle: true,
      pollMs: 5,
      notificationRetryMs: 25,
      notifier: {
        started: async () => {},
        completed: async job => {
          if (job.id !== first.id) return
          firstAttemptTimes.push(Date.now())
          if (firstAttemptTimes.length === 1) throw new Error('temporary terminal failure')
        },
      },
      executor: async () => {
        await Bun.sleep(150)
        executorFinishedAt = Date.now()
        return { sessionId: 'session-second', result: '二つ目も完了' }
      },
    })
    expect(stats.completed).toBe(1)
    expect(firstAttemptTimes).toHaveLength(2)
    expect(firstAttemptTimes[1]!).toBeLessThan(executorFinishedAt)
    expect(store.terminalNotificationCount()).toBe(0)
    store.close()
  })

  test('drains an in-flight progress post before an interrupted job becomes queued again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-lifecycle-quiesce-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(root, 'state', 'jobs.sqlite3'))
    const queued = store.enqueue({
      chatId: 'D1', threadTs: '5.0', messageId: '5.0', userId: 'U1',
      repoPath: repo, task: 'interrupt fixture', writeEnabled: false,
    }).job
    let announceProgress!: () => void
    const progressStarted = new Promise<void>(resolve => { announceProgress = resolve })
    let releaseProgress!: () => void
    const progressReleased = new Promise<void>(resolve => { releaseProgress = resolve })
    let runnerSettled = false
    const running = runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      stopWhenIdle: true,
      pollMs: 5,
      notificationRetryMs: 25,
      notifier: {
        started: async () => {},
        progress: async () => {
          announceProgress()
          await progressReleased
        },
      },
      executor: async (_job, _signal, context) => {
        context.beginProgressProbe({ slot: 0, clientMessageId: 'c'.repeat(64) })
        context.reportProgress({ slot: 0, elapsedMs: 10, text: '処理中です 🔎' })
        throw new CodexInterruptedError('fixture interruption')
      },
    })
    void running.then(() => { runnerSettled = true })
    await progressStarted
    await Bun.sleep(30)
    expect(runnerSettled).toBe(false)
    expect(store.get(queued.id)?.status).toBe('running')
    releaseProgress()
    await running
    expect(store.get(queued.id)?.status).toBe('queued')
    expect(store.lifecycleNotificationCount()).toBe(0)
    expect(store.terminalNotificationCount()).toBe(0)
    store.close()
  })

  test('a delivered start is not duplicated when an unstarted claim is released', () => {
    const { store, job } = runningJob()
    expect(store.activateJobLifecycle(job.id, job.attempts, 1_000)).toBe(1_000)
    const started = store.pendingLifecycleNotifications(1_000)[0]!
    store.markLifecycleNotificationDelivered(started.id)
    expect(store.releaseUnstartedClaim(job.id, 'worker-1', 'fixture release')).toBe(true)
    const reclaimed = store.claimNext('worker-2')!
    expect(reclaimed.attempts).toBe(job.attempts)
    expect(store.activateJobLifecycle(reclaimed.id, reclaimed.attempts, 2_000)).toBe(1_000)
    const pending = store.pendingLifecycleNotifications(2_000)
    expect(pending).toHaveLength(0)
    store.close()
  })

  test('durably retries acceptance and rate-limit status with stable ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-status-outbox-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const dbPath = join(root, 'state', 'jobs.sqlite3')
    let store = new JobStore(dbPath)
    store.enqueue({
      chatId: 'D0', threadTs: '5.0', messageId: '5.0', userId: 'U0',
      repoPath: repo, task: 'blocker', writeEnabled: false,
    })
    const blocker = store.claimNext('blocker-worker')!
    const queued = store.enqueue({
      chatId: 'D1', threadTs: '6.0', messageId: '6.0', userId: 'U1',
      repoPath: repo, task: 'status fixture', writeEnabled: false, notifyAccepted: true,
    }).job
    const firstId = store.pendingStatusNotifications()[0]?.id
    expect(firstId).toBeTruthy()
    store.close()
    store = new JobStore(dbPath)
    expect(store.pendingStatusNotifications()[0]?.id).toBe(firstId)
    const clientMessageIds: string[] = []
    let attempts = 0
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      postMessage: async input => {
        clientMessageIds.push(input.clientMessageId ?? '')
        attempts += 1
        if (attempts === 1) throw new Error('temporary status failure')
      },
    })
    await flushStatusNotifications(store, notifier, () => {}, 1)
    await Bun.sleep(2)
    await flushStatusNotifications(store, notifier, () => {}, 1)
    expect(clientMessageIds).toHaveLength(2)
    expect(clientMessageIds[0]).toBeTruthy()
    expect(clientMessageIds[1]).toBe(clientMessageIds[0])
    store.complete(blocker.id, 'blocker-session', 'done')
    const running = store.claimNext('status-worker')!
    expect(running.id).toBe(queued.id)
    const resumeAt = Date.now() + 60_000
    store.requeueAt(running.id, resumeAt, 'rate limit fixture')
    const rate = store.pendingStatusNotifications().find(row => row.kind === 'rate-limited')
    expect(rate).toMatchObject({ jobId: queued.id, chatId: 'D1', threadTs: '6.0' })
    store.deferStatusNotification(rate!.id, 'temporary Slack failure', Date.now(), 1)
    expect(store.claimNext('resumed-status-worker', 20, resumeAt + 1)?.id).toBe(queued.id)
    const stalePosts: string[] = []
    await flushStatusNotifications(store, {
      status: async notification => { stalePosts.push(notification.payload) },
    }, () => {})
    expect(stalePosts).toEqual([])
    expect(store.statusNotificationCount()).toBe(0)
    store.close()
  })

  test('App Server内部retryのrate limitは同じturnで一度だけdurable通知する', async () => {
    const { store, job } = runningJob()
    const nonce = 'f'.repeat(32)
    store.bindAppServerTurn(
      job.id,
      job.workerId!,
      job.controlEpoch,
      nonce,
      'thread-rate-wait',
      'turn-rate-wait',
    )
    expect(store.stageAppServerRateLimitWaitNotification(
      job.id, job.attempts, 'thread-rate-wait', 'turn-rate-wait', 1_000,
    )).toBe('staged')
    expect(store.stageAppServerRateLimitWaitNotification(
      job.id, job.attempts, 'thread-rate-wait', 'turn-rate-wait', 1_001,
    )).toBe('duplicate')
    const pending = store.pendingStatusNotifications(2_000)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      jobId: job.id,
      kind: 'rate-limited',
      payload: SLACK_RATE_LIMIT_WAIT_MESSAGE,
    })

    const posted: string[] = []
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      postMessage: async input => { posted.push(input.text) },
    })
    await flushStatusNotifications(store, notifier, () => {})
    expect(posted).toEqual([SLACK_RATE_LIMIT_WAIT_MESSAGE])
    expect(store.pendingStatusNotifications()).toEqual([])
    store.close()
  })

  test('turn終了が先なら未送信のrate limit待機通知を破棄する', async () => {
    const { store, job } = runningJob()
    const nonce = 'e'.repeat(32)
    store.bindAppServerTurn(
      job.id,
      job.workerId!,
      job.controlEpoch,
      nonce,
      'thread-rate-finished',
      'turn-rate-finished',
    )
    expect(store.stageAppServerRateLimitWaitNotification(
      job.id, job.attempts, 'thread-rate-finished', 'turn-rate-finished', 1_000,
    )).toBe('staged')
    store.finishAppServerTurn({
      jobId: job.id,
      epoch: job.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-rate-finished',
      turnId: 'turn-rate-finished',
    })
    const posted: string[] = []
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      postMessage: async input => { posted.push(input.text) },
    })
    await flushStatusNotifications(store, notifier, () => {})
    expect(posted).toEqual([])
    expect(store.statusNotificationCount()).toBe(0)
    store.fail(job.id, 'fixture complete')
    store.close()
  })

  test('a same-thread control supersedes unsent progress before Slack delivery', () => {
    const { store, job } = runningJob()
    store.activateJobLifecycle(job.id, job.attempts, 1_000)
    const started = store.pendingLifecycleNotifications(1_000)[0]!
    store.markLifecycleNotificationDelivered(started.id)
    store.stageProgressProbe(job.id, job.attempts, 0, 'f'.repeat(64), 1_500)
    expect(store.stageProgressNotification(
      job.id, job.attempts, 0, '古い進捗', 2_000,
    )).toBe('staged')
    expect(store.stageLiveControl({
      jobId: job.id,
      epoch: job.controlEpoch,
      repoPath: job.repoPath,
      writeEnabled: job.writeEnabled,
    }, {
      chatId: job.chatId,
      threadTs: job.threadTs,
      messageId: '1.1',
      userId: 'U2',
      task: '追加の指示です',
      kind: 'steer',
    })).toBe('staged')
    expect(store.pendingLifecycleNotifications(3_000)).toEqual([])
    store.close()
  })

  test('cancellation after monitor preparation does not start the executor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-cancel-activation-'))
    roots.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(root, 'state', 'jobs.sqlite3'))
    const queued = store.enqueue({
      chatId: 'D1', threadTs: '7.0', messageId: '7.0', userId: 'U1',
      repoPath: repo, task: 'cancel race', writeEnabled: false,
    }).job
    let executorCalls = 0
    let cancellationCleanup = 0
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      stopWhenIdle: true,
      pollMs: 5,
      notificationRetryMs: 5,
      openJobMonitor: async job => {
        expect(store.stageLiveControl({
          jobId: job.id,
          epoch: job.controlEpoch,
          repoPath: job.repoPath,
          writeEnabled: job.writeEnabled,
        }, {
          chatId: job.chatId,
          threadTs: job.threadTs,
          messageId: '7.1',
          userId: 'U2',
          task: '中止',
          kind: 'interrupt',
        })).toBe('staged')
      },
      updateJobMonitor: async () => {},
      quiesceJobMonitor: async () => {},
      cancelExternalContext: async () => { cancellationCleanup += 1 },
      closeJobMonitor: async () => {},
      notifier: { failed: async () => {} },
      executor: async () => {
        executorCalls += 1
        return { sessionId: 'should-not-run', result: 'unexpected' }
      },
    })
    expect(stats).toMatchObject({ completed: 0, failed: 1 })
    expect(executorCalls).toBe(0)
    expect(cancellationCleanup).toBe(1)
    expect(store.get(queued.id)).toMatchObject({ status: 'failed', terminalOutcome: 'cancelled' })
    store.close()
  })

  test('completion body is not reposted when the check reaction needs retry', async () => {
    const { store, job } = runningJob()
    completeWriteFixture(store, job, 'session-1', 'できました。')
    const posts: string[] = []
    let reactionAttempts = 0
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      postMessage: async input => { posts.push(input.text) },
      addReaction: async input => {
        expect(input.name).toBe('white_check_mark')
        reactionAttempts += 1
        if (reactionAttempts === 1) throw new Error('temporary reaction failure')
      },
    })
    await flushTerminalNotifications(store, notifier, () => {}, 1)
    await Bun.sleep(2)
    await flushTerminalNotifications(store, notifier, () => {}, 1)
    expect(posts).toEqual(['できました。'])
    expect(reactionAttempts).toBe(2)
    expect(store.terminalNotificationCount()).toBe(0)
  })

  test('adds the completion reaction after ambiguous artifacts are abandoned', async () => {
    const { root, store, job } = runningJob()
    const state = join(root, 'state')
    const outbox = artifactDirForJob(state, job.id)
    mkdirSync(outbox, { recursive: true })
    const artifact = join(outbox, 'hello.txt')
    writeFileSync(artifact, 'hello\n')
    const result = sealArtifactResult(
      job,
      `できました。\n<zerokun_files>${JSON.stringify([artifact])}</zerokun_files>`,
      state,
    )
    completeWriteFixture(store, job, 'session-artifact', result)
    const posts: string[] = []
    let reactions = 0
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      postMessage: async input => { posts.push(input.text) },
      requestUploadTarget: async () => ({
        uploadUrl: 'https://files.slack.com/upload/v1/fixture',
        fileId: 'F-FIXTURE',
      }),
      uploadBytes: async (_url, _data, beforeTransfer) => {
        beforeTransfer()
        throw new Error('fixture lost response after transfer')
      },
      completeUpload: async () => {},
      inspectUpload: async () => false,
      addReaction: async () => { reactions += 1 },
    })
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await flushTerminalNotifications(store, notifier, () => {}, 1)
      await Bun.sleep(25)
    }
    expect(posts).toHaveLength(2)
    expect(reactions).toBe(1)
    expect(store.terminalNotificationCount()).toBe(0)
    store.close()
  })
})
