import { createHash } from 'crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import { releaseProcessLock, tryAcquireProcessLock } from './process-lock.ts'

export const CLOUD_WAIT_MESSAGE = '利用上限のため待機中です。作業状態は保存しました。他のメンバーに引き継ぐ場合は、そのメンバーをメンションして「引き継いで」と言ってください。利用上限の解除後、私に「続けて」と指示して再開することもできます。'
export const CLOUD_SAVE_FAILED_MESSAGE = '利用上限のため待機中です。クラウドへの作業状態の保存はまだ完了していません。ローカルの作業は保持しています。保存を再試行し、完了後にお知らせします。'
export const CLOUD_MAX_BYTES = 512 * 1024 * 1024
// Keep each JSON object below common Storage/proxy limits. The local package
// remains unchanged; only its cloud transport is split, with a verified manifest.
export const CLOUD_CHUNK_BYTES = 3 * 1024 * 1024
const CLOUD_SINGLE_BYTES = 4 * 1024 * 1024
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const chunkManifestSchema = z.object({
  zerochanCheckpoint: z.literal(1),
  bytes: z.number().int().min(1).max(CLOUD_MAX_BYTES),
  digest: digestSchema,
  chunks: z.array(z.object({ digest: digestSchema,
    bytes: z.number().int().min(1).max(CLOUD_SINGLE_BYTES + 1024),
    decodedBytes: z.number().int().min(1).max(CLOUD_CHUNK_BYTES),
  }).strict()).min(1).max(Math.ceil(CLOUD_MAX_BYTES / CLOUD_CHUNK_BYTES)),
}).strict()
const chunkSchema = z.object({ zerochanChunk: z.literal(1), data: z.string() }).strict()
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
  constructor(readonly status: number, readonly operation: string, readonly providerCode?: string) {
    // Never put responses, tokens or signed URLs into Slack/process logs.
    super(`cloud handoff ${operation} failed (HTTP ${status}${providerCode ? `; ${providerCode}` : ''})`)
  }
}

const storageErrorCodes = new Set(['EntityTooLarge', 'ResourceAlreadyExists', 'KeyAlreadyExists',
  'NoSuchKey', 'NoSuchBucket', 'AccessDenied', 'InvalidJWT', 'InvalidMimeType'])

/** Bounded classification only: never persist provider text, URLs or credentials. */
async function responseError(response: Response, operation: string): Promise<CloudHandoffError> {
  let code: string | undefined
  const reader = response.body?.getReader()
  if (reader) {
    try {
      const chunks: Uint8Array[] = []
      let length = 0
      while (true) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.length
        if (length > 4096) break
        chunks.push(next.value)
      }
      if (length <= 4096) {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (storageErrorCodes.has(value?.code)) code = value.code
      }
    } catch { /* HTTP status still identifies the failed operation. */ }
    finally { await reader.cancel().catch(() => {}) }
  }
  return new CloudHandoffError(response.status, operation, code)
}

export function cloudFailureReason(error: unknown): string {
  if (error instanceof CloudHandoffError) {
    const stage = ['GET', 'POST', 'upload', 'download', 'authentication refresh'].includes(error.operation)
      ? error.operation : 'request'
    const code = error.providerCode && storageErrorCodes.has(error.providerCode) ? `:${error.providerCode}` : ''
    return `cloud-${stage}:HTTP-${error.status}${code}`
  }
  return error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
    ? 'cloud-timeout' : 'cloud-operation-failed'
}

