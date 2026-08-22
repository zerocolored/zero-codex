import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'

export const DEFAULT_RUNTIME_LOG_BYTES = 20 * 1024 * 1024
type UnsafeReporter = (message: string) => void
type FileMetadata = NonNullable<ReturnType<typeof lstatSync>>

const reportUnsafeByDefault: UnsafeReporter = message => {
  process.stderr.write(`state maintenance: ${message}\n`)
}

function stateChild(root: string, candidate: string): string {
  const base = resolve(root)
  const path = resolve(candidate)
  if (path === base || !path.startsWith(base + sep)) {
    throw new Error(`maintenance path is outside state: ${candidate}`)
  }
  return path
}

function managedMetadata(root: string, candidate: string): FileMetadata {
  const base = resolve(root)
  const path = stateChild(base, candidate)
  const rootMetadata = lstatSync(base) as FileMetadata
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`unsafe state root: ${base}`)
  }
  const components = relative(base, path).split(sep).filter(Boolean)
  let current = base
  let metadata = rootMetadata
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]!)
    metadata = lstatSync(current) as FileMetadata
    if (index < components.length - 1
      && (!metadata.isDirectory() || metadata.isSymbolicLink())) {
      throw new Error(`unsafe managed path component: ${current}`)
    }
  }
  return metadata
}

function removeEntry(
  root: string,
  candidate: string,
  onUnsafe: UnsafeReporter = reportUnsafeByDefault,
): boolean {
  const path = stateChild(root, candidate)
  try {
    const metadata = managedMetadata(root, path)
    rmSync(path, { recursive: metadata.isDirectory() && !metadata.isSymbolicLink(), force: true })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    onUnsafe(error instanceof Error ? error.message : String(error))
    return false
  }
}

function scanRoot(
  root: string,
  name: string,
  onUnsafe: UnsafeReporter = reportUnsafeByDefault,
): string[] {
  const directory = join(root, name)
  try {
    const metadata = managedMetadata(root, directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return []
    return readdirSync(directory).map(entry => join(directory, entry))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      onUnsafe(error instanceof Error ? error.message : String(error))
    }
    return []
  }
}

export function capRuntimeLogs(
  stateDir: string,
  maxBytes = DEFAULT_RUNTIME_LOG_BYTES,
  onUnsafe: UnsafeReporter = reportUnsafeByDefault,
): number {
  let capped = 0
  for (const name of ['job-runner.log', 'zerokun.log', 'watchdog.log', 'update-request.log']) {
    const path = stateChild(stateDir, join(stateDir, name))
    let descriptor: number
    try {
      const pathMetadata = managedMetadata(stateDir, path)
      const ownerMatches = typeof process.getuid !== 'function'
        || pathMetadata.uid === process.getuid()
      if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()
        || pathMetadata.nlink !== 1 || !ownerMatches) {
        onUnsafe(`refuse to truncate unsafe runtime log: ${path}`)
        continue
      }
      descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      onUnsafe(error instanceof Error ? error.message : String(error))
      continue
    }
    try {
      const metadata = fstatSync(descriptor)
      const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
      if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches) {
        onUnsafe(`refuse to truncate unsafe runtime log: ${path}`)
        continue
      }
      if (metadata.size > maxBytes) {
        const retained = Buffer.alloc(Math.max(0, maxBytes))
        const bytes = retained.length > 0
          ? readSync(descriptor, retained, 0, retained.length, metadata.size - retained.length)
          : 0
        ftruncateSync(descriptor, 0)
        if (bytes > 0) writeSync(descriptor, retained, 0, bytes, 0)
        capped += 1
      }
    } finally {
      closeSync(descriptor)
    }
  }
  return capped
}

export function removeSettledJobState(options: {
  stateDir: string
  jobIds: string[]
  attachmentPaths: string[]
  stillReferencedAttachments: Set<string>
  onUnsafe?: UnsafeReporter
}): number {
  let removed = 0
  const report = options.onUnsafe ?? reportUnsafeByDefault
  const ids = new Set(options.jobIds.filter(id => (
    id !== '.' && id !== '..' && /^[A-Za-z0-9._-]+$/.test(id)
  )))
  for (const id of ids) {
    for (const root of ['outbox', 'tmp', 'sealed-artifacts', 'final-output']) {
      if (removeEntry(options.stateDir, join(options.stateDir, root, id), report)) removed += 1
    }
    for (const suffix of ['stdout.log', 'stderr.log']) {
      if (removeEntry(
        options.stateDir,
        join(options.stateDir, 'job-logs', `${id}.${suffix}`),
        report,
      )) removed += 1
    }
  }
  const inbox = join(options.stateDir, 'inbox')
  for (const attachment of options.attachmentPaths) {
    let path: string
    try {
      path = stateChild(inbox, attachment)
    } catch {
      continue
    }
    if (options.stillReferencedAttachments.has(path)) continue
    if (removeEntry(options.stateDir, path, report)) removed += 1
    try {
      const parentMetadata = managedMetadata(options.stateDir, dirname(path))
      if (parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink()
        && readdirSync(dirname(path)).length === 0
        && removeEntry(options.stateDir, dirname(path), report)) removed += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        report(error instanceof Error ? error.message : String(error))
      }
    }
  }
  return removed
}

export function removeOrphanedJobState(options: {
  stateDir: string
  liveJobIds: Set<string>
  liveAttachmentPaths: Set<string>
  olderThan: number
  onUnsafe?: UnsafeReporter
}): number {
  let removed = 0
  const report = options.onUnsafe ?? reportUnsafeByDefault
  for (const root of ['outbox', 'tmp', 'sealed-artifacts', 'final-output']) {
    for (const entry of scanRoot(options.stateDir, root, report)) {
      if (options.liveJobIds.has(basename(entry))) continue
      try {
        if (lstatSync(entry).mtimeMs < options.olderThan
          && removeEntry(options.stateDir, entry, report)) removed += 1
      } catch {}
    }
  }
  for (const entry of scanRoot(options.stateDir, 'job-logs', report)) {
    const match = basename(entry).match(/^(.+)\.(?:stdout|stderr)\.log$/)
    if (match && options.liveJobIds.has(match[1]!)) continue
    try {
      if (lstatSync(entry).mtimeMs < options.olderThan
        && removeEntry(options.stateDir, entry, report)) removed += 1
    } catch {}
  }
  for (const directory of scanRoot(options.stateDir, 'inbox', report)) {
    let containsLive = false
    try {
      for (const name of readdirSync(directory)) {
        if (options.liveAttachmentPaths.has(resolve(join(directory, name)))) containsLive = true
      }
      if (!containsLive && lstatSync(directory).mtimeMs < options.olderThan
        && removeEntry(options.stateDir, directory, report)) removed += 1
    } catch {}
  }
  return removed
}
