import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import {
  acquireDetachedLeaderIdentity, executeUpdater, launchDetachedUpdateWorker,
  requestUpdate, resumePendingUpdateWorker,
  runUpdaterGate, runUpdateWorker, updateWorkerSessionName,
  withUpdateSlackDeadline, withoutUpdateNotificationNetworkOverrides,
} from './update-request'
import {
  applyStateEnvironment,
  buildCandidateEnvironment,
  buildRuntimeLaunchEnvironment,
  buildRuntimeServiceEnvironment,
  buildSetupEnvironment,
  buildUpdaterEnvironment,
} from './child-environment'
import { observeProcessGeneration, readProcessIdentity } from './process-generation'
import { runTmuxCommand } from './tmux-command'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zerokun-update-request-test-'))
  tempDirs.push(dir)
  return dir
}

// 実機の既定tmux serverには本番のbotが載っているので、テストは私設socketへ隔離する。
function tmuxHarness(dir: string) {
  const which = Bun.spawnSync(['/usr/bin/which', 'tmux'], { stdout: 'pipe' })
  expect(which.exitCode).toBe(0)
  const realTmux = new TextDecoder().decode(which.stdout).trim()
  const socket = `zerochan-update-test-${basename(dir)}`
  const tmuxPath = join(dir, 'isolated-tmux')
  writeFileSync(
    tmuxPath,
    `#!/bin/bash\nexec ${JSON.stringify(realTmux)} -L ${JSON.stringify(socket)} "$@"\n`,
    { mode: 0o700 },
  )
  return {
    tmuxPath,
    exists: (session: string) =>
      runTmuxCommand(tmuxPath, ['has-session', '-t', `=${session}`]).exitCode === 0,
    start: (session: string) =>
      runTmuxCommand(tmuxPath, ['new-session', '-d', '-s', session, 'sleep 60']).exitCode,
    killServer: () => { runTmuxCommand(tmuxPath, ['kill-server']) },
  }
}

function fakeWorkerFiles(dir: string) {
  const workerFile = join(dir, 'fake-worker.ts')
  const updaterPath = join(dir, 'fake-updater.ts')
  writeFileSync(workerFile, [
    "import { writeFileSync } from 'fs'",
    "import { join } from 'path'",
    "const args = process.argv.slice(2)",
    "const stateIndex = args.indexOf('--state-dir')",
    "writeFileSync(join(args[stateIndex + 1], 'worker-started'), args[1])",
    'await Bun.sleep(60_000)',
    '',
  ].join('\n'))
  writeFileSync(updaterPath, '#!/usr/bin/env bun\n')
  return { workerFile, updaterPath }
}

