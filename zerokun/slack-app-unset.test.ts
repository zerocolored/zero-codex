import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore } from './job-runner.ts'
import { bindProjectSlackApp, mutateProjectChannelConfig, readProjectChannelConfig, switchProjectSlackApp, unsetProjectSlackApp } from './project-channel-config.ts'
import { resolveProjectAppState } from './project-app-state.ts'
import { assertSlackProjectAdmission, isSlackProjectStop, SlackProjectDisconnectedError } from './slack-project-admission.ts'
import { detachedProjectStatus } from './slack-app-unset.ts'
import { registerSlackApp } from './slack-app-registry.ts'
import { Database } from 'bun:sqlite'
import { releaseProcessLock, tryAcquireProcessLock } from './process-lock.ts'

const roots: string[] = []
const stores: JobStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-unset-app-')))
  roots.push(root)
  const project = join(root, 'project'), other = join(root, 'other'), state = join(root, 'state')
  mkdirSync(state, { mode: 0o700 })
  for (const path of [project, other]) { mkdirSync(path); expect(Bun.spawnSync(['git', 'init', '-q', path]).exitCode).toBe(0) }
  const apps = [{ appId: 'ATEST', stateDir: state }]
  bindProjectSlackApp(project, 'ATEST')
  mutateProjectChannelConfig({ repoPath: project, stateDir: state, appId: 'ATEST', operation: 'set', channelId: 'COWN' })
  mutateProjectChannelConfig({ repoPath: other, stateDir: state, appId: 'ATEST', operation: 'set', channelId: 'COTHER' })
  const store = new JobStore(join(state, 'jobs.sqlite3')); stores.push(store)
  const input = { chatId: 'COWN', threadTs: '1800000000.000100', messageId: '1800000000.000100', userId: 'UUSER', repoPath: project, text: 'work', writeEnabled: true }
  store.stageInboundDeliveryAndAdoptSlackThread(input, { appId: 'ATEST', initialContextEligible: false })
  return { root, project, other, state, apps, store, input }
}

test('unset is project-only, durable, idempotent and cannot silently fall back', () => {
  const f = fixture()
  const credential = join(f.state, '.env')
  writeFileSync(credential, 'synthetic-credential-fixture', { mode: 0o600 })
  unsetProjectSlackApp(f.project, f.apps)
  unsetProjectSlackApp(f.project, f.apps)
  expect(readProjectChannelConfig(f.project)).toEqual({ version: 1, slackAppId: null, slackChannels: [] })
  expect(detachedProjectStatus(f.project)).toContain('未設定（解除済み）')
  expect(() => resolveProjectAppState(f.project, f.state, f.root)).toThrow(SlackProjectDisconnectedError)
  expect(f.store.resolveSlackChannelRoute('ATEST', 'COWN')).toBeNull()
  expect(f.store.resolveSlackChannelRoute('ATEST', 'COTHER')).toBe(f.other)
  expect(f.store.listThreads()).toHaveLength(1)
  expect(f.store.claimNextInboundDelivery()?.repoPath).toBe(f.project)
  expect(readFileSync(credential, 'utf8')).toBe('synthetic-credential-fixture')
  expect(() => mutateProjectChannelConfig({ repoPath: f.project, stateDir: f.state, appId: 'ATEST', operation: 'sync' })).toThrow()
})

