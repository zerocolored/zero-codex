import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, expect, test, spyOn } from 'bun:test'
import * as safeFile from './safe-file.ts'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore } from './job-runner.ts'
import { ClaudeDelegations, createDelegationServer, type DelegationContext } from './claude-delegation-broker.ts'
import { prepareClaudeJobContext } from './claude-job-context.ts'
import { readProcessIdentity } from './process-generation.ts'
import { pendingClaudeDelegation } from './claude-delegation-state.ts'
import { retainGoalForDelegation } from './codex-goal.ts'
import { PrimaryToolRuntime } from './primary-tools-broker.ts'
import { buildCodexPermissionOverrides } from './codex-executor.ts'
const cleanups: Array<()=>void> = []
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup()})
function fixture(writeEnabled=false) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'zero-delegation-')))
 cleanups.push(()=>rmSync(root,{recursive:true,force:true}))
 const repo=join(root,'repo'),stateDir=join(root,'state');mkdirSync(repo);mkdirSync(stateDir,{mode:0o700})
 const store=new JobStore(join(stateDir,'jobs.sqlite3'));cleanups.push(()=>store.close())
 store.enqueue({repoPath:repo,chatId:'C',threadTs:'1800000000.1',messageId:'1800000000.1',userId:'U',task:'Opusに依頼',writeEnabled})
 const job=store.claimNext('test')!
 return {store,context:{version:1,stateDir,job} as DelegationContext}
}
const request={key:'design',model:'claude-opus-5-5',prompt:'指定した作業を実装して検証してください'}
test('one durable delegation per key; primary dispatch and model stay untouched',async()=>{
 const f=fixture();let calls=0
 const before=f.store.db.query('SELECT * FROM jobs').all()
 const runs=new ClaudeDelegations(f.context,async(context,id,input)=>{calls++;expect(context.job.id).toBe(f.context.job.id);expect(input.model).toBe('claude-opus-5-5');return 'done'})
 const first=runs.start(request);expect(runs.start(request).id).toBe(first.id)
 expect(()=>runs.start({...request,prompt:'different'})).toThrow('already used')
 expect((await runs.wait(first.id)).status).toBe('completed');expect(calls).toBe(1)
 const restarted=new ClaudeDelegations(f.context,async()=>{throw Error('must not launch')})
 expect(restarted.start(request).status).toBe('completed');expect(f.store.db.query('SELECT * FROM jobs').all()).toEqual(before)
 await runs.close();await restarted.close()
})
test('lost broker and delivered failure never replay; cancellation waits for owned runner',async()=>{
 const f=fixture();let aborted=false
 const runs=new ClaudeDelegations(f.context,async(_context,_id,_request,signal)=>{
  await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve()},{once:true}));throw Error('cancelled')
 })
 const started=runs.start(request);await Bun.sleep(5)
 const second=new ClaudeDelegations(f.context,async()=>{throw Error('no replay')})
 expect(second.start(request).status).toBe('running')
 const distinct=second.start({...request,key:'another'});expect(distinct.id).not.toBe(started.id)
 await second.wait(distinct.id)
 expect((await runs.cancel(started.id)).status).toBe('cancelled');expect(aborted).toBe(true)
 expect(second.start(request).status).toBe('cancelled');await runs.close();await second.close()
})
test('missing requested model cannot cause provider/model fallback',async()=>{
 const f=fixture();let calls=0
 const runs=new ClaudeDelegations(f.context,async(_context,_id,input)=>{calls++;expect(input.model).toBe(request.model);throw Error('model unavailable')})
 const first=runs.start(request);expect((await runs.wait(first.id)).status).toBe('failed');expect(runs.start(request).status).toBe('failed');expect(calls).toBe(1)
 expect(()=>runs.start({...request,key:'invalid',model:'opus --resume foreign'})).toThrow('invalid');await runs.close()
})
test.each([false,true])('child context has independent authority and no advisor or parent goal (write=%s)',writeEnabled=>{
 const f=fixture(writeEnabled)
 const child={...f.context.job,id:'delegate-123',runtime:'claude-code' as const,sessionId:null}
 const prepared=prepareClaudeJobContext(child,f.context.stateDir,{model:request.model,parentJobId:f.context.job.id})
 try {
  const args=prepared.argumentsFor('11111111-1111-4111-8111-111111111111',false)
  expect(args[args.indexOf('--model')+1]).toBe('claude-opus-5-5')
  const mcp=JSON.parse(readFileSync(args[args.indexOf('--mcp-config')+1]!,'utf8'))
  expect(Object.keys(mcp.mcpServers)).toEqual(['zerokun_runtime'])
  expect(prepared.artifactDir).toBe(join(f.context.stateDir,'outbox',f.context.job.id));expect(prepared.inputDir).toBe(join(f.context.stateDir,'live-input',f.context.job.id))
  expect(prepared.toolsContext.jobId).toBe(child.id);expect(prepared.toolsContext.goalPath).toContain(child.id)
  expect(prepared.toolsContext.allowUnityEditor).toBe(writeEnabled)
  const instructions=readFileSync(args[args.indexOf('--append-system-prompt-file')+1]!,'utf8')
  expect(instructions).toContain('delegated Claude worker');expect(instructions).not.toContain('You are the primary Claude')
  expect(f.store.get(f.context.job.id)?.runtime).toBe('codex')
 } finally {prepared.retire()}
})
test('only configured broker enters primary MCP catalog',()=>{
 const f=fixture();const options={stateDir:f.context.stateDir,artifactDir:join(f.context.stateDir,'outbox',f.context.job.id),scratchDir:join(f.context.stateDir,'tmp',f.context.job.id)}
 mkdirSync(options.artifactDir,{recursive:true,mode:0o700});mkdirSync(options.scratchDir,{recursive:true,mode:0o700})
 const plain=buildCodexPermissionOverrides(f.context.job,options).join('\n')
 expect(plain).not.toContain('zerokun_delegation=')
 const configured=buildCodexPermissionOverrides(f.context.job,{...options,delegationMcp:{command:'/fixture/bun',args:['broker','context','state']}}).join('\n')
 expect(configured).toContain('claude_delegate_start');expect(configured).toContain('claude_delegate_poll')
})

