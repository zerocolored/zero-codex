import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { HerdrRuntimeIdentity } from './herdr-runtime.ts'
import type { HerdrJobMonitorControl, HerdrMonitorPane, HerdrMonitorTab } from './herdr-job-monitor.ts'
import { prepareManagedStateRoot } from './managed-path.ts'
import { observeProcessGeneration, readProcessIdentity, signalProcessGroupIfLeaderLive, type ProcessIdentity } from './process-generation.ts'
import { ClaudePaneFrames } from './claude-pane-protocol.ts'
import { openClaudeHerdrTransport, reconcileClaudeHerdrTransports, type ClaudeHerdrTransport } from './claude-herdr-transport.ts'
import { ClaudeControlSession, claudeResult } from './claude-control-session.ts'

const roots: string[] = [], processes: ProcessIdentity[] = [], transports: ClaudeHerdrTransport[] = []
afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.close()
  for (const identity of processes.splice(0)) signalProcessGroupIfLeaderLive(identity, 'SIGKILL')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('pane frames preserve split UTF-8 and reject oversized or truncated messages', () => {
  const packets: unknown[] = []
  const frames = new ClaudePaneFrames(packet => packets.push(packet))
  const input = Buffer.from(JSON.stringify({ type: 'input', data: '日本語' }) + '\n')
  for (const byte of input) frames.push(Uint8Array.of(byte))
  frames.finish()
  expect(packets).toEqual([{ type: 'input', data: '日本語' }])
  expect(() => new ClaudePaneFrames(() => {}, 4).push(Buffer.from('12345'))).toThrow('limit')
  const partial = new ClaudePaneFrames(() => {})
  partial.push(Buffer.from('{'))
  expect(() => partial.finish()).toThrow('inside a frame')
})

function fixture(failAfterRun = false, noRun = false) {
  const root = realpathSync(mkdtempSync('/tmp/zero-claude-test-')); roots.push(root)
  chmodSync(root, 0o700)
  const stateDir = prepareManagedStateRoot(join(root, 'state'))
  const executable = join(root, 'fixture-claude')
  writeFileSync(executable, `#!${process.execPath}
let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
 buffer += new TextDecoder().decode(chunk);
 let end;
 while ((end = buffer.indexOf('\\n')) !== -1) {
  const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  if (event.type === 'control_request') send({ type:'control_response', response:{subtype:'success', request_id:event.request_id, response:{}} });
  else if (event.type === 'user') {
   send(event);
   send({type:'system',subtype:'init',session_id:event.session_id,model:'claude-opus-fixture'});
   send({type:'result',subtype:'success',is_error:false,result:event.message.content,session_id:event.session_id});
  }
 }
}
`, { mode: 0o700 })
  const pane: HerdrMonitorPane = { paneId: 'wT:p2', tabId: 'wT:t2', workspaceId: 'wT', terminalId: 'term-test', cwd: root }
  let tab: HerdrMonitorTab | undefined
  let wrapper: ReturnType<typeof Bun.spawn> | undefined
  let runs = 0, closed = 0
  const control: HerdrJobMonitorControl = {
    verifyRuntime() {}, processGenerationStatus: identity => observeProcessGeneration(identity).status,
    async listWorkspaceIds() { return ['wT'] },
    async createTab(input) { tab = { workspaceId: 'wT', tabId: 'wT:t2', paneCount: 1, label: input.label }; return { tab, pane } },
    async listTabs() { return tab ? [tab] : [] }, async listPanes() { return tab ? [pane] : [] },
    async runPane(_pane, command) {
      runs++
      if (noRun) throw new Error('fixture no delivery')
      wrapper = Bun.spawn(['/bin/sh', '-c', command], { cwd: root, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true })
      const identity = readProcessIdentity(wrapper.pid)!
      processes.push(identity)
      if (failAfterRun) throw new Error('fixture response lost after delivery')
    },
    async waitOutput() { return false },
    async processInfo() { return { paneId: pane.paneId, shellPid: 0,
      foregroundProcesses: wrapper && readProcessIdentity(wrapper.pid) ? [{ pid: wrapper.pid, argv: [], cwd: root }] : [] } },
    async closeTab(id) { expect(id).toBe('wT:t2'); closed++; tab = undefined },
  }
  return { root, stateDir, executable, control, runtime: { workspaceId: 'wT' } as HerdrRuntimeIdentity,
    counters: () => ({ runs, closed }) }
}

