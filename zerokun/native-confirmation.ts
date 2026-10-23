import type { Database } from 'bun:sqlite'

export type NativeConfirmation = { threadId: string; turnId: string; origin: string }

/** Kept in both developer instructions and fresh turn/control context: resumed
 * conversation history can contain a question whose native RPC has ended. */
export const NATIVE_UPLOAD_CONFIRMATION_PROTOCOL = [
  'The operator has enabled browser uploads already authorized by the task without an extra Slack confirmation.',
  'Never ask for 今回だけ許可 or キャンセル for a browser upload in commentary, async questions,',
  'request_user_input, request_user_input_async, or final answers. Invoke the authorized browser operation directly.',
  'The host answers only the recognized empty Browser Use upload request for the current writable root turn.',
  'This is not new user consent, proof of upload success, or an Auto-review approval. Native policy remains authoritative.',
  'Ordinary Slack replies are task context, not answers to a host upload dialog.',
  'Old upload questions in resumed history are retired. Inspect the previous effect before retrying an authorized',
  'operation after interruption; never repeat a completed upload or revive an old confirmation question.',
  'Respect user cancellations and actual native policy denials across resume. Never use another route to bypass a denial.',
  'A host/session cancellation is not a user decline. Report unsupported requests or failures accurately.',
  'This rule takes priority over generic instructions to begin an unfinished reply with a request.',
].join('\n')

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

/** Called only in exclusive runner recovery, after old executors have stopped.
 * A gateway/status DB open must never cancel an older runner's live RPC.
 * Keep the legacy history and decisions; retirement is not user consent.
 */
export function retireLegacyUploadConfirmations(db: Database, now = Date.now()): void {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_confirmations'").get()) return
  db.transaction(() => {
    db.run(`UPDATE commentary_notifications SET suppressed_at=?
      WHERE delivered_at IS NULL AND suppressed_at IS NULL
        AND source_key IN (SELECT source_key FROM native_confirmations)`, [now])
    db.run(`UPDATE status_notifications SET superseded_at=?
      WHERE delivered_at IS NULL AND superseded_at IS NULL
        AND idempotency_key GLOB 'native-confirmation-answer:*'`, [now])
    db.run("UPDATE native_confirmations SET status='closed' WHERE status='pending'")
  }).immediate()
}
