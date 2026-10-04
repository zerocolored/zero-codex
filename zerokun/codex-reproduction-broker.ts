#!/usr/bin/env -S bun --config=/dev/null --no-env-file
import { createHash } from 'crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { lstatSync, realpathSync } from 'fs'
import { Database } from 'bun:sqlite'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile, readOptionalBoundedAtomicOwnedFile } from './safe-file.ts'
import { ensureManagedDirectory, requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { buildCodexChildEnvironment, buildCodexPermissionOverrides, buildCodexTrustArguments, resolveEffectiveCodexPermissionOverrides, CodexOwnedProcessStillLiveError } from './codex-executor.ts'
import { resolveOfficialStandaloneCodex, verifyOfficialCodexSnapshot } from './standalone-codex.ts'
import { ensureJobTempDirectory } from './job-temp.ts'
import { resolveZeroJobDatabasePath } from './state-dir.ts'
import { containsCredentialMaterial } from './public-output-guard.ts'
import { delegateProcessLock, undelegateProcessLock, releaseProcessLock, tryAcquireProcessLock, type ProcessLockDelegate } from './process-lock.ts'
import { runBounded, AdvisorOwnedProcessStillLiveError } from './advisor-broker.ts'
import type { JobRecord } from './job-runner.ts'
import { recoverPreviousReproduction } from './reproduction-recovery.ts'

export type ReproductionContext = {
  version: 1; job: JobRecord; stateDir: string; artifactDir: string; scratchDir: string;
  liveInputDir: string; fingerprintAllowPath: string
}
export type RunResult = {
  id: string; status: 'running' | 'completed' | 'failed' | 'interrupted' | 'containment_failed';
  promptSha256: string; workspace: string; finalPath: string; receiptPath: string;
  exitCode?: number; eventBytes?: number; diagnosticsTruncated?: boolean; reason?: string
  recovery?: { sourceJob: number; manifestPath: string; copiedFiles: number; unavailable: number; excluded: number; finalAvailable: boolean }
}
type Runner = (argv: string[], options: Parameters<typeof runBounded>[1]) => ReturnType<typeof runBounded>

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

/** Paths select only this job's existing work files, never host argv/config/env. */
export function reproductionRequest(context: ReproductionContext, requestPath: string, workspace: string) {
  const cwd = requireManagedDirectory(context.stateDir, workspace)
  if (!within(context.scratchDir, cwd)) throw new Error('workspace must be inside this job scratch')
  const path = resolve(requestPath)
  requireManagedDirectory(context.stateDir, dirname(path))
  if (![context.scratchDir, context.artifactDir].some(root => within(root, path))) throw new Error('request must belong to this job')
  const bytes = readOptionalBoundedAtomicOwnedFile(path, 256 * 1024, 'reproduction request')
  if (!bytes?.length || bytes.includes(0)) throw new Error('empty or invalid reproduction request')
  const prompt = bytes.toString('utf8')
  if (!Buffer.from(prompt).equals(bytes) || containsCredentialMaterial(prompt)) throw new Error('unsafe reproduction request')
  const promptSha256 = createHash('sha256').update(bytes).digest('hex')
  const id = createHash('sha256').update(JSON.stringify([context.job.id, cwd, promptSha256])).digest('hex')
  return { cwd, bytes, promptSha256, id }
}

export async function reproductionCommand(context: ReproductionContext, cwd: string, finalPath: string, signal: AbortSignal) {
  const official = resolveOfficialStandaloneCodex()
  const profile = `zero_reproduction_${createHash('sha256').update(context.job.id).digest('hex').slice(0, 24)}`
  // Auth stays in the host CLI. Model tools remain unable to read auth/state,
  // write the project, publish, or operate external services.
  const job = { ...context.job, writeEnabled: false }
  const overrides = buildCodexPermissionOverrides(job, {
    stateDir: context.stateDir, artifactDir: context.artifactDir, scratchDir: context.scratchDir,
    liveInputDir: context.liveInputDir, jobTempDir: ensureJobTempDirectory(context.stateDir, job.id),
    profile, executionWriteEnabled: false, browserAccessEnabled: false, localVerificationEnabled: true,
    multiAgentEnabled: false, nativeCloudAccessEnabled: false, computerUseEnabled: false,
    seatbeltFingerprintAllowPath: context.fingerprintAllowPath,
  })
  const environment = buildCodexChildEnvironment()
  const effective = await resolveEffectiveCodexPermissionOverrides(official.physical, cwd, overrides, profile, environment, { signal, inheritProcessGroup: true })
  verifyOfficialCodexSnapshot(official)
  return { argv: [official.physical, ...buildCodexTrustArguments(), '-C', cwd,
    ...effective.flatMap(value => ['-c', value]),
    'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--color', 'never', '--json', '--output-last-message', finalPath, '-'], environment }
}

export class CodexReproductions {
  private controller = new AbortController()
  private pending = new Map<string, Promise<void>>()
  private failedRuns = new Map<string, unknown>()
  private recoveredRuns = new Map<string, RunResult>()
  private closed = false
  private containmentFailure: Error | undefined
  private transportFailure: unknown
  constructor(
    readonly context: ReproductionContext,
    private command = reproductionCommand,
    private run: Runner = runBounded,
    private lock = { acquire: tryAcquireProcessLock, release: releaseProcessLock },
  ) {}
  private containmentGuard(): string {
    const root = ensureManagedDirectory(this.context.stateDir, join(this.context.stateDir, 'reproductions', this.context.job.id))
    // One outer executor fingerprint spans MCP reconnects. A fresh fingerprint
    // is issued only after the prior executor's owned cleanup has completed.
    const attempt = createHash('sha256').update(this.context.fingerprintAllowPath).digest('hex')
    return join(root, `containment-${attempt}.json`)
  }
  private directory(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid reproduction id')
    return ensureManagedDirectory(this.context.stateDir, join(this.context.stateDir, 'reproductions', this.context.job.id, id))
  }
  poll(id: string): RunResult {
    if (this.containmentFailure) throw this.containmentFailure
    if (this.failedRuns.has(id)) throw this.failedRuns.get(id)
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid reproduction id')
    if (this.recoveredRuns.has(id)) return this.recoveredRuns.get(id)!
    const directory = join(this.context.stateDir, 'reproductions', this.context.job.id, id)
    let value: string | null = null
    try {
      requireManagedDirectory(this.context.stateDir, directory)
      value = readOptionalBoundedOwnerOnlyRegularFile(join(directory, 'result.json'), 16_384)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (value) {
      const result = JSON.parse(value) as RunResult
      if (result.status !== 'running' || this.pending.has(id)) return result
    }
    const recovered = recoverPreviousReproduction(this.context, id, value !== null)
    if (recovered.status !== 'running') this.recoveredRuns.set(id, recovered)
    return recovered
  }
  /** A bounded RPC wait never sets a deadline on the owned execution. */
  async waitForResult(id: string, waitMs = 20_000, signal?: AbortSignal): Promise<RunResult> {
    const current = this.poll(id)
    if (current.status !== 'running' || signal?.aborted) return current
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled!: () => void
    const abort = new Promise<void>(resolve => { cancelled = resolve })
    signal?.addEventListener('abort', cancelled, { once: true })
    if (signal?.aborted) cancelled()
    try {
      await Promise.race([
        new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs) }),
        ...(this.pending.has(id) ? [this.pending.get(id)!.catch(() => {})] : []),
        abort,
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', cancelled)
    }
    return this.poll(id)
  }
  start(requestPath: string, workspace: string): RunResult {
    if (this.containmentFailure) throw this.containmentFailure
    if (readOptionalBoundedOwnerOnlyRegularFile(this.containmentGuard(), 1024)) throw new AdvisorOwnedProcessStillLiveError('This executor attempt requires host containment before another execution')
    if (this.closed) throw new Error('reproduction broker is closing')
    const request = reproductionRequest(this.context, requestPath, workspace)
    if (this.pending.has(request.id)) return this.poll(request.id)
    const directory = this.directory(request.id), journal = join(directory, 'result.json')
    // An existing request is never an implicit retry. Poll reconciles both
    // same-job reconnects and retained runs without launching a second child.
    if (readOptionalBoundedOwnerOnlyRegularFile(journal, 16_384)) return this.poll(request.id)
    const lockPath = join(directory, 'process.lock')
    const lease = this.lock.acquire(lockPath)
    if (!lease.acquired) return this.poll(request.id)
    try {
    const existing = readOptionalBoundedOwnerOnlyRegularFile(journal, 16_384)
    if (existing) {
      this.lock.release(lockPath, lease.lease)
      return this.poll(request.id)
    }
    const output = ensureManagedDirectory(this.context.stateDir, join(this.context.liveInputDir, 'codex-reproduction', request.id))
    const result: RunResult = { id: request.id, status: 'running', promptSha256: request.promptSha256,
      workspace: request.cwd, finalPath: join(output, 'final.txt'), receiptPath: join(output, 'execution.json') }
    atomicWritePrivateFile(join(directory, 'request.txt'), request.bytes)
    atomicWritePrivateFile(journal, JSON.stringify(result))
    const work = (async () => {
      let delegate: ProcessLockDelegate | undefined
      try {
        const hostFinalPath = join(directory, 'final.txt')
        const { argv, environment } = await this.command(this.context, request.cwd, hostFinalPath, this.controller.signal)
        const ran = await this.run(argv, { cwd: request.cwd, env: environment, stdin: request.bytes,
          signal: this.controller.signal, onSpawn: pid => {
            delegate = delegateProcessLock(lockPath, lease.lease, pid)
            if (!delegate) throw new Error('independent execution ownership could not be persisted')
          } })
        if (delegate && !undelegateProcessLock(lockPath, delegate)) {
          throw new Error('independent execution ownership could not be released')
        }
        delegate = undefined
        result.exitCode = ran.exitCode; result.eventBytes = Buffer.byteLength(ran.stdout)
        result.diagnosticsTruncated = ran.outputTruncated
        // Private diagnostics are not copied into model-readable artifacts.
        atomicWritePrivateFile(join(directory, 'events.jsonl'), ran.stdout)
        atomicWritePrivateFile(join(directory, 'stderr.txt'), ran.stderr)
        const final = readOptionalBoundedAtomicOwnedFile(hostFinalPath, 2 * 1024 * 1024, 'reproduction final')
        if (final) atomicWritePrivateFile(result.finalPath, final)
        const started = ran.stdout.split('\n').some(line => {
          try { return JSON.parse(line).type === 'thread.started' } catch { return false }
        })
        result.status = this.controller.signal.aborted ? 'interrupted'
          : ran.exitCode === 0 && !ran.timedOut && !ran.forcedCleanup && started && final?.length ? 'completed' : 'failed'
        if (result.status !== 'completed') result.reason = 'Independent execution or output collection did not complete; outputs retained. Do not claim a verified comparison.'
      } catch (error) {
        if (error instanceof AdvisorOwnedProcessStillLiveError || error instanceof CodexOwnedProcessStillLiveError) {
          this.containmentFailure = new AdvisorOwnedProcessStillLiveError('Owned processes remain live; host containment required'); this.controller.abort(); this.closed = true
          result.status = 'containment_failed'
          result.reason = 'Owned processes remain live; host containment is required before continuing.'
          try { atomicWritePrivateFile(this.containmentGuard(), JSON.stringify({ status: 'owned-process-still-live' })) } catch {}
          // Containment state must survive diagnostic/filesystem failures.
          try { atomicWritePrivateFile(join(directory, 'startup-error.json'), JSON.stringify({ category: 'owned-process-still-live' })) } catch {}
          throw this.containmentFailure
        }
        try { atomicWritePrivateFile(join(directory, 'startup-error.json'), JSON.stringify({ category: error instanceof Error ? error.name : 'unknown' })) } catch {}
        result.status = this.controller.signal.aborted ? 'interrupted' : 'failed'
        result.reason = 'Independent execution could not complete; request and private diagnostics are retained.'
      } finally {
        try {
          atomicWritePrivateFile(journal, JSON.stringify(result))
          atomicWritePrivateFile(result.receiptPath, JSON.stringify({ ...result, comparisonVerified: false }))
        } finally {
          // Failed startup/transport also goes through runBounded cleanup.
          // A still-live delegate keeps the lease; never erase that evidence.
          if (!this.containmentFailure && (!delegate || undelegateProcessLock(lockPath, delegate))) {
            this.lock.release(lockPath, lease.lease)
          }
        }
      }
    })().catch(error => { this.transportFailure = error; this.failedRuns.set(request.id, error); throw error })
    this.pending.set(request.id, work)
    void work.finally(() => this.pending.delete(request.id)).catch(() => {})
    return { ...result }
    } catch (error) { this.lock.release(lockPath, lease.lease); throw error }
  }
  async settled() { await Promise.allSettled([...this.pending.values()]); if (this.containmentFailure) throw this.containmentFailure; if (this.transportFailure) throw this.transportFailure }
  async close() {
    this.closed = true; this.controller.abort()
    await this.settled()
  }
}

export function readReproductionContext(path: string, stateInput: string): ReproductionContext {
  const state = requireManagedStateRoot(stateInput)
  requireManagedDirectory(state, dirname(path))
  const raw = readOptionalBoundedOwnerOnlyRegularFile(path, 256 * 1024)
  if (!raw) throw new Error('missing reproduction context')
  const context = JSON.parse(raw) as ReproductionContext
  if (context.version !== 1 || context.stateDir !== state || !/^[A-Za-z0-9_-]+$/.test(context.job?.id ?? '')
    || context.job.writeEnabled !== true) throw new Error('invalid reproduction context')
  if (requireManagedDirectory(state, context.scratchDir) !== join(state, 'tmp', context.job.id)
    || requireManagedDirectory(state, context.artifactDir) !== join(state, 'outbox', context.job.id)
    || requireManagedDirectory(state, context.liveInputDir) !== join(state, 'live-input', context.job.id)) throw new Error('reproduction context scope mismatch')
  requireManagedDirectory(state, dirname(context.fingerprintAllowPath))
  const tag = lstatSync(context.fingerprintAllowPath)
  if (!tag.isFile() || tag.isSymbolicLink() || tag.nlink !== 1) throw new Error('invalid process fingerprint')
  context.job.repoPath = realpathSync(context.job.repoPath)
  return context
}

export function createReproductionServer(runs: CodexReproductions): McpServer {
  const server = new McpServer({ name: 'zerochan-codex-reproduction', version: '1.0.0' })
  const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
  server.registerTool('codex_reproduction_start', {
    description: 'Execute the user-requested independent Codex exec reproduction with the exact UTF-8 prompt file via stdin. Workspace must be inside current job scratch. Repository and retained inputs are read-only; write outputs in workspace. No host argv/config/env accepted. Start returns immediately. Poll the same id until terminal; running is not a failure or a reason to stop. There is no total execution deadline. Completed means execution only, not similarity validation. Never use as an additional advisor.',
    inputSchema: { requestPath: z.string().max(4096), workspace: z.string().max(4096) },
  }, async args => { try { return reply(runs.start(args.requestPath, args.workspace)) } catch (error) { if (error instanceof AdvisorOwnedProcessStillLiveError) return { ...reply({ status: 'containment_failed', reason: 'Owned process cleanup failed. Stop this execution and preserve host records.' }), isError: true }; return { ...reply({ status: 'rejected', reason: 'Use a nonsecret prompt and workspace owned by this job.' }), isError: true } } })
  server.registerTool('codex_reproduction_poll', { description: 'Wait up to 20 seconds for the same execution, including a previous job in this conversation and repository, without restarting or stopping it. Host-side process ownership checks also recover a lost broker in the same job; no shell ps diagnosis is needed. Repeat while running. A recovered terminal result provides a read-only workspace and recovery manifest in current inputs. Inspect those partial outputs and copy relevant files to current scratch to continue; interrupted is not verified success and must not cause a duplicate execution.', inputSchema: { id: z.string().regex(/^[a-f0-9]{64}$/) } },
    async (args, extra) => { try { return reply(await runs.waitForResult(args.id, 20_000, extra.signal)) } catch (error) { if (error instanceof AdvisorOwnedProcessStillLiveError) return { ...reply({ status: 'containment_failed', reason: 'Owned process cleanup failed. Stop this execution and preserve host records.' }), isError: true }; return { ...reply({ status: 'unavailable', reason: 'Execution state could not be verified; preserve host records and do not start another execution.' }), isError: true } } })
  return server
}

async function main() {
  const [path, state] = process.argv.slice(2)
  if (!path || !state || process.argv.length !== 4) throw new Error('invalid reproduction invocation')
  const context = readReproductionContext(path, state)
  const runs = new CodexReproductions(context)
  const server = createReproductionServer(runs)
  let stopping = false
  const close = async () => { if (stopping) return; stopping = true; clearInterval(cancelCheck); try { await runs.close() } catch { process.exitCode = 1; process.stderr.write('Codex reproduction owned process cleanup failed\n') } finally { await server.close() } }
  const db = new Database(resolveZeroJobDatabasePath(state), { readonly: true })
  const cancelCheck = setInterval(() => {
    try {
      const row = db.query<{ status: string; cancel_requested_at: number | null }, [string]>('SELECT status,cancel_requested_at FROM jobs WHERE id=?').get(context.job.id)
      if (!row || row.status !== 'running' || row.cancel_requested_at !== null) void close()
    } catch { /* Temporary observation failure does not invent cancellation. */ }
  }, 500)
  process.once('SIGTERM', () => { void close() }); process.once('SIGINT', () => { void close() })
  process.stdin.once('end', () => { void close() })
  server.server.onclose = () => { void close().finally(() => db.close()) }
  await server.connect(new StdioServerTransport())
}
if (import.meta.main) main().catch(() => { process.stderr.write('Codex reproduction broker failed to start\n'); process.exit(1) })
