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
import { dirname, join } from 'path'
import { Database } from 'bun:sqlite'
import { runtimeRootForState } from './runtime-release.ts'
import { DEFAULT_PRIMARY_CORE, isPrimaryCore, type PrimaryCore } from './primary-core.ts'
import { SlackProjectDisconnectedError } from './slack-project-admission.ts'
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
import {
  ensureWorkspacePin,
  resolveProjectLayout,
} from './project-layout.ts'

const CONFIG_VERSION = 1 as const
const JOURNAL_VERSION = 1 as const
const MAX_CONFIG_BYTES = 16 * 1024
const MAX_JOURNAL_BYTES = 32 * 1024
const MAX_CHANNELS = 128
const MUTATION_LOCK_WAIT_MS = 5_000

export interface ProjectChannelConfig {
  version: typeof CONFIG_VERSION
  slackChannels: string[]
  slackAppId?: string | null
  slackAcceptAfter?: number
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
  const layout = resolveProjectLayout(repoPath)
  if (layout.kind === 'multi-repo-workspace') return []
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
  const layout = resolveProjectLayout(repoPath)
  ensureWorkspacePin(layout)
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
    || !['slackChannels,version', 'slackAppId,slackChannels,version'].includes(Object.keys(record).filter(key => key !== 'slackAcceptAfter').sort().join(','))) {
    throw new Error(`未対応のZeroちゃん設定形式です: ${path}`)
  }
  const config: ProjectChannelConfig = {
    version: CONFIG_VERSION,
    slackChannels: normalizeChannels(record.slackChannels),
    ...(record.slackAppId === undefined ? {} : { slackAppId: record.slackAppId === null ? null : requireSlackAppId(String(record.slackAppId)) }),
  }
  if (record.slackAcceptAfter !== undefined) {
    if (!Number.isSafeInteger(record.slackAcceptAfter) || Number(record.slackAcceptAfter) <= 0) throw new Error('Slack受付時刻が不正です')
    config.slackAcceptAfter = Number(record.slackAcceptAfter)
  }
  if (config.slackAppId === null && config.slackChannels.length) throw new Error('解除済みプロジェクトにチャンネル設定があります')
  sameDirectory(dir, identity)
  return config
}

function withProjectConfigLock<T>(repoPath: string, action: () => T): T {
  ensureLocalConfigDirectory(repoPath)
  const path = join(configDirectory(repoPath), 'config.lock')
  const deadline = Date.now() + MUTATION_LOCK_WAIT_MS
  while (true) {
    const lock = tryAcquireProcessLock(path)
    if (lock.acquired) {
      try { return action() }
      finally { releaseProcessLock(path, lock.lease) }
    }
    if (Date.now() >= deadline || lock.kind === 'owner-unavailable') throw new Error('別のプロジェクト設定操作が実行中です')
    Bun.sleepSync(50)
  }
}

export function projectPrimaryCore(repoPath: string): { desired: PrimaryCore; active: PrimaryCore } {
  const dir = configDirectory(realpathSync(repoPath))
  const defaults = { desired: DEFAULT_PRIMARY_CORE, active: DEFAULT_PRIMARY_CORE }
  if (!existsSync(dir)) return defaults
  const identity = directoryIdentity(dir)
  const raw = readOptionalBoundedOwnerOnlyRegularFile(join(dir, 'primary-core.json'), MAX_CONFIG_BYTES)
  sameDirectory(dir, identity)
  if (!raw) return defaults
  const config = JSON.parse(raw)
  if (config?.version !== 1 || Object.keys(config).sort().join(',') !== 'active,desired,version'
    || !isPrimaryCore(config.desired) || !isPrimaryCore(config.active)) throw new Error('主担当の設定が不正です')
  return { desired: config.desired, active: config.active }
}

export function setProjectPrimaryCore(repoPathInput: string, core: PrimaryCore): void {
  if (!isPrimaryCore(core)) throw new Error('主担当の設定が不正です')
  const repoPath = realpathSync(repoPathInput)
  withProjectConfigLock(repoPath, () => {
    const before = projectPrimaryCore(repoPath)
    // Keep the channel file compatible with the gateway still accepting input.
    atomicWritePrivateFile(join(configDirectory(repoPath), 'primary-core.json'), JSON.stringify({ version: 1, ...before, desired: core }, null, 2) + '\n')
  })
}

/** The caller completes runtime preflight before publishing this activation.
 * Compare the selected value under the same lock to preserve concurrent set. */
