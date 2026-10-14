import { deliverAuditMilestone } from './security-audit-progress.ts'
import { normalizeSlackInboundText } from './live-control.ts'
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore, runQueuedJobs } from './job-runner.ts'
import { auditSettingsSchema, auditProjectKey } from './security-audit.ts'
import { nodeE2EEvidence } from './security-audit-tools.ts'
import { AuditSetupRequiredError, initializeAudit, loadAuditSettings, saveAuditSettings, discoverAuditE2E, discoverSocketOrganization, applyAuditSetupAnswer } from './security-audit-setup.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'audit-initialization-')); roots.push(root)
  const state = join(root, 'state'), repo = join(root, 'repo')
  mkdirSync(state,{mode:0o700}); mkdirSync(repo,{mode:0o700})
  for (const service of ['socket','semgrep']) writeFileSync(join(state,`security-audit-${service}-token`),'synthetic-credential',{mode:0o600})
  return {root,state,repo}
}
const orgs = (state: string) => discoverSocketOrganization(state, (async () => Response.json({organizations:{id:{slug:'shared-org'}}})) as typeof fetch)
const blank = () => auditSettingsSchema.parse({})
const answer = 'URL: https://example.test/app\n認証: 公開・未ログイン範囲'

test('ordinary explicit login scope wording is recognized without widening quoted or ambiguous instructions', () => {
  for (const text of ['ログインも含む','ログイン後まで','ログイン後までお願いします','ログイン後も含む','ログインも含めてください','ログイン後のページも検査して']) {
    expect(applyAuditSetupAnswer(blank(),'<https://example.test/>\n'+text,[])).toMatchObject({targetUrl:'https://example.test/',authentication:'required'})
    expect(applyAuditSetupAnswer(blank(),'<https://example.test/> '+text,[]).authentication).toBe('required')
  }
  for (const text of ['ログインも含む？','ログイン後までですか','ログイン後までなら','ログインは含まない','「ログインも含む」','> ログインも含む','```\nログインも含む\n```','認証: 公開\nログインも含む']) {
    expect(applyAuditSetupAnswer(blank(),text,[]).authentication).toBeUndefined()
  }
  expect(applyAuditSetupAnswer({...blank(),authentication:'required'},'ログイン後も含む\nログイン後は除外',[]).authentication).toBeUndefined()
})

test('old consumed login reply is reinterpreted and Zero discovers proof without asking for paths', async () => {
  const {state,repo}=fixture(), job={id:'old-reply',repoPath:repo,inputRevision:2}
  saveAuditSettings(state,repo,{...blank(),targetUrl:'https://example.test/app',socketOrg:'shared-org'})
  mkdirSync(join(state,'security-audit-initializations'),{mode:0o700})
  writeFileSync(join(state,'security-audit-initializations',job.id+'.json'),JSON.stringify({repoPath:repo,appliedRevision:2,ready:false,settings:loadAuditSettings(state,repo)}),{mode:0o600})
  let discoveries=0
  const ready=await initializeAudit(job,state,[{text:'<https://example.test/app>\nログインも含む',writeEnabled:true,revision:2}],{
    authentication:async (_job,_state,settings)=>{ discoveries++;expect(settings.authentication).toBe('required');return {status:'verified',path:'/app/me',kind:'status'} },
  })
  expect(ready).toMatchObject({authentication:'required',authenticatedPath:'/app/me',authenticationProbe:'status'})
  expect(discoveries).toBe(1)
  expect((await initializeAudit(job,state,[])).authentication).toBe('required')
  expect(JSON.parse(readFileSync(join(state,'security-audit-initializations',job.id+'.json'),'utf8')).parserVersion).toBe(3)
})

