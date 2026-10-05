import { createHash } from 'crypto'
import { lstatSync, readlinkSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import WebSocket from 'ws'
import { prepareManagedStateRoot } from './managed-path.ts'
import { tryAcquireProcessLock, releaseProcessLock } from './process-lock.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'

export const BROWSER_CONFIG_CHECK_MS = 60_000
const RETRY_MS = 10 * 60_000
type Snapshot = { key: string; socket: string; codexHome: string }
type Connection = { reload(): Promise<void>; close(): void }
type Saved = { key: string; attemptedAt: number; failures: number; applied?: boolean }
export type BrowserRefreshResult = 'absent' | 'busy' | 'current' | 'cooldown' | 'refreshed' | 'changed' | 'unavailable'

/** Only the public browser runtime inputs contribute to the digest. No config
 * values, browser state, URLs, or credentials are persisted or logged.
 */
export function browserConfigDigest(config: any): string | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return
  // Removing the browser MCP table must also retire the old configuration.
  const server = config.mcp_servers?.node_repl ?? {}
  const selected = (value: any, keys: string[]) => Object.fromEntries(keys.map(key => [key, value?.[key] ?? null]))
  const env = Object.fromEntries(Object.entries(server.env ?? {}).filter(([key]) =>
    key.startsWith('BROWSER_USE_') || key.startsWith('NODE_REPL_TRUSTED_')).sort(([a], [b]) => a.localeCompare(b)))
  return createHash('sha256').update(JSON.stringify({
    server: selected(server, ['enabled', 'command', 'args', 'cwd']), env,
    features: selected(config.features, ['plugins', 'browser_use', 'browser_use_external', 'in_app_browser']),
    plugins: selected(config.plugins, ['chrome@openai-bundled', 'browser@openai-bundled']),
  })).digest('hex')
}

function snapshot(codexHome: string): Snapshot | undefined {
  const raw = readOptionalBoundedOwnerOnlyRegularFile(join(codexHome, 'config.toml'), 2 * 1024 * 1024)
  if (raw === null) return
  const digest = browserConfigDigest(Bun.TOML.parse(raw))
  if (!digest) return
  let socket = join(codexHome, 'app-server-control/app-server-control.sock')
  try {
    // Bun/macOS realpath on a socket can return EOPNOTSUPP. Resolve the
    // official link and parent directory without opening the socket as a file.
    for (let count = 0; count < 8 && lstatSync(socket).isSymbolicLink(); count++) {
      socket = resolve(dirname(socket), readlinkSync(socket))
    }
    socket = join(realpathSync(dirname(socket)), basename(socket))
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const stat = lstatSync(socket)
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('browser refresh socket unavailable')
  }
  const physicalHome = realpathSync(codexHome)
  const key = createHash('sha256').update(JSON.stringify([
    physicalHome, digest, socket, stat.dev, stat.ino, stat.ctimeMs,
  ])).digest('hex')
  return { key, socket, codexHome: physicalHome }
}

/** Official app-server control protocol. Reload replaces MCP configuration;
 * it does not change model settings, clear login state, or restart the daemon.
 * Codex retains existing MCP call bindings while publishing the new snapshot.
 */
