import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { slackReplyScanFailureDisposition } from '../gate.ts'
import {
  JobStore,
  SERIAL_WORKER_COUNT,
  extractArtifactPaths,
  flushTerminalNotifications,
  finalizeSuccessfulExecution,
  readUploadableArtifact,
  runQueuedJobs,
  sealArtifactResult,
  terminateTrackedExecutors,
  updateIsRunning,
  updateTransactionPending,
  splitSlackChunks,
  type EnqueueInput,
} from './job-runner.ts'
import {
  CODEX_WORKER_SAFETY_PROMPT,
  CodexInterruptedError,
  codexAttemptDisposition,
  CodexRateLimitError,
  artifactDirForJob,
  buildCodexChildEnvironment,
  assertCompatibleSystemCodexConfig,
  buildCodexDeveloperInstructions,
  buildCodexPermissionOverrides,
  buildCodexWorkerPrompt,
  codexThreadIdFromEvent,
  executeCodexJob,
  extractCodexRateLimit,
  parseCodexResult,
  resolveGitMetadataPaths,
} from './codex-executor.ts'
import { capRuntimeLogs, removeSettledJobState } from './state-maintenance.ts'
import { adoptLegacyProcessIdentity } from './process-lock.ts'

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureDir(prefix = 'zerokun-codex-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirs.push(dir)
  return dir
}

function input(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    chatId: 'C0123456789',
    threadTs: '1800000000.000100',
    messageId: '1800000000.000100',
    userId: 'U0123456789',
    repoPath: '/tmp/project',
    task: '調べてください',
    writeEnabled: false,
    ...overrides,
  }
}

function makeStore(): JobStore {
  return new JobStore(join(fixtureDir(), 'jobs.sqlite3'))
}

