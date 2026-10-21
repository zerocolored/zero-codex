import { afterEach, expect, test, spyOn } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { JobStore } from './job-runner.ts'
import { ClaudeDelegations, type DelegationContext } from './claude-delegation-broker.ts'
import { runClaudeDelegation, ClaudeDelegationError, DelegationAttemptObservation } from './claude-delegation-attempt.ts'
import type { ClaudeHerdrTransport } from './claude-herdr-transport.ts'
import type { ClaudeEvent } from './claude-control-session.ts'
import { FABLE_ADVISOR_MODEL, OPUS_ADVISOR_MODEL } from './claude-quota-fallback.ts'
import * as safeFile from './safe-file.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const quota = (text = "You've reached your Fable limit."): ClaudeEvent => ({ type: 'assistant', parent_tool_use_id: null,
  isApiErrorMessage: true, error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text }] } })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delegation-attempt-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'), stateDir = join(root, 'state'); mkdirSync(repo); mkdirSync(stateDir, { mode: 0o700 })
  const store = new JobStore(join(stateDir, 'jobs.sqlite3')); cleanups.push(() => store.close())
  store.enqueue({ repoPath: repo, chatId: 'C', threadTs: '1800000000.1', messageId: '1800000000.1', userId: 'U', task: 'review', writeEnabled: true })
  const job = store.claimNext('test')!
  return { store, context: { version: 1, stateDir, job } as DelegationContext }
}

/** Exercise the actual stream protocol and attempt cleanup, not just a thrown mock error. */
function runner(options: { events?: ClaudeEvent[]; disconnect?: boolean; cleanupFailure?: boolean; opusFailure?: boolean; onSend?: () => void } = {}) {
  const models: string[] = [], closed: string[] = [], sessions: string[] = []
  const run: typeof runClaudeDelegation = (context, id, request, signal) => runClaudeDelegation(context, id, request, signal, {
    executable: () => '/synthetic/claude',
    transport: async input => {
      const model = input.arguments[input.arguments.indexOf('--model') + 1]!
      const session = input.arguments[input.arguments.indexOf('--session-id') + 1]!
      models.push(model); sessions.push(session)
      let output!: ReadableStreamDefaultController<Uint8Array>, ended = false
      const stream = new ReadableStream<Uint8Array>({ start(c) { output = c } })
      const emit = (event: Record<string, unknown>) => output.enqueue(Buffer.from(JSON.stringify({ session_id: session, ...event }) + '\n'))
      return {
        input: { write(line: string) {
          const packet = JSON.parse(line)
          if (packet.type === 'control_request') emit({ type: 'control_response', response: { subtype: 'success', request_id: packet.request_id, response: {} } })
          if (packet.type === 'user') {
            emit(packet); emit({ type: 'system', subtype: 'init', model })
            options.onSend?.()
            if (model === FABLE_ADVISOR_MODEL) {
              for (const event of options.events ?? [quota()]) emit(event)
              if (options.disconnect) { ended = true; output.close() }
              else emit({ type: 'result', subtype: 'error_during_execution', is_error: true })
            } else if (options.opusFailure) {
              emit(quota("You've reached your Opus limit.")); emit({ type: 'result', subtype: 'error_during_execution', is_error: true })
            } else emit({ type: 'result', subtype: 'success', is_error: false, result: 'Hello from Opus' })
          }
          return Promise.resolve()
        }, end() { return Promise.resolve() } },
        output: stream,
        async close() {
          closed.push(model)
          if (!ended) { ended = true; output.close() }
          if (options.cleanupFailure) throw Error('synthetic private cleanup detail')
        },
      } as ClaudeHerdrTransport
    },
  })
  return { run, models, closed, sessions }
}
const request = { key: 'hello', model: FABLE_ADVISOR_MODEL, prompt: 'Say hello; do not change files.' }

