import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startZeroInHerdrWorkspace } from './herdr-start.ts'
import type { ManagedServiceStatus } from './service-control.ts'

function fixture(): { root: string; state: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'zerochan-herdr-start-'))
  const state = join(root, 'state')
  const project = join(root, 'project')
  mkdirSync(state, { mode: 0o700 })
  chmodSync(state, 0o700)
  mkdirSync(project)
  writeFileSync(join(root, 'codex-channel.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o700 })
  return { root, state, project }
}

describe('outside-Herdr start handoff', () => {
  test('fresh workspaceのexact root paneでzerochan startを実行し稼働確認する', async () => {
    const current: ManagedServiceStatus = { status: 'stopped' }
    const calls: string[][] = []
    const { root, state, project } = fixture()
    try {
      const result = await startZeroInHerdrWorkspace(root, state, project, {
        inspectStatus: () => current,
        invoke: async args => {
          calls.push(args)
          if (args[0] === 'pane') {
            Object.assign(current, {
              status: 'running', gatewayPid: 111, runnerPid: 222,
            })
            return { result: {} }
          }
          return {
            result: {
              workspace: {
                workspace_id: 'wNEW', label: 'Zeroちゃん project', pane_count: 1, tab_count: 1,
              },
              tab: { workspace_id: 'wNEW', tab_id: 'wNEW:t1' },
              root_pane: {
                workspace_id: 'wNEW', tab_id: 'wNEW:t1', pane_id: 'wNEW:p1',
                terminal_id: 'term_012345abcdef', cwd: project,
              },
            },
          }
        },
        timeoutMs: 1_000,
      })
      expect(result).toEqual({
        status: 'started', workspaceId: 'wNEW', paneId: 'wNEW:p1',
        gatewayPid: 111, runnerPid: 222,
      })
      expect(calls[0]).toEqual([
        'workspace', 'create', '--cwd', realpathSync(project),
        '--label', 'Zeroちゃん project', '--focus',
      ])
      expect(calls[1]).toEqual([
        'pane', 'run', 'wNEW:p1', realpathSync(join(root, 'codex-channel.sh')), 'start',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('既存serviceが正常なら新しいworkspaceを作らない', async () => {
    const { root, state, project } = fixture()
    let invoked = false
    try {
      const result = await startZeroInHerdrWorkspace(root, state, project, {
        inspectStatus: () => ({ status: 'running', gatewayPid: 333, runnerPid: 444 }),
        invoke: async () => {
          invoked = true
          return {}
        },
      })
      expect(result).toEqual({
        status: 'already-running', gatewayPid: 333, runnerPid: 444,
      })
      expect(invoked).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
