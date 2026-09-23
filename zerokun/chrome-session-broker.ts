import { lstatSync, mkdirSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { GO_CHROME_ENABLED_TOOLS } from './chrome-tools.ts'
import { releaseProcessLock, tryAcquireProcessLock, type ProcessLockLease } from './process-lock.ts'

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] })
type ChromeCall = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>

export function validateChromeAction(name: string, args: Record<string, unknown>): void {
  if (!(GO_CHROME_ENABLED_TOOLS as readonly string[]).includes(name)) throw new Error('Unsupported Chrome operation')
  if ('savePath' in args || 'overwrite' in args) throw new Error('Screenshots must be returned inline; host file writes are not available')
  if (name !== 'tabs_list' && name !== 'tabs_create'
    && (!Number.isSafeInteger(args.tabId) || Number(args.tabId) <= 0)) throw new Error('Use an explicit tabId from tabs_list or tabs_create')
  if ('url' in args) {
    if (typeof args.url !== 'string') throw new Error('Invalid navigation URL')
    const url = new URL(args.url)
    if (!['https:', 'http:'].includes(url.protocol) && args.url !== 'about:blank') throw new Error('Only HTTP(S) or about:blank navigation is available')
    if (url.username || url.password) throw new Error('Credentials in navigation URLs are not allowed')
  }
}

