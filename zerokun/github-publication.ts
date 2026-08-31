#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { createHash } from 'crypto'
import {
  lstatSync,
  realpathSync,
} from 'fs'
import { dirname, isAbsolute, join, relative as relativePath } from 'path'
import { homedir } from 'os'

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const BRANCH_MAX_BYTES = 255
export const MAX_GITHUB_PUBLICATION_REPOSITORIES = 128
const COMMAND_OUTPUT_LIMIT = 2 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 2 * 60 * 1_000

export type GitHubRepositoryIdentity = {
  owner: string
  repository: string
  slug: string
  canonicalUrl: string
}

export type GitHubPublicationBaselineRepository = {
  gitRoot: string
  initialHead: string
  baseBranch: string
  statusDigest: string
  localConfigDigest: string
  originUrlDigest: string
  remote: GitHubRepositoryIdentity
}

export type GitHubPublicationBaseline = {
  version: 1
  projectPath: string
  repositories: GitHubPublicationBaselineRepository[]
}

export type GitHubPublicationPlan = {
  version: 1
  gitRoot: string
  repositorySlug: string
  canonicalUrl: string
  baseBranch: string
  headBranch: string
  commitSha: string
  initialHead: string
  statusDigest: string
  localConfigDigest: string
  originUrlDigest: string
  title: string
}

export type GitHubPublicationSet = {
  version: 1
  jobId: string
  jobAttempt: number
  logicalNonce: string
  inputRevision: number
  inputDigest: string
  reviewRound: 1 | 2 | 3
  reviewedRepositoryDigest: string
  baselineDigest: string
  plans: GitHubPublicationPlan[]
}

export type GitHubPublicationReceipt = {
  repositorySlug: string
  baseBranch: string
  headBranch: string
  commitSha: string
  pullRequestNumber: number
  pullRequestUrl: string
}

export type PublicationCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut?: boolean
}

export interface GitHubPublicationCommands {
  runGit(repo: string, args: readonly string[], signal?: AbortSignal): Promise<PublicationCommandResult>
  runGh(args: readonly string[], stdin?: string, signal?: AbortSignal): Promise<PublicationCommandResult>
}

export class GitHubPublicationError extends Error {
  constructor(
    readonly category: 'authentication' | 'network' | 'conflict' | 'configuration' | 'remote'
      | 'cleanup',
    message: string,
  ) {
    super(message)
    this.name = 'GitHubPublicationError'
  }
}

function gitSync(repo: string, args: readonly string[], allowFailure = false): string {
  const result = Bun.spawnSync([
    '/usr/bin/git',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'credential.helper=',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=never',
    '-C', repo,
    ...args,
  ], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      SSH_ASKPASS: '/usr/bin/false',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      LC_ALL: 'C',
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0 && !allowFailure) {
    throw new GitHubPublicationError('configuration', 'Git repository metadata is unavailable')
  }
  return result.exitCode === 0 ? result.stdout.toString() : ''
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function validBranch(repo: string, value: string): string {
  const branch = value.trim()
  if (!branch || Buffer.byteLength(branch) > BRANCH_MAX_BYTES || /[\0\r\n]/.test(branch)) {
    throw new GitHubPublicationError('configuration', 'Git branch binding is invalid')
  }
  const result = Bun.spawnSync([
    '/usr/bin/git', 'check-ref-format', '--branch', branch,
  ], {
    env: { PATH: '/usr/bin:/bin', HOME: '/', LC_ALL: 'C' },
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  })
  if (result.exitCode !== 0) {
    throw new GitHubPublicationError('configuration', `Git branch binding is invalid for ${repo}`)
  }
  return branch
}

function parseGitHubRemote(value: string): GitHubRepositoryIdentity {
  const remote = value.trim()
  if (!remote || /[\0\r\n]/.test(remote) || remote.length > 2_048) {
    throw new GitHubPublicationError('configuration', 'GitHub origin URL is invalid')
  }
  let owner = ''
  let repository = ''
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote)
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote)
  const ssh = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote)
  const match = https ?? scp ?? ssh
  if (match) {
    owner = match[1]!
    repository = match[2]!
  }
  const component = /^[A-Za-z0-9_.-]{1,100}$/
  if (!component.test(owner) || !component.test(repository)
    || owner === '.' || owner === '..' || repository === '.' || repository === '..') {
    throw new GitHubPublicationError(
      'configuration',
      'origin must be a canonical github.com owner/repository URL without embedded credentials',
    )
  }
  const slug = `${owner}/${repository}`
  return { owner, repository, slug, canonicalUrl: `https://github.com/${slug}.git` }
}

