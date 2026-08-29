#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { lstatSync, realpathSync } from 'fs'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { resolveProjectLayout } from './project-layout.ts'

export const LAST_CONNECTED_PROJECT_FILE = 'last-connected-project.json'
const LAST_PROJECT_VERSION = 1 as const
const MAX_LAST_PROJECT_BYTES = 4 * 1024

export interface LastConnectedProject {
  version: typeof LAST_PROJECT_VERSION
  projectDir: string
  connectedAt: number
}

function pathContains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

function physicalDirectory(input: string, label: string): string {
  if (!input.trim()) throw new Error(`${label} is empty`)
  let physical: string
  try {
    physical = realpathSync(input)
    if (!lstatSync(physical).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error(`${label} is not an existing directory: ${input}`)
  }
  return physical
}

function candidateGitExecutable(input: string): string {
  if (!isAbsolute(input) || input.length > 1_024 || /[\r\n\0]/.test(input)) {
    throw new Error('candidate Git path is invalid')
  }
  let physical: string
  try {
    physical = realpathSync(input)
  } catch {
    throw new Error('candidate Git path is unavailable')
  }
  if (physical !== input || basename(physical) !== 'git') {
    throw new Error('candidate Git path is not physical')
  }
  const trustedBin = dirname(physical)
  const candidateRoot = dirname(trustedBin)
  const systemTemporary = realpathSync('/tmp')
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const executable = lstatSync(physical)
  const bin = lstatSync(trustedBin)
  const root = lstatSync(candidateRoot)
  const ownerMatches = (actual: number) => uid === undefined || actual === uid
  if (dirname(candidateRoot) !== systemTemporary
    || !/^zerokun-update-candidate-[A-Za-z0-9]+$/.test(basename(candidateRoot))
    || !root.isDirectory() || root.isSymbolicLink() || !ownerMatches(root.uid)
    || (root.mode & 0o777) !== 0o700
    || !bin.isDirectory() || bin.isSymbolicLink() || !ownerMatches(bin.uid)
    || (bin.mode & 0o777) !== 0o500
    || !executable.isFile() || executable.isSymbolicLink() || executable.nlink !== 1
    || !ownerMatches(executable.uid) || (executable.mode & 0o777) !== 0o500) {
    throw new Error('candidate Git staging identity is invalid')
  }
  return physical
}

export function projectGitExecutable(
  environment: Record<string, string | undefined> = process.env,
): string {
  const candidate = environment.ZERO_CODEX_CANDIDATE_GIT
  const candidateMode = environment.ZERO_CODEX_CANDIDATE_SANDBOX === '1'
    && environment.CODEX_SANDBOX === 'seatbelt'
  if (candidate === undefined && !candidateMode) return '/usr/bin/git'
  if (!candidate || !candidateMode) {
    throw new Error('candidate Git requires the verified Codex sandbox')
  }
  return candidateGitExecutable(candidate)
}

function gitOutput(projectDir: string, ...args: string[]): string {
  const result = Bun.spawnSync([
    projectGitExecutable(),
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'credential.helper=',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=never',
    '-C', projectDir,
    ...args,
  ], {
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`Slack project must be inside a Git worktree: ${projectDir}`)
  }
  return result.stdout.toString().trim()
}

function gitCommonDirectory(projectDir: string): string {
  const raw = gitOutput(projectDir, 'rev-parse', '--git-common-dir')
  return realpathSync(isAbsolute(raw) ? raw : resolve(projectDir, raw))
}

export function validateLaunchProject(
  input: string,
  options: {
    runtimeRepo: string
    stateDir: string
    homeDir?: string
  },
): string {
  const projectDir = physicalDirectory(input, 'Slack project')
  const runtimeRepo = physicalDirectory(options.runtimeRepo, 'Zero runtime repository')
  const stateDir = physicalDirectory(options.stateDir, 'Zero managed state')
  const homeDir = physicalDirectory(options.homeDir ?? homedir(), 'home directory')

  if (projectDir === resolve('/') || projectDir === homeDir) {
    throw new Error(`Slack project cannot be the filesystem root or home directory: ${projectDir}`)
  }
  if (pathContains(runtimeRepo, projectDir) || pathContains(projectDir, runtimeRepo)) {
    throw new Error(`Slack project must be separate from the Zero runtime repository: ${projectDir}`)
  }
  if (pathContains(stateDir, projectDir) || pathContains(projectDir, stateDir)) {
    throw new Error(`Slack project must be separate from Zero managed state: ${projectDir}`)
  }

  const layout = resolveProjectLayout(projectDir, { gitExecutable: projectGitExecutable() })
  if (layout.kind === 'non-git') {
    throw new Error(
      `Slack project must be inside a Git worktree or contain at least two direct-child Git repositories: ${projectDir}`,
    )
  }
  const runtimeCommonDirectory = gitCommonDirectory(runtimeRepo)
  for (const gitRoot of layout.gitRoots) {
    if (gitCommonDirectory(gitRoot) === runtimeCommonDirectory) {
      throw new Error(`Slack project cannot share Git metadata with the Zero runtime: ${gitRoot}`)
    }
  }
  return projectDir
}

export function lastConnectedProjectPath(stateDir: string): string {
  return join(stateDir, LAST_CONNECTED_PROJECT_FILE)
}

export function readLastConnectedProject(stateDir: string): LastConnectedProject | null {
  const path = lastConnectedProjectPath(stateDir)
  const content = readOptionalBoundedOwnerOnlyRegularFile(path, MAX_LAST_PROJECT_BYTES)
  if (content === null) return null
  let value: unknown
  try { value = JSON.parse(content) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== LAST_PROJECT_VERSION
    || typeof record.projectDir !== 'string' || !isAbsolute(record.projectDir)
    || !Number.isSafeInteger(record.connectedAt) || Number(record.connectedAt) <= 0) return null
  try {
    const projectDir = physicalDirectory(record.projectDir, 'last connected Slack project')
    return {
      version: LAST_PROJECT_VERSION,
      projectDir,
      connectedAt: Number(record.connectedAt),
    }
  } catch {
    return null
  }
}

export function writeLastConnectedProject(
  stateDir: string,
  projectDirInput: string,
  connectedAt = Date.now(),
): LastConnectedProject {
  if (!Number.isSafeInteger(connectedAt) || connectedAt <= 0) {
    throw new Error('last connected project timestamp is invalid')
  }
  const projectDir = physicalDirectory(projectDirInput, 'connected Slack project')
  const record: LastConnectedProject = {
    version: LAST_PROJECT_VERSION,
    projectDir,
    connectedAt,
  }
  atomicWritePrivateFile(lastConnectedProjectPath(stateDir), `${JSON.stringify(record)}\n`)
  return record
}

function usage(): never {
  throw new Error(
    'usage: project-selection.ts validate-launch <project> <runtime-repo> <state-dir> [home-dir]'
    + ' | read-last <state-dir>',
  )
}

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === 'validate-launch' && (args.length === 3 || args.length === 4)) {
      process.stdout.write(`${validateLaunchProject(args[0]!, {
        runtimeRepo: args[1]!, stateDir: args[2]!, ...(args[3] ? { homeDir: args[3] } : {}),
      })}\n`)
    } else if (command === 'read-last' && args.length === 1) {
      const record = readLastConnectedProject(args[0]!)
      if (!record) throw new Error('last connected Slack project is unavailable')
      process.stdout.write(`${record.projectDir}\n`)
    } else usage()
  } catch (error) {
    process.stderr.write(`project selection: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
