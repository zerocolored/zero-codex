import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createMeetingService } from './service.ts'
import { createMeetingInvitation, syncMeetingRecordings, meetingRecordingInstructions } from '../zerokun/meeting-client.ts'

const origin='https://meeting.example',admin='a'.repeat(64),client='b'.repeat(64)
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'meeting-test-')),calls:any[]=[]
  const options={directory:root,origin,adminToken:admin,apiKey:'fixture-key',simliApiKey:'fixture-simli-key',faceId:'fixture-face',fetcher:(async(url,init)=>{
    calls.push({url,body:init?.body?JSON.parse(String(init.body)):null})
    if(String(url).endsWith('/compose/token'))return Response.json({session_token:'limited-session-token'})
    if(String(url).endsWith('/compose/ice'))return Response.json([{urls:'stun:fixture.invalid'}])
    if(String(url).endsWith('/responses'))return Response.json({output:[{content:[{type:'output_text',text:'画面の要約'}]}]})
    return Response.json({session:{id:'live_fixture'},transport:{sdp:'fixture answer'}})
  }) as typeof fetch}
  const service=createMeetingService(options)
  const send=(path:string,method='GET',body?:unknown,token=admin,extra:Record<string,string>={})=>service.fetch(new Request(origin+path,{method,headers:{authorization:`Bearer ${token}`,origin,'x-meeting-client':client,'content-type':'application/json',...extra},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}))
  const create=async(key='request-1')=>await (await send('/api/rooms','POST',{requestId:key,project:'fixture',summary:'project summary',history:'thread history'})).json() as {id:string;url:string;expires:number}
  const prepare=async(room:{id:string;url:string})=>{
    const invite=new URL(room.url).hash.slice(1),base=`/api/rooms/${room.id}`,segment=crypto.randomUUID()
    expect((await send(base+'/join','POST',{},invite)).status).toBe(200)
    expect((await send(base+'/prepare','POST',{segment,mime:'video/webm'},invite)).status).toBe(200)
    return {invite,base,segment}
  }
  return{root,service,options,calls,send,create,prepare,close(){service.db.close();rmSync(root,{recursive:true,force:true})}}
}
test('room creation is durable/idempotent and IDs are not authorization; unfurls do not claim rooms',async()=>{
  const f=fixture();try{
    const room=await f.create();expect(await f.create()).toEqual(room)
    expect((await f.send(`/room/${room.id}`)).status).toBe(200)
    expect((await f.send(`/api/rooms/${room.id}/join`,'POST',{},room.id)).status).toBe(401)
    const {base,invite}=await f.prepare(room)
    expect((await f.send(base+'/join','POST',{},invite,{'x-meeting-client':'c'.repeat(64)})).status).toBe(409)
    expect((await f.send(base+'/manifest','GET',undefined,invite)).status).toBe(403)
    const other=await f.create('other')
    expect((await f.send(`/api/rooms/${other.id}/join`,'POST',{},invite)).status).toBe(401)
    expect((await f.send(base+'/join','POST',{},invite,{origin:'https://evil.example'})).status).toBe(403)
  }finally{f.close()}
})
test('SDP exchange uses pinned GPT Live contract and context; repeated call cannot incur another session',async()=>{
  const f=fixture();try{
    const room=await f.create(),{base,invite,segment}=await f.prepare(room)
    const body={segment,mime:'video/webm',sdp:'offer'}
    const response=await f.send(base+'/session','POST',body,invite)
    expect(response.status).toBe(200);expect(await response.json()).toEqual({sdp:'fixture answer'})
    expect(f.calls[0].url).toBe('https://api.openai.com/v1/live/sessions')
    expect(f.calls[0].body.session.model).toBe('gpt-live-1')
    expect(JSON.stringify(f.calls[0].body.session.input)).toContain('project summary');expect(JSON.stringify(f.calls[0].body.session.input)).toContain('thread history')
    expect((await f.send(base+'/session','POST',body,invite)).status).toBe(409);expect(f.calls).toHaveLength(1)
    expect((await f.send(base+'/session','POST',{...body,instructions:'override'},invite)).status).toBe(400)
  }finally{f.close()}
})
test('recording accepts reordered retries, rejects corrupt/different/missing chunks and survives server restart',async()=>{
  const f=fixture();try{
    const room=await f.create(),{base,invite,segment}=await f.prepare(room)
    const put=(seq:number,bytes:string,hash=sha(bytes))=>f.send(`${base}/chunks/${segment}/${seq}`,'PUT',bytes,invite,{'x-content-sha256':hash})
    expect((await put(1,'tail')).status).toBe(200)
    expect((await f.send(base+'/finish','POST',{segment,count:2},invite)).status).toBe(409)
    expect((await put(0,'head','0'.repeat(64))).status).toBe(400)
    expect((await put(0,'head')).status).toBe(200)
    expect((await put(0,'head')).status).toBe(200)
    expect((await put(0,'different')).status).toBe(409)
    expect((await f.send(base+'/finish','POST',{segment,count:2},invite)).status).toBe(200)
    expect((await put(2,'extra')).status).toBe(409)
    const restarted=createMeetingService(f.options)
    const manifest=await (await restarted.fetch(new Request(origin+base+'/manifest',{headers:{authorization:`Bearer ${admin}`}}))).json() as any
    expect(manifest.segments[0].chunks.map((c:any)=>c.hash)).toEqual([sha('head'),sha('tail')]);restarted.db.close()
  }finally{f.close()}
})
test('local sync verifies bytes, assembles one container, acknowledges durable save, scopes later references',async()=>{
  const f=fixture(),state=mkdtempSync(join(tmpdir(),'meeting-client-test-'))
  try{
    writeFileSync(join(state,'meeting.json'),JSON.stringify({origin,adminToken:admin}),{mode:0o600})
    const fetcher=(async(url,init)=>f.service.fetch(new Request(String(url),init))) as typeof fetch
    const input={state,repo:'/fixture/project',chat:'C1',thread:'100.1',key:'C1:100.2',summary:async()=>'fixture summary',history:async()=>'fixture history'}
    const url=await createMeetingInvitation(input,fetcher);expect(await createMeetingInvitation({...input,history:async()=>{throw Error('must reuse')}},fetcher)).toBe(url)
    const id=new URL(url).pathname.split('/').at(-1)!,{base,invite,segment}=await f.prepare({id,url})
    for(const [seq,bytes] of ['webm header','webm data'].entries())expect((await f.send(`${base}/chunks/${segment}/${seq}`,'PUT',bytes,invite,{'x-content-sha256':sha(bytes)})).status).toBe(200)
    await f.send(base+'/finish','POST',{segment,count:2},invite)
    const corrupt=(async(url,init)=>String(url).includes('/chunks/')?new Response('corrupt'):fetcher(url,init)) as typeof fetch
    await expect(syncMeetingRecordings(state,corrupt)).rejects.toThrow()
    expect((await (await f.send(base+'/status')).json() as any).state).toBe('uploaded')
    await syncMeetingRecordings(state,fetcher)
    expect(readFileSync(join(state,'meeting-recordings',id,`${segment}.webm`),'utf8')).toBe('webm headerwebm data')
    expect((await (await f.send(base+'/status')).json() as any).state).toBe('local_verified')
    expect(meetingRecordingInstructions(state,{repoPath:input.repo,chatId:'C1',threadTs:'100.1'})).toContain(id)
    expect(meetingRecordingInstructions(state,{repoPath:input.repo,chatId:'C2',threadTs:'100.1'})).toBe('')
    expect(readdirSync(join(state,'meeting-recordings',id)).some(n=>n.includes('.part-'))).toBe(false)
  }finally{f.close();rmSync(state,{recursive:true,force:true})}
})

