import { afterEach, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProcessLockLease } from './process-lock.ts'
import { prepareManagedStateRoot, ensureManagedDirectory } from './managed-path.ts'
import type { ReproductionContext } from './codex-reproduction-broker.ts'

// Protocol tests control execution and lock ownership without OS process probes.
// Real locking/cancellation remains covered by codex-reproduction-broker.test.ts.
function syntheticLocks() {
  const leases = new Map<string, ProcessLockLease>()
  return {
    acquire(path: string) {
      if (leases.has(path)) return { acquired: false as const, kind: 'held' as const, pid: process.pid }
      const lease: ProcessLockLease = { version: 2, pid: process.pid, nonce: 'synthetic', started: 'fixture', canonicalStarted: 'fixture', device: 1, inode: 1 }
      leases.set(path, lease)
      return { acquired: true as const, lease }
    },
    release(path: string, lease: ProcessLockLease) {
      if (leases.get(path) === lease) leases.delete(path)
      return true
    },
  }
}
import { CodexReproductions, createReproductionServer } from './codex-reproduction-broker.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-reproduction-test-'))); roots.push(root)
  const stateDir = prepareManagedStateRoot(join(root, 'state'))
  const repo = join(root, 'repo'); mkdirSync(repo)
  const id = 'job', scratchDir = ensureManagedDirectory(stateDir, join(stateDir, 'tmp', id)), artifactDir = ensureManagedDirectory(stateDir, join(stateDir, 'outbox', id)), liveInputDir = ensureManagedDirectory(stateDir, join(stateDir, 'live-input', id))
  const context = { version: 1, stateDir, scratchDir, artifactDir, liveInputDir, fingerprintAllowPath: '', job: { id, repoPath: repo, writeEnabled: true, attachments: [] } } as ReproductionContext
  const request = join(scratchDir, 'prompt.txt'); writeFileSync(request, 'Exact original request.\n', { mode: 0o600 })
  return { context, request, workspace: scratchDir }
}

function controlledRun() {
  const f = fixture()
  let finish!: () => void, final = '', starts = 0, signal: AbortSignal | undefined
  const released = new Promise<void>(resolve => { finish = resolve })
  const runs = new CodexReproductions(f.context,
    async (_ctx, _cwd, path) => { final = path; return { argv: ['fake'], environment: {} } },
    async (_argv, options) => {
      starts++
      expect(options.timeoutMs).toBeUndefined()
      signal = options.signal
      await new Promise<void>(resolve => {
        const cancelled = () => resolve()
        signal?.addEventListener('abort', cancelled, { once: true })
        if (signal?.aborted) cancelled()
        void released.then(() => { signal?.removeEventListener('abort', cancelled); resolve() })
      })
      writeFileSync(final, 'completed synthetic work', { mode: 0o600 })
      return { exitCode: 0, stdout: '{"type":"thread.started"}', stderr: '', timedOut: false, forcedCleanup: false, outputTruncated: false }
    }, syntheticLocks())
  return { ...f, runs, finish, starts: () => starts, signal: () => signal }
}

