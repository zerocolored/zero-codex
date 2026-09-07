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

function createdWorkspace(project: string): Record<string, unknown> {
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
              status: 'running', gatewayPid: 111, runnerPid: 222, launcherPid: 333,
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
        gatewayPid: 111, runnerPid: 222, launcherPid: 333,
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
        inspectStatus: () => ({
          status: 'running', gatewayPid: 333, runnerPid: 444, launcherPid: 555,
        }),
        invoke: async () => {
          invoked = true
          return {}
        },
      })
      expect(result).toEqual({
        status: 'already-running', gatewayPid: 333, runnerPid: 444, launcherPid: 555,
      })
      expect(invoked).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Herdr外でもlauncherだけの欠落はworkspaceを増やさず再構築する', async () => {
    const { root, state, project } = fixture()
    let invoked = false
    let repaired = false
    try {
      const result = await startZeroInHerdrWorkspace(root, state, project, {
        inspectStatus: () => ({
          status: 'partial', gatewayPid: 111, runnerPid: 222,
        }),
        repairMissingLauncher: async input => {
          repaired = true
          expect(input).toEqual({
            rootRepo: realpathSync(root),
            stateDir: realpathSync(state),
            projectDir: realpathSync(project),
          })
          return {
            status: 'running', gatewayPid: 111, runnerPid: 222, launcherPid: 333,
          }
        },
        invoke: async () => {
          invoked = true
          return {}
        },
      })
      expect(result).toEqual({
        status: 'already-running', gatewayPid: 111, runnerPid: 222, launcherPid: 333,
      })
      expect(repaired).toBe(true)
      expect(invoked).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('launcher以外も欠ける部分起動はforce stopの復旧手順を示す', async () => {
    const { root, state, project } = fixture()
    try {
      await expect(startZeroInHerdrWorkspace(root, state, project, {
        inspectStatus: () => ({ status: 'partial', gatewayPid: 111 }),
      })).rejects.toThrow('zerochan stop --force')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('pane run失敗時は今回作成したexact workspaceだけを閉じservice停止を確認する', async () => {
    const { root, state, project } = fixture()
    const calls: string[][] = []
    let status: ManagedServiceStatus = { status: 'stopped' }
    try {
      await expect(startZeroInHerdrWorkspace(root, state, project, {
        inspectStatus: () => status,
        invoke: async args => {
          calls.push(args)
          if (args[0] === 'workspace' && args[1] === 'create') {
            return createdWorkspace(project)
          }
          if (args[0] === 'pane') {
            status = { status: 'partial', launcherPid: 333 }
            throw new Error('pane delivery failed')
          }
          if (args[0] === 'workspace' && args[1] === 'close') {
            status = { status: 'stopped' }
            return { result: {} }
          }
          throw new Error(`unexpected command: ${args.join(' ')}`)
        },
        cleanupTimeoutMs: 100,
      })).rejects.toThrow('pane delivery failed')
      expect(calls.filter(args => args[0] === 'workspace' && args[1] === 'close'))
        .toEqual([['workspace', 'close', 'wNEW']])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('health timeout時もexact workspaceを閉じgateway/runner/launcher停止まで確認する', async () => {
    const { root, state, project } = fixture()
    const calls: string[][] = []
    let status: ManagedServiceStatus = { status: 'stopped' }
    try {
      await expect(startZeroInHerdrWorkspace(root, state, project, {
        inspectStatus: () => status,
        invoke: async args => {
          calls.push(args)
          if (args[0] === 'workspace' && args[1] === 'create') {
            return createdWorkspace(project)
          }
          if (args[0] === 'pane') {
            status = {
              status: 'partial', gatewayPid: 111, runnerPid: 222, launcherPid: 333,
            }
            return { result: {} }
          }
          if (args[0] === 'workspace' && args[1] === 'close') {
            status = { status: 'stopped' }
            return { result: {} }
          }
          throw new Error(`unexpected command: ${args.join(' ')}`)
        },
        sleep: async () => {},
        timeoutMs: 0,
        cleanupTimeoutMs: 100,
      })).rejects.toThrow('起動確認がtimeout')
      expect(calls.at(-1)).toEqual(['workspace', 'close', 'wNEW'])
      expect(status).toEqual({ status: 'stopped' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
