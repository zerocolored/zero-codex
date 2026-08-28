import { describe, expect, test } from 'bun:test'
import {
  decideChannelPolicy,
  canUseActiveThreadAuthority,
  isBotDMBlocked,
  selectNewReplies,
  slackTsToMs,
  msToSlackTs,
  threadPollCursor,
  advanceReadCursor,
  retreatReadCursor,
  planThreadPoll,
  planDirectMessageThreadPoll,
  planCatchupSweep,
  catchupThreadParents,
  pruneDeliveredKeys,
  classifyThreadReply,
  mentionsBot,
  resolveIsMention,
  decideThreadReplyDelivery,
  effectiveDmAllowFrom,
  isExplicitUpdateRequest,
  slackThreadKey,
  singleFlightAsync,
  validateLegacyThreadMap,
  roundRobinAfter,
  isInvalidSlackCursor,
  slackApiErrorCode,
  isTerminalSlackHistoryError,
  isTerminalSlackReplyScanError,
  slackReplyScanFailureDisposition,
  type ChannelPolicy,
  type SlackReply,
} from './gate.ts'

describe('durable round-robin scheduling', () => {
  test('channel budgetを超える30件も次周期で11件目から再開する', () => {
    const channels = Array.from({ length: 30 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`)
    const first = roundRobinAfter(channels, null).slice(0, 10)
    const second = roundRobinAfter(channels, first.at(-1)!).slice(0, 10)
    const third = roundRobinAfter(channels, second.at(-1)!).slice(0, 10)
    expect([...first, ...second, ...third]).toEqual(channels)
  })

  test('40-call replies budgetを超える55 threadも次周期で41件目から再開する', () => {
    const threads = Array.from({ length: 55 }, (_, index) => `thread-${String(index + 1).padStart(2, '0')}`)
    const first = roundRobinAfter(threads, null).slice(0, 40)
    const second = roundRobinAfter(threads, first.at(-1)!).slice(0, 40)
    expect(second.slice(0, 15)).toEqual(threads.slice(40))
    expect(second.at(15)).toBe(threads[0])
  })

  test('前回itemが削除済みなら現在の先頭から安全に再開する', () => {
    expect(roundRobinAfter(['C02', 'C03'], 'C01')).toEqual(['C02', 'C03'])
  })
})

describe('Slack cursor recovery', () => {
  test('Slack SDK PlatformErrorとplain errorのinvalid_cursorを識別する', () => {
    expect(isInvalidSlackCursor({ data: { ok: false, error: 'invalid_cursor' } })).toBe(true)
    expect(isInvalidSlackCursor({ code: 'invalid_cursor' })).toBe(true)
    expect(isInvalidSlackCursor(new Error('Slack API error: invalid_cursor'))).toBe(true)
    expect(isInvalidSlackCursor({ data: { error: 'channel_not_found' } })).toBe(false)
    expect(slackApiErrorCode({ data: { error: 'channel_not_found' } })).toBe('channel_not_found')
    expect(isTerminalSlackHistoryError({ data: { error: 'channel_not_found' } })).toBe(true)
    expect(isTerminalSlackHistoryError({ data: { error: 'not_in_channel' } })).toBe(false)
    expect(isTerminalSlackHistoryError(new Error('Slack: is_archived'))).toBe(false)

    expect(isTerminalSlackReplyScanError({ data: { error: 'thread_not_found' } })).toBe(true)
    expect(isTerminalSlackReplyScanError({ data: { error: 'channel_not_found' } })).toBe(true)
    expect(isTerminalSlackReplyScanError({ data: { error: 'not_in_channel' } })).toBe(false)
    expect(isTerminalSlackReplyScanError(new Error('Slack: is_archived'))).toBe(false)
    expect(isTerminalSlackReplyScanError({ data: { error: 'ratelimited' } })).toBe(false)
    expect(slackReplyScanFailureDisposition({ data: { error: 'not_in_channel' } })).toBe('defer')
    expect(slackReplyScanFailureDisposition({ data: { error: 'thread_not_found' } })).toBe('discard')
  })

  test('historyはopaque cursorでなくoldest timestampへ後退して再開する', () => {
    expect(retreatReadCursor([
      { ts: '300.000000' }, { ts: '250.000000' }, { ts: '275.000000' },
    ], '400.000000')).toBe('250.000000')
    expect(retreatReadCursor([], '400.000000')).toBe('400.000000')
  })
})

const HUMAN = 'U012ABCDE'
const BOT = 'B0123ABCD'
const OTHER_USER = 'U999ZZZZZ'
const OTHER_BOT = 'B999ZZZZZ'

const policy = (over: Partial<ChannelPolicy> = {}): ChannelPolicy => ({
  requireMention: false,
  allowFrom: [],
  ...over,
})

describe('validateLegacyThreadMap', () => {
  test('valid ownership rowを型付きで返す', () => {
    const input = {
      '1786325000.000001': {
        channel_id: 'C012ABCDE',
        repo_path: '/tmp/project',
        adopted_from_ts: '1786324999.000001',
        last_activity_ms: 1_786_325_000_000,
      },
    }
    expect(validateLegacyThreadMap(input)).toEqual({
      valid: [{ threadTs: '1786325000.000001', entry: input['1786325000.000001'] }],
      invalidKeys: [],
    })
  })

  test('valid JSONでもownership欠損や不正thread tsをmigration対象外として報告する', () => {
    const result = validateLegacyThreadMap({
      '1786325000.000001': {},
      invalid: { channel_id: 'C012ABCDE' },
      '1786325001.000001': null,
    })
    expect(result.valid).toEqual([])
    expect(result.invalidKeys).toEqual([
      '1786325000.000001',
      'invalid',
      '1786325001.000001',
    ])
    expect(validateLegacyThreadMap([]).invalidKeys).toEqual(['<root>'])
  })
})

describe('decideChannelPolicy — every human channel participant', () => {
  test('accepts a mentioned human even before the channel registry is persisted', () => {
    expect(decideChannelPolicy(undefined, HUMAN, true, false)).toBe('deliver')
  })

  test('delivers with empty allowFrom (default-allow humans)', () => {
    expect(decideChannelPolicy(policy(), HUMAN, true, false)).toBe('deliver')
  })

  test('delivers when human is on populated allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [HUMAN] }), HUMAN, true, false)).toBe('deliver')
  })

  test('legacy populated allowFrom no longer restricts humans', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [OTHER_USER] }), HUMAN, true, false)).toBe('deliver')
  })

  test('active thread authorityだけは別humanのallowlistとmentionを上書きする', () => {
    const restricted = policy({ requireMention: true, allowFrom: [OTHER_USER] })
    expect(decideChannelPolicy(restricted, HUMAN, false, false, true)).toBe('deliver')
    expect(decideChannelPolicy(undefined, HUMAN, false, false, true)).toBe('deliver')
    expect(decideChannelPolicy(restricted, BOT, false, true, true)).toBe('drop')
  })

  test('drops when requireMention=true and isMention=false (even if listed)', () => {
    expect(decideChannelPolicy(policy({ requireMention: true, allowFrom: [HUMAN] }), HUMAN, false, false)).toBe('drop')
  })

  test('delivers when requireMention=true and isMention=true', () => {
    expect(decideChannelPolicy(policy({ requireMention: true }), HUMAN, true, false)).toBe('deliver')
  })
})

describe('decideChannelPolicy — bots are always denied', () => {
  test('drops bot when channel has no policy', () => {
    expect(decideChannelPolicy(undefined, BOT, false, true)).toBe('drop')
  })

  test('drops bot with empty allowFrom (this is the headline behavior change)', () => {
    expect(decideChannelPolicy(policy(), BOT, false, true)).toBe('drop')
  })

  test('drops bot whose id is not on a populated allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [HUMAN, OTHER_BOT] }), BOT, false, true)).toBe('drop')
  })

  test('drops bot even when its id is explicitly listed in legacy allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [BOT] }), BOT, false, true)).toBe('drop')
  })

  test('drops bot listed alongside humans in legacy allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [HUMAN, BOT] }), BOT, false, true)).toBe('drop')
  })

  test('drops listed bot when requireMention=true and isMention=false', () => {
    expect(decideChannelPolicy(policy({ requireMention: true, allowFrom: [BOT] }), BOT, false, true)).toBe('drop')
  })

  test('drops listed bot even when requireMention=true and isMention=true', () => {
    expect(decideChannelPolicy(policy({ requireMention: true, allowFrom: [BOT] }), BOT, true, true)).toBe('drop')
  })

  test('a populated allowFrom containing only humans does not implicitly admit any bot', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [HUMAN] }), BOT, false, true)).toBe('drop')
  })

  test('legacy bot-only allowFrom cannot exclude a human participant', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [BOT] }), HUMAN, true, false)).toBe('deliver')
  })
})

describe('active Slack thread authority', () => {
  test('別humanはlive targetへsteerでき、exact中止だけsettle targetへ届く', () => {
    const base = {
      isBot: false,
      isDM: false,
      text: '方針を変えて',
      botUserId: 'U_ZERO',
      hasInterruptTarget: true,
      isInterrupt: false,
    }
    expect(canUseActiveThreadAuthority({ ...base, hasLiveTarget: true })).toBe(true)
    expect(canUseActiveThreadAuthority({ ...base, hasLiveTarget: false })).toBe(false)
    expect(canUseActiveThreadAuthority({
      ...base, text: '中止', hasLiveTarget: false, isInterrupt: true,
    })).toBe(true)
  })

  test('botと他人宛て返信はactive targetがあってもauthorityを得ない', () => {
    const base = {
      isDM: false,
      botUserId: 'U_ZERO',
      hasLiveTarget: true,
      hasInterruptTarget: true,
      isInterrupt: false,
    }
    expect(canUseActiveThreadAuthority({ ...base, isBot: true, text: '操作して' })).toBe(false)
    expect(canUseActiveThreadAuthority({
      ...base, isBot: false, text: '<@U0OTHER1> これはどう？',
    })).toBe(false)
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

test('poll cursor keyは同じthread_tsでもchannelごとに分離する', () => {
  expect(slackThreadKey('C-FIRST', '123.456')).not.toBe(
    slackThreadKey('C-SECOND', '123.456'),
  )
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

  test('drops every Slack bot history shape', () => {
    const replies = [
      reply({ ts: '1712345690.000000', bot_id: 'B123', user: undefined }),
      reply({ ts: '1712345691.000000', bot_profile: { id: 'B234' }, user: 'U0BOT234' }),
      reply({ ts: '1712345692.000000', subtype: 'bot_message', user: 'U0BOT345' }),
    ]
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

describe('classifyThreadReply — who is this reply talking to?', () => {
  const BOT_USER = 'U0B8JC02X7E'
  const ALICE = 'U06R9GU88RF'
  const BOB = 'U0A0DCGSJA0'

  // The three replies below are verbatim from the thread that exposed the bug:
  // the bot answered all of them, and the humans only wanted the first.
  test('bot mention → ours', () => {
    const text = `<@${BOT_USER}> このmdファイルのタスクないようをCSVフォーマットにして`
    expect(classifyThreadReply(text, BOT_USER)).toBe('bot')
  })

  test('addressed at two humans → not ours (the original complaint)', () => {
    const text = `<@${ALICE}> <@${BOB}> ゼロくんが作ってくれたCSVのチェックリストを共有します`
    expect(classifyThreadReply(text, BOT_USER)).toBe('others')
  })

  test('addressed at one human → not ours', () => {
    expect(classifyThreadReply(`<@${ALICE}> すいません下記の詳細をお願いしたいです！`, BOT_USER)).toBe('others')
  })

  // Un-mentioned follow-ups are how the humans actually drive the bot in an
  // owned thread — dropping these would break "いいね、マージして".
  test('no mention at all → ours (the owned thread is the address)', () => {
    expect(classifyThreadReply('いいね、マージして', BOT_USER)).toBe('none')
    expect(classifyThreadReply('', BOT_USER)).toBe('none')
  })

  test('bot mentioned alongside humans → ours (explicit beats company)', () => {
    expect(classifyThreadReply(`<@${ALICE}> <@${BOT_USER}> これ直して`, BOT_USER)).toBe('bot')
    expect(classifyThreadReply(`<@${BOT_USER}> <@${ALICE}> これ直して`, BOT_USER)).toBe('bot')
  })

  test('the bot display name in plain text is NOT a mention', () => {
    // Exactly why name-matching was rejected: this sentence is *about* the bot
    // while being addressed at humans.
    expect(classifyThreadReply(`<@${ALICE}> ゼロくんが作ってくれたCSV`, BOT_USER)).toBe('others')
    expect(classifyThreadReply('ゼロくん、これお願い', BOT_USER)).toBe('none')
  })

  test('broadcasts are a call to the humans, not to us', () => {
    for (const token of ['<!here>', '<!channel>', '<!everyone>', '<!subteam^S12345ABC>']) {
      expect(classifyThreadReply(`${token} 確認お願いします`, BOT_USER)).toBe('others')
    }
  })

  test('a broadcast that also names the bot is ours', () => {
    expect(classifyThreadReply(`<!here> <@${BOT_USER}> 頼む`, BOT_USER)).toBe('bot')
  })

  test('link-style mention tokens (<@U…|label>) are matched', () => {
    expect(classifyThreadReply(`<@${BOT_USER}|zerokun> 頼む`, BOT_USER)).toBe('bot')
    expect(classifyThreadReply(`<@${ALICE}|alice> よろしく`, BOT_USER)).toBe('others')
  })

  test('workspace-shared user ids (W-prefix) count as human mentions', () => {
    expect(classifyThreadReply('<@W012345AB> よろしく', BOT_USER)).toBe('others')
  })

  test('an unresolved botUserId cannot mute a plain reply', () => {
    // Only reachable if auth.test has not returned yet. A reply with no mention
    // still gets through; one naming us degrades to 'others' because we cannot
    // recognise our own id — acceptable because pollThreads only runs after
    // botUserId is assigned (server.ts start-up order).
    expect(classifyThreadReply('マージして', undefined)).toBe('none')
    expect(classifyThreadReply(`<@${BOT_USER}> 頼む`, undefined)).toBe('others')
  })

  test('a channel link is not a mention', () => {
    expect(classifyThreadReply('<#C0B69UHBP7Y|dev> に貼っておいた', BOT_USER)).toBe('none')
  })

  test('labelled broadcast tokens (the common form) still count', () => {
    expect(classifyThreadReply('<!here|@here> 確認お願いします', BOT_USER)).toBe('others')
    expect(classifyThreadReply('<!subteam^S06ABC1DEF|@dev-team> 見てください', BOT_USER)).toBe('others')
  })

  test('escaped mention text is inert (Slack escapes < and > it did not author)', () => {
    expect(classifyThreadReply('&lt;@U06R9GU88RF&gt; と書いた', BOT_USER)).toBe('none')
  })

  test('a bot-id token is not a user mention', () => {
    expect(classifyThreadReply('<@B012345AB> が投稿した', BOT_USER)).toBe('none')
  })

  test('an id that merely starts with ours is somebody else', () => {
    expect(classifyThreadReply('<@U0B8JC02X7EXTRA> よろしく', BOT_USER)).toBe('others')
  })

  // Quoting a colleague and then instructing us is the everyday Slack idiom;
  // reading the citation as the address would swallow the instruction.
  test('a mention inside a quote is a citation, not an address', () => {
    expect(classifyThreadReply(`&gt; <@${ALICE}> さんの案\nいいね、マージして`, BOT_USER)).toBe('none')
    expect(classifyThreadReply(`> <@${ALICE}> さんの案\nいいね、マージして`, BOT_USER)).toBe('none')
  })

  test('a mention inside code is a citation, not an address', () => {
    expect(classifyThreadReply(`\`<@${ALICE}>\` の話だけど直して`, BOT_USER)).toBe('none')
    expect(classifyThreadReply('```\n<@U06R9GU88RF> hi\n```\nこれ直して', BOT_USER)).toBe('none')
  })

  test('naming us survives quoting that swallows the token', () => {
    // Quote detection must not be able to eat our own name when nobody else is
    // addressed: a stray backtick shifts every span and the message would
    // vanish in silence.
    expect(classifyThreadReply(`\`\`\`\n<@${BOT_USER}> これ実行して`, BOT_USER)).toBe('bot')
    expect(classifyThreadReply(`&gt; 昨日の\n\`<@${BOT_USER}>\` やっといて`, BOT_USER)).toBe('bot')
  })

  test('an unclosed fence quotes to the end, the way Slack renders it', () => {
    // Otherwise the tail reads as ordinary prose and the mention inside it
    // looks like a plain address, outranking the human named above.
    const text = `<@${ALICE}> 確認して\n\`\`\`\n<@${BOT_USER}> デプロイして`
    expect(classifyThreadReply(text, BOT_USER)).toBe('others')
  })

  test('but a quoted mention of us never outranks a human addressed in the open', () => {
    // Quoting an old request to us while asking a colleague about it is the
    // exact interruption this whole change exists to stop.
    const text = `<@${ALICE}> 昨日の件です\n&gt; <@${BOT_USER}> デプロイして\nこれ確認お願いします`
    expect(classifyThreadReply(text, BOT_USER)).toBe('others')
  })

  test('quoting does not smuggle a real address past the filter', () => {
    // The quote is stripped, but the live line still addresses a human.
    expect(classifyThreadReply(`&gt; 参考\n<@${ALICE}> お願いします`, BOT_USER)).toBe('others')
  })
})

