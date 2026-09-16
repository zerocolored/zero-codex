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
  advisorRepositoryIdentifiers,
  advisorRepositoryScopeDigest,
  parseAdvisorRepositorySnapshot,
  resolveAdvisorProjectLayout,
  serializeAdvisorRepositorySnapshot,
  snapshotAdvisorRepository,
  summarizeAdvisorRepositoryChanges,
  summarizeAdvisorTaskOwnedFixChanges,
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
  test('第2reviewはコミット済み修正を内容で比較し、既存dirtyのcommitだけを修正としない', () => {
    const root = fixtureDir()
    git(root, ['init', '-q'])
    git(root, ['config', 'user.name', 'Zero Test'])
    git(root, ['config', 'user.email', 'zero@example.invalid'])
    writeFileSync(join(root, 'fix.ts'), 'before\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'initial'])
    const layout = resolveAdvisorProjectLayout(root)
    const baseline = snapshotAdvisorRepository(layout)
    const paths = [{ repository: '.', path: 'fix.ts' }]
    writeFileSync(join(root, 'fix.ts'), 'fixed\n')
    // Owner-only files must compare equal after Git normalizes them to 100644.
    chmodSync(join(root, 'fix.ts'), 0o600)
    const dirty = snapshotAdvisorRepository(layout)
    expect(summarizeAdvisorTaskOwnedFixChanges(baseline, dirty, paths).changed).toBe(true)
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'mandatory fix'])
    const committed = snapshotAdvisorRepository(layout)
    expect(summarizeAdvisorRepositoryChanges(baseline, committed).repositories[0]!.changedPaths).toEqual([])
    expect(summarizeAdvisorTaskOwnedFixChanges(baseline, committed, paths).repositories)
      .toMatchObject([{ repository: '.', changedPaths: ['fix.ts'] }])
    expect(summarizeAdvisorTaskOwnedFixChanges(dirty, committed, paths).changed).toBe(false)
    writeFileSync(join(root, 'fix.ts'), 'fixed again\n')
    const edited = snapshotAdvisorRepository(layout)
    expect(summarizeAdvisorTaskOwnedFixChanges(dirty, edited, paths).changed).toBe(true)
    writeFileSync(join(root, 'fix.ts'), 'fixed again\n')
    expect(summarizeAdvisorTaskOwnedFixChanges(edited, snapshotAdvisorRepository(layout), paths).changed).toBe(false)
    chmodSync(join(root, 'fix.ts'), 0o640)
    expect(summarizeAdvisorTaskOwnedFixChanges(edited, snapshotAdvisorRepository(layout), paths).changed).toBe(false)
    chmodSync(join(root, 'fix.ts'), 0o740)
    expect(summarizeAdvisorTaskOwnedFixChanges(edited, snapshotAdvisorRepository(layout), paths).changed).toBe(true)
    expect(summarizeAdvisorTaskOwnedFixChanges(baseline, edited, [{ repository: '.', path: 'absent.ts' }]).changed).toBe(false)
  })

  test('第2reviewのrename・削除・literal pathをコミット前後で保持する', () => {
    const root = fixtureDir()
    git(root, ['init', '-q'])
    git(root, ['config', 'user.name', 'Zero Test'])
    git(root, ['config', 'user.email', 'zero@example.invalid'])
    writeFileSync(join(root, 'old.ts'), 'rename\n')
    writeFileSync(join(root, 'deleted.ts'), 'delete\n')
    writeFileSync(join(root, '[literal].ts'), 'before\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'initial'])
    const layout = resolveAdvisorProjectLayout(root)
    const baseline = snapshotAdvisorRepository(layout)
    git(root, ['mv', 'old.ts', 'new.ts'])
    rmSync(join(root, 'deleted.ts'))
    writeFileSync(join(root, '[literal].ts'), 'after\n')
    const paths = ['[literal].ts', 'deleted.ts', 'new.ts', 'old.ts'].map(path => ({ repository: '.', path }))
    expect(summarizeAdvisorTaskOwnedFixChanges(baseline, snapshotAdvisorRepository(layout), paths)
      .repositories[0]!.changedPaths).toEqual(paths.map(value => value.path))
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'fix'])
    expect(summarizeAdvisorTaskOwnedFixChanges(baseline, snapshotAdvisorRepository(layout), paths)
      .repositories[0]!.changedPaths).toEqual(paths.map(value => value.path))
  })

  test('第2reviewは別repo・200件超の生成物・workspace指示変更を修正対象へ混ぜない', () => {
    const project = fixtureDir()
    for (const name of ['backend', 'frontend']) {
      const root = join(project, name)
      mkdirSync(root)
      git(root, ['init', '-q'])
      git(root, ['config', 'user.name', 'Zero Test'])
      git(root, ['config', 'user.email', 'zero@example.invalid'])
      writeFileSync(join(root, 'fix.ts'), 'before\n')
      git(root, ['add', '.'])
      git(root, ['commit', '-qm', 'initial'])
    }
    writeFileSync(join(project, 'AGENTS.md'), 'before\n')
    const layout = resolveAdvisorProjectLayout(project)
    const baseline = snapshotAdvisorRepository(layout)
    writeFileSync(join(project, 'backend', 'fix.ts'), 'fixed\n')
    git(join(project, 'backend'), ['add', 'fix.ts'])
    git(join(project, 'backend'), ['commit', '-qm', 'fix'])
    writeFileSync(join(project, 'frontend', 'fix.ts'), 'other task\n')
    for (let index = 0; index < 205; index++) writeFileSync(join(project, 'backend', `generated-${index}.js`), 'build\n')
    writeFileSync(join(project, 'AGENTS.md'), 'updated instructions\n')
    const current = snapshotAdvisorRepository(layout)
    expect(summarizeAdvisorRepositoryChanges(baseline, current).repositories[0]!.omittedChangedPaths).toBeGreaterThan(0)
    const delta = summarizeAdvisorTaskOwnedFixChanges(baseline, current, [{ repository: 'backend', path: 'fix.ts' }])
    expect(delta.changed).toBe(true)
    expect(delta.repositories).toHaveLength(1)
    expect(delta.repositories[0]).toMatchObject({ repository: 'backend', changedPaths: ['fix.ts'], omittedChangedPaths: 0 })
    expect(delta.rootInstructionPaths).toEqual(['AGENTS.md'])
  }, 30_000)

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
    const baseline = snapshotAdvisorRepository(layout)
    const clean = advisorRepositoryDigest(baseline)
    writeFileSync(join(project, 'tracked.txt'), 'after\n')
    const modified = advisorRepositoryDigest(snapshotAdvisorRepository(layout))
    expect(modified).not.toBe(clean)
    expect(summarizeAdvisorTaskOwnedFixChanges(baseline, snapshotAdvisorRepository(layout), [
      { repository: '.', path: 'packages/app/tracked.txt' },
    ]).repositories).toMatchObject([{ repository: '.', changedPaths: ['packages/app/tracked.txt'] }])
    rmSync(join(project, 'tracked.txt'))
    const deleted = snapshotAdvisorRepository(layout)
    expect(deleted.dirty['packages/app/tracked.txt']).toBe('missing')
    expect(advisorRepositoryDigest(deleted)).not.toBe(modified)
  })

  test('単一repositoryの変更要約は内部absolute pathではなくdot labelを使う', () => {
    const repository = fixtureDir()
    git(repository, ['init', '-q'])
    git(repository, ['config', 'user.name', 'Zero Test'])
    git(repository, ['config', 'user.email', 'zero@example.invalid'])
    writeFileSync(join(repository, 'tracked.txt'), 'before\n')
    git(repository, ['add', '.'])
    git(repository, ['commit', '-qm', 'initial'])
    const layout = resolveAdvisorProjectLayout(repository)
    const baseline = snapshotAdvisorRepository(layout)
    writeFileSync(join(repository, 'tracked.txt'), 'after\n')
    const current = snapshotAdvisorRepository(layout)
    expect(summarizeAdvisorRepositoryChanges(baseline, current).repositories)
      .toMatchObject([{ repository: '.', changedPaths: ['tracked.txt'] }])
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

  test('対象member scopeは兄弟repoを無視しroot instructionと対象repoだけを監視する', () => {
    const project = fixtureDir()
    const repositories = ['backend', 'frontend'].map(name => {
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
    writeFileSync(join(project, 'AGENTS.md'), 'before\n', { mode: 0o600 })
    const layout = resolveAdvisorProjectLayout(project)
    const baseline = snapshotAdvisorRepository(layout)
    expect(advisorRepositoryIdentifiers(baseline)).toEqual(['backend', 'frontend'])
    const scoped = advisorRepositoryScopeDigest(baseline, ['frontend'])

    writeFileSync(join(repositories[0]!, 'tracked.txt'), 'unrelated\n')
    const siblingChanged = snapshotAdvisorRepository(layout)
    expect(advisorRepositoryDigest(siblingChanged)).not.toBe(advisorRepositoryDigest(baseline))
    expect(advisorRepositoryScopeDigest(siblingChanged, ['frontend'])).toBe(scoped)

    writeFileSync(join(repositories[1]!, 'tracked.txt'), 'target changed\n')
    expect(advisorRepositoryScopeDigest(
      snapshotAdvisorRepository(layout),
      ['frontend'],
    )).not.toBe(scoped)

    git(repositories[1]!, ['checkout', '--', 'tracked.txt'])
    writeFileSync(join(project, 'AGENTS.md'), 'after\n', { mode: 0o600 })
    expect(advisorRepositoryScopeDigest(
      snapshotAdvisorRepository(layout),
      ['frontend'],
    )).not.toBe(scoped)
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
