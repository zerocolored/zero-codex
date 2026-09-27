import { join } from 'path'
import { homedir } from 'os'
import { prepareManagedStateRoot } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalPrivateFile } from './safe-file.ts'
import { slackAppRegistryRoot } from './slack-app-registry.ts'
import { tryAcquireProcessLock, releaseProcessLock, inspectProcessLock } from './process-lock.ts'
import { preflightRepositories } from './update.ts'

export const AUTO_UPDATE_INTERVAL_MS = 30 * 60_000
export function automaticUpdateRecipient(allowFrom: string[]): string {
  return allowFrom.find(id => /^[UW][A-Z0-9]+$/.test(id)) ?? ''
}
type RecordState = { checkedAt?: number; pendingState?: string; pendingId?: string; targetSha?: string; failedSha?: string }
function readJson(path: string): any {
  const value = readOptionalPrivateFile(path)
  return value === null ? {} : JSON.parse(value)
}
export function automaticUpdatesEnabled(root: string): boolean {
  return readJson(join(root, 'auto-update-config.json')).enabled !== false
}
export function configureAutomaticUpdates(root: string, enabled: boolean): void {
  prepareManagedStateRoot(root)
  atomicWritePrivateFile(join(root, 'auto-update-config.json'), JSON.stringify({ enabled }) + '\n')
}

/** Short-lived shared scheduler lock, never the updater's own mutation lock. */
export async function checkAutomaticUpdate(options: {
  root: string
  stateDir: string
  now?: () => number
  detect: () => Promise<string | undefined>
  enqueue: (sha: string) => Promise<{ request: { id: string }; accepted: boolean }>
  recoverPending?: (stateDir: string) => void
}): Promise<string> {
  prepareManagedStateRoot(options.root)
  const lockPath = join(options.root, 'auto-update-check.lock')
  const lock = tryAcquireProcessLock(lockPath)
  if (!lock.acquired) return 'busy'
  try {
    if (!automaticUpdatesEnabled(options.root)) return 'disabled'
    const updating = inspectProcessLock(join(options.root, 'shared-update.lock'))
    if (updating.status === 'active' || updating.status === 'unknown') return 'busy'
    const path = join(options.root, 'auto-update-check.json')
    const saved: RecordState = readJson(path)
    const now = (options.now ?? Date.now)()
    if (saved.pendingState && saved.pendingId) {
      const request = readJson(join(saved.pendingState, 'update-request.json'))
      if (request.id === saved.pendingId && request.outcome?.success === false && saved.targetSha) {
        saved.failedSha = saved.targetSha
        // Persist before cooldown: a later manual request can replace this outcome.
        atomicWritePrivateFile(path, JSON.stringify(saved) + '\n')
      }
      if (request.id === saved.pendingId && !request.outcome?.notifiedAt
        && !(request.source === 'automatic' && request.outcome?.notificationSkippedAt)) {
        // The originating gateway may be stopped. Let another running app
        // recover its durable worker, including notification-only outcomes.
        options.recoverPending?.(saved.pendingState)
        if (!request.outcome) return 'pending'
      }
      if (request.id === saved.pendingId && Number.isFinite(request.outcome?.completedAt)
        && request.outcome.completedAt > (saved.checkedAt ?? 0)) {
        saved.checkedAt = request.outcome.completedAt
        atomicWritePrivateFile(path, JSON.stringify(saved) + '\n')
      }
    }
    if (saved.checkedAt !== undefined && now >= saved.checkedAt
      && now - saved.checkedAt < AUTO_UPDATE_INTERVAL_MS) return 'not-due'
    // Persist before network/spawn: transient failures do not become restart loops.
    atomicWritePrivateFile(path, JSON.stringify({ checkedAt: now, failedSha: saved.failedSha }) + '\n')
    // Fetch writes refs too. Serialize it with manual updates/registration,
    // releasing this lease before launching the updater that acquires it itself.
    const mutationPath = join(options.root, 'shared-update.lock')
    const mutation = tryAcquireProcessLock(mutationPath)
    if (!mutation.acquired) return 'busy'
    let sha: string | undefined
    try { sha = await options.detect() }
    finally { releaseProcessLock(mutationPath, mutation.lease) }
    if (!sha) return 'current'
    if (sha === saved.failedSha) return 'failed-version'
    // The preference may have changed during the bounded network request.
    if (!automaticUpdatesEnabled(options.root)) return 'disabled'
    const beforeEnqueue = inspectProcessLock(join(options.root, 'shared-update.lock'))
    if (beforeEnqueue.status === 'active' || beforeEnqueue.status === 'unknown') return 'busy'
    const result = await options.enqueue(sha)
    atomicWritePrivateFile(path, JSON.stringify({
      checkedAt: now, pendingState: options.stateDir, pendingId: result.request.id,
      ...(result.accepted ? { targetSha: sha } : {}), failedSha: saved.failedSha,
    }) + '\n')
    return result.accepted ? 'scheduled' : 'pending'
  } finally {
    releaseProcessLock(lockPath, lock.lease)
  }
}

/** Fetch metadata only; the existing updater owns validation and checkout changes. */
export async function remoteUpdateHead(repo: string): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const [candidate] = await preflightRepositories([{ label: 'zero-codex', path: repo, branch: 'main' }], controller.signal)
    return candidate && candidate.targetHead !== candidate.originalHead ? candidate.targetHead : undefined
  } finally { clearTimeout(timer) }
}

if (import.meta.main) {
  const command = process.argv[2]
  const root = slackAppRegistryRoot(homedir())
  if (!['on', 'off', 'status'].includes(command ?? '')) {
    console.error('使い方: zerochan auto-update on|off|status')
    process.exitCode = 2
  } else {
    prepareManagedStateRoot(root)
    if (command !== 'status') configureAutomaticUpdates(root, command === 'on')
    console.log(`自動更新: ${automaticUpdatesEnabled(root) ? '有効（30分ごと）' : '無効'}。このMacの全Slackアプリに共通です。`)
  }
}
