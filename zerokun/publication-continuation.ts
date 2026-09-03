import { createHash } from 'crypto'
import type {
  GitHubPublicationPlan,
  GitHubPublicationReceipt,
} from './github-publication.ts'

export const PUBLICATION_CONTINUATION_VERSION = 1 as const
export const MAX_PUBLICATION_CONTINUATION_ARCHIVES_PER_SCOPE = 64 as const
export const MAX_PUBLICATION_CONTINUATION_CANDIDATES = 8 as const
export const MAX_PUBLICATION_CONTINUATION_ARCHIVE_BYTES = 1024 * 1024
export const MAX_PUBLICATION_CONTINUATION_BUNDLE_BYTES = 4 * 1024 * 1024

export type GitHubPublicationContinuationEntry = {
  plan: GitHubPublicationPlan
  receipt: GitHubPublicationReceipt
}

export type GitHubPublicationContinuationArchive = {
  version: 1
  sourceJobId: string
  sourceJobSeq: number
  chatId: string
  threadTs: string
  repoPath: string
  publicationCompletedAt: number
  inputDigest: string
  reviewRound: 1 | 2 | 3
  reviewedRepositoryDigest: string
  baselineDigest: string
  entries: GitHubPublicationContinuationEntry[]
}

export type GitHubPublicationContinuationCandidate = {
  archiveDigest: string
  archive: GitHubPublicationContinuationArchive
}

export type GitHubPublicationContinuationBundle = {
  version: 1
  targetJobId: string
  targetJobSeq: number
  chatId: string
  threadTs: string
  repoPath: string
  boundAt: number
  omittedCandidateCount: number
  candidates: GitHubPublicationContinuationCandidate[]
}

export type GitHubPublicationContinuationTarget = {
  repositorySlug: string
  /** Null merges the selected archived PR without opening another PR. */
  followupBaseBranch: string | null
  waitForChecks: boolean
  integrationPullRequestBody: string
  followupPullRequestBody: string
  closePullRequestNumbers: number[]
}

export type CodexThreadContinuationDecision =
  | { action: 'new-work'; body: string }
  | { action: 'answer-only'; body: string }
  | {
      action: 'continue-publication'
      candidate: GitHubPublicationContinuationCandidate
      targets: GitHubPublicationContinuationTarget[]
      body: string
    }

const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const MAX_PULL_REQUEST_BODY_BYTES = 60_000
const MAX_CLOSE_PULL_REQUESTS = 32

export function publicationContinuationDigest(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex')
}

function assertSafeText(value: unknown, label: string, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || !value || /\0/.test(value)
    || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`publication continuation ${label} is invalid`)
  }
}

function assertSafeIdentifier(value: unknown, label: string): asserts value is string {
  assertSafeText(value, label, 4_096)
  if (/[\r\n]/.test(value)) throw new Error(`publication continuation ${label} is invalid`)
}

function assertReceiptMatchesPlan(
  plan: GitHubPublicationPlan,
  receipt: GitHubPublicationReceipt,
): void {
  const expectedUrl = Number.isSafeInteger(receipt.pullRequestNumber)
    && receipt.pullRequestNumber > 0
    ? `https://github.com/${plan.repositorySlug}/pull/${receipt.pullRequestNumber}`
    : null
  if (plan.promotion || receipt.repositorySlug !== plan.repositorySlug
    || receipt.baseBranch !== plan.baseBranch || receipt.headBranch !== plan.headBranch
    || receipt.commitSha !== plan.commitSha || expectedUrl === null
    || receipt.pullRequestUrl.toLowerCase() !== expectedUrl.toLowerCase()
    || receipt.followupPullRequestNumber !== undefined
    || receipt.followupPullRequestUrl !== undefined) {
    throw new Error('publication continuation receipt does not match its ordinary plan')
  }
}

/**
 * Validate the archive wrapper without touching Git or the network. The caller
 * separately validates the embedded plan with its existing durable-plan
 * validator so migrations and cold starts do not depend on checkout state.
 */
