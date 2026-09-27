// Local visual QA uses synthetic data only; production never includes this server.
import { createWorker, type Env } from './worker.ts'
import { join } from 'path'
const demo = process.argv.includes('--demo')
const session = 'a'.repeat(64)
const examples = ['available','available','busy','busy','busy','limited','unknown']
const demoFetch: typeof fetch = async (input, init) => {
  const path = String(input), body = JSON.parse(String(init?.body))
  if (path.endsWith('_login')) return Response.json(body.p_password === 'demo' ? {status:200,token:session} : {status:401})
  if (path.endsWith('_logout')) return Response.json(null)
  if (body.p_token !== session) return Response.json({status:401})
  const now = Date.now()
  return Response.json({status:200,serverTime:new Date(now).toISOString(),instances:examples.map((state,i)=>({
    id:String(i),appId:'ADEMO'+i,teamId:'TDEMO',installationId:'demo-'+i,name:`Zeroちゃん ${i+2}号`,pc:`開発Mac ${i<3?'A':'B'}`,
    receivedAt:new Date(now-(i===6?23*60000:12000)).toISOString(),
    snapshot:{state,project:['営業アプリ','社内ポータル','営業アプリ','採用サイト','検索アプリ','コーポレートサイト','検証プロジェクト'][i],queued:i===2?2:0,lastAcceptedAt:now-(i+1)*8*60000,
      summary:[null,'別タスクの画面案は承認待ちです','商品登録の不具合を修正しています。修正が終わり、画面で動作を確認中です。','スマートフォン表示を調整しています。','検索結果の精度を調べています。','公開前の確認を一時停止しています。',null][i],summaryAt:now-120000,slackConnected:true,runnerHealthy:true}
  }))})
}
const worker = createWorker(demo ? demoFetch : fetch)
const env: Env = {
  SUPABASE_URL: demo?'https://demo.supabase.co':process.env.SUPABASE_URL??'',
  SUPABASE_PUBLISHABLE_KEY:process.env.SUPABASE_PUBLISHABLE_KEY??'demo',
  FLEET_SPACE_ID:process.env.FLEET_SPACE_ID??'demo',FLEET_GATEWAY_SECRET:process.env.FLEET_GATEWAY_SECRET??(demo?'demo':''),
  ASSETS:{async fetch(req){const path=new URL(req.url).pathname;const file=path==='/'?'index.html':path==='/app.js'?'app.js':path==='/style.css'?'style.css':null
    return file?new Response(Bun.file(join(import.meta.dir,'public',file))):new Response('Not found',{status:404})}},
}
const server=Bun.serve({hostname:'127.0.0.1',port:4178,fetch:req=>worker.fetch(req,env)})
console.log(`Local: ${server.url}${demo?' (synthetic demo, password: demo)':''}`)
