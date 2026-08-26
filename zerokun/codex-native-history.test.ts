import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AppServerProtocolError,
} from './codex-app-server-session.ts'
import {
  assertNativeAdvisorHistory,
  nativeAdvisorHistoryPermissionOverrides,
} from './codex-executor.ts'
import {
  nativeAdvisorMarker,
  nativeAdvisorResponseDigest,
  type NativeAdvisorRoundEvidence,
} from './native-advisor-evidence.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(
  turnsListSupported: boolean,
  delayedThread: 'parent' | 'parent-partial' | 'solution'
    | 'solution-partial-same-id' | 'solution-stale-same-id'
    | 'solution-conflicting-id' | 'solution-null-phase' | 'solution-omitted-phase'
    | 'solution-commentary-only' | 'solution-commentary-then-final'
    | 'solution-delegated' | 'solution-long' | null = null,
  itemsListSupported = true,
  fullThreadRead: 'fail' | 'omit-parent-list' | 'omit-parent-everywhere'
    | 'omit-solution-list' | 'omit-solution-everywhere'
    | 'duplicate-solution-read' | null = null,
) {
  const repo = mkdtempSync(join(tmpdir(), 'zero-native-history-'))
  roots.push(repo)
  const attemptNonce = 'f'.repeat(32)
  const inputDigest = 'a'.repeat(64)
  const parentThreadId = 'parent-thread'
  const parentTurnId = 'parent-turn'
  const children = [
    { id: 'solution-thread', perspective: 'solution' as const, role: 'solution_analyst' },
    { id: 'risk-thread', perspective: 'risk' as const, role: 'risk_reviewer' },
  ]
  const response = (perspective: 'solution' | 'risk') => (
    `${perspective} response\n${nativeAdvisorMarker(
      attemptNonce, 1, inputDigest, 'investigation', 1, perspective,
    )}`
  )
  const rounds: NativeAdvisorRoundEvidence[] = [{
    inputRevision: 1,
    inputDigest,
    phase: 'investigation',
    round: 1,
    native: children.map(child => ({
      perspective: child.perspective,
      agentId: child.id,
      responseDigest: nativeAdvisorResponseDigest(response(child.perspective)),
    })),
  }]
  const metadata = new Map<string, Record<string, unknown>>([
    [parentThreadId, {
      id: parentThreadId, parentThreadId: null, cwd: repo, source: 'appServer',
    }],
    ...children.map(child => [child.id, {
      id: child.id,
      parentThreadId,
      cwd: repo,
      agentRole: child.role,
      source: { subAgent: { thread_spawn: {
        parent_thread_id: parentThreadId, depth: 1, agent_role: child.role,
      } } },
    }] as const),
  ])
  const turns = new Map<string, Array<Record<string, unknown>>>([
    [parentThreadId, [{
      id: parentTurnId, status: 'completed', itemsView: 'full', error: null,
      items: children.map(child => ({
        type: 'subAgentActivity', kind: 'started', agentThreadId: child.id,
      })),
    }]],
    ...children.map(child => [child.id, [{
      id: `${child.id}-turn`, status: 'completed', itemsView: 'full', error: null,
      items: (() => {
        const final: Record<string, unknown> = {
          type: 'agentMessage', id: `${child.id}-final`, phase: 'final_answer',
          text: response(child.perspective),
        }
        if (child.perspective === 'solution' && delayedThread === 'solution-null-phase') {
          final.phase = null
        }
        if (child.perspective === 'solution' && delayedThread === 'solution-omitted-phase') {
          delete final.phase
        }
        if (child.perspective === 'solution' && delayedThread === 'solution-commentary-only') {
          final.phase = 'commentary'
        }
        if (child.perspective === 'solution'
          && delayedThread === 'solution-commentary-then-final') {
          return [{
            type: 'agentMessage', id: `${child.id}-commentary`,
            phase: 'commentary', text: 'checking',
          }, final]
        }
        return [final]
      })(),
    }]] as const),
  ])
  let itemsListCalls = 0
  let fullThreadReadCalls = 0
  const delayedThreadId = delayedThread === 'parent' || delayedThread === 'parent-partial'
    ? parentThreadId
    : delayedThread?.startsWith('solution-') || delayedThread === 'solution'
      ? children[0]!.id
      : null
  const visibleTurns = (threadId: string): Array<Record<string, unknown>> | undefined => {
    const stored = turns.get(threadId)
    if (threadId !== delayedThreadId || !stored) return stored
    return stored.map(turn => {
      const storedItems = Array.isArray(turn.items) ? turn.items : []
      let items: unknown[] = []
      if (delayedThread === 'parent-partial') items = storedItems.slice(0, 1)
      if (delayedThread === 'solution-partial-same-id') {
        items = storedItems.map(item => ({
          ...(item as Record<string, unknown>), text: '',
        }))
      }
      if (delayedThread === 'solution-stale-same-id') {
        items = storedItems.map(item => ({
          ...(item as Record<string, unknown>), text: 'stale materialization',
        }))
      }
      if (delayedThread === 'solution-conflicting-id') {
        items = storedItems.map(item => ({
          ...(item as Record<string, unknown>), id: 'different-final-id',
          text: 'conflicting final response',
        }))
      }
      return { ...turn, items }
    })
  }
  const read = async (
    method: 'thread/read' | 'thread/list' | 'thread/turns/list' | 'thread/items/list',
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const threadId = String(params.threadId ?? '')
    if (method === 'thread/read') {
      const thread = metadata.get(threadId)
      if (!thread) throw new Error(`unknown thread ${threadId}`)
      if (params.includeTurns === true) {
        fullThreadReadCalls += 1
        if (fullThreadRead === 'fail') throw new Error('fixture full thread read failed')
      }
      let readTurns = fullThreadRead === 'omit-parent-everywhere'
        && threadId === parentThreadId ? [] : visibleTurns(threadId)
      if (fullThreadRead === 'omit-solution-everywhere'
        && threadId === children[0]!.id) readTurns = []
      if (fullThreadRead === 'duplicate-solution-read'
        && threadId === children[0]!.id && readTurns) {
        readTurns = [...readTurns, { ...readTurns[0], id: 'duplicate-solution-turn' }]
      }
      return {
        thread: params.includeTurns === true
          ? { ...thread, turns: readTurns }
          : thread,
      }
    }
    if (method === 'thread/turns/list') {
      if (!turnsListSupported) {
        throw new AppServerProtocolError(
          'thread/turns/list unsupported', method, 2, { code: -32601 },
        )
      }
      const data = (fullThreadRead === 'omit-parent-list'
          || fullThreadRead === 'omit-parent-everywhere')
        && threadId === parentThreadId ? [] : visibleTurns(threadId)
      const listed = (fullThreadRead === 'omit-solution-list'
          || fullThreadRead === 'omit-solution-everywhere'
          || fullThreadRead === 'duplicate-solution-read')
        && threadId === children[0]!.id ? [] : data
      return { data: listed, nextCursor: null }
    }
    if (method === 'thread/items/list') {
      itemsListCalls += 1
      if (!itemsListSupported) {
        throw new AppServerProtocolError(
          'thread/items/list unsupported', method, 2, { code: -32601 },
        )
      }
      const selected = turns.get(threadId)?.find(turn => turn.id === params.turnId)
      const storedItems = Array.isArray(selected?.items) ? selected.items : []
      const items = threadId === children[0]!.id && delayedThread === 'solution-delegated'
        ? [...storedItems, {
          type: 'subAgentActivity', kind: 'started', agentThreadId: 'grandchild-thread',
        }]
        : threadId === children[0]!.id && delayedThread === 'solution-long'
          ? [
            ...Array.from({ length: 4_200 }, (_, index) => ({
              type: 'commandExecution', id: `command-${index}`, status: 'completed',
            })),
            ...storedItems,
          ]
          : storedItems
      return {
        data: items.map(item => ({ turnId: params.turnId, item })),
        nextCursor: null,
      }
    }
    return {
      data: children.map(child => ({ id: child.id, parentThreadId })),
      nextCursor: null,
    }
  }
  return {
    itemsListCalls: () => itemsListCalls,
    fullThreadReadCalls: () => fullThreadReadCalls,
    options: {
      codexBin: '/unused',
      repoPath: repo,
      permissionOverrides: ['mcp_servers={}'],
      attemptNonce,
      parentThreadId,
      parentSource: 'appServer' as const,
      parentTurnIds: [parentTurnId],
      rounds,
      readForTesting: read,
    },
  }
}

