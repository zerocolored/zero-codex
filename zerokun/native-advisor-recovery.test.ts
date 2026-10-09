import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readNativeAdvisorRegistrations, readRetainedNativeAdvisors, registerNativeAdvisor, recoverNativeAdvisorAnswers,
  retainedNativeAdvisorPrompt, resumeInterruptedNativeAdvisors, settleNativeAdvisors,
} from './native-advisor-recovery.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-native-recovery-')); roots.push(dir)
  const nonce = 'a'.repeat(32), digest = 'b'.repeat(64), contextPath = join(dir, 'context.json')
  const registration = registerNativeAdvisor({ contextPath, attemptNonce: nonce,
    phase: 'investigation', round: 1, inputRevision: 1, inputDigest: digest, request: 'Review synthetic source independently.' })
  const child: any = { id: 'physical-child', parentThreadId: 'parent', cwd: dir,
    agentRole: 'solution_analyst', model: 'gpt-6-astra', reasoningEffort: 'high', source: { subAgent: { thread_spawn: {
      parent_thread_id: 'parent', agent_role: 'solution_analyst', agent_path: registration.agentPath,
    } } }, status: { type: 'idle' }, canAcceptDirectInput: false,
    // Actual incident: encrypted spawn input is absent from the public history.
    turns: [{ id: 'original', status: 'interrupted', itemsView: 'full', items: [] }],
  }
  const calls: Array<{ method: string, params: Record<string, unknown> }> = []
  const read = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    calls.push({ method, params })
    if (method === 'thread/list') return { data: [child], nextCursor: null }
    if (method === 'thread/read') return { thread: child }
    if (method === 'thread/resume') return { thread: child, model: 'gpt-6-astra', reasoningEffort: 'high', approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false } }
    if (method === 'turn/start') { child.turns.push({ id: 'continued', status: 'inProgress', items: [] }); return { turn: child.turns.at(-1) } }
    throw new Error('unexpected request')
  }
  const options = { parentThreadId: 'parent', repoPath: dir, attemptNonce: nonce, read,
    registrations: readNativeAdvisorRegistrations(contextPath, nonce), interrupted: () => false,
    inputRevision: 1, inputDigest: digest, pollMs: 2, timeoutMs: 1000 }
  const complete = () => { const t = child.turns.at(-1); t.status = 'completed'; t.items = [
    { type: 'agentMessage', phase: 'final_answer', text: `Independent result.\n${registration.marker}` },
  ] }
  return { dir, contextPath, nonce, digest, registration, child, calls, options, complete }
}
test('登録をprocess再起動後に読み直し、異なる入力でも同一slotを再発行する', () => {
  const f = fixture()
  const again = registerNativeAdvisor({ contextPath: f.contextPath, attemptNonce: f.nonce,
    phase: 'investigation', round: 1, inputRevision: 2, inputDigest: 'c'.repeat(64), request: 'Changed input' })
  expect(again).toEqual(f.registration)
  expect(statSync(`${f.contextPath}.native-investigation-1`).mode & 0o777).toBe(0o600)
  expect(() => readNativeAdvisorRegistrations(f.contextPath, 'd'.repeat(32))).toThrow()
})
test('登録済み暗号化inputの子も完了まで待ち、親のstdin close前に回答を保持する', async () => {
  const f = fixture(); f.child.turns[0].status = 'inProgress'; let closed = false
  const waiting = settleNativeAdvisors(f.options).then(value => { closed = true; return value })
  await Bun.sleep(20); expect(closed).toBe(false)
  f.complete(); expect(await waiting).toBe('settled')
  const recovered = await readRetainedNativeAdvisors(f.options)
  expect(recovered[0]?.response).toBe(`Independent result.\n${f.registration.marker}`)
  expect(retainedNativeAdvisorPrompt(recovered)).toContain('physical-child')
  expect(retainedNativeAdvisorPrompt(recovered)).toContain('Independent result.')
})
test('中断済み子を復元し、親のfollowupへ元依頼を返す。子へ直接turn/startしない', async () => {
  const f = fixture()
  const recovered = await recoverNativeAdvisorAnswers({ ...f.options, onWarning: () => {} })
  const resumes = f.calls.filter(value => value.method === 'thread/resume')
  expect(resumes).toHaveLength(1)
  expect(resumes[0]?.params).toMatchObject({ threadId: 'physical-child', sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-6-astra' })
  expect(recovered[0]?.restored).toBe(true)
  expect(recovered[0]?.recoveryRequest).toBe(f.registration.prompt)
  expect(retainedNativeAdvisorPrompt(recovered)).toContain('collaboration.followup_task')
  expect(f.calls.some(value => value.method === 'turn/start')).toBe(false)
  f.complete(); await resumeInterruptedNativeAdvisors(f.options)
  expect(f.calls.filter(value => value.method === 'thread/resume')).toHaveLength(1)
})
test('復元RPC応答不明でも子の新規spawnやturn/startを送らない', async () => {
  const f = fixture()
  await expect(resumeInterruptedNativeAdvisors({ ...f.options, read: async (method, params) => {
    const result = await f.options.read(method, params)
    if (method === 'thread/resume') throw new Error('ambiguous transport')
    return result
  } })).rejects.toThrow('ambiguous')
  expect(f.calls.filter(value => value.method === 'thread/resume')).toHaveLength(1)
  expect(f.calls.some(value => ['thread/start', 'turn/start'].includes(value.method))).toBe(false)
})
test('取得済み回答は再開しない。新入力のために古い中断依頼も再実行しない', async () => {
  const f = fixture()
  await resumeInterruptedNativeAdvisors({ ...f.options, inputRevision: 2 })
  expect(f.calls.some(value => value.method === 'thread/resume')).toBe(false)
  f.complete(); await resumeInterruptedNativeAdvisors(f.options)
  expect(f.calls.some(value => value.method === 'thread/resume')).toBe(false)
})
test.each(['parent', 'role', 'cwd', 'name', 'nonce'] as const)('foreign identityを復旧対象へ混ぜない: %s', async kind => {
  const f = fixture()
  if (kind === 'parent') f.child.source.subAgent.thread_spawn.parent_thread_id = 'foreign'
  if (kind === 'role') f.child.agentRole = 'worker'
  if (kind === 'cwd') f.child.cwd = tmpdir()
  if (kind === 'name') f.child.source.subAgent.thread_spawn.agent_path = '/root/foreign'
  if (kind === 'nonce') f.options.registrations = []
  expect(await readRetainedNativeAdvisors(f.options)).toEqual([])
  await resumeInterruptedNativeAdvisors(f.options)
  expect(f.calls.some(value => value.method === 'thread/resume')).toBe(false)
})
test('重複した物理子と複数bindingは推測で再開しない', async () => {
  const f = fixture()
  await resumeInterruptedNativeAdvisors({ ...f.options, read: async (method, params) => {
    if (method === 'thread/list') return { data: [f.child, { ...f.child, id: 'other' }], nextCursor: null }
    if (method === 'thread/read' && params.threadId === 'other') return { thread: { ...f.child, id: 'other' } }
    return f.options.read(method, params)
  } })
  expect(f.calls.some(value => value.method === 'thread/resume')).toBe(false)
})
test('中断・失敗・commentary・foreign markerの部分回答を完成扱いにしない', async () => {
  for (const kind of ['interrupted', 'failed', 'commentary', 'marker']) {
    const f = fixture(); f.complete()
    if (kind === 'interrupted' || kind === 'failed') f.child.turns[0].status = kind
    if (kind === 'commentary') f.child.turns[0].items[0].phase = 'commentary'
    if (kind === 'marker') f.child.turns[0].items[0].text = 'Foreign answer'
    expect((await readRetainedNativeAdvisors(f.options))[0]?.response).toBeUndefined()
  }
})
test('後続中断で先行完了回答を失わず、誤った新規markerに貼り替えない', async () => {
  const f = fixture(); f.complete(); f.child.turns.push({ id: 'later', status: 'interrupted', items: [] })
  const recovered = await readRetainedNativeAdvisors(f.options)
  expect(recovered[0]?.response).toContain(f.registration.marker)
  await resumeInterruptedNativeAdvisors(f.options)
  expect(f.calls.some(value => value.method === 'turn/start')).toBe(false)
})
test('キャンセル優先・上限・RPC障害を成功に偽装せず、子をkillしない', async () => {
  const f = fixture(); f.child.turns[0].status = 'inProgress'
  expect(await settleNativeAdvisors({ ...f.options, interrupted: () => true })).toBe('interrupted')
  expect(await settleNativeAdvisors({ ...f.options, timeoutMs: 2 })).toBe('timeout')
  await expect(settleNativeAdvisors({ ...f.options, read: async () => { throw new Error('offline') } })).rejects.toThrow('offline')
  expect(f.calls.every(value => ['thread/list', 'thread/read'].includes(value.method))).toBe(true)
})
test('再開ハンドシェイクの権限違いではturn/startを送らない', async () => {
  const f = fixture()
  await expect(resumeInterruptedNativeAdvisors({ ...f.options, read: async (method, params) => {
    const result = await f.options.read(method, params)
    return method === 'thread/resume' ? { ...result, approvalPolicy: 'on-request' } : result
  } })).rejects.toThrow('permissions mismatch')
  expect(f.calls.some(value => value.method === 'turn/start')).toBe(false)
})


test('別slotの再開障害でも完成済み本文を親promptへ復元する', async () => {
  const f = fixture(); f.complete()
  const review = registerNativeAdvisor({ contextPath: f.contextPath, attemptNonce: f.nonce,
    phase: 'review', round: 1, inputRevision: 1, inputDigest: f.digest, request: 'Review synthetic delta.' })
  const failed = structuredClone(f.child)
  failed.id = 'review-child'; failed.agentRole = 'risk_reviewer'
  failed.source.subAgent.thread_spawn.agent_role = 'risk_reviewer'
  failed.source.subAgent.thread_spawn.agent_path = review.agentPath
  failed.turns = [{ id: 'review-interrupted', status: 'interrupted', items: [] }]
  const warnings: string[] = []
  const answers = await recoverNativeAdvisorAnswers({ ...f.options,
    registrations: readNativeAdvisorRegistrations(f.contextPath, f.nonce),
    onWarning: kind => warnings.push(kind),
    read: async (method, params) => {
      if (method === 'thread/list') return { data: [f.child, failed], nextCursor: null }
      if (method === 'thread/read' && params.threadId === failed.id) return { thread: failed }
      if (method === 'thread/resume') throw new Error('authentication unavailable')
      return f.options.read(method, params)
    },
  })
  expect(warnings).toContain('child-resume-unavailable')
  expect(retainedNativeAdvisorPrompt(answers)).toContain('Independent result.')
  expect(answers.find(value => value.threadId === failed.id)?.response).toBeUndefined()
})
test('再中断でも同じ子と元依頼を復元し、モデル実行を二重送信しない', async () => {
  const f = fixture()
  const first = await recoverNativeAdvisorAnswers({ ...f.options, onWarning: () => {} })
  f.child.turns.push({ id: 'second-interrupted', status: 'interrupted', items: [] })
  const second = await recoverNativeAdvisorAnswers({ ...f.options, onWarning: () => {} })
  expect(first[0]?.threadId).toBe(second[0]?.threadId)
  expect(first[0]?.recoveryRequest).toBe(second[0]?.recoveryRequest)
  expect(f.calls.some(value => value.method === 'turn/start')).toBe(false)
})

test('別slotの登録破損を報告し、有効な元依頼と回答は保持する', async () => {
  const f = fixture(); f.complete()
  writeFileSync(`${f.contextPath}.native-review-1`, 'broken', { mode: 0o600 })
  const warnings: string[] = []
  const registrations = readNativeAdvisorRegistrations(f.contextPath, f.nonce, kind => warnings.push(kind))
  expect(warnings).toEqual(['registration-review-1-unavailable'])
  const answers = await recoverNativeAdvisorAnswers({ ...f.options, registrations, onWarning: kind => warnings.push(kind) })
  expect(answers[0]?.response).toContain('Independent result.')
})


test('先に読めた完成回答は別子thread/readの持続失敗でも親promptに残る', async () => {
  const f = fixture(); f.complete()
  const unreadable = { ...f.child, id: 'unreadable-child' }
  const warnings: string[] = []
  const options = { ...f.options, onWarning: (kind: string) => warnings.push(kind),
    read: async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/list') return { data: [f.child, unreadable], nextCursor: null }
      if (method === 'thread/read' && params.threadId === unreadable.id) throw new Error('persistent history failure')
      return f.options.read(method, params)
    },
  }
  const answers = await recoverNativeAdvisorAnswers(options)
  expect(answers).toHaveLength(1)
  expect(retainedNativeAdvisorPrompt(answers)).toContain('Independent result.')
  expect(warnings).toContain('child-read-unavailable')
  expect(await settleNativeAdvisors(options)).toBe('unavailable')
  expect(f.calls.some(value => ['thread/resume', 'turn/start'].includes(value.method))).toBe(false)
})


test('初回設定の永続化前に中断されmodel/effortがnullでも登録した値で復元する', async () => {
  const f = fixture(); f.child.model = null; f.child.reasoningEffort = null
  const recovered = await recoverNativeAdvisorAnswers({ ...f.options, onWarning: () => {} })
  expect(recovered[0]?.restored).toBe(true)
  const resumed = f.calls.find(value => value.method === 'thread/resume')!
  expect(resumed.params.model).toBe(f.registration.model)
  expect(resumed.params.config).toEqual({ model_reasoning_effort: f.registration.reasoningEffort })
  expect(f.calls.some(value => value.method === 'thread/start')).toBe(false)
})


test('roleが推論強度を正規化しても同じread-only子の復元を拒否しない', async () => {
  const f = fixture(); f.child.reasoningEffort = 'xhigh'
  const recovered = await recoverNativeAdvisorAnswers({ ...f.options, onWarning: () => {} })
  expect(recovered[0]?.restored).toBe(true)
  expect(f.calls.filter(value => value.method === 'thread/resume')).toHaveLength(1)
})

test('userMessageが公開されても登録済みのモデル情報を失わない', async () => {
  const f = fixture(); f.child.model = null; f.child.reasoningEffort = null
  f.child.turns[0].items = [{ type: 'userMessage', content: [{ type: 'text', text: f.registration.prompt }] }]
  const recovered = await recoverNativeAdvisorAnswers({ ...f.options, onWarning: () => {} })
  expect(recovered[0]?.restored).toBe(true)
})

test('nativeレビューの既定待機も有限で主処理を永久停止しない', async () => {
  const f = fixture(); f.child.turns[0].status = 'inProgress'
  const now = Date.now; let elapsed = 0; let settled = false
  Date.now = () => now() + elapsed
  try {
    const waiting = settleNativeAdvisors({ ...f.options, timeoutMs: undefined })
      .then(result => { settled = true; return result })
    elapsed = 3 * 60 * 60_000
    await Bun.sleep(15)
    expect(await waiting).toBe('timeout')
  } finally { Date.now = now; f.complete() }
})


test.each(['thread/list', 'thread/read'])('native回答の一時的な%s失敗は同じ観測を再試行する', async methodToFail => {
  const f = fixture(); f.complete()
  const transient = new Error('synthetic history timeout'); let failures = 4
  expect(await settleNativeAdvisors({ ...f.options,
    retryableReadError: error => error === transient,
    read: async (method, params) => {
      if (method === methodToFail && failures-- > 0) throw transient
      return f.options.read(method, params)
    },
  })).toBe('settled')
  expect(failures).toBeLessThanOrEqual(0)
  expect(f.calls.every(call => ['thread/list', 'thread/read'].includes(call.method))).toBe(true)
})
test('native履歴確認の再試行中もキャンセルで終了する', async () => {
  const f = fixture(); let cancelled = false
  expect(await settleNativeAdvisors({ ...f.options,
    interrupted: () => cancelled, retryableReadError: () => true,
    read: async () => { cancelled = true; throw new Error('synthetic timeout') },
  })).toBe('interrupted')
})

test('明示したnative履歴probe期限は通信再試行中にも適用する', async () => {
  const f = fixture()
  expect(await settleNativeAdvisors({ ...f.options, timeoutMs: 5,
    retryableReadError: () => true, read: async () => { throw new Error('synthetic timeout') },
  })).toBe('timeout')
})

// The production review failed before spawn solely because "bearer vs" matched
// a credential heuristic. Both registration and recovered answer must be exact.
test.each(['view bearer vs callback', 'Authorization: Bearer synthetic-example',
  'https://example.test/reports/view/rpt_' + 'a'.repeat(64) + '#' + 'b'.repeat(64),
  'Ａ案とＢ案：token=synthetic_example_123456789'])('content does not reject or rewrite native requests and answers: %s', async request => {
  const f = fixture()
  const registered = registerNativeAdvisor({ contextPath: f.contextPath, attemptNonce: f.nonce,
    phase: 'review', round: 1, inputRevision: 1, inputDigest: f.digest, request })
  expect(registered.prompt).toStartWith(request + '\n')
  const registrations = readNativeAdvisorRegistrations(f.contextPath, f.nonce)
  expect(registrations.find(value => value.phase === 'review')).toEqual(registered)
  expect(registerNativeAdvisor({ contextPath: f.contextPath, attemptNonce: f.nonce,
    phase: 'review', round: 1, inputRevision: 2, inputDigest: 'c'.repeat(64), request: 'later' })).toEqual(registered)
  f.complete()
  const response = request + '\n' + f.registration.marker
  f.child.turns[0].items[0].text = response
  expect((await readRetainedNativeAdvisors(f.options))[0]?.response).toBe(response)
})
