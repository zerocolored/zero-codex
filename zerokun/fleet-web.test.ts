import { test, expect } from 'bun:test'
import { createWorker, type Env } from '../fleet-web/worker.ts'
const env:Env={SUPABASE_URL:'https://demo.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public',FLEET_SPACE_ID:'space',FLEET_GATEWAY_SECRET:'private-gateway',ASSETS:{fetch:async()=>new Response('page')}}
test('fleet viewer cannot read without session or write monitoring data',async()=>{
 let calls=0;const worker=createWorker(async()=>{calls++;return Response.json({status:200})})
 expect((await worker.fetch(new Request('https://example.com/api/status'),env)).status).toBe(401)
 expect((await worker.fetch(new Request('https://example.com/api/report',{method:'POST',headers:{origin:'https://example.com'}}),env)).status).toBe(404)
 expect(calls).toBe(0)
})
test('login protects origin, issues only secure cookie, no secret response',async()=>{
 let body:any
 const worker=createWorker(async(_,init)=>{expect(init?.redirect).toBe('manual');body=JSON.parse(String(init?.body));return Response.json({status:200,token:'a'.repeat(64)})})
 const make=(origin:string)=>new Request('https://example.com/api/login',{method:'POST',headers:{origin,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify({password:'example'})})
 expect((await worker.fetch(make('https://attacker.example'),env)).status).toBe(403)
 const response=await worker.fetch(make('https://example.com'),env)
 expect(response.status).toBe(200)
 expect(response.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Strict')
 expect(await response.text()).toBe('{}')
 expect(body.p_ip).toMatch(/^[a-f0-9]{64}$/)
 expect(body.p_ip).not.toContain('192.0.2.1')
})
test('rate limit and outage are explicit; logout expires cookie',async()=>{
 const request=new Request('https://example.com/api/login',{method:'POST',headers:{origin:'https://example.com','Content-Type':'application/json'},body:'{"password":"example"}'})
 expect((await createWorker(async()=>Response.json({status:429})).fetch(request,env)).status).toBe(429)
 const status=new Request('https://example.com/api/status',{headers:{cookie:'__Host-zero-fleet='+'a'.repeat(64)}})
 expect((await createWorker(async()=>{throw Error('offline')}).fetch(status,env)).status).toBe(503)
 const logout=await createWorker(async()=>new Response(null,{status:204})).fetch(new Request('https://example.com/api/logout',{method:'POST',headers:{origin:'https://example.com'}}),env)
 expect(logout.status).toBe(200)
 expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
})
test('RPC redirects are not followed with gateway credentials',async()=>{
 let calls=0
 const worker=createWorker(async(_,init)=>{calls++;expect(init?.redirect).toBe('manual');return new Response(null,{status:302,headers:{location:'https://example.net'}})})
 const request=new Request('https://example.com/api/login',{method:'POST',headers:{origin:'https://example.com','Content-Type':'application/json'},body:'{"password":"example"}'})
 expect((await worker.fetch(request,env)).status).toBe(503)
 expect(calls).toBe(1)
})