describe('native advisor App Server history', () => {
  test('history readerは単一MCP tableでbrokerを含む全transportを無効化する', () => {
    const overrides = nativeAdvisorHistoryPermissionOverrides([
      'mcp_servers={zerokun_advisors={command="/safe/broker",args=[],enabled=true},host_http={url="http://127.0.0.1:9",enabled=false},host_stdio={command="/usr/bin/false",args=[],enabled=false}}',
      'features.multi_agent=true',
    ])
    const mcp = overrides.filter(value => value.startsWith('mcp_servers='))
    expect(mcp).toHaveLength(1)
    const parsed = Bun.TOML.parse(`value=${mcp[0]!.slice('mcp_servers='.length)}`) as {
      value: Record<string, Record<string, unknown>>
    }
    expect(Object.values(parsed.value).every(server => server.enabled === false)).toBe(true)
    expect(parsed.value.zerokun_advisors).toEqual({
      enabled: false, command: '/usr/bin/false', args: [],
    })
    expect(parsed.value.host_http).toEqual({
      enabled: false, url: 'http://127.0.0.1:9',
    })
    expect(overrides.filter(value => value === 'features.multi_agent=false')).toHaveLength(1)
  })

  test('history readerは重複またはdotted MCP overrideをspawn前に拒否する', () => {
    expect(() => nativeAdvisorHistoryPermissionOverrides([
      'mcp_servers={}', 'mcp_servers={}',
    ])).toThrow('exactly one')
    expect(() => nativeAdvisorHistoryPermissionOverrides([
      'mcp_servers={}', 'mcp_servers.host.enabled=false',
    ])).toThrow('dotted')
  })

  test('items/listを全selected turnで完走して親子履歴を照合する', async () => {
    const value = fixture(true)
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(3)
  })

  test('childの空full履歴はitems/listのfinal responseまで復元する', async () => {
    const value = fixture(true, 'solution')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(3)
  })

  test('native履歴でもlegacyのnullまたは省略phaseを受理する', async () => {
    for (const mode of ['solution-null-phase', 'solution-omitted-phase'] as const) {
      const value = fixture(true, mode)
      await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
      expect(value.itemsListCalls()).toBe(3)
    }
  })

  test('native履歴のcommentaryだけは拒否しfinal併存時はfinalだけを採択する', async () => {
    const rejected = fixture(true, 'solution-commentary-only')
    await expect(assertNativeAdvisorHistory(rejected.options)).rejects.toThrow(
      'does not contain one final response',
    )

    const accepted = fixture(true, 'solution-commentary-then-final')
    await expect(assertNativeAdvisorHistory(accepted.options)).resolves.toBeUndefined()
    expect(accepted.itemsListCalls()).toBe(3)
  })

  test('同一item IDの空projectionをitems/listの完成回答で更新する', async () => {
    const value = fixture(true, 'solution-partial-same-id')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(3)
  })

  test('同一item IDの古いprojectionをitems/listの確定回答で更新する', async () => {
    const value = fixture(true, 'solution-stale-same-id')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(3)
  })

  test('異なるitem IDの複数final responseは引き続き拒否する', async () => {
    const value = fixture(true, 'solution-conflicting-id')
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'one final response',
    )
    expect(value.itemsListCalls()).toBe(3)
  })

  test('parentの空full履歴はitems/listのadvisor activityまで復元する', async () => {
    const value = fixture(true, 'parent')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(3)
  })

  test('parentの部分full履歴も期待advisor IDが揃うまでitems/listへ降りる', async () => {
    const value = fixture(true, 'parent-partial')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(3)
  })

  test('完全items履歴があれば補助thread/read失敗へ依存しない', async () => {
    for (const mode of ['parent-partial', 'solution'] as const) {
      const value = fixture(true, mode, true, 'fail')
      await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
      expect(value.itemsListCalls()).toBe(3)
      expect(value.fullThreadReadCalls()).toBe(0)
    }
  })

  test('items証拠も不足する場合は補助thread/read失敗を隠さない', async () => {
    const value = fixture(true, 'solution-commentary-only', true, 'fail')
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'fixture full thread read failed',
    )
    expect(value.fullThreadReadCalls()).toBe(1)
  })

  test('turns/listから欠落したparent turnをthread/readから復元する', async () => {
    const value = fixture(true, null, true, 'omit-parent-list')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.fullThreadReadCalls()).toBe(1)
    expect(value.itemsListCalls()).toBe(3)
  })

  test('全履歴から欠落したparent turnは明示的に拒否する', async () => {
    const value = fixture(true, null, true, 'omit-parent-everywhere')
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'omitted selected turn parent-turn',
    )
  })

  test('turns/listから欠落したchild turnをthread/readから1件だけ復元する', async () => {
    const value = fixture(true, null, true, 'omit-solution-list')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.fullThreadReadCalls()).toBe(1)
    expect(value.itemsListCalls()).toBe(3)
  })

  test('child turnが全viewで欠落または複数なら拒否する', async () => {
    for (const mode of ['omit-solution-everywhere', 'duplicate-solution-read'] as const) {
      const value = fixture(true, null, true, mode)
      await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
        'must contain exactly one turn',
      )
    }
  })

  test('child fullに未反映の再委任activityもitems/listから検出する', async () => {
    const value = fixture(true, 'solution-delegated')
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'delegated to another subagent',
    )
    expect(value.itemsListCalls()).toBe(3)
  })

  test('4096件超の無関係item後にあるchild final responseを投影する', async () => {
    const value = fixture(true, 'solution-long')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(3)
  })

  test('items/list未対応ならnegative evidenceを推測せずfail-closeする', async () => {
    const value = fixture(true, null, false)
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow('unsupported')
    expect(value.itemsListCalls()).toBe(1)
  })

  test('turns/list未対応時はthread/readへ弱めず公開をfail-closeする', async () => {
    const value = fixture(false)
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow('unsupported')
    expect(value.itemsListCalls()).toBe(0)
  })
})
