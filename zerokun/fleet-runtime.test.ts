import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startConfiguredFleet, fleetIsOff, discoverFleetAuth } from './fleet-runtime.ts'
import { registerSlackApp } from './slack-app-registry.ts'
import { configureFleet } from './fleet-setup.ts'

const facts = () => ({ running: 0, queued: 0, limited: false, approval: false, deferred: false,
  lastAcceptedAt: null, summary: null, summaryAt: null })
const scope = '10000000-0000-4000-8000-000000000001'
const instance = '20000000-0000-4000-8000-000000000001'
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'fleet-auto-')), state = join(home, 'state'), auth = join(home, 'auth')
  mkdirSync(state, { mode: 0o700 }); mkdirSync(auth, { mode: 0o700 })
  registerSlackApp('ANEW', state, home); registerSlackApp('AAUTH', auth, home)
  const login = (dir = auth) => writeFileSync(join(dir, 'cloud-auth.pending.json'), JSON.stringify({ version: 1,
    url: 'https://test.supabase.co', publishableKey: 'synthetic-public-key-value', accessToken: 'synthetic-access-token-value' }), { mode: 0o600 })
  let now = 0, offline = false
  const calls: { method: string; body: any }[] = []
  const fetcher = (async (url: any, init: any) => {
    const method = String(url).split('zerochan_fleet_')[1]!
    calls.push({ method, body: JSON.parse(init.body) })
    if (offline) throw Error('network down')
    return Response.json(method === 'context' ? scope : method === 'register' ? instance : method === 'begin' ? 1 : true)
  }) as typeof fetch
  const options = { teamId: 'TTEST', name: 'New bot', home, fetcher, now: () => now, warn: () => {} }
  return { home, state, auth, login, calls, options, advance() { now += 1_000_000 }, offline(value: boolean) { offline = value },
    cleanup() { rmSync(home, { recursive: true, force: true }) } }
}
test('unconfigured app registers and reports; restart reuses registration and auth file', async () => {
  const f = fixture(); f.login()
  let reporter = startConfiguredFleet(f.state, 'ANEW', '/private/project', facts, () => true, f.options)!
  try {
    await reporter.tick()
    expect(f.calls.map(c => c.method)).toEqual(['context', 'register', 'begin', 'report'])
    const saved = JSON.parse(readFileSync(join(f.state, 'fleet.json'), 'utf8'))
    expect(saved.instanceId).toBe(instance); expect(saved.authAppId).toBe('AAUTH')
    expect(f.calls[1]!.body.p_name).toBe('New bot')
    expect(JSON.stringify(f.calls)).not.toContain('/private/')
    expect(existsSync(join(f.state, 'cloud-auth.json'))).toBe(false)
    reporter.stop(); renameSync(join(f.auth, 'cloud-auth.pending.json'), join(f.auth, 'cloud-auth.json'))
    reporter = startConfiguredFleet(f.state, 'ANEW', '/private/project', facts, () => true, f.options)!
    await reporter.tick()
    expect(f.calls.filter(c => c.method === 'register')).toHaveLength(1)
    expect(f.calls.filter(c => c.method === 'report')).toHaveLength(2)
  } finally { reporter.stop(); f.cleanup() }
})
test('missing auth and network outage recover in the same running gateway', async () => {
  const f = fixture()
  const reporter = startConfiguredFleet(f.state, 'ANEW', '/project', facts, () => true, f.options)!
  try {
    await reporter.tick(); expect(f.calls).toHaveLength(0)
    f.login(); f.offline(true); f.advance(); await reporter.tick()
    expect(existsSync(join(f.state, 'fleet.json'))).toBe(false)
    f.offline(false); f.advance(); await reporter.tick()
    expect(f.calls.at(-1)!.method).toBe('report')
  } finally { reporter.stop(); f.cleanup() }
})
test('fleet off before any registration suppresses automatic registration', async () => {
  const f = fixture(); f.login()
  try {
    await configureFleet('off', f.state, [])
    expect(fleetIsOff(f.state)).toBe(true)
    expect(startConfiguredFleet(f.state, 'ANEW', '/project', facts, () => true, f.options)).toBeNull()
    expect(f.calls).toHaveLength(0)
  } finally { f.cleanup() }
})
test('legacy disabled marker remains opted out', () => {
  const f = fixture()
  try { writeFileSync(join(f.state, 'fleet.disabled.json'), '{}', { mode: 0o600 }); expect(fleetIsOff(f.state)).toBe(true) }
  finally { f.cleanup() }
})
test('copied registration from another PC gets a new machine identity', async () => {
  const f = fixture(); f.login()
  writeFileSync(join(f.state, 'fleet.json'), JSON.stringify({ instanceId: instance, appId: 'ANEW',
    installationId: '30000000-0000-4000-8000-000000000001', authAppId: 'AAUTH' }), { mode: 0o600 })
  const reporter = startConfiguredFleet(f.state, 'ANEW', '/project', facts, () => true, f.options)!
  try { await reporter.tick(); expect(f.calls.find(c => c.method === 'register')!.body.p_installation).not.toBe('30000000-0000-4000-8000-000000000001') }
  finally { reporter.stop(); f.cleanup() }
})
test('ambiguous tenant candidates are not arbitrarily selected', async () => {
  const f = fixture(); f.login()
  const other = join(f.home, 'other'); mkdirSync(other, { mode: 0o700 }); registerSlackApp('AOTHER', other, f.home); f.login(other)
  let count = 0
  try {
    const fetcher = (async () => Response.json(++count === 1 ? scope : instance)) as typeof fetch
    await expect(discoverFleetAuth(f.state, 'TTEST', f.home, fetcher)).rejects.toThrow('ambiguous')
  } finally { f.cleanup() }
})

test('Slack sender automatically reports startup and current folder without Git or membership setup',async()=>{
 const f=fixture();const calls:{action:string;body:any}[]=[]
 const fetcher=(async(url:any,init:any)=>{
  const action=String(url).split('/').at(-1)!;calls.push({action,body:JSON.parse(init.body)})
  return Response.json(action==='enroll'?{instanceId:instance,token:'a'.repeat(64),expiresAt:Date.now()+100000}:action==='begin'?{generation:1}:{status:200})
 }) as typeof fetch
 const reporter=startConfiguredFleet(f.state,'ANEW','/not-a-git-folder/BSB',()=>({...facts(),currentProject:'Other',running:1,summary:'Current work'}),()=>true,{...f.options,fetcher,botToken:'xoxb-synthetic-test'})!
 try{
  await reporter.tick()
  expect(calls.map(c=>c.action)).toEqual(['enroll','begin','project-report'])
  const report=calls.at(-1)!.body
  expect(report.projectKey).toBe('BSB');expect(report.currentProject).toBe('Other');expect(report.snapshot.project).toBe('BSB')
  expect(report.snapshot.currentProject).toBeUndefined();expect(JSON.stringify(report)).not.toContain('/not-a-git-folder/')
 }finally{reporter.stop();f.cleanup()}
})
