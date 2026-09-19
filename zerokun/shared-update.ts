import { join } from 'path'
import { unlinkSync } from 'fs'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { homedir } from 'os'
import { listRegisteredSlackApps, slackAppRegistryRoot } from './slack-app-registry.ts'

export function assertSharedSourceReady(stateDir: string, home = homedir()): void {
  const owner = readOptionalBoundedOwnerOnlyRegularFile(join(slackAppRegistryRoot(home), 'shared-update-owner.json'), 8192)
  if (owner === null) return
  const record = JSON.parse(owner)
  if (record.owner?.stateDir === stateDir || listRegisteredSlackApps(home).some(app => app.stateDir === stateDir)) {
    throw new Error('共有コードの更新・復旧が未完了です。先に zerochan update --recover-only を実行してください')
  }
}

export interface UpdatePeer { stateDir: string; projectDir: string; running?: boolean }
export interface SharedUpdateHooks {
  acquire(state: string): { release(): void }
  drain(peer: UpdatePeer): Promise<void>
  stop(peer: UpdatePeer): Promise<void>
  restart(peer: UpdatePeer): Promise<void>
  recover?(): Promise<void>
  validate?(peer: UpdatePeer): void
  observe?(peer: UpdatePeer): UpdatePeer
  deferStop?: boolean
  refresh?(peer: UpdatePeer): Promise<void>
}

/** Hold peer claim barriers across the shared code switch, retaining recovery intent. */
export async function coordinateSharedUpdate<T>(
  registryRoot: string,
  peers: UpdatePeer[],
  hooks: SharedUpdateHooks,
  update: (stopPeers: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const path = join(registryRoot, 'shared-update-peers.json')
  const prior = readOptionalBoundedOwnerOnlyRegularFile(path, 64 * 1024)
  let pending: UpdatePeer[] = []
  if (prior !== null) {
    const parsed = JSON.parse(prior)
    if (parsed?.version !== 1 || !Array.isArray(parsed.pending)
      || parsed.pending.some((peer: UpdatePeer) => typeof peer?.stateDir !== 'string' || typeof peer?.projectDir !== 'string')) {
      throw new Error('共有更新の再起動記録を読み取れません')
    }
    pending = parsed.pending
  }
  for (const peer of pending) hooks.validate?.(peer)
  let all = [...new Map([...pending, ...peers].map(peer => [peer.stateDir, peer])).values()]
    .sort((a, b) => a.stateDir.localeCompare(b.stateDir))
  const locks: Array<{ release(): void }> = []
  const save = () => atomicWritePrivateFile(path, JSON.stringify({ version: 1, pending }) + '\n')
  try {
    for (const peer of all) locks.push(hooks.acquire(peer.stateDir))
    // Official start/stop also hold these locks until their transition ends.
    // Re-observe only now: the pre-lock inventory can be stale.
    all = all.map(peer => hooks.observe?.(peer) ?? peer)
    // Recover only the recorded peers before attempting another code change.
    if (pending.length) {
      pending = pending.map(saved => {
        const current = all.find(peer => peer.stateDir === saved.stateDir)
        return current?.running ? current : saved
      })
      save()
      for (const peer of all) await hooks.drain(peer)
      for (const peer of all) {
        if (peer.running === false && !pending.some(item => item.stateDir === peer.stateDir)) continue
        if (!pending.some(item => item.stateDir === peer.stateDir)) { pending.push(peer); save() }
        await hooks.stop(peer)
      }
      // Restore the shared source transaction before starting any peer against it.
      await hooks.recover?.()
      for (const peer of all) await hooks.refresh?.(peer)
      for (const peer of [...pending]) {
        await hooks.restart(peer)
        pending = pending.filter(item => item.stateDir !== peer.stateDir)
        save()
      }
      unlinkSync(path)
      throw new Error('前回の共有更新で残った再起動を復旧しました。更新は再実行してください')
    }
    for (const peer of all) await hooks.drain(peer)
    let result!: T
    let failure: unknown
    let stopped = false
    const stopPeers = async () => {
      if (stopped) return
      stopped = true
      for (const peer of all) {
        if (peer.running === false) continue
        pending.push(peer)
        save() // A partial stop must also be restarted.
        await hooks.stop(peer)
      }
    }
    try {
      if (!hooks.deferStop) await stopPeers()
      result = await update(stopPeers)
    } catch (error) { failure = error }
    for (const peer of stopped ? all : []) {
      try { await hooks.refresh?.(peer) } catch (error) { failure ??= error }
    }
    const restartErrors: string[] = []
    for (const peer of [...pending]) {
      try {
        await hooks.restart(peer)
        pending = pending.filter(item => item.stateDir !== peer.stateDir)
        save()
      } catch { restartErrors.push(peer.stateDir) }
    }
    if (!pending.length && (all.length || prior !== null)) {
      try { unlinkSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (restartErrors.length) throw new Error(`共有更新後に${restartErrors.length}件のアプリを再起動できませんでした。再起動記録を保持しています`)
    if (failure) throw failure
    return result
  } finally {
    const failures: unknown[] = []
    for (const lock of locks.reverse()) {
      try { lock.release() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new Error('共有更新の一部lockを解放できませんでした')
  }
}