describe('decideThreadReplyDelivery — the poller wiring', () => {
  const BOT_USER = 'U0B8JC02X7E'
  const ALICE = 'U06R9GU88RF'
  const reply = (over: Partial<SlackReply> = {}): SlackReply => ({
    ts: '1786325691.248419',
    user: HUMAN,
    text: 'やっといて',
    ...over,
  })
  const open = policy({ requireMention: true, allowFrom: [HUMAN] })

  test('delivers a reply that names the bot', () => {
    expect(decideThreadReplyDelivery(open, reply({ text: `<@${BOT_USER}> 頼む` }), BOT_USER)).toBe('deliver')
  })

  test('delivers a reply that names nobody (owned thread = the address)', () => {
    expect(decideThreadReplyDelivery(open, reply({ text: 'いいね、マージして' }), BOT_USER)).toBe('deliver')
  })

  test('drops a reply addressed at a human — the whole point of this change', () => {
    expect(decideThreadReplyDelivery(open, reply({ text: `<@${ALICE}> お願いします` }), BOT_USER)).toBe('drop-others')
  })

  test('legacy allowlist does not exclude a human reply', () => {
    const closed = policy({ requireMention: true, allowFrom: [OTHER_USER] })
    expect(decideThreadReplyDelivery(closed, reply(), BOT_USER)).toBe('deliver')
  })

  test('missing registry defaults to the mention/noise rule for an owned thread', () => {
    expect(decideThreadReplyDelivery(undefined, reply(), BOT_USER)).toBe('deliver')
    expect(decideThreadReplyDelivery(undefined, reply({ text: `<@${ALICE}> hi` }), BOT_USER))
      .toBe('drop-others')
  })

  test('an attachment with no text is ours', () => {
    expect(decideThreadReplyDelivery(open, reply({ text: undefined, files: [{ id: 'F1' }] }), BOT_USER)).toBe('deliver')
  })

  test('a requireMention:false channel keeps reading everything', () => {
    // It opted into the firehose, and the live path honours that. Filtering
    // only here would make the same message land or not depending on which
    // path happened to see it first.
    const firehose = policy({ requireMention: false, allowFrom: [HUMAN] })
    expect(decideThreadReplyDelivery(firehose, reply({ text: `<@${ALICE}> お願いします` }), BOT_USER)).toBe('deliver')
  })
})