function git(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

describe('Codex job store', () => {
  test('既存auto_vacuum=NONE DBを停止中migrationでINCREMENTALへ変換する', () => {
    const dir = fixtureDir()
    const dbPath = join(dir, 'legacy.sqlite3')
    const legacy = new Database(dbPath, { create: true })
    legacy.exec('CREATE TABLE legacy (value TEXT)')
    legacy.exec("INSERT INTO legacy VALUES ('preserved')")
    expect(legacy.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum).toBe(0)
    legacy.close()
    const prepared = Bun.spawnSync([
      process.execPath, join(import.meta.dir, 'job-runner.ts'), 'prepare-storage',
    ], {
      env: { ...process.env, ZEROKUN_JOB_DB: dbPath, ZEROKUN_STATE_DIR: dir },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(prepared.exitCode, prepared.stderr.toString()).toBe(0)
    const verified = new Database(dbPath)
    expect(verified.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum).toBe(2)
    expect(verified.query<{ value: string }, []>('SELECT value FROM legacy').get()?.value).toBe('preserved')
    verified.close()
  })

  test('添付取得前のinbound metadataを永続化し、先頭retry中は後続を追い越さない', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    let store = new JobStore(path)
    expect(store.stageInboundDelivery({
      ...input({ messageId: '100.000001' }),
      text: 'slow A',
      fileIds: ['F-A'],
    })).toBe(true)
    expect(store.stageInboundDelivery({
      ...input({ messageId: '100.000002' }),
      text: 'fast B',
    })).toBe(true)
    const first = store.claimNextInboundDelivery(1_000)!
    expect(first.text).toBe('slow A')
    store.deferInboundDelivery(first.idempotencyKey, 'Slack 503', 2_000)
    expect(store.claimNextInboundDelivery(1_999)).toBeNull()
    store.close()

    store = new JobStore(path)
    expect(store.inboundDeliveryCount()).toBe(2)
    const retried = store.claimNextInboundDelivery(2_000)!
    expect(retried.text).toBe('slow A')
    store.completeInboundDelivery(retried.idempotencyKey)
    expect(store.claimNextInboundDelivery(2_000)?.text).toBe('fast B')
    store.close()
  })

  test('gateway再起動時にprocessing inboundをpendingへ戻してFIFOを再開する', () => {
    const store = makeStore()
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'interrupted' }), text: 'interrupted',
    })).toBe(true)
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'after' }), text: 'after',
    })).toBe(true)
    expect(store.claimNextInboundDelivery(1_000)?.text).toBe('interrupted')
    expect(store.claimNextInboundDelivery(1_000)).toBeNull()
    expect(store.recoverInboundDeliveries()).toBe(1)
    const recovered = store.claimNextInboundDelivery(1_001)!
    expect(recovered.text).toBe('interrupted')
    store.completeInboundDelivery(recovered.idempotencyKey)
    expect(store.claimNextInboundDelivery(1_001)?.text).toBe('after')
    store.close()
  })

  test('catch-up planner向けdurable event判定はinboundからjob handoffまで一貫する', () => {
    const store = makeStore()
    const staged = input({ messageId: 'durable-event' })
    expect(store.hasDurableEvent(`${staged.chatId}:${staged.messageId}`)).toBe(false)
    expect(store.stageInboundDelivery({ ...staged, text: 'durable' })).toBe(true)
    expect(store.hasDurableEvent(`${staged.chatId}:${staged.messageId}`)).toBe(true)
    const claimed = store.claimNextInboundDelivery()!
    store.enqueue(staged)
    store.completeInboundDelivery(claimed.idempotencyKey)
    expect(store.hasDurableEvent(claimed.idempotencyKey)).toBe(true)
    store.close()
  })

  test('Slack read cursorは対象eventと同じSQLite ledger内でだけ前進する', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    let store = new JobStore(path)
    expect(store.commitSlackReadCursorIfDurable(
      'owned-thread', 'C1:100.000001', '100.000001', false, [],
    )).toBe(true)
    expect(store.commitSlackReadCursorIfDurable(
      'owned-thread', 'C1:100.000001', '100.000002', false, ['C1:100.000002'],
    )).toBe(false)
    expect(store.readSlackReadCursor('owned-thread', 'C1:100.000001')).toEqual({
      cursor: '100.000001', complete: false, cycleOldestTs: null, cycleStartedTs: null,
    })

    const staged = input({ chatId: 'C1', threadTs: '100.000001', messageId: '100.000002' })
    expect(store.stageInboundDelivery({ ...staged, text: 'offline reply' })).toBe(true)
    expect(store.commitSlackReadCursorIfDurable(
      'owned-thread', 'C1:100.000001', '100.000002', false, ['C1:100.000002'],
    )).toBe(true)
    store.close()

    store = new JobStore(path)
    expect(store.readSlackReadCursor('owned-thread', 'C1:100.000001')).toEqual({
      cursor: '100.000002', complete: false, cycleOldestTs: null, cycleStartedTs: null,
    })
    expect(store.hasDurableEvent('C1:100.000002')).toBe(true)
    store.close()
  })

  test('完了したold-parent scanを同一gateway周期で先頭から再armする', () => {
    const store = makeStore()
    expect(store.commitSlackReadCursorIfDurable(
      'catchup-parent', 'C1', null, true, [],
      { oldestTs: '100.000000', startedTs: '200.000000' },
    )).toBe(true)
    expect(store.restartCompletedSlackReadCursor(
      'catchup-parent', 'C1', '300.000000', '199.000000',
    )).toBe(true)
    expect(store.readSlackReadCursor('catchup-parent', 'C1')).toEqual({
      cursor: null,
      complete: false,
      cycleOldestTs: '199.000000',
      cycleStartedTs: '300.000000',
    })
    expect(store.restartCompletedSlackReadCursor('catchup-parent', 'C1', '400.000000')).toBe(false)
    store.close()
  })

  test('200件超DM listはpageをdurable registryへ積んでからcursorを進める', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    let store = new JobStore(path)
    const firstPage = Array.from({ length: 200 }, (_, index) => `D${String(index).padStart(3, '0')}`)
    store.stageSlackDirectMessagePage(firstPage, 'page-2', false)
    expect(store.readSlackReadCursor('scheduler', 'dm-list')?.cursor).toBe('page-2')
    expect(store.listPendingDirectMessageChannels()).toHaveLength(200)
    for (const channel of firstPage.slice(0, 10)) {
      expect(store.completePendingDirectMessageChannel(channel)).toBe(true)
    }
    store.close()

    store = new JobStore(path)
    expect(store.readSlackReadCursor('scheduler', 'dm-list')?.cursor).toBe('page-2')
    expect(store.listPendingDirectMessageChannels()).toHaveLength(190)
    expect(store.resetSlackReadCursor('scheduler', 'dm-list')).toBe(true)
    expect(store.readSlackReadCursor('scheduler', 'dm-list')?.cursor).toBeNull()
    expect(store.listPendingDirectMessageChannels()).toHaveLength(190)
    store.stageSlackDirectMessagePage(['D-PAGE-2'], null, true)
    expect(store.listPendingDirectMessageChannels()).toContain('D-PAGE-2')
    expect(store.readSlackReadCursor('scheduler', 'dm-list')?.complete).toBe(true)
    store.close()
  })

  test('reply scanはdurable eventよりcursorを先行させず再起動後も次pageから再開する', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    let store = new JobStore(path)
    expect(store.stageSlackReplyScans([
      { channelId: 'C1', threadTs: '100.000000', oldestTs: '90.000000' },
    ])).toBe(1)
    const scan = store.listSlackReplyScans(1)[0]!
    expect(store.commitSlackReplyScanPageIfDurable(
      scan.scanKey, 'reply-page-2', ['C1:100.000001'],
    )).toBe(false)
    expect(store.listSlackReplyScans(1)[0]?.cursor).toBeNull()
    expect(store.stageInboundDelivery({
      ...input({ chatId: 'C1', threadTs: '100.000000', messageId: '100.000001' }),
      text: 'reply',
    })).toBe(true)
    expect(store.commitSlackReplyScanPageIfDurable(
      scan.scanKey, 'reply-page-2', ['C1:100.000001'],
    )).toBe(true)
    store.close()

    store = new JobStore(path)
    expect(store.listSlackReplyScans(1)[0]?.cursor).toBe('reply-page-2')
    expect(store.commitSlackReplyScanPageIfDurable(scan.scanKey, null, [])).toBe(true)
    expect(store.listSlackReplyScans()).toEqual([])
    store.close()
  })

  test('41 reply pagesをtimestamp boundaryでcrash-safeに最後まで有限進行する', () => {
    const store = makeStore()
    store.stageSlackReplyScans([
      { channelId: 'C1', threadTs: '100.000000', oldestTs: '90.000000' },
    ])
    for (let page = 1; page <= 41; page += 1) {
      const scan = store.listSlackReplyScans(1)[0]!
      expect(scan.cursor).toBe(page === 1 ? null : `${90 + page - 1}.000000`)
      const next = page === 41 ? null : `${90 + page}.000000`
      expect(store.commitSlackReplyScanPageIfDurable(scan.scanKey, next, [])).toBe(true)
    }
    expect(store.listSlackReplyScans()).toEqual([])
    store.close()
  })

  test('一時的なnot_in_channelはreply workを保持し復旧後に完了できる', () => {
    const store = makeStore()
    store.stageSlackReplyScans([
      { channelId: 'D-RECOVER', threadTs: '100.000000', oldestTs: '90.000000' },
    ])
    const scan = store.listSlackReplyScans(1)[0]!
    if (slackReplyScanFailureDisposition({ data: { error: 'not_in_channel' } }) === 'discard') {
      store.discardSlackReplyScan(scan.scanKey)
    } else {
      store.deferSlackReplyScan(scan.scanKey)
    }
    expect(store.listSlackReplyScans(1).map(item => item.scanKey)).toEqual([scan.scanKey])
    expect(store.commitSlackReplyScanPageIfDurable(scan.scanKey, null, [])).toBe(true)
    expect(store.listSlackReplyScans()).toEqual([])
    store.close()
  })

  test('thread_not_foundのreply workはdiscardでき後続を塞がない', () => {
    const store = makeStore()
    store.stageSlackReplyScans([
      { channelId: 'D-STALE', threadTs: '100.000000', oldestTs: '90.000000' },
      { channelId: 'D-LIVE', threadTs: '101.000000', oldestTs: '90.000000' },
    ])
    const stale = store.listSlackReplyScans(2).find(scan => scan.channelId === 'D-STALE')!
    expect(slackReplyScanFailureDisposition({ data: { error: 'thread_not_found' } })).toBe('discard')
    expect(store.discardSlackReplyScan(stale.scanKey)).toBe(true)
    expect(store.listSlackReplyScans(2).map(scan => scan.channelId)).toEqual(['D-LIVE'])
    store.close()
  })

  test('同じhistory pageで重複stageされた41 parentは一意なdurable workになる', () => {
    const store = makeStore()
    const parents = Array.from({ length: 41 }, (_, index) => ({
      channelId: 'C1',
      threadTs: `100.${String(index).padStart(6, '0')}`,
      oldestTs: '90.000000',
    }))
    expect(store.stageSlackReplyScans(parents)).toBe(41)
    expect(store.stageSlackReplyScans(parents)).toBe(0)
    expect(store.listSlackReplyScans(50)).toHaveLength(41)
    store.close()
  })

  test('上限回数を超えたinboundを失敗通知へ退避し、次のeventへ進む', () => {
    const store = makeStore()
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'poison' }),
      text: 'poison',
    })).toBe(true)
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'next' }),
      text: 'next',
    })).toBe(true)
    const poison = store.claimNextInboundDelivery(1_000)!
    const failedJobId = store.failInboundDelivery(poison.idempotencyKey, 'Slack download failed')
    expect(store.get(failedJobId)).toMatchObject({
      status: 'failed',
      lastError: 'Slack download failed',
    })
    expect(store.terminalNotificationCount()).toBe(1)
    expect(store.claimNextInboundDelivery(1_000)?.text).toBe('next')
    store.close()
  })

  test('settled GCは通知済みjobだけを削除し、tombstoneでSlack再配送を抑止する', () => {
    const state = fixtureDir()
    const dbPath = join(state, 'jobs.sqlite3')
    const attachment = join(state, 'inbox', 'old', 'input.txt')
    mkdirSync(dirname(attachment), { recursive: true })
    chmodSync(state, 0o700)
    writeFileSync(attachment, 'input')
    const store = new JobStore(dbPath)
    const removable = store.enqueue(input({ messageId: 'old', attachments: [attachment] })).job
    store.claimNext('worker')
    store.complete(removable.id, 'session-old', 'done')
    const delivered = store.pendingTerminalNotifications().find(item => item.jobId === removable.id)!
    store.markTerminalNotificationDelivered(delivered.id)
    mkdirSync(join(state, 'outbox', removable.id), { recursive: true })
    mkdirSync(join(state, 'job-logs'), { recursive: true })
    writeFileSync(join(state, 'job-logs', `${removable.id}.stdout.log`), 'old log')

    const retained = store.enqueue(input({ messageId: 'pending-notification' })).job
    store.claimNext('worker')
    store.complete(retained.id, 'session-retained', 'done')
    const database = new Database(dbPath)
    database.run('UPDATE jobs SET finished_at = 1 WHERE id IN (?, ?)', [removable.id, retained.id])
    database.run('UPDATE terminal_notifications SET delivered_at = 1 WHERE job_id = ?', [removable.id])
    database.close()

    const result = store.pruneSettled({
      stateDir: state,
      now: 10_000,
      retentionMs: 1_000,
      tombstoneRetentionMs: 100_000,
    })
    expect(result.jobs).toBe(1)
    expect(store.get(removable.id)).toBeNull()
    expect(store.get(retained.id)?.status).toBe('completed')
    expect(store.getThread(removable.chatId, removable.threadTs)?.repoPath).toBe(removable.repoPath)
    expect(existsSync(attachment)).toBe(false)
    expect(existsSync(join(state, 'outbox', removable.id))).toBe(false)
    expect(existsSync(join(state, 'job-logs', `${removable.id}.stdout.log`))).toBe(false)
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'old' }),
      text: 'redelivery',
    })).toBe(false)
    store.close()
  })

  test('runtime log capは通常fileだけを切り詰め、symlinkを拒否する', () => {
    const state = fixtureDir()
    const log = join(state, 'job-runner.log')
    writeFileSync(log, '0123456789')
    expect(capRuntimeLogs(state, 5)).toBe(1)
    expect(statSync(log).size).toBe(5)
    expect(readFileSync(log, 'utf8')).toBe('56789')
    const protectedFile = join(state, 'protected.txt')
    writeFileSync(protectedFile, 'must remain')
    rmSync(log)
    symlinkSync(protectedFile, log)
    expect(capRuntimeLogs(state, 5, () => {})).toBe(0)
    expect(readFileSync(protectedFile, 'utf8')).toBe('must remain')
  })

  test('settled GCはmanaged root symlinkやdot job IDからstate外を削除しない', () => {
    const state = fixtureDir()
    const external = fixtureDir('zerokun-gc-external-')
    const jobId = 'settled-job'
    const externalJob = join(external, jobId)
    mkdirSync(externalJob)
    writeFileSync(join(externalJob, 'preserve.txt'), 'preserve')
    symlinkSync(external, join(state, 'outbox'))
    const warnings: string[] = []
    const removed = removeSettledJobState({
      stateDir: state,
      jobIds: [jobId, '.', '..'],
      attachmentPaths: [],
      stillReferencedAttachments: new Set(),
      onUnsafe: warning => warnings.push(warning),
    })
    expect(removed).toBe(0)
    expect(readFileSync(join(externalJob, 'preserve.txt'), 'utf8')).toBe('preserve')
    expect(warnings.some(warning => warning.includes('unsafe managed path component'))).toBe(true)
  })

  test('同じSlack eventはCodex job 1件へ収束し、thread adoptionも同じtransactionで残る', () => {
    const store = makeStore()
    const first = store.enqueue(input())
    const duplicate = store.enqueue(input())

    expect(first.duplicate).toBe(false)
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.job.id).toBe(first.job.id)
    expect(store.list()).toHaveLength(1)
    expect(store.getThread(input().chatId, input().threadTs)).toMatchObject({
      repoPath: '/tmp/project',
      adoptedFromTs: input().messageId,
    })
    store.close()
  })

  test('更新messageのidempotencyはdelivered.jsonのpruneや再起動に依存しない', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    let store = new JobStore(path)
    expect(store.reserveUpdateRequest('C:1')).toBe(true)
    expect(store.reserveUpdateRequest('C:1')).toBe(false)
    store.close()
    store = new JobStore(path)
    expect(store.reserveUpdateRequest('C:1')).toBe(false)
    store.releaseUpdateRequest('C:1')
    expect(store.reserveUpdateRequest('C:1')).toBe(true)
    store.close()
  })

  test('legacy migration markerは再起動後も保持する', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    let store = new JobStore(path)
    expect(store.migrationApplied('legacy-threads-json-v1')).toBe(false)
    store.markMigrationApplied('legacy-threads-json-v1')
    store.close()
    store = new JobStore(path)
    expect(store.migrationApplied('legacy-threads-json-v1')).toBe(true)
    store.close()
  })

  test('新規sessionを事前採番せず、Codexが返したIDを保存してfollow-upでresumeする', () => {
    const store = makeStore()
    store.enqueue(input())
    const first = store.claimNext('serial-worker')!
    expect(first.sessionId).toBeNull()
    expect(first.resumed).toBe(false)

    store.saveExecutorPid(first.id, process.pid)
    expect(store.get(first.id)?.executorPid).toBe(process.pid)
    store.saveSession(first.id, 'codex-thread-1')
    store.complete(first.id, 'codex-thread-1', 'done')
    expect(store.get(first.id)?.executorPid).toBeNull()
    store.enqueue(input({ messageId: '1800000000.000200', task: '続き' }))
    const followUp = store.claimNext('serial-worker')!
    expect(followUp.sessionId).toBe('codex-thread-1')
    expect(followUp.resumed).toBe(true)
    store.close()
  })

  test('同じthreadでもroute先が変われば別sessionにする', () => {
    const store = makeStore()
    store.enqueue(input())
    const first = store.claimNext('serial-worker')!
    store.complete(first.id, 'codex-thread-old-repo', 'done')
    store.enqueue(input({ messageId: '2', repoPath: '/tmp/other-project' }))

    expect(store.claimNext('serial-worker')?.sessionId).toBeNull()
    store.close()
  })

  test('同じthreadでもwrite modeが変われば別sessionにする', () => {
    const store = makeStore()
    store.enqueue(input({ writeEnabled: true }))
    const writable = store.claimNext('serial-worker')!
    store.complete(writable.id, 'codex-thread-write', 'done')
    store.enqueue(input({ messageId: '2', writeEnabled: false }))

    expect(store.claimNext('serial-worker')?.sessionId).toBeNull()
    store.close()
  })

  test('同じchannel threadでもsenderが変われば別sessionにする', () => {
    const store = makeStore()
    store.enqueue(input({ userId: 'U1111111111' }))
    const first = store.claimNext('serial-worker')!
    store.complete(first.id, 'codex-thread-user-1', 'done')
    store.enqueue(input({ messageId: '2', userId: 'U2222222222' }))
    expect(store.claimNext('serial-worker')?.sessionId).toBeNull()
    store.close()
  })

  test('同じthreadのCodex sessionは5jobまでで、6件目は新規にする', () => {
    const store = makeStore()
    const sessionIds: Array<string | null> = []
    for (let index = 1; index <= 6; index += 1) {
      store.enqueue(input({ messageId: String(index), task: `job-${index}` }))
      const job = store.claimNext('serial-worker', 5)!
      sessionIds.push(job.sessionId)
      const sessionId = job.sessionId ?? `codex-thread-${index}`
      store.complete(job.id, sessionId, 'done')
    }
    expect(sessionIds).toEqual([null, 'codex-thread-1', 'codex-thread-1', 'codex-thread-1', 'codex-thread-1', null])
    store.close()
  })

  test('旧DBの待機jobはClaude sessionを破棄してCodexへ引き継ぐ', () => {
    const dir = fixtureDir()
    const path = join(dir, 'legacy.sqlite3')
    const db = new Database(path, { create: true })
    db.exec(`
      CREATE TABLE jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, idempotency_key TEXT UNIQUE,
        chat_id TEXT, thread_ts TEXT, message_id TEXT, user_id TEXT, repo_path TEXT, task TEXT,
        status TEXT, session_id TEXT, resumed INTEGER, worker_id TEXT, attempts INTEGER,
        result TEXT, last_error TEXT, created_at INTEGER, started_at INTEGER, finished_at INTEGER
      );
      INSERT INTO jobs VALUES (
        1, 'legacy', 'C:1', 'C', '1', '1', 'U', '/tmp/project', 'legacy task',
        'queued', 'claude-session-id', 0, NULL, 0, NULL, NULL, 1, NULL, NULL
      );
    `)
    db.close()

    const store = new JobStore(path)
    expect(store.list()[0]).toMatchObject({
      runtime: 'claude',
      status: 'queued',
      sessionId: 'claude-session-id',
    })
    expect(store.countLegacyActive()).toBe(1)
    expect(store.migrateLegacyActive()).toBe(1)
    expect(store.countLegacyActive()).toBe(0)
    expect(store.list()[0]).toMatchObject({
      runtime: 'codex',
      status: 'queued',
      sessionId: null,
      resumed: false,
    })
    const duplicate = store.enqueue(input({
      chatId: 'C', threadTs: '1', messageId: '1', userId: 'U',
      repoPath: '/tmp/project', task: 'legacy task',
    }))
    expect(duplicate.duplicate).toBe(true)
    expect(store.list()).toHaveLength(1)
    expect(store.claimNext('serial-worker')).toMatchObject({ runtime: 'codex', resumed: false })
    store.close()
  })

  test('旧Claudeの実行中jobは副作用を二重実行せずfailedとして再送を求める', () => {
    const store = makeStore()
    const queued = store.enqueue(input()).job
    const db = new Database(store.dbPath)
    db.run(
      "UPDATE jobs SET runtime = 'claude', status = 'running', session_id = 'claude-session' WHERE id = ?",
      [queued.id],
    )
    db.close()

    expect(store.migrateLegacyActive()).toBe(1)
    expect(store.get(queued.id)).toMatchObject({
      runtime: 'claude',
      status: 'failed',
      sessionId: 'claude-session',
    })
    expect(store.claimNext('serial-worker')).toBeNull()
    expect(store.terminalNotificationCount()).toBe(1)
    store.close()
  })

  test('書込み許可はenqueue時の値を固定する', () => {
    const store = makeStore()
    const queued = store.enqueue(input({ writeEnabled: true })).job
    expect(queued.writeEnabled).toBe(true)
    expect(store.claimNext('serial-worker')?.writeEnabled).toBe(true)
    store.close()
  })
})

