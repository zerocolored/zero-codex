#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
} from 'fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'
import {
  atomicWritePrivateFile,
  readOptionalBoundedOwnerOnlyRegularFile,
} from './safe-file.ts'
import { projectGitExecutable } from './project-git.ts'

const MAX_DIRECT_ENTRIES = 1_024
const MAX_WORKSPACE_REPOSITORIES = 16
const MAX_PIN_BYTES = 16 * 1024
const MAX_ROOT_INSTRUCTION_BYTES = 1024 * 1024
const WORKSPACE_PIN_VERSION = 1 as const
const ROOT_INSTRUCTION_NAMES = new Set(['AGENTS.md', 'CLAUDE.md'])

export type ProjectLayoutKind = 'git-worktree' | 'multi-repo-workspace' | 'non-git'

export type ProjectLayout = {
  projectPath: string
  kind: ProjectLayoutKind
  gitRoot: string | null
  gitRoots: string[]
  memberNames: string[]
  excludedDirectPaths: string[]
  rootInstructionPaths: string[]
  pinned: boolean
}

type WorkspacePin = {
  version: typeof WORKSPACE_PIN_VERSION
  kind: 'multi-repo-workspace'
  members: string[]
}

function ownerMatches(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid()
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

// Keep member ordering independent of the host locale and aligned with
// Python's Unicode code-point ordering in the fifth-advisor helper.
function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, character => character.codePointAt(0)!)
  const rightPoints = Array.from(right, character => character.codePointAt(0)!)
  const sharedLength = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index]
    }
  }
  return leftPoints.length - rightPoints.length
}

function physicalDirectory(pathInput: string): string {
  if (!isAbsolute(pathInput) || /[\0\r\n]/.test(pathInput)) {
    throw new Error(`project path must be an absolute directory: ${pathInput}`)
  }
  const physical = realpathSync(pathInput)
  const metadata = lstatSync(physical)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`project path must be a physical directory: ${pathInput}`)
  }
  return physical
}

function gitResult(
  projectPath: string,
  args: string[],
  gitExecutable = projectGitExecutable(),
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([
    gitExecutable,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'credential.helper=',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=never',
    '-C', projectPath,
    ...args,
  ], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
}

function gitOutput(projectPath: string, args: string[], gitExecutable: string): string {
  const result = gitResult(projectPath, args, gitExecutable)
  if (result.exitCode !== 0) throw new Error('Git project metadata is unavailable')
  return result.stdout?.toString().trim() ?? ''
}

function workspacePinPath(projectPath: string): string {
  return join(projectPath, '.zerochan', 'workspace.json')
}

function parseWorkspacePin(projectPath: string): WorkspacePin | null {
  const raw = readOptionalBoundedOwnerOnlyRegularFile(
    workspacePinPath(projectPath),
    MAX_PIN_BYTES,
  )
  if (raw === null) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('Zeroちゃんworkspace設定JSONが壊れています') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Zeroちゃんworkspace設定JSONが不正です')
  }
  const record = value as Record<string, unknown>
  if (record.version !== WORKSPACE_PIN_VERSION || record.kind !== 'multi-repo-workspace'
    || Object.keys(record).sort().join(',') !== 'kind,members,version'
    || !Array.isArray(record.members)
    || record.members.length < 2 || record.members.length > MAX_WORKSPACE_REPOSITORIES
    || record.members.some(member => (
      typeof member !== 'string' || !member || member.startsWith('.')
      || basename(member) !== member || member.includes('/') || member.includes('\\')
      || /[\0\r\n]/.test(member)
    ))) {
    throw new Error('Zeroちゃんworkspace設定JSONが不正です')
  }
  const members = [...new Set(record.members as string[])].sort(compareUnicodeCodePoints)
  if (members.length !== record.members.length
    || JSON.stringify(members) !== JSON.stringify(record.members)) {
    throw new Error('Zeroちゃんworkspace設定のmember一覧が不正です')
  }
  return { version: WORKSPACE_PIN_VERSION, kind: 'multi-repo-workspace', members }
}

type DiscoveredWorkspace = {
  roots: string[]
  names: string[]
  excludedDirectPaths: string[]
  rootInstructionPaths: string[]
}

