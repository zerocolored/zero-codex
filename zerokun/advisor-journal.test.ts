import { describe, expect, test } from 'bun:test'
import {
  validLegacyAdoptedClaude,
  validLegacyAdoptedGrok,
  validTerminalClaudeAttempt,
  validTerminalGrokAttempts,
  validTerminalNativeAttempts,
} from './advisor-journal.ts'

const digest = (character: string) => character.repeat(64)

describe('best-effort external advisor journal', () => {
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
