import { persistRecordingChunk, recoverRecordingCount, acquireRecordingTab } from './recording-store.js'
import { SimliClient, LogLevel } from './simli.js'
const $ = id => document.getElementById(id)
const room = location.pathname.split('/')[2]
const token = location.hash.slice(1)
// Invitation stays in the fragment: neither HTTP logs nor referrers receive it.
const key = `meeting:${room}`
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2,'0')).join('')
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n => n.toString(16).padStart(2,'0')).join('')
let db, meta, mic, display, pc, events, context, mix, analyser, recorder, recordedStream, paintTimer, uploadTimer, statusTimer
let mediaGeneration=0, liveSource, audioOnly=false, avatarSource, greeting, avatarClient, avatarContext, audioPump, speakerGain, disconnectTimer, durationTimer, visionTimer, visionBusy=false, lastVisionAt=0, shareGeneration=0
let sessionClosed = false, sessionReady = false, greeted = false
let starting=false, cancelled=false, resumeAudio
let releaseTab
let recording = false, ending = false, uploading = false, storageQueue = Promise.resolve(), storageError = false
let seq = 0, volatile = []
const canvas = $('scene'), ctx = canvas.getContext('2d'), samples = new Float32Array(256)
const state = text => { $('status').textContent = text; $('entryStatus').textContent = text; $('permissionHint').hidden=$('permissionHelp').hidden=text!=='マイクの許可を待っています' }
const offerRetry = () => { $('join').textContent='接続を再試行'; $('join').hidden=false; $('join').disabled=false }
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
function contain(video,x,y,w,h){
  if(video.readyState<2||!video.videoWidth)return
  const scale=Math.min(w/video.videoWidth,h/video.videoHeight)
  ctx.drawImage(video,x+(w-video.videoWidth*scale)/2,y+(h-video.videoHeight*scale)/2,video.videoWidth*scale,video.videoHeight*scale)
}
function paint(){
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1280,720)
  const sharing=display?.getVideoTracks().some(t=>t.readyState==='live')
  if(sharing){contain($('screen'),0,0,1118,720);contain($('avatar'),1130,8,142,180)}
  else contain($('avatar'),0,0,1280,700)
}
paintTimer=setInterval(paint,1000/30);paint()
async function describeScreen(){
  if(Date.now()-lastVisionAt<15000||visionBusy||!sessionReady||events?.readyState!=='open'||!display?.getVideoTracks().some(t=>t.readyState==='live'))return
  const generation=shareGeneration, frame=document.createElement('canvas'), v=$('screen')
  if(v.readyState<2)return
  frame.width=Math.min(1280,v.videoWidth);frame.height=Math.round(v.videoHeight*frame.width/v.videoWidth)
  frame.getContext('2d').drawImage(v,0,0,frame.width,frame.height)
  visionBusy=true;lastVisionAt=Date.now()
  try{const result=await post('screen',{segment:meta.segment,image:frame.toDataURL('image/jpeg',.7)})
    if(generation===shareGeneration&&$('status').textContent==='共有画面の読み取りを再試行します。音声は続けられます')state('')
    if(generation===shareGeneration&&events?.readyState==='open')events.send(JSON.stringify({type:'session.thinking.append',event_id:crypto.randomUUID(),delegation_id:null,content:result.description}))
  }catch{if(generation===shareGeneration)state('共有画面の読み取りを再試行します。音声は続けられます')}
  finally{visionBusy=false}
}
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
    $('saveState').textContent=meta.stopped?'録画をサーバーに保存中':'';$('retry').hidden=true
  }catch(error){state(error.message);$('retry').hidden=false;$('saveState').textContent='未送信の録画はこのブラウザに保持しています'}
  finally{uploading=false}
}
function releaseMedia(){
  mediaGeneration++;const oldAvatar=avatarClient;avatarClient=null;void oldAvatar?.stop().catch(()=>{});
  clearInterval(uploadTimer);clearTimeout(disconnectTimer);clearTimeout(durationTimer);clearInterval(visionTimer);shareGeneration++;audioPump?.disconnect();avatarContext?.close().catch(()=>{});pc?.close();mic?.getTracks().forEach(t=>t.stop());display?.getTracks().forEach(t=>t.stop());recordedStream?.getTracks().forEach(t=>t.stop());context?.close().catch(()=>{});$('remoteAudio').srcObject=null;liveSource=null;avatarSource=null;avatarContext=null;audioPump=null;recording=false
  $('speaker').disabled=$('mute').disabled=$('share').disabled=$('end').disabled=true
}
async function finish() {
  if(ending)return;ending=true;$('end').disabled=true
  if(!recording&&!meta?.stopped){cancelled=true;releaseMedia();resumeAudio?.();$('join').hidden=true;state('会議を終了しました');if(meta?.segment)void post('hangup',{segment:meta.segment}).catch(()=>{});ending=false;return}
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
    state('会議を終了しました');$('retry').hidden=true
    $('saveState').textContent='ローカル端末への回収を待っています'
    statusTimer=setInterval(async()=>{try{const result=await api('status');if(result.state==='local_verified'){$('saveState').textContent='プロジェクトの端末に録画を保存しました';clearInterval(statusTimer)}}catch{}},5000)
  }catch(error){state(error.message);$('retry').hidden=false}
  finally{ending=false}
}
$('retry').onclick=()=>meta.stopped?finish():flush()
$('end').onclick=finish
$('speaker').onclick=()=>{const muted=$('speaker').getAttribute('aria-pressed')!=='true';$('speaker').setAttribute('aria-pressed',String(muted));$('speaker').setAttribute('aria-label',muted?'スピーカーのミュートを解除':'ミュート');speakerGain.gain.value=muted?0:1}
$('mute').onclick=()=>{const muted=mic.getAudioTracks()[0].enabled;mic.getAudioTracks().forEach(t=>t.enabled=!muted);$('mute').setAttribute('aria-pressed',String(muted));$('mute').setAttribute('aria-label',muted?'マイクをオン':'マイクオフ')}
$('share').onclick=async()=>{
  if(display?.getVideoTracks().some(t=>t.readyState==='live')){display.getTracks().forEach(t=>t.stop());display=null;shareGeneration++;$('share').setAttribute('aria-pressed','false');$('shareLabel').textContent='画面共有';return}
  try{display=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});$('screen').srcObject=display;await $('screen').play();$('shareLabel').textContent='共有を停止';$('share').setAttribute('aria-pressed','true');shareGeneration++;void describeScreen();display.getVideoTracks()[0].onended=()=>{shareGeneration++;$('share').setAttribute('aria-pressed','false');$('shareLabel').textContent='画面共有';if(events?.readyState==='open')events.send(JSON.stringify({type:'session.thinking.append',delegation_id:null,content:'画面共有は終了しました。以前の画面を現在の画面として扱わないでください。'}))}}
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
async function startMeeting(){
  if(starting||cancelled)return;starting=true
  $('join').hidden=true;$('end').disabled=false
  const generation=++mediaGeneration;sessionClosed=false;sessionReady=false;greeted=false;audioOnly=false
  const check=()=>{if(generation!==mediaGeneration||cancelled)throw new DOMException('接続を中止しました','AbortError')}
  const step=async promise=>{const result=await promise;check();return result}
  try{
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder||!canvas.captureStream)throw new Error('録画対応のChromeまたはEdgeで開いてください')
    const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(t=>MediaRecorder.isTypeSupported(t))
    if(!mime)throw new Error('このブラウザは録画形式に対応していません')
    const joined=await step(post('join',{}));meta.project=joined.project
    state('マイクの許可を待っています')
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false})
    if(generation!==mediaGeneration||cancelled){stream.getTracks().forEach(t=>t.stop());check()}
    mic=stream
    context=new AudioContext();avatarContext=new AudioContext({sampleRate:16000})
    await step(new Promise(resolve=>{
      const ready=()=>{if(cancelled||(context.state==='running'&&avatarContext?.state==='running')){context.removeEventListener('statechange',ready);avatarContext?.removeEventListener('statechange',ready);resumeAudio=null;$('join').hidden=true;resolve()}}
      resumeAudio=()=>{void context.resume().catch(()=>{});void avatarContext?.resume().catch(()=>{});ready()}
      context.addEventListener('statechange',ready);avatarContext.addEventListener('statechange',ready)
      state('音声を準備しています');$('join').textContent='音声を開始';$('join').disabled=false;$('join').hidden=false;resumeAudio()
    }));mix=context.createMediaStreamDestination();analyser=context.createAnalyser();analyser.fftSize=256
    context.createMediaStreamSource(mic).connect(mix)
    meta.segment=meta.segment||crypto.randomUUID();meta.mime=mime;meta.startedAt=Date.now();meta.stopped=false;meta.count=0;seq=0;await step(saveMeta())
    await step(post('prepare',{segment:meta.segment,mime}))
    speakerGain=context.createGain();speakerGain.connect(context.destination)
    const avatarLost=()=>{if(generation!==mediaGeneration||audioOnly)return;audioOnly=true;avatarSource?.disconnect();audioPump?.disconnect();avatarContext?.close().catch(()=>{});if(liveSource){liveSource.connect(mix);liveSource.connect(speakerGain)}state('映像に接続できません。音声のみで続けます')}
    try{
      state('映像に接続しています');const avatarSession=await step(post('avatar',{segment:meta.segment}))
      const client=new SimliClient(avatarSession.session_token,$('avatar'),$('avatarAudio'),avatarSession.iceServers,LogLevel.ERROR,'p2p');avatarClient=client
      client.on('error',avatarLost);client.on('stop',avatarLost)
      $('avatarAudio').muted=true
      const attachAvatarAudio=()=>{const stream=$('avatarAudio').srcObject;if(audioOnly||generation!==mediaGeneration)return;if(!(stream instanceof MediaStream)||!stream.getAudioTracks().length)return;avatarSource?.disconnect();avatarSource=context.createMediaStreamSource(stream);avatarSource.connect(mix);avatarSource.connect(speakerGain)}
      $('avatarAudio').onloadedmetadata=attachAvatarAudio
      let timer;try{await Promise.race([client.start(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Avatar timeout')),25000)})])}finally{clearTimeout(timer)}
      check();attachAvatarAudio()
      if(!audioOnly){await step(avatarContext.audioWorklet.addModule('/pcm-worklet.js'));audioPump=new AudioWorkletNode(avatarContext,'pcm16');audioPump.port.onmessage=e=>{if(!audioOnly)client.sendAudioData(new Uint8Array(e.data))};audioPump.connect(avatarContext.destination)}
    }catch{avatarLost();const failed=avatarClient;avatarClient=null;void failed?.stop().catch(()=>{})}
    check();pc=new RTCPeerConnection();mic.getTracks().forEach(t=>pc.addTrack(t,mic));events=pc.createDataChannel('oai-events')
    events.onmessage=event=>{try{const data=JSON.parse(event.data);if(data.type==='session.started'){sessionReady=true;state(audioOnly?'映像に接続できません。音声のみで続けます':'');if(!greeted){greeted=true;events.send(JSON.stringify({type:'session.commentary.append',event_id:'greeting_'+meta.segment,delegation_id:null,content:greeting}))}}if(data.type==='session.closed'){sessionClosed=true;if(!ending)void finish()}if(data.type==='error'){state('音声サービスで一部の処理に失敗しました。会話を続けられます')}}catch{}}
    pc.ontrack=event=>{const stream=new MediaStream([event.track]);$('remoteAudio').srcObject=stream;$('remoteAudio').muted=true;void $('remoteAudio').play();liveSource=context.createMediaStreamSource(stream);if(!audioOnly)avatarContext.createMediaStreamSource(stream).connect(audioPump);if(audioOnly){liveSource.connect(mix);liveSource.connect(speakerGain)}}
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

    const offer=await step(pc.createOffer());await step(pc.setLocalDescription(offer));await step(iceComplete(pc))
    const hour=new Date().getHours(),greetingText=hour<11?'おはようございます':hour<18?'こんにちは':'こんばんは';greeting='今すぐ日本語で「'+greetingText+'、ゼロちゃんです。タスクの内容について聞かせていただけますか？」と挨拶して、返事を待ってください。';state('音声に接続しています');const answer=await post('session',{segment:meta.segment,mime,sdp:pc.localDescription.sdp,hour});if(generation!==mediaGeneration||cancelled){void post('hangup',{segment:meta.segment}).catch(()=>{});check()}recorder.start(3000);recording=true;uploadTimer=setInterval(flush,4000);await step(pc.setRemoteDescription({type:'answer',sdp:answer.sdp}))
    pc.onconnectionstatechange=()=>{
      if(pc.connectionState==='connected'){clearTimeout(disconnectTimer);if(sessionReady)state(audioOnly?'映像に接続できません。音声のみで続けます':'')}
      if(pc.connectionState==='disconnected'&&!ending){state('再接続を待っています');clearTimeout(disconnectTimer);disconnectTimer=setTimeout(()=>{if(pc.connectionState==='disconnected')void finish()},15000)}
      if(pc.connectionState==='failed'&&!ending){state('音声接続が切れました。録画を保存します');void finish()}
    }
    $('entry').hidden=true;$('speaker').disabled=$('mute').disabled=$('end').disabled=false;$('share').disabled=!navigator.mediaDevices.getDisplayMedia;if(!sessionReady)state('音声に接続しています')
    visionTimer=setInterval(describeScreen,15000)
    durationTimer=setTimeout(()=>{if(recording)void finish()},2*60*60*1000)
  }catch(error){
    if(cancelled||generation!==mediaGeneration)return
    const message=error.name==='NotAllowedError'?'マイクを許可してから接続を再試行してください':error.name==='NotFoundError'?'マイクを接続してから再試行してください':error.name==='NotReadableError'?'マイクを使用中のアプリを閉じて再試行してください':error.message
    state(message)
    if(recorder?.state==='recording')await finish()
    else{releaseMedia();if(!meta.segment)offerRetry();else try{const status=await api('status');if(status.retryable)offerRetry();else{meta.stopped=true;await saveMeta();$('entry').hidden=true;$('retry').hidden=false;state('接続を終了して保存を確定してください')}}catch{offerRetry()}}
  }finally{starting=false}
}
$('join').onclick=()=>resumeAudio?resumeAudio():startMeeting()
window.addEventListener('beforeunload',event=>{if(recording||(!meta?.finished&&meta?.segment)){event.preventDefault();event.returnValue=''}})
window.addEventListener('pagehide',()=>{cancelled=true;resumeAudio?.();if(meta?.segment&&!meta.finished)void fetch(`/api/rooms/${room}/hangup`,{method:'POST',keepalive:true,headers:{authorization:`Bearer ${token}`,'x-meeting-client':meta.client,'content-type':'application/json'},body:JSON.stringify({segment:meta.segment})}).catch(()=>{});releaseMedia();releaseTab?.()})
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload()})
async function init(){
  if(!/^[a-f0-9-]{36}$/.test(room||'')||!/^[a-f0-9]{64}$/.test(token)){state('Slackで受け取った招待リンクから開いてください');$('join').disabled=true;return}
  releaseTab=await acquireRecordingTab(navigator.locks,room)
  if(!releaseTab){state('別のタブで会議を開いています。そちらを閉じてから再読み込みしてください');$('join').disabled=true;return}
  db=await new Promise((resolve,reject)=>{const request=indexedDB.open('zero-hearing',1);request.onupgradeneeded=()=>{request.result.createObjectStore('meta');request.result.createObjectStore('chunks')};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
  meta=await transaction('meta','readonly',s=>s.get(key))||{client:random()};await saveMeta()
  if(meta.segment&&!meta.finished){const status=await api('status');if(status.retryable&&(await chunks()).length===0){meta.stopped=false;meta.count=0;await saveMeta();void startMeeting();return}}
  if(meta.segment){$('entry').hidden=true;$('download').hidden=false;try{seq=recoverRecordingCount(await chunks());meta.count=seq;await saveMeta()}catch(error){state(error.message);return}if(meta.finished){state('会議は終了しています');}else{meta.stopped=true;$('retry').hidden=false;state(seq?'前回の録画が残っています。保存を再試行してください':'接続を終了して保存を確定してください')}}
  else void startMeeting()
}
init().catch(error=>{state(error.message||'録画の保存領域を開けません。ブラウザのストレージを許可してください');$('join').disabled=true})
