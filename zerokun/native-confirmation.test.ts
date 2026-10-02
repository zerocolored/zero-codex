import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { JobStore, SlackNotifier, sanitizeExecutionTextForSlack } from './job-runner.ts'
import { awaitNativeConfirmation, browserUploadConfirmation, parseNativeConfirmationAnswer } from './native-confirmation.ts'

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

test('ordinary replies, quotes and missing confirmation codes never approve', () => {
  for (const text of ['続けて', '許可', '今回だけ許可', '> 今回だけ許可 abcdef123456', '今回だけ許可 abcdef123456\n続けて', '今回だけ許可 old']) {
    expect(parseNativeConfirmationAnswer(text)).toBeNull()
  }
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
      const code = /今回だけ許可 ([a-f0-9]{12})/.exec(message.payload)![1]!
      expect(f.store.nativeConfirmations.answer({ ...f.answer, code, decision })).toBe(true)
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
  'a hidden destination %s never produces an actionable confirmation', async origin => {
    const f = fixture()
    let published = false
    expect(await awaitNativeConfirmation({ store: f.store.nativeConfirmations,
      binding: { ...f.binding, origin }, signal: new AbortController().signal,
      prepareText: f.prepareText, publish: () => { published = true; return true },
    })).toBe('cancel')
    expect(published).toBe(false)
    expect(f.store.pendingCommentaryNotifications()).toHaveLength(0)
    expect(f.db.query('SELECT status FROM native_confirmations').get()).toEqual({ status: 'closed' })
  },
)

test('the public destination and code survive the real notifier formatting and second redaction', async () => {
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
  const code = /今回だけ許可 ([a-f0-9]{12})/.exec(payload)![1]!
  expect(sent[0]).toContain(`今回だけ許可 ${code}`)
  expect(sent[0]).toContain(`キャンセル ${code}`)
})
