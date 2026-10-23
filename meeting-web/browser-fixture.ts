/** Local-only synthetic media verification. Never deploy this entrypoint. */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMeetingService } from './service.ts'
import { syncMeetingRecordings } from '../zerokun/meeting-client.ts'

const directory=mkdtempSync(join(tmpdir(),'meeting-browser-fixture-')),port=4319,origin=`http://127.0.0.1:${port}`,token='fixture-admin-'.repeat(5)
const service=createMeetingService({directory,origin,adminToken:token,apiKey:'fixture-only',allowLocalhost:true,
  fetcher:(async()=>Response.json({session:{id:'live_synthetic'},transport:{sdp:'synthetic'}})) as unknown as typeof fetch})
const created=await (await service.fetch(new Request(origin+'/api/rooms',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requestId:'browser-fixture',project:'サンプルプロジェクト',summary:'Synthetic interview test',history:'Synthetic thread only'})}))).json() as any
writeFileSync(join(directory,'meeting.json'),JSON.stringify({origin:'https://fixture.example',adminToken:token}),{mode:0o600})
mkdirSync(join(directory,'meetings'),{mode:0o700})
writeFileSync(join(directory,'meetings','a'.repeat(64)+'.json'),JSON.stringify({...created,repo:'/synthetic',thread:'1.0',chat:'CTEST',requestId:'browser-fixture',synced:false}),{mode:0o600})
const fixtureScript=String.raw`
const nativeFetch=window.fetch.bind(window),NativePeer=window.RTCPeerConnection;
let remotePeer,remoteContext,micContext;
function tone(frequency){const context=new AudioContext(),osc=context.createOscillator(),gain=context.createGain(),out=context.createMediaStreamDestination();osc.frequency.value=frequency;gain.gain.value=.14;osc.connect(gain).connect(out);osc.start();context.resume();return {context,stream:out.stream}}
navigator.mediaDevices.getUserMedia=async()=>{const t=tone(440);micContext=t.context;return t.stream};
navigator.mediaDevices.getDisplayMedia=async()=>{const c=document.createElement('canvas');c.width=1280;c.height=720;const x=c.getContext('2d');x.fillStyle='#156644';x.fillRect(0,0,1280,720);x.fillStyle='white';x.font='70px sans-serif';x.fillText('共有画面テスト',120,360);return c.captureStream(15)};
window.fetch=async(input,init)=>{
 const response=await nativeFetch(input,init);
 if(String(input).endsWith('/session')&&response.ok){
   const offer=JSON.parse(init.body);remotePeer=new NativePeer();const t=tone(660);remoteContext=t.context;
   remotePeer.ondatachannel=e=>{const channel=e.channel;channel.onopen=()=>channel.send(JSON.stringify({type:'session.started'}));channel.onmessage=event=>{if(JSON.parse(event.data).type==='session.close')channel.send(JSON.stringify({type:'session.closed'}))}};
   t.stream.getTracks().forEach(track=>remotePeer.addTrack(track,t.stream));await remotePeer.setRemoteDescription({type:'offer',sdp:offer.sdp});await remotePeer.setLocalDescription(await remotePeer.createAnswer());
   if(remotePeer.iceGatheringState!=='complete')await new Promise(resolve=>remotePeer.addEventListener('icegatheringstatechange',()=>{if(remotePeer.iceGatheringState==='complete')resolve()}));
   return Response.json({sdp:remotePeer.localDescription.sdp});
 }
 return response;
};
const test=document.createElement('button');test.textContent='合成録画を検証';test.id='verifyFixture';document.querySelector('main').append(test);
test.onclick=async()=>{
 const status=document.createElement('p');status.id='fixtureResult';document.querySelector('main').append(status);
 try{
  const sync=await nativeFetch('/__fixture/sync',{method:'POST'});if(!sync.ok)throw Error('local sync failed');
  const video=document.createElement('video');video.src='/__fixture/recording';video.controls=true;document.querySelector('main').append(video);video.width=640;
  const ctx=new AudioContext();await ctx.resume();const source=ctx.createMediaElementSource(video),a=ctx.createAnalyser();a.fftSize=8192;source.connect(a);a.connect(ctx.destination);await video.play();
  await new Promise(resolve=>setTimeout(resolve,4000));const data=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(data);
  const peak=f=>Math.max(...data.slice(Math.round(f/ctx.sampleRate*a.fftSize)-2,Math.round(f/ctx.sampleRate*a.fftSize)+3));
  const output=document.createElement('canvas');output.width=video.videoWidth;output.height=video.videoHeight;const gx=output.getContext('2d');gx.drawImage(video,0,0);const px=gx.getImageData(640,200,1,1).data;
  const result={width:video.videoWidth,height:video.videoHeight,mic440:peak(440),assistant660:peak(660),screenGreen:px[1]>px[0]*1.5&&px[1]>px[2],localVerified:true};
  status.textContent=JSON.stringify(result);video.pause();await ctx.close();
 }catch(error){status.textContent='FAIL: '+error.message}
};`
const server=Bun.serve({hostname:'127.0.0.1',port,async fetch(request){
  const url=new URL(request.url)
  if(url.pathname==='/__fixture/bootstrap')return Response.redirect(created.url)
  if(url.pathname==='/__fixture/store-tests')return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>録画復旧テスト</title><p id="result">検証中</p><script type="module">
    import {persistRecordingChunk,recoverRecordingCount} from '/recording-store.js';
    const request=indexedDB.open('meeting-atomic-fixture-'+crypto.randomUUID(),1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('meta');request.result.createObjectStore('chunks')};
    request.onsuccess=async()=>{try{const db=request.result;
      await persistRecordingChunk(db,'r',{count:0},{room:'r',seq:0,blob:new Blob(['first'])});
      const aborting={transaction(stores,mode){const tx=db.transaction(stores,mode);queueMicrotask(()=>tx.abort());return tx}};
      let aborted=false;try{await persistRecordingChunk(aborting,'r',{count:1},{room:'r',seq:1,blob:new Blob(['second'])})}catch{aborted=true}
      const read=(store,key)=>new Promise(resolve=>{const q=db.transaction(store).objectStore(store)[key?'get':'getAll'](key);q.onsuccess=()=>resolve(q.result)});
      const meta=await read('meta','r'),chunks=await read('chunks');
      if(!aborted||meta.count!==1||chunks.length!==1||recoverRecordingCount(chunks)!==1)throw Error('atomicity mismatch');
      document.getElementById('result').textContent='PASS: IndexedDB中断時にチャンクと件数が同時にロールバック。保存済み連番から復旧。';db.close();indexedDB.deleteDatabase(db.name);
    }catch(error){document.getElementById('result').textContent='FAIL: '+error.message}};
    </script></html>`,{headers:{'content-type':'text/html'}})
  if(url.pathname==='/fixture.js')return new Response(fixtureScript,{headers:{'content-type':'text/javascript'}})
  if(url.pathname==='/__fixture/sync'&&request.method==='POST'){
    await syncMeetingRecordings(directory,(async(u,init)=>service.fetch(new Request(String(u).replace('https://fixture.example',origin),init))) as typeof fetch)
    return Response.json({ok:true})
  }
  if(url.pathname==='/__fixture/recording'){
    const manifest=JSON.parse(readFileSync(join(directory,'meeting-recordings',created.id,'manifest.json'),'utf8'))
    const segment=manifest.segments[0],extension=segment.mime.startsWith('video/mp4')?'mp4':'webm'
    return new Response(Bun.file(join(directory,'meeting-recordings',created.id,segment.id+'.'+extension)))
  }
  const response=await service.fetch(request)
  if(url.pathname.startsWith('/room/'))return new Response((await response.text()).replace('<script type="module" src="/app.js">','<script src="/fixture.js"></script><script type="module" src="/app.js">'),{headers:response.headers})
  return response
}})
console.log(JSON.stringify({origin,entry:origin+'/__fixture/bootstrap',directory}))
process.on('SIGTERM',()=>{server.stop(true);service.db.close();process.exit(0)})
