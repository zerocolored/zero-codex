#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { resolveAdvisorProjectLayout } from './advisor-snapshot.ts'
import {
  createHostGitHubPublicationCommands,
  githubRepositoryIdentity,
  type GitHubPublicationCommands,
  type GitHubRepositoryIdentity,
  type PublicationCommandResult,
} from './github-publication.ts'
import { requireManagedStateRoot } from './managed-path.ts'
import { containsCredentialMaterial } from './public-output-guard.ts'

const MAX_CONTEXT_BYTES = 256 * 1024
const MAX_JSON_BYTES = 2 * 1024 * 1024
const SHA = /^[0-9a-f]{40}$/
const MAX_WAIT_SECONDS = 30 * 60
const LOCAL_GIT_TIMEOUT_MS = 10_000

type GitHubBrokerContext = {
  version: 4
  jobId: string
  attemptNonce: string
  repoPath: string
  gitRoots: string[]
  writeEnabled: boolean
}

type BoundRepository = {
  root: string
  remote: GitHubRepositoryIdentity
}

type PullRequestView = {
  number: number
  url: string
  state: string
  isDraft: boolean
  baseBranch: string
  headBranch: string
  headSha: string
  mergeSha: string | null
  autoMergeEnabled: boolean
  checks: Array<{
    name: string
    status: string
    conclusion: string | null
    url: string | null
  }>
}

type GitHubRun = {
  id: number | null
  name: string
  status: string
  conclusion: string | null
  url: string | null
  headSha: string
}

type GitHubCheck = {
  id: number | null
  name: string
  status: string
  conclusion: string | null
  url: string | null
}

type GitHubStatus = {
  context: string
  state: string
  url: string | null
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function readBoundedPrivateFile(path: string, maximum: number): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(descriptor)
    const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.nlink !== 1 || !owned
      || (metadata.mode & 0o077) !== 0 || metadata.size > maximum) {
      throw new Error('unsafe GitHub broker context')
    }
    const bytes = Buffer.alloc(metadata.size)
    if (bytes.length > 0) readSync(descriptor, bytes, 0, bytes.length, 0)
    return bytes.toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

export function parseGitHubBrokerContext(
  pathInput: string,
  stateDirInput: string,
): GitHubBrokerContext {
  const stateDir = requireManagedStateRoot(stateDirInput)
  if (!isAbsolute(pathInput)) throw new Error('GitHub broker context path must be absolute')
  const path = resolve(pathInput)
  if (!contained(stateDir, path)) throw new Error('GitHub broker context is outside managed state')
  let value: unknown
  try { value = JSON.parse(readBoundedPrivateFile(path, MAX_CONTEXT_BYTES)) } catch {
    throw new Error('GitHub broker context is invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GitHub broker context must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 4 || typeof record.jobId !== 'string' || !record.jobId
    || typeof record.attemptNonce !== 'string' || !/^[0-9a-f]{32}$/.test(record.attemptNonce)
    || typeof record.repoPath !== 'string' || !isAbsolute(record.repoPath)
    || !Array.isArray(record.gitRoots)
    || record.gitRoots.some(root => typeof root !== 'string' || !isAbsolute(root))
    || typeof record.writeEnabled !== 'boolean') {
    throw new Error('GitHub broker context fields are invalid')
  }
  const layout = resolveAdvisorProjectLayout(record.repoPath)
  if (JSON.stringify(layout.gitRoots) !== JSON.stringify(record.gitRoots)) {
    throw new Error('GitHub broker repository layout changed')
  }
  return {
    version: 4,
    jobId: record.jobId,
    attemptNonce: record.attemptNonce,
    repoPath: realpathSync(record.repoPath),
    gitRoots: layout.gitRoots,
    writeEnabled: record.writeEnabled,
  }
}

function repositorySelector(context: GitHubBrokerContext): (repository: string) => BoundRepository {
  const resolved = new Map<string, BoundRepository>()
  return (repository: string): BoundRepository => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error('GitHub repository must be owner/name')
    }
    let selected = resolved.get(repository)
    if (!selected) {
      for (const root of context.gitRoots) {
        try {
          const physical = realpathSync(root)
          const remote = githubRepositoryIdentity(physical)
          if (remote.slug !== repository) continue
          if (selected) throw new Error('duplicate GitHub repository binding')
          selected = { root: physical, remote }
        } catch (error) {
          if (error instanceof Error && error.message === 'duplicate GitHub repository binding') {
            throw error
          }
          // One unrelated workspace member without a usable GitHub remote must
          // not block the repository Codex actually selected.
        }
      }
      if (!selected) throw new Error('GitHub repository is outside this job')
      resolved.set(repository, selected)
    }
    const current = githubRepositoryIdentity(selected.root)
    if (JSON.stringify(current) !== JSON.stringify(selected.remote)) {
      throw new Error('GitHub repository origin changed')
    }
    return selected
  }
}

