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

  test('official Node REPL image output accepts JPEG with bounded frame dimensions', () => {
    const data = '/9j/4AAQSkZJRgABAQAASABIAAD/4QBARXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/+IRrElDQ19QUk9GSUxFAAEBAAARnGFwcGwCAAAAbW50ckdSQVlYWVogB9wACAAXAA8ALgAPYWNzcEFQUEwAAAAAbm9uZQAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1hcHBsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFZGVzYwAAAMAAAAB5ZHNjbQAAATwAAAgaY3BydAAACVgAAAAjd3RwdAAACXwAAAAUa1RSQwAACZAAAAgMZGVzYwAAAAAAAAAfR2VuZXJpYyBHcmF5IEdhbW1hIDIuMiBQcm9maWxlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG1sdWMAAAAAAAAAHwAAAAxza1NLAAAALgAAAYRkYURLAAAAOgAAAbJjYUVTAAAAOAAAAex2aVZOAAAAQAAAAiRwdEJSAAAASgAAAmR1a1VBAAAALAAAAq5mckZVAAAAPgAAAtpodUhVAAAANAAAAxh6aFRXAAAAGgAAA0xrb0tSAAAAIgAAA2ZuYk5PAAAAOgAAA4hjc0NaAAAAKAAAA8JoZUlMAAAAJAAAA+pyb1JPAAAAKgAABA5kZURFAAAATgAABDhpdElUAAAATgAABIZzdlNFAAAAOAAABNR6aENOAAAAGgAABQxqYUpQAAAAJgAABSZlbEdSAAAAKgAABUxwdFBPAAAAUgAABXZubE5MAAAAQAAABchlc0VTAAAATAAABgh0aFRIAAAAMgAABlR0clRSAAAAJAAABoZmaUZJAAAARgAABqpockhSAAAAPgAABvBwbFBMAAAASgAABy5hckVHAAAALAAAB3hydVJVAAAAOgAAB6RlblVTAAAAPAAAB94AVgFhAGUAbwBiAGUAYwBuAOEAIABzAGkAdgDhACAAZwBhAG0AYQAgADIALAAyAEcAZQBuAGUAcgBpAHMAawAgAGcAcgDlACAAMgAsADIAIABnAGEAbQBtAGEALQBwAHIAbwBmAGkAbABHAGEAbQBtAGEAIABkAGUAIABnAHIAaQBzAG8AcwAgAGcAZQBuAOgAcgBpAGMAYQAgADIALgAyAEMepQB1ACAAaADsAG4AaAAgAE0A4AB1ACAAeADhAG0AIABDAGgAdQBuAGcAIABHAGEAbQBtAGEAIAAyAC4AMgBQAGUAcgBmAGkAbAAgAEcAZQBuAOkAcgBpAGMAbwAgAGQAYQAgAEcAYQBtAGEAIABkAGUAIABDAGkAbgB6AGEAcwAgADIALAAyBBcEMAQzBDAEOwRMBD0EMAAgAEcAcgBhAHkALQQzBDAEPAQwACAAMgAuADIAUAByAG8AZgBpAGwAIABnAOkAbgDpAHIAaQBxAHUAZQAgAGcAcgBpAHMAIABnAGEAbQBtAGEAIAAyACwAMgDBAGwAdABhAGwA4QBuAG8AcwAgAHMAegD8AHIAawBlACAAZwBhAG0AbQBhACAAMgAuADKQGnUocHCWjlFJXqYAMgAuADKCcl9pY8+P8Md8vBgAINaMwMkAIKwQucgAIAAyAC4AMgAg1QS4XNMMx3wARwBlAG4AZQByAGkAcwBrACAAZwByAOUAIABnAGEAbQBtAGEAIAAyACwAMgAtAHAAcgBvAGYAaQBsAE8AYgBlAGMAbgDhACABYQBlAGQA4QAgAGcAYQBtAGEAIAAyAC4AMgXSBdAF3gXUACAF0AXkBdUF6AAgBdsF3AXcBdkAIAAyAC4AMgBHAGEAbQBhACAAZwByAGkAIABnAGUAbgBlAHIAaQBjAQMAIAAyACwAMgBBAGwAbABnAGUAbQBlAGkAbgBlAHMAIABHAHIAYQB1AHMAdAB1AGYAZQBuAC0AUAByAG8AZgBpAGwAIABHAGEAbQBtAGEAIAAyACwAMgBQAHIAbwBmAGkAbABvACAAZwByAGkAZwBpAG8AIABnAGUAbgBlAHIAaQBjAG8AIABkAGUAbABsAGEAIABnAGEAbQBtAGEAIAAyACwAMgBHAGUAbgBlAHIAaQBzAGsAIABnAHIA5QAgADIALAAyACAAZwBhAG0AbQBhAHAAcgBvAGYAaQBsZm6QGnBwXqZ8+2VwADIALgAyY8+P8GWHTvZOAIIsMLAw7DCkMKww8zDeACAAMgAuADIAIDDXMO0w1TChMKQw6wOTA7UDvQO5A7oDzAAgA5MDugPBA7kAIAOTA6wDvAO8A7EAIAAyAC4AMgBQAGUAcgBmAGkAbAAgAGcAZQBuAOkAcgBpAGMAbwAgAGQAZQAgAGMAaQBuAHoAZQBuAHQAbwBzACAAZABhACAARwBhAG0AbQBhACAAMgAsADIAQQBsAGcAZQBtAGUAZQBuACAAZwByAGkAagBzACAAZwBhAG0AbQBhACAAMgAsADIALQBwAHIAbwBmAGkAZQBsAFAAZQByAGYAaQBsACAAZwBlAG4A6QByAGkAYwBvACAAZABlACAAZwBhAG0AbQBhACAAZABlACAAZwByAGkAcwBlAHMAIAAyACwAMg4jDjEOBw4qDjUOQQ4BDiEOIQ4yDkAOAQ4jDiIOTA4XDjEOSA4nDkQOGwAgADIALgAyAEcAZQBuAGUAbAAgAEcAcgBpACAARwBhAG0AYQAgADIALAAyAFkAbABlAGkAbgBlAG4AIABoAGEAcgBtAGEAYQBuACAAZwBhAG0AbQBhACAAMgAsADIAIAAtAHAAcgBvAGYAaQBpAGwAaQBHAGUAbgBlAHIAaQENAGsAaQAgAEcAcgBhAHkAIABHAGEAbQBtAGEAIAAyAC4AMgAgAHAAcgBvAGYAaQBsAFUAbgBpAHcAZQByAHMAYQBsAG4AeQAgAHAAcgBvAGYAaQBsACAAcwB6AGEAcgBvAVsAYwBpACAAZwBhAG0AbQBhACAAMgAsADIGOgYnBkUGJwAgADIALgAyACAGRAZIBkYAIAYxBkUGJwYvBkoAIAY5BicGRQQeBDEESQQwBE8AIARBBDUEQAQwBE8AIAQzBDAEPAQ8BDAAIAAyACwAMgAtBD8EQAQ+BEQEOAQ7BEwARwBlAG4AZQByAGkAYwAgAEcAcgBhAHkAIABHAGEAbQBtAGEAIAAyAC4AMgAgAFAAcgBvAGYAaQBsAGUAAHRleHQAAAAAQ29weXJpZ2h0IEFwcGxlIEluYy4sIDIwMTIAAFhZWiAAAAAAAADzUQABAAAAARbMY3VydgAAAAAAAAQAAAAABQAKAA8AFAAZAB4AIwAoAC0AMgA3ADsAQABFAEoATwBUAFkAXgBjAGgAbQByAHcAfACBAIYAiwCQAJUAmgCfAKQAqQCuALIAtwC8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'
    const item = { type: 'mcpToolCall', server: 'node_repl', tool: 'js', status: 'completed',
      result: { content: [{ type: 'image', mimeType: 'image/jpeg', data }] } }
    const capture = (value: Record<string, unknown>) => browserScreenshotFromNotification(
      itemNotification('item/completed', value), 'root-thread', 'turn-1')
    expect(capture(item)).toMatchObject({ width: 1, height: 1, format: 'jpeg' })
    expect(capture({ ...item, status: 'failed' })).toBeNull()
    expect(capture({ ...item, server: 'other' })).toBeNull()
    expect(capture({ ...item, tool: 'read_file' })).toBeNull()
    for (const bad of [Buffer.alloc(40), Buffer.from(data, 'base64').subarray(0, 40)]) {
      expect(capture({ ...item, result: { content: [{ type: 'image', mimeType: 'image/jpeg', data: bad.toString('base64') }] } })).toBeNull()
    }
    const oversized = Buffer.from(data, 'base64')
    const frame = oversized.indexOf(Buffer.from([0xff, 0xc0]))
    expect(frame).toBeGreaterThan(0)
    oversized.writeUInt16BE(16385, frame + 7)
    expect(capture({ ...item, result: { content: [{ type: 'image', mimeType: 'image/jpeg', data: oversized.toString('base64') }] } })).toBeNull()
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
    expect(sanitizeMonitorText('{"jsonrpc":"2.0","id":"example"}')).toBe('{"jsonrpc":"2.0","id":"example"}')
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

  test('URL・ID・認証方式の説明を保持しterminal制御だけを除去する', () => {
    const text = '/Users/example/project https://example.test/report#' + 'a'.repeat(64)
      + ' U0123456789 Authorization: Bearer synthetic-example'
    expect(sanitizeMonitorText('\u001b[31m' + text + '\u001b[0m')).toBe(text)
    expect(sanitizeMonitorText('view bearer vs callback')).toBe('view bearer vs callback')
    expect(sanitizeMonitorText('あ'.repeat(8_193))).toBeNull()
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
