import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createWorker, type Env } from '../fleet-web/worker.ts'
import { FleetSenderClient } from './fleet-sender.ts'
import { startConfiguredFleet } from './fleet-runtime.ts'
import { FleetSessionExpired, projectFleetStatus } from './fleet-status.ts'
const installation = '10000000-0000-4000-8000-000000000001', instance = '20000000-0000-4000-8000-000000000001'
const botToken = 'xoxb-synthetic-bot-token'
const env: Env = { ASSETS: { fetch: async () => new Response('page') }, SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'public', FLEET_SPACE_ID: 'space', FLEET_GATEWAY_SECRET: 'gateway', FLEET_SLACK_TEAM_ID: 'TTEST' }
const facts = () => ({ running: 0, queued: 0, limited: false, approval: false, deferred: false, lastAcceptedAt: null, summary: null, summaryAt: null })
const snapshot = projectFleetStatus(facts(), { project: 'example', slackConnected: false, runnerHealthy: false, paused: false })
function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'fleet-sender-'))
  const calls: { url: string; body: any; auth: string | null }[] = []
  let team = 'TTEST', app = 'ATEST', user = 'UTEST', failReport = 0, now = Date.now()
  const worker = createWorker((async (url, init) => {
    const path = String(url), body = path.startsWith('https://slack.com/')
      ? Object.fromEntries(new URLSearchParams(String(init?.body))) : JSON.parse(String(init?.body))
    const auth = new Headers(init?.headers).get('authorization'); calls.push({ url: path, body, auth })
    expect(init?.redirect).toBe('manual')
    if (path.endsWith('/auth.test')) return Response.json({ ok: true, team_id: team, bot_id: 'BTEST', user_id: 'UTEST' })
    if (path.endsWith('/bots.info')) {
      expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
      expect(body.bot).toBe('BTEST')
      return Response.json({ ok: true, bot: { id: 'BTEST', app_id: app, user_id: user, name: 'test', deleted: false } })
    }
    if (path.endsWith('_sender_throttle')) return Response.json(true)
    if (path.endsWith('_sender_enroll')) return Response.json({ status: 200, instanceId: instance, expiresAt: now + 86400000 })
    if (path.endsWith('_sender_begin')) return Response.json({ status: 200, generation: 1 })
    if (path.endsWith('_sender_report')) return Response.json({ status: failReport || 200 })
    throw Error('unexpected endpoint')
  }) as typeof fetch)
  const fetcher = ((url: any, init: any) => worker.fetch(new Request(String(url), init), env)) as typeof fetch
  return { state, calls, worker, fetcher, now: () => now, advance() { now += 1000000 },
    setTeam(x: string) { team = x }, setApp(x: string) { app = x }, setUser(x: string) { user = x }, fail(x: number) { failReport = x },
    cleanup() { rmSync(state, { recursive: true, force: true }) } }
}
test('fresh PC without Supabase auth enrolls, sends, persists only scoped credential and reuses it', async () => {
  const f = fixture()
  try {
    let client = new FleetSenderClient(f.state, installation, 'ATEST', botToken, f.fetcher, f.now)
    const started = await client.begin(); await client.send(started.generation, 1, snapshot)
    const file = join(f.state, 'fleet-sender-credential.json'), saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(saved.token).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(file, 'utf8')).not.toContain(botToken)
    const enroll = f.calls.find(c => c.url.endsWith('_sender_enroll'))!
    expect(enroll.body.p_hash).toBe(new Bun.CryptoHasher('sha256').update(saved.token).digest('hex'))
    expect(JSON.stringify(enroll)).not.toContain(botToken)
    client = new FleetSenderClient(f.state, installation, 'ATEST', botToken, f.fetcher, f.now)
    await client.begin()
    expect(f.calls.filter(c => c.url.endsWith('/auth.test'))).toHaveLength(1)
    expect(existsSync(join(f.state, 'cloud-auth.json'))).toBe(false)
  } finally { f.cleanup() }
})
for (const scenario of ['team', 'app', 'user']) test(`rejects mismatched Slack ${scenario} before enrollment`, async () => {
  const f = fixture()
  try {
    if (scenario === 'team') f.setTeam('TOTHER'); if (scenario === 'app') f.setApp('AOTHER'); if (scenario === 'user') f.setUser('UOTHER')
    await expect(new FleetSenderClient(f.state, installation, 'ATEST', botToken, f.fetcher).begin()).rejects.toThrow()
    expect(f.calls.some(c => c.url.endsWith('_sender_enroll'))).toBe(false)
  } finally { f.cleanup() }
})
test('running gateway renews expired credential and recovers sequence without restart', async () => {
  const f = fixture()
  const reporter = startConfiguredFleet(f.state, 'ATEST', '/private/project', facts, () => true,
    { home: f.state, botToken, fetcher: f.fetcher, now: f.now, warn: () => {} })!
  try {
    await reporter.tick(); f.fail(401); f.advance(); await reporter.tick()
    f.fail(0); f.advance(); await reporter.tick()
    expect(f.calls.filter(c => c.url.endsWith('/auth.test'))).toHaveLength(2)
    expect(f.calls.filter(c => c.url.endsWith('_sender_report')).at(-1)!.body.p_sequence).toBe(1)
    expect(JSON.parse(readFileSync(join(f.state, 'fleet.json'), 'utf8')).transport).toBe('slack')
  } finally { reporter.stop(); f.cleanup() }
})
test('stale generation triggers new begin, not Slack credential rotation', async () => {
  const f = fixture(); const client = new FleetSenderClient(f.state, installation, 'ATEST', botToken, f.fetcher)
  try { await client.begin(); f.fail(409); await expect(client.send(1, 2, snapshot)).rejects.toBeInstanceOf(FleetSessionExpired)
    f.fail(0); await client.begin(); expect(f.calls.filter(c => c.url.endsWith('/auth.test'))).toHaveLength(1)
  } finally { f.cleanup() }
})
test('sender does not use browser session; rejects oversized body and invalid token type', async () => {
  const f = fixture(); const url = 'https://example.com/api/sender/enroll'
  try {
    const request = (body: string, headers: Record<string, string> = {}) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
    expect((await f.worker.fetch(request('{}', { origin: 'https://example.com' }), env)).status).toBe(403)
    expect((await f.worker.fetch(request('x'.repeat(13000)), env)).status).toBe(400)
    expect((await f.worker.fetch(request(JSON.stringify({ installationId: installation, appId: 'ATEST' }), { authorization: 'Bearer xoxp-synthetic-user' }), env)).status).toBe(400)
    expect(f.calls).toHaveLength(0)
  } finally { f.cleanup() }
})
test('network failure has bounded timeout and never follows redirects carrying credentials', async () => {
  const f = fixture()
  try {
    const fetcher = (async (_url: any, init: any) => { expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal); throw Error('offline') }) as typeof fetch
    await expect(new FleetSenderClient(f.state, installation, 'ATEST', botToken, fetcher).begin()).rejects.toThrow('offline')
    expect(existsSync(join(f.state, 'fleet-sender-credential.json'))).toBe(false)
  } finally { f.cleanup() }
})
