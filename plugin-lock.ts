import { mkdirSync } from 'fs'
import { tryAcquireProcessLock } from './zerokun/process-lock.ts'

export type PluginLockResult =
  | { acquired: true; reclaimedPid?: number }
  | { acquired: false; heldPid: number }

/** 生存PIDは安全側で保持扱いにし、dead PIDだけをshlockがatomicに回収する。 */
export function acquirePluginLock(
  lockFile: string,
  stateDir: string,
  currentPid = process.pid,
): PluginLockResult {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const result = tryAcquireProcessLock(lockFile, currentPid)
  if (result.acquired === false) return result
  return result.previousPid === undefined
    ? { acquired: true }
    : { acquired: true, reclaimedPid: result.previousPid }
}
