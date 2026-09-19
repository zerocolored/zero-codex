import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installAppWatchdog, renderWatchdog, watchdogLabel } from './watchdog-profile.ts'

test('watchdogs are per-state, keep default compatibility, and escape XML paths', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'zero-watchdog-')))
  try {
    const a = join(home, '.codex/zerokun')
    const b = join(home, 'other & app')
    mkdirSync(a, { recursive: true }); mkdirSync(b)
    expect(watchdogLabel(a, home)).toBe('com.zerokun.watchdog')
    expect(watchdogLabel(b, home)).not.toBe(watchdogLabel(a, home))
    expect(watchdogLabel(b, home)).toBe(watchdogLabel(b, home))
    const xml = renderWatchdog('com.zerokun.watchdog __STATE_DIR__ __LEGACY_CUTOVER__', b, '0', home)
    expect(xml).toContain('other &amp; app')
    expect(xml).not.toContain('__STATE_DIR__')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('watchdog install addresses only the selected app and is idempotent', () => {
  if (process.platform !== 'darwin') return
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'zero-watchdog-install-')))
  const calls: string[][] = []
  try {
    const a = join(home, 'app-a'); const b = join(home, 'app-b')
    mkdirSync(a); mkdirSync(b)
    const run = (args: string[]) => { calls.push(args); return 0 }
    installAppWatchdog(a, home, run)
    expect(calls.map(args => args[1])).toEqual(['bootout', 'bootstrap'])
    expect(calls.flat().join(' ')).not.toContain(watchdogLabel(b, home))
    calls.length = 0
    installAppWatchdog(a, home, run)
    expect(calls.map(args => args[1])).toEqual(['print'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})
