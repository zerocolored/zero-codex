import { describe, expect, test } from 'bun:test'
import { updateTrackedProcesses, type ProcessIdentity } from './process-tree.ts'

function processIdentity(
  pid: number,
  ppid: number,
  pgid: number,
  started: string,
): ProcessIdentity {
  return { pid, ppid, pgid, started }
}

describe('process tree identity tracking', () => {
  test('生存中のgroup leaderとその子孫だけを追跡する', () => {
    const tracked = new Map<number, string>()
    updateTrackedProcesses([
      processIdentity(100, 1, 100, 'root-a'),
      processIdentity(101, 100, 100, 'child-a'),
      processIdentity(102, 101, 102, 'detached-a'),
    ], [100], 100, tracked)

    expect([...tracked]).toEqual([
      [100, 'root-a'],
      [101, 'child-a'],
      [102, 'detached-a'],
    ])
  })

  test('終了したgroupの数値PGIDを再利用した無関係processを追跡しない', () => {
    const tracked = new Map<number, string>([
      [100, 'root-a'],
      [101, 'child-a'],
    ])
    updateTrackedProcesses([
      processIdentity(100, 1, 100, 'unrelated-root-b'),
      processIdentity(200, 100, 100, 'unrelated-child-b'),
    ], [], 100, tracked)

    expect(tracked.size).toBe(0)
  })

  test('終了したroot PIDを再利用した別identityとその子を追跡しない', () => {
    const tracked = new Map<number, string>([[100, 'root-a']])
    updateTrackedProcesses([
      processIdentity(100, 1, 100, 'unrelated-root-b'),
      processIdentity(200, 100, 100, 'unrelated-child-b'),
    ], [100], 100, tracked)

    expect([...tracked]).toEqual([[100, 'root-a']])
  })

  test('終了済みidentityを除去して累計process churnを上限超過に数えない', () => {
    const tracked = new Map<number, string>()
    for (let pid = 1; pid <= 5_000; pid += 1) tracked.set(pid, `old-${pid}`)

    updateTrackedProcesses([
      processIdentity(6_000, 1, 6_000, 'live-root'),
    ], [6_000], 6_000, tracked)

    expect([...tracked]).toEqual([[6_000, 'live-root']])
  })
})
