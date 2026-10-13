import { expect, test } from 'bun:test'
import { auditReadUrl, authResponseProof, readAuthResponse } from './security-audit-auth.ts'
import { discoverAuditAuthentication, authenticatedBrowser, zapScopeFiles } from './security-audit-tools.ts'
import { auditSettingsSchema } from './security-audit.ts'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test('discovered URLs remain inside the authorized scope and exclude actions, credentials and ambiguous encodings', () => {
  const target='https://example.test/app'
  for (const path of ['/app','/app/account','/app/api/me']) expect(auditReadUrl(target,'https://example.test'+path)).toBe(true)
  for (const url of ['https://other.test/app','https://example.test/account','https://example.test/application','https://example.test/app/logout','https://example.test/app/sign-out','https://example.test/app/delete/item','https://example.test/app/%2e%2e/admin','https://user:pass@example.test/app','https://example.test/app?token=private']) expect(auditReadUrl(target,url)).toBe(false)
})

test('HTTP proof distinguishes anonymous denial or absent visible markers from public content and expired sessions', () => {
  const publicPage={status:200,location:null,body:'<h1>Welcome</h1><a>ログアウト</a>'}
  expect(authResponseProof(publicPage,publicPage)).toBeNull()
  expect(authResponseProof({...publicPage,status:401},publicPage)).toEqual({kind:'status'})
  expect(authResponseProof({...publicPage,status:403,body:'WAF challenge'},publicPage)).toBeNull()
  expect(authResponseProof({...publicPage,status:302,location:'/login'},publicPage)).toEqual({kind:'status'})
  expect(authResponseProof({...publicPage,status:302,location:'/elsewhere'},publicPage)).toBeNull()
  expect(authResponseProof({...publicPage,body:'Login'},publicPage)).toEqual({kind:'marker',pattern:'ログアウト'})
  expect(authResponseProof({...publicPage,body:'Login'},publicPage,[])).toBeNull()
  expect(authResponseProof(publicPage,{...publicPage,status:401})).toBeNull()
})

test('ZAP confirms the exact prevalidated protected URL and cookie, never a public redirect destination', () => {
  for(const pattern of [undefined,'ログアウト']) {
    let confirmed=0
    const script=zapScopeFiles('https://example.test/app',{url:'https://example.test/app/me',pattern}).script
    const Java={type:(name:string)=>name==='java.lang.System'?{getenv:()=> 'fixture=valid'}:name==='java.nio.file.Paths'?{get:(path:string)=>path}:{writeString:()=>confirmed++}}
    const receive=new Function('Java',script+';return responseReceived')(Java)
    const message=(url:string,status:number,body:string,cookie='fixture=valid')=>({
      getRequestHeader:()=>({getHeader:()=>cookie,getURI:()=>({getEscapedURI:()=>url})}),
      getResponseHeader:()=>({getStatusCode:()=>status}),getResponseBody:()=>body,
    })
    receive(message('https://example.test/app/login',200,'ログアウト'));expect(confirmed).toBe(0)
    receive(message('https://example.test/app/me',401,'ログアウト'));expect(confirmed).toBe(0)
    receive(message('https://example.test/app/me',200,'ログアウト',''));expect(confirmed).toBe(0)
    receive(message('https://example.test/app/me',200,'ログアウト'));expect(confirmed).toBe(1)
  }
})

test('HTTP confirmation does not follow redirects, leaks no cookies cross-origin and bounds response content', async () => {
  let outside=0
  const foreign=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>{outside++;return new Response('unexpected')}})
  const local=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>new URL(request.url).pathname==='/large'
    ? new Response('x'.repeat(200001)) : new Response(null,{status:302,headers:{location:foreign.url.href}})})
  try {
    expect((await readAuthResponse(local.url.href,'synthetic=session')).status).toBe(302)
    expect(outside).toBe(0)
    expect((await readAuthResponse(new URL('/large',local.url).href,'')).body).toBe('')
  } finally {await local.stop(true);await foreign.stop(true)}
})

// Opt-in real Chrome verification uses installed tools and synthetic loopback
// credentials only. No real browser profile, site or authentication is read.
test.skipIf(!process.env.ZERO_AUDIT_BROWSER_TEST_STATE)('real Chrome discovers SSR and SPA authentication, rejects public/expired sessions, and stays in scope', async () => {
  const state=process.env.ZERO_AUDIT_BROWSER_TEST_STATE!
  const repo=mkdtempSync(join(tmpdir(),'audit-auth-browser-'))
  let mode='ssr', forbidden=0
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>{
    const path=new URL(request.url).pathname, authenticated=request.headers.get('cookie')==='fixture=valid'&&mode!=='expired'
    if (path==='/outside'||path==='/app/logout'||request.method!=='GET') {forbidden++;return new Response('Forbidden',{status:403})}
    const html=(body:string)=>new Response(body,{headers:{'content-type':'text/html'}})
    if(mode==='waf'&&!authenticated)return new Response('WAF challenge',{status:403})
    if (path==='/app') return html(['public','waf'].includes(mode)?'<h1>ログアウト</h1>':mode==='spa'
      ? '<h1 id="title">Loading</h1><script>fetch("/app/api/me").then(r=>r.json()).then(x=>document.querySelector("h1").textContent=x.ok?"ログアウト":"Login")</script>'
      : '<a href="/app/account">Account</a><a href="/outside">Outside</a><a href="/app/logout">Logout</a>')
    if(path==='/app/api/me') return Response.json({ok:authenticated},{status:authenticated?200:401})
    if(path==='/app/account') return authenticated?html('<h1>ログアウト</h1><img src="/app/logout"><img src="/outside">'):new Response(null,{status:302,headers:{location:'/app/login'}})
    if(path==='/app/custom')return html(authenticated?'<h1>Members only fixture</h1>':'<h1>Login</h1>')
    return html('<h1>Login</h1>')
  }})
  const settings=auditSettingsSchema.parse({targetUrl:new URL('/app',server.url).href,authentication:'required'})
  const cookies=async()=>[{name:'fixture',value:'valid',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax' as const}]
  try {
    const ssr=await discoverAuditAuthentication({id:'ssr',repoPath:repo},state,settings,{},cookies)
    expect(ssr).toEqual({status:'verified',path:'/app/account',kind:'status'})
    expect((await authenticatedBrowser({root:repo,source:repo,repo,stateDir:state,jobId:'verify-ssr',settings:{...settings,authenticatedPath:'/app/account',authenticationProbe:'status'}},cookies)).ok).toBe(true)
    expect(forbidden).toBe(0)
    expect(await discoverAuditAuthentication({id:'custom',repoPath:repo},state,
      {...settings,authenticatedPath:'/app/custom',loggedInPattern:'Members only fixture'}, {},cookies))
      .toEqual({status:'verified',path:'/app/custom',kind:'marker',pattern:'Members only fixture'})
    mode='spa'
    expect(await discoverAuditAuthentication({id:'spa',repoPath:repo},state,settings,{},cookies)).toEqual({status:'verified',path:'/app/api/me',kind:'status'})
    for(const scenario of ['public','expired','waf']) {
      mode=scenario
      expect(await discoverAuditAuthentication({id:scenario,repoPath:repo},state,settings,{},cookies)).toEqual({status:'unverified'})
    }
    expect(await discoverAuditAuthentication({id:'empty',repoPath:repo},state,settings,{},async()=>[])).toEqual({status:'no-session'})
    expect(forbidden).toBe(0)
  } finally {await server.stop(true);rmSync(repo,{recursive:true,force:true})}
},120000)
