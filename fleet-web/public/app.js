const $ = id => document.getElementById(id)
let data = null, offset = 0, fetching = false, failed = false
const labels = {available:'すぐ着手可能',busy:'作業中',limited:'利用上限で待機',waiting:'開始待ち',unknown:'状態不明'}
function node(tag,text,cls){const el=document.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el}
function relative(value,now){if(!value)return '未受信';const age=Math.max(0,now-new Date(value).getTime());if(age<60000)return `${Math.floor(age/1000)}秒前`;if(age<3600000)return `${Math.floor(age/60000)}分前`;if(age<86400000)return `${Math.floor(age/3600000)}時間前`;return `${Math.floor(age/86400000)}日前`}
function render(){if(!data)return;const now=Date.now()+offset,counts={available:0,busy:0,limited:0,unknown:0};$('rows').replaceChildren()
 const active=data.instances.filter(r=>r.receivedAt&&now-Date.parse(r.receivedAt)<90000)
 for(const row of data.instances){const s=row.snapshot,stale=!row.receivedAt||now-Date.parse(row.receivedAt)>=90000
 const duplicate=active.filter(r=>r.appId===row.appId&&r.teamId===row.teamId&&r.installationId!==row.installationId).length>0
 const state=failed||stale||duplicate?'unknown':s?.state??'unknown';counts[state==='waiting'?'unknown':state]++
 const el=node('article','','row'),identity=node('div','');identity.append(node('strong',row.name),node('small',`${s?.project||'プロジェクト未受信'} · ${row.pc}`))
 const status=node('div','');status.append(node('span',labels[state],'badge '+state));status.append(node('small',duplicate?'同じアプリが別PCでも稼働中':state==='unknown'?'接続を確認できません':state==='busy'||state==='waiting'?`待ち ${s.queued}件`:''))
 const summary=node('div','','summary');summary.append(node('strong',state==='unknown'?'現在の作業状況は不明です':s?.summary|| (state==='available'?'現在の作業はありません':state==='limited'?'利用上限の解除を待っています':state==='waiting'?(s.queued>0?`依頼を${s.queued}件受け付けていますが、まだ着手していません。待機理由は未取得です。`:'現在、作業は始まっていません。待機理由は未取得です。'):'作業中・要約更新待ち')))
 if(state==='unknown'&&s)summary.append(node('small',`最後の報告：${labels[s.state]??'状態不明'}`));else if(s?.summaryAt)summary.append(node('small',`${relative(s.summaryAt,now)}更新`))
 const accepted=node('time',relative(s?.lastAcceptedAt,now));accepted.dataset.label='最後の依頼受付';if(s?.lastAcceptedAt){accepted.dateTime=new Date(s.lastAcceptedAt).toISOString();accepted.append(node('small',new Date(s.lastAcceptedAt).toLocaleString('ja-JP')))}
 const last=node('time',relative(row.receivedAt,now));last.dataset.label='最終通信';if(row.receivedAt)last.dateTime=row.receivedAt
 el.append(identity,status,summary,accepted,last);$('rows').append(el)
 }
 if(!data.instances.length)$('rows').append(node('p','登録済みのZeroちゃんはまだありません。','empty'))
 $('total').textContent=`${data.instances.length}台`;$('counts').replaceChildren()
 for(const [key,title] of [['available','すぐ着手できる'],['busy','作業中'],['limited','利用上限で待機'],['unknown','状態不明・開始待ち']]){const el=node('div','','count');el.append(node('span',title),node('strong',String(counts[key])));$('counts').append(el)}
}
function showLogin(){data=null;$('login').hidden=false;$('dashboard').hidden=true;$('logout').hidden=true;$('loading').hidden=true}
async function refresh(){if(fetching)return;fetching=true;try{const r=await fetch('/api/status',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(r.status===401){showLogin();return}if(!r.ok)throw Error();data=await r.json();offset=Date.parse(data.serverTime)-Date.now();failed=false;$('login').hidden=true;$('dashboard').hidden=false;$('logout').hidden=false;$('error').hidden=true;$('updated').textContent=`最終取得 ${new Date().toLocaleTimeString('ja-JP')} · 自動更新`;render()}catch{failed=true;if(data){$('error').hidden=false;$('error').textContent='最新情報を取得できません。再接続を待っています。';render()}else{$('loading').textContent='接続できません。自動で再接続します。'}}finally{fetching=false;if(data)$('loading').hidden=true}}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;$('login-error').textContent='';try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value}),signal:AbortSignal.timeout(10000)});const body=await r.json();if(!r.ok)throw Error(body.error||'ログインできませんでした');$('password').value='';await refresh()}catch(e){$('login-error').textContent=e.message||'接続できません'}finally{button.disabled=false}})
$('logout').addEventListener('click',async()=>{try{const r=await fetch('/api/logout',{method:'POST',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error();showLogin()}catch{$('error').hidden=false;$('error').textContent='ログアウトできませんでした。もう一度お試しください。'}})
void refresh();setInterval(refresh,15000);setInterval(render,1000)
