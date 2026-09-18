import { describe, expect, test } from 'bun:test'
import { nativeAdvisorMarker, nativeAdvisorResponseDigest, type NativeAdvisorRoundEvidence } from './native-advisor-evidence.ts'
import { observeNativeAdvisorCoverage } from './native-advisor-coverage.ts'

const nonce = 'a'.repeat(32)
const digest = 'b'.repeat(64)
const parent = 'parent-thread'
const repo = process.cwd()
const rounds: NativeAdvisorRoundEvidence[] = [{
  inputRevision: 1, inputDigest: digest, phase: 'investigation', round: 1,
  native: (['solution', 'risk'] as const).map(perspective => ({
    perspective, attempted: true, adopted: true, agentId: `/root/${perspective}`,
    // The broker received a summary, not these real final answers (job #82).
    responseDigest: 'c'.repeat(64), responseTransportDigest: 'd'.repeat(64),
  })),
}]
function fixture() {
  const children = (['solution', 'risk'] as const).map(perspective => {
    const role = perspective === 'solution' ? 'solution_analyst' : 'risk_reviewer'
    const marker = nativeAdvisorMarker(nonce, 1, digest, 'investigation', 1, perspective)
    return {
      id: `${perspective}-thread`, parentThreadId: parent, cwd: repo, agentRole: role,
      source: { subAgent: { thread_spawn: {
        parent_thread_id: parent, agent_role: role, agent_path: `/root/${perspective}`,
      } } },
      turns: [{ id: `${perspective}-turn`, status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'text', text: `Review this task.\n${marker}` }] },
        { type: 'agentMessage', phase: 'final_answer', text: `Actual independent ${perspective} answer.\n${marker}` },
      ] }],
    }
  })
  const failed = new Set<string>()
  const calls: string[] = []
  const read = async (method: 'thread/list' | 'thread/read', params: Record<string, unknown>) => {
    calls.push(`${method}:${params.threadId ?? ''}`)
    if (failed.has(method) || failed.has(String(params.threadId))) return undefined
    if (method === 'thread/list') return { data: children, nextCursor: null }
    return { thread: children.find(child => child.id === params.threadId) }
  }
  const run = (baseline: string[] = [], evidence = rounds) => observeNativeAdvisorCoverage({
    attemptNonce: nonce, parentThreadId: parent, repoPath: repo,
    parentChildBaseline: baseline, rounds: evidence, read,
  })
  return { children, failed, calls, run }
}

