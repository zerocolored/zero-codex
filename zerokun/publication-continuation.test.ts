import { describe, expect, test } from 'bun:test'
import type { GitHubPublicationPlan } from './github-publication.ts'
import {
  parseCodexThreadContinuationDecision,
  publicationContinuationDigest,
  type GitHubPublicationContinuationBundle,
  type GitHubPublicationContinuationEntry,
} from './publication-continuation.ts'

const digest = (value: string): string => publicationContinuationDigest(value)

function entry(repositorySlug: string, pullRequestNumber: number): GitHubPublicationContinuationEntry {
  const name = repositorySlug.split('/')[1]!
  const commitSha = pullRequestNumber.toString(16).padStart(40, '0')
  const plan: GitHubPublicationPlan = {
    version: 1,
    gitRoot: `/retired/${name}`,
    repositorySlug,
    canonicalUrl: `https://github.com/${repositorySlug}.git`,
    baseBranch: 'develop',
    headBranch: `zerochan/${name}`,
    commitSha,
    initialHead: 'a'.repeat(40),
    statusDigest: digest(`status:${name}`),
    localConfigDigest: digest(`config:${name}`),
    originUrlDigest: digest(`origin:${name}`),
    title: `feat: ${name}`,
  }
  return {
    plan,
    receipt: {
      repositorySlug,
      baseBranch: plan.baseBranch,
      headBranch: plan.headBranch,
      commitSha,
      pullRequestNumber,
      pullRequestUrl: `https://github.com/${repositorySlug}/pull/${pullRequestNumber}`,
    },
  }
}

function fixture(): {
  bundle: GitHubPublicationContinuationBundle
  bundleDigest: string
  candidateDigest: string
} {
  const archive = {
    version: 1 as const,
    sourceJobId: 'source-job',
    sourceJobSeq: 41,
    chatId: 'C0123456789',
    threadTs: '1900000000.000001',
    repoPath: '/workspace/bsb',
    publicationCompletedAt: 1_900_000_000_000,
    inputDigest: digest('input'),
    reviewRound: 1 as const,
    reviewedRepositoryDigest: digest('reviewed'),
    baselineDigest: digest('baseline'),
    entries: [
      entry('example/bsb_back', 862),
      entry('example/bsb_front', 861),
    ],
  }
  const candidateDigest = digest(JSON.stringify(archive))
  const bundle: GitHubPublicationContinuationBundle = {
    version: 1,
    targetJobId: 'target-job',
    targetJobSeq: 42,
    chatId: archive.chatId,
    threadTs: archive.threadTs,
    repoPath: archive.repoPath,
    boundAt: 1_900_000_001_000,
    omittedCandidateCount: 0,
    candidates: [{ archiveDigest: candidateDigest, archive }],
  }
  return { bundle, bundleDigest: digest(JSON.stringify(bundle)), candidateDigest }
}

function decision(input: {
  targets: unknown[]
  candidateDigest: string
  bundleDigest: string
}): string {
  return [
    '<zerokun_thread_continuation>' + JSON.stringify({
      version: 1,
      logicalNonce: '1'.repeat(32),
      inputRevision: 3,
      inputDigest: digest('current-input'),
      bundleDigest: input.bundleDigest,
      action: 'continue-publication',
      candidateDigest: input.candidateDigest,
      targets: input.targets,
    }) + '</zerokun_thread_continuation>',
    '指定されたフロントエンドのPRだけをdevelopへ統合します。',
  ].join('\n')
}

const frontTarget = {
  repositorySlug: 'example/bsb_front',
  followupBaseBranch: 'main',
  waitForChecks: true,
  integrationPullRequestBody: 'Reviewed integration.',
  followupPullRequestBody: 'Reviewed release.',
  closePullRequestNumbers: [],
}

describe('durable publication continuation decision', () => {
  test('multi-repo checkpointからユーザーが指定したrepositoryだけを継続できる', () => {
    const value = fixture()
    expect(parseCodexThreadContinuationDecision({
      value: decision({
        targets: [frontTarget],
        candidateDigest: value.candidateDigest,
        bundleDigest: value.bundleDigest,
      }),
      logicalNonce: '1'.repeat(32),
      inputRevision: 3,
      inputDigest: digest('current-input'),
      bundle: value.bundle,
      bundleDigest: value.bundleDigest,
    })).toMatchObject({
      action: 'continue-publication',
      targets: [{ repositorySlug: 'example/bsb_front' }],
    })
  })

  test('空・重複・checkpoint外repositoryは継続対象にできない', () => {
    const value = fixture()
    const parse = (targets: unknown[]) => parseCodexThreadContinuationDecision({
      value: decision({
        targets,
        candidateDigest: value.candidateDigest,
        bundleDigest: value.bundleDigest,
      }),
      logicalNonce: '1'.repeat(32),
      inputRevision: 3,
      inputDigest: digest('current-input'),
      bundle: value.bundle,
      bundleDigest: value.bundleDigest,
    })
    expect(() => parse([])).toThrow('target repositories changed')
    expect(() => parse([frontTarget, frontTarget])).toThrow('target repositories changed')
    expect(() => parse([{ ...frontTarget, repositorySlug: 'example/other' }]))
      .toThrow('target repositories changed')
  })
})
