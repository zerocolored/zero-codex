import { expect, test } from 'bun:test'
import { resolve } from 'path'
import { readFileSync } from 'fs'

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

const publicCommands = [
  ['start'], ['stop'], ['stop', '--force'], ['--restart'], ['status'],
  ['update'], ['update', '--recover-only'],
  ...['on', 'off', 'status'].map(value => ['auto-update', value]),
  ['set', 'slack-app'], ['set', 'slack-channel', 'C0123456789'], ['unset', 'slack-channel'],
  ['set', 'core'], ['set', 'core', 'codex'], ['set', 'core', 'claude'],
  ...['login', 'activate', 'status'].map(value => ['cloud', value]),
  ...['identity', 'status', 'off'].map(value => ['fleet', value]),
  ['fleet', 'register', 'test-instance', 'test-auth-app'],
  ...[
    ['status'], ['target', 'https://example.invalid'], ['active', 'on'], ['active', 'off'],
    ['auth', 'required'], ['auth', 'none'], ['e2e-port', '3000'],
    ['auth-probe', '/account', 'Logged in'], ['socket-org', 'test-org'], ['socket-token'],
    ['semgrep-repo', 'owner/repo'], ['semgrep-token'], ['image', 'test:latest'],
  ].map(args => ['security', ...args]),
]

function help(args: string[]) {
  return Bun.spawnSync(['/bin/bash', resolve(import.meta.dir, '../codex-channel.sh'), ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent-zerochan-help' },
    cwd: '/private/tmp', timeout: 3000,
  })
}

for (const args of publicCommands) {
  test(`public command help is side-effect free: ${args.join(' ')}`, () => {
    const group = help(['help', args[0]!])
    expect(group.exitCode).toBe(0)
    for (const flag of ['--help', '-h']) {
      const result = help([...args, flag])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe(group.stdout.toString())
      expect(result.stderr.toString()).toBe('')
    }
  })
}

test('top-level help lists every public command family, option and operator entrypoint', () => {
  const result = help(['help'])
  expect(result.exitCode).toBe(0)
  const text = result.stdout.toString()
  const lines = text.split('\n').map(line => line.trim())
  for (const args of publicCommands) {
    // Arguments are deliberately grouped as on|off|status, but each family
    // and concrete subcommand must remain discoverable in the top-level list.
    const matched = lines.some(line => {
      const words = line.split(/\s+/)
      return words[0] === 'zerochan' && args.slice(0, args[0] === 'set' ? 2 : ['security', 'fleet', 'cloud', 'auto-update', 'unset'].includes(args[0]!) ? 2 : args[1]?.startsWith('--') ? 2 : 1)
        .every((word, index) => words[index + 1]?.split('|').includes(word))
    })
    expect(matched).toBe(true)
  }
  for (const entry of ['zerochan-access policy pairing|allowlist|disabled', 'zerokun-status',
    'zerokun-jobs status', 'zerokun-jobs runtime-info', 'zerokun-jobs gc',
    'codex-channel [project-directory]', 'zerochan help [command]', 'zerochan --help', 'zerochan -h']) {
    expect(text).toContain(entry)
  }
  expect(help(['--help']).stdout.toString()).toBe(text)
  expect(help(['-h']).stdout.toString()).toBe(text)
})

test('help reports exact unset, native release, fleet and credential-input contracts', () => {
  expect(help(['help', 'unset']).stdout.toString()).toContain('すべて解除')
  expect(help(['help', 'unset']).stdout.toString()).toContain('チャンネルIDは付けません')
  expect(help(['help', 'update']).stdout.toString()).toContain('開発用cloneはpullしません')
  expect(help(['help', 'fleet']).stdout.toString()).toContain('cloud loginは不要')
  const security = help(['help', 'security']).stdout.toString()
  for (const text of ['このコマンド自体は検査を実行しません', 'activeをoffへ戻す',
    '先にtargetが必要', '非表示の対話入力', '引数へ渡さない', '既存一覧は保持']) expect(security).toContain(text)
  const unknown = help(['help', 'nonexistent-command'])
  expect(unknown.exitCode).toBe(2)
  expect(unknown.stderr.toString()).toContain('不明なヘルプ項目')
})


test('public dispatch additions require discoverable top-level and detail help', () => {
  const source = readFileSync(resolve(import.meta.dir, '../codex-channel.sh'), 'utf8')
  const commands = new Set([...source.matchAll(/\[\s*"(?:\$1|\$\{1:-\})" = "([^"]+)"/g)].map(match => match[1]!))
  expect(commands.size).toBeGreaterThan(10)
  const overview = help(['help']).stdout.toString()
  for (const command of commands) {
    if (['help', '--help', '-h'].includes(command)) continue
    expect(overview).toContain(`zerochan ${command}`)
    expect(help(['help', command]).exitCode).toBe(0)
  }
  for (const [family, file] of [['security', 'security-audit-config.ts'], ['fleet', 'fleet-setup.ts']]) {
    const implementation = readFileSync(resolve(import.meta.dir, file!), 'utf8')
    const commands = new Set([...implementation.matchAll(/command === '([^']+)'/g)].map(match => match[1]!))
    expect(commands.size).toBeGreaterThan(3)
    for (const command of commands) expect(overview).toContain(`zerochan ${family} ${command}`)
  }
})

test('help describes automatic notification and cloud activation without obsolete side effects', () => {
  const automatic = help(['help', 'auto-update']).stdout.toString()
  expect(automatic).toContain('DM許可リスト')
  expect(automatic).toContain('チャンネルへは送信しません')
  const cloud = help(['help', 'cloud']).stdout.toString()
  expect(cloud).toContain('この時点では引き継ぎは有効になりません')
  expect(cloud).toContain('zerochan stop → zerochan start')
  expect(help(['help', 'start']).stdout.toString()).toContain('Herdr外では専用workspace')
  const launcher = readFileSync(resolve(import.meta.dir, '../codex-channel.sh'), 'utf8')
  expect(launcher).toContain('使い方: zerochan <command>')
  expect(launcher).not.toContain('使い方: zerochan | zerochan start |')
})
