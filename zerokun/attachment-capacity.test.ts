import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore } from './job-runner.ts'
import { loadCachedInboundAttachment, verifyInboundDownloadBeforeRename } from './inbound-attachment-cache.ts'
import { copyLiveControlAttachments } from './live-control.ts'
import { prepareClaudeAdvisorInput } from './claude-advisor-input.ts'
import { createAdvisorInputSnapshot } from './advisor-input.ts'
import { assertSlackThreadAttachmentBudget } from './slack-thread-context.ts'
import { slackAttachmentTimeoutMs, slackHttpTimeoutMs, withSlackDeadline } from './slack-http.ts'

test('existing 50MiB database migrates atomically with bindings, uniqueness and index preserved', () => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'attachment-migration-')))
  const path = join(state, 'jobs.sqlite3')
  try {
    new JobStore(path).close()
    let db = new Database(path)
    const schema = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='slack_thread_attachments'").get()!.sql
    db.exec('DROP TABLE slack_thread_attachments')
    db.exec(schema.replace('524288000', '52428800'))
    db.exec('CREATE INDEX idx_slack_thread_attachments_scope ON slack_thread_attachments(chat_id,thread_ts,repo_path,source_message_id,ordinal)')
    const insert = "INSERT INTO slack_thread_attachments VALUES ('C','1.0','/project','1.0',?,0,?,?,'digest',1)"
    db.run(insert, ['FOLD', '/old', 123]); db.close()
    new JobStore(path).close(); new JobStore(path).close()
    db = new Database(path)
    try {
      expect(db.query('SELECT size FROM slack_thread_attachments').get()).toEqual({ size: 123 })
      db.run(insert, ['FLARGE', '/large', 500 * 1024 * 1024])
      expect(() => db.run(insert, ['FOVER', '/over', 500 * 1024 * 1024 + 1])).toThrow()
      expect(() => db.run(insert, ['FOTHER', '/old', 1])).toThrow()
      expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_slack_thread_attachments_scope'").get()).not.toBeNull()
      expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally { db.close() }
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('500MiB input survives cache, durable restart, thread history, live reply and streamed advisor copy; +1 is refused', () => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'attachment-capacity-')))
  const messageId = '1900000000.000001', fileId = 'FLARGE500'
  const inbox = join(state, 'inbox'), message = join(inbox, messageId)
  mkdirSync(message, { recursive: true, mode: 0o700 })
  const source = join(message, `${fileId}.mp4`), size = 500 * 1024 * 1024
  const fd = openSync(source, 'wx+', 0o600)
  let store: JobStore | undefined
  try {
    // Sparse on disk, but all 500MiB are read and hashed by the production cache/copy code.
    ftruncateSync(fd, size)
    const response = { statusCode: 200, headers: { 'content-length': String(size) }, complete: true, aborted: false }
    expect(verifyInboundDownloadBeforeRename(fd, size, size, response).size).toBe(size)
    expect(verifyInboundDownloadBeforeRename(fd, size, size, { ...response, headers: { 'transfer-encoding': 'chunked' } }).size).toBe(size)
    const cached = loadCachedInboundAttachment({ inboxDir: inbox, messageTs: messageId, fileId, ordinal: 0 })!
    expect(cached.size).toBe(size)
    assertSlackThreadAttachmentBudget(size)
    assertSlackThreadAttachmentBudget(1024 * 1024 * 1024)
    expect(() => assertSlackThreadAttachmentBudget(1024 * 1024 * 1024 + 1)).toThrow('1GB')
    store = new JobStore(join(state, 'jobs.sqlite3'))
    const input = { chatId: 'C1', threadTs: messageId, messageId, userId: 'U1', repoPath: state, writeEnabled: false }
    store.stageInboundDeliveryAndAdoptSlackThread({ ...input, text: 'inspect video', fileIds: [fileId] }, { initialContextEligible: false, appId: 'A1' })
    const inbound = store.claimNextInboundDelivery()!
    store.recordInboundDownloadedFile(inbound.idempotencyKey, cached)
    expect(() => store!.recordInboundDownloadedFile(inbound.idempotencyKey, { ...cached, size: size + 1 })).toThrow('size')
    store.releaseInboundDelivery(inbound.idempotencyKey)
    store.close(); store = new JobStore(join(state, 'jobs.sqlite3'))
    expect(store.claimNextInboundDelivery()!.downloadedFiles[0]!.size).toBe(size)
    const job = store.enqueue({ ...input, task: 'inspect video', attachments: [source] }).job
    store.completeInboundDelivery(inbound.idempotencyKey)
    store.close(); store = new JobStore(join(state, 'jobs.sqlite3'))
    expect(store.get(job.id)!.threadAttachments![0]!.size).toBe(size)
    const copied = copyLiveControlAttachments({ stateDir: state, jobId: job.id, messageId, attachments: [source] })[0]!
    expect(statSync(copied).size).toBe(size)
    const request = join(state, 'advisor'); mkdirSync(request, { mode: 0o700 })
    const snapshot = createAdvisorInputSnapshot({ id: job.id, message_id: messageId, user_id: 'U1', task: 'inspect video', input_revision: 1, attachments_json: JSON.stringify([source]) }, [])
    const prepared = prepareClaudeAdvisorInput(state, request, snapshot)
    const advisorCopy = prepared.input.entries[0]!.attachments[0]!
    expect(advisorCopy).toContain(cached.digest)
    expect(statSync(advisorCopy).size).toBe(size)
    expect(statSync(advisorCopy).mode & 0o777).toBe(0o600)
    expect(statSync(advisorCopy).nlink).toBe(1)
    ftruncateSync(fd, size + 1)
    expect(() => verifyInboundDownloadBeforeRename(fd, size + 1, undefined, { ...response, headers: { 'transfer-encoding': 'chunked' } })).toThrow()
    expect(() => verifyInboundDownloadBeforeRename(fd, size, size + 1, response)).toThrow()
    expect(() => loadCachedInboundAttachment({ inboxDir: inbox, messageTs: messageId, fileId, ordinal: 0 })).toThrow()
    expect(() => copyLiveControlAttachments({ stateDir: state, jobId: job.id, messageId: '1900000000.000002', attachments: [source] })).toThrow()
    expect(() => prepareClaudeAdvisorInput(state, request, snapshot)).toThrow()
  } finally { store?.close(); closeSync(fd); rmSync(state, { recursive: true, force: true }) }
}, 60_000)

test('attachment deadline is finite and separate from APIs; timeout and parent cancellation still abort', async () => {
  expect(slackAttachmentTimeoutMs('')).toBe(600_000)
  expect(slackHttpTimeoutMs('')).toBe(120_000)
  expect(slackAttachmentTimeoutMs('250')).toBe(250)
  let aborted = false
  const operation = (signal: AbortSignal) => new Promise<never>(() => signal.addEventListener('abort', () => { aborted = true }))
  await expect(withSlackDeadline(operation, 10, 'download')).rejects.toThrow('timed out')
  expect(aborted).toBe(true)
  aborted = false
  const parent = new AbortController()
  const pending = withSlackDeadline(operation, slackAttachmentTimeoutMs(''), 'download', parent.signal)
  parent.abort()
  await expect(pending).rejects.toThrow('aborted')
  expect(aborted).toBe(true)
})