export function activateProjectPrimaryCore(repoPathInput: string, expected: PrimaryCore): void {
  const repoPath = realpathSync(repoPathInput)
  withProjectConfigLock(repoPath, () => {
    const before = projectPrimaryCore(repoPath)
    if (before.desired !== expected) throw new Error('起動中に主担当設定が変更されました。zerochan start を再実行してください')
    atomicWritePrivateFile(join(configDirectory(repoPath), 'primary-core.json'), JSON.stringify({ version: 1, ...before, active: expected }, null, 2) + '\n')
  })
}

function writeProjectChannelConfig(repoPath: string, slackChannels: string[], appId?: string): void {
  withProjectConfigLock(repoPath, () => {
  const identity = ensureLocalConfigDirectory(repoPath)
  const path = projectChannelConfigPath(repoPath)
  if (existsSync(path)) requireSafeExistingFile(path)
  const before = readProjectChannelConfig(repoPath)
  assertProjectSlackAppAttached(repoPath)
  if (appId && before.slackAppId && before.slackAppId !== appId) throw new Error('プロジェクトと接続先Slackアプリが一致しません')
  const config: ProjectChannelConfig = {
    ...before,
    version: CONFIG_VERSION,
    slackChannels: normalizeChannels(slackChannels),
    ...(before.slackAppId ? { slackAppId: before.slackAppId } : {}),
  }
  atomicWritePrivateFile(path, `${JSON.stringify(config, null, 2)}\n`)
  chmodSync(path, 0o600)
  sameDirectory(configDirectory(repoPath), identity)
  })
}

/** Bind once without copying credentials or silently moving existing channel routes. */
export function bindProjectSlackApp(repoPathInput: string, appIdInput: string, verifyExistingChannels?: (channels: string[]) => boolean): void {
  const repoPath = realpathSync(repoPathInput)
  const appId = requireSlackAppId(appIdInput)
  withProjectConfigLock(repoPath, () => {
  const identity = ensureLocalConfigDirectory(repoPath)
  const before = readProjectChannelConfig(repoPath)
  assertProjectSlackAppAttached(repoPath)
  if (before.slackAppId && before.slackAppId !== appId) {
    throw new Error('このプロジェクトは別のSlackアプリに接続済みです。接続先の変更には既存設定の移行が必要です')
  }
  if (!before.slackAppId && before.slackChannels.length && !verifyExistingChannels?.(before.slackChannels)) {
    throw new Error('既存チャンネルは別のアプリで利用中、または接続元を確認できません。先に元の設定で zerochan unset slack-channel を実行してください')
  }
  atomicWritePrivateFile(projectChannelConfigPath(repoPath), JSON.stringify({ ...before, slackAppId: appId }, null, 2) + '\n')
  sameDirectory(configDirectory(repoPath), identity)
  })
}

interface AppSwitchJournal {
  version: 1
  direction: 'forward' | 'rollback'
  before: ProjectChannelConfig
  targetAppId: string
  routes: Array<{ appId: string; stateDir: string; channels: string[]; configuredAt?: Record<string, number>; explicitMode?: boolean }>
}

