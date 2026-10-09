import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore } from './job-runner.ts'
import { activateProjectPrimaryCore, bindProjectSlackApp, mutateProjectChannelConfig, projectPrimaryCore, projectChannelConfigPath, setProjectPrimaryCore, switchProjectSlackApp, unsetProjectSlackApp } from './project-channel-config.ts'
import { migratePrimaryCoreRuntime } from './primary-core-migration.ts'
import { parsePrimaryCore } from './primary-core.ts'
import { activeJobCounts, activeJobCountsFromDatabase } from './update.ts'
import { executeCodexJob } from './codex-executor.ts'

const roots: string[] = []
const stores: JobStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-core-test-')))
  roots.push(root)
  const repo = join(root, 'repo'), state = join(root, 'state')
  mkdirSync(repo); mkdirSync(state, { mode: 0o700 })
  expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0)
  const store = new JobStore(join(state, 'jobs.sqlite3')); stores.push(store)
  let seq = 0
  const enqueue = (thread = '1800000000.000001') => store.enqueue({
    chatId: 'CCORE', threadTs: thread, messageId: `1800000000.${String(++seq).padStart(6, '0')}`,
    userId: 'UTEST', repoPath: repo, task: 'synthetic core test', writeEnabled: false,
  }).job
  return { root, repo, state, store, enqueue }
}

test('Codex remains default; selection takes effect only after activation and freezes accepted jobs', () => {
  const f = fixture()
  expect(projectPrimaryCore(f.repo)).toEqual({ desired: 'codex', active: 'codex' })
  const first = f.enqueue()
  setProjectPrimaryCore(f.repo, 'claude-code')
  expect(f.enqueue().runtime).toBe('codex')
  activateProjectPrimaryCore(f.repo, 'claude-code')
  const third = f.enqueue()
  expect(third.runtime).toBe('claude-code')
  setProjectPrimaryCore(f.repo, 'codex')
  activateProjectPrimaryCore(f.repo, 'codex')
  expect(f.enqueue().runtime).toBe('codex')
  expect(f.store.get(first.id)!.runtime).toBe('codex')
  expect(f.store.get(third.id)!.runtime).toBe('claude-code')
  expect(f.store.activeCounts()).toEqual({ queued: 4, running: 0 })
  expect(() => activateProjectPrimaryCore(f.repo, 'claude-code')).toThrow('起動中に主担当設定が変更')
  expect(parsePrimaryCore('claude')).toBe('claude-code')
  expect(() => parsePrimaryCore('claude;false')).toThrow()
})

test('both cores share FIFO and one active owner; sessions never cross a core switch', () => {
  const f = fixture()
  const first = f.enqueue()
  expect(f.store.claimNext('worker')!.id).toBe(first.id)
  f.store.complete(first.id, 'codex-session', 'first')
  setProjectPrimaryCore(f.repo, 'claude-code'); activateProjectPrimaryCore(f.repo, 'claude-code')
  const second = f.enqueue()
  const claim = f.store.claimNext('worker')!
  expect(claim.id).toBe(second.id); expect(claim.sessionId).toBeNull()
  const third = f.enqueue()
  expect(f.store.claimNext('other-worker')).toBeNull()
  expect(() => f.store.saveSession(second.id, 'codex-session')).toThrow('core or protocol')
  f.store.complete(second.id, 'claude-session', 'second')
  expect(f.store.claimNext('worker')!.sessionId).toBe('claude-session')
  f.store.complete(third.id, 'claude-session', 'third')
  setProjectPrimaryCore(f.repo, 'codex'); activateProjectPrimaryCore(f.repo, 'codex')
  f.enqueue()
  expect(f.store.claimNext('worker')!.sessionId).toBeNull()
})

test('a durable Slack admission keeps its core through hydration and a later switch', () => {
  const f = fixture()
  const delivery = { chatId: 'CCORE', threadTs: '1800000000.000001', messageId: '1800000000.000001',
    userId: 'UTEST', repoPath: f.repo, text: 'admitted before switch' }
  expect(f.store.stageInboundDelivery(delivery)).toBe(true)
  setProjectPrimaryCore(f.repo, 'claude-code'); activateProjectPrimaryCore(f.repo, 'claude-code')
  expect(f.store.stageInboundDelivery(delivery)).toBe(false)
  expect(f.store.enqueue({ ...delivery, task: delivery.text }).job.runtime).toBe('codex')
  const later = { ...delivery, threadTs: '1800000000.000002', messageId: '1800000000.000002' }
  expect(f.store.stageInboundDeliveryAndAdoptSlackThread(later, { appId: 'ATEST', initialContextEligible: false }).outcome).toBe('staged')
  setProjectPrimaryCore(f.repo, 'codex'); activateProjectPrimaryCore(f.repo, 'codex')
  expect(f.store.enqueue({ ...later, task: later.text }).job.runtime).toBe('claude-code')
})

