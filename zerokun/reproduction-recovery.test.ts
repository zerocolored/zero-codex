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
import { recoverPreviousReproduction } from './reproduction-recovery.ts'

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

function sameJobFixture() {
  const f = fixture()
  f.context.job.id = 'prior'; f.context.job.seq = 105; f.context.job.status = 'running'
  f.context.scratchDir = f.dir('tmp', 'prior')
  f.context.artifactDir = f.dir('outbox', 'prior')
  f.context.liveInputDir = f.dir('live-input', 'prior')
  return f
}

test.each(['completed', 'containment_failed'])('recovery rereads a concurrently published %s result after ownership release', status => {
  const f = sameJobFixture()
  const recover = () => recoverPreviousReproduction(f.context, f.id, true, () => {
    writeFileSync(join(f.journal, 'result.json'), JSON.stringify({ ...f.result, status, exitCode: 0 }), { mode: 0o600 })
    return { status: 'missing' }
  })
  if (status === 'completed') expect(recover().status).toBe('completed')
  else expect(recover).toThrow('requires containment')
  expect(JSON.parse(readFileSync(join(f.journal, 'result.json'), 'utf8')).status).toBe(status)
  expect(f.starts()).toBe(0)
})

test('same-job reconnect recovers a lost broker without relaunching or rewriting its source journal', async () => {
  const f = sameJobFixture(), original = readFileSync(join(f.journal, 'result.json'), 'utf8')
  const value = f.runs.poll(f.id)
  expect(value.status).toBe('interrupted')
  expect(value.recovery?.sourceJob).toBe(105)
  expect(value.recovery?.copiedFiles).toBe(2)
  expect(value.recovery?.finalAvailable).toBe(false)
  expect(readFileSync(join(value.workspace, 'output', 'partial.json'), 'utf8')).toBe('{"count":12}')
  expect(readFileSync(join(f.journal, 'result.json'), 'utf8')).toBe(original)
  const prompt = join(f.context.scratchDir, 'request.txt')
  writeFileSync(prompt, readFileSync(join(f.journal, 'request.txt')), { mode: 0o600 })
  expect(f.runs.start(prompt, f.workspace)).toEqual(value)
  expect(f.starts()).toBe(0)
  expect(JSON.parse(readFileSync(value.receiptPath, 'utf8')).comparisonVerified).toBe(false)
  await f.runs.close()
})

test('same-job poll preserves a live owner and rejects unknown ownership', async () => {
  const f = sameJobFixture(), path = join(f.journal, 'process.lock')
  const lease = tryAcquireProcessLock(path)
  if (!lease.acquired) throw new Error('fixture lease unavailable')
  try {
    expect(f.runs.poll(f.id).status).toBe('running')
    expect(existsSync(join(f.context.liveInputDir, 'codex-reproduction', f.id))).toBe(false)
  } finally { releaseProcessLock(path, lease.lease) }
  writeFileSync(path, 'invalid', { mode: 0o600 })
  expect(() => f.runs.poll(f.id)).toThrow('ownership is unknown')
  expect(f.starts()).toBe(0)
  await f.runs.close()
})

