import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const LAUNCHER = join(dirname(import.meta.dir), 'codex-channel.sh')
const temporaryDirs: string[] = []
const processes: Bun.Subprocess[] = []

afterEach(() => {
  for (const process of processes.splice(0)) {
    try { process.kill() } catch {}
  }
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): string {
  const base = mkdtempSync(join(tmpdir(), 'zerokun-codex-launcher-'))
  temporaryDirs.push(base)
  const state = join(base, 'state')
  const project = join(base, 'project')
  mkdirSync(state)
  mkdirSync(project)
  const initialized = Bun.spawnSync(['git', 'init', '-q', project], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  expect(initialized.exitCode, initialized.stderr.toString()).toBe(0)
  writeFileSync(join(state, '.env'), [
    'SLACK_BOT_TOKEN=xoxb-launcher-test-token-12345',
    'SLACK_APP_TOKEN=xapp-1-A0123456789-launcher-test-token-12345',
    '',
  ].join('\n'), { mode: 0o600 })
  return state
}

function startGateway(
  state: string,
  options: { ignoreTerm?: boolean } = {},
): Bun.Subprocess {
  const server = join(state, 'server.ts')
  writeFileSync(server, options.ignoreTerm
    ? "#!/bin/bash\ntrap '' TERM\nwhile :; do read -r -t 1 _ || :; done\n"
    : '#!/bin/bash\nsleep 30\n')
  chmodSync(server, 0o700)
  const process = Bun.spawn(['/bin/bash', server], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  })
  processes.push(process)
  writeFileSync(join(state, 'plugin.lock'), `${process.pid}\n`)
  const started = Bun.spawnSync(['/bin/ps', '-o', 'lstart=', '-p', String(process.pid)], {
    stdout: 'pipe',
  }).stdout.toString().trim()
  writeFileSync(join(state, 'plugin.lock.identity'), JSON.stringify({
    pid: process.pid, started, nonce: '12345678-1234-4123-8123-123456789abc',
  }))
  return process
}

function startRunner(state: string): Bun.Subprocess {
  const runner = join(state, 'job-runner.ts')
  writeFileSync(runner, '#!/bin/bash\nsleep 30\n')
  chmodSync(runner, 0o700)
  const process = Bun.spawn(['/bin/bash', runner, 'daemon'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  })
  processes.push(process)
  const lockDir = join(state, 'job-runner.lock')
  mkdirSync(lockDir, { mode: 0o700 })
  const lock = join(lockDir, 'pid')
  writeFileSync(lock, `${process.pid}\n`)
  const started = Bun.spawnSync(['/bin/ps', '-o', 'lstart=', '-p', String(process.pid)], {
    stdout: 'pipe',
  }).stdout.toString().trim()
  writeFileSync(`${lock}.identity`, JSON.stringify({
    pid: process.pid, started, nonce: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
  }))
  writeFileSync(
    join(lockDir, 'runtime'),
    `zerokun-codex-runner-v1:A0123456789:fixture-token-fingerprint:${'0'.repeat(64)}\n`,
  )
  return process
}

async function startOrphanedRunnerLauncher(state: string): Promise<Bun.Subprocess> {
  const script = join(state, 'orphaned-runner-launcher.ts')
  const ready = join(state, 'orphaned-runner-launcher.ready')
  writeFileSync(script, [
    `import { releaseProcessLock, tryAcquireProcessLock } from ${JSON.stringify(join(import.meta.dir, 'process-lock.ts'))}`,
    `const lock = ${JSON.stringify(join(state, 'job-runner-starter.lock'))}`,
    'const acquired = tryAcquireProcessLock(lock, process.pid)',
    "if (!acquired.acquired) throw new Error('fixture starter lock unavailable')",
    `await Bun.write(${JSON.stringify(ready)}, String(process.pid))`,
    'let stopping = false',
    'const stop = () => {',
    '  if (stopping) return',
    '  stopping = true',
    '  releaseProcessLock(lock, acquired.lease)',
    '  process.exit(0)',
    '}',
    "process.on('SIGTERM', stop)",
    "process.on('SIGINT', stop)",
    'await Bun.sleep(30_000)',
    '',
  ].join('\n'), { mode: 0o700 })
  const launcher = Bun.spawn([process.execPath, script], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  })
  processes.push(launcher)
  for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) {
    await Bun.sleep(20)
  }
  expect(existsSync(ready)).toBe(true)
  return launcher
}

async function stopFixturePid(path: string): Promise<void> {
  if (!existsSync(path)) return
  const pid = Number(readFileSync(path, 'utf8').trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  try { process.kill(pid, 'SIGTERM') } catch {}
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); await Bun.sleep(20) } catch { return }
  }
  try { process.kill(pid, 'SIGKILL') } catch {}
}

