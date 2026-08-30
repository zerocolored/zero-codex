import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertNativeAdvisorEvidence,
  nativeAdvisorMarker,
  nativeAdvisorResponseDigest,
  nativeAdvisorResponseHasExactMarker,
  nativeAdvisorResponseTransportDigest,
  resolveNativeAdvisorThreadIds,
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
        itemsView: 'full',
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
            itemsView: 'full',
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
      parentChildBaseline: [],
      childResponses: new Map([
        [solutionId, child(solutionId, 'solution', 'solution_analyst')],
        [riskId, child(riskId, 'risk', 'risk_reviewer')],
      ]),
      childChildrenListResponses: new Map([
        [solutionId, { data: [], nextCursor: null }],
        [riskId, { data: [], nextCursor: null }],
      ]),
    },
  }
}

describe('native Codex advisor host evidence', () => {
  test('Markdown hard-breakの転送差だけを補助digestで照合する', () => {
    const { options, solutionId } = fixture()
    const marker = nativeAdvisorMarker(
      options.attemptNonce,
      options.rounds[0]!.inputRevision,
      options.rounds[0]!.inputDigest,
      options.rounds[0]!.phase,
      options.rounds[0]!.round,
      'solution',
    )
    const logical = `見出し\n調査結果\n修正案\n検証項目\n${marker}`
    const physical = `見出し  \n調査結果  \n修正案  \n検証項目  \n${marker}`
    const solution = options.childResponses.get(solutionId) as {
      thread: { turns: Array<{ items: Array<{ text: string }> }> }
    }
    solution.thread.turns[0]!.items[0]!.text = physical
    options.rounds[0]!.native[0]!.responseDigest = nativeAdvisorResponseDigest(logical)
    options.rounds[0]!.native[0]!.responseTransportDigest =
      nativeAdvisorResponseTransportDigest(logical)

    expect(nativeAdvisorResponseDigest(physical)).not.toBe(nativeAdvisorResponseDigest(logical))
    expect(nativeAdvisorResponseTransportDigest(physical)).toBe(
      nativeAdvisorResponseTransportDigest(logical),
    )
    expect(() => assertNativeAdvisorEvidence(options)).not.toThrow()
  })

  test('補助digestはコード・別空白・改行・本文改変を同一視しない', () => {
    const marker = '[ZERO_NATIVE_ADVISOR:test]'
    const baseline = nativeAdvisorResponseTransportDigest(`本文\n${marker}`)
    const variants = [
      `本文 \n${marker}`,
      `本文   \n${marker}`,
      `本文\t\n${marker}`,
      `本文\u00a0\n${marker}`,
      `本文  \r\n${marker}`,
      `別本文\n${marker}`,
      `本文\n\n${marker}`,
      `\`\`\`text\n本文  \n\`\`\`\n${marker}`,
      `    本文  \n${marker}`,
    ]
    for (const variant of variants) {
      expect(nativeAdvisorResponseTransportDigest(variant)).not.toBe(baseline)
    }
    expect(nativeAdvisorResponseTransportDigest(`\`\`\`text\n本文  \n\`\`\`\n${marker}`))
      .not.toBe(nativeAdvisorResponseTransportDigest(`\`\`\`text\n本文\n\`\`\`\n${marker}`))
    expect(nativeAdvisorResponseTransportDigest(`    本文  \n${marker}`))
      .not.toBe(nativeAdvisorResponseTransportDigest(`    本文\n${marker}`))
    expect(nativeAdvisorResponseTransportDigest(`+追加行  \n${marker}`))
      .not.toBe(nativeAdvisorResponseTransportDigest(`+追加行\n${marker}`))
    expect(nativeAdvisorResponseTransportDigest(`\u00a0  \n${marker}`))
      .not.toBe(nativeAdvisorResponseTransportDigest(`\u00a0\n${marker}`))
    expect(nativeAdvisorResponseTransportDigest(`  本文  \n${marker}`))
      .not.toBe(nativeAdvisorResponseTransportDigest(`  本文\n${marker}`))
    expect(nativeAdvisorResponseTransportDigest(`> 本文  \n${marker}`))
      .not.toBe(nativeAdvisorResponseTransportDigest(`> 本文\n${marker}`))
    expect(nativeAdvisorResponseTransportDigest(`> \`\`\`text\n> 本文  \n> \`\`\`\n${marker}`))
      .not.toBe(nativeAdvisorResponseTransportDigest(`> \`\`\`text\n> 本文\n> \`\`\`\n${marker}`))
    expect(nativeAdvisorResponseTransportDigest(`- 箇条書き  \n${marker}`))
      .toBe(nativeAdvisorResponseTransportDigest(`- 箇条書き\n${marker}`))
    expect(nativeAdvisorResponseTransportDigest(`+ 箇条書き  \n${marker}`))
      .toBe(nativeAdvisorResponseTransportDigest(`+ 箇条書き\n${marker}`))
    expect(nativeAdvisorResponseHasExactMarker(`本文\n${marker}`, marker)).toBe(true)
    expect(nativeAdvisorResponseHasExactMarker(`本文${marker}`, marker)).toBe(false)
    expect(nativeAdvisorResponseHasExactMarker(`${marker}\n本文\n${marker}`, marker)).toBe(false)
    expect(nativeAdvisorResponseHasExactMarker(`本文\n${marker}\n`, marker)).toBe(false)
  })

  test('論理agent名をrole・marker・digestで物理thread IDへ一意解決する', () => {
    const { options, solutionId, riskId } = fixture()
    options.rounds[0]!.native[0]!.agentId = 'investigation_solution'
    options.rounds[0]!.native[1]!.agentId = 'investigation_risk'
    const resolved = resolveNativeAdvisorThreadIds({
      attemptNonce: options.attemptNonce,
      parentThreadId: options.parentThreadId,
      repoPath: options.repoPath,
      rounds: options.rounds,
      parentResponse: options.parentResponse,
      childResponses: options.childResponses,
    })
    expect(resolved[0]!.native.map(entry => entry.agentId)).toEqual([solutionId, riskId])
  })

  test('同一thread割り込みで終了した旧advisorを利用不能として分離する', () => {
    const { options, solutionId, riskId } = fixture()
    const interruptedId = 'interrupted-old-solution'
    const parent = options.parentResponse as {
      thread: { turns: Array<Record<string, unknown>> }
    }
    parent.thread.turns[0]!.id = 'resumed-parent-turn'
    parent.thread.turns.unshift({
      id: 'paused-parent-turn',
      status: 'completed',
      itemsView: 'full',
      items: [
        {
          type: 'subAgentActivity', id: 'interrupted-old-start',
          kind: 'started', agentThreadId: interruptedId,
        },
        {
          type: 'agentMessage', id: 'pause-final', phase: 'final_answer',
          text: 'interjection accepted\n[ZERO_INTERJECTION_PAUSED:interjection-1]',
        },
      ],
    })
    options.childrenListResponse = {
      data: [
        { id: solutionId, parentThreadId: options.parentThreadId },
        { id: riskId, parentThreadId: options.parentThreadId },
        { id: interruptedId, parentThreadId: options.parentThreadId },
      ],
      nextCursor: null,
    }
    options.childResponses.set(interruptedId, {
      thread: {
        id: interruptedId,
        parentThreadId: options.parentThreadId,
        cwd: options.repoPath,
        agentRole: 'solution_analyst',
        source: { subAgent: { thread_spawn: {
          parent_thread_id: options.parentThreadId,
          depth: 1,
          agent_role: 'solution_analyst',
        } } },
        turns: [{
          id: 'interrupted-old-turn',
          status: 'interrupted',
          itemsView: 'full',
          items: [{
            type: 'agentMessage', id: 'interrupted-old-commentary',
            phase: 'commentary', text: 'still checking',
          }],
        }],
      },
    })
    options.childChildrenListResponses.set(interruptedId, { data: [], nextCursor: null })

    const resolved = resolveNativeAdvisorThreadIds({
      attemptNonce: options.attemptNonce,
      parentThreadId: options.parentThreadId,
      repoPath: options.repoPath,
      rounds: options.rounds,
      parentResponse: options.parentResponse,
      childResponses: options.childResponses,
    })
    expect(resolved[0]!.native.map(entry => entry.agentId)).toEqual([solutionId, riskId])
    expect(() => assertNativeAdvisorEvidence(options)).not.toThrow()

    ;(parent.thread.turns[1]!.items as Array<Record<string, unknown>>).push({
      type: 'subAgentActivity', id: 'interrupted-old-interaction',
      kind: 'interacted', agentThreadId: interruptedId, agentPath: '/root/interrupted',
    })
    expect(() => assertNativeAdvisorEvidence(options)).toThrow(
      'unclaimed child response',
    )
    ;(parent.thread.turns[1]!.items as Array<Record<string, unknown>>).pop()

    options.childChildrenListResponses.set(interruptedId, {
      data: [{ id: 'forbidden-descendant', parentThreadId: interruptedId }],
      nextCursor: null,
    })
    expect(() => assertNativeAdvisorEvidence(options)).toThrow(
      'unclaimed child response',
    )
  })

  test('pause markerに束縛した旧completed/interrupted pairだけを再開後pairから分離する', () => {
    const accepted = fixture()
    const parent = accepted.options.parentResponse as {
      thread: { turns: Array<Record<string, unknown>> }
    }
    parent.thread.turns[0]!.id = 'resumed-parent-turn'
    const oldSolutionId = 'paused-old-solution'
    const oldRiskId = 'paused-old-risk'
    parent.thread.turns.unshift({
      id: 'paused-parent-turn', status: 'completed', itemsView: 'full',
      items: [
        {
          type: 'subAgentActivity', id: 'paused-old-solution-start',
          kind: 'started', agentThreadId: oldSolutionId,
        },
        {
          type: 'subAgentActivity', id: 'paused-old-solution-completed',
          kind: 'completed', agentThreadId: oldSolutionId,
        },
        {
          type: 'subAgentActivity', id: 'paused-old-risk-start',
          kind: 'started', agentThreadId: oldRiskId,
        },
        {
          type: 'agentMessage', id: 'paused-parent-final', phase: 'final_answer',
          text: 'interjection accepted\n[ZERO_INTERJECTION_PAUSED:interjection-2]',
        },
      ],
    })
    const oldSolution = structuredClone(
      accepted.options.childResponses.get(accepted.solutionId),
    ) as { thread: { id: string } }
    oldSolution.thread.id = oldSolutionId
    const oldRisk = structuredClone(
      accepted.options.childResponses.get(accepted.riskId),
    ) as { thread: { id: string; turns: Array<Record<string, unknown>> } }
    oldRisk.thread.id = oldRiskId
    oldRisk.thread.turns = [{
      id: 'paused-old-risk-turn', status: 'interrupted', itemsView: 'full',
      items: [{
        type: 'agentMessage', id: 'paused-old-risk-commentary',
        phase: 'commentary', text: 'interrupted by the parent',
      }],
    }]
    ;(accepted.options.childrenListResponse as { data: unknown[] }).data.push(
      { id: oldSolutionId, parentThreadId: accepted.options.parentThreadId },
      { id: oldRiskId, parentThreadId: accepted.options.parentThreadId },
    )
    accepted.options.childResponses.set(oldSolutionId, oldSolution)
    accepted.options.childResponses.set(oldRiskId, oldRisk)
    accepted.options.childChildrenListResponses.set(oldSolutionId, { data: [], nextCursor: null })
    accepted.options.childChildrenListResponses.set(oldRiskId, { data: [], nextCursor: null })

    const resolved = resolveNativeAdvisorThreadIds({
      attemptNonce: accepted.options.attemptNonce,
      parentThreadId: accepted.options.parentThreadId,
      repoPath: accepted.options.repoPath,
      rounds: accepted.options.rounds,
      parentResponse: accepted.options.parentResponse,
      childResponses: accepted.options.childResponses,
    })
    expect(resolved[0]!.native.map(entry => entry.agentId)).toEqual([
      accepted.solutionId, accepted.riskId,
    ])
    expect(() => assertNativeAdvisorEvidence(accepted.options)).not.toThrow()

    const duplicateId = 'paused-duplicate-solution'
    const duplicate = structuredClone(oldSolution) as { thread: { id: string } }
    duplicate.thread.id = duplicateId
    const pauseItems = parent.thread.turns[0]!.items as Array<Record<string, unknown>>
    pauseItems.splice(-1, 0, {
      type: 'subAgentActivity', id: 'paused-duplicate-solution-start',
      kind: 'started', agentThreadId: duplicateId,
    })
    ;(accepted.options.childrenListResponse as { data: unknown[] }).data.push({
      id: duplicateId, parentThreadId: accepted.options.parentThreadId,
    })
    accepted.options.childResponses.set(duplicateId, duplicate)
    accepted.options.childChildrenListResponses.set(duplicateId, { data: [], nextCursor: null })
    expect(() => assertNativeAdvisorEvidence(accepted.options)).toThrow(
      'paused generation spawned duplicate perspective children',
    )
  })

  test('pause markerのないcompleted extra childを旧generationとして許容しない', () => {
    const value = fixture()
    const extraId = 'nonpause-completed-solution'
    const extra = structuredClone(
      value.options.childResponses.get(value.solutionId),
    ) as { thread: { id: string; turns: Array<{ items: Array<{ text: string }> }> } }
    extra.thread.id = extraId
    extra.thread.turns[0]!.items[0]!.text = 'unrelated completed answer'
    const parent = value.options.parentResponse as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    parent.thread.turns[0]!.items.push({
      type: 'subAgentActivity', id: 'nonpause-completed-solution-start',
      kind: 'started', agentThreadId: extraId,
    })
    ;(value.options.childrenListResponse as { data: unknown[] }).data.push({
      id: extraId, parentThreadId: value.options.parentThreadId,
    })
    value.options.childResponses.set(extraId, extra)
    value.options.childChildrenListResponses.set(extraId, { data: [], nextCursor: null })
    expect(() => resolveNativeAdvisorThreadIds({
      attemptNonce: value.options.attemptNonce,
      parentThreadId: value.options.parentThreadId,
      repoPath: value.options.repoPath,
      rounds: value.options.rounds,
      parentResponse: value.options.parentResponse,
      childResponses: value.options.childResponses,
    })).toThrow('unjournaled physical child thread')
    expect(() => assertNativeAdvisorEvidence(value.options)).toThrow(
      'unclaimed child response',
    )
  })

  test('failed terminal childは対応するunavailable slotだけへ束縛する', () => {
    const value = fixture()
    value.options.rounds[0]!.native[0] = {
      perspective: 'solution', attempted: true, adopted: false,
      reasonDigest: '4'.repeat(64),
    }
    const failed = value.options.childResponses.get(value.solutionId) as {
      thread: { turns: Array<Record<string, unknown>> }
    }
    const parent = value.options.parentResponse as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    const solutionStart = parent.thread.turns[0]!.items.find(item => (
      item.agentThreadId === value.solutionId
    ))!
    solutionStart.id = 'failed-solution-start'
    failed.thread.turns = [{
      id: 'failed-solution-turn', status: 'failed', itemsView: 'full',
      items: [{
        type: 'agentMessage', id: 'failed-solution-commentary',
        phase: 'commentary', text: 'failed before a final response',
      }],
    }]
    const resolved = resolveNativeAdvisorThreadIds({
      attemptNonce: value.options.attemptNonce,
      parentThreadId: value.options.parentThreadId,
      repoPath: value.options.repoPath,
      rounds: value.options.rounds,
      parentResponse: value.options.parentResponse,
      childResponses: value.options.childResponses,
    })
    expect(resolved[0]!.native[0]).toEqual(value.options.rounds[0]!.native[0])
    expect(resolved[0]!.native[1]!.agentId).toBe(value.riskId)
    expect(() => assertNativeAdvisorEvidence({
      ...value.options, rounds: resolved,
    })).not.toThrow()
  })

  test('unavailable outcomeのagentId付与と採択threadとの衝突を拒否する', () => {
    const value = fixture()
    value.options.rounds[0]!.native[0] = {
      perspective: 'solution', attempted: true, adopted: false,
      agentId: value.riskId,
      reasonDigest: '5'.repeat(64),
    }
    expect(() => resolveNativeAdvisorThreadIds({
      attemptNonce: value.options.attemptNonce,
      parentThreadId: value.options.parentThreadId,
      repoPath: value.options.repoPath,
      rounds: value.options.rounds,
      parentResponse: value.options.parentResponse,
      childResponses: value.options.childResponses,
    })).toThrow('unavailable outcome is invalid')
    expect(() => assertNativeAdvisorEvidence(value.options)).toThrow(
      'unavailable outcome is invalid',
    )
  })

  test('native採択数0件と1件のterminal outcomeを履歴へ正しく結合する', () => {
    const zero = fixture()
    zero.options.rounds[0]!.native = [
      {
        perspective: 'solution', attempted: true, adopted: false,
        reasonDigest: '1'.repeat(64),
      },
      {
        perspective: 'risk', attempted: true, adopted: false,
        reasonDigest: '2'.repeat(64),
      },
    ]
    const zeroParent = zero.options.parentResponse as {
      thread: { turns: Array<{ items: unknown[] }> }
    }
    zeroParent.thread.turns[0]!.items = []
    zero.options.childrenListResponse = { data: [], nextCursor: null }
    zero.options.childResponses.clear()
    zero.options.childChildrenListResponses.clear()
    const zeroResolved = resolveNativeAdvisorThreadIds({
      attemptNonce: zero.options.attemptNonce,
      parentThreadId: zero.options.parentThreadId,
      repoPath: zero.options.repoPath,
      rounds: zero.options.rounds,
      parentResponse: zero.options.parentResponse,
      childResponses: zero.options.childResponses,
    })
    expect(zeroResolved[0]!.native.map(entry => entry.adopted)).toEqual([false, false])
    expect(() => assertNativeAdvisorEvidence({
      ...zero.options,
      rounds: zeroResolved,
    })).not.toThrow()

    const one = fixture()
    one.options.rounds[0]!.native[1] = {
      perspective: 'risk', attempted: true, adopted: false,
      reasonDigest: '3'.repeat(64),
    }
    const oneParent = one.options.parentResponse as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    oneParent.thread.turns[0]!.items = oneParent.thread.turns[0]!.items.filter(item => (
      item.agentThreadId !== one.riskId
    ))
    one.options.childrenListResponse = {
      data: [{ id: one.solutionId, parentThreadId: one.options.parentThreadId }],
      nextCursor: null,
    }
    one.options.childResponses.delete(one.riskId)
    one.options.childChildrenListResponses.delete(one.riskId)
    const oneResolved = resolveNativeAdvisorThreadIds({
      attemptNonce: one.options.attemptNonce,
      parentThreadId: one.options.parentThreadId,
      repoPath: one.options.repoPath,
      rounds: one.options.rounds,
      parentResponse: one.options.parentResponse,
      childResponses: one.options.childResponses,
    })
    expect(oneResolved[0]!.native.map(entry => entry.adopted)).toEqual([undefined, false])
    expect(() => assertNativeAdvisorEvidence({
      ...one.options,
      rounds: oneResolved,
    })).not.toThrow()
  })

  test('最終回答のないinterrupted precursor後のcompleted turnを一意採択する', () => {
    const { options, solutionId } = fixture()
    const solution = options.childResponses.get(solutionId) as {
      thread: { turns: Array<Record<string, unknown>> }
    }
    solution.thread.turns.unshift({
      status: 'interrupted',
      itemsView: 'full',
      items: [
        { type: 'userMessage', text: 'initial native advisor request' },
        { type: 'agentMessage', phase: 'commentary', text: 'checking evidence' },
      ],
    })
    expect(() => assertNativeAdvisorEvidence(options)).not.toThrow()
  })

  test('completed advisorから親rootへのinteracted 1件だけを再委任とみなさない', () => {
    const accepted = fixture()
    const acceptedSolution = accepted.options.childResponses.get(accepted.solutionId) as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    acceptedSolution.thread.turns[0]!.items.unshift({
      type: 'subAgentActivity',
      id: 'call_parent_root_interaction',
      kind: 'interacted',
      agentThreadId: accepted.options.parentThreadId,
      agentPath: '/root',
    })
    expect(() => resolveNativeAdvisorThreadIds({
      attemptNonce: accepted.options.attemptNonce,
      parentThreadId: accepted.options.parentThreadId,
      repoPath: accepted.options.repoPath,
      rounds: accepted.options.rounds,
      parentResponse: accepted.options.parentResponse,
      childResponses: accepted.options.childResponses,
    })).not.toThrow()
    expect(() => assertNativeAdvisorEvidence(accepted.options)).not.toThrow()

    const rejectedActivities: Array<Record<string, unknown>> = [
      {
        type: 'subAgentActivity', id: 'wrong-kind', kind: 'started',
        agentThreadId: 'parent-thread', agentPath: '/root',
      },
      {
        type: 'subAgentActivity', id: 'wrong-target', kind: 'interacted',
        agentThreadId: 'foreign-thread', agentPath: '/root',
      },
      {
        type: 'subAgentActivity', id: 'wrong-path', kind: 'interacted',
        agentThreadId: 'parent-thread', agentPath: '/root/child',
      },
      {
        type: 'subAgentActivity', kind: 'interacted',
        agentThreadId: 'parent-thread', agentPath: '/root',
      },
    ]
    for (const activity of rejectedActivities) {
      const rejected = fixture()
      const solution = rejected.options.childResponses.get(rejected.solutionId) as {
        thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
      }
      solution.thread.turns[0]!.items.unshift(activity)
      expect(() => resolveNativeAdvisorThreadIds({
        attemptNonce: rejected.options.attemptNonce,
        parentThreadId: rejected.options.parentThreadId,
        repoPath: rejected.options.repoPath,
        rounds: rejected.options.rounds,
        parentResponse: rejected.options.parentResponse,
        childResponses: rejected.options.childResponses,
      })).toThrow('delegated to another subagent')
    }

    const interrupted = fixture()
    const interruptedSolution = interrupted.options.childResponses.get(interrupted.solutionId) as {
      thread: { turns: Array<Record<string, unknown>> }
    }
    interruptedSolution.thread.turns.unshift({
      status: 'interrupted',
      itemsView: 'full',
      items: [{
        type: 'subAgentActivity', id: 'interrupted-parent-interaction', kind: 'interacted',
        agentThreadId: interrupted.options.parentThreadId, agentPath: '/root',
      }],
    })
    expect(() => assertNativeAdvisorEvidence(interrupted.options)).toThrow(
      'delegated to another subagent',
    )

    const repeated = fixture()
    const repeatedSolution = repeated.options.childResponses.get(repeated.solutionId) as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    repeatedSolution.thread.turns[0]!.items.unshift(
      {
        type: 'subAgentActivity', id: 'parent-interaction-one', kind: 'interacted',
        agentThreadId: repeated.options.parentThreadId, agentPath: '/root',
      },
      {
        type: 'subAgentActivity', id: 'parent-interaction-two', kind: 'interacted',
        agentThreadId: repeated.options.parentThreadId, agentPath: '/root',
      },
    )
    expect(() => assertNativeAdvisorEvidence(repeated.options)).toThrow(
      'delegated to another subagent',
    )

    const descendant = fixture()
    const descendantSolution = descendant.options.childResponses.get(descendant.solutionId) as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    descendantSolution.thread.turns[0]!.items.unshift({
      type: 'subAgentActivity', id: 'parent-interaction-with-descendant', kind: 'interacted',
      agentThreadId: descendant.options.parentThreadId, agentPath: '/root',
    })
    descendant.options.childChildrenListResponses.set(descendant.solutionId, {
      data: [{ id: 'hidden-grandchild', parentThreadId: descendant.solutionId }],
      nextCursor: null,
    })
    expect(() => assertNativeAdvisorEvidence(descendant.options)).toThrow(
      'delegated to another subagent',
    )
  })

  test('複数の親turnを継承したreview advisorは自分のcompleted turnだけを採択する', () => {
    const { options, solutionId, riskId } = fixture()
    const parent = options.parentResponse as {
      thread: { turns: Array<Record<string, unknown>> }
    }
    parent.thread.turns = [
      {
        id: 'parent-prepare-turn',
        status: 'completed',
        itemsView: 'full',
        items: [
          { type: 'subAgentActivity', id: 'solution-start', kind: 'started', agentThreadId: solutionId },
          { type: 'subAgentActivity', id: 'risk-start', kind: 'started', agentThreadId: riskId },
        ],
      },
      {
        id: 'parent-implementation-turn',
        status: 'completed',
        itemsView: 'full',
        items: [{ type: 'agentMessage', phase: 'final_answer', text: 'implementation marker' }],
      },
      {
        id: 'parent-review-turn',
        status: 'completed',
        itemsView: 'full',
        items: [],
      },
    ]
    for (const childId of [solutionId, riskId]) {
      const child = options.childResponses.get(childId) as {
        thread: { turns: Array<Record<string, unknown>> }
      }
      child.thread.turns.unshift(
        {
          id: 'parent-prepare-turn',
          status: 'completed',
          itemsView: 'full',
          items: parent.thread.turns[0]!.items,
        },
        {
          id: 'parent-implementation-turn',
          status: 'completed',
          itemsView: 'full',
          items: parent.thread.turns[1]!.items,
        },
        {
          id: 'parent-review-turn',
          status: 'interrupted',
          itemsView: 'full',
          items: [{ type: 'agentMessage', phase: 'commentary', text: 'reviewing' }],
        },
      )
    }
    expect(() => assertNativeAdvisorEvidence(options)).not.toThrow()

    const forged = options.childResponses.get(solutionId) as {
      thread: { turns: Array<Record<string, unknown>> }
    }
    forged.thread.turns.push({
      id: 'second-owned-turn',
      status: 'completed',
      itemsView: 'full',
      items: [{ type: 'agentMessage', phase: 'final_answer', text: 'second response' }],
    })
    expect(() => assertNativeAdvisorEvidence(options)).toThrow(
      'does not contain one final response',
    )
  })

  test('fork時に親から継承した別direct advisorのactivityだけを許容する', () => {
    const accepted = fixture()
    const parent = accepted.options.parentResponse as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    const inherited = {
      type: 'subAgentActivity', id: 'solution-spawn-item',
      kind: 'started', agentThreadId: accepted.solutionId,
    }
    parent.thread.turns[0]!.items[0] = inherited
    parent.thread.turns[0]!.items[1] = {
      type: 'subAgentActivity', id: 'risk-spawn-item',
      kind: 'started', agentThreadId: accepted.riskId,
    }
    const risk = accepted.options.childResponses.get(accepted.riskId) as {
      thread: { turns: Array<Record<string, unknown>> }
    }
    risk.thread.turns.unshift({
      status: 'interrupted', itemsView: 'full', items: [{ ...inherited }],
    })
    expect(() => resolveNativeAdvisorThreadIds({
      attemptNonce: accepted.options.attemptNonce,
      parentThreadId: accepted.options.parentThreadId,
      repoPath: accepted.options.repoPath,
      rounds: accepted.options.rounds,
      parentResponse: accepted.options.parentResponse,
      childResponses: accepted.options.childResponses,
    })).not.toThrow()
    expect(() => assertNativeAdvisorEvidence(accepted.options)).not.toThrow()

    const forged = fixture()
    const forgedParent = forged.options.parentResponse as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    forgedParent.thread.turns[0]!.items[0] = inherited
    forgedParent.thread.turns[0]!.items[1] = {
      type: 'subAgentActivity', id: 'risk-spawn-item',
      kind: 'started', agentThreadId: forged.riskId,
    }
    const forgedRisk = forged.options.childResponses.get(forged.riskId) as {
      thread: { turns: Array<Record<string, unknown>> }
    }
    forgedRisk.thread.turns.unshift({
      status: 'interrupted', itemsView: 'full',
      items: [{ ...inherited, id: 'different-spawn-item' }],
    })
    expect(() => assertNativeAdvisorEvidence(forged.options)).toThrow(
      'delegated to another subagent',
    )

    const outOfOrder = fixture()
    const outOfOrderParent = outOfOrder.options.parentResponse as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    outOfOrderParent.thread.turns[0]!.items = [
      {
        type: 'subAgentActivity', id: 'risk-spawn-item',
        kind: 'started', agentThreadId: outOfOrder.riskId,
      },
      { ...inherited },
    ]
    const outOfOrderRisk = outOfOrder.options.childResponses.get(outOfOrder.riskId) as {
      thread: { turns: Array<Record<string, unknown>> }
    }
    outOfOrderRisk.thread.turns.unshift({
      status: 'interrupted', itemsView: 'full', items: [{ ...inherited }],
    })
    expect(() => assertNativeAdvisorEvidence(outOfOrder.options)).toThrow(
      'delegated to another subagent',
    )

    const completed = fixture()
    const completedParent = completed.options.parentResponse as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    completedParent.thread.turns[0]!.items[0] = inherited
    completedParent.thread.turns[0]!.items[1] = {
      type: 'subAgentActivity', id: 'risk-spawn-item',
      kind: 'started', agentThreadId: completed.riskId,
    }
    const completedRisk = completed.options.childResponses.get(completed.riskId) as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    completedRisk.thread.turns[0]!.items.unshift({ ...inherited })
    expect(() => assertNativeAdvisorEvidence(completed.options)).toThrow(
      'delegated to another subagent',
    )
  })

  test('interrupted precursorのfinal・再委任・複数precursorを拒否する', () => {
    const interruptedFinal = fixture()
    const finalChild = interruptedFinal.options.childResponses.get(
      interruptedFinal.solutionId,
    ) as { thread: { turns: Array<Record<string, unknown>> } }
    finalChild.thread.turns.unshift({
      status: 'interrupted', itemsView: 'full',
      items: [{ type: 'agentMessage', phase: 'final_answer', text: 'stale final' }],
    })
    expect(() => assertNativeAdvisorEvidence(interruptedFinal.options)).toThrow(
      'interrupted precursor contains a final response',
    )

    const delegated = fixture()
    const delegatedChild = delegated.options.childResponses.get(
      delegated.solutionId,
    ) as { thread: { turns: Array<Record<string, unknown>> } }
    delegatedChild.thread.turns.unshift({
      status: 'interrupted', itemsView: 'full',
      items: [{
        type: 'subAgentActivity', kind: 'started', agentThreadId: 'grandchild-thread',
      }],
    })
    expect(() => assertNativeAdvisorEvidence(delegated.options)).toThrow(
      'delegated to another subagent',
    )

    const excessive = fixture()
    const excessiveChild = excessive.options.childResponses.get(
      excessive.solutionId,
    ) as { thread: { turns: Array<Record<string, unknown>> } }
    excessiveChild.thread.turns.unshift(
      { status: 'interrupted', itemsView: 'full', items: [] },
      { status: 'interrupted', itemsView: 'full', items: [] },
    )
    expect(() => assertNativeAdvisorEvidence(excessive.options)).toThrow(
      'at most one interrupted precursor',
    )
  })

  test('物理thread対応が不一致・曖昧・余剰ならfail-closeする', () => {
    const unmatched = fixture()
    unmatched.options.rounds[0]!.native[0]!.agentId = 'investigation_solution'
    unmatched.options.rounds[0]!.native[0]!.responseDigest = '0'.repeat(64)
    expect(() => resolveNativeAdvisorThreadIds({
      attemptNonce: unmatched.options.attemptNonce,
      parentThreadId: unmatched.options.parentThreadId,
      repoPath: unmatched.options.repoPath,
      rounds: unmatched.options.rounds,
      parentResponse: unmatched.options.parentResponse,
      childResponses: unmatched.options.childResponses,
    })).toThrow('exactly one physical thread')

    const ambiguous = fixture()
    ambiguous.options.rounds[0]!.native[0]!.agentId = 'investigation_solution'
    const duplicate = structuredClone(
      ambiguous.options.childResponses.get(ambiguous.solutionId),
    ) as { thread: { id: string } }
    duplicate.thread.id = 'duplicate-solution-thread'
    ambiguous.options.childResponses.set('duplicate-solution-thread', duplicate)
    expect(() => resolveNativeAdvisorThreadIds({
      attemptNonce: ambiguous.options.attemptNonce,
      parentThreadId: ambiguous.options.parentThreadId,
      repoPath: ambiguous.options.repoPath,
      rounds: ambiguous.options.rounds,
      parentResponse: ambiguous.options.parentResponse,
      childResponses: ambiguous.options.childResponses,
    })).toThrow('exactly one physical thread')

    const extra = fixture()
    const unrelated = structuredClone(
      extra.options.childResponses.get(extra.solutionId),
    ) as { thread: { id: string; turns: Array<{ items: Array<{ text: string }> }> } }
    unrelated.thread.id = 'unrelated-solution-thread'
    unrelated.thread.turns[0]!.items[0]!.text = 'unrelated final response'
    extra.options.childResponses.set('unrelated-solution-thread', unrelated)
    expect(() => resolveNativeAdvisorThreadIds({
      attemptNonce: extra.options.attemptNonce,
      parentThreadId: extra.options.parentThreadId,
      repoPath: extra.options.repoPath,
      rounds: extra.options.rounds,
      parentResponse: extra.options.parentResponse,
      childResponses: extra.options.childResponses,
    })).toThrow('unjournaled physical child thread')
  })

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
    options.parentChildBaseline.push('old-child')
    expect(() => assertNativeAdvisorEvidence(options)).not.toThrow()
  })

  test('baselineにないhistorical childとbaseline再利用を拒否する', () => {
    const extra = fixture()
    ;(extra.options.childrenListResponse as { data: unknown[] }).data.unshift({
      id: 'unexpected-old-child', parentThreadId: extra.options.parentThreadId,
    })
    expect(() => assertNativeAdvisorEvidence(extra.options)).toThrow(
      'unjournaled or missing',
    )

    const reused = fixture()
    reused.options.parentChildBaseline.push(reused.solutionId)
    expect(() => assertNativeAdvisorEvidence(reused.options)).toThrow(
      'already present before this job attempt',
    )
  })

  test('parent listingのmissing・duplicateとactivity欠落を拒否する', () => {
    const missing = fixture()
    ;(missing.options.childrenListResponse as { data: unknown[] }).data.pop()
    expect(() => assertNativeAdvisorEvidence(missing.options)).toThrow(
      'unjournaled or missing',
    )

    const duplicate = fixture()
    const listing = (duplicate.options.childrenListResponse as { data: unknown[] }).data
    listing.push(listing[0])
    expect(() => assertNativeAdvisorEvidence(duplicate.options)).toThrow('duplicates')

    const activity = fixture()
    const parent = activity.options.parentResponse as {
      thread: { turns: Array<{ items: unknown[] }> }
    }
    parent.thread.turns[0]!.items.pop()
    expect(() => assertNativeAdvisorEvidence(activity.options)).toThrow(
      'unjournaled or missing',
    )
  })

  test('全既知subAgentActivity kindを観測し未知kindは拒否する', () => {
    const accepted = fixture()
    const parent = accepted.options.parentResponse as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    parent.thread.turns[0]!.items[0]!.kind = 'interacted'
    parent.thread.turns[0]!.items[1]!.kind = 'completed'
    expect(() => assertNativeAdvisorEvidence(accepted.options)).not.toThrow()

    const interrupted = fixture()
    const interruptedParent = interrupted.options.parentResponse as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    interruptedParent.thread.turns[0]!.items[0]!.kind = 'interrupted'
    expect(() => assertNativeAdvisorEvidence(interrupted.options)).not.toThrow()

    const rejected = fixture()
    const rejectedParent = rejected.options.parentResponse as {
      thread: { turns: Array<{ items: Array<Record<string, unknown>> }> }
    }
    rejectedParent.thread.turns[0]!.items[0]!.kind = 'futureActivity'
    expect(() => assertNativeAdvisorEvidence(rejected.options)).toThrow(
      'invalid subagent activity',
    )
  })

  test('parent/childのsummary projectionとadvisorのlisted descendantを拒否する', () => {
    const summaryParent = fixture()
    const parent = summaryParent.options.parentResponse as {
      thread: { turns: Array<{ itemsView: string }> }
    }
    parent.thread.turns[0]!.itemsView = 'summary'
    expect(() => assertNativeAdvisorEvidence(summaryParent.options)).toThrow('not terminal')

    const summaryChild = fixture()
    const child = summaryChild.options.childResponses.get(summaryChild.solutionId) as {
      thread: { turns: Array<{ itemsView: string }> }
    }
    child.thread.turns[0]!.itemsView = 'summary'
    expect(() => assertNativeAdvisorEvidence(summaryChild.options)).toThrow(
      'turn is not completed',
    )

    const descendant = fixture()
    descendant.options.childChildrenListResponses.set(descendant.solutionId, {
      data: [{ id: 'hidden-grandchild', parentThreadId: descendant.solutionId }],
      nextCursor: null,
    })
    expect(() => assertNativeAdvisorEvidence(descendant.options)).toThrow('delegated')
  })

  test('未claimのchild responseまたはdescendant listingを拒否する', () => {
    const response = fixture()
    response.options.childResponses.set('extra-child', { thread: {} })
    expect(() => assertNativeAdvisorEvidence(response.options)).toThrow(
      'unclaimed child response',
    )

    const listing = fixture()
    listing.options.childChildrenListResponses.set('extra-child', {
      data: [], nextCursor: null,
    })
    expect(() => assertNativeAdvisorEvidence(listing.options)).toThrow(
      'unclaimed child response',
    )
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
          itemsView: 'full',
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
      itemsView: 'full',
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
    options.childChildrenListResponses.set(solutionId, { data: [], nextCursor: null })
    options.childChildrenListResponses.set(riskId, { data: [], nextCursor: null })
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
