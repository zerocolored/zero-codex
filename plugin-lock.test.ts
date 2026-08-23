import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'fs'
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
  test('既存identity symlinkを追わずatomic fileへ置換する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-plugin-lock-identity-'))
    tempDirs.push(dir)
    const lockFile = join(dir, 'plugin.lock')
    const external = join(dir, 'external.txt')
    writeFileSync(external, 'preserve')
    symlinkSync(external, `${lockFile}.identity`)
    expect(acquirePluginLock(lockFile, dir, process.pid).acquired).toBe(true)
    expect(readFileSync(external, 'utf8')).toBe('preserve')
    expect(JSON.parse(readFileSync(`${lockFile}.identity`, 'utf8')).pid).toBe(process.pid)
  })

  test('dead PIDのstale lockはatomicにreclaimする', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-plugin-lock-'))
    tempDirs.push(dir)
    const lockFile = join(dir, 'plugin.lock')
    const exited = Bun.spawn(['/usr/bin/true'])
    const deadPid = exited.pid
    await exited.exited
    writeFileSync(lockFile, String(deadPid))

    const result = acquirePluginLock(lockFile, dir, process.pid)

    expect(result).toEqual({ acquired: true, reclaimedPid: deadPid })
    expect(readFileSync(lockFile, 'utf8').trim()).toBe(String(process.pid))
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

    expect(result).toEqual({ acquired: false, kind: 'held', heldPid: child.pid })
    expect(readFileSync(lockFile, 'utf8')).toBe(String(child.pid))
  })

  test('同時起動してもatomic createで1 processだけがlockを得る', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-plugin-lock-race-'))
    tempDirs.push(dir)
    const fakeServer = join(dir, 'server.ts')
    const barrier = join(dir, 'go')
    const lockFile = join(dir, 'plugin.lock')
    writeFileSync(fakeServer, `
import { existsSync } from 'fs'
import { acquirePluginLock } from ${JSON.stringify(join(import.meta.dir, 'plugin-lock.ts'))}
while (!existsSync(process.argv[2])) await Bun.sleep(1)
const result = acquirePluginLock(process.argv[3], process.argv[4])
console.log(JSON.stringify(result))
if (result.acquired) await Bun.sleep(500)
`)
    const contenders = [0, 1].map(() => Bun.spawn([
      process.execPath, fakeServer, barrier, lockFile, dir,
    ], { stdout: 'pipe', stderr: 'pipe' }))
    children.push(...contenders)
    writeFileSync(barrier, 'go')
    const results = await Promise.all(contenders.map(async child => {
      const stdout = await new Response(child.stdout).text()
      const stderr = await new Response(child.stderr).text()
      expect(await child.exited, stderr).toBe(0)
      return JSON.parse(stdout.trim()) as { acquired: boolean }
    }))
    expect(results.filter(result => result.acquired)).toHaveLength(1)
    expect(existsSync(lockFile)).toBe(true)
  })
})
