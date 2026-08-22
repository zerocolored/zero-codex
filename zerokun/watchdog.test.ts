import { describe, expect, test } from 'bun:test'
import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
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

  test('Slack API呼び出しは10秒でtimeoutする', () => {
    expect(watchdogSource.match(/--max-time 10/g)?.length).toBe(2)
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
        env: { ...process.env, SLACK_STATE_DIR: state, DRY_RUN: '1' },
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
          env: { ...process.env, SLACK_STATE_DIR: state, DRY_RUN: '1' },
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