function localConfig(repo: string): { digest: string; origin: GitHubRepositoryIdentity; originDigest: string } {
  const raw = gitSync(repo, ['config', '--local', '--null', '--list'])
  const entries = raw.split('\0').filter(Boolean).map(entry => {
    const separator = entry.indexOf('\n')
    if (separator <= 0) {
      throw new GitHubPublicationError('configuration', 'local Git config contains an invalid entry')
    }
    return { key: entry.slice(0, separator).toLowerCase(), value: entry.slice(separator + 1) }
  })
  const forbidden = entries.find(({ key }) => (
    key === 'include.path' || key.startsWith('includeif.')
    || key.startsWith('credential.') || key.startsWith('http.') || key.startsWith('url.')
    || key.startsWith('protocol.') || key === 'core.sshcommand' || key === 'core.gitproxy'
    || key === 'core.hookspath' || key === 'core.alternaterefscommand'
    || /^remote\.[^.]+\.(?:pushurl|proxy|receivepack|uploadpack|vcs)$/.test(key)
  ))
  if (forbidden) {
    throw new GitHubPublicationError(
      'configuration',
      'local Git config contains a setting that is unsafe for host publication',
    )
  }
  const originValues = entries.filter(entry => entry.key === 'remote.origin.url')
  if (originValues.length !== 1) {
    throw new GitHubPublicationError('configuration', 'repository must have exactly one origin URL')
  }
  const origin = parseGitHubRemote(originValues[0]!.value)
  return { digest: digest(raw), origin, originDigest: digest(originValues[0]!.value) }
}

function repositoryState(repoInput: string): {
  gitRoot: string
  head: string
  branch: string
  statusDigest: string
  config: ReturnType<typeof localConfig>
} {
  const gitRoot = realpathSync(repoInput)
  const topLevel = realpathSync(gitSync(gitRoot, ['rev-parse', '--show-toplevel']).trim())
  if (topLevel !== gitRoot) {
    throw new GitHubPublicationError('configuration', 'publication repository root changed')
  }
  const head = gitSync(gitRoot, ['rev-parse', '--verify', 'HEAD']).trim()
  if (!SHA_PATTERN.test(head)) {
    throw new GitHubPublicationError('configuration', 'publication commit binding is invalid')
  }
  const branch = validBranch(
    gitRoot,
    gitSync(gitRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(),
  )
  const status = gitSync(gitRoot, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none',
  ])
  return { gitRoot, head, branch, statusDigest: digest(status), config: localConfig(gitRoot) }
}

export function captureGitHubPublicationBaseline(
  projectPathInput: string,
  gitRoots: readonly string[],
): GitHubPublicationBaseline {
  const projectPath = realpathSync(projectPathInput)
  const repositories = gitRoots.map(root => {
    const state = repositoryState(root)
    if (state.statusDigest !== digest('')) {
      throw new GitHubPublicationError(
        'configuration',
        'publication repository must be clean before implementation begins',
      )
    }
    return {
      gitRoot: state.gitRoot,
      initialHead: state.head,
      baseBranch: state.branch,
      statusDigest: state.statusDigest,
      localConfigDigest: state.config.digest,
      originUrlDigest: state.config.originDigest,
      remote: state.config.origin,
    }
  })
  if (new Set(repositories.map(value => value.gitRoot)).size !== repositories.length) {
    throw new GitHubPublicationError('configuration', 'publication repository roots are not unique')
  }
  if (repositories.length === 0
    || repositories.length > MAX_GITHUB_PUBLICATION_REPOSITORIES) {
    throw new GitHubPublicationError('configuration', 'publication repository count is invalid')
  }
  if (new Set(repositories.map(value => value.remote.slug.toLowerCase())).size
    !== repositories.length) {
    throw new GitHubPublicationError(
      'configuration',
      'publication repositories must map to unique GitHub repositories',
    )
  }
  return { version: 1, projectPath, repositories }
}

export function extendGitHubPublicationBaseline(
  baseline: GitHubPublicationBaseline,
  gitRoots: readonly string[],
): GitHubPublicationBaseline {
  if (baseline.version !== 1 || realpathSync(baseline.projectPath) !== baseline.projectPath) {
    throw new GitHubPublicationError('configuration', 'publication baseline is invalid')
  }
  const existing = new Set(baseline.repositories.map(repository => repository.gitRoot))
  const missing = gitRoots.map(root => realpathSync(root)).filter(root => !existing.has(root))
  if (missing.length === 0) return baseline
  const addition = captureGitHubPublicationBaseline(baseline.projectPath, missing)
  const repositories = [...baseline.repositories, ...addition.repositories]
    .sort((left, right) => left.gitRoot.localeCompare(right.gitRoot))
  if (repositories.length > MAX_GITHUB_PUBLICATION_REPOSITORIES
    || new Set(repositories.map(value => value.gitRoot)).size !== repositories.length
    || new Set(repositories.map(value => value.remote.slug.toLowerCase())).size
      !== repositories.length) {
    throw new GitHubPublicationError(
      'configuration',
      'extended publication repositories are invalid or not unique',
    )
  }
  return { ...baseline, repositories }
}

