import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import { AntigravityResults, antigravitySandbox, runAntigravityDelegation } from './antigravity-delegation-attempt.ts'
import { ClaudeDelegations, createDelegationServer, type DelegationContext } from './claude-delegation-broker.ts'
import { JobStore } from './job-runner.ts'
import { pendingClaudeDelegation } from './claude-delegation-state.ts'
import { prepareClaudeJobContext } from './claude-job-context.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ClaudeDelegationError, delegationFailure } from './claude-delegation-attempt.ts'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function fixture(writeEnabled = true) {
  const root = realpathSync(mkdtempSync('/tmp/zero-agy-test-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'), stateDir = join(root, 'state')
  mkdirSync(repo); mkdirSync(stateDir, { mode: 0o700 })
  const store = new JobStore(join(stateDir, 'jobs.sqlite3')); cleanups.push(() => store.close())
  store.enqueue({ repoPath: repo, chatId: 'C', threadTs: '1800000000.1', messageId: '1800000000.1', userId: 'U', task: 'Antigravityに依頼', writeEnabled })
  return { version: 1 as const, stateDir, job: store.claimNext('test')! }
}
const model = 'gemini-3.8-flash-low'
test('authentication recovery preserves the request and allows one durable retry only', async () => {
  const context = fixture(); let calls = 0
  const run = async (_context: unknown, _id: string, request: { model: string; prompt: string }) => {
    calls++
    expect(request.model).toBe(model); expect(request.prompt).toBe('original task')
    if (calls === 1) throw new ClaudeDelegationError({ ...delegationFailure('authentication', 'authentication'), retrySafe: true, cleanupVerified: true })
    return 'recovered'
  }
  const first = new ClaudeDelegations(context, run, 'antigravity')
  const original = first.start({ key: 'original', model, prompt: 'original task' })
  await first.wait(original.id); await first.close()
  const resumed = new ClaudeDelegations(context, run, 'antigravity')
  try {
    const retry = resumed.retryAfterAuthentication(original.id)
    expect(resumed.retryAfterAuthentication(original.id).id).toBe(retry.id)
    expect((await resumed.wait(retry.id)).result).toBe('recovered')
    expect(resumed.retryAfterAuthentication(original.id).id).toBe(retry.id)
    expect(() => resumed.retryAfterAuthentication(retry.id)).toThrow()
    expect(calls).toBe(2)
  } finally { await resumed.close() }
})
test.each(['partial', 'cleanup', 'network', 'second-auth'] as const)('authentication retry does not replay unsafe or repeated failures (%s)', async kind => {
  const context = fixture()
  const agy = new ClaudeDelegations(context, async () => { throw new ClaudeDelegationError({
    ...delegationFailure('authentication', kind === 'network' ? 'native-error' : 'authentication'),
    retrySafe: kind !== 'partial', cleanupVerified: kind !== 'cleanup',
  }) }, 'antigravity')
  try {
    const original = agy.start({ key: 'failure', model, prompt: 'task' }); await agy.wait(original.id)
    if (kind === 'second-auth') {
      const retry = agy.retryAfterAuthentication(original.id); await agy.wait(retry.id)
      expect(() => agy.retryAfterAuthentication(retry.id)).toThrow()
    } else expect(() => agy.retryAfterAuthentication(original.id)).toThrow()
  } finally { await agy.close() }
})
const init = { event: 'init', conversation_id: 'test', init: { model } }
const result = { event: 'result', result: { conversation_id: 'test', status: 'SUCCESS', response: '日本語 OK' } }
function bytes(...events: unknown[]) { return Buffer.from(events.map(v => JSON.stringify(v)).join('\n') + '\n') }
test('native agy stream handles split UTF-8, future events and terminal result', () => {
  const parser = new AntigravityResults(model)
  for (const byte of bytes(init, { event: 'future' }, result)) parser.push(Uint8Array.of(byte))
  expect(parser.finish()).toBe('日本語 OK')
})
test('errors, changed models, missing results and wrong conversations cannot pass', () => {
  for (const events of [
    [init, { ...result, result: { ...result.result, status: 'ERROR' } }],
    [{ ...init, init: { model: 'another-model' } }, result],
    [init], [result], [init, result, result],
    [init, { event: 'step_update', step_update: { step_type: 'tool', tool_info: { error: { message: 'permission check failed: user denied permission' } } } }, result],
    [init, { ...result, result: { ...result.result, conversation_id: 'other' } }],
  ]) {
    expect(() => { const p = new AntigravityResults(model); p.push(bytes(...events)); p.finish() }).toThrow()
  }
})
test('providers reuse durable lifecycle without colliding or falling back', async () => {
  const context = fixture(); let calls = 0
  const claude = new ClaudeDelegations(context, async () => 'claude')
  const agy = new ClaudeDelegations(context, async () => { calls++; return 'agy' }, 'antigravity')
  const request = { key: 'same-key', prompt: 'task', model }
  const a = agy.start(request), c = claude.start({ ...request, model: 'claude-opus-5-5' })
  expect(a.id).not.toBe(c.id); expect(agy.start(request).id).toBe(a.id)
  expect(pendingClaudeDelegation(context.stateDir, context.job.id)).not.toBeNull()
  expect((await agy.wait(a.id)).result).toBe('agy'); expect(calls).toBe(1)
  const recovered = new ClaudeDelegations(context, async () => { throw Error('no replay') }, 'antigravity')
  expect(recovered.start(request).status).toBe('completed')
  expect(() => agy.start({ ...request, prompt: 'changed' })).toThrow()
  expect(() => agy.start({ ...request, model: '--resume=other' })).toThrow()
  await Promise.all([claude.close(), agy.close(), recovered.close()])
})
test('Antigravity MCP catalog and omitted model route to its provider', async () => {
  const context = fixture(), claude = new ClaudeDelegations(context, async () => 'claude')
  const agy = new ClaudeDelegations(context, async (_context, _id, request) => { expect(request.model).toBe('default'); return 'agy' }, 'antigravity')
  const server = createDelegationServer(claude, agy), client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a); await client.connect(b)
  try {
    const names = (await client.listTools()).tools.map(t => t.name)
    expect(names).toContain('claude_delegate_start'); expect(names).toContain('antigravity_delegate_cancel')
    expect(names).toContain('antigravity_delegate_retry_after_authentication')
    const start = await client.callTool({ name: 'antigravity_delegate_start', arguments: { key: 'mcp', prompt: 'task' } })
    const id = JSON.parse((start.content as any)[0].text).id
    expect((await agy.wait(id)).result).toBe('agy')
  } finally { await client.close(); await server.close(); await claude.close(); await agy.close() }
})
test.each([false, true])('sandbox retains project authorization and host state denial (write=%s)', writeEnabled => {
  const context = fixture(writeEnabled)
  const prepared = prepareClaudeJobContext({ ...context.job, id: 'delegate-test' }, context.stateDir, { model, parentJobId: context.job.id })
  try {
    const args = antigravitySandbox(prepared, process.execPath, model, writeEnabled)
    const overrides = args.flatMap((v, i) => v === '-c' ? [args[i + 1]!] : [])
    const parsed = Bun.TOML.parse(overrides.join('\n')) as any
    const fs = parsed.permissions[prepared.toolsContext.profile].filesystem
    expect(fs[context.job.repoPath]).toBe(writeEnabled ? 'write' : 'read')
    expect(fs[context.stateDir]).toBe('deny')
    const network = parsed.permissions[prepared.toolsContext.profile].network
    expect(network.enabled).toBe(true)
    expect(network.domains['*']).toBe('allow')
    if (!writeEnabled) expect(network.domains['slack.com']).toBe('deny')
    expect(args.slice(args.indexOf('--') + 1)).toEqual([process.execPath,
      '--dangerously-skip-permissions', '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands',
      ...(!writeEnabled ? ['--mode', 'plan'] : []), '--model', model])
    // The shared pane manifest must accept the complete permission argv.
    expect(args.length).toBeLessThanOrEqual(129)
    expect(args).toContain('--dangerously-skip-permissions')
    expect(parsed.shell_environment_policy.set.HOME).toBe(require('os').homedir())
  } finally { prepared.retire() }
})
test.each([0, 3])('native result and process exit both gate success (exit=%s)', async code => {
  const context = fixture(); let closed = 0, input = '', ended = false
  const promise = runAntigravityDelegation(context, 'a'.repeat(64), { model, prompt: 'task' }, new AbortController().signal, {
    executable: () => process.execPath,
    command: () => [process.execPath],
    transport: async options => {
      expect(options.providerLabel).toBe('Antigravity')
      return { input: { write: async value => { input += value }, end: async () => { ended = true } },
        output: new ReadableStream({ start(c) { c.enqueue(bytes(init, result)); c.close() } }),
        exited: Promise.resolve(code), close: async () => { closed++ }, identity: {} as any, pane: {} as any }
    },
  })
  if (code === 0) expect(await promise).toBe('日本語 OK')
  else await expect(promise).rejects.toThrow()
  expect(closed).toBe(1); expect(ended).toBe(true)
  expect(JSON.parse(input).event).toBe('user'); expect(input).not.toContain('control_request')
})

