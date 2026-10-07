import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { recoveryControlRuntime } from './herdr-recovery.ts'
import type { HerdrRuntimeIdentity } from './herdr-runtime.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const old: HerdrRuntimeIdentity = {
  binary: '/bin/sh', binaryDevice: 1, binaryInode: 1, binaryMode: 0o100755,
  binarySize: 1, binaryModifiedMs: 1, binaryChangedMs: 1,
  socketPath: '/tmp/control.sock', socketDevice: 1, socketInode: 1,
  workspaceId: 'wOLD', tabId: 'wOLD:t1', paneId: 'wOLD:p1', terminalId: 'term_012345abcdef',
}
const missing = new Error('Herdr: {"error":{"code":"pane_not_found"}}')
function fixture() {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'zero-recovery-workspace-')))
  roots.push(state)
  return state
}
function created(args: string[], project: string) {
  return { result: {
    workspace: { workspace_id: 'wNEW', pane_count: 1, tab_count: 1, label: args[args.indexOf('--label') + 1] },
    tab: { workspace_id: 'wNEW', tab_id: 'wNEW:t1' },
    root_pane: { workspace_id: 'wNEW', tab_id: 'wNEW:t1', pane_id: 'wNEW:p1', terminal_id: 'term_abcdef012345', cwd: project },
  } }
}

test('missing pane creates one no-focus workspace and reuses its receipt on the next attempt', async () => {
  const state = fixture(); const calls: string[][] = []
  const hooks = {
    verify: async (runtime: HerdrRuntimeIdentity) => { if (runtime.paneId === old.paneId) throw missing },
    invoke: async (args: string[]) => { calls.push(args); return created(args, state) },
    capture: (runtime: HerdrRuntimeIdentity) => runtime,
  }
  const first = await recoveryControlRuntime(state, state, old, hooks)
  const next = await recoveryControlRuntime(state, state, old, hooks)
  expect(next).toEqual(first)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('--no-focus')
  expect(first.workspaceId).toBe('wNEW')
})

test('capture failure after creation retains exact identity and does not accumulate workspaces', async () => {
  const state = fixture(); let creates = 0; let failCapture = true
  const hooks = {
    verify: async (runtime: HerdrRuntimeIdentity) => { if (runtime.paneId === old.paneId) throw missing },
    invoke: async (args: string[]) => { creates++; return created(args, state) },
    capture: (runtime: HerdrRuntimeIdentity) => { if (failCapture) throw new Error('temporary observation failure'); return runtime },
  }
  await expect(recoveryControlRuntime(state, state, old, hooks)).rejects.toThrow('temporary')
  failCapture = false
  expect((await recoveryControlRuntime(state, state, old, hooks)).workspaceId).toBe('wNEW')
  expect(creates).toBe(1)
})

test('transient control-plane failure preserves existing runtime without creating or closing anything', async () => {
  const state = fixture(); let invoked = false
  await expect(recoveryControlRuntime(state, state, old, {
    verify: async () => { throw new Error('socket temporarily unavailable') },
    invoke: async () => { invoked = true; return {} },
  })).rejects.toThrow('temporarily')
  expect(invoked).toBe(false)
})

test('wrong capture identity is never accepted', async () => {
  const state = fixture()
  await expect(recoveryControlRuntime(state, state, old, {
    verify: async () => { throw missing },
    invoke: async args => created(args, state),
    capture: runtime => ({ ...runtime, terminalId: 'term_111111111111' }),
  })).rejects.toThrow('identity changed')
})

test.each(['project', 'socket', 'terminal'])('obsolete %s receipt is replaced without operating on its workspace', async (change) => {
  const state = fixture(); const nextProject = change === 'project' ? fixture() : state
  let creates = 0
  let changed = false
  const verified: string[] = []
  const hooks = {
    verify: async (runtime: HerdrRuntimeIdentity) => {
      verified.push(runtime.paneId)
      if (runtime.paneId === old.paneId) throw missing
    },
    invoke: async (args: string[]) => { creates++; return created(args, changed ? nextProject : state) },
    capture: (runtime: HerdrRuntimeIdentity) => changed && change === 'terminal' && creates === 1
      ? { ...runtime, terminalId: 'term_111111111111' } : runtime,
  }
  await recoveryControlRuntime(state, state, old, hooks)
  changed = true; verified.length = 0
  const current = change === 'socket' ? { ...old, socketPath: '/tmp/new-control.sock' } : old
  const replacement = await recoveryControlRuntime(state, nextProject, current, hooks)
  expect(creates).toBe(2)
  expect(replacement.socketPath).toBe(current.socketPath)
  expect(replacement.terminalId).toBe('term_abcdef012345')
  if (change !== 'terminal') expect(verified[0]).toBe(old.paneId)
  await recoveryControlRuntime(state, nextProject, current, hooks)
  expect(creates).toBe(2)
})
