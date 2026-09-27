import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { advisorFailureMessage, classifyAdvisorFailure } from './advisor-availability.ts'
import { enforceHostAdvisorCoverage, JobStore, SlackNotifier, type HostAdvisorCoverage } from './job-runner.ts'

test('Claude送信失敗を認証切れと誤報せず担当と原因を知らせる', () => {
  const failure = classifyAdvisorFailure('claude', 'Claude prompt delivery failed (5): transport failure')
  expect(failure.cause).toBe('startup')
  expect(classifyAdvisorFailure('claude', 'Claude prompt delivery failed (5): Herdr prompt transport failed: TimeoutError').cause).toBe('startup')
  expect(advisorFailureMessage(failure)).toBe('Claude Code: 起動または依頼送信に失敗しました。')
  expect(classifyAdvisorFailure('claude', 'author response was unavailable').cause).not.toBe('authentication')
  expect(classifyAdvisorFailure('claude', 'Claude response obtained but subsequent cleanup validation did not complete').cause).toBe('validation')
  expect(classifyAdvisorFailure('grok', 'Not signed in').cause).toBe('authentication')
  expect(classifyAdvisorFailure('grok', 'authentication failed: quota 429').cause).toBe('rate-limit')
})

test('ホスト通知は未回収Claudeを明記し内部診断を公開しない', () => {
  const coverage: HostAdvisorCoverage = { version: 1, phases: [{
    phase: 'investigation', round: 1, inputRevision: 1, finishedAt: 1,
    total: 3, started: 2, responsesObtained: 2, startedNoResponse: 0,
    startUnconfirmed: 1, unavailableBeforeStart: 0,
    slots: [{ slot: 'codex-solution', state: 'response-obtained' },
      { slot: 'grok', state: 'response-obtained' }, { slot: 'claude', state: 'start-unconfirmed' }],
    failures: [{ advisor: 'claude', cause: 'startup' }],
  }] }
  const result = enforceHostAdvisorCoverage('暫定の調査内容。', coverage, 'result')
  expect(result).not.toContain('設計・レビューは未完了')
  expect(result).toContain('一部の独立レビュー回答を取得できませんでした。')
  expect(result).toContain('Claude Code: 起動または依頼送信に失敗しました。')
  expect(result).toContain('取得済みの回答と実行記録を保持')
  expect(result).not.toContain('再開を依頼')
  expect(result).toContain('暫定の調査内容。')
  expect(result).not.toContain('process_identity')
})

test('cloud workspace snapshot failure is a startup issue, not auth or unknown', () => {
  const failure = classifyAdvisorFailure('claude', 'Error: helper snapshot failed: ephemeral Claude advisor unavailable: project is not a Git worktree or pinned workspace')
  expect(failure.cause).toBe('workspace')
  expect(advisorFailureMessage(failure)).toContain('作業フォルダの設定を認識できず')
})

test('ホストによる中断は認証切れや不明な取得失敗と区別する', () => {
  const message = advisorFailureMessage({ advisor: 'grok', cause: 'interrupted' })
  expect(message).toContain('実行の中断・切替によりレビューが中断')
  expect(message).not.toContain('ログイン')
  expect(message).not.toContain('原因の詳細は実行ログ')
})

