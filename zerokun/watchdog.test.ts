import { describe, expect, test } from 'bun:test'
import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const watchdog = join(import.meta.dir, 'watchdog.sh')
const watchdogSource = readFileSync(watchdog, 'utf8')

describe('Zero-kun watchdog', () => {
  test('selftestで連続down・再通知抑制・復旧・muteの状態遷移を検証する', () => {
    const result = Bun.spawnSync(['/bin/bash', watchdog, '--selftest'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = new TextDecoder().decode(result.stdout)
    const stderr = new TextDecoder().decode(result.stderr)

    expect(result.exitCode, stderr).toBe(0)
    expect(stdout).toContain('ok: healthy sends nothing')
    expect(stdout).toContain('ok: active update maintenance suppresses down alert')
    expect(stdout).toContain('ok: stale update maintenance resumes down alert')
    expect(stdout).toContain('ok: active restart maintenance suppresses down alert')
    expect(stdout).toContain('ok: stale restart maintenance resumes down alert')
    expect(stdout).toContain('ok: intentional stop suppresses down alert')
    expect(stdout).toContain('ok: transient down sends nothing')
    expect(stdout).toContain('ok: second down sends alert')
    expect(stdout).toContain('ok: down reminder is suppressed')
    expect(stdout).toContain('ok: reminder is sent after interval')
    expect(stdout).toContain('ok: recovery sends once')
    expect(stdout).toContain('ok: watchdog-off mutes notifications')
    expect(stdout).toContain('watchdog selftest: PASS')
  }, 10_000)

  test('launchd templateはDesktopでなくstate dirのinstalled scriptを実行する', () => {
    const plist = readFileSync(
      join(import.meta.dir, 'templates/com.zerokun.watchdog.plist.template'),
      'utf8',
    )
    expect(plist).toContain('<string>__STATE_DIR__/watchdog.sh</string>')
    expect(plist).toContain('<key>ZEROKUN_STATE_DIR</key>')
    expect(plist).toContain('<key>ZEROKUN_LEGACY_CUTOVER</key>')
    expect(plist).toContain('<key>StartInterval</key>')
    expect(plist).toContain('<integer>60</integer>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist.match(/<string>\/dev\/null<\/string>/g)?.length).toBe(2)
    expect(plist).not.toContain('__STATE_DIR__/watchdog.log')
    expect(plist).not.toContain('Desktop')
  })

  test('watchdogはsymlinkを追う独自log truncateを行わない', () => {
    expect(watchdogSource).not.toContain(': > "$LOG_FILE"')
  })

  test('Slack alertは表示名を固定せず内部component名を出さない', () => {
    const start = watchdogSource.indexOf('alert = "✅ 応答できる状態に復旧しました。"')
    const alertProgram = watchdogSource.slice(
      start,
      watchdogSource.indexOf('with open(next_path', start),
    )
    expect(alertProgram).toContain('現在、応答できない状態です')
    expect(alertProgram).toContain('zerochan stop → zerochan start')
    expect(alertProgram).not.toContain('Zeroちゃん')
    expect(alertProgram).toContain('zerochan start')
    expect(alertProgram).not.toContain('zerokun-restart')
    expect(alertProgram).not.toContain('bridge:')
    expect(alertProgram).not.toContain('job-runner:')
    expect(alertProgram).not.toContain('Codex')
    expect(alertProgram).not.toContain('Claude')
    expect(alertProgram).not.toContain('Grok')
    expect(alertProgram).not.toContain('Herdr')
    expect(alertProgram).not.toContain('App Server')
    expect(alertProgram).not.toContain('worker')
  })

  test('Slack API呼び出しは10秒でtimeoutする', () => {
    expect(watchdogSource.match(/--max-time 10/g)?.length).toBe(4)
  })

  test('Slack tokenをcurl argvや子process環境へ渡さない', () => {
    expect(watchdogSource).toContain('unset SLACK_BOT_TOKEN SLACK_APP_TOKEN')
    expect(watchdogSource).toContain('WATCHDOG_BOT_TOKEN=""')
    expect(watchdogSource).toContain('WATCHDOG_APP_TOKEN=""')
    expect(watchdogSource).toContain('WATCHDOG_BOT_TOKEN="${line#SLACK_BOT_TOKEN=}"')
    expect(watchdogSource).toContain('WATCHDOG_APP_TOKEN="${line#SLACK_APP_TOKEN=}"')
    expect(watchdogSource).toContain('export -n WATCHDOG_BOT_TOKEN')
    expect(watchdogSource).not.toContain('export SLACK_BOT_TOKEN')
    expect(watchdogSource).not.toContain('-H "Authorization: Bearer $SLACK_BOT_TOKEN"')
    expect(watchdogSource.match(/-H @-/g)?.length).toBe(4)
    expect(watchdogSource.match(/printf 'Authorization: Bearer %s\\n'/g)?.length).toBe(4)
    expect(watchdogSource).toContain('CURL_BIN=/usr/bin/curl')
    expect(watchdogSource.match(/"\$CURL_BIN" -q/g)?.length).toBe(4)
    expect(watchdogSource.match(/--proxy '' --noproxy '\*'/g)?.length).toBe(4)

    const state = mkdtempSync(join(tmpdir(), 'zerokun-watchdog-env-'))
    try {
      writeFileSync(join(state, '.env'), [
        'SLACK_BOT_TOKEN=xoxb-state-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-A0123456789-state-not-a-real-token',
        '',
      ].join('\n'), { mode: 0o600 })
      const result = Bun.spawnSync(['/bin/bash', watchdog, '--selftest-environment'], {
        env: {
          ...process.env,
          ZEROKUN_STATE_DIR: state,
          SLACK_BOT_TOKEN: 'xoxb-sentinel-not-a-real-token',
          WATCHDOG_BOT_TOKEN: 'exported-parent-placeholder',
          HTTPS_PROXY: 'http://user:password@proxy.invalid',
          http_proxy: 'http://user:password@proxy.invalid',
          CURL_CA_BUNDLE: '/tmp/untrusted-ca.pem',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain('watchdog environment selftest: PASS')
      expect(result.stdout.toString()).not.toContain('xoxb-sentinel')
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  })

  test('異なるSlack Appのtoken pairは通知curl境界で拒否する', () => {
    const state = mkdtempSync(join(tmpdir(), 'zerokun-watchdog-identity-'))
    const fakeCurl = join(state, 'fake-curl')
    const curlLog = join(state, 'curl.log')
    try {
      writeFileSync(join(state, '.env'), [
        'SLACK_BOT_TOKEN=xoxb-old-app-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-ANEWAPP123-abcdefghijklmnopqrstuvwxyz',
        '',
      ].join('\n'), { mode: 0o600 })
      writeFileSync(fakeCurl, [
        '#!/bin/bash',
        '/bin/cat >/dev/null',
        'printf \'%s\\n\' "$*" >> "$ZEROKUN_WATCHDOG_TEST_LOG"',
        'case "$*" in',
        '  *auth.test*) printf \'%s\\n\' \'{"ok":true,"app_id":"AOLDAPP123","bot_id":"BOLDAPP123"}\' ;;',
        '  *) printf \'%s\\n\' \'{"ok":true}\' ;;',
        'esac',
        '',
      ].join('\n'), { mode: 0o700 })
      const result = Bun.spawnSync(['/bin/bash', watchdog, '--selftest-notification'], {
        env: {
          ...process.env,
          ZEROKUN_STATE_DIR: state,
          ZEROKUN_WATCHDOG_TEST_CURL: fakeCurl,
          ZEROKUN_WATCHDOG_TEST_LOG: curlLog,
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('identity mismatch')
      const requests = readFileSync(curlLog, 'utf8')
      expect(requests).toContain('auth.test')
      expect(requests).not.toContain('conversations.open')
      expect(requests).not.toContain('chat.postMessage')
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  })

  test('symlink化された.claudeのlogical/physical pathをflagなしで採用しない', () => {
    const home = mkdtempSync(join(tmpdir(), 'zerokun-watchdog-symlink-home-'))
    const physicalClaude = join(home, 'config/claude-home')
    const physicalLegacy = join(physicalClaude, 'channels/slack')
    const codexState = join(home, '.codex/zerokun')
    try {
      mkdirSync(physicalLegacy, { recursive: true })
      mkdirSync(codexState, { recursive: true })
      symlinkSync(physicalClaude, join(home, '.claude'))
      writeFileSync(join(physicalLegacy, '.env'), [
        'SLACK_BOT_TOKEN=xoxb-old-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-AOLDAPP123-old-not-a-real-token',
        '',
      ].join('\n'))
      writeFileSync(join(codexState, '.env'), [
        'SLACK_BOT_TOKEN=xoxb-codex-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-ACODEXAPP123-codex-not-a-real-token',
        '',
      ].join('\n'))
      for (const configured of [join(home, '.claude/channels/slack'), physicalLegacy]) {
        const result = Bun.spawnSync(['/bin/bash', watchdog, '--selftest-environment'], {
          env: {
            ...process.env,
            HOME: home,
            ZEROKUN_STATE_DIR: configured,
            ZEROKUN_LEGACY_CUTOVER: '0',
          },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        expect(result.stdout.toString()).toContain('watchdog environment selftest: PASS')
        expect(result.stdout.toString()).toContain(`state=${codexState}`)
      }
      writeFileSync(
        join(physicalLegacy, '.codex-legacy-cutover'),
        `zerokun-codex-legacy-cutover-v1\n${realpathSync(physicalLegacy)}\n`,
        { mode: 0o600 },
      )
      rmSync(join(home, '.claude'))
      const established = Bun.spawnSync(['/bin/bash', watchdog, '--selftest-environment'], {
        env: {
          ...process.env,
          HOME: home,
          ZEROKUN_STATE_DIR: physicalLegacy,
          ZEROKUN_LEGACY_CUTOVER: '0',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(established.exitCode, established.stderr.toString()).toBe(0)
      expect(established.stdout.toString()).toContain(`state=${codexState}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('state root symlinkを拒否して外部directoryを変更しない', () => {
    const base = mkdtempSync(join(tmpdir(), 'zerokun-watchdog-root-'))
    const external = join(base, 'external')
    const state = join(base, 'state')
    try {
      mkdirSync(external, { mode: 0o755 })
      chmodSync(external, 0o755)
      writeFileSync(join(external, 'sentinel'), 'keep')
      symlinkSync(external, state)
      const result = Bun.spawnSync(['/bin/bash', watchdog], {
        env: { ...process.env, ZEROKUN_STATE_DIR: state, DRY_RUN: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('unsafe state directory symlink')
      expect(statSync(external).mode & 0o777).toBe(0o755)
      expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('keep')
      expect(readdirSync(external)).toEqual(['sentinel'])
      expect(lstatSync(state).isSymbolicLink()).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test.each(['symlink', 'hardlink'] as const)(
    '既存watchdog-state.json.next %sを辿らず外部fileを保持する',
    (kind) => {
      const base = mkdtempSync(join(tmpdir(), 'zerokun-watchdog-next-'))
      const state = join(base, 'state')
      const external = join(base, 'external')
      try {
        mkdirSync(state, { mode: 0o700 })
        writeFileSync(external, 'keep', { mode: 0o644 })
        const legacyNext = join(state, 'watchdog-state.json.next')
        if (kind === 'symlink') symlinkSync(external, legacyNext)
        else linkSync(external, legacyNext)
        const result = Bun.spawnSync(['/bin/bash', watchdog], {
          env: { ...process.env, ZEROKUN_STATE_DIR: state, DRY_RUN: '1' },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        expect(readFileSync(external, 'utf8')).toBe('keep')
        expect(statSync(external).mode & 0o777).toBe(0o644)
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    },
  )
})
