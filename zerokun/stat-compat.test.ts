import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 2026-10-09: state-dir.sh / setup.sh / codex-channel.sh / watchdog.sh は BSD の
// `stat -f` を直接呼んでいて、Linux (GNU stat) では所有者・link 数・権限・種別が
// 読めず owner-only 検査が全部 false になっていた（watchdog.test.ts 8 件・
// public-readiness の shell resolver が WSL2 で落ちる）。両カーネルで同じ値を返す
// shim をここで固定する。

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function shell(script: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(['/bin/bash', '-c', `. "$1"; ${script}`, '_', join(import.meta.dir, 'stat-compat.sh')], {
    env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe',
  })
  return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString() }
}

describe('stat-compat.sh', () => {
  test.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    '所有者・link数・権限・種別をmacOSとLinuxで同じ形で返す', () => {
    const root = mkdtempSync(join(tmpdir(), 'zerokun-stat-compat-'))
    roots.push(root)
    const file = join(root, 'file')
    const dir = join(root, 'dir')
    const link = join(root, 'link')
    const hard = join(root, 'hard')
    writeFileSync(file, 'x\n', { mode: 0o600 })
    chmodSync(file, 0o600)
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    symlinkSync(file, link)
    const uid = String(process.getuid!())

    expect(shell(`zerokun_stat_owner "$2"`, {}).code).toBe(1) // 引数なしは失敗
    expect(shell(`zerokun_stat_owner ${JSON.stringify(file)}`).out).toBe(uid)
    expect(shell(`zerokun_stat_links ${JSON.stringify(file)}`).out).toBe('1')
    expect(shell(`zerokun_stat_owner_links ${JSON.stringify(file)}`).out).toBe(`${uid}:1`)
    expect(shell(`zerokun_stat_perm ${JSON.stringify(file)}`).out).toBe('600')
    expect(shell(`zerokun_stat_perm ${JSON.stringify(dir)}`).out).toBe('700')
    expect(shell(`zerokun_stat_type ${JSON.stringify(file)}`).out).toBe('regular')
    expect(shell(`zerokun_stat_type ${JSON.stringify(dir)}`).out).toBe('directory')
    // symlink 自体を見る（辿らない）
    expect(shell(`zerokun_stat_type ${JSON.stringify(link)}`).out).toBe('symlink')
    expect(shell(`zerokun_stat_owner_links ${JSON.stringify(link)}`).out).toBe(`${uid}:1`)

    linkSync(file, hard)
    expect(shell(`zerokun_stat_links ${JSON.stringify(file)}`).out).toBe('2')

    const missing = shell(`zerokun_stat_owner_links ${JSON.stringify(join(root, 'missing'))}`)
    expect(missing.code).toBe(1)
    expect(missing.out).toBe('')
    },
  )

  test.skipIf(process.platform !== 'linux')('Linuxのstate-dir.shはowner-only判定が実際に通る', () => {
    const root = mkdtempSync(join(tmpdir(), 'zerokun-stat-compat-state-'))
    roots.push(root)
    const env = join(root, '.env')
    writeFileSync(env, 'SLACK_BOT_TOKEN=xoxb-not-a-real-token-0001\nSLACK_APP_TOKEN=xapp-1-A0-not-a-real-token-0001\n', { mode: 0o600 })
    const result = Bun.spawnSync(['/bin/bash', '-c', '. "$1"; zerokun_owned_regular_file "$2" && zerokun_valid_slack_environment "$3" && echo ok', '_',
      join(import.meta.dir, 'state-dir.sh'), env, root], { stdout: 'pipe', stderr: 'pipe' })
    expect(result.stderr.toString()).toBe('')
    expect(result.stdout.toString().trim()).toBe('ok')
  })
})
