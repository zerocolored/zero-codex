import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AppServerAmbiguousRequestError,
  CodexAppServerSession,
  appServerFinalMessage,
  parseAppServerSessionSource,
  sameAppServerSessionSource,
} from './codex-app-server-session.ts'

function mockTransport(
  onRequest?: (request: Record<string, unknown>, emit: (value: unknown) => void) => void,
) {
  const encoder = new TextEncoder()
  let output!: ReadableStreamDefaultController<Uint8Array>
  const sent: Record<string, unknown>[] = []
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { output = controller },
  })
  const emit = (value: unknown) => output.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
  const input = {
    closed: false,
    write(line: string) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      sent.push(parsed)
      onRequest?.(parsed, emit)
    },
    end() {
      this.closed = true
      output.close()
    },
  }
  return { input, stream, sent, emit, close: () => output.close() }
}

describe('Codex App Server session', () => {
  test('公式v2 SessionSourceをhandshakeと履歴照合で共通解釈する', () => {
    expect(parseAppServerSessionSource('appServer')).toBe('appServer')
    expect(parseAppServerSessionSource({ custom: 'zerochan' })).toEqual({ custom: 'zerochan' })
    expect(parseAppServerSessionSource({ subAgent: {
      thread_spawn: { parent_thread_id: 'parent-1', depth: 1 },
    } })).toEqual({ subAgent: {
      thread_spawn: { parent_thread_id: 'parent-1', depth: 1 },
    } })
    expect(sameAppServerSessionSource({ custom: 'zerochan' }, { custom: 'zerochan' })).toBe(true)
    expect(() => parseAppServerSessionSource('mcp')).toThrow('session source is invalid')
    expect(() => parseAppServerSessionSource({ subagent: 'review' })).toThrow('session source is invalid')
  })

  test('initializeからturn/steerとterminal結果まで1本のordered writerで扱う', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'zero-app-server-session-'))
    writeFileSync(join(repo, 'AGENTS.md'), '# fixture\n')
    const beforeWrites: number[] = []
    const transport = mockTransport((request, emit) => {
      if (request.method === 'initialized') return
      const id = request.id as number
      if (request.method === 'initialize') emit({ id, result: {
        userAgent: 'test',
        codexHome: '/tmp/codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
      } })
      if (request.method === 'thread/start') {
        emit({ id, result: {
          thread: {
            id: 'thread-1', cwd: repo, source: 'unknown', modelProvider: 'openai',
            status: { type: 'idle' }, canAcceptDirectInput: true,
          },
          model: 'gpt-test',
          modelProvider: 'openai',
          cwd: repo,
          approvalPolicy: 'never',
          activePermissionProfile: { id: 'profile-1', extends: null },
          instructionSources: [join(repo, 'AGENTS.md')],
        } })
      }
      if (request.method === 'turn/start') {
        const turn = { id: 'turn-1', status: 'inProgress', itemsView: 'full', items: [] }
        emit({ id, result: {
          turn,
        } })
        emit({ method: 'turn/started', params: { threadId: 'thread-1', turn } })
      }
      if (request.method === 'turn/steer') emit({ id, result: { turnId: 'turn-1' } })
    })
    try {
      const session = new CodexAppServerSession(transport.input, transport.stream)
      await session.initialize()
      const handshake = await session.startThread({
        cwd: repo, permissions: 'profile-1', approvalPolicy: 'never', model: 'gpt-test',
      })
      const threadId = handshake.threadId
      const turnId = await session.startTurn(threadId, '最初', 'slack-root', {
        cwd: repo,
        permissions: 'profile-1',
        approvalPolicy: 'never',
        model: 'gpt-test',
      })
      await session.steer(threadId, turnId, '追記', 'slack-reply', {
        beforeWrite: id => beforeWrites.push(id),
      })
      transport.emit({
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: turnId,
            status: 'completed',
            itemsView: 'full',
            error: null,
            items: [{ type: 'agentMessage', id: 'item-1', text: '最終回答' }],
          },
        },
      })
      await session.waitForActivity(1)
      const terminal = session.takeTurnTerminal(threadId, turnId)
      expect(terminal?.turn.status).toBe('completed')
      expect(appServerFinalMessage(terminal!.turn)).toBe('最終回答')
      expect(beforeWrites).toEqual([4])
      expect(transport.sent[3]?.params).toMatchObject({
        cwd: repo, permissions: 'profile-1', approvalPolicy: 'never', model: 'gpt-test',
      })
      expect(transport.sent.map(value => value.method)).toEqual([
        'initialize', 'initialized', 'thread/start', 'turn/start', 'turn/steer',
      ])
      session.closeInput()
      await session.waitForReader()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('initialize必須field欠落を通知送信前に拒否する', async () => {
    const transport = mockTransport((request, emit) => {
      if (request.method === 'initialize') emit({ id: request.id, result: { userAgent: 'test' } })
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    await expect(session.initialize()).rejects.toThrow('initialize platformFamily is invalid')
    expect(transport.sent.map(value => value.method)).toEqual(['initialize'])
    session.closeInput()
    await session.waitForReader()
  })

  test('write後にresponseが来なければambiguousとなり自動再送しない', async () => {
    const transport = mockTransport()
    const session = new CodexAppServerSession(transport.input, transport.stream)
    await expect(session.request('turn/steer', {}, { timeoutMs: 5 }))
      .rejects.toBeInstanceOf(AppServerAmbiguousRequestError)
    expect(transport.sent).toHaveLength(1)
    session.closeInput()
    await session.waitForReader()
  })

  test('basenameだけ同じ無関係なAGENTS.mdをproject指示として受理しない', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'zero-app-server-agents-project-'))
    const unrelated = mkdtempSync(join(tmpdir(), 'zero-app-server-agents-unrelated-'))
    writeFileSync(join(repo, 'AGENTS.md'), '# expected project instructions\n')
    writeFileSync(join(unrelated, 'AGENTS.md'), '# unrelated instructions\n')
    const transport = mockTransport((request, emit) => {
      if (request.method !== 'thread/start') return
      emit({ id: request.id, result: {
        thread: {
          id: 'thread-agents', cwd: repo, source: 'unknown', modelProvider: 'openai',
          status: { type: 'idle' }, canAcceptDirectInput: true,
        },
        model: 'gpt-test', modelProvider: 'openai', cwd: repo,
        approvalPolicy: 'never',
        activePermissionProfile: { id: 'profile-1', extends: null },
        instructionSources: [join(unrelated, 'AGENTS.md')],
      } })
    })
    try {
      const session = new CodexAppServerSession(transport.input, transport.stream)
      await expect(session.startThread({
        cwd: repo, permissions: 'profile-1', approvalPolicy: 'never', model: 'gpt-test',
      }, 50)).rejects.toThrow('did not load the requested project AGENTS.md')
      session.closeInput()
      await session.waitForReader()
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(unrelated, { recursive: true, force: true })
    }
  })

  test('thread handshakeがactiveまたはdirect input不可ならturnを開始しない', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'zero-app-server-active-thread-'))
    writeFileSync(join(repo, 'AGENTS.md'), '# fixture\n')
    const transport = mockTransport((request, emit) => {
      if (request.method !== 'thread/start') return
      emit({ id: request.id, result: {
        thread: {
          id: 'thread-active', cwd: repo, source: 'unknown', modelProvider: 'openai',
          status: { type: 'active' }, canAcceptDirectInput: false,
        },
        model: 'gpt-test', modelProvider: 'openai', cwd: repo,
        approvalPolicy: 'never',
        activePermissionProfile: { id: 'profile-1', extends: null },
        instructionSources: [join(repo, 'AGENTS.md')],
      } })
    })
    try {
      const session = new CodexAppServerSession(transport.input, transport.stream)
      await expect(session.startThread({
        cwd: repo, permissions: 'profile-1', approvalPolicy: 'never', model: 'gpt-test',
      }, 50)).rejects.toThrow('did not return an idle thread')
      expect(transport.sent.map(value => value.method)).toEqual(['thread/start'])
      session.closeInput()
      await session.waitForReader()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('turn/start responseだけでcorrelated turn/startedが無ければambiguousにする', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'zero-app-server-missing-started-'))
    writeFileSync(join(repo, 'AGENTS.md'), '# fixture\n')
    const transport = mockTransport((request, emit) => {
      if (request.method === 'thread/start') emit({ id: request.id, result: {
        thread: {
          id: 'thread-1', cwd: repo, source: 'unknown', modelProvider: 'openai',
          status: { type: 'idle' }, canAcceptDirectInput: true,
        },
        model: 'gpt-test', modelProvider: 'openai', cwd: repo,
        approvalPolicy: 'never',
        activePermissionProfile: { id: 'profile-1', extends: null },
        instructionSources: [join(repo, 'AGENTS.md')],
      } })
      if (request.method === 'turn/start') emit({ id: request.id, result: {
        turn: { id: 'turn-1', status: 'inProgress', itemsView: 'full', items: [] },
      } })
    })
    try {
      const session = new CodexAppServerSession(transport.input, transport.stream)
      const thread = await session.startThread({
        cwd: repo, permissions: 'profile-1', approvalPolicy: 'never', model: 'gpt-test',
      }, 50)
      await expect(session.startTurn(thread.threadId, 'task', 'client-id', {
        cwd: repo,
        permissions: 'profile-1',
        approvalPolicy: 'never',
        model: 'gpt-test',
        timeoutMs: 5,
      })).rejects.toBeInstanceOf(AppServerAmbiguousRequestError)
      expect(transport.sent.map(value => value.method)).toEqual(['thread/start', 'turn/start'])
      session.closeInput()
      await session.waitForReader()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('malformedなcorrelated responseでもpending requestを取り残さない', async () => {
    const transport = mockTransport((request, emit) => {
      emit({ id: request.id, error: 'not-an-object' })
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const pending = session.request('turn/steer', {}, { timeoutMs: 100 })
    await expect(pending).rejects.toThrow('App Server turn/steer error is not an object')
    expect(transport.sent).toHaveLength(1)
    transport.close()
    await expect(session.waitForReader()).rejects.toThrow(
      'App Server turn/steer error is not an object',
    )
  })

  test('異なるturnのterminal通知を取り違えない', async () => {
    const transport = mockTransport()
    const session = new CodexAppServerSession(transport.input, transport.stream)
    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-old', status: 'completed', itemsView: 'full', error: null, items: [],
        },
      },
    })
    await session.waitForActivity(1)
    expect(session.takeTurnTerminal('thread-1', 'turn-new')).toBeNull()
    expect(session.takeTurnTerminal('thread-1', 'turn-old')?.turn.id).toBe('turn-old')
    session.closeInput()
    await session.waitForReader()
  })

  test('summary terminalを公式turn paginationから必要な回答だけ復元する', async () => {
    const transport = mockTransport((request, emit) => {
      if (request.method === 'thread/items/list' || request.method === 'thread/read') {
        emit({ id: request.id, error: { code: -32601, message: 'unsupported' } })
        return
      }
      if (request.method !== 'thread/turns/list') return
      const params = request.params as Record<string, unknown>
      if (params.cursor === null) {
        emit({ id: request.id, result: {
          data: [{
            id: 'turn-other', status: 'completed', itemsView: 'full', items: [], error: null,
          }],
          nextCursor: 'page-2', backwardsCursor: null,
        } })
      } else {
        emit({ id: request.id, result: {
          data: [{
            id: 'turn-summary', status: 'completed', itemsView: 'full', error: null,
            items: [{ type: 'agentMessage', id: 'item-agent', text: '復元した回答' }],
          }],
          nextCursor: null, backwardsCursor: null,
        } })
      }
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    transport.emit({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: {
        id: 'turn-summary', status: 'inProgress', itemsView: 'full', items: [], error: null,
      } },
    })
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-summary',
        item: {
          type: 'commandExecution', id: 'item-command', command: '/tmp/probe',
          cwd: '/tmp', source: 'agent', status: 'completed', exitCode: 0,
        },
      },
    })
    await session.waitForActivity(1)
    const full = await session.loadFullTurn('thread-1', {
      id: 'turn-summary', status: 'completed', itemsView: 'summary', items: [], error: null,
    })
    expect(full.itemsView).toBe('full')
    expect(full.items.some(item => item.type === 'commandExecution')).toBe(false)
    expect(appServerFinalMessage(full)).toBe('復元した回答')
    expect(transport.sent.map(value => value.method)).toEqual([
      'thread/items/list', 'thread/turns/list', 'thread/turns/list', 'thread/read',
    ])
    session.closeInput()
    await session.waitForReader()
  })

  test('final message未反映のfull terminalも公式履歴から回答を復元する', async () => {
    const transport = mockTransport((request, emit) => {
      if (request.method === 'thread/turns/list') {
        emit({ id: request.id, result: {
          data: [{
            id: 'turn-early-full', status: 'completed', itemsView: 'full', error: null,
            items: [{
              type: 'agentMessage', id: 'agent-stale', phase: 'commentary',
              text: '履歴の途中稿',
            }],
          }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/items/list') {
        emit({ id: request.id, result: {
          data: [{ turnId: 'turn-early-full', item: {
            type: 'agentMessage', id: 'agent-items-stale', phase: 'commentary',
            text: 'item履歴も途中稿',
          } }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/read') {
        emit({ id: request.id, result: { thread: {
          id: 'thread-early-full',
          turns: [{
            id: 'turn-early-full', status: 'completed', itemsView: 'full', error: null,
            items: [{
              type: 'agentMessage', id: 'agent-final', phase: 'final_answer',
              text: '永続履歴の最終回答',
            }],
          }],
        } } })
      }
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const full = await session.loadFullTurn('thread-early-full', {
      id: 'turn-early-full', status: 'completed', itemsView: 'full', items: [], error: null,
    })
    expect(appServerFinalMessage(full)).toBe('永続履歴の最終回答')
    expect(transport.sent.map(value => value.method)).toEqual([
      'thread/items/list', 'thread/turns/list', 'thread/read',
    ])
    session.closeInput()
    await session.waitForReader()
  })

  test('commentaryだけの履歴を最終Slack回答として採択しない', async () => {
    const transport = mockTransport((request, emit) => {
      if (request.method === 'thread/turns/list') {
        emit({ id: request.id, result: {
          data: [{
            id: 'turn-commentary', status: 'completed', itemsView: 'full', error: null,
            items: [{
              type: 'agentMessage', id: 'commentary-turn', phase: 'commentary',
              text: '確認中です',
            }],
          }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/items/list') {
        emit({ id: request.id, result: {
          data: [{ turnId: 'turn-commentary', item: {
            type: 'agentMessage', id: 'commentary-item', phase: 'commentary',
            text: 'まだ確認中です',
          } }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/read') {
        emit({ id: request.id, error: { code: -32601, message: 'unsupported' } })
      }
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    await expect(session.loadFullTurn('thread-commentary', {
      id: 'turn-commentary', status: 'completed', itemsView: 'summary', items: [], error: null,
    })).rejects.toThrow('did not provide full persisted turn history')
    session.closeInput()
    await session.waitForReader()
  })

  test('turns/listがsummaryまたは未掲載でも次の公式履歴経路へ降りる', async () => {
    const transport = mockTransport((request, emit) => {
      if (request.method === 'thread/turns/list') {
        emit({ id: request.id, result: {
          data: [{
            id: 'turn-fallback', status: 'completed', itemsView: 'summary',
            items: [], error: null,
          }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/items/list') {
        emit({ id: request.id, result: {
          data: [{
            turnId: 'turn-fallback',
            item: { type: 'agentMessage', id: 'agent-fallback', text: '最終fallback回答' },
          }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/read') {
        emit({ id: request.id, error: { code: -32601, message: 'unsupported' } })
      }
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const full = await session.loadFullTurn('thread-fallback', {
      id: 'turn-fallback', status: 'completed', itemsView: 'summary', items: [], error: null,
    })
    expect(appServerFinalMessage(full)).toBe('最終fallback回答')
    expect(transport.sent.map(value => value.method)).toEqual(['thread/items/list'])
    session.closeInput()
    await session.waitForReader()
  })

  test('items/listの完成稿を古いthread snapshotで上書きしない', async () => {
    let threadReadCalls = 0
    const transport = mockTransport((request, emit) => {
      if (request.method === 'thread/turns/list') {
        emit({ id: request.id, result: {
          data: [{
            id: 'turn-journal-final', status: 'completed', itemsView: 'full', error: null,
            items: [{
              type: 'agentMessage', id: 'agent-stable', phase: 'final_answer',
              text: '古いsnapshot',
            }],
          }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/items/list') {
        emit({ id: request.id, result: {
          data: [{ turnId: 'turn-journal-final', item: {
            type: 'agentMessage', id: 'agent-stable', phase: 'final_answer',
            text: '永続journalの完成稿',
          } }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/read') {
        threadReadCalls += 1
        emit({ id: request.id, result: { thread: {
          id: 'thread-journal-final',
          turns: [{
            id: 'turn-journal-final', status: 'completed', itemsView: 'full', error: null,
            items: [{
              type: 'agentMessage', id: 'agent-stable', phase: 'final_answer',
              text: '古いsnapshot',
            }],
          }],
        } } })
      }
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const full = await session.loadFullTurn('thread-journal-final', {
      id: 'turn-journal-final', status: 'completed', itemsView: 'summary',
      items: [], error: null,
    })
    expect(appServerFinalMessage(full)).toBe('永続journalの完成稿')
    expect(threadReadCalls).toBe(0)
    expect(transport.sent.map(value => value.method)).toEqual(['thread/items/list'])
    session.closeInput()
    await session.waitForReader()
  })

  test('完成item journalがあればturn snapshot障害へ依存しない', async () => {
    const transport = mockTransport((request, emit) => {
      if (request.method === 'thread/items/list') {
        emit({ id: request.id, result: {
          data: [{ turnId: 'turn-item-authority', item: {
            type: 'agentMessage', id: 'agent-item-authority', phase: 'final_answer',
            text: 'item journalの完成回答',
          } }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/turns/list') {
        emit({ id: request.id, error: { code: -32000, message: 'stale snapshot failed' } })
      }
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const full = await session.loadFullTurn('thread-item-authority', {
      id: 'turn-item-authority', status: 'completed', itemsView: 'summary',
      items: [], error: null,
    })
    expect(appServerFinalMessage(full)).toBe('item journalの完成回答')
    expect(transport.sent.map(value => value.method)).toEqual(['thread/items/list'])
    session.closeInput()
    await session.waitForReader()
  })

  test('client ID照合はfull terminalで打ち切らずboundedな永続item履歴を使う', async () => {
    const transport = mockTransport((request, emit) => {
      if (request.method !== 'thread/items/list') return
      emit({ id: request.id, result: {
        data: [
          { turnId: 'turn-steer', item: {
            type: 'agentMessage', id: 'agent-before-steer', text: '追記前の回答',
          } },
          { turnId: 'turn-steer', item: {
            type: 'userMessage', id: 'user-steer', clientId: 'slack-reply', content: [],
          } },
          { turnId: 'turn-steer', item: {
            type: 'agentMessage', id: 'agent-steer', text: '追記を反映しました',
          } },
        ],
        nextCursor: null,
      } })
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const full = await session.loadFullTurn('thread-steer', {
      id: 'turn-steer', status: 'completed', itemsView: 'full', error: null,
      items: [{ type: 'agentMessage', id: 'terminal-agent', text: 'terminal fallback' }],
    }, { clientUserMessageId: 'slack-reply' })
    expect(full.items).toEqual([
      { type: 'userMessage', clientId: 'slack-reply' },
      { type: 'agentMessage', id: 'agent-steer', text: '追記を反映しました' },
    ])
    expect(transport.sent.map(value => value.method)).toEqual(['thread/items/list'])
    session.closeInput()
    await session.waitForReader()
  })

  test('client IDより前の旧回答だけならsteer反映済みと判定しない', async () => {
    const officialItems = [
      { type: 'agentMessage', id: 'agent-before-steer', text: '追記前の回答' },
      { type: 'userMessage', id: 'user-steer', clientId: 'slack-reply', content: [] },
    ]
    const transport = mockTransport((request, emit) => {
      if (request.method === 'thread/items/list') {
        emit({ id: request.id, result: {
          data: officialItems.map(item => ({ turnId: 'turn-steer-pending', item })),
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/turns/list') {
        emit({ id: request.id, result: {
          data: [{
            id: 'turn-steer-pending', status: 'completed', itemsView: 'full',
            items: [officialItems[0]], error: null,
          }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/read') {
        emit({ id: request.id, result: { thread: {
          id: 'thread-steer-pending',
          turns: [{
            id: 'turn-steer-pending', status: 'completed', itemsView: 'full',
            items: [officialItems[0]], error: null,
          }],
        } } })
      }
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    await expect(session.loadFullTurn('thread-steer-pending', {
      id: 'turn-steer-pending', status: 'completed', itemsView: 'full', error: null,
      items: [{ type: 'agentMessage', id: 'terminal-old', text: 'terminal旧回答' }],
    }, { clientUserMessageId: 'slack-reply' })).rejects.toThrow(
      'persisted the rejected steer without a following final response',
    )
    expect(transport.sent.map(value => value.method)).toEqual([
      'thread/items/list', 'thread/turns/list', 'thread/read',
    ])
    session.closeInput()
    await session.waitForReader()
  })

  test('turn snapshotで確認したclient IDも後続の古いthread snapshotで打ち消さない', async () => {
    const oldAgent = { type: 'agentMessage', id: 'agent-before-steer', text: '追記前の回答' }
    const matchingUser = {
      type: 'userMessage', id: 'user-steer', clientId: 'slack-reply', content: [],
    }
    const transport = mockTransport((request, emit) => {
      if (request.method === 'thread/items/list') {
        emit({ id: request.id, result: {
          data: [{ turnId: 'turn-steer-turn-evidence', item: oldAgent }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/turns/list') {
        emit({ id: request.id, result: {
          data: [{
            id: 'turn-steer-turn-evidence', status: 'completed', itemsView: 'full',
            items: [oldAgent, matchingUser], error: null,
          }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/read') {
        emit({ id: request.id, result: { thread: {
          id: 'thread-steer-turn-evidence',
          turns: [{
            id: 'turn-steer-turn-evidence', status: 'completed', itemsView: 'full',
            items: [oldAgent], error: null,
          }],
        } } })
      }
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    await expect(session.loadFullTurn('thread-steer-turn-evidence', {
      id: 'turn-steer-turn-evidence', status: 'completed', itemsView: 'full', error: null,
      items: [{ type: 'agentMessage', id: 'terminal-old', text: 'terminal旧回答' }],
    }, { clientUserMessageId: 'slack-reply' })).rejects.toThrow(
      'persisted the rejected steer without a following final response',
    )
    expect(transport.sent.map(value => value.method)).toEqual([
      'thread/items/list', 'thread/turns/list', 'thread/read',
    ])
    session.closeInput()
    await session.waitForReader()
  })

  test('client userと追記後finalが別item pageでも原順序で照合する', async () => {
    const transport = mockTransport((request, emit) => {
      if (request.method !== 'thread/items/list') return
      const cursor = (request.params as Record<string, unknown>).cursor
      if (cursor === null) {
        emit({ id: request.id, result: {
          data: [
            { turnId: 'turn-steer-pages', item: {
              type: 'agentMessage', id: 'agent-old', text: '追記前の回答',
            } },
            { turnId: 'turn-steer-pages', item: {
              type: 'userMessage', id: 'user-steer', clientId: 'slack-reply', content: [],
            } },
          ],
          nextCursor: 'page-2',
        } })
        return
      }
      emit({ id: request.id, result: {
        data: [{ turnId: 'turn-steer-pages', item: {
          type: 'agentMessage', id: 'agent-current', text: '追記後の回答',
        } }],
        nextCursor: null,
      } })
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const full = await session.loadFullTurn('thread-steer-pages', {
      id: 'turn-steer-pages', status: 'completed', itemsView: 'full', error: null,
      items: [{ type: 'agentMessage', id: 'terminal-old', text: 'terminal旧回答' }],
    }, { clientUserMessageId: 'slack-reply' })
    expect(full.items).toEqual([
      { type: 'userMessage', clientId: 'slack-reply' },
      { type: 'agentMessage', id: 'agent-current', text: '追記後の回答' },
    ])
    expect(transport.sent.map(value => value.method)).toEqual([
      'thread/items/list', 'thread/items/list',
    ])
    session.closeInput()
    await session.waitForReader()
  })

  test('item pagination未対応時だけturn paginationからclient IDを照合する', async () => {
    const transport = mockTransport((request, emit) => {
      if (request.method === 'thread/items/list') {
        emit({ id: request.id, error: { code: -32601, message: 'not supported yet' } })
        return
      }
      if (request.method === 'thread/turns/list') {
        emit({ id: request.id, result: {
          data: [{
            id: 'turn-steer-fallback', status: 'completed', itemsView: 'full', error: null,
            items: [
              { type: 'userMessage', id: 'user-steer', clientId: 'slack-reply', content: [] },
              { type: 'agentMessage', id: 'agent-steer', text: 'fallbackで照合' },
            ],
          }],
          nextCursor: null,
        } })
      }
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const full = await session.loadFullTurn('thread-steer-fallback', {
      id: 'turn-steer-fallback', status: 'completed', itemsView: 'full', error: null,
      items: [{ type: 'agentMessage', id: 'terminal-agent', text: 'terminal fallback' }],
    }, { clientUserMessageId: 'slack-reply' })
    expect(full.items[0]).toMatchObject({ type: 'userMessage', clientId: 'slack-reply' })
    expect(transport.sent.map(value => value.method)).toEqual([
      'thread/items/list', 'thread/turns/list',
    ])
    session.closeInput()
    await session.waitForReader()
  })

  test('turn paginationがfullでもclient ID未反映ならthread/readまで照合する', async () => {
    const transport = mockTransport((request, emit) => {
      if (request.method === 'thread/items/list') {
        emit({ id: request.id, result: {
          data: [{ turnId: 'turn-steer-read', item: {
            type: 'userMessage', id: 'user-steer', clientId: 'slack-reply', content: [],
          } }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/turns/list') {
        emit({ id: request.id, result: {
          data: [{
            id: 'turn-steer-read', status: 'completed', itemsView: 'full', error: null,
            items: [
              { type: 'agentMessage', id: 'agent-stale', text: 'まだ反映前' },
              { type: 'userMessage', id: 'user-steer', clientId: 'slack-reply', content: [] },
            ],
          }],
          nextCursor: null,
        } })
        return
      }
      if (request.method === 'thread/read') {
        emit({ id: request.id, result: { thread: {
          id: 'thread-steer-read',
          turns: [{
            id: 'turn-steer-read', status: 'completed', itemsView: 'full', error: null,
            items: [
              { type: 'userMessage', id: 'user-steer', clientId: 'slack-reply', content: [] },
              { type: 'agentMessage', id: 'agent-current', text: 'thread/readで照合' },
            ],
          }],
        } } })
      }
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const full = await session.loadFullTurn('thread-steer-read', {
      id: 'turn-steer-read', status: 'completed', itemsView: 'full', error: null,
      items: [{ type: 'agentMessage', id: 'terminal-agent', text: 'terminal fallback' }],
    }, { clientUserMessageId: 'slack-reply' })
    expect(full.items).toEqual([
      { type: 'userMessage', clientId: 'slack-reply' },
      { type: 'agentMessage', id: 'agent-current', text: 'thread/readで照合' },
    ])
    expect(transport.sent.map(value => value.method)).toEqual([
      'thread/items/list', 'thread/turns/list', 'thread/read',
    ])
    session.closeInput()
    await session.waitForReader()
  })

  test('4096件を超えるitem/completedを保持せず最終回答を受け取る', async () => {
    const transport = mockTransport()
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const started = {
      id: 'turn-long', status: 'inProgress', itemsView: 'summary', items: [], error: null,
    }
    transport.emit({
      method: 'turn/started',
      params: { threadId: 'thread-long', turn: started },
    })
    for (let index = 0; index < 4_200; index += 1) {
      transport.emit({
        method: 'item/completed',
        params: {
          threadId: 'thread-long',
          turnId: 'turn-long',
          item: { type: 'commandExecution', id: `command-${index}`, status: 'completed' },
        },
      })
    }
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-long',
        turnId: 'turn-long',
        item: { type: 'agentMessage', id: 'agent-final', text: '長い処理の最終回答' },
      },
    })
    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-long',
        turn: {
          id: 'turn-long', status: 'completed', itemsView: 'summary', items: [], error: null,
        },
      },
    })
    session.closeInput()
    await session.waitForReader()
    const terminal = session.takeTurnTerminal('thread-long', 'turn-long')
    expect(terminal?.turn.items).toHaveLength(1)
    expect(appServerFinalMessage(terminal!.turn)).toBe('長い処理の最終回答')
  })

  test('streamとfull terminalに再掲されたcommandを二重計数しない', async () => {
    const transport = mockTransport()
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const command = {
      type: 'commandExecution', id: 'command-1', command: '/tmp/probe', cwd: '/tmp',
      source: 'agent', status: 'completed', exitCode: 0,
    }
    transport.emit({
      method: 'turn/started',
      params: { threadId: 'thread-command', turn: {
        id: 'turn-command', status: 'inProgress', itemsView: 'full', items: [], error: null,
      } },
    })
    transport.emit({
      method: 'item/completed',
      params: { threadId: 'thread-command', turnId: 'turn-command', item: command },
    })
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-command', turn: {
        id: 'turn-command', status: 'completed', itemsView: 'full', error: null,
        items: [command, { type: 'agentMessage', text: '完了' }],
      } },
    })
    session.closeInput()
    await session.waitForReader()
    const terminal = session.takeTurnTerminal('thread-command', 'turn-command')
    expect(terminal?.permissionEvidence.commandCount).toBe(1)
    expect(terminal?.permissionEvidence.firstCommand?.command).toBe('/tmp/probe')
  })

  test('4096件を超える公式item paginationを上限エラーなしで投影する', async () => {
    let itemPages = 0
    const transport = mockTransport((request, emit) => {
      const method = request.method
      if (method === 'thread/turns/list' || method === 'thread/read') {
        emit({ id: request.id, error: { code: -32601, message: 'unsupported' } })
        return
      }
      if (method !== 'thread/items/list') return
      const params = request.params as Record<string, unknown>
      const page = params.cursor === null ? 0 : Number(params.cursor)
      itemPages += 1
      const data = Array.from({ length: 100 }, (_, offset) => ({
        turnId: 'turn-paged',
        item: {
          type: 'commandExecution',
          id: `command-${page * 100 + offset}`,
          status: 'completed',
        },
      }))
      if (page === 41) {
        data.push({
          turnId: 'turn-paged',
          item: { type: 'agentMessage', id: 'agent-paged', text: 'ページ復元した回答' },
        })
      }
      emit({ id: request.id, result: {
        data,
        nextCursor: page === 41 ? null : String(page + 1),
      } })
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const full = await session.loadFullTurn('thread-paged', {
      id: 'turn-paged', status: 'completed', itemsView: 'summary', items: [], error: null,
    })
    expect(itemPages).toBe(42)
    expect(full.items).toHaveLength(1)
    expect(appServerFinalMessage(full)).toBe('ページ復元した回答')
    session.closeInput()
    await session.waitForReader()
  })

  test('streamとterminalの非対称permission evidenceを保守的に統合する', async () => {
    const transport = mockTransport()
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const started = (turnId: string) => transport.emit({
      method: 'turn/started',
      params: { threadId: 'thread-union', turn: {
        id: turnId, status: 'inProgress', itemsView: 'full', items: [], error: null,
      } },
    })
    const completedItem = (turnId: string, item: Record<string, unknown>) => transport.emit({
      method: 'item/completed', params: { threadId: 'thread-union', turnId, item },
    })
    const completed = (turnId: string, items: Array<Record<string, unknown>>) => transport.emit({
      method: 'turn/completed', params: { threadId: 'thread-union', turn: {
        id: turnId, status: 'completed', itemsView: 'full', items, error: null,
      } },
    })

    started('turn-stream-only')
    completedItem('turn-stream-only', {
      type: 'commandExecution', id: 'command-stream', command: '/tmp/probe', cwd: '/tmp',
      source: 'agent', status: 'completed', exitCode: 0,
    })
    completedItem('turn-stream-only', { type: 'mcpToolCall', id: 'unexpected-stream' })
    completed('turn-stream-only', [{ type: 'agentMessage', text: '完了' }])

    started('turn-distinct')
    completedItem('turn-distinct', {
      type: 'commandExecution', id: 'command-a', command: '/tmp/probe', cwd: '/tmp',
      source: 'agent', status: 'completed', exitCode: 0,
    })
    completed('turn-distinct', [{
      type: 'commandExecution', id: 'command-b', command: '/tmp/probe', cwd: '/tmp',
      source: 'agent', status: 'completed', exitCode: 0,
    }])

    session.closeInput()
    await session.waitForReader()
    const streamOnly = session.takeTurnTerminal('thread-union', 'turn-stream-only')!
    expect(streamOnly.permissionEvidence.commandCount).toBe(1)
    expect(streamOnly.permissionEvidence.firstCommand?.itemId).toBe('command-stream')
    expect(streamOnly.permissionEvidence.unexpectedItemType).toBe('mcpToolCall')
    const distinct = session.takeTurnTerminal('thread-union', 'turn-distinct')!
    expect(distinct.permissionEvidence.commandCount).toBe(2)
  })

  test('item/completedの先行と重複turn/startedをprotocol違反にする', async () => {
    const beforeStarted = mockTransport()
    const first = new CodexAppServerSession(beforeStarted.input, beforeStarted.stream)
    beforeStarted.emit({
      method: 'item/completed',
      params: { threadId: 'thread-order', turnId: 'turn-order', item: { type: 'reasoning' } },
    })
    beforeStarted.close()
    await expect(first.waitForReader()).rejects.toThrow('before turn/started')

    const duplicate = mockTransport()
    const second = new CodexAppServerSession(duplicate.input, duplicate.stream)
    const started = {
      method: 'turn/started',
      params: { threadId: 'thread-duplicate', turn: {
        id: 'turn-duplicate', status: 'inProgress', itemsView: 'full', items: [], error: null,
      } },
    }
    duplicate.emit(started)
    duplicate.emit(started)
    duplicate.close()
    await expect(second.waitForReader()).rejects.toThrow('repeated turn/started')
  })

  test('terminal後はstarted済みのversion互換subAgentActivityだけを遅延完了として許可する', async () => {
    const transport = mockTransport()
    const session = new CodexAppServerSession(transport.input, transport.stream)
    transport.emit({
      method: 'turn/started',
      params: { threadId: 'thread-late-child', turn: {
        id: 'turn-parent', status: 'inProgress', itemsView: 'full', items: [], error: null,
      } },
    })
    transport.emit({
      method: 'item/started',
      params: { threadId: 'thread-late-child', turnId: 'turn-parent', item: {
        type: 'subAgentActivity', id: 'child-finished', kind: 'started',
        agentThreadId: 'thread-child', agentPath: '/root/child',
      } },
    })
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-late-child', turn: {
        id: 'turn-parent', status: 'completed', itemsView: 'full', error: null,
        items: [{ type: 'agentMessage', id: 'agent-parent', text: '親は完了' }],
      } },
    })
    let parentTerminal = session.takeTurnTerminal('thread-late-child', 'turn-parent')
    while (!parentTerminal) {
      await session.waitForActivity(1)
      parentTerminal = session.takeTurnTerminal('thread-late-child', 'turn-parent')
    }
    expect(parentTerminal).not.toBeNull()
    transport.emit({
      method: 'item/completed',
      params: { threadId: 'thread-late-child', turnId: 'turn-parent', item: {
        type: 'subAgentActivity', id: 'child-finished', kind: 'completed',
        agentThreadId: 'thread-child', agentPath: '/root/child',
      } },
    })
    transport.emit({ method: 'turn/started', params: { threadId: 'thread-late-child', turn: {
      id: 'turn-interrupted-child', status: 'inProgress', itemsView: 'full', items: [], error: null,
    } } })
    transport.emit({ method: 'item/started', params: {
      threadId: 'thread-late-child', turnId: 'turn-interrupted-child', item: {
        type: 'subAgentActivity', id: 'child-interrupted', kind: 'interrupted',
        agentThreadId: 'thread-interrupted', agentPath: '/root/interrupted',
      },
    } })
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-late-child', turn: {
      id: 'turn-interrupted-child', status: 'completed', itemsView: 'full', items: [], error: null,
    } } })
    let interruptedTerminal = session.takeTurnTerminal(
      'thread-late-child', 'turn-interrupted-child',
    )
    while (!interruptedTerminal) {
      await session.waitForActivity(1)
      interruptedTerminal = session.takeTurnTerminal(
        'thread-late-child', 'turn-interrupted-child',
      )
    }
    transport.emit({ method: 'item/completed', params: {
      threadId: 'thread-late-child', turnId: 'turn-interrupted-child', item: {
        type: 'subAgentActivity', id: 'child-interrupted', kind: 'interrupted',
        agentThreadId: 'thread-interrupted', agentPath: '/root/interrupted',
      },
    } })
    session.closeInput()
    await session.waitForReader()
  })

  test('terminal後の通常itemとstarted無しのsubAgentActivityは拒否する', async () => {
    const lateCommand = mockTransport()
    const first = new CodexAppServerSession(lateCommand.input, lateCommand.stream)
    lateCommand.emit({ method: 'turn/started', params: { threadId: 'thread-late', turn: {
      id: 'turn-late', status: 'inProgress', itemsView: 'full', items: [], error: null,
    } } })
    lateCommand.emit({ method: 'turn/completed', params: { threadId: 'thread-late', turn: {
      id: 'turn-late', status: 'completed', itemsView: 'full', items: [], error: null,
    } } })
    await first.waitForActivity(1)
    expect(first.takeTurnTerminal('thread-late', 'turn-late')).not.toBeNull()
    lateCommand.emit({ method: 'item/completed', params: {
      threadId: 'thread-late', turnId: 'turn-late',
      item: { type: 'commandExecution', id: 'late-command' },
    } })
    lateCommand.close()
    await expect(first.waitForReader()).rejects.toThrow('before turn/started')

    const missingStarted = mockTransport()
    const second = new CodexAppServerSession(missingStarted.input, missingStarted.stream)
    missingStarted.emit({ method: 'item/completed', params: {
      threadId: 'thread-missing', turnId: 'turn-missing', item: {
        type: 'subAgentActivity', id: 'child-finished', kind: 'completed',
      },
    } })
    missingStarted.close()
    await expect(second.waitForReader()).rejects.toThrow('before turn/started')
  })

  test('遅延subAgentActivityは65turn超でもstarted済みの同一identityだけを許可する', async () => {
    const transport = mockTransport()
    const session = new CodexAppServerSession(transport.input, transport.stream)
    transport.emit({ method: 'turn/started', params: { threadId: 'thread-bounded', turn: {
      id: 'turn-0', status: 'inProgress', itemsView: 'full', items: [], error: null,
    } } })
    transport.emit({ method: 'item/started', params: {
      threadId: 'thread-bounded', turnId: 'turn-0', item: {
        type: 'subAgentActivity', id: 'old-child', kind: 'started',
      },
    } })
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-bounded', turn: {
      id: 'turn-0', status: 'completed', itemsView: 'full', items: [], error: null,
    } } })
    let oldestTerminal = session.takeTurnTerminal('thread-bounded', 'turn-0')
    while (!oldestTerminal) {
      await session.waitForActivity(1)
      oldestTerminal = session.takeTurnTerminal('thread-bounded', 'turn-0')
    }
    expect(oldestTerminal).not.toBeNull()

    for (let index = 1; index <= 65; index += 1) {
      const turnId = `turn-${index}`
      transport.emit({ method: 'turn/started', params: { threadId: 'thread-bounded', turn: {
        id: turnId, status: 'inProgress', itemsView: 'full', items: [], error: null,
      } } })
      transport.emit({ method: 'turn/completed', params: { threadId: 'thread-bounded', turn: {
        id: turnId, status: 'completed', itemsView: 'full', items: [], error: null,
      } } })
      await session.waitForActivity(1)
      expect(session.takeTurnTerminal('thread-bounded', turnId)).not.toBeNull()
    }
    transport.emit({ method: 'item/completed', params: {
      threadId: 'thread-bounded', turnId: 'turn-0', item: {
        type: 'subAgentActivity', id: 'old-child', kind: 'completed',
      },
    } })
    transport.close()
    await session.waitForReader()
  })

  test('完了済み子turnを16件超処理してもactive projection枠を消費し続けない', async () => {
    const transport = mockTransport()
    const session = new CodexAppServerSession(transport.input, transport.stream)
    for (let index = 0; index < 17; index += 1) {
      const turnId = `child-turn-${index}`
      transport.emit({ method: 'turn/started', params: { threadId: `child-thread-${index}`, turn: {
        id: turnId, status: 'inProgress', itemsView: 'full', items: [], error: null,
      } } })
      transport.emit({ method: 'turn/completed', params: {
        threadId: `child-thread-${index}`, turn: {
          id: turnId, status: 'completed', itemsView: 'full', items: [], error: null,
        },
      } })
    }
    transport.close()
    await session.waitForReader()
    for (let index = 0; index < 17; index += 1) {
      expect(session.takeTurnTerminal(`child-thread-${index}`, `child-turn-${index}`)).not.toBeNull()
    }

    const concurrent = mockTransport()
    const overflow = new CodexAppServerSession(concurrent.input, concurrent.stream)
    for (let index = 0; index < 17; index += 1) {
      concurrent.emit({ method: 'turn/started', params: {
        threadId: `active-thread-${index}`, turn: {
          id: `active-turn-${index}`, status: 'inProgress', itemsView: 'full', items: [], error: null,
        },
      } })
    }
    concurrent.close()
    await expect(overflow.waitForReader()).rejects.toThrow('too many concurrent turn projections')
  })

  test('production parentは2050件超の完了済みchild control通知を累積しない', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'zero-app-server-child-churn-'))
    writeFileSync(join(repo, 'AGENTS.md'), '# fixture\n')
    const transport = mockTransport((request, emit) => {
      if (request.method !== 'thread/start') return
      emit({ id: request.id, result: {
        thread: {
          id: 'root-thread', cwd: repo, source: 'unknown', modelProvider: 'openai',
          status: { type: 'idle' }, canAcceptDirectInput: true,
        },
        model: 'gpt-test', modelProvider: 'openai', cwd: repo,
        approvalPolicy: 'never',
        activePermissionProfile: { id: 'profile-1', extends: null },
        instructionSources: [join(repo, 'AGENTS.md')],
      } })
    })
    try {
      const session = new CodexAppServerSession(transport.input, transport.stream)
      await session.startThread({
        cwd: repo, permissions: 'profile-1', approvalPolicy: 'never', model: 'gpt-test',
      })
      transport.emit({ method: 'turn/started', params: { threadId: 'root-thread', turn: {
        id: 'root-turn', status: 'inProgress', itemsView: 'full', items: [], error: null,
      } } })
      for (let index = 0; index < 2_100; index += 1) {
        const threadId = `child-thread-${index}`
        const turnId = `child-turn-${index}`
        transport.emit({ method: 'turn/started', params: { threadId, turn: {
          id: turnId, status: 'inProgress', itemsView: 'full', items: [], error: null,
        } } })
        transport.emit({ method: 'error', params: {
          threadId, turnId, willRetry: true,
          error: {
            message: 'child retry', codexErrorInfo: null, additionalDetails: null,
          },
        } })
        if (index === 0) {
          transport.emit({ method: 'item/started', params: { threadId, turnId, item: {
            type: 'subAgentActivity', id: 'nested-activity', kind: 'started',
            agentThreadId: 'nested-thread', agentPath: '/root/nested',
          } } })
        }
        transport.emit({ method: 'turn/completed', params: { threadId, turn: {
          id: turnId, status: 'completed', itemsView: 'full', items: [], error: null,
        } } })
        if (index === 0) {
          transport.emit({ method: 'item/completed', params: { threadId, turnId, item: {
            type: 'subAgentActivity', id: 'nested-activity', kind: 'interrupted',
            agentThreadId: 'nested-thread', agentPath: '/root/nested',
          } } })
        }
      }
      transport.emit({ method: 'error', params: {
        threadId: 'root-thread', turnId: 'root-turn', willRetry: true,
        error: {
          message: 'root retry', codexErrorInfo: null, additionalDetails: null,
        },
      } })
      transport.emit({ method: 'turn/completed', params: { threadId: 'root-thread', turn: {
        id: 'root-turn', status: 'completed', itemsView: 'full', error: null,
        items: [{ type: 'agentMessage', id: 'root-answer', text: '長時間job完了' }],
      } } })
      transport.close()
      await session.waitForReader()
      const terminal = session.takeTurnTerminal('root-thread', 'root-turn')
      expect(terminal).not.toBeNull()
      expect(appServerFinalMessage(terminal!.turn)).toBe('長時間job完了')
      expect(session.takeError()).toMatchObject({
        threadId: 'root-thread', turnId: 'root-turn', willRetry: true,
      })
      expect(session.takeError()).toBeNull()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('turn/completed受信時に結果をsealし後続itemで書き換えない', async () => {
    const transport = mockTransport()
    const session = new CodexAppServerSession(transport.input, transport.stream)
    transport.emit({ method: 'turn/started', params: { threadId: 'thread-seal', turn: {
      id: 'turn-seal', status: 'inProgress', itemsView: 'full', items: [], error: null,
    } } })
    transport.emit({ method: 'item/completed', params: {
      threadId: 'thread-seal', turnId: 'turn-seal',
      item: { type: 'agentMessage', id: 'before-terminal', text: '確定した回答' },
    } })
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-seal', turn: {
      id: 'turn-seal', status: 'completed', itemsView: 'summary', items: [], error: null,
    } } })
    transport.emit({ method: 'item/completed', params: {
      threadId: 'thread-seal', turnId: 'turn-seal',
      item: { type: 'agentMessage', id: 'after-terminal', text: '書き換えられてはいけない回答' },
    } })
    transport.close()
    await expect(session.waitForReader()).rejects.toThrow('before turn/started')
    const terminal = session.takeTurnTerminal('thread-seal', 'turn-seal')
    expect(terminal).not.toBeNull()
    expect(appServerFinalMessage(terminal!.turn)).toBe('確定した回答')
  })

  test('4200件超の公式履歴からpermission evidenceだけをbounded集計する', async () => {
    let pages = 0
    const transport = mockTransport((request, emit) => {
      if (request.method !== 'thread/items/list') return
      const params = request.params as Record<string, unknown>
      const page = params.cursor === null ? 0 : Number(params.cursor)
      pages += 1
      const data = Array.from({ length: 100 }, (_, offset) => ({
        turnId: 'turn-evidence',
        item: { type: offset % 2 === 0 ? 'reasoning' : 'plan', id: `${page}-${offset}` },
      }))
      if (page === 20) {
        data[50] = {
          turnId: 'turn-evidence',
          item: {
            type: 'commandExecution',
            id: 'permission-command',
            command: '/tmp/permission-probe',
            cwd: '/tmp',
            source: 'agent',
            status: 'completed',
            exitCode: 0,
          },
        }
      }
      emit({ id: request.id, result: {
        data,
        nextCursor: page === 41 ? null : String(page + 1),
      } })
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const evidence = await session.loadPermissionProbeEvidence(
      'thread-evidence', 'turn-evidence',
    )
    expect(pages).toBe(42)
    expect(evidence).toEqual({
      commandCount: 1,
      firstCommand: {
        itemId: 'permission-command',
        command: '/tmp/permission-probe',
        cwd: '/tmp',
        source: 'agent',
        status: 'completed',
        exitCode: 0,
      },
      unexpectedItemSeen: false,
      unexpectedItemType: null,
    })
    session.closeInput()
    await session.waitForReader()
  })

  test('permission evidenceは複数commandと未知itemを飽和集計する', async () => {
    const transport = mockTransport((request, emit) => {
      if (request.method !== 'thread/items/list') return
      emit({ id: request.id, result: {
        data: [
          { turnId: 'turn-multiple', item: {
            type: 'commandExecution', command: '/tmp/first', cwd: '/tmp',
            source: 'agent', status: 'completed', exitCode: 0,
          } },
          { turnId: 'turn-multiple', item: {
            type: 'commandExecution', command: '/tmp/second', cwd: '/tmp',
            source: 'agent', status: 'completed', exitCode: 0,
          } },
          { turnId: 'turn-multiple', item: { type: 'mcpToolCall' } },
        ],
        nextCursor: null,
      } })
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    const evidence = await session.loadPermissionProbeEvidence(
      'thread-multiple', 'turn-multiple',
    )
    expect(evidence.commandCount).toBe(2)
    expect(evidence.firstCommand?.command).toBe('/tmp/first')
    expect(evidence.unexpectedItemSeen).toBe(true)
    expect(evidence.unexpectedItemType).toBe('mcpToolCall')
    session.closeInput()
    await session.waitForReader()
  })

  test('permission evidenceは別turnとcursor循環をfail-closeする', async () => {
    const transport = mockTransport((request, emit) => {
      if (request.method !== 'thread/items/list') return
      const params = request.params as Record<string, unknown>
      if (params.turnId === 'turn-wrong') {
        emit({ id: request.id, result: {
          data: [{ turnId: 'turn-other', item: { type: 'reasoning' } }],
          nextCursor: null,
        } })
        return
      }
      emit({ id: request.id, result: {
        data: [],
        nextCursor: 'same-cursor',
      } })
    })
    const session = new CodexAppServerSession(transport.input, transport.stream)
    await expect(session.loadPermissionProbeEvidence('thread-1', 'turn-wrong'))
      .rejects.toThrow('returned an item from another turn')
    await expect(session.loadPermissionProbeEvidence('thread-1', 'turn-cycle'))
      .rejects.toThrow('cursor is invalid')
    session.closeInput()
    await session.waitForReader()
  })
})
