#!/usr/bin/env -S bun --config=/dev/null --no-env-file
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { JobStore, type JobRecord } from './job-runner.ts'
import { liveControlInputDir } from './live-control.ts'
import { requireManagedDirectory, requireManagedStateRoot, ensureManagedDirectory } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { resolveZeroJobDatabasePath } from './state-dir.ts'
import { readProcessIdentity, observeProcessGeneration } from './process-generation.ts'
import { tryAcquireProcessLock, releaseProcessLock } from './process-lock.ts'
import { runClaudeDelegation, ClaudeDelegationError, delegationFailure, type DelegationFailure } from './claude-delegation-attempt.ts'
import { canFallbackFromClaudeQuota, OPUS_ADVISOR_MODEL, CLAUDE_QUOTA_FALLBACK_NOTICE } from './claude-quota-fallback.ts'
import { readPinnedHerdrRuntime, environmentForPinnedHerdrRuntime, verifyHerdrRuntimeIdentityAsync } from './herdr-runtime.ts'

export interface DelegationContext { version: 1; stateDir: string; job: JobRecord }
interface Request { key: string; model: string; prompt: string }
interface Result { id: string; model: string; requestedModel?: string; fallbackFrom?: string; fallbackReason?: 'fable-quota'; fallbackNotice?: string; failure?: DelegationFailure; attempts?: Array<{ model: string; failure: DelegationFailure }>;  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; result?: string; truncated?: boolean; resultPath?: string; artifactDir?: string; reportError?: string }
type Run = (context: DelegationContext, id: string, request: Request, signal: AbortSignal) => Promise<string>

export { runClaudeDelegation } from './claude-delegation-attempt.ts'

/** These failures happen before a claim or worker can exist. Never present
 * them as an uncertain delivery or disclose raw infrastructure exceptions. */
class DelegationRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class ClaudeDelegations {
  private pending = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private closing = false
  private cleanupFailure: unknown
  private settled = new Map<string, Result & { digest: string; owner: unknown }>()
  constructor(readonly context: DelegationContext, private run: Run = runClaudeDelegation) {}
  private path(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error('invalid delegation id')
    return join(ensureManagedDirectory(this.context.stateDir,
      join(this.context.stateDir, 'delegations', this.context.job.id)), `${id}.json`)
  }
  poll(id: string): Result {
    const settled = this.settled.get(id)
    if (settled) {
      // A transient final-record write failure must not resurrect a worker that
      // this broker has already reaped. Retry persistence without rerunning it.
      try { atomicWritePrivateFile(this.path(id), JSON.stringify(settled)) } catch {}
      return settled
    }
    const saved = JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(this.path(id), 256 * 1024) ?? 'null')
    if (!saved || saved.id !== id) throw Error('unknown delegation')
    // A lost MCP response is not permission to launch another worker. The
    // runner's executor/pane recovery owns orphan cleanup after a host crash.
    if (saved.status === 'running' && !this.pending.has(id)
      && (!saved.owner || observeProcessGeneration(saved.owner).status === 'dead')) {
      saved.status = 'interrupted'
      saved.failure = delegationFailure('dispatch', 'delivery-unknown')
      atomicWritePrivateFile(this.path(id), JSON.stringify(saved))
    }
    return saved
  }
  start(request: Request): Result {
    if (this.closing) throw Error('delegation broker closing')
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(request.key)) throw new DelegationRequestError('invalid-key', 'invalid delegation key; use a stable key containing letters, digits, underscores or hyphens.')
    // Native IDs are passed as a separate argv value. Do not restrict families
    // or versions: the installed Claude runtime decides model availability.
    if (!/^claude-[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(request.model) || request.model.length > 80) {
      throw new DelegationRequestError('invalid-model', 'invalid native Claude model ID; this request was not submitted.')
    }
    if (!request.prompt.trim() || Buffer.byteLength(request.prompt) > 96 * 1024) throw new DelegationRequestError('invalid-prompt', 'invalid delegation prompt: provide nonempty text within 96 KiB; this request was not submitted.')
    const id = createHash('sha256').update(JSON.stringify([this.context.job.id, request.key])).digest('hex')
    const path = this.path(id)
    const digest = createHash('sha256').update(JSON.stringify([request.model, request.prompt])).digest('hex')
    const saved = readOptionalBoundedOwnerOnlyRegularFile(path, 256 * 1024)
    if (saved) {
      if (JSON.parse(saved).digest !== digest) throw Error('delegation key already used for another request')
      return this.poll(id)
    }
    // Independent requests have independent workers. A previous request's
    // receipt, cleanup outcome, or live worker must not gate a new key.
    // Serialize only claims for this exact request to avoid duplicate delivery.
    const lockPath = join(dirname(path), `${id}.lock`)
    const attempt = tryAcquireProcessLock(lockPath)
    if (!attempt.acquired) throw Error('delegation already owned by another broker')
    // Recheck under the request lock, then durably claim BEFORE launching.
    if (readOptionalBoundedOwnerOnlyRegularFile(path, 256 * 1024)) {
      releaseProcessLock(lockPath, attempt.lease); return this.start(request)
    }
    const result: Result = { id, model: request.model, requestedModel: request.model, status: 'running' }
    const owner = readProcessIdentity(process.pid)
    if (!owner) { releaseProcessLock(lockPath, attempt.lease); throw Error('broker owner unavailable') }
    const save = () => atomicWritePrivateFile(path, JSON.stringify({ ...result, digest, owner }))
    try { save() } catch (error) {
      result.status = 'interrupted'
      this.settled.set(id, { ...result, digest, owner })
      try { save() } catch {}
      releaseProcessLock(lockPath, attempt.lease); throw error
    }
    const controller = new AbortController()
    const done = Promise.resolve().then(async () => {
      try {
        let text: string
        try { text = await this.run(this.context, id, request, controller.signal) }
        catch (error) {
          if (!(error instanceof ClaudeDelegationError)) throw error
          result.attempts = [{ model: request.model, failure: error.failure }]
          if (controller.signal.aborted || !canFallbackFromClaudeQuota({ model: request.model, ...error.failure })) throw error
          // Persist the chosen attempt before any Opus bytes can be delivered.
          // On broker loss the existing running claim becomes interrupted, never replayed.
          result.model = OPUS_ADVISOR_MODEL
          result.fallbackFrom = request.model
          result.fallbackReason = 'fable-quota'
          result.fallbackNotice = CLAUDE_QUOTA_FALLBACK_NOTICE
          try {
            save()
            const store = new JobStore(resolveZeroJobDatabasePath(this.context.stateDir))
            try { store.stageClaudeDelegationFallbackNotification(this.context.job.id, id) }
            finally { store.close() }
          } catch { throw new ClaudeDelegationError(delegationFailure('persistence', 'persistence')) }
          controller.signal.throwIfAborted()
          text = await this.run(this.context, id, { ...request, model: OPUS_ADVISOR_MODEL }, controller.signal)
        }
        // Worst-case JSON escaping is six bytes per UTF-16 code unit. Keep the
        // entire durable record below its 256 KiB read bound, including CJK.
        result.artifactDir = join(this.context.stateDir, 'outbox', this.context.job.id)
        result.result = text.slice(0, 32 * 1024)
        if (/[\uD800-\uDBFF]$/.test(result.result)) result.result = result.result.slice(0, -1)
        result.truncated = result.result.length < text.length
        result.status = 'completed'
        try {
          const inputRoot = liveControlInputDir(this.context.stateDir, this.context.job.id)
          const reportPath = join(ensureManagedDirectory(this.context.stateDir, join(inputRoot, 'delegated-results')), `${id}.txt`)
          atomicWritePrivateFile(reportPath, text)
          result.resultPath = reportPath
        } catch {
          result.reportError = 'The child completed, but the full report could not be saved. Inspect its changes and this preview; do not replay the child.'
        }
      }
      catch (error) {
        const nativeFailure = error instanceof ClaudeDelegationError ? error.failure : undefined
        result.failure = nativeFailure?.code === 'cleanup' ? nativeFailure
          : controller.signal.aborted ? delegationFailure('execution', 'cancelled')
          : nativeFailure ?? delegationFailure('execution', 'unknown')
        if (result.failure.code === 'cleanup') this.cleanupFailure = error
        result.attempts ??= []
        if (!result.attempts.some(attempt => attempt.model === result.model && attempt.failure === result.failure)) {
          result.attempts.push({ model: result.model, failure: result.failure })
        }
        result.status = controller.signal.aborted ? 'cancelled' : 'failed'
      }
      finally {
        this.settled.set(id, { ...result, digest, owner })
        try {
          save()
        } catch (error) { this.cleanupFailure = error }
        releaseProcessLock(lockPath, attempt.lease)
        this.pending.delete(id)
      }
    })
    this.pending.set(id, { controller, done })
    return result
  }
  async wait(id: string, milliseconds = 20_000) {
    const pending = this.pending.get(id)
    if (pending) await Promise.race([pending.done, Bun.sleep(milliseconds)])
    return this.poll(id)
  }
  async cancel(id: string) { const pending = this.pending.get(id); pending?.controller.abort(); await pending?.done; return this.poll(id) }
  async close() {
    this.closing = true
    for (const pending of this.pending.values()) pending.controller.abort()
    await Promise.all([...this.pending.values()].map(p => p.done))
    if (this.cleanupFailure) throw this.cleanupFailure
  }
}

