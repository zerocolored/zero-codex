import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { prepareManagedStateRoot } from './managed-path.ts'
import {
  UPDATE_RUNTIME_FILES,
  installUpdateRequestRuntime,
  type UpdateRuntimeInstallPhase,
} from './update-runtime.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), 'zerokun-update-runtime-test-'))
  temporaryRoots.push(root)
  const state = prepareManagedStateRoot(join(root, 'state'))
  return { root, state }
}

describe('atomic update request runtime', () => {
  for (const failAt of ['staged', 'published'] as const) {
    test(`${failAt}境界で停止しても旧entrypointを維持する`, () => {
      const { state } = fixture()
      const entrypoint = join(state, 'update-request.ts')
      writeFileSync(entrypoint, 'old-runtime\n', { mode: 0o700 })
      expect(() => installUpdateRequestRuntime(import.meta.dir, state, {
        onPhase: (phase: UpdateRuntimeInstallPhase) => {
          if (phase === failAt) throw new Error(`stop at ${phase}`)
        },
      })).toThrow(`stop at ${failAt}`)
      expect(lstatSync(entrypoint).isFile()).toBe(true)
      expect(readFileSync(entrypoint, 'utf8')).toBe('old-runtime\n')
    })
  }

  test('全import companionをpublishしてからentrypointをatomic切替する', () => {
    const { state } = fixture()
    const entrypoint = join(state, 'update-request.ts')
    writeFileSync(entrypoint, 'old-runtime\n', { mode: 0o700 })
    const installed = installUpdateRequestRuntime(import.meta.dir, state)
    expect(lstatSync(entrypoint).isSymbolicLink()).toBe(true)
    expect(readlinkSync(entrypoint)).toMatch(
      /^update-runtime\/bundle-[0-9a-f-]+\/update-request\.ts$/i,
    )
    expect(installed).toBe(join(state, readlinkSync(entrypoint)))
    for (const name of UPDATE_RUNTIME_FILES) {
      expect(existsSync(join(installed, '..', name))).toBe(true)
    }
    expect(existsSync(join(installed, '..', 'manifest.json'))).toBe(true)
    const loaded = Bun.spawnSync([
      process.execPath,
      '--config=/dev/null',
      '--no-env-file',
      entrypoint,
    ], {
      env: { ...process.env, ZEROKUN_STATE_DIR: state },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(loaded.exitCode).toBe(1)
    expect(loaded.stderr.toString()).toContain('usage: update-request.ts run')
    expect(loaded.stderr.toString()).not.toContain('Cannot find module')
  })

  test('既存のstate外symlinkを置換しない', () => {
    const { root, state } = fixture()
    const external = join(root, 'external')
    writeFileSync(external, 'keep\n')
    symlinkSync(external, join(state, 'update-request.ts'))
    expect(() => installUpdateRequestRuntime(import.meta.dir, state))
      .toThrow('unsafe existing update runtime link')
    expect(readFileSync(external, 'utf8')).toBe('keep\n')
  })
})