test('login unavailable parks the same job; a login acknowledgment rechecks without repeating scope or requesting technical selectors', async () => {
  const {state,repo}=fixture();const {store,job}=queued(state,repo)
  let available=false, scans=0
  const run=()=>runQueuedJobs({store,stopWhenIdle:true,pollMs:1,notifier:{status:async()=>{},started:async()=>{},progress:async()=>{}},executor:async current=>{
    const settings=await initializeAudit(current,state,store.takeAuditSetupAnswers(current),{
      organizations:orgs,authentication:async()=>available?{status:'verified',path:'/app/me',kind:'status'}:{status:'no-session'},
    })
    expect(settings.authentication).toBe('required');store.finishAuditSetup(current.id,current.inputRevision);scans++
    return {sessionId:'fixture',result:'done'}
  }})
  try {
    await run()
    store.stageThreadReply(store.liveControlTarget('C1','1.1')!,liveAnswer({task:'<https://example.test/app>\nログインも含む'}))
    expect((await run()).failed).toBe(0);expect(scans).toBe(0)
    const saved=JSON.parse(readFileSync(join(state,'security-audit-initializations',job.id+'.json'),'utf8'))
    expect(saved.settings.authentication).toBe('required');expect(saved.ready).toBe(false)
    const questions=store.pendingStatusNotifications().map(n=>n.payload).join('\n')
    expect(questions).not.toContain('確認パス');expect(questions).not.toContain('確認文言')
    available=true
    store.stageThreadReply(store.liveControlTarget('C1','1.1')!,liveAnswer({messageId:'1.3',task:'ログインした'}))
    expect((await run()).completed).toBe(1);expect(scans).toBe(1)
    expect(store.get(job.id)?.status).toBe('completed')
  } finally {store.close()}
})

test('unverified discovery preserves explicit probe candidates without claiming readiness', async () => {
  const {state,repo}=fixture()
  saveAuditSettings(state,repo,{...blank(),targetUrl:'https://example.test/app',authentication:'required',authenticatedPath:'/app/custom',loggedInPattern:'Custom signed-in heading'})
  await expect(initializeAudit({id:'keep-custom',repoPath:repo,inputRevision:1},state,[],{
    organizations:orgs,authentication:async()=>({status:'unverified'}),
  })).rejects.toBeInstanceOf(AuditSetupRequiredError)
  expect(loadAuditSettings(state,repo)).toMatchObject({authenticatedPath:'/app/custom',loggedInPattern:'Custom signed-in heading'})
  expect(JSON.parse(readFileSync(join(state,'security-audit-initializations/keep-custom.json'),'utf8')).ready).toBe(false)
})

test('first request persists questions, authorized reply resumes; another repo inherits only common organization', async () => {
  const {state,repo,root} = fixture()
  const job = {id:'fixture',repoPath:repo,inputRevision:1}
  await expect(initializeAudit(job,state,[],{organizations:orgs})).rejects.toBeInstanceOf(AuditSetupRequiredError)
  expect(loadAuditSettings(state,repo).socketOrg).toBe('shared-org')
  expect(JSON.parse(readFileSync(join(state,'security-audit-settings',auditProjectKey(repo)+'.json'),'utf8')).socketOrg).toBeUndefined()
  const ready = await initializeAudit({...job,inputRevision:2},state,[{text:answer,writeEnabled:true,revision:2}],{organizations:async()=>{throw Error('must reuse')}})
  expect(ready).toMatchObject({targetUrl:'https://example.test/app',authentication:'none',socketOrg:'shared-org'})
  const other = join(root,'other'); mkdirSync(other)
  await expect(initializeAudit({id:'other',repoPath:other,inputRevision:1},state,[],{organizations:async()=>{throw Error('must reuse')}})).rejects.toThrow('same-thread')
  expect(loadAuditSettings(state,other)).toMatchObject({socketOrg:'shared-org'})
  expect(loadAuditSettings(state,other).targetUrl).toBeUndefined()
  // The scan gets a pinned snapshot; host settings edited later do not silently change its target.
  saveAuditSettings(state,repo,{...ready,targetUrl:'https://different.test/'})
  expect((await initializeAudit({...job,inputRevision:2},state,[])).targetUrl).toBe(ready.targetUrl)
  // A genuinely newer answer still takes effect, rather than returning the older ready snapshot.
  expect((await initializeAudit({...job,inputRevision:3},state,[{text:'URL: https://new.test/',writeEnabled:true,revision:3}])).targetUrl).toBe('https://new.test/')
})

