import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const RUNTIME = join(import.meta.dir, 'grok-reviewer', 'reviewer-runtime.py')
const SCOPE = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function unsignedJwt(issuedAt: number): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ iat: issuedAt, exp: issuedAt + 21_600 })}.sig`
}

function authJson(issuedAt: number, email = 'ai01@zerocolored.co.jp'): string {
  return JSON.stringify({
    [SCOPE]: {
      key: unsignedJwt(issuedAt),
      auth_mode: 'oidc',
      email,
      refresh_token: `refresh-${issuedAt}`,
    },
  })
}

function fixture(): { home: string; reviewerRoot: string; runRoot: string; runAuth: string; hostAuth: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'zerokun-auth-sync-')))
  temporaryRoots.push(home)
  chmodSync(home, 0o700)
  const reviewerRoot = join(home, '.zerokun', 'runtime', 'grok-reviewer')
  mkdirSync(reviewerRoot, { recursive: true, mode: 0o700 })
  chmodSync(join(home, '.zerokun'), 0o700)
  chmodSync(join(home, '.zerokun', 'runtime'), 0o700)
  const runRoot = join(reviewerRoot, 'run.test')
  const runGrokHome = join(runRoot, 'user-home', '.grok')
  mkdirSync(runGrokHome, { recursive: true, mode: 0o700 })
  chmodSync(runRoot, 0o700)
  chmodSync(join(runRoot, 'user-home'), 0o700)
  mkdirSync(join(home, '.grok'), { mode: 0o700 })
  return {
    home,
    reviewerRoot,
    runRoot,
    runAuth: join(runGrokHome, 'auth.json'),
    hostAuth: join(home, '.grok', 'auth.json'),
  }
}

function syncAuthBack(reviewerRoot: string, runRoot: string): number {
  const result = spawnSync('/usr/bin/python3', ['-I', RUNTIME, 'sync-auth-back', reviewerRoot, runRoot], {
    encoding: 'utf8',
  })
  expect(result.stdout).toBe('')
  return result.status ?? -1
}

describe('sync-auth-back', () => {
  test('runでリフレッシュされた新しいトークンをホストのauth.jsonへ書き戻す', () => {
    const { reviewerRoot, runRoot, runAuth, hostAuth } = fixture()
    writeFileSync(hostAuth, authJson(1_000_000), { mode: 0o600 })
    writeFileSync(runAuth, authJson(2_000_000), { mode: 0o600 })
    expect(syncAuthBack(reviewerRoot, runRoot)).toBe(0)
    expect(readFileSync(hostAuth, 'utf8')).toBe(authJson(2_000_000))
    expect(lstatSync(hostAuth).mode & 0o777).toBe(0o600)
  })

  test('ホストが消されていても（自動復旧のパージ後）runのコピーから復元する', () => {
    const { reviewerRoot, runRoot, runAuth, hostAuth } = fixture()
    writeFileSync(runAuth, authJson(2_000_000), { mode: 0o600 })
    expect(syncAuthBack(reviewerRoot, runRoot)).toBe(0)
    expect(readFileSync(hostAuth, 'utf8')).toBe(authJson(2_000_000))
    expect(lstatSync(hostAuth).mode & 0o777).toBe(0o600)
  })

  test('runのトークンが古い・同時刻なら書き戻さない', () => {
    const { reviewerRoot, runRoot, runAuth, hostAuth } = fixture()
    writeFileSync(hostAuth, authJson(2_000_000), { mode: 0o600 })
    writeFileSync(runAuth, authJson(1_000_000), { mode: 0o600 })
    expect(syncAuthBack(reviewerRoot, runRoot)).toBe(3)
    expect(readFileSync(hostAuth, 'utf8')).toBe(authJson(2_000_000))
  })

  test('バイト一致なら何もしない', () => {
    const { reviewerRoot, runRoot, runAuth, hostAuth } = fixture()
    writeFileSync(hostAuth, authJson(2_000_000), { mode: 0o600 })
    writeFileSync(runAuth, authJson(2_000_000), { mode: 0o600 })
    expect(syncAuthBack(reviewerRoot, runRoot)).toBe(3)
  })

  test('同一スコープのアカウントが違うなら書き戻さない', () => {
    const { reviewerRoot, runRoot, runAuth, hostAuth } = fixture()
    writeFileSync(hostAuth, authJson(1_000_000), { mode: 0o600 })
    writeFileSync(runAuth, authJson(2_000_000, 'attacker@example.com'), { mode: 0o600 })
    expect(syncAuthBack(reviewerRoot, runRoot)).toBe(3)
    expect(readFileSync(hostAuth, 'utf8')).toBe(authJson(1_000_000))
  })

  test('runにauth.jsonが無ければ何もしない', () => {
    const { reviewerRoot, runRoot, hostAuth } = fixture()
    writeFileSync(hostAuth, authJson(1_000_000), { mode: 0o600 })
    expect(syncAuthBack(reviewerRoot, runRoot)).toBe(3)
    expect(readFileSync(hostAuth, 'utf8')).toBe(authJson(1_000_000))
  })

  test('壊れたJSON・iat無しのrun authは採用しない', () => {
    const { reviewerRoot, runRoot, runAuth, hostAuth } = fixture()
    writeFileSync(hostAuth, authJson(1_000_000), { mode: 0o600 })
    writeFileSync(runAuth, '{not json', { mode: 0o600 })
    expect(syncAuthBack(reviewerRoot, runRoot)).toBe(3)
    writeFileSync(runAuth, JSON.stringify({ [SCOPE]: { auth_mode: 'oidc' } }), { mode: 0o600 })
    expect(syncAuthBack(reviewerRoot, runRoot)).toBe(3)
    expect(readFileSync(hostAuth, 'utf8')).toBe(authJson(1_000_000))
  })

  test('reviewer_root配下でないrun_rootは拒否する', () => {
    const { reviewerRoot, home } = fixture()
    const outside = join(home, 'run.outside')
    mkdirSync(outside, { mode: 0o700 })
    expect(syncAuthBack(reviewerRoot, outside)).not.toBe(0)
  })
})

describe('run後の自動書き戻し', () => {
  test('run終了時（runディレクトリ削除前）に新トークンがホストへ残る', () => {
    const { reviewerRoot, runRoot, runAuth, hostAuth } = fixture()
    writeFileSync(hostAuth, authJson(1_000_000), { mode: 0o600 })
    writeFileSync(runAuth, authJson(1_000_000), { mode: 0o600 })
    // 本物の grok と同じく「ホストCPUのネイティブ実行ファイル」検査を通す必要が
    // あるため、実行中の bun バイナリを疑似 grok として複製する
    const pinned = join(runRoot, 'official-grok')
    copyFileSync(process.execPath, pinned)
    chmodSync(pinned, 0o700)
    const refresh = `require('fs').writeFileSync(${JSON.stringify(runAuth)}, ${JSON.stringify(authJson(2_000_000))})`
    const result = spawnSync(
      '/usr/bin/python3',
      ['-I', RUNTIME, 'run', reviewerRoot, runRoot, '--', pinned, '-e', refresh],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(0)
    expect(existsSync(runRoot)).toBe(false)
    expect(readFileSync(hostAuth, 'utf8')).toBe(authJson(2_000_000))
  })
})
