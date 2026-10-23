import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { JobStore, SlackNotifier, sanitizeExecutionTextForSlack } from './job-runner.ts'
import { awaitNativeConfirmation, browserUploadConfirmation, computerUseAppApproval, parseNativeConfirmationAnswer } from './native-confirmation.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-confirmation-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new JobStore(join(root, 'jobs.sqlite3'))
  cleanups.push(() => store.close())
  store.enqueue({ chatId: 'C0123456789', threadTs: '1800000000.000100', messageId: '1800000000.000100',
    userId: 'U0123456789', repoPath: root, task: '合成ファイルを送ってください', writeEnabled: true })
  const job = store.claimNext('worker')!
  store.bindAppServerTurn(job.id, job.workerId!, job.controlEpoch, 'executor-one', 'thread-one', 'turn-one')
  const binding = { jobId: job.id, epoch: job.controlEpoch, executorNonce: 'executor-one',
    threadId: 'thread-one', turnId: 'turn-one', requestId: 0, origin: 'https://example.com' }
  const answer = { chatId: job.chatId, threadTs: job.threadTs, userId: job.userId,
    messageId: '1800000000.000101', writeEnabled: true, decision: 'accept' as const }
  const prepareText = (text: string) => sanitizeExecutionTextForSlack(job, '', text, dirname(store.dbPath), [], 'progress')
  const publish = (event: { sourceKey: string; text: string }) => {
    const text = prepareText(event.text)
    return store.stageCommentaryNotification(job.id, job.attempts, event.sourceKey, `💬 ${text}`) === 'staged'
  }
  const deliver = () => {
    const notification = store.pendingCommentaryNotifications()[0]!
    expect(notification).toBeDefined()
    store.markCommentaryNotificationDelivered(notification.id)
    return notification
  }
  const db = new Database(store.dbPath)
  cleanups.push(() => db.close())
  return { store, job, binding, answer, prepareText, publish, deliver, db }
}

const params = () => ({ threadId: 'thread-one', turnId: 'turn-one', serverName: 'node_repl', mode: 'form',
  requestedSchema: { type: 'object', properties: {} },
  message: 'untrusted message must never be copied',
  _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'browser-use',
    tool_name: 'upload_browser_files', file_transfer: 'upload', tool_params: { origin: 'https://example.test' } } })

// Sanitized from PAGIT job 72, Codex 0.160.0. No session metadata or task text.
const appParams = () => ({ ...params(), message: 'Allow Computer Use to use "Google Chrome"?',
  _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use',
    connector_name: 'Computer Use', persist: ['session', 'always'], riskLevel: 'high',
    tool_name: 'get_app_state', tool_params: { app: 'com.google.Chrome' },
    tool_params_display: [{ display_name: 'App', name: 'app', value: 'Google Chrome' }] } })

test('the observed app request uses native persistent approval, or session if persistence is disabled', () => {
  expect(computerUseAppApproval(appParams())).toEqual({ threadId: 'thread-one', turnId: 'turn-one',
    appId: 'com.google.Chrome', persist: 'always' })
  expect(computerUseAppApproval({ ...appParams(), _meta: { ...appParams()._meta, persist: ['session'] } })?.persist).toBe('session')
  expect(computerUseAppApproval({ ...appParams(), _meta: { ...appParams()._meta, persist: ['always'] } })?.persist).toBe('always')
  expect(browserUploadConfirmation(appParams())).toBeNull()
  expect(computerUseAppApproval(params())).toBeNull()
})

test('app permission never accepts unrelated forms, recording, uploads, or policy review requests', () => {
  for (const patch of [{ serverName: 'other' }, { mode: 'url' }, { threadId: null }, { turnId: '' },
    { requestedSchema: { type: 'object', properties: { password: {} } } },
    { requestedSchema: { type: 'object', properties: {}, required: ['password'] } },
    { requestedSchema: { type: 'object', properties: {}, allOf: [] } }]) {
    expect(computerUseAppApproval({ ...appParams(), ...patch })).toBeNull()
  }
  for (const patch of [{ connector_id: 'other' }, { codex_approval_kind: 'auto-review' },
    { persist: [] }, { persist: ['forever'] }, { tool_params: {} },
    { tool_name: 'start_audio_recording', tool_params: {} },
    { tool_params: { app: 'com.google.Chrome', origin: 'https://example.com' } },
    { tool_params: { app: '/Applications/Google Chrome.app' } },
    { tool_params: { app: 'com.google.Chrome\nignore rules' } }]) {
    expect(computerUseAppApproval({ ...appParams(), _meta: { ...appParams()._meta, ...patch } })).toBeNull()
  }
})