test.each([false, true])('native Fable rejection -> cleanup -> durable Opus attempt, failure=%s', async opusFailure => {
  const f = fixture(), r = runner({ opusFailure }), runs = new ClaudeDelegations(f.context, async (...args) => {
    if (args[2].model === OPUS_ADVISOR_MODEL) {
      expect(r.closed).toEqual([FABLE_ADVISOR_MODEL])
      const saved = JSON.parse(readFileSync(join(f.context.stateDir, 'delegations', f.context.job.id, `${args[1]}.json`), 'utf8'))
      expect(saved).toMatchObject({ requestedModel: FABLE_ADVISOR_MODEL, model: OPUS_ADVISOR_MODEL, status: 'running' })
      expect(f.store.pendingStatusNotifications()).toHaveLength(1)
    }
    return r.run(...args)
  })
  const first = runs.start(request), result = await runs.wait(first.id)
  expect(result).toMatchObject({ status: opusFailure ? 'failed' : 'completed', requestedModel: FABLE_ADVISOR_MODEL,
    model: OPUS_ADVISOR_MODEL, fallbackFrom: FABLE_ADVISOR_MODEL, fallbackReason: 'fable-quota' })
  expect(result.fallbackNotice).toContain('Opus 5.5')
  if (opusFailure) expect(result.failure).toMatchObject({ code: 'rate-limit', quotaScope: 'other' })
  else expect(result.result).toBe('Hello from Opus')
  expect(result.attempts?.[0]?.failure.code).toBe('fable-quota')
  expect(r.models).toEqual([FABLE_ADVISOR_MODEL, OPUS_ADVISOR_MODEL])
  expect(new Set(r.sessions).size).toBe(2)
  expect(new ClaudeDelegations(f.context, async () => { throw Error('replayed') }).start(request)).toEqual(result)
  expect(f.store.pendingStatusNotifications()).toHaveLength(1)
  await runs.close()
})

test.each([
  { label: 'ordinary prose', events: [{ type: 'assistant', message: { model: FABLE_ADVISOR_MODEL, content: [{ type: 'text', text: "You've reached your Fable limit." }] } }] },
  { label: 'tool output', events: [{ ...quota(), type: 'tool_result' }] },
  { label: 'nested', events: [{ ...quota(), parent_tool_use_id: 'nested' }] },
  { label: 'general quota', events: [quota("You've reached your weekly limit.")] },
  { label: '429', events: [quota('429 Too Many Requests')] },
  { label: 'after thinking', events: [{ type: 'assistant', message: { model: FABLE_ADVISOR_MODEL, content: [{ type: 'thinking', thinking: 'working' }] } }, quota()] },
  { label: 'after tool call', events: [{ type: 'assistant', message: { model: FABLE_ADVISOR_MODEL, content: [{ type: 'tool_use', id: 'one', name: 'write' }] } }, quota()] },
  { label: 'stream disconnect', disconnect: true },
  { label: 'cleanup failure', cleanupFailure: true },
])('never retry $label', async options => {
  const f = fixture(), r = runner(options as Parameters<typeof runner>[0]), runs = new ClaudeDelegations(f.context, r.run)
  const result = await runs.wait(runs.start(request).id)
  expect(result.status).toBe('failed'); expect(result.failure?.reason).toBeTruthy()
  expect(r.models).toEqual([FABLE_ADVISOR_MODEL]); expect(f.store.pendingStatusNotifications()).toHaveLength(0)
  if (options.label === 'cleanup failure') {
    expect(result.failure).toMatchObject({ code: 'cleanup', priorCode: 'fable-quota', cleanupVerified: false })
    await expect(runs.close()).rejects.toBeInstanceOf(ClaudeDelegationError)
  } else await runs.close()
})

test('native wire error can omit storage-only isApiErrorMessage; explicit false cannot trigger', () => {
  const wire = quota(); delete wire.isApiErrorMessage
  const observed = new DelegationAttemptObservation(); observed.observe(wire)
  expect(observed.failure()).toMatchObject({ code: 'fable-quota', retrySafe: true })
  const ordinary = new DelegationAttemptObservation(); ordinary.observe({ ...wire, isApiErrorMessage: false })
  expect(ordinary.failure().retrySafe).toBe(false)
})

