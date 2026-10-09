import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { browserRuntimeContext, stageBrowserRuntime } from './browser-runtime-context.ts'
import dialogTransport from './fixtures/browser-dialog-transport.json'
import { browserDialogCompatibility } from './browser-dialog-compat.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-browser-context-'))); roots.push(root)
  const home = join(root, 'custom-codex-home'), project = join(root, 'project')
  mkdirSync(project)
  const install = (version: string, family = 'browser') => {
    const scripts = join(home, 'plugins/cache/openai-bundled', family, version, 'scripts')
    mkdirSync(scripts, { recursive: true })
    for (const file of ['browser-service.mjs', 'browser-client.mjs']) writeFileSync(join(scripts, file), '// fixture')
    return scripts
  }
  const selected = install('26.928.31416')
  const overrides = (service = join(selected, 'browser-service.mjs')) => [
    'features.plugins=true', 'features.browser_use=true', 'features.browser_use_external=true',
    'plugins={"chrome@openai-bundled"={enabled=true}}',
    `mcp_servers={node_repl={enabled=true,env={NODE_REPL_TRUSTED_SERVICES=${JSON.stringify(JSON.stringify({ browser: service }))}}}}`,
  ]
  return { root, home, project, selected, install, overrides,
    context: (args = overrides()) => browserRuntimeContext(args, project, home) }
}

test('new and resumed executions use the host-selected runtime after a cache update', () => {
  const f = fixture()
  const old = f.install('26.915.31945', 'chrome')
  const first = f.context(f.overrides(join(old, 'browser-service.mjs')))
  expect(first).toContain(join(old, 'browser-client.mjs'))
  rmSync(dirname(old), { recursive: true })
  f.install('99.999.99999') // A newer cache does not override the host selection.
  const resumed = f.context()
  expect(resumed).toContain(join(f.selected, 'browser-client.mjs'))
  expect(resumed).not.toContain('26.915.31945')
  expect(resumed).not.toContain('99.999.99999')
  expect(resumed).toContain('supersedes')
  expect(f.context(f.overrides(join(old, 'browser-service.mjs')))).toBe('')
})

test('absent, disabled, read-only and untrusted runtime configurations never advertise a client', () => {
  const f = fixture()
  for (const [from, to] of [
    ['features.plugins=true', 'features.plugins=false'],
    ['features.browser_use=true', 'features.browser_use=false'],
    ['features.browser_use_external=true', 'features.browser_use_external=false'],
    ['plugins={"chrome@openai-bundled"={enabled=true}}', 'plugins={"chrome@openai-bundled"={enabled=false}}'],
  ]) expect(f.context(f.overrides().map(x => x === from ? to! : x))).toBe('')
  expect(f.context(f.overrides().map(x => x.startsWith('mcp_servers=') ? 'mcp_servers={node_repl={enabled=false}}' : x))).toBe('')
  expect(f.context(f.overrides('/tmp/browser-service.mjs'))).toBe('')
  expect(f.context(['malformed TOML'])).toBe('')
  expect(browserRuntimeContext(f.overrides(), f.home, f.home)).toBe('')
})

test('a selected client must exist in the same safe installation as its service', () => {
  const f = fixture(), client = join(f.selected, 'browser-client.mjs')
  chmodSync(client, 0o666); expect(f.context()).toBe('')
  rmSync(client); symlinkSync(join(f.selected, 'browser-service.mjs'), client)
  expect(f.context()).toBe('')
  rmSync(client); expect(f.context()).toBe('')
})

test('browser-only selection uses its service without granting Chrome or mutating overrides', () => {
  const f = fixture()
  const args = f.overrides().filter(x => !x.startsWith('plugins=') && !x.startsWith('features.browser_use_external='))
  args.push('features.browser_use_external=false', 'features.in_app_browser=true', 'plugins={"browser@openai-bundled"={enabled=true}}')
  const before = JSON.stringify(args)
  expect(f.context(args)).toContain(join(f.selected, 'browser-client.mjs'))
  expect(JSON.stringify(args)).toBe(before)
})

function stagingFixture() {
  const f = fixture(), family = dirname(dirname(f.selected)), temp = join(f.root, 'job-temp')
  mkdirSync(temp, { mode: 0o700 })
  const destination = join(temp, 'browser-runtime-attempt')
  const input = [...f.overrides(), 'default_permissions="probe"',
    `permissions.probe.filesystem={${JSON.stringify(f.home)}="deny",${JSON.stringify(family)}="read",${JSON.stringify(temp)}="read"}`]
  return { ...f, input, destination, stage: (args = input) => stageBrowserRuntime(args, 'probe', f.project, destination, f.home) }
}

