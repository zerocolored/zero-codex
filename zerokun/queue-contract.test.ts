import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const root = join(import.meta.dir, '..')

describe('Zero-kun Codex wiring', () => {
  test('standalone gateway persists authorized Slack events directly to SQLite', () => {
    const server = readFileSync(join(root, 'server.ts'), 'utf8')
    expect(server).toContain('JobStore,')
    expect(server).toContain('updateIsRunning,')
    expect(server).toContain('updateTransactionPending,')
    expect(server).toContain("} from './zerokun/job-runner.ts'")
    expect(server).toContain('jobStore.enqueue({')
    expect(server.indexOf('jobStore.enqueue({')).toBeLessThan(
      server.indexOf(
        'jobStore.completeInboundDelivery(inbound.idempotencyKey)',
        server.indexOf('jobStore.enqueue({'),
      ),
    )
    expect(server).toContain('rememberDelivered(key)')
    expect(server.indexOf('jobStore.enqueue({')).toBeLessThan(
      server.indexOf('rememberDelivered(key)', server.indexOf('jobStore.enqueue({')),
    )
    expect(server).not.toContain("method: 'notifications/claude/channel',\n    params: { content")
  })

  test('gateway downloads attachments before enqueue and records thread ownership in DB', () => {
    const server = readFileSync(join(root, 'server.ts'), 'utf8')
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    expect(server).toContain('await downloadInboundFiles')
    expect(server.indexOf('await downloadInboundFiles')).toBeLessThan(server.indexOf('jobStore.enqueue({'))
    expect(runner).toContain('CREATE TABLE IF NOT EXISTS slack_threads')
    expect(runner).toContain('INSERT INTO slack_threads')
    expect(server).toContain("process.env.ZEROKUN_LEGACY_CUTOVER !== '1'")
  })

  test('worker runtime is ordered Codex App Server with live steer/interrupt', () => {
    const server = readFileSync(join(root, 'server.ts'), 'utf8')
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    const executor = readFileSync(join(import.meta.dir, 'codex-executor.ts'), 'utf8')
    expect(server).toContain('? jobStore.interruptControlTarget(inbound.chatId, inbound.threadTs)')
    expect(server).toContain(': jobStore.liveControlTarget(inbound.chatId, inbound.threadTs)')
    expect(runner).toMatch(/executeCodexJob\((?:job|\{\s*\.\.\.job)/u)
    expect(runner).toContain('verifySlackAppTokenPair')
    expect(runner).toContain('liveControls: {')
    expect(executor).toContain('production Codex jobs require the App Server live-control transport')
    expect(executor).toContain("'app-server', '--stdio'")
    expect(executor).toContain('const session = new CodexAppServerSession')
    expect(executor).toContain('session.startThread(')
    expect(executor).toContain('session.resumeThread(')
    expect(executor).toContain('session.startTurn(')
    expect(executor).toContain('session.steer(')
    expect(executor).toContain('session.interrupt(')
    expect(executor).toContain('session.loadFullTurn(')
  })

  test('jobごとのHerdr monitorは安全な進捗を表示し失敗時だけ確認用に残す', () => {
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    const monitor = readFileSync(join(import.meta.dir, 'herdr-job-monitor.ts'), 'utf8')
    const viewer = readFileSync(join(import.meta.dir, 'herdr-job-monitor-view.ts'), 'utf8')
    expect(runner).toContain('openHerdrJobMonitor({')
    expect(runner).toContain('onMonitorMessage: message => mirrorMonitorMessage(message)')
    expect(runner).not.toContain('onStdoutChunk: value => mirrorChunk(')
    expect(runner).not.toContain('onStderrChunk: value => mirrorChunk(')
    expect(runner).toContain('closeHerdrJobMonitor({')
    expect(runner).toContain('retainFailedHerdrJobMonitor({')
    expect(runner).toContain('watchHerdrJobMonitor({')
    expect(runner).toContain('for (const jobId of startupRetainedMonitorJobIds) ensureMonitorGuard(jobId)')
    expect(runner).toContain('assertJobMonitorHealthy:')
    expect(runner).toContain('controller.abort()')
    expect(runner).toContain('failAfterMonitorLoss(')
    expect(runner.match(/recoverMissingBindingAfterExecutorsStopped:/g)).toHaveLength(4)
    const recoveryCommand = runner.slice(
      runner.indexOf("if (command === 'recover-interrupted')"),
      runner.indexOf("if (command !== 'daemon'"),
    )
    expect(recoveryCommand.indexOf('await terminateTrackedExecutors(')).toBeLessThan(
      recoveryCommand.indexOf('const recoverMissingMonitor ='),
    )
    const daemonStartup = runner.slice(runner.indexOf('if (!updateTransactionPending(updateJournal))'))
    expect(daemonStartup.indexOf('await terminateTrackedExecutors(')).toBeLessThan(
      daemonStartup.indexOf('const recoverMissingMonitor ='),
    )
    expect(monitor).toContain("'tab', 'create'")
    expect(monitor).toContain("'--no-focus'")
    expect(monitor).toContain("'tab', 'close'")
    expect(monitor).toContain("phase: 'retained-failure'")
    expect(monitor).toContain('exec /usr/bin/env -i PATH=/usr/bin:/bin TERM=dumb')
    expect(monitor).not.toContain("'codex', 'exec'")
    expect(monitor).toContain('monitor loss recovery did not terminalize non-terminal job')
    expect(viewer).toContain('HERDR_MONITOR_READY_TEXT')
    expect(viewer).not.toContain('ZEROCHAN_MONITOR_READY:')
    expect(viewer).toContain("'progress.json'")
    expect(viewer).toContain('while (true) await Bun.sleep(60_000)')
    expect(viewer).not.toContain('Bun.spawn(')
  })

  test('read and write authorization map to separate Codex sandboxes', () => {
    const server = readFileSync(join(root, 'server.ts'), 'utf8')
    const executor = readFileSync(join(import.meta.dir, 'codex-executor.ts'), 'utf8')
    const browserBroker = readFileSync(
      join(import.meta.dir, 'browser-verification-broker.ts'), 'utf8',
    )
    expect(server).toContain('writeAllowFrom')
    expect(server).toContain('writeEnabled')
    expect(executor).toContain("[':minimal', 'read']")
    expect(executor).not.toContain("extends=${tomlString(job.writeEnabled")
    expect(executor).toContain('permissions.${profile}.network.enabled=')
    expect(executor).toContain('permissions.${profile}.network.allow_local_binding=')
    expect(executor).toContain('localVerificationEnabled')
    expect(executor).toContain('zerokun_browser=')
    expect(executor).toContain('enabled_tools=["verify_local_page"]')
    expect(browserBroker).toContain("server.registerTool('verify_local_page'")
    expect(browserBroker).toContain("['127.0.0.1', 'localhost']")
    expect(browserBroker).toContain(
      '`--proxy-bypass-list=<-loopback>;${input.address.url.hostname}:${input.address.port}`',
    )
    expect(browserBroker).toContain('blockedCrossOriginRequestCount')
    expect(executor).toContain('default_permissions=')
    expect(executor).not.toContain("'-s'")
    expect(executor).toContain('Never post to Slack yourself')
    expect(executor).toContain('for (const writeEnabled of [false, true])')
  })

  test('launcher starts runner then standalone gateway, without Claude development channels', () => {
    const launcher = readFileSync(join(root, 'codex-channel.sh'), 'utf8')
    expect(launcher).toContain('start_job_runner')
    expect(launcher).toContain('bun --config=/dev/null --no-env-file "$REPO_DIR/server.ts"')
    expect(launcher).toContain('"$RUNNER_LAUNCHER" "$JOB_RUNNER" "$STATE_DIR" "$JOB_RUNNER_LOG"')
    expect(launcher).toContain('"$JOB_RUNNER_STARTER_LOCK"')
    const runnerLauncher = readFileSync(join(import.meta.dir, 'runner-launcher.ts'), 'utf8')
    expect(runnerLauncher).toContain("detached: process.platform !== 'win32'")
    expect(runnerLauncher).toContain('tryAcquireProcessLock(canonicalStarterLock, process.pid)')
    expect(runnerLauncher).not.toContain('daemon.unref()')
    expect(launcher).toContain('starter_pid=$!')
    expect(readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8'))
      .toContain("if (command === 'daemon') process.on('SIGINT', ignoreInterrupt)")
    expect(launcher.indexOf('start_job_runner')).toBeLessThan(
      launcher.lastIndexOf('exec caffeinate -dimsu'),
    )
    expect(launcher).not.toContain('dangerously-load-development-channels')
    expect(launcher).not.toContain('command -v claude')
    expect(launcher).toContain('zerokun/herdr-runtime.ts')
    expect(launcher.indexOf('zerokun/herdr-runtime.ts')).toBeLessThan(
      launcher.indexOf('existing_bridge_pid='),
    )
    expect(readFileSync(join(import.meta.dir, 'runner-launcher.ts'), 'utf8'))
      .toContain('requireHerdrRuntime()')
  })

  test('Herdr runtime pinはdaemon lock勝者だけがshared stateへ公開する', () => {
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    const launcher = readFileSync(join(import.meta.dir, 'runner-launcher.ts'), 'utf8')
    expect(launcher).toContain('ZEROKUN_LAUNCH_HERDR_RUNTIME: encodeHerdrRuntimeIdentity(herdrRuntime)')
    expect(launcher).not.toContain('writePinnedHerdrRuntime')
    const decode = runner.indexOf('decodeHerdrRuntimeIdentity(process.env.ZEROKUN_LAUNCH_HERDR_RUNTIME)')
    const acquire = runner.indexOf('const daemonLease = acquireDaemonLock(')
    const publish = runner.indexOf('writePinnedHerdrRuntime(dir, launchHerdrRuntime)')
    expect(decode).toBeGreaterThan(-1)
    expect(acquire).toBeGreaterThan(decode)
    expect(publish).toBeGreaterThan(acquire)
  })

  test('setup requires Codex and installs every runtime companion', () => {
    const setup = readFileSync(join(import.meta.dir, 'setup.sh'), 'utf8')
    const runtime = readFileSync(join(import.meta.dir, 'update-runtime.ts'), 'utf8')
    for (const expected of [
      'zerokun_require_codex_version',
      'codex-version.sh',
      'job-runner.ts',
      'codex-executor.ts',
      'update-runtime.ts',
      'zerochan-access',
      'codex-channel',
      'zerochan update',
      'watchdog.sh',
      'zerokun_require_herdr_version',
    ]) expect(setup).toContain(expected)
    for (const companion of [
      'update-request.ts',
      'process-generation.ts',
      'child-environment.ts',
      'safe-file.ts',
      'managed-path.ts',
      'state-dir.ts',
      'slack-http.ts',
      'slack-app-identity.ts',
    ]) expect(runtime).toContain(`'${companion}'`)
    expect(setup).toContain('ln -sfn "$REPO_DIR/zerokun/access.ts" "$HOME/.local/bin/zerochan-access"')
    expect(setup).not.toContain('ln -sfn "$REPO_DIR/zerokun/access.ts" "$HOME/.local/bin/zerokun-access"')
    expect(setup).toContain(
      '"$HOME/.local/bin/zerokun-access" "$REPO_DIR/zerokun/access.ts"',
    )
    expect(setup).not.toContain('command -v claude')
    expect(setup).not.toContain('claude-config')
    expect(setup).not.toContain('claude-skills')
  })

  test('jobごとにAGENTS上限とHerdr Five-Advisor文脈を固定する', () => {
    const executor = readFileSync(join(import.meta.dir, 'codex-executor.ts'), 'utf8')
    expect(executor).toContain('project_doc_max_bytes=262144')
    expect(executor).toContain("features.multi_agent=${multiAgentEnabled ? 'true' : 'false'}")
    expect(executor).toContain('multiAgentEnabled: !continuationDecision')
    expect(executor).toContain("&& stage !== 'implementation' && stage !== 'interjection'")
    expect(executor).toContain('features.goals=false')
    expect(executor).toContain('features.browser_use=false')
    expect(executor).toContain('features.browser_use_external=false')
    expect(executor).toContain('features.browser_use_full_cdp_access=false')
    expect(executor).toContain('features.computer_use=false')
    expect(executor).toContain('features.in_app_browser=false')
    expect(executor).toContain('readPinnedHerdrRuntime(stateDir)')
    expect(executor).toContain('await verifyHerdrRuntimeIdentityAsync(herdrRuntime)')
    expect(executor).toContain('both native advisors')
    expect(executor).toContain('call advisor_round')
    expect(executor).toContain('Poll advisor_round_poll')
    expect(executor).toContain('round-owned fresh ephemeral Claude Code workspace')
    expect(executor).toContain('assertRequiredAdvisorRounds(')
    expect(executor).toContain('await assertNativeAdvisorHistory({')
    expect(executor).toContain("{ phase: 'design', round: 1 }")
    expect(executor).toContain("{ phase: 'review', round: 1 }")
    const broker = readFileSync(join(import.meta.dir, 'advisor-broker.ts'), 'utf8')
    expect(broker.match(/server\.registerTool\(/g)).toHaveLength(2)
    expect(broker).toContain("server.registerTool('advisor_round'")
    expect(broker).toContain("server.registerTool('advisor_round_poll'")
    expect(broker).toContain('version: 4')
    expect(broker).toContain('nativeAdvisors')
    expect(broker).toContain('response: z.string().min(1).max(MAX_INPUT_CHARS)')
    expect(broker).toContain('nativeAdvisorResponseDigest(response)')
    expect(broker).toContain('attemptNonce')
    expect(broker).toContain('contextDigest')
    expect(broker).toContain("runBounded([launcher, '-p']")
    expect(broker).toContain('stdin: prompt')
    expect(broker).not.toContain('@ZEROKUN_GROK_PROMPT_FILE')
    const fifthHelper = readFileSync(join(import.meta.dir, 'fifth-advisor.py'), 'utf8')
    expect(fifthHelper).toMatch(/"workspace",\s+"create",\s+"--cwd"/)
    expect(fifthHelper).toContain('["workspace", "close", workspace_id]')
    expect(fifthHelper).toContain('"method": "agent.prompt"')
    expect(fifthHelper).toContain('connection.sendall(prepared.request)')
    expect(fifthHelper).not.toContain('prepared.command')
    expect(broker).toContain("'open', ...helperArgs")
    expect(broker).toContain("'send', ...helperArgs, '--owned'")
    expect(broker).toContain("'close', ...helperArgs")
    expect(broker).not.toContain('prepareClaudeAdvisorTarget')
    const authCheck = broker.indexOf('await assertClaudeSubscriptionLogin(helperEnvironment)')
    const requestCreate = broker.indexOf('requestDir = createEphemeralClaudeRequestDirectory({')
    const helperOpen = broker.indexOf("[python, helper, 'open', ...helperArgs]")
    expect(authCheck).toBeGreaterThan(0)
    expect(requestCreate).toBeGreaterThan(authCheck)
    expect(helperOpen).toBeGreaterThan(requestCreate)
  })

  test('Slack上のsystem文面は表示名を固定せず実装名も露出しない', () => {
    const server = readFileSync(join(root, 'server.ts'), 'utf8')
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    const executor = readFileSync(join(import.meta.dir, 'codex-executor.ts'), 'utf8')
    expect(server).toContain('ペアリングが完了しました。私に話しかけてください。')
    expect(server).toContain('🔄 更新依頼を受け付けました。')
    expect(server).not.toContain('Zeroちゃんに話しかけてください')
    expect(server).not.toContain('Zeroちゃんの更新を受け付けました')
    expect(server).not.toContain('Zeroちゃんとのペアリング')
    expect(runner).toContain('🙇 別件の作業中のため、しばらくお待ちください。')
    expect(runner).not.toContain('🙌 受け付けました（待ち順')
    expect(server).not.toContain('Codexで受け付けました')
    expect(server).not.toContain('Say hi to Codex')
    expect(server).not.toContain('request ${request.id.slice')
    expect(server).not.toContain('実行中jobの完了後')
    expect(runner).not.toContain("'確認します 👀'")
    expect(runner).not.toContain('確認を始めますね')
    expect(runner).not.toContain('時間がかかる場合は、途中経過もこのスレッドでお知らせします')
    expect(runner).toContain('できました ✅')
    expect(runner).not.toContain(' worker=${job.workerId}')
    expect(runner).not.toContain('Zeroちゃんの job ${job.id.slice')
    expect(runner).not.toContain('Codexの処理が完了しました。')
    expect(executor).toContain('処理は完了しましたが、返答本文を取得できませんでした。')
    expect(executor).toContain('Do not introduce or repeat a')
    expect(executor).not.toContain('speak warmly and concisely as Zeroちゃん')
    expect(executor).not.toContain('(Codex returned no final text output)')
  })

  test('Claudeはround専用workspaceをfresh起動しexact cleanup後だけ採択する', () => {
    const broker = readFileSync(join(import.meta.dir, 'advisor-broker.ts'), 'utf8')
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    expect(broker).toContain("lifecycle: 'ephemeral-v2'")
    expect(broker).toContain('cleanupVerified = true')
    expect(broker).toContain('removeVerifiedEphemeralClaudeRequestDirectory')
    expect(broker).not.toContain("'/clear'")
    expect(runner).toContain('reconcileEphemeralClaudeSessions')
    expect(runner).not.toContain('claude-queue-boundary')
    expect(existsSync(join(import.meta.dir, 'claude-queue-boundary.ts'))).toBe(false)
    expect(existsSync(join(import.meta.dir, 'claude-queue-boundary.test.ts'))).toBe(false)
  })

  test('self update follows the main branch and restarts gateway without TUI confirmation', () => {
    const updater = readFileSync(join(import.meta.dir, 'update.ts'), 'utf8')
    expect(updater).toContain("ZEROKUN_UPDATE_BRANCH ?? 'main'")
    expect(updater).toContain("join(options.rootRepo, 'codex-channel.sh')")
    expect(updater).toContain("join(stateDir, 'plugin.lock')")
    expect(updater).not.toContain('Enter\\s+to\\s+confirm')
    expect(updater).not.toContain('dangerously-load-development-channels')
  })

  test('explicit update request bypasses the normal FIFO to avoid self-deadlock', () => {
    const server = readFileSync(join(root, 'server.ts'), 'utf8')
    const updateRequest = readFileSync(join(import.meta.dir, 'update-request.ts'), 'utf8')
    expect(server).toContain('isExplicitUpdateRequest(text)')
    expect(server).toContain('await enqueueUpdate(')
    expect(server).toContain("const UPDATE_ENTRYPOINT = join(import.meta.dir, 'zerokun', 'update.ts')")
    expect(server.match(/updaterPath: UPDATE_ENTRYPOINT/g)?.length).toBe(2)
    expect(updateRequest).not.toContain("join(homedir(), '.local', 'bin', 'zerokun-update')")
    const updateBranch = server.indexOf('isExplicitUpdateRequest(text)')
    const normalInboundFifo = server.indexOf('const inbound: InboundDeliveryInput = {', updateBranch)
    expect(updateBranch).toBeGreaterThan(-1)
    expect(updateBranch).toBeLessThan(normalInboundFifo)
  })
})