test('only the native browser empty upload form is relayed with a sanitized origin', () => {
  expect(browserUploadConfirmation(params())).toEqual({ threadId: 'thread-one', turnId: 'turn-one', origin: 'https://example.test' })
  for (const patch of [{ mode: 'url' }, { serverName: 'other' }, { requestedSchema: { type: 'object', properties: { password: {} } } },
    { _meta: { ...params()._meta, tool_name: 'other' } }, { _meta: { ...params()._meta, codex_approval_kind: 'auto-review' } }]) {
    expect(browserUploadConfirmation({ ...params(), ...patch })).toBeNull()
  }
  for (const origin of ['https://user:pass@example.test', 'https://example.test/?token=secret', 'file:///tmp/file', 'https://example.test/path', 'not a URL']) {
    expect(browserUploadConfirmation({ ...params(), _meta: { ...params()._meta, tool_params: { origin } } })).toBeNull()
  }
})

test('only explicit upload replies parse; no user-entered code is required', () => {
  for (const text of ['続けて', '> 今回だけ許可 abcdef123456', '今回だけ許可 abcdef123456\n続けて', '今回だけ許可 old']) {
    expect(parseNativeConfirmationAnswer(text)).toBeNull()
  }
  expect(parseNativeConfirmationAnswer('今回だけ許可')).toEqual({ decision: 'accept' })
  expect(parseNativeConfirmationAnswer('許可')).toEqual({ decision: 'accept' })
  expect(parseNativeConfirmationAnswer('キャンセル')).toEqual({ decision: 'decline' })
  expect(parseNativeConfirmationAnswer('今回だけ許可  abcdef123456')).toEqual({ code: 'abcdef123456', decision: 'accept' })
  expect(parseNativeConfirmationAnswer('今回だけ許可 abcdef123456')).toEqual({ code: 'abcdef123456', decision: 'accept' })
  expect(parseNativeConfirmationAnswer('キャンセル abcdef123456')).toEqual({ code: 'abcdef123456', decision: 'decline' })
})

test('the requesting user answers once; consumption waits for the delivery receipt', () => {
  const f = fixture(), native = f.store.nativeConfirmations
  const row = native.create(f.binding)!
  f.publish({ sourceKey: row.sourceKey, text: '確認' })
  expect(native.answer({ ...f.answer, code: row.code })).toBe(true)
  expect(native.poll(row)).toBeNull()
  f.deliver()
  expect(native.poll(row)).toBe('accept')
  expect(native.poll(row)).toBe('cancel')
  expect(native.answer({ ...f.answer, code: row.code })).toBe(true) // same event replay
  expect(native.answer({ ...f.answer, code: row.code, messageId: 'another' })).toBe(false)
})

test.each(['userId', 'chatId', 'threadTs', 'writeEnabled'] as const)('rejects an answer with the wrong %s', field => {
  const f = fixture(), row = f.store.nativeConfirmations.create(f.binding)!
  f.publish({ sourceKey: row.sourceKey, text: '確認' }); f.deliver()
  expect(f.store.nativeConfirmations.answer({ ...f.answer, code: row.code,
    [field]: field === 'writeEnabled' ? false : 'different' })).toBe(false)
  expect(f.store.nativeConfirmations.poll(row)).toBeNull()
})

test.each(["control_epoch=control_epoch+1", "executor_nonce='new-process'", "active_turn_id='next-turn'",
  "active_thread_id='other-thread'", "status='failed'", "cancel_requested_at=1", "write_enabled=0"])(
  'stale native binding cannot be answered or consumed after %s', change => {
    const f = fixture(), row = f.store.nativeConfirmations.create(f.binding)!
    f.publish({ sourceKey: row.sourceKey, text: '確認' }); f.deliver()
    expect(f.store.nativeConfirmations.answer({ ...f.answer, code: row.code })).toBe(true)
    f.db.run(`UPDATE jobs SET ${change} WHERE id=?`, [f.job.id])
    expect(f.store.nativeConfirmations.answer({ ...f.answer, code: row.code, messageId: 'new-reply' })).toBe(false)
    expect(f.store.nativeConfirmations.poll(row)).toBe('cancel')
  },
)

