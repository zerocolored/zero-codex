import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireDetachedLeaderIdentity, executeUpdater, requestUpdate, resumePendingUpdateWorker,
  runUpdaterGate, runUpdateWorker,
  withUpdateSlackDeadline, withoutUpdateNotificationNetworkOverrides,
} from './update-request'
import {
  applyStateEnvironment,
  buildCandidateEnvironment,
  buildRuntimeLaunchEnvironment,
  buildRuntimeServiceEnvironment,
  buildUpdaterEnvironment,
} from './child-environment'
import { observeProcessGeneration, readProcessIdentity } from './process-generation'

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
  test('gate identityを取得できなければupdaterを開始しない', async () => {
    const stateDir = fixtureDir()
    const probe = join(stateDir, 'updater-started')
    const updater = join(stateDir, 'fake-updater.ts')
    writeFileSync(updater, `await Bun.write(${JSON.stringify(probe)}, 'started\\n')\n`)
    await expect(runUpdaterGate(updater, join(stateDir, 'update.log'), {
      HOME: stateDir,
      PATH: process.env.PATH,
      ZEROKUN_STATE_DIR: stateDir,
    }, {
      identityReader: () => undefined,
      identityAttempts: 2,
      identityRetryMs: 1,
    })).rejects.toThrow('exact process identity')
    expect(existsSync(probe)).toBe(false)
  })

  test('detached leader identityは一時的な取得失敗を再試行する', async () => {
    const identity = {
      pid: 4242,
      ppid: 1,
      pgid: 4242,
      status: 2,
      bootSession: '11111111-1111-4111-8111-111111111111',
      startSec: 1_800_000_000,
      startUsec: 123,
      started: '11111111-1111-4111-8111-111111111111:1800000000:000123',
    }
    let attempts = 0
    expect(await acquireDetachedLeaderIdentity(
      identity.pid,
      () => (++attempts === 1 ? undefined : identity),
      3,
      1,
    )).toEqual(identity)
    expect(attempts).toBe(2)
  })

  test('stateやprojectのdotenvをtrusted updater processへ自動読込しない', async () => {
    const stateDir = fixtureDir()
    const probe = join(stateDir, 'dotenv-payload-ran')
    const updater = join(stateDir, 'fake-updater.ts')
    writeFileSync(join(stateDir, '.env'), [
      `ZEROKUN_SETUP_SCRIPT=${probe}`,
      'ZEROKUN_UPDATE_TESTING=1',
      '',
    ].join('\n'), { mode: 0o600 })
    writeFileSync(join(stateDir, 'bunfig.toml'), '[run]\npreload = ["./preload.ts"]\n')
    writeFileSync(
      join(stateDir, 'preload.ts'),
      `await Bun.write(${JSON.stringify(probe)}, 'unexpected bunfig preload\\n')\n`,
    )
    writeFileSync(updater, [
      'if (process.env.ZEROKUN_SETUP_SCRIPT || process.env.ZEROKUN_UPDATE_TESTING) {',
      `  await Bun.write(${JSON.stringify(probe)}, 'unexpected dotenv load\\n')`,
      '}',
      '',
    ].join('\n'), { mode: 0o700 })
    const exitCode = await executeUpdater(updater, join(stateDir, 'update.log'), 5_000, 500, {
      HOME: stateDir,
      PATH: process.env.PATH,
      ZEROKUN_STATE_DIR: stateDir,
    })
    expect(exitCode).toBe(0)
    expect(existsSync(probe)).toBe(false)
  })

  test('選択stateのSlack tokenをambient tokenより優先する', () => {
    const environment: Record<string, string | undefined> = {
      SLACK_BOT_TOKEN: 'xoxb-old-app-not-real',
      SLACK_APP_TOKEN: 'xapp-old-app-not-real',
      ZEROKUN_JOB_POLL_MS: '250',
      ZEROKUN_UPDATE_TESTING: '1',
      ZEROKUN_SLACK_IDENTITY_TEST_APP_ID: 'AOLDAPP123',
      ZEROKUN_SETUP_TEST_STOP_PROBE: '/tmp/should-not-be-used',
      HTTPS_PROXY: 'http://ambient-proxy.invalid',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    }
    applyStateEnvironment([
      'SLACK_BOT_TOKEN=xoxb-new-app-not-real',
      'SLACK_APP_TOKEN=xapp-1-ANEWAPP123-new-app-not-real',
      'ZEROKUN_JOB_POLL_MS=500',
      'HTTPS_PROXY=http://state-proxy.invalid',
      'NODE_TLS_REJECT_UNAUTHORIZED=0',
      'ZEROKUN_UPDATE_TESTING=1',
      'ZEROKUN_SLACK_IDENTITY_TEST_APP_ID=AATTACKER1',
      'ZEROKUN_SETUP_TEST_STOP_PROBE=/tmp/state-probe',
      '',
    ].join('\n'), environment)
    expect(environment.SLACK_BOT_TOKEN).toBe('xoxb-new-app-not-real')
    expect(environment.SLACK_APP_TOKEN).toBe('xapp-1-ANEWAPP123-new-app-not-real')
    expect(environment.ZEROKUN_JOB_POLL_MS).toBe('250')
    expect(environment.HTTPS_PROXY).toBeUndefined()
    expect(environment.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
    expect(environment.ZEROKUN_UPDATE_TESTING).toBeUndefined()
    expect(environment.ZEROKUN_SLACK_IDENTITY_TEST_APP_ID).toBeUndefined()
    expect(environment.ZEROKUN_SETUP_TEST_STOP_PROBE).toBeUndefined()

    expect(() => applyStateEnvironment([
      'SLACK_BOT_TOKEN=xoxb-valid-not-a-real-token',
      'SLACK_APP_TOKEN=xapp-1-A0123456789-valid-not-a-real-token',
      'SLACK_BOT_TOKEN=',
      'SLACK_APP_TOKEN=',
    ].join('\n'), environment)).toThrow('exactly one valid')
    expect(environment.SLACK_BOT_TOKEN).toBeUndefined()
    expect(environment.SLACK_APP_TOKEN).toBeUndefined()

    applyStateEnvironment('', environment)
    expect(environment.SLACK_BOT_TOKEN).toBeUndefined()
    expect(environment.SLACK_APP_TOKEN).toBeUndefined()
  })
  test('updaterとcandidateへSlack/GitHub/AWS credentialを継承しない', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/Users/example',
      LANG: 'ja_JP.UTF-8',
      ZEROKUN_STATE_DIR: '/safe/state',
      ZEROKUN_LEGACY_CUTOVER: '1',
      ZEROKUN_JOB_DB: '/safe/state/jobs.sqlite3',
      ZEROKUN_SETUP_SCRIPT: '/unsafe/stale-setup.sh',
      HTTPS_PROXY: 'http://fake-user:fake-password@proxy.invalid:8080',
      ALL_PROXY: 'socks5://fake-user:fake-password@proxy.invalid:1080',
      NO_PROXY: 'localhost',
      SLACK_BOT_TOKEN: 'xoxb-secret',
      GH_TOKEN: 'github-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      ZEROKUN_UPDATE_TESTING: '1',
    }
    const updater = buildUpdaterEnvironment(source)
    expect(updater).toEqual({
      PATH: '/usr/bin', HOME: '/Users/example', LANG: 'ja_JP.UTF-8',
      ZEROKUN_STATE_DIR: '/safe/state',
      ZEROKUN_LEGACY_CUTOVER: '1',
      ZEROKUN_SETUP_SCRIPT: '/unsafe/stale-setup.sh',
    })
    expect(updater.HTTPS_PROXY).toBeUndefined()
    expect(updater.ALL_PROXY).toBeUndefined()
    expect(updater.NO_PROXY).toBeUndefined()
    expect(updater.ZEROKUN_UPDATE_TESTING).toBeUndefined()
    const candidate = buildCandidateEnvironment('/isolated', source)
    expect(candidate.HOME).toBe('/isolated')
    expect(candidate.CODEX_HOME).toBe('/isolated')
    expect(candidate.ZEROKUN_STATE_DIR).toBeUndefined()
    expect(candidate.SLACK_BOT_TOKEN).toBeUndefined()
    expect(candidate.GH_TOKEN).toBeUndefined()
    expect(candidate.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(candidate.HTTPS_PROXY).toBeUndefined()
    expect(candidate.ALL_PROXY).toBeUndefined()
    expect(candidate.NO_PROXY).toBeUndefined()
    const runtime = buildRuntimeLaunchEnvironment(source)
    expect(runtime).toEqual({ PATH: '/usr/bin', HOME: '/Users/example', LANG: 'ja_JP.UTF-8' })
    const service = buildRuntimeServiceEnvironment(source)
    expect(service.ZEROKUN_JOB_DB).toBeUndefined()
    expect(service.ZEROKUN_SETUP_SCRIPT).toBeUndefined()
  })

  test('workerは選択stateとcutover flagをambient環境に頼らずupdaterへ固定する', async () => {
    const stateDir = fixtureDir()
    const projectDir = join(stateDir, 'project')
    const updater = join(stateDir, 'recording-updater.ts')
    writeFileSync(updater, [
      "import { writeFileSync } from 'fs'",
      "import { join } from 'path'",
      "writeFileSync(join(process.env.ZEROKUN_STATE_DIR!, 'updater-environment.json'), JSON.stringify({",
      '  stateDir: process.env.ZEROKUN_STATE_DIR,',
      '  legacyCutover: process.env.ZEROKUN_LEGACY_CUTOVER,',
      '  projectDir: process.env.ZEROKUN_PROJECT_DIR,',
      '  jobDb: process.env.ZEROKUN_JOB_DB,',
      '  slackToken: process.env.SLACK_BOT_TOKEN,',
      '}))',
      '',
    ].join('\n'))
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-explicit-environment',
      launchWorker: () => {},
    })
    const previousJobDb = process.env.ZEROKUN_JOB_DB
    process.env.ZEROKUN_JOB_DB = join(stateDir, 'jobs.sqlite3')
    try {
      const result = await runUpdateWorker('request-explicit-environment', {
        stateDir,
        updaterPath: updater,
        legacyCutover: true,
        projectDir,
        notify: async () => {},
      })
      expect(result).toEqual({ success: true, exitCode: 0, notificationSent: true })
      expect(JSON.parse(readFileSync(join(stateDir, 'updater-environment.json'), 'utf8')))
        .toEqual({
          stateDir,
          legacyCutover: '1',
          projectDir,
          jobDb: join(realpathSync(stateDir), 'jobs.sqlite3'),
        })
    } finally {
      if (previousJobDb === undefined) delete process.env.ZEROKUN_JOB_DB
      else process.env.ZEROKUN_JOB_DB = previousJobDb
    }
  })

  test('Slack完了通知のnetwork hangをdeadlineで中断する', async () => {
    await expect(withUpdateSlackDeadline(
      () => new Promise<void>(() => {}),
      20,
    )).rejects.toThrow('Slack update notification timed out after 20ms')
  })

  test('Slack完了通知中だけproxyとcustom CAを環境から除外して復元する', async () => {
    const previousProxy = process.env.HTTPS_PROXY
    const previousCa = process.env.SSL_CERT_FILE
    const previousTlsVerification = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.HTTPS_PROXY = 'http://user:password@proxy.invalid'
    process.env.SSL_CERT_FILE = '/tmp/untrusted-ca.pem'
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    try {
      await withoutUpdateNotificationNetworkOverrides(async () => {
        expect(process.env.HTTPS_PROXY).toBeUndefined()
        expect(process.env.SSL_CERT_FILE).toBeUndefined()
        expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
      })
      expect(process.env.HTTPS_PROXY).toBe('http://user:password@proxy.invalid')
      expect(process.env.SSL_CERT_FILE).toBe('/tmp/untrusted-ca.pem')
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0')
    } finally {
      if (previousProxy === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = previousProxy
      if (previousCa === undefined) delete process.env.SSL_CERT_FILE
      else process.env.SSL_CERT_FILE = previousCa
      if (previousTlsVerification === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsVerification
    }
  })

  test('更新workerはhangしたupdaterをdeadline後に停止して失敗outcomeを保存する', async () => {
    const stateDir = fixtureDir()
    const updater = join(stateDir, 'hanging-updater.ts')
    const updaterPid = join(stateDir, 'hanging-updater.pid')
    writeFileSync(updater, [
      "import { writeFileSync } from 'fs'",
      `writeFileSync(${JSON.stringify(updaterPid)}, String(process.pid))`,
      "process.on('SIGTERM', () => {})",
      'await Bun.sleep(30_000)',
      '',
    ].join('\n'))
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-timeout',
      launchWorker: () => {},
    })
    const notifications: string[] = []
    const startedAt = Date.now()
    const running = runUpdateWorker('request-timeout', {
      stateDir,
      updaterPath: updater,
      updaterTimeoutMs: 50,
      updaterTermGraceMs: 50,
      notify: async (_request, text) => { notifications.push(text) },
    })
    let deadline = Date.now() + 2_000
    while (!existsSync(updaterPid) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(updaterPid)).toBe(true)
    const childIdentity = readProcessIdentity(Number(readFileSync(updaterPid, 'utf8')))
    expect(childIdentity).toBeDefined()
    const result = await running
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(result).toEqual({ success: false, exitCode: 1, notificationSent: true })
    expect(notifications[0]).toContain('timeout')
    const saved = JSON.parse(readFileSync(join(stateDir, 'update-request.json'), 'utf8'))
    expect(saved.outcome.success).toBe(false)
    expect(saved.outcome.notifiedAt).toBeNumber()
    expect(observeProcessGeneration(childIdentity!).status).toBe('dead')
  })

  test('live detached gateがrequestへ残る間はworkerを二重起動しない', async () => {
    const stateDir = fixtureDir()
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-live-gate',
      launchWorker: () => {},
    })
    const current = JSON.parse(readFileSync(join(stateDir, 'update-request.json'), 'utf8'))
    const gate = readProcessIdentity(process.pid)
    expect(gate).toBeDefined()
    current.gate = gate
    writeFileSync(join(stateDir, 'update-request.json'), JSON.stringify(current))
    const launched: string[] = []
    expect(resumePendingUpdateWorker({
      stateDir,
      isWorkerRunning: () => false,
      launchWorker: value => launched.push(value.id),
    })).toBe(false)
    expect(launched).toEqual([])
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

  test('tmux workerへstate/cutoverを固定して切り離し、受付process終了後も生存させる', async () => {
    const stateDir = fixtureDir()
    const tmux = Bun.spawnSync(['/usr/bin/which', 'tmux'], { stdout: 'pipe' })
    expect(tmux.exitCode).toBe(0)
    const realTmux = new TextDecoder().decode(tmux.stdout).trim()
    const tmuxPath = join(stateDir, 'isolated-tmux')
    const socket = `zerokun-update-worker-${process.pid}-${Date.now()}`
    writeFileSync(
      tmuxPath,
      `#!/bin/bash\nexec ${JSON.stringify(realTmux)} -L ${JSON.stringify(socket)} "$@"\n`,
      { mode: 0o700 },
    )
    const session = `zerokun-update-worker-test-${process.pid}-${Date.now()}`
    const keeper = `keeper-${session}`
    const workerFile = join(stateDir, 'fake-worker.ts')
    const updaterPath = join(stateDir, 'fake-updater.ts')
    const projectDir = join(stateDir, 'project')
    writeFileSync(workerFile, [
      "import { writeFileSync } from 'fs'",
      "import { join } from 'path'",
      "const args = process.argv.slice(2)",
      "const stateIndex = args.indexOf('--state-dir')",
      "const cutoverIndex = args.indexOf('--legacy-cutover')",
      "const projectIndex = args.indexOf('--project-dir')",
      "writeFileSync(join(args[stateIndex + 1], 'worker-started'), JSON.stringify({",
      '  requestId: args[1],',
      '  stateDir: process.env.ZEROKUN_STATE_DIR,',
      '  legacyCutover: process.env.ZEROKUN_LEGACY_CUTOVER,',
      '  legacyCutoverArg: args[cutoverIndex + 1],',
      '  projectDir: process.env.ZEROKUN_PROJECT_DIR,',
      '  projectDirArg: args[projectIndex + 1],',
      '  jobDb: process.env.ZEROKUN_JOB_DB,',
      '  staleSetup: process.env.ZEROKUN_SETUP_SCRIPT,',
      '  staleSlackToken: process.env.SLACK_BOT_TOKEN,',
      '}))',
      'await Bun.sleep(30_000)',
      '',
    ].join('\n'))
    writeFileSync(updaterPath, '#!/usr/bin/env bun\n')
    expect(Bun.spawnSync([tmuxPath, 'new-session', '-d', '-s', keeper, 'sleep 30']).exitCode).toBe(0)
    expect(Bun.spawnSync([
      tmuxPath, 'set-environment', '-g', 'ZEROKUN_JOB_DB', '/tmux/stale/jobs.sqlite3',
    ]).exitCode).toBe(0)
    expect(Bun.spawnSync([
      tmuxPath, 'set-environment', '-g', 'ZEROKUN_SETUP_SCRIPT', '/tmux/stale/setup.sh',
    ]).exitCode).toBe(0)
    expect(Bun.spawnSync([
      tmuxPath, 'set-environment', '-g', 'SLACK_BOT_TOKEN', 'xoxb-tmux-stale-not-real',
    ]).exitCode).toBe(0)
    const previousJobDb = process.env.ZEROKUN_JOB_DB
    process.env.ZEROKUN_JOB_DB = join(stateDir, 'jobs.sqlite3')

    try {
      const result = await requestUpdate(input(), {
        stateDir,
        workerFile,
        updaterPath,
        tmuxPath,
        tmuxSession: session,
        legacyCutover: true,
        projectDir,
        idFactory: () => 'request-detached',
      })
      expect(result.accepted).toBe(true)
      for (let attempt = 0; attempt < 40 && !existsSync(join(stateDir, 'worker-started')); attempt += 1) {
        await Bun.sleep(25)
      }
      expect(JSON.parse(readFileSync(join(stateDir, 'worker-started'), 'utf8'))).toEqual({
        requestId: 'request-detached',
        stateDir,
        legacyCutover: '1',
        legacyCutoverArg: '1',
        projectDir,
        projectDirArg: projectDir,
        jobDb: join(realpathSync(stateDir), 'jobs.sqlite3'),
      })
      const alive = Bun.spawnSync([tmuxPath, 'has-session', '-t', session])
      expect(alive.exitCode).toBe(0)
    } finally {
      Bun.spawnSync([tmuxPath, 'kill-server'])
      if (previousJobDb === undefined) delete process.env.ZEROKUN_JOB_DB
      else process.env.ZEROKUN_JOB_DB = previousJobDb
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
