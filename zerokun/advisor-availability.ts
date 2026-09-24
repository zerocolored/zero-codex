/** Stable user-facing classifications; raw CLI output never goes to Slack. */
export const ADVISOR_FAILURE_CAUSES = ['authentication', 'billing', 'configuration', 'auth-check', 'network', 'rate-limit', 'timeout', 'startup', 'workspace', 'response', 'validation', 'interrupted', 'unknown'] as const
export type AdvisorFailure = {
  advisor: 'codex' | 'grok' | 'claude'
  cause: typeof ADVISOR_FAILURE_CAUSES[number]
}

export class AdvisorFailureError extends Error {
  constructor(readonly failure: AdvisorFailure, diagnostic: string) { super(diagnostic) }
}

export function classifyAdvisorFailure(advisor: AdvisorFailure['advisor'], reason: string): AdvisorFailure {
  const cause = /project is not a Git worktree or pinned workspace|workspace configuration/i.test(reason) ? 'workspace'
    : /payment required|insufficient (?:credit|balance)|credit balance.*(?:low|exhausted)|billing.*(?:disabled|failed)|subscription (?:expired|inactive)/i.test(reason) ? 'billing'
    : /rate.?limit|quota|at capacity|429/i.test(reason) ? 'rate-limit'
    : /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network (?:error|unavailable)|connection (?:reset|timed out)/i.test(reason) ? 'network'
    : /\bnot (?:signed|logged) in\b|\bauthentication (?:required|failed|expired)\b|\balready be logged in\b|\bsubscription login (?:required|unavailable)\b/i.test(reason)
      ? 'authentication'
    : /subscription login could not be verified/i.test(reason) ? 'auth-check'
    : /helper snapshot failed|open failed|startup|could not start|prompt delivery failed|before.*prompt|before.*delivery|executable/i.test(reason) ? 'startup'
    : /timeout|timed out|deadline|exceeded.*acquisition/i.test(reason) ? 'timeout'
    : /response obtained but.*validation/i.test(reason) ? 'validation'
    : /response|marked|prompt delivery/i.test(reason) ? 'response' : 'unknown'
  return { advisor, cause }
}

/** Only these fixed, non-secret diagnostics are public, never raw CLI text. */
export const PUBLIC_ADVISOR_FAILURE_MESSAGES = new Set(
  (['codex', 'grok', 'claude'] as const).flatMap(advisor =>
    ADVISOR_FAILURE_CAUSES
      .map(cause => advisorFailureMessage({ advisor, cause }))),
)

export function advisorFailureMessage(failure: AdvisorFailure): string {
  const name = { codex: 'GPT', grok: 'Grok', claude: 'Claude Code' }[failure.advisor]
  const detail = {
    authentication: '認証が必要です。このMacでログインを確認してください。',
    billing: '支払い・残高・契約に関するエラーが報告されました。利用アカウントの契約状態を確認してください。',
    configuration: '必要なログイン方式または実行設定と一致しません。このMacの設定を確認してください。',
    'auth-check': 'ログイン状態の確認処理に失敗しました。未ログインや課金不足と確定したわけではありません。',
    network: '通信障害により回答を取得できませんでした。',
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