test('an abandoned process lease expires and cannot be revived by polling', () => {
  const f = fixture(), now = Date.now(), row = f.store.nativeConfirmations.create(f.binding, now)!
  f.publish({ sourceKey: row.sourceKey, text: '確認' }); f.deliver()
  expect(f.store.nativeConfirmations.answer({ ...f.answer, code: row.code }, now + 30_001)).toBe(false)
  expect(f.store.nativeConfirmations.poll(row, now + 30_001)).toBe('cancel')
})

test.each(['accept', 'decline'] as const)('outbox → exact Slack reply → same pending request returns %s', decision => {
  const f = fixture()
  return expect(awaitNativeConfirmation({ store: f.store.nativeConfirmations, binding: f.binding,
    prepareText: f.prepareText,
    signal: new AbortController().signal, publish: event => {
      expect(event.text).toContain('https://example.com')
      expect(event.text).not.toContain('untrusted')
      f.publish(event)
      const message = f.deliver()
      expect(message.payload).not.toMatch(/今回だけ許可 [a-f0-9]{12}/)
      expect(f.store.answerNativeConfirmation({ ...f.answer, decision })).toBe(true)
      return true
    },
  })).resolves.toBe(decision)
})

test('aborting a native request suppresses its undelivered confirmation', async () => {
  const f = fixture(), controller = new AbortController()
  expect(await awaitNativeConfirmation({ store: f.store.nativeConfirmations, binding: f.binding,
    prepareText: f.prepareText,
    signal: controller.signal, publish: event => { f.publish(event); controller.abort(); return true },
  })).toBe('cancel')
  expect(f.store.pendingCommentaryNotifications()).toHaveLength(0)
  expect(f.db.query("SELECT status FROM native_confirmations").get()).toEqual({ status: 'closed' })
})

test('failed publication cancels without leaving a pending confirmation', async () => {
  const f = fixture()
  expect(await awaitNativeConfirmation({ store: f.store.nativeConfirmations, binding: f.binding,
    prepareText: f.prepareText,
    signal: new AbortController().signal, publish: () => false,
  })).toBe('cancel')
  expect(f.db.query("SELECT status FROM native_confirmations").get()).toEqual({ status: 'closed' })
})

test.each(['http://127.0.0.1', 'http://localhost', 'https://example.test', 'http://device.local', 'http://192.168.0.1'])(
  'the displayed destination %s supports the exact pending confirmation', async origin => {
    const f = fixture()
    expect(await awaitNativeConfirmation({ store: f.store.nativeConfirmations,
      binding: { ...f.binding, origin }, signal: new AbortController().signal,
      prepareText: f.prepareText, publish: event => {
        expect(event.text).toContain(origin)
        f.publish(event)
        const notification = f.deliver()
        expect(notification.payload).toContain('今回だけ許可')
        expect(f.store.nativeConfirmations.answer(f.answer)).toBe(true)
        return true
      },
    })).toBe('accept')
    expect(f.store.pendingCommentaryNotifications()).toHaveLength(0)
    expect(f.db.query('SELECT status FROM native_confirmations').get()).toEqual({ status: 'consumed' })
  },
)

test('missing destination text still cannot solicit an ambiguous approval', async () => {
  const f = fixture()
  let published = false
  expect(await awaitNativeConfirmation({ store: f.store.nativeConfirmations, binding: f.binding,
    signal: new AbortController().signal, prepareText: () => 'destination unavailable',
    publish: () => { published = true; return true },
  })).toBe('cancel')
  expect(published).toBe(false)
})

test('the actual notifier marks upload confirmation as a decision with no code entry', async () => {
  const f = fixture(), controller = new AbortController()
  let payload = ''
  await awaitNativeConfirmation({ store: f.store.nativeConfirmations, binding: f.binding,
    signal: controller.signal, prepareText: f.prepareText,
    publish: event => { payload = event.text; controller.abort(); return true },
  })
  const sent: string[] = []
  const notifier = new SlackNotifier('xoxb-fixture', () => {}, f.store, {
    postMessage: async input => { sent.push(input.text); return { messageId: '1800000000.000200' } },
  })
  await notifier.progress(f.job, `💬 ${payload}`)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain(f.binding.origin)
  expect(sent[0]).toContain('🙋 要判断')
  expect(sent[0]).toContain(`<@${f.job.userId}>`)
  expect(sent[0]).not.toContain('対応不要')
  expect(sent[0]).not.toMatch(/今回だけ許可 [a-f0-9]{12}/)
})


