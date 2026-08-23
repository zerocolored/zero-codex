import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync, closeSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { atomicWritePrivateFile, openSafeLog, readOptionalPrivateFile } from './safe-file.ts'
import { prepareManagedStateRoot, requireManagedStateRoot } from './managed-path.ts'
import { JobStore } from './job-runner.ts'

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zerokun-safe-file-'))
  directories.push(dir)
  return dir
}

describe('managed private files', () => {
  test('state rootはgroup/world accessを拒否し、owner確認後のprepareだけが0700へ直す', () => {
    const root = join(fixture(), 'state')
    mkdirSync(root, { mode: 0o777 })
    chmodSync(root, 0o777)
    expect(() => requireManagedStateRoot(root)).toThrow('not private')
    expect(prepareManagedStateRoot(root)).toBe(realpathSync(root))
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(requireManagedStateRoot(root)).toBe(realpathSync(root))
  })

  test('state root symlinkを拒否し、外部directoryを変更しない', () => {
    const dir = fixture()
    const external = join(dir, 'external')
    const root = join(dir, 'state')
    mkdirSync(external, { mode: 0o755 })
    chmodSync(external, 0o755)
    writeFileSync(join(external, 'keep'), 'preserved')
    symlinkSync(external, root)
    expect(() => requireManagedStateRoot(root)).toThrow('unsafe managed directory')
    expect(() => prepareManagedStateRoot(root)).toThrow('unsafe managed directory')
    expect(statSync(external).mode & 0o777).toBe(0o755)
    expect(readFileSync(join(external, 'keep'), 'utf8')).toBe('preserved')
    expect(readdirSync(external)).toEqual(['keep'])
    expect(lstatSync(root).isSymbolicLink()).toBe(true)
  })

  test('.env symlinkを拒否し、外部fileの内容とmodeを変えない', () => {
    const dir = fixture()
    const external = join(dir, 'external')
    const env = join(dir, '.env')
    writeFileSync(external, 'SLACK_BOT_TOKEN=external', { mode: 0o644 })
    symlinkSync(external, env)
    expect(() => readOptionalPrivateFile(env)).toThrow()
    expect(readFileSync(external, 'utf8')).toBe('SLACK_BOT_TOKEN=external')
    expect(statSync(external).mode & 0o777).toBe(0o644)
    expect(lstatSync(env).isSymbolicLink()).toBe(true)
  })

  test('log symlink/hardlinkをtruncate前に拒否する', () => {
    const dir = fixture()
    const external = join(dir, 'external.log')
    writeFileSync(external, 'keep')
    symlinkSync(external, join(dir, 'symlink.log'))
    linkSync(external, join(dir, 'hardlink.log'))
    expect(() => openSafeLog(join(dir, 'symlink.log'), 'truncate')).toThrow()
    expect(() => openSafeLog(join(dir, 'hardlink.log'), 'truncate')).toThrow('unsafe managed file')
    expect(readFileSync(external, 'utf8')).toBe('keep')
  })

  test('atomic private writeは既存destination symlinkを辿らず置換する', () => {
    const dir = fixture()
    const external = join(dir, 'external.json')
    const destination = join(dir, 'delivered.json')
    writeFileSync(external, 'keep', { mode: 0o644 })
    symlinkSync(external, destination)
    atomicWritePrivateFile(destination, '["new"]')
    expect(readFileSync(external, 'utf8')).toBe('keep')
    expect(readFileSync(destination, 'utf8')).toBe('["new"]')
    expect(lstatSync(destination).isFile()).toBe(true)
    expect(statSync(destination).mode & 0o777).toBe(0o600)
  })

  test('atomic private writeは既存destination hardlinkを辿らず置換する', () => {
    const dir = fixture()
    const external = join(dir, 'external.json')
    const destination = join(dir, 'delivered.json')
    writeFileSync(external, 'keep', { mode: 0o644 })
    linkSync(external, destination)
    atomicWritePrivateFile(destination, '["new"]')
    expect(readFileSync(external, 'utf8')).toBe('keep')
    expect(readFileSync(destination, 'utf8')).toBe('["new"]')
    expect(statSync(destination).nlink).toBe(1)
  })

  test('SQLite DBとsidecarのsymlink/hardlinkをopen前に拒否する', () => {
    const state = fixture()
    const external = join(state, 'external.sqlite3')
    const dbPath = join(state, 'jobs.sqlite3')
    writeFileSync(external, 'keep')
    symlinkSync(external, dbPath)
    expect(() => new JobStore(dbPath)).toThrow('unsafe SQLite file')
    expect(readFileSync(external, 'utf8')).toBe('keep')

    rmSync(dbPath)
    const store = new JobStore(dbPath)
    store.close()
    rmSync(`${dbPath}-wal`, { force: true })
    symlinkSync(external, `${dbPath}-wal`)
    expect(() => new JobStore(dbPath)).toThrow('unsafe SQLite file')
    expect(readFileSync(external, 'utf8')).toBe('keep')
  })

  test('job-runner.lock directory symlinkを拒否しstate外へ書かない', () => {
    const state = fixture()
    const external = fixture()
    symlinkSync(external, join(state, 'job-runner.lock'))
    const result = Bun.spawnSync([
      process.execPath, join(import.meta.dir, 'job-runner.ts'), 'run-until-idle',
    ], {
      env: { ...process.env, ZEROKUN_STATE_DIR: state },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('unsafe managed directory')
    expect(readdirSync(external)).toEqual([])
  })

  test('通常logは安全に作成できる', () => {
    const dir = fixture()
    const path = join(dir, 'job.log')
    const descriptor = openSafeLog(path, 'truncate')
    closeSync(descriptor)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
