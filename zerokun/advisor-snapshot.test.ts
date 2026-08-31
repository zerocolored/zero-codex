import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  advisorRepositoryDigest,
  parseAdvisorRepositorySnapshot,
  resolveAdvisorProjectLayout,
  serializeAdvisorRepositorySnapshot,
  snapshotAdvisorRepository,
  summarizeAdvisorRepositoryChanges,
} from './advisor-snapshot.ts'

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zerochan-advisor-snapshot-'))
  temporaryDirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['/usr/bin/git', '-C', cwd, ...args], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: {
      PATH: '/usr/bin:/bin', HOME: '/', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

describe('advisor repository snapshot', () => {
  test('Git subdirectoryを物理worktree rootへ結び、変更・削除をdigestへ反映する', () => {
    const root = fixtureDir()
    const project = join(root, 'packages', 'app')
    mkdirSync(project, { recursive: true })
    git(root, ['init', '-q'])
    git(root, ['config', 'user.name', 'Zero Test'])
    git(root, ['config', 'user.email', 'zero@example.invalid'])
    writeFileSync(join(project, 'tracked.txt'), 'before\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'initial'])

    const layout = resolveAdvisorProjectLayout(project)
    expect(layout.gitRoot).toBe(realpathSync(root))
    const clean = advisorRepositoryDigest(snapshotAdvisorRepository(layout))
    writeFileSync(join(project, 'tracked.txt'), 'after\n')
    const modified = advisorRepositoryDigest(snapshotAdvisorRepository(layout))
    expect(modified).not.toBe(clean)
    rmSync(join(project, 'tracked.txt'))
    const deleted = snapshotAdvisorRepository(layout)
    expect(deleted.dirty['packages/app/tracked.txt']).toBe('missing')
    expect(advisorRepositoryDigest(deleted)).not.toBe(modified)
  })

  test('non-Git treeをbounded no-followでsnapshotし、symlink targetは読まない', () => {
    const project = fixtureDir()
    const outside = fixtureDir()
    writeFileSync(join(project, 'plain.txt'), 'one\n')
    writeFileSync(join(outside, 'secret.txt'), 'outside\n')
    symlinkSync(join(outside, 'secret.txt'), join(project, 'link'))
    const layout = resolveAdvisorProjectLayout(project)
    expect(layout.gitRoot).toBeNull()
    const before = snapshotAdvisorRepository(layout)
    expect(before.dirty.link).toStartWith('metadata:')
    writeFileSync(join(project, 'plain.txt'), 'two\n')
    const after = snapshotAdvisorRepository(layout)
    expect(advisorRepositoryDigest(after)).not.toBe(advisorRepositoryDigest(before))
  })

  test('multi-repo workspaceは各memberのHEADとdirty stateを合成しhidden repoを除外する', () => {
    const project = fixtureDir()
    const members = ['backend', 'frontend', 'meeting-app'].map(name => {
      const repository = join(project, name)
      mkdirSync(repository)
      git(repository, ['init', '-q'])
      git(repository, ['config', 'user.name', 'Zero Test'])
      git(repository, ['config', 'user.email', 'zero@example.invalid'])
      writeFileSync(join(repository, 'tracked.txt'), `${name}\n`)
      git(repository, ['add', '.'])
      git(repository, ['commit', '-qm', 'initial'])
      return repository
    })
    const hidden = join(project, '.wt-hidden')
    mkdirSync(hidden)
    git(hidden, ['init', '-q'])

    const layout = resolveAdvisorProjectLayout(project)
    expect(layout.kind).toBe('multi-repo-workspace')
    expect(layout.gitRoots).toEqual(members.map(realpathSync))
    const before = snapshotAdvisorRepository(layout)
    expect(before.repositories).toHaveLength(3)
    writeFileSync(join(members[1]!, 'tracked.txt'), 'changed\n')
    const after = snapshotAdvisorRepository(layout)
    expect(after.dirty['frontend/tracked.txt']).toStartWith('sha256:')
    expect(advisorRepositoryDigest(after)).not.toBe(advisorRepositoryDigest(before))

    writeFileSync(join(hidden, 'ignored.txt'), 'ignored\n')
    expect(advisorRepositoryDigest(snapshotAdvisorRepository(layout)))
      .toBe(advisorRepositoryDigest(after))
  })

  test('multi-repo workspaceの安全なroot instruction変更をdigestへ反映する', () => {
    const project = fixtureDir()
    for (const name of ['backend', 'frontend']) {
      const repository = join(project, name)
      mkdirSync(repository)
      git(repository, ['init', '-q'])
      git(repository, ['config', 'user.name', 'Zero Test'])
      git(repository, ['config', 'user.email', 'zero@example.invalid'])
      writeFileSync(join(repository, 'tracked.txt'), `${name}\n`)
      git(repository, ['add', '.'])
      git(repository, ['commit', '-qm', 'initial'])
    }
    const instructions = join(project, 'AGENTS.md')
    writeFileSync(instructions, 'before\n', { mode: 0o600 })
    const layout = resolveAdvisorProjectLayout(project)
    const before = snapshotAdvisorRepository(layout)
    expect(before.rootInstructions['AGENTS.md']).toStartWith('sha256:')
    writeFileSync(instructions, 'after\n', { mode: 0o600 })
    const after = snapshotAdvisorRepository(layout)
    expect(advisorRepositoryDigest(after)).not.toBe(advisorRepositoryDigest(before))
  })

  test('承認時snapshotを厳格に往復し、承認後の変更箇所だけをbounded要約する', () => {
    const project = fixtureDir()
    for (const name of ['backend', 'frontend']) {
      const member = join(project, name)
      mkdirSync(member)
      git(member, ['init', '-q'])
      git(member, ['config', 'user.name', 'Zero Test'])
      git(member, ['config', 'user.email', 'zero@example.invalid'])
      writeFileSync(join(member, 'tracked.txt'), 'before\n')
      git(member, ['add', '.'])
      git(member, ['commit', '-qm', 'initial'])
    }
    const repository = join(project, 'frontend')
    writeFileSync(join(project, 'AGENTS.md'), 'before\n', { mode: 0o600 })

    const layout = resolveAdvisorProjectLayout(project)
    const baseline = snapshotAdvisorRepository(layout)
    const restored = parseAdvisorRepositorySnapshot(
      serializeAdvisorRepositorySnapshot(baseline),
    )
    expect(advisorRepositoryDigest(restored)).toBe(advisorRepositoryDigest(baseline))

    writeFileSync(join(repository, 'tracked.txt'), 'after\n')
    writeFileSync(join(project, 'AGENTS.md'), 'after\n', { mode: 0o600 })
    const current = snapshotAdvisorRepository(layout)
    expect(summarizeAdvisorRepositoryChanges(restored, current)).toMatchObject({
      baselineAvailable: true,
      changed: true,
      layoutChanged: false,
      repositories: [{
        repository: 'frontend',
        kind: 'changed',
        statusChanged: true,
        changedPaths: ['tracked.txt'],
        omittedChangedPaths: 0,
      }],
      rootInstructionPaths: ['AGENTS.md'],
      omittedRootInstructionPaths: 0,
    })
    expect(summarizeAdvisorRepositoryChanges(null, current)).toMatchObject({
      baselineAvailable: false,
      changed: true,
      baselineDigest: null,
      repositories: [],
    })
  })

  test('member外aliasを持つdirty hardlinkを拒否し、同一member内の全aliasはmetadata監査する', () => {
    const project = fixtureDir()
    for (const name of ['backend', 'frontend']) {
      const repository = join(project, name)
      mkdirSync(repository)
      git(repository, ['init', '-q'])
      git(repository, ['config', 'user.name', 'Zero Test'])
      git(repository, ['config', 'user.email', 'zero@example.invalid'])
      writeFileSync(join(repository, 'tracked.txt'), `${name}\n`)
      git(repository, ['add', '.'])
      git(repository, ['commit', '-qm', 'initial'])
    }
    const layout = resolveAdvisorProjectLayout(project)
    const outside = join(project, 'outside.txt')
    writeFileSync(outside, 'outside\n')
    linkSync(outside, join(project, 'backend', 'leak.txt'))
    expect(() => snapshotAdvisorRepository(layout)).toThrow('aliases outside')

    rmSync(join(project, 'backend', 'leak.txt'))
    rmSync(outside)
    const first = join(project, 'backend', 'generated-a')
    const second = join(project, 'backend', 'generated-b')
    writeFileSync(first, 'generated\n')
    linkSync(first, second)
    const snapshot = snapshotAdvisorRepository(layout)
    expect(snapshot.dirty['backend/generated-a']).toStartWith('metadata:')
    expect(snapshot.dirty['backend/generated-b']).toStartWith('metadata:')
  })

  test('unsafe hardlinked non-Git fileを拒否する', () => {
    const project = fixtureDir()
    const source = join(project, 'source')
    const linked = join(project, 'linked')
    writeFileSync(source, 'shared')
    Bun.spawnSync(['/bin/ln', source, linked])
    chmodSync(project, 0o700)
    const layout = resolveAdvisorProjectLayout(project)
    expect(() => snapshotAdvisorRepository(layout)).toThrow('unsafe dirty path')
  })
})