test('Antigravity cancellation reaps its worker and never starts Claude fallback', async () => {
  const context = fixture(); let started = 0, stopped = 0
  const agy = new ClaudeDelegations(context, async (_context, _id, _request, signal) => {
    started++
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { stopped++; resolve() }, { once: true }))
    throw Error('cancelled')
  }, 'antigravity')
  const first = agy.start({ key: 'cancel', model, prompt: 'task' })
  await Bun.sleep(5)
  expect((await agy.cancel(first.id)).status).toBe('cancelled')
  expect(started).toBe(1); expect(stopped).toBe(1)
  expect(pendingClaudeDelegation(context.stateDir, context.job.id)).toBeNull()
  expect(agy.start({ key: 'cancel', model, prompt: 'task' }).status).toBe('cancelled')
  await agy.close()
})


test('only a native authentication rejection before any work can permit recovery', () => {
  const authError = { event: 'result', result: { status: 'ERROR', error: 'Auth token read failed', num_turns: 0, conversation_id: '', response: '' } }
  for (const [events, safe] of [[[], true], [[init], false], [[{ event: 'step_update', step_update: { step_type: 'tool' } }], false]] as const) {
    const parser = new AntigravityResults(model)
    try { parser.push(bytes(...events, authError)); throw Error('expected rejection') }
    catch (error: any) {
      expect(error.failure.code).toBe('authentication')
      expect(error.failure.retrySafe).toBe(safe)
      expect(error.failure.cleanupVerified).toBe(false)
    }
  }
  const parser = new AntigravityResults(model)
  parser.push(bytes(init, { ...result, result: { ...result.result, response: 'Auth token read failed' } }))
  expect(parser.finish()).toBe('Auth token read failed')
})
