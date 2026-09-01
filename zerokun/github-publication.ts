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
const MAX_PULL_REQUEST_BODY_BYTES = 60_000
const MAX_CLOSE_PULL_REQUESTS = 32
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

export type GitHubPublicationBaseBinding = {
  gitRoot: string
  baseBranch: string
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
  promotion?: GitHubPublicationPromotion
}

export type GitHubPublicationPromotion = {
  version: 1
  sourceBranch: string
  sourceHead: string
  followupBaseBranch: string
  followupInitialHead: string
  waitForChecks?: boolean
  integrationPullRequestBody?: string
  followupPullRequestBody?: string
  closePullRequestNumbers?: number[]
}

export type GitHubPromotionBinding = {
  gitRoot: string
  baseBranch: string
  followupBaseBranch: string
  waitForChecks?: boolean
  integrationPullRequestBody?: string
  followupPullRequestBody?: string
  closePullRequestNumbers?: number[]
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
  followupPullRequestNumber?: number
  followupPullRequestUrl?: string
  closedPullRequestNumbers?: number[]
}

/**
 * A remotely reconciled promotion boundary. The runner persists each boundary
 * before allowing the next irreversible GitHub mutation to begin.
 */
export type GitHubPromotionCheckpoint =
  | {
      version: 1
      kind: 'source-branch'
      commitSha: string
    }
  | {
      version: 1
      kind: 'integration-pr' | 'integration-queued'
      pullRequestNumber: number
      pullRequestUrl: string
    }
  | {
      version: 1
      kind: 'integration-merged'
      pullRequestNumber: number
      pullRequestUrl: string
      mergeCommitSha: string
    }
  | {
      version: 1
      kind: 'followup-pr'
      pullRequestNumber: number
      pullRequestUrl: string
      mergeCommitSha: string
      followupPullRequestNumber: number
      followupPullRequestUrl: string
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
      | 'cleanup' | 'waiting' | 'checks',
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

function hasDelegatedPromotionDetails(promotion: GitHubPublicationPromotion): boolean {
  return promotion.waitForChecks !== undefined
    || promotion.integrationPullRequestBody !== undefined
    || promotion.followupPullRequestBody !== undefined
    || promotion.closePullRequestNumbers !== undefined
}

function assertDelegatedPromotionDetails(promotion: GitHubPublicationPromotion): void {
  if (!hasDelegatedPromotionDetails(promotion)) return
  const closeNumbers = promotion.closePullRequestNumbers
  if (typeof promotion.waitForChecks !== 'boolean'
    || typeof promotion.integrationPullRequestBody !== 'string'
    || typeof promotion.followupPullRequestBody !== 'string'
    || !Array.isArray(closeNumbers)
    || !promotion.integrationPullRequestBody.trim()
    || !promotion.followupPullRequestBody.trim()
    || Buffer.byteLength(promotion.integrationPullRequestBody) > MAX_PULL_REQUEST_BODY_BYTES
    || Buffer.byteLength(promotion.followupPullRequestBody) > MAX_PULL_REQUEST_BODY_BYTES
    || /\0/.test(promotion.integrationPullRequestBody)
    || /\0/.test(promotion.followupPullRequestBody)
    || closeNumbers.length > MAX_CLOSE_PULL_REQUESTS
    || closeNumbers.some(value => !Number.isSafeInteger(value) || value <= 0)
    || new Set(closeNumbers).size !== closeNumbers.length
    || JSON.stringify(closeNumbers) !== JSON.stringify([...closeNumbers].sort((a, b) => a - b))) {
    throw new GitHubPublicationError('configuration', 'delegated GitHub promotion details are invalid')
  }
}

function renderPullRequestBody(template: string, plan: GitHubPublicationPlan): string {
  const body = template.replaceAll('{{COMMIT_SHA}}', plan.commitSha)
  if (!body.trim() || Buffer.byteLength(body) > MAX_PULL_REQUEST_BODY_BYTES || /\0/.test(body)) {
    throw new GitHubPublicationError('configuration', 'delegated GitHub pull request body is invalid')
  }
  return body
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
  // core.hooksPath is intentionally not forbidden. Repositories commonly set
  // it for Husky, while every host Git path that could publish is forced to
  // core.hooksPath=/dev/null and push also uses --no-verify. The full local
  // config is still digested below, so a value change invalidates the plan.
  const forbidden = entries.find(({ key }) => (
    key === 'include.path' || key.startsWith('includeif.')
    || key.startsWith('credential.') || key.startsWith('http.') || key.startsWith('url.')
    || key.startsWith('protocol.') || key === 'core.sshcommand' || key === 'core.gitproxy'
    || key === 'core.alternaterefscommand'
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

/**
 * Bind implementation to the integration branches selected by Codex without
 * depending on whichever unrelated branch happens to be checked out in the
 * shared worktree. The implementation worker receives each exact base SHA and
 * creates the host-assigned feature ref from it in an isolated worktree.
 */
export function captureGitHubPublicationBaselineForBranches(
  projectPathInput: string,
  bindings: readonly GitHubPublicationBaseBinding[],
): GitHubPublicationBaseline {
  const projectPath = realpathSync(projectPathInput)
  const repositories = bindings.map(binding => {
    const state = repositoryState(binding.gitRoot)
    const baseBranch = validBranch(state.gitRoot, binding.baseBranch)
    const remoteTrackingHead = gitSync(
      state.gitRoot,
      ['rev-parse', '--verify', `refs/remotes/origin/${baseBranch}^{commit}`],
      true,
    ).trim()
    const localHead = gitSync(
      state.gitRoot,
      ['rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`],
      true,
    ).trim()
    const initialHead = remoteTrackingHead || localHead
    if (!SHA_PATTERN.test(initialHead)) {
      throw new GitHubPublicationError(
        'configuration',
        `Codex-selected publication base branch is unavailable: ${baseBranch}`,
      )
    }
    return {
      gitRoot: state.gitRoot,
      initialHead,
      baseBranch,
      statusDigest: state.statusDigest,
      localConfigDigest: state.config.digest,
      originUrlDigest: state.config.originDigest,
      remote: state.config.origin,
    }
  })
  if (new Set(repositories.map(value => value.gitRoot)).size !== repositories.length
    || repositories.length === 0
    || repositories.length > MAX_GITHUB_PUBLICATION_REPOSITORIES
    || new Set(repositories.map(value => value.remote.slug.toLowerCase())).size
      !== repositories.length) {
    throw new GitHubPublicationError(
      'configuration',
      'Codex-selected publication base bindings are invalid or not unique',
    )
  }
  return { version: 1, projectPath, repositories }
}

/**
 * Refresh the exact remote-tracking refs selected by Codex before binding an
 * implementation. The shared checkout itself is left untouched; only Git's
 * normal `refs/remotes/origin/*` metadata and fetched objects are updated.
 *
 * Without this step a long-running shared checkout can bind a replacement PR
 * to an old `origin/<base>` commit even though GitHub has already advanced the
 * branch, recreating the same conflict that the replacement was meant to fix.
 */
export async function captureFreshGitHubPublicationBaselineForBranches(
  projectPathInput: string,
  bindings: readonly GitHubPublicationBaseBinding[],
  commands: GitHubPublicationCommands = createHostGitHubPublicationCommands(),
  signal?: AbortSignal,
): Promise<GitHubPublicationBaseline> {
  for (const binding of bindings) {
    const gitRoot = realpathSync(binding.gitRoot)
    const state = repositoryState(gitRoot)
    const baseBranch = validBranch(state.gitRoot, binding.baseBranch)
    const fetched = await commands.runGit(state.gitRoot, [
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--force',
      state.config.origin.canonicalUrl,
      `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
    ], signal)
    if (fetched.exitCode !== 0) {
      commandFailure(fetched, `GitHub base branch refresh (${baseBranch})`)
    }
  }
  return captureGitHubPublicationBaselineForBranches(projectPathInput, bindings)
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
      || current.config.origin.slug.toLowerCase() !== initial.remote.slug.toLowerCase()) {
      throw new GitHubPublicationError(
        'configuration',
        'repository config or origin changed outside the reviewed commit',
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

/**
 * Bind an already-committed current checkout to an ordered branch-promotion
 * workflow. Remote target heads are read before review so later publication
 * can reject unrelated rewrites while still tolerating ordinary fast-forwards.
 */
export async function prepareGitHubPromotionPlans(
  baseline: GitHubPublicationBaseline,
  bindings: readonly GitHubPromotionBinding[],
  headBranch: string,
  commands: GitHubPublicationCommands,
  signal?: AbortSignal,
): Promise<GitHubPublicationPlan[]> {
  if (baseline.version !== 1 || realpathSync(baseline.projectPath) !== baseline.projectPath) {
    throw new GitHubPublicationError('configuration', 'publication baseline is invalid')
  }
  const requiredHeadBranch = validBranch(baseline.projectPath, headBranch)
  const byRoot = new Map(bindings.map(binding => [realpathSync(binding.gitRoot), binding]))
  if (byRoot.size !== bindings.length || bindings.length === 0
    || bindings.length > MAX_GITHUB_PUBLICATION_REPOSITORIES) {
    throw new GitHubPublicationError('configuration', 'promotion bindings are invalid')
  }
  const plans: GitHubPublicationPlan[] = []
  for (const initial of baseline.repositories) {
    const binding = byRoot.get(initial.gitRoot)
    if (!binding) continue
    const baseBranch = validBranch(initial.gitRoot, binding.baseBranch)
    const followupBaseBranch = validBranch(initial.gitRoot, binding.followupBaseBranch)
    if (baseBranch === followupBaseBranch || baseBranch === requiredHeadBranch
      || followupBaseBranch === requiredHeadBranch) {
      throw new GitHubPublicationError('configuration', 'promotion branch binding is invalid')
    }
    const current = repositoryState(initial.gitRoot)
    if (current.head !== initial.initialHead || current.branch !== initial.baseBranch
      || current.statusDigest !== initial.statusDigest
      || current.config.digest !== initial.localConfigDigest
      || current.config.originDigest !== initial.originUrlDigest
      || current.config.origin.slug.toLowerCase() !== initial.remote.slug.toLowerCase()) {
      throw new GitHubPublicationError(
        'configuration',
        'promotion source checkout changed after its read-only preparation',
      )
    }
    if (current.branch === baseBranch || current.branch === followupBaseBranch) {
      throw new GitHubPublicationError(
        'configuration',
        'promotion source and target branches must be distinct',
      )
    }
    const target = await commands.runGit(initial.gitRoot, [
      'ls-remote', '--heads', initial.remote.canonicalUrl, `refs/heads/${baseBranch}`,
    ], signal)
    if (target.exitCode !== 0) commandFailure(target, 'GitHub promotion base lookup')
    const initialTargetHead = parseRemoteHead(target.stdout, baseBranch)
    if (initialTargetHead === null) {
      throw new GitHubPublicationError('conflict', 'GitHub promotion base branch is unavailable')
    }
    const followup = await commands.runGit(initial.gitRoot, [
      'ls-remote', '--heads', initial.remote.canonicalUrl,
      `refs/heads/${followupBaseBranch}`,
    ], signal)
    if (followup.exitCode !== 0) commandFailure(followup, 'GitHub follow-up base lookup')
    const initialFollowupHead = parseRemoteHead(followup.stdout, followupBaseBranch)
    if (initialFollowupHead === null) {
      throw new GitHubPublicationError('conflict', 'GitHub follow-up base branch is unavailable')
    }
    plans.push({
      version: 1,
      gitRoot: current.gitRoot,
      repositorySlug: initial.remote.slug,
      canonicalUrl: initial.remote.canonicalUrl,
      baseBranch,
      headBranch: requiredHeadBranch,
      commitSha: current.head,
      initialHead: initialTargetHead,
      statusDigest: initial.statusDigest,
      localConfigDigest: initial.localConfigDigest,
      originUrlDigest: initial.originUrlDigest,
      title: commitTitle(current.gitRoot, current.head),
      promotion: {
        version: 1,
        sourceBranch: current.branch,
        sourceHead: current.head,
        followupBaseBranch,
        followupInitialHead: initialFollowupHead,
        ...(binding.waitForChecks !== undefined ? {
          waitForChecks: binding.waitForChecks,
          integrationPullRequestBody: binding.integrationPullRequestBody,
          followupPullRequestBody: binding.followupPullRequestBody,
          closePullRequestNumbers: binding.closePullRequestNumbers,
        } : {}),
      },
    })
  }
  if (plans.length !== bindings.length) {
    throw new GitHubPublicationError(
      'configuration',
      'promotion repository scope is not fully bound by the pre-write baseline',
    )
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
  if (value.promotion) {
    const promotion = value.promotion
    if (!promotion || typeof promotion !== 'object' || promotion.version !== 1
      || typeof promotion.sourceBranch !== 'string'
      || typeof promotion.sourceHead !== 'string'
      || typeof promotion.followupBaseBranch !== 'string'
      || typeof promotion.followupInitialHead !== 'string'
      || !SHA_PATTERN.test(promotion.sourceHead)
      || promotion.sourceHead !== value.commitSha
      || !SHA_PATTERN.test(promotion.followupInitialHead)
      || promotion.sourceBranch === value.baseBranch
      || promotion.sourceBranch === promotion.followupBaseBranch
      || promotion.followupBaseBranch === value.baseBranch
      || promotion.followupBaseBranch === value.headBranch) {
      throw new GitHubPublicationError('configuration', 'publication promotion is invalid')
    }
    assertDelegatedPromotionDetails(promotion)
    validBranch(value.gitRoot, promotion.sourceBranch)
    validBranch(value.gitRoot, promotion.followupBaseBranch)
  }
}

export function assertGitHubPromotionCheckpoint(
  plan: GitHubPublicationPlan,
  value: unknown,
): asserts value is GitHubPromotionCheckpoint {
  assertGitHubPublicationPlanShape(plan)
  if (!plan.promotion || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubPublicationError('configuration', 'promotion checkpoint is invalid')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.kind !== 'string') {
    throw new GitHubPublicationError('configuration', 'promotion checkpoint is invalid')
  }
  const integrationUrl = Number.isSafeInteger(record.pullRequestNumber)
    && Number(record.pullRequestNumber) > 0
    ? `https://github.com/${plan.repositorySlug}/pull/${record.pullRequestNumber}`
    : null
  const validIntegration = integrationUrl !== null
    && typeof record.pullRequestUrl === 'string'
    && record.pullRequestUrl.toLowerCase() === integrationUrl.toLowerCase()
  if (record.kind === 'source-branch') {
    if (Object.keys(record).sort().join('\n') !== 'commitSha\nkind\nversion'
      || record.commitSha !== plan.commitSha) {
      throw new GitHubPublicationError('configuration', 'promotion source checkpoint is invalid')
    }
    return
  }
  if (record.kind === 'integration-pr' || record.kind === 'integration-queued') {
    if (Object.keys(record).sort().join('\n')
        !== 'kind\npullRequestNumber\npullRequestUrl\nversion'
      || !validIntegration) {
      throw new GitHubPublicationError('configuration', 'promotion PR checkpoint is invalid')
    }
    return
  }
  if (record.kind === 'integration-merged') {
    if (Object.keys(record).sort().join('\n')
        !== 'kind\nmergeCommitSha\npullRequestNumber\npullRequestUrl\nversion'
      || !validIntegration || typeof record.mergeCommitSha !== 'string'
      || !SHA_PATTERN.test(record.mergeCommitSha)) {
      throw new GitHubPublicationError('configuration', 'promotion merge checkpoint is invalid')
    }
    return
  }
  if (record.kind === 'followup-pr') {
    const followupUrl = Number.isSafeInteger(record.followupPullRequestNumber)
      && Number(record.followupPullRequestNumber) > 0
      ? `https://github.com/${plan.repositorySlug}/pull/${record.followupPullRequestNumber}`
      : null
    if (Object.keys(record).sort().join('\n')
        !== 'followupPullRequestNumber\nfollowupPullRequestUrl\nkind\nmergeCommitSha\npullRequestNumber\npullRequestUrl\nversion'
      || !validIntegration || typeof record.mergeCommitSha !== 'string'
      || !SHA_PATTERN.test(record.mergeCommitSha) || followupUrl === null
      || typeof record.followupPullRequestUrl !== 'string'
      || record.followupPullRequestUrl.toLowerCase() !== followupUrl.toLowerCase()) {
      throw new GitHubPublicationError('configuration', 'promotion follow-up checkpoint is invalid')
    }
    return
  }
  throw new GitHubPublicationError('configuration', 'promotion checkpoint kind is invalid')
}

export function assertGitHubPublicationPlan(value: GitHubPublicationPlan): void {
  assertGitHubPublicationPlanShape(value)
  const state = repositoryState(value.gitRoot)
  const implementedPromotion = value.promotion?.sourceBranch === value.headBranch
  if (value.promotion && !implementedPromotion) {
    if (state.head !== value.promotion.sourceHead
      || state.branch !== value.promotion.sourceBranch
      || state.statusDigest !== value.statusDigest
      || state.config.digest !== value.localConfigDigest
      || state.config.originDigest !== value.originUrlDigest
      || state.config.origin.slug.toLowerCase() !== value.repositorySlug.toLowerCase()) {
      throw new GitHubPublicationError(
        'configuration',
        'publication promotion no longer matches the reviewed source checkout',
      )
    }
    return
  }
  const featureHead = gitSync(
    state.gitRoot,
    ['rev-parse', '--verify', `refs/heads/${value.headBranch}^{commit}`],
    true,
  ).trim()
  if (featureHead !== value.commitSha
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
  if (value.promotion && value.promotion.sourceBranch !== value.headBranch) return
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
  if (response.exitCode !== 0) commandFailure(response, 'GitHub base comparison')
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
  merge_commit_sha?: string | null
  body?: string | null
  head: { ref: string; sha: string; repo: { full_name: string } }
  base: { ref: string; repo: { full_name: string } }
}

async function readExactPullRequest(
  plan: GitHubPublicationPlan,
  pullRequestNumber: number,
  commands: GitHubPublicationCommands,
  signal?: AbortSignal,
): Promise<{ record: PullRequestApiRecord; detail: Record<string, unknown> }> {
  const response = await commands.runGh([
    'api', '--method', 'GET',
    `repos/${plan.repositorySlug}/pulls/${pullRequestNumber}`,
  ], undefined, signal)
  if (response.exitCode !== 0) commandFailure(response, 'GitHub PR lookup')
  let parsed: unknown
  try { parsed = JSON.parse(response.stdout) } catch {
    throw new GitHubPublicationError('remote', 'GitHub PR lookup returned invalid JSON')
  }
  const classified = classifiedPullRequestRecord(parsed, plan)
  if (!classified || classified.record.number !== pullRequestNumber
    || classified.kind !== 'valid') {
    throw new GitHubPublicationError('remote', 'GitHub PR receipt is invalid')
  }
  return { record: classified.record, detail: parsed as Record<string, unknown> }
}

async function reconcilePullRequestBody(
  plan: GitHubPublicationPlan,
  pullRequest: PullRequestApiRecord,
  bodyTemplate: string | undefined,
  commands: GitHubPublicationCommands,
  signal?: AbortSignal,
): Promise<PullRequestApiRecord> {
  if (bodyTemplate === undefined) return pullRequest
  const expectedBody = renderPullRequestBody(bodyTemplate, plan)
  if (pullRequest.body === expectedBody) return pullRequest
  const update = await commands.runGh([
    'api', '--method', 'PATCH',
    `repos/${plan.repositorySlug}/pulls/${pullRequest.number}`, '--input', '-',
  ], JSON.stringify({ body: expectedBody }), signal)
  const verified = await readExactPullRequest(plan, pullRequest.number, commands, signal)
  if (verified.record.body !== expectedBody) {
    if (update.exitCode !== 0) commandFailure(update, 'GitHub PR body update')
    throw new GitHubPublicationError('remote', 'GitHub did not retain the Codex-selected PR body')
  }
  return verified.record
}

async function assertPullRequestChecksReady(
  plan: GitHubPublicationPlan,
  commands: GitHubPublicationCommands,
  signal?: AbortSignal,
): Promise<void> {
  if (plan.promotion?.waitForChecks !== true) return
  const checksResponse = await commands.runGh([
    'api', '--method', 'GET',
    `repos/${plan.repositorySlug}/commits/${plan.commitSha}/check-runs?filter=latest&per_page=100`,
  ], undefined, signal)
  if (checksResponse.exitCode !== 0) commandFailure(checksResponse, 'GitHub check-runs lookup')
  const statusResponse = await commands.runGh([
    'api', '--method', 'GET',
    `repos/${plan.repositorySlug}/commits/${plan.commitSha}/status?per_page=100`,
  ], undefined, signal)
  if (statusResponse.exitCode !== 0) commandFailure(statusResponse, 'GitHub commit-status lookup')
  let checksValue: unknown
  let statusValue: unknown
  try {
    checksValue = JSON.parse(checksResponse.stdout)
    statusValue = JSON.parse(statusResponse.stdout)
  } catch {
    throw new GitHubPublicationError('remote', 'GitHub checks returned invalid JSON')
  }
  const checksRecord = checksValue as Record<string, unknown> | null
  const statusRecord = statusValue as Record<string, unknown> | null
  if (!checksRecord || !Number.isSafeInteger(checksRecord.total_count)
    || !Array.isArray(checksRecord.check_runs) || Number(checksRecord.total_count) < 0
    || Number(checksRecord.total_count) !== checksRecord.check_runs.length
    || !statusRecord || !Array.isArray(statusRecord.statuses)) {
    throw new GitHubPublicationError('remote', 'GitHub checks receipt is incomplete')
  }
  const pending: string[] = []
  const failed: string[] = []
  for (const [index, value] of checksRecord.check_runs.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new GitHubPublicationError('remote', 'GitHub check-run receipt is invalid')
    }
    const check = value as Record<string, unknown>
    const name = typeof check.name === 'string' && check.name ? check.name : `check-${index + 1}`
    if (check.status !== 'completed') {
      pending.push(name)
    } else if (!['success', 'neutral', 'skipped'].includes(String(check.conclusion))) {
      failed.push(name)
    }
  }
  const latestStatuses = new Map<string, string>()
  for (const [index, value] of statusRecord.statuses.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new GitHubPublicationError('remote', 'GitHub commit-status receipt is invalid')
    }
    const status = value as Record<string, unknown>
    const context = typeof status.context === 'string' && status.context
      ? status.context : `status-${index + 1}`
    if (!latestStatuses.has(context)) latestStatuses.set(context, String(status.state))
  }
  for (const [context, state] of latestStatuses) {
    if (state === 'pending') pending.push(context)
    else if (state !== 'success') failed.push(context)
  }
  if (failed.length > 0) {
    throw new GitHubPublicationError(
      'checks',
      `Codex-selected GitHub checks failed: ${failed.slice(0, 10).join(', ')}`,
    )
  }
  if (pending.length > 0 || (checksRecord.check_runs.length === 0 && latestStatuses.size === 0)) {
    throw new GitHubPublicationError(
      'waiting',
      pending.length > 0
        ? `Codex-selected GitHub checks are still running: ${pending.slice(0, 10).join(', ')}`
        : 'Codex-selected GitHub checks have not started yet',
    )
  }
}

async function readPullRequestForMerge(
  plan: GitHubPublicationPlan,
  pullRequestNumber: number,
  commands: GitHubPublicationCommands,
  signal?: AbortSignal,
): Promise<PullRequestApiRecord> {
  const { record, detail } = await readExactPullRequest(
    plan, pullRequestNumber, commands, signal,
  )
  if (record.merged_at !== null) return record
  await assertPullRequestChecksReady(plan, commands, signal)
  if (detail.mergeable_state === 'dirty') {
    throw new GitHubPublicationError(
      'conflict',
      'GitHub integration PR has a merge conflict that requires a new reviewed commit',
    )
  }
  if (detail.draft !== false || detail.mergeable !== true
    || detail.mergeable_state !== 'clean') {
    throw new GitHubPublicationError(
      'waiting',
      'GitHub integration PR is waiting for required checks and review protections',
    )
  }
  return record
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

type RepositoryPullRequestRecord = {
  number: number
  html_url: string
  state: 'open' | 'closed'
  merged_at: string | null
  head: { repo: { full_name: string } }
  base: { repo: { full_name: string } }
}

async function readRepositoryPullRequest(
  plan: GitHubPublicationPlan,
  pullRequestNumber: number,
  commands: GitHubPublicationCommands,
  signal?: AbortSignal,
): Promise<RepositoryPullRequestRecord> {
  const response = await commands.runGh([
    'api', '--method', 'GET',
    `repos/${plan.repositorySlug}/pulls/${pullRequestNumber}`,
  ], undefined, signal)
  if (response.exitCode !== 0) commandFailure(response, 'GitHub obsolete PR lookup')
  let value: unknown
  try { value = JSON.parse(response.stdout) } catch {
    throw new GitHubPublicationError('remote', 'GitHub obsolete PR lookup returned invalid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubPublicationError('remote', 'GitHub obsolete PR receipt is invalid')
  }
  const row = value as Record<string, unknown>
  const head = row.head as Record<string, unknown> | undefined
  const base = row.base as Record<string, unknown> | undefined
  const headRepo = head?.repo as Record<string, unknown> | undefined
  const baseRepo = base?.repo as Record<string, unknown> | undefined
  const expectedUrl = `https://github.com/${plan.repositorySlug}/pull/${pullRequestNumber}`
  if (row.number !== pullRequestNumber || row.html_url !== expectedUrl
    || (row.state !== 'open' && row.state !== 'closed')
    || (row.merged_at !== null && typeof row.merged_at !== 'string')
    || String(headRepo?.full_name ?? '').toLowerCase() !== plan.repositorySlug.toLowerCase()
    || String(baseRepo?.full_name ?? '').toLowerCase() !== plan.repositorySlug.toLowerCase()) {
    throw new GitHubPublicationError('remote', 'GitHub obsolete PR receipt is invalid')
  }
  return row as unknown as RepositoryPullRequestRecord
}

async function closeCodexSelectedPullRequests(
  plan: GitHubPublicationPlan,
  integrationPullRequestNumber: number,
  commands: GitHubPublicationCommands,
  signal?: AbortSignal,
): Promise<number[]> {
  const numbers = plan.promotion?.closePullRequestNumbers ?? []
  if (numbers.includes(integrationPullRequestNumber)) {
    throw new GitHubPublicationError(
      'configuration',
      'Codex selected the active integration PR as obsolete',
    )
  }
  const closed: number[] = []
  for (const number of numbers) {
    let pullRequest = await readRepositoryPullRequest(plan, number, commands, signal)
    if (pullRequest.merged_at !== null) {
      throw new GitHubPublicationError(
        'conflict',
        `Codex-selected obsolete PR #${number} is already merged`,
      )
    }
    if (pullRequest.state === 'open') {
      const update = await commands.runGh([
        'api', '--method', 'PATCH',
        `repos/${plan.repositorySlug}/pulls/${number}`, '--input', '-',
      ], JSON.stringify({ state: 'closed' }), signal)
      pullRequest = await readRepositoryPullRequest(plan, number, commands, signal)
      if (pullRequest.state !== 'closed' || pullRequest.merged_at !== null) {
        if (update.exitCode !== 0) commandFailure(update, 'GitHub obsolete PR closure')
        throw new GitHubPublicationError('remote', `GitHub did not close obsolete PR #${number}`)
      }
    }
    closed.push(number)
  }
  return closed
}

export async function publishGitHubPlan(
  plan: GitHubPublicationPlan,
  commands: GitHubPublicationCommands,
  signal?: AbortSignal,
  onPromotionCheckpoint?: (
    checkpoint: GitHubPromotionCheckpoint,
  ) => Promise<void> | void,
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
  let existing = await findPullRequest(plan, commands, signal)
  if (existing && !plan.promotion) {
    return {
      repositorySlug: plan.repositorySlug,
      baseBranch: plan.baseBranch,
      headBranch: plan.headBranch,
      commitSha: plan.commitSha,
      pullRequestNumber: existing.number,
      pullRequestUrl: existing.html_url,
    }
  }
  if (!existing && remoteHead !== null && remoteHead !== plan.commitSha) {
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
  if (!existing && remoteHead !== plan.commitSha) {
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
  if (plan.promotion && remoteHead === plan.commitSha) {
    await onPromotionCheckpoint?.({
      version: 1,
      kind: 'source-branch',
      commitSha: plan.commitSha,
    })
  }

  let pullRequest = existing ?? await findPullRequest(plan, commands, signal)
  if (!pullRequest) {
    const integrationBody = plan.promotion?.integrationPullRequestBody === undefined
      ? 'This pull request contains the reviewed changes for an authorized project task.'
      : renderPullRequestBody(plan.promotion.integrationPullRequestBody, plan)
    const request = JSON.stringify({
      title: plan.title,
      head: plan.headBranch,
      base: plan.baseBranch,
      body: integrationBody,
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
  if (plan.promotion) {
    pullRequest = await reconcilePullRequestBody(
      plan,
      pullRequest,
      plan.promotion.integrationPullRequestBody,
      commands,
      signal,
    )
    await onPromotionCheckpoint?.({
      version: 1,
      kind: 'integration-pr',
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.html_url,
    })
    if (pullRequest.merged_at === null) {
      pullRequest = await readPullRequestForMerge(
        plan,
        pullRequest.number,
        commands,
        signal,
      )
    }
    // Codex may nominate obsolete PRs, but the host closes them only after the
    // exact replacement is already merged or has passed checks and is clean.
    // A conflicting or failing replacement must not remove the last usable PR.
    const closedPullRequestNumbers = await closeCodexSelectedPullRequests(
      plan,
      pullRequest.number,
      commands,
      signal,
    )
    if (pullRequest.merged_at === null) {
      const repository = await commands.runGh([
        'api', '--method', 'GET', `repos/${plan.repositorySlug}`,
      ], undefined, signal)
      if (repository.exitCode !== 0) commandFailure(repository, 'GitHub merge policy lookup')
      let repositoryPolicy: unknown
      try { repositoryPolicy = JSON.parse(repository.stdout) } catch {
        throw new GitHubPublicationError('remote', 'GitHub merge policy returned invalid JSON')
      }
      const policy = repositoryPolicy as Record<string, unknown> | null
      // Preserve the reviewed commit graph when the repository permits it.
      // Squash/rebase are bounded fallbacks for repositories that explicitly
      // disable merge commits.
      const mergeMethod = policy?.allow_merge_commit === true
        ? 'merge'
        : policy?.allow_squash_merge === true
          ? 'squash'
          : policy?.allow_rebase_merge === true
            ? 'rebase'
            : null
      if (!mergeMethod) {
        throw new GitHubPublicationError('conflict', 'GitHub repository has no allowed PR merge method')
      }
      const merge = await commands.runGh([
        'api', '--method', 'PUT',
        `repos/${plan.repositorySlug}/pulls/${pullRequest.number}/merge`, '--input', '-',
      ], JSON.stringify({ sha: plan.commitSha, merge_method: mergeMethod }), signal)
      const mergeDetail = `${merge.stdout}\n${merge.stderr}`
      if (merge.exitCode !== 0 && /merge queue|queue is required|required.*queue/i.test(mergeDetail)) {
        const queued = await commands.runGh([
          'pr', 'merge', String(pullRequest.number), '--repo', plan.repositorySlug,
          '--auto', `--${mergeMethod}`, '--match-head-commit', plan.commitSha,
        ], undefined, signal)
        if (queued.exitCode !== 0
          && !/already.*(?:auto|queue)|auto-merge is enabled|already in.*queue/i.test(
            `${queued.stdout}\n${queued.stderr}`,
          )) {
          commandFailure(queued, 'GitHub merge queue enrollment')
        }
      }
      // The response may be lost after GitHub accepted the merge. Re-query the
      // exact PR before classifying the operation or retrying it.
      pullRequest = await findPullRequest(plan, commands, signal) ?? pullRequest
      if (pullRequest.merged_at === null) {
        if (merge.exitCode !== 0 && /merge queue|queue is required|required.*queue/i.test(mergeDetail)) {
          await onPromotionCheckpoint?.({
            version: 1,
            kind: 'integration-queued',
            pullRequestNumber: pullRequest.number,
            pullRequestUrl: pullRequest.html_url,
          })
          throw new GitHubPublicationError(
            'waiting',
            'GitHub integration PR is enrolled in the required merge queue',
          )
        }
        if (merge.exitCode !== 0) commandFailure(merge, 'GitHub PR merge')
        throw new GitHubPublicationError('remote', 'GitHub PR merge has no verified receipt')
      }
    }
    const integrationMergeHead = pullRequest.merge_commit_sha
    if (typeof integrationMergeHead !== 'string' || !SHA_PATTERN.test(integrationMergeHead)) {
      throw new GitHubPublicationError(
        'remote',
        'GitHub merged PR omitted its exact integration commit receipt',
      )
    }

    const promoted = await commands.runGit(
      plan.gitRoot,
      ['ls-remote', '--heads', plan.canonicalUrl, `refs/heads/${plan.baseBranch}`],
      signal,
    )
    if (promoted.exitCode !== 0) commandFailure(promoted, 'GitHub promoted branch lookup')
    const promotedHead = parseRemoteHead(promoted.stdout, plan.baseBranch)
    if (promotedHead === null) {
      throw new GitHubPublicationError('remote', 'GitHub promoted branch receipt is unavailable')
    }
    if (promotedHead !== integrationMergeHead) {
      await assertRemoteBaseDescendsFromPreparedBase({
        ...plan,
        initialHead: integrationMergeHead,
      }, promotedHead, commands, signal)
    }
    await assertRemoteBaseDescendsFromPreparedBase(plan, promotedHead, commands, signal)
    await onPromotionCheckpoint?.({
      version: 1,
      kind: 'integration-merged',
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.html_url,
      mergeCommitSha: integrationMergeHead,
    })
    const followupPlan: GitHubPublicationPlan = {
      ...plan,
      baseBranch: plan.promotion.followupBaseBranch,
      headBranch: plan.baseBranch,
      commitSha: promotedHead,
      initialHead: plan.promotion.followupInitialHead,
      title: `release: ${plan.baseBranch} to ${plan.promotion.followupBaseBranch}`,
      promotion: undefined,
    }
    const followupBase = await commands.runGit(
      plan.gitRoot,
      ['ls-remote', '--heads', plan.canonicalUrl,
        `refs/heads/${plan.promotion.followupBaseBranch}`],
      signal,
    )
    if (followupBase.exitCode !== 0) commandFailure(followupBase, 'GitHub follow-up base lookup')
    const followupBaseHead = parseRemoteHead(
      followupBase.stdout,
      plan.promotion.followupBaseBranch,
    )
    if (followupBaseHead === null) {
      throw new GitHubPublicationError('conflict', 'GitHub follow-up base branch is unavailable')
    }
    await assertRemoteBaseDescendsFromPreparedBase(
      followupPlan,
      followupBaseHead,
      commands,
      signal,
    )
    let followupPullRequest = await findPullRequest(followupPlan, commands, signal)
    if (!followupPullRequest) {
      const followupBody = plan.promotion.followupPullRequestBody === undefined
        ? 'The authorized integration branch is ready for release review. This PR is not auto-merged.'
        : renderPullRequestBody(plan.promotion.followupPullRequestBody, followupPlan)
      const create = await commands.runGh([
        'api', '--method', 'POST', `repos/${plan.repositorySlug}/pulls`, '--input', '-',
      ], JSON.stringify({
        title: followupPlan.title,
        head: followupPlan.headBranch,
        base: followupPlan.baseBranch,
        body: followupBody,
      }), signal)
      followupPullRequest = await findPullRequest(followupPlan, commands, signal)
      if (!followupPullRequest) {
        if (create.exitCode !== 0) commandFailure(create, 'GitHub follow-up PR creation')
        throw new GitHubPublicationError(
          'remote',
          'GitHub follow-up PR creation has no verified receipt',
        )
      }
    }
    followupPullRequest = await reconcilePullRequestBody(
      followupPlan,
      followupPullRequest,
      plan.promotion.followupPullRequestBody,
      commands,
      signal,
    )
    await onPromotionCheckpoint?.({
      version: 1,
      kind: 'followup-pr',
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.html_url,
      mergeCommitSha: integrationMergeHead,
      followupPullRequestNumber: followupPullRequest.number,
      followupPullRequestUrl: followupPullRequest.html_url,
    })
    return {
      repositorySlug: plan.repositorySlug,
      baseBranch: plan.baseBranch,
      headBranch: plan.headBranch,
      commitSha: plan.commitSha,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.html_url,
      followupPullRequestNumber: followupPullRequest.number,
      followupPullRequestUrl: followupPullRequest.html_url,
      ...(closedPullRequestNumbers.length > 0 ? { closedPullRequestNumbers } : {}),
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
