#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
} from 'fs'
import { join } from 'path'
import { JobStore } from './job-runner.ts'
import {
  inspectProcessLock,
  releaseProcessLock,
  tryAcquireProcessLock,
  UPDATE_LOCK_OWNER_PATTERN,
  type ProcessLockLease,
} from './process-lock.ts'
import {
  atomicWritePrivateFile,
  readOptionalBoundedOwnerOnlyRegularFile,
} from './safe-file.ts'
import { readGatewayReadiness } from './readiness.ts'
import { resolveZeroJobDatabasePath } from './state-dir.ts'

const CONFIG_VERSION = 1 as const
const JOURNAL_VERSION = 1 as const
const MAX_CONFIG_BYTES = 16 * 1024
const MAX_JOURNAL_BYTES = 32 * 1024
const MAX_CHANNELS = 128
const MUTATION_LOCK_WAIT_MS = 5_000

export interface ProjectChannelConfig {
  version: typeof CONFIG_VERSION
  slackChannels: string[]
}

interface RouteJournal {
  version: typeof JOURNAL_VERSION
  operation: 'set' | 'unset' | 'sync'
  appId: string
  repoPath: string
  beforeChannels: string[]
  afterChannels: string[]
  createdAt: number
}

function ownerMatches(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid()
}

function requireSlackAppId(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^A[A-Z0-9]+$/.test(normalized)) throw new Error(`invalid Slack app ID: ${value}`)
  return normalized
}

export function normalizeSlackChannelId(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[CG][A-Z0-9]+$/.test(normalized)) {
    throw new Error(`SlackチャンネルIDが不正です: ${value}`)
  }
  return normalized
}

function normalizeChannels(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > MAX_CHANNELS) {
    throw new Error(`slackChannelsは最大${MAX_CHANNELS}件です`)
  }
  return [...new Set(values.map(value => {
    if (typeof value !== 'string') throw new Error('slackChannels must contain strings')
    return normalizeSlackChannelId(value)
  }))].sort()
}

function configDirectory(repoPath: string): string {
  return join(repoPath, '.zerochan')
}

export function projectChannelConfigPath(repoPath: string): string {
  return join(configDirectory(repoPath), 'config.json')
}

function requireSafeExistingFile(path: string): void {
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || !ownerMatches(metadata.uid) || (metadata.mode & 0o077) !== 0) {
    throw new Error(`安全でないZeroちゃん設定ファイルです: ${path}`)
  }
}

function directoryIdentity(path: string): { dev: number; ino: number } {
  const metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownerMatches(metadata.uid)) {
    throw new Error(`安全でない.zerochanディレクトリです: ${path}`)
  }
  chmodSync(path, 0o700)
  return { dev: metadata.dev, ino: metadata.ino }
}

function sameDirectory(path: string, expected: { dev: number; ino: number }): void {
  const current = directoryIdentity(path)
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`.zerochanディレクトリが操作中に変更されました: ${path}`)
  }
}

