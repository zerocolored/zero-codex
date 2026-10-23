import { persistRecordingChunk, recoverRecordingCount, acquireRecordingTab } from './recording-store.js'
const $ = id => document.getElementById(id)
const room = location.pathname.split('/')[2]
const token = location.hash.slice(1)
// Invitation stays in the fragment: neither HTTP logs nor referrers receive it.
const key = `meeting:${room}`
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2,'0')).join('')
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n => n.toString(16).padStart(2,'0')).join('')
let db, meta, mic, display, pc, events, context, mix, analyser, recorder, recordedStream, paintTimer, uploadTimer, statusTimer
let sessionClosed = false, sessionReady = false
let releaseTab
let recording = false, ending = false, uploading = false, storageQueue = Promise.resolve(), storageError = false
let seq = 0, volatile = [], motion = !matchMedia('(prefers-reduced-motion: reduce)').matches, smoothed = 0
const canvas = $('scene'), ctx = canvas.getContext('2d'), samples = new Float32Array(256)
const state = text => { $('status').textContent = text }
const transaction = (store, mode, action) => new Promise((resolve,reject) => {
  const tx = db.transaction(store,mode), request = action(tx.objectStore(store))
  tx.oncomplete = () => resolve(request?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
})
const saveMeta = () => transaction('meta','readwrite',s=>s.put(meta,key))
const chunks = async () => (await transaction('chunks','readonly',s=>s.getAll())).filter(c=>c.room===room).sort((a,b)=>a.seq-b.seq)
async function api(action, options={}) {
  const response = await fetch(`/api/rooms/${room}/${action}`,{...options,signal:AbortSignal.timeout(40000),headers:{authorization:`Bearer ${token}`,'x-meeting-client':meta.client,...options.headers}})
  const body = await response.json()
  if(!response.ok) throw new Error(body.error || `接続エラー（${response.status}）`)
  return body
}
const post = (action,body) => api(action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
function paint() {
  ctx.fillStyle='#101627';ctx.fillRect(0,0,1280,720)
  let amplitude=0
  if(analyser){analyser.getFloatTimeDomainData(samples);amplitude=Math.sqrt(samples.reduce((n,v)=>n+v*v,0)/samples.length)}
  smoothed=smoothed*.82+Math.min(1,amplitude*7)*.18
  const level=motion?smoothed:0, sharing=display?.getVideoTracks().some(t=>t.readyState==='live')
  if(sharing && $('screen').readyState>=2){
    const v=$('screen'),scale=Math.min(1200/v.videoWidth,620/v.videoHeight)
    ctx.drawImage(v,(1280-v.videoWidth*scale)/2,(680-v.videoHeight*scale)/2,v.videoWidth*scale,v.videoHeight*scale)
    ctx.fillStyle='#101627dd';ctx.beginPath();ctx.roundRect(1040,465,205,205,24);ctx.fill()
  }
  ctx.save();ctx.translate(sharing?1140:640,sharing?550:335);const scale=sharing?.30:1;ctx.scale(scale,scale)
  for(let i=3;i>=0;i--){const r=160+i*48+level*(75+i*20);const gradient=ctx.createRadialGradient(0,5,40,0,5,r)
    gradient.addColorStop(0,`rgba(131,159,255,${.06+level*.07})`);gradient.addColorStop(1,'rgba(131,159,255,0)');ctx.fillStyle=gradient;ctx.beginPath();ctx.arc(0,5,r,0,Math.PI*2);ctx.fill()}
  ctx.shadowColor='#9baeff';ctx.shadowBlur=36+level*30;ctx.filter=`blur(${10+level*5}px)`
  const glow=ctx.createLinearGradient(-80,-130,80,150);glow.addColorStop(0,'#d5dfff');glow.addColorStop(.5,'#a4b8f5');glow.addColorStop(1,'#435c9b');ctx.fillStyle=glow
  ctx.beginPath();ctx.ellipse(0,-76,51+level*3,61+level*2,0,0,Math.PI*2);ctx.fill()
  ctx.beginPath();ctx.moveTo(-104,132);ctx.bezierCurveTo(-105,15,-48,4,0,4);ctx.bezierCurveTo(48,4,105,15,104,132);ctx.quadraticCurveTo(0,171,-104,132);ctx.fill();ctx.restore()
  ctx.fillStyle='#c3cee8';ctx.font='19px sans-serif';ctx.fillText(meta?.project || 'ヒアリング',30,40)
  if(recording){ctx.fillStyle='#f48f9e';ctx.beginPath();ctx.arc(33,680,5,0,Math.PI*2);ctx.fill();ctx.fillStyle='#d4def3';ctx.font='15px sans-serif';ctx.fillText(`REC  ${new Date(Date.now()-(meta.startedAt||Date.now())).toISOString().slice(11,19)}`,48,686)}
}
$('motion').onclick=()=>{motion=!motion;$('motion').textContent=motion?'動きを止める':'動きを再開';paint()}
$('motion').textContent=motion?'動きを止める':'動きを再開'
paintTimer=setInterval(paint,1000/30);paint()
async function flush() {
  if(!db)return
  while(uploading)await new Promise(resolve=>setTimeout(resolve,50))
  uploading=true
  try {
    await storageQueue
    for(const chunk of await chunks()) {
      if(chunk.uploaded)continue
      const bytes=await chunk.blob.arrayBuffer(), digest=await hash(bytes)
      const ack=await api(`chunks/${meta.segment}/${chunk.seq}`,{method:'PUT',headers:{'content-type':'application/octet-stream','x-content-sha256':digest},body:bytes})
      if(ack.hash!==digest)throw new Error('録画の保存確認に失敗しました')
      chunk.uploaded=true;await transaction('chunks','readwrite',s=>s.put(chunk,`${room}:${chunk.seq}`))
    }
    $('saveState').textContent='録画をサーバーに保存中';$('retry').hidden=true
  }catch(error){state(error.message);$('retry').hidden=false;$('saveState').textContent='未送信の録画はこのブラウザに保持しています'}
  finally{uploading=false}
}
function releaseMedia(){
  clearInterval(uploadTimer);pc?.close();mic?.getTracks().forEach(t=>t.stop());display?.getTracks().forEach(t=>t.stop());recordedStream?.getTracks().forEach(t=>t.stop());context?.close().catch(()=>{});$('remoteAudio').srcObject=null;recording=false
  $('mute').disabled=$('share').disabled=$('end').disabled=true
}
async function finish() {
  if(ending)return;ending=true;$('end').disabled=true
  try{
    if(sessionReady&&!sessionClosed&&events?.readyState==='open'){
      state('会話を終了しています');events.send(JSON.stringify({type:'session.close'}))
      await new Promise(resolve=>{const timeout=setTimeout(done,15000);function done(){clearTimeout(timeout);events.removeEventListener('message',listen);resolve()}function listen(event){try{if(JSON.parse(event.data).type==='session.closed')done()}catch{}}events.addEventListener('message',listen)})
    }
    if(recorder?.state==='recording') await new Promise(resolve=>{recorder.addEventListener('stop',resolve,{once:true});recorder.stop()})
    releaseMedia();await storageQueue
    meta.stopped=true;meta.count=seq;await saveMeta();$('download').hidden=false
    state('録画を保存しています。このページを閉じずにお待ちください');await flush()
    const saved=await chunks()
    if(storageError||saved.length!==meta.count||saved.some(c=>!c.uploaded))throw new Error('未保存の録画があります。保存を再試行するか、録画をダウンロードしてください')
    await post('finish',{segment:meta.segment,count:meta.count});meta.finished=true;await saveMeta()
    state('会議を終了しました');$('recordState').textContent='録画保存済み';$('recordState').classList.remove('recording');$('retry').hidden=true
    $('saveState').textContent='ローカル端末への回収を待っています'
    statusTimer=setInterval(async()=>{try{const result=await api('status');if(result.state==='local_verified'){$('saveState').textContent='プロジェクトの端末に録画を保存しました';clearInterval(statusTimer)}}catch{}},5000)
  }catch(error){state(error.message);$('retry').hidden=false}
  finally{ending=false}
}
$('retry').onclick=()=>meta.stopped?finish():flush()
$('end').onclick=finish
$('mute').onclick=()=>{const muted=mic.getAudioTracks()[0].enabled;mic.getAudioTracks().forEach(t=>t.enabled=!muted);$('mute').setAttribute('aria-pressed',String(muted));$('mute').textContent=muted?'ミュート解除':'ミュート'}
$('share').onclick=async()=>{
  if(display?.getVideoTracks().some(t=>t.readyState==='live')){display.getTracks().forEach(t=>t.stop());display=null;$('share').textContent='画面共有';return}
  try{display=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});$('screen').srcObject=display;await $('screen').play();$('share').textContent='共有を停止';display.getVideoTracks()[0].onended=()=>{$('share').textContent='画面共有'}}
  catch{state('画面共有は開始されませんでした。会話は続けられます')}
}
$('download').onclick=async()=>{
  const stored=await chunks(), bySeq=new Map(stored.map(c=>[c.seq,c.blob]));for(const c of volatile)bySeq.set(c.seq,c.blob)
  const blob=new Blob([...bySeq.entries()].sort((a,b)=>a[0]-b[0]).map(c=>c[1]),{type:meta.mime})
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${room}-${meta.segment}.${meta.mime.includes('mp4')?'mp4':'webm'}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000)
}
async function iceComplete(connection){
  if(connection.iceGatheringState==='complete')return
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{connection.removeEventListener('icegatheringstatechange',listen);reject(new Error('音声接続の準備がタイムアウトしました'))},15000);function listen(){if(connection.iceGatheringState==='complete'){clearTimeout(timer);connection.removeEventListener('icegatheringstatechange',listen);resolve()}}connection.addEventListener('icegatheringstatechange',listen)})
}
$('join').onclick=async()=>{
  $('join').disabled=true
  try{
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder||!canvas.captureStream)throw new Error('録画対応のChromeまたはEdgeで開いてください')
    const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'].find(t=>MediaRecorder.isTypeSupported(t))
    if(!mime)throw new Error('このブラウザは録画形式に対応していません')
    mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false})
    context=new AudioContext();await context.resume();mix=context.createMediaStreamDestination();analyser=context.createAnalyser();analyser.fftSize=256
    context.createMediaStreamSource(mic).connect(mix)
    const joined=await post('join',{});meta.project=joined.project;meta.segment=meta.segment||crypto.randomUUID();meta.mime=mime;meta.startedAt=Date.now();meta.stopped=false;meta.count=0;seq=0;await saveMeta();$('project').textContent=joined.project
    await post('prepare',{segment:meta.segment,mime})
    pc=new RTCPeerConnection();mic.getTracks().forEach(t=>pc.addTrack(t,mic));events=pc.createDataChannel('oai-events')
    events.onmessage=event=>{try{const data=JSON.parse(event.data);if(data.type==='session.started'){sessionReady=true;state('お話しください')}if(data.type==='session.closed'){sessionClosed=true;if(!ending)void finish()}if(data.type==='error'){state('音声サービスからエラーが返されました。録画を保存します');if(!ending)void finish()}}catch{}}
    pc.ontrack=event=>{const stream=event.streams[0]||new MediaStream([event.track]);$('remoteAudio').srcObject=stream;$('remoteAudio').play().catch(()=>{state('音声の再生を許可してください');$('remoteAudio').controls=true});const source=context.createMediaStreamSource(stream);source.connect(mix);source.connect(analyser)}
    recordedStream=new MediaStream([...canvas.captureStream(30).getVideoTracks(),...mix.stream.getAudioTracks()])
    recorder=new MediaRecorder(recordedStream,{mimeType:mime,videoBitsPerSecond:1400000,audioBitsPerSecond:96000})
    recorder.ondataavailable=event=>{
      if(!event.data.size)return
      // Split large browser blobs without changing their byte order or container.
      for(let offset=0;offset<event.data.size;offset+=4*1024*1024){const chunk={room,seq:seq++,blob:event.data.slice(offset,offset+4*1024*1024),uploaded:false};volatile.push(chunk)
        storageQueue=storageQueue.then(async()=>{meta.count=await persistRecordingChunk(db,key,meta,chunk);volatile=volatile.filter(c=>c!==chunk)}).catch(()=>{storageError=true;state('ブラウザへの録画保存に失敗しました。会議を終了して録画をダウンロードしてください');$('download').hidden=false;void finish()})}
    }
    recorder.onerror=()=>{state('録画が停止しました。取得済みの録画を保存します');void finish()}
    // Recording begins before the session can produce its first audio.
    recorder.start(3000);recording=true;uploadTimer=setInterval(flush,4000)
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);await iceComplete(pc)
    state('音声に接続しています');const answer=await post('session',{segment:meta.segment,mime,sdp:pc.localDescription.sdp});await pc.setRemoteDescription({type:'answer',sdp:answer.sdp})
    pc.onconnectionstatechange=()=>{if(pc.connectionState==='connected')state('お話しください');if(['failed','disconnected'].includes(pc.connectionState)&&!ending){state('音声接続が切れました。録画を保存します');void finish()}}
    $('entry').hidden=true;$('mute').disabled=$('end').disabled=false;$('share').disabled=!navigator.mediaDevices.getDisplayMedia;$('recordState').textContent='● 録画中';$('recordState').classList.add('recording');if(!sessionReady)state('音声に接続しています')
    setTimeout(()=>{if(recording)void finish()},2*60*60*1000)
  }catch(error){state(error.message);if(recorder?.state==='recording'){await finish()}else{releaseMedia();$('join').disabled=false}}
}
window.addEventListener('beforeunload',event=>{if(recording||(!meta?.finished&&meta?.segment)){event.preventDefault();event.returnValue=''}})
window.addEventListener('pagehide',()=>{releaseMedia();releaseTab?.()})
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload()})
async function init(){
  if(!/^[a-f0-9-]{36}$/.test(room||'')||!/^[a-f0-9]{64}$/.test(token)){state('Slackで受け取った招待リンクから開いてください');$('join').disabled=true;return}
  releaseTab=await acquireRecordingTab(navigator.locks,room)
  if(!releaseTab){state('別のタブで会議を開いています。そちらを閉じてから再読み込みしてください');$('join').disabled=true;return}
  db=await new Promise((resolve,reject)=>{const request=indexedDB.open('zero-hearing',1);request.onupgradeneeded=()=>{request.result.createObjectStore('meta');request.result.createObjectStore('chunks')};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
  meta=await transaction('meta','readonly',s=>s.get(key))||{client:random()};await saveMeta()
  if(meta.segment){$('entry').hidden=true;$('download').hidden=false;$('project').textContent=meta.project||'ヒアリング';try{seq=recoverRecordingCount(await chunks());meta.count=seq;await saveMeta()}catch(error){state(error.message);return}if(meta.finished){state('会議は終了しています');$('recordState').textContent='録画保存済み'}else{meta.stopped=true;$('retry').hidden=false;state('前回の録画が残っています。保存を再試行してください')}}
  else $('join').disabled=false
}
init().catch(error=>{state(error.message||'録画の保存領域を開けません。ブラウザのストレージを許可してください');$('join').disabled=true})