test('avatar capability is scoped to the joined room, issued once and never exposes the permanent key',async()=>{
 const f=fixture();try{const room=await f.create(),{base,invite,segment}=await f.prepare(room)
 const a=await f.send(base+'/avatar','POST',{segment},invite);expect(a.status).toBe(200)
 const b=await a.json() as any;expect(b.session_token).toBe('limited-session-token');expect(JSON.stringify(b)).not.toContain('fixture-simli-key')
 expect((await f.send(base+'/avatar','POST',{segment},invite)).status).toBe(200)
 expect(f.calls.filter(c=>c.url.endsWith('/compose/token'))).toHaveLength(1)
 expect((await f.send(base+'/avatar','POST',{segment},'wrong')).status).toBe(401)
 }finally{f.close()}
})
test('screen understanding requires an active room, uses image input, and throttles refreshes',async()=>{
 const f=fixture();try{const room=await f.create(),{base,invite,segment}=await f.prepare(room),body={segment,image:'data:image/jpeg;base64,YQ=='}
 expect((await f.send(base+'/screen','POST',body,invite)).status).toBe(409)
 await f.send(base+'/session','POST',{segment,mime:'video/webm',sdp:'offer',hour:20},invite)
 expect(JSON.stringify(f.calls[0].body.session.input)).toContain('こんばんは')
 const response=await f.send(base+'/screen','POST',body,invite);expect(response.status).toBe(200);expect(await response.json()).toEqual({description:'現在の共有画面の観察（参考情報）: 画面の要約'})
 expect(f.calls[1].body.input[0].content[1].type).toBe('input_image')
 expect((await f.send(base+'/screen','POST',body,invite)).status).toBe(429)
 }finally{f.close()}
})
test('temporary ICE failure retries without minting another avatar token',async()=>{
 const f=fixture();try{let ice=0,tokens=0
 const service=createMeetingService({...f.options,fetcher:(async(url)=>{
 if(String(url).endsWith('/compose/token')){tokens++;return Response.json({session_token:'retry-token'})}
 if(++ice===1)return new Response('',{status:503})
 return Response.json([{urls:'stun:fixture.invalid'}])
 }) as typeof fetch})
 const room=await f.create(),{base,invite,segment}=await f.prepare(room)
 const run=()=>service.fetch(new Request(origin+base+'/avatar',{method:'POST',headers:{authorization:`Bearer ${invite}`,origin,'x-meeting-client':client,'content-type':'application/json'},body:JSON.stringify({segment})}))
 expect((await run()).status).toBe(502);expect((await run()).status).toBe(200);expect(tokens).toBe(1);expect(ice).toBe(2)
 service.db.close()
 }finally{f.close()}
})
test('definitive Live rejection permits retry but an uncertain POST is not automatically duplicated',async()=>{
 const f=fixture();try{let calls=0
 const service=createMeetingService({...f.options,fetcher:(async()=>{calls++;return new Response('',{status:calls===1?429:503})}) as typeof fetch})
 const room=await f.create(),{base,invite,segment}=await f.prepare(room)
 const run=()=>service.fetch(new Request(origin+base+'/session',{method:'POST',headers:{authorization:`Bearer ${invite}`,origin,'x-meeting-client':client,'content-type':'application/json'},body:JSON.stringify({segment,mime:'video/webm',sdp:'offer'})}))
 expect((await run()).status).toBe(502);expect((await (await f.send(base+'/status')).json() as any).retryable).toBe(true)
 expect((await run()).status).toBe(502);expect((await run()).status).toBe(409);expect(calls).toBe(2)
 service.db.close()
 }finally{f.close()}
})

