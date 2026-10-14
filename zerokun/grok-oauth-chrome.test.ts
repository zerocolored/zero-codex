import { expect, test } from 'bun:test'
import { driveGrokChrome, type GrokChromeControl } from './grok-oauth-chrome.ts'
import { GrokOAuthBrowserSession, advisorRecoveryProgress } from './grok-oauth-browser.ts'
import { grokChromeCapabilityForOverrides } from './codex-executor.ts'
import { realpathSync } from 'fs'
import { join } from 'path'

const ready = { originAllowed: true, titleMatches: true, grokBuildHeading: true,
  authorizeButtons: 1, authorizeName: 'Authorize', interactiveFields: false, forbiddenAction: false, ready: true }

async function flow(options: { zeroClick?: boolean; manual?: boolean; changedIds?: number[]; observation?: unknown;
  secondObservation?: unknown; ambiguousClick?: boolean; abortBeforeClick?: boolean;
  loading?: 'consent' | 'callback' | 'forbidden' | 'timeout'; delayedTab?: boolean;
  finalCallback?: boolean; finalNoClick?: boolean } = {}) {
  let stopped = false, ids = [11], clicks = 0, reads = 0, lists = 0
  const written: string[] = []
  const session = new GrokOAuthBrowserSession(() => { stopped = true }, true)
  const emit = (status: string) => session.feed(Buffer.from(JSON.stringify({ status }) + '\n'))
  session.connect(async line => {
    written.push(line.trim())
    if (line === 'baseline-ready\n') {
      ids = options.manual ? [11] : [11, 22]
      emit('oauth-browser-check-required')
    } else if (line === 'native-opened\n' || line === 'manual-open\n') {
      ids = options.changedIds ?? (options.delayedTab ? [11] : [11, 22])
      emit('oauth-browser-opened')
      if (options.zeroClick) emit('oauth-browser-verify-required')
    } else if (line === 'browser-verified\n') { emit('oauth-login-complete'); stopped = true }
  })
  const chrome: GrokChromeControl = {
    async ids() {
      if (++lists > 20) throw Error('test runaway')
      if (options.delayedTab && lists === 4) ids = [11, 22]
      return ids
    },
    async observe(id) {
      expect(id).toBe(22); reads++
      if (options.loading && (reads === 1 || options.loading === 'timeout')) {
        if (options.loading === 'callback') emit('oauth-browser-verify-required')
        return { ...ready, ready: false, authorizeButtons: 0, authorizeName: null, grokBuildHeading: false }
      }
      if (options.loading === 'forbidden') return { ...ready, ready: false, interactiveFields: true }
      if (options.abortBeforeClick && reads === 2) await session.respond(session.pending()!.requestId, 'abort', 'approval-denied')
      return reads === 2 && options.secondObservation ? options.secondObservation : options.observation ?? ready
    },
    async authorize(id, name) {
      expect(id).toBe(22); expect(name).toBe('Authorize'); clicks++
      if (options.ambiguousClick) throw Error('sensitive raw browser error must not escape')
      if (options.finalCallback || options.finalNoClick) return { clicked: false }
      emit('oauth-browser-verify-required'); return { clicked: true }
    },
    async close() {},
  }
  emit('oauth-browser-baseline-required')
  const progress = advisorRecoveryProgress(session.pending(), [])
  expect(progress.nextAction).toContain('ホスト')
  let time = 0
  await driveGrokChrome(session, chrome, () => stopped, async () => {
    time += 10_000
    if (options.finalCallback && clicks === 1 && session.pending()?.stage === 'authorize') emit('oauth-browser-verify-required')
  }, () => time)
  return { written, clicks, reads, failure: session.failureReason(), progress }
}

