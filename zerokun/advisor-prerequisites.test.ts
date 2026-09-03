import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  linkSync,
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
import { resolveDedicatedGrokLauncher } from './advisor-prerequisites.ts'
import { installGrokReviewer } from './install-grok-reviewer.ts'

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'zerochan-grok-home-'))
  temporaryDirs.push(home)
  chmodSync(home, 0o700)
  return home
}

function installFixture(home: string): string {
  const grokRoot = join(home, '.grok')
  const bin = join(grokRoot, 'bin')
  const downloads = join(grokRoot, 'downloads')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  mkdirSync(downloads, { mode: 0o700 })
  chmodSync(grokRoot, 0o700)
  chmodSync(bin, 0o700)
  chmodSync(downloads, 0o700)
  const officialName = process.arch === 'arm64'
    ? 'grok-macos-aarch64'
    : 'grok-macos-x86_64'
  const executable = join(downloads, officialName)
  // This fixture is inspected as an owner-only executable but is never run.
  // Keep it process-free: an unbounded compiler subprocess can outlive Bun's
  // per-test deadline on a loaded CI host and wedge the remainder of the suite.
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  symlinkSync(`../downloads/${officialName}`, join(bin, 'grok'))
  writeFileSync(join(grokRoot, 'auth.json'), '{"fixture":true}\n', { mode: 0o600 })
  return installGrokReviewer(home)
}

describe('dedicated Grok prerequisite', () => {
  test('owner-only executableだけを固定pathから採択する', () => {
    const home = fixtureHome()
    const path = installFixture(home)
    expect(resolveDedicatedGrokLauncher(home)).toBe(realpathSync(path))
  })

  test('missing・hardlink・group/world writable launcherを拒否する', () => {
    const missingHome = fixtureHome()
    expect(() => resolveDedicatedGrokLauncher(missingHome)).toThrow('未導入または安全ではありません')

    const hardlinkHome = fixtureHome()
    const hardlinked = installFixture(hardlinkHome)
    linkSync(hardlinked, join(hardlinkHome, 'second-link'))
    expect(() => resolveDedicatedGrokLauncher(hardlinkHome)).toThrow('未導入または安全ではありません')

    const writableHome = fixtureHome()
    const writable = installFixture(writableHome)
    chmodSync(writable, 0o722)
    expect(() => resolveDedicatedGrokLauncher(writableHome)).toThrow('未導入または安全ではありません')
  })

  test('bundle改変は拒否しlogin authの可用性はservice gateにしない', () => {
    const configHome = fixtureHome()
    installFixture(configHome)
    writeFileSync(join(configHome, '.grok-reviewer', 'config.toml'), 'tampered = true\n', { mode: 0o600 })
    expect(() => resolveDedicatedGrokLauncher(configHome)).toThrow('未導入または安全ではありません')

    const authHome = fixtureHome()
    installFixture(authHome)
    chmodSync(join(authHome, '.grok', 'auth.json'), 0o640)
    expect(() => resolveDedicatedGrokLauncher(authHome)).not.toThrow()

    const unreadableAuthHome = fixtureHome()
    installFixture(unreadableAuthHome)
    rmSync(join(unreadableAuthHome, '.grok', 'auth.json'))
    expect(() => resolveDedicatedGrokLauncher(unreadableAuthHome)).not.toThrow()
  })

  test('launcher/runtimeのleaf symlinkとowner実行不能modeを拒否する', () => {
    const launcherHome = fixtureHome()
    const launcher = installFixture(launcherHome)
    const launcherCopy = join(launcherHome, '.grok-reviewer', 'bin', 'grok-copy')
    writeFileSync(launcherCopy, readFileSync(launcher), { mode: 0o700 })
    rmSync(launcher)
    symlinkSync('grok-copy', launcher)
    expect(() => resolveDedicatedGrokLauncher(launcherHome))
      .toThrow('未導入または安全ではありません')

    const runtimeHome = fixtureHome()
    installFixture(runtimeHome)
    const runtime = join(runtimeHome, '.grok-reviewer', 'bin', 'reviewer-runtime.py')
    const runtimeCopy = join(runtimeHome, '.grok-reviewer', 'bin', 'runtime-copy.py')
    writeFileSync(runtimeCopy, readFileSync(runtime), { mode: 0o700 })
    rmSync(runtime)
    symlinkSync('runtime-copy.py', runtime)
    expect(() => resolveDedicatedGrokLauncher(runtimeHome))
      .toThrow('未導入または安全ではありません')

    const modeHome = fixtureHome()
    const modeLauncher = installFixture(modeHome)
    chmodSync(modeLauncher, 0o401)
    expect(() => resolveDedicatedGrokLauncher(modeHome))
      .toThrow('未導入または安全ではありません')
  })
})
