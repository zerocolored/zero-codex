import { afterEach, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { linkDeploymentCliConfig, resolveDeploymentCliConfigs } from './deployment-cli-runtime.ts'
import { buildCodexPermissionOverrides } from './codex-executor.ts'
import { ensureManagedDirectory, prepareManagedStateRoot } from './managed-path.ts'
import type { JobRecord } from './job-runner.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deployment-cli-test-')))
  roots.push(root)
  const home = join(root, 'home'), repo = join(root, 'repo')
  for (const path of [home, repo, join(home, '.railway'), join(home, 'Library/Preferences/.wrangler')]) {
    mkdirSync(path, { recursive: true })
  }
  for (const path of [join(home, '.railway'), join(home, 'Library/Preferences/.wrangler')]) {
    writeFileSync(join(path, 'synthetic-config'), 'fixture-only', { mode: 0o600 })
  }
  const configs = resolveDeploymentCliConfigs({ home, platform: 'darwin', xdgConfigHome: join(home, 'Library/Preferences') })
  const state = prepareManagedStateRoot(join(root, 'state'))
  const scratch = ensureManagedDirectory(state, join(state, 'scratch'))
  const artifact = ensureManagedDirectory(state, join(state, 'artifact'))
  const job = { repoPath: repo, writeEnabled: true, attachments: [] } as unknown as JobRecord
  const options = { stateDir: state, scratchDir: scratch, artifactDir: artifact,
    nativeCloudAccessEnabled: true, googleCloudRuntime: null, deploymentCliConfigs: configs, multiAgentEnabled: false }
  return { root, home, repo, configs, state, scratch, job, options }
}

test('RailwayとWranglerの実設定ディレクトリだけをmetadataで検出する', () => {
  const f = fixture()
  expect(f.configs).toEqual([
    { name: 'railway', directory: join(f.home, '.railway') },
    { name: 'wrangler', directory: join(f.home, 'Library/Preferences/.wrangler') },
  ])
  mkdirSync(join(f.home, '.wrangler'))
  expect(resolveDeploymentCliConfigs({ home: f.home, platform: 'darwin' })[1]?.directory).toBe(join(f.home, '.wrangler'))
  rmSync(join(f.home, '.wrangler'), { recursive: true })
  symlinkSync(f.root, join(f.home, '.wrangler'))
  expect(resolveDeploymentCliConfigs({ home: f.home, platform: 'darwin' }).map(x => x.name)).toEqual(['railway'])
})

test('書込みprimaryだけで接続し既存ファイルや別のリンクを上書きしない', () => {
  const f = fixture()
  for (const options of [{ ...f.options, nativeCloudAccessEnabled: false }, { ...f.options, executionWriteEnabled: false }]) {
    expect(buildCodexPermissionOverrides(f.job, options).join('\n')).not.toContain(`${JSON.stringify(f.configs[0]!.directory)}="write"`)
    expect(() => lstatSync(join(f.scratch, '.railway'))).toThrow()
  }
  const settings = buildCodexPermissionOverrides(f.job, f.options).join('\n')
  expect(settings).toContain(`"HOME"=${JSON.stringify(realpathSync(homedir()))}`)
  for (const config of f.configs) {
    expect(settings).toContain(`${JSON.stringify(config.directory)}="write"`)
    expect(readlinkSync(join(f.scratch, `.${config.name}`))).toBe(config.directory)
    expect(linkDeploymentCliConfig(f.state, f.scratch, config)).toBe(true)
  }
  rmSync(join(f.scratch, '.railway'))
  mkdirSync(join(f.scratch, '.railway'))
  writeFileSync(join(f.scratch, '.railway/owned'), 'preserve')
  expect(linkDeploymentCliConfig(f.state, f.scratch, f.configs[0]!)).toBe(false)
  expect(readFileSync(join(f.scratch, '.railway/owned'), 'utf8')).toBe('preserve')
  for (const forbidden of [f.state, f.repo, f.root]) {
    const result = buildCodexPermissionOverrides(f.job, { ...f.options,
      deploymentCliConfigs: [{ name: 'railway', directory: forbidden }] }).join('\n')
    const withoutGrant = buildCodexPermissionOverrides(f.job, { ...f.options, deploymentCliConfigs: [] }).join('\n')
    expect(result).toBe(withoutGrant)
  }
})

test.skipIf(process.platform !== 'darwin' || !Bun.which('codex'))(
  '実sandboxでもCLI設定を参照・更新できるがread-only段には引き継がない', () => {
    const f = fixture()
    const overrides = buildCodexPermissionOverrides(f.job, f.options)
    const setting = overrides.find(value => value.startsWith('shell_environment_policy.set='))!
    // This test exercises the legacy scratch links using synthetic credentials only.
    const env = { ...(Bun.TOML.parse(setting) as any).shell_environment_policy.set, HOME: f.scratch }
    const run = (overrides: string[], command: string) => Bun.spawnSync(['codex', 'sandbox',
      ...overrides.flatMap(value => ['-c', value]), '-P', 'zerokun_job', '-C', f.repo, '--',
      '/usr/bin/env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      '/bin/sh', '-c', command], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    const command = 'set -eu; for name in railway wrangler; do test "$(cat "$HOME/.$name/synthetic-config")" = fixture-only; printf refreshed > "$HOME/.$name/synthetic-cache"; done; printf auth-paths-ok'
    const result = run(overrides, command)
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toBe('auth-paths-ok')
    for (const config of f.configs) expect(readFileSync(join(config.directory, 'synthetic-cache'), 'utf8')).toBe('refreshed')
    // Existing scratch links alone cannot authorize read-only/advisor access.
    const isolated = buildCodexPermissionOverrides({ ...f.job, writeEnabled: false }, f.options)
    const denied = run(isolated, command)
    expect(denied.exitCode).not.toBe(0)
    expect(denied.stdout.toString()).toBe('')
  }, 35_000,
)
