import { createHash, randomBytes } from 'crypto'
import type { Database } from 'bun:sqlite'

export type NativeConfirmation = { threadId: string; turnId: string; origin: string }
export type NativeConfirmationDecision = 'accept' | 'decline' | 'cancel'

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

/** The operator permits app access for authorized primary Computer Use jobs.
 * Match the official app-access request, not audio recording, file transfer,
 * site access, arbitrary forms, or an Auto-review decision. Native app policy
 * is checked before this request is emitted and remains authoritative.
 */
export function computerUseAppApproval(params: Record<string, unknown>): {
  threadId: string; turnId: string; appId: string; persist: 'session' | 'always'
} | null {
  const schema = object(params.requestedSchema)
  const meta = object(params._meta)
  const toolParams = object(meta?.tool_params)
  if (params.mode !== 'form' || params.serverName !== 'node_repl'
    || typeof params.threadId !== 'string' || !params.threadId
    || typeof params.turnId !== 'string' || !params.turnId
    || !schema || schema.type !== 'object' || !object(schema.properties)
    || Object.keys(object(schema.properties)!).length !== 0
    || Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties'].includes(key))
    || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0))
    || meta?.codex_approval_kind !== 'mcp_tool_call' || meta.connector_id !== 'computer-use'
    || typeof meta.tool_name !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(meta.tool_name)
    || !toolParams || Object.keys(toolParams).length !== 1
    || typeof toolParams.app !== 'string' || toolParams.app.length > 255
    || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(toolParams.app)
    || !Array.isArray(meta.persist) || meta.persist.length === 0
    || meta.persist.some(value => value !== 'session' && value !== 'always')) return null
  return { threadId: params.threadId, turnId: params.turnId, appId: toolParams.app,
    persist: meta.persist.includes('always') ? 'always' : 'session' }
}

/** Only the native browser's empty upload confirmation needs no additional form data. */
export function browserUploadConfirmation(params: Record<string, unknown>): NativeConfirmation | null {
  const schema = object(params.requestedSchema)
  const meta = object(params._meta)
  const toolParams = object(meta?.tool_params)
  if (params.mode !== 'form' || params.serverName !== 'node_repl'
    || typeof params.threadId !== 'string' || typeof params.turnId !== 'string'
    || !params.threadId || !params.turnId
    || !schema || schema.type !== 'object' || !object(schema.properties)
    || Object.keys(object(schema.properties)!).length !== 0
    || Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties'].includes(key))
    || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0))
    || meta?.codex_approval_kind !== 'mcp_tool_call' || meta.connector_id !== 'browser-use'
    || meta.tool_name !== 'upload_browser_files' || meta.file_transfer !== 'upload'
    || typeof toolParams?.origin !== 'string' || toolParams.origin.length > 240) return null
  try {
    const url = new URL(toolParams.origin)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== '/' || !url.hostname) return null
    if (typeof meta.origin === 'string' && new URL(meta.origin).origin !== url.origin) return null
    return { threadId: params.threadId, turnId: params.turnId, origin: url.origin }
  } catch { return null }
}

export function parseNativeConfirmationAnswer(text: string): { code: string; decision: NativeConfirmationDecision } | null {
  const match = /^(今回だけ許可|キャンセル) ([a-f0-9]{12})$/.exec(text.trim())
  return match ? { code: match[2]!, decision: match[1] === '今回だけ許可' ? 'accept' : 'decline' } : null
}

type Binding = NativeConfirmation & { jobId: string; epoch: number; executorNonce: string; requestId: number | string }
type Row = Binding & { code: string; sourceKey: string }
const LEASE_MS = 30_000

