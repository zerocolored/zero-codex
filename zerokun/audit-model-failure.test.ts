import { expect, test } from 'bun:test'
import { AuditModelError, auditRetryDelay, collectAuditModelDiagnostic } from './audit-model-failure.ts'

test('model diagnostics classify failures without publishing raw stderr', () => {
  for (const [text, reason, retryable] of [
    ['no space left on device', 'disk-full', false],
    ['insufficient quota', 'quota', false],
    ['401 unauthorized', 'authentication', false],
    ['429 rate limit', 'throttled', true],
    ['503 overloaded', 'capacity', true],
    ['stream disconnected', 'transport', true],
    ['something else', 'unclassified', false],
  ] as const) {
    const error = new AuditModelError(1, text + ' private stderr fixture')
    expect(error.reason).toBe(reason)
    expect(error.retryable).toBe(retryable)
    expect(error.message).not.toContain('private stderr fixture')
  }
  expect(new AuditModelError(1, 'no space left on device; 429').retryable).toBe(false)
})

test('diagnostic reader drains large output while retaining only a bounded tail', async () => {
  let chunks = 0
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (chunks++ < 100) controller.enqueue(new Uint8Array(65536).fill(120))
    else { controller.enqueue(new TextEncoder().encode('stream disconnected')); controller.close() }
  } })
  const tail = await collectAuditModelDiagnostic(stream)
  expect(chunks).toBe(101)
  expect(Buffer.byteLength(tail)).toBe(32768)
  expect(tail.endsWith('stream disconnected')).toBe(true)
})

test('model retry wait cancels promptly', async () => {
  const controller = new AbortController()
  const pending = auditRetryDelay(60000, controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow('interrupted')
  await expect(auditRetryDelay(60000, controller.signal)).rejects.toThrow('interrupted')
  await auditRetryDelay(1)
})
