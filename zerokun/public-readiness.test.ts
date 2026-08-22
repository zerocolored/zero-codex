import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  slackHttpTimeoutMs,
  slackWebClientOptions,
  withSlackDeadline,
} from './slack-http.ts'
import { resolveZeroStateDir } from './state-dir.ts'

describe('public Codex defaults', () => {
  test('repository未取得の新規Macにもcodex branch bootstrapの取得手順がある', () => {
    const rootReadme = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8')
    const setupGuide = readFileSync(join(import.meta.dir, 'NEW_MAC_SETUP.md'), 'utf8')
    const rawBootstrap = 'https://raw.githubusercontent.com/zerocolored/zero/codex/zerokun/bootstrap-macos.sh'
    for (const guide of [rootReadme, setupGuide]) {
      expect(guide).toContain(rawBootstrap)
      expect(guide).toContain('mktemp "${TMPDIR:-/tmp}/zerokun-bootstrap.XXXXXX"')
      expect(guide).toContain('--output "$bootstrap_path"')
      expect(guide).toContain('--with-slack')
    }
  })

  test('explicit state, migrated legacy state, new Codex stateの順で解決する', () => {
    const home = '/Users/tester'
    const legacy = join(home, '.claude/channels/slack')
    expect(resolveZeroStateDir({ ZEROKUN_STATE_DIR: '/explicit' }, home, () => false))
      .toBe('/explicit')
    expect(resolveZeroStateDir({ SLACK_STATE_DIR: '/compat' }, home, () => false))
      .toBe('/compat')
    expect(resolveZeroStateDir({}, home, path => path === join(legacy, 'access.json'))).toBe(legacy)
    expect(resolveZeroStateDir({}, home, path => path === legacy))
      .toBe(join(home, '.codex/zerokun'))
    expect(resolveZeroStateDir({}, home, () => false)).toBe(join(home, '.codex/zerokun'))
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
