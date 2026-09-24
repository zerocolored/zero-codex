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
import { installedComputerUseClient, installedComputerUseNodeRepl } from './installed-computer-use.ts'

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

import { mcpIsolationOverridesForConfig, trustedComputerUseNodeTransport } from './codex-executor.ts'

test('official Node runtime rejects project overlap and substituted executable', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cua-node-')))
  const app = join(root, 'ChatGPT.app'); const project = join(root, 'project')
  const client = join(app, 'Contents/Resources/cua_node/bin/node_repl')
  mkdirSync(dirname(client), {recursive:true}); mkdirSync(project)
  writeFileSync(client, 'fixture', {mode:0o700})
  try {
    expect(installedComputerUseNodeRepl(project, client, app)).toBe(true)
    expect(installedComputerUseNodeRepl(root, client, app)).toBe(false)
    expect(installedComputerUseNodeRepl(dirname(client), client, app)).toBe(false)
    expect(installedComputerUseNodeRepl(project, '/usr/bin/true', app)).toBe(false)
    rmSync(client); symlinkSync('/usr/bin/true', client)
    expect(installedComputerUseNodeRepl(project, client, app)).toBe(false)
  } finally {rmSync(root, {recursive:true,force:true})}
})

test('desktop Node connection requires operator provenance and honors disablement', () => {
  const server = {enabled:true,command:'/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl'}
  const layer = (type: string, setting = server) => ({name:{type},config:{mcp_servers:{node_repl:setting}}})
  expect(trustedComputerUseNodeTransport(server, [layer('user')])).toBe(true)
  expect(trustedComputerUseNodeTransport(server, [])).toBe(false)
  expect(trustedComputerUseNodeTransport(server, [layer('sessionFlags')])).toBe(false)
  expect(trustedComputerUseNodeTransport(server, [layer('user'),layer('project')])).toBe(false)
  expect(trustedComputerUseNodeTransport(server, [layer('user',{...server,enabled:false})])).toBe(false)
  expect(trustedComputerUseNodeTransport({...server,enabled:false}, [layer('user')])).toBe(false)
})

test('desktop Node connection preserves host metadata only for authorized primary work', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cua-node-config-')))
  const server = {enabled:true,command:'/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl',args:[],env:{NODE_REPL_TRUSTED_SERVICES:'fixture'},tools:{js:{approval_mode:'prompt'}}}
  const config = {plugins:{'computer-use@openai-bundled':{enabled:true}},mcp_servers:{node_repl:server}}
  const layers = [{name:{type:'user'},config}]
  const flags = [...base, 'features.browser_use=false', 'features.browser_use_external=false', 'mcp_servers={}']
  const result = (overrides=flags, provenance=layers) => {
    const values=mcpIsolationOverridesForConfig(config, overrides, root, provenance)
    return (Bun.TOML.parse(values.find(v=>v.startsWith('mcp_servers='))!) as any).mcp_servers.node_repl
  }
  try {
    if (installedComputerUseNodeRepl(root, server.command)) expect(result()).toEqual(server)
    expect(result(flags.map(v=>v==='features.computer_use=true'?'features.computer_use=false':v)).enabled).toBe(false)
    expect(result(flags,[...layers,{name:{type:'project'},config}]).enabled).toBe(false)
    expect(result(flags,[]).enabled).toBe(false)
  } finally {rmSync(root,{recursive:true,force:true})}
})

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