/** Explicit CLI selection moves routing only; jobs, threads and credentials stay put. */
export function switchProjectSlackApp(
  repoPathInput: string,
  targetAppIdInput: string,
  registeredApps: Array<{ appId: string; stateDir: string }>,
): void {
  const repoPath = realpathSync(repoPathInput)
  const targetAppId = requireSlackAppId(targetAppIdInput)
  const apps = registeredApps.map(app => ({ appId: requireSlackAppId(app.appId), stateDir: realpathSync(app.stateDir) }))
  if (!apps.some(app => app.appId === targetAppId)) throw new Error('選択したSlackアプリが未登録です')
  // The same lock order is used for every switch, including reverse switches.
  // Lock all registered states so legacy routes can be discovered without races.
  const leases: Array<{ path: string; lease: ProcessLockLease }> = []
  const stores = new Map<string, JobStore>()
  const journalFile = join(configDirectory(repoPath), 'slack-app-switch.json')
  try {
    for (const state of [...new Set(apps.map(app => app.stateDir))].sort()) {
      const lease = acquireMutationLock(state)
      leases.push({ path: mutationLockPath(state), lease })
      assertUpdateIdle(state)
      const store = new JobStore(resolveZeroJobDatabasePath(state))
      stores.set(state, store)
      recoverJournal(state, store)
    }
    withProjectConfigLock(repoPath, () => {
      assertNoPendingAppUnset(repoPath)
      const saveConfig = (config: ProjectChannelConfig) => atomicWritePrivateFile(projectChannelConfigPath(repoPath), JSON.stringify(config, null, 2) + '\n')
      const saveJournal = (journal: AppSwitchJournal) => atomicWritePrivateFile(journalFile, JSON.stringify(journal) + '\n')
      const apply = (journal: AppSwitchJournal) => {
        // Check every destination before removing any route.
        for (const route of journal.routes) {
          const channels = journal.direction === 'rollback' ? route.channels
            : route.appId === journal.targetAppId ? journal.before.slackChannels : []
          stores.get(route.stateDir)!.assertSlackChannelRoutesAvailable(route.appId, repoPath, channels)
        }
        // Remove old routes first. Existing accepted jobs and thread history are untouched.
        const ordered = [...journal.routes].sort((a, b) => Number(a.appId === journal.targetAppId) - Number(b.appId === journal.targetAppId))
        for (const route of ordered) {
          const channels = journal.direction === 'rollback' ? route.channels
            : route.appId === journal.targetAppId ? journal.before.slackChannels : []
          const store = stores.get(route.stateDir)!
          if (journal.direction === 'rollback' && route.configuredAt) {
            // Rebuild only this project's rows with their original catch-up times.
            store.syncSlackChannelRoutes({ appId: route.appId, repoPath, channelIds: [] })
            const restored: string[] = []
            for (const channel of channels) {
              restored.push(channel)
              store.syncSlackChannelRoutes({ appId: route.appId, repoPath, channelIds: restored, configuredAt: route.configuredAt[channel] })
            }
          } else {
            store.syncSlackChannelRoutes({ appId: route.appId, repoPath, channelIds: channels })
          }
          if (journal.direction === 'rollback' && route.explicitMode === false) store.restoreSlackChannelImplicitModeAfterRollback(route.appId)
        }
        saveConfig(journal.direction === 'rollback' ? journal.before : { ...journal.before, slackAppId: journal.targetAppId, ...(journal.before.slackAppId === null ? { slackAcceptAfter: Date.now() } : {}) })
        unlinkSync(journalFile)
      }
      const pending = readOptionalBoundedOwnerOnlyRegularFile(journalFile, MAX_JOURNAL_BYTES)
      if (pending !== null) {
        const journal = JSON.parse(pending) as AppSwitchJournal
        if (journal.version !== 1 || !['forward', 'rollback'].includes(journal.direction)
          || !apps.some(app => app.appId === journal.targetAppId) || !Array.isArray(journal.routes)
          || journal.before?.version !== 1 || (journal.before.slackAppId != null && !apps.some(app => app.appId === journal.before.slackAppId))
          || !journal.routes.some(route => route.appId === journal.targetAppId)
          || new Set(journal.routes.map(route => route.appId)).size !== journal.routes.length
          || journal.routes.some(route => !apps.some(app => app.appId === route.appId && app.stateDir === route.stateDir))) {
          throw new Error('Slackアプリ切り替えの保存記録と登録情報が一致しません')
        }
        journal.before.slackChannels = normalizeChannels(journal.before.slackChannels)
        for (const route of journal.routes) {
          route.channels = normalizeChannels(route.channels)
          if (route.configuredAt && route.channels.some(channel => !Number.isSafeInteger(route.configuredAt![channel]) || route.configuredAt![channel]! <= 0)) {
            throw new Error('Slackアプリ切り替えの経路時刻を読み取れません')
          }
        }
        const current = readProjectChannelConfig(repoPath)
        if (current.slackAppId !== journal.before.slackAppId && current.slackAppId !== journal.targetAppId) {
          throw new Error('Slackアプリ切り替え中に接続先が変更されています')
        }
        apply(journal)
      }
      const before = readProjectChannelConfig(repoPath)
      if (before.slackAppId && !apps.some(app => app.appId === before.slackAppId)) {
        throw new Error('元のSlackアプリが未登録です。既存設定は変更していません')
      }
      const routes = apps.map(app => {
        const owned = stores.get(app.stateDir)!.listSlackChannelRoutes(app.appId).filter(route => route.repoPath === repoPath)
        return { ...app, channels: owned.map(route => route.channelId), configuredAt: Object.fromEntries(owned.map(route => [route.channelId, route.configuredAt])), explicitMode: stores.get(app.stateDir)!.slackChannelRoutingIsExplicit(app.appId) }
      })
      if (before.slackAppId === targetAppId && routes.every(route => JSON.stringify(route.channels) === JSON.stringify(route.appId === targetAppId ? before.slackChannels : []))) return
      stores.get(apps.find(app => app.appId === targetAppId)!.stateDir)!
        .assertSlackChannelRoutesAvailable(targetAppId, repoPath, before.slackChannels)
      const journal: AppSwitchJournal = { version: 1, direction: 'forward', before, targetAppId, routes }
      saveJournal(journal)
      try { apply(journal) }
      catch (error) {
        // Record rollback direction BEFORE restoring anything; a crash while
        // rolling back must never be interpreted as a request to roll forward.
        journal.direction = 'rollback'
        saveJournal(journal)
        try { apply(journal) } catch { /* Keep the durable rollback for the next selection. */ }
        throw error
      }
    })
  } finally {
    for (const store of stores.values()) store.close()
    for (const entry of leases.reverse()) releaseProcessLock(entry.path, entry.lease)
  }
}

