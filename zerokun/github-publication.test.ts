import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  assertGitHubPublicationPlan,
  assertHostGitHubPublicationLogin,
  captureGitHubPublicationBaseline,
  captureGitHubPublicationBaselineForBranches,
  gitHubPublicationBaselineDigest,
  GitHubPublicationError,
  prepareGitHubPublicationPlans,
  prepareGitHubPromotionPlans,
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
  // Real projects commonly install Husky this way. Host publication disables
  // hooks independently, so this repository-owned value must not block the
  // baseline while still remaining pinned by the local-config digest.
  git(repo, 'config', 'core.hooksPath', '.husky/_')
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

function implementedPromotionFixture(slug = 'example/implemented-promotion'): {
  repo: string
  plan: GitHubPublicationPlan
  baseline: ReturnType<typeof captureGitHubPublicationBaselineForBranches>
  developHead: string
  mainHead: string
  unrelatedBranch: string
  unrelatedHead: string
} {
  const root = fixtureDir()
  const repo = join(root, 'repo')
  const implementationWorktree = join(root, 'implementation-worktree')
  mkdirSync(repo)
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'zero@example.invalid')
  git(repo, 'config', 'user.name', 'Zero Test')
  git(repo, 'config', 'remote.origin.url', `https://github.com/${slug}.git`)
  writeFileSync(join(repo, 'README.md'), 'initial\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-m', 'chore: initial')
  const mainHead = git(repo, 'rev-parse', 'HEAD')

  git(repo, 'switch', '-c', 'develop')
  writeFileSync(join(repo, 'develop.txt'), 'develop base\n')
  git(repo, 'add', 'develop.txt')
  git(repo, 'commit', '-m', 'chore: prepare develop')
  const developHead = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'update-ref', 'refs/remotes/origin/main', mainHead)
  git(repo, 'update-ref', 'refs/remotes/origin/develop', developHead)

  const unrelatedBranch = 'feature/unrelated-shared-checkout'
  git(repo, 'switch', 'main')
  git(repo, 'switch', '-c', unrelatedBranch)
  writeFileSync(join(repo, 'unrelated.txt'), 'concurrent unrelated work\n')
  git(repo, 'add', 'unrelated.txt')
  git(repo, 'commit', '-m', 'docs: unrelated shared checkout')
  const unrelatedHead = git(repo, 'rev-parse', 'HEAD')

  const physicalRepo = realpathSync(repo)
  const baseline = captureGitHubPublicationBaselineForBranches(repo, [{
    gitRoot: physicalRepo,
    baseBranch: 'develop',
  }])
  const headBranch = 'zerochan/implemented0123456789'
  git(repo, 'worktree', 'add', '-b', headBranch, implementationWorktree, developHead)
  writeFileSync(join(implementationWorktree, 'implemented.txt'), 'reviewed implementation\n')
  git(implementationWorktree, 'add', 'implemented.txt')
  git(implementationWorktree, 'commit', '-m', 'feat: implement reviewed change')
  const implementationHead = git(implementationWorktree, 'rev-parse', 'HEAD')
  git(repo, 'worktree', 'remove', implementationWorktree)

  const [ordinaryPlan] = prepareGitHubPublicationPlans(
    baseline,
    ['.'],
    [{ gitRoot: physicalRepo, head: implementationHead }],
    headBranch,
  )
  if (!ordinaryPlan) throw new Error('implemented publication fixture omitted its plan')
  const plan: GitHubPublicationPlan = {
    ...ordinaryPlan,
    promotion: {
      version: 1,
      sourceBranch: headBranch,
      sourceHead: implementationHead,
      followupBaseBranch: 'main',
      followupInitialHead: mainHead,
    },
  }
  return {
    repo: physicalRepo,
    plan,
    baseline,
    developHead,
    mainHead,
    unrelatedBranch,
    unrelatedHead,
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

function exactPullRequestJson(input: {
  plan: GitHubPublicationPlan
  number: number
  state?: 'open' | 'closed'
  mergedAt?: string | null
  mergeCommitSha?: string | null
  body?: string | null
}): string {
  return JSON.stringify([{
    number: input.number,
    html_url: `https://github.com/${input.plan.repositorySlug}/pull/${input.number}`,
    state: input.state ?? 'open',
    merged_at: input.mergedAt ?? null,
    merge_commit_sha: input.mergeCommitSha ?? null,
    ...(input.body !== undefined ? { body: input.body } : {}),
    head: {
      ref: input.plan.headBranch,
      sha: input.plan.commitSha,
      repo: { full_name: input.plan.repositorySlug },
    },
    base: {
      ref: input.plan.baseBranch,
      repo: { full_name: input.plan.repositorySlug },
    },
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

  test('HuskyのhooksPathは許容し、baseline後の値変更は公開計画を無効化する', () => {
    const { repo, plan } = publicationFixture('example/husky')
    expect(git(repo, 'config', '--local', 'core.hooksPath')).toBe('.husky/_')
    expect(plan.repositorySlug).toBe('example/husky')

    git(repo, 'config', 'core.hooksPath', '.config/husky/_')
    expect(() => prepareGitHubPublicationPlans({
      version: 1,
      projectPath: repo,
      repositories: [{
        gitRoot: repo,
        initialHead: plan.initialHead,
        baseBranch: plan.baseBranch,
        statusDigest: plan.statusDigest,
        localConfigDigest: plan.localConfigDigest,
        originUrlDigest: plan.originUrlDigest,
        remote: {
          owner: 'example',
          repository: 'husky',
          slug: 'example/husky',
          canonicalUrl: 'https://github.com/example/husky.git',
        },
      }],
    }, ['.'], undefined, plan.headBranch)).toThrow(
      'repository config or origin changed outside the reviewed commit',
    )
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

  test('既存commitをdevelopへ統合した後だけdevelopからmainへのrelease PRを冪等作成する', async () => {
    const repo = join(fixtureDir(), 'promotion')
    mkdirSync(repo)
    git(repo, 'init', '--initial-branch=main')
    git(repo, 'config', 'user.email', 'zero@example.invalid')
    git(repo, 'config', 'user.name', 'Zero Test')
    git(repo, 'config', 'remote.origin.url', 'https://github.com/example/promotion.git')
    git(repo, 'config', 'core.hooksPath', '.husky/_')
    writeFileSync(join(repo, 'README.md'), 'initial\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-m', 'chore: initial')
    git(repo, 'switch', '-c', 'feature/reviewed-ui')
    writeFileSync(join(repo, 'README.md'), 'reviewed UI\n')
    git(repo, 'commit', '-am', 'feat: reviewed UI')
    const sourceHead = git(repo, 'rev-parse', 'HEAD')
    const baseline = captureGitHubPublicationBaseline(repo, [repo])
    const developInitial = 'a'.repeat(40)
    const mainInitial = 'b'.repeat(40)
    const promotedDevelop = 'c'.repeat(40)
    const branch = 'zerochan/promotion0123456789'
    const remoteHeads = new Map<string, string | null>([
      [branch, null],
      ['develop', developInitial],
      ['main', mainInitial],
    ])
    let integrationExists = false
    let integrationMerged = false
    let releaseExists = false
    let pushes = 0
    let integrationCreates = 0
    let mergeAttempts = 0
    let releaseCreates = 0
    let failReleaseLookupOnce = true
    let readinessChecks = 0
    const integrationPlan = (): GitHubPublicationPlan => plan
    const releasePlan = (): GitHubPublicationPlan => ({
      ...plan,
      baseBranch: 'main',
      headBranch: 'develop',
      commitSha: remoteHeads.get('develop')!,
      initialHead: mainInitial,
      promotion: undefined,
    })
    const commands: GitHubPublicationCommands = {
      async runGit(_repository, args) {
        if (args[0] === 'ls-remote') {
          const ref = String(args.at(-1))
          const branchName = ref.replace(/^refs\/heads\//, '')
          const head = remoteHeads.get(branchName) ?? null
          return result(0, head ? `${head}\t${ref}\n` : '')
        }
        if (args[0] === 'push') {
          pushes += 1
          expect(args).toContain('--no-verify')
          remoteHeads.set(branch, sourceHead)
          return result(1, '', 'connection reset after request', true)
        }
        throw new Error(`unexpected git command: ${args.join(' ')}`)
      },
      async runGh(args, stdin) {
        const command = args.join(' ')
        if (command.includes('/compare/')) {
          const prepared = /\/compare\/([0-9a-f]+)\.\.\./.exec(command)?.[1]
          if (!prepared) throw new Error(`invalid compare request: ${command}`)
          return result(0, JSON.stringify({
            status: 'ahead', ahead_by: 1, behind_by: 0,
            base_commit: { sha: prepared },
            merge_base_commit: { sha: prepared },
          }))
        }
        if (args.includes('GET') && command.endsWith('repos/example/promotion')) {
          return result(0, JSON.stringify({
            allow_squash_merge: true,
            allow_merge_commit: false,
            allow_rebase_merge: false,
          }))
        }
        if (args.includes('GET') && command.endsWith('repos/example/promotion/pulls/71')) {
          readinessChecks += 1
          const record = JSON.parse(exactPullRequestJson({
            plan: integrationPlan(),
            number: 71,
          }))[0] as Record<string, unknown>
          return result(0, JSON.stringify({
            ...record,
            draft: false,
            mergeable: readinessChecks > 1,
            mergeable_state: readinessChecks > 1 ? 'clean' : 'blocked',
          }))
        }
        if (args.includes('GET') && command.includes('/pulls?')) {
          if (command.includes('base=develop')) {
            return result(0, integrationExists ? exactPullRequestJson({
              plan: integrationPlan(),
              number: 71,
              state: integrationMerged ? 'closed' : 'open',
              mergedAt: integrationMerged ? '2026-09-01T00:00:00Z' : null,
              mergeCommitSha: integrationMerged ? promotedDevelop : null,
            }) : '[]')
          }
          if (command.includes('base=main')) {
            if (integrationMerged && failReleaseLookupOnce) {
              failReleaseLookupOnce = false
              return result(1, '', 'network is unreachable')
            }
            return result(0, releaseExists ? exactPullRequestJson({
              plan: releasePlan(), number: 72,
            }) : '[]')
          }
        }
        if (args.includes('POST') && command.includes('/pulls')) {
          const request = JSON.parse(stdin ?? '{}') as Record<string, string>
          if (request.base === 'develop') {
            integrationCreates += 1
            expect(request.head).toBe(branch)
            integrationExists = true
          } else if (request.base === 'main') {
            releaseCreates += 1
            expect(integrationMerged).toBe(true)
            expect(request.head).toBe('develop')
            releaseExists = true
          } else throw new Error(`unexpected PR base: ${request.base}`)
          return result(1, '', 'timeout after request', true)
        }
        if (args.includes('PUT') && command.includes('/pulls/71/merge')) {
          mergeAttempts += 1
          expect(JSON.parse(stdin ?? '{}')).toMatchObject({
            sha: sourceHead,
            merge_method: 'squash',
          })
          integrationMerged = true
          remoteHeads.set('develop', promotedDevelop)
          return result(1, '', 'timeout after request', true)
        }
        throw new Error(`unexpected gh command: ${command}`)
      },
    }
    const [plan] = await prepareGitHubPromotionPlans(
      baseline,
      [{ gitRoot: realpathSync(repo), baseBranch: 'develop', followupBaseBranch: 'main' }],
      branch,
      commands,
    )
    expect(plan).toMatchObject({
      baseBranch: 'develop',
      headBranch: branch,
      commitSha: sourceHead,
      promotion: {
        sourceBranch: 'feature/reviewed-ui',
        sourceHead,
        followupBaseBranch: 'main',
      },
    })

    await expect(publishGitHubPlan(plan!, commands)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubPublicationError>>({ category: 'waiting' }),
    )
    expect(mergeAttempts).toBe(0)
    await expect(publishGitHubPlan(plan!, commands)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubPublicationError>>({ category: 'network' }),
    )
    const first = await publishGitHubPlan(plan!, commands)
    expect(first).toMatchObject({
      pullRequestNumber: 71,
      pullRequestUrl: 'https://github.com/example/promotion/pull/71',
      followupPullRequestNumber: 72,
      followupPullRequestUrl: 'https://github.com/example/promotion/pull/72',
    })
    const second = await publishGitHubPlan(plan!, commands)
    expect(second).toEqual(first)
    remoteHeads.set('develop', 'd'.repeat(40))
    const afterOrdinaryDevelopAdvance = await publishGitHubPlan(plan!, commands)
    expect(afterOrdinaryDevelopAdvance).toEqual(first)
    expect({ pushes, integrationCreates, mergeAttempts, releaseCreates }).toEqual({
      pushes: 1,
      integrationCreates: 1,
      mergeAttempts: 1,
      releaseCreates: 1,
    })

    const dbPath = join(fixtureDir(), 'jobs.sqlite3')
    let store = new JobStore(dbPath)
    const queued = store.enqueue({
      chatId: 'C0123456789', threadTs: '1900000000.000150',
      messageId: '1900000000.000150', userId: 'U0123456789',
      repoPath: repo, task: 'developへ適用してmain向けPRを作成', writeEnabled: true,
    }).job
    const running = store.claimNext('promotion-publisher')!
    const input = readAdvisorInputSnapshot(dirname(dbPath), running.id)
    store.ensureExecutionResultStaged(
      running.id,
      'session-promotion',
      'レビューが完了しました。',
      {
        version: 1,
        jobId: running.id,
        jobAttempt: running.attempts,
        logicalNonce: 'c'.repeat(32),
        inputRevision: input.revision,
        inputDigest: input.digest,
        reviewRound: 1,
        reviewedRepositoryDigest: createHash('sha256').update('promotion-review').digest('hex'),
        baselineDigest: gitHubPublicationBaselineDigest(baseline),
        plans: [plan!],
      },
    )
    store.close()
    const legacy = new Database(dbPath)
    legacy.exec(`
      PRAGMA foreign_keys=ON;
      INSERT INTO github_publications SELECT * FROM github_promotion_publications;
      DELETE FROM github_promotion_publications;
    `)
    legacy.close()
    store = new JobStore(dbPath)
    expect(store.pendingGitHubPublications(queued.id)).toHaveLength(1)
    store.recordGitHubPublicationReceipt(queued.id, plan!, first)
    expect(store.completeGitHubPublicationSet(queued.id)).toBe(true)
    store.completeStagedExecution(queued.id)
    expect(store.get(queued.id)?.result).toContain(
      'https://github.com/example/promotion/pull/71',
    )
    expect(store.get(queued.id)?.result).toContain(
      'https://github.com/example/promotion/pull/72',
    )
    store.close()

    const cancelledDb = join(fixtureDir(), 'jobs.sqlite3')
    const cancelledStore = new JobStore(cancelledDb)
    const cancelled = cancelledStore.enqueue({
      chatId: 'C0123456789', threadTs: '1900000000.000250',
      messageId: '1900000000.000250', userId: 'U0123456789',
      repoPath: repo, task: '公開を中止できること', writeEnabled: true,
    }).job
    const cancelledRunning = cancelledStore.claimNext('promotion-cancel')!
    const cancelledInput = readAdvisorInputSnapshot(dirname(cancelledDb), cancelledRunning.id)
    cancelledStore.ensureExecutionResultStaged(
      cancelledRunning.id,
      'session-promotion-cancel',
      '公開待機中です。',
      {
        version: 1,
        jobId: cancelledRunning.id,
        jobAttempt: cancelledRunning.attempts,
        logicalNonce: 'd'.repeat(32),
        inputRevision: cancelledInput.revision,
        inputDigest: cancelledInput.digest,
        reviewRound: 1,
        reviewedRepositoryDigest: createHash('sha256').update('cancel-review').digest('hex'),
        baselineDigest: gitHubPublicationBaselineDigest(baseline),
        plans: [plan!],
      },
    )
    const target = cancelledStore.liveControlTarget(
      cancelledRunning.chatId,
      cancelledRunning.threadTs,
    )!
    expect(cancelledStore.stageLiveControl(target, {
      chatId: cancelledRunning.chatId,
      threadTs: cancelledRunning.threadTs,
      messageId: '1900000000.000251',
      userId: 'U0123456789',
      task: 'やめて',
      kind: 'interrupt',
    })).toBe('staged')
    expect(cancelledStore.pendingGitHubPublicationJobIds()).toEqual([])
    let externalCalls = 0
    await expect(publishStagedGitHubPublication(
      cancelledStore,
      cancelled.id,
      {
        commands: {
          async runGit() { externalCalls += 1; return result(0) },
          async runGh() { externalCalls += 1; return result(0) },
        },
        retryMsForTesting: 1,
      },
    )).rejects.toMatchObject({ name: 'CodexUserCancelledError' })
    expect(externalCalls).toBe(0)
    cancelledStore.close()
  })

  test('実装promotionは共有checkoutを動かさずfeatureをdevelopへmergeしてmain PRを作る', async () => {
    const value = implementedPromotionFixture()
    const plan: GitHubPublicationPlan = {
      ...value.plan,
      promotion: {
        ...value.plan.promotion!,
        waitForChecks: true,
        integrationPullRequestBody: '## Summary\nreviewed {{COMMIT_SHA}}',
        followupPullRequestBody: '## Summary\nrelease {{COMMIT_SHA}}',
        closePullRequestNumbers: [857],
      },
    }
    expect(plan).toMatchObject({
      baseBranch: 'develop',
      initialHead: value.developHead,
      promotion: {
        sourceBranch: plan.headBranch,
        sourceHead: plan.commitSha,
        followupBaseBranch: 'main',
        followupInitialHead: value.mainHead,
      },
    })
    expect(git(value.repo, 'branch', '--show-current')).toBe(value.unrelatedBranch)
    expect(git(value.repo, 'rev-parse', 'HEAD')).toBe(value.unrelatedHead)

    // Concurrent user work in the active shared checkout is unrelated to the
    // exact reviewed feature ref and must neither be discarded nor become the
    // publication base.
    writeFileSync(join(value.repo, 'operator-notes.txt'), 'keep this worktree change\n')
    assertGitHubPublicationPlan(plan)

    const integrationMergeHead = 'd'.repeat(40)
    const remoteHeads = new Map<string, string | null>([
      [plan.headBranch, null],
      ['develop', value.developHead],
      ['main', value.mainHead],
    ])
    let integrationExists = false
    let integrationMerged = false
    let followupExists = false
    let integrationCreates = 0
    let integrationMerges = 0
    let followupCreates = 0
    let obsoleteOpen = true
    let obsoleteCloses = 0
    let integrationBody: string | null = null
    let followupBody: string | null = null
    const followupPlan = (): GitHubPublicationPlan => ({
      ...plan,
      baseBranch: 'main',
      headBranch: 'develop',
      commitSha: integrationMergeHead,
      initialHead: value.mainHead,
      promotion: undefined,
    })
    const commands: GitHubPublicationCommands = {
      async runGit(_repository, args) {
        if (args[0] === 'ls-remote') {
          const ref = String(args.at(-1))
          const branch = ref.replace(/^refs\/heads\//, '')
          const head = remoteHeads.get(branch) ?? null
          return result(0, head ? `${head}\t${ref}\n` : '')
        }
        if (args[0] === 'push') {
          remoteHeads.set(plan.headBranch, plan.commitSha)
          return result(0, 'ok')
        }
        throw new Error(`unexpected implemented-promotion Git command: ${args.join(' ')}`)
      },
      async runGh(args, stdin) {
        const command = args.join(' ')
        if (command.includes('/compare/')) {
          const prepared = /\/compare\/([0-9a-f]+)\.\.\./.exec(command)?.[1]
          if (!prepared) throw new Error(`invalid compare request: ${command}`)
          return result(0, JSON.stringify({
            status: 'ahead', ahead_by: 1, behind_by: 0,
            base_commit: { sha: prepared }, merge_base_commit: { sha: prepared },
          }))
        }
        if (args.includes('GET') && command.endsWith('repos/example/implemented-promotion')) {
          return result(0, JSON.stringify({
            allow_merge_commit: true,
            allow_squash_merge: true,
            allow_rebase_merge: true,
          }))
        }
        if (args.includes('GET')
          && command.endsWith('repos/example/implemented-promotion/pulls/301')) {
          const record = JSON.parse(exactPullRequestJson({
            plan,
            number: 301,
            state: integrationMerged ? 'closed' : 'open',
            mergedAt: integrationMerged ? '2026-09-01T00:00:00Z' : null,
            mergeCommitSha: integrationMerged ? integrationMergeHead : null,
            body: integrationBody,
          }))[0] as Record<string, unknown>
          return result(0, JSON.stringify({
            ...record,
            draft: false,
            mergeable: true,
            mergeable_state: 'clean',
          }))
        }
        if (args.includes('GET')
          && command.endsWith('repos/example/implemented-promotion/pulls/857')) {
          return result(0, JSON.stringify({
            number: 857,
            html_url: 'https://github.com/example/implemented-promotion/pull/857',
            state: obsoleteOpen ? 'open' : 'closed',
            merged_at: null,
            head: { repo: { full_name: plan.repositorySlug } },
            base: { repo: { full_name: plan.repositorySlug } },
          }))
        }
        if (args.includes('GET') && command.includes(`/commits/${plan.commitSha}/check-runs`)) {
          return result(0, JSON.stringify({
            total_count: 2,
            check_runs: [
              { name: 'quality', status: 'completed', conclusion: 'success' },
              { name: 'security', status: 'completed', conclusion: 'neutral' },
            ],
          }))
        }
        if (args.includes('GET') && command.includes(`/commits/${plan.commitSha}/status`)) {
          return result(0, JSON.stringify({ statuses: [] }))
        }
        if (args.includes('GET') && command.includes('/pulls?')) {
          if (command.includes('base=develop')) {
            return result(0, integrationExists ? exactPullRequestJson({
              plan,
              number: 301,
              state: integrationMerged ? 'closed' : 'open',
              mergedAt: integrationMerged ? '2026-09-01T00:00:00Z' : null,
              mergeCommitSha: integrationMerged ? integrationMergeHead : null,
              body: integrationBody,
            }) : '[]')
          }
          if (command.includes('base=main')) {
            return result(0, followupExists ? exactPullRequestJson({
              plan: followupPlan(),
              number: 302,
              body: followupBody,
            }) : '[]')
          }
        }
        if (args.includes('POST') && command.includes('/pulls')) {
          const request = JSON.parse(stdin ?? '{}') as Record<string, string>
          if (request.base === 'develop') {
            integrationCreates += 1
            expect(request.head).toBe(plan.headBranch)
            integrationBody = request.body
            integrationExists = true
          } else if (request.base === 'main') {
            followupCreates += 1
            expect(integrationMerged).toBe(true)
            expect(request.head).toBe('develop')
            followupBody = request.body
            followupExists = true
          } else {
            throw new Error(`unexpected implemented-promotion PR base: ${request.base}`)
          }
          return result(0, '{}')
        }
        if (args.includes('PATCH') && command.endsWith('/pulls/857 --input -')) {
          expect(JSON.parse(stdin ?? '{}')).toEqual({ state: 'closed' })
          obsoleteCloses += 1
          obsoleteOpen = false
          return result(0, '{}')
        }
        if (args.includes('PUT') && command.includes('/pulls/301/merge')) {
          integrationMerges += 1
          expect(JSON.parse(stdin ?? '{}')).toMatchObject({
            sha: plan.commitSha,
            merge_method: 'merge',
          })
          integrationMerged = true
          remoteHeads.set('develop', integrationMergeHead)
          return result(0, '{}')
        }
        throw new Error(`unexpected implemented-promotion gh command: ${command}`)
      },
    }

    const expectedReceipt = {
      pullRequestNumber: 301,
      pullRequestUrl: 'https://github.com/example/implemented-promotion/pull/301',
      followupPullRequestNumber: 302,
      followupPullRequestUrl: 'https://github.com/example/implemented-promotion/pull/302',
      closedPullRequestNumbers: [857],
    }
    await expect(publishGitHubPlan(plan, commands)).resolves.toMatchObject(expectedReceipt)
    await expect(publishGitHubPlan(plan, commands)).resolves.toMatchObject(expectedReceipt)
    expect({ integrationCreates, integrationMerges, followupCreates }).toEqual({
      integrationCreates: 1,
      integrationMerges: 1,
      followupCreates: 1,
    })
    expect({ obsoleteCloses, obsoleteOpen }).toEqual({ obsoleteCloses: 1, obsoleteOpen: false })
    expect(integrationBody).toBe(`## Summary\nreviewed ${plan.commitSha}`)
    expect(followupBody).toBe(`## Summary\nrelease ${integrationMergeHead}`)
    expect(git(value.repo, 'branch', '--show-current')).toBe(value.unrelatedBranch)
    expect(git(value.repo, 'rev-parse', 'HEAD')).toBe(value.unrelatedHead)
    expect(git(value.repo, 'status', '--porcelain')).toContain('operator-notes.txt')
  })

  test('実装feature refはCodexが選んだintegration baseの子孫でなければならない', () => {
    const value = implementedPromotionFixture('example/implemented-ancestry')
    const unrelatedPublicationBranch = 'zerochan/not-from-develop'
    git(value.repo, 'branch', unrelatedPublicationBranch, value.unrelatedHead)

    expect(() => prepareGitHubPublicationPlans(
      value.baseline,
      ['.'],
      [{ gitRoot: value.repo, head: value.unrelatedHead }],
      unrelatedPublicationBranch,
    )).toThrow('not descended from the prepared base commit')
    expect(git(value.repo, 'branch', '--show-current')).toBe(value.unrelatedBranch)
    expect(git(value.repo, 'rev-parse', 'HEAD')).toBe(value.unrelatedHead)
  })

  test('Codexがchecks待機を選んだPRはcheck登録前のclean表示でもmergeしない', async () => {
    const value = implementedPromotionFixture('example/check-registration-race')
    const plan: GitHubPublicationPlan = {
      ...value.plan,
      promotion: {
        ...value.plan.promotion!,
        waitForChecks: true,
        integrationPullRequestBody: '## Summary\nwait {{COMMIT_SHA}}',
        followupPullRequestBody: '## Summary\nrelease {{COMMIT_SHA}}',
        closePullRequestNumbers: [857],
      },
    }
    const body = `## Summary\nwait ${plan.commitSha}`
    let mergeCalls = 0
    let obsoleteCloseCalls = 0
    let checkRuns: Array<Record<string, unknown>> = []
    const commands: GitHubPublicationCommands = {
      async runGit(_repo, args) {
        if (args[0] !== 'ls-remote') throw new Error(`unexpected Git command: ${args.join(' ')}`)
        const ref = String(args.at(-1))
        if (ref.endsWith(`/${plan.headBranch}`)) return result(0, `${plan.commitSha}\t${ref}\n`)
        if (ref.endsWith('/develop')) return result(0, `${value.developHead}\t${ref}\n`)
        throw new Error(`unexpected remote ref: ${ref}`)
      },
      async runGh(args, stdin) {
        const command = args.join(' ')
        if (args.includes('GET') && command.includes('/pulls?')) {
          return result(0, exactPullRequestJson({ plan, number: 401, body }))
        }
        if (args.includes('GET') && command.endsWith('/pulls/401')) {
          const record = JSON.parse(exactPullRequestJson({ plan, number: 401, body }))[0]
          return result(0, JSON.stringify({
            ...record, draft: false, mergeable: true, mergeable_state: 'clean',
          }))
        }
        if (args.includes('GET') && command.endsWith('/pulls/857')) {
          return result(0, JSON.stringify({
            number: 857,
            html_url: 'https://github.com/example/check-registration-race/pull/857',
            state: 'open',
            merged_at: null,
            head: { repo: { full_name: plan.repositorySlug } },
            base: { repo: { full_name: plan.repositorySlug } },
          }))
        }
        if (args.includes('PATCH') && command.endsWith('/pulls/857 --input -')) {
          expect(JSON.parse(stdin ?? '{}')).toEqual({ state: 'closed' })
          obsoleteCloseCalls += 1
          return result(0, '{}')
        }
        if (args.includes('GET') && command.includes('/check-runs')) {
          return result(0, JSON.stringify({
            total_count: checkRuns.length,
            check_runs: checkRuns,
          }))
        }
        if (args.includes('GET') && command.includes('/status?')) {
          return result(0, JSON.stringify({ statuses: [] }))
        }
        if (args.includes('PUT') && command.includes('/merge')) {
          mergeCalls += 1
          return result(0, '{}')
        }
        throw new Error(`unexpected gh command: ${command}`)
      },
    }
    await expect(publishGitHubPlan(plan, commands)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubPublicationError>>({ category: 'waiting' }),
    )
    checkRuns = [{ name: 'quality', status: 'completed', conclusion: 'failure' }]
    await expect(publishGitHubPlan(plan, commands)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubPublicationError>>({ category: 'checks' }),
    )
    expect(mergeCalls).toBe(0)
    expect(obsoleteCloseCalls).toBe(0)
  })

  test('review済み実装promotionのsource refが別SHAへ動いた場合は公開を拒否する', () => {
    const value = implementedPromotionFixture('example/implemented-ref-drift')
    assertGitHubPublicationPlan(value.plan)
    git(value.repo, 'branch', '-f', value.plan.headBranch, value.unrelatedHead)

    expect(() => assertGitHubPublicationPlan(value.plan)).toThrow(
      'publication plan no longer matches the repository',
    )
    expect(git(value.repo, 'branch', '--show-current')).toBe(value.unrelatedBranch)
    expect(git(value.repo, 'rev-parse', 'HEAD')).toBe(value.unrelatedHead)
  })

  test('remote mutation中のcancelは確定receiptを保存してから停止する', async () => {
    const { repo, plan, baselineDigest } = publicationFixture('example/cancel-boundary')
    const dbPath = join(fixtureDir(), 'jobs.sqlite3')
    const store = new JobStore(dbPath)
    const queued = store.enqueue({
      chatId: 'C0123456789', threadTs: '1900000000.000350',
      messageId: '1900000000.000350', userId: 'U0123456789',
      repoPath: repo, task: '変更を公開して', writeEnabled: true,
    }).job
    const running = store.claimNext('cancel-boundary')!
    const input = readAdvisorInputSnapshot(dirname(dbPath), running.id)
    store.ensureExecutionResultStaged(running.id, 'cancel-boundary-session', '完了しました。', {
      version: 1,
      jobId: running.id,
      jobAttempt: running.attempts,
      logicalNonce: 'e'.repeat(32),
      inputRevision: input.revision,
      inputDigest: input.digest,
      reviewRound: 1,
      reviewedRepositoryDigest: createHash('sha256').update('cancel-boundary').digest('hex'),
      baselineDigest,
      plans: [plan],
    })
    const target = store.liveControlTarget(running.chatId, running.threadTs)!
    let remoteHead: string | null = null
    let pullRequestExists = false
    let pushes = 0
    let creates = 0
    const commands: GitHubPublicationCommands = {
      async runGit(repository, args) {
        if (args[0] === 'ls-remote') {
          const ref = String(args.at(-1))
          if (ref === `refs/heads/${plan.baseBranch}`) {
            return result(0, `${plan.initialHead}\t${ref}\n`)
          }
          return result(0, remoteHead ? `${remoteHead}\t${ref}\n` : '')
        }
        if (args[0] === 'push') {
          pushes += 1
          remoteHead = plan.commitSha
          return result(0)
        }
        return localGitCommand(repository, args)
      },
      async runGh(args) {
        if (args.includes('GET')) {
          return result(0, pullRequestExists ? pullRequestJson(plan, 81) : '[]')
        }
        if (args.includes('POST')) {
          creates += 1
          pullRequestExists = true
          expect(store.stageLiveControl(target, {
            chatId: running.chatId,
            threadTs: running.threadTs,
            messageId: '1900000000.000351',
            userId: running.userId,
            task: 'やめて',
            kind: 'interrupt',
          })).toBe('staged')
          return result(1, '', 'timeout after request', true)
        }
        throw new Error(`unexpected gh command: ${args.join(' ')}`)
      },
    }

    await expect(publishStagedGitHubPublication(store, queued.id, {
      commands,
      retryMsForTesting: 1,
    })).rejects.toMatchObject({ name: 'CodexUserCancelledError' })
    expect({ pushes, creates }).toEqual({ pushes: 1, creates: 1 })
    expect(store.pendingGitHubPublications(queued.id)).toEqual([])
    expect(store.githubPublicationReceipts(queued.id)).toEqual([
      expect.objectContaining({ pullRequestNumber: 81 }),
    ])
    store.close()
  })

  test('promotion中のcancelはsubstep receiptを保存し次のremote mutation前に停止する', async () => {
    const repo = join(fixtureDir(), 'promotion-cancel')
    mkdirSync(repo)
    git(repo, 'init', '--initial-branch=main')
    git(repo, 'config', 'user.email', 'zero@example.invalid')
    git(repo, 'config', 'user.name', 'Zero Test')
    git(repo, 'config', 'remote.origin.url', 'https://github.com/example/promotion-cancel.git')
    writeFileSync(join(repo, 'README.md'), 'initial\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-m', 'chore: initial')
    git(repo, 'switch', '-c', 'feature/reviewed')
    writeFileSync(join(repo, 'README.md'), 'reviewed\n')
    git(repo, 'commit', '-am', 'feat: reviewed')
    const sourceHead = git(repo, 'rev-parse', 'HEAD')
    const baseline = captureGitHubPublicationBaseline(repo, [repo])
    const initial = baseline.repositories[0]!
    const developInitial = 'a'.repeat(40)
    const mainInitial = 'b'.repeat(40)
    const headBranch = 'zerochan/cancel0123456789'
    const plan: GitHubPublicationPlan = {
      version: 1,
      gitRoot: initial.gitRoot,
      repositorySlug: initial.remote.slug,
      canonicalUrl: initial.remote.canonicalUrl,
      baseBranch: 'develop',
      headBranch,
      commitSha: sourceHead,
      initialHead: developInitial,
      statusDigest: initial.statusDigest,
      localConfigDigest: initial.localConfigDigest,
      originUrlDigest: initial.originUrlDigest,
      title: 'feat: reviewed',
      promotion: {
        version: 1,
        sourceBranch: 'feature/reviewed',
        sourceHead,
        followupBaseBranch: 'main',
        followupInitialHead: mainInitial,
      },
    }
    const dbPath = join(fixtureDir(), 'jobs.sqlite3')
    let store = new JobStore(dbPath)
    const queued = store.enqueue({
      chatId: 'C0123456789', threadTs: '1900000000.000450',
      messageId: '1900000000.000450', userId: 'U0123456789',
      repoPath: repo, task: 'developへ適用しdevelopからmainへのPRを作って', writeEnabled: true,
    }).job
    const running = store.claimNext('promotion-cancel-boundary')!
    const input = readAdvisorInputSnapshot(dirname(dbPath), running.id)
    store.ensureExecutionResultStaged(running.id, 'promotion-cancel-session', '公開します。', {
      version: 1,
      jobId: running.id,
      jobAttempt: running.attempts,
      logicalNonce: 'f'.repeat(32),
      inputRevision: input.revision,
      inputDigest: input.digest,
      reviewRound: 1,
      reviewedRepositoryDigest: createHash('sha256').update('promotion-cancel').digest('hex'),
      baselineDigest: gitHubPublicationBaselineDigest(baseline),
      plans: [plan],
    })
    const target = store.liveControlTarget(running.chatId, running.threadTs)!
    let remoteHead: string | null = null
    let integrationExists = false
    let pushes = 0
    let integrationCreates = 0
    let mergeAttempts = 0
    let followupCreates = 0
    const commands: GitHubPublicationCommands = {
      async runGit(_repository, args) {
        if (args[0] === 'ls-remote') {
          const ref = String(args.at(-1))
          if (ref === 'refs/heads/develop') return result(0, `${developInitial}\t${ref}\n`)
          if (ref === 'refs/heads/main') return result(0, `${mainInitial}\t${ref}\n`)
          return result(0, remoteHead ? `${remoteHead}\t${ref}\n` : '')
        }
        if (args[0] === 'push') {
          pushes += 1
          remoteHead = sourceHead
          return result(1, '', 'connection reset after request', true)
        }
        throw new Error(`unexpected git command: ${args.join(' ')}`)
      },
      async runGh(args, stdin) {
        const command = args.join(' ')
        if (command.includes('/compare/')) {
          const prepared = /\/compare\/([0-9a-f]+)\.\.\./.exec(command)?.[1]
          return result(0, JSON.stringify({
            status: 'ahead', ahead_by: 1, behind_by: 0,
            base_commit: { sha: prepared }, merge_base_commit: { sha: prepared },
          }))
        }
        if (args.includes('GET') && command.includes('/pulls?')) {
          return result(0, integrationExists ? pullRequestJson(plan, 91) : '[]')
        }
        if (args.includes('POST') && command.includes('/pulls')) {
          const request = JSON.parse(stdin ?? '{}') as Record<string, string>
          if (request.base === 'develop') {
            integrationCreates += 1
            integrationExists = true
            expect(store.stageLiveControl(target, {
              chatId: running.chatId,
              threadTs: running.threadTs,
              messageId: '1900000000.000451',
              userId: running.userId,
              task: 'やめて',
              kind: 'interrupt',
            })).toBe('staged')
            return result(1, '', 'timeout after request', true)
          }
          followupCreates += 1
          return result(0)
        }
        if (args.includes('PUT') && command.includes('/merge')) {
          mergeAttempts += 1
          return result(0)
        }
        throw new Error(`unexpected gh command: ${command}`)
      },
    }

    await expect(publishStagedGitHubPublication(store, queued.id, {
      commands,
      retryMsForTesting: 1,
    })).rejects.toMatchObject({ name: 'CodexUserCancelledError' })
    expect({ pushes, integrationCreates, mergeAttempts, followupCreates }).toEqual({
      pushes: 1,
      integrationCreates: 1,
      mergeAttempts: 0,
      followupCreates: 0,
    })
    expect(store.githubPromotionCheckpoint(queued.id, plan)).toEqual({
      version: 1,
      kind: 'integration-pr',
      pullRequestNumber: 91,
      pullRequestUrl: 'https://github.com/example/promotion-cancel/pull/91',
    })
    expect(store.pendingGitHubPublications(queued.id)).toHaveLength(1)
    store.close()
    store = new JobStore(dbPath)
    expect(store.githubPromotionCheckpoint(queued.id, plan)?.kind).toBe('integration-pr')
    store.close()
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
          expect(args).toContain('--no-verify')
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

  test('base ancestry APIの通信失敗を競合へ誤分類しない', async () => {
    const { plan } = publicationFixture('example/compare-network')
    const remoteBase = 'd'.repeat(40)
    const commands: GitHubPublicationCommands = {
      async runGit(_repository, args) {
        const ref = String(args.at(-1))
        if (ref === `refs/heads/${plan.baseBranch}`) {
          return result(0, `${remoteBase}\t${ref}\n`)
        }
        return result(0, `${plan.commitSha}\t${ref}\n`)
      },
      async runGh(args) {
        const command = args.join(' ')
        if (command.includes('/pulls?')) return result(0, '[]')
        if (command.includes('/compare/')) {
          return result(1, '', 'network is unreachable', true)
        }
        throw new Error(`unexpected gh command: ${command}`)
      },
    }
    await expect(publishGitHubPlan(plan, commands)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubPublicationError>>({ category: 'network' }),
    )
  })

  test('merge queue必須repositoryはauto queueへ登録して待機する', async () => {
    const { plan: ordinary } = publicationFixture('example/merge-queue')
    const plan: GitHubPublicationPlan = {
      ...ordinary,
      baseBranch: 'develop',
      initialHead: 'a'.repeat(40),
      promotion: {
        version: 1,
        sourceBranch: 'feature/reviewed',
        sourceHead: ordinary.commitSha,
        followupBaseBranch: 'main',
        followupInitialHead: 'b'.repeat(40),
      },
    }
    let queueEnrollments = 0
    const integrationRecord = JSON.parse(exactPullRequestJson({
      plan,
      number: 91,
    }))[0] as Record<string, unknown>
    const commands: GitHubPublicationCommands = {
      async runGit(_repository, args) {
        const ref = String(args.at(-1))
        const sha = ref === `refs/heads/${plan.baseBranch}`
          ? plan.initialHead
          : plan.commitSha
        return result(0, `${sha}\t${ref}\n`)
      },
      async runGh(args) {
        const command = args.join(' ')
        if (command.includes('/pulls?')) {
          return result(0, JSON.stringify([integrationRecord]))
        }
        if (args.includes('GET') && command.endsWith('/pulls/91')) {
          return result(0, JSON.stringify({
            ...integrationRecord,
            draft: false,
            mergeable: true,
            mergeable_state: 'clean',
          }))
        }
        if (args.includes('GET') && command.endsWith('repos/example/merge-queue')) {
          return result(0, JSON.stringify({
            allow_merge_commit: true,
            allow_squash_merge: true,
            allow_rebase_merge: true,
          }))
        }
        if (args.includes('PUT') && command.includes('/pulls/91/merge')) {
          return result(1, '', 'base branch requires all merges through the merge queue')
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          queueEnrollments += 1
          expect(args).toContain('--auto')
          expect(args).toContain('--match-head-commit')
          return result(0, 'queued')
        }
        throw new Error(`unexpected gh command: ${command}`)
      },
    }
    await expect(publishGitHubPlan(plan, commands)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubPublicationError>>({ category: 'waiting' }),
    )
    expect(queueEnrollments).toBe(1)
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