describe('advanceReadCursor — read position vs delivery position', () => {
  const reply = (ts: string, over: Partial<SlackReply> = {}): SlackReply => ({ ts, user: HUMAN, text: 'hi', ...over })

  test('a page of nothing but the bot’s own posts still advances the cursor', () => {
    // The stall this guards: delivery skips these, so advancing only past
    // delivered replies pins the cursor and buries every human reply behind
    // this page forever.
    const replies = [
      reply('1786400010.000000', { user: 'U0BOT00000' }),
      reply('1786400020.000000', { user: 'U0BOT00000' }),
      reply('1786400030.000000', { subtype: 'channel_join' }),
    ]
    expect(advanceReadCursor(replies, '1786400000.000000')).toBe('1786400030.000000')
  })

  test('skipped “addressed to others” replies advance it too', () => {
    const replies = [reply('1786400050.000000', { text: '<@U06R9GU88RF> お願い' })]
    expect(advanceReadCursor(replies, '1786400000.000000')).toBe('1786400050.000000')
  })

  test('never moves backwards, and holds still on an empty page', () => {
    expect(advanceReadCursor([], '1786400000.000000')).toBe('1786400000.000000')
    expect(advanceReadCursor([reply('1786399000.000000')], '1786400000.000000')).toBe('1786400000.000000')
  })

  test('takes the newest ts regardless of page order', () => {
    const replies = [reply('1786400030.000000'), reply('1786400010.000000'), reply('1786400020.000000')]
    expect(advanceReadCursor(replies, '1786400000.000000')).toBe('1786400030.000000')
  })
})

