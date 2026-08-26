import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { lstatSync } from 'fs'
import { resolveZeroJobDatabasePath } from './state-dir.ts'
import { requireManagedStateRoot } from './managed-path.ts'

const MAX_INPUT_ENTRIES = 512
const MAX_CANONICAL_INPUT_CHARS = 256 * 1024

export type AdvisorInputEntry = {
  revision: number
  kind: 'initial' | 'steer'
  messageId: string
  userId: string
  writeEnabled: boolean
  task: string
  attachments: string[]
}

export type AdvisorInputSnapshot = {
  revision: number
  digest: string
  transcript: string
  entries: AdvisorInputEntry[]
}

type JobInputRow = {
  id: string
  message_id: string
  user_id: string
  write_enabled?: number
  task: string
  attachments_json: string
  input_revision: number
}

type ControlInputRow = {
  input_revision: number
  message_id: string
  user_id: string
  write_enabled?: number
  task: string
  attachments_json: string
}

function attachments(value: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('advisor input attachments are invalid') }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error('advisor input attachments are invalid')
  }
  return parsed as string[]
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1
}

export function createAdvisorInputSnapshot(
  job: JobInputRow,
  controls: ControlInputRow[],
  canonicalVersion: 1 | 2 = 2,
): AdvisorInputSnapshot {
  if (!validRevision(job.input_revision) || !job.id || !job.message_id || !job.user_id
    || typeof job.task !== 'string') {
    throw new Error('advisor input job is invalid')
  }
  if (controls.length > MAX_INPUT_ENTRIES - 1) {
    throw new Error('advisor input has too many live updates')
  }
  const entries: AdvisorInputEntry[] = [{
    revision: 1,
    kind: 'initial',
    messageId: job.message_id,
    userId: job.user_id,
    writeEnabled: job.write_enabled === 1,
    task: job.task,
    attachments: attachments(job.attachments_json),
  }]
  let expectedRevision = 2
  for (const control of controls) {
    if (control.input_revision !== expectedRevision || !control.message_id || !control.user_id
      || typeof control.task !== 'string') {
      throw new Error('advisor input revisions are not contiguous')
    }
    entries.push({
      revision: control.input_revision,
      kind: 'steer',
      messageId: control.message_id,
      userId: control.user_id,
      writeEnabled: control.write_enabled === 1,
      task: control.task,
      attachments: attachments(control.attachments_json),
    })
    expectedRevision += 1
  }
  if (job.input_revision !== entries.length) {
    throw new Error('advisor input revision does not match its canonical transcript')
  }
  const canonicalEntries = canonicalVersion === 1
    ? entries.map(({ writeEnabled: _writeEnabled, ...entry }) => entry)
    : entries
  const canonical = JSON.stringify({ version: canonicalVersion, jobId: job.id, entries: canonicalEntries })
  if (canonical.length > MAX_CANONICAL_INPUT_CHARS) {
    throw new Error('advisor input transcript exceeds the managed size limit')
  }
  const transcript = entries.map(entry => [
    `--- input revision ${entry.revision} (${entry.kind}) ---`,
    `Slack message: ${entry.messageId}`,
    `Sender: ${entry.userId}`,
    `Write authorized: ${entry.writeEnabled ? 'yes' : 'no'}`,
    entry.task,
    ...(entry.attachments.length > 0 ? [
      'Attachments (read-only local paths):',
      ...entry.attachments.map(path => `- ${path}`),
    ] : []),
  ].join('\n')).join('\n\n')
  return {
    revision: job.input_revision,
    digest: createHash('sha256').update(canonical).digest('hex'),
    transcript,
    entries,
  }
}

export function writeAuthorizedImplementationInput(
  input: AdvisorInputSnapshot,
): Pick<AdvisorInputSnapshot, 'revision' | 'digest' | 'transcript'> {
  if (!input.entries[0]?.writeEnabled) {
    throw new Error('write implementation input is not rooted in a write-authorized job')
  }
  return {
    revision: input.revision,
    digest: input.digest,
    transcript: [
      input.transcript,
      '',
      'Host authority note: this running Slack thread delegates control to the active job.',
      'The root request was write-authorized, so every same-thread follow-up above is part of',
      'this job even when that sender would receive read-only permissions for a new thread.',
    ].join('\n'),
  }
}

export function activeWriteInputDigest(input: AdvisorInputSnapshot): string {
  if (!input.entries[0]?.writeEnabled) {
    throw new Error('active write input is not rooted in a write-authorized job')
  }
  const entries = input.entries.map(entry => ({
    revision: entry.revision,
    messageId: entry.messageId,
    userId: entry.userId,
    senderWriteEnabled: entry.writeEnabled,
    task: entry.task,
    attachments: entry.attachments,
  }))
  return createHash('sha256').update(JSON.stringify({ version: 1, entries })).digest('hex')
}

/** Read one transactionally consistent canonical input from the durable SQLite ledger. */
export function readAdvisorInputSnapshot(
  stateDirInput: string,
  jobId: string,
  revisionInput?: number,
): AdvisorInputSnapshot {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const databasePath = resolveZeroJobDatabasePath(stateDir, {})
  const metadata = lstatSync(databasePath)
  const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !owned) {
    throw new Error('advisor input database is unsafe')
  }
  const db = new Database(databasePath, { readonly: true })
  try {
    const snapshot = db.transaction(() => {
      const job = db.query<JobInputRow, [string]>(
        `SELECT id, message_id, user_id, write_enabled, task, attachments_json, input_revision
         FROM jobs WHERE id = ? AND runtime = 'codex'`,
      ).get(jobId)
      if (!job) throw new Error(`advisor input job is missing: ${jobId}`)
      const controls = db.query<ControlInputRow, [string]>(
        `SELECT input_revision, message_id, user_id, write_enabled, task, attachments_json
         FROM job_controls
         WHERE job_id = ? AND kind = 'steer'
         ORDER BY input_revision ASC, seq ASC`,
      ).all(jobId)
      if (revisionInput === undefined) return createAdvisorInputSnapshot(job, controls)
      if (!validRevision(revisionInput) || revisionInput > job.input_revision) {
        throw new Error(`advisor input revision is unavailable: ${revisionInput}`)
      }
      return createAdvisorInputSnapshot(
        { ...job, input_revision: revisionInput },
        controls.filter(control => control.input_revision <= revisionInput),
      )
    })
    return snapshot.deferred()
  } finally {
    db.close()
  }
}