function trackedZerochanFiles(repoPath: string): string[] {
  const result = Bun.spawnSync([
    '/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-C', repoPath, 'ls-files', '--', '.zerochan',
  ], {
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error('Gitのlocal設定状態を確認できませんでした')
  return result.stdout.toString().split('\n').map(value => value.trim()).filter(Boolean)
}

function ensureLocalConfigDirectory(repoPath: string): { dev: number; ino: number } {
  const dir = configDirectory(repoPath)
  const tracked = trackedZerochanFiles(repoPath)
  if (tracked.length > 0) {
    throw new Error(`.zerochanはlocal専用です。Git追跡を解除してください: ${tracked.join(', ')}`)
  }
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const identity = directoryIdentity(dir)
  const ignorePath = join(dir, '.gitignore')
  if (existsSync(ignorePath)) requireSafeExistingFile(ignorePath)
  atomicWritePrivateFile(ignorePath, '*\n')
  chmodSync(ignorePath, 0o600)
  sameDirectory(dir, identity)
  return identity
}

export function readProjectChannelConfig(repoPathInput: string): ProjectChannelConfig {
  const repoPath = realpathSync(repoPathInput)
  const dir = configDirectory(repoPath)
  if (!existsSync(dir)) return { version: CONFIG_VERSION, slackChannels: [] }
  const identity = directoryIdentity(dir)
  const path = projectChannelConfigPath(repoPath)
  let content: string | null
  try {
    content = readOptionalBoundedOwnerOnlyRegularFile(path, MAX_CONFIG_BYTES)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {
      version: CONFIG_VERSION, slackChannels: [],
    }
    throw error
  }
  if (content === null) {
    sameDirectory(dir, identity)
    return { version: CONFIG_VERSION, slackChannels: [] }
  }
  let value: unknown
  try { value = JSON.parse(content) } catch { throw new Error(`Zeroちゃん設定JSONが壊れています: ${path}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Zeroちゃん設定JSONが不正です: ${path}`)
  }
  const record = value as Record<string, unknown>
  if (record.version !== CONFIG_VERSION
    || Object.keys(record).sort().join(',') !== 'slackChannels,version') {
    throw new Error(`未対応のZeroちゃん設定形式です: ${path}`)
  }
  const config: ProjectChannelConfig = {
    version: CONFIG_VERSION,
    slackChannels: normalizeChannels(record.slackChannels),
  }
  sameDirectory(dir, identity)
  return config
}

function writeProjectChannelConfig(repoPath: string, slackChannels: string[]): void {
  const identity = ensureLocalConfigDirectory(repoPath)
  const path = projectChannelConfigPath(repoPath)
  if (existsSync(path)) requireSafeExistingFile(path)
  const config: ProjectChannelConfig = {
    version: CONFIG_VERSION,
    slackChannels: normalizeChannels(slackChannels),
  }
  atomicWritePrivateFile(path, `${JSON.stringify(config, null, 2)}\n`)
  chmodSync(path, 0o600)
  sameDirectory(configDirectory(repoPath), identity)
}

function journalPath(stateDir: string): string {
  return join(stateDir, 'channel-route-transaction.json')
}

function mutationLockPath(stateDir: string): string {
  return join(stateDir, 'channel-route.lock')
}

function parseJournal(content: string): RouteJournal {
  let value: unknown
  try { value = JSON.parse(content) } catch { throw new Error('channel route journal is invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('channel route journal is invalid')
  }
  const record = value as Record<string, unknown>
  if (record.version !== JOURNAL_VERSION
    || !['set', 'unset', 'sync'].includes(String(record.operation))
    || typeof record.appId !== 'string' || typeof record.repoPath !== 'string'
    || !Number.isSafeInteger(record.createdAt) || Number(record.createdAt) <= 0) {
    throw new Error('channel route journal is invalid')
  }
  return {
    version: JOURNAL_VERSION,
    operation: record.operation as RouteJournal['operation'],
    appId: requireSlackAppId(record.appId),
    repoPath: record.repoPath,
    beforeChannels: normalizeChannels(record.beforeChannels),
    afterChannels: normalizeChannels(record.afterChannels),
    createdAt: Number(record.createdAt),
  }
}

function readJournal(stateDir: string): RouteJournal | null {
  const content = readOptionalBoundedOwnerOnlyRegularFile(journalPath(stateDir), MAX_JOURNAL_BYTES)
  return content === null ? null : parseJournal(content)
}

function writeJournal(stateDir: string, journal: RouteJournal): void {
  atomicWritePrivateFile(journalPath(stateDir), `${JSON.stringify(journal)}\n`)
}

function clearJournal(stateDir: string): void {
  const path = journalPath(stateDir)
  try {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = fstatSync(descriptor)
      if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches(metadata.uid)) {
        throw new Error(`unsafe channel route journal: ${path}`)
      }
    } finally {
      closeSync(descriptor)
    }
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function assertUpdateIdle(stateDir: string): void {
  if (existsSync(join(stateDir, 'update-transaction.json'))) {
    throw new Error('Zeroちゃん更新中はSlackチャンネル設定を変更できません')
  }
  const update = inspectProcessLock(join(stateDir, 'update.lock', 'pid'), UPDATE_LOCK_OWNER_PATTERN)
  if (update.status === 'active' || update.status === 'unknown') {
    throw new Error('Zeroちゃん更新中はSlackチャンネル設定を変更できません')
  }
}

function acquireMutationLock(stateDir: string): ProcessLockLease {
  const deadline = Date.now() + MUTATION_LOCK_WAIT_MS
  while (true) {
    const attempt = tryAcquireProcessLock(mutationLockPath(stateDir))
    if (attempt.acquired) return attempt.lease
    if (attempt.kind === 'owner-unavailable') {
      throw new Error('Slackチャンネル設定lockの所有者を確認できません')
    }
    if (Date.now() >= deadline) {
      throw new Error(`別のSlackチャンネル設定が実行中です (PID ${attempt.heldPid})`)
    }
    Bun.sleepSync(50)
  }
}

function recoverJournal(stateDir: string, store: JobStore): void {
  const journal = readJournal(stateDir)
  if (!journal) return
  const repoPath = realpathSync(journal.repoPath)
  if (repoPath !== journal.repoPath) throw new Error('channel route journal project moved')
  store.assertSlackChannelRoutesAvailable(journal.appId, repoPath, journal.afterChannels)
  if (journal.operation === 'sync') {
    store.syncSlackChannelRoutes({
      appId: journal.appId,
      repoPath,
      channelIds: journal.afterChannels,
      configuredAt: journal.createdAt,
    })
  } else if (journal.operation === 'unset') {
    store.syncSlackChannelRoutes({
      appId: journal.appId,
      repoPath,
      channelIds: journal.afterChannels,
      configuredAt: journal.createdAt,
    })
    writeProjectChannelConfig(repoPath, journal.afterChannels)
  } else {
    writeProjectChannelConfig(repoPath, journal.afterChannels)
    store.syncSlackChannelRoutes({
      appId: journal.appId,
      repoPath,
      channelIds: journal.afterChannels,
      configuredAt: journal.createdAt,
    })
  }
  clearJournal(stateDir)
}

export function mutateProjectChannelConfig(input: {
  operation: 'set' | 'unset' | 'sync'
  repoPath: string
  stateDir: string
  appId: string
  channelId?: string
}): ProjectChannelConfig {
  const repoPath = realpathSync(input.repoPath)
  const stateDir = realpathSync(input.stateDir)
  const appId = requireSlackAppId(input.appId)
  const lease = acquireMutationLock(stateDir)
  const lockPath = mutationLockPath(stateDir)
  let store: JobStore | undefined
  try {
    store = new JobStore(resolveZeroJobDatabasePath(stateDir))
    assertUpdateIdle(stateDir)
    recoverJournal(stateDir, store)
    const before = readProjectChannelConfig(repoPath)
    const requested = input.channelId === undefined
      ? undefined
      : normalizeSlackChannelId(input.channelId)
    const afterChannels = input.operation === 'set'
      ? normalizeChannels([...before.slackChannels, requested!])
      : input.operation === 'unset'
        ? before.slackChannels.filter(channel => channel !== requested)
        : before.slackChannels

    if (input.operation === 'unset' && requested) {
      const existing = store.resolveSlackChannelRoute(appId, requested)
      if (existing && existing !== repoPath) {
        throw new Error(`Slack channel ${requested} belongs to another project: ${existing}`)
      }
    }
    store.assertSlackChannelRoutesAvailable(appId, repoPath, afterChannels)
    if (input.operation !== 'sync') ensureLocalConfigDirectory(repoPath)
    const journal: RouteJournal = {
      version: JOURNAL_VERSION,
      operation: input.operation,
      appId,
      repoPath,
      beforeChannels: before.slackChannels,
      afterChannels,
      createdAt: Date.now(),
    }
    writeJournal(stateDir, journal)
    try {
      if (input.operation === 'unset') {
        store.syncSlackChannelRoutes({ appId, repoPath, channelIds: afterChannels })
        writeProjectChannelConfig(repoPath, afterChannels)
      } else {
        if (input.operation === 'set') writeProjectChannelConfig(repoPath, afterChannels)
        store.syncSlackChannelRoutes({ appId, repoPath, channelIds: afterChannels })
      }
    } catch (error) {
      // A synchronous failure is not a crash: restore both authorities to the
      // pre-command state so one bad project cannot strand the shared journal
      // and block every other project's management command.
      try {
        store.syncSlackChannelRoutes({
          appId,
          repoPath,
          channelIds: before.slackChannels,
          configuredAt: journal.createdAt,
        })
        if (input.operation !== 'sync') {
          writeProjectChannelConfig(repoPath, before.slackChannels)
        }
        clearJournal(stateDir)
      } catch {
        // Preserve the journal when rollback itself is impossible. A later
        // invocation can then perform the same idempotent recovery.
      }
      throw error
    }
    clearJournal(stateDir)
    return { version: CONFIG_VERSION, slackChannels: afterChannels }
  } finally {
    store?.close()
    if (!releaseProcessLock(lockPath, lease)) {
      throw new Error('Slackチャンネル設定lockを安全に解放できません')
    }
  }
}

export function projectChannelStatus(input: {
  repoPath: string
  stateDir: string
  appId: string
}): string {
  const repoPath = realpathSync(input.repoPath)
  const stateDir = realpathSync(input.stateDir)
  const appId = requireSlackAppId(input.appId)
  const lease = acquireMutationLock(stateDir)
  const lockPath = mutationLockPath(stateDir)
  let store: JobStore | undefined
  try {
    store = new JobStore(resolveZeroJobDatabasePath(stateDir))
    assertUpdateIdle(stateDir)
    recoverJournal(stateDir, store)
    const config = readProjectChannelConfig(repoPath)
    const routes = store.listSlackChannelRoutes(appId)
    const explicitMode = store.slackChannelRoutingIsExplicit(appId)
    const owned = routes.filter(route => route.repoPath === repoPath)
    const readiness = readGatewayReadiness(join(stateDir, 'gateway-ready.json'))
    const gateway = inspectProcessLock(join(stateDir, 'plugin.lock'), /server\.ts(?:\s|$)/)
    const shared = gateway.status === 'active' && readiness?.pid === gateway.pid
      && readiness.channelRoutingVersion === 1 && readiness.slackAppId === appId
    const lines = [
      `📁 project: ${repoPath}`,
      `▶ Zeroちゃん: ${shared ? `稼働中 (PID ${gateway.pid})` : '停止中'}`,
      config.slackChannels.length > 0
        ? `🔗 Slackチャンネル: ${config.slackChannels.join(', ')}`
        : explicitMode
          ? '🔗 Slackチャンネル: 未設定（新規channel threadは受け付けません）'
          : '🔗 Slackチャンネル: 未設定（初回設定までは従来互換）',
    ]
    const mismatched = config.slackChannels.filter(channel => (
      !owned.some(route => route.channelId === channel)
    ))
    const liveOnly = owned
      .map(route => route.channelId)
      .filter(channel => !config.slackChannels.includes(channel))
    if (mismatched.length > 0) lines.push(`⚠️ local設定のみ（未反映）: ${mismatched.join(', ')}`)
    if (liveOnly.length > 0) lines.push(`⚠️ local設定にない稼働routing: ${liveOnly.join(', ')}`)
    return `${lines.join('\n')}\n`
  } finally {
    store?.close()
    if (!releaseProcessLock(lockPath, lease)) {
      throw new Error('Slackチャンネル設定lockを安全に解放できません')
    }
  }
}

function usage(): never {
  throw new Error(
    'usage: project-channel-config.ts set|unset <repo> <state> <app-id> <channel-id>'
    + ' | sync|status <repo> <state> <app-id>',
  )
}

if (import.meta.main) {
  try {
    const [command, repoPath, stateDir, appId, channelId, ...extra] = process.argv.slice(2)
    if (!repoPath || !stateDir || !appId || extra.length > 0) usage()
    if ((command === 'set' || command === 'unset') && channelId) {
      const config = mutateProjectChannelConfig({
        operation: command,
        repoPath,
        stateDir,
        appId,
        channelId,
      })
      process.stdout.write(`${command === 'set' ? '🔗 設定しました' : '🔓 解除しました'}: ${normalizeSlackChannelId(channelId)}\n`)
      process.stdout.write(`   project: ${repoPath}\n`)
      process.stdout.write(`   channels: ${config.slackChannels.join(', ') || 'なし'}\n`)
    } else if (command === 'sync' && channelId === undefined) {
      mutateProjectChannelConfig({ operation: 'sync', repoPath, stateDir, appId })
    } else if (command === 'status' && channelId === undefined) {
      process.stdout.write(projectChannelStatus({ repoPath, stateDir, appId }))
    } else {
      usage()
    }
  } catch (error) {
    process.stderr.write(`❌ ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