function validSha(value: string): string {
  if (!SHA.test(value)) throw new Error('GitHub commit SHA is invalid')
  return value
}

function validBranch(value: string): string {
  if (!value || value.length > 255 || /[\0\r\n]/.test(value)) {
    throw new Error('GitHub branch is invalid')
  }
  const checked = Bun.spawnSync(['/usr/bin/git', 'check-ref-format', '--branch', value], {
    env: { PATH: '/usr/bin:/bin', HOME: '/', LC_ALL: 'C' },
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    timeout: LOCAL_GIT_TIMEOUT_MS,
  })
  if (checked.exitCode !== 0) throw new Error('GitHub branch is invalid')
  return value
}

function commandFailure(result: PublicationCommandResult, action: string): never {
  const suffix = result.timedOut ? ' (timeout)' : ''
  throw new Error(`${action} failed with exit ${result.exitCode}${suffix}`)
}

function parseJson(value: string, label: string): unknown {
  if (Buffer.byteLength(value) > MAX_JSON_BYTES) throw new Error(`${label} response is too large`)
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error(`${label} returned invalid JSON`) }
  return parsed
}

function cleanText(value: unknown, maximum = 256): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, maximum)
  return containsCredentialMaterial(text) ? '' : text
}

function githubUrl(value: unknown): string | null {
  const text = cleanText(value, 2_048)
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com'
      || url.username || url.password || url.hash) return null
    return url.href
  } catch { return null }
}

function pullRequestView(value: unknown): PullRequestView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GitHub pull request response is invalid')
  }
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.number) || Number(record.number) < 1) {
    throw new Error('GitHub pull request number is invalid')
  }
  const url = githubUrl(record.url)
  const headSha = cleanText(record.headRefOid, 64)
  if (!url || !SHA.test(headSha)) throw new Error('GitHub pull request binding is invalid')
  const checks = Array.isArray(record.statusCheckRollup)
    ? record.statusCheckRollup.slice(0, 256).flatMap(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
        const check = raw as Record<string, unknown>
        const name = cleanText(check.name ?? check.context ?? check.workflowName)
        if (!name) return []
        const status = cleanText(check.status ?? check.state, 64)
        const conclusion = cleanText(check.conclusion, 64) || null
        return [{ name, status, conclusion, url: githubUrl(check.detailsUrl) }]
      })
    : []
  const mergeCommit = record.mergeCommit
  const mergeSha = mergeCommit && typeof mergeCommit === 'object' && !Array.isArray(mergeCommit)
    ? cleanText((mergeCommit as Record<string, unknown>).oid, 64) || null
    : null
  return {
    number: Number(record.number),
    url,
    state: cleanText(record.state, 64),
    isDraft: record.isDraft === true,
    baseBranch: cleanText(record.baseRefName),
    headBranch: cleanText(record.headRefName),
    headSha,
    mergeSha: mergeSha && SHA.test(mergeSha) ? mergeSha : null,
    autoMergeEnabled: record.autoMergeRequest !== null
      && record.autoMergeRequest !== undefined,
    checks,
  }
}

async function readPullRequest(
  commands: GitHubPublicationCommands,
  repository: string,
  number: number,
  signal?: AbortSignal,
): Promise<PullRequestView> {
  const response = await commands.runGh([
    'pr', 'view', String(number), '--repo', repository,
    '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeCommit,autoMergeRequest,statusCheckRollup',
  ], undefined, signal)
  if (response.exitCode !== 0) commandFailure(response, 'GitHub pull request inspection')
  return pullRequestView(parseJson(response.stdout, 'GitHub pull request inspection'))
}