export function assertPublicationContinuationArchive(
  value: unknown,
  expected?: {
    sourceJobId?: string
    sourceJobSeq?: number
    chatId?: string
    threadTs?: string
    repoPath?: string
  },
): asserts value is GitHubPublicationContinuationArchive {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('publication continuation archive is invalid')
  }
  const archive = value as GitHubPublicationContinuationArchive
  if (archive.version !== PUBLICATION_CONTINUATION_VERSION
    || !Number.isSafeInteger(archive.sourceJobSeq) || archive.sourceJobSeq < 1
    || !Number.isSafeInteger(archive.publicationCompletedAt)
    || archive.publicationCompletedAt <= 0
    || !DIGEST_PATTERN.test(archive.inputDigest)
    || ![1, 2, 3].includes(archive.reviewRound)
    || !DIGEST_PATTERN.test(archive.reviewedRepositoryDigest)
    || !DIGEST_PATTERN.test(archive.baselineDigest)
    || !Array.isArray(archive.entries) || archive.entries.length < 1
    || archive.entries.length > 128) {
    throw new Error('publication continuation archive fields are invalid')
  }
  assertSafeIdentifier(archive.sourceJobId, 'source job id')
  assertSafeIdentifier(archive.chatId, 'chat id')
  assertSafeIdentifier(archive.threadTs, 'thread timestamp')
  assertSafeText(archive.repoPath, 'repository path', 32 * 1024)
  if ((expected?.sourceJobId !== undefined && archive.sourceJobId !== expected.sourceJobId)
    || (expected?.sourceJobSeq !== undefined && archive.sourceJobSeq !== expected.sourceJobSeq)
    || (expected?.chatId !== undefined && archive.chatId !== expected.chatId)
    || (expected?.threadTs !== undefined && archive.threadTs !== expected.threadTs)
    || (expected?.repoPath !== undefined && archive.repoPath !== expected.repoPath)) {
    throw new Error('publication continuation archive scope changed')
  }
  const repositories = new Set<string>()
  for (const entry of archive.entries) {
    if (!entry || typeof entry !== 'object' || !entry.plan || !entry.receipt
      || entry.plan.version !== 1 || !REPOSITORY_PATTERN.test(entry.plan.repositorySlug)
      || !SHA_PATTERN.test(entry.plan.commitSha)) {
      throw new Error('publication continuation entry is invalid')
    }
    const repository = entry.plan.repositorySlug.toLowerCase()
    if (repositories.has(repository)) {
      throw new Error('publication continuation repositories are not unique')
    }
    repositories.add(repository)
    assertReceiptMatchesPlan(entry.plan, entry.receipt)
  }
}

export function assertPublicationContinuationBundle(
  value: unknown,
  expected?: {
    targetJobId?: string
    targetJobSeq?: number
    chatId?: string
    threadTs?: string
    repoPath?: string
  },
): asserts value is GitHubPublicationContinuationBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('publication continuation bundle is invalid')
  }
  const bundle = value as GitHubPublicationContinuationBundle
  if (bundle.version !== PUBLICATION_CONTINUATION_VERSION
    || !Number.isSafeInteger(bundle.targetJobSeq) || bundle.targetJobSeq < 1
    || !Number.isSafeInteger(bundle.boundAt) || bundle.boundAt <= 0
    || !Number.isSafeInteger(bundle.omittedCandidateCount)
    || bundle.omittedCandidateCount < 0
    || !Array.isArray(bundle.candidates)
    || bundle.candidates.length > MAX_PUBLICATION_CONTINUATION_CANDIDATES) {
    throw new Error('publication continuation bundle fields are invalid')
  }
  assertSafeIdentifier(bundle.targetJobId, 'target job id')
  assertSafeIdentifier(bundle.chatId, 'bundle chat id')
  assertSafeIdentifier(bundle.threadTs, 'bundle thread timestamp')
  assertSafeText(bundle.repoPath, 'bundle repository path', 32 * 1024)
  if ((expected?.targetJobId !== undefined && bundle.targetJobId !== expected.targetJobId)
    || (expected?.targetJobSeq !== undefined && bundle.targetJobSeq !== expected.targetJobSeq)
    || (expected?.chatId !== undefined && bundle.chatId !== expected.chatId)
    || (expected?.threadTs !== undefined && bundle.threadTs !== expected.threadTs)
    || (expected?.repoPath !== undefined && bundle.repoPath !== expected.repoPath)) {
    throw new Error('publication continuation bundle scope changed')
  }
  const digests = new Set<string>()
  let previousSeq = Number.POSITIVE_INFINITY
  for (const candidate of bundle.candidates) {
    if (!candidate || typeof candidate !== 'object'
      || !DIGEST_PATTERN.test(candidate.archiveDigest)
      || digests.has(candidate.archiveDigest)) {
      throw new Error('publication continuation candidate is invalid')
    }
    const serialized = JSON.stringify(candidate.archive)
    if (Buffer.byteLength(serialized) > MAX_PUBLICATION_CONTINUATION_ARCHIVE_BYTES
      || publicationContinuationDigest(serialized) !== candidate.archiveDigest) {
      throw new Error('publication continuation candidate digest changed')
    }
    assertPublicationContinuationArchive(candidate.archive, {
      chatId: bundle.chatId,
      threadTs: bundle.threadTs,
      repoPath: bundle.repoPath,
    })
    if (candidate.archive.sourceJobSeq >= bundle.targetJobSeq
      || candidate.archive.sourceJobSeq >= previousSeq) {
      throw new Error('publication continuation candidates are out of order')
    }
    previousSeq = candidate.archive.sourceJobSeq
    digests.add(candidate.archiveDigest)
  }
}

