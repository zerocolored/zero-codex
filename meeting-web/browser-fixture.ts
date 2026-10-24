/** Local-only synthetic media verification. Never deploy this entrypoint. */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMeetingService } from './service.ts'
import { syncMeetingRecordings } from '../zerokun/meeting-client.ts'

const directory=mkdtempSync(join(tmpdir(),'meeting-browser-fixture-')),port=4319,origin=`http://127.0.0.1:${port}`,token='fixture-admin-'.repeat(5)
let liveAttempts=0
const service=createMeetingService({directory,origin,adminToken:token,apiKey:'fixture-only',simliApiKey:'fixture-only',faceId:'fixture-face',allowLocalhost:true,
  fetcher:(async(url: RequestInfo | URL)=>{if(String(url).endsWith('/compose/token')&&process.env.MEETING_FIXTURE_AVATAR_FAIL==='1')return new Response('',{status:503});if(String(url).endsWith('/live/sessions')&&process.env.MEETING_FIXTURE_REJECT_FIRST==='1'&&liveAttempts++===0)return new Response('',{status:429});return String(url).endsWith('/compose/token')?Response.json({session_token:'fixture'}):String(url).endsWith('/compose/ice')?Response.json([{urls:'stun:fixture.invalid'}]):String(url).endsWith('/responses')?Response.json({output:[{content:[{type:'output_text',text:'緑の共有画面テスト'}]}]}):Response.json({session:{id:'live_synthetic'},transport:{sdp:'synthetic'}})}) as unknown as typeof fetch})
