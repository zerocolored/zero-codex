import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { prepareManagedStateRoot } from './managed-path.ts'
import { legacyCutoverForState } from './state-dir.ts'
import { adoptLegacySlackApp, listRegisteredSlackApps, registerSlackApp, slackAppRegistryRoot } from './slack-app-registry.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'zero-app-registry-')))
  roots.push(home)
  return { home, state: prepareManagedStateRoot(join(home, 'state')) }
}
test('registration is reusable across projects without copying credentials', () => {
  const { home, state } = fixture()
  expect(listRegisteredSlackApps(home)).toEqual([])
  const first = registerSlackApp('A123ABC', state, home)
  expect(registerSlackApp('A123ABC', state, home)).toEqual(first)
  expect(listRegisteredSlackApps(home)).toEqual([first])
  const path = join(slackAppRegistryRoot(home), 'A123ABC.json')
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort()).toEqual(['appId', 'stateDir', 'version'])
})
test('same app cannot silently move to a second state; distinct apps remain separate', () => {
  const { home, state } = fixture()
  const second = prepareManagedStateRoot(join(home, 'second'))
  registerSlackApp('A123ABC', state, home)
  expect(() => registerSlackApp('A123ABC', second, home)).toThrow('登録済み')
  registerSlackApp('A456DEF', second, home)
  expect(listRegisteredSlackApps(home).map(app => app.stateDir)).toEqual([state, second])
  expect(() => registerSlackApp('../escape', state, home)).toThrow()
  chmodSync(join(slackAppRegistryRoot(home), 'A123ABC.json'), 0o644)
  expect(() => listRegisteredSlackApps(home)).toThrow()
})

test('legacy adoption preserves credentials and queued data in their original state', () => {
  const { home } = fixture()
  const state = prepareManagedStateRoot(join(home, '.codex/zerokun'))
  const content = 'SLACK_BOT_TOKEN=xoxb-synthetic-123456\nSLACK_APP_TOKEN=xapp-1-ALEGACY-synthetic-123456\n'
  writeFileSync(join(state, '.env'), content, { mode: 0o600 })
  writeFileSync(join(state, 'jobs.sqlite3'), 'preserve-me', { mode: 0o600 })
  expect(adoptLegacySlackApp(home)?.stateDir).toBe(state)
  expect(adoptLegacySlackApp(home)?.appId).toBe('ALEGACY')
  expect(readFileSync(join(state, '.env'), 'utf8')).toBe(content)
  expect(readFileSync(join(state, 'jobs.sqlite3'), 'utf8')).toBe('preserve-me')
  expect(listRegisteredSlackApps(home)).toHaveLength(1)
})

test('cutover installation is adopted at its original state and new app does not inherit its cutover flag', () => {
  const { home } = fixture()
  const old = prepareManagedStateRoot(join(home, '.claude/channels/slack'))
  writeFileSync(join(old, '.env'), 'SLACK_BOT_TOKEN=xoxb-synthetic-123456\nSLACK_APP_TOKEN=xapp-1-AOLD-synthetic-123456\n', { mode: 0o600 })
  const adopted = adoptLegacySlackApp(home, { ZEROKUN_STATE_DIR: old, ZEROKUN_LEGACY_CUTOVER: '1' })
  expect(adopted?.stateDir).toBe(old)
  expect(adopted?.appId).toBe('AOLD')
  expect(legacyCutoverForState(old, home)).toBe('1')
  const current = prepareManagedStateRoot(join(home, '.codex/zerochan-apps/states/ANEW'))
  expect(legacyCutoverForState(current, home)).toBe('0')
})
