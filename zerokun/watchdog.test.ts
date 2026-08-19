import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const watchdog = join(import.meta.dir, 'watchdog.sh')

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
  })

  test('launchd templateはDesktopでなくstate dirのinstalled scriptを実行する', () => {
    const plist = readFileSync(
      join(import.meta.dir, 'templates/com.zerokun.watchdog.plist.template'),
      'utf8',
    )
    expect(plist).toContain('<string>__HOME__/.claude/channels/slack/watchdog.sh</string>')
    expect(plist).toContain('<key>StartInterval</key>')
    expect(plist).toContain('<integer>60</integer>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).not.toContain('Desktop')
  })
})