describe('single FIFO worker', () => {
  test('ワーカー数は常に1', () => {
    expect(SERIAL_WORKER_COUNT).toBe(1)
  })

  test('10件をFIFOで1件ずつ実行する', async () => {
    const store = makeStore()
    for (let index = 0; index < 10; index += 1) {
      store.enqueue(input({ messageId: String(index), task: `job-${index}` }))
    }
    let active = 0
    let maxActive = 0
    const order: string[] = []
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async job => {
        active += 1
        maxActive = Math.max(maxActive, active)
        order.push(job.task)
        await Bun.sleep(2)
        active -= 1
        return { sessionId: job.sessionId ?? `session-${job.id}`, result: 'ok' }
      },
    })
    expect(stats).toEqual({ completed: 10, failed: 0, workersStarted: 1 })
    expect(maxActive).toBe(1)
    expect(order).toEqual(Array.from({ length: 10 }, (_, index) => `job-${index}`))
    store.close()
  })

  test('Codex rate limitはfailedにせず再開時刻へ戻す', async () => {
    const store = makeStore()
    const queued = store.enqueue(input()).job
    const reset = Date.now() + 60_000
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async () => { throw new CodexRateLimitError('rate limited', reset, 'thread-1') },
    })
    expect(stats).toEqual({ completed: 0, failed: 0, workersStarted: 1 })
    expect(store.get(queued.id)).toMatchObject({
      status: 'queued',
      sessionId: 'thread-1',
      notBefore: reset + 60_000,
    })
    store.close()
  })

  test('write jobのrate limitは不確実な副作用を自動再実行せずfailedにする', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ writeEnabled: true })).job
    const reset = Date.now() + 60_000
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async () => {
        throw new CodexRateLimitError('rate limited after write', reset, 'thread-write')
      },
    })
    expect(stats).toEqual({ completed: 0, failed: 1, workersStarted: 1 })
    expect(store.get(queued.id)).toMatchObject({
      status: 'failed',
      sessionId: null,
      writeEnabled: true,
    })
    expect(store.terminalNotificationCount()).toBe(1)
    expect(store.claimNext('serial-worker')).toBeNull()
    store.close()
  })

  test('先頭jobがrate-limit待ちなら後続jobは追い越さない', () => {
    const store = makeStore()
    const first = store.enqueue(input({ messageId: 'first', task: 'first' })).job
    store.enqueue(input({ messageId: 'second', task: 'second' }))
    const claimed = store.claimNext('serial-worker')!
    expect(claimed.id).toBe(first.id)
    store.requeueAt(first.id, Date.now() + 60_000, 'rate limited')
    expect(store.claimNext('serial-worker')).toBeNull()
    expect(store.countClaimable()).toBe(0)
    store.close()
  })

  test('runner SIGKILL相当の再起動時にtracked supervisorを停止してjobを再queueする', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, '#!/bin/bash\nsleep 30\n')
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    const registration = join(dir, 'executors', `${job.id}.json`)
    mkdirSync(join(dir, 'executors'), { recursive: true })
    const supervisor = Bun.spawn([
      process.execPath,
      join(import.meta.dir, 'codex-supervisor.ts'),
      job.id,
      registration,
      fakeCodex,
    ], {
      cwd: repo,
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      detached: process.platform !== 'win32',
    })
    try {
      const deadline = Date.now() + 2_000
      while (!existsSync(registration) && Date.now() < deadline) await Bun.sleep(10)
      expect(existsSync(registration)).toBe(true)
      // DBへPIDを保存する前にrunnerが落ちてもregistrationから回収できる。
      await terminateTrackedExecutors(store, () => {}, 2_000, dir)
      await supervisor.exited
      expect(existsSync(registration)).toBe(false)
      expect(store.recoverInterrupted()).toEqual({ requeued: 1, failedWrites: 0 })
      expect(store.get(job.id)).toMatchObject({ status: 'queued', executorPid: null })
    } finally {
      try { supervisor.kill('SIGKILL') } catch {}
      store.close()
    }
  })

  test('PID再利用でidentity不一致なら無関係processを殺さずstale登録だけを回収する', async () => {
    const dir = fixtureDir()
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    const job = store.enqueue(input()).job
    store.claimNext('serial-worker')
    const unrelated = Bun.spawn(['/bin/sleep', '30'], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    const registration = join(dir, 'executors', `${job.id}.json`)
    mkdirSync(dirname(registration), { recursive: true })
    writeFileSync(registration, JSON.stringify({ jobId: job.id, pid: unrelated.pid }))
    store.saveExecutorPid(job.id, unrelated.pid)
    try {
      await terminateTrackedExecutors(store, () => {}, 100, dir)
      expect(unrelated.exitCode).toBeNull()
      expect(existsSync(registration)).toBe(false)
      expect(store.get(job.id)?.executorPid).toBeNull()
      expect(store.recoverInterrupted()).toEqual({ requeued: 1, failedWrites: 0 })
    } finally {
      unrelated.kill('SIGKILL')
      await unrelated.exited
      store.close()
    }
  })

  test('symlink名zerokun-updateで起動した本番updater lock中はclaimをpauseする', async () => {
    const dir = fixtureDir()
    const lockDir = join(dir, 'update.lock')
    const lockFile = join(lockDir, 'pid')
    const script = join(dir, 'update-worker.sh')
    const updater = join(dir, 'zerokun-update')
    writeFileSync(script, '#!/bin/bash\nsleep 30\n')
    chmodSync(script, 0o700)
    symlinkSync(script, updater)
    const process = Bun.spawn(['/bin/bash', updater], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    mkdirSync(lockDir)
    writeFileSync(lockFile, `${process.pid}\n`, { mode: 0o600 })
    try {
      adoptLegacyProcessIdentity(lockFile, process.pid, ['zerokun-update'])
      expect(updateIsRunning(lockDir)).toBe(true)
    } finally {
      process.kill('SIGKILL')
      await process.exited
    }
  })

  test('updater PID消失後もtransaction journalがwrite jobをfail-closedで止める', async () => {
    const dir = fixtureDir()
    const journal = join(dir, 'update-transaction.json')
    expect(updateTransactionPending(journal)).toBe(false)
    writeFileSync(journal, '{}', { mode: 0o600 })
    expect(updateTransactionPending(journal)).toBe(true)

    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    const queued = store.enqueue(input({ writeEnabled: true })).job
    let executions = 0
    const controller = new AbortController()
    const running = runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 5,
      shouldPause: () => updateTransactionPending(journal),
      signal: controller.signal,
      executor: async () => {
        executions += 1
        return { sessionId: '01941f65-7e97-7f41-8968-c2e676dd68b8', result: 'done' }
      },
    })
    await Bun.sleep(30)
    expect(executions).toBe(0)
    expect(store.get(queued.id)?.status).toBe('queued')
    rmSync(journal)
    for (let attempt = 0; attempt < 40 && executions === 0; attempt += 1) await Bun.sleep(5)
    expect(executions).toBe(1)
    controller.abort()
    await running
    store.close()
  })

  test('pre-check直後にupdate barrierが現れてもclaimを副作用前に戻す', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ writeEnabled: true })).job
    let checks = 0
    let executions = 0
    const controller = new AbortController()
    const running = runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 5,
      shouldPause: () => {
        checks += 1
        return checks >= 2
      },
      signal: controller.signal,
      executor: async () => {
        executions += 1
        return { sessionId: '01941f65-7e97-7f41-8968-c2e676dd68b8', result: 'done' }
      },
    })
    for (let attempt = 0; attempt < 40 && checks < 2; attempt += 1) await Bun.sleep(5)
    controller.abort()
    await running
    expect(checks).toBeGreaterThanOrEqual(2)
    expect(executions).toBe(0)
    expect(store.get(queued.id)).toMatchObject({ status: 'queued', attempts: 0 })
    store.close()
  })

  test('unsafe journal entryも存在する限り更新barrierとして扱う', () => {
    const dir = fixtureDir()
    const target = join(dir, 'target')
    writeFileSync(target, '{}')
    const journal = join(dir, 'update-transaction.json')
    symlinkSync(target, journal)
    expect(updateTransactionPending(journal)).toBe(true)
  })

  test('runner再起動時のwrite jobは副作用を二重実行せずfailedにする', () => {
    const store = makeStore()
    const queued = store.enqueue(input({ writeEnabled: true })).job
    store.claimNext('serial-worker')

    expect(store.recoverInterrupted()).toEqual({ requeued: 0, failedWrites: 1 })
    expect(store.get(queued.id)).toMatchObject({
      status: 'failed',
      writeEnabled: true,
    })
    expect(store.terminalNotificationCount()).toBe(1)
    expect(store.claimNext('serial-worker')).toBeNull()
    store.close()
  })

  test('graceful interruptでもwrite jobは不確実な副作用を自動再実行しない', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ writeEnabled: true })).job
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async () => {
        throw new CodexInterruptedError('terminated')
      },
    })

    expect(stats).toEqual({ completed: 0, failed: 1, workersStarted: 1 })
    expect(store.get(queued.id)).toMatchObject({ status: 'failed' })
    expect(store.terminalNotificationCount()).toBe(1)
    store.close()
  })
})

