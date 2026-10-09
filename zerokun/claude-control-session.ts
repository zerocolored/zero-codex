import { randomUUID } from 'crypto'

export type ClaudeEvent = Record<string, unknown> & { type: string }
type Input = { write(value: string): unknown; end?(): unknown }
type Pending = { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; requestId: number }

export class ClaudeProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'ClaudeProtocolError' }
}

/** A written request may have been accepted. This is never retry authority. */
export class ClaudeDeliveryUnknownError extends ClaudeProtocolError {
  constructor(readonly requestId: number, message = 'Claude request delivery is unknown') {
    super(message); this.name = 'ClaudeDeliveryUnknownError'
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

export function claudeRootEvent(event: ClaudeEvent): boolean {
  return event.parent_tool_use_id === undefined || event.parent_tool_use_id === null
}

export function claudeAssistantText(event: ClaudeEvent): string | null {
  if (event.type !== 'assistant' || !claudeRootEvent(event)) return null
  const content = record(event.message)?.content
  if (!Array.isArray(content)) return null
  return content.flatMap(value => {
    const block = record(value)
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('\n') || null
}

export function claudeResult(event: ClaudeEvent):
  | { kind: 'success'; text: string }
  | { kind: 'cancelled' | 'failed' }
  | null {
  if (event.type !== 'result' || !claudeRootEvent(event)) return null
  if (event.origin !== undefined && event.origin !== null && record(event.origin)?.kind !== 'human') return null
  if (event.terminal_reason === 'aborted_streaming' || event.terminal_reason === 'aborted_tools') return { kind: 'cancelled' }
  if (event.subtype !== 'success' || event.is_error !== false || typeof event.result !== 'string' || !event.result.trim()) return { kind: 'failed' }
  return { kind: 'success', text: event.result }
}

/** Native stream-json transport. It does not infer completion from the terminal,
 * a process exit, an assistant message, or an uncorrelated control response.
 * The host owns task semantics, permission decisions and durable dispatches. */
export class ClaudeControlSession {
  private sequence = 0
  private readonly nonce = randomUUID()
  private readonly pending = new Map<string, Pending>()
  private readonly userAcks = new Map<string, Pending>()
  private readonly sentMessageIds = new Set<string>()
  private readonly incoming = new Map<string, AbortController>()
  private readonly queue: ClaudeEvent[] = []
  private queuedBytes = 0
  private failure: Error | null = null
  private ended = false
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private wake = new Set<() => void>()
  readonly drained: Promise<void>
  model: string | null = null
  sessionState: string | null = null
  readonly capabilities = new Set<string>()

  constructor(
    private input: Input,
    output: ReadableStream<Uint8Array>,
    readonly sessionId: string,
    private options: {
      expectedModel?: string
      requestTimeoutMs?: number
      maxLineBytes?: number
      maxQueuedBytes?: number
      onEvent?(event: ClaudeEvent): void
      onControlRequest?(request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>
    } = {},
  ) {
    if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new ClaudeProtocolError('invalid Claude session id')
    this.reader = output.getReader()
    this.drained = this.read().catch(error => this.fail(error)).finally(() => {
      this.ended = true
      this.rejectOutstanding()
      this.notify()
      this.reader.releaseLock()
    })
  }

  private notify(): void { for (const wake of [...this.wake]) wake() }

  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error : new ClaudeProtocolError('Claude transport failed')
    this.rejectOutstanding()
    this.notify()
  }

  private rejectOutstanding(): void {
    for (const pending of [...this.pending.values(), ...this.userAcks.values()]) {
      clearTimeout(pending.timer)
      pending.reject(new ClaudeDeliveryUnknownError(pending.requestId, 'Claude stream ended before acknowledgement'))
    }
    this.pending.clear(); this.userAcks.clear()
    for (const controller of this.incoming.values()) controller.abort()
  }

  private checkWritable(): void {
    if (this.failure) throw this.failure
    if (this.ended) throw new ClaudeProtocolError('Claude stream is closed')
  }

  private async write(value: Record<string, unknown>): Promise<void> {
    this.checkWritable()
    await this.input.write(JSON.stringify(value) + '\n')
  }

  private waitFor(map: Map<string, Pending>, key: string, requestId: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        map.delete(key)
        reject(new ClaudeDeliveryUnknownError(requestId))
      }, this.options.requestTimeoutMs ?? 60_000)
      map.set(key, { resolve, reject, timer, requestId })
    })
  }

