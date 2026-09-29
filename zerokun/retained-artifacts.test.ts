import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { prepareManagedStateRoot, ensureManagedDirectory } from './managed-path.ts'
import { retainDeliveredArtifacts } from './retained-artifacts.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-retained-'))); roots.push(root)
  const state = prepareManagedStateRoot(join(root, 'state'))
  const input = ensureManagedDirectory(state, join(state, 'live-input', 'current'))
  const db = new Database(join(state, 'jobs.sqlite3'))
  db.exec('CREATE TABLE jobs(id TEXT,seq INTEGER,chat_id TEXT,thread_ts TEXT,repo_path TEXT); CREATE TABLE artifact_deliveries(job_id TEXT,artifact_path TEXT,delivered_at INTEGER,abandoned_at INTEGER)')
  const job = { id: 'current', seq: 10, chatId: 'chat', threadTs: 'thread', repoPath: '/repo' }
  function add(id: string, seq = 9, scope = 'thread', delivered: number | null = 1, body = 'final dataset') {
    const directory = ensureManagedDirectory(state, join(state, 'sealed-artifacts', id))
    const digest = createHash('sha256').update(body).digest('hex')
    const path = join(directory, `${'a'.repeat(32)}--${digest.slice(0, 32)}--final.json`)
    writeFileSync(path, body, { mode: 0o600 })
    db.run('INSERT INTO jobs VALUES(?,?,?,?,?)', [id, seq, 'chat', scope, '/repo'])
    db.run('INSERT INTO artifact_deliveries VALUES(?,?,?,NULL)', [id, path, delivered])
    return path
  }
  return { state, input, db, job, add }
}
test('同じ会話の配信確定済み成果物だけをdigest検証して引き継ぐ', () => {
  const f = fixture(); f.add('prior'); f.add('other-thread', 8, 'other'); f.add('draft', 7, 'thread', null); f.add('future', 11)
  f.db.close()
  const result = retainDeliveredArtifacts(f.job, f.state, f.input)
  expect(result.artifacts).toHaveLength(1)
  expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toBe('final dataset')
  expect(result.unavailable).toBe(0)
})
test('改変されたsealed fileとsymlinkを入力へコピーしない', () => {
  const f = fixture(); const changed = f.add('changed'); writeFileSync(changed, 'tampered')
  const linked = f.add('linked'); rmSync(linked); symlinkSync(changed, linked); f.db.close()
  const result = retainDeliveredArtifacts(f.job, f.state, f.input)
  expect(result.artifacts).toHaveLength(0); expect(result.unavailable).toBe(2)
})
test('worktreeの継続でも元repositoryで照合し、消えた配信済みfileを成功扱いしない', () => {
  const f = fixture(); const removed = f.add('removed'); rmSync(removed); f.add('kept'); f.db.close()
  const result = retainDeliveredArtifacts({ ...f.job, repoPath: '/worktree', historyRepoPath: '/repo' }, f.state, f.input)
  expect(result.artifacts).toHaveLength(1); expect(result.unavailable).toBe(1)
})