async function listPullRequests(
  commands: GitHubPublicationCommands,
  repository: string,
  base: string,
  head: string,
  expectedHeadSha: string,
  signal?: AbortSignal,
): Promise<PullRequestView[]> {
  const response = await commands.runGh([
    'pr', 'list', '--repo', repository, '--state', 'all',
    '--base', base, '--head', head, '--limit', '100',
    '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeCommit,autoMergeRequest,statusCheckRollup',
  ], undefined, signal)
  if (response.exitCode !== 0) commandFailure(response, 'GitHub pull request lookup')
  const parsed = parseJson(response.stdout, 'GitHub pull request lookup')
  return Array.isArray(parsed)
    ? parsed.map(pullRequestView).filter(view => (
        view.headSha === expectedHeadSha && view.state !== 'CLOSED'
      ))
    : []
}

async function readRemoteBranch(
  commands: GitHubPublicationCommands,
  selected: BoundRepository,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const ref = `refs/heads/${validBranch(branch)}`
  const remote = await commands.runGit(selected.root, [
    'ls-remote', selected.remote.canonicalUrl, ref,
  ], signal)
  if (remote.exitCode !== 0) commandFailure(remote, 'GitHub remote branch inspection')
  const line = remote.stdout.trim()
  if (!line) return null
  const [remoteSha, remoteRef, ...extra] = line.split(/\s+/)
  if (extra.length || remoteRef !== ref || !remoteSha || !SHA.test(remoteSha)) {
    throw new Error('GitHub remote branch response is invalid')
  }
  return remoteSha
}

async function approvalExists(
  commands: GitHubPublicationCommands,
  repository: string,
  pullRequestNumber: number,
  commitSha: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const actor = await commands.runGh([
    'api', '--method', 'GET', 'user', '--jq', '.login',
  ], undefined, signal)
  if (actor.exitCode !== 0) commandFailure(actor, 'GitHub actor inspection')
  const login = actor.stdout.trim()
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    throw new Error('GitHub actor response is invalid')
  }
  const reviews = await commands.runGh([
    'api', '--method', 'GET',
    `repos/${repository}/pulls/${pullRequestNumber}/reviews?per_page=100`,
    '--jq', '[.[] | {login: .user.login, state: .state, commitId: .commit_id}]',
  ], undefined, signal)
  if (reviews.exitCode !== 0) commandFailure(reviews, 'GitHub pull request review lookup')
  const parsed = parseJson(reviews.stdout, 'GitHub pull request review lookup')
  if (!Array.isArray(parsed)) throw new Error('GitHub pull request review response is invalid')
  return parsed.some(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const review = value as Record<string, unknown>
    return review.login === login && review.state === 'APPROVED'
      && review.commitId === commitSha
  })
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return Bun.sleep(milliseconds)
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('GitHub operation aborted'))
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolvePromise()
    }, milliseconds)
    const aborted = () => {
      clearTimeout(timer)
      rejectPromise(signal.reason ?? new Error('GitHub operation aborted'))
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}