test('existing threads, DM, delayed route reads and live steering refuse new tasks; accepted stop stays available', () => {
  const f = fixture()
  // A gateway may resolve its route before the CLI changes it. Staging rechecks.
  const route = f.store.resolveSlackThreadRoute({ appId: 'ATEST', chatId: 'COWN', threadTs: f.input.threadTs, defaultRepoPath: f.other })
  const job = f.store.enqueue({ ...f.input, messageId: 'accepted-job', task: 'already accepted' }).job
  f.store.claimNext('worker')
  const target = f.store.liveControlTarget(job.chatId, job.threadTs)!
  unsetProjectSlackApp(f.project, f.apps)
  expect(() => f.store.stageInboundDeliveryAndAdoptSlackThread({ ...f.input, messageId: '1800000000.000200' }, { appId: 'ATEST', initialContextEligible: false, expectedRepoPath: route.repoPath })).toThrow(SlackProjectDisconnectedError)
  expect(() => f.store.stageInboundDeliveryAndAdoptSlackThread({ ...f.input, chatId: 'DDM', messageId: '1800000000.000300' }, { appId: 'ATEST', initialContextEligible: false })).toThrow(SlackProjectDisconnectedError)
  expect(() => f.store.stageInboundDeliveryForControl({ ...f.input, messageId: '1800000000.000400' }, target)).toThrow(SlackProjectDisconnectedError)
  expect(f.store.stageInboundDeliveryForControl({ ...f.input, messageId: '1800000000.000500', isInterrupt: true, text: 'stop' }, target)).toBe('bound')
  expect(() => f.store.stageInboundDelivery({ ...f.input, messageId: '1800000000.000600', isInterrupt: true })).toThrow(SlackProjectDisconnectedError)
  expect(f.store.stageInboundDeliveryAndAdoptSlackThread(f.input, { appId: 'ATEST', initialContextEligible: false }).outcome).toBe('duplicate')
  expect(f.store.stageInboundDelivery({ ...f.input, repoPath: f.other, chatId: 'COTHER', messageId: '1800000000.000700' })).toBe(true)
})

test.each(['中止', '<@UBOT> 中止', '<@UBOT|Zeroちゃん> 中止'])('detached thread stop reaches exact authority validation: %s', text => {
  const f = fixture()
  const job = f.store.enqueue({ ...f.input, messageId: 'accepted-job', task: 'accepted' }).job
  f.store.claimNext('worker')
  const target = f.store.liveControlTarget(job.chatId, job.threadTs)!
  unsetProjectSlackApp(f.project, f.apps)
  expect(isSlackProjectStop(text, 'UBOT')).toBe(true)
  expect(isSlackProjectStop('<@UBOT> 新しい依頼', 'UBOT')).toBe(false)
  expect(f.store.stageInboundDeliveryForControl({ ...f.input, messageId: 'stop-event', text, isInterrupt: isSlackProjectStop(text, 'UBOT') }, target)).toBe('bound')
})

test('reconnecting keeps channels empty and rejects offline posts but accepts fresh posts', () => {
  const f = fixture()
  unsetProjectSlackApp(f.project, f.apps)
  const offlineTs = String((Date.now() - 10) / 1000)
  switchProjectSlackApp(f.project, 'ATEST', f.apps)
  const config = readProjectChannelConfig(f.project)
  expect(config.slackChannels).toEqual([])
  expect(config.slackAppId).toBe('ATEST')
  expect(() => assertSlackProjectAdmission(f.project, offlineTs)).toThrow(SlackProjectDisconnectedError)
  expect(f.store.stageInboundDeliveryAndAdoptSlackThread({ ...f.input, messageId: String((Date.now() + 10) / 1000) }, { appId: 'ATEST', initialContextEligible: false }).outcome).toBe('staged')
  mutateProjectChannelConfig({ repoPath: f.project, stateDir: f.state, appId: 'ATEST', operation: 'set', channelId: 'COWN' })
  expect(readProjectChannelConfig(f.project).slackAcceptAfter).toBe(config.slackAcceptAfter)
  switchProjectSlackApp(f.project, 'ATEST', f.apps)
  expect(readProjectChannelConfig(f.project).slackAcceptAfter).toBe(config.slackAcceptAfter)
})

test('offline stop is not replayed against a job after reconnect', () => {
  const f = fixture()
  unsetProjectSlackApp(f.project, f.apps)
  const offlineTs = String((Date.now() - 10) / 1000)
  switchProjectSlackApp(f.project, 'ATEST', f.apps)
  const job = f.store.enqueue({ ...f.input, messageId: 'new-job', task: 'new accepted job' }).job
  f.store.claimNext('worker')
  const target = f.store.liveControlTarget(job.chatId, job.threadTs)!
  expect(() => f.store.stageInboundDeliveryForControl({ ...f.input, messageId: offlineTs, text: '中止', isInterrupt: true }, target)).toThrow(SlackProjectDisconnectedError)
  expect(f.store.stageInboundDeliveryForControl({ ...f.input, messageId: String((Date.now() + 10) / 1000), text: '中止', isInterrupt: true }, target)).toBe('bound')
  unsetProjectSlackApp(f.project, f.apps)
  expect(() => f.store.stageInboundDeliveryForControl({ ...f.input, messageId: offlineTs, text: '中止', isInterrupt: true }, target)).toThrow(SlackProjectDisconnectedError)
})

