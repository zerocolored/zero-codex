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

test('legacy channel routes cannot silently be copied into a different app', async () => {
  const { home, project } = fixture()
  const old = prepareManagedStateRoot(join(home, 'old'))
  const next = prepareManagedStateRoot(join(home, 'next'))
  registerSlackApp('AOLD', old, home)
  registerSlackApp('AZNEW', next, home)
  new JobStore(join(next, 'jobs.sqlite3')).close()
  mutateProjectChannelConfig({ operation: 'set', repoPath: project, stateDir: old, appId: 'AOLD', channelId: 'COLD' })
  const hooks = { home, output: () => {}, installWatchdog: () => {} }
  await expect(runSlackAppCommand(project, { ...hooks, input: async () => '2' })).rejects.toThrow('zerochan unset slack-channel')
  expect(readProjectChannelConfig(project).slackAppId).toBeUndefined()
  await runSlackAppCommand(project, { ...hooks, input: async () => '1' })
  expect(readProjectChannelConfig(project).slackAppId).toBe('AOLD')
  expect(readProjectChannelConfig(project).slackChannels).toEqual(['COLD'])
})
