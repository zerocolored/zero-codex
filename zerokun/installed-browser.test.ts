import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installedGoChromeEntrypoint } from './installed-browser.ts'
import { mcpIsolationOverridesForConfig } from './codex-executor.ts'

const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-installed-chrome-')))
  roots.push(root)
  const runtime = join(root, 'zero', 'zerokun'), project = join(root, 'project'), browser = join(root, 'go-chrome-mcp')
  for (const p of [runtime, project, browser]) mkdirSync(p, { recursive: true, mode: 0o700 })
  writeFileSync(join(browser, 'mcp-broker.js'), '// installed', { mode: 0o600 })
  writeFileSync(join(browser, 'package.json'), JSON.stringify({ name: 'go-chrome-mcp' }), { mode: 0o600 })
  writeFileSync(join(browser, 'manifest.json'), JSON.stringify({ name: 'Go Chrome MCP', manifest_version: 3 }), { mode: 0o600 })
  return { root, runtime, project, browser }
}
const overrides = ['mcp_servers={}', 'features.browser_use=true', 'features.browser_use_external=true']
function isolated(f: ReturnType<typeof fixture>, config: Record<string, unknown>, flags = overrides) {
  const result = mcpIsolationOverridesForConfig(config, flags, f.project, [], f.runtime)
  return (Bun.TOML.parse('value='+result.find(x=>x.startsWith('mcp_servers='))!.slice(12)) as any).value
}
test('standard installed Chrome is provided without host registration while desktop REPL stays disabled', () => {
  const f=fixture()
  const servers=isolated(f,{mcp_servers:{node_repl:{command:'/host/repl'}}})
  expect(servers['go-chrome-mcp'].enabled).toBe(true)
  expect(servers['go-chrome-mcp'].args).toContain(join(f.browser,'mcp-broker.js'))
  expect(servers.node_repl.enabled).toBe(false)
  expect(isolated(f,{})['go-chrome-mcp'].enabled).toBe(true)
})
test('explicit host opt-out and read/history turns never gain Chrome access', () => {
  const f=fixture()
  expect(isolated(f,{mcp_servers:{'go-chrome-mcp':{command:'node',args:['/custom/browser.js'],enabled:false}}})['go-chrome-mcp'].enabled).toBe(false)
  expect(isolated(f,{},['mcp_servers={}','features.browser_use=false','features.browser_use_external=false'])['go-chrome-mcp']).toBeUndefined()
})
test('missing, task-controlled, writable, symlinked or unrelated neighbor is not executed', () => {
  const f=fixture()
  expect(installedGoChromeEntrypoint(f.runtime,f.root)).toBeUndefined()
  chmodSync(join(f.browser,'mcp-broker.js'),0o666)
  expect(installedGoChromeEntrypoint(f.runtime,f.project)).toBeUndefined()
  rmSync(join(f.browser,'mcp-broker.js'))
  symlinkSync(join(f.browser,'package.json'),join(f.browser,'mcp-broker.js'))
  expect(installedGoChromeEntrypoint(f.runtime,f.project)).toBeUndefined()
  rmSync(f.browser,{recursive:true})
  expect(isolated(f,{})['go-chrome-mcp']).toBeUndefined()
})
