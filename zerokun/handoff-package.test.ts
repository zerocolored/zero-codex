import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { captureRepository, decodePackage, encodePackage, restoreRepository } from './handoff-package.ts'

const owned: string[] = []
test('portable conversation redacts quoted credentials without blocking continuation', () => {
  const packet = decodePackage(encodePackage({ version: 1, task: 'Example {"api_key":"example-private-value"}',
    history: 'Use {"password":"example-private-password"} then continue', repositories: [], attachments: [], notes: [] }))
  expect(packet.task).not.toContain('example-private-value')
  expect(packet.history).not.toContain('example-private-password')
  expect(packet.history).toContain('continue')
})
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }) })
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  } })
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'handoff-package-test-')); owned.push(root)
  git(root, 'init', '--quiet')
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/project.git')
  writeFileSync(join(root, 'file.txt'), 'base\n')
  writeFileSync(join(root, 'delete.txt'), 'remove me\n')
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'base')
  return { root, base: git(root, 'rev-parse', 'HEAD').trim() }
}
test('roundtrip staged, unstaged, deleted, binary and untracked changes without editing source', () => {
  const { root, base } = fixture()
  writeFileSync(join(root, 'file.txt'), 'staged\n')
  git(root, 'add', 'file.txt')
  writeFileSync(join(root, 'file.txt'), 'working\n')
  git(root, 'rm', '--quiet', 'delete.txt')
  writeFileSync(join(root, 'asset.bin'), Buffer.from([0, 1, 2, 255]))
  git(root, 'add', 'asset.bin')
  writeFileSync(join(root, 'new.txt'), 'not staged\n')
  const before = git(root, 'status', '--porcelain')
  const repository = captureRepository(root, 'project', base)
  const packet = decodePackage(encodePackage({ version: 1, task: 'Continue', history: 'Previously tested',
    repositories: [repository], attachments: [], notes: [] }))
  const target = join(root, 'restored')
  restoreRepository(target, packet.repositories[0]!, root)
  expect(readFileSync(join(target, 'file.txt'), 'utf8')).toBe('working\n')
  expect(git(target, 'show', ':file.txt')).toBe('staged\n')
  expect(readFileSync(join(target, 'asset.bin'))).toEqual(Buffer.from([0, 1, 2, 255]))
  expect(readFileSync(join(target, 'new.txt'), 'utf8')).toBe('not staged\n')
  expect(git(target, 'status', '--porcelain')).toBe(before)
})
test('unpublished commit contents travel even when recipient has only base', () => {
  const { root, base } = fixture()
  writeFileSync(join(root, 'file.txt'), 'unpublished\n')
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'unpublished')
  const snapshot = captureRepository(root, 'project', base)
  expect(snapshot.sourceHead).not.toBe(base)
  expect(snapshot.staged).toContain('unpublished')
})
test('protected untracked files and symlinks cannot be silently uploaded', () => {
  const { root, base } = fixture()
  writeFileSync(join(root, '.env'), 'EXAMPLE=value')
  expect(() => captureRepository(root, 'project', base)).toThrow('protected')
  rmSync(join(root, '.env'))
  symlinkSync('/dev/null', join(root, 'link'))
  expect(() => captureRepository(root, 'project', base)).toThrow('symlink')
})
test('tampered content and traversing file paths are rejected', () => {
  const { root, base } = fixture()
  writeFileSync(join(root, 'new.txt'), 'hello')
  const packet = { version: 1 as const, task: 'task', history: '', repositories: [captureRepository(root, 'project', base)], attachments: [], notes: [] }
  packet.repositories[0]!.untracked[0]!.path = '../escape'
  expect(() => decodePackage(encodePackage(packet))).toThrow('unsafe')
  packet.repositories[0]!.untracked[0]!.path = 'new.txt'
  packet.repositories[0]!.untracked[0]!.data = Buffer.from('modified').toString('base64')
  expect(() => decodePackage(encodePackage(packet))).toThrow('digest')
})
test('existing import roots are never overwritten', () => {
  const { root, base } = fixture()
  expect(() => restoreRepository(root, captureRepository(root, 'project', base), root)).toThrow()
  expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('base\n')
})
test('ordinary source filenames mentioning tokens or credential brokers remain portable', () => {
  const { root, base } = fixture()
  for (const name of ['tokenizer.ts', 'design-tokens.css', 'github-credential-broker.ts']) writeFileSync(join(root, name), '// ordinary source')
  expect(captureRepository(root, 'project', base).untracked).toHaveLength(3)
})
test('known secret file names and quoted JSON credentials cannot be uploaded', () => {
  const { root, base } = fixture()
  for (const name of ['secrets.yaml', 'cloud-auth.json', 'zapier-webhook-secret']) {
    writeFileSync(join(root, name), 'synthetic protected fixture')
    expect(() => captureRepository(root, 'project', base)).toThrow('protected')
    rmSync(join(root, name))
  }
  writeFileSync(join(root, 'ordinary.json'), JSON.stringify({ password: 'abcdefghijklmnop' }))
  expect(() => captureRepository(root, 'project', base)).toThrow('credential')
  rmSync(join(root, 'ordinary.json'))
  writeFileSync(join(root, 'notes.txt'), 'https://hooks.zapier.com/hooks/catch/synthetic-fixture/not-real/')
  expect(() => captureRepository(root, 'project', base)).toThrow('credential')
})
