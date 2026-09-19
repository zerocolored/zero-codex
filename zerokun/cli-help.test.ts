import { expect, test } from 'bun:test'
import { resolve } from 'path'

test('help works before credentials, Bun lookup, project selection or startup', () => {
  for (const args of [['help'], ['--help'], ['start', '--help'], ['set', 'slack-app', '--help']]) {
    const result = Bun.spawnSync(['/bin/bash', resolve(import.meta.dir, '../codex-channel.sh'), ...args], {
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent-zerochan-help' },
      cwd: '/private/tmp',
    })
    expect(result.exitCode).toBe(0)
    const output = result.stdout.toString()
    expect(output).toContain('zerochan set slack-app')
    expect(output).toContain('zerochan set slack-channel')
    expect(result.stderr.toString()).toBe('')
  }
})

test('each command has specific help without runtime dependencies', () => {
  const cases = { stop: '実行中の作業も中断', status: 'チャンネル紐付け', update: '--recover-only', cloud: 'activate:', unset: '登録情報は削除しません', '--restart': '保存済みの起動プロジェクト' }
  for (const [command, expected] of Object.entries(cases)) {
    const result = Bun.spawnSync(['/bin/bash', resolve(import.meta.dir, '../codex-channel.sh'), 'help', command], {
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent-zerochan-help' }, cwd: '/private/tmp',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain(expected)
    expect(result.stderr.toString()).toBe('')
  }
})
