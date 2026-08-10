import { describe, expect, test } from 'bun:test'
import {
  decideChannelPolicy,
  isBotDMBlocked,
  selectNewReplies,
  slackTsToMs,
  msToSlackTs,
  threadPollCursor,
  advanceReadCursor,
  planThreadPoll,
  pruneDeliveredKeys,
  classifyThreadReply,
  mentionsBot,
  resolveIsMention,
  decideThreadReplyDelivery,
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

  test('the allowlist still wins, and reports itself as the reason', () => {
    const closed = policy({ requireMention: true, allowFrom: [OTHER_USER] })
    expect(decideThreadReplyDelivery(closed, reply(), BOT_USER)).toBe('drop-policy')
    // Unknown channel (e.g. a DM thread in threads.json) — policy, not noise.
    expect(decideThreadReplyDelivery(undefined, reply({ text: `<@${ALICE}> hi` }), BOT_USER)).toBe('drop-policy')
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

  test('a sender off the allowlist is reported as policy, not as noise', () => {
    const closed = policy({ requireMention: true, allowFrom: [OTHER_USER] })
    const plan = planThreadPoll([reply('1786325100.000000')], CURSOR, closed, BOT_USER)
    expect(plan.skipped.map((s) => s.reason)).toEqual(['policy'])
    expect(plan.cursor).toBe('1786325100.000000')
  })

  test('an empty page changes nothing', () => {
    expect(planThreadPoll([], CURSOR, open, BOT_USER)).toEqual({ cursor: CURSOR, deliver: [], skipped: [] })
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
