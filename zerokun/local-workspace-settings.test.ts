import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { provisionLocalWorkspaceSettings } from './local-workspace-settings.ts'
import { captureRepository } from './handoff-package.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-settings-')); roots.push(root)
  const source = join(root, 'source'), target = join(root, 'target')
  for (const path of [source, target]) {
    mkdirSync(path); git(path, 'init', '-q')
    git(path, 'config', 'user.email', 'fixture@example.com'); git(path, 'config', 'user.name', 'Fixture')
    git(path, 'remote', 'add', 'origin', 'https://github.com/example/app.git')
    writeFileSync(join(path, 'app.txt'), 'base')
    git(path, 'add', '.'); git(path, 'commit', '-qm', 'base')
  }
  return { source, target }
}
test('provisions opaque local keys owner-only, preserves source, Git and cloud capture exclude them', () => {
  const { source, target } = fixture()
  writeFileSync(join(source, '.env.keys'), 'synthetic-local-key', { mode: 0o644 })
  const before = lstatSync(join(source, '.env.keys'))
  const head = git(target, 'rev-parse', 'HEAD')
  expect(provisionLocalWorkspaceSettings(source, target)).toBe('ready')
  expect(readFileSync(join(target, '.env.keys'), 'utf8')).toBe('synthetic-local-key')
  expect(lstatSync(join(target, '.env.keys')).mode & 0o777).toBe(0o600)
  expect(lstatSync(join(source, '.env.keys')).mode).toBe(before.mode)
  expect(git(target, 'status', '--porcelain')).toBe('')
  git(target, 'add', '.')
  expect(git(target, 'ls-files', '.env.keys')).toBe('')
  expect(JSON.stringify(captureRepository(target, 'app', head))).not.toContain('synthetic-local-key')
  expect(provisionLocalWorkspaceSettings(source, target)).toBe('ready')
  expect(git(target, 'rev-parse', 'HEAD')).toBe(head)
})
test('existing workspace setting is never overwritten', () => {
  const { source, target } = fixture()
  writeFileSync(join(source, '.env.keys'), 'source-new')
  writeFileSync(join(target, '.env.keys'), 'workspace-owned')
  expect(provisionLocalWorkspaceSettings(source, target)).toBe('ready')
  expect(readFileSync(join(target, '.env.keys'), 'utf8')).toBe('workspace-owned')
})
test('missing key does not fail unrelated work or invent credentials', () => {
  const { source, target } = fixture()
  expect(provisionLocalWorkspaceSettings(source, target)).toBe('missing')
  expect(existsSync(join(target, '.env.keys'))).toBe(false)
})
test('wrong repository and tracked key are not provisioned', () => {
  const { source, target } = fixture()
  writeFileSync(join(source, '.env.keys'), 'source-only')
  git(target, 'remote', 'set-url', 'origin', 'https://github.com/example/other.git')
  expect(provisionLocalWorkspaceSettings(source, target)).toBe('unavailable')
  expect(existsSync(join(target, '.env.keys'))).toBe(false)
  git(target, 'remote', 'set-url', 'origin', 'https://github.com/example/app.git')
  writeFileSync(join(target, '.env.keys'), 'tracked-fixture'); git(target, 'add', '.env.keys')
  expect(provisionLocalWorkspaceSettings(source, target)).toBe('unavailable')
  expect(readFileSync(join(target, '.env.keys'), 'utf8')).toBe('tracked-fixture')
})
test('source and destination symlinks are not followed', () => {
  const { source, target } = fixture()
  symlinkSync(join(source, 'app.txt'), join(source, '.env.keys'))
  expect(provisionLocalWorkspaceSettings(source, target)).toBe('unavailable')
  expect(existsSync(join(target, '.env.keys'))).toBe(false)
  symlinkSync(join(target, 'app.txt'), join(target, '.env.keys'))
  expect(provisionLocalWorkspaceSettings(source, target)).toBe('unavailable')
  expect(readFileSync(join(target, 'app.txt'), 'utf8')).toBe('base')
})

test('repository ignore negation cannot expose a copied key to Git', () => {
  const { source, target } = fixture()
  writeFileSync(join(source, '.env.keys'), 'synthetic-do-not-stage')
  writeFileSync(join(target, '.gitignore'), '!.env.keys\n')
  expect(provisionLocalWorkspaceSettings(source, target)).toBe('unavailable')
  expect(existsSync(join(target, '.env.keys'))).toBe(false)
  git(target, 'add', '.')
  expect(git(target, 'ls-files', '.env.keys')).toBe('')
})

test('linked worktree does not change the source repository exclude settings', () => {
  const { source, target } = fixture()
  const linked = join(target, 'linked')
  git(source, 'worktree', 'add', '-b', 'fixture-linked', linked)
  writeFileSync(join(source, '.env.keys'), 'synthetic-local')
  const before = readFileSync(join(source, '.git/info/exclude'), 'utf8')
  expect(provisionLocalWorkspaceSettings(source, linked)).toBe('unavailable')
  expect(readFileSync(join(source, '.git/info/exclude'), 'utf8')).toBe(before)
  expect(existsSync(join(linked, '.env.keys'))).toBe(false)
})

test('same working directory without key reports missing, not ready', () => {
  const { source } = fixture()
  expect(provisionLocalWorkspaceSettings(source, source)).toBe('missing')
})

test.skipIf(!Bun.which('dotenvx'))('real dotenvx strict loading fails without key and decrypts after provisioning, without network', () => {
  const { source, target } = fixture()
  writeFileSync(join(source, '.env'), 'ZERO_SYNTHETIC_PROBE=fixture-value\n')
  const encrypt = Bun.spawnSync(['dotenvx', 'encrypt', '-f', '.env'], { cwd: source, stdout: 'pipe', stderr: 'pipe' })
  expect(encrypt.exitCode).toBe(0)
  copyFileSync(join(source, '.env'), join(target, '.env'))
  const command = ['dotenvx', 'run', '--strict', '--', 'node', '-e', 'process.exit(process.env.ZERO_SYNTHETIC_PROBE === "fixture-value" ? 0 : 41)']
  const before = Bun.spawnSync(command, { cwd: target, stdout: 'pipe', stderr: 'pipe' })
  expect(before.exitCode).not.toBe(0)
  // dotenvx 2.20 reports missing decryption keys as DECRYPTION_FAILED.
  // The nonzero-before / zero-after assertions remain the behavioral contract.
  expect(before.stderr.toString()).toMatch(/\[(?:MISSING_PRIVATE_KEY|DECRYPTION_FAILED)\]/)
  expect(provisionLocalWorkspaceSettings(source, target)).toBe('ready')
  const after = Bun.spawnSync(command, { cwd: target, stdout: 'pipe', stderr: 'pipe' })
  expect(after.exitCode).toBe(0)
  expect(after.stderr.toString()).not.toContain('MISSING_PRIVATE_KEY')
})
