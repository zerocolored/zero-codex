#!/usr/bin/env -S bun --config=/dev/null --no-env-file
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'crypto'
import { dirname, join } from 'path'
import type { JobRecord } from './job-runner.ts'
import { liveControlInputDir } from './live-control.ts'
import { requireManagedDirectory, requireManagedStateRoot, ensureManagedDirectory } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { resolveZeroJobDatabasePath } from './state-dir.ts'
import { readProcessIdentity, observeProcessGeneration } from './process-generation.ts'
import { tryAcquireProcessLock, releaseProcessLock } from './process-lock.ts'
import { prepareClaudeJobContext } from './claude-job-context.ts'
import { assertClaudeMainlineReady } from './claude-mainline-runtime.ts'
import { ClaudeControlSession, claudeResult } from './claude-control-session.ts'
import { readPinnedHerdrRuntime, environmentForPinnedHerdrRuntime, verifyHerdrRuntimeIdentityAsync } from './herdr-runtime.ts'
import { openClaudeHerdrTransport } from './claude-herdr-transport.ts'

export interface DelegationContext { version: 1; stateDir: string; job: JobRecord }
interface Request { key: string; model: string; prompt: string }
interface Result { id: string; model: string; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; result?: string; truncated?: boolean; resultPath?: string; artifactDir?: string; reportError?: string }
type Run = (context: DelegationContext, id: string, request: Request, signal: AbortSignal) => Promise<string>

/** Separate child identity, goal, receipt and session. Parent dispatch/model and
 * the fixed three-advisor ledger are never consumed by an explicit delegation. */
export const runClaudeDelegation: Run = async (context, id, request, signal) => {
  const job = { ...context.job, id: `delegate-${id}`, task: request.prompt, runtime: 'claude-code' as const,
    sessionId: null }
  const executable = assertClaudeMainlineReady(job.repoPath)
  const prepared = prepareClaudeJobContext(job, context.stateDir, { model: request.model, parentJobId: context.job.id })
  let transport: Awaited<ReturnType<typeof openClaudeHerdrTransport>> | undefined
  let session: ClaudeControlSession | undefined
  try {
    signal.throwIfAborted()
    const sessionId = randomUUID()
    transport = await openClaudeHerdrTransport({ stateDir: context.stateDir, jobId: job.id,
      sequence: job.seq, cwd: prepared.jobRepo, executable,
      arguments: prepared.argumentsFor(sessionId, false), signal,
      fingerprint: { allow: prepared.fingerprint.allow.path, deny: prepared.fingerprint.deny.path } })
    session = new ClaudeControlSession(transport.input, transport.output, sessionId, { expectedModel: request.model })
    const closeOnAbort = () => { void transport?.close().catch(() => {}) }
    signal.addEventListener('abort', closeOnAbort, { once: true })
    try {
      await session.initialize(); signal.throwIfAborted()
      await session.sendUser({ messageId: randomUUID(), content: request.prompt })
      while (true) {
        signal.throwIfAborted()
        const event = await session.nextEvent(200)
        const result = event && claudeResult(event)
        if (!result) continue
        if (result.kind !== 'success' || session.model !== request.model) throw Error('delegated Claude did not complete with the requested model')
        return result.text
      }
    } finally { signal.removeEventListener('abort', closeOnAbort) }
  } finally {
    try { await session?.endInput() } catch {}
    try { await transport?.close() } catch { throw new DelegationCleanupPendingError() }
    await session?.close()
    prepared.retire()
  }
}

