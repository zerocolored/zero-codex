#!/usr/bin/env bun

import { Database } from 'bun:sqlite'
import {
  existsSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { randomUUID } from 'crypto'
import { homedir, tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import {
  discardProcessLock,
  processLockOwnerMatches,
  releaseProcessLock,
  tryAcquireProcessLock,
} from './process-lock.ts'
import { resolveZeroStateDir } from './state-dir.ts'
import { readGatewayReadiness } from './readiness.ts'
import { buildCandidateEnvironment, buildUpdaterEnvironment } from './child-environment.ts'
import {
  ensureManagedDirectory,
  prepareManagedStateRoot,
  requireManagedDirectory,
} from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalPrivateFile } from './safe-file.ts'
import { assertEffectiveCodexPermissionConfig } from './codex-executor.ts'

interface Repository {
  label: string
  path: string
  branch: string
}

interface PinnedRepository extends Repository {
  targetHead: string
  originalHead: string
  originalBranch: string
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

type UpdatePhase = 'prepared' | 'fast-forwarded' | 'setup-applied' | 'rolling-back'

export interface UpdateJournal {
  version: 1
  id: string
  phase: UpdatePhase
  repoPath: string
  branch: string
  originalHead: string
  targetHead: string
  projectDir: string
  setupScript: string
  databasePath: string | null
  databaseBackup: string | null
  noRestart: boolean
}

const decoder = new TextDecoder()
function gitConfigOverrides(): string[] {
  return [
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'credential.helper=',
    'core.sshCommand=/usr/bin/false',
    'protocol.allow=never',
    'protocol.https.allow=always',
    ...(process.env.ZEROKUN_UPDATE_TESTING === '1' ? ['protocol.file.allow=always'] : []),
  ]
}

function hardenedGitArgs(args: string[]): string[] {
  if (args[0] !== 'git') return args
  return ['git', ...gitConfigOverrides().flatMap(value => ['-c', value]), ...args.slice(1)]
}

function hardenedGitEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...buildUpdaterEnvironment(source),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GIT_PAGER: 'cat',
  }
}

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
  const commandArgs = hardenedGitArgs(args)
  const result = Bun.spawnSync(commandArgs, {
    cwd: options.cwd,
    env: args[0] === 'git'
      ? hardenedGitEnvironment(options.env ?? process.env)
      : options.env ?? process.env,
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

async function requireCommandAsync(
  args: string[],
  options: {
    cwd?: string
    inherit?: boolean
    env?: Record<string, string | undefined>
    signal?: AbortSignal
  } = {},
): Promise<string> {
  if (options.signal?.aborted) fail('更新を中断しました')
  const commandArgs = hardenedGitArgs(args)
  const proc = Bun.spawn(commandArgs, {
    cwd: options.cwd,
    env: args[0] === 'git'
      ? hardenedGitEnvironment(options.env ?? process.env)
      : options.env ?? process.env,
    stdin: 'ignore',
    stdout: options.inherit ? 'inherit' : 'pipe',
    stderr: options.inherit ? 'inherit' : 'pipe',
    detached: process.platform !== 'win32',
  })
  let forceKill: ReturnType<typeof setTimeout> | undefined
  const terminate = () => {
    if (process.platform !== 'win32') {
      try { process.kill(-proc.pid, 'SIGTERM') } catch { try { proc.kill('SIGTERM') } catch {} }
    } else {
      try { proc.kill('SIGTERM') } catch {}
    }
    forceKill ??= setTimeout(() => {
      if (process.platform !== 'win32') {
        try { process.kill(-proc.pid, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch {} }
      } else {
        try { proc.kill('SIGKILL') } catch {}
      }
    }, 5_000)
  }
  options.signal?.addEventListener('abort', terminate, { once: true })
  const stdoutPromise = options.inherit ? Promise.resolve('') : new Response(proc.stdout).text()
  const stderrPromise = options.inherit ? Promise.resolve('') : new Response(proc.stderr).text()
  const exitCode = await proc.exited
  if (forceKill) clearTimeout(forceKill)
  options.signal?.removeEventListener('abort', terminate)
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  if (options.signal?.aborted) fail('更新を中断しました')
  if (exitCode !== 0) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
    fail(`コマンド失敗: ${args.join(' ')}${detail ? `\n${detail}` : ''}`)
  }
  return stdout.trim()
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
    const content = readOptionalPrivateFile(path)
    if (content === null) return undefined
    const pid = Number(content.trim())
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
  prepareManagedStateRoot(stateDir)
  const lockPath = join(stateDir, 'update.lock')
  const pidPath = join(lockPath, 'pid')
  ensureManagedDirectory(stateDir, lockPath)
  const attempt = tryAcquireProcessLock(pidPath)
  if (attempt.acquired === false) {
    fail(`別のzerokun-updateが実行中です (PID ${attempt.heldPid})`)
  }
  let held = true
  return {
    path: lockPath,
    release: () => {
      if (!held) return
      held = false
      releaseProcessLock(pidPath)
    },
  }
}

export function activeJobCounts(raw: string): { queued: number; running: number } {
  const jobs = JSON.parse(raw) as Array<{ status?: string; runtime?: string }>
  if (!Array.isArray(jobs)) fail('job statusが配列ではありません')
  // The first Codex update may still call an older installed runner whose
  // records have no runtime field, so those remain relevant. Once migrated,
  // explicit Claude history must not block Codex updates forever.
  const relevant = jobs.filter(job => job.runtime === undefined || job.runtime === 'codex')
  return {
    queued: relevant.filter(job => job.status === 'queued').length,
    running: relevant.filter(job => job.status === 'running').length,
  }
}

export function activeJobCountsFromDatabase(dbPath: string): {
  queued: number
  running: number
} {
  const db = new Database(dbPath, { readonly: true })
  try {
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all()
    const hasRuntime = columns.some(column => column.name === 'runtime')
    const rows = db.query<{ status: string; count: number }, []>(
      `SELECT status, COUNT(*) AS count FROM jobs
       WHERE status IN ('queued', 'running')${hasRuntime ? " AND runtime = 'codex'" : ''}
       GROUP BY status`,
    ).all()
    return {
      queued: rows.find(row => row.status === 'queued')?.count ?? 0,
      running: rows.find(row => row.status === 'running')?.count ?? 0,
    }
  } finally {
    db.close()
  }
}

function requireSafeDatabaseSource(
  databasePath: string,
): NonNullable<ReturnType<typeof lstatSync>> {
  const parent = dirname(databasePath)
  const parentMetadata = lstatSync(parent)
  const parentOwner = typeof process.getuid !== 'function' || parentMetadata.uid === process.getuid()
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || !parentOwner
    || (Number(parentMetadata.mode) & 0o022) !== 0) {
    fail(`unsafe SQLite parent directory: ${parent}`)
  }
  let databaseMetadata: NonNullable<ReturnType<typeof lstatSync>> | undefined
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    let metadata: NonNullable<ReturnType<typeof lstatSync>>
    try { metadata = lstatSync(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path !== databasePath) continue
      throw error
    }
    const owner = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !owner) {
      fail(`unsafe SQLite file: ${path}`)
    }
    if (path === databasePath) databaseMetadata = metadata
  }
  if (!databaseMetadata) fail(`SQLite database does not exist: ${databasePath}`)
  return databaseMetadata!
}