  async request(
    request: Record<string, unknown>,
    beforeWrite?: (requestId: number) => void,
  ): Promise<{ requestId: number; response: Record<string, unknown> }> {
    this.checkWritable()
    const requestId = ++this.sequence, wireId = `${this.nonce}:${requestId}`
    // Caller journals before any bytes can be delivered.
    beforeWrite?.(requestId)
    const response = this.waitFor(this.pending, wireId, requestId)
    void response.catch(() => {})
    try { await this.write({ type: 'control_request', request_id: wireId, request }) }
    catch {
      const pending = this.pending.get(wireId)
      if (pending) { clearTimeout(pending.timer); this.pending.delete(wireId); pending.reject(new ClaudeDeliveryUnknownError(requestId)) }
    }
    return { requestId, response: await response }
  }

  initialize(hooks?: Record<string, unknown>) {
    return this.request({ subtype: 'initialize', hooks: hooks ?? null })
  }

  interrupt() { return this.request({ subtype: 'interrupt' }) }

  async sendUser(input: {
    messageId: string
    content: string
    beforeWrite?(requestId: number): void
  }): Promise<{ requestId: number; messageId: string }> {
    this.checkWritable()
    if (!/^[a-f0-9-]{36}$/i.test(input.messageId) || this.sentMessageIds.has(input.messageId)) {
      throw new ClaudeProtocolError('invalid or pending Claude message id')
    }
    const requestId = ++this.sequence
    input.beforeWrite?.(requestId)
    this.sentMessageIds.add(input.messageId)
    const acknowledgement = this.waitFor(this.userAcks, input.messageId, requestId)
    void acknowledgement.catch(() => {})
    try {
      await this.write({ type: 'user', uuid: input.messageId, session_id: this.sessionId,
        origin: { kind: 'human' },
        parent_tool_use_id: null, message: { role: 'user', content: input.content } })
    } catch {
      const pending = this.userAcks.get(input.messageId)
      if (pending) { clearTimeout(pending.timer); this.userAcks.delete(input.messageId); pending.reject(new ClaudeDeliveryUnknownError(requestId)) }
    }
    await acknowledgement
    return { requestId, messageId: input.messageId }
  }