describe('Codex JSONL contract', () => {
  test('thread.startedからsession IDを読む', () => {
    expect(codexThreadIdFromEvent({
      type: 'thread.started',
      thread_id: '0199d18e-1234-7000-9000-000000000001',
    })).toBe('0199d18e-1234-7000-9000-000000000001')
  })

  test('-oの最終文を優先し、無い場合だけ最後のagent_messageへfallbackする', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'event answer' } }),
    ].join('\n')
    expect(parseCodexResult(stdout, 'file answer\n')).toBe('file answer')
    expect(parseCodexResult(stdout)).toBe('event answer')
  })

  test('長い最終文でも末尾のartifact markerを保持する', () => {
    const marker = '<zerokun_files>["/tmp/out.csv"]</zerokun_files>'
    const parsed = parseCodexResult('', `${'x'.repeat(20_000)}\n${marker}`)
    expect(parsed).toEndWith(marker)
    expect(parsed).toContain('長いため')
  })

  test('会話本文ではなく構造化errorだけをrate limit判定する', () => {
    const ordinary = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'rate limitの実装を説明します' },
    })
    expect(extractCodexRateLimit(ordinary).rateLimited).toBe(false)
    const failure = JSON.stringify({
      type: 'turn.failed',
      error: { code: 429, message: 'rate limit exceeded' },
      retry_after: 120,
    })
    expect(extractCodexRateLimit(failure, 1_000)).toEqual({
      rateLimited: true,
      resetsAtMs: 121_000,
    })
  })
})

