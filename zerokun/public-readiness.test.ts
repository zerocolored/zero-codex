import { describe, expect, test } from 'bun:test'
import {
  existsSync,
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
import {
  clearGatewayReadiness,
  readGatewayReadiness,
  writeGatewayReadiness,
} from './readiness.ts'
import {
  completeSlackSideEffect,
  DEFAULT_SLACK_HTTP_TIMEOUT_MS,
  openDirectSlackDownload,
  postDirectSlackApi,
  slackHttpTimeoutMs,
  slackWebClientOptions,
  withSlackDeadline,
} from './slack-http.ts'
import { resolveZeroJobDatabasePath, resolveZeroStateDir } from './state-dir.ts'
import { takeSlackTokensFromEnvironment } from './child-environment.ts'

describe('public Codex defaults', () => {
  test('公開手順はApp Server・live control・20 job session・無期限実行と一致する', () => {
    const rootReadme = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8')
    const runtimeReadme = readFileSync(join(import.meta.dir, 'README.md'), 'utf8')
    const broker = readFileSync(join(import.meta.dir, 'advisor-broker.ts'), 'utf8')
    const fifthHelper = readFileSync(join(import.meta.dir, 'fifth-advisor.py'), 'utf8')
    for (const guide of [rootReadme, runtimeReadme]) {
      expect(guide).toContain('codex app-server --stdio')
      expect(guide).toContain('turn/steer')
      expect(guide).toContain('turn/interrupt')
      expect(guide).toContain('20 job')
      expect(guide).toContain('sender')
      expect(guide).toContain('willRetry: true')
    }
    expect(rootReadme).toContain('job本体に最長時間は設けません')
    expect(runtimeReadme).toContain('job本体に終了時間制限はありません')
    expect(rootReadme).not.toContain('job本体はapp-serverで実行しません')
    expect(runtimeReadme).not.toContain('read-only jobは合計5回の実行まで再開')
    expect(broker).not.toContain('GROK_TIMEOUT_MS')
    expect(broker).not.toContain('CLAUDE_TIMEOUT_MS')
    expect(fifthHelper).toContain('CLAUDE_START_TIMEOUT_MS = 300_000')
    expect(fifthHelper).toContain('["workspace", "close", workspace_id]')
    expect(broker).toContain('Date.now() + 60 * 60 * 1_000')
  })

  test('公開CIはGrok認証を要求せずCodex設定だけを実機検証する', () => {
    const workflow = readFileSync(join(import.meta.dir, '..', '.github/workflows/codex.yml'), 'utf8')
    const executor = readFileSync(join(import.meta.dir, 'codex-executor.ts'), 'utf8')
    expect(workflow).toContain('codex-executor.ts verify-codex-config')
    expect(workflow).not.toContain('codex-executor.ts verify-system-config')
    expect(workflow).toContain('https://herdr.dev/install.sh')
    expect(workflow).toContain('HERDR_INSTALL_DIR="$HOME/.local/bin"')
    expect(workflow).not.toContain('brew install tmux herdr')
    expect(executor).toContain("command === 'verify-codex-config'")
    expect(executor).toContain('resolveDedicatedGrokLauncher()\n  await verifyCodexConfig')
  })

  test('candidate sandboxの絞り込みtest名は対象fileにexact 1件ずつ存在する', () => {
    const root = join(import.meta.dir, '..')
    const verify = readFileSync(join(import.meta.dir, 'verify.sh'), 'utf8')
    const selectors = [...verify.matchAll(
      /candidate_contract_test\s+(\S+)\s+\\\n\s+'([^']+)'/g,
    )]
    const callCount = (verify.match(/^\s*candidate_contract_test\s+/gm) ?? []).length
    expect(selectors.length).toBeGreaterThan(0)
    expect(selectors.length).toBe(callCount)
    for (const [, relativePath, selector] of selectors) {
      const target = readFileSync(join(root, relativePath!), 'utf8')
      expect(selector!).not.toMatch(/[\\^$.*+?()[\]{}|]/)
      expect(
        target.split(`test('${selector!}',`).length - 1,
        `${relativePath}: ${selector}`,
      ).toBe(1)
    }
  })

  test('認証済みlive検証も本番と同じMCP隔離結果だけでApp Serverを起動する', () => {
    const liveCheck = readFileSync(join(import.meta.dir, 'live-codex-permission-check.ts'), 'utf8')
    const build = liveCheck.indexOf('const baseOverrides = buildCodexPermissionOverrides(')
    const resolve = liveCheck.indexOf(
      'const overrides = await resolveEffectiveCodexPermissionOverrides(',
      build,
    )
    const revalidate = liveCheck.indexOf('verifyOfficialCodexSnapshot(codex)', resolve)
    const spawn = liveCheck.indexOf('const proc = Bun.spawn([', revalidate)
    const spawnOverrides = liveCheck.indexOf(
      "...overrides.flatMap(override => ['-c', override])",
      spawn,
    )
    expect(build).toBeGreaterThan(0)
    expect(resolve).toBeGreaterThan(build)
    expect(revalidate).toBeGreaterThan(resolve)
    expect(spawn).toBeGreaterThan(revalidate)
    expect(spawnOverrides).toBeGreaterThan(spawn)
  })

  test('本番App Serverは同じconnectionのeffective config検証後だけthreadを開く', () => {
    const executor = readFileSync(join(import.meta.dir, 'codex-executor.ts'), 'utf8')
    const flow = executor.indexOf('await session.initialize()')
    const guard = executor.indexOf('assertCurrentAppServerCodexPermissionConfig(', flow)
    const resume = executor.indexOf('session.resumeThread(', guard)
    const start = executor.indexOf('session.startThread(', guard)
    expect(flow).toBeGreaterThan(0)
    expect(guard).toBeGreaterThan(flow)
    expect(resume).toBeGreaterThan(guard)
    expect(start).toBeGreaterThan(guard)
  })

  test('Slack uploadはHTTP byte直前にintentを立て完了receiptまで追跡する', () => {
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    const transport = readFileSync(join(import.meta.dir, 'slack-http.ts'), 'utf8')
    const operation = runner.indexOf('await this.completeStartedSideEffect(async () => {')
    const target = runner.indexOf('requestUploadTarget(', operation)
    const abort = runner.indexOf('if (signal?.aborted)', target)
    const bytes = runner.indexOf('this.uploadDependencies.uploadBytes(', abort)
    const intent = runner.indexOf(
      'this.store.beginArtifactDelivery(job.id, requested, target.fileId)',
      bytes,
    )
    const receipt = runner.indexOf('this.store.markArtifactDelivered(job.id, requested)', bytes)
    const request = transport.indexOf('const request = httpsRequest(')
    const beforeWrite = transport.indexOf('beforeRequestWrite()', request)
    const end = transport.indexOf('request.end(data)', beforeWrite)
    expect(operation).toBeGreaterThan(0)
    expect(target).toBeGreaterThan(operation)
    expect(abort).toBeGreaterThan(target)
    expect(bytes).toBeGreaterThan(abort)
    expect(intent).toBeGreaterThan(bytes)
    expect(receipt).toBeGreaterThan(bytes)
    expect(request).toBeGreaterThan(0)
    expect(beforeWrite).toBeGreaterThan(request)
    expect(end).toBeGreaterThan(beforeWrite)
  })

  test('repository未取得の新規Macにもmain branch bootstrapの取得手順がある', () => {
    const rootReadme = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8')
    const runtimeReadme = readFileSync(join(import.meta.dir, 'README.md'), 'utf8')
    const setupGuide = readFileSync(join(import.meta.dir, 'NEW_MAC_SETUP.md'), 'utf8')
    const bootstrap = readFileSync(join(import.meta.dir, 'bootstrap-macos.sh'), 'utf8')
    const codexVersion = readFileSync(join(import.meta.dir, 'codex-version.sh'), 'utf8')
    const codexChannel = readFileSync(join(import.meta.dir, '..', 'codex-channel.sh'), 'utf8')
    const rawBootstrap = 'https://raw.githubusercontent.com/zerocolored/zero-codex/main/zerokun/bootstrap-macos.sh'
    for (const guide of [rootReadme, runtimeReadme, setupGuide]) {
      expect(guide).toContain(rawBootstrap)
      expect(guide).toContain('/usr/bin/mktemp -d /tmp/zerokun-bootstrap.XXXXXX')
      expect(guide).toContain('/usr/bin/env -i PATH=/usr/bin:/bin TMPDIR=/tmp')
      expect(guide).toContain("/usr/bin/curl -q --fail --location --proto '=https'")
      expect(guide).toContain("--noproxy '*'")
      expect(guide).toContain('--output "$bootstrap_path"')
      expect(guide).toContain('--with-slack')
      expect(guide).toContain('Herdr 0.8.2')
    }
    expect(codexVersion).not.toContain('curl -fsSL')
    expect(codexVersion).toContain('standalone-codex.ts" version')
    expect(codexVersion).not.toContain('"$codex_bin" --version')
    expect(codexVersion).not.toContain('${ZEROKUN_CODEX_BIN:-codex}')
    expect(codexVersion).toContain('bash zerokun/bootstrap-macos.sh --skip-slack')
    expect(codexVersion).toContain('ZEROKUN_MIN_HERDR_VERSION="0.8.2"')
    expect(codexVersion).toContain('zerokun_herdr_capabilities_ready')
    expect(codexVersion).toContain('zerokun_claude_subscription_ready')
    expect(codexChannel).toContain('zerokun_claude_subscription_ready')
    expect(codexChannel.indexOf('zerokun_claude_subscription_ready')).toBeLessThan(
      codexChannel.indexOf('start_job_runner() {'),
    )
    expect(bootstrap).toContain('claude_subscription_ready')
    expect(bootstrap).not.toContain('claude auth login')
    expect(rootReadme).toContain('新しいSlack App')
    expect(rootReadme).toContain('tokenをこのPCへコピーしないでください')
    expect(setupGuide).toContain('そのSlack Appやtokenも流用しません')
    expect(bootstrap).toContain('このCodex版用に新しいAppを作成してください')
    expect(bootstrap).toContain('xapp-/xoxb-トークンは使用しません')
  })

  test('legacy stateや互換envを暗黙採用せずCodex stateを既定にする', () => {
    const home = '/Users/tester'
    expect(resolveZeroStateDir({ ZEROKUN_STATE_DIR: '/explicit' }, home))
      .toBe('/explicit')
    expect(resolveZeroStateDir({ SLACK_STATE_DIR: '/legacy-compat' }, home))
      .toBe(join(home, '.codex/zerokun'))
    expect(resolveZeroStateDir({ ZEROKUN_STATE_DIR: join(home, '.claude/channels/slack') }, home))
      .toBe(join(home, '.codex/zerokun'))
    expect(resolveZeroStateDir({
      ZEROKUN_STATE_DIR: join(home, '.claude/channels/../channels/slack/'),
    }, home)).toBe(join(home, '.codex/zerokun'))
    expect(() => resolveZeroStateDir({
      ZEROKUN_STATE_DIR: join(home, '.claude/channels/slack'),
      ZEROKUN_LEGACY_CUTOVER: '1',
    }, home)).toThrow('legacy cutover state')
    expect(resolveZeroStateDir({}, home)).toBe(join(home, '.codex/zerokun'))
  })

  test('shell resolverもlegacy fileとSLACK_STATE_DIRを無視する', () => {
    const home = mkdtempSync(join(tmpdir(), 'zerokun-state-default-'))
    const legacy = join(home, '.claude/channels/slack')
    const alias = join(home, 'legacy-state-alias')
    try {
      mkdirSync(legacy, { recursive: true })
      symlinkSync(legacy, alias)
      writeFileSync(join(legacy, '.env'), '', { mode: 0o600 })
      expect(() => resolveZeroStateDir({
        ZEROKUN_STATE_DIR: legacy,
        ZEROKUN_LEGACY_CUTOVER: '1',
      }, home)).toThrow('valid Slack App tokens')
      const legacyEnvironment = [
        'LEGACY_SENTINEL=keep',
        'SLACK_BOT_TOKEN=xoxb-existing-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-A0123456789-existing-not-a-real-token',
        '',
      ].join('\n')
      writeFileSync(join(legacy, '.env'), legacyEnvironment, { mode: 0o600 })
      expect(resolveZeroStateDir({ ZEROKUN_STATE_DIR: alias }, home))
        .toBe(join(home, '.codex/zerokun'))
      for (const configured of [
        legacy,
        `${join(home, '.claude/channels/../channels/slack')}//`,
        alias,
      ]) {
        const result = Bun.spawnSync([
          '/bin/bash', '-c', '. "$1"; zerokun_resolve_state_dir', '_',
          join(import.meta.dir, 'state-dir.sh'),
        ], {
          env: {
            ...process.env,
            HOME: home,
            SLACK_STATE_DIR: legacy,
            ZEROKUN_STATE_DIR: configured,
            ZEROKUN_LEGACY_CUTOVER: '0',
          },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        expect(result.stdout.toString().trim()).toBe(join(home, '.codex/zerokun'))
      }
      const cutover = Bun.spawnSync([
        '/bin/bash', '-c', '. "$1"; zerokun_resolve_state_dir', '_',
        join(import.meta.dir, 'state-dir.sh'),
      ], {
        env: {
          ...process.env,
          HOME: home,
          ZEROKUN_STATE_DIR: `${legacy}/`,
          ZEROKUN_LEGACY_CUTOVER: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(cutover.exitCode, cutover.stderr.toString()).toBe(0)
      expect(cutover.stdout.toString().trim()).toBe(`${legacy}/`)
      expect(readFileSync(join(legacy, '.env'), 'utf8')).toBe(legacyEnvironment)

      const symlinkHome = join(home, 'symlink-home')
      const physicalClaude = join(home, 'config/claude-home')
      const physicalLegacy = join(physicalClaude, 'channels/slack')
      mkdirSync(symlinkHome, { recursive: true })
      mkdirSync(physicalLegacy, { recursive: true })
      symlinkSync(physicalClaude, join(symlinkHome, '.claude'))
      for (const configured of [join(symlinkHome, '.claude/channels/slack'), physicalLegacy]) {
        expect(resolveZeroStateDir({ ZEROKUN_STATE_DIR: configured }, symlinkHome))
          .toBe(join(symlinkHome, '.codex/zerokun'))
        const shell = Bun.spawnSync([
          '/bin/bash', '-c', '. "$1"; zerokun_resolve_state_dir', '_',
          join(import.meta.dir, 'state-dir.sh'),
        ], {
          env: {
            ...process.env,
            HOME: symlinkHome,
            ZEROKUN_STATE_DIR: configured,
            ZEROKUN_LEGACY_CUTOVER: '0',
          },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(shell.exitCode, shell.stderr.toString()).toBe(0)
        expect(shell.stdout.toString().trim()).toBe(join(symlinkHome, '.codex/zerokun'))

        const bootstrap = Bun.spawnSync([
          '/bin/bash', '-c',
          'bootstrap_path="$1"; set --; . "$bootstrap_path"; printf "%s\\n" "$STATE_DIR"', '_',
          join(import.meta.dir, 'bootstrap-macos.sh'),
        ], {
          env: {
            ...process.env,
            HOME: symlinkHome,
            ZEROKUN_STATE_DIR: configured,
            ZEROKUN_LEGACY_CUTOVER: '0',
          },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(bootstrap.exitCode, bootstrap.stderr.toString()).toBe(0)
        expect(bootstrap.stdout.toString().trim()).toBe(join(symlinkHome, '.codex/zerokun'))
      }
      writeFileSync(
        join(physicalLegacy, '.codex-legacy-cutover'),
        `zerokun-codex-legacy-cutover-v1\n${realpathSync(physicalLegacy)}\n`,
        { mode: 0o600 },
      )
      rmSync(join(symlinkHome, '.claude'))
      expect(resolveZeroStateDir({
        ZEROKUN_STATE_DIR: physicalLegacy,
        ZEROKUN_LEGACY_CUTOVER: '0',
      }, symlinkHome)).toBe(join(symlinkHome, '.codex/zerokun'))
      const establishedShell = Bun.spawnSync([
        '/bin/bash', '-c', '. "$1"; zerokun_resolve_state_dir', '_',
        join(import.meta.dir, 'state-dir.sh'),
      ], {
        env: {
          ...process.env,
          HOME: symlinkHome,
          ZEROKUN_STATE_DIR: physicalLegacy,
          ZEROKUN_LEGACY_CUTOVER: '0',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(establishedShell.exitCode, establishedShell.stderr.toString()).toBe(0)
      expect(establishedShell.stdout.toString().trim()).toBe(join(symlinkHome, '.codex/zerokun'))
      const establishedBootstrap = Bun.spawnSync([
        '/bin/bash', '-c',
        'bootstrap_path="$1"; set --; . "$bootstrap_path"; printf "%s\\n" "$STATE_DIR"', '_',
        join(import.meta.dir, 'bootstrap-macos.sh'),
      ], {
        env: {
          ...process.env,
          HOME: symlinkHome,
          ZEROKUN_STATE_DIR: physicalLegacy,
          ZEROKUN_LEGACY_CUTOVER: '0',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(establishedBootstrap.exitCode, establishedBootstrap.stderr.toString()).toBe(0)
      expect(establishedBootstrap.stdout.toString().trim()).toBe(join(symlinkHome, '.codex/zerokun'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('cutover入口は存在しないlegacy stateを作らず、DB overrideもstate内へ閉じる', () => {
    const home = mkdtempSync(join(tmpdir(), 'zerokun-cutover-entrypoints-'))
    const legacy = join(home, '.claude/channels/slack')
    const state = join(home, '.codex/zerokun')
    const outsideDb = join(legacy, 'jobs.sqlite3')
    try {
      const environment = {
        ...process.env,
        HOME: home,
        ZEROKUN_STATE_DIR: legacy,
        ZEROKUN_LEGACY_CUTOVER: '1',
      }
      for (const command of [
        ['/bin/bash', join(import.meta.dir, 'bootstrap-macos.sh'), '--slack-only'],
        ['/bin/bash', join(import.meta.dir, '..', 'codex-channel.sh')],
        [process.execPath, join(import.meta.dir, 'update.ts'), '--recover-only'],
      ]) {
        const result = Bun.spawnSync(command, {
          env: environment,
          stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        })
        expect(result.exitCode).not.toBe(0)
        expect(existsSync(legacy)).toBe(false)
      }
      mkdirSync(state, { recursive: true })
      expect(() => resolveZeroJobDatabasePath(state, { ZEROKUN_JOB_DB: outsideDb }))
        .toThrow("must be the selected state's jobs.sqlite3")
      expect(existsSync(legacy)).toBe(false)
      expect(() => resolveZeroJobDatabasePath(state, {
        ZEROKUN_JOB_DB: join(state, 'custom', 'jobs.sqlite3'),
      })).toThrow("must be the selected state's jobs.sqlite3")
      expect(resolveZeroJobDatabasePath(state, {}))
        .toBe(join(realpathSync(state), 'jobs.sqlite3'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('Slack HTTPはretryを外側の永続queueへ委ね、deadlineを持つ', async () => {
    expect(slackHttpTimeoutMs('invalid')).toBe(DEFAULT_SLACK_HTTP_TIMEOUT_MS)
    expect(slackHttpTimeoutMs('250')).toBe(250)
    expect(slackWebClientOptions(500)).toEqual({ timeout: 500, retryConfig: { retries: 0 } })
    await expect(withSlackDeadline(
      () => new Promise<void>(() => {}),
      20,
      'test Slack request',
    )).rejects.toThrow('test Slack request timed out after 20ms')

    const parent = new AbortController()
    const startedAt = Date.now()
    const interrupted = withSlackDeadline(
      signal => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('operation aborted')), { once: true })
      }),
      5_000,
      'preemptible attachment',
      parent.signal,
    )
    parent.abort()
    await expect(interrupted).rejects.toThrow(/aborted/)
    expect(Date.now() - startedAt).toBeLessThan(1_000)

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    let deadlineInvocations = 0
    await expect(withSlackDeadline(async () => {
      deadlineInvocations += 1
    }, 5_000, 'pre-aborted request', alreadyAborted.signal)).rejects.toThrow(
      'pre-aborted request aborted',
    )
    expect(deadlineInvocations).toBe(0)

    const sideEffectAbort = new AbortController()
    let releaseSideEffect!: () => void
    const sideEffectFinished = new Promise<void>(resolve => { releaseSideEffect = resolve })
    let sideEffectInvocations = 0
    const nonCooperative = completeSlackSideEffect(async () => {
      sideEffectInvocations += 1
      await sideEffectFinished
      return 'uploaded'
    }, 'non-cooperative upload', sideEffectAbort.signal)
    sideEffectAbort.abort()
    let settled = false
    void nonCooperative.finally(() => { settled = true })
    await Bun.sleep(10)
    expect(settled).toBe(false)
    releaseSideEffect()
    await expect(nonCooperative).resolves.toBe('uploaded')
    expect(sideEffectInvocations).toBe(1)

    let preAbortedSideEffectInvocations = 0
    await expect(completeSlackSideEffect(async () => {
      preAbortedSideEffectInvocations += 1
    }, 'pre-aborted upload', alreadyAborted.signal)).rejects.toThrow(
      'pre-aborted upload aborted before start',
    )
    expect(preAbortedSideEffectInvocations).toBe(0)
  })

  test('Slack tokenは起動時に継承可能な環境から取り除きchildへ渡さない', () => {
    const environment: Record<string, string | undefined> = {
      PATH: '/usr/bin:/bin',
      SAFE_SENTINEL: 'visible',
      SLACK_BOT_TOKEN: 'xoxb-child-probe-secret',
      SLACK_APP_TOKEN: 'xapp-child-probe-secret',
    }
    expect(takeSlackTokensFromEnvironment(environment)).toEqual({
      SLACK_BOT_TOKEN: 'xoxb-child-probe-secret',
      SLACK_APP_TOKEN: 'xapp-child-probe-secret',
    })
    const childEnvironment = Object.fromEntries(
      Object.entries(environment).filter((entry): entry is [string, string] => (
        entry[1] !== undefined
      )),
    )
    const child = Bun.spawnSync(['/usr/bin/env'], {
      env: childEnvironment,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    const output = child.stdout.toString()
    expect(output).toContain('SAFE_SENTINEL=visible')
    expect(output).not.toContain('SLACK_BOT_TOKEN')
    expect(output).not.toContain('SLACK_APP_TOKEN')
    expect(output).not.toContain('child-probe-secret')
  })

  test('Slack bearer通信はproxy非使用のdirect HTTPSだけを許可する', async () => {
    await expect(openDirectSlackDownload(
      'https://example.com/not-slack',
      'xoxb-not-a-real-token',
    )).rejects.toThrow('refusing non-Slack attachment URL')
    await expect(postDirectSlackApi(
      '../invalid',
      'xoxb-not-a-real-token',
      {},
    )).rejects.toThrow('invalid Slack API method')
    const server = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    expect(server).toContain('openDirectSlackDownload(file.url_private_download')
    expect(server).not.toContain('fetch(file.url_private_download')
    expect(runner).toContain("postDirectSlackApi('chat.postMessage'")
    expect(runner).not.toContain("fetch(\n        'https://slack.com/api/chat.postMessage'")
  })

  test('gateway readinessは接続releaseとPIDをatomic markerに記録する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-readiness-'))
    const path = join(dir, 'gateway-ready.json')
    try {
      writeGatewayReadiness(path, 'abc123', 4321)
      expect(readGatewayReadiness(path)).toMatchObject({
        runtime: 'codex',
        pid: 4321,
        release: 'abc123',
      })
      expect(JSON.parse(readFileSync(path, 'utf8')).connectedAt).toBeGreaterThan(0)
      clearGatewayReadiness(path, 9999)
      expect(existsSync(path)).toBe(true)
      clearGatewayReadiness(path, 4321)
      expect(existsSync(path)).toBe(false)
      mkdirSync(join(dir, 'nested'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
