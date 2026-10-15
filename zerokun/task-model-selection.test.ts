import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { classifyTaskModel, parseModelCatalog, loadTaskModelCatalog, TaskModelSelections, TASK_MODEL_SCHEMA, TaskModelSelectionError, type ModelDecision } from './task-model-selection.ts'
import { ModelSelectionRuntimeError } from './model-selection-runtime.ts'
import { CodexUsageTracker } from './task-usage.ts'
const models = [{id:'gpt-6-astra',medium:true},{id:'gpt-6-sol',medium:true}]
const none = {decision:'none',model:null,evidence:'',continuation:false} as ModelDecision
const sol = {...none,decision:'select',model:'gpt-6-sol',evidence:'Solで'} as ModelDecision
function store() {
 const db=new Database(':memory:')
 db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY, seq INTEGER, chat_id TEXT, thread_ts TEXT, repo_path TEXT, write_enabled INTEGER, workflow TEXT, task TEXT, last_error TEXT); ${TASK_MODEL_SCHEMA}`)
 const add=(id:string,seq:number,task:string,thread='thread')=>db.run('INSERT INTO jobs(id,seq,chat_id,thread_ts,repo_path,write_enabled,workflow,task) VALUES (?,?,?,?,?,?,?,?)',[id,seq,'chat',thread,'repo',1,'work',task])
 return {db, add, selections:new TaskModelSelections(db)}
}
describe('task model selection',()=>{
 test('LLM receives only authored text/context and its grounded selection is accepted',async()=>{
  let prompt=''
  const result=await classifyTaskModel('Solで修正して',models,null,undefined,async(p)=>{prompt=p;return JSON.stringify(sol)})
  expect(result.model).toBe('gpt-6-sol');expect(prompt).toContain('Quoted text');expect(prompt).toContain('Latest author message: "Solで修正して"')
 })
 test.each(['{}','not json',JSON.stringify({...sol,evidence:'not present'}),JSON.stringify({...none,extra:true}),JSON.stringify({...none,model:'gpt-6-sol'})])('rejects invalid classifier output %s',async(raw)=>{
  await expect(classifyTaskModel('Solで修正して',models,null,undefined,async()=>raw)).rejects.toThrow('ZERO_INPUT_CHECK_RUNTIME:invalid-output')
 })
 test('no silent default on classifier timeout or unavailable requested model',async()=>{
  await expect(classifyTaskModel('Solで',models,null,undefined,async()=>{throw Error('thread intent classifier timed out')})).rejects.toThrow('ZERO_INPUT_CHECK_RUNTIME:transport')
  await expect(classifyTaskModel('Solで',models.slice(0,1),null,undefined,async()=>JSON.stringify(sol))).rejects.toThrow('unsupported')
 })
 test('bounded input is rejected instead of dropping a model instruction at the end',async()=>{
  let called=false
  await expect(classifyTaskModel('x'.repeat(48001)+'Solで',models,null,undefined,async()=>{called=true;return JSON.stringify(none)})).rejects.toThrow('unavailable')
  expect(called).toBe(false)
 })
 test('catalog uses exact model ID and advertised effort',()=>{
  expect(parseModelCatalog({data:[{model:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]})).toEqual([models[1]])
  expect(()=>parseModelCatalog({data:[{model:'../../evil',supportedReasoningEfforts:[]}]})).toThrow()
 })
 test('default, durable retry, continuation and independent task reset',async()=>{
  const f=store();let calls=0
  f.add('one',1,'Solで直して')
  const run=async()=>{calls++;return sol}
  expect(await f.selections.resolve('one',[{revision:1,task:'Solで直して'}],models,undefined,run)).toBe('gpt-6-sol')
  const restarted=new TaskModelSelections(f.db)
  expect(await restarted.resolve('one',[{revision:1,task:'Solで直して'}],models,undefined,run)).toBe('gpt-6-sol');expect(calls).toBe(1)
  f.add('two',2,'続けて')
  expect(await restarted.resolve('two',[{revision:1,task:'続けて'}],models,undefined,async()=>({...none,continuation:true}))).toBe('gpt-6-sol')
  f.add('three',3,'別の仕事')
  expect(await restarted.resolve('three',[{revision:1,task:'別の仕事'}],models,undefined,async()=>none)).toBe('gpt-6-astra')
  f.add('four',4,'続けて','other-thread')
  expect(await restarted.resolve('four',[{revision:1,task:'続けて'}],models,undefined,async()=>({...none,continuation:true}))).toBe('gpt-6-astra')
  f.db.close()
 })
 test('clarification retains original request and next answer selects model',async()=>{
  const f=store();f.add('one',1,'AstraかSolでバグを直して')
  await expect(f.selections.resolve('one',[{revision:1,task:'AstraかSolでバグを直して'}],models,undefined,async()=>({...none,decision:'ambiguous'}))).rejects.toThrow('ambiguous')
  f.add('two',2,'Solで')
  expect(await f.selections.resolve('two',[{revision:1,task:'Solで'}],models,undefined,async(text,catalog,prior)=>{
   expect(prior?.task).toBe('AstraかSolでバグを直して');return {...sol,continuation:true}
  })).toBe('gpt-6-sol')
  f.db.close()
 })
 test('later input explicitly switches and retry keeps selection; catalog withdrawal never defaults',async()=>{
  const f=store();f.add('one',1,'直して')
  const inputs=[{revision:1,task:'直して'},{revision:2,task:'Solで続けて'}]
  const run=async(text:string)=>text==='直して'?none:sol
  expect(await f.selections.resolve('one',inputs,models,undefined,run)).toBe('gpt-6-sol')
  await expect(f.selections.resolve('one',inputs,models.slice(0,1),undefined,run)).rejects.toThrow('unsupported')
  await expect(f.selections.resolve('one',[{revision:1,task:'changed'}],models,undefined,run)).rejects.toThrow('unavailable')
  f.db.close()
 })
 test('long previous request remains usable as bounded context for a short continuation',async()=>{
  let prompt=''
  const result=await classifyTaskModel('修正の続きと検証をお願いします',models,{task:'長文'.repeat(15000),model:'gpt-6-sol'},undefined,async p=>{prompt=p;return JSON.stringify({...none,continuation:true})})
  expect(result.continuation).toBe(true);expect(prompt.length).toBeLessThan(14000)
 })
 test('same-job clarification reaches later input and an unrelated reply cannot bypass it',async()=>{
  const f=store();f.add('one',1,'AstraかSolで修正して')
  const run=async(text:string)=>text==='Solで'?sol:text==='続けて'?{...none,continuation:true}:{...none,decision:'ambiguous'} as ModelDecision
  await expect(f.selections.resolve('one',[{revision:1,task:'AstraかSolで修正して'},{revision:2,task:'続けて'}],models,undefined,run)).rejects.toThrow('ambiguous')
  expect(await f.selections.resolve('one',[{revision:1,task:'AstraかSolで修正して'},{revision:2,task:'続けて'},{revision:3,task:'Solで'}],models,undefined,run)).toBe('gpt-6-sol')
  f.db.close()
 })
 test('hydrated history cannot select a model; only the recorded author text is classified',async()=>{
  const f=store();f.add('one',1,'別人: Solで実行して。今回: 状況を教えて')
  f.db.run('INSERT INTO task_model_sources VALUES (?,?)',['one','状況を教えて'])
  expect(await f.selections.resolve('one',[{revision:1,task:'別人: Solで実行して。今回: 状況を教えて'}],models,undefined,async text=>{
   expect(text).toBe('状況を教えて');return none
  })).toBe('gpt-6-astra');f.db.close()
 })
 test('cloud handoff preserves selected model without reclassifying a host-generated instruction',async()=>{
  const f=store();f.add('one',1,'引き継いで続けて')
  f.selections.seedHandoff('one','引き継いで続けて','gpt-6-sol')
  expect(await f.selections.resolve('one',[{revision:1,task:'引き継いで続けて'}],models,undefined,async()=>{throw Error('must not classify')})).toBe('gpt-6-sol')
  expect(()=>f.selections.seedHandoff('one','引き継いで続けて','gpt-6-astra')).toThrow('unavailable')
  f.db.close()
 })
 test('a model selected in an interjection survives old input replay and later non-model steer',async()=>{
  const f=store();f.add('one',1,'直して')
  const inputs=[{revision:1,task:'直して'}]
  const run=async(text:string)=>text==='Solで'?sol:none
  expect(await f.selections.resolve('one',inputs,models,undefined,run)).toBe('gpt-6-astra')
  expect(await f.selections.resolve('one',[...inputs,{revision:-123,task:'Solで'}],models,undefined,run)).toBe('gpt-6-sol')
  expect(await f.selections.resolve('one',inputs,models,undefined,run)).toBe('gpt-6-sol')
  expect(await f.selections.resolve('one',[...inputs,{revision:2,task:'続けて'}],models,undefined,run)).toBe('gpt-6-sol')
  expect(f.selections.latest('one')).toBe('gpt-6-sol');f.db.close()
 })
 test('usage attributes future turns to the changed model without relabelling old turns',()=>{
  const tracker=new CodexUsageTracker('gpt-6-astra')
  tracker.observe({method:'turn/started',params:{threadId:'thread',turn:{id:'one'}}})
  tracker.setModel('gpt-6-sol')
  tracker.observe({method:'turn/started',params:{threadId:'thread',turn:{id:'two'}}})
  expect(tracker.document(false).turns.map(t=>t.model)).toEqual(['gpt-6-astra','gpt-6-sol'])
 })
})


describe('current model catalog',()=>{
 const entry=(model:string)=>({model,supportedReasoningEfforts:[{reasoningEffort:'medium'}]})
 test('preserves available provider metadata without assuming GPT IDs',async()=>{
  const catalog=parseModelCatalog({data:[{...entry('other-provider-v2'),displayName:'Other 2',description:'Latest Other family',upgrade:null}]})
  expect(catalog).toEqual([{id:'other-provider-v2',medium:true,displayName:'Other 2',description:'Latest Other family'}])
  await classifyTaskModel('Otherで直して',catalog,null,undefined,async prompt=>{
   expect(prompt).toContain(JSON.stringify(catalog))
   return JSON.stringify({...none,decision:'select',model:'other-provider-v2',evidence:'Otherで'})
  })
 })
 test('assembles all pages and independently reloads the catalog',async()=>{
  const cursors:(string|null)[]=[]
  let version=1
  const read=async(cursor:string|null)=>{cursors.push(cursor);return cursor?{data:[entry('other-v'+version)],nextCursor:null}:{data:[entry('gpt-6-astra')],nextCursor:'next'}}
  expect((await loadTaskModelCatalog(read)).map(m=>m.id)).toEqual(['gpt-6-astra','other-v1'])
  version=2
  expect((await loadTaskModelCatalog(read)).map(m=>m.id)).toEqual(['gpt-6-astra','other-v2'])
  expect(cursors).toEqual([null,'next',null,'next'])
 })
 test('rejects incomplete, looping and excessively paginated catalogs',async()=>{
  await expect(loadTaskModelCatalog(async cursor=>{if(cursor)throw Error('offline');return {data:[entry('old')],nextCursor:'next'}})).rejects.toThrow('offline')
  await expect(loadTaskModelCatalog(async()=>({data:[],nextCursor:'same'}))).rejects.toThrow('configuration')
  let count=0
  await expect(loadTaskModelCatalog(async()=>({data:[],nextCursor:String(++count)}))).rejects.toThrow('configuration')
  expect(count).toBe(20)
  await expect(loadTaskModelCatalog(async()=>({data:[],nextCursor:123}))).rejects.toThrow('configuration')
 })
 test('cancellation prevents classification with a partially fetched catalog',async()=>{
  const controller=new AbortController()
  let calls=0
  await expect(loadTaskModelCatalog(async()=>{calls++;controller.abort();return {data:[entry('old')],nextCursor:'next'}},controller.signal)).rejects.toThrow()
  expect(calls).toBe(1)
 })
})

describe('delegation roles and primary correction',()=>{
 test('delegation and media stay in authored task; explicit primary selection remains separate',async()=>{
  const f=store();const task='GPT Image 2.5を使って動画化し、opus5.5に依頼してください';f.add('one',1,task)
  const run=async(text:string)=>classifyTaskModel(text,models,null,undefined,async prompt=>{
   expect(prompt).toContain('PRIMARY Codex app-server worker');expect(prompt).toContain('Latest author message: '+JSON.stringify(task));return JSON.stringify(none)
  })
  expect(await f.selections.resolve('one',[{revision:1,task}],models,undefined,run)).toBe('gpt-6-astra')
  f.add('two',2,'Solで主担当を続け、Opusに依頼')
  expect(await f.selections.resolve('two',[{revision:1,task:'Solで主担当を続け、Opusに依頼'}],models,undefined,async()=>sol)).toBe('gpt-6-sol');f.db.close()
 })
 test('explicit correction clears a durable error and keeps last valid primary across jobs',async()=>{
  const f=store();f.add('one',1,'Solで');await f.selections.resolve('one',[{revision:1,task:'Solで'}],models,undefined,async()=>sol)
  f.add('two',2,'Opusに依頼')
  await expect(f.selections.resolve('two',[{revision:1,task:'Opusに依頼'}],models,undefined,async()=>({...none,decision:'unsupported'}))).rejects.toThrow('unsupported')
  const inputs=[{revision:1,task:'Opusに依頼'},{revision:2,task:'続けて'}]
  await expect(f.selections.resolve('two',inputs,models,undefined,async()=>({...none,continuation:true}))).rejects.toThrow('unsupported')
  const correction='主担当は変えない。Opusは委任先です'
  expect(await f.selections.resolve('two',[...inputs,{revision:3,task:correction}],models,undefined,async()=>({...none,decision:'retain',evidence:correction,continuation:true}))).toBe('gpt-6-sol')
  expect(await f.selections.resolve('two',inputs,models,undefined,async()=>{throw Error('no replay')})).toBe('gpt-6-sol');f.db.close()
 })
 test('correction is grounded and restores default only when no valid choice exists',async()=>{
  const text='主担当は変えない'
  await expect(classifyTaskModel(text,models,null,undefined,async()=>JSON.stringify({...none,decision:'retain'}))).rejects.toThrow('ZERO_INPUT_CHECK_RUNTIME:invalid-output')
  expect((await classifyTaskModel(text,models,null,undefined,async()=>JSON.stringify({...none,decision:'retain',evidence:text}))).decision).toBe('retain')
  const f=store();f.add('one',1,'Opusに依頼')
  await expect(f.selections.resolve('one',[{revision:1,task:'Opusに依頼'}],models,undefined,async()=>({...none,decision:'unsupported'}))).rejects.toThrow('unsupported')
  f.add('two',2,text)
  expect(await f.selections.resolve('two',[{revision:1,task:text}],models,undefined,async()=>({...none,decision:'retain',evidence:text,continuation:true}))).toBe('gpt-6-astra');f.db.close()
 })
})


describe('ordinary continuation availability',()=>{
 const offline=async()=>{throw new TaskModelSelectionError('unavailable','timeout')}
 test.each(['keep going',' KEEP   GOING! ','Please continue.','resume, please','go on','続けて','そのまま続けてください。','作業を再開してください','引き続き進めてお願いします','継続してください','よい','良い。','はい','YES!','ＯＫ','それでいいです','つづけて'])('whole control request %s never starts classifier',async task=>{
  expect(await classifyTaskModel(task,models,null,undefined,async()=>{throw Error('must not launch')})).toEqual({...none,continuation:true})
  const f=store();f.add('one',1,'Solで');await f.selections.resolve('one',[{revision:1,task:'Solで'}],models,undefined,async()=>sol)
  f.add('two',2,task)
  expect(await f.selections.resolve('two',[{revision:1,task}],models,undefined,offline)).toBe('gpt-6-sol')
  expect(await f.selections.resolve('two',[{revision:1,task},{revision:2,task:'続けて'}],models,undefined,offline)).toBe('gpt-6-sol')
  expect(await f.selections.resolve('two',[{revision:1,task}],models,undefined,offline)).toBe('gpt-6-sol');f.db.close()
 })
 test.each(['keep going, but use Sol','続けて。主担当をSolに変更','continue with NewFamily','「続けて」','keep going\nSolで','再開して。ただしOpusに依頼','はい、Solで','よいモデルに変えて','OK\nNewFamilyで'])('mixed input %s still requires semantic classification',async text=>{
  await expect(classifyTaskModel(text,models,null,undefined,async()=>{throw Error('thread intent classifier timed out')})).rejects.toThrow('ZERO_INPUT_CHECK_RUNTIME:transport')
 })
 test('fresh continuation defaults to Astra; catalog withdrawal and abort still block',async()=>{
  const f=store();f.add('one',1,'keep going')
  expect(await f.selections.resolve('one',[{revision:1,task:'keep going'}],models,undefined,offline)).toBe('gpt-6-astra')
  await expect(f.selections.resolve('one',[{revision:1,task:'keep going'}],models.slice(1),undefined,offline)).rejects.toThrow('unsupported')
  const c=new AbortController();c.abort()
  await expect(f.selections.resolve('one',[{revision:1,task:'keep going'}],models,c.signal,offline)).rejects.toThrow()
  await expect(classifyTaskModel('keep going',models,null,c.signal)).rejects.toThrow();f.db.close()
 })
 test('classification failure stays pending across continuation jobs, and explicit correction resolves it',async()=>{
  const f=store();f.add('one',1,'Solで');await f.selections.resolve('one',[{revision:1,task:'Solで'}],models,undefined,async()=>sol)
  f.add('two',2,'主担当をNewFamilyに変更')
  await expect(f.selections.resolve('two',[{revision:1,task:'主担当をNewFamilyに変更'}],models,undefined,offline)).rejects.toThrow('[classifier:timeout]')
  for(const [id,seq] of [['three',3],['four',4]] as const){
   f.add(id,seq,'keep going')
   await expect(f.selections.resolve(id,[{revision:1,task:'keep going'}],models,undefined,offline)).rejects.toThrow('unavailable')
  }
  f.add('five',5,'主担当は変えない')
  expect(await f.selections.resolve('five',[{revision:1,task:'主担当は変えない'}],models,undefined,async()=>({...none,decision:'retain',evidence:'主担当は変えない',continuation:true}))).toBe('gpt-6-sol');f.db.close()
 })
 test('failed classification can be retried on the same revision without losing the existing model',async()=>{
  const f=store();f.add('one',1,'Solで')
  const base={revision:1,task:'Solで'}
  await f.selections.resolve('one',[base],models,undefined,async()=>sol)
  const more={revision:2,task:'追加の修正をお願いします'}
  await expect(f.selections.resolve('one',[base,more],models,undefined,offline)).rejects.toThrow('unavailable')
  expect(await f.selections.resolve('one',[base,more],models,undefined,async()=>({...none,continuation:true}))).toBe('gpt-6-sol')
  expect(await f.selections.resolve('one',[base,more],models,undefined,offline)).toBe('gpt-6-sol');f.db.close()
 })
 test('failed first classification is retried, explicit later selection survives old replay',async()=>{
  const f=store();f.add('one',1,'NewFamilyで')
  const base={revision:1,task:'NewFamilyで'}
  await expect(f.selections.resolve('one',[base],models,undefined,offline)).rejects.toThrow('unavailable')
  expect(await f.selections.resolve('one',[base],models,undefined,async()=>none)).toBe('gpt-6-astra')
  f.add('two',2,'NewFamilyで')
  await expect(f.selections.resolve('two',[base],models,undefined,offline)).rejects.toThrow('unavailable')
  expect(await f.selections.resolve('two',[{revision:2,task:'Solで'}],models,undefined,async()=>sol)).toBe('gpt-6-sol')
  expect(await f.selections.resolve('two',[base],models,undefined,offline)).toBe('gpt-6-sol');f.db.close()
 })
 test('a later explicit selection resolves classifier failure without re-running the failed input first',async()=>{
  const f=store();f.add('one',1,'NewFamilyで')
  const base={revision:1,task:'NewFamilyで'}
  await expect(f.selections.resolve('one',[base],models,undefined,offline)).rejects.toThrow('unavailable')
  expect(await f.selections.resolve('one',[base,{revision:2,task:'Solで'}],models,undefined,async text=>{
   expect(text).toBe('Solで');return sol
  })).toBe('gpt-6-sol');f.db.close()
 })
 test('retry does not resurrect an older job failure after an explicit selection resolved it',async()=>{
  const f=store();f.add('old',1,'NewFamilyで')
  await expect(f.selections.resolve('old',[{revision:1,task:'NewFamilyで'}],models,undefined,offline)).rejects.toThrow('unavailable')
  f.add('current',2,'Solで')
  const choice={revision:1,task:'Solで'}, more={revision:2,task:'追加の修正をお願いします'}
  expect(await f.selections.resolve('current',[choice],models,undefined,async()=>({...sol,continuation:true}))).toBe('gpt-6-sol')
  await expect(f.selections.resolve('current',[choice,more],models,undefined,offline)).rejects.toThrow('unavailable')
  expect(await f.selections.resolve('current',[choice,more],models,undefined,async()=>({...none,continuation:true}))).toBe('gpt-6-sol')
  expect(await f.selections.resolve('current',[choice,more,{revision:3,task:'keep going'}],models,undefined,offline)).toBe('gpt-6-sol');f.db.close()
 })
 test.each(['keep going','主担当をNewFamilyに変更'])('legacy rowless failure %s is recovered without ignoring model directives',async task=>{
  const f=store();f.add('one',1,'Solで');await f.selections.resolve('one',[{revision:1,task:'Solで'}],models,undefined,async()=>sol)
  f.add('two',2,task);f.db.run('UPDATE jobs SET last_error=? WHERE id=?',['ZERO_MODEL_SELECTION:unavailable','two'])
  f.add('three',3,'keep going')
  const result=f.selections.resolve('three',[{revision:1,task:'keep going'}],models,undefined,offline)
  if(task==='keep going')expect(await result).toBe('gpt-6-sol')
  else await expect(result).rejects.toThrow('unavailable')
  f.db.close()
 })
 test('same-job ordinary steering retries the original failed input after recovery',async()=>{
  const f=store();f.add('one',1,'NewFamilyで')
  const base={revision:1,task:'NewFamilyで'},more={revision:2,task:'keep going'}
  await expect(f.selections.resolve('one',[base],models,undefined,offline)).rejects.toThrow('unavailable')
  await expect(f.selections.resolve('one',[base,more],models,undefined,offline)).rejects.toThrow('unavailable')
  const seen:string[]=[]
  expect(await f.selections.resolve('one',[base,more],models,undefined,async text=>{seen.push(text);return sol})).toBe('gpt-6-sol')
  expect(seen).toEqual(['NewFamilyで']);f.db.close()
 })
 test('cross-job continuation retries the original instruction and clears propagated failure references',async()=>{
  const f=store();f.add('one',1,'追加の修正をお願いします')
  await expect(f.selections.resolve('one',[{revision:1,task:'追加の修正をお願いします'}],models,undefined,offline)).rejects.toThrow('unavailable')
  f.add('two',2,'keep going')
  await expect(f.selections.resolve('two',[{revision:1,task:'keep going'}],models,undefined,offline)).rejects.toThrow('unavailable')
  f.add('three',3,'keep going')
  let calls=0
  expect(await f.selections.resolve('three',[{revision:1,task:'keep going'}],models,undefined,async text=>{
   calls++;expect(text).toBe('追加の修正をお願いします');return none
  })).toBe('gpt-6-astra')
  expect(calls).toBe(1)
  expect(await f.selections.resolve('two',[{revision:1,task:'keep going'}],models,undefined,offline)).toBe('gpt-6-astra');f.db.close()
 })
 test('handoff sees recovered model even when older pending references remain',async()=>{
  const f=store();f.add('one',1,'Solで')
  const first={revision:1,task:'Solで'},more={revision:2,task:'keep going'}
  await expect(f.selections.resolve('one',[first,more],models,undefined,offline)).rejects.toThrow('unavailable')
  await expect(f.selections.resolve('one',[first,more],models,undefined,offline)).rejects.toThrow('unavailable')
  expect(f.selections.latest('one')).toBeNull()
  f.add('two',2,'keep going')
  expect(await f.selections.resolve('two',[{revision:1,task:'keep going'}],models,undefined,async()=>sol)).toBe('gpt-6-sol')
  expect(f.selections.latest('one')).toBe('gpt-6-sol');f.db.close()
 })
 test.each(['ambiguous','unsupported'] as const)('recovered %s directive remains pending until an explicit resolution',async reason=>{
  const f=store();f.add('one',1,'NewFamilyで')
  await expect(f.selections.resolve('one',[{revision:1,task:'NewFamilyで'}],models,undefined,offline)).rejects.toThrow('unavailable')
  f.add('two',2,'keep going');const request={revision:1,task:'keep going'}
  await expect(f.selections.resolve('two',[request],models,undefined,async()=>({...none,decision:reason}))).rejects.toThrow(reason)
  await expect(f.selections.resolve('two',[request],models,undefined,offline)).rejects.toThrow(reason)
  expect(await f.selections.resolve('two',[request,{revision:2,task:'Solで'}],models,undefined,async()=>sol)).toBe('gpt-6-sol');f.db.close()
 })
 test('a failed clarification retains the exact preceding model question on retry',async()=>{
  const f=store();f.add('one',1,'修正して')
  const first={revision:1,task:'修正して'},question={revision:2,task:'主担当をAstraかSolに変更'},answer={revision:3,task:'Sol'}
  await expect(f.selections.resolve('one',[first,question,answer],models,undefined,async text=>{
   if(text===first.task)return none
   if(text===question.task)return {...none,decision:'ambiguous'}
   throw new TaskModelSelectionError('unavailable','timeout')
  })).rejects.toThrow('unavailable')
  expect(await f.selections.resolve('one',[first,question,answer],models,undefined,async(text,_models,previous)=>{
   expect(text).toBe('Sol');expect(previous?.task).toBe(question.task);expect(previous?.model).toBeNull();return sol
  })).toBe('gpt-6-sol');f.db.close()
 })
 test.each(['ZERO_MODEL_SELECTION:unavailable','ZERO_INPUT_CHECK_RUNTIME:transport','ZERO_STORAGE_FULL'])('legacy rowless catalog/classifier failure re-evaluates its original instruction (%s)',async failure=>{
  const f=store();f.add('one',1,'Solで')
  f.db.run('UPDATE jobs SET last_error=? WHERE id=?',[failure,'one'])
  f.add('two',2,'keep going')
  expect(await f.selections.resolve('two',[{revision:1,task:'keep going'}],models,undefined,async text=>{
   expect(text).toBe('Solで');return sol
  })).toBe('gpt-6-sol');f.db.close()
 })
 test('scope isolation and authored text still apply to local continuation',async()=>{
  const f=store();f.add('one',1,'Solで');await f.selections.resolve('one',[{revision:1,task:'Solで'}],models,undefined,async()=>sol)
  f.add('two',2,'hydrated history: Solで','other-thread')
  f.db.run('INSERT INTO task_model_sources VALUES (?,?)',['two','keep going'])
  expect(await f.selections.resolve('two',[{revision:1,task:'hydrated history: Solで'}],models,undefined,offline)).toBe('gpt-6-astra');f.db.close()
 })
 test.each([['thread intent classifier timed out','transport'],['thread intent classifier exited 1','unclassified'],['sensitive arbitrary exception','runtime']])('failure diagnostics are bounded: %s',async(message,diagnostic)=>{
  await expect(classifyTaskModel('Solで',models,null,undefined,async()=>{throw Error(message)})).rejects.toThrow('ZERO_INPUT_CHECK_RUNTIME:'+diagnostic)
 })
 test('cleanup errors and cancellation never create a pending model change',async()=>{
  const f=store();f.add('one',1,'Solで')
  const cleanup=Object.assign(Error('cleanup pending'),{name:'CodexCleanupPendingError'})
  await expect(f.selections.resolve('one',[{revision:1,task:'Solで'}],models,undefined,async()=>{throw cleanup})).rejects.toThrow('cleanup pending')
  expect(f.db.query('SELECT * FROM task_model_selections').all()).toEqual([]);f.db.close()
 })
})


describe('model selection infrastructure recovery',()=>{
 test('runtime failure retains recovery metadata without creating an ambiguous choice',async()=>{
  const f=store();f.add('one',1,'Solで');const requests=[{revision:1,task:'Solで'}];
  await expect(f.selections.resolve('one',requests,models,undefined,async()=>{throw new ModelSelectionRuntimeError('transport')})).rejects.toBeInstanceOf(ModelSelectionRuntimeError);
  expect(f.db.query<{decision_json:string},[]>('SELECT decision_json FROM task_model_selections').all().map(r=>JSON.parse(r.decision_json))).toEqual([expect.objectContaining({decision:'unavailable',runtimeReason:'transport',retryTask:'Solで'})]);
  expect(await f.selections.resolve('one',requests,models,undefined,async()=>sol)).toBe('gpt-6-sol');f.db.close();
 });
 test('the incident legacy unavailable acknowledgement recovers with the previous model, without a classifier',async()=>{
  const f=store();f.add('one',1,'Solで');await f.selections.resolve('one',[{revision:1,task:'Solで'}],models,undefined,async()=>sol);
  f.add('two',2,'よい');
  const digest=new Bun.CryptoHasher('sha256').update('よい').digest('hex');
  f.db.run('INSERT INTO task_model_selections VALUES (?,?,?,?,?)',['two',1,digest,JSON.stringify({decision:'unavailable',model:null,evidence:'',continuation:true,retryTask:'よい',retryPrevious:{task:'Solで',model:'gpt-6-sol'}}),null]);
  f.add('three',3,'続けて');
  expect(await f.selections.resolve('three',[{revision:1,task:'続けて'}],models,undefined,async()=>{throw Error('must not launch')})).toBe('gpt-6-sol');f.db.close();
 });
 test.each(['ambiguous','unsupported'] as const)('an acknowledgement cannot resolve a real %s model choice',async reason=>{
  const f=store();f.add('one',1,'NewFamilyで');await expect(f.selections.resolve('one',[{revision:1,task:'NewFamilyで'}],models,undefined,async()=>({...none,decision:reason}))).rejects.toThrow(reason);
  f.add('two',2,'よい');await expect(f.selections.resolve('two',[{revision:1,task:'よい'}],models,undefined,async()=>{throw Error('must not launch')})).rejects.toThrow(reason);f.db.close();
 });
});

test('permanent runtime failure cannot lose an explicit switch on the next continuation',async()=>{
 const f=store();f.add('one',1,'Solで');
 await expect(f.selections.resolve('one',[{revision:1,task:'Solで'}],models,undefined,async()=>{throw new ModelSelectionRuntimeError('authentication')})).rejects.toThrow('authentication');
 f.add('two',2,'よい');let checked='';
 expect(await f.selections.resolve('two',[{revision:1,task:'よい'}],models,undefined,async text=>{checked=text;return sol})).toBe('gpt-6-sol');expect(checked).toBe('Solで');f.db.close();
});
