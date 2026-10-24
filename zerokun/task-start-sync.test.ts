import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, chmodSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCodexWorkerPrompt } from './codex-executor.ts'
import type { JobRecord } from './job-runner.ts'
import { synchronizeTaskRepository, synchronizeTaskProject } from './task-start-sync.ts'
const roots: string[] = []
function git(root: string, ...args: string[]) { return execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'task-sync-')); roots.push(root)
  const remote = join(root, 'remote.git'), local = join(root, 'local'), other = join(root, 'other')
  git(root, 'init', '--bare', '--initial-branch=develop', remote)
  git(root, 'clone', remote, other)
  git(other, 'config', 'user.email', 'test@example.invalid'); git(other, 'config', 'user.name', 'Test')
  writeFileSync(join(other, 'source.txt'), 'initial\n'); git(other, 'add', '.'); git(other, 'commit', '-m', 'initial'); git(other, 'push', 'origin', 'develop')
  git(root, 'clone', remote, local)
  git(local, 'config', 'user.email', 'test@example.invalid'); git(local, 'config', 'user.name', 'Test')
  return { root, remote, local, other }
}
function advance(other: string, file = 'source.txt', text = 'remote update\n') {
  writeFileSync(join(other, file), text); git(other, 'add', '.'); git(other, 'commit', '-m', 'remote change'); git(other, 'push', 'origin', 'HEAD')
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
test('explicitly authorized clean tracking checkout updates on every start', async () => {
  const {local, other} = setup(); advance(other)
  expect((await synchronizeTaskProject({repoPath: local, writeEnabled: true}))[0]?.status).toBe('updated')
  expect(readFileSync(join(local, 'source.txt'), 'utf8')).toBe('remote update\n')
  advance(other, 'source.txt', 'second update\n')
  await synchronizeTaskProject({repoPath: local, writeEnabled: true})
  expect(readFileSync(join(local, 'source.txt'), 'utf8')).toBe('second update\n')
})
test('fetch-only preflight exposes latest SHA without mutating a research checkout', async () => {
  const {local, other} = setup(); advance(other)
  const results = await synchronizeTaskProject({repoPath: local, writeEnabled: false})
  expect(results[0]).toMatchObject({status: 'inspection-only', behind: 1, ahead: 0, remoteCommit: git(other, 'rev-parse', 'HEAD')})
  expect(readFileSync(join(local, 'source.txt'), 'utf8')).toBe('initial\n')
  const job = {id: 'sync-test', repoPath: local, writeEnabled: true, attachments: [], taskStartSync: results} as unknown as JobRecord
  const prompt = buildCodexWorkerPrompt(job, {revision: 1, digest: 'b'.repeat(64), transcript: '調査だけ'}, {attemptNonce: 'a'.repeat(32), artifactDir: local, advisorEnabled: false})
  expect(prompt).toContain(results[0]!.remoteCommit!)
  expect(prompt).toContain('Before implementation, verify the task branch is up to date')
  expect(prompt).toContain('Read-only tasks may inspect the fetched revision without modifying the checkout')
  // Claude calls the shared builder without a Codex host envelope.
  const claudePrompt = buildCodexWorkerPrompt(job, {revision: 1, digest: 'b'.repeat(64), transcript: '調査だけ'}, undefined)
  expect(claudePrompt).toContain(results[0]!.remoteCommit!)
  expect(claudePrompt).toContain('run git pull --ff-only with the explicit remote and branch before editing')
  expect(claudePrompt).toContain('Never reset, auto-stash or force-push')

})
test('subdirectory authorization never updates the containing checkout', async () => {
  const {local, other} = setup(); mkdirSync(join(local, 'subdir')); advance(other)
  const results = await synchronizeTaskProject({repoPath: join(local, 'subdir'), writeEnabled: true})
  expect(results[0]?.status).toBe('inspection-only')
  expect(git(local, 'rev-parse', 'HEAD')).not.toBe(git(other, 'rev-parse', 'HEAD'))
})
test('upstream-less new branch receives integration facts, not a guessed pull', async () => {
  const {local, other} = setup(); git(local, 'switch', '-c', 'task/new'); advance(other)
  const before = git(local, 'rev-parse', 'HEAD')
  const result = await synchronizeTaskRepository(local)
  expect(result.status).toBe('needs-resolution'); expect(result.integrationCommit).toBe(git(other, 'rev-parse', 'HEAD'))
  expect(git(local, 'rev-parse', 'HEAD')).toBe(before)
})
test('feature tracks its upstream without forcibly merging an unrelated integration update', async () => {
  const {local, other} = setup(); git(local, 'switch', '-c', 'feature'); git(local, 'push', '-u', 'origin', 'feature')
  advance(other, 'base.txt', 'new base')
  const result = await synchronizeTaskRepository(local)
  expect(result).toMatchObject({sourceBranch: 'feature', integrationBranch: 'develop', status: 'current'})
  expect(result.integrationCommit).toBe(git(other, 'rev-parse', 'HEAD'))
  expect(git(local, 'ls-files', 'base.txt')).toBe('')
})
test('dirty files and divergent unpublished commits remain intact without creating conflicts', async () => {
  const {local, other} = setup(); git(local, 'config', 'merge.autostash', 'true')
  writeFileSync(join(local, 'source.txt'), 'local commit\n'); git(local, 'add', '.'); git(local, 'commit', '-m', 'local')
  const before = git(local, 'rev-parse', 'HEAD'); advance(other)
  expect((await synchronizeTaskRepository(local)).status).toBe('needs-resolution')
  expect(git(local, 'ls-files', '--unmerged')).toBe('')
  writeFileSync(join(local, 'source.txt'), 'unsaved')
  expect((await synchronizeTaskRepository(local)).status).toBe('needs-resolution')
  expect(git(local, 'rev-parse', 'HEAD')).toBe(before)
  expect(readFileSync(join(local, 'source.txt'), 'utf8')).toBe('unsaved')
  expect(git(local, 'stash', 'list')).toBe('')
})
test('existing conflict permits primary recovery and successful next start', async () => {
  const {local, other} = setup(); writeFileSync(join(local, 'source.txt'), 'local\n'); git(local, 'add', '.'); git(local, 'commit', '-m', 'local'); advance(other)
  git(local, 'fetch', 'origin'); try { git(local, 'merge', 'origin/develop') } catch {}
  expect(git(local, 'ls-files', '--unmerged')).not.toBe('')
  expect((await synchronizeTaskProject({repoPath: local, writeEnabled: false}))[0]?.status).toBe('needs-resolution')
  writeFileSync(join(local, 'source.txt'), 'local and remote reconciled\n'); git(local, 'add', '.'); git(local, 'commit', '-m', 'resolve')
  expect((await synchronizeTaskRepository(local)).status).toBe('current')
})
test('unavailable remote is reported with original revision and does not block diagnosis', async () => {
  const {local, remote} = setup(); const before = git(local, 'rev-parse', 'HEAD'); rmSync(remote, {recursive: true, force: true})
  expect(await synchronizeTaskRepository(local)).toMatchObject({status: 'unavailable', commit: before})
  expect(git(local, 'rev-parse', 'HEAD')).toBe(before)
})
test('local-only and non-Git projects remain usable without a freshness claim', async () => {
  const {root, local} = setup(); git(local, 'remote', 'remove', 'origin')
  expect((await synchronizeTaskRepository(local)).status).toBe('local-only')
  const empty = join(root, 'empty'); mkdirSync(empty)
  expect(await synchronizeTaskProject({repoPath: empty, writeEnabled: true})).toEqual([])
})
test('managed integration preference is fetched even when server default differs', async () => {
  const {local, other, remote} = setup(); git(other, 'branch', 'main'); git(other, 'push', 'origin', 'main')
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'); git(local, 'switch', '-c', 'task/managed'); advance(other)
  const results = await synchronizeTaskProject({repoPath: local, writeEnabled: false, gitIntegrationBranches: {[local]: 'develop'}})
  expect(results[0]?.integrationCommit).toBe(git(other, 'rev-parse', 'HEAD'))
})
test('deleted upstream never falls back to a different branch', async () => {
  const {local, other} = setup(); git(local, 'switch', '-c', 'feature'); git(local, 'push', '-u', 'origin', 'feature')
  git(other, 'push', 'origin', '--delete', 'feature'); advance(other)
  const before = git(local, 'rev-parse', 'HEAD'); const result = await synchronizeTaskRepository(local)
  expect(result.status).toBe('needs-resolution'); expect(result.remoteCommit).toBeUndefined()
  expect(git(local, 'rev-parse', 'HEAD')).toBe(before)
})
test('user cancellation during remote lookup aborts synchronization before any checkout update', async () => {
  const {root, local, other} = setup(); advance(other)
  const script = join(root, 'slow-upload-pack'); const marker = join(root, 'started')
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nsleep 0.3\nexec /usr/bin/git-upload-pack "$@"\n`); chmodSync(script, 0o700)
  git(local, 'config', 'remote.origin.uploadpack', script)
  const before = git(local, 'rev-parse', 'HEAD')
  await expect(synchronizeTaskProject({repoPath: local, writeEnabled: true}, undefined, () => {try {readFileSync(marker); return true} catch {return false}})).rejects.toThrow()
  expect(git(local, 'rev-parse', 'HEAD')).toBe(before)
})