test('channel and App mutations preserve desired and active core', () => {
  const f = fixture(), next = join(f.root, 'next')
  mkdirSync(next, { mode: 0o700 })
  const apps = [{ appId: 'AFIRST', stateDir: f.state }, { appId: 'ASECOND', stateDir: next }]
  setProjectPrimaryCore(f.repo, 'claude-code'); activateProjectPrimaryCore(f.repo, 'claude-code')
  bindProjectSlackApp(f.repo, 'AFIRST')
  mutateProjectChannelConfig({ operation: 'set', repoPath: f.repo, stateDir: f.state, appId: 'AFIRST', channelId: 'CCORE' })
  switchProjectSlackApp(f.repo, 'ASECOND', apps)
  expect(projectPrimaryCore(f.repo).desired).toBe('claude-code')
  unsetProjectSlackApp(f.repo, apps)
  expect(projectPrimaryCore(f.repo)).toEqual({ desired: 'claude-code', active: 'claude-code' })
})

test('core changes leave the legacy channel configuration byte-identical for a running old gateway and rollback', () => {
  const f = fixture()
  bindProjectSlackApp(f.repo, 'AFIRST')
  const path = projectChannelConfigPath(f.repo), before = readFileSync(path, 'utf8')
  setProjectPrimaryCore(f.repo, 'claude-code')
  activateProjectPrimaryCore(f.repo, 'claude-code')
  expect(readFileSync(path, 'utf8')).toBe(before)
  setProjectPrimaryCore(f.repo, 'codex'); activateProjectPrimaryCore(f.repo, 'codex')
  expect(readFileSync(path, 'utf8')).toBe(before)
})

test('runtime CHECK migration preserves children, triggers, indexes and AUTOINCREMENT', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, runtime TEXT CHECK(runtime IN ('claude', 'codex')));
      CREATE TABLE child(job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE, value TEXT);
      CREATE TABLE audit(id TEXT);
      CREATE INDEX job_runtime ON jobs(runtime);
      CREATE TRIGGER job_insert AFTER INSERT ON jobs BEGIN INSERT INTO audit VALUES(new.id); END;
      INSERT INTO jobs VALUES(41,'keep','codex'); INSERT INTO child VALUES('keep','receipt');
      INSERT INTO jobs VALUES(99,'deleted','claude'); DELETE FROM jobs WHERE id='deleted';`)
    migratePrimaryCoreRuntime(db); migratePrimaryCoreRuntime(db)
    expect(db.query('SELECT * FROM child').all()).toEqual([{ job_id: 'keep', value: 'receipt' }])
    expect(db.query('SELECT * FROM audit').all()).toHaveLength(2)
    db.run("INSERT INTO jobs(id,runtime) VALUES('new','claude-code')")
    expect(db.query<{ seq: number }, []>("SELECT seq FROM jobs WHERE id='new'").get()!.seq).toBe(100)
    expect(db.query('SELECT * FROM audit').all()).toHaveLength(3)
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(() => db.run("INSERT INTO child VALUES('missing','bad')")).toThrow()
    expect(db.query("SELECT 1 FROM sqlite_schema WHERE name='job_runtime'").get()).not.toBeNull()
    expect(() => db.run("INSERT INTO jobs(id,runtime) VALUES('bad','unknown')")).toThrow()
  } finally { db.close() }
})

test('maintenance counts the new core and keeps legacy history separate', () => {
  const f = fixture()
  setProjectPrimaryCore(f.repo, 'claude-code'); activateProjectPrimaryCore(f.repo, 'claude-code')
  f.enqueue(); f.store.claimNext('worker'); f.enqueue('1800000000.000002')
  expect(activeJobCountsFromDatabase(f.store.dbPath)).toEqual({ queued: 1, running: 1 })
  expect(activeJobCounts(JSON.stringify([
    { runtime: 'claude-code', status: 'running' }, { runtime: 'codex', status: 'queued' },
    { runtime: 'claude', status: 'running' }, { runtime: 'future-core', status: 'queued' },
  ]))).toEqual({ queued: 2, running: 1 })
  expect(f.store.countLegacyActive()).toBe(0)
  expect(f.store.migrateLegacyActive()).toBe(0)
})

test('a Claude job cannot accidentally enter the Codex executor', async () => {
  const f = fixture()
  setProjectPrimaryCore(f.repo, 'claude-code'); activateProjectPrimaryCore(f.repo, 'claude-code')
  const job = f.enqueue()
  await expect(executeCodexJob(job, { logDir: f.state })).rejects.toThrow('another core')
})