test('same-job MCP polling returns recovered partial files immediately, with no sandbox process inspection', async () => {
  const f = sameJobFixture()
  writeFileSync(join(f.journal, 'final.txt'), 'Unsealed final output', { mode: 0o600 })
  const server = createReproductionServer(f.runs), client = new Client({ name: 'same-job-test', version: '1' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide); await client.connect(clientSide)
  try {
    const before = Date.now(), response = await client.callTool({ name: 'codex_reproduction_poll', arguments: { id: f.id } })
    expect(Date.now() - before).toBeLessThan(5_000)
    const result = JSON.parse((response.content as { text: string }[])[0]!.text)
    expect(result.status).toBe('interrupted')
    expect(result.recovery.finalAvailable).toBe(true)
    expect(readFileSync(result.finalPath, 'utf8')).toBe('Unsealed final output')
    expect(f.starts()).toBe(0)
  } finally { await client.close(); await server.close(); await f.runs.close() }
})

test('a child group outliving its broker remains running until that exact group exits', async () => {
  const f = sameJobFixture(), path = join(f.journal, 'process.lock')
  const module = new URL('./process-lock.ts', import.meta.url).pathname
  // Keep the worker under the test runner: --no-orphans would otherwise
  // remove the fixture with its owner before recovery can observe the lease.
  const child = Bun.spawn(['/bin/sleep', '30'], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  const { readProcessIdentity, observeProcessGeneration, signalProcessIfLive } = await import('./process-generation.ts')
  const identity = readProcessIdentity(child.pid)
  try {
    expect(identity).toBeDefined()
    const script = `import {tryAcquireProcessLock,delegateProcessLock} from ${JSON.stringify(module)};
      const lock=${JSON.stringify(path)};const lease=tryAcquireProcessLock(lock);if(!lease.acquired)process.exit(2);
      if(!delegateProcessLock(lock,lease.lease,${child.pid}))process.exit(3);`
    const owner = Bun.spawn([process.execPath, '--config=/dev/null', '--no-env-file', '-e', script], { stdout: 'ignore', stderr: 'pipe' })
    expect(await owner.exited).toBe(0)
    expect(f.runs.poll(f.id).status).toBe('running')
    expect(observeProcessGeneration(identity!).status).toBe('alive')
  } finally {
    if (identity) signalProcessIfLive(identity, 'SIGTERM')
    for (let n = 0; identity && n < 100 && observeProcessGeneration(identity).status !== 'dead'; n++) await Bun.sleep(20)
  }
  expect(f.runs.poll(f.id).status).toBe('interrupted')
  expect(f.starts()).toBe(0)
  await f.runs.close()
}, 10_000)

test('a proven-dead prior broker is recoverable even when its database job still says running', async () => {
  const f = fixture(); f.sql("UPDATE jobs SET status='running'")
  const path = join(f.journal, 'process.lock'), module = new URL('./process-lock.ts', import.meta.url).pathname
  const script = `import {tryAcquireProcessLock} from ${JSON.stringify(module)};
    if(!tryAcquireProcessLock(${JSON.stringify(path)}).acquired)process.exit(2);`
  const owner = Bun.spawn([process.execPath, '--config=/dev/null', '--no-env-file', '-e', script], { stdout: 'ignore', stderr: 'pipe' })
  expect(await owner.exited).toBe(0)
  expect(f.runs.poll(f.id).status).toBe('interrupted')
  expect(f.starts()).toBe(0)
  await f.runs.close()
})

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

function legacyPollDirectories(f: ReturnType<typeof fixture>) {
  // Older brokers created a current-job directory even when merely polling
  // another job's id. Later resumptions must search past those empty entries.
  for (const [job, seq] of [['poll-one', 106], ['poll-two', 108]] as const) {
    f.sql(`INSERT INTO jobs VALUES('${job}',${seq},'chat','thread','/repo','completed')`)
    f.dir('reproductions', job, f.id)
  }
  f.dir('reproductions', 'current', f.id)
}

test.each(['running', 'completed'])('legacy empty poll directories do not hide the original %s execution', async status => {
  const f = fixture(status), original = readFileSync(join(f.journal, 'result.json'), 'utf8')
  legacyPollDirectories(f)
  const result = f.runs.poll(f.id)
  expect(result.status).toBe(status === 'running' ? 'interrupted' : 'completed')
  expect(result.recovery?.sourceJob).toBe(105)
  expect(result.recovery?.copiedFiles).toBe(2)
  expect(readFileSync(join(result.workspace, 'output', 'partial.json'), 'utf8')).toBe('{"count":12}')
  expect(readFileSync(join(f.journal, 'result.json'), 'utf8')).toBe(original)
  expect(f.starts()).toBe(0)
  await f.runs.close()
})

test.each(['empty', 'malformed', 'symlink'])('a present %s record is not skipped as a legacy empty poll directory', kind => {
  const f = fixture(); legacyPollDirectories(f)
  const path = join(f.context.stateDir, 'reproductions', 'poll-two', f.id, 'result.json')
  if (kind === 'symlink') symlinkSync(join(f.journal, 'result.json'), path)
  else writeFileSync(path, kind === 'empty' ? '' : '{invalid', { mode: 0o600 })
  expect(() => f.runs.poll(f.id)).toThrow()
  expect(existsSync(join(f.context.liveInputDir, 'codex-reproduction', f.id))).toBe(false)
  expect(f.starts()).toBe(0)
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
  legacyPollDirectories(f)
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
