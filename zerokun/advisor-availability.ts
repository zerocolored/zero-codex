/** Stable user-facing classifications; raw CLI output never goes to Slack. */
export type AdvisorFailure = {
  advisor: 'codex' | 'grok' | 'claude'
  cause: 'authentication' | 'rate-limit' | 'timeout' | 'startup' | 'workspace' | 'response' | 'validation' | 'interrupted' | 'unknown'
}

export function classifyAdvisorFailure(advisor: AdvisorFailure['advisor'], reason: string): AdvisorFailure {
  const cause = /project is not a Git worktree or pinned workspace|workspace configuration/i.test(reason) ? 'workspace'
    : /rate.?limit|quota|at capacity|429/i.test(reason) ? 'rate-limit'
    : /\bnot (?:signed|logged) in\b|\bauthentication (?:required|failed|expired)\b|\balready be logged in\b|\bsubscription login (?:required|unavailable)\b/i.test(reason)
      ? 'authentication'
    : /helper snapshot failed|open failed|startup|could not start|prompt delivery failed|before.*prompt|before.*delivery|executable/i.test(reason) ? 'startup'
    : /timeout|timed out|deadline|exceeded.*acquisition/i.test(reason) ? 'timeout'
    : /response obtained but.*validation/i.test(reason) ? 'validation'
    : /response|marked|prompt delivery/i.test(reason) ? 'response' : 'unknown'
  return { advisor, cause }
}

/** Only these fixed, non-secret diagnostics are public, never raw CLI text. */
export const PUBLIC_ADVISOR_FAILURE_MESSAGES = new Set(
  (['codex', 'grok', 'claude'] as const).flatMap(advisor =>
    (['authentication', 'rate-limit', 'timeout', 'startup', 'workspace', 'response', 'validation', 'interrupted', 'unknown'] as const)
      .map(cause => advisorFailureMessage({ advisor, cause }))),
)

export function advisorFailureMessage(failure: AdvisorFailure): string {
  const name = { codex: 'GPT', grok: 'Grok', claude: 'Claude Code' }[failure.advisor]
  const detail = {
    authentication: '認証が必要です。このMacでログインを確認してください。',
    'rate-limit': '利用制限またはモデル混雑により回答を取得できません。',
    timeout: '回答取得が制限時間を超えました。',
    startup: '起動または依頼送信に失敗しました。',
    workspace: '作業フォルダの設定を認識できず、起動前に終了しました。',
    response: '完全な回答を取得できませんでした。',
    validation: '回答は届きましたが、取得後の確認を完了できませんでした。',
    interrupted: '実行の中断・切替によりレビューが中断され、回答の回収が完了していません。',
    unknown: '回答を取得できませんでした。原因の詳細は実行ログに保存しています。',
  }[failure.cause]
  return `${name}: ${detail}`
}