describe('Codex process isolation', () => {
  test('Codex attemptはprocess終了前abortと終了後abortを区別する', () => {
    expect(codexAttemptDisposition(0, false, false)).toBe('success')
    expect(codexAttemptDisposition(0, false, true)).toBe('interrupted')
    expect(codexAttemptDisposition(143, false, true)).toBe('interrupted')
    expect(codexAttemptDisposition(0, true, true)).toBe('timed-out')
  })

  test('実行中abortを受けて0終了するCodexもinterruptedにする', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
writeFileSync(args[args.indexOf('--output-last-message') + 1], 'partial')
process.on('SIGTERM', () => process.exit(0))
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'interrupted-thread' }))
await Bun.sleep(30_000)
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    const controller = new AbortController()
    try {
      await expect(executeCodexJob(job, {
        codexBin: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
        signal: controller.signal,
        onSessionId: () => controller.abort(),
      })).rejects.toBeInstanceOf(CodexInterruptedError)
    } finally {
      store.close()
    }
  })

  test('process exit確定後のrunner abortは成功を失敗へ戻さない', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
writeFileSync(args[args.indexOf('--output-last-message') + 1], 'complete')
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'completed-thread' }))
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    const controller = new AbortController()
    try {
      const result = await executeCodexJob(job, {
        codexBin: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
        signal: controller.signal,
        onProcessExit: () => controller.abort(),
      })
      expect(controller.signal.aborted).toBe(true)
      expect(result).toEqual({ sessionId: 'completed-thread', result: 'complete' })
    } finally {
      store.close()
    }
  })

  test('system configのlegacy sandboxがnamed permission profileを無効化するためfail-closedにする', () => {
    const dir = fixtureDir()
    const config = join(dir, 'config.toml')
    writeFileSync(config, 'sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = true\n')
    expect(() => assertCompatibleSystemCodexConfig(config)).toThrow('legacy sandbox setting')
    writeFileSync(config, '[profiles.unsafe]\nsandbox_mode = "workspace-write"\n')
    expect(() => assertCompatibleSystemCodexConfig(config)).toThrow('profiles.unsafe.sandbox_mode')
    writeFileSync(config, '[mcp_servers]\n')
    expect(() => assertCompatibleSystemCodexConfig(config)).not.toThrow()
  })

  test('開始前にabort済みならCodex processをspawnしない', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    const controller = new AbortController()
    controller.abort()
    try {
      await expect(executeCodexJob(job, {
        codexBin: join(dir, 'must-not-be-spawned'),
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
        signal: controller.signal,
      })).rejects.toBeInstanceOf(CodexInterruptedError)
    } finally {
      store.close()
    }
  })

  test('Zero-kun runtime repositoryへのwrite jobはCodex起動前に拒否する', async () => {
    const dir = fixtureDir()
    const runtimeRepo = realpathSync(join(import.meta.dir, '..'))
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: runtimeRepo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBin: join(dir, 'must-not-run'),
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('cannot target the Zero-kun runtime repository')
    } finally { store.close() }
  })

  test('Zero-kun runtimeの祖先directoryへのwrite jobも拒否する', async () => {
    const dir = fixtureDir()
    const runtimeParent = realpathSync(join(import.meta.dir, '../..'))
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: runtimeParent, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBin: join(dir, 'must-not-run'),
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('cannot target the Zero-kun runtime repository')
    } finally { store.close() }
  })

  test('filesystem rootへのwrite jobもruntime祖先としてCodex起動前に拒否する', async () => {
    const dir = fixtureDir()
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: '/', writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBin: join(dir, 'must-not-run'),
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('cannot target the Zero-kun runtime repository')
    } finally { store.close() }
  })

  test('Slack tokenとClaudeのネスト環境を子へ渡さない', () => {
    const child = buildCodexChildEnvironment({
      PATH: '/usr/bin',
      SLACK_BOT_TOKEN: 'xoxb-secret',
      SLACK_APP_TOKEN: 'xapp-secret',
      SLACK_SIGNING_SECRET: 'secret',
      CLAUDECODE: '1',
      KEEP: 'yes',
    })
    expect(child).toEqual({ PATH: '/usr/bin' })
    expect(child.SLACK_BOT_TOKEN).toBeUndefined()
    expect(child.SLACK_APP_TOKEN).toBeUndefined()
    expect(child.SLACK_SIGNING_SECRET).toBeUndefined()
    expect(child.CLAUDECODE).toBeUndefined()
  })

  test('read-only senderには変更禁止と許可コマンドを明示する', () => {
    const store = makeStore()
    store.enqueue(input())
    const job = store.claimNext('serial-worker')!
    const instructions = buildCodexDeveloperInstructions(job, '/tmp/job-outbox')
    const prompt = buildCodexWorkerPrompt(job)
    expect(instructions).toContain(CODEX_WORKER_SAFETY_PROMPT)
    expect(instructions).toContain('read-only access')
    expect(instructions).toContain(`zerokun-access write allow ${job.userId}`)
    expect(instructions).toContain('Never post to Slack yourself')
    expect(prompt).toContain(job.task)
    expect(prompt).not.toContain(CODEX_WORKER_SAFETY_PROMPT)
    store.close()
  })

  test('新規execはCodexが返したsessionを即時通知し、final fileだけを結果にする', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const capture = join(dir, 'capture.json')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
const prompt = await Bun.stdin.text()
writeFileSync(process.env.CAPTURE_FILE!, JSON.stringify({
  args, prompt, cwd: process.cwd(), slack: process.env.SLACK_BOT_TOKEN ?? null,
}))
const output = args[args.indexOf('--output-last-message') + 1]
writeFileSync(output, 'final from fixture')
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-fixture' }))
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'event text' } }))
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    const observed: string[] = []
    const previousCapture = process.env.CAPTURE_FILE
    const previousSlack = process.env.SLACK_BOT_TOKEN
    process.env.CAPTURE_FILE = capture
    process.env.SLACK_BOT_TOKEN = 'xoxb-must-not-leak'
    try {
      const result = await executeCodexJob(job, {
        codexBin: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
        timeoutMs: 5_000,
        extraEnvironment: { CAPTURE_FILE: capture },
        onSessionId: value => observed.push(value),
      })
      const invocation = JSON.parse(readFileSync(capture, 'utf8')) as {
        args: string[]
        prompt: string
        cwd: string
        slack: string | null
      }
      expect(result).toEqual({ sessionId: 'codex-thread-fixture', result: 'final from fixture' })
      expect(observed).toEqual(['codex-thread-fixture'])
      expect(invocation.cwd).toBe(realpathSync(repo))
      expect(invocation.slack).toBeNull()
      expect(invocation.args).toContain('exec')
      expect(invocation.args).not.toContain('resume')
      expect(invocation.args).toContain('--ignore-user-config')
      expect(invocation.args).toContain('--ignore-rules')
      const finalOutput = invocation.args[invocation.args.indexOf('--output-last-message') + 1]!
      expect(finalOutput).toStartWith(realpathSync(join(dir, 'state/final-output/')))
      expect(invocation.args.filter(value => value.includes('filesystem={')).join('\n'))
        .not.toContain(join(dir, 'state/final-output'))
      expect(invocation.args.some(value => (
        value.includes('filesystem={') && value.includes('":minimal"="read"')
      ))).toBe(true)
      expect(invocation.args).not.toContain('-s')
      expect(invocation.args.some(value => value.includes('default_permissions='))).toBe(true)
      expect(invocation.args).toContain('web_search="disabled"')
      expect(invocation.args).toContain('tools.web_search=false')
      expect(invocation.args.some(value => value.includes('network.domains='))).toBe(false)
      expect(invocation.args).toContain('apps._default.enabled=false')
      expect(invocation.args).toContain('hooks={}')
      expect(invocation.args.some(value => value.includes(job.task))).toBe(false)
      expect(invocation.prompt).toContain(job.task)
    } finally {
      if (previousCapture === undefined) delete process.env.CAPTURE_FILE
      else process.env.CAPTURE_FILE = previousCapture
      if (previousSlack === undefined) delete process.env.SLACK_BOT_TOKEN
      else process.env.SLACK_BOT_TOKEN = previousSlack
      store.close()
    }
  })

  test('write許可jobだけworkspace-writeとnetworkを受け取る', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const capture = join(dir, 'capture.json')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
writeFileSync(process.env.CAPTURE_FILE!, JSON.stringify(args))
writeFileSync(args[args.indexOf('--output-last-message') + 1], 'ok')
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'write-thread' }))
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    const previous = process.env.CAPTURE_FILE
    process.env.CAPTURE_FILE = capture
    try {
      await executeCodexJob(job, {
        codexBin: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
        extraEnvironment: { CAPTURE_FILE: capture },
      })
      const args = JSON.parse(readFileSync(capture, 'utf8')) as string[]
      expect(args.some(value => (
        value.includes('filesystem={') && value.includes('":minimal"="read"')
      ))).toBe(true)
      expect(args.some(value => value.includes('network.enabled=true'))).toBe(true)
      expect(args.some(value => value.includes('network.domains={"*"="allow"'))).toBe(true)
      expect(args).toContain('web_search="live"')
      expect(args).toContain('tools.web_search=true')
      expect(args.some(value => value.includes('/.git') && value.includes('write'))).toBe(true)
      expect(args).not.toContain('-s')
      expect(args).toContain('never')
    } finally {
      if (previous === undefined) delete process.env.CAPTURE_FILE
      else process.env.CAPTURE_FILE = previous
      store.close()
    }
  })

  test('resume先が無ければsessionを消して新規execへ1回だけfallbackする', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const calls = join(dir, 'calls.jsonl')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from 'fs'
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS_FILE!, JSON.stringify(args) + '\\n')
if (args.includes('resume')) {
  console.error('no rollout found for thread id missing-thread')
  process.exit(1)
}
writeFileSync(args[args.indexOf('--output-last-message') + 1], 'recovered')
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'replacement-thread' }))
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const first = store.claimNext('serial-worker')!
    store.complete(first.id, 'missing-thread', 'old')
    store.enqueue(input({ repoPath: repo, messageId: 'follow-up' }))
    const job = store.claimNext('serial-worker')!
    expect(job.resumed).toBe(true)
    const resets: number[] = []
    const previous = process.env.CALLS_FILE
    process.env.CALLS_FILE = calls
    try {
      const result = await executeCodexJob(job, {
        codexBin: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
        extraEnvironment: { CALLS_FILE: calls },
        onSessionReset: () => resets.push(1),
      })
      const invocations = readFileSync(calls, 'utf8').trim().split('\n')
        .map(line => JSON.parse(line)) as string[][]
      expect(invocations).toHaveLength(2)
      expect(invocations[0]).toContain('resume')
      expect(invocations[1]).not.toContain('resume')
      expect(resets).toEqual([1])
      expect(result.sessionId).toBe('replacement-thread')
    } finally {
      if (previous === undefined) delete process.env.CALLS_FILE
      else process.env.CALLS_FILE = previous
      store.close()
    }
  })

  test('session IDの永続化に失敗したらCodexを停止して失敗を返す', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'must-persist' }))