async function readGitHubSignals(
  commands: GitHubPublicationCommands,
  repository: string,
  commitSha: string,
  signal?: AbortSignal,
): Promise<{ runs: GitHubRun[], checks: GitHubCheck[], statuses: GitHubStatus[] }> {
  const runsResponse = await commands.runGh([
    'run', 'list', '--repo', repository, '--commit', commitSha, '--limit', '100',
    '--json', 'databaseId,name,workflowName,status,conclusion,url,headSha,event',
  ], undefined, signal)
  if (runsResponse.exitCode !== 0) commandFailure(runsResponse, 'GitHub workflow inspection')
  const rawRuns = parseJson(runsResponse.stdout, 'GitHub workflow inspection')
  const runs: GitHubRun[] = Array.isArray(rawRuns) ? rawRuns.slice(0, 100).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const run = item as Record<string, unknown>
    if (cleanText(run.headSha, 64) !== commitSha) return []
    return [{
      id: Number.isSafeInteger(run.databaseId) ? Number(run.databaseId) : null,
      name: cleanText(run.name ?? run.workflowName),
      status: cleanText(run.status, 64),
      conclusion: cleanText(run.conclusion, 64) || null,
      url: githubUrl(run.url),
      headSha: commitSha,
    }]
  }) : []

  const checksResponse = await commands.runGh([
    'api', '--method', 'GET',
    `repos/${repository}/commits/${commitSha}/check-runs?filter=latest&per_page=100`,
    '--jq', '{totalCount: .total_count, checks: [.check_runs[] | {id: .id, name: .name, status: .status, conclusion: .conclusion, url: .details_url}]}',
  ], undefined, signal)
  if (checksResponse.exitCode !== 0) commandFailure(checksResponse, 'GitHub check-runs inspection')
  const rawChecks = parseJson(checksResponse.stdout, 'GitHub check-runs inspection')
  if (!rawChecks || typeof rawChecks !== 'object' || Array.isArray(rawChecks)) {
    throw new Error('GitHub check-runs response is invalid')
  }
  const checksRecord = rawChecks as Record<string, unknown>
  if (!Number.isSafeInteger(checksRecord.totalCount) || Number(checksRecord.totalCount) < 0
    || !Array.isArray(checksRecord.checks)
    || Number(checksRecord.totalCount) !== checksRecord.checks.length) {
    throw new Error('GitHub check-runs response is incomplete')
  }
  const checks: GitHubCheck[] = checksRecord.checks.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('GitHub check-run response is invalid')
    }
    const check = item as Record<string, unknown>
    return {
      id: Number.isSafeInteger(check.id) ? Number(check.id) : null,
      name: cleanText(check.name) || `check-${index + 1}`,
      status: cleanText(check.status, 64),
      conclusion: cleanText(check.conclusion, 64) || null,
      url: githubUrl(check.url),
    }
  })

  const statusesResponse = await commands.runGh([
    'api', '--method', 'GET',
    `repos/${repository}/commits/${commitSha}/status?per_page=100`,
    '--jq', '[.statuses[] | {context: .context, state: .state, url: .target_url}]',
  ], undefined, signal)
  if (statusesResponse.exitCode !== 0) commandFailure(statusesResponse, 'GitHub commit-status inspection')
  const rawStatuses = parseJson(statusesResponse.stdout, 'GitHub commit-status inspection')
  if (!Array.isArray(rawStatuses)) throw new Error('GitHub commit-status response is invalid')
  const latestStatuses = new Map<string, GitHubStatus>()
  rawStatuses.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('GitHub commit-status response is invalid')
    }
    const status = item as Record<string, unknown>
    const value = {
      context: cleanText(status.context) || `status-${index + 1}`,
      state: cleanText(status.state, 64),
      url: githubUrl(status.url),
    }
    if (!latestStatuses.has(value.context)) latestStatuses.set(value.context, value)
  })
  return { runs, checks, statuses: [...latestStatuses.values()] }
}

function assertExpectedHead(view: PullRequestView, expectedHeadSha: string): void {
  if (view.headSha !== validSha(expectedHeadSha)) {
    throw new Error('GitHub pull request head changed')
  }
}

function toolText(payload: unknown, isError = false) {
  const text = JSON.stringify(payload, null, 2)
  if (containsCredentialMaterial(text)) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ complete: false, reason: 'GitHub response contained protected credential material' }) }],
      isError: true,
    }
  }
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  }
}

