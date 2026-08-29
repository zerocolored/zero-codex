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
} from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'
import {
  resolveProjectLayout,
  type ProjectLayoutKind,
} from './project-layout.ts'

const MAX_DIRTY_FILE_BYTES = 64 * 1024 * 1024
const MAX_NON_GIT_ENTRIES = 50_000
const PROTECTED_COMPONENT = /^(?:\.env.*|.*(?:auth|credential|token|secret).*|sessions|logs|memories)$/i

export type AdvisorProjectLayout = {
  projectPath: string
  kind: ProjectLayoutKind
  gitRoot: string | null
  gitRoots: string[]
  memberNames: string[]
  excludedDirectPaths: string[]
  rootInstructionPaths: string[]
}

export type AdvisorGitRepositorySnapshot = {
  gitRoot: string
  head: string
  status: string
  dirty: Record<string, string>
}

export type AdvisorRepositorySnapshot = {
  version: 2
  projectPath: string
  kind: ProjectLayoutKind
  gitRoot: string | null
  gitRoots: string[]
  head: string | null
  status: string
  dirty: Record<string, string>
  repositories: AdvisorGitRepositorySnapshot[]
  rootInstructions: Record<string, string>
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
  const layout = resolveProjectLayout(pathInput)
  return {
    projectPath: layout.projectPath,
    kind: layout.kind,
    gitRoot: layout.gitRoot,
    gitRoots: layout.gitRoots,
    memberNames: layout.memberNames,
    excludedDirectPaths: layout.excludedDirectPaths,
    rootInstructionPaths: layout.rootInstructionPaths,
  }
}

function fileIdentity(
  path: string,
  protectedContent: boolean,
  expectedHardlink?: ReturnType<typeof lstatSync>,
): string {
  let metadata: ReturnType<typeof lstatSync>
  try { metadata = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
  const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (expectedHardlink && (metadata.dev !== expectedHardlink.dev
    || metadata.ino !== expectedHardlink.ino || metadata.nlink !== expectedHardlink.nlink
    || metadata.mode !== expectedHardlink.mode || metadata.uid !== expectedHardlink.uid
    || metadata.gid !== expectedHardlink.gid || metadata.size !== expectedHardlink.size
    || metadata.mtimeMs !== expectedHardlink.mtimeMs
    || metadata.ctimeMs !== expectedHardlink.ctimeMs)) {
    throw new Error(`dirty hardlink changed during advisor snapshot: ${path}`)
  }
  if (!owned || (!metadata.isDirectory() && metadata.nlink !== 1 && !expectedHardlink)) {
    throw new Error(`unsafe dirty path in advisor snapshot: ${path}`)
  }
  const identity = [metadata.mode, metadata.uid, metadata.nlink, metadata.size,
    metadata.dev, metadata.ino, metadata.mtimeMs, metadata.ctimeMs].join(':')
  if (protectedContent || !metadata.isFile() || metadata.nlink !== 1) {
    const observed = lstatSync(path)
    if (observed.dev !== metadata.dev || observed.ino !== metadata.ino
      || observed.nlink !== metadata.nlink || observed.mode !== metadata.mode
      || observed.uid !== metadata.uid || observed.gid !== metadata.gid
      || observed.size !== metadata.size || observed.mtimeMs !== metadata.mtimeMs
      || observed.ctimeMs !== metadata.ctimeMs) {
      throw new Error(`dirty path changed during advisor snapshot: ${path}`)
    }
    return `metadata:${identity}`
  }
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
  if (layout.kind !== layoutInput.kind || layout.gitRoot !== layoutInput.gitRoot
    || JSON.stringify(layout.gitRoots) !== JSON.stringify(layoutInput.gitRoots)) {
    throw new Error('advisor Git layout changed during execution')
  }
  if (layout.kind === 'non-git') {
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
      version: 2,
      projectPath: layout.projectPath,
      kind: layout.kind,
      gitRoot: null,
      gitRoots: [],
      head: null,
      status: 'non-git-project-v1',
      dirty,
      repositories: [],
      rootInstructions: {},
    }
  }

  const snapshotGitRoot = (gitRoot: string): AdvisorGitRepositorySnapshot => {
    const status = git(gitRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const dirty: Record<string, string> = {}
    const entries = dirtyPaths(status).map(relativePath => {
      const lexical = resolve(gitRoot, relativePath)
      if (!contained(gitRoot, lexical)) {
        throw new Error('Git status returned a path outside the worktree')
      }
      let metadata: ReturnType<typeof lstatSync> | null
      try { metadata = lstatSync(lexical) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        metadata = null
      }
      return { relativePath, lexical, metadata }
    })
    const hardlinkGroups = new Map<string, typeof entries>()
    for (const entry of entries) {
      if (!entry.metadata?.isFile() || entry.metadata.nlink <= 1) continue
      const key = `${entry.metadata.dev}:${entry.metadata.ino}`
      const group = hardlinkGroups.get(key) ?? []
      group.push(entry)
      hardlinkGroups.set(key, group)
    }
    const acceptedHardlinks = new Map<string, ReturnType<typeof lstatSync>>()
    for (const group of hardlinkGroups.values()) {
      const expectedLinks = group[0]!.metadata!.nlink
      if (group.length !== expectedLinks
        || group.some(entry => entry.metadata!.nlink !== expectedLinks)) {
        throw new Error('unsafe dirty hardlink has aliases outside the same repository dirty set')
      }
      for (const entry of group) acceptedHardlinks.set(entry.relativePath, entry.metadata!)
    }
    for (const { relativePath, lexical } of entries) {
      const protectedContent = relativePath.split('/').some(value => PROTECTED_COMPONENT.test(value))
      dirty[relativePath] = fileIdentity(
        lexical,
        protectedContent,
        acceptedHardlinks.get(relativePath),
      )
    }
    return {
      gitRoot,
      head: git(gitRoot, ['rev-parse', 'HEAD']).trim(),
      status,
      dirty,
    }
  }
  const repositories = layout.gitRoots.map(snapshotGitRoot)
  if (layout.kind === 'multi-repo-workspace') {
    const rootInstructions = Object.fromEntries(layout.rootInstructionPaths.map(path => [
      relative(layout.projectPath, path),
      fileIdentity(path, false),
    ]))
    const dirty: Record<string, string> = {}
    repositories.forEach((repository, index) => {
      const namespace = layout.memberNames[index]!
      for (const [path, identity] of Object.entries(repository.dirty)) {
        dirty[`${namespace}/${path}`] = identity
      }
    })
    return {
      version: 2,
      projectPath: layout.projectPath,
      kind: layout.kind,
      gitRoot: null,
      gitRoots: layout.gitRoots,
      head: null,
      status: 'multi-repo-workspace-v1',
      dirty,
      repositories,
      rootInstructions,
    }
  }

  const repository = repositories[0]!
  const dirty: Record<string, string> = {}
  Object.assign(dirty, repository.dirty)
  return {
    version: 2,
    projectPath: layout.projectPath,
    kind: layout.kind,
    gitRoot: layout.gitRoot,
    gitRoots: layout.gitRoots,
    head: repository.head,
    status: repository.status,
    dirty,
    repositories,
    rootInstructions: {},
  }
}

export function advisorRepositoryDigest(snapshot: AdvisorRepositorySnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}