async function runLauncher(
  state: string,
  env: Record<string, string>,
  beforeConfirm?: () => void | Promise<void>,
  launch: { invokedAs?: 'zerochan' | 'zerokun'; cwd?: string; args?: string[] } = {},
) {
  // The launcher intentionally prepends $HOME/.local/bin before Homebrew.
  // Put the fixture shims there so tests do not depend on whether the host
  // machine already has a real Bun installation.
  const fakeBin = join(state, '.local', 'bin')
  mkdirSync(fakeBin, { recursive: true })
  const fakeRunnerLauncher = join(state, 'runner-launcher.ts')
  writeFileSync(fakeRunnerLauncher, [
    "import { mkdirSync, writeFileSync } from 'fs'",
    "import { join } from 'path'",
    `import { releaseProcessLock, tryAcquireProcessLock } from ${JSON.stringify(join(import.meta.dir, 'process-lock.ts'))}`,
    "const state = process.env.FAKE_RUNNER_STATE!",
    "const starterLock = join(state, 'job-runner-starter.lock')",
    "const starter = tryAcquireProcessLock(starterLock, process.pid)",
    "if (!starter.acquired) process.exit(72)",
    "writeFileSync(join(state, 'fake-starter-pid'), String(process.pid))",
    "let runner: Bun.Subprocess | undefined",
    "let stopping = false",
    "const shutdown = async () => {",
    "  if (stopping || process.env.FAKE_RUNNER_IGNORE_TERM === '1') return",
    "  stopping = true",
    "  if (runner) { try { runner.kill('SIGKILL') } catch {}; await runner.exited }",
    "  releaseProcessLock(starterLock, starter.lease)",
    "  process.exit(143)",
    "}",
    "process.on('SIGTERM', () => { void shutdown() })",
    "process.on('SIGINT', () => { void shutdown() })",
    "await Bun.sleep(Number(process.env.FAKE_RUNNER_DELAY_MS ?? '0'))",
    "if (!stopping) {",
    "  const lockDir = join(state, 'job-runner.lock')",
    "  mkdirSync(lockDir, { mode: 0o700 })",
    "  runner = Bun.spawn(['/bin/bash', '-c', 'trap \\\'\\\' TERM; while :; do /bin/sleep 1; done', 'job-runner.ts', 'daemon'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })",
    "  const runnerLease = tryAcquireProcessLock(join(lockDir, 'pid'), runner.pid)",
    "  if (!runnerLease.acquired) process.exit(73)",
    "  writeFileSync(join(lockDir, 'runtime'), process.env.FAKE_RUNNER_RUNTIME!)",
    "  writeFileSync(join(state, 'fake-runner-pid'), String(runner.pid))",
    "  await runner.exited",
    "}",
    "releaseProcessLock(starterLock, starter.lease)",
    '',
  ].join('\n'), { mode: 0o700 })
  for (const command of ['bun', 'caffeinate']) {
    const path = join(fakeBin, command)
    writeFileSync(path, [
      '#!/bin/bash',
      '[ -z "${FAKE_BUN_LOG:-}" ] || printf "%s\\n" "$*" >> "$FAKE_BUN_LOG"',
      '[ -z "${FAKE_ENV_LOG:-}" ] || /usr/bin/env >> "$FAKE_ENV_LOG"',
      'if [[ "$*" == *slack-app-identity.ts* ]] && [ "${FAKE_IDENTITY_FAIL:-0}" = "1" ]; then',
      '  echo "Slack App token identity verification failed: different Slack Apps" >&2',
      '  exit 1',
      'fi',
      'if [[ "$*" == *slack-app-identity.ts*runtime-id-file* ]]; then',
      '  echo "A0123456789:fixture-token-fingerprint"',
      '  exit 0',
      'fi',
      'if [[ "$*" == *herdr-runtime.ts*runtime-id* ]]; then',
      '  echo "${FAKE_HERDR_RUNTIME_ID:-' + '0'.repeat(64) + '}"',
      '  exit 0',
      'fi',
      'if [[ "$*" == *process-identity-check.ts* ]]; then',
      '  if [ -n "${FAKE_IDENTITY_COUNTER:-}" ]; then',
      '    count=0',
      '    [ ! -f "$FAKE_IDENTITY_COUNTER" ] || count="$(/bin/cat "$FAKE_IDENTITY_COUNTER")"',
      '    count=$((count + 1))',
      '    printf "%s\\n" "$count" > "$FAKE_IDENTITY_COUNTER"',
      '    [ "${FAKE_DELAY_SECOND_IDENTITY:-0}" != "1" ] || [ "$count" != "2" ] || sleep 1',
      '  fi',
      `  exec ${JSON.stringify(process.execPath)} "$@"`,
      'fi',
      'if [[ "$*" == *process-lock.ts*stop-owner* ]] && [ "${FAKE_PROCESS_LOCK_STOP_FAIL:-0}" = "1" ]; then',
      '  exit 3',
      'fi',
      'if [[ "$*" == *project-selection.ts* ]]; then',
      `  exec ${JSON.stringify(process.execPath)} "$@"`,
      'fi',
      'if [[ "$*" == *project-channel-config.ts* ]]; then',
      `  exec ${JSON.stringify(process.execPath)} "$@"`,
      'fi',
      'if [[ "$*" == *readiness.ts* ]]; then',
      `  exec ${JSON.stringify(process.execPath)} "$@"`,
      'fi',
      'if [[ "$*" == *runner-launcher.ts* ]]; then',
      `  exec ${JSON.stringify(process.execPath)} --config=/dev/null --no-env-file ${JSON.stringify(fakeRunnerLauncher)} 2>/dev/null`,
      'fi',
      'if [[ "$*" == *process-lock.ts* ]]; then',
      `  exec ${JSON.stringify(process.execPath)} "$@"`,
      'fi',
      'if [[ "$*" == *"standalone-codex.ts version"* ]]; then',
      '  echo "${FAKE_CODEX_VERSION:-0.149.0}"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(path, 0o700)
  }
  const claude = join(fakeBin, 'claude')
  writeFileSync(claude, [
    '#!/bin/bash',
    'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ] && [ "${3:-}" = "--json" ]; then',
    '  if [ -f "$HOME/fake-claude-auth-fail" ]; then',
    '    echo \'{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","subscriptionType":""}\'',
    '  else',
    '    echo \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\'',
    '  fi',
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o700 })
  const herdr = join(fakeBin, 'herdr')
  writeFileSync(herdr, [
    '#!/bin/bash',
    '[ "${FAKE_HERDR_HANG:-0}" != "1" ] || exec /bin/sleep 30',
    'if [ "${1:-}" = "--version" ]; then',
    '  echo "herdr ${FAKE_HERDR_VERSION:-0.8.2}"',
    '  exit 0',
    'fi',
    '[ "${FAKE_HERDR_CAPS:-1}" = "1" ] || { echo "unsupported"; exit 0; }',
    "echo 'Usage: herdr workspace list'",
    "echo 'Usage: herdr workspace get'",
    "echo 'Usage: herdr workspace close'",
    "echo 'Usage: herdr pane run'",
    "echo 'Usage: herdr pane get'",
    "echo 'Usage: herdr tab get Usage: herdr tab close'",
    'if [ "${FAKE_HERDR_MISSING_UNTIL:-0}" = "1" ]; then',
    "  echo '--current --workspace --cwd --label --no-focus --match --source --lines --kind --pane --wait --timeout'",
    'else',
    "  echo '--current --workspace --cwd --label --no-focus --match --source --lines --kind --pane --wait --until --timeout'",
    'fi',
    "echo 'Usage: herdr agent list Usage: herdr agent get Usage: herdr agent send-keys'",
    '',
  ].join('\n'), { mode: 0o700 })
  let launcherPath = LAUNCHER
  if (launch.invokedAs) {
    launcherPath = join(state, launch.invokedAs)
    if (!existsSync(launcherPath)) symlinkSync(LAUNCHER, launcherPath)
  }
  const child = Bun.spawn([
    '/bin/bash', launcherPath,
    ...(launch.args ?? (launch.invokedAs ? [] : [join(dirname(state), 'project')])),
  ], {
    env: {
      HOME: state,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      HERDR_BIN_PATH: herdr,
      ZEROKUN_STATE_DIR: state,
      FAKE_RUNNER_STATE: state,
      FAKE_RUNNER_RUNTIME: `zerokun-codex-runner-v1:A0123456789:fixture-token-fingerprint:${'0'.repeat(64)}`,
      ...env,
    },
    cwd: launch.cwd,
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  if (beforeConfirm) {
    await Bun.sleep(300)
    await beforeConfirm()
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, output: `${stdout}\n${stderr}` }
}

describe('codex-channel.sh replacement guard', () => {
  test('zerochan updateは通常起動検査より前にrepository updaterへ直接委譲する', async () => {
    const state = fixture()
    const project = join(dirname(state), 'project')
    rmSync(join(state, '.env'))

    const updateLog = join(state, 'update-bun.log')
    const update = await runLauncher(state, { FAKE_BUN_LOG: updateLog }, undefined, {
      invokedAs: 'zerochan', cwd: dirname(state), args: ['update'],
    })
    expect(update.exitCode, update.output).toBe(0)
    const updateCalls = readFileSync(updateLog, 'utf8')
    expect(updateCalls).toContain(`${join(dirname(import.meta.dir), 'zerokun/update.ts')}`)
    expect(updateCalls).not.toContain('project-selection.ts')
    expect(updateCalls).not.toContain('slack-app-identity.ts')
    expect(updateCalls).not.toContain('herdr-runtime.ts')

    const recoveryLog = join(state, 'recovery-bun.log')
    const recovery = await runLauncher(state, { FAKE_BUN_LOG: recoveryLog }, undefined, {
      invokedAs: 'zerochan', cwd: project, args: ['update', '--recover-only'],
    })
    expect(recovery.exitCode, recovery.output).toBe(0)
    expect(readFileSync(recoveryLog, 'utf8')).toContain('zerokun/update.ts --recover-only')

    const invalidLog = join(state, 'invalid-update-bun.log')
    const invalid = await runLauncher(state, { FAKE_BUN_LOG: invalidLog }, undefined, {
      invokedAs: 'zerochan', cwd: project, args: ['update', '--skip-tests'],
    })
    expect(invalid.exitCode).toBe(2)
    expect(invalid.output).toContain('zerochan update [--recover-only]')
    expect(existsSync(invalidLog)).toBe(false)
  })

  test('zerochan start/stopは専用service controllerへ正しいscopeで委譲する', async () => {
    const state = fixture()
    const project = join(dirname(state), 'project')
    const startLog = join(state, 'start-bun.log')
    const start = await runLauncher(state, { FAKE_BUN_LOG: startLog, HERDR_ENV: '1' }, undefined, {
      invokedAs: 'zerochan', cwd: project, args: ['start'],
    })
    expect(start.exitCode, start.output).toBe(0)
    const startCalls = readFileSync(startLog, 'utf8')
    expect(startCalls).toContain(
      `service-control.ts start ${dirname(import.meta.dir)} ${state} ${realpathSync(project)} A0123456789`,
    )

    const stopLog = join(state, 'stop-bun.log')
    const stop = await runLauncher(state, { FAKE_BUN_LOG: stopLog }, undefined, {
      invokedAs: 'zerochan', cwd: project, args: ['stop'],
    })
    expect(stop.exitCode, stop.output).toBe(0)
    const stopCalls = readFileSync(stopLog, 'utf8')
    expect(stopCalls).toContain(`service-control.ts stop ${dirname(import.meta.dir)} ${state}`)
    expect(stopCalls).not.toContain('slack-app-identity.ts')
    expect(stopCalls).not.toContain('project-selection.ts')

    const forceStopLog = join(state, 'force-stop-bun.log')
    const forceStop = await runLauncher(state, { FAKE_BUN_LOG: forceStopLog }, undefined, {
      invokedAs: 'zerochan', cwd: project, args: ['stop', '--force'],
    })
    expect(forceStop.exitCode, forceStop.output).toBe(0)
    const forceStopCalls = readFileSync(forceStopLog, 'utf8')
    expect(forceStopCalls).toContain(
      `service-control.ts stop ${dirname(import.meta.dir)} ${state} --force`,
    )
    expect(forceStopCalls).not.toContain('slack-app-identity.ts')
    expect(forceStopCalls).not.toContain('project-selection.ts')

    const invalidStop = await runLauncher(state, {}, undefined, {
      invokedAs: 'zerochan', cwd: project, args: ['stop', '--unsafe'],
    })
    expect(invalidStop.exitCode).toBe(2)
    expect(invalidStop.output).toContain('zerochan stop [--force]')
  })

  test('Herdr外のzerochan startは可視workspace作成helperへ委譲する', async () => {
    const state = fixture()
    const project = join(dirname(state), 'project')
    const startLog = join(state, 'outside-herdr-start-bun.log')
    const start = await runLauncher(state, { FAKE_BUN_LOG: startLog }, undefined, {
      invokedAs: 'zerochan', cwd: project, args: ['start'],
    })
    expect(start.exitCode, start.output).toBe(0)
    const startCalls = readFileSync(startLog, 'utf8')
    expect(startCalls).toContain(
      `herdr-start.ts ${dirname(import.meta.dir)} ${state} ${realpathSync(project)}`,
    )
    expect(startCalls).not.toContain('service-control.ts start')
  })

  test('legacy startはmanaged service/update lockとの競合検査を先に通す', async () => {
    const state = fixture()
    const project = join(dirname(state), 'project')
    const log = join(state, 'legacy-start-bun.log')
    const result = await runLauncher(state, { FAKE_BUN_LOG: log }, undefined, {
      invokedAs: 'zerochan', cwd: project,
    })
    expect(result.exitCode, result.output).toBe(0)
    const calls = readFileSync(log, 'utf8')
    const assertion = calls.indexOf(`service-control.ts assert-idle ${state}`)
    const runtimeProbe = calls.indexOf('herdr-runtime.ts runtime-id')
    expect(assertion).toBeGreaterThan(-1)
    expect(runtimeProbe).toBeGreaterThan(assertion)
  })

  test('zerochan set/unset/statusはcurrent projectのlocal channel設定を操作する', async () => {
    const state = fixture()
    const project = realpathSync(join(dirname(state), 'project'))
    const bunLog = join(state, 'management-bun.log')
    const set = await runLauncher(state, { FAKE_BUN_LOG: bunLog }, undefined, {
      invokedAs: 'zerochan', cwd: project,
      args: ['set', 'slack-channel', 'c0123456789'],
    })
    expect(set.exitCode, set.output).toBe(0)
    expect(set.output).toContain('設定しました: C0123456789')
    expect(JSON.parse(readFileSync(join(project, '.zerochan', 'config.json'), 'utf8')))
      .toEqual({ version: 1, slackChannels: ['C0123456789'] })
    const managementCalls = readFileSync(bunLog, 'utf8')
    expect(managementCalls).not.toContain('verify-file')
    expect(managementCalls).not.toContain('codex-executor.ts verify-system-config')
    expect(managementCalls).not.toContain('herdr-runtime.ts runtime-id')

    const status = await runLauncher(state, {}, undefined, {
      invokedAs: 'zerochan', cwd: project, args: ['status'],
    })
    expect(status.exitCode, status.output).toBe(0)
    expect(status.output).toContain('Slackチャンネル: C0123456789')

    const unset = await runLauncher(state, {}, undefined, {
      invokedAs: 'zerochan', cwd: project,
      args: ['unset', 'slack-channel'],
    })
    expect(unset.exitCode, unset.output).toBe(0)
    expect(unset.output).toContain('Slackチャンネルの紐付けをすべて解除しました')
    expect(JSON.parse(readFileSync(join(project, '.zerochan', 'config.json'), 'utf8')))
      .toEqual({ version: 1, slackChannels: [] })
  })

  test('旧gateway稼働中はchannel設定を変更せずrestartを案内する', async () => {
    const state = fixture()
    const project = realpathSync(join(dirname(state), 'project'))
    const gateway = startGateway(state)
    const bunLog = join(state, 'management-old-gateway.log')
    await Bun.sleep(100)

    const result = await runLauncher(state, { FAKE_BUN_LOG: bunLog }, undefined, {
      invokedAs: 'zerochan', cwd: project,
      args: ['set', 'slack-channel', 'C0123456789'],
    })

    expect(result.exitCode, result.output).toBe(1)
    expect(result.output).toContain('Slackチャンネル紐付けに未対応')
    expect(result.output).toContain('zerochan --restart')
    expect(existsSync(join(project, '.zerochan', 'config.json'))).toBe(false)
    expect(readFileSync(bunLog, 'utf8')).not.toContain('project-channel-config.ts set')
    expect(() => process.kill(gateway.pid, 0)).not.toThrow()
  })

  test('2つ目のzerochanは互換gateway/runnerを停止せず共有登録して終了する', async () => {
    const state = fixture()
    const project = realpathSync(join(dirname(state), 'project'))
    const gateway = startGateway(state)
    const runner = startRunner(state)
    writeFileSync(join(state, 'gateway-ready.json'), JSON.stringify({
      runtime: 'codex',
      pid: gateway.pid,
      connectedAt: Date.now(),
      release: 'fixture',
      projectDir: project,
      channelRoutingVersion: 1,
      slackAppId: 'A0123456789',
    }), { mode: 0o600 })
    await Bun.sleep(100)

    const result = await runLauncher(state, {
      FAKE_HERDR_RUNTIME_ID: '1'.repeat(64),
    }, undefined, {
      invokedAs: 'zerochan', cwd: project,
    })
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain('既存のZeroちゃんを共用します')
    expect(result.output).toContain(`gateway: PID ${gateway.pid} / runner: PID ${runner.pid}`)
    expect(() => process.kill(gateway.pid, 0)).not.toThrow()
    expect(() => process.kill(runner.pid, 0)).not.toThrow()
  })

  test('zerochanはstale exportを無視して実行した物理Git directoryを選ぶ', async () => {
    const state = fixture()
    const project = join(dirname(state), 'project')
    const projectAlias = join(dirname(state), 'project-alias')
    const stale = join(dirname(state), 'stale-project')
    mkdirSync(stale)
    Bun.spawnSync(['git', 'init', '-q', stale])
    symlinkSync(project, projectAlias)
    const result = await runLauncher(state, {
      ZEROKUN_PROJECT_DIR: stale,
      ZEROKUN_DRY_RUN: '1',
    }, undefined, { invokedAs: 'zerochan', cwd: projectAlias })
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain(`対象project: ${realpathSync(project)}`)
    expect(result.output).not.toContain(`対象project: ${realpathSync(stale)}`)
  })

  test('zerochan --restartは最後に接続できたprojectを使う', async () => {
    const state = fixture()
    const project = realpathSync(join(dirname(state), 'project'))
    writeFileSync(join(state, 'last-connected-project.json'), JSON.stringify({
      version: 1, projectDir: project, connectedAt: 1234,
    }), { mode: 0o600 })
    const result = await runLauncher(state, {
      ZEROKUN_DRY_RUN: '1',
    }, undefined, { invokedAs: 'zerochan', cwd: state, args: ['--restart'] })
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain(`対象project: ${project}`)
  })

  test('zerochan --restartは非TTYでも既存gatewayを置換し互換runnerを維持する', async () => {
    const state = fixture()
    const project = realpathSync(join(dirname(state), 'project'))
    const gateway = startGateway(state)
    const runner = startRunner(state)
    writeFileSync(join(state, 'last-connected-project.json'), JSON.stringify({
      version: 1, projectDir: project, connectedAt: 1234,
    }), { mode: 0o600 })
    await Bun.sleep(100)

    const result = await runLauncher(state, {}, undefined, {
      invokedAs: 'zerochan', cwd: state, args: ['--restart'],
    })

    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain('--restart 指定のため、既存gatewayを安全に入れ替えます')
    expect(result.output).toContain(`job-runner: running (PID ${runner.pid}, FIFO=1)`)
    expect(result.output).not.toContain('起動を中止しました')
    expect(() => process.kill(gateway.pid, 0)).toThrow()
    expect(() => process.kill(runner.pid, 0)).not.toThrow()
    expect(existsSync(join(state, 'restart.lock', 'pid'))).toBe(false)
  })

  test('zerochan --restartはSIGTERMを無視するgatewayもexact generationで回収する', async () => {
    const state = fixture()
    const project = realpathSync(join(dirname(state), 'project'))
    const gateway = startGateway(state, { ignoreTerm: true })
    writeFileSync(join(state, 'last-connected-project.json'), JSON.stringify({
      version: 1, projectDir: project, connectedAt: 1234,
    }), { mode: 0o600 })
    await Bun.sleep(100)
    try {
      const result = await runLauncher(state, {
        ZEROKUN_RUNNER_STARTUP_ATTEMPTS: '80',
      }, undefined, {
        invokedAs: 'zerochan', cwd: state, args: ['--restart'],
      })
      expect(result.exitCode, result.output).toBe(0)
      expect(result.output).not.toContain('起動を中止しました')
      expect(() => process.kill(gateway.pid, 0)).toThrow()
    } finally {
      await stopFixturePid(join(state, 'fake-starter-pid'))
      await stopFixturePid(join(state, 'fake-runner-pid'))
    }
  }, 15_000)

  test('zerochan --restartはexact generation停止helper失敗時に新gatewayを起動しない', async () => {
    const state = fixture()
    const project = realpathSync(join(dirname(state), 'project'))
    const gateway = startGateway(state)
    writeFileSync(join(state, 'last-connected-project.json'), JSON.stringify({
      version: 1, projectDir: project, connectedAt: 1234,
    }), { mode: 0o600 })
    await Bun.sleep(100)

    const result = await runLauncher(state, {
      FAKE_PROCESS_LOCK_STOP_FAIL: '1',
    }, undefined, {
      invokedAs: 'zerochan', cwd: state, args: ['--restart'],
    })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('同一generationのまま停止できません')
    expect(result.output).not.toContain('▶ Zeroちゃん')
    expect(() => process.kill(gateway.pid, 0)).not.toThrow()
    expect(existsSync(join(state, 'restart.lock', 'pid'))).toBe(false)
  })

  test('legacy zerokunはlast recordがない初回も現在のGit directoryで起動できる', async () => {
    const state = fixture()
    const project = realpathSync(join(dirname(state), 'project'))
    const ambientProject = join(dirname(state), 'ambient-project')
    mkdirSync(ambientProject)
    const initialized = Bun.spawnSync(['git', 'init', '-q', ambientProject], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    expect(initialized.exitCode, initialized.stderr.toString()).toBe(0)
    const previousProject = process.env.ZEROKUN_PROJECT_DIR
    process.env.ZEROKUN_PROJECT_DIR = ambientProject
    let result: Awaited<ReturnType<typeof runLauncher>>
    try {
      result = await runLauncher(state, {
        ZEROKUN_DRY_RUN: '1',
      }, undefined, { invokedAs: 'zerokun', cwd: project })
    } finally {
      if (previousProject === undefined) delete process.env.ZEROKUN_PROJECT_DIR
      else process.env.ZEROKUN_PROJECT_DIR = previousProject
    }
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain(`対象project: ${project}`)
    expect(result.output).not.toContain(`対象project: ${realpathSync(ambientProject)}`)
    expect(result.output).not.toContain('前回接続したprojectを確認できません')
  })

  test('不正cwdはtoken消費・journal recovery・gateway停止より前に拒否する', async () => {
    const state = fixture()
    const gateway = startGateway(state)
    const invalid = join(dirname(state), 'not-a-git-project')
    const tokenFile = join(state, 'replace-token')
    const bunLog = join(state, 'bun.log')
    mkdirSync(invalid)
    writeFileSync(tokenFile, 'keep-me')
    writeFileSync(join(state, 'update-transaction.json'), '{}')
    const result = await runLauncher(state, {
      ZEROKUN_UPDATE_RESTART: '1',
      ZEROKUN_REPLACE_TOKEN: 'keep-me',
      ZEROKUN_REPLACE_TOKEN_FILE: tokenFile,
      FAKE_BUN_LOG: bunLog,
    }, undefined, { invokedAs: 'zerochan', cwd: invalid })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('Git worktree')
    expect(readFileSync(tokenFile, 'utf8')).toBe('keep-me')
    expect(readFileSync(bunLog, 'utf8')).not.toContain('update.ts --recover-only')
    expect(() => process.kill(gateway.pid, 0)).not.toThrow()
  })

  test('Codex 0.149.0未満をjob受付前に拒否する', async () => {
    const state = fixture()
    const result = await runLauncher(state, {
      FAKE_CODEX_VERSION: '0.148.9',
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('0.149.0 以上')
  })

  test('prefixなしのCodex semverも正しく検出する', async () => {
    const state = fixture()
    const result = await runLauncher(state, {
      FAKE_BARE_VERSION: '1',
      FAKE_CODEX_VERSION: '0.149.0',
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.output).not.toContain('0.149.0 以上が必要')
  })

  test('Claude subscription login切れはjob受付を止めずround内で欠員記録する', async () => {
    const state = fixture()
    writeFileSync(join(state, 'fake-claude-auth-fail'), '1\n', { mode: 0o600 })
    const result = await runLauncher(state, { ZEROKUN_DRY_RUN: '1' })
    expect(result.exitCode).toBe(0)
    expect(result.output).not.toContain('Claude Codeはsubscription login済みである必要があります')
  })

  test('Herdr 0.8.2未満をjob受付前に拒否する', async () => {
    const state = fixture()
    const result = await runLauncher(state, {
      FAKE_HERDR_VERSION: '0.8.1',
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('Herdr 0.8.2 以上')
  })

  test('Herdrの必須workspace/tab/pane/agent API不足をjob受付前に拒否する', async () => {
    const state = fixture()
    const result = await runLauncher(state, {
      FAKE_HERDR_CAPS: '0',
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('必要とするworkspace/tab/pane/agent APIがありません')
  })

  test('PATH上の互換Herdrより明示HERDR_BIN_PATHを正本にする', async () => {
    const state = fixture()
    const incompatible = join(state, 'explicit-old-herdr')
    writeFileSync(incompatible, '#!/bin/sh\necho "herdr 0.8.1"\n', { mode: 0o700 })
    const result = await runLauncher(state, {
      HERDR_BIN_PATH: incompatible,
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('Herdr 0.8.2 以上')
  })

  test('agent promptの必須until flag欠落をjob受付前に拒否する', async () => {
    const state = fixture()
    const result = await runLauncher(state, {
      FAKE_HERDR_MISSING_UNTIL: '1',
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('必要とするworkspace/tab/pane/agent APIがありません')
  })

  test('停止したHerdr probeを期限付きで拒否する', async () => {
    const state = fixture()
    const startedAt = Date.now()
    const result = await runLauncher(state, {
      FAKE_HERDR_HANG: '1',
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.exitCode).toBe(1)
    expect(Date.now() - startedAt).toBeLessThan(8_000)
    expect(result.output).toContain('Herdr 0.8.2 以上')
  }, 10_000)

  test('ZEROKUN_REPLACE=1だけでは稼働中gatewayを停止しない', async () => {
    const state = fixture()
    const gateway = startGateway(state)
    await Bun.sleep(100)
    const result = await runLauncher(state, {
      ZEROKUN_REPLACE: '1',
      ZEROKUN_REPLACE_TOKEN_FILE: join(state, 'replace-token'),
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('有効なワンタイムトークンがありません')
    expect(gateway.killed).toBe(false)
  })

  test('不一致tokenでは停止しない', async () => {
    const state = fixture()
    const gateway = startGateway(state)
    writeFileSync(join(state, 'replace-token'), 'correct')
    await Bun.sleep(100)
    const result = await runLauncher(state, {
      ZEROKUN_REPLACE: '1',
      ZEROKUN_REPLACE_TOKEN: 'wrong',
      ZEROKUN_REPLACE_TOKEN_FILE: join(state, 'replace-token'),
    })
    expect(result.exitCode).toBe(1)
    expect(gateway.killed).toBe(false)
  })

  test('異なるSlack Appの資格情報はgateway停止境界より前に拒否する', async () => {
    const state = fixture()
    const gateway = startGateway(state)
    await Bun.sleep(100)
    const result = await runLauncher(state, {
      FAKE_IDENTITY_FAIL: '1',
      ZEROKUN_REPLACE: '1',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('different Slack Apps')
    expect(result.output).toContain('既存processは停止しません')
    expect(gateway.killed).toBe(false)
  })

  test('ambient proxyとTLS overrideをSlack identity検証前に除去する', async () => {
    const state = fixture()
    const environmentLog = join(state, 'environment.log')
    const result = await runLauncher(state, {
      FAKE_ENV_LOG: environmentLog,
      HTTPS_PROXY: 'http://user:password@127.0.0.1:9',
      https_proxy: 'http://user:password@127.0.0.1:9',
      NODE_EXTRA_CA_CERTS: join(state, 'attacker-ca.pem'),
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      ZEROKUN_UPDATE_TESTING: '1',
      ZEROKUN_SLACK_IDENTITY_TEST_APP_ID: 'AATTACKER1',
      ZEROKUN_SETUP_TEST_STOP_PROBE: join(state, 'probe'),
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.exitCode).toBe(0)
    const environment = readFileSync(environmentLog, 'utf8')
    expect(environment).not.toContain('HTTPS_PROXY=')
    expect(environment).not.toContain('https_proxy=')
    expect(environment).not.toContain('NODE_EXTRA_CA_CERTS=')
    expect(environment).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED=')
    expect(environment).not.toContain('ZEROKUN_UPDATE_TESTING=')
    expect(environment).not.toContain('ZEROKUN_SLACK_IDENTITY_TEST_APP_ID=')
    expect(environment).not.toContain('ZEROKUN_SETUP_TEST_STOP_PROBE=')
  })

  test('確認待ち中にgateway identityが変わればsignalしない', async () => {
    const state = fixture()
    const gateway = startGateway(state)
    const tokenFile = join(state, 'replace-token')
    const identityCounter = join(state, 'identity-counter')
    writeFileSync(tokenFile, 'replace-once')
    await Bun.sleep(100)
    const result = await runLauncher(state, {
      ZEROKUN_REPLACE: '1',
      ZEROKUN_REPLACE_TOKEN: 'replace-once',
      ZEROKUN_REPLACE_TOKEN_FILE: tokenFile,
      FAKE_IDENTITY_COUNTER: identityCounter,
      FAKE_DELAY_SECOND_IDENTITY: '1',
    }, async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (existsSync(identityCounter) && readFileSync(identityCounter, 'utf8').trim() === '2') break
        await Bun.sleep(10)
      }
      expect(readFileSync(identityCounter, 'utf8').trim()).toBe('2')
      writeFileSync(join(state, 'plugin.lock.identity'), JSON.stringify({
        pid: gateway.pid,
        started: 'identity changed while waiting',
        nonce: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
      }))
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('確認待ちの間に変化したためsignalしません')
    expect(() => process.kill(gateway.pid, 0)).not.toThrow()
  })

  test('異なるSlack Appの資格情報ではjournal recoveryもgateway停止前に拒否する', async () => {
    const state = fixture()
    const gateway = startGateway(state)
    const bunLog = join(state, 'bun.log')
    writeFileSync(join(state, 'update-transaction.json'), '{}')
    await Bun.sleep(100)
    const result = await runLauncher(state, {
      FAKE_IDENTITY_FAIL: '1',
      FAKE_BUN_LOG: bunLog,
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('different Slack Apps')
    const calls = readFileSync(bunLog, 'utf8')
    expect(calls).toContain('slack-app-identity.ts')
    expect(calls).not.toContain('update.ts --recover-only')
    expect(gateway.killed).toBe(false)
  })

  test('一致するone-time tokenだけがdry-run入れ替えを許可し、tokenを消す', async () => {
    const state = fixture()
    const gateway = startGateway(state)
    const tokenFile = join(state, 'replace-token')
    writeFileSync(tokenFile, 'one-time')
    await Bun.sleep(100)
    const result = await runLauncher(state, {
      ZEROKUN_REPLACE: '1',
      ZEROKUN_REPLACE_TOKEN: 'one-time',
      ZEROKUN_REPLACE_TOKEN_FILE: tokenFile,
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('ワンタイムトークンを確認しました')
    expect(existsSync(tokenFile)).toBe(false)
    expect(gateway.killed).toBe(false)
  })

  test('親updaterのone-time tokenだけがjournal保持中のrestartを許可する', async () => {
    const state = fixture()
    const tokenFile = join(state, 'replace-token')
    const bunLog = join(state, 'bun.log')
    const environmentLog = join(state, 'environment.log')
    writeFileSync(join(state, 'update-transaction.json'), '{}')
    writeFileSync(tokenFile, 'restart-once')
    try {
      const result = await runLauncher(state, {
        ZEROKUN_UPDATE_RESTART: '1',
        ZEROKUN_REPLACE_TOKEN: 'restart-once',
        ZEROKUN_REPLACE_TOKEN_FILE: tokenFile,
        ZEROKUN_RUNNER_STARTUP_ATTEMPTS: '80',
        FAKE_BUN_LOG: bunLog,
        FAKE_ENV_LOG: environmentLog,
      })
      expect(result.exitCode, result.output).toBe(0)
      expect(result.output).toContain('自己更新restartのワンタイムトークンを確認しました')
      expect(existsSync(tokenFile)).toBe(false)
      const calls = readFileSync(bunLog, 'utf8')
      expect(calls).not.toContain('recover-only')
      expect(calls).not.toContain('project-channel-config.ts sync')
      expect(readFileSync(environmentLog, 'utf8'))
        .not.toContain('ZEROKUN_REPLACE_TOKEN=restart-once')
    } finally {
      await stopFixturePid(join(state, 'fake-starter-pid'))
      await stopFixturePid(join(state, 'fake-runner-pid'))
    }
  })

  test('tokenなしではjournalを無視できずrecover-onlyを呼ぶ', async () => {
    const state = fixture()
    const bunLog = join(state, 'bun.log')
    writeFileSync(join(state, 'update-transaction.json'), '{}')
    const result = await runLauncher(state, {
      ZEROKUN_UPDATE_RESTART: '1',
      ZEROKUN_DRY_RUN: '1',
      FAKE_BUN_LOG: bunLog,
    })
    expect(result.output).toContain('未完了の自己更新を検出しました')
    expect(readFileSync(bunLog, 'utf8')).toContain('recover-only')
  })

  test('candidateのCodex version検査が失敗してもjournal recoveryを先に呼ぶ', async () => {
    const state = fixture()
    const bunLog = join(state, 'bun.log')
    writeFileSync(join(state, 'update-transaction.json'), '{}')
    const result = await runLauncher(state, {
      FAKE_CODEX_VERSION: '0.1.0',
      ZEROKUN_DRY_RUN: '1',
      FAKE_BUN_LOG: bunLog,
    })
    expect(result.exitCode).toBe(1)
    expect(readFileSync(bunLog, 'utf8')).toContain('update.ts --recover-only')
    expect(result.output.indexOf('未完了の自己更新'))
      .toBeLessThan(result.output.indexOf('0.149.0 以上'))
  })

  test('job runner起動が5秒を超えても検証済みgenerationを待つ', async () => {
    const state = fixture()
    try {
      const result = await runLauncher(state, {
        FAKE_RUNNER_DELAY_MS: '5500',
        ZEROKUN_RUNNER_STARTUP_ATTEMPTS: '80',
      })
      expect(result.exitCode, result.output).toBe(0)
      expect(result.output).toContain('job-runner: started')
      expect(existsSync(join(state, 'fake-runner-pid'))).toBe(true)
    } finally {
      await stopFixturePid(join(state, 'fake-starter-pid'))
      await stopFixturePid(join(state, 'fake-runner-pid'))
    }
  }, 12_000)

  test('runner本体終了後に残ったlauncherをexact lockで回収して再起動する', async () => {
    const state = fixture()
    const orphanedLauncher = await startOrphanedRunnerLauncher(state)
    try {
      const result = await runLauncher(state, {
        ZEROKUN_RUNNER_STARTUP_ATTEMPTS: '2',
      })
      expect(result.exitCode, result.output).toBe(0)
      expect(result.output).toContain('終了済みrunnerを待ち続けているlauncherを安全に回収します')
      expect(result.output).toContain('job-runner: started')
      expect(await Promise.race([
        orphanedLauncher.exited.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ])).toBe(true)
    } finally {
      await stopFixturePid(join(state, 'fake-starter-pid'))
      await stopFixturePid(join(state, 'fake-runner-pid'))
    }
  }, 10_000)

  test('job runner起動期限切れはstarterを強制停止しrunnerを残さない', async () => {
    const state = fixture()
    const result = await runLauncher(state, {
      FAKE_RUNNER_DELAY_MS: '30000',
      FAKE_RUNNER_IGNORE_TERM: '1',
      ZEROKUN_RUNNER_STARTUP_ATTEMPTS: '2',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('Codex job runnerの起動に失敗しました')
    const starterPid = Number(readFileSync(join(state, 'fake-starter-pid'), 'utf8'))
    expect(() => process.kill(starterPid, 0)).toThrow()
    expect(existsSync(join(state, 'fake-runner-pid'))).toBe(false)
  }, 10_000)
})

describe('zero help', () => {
  // The guide must stay answerable while the runtime is broken, so these run
  // without bun, without state, and without Slack credentials on PATH.
  async function runHelp(invokedAs: string, args: string[]) {
    const base = mkdtempSync(join(tmpdir(), 'zerokun-zero-help-'))
    temporaryDirs.push(base)
    const path = join(base, invokedAs)
    symlinkSync(LAUNCHER, path)
    const child = Bun.spawn(['/bin/bash', path, ...args], {
      env: { HOME: base, PATH: '/usr/bin:/bin' },
      cwd: base,
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { exitCode, stdout, stderr }
  }

  function expectsGuide(text: string): void {
    expect(text).toContain('zerochan start')
    expect(text).toContain('zerochan stop --force')
    expect(text).toContain('zerochan update --recover-only')
    expect(text).toContain('zerochan set slack-channel')
    expect(text).toContain('zerokun-jobs status')
    expect(text).toContain('zerochan-access write allow')
  }

  test('zero helpはbun・state・Slack資格情報なしで操作ガイドを返す', async () => {
    const result = await runHelp('zero', ['help'])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expectsGuide(result.stdout)
  })

  test('引数なしのzeroも同じガイドを返す', async () => {
    const result = await runHelp('zero', [])
    expect(result.exitCode).toBe(0)
    expectsGuide(result.stdout)
  })

  test('zeroは実行系subcommandを受け付けずzerochanへ案内する', async () => {
    const result = await runHelp('zero', ['start'])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('zerochan を使ってください')
    expectsGuide(result.stderr)
  })

  test('zerochan help / --help / -h も同じガイドを返す', async () => {
    for (const argument of ['help', '--help', '-h']) {
      const result = await runHelp('zerochan', [argument])
      expect(result.exitCode).toBe(0)
      expectsGuide(result.stdout)
    }
  })

  test('zerokun helpも同じガイドを返す', async () => {
    const result = await runHelp('zerokun', ['help'])
    expect(result.exitCode).toBe(0)
    expectsGuide(result.stdout)
  })
})
