import { createHash } from 'crypto'
import { lstatSync, mkdirSync, realpathSync } from 'fs'
import { join } from 'path'
import { requireManagedStateRoot } from './managed-path.ts'

/** A short physical root, independent of inherited TMPDIR and the state path. */
export function jobTempRoot(): string {
  return join(realpathSync('/tmp'), `zc-${process.getuid?.() ?? 'user'}`)
}

function privateDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
    throw new Error('job temporary directory must be private and physically owned')
  }
}

/**
 * Keep job scratch/HOME durable at its existing location. Only OS temporary
 * files use this short namespace so tsx and other dynamic Unix IPC fit sun_path.
 * Like scratch, it survives continuation/restart; never sweep live job sockets.
 * State identity separates apps, clones, and a deleted/recreated state directory.
 */
function jobTempDirectory(stateDir: string, jobId: string): string {
  const state = requireManagedStateRoot(stateDir)
  const stat = lstatSync(state)
  const name = createHash('sha256').update(JSON.stringify([
    state, stat.dev, stat.ino, jobId,
  ])).digest('hex').slice(0, 24)
  return join(jobTempRoot(), name)
}

export function ensureJobTempDirectory(stateDir: string, jobId: string): string {
  const path = jobTempDirectory(stateDir, jobId)
  privateDirectory(jobTempRoot())
  privateDirectory(path)
  return path
}

/** No creation: missing/unsafe OS temp must not block existing outbox delivery. */
export function existingJobTempDirectory(stateDir: string, jobId: string): string | null {
  try {
    const path = jobTempDirectory(stateDir, jobId)
    for (const entry of [jobTempRoot(), path]) {
      const stat = lstatSync(entry)
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) return null
    }
    return path
  } catch { return null }
}