describe('mentionsBot — live channel path', () => {
  const BOT_USER = 'U0B8JC02X7E'

  test('true only for the bot’s own token', () => {
    expect(mentionsBot(`<@${BOT_USER}> hi`, BOT_USER)).toBe(true)
    expect(mentionsBot(`<@${BOT_USER}|zerokun> hi`, BOT_USER)).toBe(true)
    expect(mentionsBot('<@U06R9GU88RF> hi', BOT_USER)).toBe(false)
    expect(mentionsBot('ゼロくん hi', BOT_USER)).toBe(false)
    expect(mentionsBot('', BOT_USER)).toBe(false)
  })

  test('false when the bot id is unknown', () => {
    expect(mentionsBot(`<@${BOT_USER}> hi`, undefined)).toBe(false)
  })

  test('a prefix-colliding id is not a match', () => {
    expect(mentionsBot('<@U0B8JC02X7EXTRA> hi', BOT_USER)).toBe(false)
  })
})

describe('resolveIsMention — the live-handler wiring', () => {
  const BOT_USER = 'U0B8JC02X7E'

  test('a DM is self-addressed', () => {
    expect(resolveIsMention(true, 'マージして', BOT_USER)).toBe(true)
  })

  test('a channel post must actually name us', () => {
    // Regression guard: this used to be a flat `!isDM`, which made
    // requireMention dead config on every channel message.
    expect(resolveIsMention(false, 'マージして', BOT_USER)).toBe(false)
    expect(resolveIsMention(false, '<@U06R9GU88RF> お願いします', BOT_USER)).toBe(false)
    expect(resolveIsMention(false, `<@${BOT_USER}> お願いします`, BOT_USER)).toBe(true)
  })
})

