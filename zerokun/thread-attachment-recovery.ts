import { withSlackDeadline, slackAttachmentTimeoutMs } from './slack-http.ts'
import type { Database } from 'bun:sqlite'
import { loadCachedInboundAttachment } from './inbound-attachment-cache.ts'
import type { InboundDownloadedFile } from './job-runner.ts'

export type AttachmentScope = { chatId: string; threadTs: string; repoPath: string }
export type PendingThreadAttachment = AttachmentScope & {
  sourceMessageId: string; fileId: string; ordinal: number
}

// These references outlive failed jobs and reply-intent GC. Never save or replay
// the old task text; only accepted, scoped attachment identities are recoverable.
export function initializeAttachmentRecovery(db: Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS pending_thread_attachments (
      chat_id TEXT NOT NULL, thread_ts TEXT NOT NULL, repo_path TEXT NOT NULL,
      source_message_id TEXT NOT NULL, file_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      PRIMARY KEY(chat_id,thread_ts,repo_path,source_message_id,file_id)
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS recovered_inbound_attachments (
      inbound_key TEXT NOT NULL REFERENCES inbound_deliveries(idempotency_key) ON DELETE CASCADE,
      source_message_id TEXT NOT NULL, file_id TEXT NOT NULL,
      PRIMARY KEY(inbound_key,source_message_id,file_id)
    )`)
    if (!db.query<{name:string}, []>('PRAGMA table_info(jobs)').all()
      .some(c => c.name === 'unavailable_thread_attachments_json')) {
      db.exec("ALTER TABLE jobs ADD COLUMN unavailable_thread_attachments_json TEXT NOT NULL DEFAULT '[]'")
    }
    if (db.query("SELECT 1 FROM migration_ledger WHERE name='pending-thread-attachments-v1'").get()) return
    // Legacy preparation failures never started an executor. Ignore unrelated
    // execution failures and unaccepted intents, and enforce every scope key.
    const rows = db.query<{
      chat_id:string; thread_ts:string; repo_path:string; message_id:string; file_ids_json:string
    }, []>(`SELECT j.chat_id,j.thread_ts,j.repo_path,j.message_id,i.file_ids_json
      FROM jobs j JOIN slack_thread_reply_intents i ON i.idempotency_key=j.idempotency_key
        AND i.chat_id=j.chat_id AND i.thread_ts=j.thread_ts AND i.message_id=j.message_id AND i.user_id=j.user_id
      JOIN slack_threads t ON t.chat_id=j.chat_id AND t.thread_ts=j.thread_ts AND t.repo_path=j.repo_path
      WHERE j.status='failed' AND j.started_at IS NULL AND j.session_id IS NULL
        AND i.status='addressed' AND j.last_error LIKE 'Slack入力の準備を%'
    `).all()
    for (const row of rows) preserveReferences(db, row)
    db.run("INSERT INTO migration_ledger(name,completed_at) VALUES('pending-thread-attachments-v1',?)", [Date.now()])
  }).immediate()
}

function preserveReferences(db: Database, row: {
  chat_id:string; thread_ts:string; repo_path:string; message_id:string; file_ids_json:string
}): void {
  if (!/^\d+\.\d+$/.test(row.message_id)) return
  let ids: unknown
  try { ids = JSON.parse(row.file_ids_json) } catch { return }
  if (!Array.isArray(ids)) return
  for (const [ordinal, fileId] of ids.entries()) {
    if (typeof fileId !== 'string' || !/^F[A-Z0-9]+$/.test(fileId)) continue
    db.run(`INSERT OR IGNORE INTO pending_thread_attachments
      SELECT ?,?,?,?,?,? WHERE NOT EXISTS (
        SELECT 1 FROM slack_thread_attachments WHERE chat_id=? AND thread_ts=?
          AND repo_path=? AND source_message_id=? AND file_id=?)`,
    [row.chat_id,row.thread_ts,row.repo_path,row.message_id,fileId,ordinal,
      row.chat_id,row.thread_ts,row.repo_path,row.message_id,fileId])
  }
}

/** Called in the same transaction that removes a failed inbound delivery. */
export function preserveFailedAttachments(db: Database, key: string): void {
  const row = db.query<{
    chat_id:string; thread_ts:string; repo_path:string; message_id:string; file_ids_json:string
  }, [string]>(`SELECT * FROM inbound_deliveries WHERE idempotency_key=?
    AND status='processing' AND is_interrupt=0 AND initial_context_state<>'pending'`).get(key)
  if (row) preserveReferences(db, row)
}

export function pendingThreadAttachments(db: Database, scope: AttachmentScope): PendingThreadAttachment[] {
  return db.query<PendingThreadAttachment, [string,string,string]>(`
    SELECT p.chat_id AS chatId,p.thread_ts AS threadTs,p.repo_path AS repoPath,
      p.source_message_id AS sourceMessageId,p.file_id AS fileId,p.ordinal
    FROM pending_thread_attachments p JOIN slack_threads t
      ON t.chat_id=p.chat_id AND t.thread_ts=p.thread_ts AND t.repo_path=p.repo_path
    WHERE p.chat_id=? AND p.thread_ts=? AND p.repo_path=?
    ORDER BY CAST(p.source_message_id AS REAL),p.ordinal
  `).all(scope.chatId,scope.threadTs,scope.repoPath)
}

export function recordRecoveredAttachment(
  db: Database, inboxDir: string, key: string, source: PendingThreadAttachment, file: InboundDownloadedFile,
): void {
  db.transaction(() => {
    const inbound = db.query<{message_id:string}, [string,string,string,string]>(`
      SELECT message_id FROM inbound_deliveries WHERE idempotency_key=? AND status='processing'
        AND is_interrupt=0 AND chat_id=? AND thread_ts=? AND repo_path=?
    `).get(key,source.chatId,source.threadTs,source.repoPath)
    if (!inbound || Number(source.sourceMessageId) >= Number(inbound.message_id)
      || !pendingThreadAttachments(db, source).some(p => p.sourceMessageId===source.sourceMessageId
        && p.fileId===source.fileId && p.ordinal===source.ordinal)) {
      throw new Error('recovered attachment no longer belongs to the processing input')
    }
    if (file.fileId !== source.fileId || file.ordinal !== source.ordinal) throw new Error('recovered attachment ordinal changed')
    const verified = loadCachedInboundAttachment({ inboxDir, messageTs:source.sourceMessageId,
      fileId:source.fileId,ordinal:source.ordinal,manifest:file })
    if (!verified) throw new Error('recovered attachment cache is unavailable')
    db.run(`INSERT OR IGNORE INTO slack_thread_attachments
      (chat_id,thread_ts,repo_path,source_message_id,file_id,ordinal,path,size,digest,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [source.chatId,source.threadTs,source.repoPath,
      source.sourceMessageId,source.fileId,source.ordinal,file.path,file.size,file.digest,Date.now()])
    const saved=db.query<{path:string;size:number;digest:string;ordinal:number;repo_path:string},[string,string,string,string]>(`
      SELECT path,size,digest,ordinal,repo_path FROM slack_thread_attachments
      WHERE chat_id=? AND thread_ts=? AND source_message_id=? AND file_id=?
    `).get(source.chatId,source.threadTs,source.sourceMessageId,source.fileId)
    if (!saved || saved.repo_path!==source.repoPath || saved.ordinal!==file.ordinal
      || saved.path!==file.path || saved.size!==file.size || saved.digest!==file.digest) {
      throw new Error('recovered attachment identity collision')
    }
    db.run('INSERT OR IGNORE INTO recovered_inbound_attachments VALUES (?,?,?)',
      [key,source.sourceMessageId,source.fileId])
    db.run(`DELETE FROM pending_thread_attachments WHERE chat_id=? AND thread_ts=?
      AND repo_path=? AND source_message_id=? AND file_id=?`,
    [source.chatId,source.threadTs,source.repoPath,source.sourceMessageId,source.fileId])
  }).immediate()
}

