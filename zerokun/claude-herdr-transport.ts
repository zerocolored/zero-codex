import { randomBytes } from 'crypto'
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'fs'
import { createServer, type Socket } from 'net'
import { join } from 'path'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { ensureManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { createProductionHerdrJobMonitorControl, type HerdrJobMonitorControl,
  type HerdrMonitorPane, type HerdrMonitorTab } from './herdr-job-monitor.ts'
import { readPinnedHerdrRuntime, type HerdrRuntimeIdentity } from './herdr-runtime.ts'
import { observeProcessGeneration, parseProcessStartKey, readProcessIdentity, sameProcessGeneration,
  signalProcessIfLive, type ProcessIdentity } from './process-generation.ts'
import { ClaudePaneFrames, type ClaudePaneManifest, type ClaudePanePacket } from './claude-pane-protocol.ts'
import { snapshotClaudeExecutable } from './claude-executable.ts'
import { claudeMainlineEnvironment } from './claude-mainline-runtime.ts'

interface Binding { tab: HerdrMonitorTab; pane: HerdrMonitorPane }
interface Receipt {
  version: 1
  jobId: string
  nonce: string
  directory: string
  directoryDevice: number
  directoryInode: number
  label: string
  workspaceId: string
  baselineTabIds: string[]
  binding?: Binding
  wrapper?: ProcessIdentity
  supervisor?: ProcessIdentity
}

async function discoverCreatedBinding(control: HerdrJobMonitorControl, receipt: Receipt): Promise<void> {
  if (receipt.binding) return
  const tabs = (await control.listTabs(receipt.workspaceId)).filter(tab =>
    tab.label === receipt.label && !receipt.baselineTabIds.includes(tab.tabId))
  if (tabs.length === 0) return
  if (tabs.length !== 1 || tabs[0]!.paneCount !== 1) throw new Error('Claude pane creation is ambiguous')
  const panes = (await control.listPanes(receipt.workspaceId)).filter(pane => pane.tabId === tabs[0]!.tabId)
  if (panes.length !== 1) throw new Error('Claude pane creation topology changed')
  receipt.binding = { tab: tabs[0]!, pane: panes[0]! }
}

function removeReceiptDirectory(receipt: Receipt, receiptPath: string): void {
  if (!/^\/private\/tmp\/zero-claude-[A-Za-z0-9]+$/.test(receipt.directory)
    && !/^\/tmp\/zero-claude-[A-Za-z0-9]+$/.test(receipt.directory)) throw new Error('invalid Claude transport directory')
  if (existsSync(receipt.directory)) {
    const current = lstatSync(receipt.directory)
    if (current.dev !== receipt.directoryDevice || current.ino !== receipt.directoryInode
      || !current.isDirectory() || current.isSymbolicLink() || (current.mode & 0o077)) {
      throw new Error('Claude transport directory changed; retained')
    }
    rmSync(receipt.directory, { recursive: true })
  }
  rmSync(receiptPath)
}

async function closeOwnedTab(control: HerdrJobMonitorControl, receipt: Receipt): Promise<void> {
  if (!receipt.binding || !await exactBinding(control, receipt)) return
  const info = await control.processInfo(receipt.binding.pane.paneId)
  if (info.foregroundProcesses.some(item => item.pid !== info.shellPid)) {
    throw new Error('Claude pane now contains another process; pane retained')
  }
  await control.closeTab(receipt.binding.tab.tabId)
  if (await exactBinding(control, receipt)) throw new Error('Claude pane close is pending')
}

/** Run only after the runner has retired registered executor generations.
 * A crash can leave a wrapper/tab after the supervisor is already gone. */
export async function reconcileClaudeHerdrTransports(options: {
  stateDir: string
  runtime: HerdrRuntimeIdentity
  controlForTesting?: HerdrJobMonitorControl
}): Promise<number> {
  const stateDir = requireManagedStateRoot(options.stateDir)
  const root = join(stateDir, 'claude-panes')
  if (!existsSync(root)) return 0
  ensureManagedDirectory(stateDir, root)
  const control = options.controlForTesting ?? createProductionHerdrJobMonitorControl(options.runtime)
  let closed = 0
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue
    const path = join(root, entry.name)
    const text = readOptionalBoundedOwnerOnlyRegularFile(path, 64 * 1024)
    if (!text) continue
    const receipt = JSON.parse(text) as Receipt
    if (receipt.version !== 1 || receipt.jobId + '.json' !== entry.name
      || !/^[a-f0-9]{32}$/.test(receipt.nonce) || receipt.workspaceId !== options.runtime.workspaceId
      || !Array.isArray(receipt.baselineTabIds) || typeof receipt.label !== 'string'
      || !receipt.label.endsWith(receipt.nonce.slice(0, 8))) throw new Error('invalid Claude pane recovery receipt')
    if (receipt.supervisor && observeProcessGeneration(receipt.supervisor).status !== 'dead') {
      throw new Error('Claude supervisor must be recovered before its pane')
    }
    if (receipt.wrapper) {
      signalProcessIfLive(receipt.wrapper, 'SIGTERM')
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && observeProcessGeneration(receipt.wrapper).status === 'alive') await Bun.sleep(50)
      if (observeProcessGeneration(receipt.wrapper).status !== 'dead') throw new Error('Claude wrapper cleanup is pending')
    }
    try {
      await discoverCreatedBinding(control, receipt)
      await closeOwnedTab(control, receipt)
      removeReceiptDirectory(receipt, path); closed++
    } catch {
      // All recorded owned processes above are gone. A foreign occupant or
      // changed directory is retained for inspection, not a gateway-wide stop.
      process.stderr.write('zerochan: Claude recovery retained a changed pane/directory; other jobs can continue.\n')
    }
  }
  return closed
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

