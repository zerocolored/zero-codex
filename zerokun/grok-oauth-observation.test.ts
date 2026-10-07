import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { GROK_OAUTH_OBSERVATION_SCRIPT, grokOAuthAuthorizeScript } from './grok-oauth-observation.ts'

function element(tag: string, text = '', attrs: Record<string, string> = {}, shown = true) {
  const matches = (selector: string) => selector.split(',').some(part => {
    if (part === 'input:not([type="hidden"])') return tag === 'input' && attrs.type !== 'hidden'
    const attr = /^\[([^=]+)="([^"]+)"\]$/.exec(part)
    return attr ? attrs[attr[1]!] === attr[2] : part === tag
  })
  return { textContent: text, getAttribute: (name: string) => attrs[name] ?? null,
    matches, getClientRects: () => shown ? [{}] : [],
    get value(): never { throw Error('input values must never be read') } }
}
function observe(options: { origin?: string; title?: string; label?: string; extra?: ReturnType<typeof element>[]; heading?: string } = {}) {
  const u = new URL(options.origin ?? 'https://accounts.x.ai')
  const document = {
    title: options.title ?? 'Authorize — Grok | SpaceXAI Accounts',
    querySelectorAll: () => [element('h1', options.heading ?? 'Authorize Grok Build'), element('button', options.label ?? '許可'), ...(options.extra ?? [])],
    get body(): never { throw Error('whole page must never be read') },
    get cookie(): never { throw Error('credentials must never be read') },
  }
  return runInNewContext(GROK_OAUTH_OBSERVATION_SCRIPT, {
    document, location: { protocol: u.protocol, hostname: u.hostname, port: u.port,
      get href(): never { throw Error('OAuth URL must never be read') } },
    getComputedStyle: () => ({ visibility: 'visible' }),
  })
}

test.each(['Authorize', '許可'])('real consent shape returns only structural facts and the exact %s locator name', label => {
  const result = observe({ label, extra: [element('input', '', { type: 'hidden' }), element('p', 'private-account@example.invalid')] })
  expect(result).toEqual({ originAllowed: true, titleMatches: true, grokBuildHeading: true,
    authorizeButtons: 1, authorizeName: label, interactiveFields: false, forbiddenAction: false, ready: true })
  expect(JSON.stringify(result)).not.toContain('private-account')
})

test('unrelated origin short circuits without inspecting its document', () => {
  const result = runInNewContext(GROK_OAUTH_OBSERVATION_SCRIPT, {
    location: { protocol: 'https:', hostname: 'example.invalid', port: '' },
    get document(): never { throw Error('foreign document read') },
  })
  expect(result).toEqual({ originAllowed: false, ready: false })
  expect(observe({ origin: 'http://accounts.x.ai' }).ready).toBe(false)
  expect(observe({ origin: 'https://accounts.x.ai:444' }).ready).toBe(false)
})

test.each([
  element('input', '', { type: 'password' }), element('input', '', { type: 'email' }),
  element('input', '', { autocomplete: 'one-time-code' }), element('select'), element('iframe'),
  element('div', '', { role: 'combobox' }), element('div', '', { role: 'checkbox' }),
  element('button', 'Continue'), element('button', 'Choose account'),
  element('button', 'Accept terms'), element('button', 'パスワードでログイン'),
])('interactive or additional authorization UI prevents authorization %#', extra => {
  expect(observe({ extra: [extra] }).ready).toBe(false)
})

test('wrong title, wrong app and duplicate buttons never become ready', () => {
  expect(observe({ title: 'Sign in' }).ready).toBe(false)
  expect(observe({ heading: 'Another app' }).ready).toBe(false)
  const duplicate = observe({ extra: [element('button', 'Authorize')] })
  expect(duplicate.ready).toBe(false); expect(duplicate.authorizeName).toBeNull()
})

test.each(['Authorize', '許可'] as const)('final %s operation rechecks current UI before one click', name => {
  let clicks = 0
  let forbidden = false
  const button = Object.assign(Object.create(element('button', name)), { click: () => { clicks++ } })
  const context = {
    location: { protocol: 'https:', hostname: 'auth.x.ai', port: '',
      get href(): never { throw Error('must not read OAuth URL') } },
    document: { title: 'Authorize — Grok', querySelectorAll: (selector: string) => selector === 'button,[role="button"]'
      ? [button] : [element('h1', 'Authorize Grok Build'), button, ...(forbidden ? [element('input', '', { type: 'password' })] : [])] },
    getComputedStyle: () => ({ visibility: 'visible' }),
  }
  const script = grokOAuthAuthorizeScript(name)
  forbidden = true
  expect(runInNewContext(script, context)).toEqual({ clicked: false })
  expect(clicks).toBe(0)
  forbidden = false
  expect(runInNewContext(script, context)).toEqual({ clicked: true })
  expect(clicks).toBe(1)
  expect(runInNewContext(grokOAuthAuthorizeScript(name === 'Authorize' ? '許可' : 'Authorize'), context)).toEqual({ clicked: false })
  expect(clicks).toBe(1)
})
