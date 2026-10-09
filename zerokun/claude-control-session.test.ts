import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { ClaudeControlSession, ClaudeDeliveryUnknownError, claudeAssistantText, claudeResult } from './claude-control-session.ts'

const sessions: ClaudeControlSession[] = []
afterEach(async () => { for (const session of sessions.splice(0)) await session.close() })

function fixture(options: ConstructorParameters<typeof ClaudeControlSession>[3] = {}) {
  const id = randomUUID(), writes: Record<string, unknown>[] = []
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const output = new ReadableStream<Uint8Array>({ start(controller) { stream = controller } })
  const session = new ClaudeControlSession({ write(line) { writes.push(JSON.parse(line)) } }, output, id, options)
  sessions.push(session)
  const emit = (event: Record<string, unknown>) => stream.enqueue(Buffer.from(JSON.stringify(event) + '\n'))
  return { id, writes, session, emit, stream }
}

test('initialization responses are correlated; unknown/late receipts do not complete another request', async () => {
  const f = fixture()
  const first = f.session.initialize()
  f.emit({ type: 'control_response', response: { subtype: 'success', request_id: 'foreign', response: {} } })
  f.emit({ type: 'control_response', response: { subtype: 'success', request_id: f.writes[0]!.request_id, response: { supported: true } } })
  expect((await first).response).toEqual({ supported: true })
})

test('input is journaled before write and acknowledged only by its root user replay', async () => {
  const f = fixture(), messageId = randomUUID()
  let before = false
  const sent = f.session.sendUser({ messageId, content: 'synthetic input', beforeWrite() {
    expect(f.writes).toHaveLength(0); before = true
  } })
  expect(before).toBe(true)
  f.emit({ type: 'user', uuid: messageId, parent_tool_use_id: 'child', session_id: randomUUID() })
  f.emit({ type: 'user', uuid: messageId, parent_tool_use_id: null, session_id: f.id })
  expect((await sent).messageId).toBe(messageId)
  await expect(f.session.sendUser({ messageId, content: 'repeat' })).rejects.toThrow('pending Claude message id')
  expect(f.writes).toHaveLength(1)
})

test('uncertain delivery is never automatically resent, including after late acknowledgement', async () => {
  const f = fixture({ requestTimeoutMs: 10 }), messageId = randomUUID()
  await expect(f.session.sendUser({ messageId, content: 'one' })).rejects.toBeInstanceOf(ClaudeDeliveryUnknownError)
  f.emit({ type: 'user', uuid: messageId, session_id: f.id })
  await expect(f.session.sendUser({ messageId, content: 'two' })).rejects.toThrow()
  expect(f.writes).toHaveLength(1)
})

test('persistence failure before dispatch writes no bytes', async () => {
  const f = fixture()
  await expect(f.session.sendUser({ messageId: randomUUID(), content: 'one', beforeWrite() { throw new Error('disk') } })).rejects.toThrow('disk')
  expect(f.writes).toHaveLength(0)
})

test('root session and Opus model remain pinned while benign new capabilities are allowed', async () => {
  const f = fixture()
  f.emit({ type: 'system', subtype: 'init', session_id: f.id, model: 'claude-opus-5-5', capabilities: ['future-benign'] })
  await f.session.nextEvent()
  expect(f.session.model).toBe('claude-opus-5-5')
  expect(f.session.capabilities.has('future-benign')).toBe(true)
  f.emit({ type: 'system', subtype: 'init', session_id: f.id, model: 'claude-opus-5-6' })
  await expect(f.session.nextEvent()).rejects.toThrow('model changed')
})

test('foreign root events and non-Opus startup cannot be accepted', async () => {
  const foreign = fixture()
  foreign.emit({ type: 'result', session_id: randomUUID(), subtype: 'success', is_error: false, result: 'wrong' })
  await expect(foreign.session.nextEvent()).rejects.toThrow('another session')
  const wrong = fixture()
  wrong.emit({ type: 'system', subtype: 'init', session_id: wrong.id, model: 'claude-fable-5-1' })
  await expect(wrong.session.nextEvent()).rejects.toThrow('Opus')
})

test('permission callback cancellation never sends a late approval', async () => {
  let started!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  const f = fixture({ async onControlRequest(_request, signal) {
    started(); await wait; expect(signal.aborted).toBe(true); return { behavior: 'allow' }
  } })
  f.emit({ type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool', tool_name: 'Write' } })
  await ready
  f.emit({ type: 'control_cancel_request', request_id: 'permission' })
  await f.session.nextEvent(5)
  release(); await Bun.sleep(5)
  expect(f.writes).toHaveLength(0)
})

test('missing permission handler denies and does not silently approve', async () => {
  const f = fixture()
  f.emit({ type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool' } })
  await f.session.nextEvent(5)
  expect((f.writes[0]!.response as any).response.behavior).toBe('deny')
})

test('fragmented UTF-8, blank lines and a final line without newline are decoded', async () => {
  const f = fixture()
  const bytes = Buffer.from(JSON.stringify({ type: 'assistant', session_id: f.id, message: { content: [{ type: 'text', text: '日本語' }] } }))
  for (const byte of bytes) f.stream.enqueue(new Uint8Array([byte]))
  f.stream.close()
  const event = await f.session.nextEvent(1000)
  expect(claudeAssistantText(event!)).toBe('日本語')
  await expect(f.session.nextEvent()).rejects.toThrow('stream ended')
})

test('malformed or oversized events fail without forwarding payloads', async () => {
  const f = fixture({ maxLineBytes: 32 })
  f.stream.enqueue(Buffer.from('x'.repeat(33)))
  await expect(f.session.nextEvent()).rejects.toThrow('exceeds')
  const bad = fixture()
  bad.stream.enqueue(Buffer.from('{bad}\n'))
  await expect(bad.session.nextEvent()).rejects.toThrow('invalid Claude JSON')
})

test('result success requires is_error false; child output and interruption are not completion', () => {
  const base = { type: 'result', subtype: 'success', is_error: false, result: 'done' }
  expect(claudeResult(base)).toEqual({ kind: 'success', text: 'done' })
  expect(claudeResult({ ...base, is_error: true, result: 'Not logged in' })).toEqual({ kind: 'failed' })
  expect(claudeResult({ ...base, terminal_reason: 'aborted_streaming' })).toEqual({ kind: 'cancelled' })
  expect(claudeResult({ ...base, parent_tool_use_id: 'child' })).toBeNull()
  expect(claudeResult({ type: 'system', subtype: 'session_state_changed', state: 'idle' })).toBeNull()
})
