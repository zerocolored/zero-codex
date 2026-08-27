import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AppServerProtocolError,
  type AppServerPermissionProbeEvidence,
  type AppServerTurnTerminal,
  type CodexAppServerSession,
} from './codex-app-server-session.ts'
import {
  loadPermissionProbeEvidenceForTerminal,
  requireSingleProbeExecution,
} from './live-codex-permission-check.ts'

describe('live Codex permission evidence', () => {
  test('正確に1件の固定commandだけを受理する', () => {
    const repo = mkdtempSync(join(tmpdir(), 'zero-live-permission-evidence-'))
    const script = '/tmp/permission-probe'
    const valid: AppServerPermissionProbeEvidence = {
      commandCount: 1,
      firstCommand: {
        itemId: 'command-1',
        command: script,
        cwd: repo,
        source: 'agent',
        status: 'completed',
        exitCode: 0,
      },
      unexpectedItemSeen: false,
      unexpectedItemType: null,
    }
    try {
      expect(() => requireSingleProbeExecution(valid, script, repo)).not.toThrow()
      const invalid: AppServerPermissionProbeEvidence[] = [
        { ...valid, commandCount: 0, firstCommand: null },
        { ...valid, commandCount: 2 },
        { ...valid, firstCommand: { ...valid.firstCommand!, command: '/tmp/other' } },
        { ...valid, firstCommand: { ...valid.firstCommand!, cwd: '/tmp' } },
        { ...valid, firstCommand: { ...valid.firstCommand!, source: 'user' } },
        { ...valid, firstCommand: { ...valid.firstCommand!, status: 'failed' } },
        { ...valid, firstCommand: { ...valid.firstCommand!, exitCode: 1 } },
        { ...valid, unexpectedItemSeen: true, unexpectedItemType: 'mcpToolCall' },
      ]
      for (const evidence of invalid) {
        expect(() => requireSingleProbeExecution(evidence, script, repo)).toThrow()
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('items/list未対応時はterminalのbounded evidenceへ戻る', async () => {
    const evidence: AppServerPermissionProbeEvidence = {
      commandCount: 1,
      firstCommand: {
        itemId: 'command-1', command: '/tmp/probe', cwd: '/tmp', source: 'agent',
        status: 'completed', exitCode: 0,
      },
      unexpectedItemSeen: false,
      unexpectedItemType: null,
    }
    const terminal: AppServerTurnTerminal = {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1', status: 'completed', itemsView: 'summary', items: [], error: null,
      },
      permissionEvidence: evidence,
    }
    const session = {
      loadPermissionProbeEvidence: async () => null,
    } as unknown as CodexAppServerSession
    await expect(loadPermissionProbeEvidenceForTerminal(session, terminal))
      .resolves.toEqual(evidence)
  })

  test('初回未対応null以外の-32601 errorをterminal evidenceへ弱めない', async () => {
    const terminal: AppServerTurnTerminal = {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', itemsView: 'full', items: [], error: null },
      permissionEvidence: {
        commandCount: 0, firstCommand: null,
        unexpectedItemSeen: false, unexpectedItemType: null,
      },
    }
    for (const error of [
      new AppServerProtocolError(
        'late unsupported', 'thread/items/list', 1, { code: -32601 },
      ),
      new AppServerProtocolError(
        'unsupported', 'thread/items/list', 1, { code: '-32601' },
      ),
      new AppServerProtocolError('unsupported', 'thread/read', 1, { code: -32601 }),
    ]) {
      const session = {
        loadPermissionProbeEvidence: async () => { throw error },
      } as unknown as CodexAppServerSession
      await expect(loadPermissionProbeEvidenceForTerminal(session, terminal)).rejects.toBe(error)
    }
  })

  test('公式履歴が成功してもstream側の複数実行と未知toolを捨てない', async () => {
    const firstCommand = {
      itemId: 'command-1', command: '/tmp/probe', cwd: '/tmp', source: 'agent',
      status: 'completed', exitCode: 0,
    }
    const terminal: AppServerTurnTerminal = {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1', status: 'completed', itemsView: 'full', items: [], error: null,
      },
      permissionEvidence: {
        commandCount: 2,
        firstCommand,
        unexpectedItemSeen: true,
        unexpectedItemType: 'mcpToolCall',
      },
    }
    const session = {
      loadPermissionProbeEvidence: async (): Promise<AppServerPermissionProbeEvidence> => ({
        commandCount: 1,
        firstCommand,
        unexpectedItemSeen: false,
        unexpectedItemType: null,
      }),
    } as unknown as CodexAppServerSession
    const evidence = await loadPermissionProbeEvidenceForTerminal(session, terminal)
    expect(evidence.commandCount).toBe(2)
    expect(evidence.unexpectedItemType).toBe('mcpToolCall')
  })
})
