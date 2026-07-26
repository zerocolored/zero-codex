import { describe, expect, test } from 'bun:test'
import {
  decideChannelPolicy,
  isBotDMBlocked,
  selectNewReplies,
  slackTsToMs,
  msToSlackTs,
  type ChannelPolicy,
  type SlackReply,
} from './gate.ts'

const HUMAN = 'U012ABCDE'
const BOT = 'B0123ABCD'
const OTHER_USER = 'U999ZZZZZ'
const OTHER_BOT = 'B999ZZZZZ'

const policy = (over: Partial<ChannelPolicy> = {}): ChannelPolicy => ({
  requireMention: false,
  allowFrom: [],
  ...over,
})

describe('decideChannelPolicy — humans (default-allow)', () => {
  test('drops when channel has no policy at all', () => {
    expect(decideChannelPolicy(undefined, HUMAN, true, false)).toBe('drop')
  })

  test('delivers with empty allowFrom (default-allow humans)', () => {
    expect(decideChannelPolicy(policy(), HUMAN, true, false)).toBe('deliver')
  })

  test('delivers when human is on populated allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [HUMAN] }), HUMAN, true, false)).toBe('deliver')
  })

  test('drops human not on a populated allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [OTHER_USER] }), HUMAN, true, false)).toBe('drop')
  })

  test('drops when requireMention=true and isMention=false (even if listed)', () => {
    expect(decideChannelPolicy(policy({ requireMention: true, allowFrom: [HUMAN] }), HUMAN, false, false)).toBe('drop')
  })

  test('delivers when requireMention=true and isMention=true', () => {
    expect(decideChannelPolicy(policy({ requireMention: true }), HUMAN, true, false)).toBe('deliver')
  })
})

describe('decideChannelPolicy — bots (default-deny)', () => {
  test('drops bot when channel has no policy', () => {
    expect(decideChannelPolicy(undefined, BOT, false, true)).toBe('drop')
  })

  test('drops bot with empty allowFrom (this is the headline behavior change)', () => {
    expect(decideChannelPolicy(policy(), BOT, false, true)).toBe('drop')
  })

  test('drops bot whose id is not on a populated allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [HUMAN, OTHER_BOT] }), BOT, false, true)).toBe('drop')
  })

  test('delivers bot when its id is explicitly listed in allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [BOT] }), BOT, false, true)).toBe('deliver')
  })

  test('delivers bot listed alongside humans in allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [HUMAN, BOT] }), BOT, false, true)).toBe('deliver')
  })

  test('drops listed bot when requireMention=true and isMention=false', () => {
    expect(decideChannelPolicy(policy({ requireMention: true, allowFrom: [BOT] }), BOT, false, true)).toBe('drop')
  })

  test('delivers listed bot when requireMention=true and isMention=true', () => {
    expect(decideChannelPolicy(policy({ requireMention: true, allowFrom: [BOT] }), BOT, true, true)).toBe('deliver')
  })

  test('a populated allowFrom containing only humans does not implicitly admit any bot', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [HUMAN] }), BOT, false, true)).toBe('drop')
  })

  test('drops humans not on a populated allowFrom even when the list contains only bot ids', () => {
    // A populated allowFrom narrows humans to its listed ids — regardless of
    // whether those ids are users or bots. Consequence: if you opt a bot in
    // via allowFrom, you must also list every human you want to keep able to
    // trigger Claude in that channel. (Same rule as upstream's pre-patch
    // human allowlist; surfaced here because the bot path makes it new.)
    expect(decideChannelPolicy(policy({ allowFrom: [BOT] }), HUMAN, true, false)).toBe('drop')
  })
})

describe('slackTs <-> ms conversion', () => {
  test('slackTsToMs parses seconds.micros to ms', () => {
    expect(slackTsToMs('1712345678.000200')).toBe(1712345678000)
    expect(slackTsToMs('1712345678.500000')).toBe(1712345678500)
  })

  test('msToSlackTs round-trips through slackTsToMs at ms precision', () => {
    const ms = 1712345678500
    expect(slackTsToMs(msToSlackTs(ms))).toBe(ms)
  })
})

describe('selectNewReplies — thread catch-up poller', () => {
  const BOT_USER = 'U0BOT00000'
  const reply = (over: Partial<SlackReply> = {}): SlackReply => ({
    ts: '1712345678.000100',
    user: HUMAN,
    text: 'hi',
    ...over,
  })

  test('keeps only replies strictly newer than the cursor', () => {
    const replies = [
      reply({ ts: '1712345670.000000' }), // older — drop
      reply({ ts: '1712345680.000000' }), // == cursor — drop (already delivered)
      reply({ ts: '1712345690.000000' }), // newer — keep
    ]
    const out = selectNewReplies(replies, '1712345680.000000', BOT_USER)
    expect(out.map((r) => r.ts)).toEqual(['1712345690.000000'])
  })

  test("drops the bot's own replies", () => {
    const replies = [
      reply({ ts: '1712345690.000000', user: BOT_USER }),
      reply({ ts: '1712345691.000000', user: HUMAN }),
    ]
    const out = selectNewReplies(replies, '1712345680.000000', BOT_USER)
    expect(out.map((r) => r.user)).toEqual([HUMAN])
  })

  test('drops other bots (handled by the live app_mention path, not the poller)', () => {
    const replies = [reply({ ts: '1712345690.000000', bot_id: 'B123', user: undefined })]
    expect(selectNewReplies(replies, '1712345680.000000', BOT_USER)).toEqual([])
  })

  test('drops system subtypes but keeps file_share', () => {
    const replies = [
      reply({ ts: '1712345690.000000', subtype: 'channel_join' }),
      reply({ ts: '1712345691.000000', subtype: 'message_changed' }),
      reply({ ts: '1712345692.000000', subtype: 'file_share', files: [{ id: 'F1' }] }),
    ]
    const out = selectNewReplies(replies, '1712345680.000000', BOT_USER)
    expect(out.map((r) => r.ts)).toEqual(['1712345692.000000'])
  })

  test('drops replies with no user', () => {
    const replies = [reply({ ts: '1712345690.000000', user: undefined })]
    expect(selectNewReplies(replies, '1712345680.000000', BOT_USER)).toEqual([])
  })

  test('returns results oldest-first even if input is unordered', () => {
    const replies = [
      reply({ ts: '1712345693.000000' }),
      reply({ ts: '1712345691.000000' }),
      reply({ ts: '1712345692.000000' }),
    ]
    const out = selectNewReplies(replies, '1712345680.000000', BOT_USER)
    expect(out.map((r) => r.ts)).toEqual([
      '1712345691.000000',
      '1712345692.000000',
      '1712345693.000000',
    ])
  })

  test('undefined botUserId keeps human replies (no accidental drop)', () => {
    const out = selectNewReplies([reply({ ts: '1712345690.000000' })], '1712345680.000000', undefined)
    expect(out).toHaveLength(1)
  })
})

describe('isBotDMBlocked', () => {
  test('blocks bot DMs', () => {
    expect(isBotDMBlocked('im', true)).toBe(true)
  })

  test('does not block bot channel posts', () => {
    expect(isBotDMBlocked('channel', true)).toBe(false)
  })

  test('does not block human DMs', () => {
    expect(isBotDMBlocked('im', false)).toBe(false)
  })

  test('does not block human channel posts', () => {
    expect(isBotDMBlocked('channel', false)).toBe(false)
  })
})