export function registerGitHubCredentialTools(
  server: McpServer,
  context: GitHubBrokerContext,
  commands: GitHubPublicationCommands,
): void {
  // Binding a GitHub remote is intentionally lazy. A normal write task that
  // never needs GitHub must not fail merely because one workspace member has
  // no remote (or because the operator is temporarily offline).
  const selectRepository = repositorySelector(context)

  server.registerTool('github_inspect', {
    description: 'Inspect a repository or one pull request using the operator\'s existing GitHub login. Returns only repository-scoped structured facts; it never exposes credentials, config, PR bodies, comments, or raw command output.',
    inputSchema: {
      repository: z.string().max(256).describe('Exact owner/name from the current project.'),
      pullRequestNumber: z.number().int().positive().optional(),
      commitSha: z.string().regex(SHA).optional(),
    },
  }, async ({ repository, pullRequestNumber, commitSha }, extra) => {
    try {
      selectRepository(repository)
      const repo = await commands.runGh([
        'repo', 'view', repository, '--json', 'nameWithOwner,url,defaultBranchRef',
      ], undefined, extra.signal)
      if (repo.exitCode !== 0) commandFailure(repo, 'GitHub repository inspection')
      const rawRepo = parseJson(repo.stdout, 'GitHub repository inspection') as Record<string, unknown>
      const result: Record<string, unknown> = {
        complete: true,
        repository: cleanText(rawRepo.nameWithOwner) || repository,
        url: githubUrl(rawRepo.url),
        defaultBranch: rawRepo.defaultBranchRef && typeof rawRepo.defaultBranchRef === 'object'
          ? cleanText((rawRepo.defaultBranchRef as Record<string, unknown>).name)
          : '',
      }
      if (pullRequestNumber !== undefined) {
        result.pullRequest = await readPullRequest(
          commands, repository, pullRequestNumber, extra.signal,
        )
      }
      if (commitSha !== undefined) {
        const sha = validSha(commitSha)
        const runs = await commands.runGh([
          'run', 'list', '--repo', repository, '--commit', sha, '--limit', '50',
          '--json', 'databaseId,name,workflowName,status,conclusion,url,headSha,event',
        ], undefined, extra.signal)
        if (runs.exitCode !== 0) commandFailure(runs, 'GitHub workflow inspection')
        const rawRuns = parseJson(runs.stdout, 'GitHub workflow inspection')
        result.runs = Array.isArray(rawRuns) ? rawRuns.slice(0, 50).flatMap(raw => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
          const run = raw as Record<string, unknown>
          if (cleanText(run.headSha, 64) !== sha) return []
          return [{
            id: Number.isSafeInteger(run.databaseId) ? Number(run.databaseId) : null,
            name: cleanText(run.name ?? run.workflowName),
            status: cleanText(run.status, 64),
            conclusion: cleanText(run.conclusion, 64) || null,
            event: cleanText(run.event, 64),
            url: githubUrl(run.url),
            headSha: sha,
          }]
        }) : []
      }
      return toolText(result)
    } catch (error) {
      return toolText({ complete: false, reason: error instanceof Error ? error.message : String(error) }, true)
    }
  })

  server.registerTool('github_publish_branch', {
    description: 'Publish one exact local commit to one branch of a repository in the current project. The push is non-force and is reconciled with the remote before and after execution.',
    inputSchema: {
      repository: z.string().max(256),
      commitSha: z.string().regex(SHA),
      branch: z.string().min(1).max(255),
    },
  }, async ({ repository, commitSha, branch }, extra) => {
    try {
      if (!context.writeEnabled) throw new Error('GitHub mutation requires write access')
      const selected = selectRepository(repository)
      const sha = validSha(commitSha)
      const checkedBranch = validBranch(branch)
      const ref = `refs/heads/${checkedBranch}`
      const local = Bun.spawnSync([
        '/usr/bin/git', '-C', selected.root, 'cat-file', '-e', `${sha}^{commit}`,
      ], {
        env: { PATH: '/usr/bin:/bin', HOME: '/', LC_ALL: 'C' },
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
        timeout: LOCAL_GIT_TIMEOUT_MS,
      })
      if (local.exitCode !== 0) throw new Error('local GitHub publication commit is unavailable')
      const inspect = (): Promise<string | null> => readRemoteBranch(
        commands, selected, checkedBranch, extra.signal,
      )
      const before = await inspect()
      if (before !== sha) {
        const pushed = await commands.runGit(selected.root, [
          'push', '--no-verify', '--porcelain', selected.remote.canonicalUrl, `${sha}:${ref}`,
        ], extra.signal)
        if (pushed.exitCode !== 0 && await inspect() !== sha) {
          commandFailure(pushed, 'GitHub branch publication')
        }
      }
      if (await inspect() !== sha) throw new Error('GitHub branch publication was not confirmed')
      return toolText({ complete: true, repository, branch, commitSha: sha })
    } catch (error) {
      return toolText({ complete: false, reason: error instanceof Error ? error.message : String(error) }, true)
    }
  })

  server.registerTool('github_pull_request', {
    description: 'Create, approve, or merge a pull request in a repository belonging to the current project. Codex chooses the action; the broker only supplies authenticated, repository-scoped transport and checks the exact head SHA.',
    inputSchema: {
      repository: z.string().max(256),
      action: z.enum(['create', 'approve', 'merge']),
      pullRequestNumber: z.number().int().positive().optional(),
      expectedHeadSha: z.string().regex(SHA),
      baseBranch: z.string().min(1).max(255).optional(),
      headBranch: z.string().min(1).max(255).optional(),
      title: z.string().min(1).max(256).optional(),
      body: z.string().max(60_000).optional(),
      mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional(),
      autoQueue: z.boolean().optional(),
    },
  }, async (input, extra) => {
    try {
      if (!context.writeEnabled) throw new Error('GitHub mutation requires write access')
      const selected = selectRepository(input.repository)
      const expected = validSha(input.expectedHeadSha)
      if (input.action === 'create') {
        if (!input.baseBranch || !input.headBranch || !input.title) {
          throw new Error('pull request creation fields are incomplete')
        }
        const base = validBranch(input.baseBranch)
        const head = validBranch(input.headBranch)
        if (await readRemoteBranch(commands, selected, head, extra.signal) !== expected) {
          throw new Error('GitHub pull request head branch does not match the expected commit')
        }
        const matches = await listPullRequests(
          commands, input.repository, base, head, expected, extra.signal,
        )
        if (matches.length > 1) throw new Error('multiple GitHub pull requests match this commit')
        let view = matches[0]
        if (!view) {
          const title = cleanText(input.title, 256)
          if (!title || containsCredentialMaterial(input.body ?? '')) {
            throw new Error('pull request text is invalid or contains protected material')
          }
          const created = await commands.runGh([
            'pr', 'create', '--repo', input.repository, '--base', base, '--head', head,
            '--title', title, '--body-file', '-',
          ], input.body ?? '', extra.signal)
          const number = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/
            .exec(created.stdout)?.[1]
          if (number) {
            view = await readPullRequest(
              commands, input.repository, Number(number), extra.signal,
            )
            assertExpectedHead(view, expected)
          } else {
            // A network failure can hide a successful GitHub mutation. Re-read
            // the exact base/head/SHA before reporting failure or retrying.
            const reconciled = await listPullRequests(
              commands, input.repository, base, head, expected, extra.signal,
            )
            if (reconciled.length > 1) {
              throw new Error('multiple GitHub pull requests match this commit')
            }
            view = reconciled[0]
            if (!view) commandFailure(created, 'GitHub pull request creation')
          }
        }
        return toolText({ complete: true, action: input.action, pullRequest: view })
      }

      if (!input.pullRequestNumber) throw new Error('pull request number is required')
      let view = await readPullRequest(
        commands, input.repository, input.pullRequestNumber, extra.signal,
      )
      assertExpectedHead(view, expected)
      if (input.action === 'approve') {
        if (view.state !== 'OPEN') throw new Error('only an open pull request can be approved')
        if (!await approvalExists(
          commands, input.repository, view.number, expected, extra.signal,
        )) {
          const approved = await commands.runGh([
            'api', '--method', 'POST',
            `repos/${input.repository}/pulls/${view.number}/reviews`,
            '-f', 'event=APPROVE', '-f', `commit_id=${expected}`,
          ], undefined, extra.signal)
          if (!await approvalExists(
            commands, input.repository, view.number, expected, extra.signal,
          )) {
            if (approved.exitCode !== 0) {
              commandFailure(approved, 'GitHub pull request approval')
            }
            throw new Error('GitHub pull request approval was not confirmed')
          }
        }
        view = await readPullRequest(
          commands, input.repository, view.number, extra.signal,
        )
        assertExpectedHead(view, expected)
        return toolText({ complete: true, action: input.action, pullRequest: view })
      }

      if (view.state !== 'MERGED') {
        if (view.state !== 'OPEN') throw new Error('only an open pull request can be merged')
        const method = input.mergeMethod ?? 'squash'
        const merged = await commands.runGh([
          'pr', 'merge', String(view.number), '--repo', input.repository,
          `--${method}`,
          '--match-head-commit', expected,
          ...(input.autoQueue ? ['--auto'] : []),
        ], undefined, extra.signal)
        view = await readPullRequest(
          commands, input.repository, view.number, extra.signal,
        )
        assertExpectedHead(view, expected)
        if (view.state !== 'MERGED' && !view.autoMergeEnabled) {
          if (merged.exitCode !== 0) commandFailure(merged, 'GitHub pull request merge')
          throw new Error('GitHub pull request merge was not confirmed')
        }
      }
      return toolText({
        complete: view.state === 'MERGED',
        queued: view.state !== 'MERGED' && view.autoMergeEnabled,
        action: input.action,
        pullRequest: view,
      })
    } catch (error) {
      return toolText({ complete: false, reason: error instanceof Error ? error.message : String(error) }, true)
    }
  })

  server.registerTool('github_wait_delivery', {
    description: 'Wait for GitHub checks and Actions attached to an exact commit. This reports GitHub facts only; it never claims that a non-GitHub service is reachable.',
    inputSchema: {
      repository: z.string().max(256),
      commitSha: z.string().regex(SHA),
      pullRequestNumber: z.number().int().positive().optional(),
      maxWaitSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(600),
      settleSeconds: z.number().int().min(0).max(60).default(10),
    },
  }, async ({ repository, commitSha, pullRequestNumber, maxWaitSeconds, settleSeconds }, extra) => {
    try {
      selectRepository(repository)
      const sha = validSha(commitSha)
      const deadline = Date.now() + maxWaitSeconds * 1_000
      let last: Record<string, unknown> = {}
      let terminalSignature: string | null = null
      let terminalSince = 0
      do {
        const signals = await readGitHubSignals(
          commands, repository, sha, extra.signal,
        )
        const pullRequest = pullRequestNumber === undefined
          ? undefined : await readPullRequest(
              commands, repository, pullRequestNumber, extra.signal,
            )
        if (pullRequest) {
          if (pullRequest.state === 'MERGED') {
            if (pullRequest.mergeSha !== sha) {
              throw new Error('GitHub pull request merge commit does not match delivery commit')
            }
          } else {
            assertExpectedHead(pullRequest, sha)
          }
        }
        const hasSignals = signals.runs.length > 0
          || signals.checks.length > 0
          || signals.statuses.length > 0
        const allTerminal = hasSignals
          && signals.runs.every(run => run.status === 'completed')
          && signals.checks.every(check => check.status === 'completed')
          && signals.statuses.every(status => status.state !== 'pending')
        const allSuccessful = allTerminal
          && signals.runs.every(run => (
            ['success', 'neutral', 'skipped'].includes(run.conclusion ?? '')
          ))
          && signals.checks.every(check => (
            ['success', 'neutral', 'skipped'].includes(check.conclusion ?? '')
          ))
          && signals.statuses.every(status => status.state === 'success')
        const mergeComplete = pullRequest === undefined || pullRequest.state === 'MERGED'
        const signature = allTerminal && allSuccessful && mergeComplete
          ? JSON.stringify({
              runs: signals.runs.map(run => [run.id, run.status, run.conclusion]),
              checks: signals.checks.map(check => [check.id, check.status, check.conclusion]),
              statuses: signals.statuses.map(status => [status.context, status.state]),
            })
          : null
        if (signature === null || signature !== terminalSignature) {
          terminalSignature = signature
          terminalSince = signature === null ? 0 : Date.now()
        }
        const settled = signature !== null
          && Date.now() - terminalSince >= settleSeconds * 1_000
        last = {
          complete: settled,
          successful: allSuccessful,
          repository,
          commitSha: sha,
          runs: signals.runs,
          checks: signals.checks,
          statuses: signals.statuses,
          ...(pullRequest ? { pullRequest } : {}),
          serviceReachabilityVerified: false,
        }
        if (settled || Date.now() >= deadline) break
        await abortableSleep(
          Math.min(5_000, Math.max(1, deadline - Date.now())), extra.signal,
        )
      } while (Date.now() <= deadline)
      return toolText(last)
    } catch (error) {
      return toolText({ complete: false, reason: error instanceof Error ? error.message : String(error) }, true)
    }
  })
}

async function main(): Promise<void> {
  const [contextInput, stateInput] = process.argv.slice(2)
  if (!contextInput || !stateInput || process.argv.length !== 4) {
    throw new Error('usage: github-credential-broker.ts CONTEXT STATE_DIR')
  }
  const context = parseGitHubBrokerContext(contextInput, stateInput)
  if (!context.writeEnabled) throw new Error('GitHub broker requires a write-authorized job')
  const server = new McpServer({ name: 'zerochan-github', version: '1.0.0' })
  let resolvedCommands: GitHubPublicationCommands | undefined
  const commands = (): GitHubPublicationCommands => (
    resolvedCommands ??= createHostGitHubPublicationCommands()
  )
  registerGitHubCredentialTools(server, context, {
    runGit: (repo, args, signal) => commands().runGit(repo, args, signal),
    runGh: (args, stdin, signal) => commands().runGh(args, stdin, signal),
  })
  await server.connect(new StdioServerTransport())
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`Zeroちゃん GitHub broker: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