function validateRootInstruction(path: string, name: string): void {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || !ownerMatches(before.uid)
    || before.nlink !== 1 || (before.mode & 0o022) !== 0
    || before.size < 0 || before.size > MAX_ROOT_INSTRUCTION_BYTES) {
    throw new Error(`workspace root instructionが安全な通常fileではありません: ${name}`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.uid !== before.uid || opened.nlink !== 1 || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new Error(`workspace root instructionが検査中に変更されました: ${name}`)
    }
  } finally {
    closeSync(descriptor)
  }
}

function discoverWorkspace(
  projectPath: string,
  gitExecutable: string,
): DiscoveredWorkspace {
  const entries = readdirSync(projectPath, { withFileTypes: true })
  if (entries.length > MAX_DIRECT_ENTRIES) {
    throw new Error(`workspace直下のentryが多すぎます（最大${MAX_DIRECT_ENTRIES}件）`)
  }
  const roots: string[] = []
  const names: string[] = []
  const excludedDirectPaths: string[] = []
  const rootInstructionPaths: string[] = []
  for (const entry of entries.sort((left, right) => (
    compareUnicodeCodePoints(left.name, right.name)
  ))) {
    const candidate = join(projectPath, entry.name)
    if (ROOT_INSTRUCTION_NAMES.has(entry.name)) {
      validateRootInstruction(candidate, entry.name)
      rootInstructionPaths.push(candidate)
      continue
    }
    if (entry.name === '.zerochan') {
      excludedDirectPaths.push(candidate)
      continue
    }
    if (entry.name.startsWith('.') || !entry.isDirectory() || entry.isSymbolicLink()) {
      excludedDirectPaths.push(candidate)
      continue
    }
    const before = lstatSync(candidate)
    if (!before.isDirectory() || before.isSymbolicLink() || !ownerMatches(before.uid)) {
      excludedDirectPaths.push(candidate)
      continue
    }
    let physical: string
    try { physical = realpathSync(candidate) } catch {
      excludedDirectPaths.push(candidate)
      continue
    }
    if (physical !== candidate || !contained(projectPath, physical)) {
      throw new Error(`workspace memberが親directory外を参照しています: ${entry.name}`)
    }
    const topLevelResult = gitResult(physical, ['rev-parse', '--show-toplevel'], gitExecutable)
    if (topLevelResult.exitCode !== 0) {
      excludedDirectPaths.push(candidate)
      continue
    }
    const topLevelText = topLevelResult.stdout?.toString().trim() ?? ''
    let topLevel: string
    try { topLevel = realpathSync(topLevelText) } catch {
      throw new Error(`workspace memberのGit rootを解決できません: ${entry.name}`)
    }
    if (topLevel !== physical) {
      excludedDirectPaths.push(candidate)
      continue
    }
    const dotGit = join(physical, '.git')
    if (!existsSync(dotGit)) throw new Error(`workspace memberに.gitがありません: ${entry.name}`)
    const dotGitMetadata = lstatSync(dotGit)
    // Workspace v1 intentionally accepts ordinary clones only. Linked worktrees
    // and submodules remain fully supported when launched directly as a normal
    // single-Git project, but cannot silently widen a sibling workspace.
    if (!dotGitMetadata.isDirectory() || dotGitMetadata.isSymbolicLink()
      || !ownerMatches(dotGitMetadata.uid)) {
      throw new Error(`workspace memberは通常のGit cloneである必要があります: ${entry.name}`)
    }
    const gitDirText = gitOutput(physical, ['rev-parse', '--git-dir'], gitExecutable)
    const commonDirText = gitOutput(physical, ['rev-parse', '--git-common-dir'], gitExecutable)
    const gitDir = realpathSync(isAbsolute(gitDirText) ? gitDirText : resolve(physical, gitDirText))
    const commonDir = realpathSync(
      isAbsolute(commonDirText) ? commonDirText : resolve(physical, commonDirText),
    )
    if (!contained(physical, gitDir) || !contained(physical, commonDir)) {
      throw new Error(`workspace memberのGit metadataがmember外にあります: ${entry.name}`)
    }
    const after = lstatSync(candidate)
    if (after.dev !== before.dev || after.ino !== before.ino
      || !after.isDirectory() || after.isSymbolicLink()) {
      throw new Error(`workspace memberが検査中に変更されました: ${entry.name}`)
    }
    roots.push(physical)
    names.push(entry.name)
  }
  if (roots.length > MAX_WORKSPACE_REPOSITORIES) {
    throw new Error(`workspace memberが多すぎます（最大${MAX_WORKSPACE_REPOSITORIES}件）`)
  }
  return { roots, names, excludedDirectPaths, rootInstructionPaths }
}