for (const failAfterRun of [false, true]) test.skipIf(process.platform !== 'darwin')(
  `owned Claude transport executes, acknowledges, and reaps (lost launch response=${failAfterRun})`, async () => {
    const f = fixture(failAfterRun)
    const lifecycle: string[] = []
    const transport = await openClaudeHerdrTransport({ ...f, jobId: 'bridge-test', sequence: 1, cwd: f.root,
      arguments: [], controlForTesting: f.control, environmentForTesting: { PATH: '/usr/bin:/bin', HOME: f.root },
      onProcessId: pid => lifecycle.push(`start:${pid}`), onProcessExit: code => lifecycle.push(`exit:${code}`) })
    transports.push(transport)
    const session = new ClaudeControlSession(transport.input, transport.output, randomUUID())
    await session.initialize()
    const before: number[] = []
    await session.sendUser({ messageId: randomUUID(), content: 'synthetic-first', beforeWrite: id => before.push(id) })
    let result: ReturnType<typeof claudeResult> = null
    while (!result) { const event = await session.nextEvent(); if (event) result = claudeResult(event) }
    expect(result).toEqual({ kind: 'success', text: 'synthetic-first' })
    expect(before).toHaveLength(1)
    expect(session.model).toBe('claude-opus-fixture')
    await session.interrupt()
    await session.sendUser({ messageId: randomUUID(), content: 'synthetic-followup' })
    result = null
    while (!result) { const event = await session.nextEvent(); if (event) result = claudeResult(event) }
    expect(result).toEqual({ kind: 'success', text: 'synthetic-followup' })
    await session.endInput()
    expect(await transport.exited).toBe(0)
    await session.close(); await transport.close()
    expect(observeProcessGeneration(transport.identity).status).toBe('dead')
    expect(lifecycle).toEqual([`start:${transport.identity.pid}`, 'exit:0'])
    expect(f.counters()).toEqual({ runs: 1, closed: 1 })
    expect(existsSync(join(f.stateDir, 'executors', 'bridge-test.json'))).toBe(false)
    expect(existsSync(join(f.stateDir, 'claude-panes', 'bridge-test.json'))).toBe(false)
  }, 15_000)

test.skipIf(process.platform !== 'darwin')('undelivered startup times out once and closes only its new pane', async () => {
  const f = fixture(false, true)
  await expect(openClaudeHerdrTransport({ ...f, jobId: 'no-delivery', sequence: 2, cwd: f.root,
    arguments: [], controlForTesting: f.control, readyTimeoutMsForTesting: 100 })).rejects.toThrow('not confirmed')
  expect(f.counters()).toEqual({ runs: 1, closed: 1 })
  expect(existsSync(join(f.stateDir, 'claude-panes', 'no-delivery.json'))).toBe(false)
})

test.skipIf(process.platform !== 'darwin')('closing during an open input stream retires the supervisor and records its exit', async () => {
  const f = fixture()
  const transport = await openClaudeHerdrTransport({ ...f, jobId: 'cancel-test', sequence: 3, cwd: f.root,
    arguments: [], controlForTesting: f.control, environmentForTesting: { PATH: '/usr/bin:/bin', HOME: f.root } })
  transports.push(transport)
  const receipt = JSON.parse(readFileSync(join(f.stateDir, 'claude-panes', 'cancel-test.json'), 'utf8'))
  await transport.close()
  expect(observeProcessGeneration(transport.identity).status).toBe('dead')
  expect(observeProcessGeneration(receipt.wrapper).status).toBe('dead')
  expect(f.counters().closed).toBe(1)
})

test('lost create response discovers only the nonce-owned tab for cleanup without launching', async () => {
  const f = fixture(), original = f.control.createTab
  f.control.createTab = async input => { await original(input); throw new Error('create response lost') }
  await expect(openClaudeHerdrTransport({ ...f, jobId: 'create-lost', sequence: 1, cwd: f.root,
    arguments: [], controlForTesting: f.control })).rejects.toThrow('create response lost')
  expect(f.counters()).toEqual({ runs: 0, closed: 1 })
  expect(existsSync(join(f.stateDir, 'claude-panes', 'create-lost.json'))).toBe(false)
})

test('cancellation during tab creation closes the owned tab without dispatching the launcher', async () => {
  const f = fixture(), original = f.control.createTab, controller = new AbortController()
  f.control.createTab = async input => { const result = await original(input); controller.abort(); return result }
  await expect(openClaudeHerdrTransport({ ...f, jobId: 'create-abort', sequence: 1, cwd: f.root,
    arguments: [], controlForTesting: f.control, signal: controller.signal })).rejects.toThrow('interrupted')
  expect(f.counters()).toEqual({ runs: 0, closed: 1 })
})

test('foreign occupant is retained and a later recovery closes the original tab only after it is empty', async () => {
  const f = fixture(false, true), original = f.control.processInfo
  f.control.processInfo = async pane => ({ ...await original(pane), foregroundProcesses: [{ pid: 987654, argv: ['foreign'], cwd: f.root }] })
  await expect(openClaudeHerdrTransport({ ...f, jobId: 'foreign-occupant', sequence: 1, cwd: f.root,
    arguments: [], controlForTesting: f.control, readyTimeoutMsForTesting: 20 })).rejects.toThrow('another process')
  expect(f.counters().closed).toBe(0)
  expect(existsSync(join(f.stateDir, 'claude-panes', 'foreign-occupant.json'))).toBe(true)
  expect(await reconcileClaudeHerdrTransports({ stateDir: f.stateDir, runtime: f.runtime, controlForTesting: f.control })).toBe(0)
  expect(f.counters().closed).toBe(0)
  expect(existsSync(join(f.stateDir, 'claude-panes', 'foreign-occupant.json'))).toBe(true)
  f.control.processInfo = original
  expect(await reconcileClaudeHerdrTransports({ stateDir: f.stateDir, runtime: f.runtime, controlForTesting: f.control })).toBe(1)
  expect(f.counters().closed).toBe(1)
})