describe('host native advisor execution observations', () => {
  test('同じGPTへの補足依頼で最終回答が増えても1枠として最新の完了回答を回収する', async () => {
    const f = fixture()
    const child = f.children[0]!
    // job196: the binding is in the actual answers, not the initial input.
    child.turns[0]!.items[0]!.content![0]!.text = 'Review this task.'
    const followup = structuredClone(child.turns[0]!)
    followup.id = 'followup-turn'
    followup.items[1]!.text = `Updated review after clarification.\n${nativeAdvisorMarker(nonce, 1, digest, 'investigation', 1, 'solution')}`
    child.turns.push(followup)
    const result = await f.run()
    expect(result[0]!.state).toBe('response-obtained')
    expect(result[0]!.threadId).toBe(child.id)
    expect(result[0]!.responseDigest).toBe(nativeAdvisorResponseDigest(followup.items[1]!.text!))
    expect(result).toHaveLength(2)
  })

  test('同じ子の後続commentary・失敗・別markerは取得済み完了回答を置き換えない', async () => {
    for (const invalid of ['commentary', 'failed', 'foreign-marker'] as const) {
      const f = fixture()
      const child = f.children[0]!
      const original = child.turns[0]!.items[1]!.text!
      const later = structuredClone(child.turns[0]!)
      later.id = 'later-turn'
      later.items[1]!.text = `Later response.\n${nativeAdvisorMarker(nonce, 1, digest, 'investigation', 1, 'solution')}`
      if (invalid === 'commentary') later.items[1]!.phase = 'commentary'
      if (invalid === 'failed') later.status = 'failed'
      if (invalid === 'foreign-marker') later.items[1]!.text = later.items[1]!.text!.replace(nonce, 'f'.repeat(32))
      child.turns.push(later)
      const result = await f.run()
      expect(result[0]!.state).toBe('response-obtained')
      expect(result[0]!.responseDigest).toBe(nativeAdvisorResponseDigest(original))
    }
  })

  test('回答がAからBを経てAへ戻った場合も最後のAのdigestを保持する', async () => {
    const f = fixture()
    const child = f.children[0]!
    const original = child.turns[0]!.items[1]!.text!
    const middle = structuredClone(child.turns[0]!)
    middle.id = 'middle-turn'
    middle.items[1]!.text = `Different answer.\n${nativeAdvisorMarker(nonce, 1, digest, 'investigation', 1, 'solution')}`
    const last = structuredClone(child.turns[0]!)
    last.id = 'last-turn'
    child.turns.push(middle, last)
    const result = await f.run()
    expect(result[0]!.state).toBe('response-obtained')
    expect(result[0]!.responseDigest).toBe(nativeAdvisorResponseDigest(original))
  })

  test('補足回答を持つ物理子が複数なら曖昧性を残しjournalで選んだ子だけを採用する', async () => {
    const f = fixture()
    const child = f.children[0]!
    const later = structuredClone(child.turns[0]!)
    later.id = 'followup-turn'
    later.items[1]!.text = `Updated review.\n${nativeAdvisorMarker(nonce, 1, digest, 'investigation', 1, 'solution')}`
    child.turns.push(later)
    f.children.push({ ...structuredClone(child), id: 'another-child' })
    expect((await f.run())[0]!.state).toBe('start-unconfirmed')
    const evidence = [{ ...rounds[0]!, native: rounds[0]!.native.map(entry => ({
      ...entry, agentId: entry.perspective === 'solution' ? child.id : entry.agentId,
    })) }]
    const result = await f.run([], evidence)
    expect(result[0]!.threadId).toBe(child.id)
    expect(result[0]!.state).toBe('response-obtained')
    expect(result[0]!.responseDigest).toBe(nativeAdvisorResponseDigest(later.items[1]!.text!))
  })

  test('broker要約のdigest不一致でも実子セッションの今回の最終回答を数える', async () => {
    const f = fixture()
    const result = await f.run()
    expect(result.map(value => value.state)).toEqual(['response-obtained', 'response-obtained'])
    expect(result.every(value => value.responseDigest !== rounds[0]!.native[0]!.responseDigest)).toBe(true)
    expect(f.calls).toEqual(['thread/list:', 'thread/read:solution-thread', 'thread/read:risk-thread'])
  })

  test('先頭枠のRPC失敗でも後続枠を回収し、未確認を起動前利用不能に変えない', async () => {
    const f = fixture()
    f.failed.add('solution-thread')
    expect((await f.run()).map(value => value.state)).toEqual(['start-unconfirmed', 'response-obtained'])
  })

  test('一覧取得不能なら両枠未確認、モデルのadopted自己申告は採用しない', async () => {
    const f = fixture()
    f.failed.add('thread/list')
    expect((await f.run()).map(value => value.state)).toEqual(['start-unconfirmed', 'start-unconfirmed'])
  })

  test('今回のinputだけ保存された子は起動を数え、回答は未確認として残す', async () => {
    const f = fixture()
    f.children[0]!.turns[0]!.status = 'inProgress'
    f.children[0]!.turns[0]!.items.pop()
    expect((await f.run()).map(value => value.state)).toEqual(['started-no-response', 'response-obtained'])
  })

  test('commentaryや失敗turnの回答を完了回答として数えない', async () => {
    const f = fixture()
    f.children[0]!.turns[0]!.items[1]!.phase = 'commentary'
    f.children[1]!.turns[0]!.status = 'failed'
    expect((await f.run()).map(value => value.state)).toEqual(['started-no-response', 'started-no-response'])
  })

  test('以前のchild・別nonce・別input revision・別phaseを今回の枠に混ぜない', async () => {
    expect((await fixture().run(['solution-thread', 'risk-thread'])).every(value => value.state === 'start-unconfirmed')).toBe(true)
    for (const change of [
      { inputRevision: 2 }, { inputDigest: 'e'.repeat(64) }, { phase: 'review' as const },
    ]) {
      expect((await fixture().run([], [{ ...rounds[0]!, ...change }]))
        .every(value => value.state === 'start-unconfirmed')).toBe(true)
    }
    const f = fixture()
    f.children.forEach(child => child.turns[0]!.items.forEach(item => {
      if (item.text) item.text = item.text.replace(nonce, 'f'.repeat(32))
      if (item.content) item.content[0]!.text = item.content[0]!.text.replace(nonce, 'f'.repeat(32))
    }))
    expect((await f.run()).every(value => value.state === 'start-unconfirmed')).toBe(true)
  })

  test('別親・別role・異なる作業対象の回答を数えない', async () => {
    for (const change of [
      { parentThreadId: 'foreign-parent' }, { agentRole: 'worker' }, { cwd: '/private/tmp' },
    ]) {
      const f = fixture()
      Object.assign(f.children[0]!, change)
      expect((await f.run())[0]!.state).toBe('start-unconfirmed')
    }
  })

  test('同じslot名の複数childを推測で成功扱いにしない', async () => {
    const f = fixture()
    f.children.push({ ...f.children[0]!, id: 'duplicate-thread' })
    expect((await f.run())[0]!.state).toBe('start-unconfirmed')
  })

  test('同じmarkerの失敗世代が残っても再試行の実回答を回収する', async () => {
    const f = fixture()
    const failed = structuredClone(f.children[0]!)
    failed.id = 'failed-thread'
    failed.turns[0]!.status = 'failed'
    failed.turns[0]!.items.pop()
    f.children.push(failed)
    expect((await f.run())[0]!.threadId).toBe('solution-thread')
    expect((await f.run())[0]!.state).toBe('response-obtained')
  })

  test('journalのagent未指定とchildのpath欠落が一致しても回答を選ばない', async () => {
    const f = fixture()
    const duplicate = structuredClone(f.children[0]!)
    duplicate.id = 'duplicate-thread'
    Reflect.deleteProperty(duplicate.source.subAgent.thread_spawn, 'agent_path')
    f.children.push(duplicate)
    const evidence = [{ ...rounds[0]!, native: rounds[0]!.native.map(entry => ({
      ...entry, agentId: undefined,
    })) }]
    expect((await f.run([], evidence))[0]!.state).toBe('start-unconfirmed')
  })

  test('複数回答がある場合はjournalで選択した物理agentだけを回収する', async () => {
    const f = fixture()
    f.children.push({ ...f.children[0]!, id: 'retry-thread' })
    const evidence = [{ ...rounds[0]!, native: rounds[0]!.native.map(entry => ({
      ...entry, agentId: entry.perspective === 'solution' ? 'retry-thread' : entry.agentId,
    })) }]
    expect((await f.run([], evidence))[0]!.threadId).toBe('retry-thread')
  })

  test('phase省略/nullの公式最終回答にも対応し、commentaryとの区別を保つ', async () => {
    for (const phase of [undefined, null]) {
      const f = fixture()
      Object.assign(f.children[0]!.turns[0]!.items[1]!, { phase })
      expect((await f.run())[0]!.state).toBe('response-obtained')
    }
  })

  test('短い論理名でもroleと今回markerから物理childを解決する', async () => {
    const f = fixture()
    const evidence = [{ ...rounds[0]!, native: rounds[0]!.native.map(entry => ({
      ...entry, agentId: entry.perspective,
    })) }]
    expect((await f.run([], evidence)).every(value => value.state === 'response-obtained')).toBe(true)
  })

  test('同roleの古い子が併存しても今回markerがある1件だけを採用する', async () => {
    const f = fixture()
    f.children.push({ ...f.children[0]!, id: 'old-thread', turns: [] })
    expect((await f.run())[0]!.state).toBe('response-obtained')
  })
})
