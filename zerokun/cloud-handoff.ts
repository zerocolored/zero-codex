import { createHash } from 'crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import { releaseProcessLock, tryAcquireProcessLock } from './process-lock.ts'

export const CLOUD_WAIT_MESSAGE = '利用上限のため待機中です。作業状態は保存しました。他のメンバーに引き継ぐ場合は、そのメンバーをメンションして「引き継いで」と言ってください。利用上限の解除後、私に「続けて」と指示して再開することもできます。'
export const CLOUD_SAVE_FAILED_MESSAGE = '利用上限のため待機中です。クラウドへの作業状態の保存はまだ完了していません。ローカルの作業は保持しています。保存を再試行し、完了後にお知らせします。'
export const CLOUD_MAX_BYTES = 512 * 1024 * 1024
export const digestBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const configSchema = z.object({
  version: z.literal(1),
  url: z.string().url().refine(value => /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(value)),
  publishableKey: z.string().min(20),
  accessToken: z.string().min(20),
  refreshToken: z.string().min(10).optional(),
  expiresAt: z.number().int().positive().optional(),
}).strict()
export type CloudConfig = z.infer<typeof configSchema>
export function readCloudConfig(path: string): CloudConfig {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.()
      || (st.mode & 0o077) !== 0 || st.size > 16384) throw new Error('cloud configuration is not owner-only')
    return configSchema.parse(JSON.parse(readFileSync(fd, 'utf8')))
  } finally { closeSync(fd) }
}

export const handoffSchema = z.object({
  id: z.string().uuid(), space_id: z.string().uuid(), slack_team_id: z.string(),
  channel_id: z.string(), thread_ts: z.string(), owner_id: z.string().uuid(),
  epoch: z.number().int().positive(),
  state: z.enum(['active', 'saving', 'waiting', 'importing', 'completed']),
  checkpoint_key: z.string().nullable(), checkpoint_digest: z.string().nullable(),
  checkpoint_bytes: z.number().nullable(), reset_at: z.string().nullable(), updated_at: z.string(),
})
export type CloudHandoff = z.infer<typeof handoffSchema>
export class CloudHandoffError extends Error {
  constructor(readonly status: number, operation: string) {
    // Never put responses, tokens or signed URLs into Slack/process logs.
    super(`cloud handoff ${operation} failed (HTTP ${status})`)
  }
}