test('multiple organizations require selection once; token changes invalidate inherited organization', async () => {
  const {state,repo,root}=fixture()
  const organizations = async () => ['first','second']
  await expect(initializeAudit({id:'multi',repoPath:repo,inputRevision:1},state,[],{organizations})).rejects.toThrow('same-thread')
  expect(loadAuditSettings(state,repo).socketOrg).toBeUndefined()
  await initializeAudit({id:'multi',repoPath:repo,inputRevision:2},state,[{text:answer+'\nSocket: second',writeEnabled:true,revision:2}],{organizations})
  const other=join(root,'other');mkdirSync(other)
  expect(loadAuditSettings(state,other).socketOrg).toBe('second')
  writeFileSync(join(state,'security-audit-socket-token'),'changed-synthetic-credential')
  expect(loadAuditSettings(state,other).socketOrg).toBeUndefined()
  expect(loadAuditSettings(state,repo).socketOrg).toBeUndefined()
})

test('source strings, unprivileged replies, malformed URLs and ambiguous authentication never grant scope', async () => {
  const {state,repo}=fixture()
  writeFileSync(join(repo,'package.json'),JSON.stringify({description:answer,scripts:{'test:e2e':123}}))
  const job={id:'scope',repoPath:repo,inputRevision:2}
  await expect(initializeAudit(job,state,[{text:answer,writeEnabled:false,revision:2}],{organizations:orgs})).rejects.toThrow('same-thread')
  expect(loadAuditSettings(state,repo).targetUrl).toBeUndefined()
  for(const text of ['認証不要ですか？','公開ではない','認証: 公開なら','URL: https://user:pass@example.test','URL: https://example.test/?token=x','URL: https://[invalid']) {
    const settings=applyAuditSetupAnswer(blank(),text,[])
    expect(settings.targetUrl).toBeUndefined();expect(settings.authentication).toBeUndefined()
  }
  expect(applyAuditSetupAnswer(blank(),'認証: ログイン後も含む\n確認パス: /account\n確認文言: ログアウト',[])).toMatchObject({authentication:'required',authenticatedPath:'/account',loggedInPattern:'ログアウト'})
  await expect(initializeAudit({...job,repoPath:repo+'-changed'},state,[])).rejects.toThrow('repository changed')
})

test('discovery selects root custom E2E over unrelated nested Playwright and refuses escape/symlinks', () => {
  const {repo,root}=fixture()
  mkdirSync(join(repo,'services/chatbot'),{recursive:true})
  writeFileSync(join(repo,'services/chatbot/playwright.config.ts'),"export default {use:{baseURL:'http://localhost:3111'}}")
  expect(discoverAuditE2E(repo).e2e).toBeUndefined()
  mkdirSync(join(repo,'packages/web'),{recursive:true})
  writeFileSync(join(repo,'packages/web/journey.cjs'),'// synthetic')
  writeFileSync(join(repo,'package.json'),JSON.stringify({scripts:{'test:e2e':'pnpm -C packages/web exec node journey.cjs'}}))
  expect(discoverAuditE2E(repo).e2e).toEqual({kind:'node',cwd:'packages/web',entry:'journey.cjs'})
  writeFileSync(join(repo,'playwright.config.ts'),"export default {use:{baseURL:'http://localhost:4321'}}")
  expect(discoverAuditE2E(repo).e2e?.kind).toBe('node')
  writeFileSync(join(repo,'package.json'),JSON.stringify({scripts:{'test:e2e':'playwright test'}}))
  expect(discoverAuditE2E(repo).port).toBe(4321)
  writeFileSync(join(root,'outside.cjs'),'// outside')
  symlinkSync(join(root,'outside.cjs'),join(repo,'linked.cjs'))
  for(const script of ['node ../outside.cjs','node linked.cjs','node journey.cjs; echo bad']) {
    writeFileSync(join(repo,'package.json'),JSON.stringify({scripts:{'test:e2e':script}}))
    expect(discoverAuditE2E(repo).e2e).toBeUndefined()
  }
  expect(nodeE2EEvidence('saas-journey: 4 checks passed; real browser')).toBe(4)
  expect(nodeE2EEvidence('Hello World')).toBe(0)
  expect(nodeE2EEvidence('# pass 3\n# skipped 1\n')).toBe(0)
})

function queued(state: string,repo: string) {
  const store=new JobStore(join(state,'jobs.sqlite'))
  const job=store.enqueue({chatId:'C1',threadTs:'1.1',messageId:'1.1',userId:'U1',repoPath:repo,task:'検査して\nURL: https://reference.test/\n認証: 公開',workflow:'security-audit',writeEnabled:true}).job
  return {store,job}
}
const liveAnswer = (overrides: Record<string,unknown> = {}) => ({chatId:'C1',threadTs:'1.1',messageId:'1.2',userId:'U1',task:answer,writeEnabled:true,...overrides})
function deliverQuestion(store: JobStore) {
  const notification=store.pendingStatusNotifications().find(n=>n.payload==='setup question')!
  expect(store.statusNotificationDeliverable(notification.id)).toBe(true)
  store.markStatusNotificationDelivered(notification.id)
}

