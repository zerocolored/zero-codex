import { describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import {
  validLegacyAdoptedClaude,
  validLegacyAdoptedGrok,
  validTerminalClaudeAttempt,
  validTerminalGrokAttempts,
  validTerminalNativeAttempts,
  validThreeAdvisorGrokAttempts,
  validThreeAdvisorNativeAttempts,
  validThreeAdvisorPhaseRound,
  validThreeAdvisorReviewSequence,
  validThreeAdvisorRoundTwoBasis,
  threeAdvisorRepositoryDeltaDigest,
  threeAdvisorTaskOwnedFixPathsDigest,
} from './advisor-journal.ts'

const digest = (character: string) => character.repeat(64)

describe('best-effort external advisor journal', () => {
  test('version 9は初期1回と最終review最大2回だけを許可する', () => {
    expect(validThreeAdvisorPhaseRound('investigation', 1)).toBe(true)
    expect(validThreeAdvisorPhaseRound('review', 1)).toBe(true)
    expect(validThreeAdvisorPhaseRound('review', 2)).toBe(true)
    expect(validThreeAdvisorPhaseRound('investigation', 2)).toBe(false)
    expect(validThreeAdvisorPhaseRound('design', 1)).toBe(false)
    expect(validThreeAdvisorPhaseRound('review', 3)).toBe(false)
  })

  test('最終review round 2のbindingは採択sourceとhost確認済みrepository deltaを要求する', () => {
    const basis = {
      reviewOneJournalDigest: digest('a'),
      roundOneSources: ['native', 'claude'],
      roundOneResponseDigests: { native: digest('b'), claude: digest('c') },
      mandatoryFindingDigest: digest('d'),
      repositoryBaselineDigest: digest('f'),
      repositoryCurrentDigest: digest('0'),
      changedRepositoryCount: 1,
      taskOwnedFixDeltaDigest: threeAdvisorRepositoryDeltaDigest(
        digest('f'), digest('0'), 1,
      ),
      taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
      taskOwnedFixPathCount: 1,
      taskOwnedFixPathsDigest: threeAdvisorTaskOwnedFixPathsDigest([
        { repository: '.', path: 'round-two-fix.ts' },
      ]),
    }
    expect(validThreeAdvisorRoundTwoBasis(basis)).toBe(true)
    expect(validThreeAdvisorRoundTwoBasis({ ...basis, roundOneSources: [] })).toBe(false)
    expect(validThreeAdvisorRoundTwoBasis({
      ...basis, roundOneSources: ['native', 'native'],
    })).toBe(false)
    expect(validThreeAdvisorRoundTwoBasis({
      ...basis, roundOneResponseDigests: { native: digest('b') },
    })).toBe(false)
    expect(validThreeAdvisorRoundTwoBasis({
      ...basis, taskOwnedFixDeltaDigest: 'not-a-digest',
    })).toBe(false)
    expect(validThreeAdvisorRoundTwoBasis({
      ...basis, repositoryCurrentDigest: basis.repositoryBaselineDigest,
    })).toBe(false)
    expect(validThreeAdvisorRoundTwoBasis({
      ...basis, changedRepositoryCount: 0,
    })).toBe(false)
    expect(validThreeAdvisorRoundTwoBasis({
      ...basis, taskOwnedFixPaths: [{ repository: '.', path: 'another-task.ts' }],
    })).toBe(false)
    expect(validThreeAdvisorRoundTwoBasis({
      ...basis, taskOwnedFixPathCount: 2,
    })).toBe(false)
    expect(validThreeAdvisorRoundTwoBasis({
      ...basis,
      changedRepositoryCount: 2,
      taskOwnedFixDeltaDigest: threeAdvisorRepositoryDeltaDigest(
        basis.repositoryBaselineDigest, basis.repositoryCurrentDigest, 2,
      ),
    })).toBe(false)
    expect(threeAdvisorTaskOwnedFixPathsDigest([
      { repository: 'backend', path: 'z.ts' },
      { repository: 'backend', path: 'a.ts' },
    ])).toBeNull()
    expect(threeAdvisorTaskOwnedFixPathsDigest([
      { repository: '.', path: 'same.ts' },
      { repository: '.', path: 'same.ts' },
    ])).toBeNull()
  })

  test('条件付きreview第2回はcurrent-policy第1回の採択結果とfresh枠へ結合する', () => {
    const unavailableClaude = {
      attempted: true, required: true, lifecycle: 'ephemeral-v2', adopted: false,
      executionState: 'unavailable-before-start', workspaceCreationAttempted: false,
      freshEphemeral: false, cleanupVerified: false, containmentVerified: true,
      promptMayHaveBeenDelivered: false, reasonDigest: digest('7'),
    }
    const journal = (round: 1 | 2, agentId: string, startedAt: number) => ({
      version: 9,
      advisorPolicy: 'three-phase-specific-conditional-final-v2',
      status: 'completed',
      phase: 'review',
      round,
      attemptNonce: 'f'.repeat(32),
      contextDigest: digest('9'),
      inputRevision: round,
      inputDigest: round === 1 ? digest('1') : digest('2'),
      repositoryDigest: round === 1 ? digest('3') : digest('4'),
      repositoryDigestBefore: round === 1 ? digest('3') : digest('4'),
      repositoryDigestAfter: round === 1 ? digest('3') : digest('4'),
      ...(round === 1 ? { repositoryDeltaBaselineDigest: digest('d') } : {}),
      ...(round === 2 ? {
        repositoryDeltaCurrentDigest: digest('e'),
        repositoryDeltaCurrentDigestAfter: digest('e'),
      } : {}),
      brokerProcessId: 100 + round,
      primaryEvidenceDigest: digest('5'),
      startedAt,
      finishedAt: startedAt + 1,
      receiptIssuedAt: startedAt + 2,
      pollObservedAt: startedAt + 3,
      receiptDigest: digest('6'),
      native: [{
        attempted: true, adopted: true, perspective: 'risk', agentId,
        responseDigest: digest('a'), responseTransportDigest: digest('b'),
        executionState: 'response-obtained',
      }],
      grok: [{
        attempted: true, adopted: false, perspective: 'risk', containmentVerified: true,
        reasonDigest: digest('c'), executionState: 'unavailable-before-start',
      }],
      claude: unavailableClaude,
    })
    const reviewOne = journal(1, '/root/review-one', 10)
    const basis = {
      reviewOneJournalDigest: createHash('sha256')
        .update(JSON.stringify(reviewOne)).digest('hex'),
      mandatoryFindingDigest: digest('d'),
      repositoryBaselineDigest: digest('d'),
      repositoryCurrentDigest: digest('e'),
      changedRepositoryCount: 1,
      taskOwnedFixDeltaDigest: threeAdvisorRepositoryDeltaDigest(
        digest('d'), digest('e'), 1,
      ),
      taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
      taskOwnedFixPathCount: 1,
      taskOwnedFixPathsDigest: threeAdvisorTaskOwnedFixPathsDigest([
        { repository: '.', path: 'round-two-fix.ts' },
      ]),
      roundOneSources: ['native'],
      roundOneResponseDigests: { native: digest('a') },
    }
    const reviewTwo = { ...journal(2, '/root/review-two', 20), roundTwoBasis: basis }
    expect(validThreeAdvisorReviewSequence(reviewOne, reviewTwo)).toBe(true)
    expect(validThreeAdvisorReviewSequence(
      { ...reviewOne, version: 8, advisorPolicy: undefined }, reviewTwo,
    )).toBe(false)
    expect(validThreeAdvisorReviewSequence(reviewOne, {
      ...reviewTwo, roundTwoBasis: { ...basis, reviewOneJournalDigest: digest('0') },
    })).toBe(false)
    expect(validThreeAdvisorReviewSequence(reviewOne, {
      ...reviewTwo, native: [{ ...reviewTwo.native[0], agentId: '/root/review-one' }],
    })).toBe(false)
    expect(validThreeAdvisorReviewSequence(reviewOne, {
      ...reviewTwo, startedAt: reviewOne.finishedAt - 1,
    })).toBe(false)
    expect(validThreeAdvisorReviewSequence(reviewOne, {
      ...reviewTwo, repositoryDeltaCurrentDigestAfter: digest('0'),
    })).toBe(false)
  })

  test('version 9契約はphase別native 1枠とGrok 1枠だけを受理する', () => {
    const native = {
      attempted: true,
      adopted: true,
      perspective: 'solution',
      agentId: 'solution-agent',
      responseDigest: digest('a'),
      responseTransportDigest: digest('b'),
      executionState: 'response-obtained',
    }
    const grok = {
      attempted: true,
      adopted: true,
      perspective: 'solution',
      containmentVerified: true,
      processId: 101,
      responseDigest: digest('c'),
      executionState: 'response-obtained',
    }
    expect(validThreeAdvisorNativeAttempts([native], 'investigation')).toBe(true)
    expect(validThreeAdvisorGrokAttempts([grok], 'investigation')).toBe(true)
    expect(validThreeAdvisorNativeAttempts([native], 'review')).toBe(false)
    expect(validThreeAdvisorGrokAttempts([grok], 'review')).toBe(false)
    expect(validThreeAdvisorNativeAttempts([
      native,
      { ...native, perspective: 'risk', agentId: 'risk-agent' },
    ], 'investigation')).toBe(false)
    expect(validThreeAdvisorGrokAttempts([
      grok,
      { ...grok, perspective: 'risk', processId: 102 },
    ], 'investigation')).toBe(false)
  })

  test('native Codex欠員もsolution/risk各slotのterminal outcomeとして受理する', () => {
    const unavailable = ['solution', 'risk'].map((perspective, index) => ({
      attempted: true,
      adopted: false,
      perspective,
      reasonDigest: digest(String(index + 1)),
    }))
    expect(validTerminalNativeAttempts(unavailable)).toBe(true)
    expect(validTerminalNativeAttempts([
      {
        attempted: true,
        adopted: true,
        perspective: 'solution',
        agentId: 'solution_agent',
        responseDigest: digest('a'),
        responseTransportDigest: digest('b'),
      },
      unavailable[1],
    ])).toBe(true)
    expect(validTerminalNativeAttempts([
      { ...unavailable[0], attempted: false }, unavailable[1],
    ])).toBe(false)
    expect(validTerminalNativeAttempts([
      { ...unavailable[0], responseDigest: digest('c') }, unavailable[1],
    ])).toBe(false)
    expect(validTerminalNativeAttempts([
      {
        ...unavailable[0], started: false,
        executionState: 'response-obtained',
      },
      unavailable[1],
    ])).toBe(false)
    expect(validTerminalNativeAttempts([
      {
        ...unavailable[0], started: true,
        executionState: 'unavailable-before-start',
      },
      unavailable[1],
    ])).toBe(false)
  })

  test('安全に終了したGrok欠員を成功数0でもterminalとして受理する', () => {
    const unavailable = ['solution', 'risk'].map((perspective, index) => ({
      attempted: true,
      adopted: false,
      perspective,
      containmentVerified: true,
      reasonDigest: digest(String(index + 1)),
    }))
    expect(validTerminalGrokAttempts(unavailable)).toBe(true)
    expect(validTerminalGrokAttempts([
      { ...unavailable[0], containmentVerified: false }, unavailable[1],
    ])).toBe(false)
    expect(validTerminalGrokAttempts([
      { ...unavailable[0], reasonDigest: undefined }, unavailable[1],
    ])).toBe(false)
    expect(validTerminalGrokAttempts([
      { ...unavailable[0], executionState: 'response-obtained' }, unavailable[1],
    ])).toBe(false)
    expect(validTerminalGrokAttempts([
      { ...unavailable[0], executionState: 'started-no-response' }, unavailable[1],
    ])).toBe(false)
    expect(validTerminalGrokAttempts([
      {
        ...unavailable[0], executionState: 'started-no-response', processId: 101,
      },
      unavailable[1],
    ])).toBe(true)
    expect(validTerminalGrokAttempts([
      {
        ...unavailable[0],
        containmentVerified: false,
        containmentStatus: 'unverified-bounded-residual',
        executionState: 'start-unconfirmed',
      },
      unavailable[1],
    ])).toBe(true)
    expect(validTerminalGrokAttempts([
      {
        ...unavailable[0],
        containmentVerified: false,
        containmentStatus: 'owned-process-still-live',
        executionState: 'start-unconfirmed',
      },
      unavailable[1],
    ])).toBe(false)
  })

  test('Grok成功枠は別PIDとresponse digestを要求する', () => {
    const adopted = ['solution', 'risk'].map((perspective, index) => ({
      attempted: true,
      adopted: true,
      perspective,
      containmentVerified: true,
      processId: 100 + index,
      responseDigest: digest(String(index + 3)),
    }))
    expect(validTerminalGrokAttempts(adopted)).toBe(true)
    expect(validTerminalGrokAttempts([
      adopted[0], { ...adopted[1], processId: adopted[0]!.processId },
    ])).toBe(false)
  })

  test('Claudeは未起動欠員またはexact cleanup済み欠員だけterminalにする', () => {
    const notStarted = {
      attempted: true,
      required: true,
      lifecycle: 'ephemeral-v2',
      adopted: false,
      workspaceCreationAttempted: false,
      freshEphemeral: false,
      cleanupVerified: false,
      containmentVerified: true,
      promptMayHaveBeenDelivered: false,
      reasonDigest: digest('a'),
    }
    expect(validTerminalClaudeAttempt(notStarted)).toBe(true)
    expect(validTerminalClaudeAttempt({
      ...notStarted,
      workspaceCreationAttempted: true,
      freshEphemeral: true,
    })).toBe(false)
    expect(validTerminalClaudeAttempt({
      ...notStarted,
      workspaceCreationAttempted: true,
      freshEphemeral: true,
      cleanupVerified: true,
      cleanupStatus: 'closed-and-verified',
      cleanupReceiptDigest: digest('b'),
      promptMayHaveBeenDelivered: true,
      executionState: 'started-no-response',
    })).toBe(true)
    expect(validTerminalClaudeAttempt({
      ...notStarted,
      workspaceCreationAttempted: true,
      cleanupVerified: true,
      cleanupStatus: 'provisional-workspace-not-created',
      cleanupReceiptDigest: digest('c'),
    })).toBe(true)
    expect(validTerminalClaudeAttempt({
      ...notStarted,
      workspaceCreationAttempted: true,
      cleanupVerified: true,
      cleanupStatus: 'unexpected-cleanup-status',
      cleanupReceiptDigest: digest('d'),
    })).toBe(false)
    expect(validTerminalClaudeAttempt({
      ...notStarted,
      executionState: 'response-obtained',
    })).toBe(false)
    expect(validTerminalClaudeAttempt({
      ...notStarted,
      adopted: true,
      workspaceCreationAttempted: true,
      freshEphemeral: true,
      cleanupVerified: true,
      cleanupStatus: 'closed-and-verified',
      cleanupReceiptDigest: digest('f'),
      responseDigest: digest('1'),
      executionState: 'response-obtained',
    })).toBe(false)
    expect(validTerminalClaudeAttempt({
      ...notStarted,
      workspaceCreationAttempted: true,
      freshEphemeral: true,
      cleanupVerified: true,
      cleanupStatus: 'closed-and-verified',
      cleanupReceiptDigest: digest('e'),
      promptMayHaveBeenDelivered: true,
      executionState: 'start-unconfirmed',
    })).toBe(true)
    expect(validTerminalClaudeAttempt({
      ...notStarted,
      workspaceCreationAttempted: true,
      cleanupStatus: 'unverified-after-retirement',
      containmentVerified: false,
      executionState: 'start-unconfirmed',
    })).toBe(true)
    expect(validTerminalClaudeAttempt({
      ...notStarted,
      workspaceCreationAttempted: true,
      cleanupStatus: undefined,
      containmentVerified: false,
      containmentStatus: 'unverified-bounded-residual',
      executionState: 'start-unconfirmed',
    })).toBe(true)
    expect(validTerminalClaudeAttempt({
      ...notStarted,
      workspaceCreationAttempted: true,
      cleanupStatus: undefined,
      containmentVerified: false,
      containmentStatus: 'owned-process-still-live',
      executionState: 'start-unconfirmed',
    })).toBe(false)
  })

  test('旧version 5は従来どおり全採択結果だけを受理する', () => {
    const grok = ['solution', 'risk'].map((perspective, index) => ({
      adopted: true,
      perspective,
      processId: 200 + index,
      responseDigest: digest(String(index + 5)),
    }))
    const claude = {
      attempted: true,
      required: true,
      lifecycle: 'ephemeral-v2',
      adopted: true,
      freshEphemeral: true,
      cleanupVerified: true,
      cleanupStatus: 'closed-and-verified',
      responseDigest: digest('c'),
      cleanupReceiptDigest: digest('d'),
    }
    expect(validLegacyAdoptedGrok(grok)).toBe(true)
    expect(validLegacyAdoptedClaude(claude)).toBe(true)
    expect(validLegacyAdoptedGrok(grok.map(value => ({ ...value, adopted: false })))).toBe(false)
    expect(validLegacyAdoptedClaude({ ...claude, adopted: false })).toBe(false)
  })
})
