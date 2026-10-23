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
  const options={directory:root,origin,adminToken:admin,apiKey:'fixture-key',fetcher:(async(url,init)=>{
    calls.push({url,body:init?.body?JSON.parse(String(init.body)):null})
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
    expect(f.calls[0].body.session.instructions).toContain('project summary');expect(f.calls[0].body.session.instructions).toContain('thread history')
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
