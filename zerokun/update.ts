#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { randomUUID } from 'crypto'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'

interface Repository {
  label: string
  path: string
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

const decoder = new TextDecoder()

function output(message: string): void {
  process.stdout.write(`${message}\n`)
}

function fail(message: string): never {
  throw new Error(message)
}

function command(
  args: string[],
  options: { cwd?: string; inherit?: boolean; env?: Record<string, string | undefined> } = {},
): CommandResult {
  const result = Bun.spawnSync(args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdin: 'ignore',
    stdout: options.inherit ? 'inherit' : 'pipe',
    stderr: options.inherit ? 'inherit' : 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout ? decoder.decode(result.stdout).trim() : '',
    stderr: result.stderr ? decoder.decode(result.stderr).trim() : '',
  }
}

function requireCommand(
  args: string[],
  options: { cwd?: string; inherit?: boolean; env?: Record<string, string | undefined> } = {},
): string {
  const result = command(args, options)
  if (result.exitCode !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n')
    fail(`コマンド失敗: ${args.join(' ')}${detail ? `\n${detail}` : ''}`)
  }
  return result.stdout
}

export function processStateIsAlive(state: string): boolean {
  const normalized = state.trim().toUpperCase()
  return normalized.length > 0 && !normalized.startsWith('Z')
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    const state = command(['ps', '-o', 'state=', '-p', String(pid)])
    return state.exitCode === 0 && processStateIsAlive(state.stdout)
  } catch {
    return false
  }
}

function readPid(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function resolveRootRepo(): string {
  if (process.env.ZEROKUN_REPO_DIR) return realpathSync(process.env.ZEROKUN_REPO_DIR)
  const invoked = process.argv[1] ? realpathSync(process.argv[1]) : import.meta.path
  return realpathSync(join(dirname(invoked), '..'))
}

function acquireUpdateLock(stateDir: string): { path: string; release: () => void } {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const lockPath = join(stateDir, 'update.lock')
  const pidPath = join(lockPath, 'pid')
  try {
    mkdirSync(lockPath, { mode: 0o700 })
  } catch {
    const existing = readPid(pidPath)
    if (existing && pidIsAlive(existing)) fail(`別のzerokun-updateが実行中です (PID ${existing})`)
    rmSync(lockPath, { recursive: true, force: true })
    mkdirSync(lockPath, { mode: 0o700 })
  }
  writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 })
  let held = true
  return {
    path: lockPath,
    release: () => {
      if (!held) return
      held = false
      if (readPid(pidPath) === process.pid) rmSync(lockPath, { recursive: true, force: true })
    },
  }
}

function activeJobCounts(raw: string): { queued: number; running: number } {
  const jobs = JSON.parse(raw) as Array<{ status?: string }>
  if (!Array.isArray(jobs)) fail('job statusが配列ではありません')
  return {
    queued: jobs.filter(job => job.status === 'queued').length,
    running: jobs.filter(job => job.status === 'running').length,
  }
}

async function waitForRunningJobs(stateDir: string, timeoutSeconds: number): Promise<void> {
  const runner = join(stateDir, 'job-runner.ts')
  if (!existsSync(runner)) {
    output('   queue: 未導入（初回更新）')
    return
  }

  const startedAt = Date.now()
  while (true) {
    const status = command([runner, 'status'])
    if (status.exitCode !== 0) {
      fail(`queue状態を取得できません: ${status.stderr || status.stdout}`)
    }
    const counts = activeJobCounts(status.stdout)
    if (counts.running === 0) {
      output(`   queue: 実行中0件 / 待機${counts.queued}件（更新中はclaim停止）`)
      return
    }
    if (Date.now() - startedAt >= timeoutSeconds * 1000) {
      fail(`実行中job ${counts.running}件があるため更新を停止しました`)
    }
    output(`   queue: 実行中job ${counts.running}件の完了待ち...`)
    await Bun.sleep(5_000)
  }
}

function assertRepositoryClean(repo: Repository): void {
  if (!existsSync(join(repo.path, '.git'))) fail(`${repo.label} のcloneがありません: ${repo.path}`)
  const dirty = requireCommand(['git', 'status', '--porcelain'], { cwd: repo.path })
  if (dirty) fail(`${repo.label} に未コミット変更があります。更新せず停止しました`)
}

function refExists(repo: Repository, ref: string): boolean {
  return command(['git', 'show-ref', '--verify', '--quiet', ref], { cwd: repo.path }).exitCode === 0
}