await Bun.sleep(30_000)
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    const startedAt = Date.now()
    try {
      await expect(executeCodexJob(job, {
        codexBin: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
        timeoutMs: 10_000,
        onSessionId: () => { throw new Error('sqlite persistence failed') },
      })).rejects.toThrow('sqlite persistence failed')
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    } finally {
      store.close()
    }
  })

  test('Codexが残したbackground子processを正常完了時にも回収する', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const fakeCodex = join(dir, 'fake-codex')
    const childPidFile = join(dir, 'child.pid')
    mkdirSync(repo)
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
const child = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
writeFileSync(process.env.CHILD_PID_FILE!, String(child.pid))
writeFileSync(args[args.indexOf('--output-last-message') + 1], 'ok')
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'background-thread' }))
process.exit(0)
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    try {
      await executeCodexJob(job, {
        codexBin: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
        extraEnvironment: { CHILD_PID_FILE: childPidFile },
        timeoutMs: 5_000,
      })
      const childPid = Number(readFileSync(childPidFile, 'utf8'))
      expect(childPid).toBeGreaterThan(0)
      expect(() => process.kill(childPid, 0)).toThrow()
    } finally {
      store.close()
    }
  })

  test('大量JSONL出力は20MB logと1MB解析tailへ上限化する', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const logs = join(dir, 'state/job-logs')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
for (let index = 0; index < 45000; index += 1) {
  console.log(JSON.stringify({ type: 'item.completed', item: { text: 'x'.repeat(512) } }))
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'large-output-thread' }))
writeFileSync(args[args.indexOf('--output-last-message') + 1], 'ok')
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    try {
      const result = await executeCodexJob(job, {
        codexBin: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: logs,
        timeoutMs: 20_000,
      })
      expect(result.sessionId).toBe('large-output-thread')
      const logSize = statSync(join(logs, `${job.id}.stdout.log`)).size
      expect(logSize).toBeGreaterThan(19 * 1024 * 1024)
      expect(logSize).toBeLessThanOrEqual(20 * 1024 * 1024)
    } finally {
      store.close()
    }
  })

  test('permission profileはHOME/stateを閉じ、repo・当該添付・outboxだけを再許可する', () => {
    const dir = fixtureDir()
    const state = join(dir, 'state')
    const repo = join(dir, 'repo')
    const attachment = join(state, 'inbox', 'message', 'input.txt')
    const outbox = join(state, 'outbox', 'job')
    const scratch = join(state, 'tmp', 'job')
    const codexHome = join(dir, 'codex-home')
    mkdirSync(dirname(attachment), { recursive: true })
    chmodSync(state, 0o700)
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(outbox, { recursive: true })
    mkdirSync(scratch, { recursive: true })
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(attachment, 'input')
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    try {
      store.enqueue(input({ repoPath: repo, attachments: [attachment], writeEnabled: true }))
      const job = store.claimNext('serial-worker')!
      const overrides = buildCodexPermissionOverrides(job, {
        stateDir: state,
        artifactDir: outbox,
        scratchDir: scratch,
      }).join('\n')
      expect(overrides).toContain('":minimal"="read"')
      expect(overrides).not.toContain('extends=')
      expect(overrides).toContain(`${JSON.stringify(realpathSync(repo))}="write"`)
      expect(overrides).toContain(`${JSON.stringify(realpathSync(join(repo, '.git')))}="write"`)
      expect(overrides).toContain(`${JSON.stringify(realpathSync(attachment))}="read"`)
      expect(overrides).toContain(`${JSON.stringify(realpathSync(state))}="deny"`)
      expect(overrides).toContain(`${JSON.stringify(realpathSync(codexHome))}="deny"`)
      expect(overrides).toContain('"*PROXY*"')
      expect(overrides).toContain('network.enabled=true')
      expect(overrides).toContain('features.network_proxy=true')
      for (const slackDomain of [
        'slack.com', '**.slack.com',
        'slack-edge.com', '**.slack-edge.com',
        'slack-msgs.com', '**.slack-msgs.com',
      ]) expect(overrides).toContain(`${JSON.stringify(slackDomain)}="deny"`)
      expect(overrides).toContain('features.apps=false')
      expect(overrides).toContain('features.plugins=false')
      expect(() => buildCodexPermissionOverrides(
        { ...job, repoPath: homedir() },
        { stateDir: state, artifactDir: outbox, scratchDir: scratch },
      )).toThrow('repository must not contain HOME')
      for (const writeEnabled of [false, true]) {
        expect(() => buildCodexPermissionOverrides(
          { ...job, repoPath: '/', writeEnabled },
          { stateDir: state, artifactDir: outbox, scratchDir: scratch },
        )).toThrow('repository must not contain HOME')
      }
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      store.close()
    }
  })

  test('偽の.git pointerは外部Git metadataを許可しない', () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const state = join(dir, 'state')
    const outbox = join(state, 'outbox/job')
    const scratch = join(state, 'tmp/job')
    mkdirSync(repo)
    mkdirSync(outbox, { recursive: true })
    chmodSync(state, 0o700)
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(repo, '.git'), `gitdir: ${state}\n`)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      expect(() => buildCodexPermissionOverrides(job, {
        stateDir: state,
        artifactDir: outbox,
        scratchDir: scratch,
      })).toThrow(/Git metadata|gitdir|worktree|submodule/)
    } finally {
      store.close()
    }
  })

  test('stateのoutbox/tmpがsymlinkならCodex write許可を生成しない', () => {
    const state = fixtureDir()
    const external = fixtureDir('zerokun-sandbox-external-')
    const repo = join(fixtureDir(), 'repo')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(external, 'job'))
    symlinkSync(external, join(state, 'outbox'))
    mkdirSync(join(state, 'tmp/job'), { recursive: true })
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('worker')!
    try {
      expect(() => buildCodexPermissionOverrides(job, {
        stateDir: state,
        artifactDir: join(state, 'outbox/job'),
        scratchDir: join(state, 'tmp/job'),
      })).toThrow('unsafe managed directory')
    } finally {
      store.close()
    }
  })

  test('正規linked worktreeの共通・個別Git metadataだけを許可する', () => {
    const dir = fixtureDir()
    const main = join(dir, 'main')
    const linked = join(dir, 'linked')
    const stale = join(dir, 'stale')
    const state = join(dir, 'state')
    const outbox = join(state, 'outbox/job')
    const scratch = join(state, 'tmp/job')
    git(['init', '--initial-branch=main', main])
    git(['config', 'user.email', 'test@example.com'], main)
    git(['config', 'user.name', 'test'], main)
    writeFileSync(join(main, 'tracked.txt'), 'tracked\n')
    git(['add', '.'], main)
    git(['commit', '-m', 'initial'], main)
    git(['worktree', 'add', '-b', 'linked', linked], main)
    git(['worktree', 'add', '-b', 'stale', stale], main)
    rmSync(stale, { recursive: true })
    mkdirSync(outbox, { recursive: true })
    chmodSync(state, 0o700)
    mkdirSync(scratch, { recursive: true })
    const metadata = resolveGitMetadataPaths(linked)
    const common = realpathSync(join(main, '.git'))
    expect(metadata).toHaveLength(2)
    expect(metadata).toContain(common)
    expect(metadata.some(path => path.startsWith(join(common, 'worktrees') + '/'))).toBe(true)

    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: linked, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      const overrides = buildCodexPermissionOverrides(job, {
        stateDir: state,
        artifactDir: outbox,
        scratchDir: scratch,
      }).join('\n')
      for (const path of metadata) expect(overrides).toContain(`${JSON.stringify(path)}="write"`)
      expect(overrides).toContain(`${JSON.stringify(realpathSync(join(linked, '.git')))}="read"`)
    } finally {
      store.close()
    }
  })

  test('正規submoduleのGit metadataだけを許可する', () => {
    const dir = fixtureDir()
    const child = join(dir, 'child')
    const parent = join(dir, 'parent')
    const state = join(dir, 'state')
    git(['init', '--initial-branch=main', child])
    git(['config', 'user.email', 'test@example.com'], child)
    git(['config', 'user.name', 'test'], child)
    writeFileSync(join(child, 'child.txt'), 'child\n')
    git(['add', '.'], child)
    git(['commit', '-m', 'child'], child)
    git(['init', '--initial-branch=main', parent])
    git(['config', 'user.email', 'test@example.com'], parent)
    git(['config', 'user.name', 'test'], parent)
    writeFileSync(join(parent, 'parent.txt'), 'parent\n')
    git(['add', '.'], parent)
    git(['commit', '-m', 'parent'], parent)
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'modules/child'], parent)
    git(['commit', '-am', 'add submodule'], parent)
    const submodule = join(parent, 'modules/child')
    const marker = join(dir, 'fsmonitor-executed')
    const helper = join(dir, 'fsmonitor.sh')
    writeFileSync(helper, `#!/bin/bash\ntouch '${marker}'\nexit 0\n`)
    chmodSync(helper, 0o700)
    git(['config', 'core.fsmonitor', helper], parent)
    const metadata = resolveGitMetadataPaths(submodule)
    expect(metadata).toEqual([realpathSync(join(parent, '.git/modules/modules/child'))])
    expect(existsSync(marker)).toBe(false)
  })

  test.skipIf(process.platform !== 'darwin')('実Codex sandboxでlinked worktreeとsubmoduleはcommit可、.git pointerはread-only', () => {
    const codex = Bun.spawnSync(['/usr/bin/which', 'codex'], { stdout: 'pipe' })
      .stdout.toString().trim()
    expect(codex).not.toBe('')

    const runSandboxCommit = (repo: string, state: string, messageId: string) => {
      const store = new JobStore(join(state, 'jobs.sqlite3'))
      try {
        store.enqueue(input({ repoPath: repo, messageId, writeEnabled: true }))
        const job = store.claimNext('serial-worker')!
        const outbox = artifactDirForJob(state, job.id)
        const scratch = join(state, 'tmp', job.id)
        mkdirSync(outbox, { recursive: true })
        mkdirSync(scratch, { recursive: true })
        const overrides = buildCodexPermissionOverrides(job, {
          stateDir: state, artifactDir: outbox, scratchDir: scratch,
        })
        const result = Bun.spawnSync([
          codex, 'sandbox', '-C', repo,
          ...overrides.flatMap(value => ['-c', value]),
          '-P', 'zerokun_job', '--', '/bin/zsh', '-c',
          [
            'set -e',
            'git status --short >/dev/null',
            "printf 'sandbox change\\n' >> sandbox-change.txt",
            'git add sandbox-change.txt',
            `git commit -m ${JSON.stringify(messageId)} >/dev/null`,
            "if /bin/sh -c 'printf bad > .git' 2>/dev/null; then exit 44; fi",
          ].join('; '),
        ], {
          env: {
            ...process.env,
            HOME: scratch,
            TMPDIR: scratch,
            XDG_CONFIG_HOME: join(scratch, '.config'),
            XDG_CACHE_HOME: join(scratch, '.cache'),
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        expect(git(['log', '-1', '--format=%s'], repo)).toBe(messageId)
        expect(readFileSync(join(repo, '.git'), 'utf8')).toStartWith('gitdir: ')
      } finally { store.close() }
    }

    const linkedBase = fixtureDir()
    const main = join(linkedBase, 'main')
    const linked = join(linkedBase, 'linked')
    git(['init', '--initial-branch=main', main])
    git(['config', 'user.email', 'test@example.com'], main)
    git(['config', 'user.name', 'test'], main)
    writeFileSync(join(main, 'initial.txt'), 'initial\n')
    git(['add', '.'], main)
    git(['commit', '-m', 'initial'], main)
    git(['worktree', 'add', '-b', 'linked', linked], main)
    runSandboxCommit(linked, join(linkedBase, 'state'), 'linked sandbox commit')

    const submoduleBase = fixtureDir()
    const child = join(submoduleBase, 'child')
    const parent = join(submoduleBase, 'parent')
    git(['init', '--initial-branch=main', child])
    git(['config', 'user.email', 'test@example.com'], child)
    git(['config', 'user.name', 'test'], child)
    writeFileSync(join(child, 'child.txt'), 'child\n')
    git(['add', '.'], child)
    git(['commit', '-m', 'child'], child)
    git(['init', '--initial-branch=main', parent])
    git(['config', 'user.email', 'test@example.com'], parent)
    git(['config', 'user.name', 'test'], parent)
    writeFileSync(join(parent, 'parent.txt'), 'parent\n')
    git(['add', '.'], parent)
    git(['commit', '-m', 'parent'], parent)
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'modules/child'], parent)
    git(['commit', '-am', 'add submodule'], parent)
    const submodule = join(parent, 'modules/child')
    git(['config', 'user.email', 'test@example.com'], submodule)
    git(['config', 'user.name', 'test'], submodule)
    runSandboxCommit(submodule, join(submoduleBase, 'state'), 'submodule sandbox commit')
  }, 30_000)

  test.skipIf(process.platform !== 'darwin')('実Codex 0.149 sandboxでstate deny・添付read・outbox/.git writeを強制する', () => {
    const codex = Bun.spawnSync(['/usr/bin/which', 'codex'], { stdout: 'pipe' })
      .stdout.toString().trim()
    expect(codex).not.toBe('')
    const dir = fixtureDir()
    const state = join(dir, 'state')
    const repo = join(dir, 'repo')
    const attachment = join(state, 'inbox', 'message', 'input.txt')
    const secret = join(state, '.env')
    mkdirSync(dirname(attachment), { recursive: true })
    chmodSync(state, 0o700)
    mkdirSync(repo, { recursive: true })
    Bun.spawnSync(['git', 'init', '-q', repo])
    writeFileSync(attachment, 'input')
    writeFileSync(secret, 'SLACK_BOT_TOKEN=must-not-read')
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    try {
      store.enqueue(input({ repoPath: repo, attachments: [attachment], writeEnabled: true }))
      const job = store.claimNext('serial-worker')!
      const outbox = artifactDirForJob(state, job.id)
      const scratch = join(state, 'tmp', job.id)
      mkdirSync(outbox, { recursive: true })
      mkdirSync(scratch, { recursive: true })
      const overrides = buildCodexPermissionOverrides(job, {
        stateDir: state,
        artifactDir: outbox,
        scratchDir: scratch,
      })
      const result = Bun.spawnSync([
        codex,
        'sandbox',
        '-C', repo,
        ...overrides.flatMap(value => ['-c', value]),
        '-P', 'zerokun_job',
        '--',
        '/bin/zsh', '-c',
        'test ! -r "$1" && test -r "$2" && touch "$3/from-sandbox" && touch .git/from-sandbox',
        'zerokun-sandbox', secret, attachment, outbox,
      ], { stdout: 'pipe', stderr: 'pipe' })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(readFileSync(join(outbox, 'from-sandbox'), 'utf8')).toBe('')
      expect(existsSync(join(repo, '.git/from-sandbox'))).toBe(true)

      const readOverrides = buildCodexPermissionOverrides({ ...job, writeEnabled: false }, {
        stateDir: state,
        artifactDir: outbox,
        scratchDir: scratch,
      })
      const readProfile = Bun.spawnSync([
        codex, 'sandbox', '-C', repo,
        ...readOverrides.flatMap(value => ['-c', value]),
        '-P', 'zerokun_job', '--', '/usr/bin/true',
      ], { stdout: 'pipe', stderr: 'pipe' })
      expect(readProfile.exitCode, readProfile.stderr.toString()).toBe(0)

      const rootArgs = [
        codex, '-a', 'never', '-C', repo,
        ...overrides.flatMap(value => ['-c', value]),
        '-c', 'developer_instructions="contract test"',
        'exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
        '--json', '--output-last-message', join(state, 'parser-output.txt'),
      ]
      const newHelp = Bun.spawnSync([...rootArgs, '--help'], { stdout: 'pipe', stderr: 'pipe' })
      const resumeHelp = Bun.spawnSync([...rootArgs, 'resume', '--help'], {
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(newHelp.exitCode, newHelp.stderr.toString()).toBe(0)
      expect(resumeHelp.exitCode, resumeHelp.stderr.toString()).toBe(0)
      expect(resumeHelp.stdout.toString()).toContain('Resume a previous session')
    } finally {
      store.close()
    }
  })
})

describe('Slack output guard', () => {
  test('最終文のartifact markerを分離する', () => {
    expect(extractArtifactPaths('完了\n<zerokun_files>["/tmp/a.csv"]</zerokun_files>')).toEqual({
      text: '完了',
      files: ['/tmp/a.csv'],
    })
  })

  test('想定外の巨大結果でもSlack 5通を超えない', () => {
    const chunks = splitSlackChunks('x'.repeat(100_000))
    expect(chunks.length).toBeLessThanOrEqual(5)
    expect(chunks.join('')).toContain('長すぎるため')
  })

  test('job専用outboxをsealし、その直下のregular fileだけを上限付きで読める', () => {
    const dir = fixtureDir()
    const state = join(dir, 'state')
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    const outbox = artifactDirForJob(state, job.id)
    mkdirSync(outbox, { recursive: true })
    const good = join(outbox, 'report.txt')
    const secret = join(dir, 'secret.txt')
    const escaped = join(outbox, 'escaped.txt')
    const hardlink = join(outbox, 'hardlink.txt')
    const fifo = join(outbox, 'pipe')
    writeFileSync(good, 'safe report')
    writeFileSync(secret, 'secret')
    symlinkSync(secret, escaped)
    linkSync(secret, hardlink)
    Bun.spawnSync(['/usr/bin/mkfifo', fifo])
    try {
      const sealedResult = sealArtifactResult(
        job,
        `完了\n<zerokun_files>${JSON.stringify([good])}</zerokun_files>`,
        state,
      )
      const [sealed] = extractArtifactPaths(sealedResult).files
      const uploaded = readUploadableArtifact(job, sealed!, state)
      expect(uploaded.data.toString()).toBe('safe report')
      expect(uploaded.filename).toBe('report.txt')
      expect(() => readUploadableArtifact(job, secret, state)).toThrow('outside')
      expect(() => sealArtifactResult(
        job,
        `<zerokun_files>${JSON.stringify([escaped])}</zerokun_files>`,
        state,
      )).toThrow('regular file')
      expect(() => sealArtifactResult(
        job,
        `<zerokun_files>${JSON.stringify([fifo])}</zerokun_files>`,
        state,
      )).toThrow('regular file')
      expect(() => sealArtifactResult(
        job,
        `<zerokun_files>${JSON.stringify([hardlink])}</zerokun_files>`,
        state,
      )).toThrow('multiple hard links')
    } finally {
      store.close()
    }
  })

  test('write成功後のartifact封印失敗をjob失敗にせず添付だけ省略する', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    const job = store.enqueue(input({ repoPath: repo, writeEnabled: true })).job
    const outbox = artifactDirForJob(state, job.id)
    mkdirSync(outbox, { recursive: true })
    const outside = join(state, 'not-allowed.txt')
    writeFileSync(outside, 'secret')
    const result = finalizeSuccessfulExecution(job, {
      sessionId: 'successful-write-session',
      result: `変更は完了しました。\n<zerokun_files>[${JSON.stringify(outside)}]</zerokun_files>`,
    }, state)
    expect(result.sessionId).toBe('successful-write-session')
    expect(result.result).toContain('変更は完了しました。')
    expect(result.result).toContain('ファイル添付だけを省略しました')
    expect(extractArtifactPaths(result.result).files).toEqual([])
    store.close()
  })

  test('artifact seal後・DB complete前に落ちても決定的sealed copyから回復する', () => {
    const dir = fixtureDir()
    const state = join(dir, 'state')
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const firstAttempt = store.claimNext('serial-worker')!
    const outbox = artifactDirForJob(state, firstAttempt.id)
    mkdirSync(outbox, { recursive: true })
    const source = join(outbox, 'report.txt')
    writeFileSync(source, 'recoverable report')
    const rawResult = `完了\n<zerokun_files>${JSON.stringify([source])}</zerokun_files>`
    try {
      const firstSealed = sealArtifactResult(firstAttempt, rawResult, state)
      const [sealedPath] = extractArtifactPaths(firstSealed).files

      // Simulate a crash before complete(): the DB requeues the running job.
      expect(store.recoverInterrupted()).toEqual({ requeued: 1, failedWrites: 0 })
      const retried = store.claimNext('serial-worker')!
      rmSync(source)

      const recovered = sealArtifactResult(retried, rawResult, state)
      expect(extractArtifactPaths(recovered).files).toEqual([sealedPath])
      expect(readUploadableArtifact(retried, sealedPath!, state).data.toString()).toBe(
        'recoverable report',
      )
    } finally {
      store.close()
    }
  })

  test('resume後に同名artifactが更新された場合は新しい内容をsealする', () => {
    const dir = fixtureDir()
    const state = join(dir, 'state')
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    const outbox = artifactDirForJob(state, job.id)
    mkdirSync(outbox, { recursive: true })
    const source = join(outbox, 'report.txt')
    const result = `完了\n<zerokun_files>${JSON.stringify([source])}</zerokun_files>`
    try {
      writeFileSync(source, 'version X')
      const first = extractArtifactPaths(sealArtifactResult(job, result, state)).files[0]!
      writeFileSync(source, 'version Y')
      const second = extractArtifactPaths(sealArtifactResult(job, result, state)).files[0]!

      expect(second).not.toBe(first)
      expect(readUploadableArtifact(job, second, state).data.toString()).toBe('version Y')
    } finally {
      store.close()
    }
  })
})