test('durable wait releases worker, survives restart and binds replies to exact thread/repository with deduplication', () => {
  const {state,repo}=fixture();let {store,job}=queued(state,repo)
  store.claimNext('first');store.parkAuditSetup(job.id,'setup question',1)
  expect(store.countClaimable()).toBe(0)
  const other=store.enqueue({chatId:'C1',threadTs:'2.1',messageId:'2.1',userId:'U1',repoPath:repo,task:'another task'}).job
  expect(store.claimNext('other')?.id).toBe(other.id);store.fail(other.id,'fixture')
  store.close();store=new JobStore(join(state,'jobs.sqlite'))
  try {
    expect(store.auditSetupWaiting(job.id)).toBe(true)
    const target=store.liveControlTarget('C1','1.1')!
    expect(store.stageThreadReply(target,liveAnswer({threadTs:'wrong'}))).toBe('closed')
    expect(store.stageThreadReply({...target,repoPath:repo+'wrong'},liveAnswer())).toBe('closed')
    expect(store.stageThreadReply(target,liveAnswer({writeEnabled:false}))).toBe('closed')
    expect(store.stageThreadReply(target,liveAnswer())).toBe('staged')
    expect(store.stageThreadReply(target,liveAnswer())).toBe('duplicate')
    expect(store.claimNext('not-before-delivery')).toBeNull()
    deliverQuestion(store)
    const resumed=store.claimNext('resumed')!
    expect(resumed.id).toBe(job.id);expect(resumed.inputRevision).toBe(2)
    expect(resumed.writeEnabled).toBe(false)
    store.finishAuditSetup(job.id,2)
    expect(store.auditSetupWaiting(job.id)).toBe(false)
  } finally {store.close()}
})

test('cancel during parking or waiting wins over replies and can be claimed without prompt delivery', () => {
  for(const before of [true,false]) {
    const {state,repo}=fixture();const {store,job}=queued(state,repo)
    try {
      store.claimNext('first')
      if(!before)store.parkAuditSetup(job.id,'setup question',1)
      const target=store.liveControlTarget('C1','1.1')!
      expect(store.stageLiveControl(target,{...liveAnswer(),kind:'interrupt'})).toBe('staged')
      if(before) {store.parkAuditSetup(job.id,'setup question',1);expect(store.get(job.id)?.terminalOutcome).toBe('cancelled')}
      else expect(store.claimNext('cancel')?.cancelRequestedAt).not.toBeNull()
      expect(store.stageThreadReply(target,liveAnswer({messageId:'1.3'}))).toBe('closed')
    } finally {store.close()}
  }
})

test('runner parks initialization without terminal failure, then continues the same job after answer', async () => {
  const {state,repo}=fixture();const {store,job}=queued(state,repo)
  const phases: string[]=[]
  const run=()=>runQueuedJobs({store,stopWhenIdle:true,pollMs:1,notifier:{status:async()=>{},started:async()=>{},progress:async()=>{}},executor:async (current,signal,context)=>{
    const answers=store.takeAuditSetupAnswers(current)
    await deliverAuditMilestone(current,'initializing','Checking tools',context!,key=>store.commentarySourceDelivered(current.id,key),{signal},1_500)
    const settings=await initializeAudit(current,state,answers,{organizations:orgs})
    store.finishAuditSetup(current.id,current.inputRevision)
    for(const phase of ['checking','ready'] as const) await deliverAuditMilestone(current,phase,phase,context!,key=>store.commentarySourceDelivered(current.id,key),{signal},1_500)
    expect(settings.targetUrl).toBe('https://example.test/app');phases.push('scan')
    return {sessionId:'fixture',result:'done'}
  }})
  try {
    const first=await run();expect(first.failed).toBe(0);expect(phases).toEqual([])
    expect(store.get(job.id)?.status).toBe('queued')
    const target=store.liveControlTarget('C1','1.1')!
    expect(store.stageThreadReply(target,liveAnswer())).toBe('staged')
    const second=await run();expect(second.completed).toBe(1);expect(phases).toEqual(['scan'])
    expect(store.get(job.id)?.status).toBe('completed')
    expect(store.listJobControls(job.id)[0]?.status).toBe('observed')
  } finally {store.close()}
})

