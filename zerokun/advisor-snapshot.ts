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

export type AdvisorRepositoryChange = {
  repository: string
  kind: 'added' | 'removed' | 'changed'
  headBefore: string | null
  headAfter: string | null
  statusChanged: boolean
  changedPaths: string[]
  omittedChangedPaths: number
}

export type AdvisorRepositoryChangeSummary = {
  version: 1
  baselineAvailable: boolean
  changed: boolean
  layoutChanged: boolean
  baselineDigest: string | null
  currentDigest: string
  repositories: AdvisorRepositoryChange[]
  rootInstructionPaths: string[]
  omittedRootInstructionPaths: number
}

export type AdvisorRepositoryScope = string[]

const MAX_SNAPSHOT_JSON_BYTES = 16 * 1024 * 1024
const MAX_SNAPSHOT_REPOSITORIES = 128
const MAX_SNAPSHOT_DIRTY_PATHS = 50_000
const MAX_SUMMARY_PATHS = 200

function exactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(record).sort().join('\0') === [...expected].sort().join('\0')
}

function boundedString(value: unknown, label: string, max = 4 * 1024 * 1024): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new Error(`advisor repository snapshot ${label} is invalid`)
  }
  return value
}

function validateIdentityMap(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`advisor repository snapshot ${label} is invalid`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_SNAPSHOT_DIRTY_PATHS) {
    throw new Error(`advisor repository snapshot ${label} is too large`)
  }
  for (const [path, identity] of entries) {
    if (!path || path.length > 8_192 || typeof identity !== 'string'
      || identity.length > 2_048) {
      throw new Error(`advisor repository snapshot ${label} entry is invalid`)
    }
  }
  return value as Record<string, string>
}

