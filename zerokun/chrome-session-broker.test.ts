import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ChromeSession, chromeTools, validateChromeAction } from './chrome-session-broker.ts'
const roots: string[]=[]
const sessions: ChromeSession[]=[]
afterEach(()=>{for(const s of sessions.splice(0))s.close();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true})})
const ok: CallToolResult={content:[{type:'text',text:'ok'}]}
function root(){const p=realpathSync(mkdtempSync(join(tmpdir(),'zero-chrome-session-')));roots.push(p);return p}
function session(call:(n:string,a:Record<string,unknown>)=>Promise<CallToolResult>,p=root()){const s=new ChromeSession(call,p,1000);sessions.push(s);return s}
test('unsafe tools, implicit tab, host writes and script URLs are rejected before dispatch',()=>{
  for(const [n,a] of [['cookies_get',{}],['javascript_exec',{tabId:1}],['click',{}],['screenshot',{tabId:1,savePath:'/host/file'}],['navigate',{tabId:1,url:'javascript:alert(1)'}],['navigate',{tabId:1,url:'file:///private/file'}]] as const){expect(()=>validateChromeAction(n,a)).toThrow()}
  expect(()=>validateChromeAction('navigate',{tabId:1,url:'https://example.test/'})).not.toThrow()
})
test('advertised tools omit dangerous capabilities and screenshot filesystem parameters',()=>{
  const tools=chromeTools([{name:'cookies_get',inputSchema:{type:'object'}},{name:'screenshot',inputSchema:{type:'object',properties:{tabId:{type:'number'},savePath:{type:'string'},overwrite:{type:'boolean'}}}}])
  expect(tools.map(t=>t.name)).toEqual(['screenshot','release_tab'])
  expect(tools[0]!.inputSchema.required).toContain('tabId')
  expect(tools[0]!.inputSchema.properties).not.toHaveProperty('savePath')
})
test('only initial read-only connection probe retries; mutating operation is sent once',async()=>{
  let probes=0, clicks=0
  const s=session(async n=>{if(n==='tabs_list'&&++probes<3)return {isError:true,content:[{type:'text',text:'Not connected to hub'}]};if(n==='click'){clicks++;return {isError:true,content:[{type:'text',text:'ambiguous timeout'}]}}return ok})
  expect((await s.run('click',{tabId:17,selector:'#submit'})).isError).toBe(true)
  expect(probes).toBe(3);expect(clicks).toBe(1)
})
test('two jobs cannot reserve the same tab; release leaves tab open and permits the next job',async()=>{
  const p=root(),calls:string[]=[]
  const call=async(n:string)=>{calls.push(n);return ok}
  const a=session(call,p),b=session(call,p)
  expect((await a.run('read_page',{tabId:42})).isError).not.toBe(true)
  expect((await b.run('click',{tabId:42,selector:'#submit'})).isError).toBe(true)
  expect(calls).not.toContain('click')
  expect((await a.run('release_tab',{tabId:42})).isError).not.toBe(true)
  expect(calls).not.toContain('coordinate_mode');expect(calls).not.toContain('tabs_close')
  expect((await b.run('click',{tabId:42,selector:'#submit'})).isError).not.toBe(true)
})
test('different tabs share a global operation lock so screenshot activation cannot race another input',async()=>{
  const p=root();let inFlight=0,max=0
  const call=async(n:string)=>{if(n==='tabs_list')return ok;inFlight++;max=Math.max(max,inFlight);await Bun.sleep(150);inFlight--;return ok}
  const a=session(call,p),b=session(call,p)
  await Promise.all([a.run('screenshot',{tabId:1}),b.run('click',{tabId:2,selector:'#test'})])
  expect(max).toBe(1)
})
test('new tabs are reserved before another job can operate them',async()=>{
  const p=root();const call=async(n:string)=>n==='tabs_create'?{content:[{type:'text' as const,text:'{"id":123}'}]}:ok
  const a=session(call,p),b=session(call,p)
  await a.run('tabs_create',{url:'about:blank'})
  expect((await b.run('read_page',{tabId:123})).isError).toBe(true)
})
test('detach false is not reported as release success and another job remains blocked',async()=>{
  const p=root();let detached=false
  const call=async(n:string,a:Record<string,unknown>)=>n==='coordinate_mode'&&a.enable===false?{content:[{type:'text' as const,text:JSON.stringify({detached})}]}:ok
  const a=session(call,p),b=session(call,p)
  await a.run('coordinate_mode',{tabId:88,enable:true})
  expect((await a.run('release_tab',{tabId:88})).isError).toBe(true)
  expect((await b.run('read_page',{tabId:88})).isError).toBe(true)
  detached=true
  expect((await a.run('release_tab',{tabId:88})).isError).not.toBe(true)
  expect((await b.run('read_page',{tabId:88})).isError).not.toBe(true)
})
test('normal shutdown detaches only tabs touched by this session coordinate operations',async()=>{
  const detached:number[]=[]
  const s=session(async(n,a)=>{if(n==='coordinate_mode'&&a.enable===false){detached.push(Number(a.tabId));return {content:[{type:'text',text:'{"detached":true}'}]}}return ok})
  await s.run('read_page',{tabId:1})
  await s.run('coordinate_observe',{tabId:2})
  expect(await s.finish()).toBe(true)
  expect(detached).toEqual([2])
  expect((await s.run('read_page',{tabId:3})).isError).toBe(true)
})