test('Live rejection renews a consumed avatar token on the next attempt',async()=>{
 const f=fixture();try{let tokens=0
 const service=createMeetingService({...f.options,fetcher:(async(url)=>String(url).endsWith('/compose/token')?Response.json({session_token:`token-${++tokens}`}):String(url).endsWith('/compose/ice')?Response.json([{urls:'stun:fixture.invalid'}]):new Response('',{status:429})) as typeof fetch})
 const room=await f.create(),{base,invite,segment}=await f.prepare(room)
 const run=(action:string,body:unknown)=>service.fetch(new Request(origin+base+'/'+action,{method:'POST',headers:{authorization:`Bearer ${invite}`,origin,'x-meeting-client':client,'content-type':'application/json'},body:JSON.stringify(body)}))
 expect((await run('avatar',{segment})).status).toBe(200)
 expect((await run('session',{segment,mime:'video/webm',sdp:'offer'})).status).toBe(502)
 expect((await run('avatar',{segment})).status).toBe(200);expect(tokens).toBe(2)
 service.db.close()
 }finally{f.close()}
})
test('hangup preserves late recording uploads and empty finalization cannot discard chunks',async()=>{
 const f=fixture();try{const room=await f.create(),{base,invite,segment}=await f.prepare(room)
 await f.send(base+'/session','POST',{segment,mime:'video/webm',sdp:'offer'},invite)
 expect((await f.send(base+'/hangup','POST',{segment},'wrong')).status).toBe(401)
 expect((await f.send(base+'/hangup','POST',{segment},invite)).status).toBe(200)
 expect(f.calls.some(c=>c.url.endsWith('/live_fixture/hangup'))).toBe(true)
 expect((await f.send(`${base}/chunks/${segment}/0`,'PUT','tail',invite,{'x-content-sha256':sha('tail')})).status).toBe(200)
 expect((await f.send(base+'/finish','POST',{segment,count:0},invite)).status).toBe(409)
 expect((await f.send(base+'/finish','POST',{segment,count:1},invite)).status).toBe(200)
 }finally{f.close()}
})
test('zero-chunk failed calls finalize and sync without creating an empty video',async()=>{
 const f=fixture(),state=mkdtempSync(join(tmpdir(),'meeting-empty-test-'));try{
 writeFileSync(join(state,'meeting.json'),JSON.stringify({origin,adminToken:admin}),{mode:0o600})
 const fetcher=(async(url,init)=>f.service.fetch(new Request(String(url),init))) as typeof fetch
 const url=await createMeetingInvitation({state,repo:'/fixture',chat:'C1',thread:'1',key:'empty',summary:async()=>'summary',history:async()=>'history'},fetcher)
 const id=new URL(url).pathname.split('/').at(-1)!,{base,invite,segment}=await f.prepare({id,url})
 f.service.db.run("UPDATE segments SET state='uncertain' WHERE id=?",[segment])
 expect((await f.send(base+'/finish','POST',{segment,count:0},invite)).status).toBe(200)
 await syncMeetingRecordings(state,fetcher)
 expect(readdirSync(join(state,'meeting-recordings',id)).some(n=>n.endsWith('.webm'))).toBe(false)
 expect((await (await f.send(base+'/status')).json() as any).state).toBe('local_verified')
 }finally{f.close();rmSync(state,{recursive:true,force:true})}
})

