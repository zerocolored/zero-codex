import { describe, expect, test } from 'bun:test'
import {
  commandOwnedByState,
  observeProcessGeneration,
  processGroupSignalAllowed,
  processStartKey,
  readBootSession,
  readProcessIdentity,
  resetBootSessionCacheForTests,
  sameProcessGeneration,
} from './process-generation.ts'

describe('Darwin process generation', () => {
  test('boot-session probeの一時失敗はcacheせず次回成功を採用する', () => {
    resetBootSessionCacheForTests()
    let attempts = 0
    const expected = '11111111-1111-4111-8111-111111111111'
    const probe = () => (++attempts === 1 ? undefined : expected)
    expect(readBootSession(probe)).toBeUndefined()
    expect(readBootSession(probe)).toBe(expected)
    expect(readBootSession(() => '22222222-2222-4222-8222-222222222222')).toBe(expected)
    expect(attempts).toBe(2)
    resetBootSessionCacheForTests()
  })

  test('同じ秒でもmicrosecondが違えば別generationとして扱う', () => {
    const base = {
      pid: 42,
      bootSession: '11111111-1111-4111-8111-111111111111',
      startSec: 1_800_000_000,
      startUsec: 123,
    }
    expect(sameProcessGeneration(base, { ...base, startUsec: 124 })).toBe(false)
    expect(processStartKey(base)).not.toBe(processStartKey({ ...base, startUsec: 124 }))
  })

  test('TERM後にleader generationが変わればnegative PGID KILLを許可しない', () => {
    const expected = {
      pid: 42,
      ppid: 1,
      pgid: 42,
      status: 2,
      bootSession: '11111111-1111-4111-8111-111111111111',
      startSec: 1_800_000_000,
      startUsec: 123,
      started: '11111111-1111-4111-8111-111111111111:1800000000:000123',
    }
    expect(processGroupSignalAllowed(expected, expected)).toBe(true)
    expect(processGroupSignalAllowed(expected, { ...expected, startUsec: 124 })).toBe(false)
    expect(processGroupSignalAllowed(expected, { ...expected, pgid: 99 })).toBe(false)
    expect(processGroupSignalAllowed(expected, undefined)).toBe(false)
  })

  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'live PIDのgenerationを安定して取得する', () => {
    const first = readProcessIdentity(process.pid)
    const second = readProcessIdentity(process.pid)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(sameProcessGeneration(first!, second!)).toBe(true)
    expect(first!.pgid).toBeGreaterThan(1)
    expect(observeProcessGeneration(first!).status).toBe('alive')
    },
  )

  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    '存在しないPIDはmissingでありunknownへ丸めない', () => {
    const current = readProcessIdentity(process.pid)!
    expect(observeProcessGeneration({ ...current, pid: 2_147_483_647 })).toEqual({
      status: 'dead',
      reason: 'missing',
    })
    },
  )

  // 2026-09-14: cutoverがcommandの「形」だけで停止対象を選んでいたため、
  // 偽HOMEで走らせたテストが実HOMEで稼働中の本番bridgeを巻き込んで停止させた。
  // 形は所有権ではない、という契約をここで固定する。
  test('commandの形だけでは所有権にならない: 別stateのClaude bridgeは対象外', () => {
    const production = [
      'claude --model opus --effort max --dangerously-skip-permissions',
      '--mcp-config /Users/example/.claude/channels/slack/mcp.slack-channel.json',
      '--settings /Users/example/.claude/channels/slack/bot-settings.json',
      '--append-system-prompt-file'
        + ' /Users/example/.claude/channels/slack/zerokun-heavy-mode.generated.md',
      '--dangerously-load-development-channels server:slack-channel',
    ].join(' ')
    const shape = /claude.*dangerously-load-development-channels\s+server:slack-channel/
    // 形は一致する。旧ルールはこれだけで停止していた。
    expect(shape.test(production)).toBe(true)
    // テストの一時stateからは他人のbridgeに見える。
    expect(commandOwnedByState(production, [
      '/private/var/folders/zz/T/zerokun-setup-cutover-ab12cd/.claude/channels/slack/',
    ])).toBe(false)
    // 本物のcutoverはちゃんと捕まえる。
    expect(commandOwnedByState(production, [
      '/Users/example/.claude/channels/slack/',
    ])).toBe(true)
    // 末尾の / が無いと <state>-old を取り違える。
    expect(commandOwnedByState(production, [
      '/Users/example/.claude/channels/slack-old/',
    ])).toBe(false)
    // 証拠が無ければ止めない(fail closed)。
    expect(commandOwnedByState(production, [])).toBe(false)
    expect(commandOwnedByState(production, [''])).toBe(false)
    // pathは正規表現ではなくliteralとして比較する。
    expect(commandOwnedByState(
      'x /tmp/a+b(c)/.claude/channels/slack/y',
      ['/tmp/a+b(c)/.claude/channels/slack/'],
    )).toBe(true)
    expect(commandOwnedByState(
      'x /tmp/aZb(c)/.claude/channels/slack/y',
      ['/tmp/a+b(c)/.claude/channels/slack/'],
    )).toBe(false)
  })

})
