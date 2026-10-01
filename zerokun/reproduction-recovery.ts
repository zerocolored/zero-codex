import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { lstatSync, readdirSync } from 'fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { ensureManagedDirectory, requireManagedDirectory } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalBoundedAtomicOwnedFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { inspectProcessLock } from './process-lock.ts'
import { resolveZeroJobDatabasePath } from './state-dir.ts'
import { containsCredentialMaterial } from './public-output-guard.ts'
import type { ReproductionContext, RunResult } from './codex-reproduction-broker.ts'

const MAX_FILE = 64 * 1024 * 1024
const MAX_TOTAL = 1024 * 1024 * 1024
const MAX_ENTRIES = 20_000
const FORMATS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.json', '.jsonl', '.csv', '.tsv', '.txt', '.md', '.py', '.js', '.ts', '.swift', '.html', '.css', '.sha256'])
const BINARY = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp'])
// A reproduction workspace can be the scratch HOME. Never promote its runtime,
// credentials, caches, or private diagnostics into the next model's inputs.
const EXCLUDED = /^(?:\..*|node_modules|__pycache__|.*cache.*|clang|runtime|auth(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|.*(?:webhook-secret|private-key).*|events\.jsonl|stderr\.txt)$/i

function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

type PriorJob = { id: string; seq: number; status: string }

/** Authority comes from durable conversation scope, never a caller-supplied job/path. */
function priorJobs(context: ReproductionContext): PriorJob[] {
  const { job, stateDir } = context
  const db = new Database(resolveZeroJobDatabasePath(stateDir), { readonly: true })
  try {
    return db.query<PriorJob, [string, string, string, number]>(
      'SELECT id,seq,status FROM jobs WHERE chat_id=? AND thread_ts=? AND repo_path=? AND seq<? ORDER BY seq DESC LIMIT 100',
    ).all(job.chatId, job.threadTs, job.historyRepoPath ?? job.repoPath, job.seq)
      .filter(row => /^[A-Za-z0-9_-]+$/.test(row.id))
  } finally { db.close() }
}

function existingDirectory(state: string, path: string): string | undefined {
  try { return requireManagedDirectory(state, path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

function validatedResult(context: ReproductionContext, source: PriorJob, id: string, directory: string): RunResult {
  const raw = readOptionalBoundedOwnerOnlyRegularFile(join(directory, 'result.json'), 16_384)
  if (!raw) throw new Error('missing previous execution record')
  const value = JSON.parse(raw) as RunResult
  if (value.id !== id || !['running', 'completed', 'failed', 'interrupted', 'containment_failed'].includes(value.status)
    || typeof value.workspace !== 'string' || !isAbsolute(value.workspace)
    || typeof value.promptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.promptSha256)) throw new Error('invalid previous execution record')
  const scratch = join(context.stateDir, 'tmp', source.id)
  const workspace = resolve(value.workspace)
  if (!inside(scratch, workspace)) throw new Error('previous workspace is outside source job')
  // Retention may remove scratch before its host journal. Validate any existing
  // parents, but preserve access to the execution record when files are gone.
  existingDirectory(context.stateDir, workspace)
  const request = readOptionalBoundedAtomicOwnedFile(join(directory, 'request.txt'), 256 * 1024)
  if (!request || createHash('sha256').update(request).digest('hex') !== value.promptSha256
    || createHash('sha256').update(JSON.stringify([source.id, workspace, value.promptSha256])).digest('hex') !== id) throw new Error('previous execution identity mismatch')
  // Do not trust persisted output paths or arbitrary extra JSON properties.
  const output = join(context.stateDir, 'live-input', source.id, 'codex-reproduction', id)
  return { id, status: value.status, promptSha256: value.promptSha256, workspace,
    finalPath: join(output, 'final.txt'), receiptPath: join(output, 'execution.json'),
    ...(Number.isInteger(value.exitCode) ? { exitCode: value.exitCode } : {}) }
}

function copyWorkspace(state: string, source: string, destination: string) {
  const files: { path: string; bytes: number; sha256: string }[] = []
  const omitted: { path: string; reason: string }[] = []
  let bytes = 0, visited = 0, excluded = 0, unavailable = 0
  function omission(path: string, reason: string) {
    if (omitted.length < MAX_ENTRIES) omitted.push({ path: relative(source, path) || '.', reason })
  }
  function walk(directory: string, target: string) {
    if (++visited > MAX_ENTRIES) { unavailable++; omission(directory, 'entry-limit'); return }
    requireManagedDirectory(state, directory)
    for (const name of readdirSync(directory).sort()) {
      if (++visited > MAX_ENTRIES) { unavailable++; omission(directory, 'entry-limit'); break }
      if (EXCLUDED.test(name)) { excluded++; continue }
      const path = join(directory, name)
      try {
        const metadata = lstatSync(path)
        if (metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) { unavailable++; continue }
        if (metadata.isDirectory()) {
          walk(path, ensureManagedDirectory(state, join(target, name)))
          continue
        }
        if (!metadata.isFile() || metadata.nlink !== 1) { unavailable++; continue }
        const extension = extname(name).toLowerCase()
        if (!FORMATS.has(extension)) { excluded++; omission(path, 'unsupported-format'); continue }
        if (metadata.size > MAX_FILE || bytes + metadata.size > MAX_TOTAL) { unavailable++; omission(path, 'size-limit'); continue }
        requireManagedDirectory(state, dirname(path))
        const data = readOptionalBoundedAtomicOwnedFile(path, MAX_FILE)
        const after = lstatSync(path)
        if (!data || (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).some(key => metadata[key] !== after[key])) {
          unavailable++; omission(path, 'source-changed'); continue
        }
        if (!BINARY.has(extension) && containsCredentialMaterial(data.toString('utf8'))) { excluded++; continue }
        atomicWritePrivateFile(join(target, name), data)
        bytes += data.length
        files.push({ path: relative(destination, join(target, name)), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
      } catch { unavailable++; omission(path, 'copy-unavailable') }
    }
  }
  if (existingDirectory(state, source)) walk(source, destination)
  else { unavailable++; omission(source, 'source-workspace-missing') }
  return { files, bytes, excluded, unavailable, omitted }
}

/** Recover only an existing run in the same conversation. Never launch a child
 * or rewrite the source journal, including a journal stranded by ENOSPC. */
export function recoverPreviousReproduction(context: ReproductionContext, id: string): RunResult {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid reproduction id')
  for (const source of priorJobs(context)) {
    const root = existingDirectory(context.stateDir, join(context.stateDir, 'reproductions', source.id))
    if (!root) continue
    const directory = existingDirectory(context.stateDir, join(root, id))
    if (!directory) continue
    const result = validatedResult(context, source, id, directory)
    const containment = readdirSync(root).some(name => /^containment-[a-f0-9]{64}\.json$/.test(name))
    if (containment || result.status === 'containment_failed') throw new Error('previous execution requires containment')
    const lock = inspectProcessLock(join(directory, 'process.lock'))
    if (lock.status === 'unknown') throw new Error('previous execution ownership is unknown')
    if (lock.status === 'active') return { ...result, status: 'running', reason: 'The previous execution still owns its process lock. Continue polling this same id.' }
    if (source.status === 'running' || source.status === 'queued') throw new Error('previous job is still active')
    if (result.status === 'running') {
      result.status = 'interrupted'
      result.reason = 'The previous executor stopped before publishing a terminal result. Retained files are partial evidence, not a completed or verified execution. Do not repeat the original execution.'
    }
    const output = ensureManagedDirectory(context.stateDir, join(context.liveInputDir, 'codex-reproduction', id))
    const workspace = ensureManagedDirectory(context.stateDir, join(output, 'workspace'))
    const recovered = copyWorkspace(context.stateDir, result.workspace, workspace)
    // Host final is optional for an interrupted run, and never read via a path
    // supplied by the persisted result JSON.
    const final = readOptionalBoundedAtomicOwnedFile(join(directory, 'final.txt'), 2 * 1024 * 1024)
    const finalPath = join(output, 'final.txt')
    const finalAvailable = Boolean(final && !containsCredentialMaterial(final.toString('utf8')))
    if (finalAvailable) atomicWritePrivateFile(finalPath, final!)
    const manifestPath = join(output, 'recovery.json')
    const recovery = { sourceJob: source.seq, manifestPath, copiedFiles: recovered.files.length,
      unavailable: recovered.unavailable, excluded: recovered.excluded, finalAvailable }
    const value: RunResult = { ...result, workspace, finalPath, receiptPath: join(output, 'execution.json'), recovery }
    atomicWritePrivateFile(manifestPath, JSON.stringify({ version: 1, ...recovery, files: recovered.files, bytes: recovered.bytes, omitted: recovered.omitted,
      comparisonVerified: false, instructions: 'Read retained input/output/work files here. This workspace is read-only; copy relevant files to current job scratch to continue analysis. Missing or excluded files are not proof of a completed comparison. Do not relaunch the original independent execution.' }))
    atomicWritePrivateFile(value.receiptPath, JSON.stringify({ ...value, comparisonVerified: false }))
    return value
  }
  throw new Error('no authorized previous execution')
}
