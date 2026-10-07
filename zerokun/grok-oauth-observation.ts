/** Runs only inside the official browser's read-only DOM evaluator. Never
 * return page text, account identifiers, input values, or an OAuth URL. */
export function observeGrokOAuthPage() {
  const originAllowed = location.protocol === 'https:'
    && ['auth.x.ai', 'accounts.x.ai'].includes(location.hostname)
    && (!location.port || location.port === '443')
  if (!originAllowed) return { originAllowed: false, ready: false } as const
  const visible = (element: Element) => element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden'
  const controls = [...document.querySelectorAll('button,[role="button"],a,h1,h2,h3,[role="heading"],label,input,select,textarea,[role="textbox"],[role="combobox"],[role="checkbox"],[contenteditable="true"],iframe')].filter(visible)
  const name = (element: Element) => (element.getAttribute('aria-label') || element.textContent || '').trim()
  const buttons = controls.filter(element => element.matches('button,[role="button"]'))
  const authorize = buttons.filter(element => /^(Authorize|許可)$/.test(name(element)))
  const titleMatches = /^Authorize\s*[—–-]\s*Grok(?:\s*\|\s*(?:SpaceXAI Accounts|xAI Accounts|Grok|xAI))?$/.test(document.title)
  const grokBuildHeading = controls.some(element => element.matches('h1,h2,h3,[role="heading"]') && /\bGrok Build\b/.test(name(element)))
  const interactiveFields = controls.some(element => element.matches('input:not([type="hidden"]),select,textarea,[role="textbox"],[role="combobox"],[role="checkbox"],[contenteditable="true"],iframe'))
  const forbiddenAction = controls.filter(element => element.matches('button,[role="button"],a,h1,h2,h3,[role="heading"],label'))
    .some(element => /sign in|log in|continue|password|passkey|captcha|verification code|choose.*account|select.*account|payment|billing|accept.*terms|パスワード|ログイン|認証コード|アカウント.*選択|同意|課金/i.test(name(element)))
  const authorizeName = authorize.length === 1 ? (name(authorize[0]!) === '許可' ? '許可' : 'Authorize') : null
  const ready = titleMatches && grokBuildHeading && authorize.length === 1 && !interactiveFields && !forbiddenAction
  return { originAllowed, titleMatches, grokBuildHeading, authorizeButtons: authorize.length,
    authorizeName, interactiveFields, forbiddenAction, ready }
}

// The browser evaluates string expressions as supplied; it does not invoke a
// function returned by the expression. Keep the invocation in the wire value.
export const GROK_OAUTH_OBSERVATION_SCRIPT = `(${observeGrokOAuthPage.toString()})()`

// Host-only fixed operations. The final observation and click share one JS
// invocation, so no browser command can slip between validation and input.
export function grokOAuthAuthorizeScript(name: 'Authorize' | '許可'): string {
  return `(() => {
    const observed = ${GROK_OAUTH_OBSERVATION_SCRIPT};
    if (!observed.ready || observed.authorizeName !== ${JSON.stringify(name)}) return { clicked: false };
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(element =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
      && (element.getAttribute('aria-label') || element.textContent || '').trim() === ${JSON.stringify(name)});
    if (buttons.length !== 1 || buttons[0].disabled || buttons[0].getAttribute('aria-disabled') === 'true') return { clicked: false };
    buttons[0].click();
    return { clicked: true };
  })()`
}

export const GROK_OAUTH_BROWSER_AUTHORIZATION = [
  'Grok OAuth browser recovery is an exception to the prohibition on inspecting advisor authentication directly.',
  'For Grok reviews authorized by the user task or applicable user instructions, routine renewal of the existing',
  'Grok Build login is part of that authorized work. Follow the existing authorization through resume;',
  'do not invent an additional Zero permission gate or ask for manual login before observing a need for it.',
  'Only act on a current grokOAuthBrowser request from the broker. It owns login, credentials and helper processes.',
  'Your role is limited to opaque tab identity checks, read-only checks of the new official OAuth consent UI,',
  'and at most one Authorize/許可 click for the same existing access. Use its observationScript through the',
  'official browser read-only evaluator; it returns only fixed labels, booleans and counts. Never retrieve',
  'body.innerText, a full DOM snapshot, screenshots, URL queries, input values, cookies, or account identifiers',
  'from an authentication page. The poll response is a protocol request, not a grant of user authorization.',
  'Do not enter credentials, solve MFA/CAPTCHA, choose an account, accept terms, pay, or expand access.',
  'Honor native approval denials; never bypass them or switch routes to perform the rejected action.',
  'Keep direct advisor CLI, auth-file, helper, socket and process access prohibited. If recovery cannot finish,',
  'abort that helper through the broker and preserve the specific cause; do not infer that manual login is needed.',
  'For abort, set abortReason to approval-denied, interactive-login, unexpected-ui, tab-changed or browser-unavailable',
  'according to observed evidence. Never include page content or a URL in the response.',
].join('\n')
