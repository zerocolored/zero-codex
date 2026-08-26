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
  readdirSync,
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
  ArtifactDeliveryAmbiguousError,
  ArtifactPublicationBlockedError,
  classifyExecutorCommandProbe,
  classifyFallbackProcessState,
  CodexResultPersistencePendingError,
  configuredMaxJobsPerSession,
  DEFAULT_MAX_JOBS_PER_SESSION,
  JobStore,
  liveControlAcceptsInput,
  SERIAL_WORKER_COUNT,
  createSlackIdentityPauseGuard,
  extractArtifactPaths,
  flushTerminalNotifications,
  finalizeSuccessfulExecution,
  persistExecutionResultJournal,
  readUploadableArtifact,
  recoverExecutionCheckpointBeforeClaudeClear,
  recoverExecutionResultJournals,
  reconcileClaudeWithMonitorHealthBarrier,
  runQueuedJobs,
  sealArtifactResult,
  SlackNotifier,
  slackArtifactPublicationBlockedMessage,
  slackArtifactsAbandonedMessage,
  slackFileIsSharedInThread,
  slackRateLimitMessage,
  stateSlackTokenPairMatches,
  terminateTrackedExecutors,
  updateIsRunning,
  updateTransactionPending,
  splitSlackChunks,
  type EnqueueInput,
  type JobRecord,
} from './job-runner.ts'

import {
  CODEX_WORKER_SAFETY_PROMPT,
  CodexCleanupPendingError,
  CodexInterruptedError,
  CodexUserCancelledError,
  codexAttemptDisposition,
  codexRateLimitResumeAt,
  CodexRateLimitError,
  artifactDirForJob,
  buildCodexChildEnvironment,
  assertCodexChatGptSubscriptionLogin,
  buildCodexTrustArguments,
  assertCompatibleSystemCodexConfig,
  buildCodexDeveloperInstructions,
  buildCodexPhasePrompt,
  buildCodexPermissionOverrides,
  buildCodexWorkerPrompt,
  codexThreadIdFromEvent,
  executeCodexJob,
  extractCodexRateLimit,
  assertRequiredAdvisorRounds,
  parseCodexResult,
  parseCodexReviewDecision,
  requiredAdvisorRoundsForJob,
  resolveCodexExecutable,
  resolveGitMetadataPaths,
} from './codex-executor.ts'
import {
  capRuntimeLogs,
  removeOrphanedJobState,
  removeSettledJobState,
} from './state-maintenance.ts'
import { tryAcquireProcessLock } from './process-lock.ts'
import { slackTokenPairRuntimeIdentity } from './slack-app-identity.ts'
import { readProcessIdentity } from './process-tree.ts'
import { resolveOfficialStandaloneCodex } from './standalone-codex.ts'
import {
  observeProcessGeneration,
  processStartKey,
  signalProcessGroupIfLeaderLive,
  signalProcessIfLive,
} from './process-generation.ts'
import { ClaudeContextClearPendingError } from './claude-queue-boundary.ts'
import { HerdrJobMonitorPendingError } from './herdr-job-monitor.ts'
import { createSeatbeltFingerprint } from './seatbelt-fingerprint.ts'
import { readAdvisorInputSnapshot } from './advisor-input.ts'

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureDir(prefix = 'zerokun-codex-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirs.push(dir)
  return dir
}

