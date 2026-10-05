import { randomUUID } from 'crypto'
import { GROK_OAUTH_OBSERVATION_SCRIPT } from './grok-oauth-observation.ts'

export const GROK_BROWSER_ANSWERS = ['baseline-ready', 'native-opened', 'manual-open', 'browser-verified', 'abort'] as const
export type GrokBrowserAnswer = typeof GROK_BROWSER_ANSWERS[number]
export const GROK_BROWSER_ABORT_REASONS = ['approval-denied', 'interactive-login', 'unexpected-ui', 'tab-changed', 'browser-unavailable'] as const
export type GrokBrowserAbortReason = typeof GROK_BROWSER_ABORT_REASONS[number]
type Stage = 'baseline' | 'check' | 'authorize' | 'verify'
export function advisorRecoveryProgress(
  browser: ReturnType<GrokOAuthBrowserSession['pending']>,
  waitingForAuthentication: readonly unknown[],
) {
  return {
    ...(waitingForAuthentication.length ? { waitingForAuthentication } : {}),
    ...(browser ? {
      grokOAuthBrowser: browser,
      nextAction: browser.stage === 'authorize'
        ? 'grokOAuthBrowserの認可画面確認と最大1回のclickの指示を実行し、同じroundをpollしてください。この段階では成功応答を送信しません。中止が必要な場合だけabortを返してください。'
        : 'grokOAuthBrowserの指示を実行し、指定のfixed responseをadvisor_grok_oauth_respondへ一度返してください。新しいloginを起動しないでください。',
    } : waitingForAuthentication.length ? {
      nextAction: '認証状態の回復を待って自動再確認しています。この待機理由をユーザーへ一度だけ伝え、同じ依頼のpollを続けてください。ログイン操作や依頼の再送を繰り返さないでください。',
    } : {}),
  }
}
const instructions: Record<Stage, string> = {
  baseline: '公式Chrome controlで既存タブのopaque ID集合だけを保存し、baseline-readyを返してください。URL・title・本文・入力値は読まないでください。取得不能ならabort。',
  check: '保存したbaselineと現在のopaque ID集合を比較してください。既存IDの消失・複数増加・取得不能ならabort。新規1件ならnative-opened、0件ならmanual-openを一度だけ返してください。URL・title・本文はまだ読まないでください。',
  authorize: 'helper終了待ちを一度pollし、verify段階なら本文を読まず最終ID確認へ進んでください。まだ認可待ちの場合だけ、baselineから増えたexact 1件の同じtabを確認し、公式Chromeのtab.playwright.evaluateへobservationScriptを渡してください。返却は真偽値・件数・固定ボタン名のみです。本文全文・DOM snapshot・screenshot・URL全体・query・入力値・account情報は取得しません。ready=trueの同一結果を2回確認します。click直前にtab IDの同一性を再確認し、返されたauthorizeNameの一意なbutton locatorを作り、同じobservationScriptで全条件を再評価してください。最終結果が前回と同じready=trueの場合だけ、そのlocatorを他のbrowser操作を挟まず1回clickします。Authorizeと許可を推測で選ばずauthorizeNameを使ってください。Sign in・Continue・禁止UIや判断不能ならabort。clickの結果が曖昧なら再クリックせずpollしてください。',
  verify: 'Chrome controlで今回の新規タブがexact 1件で既存IDの消失がないことを確認し、browser-verifiedを返してください。URLや本文を追加取得しないでください。曖昧ならabort。Grokの正常終了だけでは実authへ反映されず、この確認後に公開されます。',
}

/** Only fixed status records and decisions cross this bridge. OAuth URLs and
 * credentials stay inside the fixed helper; browser observations stay in Codex.
 */
export class GrokOAuthBrowserSession {
  private buffer = ''
  private writer?: (line: string) => Promise<void>
  private sequence = 0
  private closed = false
  private abortReason?: GrokBrowserAbortReason
  private current?: { requestId: string; stage: Stage; nextAction: string }
  constructor(private readonly abortHelper: () => void) {}
  connect(write: (line: string) => Promise<void>) { this.writer = write }
  pending() { return this.current ? { ...this.current,
    ...(this.current.stage === 'authorize' ? { observationScript: GROK_OAUTH_OBSERVATION_SCRIPT } : {}),
  } : undefined }
  finish() { this.closed = true; this.current = undefined; this.writer = undefined }
  failureReason() { return this.abortReason ? `Grok OAuth browser recovery stopped: ${this.abortReason}` : undefined }
  private abort() { this.finish(); this.abortHelper() }
  private request(stage: Stage) { this.current = { requestId: randomUUID(), stage, nextAction: instructions[stage] } }
  feed(chunk: Uint8Array) {
    if (this.closed) return
    this.buffer += Buffer.from(chunk).toString('utf8')
    if (this.buffer.length > 4096) { this.abort(); return }
    while (this.buffer.includes('\n')) {
      const split = this.buffer.indexOf('\n')
      const line = this.buffer.slice(0, split); this.buffer = this.buffer.slice(split + 1)
      let status: string
      try {
        const value = JSON.parse(line)
        if (!value || Object.keys(value).length !== 1 || typeof value.status !== 'string') throw Error()
        status = value.status
      } catch { this.abort(); return }
      if (status === 'oauth-browser-baseline-required' && this.sequence === 0) { this.sequence = 1; this.request('baseline') }
      else if (status === 'oauth-browser-check-required' && this.sequence === 2) { this.sequence = 3; this.request('check') }
      else if (status === 'oauth-browser-opened' && this.sequence === 4) { this.sequence = 5; this.request('authorize') }
      else if (status === 'oauth-browser-verify-required' && this.sequence === 5) { this.sequence = 6; this.request('verify') }
      else if (status === 'oauth-login-complete' && this.sequence === 7) { this.sequence = 8; this.finish() }
      // A paired legacy helper can still complete a zero-click callback. It
      // has no response protocol, so never expose a browser action for it.
      else if (status === 'oauth-browser-opened' && this.sequence === 0) this.sequence = -1
      else if (status === 'oauth-login-complete' && this.sequence === -1) this.finish()
      else { this.abort(); return }
    }
  }
  async respond(requestId: string, answer: GrokBrowserAnswer, abortReason?: GrokBrowserAbortReason) {
    if (this.closed || !this.writer || this.current?.requestId !== requestId) throw Error('Grok browser request is no longer current')
    if (abortReason && (answer !== 'abort' || !GROK_BROWSER_ABORT_REASONS.includes(abortReason))) throw Error('Grok browser abort reason does not match response')
    if (answer === 'abort') { this.abortReason = abortReason; this.abort(); return }
    const stage = this.current.stage
    if (!((stage === 'baseline' && answer === 'baseline-ready')
      || (stage === 'check' && (answer === 'native-opened' || answer === 'manual-open'))
      || (stage === 'verify' && answer === 'browser-verified'))) throw Error('Grok browser response does not match the current request')
    this.current = undefined
    this.sequence++
    try { await this.writer(answer + '\n') } catch { this.abort(); throw Error('Grok browser response transport failed') }
  }
}
