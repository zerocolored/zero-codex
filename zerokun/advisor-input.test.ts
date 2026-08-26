import { describe, expect, test } from 'bun:test'
import {
  createAdvisorInputSnapshot,
  MAX_CANONICAL_INPUT_BYTES,
  MAX_CANONICAL_INPUT_CHARS,
} from './advisor-input.ts'

function job(task: string) {
  return {
    id: 'job-boundary',
    message_id: 'message-boundary',
    user_id: 'user-boundary',
    write_enabled: 0,
    task,
    attachments_json: '[]',
    input_revision: 1,
  }
}

describe('advisor canonical input bounds', () => {
  test('上限近い日本語threadもbyte基準内で全advisorへ渡せる', () => {
    const task = 'あ'.repeat(MAX_CANONICAL_INPUT_CHARS - 1_024)
    const snapshot = createAdvisorInputSnapshot(job(task), [])
    expect(snapshot.transcript).toContain(task)
    const canonical = JSON.stringify({ version: 2, jobId: 'job-boundary', entries: snapshot.entries })
    expect(canonical.length).toBeLessThanOrEqual(MAX_CANONICAL_INPUT_CHARS)
    expect(Buffer.byteLength(canonical, 'utf8')).toBeLessThanOrEqual(MAX_CANONICAL_INPUT_BYTES)
    expect(Buffer.byteLength(snapshot.transcript, 'utf8')).toBeLessThan(2 * 1024 * 1024)
  })

  test('文字上限を越えるthreadはworkspace作成前のcanonical化で拒否する', () => {
    expect(() => createAdvisorInputSnapshot(
      job('x'.repeat(MAX_CANONICAL_INPUT_CHARS + 1)),
      [],
    )).toThrow('managed size limit')
  })
})
