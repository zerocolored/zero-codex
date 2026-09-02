import { describe, expect, test } from 'bun:test'
import {
  buildInitialSlackThreadContext,
  MAX_INITIAL_THREAD_CONTEXT_BYTES,
  MAX_INITIAL_THREAD_CONTEXT_FILES,
  MAX_INITIAL_THREAD_CONTEXT_MESSAGES,
  planInitialSlackThreadContext,
  SlackInitialThreadContextError,
  SlackInitialThreadContextIncompleteError,
} from './slack-thread-context.ts'

const BOT = 'U0BOT123'
const CHANNEL = 'C0THREAD1'
const ROOT = '1788000000.000001'
const TRIGGER = '1788000003.000001'

describe('buildInitialSlackThreadContext', () => {
  test('rootから別ユーザーの途中メンションまでを時系列の1入力へまとめる', () => {
    const result = buildInitialSlackThreadContext({
      chatId: CHANNEL,
      threadTs: ROOT,
      triggerTs: TRIGGER,
      botUserId: BOT,
      hasMore: false,
      messages: [
        { ts: TRIGGER, thread_ts: ROOT, user: 'U0CAROL', text: `<@${BOT}> 確認して`, files: [{ id: 'F003' }] },
        { ts: ROOT, user: 'U0ALICE', text: '先頭です', files: [{ id: 'F001' }] },
        { ts: '1788000002.000001', thread_ts: ROOT, user: 'U0BOB', text: '補足です <@U0ALICE>', files: [{ id: 'F001' }, { id: 'F002' }] },
        { ts: '1788000001.000001', thread_ts: ROOT, bot_id: 'B0NOISE', subtype: 'bot_message', text: 'bot' },
        { ts: '1788000002.500001', thread_ts: ROOT, user: 'USLACKBOT', subtype: 'channel_join', text: 'system' },
      ],
    })

    expect(result.messageCount).toBe(3)
    expect(result.fileIds).toEqual(['F001', 'F002', 'F003'])
    expect(result.consumedMessageTs).toEqual([ROOT, '1788000002.000001'])
    expect(result.text.indexOf('先頭です')).toBeLessThan(result.text.indexOf('補足です'))
    expect(result.text.indexOf('補足です')).toBeLessThan(result.text.indexOf('確認して'))
    expect(result.text).not.toContain(BOT)
    expect(result.text).not.toContain('U0ALICE')
    expect(result.text).toContain('@参加者1')
    expect(result.text).not.toContain('\nbot\n')
    expect(result.text).toContain('添付: #1, #2')
  })

  test('同じユーザーと同じ添付は安定したaliasとordinalを再利用する', () => {
    const result = buildInitialSlackThreadContext({
      chatId: CHANNEL,
      threadTs: ROOT,
      triggerTs: TRIGGER,
      botUserId: BOT,
      hasMore: false,
      messages: [
        { ts: ROOT, user: 'U0ALICE', text: 'root', files: [{ id: 'F001' }] },
        { ts: TRIGGER, thread_ts: ROOT, user: 'U0ALICE', text: `<@${BOT}> go`, files: [{ id: 'F001' }] },
      ],
    })
    expect(result.fileIds).toEqual(['F001'])
    expect(result.text.match(/参加者1/g)?.length).toBe(2)
    expect(result.text.match(/添付: #1/g)?.length).toBe(2)
  })

  test('page、件数、添付数、root/trigger欠落を部分入力にせず拒否する', () => {
    const base = {
      chatId: CHANNEL,
      threadTs: ROOT,
      triggerTs: TRIGGER,
      botUserId: BOT,
    }
    expect(() => buildInitialSlackThreadContext({
      ...base,
      hasMore: true,
      messages: [],
    })).toThrow(SlackInitialThreadContextError)
    expect(() => buildInitialSlackThreadContext({
      ...base,
      hasMore: false,
      messages: [{ ts: TRIGGER, thread_ts: ROOT, user: 'U0ALICE', text: `<@${BOT}> go` }],
    })).toThrow(SlackInitialThreadContextIncompleteError)
    expect(() => buildInitialSlackThreadContext({
      ...base,
      hasMore: false,
      messages: [
        { ts: ROOT, user: 'U0ALICE', text: 'root' },
        { ts: TRIGGER, thread_ts: ROOT, user: 'U0ALICE', text: 'mention missing' },
      ],
    })).toThrow(SlackInitialThreadContextIncompleteError)

    const many = Array.from({ length: MAX_INITIAL_THREAD_CONTEXT_MESSAGES + 1 }, (_, index) => ({
      ts: `1788000001.${String(index + 1).padStart(6, '0')}`,
      thread_ts: ROOT,
      user: 'U0ALICE',
      text: index === MAX_INITIAL_THREAD_CONTEXT_MESSAGES ? `<@${BOT}> go` : 'message',
    }))
    many[0]!.ts = ROOT
    many.at(-1)!.ts = TRIGGER
    expect(() => buildInitialSlackThreadContext({
      ...base,
      hasMore: false,
      messages: many,
    })).toThrow(`${MAX_INITIAL_THREAD_CONTEXT_MESSAGES}件`)

    expect(() => buildInitialSlackThreadContext({
      ...base,
      hasMore: false,
      messages: [
        {
          ts: ROOT,
          user: 'U0ALICE',
          text: 'root',
          files: Array.from({ length: MAX_INITIAL_THREAD_CONTEXT_FILES + 1 }, (_, index) => ({ id: `F${index}A` })),
        },
        { ts: TRIGGER, thread_ts: ROOT, user: 'U0ALICE', text: `<@${BOT}> go` },
      ],
    })).toThrow(`${MAX_INITIAL_THREAD_CONTEXT_FILES}件`)

    expect(() => buildInitialSlackThreadContext({
      ...base,
      hasMore: false,
      messages: [
        { ts: ROOT, user: 'U0ALICE', text: 'x'.repeat(MAX_INITIAL_THREAD_CONTEXT_BYTES) },
        { ts: TRIGGER, thread_ts: ROOT, user: 'U0ALICE', text: `<@${BOT}> go` },
      ],
    })).toThrow(`${MAX_INITIAL_THREAD_CONTEXT_BYTES} bytes`)
  })

  test('LLM承認済みの観測triggerをcanonicalにし、それ以前を文脈としてだけ保持する', () => {
    const firstMention = '1788000001.000001'
    const plan = planInitialSlackThreadContext({
      chatId: CHANNEL,
      threadTs: ROOT,
      triggerTs: TRIGGER,
      botUserId: BOT,
      hasMore: false,
      messages: [
        { ts: ROOT, user: 'U0ALICE', text: '先頭です' },
        { ts: firstMention, thread_ts: ROOT, user: 'U0BOB', text: `<@${BOT}> 先に確認して` },
        {
          ts: '1788000002.000001', thread_ts: ROOT, user: 'U0CAROL',
          subtype: 'thread_broadcast', text: '補足です', files: [{ id: 'F002' }],
        },
        { ts: TRIGGER, thread_ts: ROOT, user: 'U0DAVE', text: `<@${BOT}> 後から確認して` },
      ],
    })
    expect(plan.kind).toBe('context')
    if (plan.kind !== 'context') throw new Error('context plan expected')
    expect(plan.context.trigger.messageId).toBe(TRIGGER)
    expect(plan.context.text).toContain('先に確認して')
    expect(plan.context.text).toContain('後から確認して')
    expect(plan.context.text).toContain('補足です')
    expect(plan.followups).toEqual([])
  })

  test('先頭がmention済みでも後続を直接replayせず観測triggerの文脈へまとめる', () => {
    const plan = planInitialSlackThreadContext({
      chatId: CHANNEL,
      threadTs: ROOT,
      triggerTs: TRIGGER,
      botUserId: BOT,
      hasMore: false,
      messages: [
        { ts: ROOT, user: 'U0ALICE', text: `<@${BOT}> 先頭の依頼`, files: [{ id: 'F001' }] },
        {
          ts: '1788000002.000001', thread_ts: ROOT, user: 'U0BOB',
          subtype: 'thread_broadcast', text: '途中の補足', files: [{ id: 'F002' }],
        },
        { ts: TRIGGER, thread_ts: ROOT, user: 'U0CAROL', text: `<@${BOT}> 再確認` },
      ],
    })
    expect(plan.kind).toBe('context')
    if (plan.kind !== 'context') throw new Error('context plan expected')
    expect(plan.context.trigger).toEqual({
      messageId: TRIGGER, userId: 'U0CAROL', text: '再確認', fileIds: [],
    })
    expect(plan.context.fileIds).toEqual(['F001', 'F002'])
    expect(plan.context.text).toContain('先頭の依頼')
    expect(plan.context.text).toContain('途中の補足')
    expect(plan.followups).toEqual([])
  })

  test('bot/system rootは文脈から除外しhumanのmention自体は失敗させない', () => {
    const plan = planInitialSlackThreadContext({
      chatId: CHANNEL,
      threadTs: ROOT,
      triggerTs: TRIGGER,
      botUserId: BOT,
      hasMore: false,
      messages: [
        { ts: ROOT, bot_id: 'B0CI', subtype: 'bot_message', text: 'CI notification' },
        {
          ts: '1788000002.000001', thread_ts: ROOT,
          user: 'U0ALICE', text: 'この失敗を調べて',
        },
        {
          ts: TRIGGER, thread_ts: ROOT,
          user: 'U0BOB', subtype: 'thread_broadcast', text: `<@${BOT}> お願い`,
        },
      ],
    })
    expect(plan.kind).toBe('context')
    if (plan.kind !== 'context') throw new Error('context plan expected')
    expect(plan.context.messageCount).toBe(2)
    expect(plan.context.text).toContain('この失敗を調べて')
    expect(plan.context.text).toContain('お願い')
    expect(plan.context.text).not.toContain('CI notification')
  })
})
