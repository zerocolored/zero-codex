import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { resolveGoogleCloudRuntime } from './google-cloud-runtime.ts'
import { buildCodexPermissionOverrides } from './codex-executor.ts'
import { ensureManagedDirectory, prepareManagedStateRoot } from './managed-path.ts'
import type { JobRecord } from './job-runner.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-cli-test-')))
  roots.push(root)
  const home = join(root, 'home')
  const sdk = join(home, 'google-cloud-sdk')
  const config = join(home, '.config/gcloud')
  const repo = join(root, 'repo')
  for (const dir of [join(sdk, 'bin'), join(sdk, 'lib'), config, repo]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(sdk, 'lib/gcloud.py'), '# synthetic SDK only\n')
  writeFileSync(join(config, 'synthetic-credential'), 'fixture-only\n')
  writeFileSync(join(sdk, 'bin/gcloud'), '#!/bin/sh\nset -eu\ntest "$(cat "$CLOUDSDK_CONFIG/synthetic-credential")" = fixture-only\nprintf refreshed > "$CLOUDSDK_CONFIG/synthetic-cache"\nprintf cli-auth-and-cache-ok\n', { mode: 0o700 })
  const state = prepareManagedStateRoot(join(root, 'state'))
  const scratch = ensureManagedDirectory(state, join(state, 'scratch'))
  const artifact = ensureManagedDirectory(state, join(state, 'artifact'))
  const runtime = resolveGoogleCloudRuntime({ home, path: join(sdk, 'bin'), config })!
  const job = { repoPath: repo, writeEnabled: true, attachments: [] } as unknown as JobRecord
  const options = { stateDir: state, scratchDir: scratch, artifactDir: artifact,
    nativeCloudAccessEnabled: true, googleCloudRuntime: runtime, multiAgentEnabled: false }
  return { root, home, sdk, config, repo, state, scratch, runtime, job, options }
}

test('resolves installed SDK and existing configuration without credential contents', () => {
  const f = fixture()
  expect(f.runtime).toEqual({ bin: join(f.sdk, 'bin'), readPaths: [f.sdk], config: f.config })
  const aliases = join(f.root, 'aliases'); mkdirSync(aliases)
  symlinkSync(join(f.sdk, 'bin/gcloud'), join(aliases, 'gcloud'))
  expect(resolveGoogleCloudRuntime({ home: f.home, path: aliases, config: f.config })).toEqual(f.runtime)
  expect(resolveGoogleCloudRuntime({ home: f.home, path: '', config: f.home })?.config).toBeNull()
  expect(resolveGoogleCloudRuntime({ home: f.home, path: '', config: join(f.home, 'missing') })?.config).toBeNull()
  expect(resolveGoogleCloudRuntime({ home: f.home, path: '/usr/bin:/bin', config: f.config,
    installedCandidates: [join(aliases, 'gcloud')] })).toEqual(f.runtime)
})

test('does not grant an arbitrary executable wrapper parent as an SDK', () => {
  const f = fixture(); const bin = join(f.root, 'wrapper'); mkdirSync(bin)
  writeFileSync(join(bin, 'gcloud'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'gcloud'), 0o700)
  expect(resolveGoogleCloudRuntime({ home: f.home, path: bin, config: f.config })).toBeNull()
})

test('native auth is primary-only and cannot reopen managed state or repository roots', () => {
  const f = fixture()
  const settings = buildCodexPermissionOverrides(f.job, f.options).join('\n')
  expect(settings).toContain(`${JSON.stringify(f.config)}="write"`)
  expect(settings).toContain(`"CLOUDSDK_CONFIG"=${JSON.stringify(f.config)}`)
  expect(settings).toContain(`${JSON.stringify(realpathSync(homedir()))}="deny"`)
  expect(settings).toContain(`${JSON.stringify(f.state)}="deny"`)
  for (const [job, options] of [
    [{ ...f.job, writeEnabled: false }, f.options],
    [f.job, { ...f.options, executionWriteEnabled: false }],
    [f.job, { ...f.options, nativeCloudAccessEnabled: false }],
  ] as const) {
    const isolated = buildCodexPermissionOverrides(job, options).join('\n')
    expect(isolated).not.toContain('"CLOUDSDK_CONFIG"=')
    expect(isolated).not.toContain(`${JSON.stringify(f.config)}="write"`)
  }
  for (const forbidden of [f.state, f.repo, f.root]) {
    const isolated = buildCodexPermissionOverrides(f.job, { ...f.options,
      googleCloudRuntime: { ...f.runtime, config: forbidden } }).join('\n')
    expect(isolated).not.toContain('"CLOUDSDK_CONFIG"=')
  }
})

test.skipIf(process.platform !== 'darwin' || !Bun.which('codex'))(
  'real Codex sandbox runs native CLI/cache refresh while unrelated state stays denied', () => {
    const f = fixture()
    writeFileSync(join(f.state, 'unrelated'), 'must stay hidden')
    const overrides = buildCodexPermissionOverrides(f.job, f.options)
    const setting = overrides.find(value => value.startsWith('shell_environment_policy.set='))!
    const env = (Bun.TOML.parse(setting) as any).shell_environment_policy.set
    const result = Bun.spawnSync(['codex', 'sandbox', ...overrides.flatMap(value => ['-c', value]),
      '-P', 'zerokun_job', '-C', f.repo, '--', '/usr/bin/env', '-i',
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      '/bin/sh', '-c', 'gcloud && if cat "$1" >/dev/null 2>&1; then exit 99; fi',
      'probe', join(f.state, 'unrelated')], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toBe('cli-auth-and-cache-ok')
    expect(readFileSync(join(f.config, 'synthetic-cache'), 'utf8')).toBe('refreshed')
    const readOnly = buildCodexPermissionOverrides({ ...f.job, writeEnabled: false }, f.options)
    const denied = Bun.spawnSync(['codex', 'sandbox', ...readOnly.flatMap(value => ['-c', value]),
      '-P', 'zerokun_job', '-C', f.repo, '--', '/bin/cat', join(f.config, 'synthetic-credential')],
    { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    expect(denied.exitCode).not.toBe(0)
    expect(denied.stdout.toString()).toBe('')
  }, 35_000,
)
