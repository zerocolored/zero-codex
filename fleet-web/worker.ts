export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  FLEET_SPACE_ID: string
  FLEET_GATEWAY_SECRET: string
}
const cookieName = '__Host-zero-fleet'
const security = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { ...security, ...headers } })
}
function token(request: Request) {
  return request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? ''
}
async function ipHash(secret: string, ip: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip))
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('')
}
export function createWorker(fetcher: typeof fetch = fetch) {
  return { async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) {
      const response = await env.ASSETS.fetch(request)
      const headers = new Headers(response.headers)
      for (const [key, value] of Object.entries(security)) headers.set(key, value)
      return new Response(response.body, { status: response.status, headers })
    }
    if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(env.SUPABASE_URL ?? '') || !env.FLEET_GATEWAY_SECRET) return json({ error: '稼働状況の接続設定を確認中です' }, 503)
    const rpc = async (name: string, body: object) => {
      const response = await fetcher(`${env.SUPABASE_URL}/rest/v1/rpc/zerochan_fleet_${name}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!response.ok) { console.warn('fleet RPC HTTP failure', response.status); await response.body?.cancel(); throw new Error('monitor unavailable') }
      if (name === 'logout') { await response.body?.cancel(); return null }
      return response.json() as Promise<Record<string, unknown> | null>
    }
    try {
      if (request.method === 'POST') {
        if (request.headers.get('origin') !== url.origin) return json({ error: '操作元を確認できません' }, 403)
        if (url.pathname === '/api/logout') {
          await rpc('logout', { p_token: token(request) })
          return json({}, 200, { 'Set-Cookie': `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` })
        }
        if (url.pathname !== '/api/login') return json({}, 404)
        if (!request.headers.get('content-type')?.startsWith('application/json')) return json({}, 415)
        const reader = request.body?.getReader()
        if (!reader) return json({}, 400)
        let text = '', size = 0
        try {
          const decoder = new TextDecoder()
          while (true) {
            const part = await reader.read()
            if (part.done) break
            size += part.value.length
            if (size > 2048) return json({}, 413)
            text += decoder.decode(part.value, { stream: true })
          }
          text += decoder.decode()
        } finally { await reader.cancel() }
        let password: unknown
        try { password = JSON.parse(text).password } catch { return json({}, 400) }
        if (typeof password !== 'string' || !password.length || password.length > 256) return json({}, 400)
        const result = await rpc('login', { p_space: env.FLEET_SPACE_ID, p_gateway: env.FLEET_GATEWAY_SECRET,
          p_ip: await ipHash(env.FLEET_GATEWAY_SECRET, request.headers.get('CF-Connecting-IP') ?? 'local'), p_password: password })
        if (result?.status !== 200 || typeof result.token !== 'string' || !/^[a-f0-9]{64}$/.test(result.token)) {
          const status = result?.status === 429 ? 429 : result?.status === 401 ? 401 : 503
          return json({ error: status === 429 ? '試行回数が多いため、15分後にお試しください' : status === 401 ? 'パスワードが違います' : '接続できません。しばらくしてからお試しください' }, status)
        }
        return json({}, 200, { 'Set-Cookie': `${cookieName}=${result.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800` })
      }
      if (request.method !== 'GET' || url.pathname !== '/api/status') return json({}, 404)
      const session = token(request)
      if (!/^[a-f0-9]{64}$/.test(session)) return json({}, 401)
      const result = await rpc('list', { p_token: session })
      if (result?.status !== 200) return json({}, 401)
      return json(result)
    } catch (error) {
      // Never log request bodies, credentials, RPC response bodies or exception messages.
      console.warn('fleet request failed', error instanceof Error ? error.name : 'unknown',
        error instanceof Error ? error.stack?.split('\n').slice(1, 4).join('\n') : '')
      return json({ error: '最新情報を取得できません。再接続を待っています' }, 503)
    }
  } }
}
export default createWorker()
