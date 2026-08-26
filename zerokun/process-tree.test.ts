import { describe, expect, test } from 'bun:test'
import {
  readProcessIdentity,
  updateTrackedProcesses,
  type ProcessIdentity,
} from './process-tree.ts'

const generations = new Map<string, string>()

function generation(label: string): string {
  let value = generations.get(label)
  if (!value) {
    value = `00000000-0000-4000-8000-000000000001:1:${String(generations.size + 1).padStart(6, '0')}`
    generations.set(label, value)
  }
  return value
}

function processIdentity(
  pid: number,
  ppid: number,
  pgid: number,
  started: string,
): ProcessIdentity {
  const value = generation(started)
  return {
    pid,
    ppid,
    pgid,
    status: 2,
    bootSession: value.split(':')[0]!,
    startSec: 1,
    startUsec: Number(value.split(':')[2]),
    started: value,
  }
}

describe('process tree identity tracking', () => {
  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'process tableから一時欠落したlive generationをdirect probeで保持する',
    () => {
      const identity = readProcessIdentity(process.pid)
      expect(identity).toBeDefined()
      const tracked = new Map([[process.pid, identity!.started]])
      updateTrackedProcesses([], [], identity!.pgid, tracked)
      expect(tracked.get(process.pid)).toBe(identity!.started)
    },
  )

  test('初回tableでroot generationを読めなければ空sentinelで成功扱いしない', () => {
    const tracked = new Map<number, string>()
    expect(() => updateTrackedProcesses([], [100], 100, tracked))
      .toThrow('追跡root process 100のgenerationを取得できません')
    expect(tracked.size).toBe(0)
  })

  test('生存中のgroup leaderとその子孫だけを追跡する', () => {
    const tracked = new Map<number, string>()
    updateTrackedProcesses([
      processIdentity(100, 1, 100, 'root-a'),
      processIdentity(101, 100, 100, 'child-a'),
      processIdentity(102, 101, 102, 'detached-a'),
    ], [100], 100, tracked)

    expect([...tracked]).toEqual([
      [100, generation('root-a')],
      [101, generation('child-a')],
      [102, generation('detached-a')],
    ])
  })

  test('終了したgroupの数値PGIDを再利用した無関係processを追跡しない', () => {
    const tracked = new Map<number, string>([
      [100, generation('root-a')],
      [101, generation('child-a')],
    ])
    updateTrackedProcesses([
      processIdentity(100, 1, 100, 'unrelated-root-b'),
      processIdentity(200, 100, 100, 'unrelated-child-b'),
    ], [], 100, tracked)

    expect(tracked.size).toBe(0)
  })

  test('親groupを継承したroot PIDと同番号の無関係group memberを追跡しない', () => {
    const tracked = new Map<number, string>([[100, generation('inherited-root')]])
    updateTrackedProcesses([
      processIdentity(100, 50, 50, 'inherited-root'),
      processIdentity(101, 100, 50, 'real-child'),
      processIdentity(102, 101, 102, 'real-grandchild'),
      processIdentity(200, 1, 100, 'unrelated-group-member'),
    ], [100], 100, tracked)

    expect([...tracked]).toEqual([
      [100, generation('inherited-root')],
      [101, generation('real-child')],
      [102, generation('real-grandchild')],
    ])
  })

  test('終了したroot PIDを再利用した別identityとその子を追跡しない', () => {
    const tracked = new Map<number, string>([[100, generation('root-a')]])
    updateTrackedProcesses([
      processIdentity(100, 1, 100, 'unrelated-root-b'),
      processIdentity(200, 100, 100, 'unrelated-child-b'),
    ], [100], 100, tracked)

    expect([...tracked]).toEqual([[100, generation('root-a')]])
  })

  test('終了済みidentityを除去して累計process churnを上限超過に数えない', () => {
    const tracked = new Map<number, string>()
    // Use values above Darwin's PID range so every direct generation probe is
    // deterministically `missing`; low synthetic values can name protected
    // system processes and correctly produce an `unknown` fail-closed result.
    for (let pid = 1_000_000; pid < 1_005_000; pid += 1) {
      tracked.set(pid, generation(`old-${pid}`))
    }

    updateTrackedProcesses([
      processIdentity(6_000, 1, 6_000, 'live-root'),
    ], [6_000], 6_000, tracked)

    expect([...tracked]).toEqual([[6_000, generation('live-root')]])
  })
})
