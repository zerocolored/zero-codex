import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createServer } from 'net'
import { browserConfigDigest, checkBrowserConfigRefresh, connectBrowserConfigControl } from './browser-config-refresh.ts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
async function fixture() {
  // Keep Unix socket paths below macOS's sockaddr_un limit.
  const root = realpathSync(mkdtempSync('/tmp/zbr-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'codex'); const stateRoot = join(root, 'state')
  mkdirSync(join(home, 'app-server-control'), { recursive: true, mode: 0o700 })
  const config = join(home, 'config.toml')
  const writeConfig = (version: string) => writeFileSync(config, `[features]\nbrowser_use=true\n[mcp_servers.node_repl]\nenabled=true\ncommand="node"\n[mcp_servers.node_repl.env]\nBROWSER_USE_CODEX_APP_VERSION="${version}"\n`, { mode: 0o600 })
  writeConfig('A')
  const socket = join(home, 'app-server-control/app-server-control.sock')
  const listen = async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
    chmodSync(socket, 0o600)
    cleanup.push(() => server.close())
    return server
  }
  const server = await listen()
  let reloads = 0; let closed = 0; let now = 1_000_000
  const options = {
    codexHome: home, stateRoot, now: () => now,
    connect: async () => ({ reload: async () => { reloads++ }, close: () => { closed++ } }),
  }
  return { root, home, socket, server, config, options, writeConfig, listen,
    reloads: () => reloads, closed: () => closed, advance: (ms: number) => { now += ms } }
}

test('unrelated config changes do not invalidate browser settings; disable is detected', () => {
  const config = { mcp_servers: { node_repl: { enabled: true, env: { BROWSER_USE_CODEX_APP_VERSION: 'A', SECRET: 'fixture' } } } }
  const before = browserConfigDigest(config)
  expect(browserConfigDigest({ ...config, model: 'different' })).toBe(before)
  config.mcp_servers.node_repl.env.SECRET = 'different-fixture'
  expect(browserConfigDigest(config)).toBe(before)
  config.mcp_servers.node_repl.enabled = false
  expect(browserConfigDigest(config)).not.toBe(before)
  expect(browserConfigDigest({})).toBeString()
  expect(browserConfigDigest({})).not.toBe(before)
})

test('startup refresh is shared across gateway restarts; unchanged settings are no-op', async () => {
  const f = await fixture()
  expect(await checkBrowserConfigRefresh(f.options)).toBe('refreshed')
  expect(await checkBrowserConfigRefresh({ ...f.options })).toBe('current')
  f.advance(24 * 60 * 60_000)
  expect(await checkBrowserConfigRefresh(f.options)).toBe('current')
  expect(f.reloads()).toBe(1); expect(f.closed()).toBe(1)
  const receipt = readFileSync(join(f.options.stateRoot, 'browser-config-refresh.json'), 'utf8')
  expect(receipt).not.toContain('BROWSER_USE'); expect(receipt).not.toContain(f.home)
})

test('new browser version is refreshed once without modifying the config', async () => {
  const f = await fixture()
  await checkBrowserConfigRefresh(f.options)
  f.writeConfig('B')
  const before = readFileSync(f.config)
  expect(await checkBrowserConfigRefresh(f.options)).toBe('refreshed')
  expect(await checkBrowserConfigRefresh(f.options)).toBe('current')
  expect(f.reloads()).toBe(2); expect(readFileSync(f.config)).toEqual(before)
})

test('removing browser configuration retires the loaded settings', async () => {
  const f = await fixture()
  await checkBrowserConfigRefresh(f.options)
  writeFileSync(f.config, 'model="unchanged"\n')
  expect(await checkBrowserConfigRefresh(f.options)).toBe('refreshed')
  expect(f.reloads()).toBe(2)
})

test('concurrent gateways cannot duplicate an in-flight reload', async () => {
  const f = await fixture()
  let release!: () => void; let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  const first = checkBrowserConfigRefresh({ ...f.options, connect: async () => ({
    reload: async () => { entered(); await wait }, close() {},
  }) })
  await ready
  expect(await checkBrowserConfigRefresh(f.options)).toBe('busy')
  release(); expect(await first).toBe('refreshed')
  expect(await checkBrowserConfigRefresh(f.options)).toBe('current')
  expect(f.reloads()).toBe(0)
})

test('ambiguous reload timeout has a durable cooldown across restarts', async () => {
  const f = await fixture()
  let attempts = 0
  const options = { ...f.options, connect: async () => ({ reload: async () => { attempts++; throw Error('timeout') }, close() {} }) }
  expect(await checkBrowserConfigRefresh(options)).toBe('unavailable')
  f.advance(60_000)
  expect(await checkBrowserConfigRefresh({ ...options })).toBe('cooldown')
  expect(attempts).toBe(1)
  f.advance(10 * 60_000)
  expect(await checkBrowserConfigRefresh(f.options)).toBe('refreshed')
})

test('a version changed during reload is never recorded as applied', async () => {
  const f = await fixture()
  expect(await checkBrowserConfigRefresh({ ...f.options, connect: async () => ({
    reload: async () => f.writeConfig('B'), close() {},
  }) })).toBe('changed')
  expect(await checkBrowserConfigRefresh(f.options)).toBe('refreshed')
  expect(f.reloads()).toBe(1)
})

test('a replaced daemon socket triggers a new refresh even with unchanged config', async () => {
  const f = await fixture()
  await checkBrowserConfigRefresh(f.options)
  await new Promise<void>(resolve => f.server.close(() => resolve()))
  await f.listen()
  expect(await checkBrowserConfigRefresh(f.options)).toBe('refreshed')
  expect(f.reloads()).toBe(2)
})

test('missing daemon and malformed config do not block normal work', async () => {
  const f = await fixture()
  await new Promise<void>(resolve => f.server.close(() => resolve()))
  expect(await checkBrowserConfigRefresh(f.options)).toBe('absent')
  writeFileSync(f.config, 'invalid = [')
  expect(await checkBrowserConfigRefresh(f.options)).toBe('unavailable')
  expect(f.reloads()).toBe(0)
})

test('official control handshake only reloads MCP settings and closes its connection', async () => {
  const f = await fixture()
  await new Promise<void>(resolve => f.server.close(() => resolve()))
  const methods: string[] = []
  const server = Bun.serve({
    unix: f.socket,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response('upgrade required', { status: 400 }) },
    websocket: { message(ws, raw) {
      const value = JSON.parse(raw.toString()); methods.push(value.method)
      if (value.method === 'initialize') ws.send(JSON.stringify({ id: value.id, result: { codexHome: f.home } }))
      else if (value.method === 'config/mcpServer/reload') ws.send(JSON.stringify({ id: value.id, result: {} }))
    } },
  })
  cleanup.push(() => server.stop(true)); chmodSync(f.socket, 0o600)
  expect(await checkBrowserConfigRefresh({ ...f.options, connect: connectBrowserConfigControl })).toBe('refreshed')
  expect(methods).toEqual(['initialize', 'initialized', 'config/mcpServer/reload'])
})
