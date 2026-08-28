import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  JobStore,
  SlackNotifier,
  flushLifecycleNotifications,
  flushStatusNotifications,
  flushTerminalNotifications,
  runQueuedJobs,
  sealArtifactResult,
} from './job-runner.ts'
import { artifactDirForJob, CodexInterruptedError } from './codex-executor.ts'

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

describe('durable lifecycle notifications', () => {
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
    const running = store.claimNext('status-worker')!
    store.requeueAt(running.id, Date.now() + 60_000, 'rate limit fixture')
    const rate = store.pendingStatusNotifications().find(row => row.kind === 'rate-limited')
    expect(rate).toMatchObject({ jobId: queued.id, chatId: 'D1', threadTs: '6.0' })
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
    store.complete(job.id, 'session-1', 'できました。')
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
    store.complete(
      job.id,
      'session-artifact',
      result,
    )
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
