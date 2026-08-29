import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import {
  ensureWorkspacePin,
  resolveProjectLayout,
} from './project-layout.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function gitInit(path: string): void {
  mkdirSync(path, { recursive: true })
  const result = Bun.spawnSync(['/usr/bin/git', 'init', '-q', path], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
}

function workspaceFixture(): { root: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), 'zerochan-multi-layout-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  for (const name of ['backend', 'frontend', 'meeting-app', '.wt-hidden']) {
    gitInit(join(workspace, name))
  }
  mkdirSync(join(workspace, 'artifacts'))
  return { root, workspace }
}

describe('multi-repository project layout', () => {
  test('visible direct Git clonesだけを安定順でworkspace memberにする', () => {
    const { workspace } = workspaceFixture()
    const layout = resolveProjectLayout(workspace)
    expect(layout.kind).toBe('multi-repo-workspace')
    expect(layout.memberNames).toEqual(['backend', 'frontend', 'meeting-app'])
    expect(layout.gitRoots.map(path => relative(layout.projectPath, path)))
      .toEqual(['backend', 'frontend', 'meeting-app'])
    expect(layout.excludedDirectPaths.map(path => relative(layout.projectPath, path)))
      .toEqual(['.wt-hidden', 'artifacts'])
  })

  test('owner-only workspace pinを保存し、member追加を黙って採用しない', () => {
    const { workspace } = workspaceFixture()
    const layout = resolveProjectLayout(workspace)
    ensureWorkspacePin(layout)
    const pin = join(workspace, '.zerochan', 'workspace.json')
    expect(existsSync(pin)).toBe(true)
    expect(lstatSync(join(workspace, '.zerochan')).mode & 0o777).toBe(0o700)
    expect(lstatSync(pin).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(pin, 'utf8'))).toEqual({
      version: 1,
      kind: 'multi-repo-workspace',
      members: ['backend', 'frontend', 'meeting-app'],
    })
    expect(resolveProjectLayout(workspace).pinned).toBe(true)

    gitInit(join(workspace, 'new-app'))
    expect(() => resolveProjectLayout(workspace)).toThrow('member構成が設定時から変わっています')
  })

  test('localeや文字種に依存しない順序でpinを保存して再読込できる', () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-multi-order-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    for (const name of ['alpha', 'API', 'frontend', 'Zeta', '\uE000', '😀']) {
      gitInit(join(workspace, name))
    }

    const layout = resolveProjectLayout(workspace)
    expect(layout.memberNames).toEqual(['API', 'Zeta', 'alpha', 'frontend', '\uE000', '😀'])
    ensureWorkspacePin(layout)
    expect(resolveProjectLayout(workspace)).toMatchObject({
      kind: 'multi-repo-workspace',
      memberNames: ['API', 'Zeta', 'alpha', 'frontend', '\uE000', '😀'],
      pinned: true,
    })
  })

  test('安全なworkspace root instructionだけをmember外read対象にする', () => {
    const { workspace } = workspaceFixture()
    const agents = join(workspace, 'AGENTS.md')
    writeFileSync(agents, '# workspace instructions\n', { mode: 0o600 })
    expect(resolveProjectLayout(workspace).rootInstructionPaths).toEqual([realpathSync(agents)])

    rmSync(agents)
    symlinkSync(join(workspace, 'backend', '.git', 'HEAD'), agents)
    expect(() => resolveProjectLayout(workspace)).toThrow('安全な通常file')
  })

  test('pin済みworkspace parentがGit化されたら単一repoへ黙って切り替えない', () => {
    const { workspace } = workspaceFixture()
    ensureWorkspacePin(resolveProjectLayout(workspace))
    const initialized = Bun.spawnSync(['/usr/bin/git', 'init', '-q', workspace], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    expect(initialized.exitCode, initialized.stderr.toString()).toBe(0)
    expect(() => resolveProjectLayout(workspace)).toThrow('親directoryがGit化')
  })

  test('pin済みworkspaceのmemberが1件まで減ってもnon-Git扱いへ降格しない', () => {
    const { workspace } = workspaceFixture()
    ensureWorkspacePin(resolveProjectLayout(workspace))
    rmSync(join(workspace, 'frontend'), { recursive: true, force: true })
    rmSync(join(workspace, 'meeting-app'), { recursive: true, force: true })
    expect(() => resolveProjectLayout(workspace)).toThrow('member構成が設定時から変わっています')
  })

  test('Git repoが1件だけの親とsymlinkだけの親はworkspaceにしない', () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-not-workspace-'))
    roots.push(root)
    const one = join(root, 'one')
    mkdirSync(one)
    gitInit(join(one, 'repo'))
    expect(resolveProjectLayout(one).kind).toBe('non-git')

    const linked = join(root, 'linked')
    mkdirSync(linked)
    symlinkSync(join(one, 'repo'), join(linked, 'external-repo'))
    expect(resolveProjectLayout(linked).kind).toBe('non-git')
  })
})