function secureFixtureDir(prefix = '.zerokun-codex-test-'): string {
  const dir = mkdtempSync(join(homedir(), prefix))
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

describe('host-enforced App Server permission phases', () => {
  test('pre-edit terminal後も同じthreadを開いたままphase receiptでwrite turnを一度だけ束縛する', () => {
    const store = makeStore()
    store.enqueue(input({ writeEnabled: true, messageId: 'phase-root' }))
    const job = store.claimNext('phase-worker')!
    const snapshot = readAdvisorInputSnapshot(dirname(store.dbPath), job.id)
    expect(store.beginInitialTurnDispatch({
      jobId: job.id,
      attempt: job.attempts,
      epoch: job.controlEpoch,
      executorNonce: 'logical-phase-nonce',
      threadId: 'thread-phase',
      requestId: 1,
      inputRevision: snapshot.revision,
      inputDigest: snapshot.digest,
    })).toBe('dispatching')
    store.acknowledgeInitialTurnDispatch({
      jobId: job.id,
      workerId: job.workerId!,
      attempt: job.attempts,
      epoch: job.controlEpoch,
      executorNonce: 'logical-phase-nonce',
      threadId: 'thread-phase',
      turnId: 'turn-prepare',
      requestId: 1,
    })
    expect(store.finishAppServerTurn({
      jobId: job.id,
      epoch: job.controlEpoch,
      executorNonce: 'logical-phase-nonce',
      threadId: 'thread-phase',
      turnId: 'turn-prepare',
      retainInput: true,
    })).toEqual({ closeInput: false, cancelled: false, pending: 0, pendingInbound: 0 })
    expect(store.get(job.id)).toMatchObject({
      acceptsControl: true,
      activeThreadId: 'thread-phase',
      activeTurnId: null,
    })

    const clientId = store.prepareAppServerPhaseDispatch({
      jobId: job.id,
      attempt: job.attempts,
      epoch: job.controlEpoch,
      phaseSequence: 1,
      stage: 'implementation',
      logicalNonce: 'logical-phase-nonce',
      threadId: 'thread-phase',
      inputRevision: snapshot.revision,
      inputDigest: snapshot.digest,
    })
    expect(clientId).toBe(`${job.id}:phase:1`)
    expect(store.beginAppServerPhaseDispatch({
      jobId: job.id,
      attempt: job.attempts,
      epoch: job.controlEpoch,
      phaseSequence: 1,
      logicalNonce: 'logical-phase-nonce',
      threadId: 'thread-phase',
      requestId: 2,
      inputRevision: snapshot.revision,
      inputDigest: snapshot.digest,
    })).toBe('dispatching')
    store.acknowledgeAppServerPhaseDispatch({
      jobId: job.id,
      workerId: job.workerId!,
      attempt: job.attempts,
      epoch: job.controlEpoch,
      phaseSequence: 1,
      logicalNonce: 'logical-phase-nonce',
      threadId: 'thread-phase',
      turnId: 'turn-implementation',
      requestId: 2,
    })
    expect(store.finishAppServerTurn({
      jobId: job.id,
      epoch: job.controlEpoch,
      executorNonce: 'logical-phase-nonce',
      threadId: 'thread-phase',
      turnId: 'turn-implementation',
      retainInput: true,
    })).toEqual({ closeInput: false, cancelled: false, pending: 0, pendingInbound: 0 })
    expect(store.sealAppServerPhaseResult({
      jobId: job.id,
      epoch: job.controlEpoch,
      logicalNonce: 'logical-phase-nonce',
      threadId: 'thread-phase',
      inputRevision: snapshot.revision,
      inputDigest: snapshot.digest,
    })).toBe('sealed')
    expect(store.get(job.id)?.acceptsControl).toBe(false)
    store.close()
  })

  test('phase切替窓のinboundと中止をwrite requestより先に検出する', () => {
    const store = makeStore()
    store.enqueue(input({ writeEnabled: true, messageId: 'phase-race-root' }))
    const job = store.claimNext('phase-race-worker')!
    const snapshot = readAdvisorInputSnapshot(dirname(store.dbPath), job.id)
    store.beginInitialTurnDispatch({
      jobId: job.id, attempt: job.attempts, epoch: job.controlEpoch,
      executorNonce: 'logical-race', threadId: 'thread-race', requestId: 1,
      inputRevision: snapshot.revision, inputDigest: snapshot.digest,
    })
    store.acknowledgeInitialTurnDispatch({
      jobId: job.id, workerId: job.workerId!, attempt: job.attempts,
      epoch: job.controlEpoch, executorNonce: 'logical-race', threadId: 'thread-race',
      turnId: 'turn-race-prepare', requestId: 1,
    })
    store.finishAppServerTurn({
      jobId: job.id, epoch: job.controlEpoch, executorNonce: 'logical-race',
      threadId: 'thread-race', turnId: 'turn-race-prepare', retainInput: true,
    })
    store.prepareAppServerPhaseDispatch({
      jobId: job.id, attempt: job.attempts, epoch: job.controlEpoch,
      phaseSequence: 1, stage: 'implementation', logicalNonce: 'logical-race',
      threadId: 'thread-race', inputRevision: snapshot.revision, inputDigest: snapshot.digest,
    })
    store.stageInboundDelivery({
      chatId: job.chatId, threadTs: job.threadTs, messageId: 'gap-inbound',
      userId: 'UOTHER', repoPath: job.repoPath, text: '切替窓の追記', writeEnabled: false,
    })
    expect(store.beginAppServerPhaseDispatch({
      jobId: job.id, attempt: job.attempts, epoch: job.controlEpoch,
      phaseSequence: 1, logicalNonce: 'logical-race', threadId: 'thread-race',
      requestId: 2, inputRevision: snapshot.revision, inputDigest: snapshot.digest,
    })).toBe('pending-inbound')
    store.completeInboundDelivery(`${job.chatId}:gap-inbound`)
    const target = store.liveControlTarget(job.chatId, job.threadTs)!
    store.stageLiveControl(target, {
      chatId: job.chatId, threadTs: job.threadTs, messageId: 'gap-stop',
      userId: 'UOTHER', task: '中止', kind: 'interrupt',
    })
    expect(store.prepareAppServerPhaseDispatch({
      jobId: job.id, attempt: job.attempts, epoch: job.controlEpoch,
      phaseSequence: 1, stage: 'implementation', logicalNonce: 'logical-race',
      threadId: 'thread-race', inputRevision: snapshot.revision, inputDigest: snapshot.digest,
    })).toBe('cancelled')
    store.close()
  })

  test('reviewのhost envelopeはexact markerと本文を要求する', () => {
    const nonce = 'a'.repeat(32)
    expect(parseCodexReviewDecision(
      `[ZERO_REVIEW_PUBLISH:${nonce}:round-1]\n公開できます`, nonce, 1,
    )).toEqual({ decision: 'publish', body: '公開できます' })
    expect(() => parseCodexReviewDecision('公開できます', nonce, 1))
      .toThrow('exact host decision envelope')
    expect(() => parseCodexReviewDecision(
      `[ZERO_REVIEW_FIX_REQUIRED:${nonce}:round-1]`, nonce, 1,
    )).toThrow('exact host decision envelope')
  })
})

describe('Codex job store', () => {
  test('session job上限は設定値にかかわらず20を超えない', () => {
    expect(configuredMaxJobsPerSession(undefined)).toBe(20)
    expect(configuredMaxJobsPerSession('5')).toBe(5)
    expect(configuredMaxJobsPerSession('20')).toBe(20)
    expect(configuredMaxJobsPerSession('21')).toBe(20)
    expect(configuredMaxJobsPerSession('invalid')).toBe(20)
  })

  test('別DB connectionから同時claimしてもrunning Codexは常に1件だけ', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    const firstStore = new JobStore(path)
    firstStore.enqueue(input({ messageId: 'first' }))
    firstStore.enqueue(input({ messageId: 'second' }))
    const secondStore = new JobStore(path)
    try {
      const first = firstStore.claimNext('worker-a')!
      expect(first.messageId).toBe('first')
      expect(secondStore.claimNext('worker-b')).toBeNull()
      firstStore.complete(first.id, 'session-1', 'done')
      expect(secondStore.claimNext('worker-b')?.messageId).toBe('second')
    } finally {
      secondStore.close()
      firstStore.close()
    }
  })

  test('executor command probe失敗や空出力をstaleではなくunknownにする', () => {
    expect(classifyExecutorCommandProbe(1, '')).toEqual({ status: 'unknown' })
    expect(classifyExecutorCommandProbe(0, '   ')).toEqual({ status: 'unknown' })
    expect(classifyExecutorCommandProbe(0, 'codex-supervisor job-1\n')).toEqual({
      status: 'known', command: 'codex-supervisor job-1',
    })
  })

  test('常駐runnerは選択stateのSlack App ID変更と不正設定を検出する', () => {
    const dir = fixtureDir()
    const envFile = join(dir, '.env')
    writeFileSync(envFile, [
      'SLACK_BOT_TOKEN=xoxb-runner-test-token-12345',
      'SLACK_APP_TOKEN=xapp-1-AOLDAPP123-runner-test-token-12345',
      '',
    ].join('\n'), { mode: 0o600 })
    const runtimeId = slackTokenPairRuntimeIdentity(
      'xoxb-runner-test-token-12345',
      'xapp-1-AOLDAPP123-runner-test-token-12345',
    )
    expect(stateSlackTokenPairMatches(dir, runtimeId)).toBe(true)
    expect(stateSlackTokenPairMatches(dir, `${runtimeId}-different`)).toBe(false)
    writeFileSync(envFile, 'SLACK_APP_TOKEN=malformed\n', { mode: 0o600 })
    expect(stateSlackTokenPairMatches(dir, runtimeId)).toBe(false)
  })

  test('常駐runnerはstateのSlack App変更後に新規claimせず終了する', () => {
    const dir = fixtureDir()
    const envFile = join(dir, '.env')
    writeFileSync(envFile, [
      'SLACK_BOT_TOKEN=xoxb-runner-test-token-12345',
      'SLACK_APP_TOKEN=xapp-1-AOLDAPP123-runner-test-token-12345',
      '',
    ].join('\n'), { mode: 0o600 })
    const oldRuntimeId = slackTokenPairRuntimeIdentity(
      'xoxb-runner-test-token-12345',
      'xapp-1-AOLDAPP123-runner-test-token-12345',
    )
    const controller = new AbortController()
    const logs: string[] = []
    const shouldPause = createSlackIdentityPauseGuard(
      dir, oldRuntimeId, controller, message => logs.push(message),
    )
    expect(shouldPause()).toBe(false)
    writeFileSync(envFile, [
      'SLACK_BOT_TOKEN=xoxb-runner-test-token-67890',
      'SLACK_APP_TOKEN=xapp-1-AOLDAPP123-runner-test-token-12345',
      '',
    ].join('\n'), { mode: 0o600 })
    expect(shouldPause()).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(logs).toEqual([
      'selected Slack App changed; stopping this runner before claiming more work',
    ])
    expect(shouldPause()).toBe(true)
    expect(logs).toHaveLength(1)
  })

  test('daemon lock用Herdr複合IDをSlack token変更guardへ渡さない契約を維持する', () => {
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    expect(runner).toContain('let slackRuntimeId: string | undefined')
    expect(runner).toContain('runnerRuntimeId = `${slackRuntimeId}:${pinnedHerdrId}`')
    expect(runner).toContain('dir, slackRuntimeId, controller, log,')
    expect(runner).not.toContain('dir, runnerRuntimeId, controller, log,')

    const dir = fixtureDir()
    const controller = new AbortController()
    const shouldPauseWithoutSlack = createSlackIdentityPauseGuard(
      dir, undefined, controller, () => {},
    )
    expect(shouldPauseWithoutSlack()).toBe(false)
    expect(controller.signal.aborted).toBe(false)
  })

  test('既存auto_vacuum=NONE DBを停止中migrationでINCREMENTALへ変換する', () => {
    const dir = fixtureDir()
    const dbPath = join(dir, 'jobs.sqlite3')
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

  test('実行中threadの返信は別threadのretry待ちを越え、中止だけは同thread内も最優先する', () => {
    const store = makeStore()
    const root = store.enqueue(input({ messageId: 'active-root' })).job
    store.claimNext('serial-worker')

    expect(store.stageInboundDelivery({
      ...input({
        chatId: 'C-DIFFERENT', threadTs: 'different-thread', messageId: 'blocked-head',
      }),
      text: '別threadの添付',
      fileIds: ['F-BLOCKED'],
    })).toBe(true)
    const blocked = store.claimNextInboundDelivery(1_000)!
    store.deferInboundDelivery(blocked.idempotencyKey, 'Slack 503', 10_000)

    expect(store.stageInboundDelivery({
      ...input({ messageId: 'ordinary-steer' }),
      chatId: root.chatId,
      threadTs: root.threadTs,
      text: '通常の追加入力',
    })).toBe(true)
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'urgent-stop' }),
      chatId: root.chatId,
      threadTs: root.threadTs,
      text: '中止',
      isInterrupt: true,
    })).toBe(true)

    const interrupt = store.claimNextInboundDelivery(2_000)!
    expect(interrupt).toMatchObject({ text: '中止', isInterrupt: true })
    store.completeInboundDelivery(interrupt.idempotencyKey)
    const steer = store.claimNextInboundDelivery(2_000)!
    expect(steer).toMatchObject({ text: '通常の追加入力', isInterrupt: false })
    store.completeInboundDelivery(steer.idempotencyKey)
    expect(store.claimNextInboundDelivery(2_000)).toBeNull()
    expect(store.claimNextInboundDelivery(10_000)?.text).toBe('別threadの添付')
    store.close()
  })

  test('active-thread権限をexact job/epochへ固定しpreempt releaseでもattemptを消費しない', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    let store = new JobStore(path)
    const root = store.enqueue(input({ messageId: 'authority-root' })).job
    store.claimNext('serial-worker')
    const target = store.liveControlTarget(root.chatId, root.threadTs)!
    expect(store.stageInboundDeliveryForControl({
      ...input({ messageId: 'authority-reply', userId: 'U0OTHER1' }),
      chatId: root.chatId,
      threadTs: root.threadTs,
      text: '同じスレッドの追記',
      fileIds: ['FCACHED123'],
    }, target)).toBe('bound')
    store.close()

    store = new JobStore(path)
    const claimed = store.claimNextInboundDelivery()!
    expect(claimed).toMatchObject({
      expectedControlJobId: root.id,
      expectedControlEpoch: target.epoch,
      attempts: 0,
    })
    store.recordInboundDownloadedFile(claimed.idempotencyKey, {
      fileId: 'FCACHED123',
      ordinal: 0,
      path: join(dir, 'inbox/authority-reply/FCACHED123.bin'),
      size: 4,
      digest: 'a'.repeat(64),
    })
    expect(store.releaseInboundDelivery(claimed.idempotencyKey)).toBe(true)
    const reclaimed = store.claimNextInboundDelivery()!
    expect(reclaimed).toMatchObject({
      expectedControlJobId: root.id,
      expectedControlEpoch: target.epoch,
      attempts: 0,
      downloadedFiles: [{
        fileId: 'FCACHED123',
        ordinal: 0,
        path: join(dir, 'inbox/authority-reply/FCACHED123.bin'),
        size: 4,
        digest: 'a'.repeat(64),
      }],
    })
    store.completeInboundDelivery(reclaimed.idempotencyKey)
    store.close()
  })

  test('active-thread権限が先に閉じた返信を新規FIFO jobへ昇格させない', () => {
    const store = makeStore()
    const root = store.enqueue(input({ messageId: 'authority-race-root' })).job
    store.claimNext('serial-worker')
    const staleTarget = store.liveControlTarget(root.chatId, root.threadTs)!
    const successor = store.enqueue(input({
      messageId: 'authority-race-successor',
      task: '同じthreadの後続job',
    })).job
    store.complete(root.id, 'completed-session', 'done')

    const restrictedReply = {
      ...input({ messageId: 'authority-race-reply', userId: 'U0OTHER1' }),
      chatId: root.chatId,
      threadTs: root.threadTs,
      text: 'active中だけ許可された返信',
    }
    expect(store.stageInboundDeliveryForControl(
      restrictedReply,
      staleTarget,
    )).toBe('authority-closed')
    expect(store.inboundDeliveryCount()).toBe(0)
    expect(store.hasDurableEvent(`${root.chatId}:${restrictedReply.messageId}`)).toBe(true)
    expect(store.list()).toHaveLength(2)
    expect(store.get(successor.id)).toMatchObject({ status: 'queued', cancelRequestedAt: null })
    expect(store.listJobControls(successor.id)).toEqual([])

    store.close()
  })

  test('先行steerを追い越した中止は対象入力をtombstone化して新規job復活を防ぐ', () => {
    const store = makeStore()
    const root = store.enqueue(input({ messageId: 'interrupt-race-root' })).job
    store.claimNext('serial-worker')
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'older-authorized-steer' }),
      chatId: root.chatId,
      threadTs: root.threadTs,
      text: '中止より前の追加入力',
    })).toBe(true)
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'later-interrupt' }),
      chatId: root.chatId,
      threadTs: root.threadTs,
      text: '中止',
      isInterrupt: true,
    })).toBe(true)

    const interrupt = store.claimNextInboundDelivery()!
    expect(interrupt).toMatchObject({ messageId: 'later-interrupt', isInterrupt: true })
    const target = store.liveControlTarget(root.chatId, root.threadTs)!
    expect(store.stageLiveControl(target, {
      chatId: interrupt.chatId,
      threadTs: interrupt.threadTs,
      messageId: interrupt.messageId,
      userId: interrupt.userId,
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')
    store.completeInboundDelivery(interrupt.idempotencyKey)

    expect(store.inboundDeliveryCount()).toBe(0)
    expect(store.claimNextInboundDelivery()).toBeNull()
    expect(store.hasDurableEvent(`${root.chatId}:older-authorized-steer`)).toBe(true)
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'older-authorized-steer' }),
      chatId: root.chatId,
      threadTs: root.threadTs,
      text: '再配信',
    })).toBe(false)
    store.close()
  })

  test('同一threadの別sender追記も後続中止が追い越してtombstone化する', () => {
    const store = makeStore()
    const root = store.enqueue(input({
      messageId: 'write-interrupt-root', writeEnabled: true,
    })).job
    store.claimNext('serial-worker')
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'read-only-reply-before-stop' }),
      chatId: root.chatId,
      threadTs: root.threadTs,
      text: 'read-only userの返信',
      writeEnabled: false,
    })).toBe(true)
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'write-job-stop' }),
      chatId: root.chatId,
      threadTs: root.threadTs,
      text: '中止',
      isInterrupt: true,
    })).toBe(true)

    const interrupt = store.claimNextInboundDelivery()!
    const target = store.liveControlTarget(root.chatId, root.threadTs)!
    expect(store.stageLiveControl(target, {
      chatId: interrupt.chatId,
      threadTs: interrupt.threadTs,
      messageId: interrupt.messageId,
      userId: interrupt.userId,
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')
    store.completeInboundDelivery(interrupt.idempotencyKey)
    expect(store.claimNextInboundDelivery()).toBeNull()
    expect(store.hasDurableEvent(`${root.chatId}:read-only-reply-before-stop`)).toBe(true)
    store.close()
  })

  test('write job中の同一thread返信は別senderのread-only判定でも即時controlを優先する', () => {
    const store = makeStore()
    const root = store.enqueue(input({
      messageId: 'delegated-write-root', userId: 'U_WRITER', writeEnabled: true,
    })).job
    store.claimNext('serial-worker')
    expect(store.stageInboundDelivery({
      ...input({
        messageId: 'delegated-read-reply', userId: 'U_OTHER', writeEnabled: false,
      }),
      chatId: root.chatId,
      threadTs: root.threadTs,
      text: '同じスレッドから方針を変更',
    })).toBe(true)

    const inbound = store.claimNextInboundDelivery()!
    expect(inbound).toMatchObject({
      messageId: 'delegated-read-reply', userId: 'U_OTHER', writeEnabled: false,
    })
    const target = store.liveControlTarget(root.chatId, root.threadTs)!
    expect(target.writeEnabled).toBe(true)
    expect(liveControlAcceptsInput(target, {
      repoPath: inbound.repoPath,
      writeEnabled: inbound.writeEnabled,
      interrupt: false,
    })).toBe(true)
    expect(store.stageLiveControl(target, {
      chatId: inbound.chatId,
      threadTs: inbound.threadTs,
      messageId: inbound.messageId,
      userId: inbound.userId,
      task: inbound.text,
      kind: 'steer',
    })).toBe('staged')
    store.completeInboundDelivery(inbound.idempotencyKey)
    expect(store.list()).toHaveLength(1)
    expect(store.listJobControls(root.id)[0]).toMatchObject({
      userId: 'U_OTHER', kind: 'steer', status: 'ready',
    })
    store.close()
  })

  test('upgrade前pending exact中止をmigrationでinterruptへ再分類する', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    let store = new JobStore(path)
    const root = store.enqueue(input({ messageId: 'legacy-interrupt-root' })).job
    store.claimNext('serial-worker')
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'legacy-pending-stop' }),
      chatId: root.chatId,
      threadTs: root.threadTs,
      text: '中止',
      isInterrupt: false,
    })).toBe(true)
    store.close()

    const legacy = new Database(path)
    legacy.run(
      "DELETE FROM migration_ledger WHERE name = 'inbound-interrupt-classification-v1'",
    )
    legacy.exec('ALTER TABLE inbound_deliveries DROP COLUMN is_interrupt')
    legacy.close()

    store = new JobStore(path)
    const migrated = store.claimNextInboundDelivery()!
    expect(migrated).toMatchObject({
      messageId: 'legacy-pending-stop', isInterrupt: true,
    })
    const target = store.liveControlTarget(root.chatId, root.threadTs)!
    expect(store.stageLiveControl(target, {
      chatId: migrated.chatId,
      threadTs: migrated.threadTs,
      messageId: migrated.messageId,
      userId: migrated.userId,
      task: '中止',
      kind: migrated.isInterrupt ? 'interrupt' : 'steer',
    })).toBe('staged')
    expect(store.get(root.id)?.cancelRequestedAt).not.toBeNull()
    expect(store.listJobControls(root.id)[0]?.kind).toBe('interrupt')
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

  test('実行対象がないexact中止はtombstone化しSocket再配信で再採択しない', () => {
    const store = makeStore()
    const delivery = {
      ...input({ messageId: 'inactive-interrupt-redelivery', writeEnabled: false }),
      text: '中止',
      isInterrupt: true,
    }
    expect(store.stageInboundDelivery(delivery)).toBe(true)
    const claimed = store.claimNextInboundDelivery()!
    expect(claimed).toMatchObject({ isInterrupt: true, text: '中止' })
    expect(store.liveControlTarget(claimed.chatId, claimed.threadTs)).toBeNull()
    store.tombstoneInboundDelivery(claimed.idempotencyKey)
    expect(store.inboundDeliveryCount()).toBe(0)
    expect(store.hasDurableEvent(claimed.idempotencyKey)).toBe(true)
    expect(store.stageInboundDelivery(delivery)).toBe(false)
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
    for (const root of ['final-output', 'advisor-runtime', 'advisor-context', 'advisor-journal']) {
      const path = join(state, root, removable.id)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'evidence'), root)
    }
    mkdirSync(join(state, 'job-logs'), { recursive: true })
    writeFileSync(join(state, 'job-logs', `${removable.id}.stdout.log`), 'old log')
    for (const phase of ['1-prepare.stdout.log', '1-implementation.stderr.log', '1-review-3.stdout.log']) {
      writeFileSync(join(state, 'job-logs', `${removable.id}.${phase}`), phase)
    }

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
    for (const root of ['final-output', 'advisor-runtime', 'advisor-context', 'advisor-journal']) {
      expect(existsSync(join(state, root, removable.id))).toBe(false)
    }
    expect(existsSync(join(state, 'job-logs', `${removable.id}.stdout.log`))).toBe(false)
    for (const phase of ['1-prepare.stdout.log', '1-implementation.stderr.log', '1-review-3.stdout.log']) {
      expect(existsSync(join(state, 'job-logs', `${removable.id}.${phase}`))).toBe(false)
    }
    expect(store.stageInboundDelivery({
      ...input({ messageId: 'old' }),
      text: 'redelivery',
    })).toBe(false)
    store.close()
  })

  test('orphan GCはactive jobのphase logを保持し孤立phase logだけ削除する', () => {
    const state = fixtureDir()
    const logs = join(state, 'job-logs')
    mkdirSync(logs, { recursive: true })
    const active = 'active-job-11111111'
    const orphan = 'orphan-job-22222222'
    const phases = [
      '1-prepare.stdout.log',
      '1-implementation.stderr.log',
      '1-review-3.stdout.log',
    ]
    for (const jobId of [active, orphan]) {
      for (const phase of phases) writeFileSync(join(logs, `${jobId}.${phase}`), phase)
    }

    expect(removeOrphanedJobState({
      stateDir: state,
      liveJobIds: new Set([active]),
      liveAttachmentPaths: new Set(),
      olderThan: Date.now() + 1_000,
    })).toBe(phases.length)
    for (const phase of phases) {
      expect(existsSync(join(logs, `${active}.${phase}`))).toBe(true)
      expect(existsSync(join(logs, `${orphan}.${phase}`))).toBe(false)
    }
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

    store.beginMonitorPreparation(first.id, first.workerId!)
    store.commitMonitorRequired(first.id, first.workerId!)
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

  test('旧protocolのCodex sessionは同じSlack threadでもresumeしない', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    let store = new JobStore(path)
    store.enqueue(input())
    const first = store.claimNext('serial-worker')!
    store.complete(first.id, 'legacy-codex-thread', 'done')
    store.close()

    const raw = new Database(path)
    raw.run('DELETE FROM codex_session_protocols WHERE session_id = ?', ['legacy-codex-thread'])
    raw.close()

    store = new JobStore(path)
    store.enqueue(input({ messageId: '1800000000.000201', task: '旧session後の続き' }))
    const followUp = store.claimNext('serial-worker')!
    expect(followUp.sessionId).toBeNull()
    expect(followUp.resumed).toBe(false)
    store.close()
  })

  test('同じSlackスレッドは既定20 jobまで同じCodex sessionをresumeする', () => {
    const store = makeStore()
    const sessionId = 'twenty-job-thread'

    for (let index = 0; index < DEFAULT_MAX_JOBS_PER_SESSION; index += 1) {
      store.enqueue(input({
        messageId: `1800000000.${String(index + 1).padStart(6, '0')}`,
        task: `turn-${index + 1}`,
      }))
      const job = store.claimNext('serial-worker')!
      expect(job.resumed).toBe(index > 0)
      expect(job.sessionId).toBe(index === 0 ? null : sessionId)
      store.complete(job.id, sessionId, `done-${index + 1}`)
    }

    store.enqueue(input({
      messageId: '1800000000.000021',
      task: 'turn-21',
    }))
    const rotated = store.claimNext('serial-worker')!
    expect(rotated.resumed).toBe(false)
    expect(rotated.sessionId).toBeNull()
    store.close()
  })

  test('完了jobをretention削除しても同じCodex sessionを20 job超でresumeしない', () => {
    const state = fixtureDir()
    const path = join(state, 'jobs.sqlite3')
    const store = new JobStore(path)
    const sessionId = 'retention-proof-twenty-job-thread'
    const completedIds: string[] = []
    for (let index = 0; index < DEFAULT_MAX_JOBS_PER_SESSION; index += 1) {
      store.enqueue(input({
        messageId: `1800000001.${String(index + 1).padStart(6, '0')}`,
        task: `retention-turn-${index + 1}`,
      }))
      const job = store.claimNext('serial-worker')!
      store.complete(job.id, sessionId, `done-${index + 1}`)
      completedIds.push(job.id)
      const notification = store.pendingTerminalNotifications()
        .find(item => item.jobId === job.id)!
      store.markTerminalNotificationDelivered(notification.id)
    }
    const raw = new Database(path)
    for (const id of completedIds.slice(0, -1)) {
      raw.run('UPDATE jobs SET finished_at = 1 WHERE id = ?', [id])
    }
    raw.close()
    const pruned = store.pruneSettled({
      stateDir: state,
      now: Date.now(),
      retentionMs: 24 * 60 * 60 * 1_000,
      tombstoneRetentionMs: 48 * 60 * 60 * 1_000,
    })
    expect(pruned.jobs).toBe(DEFAULT_MAX_JOBS_PER_SESSION - 1)

    store.enqueue(input({
      messageId: '1800000001.000021',
      task: 'retention-turn-21',
    }))
    const rotated = store.claimNext('serial-worker')!
    expect(rotated.resumed).toBe(false)
    expect(rotated.sessionId).toBeNull()
    store.close()
  })

  test('usage ledger導入前のsessionは残存job数を信用せず新規jobでrotationする', () => {
    const state = fixtureDir()
    const path = join(state, 'jobs.sqlite3')
    let store = new JobStore(path)
    store.enqueue(input({ messageId: 'legacy-usage-1' }))
    const first = store.claimNext('serial-worker')!
    store.complete(first.id, 'pre-ledger-session', 'done')
    store.close()

    const raw = new Database(path)
    raw.run("DELETE FROM migration_ledger WHERE name = 'codex-session-usage-ledger-v1'")
    raw.run('DELETE FROM codex_session_retirements WHERE session_id = ?', ['pre-ledger-session'])
    raw.run('DELETE FROM codex_session_job_uses WHERE session_id = ?', ['pre-ledger-session'])
    raw.close()

    store = new JobStore(path)
    store.enqueue(input({ messageId: 'legacy-usage-2', task: '移行後の続き' }))
    const rotated = store.claimNext('serial-worker')!
    expect(rotated.resumed).toBe(false)
    expect(rotated.sessionId).toBeNull()
    store.close()
  })

  test('executorはdurable monitor arm後だけ保存できる', () => {
    const store = makeStore()
    store.enqueue(input())
    const claimed = store.claimNext('serial-worker')!
    expect(() => store.saveExecutorPid(claimed.id, process.pid))
      .toThrow('durable Herdr monitor')
    store.beginMonitorPreparation(claimed.id, claimed.workerId!)
    expect(store.get(claimed.id)?.monitorState).toBe('preparing')
    expect(() => store.saveExecutorPid(claimed.id, process.pid))
      .toThrow('durable Herdr monitor')
    store.commitMonitorRequired(claimed.id, claimed.workerId!)
    store.saveExecutorPid(claimed.id, process.pid)
    expect(store.get(claimed.id)).toMatchObject({
      monitorState: 'required',
      executorPid: process.pid,
    })
    store.close()
  })

  test('terminal化してもmonitor obligationはexact close完了まで残す', () => {
    const store = makeStore()
    const completed = store.enqueue(input({ messageId: 'monitor-complete' })).job
    const claimedCompleted = store.claimNext('serial-worker')!
    store.beginMonitorPreparation(completed.id, claimedCompleted.workerId!)
    store.commitMonitorRequired(completed.id, claimedCompleted.workerId!)
    store.complete(completed.id, 'session-complete', 'done')
    expect(store.get(completed.id)?.monitorState).toBe('required')
    store.retireMonitorObligation(completed.id)
    expect(store.get(completed.id)?.monitorState).toBe('none')

    const failed = store.enqueue(input({ messageId: 'monitor-fail' })).job
    const claimedFailed = store.claimNext('serial-worker')!
    store.beginMonitorPreparation(failed.id, claimedFailed.workerId!)
    store.commitMonitorRequired(failed.id, claimedFailed.workerId!)
    store.fail(failed.id, 'failed')
    expect(store.get(failed.id)?.monitorState).toBe('required')
    store.retireMonitorObligation(failed.id)
    expect(store.get(failed.id)?.monitorState).toBe('none')
    store.close()
  })

  test('monitor消失後のstaged resultは保持するが自動完成しない', () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'monitor-staged' })).job
    const claimed = store.claimNext('serial-worker')!
    store.beginMonitorPreparation(queued.id, claimed.workerId!)
    store.commitMonitorRequired(queued.id, claimed.workerId!)
    store.stageExecutionResult(queued.id, 'session-staged', 'completed answer')
    expect(store.markMonitorLostAfterStagedResult(queued.id)).toBe(true)
    expect(store.hasStagedExecution(queued.id)).toBe(true)
    expect(store.get(queued.id)?.monitorState).toBe('lost-staged')

    expect(() => store.completeStagedExecution(queued.id)).toThrow('job is no longer running')
    expect(store.get(queued.id)).toMatchObject({
      status: 'running',
      result: null,
      monitorState: 'lost-staged',
    })
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

  test('同じchannel threadならsenderが変わっても同じsessionを継続する', () => {
    const store = makeStore()
    store.enqueue(input({ userId: 'U1111111111' }))
    const first = store.claimNext('serial-worker')!
    store.complete(first.id, 'codex-thread-user-1', 'done')
    store.enqueue(input({ messageId: '2', userId: 'U2222222222' }))
    expect(store.claimNext('serial-worker')?.sessionId).toBe('codex-thread-user-1')
    store.close()
  })

  test('実行中の同じSlack threadなら別userの返信をFIFO jobではなくcontrolへ束縛する', () => {
    const store = makeStore()
    const root = store.enqueue(input({ userId: 'UROOT' })).job
    const running = store.claimNext('serial-worker')!
    expect(running.id).toBe(root.id)
    expect(running.controlEpoch).toBe(1)
    expect(running.acceptsControl).toBe(true)
    const target = store.liveControlTarget(running.chatId, running.threadTs)
    expect(target).toEqual({
      jobId: running.id,
      epoch: 1,
      repoPath: running.repoPath,
      writeEnabled: false,
    })
    expect(store.stageLiveControl(target!, {
      chatId: running.chatId,
      threadTs: running.threadTs,
      messageId: 'follow-up-1',
      userId: 'UOTHER',
      task: '別ユーザーからの追記',
      kind: 'steer',
    })).toBe('staged')
    expect(store.list()).toHaveLength(1)
    expect(store.listJobControls(running.id)[0]).toMatchObject({
      userId: 'UOTHER', kind: 'steer', status: 'ready', epoch: 1,
    })
    expect(store.liveControlTarget(running.chatId, 'different-thread')).toBeNull()
    store.close()
  })

  test('同一threadの返信はsender・route・個別write許可に関係なくactive jobへsteerする', () => {
    const readTarget = {
      jobId: 'read-job', epoch: 1, repoPath: '/tmp/project', writeEnabled: false,
    }
    const writeTarget = { ...readTarget, jobId: 'write-job', writeEnabled: true }
    expect(liveControlAcceptsInput(readTarget, {
      repoPath: '/tmp/project', writeEnabled: false, interrupt: false,
    })).toBe(true)
    expect(liveControlAcceptsInput(writeTarget, {
      repoPath: '/tmp/project', writeEnabled: false, interrupt: false,
    })).toBe(true)
    expect(liveControlAcceptsInput(writeTarget, {
      repoPath: '/tmp/project', writeEnabled: true, interrupt: false,
    })).toBe(true)
    expect(liveControlAcceptsInput(writeTarget, {
      repoPath: '/tmp/other-project', writeEnabled: true, interrupt: false,
    })).toBe(true)
    expect(liveControlAcceptsInput(writeTarget, {
      repoPath: '/tmp/other-project', writeEnabled: false, interrupt: true,
    })).toBe(true)
  })

  test('未claimの同じSlack threadも別user返信をroot入力へ束縛し別jobを作らない', () => {
    const store = makeStore()
    const root = store.enqueue(input({ messageId: 'queued-live-root', task: '初回依頼' })).job
    const target = store.liveControlTarget(root.chatId, root.threadTs)
    expect(target).toEqual({
      jobId: root.id,
      epoch: 1,
      repoPath: root.repoPath,
      writeEnabled: false,
    })
    expect(store.stageLiveControl(target!, {
      chatId: root.chatId,
      threadTs: root.threadTs,
      messageId: 'queued-live-follow-up',
      userId: 'UOTHER',
      task: '開始前の追記',
      kind: 'steer',
    })).toBe('staged')
    expect(store.list()).toHaveLength(1)
    expect(readAdvisorInputSnapshot(dirname(store.dbPath), root.id).transcript)
      .toContain('開始前の追記')
    const claimed = store.claimNext('serial-worker')!
    expect(claimed.inputRevision).toBe(2)
    expect(store.listJobControls(root.id)[0]).toMatchObject({
      userId: 'UOTHER', status: 'ready', inputRevision: 2,
    })
    store.close()
  })

  test('未claimの同じSlack threadの中止はjob起動前にdurable cancelへ束縛する', () => {
    const store = makeStore()
    const root = store.enqueue(input({ messageId: 'queued-stop-root' })).job
    const target = store.liveControlTarget(root.chatId, root.threadTs)!
    expect(store.stageLiveControl(target, {
      chatId: root.chatId,
      threadTs: root.threadTs,
      messageId: 'queued-stop',
      userId: 'UOTHER',
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')
    expect(store.get(root.id)?.cancelRequestedAt).not.toBeNull()
    expect(store.claimNext('serial-worker')).toMatchObject({
      id: root.id,
      acceptsControl: false,
    })
    store.close()
  })

  test('job handoff後に再取得した同じSlack deliveryをroot job自身のcontrolにしない', () => {
    const store = makeStore()
    const root = store.enqueue(input({ messageId: 'handoff-crash' })).job
    const running = store.claimNext('serial-worker')!
    const target = store.liveControlTarget(running.chatId, running.threadTs)!
    expect(store.stageLiveControl(target, {
      chatId: running.chatId,
      threadTs: running.threadTs,
      messageId: root.messageId,
      userId: root.userId,
      task: root.task,
      kind: 'steer',
    })).toBe('duplicate')
    expect(store.list()).toHaveLength(1)
    expect(store.listJobControls(root.id)).toHaveLength(0)
    store.close()
  })

  test('turn完了barrierより先に入ったcontrolは次turnへ残り、後なら新jobへ分離できる', () => {
    const store = makeStore()
    store.enqueue(input())
    const running = store.claimNext('serial-worker')!
    const target = store.liveControlTarget(running.chatId, running.threadTs)!
    store.bindAppServerTurn(running.id, running.workerId!, target.epoch, 'nonce-1', 'thread-1', 'turn-1')
    store.stageLiveControl(target, {
      chatId: running.chatId, threadTs: running.threadTs,
      messageId: 'race-before', userId: 'UOTHER', task: '先着', kind: 'steer',
    })
    expect(store.finishAppServerTurn({
      jobId: running.id, epoch: target.epoch, executorNonce: 'nonce-1',
      threadId: 'thread-1', turnId: 'turn-1',
    })).toEqual({ closeInput: false, cancelled: false, pending: 1, pendingInbound: 0 })
    expect(store.liveControlTarget(running.chatId, running.threadTs)).toEqual(target)

    const control = store.nextReadyControl(running.id, target.epoch)!
    store.beginControlDispatch({
      controlId: control.id, jobId: running.id, epoch: target.epoch,
      executorNonce: 'nonce-1', threadId: 'thread-1', requestId: 8,
    })
    store.acknowledgeControl(control.id, 8, 'turn-2')
    store.bindAppServerTurn(running.id, running.workerId!, target.epoch, 'nonce-1', 'thread-1', 'turn-2')
    expect(store.finishAppServerTurn({
      jobId: running.id, epoch: target.epoch, executorNonce: 'nonce-1',
      threadId: 'thread-1', turnId: 'turn-2',
    })).toEqual({ closeInput: true, cancelled: false, pending: 0, pendingInbound: 0 })
    expect(store.liveControlTarget(running.chatId, running.threadTs)).toBeNull()
    expect(store.stageLiveControl(target, {
      chatId: running.chatId, threadTs: running.threadTs,
      messageId: 'race-after', userId: 'UOTHER', task: '後着', kind: 'steer',
    })).toBe('closed')
    store.close()
  })

  test('最終turn seal後のClaude settle中も同thread中止だけをdurable cancelへ束縛する', () => {
    const store = makeStore()
    store.enqueue(input({ messageId: 'settle-stop-root' }))
    const running = store.claimNext('serial-worker')!
    const activeTarget = store.liveControlTarget(running.chatId, running.threadTs)!
    store.bindAppServerTurn(
      running.id,
      running.workerId!,
      activeTarget.epoch,
      'nonce-settle-stop',
      'thread-settle-stop',
      'turn-settle-stop',
    )
    expect(store.finishAppServerTurn({
      jobId: running.id,
      epoch: activeTarget.epoch,
      executorNonce: 'nonce-settle-stop',
      threadId: 'thread-settle-stop',
      turnId: 'turn-settle-stop',
    })).toEqual({ closeInput: true, cancelled: false, pending: 0, pendingInbound: 0 })
    expect(store.liveControlTarget(running.chatId, running.threadTs)).toBeNull()
    expect(store.interruptControlTarget(running.chatId, running.threadTs)).toEqual(activeTarget)
    expect(store.interruptControlTarget(running.chatId, 'different-thread')).toBeNull()

    store.stageInboundDelivery({
      chatId: 'COTHER',
      threadTs: 'unrelated-thread',
      messageId: 'blocked-older-delivery',
      userId: 'UOTHER',
      repoPath: running.repoPath,
      text: '別threadの添付待ち',
    })
    const blocked = store.claimNextInboundDelivery(1_000)!
    store.deferInboundDelivery(blocked.idempotencyKey, 'fixture backoff', 10_000)
    store.stageInboundDelivery({
      chatId: running.chatId,
      threadTs: running.threadTs,
      messageId: 'settle-stop',
      userId: 'UDIFFERENT',
      repoPath: '/tmp/unrelated-route-is-ignored-for-same-thread',
      text: '中止',
      isInterrupt: true,
    })
    const interrupt = store.claimNextInboundDelivery(2_000)!
    expect(interrupt).toMatchObject({
      messageId: 'settle-stop', userId: 'UDIFFERENT', isInterrupt: true,
    })
    const target = store.interruptControlTarget(interrupt.chatId, interrupt.threadTs)!
    expect(store.stageLiveControl(target, {
      chatId: interrupt.chatId,
      threadTs: interrupt.threadTs,
      messageId: interrupt.messageId,
      userId: interrupt.userId,
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')
    store.completeInboundDelivery(interrupt.idempotencyKey)
    expect(store.get(running.id)?.cancelRequestedAt).not.toBeNull()
    expect(store.listJobControls(running.id)).toEqual([
      expect.objectContaining({ kind: 'interrupt', status: 'ready', userId: 'UDIFFERENT' }),
    ])
    expect(store.interruptControlTarget(running.chatId, running.threadTs)).toBeNull()
    store.close()
  })

  test('durable inboundがcontrolへ変換されるまでterminal barrierを閉じない', () => {
    const store = makeStore()
    store.enqueue(input({ messageId: 'inbound-barrier-root' }))
    const claimed = store.claimNext('serial-worker')!
    const target = store.liveControlTarget(claimed.chatId, claimed.threadTs)!
    store.bindAppServerTurn(
      claimed.id, claimed.workerId!, target.epoch, 'nonce-inbound', 'thread-inbound', 'turn-inbound',
    )
    store.stageInboundDelivery({
      chatId: claimed.chatId,
      threadTs: claimed.threadTs,
      messageId: 'inbound-before-terminal',
      userId: 'UOTHER',
      repoPath: claimed.repoPath,
      text: 'terminal直前の追記',
      writeEnabled: false,
    })
    expect(store.finishAppServerTurn({
      jobId: claimed.id,
      epoch: target.epoch,
      executorNonce: 'nonce-inbound',
      threadId: 'thread-inbound',
      turnId: 'turn-inbound',
    })).toEqual({ closeInput: false, cancelled: false, pending: 0, pendingInbound: 1 })
    expect(store.get(claimed.id)?.activeTurnId).toBe('turn-inbound')
    store.completeInboundDelivery(`${claimed.chatId}:inbound-before-terminal`)
    expect(store.finishAppServerTurn({
      jobId: claimed.id,
      epoch: target.epoch,
      executorNonce: 'nonce-inbound',
      threadId: 'thread-inbound',
      turnId: 'turn-inbound',
    })).toEqual({ closeInput: true, cancelled: false, pending: 0, pendingInbound: 0 })
    expect(store.get(claimed.id)?.activeTurnId).toBeNull()
    store.close()
  })

  test('write terminal境界の別user返信はretainInput中もturnを保持して再準備へ渡す', () => {
    const store = makeStore()
    store.enqueue(input({ writeEnabled: true, messageId: 'late-write-inbound-root' }))
    const claimed = store.claimNext('serial-worker')!
    const target = store.liveControlTarget(claimed.chatId, claimed.threadTs)!
    store.bindAppServerTurn(
      claimed.id,
      claimed.workerId!,
      target.epoch,
      'nonce-late-write',
      'thread-late-write',
      'turn-implementation',
    )
    store.stageInboundDelivery({
      chatId: claimed.chatId,
      threadTs: claimed.threadTs,
      messageId: 'late-during-write',
      userId: 'UOTHER',
      repoPath: claimed.repoPath,
      text: '実装中の追記',
      writeEnabled: false,
    })

    expect(store.finishAppServerTurn({
      jobId: claimed.id,
      epoch: target.epoch,
      executorNonce: 'nonce-late-write',
      threadId: 'thread-late-write',
      turnId: 'turn-implementation',
      retainInput: true,
    })).toEqual({ closeInput: false, cancelled: false, pending: 0, pendingInbound: 1 })
    expect(store.get(claimed.id)?.activeTurnId).toBe('turn-implementation')

    const inbound = store.claimNextInboundDelivery()!
    const live = store.liveControlTarget(inbound.chatId, inbound.threadTs)!
    expect(store.stageLiveControl(live, {
      chatId: inbound.chatId,
      threadTs: inbound.threadTs,
      messageId: inbound.messageId,
      userId: inbound.userId,
      writeEnabled: inbound.writeEnabled,
      task: inbound.text,
      kind: 'steer',
    })).toBe('staged')
    store.completeInboundDelivery(inbound.idempotencyKey)

    expect(store.finishAppServerTurn({
      jobId: claimed.id,
      epoch: target.epoch,
      executorNonce: 'nonce-late-write',
      threadId: 'thread-late-write',
      turnId: 'turn-implementation',
      retainInput: true,
    })).toEqual({ closeInput: false, cancelled: false, pending: 1, pendingInbound: 0 })
    expect(store.get(claimed.id)).toMatchObject({
      activeTurnId: null,
      acceptsControl: true,
      inputRevision: 2,
    })
    expect(store.nextReadyControl(claimed.id, target.epoch)).toMatchObject({
      userId: 'UOTHER',
      kind: 'steer',
      inputRevision: 2,
    })
    store.close()
  })

  test('同じthreadの中止は未送信steerをsupersedeして受付epochを閉じる', () => {
    const store = makeStore()
    store.enqueue(input())
    const running = store.claimNext('serial-worker')!
    const target = store.liveControlTarget(running.chatId, running.threadTs)!
    store.stageLiveControl(target, {
      chatId: running.chatId, threadTs: running.threadTs,
      messageId: 'steer-before-stop', userId: 'U2', task: '追記', kind: 'steer',
    })
    expect(store.stageLiveControl(target, {
      chatId: running.chatId, threadTs: running.threadTs,
      messageId: 'stop', userId: 'U3', task: '中止', kind: 'interrupt',
    })).toBe('staged')
    expect(store.liveControlTarget(running.chatId, running.threadTs)).toBeNull()
    expect(store.listJobControls(running.id).map(value => [value.kind, value.status])).toEqual([
      ['steer', 'superseded'], ['interrupt', 'ready'],
    ])
    expect(store.nextReadyControl(running.id, target.epoch)?.kind).toBe('interrupt')
    expect(store.get(running.id)?.cancelRequestedAt).not.toBeNull()
    store.close()
  })

  test('旧control ledgerをcanonical入力revisionとdigestへ一度だけmigrationする', () => {
    const dir = fixtureDir()
    const state = join(dir, 'state')
    mkdirSync(state, { mode: 0o700 })
    const path = join(state, 'jobs.sqlite3')
    const store = new JobStore(path)
    store.enqueue(input({ messageId: 'legacy-input-root', task: '初回' }))
    const running = store.claimNext('serial-worker')!
    const target = store.liveControlTarget(running.chatId, running.threadTs)!
    for (const [messageId, userId, task] of [
      ['legacy-steer-1', 'U2', '追加入力1'],
      ['legacy-steer-2', 'U3', '追加入力2'],
    ] as const) {
      expect(store.stageLiveControl(target, {
        chatId: running.chatId,
        threadTs: running.threadTs,
        messageId,
        userId,
        task,
        kind: 'steer',
      })).toBe('staged')
    }
    expect(store.stageLiveControl(target, {
      chatId: running.chatId,
      threadTs: running.threadTs,
      messageId: 'legacy-interrupt',
      userId: 'U4',
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')
    store.close()

    const legacy = new Database(path)
    legacy.exec('DROP INDEX idx_job_controls_steer_revision')
    legacy.run("DELETE FROM migration_ledger WHERE name = 'advisor-input-ledger-v1'")
    legacy.run('UPDATE jobs SET input_revision = 1')
    legacy.run("UPDATE job_controls SET input_revision = 1, input_digest = ''")
    legacy.close()

    const migrated = new JobStore(path)
    const controls = migrated.listJobControls(running.id)
    expect(controls.map(control => control.inputRevision)).toEqual([2, 3, 3])
    expect(controls.every(control => /^[0-9a-f]{64}$/.test(control.inputDigest))).toBe(true)
    expect(controls[1]!.inputDigest).toBe(controls[2]!.inputDigest)
    expect(migrated.get(running.id)?.inputRevision).toBe(3)
    expect(readAdvisorInputSnapshot(state, running.id).digest).toBe(controls[2]!.inputDigest)
    const revisionOne = readAdvisorInputSnapshot(state, running.id, 1)
    const revisionTwo = readAdvisorInputSnapshot(state, running.id, 2)
    expect(revisionOne.entries.map(entry => entry.task)).toEqual(['初回'])
    expect(revisionTwo.entries.map(entry => [entry.userId, entry.task])).toEqual([
      ['U0123456789', '初回'],
      ['U2', '追加入力1'],
    ])
    expect(revisionTwo.digest).toBe(controls[0]!.inputDigest)
    const firstMigration = controls.map(control => [control.inputRevision, control.inputDigest])
    migrated.close()

    const reopened = new JobStore(path)
    expect(reopened.listJobControls(running.id).map(control => (
      [control.inputRevision, control.inputDigest]
    ))).toEqual(firstMigration)
    reopened.close()
  })

  test('初回turn/startはwrite前receiptからterminal観測までdurableに遷移する', () => {
    const store = makeStore()
    store.enqueue(input({ messageId: 'initial-dispatch-ambiguous' }))
    const uncertain = store.claimNext('serial-worker')!
    const uncertainInput = readAdvisorInputSnapshot(
      dirname(store.dbPath), uncertain.id,
    )
    expect(store.initialTurnDispatchIsSafeToRetry(uncertain.id)).toBe(true)
    expect(store.initialTurnMayHaveBeenDelivered(uncertain.id)).toBe(false)
    store.beginInitialTurnDispatch({
      jobId: uncertain.id,
      attempt: uncertain.attempts,
      epoch: uncertain.controlEpoch,
      executorNonce: 'a'.repeat(32),
      threadId: 'thread-initial-1',
      requestId: 1,
      inputRevision: uncertainInput.revision,
      inputDigest: uncertainInput.digest,
    })
    expect(store.initialTurnMayHaveBeenDelivered(uncertain.id)).toBe(true)
    expect(() => store.requeue(uncertain.id, 'must not resend')).toThrow('cannot be safely requeued')
    expect(store.recoverInterrupted()).toEqual({
      requeued: 0, failedWrites: 0, failedUncertain: 1,
    })

    store.enqueue(input({ messageId: 'initial-dispatch-observed' }))
    const observed = store.claimNext('serial-worker')!
    const observedInput = readAdvisorInputSnapshot(dirname(store.dbPath), observed.id)
    const nonce = 'b'.repeat(32)
    store.beginInitialTurnDispatch({
      jobId: observed.id,
      attempt: observed.attempts,
      epoch: observed.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-initial-2',
      requestId: 2,
      inputRevision: observedInput.revision,
      inputDigest: observedInput.digest,
    })
    store.acknowledgeInitialTurnDispatch({
      jobId: observed.id,
      workerId: observed.workerId!,
      attempt: observed.attempts,
      epoch: observed.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-initial-2',
      turnId: 'turn-initial-2',
      requestId: 2,
    })
    expect(store.get(observed.id)).toMatchObject({
      executorNonce: nonce,
      activeThreadId: 'thread-initial-2',
      activeTurnId: 'turn-initial-2',
    })
    expect(store.finishAppServerTurn({
      jobId: observed.id,
      epoch: observed.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-initial-2',
      turnId: 'turn-initial-2',
    })).toEqual({ closeInput: true, cancelled: false, pending: 0, pendingInbound: 0 })
    expect(store.initialTurnMayHaveBeenDelivered(observed.id)).toBe(true)
    store.close()
  })

  test('初回turnは送信前の全steer本文とrevisionを一度だけreceiptへ束縛する', () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'initial-bound-root', task: '初回' })).job
    const target = store.liveControlTarget(queued.chatId, queued.threadTs)!
    expect(store.stageLiveControl(target, {
      chatId: queued.chatId,
      threadTs: queued.threadTs,
      messageId: 'initial-bound-follow-up',
      userId: 'UOTHER',
      task: '開始前追記',
      kind: 'steer',
    })).toBe('staged')
    const running = store.claimNext('serial-worker')!
    const snapshot = readAdvisorInputSnapshot(dirname(store.dbPath), running.id)
    expect(buildCodexWorkerPrompt(running, snapshot)).toContain('開始前追記')
    const nonce = 'd'.repeat(32)
    expect(store.beginInitialTurnDispatch({
      jobId: running.id,
      attempt: running.attempts,
      epoch: running.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-bound',
      requestId: 51,
      inputRevision: snapshot.revision,
      inputDigest: snapshot.digest,
    })).toBe('dispatching')
    expect(store.listJobControls(running.id)[0]?.status).toBe('dispatching')
    store.acknowledgeInitialTurnDispatch({
      jobId: running.id,
      workerId: running.workerId!,
      attempt: running.attempts,
      epoch: running.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-bound',
      turnId: 'turn-bound',
      requestId: 51,
    })
    expect(store.listJobControls(running.id)[0]).toMatchObject({
      status: 'observed', turnId: 'turn-bound',
    })
    expect(store.nextReadyControl(running.id, running.controlEpoch)).toBeNull()
    store.close()
  })

  test('snapshot後にsteerが増えた初回turnはJSON write前に止め最新入力で再試行できる', () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'initial-race-root' })).job
    const running = store.claimNext('serial-worker')!
    const stale = readAdvisorInputSnapshot(dirname(store.dbPath), running.id)
    const target = store.liveControlTarget(running.chatId, running.threadTs)!
    expect(store.stageLiveControl(target, {
      chatId: running.chatId,
      threadTs: running.threadTs,
      messageId: 'initial-race-follow-up',
      userId: 'UOTHER',
      task: 'snapshot後追記',
      kind: 'steer',
    })).toBe('staged')
    expect(store.beginInitialTurnDispatch({
      jobId: running.id,
      attempt: running.attempts,
      epoch: running.controlEpoch,
      executorNonce: 'e'.repeat(32),
      threadId: 'thread-race',
      requestId: 61,
      inputRevision: stale.revision,
      inputDigest: stale.digest,
    })).toBe('input-changed')
    expect(store.initialTurnDispatchIsSafeToRetry(running.id)).toBe(true)
    expect(store.initialTurnMayHaveBeenDelivered(running.id)).toBe(false)
    expect(store.listJobControls(running.id)[0]?.status).toBe('ready')
    store.close()
  })

  test('session上限を5jobに設定した場合は6件目を新規にする', () => {
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
  test('claim直前のClaude clean receipt検証失敗ならCodexを起動しない', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'blocked-before-claim' })).job
    let executions = 0
    await expect(runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: false,
      beforeClaim: async () => {
        throw new ClaudeContextClearPendingError('Claude receipt changed')
      },
      executor: async () => {
        executions += 1
        return { sessionId: 'must-not-run', result: 'must-not-run' }
      },
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(executions).toBe(0)
    expect(store.get(queued.id)).toMatchObject({ status: 'queued', attempts: 0 })
    store.close()
  })

  test('Codex成功結果をclear前にstageし、crash recovery後も完成回答を失わない', async () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    let store = new JobStore(path)
    const queued = store.enqueue(input({ messageId: 'staged-before-clear' })).job
    await expect(runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async () => ({ sessionId: 'staged-session', result: 'staged result' }),
      settleExternalContext: async () => {
        throw new ClaudeContextClearPendingError('simulated crash boundary')
      },
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(store.get(queued.id)?.status).toBe('running')
    store.close()

    store = new JobStore(path)
    expect(store.recoverStagedExecutions()).toBe(1)
    expect(store.get(queued.id)).toMatchObject({
      status: 'completed', sessionId: 'staged-session', result: 'staged result',
    })
    expect(store.terminalNotificationCount()).toBe(1)
    store.close()
  })

  test('durable result journalからDB stage前crashの完成回答を復旧する', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    let store = new JobStore(path)
    const queued = store.enqueue(input({ messageId: 'journal-before-stage' })).job
    const running = store.claimNext('serial-worker')!
    persistExecutionResultJournal(dir, running, {
      sessionId: 'journal-session', result: 'journal result',
    })
    store.close()

    store = new JobStore(path)
    expect(recoverExecutionResultJournals(store, dir)).toBe(1)
    expect(store.recoverStagedExecutions()).toBe(1)
    expect(store.get(queued.id)).toMatchObject({
      status: 'completed', sessionId: 'journal-session', result: 'journal result',
    })
    store.close()
  })

  test('再起動はjournalをSQLiteへstageしてからClaudeをclearし、その後completeする', async () => {
    const dir = fixtureDir()
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    const queued = store.enqueue(input({ messageId: 'recovery-order' })).job
    const running = store.claimNext('serial-worker')!
    persistExecutionResultJournal(dir, running, {
      sessionId: 'recovery-session', result: 'recovery result',
    })
    const order: string[] = []

    const recovered = await recoverExecutionCheckpointBeforeClaudeClear(
      store,
      dir,
      async () => {
        store.assertExecutionResultStaged(
          queued.id, 'recovery-session', 'recovery result',
        )
        order.push('claude-clear')
      },
    )

    order.push('returned-after-complete')
    expect(recovered).toEqual({ journaled: 1, completed: 1 })
    expect(order).toEqual(['claude-clear', 'returned-after-complete'])
    expect(store.get(queued.id)).toMatchObject({
      status: 'completed', sessionId: 'recovery-session', result: 'recovery result',
    })
    store.close()
  })

  test('staged成功後のdurable中止はstartupで成功公開せずcancel terminalへ復旧する', async () => {
    const dir = fixtureDir()
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    const queued = store.enqueue(input({ messageId: 'staged-then-cancelled' })).job
    const running = store.claimNext('recovery-worker')!
    store.stageExecutionResult(running.id, 'cancelled-staged-session', 'must not publish')
    const target = store.interruptControlTarget(running.chatId, running.threadTs)!
    expect(store.stageLiveControl(target, {
      chatId: running.chatId,
      threadTs: running.threadTs,
      messageId: 'cancel-after-staged-success',
      userId: 'UDIFFERENT',
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')
    expect(store.stagedExecutionJobIds()).toEqual([queued.id])

    const checkpoint = await recoverExecutionCheckpointBeforeClaudeClear(
      store,
      dir,
      async () => {
        expect(store.hasStagedExecution(queued.id)).toBe(true)
        expect(store.get(queued.id)?.cancelRequestedAt).not.toBeNull()
      },
    )
    expect(checkpoint).toEqual({ journaled: 0, completed: 0 })
    expect(store.get(queued.id)).toMatchObject({ status: 'running', result: null })

    expect(store.recoverInterrupted(dir)).toEqual({
      requeued: 0, failedWrites: 0, failedUncertain: 1,
    })
    expect(store.get(queued.id)).toMatchObject({
      status: 'failed', terminalOutcome: 'cancelled', result: null,
    })
    expect(store.hasStagedExecution(queued.id)).toBe(false)
    expect(store.pendingTerminalNotifications()).toEqual([
      expect.objectContaining({ jobId: queued.id, kind: 'failed' }),
    ])
    store.close()
  })

  test('成功stage後のClaude settle中に届いた中止は完成回答を公開しない', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'live-staged-then-cancelled' })).job
    const notifications: Array<{ kind: 'completed' | 'failed'; payload: string }> = []
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async () => ({
        sessionId: 'live-cancelled-staged-session',
        result: 'must never reach Slack',
      }),
      settleExternalContext: async job => {
        expect(store.hasStagedExecution(job.id)).toBe(true)
        const target = store.interruptControlTarget(job.chatId, job.threadTs)!
        expect(store.stageLiveControl(target, {
          chatId: job.chatId,
          threadTs: job.threadTs,
          messageId: 'live-cancel-after-staged-success',
          userId: 'U_DIFFERENT',
          task: '中止',
          kind: 'interrupt',
        })).toBe('staged')
      },
      notifier: {
        completed: async (_job, payload) => {
          notifications.push({ kind: 'completed', payload })
        },
        failed: async (_job, payload) => {
          notifications.push({ kind: 'failed', payload })
        },
      },
    })

    expect(stats).toEqual({ completed: 0, failed: 1, workersStarted: 1 })
    expect(store.get(queued.id)).toMatchObject({
      status: 'failed', terminalOutcome: 'cancelled', result: null,
    })
    expect(store.hasStagedExecution(queued.id)).toBe(false)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.kind).toBe('failed')
    expect(notifications.some(notification => (
      notification.kind === 'completed' || notification.payload.includes('must never reach Slack')
    ))).toBe(false)
    store.close()
  })

  test('startup staged recoveryはClaude clear前後のmonitor検証失敗でterminal化しない', async () => {
    for (const missingAt of ['before-clear', 'after-clear'] as const) {
      const store = makeStore()
      const queued = store.enqueue(input({ messageId: `startup-monitor-${missingAt}` })).job
      const claimed = store.claimNext('recovery-worker')!
      store.stageExecutionResult(claimed.id, 'recovery-session', 'durable result')
      let checks = 0
      let clears = 0
      await expect(recoverExecutionCheckpointBeforeClaudeClear(
        store,
        fixtureDir(),
        () => reconcileClaudeWithMonitorHealthBarrier(
          store,
          async () => {
            checks += 1
            return {
              retainedJobIds: checks === 1 && missingAt === 'after-clear'
                ? [queued.id]
                : [],
            }
          },
          async () => { clears += 1 },
        ),
      )).rejects.toBeInstanceOf(HerdrJobMonitorPendingError)
      expect(store.get(queued.id)?.status).toBe('running')
      expect(clears).toBe(missingAt === 'before-clear' ? 0 : 1)
      store.close()
    }
  })

  test('結果checkpoint失敗時はClaudeをclearせずrunningを保持する', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'checkpoint-before-clear' })).job
    let clears = 0
    await expect(runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async () => {
        throw new CodexResultPersistencePendingError('journal write failed')
      },
      settleExternalContext: async () => { clears += 1 },
    })).rejects.toBeInstanceOf(CodexResultPersistencePendingError)
    expect(clears).toBe(0)
    expect(store.get(queued.id)?.status).toBe('running')
    store.close()
  })

  test('Claude clear後のDB complete失敗も成功結果をstagedのまま保持する', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'complete-retry' })).job
    const complete = store.completeStagedExecution.bind(store)
    store.completeStagedExecution = () => { throw new Error('database unavailable') }
    let clears = 0
    await expect(runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async () => ({ sessionId: 'complete-session', result: 'complete result' }),
      settleExternalContext: async () => { clears += 1 },
    })).rejects.toBeInstanceOf(CodexResultPersistencePendingError)
    expect(clears).toBe(1)
    expect(store.get(queued.id)?.status).toBe('running')
    store.assertExecutionResultStaged(queued.id, 'complete-session', 'complete result')
    complete(queued.id)
    expect(store.get(queued.id)).toMatchObject({
      status: 'completed', sessionId: 'complete-session', result: 'complete result',
    })
    store.close()
  })

  test('plain external settle errorもcompleted結果を消さずrunningでfail-closedする', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'plain-boundary-error' })).job
    await expect(runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async () => ({ sessionId: 'plain-session', result: 'plain result' }),
      settleExternalContext: async () => { throw new Error('malformed boundary') },
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(store.get(queued.id)?.status).toBe('running')
    expect(store.recoverStagedExecutions()).toBe(1)
    expect(store.get(queued.id)).toMatchObject({
      status: 'completed', sessionId: 'plain-session', result: 'plain result',
    })
    store.close()
  })

  test('Claude予約が完了するまでclaimed jobのCodexを起動しない', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'prepare-first' })).job
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    let executions = 0
    const running = runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      prepareExternalContext: async () => {
        entered()
        await ready
      },
      executor: async () => {
        executions += 1
        return { sessionId: 'prepared-session', result: 'prepared result' }
      },
    })
    await preparing
    expect(executions).toBe(0)
    expect(store.get(queued.id)?.status).toBe('running')
    release()
    expect(await running).toEqual({ completed: 1, failed: 0, workersStarted: 1 })
    expect(executions).toBe(1)
    store.close()
  })

  test('Claude予約中の中止はcancel境界を使いCodexを起動せず次threadへ進む', async () => {
    const store = makeStore()
    const first = store.enqueue(input({ messageId: 'cancel-during-reserve-1' })).job
    const second = store.enqueue(input({
      chatId: 'COTHER',
      threadTs: '1800000001.000100',
      messageId: 'cancel-during-reserve-2',
    })).job
    const executed: string[] = []
    const external: string[] = []
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      pollMs: 1,
      stopWhenIdle: true,
      prepareExternalContext: async job => {
        if (job.id !== first.id) return
        const target = store.liveControlTarget(job.chatId, job.threadTs)!
        expect(store.stageLiveControl(target, {
          chatId: job.chatId,
          threadTs: job.threadTs,
          messageId: 'cancel-during-reserve-stop',
          userId: 'UOTHER',
          task: '中止',
          kind: 'interrupt',
        })).toBe('staged')
        throw new CodexUserCancelledError()
      },
      cancelExternalContext: async job => { external.push(`cancel:${job.id}`) },
      settleExternalContext: async job => { external.push(`settle:${job.id}`) },
      executor: async job => {
        executed.push(job.id)
        return { sessionId: `session-${job.id}`, result: 'done' }
      },
    })
    expect(stats).toEqual({ completed: 1, failed: 1, workersStarted: 1 })
    expect(executed).toEqual([second.id])
    expect(external).toEqual([`cancel:${first.id}`, `settle:${second.id}`])
    expect(store.get(first.id)).toMatchObject({
      status: 'failed', terminalOutcome: 'cancelled', monitorState: 'none',
    })
    expect(store.get(second.id)?.status).toBe('completed')
    store.close()
  })

  test('実行中の中止はClaude cancelとclear完了までDB terminal化も次job claimもしない', async () => {
    const store = makeStore()
    const first = store.enqueue(input({ messageId: 'active-cancel-boundary-1' })).job
    const second = store.enqueue(input({
      chatId: 'COTHER',
      threadTs: '1800000002.000100',
      messageId: 'active-cancel-boundary-2',
    })).job
    const executed: string[] = []
    let releaseCancel!: () => void
    const cancelRelease = new Promise<void>(resolve => { releaseCancel = resolve })
    let enterCancel!: () => void
    const cancelEntered = new Promise<void>(resolve => { enterCancel = resolve })
    const running = runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      pollMs: 1,
      stopWhenIdle: true,
      openJobMonitor: async () => {},
      quiesceJobMonitor: async () => {},
      cancelExternalContext: async job => {
        if (job.id !== first.id) return
        enterCancel()
        await cancelRelease
      },
      settleExternalContext: async () => {},
      executor: async job => {
        executed.push(job.id)
        if (job.id === first.id) {
          const target = store.liveControlTarget(job.chatId, job.threadTs)!
          expect(store.stageLiveControl(target, {
            chatId: job.chatId,
            threadTs: job.threadTs,
            messageId: 'active-cancel-boundary-stop',
            userId: 'UOTHER',
            task: '中止',
            kind: 'interrupt',
          })).toBe('staged')
          throw new CodexUserCancelledError()
        }
        return { sessionId: `session-${job.id}`, result: 'done' }
      },
    })
    await cancelEntered
    expect(executed).toEqual([first.id])
    expect(store.get(first.id)?.status).toBe('running')
    expect(store.get(second.id)?.status).toBe('queued')
    expect(store.claimNext('another-worker')).toBeNull()
    releaseCancel()
    expect(await running).toEqual({ completed: 1, failed: 1, workersStarted: 1 })
    expect(executed).toEqual([first.id, second.id])
    expect(store.get(first.id)).toMatchObject({
      status: 'failed', terminalOutcome: 'cancelled',
    })
    expect(store.get(second.id)?.status).toBe('completed')
    store.close()
  })

  test('外部Claude境界が完了するまでrunningを維持し次Codexを起動しない', async () => {
    const store = makeStore()
    const first = store.enqueue(input({ messageId: 'first' })).job
    const second = store.enqueue(input({ messageId: 'second' })).job
    const executed: string[] = []
    let releaseBoundary!: () => void
    const boundaryRelease = new Promise<void>(resolve => { releaseBoundary = resolve })
    let reportBoundary!: () => void
    const boundaryEntered = new Promise<void>(resolve => { reportBoundary = resolve })
    const running = runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async job => {
        executed.push(job.messageId)
        return { sessionId: `session-${job.messageId}`, result: 'done' }
      },
      settleExternalContext: async job => {
        if (job.id !== first.id) return
        reportBoundary()
        await boundaryRelease
      },
    })
    await boundaryEntered
    expect(executed).toEqual(['first'])
    expect(store.get(first.id)?.status).toBe('running')
    expect(store.get(second.id)?.status).toBe('queued')
    expect(store.claimNext('another-worker')).toBeNull()
    releaseBoundary()
    expect(await running).toEqual({ completed: 2, failed: 0, workersStarted: 1 })
    expect(executed).toEqual(['first', 'second'])
    store.close()
  })

  test('monitorはClaude予約後に開き、DB terminal確定後だけ閉じる', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'monitor-order' })).job
    const order: string[] = []
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      prepareExternalContext: async () => { order.push('claude-reserved') },
      openJobMonitor: async current => {
        expect(store.get(current.id)?.status).toBe('running')
        order.push('monitor-open')
      },
      executor: async () => {
        order.push('executor')
        return { sessionId: 'monitor-session', result: 'monitor result' }
      },
      settleExternalContext: async () => { order.push('claude-cleared') },
      closeJobMonitor: async current => {
        expect(store.get(current.id)?.status).toBe('completed')
        order.push('monitor-close')
      },
    })
    expect(stats).toEqual({ completed: 1, failed: 0, workersStarted: 1 })
    expect(store.get(queued.id)?.status).toBe('completed')
    expect(order).toEqual([
      'claude-reserved', 'monitor-open', 'executor', 'claude-cleared', 'monitor-close',
    ])
    store.close()
  })

  test('Claude clearやresult checkpointがpendingならmonitorを閉じない', async () => {
    for (const pending of ['claude', 'result'] as const) {
      const store = makeStore()
      const queued = store.enqueue(input({ messageId: `monitor-pending-${pending}` })).job
      let closes = 0
      await expect(runQueuedJobs({
        store,
        maxJobsPerSession: 5,
        pollMs: 1,
        stopWhenIdle: true,
        openJobMonitor: async () => {},
        closeJobMonitor: async () => { closes += 1 },
        executor: async () => {
          if (pending === 'result') {
            throw new CodexResultPersistencePendingError('checkpoint pending')
          }
          return { sessionId: 'pending-session', result: 'pending result' }
        },
        settleExternalContext: async () => {
          throw new ClaudeContextClearPendingError('clear pending')
        },
      })).rejects.toBeInstanceOf(
        pending === 'result'
          ? CodexResultPersistencePendingError
          : ClaudeContextClearPendingError,
      )
      expect(store.get(queued.id)?.status).toBe('running')
      expect(closes).toBe(0)
      store.close()
    }
  })

  test('monitor openが曖昧なら未実行claimを戻してdaemonを止める', async () => {
    const store = makeStore()
    const first = store.enqueue(input({ messageId: 'monitor-open-pending-1' })).job
    const second = store.enqueue(input({ messageId: 'monitor-open-pending-2' })).job
    let executions = 0
    let clears = 0
    await expect(runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      prepareExternalContext: async () => {},
      settleExternalContext: async () => { clears += 1 },
      openJobMonitor: async () => {
        throw new HerdrJobMonitorPendingError('create response is ambiguous')
      },
      executor: async () => {
        executions += 1
        return { sessionId: 'never', result: 'never' }
      },
    })).rejects.toBeInstanceOf(HerdrJobMonitorPendingError)
    expect(executions).toBe(0)
    expect(clears).toBe(1)
    expect(store.get(first.id)).toMatchObject({ status: 'queued', attempts: 0 })
    expect(store.get(second.id)?.status).toBe('queued')
    store.close()
  })

  test('monitor open後Codex起動直前のhealth失敗も未実行claimへ戻す', async () => {
    const store = makeStore()
    const first = store.enqueue(input({
      messageId: 'monitor-pre-exec-health-1',
      writeEnabled: true,
    })).job
    const second = store.enqueue(input({ messageId: 'monitor-pre-exec-health-2' })).job
    let executions = 0
    let clears = 0
    let checks = 0
    await expect(runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      prepareExternalContext: async () => {},
      settleExternalContext: async () => { clears += 1 },
      openJobMonitor: async () => {},
      assertJobMonitorHealthy: () => {
        checks += 1
        throw new HerdrJobMonitorPendingError('viewer heartbeat is stale before Codex')
      },
      executor: async () => {
        executions += 1
        return { sessionId: 'never', result: 'never' }
      },
    })).rejects.toBeInstanceOf(HerdrJobMonitorPendingError)
    expect(executions).toBe(0)
    expect(clears).toBe(1)
    expect(checks).toBe(1)
    expect(store.get(first.id)).toMatchObject({ status: 'queued', attempts: 0 })
    expect(store.get(second.id)?.status).toBe('queued')
    store.close()
  })

  test('実行中monitorが消失したら次jobへ進まずrunningを回復対象に残す', async () => {
    const store = makeStore()
    const first = store.enqueue(input({ messageId: 'monitor-health-pending-1' })).job
    const second = store.enqueue(input({ messageId: 'monitor-health-pending-2' })).job
    const executed: string[] = []
    let clears = 0
    let closes = 0
    await expect(runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      openJobMonitor: async () => {},
      closeJobMonitor: async () => { closes += 1 },
      settleExternalContext: async () => { clears += 1 },
      executor: async current => {
        executed.push(current.id)
        throw new HerdrJobMonitorPendingError('viewer disappeared')
      },
    })).rejects.toBeInstanceOf(HerdrJobMonitorPendingError)
    expect(executed).toEqual([first.id])
    expect(clears).toBe(1)
    expect(closes).toBe(0)
    expect(store.get(first.id)?.status).toBe('running')
    expect(store.get(second.id)?.status).toBe('queued')
    store.close()
  })

  test('result checkpointからClaude clear完了までmonitor healthを維持する', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'monitor-health-clear-gap' })).job
    let checks = 0
    let clears = 0
    let closes = 0
    await expect(runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      openJobMonitor: async () => {},
      assertJobMonitorHealthy: () => {
        checks += 1
        if (checks === 4) throw new HerdrJobMonitorPendingError('heartbeat stopped during clear')
      },
      settleExternalContext: async () => { clears += 1 },
      closeJobMonitor: async () => { closes += 1 },
      executor: async () => ({ sessionId: 'health-session', result: 'durable result' }),
    })).rejects.toBeInstanceOf(HerdrJobMonitorPendingError)
    expect(checks).toBe(4)
    expect(clears).toBe(1)
    expect(closes).toBe(0)
    expect(store.get(queued.id)).toMatchObject({
      status: 'running',
      result: null,
    })
    expect(() => store.assertExecutionResultStaged(
      queued.id,
      'health-session',
      'durable result',
    )).not.toThrow()
    store.close()
  })

  test('Claude clear後status更新中のmonitor failureをDB terminal化前に止める', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'monitor-final-health-window' })).job
    let monitorFailed = false
    let closes = 0
    await expect(runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      openJobMonitor: async () => {},
      assertJobMonitorHealthy: () => {
        if (monitorFailed) {
          throw new HerdrJobMonitorPendingError('viewer failed after Claude clear')
        }
      },
      settleExternalContext: async () => {},
      updateJobMonitor: async (_job, message) => {
        if (message.includes('作業コンテキストを消去')) {
          await Bun.sleep(1)
          monitorFailed = true
        }
      },
      closeJobMonitor: async () => { closes += 1 },
      executor: async () => ({ sessionId: 'final-health-session', result: 'durable result' }),
    })).rejects.toBeInstanceOf(HerdrJobMonitorPendingError)
    expect(store.get(queued.id)?.status).toBe('running')
    expect(closes).toBe(0)
    expect(() => store.assertExecutionResultStaged(
      queued.id,
      'final-health-session',
      'durable result',
    )).not.toThrow()
    store.close()
  })

  test('status feed追記失敗をdurable化しstaged resultと後続jobをfail closedに保つ', async () => {
    const directory = fixtureDir()
    const database = join(directory, 'jobs.sqlite3')
    const store = new JobStore(database)
    const first = store.enqueue(input({ messageId: 'monitor-status-durable-1' })).job
    const second = store.enqueue(input({ messageId: 'monitor-status-durable-2' })).job
    const executed: string[] = []
    let closes = 0
    await expect(runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      openJobMonitor: async job => {
        const current = store.get(job.id)!
        store.beginMonitorPreparation(job.id, current.workerId!)
        store.commitMonitorRequired(job.id, current.workerId!)
      },
      updateJobMonitor: async () => { throw new Error('status feed write failed') },
      recordJobMonitorFailure: (job, error) => store.recordMonitorFailure(job.id, String(error)),
      closeJobMonitor: async () => { closes += 1 },
      executor: async job => {
        executed.push(job.id)
        return { sessionId: 'status-failure-session', result: 'durable result' }
      },
    })).rejects.toBeInstanceOf(HerdrJobMonitorPendingError)
    expect(executed).toEqual([first.id])
    expect(store.get(first.id)).toMatchObject({ status: 'running', monitorState: 'required' })
    expect(store.hasStagedExecution(first.id)).toBe(true)
    expect(store.get(second.id)?.status).toBe('queued')
    expect(closes).toBe(0)
    expect(store.monitorFailure(first.id)?.reasonDigest).toMatch(/^[0-9a-f]{64}$/)
    store.close()

    const reopened = new JobStore(database)
    expect(() => reopened.monitorObligations()).toThrow('durable Herdr monitor failure')
    expect(() => reopened.completeStagedExecution(first.id)).toThrow('job is no longer running')
    reopened.close()
  })

  test('rate-limitと通常失敗のstatus追記失敗はDB mutation前にFIFOを止める', async () => {
    for (const mode of ['rate-limit', 'failure'] as const) {
      const store = makeStore()
      const first = store.enqueue(input({ messageId: `monitor-${mode}-1` })).job
      const second = store.enqueue(input({ messageId: `monitor-${mode}-2` })).job
      const executed: string[] = []
      await expect(runQueuedJobs({
        store,
        maxJobsPerSession: 5,
        pollMs: 1,
        stopWhenIdle: true,
        openJobMonitor: async job => {
          const current = store.get(job.id)!
          store.beginMonitorPreparation(job.id, current.workerId!)
          store.commitMonitorRequired(job.id, current.workerId!)
        },
        updateJobMonitor: async () => { throw new Error('status feed write failed') },
        recordJobMonitorFailure: (job, error) => store.recordMonitorFailure(job.id, String(error)),
        executor: async job => {
          executed.push(job.id)
          if (mode === 'rate-limit') {
            throw new CodexRateLimitError('limited', Date.now(), 'resume-id')
          }
          throw new Error('execution failed')
        },
      })).rejects.toBeInstanceOf(HerdrJobMonitorPendingError)
      expect(executed).toEqual([first.id])
      expect(store.get(first.id)).toMatchObject({
        status: 'running',
        notBefore: null,
        lastError: null,
      })
      expect(store.get(second.id)?.status).toBe('queued')
      expect(store.monitorFailure(first.id)).not.toBeNull()
      store.close()
    }
  })

  test('in-flight monitor probeをsettleするまでDB terminalへ進めない', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'monitor-inflight-final-barrier' })).job
    let enterQuiesce!: () => void
    const quiesceEntered = new Promise<void>(resolve => { enterQuiesce = resolve })
    let releaseQuiesce!: () => void
    const quiesceRelease = new Promise<void>(resolve => { releaseQuiesce = resolve })
    let closes = 0
    const running = runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      openJobMonitor: async () => {},
      assertJobMonitorHealthy: () => {},
      quiesceJobMonitor: async () => {
        enterQuiesce()
        await quiesceRelease
        throw new HerdrJobMonitorPendingError('in-flight process-info failed')
      },
      settleExternalContext: async () => {},
      closeJobMonitor: async () => { closes += 1 },
      executor: async () => ({ sessionId: 'inflight-session', result: 'durable result' }),
    })
    await quiesceEntered
    expect(store.get(queued.id)?.status).toBe('running')
    releaseQuiesce()
    await expect(running).rejects.toBeInstanceOf(HerdrJobMonitorPendingError)
    expect(store.get(queued.id)?.status).toBe('running')
    expect(closes).toBe(0)
    store.close()
  })

  test('read-only rate limit retryは同じmonitorを保持し最終成功後だけ閉じる', async () => {
    const store = makeStore()
    store.enqueue(input({ messageId: 'monitor-rate-limit' }))
    let executions = 0
    let opens = 0
    let closes = 0
    const first = await runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      openJobMonitor: async () => { opens += 1 },
      closeJobMonitor: async () => { closes += 1 },
      executor: async () => {
        executions += 1
        if (executions === 1) {
          throw new CodexRateLimitError('rate limited', Date.now() - 60_000, 'resume-session')
        }
        return { sessionId: 'resume-session', result: 'done' }
      },
    })
    expect(first).toEqual({ completed: 0, failed: 0, workersStarted: 1 })
    const notBefore = store.list()[0]?.notBefore
    expect(notBefore).toEqual(expect.any(Number))
    await Bun.sleep(Math.max(0, notBefore! - Date.now()) + 1)
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      openJobMonitor: async () => { opens += 1 },
      closeJobMonitor: async () => { closes += 1 },
      executor: async () => {
        executions += 1
        return { sessionId: 'resume-session', result: 'done' }
      },
    })
    expect(stats).toEqual({ completed: 1, failed: 0, workersStarted: 1 })
    expect(executions).toBe(2)
    expect(opens).toBe(2)
    expect(closes).toBe(1)
    store.close()
  })

  test('legacy executorのps失敗や空出力を死亡扱いしない', () => {
    expect(classifyFallbackProcessState('present', 1, '')).toBe('unknown')
    expect(classifyFallbackProcessState('present', 0, '')).toBe('unknown')
    expect(classifyFallbackProcessState('unknown', 0, 'S')).toBe('unknown')
    expect(classifyFallbackProcessState('missing', 1, '')).toBe('dead')
    expect(classifyFallbackProcessState('present', 0, 'Z+')).toBe('dead')
    expect(classifyFallbackProcessState('present', 0, 'S+')).toBe('alive')
  })

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

  test('crash recoveryはadvisor journalありread jobを再送せず、空nonceだけならrequeueする', () => {
    const deliveredDir = fixtureDir()
    const deliveredState = join(deliveredDir, 'state')
    mkdirSync(deliveredState, { mode: 0o700 })
    const deliveredStore = new JobStore(join(deliveredState, 'jobs.sqlite3'))
    deliveredStore.enqueue(input())
    const deliveredJob = deliveredStore.claimNext('serial-worker')!
    const journal = join(
      deliveredState,
      'advisor-journal',
      deliveredJob.id,
      'f'.repeat(32),
      'investigation-1.json',
    )
    mkdirSync(dirname(journal), { recursive: true, mode: 0o700 })
    writeFileSync(journal, '{"status":"requested"}\n', { mode: 0o600 })
    expect(deliveredStore.recoverInterrupted(deliveredState)).toEqual({
      requeued: 0,
      failedWrites: 0,
      failedUncertain: 1,
    })
    expect(deliveredStore.get(deliveredJob.id)?.status).toBe('failed')
    deliveredStore.close()

    const emptyDir = fixtureDir()
    const emptyState = join(emptyDir, 'state')
    mkdirSync(emptyState, { mode: 0o700 })
    const emptyStore = new JobStore(join(emptyState, 'jobs.sqlite3'))
    emptyStore.enqueue(input({ messageId: 'empty-nonce' }))
    const emptyJob = emptyStore.claimNext('serial-worker')!
    mkdirSync(join(
      emptyState,
      'advisor-journal',
      emptyJob.id,
      'e'.repeat(32),
    ), { recursive: true, mode: 0o700 })
    expect(emptyStore.recoverInterrupted(emptyState)).toEqual({
      requeued: 1,
      failedWrites: 0,
      failedUncertain: 0,
    })
    expect(emptyStore.get(emptyJob.id)?.status).toBe('queued')
    emptyStore.close()
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

  test('read-only rate limitは5回を越えても時間上限なく同じjobを再開する', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'unbounded-rate-limit' })).job
    let calls = 0
    let completed = 0
    let failed = 0
    while (store.get(queued.id)?.status !== 'completed') {
      const stats = await runQueuedJobs({
        store,
        maxJobsPerSession: 20,
        pollMs: 1,
        stopWhenIdle: true,
        executor: async () => {
          calls += 1
          if (calls <= 6) {
            throw new CodexRateLimitError(
              `rate limited ${calls}`,
              Date.now() - 120_000,
              'thread-unbounded-rate',
            )
          }
          return { sessionId: 'thread-unbounded-rate', result: 'done' }
        },
      })
      completed += stats.completed
      failed += stats.failed
      const notBefore = store.get(queued.id)?.notBefore
      if (notBefore !== null && notBefore !== undefined && notBefore > Date.now()) {
        await Bun.sleep(notBefore - Date.now() + 1)
      }
    }
    expect(calls).toBe(7)
    expect({ completed, failed }).toEqual({ completed: 1, failed: 0 })
    expect(store.get(queued.id)).toMatchObject({ status: 'completed', result: 'done' })
    store.close()
  })

  test('write jobも初回turn送達前のrate limitなら安全に同じjobを再開する', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({
      messageId: 'write-pre-dispatch-rate-limit', writeEnabled: true,
    })).job
    let calls = 0
    const first = await runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async () => {
        calls += 1
        if (calls === 1) {
          throw new CodexRateLimitError(
            'rate limited before initial turn', Date.now() - 120_000,
          )
        }
        return { sessionId: 'thread-write-safe-retry', result: 'done' }
      },
    })
    expect(first).toEqual({ completed: 0, failed: 0, workersStarted: 1 })
    const notBefore = store.get(queued.id)?.notBefore
    expect(notBefore).toEqual(expect.any(Number))
    await Bun.sleep(Math.max(0, notBefore! - Date.now()) + 1)
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      pollMs: 1,
      stopWhenIdle: true,
      executor: async () => {
        calls += 1
        return { sessionId: 'thread-write-safe-retry', result: 'done' }
      },
    })
    expect(calls).toBe(2)
    expect(stats).toEqual({ completed: 1, failed: 0, workersStarted: 1 })
    expect(store.get(queued.id)).toMatchObject({ status: 'completed', result: 'done' })
    store.close()
  })

  test('rate-limit待機中の同じthreadはcontrolを保持し、中止なら待刻を飛ばして再claimする', () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'rate-live-root' })).job
    const first = store.claimNext('serial-worker')!
    store.beginMonitorPreparation(first.id, first.workerId!)
    store.commitMonitorRequired(first.id, first.workerId!)
    store.requeueAt(first.id, Date.now() + 60_000, 'rate limited', 'thread-rate-live')

    const target = store.liveControlTarget(first.chatId, first.threadTs)
    expect(target).toEqual({
      jobId: queued.id,
      epoch: 1,
      repoPath: first.repoPath,
      writeEnabled: first.writeEnabled,
    })
    expect(store.stageLiveControl(target!, {
      chatId: first.chatId,
      threadTs: first.threadTs,
      messageId: 'rate-live-stop',
      userId: 'UOTHER',
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')
    expect(store.countClaimable()).toBe(1)
    expect(store.claimableHeadId()).toBe(queued.id)
    expect(store.claimNext('serial-worker')?.id).toBe(queued.id)
    store.close()
  })

  test('rate-limit terminalのdurable時刻からrunner crash後も同じread jobを再開する', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    const store = new JobStore(path)
    store.enqueue(input({ messageId: 'rate-terminal-crash' }))
    const running = store.claimNext('serial-worker')!
    const snapshot = readAdvisorInputSnapshot(dir, running.id)
    const nonce = '7'.repeat(32)
    expect(store.beginInitialTurnDispatch({
      jobId: running.id,
      attempt: running.attempts,
      epoch: running.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-rate-crash',
      requestId: 71,
      inputRevision: snapshot.revision,
      inputDigest: snapshot.digest,
    })).toBe('dispatching')
    store.acknowledgeInitialTurnDispatch({
      jobId: running.id,
      workerId: running.workerId!,
      attempt: running.attempts,
      epoch: running.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-rate-crash',
      turnId: 'turn-rate-crash',
      requestId: 71,
    })
    const resumeAt = Date.now() + 120_000
    expect(store.finishAppServerTurn({
      jobId: running.id,
      epoch: running.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-rate-crash',
      turnId: 'turn-rate-crash',
      retainInput: true,
      rateLimitResumeAt: resumeAt,
    })).toEqual({ closeInput: false, cancelled: false, pending: 0, pendingInbound: 0 })
    store.close()

    const recovered = new JobStore(path)
    expect(recovered.recoverInterrupted()).toEqual({
      requeued: 1, failedWrites: 0, failedUncertain: 0,
    })
    expect(recovered.get(running.id)).toMatchObject({
      status: 'queued', sessionId: 'thread-rate-crash', notBefore: resumeAt, acceptsControl: true,
    })
    expect(recovered.liveControlTarget(running.chatId, running.threadTs)?.jobId).toBe(running.id)
    recovered.close()
  })

  test('uncorrelated App Server rate-limitもcrash前に再開可能状態へ固定する', () => {
    const dir = fixtureDir()
    const path = join(dir, 'jobs.sqlite3')
    const store = new JobStore(path)
    store.enqueue(input({ messageId: 'rate-error-notification-crash' }))
    const running = store.claimNext('serial-worker')!
    const snapshot = readAdvisorInputSnapshot(dir, running.id)
    const nonce = '8'.repeat(32)
    expect(store.beginInitialTurnDispatch({
      jobId: running.id,
      attempt: running.attempts,
      epoch: running.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-rate-error',
      requestId: 81,
      inputRevision: snapshot.revision,
      inputDigest: snapshot.digest,
    })).toBe('dispatching')
    store.acknowledgeInitialTurnDispatch({
      jobId: running.id,
      workerId: running.workerId!,
      attempt: running.attempts,
      epoch: running.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-rate-error',
      turnId: 'turn-rate-error',
      requestId: 81,
    })
    const resumeAt = Date.now() + 120_000
    store.recordAppServerRateLimit({
      jobId: running.id,
      epoch: running.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-rate-error',
      turnId: 'turn-rate-error',
      resumeAt,
    })
    store.close()

    const recovered = new JobStore(path)
    expect(recovered.recoverInterrupted()).toEqual({
      requeued: 1, failedWrites: 0, failedUncertain: 0,
    })
    expect(recovered.get(running.id)).toMatchObject({
      status: 'queued', sessionId: 'thread-rate-error', notBefore: resumeAt, acceptsControl: true,
    })
    recovered.close()
  })

  test('rate-limit terminalからrequeueまで同じthreadの中止受付を閉じない', () => {
    const store = makeStore()
    store.enqueue(input({ messageId: 'rate-terminal-window' }))
    const running = store.claimNext('serial-worker')!
    const nonce = 'f'.repeat(32)
    store.bindAppServerTurn(
      running.id, running.workerId!, running.controlEpoch,
      nonce, 'thread-rate-window', 'turn-rate-window',
    )
    expect(store.finishAppServerTurn({
      jobId: running.id,
      epoch: running.controlEpoch,
      executorNonce: nonce,
      threadId: 'thread-rate-window',
      turnId: 'turn-rate-window',
      retainInput: true,
    })).toEqual({ closeInput: false, cancelled: false, pending: 0, pendingInbound: 0 })
    const target = store.liveControlTarget(running.chatId, running.threadTs)
    expect(target).toEqual({
      jobId: running.id,
      epoch: running.controlEpoch,
      repoPath: running.repoPath,
      writeEnabled: running.writeEnabled,
    })
    expect(store.stageLiveControl(target!, {
      chatId: running.chatId,
      threadTs: running.threadTs,
      messageId: 'rate-terminal-stop',
      userId: 'UOTHER',
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')
    store.requeueAt(
      running.id, Date.now() + 60_000, 'rate limited', 'thread-rate-window',
    )
    expect(store.countClaimable()).toBe(1)
    expect(store.claimNext('serial-worker')).toMatchObject({
      id: running.id,
      cancelRequestedAt: expect.any(Number),
    })
    store.close()
  })

  test('rate-limit待機中の中止はCodexやClaude準備を起動せずhost側で確定する', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'queued-cancel-root' })).job
    const first = store.claimNext('serial-worker')!
    store.beginMonitorPreparation(first.id, first.workerId!)
    store.commitMonitorRequired(first.id, first.workerId!)
    store.requeueAt(first.id, Date.now() + 60_000, 'rate limited', 'queued-cancel-session')
    const retainedTarget = store.liveControlTarget(first.chatId, first.threadTs)!
    expect(store.stageLiveControl(retainedTarget, {
      chatId: first.chatId,
      threadTs: first.threadTs,
      messageId: 'queued-cancel-stop',
      userId: 'UOTHER',
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')

    let prepared = 0
    let opened = 0
    let started = 0
    let executed = 0
    let settled = 0
    let quiesced = 0
    let closedOutcome: JobRecord['terminalOutcome'] | null = null
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      pollMs: 1,
      stopWhenIdle: true,
      prepareExternalContext: async () => { prepared += 1 },
      settleExternalContext: async () => { settled += 1 },
      openJobMonitor: async () => { opened += 1 },
      quiesceJobMonitor: async () => { quiesced += 1 },
      closeJobMonitor: async job => { closedOutcome = job.terminalOutcome },
      notifier: { started: async () => { started += 1 } },
      executor: async () => {
        executed += 1
        return { sessionId: 'must-not-run', result: 'must-not-run' }
      },
    })
    expect(stats).toEqual({ completed: 0, failed: 1, workersStarted: 1 })
    expect({ prepared, opened, started, executed, settled, quiesced, closedOutcome }).toEqual({
      prepared: 0,
      opened: 0,
      started: 0,
      executed: 0,
      settled: 1,
      quiesced: 1,
      closedOutcome: 'cancelled',
    })
    expect(store.get(queued.id)).toMatchObject({
      status: 'failed', terminalOutcome: 'cancelled', acceptsControl: false,
    })
    store.close()
  })

  test('未claim jobの中止は存在しないmonitorやClaude paneを操作せず確定する', async () => {
    const store = makeStore()
    const queued = store.enqueue(input({ messageId: 'fresh-queued-cancel-root' })).job
    const target = store.liveControlTarget(queued.chatId, queued.threadTs)!
    expect(store.stageLiveControl(target, {
      chatId: queued.chatId,
      threadTs: queued.threadTs,
      messageId: 'fresh-queued-cancel-stop',
      userId: 'UOTHER',
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')
    let externalCalls = 0
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      pollMs: 1,
      stopWhenIdle: true,
      prepareExternalContext: async () => { externalCalls += 1 },
      settleExternalContext: async () => { externalCalls += 1 },
      openJobMonitor: async () => { externalCalls += 1 },
      quiesceJobMonitor: async () => { externalCalls += 1 },
      closeJobMonitor: async () => { externalCalls += 1 },
      executor: async () => {
        externalCalls += 1
        return { sessionId: 'must-not-run', result: 'must-not-run' }
      },
    })
    expect(stats).toEqual({ completed: 0, failed: 1, workersStarted: 1 })
    expect(externalCalls).toBe(0)
    expect(store.get(queued.id)).toMatchObject({
      status: 'failed', terminalOutcome: 'cancelled', monitorState: 'none',
    })
    store.close()
  })

  test('advisor journal作成後のread rate limitは自動再送せずfailedにする', async () => {
    const dir = fixtureDir()
    const state = join(dir, 'state')
    mkdirSync(state, { mode: 0o700 })
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    const queued = store.enqueue(input()).job
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      advisorStateDir: state,
      executor: async job => {
        const journal = join(
          state,
          'advisor-journal',
          job.id,
          'f'.repeat(32),
          'investigation-1.json',
        )
        mkdirSync(dirname(journal), { recursive: true, mode: 0o700 })
        writeFileSync(journal, '{"status":"requested"}\n', { mode: 0o600 })
        throw new CodexRateLimitError('rate limited after advisor delivery', Date.now() + 60_000)
      },
    })
    expect(stats).toEqual({ completed: 0, failed: 1, workersStarted: 1 })
    expect(store.get(queued.id)).toMatchObject({ status: 'failed' })
    expect(store.get(queued.id)?.lastError).toContain('will not be resent automatically')
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
      executor: async job => {
        const boundInput = readAdvisorInputSnapshot(dirname(store.dbPath), job.id)
        const nonce = 'c'.repeat(32)
        expect(store.beginInitialTurnDispatch({
          jobId: job.id,
          attempt: job.attempts,
          epoch: job.controlEpoch,
          executorNonce: nonce,
          threadId: 'thread-write',
          requestId: 41,
          inputRevision: boundInput.revision,
          inputDigest: boundInput.digest,
        })).toBe('dispatching')
        store.acknowledgeInitialTurnDispatch({
          jobId: job.id,
          workerId: job.workerId!,
          attempt: job.attempts,
          epoch: job.controlEpoch,
          executorNonce: nonce,
          threadId: 'thread-write',
          turnId: 'turn-write',
          requestId: 41,
        })
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

  test('write implementation送信後のreview失敗は副作用警告とClaude clear後に次threadへ進む', async () => {
    const store = makeStore()
    const first = store.enqueue(input({
      messageId: 'write-review-failure-first',
      threadTs: '1800000000.100001',
      writeEnabled: true,
    })).job
    store.enqueue(input({
      messageId: 'write-review-failure-second',
      threadTs: '1800000000.100002',
      writeEnabled: false,
    }))
    let executions = 0
    let settled = 0
    const stats = await runQueuedJobs({
      store,
      maxJobsPerSession: 20,
      pollMs: 1,
      stopWhenIdle: true,
      settleExternalContext: async () => { settled += 1 },
      executor: async job => {
        executions += 1
        if (job.id !== first.id) {
          return { sessionId: 'next-thread-session', result: 'next thread completed' }
        }
        const snapshot = readAdvisorInputSnapshot(dirname(store.dbPath), job.id)
        const nonce = 'd'.repeat(32)
        expect(store.beginInitialTurnDispatch({
          jobId: job.id,
          attempt: job.attempts,
          epoch: job.controlEpoch,
          executorNonce: nonce,
          threadId: 'write-review-thread',
          requestId: 51,
          inputRevision: snapshot.revision,
          inputDigest: snapshot.digest,
        })).toBe('dispatching')
        store.acknowledgeInitialTurnDispatch({
          jobId: job.id,
          workerId: job.workerId!,
          attempt: job.attempts,
          epoch: job.controlEpoch,
          executorNonce: nonce,
          threadId: 'write-review-thread',
          turnId: 'prepare-turn',
          requestId: 51,
        })
        store.finishAppServerTurn({
          jobId: job.id,
          epoch: job.controlEpoch,
          executorNonce: nonce,
          threadId: 'write-review-thread',
          turnId: 'prepare-turn',
          retainInput: true,
        })
        expect(store.prepareAppServerPhaseDispatch({
          jobId: job.id,
          attempt: job.attempts,
          epoch: job.controlEpoch,
          phaseSequence: 1,
          stage: 'implementation',
          logicalNonce: nonce,
          threadId: 'write-review-thread',
          inputRevision: snapshot.revision,
          inputDigest: snapshot.digest,
        })).toBe(`${job.id}:phase:1`)
        expect(store.beginAppServerPhaseDispatch({
          jobId: job.id,
          attempt: job.attempts,
          epoch: job.controlEpoch,
          phaseSequence: 1,
          logicalNonce: nonce,
          threadId: 'write-review-thread',
          requestId: 52,
          inputRevision: snapshot.revision,
          inputDigest: snapshot.digest,
        })).toBe('dispatching')
        throw new Error('review envelope was malformed')
      },
    })
    expect(stats).toEqual({ completed: 1, failed: 1, workersStarted: 1 })
    expect(executions).toBe(2)
    expect(settled).toBe(2)
    expect(store.get(first.id)).toMatchObject({ status: 'failed', writeEnabled: true })
    expect(store.get(first.id)?.lastError).toContain('may already have changed')
    expect(store.get(first.id)?.lastError).toContain('review envelope was malformed')
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

  test('monitor消失復旧はqueued/running jobを二重処理できないterminal失敗へ固定する', () => {
    const store = makeStore()
    const running = store.enqueue(input({ messageId: 'lost-running' })).job
    expect(store.claimNext('serial-worker')?.id).toBe(running.id)
    const queued = store.enqueue(input({ messageId: 'lost-queued' })).job

    expect(store.failAfterMonitorLoss(running.id, 'monitor lost running')).toBe(true)
    expect(store.failAfterMonitorLoss(queued.id, 'monitor lost queued')).toBe(true)
    expect(store.failAfterMonitorLoss(running.id, 'duplicate')).toBe(false)
    expect(store.get(running.id)).toMatchObject({
      status: 'failed',
      workerId: null,
      executorPid: null,
      lastError: 'monitor lost running',
    })
    expect(store.get(queued.id)).toMatchObject({
      status: 'failed',
      workerId: null,
      lastError: 'monitor lost queued',
    })
    expect(store.pendingTerminalNotifications().map(notification => ({
      jobId: notification.jobId,
      kind: notification.kind,
      payload: notification.payload,
    }))).toEqual([
      { jobId: running.id, kind: 'failed', payload: 'monitor lost running' },
      { jobId: queued.id, kind: 'failed', payload: 'monitor lost queued' },
    ])
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
      '--unverified-for-tests',
      '--',
      fakeCodex,
    ], {
      cwd: repo,
      env: { ...process.env, ZEROKUN_SUPERVISOR_TEST_UNVERIFIED: '1' },
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
      expect(store.recoverInterrupted()).toEqual({ requeued: 1, failedWrites: 0, failedUncertain: 0 })
      expect(store.get(job.id)).toMatchObject({ status: 'queued', executorPid: null })
    } finally {
      try { supervisor.kill('SIGKILL') } catch {}
      store.close()
    }
  })

  test('runnerのstdout pipe切断後もsupervisorはCodex監督を継続する', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, '#!/bin/bash\nsleep 0.1\necho after-runner-exit\nsleep 30\n')
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
      '--unverified-for-tests',
      '--',
      fakeCodex,
    ], {
      cwd: repo,
      env: { ...process.env, ZEROKUN_SUPERVISOR_TEST_UNVERIFIED: '1' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
      detached: process.platform !== 'win32',
    })
    try {
      const deadline = Date.now() + 2_000
      while (!existsSync(registration) && Date.now() < deadline) await Bun.sleep(10)
      expect(existsSync(registration)).toBe(true)
      await supervisor.stdout.cancel()
      await Bun.sleep(300)
      expect(() => process.kill(supervisor.pid, 0)).not.toThrow()
      await terminateTrackedExecutors(store, () => {}, 2_000, dir)
      await supervisor.exited
      expect(existsSync(registration)).toBe(false)
    } finally {
      try { supervisor.kill('SIGKILL') } catch {}
      store.close()
    }
  })

  test('runnerがstdout pipeを開いたまま読まなくてもsupervisorは停止しない', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, [
      '#!/bin/bash',
      '( sleep 0.1; dd if=/dev/zero bs=1048576 count=8 2>/dev/null; sleep 30 ) &',
      'sleep 0.2',
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(fakeCodex, 0o755)
    const registration = join(dir, 'executors', 'unread-output.json')
    mkdirSync(join(dir, 'executors'), { recursive: true })
    const supervisor = Bun.spawn([
      process.execPath,
      join(import.meta.dir, 'codex-supervisor.ts'),
      'unread-output',
      registration,
      '--unverified-for-tests',
      '--',
      fakeCodex,
    ], {
      cwd: repo,
      env: { ...process.env, ZEROKUN_SUPERVISOR_TEST_UNVERIFIED: '1' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      detached: process.platform !== 'win32',
    })
    try {
      const deadline = Date.now() + 6_000
      while (readProcessIdentity(supervisor.pid) && Date.now() < deadline) await Bun.sleep(25)
      expect(readProcessIdentity(supervisor.pid)).toBeUndefined()
      await supervisor.stdout.cancel().catch(() => {})
      await supervisor.stderr.cancel().catch(() => {})
      await supervisor.exited
      expect(JSON.parse(readFileSync(registration, 'utf8')).phase).toBe('cleanup-confirmed')
    } finally {
      try { supervisor.kill('SIGKILL') } catch {}
      await supervisor.stdout.cancel().catch(() => {})
      await supervisor.stderr.cancel().catch(() => {})
    }
  }, 10_000)

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
    const identity = readProcessIdentity(unrelated.pid)
    expect(identity).toBeDefined()
    writeFileSync(registration, JSON.stringify({
      jobId: job.id,
      pid: unrelated.pid,
      pgid: unrelated.pid,
      started: `${identity!.started} stale`,
      bootSession: identity!.bootSession,
      startSec: identity!.startSec,
      startUsec: identity!.startUsec,
    }))
    const claimed = store.get(job.id)!
    store.beginMonitorPreparation(job.id, claimed.workerId!)
    store.commitMonitorRequired(job.id, claimed.workerId!)
    store.saveExecutorPid(job.id, unrelated.pid)
    try {
      await terminateTrackedExecutors(store, () => {}, 100, dir)
      expect(unrelated.exitCode).toBeNull()
      expect(existsSync(registration)).toBe(false)
      expect(store.get(job.id)?.executorPid).toBeNull()
      expect(store.recoverInterrupted()).toEqual({ requeued: 1, failedWrites: 0, failedUncertain: 0 })
    } finally {
      unrelated.kill('SIGKILL')
      await unrelated.exited
      store.close()
    }
  })

  test.skipIf(process.platform !== 'darwin')(
    'v3はsupervisor PID再利用時も無関係processを残してledger子だけ回収する',
    async () => {
      const dir = fixtureDir()
      const store = new JobStore(join(dir, 'jobs.sqlite3'))
      const job = store.enqueue(input({ messageId: 'v3-reused-root' })).job
      const claimed = store.claimNext('serial-worker')!
      const unrelated = Bun.spawn(['/bin/sleep', '30'], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      })
      const trackedChild = Bun.spawn(['/bin/sleep', '30'], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      })
      const unrelatedIdentity = readProcessIdentity(unrelated.pid)!
      const childIdentity = readProcessIdentity(trackedChild.pid)!
      const staleGeneration = {
        bootSession: unrelatedIdentity.bootSession,
        startSec: unrelatedIdentity.startSec + 1,
        startUsec: unrelatedIdentity.startUsec,
      }
      const staleStarted = processStartKey(staleGeneration)
      const registration = join(dir, 'executors', `${job.id}.json`)
      mkdirSync(dirname(registration), { recursive: true })
      writeFileSync(registration, `${JSON.stringify({
        version: 3,
        phase: 'active',
        revision: 1,
        cleanupPending: true,
        jobId: job.id,
        pid: unrelated.pid,
        pgid: unrelated.pid,
        started: staleStarted,
        ...staleGeneration,
        tracked: [
          { pid: unrelated.pid, started: staleStarted },
          { pid: trackedChild.pid, started: childIdentity.started },
        ],
      })}\n`, { mode: 0o600 })
      store.beginMonitorPreparation(job.id, claimed.workerId!)
      store.commitMonitorRequired(job.id, claimed.workerId!)
      store.saveExecutorPid(job.id, unrelated.pid)

      try {
        await terminateTrackedExecutors(store, () => {}, 100, dir)
        expect(unrelated.exitCode).toBeNull()
        await trackedChild.exited
        expect(observeProcessGeneration(childIdentity).status).not.toBe('alive')
        expect(existsSync(registration)).toBe(false)
        expect(store.get(job.id)?.executorPid).toBeNull()
      } finally {
        unrelated.kill('SIGKILL')
        trackedChild.kill('SIGKILL')
        await Promise.all([unrelated.exited, trackedChild.exited])
        store.close()
      }
    },
  )

  test.skipIf(process.platform !== 'darwin')(
    'v3はsupervisor死亡後もledger子をrootに固定点探索して未記録の孫を回収する',
    async () => {
      const dir = fixtureDir()
      const store = new JobStore(join(dir, 'jobs.sqlite3'))
      const job = store.enqueue(input({ messageId: 'v3-dead-root-descendant' })).job
      const claimed = store.claimNext('serial-worker')!
      const descendantPidPath = join(dir, 'descendant.pid')
      const trackedParent = Bun.spawn([
        '/bin/bash', '-c', 'sleep 30 & child=$!; echo "$child" > "$1"; wait "$child"',
        'v3-ledger-parent', descendantPidPath,
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      const parentIdentity = readProcessIdentity(trackedParent.pid)!
      const deadline = Date.now() + 2_000
      while (!existsSync(descendantPidPath) && Date.now() < deadline) await Bun.sleep(10)
      expect(existsSync(descendantPidPath)).toBe(true)
      const descendantPid = Number(readFileSync(descendantPidPath, 'utf8').trim())
      const descendantIdentity = readProcessIdentity(descendantPid)!
      expect(descendantIdentity.ppid).toBe(trackedParent.pid)

      const deadSupervisorPid = 999_991
      const deadGeneration = {
        bootSession: parentIdentity.bootSession,
        startSec: 1,
        startUsec: 1,
      }
      const deadStarted = processStartKey(deadGeneration)
      const registration = join(dir, 'executors', `${job.id}.json`)
      mkdirSync(dirname(registration), { recursive: true })
      writeFileSync(registration, `${JSON.stringify({
        version: 3,
        phase: 'active',
        revision: 1,
        cleanupPending: true,
        jobId: job.id,
        pid: deadSupervisorPid,
        pgid: deadSupervisorPid,
        started: deadStarted,
        ...deadGeneration,
        tracked: [
          { pid: deadSupervisorPid, started: deadStarted },
          { pid: trackedParent.pid, started: parentIdentity.started },
        ],
      })}\n`, { mode: 0o600 })
      store.beginMonitorPreparation(job.id, claimed.workerId!)
      store.commitMonitorRequired(job.id, claimed.workerId!)
      store.saveExecutorPid(job.id, deadSupervisorPid)

      try {
        await terminateTrackedExecutors(store, () => {}, 100, dir)
        await trackedParent.exited
        expect(observeProcessGeneration(parentIdentity).status).not.toBe('alive')
        expect(observeProcessGeneration(descendantIdentity).status).not.toBe('alive')
        expect(existsSync(registration)).toBe(false)
      } finally {
        trackedParent.kill('SIGKILL')
        signalProcessIfLive(descendantIdentity, 'SIGKILL')
        await trackedParent.exited
        store.close()
      }
    },
  )

  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'v4 recoveryはsupervisor死亡後のreparent済みSeatbelt子も回収してからFIFOを開く',
    async () => {
      const dir = fixtureDir('zerokun-v4-seatbelt-recovery-')
      const store = new JobStore(join(dir, 'jobs.sqlite3'))
      const job = store.enqueue(input({ messageId: 'v4-seatbelt-recovery' })).job
      const claimed = store.claimNext('serial-worker')!
      const fingerprint = createSeatbeltFingerprint(dir, job.id, 'e'.repeat(32))
      const escapedPidPath = join(dir, 'escaped.pid')
      const code = [
        'import os,sys,time',
        'pid=os.fork()',
        'if pid:',
        ' open(sys.argv[1],"w").write(str(pid))',
        ' os._exit(0)',
        'os.setsid()',
        'os.close(0);os.close(1);os.close(2)',
        'time.sleep(60)',
      ].join('\n')
      const profile = [
        '(version 1)',
        '(allow default)',
        `(deny file-read-data (literal ${JSON.stringify(fingerprint.deny.path)}))`,
      ].join('\n')
      const launcher = Bun.spawn([
        '/usr/bin/sandbox-exec', '-p', profile,
        '/usr/bin/python3', '-c', code, escapedPidPath,
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      expect(await launcher.exited).toBe(0)
      const deadline = Date.now() + 2_000
      while (!existsSync(escapedPidPath) && Date.now() < deadline) await Bun.sleep(10)
      const escapedPid = Number(readFileSync(escapedPidPath, 'utf8'))
      const escapedIdentity = readProcessIdentity(escapedPid)!
      expect(escapedIdentity.ppid).toBe(1)

      const deadSupervisorPid = 999_992
      const generation = {
        bootSession: escapedIdentity.bootSession,
        startSec: 1,
        startUsec: 1,
      }
      const started = processStartKey(generation)
      const registration = join(dir, 'executors', `${job.id}.json`)
      mkdirSync(dirname(registration), { recursive: true })
      writeFileSync(registration, `${JSON.stringify({
        version: 4,
        phase: 'active',
        revision: 1,
        cleanupPending: true,
        jobId: job.id,
        pid: deadSupervisorPid,
        pgid: deadSupervisorPid,
        started,
        ...generation,
        tracked: [{ pid: deadSupervisorPid, started }],
        fingerprint,
      })}\n`, { mode: 0o600 })
      store.beginMonitorPreparation(job.id, claimed.workerId!)
      store.commitMonitorRequired(job.id, claimed.workerId!)
      store.saveExecutorPid(job.id, deadSupervisorPid)

      try {
        await terminateTrackedExecutors(store, () => {}, 100, dir)
        expect(observeProcessGeneration(escapedIdentity).status).toBe('dead')
        expect(existsSync(registration)).toBe(false)
        expect(existsSync(fingerprint.allow.path)).toBe(false)
        expect(store.get(job.id)?.executorPid).toBeNull()
      } finally {
        signalProcessIfLive(escapedIdentity, 'SIGKILL')
        store.close()
      }
    },
    10_000,
  )

  test('v3の重複generation ledgerはsignal前にfail closedにする', async () => {
    const dir = fixtureDir()
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    const job = store.enqueue(input({ messageId: 'v3-duplicate-ledger' })).job
    const generation = processStartKey({
      bootSession: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      startSec: 1_800_000_000,
      startUsec: 123456,
    })
    const registration = join(dir, 'executors', `${job.id}.json`)
    mkdirSync(dirname(registration), { recursive: true })
    writeFileSync(registration, `${JSON.stringify({
      version: 3,
      phase: 'active',
      revision: 0,
      cleanupPending: true,
      jobId: job.id,
      pid: 424242,
      pgid: 424242,
      started: generation,
      bootSession: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      startSec: 1_800_000_000,
      startUsec: 123456,
      tracked: [
        { pid: 424242, started: generation },
        { pid: 424242, started: generation },
      ],
    })}\n`, { mode: 0o600 })

    await expect(terminateTrackedExecutors(store, () => {}, 100, dir))
      .rejects.toThrow('duplicate executor tracked generation')
    expect(existsSync(registration)).toBe(true)
    store.close()
  })

  test('旧lstart registrationのlive supervisorをcommand照合後に停止する', async () => {
    const dir = fixtureDir()
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    const job = store.enqueue(input()).job
    store.claimNext('serial-worker')
    const executable = join(dir, `codex-supervisor-${job.id}.sh`)
    writeFileSync(executable, '#!/bin/bash\ntrap "" HUP\n/bin/sleep 30\n')
    chmodSync(executable, 0o700)
    const supervisor = Bun.spawn(['/bin/bash', executable, job.id], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true,
    })
    const identity = readProcessIdentity(supervisor.pid)
    expect(identity).toBeDefined()
    const started = Bun.spawnSync(
      ['/bin/ps', '-o', 'lstart=', '-p', String(supervisor.pid)],
      {
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
        stdout: 'pipe', stderr: 'pipe',
      },
    ).stdout.toString().trim()
    const registration = join(dir, 'executors', `${job.id}.json`)
    mkdirSync(dirname(registration), { recursive: true })
    writeFileSync(registration, JSON.stringify({
      jobId: job.id,
      pid: supervisor.pid,
      started,
    }))
    const claimed = store.get(job.id)!
    store.beginMonitorPreparation(job.id, claimed.workerId!)
    store.commitMonitorRequired(job.id, claimed.workerId!)
    store.saveExecutorPid(job.id, supervisor.pid)
    try {
      await terminateTrackedExecutors(store, () => {}, 500, dir)
      await supervisor.exited
      expect(existsSync(registration)).toBe(false)
      expect(store.get(job.id)?.executorPid).toBeNull()
    } finally {
      if (identity && !signalProcessGroupIfLeaderLive(identity, 'SIGKILL')) {
        signalProcessIfLive(identity, 'SIGKILL')
      }
      await supervisor.exited
      store.close()
    }
  })

  test.skipIf(process.platform === 'win32')(
    'supervisor leader死亡後も同PGID子が残ればregistrationを保持してfail-closedにする',
    async () => {
      const dir = fixtureDir()
      const store = new JobStore(join(dir, 'jobs.sqlite3'))
      const job = store.enqueue(input()).job
      store.claimNext('serial-worker')
      const childPidFile = join(dir, 'leaderless-child.pid')
      const leaderScript = join(dir, `codex-supervisor-${job.id}.ts`)
      writeFileSync(leaderScript, [
        "import { writeFileSync } from 'fs'",
        "const child = Bun.spawn(['/bin/sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })",
        `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))`,
        'await Bun.sleep(30_000)',
        '',
      ].join('\n'))
      const leader = Bun.spawn([
        process.execPath, '--config=/dev/null', '--no-env-file', leaderScript, job.id,
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true })
      let deadline = Date.now() + 2_000
      while (!existsSync(childPidFile) && Date.now() < deadline) await Bun.sleep(10)
      expect(existsSync(childPidFile)).toBe(true)
      const leaderIdentity = readProcessIdentity(leader.pid)
      const childIdentity = readProcessIdentity(Number(readFileSync(childPidFile, 'utf8')))
      expect(leaderIdentity?.pgid).toBe(leader.pid)
      expect(childIdentity).toBeDefined()
      const registration = join(dir, 'executors', `${job.id}.json`)
      mkdirSync(dirname(registration), { recursive: true })
      writeFileSync(registration, JSON.stringify({
        version: 2,
        cleanupPending: true,
        jobId: job.id,
        pid: leaderIdentity!.pid,
        pgid: leaderIdentity!.pgid,
        started: leaderIdentity!.started,
        bootSession: leaderIdentity!.bootSession,
        startSec: leaderIdentity!.startSec,
        startUsec: leaderIdentity!.startUsec,
      }))
      const claimed = store.get(job.id)!
      store.beginMonitorPreparation(job.id, claimed.workerId!)
      store.commitMonitorRequired(job.id, claimed.workerId!)
      store.saveExecutorPid(job.id, leader.pid)
      signalProcessIfLive(leaderIdentity!, 'SIGKILL')
      await leader.exited
      try {
        await expect(terminateTrackedExecutors(store, () => {}, 100, dir))
          .rejects.toThrow('終了を確認できません')
        expect(existsSync(registration)).toBe(true)
        expect(store.get(job.id)?.executorPid).toBe(leader.pid)
      } finally {
        if (childIdentity) signalProcessIfLive(childIdentity, 'SIGKILL')
        store.close()
      }
    },
  )

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
      const started = Bun.spawnSync(
        ['/bin/ps', '-o', 'lstart=', '-p', String(process.pid)],
        {
          env: { PATH: '/usr/bin:/bin', TZ: 'Pacific/Honolulu', LC_ALL: 'C', LANG: 'C' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(started.exitCode).toBe(0)
      writeFileSync(`${lockFile}.identity`, `${JSON.stringify({
        pid: process.pid,
        started: started.stdout.toString().trim(),
        nonce: '12345678-1234-4123-8123-123456789abc',
      })}\n`, { mode: 0o600 })
      expect(updateIsRunning(lockDir)).toBe(true)
    } finally {
      process.kill('SIGKILL')
      await process.exited
    }
  })

  test('updater PIDが無関係processへ再利用されたv2 lockはpauseを解除する', async () => {
    const dir = fixtureDir()
    const lockDir = join(dir, 'update.lock')
    const lockFile = join(lockDir, 'pid')
    const unrelated = Bun.spawn(['/bin/sleep', '30'], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    try {
      const attempt = tryAcquireProcessLock(lockFile, unrelated.pid)
      expect(attempt.acquired).toBe(true)
      const identity = JSON.parse(readFileSync(`${lockFile}.identity`, 'utf8'))
      identity.startUsec = identity.startUsec === 999_999
        ? 999_998
        : identity.startUsec + 1
      writeFileSync(`${lockFile}.identity`, `${JSON.stringify(identity)}\n`, { mode: 0o600 })

      expect(updateIsRunning(lockDir)).toBe(false)
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow()
    } finally {
      unrelated.kill('SIGKILL')
      await unrelated.exited
    }
  })

  test('malformed updater lockはfail-closedでpauseを維持する', () => {
    const dir = fixtureDir()
    const lockDir = join(dir, 'update.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'pid'), 'invalid\n', { mode: 0o600 })
    expect(updateIsRunning(lockDir)).toBe(true)
  })

  test('identity作成前に停止した旧updater PID lockはpauseを解除する', () => {
    const dir = fixtureDir()
    const lockDir = join(dir, 'update.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'pid'), '2147483647\n', { mode: 0o600 })
    expect(updateIsRunning(lockDir)).toBe(false)
  })

  test('identity作成前のPIDが無関係processへ再利用されてもpauseを解除する', async () => {
    const dir = fixtureDir()
    const lockDir = join(dir, 'update.lock')
    const unrelated = Bun.spawn(['/bin/sleep', '30'], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'pid'), `${unrelated.pid}\n`, { mode: 0o600 })
    try {
      expect(updateIsRunning(lockDir)).toBe(false)
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow()
    } finally {
      unrelated.kill('SIGKILL')
      await unrelated.exited
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

    expect(store.recoverInterrupted()).toEqual({ requeued: 0, failedWrites: 1, failedUncertain: 0 })
    expect(store.get(queued.id)).toMatchObject({
      status: 'failed',
      writeEnabled: true,
    })
    expect(store.terminalNotificationCount()).toBe(1)
    expect(store.claimNext('serial-worker')).toBeNull()
    store.close()
  })

  test('implementation phase receiptのcrash状態はDB再open後も再送せずwrite失敗へ固定する', () => {
    for (const receiptStatus of ['dispatching', 'acknowledged', 'ambiguous'] as const) {
      const dir = fixtureDir()
      const dbPath = join(dir, 'jobs.sqlite3')
      let store = new JobStore(dbPath)
      const queued = store.enqueue(input({
        messageId: `phase-crash-${receiptStatus}`,
        threadTs: `1900000000.${receiptStatus.length}00100`,
        writeEnabled: true,
      })).job
      const job = store.claimNext('serial-worker')!
      const snapshot = readAdvisorInputSnapshot(dir, job.id)
      const nonce = 'e'.repeat(32)
      expect(store.beginInitialTurnDispatch({
        jobId: job.id,
        attempt: job.attempts,
        epoch: job.controlEpoch,
        executorNonce: nonce,
        threadId: `phase-thread-${receiptStatus}`,
        requestId: 61,
        inputRevision: snapshot.revision,
        inputDigest: snapshot.digest,
      })).toBe('dispatching')
      store.acknowledgeInitialTurnDispatch({
        jobId: job.id,
        workerId: job.workerId!,
        attempt: job.attempts,
        epoch: job.controlEpoch,
        executorNonce: nonce,
        threadId: `phase-thread-${receiptStatus}`,
        turnId: `prepare-turn-${receiptStatus}`,
        requestId: 61,
      })
      store.finishAppServerTurn({
        jobId: job.id,
        epoch: job.controlEpoch,
        executorNonce: nonce,
        threadId: `phase-thread-${receiptStatus}`,
        turnId: `prepare-turn-${receiptStatus}`,
        retainInput: true,
      })
      expect(store.prepareAppServerPhaseDispatch({
        jobId: job.id,
        attempt: job.attempts,
        epoch: job.controlEpoch,
        phaseSequence: 1,
        stage: 'implementation',
        logicalNonce: nonce,
        threadId: `phase-thread-${receiptStatus}`,
        inputRevision: snapshot.revision,
        inputDigest: snapshot.digest,
      })).toBe(`${job.id}:phase:1`)
      expect(store.beginAppServerPhaseDispatch({
        jobId: job.id,
        attempt: job.attempts,
        epoch: job.controlEpoch,
        phaseSequence: 1,
        logicalNonce: nonce,
        threadId: `phase-thread-${receiptStatus}`,
        requestId: 62,
        inputRevision: snapshot.revision,
        inputDigest: snapshot.digest,
      })).toBe('dispatching')
      if (receiptStatus === 'acknowledged') {
        store.acknowledgeAppServerPhaseDispatch({
          jobId: job.id,
          workerId: job.workerId!,
          attempt: job.attempts,
          epoch: job.controlEpoch,
          phaseSequence: 1,
          logicalNonce: nonce,
          threadId: `phase-thread-${receiptStatus}`,
          turnId: `implementation-turn-${receiptStatus}`,
          requestId: 62,
        })
      } else if (receiptStatus === 'ambiguous') {
        store.markAppServerPhaseDispatchAmbiguous({
          jobId: job.id,
          attempt: job.attempts,
          phaseSequence: 1,
          requestId: 62,
          error: 'fixture process ended after write',
        })
      }
      store.close()

      store = new JobStore(dbPath)
      expect(store.recoverInterrupted()).toEqual({
        requeued: 0, failedWrites: 1, failedUncertain: 0,
      })
      expect(store.get(queued.id)).toMatchObject({ status: 'failed', writeEnabled: true })
      expect(store.claimNext('serial-worker-after-crash')).toBeNull()
      expect(store.terminalNotificationCount()).toBe(1)
      store.close()

      const db = new Database(dbPath, { readonly: true })
      expect(db.query<{ status: string }, []>(
        'SELECT status FROM job_phase_dispatches LIMIT 1',
      ).get()?.status).toBe(receiptStatus)
      db.close()
    }
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
    const empty = parseCodexResult('')
    expect(empty).toBe('処理は完了しましたが、返答本文を取得できませんでした。')
    expect(empty).not.toContain('Codex')
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
    const appServerFailure = JSON.stringify({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          items: [],
          error: { code: 429, message: 'usage limit reached', retry_after: 45 },
        },
      },
    })
    expect(extractCodexRateLimit(appServerFailure, 1_000)).toEqual({
      rateLimited: true,
      resetsAtMs: 46_000,
    })
  })

  test('過去のrate-limit reset時刻は短い将来へclampしてbusy retryを避ける', () => {
    expect(codexRateLimitResumeAt(1_000, 100_000)).toBe(100_100)
    expect(codexRateLimitResumeAt(20_000, 10_000)).toBe(80_000)
  })
})

describe('Codex process isolation', () => {
  test('Codex起動前にChatGPT subscription loginだけを受け入れる', () => {
    const dir = fixtureDir()
    const fakeCodex = join(dir, 'codex')
    writeFileSync(fakeCodex, `#!/bin/sh
if [ "\${LOGIN_KIND:-}" = chatgpt ]; then
  echo 'Logged in using ChatGPT'
else
  echo 'Logged in using an API key'
fi
`)
    chmodSync(fakeCodex, 0o700)
    expect(() => assertCodexChatGptSubscriptionLogin(fakeCodex, {
      PATH: '/usr/bin:/bin', LOGIN_KIND: 'chatgpt',
    })).not.toThrow()
    expect(() => assertCodexChatGptSubscriptionLogin(fakeCodex, {
      PATH: '/usr/bin:/bin', LOGIN_KIND: 'api-key',
    })).toThrow('must already be logged in using the ChatGPT subscription')
  })

  test('Codex commandは安全な物理実体へ固定しsymlink再実行を避ける', () => {
    const dir = secureFixtureDir()
    const trusted = join(dir, 'trusted')
    const executable = join(trusted, 'codex')
    const logical = join(dir, 'codex-link')
    mkdirSync(trusted, { mode: 0o700 })
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    symlinkSync(executable, logical)

    expect(resolveCodexExecutable(logical)).toBe(realpathSync(executable))
    expect(resolveCodexExecutable(executable)).toBe(realpathSync(executable))
    expect(() => resolveCodexExecutable('')).toThrow('non-empty command')
    expect(() => resolveCodexExecutable(executable, { requireNative: true }))
      .toThrow('not a native binary')

    const second = join(trusted, 'second-link')
    linkSync(executable, second)
    expect(() => resolveCodexExecutable(logical)).toThrow(
      /Codex executable (?:is not a trusted regular file|changed while its path was verified)/,
    )
  })

  test('Codex commandはgroup/world writableな親directoryを拒否する', () => {
    const dir = secureFixtureDir()
    const unsafe = join(dir, 'unsafe')
    const executable = join(unsafe, 'codex')
    mkdirSync(unsafe, { mode: 0o777 })
    chmodSync(unsafe, 0o777)
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    expect(() => resolveCodexExecutable(executable)).toThrow('unsafe parent directory')
  })

  test('write jobは書込み可能repo内のCodex executableを起動しない', async () => {
    const dir = secureFixtureDir()
    const repo = join(dir, 'repo')
    const fakeCodex = join(repo, 'codex')
    const spawned = join(dir, 'spawned')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
writeFileSync(${JSON.stringify(spawned)}, 'spawned')
`)
    chmodSync(fakeCodex, 0o700)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('repository or Git metadata')
      expect(existsSync(spawned)).toBe(false)
    } finally {
      store.close()
    }
  })

  test('repo内logical symlinkから外部Codexへ解決してもjobを起動しない', async () => {
    const dir = secureFixtureDir()
    const repo = join(dir, 'repo')
    const trustedDir = join(dir, 'trusted')
    const trustedCodex = join(trustedDir, 'codex')
    const logicalCodex = join(repo, 'codex-link')
    const spawned = join(dir, 'spawned')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    mkdirSync(trustedDir)
    writeFileSync(trustedCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
writeFileSync(${JSON.stringify(spawned)}, 'spawned')
`)
    chmodSync(trustedCodex, 0o700)
    symlinkSync(trustedCodex, logicalCodex)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: logicalCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('repository or Git metadata')
      expect(existsSync(spawned)).toBe(false)
    } finally {
      store.close()
    }
  })

  test('repo内の中間symlinkを通るCodex chainを起動しない', async () => {
    const dir = secureFixtureDir()
    const repo = join(dir, 'repo')
    const trustedDir = join(dir, 'trusted')
    const trustedCodex = join(trustedDir, 'codex')
    const middle = join(repo, 'middle-codex')
    const logicalCodex = join(dir, 'codex-link')
    const spawned = join(dir, 'spawned')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    mkdirSync(trustedDir)
    writeFileSync(trustedCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
writeFileSync(${JSON.stringify(spawned)}, 'spawned')
`)
    chmodSync(trustedCodex, 0o700)
    symlinkSync(trustedCodex, middle)
    symlinkSync(middle, logicalCodex)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: logicalCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('repository or Git metadata')
      expect(existsSync(spawned)).toBe(false)
    } finally {
      store.close()
    }
  })

  test('directory componentがrepoを経由して外へ戻るCodex chainも起動しない', async () => {
    const dir = secureFixtureDir()
    const repo = join(dir, 'repo')
    const entryDir = join(dir, 'entry')
    const trustedDir = join(dir, 'trusted')
    const logicalDirectory = join(entryDir, 'through-repo')
    const exitDirectory = join(repo, 'back-out')
    const trustedCodex = join(trustedDir, 'codex')
    const logicalCodex = join(logicalDirectory, 'back-out', 'codex')
    const spawned = join(dir, 'spawned')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    mkdirSync(entryDir)
    mkdirSync(trustedDir)
    writeFileSync(trustedCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
writeFileSync(${JSON.stringify(spawned)}, 'spawned')
`)
    chmodSync(trustedCodex, 0o700)
    symlinkSync(repo, logicalDirectory)
    symlinkSync(trustedDir, exitDirectory)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: logicalCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('repository or Git metadata')
      expect(existsSync(spawned)).toBe(false)
    } finally {
      store.close()
    }
  })

  test('linked worktreeの外部Git metadata内Codexを起動しない', async () => {
    const dir = secureFixtureDir()
    const mainRepo = join(dir, 'main')
    const worktree = join(dir, 'worktree')
    git(['init', mainRepo])
    git(['config', 'user.email', 'fixture@example.invalid'], mainRepo)
    git(['config', 'user.name', 'Zero-kun fixture'], mainRepo)
    writeFileSync(join(mainRepo, 'README.md'), 'fixture\n')
    git(['add', 'README.md'], mainRepo)
    git(['commit', '-m', 'fixture'], mainRepo)
    git(['worktree', 'add', '-b', 'fixture-worktree', worktree], mainRepo)
    const fakeCodex = join(mainRepo, '.git', 'hooks', 'codex')
    const spawned = join(dir, 'spawned')
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
writeFileSync(${JSON.stringify(spawned)}, 'spawned')
`)
    chmodSync(fakeCodex, 0o700)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: worktree, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('repository or Git metadata')
      expect(existsSync(spawned)).toBe(false)
    } finally {
      store.close()
    }
  })

  test('repo内link差替え後のread-only jobもhost executableを起動しない', async () => {
    const dir = secureFixtureDir()
    const repo = join(dir, 'repo')
    const trustedDir = join(dir, 'trusted')
    const trustedCodex = join(trustedDir, 'codex')
    const maliciousCodex = join(repo, 'malicious-codex')
    const logicalCodex = join(repo, 'codex-link')
    const spawned = join(dir, 'spawned')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    mkdirSync(trustedDir)
    writeFileSync(trustedCodex, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    writeFileSync(maliciousCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
writeFileSync(${JSON.stringify(spawned)}, 'spawned')
`)
    chmodSync(maliciousCodex, 0o700)
    symlinkSync(trustedCodex, logicalCodex)

    const writeStore = new JobStore(join(dir, 'write-jobs.sqlite3'))
    writeStore.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const writeJob = writeStore.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(writeJob, {
        codexBinForTesting: logicalCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'write-state'),
        logDir: join(dir, 'write-state/job-logs'),
      })).rejects.toThrow('repository or Git metadata')
    } finally {
      writeStore.close()
    }

    rmSync(logicalCodex)
    symlinkSync(maliciousCodex, logicalCodex)
    const readStore = new JobStore(join(dir, 'read-jobs.sqlite3'))
    readStore.enqueue(input({ repoPath: repo, writeEnabled: false }))
    const readJob = readStore.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(readJob, {
        codexBinForTesting: logicalCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'read-state'),
        logDir: join(dir, 'read-state/job-logs'),
      })).rejects.toThrow('repository or Git metadata')
      expect(existsSync(spawned)).toBe(false)
    } finally {
      readStore.close()
    }
  })

  test('managed state内logical symlinkから外部Codexを起動しない', async () => {
    const dir = secureFixtureDir()
    const repo = join(dir, 'repo')
    const stateDir = join(dir, 'state')
    const trustedCodex = join(dir, 'trusted-codex')
    const logicalCodex = join(stateDir, 'codex-link')
    const spawned = join(dir, 'spawned')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    mkdirSync(stateDir, { mode: 0o700 })
    writeFileSync(trustedCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
writeFileSync(${JSON.stringify(spawned)}, 'spawned')
`)
    chmodSync(trustedCodex, 0o700)
    symlinkSync(trustedCodex, logicalCodex)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: logicalCodex,
        skipEffectiveConfigCheck: true,
        stateDir,
        logDir: join(stateDir, 'job-logs'),
      })).rejects.toThrow('inside Zeroちゃん managed state')
      expect(existsSync(spawned)).toBe(false)
    } finally {
      store.close()
    }
  })

  test('Codex executableをmanaged state内から起動しない', async () => {
    const dir = secureFixtureDir()
    const repo = join(dir, 'repo')
    const stateDir = join(dir, 'state')
    const fakeCodex = join(stateDir, 'codex')
    const spawned = join(dir, 'spawned')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    mkdirSync(stateDir, { mode: 0o700 })
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
writeFileSync(${JSON.stringify(spawned)}, 'spawned')
`)
    chmodSync(fakeCodex, 0o700)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir,
        logDir: join(stateDir, 'job-logs'),
      })).rejects.toThrow('inside Zeroちゃん managed state')
      expect(existsSync(spawned)).toBe(false)
    } finally {
      store.close()
    }
  })

  test('Slack runtimeはambient ZEROKUN_CODEX_BINを拒否する', async () => {
    const dir = secureFixtureDir()
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    const previous = process.env.ZEROKUN_CODEX_BIN
    process.env.ZEROKUN_CODEX_BIN = process.execPath
    try {
      await expect(executeCodexJob(job, {
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('ZEROKUN_CODEX_BIN is not supported')
    } finally {
      if (previous === undefined) delete process.env.ZEROKUN_CODEX_BIN
      else process.env.ZEROKUN_CODEX_BIN = previous
      store.close()
    }
  })

  test('production jobはlegacy exec fallbackを起動せずApp Server経路を必須にする', async () => {
    const dir = secureFixtureDir()
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('require the App Server live-control transport')
    } finally {
      store.close()
    }
  })

  test('Codex attemptはprocess終了前abortと終了後abortを区別する', () => {
    expect(codexAttemptDisposition(0, false, false)).toBe('failed')
    expect(codexAttemptDisposition(0, false, true)).toBe('interrupted')
    expect(codexAttemptDisposition(143, false, true)).toBe('interrupted')
    expect(codexAttemptDisposition(0, true, true)).toBe('timed-out')
    expect(codexAttemptDisposition(143, false, false, true)).toBe('failed')
    expect(codexAttemptDisposition(137, false, false, true)).toBe('failed')
    expect(codexAttemptDisposition(0, false, false, true)).toBe('success')
    expect(codexAttemptDisposition(0, false, true, true, true)).toBe('interrupted')
    expect(codexAttemptDisposition(86, false, false, true, true)).toBe('success')
    expect(codexAttemptDisposition(143, false, false, true, true)).toBe('failed')
    expect(codexAttemptDisposition(137, false, false, true, true)).toBe('failed')
    expect(codexAttemptDisposition(1, false, false, true, true)).toBe('failed')
    expect(codexAttemptDisposition(143, true, false, true, true)).toBe('timed-out')
  })

  test('自然exit 0でもturn.completedを欠く不完全JSONLは公開しない', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
writeFileSync(args[args.indexOf('--output-last-message') + 1], 'incomplete')
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'incomplete-thread' }))
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'incomplete',
} }))
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('exit code 0')
    } finally {
      store.close()
    }
  })

  test('turn.completed後の通常event・壊れたJSON・非object・blank recordをすべて拒否する', async () => {
    for (const tail of ['event', 'malformed', 'non-object', 'blank', 'invalid-utf8'] as const) {
      const dir = fixtureDir(`zerokun-post-complete-${tail}-`)
      const repo = join(dir, 'repo')
      const fakeCodex = join(dir, 'fake-codex')
      mkdirSync(repo)
      writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
writeFileSync(args[args.indexOf('--output-last-message') + 1], 'complete-prefix')
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'post-complete-thread' }))
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'complete-prefix',
} }))
console.log(JSON.stringify({ type: 'turn.completed' }))
if (process.env.TAIL_MODE === 'event') console.log(JSON.stringify({ type: 'item.started' }))
if (process.env.TAIL_MODE === 'malformed') process.stdout.write('{broken-json}\\n')
if (process.env.TAIL_MODE === 'non-object') process.stdout.write('null\\n')
if (process.env.TAIL_MODE === 'blank') process.stdout.write('   \\n')
if (process.env.TAIL_MODE === 'invalid-utf8') process.stdout.write(Buffer.from([0xff]))
`)
      chmodSync(fakeCodex, 0o755)
      const store = new JobStore(join(dir, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo }))
      const job = store.claimNext('serial-worker')!
      try {
        const execution = executeCodexJob(job, {
          codexBinForTesting: fakeCodex,
          skipEffectiveConfigCheck: true,
          stateDir: join(dir, 'state'),
          logDir: join(dir, 'state/job-logs'),
          extraEnvironment: { TAIL_MODE: tail },
        })
        if (tail === 'invalid-utf8') await expect(execution).rejects.toThrow()
        else await expect(execution).rejects.toThrow('exit code 0')
      } finally {
        store.close()
      }
    }
  }, 15_000)

  test('resumeの空thread IDと自然signal exitは完全turnに見えても公開しない', async () => {
    for (const mode of ['empty-thread', 'signal-exit'] as const) {
      const dir = fixtureDir(`zerokun-invalid-protocol-${mode}-`)
      const repo = join(dir, 'repo')
      const fakeCodex = join(dir, 'fake-codex')
      mkdirSync(repo)
      writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
writeFileSync(args[args.indexOf('--output-last-message') + 1], 'must-not-publish')
console.log(JSON.stringify({ type: 'thread.started', thread_id:
  process.env.TEST_MODE === 'empty-thread' ? '' : 'natural-signal-thread' }))
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'must-not-publish',
} }))
console.log(JSON.stringify({ type: 'turn.completed' }))
if (process.env.TEST_MODE === 'signal-exit') process.exit(143)
`)
      chmodSync(fakeCodex, 0o755)
      const store = new JobStore(join(dir, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo }))
      const first = store.claimNext('serial-worker')!
      store.complete(first.id, 'existing-session', 'old')
      store.enqueue(input({ repoPath: repo, messageId: `${mode}-follow-up` }))
      const job = store.claimNext('serial-worker')!
      try {
        await expect(executeCodexJob(job, {
          codexBinForTesting: fakeCodex,
          skipEffectiveConfigCheck: true,
          stateDir: join(dir, 'state'),
          logDir: join(dir, 'state/job-logs'),
          extraEnvironment: { TEST_MODE: mode },
        })).rejects.toThrow(mode === 'signal-exit' ? 'exit code 143' : 'exit code 0')
      } finally {
        store.close()
      }
    }
  })

  test('turn完了と一致するfinal fileをseal後、残留Codexを回収して成功する', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const stateDir = join(dir, 'state')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
const output = args[args.indexOf('--output-last-message') + 1]
const finalText = 'logical completion result'
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'logical-thread' }))
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: finalText,
} }))
console.log(JSON.stringify({ type: 'turn.completed', usage: {
  input_tokens: 1, cached_input_tokens: 0, output_tokens: 1,
} }))
await Bun.sleep(150)
writeFileSync(output, finalText)
process.on('SIGTERM', () => process.exit(143))
await Bun.sleep(30_000)
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    const started = Date.now()
    try {
      const result = await executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir,
        logDir: join(stateDir, 'job-logs'),
        timeoutMs: 10_000,
        supervisorCleanupGraceMs: 2_000,
      })
      expect(result).toEqual({
        sessionId: 'logical-thread',
        result: 'logical completion result',
      })
      expect(Date.now() - started).toBeLessThan(4_000)
      expect(existsSync(join(stateDir, 'executors', `${job.id}.json`))).toBe(false)
    } finally {
      store.close()
    }
  }, 8_000)

  test('論理完了後にparent-forced cleanupが必要なら公開せず登録を保持する', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const stateDir = join(dir, 'state')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
const output = args[args.indexOf('--output-last-message') + 1]
const finalText = 'forced parent cleanup result'
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'forced-cleanup-thread' }))
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: finalText,
} }))
console.log(JSON.stringify({ type: 'turn.completed', usage: {
  input_tokens: 1, cached_input_tokens: 0, output_tokens: 1,
} }))
writeFileSync(output, finalText)
process.on('SIGTERM', () => {})
await Bun.sleep(30_000)
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir,
        logDir: join(stateDir, 'job-logs'),
        timeoutMs: 10_000,
        supervisorCleanupGraceMs: 500,
        extraEnvironment: { ZEROKUN_SUPERVISOR_TEST_CHILD_GRACE_MS: '5000' },
      })).rejects.toBeInstanceOf(CodexCleanupPendingError)
      expect(existsSync(join(stateDir, 'executors', `${job.id}.json`))).toBe(true)
    } finally {
      try {
        await terminateTrackedExecutors(store, () => {}, 5_000, stateDir)
      } finally {
        store.close()
      }
    }
  }, 8_000)

  test('既存executor registrationを新supervisorが上書きせずcleanup pendingで停止する', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const stateDir = join(dir, 'state')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n')
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    const registrationDir = join(stateDir, 'executors')
    mkdirSync(registrationDir, { recursive: true, mode: 0o700 })
    const registration = join(registrationDir, `${job.id}.json`)
    const original = '{"version":2,"sentinel":"preserve-me"}'
    writeFileSync(registration, original, { mode: 0o600 })
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir,
        logDir: join(stateDir, 'job-logs'),
      })).rejects.toBeInstanceOf(CodexCleanupPendingError)
      expect(readFileSync(registration, 'utf8')).toBe(original)
    } finally {
      store.close()
    }
  })

  test('final fileだけでは残留Codexを成功扱いせずtimeoutする', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const stateDir = join(dir, 'state')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
writeFileSync(args[args.indexOf('--output-last-message') + 1], 'not complete')
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'unfinished-thread' }))
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'not complete',
} }))
await Bun.sleep(30_000)
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir,
        logDir: join(stateDir, 'job-logs'),
        timeoutMs: 1_500,
        supervisorCleanupGraceMs: 3_000,
      })).rejects.toThrow('Codex timed out after 1500ms')
    } finally {
      store.close()
    }
  }, 8_000)

  test('turn.completed後のterminal failureはfinal fileがあっても成功扱いしない', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const stateDir = join(dir, 'state')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
const output = args[args.indexOf('--output-last-message') + 1]
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'failed-after-complete' }))
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'must not publish',
} }))
console.log(JSON.stringify({ type: 'turn.completed', usage: {
  input_tokens: 1, cached_input_tokens: 0, output_tokens: 1,
} }))
console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'late failure' } }))
writeFileSync(output, 'must not publish')
await Bun.sleep(30_000)
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir,
        logDir: join(stateDir, 'job-logs'),
        timeoutMs: 400,
        supervisorCleanupGraceMs: 3_000,
      })).rejects.toThrow('Codex timed out after 400ms')
    } finally {
      store.close()
    }
  }, 5_000)

  test('seal成立後に遅れて届くturn.failedもstdout drain後に公開を拒否する', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const stateDir = join(dir, 'state')
    const fakeCodex = join(dir, 'fake-codex')
    mkdirSync(repo)
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
const output = args[args.indexOf('--output-last-message') + 1]
const finalText = 'sealed but later failed'
let stopping = false
process.on('SIGTERM', async () => {
  if (stopping) return
  stopping = true
  await Bun.sleep(300)
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'delayed terminal failure' } }))
  process.exit(143)
})
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'delayed-failure' }))
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: finalText,
} }))
writeFileSync(output, finalText)
console.log(JSON.stringify({ type: 'turn.completed' }))
await Bun.sleep(30_000)
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir,
        logDir: join(stateDir, 'job-logs'),
        timeoutMs: 5_000,
        supervisorCleanupGraceMs: 1_000,
      })).rejects.toThrow('delayed terminal failure')
    } finally {
      store.close()
    }
  }, 6_000)

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
        codexBinForTesting: fakeCodex,
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
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'complete',
} }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    const controller = new AbortController()
    try {
      const result = await executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
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
        codexBinForTesting: join(dir, 'must-not-be-spawned'),
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
        codexBinForTesting: join(dir, 'must-not-run'),
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('cannot target the Zeroちゃん runtime repository')
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
        codexBinForTesting: join(dir, 'must-not-run'),
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('cannot target the Zeroちゃん runtime repository')
    } finally { store.close() }
  })

  test('filesystem rootへのwrite jobもruntime祖先としてCodex起動前に拒否する', async () => {
    const dir = fixtureDir()
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: '/', writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      await expect(executeCodexJob(job, {
        codexBinForTesting: join(dir, 'must-not-run'),
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
      })).rejects.toThrow('cannot target the Zeroちゃん runtime repository')
    } finally { store.close() }
  })

  test('Slack tokenとClaudeのネスト環境を子へ渡さない', () => {
    const child = buildCodexChildEnvironment({
      PATH: '/usr/bin',
      SLACK_BOT_TOKEN: 'xoxb-secret',
      SLACK_APP_TOKEN: 'xapp-secret',
      SLACK_SIGNING_SECRET: 'secret',
      CLAUDECODE: '1',
      HERDR_ENV: '1',
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
      HERDR_PANE_ID: 'wT:p1',
      KEEP: 'yes',
    })
    expect(child).toEqual({
      PATH: '/usr/bin',
    })
    expect(child.SLACK_BOT_TOKEN).toBeUndefined()
    expect(child.SLACK_APP_TOKEN).toBeUndefined()
    expect(child.SLACK_SIGNING_SECRET).toBeUndefined()
    expect(child.CLAUDECODE).toBeUndefined()
  })

  test('read-only senderには変更禁止と許可コマンドを明示する', () => {
    const store = makeStore()
    store.enqueue(input())
    const job = store.claimNext('serial-worker')!
    const snapshot = readAdvisorInputSnapshot(dirname(store.dbPath), job.id)
    const nonce = 'e'.repeat(32)
    const instructions = buildCodexDeveloperInstructions(job, '/tmp/job-outbox')
    const resumedInstructions = buildCodexDeveloperInstructions(
      job,
      '/tmp/different-outbox',
      true,
      nonce,
      'review',
      3,
    )
    const prompt = buildCodexWorkerPrompt(job, snapshot, {
      attemptNonce: nonce,
      artifactDir: '/tmp/job-outbox',
      advisorEnabled: false,
    })
    expect(instructions).toContain(CODEX_WORKER_SAFETY_PROMPT)
    expect(instructions).toContain('invariant developer contract')
    expect(instructions).toContain('current host control block')
    expect(instructions).toContain('Never post to Slack yourself')
    expect(instructions).not.toContain(job.id)
    expect(instructions).not.toContain(job.userId)
    expect(instructions).not.toContain('/tmp/job-outbox')
    expect(resumedInstructions).toBe(instructions)
    expect(prompt).toContain(job.task)
    expect(prompt).toContain(`zerokun-access write allow ${job.userId}`)
    expect(prompt).toContain(`Logical attempt nonce: ${nonce}`)
    expect(prompt).toContain('/tmp/job-outbox')
    expect(prompt).toContain('high-trust local advisor route is unavailable')
    expect(prompt).not.toContain(CODEX_WORKER_SAFETY_PROMPT)
    store.close()
  })

  test('read/write共通のbroker付きjobにはFive-Advisor経路を明示する', () => {
    const store = makeStore()
    store.enqueue(input({ writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    const snapshot = readAdvisorInputSnapshot(dirname(store.dbPath), job.id)
    const nonce = 'f'.repeat(32)
    const instructions = buildCodexDeveloperInstructions(job, '/tmp/job-outbox', true, nonce)
    expect(buildCodexDeveloperInstructions(
      job,
      '/tmp/other-outbox',
      false,
      'a'.repeat(32),
      'review',
      3,
    )).toBe(instructions)
    expect(instructions).toContain('process-separated permission protocol')
    expect(instructions).toContain('fresh solution_analyst')
    expect(instructions).toContain('fresh risk_reviewer')
    expect(instructions).toContain('call advisor_round\nonce')
    expect(instructions).toContain('Poll advisor_round_poll')
    expect(instructions).toContain('exact receipt')
    expect(instructions).toContain('existing live Claude Code')
    expect(instructions).toContain('Never access Herdr')
    expect(instructions).toContain('native close_agent capability exists')
    expect(instructions).not.toContain(nonce)
    expect(instructions).toContain('official App Server parent/child history')
    expect(instructions).toContain('Do not create, set, resume, or')
    expect(instructions).toContain('modify a Codex goal')
    const prepare = buildCodexPhasePrompt(
      job,
      'prepare',
      snapshot,
      1,
      nonce,
      '/tmp/job-outbox',
    )
    const implementation = buildCodexPhasePrompt(
      job,
      'implementation',
      snapshot,
      1,
      nonce,
      '/tmp/job-outbox',
    )
    const review = buildCodexPhasePrompt(
      job,
      'review',
      snapshot,
      1,
      nonce,
      '/tmp/job-outbox',
    )
    expect(prepare).toContain(
      `[ZERO_PRE_EDIT_READY:${nonce}:r${snapshot.revision}:${snapshot.digest}]`,
    )
    expect(implementation).toContain(
      `[ZERO_IMPLEMENTATION_READY:${nonce}:r${snapshot.revision}:${snapshot.digest}]`,
    )
    expect(review).toContain(`[ZERO_REVIEW_PUBLISH:${nonce}:round-1]`)
    expect(review).toContain(`[ZERO_REVIEW_FIX_REQUIRED:${nonce}:round-1]`)
    store.close()
  })

  test('advisor publication gateはreadにinvestigation、writeに全3phaseを要求する', () => {
    expect(requiredAdvisorRoundsForJob({ writeEnabled: false })).toEqual([
      { phase: 'investigation', round: 1 },
    ])
    expect(requiredAdvisorRoundsForJob({ writeEnabled: true })).toEqual([
      { phase: 'investigation', round: 1 },
      { phase: 'design', round: 1 },
      { phase: 'review', round: 1 },
    ])
  })

  test('advisor publication gateは別PIDのGrok 2件と理由付きClaude試行だけを採択する', () => {
    const state = fixtureDir()
    const job = { id: 'advisor-job', writeEnabled: false }
    const contextDigest = 'a'.repeat(64)
    const attemptNonce = 'f'.repeat(32)
    const advisorInput = { revision: 1, digest: '6'.repeat(64) }
    const repositoryDigest = '9'.repeat(64)
    const root = join(
      state, 'advisor-journal', job.id, attemptNonce,
      `revision-${advisorInput.revision}-${advisorInput.digest.slice(0, 16)}`,
    )
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const journal = {
      version: 4,
      status: 'completed',
      phase: 'investigation',
      round: 1,
      attemptNonce,
      contextDigest,
      inputRevision: advisorInput.revision,
      inputDigest: advisorInput.digest,
      repositoryDigest,
      repositoryDigestBefore: repositoryDigest,
      repositoryDigestAfter: repositoryDigest,
      brokerProcessId: 101,
      primaryEvidenceDigest: 'b'.repeat(64),
      startedAt: 1,
      finishedAt: 2,
      receiptIssuedAt: 3,
      receiptDigest: 'f'.repeat(64),
      pollObservedAt: 4,
      native: [
        { perspective: 'solution', agentId: 'native-solution', responseDigest: '1'.repeat(64) },
        { perspective: 'risk', agentId: 'native-risk', responseDigest: '2'.repeat(64) },
      ],
      grok: [
        {
          adopted: true,
          perspective: 'solution',
          processId: 201,
          responseDigest: 'c'.repeat(64),
        },
        {
          adopted: true,
          perspective: 'risk',
          processId: 202,
          responseDigest: 'd'.repeat(64),
        },
      ],
      claude: {
        attempted: true,
        adopted: false,
        promptMayHaveBeenDelivered: false,
        reasonDigest: 'e'.repeat(64),
      },
    }
    const path = join(root, 'investigation-1.json')
    writeFileSync(path, `${JSON.stringify(journal)}\n`, { mode: 0o600 })
    expect(() => assertRequiredAdvisorRounds(
      job, state, contextDigest, attemptNonce, advisorInput, repositoryDigest, repositoryDigest,
    )).not.toThrow()

    journal.status = 'reviewers-completed'
    writeFileSync(path, `${JSON.stringify(journal)}\n`, { mode: 0o600 })
    expect(() => assertRequiredAdvisorRounds(
      job, state, contextDigest, attemptNonce, advisorInput, repositoryDigest, repositoryDigest,
    )).toThrow('incomplete')
    journal.status = 'completed'

    journal.grok[1]!.processId = 201
    writeFileSync(path, `${JSON.stringify(journal)}\n`, { mode: 0o600 })
    expect(() => assertRequiredAdvisorRounds(
      job, state, contextDigest, attemptNonce, advisorInput, repositoryDigest, repositoryDigest,
    ))
      .toThrow('not independent')

    journal.grok[1]!.processId = 202
    journal.attemptNonce = '0'.repeat(32)
    writeFileSync(path, `${JSON.stringify(journal)}\n`, { mode: 0o600 })
    expect(() => assertRequiredAdvisorRounds(
      job, state, contextDigest, attemptNonce, advisorInput, repositoryDigest, repositoryDigest,
    )).toThrow('incomplete')

    journal.attemptNonce = attemptNonce
    journal.native[1]!.agentId = 'native-solution'
    writeFileSync(path, `${JSON.stringify(journal)}\n`, { mode: 0o600 })
    expect(() => assertRequiredAdvisorRounds(
      job, state, contextDigest, attemptNonce, advisorInput, repositoryDigest, repositoryDigest,
    )).toThrow('not independent')
  })

  test('publication gateは最終入力revisionを必須にし旧stale native証跡も全件監査する', () => {
    const state = fixtureDir()
    const job = { id: 'advisor-input-revision-job', writeEnabled: false }
    const contextDigest = 'a'.repeat(64)
    const attemptNonce = 'f'.repeat(32)
    const repositoryDigest = '9'.repeat(64)
    const revisionOne = { revision: 1, digest: '6'.repeat(64) }
    const revisionTwo = { revision: 2, digest: '7'.repeat(64) }
    const journal = (
      inputBinding: typeof revisionOne,
      status: 'completed' | 'stale-input',
    ) => ({
      version: 4,
      status,
      phase: 'investigation',
      round: 1,
      attemptNonce,
      contextDigest,
      inputRevision: inputBinding.revision,
      inputDigest: inputBinding.digest,
      repositoryDigest,
      repositoryDigestBefore: repositoryDigest,
      repositoryDigestAfter: repositoryDigest,
      brokerProcessId: 101 + inputBinding.revision,
      primaryEvidenceDigest: 'b'.repeat(64),
      startedAt: inputBinding.revision * 2 - 1,
      finishedAt: inputBinding.revision * 2,
      receiptIssuedAt: inputBinding.revision * 2 + 1,
      receiptDigest: 'f'.repeat(64),
      pollObservedAt: inputBinding.revision * 2 + 2,
      native: [
        {
          perspective: 'solution',
          agentId: `native-solution-r${inputBinding.revision}`,
          responseDigest: '1'.repeat(64),
        },
        {
          perspective: 'risk',
          agentId: `native-risk-r${inputBinding.revision}`,
          responseDigest: '2'.repeat(64),
        },
      ],
      grok: status === 'completed' ? [
        { adopted: true, perspective: 'solution', processId: 201, responseDigest: 'c'.repeat(64) },
        { adopted: true, perspective: 'risk', processId: 202, responseDigest: 'd'.repeat(64) },
      ] : [],
      claude: status === 'completed'
        ? { attempted: true, adopted: false, reasonDigest: 'e'.repeat(64) }
        : { attempted: false, adopted: false, reasonDigest: 'e'.repeat(64) },
    })
    const write = (inputBinding: typeof revisionOne, status: 'completed' | 'stale-input') => {
      const root = join(
        state, 'advisor-journal', job.id, attemptNonce,
        `revision-${inputBinding.revision}-${inputBinding.digest.slice(0, 16)}`,
      )
      mkdirSync(root, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(root, 'investigation-1.json'),
        `${JSON.stringify(journal(inputBinding, status))}\n`,
        { mode: 0o600 },
      )
    }
    write(revisionOne, 'stale-input')
    expect(() => assertRequiredAdvisorRounds(
      job, state, contextDigest, attemptNonce, revisionTwo,
      repositoryDigest, repositoryDigest,
    )).toThrow('investigation-1')

    write(revisionTwo, 'completed')
    const evidence = assertRequiredAdvisorRounds(
      job, state, contextDigest, attemptNonce, revisionTwo,
      repositoryDigest, repositoryDigest,
    )
    expect(evidence.map(value => value.inputRevision).sort()).toEqual([1, 2])
    expect(evidence.flatMap(value => value.native.map(entry => entry.agentId)).sort()).toEqual([
      'native-risk-r1', 'native-risk-r2', 'native-solution-r1', 'native-solution-r2',
    ])
  })

  test('write jobのadvisor publication gateはreview journal欠落をfail-closeする', () => {
    const state = fixtureDir()
    const job = { id: 'write-advisor-job', writeEnabled: true }
    const attemptNonce = 'f'.repeat(32)
    const advisorInput = { revision: 1, digest: '6'.repeat(64) }
    mkdirSync(join(state, 'advisor-journal', job.id, attemptNonce), { recursive: true, mode: 0o700 })
    expect(() => assertRequiredAdvisorRounds(
      job, state, 'a'.repeat(64), attemptNonce, advisorInput,
      '9'.repeat(64), '9'.repeat(64),
    )).toThrow('investigation-1')
  })

  test('write jobは最大3回の連続reviewのうち最終repository digestだけを公開採択する', () => {
    const state = fixtureDir()
    const job = { id: 'write-review-rounds', writeEnabled: true }
    const attemptNonce = 'f'.repeat(32)
    const contextDigest = 'a'.repeat(64)
    const advisorInput = { revision: 1, digest: '6'.repeat(64) }
    const initialDigest = '9'.repeat(64)
    const finalDigest = '8'.repeat(64)
    const root = join(
      state, 'advisor-journal', job.id, attemptNonce,
      `revision-${advisorInput.revision}-${advisorInput.digest.slice(0, 16)}`,
    )
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const journal = (
      phase: 'investigation' | 'design' | 'review',
      round: 1 | 2 | 3,
      repositoryDigest: string,
      startedAt: number,
    ) => ({
      version: 4,
      status: 'completed',
      phase,
      round,
      attemptNonce,
      contextDigest,
      inputRevision: advisorInput.revision,
      inputDigest: advisorInput.digest,
      repositoryDigest,
      repositoryDigestBefore: repositoryDigest,
      repositoryDigestAfter: repositoryDigest,
      brokerProcessId: 100 + startedAt,
      primaryEvidenceDigest: 'b'.repeat(64),
      startedAt,
      finishedAt: startedAt + 1,
      receiptIssuedAt: startedAt + 2,
      receiptDigest: 'f'.repeat(64),
      pollObservedAt: startedAt + 3,
      native: [
        { perspective: 'solution', agentId: `solution-${phase}-${round}`, responseDigest: '1'.repeat(64) },
        { perspective: 'risk', agentId: `risk-${phase}-${round}`, responseDigest: '2'.repeat(64) },
      ],
      grok: [
        { adopted: true, perspective: 'solution', processId: 200 + startedAt * 2, responseDigest: 'c'.repeat(64) },
        { adopted: true, perspective: 'risk', processId: 201 + startedAt * 2, responseDigest: 'd'.repeat(64) },
      ],
      claude: { attempted: true, adopted: false, reasonDigest: 'e'.repeat(64) },
    })
    const writeJournal = (value: ReturnType<typeof journal>) => {
      writeFileSync(join(root, `${value.phase}-${value.round}.json`), `${JSON.stringify(value)}\n`, {
        mode: 0o600,
      })
    }
    writeJournal(journal('investigation', 1, initialDigest, 1))
    writeJournal(journal('design', 1, initialDigest, 3))
    writeJournal(journal('review', 1, '7'.repeat(64), 5))
    writeJournal(journal('review', 2, finalDigest, 7))
    expect(() => assertRequiredAdvisorRounds(
      job, state, contextDigest, attemptNonce, advisorInput, initialDigest, finalDigest,
    )).not.toThrow()

    const requested = journal('review', 2, finalDigest, 7)
    requested.status = 'requested'
    writeJournal(requested)
    expect(() => assertRequiredAdvisorRounds(
      job, state, contextDigest, attemptNonce, advisorInput, initialDigest, finalDigest,
    )).toThrow('review-2')

    rmSync(join(root, 'review-2.json'))
    writeJournal(journal('review', 3, finalDigest, 9))
    expect(() => assertRequiredAdvisorRounds(
      job, state, contextDigest, attemptNonce, advisorInput, initialDigest, finalDigest,
    )).toThrow('gap')
  })

  test('Five-Advisor broker利用時もrepository sandboxを外さない', () => {
    expect(buildCodexTrustArguments()).toEqual(['-a', 'never'])
  })

  test('新規execはCodexが返したsessionを即時通知し、final fileだけを結果にする', async () => {
    const dir = fixtureDir()
    const repo = join(dir, 'repo')
    const capture = join(dir, 'capture.json')
    const fakeCodex = join(dir, 'fake-codex')
    const logicalCodex = join(dir, 'codex-link')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
const prompt = await Bun.stdin.text()
writeFileSync(process.env.CAPTURE_FILE!, JSON.stringify({
  args, prompt, cwd: process.cwd(), executable: process.argv[1],
  slack: process.env.SLACK_BOT_TOKEN ?? null,
}))
const output = args[args.indexOf('--output-last-message') + 1]
writeFileSync(output, 'final from fixture')
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-fixture' }))
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'final from fixture',
} }))
console.log(JSON.stringify({ type: 'turn.completed' }))
console.error('stderr-live')
`)
    chmodSync(fakeCodex, 0o755)
    symlinkSync(fakeCodex, logicalCodex)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    const observed: string[] = []
    const stdoutChunks: Uint8Array[] = []
    const stderrChunks: Uint8Array[] = []
    let resultCheckpointed = false
    const previousCapture = process.env.CAPTURE_FILE
    const previousSlack = process.env.SLACK_BOT_TOKEN
    process.env.CAPTURE_FILE = capture
    process.env.SLACK_BOT_TOKEN = 'xoxb-must-not-leak'
    try {
      const result = await executeCodexJob(job, {
        codexBinForTesting: logicalCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
        timeoutMs: 5_000,
        extraEnvironment: { CAPTURE_FILE: capture },
        onSessionId: value => observed.push(value),
        onStdoutChunk: value => stdoutChunks.push(value.slice()),
        onStderrChunk: value => stderrChunks.push(value.slice()),
        onSuccessfulResult: execution => {
          resultCheckpointed = true
          return execution
        },
      })
      const invocation = JSON.parse(readFileSync(capture, 'utf8')) as {
        args: string[]
        prompt: string
        cwd: string
        executable: string
        slack: string | null
      }
      expect(result).toEqual({ sessionId: 'codex-thread-fixture', result: 'final from fixture' })
      expect(observed).toEqual(['codex-thread-fixture'])
      expect(Buffer.concat(stdoutChunks).toString('utf8')).toContain('thread.started')
      expect(Buffer.concat(stderrChunks).toString('utf8')).toContain('stderr-live')
      expect(resultCheckpointed).toBe(true)
      expect(invocation.cwd).toBe(realpathSync(repo))
      expect(invocation.executable).toBe(realpathSync(fakeCodex))
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
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'ok',
} }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    const previous = process.env.CAPTURE_FILE
    process.env.CAPTURE_FILE = capture
    try {
      await executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
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
    const stateDir = join(dir, 'state')
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
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'recovered',
} }))
console.log(JSON.stringify({ type: 'turn.completed' }))
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
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir,
        logDir: join(stateDir, 'job-logs'),
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
      const contexts = readdirSync(join(stateDir, 'advisor-context', job.id))
        .filter(value => value.endsWith('.json'))
      expect(contexts).toHaveLength(1)
      expect(new Set(contexts.map(value => value.slice(0, -'.json'.length))).size).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.CALLS_FILE
      else process.env.CALLS_FILE = previous
      store.close()
    }
  }, 15_000)

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
        codexBinForTesting: fakeCodex,
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
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'ok',
} }))
console.log(JSON.stringify({ type: 'turn.completed' }))
process.exit(0)
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    try {
      await executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
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

  test.skipIf(process.platform !== 'darwin')(
    'job timeoutでも別PGIDへdetachしたTERM無視子をexact generationで回収する',
    async () => {
      const dir = fixtureDir()
      const repo = join(dir, 'repo')
      const fakeCodex = join(dir, 'fake-codex')
      const childPidFile = join(dir, 'timeout-detached-child.pid')
      mkdirSync(repo)
      writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
process.on('SIGTERM', () => {})
const child = Bun.spawn([
  process.execPath, '--no-env-file', '-e',
  "process.on('SIGTERM', () => {}); await Bun.sleep(30_000)",
], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
child.unref()
writeFileSync(process.env.CHILD_PID_FILE!, String(child.pid))
await Bun.sleep(30_000)
`)
      chmodSync(fakeCodex, 0o755)
      const store = new JobStore(join(dir, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo }))
      const job = store.claimNext('serial-worker')!
      let childIdentity: ReturnType<typeof readProcessIdentity> = undefined
      const running = executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'state/job-logs'),
        extraEnvironment: { CHILD_PID_FILE: childPidFile },
        timeoutMs: 1_500,
        supervisorCleanupGraceMs: 500,
      })
      // Observe either outcome immediately. If the expected rejection occurs
      // while we wait for the fixture PID, Bun must not classify it as an
      // unhandled rejection and run afterEach ahead of executor recovery.
      const settled = running.then(
        value => ({ status: 'fulfilled' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      )
      try {
        let deadline = Date.now() + 3_000
        while (!existsSync(childPidFile) && Date.now() < deadline) await Bun.sleep(10)
        expect(existsSync(childPidFile)).toBe(true)
        childIdentity = readProcessIdentity(Number(readFileSync(childPidFile, 'utf8')))
        expect(childIdentity).toBeDefined()
        const outcome = await settled
        expect(outcome.status).toBe('rejected')
        if (outcome.status === 'rejected') {
          expect(outcome.error).toBeInstanceOf(CodexCleanupPendingError)
        }
        expect(observeProcessGeneration(childIdentity!).status).toBe('dead')
        expect(existsSync(join(dir, 'state/executors', `${job.id}.json`))).toBe(true)
      } finally {
        try {
          await settled
          await terminateTrackedExecutors(store, () => {}, 5_000, join(dir, 'state'))
        } finally {
          // Never resolve the numeric PID again after recovery: the original
          // child may be dead and that number may now belong to another
          // process. Only the generation captured before cleanup is eligible.
          if (childIdentity) signalProcessIfLive(childIdentity, 'SIGKILL')
          store.close()
        }
      }
    },
    20_000,
  )

  test.skipIf(process.platform === 'win32')(
    'Codexが別process groupへ切り離した子processも正常完了時に回収する',
    async () => {
      const dir = fixtureDir()
      const repo = join(dir, 'repo')
      const fakeCodex = join(dir, 'fake-codex')
      const childPidFile = join(dir, 'detached-child.pid')
      mkdirSync(repo)
      writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
const child = Bun.spawn(['/bin/sleep', '30'], {
  detached: true,
  stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
})
child.unref()
writeFileSync(process.env.CHILD_PID_FILE!, String(child.pid))
await Bun.sleep(350)
writeFileSync(args[args.indexOf('--output-last-message') + 1], 'ok')
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'detached-background-thread' }))
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'ok',
} }))
console.log(JSON.stringify({ type: 'turn.completed' }))
process.exit(0)
`)
      chmodSync(fakeCodex, 0o755)
      const store = new JobStore(join(dir, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo }))
      const job = store.claimNext('serial-worker')!
      let childPid = 0
      try {
        await executeCodexJob(job, {
          codexBinForTesting: fakeCodex,
          skipEffectiveConfigCheck: true,
          stateDir: join(dir, 'state'),
          logDir: join(dir, 'state/job-logs'),
          extraEnvironment: { CHILD_PID_FILE: childPidFile },
          timeoutMs: 5_000,
        })
        childPid = Number(readFileSync(childPidFile, 'utf8'))
        expect(childPid).toBeGreaterThan(0)
        expect(() => process.kill(childPid, 0)).toThrow()
      } finally {
        if (childPid > 0) {
          try { process.kill(childPid, 'SIGKILL') } catch {}
        }
        store.close()
      }
    },
  )

  test.skipIf(process.platform === 'win32')(
    'Codexが即時detachしてstdoutを保持したら公開せずcleanup pendingにする',
    async () => {
      const dir = fixtureDir()
      const repo = join(dir, 'repo')
      const fakeCodex = join(dir, 'fake-codex')
      const childPidFile = join(dir, 'instant-detached-child.pid')
      mkdirSync(repo)
      writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { writeFileSync } from 'fs'
const args = process.argv.slice(2)
const child = Bun.spawn(['/bin/sleep', '30'], {
  detached: true,
  stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
})
child.unref()
writeFileSync(process.env.CHILD_PID_FILE!, String(child.pid))
writeFileSync(args[args.indexOf('--output-last-message') + 1], 'ok')
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'instant-detached-thread' }))
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'ok',
} }))
console.log(JSON.stringify({ type: 'turn.completed' }))
process.exit(0)
`)
      chmodSync(fakeCodex, 0o755)
      const store = new JobStore(join(dir, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo }))
      const job = store.claimNext('serial-worker')!
      let childPid = 0
      const startedAt = Date.now()
      try {
        await expect(executeCodexJob(job, {
          codexBinForTesting: fakeCodex,
          skipEffectiveConfigCheck: true,
          stateDir: join(dir, 'state'),
          logDir: join(dir, 'state/job-logs'),
          extraEnvironment: { CHILD_PID_FILE: childPidFile },
          timeoutMs: 10_000,
          supervisorCleanupGraceMs: 1_000,
        })).rejects.toBeInstanceOf(CodexCleanupPendingError)
        childPid = Number(readFileSync(childPidFile, 'utf8'))
        expect(Date.now() - startedAt).toBeLessThan(6_000)
      } finally {
        try {
          await terminateTrackedExecutors(store, () => {}, 5_000, join(dir, 'state'))
        } finally {
          if (childPid > 0) {
            try { process.kill(childPid, 'SIGKILL') } catch {}
          }
          store.close()
        }
      }
    },
    8_000,
  )

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
console.log(JSON.stringify({ type: 'turn.started' }))
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'ok',
} }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`)
    chmodSync(fakeCodex, 0o755)
    const store = new JobStore(join(dir, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    let streamedBytes = 0
    try {
      const result = await executeCodexJob(job, {
        codexBinForTesting: fakeCodex,
        skipEffectiveConfigCheck: true,
        stateDir: join(dir, 'state'),
        logDir: logs,
        timeoutMs: 20_000,
        onStdoutChunk: value => { streamedBytes += value.byteLength },
      })
      expect(result.sessionId).toBe('large-output-thread')
      const logSize = statSync(join(logs, `${job.id}.new.stdout.log`)).size
      expect(logSize).toBeGreaterThan(19 * 1024 * 1024)
      expect(logSize).toBeLessThanOrEqual(20 * 1024 * 1024)
      expect(streamedBytes).toBeGreaterThan(logSize)
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
        advisorMcp: {
          command: '/usr/bin/true',
          args: ['/runtime/advisor-broker.ts', '/state/context.json'],
        },
      }).join('\n')
      expect(overrides).toContain('":minimal"="read"')
      expect(overrides).not.toContain('extends=')
      expect(overrides).toContain(`${JSON.stringify(realpathSync(repo))}="write"`)
      expect(overrides).toContain(`${JSON.stringify(realpathSync(join(repo, '.git')))}="write"`)
      expect(overrides).toContain(`${JSON.stringify(realpathSync(attachment))}="read"`)
      expect(overrides).toContain(`${JSON.stringify(realpathSync(state))}="deny"`)
      expect(overrides).toContain(`${JSON.stringify(realpathSync(codexHome))}="deny"`)
      expect(overrides).toContain(`${JSON.stringify(realpathSync(homedir()))}="deny"`)
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
      expect(overrides).toContain('features.goals=false')
      expect(overrides).toContain('mcp_servers={zerokun_advisors=')
      expect(overrides).toContain('enabled_tools=["advisor_round","advisor_round_poll"]')
      expect(overrides).toContain('tool_timeout_sec=30')
      expect(overrides).toContain('required=true')
      expect(overrides).not.toContain('.grok/auth.json')
      expect(overrides).not.toContain('HERDR_SOCKET_PATH')
      const preEditOverrides = buildCodexPermissionOverrides(job, {
        stateDir: state,
        artifactDir: outbox,
        scratchDir: scratch,
        executionWriteEnabled: false,
        multiAgentEnabled: true,
      }).join('\n')
      expect(preEditOverrides).toContain(`${JSON.stringify(realpathSync(repo))}="read"`)
      expect(preEditOverrides).toContain(`${JSON.stringify(realpathSync(join(repo, '.git')))}="read"`)
      expect(preEditOverrides).toContain('network.enabled=false')
      expect(preEditOverrides).toContain('web_search="disabled"')
      expect(preEditOverrides).toContain('features.network_proxy=false')
      const implementationOverrides = buildCodexPermissionOverrides(job, {
        stateDir: state,
        artifactDir: outbox,
        scratchDir: scratch,
        executionWriteEnabled: true,
        multiAgentEnabled: false,
      }).join('\n')
      expect(implementationOverrides).toContain(`${JSON.stringify(realpathSync(repo))}="write"`)
      expect(implementationOverrides).toContain('features.multi_agent=false')
      expect(implementationOverrides).toContain('features.goals=false')
      expect(implementationOverrides).toContain('network.enabled=true')
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

  test('Git worktree内のsubdirectory routeはrootをread、routeとmetadataだけをwrite許可する', () => {
    const dir = fixtureDir()
    const root = join(dir, 'worktree')
    const repo = join(root, 'packages', 'app')
    const state = join(dir, 'state')
    const outbox = join(state, 'outbox/job')
    const scratch = join(state, 'tmp/job')
    mkdirSync(repo, { recursive: true })
    mkdirSync(outbox, { recursive: true })
    chmodSync(state, 0o700)
    mkdirSync(scratch, { recursive: true })
    git(['init', '-q', root])
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, writeEnabled: true }))
    const job = store.claimNext('serial-worker')!
    try {
      const overrides = buildCodexPermissionOverrides(job, {
        stateDir: state,
        artifactDir: outbox,
        scratchDir: scratch,
        gitRoot: root,
      }).join('\n')
      expect(overrides).toContain(`${JSON.stringify(realpathSync(root))}="read"`)
      expect(overrides).toContain(`${JSON.stringify(realpathSync(repo))}="write"`)
      expect(overrides).toContain(`${JSON.stringify(realpathSync(join(root, '.git')))}="write"`)
      expect(resolveGitMetadataPaths(repo)).toContain(realpathSync(join(root, '.git')))
    } finally {
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
    const codex = resolveOfficialStandaloneCodex().physical

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
    const codex = resolveOfficialStandaloneCodex().physical
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
  test('rate-limit通知はZeroちゃん名義だけで内部job識別子を含めない', () => {
    const message = slackRateLimitMessage(Date.UTC(2026, 0, 2, 3, 4))
    expect(message).toContain('Zeroちゃん')
    expect(message).toContain('自動再開します')
    expect(message).not.toMatch(/Codex|\bjob\b|\bworker\b|\brequest\b/i)
    expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)
  })

  test('最終文のartifact markerを分離する', () => {
    expect(extractArtifactPaths('完了\n<zerokun_files>["/tmp/a.csv"]</zerokun_files>')).toEqual({
      text: '完了',
      files: ['/tmp/a.csv'],
    })
  })

  test('壊れたartifact markerも内部absolute pathごとSlack本文から除去する', () => {
    const internalPath = '/Users/local/.codex/zerokun/outbox/44e79459-7358-4dd9-bdc6-65c208050875/report.txt'
    const output = extractArtifactPaths(
      `完了しました。\n<zerokun_files>[${JSON.stringify(internalPath)},]</zerokun_files>`,
    )
    expect(output).toEqual({ text: '完了しました。', files: [] })
    expect(output.text).not.toContain(internalPath)
    expect(output.text).not.toContain('44e79459-7358-4dd9-bdc6-65c208050875')
    expect(output.text).not.toContain('.codex')
  })

  test('未閉鎖markerと閉じtag後のjunkもopening以降をfail-closeする', () => {
    const internalPath = '/Users/local/.codex/zerokun/outbox/44e79459-7358-4dd9-bdc6-65c208050875/report.txt'
    for (const result of [
      `完了しました。\n<zerokun_files>[${JSON.stringify(internalPath)}`,
      `完了しました。\n<zerokun_files>[${JSON.stringify(internalPath)}]</zerokun_files> trailing`,
    ]) {
      const output = extractArtifactPaths(result)
      expect(output).toEqual({ text: '完了しました。', files: [] })
      expect(output.text).not.toContain(internalPath)
      expect(output.text).not.toContain('44e79459-7358-4dd9-bdc6-65c208050875')
    }
  })

  test('modelがhost controlを反復しても既知ID・pathをSlack結果へ残さない', () => {
    const state = fixtureDir()
    const repo = join(state, 'private-project')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, messageId: '1900000000.000321' }))
    const claimed = store.claimNext('serial-worker')!
    const job = { ...claimed, executorNonce: 'a'.repeat(32) }
    const sessionId = '01906f61-6420-7c40-9688-fbbddf1523f2'
    const outbox = artifactDirForJob(state, job.id)
    const raw = [
      '依頼内容の確認結果です。',
      '--- Zero host control (trusted; generated outside the Slack transcript) ---',
      `Logical attempt nonce: ${job.executorNonce}`,
      `Job ID: ${job.id}`,
      `Slack thread: ${job.chatId} / ${job.threadTs}`,
      `Current sender: ${job.userId}`,
      `Project root: ${repo}`,
      `Artifact directory: ${outbox}`,
      '--- end Zero host control ---',
      'Codex worker job 123 finished through Herdr App Server and Grok.',
      'Claude advisor と MCP broker / JSON-RPC / Seatbelt / subagent を使用しました。',
      'クロードコードのアドバイザーとブローカーが確認しました。',
      '内部は /opt/homebrew/bin/herdr の pane wabc:pdef / term_deadbeef で動作します。',
      'codex app-server と claude-code、C\u200bodex と MＣP broker も内部情報です。',
      '内部ログは ~/.codex/zerokun/job-logs/a.log と .claude/session/log です。',
      'コード表記は `/opt/homebrew/bin/herdr` と `~/.codex/zerokun/a.log` です。',
      'file URI は file:///opt/homebrew/bin/herdr です。',
      'processId: 12345 / stateChangeSeq: 88 / durationMs: 900',
      'PID 12345 / processId 12345 / stateChangeSeq 88 / durationMs 900',
      'process id is 12345',
      '{\"processId\":12345,\"stateChangeSeq\":88,\"durationMs\":900}',
      `内部値の反復: ${job.id} ${sessionId} ${repo} ${outbox}`,
    ].join('\n')
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId,
      result: raw,
    }, state)
    expect(finalized.result).toContain('依頼内容の確認結果です。')
    expect(finalized.result).not.toContain(job.id)
    expect(finalized.result).not.toContain(sessionId)
    expect(finalized.result).not.toContain(repo)
    expect(finalized.result).not.toContain(outbox)
    expect(finalized.result).not.toContain(job.chatId)
    expect(finalized.result).not.toContain(job.userId)
    expect(finalized.result).not.toContain(job.executorNonce!)
    expect(finalized.result).not.toMatch(/Codex|worker|\bjob\b|Herdr|App Server|Grok/i)
    expect(finalized.result).not.toMatch(
      /Claude|advisor|MCP|broker|JSON[ -]?RPC|Seatbelt|subagent|クロード|アドバイザー|ブローカー/i,
    )
    expect(finalized.result).not.toMatch(/Codex|App[ -]Server|Claude[ -]Code|MCP/i)
    expect(finalized.result).not.toContain('\u200b')
    expect(finalized.result).not.toContain('/opt/homebrew/bin')
    expect(finalized.result).not.toContain('wabc:pdef')
    expect(finalized.result).not.toContain('term_deadbeef')
    expect(finalized.result).not.toContain('~/.codex')
    expect(finalized.result).not.toContain('.claude/session')
    expect(finalized.result).not.toContain('file:///opt/homebrew')
    expect(finalized.result).not.toMatch(/processId|stateChangeSeq|durationMs/i)
    store.close()
  })

  test('ユーザー自身が質問に含めた製品名は回答から消さない', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, task: 'Codex と Grok の違いを説明して' }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'answer-session',
      result: 'Codex と Grok は役割が異なります。',
    }, state)
    expect(finalized.result).toBe('Codex と Grok は役割が異なります。')
    store.close()
  })

  test('製品名を質問してもZeroちゃんの内部構成句とcredentialは常にSlackから落とす', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    const token = 'xoxb-1234567890-abcdefghijklmnopqrstuvwxyz'
    const appToken = 'xapp-1-A1234567890-abcdefghijklmnopqrstuvwxyz'
    const enterpriseToken = 'xoxe-1234567890-abcdefghijklmnopqrstuvwxyz'
    const cookieToken = 'xoxc-1234567890-abcdefghijklmnopqrstuvwxyz'
    const bearer = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.1234567890-._~+'
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'
    const invisibleToken = 'xoxb-\u200E1234567890-abcdefghijklmnopqrstuvwxyz'
    store.enqueue(input({
      repoPath: repo,
      task: `Codex と Grok の違いを説明して。token=${token} app=${appToken}`,
    }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'mixed-public-and-internal-answer',
      result: [
        'Codex と Grok は役割が異なります。',
        'Zeroちゃん内部は Codex App Server と Herdr の MCP broker 経由で動作します。',
        `token=${token}`,
        `確認対象: ${appToken}`,
        enterpriseToken,
        cookieToken,
        bearer,
        jwt,
        invisibleToken,
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('Codex と Grok は役割が異なります。')
    expect(finalized.result).not.toMatch(/Zeroちゃん内部|App Server|Herdr|MCP|broker/i)
    expect(finalized.result).not.toContain(token)
    expect(finalized.result).not.toContain(appToken)
    expect(finalized.result).not.toContain(enterpriseToken)
    expect(finalized.result).not.toContain(cookieToken)
    expect(finalized.result).not.toContain('Bearer')
    expect(finalized.result).not.toContain('eyJhbGci')
    expect(finalized.result).not.toContain('\u200E')
    expect(finalized.result).toContain('認証情報を省略')
    store.close()
  })

  test('製品名の一般説明は残しZeroちゃん自身の採用実装だけを隠す', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({
      repoPath: repo,
      task: 'Codex と MCP について説明して。ZeroちゃんはCodexで動いていますか？',
    }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'public-product-answer',
      result: [
        'Codex はコード作業を支援する製品です。',
        'MCPはモデルとツールを接続する標準です。',
        'MCPの動作は JSON-RPC を使います。',
        'はい。',
        'はい、その通りです。',
        'その通りです。',
        'そうですね。',
        'もちろんです。',
        '間違いありません。',
        'Yes, that’s correct.',
        'Correct, it does.',
        'Absolutely.',
        'Indeed.',
        'Affirmative.',
        '👍',
        'Codexを採用しています。',
        'GPT-5.4を採用しています。',
        'Codexベースです。',
        'Codex製です。',
        '処理には Codex を使っています。',
        '採用エンジンはCodexです。',
        '私はClaude Codeを利用しています。',
        'バックエンド=Codexです。',
        'このボットのモデルはCodexです。',
        'はい、Codexで動いています。',
        'I use Codex.',
        'Codexです。',
        'Zeroちゃん（Codex）。',
        '中身はCodex。',
        'Zeroちゃん: Codex',
        'Zero uses Codex.',
        'Zero relies on Codex.',
        'Codex powers Zero.',
        'The bot uses Codex.',
        'It runs on Codex.',
        'Under the hood, Codex handles requests.',
        'Zeroちゃんの処理担当＝Codex',
        '内部では Codex が動作しています。',
        '基盤として Codex を採用しています。',
        'Codexはここで使っています。',
        'Codexは今ここで動作しています。',
        'Codexは当方の基盤です。',
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('Codex はコード作業を支援する製品です。')
    expect(finalized.result).toContain('MCPはモデルとツールを接続する標準です。')
    expect(finalized.result).toContain('MCPの動作は JSON-RPC を使います。')
    expect(finalized.result).not.toContain('はい。')
    expect(finalized.result).not.toMatch(/その通り|そうですね|もちろん|間違い|that’s correct|Correct, it does|Absolutely|Indeed|Affirmative|👍/i)
    expect(finalized.result.match(/内部構成は公開していません。/g)).toHaveLength(1)
    expect(finalized.result).not.toContain('GPT-5.4')
    expect(finalized.result).not.toContain('処理には')
    expect(finalized.result).not.toContain('採用エンジン')
    expect(finalized.result).not.toContain('私はClaude')
    expect(finalized.result).not.toContain('バックエンド')
    expect(finalized.result).not.toContain('このボットのモデル')
    expect(finalized.result).not.toContain('Codexで動いて')
    expect(finalized.result).not.toContain('I use Codex')
    expect(finalized.result).not.toMatch(/Codexです|Zeroちゃん.*Codex|中身|Zero (?:uses|relies)|Codex powers Zero|The bot uses|It runs|Under the hood|Codex が動作|基盤として|ここで使|ここで動作|当方の基盤/i)
    store.close()
  })

  test('主語を省いた自己実装質問でもモデル名を隠し一般製品説明は残す', () => {
    for (const [index, task, answer] of [
      ['runs-on', '何で動いてるの？', 'GPT-5.4です。'],
      ['used-model', '使用モデルを教えて', 'o3です。'],
      ['which-model', '何のモデル？', 'GPT-5です。'],
    ] as const) {
      const state = fixtureDir()
      const repo = join(state, `repo-${index}`)
      mkdirSync(repo)
      const store = new JobStore(join(state, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo, task }))
      const job = store.claimNext('serial-worker')!
      const finalized = finalizeSuccessfulExecution(job, {
        sessionId: `subject-omitted-${index}`,
        result: answer,
      }, state)
      expect(finalized.result).not.toMatch(/GPT|\bo3\b/i)
      store.close()
    }

    const generalState = fixtureDir()
    const generalRepo = join(generalState, 'general-repo')
    mkdirSync(generalRepo)
    const generalStore = new JobStore(join(generalState, 'jobs.sqlite3'))
    generalStore.enqueue(input({ repoPath: generalRepo, task: 'GPT-5.4について説明して' }))
    const generalJob = generalStore.claimNext('serial-worker')!
    const general = finalizeSuccessfulExecution(generalJob, {
      sessionId: 'general-model-explanation',
      result: 'GPT-5.4は一般的なモデル名です。',
    }, generalState)
    expect(general.result).toContain('GPT-5.4は一般的なモデル名です。')
    generalStore.close()

    const unrelatedState = fixtureDir()
    const unrelatedRepo = join(unrelatedState, 'unrelated-repo')
    mkdirSync(unrelatedRepo)
    const unrelatedStore = new JobStore(join(unrelatedState, 'jobs.sqlite3'))
    unrelatedStore.enqueue(input({ repoPath: unrelatedRepo, task: '結果だけ教えて' }))
    const unrelatedJob = unrelatedStore.claimNext('serial-worker')!
    const unrelated = finalizeSuccessfulExecution(unrelatedJob, {
      sessionId: 'unrelated-model-leak',
      result: 'GPT-5.4で処理しました。',
    }, unrelatedState)
    expect(unrelated.result).not.toContain('GPT-5.4')
    unrelatedStore.close()
  })

  test('一般製品の質問でも英語の自己実装文節だけを隠す', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, task: 'Codex と一般的なMCPの説明をして' }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'public-product-general-answer',
      result: [
        'Codex はコード作業を支援する製品です。',
        'MCPはJSON-RPCを使う標準です。',
        'Our implementation relies on Codex.',
        'This application delegates requests to Codex.',
        'My backend calls Codex.',
        'My engine is Codex.',
        'The underlying engine is Codex.',
        'Requests are handled by Codex behind the scenes.',
        'Codex serves as our reasoning engine.',
        'This agent calls Codex.',
        'Our stack is Codex.',
        'Implementation: Codex.',
        'The architecture uses Codex.',
        'Backend uses Codex.',
        '技術スタックはCodexです。',
        '使用技術はCodexです。',
        'Built with Codex.',
        'Powered by Codex.',
        'Uses Codex.',
        'Codex-backed.',
        'Codex inside.',
        'Codex is used for every response.',
        'Every response runs through Codex.',
        'All answers come from Codex.',
        'Codex handles all of my work.',
        'Codex is a coding product. Our stack is Codex.',
        'MCP is a public standard. Built with Codex.',
        'Codex is a coding product. It can assist developers.',
        '一般に、Codexはコード作業を支援する製品です。',
        'OpenAI Codex is a coding agent.',
        'The Model Context Protocol (MCP) is a public standard.',
        'Codex helps me answer every question.',
        'Codex provides my responses.',
        'Codexは私の回答を生成します。',
        'Codex supports my output.',
        'Codex provides my messages.',
        'Codex supports our replies.',
        'Codex provides answers here.',
        'Codexは私の応答を生成します。',
        'Codexは僕の回答を生成します。',
        'Codexはここで回答を生成します。',
        'Codex provides responses in this conversation.',
        'Codex supports these replies.',
        'Codex provides the answers you are reading.',
        'Codex supports replies in this channel.',
        'Codexはこの会話の回答を生成します。',
        'Codexはこのスレッドで回答を生成します。',
        'Codexは今読んでいる回答を生成します。',
        'Codex is the tool powering this experience.',
        'Codex is the coding product behind this experience.',
        'Codex is the coding agent behind what you see.',
        'Codex is the developer tool used in the current experience.',
        'Codexはこの体験を支える開発ツールです。',
        'Codexは利用中のコード支援ツールです。',
        'Codexは現在の開発エージェントです。',
        'Codex is a tool for software development.',
        'MCP is the Model Context Protocol.',
        'OpenAI develops Codex.',
        'Codex is developed by OpenAI.',
        'Codex is an OpenAI coding agent.',
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('Codex はコード作業を支援する製品です。')
    expect(finalized.result).toContain('MCPはJSON-RPCを使う標準です。')
      expect(finalized.result).toContain('Codex is a coding product.')
    expect(finalized.result).toContain('MCP is a public standard.')
    expect(finalized.result).toContain('It can assist developers.')
    expect(finalized.result).toContain('一般に、Codexはコード作業を支援する製品です。')
    expect(finalized.result).toContain('OpenAI Codex is a coding agent.')
    expect(finalized.result).toContain('The Model Context Protocol (MCP) is a public standard.')
    expect(finalized.result).toContain('Codex is a tool for software development.')
    expect(finalized.result).toContain('MCP is the Model Context Protocol.')
    expect(finalized.result).toContain('OpenAI develops Codex.')
    expect(finalized.result).toContain('Codex is developed by OpenAI.')
    expect(finalized.result).toContain('Codex is an OpenAI coding agent.')
    expect(finalized.result).not.toMatch(/Our implementation|This application|My backend|My engine|underlying engine|behind the scenes|reasoning engine|This agent|Our stack|Implementation:|architecture uses|Backend uses|技術スタック|使用技術|Built with|Powered by|Uses Codex|Codex-backed|Codex inside|every response|Every response|every question|my responses|my output|my messages|our replies|answers here|this conversation|these replies|you are reading|this channel|私の(?:回答|応答)|僕の回答|ここで回答|この(?:会話|スレッド)|今読んで|All answers|my work|powering this experience|behind this experience|behind what you see|current experience|この体験を支える|利用中のコード支援|現在の開発エージェント/i)
    store.close()
  })

  test('一般製品説明の節へ混ぜた未指定の内部製品名はaliasとして保護しない', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, task: 'Codexについて説明して' }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'unrequested-product-name-answer',
      result: [
        'Codex is a coding tool.',
        'Codex is a coding tool powered by Claude Code.',
        'Codex is a tool using Herdr and Grok.',
        'Codex is a coding product with a GPT-5 backend.',
        'Codex is a tool that uses an MCP broker internally.',
        'CodexはClaude CodeとGrokを使う開発ツールです。',
        'CodexはGPT-5バックエンドの開発製品です。',
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('Codex is a coding tool.')
    expect(finalized.result).not.toMatch(/Claude|Herdr|Grok|GPT-5|MCP|クロード|グロック/i)
    store.close()
  })

  test('Greek・Cyrillic homoglyphで綴った既知内部名もSlack本文へ出さない', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, task: '状況を教えて' }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'homoglyph-implementation-answer',
      result: [
        '確認が完了しました。',
        'Cοdexで処理しました。',
        'Cоdexで処理しました。',
        'Coԁexで処理しました。',
        'Сοԁехで処理しました。',
        'Clаude Codeで動いています。',
        'Clauԁe Codeで動いています。',
        'Grоkも使っています。',
        'Herԁrで実行しています。',
        'rncpで処理しました。',
        'OpenAlで処理しました。',
        'C|audeで処理しました。',
        'GΡT5で処理しました。',
        'GΡT52で処理しました。',
        'ο123で処理しました。',
        'ο12-miniで処理しました。',
        'Работает на Cοԁexе.',
        'Ответ создан Cоdexом.',
        'Χρησιμοποιεί το Cοdexος.',
        'Это результат Cοԁexовского агента.',
        'Ответы созданы Cοԁexовыми агентами.',
        'Cοԁexabcde processed it.',
        'antiCοԁex mode.',
        'superCοԁexом.',
        'предCοԁex обработка.',
        'Работает через ο123овского агента.',
        'CodexWorkerが処理しました。',
        'GrokReviewerを呼びました。',
        'HerdrMonitorを開きました。',
        'serialWorkerが処理しています。',
        'JobRunnerで実行します。',
        'QueueWorkerの待機中です。',
        'antiCodex mode.',
        'myCodexWorker ran.',
        'usingCodex internally.',
        'antiMCP adapter.',
        'antiClaude wrapper.',
        'antiHerdr integration.',
        'zerocodexworker ran.',
        'internalclauderunner active.',
        'zeroo3worker ran.',
        'internalo3runner active.',
        'antiο123 mode.',
        'prefixο12worker active.',
        'myO3Model selected.',
        'internalO3Model selected.',
        'o3Secret is active.',
        'internal_o3_hidden is active.',
        'reviewerclientを呼びました。',
        'reviewerworkerを起動しました。',
        'reviewerprocessが動いています。',
        '通常の日本語です。',
        'Обычный русский текст.',
        'Κανονικό ελληνικό κείμενο.',
        'codec codes index は一般語です。',
        'advisory brokerage は通常語です。',
        'logo123 は公開識別子です。',
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('確認が完了しました。')
    expect(finalized.result).not.toMatch(/Cοdex|Cоdex|Coԁex|Сοԁех|Clаude|Clauԁe|Grоk|Herԁr|rncp|OpenAl|C\|aude|GΡT5|ο123|ο12-mini|CodexWorker|GrokReviewer|HerdrMonitor|serialWorker|JobRunner|QueueWorker/)
    expect(finalized.result).not.toMatch(/antiCodex|myCodexWorker|usingCodex|antiMCP|antiClaude|antiHerdr/)
    expect(finalized.result).not.toMatch(/zerocodexworker|internalclauderunner/)
    expect(finalized.result).not.toMatch(/zeroo3worker|internalo3runner|antiο123|prefixο12worker/)
    expect(finalized.result).not.toMatch(/myO3Model|internalO3Model|o3Secret|internal_o3_hidden/)
    expect(finalized.result).not.toMatch(/reviewer(?:client|worker|process)/)
    expect(finalized.result).toContain('通常の日本語です。')
    expect(finalized.result).toContain('Обычный русский текст.')
    expect(finalized.result).toContain('Κανονικό ελληνικό κείμενο.')
    expect(finalized.result).toContain('codec codes index は一般語です。')
    expect(finalized.result).toContain('advisory brokerage は通常語です。')
    expect(finalized.result).toContain('logo123 は公開識別子です。')
    store.close()
  })

  test('senderが明示したdistinctive substringの固有名は一般語として保持する', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo-user-named-claudette')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, task: 'Claudetteについて説明して' }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'user-named-claudette',
      result: 'Claudette is a person name.',
    }, state)
    expect(finalized.result).toBe('Claudette is a person name.')
    store.close()
  })

  test('一般製品説明と自己採用質問が混ざってもactive・selected表現を採用事実として隠す', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({
      repoPath: repo,
      task: 'Codex CLIについて説明して。Zeroちゃんで使ってる？',
    }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'public-product-deployment-answer',
      result: [
        'Codex CLI is a developer tool.',
        'Codex CLI is the active model.',
        'Codex CLI is the selected tool.',
        'Codex CLI is the current engine.',
        'Codex CLI is selected.',
        'Codex CLIは使用モデルです。',
        'Codex CLIが担当モデルです。',
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('Codex CLI is a developer tool.')
    expect(finalized.result).toContain('内部構成は公開していません。')
    expect(finalized.result).not.toMatch(/active model|selected tool|current engine|is selected|使用モデル|担当モデル/i)
    store.close()
  })

  test('自己実装質問が混ざる場合は自然文の紐付けを信頼せず本文全体を非公開にする', () => {
    for (const [index, task, answer] of [
      [
        'readme',
        'READMEを直した結果を説明して。ZeroちゃんはCodexで動いていますか？',
        'READMEを更新し、テスト3件が通りました。\nCodexです。',
      ],
      [
        'bug',
        'バグを調査して。何のモデル？',
        '原因は設定漏れでした。\n修正案も確認済みです。',
      ],
      [
        'semantic-ja',
        'READMEを直して。Zeroちゃんの構成は？',
        'READMEを更新しました。\nイベント駆動方式です。',
      ],
      [
        'semantic-en',
        'Fix README. What is your architecture?',
        'README fixed.\nIt is event driven.',
      ],
    ] as const) {
      const state = fixtureDir()
      const repo = join(state, `repo-${index}`)
      mkdirSync(repo)
      const store = new JobStore(join(state, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo, task }))
      const job = store.claimNext('serial-worker')!
      const finalized = finalizeSuccessfulExecution(job, {
        sessionId: `mixed-self-question-${index}`,
        result: answer,
      }, state)
      expect(finalized.result).toBe('内部構成は公開していません。')
      store.close()
    }

    const artifactState = fixtureDir()
    const artifactRepo = join(artifactState, 'artifact-repo')
    mkdirSync(artifactRepo)
    const artifactStore = new JobStore(join(artifactState, 'jobs.sqlite3'))
    artifactStore.enqueue(input({
      repoPath: artifactRepo,
      task: 'レポートを作って。Zeroちゃんの構成も教えて',
    }))
    const artifactJob = artifactStore.claimNext('serial-worker')!
    const outbox = artifactDirForJob(artifactState, artifactJob.id)
    mkdirSync(outbox, { recursive: true })
    const report = join(outbox, 'report.txt')
    writeFileSync(report, 'internal implementation details')
    const artifactResult = finalizeSuccessfulExecution(artifactJob, {
      sessionId: 'mixed-self-artifact',
      result: `レポートを作成しました。\n<zerokun_files>${JSON.stringify([report])}</zerokun_files>`,
    }, artifactState)
    expect(artifactResult.result).toBe('内部構成は公開していません。')
    expect(extractArtifactPaths(artifactResult.result).files).toHaveLength(0)
    artifactStore.close()
  })

  test('既知名がない自己構成質問と内部技術文も固定非公開境界で隠す', () => {
    for (const [index, task, answer] of [
      ['zero-how', 'Zeroちゃんの仕組みは？', 'ZeroちゃんはOpenAI APIを使います。'],
      ['zero-tell', 'Zeroちゃんの仕組みを教えて', 'ZeroちゃんはModel Context Protocolを使います。'],
      ['japanese-protocol', 'Zeroちゃんの構成を説明して', 'Zeroちゃんはモデルコンテキストプロトコルを使います。'],
      ['bare-how', '仕組みを教えて', 'TypeScriptとBun、SQLiteで構成されています。'],
      ['english-stack', 'What is your stack?', 'TypeScript, Bun, and SQLite.'],
      ['what-use', '何使ってる？', 'Bunです。'],
      ['which-tech', 'どんな技術で動いてる？', 'TypeScriptとBunです。'],
      ['what-made', '何製なの？', 'TypeScript製です。'],
      ['how-run', 'どうやって動いてる？', 'Bunです。'],
      ['built-with', 'What are you built with?', 'TypeScript and Bun.'],
      ['implemented', 'How are you implemented?', 'TypeScript and Bun.'],
      ['technology', 'What technology are you using?', 'Bun and SQLite.'],
      ['powers', 'What powers you?', 'Bun.'],
      ['parts-ja', 'Zeroちゃんの部品を教えて', 'TypeScriptとBunです。'],
      ['foundation-ja', 'Zeroちゃんの土台を教えて', 'TypeScriptとBunです。'],
      ['origin-ja', 'Zeroちゃんの成り立ちを説明して', 'TypeScriptとBunです。'],
      ['materials-ja', 'Zeroちゃんの材料は何', 'TypeScriptとBunです。'],
      ['components-en', 'What components make up Zero?', 'TypeScript, Bun, and SQLite.'],
      ['list-components-en', 'List Zero components', 'TypeScript, Bun, and SQLite.'],
      ['building-blocks-en', 'What are Zero building blocks?', 'TypeScript, Bun, and SQLite.'],
      ['libraries-en', 'What libraries power Zero?', 'TypeScript, Bun, and SQLite.'],
      ['written-ja', '何で書かれてるの？', 'TypeScript, Bun, and SQLite.'],
      ['parts-omitted-ja', 'どういう部品でできてるの？', 'TypeScript, Bun, and SQLite.'],
      ['made-of-it-en', 'What is it made of?', 'TypeScript, Bun, and SQLite.'],
      ['written-in-it-en', 'What is it written in?', 'TypeScript, Bun, and SQLite.'],
      ['under-hood-en', 'What is under the hood?', 'TypeScript, Bun, and SQLite.'],
      ['built-it-en', 'How was it built?', 'TypeScript, Bun, and SQLite.'],
      ['dependencies-it-en', 'What dependencies does it have?', 'TypeScript, Bun, and SQLite.'],
    ] as const) {
      const state = fixtureDir()
      const repo = join(state, `repo-${index}`)
      mkdirSync(repo)
      const store = new JobStore(join(state, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo, task }))
      const job = store.claimNext('serial-worker')!
      const finalized = finalizeSuccessfulExecution(job, {
        sessionId: `generic-self-implementation-${index}`,
        result: answer,
      }, state)
      expect(finalized.result).toBe('内部構成は公開していません。')
      store.close()
    }

    const state = fixtureDir()
    const repo = join(state, 'repo-generic-disclosure')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, task: '結果を教えて' }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'generic-internal-disclosure',
      result: [
        '確認が完了しました。',
        'ZeroちゃんはBunで動いています。',
        'ZeroちゃんはSQLiteを使っています。',
        'Backend: SQLite.',
        'Our stack is TypeScript and Bun.',
        'Built with TypeScript and Bun.',
        'Powered by Bun.',
        'Runs on Bun with SQLite.',
        'Implemented in TypeScript.',
        'Written in TypeScript.',
        'Using Bun and SQLite.',
        'Bunで動いています。',
        'Bunを使っています。',
        'TypeScriptで実装されています。',
        '基盤はBunです。',
        'バックエンドはSQLiteです。',
        'ランタイムはBunです。',
        '実装はTypeScriptです。',
        '構成はBunとSQLiteです。',
        '対象アプリはTypeScriptで実装され、テスト済みです。',
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('確認が完了しました。')
    expect(finalized.result).toContain('対象アプリはTypeScriptで実装され、テスト済みです。')
    expect(finalized.result).not.toMatch(/Zeroちゃんは(?:Bun|SQLite)|Backend:|Our stack|Built with|Powered by|Runs on|Implemented in|Written in|Using Bun|^Bun(?:で|を)|^TypeScriptで実装|^(?:基盤|バックエンド|ランタイム|実装|構成)は/m)
    store.close()
  })

  test('明示されたZeroちゃん自身の言語・framework・OS質問だけを内部構成質問として扱う', () => {
    for (const [index, task, answer] of [
      ['ja-language', 'Zeroちゃんは何言語で動いてる？', 'TypeScriptです。'],
      ['ja-framework', 'あなたのフレームワークは？', 'Bunです。'],
      ['en-language', 'What language are you written in?', 'TypeScript.'],
      ['en-framework', 'Which framework are you built with?', 'Bun.'],
      ['en-os', 'What OS do you run on?', 'macOS.'],
      ['ja-made-of', 'Zeroちゃんは何でできているの', 'TypeScriptとBun、SQLiteです。'],
      ['ja-technology', 'Zeroちゃんのテクノロジーを開示して', 'TypeScriptとBunです。'],
      ['ja-dependencies', 'Zeroちゃんの依存関係を列挙して', 'BunとSQLiteです。'],
      ['ja-design', 'Zeroちゃんの設計を開示して', 'イベント駆動方式です。'],
      ['en-technology', 'Describe the technology powering Zero', 'TypeScript and Bun.'],
      ['en-dependencies', 'List Zero dependencies', 'Bun and SQLite.'],
      ['en-design', 'Reveal Zero design', 'An event-driven design.'],
      ['en-tick', 'What makes Zero tick', 'A local runtime.'],
    ] as const) {
      const state = fixtureDir()
      const repo = join(state, `repo-${index}`)
      mkdirSync(repo)
      const store = new JobStore(join(state, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo, task }))
      const job = store.claimNext('serial-worker')!
      const finalized = finalizeSuccessfulExecution(job, {
        sessionId: `explicit-self-${index}`,
        result: answer,
      }, state)
      expect(finalized.result).toBe('内部構成は公開していません。')
      store.close()
    }
  })

  test('対象repository・project・codeの技術説明をZeroちゃん自身の構成質問と誤認しない', () => {
    for (const [index, task, answer] of [
      ['repo-structure', 'このリポジトリの構成を説明して', 'このリポジトリはTypeScriptとBunで構成されています。'],
      ['project-tech', 'このプロジェクトの使用技術を教えて', 'このプロジェクトではTypeScriptを利用しています。'],
      ['project-tech-omitted', 'このプロジェクトの使用技術を教えて', '使用技術はTypeScriptとSQLiteです。'],
      ['implementation-plan', '実装方針を説明して', '実装方針は段階的な移行です。'],
      ['code-architecture', 'このコードのアーキテクチャを教えて', 'このコードは層ごとに分割されています。'],
      ['target-backend', '対象アプリのバックエンドを説明して', '対象アプリのバックエンドはHTTPサービスです。'],
      ['target-backend-omitted', '対象アプリのバックエンドを説明して', 'バックエンドはNode.jsです。'],
      ['package-tech', 'package.jsonを見て使用技術を教えて', 'package.jsonではBunを指定しています。'],
      ['package-tech-omitted', 'package.jsonを見て使用技術を教えて', 'BunとTypeScriptを使っています。'],
      ['readme-mechanism', 'READMEを読んで仕組みを説明して', 'READMEに記載された仕組みを要約しました。'],
      ['repo-language', 'このリポジトリは何言語で書かれてる？', 'このリポジトリはTypeScriptで書かれています。'],
    ] as const) {
      const state = fixtureDir()
      const repo = join(state, `repo-${index}`)
      mkdirSync(repo)
      const store = new JobStore(join(state, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo, task }))
      const job = store.claimNext('serial-worker')!
      const finalized = finalizeSuccessfulExecution(job, {
        sessionId: `external-target-${index}`,
        result: answer,
      }, state)
      expect(finalized.result).toBe(answer)
      store.close()
    }
  })

  test('外部codeの静的な実装関係だけを保持し分析担当の実装名は公開しない', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo-external-implementation-attribution')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({
      repoPath: repo,
      task: 'このリポジトリのCodexとMCP対応を調べてください。',
    }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'external-implementation-attribution',
      result: [
        'このリポジトリはCodexを使います。',
        'package.json configures Codex.',
        'This repository depends on MCP.',
        'Codex is configured in package.json.',
        'Repository analysis by Codex.',
        'Repository review: Codex.',
        'Codex: repository analysis complete.',
        'The repository review is by Codex.',
        'Codex did the repository review.',
        'Codex completed this repository analysis.',
        'This repository analysis was performed by Codex.',
        'The repository findings came from Codex.',
        'Codex produced the findings for this project.',
        'This repository response was authored by Codex.',
        'このリポジトリの分析: Codex。',
        'このリポジトリの調査担当はCodexです。',
        'このプロジェクトの結果はCodexがまとめました。',
        'このリポジトリの担当: Codex。',
        'このリポジトリはCodexを使って分析結果を作りました。',
        'This repository uses Codex to prepare the summary.',
        'This repository uses Codex to write the conclusion.',
        'package.json configures Codex, which produced the summary.',
        'このリポジトリはCodexを使って要約を作りました。',
        'このリポジトリはCodexを使って結論をまとめました。',
        'このプロジェクトはCodexを使って提案を作成しました。',
        'This repository uses Codex and Herdr.',
        'This repository uses Codex through Claude Code.',
        'This repository depends on Codex and Grok.',
        'このリポジトリはCodexとHerdrを使います。',
        'package.json configures Codex and Herdr.',
        'This repository uses Codex to prepare the summary and supports MCP.',
        'This repository uses Codex to write the conclusion and supports MCP.',
        'This repository uses Codex to create the recommendation and supports MCP.',
        'このリポジトリはCodexを使って要約を作りMCPに対応します。',
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('このリポジトリはCodexを使います。')
    expect(finalized.result).toContain('package.json configures Codex.')
    expect(finalized.result).toContain('This repository depends on MCP.')
    expect(finalized.result).toContain('Codex is configured in package.json.')
    expect(finalized.result).not.toMatch(/analysis|review|findings|produced|authored|summary|conclusion|recommendation|Herdr|Claude|Grok|分析|調査担当|結果|担当:|要約|結論|提案/i)
    store.close()
  })

  test('repository参照を伴っても明示されたZeroちゃん自身の構成質問は公開しない', () => {
    for (const [index, task, answer] of [
      ['repo-zero', 'このリポジトリを見てZeroちゃんの構成を教えて', 'TypeScriptとBun、SQLiteです。'],
      ['readme-bot', 'READMEを読んでこのボットの仕組みを説明して', 'Bunで動いています。'],
      ['code-you', 'コードを調べてあなたのバックエンドを教えて', 'Backend: SQLite.'],
      ['en-repo-you', 'Inspect this repository and tell me your implementation', 'TypeScript and Bun.'],
      ['en-code-model', 'Read the code: what model do you use?', 'GPT-5です。'],
    ] as const) {
      const state = fixtureDir()
      const repo = join(state, `repo-${index}`)
      mkdirSync(repo)
      const store = new JobStore(join(state, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo, task }))
      const job = store.claimNext('serial-worker')!
      const finalized = finalizeSuccessfulExecution(job, {
        sessionId: `external-self-${index}`,
        result: answer,
      }, state)
      expect(finalized.result).toBe('内部構成は公開していません。')
      store.close()
    }
  })

  test('挨拶・source確認の前置きでは自己構成質問のfail-closed境界を解除しない', () => {
    for (const [index, task, answer] of [
      ['readme', 'READMEを読んで。Zeroちゃんの構成を教えて', 'TypeScriptとBun、SQLiteです。'],
      ['inspect', 'Inspect this repository. What is your stack?', 'TypeScript and Bun.'],
      ['hello', 'こんにちは。Zeroちゃんの構成を教えて', 'TypeScriptとBun、SQLiteです。'],
      ['please', 'お願いします。何使ってる？', 'TypeScriptとBunです。'],
      ['urgent', '急ぎです。What is your stack?', 'TypeScript and Bun.'],
      ['thanks', 'ありがとう。あなたのバックエンドは？', 'SQLiteです。'],
      ['aside-ja', 'ちなみに。Zeroちゃんの構成を教えて', 'ElixirとPhoenixです。'],
      ['curious-en', 'Just curious. What is your stack?', 'Elixir and Phoenix.'],
      ['note-ja', '補足です。何使ってる？', 'FastAPIとRedisです。'],
      ['context-en', 'For context. What is your backend?', 'Django and MongoDB.'],
      ['preface-ja', '前置き。あなたのOSは？', 'FreeBSDです。'],
      ['one-more-en', 'One more thing. What framework do you use?', 'SolidJS.'],
    ] as const) {
      const state = fixtureDir()
      const repo = join(state, `repo-${index}`)
      mkdirSync(repo)
      const store = new JobStore(join(state, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo, task }))
      const job = store.claimNext('serial-worker')!
      const finalized = finalizeSuccessfulExecution(job, {
        sessionId: `self-preamble-${index}`,
        result: answer,
      }, state)
      expect(finalized.result).toBe('内部構成は公開していません。')
      store.close()
    }

    const mixedState = fixtureDir()
    const mixedRepo = join(mixedState, 'mixed-repo')
    mkdirSync(mixedRepo)
    const mixedStore = new JobStore(join(mixedState, 'jobs.sqlite3'))
    mixedStore.enqueue(input({
      repoPath: mixedRepo,
      task: 'READMEを直して。Zeroちゃんのモデルは？',
    }))
    const mixedJob = mixedStore.claimNext('serial-worker')!
    const mixed = finalizeSuccessfulExecution(mixedJob, {
      sessionId: 'substantive-work-and-self-question',
      result: 'READMEを更新しました。\nGPT-5です。',
    }, mixedState)
    expect(mixed.result).toBe('内部構成は公開していません。')
    mixedStore.close()

    const unknownMixedState = fixtureDir()
    const unknownMixedRepo = join(unknownMixedState, 'unknown-mixed-repo')
    mkdirSync(unknownMixedRepo)
    const unknownMixedStore = new JobStore(join(unknownMixedState, 'jobs.sqlite3'))
    unknownMixedStore.enqueue(input({
      repoPath: unknownMixedRepo,
      task: 'READMEを直して。Zeroちゃんの構成は？',
    }))
    const unknownMixedJob = unknownMixedStore.claimNext('serial-worker')!
    const unknownMixed = finalizeSuccessfulExecution(unknownMixedJob, {
      sessionId: 'substantive-work-and-unknown-stack',
      result: 'READMEを更新しました。\nElixirとPhoenixです。',
    }, unknownMixedState)
    expect(unknownMixed.result).toBe('内部構成は公開していません。')
    unknownMixedStore.close()
  })

  test('external technical taskでもZeroちゃん自身の実行・回答モデル文は公開しない', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, task: 'このリポジトリのCodex実装を調べて' }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'external-task-self-execution',
      result: [
        'このリポジトリはCodexを使います。',
        'package.json configures Codex.',
        'Codex handled this request.',
        'This request ran through Codex.',
        'The active model is Codex.',
        'Handled by Codex.',
        'Codex generated this answer.',
        'この依頼はCodexで処理しました。',
        'Codexがこの回答を生成しました。',
        'Codexで回答しました。',
        'Codex handled this repository request.',
        'Codex processed this repository task.',
        'This repository review was handled by Codex.',
        'For this repository, Codex generated the analysis.',
        'Codex analyzed this repository.',
        'Codex reviewed this repository.',
        'Codex inspected this repository.',
        'Codex examined this repository.',
        'Codex is working on this repository.',
        'This repository was analyzed by Codex.',
        'このリポジトリの調査はCodexが処理しました。',
        'このリポジトリ向けの回答はCodexが生成しました。',
        'Codexがこのリポジトリを分析しました。',
        'Codexがこのリポジトリを調査しました。',
        'このリポジトリはCodexがレビューしました。',
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('このリポジトリはCodexを使います。')
    expect(finalized.result).toContain('package.json configures Codex.')
    expect(finalized.result).not.toMatch(/handled this request|request ran through|active model|Handled by|generated this answer|handled this repository|processed this repository|repository review|generated the analysis|analyzed this repository|reviewed this repository|inspected this repository|examined this repository|working on this repository|repository was analyzed|この依頼|この回答|Codexで回答|調査はCodex|向けの回答|リポジトリを分析|リポジトリを調査|Codexがレビュー/i)
    store.close()
  })

  test('明示された一般製品・対象codeの作業結果を内部実装名として誤消去しない', () => {
    for (const [index, task, answer] of [
      ['codex-cli-repo', 'このリポジトリでCodex CLIを使う方法を説明して', 'Codex CLIはコマンドから利用できます。'],
      ['codex-api', 'Codex APIの使い方を説明して', 'Codex APIは公開APIとして利用できます。'],
      ['openai-code', 'このコードはOpenAI APIを使っていますか？', 'このコードはOpenAI APIを使っています。'],
      ['mcp-target', '対象アプリのMCP実装を調査して', '対象アプリのMCP実装を確認しました。'],
      ['claude-config', 'Claude Code向け設定を説明して', 'Claude Code向け設定を説明します。'],
      ['grok-sample', 'Grok 4を使うサンプルを書いて', 'Grok 4を使うサンプルです。'],
    ] as const) {
      const state = fixtureDir()
      const repo = join(state, `repo-${index}`)
      mkdirSync(repo)
      const store = new JobStore(join(state, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo, task }))
      const job = store.claimNext('serial-worker')!
      const finalized = finalizeSuccessfulExecution(job, {
        sessionId: `public-product-work-${index}`,
        result: answer,
      }, state)
      expect(finalized.result).toBe(answer)
      store.close()
    }
  })

  test('suffix付きGPT製品名の一般説明をtoken全体で保持する', () => {
    for (const [index, name] of [
      ['multimodal', 'GPT-4o'],
      ['mini', 'GPT-4.1-mini'],
      ['oss', 'gpt-oss'],
      ['oss-120b', 'gpt-oss-120b'],
      ['bare-version', 'GPT5'],
      ['o-family', 'o123'],
      ['o-family-suffix', 'o12-mini'],
    ] as const) {
      const state = fixtureDir()
      const repo = join(state, `repo-${index}`)
      mkdirSync(repo)
      const store = new JobStore(join(state, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo, task: `${name}について説明して` }))
      const job = store.claimNext('serial-worker')!
      const answer = `${name}は一般に利用されるモデル名です。`
      const finalized = finalizeSuccessfulExecution(job, {
        sessionId: `public-gpt-${index}`,
        result: answer,
      }, state)
      expect(finalized.result).toBe(answer)
      store.close()
    }
  })

  test('ユーザーが明示したversion・variant付き製品名の一般説明を保持する', () => {
    for (const [index, name, answer] of [
      ['claude-sonnet', 'Claude 3.7 Sonnet', 'Claude 3.7 Sonnet is a model.'],
      ['claude-opus', 'Claude Opus 4.1', 'Claude Opus 4.1 is a model.'],
      ['grok-version', 'Grok 4', 'Grok 4 is a model.'],
      ['codex-cli', 'Codex CLI', 'Codex CLI is a coding tool.'],
      ['openai-codex-cli', 'OpenAI Codex CLI', 'OpenAI Codex CLI is a coding tool.'],
      ['mcp-server', 'MCP server', 'MCP server is a public protocol tool.'],
    ] as const) {
      const state = fixtureDir()
      const repo = join(state, `repo-${index}`)
      mkdirSync(repo)
      const store = new JobStore(join(state, 'jobs.sqlite3'))
      store.enqueue(input({ repoPath: repo, task: `${name}について説明して` }))
      const job = store.claimNext('serial-worker')!
      const finalized = finalizeSuccessfulExecution(job, {
        sessionId: `public-variant-${index}`,
        result: answer,
      }, state)
      expect(finalized.result).toBe(answer)
      store.close()
    }
  })

  test('公開URLは保持しlocal URI・多重encode・Windows pathだけを落とす', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, task: '公開リンクと確認結果を教えて' }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'public-url-answer',
      result: [
        'docs: https://developer.apple.com/library/archive/documentation',
        'data: https://example.com/docs/data?next=%2Fdocs',
        'safe-query: https://example.com/search?q=/docs/intro',
        'safe-nested-home-route: https://example.com/docs/home/guide',
        'host-path: https://example.com/Users/alice/report',
        'encoded-host-path: https://example.com/%2FUsers%2Falice%2Fprivate.log',
        'deep-home-path: https://example.com/home/alice/.config/app',
        'safe-home-settings-route: https://example.com/home/account/settings',
        'safe-users-detail-route: https://example.com/Users/list/detail',
        'safe-lowercase-users-route: https://example.com/users/alice/profile',
        'safe-var-chart-route: https://example.com/var/data/charts',
        'safe-nested-usr-route: https://example.com/docs/usr/bin',
        'usr-host-path: https://example.com/usr/bin',
        'opt-host-path: https://example.com/opt/homebrew',
        'app-host-path: https://example.com/Applications/Xcode.app',
        'system-host-path: https://example.com/System/Library',
        'tmp-file-host-path: https://example.com/tmp/secret.txt',
        'volume-host-path: https://example.com/Volumes/Work',
        'confusable-users-host-path: https://example.com/Uѕers/alice/Documents/secret.txt',
        'confusable-home-host-path: https://example.com/hοme/alice/.config/app',
        'confusable-usr-host-path: https://example.com/uѕr/bin',
        'confusable-system-host-path: https://example.com/Ѕystem/Library',
        'confusable-homebrew-host-path: https://example.com/opt/hοmebrew',
        'home-route: https://example.com/home/about',
        'var-route: https://example.com/var/data',
        'tmp-route: https://example.com/tmp/download',
        'host-query: https://example.com/?path=/Users/alice/Projects/zero/state.db',
        'encoded-host-query: https://example.com/search?q=%2FUsers%2Falice%2Fsecret.txt',
        'credential-host-query: https://example.com/?file=/Users/alice/.codex/config.toml',
        'redirect-host-query: https://example.com/?redirect=/Users/alice/secret',
        'next-host-query: https://example.com/?next=/Users/alice/secret',
        'target-host-query: https://example.com/?target=/Users/alice/secret',
        'location-host-query: https://example.com/?location=/Users/alice/secret.txt',
        'dest-host-query: https://example.com/?dest=/home/alice/.config/app',
        'artifact-host-query: https://example.com/?artifact=/private/tmp/result.txt',
        'fragment-host-path: https://example.com/#where=/Users/alice/secret',
        'bare-query-host-path: https://example.com/?/Users/alice/secret',
        'encoded-bare-query-host-path: https://example.com/?%2FUsers%2Falice%2Fsecret',
        'bare-fragment-host-path: https://example.com/#/Users/alice/secret',
        'encoded-bare-fragment-host-path: https://example.com/#%2FUsers%2Falice%2Fsecret',
        'safe-home-hash-route: https://example.com/#/home/dashboard',
        'safe-users-hash-route: https://example.com/#/Users/list',
        'safe-var-hash-route: https://example.com/#/var/charts',
        'safe-deep-home-hash-route: https://example.com/#/home/account/settings',
        'safe-deep-users-hash-route: https://example.com/#/Users/list/detail',
        'safe-deep-var-hash-route: https://example.com/#/var/data/charts',
        'usr-host-hash: https://example.com/#/usr/bin',
        'public-ipv6: https://[2606:4700:4700::1111]/dns',
        'cdn: //cdn.example.com/x.js',
        'public-schemeless: example.com:443/path',
        'schemeless-host-path: example.com/usr/bin',
        'protocol-relative-host-path: //example.com/Users/alice/Projects/private.log',
        'www-schemeless-host-path: www.example.com/home/alice/.config/app',
        'confusable-schemeless-host-path: example.com/Uѕers/alice/Documents/secret.txt',
        'loopback: https://localhost/Users/alice/report',
        'loopback-dot: http://localhost./Users/alice/report',
        'private-network: http://10.0.0.5/admin',
        'single-label: http://buildbox/admin',
        'local-ipv6: http://[::1]/admin',
        'ula-ipv6: http://[fc00::1]/admin',
        'schemeless-localhost: localhost:3000/admin',
        'schemeless-loopback: 127.0.0.1:8765/status',
        'schemeless-private: 10.0.0.5:8080/internal',
        'schemeless-single-label: buildbox:3000/api',
        'schemeless-ipv6: [::1]:3000/admin',
        'schemeless-local-domain: server.local:8080/path',
        'schemeless-localhost-ratio-colon: localhost∶3000/admin',
        'schemeless-localhost-modifier-colon: localhost꞉3000/admin',
        'schemeless-private-ratio-colon: 10.0.0.5∶8080/admin',
        'encoded-schemeless-localhost: %6C%6F%63%61%6C%68%6F%73%74%3A3000%2Fadmin',
        'encoded-localhost-url: %68%74%74%70%3A%2F%2Flocalhost%3A3000%2Fadmin',
        'encoded-localhost-path: %6c%6f%63%61%6c%68%6f%73%74%2fadmin',
        'encoded-private-path: %31%30%2e%30%2e%30%2e%35%2fadmin',
        'raw-localhost-confusable-path: localhost∕admin',
        'encoded-public-path: %65%78%61%6d%70%6c%65%2e%63%6f%6d%2fdocs',
        'mixed-encoded-private-ip: 10.0.%30.5/admin',
        'mixed-encoded-localhost: local%68ost/admin',
        'mixed-encoded-public-host: exam%70le.com/docs',
        'credential-url: https://example.com/.ssh/id_rsa',
        'file-url: file:///Users/alice/Projects/zero/state.db',
        'double-file: file:%252F%252F%252FUsers%252Falice%252FProjects%252Fzero%252Fstate.db',
        'encoded-web-local: https:%2F%2Fexample.invalid%2FUsers%2Falice%2FProjects%2Fzero%2Fstate.db',
        'encoded-home: $HOME%2FProjects%2Fzero%2Fstate.db',
        'encoded-braced-home: %24%7BHOME%7D%2FProjects%2Fzero%2Fstate.db',
        'mixed-braced-home: $%7BHOME%7D%2Fsecret%2Ffile',
        'mixed-closing-brace-home: ${HOME%7D%2Fsecret',
        'double-mixed-closing-brace-home: ${HOME%257D%252Fsecret',
        'mixed-home-name-one: ${HO%4DE}\\work\\secret',
        'mixed-home-name-two: ${H%4FME}\\work\\secret',
        'mixed-bare-home: $H%4FME%2Fsecret',
        'encoded-unc: %255C%255Cserver%255Cshare%255Csecret',
        'encoded-drive-relative: %43%3AUsers%2Falice%2Fsecret.txt',
        'mixed-encoded-drive-relative: C%3AUsers%2Falice%2Fsecret.txt',
        String.raw`mixed-encoded-unc: \\%5Cserver%5Cshare%5Csecret`,
        'encoded-absolute: %2Fworkspace%2Fprivate-project%2Fsecret.txt',
        'double-encoded-absolute: %252Fworkspace%252Fprivate-project%252Fsecret.txt',
        'encoded-repo: %2Frepo%2Fsecret',
        String.raw`windows: C:\Users\alice\.codex\config.toml`,
        String.raw`unc: \\server\share\Users\alice\.ssh\id_rsa`,
        String.raw`extended-unc: \\?\UNC\server\share\secret`,
        String.raw`drive-relative: C:Users\alice\secret`,
        'drive-relative-forward: C:repo/src/file.ts',
        'drive-relative-file: C:secret.txt',
        'drive-relative-env: D:private.env',
        'drive-relative-bare: C:repo',
        'encoded-drive-relative-file: %43%3Asecret.txt',
        String.raw`modifier-colon-drive: C꞉\Users\alice\secret`,
        'ratio-colon-drive-relative: C∶secret.txt',
        'confusable-unc: ⧵⧵server⧵share⧵secret',
        'setminus-unc: ∖∖server∖share∖secret',
        'big-reverse-unc: ⧹⧹server⧹share⧹secret',
        'box-reverse-unc: ╲╲server╲share╲secret',
        'box-forward: ╱Users╱alice╱secret',
        'math-forward: ⟋Users⟋alice⟋secret',
        'math-reverse: ⟍⟍server⟍share⟍secret',
        `encoded-math-forward: ${encodeURIComponent('⟋Users⟋alice⟋secret')}`,
        `encoded-math-reverse: ${encodeURIComponent('⟍⟍server⟍share⟍secret')}`,
        'confusable: ∕Users∕alice∕Projects∕zero∕state.db',
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('https://developer.apple.com/library/archive/documentation')
    expect(finalized.result).toContain('https://example.com/docs/data?next=%2Fdocs')
    expect(finalized.result).toContain('https://example.com/search?q=/docs/intro')
    expect(finalized.result).toContain('https://example.com/docs/home/guide')
    expect(finalized.result).toContain('https://example.com/Users/alice/report')
    expect(finalized.result).toContain('https://example.com/home/about')
    expect(finalized.result).toContain('https://example.com/var/data')
    expect(finalized.result).toContain('https://example.com/tmp/download')
    expect(finalized.result).toContain('https://[2606:4700:4700::1111]/dns')
    expect(finalized.result).toContain('//cdn.example.com/x.js')
    expect(finalized.result).toContain('example.com:443/path')
    expect(finalized.result).toContain('https://example.com/#/home/dashboard')
    expect(finalized.result).toContain('https://example.com/#/Users/list')
    expect(finalized.result).toContain('https://example.com/#/var/charts')
    expect(finalized.result).toContain('https://example.com/home/account/settings')
    expect(finalized.result).toContain('https://example.com/Users/list/detail')
    expect(finalized.result).toContain('https://example.com/users/alice/profile')
    expect(finalized.result).toContain('https://example.com/var/data/charts')
    expect(finalized.result).toContain('https://example.com/docs/usr/bin')
    expect(finalized.result).toContain('https://example.com/#/home/account/settings')
    expect(finalized.result).toContain('https://example.com/#/Users/list/detail')
    expect(finalized.result).toContain('https://example.com/#/var/data/charts')
    expect(finalized.result).toContain('https://example.com/#/Users/alice/secret')
    expect(finalized.result).toContain('https://example.com/#%2FUsers%2Falice%2Fsecret')
    expect(finalized.result).toContain('%65%78%61%6d%70%6c%65%2e%63%6f%6d%2fdocs')
    expect(finalized.result).toContain('exam%70le.com/docs')
    expect(finalized.result).not.toMatch(/localhost\.?\/|10\.0\.0\.5|buildbox|\[::1\]|\[fc00::1\]|\.ssh\/|file:(?:\/|%)|https:%2F|\$HOME%|%24|%255C|C:(?:\\)?Users|\\\\(?:\?\\UNC\\)?server|∕Users|⧵⧵server|∖∖server|⧹⧹server|╲╲server|╱Users/i)
    expect(finalized.result).not.toMatch(/example\.com\/\?path=\/Users|example\.com\/search\?q=%2FUsers%2Falice|example\.com\/\?file=/i)
    expect(finalized.result).not.toMatch(/example\.com\/(?:\?|#)(?:redirect|next|target|location|dest|artifact|where)=/i)
    expect(finalized.result).not.toMatch(/example\.com\/\?(?:\/Users\/alice\/secret|%2FUsers%2Falice%2Fsecret)/i)
    expect(finalized.result).not.toMatch(/example\.com\/(?:%2FUsers%2Falice|home\/alice\/\.config|usr\/bin|opt\/homebrew|Applications\/Xcode\.app|System\/Library|tmp\/secret\.txt|Volumes\/Work)/i)
    expect(finalized.result).not.toContain('https://example.com/#/usr/bin')
    expect(finalized.result).not.toContain('//example.com/Users/alice/Projects/private.log')
    expect(finalized.result).not.toContain('www.example.com/home/alice/.config/app')
    expect(finalized.result).not.toMatch(/Uѕers|hοme|uѕr|Ѕystem|hοmebrew/)
    expect(finalized.result).not.toContain('%43%3AUsers%2Falice%2Fsecret.txt')
    expect(finalized.result).not.toContain('C%3AUsers%2Falice%2Fsecret.txt')
    expect(finalized.result).not.toContain(String.raw`\\%5Cserver%5Cshare%5Csecret`)
    expect(finalized.result).not.toContain('$%7BHOME%7D%2Fsecret%2Ffile')
    expect(finalized.result).not.toContain('${HOME%7D%2Fsecret')
    expect(finalized.result).not.toContain('${HOME%257D%252Fsecret')
    expect(finalized.result).not.toMatch(/\$\{HO%4DE\}|\$\{H%4FME\}|\\work\\secret/i)
    expect(finalized.result).not.toContain('$H%4FME%2Fsecret')
    expect(finalized.result).not.toContain('%2Fworkspace%2Fprivate-project%2Fsecret.txt')
    expect(finalized.result).not.toContain('%252Fworkspace%252Fprivate-project%252Fsecret.txt')
    expect(finalized.result).not.toContain('%2Frepo%2Fsecret')
    expect(finalized.result).not.toContain('C:repo/src/file.ts')
    expect(finalized.result).not.toMatch(/C:secret\.txt|D:private\.env|C:repo|%43%3Asecret\.txt/i)
    expect(finalized.result).not.toMatch(/C꞉\\Users|C∶secret\.txt/i)
    expect(finalized.result).not.toMatch(/localhost:3000|127\.0\.0\.1:8765|10\.0\.0\.5:8080|buildbox:3000|\[::1\]:3000|server\.local:8080/i)
    expect(finalized.result).not.toMatch(/localhost[∶꞉]3000|10\.0\.0\.5∶8080|localhost∕admin|10\.0\.%30\.5|local%68ost|%6C%6F%63|%31%30%2e%30|%68%74%74%70/i)
    expect(finalized.result).not.toMatch(/⟋Users|⟍⟍server|%E2%9F%8[BD]/i)
    expect(finalized.result).toContain('内部パスを省略')
    store.close()
  })

  test('既知host home prefixをpublic URLへ埋め込んでもrouteとして公開しない', () => {
    const state = fixtureDir()
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: '/Users/runtime-user/dev/zero', task: '状況を教えて' }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'known-host-home-prefix',
      result: [
        'private-path: https://example.com/Users/runtime-user/dev',
        'private-hash: https://example.com/#/Users/runtime-user/dev',
        'confusable-private-path: https://example.com/Users/runtime-uѕer/dev',
        'confusable-private-hash: https://example.com/#/Users/runtime-uѕer/dev',
        'safe-route: https://example.com/Users/list/detail',
      ].join('\n'),
    }, state)
    expect(finalized.result).not.toContain('/Users/runtime-user/dev')
    expect(finalized.result).not.toContain('/Users/runtime-uѕer/dev')
    expect(finalized.result).toContain('https://example.com/Users/list/detail')
    store.close()
  })

  test('percent encodingした内部実装名・runtime IDもSlack本文へ出さない', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo-percent-internal-id')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, task: '状況を教えて' }))
    const job = store.claimNext('serial-worker')!
    const encodedJobId = job.id.replaceAll('-', '%2D')
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'percent-internal-answer',
      result: [
        '確認が完了しました。',
        'Cod%65xで処理しました。',
        '%43%6F%64%65%78で処理しました。',
        'Cl%61ude%20Codeで動いています。',
        'Gr%6Fkを呼びました。',
        'Her%64rを使います。',
        '%47%50%54%2D%35です。',
        `id: ${encodedJobId}`,
        'pid%3D12345',
        'five-layer: %2525252565',
        '進捗は50%25です。',
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('確認が完了しました。')
    expect(finalized.result).toContain('進捗は50%25です。')
    expect(finalized.result).not.toMatch(/Cod%65x|%43%6F%64|Cl%61ude|Gr%6Fk|Her%64r|%47%50%54|pid%3D|%2525252565/i)
    expect(finalized.result).not.toContain(encodedJobId)
    store.close()
  })

  test('senderが明示したpublic URLはlocal host・credentialでない限り同じ綴りを保持する', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo-user-public-url')
    mkdirSync(repo)
    const userUrl = 'https://example.com/search?path=/Users/alice/report'
    const userPathUrl = 'https://example.com/Users/alice/report'
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, task: `${userUrl} と ${userPathUrl} を確認して` }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'user-authored-public-url',
      result: `確認先: ${userUrl}\n確認先: ${userPathUrl}`,
    }, state)
    expect(finalized.result).toContain(userUrl)
    expect(finalized.result).toContain(userPathUrl)
    store.close()
  })

  test('unsafe artifact名を置換しても内部実装名を拡張子として再利用しない', () => {
    const state = fixtureDir()
    const repo = join(state, 'artifact-extension-repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo }))
    const job = store.claimNext('serial-worker')!
    const outbox = artifactDirForJob(state, job.id)
    mkdirSync(outbox, { recursive: true })
    for (const [filename, expected] of [
      ['report.codex', 'result'],
      ['report.claude', 'result'],
      ['report.grok', 'result'],
      ['report.o3', 'result'],
      ['unsafe codex report.png', 'result.png'],
      ['unsafe codex report.pdf', 'result.pdf'],
      ['unsafe codex report.zip', 'result.zip'],
    ] as const) {
      const source = join(outbox, filename)
      writeFileSync(source, 'artifact payload')
      const result = sealArtifactResult(
        job,
        `done\n<zerokun_files>${JSON.stringify([source])}</zerokun_files>`,
        state,
      )
      const sealed = extractArtifactPaths(result).files[0]!
      expect(readUploadableArtifact(job, sealed, state).filename).toBe(expected)
    }
    store.close()
  })

  test('日本語やJSON escapeへ直結したhost pathもSlackへ残さない', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, task: '内部処理の結果だけ教えて' }))
    const job = store.claimNext('serial-worker')!
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'adjacent-path-answer',
      result: [
        '確認しました。',
        '内部処理は/opt/homebrew/bin/herdrで動作します。',
        'cwd:/Users/example/.codex/config.toml',
        'space:/Users/example/My Project/a.txt',
        'unicode:/Users/example/秘密/a.txt',
        'nonstandard:/srv/My Project/秘密.txt',
        'system:/System/Volumes/Data/Users/alice/My Project/秘密.txt',
        'network: //Users/local/.ssh/id_rsa',
        'triple: ///tmp/private-output.txt',
        '確認は~/.codex/zerokun/job-logs/id.stdout.logです。',
        '鍵は ~/.ssh/id_rsa です。',
        'cloud: ~/.aws/credentials',
        'git: $HOME/.git-credentials',
        'braced: ${HOME}/private/config',
        '専用helperは~/.zerokun/runtime/fifth-advisor.pyです。',
        '相対設定は.zerokun/runtime/fifth-advisor.pyです。',
        String.raw`JSONは\/Users\/example\/.codex\/zerokun\/job.logです。`,
        '参照: https://example.invalid/Users/local/.ssh/id_rsa',
        'local: file://localhost/etc/passwd',
        'editor: vscode://file/Users/local/.aws/credentials',
        'internal: zerokun://localhost/Users/me/.ssh/id_rsa',
        'engine: codex://host/opt/homebrew/bin/herdr',
        'local-triple: zerokun:///etc/passwd',
        'encoded: https://example.invalid/%2FUsers%2Flocal%2F.ssh%2Fid_rsa',
        '[詳細](https://example.invalid/opt/homebrew/bin/herdr)',
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('確認しました。')
    expect(finalized.result).not.toMatch(/\/opt\/homebrew|\/Users\/example|~\/\.codex|\\\/Users/i)
    expect(finalized.result).not.toMatch(/My Project|秘密|\.zerokun|example\.invalid|file:\/\/|vscode:\/\//i)
    expect(finalized.result).not.toMatch(/id_rsa|passwd|credentials|homebrew\/bin|\/srv|\/System|\/\/Users|\/\/\/tmp/i)
    expect(finalized.result).not.toMatch(/~\/\.ssh|~\/\.aws|\$HOME|zerokun:\/\/|codex:\/\//i)
    store.close()
  })

  test('host生成の添付suffixをユーザー本文とみなさずfollow-up pathと内部名を消す', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, task: '添付内容を確認して' }))
    const job = store.claimNext('serial-worker')!
    const attachment = join(
      state,
      '.codex',
      'zerokun',
      'live-input',
      job.id,
      '1800000001.000200',
      '000-FABC1234.txt',
    )
    const target = store.liveControlTarget(job.chatId, job.threadTs)!
    expect(store.stageLiveControl(target, {
      chatId: job.chatId,
      threadTs: job.threadTs,
      messageId: '1800000001.000200',
      userId: 'UFOLLOWUP123',
      task: `追加の添付も確認して\n添付ファイル（ローカル絶対パス）:\n- ${attachment}`,
      attachments: [attachment],
      kind: 'steer',
    })).toBe('staged')
    const finalized = finalizeSuccessfulExecution(job, {
      sessionId: 'attachment-host-suffix-session',
      result: [
        '確認しました。Codex の内部処理結果です。',
        `添付は ${attachment} です。`,
        '相対表示は .codex/zerokun/live-input/example.txt です。',
        '送信元は 1800000001.000200 / UFOLLOWUP123 です。',
      ].join('\n'),
    }, state)
    expect(finalized.result).toContain('確認しました。')
    expect(finalized.result).not.toMatch(/Codex|\.codex|live-input/i)
    expect(finalized.result).not.toContain(attachment)
    expect(finalized.result).not.toContain('1800000001.000200')
    expect(finalized.result).not.toContain('UFOLLOWUP123')
    store.close()
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
    store.enqueue(input({ repoPath: repo, task: 'Codexの成果物を出して' }))
    const job = store.claimNext('serial-worker')!
    const outbox = artifactDirForJob(state, job.id)
    mkdirSync(outbox, { recursive: true })
    const good = join(outbox, 'report.txt')
    const internalName = join(outbox, `${job.id}.txt`)
    const encodedLocalName = join(
      outbox,
      'report%2FUsers%2Falice%2F.ssh%2Fid_rsa.txt',
    )
    const implementationName = join(outbox, 'codex-runtime-report.txt')
    const inflectedImplementationName = join(outbox, 'Cοԁexе-report.txt')
    const secret = join(dir, 'secret.txt')
    const escaped = join(outbox, 'escaped.txt')
    const hardlink = join(outbox, 'hardlink.txt')
    const fifo = join(outbox, 'pipe')
    const empty = join(outbox, 'empty.txt')
    writeFileSync(good, 'safe report')
    writeFileSync(internalName, 'safe internal-name report')
    writeFileSync(encodedLocalName, 'safe encoded-name report')
    writeFileSync(implementationName, 'safe implementation-name report')
    writeFileSync(inflectedImplementationName, 'safe confusable-name report')
    writeFileSync(empty, '')
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
      const internalSealedResult = sealArtifactResult(
        job,
        `完了\n<zerokun_files>${JSON.stringify([internalName])}</zerokun_files>`,
        state,
      )
      const [internalSealed] = extractArtifactPaths(internalSealedResult).files
      const internalUpload = readUploadableArtifact(job, internalSealed!, state)
      expect(internalUpload.data.toString()).toBe('safe internal-name report')
      expect(internalUpload.filename).toBe('result.txt')
      expect(internalUpload.filename).not.toContain(job.id)
      const encodedNameResult = sealArtifactResult(
        job,
        `完了\n<zerokun_files>${JSON.stringify([encodedLocalName])}</zerokun_files>`,
        state,
      )
      const [encodedNameSealed] = extractArtifactPaths(encodedNameResult).files
      const encodedNameUpload = readUploadableArtifact(job, encodedNameSealed!, state)
      expect(encodedNameUpload.data.toString()).toBe('safe encoded-name report')
      expect(encodedNameUpload.filename).toBe('result.txt')
      expect(encodedNameUpload.filename).not.toMatch(/Users|\.ssh|id_rsa|%2F/i)
      const implementationNameResult = sealArtifactResult(
        job,
        `完了\n<zerokun_files>${JSON.stringify([implementationName])}</zerokun_files>`,
        state,
      )
      const [implementationNameSealed] = extractArtifactPaths(implementationNameResult).files
      const implementationNameUpload = readUploadableArtifact(job, implementationNameSealed!, state)
      expect(implementationNameUpload.data.toString()).toBe('safe implementation-name report')
      expect(implementationNameUpload.filename).toBe('result.txt')
      const inflectedNameResult = sealArtifactResult(
        job,
        `完了\n<zerokun_files>${JSON.stringify([inflectedImplementationName])}</zerokun_files>`,
        state,
      )
      const [inflectedNameSealed] = extractArtifactPaths(inflectedNameResult).files
      const inflectedNameUpload = readUploadableArtifact(job, inflectedNameSealed!, state)
      expect(inflectedNameUpload.data.toString()).toBe('safe confusable-name report')
      expect(inflectedNameUpload.filename).toBe('result.txt')
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
      expect(() => sealArtifactResult(
        job,
        `<zerokun_files>${JSON.stringify([empty])}</zerokun_files>`,
        state,
      )).toThrow('empty')
    } finally {
      store.close()
    }
  })

  test('任意のbinaryと実装名を許可し、明白なcredential bytesだけを拒否する', () => {
    const dir = fixtureDir()
    const state = join(dir, 'state')
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, messageId: 'artifact-lightweight-policy' }))
    const job = store.claimNext('serial-worker')!
    const outbox = artifactDirForJob(state, job.id)
    mkdirSync(outbox, { recursive: true })
    const binary = join(outbox, 'diagram.png')
    const implementationNotes = join(outbox, 'implementation.txt')
    const credential = join(outbox, 'credential.bin')
    writeFileSync(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]))
    writeFileSync(implementationNotes, 'Codex and Claude implementation notes are allowed internally.')
    writeFileSync(
      credential,
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('xoxb-fixtureCredential1234567890')]),
    )
    try {
      const sealedResult = sealArtifactResult(
        job,
        `done\n<zerokun_files>${JSON.stringify([binary, implementationNotes, credential])}</zerokun_files>`,
        state,
      )
      const [sealedBinary, sealedNotes, sealedCredential] = extractArtifactPaths(sealedResult).files
      expect(readUploadableArtifact(job, sealedBinary!, state).data).toEqual(readFileSync(binary))
      expect(readUploadableArtifact(job, sealedNotes!, state).data.toString()).toContain('Codex and Claude')
      expect(() => readUploadableArtifact(job, sealedCredential!, state))
        .toThrow(ArtifactPublicationBlockedError)
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
    const internalId = '44e79459-7358-4dd9-bdc6-65c208050875'
    const outside = join(state, internalId, 'not-allowed.txt')
    mkdirSync(dirname(outside), { recursive: true })
    writeFileSync(outside, 'secret')
    const result = finalizeSuccessfulExecution(job, {
      sessionId: 'successful-write-session',
      result: `変更は完了しました。\n<zerokun_files>[${JSON.stringify(outside)}]</zerokun_files>`,
    }, state)
    expect(result.sessionId).toBe('successful-write-session')
    expect(result.result).toContain('変更は完了しました。')
    expect(result.result).toContain('ファイル添付だけを省略しました')
    expect(result.result).not.toContain(internalId)
    expect(result.result).not.toContain(outside)
    expect(result.result).not.toMatch(/Codex|worker|job/i)
    expect(extractArtifactPaths(result.result).files).toEqual([])
    store.close()
  })

  test('成果物添付打ち切り文面はraw error・内部ID・実装名をSlackへ出さない', () => {
    const internalError = 'artifact /private/tmp/44e79459-7358-4dd9-bdc6-65c208050875 missing'
    const message = slackArtifactsAbandonedMessage()
    expect(message).toContain('添付を打ち切りました')
    expect(message).not.toContain(internalError)
    expect(message).not.toContain('44e79459-7358-4dd9-bdc6-65c208050875')
    expect(message).not.toContain('/private/tmp')
    expect(message).not.toMatch(/Codex|worker|job/i)
  })

  test('巨大な非string artifact markerを除去してjournalを復旧可能に保つ', () => {
    const state = fixtureDir()
    const repo = join(state, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    const queued = store.enqueue(input({
      repoPath: repo, messageId: 'bounded-artifact-marker',
    })).job
    const running = store.claimNext('serial-worker')!
    const raw = `完了\n<zerokun_files>[${'0,'.repeat(160_000)}0]</zerokun_files>`
    const finalized = finalizeSuccessfulExecution(running, {
      sessionId: 'bounded-session', result: raw,
    }, state)
    expect(finalized.result).toBe('完了')
    persistExecutionResultJournal(state, running, finalized)
    expect(recoverExecutionResultJournals(store, state)).toBe(1)
    store.completeStagedExecution(queued.id)
    expect(store.get(queued.id)).toMatchObject({ status: 'completed', result: '完了' })
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
      expect(store.recoverInterrupted()).toEqual({ requeued: 1, failedWrites: 0, failedUncertain: 0 })
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
  function productionArtifactFixture(messageId: string) {
    const store = makeStore()
    const state = dirname(store.dbPath)
    const running = store.enqueue(input({ messageId })).job
    const job = store.claimNext('serial-worker')!
    const outbox = artifactDirForJob(state, job.id)
    mkdirSync(outbox, { recursive: true })
    const source = join(outbox, 'report.txt')
    writeFileSync(source, 'artifact payload')
    const result = sealArtifactResult(
      job,
      `done\n<zerokun_files>${JSON.stringify([source])}</zerokun_files>`,
      state,
    )
    store.complete(job.id, 'thread-artifact', result)
    const notification = store.pendingTerminalNotifications()[0]!
    store.markTerminalNotificationBodyDelivered(notification.id)
    return {
      store,
      job: store.get(running.id)!,
      result,
      notificationId: notification.id,
      artifact: extractArtifactPaths(result).files[0]!,
    }
  }

  test('内部IDを含むartifact名はupload URL取得とcompleteの両方で同じ安全名にする', async () => {
    const store = makeStore()
    const state = dirname(store.dbPath)
    const queued = store.enqueue(input({ messageId: 'artifact-internal-title' })).job
    const running = store.claimNext('serial-worker')!
    const outbox = artifactDirForJob(state, running.id)
    mkdirSync(outbox, { recursive: true })
    const source = join(outbox, `${running.id}.txt`)
    writeFileSync(source, 'artifact payload')
    const result = sealArtifactResult(
      running,
      `done\n<zerokun_files>${JSON.stringify([source])}</zerokun_files>`,
      state,
    )
    store.complete(running.id, 'thread-artifact-title', result)
    const notification = store.pendingTerminalNotifications()[0]!
    store.markTerminalNotificationBodyDelivered(notification.id)
    const observedNames: string[] = []
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      requestUploadTarget: async filename => {
        observedNames.push(filename)
        return { uploadUrl: 'https://files.slack.com/upload/v1/test', fileId: 'FSAFE' }
      },
      uploadBytes: async (_url, _data, beforeRequestWrite) => {
        beforeRequestWrite()
      },
      completeUpload: async input => {
        observedNames.push(input.filename)
      },
    })
    await notifier.completed(
      store.get(queued.id)!, result, notification.id,
    )
    expect(observedNames).toEqual(['result.txt', 'result.txt'])
    expect(observedNames.join(' ')).not.toContain(running.id)
    store.close()
  })

  test('不可視文字で分割したcredentialをartifact名からも除去する', async () => {
    const store = makeStore()
    const state = dirname(store.dbPath)
    const queued = store.enqueue(input({ messageId: 'artifact-invisible-token-title' })).job
    const running = store.claimNext('serial-worker')!
    const outbox = artifactDirForJob(state, running.id)
    mkdirSync(outbox, { recursive: true })
    const source = join(outbox, 'xoxb-\u200E1234567890-abcdefghijklmnopqrstuvwxyz.txt')
    writeFileSync(source, 'artifact payload')
    const result = sealArtifactResult(
      running,
      `done\n<zerokun_files>${JSON.stringify([source])}</zerokun_files>`,
      state,
    )
    store.complete(running.id, 'thread-invisible-token-title', result)
    const notification = store.pendingTerminalNotifications()[0]!
    store.markTerminalNotificationBodyDelivered(notification.id)
    const observedNames: string[] = []
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      requestUploadTarget: async filename => {
        observedNames.push(filename)
        return { uploadUrl: 'https://files.slack.com/upload/v1/test', fileId: 'FSAFE' }
      },
      uploadBytes: async (_url, _data, beforeRequestWrite) => {
        beforeRequestWrite()
      },
      completeUpload: async input => {
        observedNames.push(input.filename)
      },
    })
    await notifier.completed(store.get(queued.id)!, result, notification.id)
    expect(observedNames).toEqual(['result.txt', 'result.txt'])
    expect(observedNames.join(' ')).not.toContain('xoxb')
    expect(observedNames.join(' ')).not.toContain('\u200E')
    store.close()
  })

  test('credential artifactだけをupload前に止め、同じ結果の安全なbinaryは配送する', async () => {
    const store = makeStore()
    const state = dirname(store.dbPath)
    const queued = store.enqueue(input({ messageId: 'artifact-publication-policy' })).job
    const running = store.claimNext('serial-worker')!
    const outbox = artifactDirForJob(state, running.id)
    mkdirSync(outbox, { recursive: true })
    const blockedSource = join(outbox, 'blocked.bin')
    const safeSource = join(outbox, 'safe.png')
    writeFileSync(blockedSource, Buffer.from('prefix\0xoxb-fixtureCredential1234567890\0suffix'))
    writeFileSync(safeSource, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]))
    const result = sealArtifactResult(
      running,
      `done\n<zerokun_files>${JSON.stringify([blockedSource, safeSource])}</zerokun_files>`,
      state,
    )
    const [blocked, safe] = extractArtifactPaths(result).files
    store.complete(running.id, 'thread-artifact-policy', result)
    const notification = store.pendingTerminalNotifications()[0]!
    store.markTerminalNotificationBodyDelivered(notification.id)
    const uploadTargets: string[] = []
    const uploaded: Buffer[] = []
    const posted: Array<{ text: string; clientMessageId?: string }> = []
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      postMessage: async input => {
        posted.push({ text: input.text, clientMessageId: input.clientMessageId })
      },
      requestUploadTarget: async filename => {
        uploadTargets.push(filename)
        return { uploadUrl: 'https://files.slack.com/upload/v1/test', fileId: 'FSAFE' }
      },
      uploadBytes: async (_url, data, beforeRequestWrite) => {
        beforeRequestWrite()
        uploaded.push(Buffer.from(data))
      },
      completeUpload: async () => {},
    })
    await notifier.completed(store.get(queued.id)!, result, notification.id)
    expect(store.artifactDeliveryState(queued.id, blocked!)).toBe('abandoned')
    expect(store.artifactDeliveryState(queued.id, safe!)).toBe('delivered')
    expect(store.publicationBlockedArtifactCount(queued.id)).toBe(1)
    expect(store.abandonedArtifactCount(queued.id)).toBe(0)
    expect(uploadTargets).toEqual(['safe.png'])
    expect(uploaded).toEqual([readFileSync(safeSource)])
    expect(posted).toHaveLength(1)
    expect(posted[0]?.text).toBe(slackArtifactPublicationBlockedMessage())
    expect(posted[0]?.clientMessageId).toMatch(/^[0-9a-f-]{36}$/)
    store.close()
  })

  test('pre-start abortはupload targetもintentも作らず再試行可能に保つ', async () => {
    const value = productionArtifactFixture('artifact-pre-abort')
    let targetRequests = 0
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, value.store, {
      requestUploadTarget: async () => {
        targetRequests += 1
        return { uploadUrl: 'https://files.slack.com/upload/v1/test', fileId: 'FTEST' }
      },
    })
    const controller = new AbortController()
    controller.abort()
    await expect(notifier.completed(
      value.job,
      value.result,
      value.notificationId,
      controller.signal,
    )).rejects.toThrow('aborted before start')
    expect(targetRequests).toBe(0)
    expect(value.store.artifactDeliveryState(value.job.id, value.artifact)).toBe('ready')
    value.store.close()
  })

  test('upload URL取得中のabortもbyte転送せず次回再試行できる', async () => {
    const value = productionArtifactFixture('artifact-target-abort')
    let targetRequests = 0
    let byteUploads = 0
    let releaseFirstTarget!: () => void
    const firstTarget = new Promise<void>(resolve => { releaseFirstTarget = resolve })
    let announceFirstTarget!: () => void
    const firstTargetStarted = new Promise<void>(resolve => { announceFirstTarget = resolve })
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, value.store, {
      requestUploadTarget: async () => {
        targetRequests += 1
        if (targetRequests === 1) {
          announceFirstTarget()
          await firstTarget
        }
        return { uploadUrl: 'https://files.slack.com/upload/v1/test', fileId: 'FTEST' }
      },
      uploadBytes: async (_url, _data, beforeRequestWrite) => {
        beforeRequestWrite()
        byteUploads += 1
      },
      completeUpload: async () => {},
    })
    const controller = new AbortController()
    const first = notifier.completed(
      value.job,
      value.result,
      value.notificationId,
      controller.signal,
    )
    await firstTargetStarted
    controller.abort()
    releaseFirstTarget()
    await expect(first).rejects.toThrow('aborted before byte transfer')
    expect(byteUploads).toBe(0)
    expect(value.store.artifactDeliveryState(value.job.id, value.artifact)).toBe('ready')
    await notifier.completed(value.job, value.result, value.notificationId)
    expect(targetRequests).toBe(2)
    expect(byteUploads).toBe(1)
    expect(value.store.artifactDeliveryState(value.job.id, value.artifact)).toBe('delivered')
    value.store.close()
  })

  test('upload URL取得の明示失敗はintent前なので次flushで再試行する', async () => {
    const value = productionArtifactFixture('artifact-target-retry')
    let targetRequests = 0
    let byteUploads = 0
    let completions = 0
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, value.store, {
      requestUploadTarget: async () => {
        targetRequests += 1
        if (targetRequests === 1) throw new Error('getUploadURLExternal rejected')
        return { uploadUrl: 'https://files.slack.com/upload/v1/test', fileId: 'FTEST' }
      },
      uploadBytes: async (_url, data, beforeRequestWrite) => {
        beforeRequestWrite()
        byteUploads += 1
        expect(data.toString()).toBe('artifact payload')
      },
      completeUpload: async () => { completions += 1 },
    })
    await expect(notifier.completed(
      value.job,
      value.result,
      value.notificationId,
    )).rejects.toThrow('getUploadURLExternal rejected')
    expect(value.store.artifactDeliveryState(value.job.id, value.artifact)).toBe('ready')
    await notifier.completed(value.job, value.result, value.notificationId)
    expect(targetRequests).toBe(2)
    expect(byteUploads).toBe(1)
    expect(completions).toBe(1)
    expect(value.store.artifactDeliveryState(value.job.id, value.artifact)).toBe('delivered')
    value.store.close()
  })

  test('transportがdurable byte境界前に失敗すればreadyのまま再試行する', async () => {
    const value = productionArtifactFixture('artifact-transport-pre-boundary-retry')
    let uploadAttempts = 0
    let completions = 0
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, value.store, {
      requestUploadTarget: async () => ({
        uploadUrl: 'https://files.slack.com/upload/v1/test', fileId: 'FBOUNDARY',
      }),
      uploadBytes: async (_url, _data, beforeRequestWrite) => {
        uploadAttempts += 1
        if (uploadAttempts === 1) throw new Error('request construction failed')
        beforeRequestWrite()
      },
      completeUpload: async () => { completions += 1 },
    })
    await expect(notifier.completed(
      value.job, value.result, value.notificationId,
    )).rejects.toThrow('request construction failed')
    expect(value.store.artifactDeliveryState(value.job.id, value.artifact)).toBe('ready')
    await notifier.completed(value.job, value.result, value.notificationId)
    expect(uploadAttempts).toBe(2)
    expect(completions).toBe(1)
    expect(value.store.artifactDeliveryState(value.job.id, value.artifact)).toBe('delivered')
    value.store.close()
  })

  test('byte transfer開始後の失敗はambiguous固定で自動再送しない', async () => {
    const value = productionArtifactFixture('artifact-transfer-ambiguous')
    let targetRequests = 0
    let byteUploads = 0
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, value.store, {
      requestUploadTarget: async () => {
        targetRequests += 1
        return { uploadUrl: 'https://files.slack.com/upload/v1/test', fileId: 'FTEST' }
      },
      uploadBytes: async (_url, _data, beforeRequestWrite) => {
        beforeRequestWrite()
        byteUploads += 1
        throw new Error('PUT response missing')
      },
      inspectUpload: async () => false,
    })
    await expect(notifier.completed(
      value.job,
      value.result,
      value.notificationId,
    )).rejects.toBeInstanceOf(ArtifactDeliveryAmbiguousError)
    expect(value.store.artifactDeliveryState(value.job.id, value.artifact)).toBe('ambiguous')
    await expect(notifier.completed(
      value.job,
      value.result,
      value.notificationId,
    )).rejects.toBeInstanceOf(ArtifactDeliveryAmbiguousError)
    expect(targetRequests).toBe(1)
    expect(byteUploads).toBe(1)
    value.store.close()
  })

  test('再起動相当のfiles.info照合で同じthreadへの共有済みartifactを確定する', async () => {
    const value = productionArtifactFixture('artifact-info-reconcile')
    let byteUploads = 0
    let inspections = 0
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, value.store, {
      requestUploadTarget: async () => ({
        uploadUrl: 'https://files.slack.com/upload/v1/test',
        fileId: 'FRECONCILE',
      }),
      uploadBytes: async (_url, _data, beforeRequestWrite) => {
        beforeRequestWrite()
        byteUploads += 1
        throw new Error('response lost after possible byte transfer')
      },
      inspectUpload: async input => {
        inspections += 1
        expect(input).toEqual({
          fileId: 'FRECONCILE',
          chatId: value.job.chatId,
          threadTs: value.job.threadTs,
        })
        return true
      },
    })
    await expect(notifier.completed(
      value.job, value.result, value.notificationId,
    )).rejects.toBeInstanceOf(ArtifactDeliveryAmbiguousError)
    expect(value.store.artifactDeliveryState(value.job.id, value.artifact)).toBe('ambiguous')
    await notifier.completed(value.job, value.result, value.notificationId)
    expect(inspections).toBe(1)
    expect(byteUploads).toBe(1)
    expect(value.store.artifactDeliveryState(value.job.id, value.artifact)).toBe('delivered')
    value.store.close()
  })

  test('files.infoはchannelとthread_tsの両方が一致した共有だけを採択する', () => {
    const file = {
      shares: {
        public: {
          COTHER: [{ thread_ts: '1800000000.000100' }],
        },
        private: {
          C0123456789: [{ thread_ts: '1800000000.000100' }],
        },
      },
    }
    expect(slackFileIsSharedInThread(
      file, 'C0123456789', '1800000000.000100',
    )).toBe(true)
    expect(slackFileIsSharedInThread(
      file, 'C0123456789', '1800000000.999999',
    )).toBe(false)
    expect(slackFileIsSharedInThread(file, 'CMISSING', '1800000000.000100')).toBe(false)
  })

  test('先頭artifactがambiguousでも後続ready artifactの配送を妨げない', async () => {
    const dir = fixtureDir()
    const state = join(dir, 'state')
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    store.enqueue(input({ repoPath: repo, messageId: 'mixed-artifacts' }))
    const running = store.claimNext('serial-worker')!
    const outbox = artifactDirForJob(state, running.id)
    mkdirSync(outbox, { recursive: true })
    const first = join(outbox, 'first.txt')
    const second = join(outbox, 'second.txt')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    const result = sealArtifactResult(
      running,
      `done\n<zerokun_files>${JSON.stringify([first, second])}</zerokun_files>`,
      state,
    )
    const [sealedFirst, sealedSecond] = extractArtifactPaths(result).files
    store.complete(running.id, 'thread-mixed-artifacts', result)
    const notification = store.pendingTerminalNotifications()[0]!
    store.markTerminalNotificationBodyDelivered(notification.id)
    expect(store.beginArtifactDelivery(running.id, sealedFirst!, 'FALREADY')).toBe('started')
    let byteUploads = 0
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      requestUploadTarget: async () => ({
        uploadUrl: 'https://files.slack.com/upload/v1/test', fileId: 'FSECOND',
      }),
      uploadBytes: async (_url, _data, beforeRequestWrite) => {
        beforeRequestWrite()
        byteUploads += 1
      },
      completeUpload: async () => {},
      inspectUpload: async () => false,
    })
    await expect(notifier.completed(
      store.get(running.id)!, result, notification.id,
    )).rejects.toBeInstanceOf(ArtifactDeliveryAmbiguousError)
    expect(byteUploads).toBe(1)
    expect(store.artifactDeliveryState(running.id, sealedFirst!)).toBe('ambiguous')
    expect(store.artifactDeliveryState(running.id, sealedSecond!)).toBe('delivered')
    store.close()
  })

  test('production notifierはPUT開始後のshutdownをcompleteとreceiptまで待つ', async () => {
    const value = productionArtifactFixture('artifact-production-drain')
    let announceUpload!: () => void
    const uploadStarted = new Promise<void>(resolve => { announceUpload = resolve })
    let releaseUpload!: () => void
    const uploadFinished = new Promise<void>(resolve => { releaseUpload = resolve })
    let completions = 0
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, value.store, {
      requestUploadTarget: async () => ({
        uploadUrl: 'https://files.slack.com/upload/v1/test',
        fileId: 'FTEST',
      }),
      uploadBytes: async (_url, _data, beforeRequestWrite) => {
        beforeRequestWrite()
        announceUpload()
        await uploadFinished
      },
      completeUpload: async () => { completions += 1 },
    })
    const controller = new AbortController()
    const running = runQueuedJobs({
      store: value.store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: false,
      signal: controller.signal,
      executor: async () => ({ sessionId: 'unused', result: 'unused' }),
      notifier,
    })
    await uploadStarted
    controller.abort()
    let runnerSettled = false
    void running.then(() => { runnerSettled = true })
    await Bun.sleep(1_100)
    expect(runnerSettled).toBe(false)
    expect(completions).toBe(0)
    expect(value.store.artifactDeliveryState(value.job.id, value.artifact)).toBe('ambiguous')
    releaseUpload()
    await running
    expect(completions).toBe(1)
    expect(value.store.artifactDeliveryState(value.job.id, value.artifact)).toBe('delivered')
    value.store.close()
  }, 15_000)

  test('shutdownは開始済み非協調uploadのreceiptを1秒後も待ってから戻る', async () => {
    const store = makeStore()
    const artifact = '/tmp/sealed/slow-upload.txt'
    store.enqueue(input({ messageId: 'slow-upload' }))
    const job = store.claimNext('serial-worker')!
    store.complete(
      job.id,
      'thread-slow-upload',
      `done\n<zerokun_files>${JSON.stringify([artifact])}</zerokun_files>`,
    )
    const controller = new AbortController()
    let announceStarted!: () => void
    const started = new Promise<void>(resolve => { announceStarted = resolve })
    let releaseUpload!: () => void
    const uploadFinished = new Promise<void>(resolve => { releaseUpload = resolve })
    let criticalSideEffect: Promise<void> | undefined
    const running = runQueuedJobs({
      store,
      maxJobsPerSession: 5,
      pollMs: 1,
      stopWhenIdle: true,
      signal: controller.signal,
      executor: async () => ({ sessionId: 'unused', result: 'unused' }),
      notifier: {
        completed: async () => {
          expect(store.beginArtifactDelivery(job.id, artifact, 'FSLOW')).toBe('started')
          criticalSideEffect = (async () => {
            announceStarted()
            await uploadFinished
            store.markArtifactDelivered(job.id, artifact)
          })()
          await criticalSideEffect
        },
        settleStartedSideEffects: async () => {
          if (criticalSideEffect) await criticalSideEffect
        },
      },
    })
    await started
    controller.abort()
    let runnerSettled = false
    void running.then(() => { runnerSettled = true })
    await Bun.sleep(1_100)
    expect(runnerSettled).toBe(false)
    expect(store.artifactDelivered(job.id, artifact)).toBe(false)
    releaseUpload()
    await running
    expect(store.artifactDelivered(job.id, artifact)).toBe(true)
    store.close()
  })

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
    expect(store.beginArtifactDelivery(queued.id, artifact, 'FDELIVERED')).toBe('started')
    store.markArtifactDelivered(queued.id, artifact)
    expect(store.artifactDelivered(queued.id, artifact)).toBe(true)
    expect(store.beginArtifactDelivery(queued.id, artifact, 'FIGNORED')).toBe('delivered')
    store.close()
  })

  test('upload開始intent後の突然死は再起動しても自動再送せずambiguousに固定する', () => {
    const dir = fixtureDir()
    const dbPath = join(dir, 'jobs.sqlite3')
    const artifact = '/tmp/sealed/crash-window.txt'
    let store = new JobStore(dbPath)
    const job = store.enqueue(input({ messageId: 'upload-crash-window' })).job
    const running = store.claimNext('serial-worker')!
    store.complete(
      running.id,
      'thread-upload-crash',
      `done\n<zerokun_files>${JSON.stringify([artifact])}</zerokun_files>`,
    )
    expect(store.beginArtifactDelivery(job.id, artifact, 'FCRASH')).toBe('started')
    store.close()

    store = new JobStore(dbPath)
    expect(store.artifactDelivered(job.id, artifact)).toBe(false)
    expect(store.beginArtifactDelivery(job.id, artifact, 'FOTHER')).toBe('ambiguous')
    expect(store.beginArtifactDelivery(job.id, artifact, 'FOTHER')).toBe('ambiguous')
    store.close()
  })

  test('byte送信前のupload target失敗は5回を超えてもreadyのまま再試行する', async () => {
    const value = productionArtifactFixture('artifact-target-many-retries')
    const { store, job, artifact } = value
    let targetRequests = 0
    let byteUploads = 0
    const notifier = new SlackNotifier('xoxb-fixture', () => {}, store, {
      requestUploadTarget: async () => {
        targetRequests += 1
        if (targetRequests <= 6) throw new Error('getUploadURLExternal unavailable')
        return { uploadUrl: 'https://files.slack.com/upload/v1/test', fileId: 'FRETRY' }
      },
      uploadBytes: async (_url, _data, beforeRequestWrite) => {
        beforeRequestWrite()
        byteUploads += 1
      },
      completeUpload: async () => {},
    })
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await flushTerminalNotifications(store, notifier, () => {}, 1)
      await Bun.sleep(2 ** (attempt + 1) + 2)
    }
    expect(targetRequests).toBe(6)
    expect(byteUploads).toBe(0)
    expect(store.artifactDeliveryState(job.id, artifact)).toBe('ready')
    expect(store.terminalNotificationCount()).toBe(1)
    await flushTerminalNotifications(store, notifier, () => {}, 1)
    expect(targetRequests).toBe(7)
    expect(byteUploads).toBe(1)
    expect(store.terminalNotificationCount()).toBe(0)
    expect(store.artifactDelivered(job.id, artifact)).toBe(true)
    store.close()
  })

  test('byte開始後の曖昧性だけをartifact単位で5回確認して打ち切る', async () => {
    const store = makeStore()
    const job = store.enqueue(input({ messageId: 'ambiguous-budget' })).job
    const running = store.claimNext('serial-worker')!
    const artifact = '/tmp/sealed/ambiguous.txt'
    store.complete(
      running.id,
      'thread-ambiguous-budget',
      `done\n<zerokun_files>${JSON.stringify([artifact])}</zerokun_files>`,
    )
    const notification = store.pendingTerminalNotifications()[0]!
    store.markTerminalNotificationBodyDelivered(notification.id)
    expect(store.beginArtifactDelivery(job.id, artifact, 'FAMBIGUOUS')).toBe('started')
    let abandonmentNotices = 0
    const notifier = {
      completed: async () => {
        throw new ArtifactDeliveryAmbiguousError([artifact])
      },
      artifactsAbandoned: async () => { abandonmentNotices += 1 },
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await flushTerminalNotifications(store, notifier, () => {}, 1)
      await Bun.sleep(2 ** (attempt + 1) + 2)
    }
    expect(abandonmentNotices).toBe(1)
    expect(store.artifactDeliveryState(job.id, artifact)).toBe('abandoned')
    expect(store.terminalNotificationCount()).toBe(0)
    store.close()
  })
})