test.each([false, true])('configured Chrome completes existing/helper-open flow (manual=%s)', async manual => {
  const result = await flow({ manual })
  expect(result.written).toEqual(['baseline-ready', manual ? 'manual-open' : 'native-opened', 'browser-verified'])
  expect(result.clicks).toBe(1); expect(result.reads).toBe(2); expect(result.failure).toBeUndefined()
})
test('zero-click callback verifies only IDs and never reads authentication content', async () => {
  const result = await flow({ zeroClick: true })
  expect(result.clicks).toBe(0); expect(result.reads).toBe(0)
  expect(result.written.at(-1)).toBe('browser-verified')
})
test('manual open waits for a newly published tab without accepting a vanished known tab', async () => {
  const result = await flow({ manual: true, delayedTab: true })
  expect(result.failure).toBeUndefined(); expect(result.clicks).toBe(1)
  expect(result.written.at(-1)).toBe('browser-verified')
})
test('callback racing the final check completes without a repeated authorization operation', async () => {
  const result = await flow({ finalCallback: true })
  expect(result.failure).toBeUndefined(); expect(result.clicks).toBe(1)
  expect(result.written.at(-1)).toBe('browser-verified')
  const timeout = await flow({ finalNoClick: true })
  expect(timeout.clicks).toBe(1); expect(timeout.failure).toContain('unexpected-ui')
  const lostReply = await flow({ ambiguousClick: true, finalCallback: true })
  expect(lostReply.failure).toBeUndefined(); expect(lostReply.clicks).toBe(1)
  expect(lostReply.written.at(-1)).toBe('browser-verified')
})
test('delayed consent waits for two ready observations and delayed callback never clicks', async () => {
  const consent = await flow({ loading: 'consent' })
  expect(consent.clicks).toBe(1); expect(consent.reads).toBe(3); expect(consent.failure).toBeUndefined()
  const callback = await flow({ loading: 'callback' })
  expect(callback.clicks).toBe(0); expect(callback.written.at(-1)).toBe('browser-verified')
})
test.each(['forbidden', 'timeout'] as const)('loading stops on %s without input', async loading => {
  const result = await flow({ loading })
  expect(result.clicks).toBe(0); expect(result.failure).toContain('unexpected-ui')
})
test.each([{ changedIds: [11, 22, 33] }, { changedIds: [22] }, { changedIds: [11] }])('changed tabs abort without a click', async ({ changedIds }) => {
  const result = await flow({ changedIds })
  expect(result.clicks).toBe(0); expect(result.failure).toContain('tab-changed')
})
test.each([
  { originAllowed: false, ready: false }, { ...ready, interactiveFields: true },
  { ...ready, forbiddenAction: true }, { ...ready, authorizeButtons: 2 },
])('forbidden or ambiguous UI never receives input', async observation => {
  const result = await flow({ observation })
  expect(result.clicks).toBe(0); expect(result.failure).toContain('unexpected-ui')
})
test('UI drift and native approval denial suppress input', async () => {
  expect((await flow({ secondObservation: { ...ready, authorizeName: '許可' } })).clicks).toBe(0)
  const denied = await flow({ abortBeforeClick: true })
  expect(denied.clicks).toBe(0); expect(denied.failure).toContain('approval-denied')
})
test('ambiguous click is never retried and raw browser errors never escape', async () => {
  const result = await flow({ ambiguousClick: true })
  expect(result.clicks).toBe(1); expect(result.failure).toContain('browser-unavailable')
  expect(JSON.stringify(result)).not.toContain('sensitive')
})
test('only the validated host Chrome wrapper grants a per-process capability', () => {
  const binding = { jobId: 'job', attemptNonce: 'a', processNonce: 'b' }
  const config = (server: object) => [`mcp_servers=${JSON.stringify({ 'go-chrome-mcp': server }).replaceAll(':', '=')}`]
  // Use TOML inline tables, including explicit disabled/custom alternatives.
  const wrapper = { enabled: true, command: realpathSync(process.execPath),
    args: ['--config=/dev/null', '--no-env-file', join(import.meta.dir, 'chrome-session-broker.ts'), '/installed/mcp-broker.js'] }
  expect(grokChromeCapabilityForOverrides(config(wrapper), binding)).toMatchObject({ ...binding, entrypoint: '/installed/mcp-broker.js' })
  expect(grokChromeCapabilityForOverrides(config({ ...wrapper, enabled: false }), binding)).toBeUndefined()
  expect(grokChromeCapabilityForOverrides(config({ ...wrapper, args: ['/custom.js'] }), binding)).toBeUndefined()
  expect(grokChromeCapabilityForOverrides(['mcp_servers={}'], binding)).toBeUndefined()
})
