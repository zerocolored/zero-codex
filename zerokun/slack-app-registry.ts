import { readdirSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { prepareManagedStateRoot, requireManagedStateRoot } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { parseStateSlackTokens } from './child-environment.ts'
import { appIdFromAppToken } from './slack-app-identity.ts'
import { releaseProcessLock, tryAcquireProcessLock } from './process-lock.ts'
import { resolveZeroStateDir } from './state-dir.ts'

export interface RegisteredSlackApp {
  version: 1
  appId: string
  stateDir: string
}

export function requireAppId(value: string): string {
  if (!/^A[A-Z0-9]{1,63}$/.test(value)) throw new Error('Slack App IDが不正です')
  return value
}

export function slackAppRegistryRoot(home = homedir()): string {
  return join(home, '.codex', 'zerochan-apps')
}

export function withSlackAppRegistryLock<T>(home: string, action: () => T): T {
  const root = prepareManagedStateRoot(slackAppRegistryRoot(home))
  const path = join(root, 'registry.lock')
  const deadline = Date.now() + 5000
  while (true) {
    const attempt = tryAcquireProcessLock(path)
    if (attempt.acquired) {
      try {
        const updatePath = join(root, 'shared-update.lock')
        const update = tryAcquireProcessLock(updatePath)
        if (!update.acquired) throw new Error('Slackアプリの更新中です。終了後に登録してください')
        try { return action() }
        finally { releaseProcessLock(updatePath, update.lease) }
      }
      finally { if (!releaseProcessLock(path, attempt.lease)) throw new Error('Slackアプリ登録lockを解放できません') }
    }
    if (Date.now() >= deadline || attempt.kind === 'owner-unavailable') {
      throw new Error('別のSlackアプリ登録が実行中です。終了後に再実行してください')
    }
    Bun.sleepSync(50)
  }
}

/** Credentials remain in the selected private state, never in registry metadata. */
export function registerSlackApp(appId: string, stateDir: string, home = homedir()): RegisteredSlackApp {
  return withSlackAppRegistryLock(home, () => registerSlackAppUnlocked(appId, stateDir, home))
}

function registerSlackAppUnlocked(appId: string, stateDir: string, home: string): RegisteredSlackApp {
  requireAppId(appId)
  const physicalState = requireManagedStateRoot(stateDir)
  const root = prepareManagedStateRoot(slackAppRegistryRoot(home))
  const existing = readRegisteredSlackApp(appId, home)
  if (existing && existing.stateDir !== physicalState) {
    throw new Error('このSlackアプリは別の保存先で登録済みです。登録済みアプリを選択してください')
  }
  const record: RegisteredSlackApp = { version: 1, appId, stateDir: physicalState }
  atomicWritePrivateFile(join(root, `${appId}.json`), JSON.stringify(record) + '\n')
  return record
}

export function saveNewSlackApp(appId: string, botToken: string, appToken: string, home = homedir()): RegisteredSlackApp {
  requireAppId(appId)
  if (appIdFromAppToken(appToken) !== appId || !/^xoxb-[A-Za-z0-9._-]{10,}$/.test(botToken)) {
    throw new Error('Slackアプリの認証形式が不正です')
  }
  return withSlackAppRegistryLock(home, () => {
    if (readRegisteredSlackApp(appId, home)) throw new Error('このアプリは登録済みです。一覧から選択してください')
    const state = prepareManagedStateRoot(join(slackAppRegistryRoot(home), 'states', appId))
    const path = join(state, '.env')
    const previous = readOptionalBoundedOwnerOnlyRegularFile(path, 64 * 1024)
    const content = `SLACK_BOT_TOKEN=${botToken}\nSLACK_APP_TOKEN=${appToken}\n`
    if (previous !== null && previous !== content) throw new Error('未完了のアプリ登録があります。既存の認証情報は保持しました')
    atomicWritePrivateFile(path, content)
    return registerSlackAppUnlocked(appId, state, home)
  })
}

function readRegisteredSlackAppMetadata(appId: string, home: string): RegisteredSlackApp | null {
  requireAppId(appId)
  const content = readOptionalBoundedOwnerOnlyRegularFile(
    join(slackAppRegistryRoot(home), `${appId}.json`), 8192,
  )
  if (content === null) return null
  const record = JSON.parse(content)
  if (record?.version !== 1 || record.appId !== appId || typeof record.stateDir !== 'string'
    || !isAbsolute(record.stateDir) || record.stateDir.includes('\0')) {
    throw new Error('Slackアプリの登録情報が不正です')
  }
  return { version: 1, appId, stateDir: resolve(record.stateDir) }
}

export function readRegisteredSlackApp(appId: string, home = homedir()): RegisteredSlackApp | null {
  const record = readRegisteredSlackAppMetadata(appId, home)
  return record ? { ...record, stateDir: requireManagedStateRoot(record.stateDir) } : null
}

/** Permission denies must also cover registered directories that no longer exist. */
export function registeredSlackAppStatePaths(home = homedir()): string[] {
  return registeredSlackAppIds(home).flatMap(appId => {
    const record = readRegisteredSlackAppMetadata(appId, home)
    return record ? [record.stateDir] : []
  })
}

function registeredSlackAppIds(home = homedir()): string[] {
  let names: string[]
  try { names = readdirSync(slackAppRegistryRoot(home)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.filter(name => /^A[A-Z0-9]{1,63}\.json$/.test(name)).sort()
    .map(name => name.slice(0, -5))
}

export function listRegisteredSlackApps(home = homedir()): RegisteredSlackApp[] {
  return registeredSlackAppIds(home).map(appId => readRegisteredSlackApp(appId, home)!)
}

/** Adopt the existing installation in place; never copy its credentials or queue. */
export function adoptLegacySlackApp(home = homedir(), environment: Record<string, string | undefined> = home === homedir() ? process.env : {}): RegisteredSlackApp | null {
  const selected = resolveZeroStateDir(environment, home)
  let result: RegisteredSlackApp | null = null
  for (const state of new Set([join(home, '.codex', 'zerokun'), selected])) {
    const adopted = adoptExistingSlackApp(state, home)
    if (adopted) result = adopted
  }
  return result
}

function adoptExistingSlackApp(state: string, home: string): RegisteredSlackApp | null {
  const content = readOptionalBoundedOwnerOnlyRegularFile(join(state, '.env'), 64 * 1024)
  if (content === null) return null
  const tokens = parseStateSlackTokens(content)
  if (!tokens.SLACK_APP_TOKEN || !tokens.SLACK_BOT_TOKEN) return null
  let appId: string
  try { appId = appIdFromAppToken(tokens.SLACK_APP_TOKEN) }
  catch { return null }
  const existing = readRegisteredSlackApp(appId, home)
  return existing ?? registerSlackApp(appId, state, home)
}