describe('isExplicitUpdateRequest — privileged detached route', () => {
  test('短い命令形だけを自己更新として扱う', () => {
    expect(isExplicitUpdateRequest('ゼロくんを最新版に更新してください。')).toBe(true)
    expect(isExplicitUpdateRequest('Zeroちゃんを更新してください。')).toBe(true)
    expect(isExplicitUpdateRequest('ゼロちゃんのアップデートお願いします')).toBe(true)
    expect(isExplicitUpdateRequest('ゼロくんのアップデートお願いします')).toBe(true)
    expect(isExplicitUpdateRequest('please update zero-kun now')).toBe(true)
    expect(isExplicitUpdateRequest('zerokun update')).toBe(true)
    expect(isExplicitUpdateRequest('<@U0123456789> ゼロくんを更新してください')).toBe(true)
  })

  test('質問・説明・否定は通常jobに残す', () => {
    expect(isExplicitUpdateRequest('ゼロくんの更新方法を教えて')).toBe(false)
    expect(isExplicitUpdateRequest('ゼロくんを更新できますか？')).toBe(false)
    expect(isExplicitUpdateRequest('ゼロくんを更新しないで')).toBe(false)
    expect(isExplicitUpdateRequest('update zero-kun の仕組み')).toBe(false)
  })
})

