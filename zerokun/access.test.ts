import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { approvePairing, mutateAccess, readAccess, writeAccess } from './access.ts'

const directories: string[] = []

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zerokun-access-'))
  directories.push(dir)
  return dir
}

describe('zerokun-access', () => {
  test('pairingは指定codeだけを承認し、write権限を暗黙付与しない', () => {
    const dir = fixture()
    const path = join(dir, 'access.json')
    const access = readAccess(path)
    access.pending.abc123 = {
      senderId: 'U0123456789',
      chatId: 'D0123456789',
      createdAt: 1,
      expiresAt: 10_000,
    }
    writeAccess(access, path)

    expect(approvePairing('abc123', { stateDir: dir, now: 100 })).toEqual({
      senderId: 'U0123456789',
      chatId: 'D0123456789',
    })
    const saved = readAccess(path)
    expect(saved.allowFrom).toContain('U0123456789')
    expect(saved.writeAllowFrom).toEqual([])
    expect(saved.pending).not.toHaveProperty('abc123')
    expect(readFileSync(join(dir, 'approved/U0123456789'), 'utf8').trim()).toBe('D0123456789')
  })

  test('code省略や推測による自動承認をしない', () => {
    const dir = fixture()
    const path = join(dir, 'access.json')
    const access = readAccess(path)
    access.pending.onlyone = {
      senderId: 'U0123456789',
      chatId: 'D0123456789',
      createdAt: 1,
      expiresAt: 10_000,
    }
    writeAccess(access, path)
    expect(() => approvePairing('', { stateDir: dir, now: 100 })).toThrow('code is required')
    expect(readAccess(path).allowFrom).toEqual([])
  })

  test('lock identity破損によるrelease失敗を成功扱いしない', () => {
    const dir = fixture()
    const path = join(dir, 'access.json')
    expect(() => mutateAccess(access => {
      access.allowFrom.push('U0123456789')
      writeFileSync(`${path}.lock.identity`, '{}\n', { mode: 0o600 })
    }, path)).toThrow('failed to release access config lock')
  })

  test('期限切れcodeを拒否してpendingから除去する', () => {
    const dir = fixture()
    const path = join(dir, 'access.json')
    const access = readAccess(path)
    access.pending.expired = {
      senderId: 'U0123456789',
      chatId: 'D0123456789',
      createdAt: 1,
      expiresAt: 2,
    }
    writeAccess(access, path)
    expect(() => approvePairing('expired', { stateDir: dir, now: 3 })).toThrow('expired')
    expect(readAccess(path).pending).toEqual({})
    expect(existsSync(join(dir, 'approved/U0123456789'))).toBe(false)
  })

  test('部分更新はlock内で最新状態を再読込し、write revokeを復活させない', () => {
    const dir = fixture()
    const path = join(dir, 'access.json')
    const initial = readAccess(path)
    initial.writeAllowFrom = ['U0123456789']
    writeAccess(initial, path)

    mutateAccess(access => {
      access.writeAllowFrom = access.writeAllowFrom.filter(id => id !== 'U0123456789')
    }, path)
    mutateAccess(access => {
      access.pending.fresh = {
        senderId: 'U9999999999',
        chatId: 'D9999999999',
        createdAt: 1,
        expiresAt: 10_000,
      }
    }, path)

    expect(readAccess(path)).toMatchObject({
      writeAllowFrom: [],
      pending: { fresh: { senderId: 'U9999999999' } },
    })
  })

  test('別processのrevokeとpending追加が同時でもwrite権限を復活させない', async () => {
    const dir = fixture()
    const path = join(dir, 'access.json')
    const barrier = join(dir, 'go')
    const worker = join(dir, 'access-worker.ts')
    const initial = readAccess(path)
    initial.writeAllowFrom = ['U0123456789']
    writeAccess(initial, path)
    writeFileSync(worker, `
import { existsSync } from 'fs'
import { mutateAccess } from ${JSON.stringify(join(import.meta.dir, 'access.ts'))}
while (!existsSync(process.argv[2])) await Bun.sleep(1)
mutateAccess(access => {
  if (process.argv[4] === 'revoke') {
    access.writeAllowFrom = access.writeAllowFrom.filter(id => id !== 'U0123456789')
  } else {
    access.pending.concurrent = {
      senderId: 'U9999999999', chatId: 'D9999999999', createdAt: 1, expiresAt: 10000,
    }
  }
}, process.argv[3])
`)
    const children = ['revoke', 'pending'].map(mode => Bun.spawn([
      process.execPath, worker, barrier, path, mode,
    ], { stdout: 'pipe', stderr: 'pipe' }))
    writeFileSync(barrier, 'go')
    for (const child of children) {
      const stderr = await new Response(child.stderr).text()
      expect(await child.exited, stderr).toBe(0)
    }
    expect(readAccess(path)).toMatchObject({
      writeAllowFrom: [],
      pending: { concurrent: { senderId: 'U9999999999' } },
    })
  })
})