export function readDelegationContext(path: string, stateInput: string): DelegationContext {
  const stateDir = requireManagedStateRoot(stateInput)
  requireManagedDirectory(stateDir, dirname(path))
  const context = JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(path, 256 * 1024) ?? 'null')
  if (!context || context.version !== 1 || context.stateDir !== stateDir
    || !/^[A-Za-z0-9_-]{1,128}$/.test(context.job?.id ?? '') || typeof context.job?.repoPath !== 'string'
    || typeof context.job?.writeEnabled !== 'boolean') throw Error('invalid delegation context')
  return context
}
export function createDelegationServer(runs: ClaudeDelegations) {
  const server = new McpServer({ name: 'zerochan-claude-delegation', version: '1.0.0' })
  const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
  const guard = async (call: () => unknown) => {
    try { return reply(await call()) }
    catch (error) {
      if (error instanceof DelegationRequestError) return { ...reply({ status: 'unavailable', code: error.code,
        delivery: 'not-started', reason: error.message }), isError: true }
      return { ...reply({ status: 'unavailable', delivery: 'unknown', reason: 'Claude delegation could not be verified. Preserve the original request; do not substitute another model or repeat a delivered request.' }), isError: true }
    }
  }
  server.registerTool('claude_delegate_start', { description: 'Explicit user-requested Claude delegation in a fresh owned Herdr tab. Codex stays primary. Use the requested exact native model ID (e.g. claude-fable-5-1 or claude-opus-5-5), stable key and subtask prompt. A native initial Fable-only quota rejection switches once to Opus 5.5 after cleanup; no fallback after work has started or for other failures. Report fallbackNotice and failure.reason with the actual model. Child inherits the parent project write authorization and sandbox, with independent goal/session. Not the fixed Fable advisor. Returns immediately; poll the same id, never restart on a delayed response. Parent owns approval, integration, review and publication.',
    inputSchema: { key: z.string().max(80), model: z.string().max(80), prompt: z.string().max(96 * 1024) } }, async input => guard(() => runs.start(input)))
  server.registerTool('claude_delegate_poll', { description: 'Wait for the same delegated Claude. Repeat while running. Completed is the child result, not parent task completion. Read resultPath for the full report (including when truncated) and inspect artifactDir; both are within the parent task scope. Interrupted/failed is not permission to replay its changes.',
    inputSchema: { id: z.string().regex(/^[a-f0-9]{64}$/) } }, async input => guard(() => runs.wait(input.id)))
  server.registerTool('claude_delegate_cancel', { description: 'Cancel and reap only this task’s owned delegated Claude, preserving any partial changes for parent inspection.',
    inputSchema: { id: z.string().regex(/^[a-f0-9]{64}$/) } }, async input => guard(() => runs.cancel(input.id)))
  return server
}
async function main() {
  const [path, state] = process.argv.slice(2)
  if (!path || !state || process.argv.length !== 4) throw Error('invalid delegation invocation')
  const runtime = readPinnedHerdrRuntime(state)
  const environment = environmentForPinnedHerdrRuntime(runtime)
  await verifyHerdrRuntimeIdentityAsync(runtime, environment)
  Object.assign(process.env, environment)
  const context = readDelegationContext(path, state), runs = new ClaudeDelegations(context), server = createDelegationServer(runs)
  const db = new Database(resolveZeroJobDatabasePath(state), { readonly: true })
  let stopping = false
  const close = async () => { if (stopping) return; stopping = true; clearInterval(timer); try { await runs.close() } finally { await server.close(); db.close() } }
  const stop = () => { void close().catch(() => { process.exitCode = 1 }) }
  const timer = setInterval(() => {
    try {
      const row = db.query<any,[string]>('SELECT status,cancel_requested_at FROM jobs WHERE id=?').get(context.job.id)
      if (!row || row.status !== 'running' || row.cancel_requested_at !== null) stop()
    } catch {}
  }, 500)
  process.once('SIGTERM', stop); process.once('SIGINT', stop); process.stdin.once('end', stop); server.server.onclose = stop
  await server.connect(new StdioServerTransport())
}
if (import.meta.main) main().catch(() => { process.stderr.write('Claude delegation broker could not start\n'); process.exitCode = 1 })
