import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  activeJobCounts,
  activeJobCountsFromDatabase,
  assertPinnedRepositoryState,
  clearJournal,
  copySecureExecutableForTesting,
  createUpdaterTemporaryDirectory,
  fastForwardRepositories,
  nativeExecutableHeaderSupported,
  preflightRepositories,
  processGroupCleanupIsUncertain,
  processStateIsAlive,
  resolveSetupTimeoutMs,
  resolveUpdaterCodexBinary,
  setupTimeoutBudgetMs,
  stageVerifiedCandidateCodex,
  restoreRollbackDatabase,
  startBotInTmux,
  stopLockedProcess,
  waitForStableHealth,
  withUpdateTestPolicy,
  updaterTrustedToolPath,
} from './update.ts'
import { tryAcquireProcessLock } from './process-lock.ts'
import {
  captureTrackedProcesses,
  readProcessIdentity,
  reapTrackedProcesses,
  type ProcessIdentity,
} from './process-tree.ts'
import { signalProcessIfLive } from './process-generation.ts'
import { resolveOfficialStandaloneCodex } from './standalone-codex.ts'

const directories: string[] = []
const tmuxSessions: string[] = []
const serviceIdentities: ProcessIdentity[] = []

afterEach(() => {
  for (const session of tmuxSessions.splice(0)) Bun.spawnSync(['tmux', 'kill-session', '-t', session])
  for (const identity of serviceIdentities.splice(0)) signalProcessIfLive(identity, 'SIGKILL')
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zerokun-update-codex-'))
  directories.push(dir)
  return dir
}

function snapshotFixtureGroup(groupId: number): Map<number, string> {
  const tracked = new Map<number, string>()
  captureTrackedProcesses([groupId], groupId, tracked)
  return tracked
}

async function stopFixtureGroup(groupId: number, tracked: Map<number, string>): Promise<void> {
  const remaining = await reapTrackedProcesses({
    rootPids: [],
    groupId,
    tracked,
    signalGroup: false,
    termGraceMs: 50,
    killWaitMs: 2_000,
  })
  if (remaining.length > 0) throw new Error(`test process group cleanup failed: ${remaining.join(', ')}`)
}

function must(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function installedNativeCodex(): string {
  return resolveOfficialStandaloneCodex().physical
}

function makeRepo(base: string) {
  const bare = join(base, 'remote.git')
  const seed = join(base, 'seed')
  const local = join(base, 'zero')
  must(['git', 'init', '--bare', '--initial-branch=codex', bare])
  must(['git', 'init', '--initial-branch=codex', seed])
  must(['git', 'config', 'user.email', 'test@example.com'], seed)
  must(['git', 'config', 'user.name', 'test'], seed)
  mkdirSync(join(seed, 'zerokun'))
  const lockSource = [
    "import { mkdirSync, writeFileSync } from 'fs'",
    "import { dirname } from 'path'",
    'export function acquire(path: string) {',
    '  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })',
    "  const ps = Bun.spawnSync(['/bin/ps', '-o', 'lstart=', '-p', String(process.pid)], { stdout: 'pipe' })",
    "  const started = ps.stdout.toString().trim()",
    "  writeFileSync(path, `${process.pid}\\n`, { mode: 0o600 })",
    "  writeFileSync(`${path}.identity`, `${JSON.stringify({ pid: process.pid, started, nonce: '12345678-1234-4123-8123-123456789abc' })}\\n`, { mode: 0o600 })",
    '}',
    '',
  ].join('\n')
  writeFileSync(join(seed, 'zerokun', 'fixture-lock.ts'), lockSource)
  writeFileSync(join(seed, 'zerokun', 'job-runner.ts'), [
    "import { writeFileSync } from 'fs'",
    "import { join } from 'path'",
    "import { acquire } from './fixture-lock.ts'",
    'const state = process.env.ZEROKUN_STATE_DIR!',
    "acquire(join(state, 'job-runner.lock', 'pid'))",
    "writeFileSync(join(state, 'job-runner.lock', 'runtime'), 'zerokun-codex-runner-v1\\n')",
    "process.on('SIGTERM', () => process.exit(0))",
    'await Bun.sleep(60_000)',
    '',
  ].join('\n'))
  writeFileSync(join(seed, 'server.ts'), [
    "import { writeFileSync } from 'fs'",
    "import { join } from 'path'",
    "import { acquire } from './zerokun/fixture-lock.ts'",
    'const state = process.env.ZEROKUN_STATE_DIR!',
    "acquire(join(state, 'plugin.lock'))",
    "writeFileSync(join(state, 'gateway-ready.json'), JSON.stringify({ runtime: 'codex', pid: process.pid, release: process.env.ZEROKUN_RELEASE_COMMIT, connectedAt: Date.now() }))",
    "process.on('SIGTERM', () => process.exit(0))",
    'await Bun.sleep(60_000)',
    '',
  ].join('\n'))
  writeFileSync(join(seed, 'codex-channel.sh'), [
    '#!/bin/bash',
    'set -e',
    'root="$(cd "$(dirname "$0")" && pwd)"',
    'bun "$root/zerokun/job-runner.ts" daemon >/dev/null 2>&1 &',
    'exec bun "$root/server.ts"',
    '',
  ].join('\n'), { mode: 0o700 })
  writeFileSync(join(seed, 'version.txt'), 'v1\n')
  must(['git', 'add', '.'], seed)
  must(['git', 'commit', '-m', 'v1'], seed)
  must(['git', 'remote', 'add', 'origin', bare], seed)
  must(['git', 'push', '-u', 'origin', 'codex'], seed)
  must(['git', 'clone', '--branch', 'codex', bare, local])
  writeFileSync(join(seed, 'version.txt'), 'v2\n')
  must(['git', 'add', '.'], seed)
  must(['git', 'commit', '-m', 'v2'], seed)
  must(['git', 'push', 'origin', 'codex'], seed)
  return { bare, seed, local }
}

function updaterFixture() {
  const base = fixtureDir()
  const repo = makeRepo(base)
  const state = join(base, 'state')
  const project = join(base, 'project')
  const setup = join(base, 'setup.sh')
  const setupMarker = join(base, 'setup-ran')
  mkdirSync(state)
  mkdirSync(project)
  writeFileSync(setup, [
    '#!/bin/bash',
    '[ -z "${ZEROKUN_CODEX_BIN+x}" ] || { echo "updater-only Codex override leaked" >&2; exit 79; }',
    `touch ${JSON.stringify(setupMarker)}`,
    '',
  ].join('\n'))
  chmodSync(setup, 0o700)
  return { base, repo, state, project, setup, setupMarker }
}

function updaterEnvironment(fixture: ReturnType<typeof updaterFixture>) {
  const safeCodex = join(fixture.base, 'safe-codex')
  if (!existsSync(safeCodex)) {
    copyFileSync(installedNativeCodex(), safeCodex)
    chmodSync(safeCodex, 0o700)
  }
  return {
    ...process.env,
    ZEROKUN_REPO_DIR: fixture.repo.local,
    ZEROKUN_STATE_DIR: fixture.state,
    ZEROKUN_PROJECT_DIR: fixture.project,
    ZEROKUN_SETUP_SCRIPT: fixture.setup,
    ZEROKUN_UPDATE_BRANCH: 'codex',
    ZEROKUN_CODEX_BIN: safeCodex,
  }
}

function serviceUpdaterEnvironment(fixture: ReturnType<typeof updaterFixture>, session: string) {
  return {
    ...updaterEnvironment(fixture),
    ZEROKUN_TMUX_SESSION: session,
    ZEROKUN_HEALTH_CONSECUTIVE: '2',
    ZEROKUN_HEALTH_MAX_CHECKS: '30',
    ZEROKUN_HEALTH_SLEEP_MS: '100',
  }
}

function rememberFixtureServices(state: string): void {
  try {
    const marker = JSON.parse(readFileSync(join(state, 'tmux-session.json'), 'utf8')) as { name?: unknown }
    if (typeof marker.name === 'string') tmuxSessions.push(marker.name)
  } catch {}
  for (const path of [join(state, 'plugin.lock'), join(state, 'job-runner.lock', 'pid')]) {
    try {
      const pid = Number(readFileSync(path, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) {
        const identity = readProcessIdentity(pid)
        if (identity) serviceIdentities.push(identity)
      }
    } catch {}
  }
}

function runUpdater(
  fixture: ReturnType<typeof updaterFixture>,
  args = ['--skip-tests', '--no-restart'],
  environment = updaterEnvironment(fixture),
) {
  const entry = [
    `import { runUpdateForTests } from ${JSON.stringify(join(import.meta.dir, 'update.ts'))}`,
    'await runUpdateForTests()',
  ].join('; ')
  return Bun.spawnSync([process.execPath, '--no-env-file', '-e', entry, '--', ...args], {
    cwd: fixture.repo.local,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

function spawnUpdater(
  fixture: ReturnType<typeof updaterFixture>,
  args: string[],
  environment = updaterEnvironment(fixture),
) {
  const entry = [
    `import { runUpdateForTests } from ${JSON.stringify(join(import.meta.dir, 'update.ts'))}`,
    'await runUpdateForTests()',
  ].join('; ')
  return Bun.spawn([process.execPath, '--no-env-file', '-e', entry, '--', ...args], {
    cwd: fixture.repo.local,
    env: environment,
    stdout: 'pipe', stderr: 'pipe',
  })
}

function runStandaloneSetup(
  fixture: ReturnType<typeof updaterFixture>,
  environment = updaterEnvironment(fixture),
) {
  const entry = [
    `import { runStandaloneSetupForTests } from ${JSON.stringify(join(import.meta.dir, 'update.ts'))}`,
    'await runStandaloneSetupForTests()',
  ].join('; ')
  return Bun.spawnSync([process.execPath, '--no-env-file', '-e', entry], {
    cwd: fixture.repo.local,
    env: environment,
    stdout: 'pipe', stderr: 'pipe',
  })
}

function spawnStandaloneSetup(
  fixture: ReturnType<typeof updaterFixture>,
  environment = updaterEnvironment(fixture),
) {
  const entry = [
    `import { runStandaloneSetupForTests } from ${JSON.stringify(join(import.meta.dir, 'update.ts'))}`,
    'await runStandaloneSetupForTests()',
  ].join('; ')
  return Bun.spawn([process.execPath, '--no-env-file', '-e', entry], {
    cwd: fixture.repo.local,
    env: environment,
    stdout: 'pipe', stderr: 'pipe',
  })
}

describe('updater helpers', () => {
  test('security-sensitive stagingはcaller TMPDIRを無視してroot-owned sticky parentを使う', () => {
    const hostile = fixtureDir()
    chmodSync(hostile, 0o777)
    const previous = process.env.TMPDIR
    process.env.TMPDIR = hostile
    let staged = ''
    try {
      staged = createUpdaterTemporaryDirectory('zerokun-test-stage-')
      expect(staged.startsWith(`${realpathSync(hostile)}/`)).toBe(false)
      expect(lstatSync(staged).mode & 0o777).toBe(0o700)
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
      if (staged) rmSync(staged, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'darwin')(
    'version確認済みstaged Codexは元path差替え後も同じcopyを実行する', () => {
    const root = fixtureDir()
    const original = join(root, 'codex')
    copyFileSync(installedNativeCodex(), original)
    chmodSync(original, 0o700)
    const staged = stageVerifiedCandidateCodex(root, original, { HOME: root })
    try {
      const before = Bun.spawnSync([staged.executable, '--version'], {
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(before.exitCode).toBe(0)
      writeFileSync(original, [
        '#!/bin/sh',
        'echo replaced',
        '',
      ].join('\n'), { mode: 0o700 })
      const result = Bun.spawnSync([staged.executable, '--version'], {
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString().trim()).toBe(before.stdout.toString().trim())
      expect(staged.executable).not.toBe(realpathSync(original))
    } finally {
      chmodSync(staged.directory, 0o700)
    }
  })

  test('実行file検証後のancestor相当swapをopened FD検査で拒否する', () => {
    const root = fixtureDir()
    const candidate = join(root, 'codex')
    const original = join(root, 'codex-original')
    const replacement = join(root, 'codex-replacement')
    const staged = join(root, 'staged-codex')
    writeFileSync(candidate, '#!/bin/sh\necho safe\n', { mode: 0o700 })
    writeFileSync(replacement, '#!/bin/sh\necho malicious\n', { mode: 0o777 })
    chmodSync(replacement, 0o777)
    expect(() => copySecureExecutableForTesting(candidate, staged, () => {
      renameSync(candidate, original)
      renameSync(replacement, candidate)
    })).toThrow('検証中に変化')
    expect(existsSync(staged)).toBe(false)
  })

  test('standalone Codexを絶対pathへ固定しcandidate PATHでも解決できる', () => {
    const home = fixtureDir()
    const bin = join(home, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    const codex = join(bin, 'codex')
    writeFileSync(codex, '#!/bin/sh\necho "codex-cli 0.149.0"\n', { mode: 0o755 })
    const resolved = resolveUpdaterCodexBinary(
      { HOME: home, PATH: '/usr/bin:/bin' }, process.execPath, true,
    )
    expect(resolved).toBe(realpathSync(codex))
    const trusted = join(home, 'trusted-bin')
    expect(updaterTrustedToolPath(trusted).split(':')[0]).toBe(trusted)
  })

  test('shell trampolineをnative Codexとしてstagingしない', () => {
    const root = fixtureDir()
    const wrapper = join(root, 'codex')
    writeFileSync(wrapper, '#!/bin/sh\nexec /opt/homebrew/bin/codex "$@"\n', { mode: 0o700 })
    expect(nativeExecutableHeaderSupported(Buffer.from('#!/b'), 'darwin')).toBe(false)
    expect(nativeExecutableHeaderSupported(
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]), 'darwin', 'arm64',
    ))
      .toBe(true)
    expect(nativeExecutableHeaderSupported(
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0, 0, 1]), 'darwin', 'arm64',
    )).toBe(false)
    expect(() => resolveUpdaterCodexBinary({ ZEROKUN_CODEX_BIN: wrapper }))
      .toThrow('native binary')
  })

  test('standalone Codexを古いBun隣接版より優先し、最低version未満は採用しない', () => {
    const root = fixtureDir()
    const homeBin = join(root, 'home', '.local', 'bin')
    const runtimeBin = join(root, 'runtime')
    mkdirSync(homeBin, { recursive: true })
    mkdirSync(runtimeBin)
    const standalone = join(homeBin, 'codex')
    const adjacent = join(runtimeBin, 'codex')
    writeFileSync(standalone, '#!/bin/sh\necho "codex-cli 0.149.0"\n', { mode: 0o755 })
    writeFileSync(adjacent, '#!/bin/sh\necho "codex-cli 0.148.0"\n', { mode: 0o755 })
    expect(resolveUpdaterCodexBinary(
      { HOME: join(root, 'home') }, join(runtimeBin, 'bun'), true,
    )).toBe(realpathSync(standalone))

    writeFileSync(standalone, '#!/bin/sh\necho "codex-cli 0.148.9"\n', { mode: 0o755 })
    writeFileSync(adjacent, '#!/bin/sh\necho "codex-cli 0.150.0"\n', { mode: 0o755 })
    expect(resolveUpdaterCodexBinary(
      { HOME: join(root, 'home') }, join(runtimeBin, 'bun'), true,
    )).toBe(realpathSync(adjacent))
  })

  test.skipIf(process.platform !== 'darwin')('standalone Codex実体を候補sandboxで読取専用実行できる', () => {
    const fixture = updaterFixture()
    const standaloneHome = join(fixture.base, 'standalone-home')
    const standaloneBin = join(standaloneHome, '.local', 'bin')
    mkdirSync(standaloneBin, { recursive: true })
    const standaloneCodex = join(standaloneBin, 'codex')
    copyFileSync(installedNativeCodex(), standaloneCodex)
    chmodSync(standaloneCodex, 0o700)

    const verifyDir = join(fixture.repo.seed, 'zerokun')
    writeFileSync(join(verifyDir, 'verify.sh'), [
      '#!/bin/bash',
      'set -euo pipefail',
      'test "${ZERO_CODEX_CANDIDATE_SANDBOX:-}" = 1',
      'codex --version | grep -E "[0-9]+\\.[0-9]+\\.[0-9]+" >/dev/null',
      'bun --version >/dev/null',
      '',
    ].join('\n'))
    must(['git', 'add', '.'], fixture.repo.seed)
    must(['git', 'commit', '-m', 'standalone candidate verification'], fixture.repo.seed)
    must(['git', 'push', 'origin', 'codex'], fixture.repo.seed)

    const environment = {
      ...updaterEnvironment(fixture),
      HOME: standaloneHome,
      PATH: `${standaloneBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    }
    delete environment.ZEROKUN_CODEX_BIN
    const result = runUpdater(fixture, ['--no-restart'], environment)
    expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0)
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v2\n')
  }, 30_000)

  test('updaterのcustom Codexは相対pathやgroup/world writable実体を拒否する', () => {
    expect(() => resolveUpdaterCodexBinary({ ZEROKUN_CODEX_BIN: 'codex-custom' }))
      .toThrow('絶対path')
    const dir = fixtureDir()
    const unsafe = join(dir, 'codex')
    writeFileSync(unsafe, '#!/bin/sh\nexit 0\n', { mode: 0o777 })
    chmodSync(unsafe, 0o777)
    expect(() => resolveUpdaterCodexBinary({ ZEROKUN_CODEX_BIN: unsafe }))
      .toThrow('安全なCodex CLI')

    const unsafeParent = join(dir, 'group-writable')
    mkdirSync(unsafeParent, { mode: 0o770 })
    chmodSync(unsafeParent, 0o770)
    const nested = join(unsafeParent, 'codex')
    writeFileSync(nested, '#!/bin/sh\necho "codex-cli 0.149.0"\n', { mode: 0o700 })
    expect(() => resolveUpdaterCodexBinary({ ZEROKUN_CODEX_BIN: nested }))
      .toThrow('安全なCodex CLI')

    const hardlink = join(dir, 'codex-hardlink')
    linkSync(nested, hardlink)
    expect(() => resolveUpdaterCodexBinary({ ZEROKUN_CODEX_BIN: hardlink }))
      .toThrow('安全なCodex CLI')
    expect(readFileSync(join(import.meta.dir, 'update.ts'), 'utf8')).not.toContain('trustedHomebrew')
  })

  test('本番entrypointはテスト専用の検証・再起動省略flagを拒否する', () => {
    for (const flag of ['--skip-tests', '--no-restart']) {
      const result = Bun.spawnSync([
        process.execPath,
        '--no-env-file',
        join(import.meta.dir, 'update.ts'),
        flag,
      ], {
        env: { PATH: '/usr/bin:/bin', HOME: fixtureDir() },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain(`${flag} はテスト環境でのみ使用できます`)
    }
  })

  test('candidate sandboxはpreflightと同じrandom named permissionをdefaultにする', () => {
    const source = readFileSync(join(import.meta.dir, 'update.ts'), 'utf8')
    const candidate = source.slice(source.indexOf('async function validateZero('), source.indexOf('export async function stopLockedProcess('))
    expect(candidate).toContain('`default_permissions=${JSON.stringify(profile)}`')
    expect(candidate).toContain("'-P', profile")
    expect(candidate).toContain("'--include-managed-config'")
    expect(candidate.indexOf('requireEffectiveCodexPermissionPreflight('))
      .toBeLessThan(candidate.indexOf("'sandbox'"))
    expect(candidate).toContain('const stagedCodexBin = stagedCodex.executable')
    expect(candidate).toContain('requireEffectiveCodexPermissionPreflight(\n      stagedCodexBin,')
    expect(candidate).toContain('await requireCommandAsync([\n    stagedCodexBin,')
  })

  test('rollback用SQLite snapshotをsidecarごと原子的に復元する', () => {
    const dir = fixtureDir()
    const databasePath = join(dir, 'jobs.sqlite3')
    const databaseBackup = join(dir, 'jobs.sqlite3.backup')
    let database = new Database(databaseBackup, { create: true })
    database.exec('CREATE TABLE marker (value TEXT NOT NULL)')
    database.run('INSERT INTO marker (value) VALUES (?)', ['before-update'])
    database.close()
    database = new Database(databasePath, { create: true })
    database.exec('CREATE TABLE marker (value TEXT NOT NULL)')
    database.run('INSERT INTO marker (value) VALUES (?)', ['candidate'])
    database.close()
    writeFileSync(`${databasePath}-wal`, 'stale-wal')
    writeFileSync(`${databasePath}-shm`, 'stale-shm')

    restoreRollbackDatabase({ databasePath, databaseBackup })

    const restored = new Database(databasePath)
    expect(restored.query<{ value: string }, []>('SELECT value FROM marker').get()?.value)
      .toBe('before-update')
    restored.close()
    expect(existsSync(`${databasePath}-wal`)).toBe(false)
    expect(existsSync(`${databasePath}-shm`)).toBe(false)
  })

  test('rollbackはGitを戻してからSQLiteを復元し旧setupを実行する', () => {
    const source = readFileSync(join(import.meta.dir, 'update.ts'), 'utf8')
    const rollback = source.slice(
      source.indexOf('async function rollbackUpdate('),
      source.indexOf('async function main('),
    )
    const gitReset = rollback.indexOf("['git', 'reset', '--hard', journal.originalHead]")
    const databaseRestore = rollback.indexOf('restoreRollbackDatabase(journal)')
    const legacySetup = rollback.indexOf('requireSetupCommandAsync(journal.setupScript')
    const exclusiveBarrier = rollback.indexOf('options.updateLock.assertExclusive()')
    expect(exclusiveBarrier).toBeGreaterThanOrEqual(0)
    expect(gitReset).toBeGreaterThan(exclusiveBarrier)
    expect(gitReset).toBeGreaterThanOrEqual(0)
    expect(databaseRestore).toBeGreaterThan(gitReset)
    expect(legacySetup).toBeGreaterThan(databaseRestore)
  })

  test('setupは依存導入やproject初期化より前にupdate lockへ参加する', () => {
    const setup = readFileSync(join(import.meta.dir, 'setup.sh'), 'utf8')
    const standaloneMode = setup.indexOf('if [ "${ZEROKUN_UPDATE_IN_PROGRESS:-0}" = "0" ]; then')
    const supervisor = setup.indexOf('"$REPO_DIR/zerokun/update.ts" --setup-supervisor')
    const updateMode = setup.indexOf('if [ "${ZEROKUN_UPDATE_IN_PROGRESS:-0}" = "1" ]; then')
    const delegateActive = setup.indexOf('delegate-active "$SETUP_LOCK/pid" "$$"')
    const requireRoot = setup.indexOf('require-root "$CH"')
    const requireLockDirectory = setup.indexOf('require-directories "$CH" "$SETUP_LOCK"')
    const legacyUpdaterFailure = setup.lastIndexOf('Codex版のoffline bootstrapを実行してください')
    const prepareState = setup.indexOf('prepare-root "$CH"')
    const inheritedPreflight = setup.indexOf('verify-system-config --inherit-process-group')
    const installDependencies = setup.indexOf('install --frozen-lockfile')
    const createProject = setup.indexOf('mkdir -p "$PROJECT_DIR"')

    expect(standaloneMode).toBeGreaterThanOrEqual(0)
    expect(supervisor).toBeGreaterThan(standaloneMode)
    expect(updateMode).toBeGreaterThanOrEqual(0)
    expect(requireRoot).toBeGreaterThan(updateMode)
    expect(requireLockDirectory).toBeGreaterThan(requireRoot)
    expect(delegateActive).toBeGreaterThan(requireLockDirectory)
    expect(delegateActive).toBeGreaterThan(updateMode)
    expect(legacyUpdaterFailure).toBeGreaterThan(delegateActive)
    expect(prepareState).toBeGreaterThan(legacyUpdaterFailure)
    expect(inheritedPreflight).toBeGreaterThan(prepareState)
    expect(installDependencies).toBeGreaterThan(inheritedPreflight)
    expect(createProject).toBeGreaterThan(inheritedPreflight)
    expect(setup).not.toContain('acquire "$SETUP_LOCK/pid" "$$"')
    expect(setup).not.toContain('SETUP_OWNS_LOCK')
    expect(setup).not.toContain('delegate-parent')
  })

  test('旧updaterからのsetupはstate作成より前にoffline bootstrapを案内して停止する', () => {
    const root = fixtureDir()
    const home = join(root, 'home')
    const state = join(root, 'state-not-created')
    mkdirSync(home)
    const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        ZEROKUN_STATE_DIR: state,
        ZEROKUN_UPDATE_IN_PROGRESS: '1',
        ZEROKUN_LEGACY_CUTOVER: '0',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('Codex版のoffline bootstrap')
    expect(existsSync(state)).toBe(false)
  })

  test('setupはupdate.lock symlinkをdelegate-active前に拒否しstate外へ書かない', () => {
    const root = fixtureDir()
    const home = join(root, 'home')
    const state = join(root, 'state')
    const external = join(root, 'external-lock')
    mkdirSync(home)
    mkdirSync(state, { mode: 0o700 })
    mkdirSync(external)
    symlinkSync(external, join(state, 'update.lock'))
    const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        ZEROKUN_STATE_DIR: state,
        ZEROKUN_UPDATE_IN_PROGRESS: '1',
        ZEROKUN_LEGACY_CUTOVER: '0',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('lock directoryが安全ではありません')
    expect(readdirSync(external)).toEqual([])
  })

  test('standalone supervisorは未完了journalを越えてsetupを開始しない', () => {
    const fixture = updaterFixture()
    writeFileSync(join(fixture.state, 'update-transaction.json'), '{}\n', { mode: 0o600 })
    const result = runStandaloneSetup(fixture)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('zerokun-update --recover-only')
    expect(existsSync(fixture.setupMarker)).toBe(false)
    expect(existsSync(join(fixture.state, 'update.lock/pid'))).toBe(false)
  })

  test('全detached commandはlease登録後に開始しreaper後にだけ解除する', () => {
    const source = readFileSync(join(import.meta.dir, 'update.ts'), 'utf8')
    const commandRunner = source.slice(
      source.indexOf('async function requireCommandAsync('),
      source.indexOf('export function processStateIsAlive('),
    )
    const delegate = commandRunner.indexOf('options.processGroupLease.delegate(proc.pid)')
    const openGate = commandRunner.indexOf(
      'gateInput.write(`start\\n${encodeProcessLockDelegate(delegated)}\\n`)',
    )
    const finalReap = commandRunner.indexOf('rootPids: []')
    const cleanupDecision = commandRunner.indexOf('processGroupCleanupIsUncertain({')
    const undelegate = commandRunner.indexOf('options.processGroupLease!.undelegate(delegated)')
    expect(delegate).toBeGreaterThanOrEqual(0)
    expect(openGate).toBeGreaterThan(delegate)
    expect(finalReap).toBeGreaterThan(openGate)
    expect(cleanupDecision).toBeGreaterThan(finalReap)
    expect(undelegate).toBeGreaterThan(cleanupDecision)
    expect(undelegate).toBeGreaterThan(finalReap)
    expect(commandRunner).toContain("signalProcessGroupIfLeaderLive(rootIdentity, 'SIGKILL')")
    expect(commandRunner).toContain("signalProcessIfLive(rootIdentity, 'SIGKILL')")
    expect(commandRunner).not.toContain('proc.kill(')
    expect(commandRunner).not.toContain('process.kill(-proc.pid')

    const candidate = source.slice(
      source.indexOf('async function validateZero('),
      source.indexOf('export async function stopLockedProcess('),
    )
    const preflight = candidate.slice(
      candidate.indexOf('requireEffectiveCodexPermissionPreflight('),
      candidate.indexOf("await requireCommandAsync([\n    stagedCodexBin"),
    )
    expect(preflight).toContain('processGroupLease')
    expect(preflight).toContain('signal')

    for (const marker of [
      "'git', 'fetch'",
      "'git', 'clone'",
      "'git', 'checkout'",
      "stagedCodexBin,\n    '-a', 'never'",
    ]) {
      const start = source.indexOf(marker)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(source.slice(start, start + 900)).toContain('processGroupLease')
    }
    const main = source.slice(source.indexOf('async function main('))
    expect(main.slice(main.indexOf('preflightRepositories('), main.indexOf('throwIfInterrupted()', main.indexOf('preflightRepositories('))))
      .toContain('updateLock')
    expect(main.slice(main.indexOf('validateRemoteTargets('), main.indexOf('throwIfInterrupted()', main.indexOf('validateRemoteTargets('))))
      .toContain('updateLock')
  })

  test('cleanup evidenceが一つでも不確実ならundelegateを許可しない', () => {
    expect(processGroupCleanupIsUncertain({ remaining: [] })).toBe(false)
    expect(processGroupCleanupIsUncertain({ remaining: [42] })).toBe(true)
    expect(processGroupCleanupIsUncertain({ remaining: [], terminationError: new Error() })).toBe(true)
    expect(processGroupCleanupIsUncertain({ remaining: [], finalReapError: new Error() })).toBe(true)
    expect(processGroupCleanupIsUncertain({ remaining: [], trackingError: new Error() })).toBe(true)
    expect(processGroupCleanupIsUncertain({
      remaining: [], cleanupProtectionError: new Error(),
    })).toBe(true)
  })

  test('setup timeoutはlegacy drainと15分の作業budgetを必ず覆う', () => {
    expect(setupTimeoutBudgetMs({ ZEROKUN_LEGACY_CUTOVER: '0' })).toBe(15 * 60_000)
    expect(setupTimeoutBudgetMs({ ZEROKUN_LEGACY_CUTOVER: '1' }))
      .toBe(21_600_000 + 15 * 60_000)
    expect(setupTimeoutBudgetMs({
      ZEROKUN_LEGACY_CUTOVER: '1',
      ZEROKUN_SETUP_DRAIN_SECONDS: '10',
    })).toBe(910_000)
    expect(() => resolveSetupTimeoutMs({
      ZEROKUN_LEGACY_CUTOVER: '1',
      ZEROKUN_SETUP_DRAIN_SECONDS: '10',
      ZEROKUN_UPDATE_SETUP_TIMEOUT_MS: '100',
    })).toThrow('910000ms以上')
    expect(resolveSetupTimeoutMs({
      ZEROKUN_LEGACY_CUTOVER: '1',
      ZEROKUN_SETUP_DRAIN_SECONDS: '10',
      ZEROKUN_UPDATE_SETUP_TIMEOUT_MS: '100',
    }, true)).toBe(100)
  })

  test('zombieだけをdeadと判定する', () => {
    expect(processStateIsAlive('S')).toBe(true)
    expect(processStateIsAlive('R+')).toBe(true)
    expect(processStateIsAlive('Z')).toBe(false)
    expect(processStateIsAlive('Z+')).toBe(false)
    expect(processStateIsAlive('')).toBe(false)
  })

  test('healthは連続成功だけを数える', async () => {
    const observations = [true, true, false, true, true, true]
    let index = 0
    await waitForStableHealth({
      observe: () => observations[index++] ?? false,
      requiredConsecutive: 3,
      maxChecks: 6,
      sleep: async () => {},
    })
    expect(index).toBe(6)
  })

  test('Codex queueだけを待ち、migration済みClaude履歴は無視する', () => {
    expect(activeJobCounts(JSON.stringify([
      { runtime: 'claude', status: 'running' },
      { runtime: 'codex', status: 'running' },
      { runtime: 'codex', status: 'queued' },
    ]))).toEqual({ running: 1, queued: 1 })
    expect(activeJobCounts(JSON.stringify([
      { status: 'running' },
    ]))).toEqual({ running: 1, queued: 0 })
  })

  test('100件を超える履歴の末尾にあるactive jobもDB集計で見落とさない', () => {
    const dir = fixtureDir()
    const dbPath = join(dir, 'jobs.sqlite3')
    const db = new Database(dbPath, { create: true })
    db.exec('CREATE TABLE jobs (seq INTEGER PRIMARY KEY, status TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO jobs (seq, status) VALUES (?, ?)')
    for (let seq = 1; seq <= 100; seq += 1) insert.run(seq, 'completed')
    insert.run(101, 'running')
    insert.run(102, 'queued')
    db.close()
    expect(activeJobCountsFromDatabase(dbPath)).toEqual({ queued: 1, running: 1 })
  })

  test('Codex gatewayはClaudeの確認画面なしでdetached tmuxへ起動できる', async () => {
    const tmux = Bun.spawnSync(['/usr/bin/which', 'tmux'], { stdout: 'pipe' })
    expect(tmux.exitCode).toBe(0)
    const base = fixtureDir()
    const root = join(base, 'root')
    const project = join(base, 'project')
    const log = join(base, 'gateway.log')
    const observedEnvironment = join(base, 'launch-environment-observed')
    const launcher = join(root, 'codex-channel.sh')
    mkdirSync(root)
    mkdirSync(project)
    writeFileSync(
      launcher,
      '#!/bin/bash\nprintf \'%s|%s|%s|%s\\n\' "$ZEROKUN_LEGACY_CUTOVER" "${ZEROKUN_JOB_DB:-}" "${ZEROKUN_SETUP_SCRIPT:-}" "${SLACK_BOT_TOKEN:-}" > "$ZEROKUN_STATE_DIR/launch-environment-observed"\necho gateway-started\nsleep 30\n',
    )
    chmodSync(launcher, 0o700)
    const session = `zerokun-codex-test-${process.pid}-${Date.now()}`
    tmuxSessions.push(session)

    const previousJobDb = process.env.ZEROKUN_JOB_DB
    const previousSetup = process.env.ZEROKUN_SETUP_SCRIPT
    const previousSlack = process.env.SLACK_BOT_TOKEN
    process.env.ZEROKUN_JOB_DB = join(base, 'jobs.sqlite3')
    process.env.ZEROKUN_SETUP_SCRIPT = '/stale/setup.sh'
    process.env.SLACK_BOT_TOKEN = 'xoxb-stale-not-real'
    try {
      const panePid = await startBotInTmux({
        rootRepo: root,
        projectDir: project,
        logPath: log,
        sessionName: session,
        startupTimeoutMs: 2_000,
        tmuxPath: tmux.stdout.toString().trim(),
        replaceTokenFile: join(base, 'replace-token'),
        legacyCutover: true,
      })
      expect(panePid).toBeGreaterThan(0)
      expect(Bun.spawnSync([tmux.stdout.toString().trim(), 'has-session', '-t', session]).exitCode).toBe(0)
      for (let attempt = 0; attempt < 100 && !existsSync(observedEnvironment); attempt += 1) {
        await Bun.sleep(20)
      }
      expect(readFileSync(observedEnvironment, 'utf8').trim())
        .toBe(`1|${join(realpathSync(base), 'jobs.sqlite3')}||`)
    } finally {
      if (previousJobDb === undefined) delete process.env.ZEROKUN_JOB_DB
      else process.env.ZEROKUN_JOB_DB = previousJobDb
      if (previousSetup === undefined) delete process.env.ZEROKUN_SETUP_SCRIPT
      else process.env.ZEROKUN_SETUP_SCRIPT = previousSetup
      if (previousSlack === undefined) delete process.env.SLACK_BOT_TOKEN
      else process.env.SLACK_BOT_TOKEN = previousSlack
    }
  })

  test('同名の無関係tmux sessionを停止せずfail-closedにする', async () => {
    const tmux = Bun.spawnSync(['/usr/bin/which', 'tmux'], { stdout: 'pipe' })
    expect(tmux.exitCode).toBe(0)
    const tmuxPath = tmux.stdout.toString().trim()
    const base = fixtureDir()
    const root = join(base, 'root')
    const project = join(base, 'project')
    mkdirSync(root)
    mkdirSync(project)
    writeFileSync(join(root, 'codex-channel.sh'), '#!/bin/bash\nsleep 30\n', { mode: 0o700 })
    const session = `zerokun-collision-${process.pid}-${Date.now()}`
    tmuxSessions.push(session)
    expect(Bun.spawnSync([tmuxPath, 'new-session', '-d', '-s', session, 'sleep 30']).exitCode).toBe(0)
    const sentinelPid = Number(Bun.spawnSync([
      tmuxPath, 'list-panes', '-t', session, '-F', '#{pane_pid}',
    ], { stdout: 'pipe' }).stdout.toString().trim())
    const replaceTokenFile = join(base, 'replace-token')

    await expect(startBotInTmux({
      rootRepo: root,
      stateDir: base,
      projectDir: project,
      logPath: join(base, 'gateway.log'),
      sessionName: session,
      startupTimeoutMs: 2_000,
      tmuxPath,
      replaceTokenFile,
    })).rejects.toThrow('所有権を確認できないsessionを停止せず')

    expect(Bun.spawnSync([tmuxPath, 'has-session', '-t', session]).exitCode).toBe(0)
    expect(() => process.kill(sentinelPid, 0)).not.toThrow()
    expect(existsSync(replaceTokenFile)).toBe(false)
  })

  test.each(['symlink', 'hardlink'] as const)(
    'gateway replace tokenは既存%sを辿らず外部fileを保持する',
    async (kind) => {
      const tmux = Bun.spawnSync(['/usr/bin/which', 'tmux'], { stdout: 'pipe' })
      expect(tmux.exitCode).toBe(0)
      const base = fixtureDir()
      const root = join(base, 'root')
      const project = join(base, 'project')
      const external = join(base, 'external-token')
      const token = join(base, 'replace-token')
      mkdirSync(root)
      mkdirSync(project)
      writeFileSync(external, 'keep-token', { mode: 0o644 })
      if (kind === 'symlink') symlinkSync(external, token)
      else linkSync(external, token)
      writeFileSync(
        join(root, 'codex-channel.sh'),
        '#!/bin/bash\necho gateway-started\nsleep 30\n',
        { mode: 0o700 },
      )
      const session = `zerokun-token-${kind}-${process.pid}-${Date.now()}`
      tmuxSessions.push(session)
      await startBotInTmux({
        rootRepo: root,
        stateDir: base,
        projectDir: project,
        logPath: join(base, 'gateway.log'),
        sessionName: session,
        startupTimeoutMs: 2_000,
        tmuxPath: tmux.stdout.toString().trim(),
        replaceTokenFile: token,
      })
      expect(readFileSync(external, 'utf8')).toBe('keep-token')
      expect(lstatSync(token).isFile()).toBe(true)
    },
  )

  test('stale lockが生きている無関係なPIDを指してもprocessを停止しない', async () => {
    const dir = fixtureDir()
    const lockFile = join(dir, 'plugin.lock')
    const unrelated = Bun.spawn(['/bin/sleep', '30'])
    writeFileSync(lockFile, `${unrelated.pid}\n`, { mode: 0o600 })
    const metadata = lstatSync(lockFile)
    writeFileSync(`${lockFile}.identity`, `${JSON.stringify({
      version: 2,
      pid: unrelated.pid,
      started: 'Thu Jan  1 00:00:00 1970',
      canonicalStarted: 'Thu Jan  1 00:00:00 1970',
      nonce: '12345678-1234-4123-8123-123456789abc',
      device: metadata.dev,
      inode: metadata.ino,
    })}\n`, { mode: 0o600 })
    try {
      await stopLockedProcess(lockFile, unrelated.pid, 'Slack gateway', /server\.ts/)
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow()
      expect(existsSync(lockFile)).toBe(false)
    } finally {
      unrelated.kill()
      await unrelated.exited
    }
  })

  test('正規gatewayのidentityだけが欠損した場合はlockを捨てずfail-closedにする', async () => {
    const dir = fixtureDir()
    const lockFile = join(dir, 'plugin.lock')
    const fakeServer = join(dir, 'server.ts')
    writeFileSync(fakeServer, 'await Bun.sleep(30_000)\n')
    const gateway = Bun.spawn([process.execPath, fakeServer])
    writeFileSync(lockFile, `${gateway.pid}\n`)
    try {
      await expect(
        stopLockedProcess(lockFile, gateway.pid, 'Slack gateway', /server\.ts/),
      ).rejects.toThrow('lock identityを検証できません')
      expect(() => process.kill(gateway.pid, 0)).not.toThrow()
      expect(existsSync(lockFile)).toBe(true)
    } finally {
      gateway.kill()
      await gateway.exited
    }
  })
})

describe('Codex branch self update', () => {
  test('state ancestor aliasをphysical identityへ統一してsetupとjournalへ渡す', () => {
    const fixture = updaterFixture()
    writeFileSync(join(fixture.state, '.env'), [
      'SLACK_BOT_TOKEN=xoxb-cutover-not-a-real-token',
      'SLACK_APP_TOKEN=xapp-1-A0123456789-cutover-not-a-real-token',
      '',
    ].join('\n'), { mode: 0o600 })
    writeFileSync(
      join(fixture.state, '.codex-legacy-cutover'),
      `zerokun-codex-legacy-cutover-v1\n${realpathSync(fixture.state)}\n`,
      { mode: 0o600 },
    )
    const aliasParent = join(fixture.base, 'state-parent-alias')
    const aliasState = join(aliasParent, 'state')
    symlinkSync(fixture.base, aliasParent)
    writeFileSync(fixture.setup, [
      '#!/bin/bash',
      `printf '%s\\n' "$ZEROKUN_STATE_DIR" > '${fixture.setupMarker}'`,
      '',
    ].join('\n'))
    const result = runUpdater(fixture, ['--skip-tests', '--no-restart'], {
      ...updaterEnvironment(fixture),
      ZEROKUN_STATE_DIR: aliasState,
      ZEROKUN_LEGACY_CUTOVER: '1',
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(readFileSync(fixture.setupMarker, 'utf8').trim()).toBe(realpathSync(fixture.state))
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(false)
  })

  test('無関係な同名tmux sessionを保持し一意なsessionで更新を完遂する', () => {
    const fixture = updaterFixture()
    const tmux = must(['/usr/bin/which', 'tmux'])
    const session = `zerokun-update-collision-${process.pid}-${Date.now()}`
    tmuxSessions.push(session)
    expect(Bun.spawnSync([tmux, 'new-session', '-d', '-s', session, 'sleep 30']).exitCode).toBe(0)
    const sentinelPid = Number(Bun.spawnSync([
      tmux, 'list-panes', '-t', session, '-F', '#{pane_pid}',
    ], { stdout: 'pipe' }).stdout.toString().trim())
    const before = must(['git', 'rev-parse', 'HEAD'], fixture.repo.local)

    const result = runUpdater(fixture, ['--skip-tests'], {
      ...serviceUpdaterEnvironment(fixture, session),
      ZEROKUN_TMUX_PATH: tmux,
    })
    rememberFixtureServices(fixture.state)

    expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0)
    expect(must(['git', 'rev-parse', 'HEAD'], fixture.repo.local)).not.toBe(before)
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(false)
    expect(existsSync(fixture.setupMarker)).toBe(true)
    expect(Bun.spawnSync([tmux, 'has-session', '-t', session]).exitCode).toBe(0)
    expect(() => process.kill(sentinelPid, 0)).not.toThrow()
    const marker = JSON.parse(readFileSync(join(fixture.state, 'tmux-session.json'), 'utf8'))
    expect(marker.name).toStartWith(`${session}-`)
    expect(marker.name).not.toBe(session)
  }, 20_000)

  test('commit済みjournalをbackupより先に消し、後処理失敗後も復旧を妨げない', () => {
    const fixture = updaterFixture()
    const external = join(fixture.base, 'external-orphan')
    mkdirSync(external)
    symlinkSync(external, join(fixture.state, 'update-rollback'))
    const journalFile = join(fixture.state, 'update-transaction.json')
    writeFileSync(journalFile, '{}')
    const head = must(['git', 'rev-parse', 'HEAD'], fixture.repo.local)
    const warnings: string[] = []

    clearJournal(fixture.state, {
      version: 1,
      id: '12345678-1234-4123-8123-123456789abc',
      phase: 'setup-applied',
      repoPath: realpathSync(fixture.repo.local),
      branch: 'codex',
      originalHead: head,
      targetHead: head,
      projectDir: fixture.project,
      setupScript: fixture.setup,
      databasePath: join(fixture.state, 'jobs.sqlite3'),
      databaseBackup: join(fixture.state, 'update-rollback', '12345678-1234-4123-8123-123456789abc', 'jobs.sqlite3'),
      noRestart: true,
    }, message => warnings.push(message))

    expect(existsSync(journalFile)).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(readdirSync(external)).toEqual([])
    const recovery = runUpdater(fixture, ['--recover-only'])
    expect(recovery.exitCode).toBe(0)
    expect(recovery.stdout.toString()).toContain('未完了の更新transactionはありません')
  })

  test.each(['symlink', 'hardlink'] as const)(
    'rollback snapshotは%s jobs.sqlite3をopen前に拒否する',
    (kind) => {
      const fixture = updaterFixture()
      const external = join(fixture.base, `external-${kind}.sqlite3`)
      const database = new Database(external, { create: true })
      database.exec('CREATE TABLE jobs (status TEXT NOT NULL, runtime TEXT NOT NULL)')
      database.close()
      const before = readFileSync(external)
      if (kind === 'symlink') symlinkSync(external, join(fixture.state, 'jobs.sqlite3'))
      else linkSync(external, join(fixture.state, 'jobs.sqlite3'))
      const result = runUpdater(fixture)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain(
        kind === 'symlink'
          ? "must be the selected state's jobs.sqlite3"
          : 'unsafe SQLite file',
      )
      expect(readFileSync(external)).toEqual(before)
    },
  )

  test('update.lock directory symlinkを拒否しstate外へ書かない', () => {
    const fixture = updaterFixture()
    const external = join(fixture.base, 'external-lock')
    mkdirSync(external)
    symlinkSync(external, join(fixture.state, 'update.lock'))
    const result = runUpdater(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('unsafe managed directory')
    expect(readdirSync(external)).toEqual([])
  })

  test('update-rollback directory symlinkを拒否しstate外へbackupも削除もしない', () => {
    const fixture = updaterFixture()
    const database = new Database(join(fixture.state, 'jobs.sqlite3'), { create: true })
    database.exec('CREATE TABLE jobs (status TEXT NOT NULL, runtime TEXT NOT NULL)')
    database.close()
    const external = join(fixture.base, 'external-rollback')
    mkdirSync(external)
    symlinkSync(external, join(fixture.state, 'update-rollback'))
    const result = runUpdater(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('unsafe managed directory')
    expect(readdirSync(external)).toEqual([])
  })

  test('改ざんjournalのstate外DB backup pathを読まず削除もしない', () => {
    const fixture = updaterFixture()
    const external = join(fixture.base, 'must-stay.sqlite3')
    writeFileSync(external, 'do not touch')
    const head = must(['git', 'rev-parse', 'HEAD'], fixture.repo.local)
    writeFileSync(join(fixture.state, 'update-transaction.json'), JSON.stringify({
      version: 1,
      id: '12345678-1234-4123-8123-123456789abc',
      phase: 'fast-forwarded',
      repoPath: realpathSync(fixture.repo.local),
      branch: 'codex',
      originalHead: head,
      targetHead: head,
      projectDir: fixture.project,
      setupScript: fixture.setup,
      databasePath: external,
      databaseBackup: external,
      noRestart: true,
    }))
    const result = runUpdater(fixture, ['--recover-only'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('journalが不正')
    expect(readFileSync(external, 'utf8')).toBe('do not touch')
  })

  test('悪性local Git configを実行せず更新を拒否する', () => {
    const fixture = updaterFixture()
    const marker = join(fixture.base, 'fsmonitor-executed')
    const helper = join(fixture.base, 'evil-fsmonitor.sh')
    writeFileSync(helper, `#!/bin/bash\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 })
    must(['git', 'config', 'core.fsmonitor', helper], fixture.repo.local)
    const result = runUpdater(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('許可されていない設定')
    expect(existsSync(marker)).toBe(false)
  })

  test('include経由filterとHTTP proxy設定をorigin fetch前に拒否する', () => {
    for (const mode of ['include-filter', 'http-proxy']) {
      const fixture = updaterFixture()
      const marker = join(fixture.base, `${mode}-executed`)
      if (mode === 'include-filter') {
        const helper = join(fixture.base, 'evil-filter.sh')
        const included = join(fixture.repo.local, '.git', 'evil.conf')
        writeFileSync(helper, `#!/bin/bash\ntouch '${marker}'\ncat\n`, { mode: 0o700 })
        writeFileSync(included, `[filter "evil"]\n\tclean = ${helper}\n`)
        must(['git', 'config', 'include.path', included], fixture.repo.local)
        writeFileSync(join(fixture.repo.local, '.gitattributes'), '* filter=evil\n')
      } else {
        must(['git', 'config', 'http.proxy', 'http://127.0.0.1:9'], fixture.repo.local)
        must(['git', 'config', 'http.sslVerify', 'false'], fixture.repo.local)
      }
      const result = runUpdater(fixture)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('許可されていない設定')
      expect(existsSync(marker)).toBe(false)
    }
  })

  test('悪性fetch refspecで未pushのlocal branchを上書きしない', () => {
    const fixture = updaterFixture()
    must(['git', 'switch', '-c', 'main'], fixture.repo.local)
    must(['git', 'config', 'user.email', 'test@example.com'], fixture.repo.local)
    must(['git', 'config', 'user.name', 'test'], fixture.repo.local)
    writeFileSync(join(fixture.repo.local, 'local-only.txt'), 'preserve\n')
    must(['git', 'add', 'local-only.txt'], fixture.repo.local)
    must(['git', 'commit', '-m', 'local only'], fixture.repo.local)
    const localMain = must(['git', 'rev-parse', 'HEAD'], fixture.repo.local)
    must(['git', 'switch', 'codex'], fixture.repo.local)
    must([
      'git', 'config', '--replace-all', 'remote.origin.fetch',
      '+refs/heads/codex:refs/heads/main',
    ], fixture.repo.local)

    const result = runUpdater(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('remote.origin.fetch')
    expect(must(['git', 'rev-parse', 'main'], fixture.repo.local)).toBe(localMain)
    expect(must(['git', 'show', 'main:local-only.txt'], fixture.repo.local)).toBe('preserve')
  })

  test('codex branchだけを事前検査してfast-forwardしsetupを実行する', () => {
    const fixture = updaterFixture()
    const result = runUpdater(fixture)
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v2\n')
    expect(must(['git', 'branch', '--show-current'], fixture.repo.local)).toBe('codex')
    expect(existsSync(fixture.setupMarker)).toBe(true)
    expect(result.stdout.toString()).toContain('origin/codex')
    expect(result.stdout.toString().match(/queue: /g)?.length).toBe(2)
  })

  test('journal保持中のcandidate gatewayとrunnerを起動しreadiness後にcommitする', () => {
    const fixture = updaterFixture()
    const session = `zerokun-update-success-${process.pid}-${Date.now()}`
    tmuxSessions.push(session)
    const result = runUpdater(
      fixture,
      ['--skip-tests'],
      serviceUpdaterEnvironment(fixture, session),
    )
    rememberFixtureServices(fixture.state)
    const serviceLog = existsSync(join(fixture.state, 'zerokun.log'))
      ? readFileSync(join(fixture.state, 'zerokun.log'), 'utf8')
      : '(no gateway log)'
    expect(result.exitCode, `${result.stderr}\n${result.stdout}\n${serviceLog}`).toBe(0)
    expect(result.stdout.toString()).toContain('再起動完了')
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(false)
    const head = must(['git', 'rev-parse', 'HEAD'], fixture.repo.local)
    const readiness = JSON.parse(readFileSync(join(fixture.state, 'gateway-ready.json'), 'utf8'))
    expect(readiness.release).toBe(head)
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v2\n')
  }, 20_000)

  test('candidate readiness失敗時は旧commitへrollbackし旧gatewayとrunnerを再起動する', () => {
    const fixture = updaterFixture()
    const originalHead = must(['git', 'rev-parse', 'HEAD'], fixture.repo.local)
    writeFileSync(join(fixture.repo.seed, 'server.ts'), [
      "import { join } from 'path'",
      "import { acquire } from './zerokun/fixture-lock.ts'",
      'const state = process.env.ZEROKUN_STATE_DIR!',
      "acquire(join(state, 'plugin.lock'))",
      "process.on('SIGTERM', () => process.exit(0))",
      'await Bun.sleep(60_000)',
      '',
    ].join('\n'))
    must(['git', 'add', 'server.ts'], fixture.repo.seed)
    must(['git', 'commit', '-m', 'broken candidate readiness'], fixture.repo.seed)
    must(['git', 'push', 'origin', 'codex'], fixture.repo.seed)
    const session = `zerokun-update-rollback-${process.pid}-${Date.now()}`
    tmuxSessions.push(session)
    const result = runUpdater(
      fixture,
      ['--skip-tests'],
      {
        ...serviceUpdaterEnvironment(fixture, session),
        ZEROKUN_HEALTH_CONSECUTIVE: '2',
        ZEROKUN_HEALTH_MAX_CHECKS: '20',
        ZEROKUN_HEALTH_SLEEP_MS: '100',
      },
    )
    rememberFixtureServices(fixture.state)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('旧Codex版へ自動ロールバックしました')
    expect(must(['git', 'rev-parse', 'HEAD'], fixture.repo.local)).toBe(originalHead)
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(false)
    const readiness = JSON.parse(readFileSync(join(fixture.state, 'gateway-ready.json'), 'utf8'))
    expect(readiness.release).toBe(originalHead)
  }, 20_000)

  test('setup失敗時はGitとSQLiteを旧版へ自動rollbackしてjournalを消す', () => {
    const fixture = updaterFixture()
    const databasePath = join(fixture.state, 'jobs.sqlite3')
    const database = new Database(databasePath, { create: true })
    database.exec('CREATE TABLE marker (value TEXT NOT NULL)')
    database.exec('CREATE TABLE jobs (status TEXT NOT NULL, runtime TEXT NOT NULL)')
    database.run('INSERT INTO marker (value) VALUES (?)', ['before-update'])
    database.close()
    const failedOnce = join(fixture.base, 'setup-failed-once')
    const rollbackSetup = join(fixture.base, 'rollback-setup-ran')
    writeFileSync(fixture.setup, [
      '#!/bin/bash',
      `if [ ! -f '${failedOnce}' ]; then`,
      `  touch '${failedOnce}'`,
      `  printf 'candidate-garbage' >> '${databasePath}'`,
      '  exit 42',
      'fi',
      `touch '${rollbackSetup}'`,
      '',
    ].join('\n'))

    const result = runUpdater(fixture)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('自動ロールバックしました')
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(rollbackSetup)).toBe(true)
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(false)
    const restored = new Database(databasePath)
    expect(restored.query<{ value: string }, []>('SELECT value FROM marker').get()?.value)
      .toBe('before-update')
    restored.close()
  })

  test('未コミット変更があれば何も更新しない', () => {
    const fixture = updaterFixture()
    writeFileSync(join(fixture.repo.local, 'local.txt'), 'preserve\n')
    const result = runUpdater(fixture)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('未コミット変更')
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(fixture.setupMarker)).toBe(false)
  })

  test('候補commitの検証失敗時はlive branchをfast-forwardしない', () => {
    const fixture = updaterFixture()
    // Minimal fixture has no Zero-kun package, so candidate validation must fail.
    const result = runUpdater(fixture, ['--no-restart'])
    expect(result.exitCode).toBe(1)
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(fixture.setupMarker)).toBe(false)
  })

  test('候補commitは公開verify scriptを通らない限りliveへ反映しない', () => {
    const fixture = updaterFixture()
    const verifyMarker = join(fixture.base, 'candidate-verify-ran')
    const verifyDir = join(fixture.repo.seed, 'zerokun')
    mkdirSync(verifyDir, { recursive: true })
    writeFileSync(join(verifyDir, 'verify.sh'), [
      '#!/bin/bash',
      `touch '${verifyMarker}'`,
      'exit 42',
      '',
    ].join('\n'))
    must(['git', 'add', '.'], fixture.repo.seed)
    must(['git', 'commit', '-m', 'broken candidate'], fixture.repo.seed)
    must(['git', 'push', 'origin', 'codex'], fixture.repo.seed)

    const result = runUpdater(fixture, ['--no-restart'])
    expect(result.exitCode).toBe(1)
    expect(existsSync(verifyMarker)).toBe(false)
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v1\n')
  }, 15_000)

  test('候補verifyは隔離sandbox内だけを書け、stateや外部pathへ触れない', () => {
    const fixture = updaterFixture()
    const stateSecret = join(fixture.state, 'secret.txt')
    const externalMarker = join(fixture.base, 'candidate-escaped')
    writeFileSync(stateSecret, 'must-not-read')
    const verifyDir = join(fixture.repo.seed, 'zerokun')
    mkdirSync(verifyDir, { recursive: true })
    writeFileSync(join(verifyDir, 'verify.sh'), [
      '#!/bin/bash',
      'set -e',
      `if test -r '${stateSecret}'; then exit 41; fi`,
      `if touch '${externalMarker}' 2>/dev/null; then exit 42; fi`,
      'touch candidate-local-output',
      'exit 0',
      '',
    ].join('\n'))
    must(['git', 'add', '.'], fixture.repo.seed)
    must(['git', 'commit', '-m', 'sandboxed candidate'], fixture.repo.seed)
    must(['git', 'push', 'origin', 'codex'], fixture.repo.seed)
    const result = runUpdater(fixture, ['--no-restart'])
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(existsSync(externalMarker)).toBe(false)
    expect(readFileSync(stateSecret, 'utf8')).toBe('must-not-read')
  }, 15_000)

  test('候補verifyがhangしてもdeadlineで停止しlive HEADを変更しない', () => {
    const fixture = updaterFixture()
    const verifyDir = join(fixture.repo.seed, 'zerokun')
    mkdirSync(verifyDir, { recursive: true })
    writeFileSync(join(verifyDir, 'verify.sh'), '#!/bin/bash\nsleep 30\n')
    must(['git', 'add', '.'], fixture.repo.seed)
    must(['git', 'commit', '-m', 'hanging candidate'], fixture.repo.seed)
    must(['git', 'push', 'origin', 'codex'], fixture.repo.seed)
    const startedAt = Date.now()
    const result = runUpdater(
      fixture,
      ['--no-restart'],
      { ...updaterEnvironment(fixture), ZEROKUN_UPDATE_VERIFY_TIMEOUT_MS: '100' },
    )
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('timeout')
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(false)
  }, 15_000)

  test('新版setupがhangしてもdeadlineで停止し旧版へrollbackする', () => {
    const fixture = updaterFixture()
    writeFileSync(fixture.setup, [
      '#!/bin/bash',
      `if grep -q '^v2' '${join(fixture.repo.local, 'version.txt')}'; then`,
      '  sleep 30',
      'fi',
      `touch '${fixture.setupMarker}'`,
      '',
    ].join('\n'))
    const startedAt = Date.now()
    const result = runUpdater(
      fixture,
      ['--skip-tests', '--no-restart'],
      { ...updaterEnvironment(fixture), ZEROKUN_UPDATE_SETUP_TIMEOUT_MS: '100' },
    )
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('timeout')
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(false)
    expect(existsSync(fixture.setupMarker)).toBe(true)
  }, 15_000)

  test('rollback側setupもhangした場合はjournalを保持しrecover-onlyで復旧する', () => {
    const fixture = updaterFixture()
    writeFileSync(fixture.setup, '#!/bin/bash\nsleep 30\n')
    const failed = runUpdater(
      fixture,
      ['--skip-tests', '--no-restart'],
      { ...updaterEnvironment(fixture), ZEROKUN_UPDATE_SETUP_TIMEOUT_MS: '100' },
    )
    expect(failed.exitCode).not.toBe(0)
    expect(failed.stderr.toString()).toContain('timeout')
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(true)

    writeFileSync(fixture.setup, `#!/bin/bash\ntouch '${fixture.setupMarker}'\n`)
    const recovered = runUpdater(
      fixture,
      ['--recover-only'],
      { ...updaterEnvironment(fixture), ZEROKUN_UPDATE_SETUP_TIMEOUT_MS: '2000' },
    )
    expect(recovered.exitCode, recovered.stderr.toString()).toBe(0)
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(false)
    expect(existsSync(fixture.setupMarker)).toBe(true)
  }, 20_000)

  test('検証中にorigin/codexが進んでも検証済みSHAだけを適用する', async () => {
    const fixture = updaterFixture()
    writeFileSync(join(fixture.repo.seed, 'version.txt'), 'v3-verified\n')
    must(['git', 'add', '.'], fixture.repo.seed)
    must(['git', 'commit', '-m', 'v3 verified'], fixture.repo.seed)
    must(['git', 'push', 'origin', 'codex'], fixture.repo.seed)
    await withUpdateTestPolicy(async () => {
      const repositories = [{ label: 'zero-codex', path: fixture.repo.local, branch: 'codex' }]
      const pinned = await preflightRepositories(repositories)
      writeFileSync(join(fixture.repo.seed, 'version.txt'), 'v4-unverified\n')
      must(['git', 'add', '.'], fixture.repo.seed)
      must(['git', 'commit', '-m', 'v4 unverified'], fixture.repo.seed)
      must(['git', 'push', 'origin', 'codex'], fixture.repo.seed)
      must(['git', 'fetch', 'origin'], fixture.repo.local)
      fastForwardRepositories(pinned)
      expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v3-verified\n')
      expect(must(['git', 'rev-parse', 'HEAD'], fixture.repo.local))
        .not.toBe(must(['git', 'rev-parse', 'origin/codex'], fixture.repo.local))
    })
  })

  test('候補検証中にlive branchが変わればjournal作成前に停止する', async () => {
    const fixture = updaterFixture()
    await withUpdateTestPolicy(async () => {
      const repositories = [{ label: 'zero-codex', path: fixture.repo.local, branch: 'codex' }]
      const [pinned] = await preflightRepositories(repositories)
      must(['git', 'switch', '-c', 'user-work'], fixture.repo.local)
      expect(() => assertPinnedRepositoryState(pinned!)).toThrow('branchまたはHEADが変更')
      expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(false)
    })
  })

  test('rollback開始後の未コミット変更はresetせずjournalを保持する', () => {
    const fixture = updaterFixture()
    const failedOnce = join(fixture.base, 'dirty-failed-once')
    writeFileSync(fixture.setup, [
      '#!/bin/bash',
      `if [ ! -f '${failedOnce}' ]; then`,
      `  touch '${failedOnce}'`,
      "  printf 'do-not-delete\\n' > version.txt",
      '  exit 42',
      'fi',
      'exit 0',
      '',
    ].join('\n'))
    const result = runUpdater(fixture)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('ユーザー作業を保持するため自動resetせず')
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('do-not-delete\n')
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(true)
  })

  test('通常更新workerは残存journalのrollbackを更新成功として通知しない', () => {
    const fixture = updaterFixture()
    const failedOnce = join(fixture.base, 'leave-recoverable-journal')
    writeFileSync(fixture.setup, [
      '#!/bin/bash',
      `if [ ! -f '${failedOnce}' ]; then`,
      `  touch '${failedOnce}'`,
      "  printf 'dirty during failed setup\\n' > version.txt",
      '  exit 42',
      'fi',
      'exit 0',
      '',
    ].join('\n'))

    const failed = runUpdater(fixture)
    expect(failed.exitCode).toBe(1)
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(true)
    must(['git', 'checkout', '--', 'version.txt'], fixture.repo.local)

    const recovered = runUpdater(fixture)
    expect(recovered.exitCode).toBe(1)
    expect(recovered.stdout.toString()).toContain('未完了だった更新transactionを復旧しました')
    expect(recovered.stderr.toString()).toContain('今回の更新は適用されていない')
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(false)

    const launcherRecovery = runUpdater(fixture, ['--recover-only'])
    expect(launcherRecovery.exitCode).toBe(0)
    expect(launcherRecovery.stdout.toString()).toContain('未完了の更新transactionはありません')
  })

  test('service停止待ち中に作られた変更もreset直前の再検査で保持する', async () => {
    const fixture = updaterFixture()
    const failedOnce = join(fixture.base, 'leave-journal')
    writeFileSync(fixture.setup, [
      '#!/bin/bash',
      `if [ ! -f '${failedOnce}' ]; then`,
      `  touch '${failedOnce}'`,
      "  printf 'initial dirty\\n' > version.txt",
      '  exit 42',
      'fi',
      'exit 0',
      '',
    ].join('\n'))
    expect(runUpdater(fixture).exitCode).toBe(1)
    must(['git', 'checkout', '--', 'version.txt'], fixture.repo.local)

    const stopping = join(fixture.base, 'gateway-stopping')
    const server = join(fixture.base, 'server.ts')
    writeFileSync(server, [
      '#!/bin/bash',
      `trap "touch '${stopping}'; sleep 1; exit 0" TERM`,
      'while :; do sleep 1; done',
      '',
    ].join('\n'), { mode: 0o700 })
    const gateway = Bun.spawn(['/bin/bash', server], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    const lock = join(fixture.state, 'plugin.lock')
    expect(tryAcquireProcessLock(lock, gateway.pid).acquired).toBe(true)
    const recover = spawnUpdater(fixture, ['--recover-only'])
    const deadline = Date.now() + 5_000
    while (!existsSync(stopping) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(stopping)).toBe(true)
    writeFileSync(join(fixture.repo.local, 'version.txt'), 'changed during stop\n')
    const [exitCode, stderr] = await Promise.all([
      recover.exited,
      new Response(recover.stderr).text(),
    ])
    await gateway.exited
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('自動resetせず')
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('changed during stop\n')
    expect(existsSync(join(fixture.state, 'update-transaction.json'))).toBe(true)
  })

  test('SIGTERM中断でも処理終了までupdate lockを保持する', async () => {
    const fixture = updaterFixture()
    const setupStarted = join(fixture.base, 'setup-started')
    const rollbackSetupCompleted = join(fixture.base, 'rollback-setup-completed')
    writeFileSync(
      fixture.setup,
      [
        '#!/bin/bash',
        `if [ -f '${setupStarted}' ]; then`,
        `  touch '${rollbackSetupCompleted}'`,
        '  exit 0',
        'fi',
        `touch '${setupStarted}'`,
        "trap 'sleep 0.5; exit 143' TERM",
        'sleep 30',
        '',
      ].join('\n'),
    )
    const first = spawnUpdater(fixture, ['--skip-tests', '--no-restart'])
    const deadline = Date.now() + 5_000
    while (!existsSync(setupStarted) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(setupStarted)).toBe(true)
    process.kill(first.pid, 'SIGTERM')
    await Bun.sleep(50)
    expect(existsSync(join(fixture.state, 'update.lock/pid'))).toBe(true)
    const second = runUpdater(fixture)
    expect(second.exitCode).toBe(1)
    expect(second.stderr.toString()).toContain('実行中')
    const firstStderr = await new Response(first.stderr).text()
    expect(await first.exited, firstStderr).toBe(1)
    expect(existsSync(rollbackSetupCompleted)).toBe(true)
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(fixture.state, 'update.lock/pid'))).toBe(false)
  })

  test('standalone supervisorとdelegate leaderのSIGKILL後もsetup子が二本目を防ぐ', async () => {
    const fixture = updaterFixture()
    const setupStarted = join(fixture.base, 'standalone-setup-started')
    const setupShellPidFile = join(fixture.base, 'standalone-setup-shell-pid')
    const secondCompleted = join(fixture.base, 'standalone-second-completed')
    writeFileSync(
      fixture.setup,
      [
        '#!/bin/bash',
        'test "${ZEROKUN_UPDATE_IN_PROGRESS:-0}" = 1 || exit 91',
        `if [ -f '${setupStarted}' ]; then`,
        `  touch '${secondCompleted}'`,
        '  exit 0',
        'fi',
        `printf '%s\\n' "$$" > '${setupShellPidFile}'`,
        `touch '${setupStarted}'`,
        "trap '' HUP TERM",
        'while :; do sleep 1; done',
        '',
      ].join('\n'),
    )
    const first = spawnStandaloneSetup(fixture)
    let delegatePid = 0
    let trackedGroup = new Map<number, string>()
    try {
      let deadline = Date.now() + 5_000
      while (!existsSync(setupStarted) && Date.now() < deadline) await Bun.sleep(10)
      expect(existsSync(setupStarted)).toBe(true)
      const identity = JSON.parse(
        readFileSync(join(fixture.state, 'update.lock/pid.identity'), 'utf8'),
      ) as { delegate?: { pid?: unknown; groupId?: unknown } }
      delegatePid = Number(identity.delegate?.pid)
      const setupShellPid = Number(readFileSync(setupShellPidFile, 'utf8').trim())
      expect(identity.delegate?.groupId).toBe(delegatePid)
      expect(Number.isInteger(delegatePid) && delegatePid > 0).toBe(true)
      expect(Number.isInteger(setupShellPid) && setupShellPid > 0).toBe(true)
      trackedGroup = snapshotFixtureGroup(delegatePid)

      process.kill(first.pid, 'SIGKILL')
      await first.exited
      process.kill(delegatePid, 'SIGKILL')
      deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try { process.kill(delegatePid, 0); await Bun.sleep(10) } catch { break }
      }
      expect(() => process.kill(setupShellPid, 0)).not.toThrow()
      expect(() => process.kill(-delegatePid, 0)).not.toThrow()

      const blocked = runStandaloneSetup(fixture)
      expect(blocked.exitCode).toBe(1)
      expect(blocked.stderr.toString()).toContain(`PID ${delegatePid}`)
      expect(existsSync(secondCompleted)).toBe(false)

      await stopFixtureGroup(delegatePid, trackedGroup)
      deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try { process.kill(-delegatePid, 0); await Bun.sleep(10) } catch { break }
      }
      const recovered = runStandaloneSetup(fixture)
      expect(recovered.exitCode, recovered.stderr.toString()).toBe(0)
      expect(existsSync(secondCompleted)).toBe(true)
      expect(existsSync(join(fixture.state, 'update.lock/pid'))).toBe(false)
    } finally {
      if (delegatePid > 0 && trackedGroup.size > 0) {
        await stopFixtureGroup(delegatePid, trackedGroup).catch(() => {})
      }
      try { process.kill(first.pid, 'SIGKILL') } catch {}
    }
  }, 20_000)

  test('親とsetup shellのSIGKILL後もlive子processが二本目のrollbackを防ぐ', async () => {
    const fixture = updaterFixture()
    const setupStarted = join(fixture.base, 'setup-started')
    const setupShellPidFile = join(fixture.base, 'setup-shell-pid')
    const rollbackSetupCompleted = join(fixture.base, 'rollback-setup-completed')
    writeFileSync(
      fixture.setup,
      [
        '#!/bin/bash',
        `if [ -f '${setupStarted}' ]; then`,
        `  touch '${rollbackSetupCompleted}'`,
        '  exit 0',
        'fi',
        `printf '%s\\n' "$$" > '${setupShellPidFile}'`,
        `touch '${setupStarted}'`,
        "trap '' HUP",
        'sleep 30',
        '',
      ].join('\n'),
    )
    const first = spawnUpdater(fixture, ['--skip-tests', '--no-restart'])
    const deadline = Date.now() + 5_000
    while (!existsSync(setupStarted) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(setupStarted)).toBe(true)
    const identityPath = join(fixture.state, 'update.lock/pid.identity')
    const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as {
      delegate?: { pid?: unknown }
    }
    const delegatePid = Number(identity.delegate?.pid)
    expect(Number.isInteger(delegatePid) && delegatePid > 0).toBe(true)
    const setupShellPid = Number(readFileSync(setupShellPidFile, 'utf8').trim())
    expect(Number.isInteger(setupShellPid) && setupShellPid > 0).toBe(true)
    const trackedGroup = snapshotFixtureGroup(delegatePid)

    process.kill(setupShellPid, 'SIGKILL')
    await Bun.sleep(100)
    expect(() => process.kill(-delegatePid, 0)).not.toThrow()
    process.kill(first.pid, 'SIGKILL')
    await first.exited
    const second = runUpdater(fixture, ['--recover-only'])
    expect(second.exitCode).toBe(1)
    expect(second.stderr.toString()).toContain(`PID ${delegatePid}`)
    expect(existsSync(rollbackSetupCompleted)).toBe(false)

    await stopFixtureGroup(delegatePid, trackedGroup)
    const stopped = Date.now() + 5_000
    while (Date.now() < stopped) {
      try { process.kill(delegatePid, 0); await Bun.sleep(10) } catch { break }
    }
    const recovered = runUpdater(fixture, ['--recover-only'])
    expect(recovered.exitCode, recovered.stderr.toString()).toBe(0)
    expect(existsSync(rollbackSetupCompleted)).toBe(true)
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(fixture.state, 'update.lock/pid'))).toBe(false)
  }, 20_000)

  test('updaterとdelegate leaderの二重SIGKILL後もorphan setup groupがrollbackを防ぐ', async () => {
    const fixture = updaterFixture()
    const setupStarted = join(fixture.base, 'setup-started')
    const setupShellPidFile = join(fixture.base, 'setup-shell-pid')
    const rollbackSetupCompleted = join(fixture.base, 'rollback-setup-completed')
    writeFileSync(
      fixture.setup,
      [
        '#!/bin/bash',
        `if [ -f '${setupStarted}' ]; then`,
        `  touch '${rollbackSetupCompleted}'`,
        '  exit 0',
        'fi',
        `printf '%s\\n' "$$" > '${setupShellPidFile}'`,
        `touch '${setupStarted}'`,
        "trap '' HUP TERM",
        'while :; do sleep 1; done',
        '',
      ].join('\n'),
    )
    const first = spawnUpdater(fixture, ['--skip-tests', '--no-restart'])
    let deadline = Date.now() + 5_000
    while (!existsSync(setupStarted) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(setupStarted)).toBe(true)
    const identity = JSON.parse(
      readFileSync(join(fixture.state, 'update.lock/pid.identity'), 'utf8'),
    ) as { delegate?: { pid?: unknown; groupId?: unknown } }
    const delegatePid = Number(identity.delegate?.pid)
    const setupShellPid = Number(readFileSync(setupShellPidFile, 'utf8').trim())
    expect(identity.delegate?.groupId).toBe(delegatePid)
    expect(Number.isInteger(delegatePid) && delegatePid > 0).toBe(true)
    expect(Number.isInteger(setupShellPid) && setupShellPid > 0).toBe(true)
    const trackedGroup = snapshotFixtureGroup(delegatePid)

    process.kill(first.pid, 'SIGKILL')
    await first.exited
    process.kill(delegatePid, 'SIGKILL')
    deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try { process.kill(delegatePid, 0); await Bun.sleep(10) } catch { break }
    }
    expect(() => process.kill(setupShellPid, 0)).not.toThrow()
    expect(() => process.kill(-delegatePid, 0)).not.toThrow()

    const second = runUpdater(fixture, ['--recover-only'])
    expect(second.exitCode).toBe(1)
    expect(second.stderr.toString()).toContain(`PID ${delegatePid}`)
    expect(existsSync(rollbackSetupCompleted)).toBe(false)

    await stopFixtureGroup(delegatePid, trackedGroup)
    deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try { process.kill(-delegatePid, 0); await Bun.sleep(10) } catch { break }
    }
    const recovered = runUpdater(fixture, ['--recover-only'])
    expect(recovered.exitCode, recovered.stderr.toString()).toBe(0)
    expect(existsSync(rollbackSetupCompleted)).toBe(true)
    expect(readFileSync(join(fixture.repo.local, 'version.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(fixture.state, 'update.lock/pid'))).toBe(false)
  }, 20_000)

  test('cleanup開始後のcoordinator死亡はwrite-ahead markerで永久fail-closedにする', async () => {
    const fixture = updaterFixture()
    const setupStarted = join(fixture.base, 'setup-started')
    const setupTermObserved = join(fixture.base, 'setup-term-observed')
    const rollbackSetupCompleted = join(fixture.base, 'rollback-setup-completed')
    writeFileSync(
      fixture.setup,
      [
        '#!/bin/bash',
        `if [ -f '${setupStarted}' ]; then`,
        `  touch '${rollbackSetupCompleted}'`,
        '  exit 0',
        'fi',
        `trap 'touch "${setupTermObserved}"; while :; do sleep 1; done' TERM`,
        `touch '${setupStarted}'`,
        'while :; do sleep 1; done',
        '',
      ].join('\n'),
    )
    const first = spawnUpdater(fixture, ['--skip-tests', '--no-restart'])
    let deadline = Date.now() + 5_000
    while (!existsSync(setupStarted) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(setupStarted)).toBe(true)
    const identity = JSON.parse(
      readFileSync(join(fixture.state, 'update.lock/pid.identity'), 'utf8'),
    ) as { delegate?: { pid?: unknown } }
    const delegatePid = Number(identity.delegate?.pid)
    expect(Number.isInteger(delegatePid) && delegatePid > 0).toBe(true)
    const trackedGroup = snapshotFixtureGroup(delegatePid)

    process.kill(first.pid, 'SIGTERM')
    deadline = Date.now() + 3_000
    while (!existsSync(setupTermObserved) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(setupTermObserved)).toBe(true)
    expect(() => process.kill(delegatePid, 0)).not.toThrow()
    process.kill(first.pid, 'SIGKILL')
    await first.exited

    const second = runUpdater(fixture, ['--recover-only'])
    expect(second.exitCode).toBe(1)
    expect(second.stderr.toString()).toContain('所有者を確認できません')
    expect(existsSync(rollbackSetupCompleted)).toBe(false)

    await stopFixtureGroup(delegatePid, trackedGroup)
    deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try { process.kill(delegatePid, 0); await Bun.sleep(10) } catch { break }
    }
    const recovered = runUpdater(fixture, ['--recover-only'])
    expect(recovered.exitCode).toBe(1)
    expect(recovered.stderr.toString()).toContain('所有者を確認できません')
    expect(existsSync(rollbackSetupCompleted)).toBe(false)
    expect(existsSync(join(fixture.state, 'update.lock/pid'))).toBe(true)
  }, 20_000)

  test('origin/codexへ未反映のlocal commitがあれば停止する', () => {
    const fixture = updaterFixture()
    must(['git', 'config', 'user.email', 'test@example.com'], fixture.repo.local)
    must(['git', 'config', 'user.name', 'test'], fixture.repo.local)
    writeFileSync(join(fixture.repo.local, 'local.txt'), 'local commit\n')
    must(['git', 'add', '.'], fixture.repo.local)
    must(['git', 'commit', '-m', 'local only'], fixture.repo.local)
    const result = runUpdater(fixture)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('origin/codexへ未反映')
    expect(existsSync(fixture.setupMarker)).toBe(false)
  })
})