test('lost start response recovers same claim while the real pane receipt exists',async()=>{
 const f=fixture();let finish!:()=>void
 const runs=new ClaudeDelegations(f.context,async(_context,id)=>{
  const root=join(f.context.stateDir,'claude-panes');mkdirSync(root,{mode:0o700})
  const path=join(root,`delegate-${id}.json`);writeFileSync(path,'{}',{mode:0o600})
  await new Promise<void>(resolve=>{finish=resolve});rmSync(path);return 'ok'
 })
 const first=runs.start(request);await Bun.sleep(5)
 expect(runs.start(request).id).toBe(first.id)
 const other=new ClaudeDelegations(f.context,async()=>{throw Error('no duplicate')})
 expect(other.start(request).status).toBe('running');finish();expect((await runs.wait(first.id)).status).toBe('completed')
 await runs.close();await other.close()
})
test.each(['あ'.repeat(90000),'\u0000'.repeat(90000)])('large Unicode or JSON-escaped result remains durably readable',async text=>{
 const f=fixture(),runs=new ClaudeDelegations(f.context,async()=>text)
 const first=runs.start(request);const result=await runs.wait(first.id)
 expect(readFileSync(result.resultPath!,'utf8')).toBe(text)
 expect(result.status).toBe('completed');expect(result.truncated).toBe(true);expect(result.result).toBe(text.slice(0,32768))
 const again=new ClaudeDelegations(f.context,async()=>{throw Error('no replay')});expect(again.start(request).result).toBe(result.result)
 await runs.close();await again.close()
})
test('retained receipt and failed worker do not reject a fresh key in either broker',async()=>{
 const f=fixture(),runs=new ClaudeDelegations(f.context,async(_context,id,input)=>{
  if(input.key!=='design')return 'fresh result'
  const root=join(f.context.stateDir,'claude-panes');mkdirSync(root,{mode:0o700})
  writeFileSync(join(root,`delegate-${id}.json`),'{}',{mode:0o600});throw Error('cleanup pending')
 })
 const first=runs.start(request);expect((await runs.wait(first.id)).status).toBe('failed')
 const next=runs.start({...request,key:'same-broker-new-key'});expect((await runs.wait(next.id)).status).toBe('completed')
 const again=new ClaudeDelegations(f.context,async()=> 'recovered')
 expect(again.start(request).id).toBe(first.id)
 const fresh=again.start({...request,key:'another'});expect((await again.wait(fresh.id)).status).toBe('completed')
 expect(readFileSync(join(f.context.stateDir,'claude-panes',`delegate-${first.id}.json`),'utf8')).toBe('{}')
 await runs.close();await again.close()
})

