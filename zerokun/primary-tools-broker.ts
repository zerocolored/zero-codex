#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { dirname, isAbsolute, join, resolve } from 'path'
import { lstatSync, realpathSync } from 'fs'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { verifyOfficialCodexSnapshot, type OfficialCodexSnapshot } from './standalone-codex.ts'
import { buildCodexChildEnvironment } from './codex-executor.ts'
import { captureTrackedProcesses, reapTrackedProcesses } from './process-tree.ts'
import { readProcessIdentity, type ProcessIdentity } from './process-generation.ts'
import { taskGoalObjective, type NativeGoal } from './codex-goal.ts'

/** Claude supplies decisions and tool inputs. Codex's existing permission
 * engine executes commands; it performs no model turn or task planning here. */
export interface PrimaryToolsContext {
  version: 1
  jobId: string
  cwd: string
  stateDir: string
  goalPath: string
  profile: string
  permissionOverrides: string[]
  codex: OfficialCodexSnapshot
  shellEnvironment: Record<string, string>
  fingerprintDenyPath?: string
  allowGoalUpdate?: boolean
}

interface Execution {
  id: string
  process: ReturnType<typeof spawnCommand>
  identity: ProcessIdentity
  tracked: Map<number, string>
  buffer: string
  truncated: boolean
  readerFailure?: string
  exitCode: number | null
  done: Promise<void>
  stopTracking: ReturnType<typeof setInterval>
}

function spawnCommand(context: PrimaryToolsContext, argv: string[], cwd: string) {
  verifyOfficialCodexSnapshot(context.codex)
  let overrides = context.permissionOverrides
  if (context.fingerprintDenyPath) {
    // Codex's -c dotted-key parser does not preserve quoted dots inside path
    // keys. Replace the inline filesystem table, whose TOML keys are parsed.
    const parsed = Bun.TOML.parse(overrides.join('\n')) as {
      permissions: Record<string, { filesystem: Record<string, string> }>
    }
    const rules = { ...parsed.permissions[context.profile]!.filesystem, [context.fingerprintDenyPath]: 'deny' }
    const prefix = `permissions.${context.profile}.filesystem=`
    overrides = overrides.map(value => value.startsWith(prefix)
      ? prefix + '{' + Object.entries(rules).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(',') + '}'
      : value)
  }
  return Bun.spawn([context.codex.physical, 'sandbox', '-C', cwd,
    ...overrides.flatMap(value => ['-c', value]),
    '-P', context.profile, '--', ...argv], {
    cwd, env: { ...buildCodexChildEnvironment(), ...context.shellEnvironment },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true,
  })
}

export class PrimaryToolRuntime {
  private executions = new Map<string, Execution>()
  private closing = false
  constructor(readonly context: PrimaryToolsContext) {}

  async execute(input: { command: string; cwd?: string; yieldMs?: number }) {
    return this.startCommand(['/bin/zsh', '-c', input.command], input.cwd, input.yieldMs)
  }

