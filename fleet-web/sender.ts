/** Machine-only enrollment. Slack credentials are used transiently, never persisted. */
export type SenderEnv = { FLEET_SPACE_ID: string; FLEET_GATEWAY_SECRET: string; FLEET_SLACK_TEAM_ID?: string }
type Rpc = (name: string, body: object) => Promise<any>
const id = (value: unknown, prefix: string) => typeof value === 'string' && new RegExp(`^${prefix}[A-Z0-9]{1,63}$`).test(value)
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const reply = (status: number, code: string, extra: object = {}) => Response.json({ code, ...extra }, { status, headers: { 'Cache-Control': 'no-store' } })
async function body(request: Request): Promise<any> {
  const reader = request.body?.getReader(); if (!reader) throw Error('body')
  let text = '', size = 0; const decoder = new TextDecoder()
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break
    size += chunk.value.length; if (size > 12_288) throw Error('size')
    text += decoder.decode(chunk.value, { stream: true })
  } return JSON.parse(text + decoder.decode()) } finally { await reader.cancel() }
}
export async function senderRequest(request: Request, env: SenderEnv, rpc: Rpc, fetcher: typeof fetch): Promise<Response> {
  const action = new URL(request.url).pathname.slice('/api/sender/'.length)
  if (request.method !== 'POST' || !['enroll', 'begin', 'report', 'project-report', 'project-status'].includes(action)) return reply(404, 'not_found')
  // No browser cookies or Origin-authorized writes on machine endpoints.
  if (request.headers.has('origin')) return reply(403, 'machine_only')
  if (!request.headers.get('content-type')?.startsWith('application/json')) return reply(415, 'json_required')
  let input: any; try { input = await body(request) } catch { return reply(400, 'invalid_body') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reply(400, 'invalid_body')
  const auth = request.headers.get('authorization') ?? ''
  if (action === 'enroll') {
    if (!id(env.FLEET_SLACK_TEAM_ID, 'T')) return reply(503, 'enrollment_not_configured')
    if (!/^Bearer xoxb-[A-Za-z0-9._-]{10,4096}$/.test(auth) || !uuid(input.installationId) || !id(input.appId, 'A')) return reply(400, 'invalid_enrollment')
    const admitted = await rpc('sender_throttle', { p_space: env.FLEET_SPACE_ID, p_gateway: env.FLEET_GATEWAY_SECRET,
      p_ip: request.headers.get('CF-Connecting-IP') ?? 'local' })
    if (admitted !== true) return reply(429, 'enrollment_rate_limited')
    const slack = async (method: string, payload: Record<string, string>) => {
      const response = await fetcher(`https://slack.com/api/${method}`, { method: 'POST', redirect: 'manual',
        signal: AbortSignal.timeout(8000), headers: { authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(payload).toString() })
      if (!response.ok) { await response.body?.cancel(); return { ok: false, error: response.status === 429 ? 'ratelimited' : 'transport' } }
      return response.json() as Promise<any>
    }
    const identity = await slack('auth.test', {})
    if (!identity.ok) return reply(identity.error === 'ratelimited' || identity.error === 'transport' ? 503 : 401, 'slack_auth_failed')
    if (identity.team_id !== env.FLEET_SLACK_TEAM_ID || !id(identity.bot_id, 'B') || !id(identity.user_id, 'U')) return reply(403, 'slack_workspace_denied')
    const info = await slack('bots.info', { bot: identity.bot_id })
    if (!info.ok) return reply(info.error === 'missing_scope' ? 403 : 503, info.error === 'missing_scope' ? 'slack_users_read_required' : 'slack_identity_unavailable')
    if (info.bot?.id !== identity.bot_id || info.bot?.user_id !== identity.user_id || info.bot?.app_id !== input.appId || info.bot?.deleted !== false) {
      console.warn('fleet Slack identity mismatch', { botMatches: info.bot?.id === identity.bot_id,
        userMatches: info.bot?.user_id === identity.user_id, appMatches: info.bot?.app_id === input.appId,
        deletionFieldPresent: typeof info.bot?.deleted === 'boolean', deleted: info.bot?.deleted === true })
      return reply(403, 'slack_app_mismatch')
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const token = [...bytes].map(v => v.toString(16).padStart(2, '0')).join('')
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(v => v.toString(16).padStart(2, '0')).join('')
    const result = await rpc('sender_enroll', { p_space: env.FLEET_SPACE_ID, p_gateway: env.FLEET_GATEWAY_SECRET,
      p_installation: input.installationId, p_app: info.bot.app_id, p_team: identity.team_id,
      p_name: String(info.bot.name || input.appId).slice(0, 100), p_pc: `PC ${input.installationId.slice(0, 8)}`, p_hash: digest })
    if (result?.status !== 200) return reply(403, 'registration_disabled')
    return reply(200, 'enrolled', { instanceId: result.instanceId, expiresAt: result.expiresAt, token })
  }
  if (!/^Bearer [a-f0-9]{64}$/.test(auth) || !uuid(input.instanceId)) return reply(401, 'sender_auth_required')
  const common = { p_id: input.instanceId, p_token: auth.slice(7) }
  if (action.startsWith('project-')) {
    if (typeof input.projectKey !== 'string' || !input.projectKey.length || input.projectKey.length>100 || /[\\/\x00-\x1f\x7f]/.test(input.projectKey)) return reply(400, 'invalid_project')
    if (action==='project-report' && input.currentProject!=null && (typeof input.currentProject!=='string' || !input.currentProject.length || input.currentProject.length>100 || /[\\/\x00-\x1f\x7f]/.test(input.currentProject))) return reply(400,'invalid_project')
    const result = await rpc(action === 'project-status' ? 'project_status' : 'project_report', { ...common, p_project: input.projectKey,
      ...(action === 'project-report' ? {p_generation:input.generation,p_sequence:input.sequence,p_snapshot:input.snapshot,p_current:input.currentProject??null} : {}) })
    if (result?.status !== 200) return reply([400,401,403,409].includes(result?.status) ? result.status : 503, 'project_unavailable')
    return Response.json(result, {headers:{'Cache-Control':'no-store'}})
  }
  const result = action === 'begin'
    ? await rpc('sender_begin', common)
    : await rpc('sender_report', { ...common, p_generation: input.generation, p_sequence: input.sequence, p_snapshot: input.snapshot })
  const status = result?.status
  if (status !== 200) return reply(status === 409 ? 409 : status === 400 ? 400 : 401, status === 409 ? 'stale_generation' : status === 400 ? 'invalid_snapshot' : 'sender_auth_required')
  return reply(200, 'ok', action === 'begin' ? { generation: result.generation } : {})
}