test('failed route cleanup stays fail-closed and rerunning unset repairs it', () => {
  const f = fixture()
  const fail = spyOn(JobStore.prototype, 'syncSlackChannelRoutes').mockImplementation(() => { throw new Error('synthetic disk failure') })
  try { expect(() => unsetProjectSlackApp(f.project, f.apps)).toThrow('synthetic disk failure') } finally { fail.mockRestore() }
  expect(existsSync(join(f.project, '.zerochan', 'slack-app-unset.json'))).toBe(true)
  expect(() => assertSlackProjectAdmission(f.project, f.input.messageId)).toThrow(SlackProjectDisconnectedError)
  expect(() => switchProjectSlackApp(f.project, 'ATEST', f.apps)).toThrow('unset slack-app')
  // Registering an additional app before retry must not strand the journal.
  const next = join(f.root, 'newly-registered'); mkdirSync(next, { mode: 0o700 })
  unsetProjectSlackApp(f.project, [...f.apps, { appId: 'ANEW', stateDir: next }])
  expect(existsSync(join(f.project, '.zerochan', 'slack-app-unset.json'))).toBe(false)
  expect(f.store.resolveSlackChannelRoute('ATEST', 'COWN')).toBeNull()
})

test('legacy all-app unset journal does not impose runtime support on unrelated apps', () => {
  const f = fixture()
  const other = join(f.root, 'old-unrelated'); mkdirSync(other, { mode: 0o700 })
  const old = join(f.root, 'old-runtime'); mkdirSync(old)
  writeFileSync(join(other, 'legacy-runtime.json'), JSON.stringify({ version: 1, path: old }), { mode: 0o600 })
  const apps = [...f.apps, { appId: 'AOTHER', stateDir: other }]
  const journal = join(f.project, '.zerochan', 'slack-app-unset.json')
  writeFileSync(journal, JSON.stringify({ version: 1, repoPath: f.project, apps }), { mode: 0o600 })
  unsetProjectSlackApp(f.project, apps)
  expect(readProjectChannelConfig(f.project).slackAppId).toBeNull()
  expect(existsSync(journal)).toBe(false)
})

test('pre-feature pinned runtime refuses before detaching', () => {
  const f = fixture()
  const oldRoot = join(f.root, 'old-runtime'); mkdirSync(oldRoot)
  writeFileSync(join(f.state, 'legacy-runtime.json'), JSON.stringify({ version: 1, path: oldRoot }), { mode: 0o600 })
  expect(() => unsetProjectSlackApp(f.project, f.apps)).toThrow('zerochan update')
  expect(readProjectChannelConfig(f.project).slackAppId).toBe('ATEST')
  expect(f.store.resolveSlackChannelRoute('ATEST', 'COWN')).toBe(f.project)
  expect(existsSync(join(f.project, '.zerochan', 'slack-app-unset.json'))).toBe(false)
})

test('legacy fallback is explicitly detached without changing the other project', () => {
  const f = fixture()
  expect(readProjectChannelConfig(f.other).slackAppId).toBeUndefined()
  expect(resolveProjectAppState(f.other, f.state, f.root)).toBe(f.state)
  unsetProjectSlackApp(f.other, f.apps)
  expect(() => resolveProjectAppState(f.other, f.state, f.root)).toThrow(SlackProjectDisconnectedError)
  expect(f.store.resolveSlackChannelRoute('ATEST', 'COWN')).toBe(f.project)
  expect(f.store.resolveSlackChannelRoute('ATEST', 'COTHER')).toBeNull()
})