/** The runner alone consumes decisions. Gateway restarts preserve replies, never live RPC ownership. */
export class NativeConfirmationStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS native_confirmations (
      code TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, epoch INTEGER NOT NULL,
      executor_nonce TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      request_id TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE, origin TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', decision TEXT, answer_message_id TEXT,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    )`)
  }

  private live(binding: Binding): boolean {
    return Boolean(this.db.query(`SELECT 1 FROM jobs WHERE id=? AND control_epoch=?
      AND executor_nonce=? AND active_thread_id=? AND active_turn_id=?
      AND status='running' AND write_enabled=1 AND cancel_requested_at IS NULL`).get(
      binding.jobId, binding.epoch, binding.executorNonce, binding.threadId, binding.turnId,
    ))
  }

  create(binding: Binding, now = Date.now()): Row | null {
    if (!this.live(binding)) return null
    const code = randomBytes(6).toString('hex')
    const sourceKey = createHash('sha256').update(`native-confirmation:${code}`).digest('hex')
    this.db.run(`INSERT INTO native_confirmations
      (code,job_id,epoch,executor_nonce,thread_id,turn_id,request_id,source_key,origin,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [code, binding.jobId, binding.epoch, binding.executorNonce,
      binding.threadId, binding.turnId, JSON.stringify(binding.requestId), sourceKey, binding.origin,
      now + LEASE_MS, now])
    return { ...binding, code, sourceKey }
  }

  /** An exact reply from the requesting user is an answer, never an ordinary new Codex task. */
  answer(input: { code: string; decision: NativeConfirmationDecision; chatId: string; threadTs: string;
    userId: string; messageId: string; writeEnabled: boolean }, now = Date.now()): boolean {
    if (!input.writeEnabled) return false
    const result = this.db.run(`UPDATE native_confirmations SET decision=?,answer_message_id=?
      WHERE code=? AND status='pending' AND decision IS NULL AND expires_at>?
      AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=native_confirmations.job_id
        AND j.chat_id=? AND j.thread_ts=? AND j.user_id=? AND j.status='running'
        AND j.write_enabled=1 AND j.cancel_requested_at IS NULL
        AND j.control_epoch=native_confirmations.epoch AND j.executor_nonce=native_confirmations.executor_nonce
        AND j.active_thread_id=native_confirmations.thread_id AND j.active_turn_id=native_confirmations.turn_id)
      AND EXISTS (SELECT 1 FROM commentary_notifications c WHERE c.source_key=native_confirmations.source_key
        AND c.suppressed_at IS NULL)`, [input.decision, input.messageId, input.code, now,
      input.chatId, input.threadTs, input.userId])
    if (result.changes === 1) return true
    return Boolean(this.db.query(`SELECT 1 FROM native_confirmations n JOIN jobs j ON j.id=n.job_id
      WHERE n.code=? AND n.answer_message_id=? AND n.decision=? AND j.chat_id=? AND j.thread_ts=? AND j.user_id=?`).get(
      input.code, input.messageId, input.decision, input.chatId, input.threadTs, input.userId,
    ))
  }

  poll(row: Row, now = Date.now()): NativeConfirmationDecision | null {
    return this.db.transaction(() => {
      if (!this.live(row)) return 'cancel' as const
      const current = this.db.query<{ decision: NativeConfirmationDecision | null; delivered: number | null;
        suppressed: number | null; expires: number }, [string]>(
        `SELECT n.decision,c.delivered_at AS delivered,c.suppressed_at AS suppressed,n.expires_at AS expires
         FROM native_confirmations n LEFT JOIN commentary_notifications c ON c.source_key=n.source_key
         WHERE n.code=? AND n.status='pending'`,
      ).get(row.code)
      if (!current || current.expires <= now || current.suppressed !== null) return 'cancel' as const
      if (current.decision && current.delivered !== null) {
        this.db.run("UPDATE native_confirmations SET status='consumed' WHERE code=? AND status='pending'", [row.code])
        return current.decision
      }
      this.db.run("UPDATE native_confirmations SET expires_at=? WHERE code=? AND status='pending'", [now + LEASE_MS, row.code])
      return null
    }).immediate()
  }

  close(row: Row): void {
    this.db.run("UPDATE native_confirmations SET status='closed' WHERE code=? AND status='pending'", [row.code])
    // An unsent prompt cannot remain actionable after its native session ends.
    this.db.run(`UPDATE commentary_notifications SET suppressed_at=?
      WHERE source_key=? AND delivered_at IS NULL AND suppressed_at IS NULL`, [Date.now(), row.sourceKey])
  }
}

export async function awaitNativeConfirmation(options: {
  store: NativeConfirmationStore; binding: Binding; signal: AbortSignal;
  prepareText(text: string): string;
  publish(event: { sourceKey: string; text: string }): boolean;
  sleep?: () => Promise<void>;
}): Promise<NativeConfirmationDecision> {
  if (options.signal.aborted) return 'cancel'
  // turn/started and the first server request can precede the turn/start RPC reply.
  let row: Row | null = null
  for (let attempt = 0; attempt < 5 && !options.signal.aborted; attempt++) {
    row = options.store.create(options.binding)
    if (row) break
    await (options.sleep?.() ?? Bun.sleep(100))
  }
  if (!row) return 'cancel'
  try {
    const text = options.prepareText([
      `ブラウザが、この依頼で使うファイルを ${row.origin} へアップロードする確認を求めています。`,
      '依頼したご本人が、このスレッドで次のどちらかを返信してください。',
      `今回だけ許可 ${row.code}`,
      `キャンセル ${row.code}`,
      '回答後は同じ処理を続けます。この確認だけへの回答で、常時許可にはしません。',
    ].join('\n'))
    // An approval must display its exact destination. This is a delivery
    // integrity check, independent of the destination text or hostname.
    if (!text.includes(row.origin)) return 'cancel'
    if (!options.publish({ sourceKey: row.sourceKey, text })) return 'cancel'
    while (!options.signal.aborted) {
      const decision = options.store.poll(row)
      if (decision) return decision
      await (options.sleep?.() ?? Bun.sleep(250))
    }
    return 'cancel'
  } finally { options.store.close(row) }
}
