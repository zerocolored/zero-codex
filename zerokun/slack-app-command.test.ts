import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runSlackAppCommand } from './slack-app-command.ts'
import { listRegisteredSlackApps } from './slack-app-registry.ts'
import { readProjectChannelConfig, mutateProjectChannelConfig } from './project-channel-config.ts'
import { registerSlackApp } from './slack-app-registry.ts'
import { prepareManagedStateRoot } from './managed-path.ts'
import { JobStore } from './job-runner.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'zero-register-app-')))
  roots.push(home)
  const outside = join(home, 'outside'); mkdirSync(outside)
  const project = join(home, 'project'); mkdirSync(project)
  expect(Bun.spawnSync(['/usr/bin/git', 'init', '-q', project]).exitCode).toBe(0)
  return { home, outside, project }
}
test('register once outside a project, then select without asking for credentials again', async () => {
  const { home, outside, project } = fixture()
  const bot = 'xoxb-synthetic-only-12345'
  const app = 'xapp-1-ATEST-synthetic-only-12345'
  const inputs = [bot, app]
  const messages: string[] = []
  await runSlackAppCommand(outside, { home, installWatchdog: () => {}, input: async () => inputs.shift()!, output: text => messages.push(text), verify: async () => ({ appId: 'ATEST' }) })
  expect(existsSync(join(outside, '.zerochan'))).toBe(false)
  const record = listRegisteredSlackApps(home)[0]!
  expect(statSync(join(record.stateDir, '.env')).mode & 0o777).toBe(0o600)
  expect(readFileSync(join(record.stateDir, '.env'), 'utf8')).toContain(bot)
  let prompts = 0
  await runSlackAppCommand(project, { home, installWatchdog: () => {}, input: async () => { prompts++; return '1' }, output: text => messages.push(text), verify: async () => { throw new Error('must not reverify') } })
  expect(prompts).toBe(1)
  expect(readProjectChannelConfig(project).slackAppId).toBe('ATEST')
  expect(messages.join('')).not.toContain(bot)
  expect(messages.join('')).not.toContain(app)
})
test('authentication failure leaves no registration and does not expose provider errors', async () => {
  const { home, outside } = fixture()
  const secret = 'xoxb-synthetic-only-12345'
  await expect(runSlackAppCommand(outside, { home, input: async () => secret, verify: async () => { throw new Error(secret) }, output: () => {} })).rejects.toThrow('既存設定は変更していません')
  expect(listRegisteredSlackApps(home)).toEqual([])
})

test('explicit selection transfers legacy channel routes without asking for tokens again', async () => {
  const { home, project } = fixture()
  const old = prepareManagedStateRoot(join(home, 'old'))
  const next = prepareManagedStateRoot(join(home, 'next'))
  registerSlackApp('AOLD', old, home)
  registerSlackApp('AZNEW', next, home)
  new JobStore(join(next, 'jobs.sqlite3')).close()
  mutateProjectChannelConfig({ operation: 'set', repoPath: project, stateDir: old, appId: 'AOLD', channelId: 'COLD' })
  const hooks = { home, output: () => {}, installWatchdog: () => {} }
  await runSlackAppCommand(project, { ...hooks, input: async () => 'AZNEW', verify: async () => { throw new Error('must not reverify') } })
  expect(readProjectChannelConfig(project).slackAppId).toBe('AZNEW')
  const oldStore = new JobStore(join(old, 'jobs.sqlite3'))
  const nextStore = new JobStore(join(next, 'jobs.sqlite3'))
  expect(oldStore.resolveSlackChannelRoute('AOLD', 'COLD')).toBeNull()
  expect(nextStore.resolveSlackChannelRoute('AZNEW', 'COLD')).toBe(project)
  oldStore.close(); nextStore.close()
  await runSlackAppCommand(project, { ...hooks, input: async () => '1' })
  expect(readProjectChannelConfig(project).slackAppId).toBe('AOLD')
  expect(readProjectChannelConfig(project).slackChannels).toEqual(['COLD'])
})