test('MCP startは完了を待たず返り、poll待機後も時間上限なしで同一実行を継続する', async () => {
  const f = controlledRun(), server = createReproductionServer(f.runs)
  const client = new Client({ name: 'reproduction-test', version: '1' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(right); await client.connect(left)
    const response = await client.callTool({ name: 'codex_reproduction_start', arguments: { requestPath: f.request, workspace: f.workspace } }, undefined, { timeout: 1000 })
    const started = JSON.parse((response.content as any[])[0].text)
    expect(started.status).toBe('running')
    for (let i = 0; i < 3; i++) expect((await f.runs.waitForResult(started.id, 1)).status).toBe('running')
    expect(f.signal()?.aborted).toBe(false)
    expect(f.runs.start(f.request, f.workspace).id).toBe(started.id)
    expect(f.starts()).toBe(1)
    const completion = client.callTool({ name: 'codex_reproduction_poll', arguments: { id: started.id } }, undefined, { timeout: 1000 })
    f.finish()
    const completed = JSON.parse(((await completion).content as any[])[0].text)
    expect(completed.status).toBe('completed')
    expect(JSON.parse(readFileSync(completed.receiptPath, 'utf8')).comparisonVerified).toBe(false)
  } finally { f.finish(); await f.runs.close(); await client.close(); await server.close() }
})

test('poll RPC取消は実行を停止せず、broker closeだけが実行を中止する', async () => {
  const f = controlledRun()
  const started = f.runs.start(f.request, f.workspace)
  try {
    const request = new AbortController()
    const pending = f.runs.waitForResult(started.id, 20_000, request.signal)
    request.abort()
    expect((await pending).status).toBe('running')
    expect(f.signal()?.aborted).toBe(false)
    await f.runs.close()
    expect(f.signal()?.aborted).toBe(true)
    expect(f.runs.poll(started.id).status).toBe('interrupted')
  } finally { f.finish(); await f.runs.close() }
})

test('MCP要求がtimeoutしても同じIDの再pollで元の実行結果を取得する', async () => {
  const f = controlledRun(), server = createReproductionServer(f.runs)
  const client = new Client({ name: 'timeout-recovery-test', version: '1' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(right); await client.connect(left)
    const response = await client.callTool({ name: 'codex_reproduction_start', arguments: { requestPath: f.request, workspace: f.workspace } })
    const started = JSON.parse((response.content as any[])[0].text)
    await expect(client.callTool(
      { name: 'codex_reproduction_poll', arguments: { id: started.id } },
      undefined, { timeout: 20 },
    )).rejects.toThrow('Request timed out')
    expect(f.runs.poll(started.id).status).toBe('running')
    expect(f.signal()?.aborted).toBe(false)
    f.finish()
    const recovered = await client.callTool({ name: 'codex_reproduction_poll', arguments: { id: started.id } })
    expect(JSON.parse((recovered.content as any[])[0].text).status).toBe('completed')
    expect(f.starts()).toBe(1)
  } finally { f.finish(); await f.runs.close(); await client.close(); await server.close() }
})

test('最終journal保存失敗を永久runningとしてpollしない', async () => {
  const f = fixture(); let final = ''
  const runs = new CodexReproductions(f.context,
    async (_ctx, _cwd, path) => { final = path; return { argv: ['fake'], environment: {} } },
    async () => {
      writeFileSync(final, 'finished', { mode: 0o600 })
      const journal = join(final, '..', 'result.json')
      rmSync(journal); mkdirSync(journal)
      return { exitCode: 0, stdout: '{"type":"thread.started"}', stderr: '', timedOut: false, forcedCleanup: false, outputTruncated: false }
    }, syntheticLocks())
  const started = runs.start(f.request, f.workspace)
  await expect(runs.settled()).rejects.toThrow()
  await expect(runs.waitForResult(started.id, 1)).rejects.toThrow()
  await expect(runs.close()).rejects.toThrow()
})

test('非同期の子孫残存をMCP pollでも封じ込め失敗として返す', async () => {
  const { AdvisorOwnedProcessStillLiveError } = await import('./advisor-broker.ts')
  const f = fixture()
  const runs = new CodexReproductions(f.context,
    async () => ({ argv: ['fake'], environment: {} }),
    async () => { throw new AdvisorOwnedProcessStillLiveError('synthetic owned process') },
    syntheticLocks())
  const server = createReproductionServer(runs)
  const client = new Client({ name: 'containment-test', version: '1' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(right); await client.connect(left)
    const started = runs.start(f.request, f.workspace)
    await expect(runs.settled()).rejects.toBeInstanceOf(AdvisorOwnedProcessStillLiveError)
    const response = await client.callTool({ name: 'codex_reproduction_poll', arguments: { id: started.id } })
    expect(response.isError).toBe(true)
    expect(JSON.parse((response.content as any[])[0].text).status).toBe('containment_failed')
    expect(JSON.parse(readFileSync(started.receiptPath, 'utf8')).status).toBe('containment_failed')
  } finally {
    await expect(runs.close()).rejects.toBeInstanceOf(AdvisorOwnedProcessStillLiveError)
    await client.close(); await server.close()
  }
})