test('code-free approval requires delivery and rejects an older Slack event', () => {
  const f = fixture(), n = f.store.nativeConfirmations, row = n.create(f.binding)!
  f.publish({ sourceKey: row.sourceKey, text: 'お願い: upload' })
  expect(n.answer(f.answer)).toBe(false)
  f.deliver()
  expect(n.answer({ ...f.answer, messageId: '1000000000.000100' })).toBe(false)
  expect(n.answer(f.answer)).toBe(true)
  expect(n.poll(row)).toBe('accept')
})

test('a code-free reply cannot choose between two live requests', () => {
  const f = fixture(), n = f.store.nativeConfirmations
  for (let requestId = 0; requestId < 2; requestId++) {
    const row = n.create({ ...f.binding, requestId })!
    f.publish({ sourceKey: row.sourceKey, text: 'お願い: upload' }); f.deliver()
  }
  expect(n.answer(f.answer)).toBe(false)
})

test('replayed approval cannot approve the next native request', () => {
  const f = fixture(), n = f.store.nativeConfirmations
  const row = n.create(f.binding)!; f.publish({ sourceKey: row.sourceKey, text: 'お願い: upload' }); f.deliver()
  expect(f.store.answerNativeConfirmation(f.answer)).toBe(true)
  expect(n.poll(row)).toBe('accept')
  const next = n.create({ ...f.binding, requestId: 1 })!
  f.publish({ sourceKey: next.sourceKey, text: 'お願い: another upload' }); f.deliver()
  expect(f.store.answerNativeConfirmation(f.answer)).toBe(true)
  expect(n.poll(next)).toBeNull()
  expect(f.store.pendingStatusNotifications()).toHaveLength(1)
})

test('wrong old code gets a durable explanation, then a code-free retry succeeds', () => {
  const f = fixture(), n = f.store.nativeConfirmations, row = n.create(f.binding)!
  f.publish({ sourceKey: row.sourceKey, text: 'お願い: upload' }); f.deliver()
  expect(f.store.answerNativeConfirmation({ ...f.answer, code: 'wrong-code' })).toBe(false)
  expect(n.poll(row)).toBeNull()
  expect(f.store.pendingStatusNotifications()[0]!.payload).toContain('番号の入力は不要')
  expect(f.store.hasDurableEvent(`${f.answer.chatId}:${f.answer.messageId}`)).toBe(true)
  expect(f.store.answerNativeConfirmation({ ...f.answer, messageId: '1800000000.000102' })).toBe(true)
  expect(n.poll(row)).toBe('accept')
  expect(f.store.pendingStatusNotifications()).toHaveLength(2)
})

test('outbox failure rolls back the decision and event tombstone together', () => {
  const f = fixture(), n = f.store.nativeConfirmations, row = n.create(f.binding)!
  f.publish({ sourceKey: row.sourceKey, text: 'お願い: upload' }); f.deliver()
  f.db.exec("CREATE TRIGGER fail_status BEFORE INSERT ON status_notifications BEGIN SELECT RAISE(ABORT, 'fixture outbox failure'); END")
  expect(() => f.store.answerNativeConfirmation(f.answer)).toThrow('fixture outbox failure')
  expect(n.poll(row)).toBeNull()
  expect(f.store.hasDurableEvent(`${f.answer.chatId}:${f.answer.messageId}`)).toBe(false)
  f.db.exec('DROP TRIGGER fail_status')
  expect(f.store.answerNativeConfirmation(f.answer)).toBe(true)
})

test.each(['userId', 'chatId', 'threadTs', 'writeEnabled'] as const)('code-free answer rejects wrong %s', field => {
  const f = fixture(), n = f.store.nativeConfirmations, row = n.create(f.binding)!
  f.publish({ sourceKey: row.sourceKey, text: 'お願い: upload' }); f.deliver()
  expect(n.answer({ ...f.answer, [field]: field === 'writeEnabled' ? false : 'different' })).toBe(false)
  expect(n.poll(row)).toBeNull()
})


test('a delayed reply from before prompt delivery cannot approve the new request', () => {
  const f = fixture(), n = f.store.nativeConfirmations, row = n.create(f.binding)!
  f.publish({ sourceKey: row.sourceKey, text: 'お願い: upload' }); f.deliver()
  // The user replied while the prompt was still in the outbox; Slack delivers
  // that inbound event only after the prompt delivery receipt exists.
  const receiptTime = Number(f.answer.messageId) * 1000 + 1000
  f.db.run('UPDATE commentary_notifications SET delivered_at=? WHERE source_key=?', [receiptTime, row.sourceKey])
  expect(f.store.answerNativeConfirmation(f.answer)).toBeNull()
  expect(f.store.hasDurableEvent(`${f.answer.chatId}:${f.answer.messageId}`)).toBe(false)
  expect(f.store.pendingStatusNotifications()).toHaveLength(0)
  expect(n.poll(row)).toBeNull()
  expect(f.store.answerNativeConfirmation({ ...f.answer, messageId: '1800000002.000100' })).toBe(true)
  expect(n.poll(row)).toBe('accept')
})