async function exactBinding(control: HerdrJobMonitorControl, receipt: Receipt): Promise<boolean> {
  if (!receipt.binding) return false
  const { tab, pane } = receipt.binding
  const tabs = await control.listTabs(tab.workspaceId)
  const found = tabs.find(item => item.tabId === tab.tabId)
  if (!found) return false
  const panes = (await control.listPanes(tab.workspaceId)).filter(item => item.tabId === tab.tabId)
  if (found.label !== receipt.label || found.paneCount !== 1 || panes.length !== 1
    || panes[0]!.paneId !== pane.paneId || panes[0]!.terminalId !== pane.terminalId
    || panes[0]!.workspaceId !== pane.workspaceId) throw new Error('Claude owned pane changed')
  return true
}

export interface ClaudeHerdrTransport {
  input: { write(value: string): Promise<void>; end(): Promise<void> }
  output: ReadableStream<Uint8Array>
  identity: ProcessIdentity
  pane: HerdrMonitorPane
  exited: Promise<number>
  close(): Promise<void>
}

/** Open exactly one native Claude in a new, unfocused, job-owned Herdr tab.
 * Instructions travel over a private socket, never shell text or CLI argv. */
export async function openClaudeHerdrTransport(options: {
  stateDir: string
  jobId: string
  sequence: number
  cwd: string
  executable: string
  arguments: string[]
  fingerprint?: { allow: string; deny: string }
  signal?: AbortSignal
  runtime?: HerdrRuntimeIdentity
  controlForTesting?: HerdrJobMonitorControl
  environmentForTesting?: Record<string, string>
  readyTimeoutMsForTesting?: number
  onProcessId?(pid: number): void
  onProcessExit?(code: number): void
  onStderr?(bytes: Uint8Array): void
}): Promise<ClaudeHerdrTransport> {
  if (!/^[A-Za-z0-9._-]+$/.test(options.jobId)) throw new Error('invalid Claude job id')
  const stateDir = requireManagedStateRoot(options.stateDir)
  const runtime = options.runtime ?? readPinnedHerdrRuntime(stateDir)
  const control = options.controlForTesting ?? createProductionHerdrJobMonitorControl(runtime)
  await control.verifyRuntime()
  if (options.signal?.aborted) throw new Error('Claude startup interrupted')
  const receiptRoot = ensureManagedDirectory(stateDir, join(stateDir, 'claude-panes'))
  const registrationRoot = ensureManagedDirectory(stateDir, join(stateDir, 'executors'))
  const receiptPath = join(receiptRoot, `${options.jobId}.json`)
  if (readOptionalBoundedOwnerOnlyRegularFile(receiptPath, 64 * 1024)) {
    throw new Error('previous Claude pane must be retired before another launch')
  }
  // AF_UNIX paths on macOS have a small bound. Do not use long per-user TMPDIR.
  const directory = realpathSync(mkdtempSync('/tmp/zero-claude-'))
  chmodSync(directory, 0o700)
  const metadata = lstatSync(directory)
  const nonce = randomBytes(16).toString('hex')
  const receipt: Receipt = { version: 1, jobId: options.jobId, nonce, directory,
    directoryDevice: metadata.dev, directoryInode: metadata.ino,
    workspaceId: runtime.workspaceId, baselineTabIds: (await control.listTabs(runtime.workspaceId)).map(tab => tab.tabId),
    label: `Zeroちゃん #${options.sequence} Claude ${nonce.slice(0, 8)}` }
  const persist = () => atomicWritePrivateFile(receiptPath, JSON.stringify(receipt))
  persist()
  const manifest: ClaudePaneManifest = { version: 1, nonce, jobId: options.jobId,
    cwd: realpathSync(options.cwd), socketPath: join(directory, 'host.sock'),
    registrationPath: join(registrationRoot, `${options.jobId}.json`),
    executable: snapshotClaudeExecutable(options.executable), arguments: options.arguments,
    fingerprint: options.fingerprint,
    environment: options.environmentForTesting ?? claudeMainlineEnvironment() }
  const manifestPath = join(directory, 'manifest.json')
  atomicWritePrivateFile(manifestPath, JSON.stringify(manifest))
  let socket: Socket | undefined, outputController!: ReadableStreamDefaultController<Uint8Array>
  let outputEnded = false, closing = false, registered = false
  let exitCode: number | undefined, failure: Error | undefined
  let resolveReady!: (identity: ProcessIdentity) => void, rejectReady!: (error: Error) => void
  let resolveExit!: (code: number) => void
  const ready = new Promise<ProcessIdentity>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  const exited = new Promise<number>(resolve => { resolveExit = resolve })
  const output = new ReadableStream<Uint8Array>({ start(controller) { outputController = controller } },
    new ByteLengthQueuingStrategy({ highWaterMark: 32 * 1024 * 1024 }))
  const finishOutput = (error?: Error) => {
    if (outputEnded) return
    outputEnded = true
    if (error) outputController.error(error)
    else outputController.close()
  }
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error('Claude pane transport failed')
    rejectReady(failure); finishOutput(failure)
  }
  const send = (packet: ClaudePanePacket): Promise<void> => new Promise((resolve, reject) => {
    if (!socket || socket.destroyed) { reject(new Error('Claude pane is disconnected')); return }
    socket.write(JSON.stringify(packet) + '\n', error => error ? reject(error) : resolve())
  })
  const connections = new Set<Socket>()
  const server = createServer(connection => {
    connections.add(connection)
    const handshakeDeadline = setTimeout(() => { if (socket !== connection) connection.destroy() }, 5_000)
    connection.once('close', () => { connections.delete(connection); clearTimeout(handshakeDeadline) })
    connection.on('error', () => {})
    let authenticated = false
    let chain = Promise.resolve()
    const frames = new ClaudePaneFrames(packet => {
      chain = chain.then(async () => {
        if (!authenticated) {
          if (packet.type !== 'hello' || packet.nonce !== nonce || socket || closing || !receipt.binding) {
            connection.destroy(); return
          }
          const actual = readProcessIdentity(packet.identity?.pid)
          if (!actual || !sameProcessGeneration(actual, packet.identity)
            || !await exactBinding(control, receipt)) throw new Error('Claude pane identity unavailable')
          const processInfo = await control.processInfo(receipt.binding.pane.paneId)
          if (processInfo.paneId !== receipt.binding.pane.paneId
            || !processInfo.foregroundProcesses.some(item => item.pid === actual.pid)) {
            throw new Error('Claude bridge is not in the owned pane')
          }
          socket = connection; authenticated = true; receipt.wrapper = actual; persist()
          await send({ type: 'start' }); return
        }
        switch (packet.type) {
          case 'ready': {
            if (receipt.supervisor || closing) throw new Error('unexpected Claude startup acknowledgement')
            const actual = readProcessIdentity(packet.identity?.pid)
            if (!actual || !sameProcessGeneration(actual, packet.identity)
              || actual.ppid !== receipt.wrapper!.pid || actual.pgid !== actual.pid) {
              throw new Error('Claude supervisor identity unavailable')
            }
            receipt.supervisor = actual; persist()
            options.onProcessId?.(actual.pid); registered = true
            resolveReady(actual); break
          }
          case 'stdout':
          case 'stderr': {
            if (!receipt.supervisor || typeof packet.data !== 'string'
              || packet.data.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(packet.data)) {
              throw new Error('invalid Claude process output')
            }
            const bytes = Buffer.from(packet.data, 'base64')
            if (bytes.toString('base64') !== packet.data) throw new Error('invalid Claude output encoding')
            if (packet.type === 'stderr') options.onStderr?.(bytes)
            else if (!outputEnded) {
              if ((outputController.desiredSize ?? 0) < bytes.length) throw new Error('Claude output queue exceeds limit')
              outputController.enqueue(bytes)
            }
            break
          }
          case 'exit':
            if (!Number.isSafeInteger(packet.code) || exitCode !== undefined) throw new Error('invalid Claude exit receipt')
            exitCode = packet.code; finishOutput(); resolveExit(packet.code)
            rejectReady(new Error('Claude exited before readiness')); break
          case 'failure': throw new Error('Claude pane startup or transport failed')
          default: throw new Error('unexpected Claude pane response')
        }
      }).catch(error => { fail(error); connection.destroy() })
    })
    connection.on('data', bytes => {
      try { frames.push(typeof bytes === 'string' ? Buffer.from(bytes) : bytes) }
      catch (error) { if (authenticated) fail(error); connection.destroy() }
    })
    connection.on('close', () => {
      if (!authenticated) return
      void chain.then(() => {
        try { frames.finish() } catch (error) { fail(error) }
        if (exitCode === undefined && !closing) fail(new Error('Claude pane disconnected before exit acknowledgement'))
      })
    })
  })
  server.on('error', fail)
  const onAbort = () => { fail(new Error('Claude transport interrupted')); void send({ type: 'stop' }).catch(() => {}) }
  let closePromise: Promise<void> | undefined
  const closeOwned = async () => {
    closing = true
    options.signal?.removeEventListener('abort', onAbort)
    await send({ type: 'stop' }).catch(() => {})
    if (receipt.supervisor) signalProcessIfLive(receipt.supervisor, 'SIGTERM')
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && [receipt.supervisor, receipt.wrapper].some(identity =>
      identity && observeProcessGeneration(identity).status !== 'dead')) await Bun.sleep(50)
    socket?.destroy()
    for (const connection of connections) connection.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    finishOutput()
    if ([receipt.supervisor, receipt.wrapper].some(identity => identity && observeProcessGeneration(identity).status !== 'dead')) {
      throw new Error('Claude cleanup is pending; owned process receipt retained')
    }
    const registrationText = readOptionalBoundedOwnerOnlyRegularFile(manifest.registrationPath, 512 * 1024)
    if (registrationText) {
      const registration = JSON.parse(registrationText)
      if (!receipt.supervisor || registration.jobId !== options.jobId
        || registration.pid !== receipt.supervisor.pid || registration.started !== receipt.supervisor.started
        || registration.phase !== 'cleanup-confirmed' || !Array.isArray(registration.tracked)
        || registration.tracked.some((item: { pid: number; started: string }) => {
          const generation = parseProcessStartKey(item.started)
          return !generation || observeProcessGeneration({ pid: item.pid, ...generation }).status !== 'dead'
        })) throw new Error('Claude descendant cleanup is pending; receipt retained')
      rmSync(manifest.registrationPath)
    }
    if (registered) { options.onProcessExit?.(exitCode ?? 1); registered = false }
    await discoverCreatedBinding(control, receipt)
    await closeOwnedTab(control, receipt)
    removeReceiptDirectory(receipt, receiptPath)
  }
  const close = () => closePromise ??= closeOwned()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(manifest.socketPath, resolve)
    })
    chmodSync(manifest.socketPath, 0o600)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) throw new Error('Claude startup interrupted')
    receipt.binding = await control.createTab({ workspaceId: runtime.workspaceId, cwd: manifest.cwd, label: receipt.label })
    persist()
    if (options.signal?.aborted) throw new Error('Claude startup interrupted')
    if (!await exactBinding(control, receipt)) throw new Error('Claude pane creation unconfirmed')
    const command = ['exec', shellQuote(realpathSync(process.execPath)), '--config=/dev/null', '--no-env-file',
      shellQuote(join(import.meta.dir, 'claude-pane-runtime.ts')), shellQuote(manifestPath)].join(' ')
    // A failed pane/run response may still have delivered. Wait on the same
    // nonce/socket; never submit the launch a second time.
    let runFailure: unknown
    void control.runPane(receipt.binding.pane.paneId, command).catch(error => { runFailure = error })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const identity = await Promise.race([ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(runFailure ? 'Claude pane launch was not confirmed' : 'Claude pane readiness timed out')),
          options.readyTimeoutMsForTesting ?? 30_000)
      })])
      if (failure) throw failure
      return { input: { write: value => send({ type: 'input', data: value }), end: () => send({ type: 'end-input' }) },
        output, identity, pane: receipt.binding.pane, exited, close }
    } finally { if (timer) clearTimeout(timer) }
  } catch (error) {
    await close()
    throw error
  }
}
