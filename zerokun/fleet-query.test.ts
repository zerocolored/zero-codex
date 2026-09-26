import {test,expect,setSystemTime} from 'bun:test'
import {mkdtempSync,rmSync,writeFileSync} from 'fs'
import {tmpdir} from 'os'
import {join} from 'path'
import {Database} from 'bun:sqlite'
import {JobStore,SlackNotifier} from './job-runner.ts'
import {answerFleetStatus,readProjectFleet,fleetReplyEnvelope,fleetReplyForDelivery,type FleetCloudResult} from './fleet-query.ts'
import {fleetProject} from './fleet-project.ts'
import {createWorker} from '../fleet-web/worker.ts'
const key='BSB', other='Other', id='10000000-0000-4000-8000-000000000001'
const now=new Date().toISOString()
const snap={state:'available' as const,project:'ignored display',queued:0,summary:null,summaryAt:null,lastAcceptedAt:null,slackConnected:true,runnerHealthy:true}
const cloud: FleetCloudResult={status:200,projectKey:key,projectName:'BSB',serverTime:now,instances:[{id,appId:'ATEST',name:'2号',receivedAt:now,snapshot:snap}]}
const validModel=async()=>JSON.stringify({order:[0]})
test('dedicated model gets only cloud rows and cannot invent names or task text',async()=>{
 let input='';const answer=await answerFleetStatus(cloud,async p=>{input=p;return JSON.stringify({order:[0],text:'OTHER PROJECT PRIVATE'})})
 expect(input).toContain('2号');expect(answer).toContain('受付可能');expect(answer).not.toContain('OTHER PROJECT')
 expect(answer).not.toContain('ignored display')
})
test('stale and duplicate app rows never become available',async()=>{
 const stale={...cloud,instances:[{...cloud.instances[0]!,receivedAt:new Date(Date.now()-100000).toISOString()}]}
 expect(await answerFleetStatus(stale,validModel)).not.toContain('受付可能')
 const dup={...cloud,instances:[cloud.instances[0]!,{...cloud.instances[0]!,id:'10000000-0000-4000-8000-000000000002'}]}
 expect(await answerFleetStatus(dup,async()=>JSON.stringify({order:[0,1]}))).not.toContain('受付可能')
})
test('credentialed cloud query cannot accept another project or follow redirects',async()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-query-'))
 try {
  writeFileSync(join(root,'fleet-sender-credential.json'),JSON.stringify({instanceId:id,token:'c'.repeat(64),expiresAt:Date.now()+100000}),{mode:0o600})
  const fetcher=(async(_u:any,init:any)=>{expect(init.redirect).toBe('error');expect(JSON.parse(init.body).projectKey).toBe(key);return Response.json({...cloud,projectKey:other})}) as typeof fetch
  await expect(readProjectFleet(root,key,fetcher)).rejects.toThrow('project mismatch')
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('folder names group different clones and non-Git paths without registration',()=>{
 expect(fleetProject('/pc-one/BSB')).toEqual({key:'BSB',label:'BSB'})
 expect(fleetProject('/pc-two/BSB/')).toEqual(fleetProject('/pc-one/BSB'))
 expect(fleetProject('/pc-two/Other')?.key).not.toBe('BSB')
 expect(fleetProject('/pc/e\u0301')).toEqual(fleetProject('/else/é'))
 expect(fleetProject('/')).toBeNull()
})
test('status route is durable, bypasses active job, and stages exactly one normal outbox reply',()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-route-')),db=join(root,'jobs.sqlite3');let store=new JobStore(db)
 try{
  const input={chatId:'CTEST',threadTs:'100.1',messageId:'100.2',userId:'UTEST',repoPath:root,text:'誰が空いてる？',fileIds:[],writeEnabled:true,isInterrupt:false}
  store.enqueue({chatId:'CTEST',threadTs:'100.1',messageId:'100.1',userId:'UTEST',repoPath:root,task:'normal work'})
  store.stageInboundDelivery(input);const inbound=store.claimNextInboundDelivery()!
  store.stageFleetRoute(inbound,'fleet-status',key)
  expect(store.list()).toHaveLength(1);expect(store.hasDurableEvent(inbound.idempotencyKey)).toBe(true)
  store.close();store=new JobStore(db)
  expect(store.fleetQueryRoute(inbound.idempotencyKey)).toBe('fleet-status')
  expect(store.pendingFleetQueries()).toHaveLength(1)
  store.completeFleetQuery(inbound.idempotencyKey,'BSB: 2号は受付可能');store.completeFleetQuery(inbound.idempotencyKey,'different retry')
  const notes=store.pendingStatusNotifications().filter(n=>n.kind==='fleet-status');expect(notes).toHaveLength(1)
  expect(store.statusNotificationDeliverable(notes[0]!.id)).toBe(true)
  expect(store.stageInboundDelivery(input)).toBe(false)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
test('project projection never borrows another projects summary or queued count',()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-facts-')),path=join(root,'jobs.sqlite3'),store=new JobStore(path)
 try{
  const {job}=store.enqueue({chatId:'CTEST',threadTs:'100.1',messageId:'100.1',userId:'UTEST',repoPath:'/other',task:'PRIVATE'})
  const db=new Database(path);db.run("UPDATE jobs SET status='running',attempts=1 WHERE id=?",[job.id])
  db.run("INSERT INTO commentary_notifications(id,source_key,job_id,attempt,payload,created_at,delivered_at) VALUES('private','private',?,1,'OTHER SECRET',1,1)",[job.id]);db.close()
  const facts=store.fleetFacts(Date.now(),root)
  expect(facts.running).toBe(0);expect(facts.occupiedElsewhere).toBe(true);expect(facts.queued).toBe(0);expect(facts.summary).toBeNull();expect(facts.lastAcceptedAt).toBeNull()
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
test('worker routes scoped reads to restricted RPC, never space-wide list',async()=>{
 const calls:string[]=[]
 const worker=createWorker((async(url:any,init:any)=>{calls.push(String(url));expect(JSON.parse(init.body).p_project).toBe(key);return Response.json({status:403})}) as typeof fetch)
 const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'test',FLEET_SPACE_ID:id,FLEET_GATEWAY_SECRET:'test',ASSETS:{fetch:async()=>new Response()}}
 const response=await worker.fetch(new Request('https://fleet.example/api/sender/project-status',{method:'POST',headers:{authorization:`Bearer ${'c'.repeat(64)}`,'content-type':'application/json'},body:JSON.stringify({instanceId:id,projectKey:key})}),env)
 expect(response.status).toBe(403);expect(calls).toEqual(['https://example.supabase.co/rest/v1/rpc/zerochan_fleet_project_status'])
})

test('model latency cannot turn an expired heartbeat into an available answer',async()=>{
 const start=Date.parse(now);setSystemTime(start)
 try {
  const answer=await answerFleetStatus(cloud,async()=>{setSystemTime(start+91000);return JSON.stringify({order:[0]})})
  expect(answer).not.toContain('受付可能');expect(answer).toContain('状態不明')
 }finally{setSystemTime()}
})
test('fleet outbox goes through real Slack notifier shaping with stable delivery IDs, and expires',async()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-notify-')),store=new JobStore(join(root,'db'));const sent:any[]=[]
 try {
  const notifier=new SlackNotifier('xoxb-fixture',()=>{},store,{postMessage:async x=>{sent.push(x);return {ts:'100.2'}}})
  const base={id:'test-fleet',idempotencyKey:'fleet-status:test',jobId:null,chatId:'CTEST',threadTs:'100.1',kind:'fleet-status' as const,attempts:0}
  const payload=fleetReplyEnvelope('BSBの状況です。\n・2号：受付可能',Date.now()+10000)
  await notifier.status({...base,payload});await notifier.status({...base,payload})
  expect(sent[0].text).toContain('受付可能');expect(sent[0].threadTs).toBe('100.1');expect(sent[0].clientMessageId).toBe(sent[1].clientMessageId)
  const expired=fleetReplyEnvelope('PRIVATE STALE 受付可能',Date.now()-1)
  await notifier.status({...base,payload:expired});expect(sent.at(-1).text).not.toContain('PRIVATE STALE')
  expect(fleetReplyForDelivery('invalid')).toContain('確認できません')
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
test('existing status outbox migrates without losing delivery records',()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-migrate-')),path=join(root,'db');let store=new JobStore(path)
 try{
  const input={chatId:'CTEST',threadTs:'100.1',messageId:'100.1',userId:'UTEST',repoPath:root,text:'中止',fileIds:[],writeEnabled:true,isInterrupt:true}
  store.stageInboundDelivery(input);const row=store.claimNextInboundDelivery()!;store.tombstoneInboundDelivery(row.idempotencyKey,{kind:'inactive-interrupt',payload:'既存通知'})
  store.close();const db=new Database(path)
  const schema=(db.query("select sql from sqlite_master where name='status_notifications'").get() as any).sql
  db.exec(schema.replace('status_notifications','legacy_status').replace(", 'fleet-status'",''))
  db.exec('INSERT INTO legacy_status SELECT * FROM status_notifications; DROP TABLE status_notifications; ALTER TABLE legacy_status RENAME TO status_notifications;')
  db.close();store=new JobStore(path)
  const notes=store.pendingStatusNotifications();expect(notes).toHaveLength(1);expect(notes[0]!.payload).toBe('既存通知')
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})

test('transport latency is conservatively included before rendering availability',async()=>{
 const delayed={...cloud,requestDurationMs:20000,observedAt:performance.now(),instances:[{...cloud.instances[0]!,receivedAt:new Date(Date.parse(now)-80000).toISOString()}]}
 const answer=await answerFleetStatus(delayed,validModel)
 expect(answer).not.toContain('受付可能');expect(answer).toContain('状態不明')
})

test('current folder facts and summary follow the same live job, and disappear on completion',()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-current-')),path=join(root,'jobs.sqlite3'),store=new JobStore(path)
 try{
  const {job}=store.enqueue({chatId:'CTEST',threadTs:'100.1',messageId:'100.1',userId:'UTEST',repoPath:'/pc/Other',task:'PRIVATE'})
  const db=new Database(path);db.run("UPDATE jobs SET status='running',attempts=1 WHERE id=?",[job.id])
  db.run("INSERT INTO commentary_notifications(id,source_key,job_id,attempt,payload,created_at,delivered_at) VALUES('current','current',?,1,'Other task milestone',1,1)",[job.id])
  const facts=store.fleetFolderFacts(Date.now(),'/pc/BSB')
  expect(facts.currentProject).toBe('Other');expect(facts.running).toBe(1);expect(facts.summary).toBe('Other task milestone')
  db.run("UPDATE jobs SET status='completed' WHERE id=?",[job.id]);db.close()
  const idle=store.fleetFolderFacts(Date.now(),'/pc/BSB')
  expect(idle.currentProject).toBeNull();expect(idle.summary).toBeNull();expect(idle.running).toBe(0)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})

test('unrepresentable current folder never publishes its details under the startup name',()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-invalid-current-')),path=join(root,'jobs.sqlite3'),store=new JobStore(path)
 try{
  const {job}=store.enqueue({chatId:'CTEST',threadTs:'100.1',messageId:'100.1',userId:'UTEST',repoPath:'/pc/'+ 'x'.repeat(101),task:'PRIVATE'})
  const db=new Database(path);db.run("UPDATE jobs SET status='running',attempts=1 WHERE id=?",[job.id])
  db.run("INSERT INTO commentary_notifications(id,source_key,job_id,attempt,payload,created_at,delivered_at) VALUES('unknown','unknown',?,1,'PRIVATE OTHER',1,1)",[job.id]);db.close()
  const facts=store.fleetFolderFacts(Date.now(),'/pc/BSB')
  expect(facts.currentProject).toBeNull();expect(facts.occupiedElsewhere).toBe(true);expect(facts.running).toBe(0)
  expect(facts.summary).toBeNull();expect(facts.queued).toBe(0);expect(facts.lastAcceptedAt).toBeNull();expect(facts.summaryAt).toBeNull()
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
