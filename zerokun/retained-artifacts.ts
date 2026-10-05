import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import { lstatSync } from 'fs'
import { ensureManagedDirectory, requireManagedDirectory } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalBoundedAtomicOwnedFile } from './safe-file.ts'
import { resolveZeroJobDatabasePath } from './state-dir.ts'

type Scope = { id: string; seq: number; chatId: string; threadTs: string; repoPath: string; historyRepoPath?: string }
type Delivered = { job_id: string; seq: number; artifact_path: string }
export type RetainedArtifact = { sourceJob: number; filename: string; path: string; sha256: string; bytes: number }
const MAX_FILE = 50 * 1024 * 1024

/** Only confirmed deliveries from this same conversation/repository are inputs.
 * Never open prior scratch/outbox trees, private state or unsent drafts. */
export function retainDeliveredArtifacts(job: Scope, state: string, inputRoot: string): {
  artifacts: RetainedArtifact[]; unavailable: number; manifest: string
} {
  const root = ensureManagedDirectory(state, join(inputRoot, 'prior-artifacts'))
  const artifacts: RetainedArtifact[] = []
  let unavailable = 0, total = 0
  let db: Database | undefined
  try {
    db = new Database(resolveZeroJobDatabasePath(state), { readonly: true })
    const rows = db.query<Delivered, [string, string, string, number]>(
      `SELECT d.job_id, j.seq, d.artifact_path FROM artifact_deliveries d JOIN jobs j ON j.id=d.job_id
       WHERE j.chat_id=? AND j.thread_ts=? AND j.repo_path=? AND j.seq<?
         AND d.delivered_at IS NOT NULL AND d.abandoned_at IS NULL
       ORDER BY j.seq DESC, d.artifact_path LIMIT 101`,
    ).all(job.chatId, job.threadTs, job.historyRepoPath ?? job.repoPath, job.seq)
    for (const row of rows) {
      try {
        if (artifacts.length >= 100 || !/^[A-Za-z0-9_-]+$/.test(row.job_id)) throw new Error('artifact bound')
        const sourceRoot = requireManagedDirectory(state, join(state, 'sealed-artifacts', row.job_id))
        const source = resolve(row.artifact_path)
        const encoded = basename(source)
        const match = /^[a-f0-9]{32}--([a-f0-9]{32})--(.+)$/.exec(encoded)
        if (dirname(source) !== sourceRoot || !match) throw new Error('unsealed artifact')
        const metadata = lstatSync(source)
        if ((metadata.mode & 0o077) !== 0) throw new Error('artifact mode')
        const bytes = readOptionalBoundedAtomicOwnedFile(source, MAX_FILE, 'retained artifact')
        if (!bytes?.length || total + bytes.length > 200 * 1024 * 1024) throw new Error('artifact size')
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        if (sha256.slice(0, 32) !== match[1]) throw new Error('artifact digest')
        const path = join(root, `${row.seq}-${encoded}`)
        atomicWritePrivateFile(path, bytes)
        total += bytes.length
        artifacts.push({ sourceJob: row.seq, filename: match[2]!, path, sha256, bytes: bytes.length })
      } catch { unavailable++ }
    }
  } catch { unavailable++ } finally { db?.close() }
  const manifest = join(root, 'manifest.json')
  atomicWritePrivateFile(manifest, JSON.stringify({ version: 1, artifacts, unavailable }))
  return { artifacts, unavailable, manifest }
}

export function retainedArtifactInstructions(manifest: string): string {
  return `\nHost-retained prior delivered artifacts: ${JSON.stringify(manifest)}. Read this manifest before asking for previous outputs again. Its verified copies are read-only inputs from this same Slack thread and repository. Open relevant archives to locate the prior final dataset; do not confuse the original baseline with the final result. An unavailable entry is missing evidence, never a successful comparison.\n`
}