test('an unregistered App ID continues into hidden token registration for that exact app', async () => {
  const { home, project } = fixture()
  registerSlackApp('AOLD', prepareManagedStateRoot(join(home, 'old')), home)
  const inputs = ['  ANEW  ', 'xoxb-synthetic-only-12345', 'xapp-1-ANEW-synthetic-only-12345']
  const echoes: Array<boolean | undefined> = []
  const output: string[] = []
  await runSlackAppCommand(project, {
    home, installWatchdog: () => {},
    input: async (_, options) => { echoes.push(options?.echo); return inputs.shift()! },
    output: text => output.push(text), verify: async () => ({ appId: 'ANEW' }),
  })
  expect(inputs).toEqual([])
  expect(echoes).toEqual([true, undefined, undefined])
  expect(output.join('')).toContain('ANEW は未登録です')
  expect(output.join('')).not.toContain('synthetic-only')
  expect(readProjectChannelConfig(project).slackAppId).toBe('ANEW')
  expect(listRegisteredSlackApps(home).map(app => app.appId)).toEqual(['ANEW', 'AOLD'])
  expect(statSync(join(home, '.codex/zerochan-apps/states/ANEW/.env')).mode & 0o777).toBe(0o600)
})

for (const stage of ['token-id', 'verified-id', 'malformed-token'] as const) {
  test(`App ID registration rejects ${stage} before saving or switching`, async () => {
    const { home, project } = fixture()
    const old = prepareManagedStateRoot(join(home, 'old'))
    registerSlackApp('AOLD', old, home)
    mutateProjectChannelConfig({ operation: 'set', repoPath: project, stateDir: old, appId: 'AOLD', channelId: 'COLD' })
    const before = readProjectChannelConfig(project)
    const token = stage === 'malformed-token' ? 'invalid-synthetic-token'
      : `xapp-1-${stage === 'token-id' ? 'AOTHER' : 'ANEW'}-synthetic-only-12345`
    const inputs = ['ANEW', 'xoxb-synthetic-only-12345', token]
    let verifications = 0
    await expect(runSlackAppCommand(project, {
      home, input: async () => inputs.shift()!, output: () => {},
      verify: async () => { verifications++; return { appId: 'AOTHER' } },
      prepare: () => { throw new Error('must not prepare') },
      installWatchdog: () => { throw new Error('must not install') },
    })).rejects.toThrow(stage === 'malformed-token' ? 'App-Level Tokenの形式が不正です' : '指定した App ID とトークンのアプリが一致しません')
    expect(verifications).toBe(stage === 'verified-id' ? 1 : 0)
    expect(readProjectChannelConfig(project)).toEqual(before)
    expect(listRegisteredSlackApps(home).map(app => app.appId)).toEqual(['AOLD'])
    expect(existsSync(join(home, '.codex/zerochan-apps/states'))).toBe(false)
    const store = new JobStore(join(old, 'jobs.sqlite3'))
    expect(store.resolveSlackChannelRoute('AOLD', 'COLD')).toBe(project)
    store.close()
  })
}

test('invalid selections retry without reflecting their contents, then accept a number', async () => {
  const { home, outside } = fixture()
  registerSlackApp('ATEST', prepareManagedStateRoot(join(home, 'old')), home)
  const inputs = ['', '0', '2', '999999999999999999999999', '1.0', 'xoxb-synthetic-only-12345', '1']
  const messages: string[] = []
  await runSlackAppCommand(outside, {
    home, input: async () => { if (!inputs.length) throw new Error('unexpected prompt'); return inputs.shift()! },
    output: text => messages.push(text),
    verify: async () => { throw new Error('must not verify') },
  })
  expect(inputs).toEqual([])
  expect(messages.filter(text => text.includes('入力してください'))).toHaveLength(6)
  expect(messages.join('')).not.toContain('synthetic-only')
  expect(messages.join('')).toContain('Slackアプリ登録: ATEST')
})

test('cancelling a retried selection does not prepare or change the project', async () => {
  const { home, project } = fixture()
  registerSlackApp('ATEST', prepareManagedStateRoot(join(home, 'old')), home)
  let prompts = 0
  await expect(runSlackAppCommand(project, {
    home, output: () => {}, input: async () => { if (++prompts === 1) return '0'; throw new Error('入力を中止しました') },
    prepare: () => { throw new Error('must not prepare') },
  })).rejects.toThrow('入力を中止しました')
  expect(prompts).toBe(2)
  expect(readProjectChannelConfig(project).slackAppId).toBeUndefined()
})
