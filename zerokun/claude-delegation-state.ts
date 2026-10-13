import { existsSync } from 'fs'
import { join } from 'path'
import { requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'

/** The job-wide lease allows only one active child. Host completion checks use
 * its durable pointer rather than model claims or terminal scrollback. */
export function pendingClaudeDelegation(stateInput: string, jobId: string): string | null {
  const state = requireManagedStateRoot(stateInput)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw Error('invalid delegation job')
  const root = join(state, 'delegations', jobId)
  if (!existsSync(root)) return null
  requireManagedDirectory(state, root)
  const active = readOptionalBoundedOwnerOnlyRegularFile(join(root, 'active.json'), 8192)
  if (!active) return null
  const { id } = JSON.parse(active)
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw Error('invalid active delegation')
  const record = JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(join(root, `${id}.json`), 256 * 1024) ?? 'null')
  if (!record || record.id !== id) throw Error('missing active delegation claim')
  return record.status === 'running' ? id : null
}