/** Only member-scoped credentials; never a shared service-role/admin key. */
export class CloudHandoffClient {
  constructor(private readonly config: CloudConfig, private readonly fetcher: typeof fetch = fetch,
    private readonly configPath?: string) {}
  private async credentials(): Promise<CloudConfig> {
    if (!this.configPath) return this.config
    const initial = readCloudConfig(this.configPath)
    if (!initial.expiresAt || initial.expiresAt > Date.now() + 60_000) return initial
    const lockPath = `${this.configPath}.refresh.lock`
    const deadline = Date.now() + 65_000
    while (Date.now() < deadline) {
      const lock = tryAcquireProcessLock(lockPath)
      if (!lock.acquired) { await Bun.sleep(250); continue }
      try {
        const current = readCloudConfig(this.configPath)
        if (!current.expiresAt || current.expiresAt > Date.now() + 60_000) return current
        if (!current.refreshToken) throw new Error('cloud login expired; sign in again')
        const response = await this.fetcher(`${current.url}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: { apikey: current.publishableKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: current.refreshToken }),
        })
        if (!response.ok) { await response.body?.cancel(); throw new CloudHandoffError(response.status, 'authentication refresh') }
        const session = z.object({ access_token: z.string().min(20), refresh_token: z.string().min(10), expires_in: z.number().positive() }).parse(await response.json())
        const next: CloudConfig = { ...current, accessToken: session.access_token, refreshToken: session.refresh_token,
          expiresAt: Date.now() + session.expires_in * 1000 }
        const temp = `${this.configPath}.${crypto.randomUUID()}.tmp`
        const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
        try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(temp, this.configPath)
        const parent = openSync(dirname(this.configPath), constants.O_RDONLY)
        try { fsyncSync(parent) } finally { closeSync(parent) }
        return next
      } finally { releaseProcessLock(lockPath, lock.lease) }
    }
    throw new Error('cloud authentication refresh is busy')
  }
  private async request(path: string, method: string, body?: string | Uint8Array): Promise<Response> {
    const config = await this.credentials()
    const response = await this.fetcher(`${config.url}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json' }, body: body as BodyInit | undefined,
    })
    if (!response.ok) { await response.body?.cancel(); throw new CloudHandoffError(response.status, method) }
    return response
  }
  private async rpc(name: string, args: Record<string, unknown>): Promise<CloudHandoff> {
    const response = await this.request(`/rest/v1/rpc/${name}`, 'POST', JSON.stringify(args))
    return handoffSchema.parse(await response.json())
  }
  async member(): Promise<{ user_id: string; space_id: string; slack_team_id: string; slack_bot_id: string }> {
    const response = await this.request('/rest/v1/zerochan_members?select=user_id,space_id,slack_team_id,slack_bot_id', 'GET')
    return z.array(z.object({ user_id: z.string().uuid(), space_id: z.string().uuid(),
      slack_team_id: z.string(), slack_bot_id: z.string() })).length(1).parse(await response.json())[0]!
  }
  async find(channel: string, thread: string): Promise<CloudHandoff | null> {
    const params = new URLSearchParams({ channel_id: `eq.${channel}`, thread_ts: `eq.${thread}`, select: '*' })
    const response = await this.request(`/rest/v1/zerochan_handoffs?${params}`, 'GET')
    const rows = z.array(handoffSchema).max(1).parse(await response.json())
    return rows[0] ?? null
  }
  claim(channel: string, thread: string): Promise<CloudHandoff> {
    return this.rpc('zerochan_claim_thread', { p_channel: channel, p_thread: thread })
  }
  saving(h: CloudHandoff, resetAt: number | null = null): Promise<CloudHandoff> {
    return this.rpc('zerochan_checkpoint', { p_id: h.id, p_epoch: h.epoch, p_state: 'saving',
      p_reset: resetAt === null ? null : new Date(resetAt).toISOString() })
  }
  async publish(h: CloudHandoff, bytes: Uint8Array, resetAt: number | null): Promise<CloudHandoff> {
    if (!bytes.length || bytes.length > CLOUD_MAX_BYTES) throw new Error('checkpoint size exceeds limit')
    const digest = digestBytes(bytes)
    const key = `${h.space_id}/${h.owner_id}/${h.id}/${digest}.json`
    try {
      await this.request(`/storage/v1/object/zerochan-handoffs/${key}`, 'POST', bytes)
    } catch (error) {
      if (!(error instanceof CloudHandoffError) || ![400, 409].includes(error.status)) throw error
      // An upload response can be lost. Content verification, not the status
      // code alone, makes retry idempotent.
    }
    const uploaded = await this.downloadKey(key, bytes.length)
    if (digestBytes(uploaded) !== digest) throw new Error('uploaded checkpoint digest mismatch')
    return this.rpc('zerochan_checkpoint', { p_id: h.id, p_epoch: h.epoch, p_state: 'waiting',
      p_key: key, p_digest: digest, p_bytes: bytes.length,
      p_reset: resetAt === null ? null : new Date(resetAt).toISOString() })
  }
  private async downloadKey(key: string, expected: number): Promise<Uint8Array> {
    if (!/^[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9]{64}\.json$/.test(key)
      || expected < 1 || expected > CLOUD_MAX_BYTES) throw new Error('invalid checkpoint reference')
    const response = await this.request(`/storage/v1/object/authenticated/zerochan-handoffs/${key}`, 'GET')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('checkpoint body missing')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > expected) throw new Error('checkpoint size mismatch')
        chunks.push(value)
      }
    } finally { await reader.cancel() }
    if (size !== expected) throw new Error('checkpoint size mismatch')
    return Buffer.concat(chunks)
  }
  async download(h: CloudHandoff): Promise<Uint8Array> {
    if (!h.checkpoint_key || !h.checkpoint_digest || !h.checkpoint_bytes) throw new Error('checkpoint not ready')
    const bytes = await this.downloadKey(h.checkpoint_key, h.checkpoint_bytes)
    if (digestBytes(bytes) !== h.checkpoint_digest) throw new Error('checkpoint digest mismatch')
    return bytes
  }
  take(h: CloudHandoff, eventId: string): Promise<CloudHandoff> {
    return this.rpc('zerochan_take_handoff', { p_id: h.id, p_epoch: h.epoch, p_event: eventId })
  }
  activate(h: CloudHandoff): Promise<CloudHandoff> {
    return this.rpc('zerochan_activate_handoff', { p_id: h.id, p_epoch: h.epoch })
  }
}
