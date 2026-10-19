import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { observeProcessGeneration } from './process-generation.ts'

/** Every child has its own durable claim. A later child's completion must not
 * hide another running child, and a dead broker must not pin the parent forever. */
export function pendingClaudeDelegation(stateInput: string, jobId: string): string | null {
  const state = requireManagedStateRoot(stateInput)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw Error('invalid delegation job')
  const root = join(state, 'delegations', jobId)
  if (!existsSync(root)) return null
  requireManagedDirectory(state, root)
  for (const name of readdirSync(root).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
    const record = JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(join(root, name), 256 * 1024) ?? 'null')
    if (!record || `${record.id}.json` !== name) throw Error('invalid delegation claim')
    if (record.status === 'running' && record.owner
      && observeProcessGeneration(record.owner).status !== 'dead') return record.id
  }
  return null
}