describe('planCatchupSweep — startup recovery', () => {
  test('一時失敗後の定期catch-upを再実行し、同時実行は重ねない', async () => {
    let calls = 0
    let successes = 0
    const run = singleFlightAsync(async () => {
      calls += 1
      if (calls <= 2) throw new Error('temporary Slack failure')
      successes += 1
    })
    await Promise.all([run(), run()])
    await run()
    await run()
    expect(calls).toBe(3)
    expect(successes).toBe(1)
  })

  const BOT_USER = 'U0B8JC02X7E'
  const NOW = 1_786_400_000_000
  const ts = (offsetMs: number) => ((NOW + offsetMs) / 1000).toFixed(6)
  const message = (offsetMs: number, over: Partial<SlackReply> = {}): SlackReply => ({
    ts: ts(offsetMs),
    user: HUMAN,
    text: `<@${BOT_USER}> お願い`,
    ...over,
  })

  test('履歴parentの窓内replyを展開対象にし、古いthread replyはAPI取得前に除外する', () => {
    expect(catchupThreadParents([
      message(-50_000, { reply_count: 2, latest_reply: ts(-5_000) }),
      message(-86_400_000, { reply_count: 1, latest_reply: ts(-1_000) }),
      message(-40_000, { reply_count: 1, latest_reply: ts(-70_000) }),
      message(-30_000, { reply_count: 0 }),
    ], NOW - 60_000)).toEqual([ts(-50_000), ts(-86_400_000)])
  })

  test('channelはメンション済み・未配送・窓内の人間メッセージだけを古い順に返す', () => {
    const history = [
      message(-50_000),
      message(-40_000, { text: 'メンションなし' }),
      message(-30_000),
      message(-20_000),
      message(-10_000, { user: BOT_USER }),
      message(-5_000, { subtype: 'message_changed' }),
      message(-70_000),
    ]
    const delivered = new Set([`C123:${ts(-30_000)}`])

    const plan = planCatchupSweep(history, delivered, {
      channelId: 'C123',
      channelType: 'channel',
      channelPolicy: policy({ requireMention: true }),
      oldestMs: NOW - 60_000,
      limit: 20,
    }, BOT_USER)

    expect(plan.map(item => item.ts)).toEqual([ts(-50_000), ts(-20_000)])
  })

  test('DMはメンション不要だがbot DMは除外する', () => {
    const plan = planCatchupSweep([
      message(-20_000, { text: '止まっている間のDM' }),
      message(-10_000, { user: undefined, bot_id: OTHER_BOT, text: 'bot DM' }),
      message(-9_000, { user: 'U0BOT234', bot_profile: { id: 'B234' }, text: 'profile bot DM' }),
      message(-8_000, { user: 'U0BOT345', subtype: 'bot_message', text: 'legacy bot DM' }),
    ], [], {
      channelId: 'D123',
      channelType: 'im',
      oldestMs: NOW - 60_000,
      limit: 20,
    }, BOT_USER)

    expect(plan.map(item => item.text)).toEqual(['止まっている間のDM'])
  })

  test('channel allowlist外humanのchild replyもruntime active-thread gate用に残す', () => {
    const child = message(-15_000, {
      user: OTHER_USER,
      text: 'active threadへの追記',
      thread_ts: ts(-50_000),
    })
    const plan = planCatchupSweep([child], [], {
      channelId: 'C123',
      channelType: 'channel',
      channelPolicy: policy({ requireMention: true, allowFrom: [HUMAN] }),
      oldestMs: NOW - 60_000,
      limit: 20,
    }, BOT_USER)
    expect(plan).toEqual([child])
  })

  test('上限超過時は最新分を選び、その中を古い順に返す', () => {
    const history = [message(-40_000), message(-10_000), message(-30_000), message(-20_000)]
    const plan = planCatchupSweep(history, [], {
      channelId: 'C123',
      channelType: 'channel',
      channelPolicy: policy({ requireMention: true }),
      oldestMs: NOW - 60_000,
      limit: 2,
    }, BOT_USER)

    expect(plan.map(item => item.ts)).toEqual([ts(-20_000), ts(-10_000)])
  })

  test('durable ledgerで既処理を除外すればlimitを消費せず全件が有限回で進む', () => {
    const history = Array.from({ length: 1_001 }, (_, index) => message(-1_001_000 + index * 1_000))
    const handled = new Set<string>()
    let rounds = 0
    while (handled.size < history.length && rounds < 60) {
      const plan = planCatchupSweep(history, handled, {
        channelId: 'C123', channelType: 'channel',
        channelPolicy: policy({ requireMention: true }),
        oldestMs: NOW - 2_000_000,
        limit: 20,
      }, BOT_USER)
      for (const item of plan) handled.add(`C123:${item.ts}`)
      rounds += 1
    }
    expect(handled.size).toBe(1_001)
    expect(rounds).toBe(51)
  })
})

