import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { requestUpdate, runUpdateWorker } from './update-request'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zerokun-update-request-test-'))
  tempDirs.push(dir)
  return dir
}

function input(messageId = '1787000000.000100') {
  return {
    chatId: 'C0123456789',
    threadTs: '1787000000.000000',
    messageId,
    userId: 'U0123456789',
  }
}

describe('Slack update request', () => {
  test('受付通知後に独立workerを1回だけ起動し、同時依頼をまとめる', async () => {
    const stateDir = fixtureDir()
    const events: string[] = []
    const options = {
      stateDir,
      idFactory: () => 'request-1',
      launchWorker: () => events.push('launch'),
      onAccepted: async () => { events.push('ack') },
      onDuplicate: async () => { events.push('duplicate') },
      isWorkerRunning: () => true,
    }

    const first = await requestUpdate(input(), options)
    const second = await requestUpdate(input('1787000000.000200'), options)

    expect(first.accepted).toBe(true)
    expect(second.duplicate).toBe(true)
    expect(second.request.id).toBe(first.request.id)
    expect(events).toEqual(['ack', 'launch', 'duplicate'])
  })

  test('worker起動に失敗した予約を残さず再試行可能にする', async () => {
    const stateDir = fixtureDir()
    await expect(requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-failed',
      launchWorker: () => { throw new Error('tmux failed') },
    })).rejects.toThrow('tmux failed')

    expect(existsSync(join(stateDir, 'update-request.json'))).toBe(false)
  })

  test('古い予約に生存workerがいなければ回収して新しい依頼を受ける', async () => {
    const stateDir = fixtureDir()
    await requestUpdate(input(), {
      stateDir,
      now: () => 1,
      idFactory: () => 'request-stale',
      launchWorker: () => {},
    })

    const recovered = await requestUpdate(input('1787000000.000300'), {
      stateDir,
      now: () => 7 * 60 * 60 * 1000,
      idFactory: () => 'request-new',
      isWorkerRunning: () => false,
      launchWorker: () => {},
    })

    expect(recovered.accepted).toBe(true)
    expect(recovered.request.id).toBe('request-new')
  })

  test('壊れた予約ファイルに生存workerがいなければ自己復旧する', async () => {
    const stateDir = fixtureDir()
    writeFileSync(join(stateDir, 'update-request.json'), '{broken json', { mode: 0o600 })

    const recovered = await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-after-corruption',
      isWorkerRunning: () => false,
      launchWorker: () => {},
    })

    expect(recovered.accepted).toBe(true)
    expect(recovered.request.id).toBe('request-after-corruption')
  })

  test('tmux workerへ切り離し、受付process終了後もworkerを生存させる', async () => {
    const stateDir = fixtureDir()
    const tmux = Bun.spawnSync(['/usr/bin/which', 'tmux'], { stdout: 'pipe' })
    expect(tmux.exitCode).toBe(0)
    const tmuxPath = new TextDecoder().decode(tmux.stdout).trim()
    const session = `zerokun-update-worker-test-${process.pid}-${Date.now()}`
    const workerFile = join(stateDir, 'fake-worker.ts')
    const updaterPath = join(stateDir, 'fake-updater.ts')
    writeFileSync(workerFile, [
      "import { writeFileSync } from 'fs'",
      "import { join } from 'path'",
      "const args = process.argv.slice(2)",
      "const stateIndex = args.indexOf('--state-dir')",
      "writeFileSync(join(args[stateIndex + 1], 'worker-started'), args[1])",
      'await Bun.sleep(30_000)',
      '',
    ].join('\n'))
    writeFileSync(updaterPath, '#!/usr/bin/env bun\n')

    try {
      const result = await requestUpdate(input(), {
        stateDir,
        workerFile,
        updaterPath,
        tmuxPath,
        tmuxSession: session,
        idFactory: () => 'request-detached',
      })
      expect(result.accepted).toBe(true)
      for (let attempt = 0; attempt < 40 && !existsSync(join(stateDir, 'worker-started')); attempt += 1) {
        await Bun.sleep(25)
      }
      expect(readFileSync(join(stateDir, 'worker-started'), 'utf8')).toBe('request-detached')
      const alive = Bun.spawnSync([tmuxPath, 'has-session', '-t', session])
      expect(alive.exitCode).toBe(0)
    } finally {
      Bun.spawnSync([tmuxPath, 'kill-session', '-t', session])
    }
  })

  test('独立workerが更新成功を元のSlackスレッドへ通知して予約を消す', async () => {
    const stateDir = fixtureDir()
    const notifications: string[] = []
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-success',
      launchWorker: () => {},
    })

    const result = await runUpdateWorker('request-success', {
      stateDir,
      executeUpdater: async () => 0,
      notify: async (_request, text) => { notifications.push(text) },
    })

    expect(result.success).toBe(true)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toContain('更新完了')
    expect(existsSync(join(stateDir, 'update-request.json'))).toBe(false)
  })

  test('更新失敗も元のSlackスレッドへ通知して次の依頼を受けられる', async () => {
    const stateDir = fixtureDir()
    const notifications: string[] = []
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-error',
      launchWorker: () => {},
    })

    const result = await runUpdateWorker('request-error', {
      stateDir,
      executeUpdater: async () => 17,
      notify: async (_request, text) => { notifications.push(text) },
    })

    expect(result.success).toBe(false)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toContain('更新失敗')
    expect(existsSync(join(stateDir, 'update-request.json'))).toBe(false)
  })
})
