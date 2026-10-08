import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { classifyTaskModel, parseModelCatalog, TaskModelSelections, TASK_MODEL_SCHEMA, TaskModelSelectionError, type ModelDecision } from './task-model-selection.ts'
import { CodexUsageTracker } from './task-usage.ts'
const models = [{id:'gpt-6-astra',medium:true},{id:'gpt-6-sol',medium:true}]
const none = {decision:'none',model:null,evidence:'',continuation:false} as ModelDecision
const sol = {...none,decision:'select',model:'gpt-6-sol',evidence:'Solで'} as ModelDecision
function store() {
 const db=new Database(':memory:')
 db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY, seq INTEGER, chat_id TEXT, thread_ts TEXT, repo_path TEXT, write_enabled INTEGER, workflow TEXT, task TEXT); ${TASK_MODEL_SCHEMA}`)
 const add=(id:string,seq:number,task:string,thread='thread')=>db.run('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)',[id,seq,'chat',thread,'repo',1,'work',task])
 return {db, add, selections:new TaskModelSelections(db)}
}
describe('task model selection',()=>{
 test('LLM receives only authored text/context and its grounded selection is accepted',async()=>{
  let prompt=''
  const result=await classifyTaskModel('Solで修正して',models,null,undefined,async(p)=>{prompt=p;return JSON.stringify(sol)})
  expect(result.model).toBe('gpt-6-sol');expect(prompt).toContain('Quoted text');expect(prompt).toContain('Latest author message: "Solで修正して"')
 })
 test.each(['{}','not json',JSON.stringify({...sol,evidence:'not present'}),JSON.stringify({...none,extra:true}),JSON.stringify({...none,model:'gpt-6-sol'})])('rejects invalid classifier output %s',async(raw)=>{
  await expect(classifyTaskModel('Solで修正して',models,null,undefined,async()=>raw)).rejects.toThrow('ZERO_MODEL_SELECTION:unavailable')
 })
 test('no silent default on classifier timeout or unavailable requested model',async()=>{
  await expect(classifyTaskModel('Solで',models,null,undefined,async()=>{throw Error('timeout')})).rejects.toThrow('unavailable')
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
  const result=await classifyTaskModel('続けて',models,{task:'長文'.repeat(15000),model:'gpt-6-sol'},undefined,async p=>{prompt=p;return JSON.stringify({...none,continuation:true})})
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