  /** Returns null only for an observation timeout; EOF is an explicit error. */
  async nextEvent(waitMs = 100): Promise<ClaudeEvent | null> {
    if (this.failure) throw this.failure
    if (!this.queue.length && !this.ended) {
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.wake.delete(wake); resolve() }
        const timer = setTimeout(wake, waitMs)
        this.wake.add(wake)
      })
    }
    if (this.failure) throw this.failure
    const event = this.queue.shift()
    if (event) { this.queuedBytes -= Buffer.byteLength(JSON.stringify(event)); return event }
    if (this.ended) throw new ClaudeProtocolError('Claude stream ended')
    return null
  }

  async endInput(): Promise<void> { await this.input.end?.() }

  /** Caller still owns terminating/reaping the process and its descendants. */
  async close(): Promise<void> {
    this.ended = true
    this.rejectOutstanding(); this.notify()
    try { await this.reader.cancel() } catch {}
    await this.drained
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const max = this.options.maxLineBytes ?? 8 * 1024 * 1024
    let buffer = ''
    const decodeLine = (line: string) => {
      if (Buffer.byteLength(line) > max) throw new ClaudeProtocolError('Claude event exceeds its limit')
      if (!line.trim()) return
      let event: Record<string, unknown> | null
      try { event = record(JSON.parse(line)) } catch { throw new ClaudeProtocolError('invalid Claude JSON event') }
      if (!event || typeof event.type !== 'string') throw new ClaudeProtocolError('invalid Claude event')
      this.accept(event as ClaudeEvent)
    }
    while (true) {
      const next = await this.reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) !== -1) {
        decodeLine(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      }
      if (Buffer.byteLength(buffer) > max) throw new ClaudeProtocolError('Claude event exceeds its limit')
    }
    buffer += decoder.decode()
    if (buffer.trim()) decodeLine(buffer)
  }

  private accept(event: ClaudeEvent): void {
    if (claudeRootEvent(event) && event.session_id !== undefined && event.session_id !== this.sessionId) {
      throw new ClaudeProtocolError('Claude event belongs to another session')
    }
    if (event.type === 'control_response') {
      const response = record(event.response)
      const key = response?.request_id
      if (typeof key !== 'string') throw new ClaudeProtocolError('Claude response omitted request id')
      const pending = this.pending.get(key)
      if (!pending) return // late/unknown receipt never satisfies a different request
      this.pending.delete(key); clearTimeout(pending.timer)
      if (response?.subtype === 'success') pending.resolve(record(response.response) ?? {})
      else pending.reject(new ClaudeProtocolError('Claude control request was rejected'))
      return
    }
    if (event.type === 'control_cancel_request') {
      if (typeof event.request_id === 'string') this.incoming.get(event.request_id)?.abort()
      return
    }
    if (event.type === 'control_request') {
      const request = record(event.request), key = event.request_id
      if (!request || typeof key !== 'string' || this.incoming.has(key)) throw new ClaudeProtocolError('invalid Claude control request')
      const controller = new AbortController(); this.incoming.set(key, controller)
      void (async () => {
        try {
          const response = this.options.onControlRequest
            ? await this.options.onControlRequest(request, controller.signal)
            : { behavior: 'deny', message: 'This host has no handler for this request.' }
          if (!controller.signal.aborted && !this.ended) await this.write({ type: 'control_response',
            response: { subtype: 'success', request_id: key, response } })
        } catch {
          if (!controller.signal.aborted && !this.ended) await this.write({ type: 'control_response',
            response: { subtype: 'error', request_id: key, error: 'Host request could not complete' } })
        } finally { this.incoming.delete(key) }
      })().catch(error => this.fail(error))
      return
    }
    if (claudeRootEvent(event) && event.type === 'system' && event.subtype === 'init') {
      if (typeof event.model !== 'string' || !/^claude-opus-[a-zA-Z0-9.-]+$/.test(event.model)) {
        throw new ClaudeProtocolError('Claude primary did not select an Opus model')
      }
      if ((this.model !== null && event.model !== this.model)
        || (this.options.expectedModel && event.model !== this.options.expectedModel)) {
        throw new ClaudeProtocolError('Claude primary model changed within the task')
      }
      this.model = event.model
      if (Array.isArray(event.capabilities)) for (const capability of event.capabilities) {
        if (typeof capability === 'string') this.capabilities.add(capability)
      }
    }
    if (claudeRootEvent(event) && event.type === 'system' && event.subtype === 'session_state_changed') {
      this.sessionState = typeof event.state === 'string' ? event.state : null
    }
    if (claudeRootEvent(event) && event.type === 'user' && typeof event.uuid === 'string') {
      const pending = this.userAcks.get(event.uuid)
      if (pending) { this.userAcks.delete(event.uuid); clearTimeout(pending.timer); pending.resolve(event) }
    }
    this.options.onEvent?.(event)
    this.queuedBytes += Buffer.byteLength(JSON.stringify(event))
    if (this.queuedBytes > (this.options.maxQueuedBytes ?? 32 * 1024 * 1024)) throw new ClaudeProtocolError('Claude event consumer fell behind')
    this.queue.push(event); this.notify()
  }
}