function journalPath(stateDir: string): string {
  return join(stateDir, 'channel-route-transaction.json')
}

export function assertNoPendingAppUnset(repoPath: string): void {
  if (existsSync(join(configDirectory(repoPath), 'slack-app-unset.json'))) {
    throw new Error('Slackアプリの解除を復旧するため zerochan unset slack-app を再実行してください')
  }
}

export function assertProjectSlackAppAttached(repoPath: string): void {
  assertNoPendingAppUnset(repoPath)
  if (readProjectChannelConfig(repoPath).slackAppId === null) throw new SlackProjectDisconnectedError()
}

/** Discover historical ownership without migrating or recovering unrelated apps. */
function appHasProjectHistory(stateDir: string, repoPath: string): boolean {
  const raw = readOptionalBoundedOwnerOnlyRegularFile(journalPath(stateDir), MAX_JOURNAL_BYTES)
  if (raw !== null) {
    // Discovery needs only ownership. Validate the whole operation only when
    // recovering a related app; malformed foreign journals stay untouched.
    try { if (JSON.parse(raw)?.repoPath === repoPath) return true } catch { /* Cannot be replayed as a valid route transaction. */ }
  }
  const path = resolveZeroJobDatabasePath(stateDir)
  if (!existsSync(path)) return false
  const db = new Database(path, { readonly: true })
  try {
    db.exec('PRAGMA busy_timeout=5000')
    for (const table of ['slack_threads', 'slack_channel_routes']) {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue
      if (db.query(`SELECT 1 FROM ${table} WHERE repo_path = ? LIMIT 1`).get(repoPath)) return true
    }
    return false
  } finally { db.close() }
}

/** Forward-only recovery: block admission before deleting routes. No credentials,
 * accepted jobs, thread history, service state or other projects are removed. */
