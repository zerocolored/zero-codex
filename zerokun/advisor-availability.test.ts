import { expect, test } from 'bun:test'
import { advisorFailureMessage, classifyAdvisorFailure } from './advisor-availability.ts'
import { enforceHostAdvisorCoverage, type HostAdvisorCoverage } from './job-runner.ts'

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
  expect(result).toContain('設計・レビューは未完了')
  expect(result).toContain('Claude Code: 起動または依頼送信に失敗しました。')
  expect(result).toContain('取得済みの回答と作業は保持')
  expect(result).toContain('暫定の調査内容。')
  expect(result).not.toContain('process_identity')
})
