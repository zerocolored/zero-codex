import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
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
  resolveAdvisorProjectLayout,
  snapshotAdvisorRepository,
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