export function unsetProjectSlackApp(
  repoPathInput: string,
  registeredApps: Array<{ appId: string; stateDir: string }>,
): void {
  const repoPath = realpathSync(repoPathInput)
  resolveProjectLayout(repoPath)
  const apps = registeredApps.map(app => ({ appId: requireSlackAppId(app.appId), stateDir: realpathSync(app.stateDir) }))
  const leases: Array<{ path: string; lease: ProcessLockLease }> = []
  const stores = new Map<string, JobStore>()
  const journalFile = join(configDirectory(repoPath), 'slack-app-unset.json')
  const initial = readProjectChannelConfig(repoPath)
  const pending = readOptionalBoundedOwnerOnlyRegularFile(journalFile, MAX_JOURNAL_BYTES)
  if (pending === null && initial.slackAppId === null) return
  const journal = pending === null ? null : JSON.parse(pending)
  if (journal !== null && (journal.version !== 1 || journal.repoPath !== repoPath || !Array.isArray(journal.apps)
    || new Set(journal.apps.map((app: { appId: string }) => app.appId)).size !== journal.apps.length
    || journal.apps.some((app: { appId: string; stateDir: string }) => !apps.some(current => current.appId === app.appId && current.stateDir === app.stateDir)))) {
    throw new Error('Slackアプリ解除の保存記録と登録情報が一致しません')
  }
  // The caller holds the registry lock against app switches. Current ownership,
  // historical routes/threads, bootstrap gateways and interrupted transactions
  // all remain in scope; other apps need no mutation lease or update preflight.
  const owners = apps.filter(app => app.appId === initial.slackAppId
    || readGatewayReadiness(join(app.stateDir, 'gateway-ready.json'))?.projectDir === repoPath
    || appHasProjectHistory(app.stateDir, repoPath))
  // Older journals listed every registered app. Retain their recovery scope
  // without requiring unrelated runtimes to support this project's admission.
  const targets = apps.filter(app => owners.includes(app)
    || journal?.apps.some((saved: { appId: string }) => saved.appId === app.appId))
  try {
    for (const state of [...new Set(targets.map(app => app.stateDir))].sort()) {
      const lease = acquireMutationLock(state)
      leases.push({ path: mutationLockPath(state), lease })
      assertUpdateIdle(state)
    }
    // Reject unsupported runtimes before JobStore can migrate a database or
    // recover another project's journal in the same app.
    for (const app of owners) {
      const readiness = readGatewayReadiness(join(app.stateDir, 'gateway-ready.json'))
      const root = runtimeRootForState(app.stateDir, dirname(import.meta.dir))
      const gateway = inspectProcessLock(join(app.stateDir, 'plugin.lock'), /server\.ts(?:\s|$)/)
      if (!existsSync(join(root, 'zerokun', 'slack-project-admission.ts'))
        || gateway.status === 'unknown'
        || (gateway.status === 'active' && (readiness?.pid !== gateway.pid || readiness.projectDisconnectVersion !== 1))) {
        throw new Error(`Slackアプリ ${app.appId} の実行版が解除機能に未対応です。先にそのアプリを zerochan update で更新してください（設定は変更していません）`)
      }
    }
    for (const state of [...new Set(targets.map(app => app.stateDir))].sort()) {
      const store = new JobStore(resolveZeroJobDatabasePath(state))
      stores.set(state, store)
      recoverJournal(state, store)
    }
    withProjectConfigLock(repoPath, () => {
      if (existsSync(join(configDirectory(repoPath), 'slack-app-switch.json'))) {
        throw new Error('先に zerochan set slack-app で中断した切り替えを復旧してください')
      }
      const before = readProjectChannelConfig(repoPath)
      if (before.slackAppId !== initial.slackAppId
        || readOptionalBoundedOwnerOnlyRegularFile(journalFile, MAX_JOURNAL_BYTES) !== pending) {
        throw new Error('Slackアプリの接続状態が変更されました。解除を再実行してください')
      }
      if (before.slackAppId && !apps.some(app => app.appId === before.slackAppId)) {
        throw new Error('接続元のSlackアプリが未登録のため解除できません')
      }
      if (!apps.length && before.slackAppId === undefined) {
        throw new Error('このPCに登録済みのSlackアプリがありません')
      }
      if (pending === null) atomicWritePrivateFile(journalFile, JSON.stringify({ version: 1, repoPath, apps: targets }) + '\n')
      // The journal itself blocks new admission, including after a crash here.
      atomicWritePrivateFile(projectChannelConfigPath(repoPath), JSON.stringify({
        ...before,
        version: CONFIG_VERSION, slackAppId: null, slackChannels: [],
        ...(before.slackAcceptAfter === undefined ? {} : { slackAcceptAfter: before.slackAcceptAfter }),
      } satisfies ProjectChannelConfig, null, 2) + '\n')
      for (const app of targets) stores.get(app.stateDir)!.syncSlackChannelRoutes({ appId: app.appId, repoPath, channelIds: [] })
      unlinkSync(journalFile)
    })
  } finally {
    for (const store of stores.values()) store.close()
    for (const entry of leases.reverse()) releaseProcessLock(entry.path, entry.lease)
  }
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
  assertProjectSlackAppAttached(repoPath)
  const binding = readProjectChannelConfig(repoPath).slackAppId
  if (binding && binding !== journal.appId) throw new Error('保存されたチャンネル設定とSlackアプリが一致しません')
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
    writeProjectChannelConfig(repoPath, journal.afterChannels, journal.appId)
  } else {
    writeProjectChannelConfig(repoPath, journal.afterChannels, journal.appId)
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
  assertProjectSlackAppAttached(repoPath)
  const appId = requireSlackAppId(input.appId)
  const lease = acquireMutationLock(stateDir)
  const lockPath = mutationLockPath(stateDir)
  let store: JobStore | undefined
  try {
    store = new JobStore(resolveZeroJobDatabasePath(stateDir))
    assertUpdateIdle(stateDir)
    assertProjectSlackAppAttached(repoPath)
    if (existsSync(join(configDirectory(repoPath), 'slack-app-switch.json'))) {
      throw new Error('Slackアプリの切り替えを復旧するため zerochan set slack-app を再実行してください')
    }
    recoverJournal(stateDir, store)
    const layout = resolveProjectLayout(repoPath)
    if (layout.kind === 'multi-repo-workspace') ensureLocalConfigDirectory(repoPath)
    const before = readProjectChannelConfig(repoPath)
    if (before.slackAppId && before.slackAppId !== appId) {
      throw new Error('プロジェクトと接続先Slackアプリが一致しません')
    }
    const requested = input.channelId === undefined
      ? undefined
      : normalizeSlackChannelId(input.channelId)
    const afterChannels = input.operation === 'set'
      ? normalizeChannels([...before.slackChannels, requested!])
      : input.operation === 'unset'
        ? requested === undefined
          ? []
          : before.slackChannels.filter(channel => channel !== requested)
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
        writeProjectChannelConfig(repoPath, afterChannels, appId)
      } else {
        if (input.operation === 'set') writeProjectChannelConfig(repoPath, afterChannels, appId)
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
          writeProjectChannelConfig(repoPath, before.slackChannels, appId)
        }
        clearJournal(stateDir)
      } catch {
        // Preserve the journal when rollback itself is impossible. A later
        // invocation can then perform the same idempotent recovery.
      }
      throw error
    }
    clearJournal(stateDir)
    return { ...before, slackChannels: afterChannels }
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
  assertProjectSlackAppAttached(repoPath)
  const appId = requireSlackAppId(input.appId)
  const lease = acquireMutationLock(stateDir)
  const lockPath = mutationLockPath(stateDir)
  let store: JobStore | undefined
  try {
    store = new JobStore(resolveZeroJobDatabasePath(stateDir))
    assertUpdateIdle(stateDir)
    const pendingSwitch = existsSync(join(configDirectory(repoPath), 'slack-app-switch.json'))
    if (!pendingSwitch) recoverJournal(stateDir, store)
    const config = readProjectChannelConfig(repoPath)
    const layout = resolveProjectLayout(repoPath)
    const routes = store.listSlackChannelRoutes(appId)
    const explicitMode = store.slackChannelRoutingIsExplicit(appId)
    const owned = routes.filter(route => route.repoPath === repoPath)
    const readiness = readGatewayReadiness(join(stateDir, 'gateway-ready.json'))
    const gateway = inspectProcessLock(join(stateDir, 'plugin.lock'), /server\.ts(?:\s|$)/)
    const shared = gateway.status === 'active' && readiness?.pid === gateway.pid
      && readiness.channelRoutingVersion === 1 && readiness.slackAppId === appId
    const lines = [
      `📁 project: ${repoPath}`,
      `🔗 Slackアプリ: ${appId}`,
      ...(pendingSwitch ? ['⚠️ アプリ切り替えが中断されています。zerochan set slack-app を再実行すると復旧します。'] : []),
      ...(layout.kind === 'multi-repo-workspace'
        ? [`🧩 repositories: ${layout.memberNames.join(', ')}`]
        : []),
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
    'usage: project-channel-config.ts set <repo> <state> <app-id> <channel-id>'
    + ' | unset|sync|status <repo> <state> <app-id>',
  )
}

if (import.meta.main) {
  try {
    const [command, repoPath, stateDir, appId, channelId, ...extra] = process.argv.slice(2)
    if (!repoPath || !stateDir || !appId || extra.length > 0) usage()
    if (command === 'set' && channelId) {
      const config = mutateProjectChannelConfig({
        operation: 'set',
        repoPath,
        stateDir,
        appId,
        channelId,
      })
      process.stdout.write(`🔗 設定しました: ${normalizeSlackChannelId(channelId)}\n`)
      process.stdout.write(`   project: ${repoPath}\n`)
      process.stdout.write(`   channels: ${config.slackChannels.join(', ') || 'なし'}\n`)
    } else if (command === 'unset' && channelId === undefined) {
      const config = mutateProjectChannelConfig({
        operation: 'unset', repoPath, stateDir, appId,
      })
      process.stdout.write('🔓 Slackチャンネルの紐付けをすべて解除しました\n')
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