for (const link of ['<https://example.test/app>', '<https://example.test/app|https://label-is-not-target.test/>']) {
  test('Slack auto-linked URL answers survive normalization, persistence and same-job resume: ' + link, async () => {
    const {state,repo}=fixture(); const {store,job}=queued(state,repo)
    try {
      const first=store.claimNext('first')!
      // Even a request containing URL/auth lines cannot silently become an authorized settings reply.
      await expect(initializeAudit(first,state,[],{organizations:orgs})).rejects.toThrow('same-thread')
      expect(loadAuditSettings(state,repo).targetUrl).toBeUndefined()
      store.parkAuditSetup(job.id,'setup question',first.inputRevision); deliverQuestion(store)
      const text=normalizeSlackInboundText('<@BOT> URL: '+link+'\n認証: 公開・未ログイン範囲','BOT',false)
      expect(store.stageThreadReply(store.liveControlTarget('C1','1.1')!,liveAnswer({task:text}))).toBe('staged')
      const resumed=store.claimNext('resumed')!
      const settings=await initializeAudit(resumed,state,store.listJobControls(job.id).map(c=>({text:c.task,writeEnabled:c.writeEnabled,revision:c.inputRevision})))
      store.finishAuditSetup(job.id,resumed.inputRevision)
      expect(settings.targetUrl).toBe('https://example.test/app')
      expect(loadAuditSettings(state,repo).targetUrl).toBe('https://example.test/app')
      expect(resumed.id).toBe(job.id)
    } finally {store.close()}
  })
}

test('host audit answer acceptance is bound to the current revision and cancellation',()=>{
  const {state,repo}=fixture();const {store,job}=queued(state,repo)
  try {
    store.claimNext('first');store.parkAuditSetup(job.id,'setup question',1);deliverQuestion(store)
    store.stageThreadReply(store.liveControlTarget('C1','1.1')!,liveAnswer())
    const resumed=store.claimNext('resumed')!
    expect(()=>store.takeAuditSetupAnswers({...resumed,inputRevision:1})).toThrow('input changed')
    expect(store.listJobControls(job.id)[0]?.status).toBe('ready')
    expect(store.takeAuditSetupAnswers(resumed)).toEqual([{text:answer,writeEnabled:true,revision:2}])
    expect(store.takeAuditSetupAnswers(resumed)).toHaveLength(1)
    expect(store.listJobControls(job.id)[0]).toMatchObject({status:'observed',requestId:null,executorNonce:null})
    store.stageLiveControl(store.liveControlTarget('C1','1.1')!,{...liveAnswer({messageId:'1.3'}),kind:'interrupt'})
    expect(()=>store.takeAuditSetupAnswers(resumed)).toThrow()
  } finally {store.close()}
})

function failedAnsweredAudit(state: string, repo: string) {
  const {store,job}=queued(state,repo)
  store.claimNext('first');store.parkAuditSetup(job.id,'setup question',1);deliverQuestion(store)
  store.stageThreadReply(store.liveControlTarget('C1','1.1')!,liveAnswer({task:'<https://example.test/app>\nログインも含む'}))
  store.claimNext('old-runner');store.fail(job.id,'synthetic failure before answer acceptance')
  return {store,job}
}

