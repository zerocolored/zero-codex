import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
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
  const dir = mkdtempSync(join(tmpdir(), 'zerokun-codex-launcher-'))
  temporaryDirs.push(dir)
  writeFileSync(join(dir, '.env'), [
    'SLACK_BOT_TOKEN=xoxb-launcher-test-token-12345',
    'SLACK_APP_TOKEN=xapp-1-A0123456789-launcher-test-token-12345',
    '',
  ].join('\n'), { mode: 0o600 })
  return dir
}

function startGateway(state: string): Bun.Subprocess {
  const server = join(state, 'server.ts')
  writeFileSync(server, '#!/bin/bash\nsleep 30\n')
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
      '  printf "%064d\\n" 0',
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
    "echo 'Usage: herdr pane run'",
    "echo 'Usage: herdr tab close'",
    'if [ "${FAKE_HERDR_MISSING_UNTIL:-0}" = "1" ]; then',
    "  echo '--current --workspace --cwd --label --no-focus --match --source --lines --timeout --pane --wait --timeout'",
    'else',
    "  echo '--current --workspace --cwd --label --no-focus --match --source --lines --timeout --pane --wait --until --timeout'",
    'fi',
    "echo 'Usage: herdr agent list Usage: herdr agent get'",
    '',
  ].join('\n'), { mode: 0o700 })
  const child = Bun.spawn(['/bin/bash', LAUNCHER, state], {
    env: {
      ...processEnvWithout('ZEROKUN_REPLACE_TOKEN'),
      HOME: state,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      HERDR_BIN_PATH: herdr,
      ZEROKUN_STATE_DIR: state,
      FAKE_RUNNER_STATE: state,
      FAKE_RUNNER_RUNTIME: `zerokun-codex-runner-v1:A0123456789:fixture-token-fingerprint:${'0'.repeat(64)}`,
      ...env,
    },
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

function processEnvWithout(key: string): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (name !== key && value !== undefined) environment[name] = value
  }
  return environment
}

describe('codex-channel.sh replacement guard', () => {
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

  test('Herdr 0.8.2未満をjob受付前に拒否する', async () => {
    const state = fixture()
    const result = await runLauncher(state, {
      FAKE_HERDR_VERSION: '0.8.1',
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('Herdr 0.8.2 以上')
  })

  test('Herdrの必須tab/pane API不足をjob受付前に拒否する', async () => {
    const state = fixture()
    const result = await runLauncher(state, {
      FAKE_HERDR_CAPS: '0',
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('必要とするtab/pane APIがありません')
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
    expect(result.output).toContain('必要とするtab/pane APIがありません')
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
    writeFileSync(join(state, 'update-transaction.json'), '{}')
    writeFileSync(tokenFile, 'restart-once')
    const result = await runLauncher(state, {
      ZEROKUN_UPDATE_RESTART: '1',
      ZEROKUN_REPLACE_TOKEN: 'restart-once',
      ZEROKUN_REPLACE_TOKEN_FILE: tokenFile,
      ZEROKUN_DRY_RUN: '1',
      FAKE_BUN_LOG: bunLog,
    })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('自己更新restartのワンタイムトークンを確認しました')
    expect(existsSync(tokenFile)).toBe(false)
    expect(readFileSync(bunLog, 'utf8')).not.toContain('recover-only')
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
