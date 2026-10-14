import { join } from 'path'
import { realpathSync } from 'fs'
import { ensureManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'

const modelName = /^claude-opus-[a-zA-Z0-9.-]+$/
function modelPath(stateInput: string, jobId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(jobId)) throw new Error('invalid Claude model job binding')
  const state = requireManagedStateRoot(stateInput)
  return join(ensureManagedDirectory(state, join(state, 'claude-job-models')), `${jobId}.json`)
}
export function readClaudeJobModel(state: string, jobId: string, repo: string): string | undefined {
  const raw = readOptionalBoundedOwnerOnlyRegularFile(modelPath(state, jobId), 8192)
  if (!raw) return
  const value = JSON.parse(raw)
  if (value.jobId !== jobId || value.repoPath !== realpathSync(repo)
    || typeof value.model !== 'string' || !modelName.test(value.model)) throw new Error('invalid Claude model binding')
  return value.model
}
export function pinClaudeJobModel(state: string, jobId: string, repo: string, model: string): void {
  const existing = readClaudeJobModel(state, jobId, repo)
  if (!modelName.test(model) || (existing && existing !== model)) throw new Error('Claude primary model changed')
  atomicWritePrivateFile(modelPath(state, jobId), JSON.stringify({ jobId, repoPath: realpathSync(repo), model }))
}