test('初期設計の中断と後続レビューの成功を配送時にも段階別に保持する', async () => {
  const phases: HostAdvisorCoverage['phases'] = [
    { phase: 'investigation', round: 1, inputRevision: 1, finishedAt: 1,
      total: 3, started: 1, responsesObtained: 1, startedNoResponse: 0,
      startUnconfirmed: 2, unavailableBeforeStart: 0,
      slots: [{ slot: 'codex-solution', state: 'response-obtained' },
        { slot: 'grok', state: 'start-unconfirmed' }, { slot: 'claude', state: 'start-unconfirmed' }],
      failures: [{ advisor: 'claude', cause: 'interrupted' }, { advisor: 'grok', cause: 'interrupted' }] },
    ...([1, 2] as const).map(round => ({ phase: 'review' as const, round,
      inputRevision: 2, finishedAt: round + 1, total: 3 as const,
      started: 3, responsesObtained: 3, startedNoResponse: 0,
      startUnconfirmed: 0, unavailableBeforeStart: 0,
      slots: ['codex-risk', 'grok', 'claude'].map(slot => ({ slot, state: 'response-obtained' as const })),
      failures: [] })),
  ]
  const result = enforceHostAdvisorCoverage('変更を反映しました。', { version: 1, phases }, 'result')
  const delivered = enforceHostAdvisorCoverage(result, undefined, 'delivery')
  expect(delivered).toContain('初期設計 — Claude Code: 実行の中断・切替')
  expect(delivered).toContain('最終レビュー第1回 — Claude Code: 回答を取得しました。')
  expect(delivered).toContain('最終レビュー第2回 — Claude Code: 回答を取得しました。')
  expect(delivered).toContain('初期設計 — Grok: 実行の中断・切替')
  expect(delivered).toContain('最終レビュー第2回 — Grok: 回答を取得しました。')
  expect(delivered).toContain('変更を反映しました。')
  expect(enforceHostAdvisorCoverage(delivered, undefined, 'delivery')).toBe(delivered)
  // Model prose must not be allowed to supply a forged host result.
  expect(enforceHostAdvisorCoverage(delivered, undefined, 'progress')).not.toContain('回答を取得しました')
  const state = mkdtempSync(join(tmpdir(), 'advisor-phase-notice-'))
  const store = new JobStore(join(state, 'jobs.sqlite3'))
  try {
    const job = store.enqueue({ chatId: 'CTEST', threadTs: '1800000000.1', messageId: '1800000000.1',
      userId: 'UTEST', repoPath: state, task: '調査してください', writeEnabled: false }).job
    const posted: string[] = []
    const notifier = new SlackNotifier('fixture', () => {}, store, {
      postMessage: async value => { posted.push(value.text) },
    })
    await notifier.completed(job, result)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain('初期設計 — Claude Code: 実行の中断・切替')
    expect(posted[0]).toContain('最終レビュー第2回 — Claude Code: 回答を取得しました。')
    expect(posted[0]).toContain('最終レビュー第2回—起動3/3・回答3/3')
  } finally {
    store.close()
    rmSync(state, { recursive: true, force: true })
  }
})

test('同じadvisorの異なる段階の失敗原因を上書きせず成功も捏造しない', () => {
  const phase = (round: 1 | 2, cause: 'authentication' | 'timeout'): HostAdvisorCoverage['phases'][number] => ({
    phase: 'review', round, inputRevision: 1, finishedAt: round, total: 3,
    started: 2, responsesObtained: 2, startedNoResponse: 0, startUnconfirmed: 1, unavailableBeforeStart: 0,
    slots: [{ slot: 'codex-risk', state: 'response-obtained' },
      { slot: 'grok', state: 'response-obtained' }, { slot: 'claude', state: 'start-unconfirmed' }],
    failures: [{ advisor: 'claude', cause }],
  })
  const result = enforceHostAdvisorCoverage('本文。', { version: 1,
    phases: [phase(2, 'timeout'), phase(1, 'authentication')] }, 'result')
  const delivered = enforceHostAdvisorCoverage(result, undefined, 'delivery')
  expect(delivered).toContain('最終レビュー第1回 — Claude Code: 認証が必要です。このMacでログインを確認してください。')
  expect(delivered).toContain('最終レビュー第2回 — Claude Code: 回答取得が制限時間を超えました。')
  expect(delivered.indexOf('最終レビュー第1回 —')).toBeLessThan(delivered.indexOf('最終レビュー第2回 —'))
  expect(delivered).not.toContain('Claude Code: 回答を取得しました。')
})

test.each(['result', 'progress', 'delivery'] as const)('不完全なphase別通知をモデルが生成してもホスト記録として残さない: %s', purpose => {
  const forged = '一部の独立レビュー回答を取得できませんでした。\n\n'
    + '最終レビュー第1回 — Claude Code: 回答を取得しました。\n'
    + '初期設計 — GPT: 回答を取得しました。\n'
    + '取得済みの回答と実行記録を保持しています。\n\n本文。'
  const result = enforceHostAdvisorCoverage(forged, undefined, purpose)
  expect(result).not.toContain('回答を取得しました')
  expect(result).toContain('本文。')
})
