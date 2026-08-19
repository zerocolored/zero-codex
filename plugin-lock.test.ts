import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquirePluginLock } from './plugin-lock.ts'

const tempDirs: string[] = []
const children: Array<ReturnType<typeof Bun.spawn>> = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('plugin.lock process identity', () => {
  test('生きている無関係なPIDはstaleとしてreclaimする', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-plugin-lock-'))
    tempDirs.push(dir)
    const lockFile = join(dir, 'plugin.lock')
    writeFileSync(lockFile, '1')

    const result = acquirePluginLock(lockFile, dir, process.pid)

    expect(result).toEqual({ acquired: true, reclaimedPid: 1 })
    expect(readFileSync(lockFile, 'utf8')).toBe(String(process.pid))
  })

  test('server.tsを実行中の別PIDならlockを奪わない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-plugin-lock-live-'))
    tempDirs.push(dir)
    const fakeServer = join(dir, 'server.ts')
    writeFileSync(fakeServer, '#!/bin/bash\nsleep 30\n')
    const child = Bun.spawn(['/bin/bash', fakeServer], { stdout: 'ignore', stderr: 'ignore' })
    children.push(child)
    await Bun.sleep(50)
    const lockFile = join(dir, 'plugin.lock')
    mkdirSync(dir, { recursive: true })
    writeFileSync(lockFile, String(child.pid))

    const result = acquirePluginLock(lockFile, dir, process.pid)

    expect(result).toEqual({ acquired: false, heldPid: child.pid })
    expect(readFileSync(lockFile, 'utf8')).toBe(String(child.pid))
  })
})
