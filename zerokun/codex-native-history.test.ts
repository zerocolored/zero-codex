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
    | 'solution-legacy-agent-message'
    | 'solution-delegated' | 'solution-long' | 'solution-parent-interacted' | null = null,
  itemsListSupported = true,
  fullThreadRead: 'fail' | 'omit-parent-list' | 'omit-parent-everywhere'
    | 'omit-solution-list' | 'omit-solution-everywhere'
    | 'duplicate-solution-read' | null = null,
  identityMode: 'same' | 'logical-labels-with-uuid-threads' = 'same',
) {
  const repo = mkdtempSync(join(tmpdir(), 'zero-native-history-'))
  roots.push(repo)
  const attemptNonce = 'f'.repeat(32)
  const inputDigest = 'a'.repeat(64)
  const parentThreadId = 'parent-thread'
  const parentTurnId = 'parent-turn'
  const children = identityMode === 'logical-labels-with-uuid-threads'
    ? [
      {
        id: '01a04329-fa9b-7562-bbfe-1258a97e9071',
        perspective: 'solution' as const,
        role: 'solution_analyst',
      },
      {
        id: '01a0432a-1683-7142-b2a0-22726fdfa8b7',
        perspective: 'risk' as const,
        role: 'risk_reviewer',
      },
    ]
    : [
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
    native: children.map((child, index) => ({
      perspective: child.perspective,
      agentId: identityMode === 'logical-labels-with-uuid-threads'
        ? ['investigation_solution', 'investigation_risk'][index]!
        : child.id,
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
        type: 'subAgentActivity', id: `${child.id}-activity`,
        kind: 'started', agentThreadId: child.id,
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
        if (child.perspective === 'solution'
          && delayedThread === 'solution-legacy-agent-message') {
          final.type = 'agent_message'
        }
        if (child.perspective === 'solution'
          && delayedThread === 'solution-parent-interacted') {
          return [{
            type: 'subAgentActivity', id: 'call_parent_root_interaction',
            kind: 'interacted', agentThreadId: parentThreadId, agentPath: '/root',
          }, final]
        }
        return [final]
      })(),
    }]] as const),
  ])
  let itemsListCalls = 0
  let fullThreadReadCalls = 0
  const threadReadIds: string[] = []
  const delayedThreadId = delayedThread === 'parent' || delayedThread === 'parent-partial'
    ? parentThreadId
    : (delayedThread?.startsWith('solution-')
        && delayedThread !== 'solution-parent-interacted') || delayedThread === 'solution'
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
      threadReadIds.push(threadId)
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
    const requestedParent = String(params.parentThreadId ?? '')
    return {
      data: requestedParent === parentThreadId
        ? children.map(child => ({ id: child.id, parentThreadId }))
        : [],
      nextCursor: null,
    }
  }
  return {
    itemsListCalls: () => itemsListCalls,
    fullThreadReadCalls: () => fullThreadReadCalls,
    threadReadIds: () => [...threadReadIds],
    options: {
      codexBin: '/unused',
      repoPath: repo,
      permissionOverrides: ['mcp_servers={}'],
      attemptNonce,
      parentThreadId,
      parentSource: 'appServer' as const,
      parentChildBaseline: [],
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
    expect(value.itemsListCalls()).toBe(6)
  })

  test('childの空full履歴はitems/listのfinal responseまで復元する', async () => {
    const value = fixture(true, 'solution')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(6)
  })

  test('native履歴でもlegacyのnullまたは省略phaseを受理する', async () => {
    for (const mode of ['solution-null-phase', 'solution-omitted-phase'] as const) {
      const value = fixture(true, mode)
      await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
      expect(value.itemsListCalls()).toBe(6)
    }
  })

  test('supported item journalでもlegacy agent_messageを受理する', async () => {
    const value = fixture(true, 'solution-legacy-agent-message')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(6)
  })

  test('native履歴のcommentaryだけは拒否しfinal併存時はfinalだけを採択する', async () => {
    const rejected = fixture(true, 'solution-commentary-only')
    await expect(assertNativeAdvisorHistory(rejected.options)).rejects.toThrow(
      'does not contain one final response',
    )

    const accepted = fixture(true, 'solution-commentary-then-final')
    await expect(assertNativeAdvisorHistory(accepted.options)).resolves.toBeUndefined()
    expect(accepted.itemsListCalls()).toBe(6)
  })

  test('supported items/listのfinal反映遅延をbounded再取得で回収する', async () => {
    const value = fixture(true)
    const original = value.options.readForTesting!
    let parentSnapshots = 0
    value.options.readForTesting = async (method, params) => {
      if (method === 'thread/read' && params.includeTurns === false
        && params.threadId === value.options.parentThreadId) parentSnapshots += 1
      const response = await original(method, params)
      if (parentSnapshots !== 1 || method !== 'thread/items/list'
        || params.threadId !== 'solution-thread') return response
      return {
        ...response,
        data: (response.data as Array<Record<string, unknown>>).map(entry => ({
          ...entry,
          item: {
            ...(entry.item as Record<string, unknown>),
            phase: 'commentary',
            text: 'final is still materializing',
          },
        })),
      }
    }
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(9)
  })

  test('supported snapshot収集中のchild turn欠落を再取得し2連続validへ収束する', async () => {
    const value = fixture(true)
    const original = value.options.readForTesting!
    let parentSnapshots = 0
    value.options.readForTesting = async (method, params) => {
      if (method === 'thread/read' && params.includeTurns === false
        && params.threadId === value.options.parentThreadId) parentSnapshots += 1
      const response = await original(method, params)
      if (parentSnapshots !== 1 || params.threadId !== 'solution-thread') return response
      if (method === 'thread/turns/list') return { ...response, data: [] }
      if (method === 'thread/read' && params.includeTurns === true) {
        return {
          ...response,
          thread: { ...(response.thread as Record<string, unknown>), turns: [] },
        }
      }
      return response
    }
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(8)
    expect(value.fullThreadReadCalls()).toBe(1)
  })

  test('先頭childのfinal遅延中に後続childで観測したunsafe itemを再取得で隠さない', async () => {
    const value = fixture(true)
    const original = value.options.readForTesting!
    let parentSnapshots = 0
    value.options.readForTesting = async (method, params) => {
      if (method === 'thread/read' && params.includeTurns === false
        && params.threadId === value.options.parentThreadId) parentSnapshots += 1
      const response = await original(method, params)
      if (parentSnapshots !== 1 || method !== 'thread/items/list') return response
      if (params.threadId === 'solution-thread') {
        return {
          ...response,
          data: (response.data as Array<Record<string, unknown>>).map(entry => ({
            ...entry,
            item: {
              ...(entry.item as Record<string, unknown>),
              phase: 'commentary',
              text: 'final is still materializing',
            },
          })),
        }
      }
      if (params.threadId === 'risk-thread') {
        return {
          ...response,
          data: [
            ...(response.data as Array<Record<string, unknown>>),
            {
              turnId: 'risk-thread-turn',
              item: {
                type: 'subAgentActivity',
                id: 'risk-late-unsafe-child',
                kind: 'started',
                agentThreadId: 'risk-hidden-grandchild',
              },
            },
          ],
        }
      }
      return response
    }
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'removed observed item evidence',
    )
  })

  test('supported items/listの初回valid後に現れたdelegationを固定点採択で隠さない', async () => {
    const value = fixture(true)
    const original = value.options.readForTesting!
    let parentSnapshots = 0
    value.options.readForTesting = async (method, params) => {
      if (method === 'thread/read' && params.includeTurns === false
        && params.threadId === value.options.parentThreadId) parentSnapshots += 1
      const response = await original(method, params)
      if (parentSnapshots !== 2 || method !== 'thread/items/list'
        || params.threadId !== 'solution-thread') return response
      return {
        ...response,
        data: [
          ...(response.data as unknown[]),
          {
            turnId: 'solution-thread-turn',
            item: {
              type: 'subAgentActivity', id: 'transient-grandchild',
              kind: 'started', agentThreadId: 'transient-grandchild-thread',
            },
          },
        ],
      }
    }
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'delegated to another subagent',
    )
    expect(value.itemsListCalls()).toBe(6)
  })

  test('native採択数0のterminal journalを空の物理child履歴と照合する', async () => {
    const value = fixture(true)
    value.options.rounds[0]!.native = [
      {
        perspective: 'solution', attempted: true, adopted: false,
        reasonDigest: '1'.repeat(64),
      },
      {
        perspective: 'risk', attempted: true, adopted: false,
        reasonDigest: '2'.repeat(64),
      },
    ]
    const original = value.options.readForTesting!
    value.options.readForTesting = async (method, params) => {
      if (method === 'thread/list' && params.parentThreadId === value.options.parentThreadId) {
        return { data: [], nextCursor: null }
      }
      const response = await original(method, params)
      if (params.threadId !== value.options.parentThreadId) return response
      if (method === 'thread/items/list') return { data: [], nextCursor: null }
      if (method === 'thread/turns/list') {
        return {
          ...response,
          data: (response.data as Array<Record<string, unknown>>).map(turn => ({
            ...turn, items: [],
          })),
        }
      }
      if (method === 'thread/read' && params.includeTurns === true) {
        const thread = response.thread as Record<string, unknown>
        return {
          ...response,
          thread: {
            ...thread,
            turns: (thread.turns as Array<Record<string, unknown>>).map(turn => ({
              ...turn, items: [],
            })),
          },
        }
      }
      return response
    }
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
  })

  test('同一item IDの空projectionをitems/listの完成回答で更新する', async () => {
    const value = fixture(true, 'solution-partial-same-id')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(6)
  })

  test('同一item IDの古いprojectionをitems/listの確定回答で更新する', async () => {
    const value = fixture(true, 'solution-stale-same-id')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(6)
  })

  test('supported item journalを古いturn projectionより優先する', async () => {
    const value = fixture(true, 'solution-conflicting-id')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(6)
  })

  test('parentの空full履歴はitems/listのadvisor activityまで復元する', async () => {
    const value = fixture(true, 'parent')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(6)
  })

  test('parentの部分full履歴も期待advisor IDが揃うまでitems/listへ降りる', async () => {
    const value = fixture(true, 'parent-partial')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(6)
  })

  test('完全items履歴があれば補助thread/read失敗へ依存しない', async () => {
    for (const mode of ['parent-partial', 'solution'] as const) {
      const value = fixture(true, mode, true, 'fail')
      await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
      expect(value.itemsListCalls()).toBe(6)
      expect(value.fullThreadReadCalls()).toBe(0)
    }
  })

  test('supported item journalの不足を補助thread/readで推測しない', async () => {
    const value = fixture(true, 'solution-commentary-only', true, 'fail')
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'does not contain one final response',
    )
    expect(value.fullThreadReadCalls()).toBe(0)
  })

  test('turns/listから欠落したparent turnをthread/readから復元する', async () => {
    const value = fixture(true, null, true, 'omit-parent-list')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.fullThreadReadCalls()).toBe(2)
    expect(value.itemsListCalls()).toBe(6)
  })

  test('全履歴から欠落したparent turnは明示的に拒否する', async () => {
    const value = fixture(true, null, true, 'omit-parent-everywhere')
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'omitted completed turn parent-turn',
    )
  })

  test('turns/listから欠落したchild turnをthread/readから1件だけ復元する', async () => {
    const value = fixture(true, null, true, 'omit-solution-list')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.fullThreadReadCalls()).toBe(2)
    expect(value.itemsListCalls()).toBe(6)
  })

  test('child turnが全viewで欠落またはcompleted finalが複数なら拒否する', async () => {
    const missing = fixture(true, null, true, 'omit-solution-everywhere')
    await expect(assertNativeAdvisorHistory(missing.options)).rejects.toThrow(
      'contains no materialized turns yet',
    )

    const duplicate = fixture(true, null, true, 'duplicate-solution-read')
    await expect(assertNativeAdvisorHistory(duplicate.options)).rejects.toThrow(
      'does not contain one final response',
    )
  })

  test('childのinterrupted precursorとcompleted finalを全履歴viewで照合する', async () => {
    for (const itemsListSupported of [true, false]) {
      const value = fixture(
        true,
        null,
        itemsListSupported,
        null,
        'logical-labels-with-uuid-threads',
      )
      const original = value.options.readForTesting!
      const childIds = [
        '01a04329-fa9b-7562-bbfe-1258a97e9071',
        '01a0432a-1683-7142-b2a0-22726fdfa8b7',
      ]
      const precursorFor = (threadId: string) => ({
        id: `${threadId}-precursor`,
        status: 'interrupted',
        itemsView: 'full',
        error: null,
        items: [
          { type: 'userMessage', id: `${threadId}-user`, text: 'initial advisor task' },
          {
            type: 'agentMessage', id: `${threadId}-commentary`,
            phase: 'commentary', text: 'checking evidence',
          },
        ],
      })
      value.options.readForTesting = async (method, params) => {
        const threadId = String(params.threadId ?? '')
        if (method === 'thread/items/list' && childIds.includes(threadId)
          && params.turnId === `${threadId}-precursor`) {
          if (!itemsListSupported) {
            return original(method, params)
          }
          const precursor = precursorFor(threadId)
          return {
            data: precursor.items.map(item => ({ turnId: precursor.id, item })),
            nextCursor: null,
          }
        }
        const response = await original(method, params)
        if (!childIds.includes(threadId)) return response
        if (method === 'thread/turns/list') {
          return {
            ...response,
            data: [precursorFor(threadId), ...(response.data as unknown[])],
          }
        }
        if (method === 'thread/read' && params.includeTurns === true) {
          const thread = response.thread as Record<string, unknown>
          return {
            ...response,
            thread: {
              ...thread,
              turns: [precursorFor(threadId), ...(thread.turns as unknown[])],
            },
          }
        }
        return response
      }
      await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    }
  })

  test('割り込み前の旧interrupted childと再開後の採択pairを両履歴経路で照合する', async () => {
    for (const itemsListSupported of [true, false]) {
      const value = fixture(true, null, itemsListSupported)
      const original = value.options.readForTesting!
      const interruptedId = 'interrupted-old-solution'
      const pauseTurn = {
        id: 'paused-parent-turn',
        status: 'completed',
        itemsView: 'full',
        error: null,
        items: [
          {
            type: 'subAgentActivity', id: 'interrupted-old-start',
            kind: 'started', agentThreadId: interruptedId,
          },
          {
            type: 'agentMessage', id: 'pause-final', phase: 'final_answer',
            text: 'interjection accepted\n[ZERO_INTERJECTION_PAUSED:interjection-1]',
          },
        ],
      }
      value.options.parentTurnIds = [pauseTurn.id, ...value.options.parentTurnIds]
      const interruptedTurn = {
        id: 'interrupted-old-turn',
        status: 'interrupted',
        itemsView: 'full',
        error: null,
        items: [{
          type: 'agentMessage', id: 'interrupted-old-commentary',
          phase: 'commentary', text: 'checking before the interjection',
        }],
      }
      const interruptedMetadata = {
        id: interruptedId,
        parentThreadId: value.options.parentThreadId,
        cwd: value.options.repoPath,
        agentRole: 'solution_analyst',
        source: { subAgent: { thread_spawn: {
          parent_thread_id: value.options.parentThreadId,
          depth: 1,
          agent_role: 'solution_analyst',
        } } },
      }
      value.options.readForTesting = async (method, params) => {
        const threadId = String(params.threadId ?? '')
        if (method === 'thread/read' && threadId === interruptedId) {
          return {
            thread: params.includeTurns === true
              ? { ...interruptedMetadata, turns: [interruptedTurn] }
              : interruptedMetadata,
          }
        }
        if (method === 'thread/turns/list' && threadId === interruptedId) {
          return { data: [interruptedTurn], nextCursor: null }
        }
        if (method === 'thread/items/list' && threadId === interruptedId) {
          if (!itemsListSupported) return original(method, params)
          return {
            data: interruptedTurn.items.map(item => ({ turnId: interruptedTurn.id, item })),
            nextCursor: null,
          }
        }
        if (method === 'thread/list') {
          const response = await original(method, params)
          if (params.parentThreadId !== value.options.parentThreadId) return response
          return {
            ...response,
            data: [
              ...(response.data as unknown[]),
              { id: interruptedId, parentThreadId: value.options.parentThreadId },
            ],
          }
        }
        const response = await original(method, params)
        const parentFull = threadId === value.options.parentThreadId
          && ((method === 'thread/read' && params.includeTurns === true)
            || method === 'thread/turns/list')
        if (parentFull) {
          if (method === 'thread/turns/list') {
            return {
              ...response,
              data: [pauseTurn, ...(response.data as unknown[])],
            }
          }
          const thread = response.thread as Record<string, unknown>
          return {
            ...response,
            thread: {
              ...thread,
              turns: [pauseTurn, ...(thread.turns as unknown[])],
            },
          }
        }
        if (itemsListSupported && method === 'thread/items/list'
          && threadId === value.options.parentThreadId
          && params.turnId === pauseTurn.id) {
          return {
            data: pauseTurn.items.map(item => ({ turnId: pauseTurn.id, item })),
            nextCursor: null,
          }
        }
        return response
      }
      await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    }
  })

  test('fork時に親から継承されたsibling activityを全履歴viewで識別する', async () => {
    for (const itemsListSupported of [true, false]) {
      const value = fixture(
        true,
        null,
        itemsListSupported,
        null,
        'logical-labels-with-uuid-threads',
      )
      const original = value.options.readForTesting!
      const solutionId = '01a04329-fa9b-7562-bbfe-1258a97e9071'
      const riskId = '01a0432a-1683-7142-b2a0-22726fdfa8b7'
      const precursor = {
        id: `${riskId}-inherited-precursor`,
        status: 'interrupted',
        itemsView: 'full',
        error: null,
        items: [{
          type: 'subAgentActivity', id: `${solutionId}-activity`,
          kind: 'started', agentThreadId: solutionId,
        }],
      }
      value.options.readForTesting = async (method, params) => {
        const threadId = String(params.threadId ?? '')
        if (method === 'thread/items/list' && threadId === riskId
          && params.turnId === precursor.id) {
          if (!itemsListSupported) return original(method, params)
          return {
            data: precursor.items.map(item => ({ turnId: precursor.id, item })),
            nextCursor: null,
          }
        }
        const response = await original(method, params)
        if (threadId !== riskId) return response
        if (method === 'thread/turns/list') {
          return { ...response, data: [precursor, ...(response.data as unknown[])] }
        }
        if (method === 'thread/read' && params.includeTurns === true) {
          const thread = response.thread as Record<string, unknown>
          return {
            ...response,
            thread: { ...thread, turns: [precursor, ...(thread.turns as unknown[])] },
          }
        }
        return response
      }
      await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    }
  })

  test('child fullに未反映の再委任activityもitems/listから検出する', async () => {
    const value = fixture(true, 'solution-delegated')
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'delegated to another subagent',
    )
    expect(value.itemsListCalls()).toBe(3)
  })

  test('親rootへのinteractedをitems/listとfallbackの両履歴経路で受理する', async () => {
    const itemsList = fixture(true, 'solution-parent-interacted')
    await expect(assertNativeAdvisorHistory(itemsList.options)).resolves.toBeUndefined()

    const fallback = fixture(true, 'solution-parent-interacted', false)
    await expect(assertNativeAdvisorHistory(fallback.options)).resolves.toBeUndefined()
  })

  test('4096件超の無関係item後にあるchild final responseを投影する', async () => {
    const value = fixture(true, 'solution-long')
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(6)
  })

  test('items/list未対応なら両方のfull履歴viewを固定点照合する', async () => {
    const value = fixture(true, null, false)
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(1)
    expect(value.fullThreadReadCalls()).toBe(6)
  })

  test('journalの論理agent名をRPC thread IDに使わず公式child UUIDへ解決する', async () => {
    const value = fixture(
      true,
      null,
      false,
      null,
      'logical-labels-with-uuid-threads',
    )
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.itemsListCalls()).toBe(1)
    expect(value.fullThreadReadCalls()).toBe(6)
    expect(value.threadReadIds()).toContain('01a04329-fa9b-7562-bbfe-1258a97e9071')
    expect(value.threadReadIds()).toContain('01a0432a-1683-7142-b2a0-22726fdfa8b7')
    expect(value.threadReadIds()).not.toContain('investigation_solution')
    expect(value.threadReadIds()).not.toContain('investigation_risk')
  })

  test('未対応fallbackはturns/listとthread/readの両方にcompleted fullを要求する', async () => {
    for (const weakenedMethod of ['thread/turns/list', 'thread/read'] as const) {
      const value = fixture(true, null, false)
      const original = value.options.readForTesting!
      value.options.readForTesting = async (method, params) => {
        const response = await original(method, params)
        const parent = method === weakenedMethod
          && String(params.threadId ?? '') === value.options.parentThreadId
          && (method !== 'thread/read' || params.includeTurns === true)
        if (!parent) return response
        if (method === 'thread/turns/list') {
          return {
            ...response,
            data: (response.data as Array<Record<string, unknown>>).map(turn => ({
              ...turn, itemsView: 'summary',
            })),
          }
        }
        const thread = response.thread as Record<string, unknown>
        return {
          ...response,
          thread: {
            ...thread,
            turns: (thread.turns as Array<Record<string, unknown>>).map(turn => ({
              ...turn, itemsView: 'summary',
            })),
          },
        }
      }
      await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
        'not a completed full projection',
      )
    }
  })

  test('文字列-32601または別methodのerrorをitems/list未対応へ誤分類しない', async () => {
    for (const error of [
      new AppServerProtocolError(
        'string code', 'thread/items/list', 10, { code: '-32601' },
      ),
      new AppServerProtocolError('wrong method', 'thread/read', 10, { code: -32601 }),
      new AppServerProtocolError('invalid params', 'thread/items/list', 10, { code: -32602 }),
      new AppServerProtocolError('server error', 'thread/items/list', 10, { code: -32000 }),
    ]) {
      const value = fixture(true)
      const original = value.options.readForTesting!
      value.options.readForTesting = async (method, params) => {
        if (method === 'thread/items/list') throw error
        return original(method, params)
      }
      await expect(assertNativeAdvisorHistory(value.options)).rejects.toBe(error)
    }
  })

  test('items/list成功後または2page目の-32601はfallbackせず失敗する', async () => {
    const value = fixture(true)
    const original = value.options.readForTesting!
    value.options.readForTesting = async (method, params) => {
      if (method !== 'thread/items/list') return original(method, params)
      if (params.cursor === 'page-2') {
        throw new AppServerProtocolError(
          'late unsupported', 'thread/items/list', 11, { code: -32601 },
        )
      }
      const response = await original(method, params)
      return { ...response, nextCursor: 'page-2' }
    }
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow('late unsupported')
  })

  test('fallbackは一時的な不完全snapshotから連続する同一valid snapshotへ収束する', async () => {
    const value = fixture(true, null, false)
    const original = value.options.readForTesting!
    let parentMetadataReads = 0
    value.options.readForTesting = async (method, params) => {
      if (method === 'thread/read' && params.includeTurns === false
        && params.threadId === value.options.parentThreadId) parentMetadataReads += 1
      const response = await original(method, params)
      const firstSnapshot = parentMetadataReads === 1
      const solutionFullView = params.threadId === 'solution-thread'
        && (method === 'thread/turns/list'
          || (method === 'thread/read' && params.includeTurns === true))
      if (!firstSnapshot || !solutionFullView) return response
      const makePending = (turn: Record<string, unknown>): Record<string, unknown> => ({
        ...turn, status: 'inProgress', items: [],
      })
      if (method === 'thread/turns/list') {
        return {
          ...response,
          data: (response.data as Array<Record<string, unknown>>).map(makePending),
        }
      }
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: {
          ...thread,
          turns: (thread.turns as Array<Record<string, unknown>>).map(makePending),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.fullThreadReadCalls()).toBe(9)
  })

  test('fallbackが上限内に固定点へ到達しなければ拒否する', async () => {
    const value = fixture(true, null, false)
    const original = value.options.readForTesting!
    let metadataReads = 0
    value.options.readForTesting = async (method, params) => {
      const response = await original(method, params)
      if (method !== 'thread/read' || params.includeTurns === true) return response
      metadataReads += 1
      return {
        ...response,
        thread: {
          ...(response.thread as Record<string, unknown>),
          historyEpoch: Math.ceil(metadataReads / 3),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'did not reach a fixed point after 4 snapshots',
    )
  })

  test('同一item IDのimmutable typeまたはagent thread衝突を拒否する', async () => {
    const typeConflict = fixture(true, null, false)
    const typeOriginal = typeConflict.options.readForTesting!
    typeConflict.options.readForTesting = async (method, params) => {
      const response = await typeOriginal(method, params)
      if (method !== 'thread/read' || params.includeTurns !== true
        || params.threadId !== 'solution-thread') return response
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: {
          ...thread,
          turns: (thread.turns as Array<Record<string, unknown>>).map(turn => ({
            ...turn,
            items: (turn.items as Array<Record<string, unknown>>).map(item => ({
              ...item, type: 'commandExecution', status: 'completed',
            })),
          })),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(typeConflict.options)).rejects.toThrow(
      'changed immutable type',
    )

    const threadConflict = fixture(true, null, false)
    const threadOriginal = threadConflict.options.readForTesting!
    threadConflict.options.readForTesting = async (method, params) => {
      const response = await threadOriginal(method, params)
      if (method !== 'thread/read' || params.includeTurns !== true
        || params.threadId !== 'parent-thread') return response
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: {
          ...thread,
          turns: (thread.turns as Array<Record<string, unknown>>).map(turn => ({
            ...turn,
            items: (turn.items as Array<Record<string, unknown>>).map((item, index) => (
              index === 0 ? { ...item, agentThreadId: 'unexpected-thread' } : item
            )),
          })),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(threadConflict.options)).rejects.toThrow(
      'changed immutable agent thread',
    )

    const missingIdentity = fixture(true, null, false)
    const missingOriginal = missingIdentity.options.readForTesting!
    missingIdentity.options.readForTesting = async (method, params) => {
      const response = await missingOriginal(method, params)
      if (method !== 'thread/read' || params.includeTurns !== true
        || params.threadId !== 'parent-thread') return response
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: {
          ...thread,
          turns: (thread.turns as Array<Record<string, unknown>>).map(turn => ({
            ...turn,
            items: (turn.items as Array<Record<string, unknown>>).map((item, index) => {
              if (index !== 0) return item
              const changed = { ...item }
              delete changed.agentThreadId
              return changed
            }),
          })),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(missingIdentity.options)).rejects.toThrow(
      'changed immutable agent thread',
    )
  })

  test('fallbackは両endpoint viewが個別に固定するまで採択しない', async () => {
    const value = fixture(true, null, false)
    const original = value.options.readForTesting!
    let snapshot = 0
    value.options.readForTesting = async (method, params) => {
      if (method === 'thread/read' && params.includeTurns === false
        && params.threadId === 'parent-thread') snapshot += 1
      const response = await original(method, params)
      const solutionFullView = params.threadId === 'solution-thread'
        && (method === 'thread/turns/list'
          || (method === 'thread/read' && params.includeTurns === true))
      if (!solutionFullView) return response
      const keepItems = snapshot % 2 === 1
        ? method === 'thread/turns/list'
        : method === 'thread/read'
      if (method === 'thread/turns/list') {
        return {
          ...response,
          data: (response.data as Array<Record<string, unknown>>).map(turn => ({
            ...turn, items: keepItems ? turn.items : [],
          })),
        }
      }
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: {
          ...thread,
          turns: (thread.turns as Array<Record<string, unknown>>).map(turn => ({
            ...turn, items: keepItems ? turn.items : [],
          })),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'fallback endpoints disagree on selected evidence',
    )
  })

  test('fallbackは両endpointの相補的なadvisor証拠を合成しない', async () => {
    const value = fixture(true, null, false)
    const original = value.options.readForTesting!
    value.options.readForTesting = async (method, params) => {
      const response = await original(method, params)
      const parentFullView = params.threadId === 'parent-thread'
        && (method === 'thread/turns/list'
          || (method === 'thread/read' && params.includeTurns === true))
      if (!parentFullView) return response
      const keepThreadId = method === 'thread/turns/list'
        ? 'solution-thread'
        : 'risk-thread'
      const split = (turn: Record<string, unknown>): Record<string, unknown> => ({
        ...turn,
        items: (turn.items as Array<Record<string, unknown>>).filter(item => (
          item.agentThreadId === keepThreadId
        )),
      })
      if (method === 'thread/turns/list') {
        return {
          ...response,
          data: (response.data as Array<Record<string, unknown>>).map(split),
        }
      }
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: {
          ...thread,
          turns: (thread.turns as Array<Record<string, unknown>>).map(split),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'fallback endpoints disagree on selected evidence',
    )
  })

  test('fallbackはsnapshotをまたぐstable item identity変更を拒否する', async () => {
    const activityConflict = fixture(true, null, false)
    const activityOriginal = activityConflict.options.readForTesting!
    let activitySnapshot = 0
    activityConflict.options.readForTesting = async (method, params) => {
      if (method === 'thread/read' && params.includeTurns === false
        && params.threadId === 'parent-thread') activitySnapshot += 1
      const response = await activityOriginal(method, params)
      const parentFullView = params.threadId === 'parent-thread'
        && (method === 'thread/turns/list'
          || (method === 'thread/read' && params.includeTurns === true))
      if (!parentFullView || activitySnapshot < 2) return response
      const swap = (turn: Record<string, unknown>): Record<string, unknown> => ({
        ...turn,
        items: (turn.items as Array<Record<string, unknown>>).map(item => ({
          ...item,
          agentThreadId: item.agentThreadId === 'solution-thread'
            ? 'risk-thread'
            : item.agentThreadId === 'risk-thread'
              ? 'solution-thread'
              : item.agentThreadId,
        })),
      })
      if (method === 'thread/turns/list') {
        return { ...response, data: (response.data as Array<Record<string, unknown>>).map(swap) }
      }
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: { ...thread, turns: (thread.turns as Array<Record<string, unknown>>).map(swap) },
      }
    }
    await expect(assertNativeAdvisorHistory(activityConflict.options)).rejects.toThrow(
      'changed immutable agent thread',
    )

    const typeConflict = fixture(true, null, false)
    const typeOriginal = typeConflict.options.readForTesting!
    let typeSnapshot = 0
    typeConflict.options.readForTesting = async (method, params) => {
      if (method === 'thread/read' && params.includeTurns === false
        && params.threadId === 'parent-thread') typeSnapshot += 1
      const response = await typeOriginal(method, params)
      const solutionFullView = params.threadId === 'solution-thread'
        && (method === 'thread/turns/list'
          || (method === 'thread/read' && params.includeTurns === true))
      if (!solutionFullView) return response
      const appendChangingItem = (turn: Record<string, unknown>): Record<string, unknown> => ({
        ...turn,
        items: [
          ...(turn.items as unknown[]),
          {
            type: typeSnapshot < 2 ? 'commandExecution' : 'userMessage',
            id: 'stable-unknown-item',
          },
        ],
      })
      if (method === 'thread/turns/list') {
        return {
          ...response,
          data: (response.data as Array<Record<string, unknown>>).map(appendChangingItem),
        }
      }
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: {
          ...thread,
          turns: (thread.turns as Array<Record<string, unknown>>).map(appendChangingItem),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(typeConflict.options)).rejects.toThrow(
      'changed immutable type',
    )
  })

  test('fallbackはagent message raw aliasをimmutable identityとして扱う', async () => {
    const switchAcrossSnapshots = fixture(true, null, false)
    const switchOriginal = switchAcrossSnapshots.options.readForTesting!
    let snapshot = 0
    switchAcrossSnapshots.options.readForTesting = async (method, params) => {
      if (method === 'thread/read' && params.includeTurns === false
        && params.threadId === 'parent-thread') snapshot += 1
      const response = await switchOriginal(method, params)
      const selectedView = snapshot >= 2 && params.threadId === 'solution-thread'
        && (method === 'thread/turns/list'
          || (method === 'thread/read' && params.includeTurns === true))
      if (!selectedView) return response
      const useLegacyAlias = (turn: Record<string, unknown>) => ({
        ...turn,
        items: (turn.items as Array<Record<string, unknown>>).map(item => ({
          ...item, type: item.type === 'agentMessage' ? 'agent_message' : item.type,
        })),
      })
      if (method === 'thread/turns/list') {
        return {
          ...response,
          data: (response.data as Array<Record<string, unknown>>).map(useLegacyAlias),
        }
      }
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: {
          ...thread,
          turns: (thread.turns as Array<Record<string, unknown>>).map(useLegacyAlias),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(switchAcrossSnapshots.options)).rejects.toThrow(
      'changed immutable type',
    )

    const endpointMismatch = fixture(true, null, false)
    const mismatchOriginal = endpointMismatch.options.readForTesting!
    endpointMismatch.options.readForTesting = async (method, params) => {
      const response = await mismatchOriginal(method, params)
      if (method !== 'thread/read' || params.includeTurns !== true
        || params.threadId !== 'solution-thread') return response
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: {
          ...thread,
          turns: (thread.turns as Array<Record<string, unknown>>).map(turn => ({
            ...turn,
            items: (turn.items as Array<Record<string, unknown>>).map(item => ({
              ...item, type: item.type === 'agentMessage' ? 'agent_message' : item.type,
            })),
          })),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(endpointMismatch.options)).rejects.toThrow(
      'changed immutable type',
    )

    const consistentLegacy = fixture(true, null, false)
    const legacyOriginal = consistentLegacy.options.readForTesting!
    consistentLegacy.options.readForTesting = async (method, params) => {
      const response = await legacyOriginal(method, params)
      const selectedView = params.threadId === 'solution-thread'
        && (method === 'thread/turns/list'
          || (method === 'thread/read' && params.includeTurns === true))
      if (!selectedView) return response
      const useLegacyAlias = (turn: Record<string, unknown>) => ({
        ...turn,
        items: (turn.items as Array<Record<string, unknown>>).map(item => ({
          ...item, type: item.type === 'agentMessage' ? 'agent_message' : item.type,
        })),
      })
      if (method === 'thread/turns/list') {
        return {
          ...response,
          data: (response.data as Array<Record<string, unknown>>).map(useLegacyAlias),
        }
      }
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: {
          ...thread,
          turns: (thread.turns as Array<Record<string, unknown>>).map(useLegacyAlias),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(consistentLegacy.options)).resolves.toBeUndefined()
  })

  test('fallbackは同一agent item IDのtext materialization後に固定点へ収束する', async () => {
    const value = fixture(true, null, false)
    const original = value.options.readForTesting!
    let snapshot = 0
    value.options.readForTesting = async (method, params) => {
      if (method === 'thread/read' && params.includeTurns === false
        && params.threadId === 'parent-thread') snapshot += 1
      const response = await original(method, params)
      const solutionFullView = params.threadId === 'solution-thread'
        && (method === 'thread/turns/list'
          || (method === 'thread/read' && params.includeTurns === true))
      if (!solutionFullView || snapshot > 1) return response
      const clearText = (turn: Record<string, unknown>): Record<string, unknown> => ({
        ...turn,
        items: (turn.items as Array<Record<string, unknown>>).map(item => ({
          ...item, text: '',
        })),
      })
      if (method === 'thread/turns/list') {
        return { ...response, data: (response.data as Array<Record<string, unknown>>).map(clearText) }
      }
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: { ...thread, turns: (thread.turns as Array<Record<string, unknown>>).map(clearText) },
      }
    }
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(value.fullThreadReadCalls()).toBe(9)
  })

  test('fallback full viewのraw item shapeと件数上限を強制する', async () => {
    const malformed = fixture(true, null, false)
    const malformedOriginal = malformed.options.readForTesting!
    malformed.options.readForTesting = async (method, params) => {
      const response = await malformedOriginal(method, params)
      if (method !== 'thread/turns/list' || params.threadId !== 'solution-thread') {
        return response
      }
      return {
        ...response,
        data: (response.data as Array<Record<string, unknown>>).map(turn => ({
          ...turn, items: [...(turn.items as unknown[]), null],
        })),
      }
    }
    await expect(assertNativeAdvisorHistory(malformed.options)).rejects.toThrow(
      'contains an invalid raw item',
    )

    const oversized = fixture(true, null, false)
    const oversizedOriginal = oversized.options.readForTesting!
    oversized.options.readForTesting = async (method, params) => {
      const response = await oversizedOriginal(method, params)
      if (method !== 'thread/turns/list' || params.threadId !== 'solution-thread') {
        return response
      }
      return {
        ...response,
        data: (response.data as Array<Record<string, unknown>>).map(turn => ({
          ...turn,
          items: Array.from({ length: 65_537 }, (_, index) => ({
            type: 'commandExecution', id: `irrelevant-${index}`, status: 'completed',
          })),
        })),
      }
    }
    await expect(assertNativeAdvisorHistory(oversized.options)).rejects.toThrow(
      'full item view exceeds the managed raw bound',
    )
  })

  test('fallbackは同一item IDのfinalからcommentaryへの後段変更を隠さない', async () => {
    const value = fixture(true, null, false)
    const original = value.options.readForTesting!
    value.options.readForTesting = async (method, params) => {
      const response = await original(method, params)
      if (method !== 'thread/read' || params.includeTurns !== true
        || params.threadId !== 'solution-thread') return response
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: {
          ...thread,
          turns: (thread.turns as Array<Record<string, unknown>>).map(turn => ({
            ...turn,
            items: (turn.items as Array<Record<string, unknown>>).map(item => ({
              ...item, phase: 'commentary',
            })),
          })),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'changed immutable phase',
    )
  })

  test('fallbackはduplicate turn ID・full-read identity drift・複数finalを拒否する', async () => {
    const duplicate = fixture(true, null, false)
    const duplicateOriginal = duplicate.options.readForTesting!
    duplicate.options.readForTesting = async (method, params) => {
      const response = await duplicateOriginal(method, params)
      if (method !== 'thread/turns/list' || params.threadId !== 'solution-thread') {
        return response
      }
      return { ...response, data: [...(response.data as unknown[]), response.data![0]] }
    }
    await expect(assertNativeAdvisorHistory(duplicate.options)).rejects.toThrow(
      'invalid or duplicated',
    )

    const identity = fixture(true, null, false)
    const identityOriginal = identity.options.readForTesting!
    identity.options.readForTesting = async (method, params) => {
      const response = await identityOriginal(method, params)
      if (method !== 'thread/read' || params.includeTurns !== true
        || params.threadId !== 'solution-thread') return response
      return {
        ...response,
        thread: { ...(response.thread as Record<string, unknown>), agentRole: 'risk_reviewer' },
      }
    }
    await expect(assertNativeAdvisorHistory(identity.options)).rejects.toThrow(
      'full read changed identity',
    )

    const finals = fixture(true, null, false)
    const finalsOriginal = finals.options.readForTesting!
    finals.options.readForTesting = async (method, params) => {
      const response = await finalsOriginal(method, params)
      if (method !== 'thread/read' || params.includeTurns !== true
        || params.threadId !== 'solution-thread') return response
      const thread = response.thread as Record<string, unknown>
      return {
        ...response,
        thread: {
          ...thread,
          turns: (thread.turns as Array<Record<string, unknown>>).map(turn => ({
            ...turn,
            items: [
              ...(turn.items as unknown[]),
              { type: 'agentMessage', id: 'other-final', phase: 'final_answer', text: 'other' },
            ],
          })),
        },
      }
    }
    await expect(assertNativeAdvisorHistory(finals.options)).rejects.toThrow(
      'fallback endpoints disagree on selected evidence',
    )
  })

  test('item paginationの反復cursorと過長cursorを拒否する', async () => {
    const repeated = fixture(true)
    const repeatedOriginal = repeated.options.readForTesting!
    repeated.options.readForTesting = async (method, params) => {
      const response = await repeatedOriginal(method, params)
      if (method !== 'thread/items/list') return response
      return { ...response, nextCursor: 'same-page' }
    }
    await expect(assertNativeAdvisorHistory(repeated.options)).rejects.toThrow(
      'did not advance',
    )

    const oversized = fixture(true)
    const oversizedOriginal = oversized.options.readForTesting!
    oversized.options.readForTesting = async (method, params) => {
      const response = await oversizedOriginal(method, params)
      if (method !== 'thread/items/list') return response
      return { ...response, nextCursor: 'x'.repeat(8_193) }
    }
    await expect(assertNativeAdvisorHistory(oversized.options)).rejects.toThrow(
      'cursor is invalid',
    )
  })

  test('advisor直下のlisted grandchildはitem projectionになくても拒否する', async () => {
    const value = fixture(true)
    const original = value.options.readForTesting!
    value.options.readForTesting = async (method, params) => {
      if (method === 'thread/list' && params.parentThreadId === 'solution-thread') {
        return {
          data: [{ id: 'hidden-grandchild', parentThreadId: 'solution-thread' }],
          nextCursor: null,
        }
      }
      return original(method, params)
    }
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow(
      'delegated to another subagent',
    )
  })

  test('再開前から存在するdirect childはbaselineに限って保持する', async () => {
    const value = fixture(true)
    value.options.parentChildBaseline = ['historical-child']
    const original = value.options.readForTesting!
    value.options.readForTesting = async (method, params) => {
      const response = await original(method, params)
      if (method !== 'thread/list' || params.parentThreadId !== 'parent-thread') return response
      return {
        ...response,
        data: [
          { id: 'historical-child', parentThreadId: 'parent-thread' },
          ...(response.data as unknown[]),
        ],
      }
    }
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
  })

  test('全source kind指定と空pageのpagination拒否を維持する', async () => {
    const value = fixture(true)
    const original = value.options.readForTesting!
    let checked = 0
    value.options.readForTesting = async (method, params) => {
      if (method === 'thread/list') {
        expect(params.sourceKinds).toEqual([
          'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
          'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
        ])
        checked += 1
      }
      return original(method, params)
    }
    await expect(assertNativeAdvisorHistory(value.options)).resolves.toBeUndefined()
    expect(checked).toBe(6)

    const stalled = fixture(true)
    const stalledOriginal = stalled.options.readForTesting!
    stalled.options.readForTesting = async (method, params) => {
      if (method === 'thread/list' && params.parentThreadId === 'parent-thread') {
        return { data: [], nextCursor: 'never-advances' }
      }
      return stalledOriginal(method, params)
    }
    await expect(assertNativeAdvisorHistory(stalled.options)).rejects.toThrow(
      'pagination did not advance',
    )
  })

  test('turns/list未対応時はthread/readへ弱めず公開をfail-closeする', async () => {
    const value = fixture(false)
    await expect(assertNativeAdvisorHistory(value.options)).rejects.toThrow('unsupported')
    expect(value.itemsListCalls()).toBe(0)
  })
})