function parseTarget(value: unknown): GitHubPublicationContinuationTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Codex continuation target is invalid')
  }
  const target = value as Record<string, unknown>
  if (Object.keys(target).sort().join('\n') !== [
    'closePullRequestNumbers',
    'followupBaseBranch',
    'followupPullRequestBody',
    'integrationPullRequestBody',
    'repositorySlug',
    'waitForChecks',
  ].join('\n')
    || typeof target.repositorySlug !== 'string'
    || !REPOSITORY_PATTERN.test(target.repositorySlug)
    || !((target.followupBaseBranch === null)
      || (typeof target.followupBaseBranch === 'string'
        && Boolean(target.followupBaseBranch.trim())
        && Buffer.byteLength(target.followupBaseBranch) <= 255
        && !/[\0\r\n]/.test(target.followupBaseBranch)))
    || typeof target.waitForChecks !== 'boolean'
    || typeof target.integrationPullRequestBody !== 'string'
    || !target.integrationPullRequestBody.trim()
    || Buffer.byteLength(target.integrationPullRequestBody) > MAX_PULL_REQUEST_BODY_BYTES
    || /\0/.test(target.integrationPullRequestBody)
    || typeof target.followupPullRequestBody !== 'string'
    || !target.followupPullRequestBody.trim()
    || Buffer.byteLength(target.followupPullRequestBody) > MAX_PULL_REQUEST_BODY_BYTES
    || /\0/.test(target.followupPullRequestBody)
    || !Array.isArray(target.closePullRequestNumbers)
    || target.closePullRequestNumbers.length > MAX_CLOSE_PULL_REQUESTS
    || target.closePullRequestNumbers.some(number => (
      !Number.isSafeInteger(number) || Number(number) <= 0
    ))) {
    throw new Error('Codex continuation target fields are invalid')
  }
  const closePullRequestNumbers = target.closePullRequestNumbers as number[]
  if (new Set(closePullRequestNumbers).size !== closePullRequestNumbers.length
    || JSON.stringify(closePullRequestNumbers)
      !== JSON.stringify([...closePullRequestNumbers].sort((a, b) => a - b))) {
    throw new Error('Codex continuation PR selections are invalid')
  }
  return target as GitHubPublicationContinuationTarget
}

export function parseCodexThreadContinuationDecision(input: {
  value: string
  logicalNonce: string
  inputRevision: number
  inputDigest: string
  bundle: GitHubPublicationContinuationBundle
  bundleDigest: string
}): CodexThreadContinuationDecision {
  const normalized = input.value.replace(/\r\n/g, '\n').trim()
  const [first, ...rest] = normalized.split('\n')
  const body = rest.join('\n').trim()
  const match = /^<zerokun_thread_continuation>([^\n]+)<\/zerokun_thread_continuation>$/.exec(first ?? '')
  if (!match || !body || !/^[0-9a-f]{32}$/.test(input.logicalNonce)
    || !DIGEST_PATTERN.test(input.inputDigest)
    || !DIGEST_PATTERN.test(input.bundleDigest)) {
    throw new Error('Codex continuation decision envelope is invalid')
  }
  let parsed: unknown
  try { parsed = JSON.parse(match[1]!) } catch {
    throw new Error('Codex continuation decision is invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codex continuation decision is invalid')
  }
  const decision = parsed as Record<string, unknown>
  if (Object.keys(decision).sort().join('\n') !== [
    'action', 'bundleDigest', 'candidateDigest', 'inputDigest',
    'inputRevision', 'logicalNonce', 'targets', 'version',
  ].sort().join('\n')
    || decision.version !== 1
    || decision.logicalNonce !== input.logicalNonce
    || decision.inputRevision !== input.inputRevision
    || decision.inputDigest !== input.inputDigest
    || decision.bundleDigest !== input.bundleDigest
    || !Array.isArray(decision.targets)) {
    throw new Error('Codex continuation decision binding changed')
  }
  if (decision.action === 'new-work' || decision.action === 'answer-only') {
    if (decision.candidateDigest !== null || decision.targets.length !== 0) {
      throw new Error('Codex continuation non-publication decision has unexpected targets')
    }
    return { action: decision.action, body }
  }
  if (decision.action !== 'continue-publication'
    || typeof decision.candidateDigest !== 'string') {
    throw new Error('Codex continuation action is invalid')
  }
  const candidate = input.bundle.candidates.find(value => (
    value.archiveDigest === decision.candidateDigest
  ))
  if (!candidate) throw new Error('Codex continuation selected an unavailable checkpoint')
  const targets = decision.targets.map(parseTarget)
  const targetRepositories = targets.map(target => target.repositorySlug.toLowerCase())
  const sortedRepositories = [...targetRepositories]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  if (targets.length === 0
    || JSON.stringify(targetRepositories) !== JSON.stringify(sortedRepositories)
    || new Set(targetRepositories).size !== targets.length
    || targets.some(target => !candidate.archive.entries.some(entry => (
      entry.plan.repositorySlug.toLowerCase() === target.repositorySlug.toLowerCase()
    )))) {
    throw new Error('Codex continuation target repositories changed')
  }
  for (const target of targets) {
    const entry = candidate.archive.entries.find(value => (
      value.plan.repositorySlug.toLowerCase() === target.repositorySlug.toLowerCase()
    ))!
    if (target.followupBaseBranch !== null
      && (target.followupBaseBranch === entry.plan.baseBranch
        || target.followupBaseBranch === entry.plan.headBranch)) {
      throw new Error('Codex continuation follow-up branch conflicts')
    }
  }
  return { action: 'continue-publication', candidate, targets, body }
}
