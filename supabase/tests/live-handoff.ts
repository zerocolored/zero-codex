/** Explicit integration check against two pre-enrolled validation identities.
 * Never loaded by bun test; credentials remain in owner-only config files.
 * Creates tiny synthetic checkpoints in the validation space (retained as
 * evidence), and isolated temporary local repositories only. No Slack API. */
import { strict as assert } from 'assert'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CloudHandoffClient, readCloudConfig } from '../../zerokun/cloud-handoff.ts'
import { CloudRuntime } from '../../zerokun/cloud-runtime.ts'
import { writeCheckpoint } from '../../zerokun/handoff-coordinator.ts'
import { JobStore } from '../../zerokun/job-runner.ts'

const [pathA, pathB] = process.argv.slice(2)
if (!pathA || !pathB) throw Error('Usage: bun supabase/tests/live-handoff.ts <validation-config-A> <validation-config-B>')
const a = new CloudHandoffClient(readCloudConfig(pathA), fetch, pathA)
const b = new CloudHandoffClient(readCloudConfig(pathB), fetch, pathB)
const [memberA, memberB] = await Promise.all([a.member(), b.member()])
assert.equal(memberA.slack_team_id, 'TVALIDATION')
assert.equal(memberB.slack_team_id, 'TVALIDATION')
assert.equal(memberA.space_id, memberB.space_id)
assert.notEqual(memberA.user_id, memberB.user_id)
const root = mkdtempSync(join(tmpdir(), 'zero-live-handoff-'))
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Handoff Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Handoff Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim()
}
const stateA = join(root, 'state-a'), stateB = join(root, 'state-b')
const storeA = new JobStore(join(stateA, 'jobs.sqlite3')), storeB = new JobStore(join(stateB, 'jobs.sqlite3'))
try {
  const source = join(root, 'source'); mkdirSync(source)
  git(source, 'init', '--quiet'); git(source, 'remote', 'add', 'origin', 'https://github.com/example/handoff-fixture.git')
  writeFileSync(join(source, 'code.txt'), 'baseline\n'); git(source, 'add', '.'); git(source, 'commit', '--quiet', '-m', 'fixture base')
  const base = git(source, 'rev-parse', 'HEAD')
  const project = join(root, 'owned-a'); mkdirSync(project)
  const work = join(project, 'repository')
  git(source, 'clone', '--no-hardlinks', source, work)
  git(work, 'remote', 'set-url', 'origin', 'https://github.com/example/handoff-fixture.git')
  const channel = 'CVALIDATION', thread = `${Math.floor(Date.now()/1000)}.${Math.floor(Math.random()*1_000_000).toString().padStart(6,'0')}`
  const h = await a.claim(channel, thread)
  const attachment = join(stateA, 'fixture.txt'); writeFileSync(attachment, 'synthetic retained attachment')
  storeA.enqueue({ chatId: channel, threadTs: thread, messageId: thread, userId: 'UVALIDATIONHUMAN', repoPath: source,
    task: 'Synthetic handoff validation only', writeEnabled: true, attachments: [attachment] })
  const jobA = storeA.claimNext('validation-a')!
  storeA.bindCloudHandoff(jobA.id, h.id, h.epoch, JSON.stringify(h))
  writeCheckpoint(join(stateA, 'cloud-workspaces', `${h.id}.json`), Buffer.from(JSON.stringify({ epoch: h.epoch,
    project, repositories: [{ root: work, name: 'repository', base }] })))
  const runtimeA = new CloudRuntime(storeA, stateA, a, join(root, 'imports-a'))
  const runtimeB = new CloudRuntime(storeB, stateB, b, join(root, 'imports-b'))
  writeFileSync(join(work, 'code.txt'), 'index-A\n'); git(work, 'add', 'code.txt')
  writeFileSync(join(work, 'code.txt'), 'worktree-A\n')
  writeFileSync(join(work, 'new.bin'), Buffer.from([0,1,2,255]))
  storeA.recordCloudContext(jobA.id, 'a-visible', 'A investigated the synthetic task.')
  await Promise.all([runtimeA.pause(jobA, Date.now()+3_600_000), runtimeA.pause(jobA, undefined)])
  const waiting = (await a.find(channel, thread))!
  assert.equal(waiting.state, 'waiting'); assert.equal(storeA.claimNext('validation-a'), null)
  const events = [`${channel}:${thread}1`, `${channel}:${thread}2`]
  const races = await Promise.allSettled(events.map(event => b.take(waiting, event)))
  assert.equal(races.filter(r => r.status === 'fulfilled').length, 1)
  const winner = races.findIndex(r => r.status === 'fulfilled')
  const message = events[winner]!.slice(channel.length+1)
  const control = { channel, thread, message, user: 'UVALIDATIONHUMAN', bot: memberB.slack_bot_id,
    project: source, writeEnabled: true, action: 'handoff' as const }
  await runtimeB.receive(control); await runtimeB.receive(control)
  assert.equal(storeB.list().length, 1)
  const jobB = storeB.claimNext('validation-b')!
  const executionB = runtimeB.executionJob(jobB)
  assert.equal(readFileSync(join(executionB.repoPath, 'code.txt'), 'utf8'), 'worktree-A\n')
  assert.equal(git(executionB.repoPath, 'show', ':code.txt'), 'index-A')
  assert.deepEqual(readFileSync(join(executionB.repoPath, 'new.bin')), Buffer.from([0,1,2,255]))
  assert.equal(readFileSync(jobB.attachments[0]!, 'utf8'), 'synthetic retained attachment')
  writeFileSync(join(executionB.repoPath, 'code.txt'), 'continued-B\n')
  storeB.recordCloudContext(jobB.id, 'b-visible', 'B continued the synthetic task.')
  await runtimeB.pause(jobB, Date.now()-1000)
  await runtimeA.receive({ ...control, bot: memberA.slack_bot_id, message: `${thread}3` })
  const back = storeA.claimNext('validation-a')!
  const executionA = runtimeA.executionJob(back)
  assert.equal(readFileSync(join(executionA.repoPath, 'code.txt'), 'utf8'), 'continued-B\n')
  const context = readFileSync(executionA.attachments.find(p => p.endsWith('/HANDOFF.md'))!, 'utf8')
  assert.ok(context.includes('A investigated') && context.includes('B continued'))
  assert.equal(readFileSync(join(work, 'code.txt'), 'utf8'), 'worktree-A\n')
  assert.equal((await a.find(channel, thread))?.epoch, 3)
  console.log(JSON.stringify({ status: 'live-handoff-passed', handoffId: h.id, epoch: 3,
    checks: ['Auth/RLS member access','immutable Storage upload/download','single-winner concurrent take',
      'import retry idempotency','index/worktree/binary/attachment restoration','A-B-A visible context','original workspace preserved'],
    limitations: 'two independent local workers with real Supabase; no real Slack or second physical PC' }))
} finally {
  storeA.close(); storeB.close()
  rmSync(root, { recursive: true, force: true })
}