function isAncestor(repo: Repository, ancestor: string, descendant: string): boolean {
  return command(['git', 'merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repo.path,
  }).exitCode === 0
}

function preflightRepositories(repositories: Repository[]): void {
  for (const repo of repositories) assertRepositoryClean(repo)
  for (const repo of repositories) {
    output(`   fetch: ${repo.label}`)
    requireCommand(['git', 'fetch', '--prune', 'origin'], { cwd: repo.path })
  }

  for (const repo of repositories) {
    if (!refExists(repo, 'refs/remotes/origin/main')) {
      fail(`${repo.label} に origin/main がありません`)
    }
    const currentBranch = requireCommand(['git', 'branch', '--show-current'], { cwd: repo.path })
    if (!currentBranch) fail(`${repo.label} はdetached HEADです`)
    if (!isAncestor(repo, 'HEAD', 'origin/main')) {
      fail(`${repo.label} の ${currentBranch} は origin/mainへ未反映です。更新せず停止しました`)
    }
    if (
      refExists(repo, 'refs/heads/main')
      && !isAncestor(repo, 'main', 'origin/main')
    ) {
      fail(`${repo.label} のlocal mainがorigin/mainから分岐しています`)
    }
  }
}

function fastForwardRepositories(repositories: Repository[]): void {
  for (const repo of repositories) {
    output(`   update: ${repo.label}`)
    if (refExists(repo, 'refs/heads/main')) {
      requireCommand(['git', 'switch', '--quiet', 'main'], { cwd: repo.path })
    } else {
      requireCommand(['git', 'switch', '--quiet', '--create', 'main', '--track', 'origin/main'], {
        cwd: repo.path,
      })
    }
    requireCommand(['git', 'merge', '--quiet', '--ff-only', 'origin/main'], { cwd: repo.path })
  }
}

function validateZero(rootRepo: string): void {
  const buildDir = mkdtempSync(join(tmpdir(), 'zerokun-update-build-'))
  try {
    output('   validate: bun install')
    requireCommand(['bun', 'install', '--silent'], { cwd: rootRepo, inherit: true })
    output('   validate: bun test')
    requireCommand(['bun', 'test'], { cwd: rootRepo, inherit: true })
    output('   validate: build + shell syntax')
    requireCommand(
      ['bun', 'build', 'server.ts', '--target=bun', '--outfile', join(buildDir, 'server.js')],
      { cwd: rootRepo },
    )
    requireCommand(
      ['bun', 'build', 'zerokun/job-runner.ts', '--target=bun', '--outfile', join(buildDir, 'job-runner.js')],
      { cwd: rootRepo },
    )
    requireCommand(
      ['bun', 'build', 'zerokun/update.ts', '--target=bun', '--outfile', join(buildDir, 'update.js')],
      { cwd: rootRepo },
    )
    requireCommand(
      ['bun', 'build', 'zerokun/update-request.ts', '--target=bun', '--outfile', join(buildDir, 'update-request.js')],
      { cwd: rootRepo },
    )
    requireCommand(['bash', '-n', 'claude-channel.sh'], { cwd: rootRepo })
    requireCommand(['bash', '-n', 'zerokun/setup.sh'], { cwd: rootRepo })
    requireCommand(['bash', '-n', 'zerokun/bootstrap-macos.sh'], { cwd: rootRepo })
  } finally {
    rmSync(buildDir, { recursive: true, force: true })
  }
}

async function stopPid(pid: number, label: string, timeoutMs = 30_000): Promise<void> {
  if (!pidIsAlive(pid)) return
  output(`   stop: ${label} PID ${pid}`)
  process.kill(pid, 'SIGTERM')
  const startedAt = Date.now()
  while (pidIsAlive(pid)) {
    if (Date.now() - startedAt >= timeoutMs) fail(`${label} PID ${pid} が正常終了しません`)
    await Bun.sleep(200)
  }
}

function matchingPids(pattern: string): number[] {
  const found = command(['pgrep', '-f', pattern])
  if (found.exitCode !== 0 || !found.stdout) return []
  return found.stdout
    .split(/\s+/)
    .map(Number)
    .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
}