test('dead owner plus old active/cleanup pointers and receipt never prevent a fresh request',async()=>{
 const f=fixture(),oldId='a'.repeat(64)
 const root=join(f.context.stateDir,'delegations',f.context.job.id),panes=join(f.context.stateDir,'claude-panes')
 mkdirSync(root,{recursive:true,mode:0o700});mkdirSync(panes,{mode:0o700})
 for(const name of ['active.json','cleanup.json'])writeFileSync(join(root,name),JSON.stringify({id:oldId}),{mode:0o600})
 const receipt=join(panes,`delegate-${oldId}.json`);writeFileSync(receipt,'{}',{mode:0o600})
 const deadOwner={...readProcessIdentity(process.pid)!,startSec:1}
 writeFileSync(join(root,`${oldId}.json`),JSON.stringify({id:oldId,status:'running',owner:deadOwner}),{mode:0o600})
 expect(pendingClaudeDelegation(f.context.stateDir,f.context.job.id)).toBeNull()
 const runs=new ClaudeDelegations(f.context,async()=> 'ok')
 expect(runs.poll(oldId).status).toBe('interrupted')
 const started=runs.start(request);expect((await runs.wait(started.id)).status).toBe('completed')
 expect(readFileSync(receipt,'utf8')).toBe('{}');await runs.close()
})

test('distinct requests run concurrently across brokers; completion order and cancellation are independent',async()=>{
 const f=fixture();const finish=new Map<string,(value:string)=>void>()
 const worker=async(_c:unknown,_id:string,input:{key:string},signal:AbortSignal)=>new Promise<string>((resolve,reject)=>{
  finish.set(input.key,resolve);signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true})
 })
 const a=new ClaudeDelegations(f.context,worker),b=new ClaudeDelegations(f.context,worker)
 const first=a.start(request),second=b.start({...request,key:'second'}),third=a.start({...request,key:'third'})
 await Bun.sleep(5);expect(finish.size).toBe(3)
 finish.get('second')!('second done');await b.wait(second.id)
 expect(pendingClaudeDelegation(f.context.stateDir,f.context.job.id)).not.toBeNull()
 expect((await a.cancel(third.id)).status).toBe('cancelled')
 expect(a.poll(first.id).status).toBe('running')
 expect(pendingClaudeDelegation(f.context.stateDir,f.context.job.id)).toBe(first.id)
 finish.get('design')!('first done');await a.wait(first.id)
 expect(pendingClaudeDelegation(f.context.stateDir,f.context.job.id)).toBeNull()
 await a.close();await b.close()
})

