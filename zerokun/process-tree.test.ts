import { describe, expect, test } from 'bun:test'
import {
  MAX_TRACKED_PROCESSES,
  readProcessIdentity,
  reapTrackedProcesses,
  synchronizeTrackedProcessLedger,
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
    const missingPid = 2_147_483_647
    const tracked = new Map<number, string>()
    expect(() => updateTrackedProcesses([], [missingPid], missingPid, tracked))
      .toThrow(`追跡root process ${missingPid}のgenerationを取得できません`)
    expect(tracked.size).toBe(0)
  })

  test('一時unknownの既知generationを保持し探索rootにはせずalive復帰を待つ', () => {
    const root = processIdentity(100, 1, 100, 'root-transient')
    const child = processIdentity(101, 100, 100, 'child-transient')
    const grandchild = processIdentity(102, 101, 102, 'grandchild-transient')
    const tracked = new Map<number, string>([
      [root.pid, root.started],
      [child.pid, child.started],
    ])

    updateTrackedProcesses(
      [root, grandchild],
      [root.pid],
      root.pid,
      tracked,
      new Set(),
      expected => expected.pid === child.pid
        ? { status: 'unknown' }
        : { status: 'alive', identity: root },
    )
    expect([...tracked]).toEqual([
      [root.pid, root.started],
      [child.pid, child.started],
    ])

    updateTrackedProcesses(
      [root, grandchild],
      [root.pid],
      root.pid,
      tracked,
      new Set(),
      expected => expected.pid === child.pid
        ? { status: 'alive', identity: child }
        : { status: 'alive', identity: root },
    )
    expect([...tracked]).toEqual([
      [root.pid, root.started],
      [child.pid, child.started],
      [grandchild.pid, grandchild.started],
    ])
  })

  test('一時unknown後にdeadと確定した非rootを除去し再利用PIDの子を採らない', () => {
    const root = processIdentity(100, 1, 100, 'root-prune')
    const child = processIdentity(101, 100, 100, 'child-prune')
    const unrelated = processIdentity(102, 101, 102, 'unrelated-after-prune')
    const tracked = new Map<number, string>([
      [root.pid, root.started],
      [child.pid, child.started],
    ])

    updateTrackedProcesses(
      [root, unrelated],
      [root.pid],
      root.pid,
      tracked,
      new Set(),
      () => ({ status: 'unknown' }),
    )
    updateTrackedProcesses(
      [root, unrelated],
      [root.pid],
      root.pid,
      tracked,
      new Set(),
      () => ({ status: 'dead', reason: 'reused' }),
    )

    expect([...tracked]).toEqual([[root.pid, root.started]])
  })

  test('group leaderの一時unknown中は数値PGIDを探索に使わずalive復帰後だけ再開する', () => {
    const root = processIdentity(100, 1, 100, 'root-group-transient')
    const groupMember = processIdentity(101, 1, 100, 'group-member-transient')
    const tracked = new Map([[root.pid, root.started]])

    updateTrackedProcesses(
      [groupMember],
      [root.pid],
      root.pid,
      tracked,
      new Set(),
      () => ({ status: 'unknown' }),
    )
    expect([...tracked]).toEqual([[root.pid, root.started]])

    updateTrackedProcesses(
      [groupMember],
      [root.pid],
      root.pid,
      tracked,
      new Set(),
      () => ({ status: 'alive', identity: root }),
    )
    expect([...tracked]).toEqual([
      [root.pid, root.started],
      [groupMember.pid, groupMember.started],
    ])
  })

  test.skipIf(process.platform !== 'darwin')(
    'cleanupはpersistent unknownを許容せずsignal前にfail closedする',
    async () => {
      const pid = 1_000_000
      const started = generation('cleanup-unknown')
      const tracked = new Map([[pid, started]])

      await expect(reapTrackedProcesses({
        rootPids: [pid],
        groupId: pid,
        tracked,
        generationObserver: () => ({ status: 'unknown' }),
      })).rejects.toThrow(`process ${pid}のgenerationを確認できません`)
      expect(tracked.get(pid)).toBe(started)
    },
  )

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

  test('durable ledgerも終了済みgenerationをpruneして生涯上限にしない', () => {
    const tracked = new Map<number, string>([[6_000, generation('live-root-ledger')]])
    const ledger = new Map<string, { pid: number; started: string }>()
    for (let pid = 1_000_000; pid < 1_005_000; pid += 1) {
      const started = generation(`historical-${pid}`)
      ledger.set(`${pid}:${started}`, { pid, started })
    }

    synchronizeTrackedProcessLedger(tracked, ledger)

    expect([...ledger.values()]).toEqual([
      { pid: 6_000, started: generation('live-root-ledger') },
    ])
  })

  test('同時に生存するgenerationが上限を超える場合はfail closedを維持する', () => {
    const tracked = new Map<number, string>()
    for (let index = 0; index <= MAX_TRACKED_PROCESSES; index += 1) {
      tracked.set(10_000 + index, generation(`concurrent-${index}`))
    }
    expect(() => synchronizeTrackedProcessLedger(tracked, new Map()))
      .toThrow(`追跡process数が上限${MAX_TRACKED_PROCESSES}を超えました`)
  })
})
