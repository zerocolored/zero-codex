import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { JobStore } from './job-runner.ts'
import { classifyFleetRequest } from './fleet-query.ts'
import { meetingHistory, createMeetingInvitation, meetingUnavailable } from './meeting-client.ts'

test('meeting classification has explicit positive and feature-development exclusions',async()=>{
  let prompt=''
  expect(await classifyFleetRequest('会議したいです','',async(p,s)=>{prompt=p;expect(JSON.stringify(s)).toContain('meeting');return '{"route":"meeting"}'})).toBe('meeting')
  expect(prompt).toContain('START a live voice conversation');expect(prompt).toContain('Requests to implement/design/fix a meeting feature')
  await expect(classifyFleetRequest('test','',async()=>'{"route":"arbitrary"}')).rejects.toThrow()
})
test('meeting route survives old schema migration and produces one reply without steering the active task',()=>{
  const root=mkdtempSync(join(tmpdir(),'meeting-routing-')),path=join(root,'db');let store=new JobStore(path)
  try{
    const input={chatId:'CTEST',threadTs:'100.1',messageId:'100.2',userId:'UTEST',repoPath:root,text:'会議したい',fileIds:[],writeEnabled:true,isInterrupt:false}
    store.enqueue({chatId:'CTEST',threadTs:'100.1',messageId:'100.1',userId:'UTEST',repoPath:root,task:'preserve work'})
    store.close();const db=new Database(path),schema=(db.query("SELECT sql FROM sqlite_master WHERE name='fleet_queries'").get() as any).sql
    db.exec(schema.replace('fleet_queries','old_routes').replace(",'meeting'",''));db.exec('DROP TABLE fleet_queries; ALTER TABLE old_routes RENAME TO fleet_queries;');db.close()
    store=new JobStore(path);store.stageInboundDelivery(input);const row=store.claimNextInboundDelivery()!
    store.stageFleetRoute(row,'meeting',null);store.completeMeetingInvitation(row,'https://meeting.example/room/fixture');store.completeMeetingInvitation(row,'duplicate')
    expect(store.list()).toHaveLength(1);expect(store.list()[0]?.task).toBe('preserve work')
    expect(store.fleetQueryRoute(row.idempotencyKey)).toBe('meeting');expect(store.stageInboundDelivery(input)).toBe(false)
    const notes=store.pendingStatusNotifications().filter(n=>n.kind==='meeting-ready');expect(notes).toHaveLength(1);expect(store.statusNotificationDeliverable(notes[0]!.id)).toBe(true)
  }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
test('thread context is chronological, includes assistant responses, excludes future messages',async()=>{
  const history=JSON.parse(await meetingHistory([{ts:'2.0',user:'BOT',text:'second'},{ts:'1.0',user:'USER',text:'first'},{ts:'4.0',text:'future'}],'BOT','3.0'))
  expect(history.map((m:any)=>m.text)).toEqual(['first','second']);expect(history[1].role).toBe('assistant')
})
test('missing meeting setup does not create a room or a work job',async()=>{
  const state=mkdtempSync(join(tmpdir(),'meeting-unconfigured-'))
  try{expect(await createMeetingInvitation({state,repo:state,chat:'C',thread:'1',key:'1',history:async()=>{throw Error('not needed')}})).toBe(meetingUnavailable)}finally{rmSync(state,{recursive:true,force:true})}
})
test('long individual messages retain their final requirements and are summarized across every fragment',async()=>{
  const text='a'.repeat(170000)+'FINAL REQUIREMENT';let observed=''
  const result=JSON.parse(await meetingHistory([{ts:'1.0',user:'USER',text}],'BOT','1.0',async prompt=>{observed+=prompt;return '{"summary":"summary"}'}))
  expect(result.summarized).toBe(true);expect(observed).toContain('FINAL REQUIREMENT');expect(result.recent[0].text).toContain('FINAL REQUIREMENT')
  const ordinary=await meetingHistory([{ts:'1.0',user:'USER',text:'x'.repeat(5000)+'TAIL'}],'BOT','1.0')
  expect(ordinary).toContain('TAIL')
})
