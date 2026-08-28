import { describe, expect, test } from 'bun:test'
import {
  buildCodexProgressPrompt,
  codexProgressClientMessageId,
  codexProgressOffsetForSlot,
  latestDueCodexProgressSlot,
  parseCodexProgressCommentary,
  progressCommentaryFromNotification,
  type CodexProgressSchedule,
} from './codex-executor.ts'

const schedule: CodexProgressSchedule = {
  firstMs: 10,
  secondMs: 30,
  thirdMs: 60,
  repeatMs: 60,
}
const marker = 'ABCDEF0123456789ABCDEF01'

describe('dynamic same-turn progress', () => {
  test('uses 10m, 30m, 60m, then hourly cadence', () => {
    expect([0, 1, 2, 3, 4].map(slot => codexProgressOffsetForSlot(slot)))
      .toEqual([600_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000])
  })

  test('collapses delayed boundaries to only the latest due slot', () => {
    const started = 1_000
    expect(latestDueCodexProgressSlot(started, 1_009, 0, schedule)).toBeNull()
    expect(latestDueCodexProgressSlot(started, 1_010, 0, schedule)).toBe(0)
    expect(latestDueCodexProgressSlot(started, 1_090, 0, schedule)).toBe(2)
    expect(latestDueCodexProgressSlot(started, 1_121, 3, schedule)).toBe(3)
    expect(latestDueCodexProgressSlot(started, 1_121, 4, schedule)).toBeNull()
  })

  test('includes the durable job attempt in the App Server idempotency key', () => {
    const first = codexProgressClientMessageId('job-1', 1, 0)
    expect(first).toHaveLength(64)
    expect(codexProgressClientMessageId('job-1', 1, 0)).toBe(first)
    expect(codexProgressClientMessageId('job-1', 2, 0)).not.toBe(first)
    expect(codexProgressClientMessageId('job-1', 1, 1)).not.toBe(first)
  })

  test('requires a bounded exact marker-only commentary response', () => {
    const begin = `[ZERO_PROGRESS_BEGIN:${marker}]`
    const end = `[ZERO_PROGRESS_END:${marker}]`
    expect(parseCodexProgressCommentary(`${begin}\n🔎 いま確認中です。次にテストします。\n${end}`, marker))
      .toBe('🔎 いま確認中です。次にテストします。')
    expect(parseCodexProgressCommentary(`prefix\n${begin}\n本文\n${end}`, marker)).toBeNull()
    expect(parseCodexProgressCommentary(`${begin}\n\n${end}`, marker)).toBeNull()
    expect(buildCodexProgressPrompt(marker)).toContain('continue the original task')
  })

  test('accepts only same-thread same-turn completed commentary items', () => {
    const text = `[ZERO_PROGRESS_BEGIN:${marker}]\n🧪 動作確認中です。\n[ZERO_PROGRESS_END:${marker}]`
    const notification = {
      method: 'item/completed',
      sequence: 1,
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', phase: 'commentary', text },
      },
    }
    expect(progressCommentaryFromNotification(notification, {
      threadId: 'thread-1', turnId: 'turn-1', marker,
    })).toBe('🧪 動作確認中です。')
    expect(progressCommentaryFromNotification({
      ...notification,
      params: { ...notification.params, turnId: 'turn-2' },
    }, { threadId: 'thread-1', turnId: 'turn-1', marker })).toBeNull()
    expect(progressCommentaryFromNotification({
      ...notification,
      params: {
        ...notification.params,
        item: { type: 'agentMessage', phase: 'final_answer', text },
      },
    }, { threadId: 'thread-1', turnId: 'turn-1', marker })).toBeNull()
  })
})
