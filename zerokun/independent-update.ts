import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { UpdateDeferredError } from './update-result.ts'
import { readRuntimeRelease, writeRuntimeRelease, validateRelease, releaseIdentity, RELEASE_JOURNAL, type RuntimeRelease } from './runtime-release.ts'

export interface ReleaseTarget { stateDir: string; projectDir: string; oldRoot: string; running: boolean }
export interface ReleaseTransaction {
  version: 1
  target: ReleaseTarget
  previous: RuntimeRelease | null
  candidate: RuntimeRelease
  phase: 'waiting' | 'prepared' | 'stopped' | 'activated' | 'healthy' | 'rolling-back'
}
export interface ActivationHooks {
  acquire(state: string): { release(): void } | Promise<{ release(): void }>
  observe(target: ReleaseTarget): ReleaseTarget
  drain(target: ReleaseTarget): Promise<void>
  stop(target: ReleaseTarget): Promise<void>
  install(target: ReleaseTarget, root: string): Promise<void>
  start(target: ReleaseTarget, root: string): Promise<void>
  healthy(target: ReleaseTarget, root: string): Promise<void>
  home?: string
  report?: (target: ReleaseTarget, status: string) => void
}
export function readReleaseTransaction(state: string, home?: string): ReleaseTransaction | null {
  const raw = readOptionalBoundedOwnerOnlyRegularFile(join(state, RELEASE_JOURNAL), 16384)
    ?? readOptionalBoundedOwnerOnlyRegularFile(join(state, 'release-target.json'), 16384)
  if (raw === null) return null
  const t = JSON.parse(raw) as ReleaseTransaction
  if (t.version !== 1 || t.target?.stateDir !== state || typeof t.target.projectDir !== 'string'
    || typeof t.target.oldRoot !== 'string' || typeof t.target.running !== 'boolean'
    || !['waiting', 'prepared', 'stopped', 'activated', 'healthy', 'rolling-back'].includes(t.phase)) {
    throw new Error('インスタンス更新journalが不正です')
  }
  releaseIdentity(t.candidate, home)
  if (t.previous) releaseIdentity(t.previous, home)
  return t
}
/** No database restore: even a candidate gateway may have accepted new work. */
export async function activateRelease(target: ReleaseTarget, candidate: RuntimeRelease, hooks: ActivationHooks, recoverOnly = false): Promise<'updated' | 'current' | 'recovered'> {
  const interrupted = readReleaseTransaction(target.stateDir, hooks.home)
  if (!interrupted || (interrupted.phase === 'waiting' && !recoverOnly)) validateRelease(candidate, hooks.home)
  if (!interrupted
    && readRuntimeRelease(target.stateDir, hooks.home)?.sha === candidate.sha) return 'current'
  const lock = await hooks.acquire(target.stateDir)
  const path = join(target.stateDir, RELEASE_JOURNAL)
  const intent = join(target.stateDir, 'release-target.json')
  const save = (t: ReleaseTransaction) => {
    atomicWritePrivateFile(t.phase === 'waiting' ? intent : path, JSON.stringify(t) + '\n')
    if (t.phase !== 'waiting') rmSync(intent, { force: true })
  }
  try {
    let tx = readReleaseTransaction(target.stateDir, hooks.home)
    const recover = async (t: ReleaseTransaction) => {
      if (t.previous) validateRelease(t.previous, hooks.home)
      save({ ...t, phase: 'rolling-back' })
      await hooks.stop(t.target)
      // Storage migrations must remain backwards-compatible. Never replace the
      // queue with a pre-update snapshot after intake has resumed.
      await hooks.install(t.target, t.target.oldRoot)
      if (t.previous) writeRuntimeRelease(t.target.stateDir, t.previous, hooks.home)
      else rmSync(join(t.target.stateDir, 'runtime-release.json'), { force: true })
      if (t.target.running) {
        await hooks.start(t.target, t.target.oldRoot)
        await hooks.healthy(t.target, t.target.oldRoot)
      }
      rmSync(path)
    }
    if (tx?.phase === 'waiting') {
      if (recoverOnly) { rmSync(intent, { force: true }); return 'recovered' }
      tx = null // Resume a durable drain intent; no service was stopped yet.
    }
    if (tx) {
      if (tx.phase === 'healthy') {
        try { validateRelease(tx.candidate, hooks.home); rmSync(path); return 'recovered' } catch {}
      }
      await recover(tx)
      return 'recovered'
    }
    target = hooks.observe(target)
    const previous = readRuntimeRelease(target.stateDir, hooks.home)
    if (previous?.sha === candidate.sha) { rmSync(intent, { force: true }); return 'current' }
    // This wait holds only this app's barrier. Other activations run concurrently.
    tx = { version: 1, target, previous, candidate, phase: 'waiting' }
    save(tx)
    try { await hooks.drain(target) }
    catch (error) { rmSync(intent, { force: true }); throw error }
    tx.phase = 'prepared'; save(tx)
    try {
      await hooks.stop(target)
      tx.phase = 'stopped'; save(tx)
      await hooks.install(target, candidate.path)
      writeRuntimeRelease(target.stateDir, candidate, hooks.home)
      tx.phase = 'activated'; save(tx)
      if (target.running) {
        await hooks.start(target, candidate.path)
        await hooks.healthy(target, candidate.path)
      }
      tx.phase = 'healthy'; save(tx)
      rmSync(path)
      return 'updated'
    } catch (error) {
      try { await recover(tx) }
      catch (rollback) { throw new Error(`更新失敗。対象アプリの復旧記録を保持しました: ${String(error)} / ${String(rollback)}`) }
      throw new Error(`対象アプリを旧版へ復旧しました: ${String(error)}`)
    }
  } finally { lock.release() }
}
export async function activateIndependentTargets(targets: ReleaseTarget[], candidate: RuntimeRelease, hooks: ActivationHooks, recoverOnly = false) {
  return Promise.allSettled(targets.map(async target => {
    try {
      const status = await activateRelease(target, candidate, hooks, recoverOnly)
      hooks.report?.(target, status)
      return status
    } catch (error) { hooks.report?.(target, String(error)); throw error }
  }))
}

export function collectIndependentTargets(states: string[], resolve: (state: string) => ReleaseTarget | undefined) {
  const targets: ReleaseTarget[] = []
  const unavailable: string[] = []
  for (const state of states) {
    try { const target = resolve(state); if (target) targets.push(target) }
    catch (error) { unavailable.push(`${state.split('/').at(-1)}: ${String(error)}`) }
  }
  return { targets, unavailable }
}

export function summarizeIndependentResults(
  results: readonly PromiseSettledResult<unknown>[], unavailable: readonly string[],
): 'complete' | 'deferred' | 'failed' {
  const failures = results.filter(result => result.status === 'rejected')
  if (unavailable.length || failures.some(result => !(result.reason instanceof UpdateDeferredError))) return 'failed'
  return failures.length ? 'deferred' : 'complete'
}