test('failed audit answer survives an intervening work job and a new audit with a lower revision', async()=>{
  const {state,repo}=fixture();const {store,job:old}=failedAnsweredAudit(state,repo)
  try {
    const work=store.enqueue({chatId:'C1',threadTs:'1.1',messageId:'1.3',userId:'U1',repoPath:repo,task:'続けて'}).job
    store.claimNext('work');store.complete(work.id,'synthetic','completed')
    const next=store.enqueue({chatId:'C1',threadTs:'1.1',messageId:'1.4',userId:'U1',repoPath:repo,task:'Socketを再度試して',workflow:'security-audit'}).job
    const current=store.claimNext('retry')!
    expect(current.id).toBe(next.id);expect(current.inputRevision).toBe(1)
    const inputs=store.takeAuditSetupAnswers(current)
    expect(inputs[0]).toMatchObject({sourceJobId:old.id,revision:2})
    let checked=0
    const settings=await initializeAudit(current,state,inputs,{organizations:orgs,authentication:async()=>{
      checked++;return {status:'verified',path:'/app/me',kind:'status'}
    }})
    expect(settings).toMatchObject({targetUrl:'https://example.test/app',authentication:'required'})
    expect(checked).toBe(1)
    expect(store.listJobControls(old.id)[0]?.status).toBe('ready')
    const record=JSON.parse(readFileSync(join(state,'security-audit-initializations',next.id+'.json'),'utf8'))
    expect(record.inheritedControls).toEqual([store.listJobControls(old.id)[0]!.id])
    store.finishAuditSetup(current.id,current.inputRevision)
  } finally {store.close()}
})

test('legacy parked retry automatically re-evaluates history once, then waits only for actual login',async()=>{
  const {state,repo}=fixture();let {store}=failedAnsweredAudit(state,repo)
  const next=store.enqueue({chatId:'C1',threadTs:'1.1',messageId:'1.3',userId:'U1',repoPath:repo,task:'再度',workflow:'security-audit'}).job
  store.claimNext('legacy');store.parkAuditSetup(next.id,'setup question',1);deliverQuestion(store)
  mkdirSync(join(state,'security-audit-initializations'),{recursive:true})
  writeFileSync(join(state,'security-audit-initializations',next.id+'.json'),JSON.stringify({parserVersion:2,repoPath:repo,appliedRevision:1,ready:false,settings:blank()}),{mode:0o600})
  // Old releases had neither the history check receipt nor a versioned notification key.
  const db=new Database(store.dbPath)
  db.run("UPDATE status_notifications SET idempotency_key='audit-setup:'||job_id||':1' WHERE job_id=? AND payload='setup question'",[next.id])
  db.run("UPDATE audit_setup_waits SET notification_key='audit-setup:'||job_id||':1' WHERE job_id=?",[next.id]);db.close()
  store.close();store=new JobStore(join(state,'jobs.sqlite'))
  try {
    const resumed=store.claimNext('upgraded')!;expect(resumed.id).toBe(next.id)
    try {
      await initializeAudit(resumed,state,store.takeAuditSetupAnswers(resumed),{organizations:orgs,authentication:async()=>({status:'no-session'})})
      throw Error('expected login wait')
    } catch(error) {
      expect(error).toBeInstanceOf(AuditSetupRequiredError)
      const required=error as AuditSetupRequiredError
      expect(required.prompt).not.toContain('検査してよいWeb環境');expect(required.prompt).not.toContain('Web検査の範囲を')
      expect(required.prompt).toContain('ログインし')
      store.parkAuditSetup(next.id,required.prompt,resumed.inputRevision)
    }
    const notice=store.pendingStatusNotifications().find(n=>n.payload.includes('ログインし'))!
    expect(notice).toBeDefined();store.markStatusNotificationDelivered(notice.id)
    store.close();store=new JobStore(join(state,'jobs.sqlite'))
    expect(store.claimNext('must-stay-parked')).toBeNull()
    store.stageThreadReply(store.liveControlTarget('C1','1.1')!,liveAnswer({messageId:'1.4',task:'認証: 公開・未ログイン範囲'}))
    const latest=store.claimNext('public')!
    const ready=await initializeAudit(latest,state,store.takeAuditSetupAnswers(latest),{organizations:orgs,authentication:async()=>{throw Error('old login grant must not return')}})
    expect(ready.authentication).toBe('none')
  } finally {store.close()}
})

test('history excludes other boundaries, unauthorized/superseded answers and completed or cancelled audits',()=>{
  for(const boundary of ['chat','thread','repo','unauthorized','superseded','completed','cancelled'] as const) {
    const {state,repo}=fixture();const {store,job}=failedAnsweredAudit(state,repo)
    try {
      const db=new Database(store.dbPath)
      if(boundary==='unauthorized')db.run('UPDATE job_controls SET write_enabled=0 WHERE job_id=?',[job.id])
      if(boundary==='superseded')db.run("UPDATE job_controls SET status='superseded' WHERE job_id=?",[job.id])
      if(boundary==='completed')db.run("UPDATE jobs SET status='completed' WHERE id=?",[job.id])
      if(boundary==='cancelled')db.run("UPDATE jobs SET terminal_outcome='cancelled' WHERE id=?",[job.id])
      db.close()
      const next=store.enqueue({chatId:boundary==='chat'?'C2':'C1',threadTs:boundary==='thread'?'2.1':'1.1',messageId:'1.3',userId:'U1',repoPath:boundary==='repo'?repo+'-other':repo,task:'再度',workflow:'security-audit'}).job
      expect(store.auditSetupHistory(next.id)).toEqual([])
    } finally {store.close()}
  }
})

