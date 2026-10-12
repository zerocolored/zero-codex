import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { prepareManagedStateRoot } from './managed-path.ts'
import { bindProjectSlackApp } from './project-channel-config.ts'
import { registerSlackApp } from './slack-app-registry.ts'
import { assertProjectRuntimeCompatible, resolveProjectAppState } from './project-app-state.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
test('project binding selects its own App regardless of stale default state', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'zero-select-app-')))
  roots.push(home)
  const projects = ['one', 'two'].map(name => {
    const path = join(home, name)
    mkdirSync(path)
    expect(Bun.spawnSync(['/usr/bin/git', 'init', '-q', path]).exitCode).toBe(0)
    return path
  })
  const stateA = prepareManagedStateRoot(join(home, 'state-a'))
  const stateB = prepareManagedStateRoot(join(home, 'state-b'))
  expect(resolveProjectAppState(projects[0]!, stateA, home)).toBe(stateA)
  registerSlackApp('AONE', stateA, home)
  registerSlackApp('ATWO', stateB, home)
  bindProjectSlackApp(projects[0]!, 'AONE')
  bindProjectSlackApp(projects[1]!, 'ATWO')
  expect(resolveProjectAppState(projects[0]!, stateB, home)).toBe(stateA)
  expect(resolveProjectAppState(projects[1]!, stateA, home)).toBe(stateB)
  expect(() => resolveProjectAppState(projects[0]!, stateA, join(home, 'other-pc'))).toThrow('未登録')
})


test('runtime compatibility leaves legacy defaults usable and preserves the reconnect boundary', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-runtime-config-')))
  roots.push(root)
  const project = join(root, 'project')
  const runtime = join(root, 'old-runtime')
  mkdirSync(project); mkdirSync(runtime)
  expect(() => assertProjectRuntimeCompatible(project, runtime)).not.toThrow()
  mkdirSync(join(project, '.zerochan'), { mode: 0o700 })
  const config = join(project, '.zerochan/config.json')
  writeFileSync(config, JSON.stringify({ version: 1, slackChannels: [], slackAppId: 'ATEST' }), { mode: 0o600 })
  expect(() => assertProjectRuntimeCompatible(project, runtime)).not.toThrow()
  writeFileSync(config, JSON.stringify({ version: 1, slackChannels: [], slackAppId: 'ATEST', slackAcceptAfter: 12345 }))
  expect(() => assertProjectRuntimeCompatible(project, runtime)).toThrow('zerochan update')
  mkdirSync(join(runtime, 'zerokun'))
  writeFileSync(join(runtime, 'zerokun/slack-project-admission.ts'), '')
  expect(() => assertProjectRuntimeCompatible(project, runtime)).not.toThrow()
})