async function waitForWorker(stateDir: string): Promise<void> {
  for (let attempt = 0; attempt < 80 && !existsSync(join(stateDir, 'worker-started')); attempt += 1) {
    await Bun.sleep(25)
  }
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
      ZEROKUN_JOB_MODEL: 'gpt-machine-local',
      ZEROKUN_UPDATE_TESTING: '1',
      ZEROKUN_SLACK_IDENTITY_TEST_APP_ID: 'AOLDAPP123',
      ZEROKUN_SETUP_TEST_STOP_PROBE: '/tmp/should-not-be-used',
      ZEROKUN_CODEX_BIN: '/tmp/ambient-codex',
      HTTPS_PROXY: 'http://ambient-proxy.invalid',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    }
    applyStateEnvironment([
      'SLACK_BOT_TOKEN=xoxb-new-app-not-real',
      'SLACK_APP_TOKEN=xapp-1-ANEWAPP123-new-app-not-real',
      'ZEROKUN_JOB_POLL_MS=500',
      'ZEROKUN_JOB_MODEL=gpt-state-local',
      'HTTPS_PROXY=http://state-proxy.invalid',
      'NODE_TLS_REJECT_UNAUTHORIZED=0',
      'ZEROKUN_UPDATE_TESTING=1',
      'ZEROKUN_SLACK_IDENTITY_TEST_APP_ID=AATTACKER1',
      'ZEROKUN_SETUP_TEST_STOP_PROBE=/tmp/state-probe',
      'ZEROKUN_CODEX_BIN=/tmp/state-codex',
      'ZEROKUN_SETUP_SCRIPT=/tmp/state-setup.sh',
      'ZEROKUN_JOB_RUNNER=/tmp/state-runner.ts',
      'ZEROKUN_TMUX_PATH=/tmp/state-tmux',
      'ZEROKUN_UPDATE_BRANCH=attacker-branch',
      'ZEROKUN_CATCHUP_LIMIT=25',
      '',
    ].join('\n'), environment)
    expect(environment.SLACK_BOT_TOKEN).toBe('xoxb-new-app-not-real')
    expect(environment.SLACK_APP_TOKEN).toBe('xapp-1-ANEWAPP123-new-app-not-real')
    expect(environment.ZEROKUN_JOB_POLL_MS).toBe('250')
    expect(environment.ZEROKUN_JOB_MODEL).toBeUndefined()
    expect(environment.HTTPS_PROXY).toBeUndefined()
    expect(environment.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
    expect(environment.ZEROKUN_UPDATE_TESTING).toBeUndefined()
    expect(environment.ZEROKUN_SLACK_IDENTITY_TEST_APP_ID).toBeUndefined()
    expect(environment.ZEROKUN_SETUP_TEST_STOP_PROBE).toBeUndefined()
    expect(environment.ZEROKUN_CODEX_BIN).toBeUndefined()
    expect(environment.ZEROKUN_SETUP_SCRIPT).toBeUndefined()
    expect(environment.ZEROKUN_JOB_RUNNER).toBeUndefined()
    expect(environment.ZEROKUN_TMUX_PATH).toBeUndefined()
    expect(environment.ZEROKUN_UPDATE_BRANCH).toBeUndefined()
    expect(environment.ZEROKUN_CATCHUP_LIMIT).toBe('25')

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
      ZEROKUN_JOB_MODEL: 'gpt-machine-local',
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
    const setup = buildSetupEnvironment({ ...source, ZEROKUN_CODEX_BIN: '/trusted/updater-codex' })
    expect(setup.ZEROKUN_CODEX_BIN).toBeUndefined()
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
    expect(service.ZEROKUN_CODEX_BIN).toBeUndefined()
    expect(service.ZEROKUN_JOB_MODEL).toBeUndefined()
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

  test('workerは旧standalone commandへfallbackせず明示entrypointを要求する', async () => {
    const stateDir = fixtureDir()
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-without-entrypoint',
      launchWorker: () => {},
    })
    await expect(runUpdateWorker('request-without-entrypoint', {
      stateDir,
      notify: async () => {},
    })).rejects.toThrow('Zeroちゃん更新entrypointが指定されていません')
  })

  test('Slack完了通知はbodyを読み終えるまでdeadlineの内側で完結する', async () => {
    const stateDir = fixtureDir()
    const projectDir = join(stateDir, 'project')
    const updater = join(stateDir, 'noop-updater.ts')
    writeFileSync(updater, 'export {}\n')
    writeFileSync(join(stateDir, '.env'), [
      'SLACK_BOT_TOKEN=xoxb-0123456789abcdef',
      'SLACK_APP_TOKEN=xapp-1-A0TESTAPP-1234567890abcdef',
      '',
    ].join('\n'))
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-notify-body',
      launchWorker: () => {},
    })

    // 実物のfetchと同じく、bodyはheaderより後に届き、signalがabortされたらstreamが壊れる。
    // 以前はdeadline scopeを抜けた後にresponse.json()を呼んでいたため、必ずここで失敗していた。
    const posted: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((url: any, init: any = {}) => {
      const target = String(url)
      posted.push(target)
      const payload = target.endsWith('auth.test')
        ? { ok: true, app_id: 'A0TESTAPP', bot_id: 'B0TESTBOT', user_id: 'U0TESTBOT' }
        : target.endsWith('bots.info')
          ? { ok: true, bot: { app_id: 'A0TESTAPP' } }
          : { ok: true }
      const signal = init.signal as AbortSignal | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            if (signal?.aborted) {
              controller.error(new Error('The operation was aborted.'))
              return
            }
            controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)))
            controller.close()
          }, 0)
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    }) as typeof fetch

    const previousJobDb = process.env.ZEROKUN_JOB_DB
    process.env.ZEROKUN_JOB_DB = join(stateDir, 'jobs.sqlite3')
    try {
      const result = await runUpdateWorker('request-notify-body', {
        stateDir,
        updaterPath: updater,
        legacyCutover: true,
        projectDir,
        maxNotifyAttempts: 1,
      })
      expect(result.notificationSent).toBe(true)
      expect(posted.some(url => url.endsWith('chat.postMessage'))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
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
    expect(notifications[0]).toContain('このMacの管理ログ')
    expect(notifications[0]).not.toContain('Codex')
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

  test('配信し損ねたoutcomeが残っていても新しい更新依頼を受け付ける', async () => {
    const stateDir = fixtureDir()
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-undelivered',
      launchWorker: () => {},
    })
    const request = JSON.parse(readFileSync(join(stateDir, 'update-request.json'), 'utf8'))
    // 更新自体は完了したがSlack通知だけが落ちた状態。notifiedAtは配信成功でしか付かないので、
    // ここでduplicateを返し続けると二度と更新できなくなる(実機で発生した)。
    request.outcome = { success: true, exitCode: 0, text: 'done', completedAt: Date.now() }
    writeFileSync(join(stateDir, 'update-request.json'), JSON.stringify(request))

    const events: string[] = []
    const second = await requestUpdate(input('1787000000.000200'), {
      stateDir,
      idFactory: () => 'request-after-undelivered',
      isWorkerRunning: () => false,
      isUpdateRunning: () => false,
      launchWorker: () => events.push('launch'),
      onAccepted: async () => { events.push('ack') },
      onDuplicate: async () => { events.push('duplicate') },
    })

    expect(second.accepted).toBe(true)
    expect(second.duplicate).toBe(false)
    expect(second.request.id).toBe('request-after-undelivered')
    expect(events).toEqual(['ack', 'launch'])
  })

  test('通知期限切れのoutcomeは再起動せず同一event用の記録として残す', async () => {
    const stateDir = fixtureDir()
    await requestUpdate(input(), {
      stateDir,
      idFactory: () => 'request-give-up-notify',
      launchWorker: () => {},
    })
    const request = JSON.parse(readFileSync(join(stateDir, 'update-request.json'), 'utf8'))
    request.outcome = { success: true, exitCode: 0, text: 'done', completedAt: Date.now() }
    writeFileSync(join(stateDir, 'update-request.json'), JSON.stringify(request))

    const launched: string[] = []
    expect(resumePendingUpdateWorker({
      stateDir,
      isWorkerRunning: () => false,
      isUpdateRunning: () => false,
      launchWorker: value => launched.push(value.id),
      now: () => Date.now() + 7 * 60 * 60 * 1000,
    })).toBe(false)
    expect(launched).toEqual([])
    expect(JSON.parse(readFileSync(join(stateDir, 'update-request.json'), 'utf8')).id)
      .toBe('request-give-up-notify')
    const replay = await requestUpdate(input(), {
      stateDir,
      isWorkerRunning: () => false,
      isUpdateRunning: () => false,
      launchWorker: value => launched.push(value.id),
      now: () => Date.now() + 8 * 60 * 60 * 1000,
    })
    expect(replay.duplicate).toBe(true)
    expect(replay.request.id).toBe('request-give-up-notify')
    expect(launched).toEqual([])
  })

  for (const success of [true, false]) {
    test(`未通知の同一eventは通知だけ再開する: update success=${success}`, async () => {
      const stateDir = fixtureDir()
      await requestUpdate(input(), {
        stateDir, idFactory: () => 'original-update', launchWorker: () => {},
      })
      let executions = 0
      await runUpdateWorker('original-update', {
        stateDir,
        executeUpdater: async () => { executions += 1; return success ? 0 : 17 },
        notify: async () => { throw new Error('synthetic delivery failure') },
        maxNotifyAttempts: 1,
      })
      const launched: string[] = []
      const replay = await requestUpdate(input(), {
        stateDir,
        idFactory: () => 'must-not-create-new-update',
        isWorkerRunning: () => false,
        isUpdateRunning: () => false,
        launchWorker: request => launched.push(request.id),
      })
      expect(replay.accepted).toBe(false)
      expect(replay.duplicate).toBe(true)
      expect(launched).toEqual(['original-update'])
      const result = await runUpdateWorker(launched[0]!, {
        stateDir,
        executeUpdater: async () => { executions += 1; return 0 },
        notify: async () => {},
      })
      expect(executions).toBe(1)
      expect(result).toEqual({ success, exitCode: success ? 0 : 17, notificationSent: true })
    })
  }

  for (const elapsed of [999, 1000, 1001]) {
    test(`通知期限は完了時刻から計測し両入口で一致する: elapsed=${elapsed}`, async () => {
      const stateDir = fixtureDir()
      const completedAt = 8 * 60 * 60 * 1000
      await requestUpdate(input(), {
        stateDir, now: () => 1, idFactory: () => 'long-update', launchWorker: () => {},
      })
      const path = join(stateDir, 'update-request.json')
      const request = JSON.parse(readFileSync(path, 'utf8'))
      request.outcome = { success: true, exitCode: 0, text: 'done', completedAt }
      writeFileSync(path, JSON.stringify(request))
      const launched: string[] = []
      const options = {
        stateDir, now: () => completedAt + elapsed, staleAfterMs: 1000,
        isWorkerRunning: () => false, isUpdateRunning: () => false,
        launchWorker: (value: { id: string }) => launched.push(value.id),
      }
      const expectedLaunch = elapsed <= 1000
      expect(resumePendingUpdateWorker(options)).toBe(expectedLaunch)
      expect(resumePendingUpdateWorker(options)).toBe(expectedLaunch)
      const replay = await requestUpdate(input(), options)
      expect(replay.accepted).toBe(false)
      expect(replay.request.id).toBe('long-update')
      expect(launched).toEqual(expectedLaunch ? ['long-update', 'long-update', 'long-update'] : [])
      expect(JSON.parse(readFileSync(path, 'utf8')).outcome).toEqual(request.outcome)
      const next = await requestUpdate(input('1787000000.000200'), {
        ...options, idFactory: () => 'next-update',
      })
      expect(next.accepted).toBe(true)
      expect(next.request.id).toBe('next-update')
    })
  }

  for (const guard of ['worker', 'updater', 'gate'] as const) {
    test(`未通知outcomeでも${guard}が動作中なら再起動も置換もしない`, async () => {
      const stateDir = fixtureDir()
      await requestUpdate(input(), {
        stateDir, now: () => 1, idFactory: () => 'running-update', launchWorker: () => {},
      })
      const path = join(stateDir, 'update-request.json')
      const request = JSON.parse(readFileSync(path, 'utf8'))
      request.outcome = { success: true, exitCode: 0, text: 'done', completedAt: 2 }
      const gateProcess = guard === 'gate'
        ? Bun.spawn(['/bin/sleep', '30'], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
        : undefined
      try {
        if (guard === 'gate') {
          request.gate = await acquireDetachedLeaderIdentity(gateProcess!.pid)
          expect(request.gate).toBeDefined()
          expect(request.gate.pgid).toBe(request.gate.pid)
        }
        writeFileSync(path, JSON.stringify(request))
        const launched: string[] = []
        const options = {
          stateDir, isWorkerRunning: () => guard === 'worker',
          isUpdateRunning: () => guard === 'updater',
          launchWorker: (value: { id: string }) => launched.push(value.id),
        }
        for (const now of [3, 8 * 60 * 60 * 1000]) {
          expect(resumePendingUpdateWorker({ ...options, now: () => now })).toBe(false)
          for (const messageId of [input().messageId, '1787000000.000200']) {
            const replay = await requestUpdate(input(messageId), { ...options, now: () => now })
            expect(replay.duplicate).toBe(true)
            expect(replay.request.id).toBe('running-update')
          }
        }
        expect(launched).toEqual([])
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(request)
      } finally {
        if (gateProcess) {
          gateProcess.kill()
          await gateProcess.exited
        }
      }
    })
  }

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

  // 2026-09-18、オーナーが全台へ同時に更新を依頼したとき、ベルミちゃんとベルミくんが
  // 同じ 'zerokun-update-worker' というtmux session名を取り合い、先に取った側だけが更新
  // できて、もう一方が「別の…更新workerが実行中です」で弾かれた。
  test('同居する相手製品や旧名のsessionが居ても更新を受け付け、同じstate dirの二重起動は今まで通り弾く', async () => {
    const tmux = tmuxHarness(fixtureDir())
    const stateA = fixtureDir()
    const stateB = fixtureDir()
    const { workerFile, updaterPath } = fakeWorkerFiles(fixtureDir())
    // 相手製品(ベルミくん)の更新workerと、旧実装が使っていた固定名を先に立てておく。
    const decoys = ['bellmi-update-5f51677912cc', 'zerokun-update-worker']

    try {
      for (const decoy of decoys) expect(tmux.start(decoy)).toBe(0)

      const first = await requestUpdate(input(), {
        stateDir: stateA,
        workerFile,
        updaterPath,
        tmuxPath: tmux.tmuxPath,
        idFactory: () => 'alpha',
      })
      expect(first.accepted).toBe(true)
      await waitForWorker(stateA)
      expect(tmux.exists(updateWorkerSessionName(stateA))).toBe(true)
      // 相手のworkerも旧名のsessionも、こちらの更新で巻き添えにしない。
      for (const decoy of decoys) expect(tmux.exists(decoy)).toBe(true)

      // 別のstate dir(=別の同居ボット)は同時に更新を始められる。
      const second = await requestUpdate(input('1787000000.000200'), {
        stateDir: stateB,
        workerFile,
        updaterPath,
        tmuxPath: tmux.tmuxPath,
        idFactory: () => 'beta',
      })
      expect(second.accepted).toBe(true)
      await waitForWorker(stateB)
      expect(updateWorkerSessionName(stateB)).not.toBe(updateWorkerSessionName(stateA))
      expect(tmux.exists(updateWorkerSessionName(stateA))).toBe(true)
      expect(tmux.exists(updateWorkerSessionName(stateB))).toBe(true)

      // 同じstate dirの二重更新は今まで通り弾く。
      expect(() => launchDetachedUpdateWorker(first.request, {
        stateDir: stateA,
        workerFile,
        updaterPath,
        tmuxPath: tmux.tmuxPath,
      })).toThrow('別のZeroちゃん更新workerが実行中です')
    } finally {
      tmux.killServer()
    }
  })

  // bot起動のたびに走る経路。ここだけ旧固定名のままだと、生きているworkerを見落として
  // 2本目を起こす。
  test('resumePendingUpdateWorkerもstate dirごとのsessionで生存workerを見つける', async () => {
    const tmux = tmuxHarness(fixtureDir())
    const stateDir = fixtureDir()
    const { workerFile, updaterPath } = fakeWorkerFiles(fixtureDir())

    try {
      const accepted = await requestUpdate(input(), {
        stateDir,
        workerFile,
        updaterPath,
        tmuxPath: tmux.tmuxPath,
        idFactory: () => 'resume-target',
      })
      expect(accepted.accepted).toBe(true)
      await waitForWorker(stateDir)
      expect(tmux.exists(updateWorkerSessionName(stateDir))).toBe(true)

      expect(resumePendingUpdateWorker({
        stateDir,
        workerFile,
        updaterPath,
        tmuxPath: tmux.tmuxPath,
      })).toBe(false)
    } finally {
      tmux.killServer()
    }
  })

  test('前方一致する無関係sessionを自分のworkerと誤認しない', async () => {
    const tmux = tmuxHarness(fixtureDir())
    const stateDir = fixtureDir()
    const { workerFile, updaterPath } = fakeWorkerFiles(fixtureDir())

    try {
      expect(tmux.start(`${updateWorkerSessionName(stateDir)}-decoy`)).toBe(0)
      const result = await requestUpdate(input(), {
        stateDir,
        workerFile,
        updaterPath,
        tmuxPath: tmux.tmuxPath,
        idFactory: () => 'not-confused',
      })
      expect(result.accepted).toBe(true)
      await waitForWorker(stateDir)
      expect(tmux.exists(updateWorkerSessionName(stateDir))).toBe(true)
    } finally {
      tmux.killServer()
    }
  })

  test('更新worker sessionはstate dirの実体pathごとに決まり、旧名やbot名の前方一致を作らない', () => {
    const a = fixtureDir()
    const b = fixtureDir()

    expect(updateWorkerSessionName(a)).toBe(updateWorkerSessionName(a))
    expect(updateWorkerSessionName(a)).not.toBe(updateWorkerSessionName(b))
    expect(updateWorkerSessionName(`${a}/`)).toBe(updateWorkerSessionName(a))

    const link = join(b, 'link-to-a')
    symlinkSync(a, link)
    expect(updateWorkerSessionName(link)).toBe(updateWorkerSessionName(a))

    // requestUpdate は state dir を作る前に名前を決めるので、作成の前後で名前が変わって
    // はいけない(macOS の /var -> /private/var で単純な realpath だと実際に変わる)。
    const missing = join(a, 'not-created-yet')
    const before = updateWorkerSessionName(missing)
    mkdirSync(missing)
    expect(updateWorkerSessionName(missing)).toBe(before)

    expect(updateWorkerSessionName(a)).toMatch(/^zerochan-update-[0-9a-f]{12}$/)
    // 旧固定名やbot常駐sessionの前方一致になると、tmuxの緩い名前解決で
    // 相手repoの旧コードやkill-sessionに巻き込まれる。
    expect(updateWorkerSessionName(a).startsWith('zerokun-update-worker')).toBe(false)
    expect(updateWorkerSessionName(a).startsWith('zerokun-slack')).toBe(false)
    // 本番のstate dirで実際に使われる名前。同居するベルミくんは bellmi-update-* になる。
    expect(updateWorkerSessionName('/Users/zerocolored_ai03/.codex/zerokun'))
      .toBe('zerochan-update-5ab1dda68a07')
  })

  test('tmuxのtarget構文になるsession名を拒否する', () => {
    const stateDir = fixtureDir()
    const { workerFile, updaterPath } = fakeWorkerFiles(stateDir)
    const request = {
      ...input(),
      id: 'rejected-session-name',
      requestedAt: 1787000000000,
    }

    for (const name of ['session.dot', 'session:colon', 'session*', '', 'session space']) {
      expect(() => launchDetachedUpdateWorker(request, {
        stateDir,
        workerFile,
        updaterPath,
        tmuxSession: name,
      })).toThrow('tmux session名が不正です')
    }
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
    expect(runTmuxCommand(
      tmuxPath,
      ['new-session', '-d', '-s', keeper, 'sleep 30'],
    ).exitCode).toBe(0)
    expect(runTmuxCommand(
      tmuxPath,
      ['set-environment', '-g', 'ZEROKUN_JOB_DB', '/tmux/stale/jobs.sqlite3'],
    ).exitCode).toBe(0)
    expect(runTmuxCommand(
      tmuxPath,
      ['set-environment', '-g', 'ZEROKUN_SETUP_SCRIPT', '/tmux/stale/setup.sh'],
    ).exitCode).toBe(0)
    expect(runTmuxCommand(
      tmuxPath,
      ['set-environment', '-g', 'SLACK_BOT_TOKEN', 'xoxb-tmux-stale-not-real'],
    ).exitCode).toBe(0)
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
      expect(result.request.projectDir).toBe(projectDir)
      expect(JSON.parse(readFileSync(join(stateDir, 'update-request.json'), 'utf8')).projectDir)
        .toBe(projectDir)
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
      const alive = runTmuxCommand(tmuxPath, ['has-session', '-t', session])
      expect(alive.exitCode).toBe(0)
    } finally {
      runTmuxCommand(tmuxPath, ['kill-server'])
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
    // 実装方式や固定のApp表示名はSlack上へ露出せず、完了だけを伝える。
    expect(notifications[0]).toContain('更新完了')
    expect(notifications[0]).not.toContain('Zeroちゃん')
    expect(notifications[0]).not.toContain('Codex')
    expect(notifications[0]).not.toContain('tmux')
    expect(notifications[0]).not.toContain('Ctrl-b')
    expect(notifications[0]).not.toContain('request-success')
    expect(notifications[0]).not.toMatch(/request\s+[0-9a-z-]+/i)
    expect(notifications[0]).not.toContain(stateDir)
    expect(notifications[0]).not.toContain('.codex')
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

    // 内部の旧tmux markerが残っていても、利用者向け文面へ実装詳細を露出しない。
    expect(actualSession).toBe('zerokun-slack-a1b2c3d4')
    expect(notifications[0]).not.toContain(actualSession)
    expect(notifications[0]).not.toContain('tmux')
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
    expect(notifications[0]).not.toContain('request-error')
    expect(notifications[0]).not.toMatch(/request\s+[0-9a-z-]+/i)
    expect(notifications[0]).not.toContain(stateDir)
    expect(notifications[0]).not.toContain('.codex')
    expect(notifications[0]).not.toMatch(/Codex|worker|job/i)
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
    expect(readFileSync(join(stateDir, 'update-request.log'), 'utf8'))
      .toContain('notify attempt 1/1 failed: Error: Slack 503')

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
