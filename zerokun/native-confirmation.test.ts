import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore } from './job-runner.ts'
import { browserUploadConfirmation, computerUseAppApproval } from './native-confirmation.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

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

test('only the native browser empty upload form is recognized with a sanitized origin', () => {
  expect(browserUploadConfirmation(params())).toEqual({ threadId: 'thread-one', turnId: 'turn-one', origin: 'https://example.test' })
  for (const patch of [{ mode: 'url' }, { serverName: 'other' }, { requestedSchema: { type: 'object', properties: { password: {} } } },
    { _meta: { ...params()._meta, tool_name: 'other' } }, { _meta: { ...params()._meta, codex_approval_kind: 'auto-review' } }]) {
    expect(browserUploadConfirmation({ ...params(), ...patch })).toBeNull()
  }
  for (const origin of ['https://user:pass@example.test', 'https://example.test/?token=secret', 'file:///tmp/file', 'https://example.test/path', 'not a URL']) {
    expect(browserUploadConfirmation({ ...params(), _meta: { ...params()._meta, tool_params: { origin } } })).toBeNull()
  }
})


function legacyFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-retired-upload-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'jobs.sqlite3')
  const store = new JobStore(path)
  cleanups.push(() => store.close())
  const db = new Database(path)
  cleanups.push(() => db.close())
  const job = store.enqueue({ chatId: 'C0123456789', threadTs: '1800000000.000100', messageId: '1800000000.000100',
    userId: 'U0123456789', repoPath: root, task: '合成ファイルを送ってください', writeEnabled: true }).job
  store.claimNext('worker')
  // Exact pre-upgrade schema: no new runtime path creates or awaits these rows.
  db.exec(`CREATE TABLE native_confirmations (
    code TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, epoch INTEGER NOT NULL,
    executor_nonce TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    request_id TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE, origin TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', decision TEXT, answer_message_id TEXT,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`)
  for (const [code, status, decision] of [['undelivered', 'pending', null], ['delivered', 'pending', null],
    ['answered', 'consumed', 'decline'], ['closed', 'closed', null]]) {
    db.run(`INSERT INTO native_confirmations VALUES (?, ?, 0, 'old-executor', 'old-thread', 'old-turn', '0', ?,
      'https://example.test', ?, ?, NULL, ?, ?)`, [code!, job.id, code!, status!, decision ?? null, Date.now() + 30_000, Date.now()])
    db.run(`INSERT INTO commentary_notifications (id,source_key,job_id,attempt,payload,created_at,delivered_at)
      VALUES (?,?,?,1,'old question',1,?)`, [code!, code!, job.id, code === 'delivered' ? 2 : null])
  }
  db.run(`INSERT INTO commentary_notifications (id,source_key,job_id,attempt,payload,created_at)
    VALUES ('ordinary','ordinary',?,1,'ordinary progress',1)`, [job.id])
  for (const [id, key, delivered] of [['old-answer', 'native-confirmation-answer:old', null],
    ['sent-answer', 'native-confirmation-answer:sent', 2], ['ordinary-status', 'other', null]]) {
    db.run(`INSERT INTO status_notifications (id,idempotency_key,job_id,chat_id,thread_ts,kind,payload,created_at,delivered_at)
      VALUES (?,?,NULL,'C0123456789','1800000000.000100','closed-control','old answer',1,?)`, [id!, key!, delivered ?? null])
  }
  return { store, db, path, job }
}

test('opening a new gateway does not modify a legacy runner wait; exclusive recovery retires it without consent', () => {
  const f = legacyFixture()
  const gateway = new JobStore(f.path)
  gateway.close()
  expect(f.db.query("SELECT count(*) AS n FROM native_confirmations WHERE status='pending'").get()).toEqual({ n: 2 })
  const recovered = f.store.recoverInterrupted()
  expect(recovered.failedWrites).toBe(1)
  expect(f.db.query("SELECT count(*) AS n FROM native_confirmations WHERE status='pending'").get()).toEqual({ n: 0 })
  expect(f.db.query("SELECT decision, answer_message_id FROM native_confirmations WHERE code='undelivered'").get())
    .toEqual({ decision: null, answer_message_id: null })
  expect(f.db.query("SELECT status,decision FROM native_confirmations WHERE code='answered'").get())
    .toEqual({ status: 'consumed', decision: 'decline' })
  expect(f.db.query("SELECT delivered_at,suppressed_at FROM commentary_notifications WHERE id='delivered'").get())
    .toEqual({ delivered_at: 2, suppressed_at: null })
  expect(f.db.query("SELECT count(*) AS n FROM commentary_notifications WHERE source_key!='ordinary' AND delivered_at IS NULL AND suppressed_at IS NULL").get()).toEqual({ n: 0 })
  expect(f.db.query("SELECT suppressed_at FROM commentary_notifications WHERE id='ordinary'").get()).toEqual({ suppressed_at: null })
  expect(f.db.query("SELECT superseded_at FROM status_notifications WHERE id='old-answer'").get()).not.toEqual({ superseded_at: null })
  for (const id of ['sent-answer', 'ordinary-status']) {
    expect(f.db.query('SELECT superseded_at FROM status_notifications WHERE id=?').get(id)).toEqual({ superseded_at: null })
  }
  const snapshot = f.db.query('SELECT * FROM native_confirmations ORDER BY code').all()
  f.store.recoverInterrupted()
  expect(f.db.query('SELECT * FROM native_confirmations ORDER BY code').all()).toEqual(snapshot)
})

test('fresh stores never create an upload reply gate', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-no-upload-gate-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'jobs.sqlite3'), store = new JobStore(path)
  cleanups.push(() => store.close())
  expect(() => store.recoverInterrupted()).not.toThrow()
  const db = new Database(path)
  try { expect(db.query("SELECT 1 FROM sqlite_master WHERE name='native_confirmations'").get()).toBeNull() }
  finally { db.close() }
})

test.each(['添付先はこのスレッドでお願いします', '今回だけ許可', '続けて'])(
  'ordinary reply remains durable task input even with an old pending upload: %s', text => {
    const f = legacyFixture()
    const input = { chatId: f.job.chatId, threadTs: f.job.threadTs, userId: f.job.userId,
      messageId: '1800000000.000200', repoPath: f.job.repoPath, writeEnabled: true, text }
    expect(f.store.stageInboundDelivery(input)).toBe(true)
    const inbound = f.store.claimNextInboundDelivery()!
    expect(inbound.text).toBe(text)
    const target = f.store.liveControlTarget(f.job.chatId, f.job.threadTs)!
    expect(f.store.stageLiveControl(target, { ...input, task: text, kind: 'steer' })).toBe('staged')
    f.store.completeInboundDelivery(inbound.idempotencyKey)
    expect(f.store.listJobControls(f.job.id)[0]).toMatchObject({ task: text, kind: 'steer', status: 'ready' })
    expect(f.db.query("SELECT decision FROM native_confirmations WHERE code='undelivered'").get()).toEqual({ decision: null })
  },
)
