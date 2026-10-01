import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CodexReproductions, createReproductionServer, type ReproductionContext } from './codex-reproduction-broker.ts'
import { ensureManagedDirectory, prepareManagedStateRoot } from './managed-path.ts'
import { releaseProcessLock, tryAcquireProcessLock } from './process-lock.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(status = 'running') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-recovery-'))); roots.push(root)
  const stateDir = prepareManagedStateRoot(join(root, 'state'))
  const dir = (...parts: string[]) => ensureManagedDirectory(stateDir, join(stateDir, ...parts))
  const context = { version: 1, stateDir, scratchDir: dir('tmp', 'current'), artifactDir: dir('outbox', 'current'),
    liveInputDir: dir('live-input', 'current'), fingerprintAllowPath: '',
    job: { id: 'current', seq: 109, chatId: 'chat', threadTs: 'thread', repoPath: '/repo', writeEnabled: true } } as ReproductionContext
  const db = new Database(join(stateDir, 'jobs.sqlite3'))
  db.exec('CREATE TABLE jobs(id TEXT,seq INTEGER,chat_id TEXT,thread_ts TEXT,repo_path TEXT,status TEXT)')
  db.run('INSERT INTO jobs VALUES(?,?,?,?,?,?)', ['prior', 105, 'chat', 'thread', '/repo', 'failed'])
  db.close()
  const workspace = dir('tmp', 'prior', 'run_a')
  const prompt = 'User requested exact independent PDF comparison.\n'
  const promptSha256 = createHash('sha256').update(prompt).digest('hex')
  const id = createHash('sha256').update(JSON.stringify(['prior', workspace, promptSha256])).digest('hex')
  const journal = dir('reproductions', 'prior', id)
  const result = { id, status, workspace, promptSha256, finalPath: '/not-trusted/final', receiptPath: '/not-trusted/receipt' }
  writeFileSync(join(journal, 'request.txt'), prompt, { mode: 0o600 })
  writeFileSync(join(journal, 'result.json'), JSON.stringify(result), { mode: 0o600 })
  writeFileSync(join(dir('tmp', 'prior', 'run_a', 'output'), 'partial.json'), '{"count":12}', { mode: 0o600 })
  writeFileSync(join(dir('tmp', 'prior', 'run_a', 'work'), 'continue.py'), 'print("continue")', { mode: 0o600 })
  let starts = 0
  const runs = new CodexReproductions(context, async () => { starts++; throw new Error('must not spawn') })
  return { root, context, dir, workspace, journal, id, result, runs, starts: () => starts,
    sql(sql: string) { const db = new Database(join(stateDir, 'jobs.sqlite3')); try { db.exec(sql) } finally { db.close() } } }
}

test('same conversation resume recovers stranded running record and partial workspace without another execution', async () => {
  const f = fixture(), original = readFileSync(join(f.journal, 'result.json'), 'utf8')
  const value = f.runs.poll(f.id)
  expect(value.status).toBe('interrupted')
  expect(value.recovery?.sourceJob).toBe(105)
  expect(value.workspace.startsWith(f.context.liveInputDir)).toBe(true)
  expect(readFileSync(join(value.workspace, 'output', 'partial.json'), 'utf8')).toBe('{"count":12}')
  expect(readFileSync(join(value.workspace, 'work', 'continue.py'), 'utf8')).toContain('continue')
  expect(value.recovery?.finalAvailable).toBe(false)
  expect(JSON.parse(readFileSync(value.receiptPath, 'utf8')).comparisonVerified).toBe(false)
  expect(readFileSync(join(f.journal, 'result.json'), 'utf8')).toBe(original)
  expect(f.runs.poll(f.id)).toEqual(value)
  expect(f.starts()).toBe(0)
  expect(existsSync(join(f.context.stateDir, 'reproductions', 'current', f.id))).toBe(false)
  await f.runs.close()
})

test.each([
  "UPDATE jobs SET chat_id='other'", "UPDATE jobs SET thread_ts='other'", "UPDATE jobs SET repo_path='/other'",
  'UPDATE jobs SET seq=110',
])('historical poll rejects outside durable scope: %s', sql => {
  const f = fixture(); f.sql(sql)
  expect(() => f.runs.poll(f.id)).toThrow('no authorized previous execution')
})

test('worktree continuation uses original history repository and preserves completed host final', () => {
  const f = fixture('completed')
  f.context.job.historyRepoPath = '/repo'; f.context.job.repoPath = '/repo-worktree'
  writeFileSync(join(f.journal, 'final.txt'), 'Completed independent extraction', { mode: 0o600 })
  const value = f.runs.poll(f.id)
  expect(value.status).toBe('completed')
  expect(value.recovery?.finalAvailable).toBe(true)
  expect(readFileSync(value.finalPath, 'utf8')).toBe('Completed independent extraction')
})

test('active owner is polled without copying mutable files, then terminal files become available', () => {
  const f = fixture(), lock = join(f.journal, 'process.lock'), acquired = tryAcquireProcessLock(lock)
  if (!acquired.acquired) throw new Error('fixture lock unavailable')
  try {
    expect(f.runs.poll(f.id).status).toBe('running')
    expect(existsSync(join(f.context.liveInputDir, 'codex-reproduction', f.id))).toBe(false)
  } finally { releaseProcessLock(lock, acquired.lease) }
  expect(f.runs.poll(f.id).status).toBe('interrupted')
})

