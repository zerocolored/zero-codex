/** Trusted host code. Site content supplies candidates, never authorization. */
export const LOGIN_MARKERS = ['ログアウト', 'サインアウト', 'Log out', 'Log Out', 'Logout', 'Sign out', 'Sign Out']

export function auditReadUrl(target: string, candidate: string): boolean {
  try {
    const base = new URL(target), url = new URL(candidate), prefix = base.pathname.replace(/\/$/, '')
    return url.origin === base.origin && !url.username && !url.password && !url.search && !url.hash
      && !/[%\\]/.test(url.pathname)
      && (url.pathname === prefix || url.pathname.startsWith(prefix + '/'))
      && !/(?:^|[/_.-])(?:logout|log-out|signout|sign-out|delete|remove|destroy|revoke|reset|unsubscribe|checkout|purchase|pay|callback)(?:$|[/_.-])/i.test(url.pathname)
  } catch { return false }
}

export type AuthenticationDiscovery =
  | { status: 'verified'; path: string; kind: 'status' | 'marker'; pattern?: string }
  | { status: 'no-session' | 'unverified' | 'unavailable' }

export type AuthResponse = { status: number; location: string | null; body: string }
export async function readAuthResponse(url: string, cookie: string, signal?: AbortSignal): Promise<AuthResponse> {
  const response = await fetch(url, {
    headers: cookie ? {Cookie: cookie} : {}, redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  })
  const result = {status: response.status, location: response.headers.get('location'), body: ''}
  const reader = response.body?.getReader()
  if (!reader) return result
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      size += value.length
      if (size > 200000) return result
      chunks.push(value)
    }
    result.body = Buffer.concat(chunks).toString('utf8')
    return result
  } finally { await reader.cancel() }
}

export function authResponseProof(anonymous: AuthResponse, authenticated: AuthResponse,
  markers: string[] = LOGIN_MARKERS): {kind: 'status' | 'marker'; pattern?: string} | null {
  if (authenticated.status < 200 || authenticated.status >= 300) return null
  // A 403 can be a WAF/consent-cookie challenge, not an application login gate.
  const denied = anonymous.status === 401
    || (anonymous.status >= 300 && anonymous.status < 400 && anonymous.location !== null
      && /(?:^|\/)(?:login|signin|sign-in|authorize)(?:[/?#]|$)/i.test(anonymous.location))
  if (denied) return {kind: 'status'}
  if (anonymous.status < 200 || anonymous.status >= 300) return null
  const pattern = markers.find(p => authenticated.body.includes(p) && !anonymous.body.includes(p))
  return pattern ? {kind: 'marker', pattern} : null
}

/** Real Chrome renders SPAs; GET API responses and links become bounded probe candidates.
 * No page text, cookies, storage, request headers, or query strings are returned. */
export function authenticationDiscoveryProgram(playwrightEntry: string): string {
  return `import {chromium} from ${JSON.stringify(playwrightEntry)};
const allowed=${auditReadUrl.toString()};
const defaults=${JSON.stringify(LOGIN_MARKERS)};
` + String.raw`
const input=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>resolve(s))}));
const markers=[...defaults,...(typeof input.pattern==='string'?[input.pattern]:[])];
const browser=await chromium.launch({channel:'chrome'});
try {
 const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
 await context.addCookies(input.cookies);
 await context.route('**/*',route=>{
   const r=route.request(); return ['GET','HEAD'].includes(r.method())&&allowed(input.target,r.url())?route.continue():route.abort();
 });
 await context.routeWebSocket('**/*',socket=>socket.close());
 const page=await context.newPage(), candidates=new Map(), visited=new Set(), queue=[input.probe,input.target].filter(Boolean);
 const add=(url,visible=[])=>{if(!allowed(input.target,url)||candidates.size>=24)return;const path=new URL(url).pathname;
   candidates.set(path,[...new Set([...(candidates.get(path)||[]),...visible])]);};
 page.on('response',response=>{const type=response.headers()['content-type']||'';
   if(response.request().method()==='GET'&&/json|html/.test(type))add(response.url());});
 const deadline=Date.now()+40000;
 while(queue.length&&visited.size<8&&Date.now()<deadline){
   const url=queue.shift();if(visited.has(url)||!allowed(input.target,url))continue;visited.add(url);
   try {
     await page.goto(url,{waitUntil:'domcontentloaded',timeout:5000});
     await page.waitForLoadState('networkidle',{timeout:1500}).catch(()=>{});
     if(!allowed(input.target,page.url()))continue;
     const text=await page.locator('body').innerText({timeout:1000});
     add(page.url(),markers.filter(m=>text.includes(m)));
     const links=await page.locator('a[href]').evaluateAll(nodes=>nodes.slice(0,100).map(n=>n.href));
     for(const link of [...new Set(links)].filter(x=>allowed(input.target,x)).sort()){
       if(queue.length<24&&!visited.has(link)&&!queue.includes(link))queue.push(link);
     }
   } catch {}
 }
 console.log(JSON.stringify({candidates:[...candidates].sort((a,b)=>a[0].localeCompare(b[0])).map(([path,markers])=>({path,markers}))}));
} finally {await browser.close();}
`
}
