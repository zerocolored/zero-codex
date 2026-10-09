import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import {
  commandOwnedByState,
  observeProcessGeneration,
  processGroupSignalAllowed,
  processStartKey,
  readBootSession,
  readProcessIdentity,
  readProcessTable,
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

  // Linux (WSL2) reads the same generation from /proc; both kernels are asserted for real.
  const noLiveProcessTable = (process.platform !== 'darwin' && process.platform !== 'linux')
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1'

  test.skipIf(noLiveProcessTable)(
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

  test.skipIf(noLiveProcessTable)(
    '存在しないPIDはmissingでありunknownへ丸めない', () => {
    const current = readProcessIdentity(process.pid)!
    expect(observeProcessGeneration({ ...current, pid: 2_147_483_647 })).toEqual({
      status: 'dead',
      reason: 'missing',
    })
    },
  )

  test.skipIf(noLiveProcessTable)(
    'process tableは自分自身をuid付きで含み、boot sessionはUUID形式である', () => {
    const session = readBootSession()
    expect(session).toMatch(/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/)
    const self = readProcessTable().find(identity => identity.pid === process.pid)
    expect(self).toBeDefined()
    expect(self!.uid).toBe(process.getuid!())
    expect(self!.ppid).toBe(process.ppid)
    expect(self!.bootSession).toBe(session!)
    expect(sameProcessGeneration(self!, readProcessIdentity(process.pid)!)).toBe(true)
    },
  )

  // 2026-10-08: WSL2 は realtime clock が数十秒ごとに後ろへ飛ぶ（dmesg "Time jumped
  // backwards"）。/proc/stat の btime は realtime − uptime なので一緒に動き、executor が
  // cache した btime と supervisor が読み直した btime がずれて registration の generation
  // 照合（startSec）が全件落ちた。Linux の generation は boot_id + 起動 tick だけで組み、
  // 時計から独立していることを固定する。
  test.skipIf(process.platform !== 'linux' || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'Linuxのgenerationはboot相対の起動tickだけで決まり、realtime clockに依存しない', () => {
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
    const startTicks = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19])
    const ticksPerSecond = Number(Bun.spawnSync(['/usr/bin/getconf', 'CLK_TCK'], {
      stdout: 'pipe', stderr: 'ignore', stdin: 'ignore',
    }).stdout.toString().trim())
    expect(ticksPerSecond).toBeGreaterThan(0)
    const identity = readProcessIdentity(process.pid)!
    expect(identity.startSec).toBe(Math.floor(startTicks / ticksPerSecond))
    expect(identity.startUsec).toBe(
      Math.floor(((startTicks % ticksPerSecond) * 1_000_000) / ticksPerSecond),
    )
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))![1])
    expect(identity.startSec).toBeLessThan(btime)
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
    // 末尾の / が無いと <state> が <state>-old に前方一致して、別installの
    // bridgeを自分のものと誤判定する。commandを兄弟state側にして向きを固定する。
    const sibling = production.replaceAll('/channels/slack/', '/channels/slack-old/')
    expect(commandOwnedByState(sibling, [
      '/Users/example/.claude/channels/slack/',
    ])).toBe(false)
    expect(commandOwnedByState(sibling, [
      '/Users/example/.claude/channels/slack',
    ])).toBe(true)
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
