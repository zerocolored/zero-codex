import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

// 2026-08-17: 自己更新の検証を手で流すたびに、稼働中のゼロくんが kill されていた
// (実測 7 回)。原因は claude-channel.sh が CLAUDE_CHANNEL_REPLACE=1 だけで
// 既存ボットを kill していたこと。フラグ単独では殺せないことをここで固定する。

const LAUNCHER = join(dirname(import.meta.dir), 'claude-channel.sh')
const BOT_PATTERN = 'dangerously-load-development-channels server:slack-channel'

const tempDirs: string[] = []
const fakeBots: Array<{ kill: () => void }> = []

afterEach(() => {
  for (const bot of fakeBots.splice(0)) bot.kill()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zerokun-launcher-test-'))
  tempDirs.push(dir)
  return dir
}

/** 稼働中ゼロくんの代役。pgrep -f が拾う形の command line を持つ。 */
function startFakeBot(dir: string) {
  const script = join(dir, 'fake-bot.sh')
  writeFileSync(script, '#!/bin/bash\nsleep 30\n')
  chmodSync(script, 0o755)
  const proc = Bun.spawn(['/bin/bash', script, `--${BOT_PATTERN}`], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  fakeBots.push({ kill: () => { try { proc.kill() } catch {} } })
  return proc
}

async function runLauncher(env: Record<string, string>, projectDir: string) {
  const proc = Bun.spawn([LAUNCHER, projectDir], {
    env: { ...process.env, CHANNEL: 'slack', ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { exitCode, output: `${stdout}\n${stderr}` }
}

describe('claude-channel.sh の入れ替えガード', () => {
  test('CLAUDE_CHANNEL_REPLACE=1 だけでは稼働中ボットを kill しない', async () => {
    const dir = makeTempDir()
    const bot = startFakeBot(dir)
    await Bun.sleep(300)

    const result = await runLauncher(
      {
        CLAUDE_CHANNEL_REPLACE: '1',
        CLAUDE_CHANNEL_REPLACE_TOKEN_FILE: join(dir, 'replace-token'),
      },
      dir,
    )

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('有効なワンタイムトークンがありません')
    expect(result.output).toContain('起動を中止しました')
    // 代役が生きたまま = 稼働中ゼロくんが巻き添えで落ちない
    expect(bot.killed).toBe(false)
  })

  test('トークンが一致しなければ kill しない', async () => {
    const dir = makeTempDir()
    const bot = startFakeBot(dir)
    const tokenFile = join(dir, 'replace-token')
    writeFileSync(tokenFile, 'correct-token')
    await Bun.sleep(300)

    const result = await runLauncher(
      {
        CLAUDE_CHANNEL_REPLACE: '1',
        CLAUDE_CHANNEL_REPLACE_TOKEN: 'wrong-token',
        CLAUDE_CHANNEL_REPLACE_TOKEN_FILE: tokenFile,
      },
      dir,
    )

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('起動を中止しました')
    expect(bot.killed).toBe(false)
  })

  test('自己更新が発行したトークンが一致した時だけ入れ替えを許可する', async () => {
    const dir = makeTempDir()
    startFakeBot(dir)
    const tokenFile = join(dir, 'replace-token')
    writeFileSync(tokenFile, 'one-time-token')
    await Bun.sleep(300)

    const result = await runLauncher(
      {
        CLAUDE_CHANNEL_REPLACE: '1',
        CLAUDE_CHANNEL_REPLACE_TOKEN: 'one-time-token',
        CLAUDE_CHANNEL_REPLACE_TOKEN_FILE: tokenFile,
        CLAUDE_CHANNEL_DRY_RUN: '1', // 実機のゼロくんを巻き込まないため kill 手前で止める
      },
      dir,
    )

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('ワンタイムトークンを確認しました')
    expect(existsSync(tokenFile)).toBe(false) // 使い回せない
  })
})