export function gitHubPublicationBaselineDigest(
  baseline: GitHubPublicationBaseline,
): string {
  return digest(JSON.stringify(baseline))
}

function commitTitle(repo: string, commit: string): string {
  const raw = gitSync(repo, ['log', '-1', '--format=%s', commit])
    .replace(/[\0\r\n]+/g, ' ').trim()
  const title = raw.slice(0, 200)
  return title || 'Apply reviewed changes'
}

export function prepareGitHubPublicationPlans(
  baseline: GitHubPublicationBaseline,
  repositoryScope?: readonly string[],
  reviewedRepositories?: readonly { gitRoot: string; head: string }[],
  expectedHeadBranch?: string,
): GitHubPublicationPlan[] {
  if (baseline.version !== 1 || realpathSync(baseline.projectPath) !== baseline.projectPath) {
    throw new GitHubPublicationError('configuration', 'publication baseline is invalid')
  }
  const allowed = repositoryScope ? new Set(repositoryScope) : null
  if (allowed) {
    const available = new Set(baseline.repositories.map(repository => (
      relativePath(baseline.projectPath, repository.gitRoot) || '.'
    )))
    if (allowed.size !== repositoryScope!.length
      || [...allowed].some(repository => !available.has(repository))) {
      throw new GitHubPublicationError(
        'configuration',
        'publication repository scope is not fully bound by the pre-write baseline',
      )
    }
  }
  const reviewedHeads = reviewedRepositories
    ? new Map(reviewedRepositories.map(repository => [repository.gitRoot, repository.head]))
    : null
  if (reviewedHeads && reviewedHeads.size !== reviewedRepositories!.length) {
    throw new GitHubPublicationError('configuration', 'reviewed publication repositories are not unique')
  }
  const requiredHeadBranch = expectedHeadBranch === undefined
    ? undefined
    : validBranch(baseline.projectPath, expectedHeadBranch)
  const plans: GitHubPublicationPlan[] = []
  for (const initial of baseline.repositories) {
    const relative = relativePath(baseline.projectPath, initial.gitRoot) || '.'
    if (isAbsolute(relative) || relative === '..' || relative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new GitHubPublicationError('configuration', 'publication repository is outside the project root')
    }
    if (allowed && !allowed.has(relative)) continue
    const current = repositoryState(initial.gitRoot)
    if (current.config.digest !== initial.localConfigDigest
      || current.config.originDigest !== initial.originUrlDigest
      || current.config.origin.slug.toLowerCase() !== initial.remote.slug.toLowerCase()
      || current.statusDigest !== initial.statusDigest) {
      throw new GitHubPublicationError(
        'configuration',
        'repository config, origin, or uncommitted state changed outside the reviewed commit',
      )
    }
    if (current.head !== initial.initialHead || current.branch !== initial.baseBranch) {
      throw new GitHubPublicationError(
        'configuration',
        'implementation must return the clean checkout to its prepared base before publication',
      )
    }
    if (requiredHeadBranch === undefined) {
      throw new GitHubPublicationError(
        'configuration',
        'changed repositories require a host-assigned publication branch',
      )
    }
    const featureHead = gitSync(
      current.gitRoot,
      ['rev-parse', '--verify', `refs/heads/${requiredHeadBranch}^{commit}`],
      true,
    ).trim()
    if (!featureHead) {
      const reviewedHead = reviewedHeads?.get(initial.gitRoot)
      if (reviewedHead && reviewedHead !== initial.initialHead) {
        throw new GitHubPublicationError(
          'configuration',
          'reviewed changes are not on the host-assigned publication branch',
        )
      }
      continue
    }
    if (!SHA_PATTERN.test(featureHead)) {
      throw new GitHubPublicationError('configuration', 'publication branch commit is invalid')
    }
    if (reviewedHeads && reviewedHeads.get(initial.gitRoot) !== featureHead) {
      throw new GitHubPublicationError(
        'configuration',
        'publication commit changed after the accepted read-only review',
      )
    }
    if (featureHead === initial.initialHead) continue
    const ancestor = Bun.spawnSync([
      '/usr/bin/git', '-C', current.gitRoot,
      'merge-base', '--is-ancestor', initial.initialHead, featureHead,
    ], {
      env: {
        PATH: '/usr/bin:/bin', HOME: '/', GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C',
      },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    if (ancestor.exitCode !== 0) {
      throw new GitHubPublicationError(
        'configuration',
        'reviewed feature commit is not descended from the prepared base commit',
      )
    }
    plans.push({
      version: 1,
      gitRoot: current.gitRoot,
      repositorySlug: initial.remote.slug,
      canonicalUrl: initial.remote.canonicalUrl,
      baseBranch: initial.baseBranch,
      headBranch: requiredHeadBranch,
      commitSha: featureHead,
      initialHead: initial.initialHead,
      statusDigest: initial.statusDigest,
      localConfigDigest: initial.localConfigDigest,
      originUrlDigest: initial.originUrlDigest,
      title: commitTitle(current.gitRoot, featureHead),
    })
  }
  return plans
}

function assertGitHubPublicationPlanShape(value: GitHubPublicationPlan): void {
  if (!value || value.version !== 1 || !SHA_PATTERN.test(value.commitSha)
    || !SHA_PATTERN.test(value.initialHead) || !/^[0-9a-f]{64}$/.test(value.statusDigest)
    || !/^[0-9a-f]{64}$/.test(value.localConfigDigest)
    || !/^[0-9a-f]{64}$/.test(value.originUrlDigest)
    || value.title.length < 1 || value.title.length > 200 || /[\0\r\n]/.test(value.title)) {
    throw new GitHubPublicationError('configuration', 'publication plan is invalid')
  }
  const remote = parseGitHubRemote(value.canonicalUrl)
  if (remote.slug.toLowerCase() !== value.repositorySlug.toLowerCase()
    || value.baseBranch === value.headBranch) {
    throw new GitHubPublicationError('configuration', 'publication plan identity is invalid')
  }
  validBranch(value.gitRoot, value.baseBranch)
  validBranch(value.gitRoot, value.headBranch)
}

export function assertGitHubPublicationPlan(value: GitHubPublicationPlan): void {
  assertGitHubPublicationPlanShape(value)
  const state = repositoryState(value.gitRoot)
  const featureHead = gitSync(
    state.gitRoot,
    ['rev-parse', '--verify', `refs/heads/${value.headBranch}^{commit}`],
    true,
  ).trim()
  if (state.head !== value.initialHead || state.branch !== value.baseBranch
    || featureHead !== value.commitSha
    || state.statusDigest !== value.statusDigest
    || state.config.digest !== value.localConfigDigest
    || state.config.originDigest !== value.originUrlDigest
    || state.config.origin.slug.toLowerCase() !== value.repositorySlug.toLowerCase()
    || value.baseBranch === value.headBranch) {
    throw new GitHubPublicationError('configuration', 'publication plan no longer matches the repository')
  }
}

function assertGitHubPublicationSource(value: GitHubPublicationPlan): void {
  assertGitHubPublicationPlanShape(value)
  const gitRoot = realpathSync(value.gitRoot)
  if (gitRoot !== value.gitRoot
    || realpathSync(gitSync(gitRoot, ['rev-parse', '--show-toplevel']).trim()) !== gitRoot) {
    throw new GitHubPublicationError('configuration', 'publication repository root changed')
  }
  const config = localConfig(gitRoot)
  if (config.digest !== value.localConfigDigest
    || config.originDigest !== value.originUrlDigest
    || config.origin.slug.toLowerCase() !== value.repositorySlug.toLowerCase()) {
    throw new GitHubPublicationError('configuration', 'publication repository identity changed')
  }
  const commit = gitSync(gitRoot, ['rev-parse', '--verify', `${value.commitSha}^{commit}`]).trim()
  if (commit !== value.commitSha) {
    throw new GitHubPublicationError('configuration', 'reviewed publication commit is unavailable')
  }
  const ancestor = Bun.spawnSync([
    '/usr/bin/git', '-C', gitRoot,
    'merge-base', '--is-ancestor', value.initialHead, value.commitSha,
  ], {
    env: {
      PATH: '/usr/bin:/bin', HOME: '/', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C',
    },
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  })
  if (ancestor.exitCode !== 0) {
    throw new GitHubPublicationError(
      'configuration',
      'reviewed publication commit no longer descends from its prepared base',
    )
  }
}

export function assertGitHubPublicationSet(value: GitHubPublicationSet): void {
  if (!value || value.version !== 1 || typeof value.jobId !== 'string' || !value.jobId
    || !Number.isSafeInteger(value.jobAttempt) || value.jobAttempt < 1
    || !/^[0-9a-f]{32}$/.test(value.logicalNonce)
    || !Number.isSafeInteger(value.inputRevision)
    || value.inputRevision < 1 || !/^[0-9a-f]{64}$/.test(value.inputDigest)
    || ![1, 2, 3].includes(value.reviewRound)
    || !/^[0-9a-f]{64}$/.test(value.reviewedRepositoryDigest)
    || !/^[0-9a-f]{64}$/.test(value.baselineDigest)
    || !Array.isArray(value.plans)
    || value.plans.length > MAX_GITHUB_PUBLICATION_REPOSITORIES) {
    throw new GitHubPublicationError('configuration', 'publication set is invalid')
  }
  const roots = new Set<string>()
  const repositories = new Set<string>()
  for (const plan of value.plans) {
    assertGitHubPublicationPlan(plan)
    const repository = plan.repositorySlug.toLowerCase()
    if (roots.has(plan.gitRoot) || repositories.has(repository)) {
      throw new GitHubPublicationError(
        'configuration',
        'publication plan repository identities are not unique',
      )
    }
    roots.add(plan.gitRoot)
    repositories.add(repository)
  }
}

type GhIdentity = {
  physical: string
  dev: number
  ino: number
  uid: number
  mode: number
  size: number
  mtimeMs: number
}

function resolveGhIdentity(): GhIdentity {
  const candidates = [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    ...(process.env.PATH ?? '').split(':').filter(Boolean).map(path => join(path, 'gh')),
  ]
  for (const candidate of candidates) {
    try {
      const physical = realpathSync(candidate)
      const metadata = lstatSync(physical)
      const uid = typeof process.getuid === 'function' ? process.getuid() : metadata.uid
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || (metadata.uid !== 0 && metadata.uid !== uid) || (metadata.mode & 0o022) !== 0
        || (metadata.mode & 0o111) === 0 || /[\0\r\n]/.test(physical)) continue
      return {
        physical, dev: metadata.dev, ino: metadata.ino, uid: metadata.uid,
        mode: metadata.mode, size: metadata.size, mtimeMs: metadata.mtimeMs,
      }
    } catch {}
  }
  throw new GitHubPublicationError(
    'authentication',
    'GitHub CLI is unavailable; install it and run gh auth login on this Mac',
  )
}

function verifyGhIdentity(identity: GhIdentity): void {
  const physical = realpathSync(identity.physical)
  const metadata = lstatSync(physical)
  if (physical !== identity.physical || !metadata.isFile() || metadata.isSymbolicLink()
    || metadata.nlink !== 1 || metadata.dev !== identity.dev || metadata.ino !== identity.ino
    || metadata.uid !== identity.uid || metadata.mode !== identity.mode
    || metadata.size !== identity.size || metadata.mtimeMs !== identity.mtimeMs) {
    throw new GitHubPublicationError('configuration', 'GitHub CLI changed during publication')
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void,
): Promise<{ text: string; overflow: boolean }> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let overflow = false
  try {
    while (true) {
      const value = await reader.read()
      if (value.done) break
      if (overflow) continue
      size += value.value.byteLength
      if (size > maxBytes) {
        overflow = true
        chunks.length = 0
        onOverflow()
        continue
      }
      chunks.push(value.value)
    }
  } finally {
    reader.releaseLock()
  }
  return {
    text: overflow ? '' : Buffer.concat(chunks.map(value => Buffer.from(value)), size).toString('utf8'),
    overflow,
  }
}

async function runBoundedCommand(
  argv: readonly string[],
  environment: Record<string, string>,
  stdin: string | undefined,
  signal?: AbortSignal,
  timeoutMs: number | null = COMMAND_TIMEOUT_MS,
): Promise<PublicationCommandResult> {
  if (signal?.aborted) {
    throw new GitHubPublicationError('network', 'GitHub publication was interrupted')
  }
  const proc = Bun.spawn([...argv], {
    env: environment,
    stdin: stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe', stderr: 'pipe',
    detached: process.platform !== 'win32',
  })
  let finished = false
  let cleanupFailed = false
  let stopPromise: Promise<void> | null = null
  const groupAlive = (): boolean => {
    if (process.platform === 'win32') return !finished
    try {
      process.kill(-proc.pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
  const signalGroup = (childSignal: NodeJS.Signals): void => {
    try {
      if (process.platform === 'win32') proc.kill(childSignal)
      else process.kill(-proc.pid, childSignal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupFailed = true
    }
  }
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      signalGroup('SIGTERM')
      const graceful = await Promise.race([
        proc.exited.then(() => true, () => true),
        Bun.sleep(2_000).then(() => false),
      ])
      if (!graceful || groupAlive()) signalGroup('SIGKILL')
      await Promise.race([
        proc.exited.catch(() => -1),
        Bun.sleep(2_000).then(() => -1),
      ])
      const deadline = Date.now() + 2_000
      while (groupAlive() && Date.now() < deadline) await Bun.sleep(25)
      if (groupAlive()) cleanupFailed = true
    })()
    return stopPromise
  }
  if (stdin !== undefined) {
    const input = proc.stdin
    if (!input || typeof input === 'number') {
      await stop()
      throw new GitHubPublicationError('configuration', 'GitHub command stdin is unavailable')
    }
    try {
      input.write(stdin)
      input.end()
    } catch {
      await stop()
      throw new GitHubPublicationError('network', 'GitHub command input was interrupted')
    }
  }
  let timedOut = false
  let aborted = false
  const abort = () => {
    aborted = true
    void stop()
  }
  signal?.addEventListener('abort', abort, { once: true })
  const timer = timeoutMs === null ? null : setTimeout(() => {
    timedOut = true
    void stop()
  }, timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(proc.stdout, COMMAND_OUTPUT_LIMIT, stop),
      readBoundedStream(proc.stderr, COMMAND_OUTPUT_LIMIT, stop),
      proc.exited,
    ])
    finished = true
    if (stopPromise) await stopPromise
    if (cleanupFailed) {
      throw new GitHubPublicationError(
        'cleanup',
        'GitHub command process group could not be reaped safely',
      )
    }
    if (stdout.overflow || stderr.overflow) {
      throw new GitHubPublicationError('remote', 'GitHub command output exceeded its safety limit')
    }
    if (aborted) {
      throw new GitHubPublicationError('network', 'GitHub publication was interrupted')
    }
    return { exitCode, stdout: stdout.text, stderr: stderr.text, timedOut }
  } finally {
    finished = true
    if (timer !== null) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

function shellSingleQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new GitHubPublicationError('configuration', 'GitHub CLI path is invalid')
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function createHostGitHubPublicationCommands(): GitHubPublicationCommands {
  const gh = resolveGhIdentity()
  const home = realpathSync(homedir())
  const homeMetadata = lstatSync(home)
  const uid = typeof process.getuid === 'function' ? process.getuid() : homeMetadata.uid
  if (!homeMetadata.isDirectory() || homeMetadata.isSymbolicLink() || homeMetadata.uid !== uid
    || (homeMetadata.mode & 0o022) !== 0) {
    throw new GitHubPublicationError('authentication', 'operator HOME is unsafe for GitHub authentication')
  }
  const baseEnvironment = {
    PATH: `${dirname(gh.physical)}:/usr/bin:/bin`,
    HOME: home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
  }
  return {
    async runGit(repo, args, signal) {
      verifyGhIdentity(gh)
      const needsRepository = args[0] !== 'ls-remote'
      return runBoundedCommand([
        '/usr/bin/git',
        '-c', 'core.fsmonitor=false',
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'credential.helper=',
        '-c', `credential.helper=!${shellSingleQuote(gh.physical)} auth git-credential`,
        '-c', 'protocol.ext.allow=never',
        '-c', 'protocol.file.allow=never',
        '-c', 'http.extraHeader=',
        '-c', 'http.proxy=',
        '-c', 'http.sslVerify=true',
        '-c', 'push.followTags=false',
        '-c', 'push.recurseSubmodules=no',
        '-c', 'push.pushOption=',
        '-c', 'push.gpgSign=false',
        ...(needsRepository ? ['-C', realpathSync(repo)] : []),
        ...args,
      ], baseEnvironment, undefined, signal, args[0] === 'push' ? null : COMMAND_TIMEOUT_MS)
    },
    async runGh(args, stdin, signal) {
      verifyGhIdentity(gh)
      return runBoundedCommand([gh.physical, ...args], baseEnvironment, stdin, signal)
    },
  }
}

/** Verify the operator-owned GitHub login without opening or modifying authentication. */
export async function assertHostGitHubPublicationLogin(
  commands: GitHubPublicationCommands = createHostGitHubPublicationCommands(),
): Promise<void> {
  const status = await commands.runGh([
    'auth', 'status', '--hostname', 'github.com',
  ])
  if (status.exitCode !== 0) commandFailure(status, 'GitHub login check')
}

async function assertRemoteBaseDescendsFromPreparedBase(
  plan: GitHubPublicationPlan,
  remoteBaseHead: string,
  commands: GitHubPublicationCommands,
  signal?: AbortSignal,
): Promise<void> {
  if (remoteBaseHead === plan.initialHead) return
  const response = await commands.runGh([
    'api', '--method', 'GET',
    `repos/${plan.repositorySlug}/compare/${plan.initialHead}...${remoteBaseHead}`,
  ], undefined, signal)
  if (response.exitCode !== 0) {
    throw new GitHubPublicationError(
      'conflict',
      'prepared base commit is not verifiably present on the current GitHub base branch',
    )
  }
  let parsed: unknown
  try { parsed = JSON.parse(response.stdout) } catch {
    throw new GitHubPublicationError('remote', 'GitHub base comparison returned invalid JSON')
  }
  const record = parsed as Record<string, unknown> | null
  const baseCommit = record?.base_commit as Record<string, unknown> | undefined
  const mergeBase = record?.merge_base_commit as Record<string, unknown> | undefined
  if (!record || record.status !== 'ahead' || baseCommit?.sha !== plan.initialHead
    || mergeBase?.sha !== plan.initialHead
    || !Number.isSafeInteger(record.ahead_by) || Number(record.ahead_by) < 1
    || record.behind_by !== 0) {
    throw new GitHubPublicationError(
      'conflict',
      'current GitHub base branch does not fast-forward from the prepared base commit',
    )
  }
}

function commandFailure(result: PublicationCommandResult, operation: string): never {
  const detail = `${result.stdout}\n${result.stderr}`
  if (result.timedOut || /timed out|timeout|Could not resolve host|network is unreachable|connection reset|TLS|SSL/i.test(detail)) {
    throw new GitHubPublicationError('network', `${operation} could not reach GitHub`)
  }
  if (/authentication failed|could not read Username|not logged in|HTTP 401|HTTP 403|permission denied|repository not found/i.test(detail)) {
    throw new GitHubPublicationError(
      'authentication',
      `${operation} needs a valid gh auth login with repository write access`,
    )
  }
  if (/non-fast-forward|fetch first|rejected/i.test(detail)) {
    throw new GitHubPublicationError('conflict', `${operation} found a conflicting remote branch`)
  }
  throw new GitHubPublicationError('remote', `${operation} failed without a verified receipt`)
}

function parseRemoteHead(stdout: string, branch: string): string | null {
  const lines = stdout.trim() ? stdout.trim().split(/\r?\n/) : []
  if (lines.length === 0) return null
  if (lines.length !== 1) {
    throw new GitHubPublicationError('remote', 'GitHub returned an ambiguous branch receipt')
  }
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/(.+)$/.exec(lines[0]!)
  if (!match || match[2] !== branch) {
    throw new GitHubPublicationError('remote', 'GitHub returned an invalid branch receipt')
  }
  return match[1]!
}

type PullRequestApiRecord = {
  number: number
  html_url: string
  state: 'open' | 'closed'
  merged_at: string | null
  head: { ref: string; sha: string; repo: { full_name: string } }
  base: { ref: string; repo: { full_name: string } }
}

function classifiedPullRequestRecord(
  value: unknown,
  plan: GitHubPublicationPlan,
): { kind: 'valid' | 'closed-unmerged'; record: PullRequestApiRecord } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const head = row.head as Record<string, unknown> | undefined
  const base = row.base as Record<string, unknown> | undefined
  const headRepo = head?.repo as Record<string, unknown> | undefined
  const baseRepo = base?.repo as Record<string, unknown> | undefined
  if (!Number.isSafeInteger(row.number) || Number(row.number) <= 0
    || typeof row.html_url !== 'string'
    || (row.state !== 'open' && row.state !== 'closed')
    || (row.merged_at !== null && typeof row.merged_at !== 'string')
    || head?.ref !== plan.headBranch || head?.sha !== plan.commitSha
    || base?.ref !== plan.baseBranch
    || String(headRepo?.full_name ?? '').toLowerCase() !== plan.repositorySlug.toLowerCase()
    || String(baseRepo?.full_name ?? '').toLowerCase() !== plan.repositorySlug.toLowerCase()) return null
  const expectedUrl = `https://github.com/${plan.repositorySlug}/pull/${row.number}`
  if (row.html_url.toLowerCase() !== expectedUrl.toLowerCase()) return null
  const record = row as unknown as PullRequestApiRecord
  if (record.state === 'open' || record.merged_at !== null) {
    return { kind: 'valid', record }
  }
  return { kind: 'closed-unmerged', record }
}

async function findPullRequest(
  plan: GitHubPublicationPlan,
  commands: GitHubPublicationCommands,
  signal?: AbortSignal,
): Promise<PullRequestApiRecord | null> {
  const [owner] = plan.repositorySlug.split('/')
  const query = new URLSearchParams({
    state: 'all', head: `${owner}:${plan.headBranch}`, base: plan.baseBranch, per_page: '100',
  })
  const response = await commands.runGh([
    'api', '--method', 'GET', `repos/${plan.repositorySlug}/pulls?${query.toString()}`,
  ], undefined, signal)
  if (response.exitCode !== 0) commandFailure(response, 'GitHub PR lookup')
  let parsed: unknown
  try { parsed = JSON.parse(response.stdout) } catch {
    throw new GitHubPublicationError('remote', 'GitHub PR lookup returned invalid JSON')
  }
  if (!Array.isArray(parsed)) {
    throw new GitHubPublicationError('remote', 'GitHub PR lookup returned an invalid response')
  }
  const classified = parsed.map(value => classifiedPullRequestRecord(value, plan)).filter(Boolean)
  const matches = classified.filter(value => value!.kind === 'valid').map(value => value!.record)
  if (matches.length > 1) {
    throw new GitHubPublicationError('remote', 'GitHub PR lookup returned an ambiguous receipt')
  }
  if (matches.length === 0 && classified.some(value => value!.kind === 'closed-unmerged')) {
    throw new GitHubPublicationError(
      'conflict',
      'GitHub publication PR was closed without being merged',
    )
  }
  return matches[0] ?? null
}

export async function publishGitHubPlan(
  plan: GitHubPublicationPlan,
  commands: GitHubPublicationCommands,
  signal?: AbortSignal,
): Promise<GitHubPublicationReceipt> {
  assertGitHubPublicationPlanShape(plan)
  if (signal?.aborted) {
    throw new GitHubPublicationError('network', 'GitHub publication was interrupted')
  }
  const remoteRef = `refs/heads/${plan.headBranch}`
  let remote = await commands.runGit(
    plan.gitRoot,
    ['ls-remote', '--heads', plan.canonicalUrl, remoteRef],
    signal,
  )
  if (remote.exitCode !== 0) commandFailure(remote, 'GitHub branch lookup')
  let remoteHead = parseRemoteHead(remote.stdout, plan.headBranch)
  const existing = await findPullRequest(plan, commands, signal)
  if (existing) {
    return {
      repositorySlug: plan.repositorySlug,
      baseBranch: plan.baseBranch,
      headBranch: plan.headBranch,
      commitSha: plan.commitSha,
      pullRequestNumber: existing.number,
      pullRequestUrl: existing.html_url,
    }
  }
  if (remoteHead !== null && remoteHead !== plan.commitSha) {
    throw new GitHubPublicationError('conflict', 'GitHub publication branch already has another commit')
  }
  const baseRef = `refs/heads/${plan.baseBranch}`
  const base = await commands.runGit(
    plan.gitRoot,
    ['ls-remote', '--heads', plan.canonicalUrl, baseRef],
    signal,
  )
  if (base.exitCode !== 0) commandFailure(base, 'GitHub base branch lookup')
  const remoteBaseHead = parseRemoteHead(base.stdout, plan.baseBranch)
  if (remoteBaseHead === null) {
    throw new GitHubPublicationError('conflict', 'GitHub base branch is unavailable')
  }
  await assertRemoteBaseDescendsFromPreparedBase(plan, remoteBaseHead, commands, signal)
  if (remoteHead !== plan.commitSha) {
    assertGitHubPublicationSource(plan)
    const push = await commands.runGit(plan.gitRoot, [
      'push', '--no-verify', '--porcelain', '--no-follow-tags',
      '--recurse-submodules=no', '--no-signed', plan.canonicalUrl,
      `${plan.commitSha}:${remoteRef}`,
    ], signal)
    // A lost response is reconciled below; never infer success from exit code.
    remote = await commands.runGit(
      plan.gitRoot,
      ['ls-remote', '--heads', plan.canonicalUrl, remoteRef],
      signal,
    )
    if (remote.exitCode !== 0) commandFailure(remote, 'GitHub branch verification')
    remoteHead = parseRemoteHead(remote.stdout, plan.headBranch)
    if (remoteHead !== plan.commitSha) {
      if (push.exitCode !== 0) commandFailure(push, 'GitHub non-force push')
      throw new GitHubPublicationError('remote', 'GitHub did not retain the reviewed commit')
    }
  }

  let pullRequest = await findPullRequest(plan, commands, signal)
  if (!pullRequest) {
    const request = JSON.stringify({
      title: plan.title,
      head: plan.headBranch,
      base: plan.baseBranch,
      body: 'This pull request contains the reviewed changes for an authorized project task.',
    })
    const create = await commands.runGh([
      'api', '--method', 'POST', `repos/${plan.repositorySlug}/pulls`, '--input', '-',
    ], request, signal)
    // A timeout after request bytes were sent is reconciled by the exact lookup.
    pullRequest = await findPullRequest(plan, commands, signal)
    if (!pullRequest) {
      if (create.exitCode !== 0) commandFailure(create, 'GitHub PR creation')
      throw new GitHubPublicationError('remote', 'GitHub PR creation has no verified receipt')
    }
  }
  return {
    repositorySlug: plan.repositorySlug,
    baseBranch: plan.baseBranch,
    headBranch: plan.headBranch,
    commitSha: plan.commitSha,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.html_url,
  }
}