class DelegationCleanupPendingError extends Error {}

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
      saved.status = 'interrupted'; atomicWritePrivateFile(this.path(id), JSON.stringify(saved))
    }
    return saved
  }
  start(request: Request): Result {
    if (this.closing || !/^[a-zA-Z0-9_-]{1,80}$/.test(request.key)
      || !/^claude-opus-[a-zA-Z0-9.-]{1,60}$/.test(request.model)
      || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 96 * 1024) throw Error('invalid delegation request')
    const id = createHash('sha256').update(JSON.stringify([this.context.job.id, request.key])).digest('hex')
    const path = this.path(id)
    const digest = createHash('sha256').update(JSON.stringify([request.model, request.prompt])).digest('hex')
    const saved = readOptionalBoundedOwnerOnlyRegularFile(path, 256 * 1024)
    if (saved) {
      if (JSON.parse(saved).digest !== digest) throw Error('delegation key already used for another request')
      return this.poll(id)
    }
    const root = dirname(path), poisonPath = join(root, 'cleanup.json'), activePath = join(root, 'active.json')
    const assertPreviousChildRetired = () => {
      for (const pointer of [activePath, poisonPath]) {
        const raw = readOptionalBoundedOwnerOnlyRegularFile(pointer, 8192)
        if (!raw) continue
        const blockedId = JSON.parse(raw).id
        if (!/^[a-f0-9]{64}$/.test(blockedId)) throw Error('invalid child execution record')
        if (readOptionalBoundedOwnerOnlyRegularFile(join(this.context.stateDir, 'claude-panes', `delegate-${blockedId}.json`), 64 * 1024)) throw Error('owned Claude cleanup is pending')
      }
      if (this.cleanupFailure) throw Error('owned Claude cleanup is pending')
    }
    assertPreviousChildRetired()
    if (this.pending.size) throw Error('finish the existing delegated worker before starting another')
    const lockPath = join(dirname(path), 'worker.lock')
    const attempt = tryAcquireProcessLock(lockPath)
    if (!attempt.acquired) throw Error('delegation already owned by another broker')
    // Recheck after acquiring: a prior broker may have written its final
    // cleanup record between the preflight and acquisition of the job-wide lease.
    try { assertPreviousChildRetired() } catch (error) { releaseProcessLock(lockPath, attempt.lease); throw error }
    // Recheck under the job-wide lock, then durably claim BEFORE launching.
    if (readOptionalBoundedOwnerOnlyRegularFile(path, 256 * 1024)) {
      releaseProcessLock(lockPath, attempt.lease); return this.start(request)
    }
    const result: Result = { id, model: request.model, status: 'running' }
    const owner = readProcessIdentity(process.pid)
    if (!owner) { releaseProcessLock(lockPath, attempt.lease); throw Error('broker owner unavailable') }
    const save = () => atomicWritePrivateFile(path, JSON.stringify({ ...result, digest, owner }))
    try { save(); atomicWritePrivateFile(activePath, JSON.stringify({ id })) } catch (error) {
      result.status = 'interrupted'
      this.settled.set(id, { ...result, digest, owner })
      try { save() } catch {}
      releaseProcessLock(lockPath, attempt.lease); throw error
    }
    const controller = new AbortController()
    const done = Promise.resolve().then(async () => {
      try {
        const text = await this.run(this.context, id, request, controller.signal)
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
        if (error instanceof DelegationCleanupPendingError) this.cleanupFailure = error
        result.status = controller.signal.aborted ? 'cancelled' : 'failed'
      }
      finally {
        this.settled.set(id, { ...result, digest, owner })
        try {
          if (readOptionalBoundedOwnerOnlyRegularFile(join(this.context.stateDir, 'claude-panes', `delegate-${id}.json`), 64 * 1024)) {
            atomicWritePrivateFile(poisonPath, JSON.stringify({ id })); this.cleanupFailure ??= new DelegationCleanupPendingError()
          }
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
    catch { return { ...reply({ status: 'unavailable', reason: 'Claude delegation could not be verified. Preserve the original request; do not substitute another model or repeat a delivered request.' }), isError: true } }
  }
  server.registerTool('claude_delegate_start', { description: 'Explicit user-requested Claude delegation in a fresh owned Herdr tab. Codex stays primary. Use exact native model ID (e.g. claude-opus-5-5), stable key and subtask prompt; no model fallback. Child inherits the parent project write authorization and sandbox, with independent goal/session. Not the fixed Fable advisor. Returns immediately; poll the same id, never restart on a delayed response. Parent owns approval, integration, review and publication.',
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
