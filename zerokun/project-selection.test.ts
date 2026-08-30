import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
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
import { join } from 'path'
import {
  lastConnectedProjectPath,
  projectGitExecutable,
  readLastConnectedProject,
  validateLaunchProject,
  writeLastConnectedProject,
} from './project-selection.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; home: string; runtime: string; state: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'zerochan-project-'))
  roots.push(root)
  const home = join(root, 'home')
  const runtime = join(root, 'runtime')
  const state = join(root, 'state')
  const project = join(root, 'project')
  for (const directory of [home, runtime, state, project]) mkdirSync(directory)
  for (const repository of [runtime, project]) {
    const result = Bun.spawnSync(['git', 'init', '-q', repository], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  }
  return { root, home, runtime, state, project }
}

describe('zerochan project selection', () => {
  test('candidate Git overrideはverified sandbox markerなしでは拒否する', () => {
    expect(projectGitExecutable({})).toBe('/usr/bin/git')
    expect(() => projectGitExecutable({
      ZERO_CODEX_CANDIDATE_GIT: '/usr/bin/git',
    })).toThrow('verified Codex sandbox')
    expect(() => projectGitExecutable({
      ZERO_CODEX_CANDIDATE_SANDBOX: '1',
      CODEX_SANDBOX: 'seatbelt',
    })).toThrow('verified Codex sandbox')
  })

  test('validates and returns the physical Git project path', () => {
    const value = fixture()
    const alias = join(value.root, 'project-alias')
    symlinkSync(value.project, alias)
    expect(validateLaunchProject(alias, {
      runtimeRepo: value.runtime,
      stateDir: value.state,
      homeDir: value.home,
    })).toBe(realpathSync(value.project))
  })

  test('accepts a non-Git parent with multiple visible direct-child repositories', () => {
    const value = fixture()
    const workspace = join(value.root, 'workspace')
    mkdirSync(workspace)
    for (const name of ['backend', 'frontend', 'meeting-app', '.wt-hidden']) {
      const repository = join(workspace, name)
      mkdirSync(repository)
      const result = Bun.spawnSync([projectGitExecutable(), 'init', '-q', repository], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
    }
    expect(validateLaunchProject(workspace, {
      runtimeRepo: value.runtime,
      stateDir: value.state,
      homeDir: value.home,
    })).toBe(realpathSync(workspace))
  })

  test('rejects non-Git, runtime, state, home, and filesystem-root targets', () => {
    const value = fixture()
    const plain = join(value.root, 'plain')
    mkdirSync(plain)
    const options = {
      runtimeRepo: value.runtime,
      stateDir: value.state,
      homeDir: value.home,
    }
    expect(() => validateLaunchProject(plain, options)).toThrow('Git worktree')
    expect(() => validateLaunchProject(value.runtime, options)).toThrow('runtime repository')
    expect(() => validateLaunchProject(value.state, options)).toThrow('managed state')
    expect(() => validateLaunchProject(value.home, options)).toThrow('home directory')
    expect(() => validateLaunchProject('/', options)).toThrow('filesystem root')
  })

  test('ignores PATH git shims and ambient Git repository selectors', () => {
    const value = fixture()
    const plain = join(value.root, 'plain')
    const fakeBin = join(value.root, 'fake-bin')
    mkdirSync(plain)
    mkdirSync(fakeBin)
    const fakeGit = join(fakeBin, 'git')
    writeFileSync(fakeGit, '#!/bin/sh\necho true\n', { mode: 0o700 })
    const previousPath = process.env.PATH
    const previousGitDir = process.env.GIT_DIR
    const previousWorkTree = process.env.GIT_WORK_TREE
    try {
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
      process.env.GIT_DIR = join(value.runtime, '.git')
      process.env.GIT_WORK_TREE = value.runtime
      expect(() => validateLaunchProject(plain, {
        runtimeRepo: value.runtime,
        stateDir: value.state,
        homeDir: value.home,
      })).toThrow('Git worktree')
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
      if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = previousWorkTree
    }
  })

  test('rejects another worktree sharing the runtime Git metadata', () => {
    const value = fixture()
    writeFileSync(join(value.runtime, 'tracked'), 'one\n')
    Bun.spawnSync(['git', '-C', value.runtime, 'add', 'tracked'])
    Bun.spawnSync([
      'git', '-C', value.runtime,
      '-c', 'user.name=Zero Test', '-c', 'user.email=zero@example.invalid',
      'commit', '-qm', 'fixture',
    ])
    const sibling = join(value.root, 'runtime-worktree')
    const added = Bun.spawnSync(['git', '-C', value.runtime, 'worktree', 'add', '-q', sibling], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    expect(added.exitCode, added.stderr.toString()).toBe(0)
    expect(() => validateLaunchProject(sibling, {
      runtimeRepo: value.runtime,
      stateDir: value.state,
      homeDir: value.home,
    })).toThrow('share Git metadata')
  })

  test('persists an owner-only physical last-connected project record', () => {
    const value = fixture()
    const alias = join(value.root, 'project-alias')
    symlinkSync(value.project, alias)
    const written = writeLastConnectedProject(value.state, alias, 1234)
    expect(written).toEqual({
      version: 1, projectDir: realpathSync(value.project), connectedAt: 1234,
    })
    const recordPath = lastConnectedProjectPath(value.state)
    expect(lstatSync(recordPath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toEqual(written)
    expect(readLastConnectedProject(value.state)).toEqual(written)
  })

  test('treats malformed, obsolete, and missing project records as unavailable', () => {
    const value = fixture()
    const recordPath = lastConnectedProjectPath(value.state)
    writeFileSync(recordPath, '{', { mode: 0o600 })
    expect(readLastConnectedProject(value.state)).toBeNull()
    writeFileSync(recordPath, JSON.stringify({
      version: 2, projectDir: value.project, connectedAt: 1,
    }))
    chmodSync(recordPath, 0o600)
    expect(readLastConnectedProject(value.state)).toBeNull()
    writeFileSync(recordPath, JSON.stringify({
      version: 1, projectDir: join(value.root, 'gone'), connectedAt: 1,
    }))
    chmodSync(recordPath, 0o600)
    expect(readLastConnectedProject(value.state)).toBeNull()
  })

  test('fails closed for a symlinked record', () => {
    const value = fixture()
    const target = join(value.root, 'record-target')
    writeFileSync(target, JSON.stringify({
      version: 1, projectDir: value.project, connectedAt: 1,
    }), { mode: 0o600 })
    symlinkSync(target, lastConnectedProjectPath(value.state))
    expect(() => readLastConnectedProject(value.state)).toThrow()
  })
})