/** Keep recovered files associated with this delivery across a crash between
 * catalog commit and live-control copying. Copies use the already-readable live
 * input directory, so a same-process steer never widens its sandbox. */
export function recoveredInboundAttachmentPaths(db: Database, inboxDir: string, key: string): string[] {
  const rows = db.query<InboundDownloadedFile & {sourceMessageId:string}, [string]>(`
    SELECT a.source_message_id AS sourceMessageId,a.file_id AS fileId,a.ordinal,a.path,a.size,a.digest
    FROM recovered_inbound_attachments r JOIN inbound_deliveries i ON i.idempotency_key=r.inbound_key
    JOIN slack_thread_attachments a ON a.chat_id=i.chat_id AND a.thread_ts=i.thread_ts AND a.repo_path=i.repo_path
      AND a.source_message_id=r.source_message_id AND a.file_id=r.file_id
    WHERE r.inbound_key=? AND i.status='processing' ORDER BY a.source_message_id,a.ordinal
  `).all(key)
  return rows.map(file => {
    const verified=loadCachedInboundAttachment({inboxDir,messageTs:file.sourceMessageId,
      fileId:file.fileId,ordinal:file.ordinal,manifest:file})
    if (!verified) throw new Error('recovered live attachment is unavailable')
    return verified.path
  })
}

/** Old unavailable files must not fail unrelated new requests or disappear from
 * the model's view. Try each once per delivery, then pass explicit pending metadata. */
export async function recoverThreadAttachments(options: {
  sources: PendingThreadAttachment[]; messageId: string; signal: AbortSignal; maxBytes: number
  timeoutMs?: number
  download: (source: PendingThreadAttachment, remainingBytes: number, signal: AbortSignal) => Promise<number>
}): Promise<void> {
  try {
    await withSlackDeadline(async signal => {
      let remaining = options.maxBytes
      let count = 0
      for (const source of options.sources) {
        if (signal.aborted) throw new Error('attachment recovery aborted')
        if (Number(source.sourceMessageId) >= Number(options.messageId)) continue
        if (++count > 100 || remaining <= 0) break
        try { remaining -= await options.download(source, remaining, signal) }
        catch (error) {
          if (signal.aborted) throw error
          // Reference stays pending. No raw Slack error/URL is put into model input.
        }
      }
    }, options.timeoutMs ?? slackAttachmentTimeoutMs(), 'thread attachment recovery', options.signal)
  } catch (error) {
    // The recovery-wide deadline bounds the total delay from old files. An
    // actual user interrupt must still preempt and preserve the input lease.
    if (options.signal.aborted) throw error
  }
}