export async function waitForStableHealth(options: {
  observe: () => boolean
  requiredConsecutive: number
  maxChecks: number
  sleep: () => Promise<void>
}): Promise<void> {
  let consecutive = 0
  for (let check = 0; check < options.maxChecks; check += 1) {
    consecutive = options.observe() ? consecutive + 1 : 0
    if (consecutive >= options.requiredConsecutive) return
    await options.sleep()
  }
  fail('bot・bridge・runnerの安定稼働を確認できません')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function resolveTmuxPath(): string {
  const configured = process.env.ZEROKUN_TMUX_PATH
  if (configured && existsSync(configured)) return configured
  for (const candidate of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']) {
    if (existsSync(candidate)) return candidate
  }
  const found = command(['/usr/bin/which', 'tmux'])
  if (found.exitCode === 0 && found.stdout) return found.stdout
  fail('tmuxがありません。brew install tmux を実行してから再試行してください')
}

export async function startBotInTmux(options: {
  rootRepo: string
  projectDir: string
  logPath: string
  sessionName?: string
  confirmationTimeoutMs?: number
  tmuxPath?: string
  replaceTokenFile?: string
}): Promise<number> {
  const tmux = options.tmuxPath ?? resolveTmuxPath()
  const sessionName = options.sessionName ?? 'zerokun-slack'
  const timeoutMs = Math.max(1_000, options.confirmationTimeoutMs ?? 25_000)
  const launcher = join(options.rootRepo, 'claude-channel.sh')
  // 稼働中ボットの入れ替えは「自己更新が今まさに発行したワンタイムトークン」を
  // 持つ起動だけに許す。CLAUDE_CHANNEL_REPLACE=1 を手で付けただけでは現役を
  // kill できない(2026-08-17 の「検証のたびにゼロくんが落ちる」再発防止)。
  const replaceTokenFile = options.replaceTokenFile
    ?? join(homedir(), '.claude', 'channels', 'slack', 'replace-token')
  const replaceToken = randomUUID()
  mkdirSync(dirname(replaceTokenFile), { recursive: true, mode: 0o700 })
  writeFileSync(replaceTokenFile, replaceToken, { mode: 0o600 })
  const launchCommand = [
    'exec /usr/bin/env CHANNEL=slack CLAUDE_CHANNEL_REPLACE=1',
    `CLAUDE_CHANNEL_REPLACE_TOKEN=${shellQuote(replaceToken)}`,
    `CLAUDE_CHANNEL_REPLACE_TOKEN_FILE=${shellQuote(replaceTokenFile)}`,
    shellQuote(launcher),
    shellQuote(options.projectDir),
  ].join(' ')

  command([tmux, 'kill-session', '-t', sessionName])
  requireCommand([
    tmux,
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-x',
    '120',
    '-y',
    '40',
    launchCommand,
  ])

  try {
    requireCommand([
      tmux,
      'pipe-pane',
      '-o',
      '-t',
      sessionName,
      `/bin/cat >> ${shellQuote(options.logPath)}`,
    ])
    const maxChecks = Math.ceil(timeoutMs / 100)
    for (let check = 0; check < maxChecks; check += 1) {
      const pane = command([tmux, 'capture-pane', '-p', '-t', sessionName])
      if (pane.exitCode !== 0) fail('Claudeのtmuxセッションが確認画面より前に終了しました')
      if (/Enter\s+to\s+confirm/.test(pane.stdout)) {
        requireCommand([tmux, 'send-keys', '-t', sessionName, 'Enter'])
        const panePid = Number(requireCommand([
          tmux,
          'list-panes',
          '-t',
          sessionName,
          '-F',
          '#{pane_pid}',
        ]))
        if (!Number.isInteger(panePid) || panePid <= 0) fail('tmux pane PIDを取得できません')
        return panePid
      }
      await Bun.sleep(100)
    }
    fail(`Claudeの確認画面が${timeoutMs / 1_000}秒以内に表示されませんでした`)
  } catch (error) {
    command([tmux, 'kill-session', '-t', sessionName])
    throw error
  } finally {
    // 起動が成功しても失敗しても、トークンを残さない。
    // 残すと後からの手動 CLAUDE_CHANNEL_REPLACE=1 が 1 回だけ通ってしまう。
    rmSync(replaceTokenFile, { force: true })
  }
}

async function restartServices(
  rootRepo: string,
  stateDir: string,
  projectDir: string,
  releaseUpdateLock: () => void,
): Promise<void> {
  const runnerPid = readPid(join(stateDir, 'job-runner.lock', 'pid'))
  if (runnerPid) await stopPid(runnerPid, 'job runner')

  const botPattern = 'dangerously-load-development-channels server:slack-channel'
  for (const pid of matchingPids(botPattern)) await stopPid(pid, 'Slack bot')

  releaseUpdateLock()
  const logPath = join(stateDir, 'zerokun.log')
  const panePid = await startBotInTmux({
    rootRepo,
    projectDir,
    logPath,
    replaceTokenFile: join(stateDir, 'replace-token'),
  })
  // Claude Codeはdevelopment channel起動時に毎回確認画面を出す。
  // detached tmuxが実端末を保持し、確認表示後にEnterを送る。
  output(`   terminal: tmux zerokun-slack (pane PID ${panePid})`)

  await waitForStableHealth({
    requiredConsecutive: 10,
    maxChecks: 60,
    sleep: () => Bun.sleep(500),
    observe: () => {
      const newRunnerPid = readPid(join(stateDir, 'job-runner.lock', 'pid'))
      const bridgePid = readPid(join(stateDir, 'plugin.lock'))
      return matchingPids(botPattern).length > 0
        && Boolean(newRunnerPid && pidIsAlive(newRunnerPid))
        && Boolean(bridgePid && pidIsAlive(bridgePid))
    },
  }).catch(error => {
    fail(`${error instanceof Error ? error.message : String(error)}。ログ: ${logPath}`)
  })
  const newRunnerPid = readPid(join(stateDir, 'job-runner.lock', 'pid'))
  const bridgePid = readPid(join(stateDir, 'plugin.lock'))
  output(`   start: Slack bot + bridge PID ${bridgePid} + job runner PID ${newRunnerPid}`)
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const testing = process.env.ZEROKUN_UPDATE_TESTING === '1'
  const skipTests = args.has('--skip-tests')
  const noRestart = args.has('--no-restart')
  if (skipTests && !testing) fail('--skip-tests はテスト環境でのみ使用できます')
  const unknown = [...args].filter(arg => !['--skip-tests', '--no-restart'].includes(arg))
  if (unknown.length > 0) fail(`不明なオプション: ${unknown.join(', ')}`)

  const rootRepo = resolveRootRepo()
  const stateDir = process.env.ZEROKUN_STATE_DIR
    ?? join(process.env.HOME ?? fail('HOMEがありません'), '.claude', 'channels', 'slack')
  const ownerDir = process.env.ZEROKUN_OWNER_DIR ?? join(stateDir, 'owner')
  const projectDir = process.env.ZEROKUN_PROJECT_DIR
    ?? join(process.env.HOME ?? fail('HOMEがありません'), 'Desktop', 'Project', 'BellSalsesAI')
  const setupScript = process.env.ZEROKUN_SETUP_SCRIPT ?? join(rootRepo, 'zerokun', 'setup.sh')
  const waitSeconds = Number(process.env.ZEROKUN_UPDATE_WAIT_SECONDS ?? 21_600)
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) fail('ZEROKUN_UPDATE_WAIT_SECONDSが不正です')
  if (!existsSync(projectDir)) fail(`作業ディレクトリがありません: ${projectDir}`)
  if (!existsSync(setupScript)) fail(`setup.shがありません: ${setupScript}`)

  const repositories: Repository[] = [
    { label: 'zero', path: rootRepo },
    { label: 'claude-config', path: join(ownerDir, 'claude-config') },
    { label: 'claude-skills', path: join(ownerDir, 'claude-skills') },
  ]

  const updateLock = acquireUpdateLock(stateDir)
  const cleanup = () => updateLock.release()
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  try {
    output('▶ zerokun-update')
    await waitForRunningJobs(stateDir, waitSeconds)
    output('▶ 3リポを事前検査')
    preflightRepositories(repositories)
    output('▶ origin/mainへfast-forward')
    fastForwardRepositories(repositories)
    if (!skipTests) {
      output('▶ 更新後検証')
      validateZero(rootRepo)
    }
    output('▶ setupを反映')
    requireCommand(['bash', setupScript], {
      cwd: rootRepo,
      inherit: !testing,
      env: { ...process.env, ZEROKUN_STATE_DIR: stateDir },
    })
    if (noRestart) {
      output('✅ 3リポ更新・setup完了（--no-restart）')
      return
    }
    output('▶ ゼロくんとjob runnerを再起動')
    await restartServices(rootRepo, stateDir, projectDir, updateLock.release)
    output('✅ 3リポ更新・検証・再起動完了')
  } finally {
    cleanup()
    process.off('SIGINT', cleanup)
    process.off('SIGTERM', cleanup)
  }
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`❌ ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