test('a crashed request lease cannot permanently intercept normal thread replies', () => {
  const f = fixture(), n = f.store.nativeConfirmations, now = Date.now()
  n.create(f.binding, now)
  expect(n.hasPendingForThread(f.job.chatId, f.job.threadTs, now)).toBe(true)
  expect(n.hasPendingForThread(f.job.chatId, 'another-thread', now)).toBe(false)
  expect(n.hasPendingForThread(f.job.chatId, f.job.threadTs, now + 30_001)).toBe(false)
  f.db.run("UPDATE jobs SET status='completed' WHERE id=?", [f.job.id])
  expect(n.hasPendingForThread(f.job.chatId, f.job.threadTs, now)).toBe(false)
})

test('interrupted upload resumes with one live question and one answer to that exact call', async () => {
  const f = fixture(), n = f.store.nativeConfirmations
  const old = n.create(f.binding)!
  f.publish({ sourceKey: old.sourceKey, text: 'お願い: upload' }); f.deliver()
  n.close(old)
  expect(n.hasPendingForThread(f.job.chatId, f.job.threadTs)).toBe(false)
  expect(f.store.answerNativeConfirmation(f.answer)).toBeNull()

  // Model the supervisor retiring the old native process before completion.
  f.db.run('UPDATE jobs SET executor_nonce=NULL,active_turn_id=NULL WHERE id=?', [f.job.id])
  f.store.complete(f.job.id, 'thread-one', '旧確認は中断しました')
  for (const notice of f.store.pendingTerminalNotifications()) f.store.markTerminalNotificationDelivered(notice.id)
  f.store.enqueue({ chatId: f.job.chatId, threadTs: f.job.threadTs, messageId: '1800000000.000102',
    userId: f.job.userId, repoPath: f.job.repoPath, task: 'つづけて', writeEnabled: true })
  const resumed = f.store.claimNext('worker')!
  f.store.bindAppServerTurn(resumed.id, resumed.workerId!, resumed.controlEpoch,
    'executor-resumed', 'thread-one', 'turn-resumed')
  let questions = 0
  const result = await awaitNativeConfirmation({ store: n, signal: new AbortController().signal,
    binding: { ...f.binding, jobId: resumed.id, epoch: resumed.controlEpoch,
      executorNonce: 'executor-resumed', turnId: 'turn-resumed' },
    prepareText: f.prepareText,
    publish: event => {
      questions++
      f.store.stageCommentaryNotification(resumed.id, resumed.attempts, event.sourceKey, `💬 ${event.text}`)
      f.deliver()
      const reply = { ...f.answer, messageId: '1800000001.000100' }
      expect(f.store.answerNativeConfirmation(reply)).toBe(true)
      expect(f.store.answerNativeConfirmation(reply)).toBe(true)
      return true
    },
  })
  expect(result).toBe('accept')
  expect(questions).toBe(1)
  expect(f.store.pendingStatusNotifications()).toHaveLength(1)
  expect(f.db.query('SELECT status,decision FROM native_confirmations WHERE code=?').get(old.code))
    .toEqual({ status: 'closed', decision: null })
  expect(n.hasPendingForThread(f.job.chatId, f.job.threadTs)).toBe(false)
})


test('an older ordinary reply and an already queued event are not consumed by a new confirmation', () => {
  const f = fixture(), n = f.store.nativeConfirmations, row = n.create(f.binding)!
  f.publish({ sourceKey: row.sourceKey, text: 'お願い: upload' }); f.deliver()
  const old = { ...f.answer, messageId: '1000000000.000100', decision: 'decline' as const }
  expect(f.store.answerNativeConfirmation(old)).toBeNull()
  expect(f.store.hasDurableEvent(`${old.chatId}:${old.messageId}`)).toBe(false)
  const messageId = '1800000001.000100'
  f.store.stageInboundDelivery({ ...f.answer, messageId, repoPath: f.job.repoPath, text: '許可', fileIds: [] })
  expect(f.store.answerNativeConfirmation({ ...f.answer, messageId })).toBeNull()
  expect(f.store.pendingStatusNotifications()).toHaveLength(0)
  expect(n.poll(row)).toBeNull()
})
