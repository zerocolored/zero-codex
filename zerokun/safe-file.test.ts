import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'fs'
import {
  chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertDescriptorStillNamesPath,
  atomicWritePrivateFile,
  openSafeLog,
  readOptionalBoundedAtomicOwnedFile,
  readOptionalBoundedOwnerOnlyRegularFile,
  readOptionalOwnedRegularFile,
  readOptionalOwnerOnlyRegularFile,
  readOptionalPrivateFile,
} from './safe-file.ts'
import {
  ensureManagedDirectory,
  prepareManagedStateRoot,
  requireManagedStateRoot,
} from './managed-path.ts'
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
  test('通常のowner fileと秘密receiptのmode契約を分離する', () => {
    const dir = fixture()
    const publicConfig = join(dir, '.zshrc')
    writeFileSync(publicConfig, 'export SAFE=1\n', { mode: 0o644 })
    expect(readOptionalOwnedRegularFile(publicConfig)).toBe('export SAFE=1\n')
    expect(() => readOptionalOwnerOnlyRegularFile(publicConfig)).toThrow('not owner-only')
    chmodSync(publicConfig, 0o600)
    expect(readOptionalOwnerOnlyRegularFile(publicConfig)).toBe('export SAFE=1\n')
  })

  test('bounded owner-only readerは内容を読む前にsize上限を強制する', () => {
    const dir = fixture()
    const receipt = join(dir, 'receipt.json')
    writeFileSync(receipt, '12345', { mode: 0o600 })
    expect(readOptionalBoundedOwnerOnlyRegularFile(receipt, 5)).toBe('12345')
    expect(() => readOptionalBoundedOwnerOnlyRegularFile(receipt, 4))
      .toThrow('exceeds size bound')
    expect(() => readOptionalBoundedOwnerOnlyRegularFile(receipt, -1))
      .toThrow('invalid managed file size bound')
  })

  test('bounded owner-only readerはFIFOをblockせず拒否する', () => {
    const fifo = join(fixture(), 'receipt.pipe')
    const created = Bun.spawnSync(['/usr/bin/mkfifo', fifo])
    expect(created.exitCode).toBe(0)
    expect(() => readOptionalBoundedOwnerOnlyRegularFile(fifo, 4_096))
      .toThrow('unsafe managed file')
  })

  test('atomic readerはopen直後にdetachされた旧inodeを捨てて現在pathを再読込する', () => {
    const path = join(fixture(), 'progress.json')
    writeFileSync(path, '{"revision":0}\n', { mode: 0o600 })
    const original = fs.fstatSync
    let replaced = false
    const stat = spyOn(fs, 'fstatSync').mockImplementation(descriptor => {
      if (!replaced) {
        replaced = true
        atomicWritePrivateFile(path, '{"revision":1}\n')
      }
      return original(descriptor)
    })
    try {
      expect(readOptionalBoundedAtomicOwnedFile(path, 1_024, 'monitor progress')?.toString())
        .toBe('{"revision":1}\n')
    } finally {
      stat.mockRestore()
    }
  })

  test('atomic readerもhardlinkとsymlinkは再試行せず拒否する', () => {
    const dir = fixture()
    const external = join(dir, 'external.json')
    writeFileSync(external, '{}\n', { mode: 0o600 })
    const hardlink = join(dir, 'hardlink.json')
    const symlink = join(dir, 'symlink.json')
    linkSync(external, hardlink)
    symlinkSync(external, symlink)
    expect(() => readOptionalBoundedAtomicOwnedFile(hardlink, 1_024, 'monitor progress'))
      .toThrow('unsafe monitor progress')
    expect(() => readOptionalBoundedAtomicOwnedFile(symlink, 1_024, 'monitor progress'))
      .toThrow()
  })

  test('managed directory作成はretry時も各direntの親を同期する', () => {
    const root = fixture()
    const original = fs.fsyncSync
    const synchronizedDirectoryDescriptors: number[] = []
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      if (fstatSync(descriptor).isDirectory()) synchronizedDirectoryDescriptors.push(descriptor)
      original(descriptor)
    })
    try {
      ensureManagedDirectory(root, join(root, 'advisor-journal', 'job-123'))
      ensureManagedDirectory(root, join(root, 'advisor-journal', 'job-123'))
    } finally {
      sync.mockRestore()
    }
    expect(synchronizedDirectoryDescriptors).toHaveLength(4)
  })

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
    expect(() => ensureManagedDirectory(state, join(state, 'job-runner.lock')))
      .toThrow('unsafe managed directory')
    expect(readdirSync(external)).toEqual([])
  })

  test('通常logは安全に作成できる', () => {
    const dir = fixture()
    const path = join(dir, 'job.log')
    const descriptor = openSafeLog(path, 'truncate')
    closeSync(descriptor)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('open後のatomic replaceをpathname identityで検出する', () => {
    const dir = fixture()
    const path = join(dir, 'registration.json')
    writeFileSync(path, '{"revision":0}\n', { mode: 0o600 })
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      expect(() => assertDescriptorStillNamesPath(descriptor, path)).not.toThrow()
      atomicWritePrivateFile(path, '{"revision":1}\n')
      expect(() => assertDescriptorStillNamesPath(descriptor, path))
        .toThrow('managed file path changed while open')
    } finally {
      closeSync(descriptor)
    }
  })
})
