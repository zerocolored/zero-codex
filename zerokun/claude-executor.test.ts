import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore } from './job-runner.ts'
import { executeClaudeJob } from './claude-executor.ts'
import { prepareClaudeJobContext } from './claude-job-context.ts'
import { atomicWritePrivateFile } from './safe-file.ts'
import { createPrimaryLiveControlHooks } from './primary-live-controls.ts'
import type { ClaudeHerdrTransport } from './claude-herdr-transport.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })


function fixture(mode: 'complete' | 'continue' | 'steer' | 'question' | 'question-update' | 'cancel' | 'lost-ack' | 'failed' | 'late-inbound' | 'quota' | 'capacity' | 'proposal' | 'proposal-withdrawn' | 'proposal-changed' | 'proposal-revision') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-claude-executor-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'), state = join(root, 'state'), logs = join(state, 'job-logs')
  mkdirSync(repo); mkdirSync(state, { mode: 0o700 }); mkdirSync(logs, { mode: 0o700 })
  expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0)
  const store = new JobStore(join(state, 'jobs.sqlite3')); cleanups.push(() => store.close())
  store.enqueue({ core: 'claude-code', repoPath: repo, chatId: 'CTEST', threadTs: '1800000000.000100',
    messageId: '1800000000.000100', userId: 'UTEST', task: '最初の依頼', writeEnabled: false })
  const job = store.claimNext('worker')!
  const hooks = createPrimaryLiveControlHooks(store, job)
  let context: ReturnType<typeof prepareClaudeJobContext>, turns = 0, opens = 0, closes = 0, interrupts = 0
  const messages: string[] = [], readOnly: boolean[] = []
  const finish = hooks.finishTurn
  let proposalSteered = false
  hooks.finishTurn = input => {
    const result = finish(input)
    if (mode === 'proposal-revision' && !proposalSteered) {
      proposalSteered = true
      const target = store.liveControlTarget(job.chatId, job.threadTs)!
      store.stageLiveControl(target, { kind: 'steer', chatId: job.chatId, threadTs: job.threadTs,
        messageId: '1800000000.000300', userId: 'UTEST', task: '以前の提案を使わないでください' })
    }
    return result
  }
  const ack = hooks.acknowledgeInitialDispatch
  hooks.acknowledgeInitialDispatch = input => {
    ack(input)
    if (!['steer', 'question', 'question-update', 'cancel'].includes(mode)) return
    const target = store.liveControlTarget(job.chatId, job.threadTs)!
    const next = { chatId: job.chatId, threadTs: job.threadTs, messageId: '1800000000.000200', userId: 'UOTHER', task: '追加の入力' }
    if (mode.startsWith('question')) store.stageLiveInterjection(target, next)
    else store.stageLiveControl(target, { ...next, kind: mode === 'cancel' ? 'interrupt' : 'steer' })
  }
  // Delivery is independently acknowledged by the outbox in production.
  // Use that exact store path in the fixture, too.
  const timer = setInterval(() => {
    for (const notification of store.pendingInterjectionNotifications()) {
      store.markInterjectionNotificationDelivered(notification.id)
    }
  }, 10)
  cleanups.push(() => clearInterval(timer))
  let sealCalls = 0
  const seal = hooks.sealPhaseResult!
  hooks.sealPhaseResult = input => {
    sealCalls += 1
    if (mode === 'late-inbound' && sealCalls === 1) return 'pending-inbound'
    return seal(input)
  }
  const run = () => executeClaudeJob(job, { stateDir: state, logDir: logs, liveControls: hooks,
    onSessionId: id => store.saveSession(job.id, id), cancellationTerminalGraceMs: 500 }, {
    executable: () => '/fixture/claude', settlement: async () => 'settled',
    context: (job, state) => context = prepareClaudeJobContext(job, state),
    transport: async options => {
      opens += 1
      const id = options.arguments.at(-1)!, readonly = options.arguments.some(value => value.endsWith('/readonly-mcp.json'))
      readOnly.push(readonly)
      let output!: ReadableStreamDefaultController<Uint8Array>, closed = false
      const emit = (event: object) => { if (!closed) output.enqueue(Buffer.from(JSON.stringify(event) + '\n')) }
      const terminal = (kind: 'success' | 'cancelled' | 'failed', text = '完了しました') => emit({ type: 'result',
        session_id: id, subtype: kind === 'failed' ? 'error_during_execution' : 'success', is_error: kind === 'failed',
        ...(kind === 'cancelled' ? { terminal_reason: 'aborted_streaming' } : {}), result: text })
      return {
        output: new ReadableStream({ start(controller) { output = controller } }),
        input: { async write(text: string) {
          const event = JSON.parse(text)
          if (event.type === 'control_request') {
            emit({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: {} } })
            if (event.request.subtype === 'interrupt') { interrupts += 1; terminal('cancelled') }
          } else if (event.type === 'user') {
            turns += 1; messages.push(event.message.content)
            emit({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: id })
            if (mode === 'lost-ack') { closed = true; output.close(); return }
            emit(event)
            if (mode === 'quota' || mode === 'capacity') {
              emit({ type: 'result', session_id: id, subtype: 'success', is_error: true,
                api_error_status: mode === 'quota' ? 429 : 529, result: 'synthetic limit' })
              return
            }
            if (turns === 1 && ['steer', 'question', 'question-update', 'cancel'].includes(mode)) return
            if (mode.startsWith('proposal')) {
              const attachment = join(context.artifactDir, 'proposal.png')
              if (turns === 1) writeFileSync(attachment, 'synthetic proposal')
              else if (mode === 'proposal-changed') writeFileSync(attachment, 'changed after proposal')
              atomicWritePrivateFile(context.toolsContext.goalPath, JSON.stringify({ objective: 'fixture', status: turns === 1 ? 'active' : 'blocked' }))
              terminal('success', turns === 1 ? `この比較案で実装してよいですか？\n<zerokun_files>${JSON.stringify([attachment])}</zerokun_files>`
                : mode === 'proposal-withdrawn' ? '添付を撤回します<zerokun_files>[]</zerokun_files>' : '承認待ちです')
              return
            }
            if (readonly) {
              const questionId = /Interjection ID: (\S+)/.exec(event.message.content)?.[1]
              terminal('success', JSON.stringify({ interjectionId: questionId,
                disposition: mode === 'question-update' ? 'task-update' : 'answer-only', answer: '回答です' }))
            } else {
              atomicWritePrivateFile(context.toolsContext.goalPath, JSON.stringify({ objective: 'fixture',
                status: mode === 'continue' && turns === 1 ? 'active' : 'complete' }))
              terminal(mode === 'failed' ? 'failed' : 'success')
            }
          }
        }, async end() {} },
        async close() { if (!closed) { closed = true; output.close() }; closes += 1 },
        identity: {} as any, pane: {} as any, exited: Promise.resolve(0),
      } satisfies ClaudeHerdrTransport
    },
  })
  return { store, state, job, run, messages, readOnly, counts: () => ({ turns, opens, closes, interrupts, sealCalls }) }
}