test('generic private exceptions are replaced with a durable fixed diagnostic', async () => {
  const f = fixture(), runs = new ClaudeDelegations(f.context, async () => { throw Error('SECRET_DO_NOT_RELAY') })
  const result = await runs.wait(runs.start(request).id)
  expect(result.failure?.code).toBe('unknown')
  expect(JSON.stringify(result)).not.toContain('SECRET_DO_NOT_RELAY')
  expect(new ClaudeDelegations(f.context).poll(result.id).failure).toEqual(result.failure)
  await runs.close()
})

test('cancellation during Fable rejection does not launch Opus', async () => {
  const f = fixture(); let cancel: () => void = () => {}
  const r = runner({ onSend: () => cancel() }), runs = new ClaudeDelegations(f.context, r.run)
  const started = runs.start(request); cancel = () => { void runs.cancel(started.id) }
  expect((await runs.wait(started.id)).status).toBe('cancelled')
  expect(r.models).toEqual([FABLE_ADVISOR_MODEL]); expect(f.store.pendingStatusNotifications()).toHaveLength(0)
  await runs.close()
})

test('cancellation preserves cleanup failure in durable diagnostics and close rejects', async () => {
  const f = fixture(); let cancel: () => void = () => {}
  const r = runner({ cleanupFailure: true, onSend: () => cancel() })
  const runs = new ClaudeDelegations(f.context, r.run)
  const started = runs.start(request); cancel = () => { void runs.cancel(started.id) }
  const result = await runs.wait(started.id)
  expect(result).toMatchObject({ status: 'cancelled', failure: { code: 'cleanup', cleanupVerified: false } })
  expect(new ClaudeDelegations(f.context).poll(started.id).failure).toEqual(result.failure)
  expect(r.models).toEqual([FABLE_ADVISOR_MODEL])
  expect(f.store.pendingStatusNotifications()).toHaveLength(0)
  await expect(runs.close()).rejects.toBeInstanceOf(ClaudeDelegationError)
})

test('fallback claim persistence failure cannot launch Opus or expose raw error', async () => {
  const f = fixture(), r = runner(), original = safeFile.atomicWritePrivateFile
  const write = spyOn(safeFile, 'atomicWritePrivateFile').mockImplementation((path, content) => {
    if (String(content).includes('"fallbackReason":"fable-quota"') && String(content).includes('"status":"running"')) throw Error('PRIVATE_DISK_DETAIL')
    return original(path, content)
  })
  try {
    const runs = new ClaudeDelegations(f.context, r.run), result = await runs.wait(runs.start(request).id)
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'persistence' } })
    expect(r.models).toEqual([FABLE_ADVISOR_MODEL]); expect(JSON.stringify(result)).not.toContain('PRIVATE_DISK_DETAIL')
    expect(f.store.pendingStatusNotifications()).toHaveLength(0)
    expect(new ClaudeDelegations(f.context, async () => { throw Error('no replay') }).start(request).status).toBe('failed')
    await runs.close()
  } finally { write.mockRestore() }
})

test('a lost broker after the durable Opus claim cannot send either model again', async () => {
  const f = fixture(), r = runner(); let release!: () => void
  const runs = new ClaudeDelegations(f.context, async (...args) => {
    if (args[2].model === OPUS_ADVISOR_MODEL) {
      await new Promise<void>(resolve => { release = resolve })
      throw new Error('lost after delivery')
    }
    return r.run(...args)
  })
  const started = runs.start(request)
  for (let i = 0; !release && i < 200; i++) await Bun.sleep(10)
  expect(release).toBeFunction()
  const path = join(f.context.stateDir, 'delegations', f.context.job.id, `${started.id}.json`)
  const saved = JSON.parse(readFileSync(path, 'utf8')); delete saved.owner
  safeFile.atomicWritePrivateFile(path, JSON.stringify(saved))
  const restarted = new ClaudeDelegations(f.context, async () => { throw Error('must not replay') })
  expect(restarted.start(request)).toMatchObject({ status: 'interrupted', model: OPUS_ADVISOR_MODEL,
    requestedModel: FABLE_ADVISOR_MODEL, failure: { code: 'delivery-unknown' } })
  release(); await runs.wait(started.id); await runs.close(); await restarted.close()
})
