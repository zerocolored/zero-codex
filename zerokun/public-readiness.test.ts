import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearGatewayReadiness,
  readGatewayReadiness,
  writeGatewayReadiness,
} from './readiness.ts'
import {
  DEFAULT_SLACK_HTTP_TIMEOUT_MS,
  openDirectSlackDownload,
  postDirectSlackApi,
  slackHttpTimeoutMs,
  slackWebClientOptions,
  withSlackDeadline,
} from './slack-http.ts'
import { resolveZeroJobDatabasePath, resolveZeroStateDir } from './state-dir.ts'

describe('public Codex defaults', () => {
  test('repository未取得の新規Macにもmain branch bootstrapの取得手順がある', () => {
    const rootReadme = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8')
    const runtimeReadme = readFileSync(join(import.meta.dir, 'README.md'), 'utf8')
    const setupGuide = readFileSync(join(import.meta.dir, 'NEW_MAC_SETUP.md'), 'utf8')
    const bootstrap = readFileSync(join(import.meta.dir, 'bootstrap-macos.sh'), 'utf8')
    const codexVersion = readFileSync(join(import.meta.dir, 'codex-version.sh'), 'utf8')
    const rawBootstrap = 'https://raw.githubusercontent.com/zerocolored/zero-codex/main/zerokun/bootstrap-macos.sh'
    for (const guide of [rootReadme, runtimeReadme, setupGuide]) {
      expect(guide).toContain(rawBootstrap)
      expect(guide).toContain('/usr/bin/mktemp -d /tmp/zerokun-bootstrap.XXXXXX')
      expect(guide).toContain('/usr/bin/env -i PATH=/usr/bin:/bin TMPDIR=/tmp')
      expect(guide).toContain("/usr/bin/curl -q --fail --location --proto '=https'")
      expect(guide).toContain("--noproxy '*'")
      expect(guide).toContain('--output "$bootstrap_path"')
      expect(guide).toContain('--with-slack')
    }
    expect(codexVersion).not.toContain('curl -fsSL')
    expect(codexVersion).toContain('bash zerokun/bootstrap-macos.sh --skip-slack')
    expect(rootReadme).toContain('新しいSlack App')
    expect(rootReadme).toContain('tokenをこのPCへコピーしないでください')
    expect(setupGuide).toContain('そのSlack Appやtokenも流用しません')
    expect(bootstrap).toContain('このCodex版用に新しいAppを作成してください')
    expect(bootstrap).toContain('xapp-/xoxb-トークンは使用しません')
  })

  test('legacy stateや互換envを暗黙採用せずCodex stateを既定にする', () => {
    const home = '/Users/tester'
    expect(resolveZeroStateDir({ ZEROKUN_STATE_DIR: '/explicit' }, home))
      .toBe('/explicit')
    expect(resolveZeroStateDir({ SLACK_STATE_DIR: '/legacy-compat' }, home))
      .toBe(join(home, '.codex/zerokun'))
    expect(resolveZeroStateDir({ ZEROKUN_STATE_DIR: join(home, '.claude/channels/slack') }, home))
      .toBe(join(home, '.codex/zerokun'))
    expect(resolveZeroStateDir({
      ZEROKUN_STATE_DIR: join(home, '.claude/channels/../channels/slack/'),
    }, home)).toBe(join(home, '.codex/zerokun'))
    expect(() => resolveZeroStateDir({
      ZEROKUN_STATE_DIR: join(home, '.claude/channels/slack'),
      ZEROKUN_LEGACY_CUTOVER: '1',
    }, home)).toThrow('legacy cutover state')
    expect(resolveZeroStateDir({}, home)).toBe(join(home, '.codex/zerokun'))
  })

  test('shell resolverもlegacy fileとSLACK_STATE_DIRを無視する', () => {
    const home = mkdtempSync(join(tmpdir(), 'zerokun-state-default-'))
    const legacy = join(home, '.claude/channels/slack')
    const alias = join(home, 'legacy-state-alias')
    try {
      mkdirSync(legacy, { recursive: true })
      symlinkSync(legacy, alias)
      writeFileSync(join(legacy, '.env'), '', { mode: 0o600 })
      expect(() => resolveZeroStateDir({
        ZEROKUN_STATE_DIR: legacy,
        ZEROKUN_LEGACY_CUTOVER: '1',
      }, home)).toThrow('valid Slack App tokens')
      const legacyEnvironment = [
        'LEGACY_SENTINEL=keep',
        'SLACK_BOT_TOKEN=xoxb-existing-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-A0123456789-existing-not-a-real-token',
        '',
      ].join('\n')
      writeFileSync(join(legacy, '.env'), legacyEnvironment, { mode: 0o600 })
      expect(resolveZeroStateDir({ ZEROKUN_STATE_DIR: alias }, home))
        .toBe(join(home, '.codex/zerokun'))
      for (const configured of [
        legacy,
        `${join(home, '.claude/channels/../channels/slack')}//`,
        alias,
      ]) {
        const result = Bun.spawnSync([
          '/bin/bash', '-c', '. "$1"; zerokun_resolve_state_dir', '_',
          join(import.meta.dir, 'state-dir.sh'),
        ], {
          env: {
            ...process.env,
            HOME: home,
            SLACK_STATE_DIR: legacy,
            ZEROKUN_STATE_DIR: configured,
            ZEROKUN_LEGACY_CUTOVER: '0',
          },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        expect(result.stdout.toString().trim()).toBe(join(home, '.codex/zerokun'))
      }
      const cutover = Bun.spawnSync([
        '/bin/bash', '-c', '. "$1"; zerokun_resolve_state_dir', '_',
        join(import.meta.dir, 'state-dir.sh'),
      ], {
        env: {
          ...process.env,
          HOME: home,
          ZEROKUN_STATE_DIR: `${legacy}/`,
          ZEROKUN_LEGACY_CUTOVER: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(cutover.exitCode, cutover.stderr.toString()).toBe(0)
      expect(cutover.stdout.toString().trim()).toBe(`${legacy}/`)
      expect(readFileSync(join(legacy, '.env'), 'utf8')).toBe(legacyEnvironment)

      const symlinkHome = join(home, 'symlink-home')
      const physicalClaude = join(home, 'config/claude-home')
      const physicalLegacy = join(physicalClaude, 'channels/slack')
      mkdirSync(symlinkHome, { recursive: true })
      mkdirSync(physicalLegacy, { recursive: true })
      symlinkSync(physicalClaude, join(symlinkHome, '.claude'))
      for (const configured of [join(symlinkHome, '.claude/channels/slack'), physicalLegacy]) {
        expect(resolveZeroStateDir({ ZEROKUN_STATE_DIR: configured }, symlinkHome))
          .toBe(join(symlinkHome, '.codex/zerokun'))
        const shell = Bun.spawnSync([
          '/bin/bash', '-c', '. "$1"; zerokun_resolve_state_dir', '_',
          join(import.meta.dir, 'state-dir.sh'),
        ], {
          env: {
            ...process.env,
            HOME: symlinkHome,
            ZEROKUN_STATE_DIR: configured,
            ZEROKUN_LEGACY_CUTOVER: '0',
          },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(shell.exitCode, shell.stderr.toString()).toBe(0)
        expect(shell.stdout.toString().trim()).toBe(join(symlinkHome, '.codex/zerokun'))

        const bootstrap = Bun.spawnSync([
          '/bin/bash', '-c',
          'bootstrap_path="$1"; set --; . "$bootstrap_path"; printf "%s\\n" "$STATE_DIR"', '_',
          join(import.meta.dir, 'bootstrap-macos.sh'),
        ], {
          env: {
            ...process.env,
            HOME: symlinkHome,
            ZEROKUN_STATE_DIR: configured,
            ZEROKUN_LEGACY_CUTOVER: '0',
          },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(bootstrap.exitCode, bootstrap.stderr.toString()).toBe(0)
        expect(bootstrap.stdout.toString().trim()).toBe(join(symlinkHome, '.codex/zerokun'))
      }
      writeFileSync(
        join(physicalLegacy, '.codex-legacy-cutover'),
        `zerokun-codex-legacy-cutover-v1\n${realpathSync(physicalLegacy)}\n`,
        { mode: 0o600 },
      )
      rmSync(join(symlinkHome, '.claude'))
      expect(resolveZeroStateDir({
        ZEROKUN_STATE_DIR: physicalLegacy,
        ZEROKUN_LEGACY_CUTOVER: '0',
      }, symlinkHome)).toBe(join(symlinkHome, '.codex/zerokun'))
      const establishedShell = Bun.spawnSync([
        '/bin/bash', '-c', '. "$1"; zerokun_resolve_state_dir', '_',
        join(import.meta.dir, 'state-dir.sh'),
      ], {
        env: {
          ...process.env,
          HOME: symlinkHome,
          ZEROKUN_STATE_DIR: physicalLegacy,
          ZEROKUN_LEGACY_CUTOVER: '0',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(establishedShell.exitCode, establishedShell.stderr.toString()).toBe(0)
      expect(establishedShell.stdout.toString().trim()).toBe(join(symlinkHome, '.codex/zerokun'))
      const establishedBootstrap = Bun.spawnSync([
        '/bin/bash', '-c',
        'bootstrap_path="$1"; set --; . "$bootstrap_path"; printf "%s\\n" "$STATE_DIR"', '_',
        join(import.meta.dir, 'bootstrap-macos.sh'),
      ], {
        env: {
          ...process.env,
          HOME: symlinkHome,
          ZEROKUN_STATE_DIR: physicalLegacy,
          ZEROKUN_LEGACY_CUTOVER: '0',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(establishedBootstrap.exitCode, establishedBootstrap.stderr.toString()).toBe(0)
      expect(establishedBootstrap.stdout.toString().trim()).toBe(join(symlinkHome, '.codex/zerokun'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('cutover入口は存在しないlegacy stateを作らず、DB overrideもstate内へ閉じる', () => {
    const home = mkdtempSync(join(tmpdir(), 'zerokun-cutover-entrypoints-'))
    const legacy = join(home, '.claude/channels/slack')
    const state = join(home, '.codex/zerokun')
    const outsideDb = join(legacy, 'jobs.sqlite3')
    try {
      const environment = {
        ...process.env,
        HOME: home,
        ZEROKUN_STATE_DIR: legacy,
        ZEROKUN_LEGACY_CUTOVER: '1',
      }
      for (const command of [
        ['/bin/bash', join(import.meta.dir, 'bootstrap-macos.sh'), '--slack-only'],
        ['/bin/bash', join(import.meta.dir, '..', 'codex-channel.sh')],
        [process.execPath, join(import.meta.dir, 'update.ts'), '--recover-only'],
      ]) {
        const result = Bun.spawnSync(command, {
          env: environment,
          stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        })
        expect(result.exitCode).not.toBe(0)
        expect(existsSync(legacy)).toBe(false)
      }
      mkdirSync(state, { recursive: true })
      expect(() => resolveZeroJobDatabasePath(state, { ZEROKUN_JOB_DB: outsideDb }))
        .toThrow("must be the selected state's jobs.sqlite3")
      expect(existsSync(legacy)).toBe(false)
      expect(() => resolveZeroJobDatabasePath(state, {
        ZEROKUN_JOB_DB: join(state, 'custom', 'jobs.sqlite3'),
      })).toThrow("must be the selected state's jobs.sqlite3")
      expect(resolveZeroJobDatabasePath(state, {}))
        .toBe(join(realpathSync(state), 'jobs.sqlite3'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('Slack HTTPはretryを外側の永続queueへ委ね、deadlineを持つ', async () => {
    expect(slackHttpTimeoutMs('invalid')).toBe(DEFAULT_SLACK_HTTP_TIMEOUT_MS)
    expect(slackHttpTimeoutMs('250')).toBe(250)
    expect(slackWebClientOptions(500)).toEqual({ timeout: 500, retryConfig: { retries: 0 } })
    await expect(withSlackDeadline(
      () => new Promise<void>(() => {}),
      20,
      'test Slack request',
    )).rejects.toThrow('test Slack request timed out after 20ms')
  })

  test('Slack bearer通信はproxy非使用のdirect HTTPSだけを許可する', async () => {
    await expect(openDirectSlackDownload(
      'https://example.com/not-slack',
      'xoxb-not-a-real-token',
    )).rejects.toThrow('refusing non-Slack attachment URL')
    await expect(postDirectSlackApi(
      '../invalid',
      'xoxb-not-a-real-token',
      {},
    )).rejects.toThrow('invalid Slack API method')
    const server = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    expect(server).toContain('openDirectSlackDownload(file.url_private_download')
    expect(server).not.toContain('fetch(file.url_private_download')
    expect(runner).toContain("postDirectSlackApi(\n        'chat.postMessage'")
    expect(runner).not.toContain("fetch(\n        'https://slack.com/api/chat.postMessage'")
  })

  test('gateway readinessは接続releaseとPIDをatomic markerに記録する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-readiness-'))
    const path = join(dir, 'gateway-ready.json')
    try {
      writeGatewayReadiness(path, 'abc123', 4321)
      expect(readGatewayReadiness(path)).toMatchObject({
        runtime: 'codex',
        pid: 4321,
        release: 'abc123',
      })
      expect(JSON.parse(readFileSync(path, 'utf8')).connectedAt).toBeGreaterThan(0)
      clearGatewayReadiness(path, 9999)
      expect(existsSync(path)).toBe(true)
      clearGatewayReadiness(path, 4321)
      expect(existsSync(path)).toBe(false)
      mkdirSync(join(dir, 'nested'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