  private async startCommand(argv: string[], directory?: string, yieldMs?: number, outputLimit = 2 * 1024 * 1024, includeStderr = true) {
    if (this.closing) throw new Error('primary tool runtime is closing')
    if (this.executions.size >= 64) throw new Error('too many live command sessions; finish or stop an existing session')
    const cwd = directory ? realpathSync(directory) : this.context.cwd
    if (!isAbsolute(cwd)) throw new Error('command directory must be absolute')
    const process = spawnCommand(this.context, argv, cwd)
    const identity = readProcessIdentity(process.pid)
    if (!identity) { process.kill('SIGTERM'); await process.exited; throw new Error('command process identity unavailable') }
    const tracked = new Map([[identity.pid, identity.started]])
    const id = randomUUID()
    const execution: Execution = { id, process, identity, tracked, buffer: '', truncated: false, exitCode: null,
      done: Promise.resolve(), stopTracking: setInterval(() => {
        try { captureTrackedProcesses([identity.pid], identity.pgid, tracked) }
        catch { execution.readerFailure = 'command descendant tracking failed'; void this.stop(id) }
      }, 100) }
    this.executions.set(id, execution)
    const read = async (stream: ReadableStream<Uint8Array>, capture = true) => {
      const decoder = new TextDecoder()
      const reader = stream.getReader()
      const append = (text: string) => {
        if (!capture) return
        const available = Math.max(0, outputLimit - execution.buffer.length)
        execution.buffer += text.slice(0, available)
        if (text.length > available) execution.truncated = true
      }
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          append(decoder.decode(next.value, { stream: true }))
        }
        append(decoder.decode())
      } finally { reader.releaseLock() }
    }
    execution.done = (async () => {
      const streams = Promise.all([read(process.stdout), read(process.stderr, includeStderr)])
      const code = await process.exited
      await streams
      execution.exitCode = code
    })().catch(() => { execution.readerFailure = 'command output transport failed' })
    return await this.poll({ id, yieldMs })
  }

  async viewImage(path: string) {
    // The host must not read the path itself: the exact same permission engine
    // as shell tools resolves symlinks and enforces private-state denials.
    const result = await this.startCommand(['/usr/bin/base64', '-i', resolve(this.context.cwd, path)], undefined, 10_000, 12 * 1024 * 1024, false)
    if (result.sessionId) {
      await this.stop(result.sessionId)
      throw new Error('image read timed out')
    }
    if (result.exitCode !== 0 || result.truncated) throw new Error('image is inaccessible or exceeds the 5 MiB limit')
    const encoded = result.output.replace(/\s/g, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('invalid image output')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length > 5 * 1024 * 1024 || bytes.toString('base64') !== encoded) throw new Error('invalid or oversized image')
    const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) ? 'image/gif'
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : null
    if (!mimeType) throw new Error('supported image formats are PNG, JPEG, GIF and WebP')
    return { content: [{ type: 'image' as const, data: encoded, mimeType }] }
  }

  reportProgress(text: string) {
    if (this.context.allowGoalUpdate === false) throw new Error('Task progress cannot be changed during a read-only interjection')
    atomicWritePrivateFile(this.context.goalPath + '.progress', JSON.stringify({ text, updatedAt: Date.now() }))
    return { recorded: true }
  }

  async poll(input: { id: string; input?: string; yieldMs?: number }) {
    const execution = this.executions.get(input.id)
    if (!execution) throw new Error('unknown command session')
    if (input.input !== undefined) {
      if (execution.exitCode !== null) throw new Error('command already exited')
      await execution.process.stdin.write(input.input)
    }
    await Promise.race([execution.done, Bun.sleep(Math.min(30_000, Math.max(0, input.yieldMs ?? 1_000)))])
    const output = execution.buffer
    const truncated = execution.truncated
    execution.buffer = ''; execution.truncated = false
    if (execution.readerFailure) throw new Error(execution.readerFailure)
    if (execution.exitCode !== null) {
      const remaining = await reapTrackedProcesses({ rootPids: [execution.identity.pid], groupId: execution.identity.pgid,
        tracked: execution.tracked, termGraceMs: 1_000 })
      if (remaining.length) throw new Error('command descendant cleanup pending')
      clearInterval(execution.stopTracking)
      this.executions.delete(input.id)
    }
    return { sessionId: execution.exitCode === null ? input.id : null, exitCode: execution.exitCode, output, truncated }
  }

  async stop(id: string): Promise<void> {
    const execution = this.executions.get(id)
    if (!execution) return
    clearInterval(execution.stopTracking)
    const remaining = await reapTrackedProcesses({ rootPids: [execution.identity.pid], groupId: execution.identity.pgid,
      tracked: execution.tracked, termGraceMs: 1_000 })
    if (remaining.length) throw new Error('command cleanup pending')
    await execution.done
    this.executions.delete(id)
  }

  async close(): Promise<void> {
    this.closing = true
    const results = await Promise.allSettled([...this.executions.keys()].map(id => this.stop(id)))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  readGoal(): NativeGoal {
    const text = readOptionalBoundedOwnerOnlyRegularFile(this.context.goalPath, 32 * 1024)
    const value = text ? JSON.parse(text) : { objective: taskGoalObjective(this.context.jobId), status: 'active' }
    if (typeof value.objective !== 'string' || !['active', 'paused', 'blocked', 'complete'].includes(value.status)) {
      throw new Error('invalid primary goal record')
    }
    return value
  }

  updateGoal(status: 'active' | 'paused' | 'blocked' | 'complete', explanation: string): NativeGoal {
    if (this.context.allowGoalUpdate === false) throw new Error('The primary task goal cannot be changed during a read-only interjection')
    const current = this.readGoal()
    const next = { ...current, status, explanation, updatedAt: Date.now() }
    atomicWritePrivateFile(this.context.goalPath, JSON.stringify(next))
    return next
  }
}