describe('threadPollCursor — where the poller resumes', () => {
  const THREAD = '1786011979.655819'

  test('a never-polled thread starts where the dispatcher last handled a message', () => {
    // Not at the thread root: adopting an old thread must not replay its
    // whole human backlog.
    expect(threadPollCursor(undefined, '1786325691.248419', 1786325779155, THREAD))
      .toBe('1786325691.248419')
  })

  test('a never-polled thread with nothing to go on starts at the thread root', () => {
    expect(threadPollCursor(undefined, undefined, 0, THREAD)).toBe(THREAD)
    expect(threadPollCursor(undefined, undefined, undefined, THREAD)).toBe(THREAD)
  })

  test('a thread not yet polled reads from where it was adopted, not from later traffic', () => {
    // The adoption mark is fixed. If it crept forward with each dispatch it
    // would be a floor again for as long as the first sweep has not landed:
    // adopt at …020, "これ見て" at …030, "@ゼロくん やって" at …040 — a moving
    // mark would start at …040 and the message with the content in it dies.
    expect(threadPollCursor(undefined, '1786400020.000000', 1786400045000, THREAD))
      .toBe('1786400020.000000')
  })

  test('nothing the dispatcher records may drag the read position forward', () => {
    // The drop this guards, in both of its shapes. A bare reply lands at …010
    // and, before the next poll, a mention at …020 is dispatched live. Letting
    // either the handled ts (…020) or the wall clock (…100) act as a floor
    // steps over …010 and buries it — "これ見て" then "@ゼロくん やって" is an
    // ordinary way to type, not an edge case. Redelivering …020 is harmless:
    // dedup catches it.
    expect(threadPollCursor('1786400000.000000', '1786400020.000000', 1786400100000, THREAD))
      .toBe('1786400000.000000')
    expect(threadPollCursor('1786400000.000000', undefined, 1786400100000, THREAD))
      .toBe('1786400000.000000')
  })

  test('an out-of-order or stale dispatcher mark costs nothing', () => {
    expect(threadPollCursor('1786400200.000000', '1786400020.000000', 1786400100000, THREAD))
      .toBe('1786400200.000000')
  })

  test('a never-polled legacy entry still starts at the wall clock', () => {
    expect(threadPollCursor(undefined, undefined, 1786400100000, THREAD))
      .toBe('1786400100.000000')
  })
})

describe('pruneDeliveredKeys — bounding what we remember having delivered', () => {
  const keys = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `C1:${from + i}`)

  test('keeps everything until the limit is passed', () => {
    expect(pruneDeliveredKeys(keys(10), 10)).toEqual(keys(10))
  })

  test('drops the oldest half, keeping insertion order', () => {
    expect(pruneDeliveredKeys(keys(11), 10)).toEqual(keys(5, 6))
  })

  test('keeps the NEWEST keys — forgetting those would redeliver what just arrived', () => {
    const pruned = pruneDeliveredKeys(keys(1001), 1000)
    expect(pruned).toHaveLength(500)
    expect(pruned.at(-1)).toBe('C1:1000')
  })

  test('accepts a Set, which is what the caller actually holds', () => {
    expect(pruneDeliveredKeys(new Set(keys(4)), 10)).toEqual(keys(4))
  })
})

