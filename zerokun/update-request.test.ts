import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  requestUpdate, resumePendingUpdateWorker, runUpdateWorker, withUpdateSlackDeadline,
} from './update-request'
import { buildCandidateEnvironment, buildUpdaterEnvironment } from './child-environment'

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
  test('updaterとcandidateへSlack/GitHub/AWS credentialを継承しない', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/Users/example',
      LANG: 'ja_JP.UTF-8',
      ZEROKUN_STATE_DIR: '/safe/state',
      SLACK_BOT_TOKEN: 'xoxb-secret',
      GH_TOKEN: 'github-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
    }
    const updater = buildUpdaterEnvironment(source)
    expect(updater).toEqual({
      PATH: '/usr/bin', HOME: '/Users/example', LANG: 'ja_JP.UTF-8',
      ZEROKUN_STATE_DIR: '/safe/state',
    })
    const candidate = buildCandidateEnvironment('/isolated', source)
    expect(candidate.HOME).toBe('/isolated')
    expect(candidate.CODEX_HOME).toBe('/isolated')
    expect(candidate.ZEROKUN_STATE_DIR).toBeUndefined()
    expect(candidate.SLACK_BOT_TOKEN).toBeUndefined()
    expect(candidate.GH_TOKEN).toBeUndefined()
    expect(candidate.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })

  test('Slack完了通知のnetwork hangをdeadlineで中断する', async () => {
    await expect(withUpdateSlackDeadline(
      () => new Promise<void>(() => {}),
      20,
    )).rejects.toThrow('Slack update notification timed out after 20ms')
  })

  test('未通知outcomeのworkerが終了していれば定期回復で再起動する', async () => {
    const stateDir = fixtureDir()
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-recover-notify',
      launchWorker: () => {},
    })
    const request = JSON.parse(readFileSync(join(stateDir, 'update-request.json'), 'utf8'))
    request.outcome = { success: true, exitCode: 0, text: 'done', completedAt: Date.now() }
    writeFileSync(join(stateDir, 'update-request.json'), JSON.stringify(request))
    const launched: string[] = []
    expect(resumePendingUpdateWorker({
      stateDir,
      isWorkerRunning: () => false,
      launchWorker: value => launched.push(value.id),
    })).toBe(true)
    expect(launched).toEqual(['request-recover-notify'])
  })

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

  test('独立workerが更新成功を通知し、同じSlack event用のdurable tombstoneを残す', async () => {
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
    // 更新は再起動を伴い、ゼロくんは元のタブから消えて detached tmux へ移る。
    // 「どこに行った」を毎回聞かせないよう、開き方と抜け方を完了通知に必ず載せる。
    expect(notifications[0]).toContain('tmux attach -t zerokun-slack')
    expect(notifications[0]).toContain('Ctrl-b')
    const tombstone = JSON.parse(readFileSync(join(stateDir, 'update-request.json'), 'utf8'))
    expect(tombstone.outcome.notifiedAt).toBeNumber()

    let relaunched = 0
    const replay = await requestUpdate(input(), {
      stateDir,
      launchWorker: () => { relaunched += 1 },
    })
    expect(replay.duplicate).toBe(true)
    expect(relaunched).toBe(0)
  })

  test('完了通知が案内するsessionは、再起動が実際に作るsessionと一致する', async () => {
    const stateDir = fixtureDir()
    const notifications: string[] = []
    const actualSession = 'zerokun-slack-a1b2c3d4'
    writeFileSync(
      join(stateDir, 'tmux-session.json'),
      JSON.stringify({ version: 1, name: actualSession, panePid: 12345, release: 'abc' }),
      { mode: 0o600 },
    )
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-session-name',
      launchWorker: () => {},
    })

    await runUpdateWorker('request-session-name', {
      stateDir,
      executeUpdater: async () => 0,
      notify: async (_request, text) => { notifications.push(text) },
    })

    // updaterは衝突回避用suffixを付けるため、通知は固定名ではなく起動時markerを読む。
    const guided = notifications[0].match(/tmux attach -t (\S+)/)?.[1]
    expect(guided).toBe(actualSession)
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
    expect(JSON.parse(readFileSync(join(stateDir, 'update-request.json'), 'utf8')).outcome.notifiedAt)
      .toBeNumber()
  })

  test('通知失敗時は更新結果を永続化し、再開workerはupdateを再実行せず通知だけ再送する', async () => {
    const stateDir = fixtureDir()
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-durable-notify',
      launchWorker: () => {},
    })
    let updaterCalls = 0
    const first = await runUpdateWorker('request-durable-notify', {
      stateDir,
      executeUpdater: async () => { updaterCalls += 1; return 0 },
      notify: async () => { throw new Error('Slack 503') },
      maxNotifyAttempts: 1,
      notificationRetryMs: 1,
    })
    expect(first.notificationSent).toBe(false)
    expect(JSON.parse(readFileSync(join(stateDir, 'update-request.json'), 'utf8')).outcome)
      .toMatchObject({ success: true, exitCode: 0 })

    const notifications: string[] = []
    const resumed = await runUpdateWorker('request-durable-notify', {
      stateDir,
      executeUpdater: async () => { updaterCalls += 1; return 99 },
      notify: async (_request, text) => { notifications.push(text) },
    })
    expect(resumed).toMatchObject({ success: true, exitCode: 0, notificationSent: true })
    expect(updaterCalls).toBe(1)
    expect(notifications[0]).toContain('更新完了')
    expect(JSON.parse(readFileSync(join(stateDir, 'update-request.json'), 'utf8')).outcome.notifiedAt)
      .toBeNumber()
  })

  test('通知失敗logのsymlinkを拒否しstate外fileへ追記しない', async () => {
    const stateDir = fixtureDir()
    const external = join(fixtureDir(), 'external.log')
    writeFileSync(external, 'keep\n')
    symlinkSync(external, join(stateDir, 'update-request.log'))
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-unsafe-log',
      launchWorker: () => {},
    })

    await expect(runUpdateWorker('request-unsafe-log', {
      stateDir,
      executeUpdater: async () => 0,
      notify: async () => { throw new Error('Slack 503') },
      maxNotifyAttempts: 1,
    })).rejects.toThrow()
    expect(readFileSync(external, 'utf8')).toBe('keep\n')
  })

  test('Slack完了通知はrequest由来のclient_msg_idで再送を冪等化する', () => {
    const source = readFileSync(join(import.meta.dir, 'update-request.ts'), 'utf8')
    expect(source).toContain('client_msg_id: updateNotificationClientId(request.id)')
  })
})
