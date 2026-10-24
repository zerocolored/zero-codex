import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Exercise the real startup code with controlled device/API completion order.
const source=readFileSync(new URL('./public/app.js',import.meta.url),'utf8').replace(/^import .*\n/gm,'').replace(/init\(\)\.catch[\s\S]*$/,'')
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
function setup({denied=false,blocked=false,savedMeta=null,savedChunks=[]}: {denied?:boolean;blocked?:boolean;savedMeta?:any;savedChunks?:any[]}={}){
  const elements=new Map<string,any>(),calls:string[]=[],listeners=new Map<string,Function>()
  let grant:(value:any)=>void=()=>{},stopped=0,requests=0
  const track={stop(){stopped++}},stream={getTracks:()=>[track]}
  const element=(id:string)=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',getContext:()=>({fillRect(){}}),captureStream(){},getAttribute(){},setAttribute(){}});return elements.get(id)}
  class Audio extends EventTarget{state='suspended';resume(){return new Promise(()=>{})}close(){this.state='closed';return Promise.resolve()}}
  const db={transaction(){const tx:any={objectStore:(name:string)=>({get:()=>{const request={result:savedMeta};queueMicrotask(()=>tx.oncomplete?.());return request},put:()=>{queueMicrotask(()=>tx.oncomplete?.());return {}},getAll:()=>{const request={result:savedChunks};queueMicrotask(()=>tx.oncomplete?.());return request}})};return tx}}
  const sandbox:any={acquireRecordingTab:async()=>()=>{},recoverRecordingCount:(rows:any[])=>rows.length,indexedDB:{open(){const request:any={result:db};queueMicrotask(()=>request.onsuccess?.());return request}},document:{getElementById:element},location:{pathname:'/room/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',hash:'#'+'a'.repeat(64)},crypto,DOMException,AbortSignal,Float32Array,Uint8Array,AudioContext:Audio,MediaRecorder:{isTypeSupported:()=>true},window:{MediaRecorder:true,addEventListener:(name:string,fn:Function)=>listeners.set(name,fn)},navigator:{mediaDevices:{getUserMedia(){requests++;return denied?Promise.reject(new DOMException('Denied','NotAllowedError')):new Promise(resolve=>{grant=resolve})}}},setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout,fetch:async(url:string)=>{calls.push(url.split('/').at(-1)!);return {ok:!blocked,json:async()=>blocked?{error:'この会議は終了または期限切れです'}:{project:'fixture',retryable:true}}}}
  runInNewContext(source+`;meta={client:'b'.repeat(64)};this.start=startMeeting;this.finish=finish;this.init=init;`,sandbox)
  return {init:sandbox.init,start:sandbox.start,finish:sandbox.finish,element,calls,grant:()=>grant(stream),stopped:()=>stopped,requests:()=>requests,listeners}
}
test('startup automatically requests microphone, single flight, late grant after End stops tracks',async()=>{
 const f=setup();const pending=f.start();await tick();expect(f.requests()).toBe(1);await f.start();expect(f.requests()).toBe(1)
 await f.finish();f.grant();await pending;expect(f.stopped()).toBe(1);expect(f.calls).toEqual(['join']);expect(f.element('entryStatus').textContent).toBe('会議を終了しました')
})
test('invalid/ended invitation fails before microphone or paid session',async()=>{
 const f=setup({blocked:true});await f.start();expect(f.requests()).toBe(0);expect(f.calls).toEqual(['join'])
})
test('permission denial exposes an explicit retry without repeating the prompt',async()=>{
 const f=setup({denied:true});await f.start();expect(f.requests()).toBe(1);expect(f.element('join').hidden).toBe(false);expect(f.element('entryStatus').textContent).toContain('マイクを許可')
})
test('suspended audio offers gesture recovery and End cancels without creating a paid session',async()=>{
 const f=setup();const pending=f.start();await tick();f.grant();await tick();expect(f.element('join').textContent).toBe('音声を開始');await f.finish();await pending;expect(f.calls).toEqual(['join']);expect(f.stopped()).toBe(1)
})
test('pagehide while microphone prompt is pending releases a late stream',async()=>{
 const f=setup();const pending=f.start();await tick();f.listeners.get('pagehide')!();f.grant();await pending;expect(f.stopped()).toBe(1);expect(f.calls).toEqual(['join'])
})

test('page initialization starts microphone without an entry click',async()=>{
 const f=setup();await f.init();await tick();expect(f.requests()).toBe(1);await f.finish();f.grant();await tick();expect(f.stopped()).toBe(1)
})
test('initialization preserves local chunks even when the server says retryable',async()=>{
 const f=setup({savedMeta:{client:'b'.repeat(64),segment:'segment'},savedChunks:[{room:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',seq:0,blob:new Blob(['recording'])}]});await f.init();expect(f.requests()).toBe(0);expect(f.element('retry').hidden).toBe(false);expect(f.element('status').textContent).toContain('前回の録画')
})
