import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertNativeAdvisorEvidence,
  nativeAdvisorMarker,
  nativeAdvisorResponseDigest,
  type NativeAdvisorPerspective,
  type NativeAdvisorRoundEvidence,
} from './native-advisor-evidence.ts'

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): {
  options: Parameters<typeof assertNativeAdvisorEvidence>[0]
  solutionId: string
  riskId: string
} {
  const repo = mkdtempSync(join(tmpdir(), 'zero-native-advisor-'))
  temporaryDirs.push(repo)
  const attemptNonce = 'f'.repeat(32)
  const inputRevision = 1
  const inputDigest = 'a'.repeat(64)
  const parentThreadId = 'parent-thread'
  const solutionId = 'solution-thread'
  const riskId = 'risk-thread'
  const phase = 'investigation' as const
  const round = 1 as const
  const response = (perspective: NativeAdvisorPerspective) => (
    `${perspective} findings\n${nativeAdvisorMarker(
      attemptNonce, inputRevision, inputDigest, phase, round, perspective,
    )}`
  )
  const child = (
    id: string,
    perspective: NativeAdvisorPerspective,
    role: 'solution_analyst' | 'risk_reviewer',
  ) => ({
    thread: {
      id,
      parentThreadId,
      cwd: repo,
      agentRole: role,
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: parentThreadId,
            depth: 1,
            agent_role: role,
          },
        },
      },
      turns: [{
        status: 'completed',
        items: [{ type: 'agentMessage', phase: 'final_answer', text: response(perspective) }],
      }],
    },
  })
  const rounds: NativeAdvisorRoundEvidence[] = [{
    inputRevision,
    inputDigest,
    phase,
    round,
    native: [
      {
        perspective: 'solution',
        agentId: solutionId,
        responseDigest: nativeAdvisorResponseDigest(response('solution')),
      },
      {
        perspective: 'risk',
        agentId: riskId,
        responseDigest: nativeAdvisorResponseDigest(response('risk')),
      },
    ],
  }]
  return {
    solutionId,
    riskId,
    options: {
      attemptNonce,
      parentThreadId,
      expectedParentSource: 'appServer',
      repoPath: repo,
      rounds,
      parentResponse: {
        thread: {
          id: parentThreadId,
          parentThreadId: null,
          source: 'appServer',
          cwd: repo,
          turns: [{
            status: 'completed',
            items: [
              {
                type: 'subAgentActivity', kind: 'started', agentThreadId: solutionId,
              },
              {
                type: 'subAgentActivity', kind: 'started', agentThreadId: riskId,
              },
            ],
          }],
        },
      },
      childrenListResponse: {
        data: [
          { id: solutionId, parentThreadId },
          { id: riskId, parentThreadId },
        ],
        nextCursor: null,
      },
      childResponses: new Map([
        [solutionId, child(solutionId, 'solution', 'solution_analyst')],
        [riskId, child(riskId, 'risk', 'risk_reviewer')],
      ]),
    },
  }
}

