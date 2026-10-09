import { Database } from 'bun:sqlite'
import { lstatSync, readdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { ensureManagedDirectory, requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { observeProcessGeneration, processStartEpochMs, type ProcessIdentity } from './process-generation.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const FIELDS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const
export type TokenCounts = Record<typeof FIELDS[number], number>
const zero = (): TokenCounts => ({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 })
function counts(value: any): TokenCounts | undefined {
  if (!value || FIELDS.some(k => !Number.isSafeInteger(value[k]) || value[k] < 0)) return
  if (value.cachedInputTokens > value.inputTokens || value.reasoningOutputTokens > value.outputTokens) return
  return Object.fromEntries(FIELDS.map(k => [k, value[k]])) as TokenCounts
}
function difference(high: TokenCounts, low: TokenCounts): TokenCounts | undefined {
  if (FIELDS.some(k => high[k] < low[k])) return
  return Object.fromEntries(FIELDS.map(k => [k, high[k] - low[k]])) as TokenCounts
}
function add(target: TokenCounts, value: TokenCounts): void {
  for (const k of FIELDS) {
    if (!Number.isSafeInteger(target[k] + value[k])) throw Error('usage counter overflow')
    target[k] += value[k]
  }
}
type UsageTurn = { thread: string; turn: string; model: string | null; baseline?: TokenCounts; maximum?: TokenCounts; ended: boolean; invalid: boolean }
type UsageDocument = { version: 1; provider: 'codex'; closed: boolean; partial: boolean; turns: UsageTurn[]; sourceLog?: string }

/** Numeric-only projection. Resume snapshots for old turns are deliberately ignored.
 * The first request supplies its baseline (total - last); later cumulative updates
 * cover missed intermediate updates without adding cumulative totals repeatedly. */
export class CodexUsageTracker {
  private turns = new Map<string, UsageTurn>()
  private partial = false
  private root: string | undefined
  constructor(private model: string | null = null, private persist?: (doc: UsageDocument) => void) {}
  observe(event: any): void {
    const p = event?.params
    if (!p || !ID.test(p.threadId ?? '')) return
    const turnId = event.method === 'thread/tokenUsage/updated' ? p.turnId : p.turn?.id
    if (!ID.test(turnId ?? '')) return
    const key = `${p.threadId}/${turnId}`
    if (event.method === 'turn/started' && !this.turns.has(key)) {
      if (this.turns.size >= 4096) { this.partial = true; return }
      this.root ??= p.threadId
      this.turns.set(key, { thread: p.threadId, turn: turnId,
        model: p.threadId === this.root && this.model && MODEL.test(this.model) ? this.model : null,
        ended: false, invalid: false })
    }
    const turn = this.turns.get(key)
    if (!turn) return
    if (event.method === 'thread/tokenUsage/updated') {
      const total = counts(p.tokenUsage?.total), last = counts(p.tokenUsage?.last)
      if (!total || !last) { turn.invalid = true }
      else if (!turn.baseline) {
        turn.baseline = difference(total, last)
        turn.maximum = total
        if (!turn.baseline) turn.invalid = true
      } else if (FIELDS.every(k => total[k] >= turn.maximum![k])) turn.maximum = total
      else turn.invalid = true
      // Repeated complete snapshots are not another charge. Regressions may be
      // stale delivery or a counter reset; neither justifies a complete total.
    } else if (event.method === 'turn/completed') turn.ended = true
    else if (event.method !== 'turn/started') return
    this.persist?.(this.document(false))
  }
  markPartial(): void { this.partial = true }
  document(closed: boolean): UsageDocument {
    return { version: 1, provider: 'codex', closed, partial: this.partial, turns: [...this.turns.values()] }
  }
  close(): void { this.persist?.(this.document(true)) }
}

export function createUsageRecorder(state: string, jobId: string, attempt: string, model: string, sourceLog?: string): CodexUsageTracker {
  if (!ID.test(jobId) || !ID.test(attempt)) throw Error('invalid usage identity')
  const root = ensureManagedDirectory(state, join(state, 'task-usage', jobId))
  return new CodexUsageTracker(model, doc => atomicWritePrivateFile(join(root, `${attempt}.json`), JSON.stringify({...doc,sourceLog})))
}

type Job = { id: string; seq: number; chat_id: string; thread_ts: string; repo_path: string; status: string; created_at: number }
export type UsageContext = { jobId: string; repoPath: string }
type Budget = { bytes: number }
function privateRead(path: string, max: number, budget: Budget): string | null {
  const text = readOptionalBoundedOwnerOnlyRegularFile(path, Math.min(max, budget.bytes))
  budget.bytes -= Buffer.byteLength(text ?? '')
  return text
}
function readDocument(raw: string): UsageDocument {
  const value = JSON.parse(raw)
  if (value.version !== 1 || value.provider !== 'codex' || typeof value.closed !== 'boolean'
    || typeof value.partial !== 'boolean' || !Array.isArray(value.turns) || value.turns.length > 4096) throw Error('invalid usage record')
  return { version: 1, provider: 'codex', closed: value.closed, partial: value.partial,
    ...(typeof value.sourceLog === 'string' && /^[A-Za-z0-9._-]+\.stdout\.log$/.test(value.sourceLog) ? {sourceLog:value.sourceLog} : {}),
    turns: value.turns.map((t: any) => {
      if (!ID.test(t.thread) || !ID.test(t.turn) || !(t.model === null || MODEL.test(t.model))
        || typeof t.ended !== 'boolean' || typeof t.invalid !== 'boolean'
        || (t.baseline !== undefined && !counts(t.baseline)) || (t.maximum !== undefined && !counts(t.maximum))) throw Error('invalid usage turn')
      return { thread: t.thread, turn: t.turn, model: t.model, baseline: counts(t.baseline), maximum: counts(t.maximum), ended: t.ended, invalid: t.invalid }
    }) }
}

function jobCodexUsage(state: string, job: Job, budget: Budget) {
  const turns = new Map<string, UsageTurn>()
  let partial = false, sources = 0
  const coveredLogs = new Set<string>()
  const merge = (doc: UsageDocument) => {
    sources++
    partial ||= doc.partial || !doc.closed
    for (const t of doc.turns) {
      const key = `${t.thread}/${t.turn}`, prior = turns.get(key)
      if (!prior) { turns.set(key, t); continue }
      prior.ended ||= t.ended
      prior.invalid ||= t.invalid
      if (prior.model !== t.model) prior.model = null
      if (t.baseline && (!prior.baseline || FIELDS.every(k => t.baseline![k] <= prior.baseline![k]))) prior.baseline = t.baseline
      if (t.maximum && (!prior.maximum || FIELDS.every(k => t.maximum![k] >= prior.maximum![k]))) prior.maximum = t.maximum
      else if (t.maximum && FIELDS.some(k => t.maximum![k] > prior.maximum![k])) prior.invalid = true
    }
  }
  try {
    const dir = requireManagedDirectory(state, join(state, 'task-usage', job.id))
    for (const name of readdirSync(dir).filter(n => /^[A-Za-z0-9_-]+\.json$/.test(n)).slice(0, 128)) {
      const raw = privateRead(join(dir, name), 4 * 1024 * 1024, budget)
      if (raw) {
        const doc = readDocument(raw)
        merge(doc)
        if (doc.sourceLog) coveredLogs.add(doc.sourceLog)
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') partial = true }
  // Backfill numeric evidence in memory. It never returns command output or
  // rewrites source logs, and old files cannot replace the new durable ledger.
  try {
    const dir = requireManagedDirectory(state, join(state, 'job-logs'))
    const names = readdirSync(dir).filter(n => n.startsWith(`${job.id}.`) && /^[A-Za-z0-9._-]+\.stdout\.log$/.test(n))
    if (names.length > 64) partial = true
    for (const name of names.slice(0, 64)) {
      if (coveredLogs.has(name)) continue
      const tracker = new CodexUsageTracker()
      const raw = privateRead(join(dir, name), 20 * 1024 * 1024, budget)
      if (!raw) continue
      for (const line of raw.split('\n')) {
        try { tracker.observe(JSON.parse(line)) } catch { /* non-JSON/truncated boundary */ }
      }
      const index = privateRead(join(dir, `${name}.tail.json`), 4096, budget)
      if (index) {
        const tail = JSON.parse(index)
        if (tail.prefixTruncated === true) {
          tracker.markPartial()
          const order = tail.latestSegment === 0 ? [1, 0] : [0, 1]
          const chunks = order.map(i => privateRead(join(dir, `${name}.tail-${i}.log`), 1024 * 1024, budget) ?? '').join('')
          for (const line of chunks.split('\n')) try { tracker.observe(JSON.parse(line)) } catch {}
        }
      } else if (Buffer.byteLength(raw) >= 20 * 1024 * 1024) tracker.markPartial()
      merge(tracker.document(job.status !== 'running'))
    }
  } catch (error) { if (!sources || (error as NodeJS.ErrnoException).code !== 'ENOENT') partial = true }
  const total = zero(), byModel = new Map<string, TokenCounts>()
  let measured = 0
  for (const t of turns.values()) {
    const delta = t.baseline && t.maximum ? difference(t.maximum, t.baseline) : undefined
    if (!delta) { partial = true; continue }
    partial ||= !t.ended || t.invalid
    add(total, delta); measured++
    const key = t.model ?? 'unknown'
    if (!byModel.has(key)) byModel.set(key, zero())
    add(byModel.get(key)!, delta)
  }
  return { status: measured ? partial ? 'partial' : 'reported' : 'unavailable',
    source: sources ? 'host-numeric-records-or-logs' : 'no-retained-records',
    tokens: measured ? total : null, measuredTurns: measured,
    byModel: [...byModel].map(([model, tokens]) => ({ model, tokens })) }
}

function safeDatabase(state: string): Database {
  const path = join(state, 'jobs.sqlite3')
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const s = lstatSync(path + suffix)
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw Error('unsafe usage database')
    } catch (error) { if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
  }
  return new Database(path, { readonly: true })
}

export function readTaskUsage(stateInput: string, context: UsageContext,
  input: { taskNumbers?: number[]; beforeTaskNumber?: number } = {}) {
  if (input.beforeTaskNumber !== undefined && (!Number.isSafeInteger(input.beforeTaskNumber) || input.beforeTaskNumber < 1)) throw Error('invalid task number')
  const state = requireManagedStateRoot(stateInput)
  const db = safeDatabase(state)
  try {
    const current = db.query<Job, [string]>('SELECT id,seq,chat_id,thread_ts,repo_path,status,created_at FROM jobs WHERE id=?').get(context.jobId)
    if (!current || current.repo_path !== context.repoPath) throw Error('usage scope unavailable')
    const jobs = db.query<Job, [string, string, string, number, number]>(
      'SELECT id,seq,chat_id,thread_ts,repo_path,status,created_at FROM jobs WHERE chat_id=? AND thread_ts=? AND repo_path=? AND seq<=? AND seq<? ORDER BY seq DESC LIMIT 101',
    ).all(current.chat_id, current.thread_ts, current.repo_path, current.seq, input.beforeTaskNumber ?? current.seq + 1)
    if (input.taskNumbers?.some(n => !Number.isSafeInteger(n) || n < 1) || (input.taskNumbers?.length ?? 0) > 10) throw Error('invalid task numbers')
    const selected = input.taskNumbers ? jobs.filter(j => input.taskNumbers!.includes(j.seq)) : jobs.slice(0, 10)
    if (input.taskNumbers && new Set(input.taskNumbers).size !== selected.length) throw Error('requested task is outside retained conversation scope')
    const budget = { bytes: 200 * 1024 * 1024 }
    return { currentTaskNumber: current.seq, scope: 'current-app-project-chat-thread',
      hasEarlierTasks: !input.taskNumbers && jobs.length > selected.length,
      jobs: selected.map(job => {
        if (!ID.test(job.id)) throw Error('invalid job identity')
        return { taskNumber: job.seq, createdAt: job.created_at, codex: jobCodexUsage(state, job, budget),
          claude: readClaudeUsage(state, job.id, budget) }
      }),
      accounting: 'Codex inputTokens includes cachedInputTokens; reasoningOutputTokens is included in outputTokens. Subtract cached input before applying uncached rates. Claude cacheRead/cacheWrite are separate from input. Do not add cumulative snapshots, or treat unavailable/partial as zero. Prices and actual subscription bills are not included. Unknown historical models require an explicit hypothetical rate. Grok excluded.' }
  } finally { db.close() }
}

type ClaudeTokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
function claudeDirectories(home: string, children: string[]): string {
  let path = home
  for (const child of ['', ...children]) {
    if (child) path = join(path, child)
    const s = lstatSync(path)
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o022)) throw Error('unsafe Claude runtime directory')
  }
  return path
}

/** Safe-mode can hide the session from Herdr hooks. Read only the runtime
 * metadata named by our recorded live PID, with generation and cwd checks. */
export function ownedClaudeUsageSession(home: string, project: string, process: ProcessIdentity): string | undefined {
  try {
    if (observeProcessGeneration(process).status !== 'alive') return
    const dir = claudeDirectories(home, ['sessions'])
    const raw = readOptionalBoundedOwnerOnlyRegularFile(join(dir, `${process.pid}.json`), 16 * 1024)
    if (!raw) return
    const d = JSON.parse(raw)
    const start = typeof d.startedAt === 'number' ? d.startedAt : Date.parse(d.startedAt)
    if (d.pid !== process.pid || d.cwd !== project || !UUID.test(d.sessionId ?? '')
      || !Number.isFinite(start) || start < processStartEpochMs(process) - 1000 || start > Date.now()
      || observeProcessGeneration(process).status !== 'alive') return
    return d.sessionId
  } catch { return }
}
/** Called only with an exact owned native session, never a model-supplied path. */
export function captureClaudeUsage(state: string, jobId: string, attempt: string,
  sessionId: string | undefined, projectRoot: string, claudeHome: string): void {
  if (!ID.test(jobId) || !ID.test(attempt)) return
  const dir = ensureManagedDirectory(state, join(state, 'task-usage-claude', jobId))
  const rows: Array<{ model: string; tokens: ClaudeTokens }> = []
  let status = 'unavailable'
  if (sessionId && UUID.test(sessionId)) try {
    const project = projectRoot.replace(/[^a-zA-Z0-9]/g, '-')
    // Validate every directory rather than following an arbitrary ~/.claude link.
    claudeDirectories(claudeHome, ['projects', project])
    const raw = readOptionalBoundedOwnerOnlyRegularFile(join(claudeHome, 'projects', project, `${sessionId}.jsonl`), 32 * 1024 * 1024)
    const seen = new Map<string, { model: string; tokens: ClaudeTokens }>()
    let incomplete = false
    if (raw) for (const line of raw.split('\n')) {
      if (!line) continue
      let event: any
      try { event = JSON.parse(line) } catch { incomplete = true; continue }
      if (!event || typeof event !== 'object' || Array.isArray(event)) { incomplete = true; continue }
      const message = event.message, usage = message?.usage
      if (event.type !== 'assistant' || event.sessionId !== sessionId) continue
      if (!usage || !ID.test(message?.id ?? '') || !MODEL.test(message?.model ?? '')) { incomplete = true; continue }
      const tokens = { input: usage.input_tokens, output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }
      if (Object.values(tokens).some(n => !Number.isSafeInteger(n) || n < 0)) { incomplete = true; continue }
      seen.set(message.id, { model: message.model, tokens })
    }
    rows.push(...seen.values()); if (rows.length) status = incomplete ? 'partial' : 'reported'
  } catch { status = 'partial' }
  atomicWritePrivateFile(join(dir, `${attempt}.json`), JSON.stringify({ version: 1, status, rows,
    sessionKey: sessionId ? createHash('sha256').update(sessionId).digest('hex') : null }))
}

function readClaudeUsage(state: string, jobId: string, budget: Budget) {
  const tokens: ClaudeTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let measured = false, partial = false
  const seen = new Set<string>()
  const byModel = new Map<string, ClaudeTokens>()
  try {
    const dir = requireManagedDirectory(state, join(state, 'task-usage-claude', jobId))
    const names = readdirSync(dir).filter(n => /^[A-Za-z0-9_-]+\.json$/.test(n))
    if (names.length > 128) partial = true
    for (const name of names.slice(0, 128)) {
      const raw = privateRead(join(dir, name), 4 * 1024 * 1024, budget)
      if (!raw) continue
      const d = JSON.parse(raw)
      if (d.version !== 1 || !['reported','partial'].includes(d.status)) { partial = true; continue }
      partial ||= d.status === 'partial'
      if (typeof d.sessionKey !== 'string' || !/^[a-f0-9]{64}$/.test(d.sessionKey) || !Array.isArray(d.rows) || d.rows.length > 10000) throw Error('invalid usage')
      if (seen.has(d.sessionKey)) continue
      seen.add(d.sessionKey)
      for (const row of d.rows) {
        if (typeof row.model !== 'string' || !MODEL.test(row.model)) throw Error('invalid model')
        if (!byModel.has(row.model)) byModel.set(row.model, {input:0,output:0,cacheRead:0,cacheWrite:0})
        for (const k of ['input','output','cacheRead','cacheWrite'] as const) {
          const n = row.tokens?.[k]
          if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(tokens[k] + n)) throw Error('invalid usage')
          tokens[k] += n
          byModel.get(row.model)![k] += n
        }
        measured = true
      }
    }
  } catch { partial = true }
  return { status: measured ? partial ? 'partial' : 'reported' : 'unavailable', tokens: measured ? tokens : null,
    byModel: [...byModel].map(([model, tokens]) => ({model,tokens})),
    note: measured ? 'Owned Claude session numeric records.' : 'No numeric record bound to an owned Claude session. This does not prove zero usage or absence of all Claude runtime logs.' }
}