describe('planThreadPoll — one page of a thread, end to end', () => {
  const BOT_USER = 'U0B8JC02X7E'
  const ALICE = 'U06R9GU88RF'
  const CURSOR = '1786325000.000000'
  const open = policy({ requireMention: true, allowFrom: [HUMAN] })
  const reply = (ts: string, over: Partial<SlackReply> = {}): SlackReply => ({ ts, user: HUMAN, text: 'hi', ...over })

  test('routes a mixed page: bot-addressed and bare delivered, human-addressed skipped', () => {
    const replies = [
      reply('1786325100.000000', { text: `<@${ALICE}> <@U0A0DCGSJA0> 共有します` }),
      reply('1786325200.000000', { text: `<@${BOT_USER}> これやって` }),
      reply('1786325300.000000', { text: 'いいね、マージして' }),
      reply('1786325400.000000', { user: BOT_USER, text: '対応しました' }),
    ]
    const plan = planThreadPoll(replies, CURSOR, open, BOT_USER)
    expect(plan.deliver.map((r) => r.ts)).toEqual(['1786325200.000000', '1786325300.000000'])
    expect(plan.skipped).toEqual([{ reply: replies[0]!, reason: 'others' }])
    expect(plan.cursor).toBe('1786325400.000000')
  })

  test('a page of nothing deliverable still moves the read cursor', () => {
    const replies = [
      reply('1786325100.000000', { user: BOT_USER }),
      reply('1786325200.000000', { text: `<@${ALICE}> お願い` }),
    ]
    const plan = planThreadPoll(replies, CURSOR, open, BOT_USER)
    expect(plan.deliver).toEqual([])
    expect(plan.cursor).toBe('1786325200.000000')
  })

  test('replies at or before the cursor are neither delivered nor re-reported', () => {
    const plan = planThreadPoll([reply(CURSOR), reply('1786324000.000000')], CURSOR, open, BOT_USER)
    expect(plan.deliver).toEqual([])
    expect(plan.skipped).toEqual([])
    expect(plan.cursor).toBe(CURSOR)
  })

  test('legacy allowlist cannot exclude a human participant', () => {
    const closed = policy({ requireMention: true, allowFrom: [OTHER_USER] })
    const plan = planThreadPoll([reply('1786325100.000000')], CURSOR, closed, BOT_USER)
    expect(plan.deliver).toHaveLength(1)
    expect(plan.skipped).toEqual([])
    expect(plan.cursor).toBe('1786325100.000000')
  })

  test('an empty page changes nothing', () => {
    expect(planThreadPoll([], CURSOR, open, BOT_USER)).toEqual({ cursor: CURSOR, deliver: [], skipped: [] })
  })
})

describe('planDirectMessageThreadPoll — DM follow-up recovery', () => {
  const CURSOR = '1786325000.000000'
  const BOT_USER = 'U0B8JC02X7E'

  test('authorized human replies are delivered without a channel policy', () => {
    const reply = { ts: '1786325100.000000', user: HUMAN, text: '続けて' }
    const plan = planDirectMessageThreadPoll([reply], CURSOR, [HUMAN], BOT_USER)
    expect(plan.deliver).toEqual([reply])
    expect(plan.skipped).toEqual([])
  })

  test('revoked senders are skipped while the read cursor still advances', () => {
    const reply = { ts: '1786325100.000000', user: HUMAN, text: '続けて' }
    const plan = planDirectMessageThreadPoll([reply], CURSOR, [], BOT_USER)
    expect(plan.deliver).toEqual([])
    expect(plan.skipped).toEqual([{ reply, reason: 'policy' }])
    expect(plan.cursor).toBe(reply.ts)
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

describe('effectiveDmAllowFrom — DM permission is independent from channels', () => {
  test('empty access yields nobody', () => {
    expect(effectiveDmAllowFrom({})).toEqual([])
    expect(effectiveDmAllowFrom({ allowFrom: [], channels: {} })).toEqual([])
  })

  test('keeps the global list when there are no channels', () => {
    expect(effectiveDmAllowFrom({ allowFrom: [HUMAN], channels: {} })).toEqual([HUMAN])
  })

  test('legacy channel membership does not grant DM at runtime', () => {
    const access = { allowFrom: [], channels: { C1: policy({ allowFrom: [OTHER_USER] }) } }
    expect(effectiveDmAllowFrom(access)).toEqual([])
  })

  test('ignores every legacy channel list and keeps only the global list', () => {
    const access = {
      allowFrom: [HUMAN],
      channels: {
        C1: policy({ allowFrom: [OTHER_USER, HUMAN] }),
        C2: policy({ allowFrom: ['U333THIRD'] }),
      },
    }
    expect(effectiveDmAllowFrom(access)).toEqual([HUMAN])
  })

  test('an open channel (empty allowFrom) grants DM access to nobody', () => {
    const access = { allowFrom: [], channels: { C1: policy({ allowFrom: [] }) } }
    expect(effectiveDmAllowFrom(access)).toEqual([])
  })

  test('bot ids opted into a channel never reach the DM list', () => {
    const access = { allowFrom: [], channels: { C1: policy({ allowFrom: [BOT, OTHER_BOT, HUMAN] }) } }
    expect(effectiveDmAllowFrom(access)).toEqual([])
  })

  test('a bot id sitting in the global list is ignored too', () => {
    expect(effectiveDmAllowFrom({ allowFrom: [BOT, HUMAN], channels: {} })).toEqual([HUMAN])
  })

  test('accepts Enterprise Grid "W…" user ids', () => {
    expect(effectiveDmAllowFrom({ allowFrom: ['W012ABCDE'], channels: {} })).toEqual(['W012ABCDE'])
  })

  test('tolerates missing/undefined channel policies', () => {
    const access = { allowFrom: [HUMAN], channels: { C1: undefined } }
    expect(effectiveDmAllowFrom(access)).toEqual([HUMAN])
  })
})
