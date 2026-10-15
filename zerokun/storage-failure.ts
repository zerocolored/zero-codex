import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, statfsSync } from 'fs'
import { join } from 'path'
import { requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'

export const STORAGE_FAILURE = 'ZERO_STORAGE_FULL'
export const STORAGE_FAILURE_MESSAGE = 'Macの空き容量が不足し、実行状態を保存できませんでした。作業内容は残っている可能性があります。空き容量を確保してから、このスレッドで再開してください。'

export function isStorageFailure(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error && error.code != null) {
    return ['ENOSPC', 'SQLITE_FULL'].includes(String(error.code))
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (message === STORAGE_FAILURE) return true
  // A quoted diagnostic or a filename containing ENOSPC is not an OS failure.
  const diagnostic = message.replace(/^(?:Error|SystemError):\s*/, '')
  return /^(?:ENOSPC|SQLITE_FULL)(?=[:,\s]|$)/.test(diagnostic)
    || /^(?:[Nn]o space left on device|database or disk is full)(?=[:,\s]|$)/.test(diagnostic)
}

/** Only host diagnostic records, including the in-memory tail after log truncation. */
export function storageFailureFromDiagnostics(text: string): typeof STORAGE_FAILURE | null {
  const lines = text.slice(-64 * 1024).split('\n')
  if (text.length > 64 * 1024) lines.shift()
  for (const line of lines) {
    const prefix = 'Codex cleanup is pending; retaining supervisor registration: '
    if (line.startsWith(prefix) && isStorageFailure(line.slice(prefix.length))) return STORAGE_FAILURE
    if (/^\d{4}-\d\d-\d\dT\S+ ERROR codex_rollout::recorder: rollout writer failed /.test(line)
      && line.includes('error_kind=StorageFull')) return STORAGE_FAILURE
    if (line.startsWith('{')) {
      try {
        const record = JSON.parse(line)
        if (record.type === 'zero-app-server-error' && record.message === STORAGE_FAILURE) return STORAGE_FAILURE
      } catch { /* Partial diagnostics do not obstruct recovery. */ }
    }
  }
  return null
}

/** Recover a fixed cause, never publish raw paths/stderr or change a successful result.
 * The supervisor's stderr survives a full-disk failure to persist its receipt.
 * Only this job's current attempt and known host diagnostics are evidence.
 */
export function retainedStorageFailure(stateDir: string | undefined, job: {
  id: string; startedAt: number | null
} | null): typeof STORAGE_FAILURE | null {
  if (!stateDir || !job || job.startedAt === null || !/^[A-Za-z0-9_-]+$/.test(job.id)) return null
  try {
    const root = requireManagedStateRoot(stateDir)
    const logs = requireManagedDirectory(root, join(root, 'job-logs'))
    const names = readdirSync(logs).filter(name => name.startsWith(job.id + '.')
      && /^[A-Za-z0-9_.-]+\.stderr\.log$/.test(name))
    for (const name of names) {
      let fd: number | undefined
      try {
        fd = openSync(join(logs, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const s = fstatSync(fd)
        if (!s.isFile() || s.nlink !== 1 || (process.getuid && s.uid !== process.getuid())
          || s.mtimeMs < job.startedAt) continue
        const offset = Math.max(0, s.size - 64 * 1024)
        const bytes = Buffer.alloc(Math.min(s.size, 64 * 1024))
        const length = readSync(fd, bytes, 0, bytes.length, offset)
        const lines = bytes.subarray(0, length).toString('utf8').split('\n')
        if (offset) lines.shift() // The first partial line is not a host record.
        if (storageFailureFromDiagnostics(lines.join('\n'))) return STORAGE_FAILURE
      } catch { /* Missing/rotated logs are not a new job failure. */ }
      finally { if (fd !== undefined) closeSync(fd) }
    }
  } catch { /* Diagnostic recovery is best effort. */ }
  return null
}

/** Guidance, not a global stop or an authorization to delete user data. */
export function buildStorageInstructions(projectRoot: string): string {
  let capacity = ''
  try {
    const fs = statfsSync(projectRoot)
    capacity = ` Project filesystem free space at turn setup: ${(fs.bavail * fs.bsize / 1024 ** 3).toFixed(1)} GiB; recheck before large writes.`
  } catch { /* Filesystem telemetry failure must not reject ordinary work. */ }
  return '\nBefore large builds, exports, dependency installs or temporary project copies, check free space on each destination filesystem and budget for temporary outputs as well as the final artifact.'
    + ' Reuse task-owned build caches where practical; do not duplicate generated Unity Library, DerivedData, node_modules or build caches into every verification copy.'
    + ' When finished, remove only the regenerable caches created and still owned by this task after their processes exit. Preserve source edits, active or foreign work, conversation history, receipts and deliverable artifacts.'
    + ' If space is insufficient, reduce generated copies or clean your own disposable cache before the expensive step; do not repeatedly retry a disk-full write or claim that an incomplete save/upload succeeded.' + capacity + '\n'
}
