import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { JobStore } from './job-runner.ts'
import { CloudRuntime } from './cloud-runtime.ts'
import { CloudHandoffClient, CloudHandoffError, digestBytes, type CloudHandoff } from './cloud-handoff.ts'
import { writeCheckpoint } from './handoff-coordinator.ts'
import { resolveProjectLayout } from './project-layout.ts'
import { buildCodexDeveloperInstructions } from './codex-executor.ts'
const roots: string[] = []
test('permanent ownership refusal is not classified as a retryable preparation outage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-prepare-classification-')); roots.push(root)
  const store = new JobStore(join(root, 'jobs.sqlite3'))
  const job = store.enqueue({ chatId: 'C1', threadTs: '1.0', messageId: '1.0', userId: 'U1', repoPath: root, task: 'task', writeEnabled: true }).job
  const client = new CloudHandoffClient({ version: 1, url: 'https://example.supabase.co', publishableKey: 'sb_publishable_fixture', accessToken: 'fixture' })
  client.claim = async () => { throw new CloudHandoffError(400, 'claim') }
  const runtime = new CloudRuntime(store, root, client)
  await expect(runtime.prepare(job)).rejects.toMatchObject({ permanent: true })
  client.claim = async () => { throw new CloudHandoffError(503, 'claim') }
  await expect(runtime.prepare(job)).rejects.toMatchObject({ permanent: false })
  store.close()
})
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
test('cloud multi-repo pin repair preserves existing HEAD, index and uncommitted files and passes real Claude snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-pin-repair-')); roots.push(root)
  const project = join(root, 'project'); mkdirSync(project)
  const repositories = ['back', 'front'].map(name => {
    const repo = join(project, name); mkdirSync(repo)
    git(repo, 'init', '--quiet')
    writeFileSync(join(repo, 'file.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'file.txt'), 'staged'); git(repo, 'add', '.')
    writeFileSync(join(repo, 'file.txt'), 'unstaged')
    writeFileSync(join(repo, 'untracked.txt'), 'owned work')
    return { name, root: repo, base }
  })
  const state = join(root, 'state'), store = new JobStore(join(state, 'jobs.sqlite3'))
  try {
    store.enqueue({ chatId: 'C1', threadTs: '1.0', messageId: '1.0', userId: 'U1', repoPath: project, task: 'continue', writeEnabled: true })
    const job = store.claimNext('worker')!
    store.bindCloudHandoff(job.id, initial.id, 1, JSON.stringify(initial))
    writeCheckpoint(join(state, 'cloud-workspaces', `${initial.id}.json`), Buffer.from(JSON.stringify({ epoch: 1, project, repositories })))
    const runtime = new CloudRuntime(store, state, new MemberClient(new CloudFixture(), ownerA, 'UA'))
    const request = join(root, 'request'); mkdirSync(request, { mode: 0o700 })
    const snapshot = () => Bun.spawnSync(['/usr/bin/python3', join(import.meta.dir, 'fifth-advisor.py'), 'snapshot',
      '--project-root', project, '--request-dir', request], { stdout: 'pipe', stderr: 'pipe' })
    expect(snapshot().stderr.toString()).toContain('project is not a Git worktree or pinned workspace')
    await runtime.prepare(job)
    expect(resolveProjectLayout(project).pinned).toBe(true)
    expect(runtime.executionJob(job).repoPath).toBe(realpathSync(project))
    const after = snapshot()
    expect(after.exitCode, after.stderr.toString()).toBe(0)
    await runtime.prepare(job)
    for (const repo of repositories) {
      expect(git(repo.root, 'rev-parse', 'HEAD')).toBe(repo.base)
      expect(git(repo.root, 'show', ':file.txt')).toBe('staged')
      expect(readFileSync(join(repo.root, 'file.txt'), 'utf8')).toBe('unstaged')
      expect(readFileSync(join(repo.root, 'untracked.txt'), 'utf8')).toBe('owned work')
    }
  } finally { store.close() }
})
test('legacy native session is reset durably when cloud changes cwd; managed continuation resumes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-session-cwd-')); roots.push(root)
  const source = join(root, 'source'), managed = join(root, 'managed')
  mkdirSync(source); mkdirSync(managed)
  const store = new JobStore(join(root, 'jobs.sqlite3'))
  try {
    const runtime = new CloudRuntime(store, root, new MemberClient(new CloudFixture(), ownerA, 'UA'))
    const input = { chatId: 'C1', threadTs: '1.0', userId: 'U1', repoPath: source, task: 'Continue approved work', writeEnabled: true }
    store.enqueue({ ...input, messageId: '1.0' })
    const previous = store.claimNext('worker')!
    store.saveSession(previous.id, 'legacy-session')
    store.complete(previous.id, 'legacy-session', 'Approved implementation completed; publish next.')
    store.enqueue({ ...input, messageId: '2.0' })
    const job = store.claimNext('worker')!
    expect(job.sessionId).toBe('legacy-session')
    store.bindCloudHandoff(job.id, initial.id, 1, JSON.stringify(initial))
    writeCheckpoint(join(root, 'cloud-workspaces', `${initial.id}.json`), Buffer.from(JSON.stringify({ epoch: 1,
      project: managed, repositories: [{ root: managed, name: 'project', base: 'fixture' }] })))
    const execution = runtime.executionJob(job)
    expect(execution.sessionId).toBeNull()
    expect(execution.resumed).toBe(false)
    expect(store.get(job.id)?.sessionId).toBeNull()
    expect(store.get(job.id)?.resumed).toBe(false)
    expect(execution.historyRepoPath).toBe(source)
    expect(store.threadHistorySnapshot(job.id).transcript).toContain('Approved implementation completed')
    // A pre-dispatch retry must not revive the preceding ID.
    expect(store.releaseUnstartedClaim(job.id, 'worker', 'fixture pre-dispatch retry')).toBe(true)
    const reclaimed = store.claimNext('worker')!
    expect(reclaimed.sessionId).toBeNull()
    expect(runtime.executionJob(reclaimed).sessionId).toBeNull()
    store.saveSession(job.id, 'managed-session', managed)
    const alias = join(root, 'managed-alias'); symlinkSync(managed, alias)
    store.saveSession(job.id, 'managed-session', alias)
    expect(() => store.saveSession(job.id, 'managed-session', source)).toThrow('workspace changed')
    expect(store.sessionWorkspace('managed-session')).toBe(realpathSync(managed))
    store.requeue(job.id, 'fixture same-workspace retry before dispatch')
    const retryClaim = store.claimNext('worker')!
    expect(retryClaim.resumed).toBe(true)
    const retry = runtime.executionJob(retryClaim)
    expect(retry.sessionId).toBe('managed-session')
    expect(retry.resumed).toBe(true)
    store.complete(job.id, 'managed-session', 'Work continued in managed workspace.')
    store.enqueue({ ...input, messageId: '3.0' })
    const next = store.claimNext('worker')!
    store.bindCloudHandoff(next.id, initial.id, 1, JSON.stringify(initial))
    expect(runtime.executionJob(next).sessionId).toBe('managed-session')
    expect(runtime.executionJob(next).resumed).toBe(true)
    // Import/epoch changes cannot reuse a local native session at another cwd.
    const imported = join(root, 'imported'); mkdirSync(imported)
    writeCheckpoint(join(root, 'cloud-workspaces', `${initial.id}.json`), Buffer.from(JSON.stringify({ epoch: 2,
      project: imported, repositories: [{ root: imported, name: 'project', base: 'fixture' }] })))
    expect(runtime.executionJob(next).sessionId).toBeNull()
    expect(store.get(next.id)?.sessionId).toBeNull()
  } finally { store.close() }
})
test('new cloud preparation and multi-repo import both pin the execution parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-new-pin-')); roots.push(root)
  const source = join(root, 'source'); mkdirSync(source)
  for (const name of ['back', 'front']) {
    const repo = join(source, name); mkdirSync(repo)
    git(repo, 'init', '-b', 'main', '--quiet')
    writeFileSync(join(repo, 'file.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'base')
    git(repo, 'remote', 'add', 'origin', repo)
  }
  const stateA = join(root, 'A'), stateB = join(root, 'B')
  const a = new JobStore(join(stateA, 'jobs.sqlite3')), b = new JobStore(join(stateB, 'jobs.sqlite3'))
  try {
    const cloud = new CloudFixture()
    const runtimeA = new CloudRuntime(a, stateA, new MemberClient(cloud, ownerA, 'UA'), join(root, 'owned-A'))
    const runtimeB = new CloudRuntime(b, stateB, new MemberClient(cloud, ownerB, 'UB'), join(root, 'owned-B'))
    a.enqueue({ chatId: 'C1', threadTs: '1.0', messageId: '1.0', userId: 'U1', repoPath: source, task: 'continue', writeEnabled: true })
    const job = a.claimNext('worker')!
    await runtimeA.prepare(job)
    const execution = runtimeA.executionJob(job)
    expect(resolveProjectLayout(execution.repoPath).pinned).toBe(true)
    for (const name of ['back', 'front']) {
      // Handoff remote identity is public HTTPS; all transfers still use the
      // already present local fixture objects, never GitHub or cloud network.
      git(join(source, name), 'remote', 'set-url', 'origin', `https://github.com/example/${name}.git`)
      git(join(execution.repoPath, name), 'remote', 'set-url', 'origin', `https://github.com/example/${name}.git`)
      writeFileSync(join(execution.repoPath, name, 'file.txt'), 'unfinished work')
    }
    await runtimeA.pause(job, undefined)
    const control = { channel: 'C1', thread: '1.0', message: '2.0', user: 'U1', bot: 'UB', project: source,
      writeEnabled: true, action: 'handoff' as const }
    await runtimeB.receive(control)
    await runtimeB.receive(control)
    const imported = runtimeB.executionJob(b.claimNext('worker-B')!)
    expect(resolveProjectLayout(imported.repoPath).pinned).toBe(true)
    const request = join(root, 'snapshot'); mkdirSync(request, { mode: 0o700 })
    const result = Bun.spawnSync(['/usr/bin/python3', join(import.meta.dir, 'fifth-advisor.py'), 'snapshot',
      '--project-root', imported.repoPath, '--request-dir', request], { stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    for (const name of ['back', 'front']) expect(readFileSync(join(imported.repoPath, name, 'file.txt'), 'utf8')).toBe('unfinished work')
  } finally { a.close(); b.close() }
})
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim()
}
const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const ownerB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const initial: CloudHandoff = { id: '11111111-1111-4111-8111-111111111111',
  space_id: '22222222-2222-4222-8222-222222222222', owner_id: ownerA, epoch: 1,
  slack_team_id: 'T1', channel_id: 'C1', thread_ts: '1.0', state: 'active',
  checkpoint_key: null, checkpoint_digest: null, checkpoint_bytes: null, reset_at: null, updated_at: new Date(0).toISOString() }
class CloudFixture {
  h = structuredClone(initial)
  bytes = new Uint8Array()
  events = new Map<string, { epoch: number; owner: string }>()
  publications = 0
}
class MemberClient extends CloudHandoffClient {
  constructor(private shared: CloudFixture, private owner: string, private bot: string) {
    super({ version: 1, url: 'https://example.supabase.co', publishableKey: 'sb_publishable_fixture', accessToken: 'fixture-access-token-only' })
  }
  override async member() { return { user_id: this.owner, space_id: initial.space_id, slack_team_id: 'T1', slack_bot_id: this.bot } }
  override async find() { return structuredClone(this.shared.h) }
  override async claim() {
    if (this.shared.h.owner_id !== this.owner || this.shared.h.state !== 'active') throw new Error('not owner')
    return this.find()
  }
  override async saving(h: CloudHandoff) {
    if (h.epoch !== this.shared.h.epoch || this.owner !== this.shared.h.owner_id) throw new Error('stale owner')
    this.shared.h.state = 'saving'; return this.find()
  }
  override async publish(h: CloudHandoff, bytes: Uint8Array) {
    this.shared.publications += 1
    if (h.epoch !== this.shared.h.epoch || this.owner !== this.shared.h.owner_id) throw new Error('stale owner')
    this.shared.bytes = new Uint8Array(bytes)
    this.shared.h = { ...this.shared.h, state: 'waiting', checkpoint_key: 'fixture', checkpoint_digest: digestBytes(bytes), checkpoint_bytes: bytes.length }
    return this.find()
  }
  override async download() { return this.shared.bytes }
  override async take(h: CloudHandoff, event: string) {
    const seen = this.shared.events.get(event)
    if (seen) {
      if (seen.epoch !== this.shared.h.epoch || seen.owner !== this.owner) throw new Error('stale event')
      return this.find()
    }
    if (h.epoch !== this.shared.h.epoch || this.shared.h.state !== 'waiting') throw new Error('not waiting')
    this.shared.h = { ...this.shared.h, epoch: h.epoch + 1, owner_id: this.owner, state: 'importing' }
    this.shared.events.set(event, { epoch: this.shared.h.epoch, owner: this.owner })
    return this.find()
  }
  override async activate(h: CloudHandoff) {
    if (h.epoch !== this.shared.h.epoch || this.shared.h.owner_id !== this.owner) throw new Error('stale owner')
    this.shared.h.state = 'active'; return this.find()
  }
}

test('two independent local workers transfer uncommitted work, attachments and output A -> B -> A', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-runtime-test-')); roots.push(root)
  const source = join(root, 'source'); mkdirSync(source)
  git(source, 'init', '--quiet')
  git(source, 'remote', 'add', 'origin', 'https://github.com/example/project.git')
  writeFileSync(join(source, 'file.txt'), 'base\n'); git(source, 'add', '.'); git(source, 'commit', '--quiet', '-m', 'base')
  const base = git(source, 'rev-parse', 'HEAD')
  const projectA = join(root, 'owned-A'); mkdirSync(projectA)
  const workA = join(projectA, 'project')
  git(source, 'worktree', 'add', '-b', 'fixture-task', workA, base)
  const stateA = join(root, 'state-A'), stateB = join(root, 'state-B')
  const storeA = new JobStore(join(stateA, 'jobs.sqlite3')), storeB = new JobStore(join(stateB, 'jobs.sqlite3'))
  try {
    const cloud = new CloudFixture()
    const runtimeA = new CloudRuntime(storeA, stateA, new MemberClient(cloud, ownerA, 'UA'), join(root, 'imports-A'))
    const runtimeB = new CloudRuntime(storeB, stateB, new MemberClient(cloud, ownerB, 'UB'), join(root, 'imports-B'))
    const attachment = join(stateA, 'input.txt'); writeFileSync(attachment, 'original attachment')
    storeA.enqueue({ chatId: 'C1', threadTs: '1.0', messageId: '1.0', userId: 'USER', repoPath: source,
      task: 'Finish the existing task', writeEnabled: true, attachments: [attachment] })
    const jobA = storeA.claimNext('worker-A')!
    storeA.bindCloudHandoff(jobA.id, cloud.h.id, 1, JSON.stringify(cloud.h))
    writeCheckpoint(join(stateA, 'cloud-workspaces', `${cloud.h.id}.json`), Buffer.from(JSON.stringify({ epoch: 1,
      project: projectA, repositories: [{ root: workA, name: 'project', base }] })))
    await runtimeA.prepare(jobA)
    writeFileSync(join(workA, 'file.txt'), 'staged\n'); git(workA, 'add', 'file.txt')
    writeFileSync(join(workA, 'file.txt'), 'unstaged-A\n')
    writeFileSync(join(workA, 'new.txt'), 'untracked-A\n')
    storeA.recordCloudContext(jobA.id, 'A-output', 'A investigated the cause; implementation is in progress.')
    await Promise.all([runtimeA.pause(jobA, undefined), runtimeA.pause(jobA, undefined)])
    expect(cloud.publications).toBe(1)
    expect(storeA.countClaimable(Date.now() + 999999999)).toBe(0)
    const request = { channel: 'C1', thread: '1.0', message: '2.0', user: 'USER', bot: 'UB',
      project: source, writeEnabled: true, action: 'handoff' as const }
    const validBytes = cloud.bytes
    const broken = JSON.parse(Buffer.from(validBytes).toString())
    broken.repositories[0].staged = 'invalid patch'
    cloud.bytes = Buffer.from(JSON.stringify(broken))
    await expect(runtimeB.receive(request)).rejects.toThrow('復元できません')
    expect(cloud.h.owner_id).toBe(ownerA)
    expect(cloud.h.state).toBe('waiting')
    expect(storeB.list()).toHaveLength(0)
    cloud.bytes = validBytes
    await runtimeB.receive(request)
    await runtimeB.receive(request)
    expect(storeB.list()).toHaveLength(1)
    await runtimeA.receive({ ...request, message: '2.1', bot: 'UA', action: 'continue' })
    expect(storeA.cloudHandoff(jobA.id)?.state).toBe('transferred')
    expect(storeA.list()).toHaveLength(1)
    const jobB = storeB.claimNext('worker-B')!
    const executionB = runtimeB.executionJob(jobB)
    const workB = executionB.repoPath
    expect(resolveProjectLayout(executionB.repoPath).gitRoots).toEqual([realpathSync(workB)])
    expect(() => buildCodexDeveloperInstructions(executionB, join(stateB, 'artifacts'))).not.toThrow()
    expect(readFileSync(join(workB, 'file.txt'), 'utf8')).toBe('unstaged-A\n')
    expect(git(workB, 'show', ':file.txt')).toBe('staged')
    expect(readFileSync(join(workB, 'new.txt'), 'utf8')).toBe('untracked-A\n')
    expect(readFileSync(jobB.attachments[0]!, 'utf8')).toBe('original attachment')
    expect(readFileSync(executionB.attachments.find(p => p.endsWith('/HANDOFF.md'))!, 'utf8')).toContain('A investigated')
    expect(git(workB, 'branch', '--show-current')).toContain('handoff-2')
    writeFileSync(join(workB, 'file.txt'), 'continued-B\n')
    storeB.recordCloudContext(jobB.id, 'B-output', 'B continued the existing implementation.')
    await runtimeB.pause(jobB, undefined)
    await runtimeA.receive({ ...request, bot: 'UA', message: '3.0' })
    const resumedA = storeA.claimNext('worker-A')!
    const executionA = runtimeA.executionJob(resumedA)
    expect(executionA.repoPath).not.toBe(projectA)
    expect(readFileSync(join(executionA.repoPath, 'file.txt'), 'utf8')).toBe('continued-B\n')
    expect(readFileSync(join(workA, 'file.txt'), 'utf8')).toBe('unstaged-A\n')
    const contextA = executionA.attachments.find(p => p.endsWith('/HANDOFF.md'))!
    expect(readFileSync(contextA, 'utf8')).toContain('B continued')
    expect(readFileSync(contextA, 'utf8')).toContain('A investigated')
    expect(cloud.h.epoch).toBe(3)
    expect(storeA.cloudHandoff(jobA.id)?.state).toBe('transferred')
  } finally { storeA.close(); storeB.close() }
})