describe('native Codex advisor host evidence', () => {
  test('parent sourceは起動handshakeで観測した値と完全一致が必要', () => {
    const { options } = fixture()
    options.expectedParentSource = 'exec'
    expect(() => assertNativeAdvisorEvidence(options)).toThrow(
      'parent thread does not match',
    )
  })

  test('App Serverの親子・role・completed response・marker・digestを完全照合する', () => {
    const { options } = fixture()
    expect(() => assertNativeAdvisorEvidence(options)).not.toThrow()
  })

  test('legacyのnullまたは省略phaseを最終回答として受理する', () => {
    for (const phase of [null, undefined]) {
      const { options, solutionId } = fixture()
      const solution = options.childResponses.get(solutionId) as {
        thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
      }
      if (phase === undefined) delete solution.thread.turns[0]!.items[0]!.phase
      else solution.thread.turns[0]!.items[0]!.phase = phase
      expect(() => assertNativeAdvisorEvidence(options)).not.toThrow()
    }
  })

  test('commentaryは最終回答へ数えず明示finalだけを採択する', () => {
    const accepted = fixture()
    const acceptedSolution = accepted.options.childResponses.get(accepted.solutionId) as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    acceptedSolution.thread.turns[0]!.items.unshift({
      type: 'agentMessage', phase: 'commentary', text: 'checking',
    })
    expect(() => assertNativeAdvisorEvidence(accepted.options)).not.toThrow()

    const rejected = fixture()
    const rejectedSolution = rejected.options.childResponses.get(rejected.solutionId) as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    rejectedSolution.thread.turns[0]!.items[0]!.phase = 'commentary'
    expect(() => assertNativeAdvisorEvidence(rejected.options)).toThrow(
      'does not contain one final response',
    )
  })

  test('異なる2件のlegacy null finalは拒否する', () => {
    const { options, solutionId } = fixture()
    const solution = options.childResponses.get(solutionId) as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    const original = solution.thread.turns[0]!.items[0]!
    original.phase = null
    solution.thread.turns[0]!.items.push({
      ...original,
      text: `${original.text as string}\nextra`,
    })
    expect(() => assertNativeAdvisorEvidence(options)).toThrow(
      'does not contain one final response',
    )
  })

  test('現在turnの余分な子subagentまたは未記録の子をfail-closeする', () => {
    const { options } = fixture()
    ;(options.childrenListResponse as { data: unknown[] }).data.push({
      id: 'extra-thread',
      parentThreadId: options.parentThreadId,
    })
    const parent = options.parentResponse as {
      thread: { turns: Array<{ items: unknown[] }> }
    }
    parent.thread.turns[0]!.items.push({
      type: 'subAgentActivity', kind: 'started', agentThreadId: 'extra-thread',
    })
    expect(() => assertNativeAdvisorEvidence(options)).toThrow('unjournaled or missing')
  })

  test('架空digest・role違い・子の再利用をfail-closeする', () => {
    const first = fixture()
    first.options.rounds[0]!.native[0]!.responseDigest = '0'.repeat(64)
    expect(() => assertNativeAdvisorEvidence(first.options)).toThrow('not bound')

    const second = fixture()
    const risk = second.options.childResponses.get(second.riskId) as {
      thread: { agentRole: string }
    }
    risk.thread.agentRole = 'solution_analyst'
    expect(() => assertNativeAdvisorEvidence(second.options)).toThrow('identity or role')

    const third = fixture()
    third.options.rounds.push({
      inputRevision: 1,
      inputDigest: 'a'.repeat(64),
      phase: 'design',
      round: 1,
      native: third.options.rounds[0]!.native.map(value => ({ ...value })),
    })
    expect(() => assertNativeAdvisorEvidence(third.options)).toThrow('not fresh and unique')
  })

  test('rate-limit resume前のturnと古いchild threadは現在roundへ混入させない', () => {
    const { options } = fixture()
    // The caller supplies only turn IDs started by this executor attempt. An
    // older attempt can still appear in thread/list, but not in those turns.
    ;(options.childrenListResponse as { data: unknown[] }).data.unshift({
      id: 'old-child', parentThreadId: options.parentThreadId,
    })
    expect(() => assertNativeAdvisorEvidence(options)).not.toThrow()
  })

  test('同じattemptの複数turn・複数入力revisionの全childをjournalへ結合する', () => {
    const { options } = fixture()
    const inputRevision = 2
    const inputDigest = 'b'.repeat(64)
    const solutionId = 'solution-thread-r2'
    const riskId = 'risk-thread-r2'
    const response = (perspective: NativeAdvisorPerspective) => (
      `${perspective} revision 2\n${nativeAdvisorMarker(
        options.attemptNonce,
        inputRevision,
        inputDigest,
        'investigation',
        1,
        perspective,
      )}`
    )
    const child = (
      id: string,
      perspective: NativeAdvisorPerspective,
      role: 'solution_analyst' | 'risk_reviewer',
    ) => ({
      thread: {
        id,
        parentThreadId: options.parentThreadId,
        cwd: options.repoPath,
        agentRole: role,
        source: { subAgent: { thread_spawn: {
          parent_thread_id: options.parentThreadId,
          depth: 1,
          agent_role: role,
        } } },
        turns: [{
          status: 'completed',
          items: [{ type: 'agentMessage', phase: 'final_answer', text: response(perspective) }],
        }],
      },
    })
    options.rounds.push({
      inputRevision,
      inputDigest,
      phase: 'investigation',
      round: 1,
      native: [
        {
          perspective: 'solution',
          agentId: solutionId,
          responseDigest: nativeAdvisorResponseDigest(response('solution')),
        },
        {
          perspective: 'risk',
          agentId: riskId,
          responseDigest: nativeAdvisorResponseDigest(response('risk')),
        },
      ],
    })
    const parent = options.parentResponse as {
      thread: { turns: Array<{ status: string; items: unknown[] }> }
    }
    parent.thread.turns.push({
      status: 'completed',
      items: [
        { type: 'subAgentActivity', kind: 'started', agentThreadId: solutionId },
        { type: 'subAgentActivity', kind: 'started', agentThreadId: riskId },
      ],
    })
    ;(options.childrenListResponse as { data: unknown[] }).data.push(
      { id: solutionId, parentThreadId: options.parentThreadId },
      { id: riskId, parentThreadId: options.parentThreadId },
    )
    options.childResponses.set(solutionId, child(solutionId, 'solution', 'solution_analyst'))
    options.childResponses.set(riskId, child(riskId, 'risk', 'risk_reviewer'))
    expect(() => assertNativeAdvisorEvidence(options)).not.toThrow()
  })

  test('必須advisor自身が孫subagentへ再委任した履歴を拒否する', () => {
    const { options, solutionId } = fixture()
    const solution = options.childResponses.get(solutionId) as {
      thread: { turns: Array<{ items: unknown[] }> }
    }
    solution.thread.turns[0]!.items.unshift({
      type: 'subAgentActivity', kind: 'started', agentThreadId: 'grandchild',
    })
    expect(() => assertNativeAdvisorEvidence(options)).toThrow('delegated')
  })
})