export async function connectBrowserConfigControl(input: Snapshot): Promise<Connection> {
  const socket = new WebSocket(`ws+unix://${input.socket}:/`, { handshakeTimeout: 5_000, maxPayload: 1024 * 1024 })
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  let sequence = 0
  const fail = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('browser refresh connection closed')) }
    pending.clear()
  }
  socket.on('error', fail)
  socket.on('close', fail)
  socket.on('message', raw => {
    let value: any
    try { value = JSON.parse(raw.toString()) } catch { socket.terminate(); return }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { socket.terminate(); return }
    const request = pending.get(value.id)
    if (!request || (!('result' in value) && !('error' in value))) return
    pending.delete(value.id); clearTimeout(request.timer)
    if ('error' in value) request.reject(new Error('browser refresh request rejected'))
    else request.resolve(value.result)
  })
  const call = (method: string, params?: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('browser refresh request timeout')) }, 5_000)
    pending.set(id, { resolve, reject, timer })
    try { socket.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })) }
    catch { clearTimeout(timer); pending.delete(id); reject(new Error('browser refresh send failed')) }
  })
  const close = () => { fail(); socket.terminate() }
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', () => reject(new Error('browser refresh connection unavailable')))
      socket.once('close', () => reject(new Error('browser refresh connection closed')))
    })
    const initialized = await call('initialize', {
      clientInfo: { name: 'zerochan-browser-config-refresh', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    if (typeof initialized?.codexHome !== 'string' || realpathSync(initialized.codexHome) !== input.codexHome) {
      throw new Error('browser refresh home mismatch')
    }
    socket.send(JSON.stringify({ method: 'initialized' }))
    return { reload: async () => { await call('config/mcpServer/reload') }, close }
  } catch (error) { close(); throw error }
}

/** Shared across all gateways on this Mac. A durable claim precedes the RPC,
 * including ambiguous delivery, so restarts cannot create a reload storm.
 */
export async function checkBrowserConfigRefresh(options: {
  stateRoot: string; codexHome?: string; now?: () => number
  connect?: (input: Snapshot) => Promise<Connection>
}): Promise<BrowserRefreshResult> {
  let lease: ReturnType<typeof tryAcquireProcessLock> | undefined
  let connection: Connection | undefined
  const lock = join(options.stateRoot, 'browser-config-refresh.lock')
  try {
    const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
    const before = snapshot(codexHome)
    if (!before) return 'absent'
    prepareManagedStateRoot(options.stateRoot)
    lease = tryAcquireProcessLock(lock)
    if (!lease.acquired) return 'busy'
    const path = join(options.stateRoot, 'browser-config-refresh.json')
    const raw = readOptionalBoundedOwnerOnlyRegularFile(path, 4096)
    const saved = raw ? JSON.parse(raw) as Saved : undefined
    const now = (options.now ?? Date.now)()
    if (saved?.key === before.key) {
      if (saved.applied) return 'current'
      const delay = Math.min(6, Math.max(1, saved.failures)) * RETRY_MS
      if (now >= saved.attemptedAt && now - saved.attemptedAt < delay) return 'cooldown'
    }
    const attempt: Saved = { key: before.key, attemptedAt: now, failures: saved?.key === before.key ? saved.failures + 1 : 1 }
    atomicWritePrivateFile(path, JSON.stringify(attempt) + '\n')
    connection = await (options.connect ?? connectBrowserConfigControl)(before)
    if (snapshot(codexHome)?.key !== before.key) return 'changed'
    await connection.reload()
    if (snapshot(codexHome)?.key !== before.key) return 'changed'
    atomicWritePrivateFile(path, JSON.stringify({ ...attempt, failures: 0, applied: true }) + '\n')
    return 'refreshed'
  } catch { return 'unavailable' }
  finally {
    try { connection?.close() } catch { /* Refresh must never stop the gateway. */ }
    try { if (lease?.acquired) releaseProcessLock(lock, lease.lease) } catch { /* The next check reports an unavailable lease. */ }
  }
}

export function startBrowserConfigRefresh(stateRoot: string, log: (message: string) => void): { stop(): void } {
  let stopped = false
  let running = false
  let lastWarning = false
  const check = async () => {
    if (stopped || running) return
    running = true
    try {
      const result = await checkBrowserConfigRefresh({ stateRoot })
      if (result === 'refreshed') log('browser connection settings refreshed through official Codex control')
      if (result === 'unavailable' && !lastWarning) log('browser settings refresh unavailable; normal work continues; retry is scheduled')
      if (result !== 'cooldown' && result !== 'busy') lastWarning = result === 'unavailable'
    } finally { running = false }
  }
  const timer = setInterval(() => { void check() }, BROWSER_CONFIG_CHECK_MS)
  timer.unref()
  void check()
  return { stop() { stopped = true; clearInterval(timer) } }
}
