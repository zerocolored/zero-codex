import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, renameSync, writeFileSync, mkdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fleetSummaryWithoutPaths, projectFleetStatus, startFleetReporter, type FleetLocalFacts } from './fleet-status.ts'
import { JobStore } from './job-runner.ts'
import { fleetAuthPath, fleetInstallationId } from './fleet-runtime.ts'
import { registerSlackApp } from './slack-app-registry.ts'
import { CloudHandoffClient } from './cloud-handoff.ts'
import { Database } from 'bun:sqlite'
const facts: FleetLocalFacts = {running:0,queued:0,limited:false,approval:false,deferred:false,lastAcceptedAt:null,summary:null,summaryAt:null}
const runtime={project:'demo',slackConnected:true,runnerHealthy:true,paused:false}
describe('fleet status',()=>{
 test('SQLite projection only uses delivered current-attempt summaries and suppresses paths',()=>{
   const root=mkdtempSync(join(tmpdir(),'fleet-summary-')),path=join(root,'jobs.sqlite3'),store=new JobStore(path),db=new Database(path)
   try {
     const {job}=store.enqueue({chatId:'CTEST',threadTs:'100.1',messageId:'100.1',userId:'UTEST',repoPath:root,task:'PRIVATE TASK'})
     db.run("UPDATE jobs SET status='running',attempts=2 WHERE id=?",[job.id])
     const add=(id:string,attempt:number,text:string,delivered:number|null)=>db.run('INSERT INTO commentary_notifications(id,source_key,job_id,attempt,payload,created_at,delivered_at) VALUES(?,?,?,?,?,?,?)',[id,id,job.id,attempt,text,1000,delivered])
     add('old',1,'前の試行の内容',1000);add('undelivered',2,'未公開',null)
     expect(store.fleetFacts().summary).toBeNull()
     add('public',2,'💬 商品登録の修正を検証しています',1000)
     expect(store.fleetFacts().summary).toBe('商品登録の修正を検証しています')
     add('path',2,'💬 /Volumes/Client/project/file を修正中',1000)
     expect(store.fleetFacts().summary).toBeNull()
     db.run("UPDATE jobs SET status='queued',rate_limit_terminal_json='{}' WHERE id=?",[job.id])
     expect(store.fleetFacts().limited).toBe(true);expect(store.fleetFacts().summary).toBeNull()
   } finally {db.close();store.close();rmSync(root,{recursive:true,force:true})}
 })
 test('monitoring authentication does not require handoff membership',async()=>{
   const calls:string[]=[]
   const client=new CloudHandoffClient({version:1,url:'https://test.supabase.co',publishableKey:'synthetic-public-key-value',accessToken:'synthetic-access-token-value'},(async(url:any)=>{
     calls.push(String(url));return Response.json({id:'10000000-0000-4000-8000-000000000001'})
   }) as typeof fetch)
   expect(await client.authenticatedUserId()).toBe('10000000-0000-4000-8000-000000000001')
   expect(calls).toEqual(['https://test.supabase.co/auth/v1/user'])
 })
 test('public summary does not expose Unix, Windows, UNC or user-relative paths',()=>{
   for (const path of ['/Volumes/Client/project/a.ts','/private/tmp/build/a','/opt/project/a','/srv/project/a','c:\\Users\\someone\\a','\\\\server\\share\\a','~/dev/project','/tmp']) expect(fleetSummaryWithoutPaths(`確認: ${path} を修正中`)).toBeNull()
   for (const text of ['設定「/secret.txt」を確認中','確認対象は/tmpです','ルート/を確認']) expect(fleetSummaryWithoutPaths(text)).toBeNull()
   expect(fleetSummaryWithoutPaths('商品登録の不具合を修正し、画面で動作を確認中です')).toContain('商品登録')
 })
 test('shared authentication follows pending-to-active activation without token copying',()=>{
   const home=mkdtempSync(join(tmpdir(),'fleet-auth-')),state=join(home,'state')
   mkdirSync(state,{mode:0o700})
   try {
     registerSlackApp('ATEST',state,home)
     writeFileSync(join(state,'cloud-auth.pending.json'),'synthetic',{mode:0o600})
     expect(fleetAuthPath('other','ATEST',home)).toBe(join(realpathSync(state),'cloud-auth.pending.json'))
     renameSync(join(state,'cloud-auth.pending.json'),join(state,'cloud-auth.json'))
     expect(fleetAuthPath('other','ATEST',home)).toBe(join(realpathSync(state),'cloud-auth.json'))
   } finally {rmSync(home,{recursive:true,force:true})}
 })
 test('PC installation identity persists locally but differs on another PC',()=>{
   const a=mkdtempSync(join(tmpdir(),'fleet-pc-a-')),b=mkdtempSync(join(tmpdir(),'fleet-pc-b-'))
   try { const id=fleetInstallationId(a);expect(fleetInstallationId(a)).toBe(id);expect(fleetInstallationId(b)).not.toBe(id) }
   finally { rmSync(a,{recursive:true,force:true});rmSync(b,{recursive:true,force:true}) }
 })
 test('availability requires connected Slack, fresh runner and scheduler readiness',()=>{
   expect(projectFleetStatus(facts,runtime).state).toBe('available')
   for(const change of [{slackConnected:false},{runnerHealthy:false}])expect(projectFleetStatus(facts,{...runtime,...change}).state).toBe('unknown')
   expect(projectFleetStatus(facts,{...runtime,paused:true}).state).toBe('waiting')
   expect(projectFleetStatus({...facts,running:1},runtime).state).toBe('busy')
   expect(projectFleetStatus({...facts,limited:true},runtime).state).toBe('limited')
   expect(projectFleetStatus({...facts,approval:true},runtime).state).toBe('available')
   expect(projectFleetStatus({...facts,queued:2},runtime).state).toBe('waiting')
 })
 test('idle/new job never reuses a previous task summary',()=>{
   expect(projectFleetStatus({...facts,summary:'old',summaryAt:1},runtime).summary).toBeNull()
   expect(projectFleetStatus({...facts,running:1},runtime).summary).toBeNull()
 })
 test('monitor outage backs off, coalesces and never throws into work',async()=>{
   let now=0,calls=0,release!:()=>void
   const blocked=new Promise<void>(r=>{release=r})
   const reporter=startFleetReporter({now:()=>now,snapshot:()=>projectFleetStatus(facts,runtime),begin:async()=>1,
    send:async()=>{calls++;await blocked;throw Error('offline')}})
   await Promise.resolve();await Promise.resolve()
   expect(calls).toBe(1)
   const pending=reporter.tick();release();await pending
   await reporter.tick();expect(calls).toBe(1)
   now=60001;await reporter.tick();expect(calls).toBe(2)
   reporter.stop();now=1000000;await reporter.tick();expect(calls).toBe(2)
 })
 test('state changes send before heartbeat, unchanged polling does not postpone heartbeat',async()=>{
   let now=0,running=0,calls=0
   const reporter=startFleetReporter({now:()=>now,snapshot:()=>projectFleetStatus({...facts,running},runtime),begin:async()=>1,send:async()=>{calls++}})
   await reporter.tick();expect(calls).toBe(1)
   now=5000;await reporter.tick();expect(calls).toBe(1)
   running=1;await reporter.tick();expect(calls).toBe(2)
   now=10000;await reporter.tick();expect(calls).toBe(2)
   now=35000;await reporter.tick();expect(calls).toBe(3)
   reporter.stop()
 })
 test('projection does not expose task text and records deduplicated acceptance',()=>{
   const root=mkdtempSync(join(tmpdir(),'fleet-test-')),store=new JobStore(join(root,'jobs.sqlite3'))
   try {
    const input={chatId:'CDEMO',threadTs:'100.1',messageId:'100.1',userId:'UDEMO',repoPath:root,task:'PRIVATE TASK /Users/example/secret'}
    store.enqueue(input);const before=store.fleetFacts();store.enqueue(input)
    expect(store.fleetFacts().lastAcceptedAt).toBe(before.lastAcceptedAt)
    expect(JSON.stringify(before)).not.toContain('PRIVATE')
    expect(before.queued).toBe(1)
   }finally{store.close();rmSync(root,{recursive:true,force:true})}
 })
})