test('unknown lock and durable containment are never downgraded to recoverable interruption', () => {
  const f = fixture()
  writeFileSync(join(f.journal, 'process.lock'), 'invalid', { mode: 0o600 })
  expect(() => f.runs.poll(f.id)).toThrow('ownership is unknown')
  rmSync(join(f.journal, 'process.lock'))
  writeFileSync(join(f.context.stateDir, 'reproductions', 'prior', `containment-${'a'.repeat(64)}.json`), '{}', { mode: 0o600 })
  expect(() => f.runs.poll(f.id)).toThrow('requires containment')
})

test('active previous job is not declared interrupted from a missing process lock', () => {
  const f = fixture(); f.sql("UPDATE jobs SET status='running'")
  expect(() => f.runs.poll(f.id)).toThrow('previous job is still active')
})

test.each(['workspace', 'promptSha256', 'id'])('tampered source identity is rejected: %s', field => {
  const f = fixture()
  writeFileSync(join(f.journal, 'result.json'), JSON.stringify({ ...f.result, [field]: field === 'workspace' ? f.context.scratchDir : 'a'.repeat(64) }), { mode: 0o600 })
  expect(() => f.runs.poll(f.id)).toThrow()
})

test('recovery excludes runtime, credentials, compiler caches, links, special and oversized files', () => {
  const f = fixture()
  writeFileSync(join(f.workspace, '.env'), 'do not read', { mode: 0o600 })
  writeFileSync(join(f.workspace, 'auth.json'), 'do not read', { mode: 0o600 })
  writeFileSync(join(f.dir('tmp', 'prior', 'run_a', 'swift-cache'), 'huge.pcm'), 'cache')
  writeFileSync(join(f.workspace, 'sensitive.txt'), 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789', { mode: 0o600 })
  symlinkSync(f.context.scratchDir, join(f.workspace, 'linked-directory'))
  symlinkSync(join(f.workspace, 'auth.json'), join(f.workspace, 'linked.json'))
  linkSync(join(f.workspace, 'auth.json'), join(f.workspace, 'hardlink.json'))
  writeFileSync(join(f.workspace, 'too-large.json'), ''); truncateSync(join(f.workspace, 'too-large.json'), 65 * 1024 * 1024)
  const value = f.runs.poll(f.id)
  for (const name of ['.env', 'auth.json', 'swift-cache', 'sensitive.txt', 'linked-directory', 'linked.json', 'hardlink.json', 'too-large.json']) {
    expect(existsSync(join(value.workspace, name))).toBe(false)
  }
  expect(value.recovery!.excluded).toBeGreaterThan(0)
  expect(value.recovery!.unavailable).toBeGreaterThan(0)
  expect(value.recovery!.copiedFiles).toBe(2)
})

test('MCP poll returns historical recovery instead of the former unavailable response', async () => {
  const f = fixture(), server = createReproductionServer(f.runs)
  const client = new Client({ name: 'resume-test', version: '1' }), [left, right] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(right); await client.connect(left)
    const response = await client.callTool({ name: 'codex_reproduction_poll', arguments: { id: f.id } })
    expect(response.isError).not.toBe(true)
    const value = JSON.parse((response.content as { text: string }[])[0]!.text)
    expect(value.status).toBe('interrupted')
    expect(value.recovery.copiedFiles).toBe(2)
    expect(f.starts()).toBe(0)
  } finally { await client.close(); await server.close(); await f.runs.close() }
})

test('retained execution record stays readable after scratch retention removes its workspace', () => {
  const f = fixture('completed')
  writeFileSync(join(f.journal, 'final.txt'), 'Retained final report', { mode: 0o600 })
  rmSync(join(f.context.stateDir, 'tmp', 'prior'), { recursive: true })
  const result = f.runs.poll(f.id)
  expect(result.status).toBe('completed')
  expect(result.recovery?.copiedFiles).toBe(0)
  expect(result.recovery?.unavailable).toBe(1)
  expect(readFileSync(result.finalPath, 'utf8')).toBe('Retained final report')
  const manifest = JSON.parse(readFileSync(result.recovery!.manifestPath, 'utf8'))
  expect(manifest.omitted).toEqual([{ path: '.', reason: 'source-workspace-missing' }])
  expect(manifest.comparisonVerified).toBe(false)
})

test('unsupported or oversized work products are named in the recovery manifest without exposing protected names', () => {
  const f = fixture()
  writeFileSync(join(f.workspace, 'comparison.xlsx'), 'synthetic workbook')
  writeFileSync(join(f.workspace, 'large.json'), ''); truncateSync(join(f.workspace, 'large.json'), 65 * 1024 * 1024)
  writeFileSync(join(f.workspace, '.env.private'), 'synthetic private data')
  const result = f.runs.poll(f.id)
  const manifest = JSON.parse(readFileSync(result.recovery!.manifestPath, 'utf8'))
  expect(manifest.omitted).toContainEqual({ path: 'comparison.xlsx', reason: 'unsupported-format' })
  expect(manifest.omitted).toContainEqual({ path: 'large.json', reason: 'size-limit' })
  expect(JSON.stringify(manifest)).not.toContain('.env.private')
})
