#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { createHash } from 'crypto'
import {
  lstatSync,
  openSync,
  closeSync,
  constants,
  fstatSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'

const MAX_DIRTY_FILE_BYTES = 64 * 1024 * 1024
const MAX_NON_GIT_ENTRIES = 50_000
const PROTECTED_COMPONENT = /^(?:\.env.*|.*(?:auth|credential|token|secret).*|sessions|logs|memories)$/i

export type AdvisorProjectLayout = {
  projectPath: string
  gitRoot: string | null
}

export type AdvisorRepositorySnapshot = {
  version: 1
  projectPath: string
  gitRoot: string | null
  head: string | null
  status: string
  dirty: Record<string, string>
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function gitResult(path: string, args: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([
    '/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'credential.helper=', '-C', path, ...args,
  ], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: {
      PATH: '/usr/bin:/bin', HOME: '/', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    },
  })
}

function git(path: string, args: string[]): string {
  const result = gitResult(path, args)
  if (result.exitCode !== 0) {
    throw new Error(`Git advisor snapshot failed: ${result.stderr?.toString().slice(-2_000) ?? ''}`)
  }
  return result.stdout?.toString() ?? ''
}

export function resolveAdvisorProjectLayout(pathInput: string): AdvisorProjectLayout {
  if (!isAbsolute(pathInput)) throw new Error('advisor project path must be absolute')
  const projectPath = realpathSync(pathInput)
  const result = gitResult(projectPath, ['rev-parse', '--show-toplevel'])
  if (result.exitCode !== 0) return { projectPath, gitRoot: null }
  const candidate = result.stdout?.toString().trim() ?? ''
  if (!candidate || !isAbsolute(candidate)) throw new Error('Git worktree root is invalid')
  const gitRoot = realpathSync(candidate)
  if (!contained(gitRoot, projectPath)) {
    throw new Error('advisor project is outside its physical Git worktree')
  }
  return { projectPath, gitRoot }
}

function fileIdentity(path: string, protectedContent: boolean): string {
  let metadata: ReturnType<typeof lstatSync>
  try { metadata = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
  const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!owned || (!metadata.isDirectory() && metadata.nlink !== 1)) {
    throw new Error(`unsafe dirty path in advisor snapshot: ${path}`)
  }
  const identity = [metadata.mode, metadata.uid, metadata.nlink, metadata.size,
    metadata.dev, metadata.ino, metadata.mtimeMs, metadata.ctimeMs].join(':')
  if (protectedContent || !metadata.isFile()) return `metadata:${identity}`
  if (metadata.size > MAX_DIRTY_FILE_BYTES) {
    throw new Error(`dirty file is too large for advisor snapshot: ${path}`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino || opened.size !== metadata.size
      || opened.mtimeMs !== metadata.mtimeMs || opened.ctimeMs !== metadata.ctimeMs) {
      throw new Error(`dirty file changed during advisor snapshot: ${path}`)
    }
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, opened.size)))
    let offset = 0
    while (offset < opened.size) {
      const length = Math.min(buffer.length, opened.size - offset)
      const count = readSync(descriptor, buffer, 0, length, offset)
      if (count <= 0) throw new Error(`short read during advisor snapshot: ${path}`)
      hash.update(buffer.subarray(0, count))
      offset += count
    }
    const after = fstatSync(descriptor)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`dirty file changed during advisor snapshot: ${path}`)
    }
    return `sha256:${hash.digest('hex')}:${identity}`
  } finally {
    closeSync(descriptor)
  }
}

function dirtyPaths(status: string): string[] {
  const entries = status.split('\0')
  const paths: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    if (entry.length < 4) throw new Error('Git status entry is malformed')
    const code = entry.slice(0, 2)
    const first = entry.slice(3)
    if (first) paths.push(first)
    if (/[RC]/.test(code)) {
      const second = entries[index + 1]
      if (second) paths.push(second)
      index += 1
    }
  }
  return [...new Set(paths)].sort()
}

export function snapshotAdvisorRepository(
  layoutInput: AdvisorProjectLayout,
): AdvisorRepositorySnapshot {
  const layout = resolveAdvisorProjectLayout(layoutInput.projectPath)
  if (layout.gitRoot !== layoutInput.gitRoot) {
    throw new Error('advisor Git layout changed during execution')
  }
  if (!layout.gitRoot) {
    const dirty: Record<string, string> = {}
    const pending = ['']
    let entries = 0
    while (pending.length > 0) {
      const parent = pending.pop()!
      const absoluteParent = resolve(layout.projectPath, parent)
      const names = readdirSync(absoluteParent).sort()
      for (const name of names) {
        const relativePath = parent ? `${parent}/${name}` : name
        const lexical = resolve(layout.projectPath, relativePath)
        if (!contained(layout.projectPath, lexical)) {
          throw new Error('non-Git advisor snapshot escaped the project root')
        }
        entries += 1
        if (entries > MAX_NON_GIT_ENTRIES) {
          throw new Error('non-Git project is too large for a bounded advisor snapshot')
        }
        const metadata = lstatSync(lexical)
        const protectedContent = relativePath.split('/').some(value => PROTECTED_COMPONENT.test(value))
        dirty[relativePath] = fileIdentity(lexical, protectedContent)
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) pending.push(relativePath)
      }
    }
    return {
      version: 1,
      projectPath: layout.projectPath,
      gitRoot: null,
      head: null,
      status: 'non-git-project-v1',
      dirty,
    }
  }
  const status = git(layout.gitRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const dirty: Record<string, string> = {}
  for (const relativePath of dirtyPaths(status)) {
    const lexical = resolve(layout.gitRoot, relativePath)
    if (!contained(layout.gitRoot, lexical)) {
      throw new Error('Git status returned a path outside the worktree')
    }
    const protectedContent = relativePath.split('/').some(value => PROTECTED_COMPONENT.test(value))
    dirty[relativePath] = fileIdentity(lexical, protectedContent)
  }
  return {
    version: 1,
    projectPath: layout.projectPath,
    gitRoot: layout.gitRoot,
    head: git(layout.gitRoot, ['rev-parse', 'HEAD']).trim(),
    status,
    dirty,
  }
}

export function advisorRepositoryDigest(snapshot: AdvisorRepositorySnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}
