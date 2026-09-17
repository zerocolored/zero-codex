import { expect, test } from 'bun:test'
import { join } from 'path'

test('Grok OAuth runtime: synthetic staged login, URL/ANSI compatibility and credential preservation', () => {
  const result = Bun.spawnSync([
    '/usr/bin/python3', '-B', join(import.meta.dir, 'grok-oauth-runtime.test.py'),
  ], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stderr.toString()).toContain('OK')
}, 35_000)