test('historical app threads also stop receiving after a switch and unset', () => {
  const f = fixture()
  const next = join(f.root, 'next'); mkdirSync(next, { mode: 0o700 })
  const apps = [...f.apps, { appId: 'ANEXT', stateDir: next }]
  switchProjectSlackApp(f.project, 'ANEXT', apps)
  unsetProjectSlackApp(f.project, apps)
  expect(() => f.store.stageInboundDeliveryAndAdoptSlackThread({ ...f.input, messageId: '1800000000.000200' }, { appId: 'ATEST', initialContextEligible: false })).toThrow(SlackProjectDisconnectedError)
  expect(f.store.resolveSlackChannelRoute('ATEST', 'COTHER')).toBe(f.other)
  expect(f.store.listThreads()[0]?.repoPath).toBe(f.project)
})

test('unrelated app update and route lock do not block detach or migrate its database', () => {
  const f = fixture()
  const other = join(f.root, 'unrelated'); mkdirSync(other, { mode: 0o700 })
  const path = join(other, 'jobs.sqlite3')
  const db = new Database(path)
  db.exec('CREATE TABLE unrelated (value TEXT)'); db.close()
  const before = readFileSync(path)
  const marker = join(other, 'update-transaction.json')
  writeFileSync(marker, '{}', { mode: 0o600 })
  const lock = join(other, 'channel-route.lock')
  const held = tryAcquireProcessLock(lock)
  expect(held.acquired).toBe(true)
  if (!held.acquired) throw new Error('fixture lock failed')
  try {
    unsetProjectSlackApp(f.project, [...f.apps, { appId: 'AOTHER', stateDir: other }])
    expect(readProjectChannelConfig(f.project).slackAppId).toBeNull()
    expect(readFileSync(path)).toEqual(before)
    expect(readFileSync(marker, 'utf8')).toBe('{}')
    expect(existsSync(lock)).toBe(true)
  } finally { releaseProcessLock(lock, held.lease) }
})

test.each(['malformed-json', 'invalid-operation'])('unrelated route journal is not validated or recovered during discovery: %s', kind => {
  const f = fixture()
  const other = join(f.root, 'unrelated'); mkdirSync(other, { mode: 0o700 })
  const path = join(other, 'channel-route-transaction.json')
  const raw = kind === 'malformed-json' ? '{' : JSON.stringify({ repoPath: f.other, beforeChannels: ['invalid-channel'] })
  writeFileSync(path, raw, { mode: 0o600 })
  unsetProjectSlackApp(f.project, [...f.apps, { appId: 'AOTHER', stateDir: other }])
  expect(readProjectChannelConfig(f.project).slackAppId).toBeNull()
  expect(readFileSync(path, 'utf8')).toBe(raw)
  expect(existsSync(join(other, 'jobs.sqlite3'))).toBe(false)
})

test('discovery waits for an unrelated temporary SQLite write lock', async () => {
  const f = fixture()
  const other = join(f.root, 'unrelated'); mkdirSync(other, { mode: 0o700 })
  const path = join(other, 'jobs.sqlite3')
  const db = new Database(path); db.exec('CREATE TABLE unrelated (value TEXT)'); db.close()
  const child = Bun.spawn([process.execPath, '--config=/dev/null', '--no-env-file', '-e',
    "import {Database} from 'bun:sqlite'; const db=new Database(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked'); await Bun.sleep(300); db.exec('COMMIT'); db.close();", path],
  { stdout: 'pipe', stderr: 'pipe' })
  try {
    const reader = child.stdout.getReader()
    const ready = await reader.read(); reader.releaseLock()
    expect(new TextDecoder().decode(ready.value)).toContain('locked')
    unsetProjectSlackApp(f.project, [...f.apps, { appId: 'AOTHER', stateDir: other }])
    expect(readProjectChannelConfig(f.project).slackAppId).toBeNull()
    expect(await child.exited).toBe(0)
  } finally { if (child.exitCode === null) child.kill(); await child.exited }
})