export function resolveProjectLayout(
  pathInput: string,
  options: { gitExecutable?: string; ignorePin?: boolean } = {},
): ProjectLayout {
  const projectPath = physicalDirectory(pathInput)
  const gitExecutable = options.gitExecutable ?? projectGitExecutable()
  const topLevelResult = gitResult(projectPath, ['rev-parse', '--show-toplevel'], gitExecutable)
  if (topLevelResult.exitCode === 0) {
    const topLevelText = topLevelResult.stdout?.toString().trim() ?? ''
    const gitRoot = realpathSync(topLevelText)
    if (!contained(gitRoot, projectPath)) {
      throw new Error('project path is outside its physical Git worktree')
    }
    if (!options.ignorePin && parseWorkspacePin(projectPath) !== null) {
      throw new Error('workspace設定済みの親directoryがGit化されています。親の.gitを確認してください')
    }
    return {
      projectPath,
      kind: 'git-worktree',
      gitRoot,
      gitRoots: [gitRoot],
      memberNames: [],
      excludedDirectPaths: [],
      rootInstructionPaths: [],
      pinned: false,
    }
  }

  const discovered = discoverWorkspace(projectPath, gitExecutable)
  const pin = options.ignorePin ? null : parseWorkspacePin(projectPath)
  if (pin && JSON.stringify(pin.members) !== JSON.stringify(discovered.names)) {
    throw new Error(
      `workspace member構成が設定時から変わっています（設定: ${pin.members.join(', ')} / 現在: ${discovered.names.join(', ')}）`,
    )
  }
  if (discovered.roots.length < 2) {
    return {
      projectPath,
      kind: 'non-git',
      gitRoot: null,
      gitRoots: [],
      memberNames: [],
      excludedDirectPaths: discovered.excludedDirectPaths,
      rootInstructionPaths: discovered.rootInstructionPaths,
      pinned: false,
    }
  }
  return {
    projectPath,
    kind: 'multi-repo-workspace',
    gitRoot: null,
    gitRoots: discovered.roots,
    memberNames: discovered.names,
    excludedDirectPaths: discovered.excludedDirectPaths,
    rootInstructionPaths: discovered.rootInstructionPaths,
    pinned: pin !== null,
  }
}

export function ensureWorkspacePin(layoutInput: ProjectLayout): void {
  const layout = resolveProjectLayout(layoutInput.projectPath)
  if (layout.kind !== layoutInput.kind
    || JSON.stringify(layout.gitRoots) !== JSON.stringify(layoutInput.gitRoots)) {
    throw new Error('workspace layout changed before it could be pinned')
  }
  if (layout.kind !== 'multi-repo-workspace' || layout.pinned) return
  const directory = join(layout.projectPath, '.zerochan')
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const metadata = lstatSync(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownerMatches(metadata.uid)) {
    throw new Error(`安全でない.zerochanディレクトリです: ${directory}`)
  }
  chmodSync(directory, 0o700)
  const pin: WorkspacePin = {
    version: WORKSPACE_PIN_VERSION,
    kind: 'multi-repo-workspace',
    members: layout.memberNames,
  }
  atomicWritePrivateFile(workspacePinPath(layout.projectPath), `${JSON.stringify(pin, null, 2)}\n`)
  chmodSync(workspacePinPath(layout.projectPath), 0o600)
}

export function projectLayoutSummary(layout: ProjectLayout): string {
  return layout.kind === 'multi-repo-workspace'
    ? `multi-repo workspace (${layout.memberNames.join(', ')})`
    : layout.kind === 'git-worktree'
      ? 'Git worktree'
      : 'non-Git directory'
}

function usage(): never {
  throw new Error('usage: project-layout.ts inspect <project> | kind <project>')
}

if (import.meta.main) {
  try {
    const [command, project, ...extra] = process.argv.slice(2)
    if (!project || extra.length > 0) usage()
    const layout = resolveProjectLayout(resolve(project))
    if (command === 'kind') process.stdout.write(`${layout.kind}\n`)
    else if (command === 'inspect') process.stdout.write(`${JSON.stringify(layout)}\n`)
    else usage()
  } catch (error) {
    process.stderr.write(`project layout: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