describe('durable terminal notifications', () => {
  test('Slack通知がhangしても後続jobのclaimと実行を止めない', async () => {
    const store = makeStore()
    store.enqueue(input({ messageId: 'hang-notification' }))
    store.enqueue(input({ messageId: 'next-job' }))
    const executed: string[] = []
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async job => {
        executed.push(job.messageId)
        return { sessionId: `session-${job.messageId}`, result: 'done' }
      },
      notifier: {
        completed: async job => {
          if (job.messageId === 'hang-notification') await new Promise<void>(() => {})
        },
      },
    })
    expect(stats.completed).toBe(2)
    expect(executed).toEqual(['hang-notification', 'next-job'])
    store.close()
  })

  test('1件の永久通知失敗が後続のterminal resultを止めない', async () => {
    const store = makeStore()
    const first = store.enqueue(input({ messageId: 'poison' })).job
    const firstRunning = store.claimNext('serial-worker')!
    store.complete(firstRunning.id, 'thread-poison', 'missing artifact')
    const second = store.enqueue(input({ messageId: 'healthy' })).job
    const secondRunning = store.claimNext('serial-worker')!
    store.complete(secondRunning.id, 'thread-healthy', 'healthy result')
    const delivered: string[] = []

    await flushTerminalNotifications(store, {
      completed: async (job) => {
        if (job.id === first.id) throw new Error('artifact is missing')
        delivered.push(job.id)
      },
    }, () => {}, 60_000)

    expect(delivered).toEqual([second.id])
    expect(store.terminalNotificationCount()).toBe(1)
    expect(store.pendingTerminalNotifications()).toHaveLength(0)
    store.close()
  })

  test('Slack失敗後もDBへ残り、daemon再開相当のflushで再送する', async () => {
    const dir = fixtureDir()
    const dbPath = join(dir, 'jobs.sqlite3')
    let store = new JobStore(dbPath)
    store.enqueue(input())
    const job = store.claimNext('serial-worker')!
    store.complete(job.id, 'thread-1', 'done')
    expect(store.terminalNotificationCount()).toBe(1)
    let attempts = 0
    await flushTerminalNotifications(store, {
      completed: async () => {
        attempts += 1
        throw new Error('Slack 503')
      },
    }, () => {}, 1)
    expect(store.terminalNotificationCount()).toBe(1)
    store.close()

    await Bun.sleep(5)
    store = new JobStore(dbPath)
    await flushTerminalNotifications(store, {
      completed: async (_job, result) => {
        attempts += 1
        expect(result).toBe('done')
      },
    }, () => {}, 1)
    expect(attempts).toBe(2)
    expect(store.terminalNotificationCount()).toBe(0)
    store.close()
  })

  test('成果物単位のdelivery checkpointで再送時の重複uploadを防ぐ', () => {
    const store = makeStore()
    const queued = store.enqueue(input()).job
    const job = store.claimNext('serial-worker')!
    const artifact = '/tmp/sealed/report.txt'
    store.complete(
      job.id,
      'thread-1',
      `done\n<zerokun_files>${JSON.stringify([artifact])}</zerokun_files>`,
    )
    expect(store.artifactDelivered(queued.id, artifact)).toBe(false)
    store.markArtifactDelivered(queued.id, artifact)
    expect(store.artifactDelivered(queued.id, artifact)).toBe(true)
    store.close()
  })
})