export function parseAdvisorRepositorySnapshot(value: string): AdvisorRepositorySnapshot {
  if (Buffer.byteLength(value) < 2 || Buffer.byteLength(value) > MAX_SNAPSHOT_JSON_BYTES) {
    throw new Error('advisor repository snapshot JSON is not bounded')
  }
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    throw new Error('advisor repository snapshot JSON is invalid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('advisor repository snapshot must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (!exactKeys(record, [
    'version', 'projectPath', 'kind', 'gitRoot', 'gitRoots', 'head', 'status',
    'dirty', 'repositories', 'rootInstructions',
  ]) || record.version !== 2
    || !['git-worktree', 'multi-repo-workspace', 'non-git'].includes(String(record.kind))) {
    throw new Error('advisor repository snapshot fields are invalid')
  }
  const projectPath = boundedString(record.projectPath, 'project path', 32_768)
  if (!isAbsolute(projectPath)) throw new Error('advisor repository snapshot project path is invalid')
  if (!Array.isArray(record.gitRoots) || record.gitRoots.length > MAX_SNAPSHOT_REPOSITORIES
    || record.gitRoots.some(root => typeof root !== 'string' || !isAbsolute(root))) {
    throw new Error('advisor repository snapshot Git roots are invalid')
  }
  if (record.gitRoot !== null && (typeof record.gitRoot !== 'string'
    || !isAbsolute(record.gitRoot))) {
    throw new Error('advisor repository snapshot Git root is invalid')
  }
  if (record.head !== null && (typeof record.head !== 'string'
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(record.head))) {
    throw new Error('advisor repository snapshot HEAD is invalid')
  }
  boundedString(record.status, 'status')
  validateIdentityMap(record.dirty, 'dirty map')
  validateIdentityMap(record.rootInstructions, 'root instructions')
  if (!Array.isArray(record.repositories)
    || record.repositories.length > MAX_SNAPSHOT_REPOSITORIES) {
    throw new Error('advisor repository snapshot repositories are invalid')
  }
  for (const repository of record.repositories) {
    if (!repository || typeof repository !== 'object' || Array.isArray(repository)
      || !exactKeys(repository as Record<string, unknown>, ['gitRoot', 'head', 'status', 'dirty'])) {
      throw new Error('advisor repository snapshot repository entry is invalid')
    }
    const entry = repository as Record<string, unknown>
    if (typeof entry.gitRoot !== 'string' || !isAbsolute(entry.gitRoot)
      || typeof entry.head !== 'string'
      || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(entry.head)) {
      throw new Error('advisor repository snapshot repository binding is invalid')
    }
    boundedString(entry.status, 'repository status')
    validateIdentityMap(entry.dirty, 'repository dirty map')
  }
  if (record.kind === 'non-git' && (record.gitRoot !== null
    || record.gitRoots.length !== 0 || record.repositories.length !== 0)) {
    throw new Error('advisor repository snapshot non-Git layout is invalid')
  }
  if (record.kind === 'git-worktree' && (record.repositories.length !== 1
    || record.gitRoots.length !== 1 || record.gitRoot !== record.gitRoots[0])) {
    throw new Error('advisor repository snapshot single-repository layout is invalid')
  }
  if (record.kind === 'multi-repo-workspace' && (record.gitRoot !== null
    || record.repositories.length !== record.gitRoots.length)) {
    throw new Error('advisor repository snapshot workspace layout is invalid')
  }
  const gitRoots = record.gitRoots as string[]
  if (record.repositories.some((repository, index) => (
    (repository as Record<string, unknown>).gitRoot !== gitRoots[index]
  ))) {
    throw new Error('advisor repository snapshot repository ordering is invalid')
  }
  return parsed as AdvisorRepositorySnapshot
}

export function serializeAdvisorRepositorySnapshot(snapshot: AdvisorRepositorySnapshot): string {
  const serialized = JSON.stringify(snapshot)
  parseAdvisorRepositorySnapshot(serialized)
  return serialized
}

function changedIdentityPaths(
  before: Record<string, string>,
  after: Record<string, string>,
): { paths: string[]; omitted: number } {
  const all = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const changed = all.filter(path => before[path] !== after[path])
  return {
    paths: changed.slice(0, MAX_SUMMARY_PATHS),
    omitted: Math.max(0, changed.length - MAX_SUMMARY_PATHS),
  }
}

export function summarizeAdvisorRepositoryChanges(
  baseline: AdvisorRepositorySnapshot | null,
  current: AdvisorRepositorySnapshot,
  repositoryScope?: readonly string[],
): AdvisorRepositoryChangeSummary {
  if (repositoryScope) {
    return summarizeAdvisorRepositoryChanges(
      baseline ? scopeAdvisorRepositorySnapshot(baseline, repositoryScope) : null,
      scopeAdvisorRepositorySnapshot(current, repositoryScope),
    )
  }
  const currentDigest = advisorRepositoryDigest(current)
  if (!baseline) {
    return {
      version: 1,
      baselineAvailable: false,
      changed: true,
      layoutChanged: false,
      baselineDigest: null,
      currentDigest,
      repositories: [],
      rootInstructionPaths: [],
      omittedRootInstructionPaths: 0,
    }
  }
  const baselineDigest = advisorRepositoryDigest(baseline)
  const layoutChanged = baseline.projectPath !== current.projectPath
    || baseline.kind !== current.kind
    || baseline.gitRoot !== current.gitRoot
    || JSON.stringify(baseline.gitRoots) !== JSON.stringify(current.gitRoots)
  const beforeRepositories = new Map(baseline.repositories.map(value => [value.gitRoot, value]))
  const afterRepositories = new Map(current.repositories.map(value => [value.gitRoot, value]))
  const repositories: AdvisorRepositoryChange[] = []
  for (const gitRoot of [...new Set([
    ...beforeRepositories.keys(), ...afterRepositories.keys(),
  ])].sort()) {
    const before = beforeRepositories.get(gitRoot)
    const after = afterRepositories.get(gitRoot)
    const pathChanges = changedIdentityPaths(before?.dirty ?? {}, after?.dirty ?? {})
    const kind = !before ? 'added' : !after ? 'removed' : 'changed'
    const statusChanged = before?.status !== after?.status
    if (kind === 'changed' && before?.head === after?.head && !statusChanged
      && pathChanges.paths.length === 0 && pathChanges.omitted === 0) continue
    const lexical = relative(current.projectPath, gitRoot)
    repositories.push({
      repository: lexical && lexical !== '..' && !lexical.startsWith(`..${sep}`)
        ? lexical
        : gitRoot,
      kind,
      headBefore: before?.head ?? null,
      headAfter: after?.head ?? null,
      statusChanged,
      changedPaths: pathChanges.paths,
      omittedChangedPaths: pathChanges.omitted,
    })
  }
  if (baseline.kind === 'non-git' && current.kind === 'non-git') {
    const paths = changedIdentityPaths(baseline.dirty, current.dirty)
    if (paths.paths.length > 0 || paths.omitted > 0) {
      repositories.push({
        repository: '.',
        kind: 'changed',
        headBefore: null,
        headAfter: null,
        statusChanged: baseline.status !== current.status,
        changedPaths: paths.paths,
        omittedChangedPaths: paths.omitted,
      })
    }
  }
  const rootChanges = changedIdentityPaths(baseline.rootInstructions, current.rootInstructions)
  return {
    version: 1,
    baselineAvailable: true,
    changed: baselineDigest !== currentDigest,
    layoutChanged,
    baselineDigest,
    currentDigest,
    repositories,
    rootInstructionPaths: rootChanges.paths,
    omittedRootInstructionPaths: rootChanges.omitted,
  }
}

function repositoryIdentifier(snapshot: AdvisorRepositorySnapshot, gitRoot: string): string {
  const lexical = relative(snapshot.projectPath, gitRoot)
  return lexical === '' ? '.' : lexical
}

export function advisorRepositoryIdentifiers(
  snapshot: AdvisorRepositorySnapshot,
): AdvisorRepositoryScope {
  if (snapshot.kind === 'non-git') return ['.']
  return snapshot.repositories.map(repository => repositoryIdentifier(snapshot, repository.gitRoot))
}

export function normalizeAdvisorRepositoryScope(
  snapshot: AdvisorRepositorySnapshot,
  repositoryScope: readonly string[],
): AdvisorRepositoryScope {
  if (!Array.isArray(repositoryScope) || repositoryScope.length === 0
    || repositoryScope.length > MAX_SNAPSHOT_REPOSITORIES
    || repositoryScope.some(value => typeof value !== 'string' || value.length === 0
      || value.length > 32_768 || value.includes('\0') || isAbsolute(value))) {
    throw new Error('advisor repository scope is invalid')
  }
  const normalized = [...repositoryScope]
  const sorted = [...normalized].sort()
  if (JSON.stringify(normalized) !== JSON.stringify(sorted)
    || new Set(normalized).size !== normalized.length) {
    throw new Error('advisor repository scope must be sorted and unique')
  }
  const available = new Set(advisorRepositoryIdentifiers(snapshot))
  if (normalized.some(value => !available.has(value))) {
    throw new Error('advisor repository scope contains an unknown repository')
  }
  return normalized
}

export function parseAdvisorRepositoryScope(
  snapshot: AdvisorRepositorySnapshot,
  value: string,
): AdvisorRepositoryScope {
  if (Buffer.byteLength(value) < 2 || Buffer.byteLength(value) > 64 * 1024) {
    throw new Error('advisor repository scope JSON is not bounded')
  }
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    throw new Error('advisor repository scope JSON is invalid')
  }
  if (!Array.isArray(parsed)) throw new Error('advisor repository scope JSON is not an array')
  return normalizeAdvisorRepositoryScope(snapshot, parsed as string[])
}

