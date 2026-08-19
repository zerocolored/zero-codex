import { mkdirSync, readFileSync, writeFileSync } from 'fs'

export type PluginLockResult =
  | { acquired: true; reclaimedPid?: number }
  | { acquired: false; heldPid: number }

function isSlackServerProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const processInfo = Bun.spawnSync(
    ['/bin/ps', '-o', 'command=', '-p', String(pid)],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  if (processInfo.exitCode !== 0) return false
  return /(?:^|[\/\s])server\.ts(?:\s|$)/.test(new TextDecoder().decode(processInfo.stdout))
}

/** PIDの生存だけでなく実行コマンドも照合して、再利用されたPIDのlockを回収する。 */
export function acquirePluginLock(
  lockFile: string,
  stateDir: string,
  currentPid = process.pid,
): PluginLockResult {
  let reclaimedPid: number | undefined
  try {
    const heldPid = Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10)
    if (Number.isFinite(heldPid) && heldPid > 0 && heldPid !== currentPid) {
      if (isSlackServerProcess(heldPid)) return { acquired: false, heldPid }
      reclaimedPid = heldPid
    }
  } catch {
    // no lock file, or unreadable — proceed
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(lockFile, String(currentPid), { encoding: 'utf8', mode: 0o600 })
  return reclaimedPid === undefined
    ? { acquired: true }
    : { acquired: true, reclaimedPid }
}