test('physical retry reuses the logical advisor ledger and model while renewing tool processes', () => {
  const f = fixture('complete'), first = prepareClaudeJobContext(f.job, f.state)
  first.pinModel('claude-opus-5-5')
  first.retire()
  const resumed = prepareClaudeJobContext({ ...f.job, attempts: f.job.attempts + 1 }, f.state)
  try {
    expect(resumed.attemptNonce).toBe(first.attemptNonce)
    expect(resumed.processNonce).not.toBe(first.processNonce)
    expect(resumed.contextPath).toBe(first.contextPath)
    expect(resumed.pinnedModel).toBe('claude-opus-5-5')
    expect(() => resumed.pinModel('claude-opus-different')).toThrow('changed')
  } finally { resumed.retire() }
})

test('Claude completion is sealed in the real job ledger only after process cleanup', async () => {
  const f = fixture('complete'), result = await f.run()
  expect(result.result).toBe('完了しました')
  expect(f.store.hasStagedExecution(f.job.id)).toBe(true)
  expect(f.store.get(f.job.id)!.acceptsControl).toBe(false)
  expect(f.counts()).toMatchObject({ turns: 1, opens: 1, closes: 1, sealCalls: 1 })
})
test('an active goal continues within the same Claude process and logical task', async () => {
  const f = fixture('continue'); await f.run()
  expect(f.counts()).toMatchObject({ turns: 2, opens: 1, closes: 1 })
  expect(f.messages[1]).toContain('Continue this same task')
})
test('steer interrupts the old turn and delivers the added task once after its terminal', async () => {
  const f = fixture('steer'); await f.run()
  expect(f.counts()).toMatchObject({ turns: 2, interrupts: 1, opens: 2, closes: 2 })
  expect(f.messages[1]).toContain('追加の入力')
  expect(f.store.listJobControls(f.job.id)[0]?.status).toBe('observed')
})
for (const mode of ['question', 'question-update'] as const) test(`${mode}: answer through a read-only process then resume the same session`, async () => {
  const f = fixture(mode); await f.run()
  expect(f.readOnly).toEqual([false, true, false])
  expect(f.counts()).toMatchObject({ turns: 3, opens: 3, closes: 3, interrupts: 1 })
  expect(f.store.hasStagedExecution(f.job.id)).toBe(true)
})
test('cancellation produces no staged completion and always closes its Claude process', async () => {
  const f = fixture('cancel'); await expect(f.run()).rejects.toThrow()
  expect(f.store.hasStagedExecution(f.job.id)).toBe(false)
  expect(f.counts().closes).toBe(1)
})
test('lost user ACK is ambiguous, never resent or published', async () => {
  const f = fixture('lost-ack'); await expect(f.run()).rejects.toThrow('acknowledgement')
  expect(f.store.hasStagedExecution(f.job.id)).toBe(false)
  expect(f.store.get(f.job.id)!.sessionId).toBeNull()
  expect(f.counts()).toMatchObject({ turns: 1, opens: 1, closes: 1 })
})
test('failed result is not completion even when goal file claims complete', async () => {
  const f = fixture('failed'); await expect(f.run()).rejects.toThrow('unsuccessful')
  expect(f.store.hasStagedExecution(f.job.id)).toBe(false)
})
test('late inbound seal waits without replaying already completed work', async () => {
  const f = fixture('late-inbound'); await f.run()
  expect(f.counts()).toMatchObject({ turns: 1, opens: 1, closes: 1, sealCalls: 2 })
})
for (const mode of ['quota', 'capacity'] as const) test(`${mode}: native failure records a durable continuation, never completion or immediate replay`, async () => {
  const f = fixture(mode)
  await expect(f.run()).rejects.toMatchObject({ name: 'CodexRateLimitError', reason: mode === 'quota' ? 'rate-limit' : 'capacity' })
  expect(f.store.hasDurableRateLimitTerminal(f.job.id)).toBe(true)
  expect(f.store.hasStagedExecution(f.job.id)).toBe(false)
  expect(f.counts()).toMatchObject({ turns: 1, opens: 1, closes: 1 })
})

for (const mode of ['proposal', 'proposal-withdrawn', 'proposal-changed', 'proposal-revision'] as const) test(
  `${mode}: blocked continuation retains only the still-current proposal and attachments`, async () => {
    const f = fixture(mode), result = await f.run()
    expect(result.taskGoalStatus).toBe('blocked')
    if (mode === 'proposal') expect(result.result).toContain('この比較案で実装してよいですか？\n<zerokun_files>')
    else expect(result.result).toBe(mode === 'proposal-withdrawn' ? '添付を撤回します<zerokun_files>[]</zerokun_files>' : '承認待ちです')
    expect(f.counts().turns).toBe(2)
  })