export function chromeTools(tools: Tool[]): Tool[] {
  return [...tools.filter(t => (GO_CHROME_ENABLED_TOOLS as readonly string[]).includes(t.name)).map(t => {
    const properties = { ...t.inputSchema.properties }
    delete properties.savePath
    delete properties.overwrite
    const required = new Set(t.inputSchema.required ?? [])
    if (t.name !== 'tabs_list' && t.name !== 'tabs_create') required.add('tabId')
    return { ...t, description: `${t.description ?? ''} Use an explicit tabId. A tab stays reserved to this job until release_tab. Screenshots are inline only.`,
      inputSchema: { ...t.inputSchema, properties, required: [...required], additionalProperties: false } }
  }), { name: 'release_tab', description: 'Detach coordinate mode and release this job’s tab reservation without closing the tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'integer', minimum: 1 } }, required: ['tabId'], additionalProperties: false } }]
}

export class ChromeSession {
  private tabs = new Map<number, ProcessLockLease>()
  private coordinates = new Set<number>()
  private stopping = false
  private ready = false
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private call: ChromeCall, private lockRoot: string, private readinessMs = 12_000) {
    mkdirSync(lockRoot, { recursive: true, mode: 0o700 })
    const st = lstatSync(lockRoot)
    if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(lockRoot) !== lockRoot
      || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error('Unsafe Chrome lock directory')
  }
  private tabLock(id: number) { return join(this.lockRoot, `tab-${id}.lock`) }
  private reserve(id: number) {
    if (this.tabs.has(id)) return
    const lock = tryAcquireProcessLock(this.tabLock(id))
    if (!lock.acquired) throw new Error('This tab is in use by another Zeroちゃん job. Use another tab or wait for its release.')
    this.tabs.set(id, lock.lease)
  }
  private release(id: number) {
    const lease = this.tabs.get(id)
    if (lease && releaseProcessLock(this.tabLock(id), lease)) this.tabs.delete(id)
  }
  run(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (this.stopping) return Promise.resolve(failure('Chrome session is closing; nothing was sent'))
    const result = this.chain.then(() => this.execute(name, args))
    this.chain = result.catch(() => {})
    return result
  }
  private async execute(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      validateChromeAction(name, args)
      if (!this.ready) {
        const deadline = Date.now() + this.readinessMs
        // Only the read-only readiness request is retried. Never replay input,
        // navigation, tab creation, or any other operation after sending it.
        while (true) {
          const probe = await this.call('tabs_list', {})
          if (!probe.isError) { this.ready = true; break }
          const text = probe.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          if (!text.includes('Not connected to hub') || Date.now() >= deadline) return probe
          await Bun.sleep(250)
        }
      }
      const id = Number(args.tabId)
      if (name !== 'tabs_list' && name !== 'tabs_create') this.reserve(id)
      const path = join(this.lockRoot, 'operation.lock')
      const deadline = Date.now() + 15_000
      let operation = tryAcquireProcessLock(path)
      while (!operation.acquired && Date.now() < deadline) {
        await Bun.sleep(100)
        operation = tryAcquireProcessLock(path)
      }
      if (!operation.acquired) return failure('Another Zeroちゃん is operating Chrome. Retry after that operation finishes; nothing was sent.')
      try {
        if (name === 'release_tab') {
          const detached = await this.detach(id)
          if (detached.isError) return detached
          this.release(id)
          return { content: [{ type: 'text', text: 'Tab reservation released; tab left open.' }] }
        }
        if (name === 'coordinate_mode' && args.enable === false) return this.detach(id)
        if (name.startsWith('coordinate_') || name.startsWith('mouse_') || name.startsWith('key_')) {
          // An operation can attach and then fail, so record ownership before
          // dispatch, not only after receiving a successful result.
          this.coordinates.add(id)
        }
        const result = await this.call(name, args)
        if (!result.isError && name === 'tabs_create') {
          for (const content of result.content) {
            if (content.type !== 'text') continue
            try {
              const created = JSON.parse(content.text)
              const tabId = created.tabId ?? created.id ?? created.tab?.id
              if (Number.isSafeInteger(tabId) && tabId > 0) this.reserve(tabId)
            } catch { /* non-JSON diagnostic; subsequent operations still require a reservation */ }
          }
        }
        if (!result.isError && name === 'tabs_close') { this.coordinates.delete(id); this.release(id) }
        return result
      } finally { releaseProcessLock(path, operation.lease) }
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'Chrome operation failed')
    }
  }
  private async detach(id: number): Promise<CallToolResult> {
    if (!this.coordinates.has(id)) return { content: [{ type: 'text', text: 'This job did not start coordinate mode; no detach was sent.' }] }
    const result = await this.call('coordinate_mode', { tabId: id, enable: false })
    const confirmed = !result.isError && result.content.some(content => {
      if (content.type !== 'text') return false
      try { return JSON.parse(content.text).detached === true } catch { return false }
    })
    if (!confirmed) return failure('Chrome coordinate detach was not confirmed; the tab reservation is retained.')
    this.coordinates.delete(id)
    return result
  }
  async finish(): Promise<boolean> {
    this.stopping = true
    await this.chain
    let complete = true
    for (const id of this.coordinates) {
      try { if ((await this.execute('release_tab', { tabId: id })).isError) complete = false } catch { complete = false }
    }
    return complete
  }
  close() { for (const id of this.tabs.keys()) this.release(id) }
}

export async function main(entrypoint: string) {
  const client = new Client({ name: 'zerochan-chrome-session', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: 'node',
    args: [join(import.meta.dir, 'browser-mcp-proxy.mjs'), entrypoint], stderr: 'pipe' })
  transport.stderr?.on('data', () => {})
  await client.connect(transport)
  const session = new ChromeSession(async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })
    return result as CallToolResult
  }, join(homedir(), '.codex', 'zerochan-browser-locks'))
  const server = new Server({ name: 'zerochan-chrome', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: chromeTools((await client.listTools()).tools) }))
  server.setRequestHandler(CallToolRequestSchema, async req => session.run(req.params.name, req.params.arguments ?? {}))
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    if (!await session.finish()) process.stderr.write('Chrome coordinate cleanup could not be confirmed.\n')
    // Keep reservations until the child and all its pending commands are gone.
    await client.close()
    session.close()
    await server.close()
  }
  server.onclose = () => { void close() }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => { void close() })
  await server.connect(new StdioServerTransport())
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('Chrome session broker requires an installed entrypoint')
  await main(process.argv[2]!)
}
