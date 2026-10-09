import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { projectPrimaryCore, setProjectPrimaryCore } from './project-channel-config.ts'
import { startWithSelectedCore } from './core-command.ts'
import { claudeMainlineEnvironment } from './claude-mainline-runtime.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test('public core command selects only the current project without Slack setup', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-core-command-'))); roots.push(root)
  expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0)
  const launcher = join(root, 'zerochan')
  symlinkSync(resolve(import.meta.dir, '../codex-channel.sh'), launcher)
  const invoke = (...args: string[]) => Bun.spawnSync(['/bin/bash', launcher, ...args], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const selected = invoke('set', 'core', 'claude')
  expect(selected.exitCode, selected.stderr.toString()).toBe(0)
  expect(selected.stdout.toString()).toContain('zerochan start')
  expect(projectPrimaryCore(root)).toEqual({ desired: 'claude-code', active: 'codex' })
  expect(invoke('set', 'core', 'unknown').exitCode).not.toBe(0)
  expect(projectPrimaryCore(root).desired).toBe('claude-code')
  expect(invoke('set', 'core').stderr.toString()).toContain('codex|claude')
  expect(invoke('set', 'core', 'codex').exitCode).toBe(0)
  expect(projectPrimaryCore(root)).toEqual({ desired: 'codex', active: 'codex' })
})

test('native Claude environment preserves keychain context without inheriting credentials or another session', () => {
  const environment = claudeMainlineEnvironment({ HOME: '/synthetic/home', USER: 'fixture', LOGNAME: 'fixture', PATH: '/usr/bin:/bin',
    __CF_USER_TEXT_ENCODING: 'fixture', ANTHROPIC_API_KEY: 'not-a-real-key', SLACK_BOT_TOKEN: 'not-a-real-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'not-a-real-token', CLAUDECODE: 'foreign-session', NODE_OPTIONS: '--require bad.js' })
  expect(environment.USER).toBe('fixture')
  expect(environment.LOGNAME).toBe('fixture')
  expect(environment.HOME).toBe('/synthetic/home')
  expect(environment.__CF_USER_TEXT_ENCODING).toBe('fixture')
  for (const key of ['ANTHROPIC_API_KEY', 'SLACK_BOT_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'NODE_OPTIONS']) expect(environment[key]).toBeUndefined()
})

test('explicit start activates only after preflight and service readiness, including already-running service', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-core-start-'))); roots.push(root)
  expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0)
  setProjectPrimaryCore(root, 'claude-code')
  const events: string[] = []
  await expect(startWithSelectedCore(root, async () => { throw Error('not ready') }, () => events.push('preflight'))).rejects.toThrow('not ready')
  expect(projectPrimaryCore(root).active).toBe('codex')
  await expect(startWithSelectedCore(root, async () => { events.push('started') }, () => { throw Error('not logged in') })).rejects.toThrow('not logged in')
  expect(events).toEqual(['preflight'])
  await startWithSelectedCore(root, async () => {
    expect(projectPrimaryCore(root).active).toBe('codex')
    return { status: 'already-running' }
  }, () => {})
  expect(projectPrimaryCore(root).active).toBe('claude-code')
  await expect(startWithSelectedCore(root, async () => { setProjectPrimaryCore(root, 'codex') }, () => {})).rejects.toThrow('起動中')
  expect(projectPrimaryCore(root)).toEqual({ desired: 'codex', active: 'claude-code' })
})
