import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { homedir } from 'os'
import { join } from 'path'
import { ChromeSession } from './chrome-session-broker.ts'
import type { GrokOAuthBrowserSession, GrokBrowserAbortReason } from './grok-oauth-browser.ts'

/** The parent writes this only after validating the effective browser config.
 * An explicitly disabled/custom transport never creates this capability. */
export type GrokChromeCapability = {
  version: 1; jobId: string; attemptNonce: string; processNonce: string; entrypoint: string
}

function decoded(result: CallToolResult): unknown {
  if (result.isError || result.content.length !== 1 || result.content[0]?.type !== 'text') throw Error('browser-unavailable')
  let value: unknown = result.content[0].text
  for (let i = 0; i < 3 && typeof value === 'string'; i++) value = JSON.parse(value)
  return value
}

export interface GrokChromeControl {
  ids(): Promise<number[]>
  observe(tabId: number): Promise<unknown>
  authorize(tabId: number, name: 'Authorize' | '許可'): Promise<unknown>
  close(): Promise<void>
}

export async function connectGrokChrome(entrypoint: string): Promise<GrokChromeControl> {
  const client = new Client({ name: 'zerochan-grok-oauth', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: 'node',
    args: [join(import.meta.dir, 'browser-mcp-proxy.mjs'), entrypoint], stderr: 'pipe' })
  transport.stderr?.on('data', () => {})
  try { await client.connect(transport) } catch { await transport.close(); throw Error('browser-unavailable') }
  const chrome = new ChromeSession(async (name, args) =>
    await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 }) as CallToolResult,
  join(homedir(), '.codex', 'zerochan-browser-locks'))
  return {
    async ids() {
      const tabs = decoded(await chrome.run('tabs_list', {}))
      if (!Array.isArray(tabs) || tabs.length > 10_000) throw Error('browser-unavailable')
      // Discard titles/URLs inside the host; only opaque identities cross the
      // recovery protocol. Never serialize raw MCP failures or tab records.
      const ids = tabs.map(tab => tab?.id ?? tab?.tabId)
      if (!ids.every(id => Number.isSafeInteger(id) && id > 0) || new Set(ids).size !== ids.length) throw Error('browser-unavailable')
      return ids
    },
    async observe(id) { return decoded(await chrome.oauth('observe', id)) },
    async authorize(id, name) { return decoded(await chrome.oauth(name, id)) },
    async close() {
      try { await chrome.finish() } finally { await client.close(); chrome.close() }
    },
  }
}

function readyName(value: unknown): 'Authorize' | '許可' | undefined {
  if (!value || typeof value !== 'object') return
  const v = value as Record<string, unknown>
  if (v.originAllowed === true && v.titleMatches === true && v.grokBuildHeading === true
    && v.authorizeButtons === 1 && v.interactiveFields === false && v.forbiddenAction === false
    && v.ready === true && (v.authorizeName === 'Authorize' || v.authorizeName === '許可')) return v.authorizeName
}

/** One helper lifecycle, one baseline and at most one click. No model-supplied
 * JS, selector, tab, URL, or account data is accepted. */
export async function driveGrokChrome(browser: GrokOAuthBrowserSession, chrome: GrokChromeControl,
  stopped: () => boolean, pause: () => Promise<void> = () => Bun.sleep(100), now = Date.now): Promise<void> {
  let baseline: number[] | undefined
  let target: number | undefined
  let clicked = false
  let loadingDeadline: number | undefined
  let callbackDeadline: number | undefined
  let callbackFailure: GrokBrowserAbortReason = 'unexpected-ui'
  const handled = new Set<string>()
  const freshTab = async (allowNone = false) => {
    const ids = await chrome.ids()
    if (!baseline || baseline.some(id => !ids.includes(id))) throw Error('tab-changed')
    const added = ids.filter(id => !baseline!.includes(id))
    if (added.length > 1 || (!allowNone && added.length !== 1)
      || (target !== undefined && added[0] !== target)) throw Error('tab-changed')
    if (added.length === 1) target = added[0]
    return added.length
  }
  while (!stopped()) {
    await pause() // Let an immediate callback advance authorize -> verify first.
    const request = browser.pending()
    if (!request || stopped()) continue
    if (handled.has(request.requestId)) {
      if (request.stage === 'authorize' && callbackDeadline !== undefined && now() >= callbackDeadline) {
        await browser.respond(request.requestId, 'abort', callbackFailure)
      }
      continue
    }
    handled.add(request.requestId)
    const current = () => !stopped() && browser.pending()?.requestId === request.requestId
    try {
      if (request.stage === 'baseline') {
        baseline = await chrome.ids()
        if (current()) await browser.respond(request.requestId, 'baseline-ready')
      } else if (request.stage === 'check') {
        const count = await freshTab(true)
        if (current()) await browser.respond(request.requestId, count ? 'native-opened' : 'manual-open')
      } else if (request.stage === 'verify') {
        await freshTab()
        if (current()) await browser.respond(request.requestId, 'browser-verified')
      } else {
        loadingDeadline ??= now() + 30_000
        const count = await freshTab(target === undefined)
        if (!count) {
          // osascript may acknowledge opening before Chrome publishes the tab.
          // Never tolerate the disappearance of an already identified target.
          if (now() >= loadingDeadline) throw Error('tab-changed')
          handled.delete(request.requestId)
          continue
        }
        if (!current()) continue
        const first = await chrome.observe(target!)
        const name = readyName(first)
        if (!name) {
          const observed = first as Record<string, unknown> | null
          // Opening a Chrome tab does not imply that its SPA has rendered.
          // Wait only on the official origin with no input/forbidden controls
          // and no consent button yet. Recheck identities on every iteration;
          // the helper may advance to verify without any click meanwhile.
          if (observed?.originAllowed === true && observed.interactiveFields === false
            && observed.forbiddenAction === false && observed.authorizeButtons === 0
            && now() < loadingDeadline) {
            handled.delete(request.requestId)
            continue
          }
          throw Error('unexpected-ui')
        }
        await pause()
        if (!current()) continue
        await freshTab()
        const second = await chrome.observe(target!)
        if (readyName(second) !== name || JSON.stringify(first) !== JSON.stringify(second)) throw Error('unexpected-ui')
        await freshTab()
        if (!current() || clicked) continue
        clicked = true // Includes delivery-possible failures: never click twice.
        let result: unknown
        try { result = await chrome.authorize(target!, name) } catch {
          // Delivery may have happened despite a lost browser reply. Let the
          // fixed helper report completion; never send another authorization.
          callbackDeadline = now() + 30_000
          callbackFailure = 'browser-unavailable'
          continue
        }
        if (!result || typeof result !== 'object' || typeof (result as { clicked?: unknown }).clicked !== 'boolean') {
          callbackDeadline = now() + 30_000
          callbackFailure = 'browser-unavailable'
          continue
        }
        if ((result as { clicked: boolean }).clicked === false) {
          // An already authorized callback can replace consent between the
          // stable reads and final check. No input was sent; await the helper's
          // verify request briefly, without another click or page inspection.
          callbackDeadline = now() + 30_000
        }
      }
    } catch (error) {
      if (!current()) continue
      const reason: GrokBrowserAbortReason = error instanceof Error && error.message === 'tab-changed' ? 'tab-changed'
        : error instanceof Error && error.message === 'unexpected-ui' ? 'unexpected-ui' : 'browser-unavailable'
      await browser.respond(request.requestId, 'abort', reason)
    }
  }
}