async function waitForRunningJobs(
  stateDir: string,
  timeoutSeconds: number,
  jobRunnerFile: string,
  signal?: AbortSignal,
): Promise<void> {
  const dbPath = process.env.ZEROKUN_JOB_DB ?? join(stateDir, 'jobs.sqlite3')
  if (!existsSync(dbPath)) {
    output('   queue: 未導入（初回更新）')
    return
  }
  requireSafeDatabaseSource(dbPath)

  const startedAt = Date.now()
  while (true) {
    if (signal?.aborted) fail('更新を中断しました')
    let counts: { queued: number; running: number }
    try {
      counts = activeJobCountsFromDatabase(dbPath)
    } catch (error) {
      fail(`queue状態を取得できません: ${error}`)
    }
    if (counts.running === 0) {
      output(`   queue: 実行中0件 / 待機${counts.queued}件（更新中はclaim停止）`)
      return
    }
    const runnerPid = readPid(join(stateDir, 'job-runner.lock', 'pid'))
    const runnerCommand = runnerPid
      ? command(['ps', '-o', 'command=', '-p', String(runnerPid)])
      : { exitCode: 1, stdout: '', stderr: '' }
    const runnerAlive = Boolean(
      runnerPid && pidIsAlive(runnerPid) && runnerCommand.exitCode === 0
      && /job-runner\.ts\s+daemon(?:\s|$)/.test(runnerCommand.stdout),
    )
    if (Date.now() - startedAt >= timeoutSeconds * 1000) {
      fail(`実行中job ${counts.running}件があるため更新を停止しました`)
    }
    if (!runnerAlive) {
      output(`   queue: 停止したrunnerの実行中job ${counts.running}件を安全に回収します`)
      requireCommand(['bun', jobRunnerFile, 'recover-interrupted'], {
        env: { ...process.env, ZEROKUN_STATE_DIR: stateDir },
      })
      continue
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

export function assertSafeLocalGitConfig(
  repo: Repository,
  options: { requireTracking?: boolean } = {},
): void {
  const entries = requireCommand(
    ['git', 'config', '--local', '--no-includes', '--null', '--list'],
    { cwd: repo.path },
  ).split('\0').filter(Boolean)
  const safeCore = /^core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)$/i
  const safeRemote = /^remote\.origin\.(?:url|fetch)$/i
  const safeBranch = /^branch\..+\.(?:remote|merge)$/i
  const safeUser = /^user\.(?:name|email)$/i
  for (const entry of entries) {
    const key = entry.split(/\n|=/, 1)[0] ?? ''
    if (![safeCore, safeRemote, safeBranch, safeUser].some(pattern => pattern.test(key))) {
      fail(`${repo.label} のlocal Git configに許可されていない設定があります: ${key}`)
    }
  }
  const values = (key: string): string[] => {
    const result = command(
      ['git', 'config', '--local', '--no-includes', '--null', '--get-all', key],
      { cwd: repo.path },
    )
    if (result.exitCode === 1) return []
    if (result.exitCode !== 0) fail(`${repo.label} のlocal Git configを検証できません: ${key}`)
    return result.stdout.split('\0').filter(Boolean)
  }
  const requireOnly = (key: string, expected: string): void => {
    const actual = values(key)
    if (actual.length !== 1 || actual[0] !== expected) {
      fail(`${repo.label} のlocal Git configが安全な値ではありません: ${key}`)
    }
  }
  requireOnly('remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
  const configuredBranches = new Set<string>()
  for (const entry of entries) {
    const key = entry.split(/\n|=/, 1)[0] ?? ''
    const match = /^branch\.(.+)\.(?:remote|merge)$/i.exec(key)
    if (match) configuredBranches.add(match[1]!)
  }
  for (const branch of configuredBranches) {
    requireOnly(`branch.${branch}.remote`, 'origin')
    requireOnly(`branch.${branch}.merge`, `refs/heads/${branch}`)
  }
  const branchRemoteKey = `branch.${repo.branch}.remote`
  const branchMergeKey = `branch.${repo.branch}.merge`
  const hasTracking = values(branchRemoteKey).length > 0 || values(branchMergeKey).length > 0
  if (options.requireTracking !== false || hasTracking) {
    requireOnly(branchRemoteKey, 'origin')
    requireOnly(branchMergeKey, `refs/heads/${repo.branch}`)
  }
}

export function assertExpectedOrigin(repo: Repository): void {
  const remote = requireCommand(['git', 'remote', 'get-url', 'origin'], { cwd: repo.path })
  if (process.env.ZEROKUN_UPDATE_TESTING === '1') return
  if (remote !== 'https://github.com/zerocolored/zero.git'
    && remote !== 'https://github.com/zerocolored/zero') {
    fail(`${repo.label} のoriginは公開Codex版のHTTPS URLではありません: ${remote}`)
  }
}

function refExists(repo: Repository, ref: string): boolean {
  return command(['git', 'show-ref', '--verify', '--quiet', ref], { cwd: repo.path }).exitCode === 0
}

function isAncestor(repo: Repository, ancestor: string, descendant: string): boolean {
  return command(['git', 'merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repo.path,
  }).exitCode === 0
}

export function preflightRepositories(repositories: Repository[]): PinnedRepository[] {
  for (const repo of repositories) {
    assertSafeLocalGitConfig(repo)
    assertExpectedOrigin(repo)
    assertRepositoryClean(repo)
  }
  const originalStates = new Map(repositories.map(repo => [repo.path, {
    originalHead: requireCommand(['git', 'rev-parse', 'HEAD'], { cwd: repo.path }),
    originalBranch: requireCommand(['git', 'branch', '--show-current'], { cwd: repo.path }),
  }]))
  for (const repo of repositories) {
    output(`   fetch: ${repo.label}`)
    requireCommand([
      'git', 'fetch', '--no-tags', '--prune', 'origin',
      `+refs/heads/${repo.branch}:refs/remotes/origin/${repo.branch}`,
    ], { cwd: repo.path })
  }

  return repositories.map(repo => {
    const remoteRef = `refs/remotes/origin/${repo.branch}`
    if (!refExists(repo, remoteRef)) {
      fail(`${repo.label} に origin/${repo.branch} がありません`)
    }
    const currentBranch = requireCommand(['git', 'branch', '--show-current'], { cwd: repo.path })
    if (!currentBranch) fail(`${repo.label} はdetached HEADです`)
    if (currentBranch !== repo.branch) {
      fail(`${repo.label} は ${repo.branch} branchで更新してください（現在: ${currentBranch}）`)
    }
    const targetHead = requireCommand(['git', 'rev-parse', remoteRef], { cwd: repo.path })
    if (!isAncestor(repo, 'HEAD', targetHead)) {
      fail(`${repo.label} の ${currentBranch} は origin/${repo.branch}へ未反映です。更新せず停止しました`)
    }
    if (
      refExists(repo, `refs/heads/${repo.branch}`)
      && !isAncestor(repo, repo.branch, targetHead)
    ) {
      fail(`${repo.label} のlocal ${repo.branch}がorigin/${repo.branch}から分岐しています`)
    }
    return { ...repo, targetHead, ...originalStates.get(repo.path)! }
  })
}

export function assertPinnedRepositoryState(repo: PinnedRepository): void {
  assertRepositoryClean(repo)
  const branch = requireCommand(['git', 'branch', '--show-current'], { cwd: repo.path })
  const head = requireCommand(['git', 'rev-parse', 'HEAD'], { cwd: repo.path })
  if (branch !== repo.originalBranch || head !== repo.originalHead) {
    fail(
      `${repo.label} は候補検証中にbranchまたはHEADが変更されました。`
      + ' ユーザー作業を保持するため更新せず停止します',
    )
  }
}

export function fastForwardRepositories(repositories: PinnedRepository[]): void {
  for (const repo of repositories) {
    output(`   update: ${repo.label}`)
    if (refExists(repo, `refs/heads/${repo.branch}`)) {
      requireCommand(['git', 'switch', '--quiet', repo.branch], { cwd: repo.path })
    } else {
      requireCommand(
        ['git', 'switch', '--quiet', '--create', repo.branch, '--track', `origin/${repo.branch}`],
        { cwd: repo.path },
      )
    }
    requireCommand(['git', 'merge', '--quiet', '--ff-only', repo.targetHead], {
      cwd: repo.path,
    })
    const applied = requireCommand(['git', 'rev-parse', 'HEAD'], { cwd: repo.path })
    if (applied !== repo.targetHead) {
      fail(`${repo.label} の適用commitが検証済みSHAと一致しません`)
    }
  }
}

function journalPath(stateDir: string): string {
  return join(stateDir, 'update-transaction.json')
}

function writeJournal(stateDir: string, journal: UpdateJournal): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const path = journalPath(stateDir)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(journal, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function readJournal(
  stateDir: string,
  expected: { repoPath: string; projectDir: string; setupScript: string },
): UpdateJournal | null {
  const path = journalPath(stateDir)
  if (!existsSync(path)) return null
  const metadata = lstatSync(path)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !ownerMatches) {
    fail(`更新transaction journalが安全な通常fileではありません: ${path}`)
  }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateJournal>
  const databasePath = resolve(process.env.ZEROKUN_JOB_DB ?? join(stateDir, 'jobs.sqlite3'))
  const backupPath = typeof value.id === 'string'
    ? resolve(stateDir, 'update-rollback', value.id, 'jobs.sqlite3')
    : ''
  const databasePairIsValid = (
    (value.databasePath === null && value.databaseBackup === null)
    || (value.databasePath === databasePath && value.databaseBackup === backupPath)
  )
  if (value.version !== 1 || typeof value.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
    || !['prepared', 'fast-forwarded', 'setup-applied', 'rolling-back'].includes(value.phase ?? '')
    || value.repoPath !== expected.repoPath || typeof value.branch !== 'string'
    || !/^[0-9a-f]{40,64}$/.test(value.originalHead ?? '')
    || !/^[0-9a-f]{40,64}$/.test(value.targetHead ?? '')
    || value.projectDir !== expected.projectDir || value.setupScript !== expected.setupScript
    || typeof value.noRestart !== 'boolean' || !databasePairIsValid) {
    fail(`更新transaction journalが不正です: ${path}`)
  }
  return value as UpdateJournal
}

function snapshotDatabase(stateDir: string, id: string): {
  databasePath: string | null
  databaseBackup: string | null
} {
  const databasePath = process.env.ZEROKUN_JOB_DB ?? join(stateDir, 'jobs.sqlite3')
  if (!existsSync(databasePath)) return { databasePath: null, databaseBackup: null }
  const beforeOpen = requireSafeDatabaseSource(databasePath)
  const rollbackRoot = ensureManagedDirectory(stateDir, join(stateDir, 'update-rollback'))
  const backupDir = ensureManagedDirectory(stateDir, join(rollbackRoot, id))
  const databaseBackup = join(backupDir, 'jobs.sqlite3')
  const db = new Database(databasePath)
  try {
    const afterOpen = requireSafeDatabaseSource(databasePath)
    if (beforeOpen.dev !== afterOpen.dev || beforeOpen.ino !== afterOpen.ino) {
      fail(`SQLite database changed while opening: ${databasePath}`)
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const escaped = databaseBackup.replaceAll("'", "''")
    db.exec(`VACUUM INTO '${escaped}'`)
  } finally {
    db.close()
  }
  const metadata = lstatSync(databaseBackup)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !ownerMatches) {
    fail(`rollback DB backupが安全な通常fileではありません: ${databaseBackup}`)
  }
  chmodSync(databaseBackup, 0o600)
  return { databasePath, databaseBackup }
}

function restoreDatabase(journal: UpdateJournal): void {
  if (!journal.databasePath || !journal.databaseBackup) return
  if (!existsSync(journal.databaseBackup)) fail(`rollback DB backupがありません: ${journal.databaseBackup}`)
  const metadata = lstatSync(journal.databaseBackup)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !ownerMatches) {
    fail(`rollback DB backupが安全な通常fileではありません: ${journal.databaseBackup}`)
  }
  const temporary = `${journal.databasePath}.${process.pid}.rollback`
  rmSync(temporary, { force: true })
  copyFileSync(journal.databaseBackup, temporary)
  chmodSync(temporary, 0o600)
  rmSync(`${journal.databasePath}-wal`, { force: true })
  rmSync(`${journal.databasePath}-shm`, { force: true })
  renameSync(temporary, journal.databasePath)
}

export function clearJournal(
  stateDir: string,
  journal: UpdateJournal,
  warn: (message: string) => void = output,
): void {
  // The journal is the rollback authority, so removing it is the transaction's
  // commit point. A crash after this unlink can leave only an inert orphan
  // backup; deleting the backup first could instead leave an unrecoverable
  // journal that permanently blocks the gateway.
  rmSync(journalPath(stateDir), { force: true })
  if (!journal.databaseBackup) return
  try {
    const rollbackRoot = requireManagedDirectory(stateDir, join(stateDir, 'update-rollback'))
    const backupDir = requireManagedDirectory(stateDir, join(rollbackRoot, journal.id))
    rmSync(backupDir, { recursive: true, force: true })
  } catch (error) {
    warn(`⚠️ rollback backupの後処理を省略しました: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function validateRemoteTargets(
  repositories: PinnedRepository[],
  stateDir: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const repo of repositories) {
    const parent = mkdtempSync(join(tmpdir(), 'zerokun-update-candidate-'))
    const checkout = join(parent, 'checkout')
    const isolatedHome = join(parent, 'home')
    try {
      mkdirSync(isolatedHome, { mode: 0o700 })
      mkdirSync(join(isolatedHome, 'tmp'), { recursive: true, mode: 0o700 })
      const remote = requireCommand(['git', 'remote', 'get-url', 'origin'], { cwd: repo.path })
      requireCommand(['git', 'clone', '--quiet', '--no-local', '--no-checkout', remote, checkout])
      requireCommand(['git', 'checkout', '--quiet', '--detach', repo.targetHead], { cwd: checkout })
      await validateZero(checkout, isolatedHome, repo.path, stateDir, signal)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  }
}

async function validateZero(
  rootRepo: string,
  isolatedHome: string,
  liveRepo: string,
  stateDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const verifyScript = join(rootRepo, 'zerokun', 'verify.sh')
  if (!existsSync(verifyScript)) fail(`候補commitに公開検証scriptがありません: ${verifyScript}`)
  output('   validate: frozen install + tests + typecheck + build + shell syntax')
  const profile = `zerokun_update_${randomUUID().replaceAll('-', '')}`
  const filesystem = new Map<string, 'deny' | 'read' | 'write'>([
    [':minimal', 'read'],
    [realpathSync(homedir()), 'deny'],
    [realpathSync(liveRepo), 'deny'],
    [realpathSync(stateDir), 'deny'],
    [realpathSync(rootRepo), 'write'],
    [realpathSync(isolatedHome), 'write'],
  ])
  const filesystemToml = [...filesystem]
    .map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`)
    .join(',')
  const codexBin = process.env.ZEROKUN_CODEX_BIN ?? 'codex'
  const candidateEnvironment = buildCandidateEnvironment(isolatedHome)
  const permissionOverrides = [
    `permissions.${profile}.filesystem={${filesystemToml}}`,
    `permissions.${profile}.network.enabled=true`,
    `permissions.${profile}.network.domains={"*"="allow"}`,
    `default_permissions=${JSON.stringify(profile)}`,
    'approval_policy="never"',
    'notify=[]',
    'model_provider="openai"',
    'model_providers={}',
    'features.network_proxy=true',
    'features.apps=false',
    'features.plugins=false',
  ]
  if (process.env.ZEROKUN_UPDATE_TESTING !== '1') {
    await assertEffectiveCodexPermissionConfig(
      codexBin, rootRepo, permissionOverrides, profile, candidateEnvironment,
    )
  }
  await requireCommandAsync([
    codexBin,
    '-a', 'never',
    'sandbox',
    '-C', rootRepo,
    ...permissionOverrides.flatMap(value => ['-c', value]),
    '-P', profile,
    '--include-managed-config',
    '--',
    'bash', verifyScript,
  ], {
    cwd: rootRepo,
    inherit: true,
    signal,
    env: candidateEnvironment,
  })
}

export async function stopLockedProcess(
  lockFile: string,
  pid: number,
  label: string,
  commandPattern: RegExp,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<void> {
  if (!pidIsAlive(pid)) {
    discardProcessLock(lockFile, pid)
    return
  }
  if (!processLockOwnerMatches(lockFile, pid, commandPattern)) {
    const currentLockPid = Number(readFileSync(lockFile, 'utf8').trim())
    const command = trackedProcessCommand(pid)
    if (currentLockPid === pid && commandPattern.test(command)) {
      fail(
        `${label} PID ${pid} は期待するprocessですがlock identityを検証できません。`
        + ' 稼働processを残したまま更新を停止します',
      )
    }
    output(`   stale lock: ${label} PID ${pid} は期待するprocessではないため停止しません`)
    discardProcessLock(lockFile, pid)
    return
  }
  output(`   stop: ${label} PID ${pid}`)
  if (!processLockOwnerMatches(lockFile, pid, commandPattern)) {
    fail(`${label} PID ${pid} のidentityが停止直前に変化しました`)
  }
  process.kill(pid, 'SIGTERM')
  const startedAt = Date.now()
  while (pidIsAlive(pid)) {
    if (signal?.aborted) fail('更新を中断しました')
    if (Date.now() - startedAt >= timeoutMs) fail(`${label} PID ${pid} が正常終了しません`)
    await Bun.sleep(200)
  }
}

function trackedProcessCommand(pid: number): string {
  const result = command(['/bin/ps', '-ww', '-o', 'command=', '-p', String(pid)])
  return result.exitCode === 0 ? result.stdout : ''
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

export function assertTmuxSessionAvailableOrOwned(options: {
  tmuxPath: string
  sessionName: string
  stateDir: string
}): void {
  if (command([options.tmuxPath, 'has-session', '-t', options.sessionName]).exitCode !== 0) return
  const panes = command([
    options.tmuxPath, 'list-panes', '-t', options.sessionName, '-F', '#{pane_pid}',
  ])
  const panePids = panes.exitCode === 0
    ? panes.stdout.split(/\s+/).map(Number).filter(pid => Number.isInteger(pid) && pid > 0)
    : []
  const lockFile = join(options.stateDir, 'plugin.lock')
  const gatewayPid = readPid(lockFile)
  if (panePids.length === 1 && gatewayPid === panePids[0]
    && processLockOwnerMatches(lockFile, gatewayPid, /server\.ts(?:\s|$)/)) return
  fail(
    `tmux session ${options.sessionName} は既に存在します。`
    + ' Zero-kunの所有権を確認できないsessionを停止せず、更新を中断します',
  )
}

export async function startBotInTmux(options: {
  rootRepo: string
  stateDir?: string
  projectDir: string
  logPath: string
  sessionName?: string
  startupTimeoutMs?: number
  tmuxPath?: string
  replaceTokenFile?: string
}): Promise<number> {
  const tmux = options.tmuxPath ?? resolveTmuxPath()
  const sessionName = options.sessionName ?? 'zerokun-slack'
  const timeoutMs = Math.max(1_000, options.startupTimeoutMs ?? 10_000)
  const launcher = join(options.rootRepo, 'codex-channel.sh')
  // 稼働中gatewayの入れ替えは、更新処理が今発行したワンタイムトークンだけに許す。
  const replaceTokenFile = options.replaceTokenFile
    ?? join(resolveZeroStateDir(), 'replace-token')
  const stateDir = options.stateDir ?? dirname(replaceTokenFile)
  assertTmuxSessionAvailableOrOwned({ tmuxPath: tmux, sessionName, stateDir })
  const replaceToken = randomUUID()
  const release = command(['git', 'rev-parse', 'HEAD'], { cwd: options.rootRepo }).stdout || 'unknown'
  ensureManagedDirectory(stateDir, dirname(replaceTokenFile))
  atomicWritePrivateFile(replaceTokenFile, replaceToken)
  const launchCommand = [
    'exec /usr/bin/env ZEROKUN_REPLACE=1',
    'ZEROKUN_UPDATE_RESTART=1',
    `ZEROKUN_STATE_DIR=${shellQuote(stateDir)}`,
    `ZEROKUN_PROJECT_DIR=${shellQuote(options.projectDir)}`,
    `ZEROKUN_REPLACE_TOKEN=${shellQuote(replaceToken)}`,
    `ZEROKUN_REPLACE_TOKEN_FILE=${shellQuote(replaceTokenFile)}`,
    `ZEROKUN_RELEASE_COMMIT=${shellQuote(release)}`,
    shellQuote(launcher),
    shellQuote(options.projectDir),
  ].join(' ')

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
      [
        shellQuote(process.execPath),
        shellQuote(join(options.rootRepo, 'zerokun', 'safe-log-sink.ts')),
        shellQuote(stateDir),
        shellQuote(options.logPath),
      ].join(' '),
    ])
    const maxChecks = Math.ceil(timeoutMs / 100)
    for (let check = 0; check < maxChecks; check += 1) {
      const panePid = Number(command([
        tmux,
        'list-panes',
        '-t',
        sessionName,
        '-F',
        '#{pane_pid}',
      ]).stdout)
      if (Number.isInteger(panePid) && panePid > 0) {
        atomicWritePrivateFile(
          join(stateDir, 'tmux-session.json'),
          JSON.stringify({ version: 1, name: sessionName, panePid, release }) + '\n',
        )
        return panePid
      }
      await Bun.sleep(100)
    }
    fail(`Codex版gatewayのtmux sessionを${timeoutMs / 1_000}秒以内に確認できませんでした`)
  } catch (error) {
    command([tmux, 'kill-session', '-t', sessionName])
    throw error
  }
}

async function stopServices(
  stateDir: string,
  signal?: AbortSignal,
): Promise<void> {
  ensureManagedDirectory(stateDir, join(stateDir, 'job-runner.lock'))
  const runnerLock = join(stateDir, 'job-runner.lock', 'pid')
  const runnerPid = readPid(runnerLock)
  if (runnerPid) {
    await stopLockedProcess(runnerLock, runnerPid, 'job runner', /job-runner\.ts\s+daemon(?:\s|$)/, signal)
  }

  const bridgeLock = join(stateDir, 'plugin.lock')
  const bridgePid = readPid(bridgeLock)
  if (bridgePid) await stopLockedProcess(bridgeLock, bridgePid, 'Slack gateway', /server\.ts(?:\s|$)/, signal)
}

async function restartServices(
  rootRepo: string,
  stateDir: string,
  projectDir: string,
  signal?: AbortSignal,
): Promise<void> {
  await stopServices(stateDir, signal)

  if (signal?.aborted) fail('更新を中断しました')
  const logPath = join(stateDir, 'zerokun.log')
  const sessionBase = (process.env.ZEROKUN_TMUX_SESSION ?? 'zerokun-slack')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80) || 'zerokun-slack'
  const sessionName = `${sessionBase}-${randomUUID().slice(0, 8)}`
  const panePid = await startBotInTmux({
    rootRepo,
    stateDir,
    projectDir,
    logPath,
    replaceTokenFile: join(stateDir, 'replace-token'),
    sessionName,
  })
  output(`   terminal: tmux attach -t ${sessionName} (pane PID ${panePid})`)

  await waitForStableHealth({
    requiredConsecutive: Number(process.env.ZEROKUN_HEALTH_CONSECUTIVE ?? 10),
    maxChecks: Number(process.env.ZEROKUN_HEALTH_MAX_CHECKS ?? 60),
    sleep: () => Bun.sleep(Number(process.env.ZEROKUN_HEALTH_SLEEP_MS ?? 500)),
    observe: () => {
      const newRunnerPid = readPid(join(stateDir, 'job-runner.lock', 'pid'))
      const newBridgePid = readPid(join(stateDir, 'plugin.lock'))
      const readiness = readGatewayReadiness(join(stateDir, 'gateway-ready.json'))
      const expectedRelease = command(['git', 'rev-parse', 'HEAD'], { cwd: rootRepo }).stdout
      return Boolean(newRunnerPid && processLockOwnerMatches(
        join(stateDir, 'job-runner.lock', 'pid'), newRunnerPid, /job-runner\.ts\s+daemon(?:\s|$)/,
      )) && Boolean(newBridgePid && processLockOwnerMatches(
        join(stateDir, 'plugin.lock'), newBridgePid, /server\.ts(?:\s|$)/,
      )) && Boolean(readiness && readiness.pid === newBridgePid
        && readiness.release === expectedRelease)
    },
  }).catch(error => {
    fail(`${error instanceof Error ? error.message : String(error)}。ログ: ${logPath}`)
  })
  const newRunnerPid = readPid(join(stateDir, 'job-runner.lock', 'pid'))
  const newBridgePid = readPid(join(stateDir, 'plugin.lock'))
  output(`   start: Slack gateway PID ${newBridgePid} + Codex job runner PID ${newRunnerPid}`)
}

async function rollbackUpdate(
  stateDir: string,
  journal: UpdateJournal,
  options: { restart: boolean; testing: boolean },
): Promise<void> {
  if (realpathSync(journal.repoPath) !== journal.repoPath) {
    fail(`rollback repository pathがcanonicalではありません: ${journal.repoPath}`)
  }
  const assertRollbackState = () => {
    const currentBranch = requireCommand(['git', 'branch', '--show-current'], {
      cwd: journal.repoPath,
    })
    if (currentBranch !== journal.branch) {
      fail(
        `rollback前にbranchが変更されています (${currentBranch || 'detached HEAD'})。`
        + ` ${journal.branch} へ戻してから再実行してください`,
      )
    }
    const currentHead = requireCommand(['git', 'rev-parse', 'HEAD'], { cwd: journal.repoPath })
    if (currentHead !== journal.originalHead && currentHead !== journal.targetHead) {
      fail(
        `rollback開始後に別commitが作成されています (${currentHead.slice(0, 12)})。`
        + ' 未完了journalを保持したまま停止します',
      )
    }
    const dirty = requireCommand(['git', 'status', '--porcelain'], { cwd: journal.repoPath })
    if (dirty) {
      fail(
        'rollback開始後に未コミット変更が作成されています。'
        + ' ユーザー作業を保持するため自動resetせず、未完了journalを残します',
      )
    }
  }
  assertRollbackState()
  writeJournal(stateDir, { ...journal, phase: 'rolling-back' })
  output(`▶ 更新を ${journal.originalHead.slice(0, 12)} へロールバック`)
  await stopServices(stateDir)
  assertRollbackState()
  requireCommand(['git', 'reset', '--hard', journal.originalHead], { cwd: journal.repoPath })
  restoreDatabase(journal)
  await requireCommandAsync(['bash', journal.setupScript], {
    cwd: journal.repoPath,
    inherit: !options.testing,
    env: {
      ...buildUpdaterEnvironment(),
      ZEROKUN_STATE_DIR: stateDir,
      ZEROKUN_UPDATE_IN_PROGRESS: '1',
    },
  })
  if (options.restart) {
    await restartServices(journal.repoPath, stateDir, journal.projectDir)
  }
  clearJournal(stateDir, journal)
  output('✅ 旧Codex版へのロールバック完了')
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const testing = process.env.ZEROKUN_UPDATE_TESTING === '1'
  const skipTests = args.has('--skip-tests')
  const noRestart = args.has('--no-restart')
  const recoverOnly = args.has('--recover-only')
  if (skipTests && !testing) fail('--skip-tests はテスト環境でのみ使用できます')
  if (noRestart && !testing) fail('--no-restart はテスト環境でのみ使用できます')
  const unknown = [...args].filter(arg => ![
    '--skip-tests', '--no-restart', '--recover-only',
  ].includes(arg))
  if (unknown.length > 0) fail(`不明なオプション: ${unknown.join(', ')}`)

  const rootRepo = resolveRootRepo()
  const stateDir = resolveZeroStateDir()
  const projectDir = process.env.ZEROKUN_PROJECT_DIR
    ?? rootRepo
  const setupScript = process.env.ZEROKUN_SETUP_SCRIPT ?? join(rootRepo, 'zerokun', 'setup.sh')
  const waitSeconds = Number(process.env.ZEROKUN_UPDATE_WAIT_SECONDS ?? 21_600)
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) fail('ZEROKUN_UPDATE_WAIT_SECONDSが不正です')
  if (!existsSync(projectDir)) fail(`作業ディレクトリがありません: ${projectDir}`)
  if (!existsSync(setupScript)) fail(`setup.shがありません: ${setupScript}`)

  const branch = process.env.ZEROKUN_UPDATE_BRANCH ?? 'codex'
  const repositories: Repository[] = [{ label: 'zero-codex', path: rootRepo, branch }]

  const updateLock = acquireUpdateLock(stateDir)
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  const throwIfInterrupted = () => {
    if (controller.signal.aborted) fail('更新を中断しました')
  }
  const cleanup = () => updateLock.release()
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    output('▶ zerokun-update')
    const interrupted = readJournal(stateDir, { repoPath: rootRepo, projectDir, setupScript })
    if (interrupted) {
      if (realpathSync(interrupted.repoPath) !== rootRepo) {
        fail(`別repositoryの未完了更新があります: ${interrupted.repoPath}`)
      }
      await rollbackUpdate(stateDir, interrupted, {
        restart: !recoverOnly && !interrupted.noRestart,
        testing,
      })
      output('   未完了だった更新transactionを復旧しました')
      if (!recoverOnly) {
        fail(
          '未完了だった更新を旧Codex版へロールバックしました。'
          + '今回の更新は適用されていないため、状態を確認してから新しい更新依頼を送ってください',
        )
      }
      return
    }
    if (recoverOnly) {
      output('   未完了の更新transactionはありません')
      return
    }
    await waitForRunningJobs(
      stateDir,
      waitSeconds,
      process.env.ZEROKUN_JOB_RUNNER ?? join(rootRepo, 'zerokun', 'job-runner.ts'),
      controller.signal,
    )
    throwIfInterrupted()
    output(`▶ Codex版リポを事前検査 (${branch})`)
    const pinnedRepositories = preflightRepositories(repositories)
    throwIfInterrupted()
    if (!skipTests) {
      output('▶ 候補commitを一時worktreeで検証')
      await validateRemoteTargets(pinnedRepositories, stateDir, controller.signal)
    }
    throwIfInterrupted()
    for (const repo of pinnedRepositories) assertPinnedRepositoryState(repo)
    // The updater lock has remained held since the first drain. A runner that
    // observed the pre-lock state immediately before claiming is therefore
    // either visible as running here or has already finished. Once this second
    // drain returns, the runner's post-claim barrier check prevents new work.
    await waitForRunningJobs(
      stateDir,
      waitSeconds,
      process.env.ZEROKUN_JOB_RUNNER ?? join(rootRepo, 'zerokun', 'job-runner.ts'),
      controller.signal,
    )
    throwIfInterrupted()
    const transactionId = randomUUID()
    let journal: UpdateJournal = {
      version: 1,
      id: transactionId,
      phase: 'prepared',
      repoPath: rootRepo,
      branch,
      originalHead: pinnedRepositories[0]!.originalHead,
      targetHead: pinnedRepositories[0]!.targetHead,
      projectDir,
      setupScript,
      databasePath: null,
      databaseBackup: null,
      noRestart,
    }
    writeJournal(stateDir, journal)
    try {
      output('▶ gatewayとrunnerを停止してrollback snapshotを作成')
      await stopServices(stateDir, controller.signal)
      for (const repo of pinnedRepositories) assertPinnedRepositoryState(repo)
      journal = { ...journal, ...snapshotDatabase(stateDir, transactionId) }
      writeJournal(stateDir, journal)
      throwIfInterrupted()
      output(`▶ origin/${branch}へfast-forward`)
      fastForwardRepositories(pinnedRepositories)
      journal = { ...journal, phase: 'fast-forwarded' }
      writeJournal(stateDir, journal)
      throwIfInterrupted()
      output('▶ setupを反映')
      await requireCommandAsync(['bash', setupScript], {
        cwd: rootRepo,
        inherit: !testing,
        env: {
          ...buildUpdaterEnvironment(),
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_UPDATE_IN_PROGRESS: '1',
        },
        signal: controller.signal,
      })
      assertRepositoryClean(repositories[0]!)
      journal = { ...journal, phase: 'setup-applied' }
      writeJournal(stateDir, journal)
      throwIfInterrupted()
      if (!noRestart) {
        output('▶ ゼロくんとjob runnerを再起動')
        await restartServices(rootRepo, stateDir, projectDir, controller.signal)
      }
      clearJournal(stateDir, journal)
      output(noRestart
        ? '✅ Codex版更新・setup完了（テスト用 --no-restart）'
        : '✅ Codex版更新・検証・再起動完了')
    } catch (error) {
      const original = error instanceof Error ? error.message : String(error)
      try {
        await rollbackUpdate(stateDir, journal, { restart: !noRestart, testing })
      } catch (rollbackError) {
        const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        fail(`更新失敗: ${original}\nロールバックも失敗: ${rollback}`)
      }
      fail(`更新失敗: ${original}\n旧Codex版へ自動ロールバックしました`)
    }
  } finally {
    cleanup()
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`❌ ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
