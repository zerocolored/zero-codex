import { expect, test } from 'bun:test'
import { computerUsePluginIsolationOverrides } from './codex-executor.ts'

const base = ['features.computer_use=true', 'features.plugins=true']
function enabled(config: Record<string, unknown>): Record<string, { enabled: boolean }> {
  const result = computerUsePluginIsolationOverrides(config, base, [{name:{type:'user'},config}])
  return (Bun.TOML.parse(result.find(value => value.startsWith('plugins='))!) as any).plugins
}

test('native Computer Use does not enable unrelated plugins or override operator disablement', () => {
  const plugins = enabled({ plugins: {
    'computer-use@openai-bundled': { enabled: true },
    'messages@openai-bundled': { enabled: true },
    'custom.plugin@local': { enabled: true },
  } })
  expect(plugins['computer-use@openai-bundled']?.enabled).toBe(true)
  expect(plugins['messages@openai-bundled']?.enabled).toBe(false)
  expect(plugins['custom.plugin@local']?.enabled).toBe(false)
  expect(enabled({ plugins: { 'computer-use@openai-bundled': { enabled: false } } })['computer-use@openai-bundled']?.enabled).toBe(false)
  expect(enabled({})['computer-use@openai-bundled']?.enabled).toBe(false)
})

test('review stages keep plugin isolation disabled', () => {
  const overrides = ['features.computer_use=false', 'features.plugins=false']
  expect(computerUsePluginIsolationOverrides({}, overrides)).toEqual(overrides)
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { installedComputerUseClient } from './installed-computer-use.ts'

test('native CUA resolver rejects project overlap and symlink transport replacements', () => {
  const root = mkdtempSync(join(tmpdir(), 'cua-runtime-'))
  const home = join(root, 'home'); const project = join(root, 'project')
  const client = join(home, 'computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient')
  mkdirSync(dirname(client), { recursive: true }); mkdirSync(project)
  writeFileSync(client, 'fixture', { mode: 0o700 })
  try {
    expect(installedComputerUseClient(home, project)).toBe(realpathSync(client))
    expect(installedComputerUseClient(home, home)).toBeUndefined()
    expect(installedComputerUseClient(home, dirname(client))).toBeUndefined()
    rmSync(client); symlinkSync('/usr/bin/true', client)
    expect(installedComputerUseClient(home, project)).toBeUndefined()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('project configuration cannot enable the native desktop plugin', () => {
  const config = { plugins: { 'computer-use@openai-bundled': { enabled: true } } }
  const output = computerUsePluginIsolationOverrides(config, base, [{ name: { type: 'project' }, config }])
  expect(output.find(value => value.startsWith('plugins='))).toContain('enabled=false')
})

import { mcpIsolationOverridesForConfig } from './codex-executor.ts'

test('native CUA transport uses installed client and retains operator disablement', () => {
  const root = mkdtempSync(join(tmpdir(), 'cua-transport-'))
  const home = join(root, 'home'); const project = join(root, 'project')
  const client = join(home, 'computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient')
  mkdirSync(dirname(client), { recursive: true }); mkdirSync(project)
  writeFileSync(client, 'fixture', { mode: 0o700 })
  const prior = process.env.CODEX_HOME; process.env.CODEX_HOME = home
  const config = { plugins: { 'computer-use@openai-bundled': { enabled: true } }, mcp_servers: { 'computer-use': { enabled: true, command: './stale-relative-client', args: ['mcp'] } } }
  const overrides = [...base, 'features.browser_use=false', 'features.browser_use_external=false', 'mcp_servers={}']
  const layers = [{name:{type:'user'},config}]
  const server = (cfg: any, flags = overrides, configLayers = layers) => {
    const result = mcpIsolationOverridesForConfig(cfg, flags, project, configLayers)
    return (Bun.TOML.parse(result.find(value => value.startsWith('mcp_servers='))!) as any).mcp_servers['computer-use']
  }
  try {
    expect(server(config).command).toBe(realpathSync(client))
    expect(server(config).enabled).toBe(true)
    expect(server(config).default_tools_approval_mode).toBeUndefined()
    expect(server({...config,mcp_servers:{'computer-use':{...config.mcp_servers['computer-use'],enabled:false}}}).enabled).toBe(false)
    expect(server(config, overrides.map(value => value === 'features.computer_use=true' ? 'features.computer_use=false' : value)).enabled).toBe(false)
    expect(server(config, overrides, [{name:{type:'project'},config}]).enabled).toBe(false)
  } finally {
    if (prior === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior
    rmSync(root, {recursive:true,force:true})
  }
})