/** Only member-scoped credentials; never a shared service-role/admin key. */
export class CloudHandoffClient {
  constructor(private readonly config: CloudConfig, private readonly fetcher: typeof fetch = fetch,
    private readonly configPath?: string) {}
  /** Authentication only: monitoring does not need handoff membership or RPC rights. */
  async authenticatedUserId(): Promise<string> {
    const response = await this.request('/auth/v1/user', 'GET')
    return z.object({ id: z.string().uuid() }).parse(await response.json()).id
  }
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
  private async request(path: string, method: string, body?: string | Uint8Array, operation = method): Promise<Response> {
    const config = await this.credentials()
    const response = await this.fetcher(`${config.url}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json' }, body: body as BodyInit | undefined,
    })
    if (!response.ok) throw await responseError(response, operation)
    return response
  }
  private async rpc(name: string, args: Record<string, unknown>): Promise<CloudHandoff> {
    const response = await this.request(`/rest/v1/rpc/${name}`, 'POST', JSON.stringify(args))
    return handoffSchema.parse(await response.json())
  }
  /** Monitoring has separate RPC grants and never touches handoff records. */
  async fleetRpc(name: 'context' | 'register' | 'begin' | 'report', args: Record<string, unknown>): Promise<unknown> {
    const config = await this.credentials()
    const response = await this.fetcher(`${config.url}/rest/v1/rpc/zerochan_fleet_${name}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    if (!response.ok) { await response.body?.cancel(); throw new CloudHandoffError(response.status, 'fleet') }
    return response.json()
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
    const prefix = `${h.space_id}/${h.owner_id}/${h.id}/`
    let object = bytes
    if (bytes.length > CLOUD_SINGLE_BYTES) {
      const chunks: z.infer<typeof chunkManifestSchema>['chunks'] = []
      for (let offset = 0; offset < bytes.length; offset += CLOUD_CHUNK_BYTES) {
        const part = bytes.subarray(offset, offset + CLOUD_CHUNK_BYTES)
        const encoded = Buffer.from(JSON.stringify({ zerochanChunk: 1, data: Buffer.from(part).toString('base64') }))
        const digest = digestBytes(encoded)
        await this.uploadVerified(`${prefix}${digest}.json`, encoded)
        chunks.push({ digest, bytes: encoded.length, decodedBytes: part.length })
      }
      object = Buffer.from(JSON.stringify({ zerochanCheckpoint: 1, bytes: bytes.length, digest: digestBytes(bytes), chunks }))
    }
    const digest = digestBytes(object)
    const key = `${prefix}${digest}.json`
    await this.uploadVerified(key, object)
    return this.rpc('zerochan_checkpoint', { p_id: h.id, p_epoch: h.epoch, p_state: 'waiting',
      p_key: key, p_digest: digest, p_bytes: object.length,
      p_reset: resetAt === null ? null : new Date(resetAt).toISOString() })
  }

  private async uploadVerified(key: string, bytes: Uint8Array): Promise<void> {
    let uploadError: unknown
    try {
      await this.request(`/storage/v1/object/zerochan-handoffs/${key}`, 'POST', bytes, 'upload')
    } catch (error) {
      if (!(error instanceof CloudHandoffError) || ![400, 409].includes(error.status)) throw error
      uploadError = error
    }
    try {
      const uploaded = await this.downloadKey(key, bytes.length)
      if (digestBytes(uploaded) !== digestBytes(bytes)) throw new Error('uploaded checkpoint digest mismatch')
    } catch (error) {
      // A duplicate/lost response is success only after exact readback. A
      // secondary missing-object error must never hide the original rejection.
      throw uploadError ?? error
    }
  }
  private async downloadKey(key: string, expected: number): Promise<Uint8Array> {
    if (!/^[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9]{64}\.json$/.test(key)
      || !Number.isSafeInteger(expected) || expected < 1 || expected > CLOUD_MAX_BYTES) throw new Error('invalid checkpoint reference')
    const response = await this.request(`/storage/v1/object/authenticated/zerochan-handoffs/${key}`, 'GET', undefined, 'download')
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
    // Legacy checkpoints stay readable, including previously published large JSON.
    if (bytes.length <= 64 * 1024 && Buffer.from(bytes.subarray(0, 24)).toString('utf8').startsWith('{"zerochanCheckpoint":')) {
      const candidate = JSON.parse(Buffer.from(bytes).toString('utf8'))
      if (candidate?.zerochanCheckpoint !== undefined) {
        const manifest = chunkManifestSchema.parse(candidate)
        if (manifest.chunks.reduce((sum, part) => sum + part.decodedBytes, 0) !== manifest.bytes) {
          throw new Error('checkpoint manifest size mismatch')
        }
        const prefix = h.checkpoint_key.slice(0, h.checkpoint_key.lastIndexOf('/') + 1)
        const result = Buffer.alloc(manifest.bytes)
        let offset = 0
        for (const part of manifest.chunks) {
          const encoded = await this.downloadKey(`${prefix}${part.digest}.json`, part.bytes)
          if (digestBytes(encoded) !== part.digest) throw new Error('checkpoint chunk digest mismatch')
          const chunk = chunkSchema.parse(JSON.parse(Buffer.from(encoded).toString('utf8')))
          const decoded = Buffer.from(chunk.data, 'base64')
          if (decoded.length !== part.decodedBytes || decoded.toString('base64') !== chunk.data) {
            throw new Error('checkpoint chunk size or encoding mismatch')
          }
          decoded.copy(result, offset); offset += decoded.length
        }
        if (digestBytes(result) !== manifest.digest) throw new Error('checkpoint assembled digest mismatch')
        return result
      }
    }
    return bytes
  }
  take(h: CloudHandoff, eventId: string): Promise<CloudHandoff> {
    return this.rpc('zerochan_take_handoff', { p_id: h.id, p_epoch: h.epoch, p_event: eventId })
  }
  activate(h: CloudHandoff): Promise<CloudHandoff> {
    return this.rpc('zerochan_activate_handoff', { p_id: h.id, p_epoch: h.epoch })
  }
}
