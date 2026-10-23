import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
test('fetches remote changes and updates actual working files on every start', async () => {
  const {local, other} = setup(); advance(other)
  await synchronizeTaskProject({repoPath: local, writeEnabled: true})
  expect(readFileSync(join(local, 'source.txt'), 'utf8')).toBe('remote update\n')
  advance(other, 'source.txt', 'second update\n')
  await synchronizeTaskProject({repoPath: local, writeEnabled: true})
  expect(readFileSync(join(local, 'source.txt'), 'utf8')).toBe('second update\n')
})
test('new branch uses server default, preserves branch and unrelated dirty files', async () => {
  const {local, other} = setup(); git(local, 'switch', '-c', 'task/new')
  writeFileSync(join(local, 'mine.txt'), 'unsaved'); advance(other)
  const result = await synchronizeTaskRepository(local)
  expect(result?.sourceBranch).toBe('develop'); expect(result?.branch).toBe('task/new')
  expect(git(local, 'branch', '--show-current')).toBe('task/new')
  expect(readFileSync(join(local, 'mine.txt'), 'utf8')).toBe('unsaved')
  expect(readFileSync(join(local, 'source.txt'), 'utf8')).toBe('remote update\n')
})
test('existing feature branch follows its upstream, not develop', async () => {
  const {local, other} = setup(); git(other, 'switch', '-c', 'feature'); git(other, 'push', '-u', 'origin', 'feature')
  git(local, 'fetch', 'origin'); git(local, 'switch', '--track', 'origin/feature'); advance(other)
  expect((await synchronizeTaskRepository(local))?.sourceBranch).toBe('feature')
  expect(readFileSync(join(local, 'source.txt'), 'utf8')).toBe('remote update\n')
})
test('merges divergent unpublished commits without discarding either side', async () => {
  const {local, other} = setup()
  writeFileSync(join(local, 'local.txt'), 'local'); git(local, 'add', '.'); git(local, 'commit', '-m', 'local')
  const before = git(local, 'rev-parse', 'HEAD'); advance(other)
  await synchronizeTaskRepository(local)
  expect(git(local, 'merge-base', '--is-ancestor', before, 'HEAD')).toBe('')
  expect(readFileSync(join(local, 'local.txt'), 'utf8')).toBe('local')
  expect(readFileSync(join(local, 'source.txt'), 'utf8')).toBe('remote update\n')
})
test('overlapping dirty edits reject without autostash or losing user changes', async () => {
  const {local, other} = setup(); git(local, 'config', 'merge.autostash', 'true')
  writeFileSync(join(local, 'source.txt'), 'unsaved'); advance(other)
  await expect(synchronizeTaskRepository(local)).rejects.toThrow('作業は開始していません')
  expect(readFileSync(join(local, 'source.txt'), 'utf8')).toBe('unsaved')
  expect(git(local, 'stash', 'list')).toBe('')
})
test('unavailable remote rejects and read-only task leaves checkout alone', async () => {
  const {local, remote, other} = setup(); advance(other)
  await synchronizeTaskProject({repoPath: local, writeEnabled: false})
  expect(readFileSync(join(local, 'source.txt'), 'utf8')).toBe('initial\n')
  rmSync(remote, {recursive: true, force: true})
  await expect(synchronizeTaskRepository(local)).rejects.toThrow('作業は開始していません')
})
test('local-only and non-Git projects remain usable', async () => {
  const {root, local} = setup(); git(local, 'remote', 'remove', 'origin')
  expect(await synchronizeTaskRepository(local)).toBeNull()
  const empty = mkdtempSync(join(tmpdir(), 'task-sync-empty-')); roots.push(empty)
  expect(await synchronizeTaskProject({repoPath: empty, writeEnabled: true})).toEqual([])
})
test('feature also receives integration changes pushed from another PC', async () => {
  const {local, other} = setup(); git(local, 'switch', '-c', 'feature'); git(local, 'push', '-u', 'origin', 'feature')
  advance(other, 'base.txt', 'new base')
  const result = await synchronizeTaskRepository(local)
  expect(result?.sourceBranch).toBe('feature'); expect(result?.integrationBranch).toBe('develop')
  expect(readFileSync(join(local, 'base.txt'), 'utf8')).toBe('new base')
})
test('merge conflicts keep both commits and stop before work', async () => {
  const {local, other} = setup()
  writeFileSync(join(local, 'source.txt'), 'local commit\n'); git(local, 'add', '.'); git(local, 'commit', '-m', 'local')
  const before = git(local, 'rev-parse', 'HEAD'); advance(other)
  await expect(synchronizeTaskRepository(local)).rejects.toThrow('作業は開始していません')
  expect(git(local, 'rev-parse', 'HEAD')).toBe(before)
  expect(git(local, 'ls-files', '--unmerged')).not.toBe('')
  await expect(synchronizeTaskRepository(local)).rejects.toThrow('未解消の競合')
})
test('managed workspace honors develop even when remote default is main', async () => {
  const {local, other, remote} = setup(); git(other, 'branch', 'main'); git(other, 'push', 'origin', 'main')
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'); git(local, 'switch', '-c', 'task/managed')
  advance(other, 'develop.txt', 'develop update')
  const results = await synchronizeTaskProject({repoPath: local, writeEnabled: true, gitIntegrationBranches: {[local]: 'develop'}})
  expect(results[0]?.integrationBranch).toBe('develop')
  expect(readFileSync(join(local, 'develop.txt'), 'utf8')).toBe('develop update')
})
test('deleted feature upstream falls back to current integration branch', async () => {
  const {local, other} = setup(); git(local, 'switch', '-c', 'feature'); git(local, 'push', '-u', 'origin', 'feature')
  git(other, 'push', 'origin', '--delete', 'feature'); advance(other)
  expect((await synchronizeTaskRepository(local))?.sourceBranch).toBe('develop')
  expect(git(local, 'branch', '--show-current')).toBe('feature')
  expect(readFileSync(join(local, 'source.txt'), 'utf8')).toBe('remote update\n')
})