test('native parent completion remains active until the existing delegated result is collected',async()=>{
 const f=fixture();let finish!:()=>void
 const runs=new ClaudeDelegations(f.context,async()=>{await new Promise<void>(resolve=>{finish=resolve});return 'done'})
 const started=runs.start(request);await Bun.sleep(5)
 const calls:any[]=[];const session={request:async(method:string,params:unknown)=>{calls.push([method,params]);return {result:{}}}} as any
 const pending=pendingClaudeDelegation(f.context.stateDir,f.context.job.id);expect(pending).toBe(started.id)
 expect((await retainGoalForDelegation(session,'thread',f.context.job.id,{objective:'task',status:'complete'},pending))?.status).toBe('active')
 expect(calls).toHaveLength(1);expect(calls[0][0]).toBe('thread/goal/set');expect(calls[0][1].objective).toContain(started.id)
 expect((await retainGoalForDelegation(session,'thread',f.context.job.id,{objective:'task',status:'paused'},pending))?.status).toBe('paused');expect(calls).toHaveLength(1)
 finish();await runs.wait(started.id);expect(pendingClaudeDelegation(f.context.stateDir,f.context.job.id)).toBeNull();await runs.close()
})
test('real child sandbox reads parent inputs and writes outputs the parent can collect',async()=>{
 const f=fixture(),child={...f.context.job,id:'delegate-files',runtime:'claude-code' as const,sessionId:null}
 const prepared=prepareClaudeJobContext(child,f.context.stateDir,{model:request.model,parentJobId:f.context.job.id})
 const asset=join(prepared.inputDir,'synthetic-asset.txt'),output=join(prepared.artifactDir,'synthetic-result.txt')
 writeFileSync(asset,'shared-input',{mode:0o600})
 const runtime=new PrimaryToolRuntime(prepared.toolsContext)
 try {
  const result=await runtime.execute({command:`cat '${asset}' > '${output}'`,yieldMs:10000})
  expect(result.exitCode).toBe(0);expect(readFileSync(output,'utf8')).toBe('shared-input')
  const denied=await runtime.execute({command:`printf forbidden > '${asset}'`,yieldMs:10000})
  expect(denied.exitCode).not.toBe(0);expect(readFileSync(asset,'utf8')).toBe('shared-input')
 } finally {await runtime.close();prepared.retire()}
})

test('preview never splits an emoji surrogate pair and full report is retained',async()=>{
 const f=fixture(),text='x'.repeat(32767)+'😀',runs=new ClaudeDelegations(f.context,async()=>text)
 const first=runs.start(request),result=await runs.wait(first.id)
 expect(result.result).toBe('x'.repeat(32767));expect(result.truncated).toBe(true)
 expect(readFileSync(result.resultPath!,'utf8')).toBe(text);await runs.close()
})

test('partial launch claim becomes interrupted while its broker stays alive',async()=>{
 const f=fixture();let calls=0
 const runs=new ClaudeDelegations(f.context,async()=>{calls++;return 'never'})
 const original=safeFile.atomicWritePrivateFile
 const write=spyOn(safeFile,'atomicWritePrivateFile').mockImplementation((path,content)=>{
  if(path.endsWith('.json')&&String(content).includes('\"status\":\"running\"'))throw Error('synthetic write failure')
  return original(path,content)
 })
 try {expect(()=>runs.start(request)).toThrow('synthetic write failure')} finally {write.mockRestore()}
 expect(runs.start(request).status).toBe('interrupted');expect(calls).toBe(0);await runs.close()
})
test('final record write failure cannot leave a reaped child running',async()=>{
 const f=fixture(),runs=new ClaudeDelegations(f.context,async()=> 'completed report')
 const original=safeFile.atomicWritePrivateFile
 const write=spyOn(safeFile,'atomicWritePrivateFile').mockImplementation((path,content)=>{
  if(path.endsWith('.json')&&String(content).includes('"status":"completed"'))throw Error('synthetic disk failure')
  return original(path,content)
 })
 let id=''
 try {const first=runs.start(request);id=first.id;expect((await runs.wait(id)).status).toBe('completed')} finally {write.mockRestore()}
 expect(runs.poll(id).status).toBe('completed')
 const reopened=new ClaudeDelegations(f.context,async()=>{throw Error('must not replay')})
 expect(reopened.start(request).status).toBe('completed')
 const next=runs.start({...request,key:'after-record-failure'});expect((await runs.wait(next.id)).status).toBe('completed')
 await reopened.close();await expect(runs.close()).rejects.toThrow()
})
test('report storage failure preserves completed child status and preview',async()=>{
 const f=fixture(),runs=new ClaudeDelegations(f.context,async()=> 'completed changes')
 const root=join(f.context.stateDir,'live-input',f.context.job.id);mkdirSync(root,{recursive:true,mode:0o700})
 writeFileSync(join(root,'delegated-results'),'synthetic obstruction',{mode:0o600})
 const first=runs.start(request),result=await runs.wait(first.id)
 expect(result.status).toBe('completed');expect(result.result).toBe('completed changes')
 expect(result.resultPath).toBeUndefined();expect(result.reportError).toContain('do not replay')
 expect(runs.start(request).status).toBe('completed');await runs.close()
})


