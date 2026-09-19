import { Database } from 'bun:sqlite'
import { resolveZeroJobDatabasePath } from './state-dir.ts'
import { realpathSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep, join } from 'path'

/** Resolve directory aliases (including macOS /tmp) without following the file leaf. */
export function resolveArtifactSource(file: string, roots: readonly string[]): string {
  if (!isAbsolute(file)) throw new Error('artifact path is not absolute')
  const source = resolve(file)
  const parent = realpathSync(dirname(source))
  const physical = resolve(parent, source.slice(dirname(source).length + 1))
  for (const root of roots) {
    let physicalRoot: string
    try { physicalRoot = realpathSync(root) } catch { continue }
    const local = relative(physicalRoot, physical)
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) continue
    // Do not promote configuration or credentials to attachments through the host reader.
    if (local.split(sep).some(part => /^(?:\.git|\.zerochan|\.env(?:\..*)?|\.ssh|\.aws|\.codex|\.claude|\.grok|\.config|\.cache|\.npmrc|\.netrc|(?:cloud-)?auth(?:\.pending)?\.json|credentials?(?:\.(?:json|ya?ml|toml|ini))?|secrets?(?:\.(?:json|ya?ml|toml|ini))?|tokens?\.(?:json|ya?ml|toml|ini)|.*(?:webhook-secret|private-key)|.*\.(?:pem|key|p12|pfx))$/i.test(part))) {
      throw new Error('protected file cannot be attached')
    }
    return physical
  }
  throw new Error('artifact is outside this job artifact sources')
}

/** Prior outboxes are authorized from host history, never from the model's path alone. */
export function previousThreadArtifactRoots(job: {
  id: string; seq: number; chatId: string; threadTs: string; repoPath: string; historyRepoPath?: string
}, state: string): string[] {
  let db: Database | undefined
  try {
    db = new Database(resolveZeroJobDatabasePath(state), { readonly: true })
    const rows = db.query<{ id: string }, [string, string, string, number]>(
      'SELECT id FROM jobs WHERE chat_id = ? AND thread_ts = ? AND repo_path = ? AND seq < ? ORDER BY seq DESC LIMIT 100',
    ).all(job.chatId, job.threadTs, job.historyRepoPath ?? job.repoPath, job.seq)
    return rows.filter(row => /^[A-Za-z0-9._-]+$/.test(row.id))
      .map(row => join(state, 'outbox', row.id))
  } catch { return [] } finally { db?.close() }
}
