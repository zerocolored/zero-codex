import { expect, test } from 'bun:test'
import { GrokOAuthBrowserSession, advisorRecoveryProgress } from './grok-oauth-browser.ts'
import { grokOAuthCompletionOutput, runBounded } from './advisor-broker.ts'

function fixture() {
  let aborted = 0
  const written: string[] = []
  const session = new GrokOAuthBrowserSession(() => aborted++)
  session.connect(async value => { written.push(value) })
  const emit = (status: string) => session.feed(Buffer.from(JSON.stringify({ status }) + '\n'))
  return { session, emit, written, aborted: () => aborted }
}

test('native browser flow needs baseline and final verification, and never requests a duplicate open', async () => {
  const f = fixture()
  f.emit('oauth-browser-baseline-required')
  const baseline = f.session.pending()!
  expect(baseline.stage).toBe('baseline')
  await f.session.respond(baseline.requestId, 'baseline-ready')
  await expect(f.session.respond(baseline.requestId, 'baseline-ready')).rejects.toThrow('no longer current')
  f.emit('oauth-browser-check-required')
  await f.session.respond(f.session.pending()!.requestId, 'native-opened')
  f.emit('oauth-browser-opened')
  expect(f.session.pending()!.stage).toBe('authorize')
  const progress = advisorRecoveryProgress(f.session.pending(), [{ advisor: 'claude', cause: 'authentication' }])
  expect(progress.nextAction).toContain('click')
  expect(progress.nextAction).toContain('成功応答を送信しません')
  expect(progress.nextAction).not.toContain('fixed response')
  f.emit('oauth-browser-verify-required')
  await f.session.respond(f.session.pending()!.requestId, 'browser-verified')
  f.emit('oauth-login-complete')
  expect(f.session.pending()).toBeUndefined()
  expect(f.written).toEqual(['baseline-ready\n', 'native-opened\n', 'browser-verified\n'])
  expect(f.aborted()).toBe(0)
})

test('wrong-stage response cannot advance the helper and abort terminates only this recovery', async () => {
  const f = fixture(); f.emit('oauth-browser-baseline-required')
  await expect(f.session.respond(f.session.pending()!.requestId, 'manual-open')).rejects.toThrow('does not match')
  expect(f.written).toEqual([])
  await f.session.respond(f.session.pending()!.requestId, 'abort')
  expect(f.aborted()).toBe(1)
  expect(f.session.pending()).toBeUndefined()
})

test('Claude authentication wait preserves the actionable Grok browser request', () => {
  const f = fixture(); f.emit('oauth-browser-baseline-required')
  const waiting = [{ advisor: 'claude', cause: 'authentication' }]
  const progress = advisorRecoveryProgress(f.session.pending(), waiting)
  expect(progress.grokOAuthBrowser?.stage).toBe('baseline')
  expect(progress.nextAction).toContain('advisor_grok_oauth_respond')
  expect(progress.waitingForAuthentication).toEqual(waiting)
  expect(advisorRecoveryProgress(undefined, waiting).nextAction).toContain('poll')
  expect(advisorRecoveryProgress(undefined, []).nextAction).toBeUndefined()
})

test('fragmented records work; repeated or unexpected output cannot trigger browser actions', () => {
  const f = fixture()
  for (const byte of Buffer.from('{"status":"oauth-browser-baseline-required"}\n')) f.session.feed(Uint8Array.of(byte))
  expect(f.session.pending()!.stage).toBe('baseline')
  f.emit('oauth-browser-baseline-required')
  expect(f.aborted()).toBe(1)
  const g = fixture(); g.session.feed(Buffer.from('{"status":"oauth-browser-baseline-required","url":"fixture"}\n'))
  expect(g.aborted()).toBe(1); expect(g.session.pending()).toBeUndefined()
})

test('completion parser accepts the complete new protocol and rejects missing verification', () => {
  const statuses = ['oauth-browser-baseline-required', 'oauth-browser-check-required', 'oauth-browser-opened', 'oauth-browser-verify-required', 'oauth-login-complete']
  const output = (values: string[]) => values.map(status => JSON.stringify({ status })).join('\n')
  expect(grokOAuthCompletionOutput(output(statuses))).toBe(true)
  expect(grokOAuthCompletionOutput(output(statuses.filter(s => s !== 'oauth-browser-verify-required')))).toBe(false)
})

test('real bounded child completes browser handshake and cleans up', async () => {
  const abort = new AbortController()
  const session = new GrokOAuthBrowserSession(() => abort.abort())
  const program = `
    process.stdin.setEncoding('utf8'); let n=0;
    const emit=status=>console.log(JSON.stringify({status}));
    const expected=['baseline-ready','native-opened','browser-verified'];
    process.stdin.on('data', input=>{
      if(input!==expected[n]+'\\n')process.exit(2);
      n++;
      if(n===1)emit('oauth-browser-check-required');
      if(n===2){emit('oauth-browser-opened');emit('oauth-browser-verify-required')}
      if(n===3){emit('oauth-login-complete');process.exit(0)}
    }); emit('oauth-browser-baseline-required');`
  const responses: Promise<void>[] = []
  const result = await runBounded([process.execPath, '-e', program], {
    timeoutMs: 2_000, signal: abort.signal, onStdin: write => session.connect(write),
    onStdout: chunk => {
      session.feed(chunk)
      const request = session.pending()
      if (!request) return
      const answer = { baseline: 'baseline-ready', check: 'native-opened', verify: 'browser-verified' } as const
      if (request.stage !== 'authorize') responses.push(session.respond(request.requestId, answer[request.stage]))
    },
  })
  await Promise.all(responses)
  expect(result.exitCode).toBe(0); expect(result.timedOut).toBe(false)
  expect(result.forcedCleanup).toBe(false)
  expect(grokOAuthCompletionOutput(result.stdout)).toBe(true)
  expect(session.pending()).toBeUndefined()
  expect(responses).toHaveLength(3)
})
