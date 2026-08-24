import { describe, expect, test } from 'bun:test'
import {
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
})
