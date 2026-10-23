import {test,expect} from 'bun:test'
import {recoverRecordingCount,acquireRecordingTab,persistRecordingChunk} from './public/recording-store.js'

test('recovery derives count from persisted contiguous data, rejecting gaps and duplicates',()=>{
  expect(recoverRecordingCount([{seq:1},{seq:0}])).toBe(2)
  expect(recoverRecordingCount([])).toBe(0)
  expect(()=>recoverRecordingCount([{seq:0},{seq:2}])).toThrow('欠落')
  expect(()=>recoverRecordingCount([{seq:0},{seq:0}])).toThrow('欠落')
})
test('a held browser lock rejects a second tab; release allows crash/reload recovery',async()=>{
  let held=false
  const locks={request:async(_name:unknown,_options:unknown,callback:any)=>{if(held)return callback(null);held=true;try{return await callback({})}finally{held=false}}}
  const release=await acquireRecordingTab(locks,'fixture') as ()=>void
  expect(await acquireRecordingTab(locks,'fixture')).toBeNull()
  release();await new Promise(resolve=>setTimeout(resolve,0))
  const next=await acquireRecordingTab(locks,'fixture') as ()=>void;expect(typeof next).toBe('function');next()
})
test('chunk and exact chunk watermark share one transaction, not a future queued seq',async()=>{
  const writes:any[]=[];let tx:any
  const db={transaction:(stores:unknown,mode:unknown)=>{expect(stores).toEqual(['chunks','meta']);expect(mode).toBe('readwrite');return tx={objectStore:(name:string)=>({put:(value:unknown,key:string)=>writes.push({name,value,key})})}}}
  const saved=persistRecordingChunk(db,'room',{count:99},{room:'r',seq:0,blob:'fixture'})
  expect(writes[1].value.count).toBe(1);tx.oncomplete();expect(await saved).toBe(1)
  const failed=persistRecordingChunk(db,'room',{count:1},{room:'r',seq:1,blob:'fixture'});tx.onabort();await expect(failed).rejects.toThrow()
})