test('unsupported runtime is rejected before schema migration or shared-app journal recovery', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-unset-preflight-'))); roots.push(root)
  const project = join(root, 'project'), state = join(root, 'state'), old = join(root, 'old')
  for (const path of [project, state, old]) mkdirSync(path, { mode: 0o700 })
  expect(Bun.spawnSync(['git', 'init', '-q', project]).exitCode).toBe(0)
  bindProjectSlackApp(project, 'ATEST')
  const dbPath = join(state, 'jobs.sqlite3')
  const db = new Database(dbPath); db.exec('CREATE TABLE untouched (value TEXT)'); db.close()
  const before = readFileSync(dbPath)
  const journalPath = join(state, 'channel-route-transaction.json')
  const journal = JSON.stringify({ version: 1, operation: 'sync', appId: 'ATEST', repoPath: project, beforeChannels: [], afterChannels: [], createdAt: Date.now() })
  writeFileSync(journalPath, journal, { mode: 0o600 })
  writeFileSync(join(state, 'legacy-runtime.json'), JSON.stringify({ version: 1, path: old }), { mode: 0o600 })
  expect(() => unsetProjectSlackApp(project, [{ appId: 'ATEST', stateDir: state }])).toThrow('zerochan update')
  expect(readFileSync(dbPath)).toEqual(before)
  expect(readFileSync(journalPath, 'utf8')).toBe(journal)
  expect(readProjectChannelConfig(project).slackAppId).toBe('ATEST')
})

test('related app update still prevents detach before any config or routes change', () => {
  const f = fixture()
  writeFileSync(join(f.state, 'update-transaction.json'), '{}', { mode: 0o600 })
  expect(() => unsetProjectSlackApp(f.project, f.apps)).toThrow('更新中')
  expect(readProjectChannelConfig(f.project).slackAppId).toBe('ATEST')
  expect(f.store.resolveSlackChannelRoute('ATEST', 'COWN')).toBe(f.project)
  expect(existsSync(join(f.project, '.zerochan', 'slack-app-unset.json'))).toBe(false)
})

test('historical owner update remains in scope after switching to another app', () => {
  const f = fixture()
  const next = join(f.root, 'next'); mkdirSync(next, { mode: 0o700 })
  const apps = [...f.apps, { appId: 'ANEXT', stateDir: next }]
  switchProjectSlackApp(f.project, 'ANEXT', apps)
  writeFileSync(join(f.state, 'update-transaction.json'), '{}', { mode: 0o600 })
  expect(() => unsetProjectSlackApp(f.project, apps)).toThrow('更新中')
  expect(readProjectChannelConfig(f.project).slackAppId).toBe('ANEXT')
})

test('cloud controls are blocked when new; accepted cloud controls can finish', () => {
  const f = fixture()
  const control = { channel: 'COWN', thread: f.input.threadTs, message: '1800000000.000200', user: 'UUSER', bot: 'UBOT', project: f.project, writeEnabled: true, action: 'handoff' as const }
  f.store.stageCloudControl(control)
  unsetProjectSlackApp(f.project, f.apps)
  expect(() => f.store.stageCloudControl({ ...control, message: '1800000000.000300' })).toThrow(SlackProjectDisconnectedError)
  expect(() => f.store.finishCloudControlWithMessage(control, 'accepted result')).not.toThrow()
  expect(f.store.pendingCloudControls()).toEqual([])
})

test('CLI detached status and invalid arguments work without credentials or pinned runtime', () => {
  const f = fixture()
  registerSlackApp('ATEST', f.state, f.root)
  const command = join(f.root, 'zerochan')
  symlinkSync(join(import.meta.dir, '..', 'codex-channel.sh'), command)
  const run = (...args: string[]) => Bun.spawnSync(['bash', command, ...args], { cwd: f.project, env: { ...process.env, HOME: f.root, ZEROKUN_STATE_DIR: f.state } })
  const unset = run('unset', 'slack-app')
  expect(unset.exitCode, unset.stderr.toString()).toBe(0)
  expect(unset.stdout.toString()).toContain('紐付けを解除しました')
  expect(run('unset', 'slack-app').exitCode).toBe(0)
  const status = run('status')
  expect(status.exitCode, status.stderr.toString()).toBe(0)
  expect(status.stdout.toString()).toContain('未設定（解除済み）')
  expect(run('unset', 'slack-app', 'extra').exitCode).toBe(2)
  expect(run('start').stderr.toString()).toContain('zerochan set slack-app')
  expect(run('unset', '--help').stdout.toString()).toContain('zerochan unset slack-app')
})