export function serializeAdvisorRepositoryScope(
  snapshot: AdvisorRepositorySnapshot,
  repositoryScope: readonly string[],
): string {
  const scope = normalizeAdvisorRepositoryScope(snapshot, repositoryScope)
  return JSON.stringify(scope)
}

export function scopeAdvisorRepositorySnapshot(
  snapshot: AdvisorRepositorySnapshot,
  repositoryScope: readonly string[],
): AdvisorRepositorySnapshot {
  const scope = normalizeAdvisorRepositoryScope(snapshot, repositoryScope)
  if (snapshot.kind !== 'multi-repo-workspace') return snapshot
  const byIdentifier = new Map(snapshot.repositories.map(repository => [
    repositoryIdentifier(snapshot, repository.gitRoot),
    repository,
  ]))
  const repositories = scope.map(identifier => byIdentifier.get(identifier)!)
  const dirty: Record<string, string> = {}
  for (const [index, repository] of repositories.entries()) {
    const namespace = scope[index]!
    for (const [path, identity] of Object.entries(repository.dirty)) {
      dirty[`${namespace}/${path}`] = identity
    }
  }
  return {
    ...snapshot,
    gitRoots: repositories.map(repository => repository.gitRoot),
    dirty,
    repositories,
  }
}

export function advisorRepositoryScopeDigest(
  snapshot: AdvisorRepositorySnapshot,
  repositoryScope: readonly string[],
): string {
  return advisorRepositoryDigest(scopeAdvisorRepositorySnapshot(snapshot, repositoryScope))
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