for (const deliveryStatus of ['ready','dispatching','acknowledged','observed','ambiguous']) {
test('newer authorized restrictions win even when their delivery is '+deliveryStatus,async()=>{
  const {state,repo}=fixture();const {store}=failedAnsweredAudit(state,repo)
  try {
    const work=store.enqueue({chatId:'C1',threadTs:'1.1',messageId:'1.3',userId:'U1',repoPath:repo,task:'続けて',writeEnabled:true}).job
    store.claimNext('work')
    expect(store.stageLiveControl(store.liveControlTarget('C1','1.1')!,{...liveAnswer({messageId:'1.4',task:'ログインを除外'}),kind:'steer'})).toBe('staged')
    const db=new Database(store.dbPath)
    db.run('UPDATE job_controls SET status=? WHERE job_id=?',[deliveryStatus,work.id]);db.close()
    store.fail(work.id,'synthetic')
    const next=store.enqueue({chatId:'C1',threadTs:'1.1',messageId:'1.5',userId:'U1',repoPath:repo,task:'再度',workflow:'security-audit'}).job
    let current=store.claimNext('retry')!
    await expect(initializeAudit(current,state,store.takeAuditSetupAnswers(current),{organizations:orgs,authentication:async()=>{throw Error('revoked scope must not authenticate')}})).rejects.toBeInstanceOf(AuditSetupRequiredError)
    expect(loadAuditSettings(state,repo).authentication).toBeUndefined()
    store.parkAuditSetup(next.id,'setup question',1);deliverQuestion(store)
    store.stageThreadReply(store.liveControlTarget('C1','1.1')!,liveAnswer({messageId:'1.6',task:'URL: https://new.test/app\n認証: 公開・未ログイン範囲'}))
    current=store.claimNext('corrected')!
    expect(await initializeAudit(current,state,store.takeAuditSetupAnswers(current),{organizations:orgs})).toMatchObject({targetUrl:'https://new.test/app',authentication:'none'})
  } finally {store.close()}
})
}

test('ordinary work answers cannot grant audit targets or wake an old parked audit',async()=>{
  for(const auth of ['認証: 公開・未ログイン範囲','ログインも含む']) {
    const {state,repo}=fixture();let store=new JobStore(join(state,'jobs.sqlite'))
    try {
      const work=store.enqueue({chatId:'C1',threadTs:'1.1',messageId:'1.1',userId:'U1',repoPath:repo,task:'画面を実装して',writeEnabled:true}).job
      store.claimNext('work')
      expect(store.stageLiveControl(store.liveControlTarget('C1','1.1')!,{...liveAnswer({task:'https://unrelated.test/\n'+auth}),kind:'steer'})).toBe('staged')
      store.fail(work.id,'synthetic')
      const next=store.enqueue({chatId:'C1',threadTs:'1.1',messageId:'1.3',userId:'U1',repoPath:repo,task:'セキュリティ検査',workflow:'security-audit'}).job
      const current=store.claimNext('audit')!
      const answers=store.auditSetupHistory(current.id)
      expect(answers).toHaveLength(1);expect(answers[0]!.restrictionsOnly).toBe(true)
      await expect(initializeAudit(current,state,answers,{organizations:orgs,authentication:async()=>{throw Error('no audit grant')}})).rejects.toBeInstanceOf(AuditSetupRequiredError)
      expect(loadAuditSettings(state,repo).targetUrl).toBeUndefined()
      expect(loadAuditSettings(state,repo).authentication).toBeUndefined()
      store.parkAuditSetup(next.id,'setup question',1);deliverQuestion(store)
      store.close();store=new JobStore(join(state,'jobs.sqlite'))
      expect(store.claimNext('must-not-wake')).toBeNull()
    } finally {store.close()}
  }
})
