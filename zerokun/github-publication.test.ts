import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  assertHostGitHubPublicationLogin,
  captureGitHubPublicationBaseline,
  gitHubPublicationBaselineDigest,
  GitHubPublicationError,
  prepareGitHubPublicationPlans,
  publishGitHubPlan,
  type GitHubPublicationCommands,
  type GitHubPublicationPlan,
  type GitHubPublicationSet,
  type PublicationCommandResult,
} from './github-publication.ts'
import {
  CodexResultPersistencePendingError,
  JobStore,
  publishStagedGitHubPublication,
  type EnqueueInput,
} from './job-runner.ts'
import { readAdvisorInputSnapshot } from './advisor-input.ts'

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zero-github-publication-'))
  temporaryDirs.push(dir)
  return dir
}

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(['/usr/bin/git', '-C', repo, ...args], {
    env: {
      PATH: '/usr/bin:/bin', HOME: '/', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C',
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function publicationFixture(slug = 'example/demo'): {
  repo: string
  plan: GitHubPublicationPlan
  baselineDigest: string
} {
  const repo = join(fixtureDir(), 'repo')
  mkdirSync(repo)
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'zero@example.invalid')
  git(repo, 'config', 'user.name', 'Zero Test')
  git(repo, 'config', 'remote.origin.url', `https://github.com/${slug}.git`)
  writeFileSync(join(repo, 'README.md'), 'initial\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-m', 'chore: initial')
  const baseline = captureGitHubPublicationBaseline(repo, [repo])
  const branch = 'zerochan/0123456789abcdef0123'
  git(repo, 'switch', '-c', branch)
  writeFileSync(join(repo, 'README.md'), 'reviewed change\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-m', 'fix: publish reviewed change')
  const head = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'switch', 'main')
  const physicalRepo = realpathSync(repo)
  const plans = prepareGitHubPublicationPlans(
    baseline,
    ['.'],
    [{ gitRoot: physicalRepo, head }],
    branch,
  )
  expect(plans).toHaveLength(1)
  return {
    repo: physicalRepo,
    plan: plans[0]!,
    baselineDigest: gitHubPublicationBaselineDigest(baseline),
  }
}

function result(
  exitCode: number,
  stdout = '',
  stderr = '',
  timedOut = false,
): PublicationCommandResult {
  return { exitCode, stdout, stderr, timedOut }
}

function localGitCommand(repo: string, args: readonly string[]): PublicationCommandResult {
  const command = Bun.spawnSync(['/usr/bin/git', '-C', repo, ...args], {
    env: {
      PATH: '/usr/bin:/bin', HOME: '/', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C',
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  return result(command.exitCode, command.stdout.toString(), command.stderr.toString())
}

function pullRequestJson(
  plan: GitHubPublicationPlan,
  number = 17,
  state: 'open' | 'closed' = 'open',
  mergedAt: string | null = null,
): string {
  return JSON.stringify([{
    number,
    html_url: `https://github.com/${plan.repositorySlug}/pull/${number}`,
    state,
    merged_at: mergedAt,
    head: {
      ref: plan.headBranch,
      sha: plan.commitSha,
      repo: { full_name: plan.repositorySlug },
    },
    base: { ref: plan.baseBranch, repo: { full_name: plan.repositorySlug } },
  }])
}

describe('host GitHub publication', () => {
  test('起動前login確認は既存gh認証だけを読み、認証操作を開始しない', async () => {
    const calls: string[][] = []
    const commands: GitHubPublicationCommands = {
      async runGit() { throw new Error('Git must not run during the login preflight') },
      async runGh(args) {
        calls.push([...args])
        return result(0, 'github.com login ok')
      },
    }
    await expect(assertHostGitHubPublicationLogin(commands)).resolves.toBeUndefined()
    expect(calls).toEqual([['auth', 'status', '--hostname', 'github.com']])

    await expect(assertHostGitHubPublicationLogin({
      ...commands,
      async runGh() { return result(1, '', 'not logged in') },
    })).rejects.toEqual(expect.objectContaining<Partial<GitHubPublicationError>>({
      category: 'authentication',
    }))
  })

  test('review済みSHAとhost指定branchだけをclean repositoryから計画する', () => {
    const { plan } = publicationFixture()
    expect(plan).toMatchObject({
      repositorySlug: 'example/demo',
      canonicalUrl: 'https://github.com/example/demo.git',
      baseBranch: 'main',
      headBranch: 'zerochan/0123456789abcdef0123',
      title: 'fix: publish reviewed change',
    })
    expect(plan.commitSha).toMatch(/^[0-9a-f]{40}$/)

    const repo = join(fixtureDir(), 'wrong-branch')
    mkdirSync(repo)
    git(repo, 'init', '--initial-branch=main')
    git(repo, 'config', 'user.email', 'zero@example.invalid')
    git(repo, 'config', 'user.name', 'Zero Test')
    git(repo, 'config', 'remote.origin.url', 'https://github.com/example/wrong.git')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-m', 'initial')
    const baseline = captureGitHubPublicationBaseline(repo, [repo])
    git(repo, 'switch', '-c', 'human/branch')
    writeFileSync(join(repo, 'a.txt'), 'b\n')
    git(repo, 'commit', '-am', 'change')
    const reviewedHead = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'switch', 'main')
    expect(() => prepareGitHubPublicationPlans(
      baseline,
      ['.'],
      [{ gitRoot: realpathSync(repo), head: reviewedHead }],
      'zerochan/assigned',
    )).toThrow('host-assigned publication branch')
  })

  test('push/PR作成の応答消失後もremote receiptを再照合して重複送信しない', async () => {
    const { plan } = publicationFixture()
    let remoteHead: string | null = null
    let pullRequestExists = false
    let pushes = 0
    let creates = 0
    const commands: GitHubPublicationCommands = {
      async runGit(repo, args) {
        if (args[0] === 'ls-remote') {
          const branch = args.at(-1)
          if (branch === `refs/heads/${plan.baseBranch}`) {
            return result(0, `${plan.initialHead}\t${branch}\n`)
          }
          return result(0, remoteHead ? `${remoteHead}\trefs/heads/${plan.headBranch}\n` : '')
        }
        if (args[0] === 'push') {
          pushes += 1
          remoteHead = plan.commitSha
          return result(1, '', 'connection reset after request', true)
        }
        return localGitCommand(repo, args)
      },
      async runGh(args, stdin) {
        if (args.includes('--method') && args.includes('GET')) {
          expect(args.join(' ')).toContain('state=all')
          return result(0, pullRequestExists ? pullRequestJson(plan) : '[]')
        }
        if (args.includes('--method') && args.includes('POST')) {
          creates += 1
          expect(JSON.parse(stdin ?? '{}')).toMatchObject({
            head: plan.headBranch,
            base: plan.baseBranch,
          })
          pullRequestExists = true
          return result(1, '', 'timeout after request', true)
        }
        throw new Error(`unexpected gh command: ${args.join(' ')}`)
      },
    }

    const receipt = await publishGitHubPlan(plan, commands)
    expect(receipt).toMatchObject({
      commitSha: plan.commitSha,
      pullRequestNumber: 17,
      pullRequestUrl: 'https://github.com/example/demo/pull/17',
    })
    expect(pushes).toBe(1)
    expect(creates).toBe(1)
    expect(git(plan.gitRoot, 'branch', '--show-current')).toBe(plan.baseBranch)
  })

  test('write結果は公開receipt前に完了せず、再起動後に同じcheckpointから完了する', async () => {
    const state = fixtureDir()
    const { repo, plan, baselineDigest } = publicationFixture()
    const dbPath = join(state, 'jobs.sqlite3')
    let store = new JobStore(dbPath)
    const enqueue: EnqueueInput = {
      chatId: 'C0123456789', threadTs: '1900000000.000100',
      messageId: '1900000000.000100', userId: 'U0123456789',
      repoPath: repo, task: '修正して', writeEnabled: true,
    }
    const queued = store.enqueue(enqueue).job
    const running = store.claimNext('publisher-worker')!
    const input = readAdvisorInputSnapshot(dirname(dbPath), running.id)
    const publication: GitHubPublicationSet = {
      version: 1,
      jobId: running.id,
      jobAttempt: running.attempts,
      logicalNonce: 'a'.repeat(32),
      inputRevision: input.revision,
      inputDigest: input.digest,
      reviewRound: 1,
      reviewedRepositoryDigest: createHash('sha256').update('review').digest('hex'),
      baselineDigest,
      plans: [plan],
    }
    expect(store.ensureExecutionResultStaged(
      running.id, 'session-reviewed', '実装とレビューが完了しました。', publication,
    )).toBe(true)
    expect(() => store.completeStagedExecution(running.id)).toThrow('publication is still pending')
    expect(() => store.complete(
      running.id, 'session-reviewed', 'must not bypass publication',
    )).toThrow('job is no longer running')
    expect(store.terminalNotificationCount()).toBe(0)
    expect(store.recoverInterrupted()).toEqual({
      requeued: 0, failedWrites: 0, failedUncertain: 0,
    })
    expect(store.get(running.id)?.status).toBe('running')
    store.close()

    store = new JobStore(dbPath)
    // Publication is bound to the immutable reviewed SHA, not whichever
    // branch a human happens to have checked out after a restart.
    git(repo, 'switch', 'main')
    let remoteHead: string | null = null
    let pullRequestExists = false
    let authenticationFailures = 0
    let pushes = 0
    let creates = 0
    const commands: GitHubPublicationCommands = {
      async runGit(repository, args) {
        const branch = args.at(-1)
        if (args[0] === 'ls-remote'
          && branch === `refs/heads/${plan.headBranch}`
          && authenticationFailures === 0) {
          authenticationFailures += 1
          return result(1, '', 'authentication failed')
        }
        if (args[0] === 'ls-remote') {
          if (branch === `refs/heads/${plan.baseBranch}`) {
            return result(0, `${plan.initialHead}\t${branch}\n`)
          }
          return result(0, remoteHead ? `${remoteHead}\trefs/heads/${plan.headBranch}\n` : '')
        }
        if (args[0] === 'push') {
          pushes += 1
          remoteHead = plan.commitSha
          return result(0, 'ok')
        }
        return localGitCommand(repository, args)
      },
      async runGh(args) {
        if (args.includes('GET')) {
          return result(0, pullRequestExists ? pullRequestJson(plan, 23) : '[]')
        }
        if (args.includes('POST')) {
          creates += 1
          pullRequestExists = true
          return result(0, '{}')
        }
        throw new Error(`unexpected gh command: ${args.join(' ')}`)
      },
    }
    const recordReceipt = store.recordGitHubPublicationReceipt.bind(store)
    let receiptCheckpointFailures = 0
    store.recordGitHubPublicationReceipt = (jobId, publicationPlan, receipt) => {
      if (receiptCheckpointFailures === 0) {
        receiptCheckpointFailures += 1
        throw new Error('fixture receipt checkpoint failure')
      }
      recordReceipt(jobId, publicationPlan, receipt)
    }
    await expect(publishStagedGitHubPublication(store, queued.id, {
      commands,
      retryMsForTesting: 1,
    })).rejects.toBeInstanceOf(CodexResultPersistencePendingError)
    expect(store.get(queued.id)?.status).toBe('running')
    expect(store.terminalNotificationCount()).toBe(0)
    await publishStagedGitHubPublication(store, queued.id, {
      commands,
      retryMsForTesting: 1,
    })
    store.completeStagedExecution(queued.id)
    expect(store.get(queued.id)).toMatchObject({
      status: 'completed',
      sessionId: 'session-reviewed',
    })
    expect(store.get(queued.id)?.result).toContain('https://github.com/example/demo/pull/23')
    expect(authenticationFailures).toBe(1)
    expect(pushes).toBe(1)
    expect(creates).toBe(1)
    store.close()
  })

  test('remote branchが別SHAなら非強制で上書きせず競合として保留する', async () => {
    const { plan } = publicationFixture()
    const commands: GitHubPublicationCommands = {
      async runGit(repository, args) {
        if (args[0] === 'ls-remote') {
          const branch = args.at(-1)
          const sha = branch === `refs/heads/${plan.baseBranch}`
            ? plan.initialHead
            : 'f'.repeat(40)
          return result(0, `${sha}\t${branch}\n`)
        }
        if (args[0] === 'push') return result(1, '', 'rejected non-fast-forward')
        return localGitCommand(repository, args)
      },
      async runGh(args) {
        if (args.includes('GET')) return result(0, '[]')
        throw new Error('PR creation must not run after a branch conflict')
      },
    }
    await expect(publishGitHubPlan(plan, commands)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubPublicationError>>({ category: 'conflict' }),
    )
  })

  test('prepared baseとGitHub baseが違えばtask外commitを含めて公開しない', async () => {
    const { plan } = publicationFixture()
    let pushes = 0
    const commands: GitHubPublicationCommands = {
      async runGit(repository, args) {
        if (args[0] === 'ls-remote') {
          const branch = args.at(-1)
          if (branch === `refs/heads/${plan.baseBranch}`) {
            return result(0, `${'e'.repeat(40)}\t${branch}\n`)
          }
          return result(0, '')
        }
        if (args[0] === 'push') {
          pushes += 1
          return result(0, 'unexpected')
        }
        return localGitCommand(repository, args)
      },
      async runGh(args) {
        if (args.includes('GET')) return result(0, '[]')
        throw new Error('PR creation must not run for a changed base')
      },
    }
    await expect(publishGitHubPlan(plan, commands)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubPublicationError>>({ category: 'conflict' }),
    )
    expect(pushes).toBe(0)
  })

  test('base branchの通常fast-forwardはGitHub ancestry照合後に許可する', async () => {
    const { plan } = publicationFixture()
    const remoteBase = 'd'.repeat(40)
    let remoteHead: string | null = null
    let created = false
    const commands: GitHubPublicationCommands = {
      async runGit(repository, args) {
        if (args[0] === 'ls-remote') {
          const branch = args.at(-1)
          if (branch === `refs/heads/${plan.baseBranch}`) {
            return result(0, `${remoteBase}\t${branch}\n`)
          }
          return result(0, remoteHead ? `${remoteHead}\t${branch}\n` : '')
        }
        if (args[0] === 'push') {
          remoteHead = plan.commitSha
          expect(args).toContain('--no-follow-tags')
          expect(args).toContain('--recurse-submodules=no')
          expect(args).toContain('--no-signed')
          return result(0, 'ok')
        }
        return localGitCommand(repository, args)
      },
      async runGh(args) {
        const command = args.join(' ')
        if (command.includes('/compare/')) {
          return result(0, JSON.stringify({
            status: 'ahead', ahead_by: 1, behind_by: 0,
            base_commit: { sha: plan.initialHead },
            merge_base_commit: { sha: plan.initialHead },
          }))
        }
        if (args.includes('GET')) {
          return result(0, created ? pullRequestJson(plan, 31) : '[]')
        }
        if (args.includes('POST')) {
          created = true
          return result(0, '{}')
        }
        throw new Error(`unexpected gh command: ${command}`)
      },
    }
    await expect(publishGitHubPlan(plan, commands)).resolves.toMatchObject({
      pullRequestNumber: 31,
    })
    expect(git(plan.gitRoot, 'branch', '--show-current')).toBe(plan.baseBranch)
  })

  test('merged PR receiptはhead branch削除後もlocal checkoutへ依存せず復元する', async () => {
    const { plan } = publicationFixture()
    const unavailable = { ...plan, gitRoot: join(fixtureDir(), 'missing-repository') }
    const commands: GitHubPublicationCommands = {
      async runGit(_repo, args) {
        expect(args[0]).toBe('ls-remote')
        return result(0, '')
      },
      async runGh(args) {
        expect(args.join(' ')).toContain('state=all')
        return result(0, pullRequestJson(
          unavailable, 44, 'closed', '2026-09-01T00:00:00Z',
        ))
      },
    }
    await expect(publishGitHubPlan(unavailable, commands)).resolves.toMatchObject({
      pullRequestNumber: 44,
    })
  })

  test('PR確定後もhost publisherは人のcheckoutや未commit変更へ触れない', async () => {
    const { plan } = publicationFixture()
    writeFileSync(join(plan.gitRoot, 'human-notes.txt'), 'keep this work\n')
    const commands: GitHubPublicationCommands = {
      async runGit(repository, args) {
        if (args[0] === 'ls-remote') {
          return result(0, `${plan.commitSha}\trefs/heads/${plan.headBranch}\n`)
        }
        return localGitCommand(repository, args)
      },
      async runGh() {
        return result(0, pullRequestJson(plan, 45))
      },
    }
    await expect(publishGitHubPlan(plan, commands)).resolves.toMatchObject({
      pullRequestNumber: 45,
    })
    expect(git(plan.gitRoot, 'branch', '--show-current')).toBe(plan.baseBranch)
    expect(git(plan.gitRoot, 'status', '--porcelain')).toContain('human-notes.txt')
  })

  test('dirty baselineとbaseline外scopeを公開計画にしない', () => {
    const repo = join(fixtureDir(), 'dirty')
    mkdirSync(repo)
    git(repo, 'init', '--initial-branch=main')
    git(repo, 'config', 'user.email', 'zero@example.invalid')
    git(repo, 'config', 'user.name', 'Zero Test')
    git(repo, 'config', 'remote.origin.url', 'https://github.com/example/dirty.git')
    writeFileSync(join(repo, 'README.md'), 'initial\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-m', 'initial')
    writeFileSync(join(repo, 'README.md'), 'uncommitted user work\n')
    expect(() => captureGitHubPublicationBaseline(repo, [repo])).toThrow('must be clean')

    git(repo, 'restore', 'README.md')
    const baseline = captureGitHubPublicationBaseline(repo, [repo])
    expect(() => prepareGitHubPublicationPlans(baseline, ['missing'])).toThrow(
      'not fully bound',
    )
  })

  test('closed-unmerged PRは成功receiptにせず競合として保留する', async () => {
    const { plan } = publicationFixture()
    let pushes = 0
    const commands: GitHubPublicationCommands = {
      async runGit(_repo, args) {
        if (args[0] === 'ls-remote') {
          return result(0, `${plan.commitSha}\trefs/heads/${plan.headBranch}\n`)
        }
        if (args[0] === 'push') pushes += 1
        return result(0)
      },
      async runGh() {
        return result(0, pullRequestJson(plan, 51, 'closed', null))
      },
    }
    await expect(publishGitHubPlan(plan, commands)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubPublicationError>>({ category: 'conflict' }),
    )
    expect(pushes).toBe(0)
  })

  test('process cleanup未確認後はdurable quarantineから外部writeを再送しない', async () => {
    const state = fixtureDir()
    const { repo, plan, baselineDigest } = publicationFixture()
    const store = new JobStore(join(state, 'jobs.sqlite3'))
    const queued = store.enqueue({
      chatId: 'C0123456789', threadTs: '1900000000.000300',
      messageId: '1900000000.000300', userId: 'U0123456789',
      repoPath: repo, task: '公開して', writeEnabled: true,
    }).job
    const running = store.claimNext('publisher-cleanup-worker')!
    const input = readAdvisorInputSnapshot(dirname(store.dbPath), running.id)
    store.ensureExecutionResultStaged(running.id, 'session-cleanup', '実装済み', {
      version: 1,
      jobId: running.id,
      jobAttempt: running.attempts,
      logicalNonce: 'b'.repeat(32),
      inputRevision: input.revision,
      inputDigest: input.digest,
      reviewRound: 1,
      reviewedRepositoryDigest: createHash('sha256').update('review').digest('hex'),
      baselineDigest,
      plans: [plan],
    })
    let externalCalls = 0
    const commands: GitHubPublicationCommands = {
      async runGit() {
        externalCalls += 1
        throw new GitHubPublicationError('cleanup', 'fixture group still alive')
      },
      async runGh() {
        externalCalls += 1
        return result(0)
      },
    }
    await expect(publishStagedGitHubPublication(store, queued.id, {
      commands, retryMsForTesting: 1,
    })).rejects.toBeInstanceOf(CodexResultPersistencePendingError)
    expect(externalCalls).toBe(1)
    await expect(publishStagedGitHubPublication(store, queued.id, {
      commands, retryMsForTesting: 1,
    })).rejects.toBeInstanceOf(CodexResultPersistencePendingError)
    expect(externalCalls).toBe(1)
    expect(store.get(queued.id)?.status).toBe('running')
    store.close()
  })

  test('host pushが実行し得るalternate refs commandを拒否する', () => {
    const repo = join(fixtureDir(), 'hostile-alternate-refs')
    mkdirSync(repo)
    git(repo, 'init', '--initial-branch=main')
    git(repo, 'config', 'user.email', 'zero@example.invalid')
    git(repo, 'config', 'user.name', 'Zero Test')
    git(repo, 'config', 'remote.origin.url', 'https://github.com/example/hostile.git')
    writeFileSync(join(repo, 'README.md'), 'initial\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-m', 'initial')
    git(repo, 'config', 'core.alternateRefsCommand', '/bin/sh -c id')
    expect(() => captureGitHubPublicationBaseline(repo, [repo])).toThrow(
      'unsafe for host publication',
    )
  })
})