test('staging uses selected public code while keeping private state denied and native server metadata', () => {
  const f = stagingFixture()
  writeFileSync(join(f.home, 'auth.json'), 'private fixture')
  writeFileSync(join(dirname(f.selected), 'operator-private'), 'private fixture')
  const args = f.input.map(x => x.startsWith('mcp_servers=')
    ? x.replace('enabled=true,env=', 'enabled=true,command="official-node",startup_timeout_sec=45,approval_policy="auto-review",env=') : x)
  const before = JSON.stringify(args)
  let cleanup: (() => void) | undefined
  const output = stageBrowserRuntime(args, 'probe', f.project, f.destination, f.home, fn => { cleanup = fn })
  const config = Bun.TOML.parse(output.join('\n')) as any
  expect(config.permissions.probe.filesystem[f.home]).toBe('deny')
  expect(config.permissions.probe.filesystem[f.destination]).toBe('read')
  const server = config.mcp_servers.node_repl
  expect(server.command).toBe('official-node'); expect(server.startup_timeout_sec).toBe(45)
  expect(server.approval_policy).toBe('auto-review')
  expect(JSON.parse(server.env.NODE_REPL_TRUSTED_SERVICES).browser).toBe(join(f.destination, 'scripts/browser-service.mjs'))
  expect(readFileSync(join(f.destination, 'scripts/browser-client.mjs'), 'utf8')).toBe('// fixture')
  expect(existsSync(join(f.destination, 'auth.json'))).toBe(false)
  expect(existsSync(join(f.destination, 'operator-private'))).toBe(false)
  expect(browserRuntimeContext(output, f.project, f.home, f.destination)).toContain(join(f.destination, 'scripts/browser-client.mjs'))
  expect(browserRuntimeContext(output, f.project, f.home)).toBe('')
  expect(JSON.stringify(args)).toBe(before)
  cleanup!(); expect(existsSync(f.destination)).toBe(false)
  cleanup!()
})

test('staging preserves explicit distribution denials and disabled transports', () => {
  for (const suffix of ['', '/scripts', '/docs', '/scripts/browser-client.mjs']) {
    const f = stagingFixture(), denied = join(dirname(f.selected), suffix)
    const input = f.input.map(x => x.startsWith('permissions.') ? x.slice(0, -1) + `,${JSON.stringify(denied)}="deny"}` : x)
    expect(f.stage(input)).toEqual(input)
    expect(existsSync(f.destination)).toBe(false)
  }
  const f = stagingFixture()
  const disabled = f.input.map(x => x === 'features.browser_use=true' ? 'features.browser_use=false' : x)
  expect(f.stage(disabled)).toEqual(disabled)
  expect(existsSync(f.destination)).toBe(false)
})

test.each([0o644, 0o444])('dialog fix changes only the job copy and retains native approval configuration (mode=%s)', mode => {
  const f = stagingFixture()
  const source = dialogTransport.methods.join('\n')
  const installed = join(f.selected, 'browser-service.mjs')
  writeFileSync(installed, source)
  chmodSync(installed, mode)
  const input = [...f.input, 'approval_policy="on-request"', 'approvals_reviewer="auto_review"']
  const output = f.stage(input)
  expect(readFileSync(installed, 'utf8')).toBe(source)
  expect(readFileSync(join(f.destination, 'scripts/browser-service.mjs'), 'utf8')).toBe(browserDialogCompatibility(source).source)
  expect(output).toContain('approval_policy="on-request"')
  expect(output).toContain('approvals_reviewer="auto_review"')
})

test('staging refuses linked distribution contents and keeps a preexisting destination intact', () => {
  const f = stagingFixture()
  symlinkSync(join(f.home, 'private'), join(f.selected, 'unexpected-link'))
  expect(f.stage()).toEqual(f.input)
  expect(existsSync(f.destination)).toBe(false)
  mkdirSync(f.destination); writeFileSync(join(f.destination, 'existing'), 'keep')
  expect(f.stage()).toEqual(f.input)
  expect(readFileSync(join(f.destination, 'existing'), 'utf8')).toBe('keep')
})

test('staging never relocates runtime beneath denied or peer-writable roots', () => {
  for (const access of ['deny', 'write']) {
    const f = stagingFixture()
    const args = f.input.map(x => x.startsWith('permissions.') ? x.replace(`${JSON.stringify(dirname(f.destination))}="read"`, `${JSON.stringify(dirname(f.destination))}="${access}"`) : x)
    expect(f.stage(args)).toEqual(args)
    expect(existsSync(f.destination)).toBe(false)
  }
})
