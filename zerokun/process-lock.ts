import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname } from 'path'
import { readOptionalPrivateFile } from './safe-file.ts'

export type ProcessLockAttempt =
  | { acquired: true; previousPid?: number }
  | { acquired: false; heldPid: number }

function readOwner(lockFile: string): number | undefined {
  try {
    const content = readOptionalPrivateFile(lockFile)
    if (content === null) return undefined
    const pid = Number.parseInt(content.trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

type LockIdentity = { pid: number; started: string; nonce: string }

function processStarted(pid: number): string {
  const result = Bun.spawnSync(
    ['/bin/ps', '-o', 'lstart=', '-p', String(pid)],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : ''
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  const result = Bun.spawnSync(
    ['/bin/ps', '-o', 'state=', '-p', String(pid)],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  const state = result.exitCode === 0
    ? new TextDecoder().decode(result.stdout).trim().toUpperCase()
    : ''
  return Boolean(state) && !state.startsWith('Z')
}

function identityPath(lockFile: string): string {
  return `${lockFile}.identity`
}

function writeIdentity(lockFile: string, pid: number): void {
  const identity: LockIdentity = { pid, started: processStarted(pid), nonce: randomUUID() }
  if (!identity.started) throw new Error(`cannot identify lock owner PID ${pid}`)
  const path = identityPath(lockFile)
  const temporary = `${path}.${pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(identity)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch {}
  }
}

export function processLockOwnerMatches(
  lockFile: string,
  expectedPid: number,
  commandPattern: RegExp,
): boolean {
  if (readOwner(lockFile) !== expectedPid) return false
  let identity: LockIdentity
  try {
    const content = readOptionalPrivateFile(identityPath(lockFile))
    if (content === null) return false
    identity = JSON.parse(content) as LockIdentity
  } catch {
    return false
  }
  if (identity.pid !== expectedPid || identity.started !== processStarted(expectedPid)) return false
  const command = Bun.spawnSync(
    ['/bin/ps', '-ww', '-o', 'command=', '-p', String(expectedPid)],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  return command.exitCode === 0 && commandPattern.test(new TextDecoder().decode(command.stdout))
}

/** Bind an identityless lock from the legacy Claude release to the exact currently-running script. */
export function adoptLegacyProcessIdentity(
  lockFile: string,
  expectedPid: number,
  expectedFragments: string[],
): void {
  const metadata = lstatSync(lockFile)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !ownerMatches
    || readOwner(lockFile) !== expectedPid || !processIsAlive(expectedPid)) {
    throw new Error(`unsafe legacy process lock: ${lockFile}`)
  }
  const processInfo = Bun.spawnSync(
    ['/bin/ps', '-ww', '-o', 'command=', '-p', String(expectedPid)],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  const command = processInfo.exitCode === 0
    ? new TextDecoder().decode(processInfo.stdout)
    : ''
  if (!command || expectedFragments.some(fragment => !command.includes(fragment))) {
    throw new Error(`legacy lock PID ${expectedPid} does not run the expected Zero-kun script`)
  }
  writeIdentity(lockFile, expectedPid)
}

/** Remove a lock only while its PID field still equals the inspected stale owner. */
export function discardProcessLock(lockFile: string, expectedPid: number): boolean {
  if (!acquireReclaimGuard(lockFile, process.pid)) return false
  try {
    if (readOwner(lockFile) !== expectedPid) return false
    try { unlinkSync(identityPath(lockFile)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (readOwner(lockFile) !== expectedPid) return false
    try {
      unlinkSync(lockFile)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  } finally {
    releaseReclaimGuard(lockFile, process.pid)
  }
}

function atomicLinkPid(lockFile: string, pid: number): boolean {
  const temporary = `${lockFile}.candidate-${pid}-${randomUUID()}`
  writeFileSync(temporary, `${pid}\n`, { mode: 0o600, flag: 'wx' })
  try {
    linkSync(temporary, lockFile)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    try { unlinkSync(temporary) } catch {}
  }
}

function acquireReclaimGuard(lockFile: string, currentPid: number): boolean {
  const guard = `${lockFile}.reclaim`
  if (atomicLinkPid(guard, currentPid)) return true
  const heldPid = readOwner(guard)
  if (heldPid !== undefined && !processIsAlive(heldPid) && readOwner(guard) === heldPid) {
    try { unlinkSync(guard) } catch {}
    return atomicLinkPid(guard, currentPid)
  }
  return false
}

function releaseReclaimGuard(lockFile: string, currentPid: number): void {
  const guard = `${lockFile}.reclaim`
  if (readOwner(guard) === currentPid) {
    try { unlinkSync(guard) } catch {}
  }
}

/** PIDを含む候補fileをlink(2)で公開し、空fileの競合窓なしに取得する。 */
export function tryAcquireProcessLock(
  lockFile: string,
  currentPid = process.pid,
): ProcessLockAttempt {
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 })
  const guardPid = readOwner(`${lockFile}.reclaim`)
  if (guardPid !== undefined && guardPid !== currentPid && processIsAlive(guardPid)) {
    return { acquired: false, heldPid: guardPid }
  }
  const previousPid = readOwner(lockFile)
  let acquired = atomicLinkPid(lockFile, currentPid)
  if (!acquired && previousPid !== undefined && !processIsAlive(previousPid)) {
    if (acquireReclaimGuard(lockFile, currentPid)) {
      try {
        if (readOwner(lockFile) === previousPid && !processIsAlive(previousPid)) {
          try { unlinkSync(identityPath(lockFile)) } catch {}
          try { unlinkSync(lockFile) } catch {}
          acquired = atomicLinkPid(lockFile, currentPid)
        }
      } finally {
        releaseReclaimGuard(lockFile, currentPid)
      }
    }
  }
  if (acquired) {
    try {
      writeIdentity(lockFile, currentPid)
    } catch (error) {
      try { unlinkSync(lockFile) } catch {}
      throw error
    }
    return previousPid === undefined || previousPid === currentPid
      ? { acquired: true }
      : { acquired: true, previousPid }
  }
  const heldPid = readOwner(lockFile)
  if (heldPid !== undefined) return { acquired: false, heldPid }
  throw new Error(`failed to acquire process lock ${lockFile}`)
}

export function releaseProcessLock(lockFile: string, currentPid = process.pid): void {
  if (readOwner(lockFile) !== currentPid) return
  try { unlinkSync(identityPath(lockFile)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try { unlinkSync(lockFile) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

if (import.meta.main) {
  const [command, lockFile, pidText] = process.argv.slice(2)
  const pid = Number(pidText)
  if (!lockFile || !Number.isInteger(pid) || pid <= 0
    || (command !== 'acquire' && command !== 'release')) {
    process.stderr.write('usage: process-lock.ts acquire|release <lock-file> <pid>\n')
    process.exit(2)
  }
  try {
    if (command === 'acquire') {
      const result = tryAcquireProcessLock(lockFile, pid)
      if (result.acquired) {
        process.stdout.write('acquired\n')
      } else {
        process.stdout.write(`${result.heldPid}\n`)
        process.exitCode = 3
      }
    } else {
      releaseProcessLock(lockFile, pid)
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
