import { execFileSync } from 'child_process'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, sep } from 'path'
import { z } from 'zod'
import { containsCredentialMaterial, redactCredentialMaterial } from './public-output-guard.ts'
import { CLOUD_MAX_BYTES, digestBytes } from './cloud-handoff.ts'

const MAX_FILE_BYTES = 50 * 1024 * 1024
const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
const fileSchema = z.object({ path: z.string(), data: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  executable: z.boolean() }).strict()
const repositorySchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  remote: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/),
  base: sha, sourceHead: sha, staged: z.string(), unstaged: z.string(),
  untracked: z.array(fileSchema).max(10000),
}).strict()
export const packageSchema = z.object({
  version: z.literal(1), task: z.string(), history: z.string(),
  repositories: z.array(repositorySchema).max(32), attachments: z.array(fileSchema).max(1000),
  notes: z.array(z.string()).max(100),
}).strict()
export type HandoffPackage = z.infer<typeof packageSchema>

function git(root: string, args: string[], input?: string): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-C', root, ...args], { encoding: 'utf8', input, timeout: 60_000,
    maxBuffer: CLOUD_MAX_BYTES, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })
}
function assertPortablePath(path: string): void {
  if (!path || isAbsolute(path) || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)
    || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) {
    throw new Error('unsafe handoff path')
  }
}
function protectedPath(path: string): boolean {
  return path.split('/').some(p => /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.codex|\.claude|\.grok|node_modules|(?:cloud-)?auth(?:\.pending)?\.json|credentials?(?:\.(?:json|ya?ml|toml|ini))?|secrets?(?:\.(?:json|ya?ml|toml|ini))?|tokens?\.(?:json|ya?ml|toml|ini)|.*(?:webhook-secret|private-key)|.*\.(?:pem|key|p12|pfx)|\.npmrc|\.netrc)$/i.test(p))
}
export function redactHandoffText(text: string): string {
  const normalized = text
    .replace(/(["'](?:password|passwd|api[_-]?key|access[_-]?key|secret|token)["']\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, '$1"[credential removed]"')
    .replace(/["']((?:password|passwd|api[_-]?key|access[_-]?key|secret|token))["']\s*[:=]/gi, '$1:')
  return redactCredentialMaterial(normalized, '[credential removed]')
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, '[credential removed]')
    .replace(/https:\/\/hooks\.zapier\.com\/hooks\/catch\/[^\s"'<>]+/gi, '[credential removed]')
}
function assertNoSecrets(text: string): void {
  const credentialKeys = text.replace(/["']((?:password|passwd|api[_-]?key|access[_-]?key|secret|token))["']\s*[:=]/gi, '$1:')
  if (containsCredentialMaterial(credentialKeys) || /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text)
    || /https:\/\/hooks\.zapier\.com\/hooks\/catch\/[^\s"'<>]+/i.test(text)) {
    throw new Error('credential material cannot be included in handoff')
  }
}
function readRegular(root: string, path: string): Buffer {
  assertPortablePath(path)
  if (protectedPath(path)) throw new Error('protected file cannot be included in handoff')
  const base = realpathSync(root)
  let cursor = base
  for (const part of path.split('/')) {
    cursor = join(cursor, part)
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('handoff symlink is not supported')
  }
  const physicalParent = realpathSync(dirname(cursor))
  if (physicalParent !== base && !physicalParent.startsWith(`${base}${sep}`)) throw new Error('handoff path escaped root')
  const fd = openSync(cursor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error('handoff file is not a bounded regular file')
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error('handoff file changed during capture')
    }
    assertNoSecrets(bytes.toString('utf8'))
    return bytes
  } finally { closeSync(fd) }
}

/** Caller supplies only the exact task-owned worktrees after writer shutdown.
 * Never discover all dirty worktrees and assume they belong to this task. */
export function captureRepository(root: string, name: string, base: string): HandoffPackage['repositories'][number] {
  if (!sha.safeParse(base).success) throw new Error('invalid base commit')
  const remoteRaw = git(root, ['remote', 'get-url', 'origin']).trim()
  const remote = remoteRaw.replace(/^git@github\.com:/, 'https://github.com/')
  const sourceHead = git(root, ['rev-parse', 'HEAD']).trim()
  const before = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const changed = new Set([...git(root, ['diff', '--cached', '--name-only', '-z', base]).split('\0'),
    ...git(root, ['diff', '--name-only', '-z']).split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean))
  for (const path of changed) {
    assertPortablePath(path)
    if (protectedPath(path)) throw new Error('task changes include a protected file; checkpoint is incomplete')
    // A binary Git patch encodes BOTH previous/index bytes. Inspect those
    // objects too, including an index change undone in the working tree.
    for (const spec of [`${base}:${path}`, `:${path}`]) {
      const exists = Bun.spawnSync(['git', '-C', root, 'cat-file', '-e', spec], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
      if (exists) assertNoSecrets(git(root, ['show', '--no-ext-diff', '--no-textconv', spec]))
    }
    // Deleted paths have no current bytes. Patch contents are checked below.
    try { readRegular(root, path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  // The base-to-index patch also carries unpublished committed changes.
  const staged = git(root, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', base])
  const unstaged = git(root, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv'])
  assertNoSecrets(staged); assertNoSecrets(unstaged)
  if (/^(?:new|old) mode 120000|^new file mode 120000|^index [^\n]+ 120000/m.test(`${staged}\n${unstaged}`)) {
    throw new Error('changed symlinks cannot be transported')
  }
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).map(path => {
    const bytes = readRegular(root, path)
    return { path, data: bytes.toString('base64'), digest: digestBytes(bytes), executable: (lstatSync(join(root, path)).mode & 0o111) !== 0 }
  })
  if (before !== git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    || sourceHead !== git(root, ['rev-parse', 'HEAD']).trim()) throw new Error('repository changed during checkpoint')
  return repositorySchema.parse({ name, remote, base, sourceHead, staged, unstaged, untracked })
}

export function captureAttachment(root: string, path: string, portableName: string): HandoffPackage['attachments'][number] {
  assertPortablePath(portableName)
  const bytes = readRegular(root, relative(root, path).split(sep).join('/'))
  return { path: portableName, data: bytes.toString('base64'), digest: digestBytes(bytes), executable: false }
}
export function encodePackage(value: HandoffPackage): Buffer {
  const checked = packageSchema.parse({ ...value, task: redactHandoffText(value.task), history: redactHandoffText(value.history) })
  assertNoSecrets(checked.task); assertNoSecrets(checked.history)
  const bytes = Buffer.from(JSON.stringify(checked))
  if (bytes.length > CLOUD_MAX_BYTES) throw new Error('handoff package exceeds limit')
  return bytes
}
export function decodePackage(bytes: Uint8Array): HandoffPackage {
  if (bytes.length > CLOUD_MAX_BYTES) throw new Error('handoff package exceeds limit')
  const value = packageSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
  const names = new Set<string>()
  for (const repository of value.repositories) {
    if (repository.name === '.' || repository.name === '..' || repository.name.toLowerCase() === '.git' || names.has(repository.name)) throw new Error('duplicate or invalid repository name')
    names.add(repository.name)
  }
  for (const files of [value.attachments, ...value.repositories.map(r => r.untracked)]) {
    const paths = new Set<string>()
    for (const file of files) {
      assertPortablePath(file.path)
      if (paths.has(file.path) || protectedPath(file.path)) throw new Error('duplicate or protected handoff file')
      paths.add(file.path)
      const data = Buffer.from(file.data, 'base64')
      if (data.length > MAX_FILE_BYTES || data.toString('base64') !== file.data || digestBytes(data) !== file.digest) {
        throw new Error('handoff file digest mismatch')
      }
    }
  }
  return value
}

/** Restore only into a NEW directory below a caller-owned import root. A
 * failed import is retained for diagnosis, never applied over existing work. */
export function restoreRepository(root: string, repository: HandoffPackage['repositories'][number], localSource: string): void {
  repositorySchema.parse(repository)
  const remote = git(localSource, ['remote', 'get-url', 'origin']).trim().replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
  if (remote !== repository.remote.replace(/\.git$/, '')) throw new Error('repository identity mismatch')
  mkdirSync(root, { mode: 0o700 }) // EEXIST is intentional: never overwrite a previous import.
  git(root, ['init', '--quiet'])
  git(root, ['fetch', '--no-tags', '--', localSource, repository.base])
  git(root, ['checkout', '--detach', '--quiet', repository.base])
  if (repository.staged) {
    git(root, ['apply', '--check', '--index', '--binary', '-'], repository.staged)
    git(root, ['apply', '--index', '--binary', '-'], repository.staged)
  }
  if (repository.unstaged) {
    git(root, ['apply', '--check', '--binary', '-'], repository.unstaged)
    git(root, ['apply', '--binary', '-'], repository.unstaged)
  }
  for (const file of repository.untracked) {
    assertPortablePath(file.path)
    let parent = root
    for (const component of file.path.split('/').slice(0, -1)) {
      parent = join(parent, component)
      try { mkdirSync(parent, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new Error('unsafe restore directory')
      }
    }
    const bytes = Buffer.from(file.data, 'base64')
    if (digestBytes(bytes) !== file.digest) throw new Error('handoff file digest mismatch')
    writeFileSync(join(root, file.path), bytes, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 })
  }
  git(root, ['remote', 'add', 'origin', repository.remote])
}