const textResult = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
export function registerPrimaryTools(server: McpServer, runtime: PrimaryToolRuntime): void {
  const guarded = <T>(action: (input: T) => Promise<unknown> | unknown) => async (input: T) => {
    try { return textResult(await action(input)) }
    catch (error) { return { ...textResult({ error: error instanceof Error ? error.message : 'primary tool failed' }), isError: true } }
  }
  server.registerTool('execute', {
    description: 'Run a shell command in the current task permission sandbox. Use rg/read commands for investigation and normal project tools for edits/tests. Returns a sessionId if still running; poll that exact session, never repeat an unconfirmed command. No automatic permission escalation. cwd defaults to the project.',
    inputSchema: { command: z.string().min(1).max(128 * 1024), cwd: z.string().max(4096).optional(), yieldMs: z.number().int().min(0).max(30_000).optional() },
  }, guarded(input => runtime.execute(input)))
  server.registerTool('wait_command', {
    description: 'Read new output from a command session, optionally writing stdin. No total task deadline. Omit input for a read-only poll. A sessionId of null means the command and its descendants have exited.',
    inputSchema: { id: z.string().uuid(), input: z.string().max(128 * 1024).optional(), yieldMs: z.number().int().min(0).max(30_000).optional() },
  }, guarded(input => runtime.poll(input)))
  server.registerTool('stop_command', {
    description: 'Stop one command session and reap only its recorded process generations.',
    inputSchema: { id: z.string().uuid() },
  }, guarded(async input => { await runtime.stop(input.id); return { stopped: true } }))
  server.registerTool('view_image', {
    description: 'View a local PNG, JPEG, GIF or WebP (up to 5 MiB), including task attachments and generated screenshots. Uses the task permission sandbox.',
    inputSchema: { path: z.string().min(1).max(4096) },
  }, async ({ path }) => {
    try { return await runtime.viewImage(path) }
    catch (error) { return { ...textResult({ error: error instanceof Error ? error.message : 'image read failed' }), isError: true } }
  })
  server.registerTool('report_progress', {
    description: 'Record a concise Japanese progress update: observed results, current work and next step. Refresh at meaningful phase changes and while polling long commands. The host publishes at its normal cadence. Do not include secrets or claim unobserved results.',
    inputSchema: { text: z.string().min(1).max(3000) },
  }, guarded(({ text }) => runtime.reportProgress(text)))
  server.registerTool('get_goal', { description: 'Read this task goal and its durable status.', inputSchema: {} }, guarded(() => runtime.readGoal()))
  server.registerTool('update_goal', {
    description: 'Update this task goal. Complete only after all requested work, checks and delivery are finished. paused requires an explicit user pause; blocked requires a real external dependency or required user judgment. A partial progress report is not completion. Keep active when actionable work remains.',
    inputSchema: { status: z.enum(['active', 'paused', 'blocked', 'complete']), explanation: z.string().min(1).max(8192) },
  }, guarded(input => runtime.updateGoal(input.status, input.explanation)))
}

export function readPrimaryToolsContext(path: string): PrimaryToolsContext {
  const parent = lstatSync(dirname(path))
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new Error('unsafe primary tools context directory')
  const text = readOptionalBoundedOwnerOnlyRegularFile(path, 512 * 1024)
  const context = text ? JSON.parse(text) as PrimaryToolsContext : null
  if (!context || context.version !== 1 || !/^[A-Za-z0-9._-]+$/.test(context.jobId)
    || !isAbsolute(context.cwd) || realpathSync(context.cwd) !== context.cwd
    || !isAbsolute(context.stateDir) || context.goalPath !== join(dirname(path), 'goal.json')
    || !/^[A-Za-z0-9_]+$/.test(context.profile) || !Array.isArray(context.permissionOverrides)
    || context.permissionOverrides.some(value => typeof value !== 'string')
    || !context.shellEnvironment || typeof context.shellEnvironment !== 'object') throw new Error('invalid primary tools context')
  verifyOfficialCodexSnapshot(context.codex)
  return context
}

if (import.meta.main) {
  const runtime = new PrimaryToolRuntime(readPrimaryToolsContext(process.argv[2] ?? ''))
  const server = new McpServer({ name: 'zerochan-primary-tools', version: '1.0.0' })
  registerPrimaryTools(server, runtime)
  let closing: Promise<void> | undefined
  const close = () => closing ??= runtime.close().then(() => server.close()).finally(() => { process.exitCode = 0 })
  process.on('SIGTERM', () => { void close() }); process.on('SIGINT', () => { void close() })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  server.server.onclose = () => { void close() }
}