test('opening an invite does not claim it; preparing atomically admits just one browser',async()=>{
 const f=fixture();try{
  const room=await f.create(),base=`/api/rooms/${room.id}`,invite=new URL(room.url).hash.slice(1)
  const mobile={'x-meeting-client':'c'.repeat(64)},desktop={'x-meeting-client':'d'.repeat(64)}
  expect((await f.send(base+'/join','POST',{},invite,mobile)).status).toBe(200)
  expect((await f.send(base+'/status','GET',undefined,invite,mobile)).status).toBe(200)
  expect((await f.send(base+'/avatar','POST',{segment:crypto.randomUUID()},invite,mobile)).status).toBe(409)
  expect((await f.send(base+'/prepare','POST',{segment:'invalid',mime:'video/webm'},invite,mobile)).status).toBe(400)
  expect((await f.send(base+'/join','POST',{},invite,desktop)).status).toBe(200)
  const body={segment:crypto.randomUUID(),mime:'video/webm'}
  const results=await Promise.all([f.send(base+'/prepare','POST',body,invite,desktop),f.send(base+'/prepare','POST',{...body,segment:crypto.randomUUID()},invite,mobile)])
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);expect(f.calls).toHaveLength(0)
  const winner=results[0]!.status===200?desktop:mobile,loser=winner===desktop?mobile:desktop
  expect((await f.send(base+'/join','POST',{},invite,winner)).status).toBe(200)
  expect((await f.send(base+'/join','POST',{},invite,loser)).status).toBe(409)
 }finally{f.close()}
})