const created=await (await service.fetch(new Request(origin+'/api/rooms',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requestId:'browser-fixture',project:'サンプルプロジェクト',summary:'Synthetic interview test',history:'Synthetic thread only'})}))).json() as any
writeFileSync(join(directory,'meeting.json'),JSON.stringify({origin:'https://fixture.example',adminToken:token}),{mode:0o600})
mkdirSync(join(directory,'meetings'),{mode:0o700})
writeFileSync(join(directory,'meetings','a'.repeat(64)+'.json'),JSON.stringify({...created,repo:'/synthetic',thread:'1.0',chat:'CTEST',requestId:'browser-fixture',synced:false}),{mode:0o600})
const fixtureScript=String.raw`
const nativeFetch=window.fetch.bind(window),NativePeer=window.RTCPeerConnection;
let remotePeer,remoteContext,micContext,sessionAt,screenAt,endedAt;
document.querySelector("#join").addEventListener("click",()=>{void micContext?.resume()});
document.querySelector("#end").addEventListener("click",()=>{endedAt=Date.now()});
function tone(frequency){const context=new AudioContext(),osc=context.createOscillator(),gain=context.createGain(),out=context.createMediaStreamDestination();osc.frequency.value=frequency;gain.gain.value=.14;osc.connect(gain).connect(out);osc.start();context.resume();return {context,stream:out.stream}}
navigator.mediaDevices.getUserMedia=async()=>{if(${process.env.MEETING_FIXTURE_MIC_WAIT==='1'})await new Promise(()=>{});const t=tone(440);micContext=t.context;return t.stream};
navigator.mediaDevices.getDisplayMedia=async()=>{screenAt=Date.now();const c=document.createElement('canvas');c.width=1280;c.height=720;const x=c.getContext('2d');x.fillStyle='#156644';x.fillRect(0,0,1280,720);x.fillStyle='white';x.font='70px sans-serif';x.fillText('共有画面テスト',120,360);return c.captureStream(15)};
window.fetch=async(input,init)=>{
 const response=await nativeFetch(input,init);
 if(String(input).endsWith('/session')&&response.ok){
   const offer=JSON.parse(init.body);remotePeer=new NativePeer();const t=tone(660);remoteContext=t.context;
   remotePeer.ondatachannel=e=>{const channel=e.channel;channel.onopen=()=>channel.send(JSON.stringify({type:'session.started'}));channel.onmessage=event=>{if(JSON.parse(event.data).type==='session.close')setTimeout(()=>{endedAt=Date.now();channel.send(JSON.stringify({type:'session.closed'}))},8000)}};
   t.stream.getTracks().forEach(track=>remotePeer.addTrack(track,t.stream));await remotePeer.setRemoteDescription({type:'offer',sdp:offer.sdp});await remotePeer.setLocalDescription(await remotePeer.createAnswer());
   if(remotePeer.iceGatheringState!=='complete')await new Promise(resolve=>remotePeer.addEventListener('icegatheringstatechange',()=>{if(remotePeer.iceGatheringState==='complete')resolve()}));
   sessionAt=Date.now();return Response.json({sdp:remotePeer.localDescription.sdp});
 }
 return response;
};
const test=document.createElement('button');test.textContent='合成録画を検証';test.id='verifyFixture';document.querySelector('main').append(test);
const tail=document.createElement('button');tail.textContent='録画末尾を検証';document.querySelector('main').append(tail);
async function verifyRecording(atEnd=false){
 const status=document.createElement('p');status.id='fixtureResult';document.querySelector('main').append(status);
 try{
  const sync=await nativeFetch('/__fixture/sync',{method:'POST'});if(!sync.ok)throw Error('local sync failed');
  const video=document.createElement('video');video.src='/__fixture/recording';video.controls=true;document.querySelector('main').append(video);video.width=640;
  const ctx=new AudioContext();await ctx.resume();const source=ctx.createMediaElementSource(video),a=ctx.createAnalyser();a.fftSize=8192;source.connect(a);a.connect(ctx.destination);await video.play();if(atEnd&&endedAt)video.currentTime=Math.max(0,(endedAt-sessionAt)/1000-7);else if(screenAt)video.currentTime=Math.max(0,(screenAt-sessionAt)/1000+2);
  await new Promise(resolve=>setTimeout(resolve,4000));const data=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(data);
  const peak=f=>Math.max(...data.slice(Math.round(f/ctx.sampleRate*a.fftSize)-2,Math.round(f/ctx.sampleRate*a.fftSize)+3));
  const output=document.createElement('canvas');output.width=video.videoWidth;output.height=video.videoHeight;const gx=output.getContext('2d');gx.drawImage(video,0,0);const px=gx.getImageData(640,200,1,1).data;
  const result={width:video.videoWidth,height:video.videoHeight,mic440:peak(440),assistant660:peak(660),screenGreen:px[1]>px[0]*1.5&&px[1]>px[2],localVerified:true};
  status.textContent=JSON.stringify(result);video.pause();await ctx.close();
 }catch(error){status.textContent='FAIL: '+error.message}
}
test.onclick=()=>verifyRecording();tail.onclick=()=>verifyRecording(true);`
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
  if(url.pathname==='/simli.js')return new Response(`
  export const LogLevel={ERROR:0};
  export class SimliClient{
    constructor(token,video,audio){this.video=video;this.audio=audio;this.next=0;this.count=0}
    on(name,callback){this.handlers??={};this.handlers[name]=callback}
    async start(){this.ctx=new AudioContext({sampleRate:16000});await this.ctx.resume();this.out=this.ctx.createMediaStreamDestination();this.audio.srcObject=this.out.stream;await this.audio.play();this.canvas=document.createElement('canvas');this.canvas.width=480;this.canvas.height=480;const g=this.canvas.getContext('2d');g.fillStyle='#dde8f3';g.fillRect(0,0,480,480);g.fillStyle='#27446b';g.font='30px sans-serif';g.fillText('合成アバター',140,240);this.stream=this.canvas.captureStream(15);this.video.srcObject=this.stream;await this.video.play();const fail=document.createElement('button');fail.textContent='アバター切断を再現';fail.onclick=()=>{this.handlers.error?.();this.stop()};document.querySelector('main').append(fail)}
    sendAudioData(bytes){const samples=new Int16Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/2);const b=this.ctx.createBuffer(1,samples.length,16000);b.copyToChannel(Float32Array.from(samples,x=>x/32768),0);const src=this.ctx.createBufferSource();src.buffer=b;src.connect(this.out);this.next=Math.max(this.next,this.ctx.currentTime+.03);src.start(this.next);this.next+=b.duration;this.count++;document.querySelector('canvas').dataset.pcm=JSON.stringify({count:this.count,peak:Math.max(...samples.map(x=>Math.abs(x)))})}
    async stop(){this.stream?.getTracks().forEach(t=>t.stop());await this.ctx?.close()}
  }`,{headers:{'content-type':'text/javascript'}})
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
  if(url.pathname.endsWith('/screen'))console.log('fixture screen',response.status,await response.clone().text())
  if(url.pathname.startsWith('/room/'))return new Response((await response.text()).replace('<script type="module" src="/app.js">','<script src="/fixture.js"></script><script type="module" src="/app.js">'),{headers:response.headers})
  return response
}})
console.log(JSON.stringify({origin,entry:origin+'/__fixture/bootstrap',directory}))
process.on('SIGTERM',()=>{server.stop(true);service.db.close();process.exit(0)})