test.each(['claude-fable-5-1', 'claude-opus-5-5', 'claude-future-9-2'])('requested native model %s reaches worker and argv without family filtering', async model => {
 const f=fixture(),seen:string[]=[],runs=new ClaudeDelegations(f.context,async(_c,_id,input)=>{seen.push(input.model);return 'done'})
 const input={...request,model},first=runs.start(input)
 expect((await runs.wait(first.id)).status).toBe('completed')
 const restarted=new ClaudeDelegations(f.context,async()=>{throw Error('no replay')})
 expect(restarted.start(input).id).toBe(first.id);expect(seen).toEqual([model])
 const prepared=prepareClaudeJobContext({...f.context.job,id:'delegate-model',runtime:'claude-code',sessionId:null},f.context.stateDir,{model,parentJobId:f.context.job.id})
 try {const argv=prepared.argumentsFor('11111111-1111-4111-8111-111111111111',false);expect(argv[argv.indexOf('--model')+1]).toBe(model)} finally {prepared.retire()}
 await runs.close();await restarted.close()
})

test('MCP distinguishes unsent input rejection from uncertain delivery, and accepts a corrected Fable request once',async()=>{
 const f=fixture();let calls=0
 const runs=new ClaudeDelegations(f.context,async()=>{calls++;return 'done'}),server=createDelegationServer(runs)
 const client=new Client({name:'delegation-test',version:'1.0.0'}),[a,b]=InMemoryTransport.createLinkedPair()
 await server.connect(b);await client.connect(a)
 const call=async(input:Record<string,unknown>)=>{
  const reply=await client.callTool({name:'claude_delegate_start',arguments:input})
  return {error:reply.isError,value:JSON.parse((reply.content as Array<{text:string}>)[0]!.text)}
 }
 try {
  for(const model of ['', 'claude-fable-5-1 --resume foreign', 'claude-fable-5-1\n', 'claude-fable-5-1\0']) {
   const reply=await call({...request,model})
   expect(reply.error).toBe(true);expect(reply.value.code).toBe('invalid-model');expect(reply.value.delivery).toBe('not-started')
   expect(calls).toBe(0)
  }
  const badKey=await call({...request,key:'bad key'});expect(badKey.value.code).toBe('invalid-key')
  const badPrompt=await call({...request,prompt:' '});expect(badPrompt.value.code).toBe('invalid-prompt')
  const input={...request,model:'claude-fable-5-1'},first=await call(input)
  expect(first.error).not.toBe(true);await runs.wait(first.value.id)
  expect((await call(input)).value.id).toBe(first.value.id);expect(calls).toBe(1)
  const conflict=await call({...input,model:'claude-opus-5-5'})
  expect(conflict.error).toBe(true);expect(conflict.value.delivery).toBe('unknown');expect(conflict.value.code).toBeUndefined();expect(calls).toBe(1)
  await runs.close()
  expect((await call(input)).value.delivery).toBe('unknown')
 } finally {await runs.close();await client.close();await server.close()}
})
