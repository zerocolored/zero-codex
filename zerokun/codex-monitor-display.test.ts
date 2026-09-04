import { describe, expect, test } from 'bun:test'
import type { AppServerNotification } from './codex-app-server-session'
import {
  browserScreenshotFromNotification,
  CodexMonitorDisplay,
  parseSlackUpdateCommentary,
  sanitizeMonitorText,
  slackUpdateCommentaryFromNotification,
} from './codex-monitor-display'

function notification(
  method: string,
  params: Record<string, unknown>,
  sequence = 1,
): AppServerNotification {
  return { method, params, sequence }
}

function itemNotification(
  method: 'item/started' | 'item/completed',
  item: Record<string, unknown>,
  threadId = 'root-thread',
): AppServerNotification {
  return notification(method, { threadId, turnId: 'turn-1', item })
}

describe('Codex monitor display', () => {
  test('active root turnのChrome screenshotだけをbounded PNGとして取り出す', () => {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const root = itemNotification('item/completed', {
      id: 'screenshot-1', type: 'mcpToolCall', server: 'go-chrome-mcp',
      tool: 'screenshot', status: 'completed',
      result: { content: [{ type: 'image', mimeType: 'image/png', data }] },
    })
    const image = browserScreenshotFromNotification(root, 'root-thread', 'turn-1')
    expect(image && Buffer.from(image.bytes).toString('base64')).toBe(data)
    expect(image && { width: image.width, height: image.height }).toEqual({ width: 1, height: 1 })
    expect(browserScreenshotFromNotification(root, 'child-thread', 'turn-1')).toBeNull()
    expect(browserScreenshotFromNotification(root, 'root-thread', 'turn-2')).toBeNull()
    expect(browserScreenshotFromNotification(itemNotification('item/completed', {
      ...root.params.item as Record<string, unknown>, server: 'untrusted-browser',
    }), 'root-thread', 'turn-1')).toBeNull()
    expect(browserScreenshotFromNotification(itemNotification('item/completed', {
      ...root.params.item as Record<string, unknown>,
      result: { content: [{ type: 'image', mimeType: 'image/png', data: `${data.slice(0, -1)}!` }] },
    }), 'root-thread', 'turn-1')).toBeNull()
    const builtIn = itemNotification('item/completed', {
      id: 'browser-screenshot-1', type: 'dynamicToolCall', namespace: 'browser',
      tool: 'screenshot', status: 'completed', success: true,
      contentItems: [{ type: 'inputImage', imageUrl: `data:image/png;base64,${data}` }],
    })
    const builtInImage = browserScreenshotFromNotification(
      builtIn,
      'root-thread',
      'turn-1',
    )
    expect(builtInImage && Buffer.from(builtInImage.bytes).toString('base64')).toBe(data)
    expect(browserScreenshotFromNotification(itemNotification('item/completed', {
      ...builtIn.params.item as Record<string, unknown>, namespace: 'third_party',
    }), 'root-thread', 'turn-1')).toBeNull()
  })

  test('root threadの安全な状況だけを追記用文面へ投影する', () => {
    const display = new CodexMonitorDisplay()
    const lines = [
      ...display.observe(notification('turn/started', {
        threadId: 'root-thread',
        turn: { id: 'turn-1', status: 'inProgress' },
      }), 'root-thread'),
      ...display.observe(itemNotification('item/completed', {
        type: 'agentMessage', phase: 'commentary',
        text: '関連ファイルを確認し、次にテストを実行します 🔎',
      }), 'root-thread'),
      ...display.observe(itemNotification('item/started', {
        id: 'command-1', type: 'commandExecution', command: 'bun test', status: 'inProgress',
      }), 'root-thread'),
      ...display.observe(itemNotification('item/completed', {
        id: 'command-1', type: 'commandExecution', command: 'bun test', status: 'completed', exitCode: 0,
      }), 'root-thread'),
      ...display.observe(itemNotification('item/started', {
        id: 'review-1', type: 'subAgentActivity', kind: 'started',
      }), 'root-thread'),
      ...display.observe(itemNotification('item/completed', {
        id: 'review-1', type: 'subAgentActivity', kind: 'completed',
      }), 'root-thread'),
      ...display.observe(itemNotification('item/completed', {
        type: 'agentMessage', phase: 'final_answer', text: '完了しました',
      }), 'root-thread'),
    ]
    expect(lines).toEqual([
      '● 作業を開始しました',
      '💬 関連ファイルを確認し、次にテストを実行します 🔎',
      '› テストを実行しています',
      '✓ テストが完了しました',
      '› 補助レビューを進めています',
      '✓ 補助レビューを確認しました',
      '✓ 回答をまとめました',
    ])
  })

  test('child、progress probe、reasoning、未知eventと生JSONを表示しない', () => {
    const display = new CodexMonitorDisplay()
    display.observe(notification('turn/started', {
      threadId: 'root-thread', turn: { id: 'turn-1', status: 'inProgress' },
    }), 'root-thread')
    expect(display.observe(itemNotification('item/completed', {
      type: 'agentMessage', phase: 'commentary', text: 'childの内部処理',
    }, 'child-thread'), 'root-thread')).toEqual([])
    expect(display.observe(itemNotification('item/completed', {
      type: 'agentMessage', phase: 'commentary',
      text: '[ZERO_PROGRESS_BEGIN:ABC]\n進捗\n[ZERO_PROGRESS_END:ABC]',
    }), 'root-thread')).toEqual([])
    expect(display.observe(itemNotification('item/completed', {
      type: 'reasoning', content: [{ text: '非公開推論' }],
    }), 'root-thread')).toEqual([])
    expect(display.observe(notification('future/event', {
      threadId: 'root-thread', payload: { jsonrpc: '2.0' },
    }), 'root-thread')).toEqual([])
    expect(sanitizeMonitorText('{"jsonrpc":"2.0","id":"secret"}')).toBeNull()
  })

  test('Slack向け節目だけをkind付き完全envelopeから取り出す', () => {
    const plan = [
      '[ZERO_SLACK_UPDATE_BEGIN:PLAN]',
      '原因を特定し、修正方針を確定しました 🔎',
      '[ZERO_SLACK_UPDATE_END:PLAN]',
    ].join('\n')
    expect(parseSlackUpdateCommentary(plan)).toEqual({
      kind: 'PLAN',
      text: '原因を特定し、修正方針を確定しました 🔎',
    })
    expect(parseSlackUpdateCommentary(plan.replaceAll(':PLAN]', ':VERIFY]'))).toEqual({
      kind: 'VERIFY',
      text: '原因を特定し、修正方針を確定しました 🔎',
    })
    expect(parseSlackUpdateCommentary(plan.replace(
      '[ZERO_SLACK_UPDATE_END:PLAN]',
      '[ZERO_SLACK_UPDATE_END:BLOCKED]',
    ))).toBeNull()
    expect(parseSlackUpdateCommentary(`前置き\n${plan}`)).toBeNull()
    expect(parseSlackUpdateCommentary('通常の技術的な実況です')).toBeNull()

    const root = itemNotification('item/completed', {
      type: 'agentMessage', phase: 'commentary', text: plan,
    })
    expect(slackUpdateCommentaryFromNotification(root, 'root-thread')).toEqual({
      kind: 'PLAN',
      text: '原因を特定し、修正方針を確定しました 🔎',
    })
    expect(slackUpdateCommentaryFromNotification(root, 'root-thread', 'turn-1')).toEqual({
      kind: 'PLAN',
      text: '原因を特定し、修正方針を確定しました 🔎',
    })
    expect(slackUpdateCommentaryFromNotification(root, 'root-thread', 'turn-2')).toBeNull()
    expect(slackUpdateCommentaryFromNotification(root, 'child-thread')).toBeNull()
  })

  test('節目markerは監視タブでは外し、通常commentaryも従来どおり表示する', () => {
    const display = new CodexMonitorDisplay()
    display.observe(notification('turn/started', {
      threadId: 'root-thread', turn: { id: 'turn-1', status: 'inProgress' },
    }), 'root-thread')
    expect(display.observe(itemNotification('item/completed', {
      type: 'agentMessage', phase: 'commentary',
      text: '[ZERO_SLACK_UPDATE_BEGIN:VERIFY]\n実装が完了し、検証へ進みます 🧪\n[ZERO_SLACK_UPDATE_END:VERIFY]',
    }), 'root-thread')).toEqual(['💬 実装が完了し、検証へ進みます 🧪'])
    expect(display.observe(itemNotification('item/completed', {
      type: 'agentMessage', phase: 'commentary', text: 'テスト設定を調整しています',
    }), 'root-thread')).toEqual(['💬 テスト設定を調整しています'])
  })

  test('絶対path、URL、ID、terminal制御を除去しcredential含有行は棄却する', () => {
    const safe = sanitizeMonitorText(
      '\u001b[31m/Users/example/project\u001b[0m https://example.test/a '
        + '123e4567-e89b-12d3-a456-426614174000 U0123456789',
    )
    expect(safe).toBe(
      '（内部パスを省略） （URLを省略） （内部IDを省略） （内部IDを省略）',
    )
    expect(sanitizeMonitorText('Authorization: Bearer abcdefghijklmnop')).toBeNull()
    expect(sanitizeMonitorText('token=xoxb-12345678901234567890')).toBeNull()
    expect(sanitizeMonitorText('private_key=not-for-display')).toBeNull()
    for (const value of [
      'cwd=/Users/example/project を確認中',
      '/System/Libraryを確認中',
      '/workspace/projectを確認中',
      '~/private/projectを確認中',
      'file:///Users/example/project/index.html',
      'postgres://user:pass@localhost/database',
    ]) {
      const sanitized = sanitizeMonitorText(value)
      expect(sanitized).not.toBeNull()
      expect(sanitized).not.toContain('/Users')
      expect(sanitized).not.toContain('/System')
      expect(sanitized).not.toContain('/workspace')
      expect(sanitized).not.toContain('~/')
      expect(sanitized).not.toContain('://')
      expect(sanitized).not.toContain('user:pass')
    }
    expect(sanitizeMonitorText('処理結果 {"jsonrpc":"2.0","turnId":"secret"}')).toBeNull()
    expect(sanitizeMonitorText('あ'.repeat(8_193))).toBeNull()
    expect(sanitizeMonitorText('COMPLETED')).toBe('COMPLETED')
  })

  test('同turnで同種コマンドを連打してもカテゴリ表示を増やさない', () => {
    const display = new CodexMonitorDisplay()
    display.observe(notification('turn/started', {
      threadId: 'root-thread', turn: { id: 'turn-1', status: 'inProgress' },
    }), 'root-thread')
    const first = display.observe(itemNotification('item/started', {
      id: 'git-1', type: 'commandExecution', command: 'git status', status: 'inProgress',
    }), 'root-thread')
    const second = display.observe(itemNotification('item/started', {
      id: 'git-2', type: 'commandExecution', command: 'git diff', status: 'inProgress',
    }), 'root-thread')
    expect(first).toEqual(['› Gitの状態を確認しています'])
    expect(second).toEqual([])
  })

  test('同カテゴリの並列commandは全item完了後に一度だけ完了表示する', () => {
    const display = new CodexMonitorDisplay()
    display.observe(notification('turn/started', {
      threadId: 'root-thread', turn: { id: 'turn-1', status: 'inProgress' },
    }), 'root-thread')
    display.observe(itemNotification('item/started', {
      id: 'test-1', type: 'commandExecution', command: 'bun test a', status: 'inProgress',
    }), 'root-thread')
    display.observe(itemNotification('item/started', {
      id: 'test-2', type: 'commandExecution', command: 'bun test b', status: 'inProgress',
    }), 'root-thread')
    expect(display.observe(itemNotification('item/completed', {
      id: 'test-1', type: 'commandExecution', command: 'bun test a',
      status: 'completed', exitCode: 0,
    }), 'root-thread')).toEqual([])
    expect(display.observe(itemNotification('item/completed', {
      id: 'test-2', type: 'commandExecution', command: 'bun test b',
      status: 'completed', exitCode: 0,
    }), 'root-thread')).toEqual(['✓ テストが完了しました'])
  })

  test('前turnの遅延itemと未追跡completionを表示しない', () => {
    const display = new CodexMonitorDisplay()
    display.observe(notification('turn/started', {
      threadId: 'root-thread', turn: { id: 'turn-1', status: 'inProgress' },
    }), 'root-thread')
    display.observe(itemNotification('item/started', {
      id: 'review-old', type: 'subAgentActivity', kind: 'started',
    }), 'root-thread')
    display.observe(notification('turn/started', {
      threadId: 'root-thread', turn: { id: 'turn-2', status: 'inProgress' },
    }), 'root-thread')
    expect(display.observe(notification('item/completed', {
      threadId: 'root-thread', turnId: 'turn-1',
      item: { id: 'review-old', type: 'subAgentActivity', kind: 'completed' },
    }), 'root-thread')).toEqual([])
    expect(display.observe(notification('item/completed', {
      threadId: 'root-thread', turnId: 'turn-2',
      item: {
        id: 'unknown', type: 'commandExecution', command: 'bun test',
        status: 'failed', exitCode: 1,
      },
    }), 'root-thread')).toEqual([])
  })
})
