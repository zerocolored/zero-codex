import { join } from 'path'
import { z } from 'zod'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { FleetSessionExpired, type FleetSnapshot } from './fleet-status.ts'

// Public destination only. Never accept a runtime URL that could exfiltrate Slack credentials.
export const FLEET_SENDER_ORIGIN = 'https://zerochan-fleet.s-hashimoto-dcd.workers.dev'
export class FleetSenderDiagnostic extends Error {}
const credentialSchema = z.object({ instanceId: z.string().uuid(), installationId: z.string().uuid(),
  appId: z.string(), token: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().finite() }).strict()
export class FleetSenderClient {
  private credential: z.infer<typeof credentialSchema> | undefined
  private renew = false
  constructor(private state: string, private installationId: string, private appId: string,
    private botToken: string, private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {}
  private async request(action: string, token: string, body: object) {
    const response = await this.fetcher(`${FLEET_SENDER_ORIGIN}/api/sender/${action}`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json() as any
    if (!response.ok) {
      if (response.status === 401) { this.renew = true; throw new FleetSessionExpired('稼働状況の送信認証を再取得します') }
      if (response.status === 409) throw new FleetSessionExpired('稼働状況の送信世代を再取得します')
      const messages: Record<string, string> = {
        slack_workspace_denied: 'Slackワークスペースが監視の登録対象外です',
        slack_users_read_required: 'Slackアプリのusers:read権限が必要です',
        slack_app_mismatch: 'Slackアプリの認証IDが一致しません',
        registration_disabled: '稼働状況の登録が管理者により無効化されています',
        enrollment_not_configured: '稼働状況サーバーの登録設定が未完了です',
        enrollment_rate_limited: '稼働状況の登録上限に達しました。自動再試行します',
      }
      throw new FleetSenderDiagnostic(messages[result?.code] ?? '稼働状況サーバーへ接続できません。自動再試行します')
    }
    return result
  }
  async begin(): Promise<{ instanceId: string; generation: number }> {
    const path = join(this.state, 'fleet-sender-credential.json')
    if (!this.credential && !this.renew) {
      const text = readOptionalBoundedOwnerOnlyRegularFile(path, 4096)
      if (text) { let value: unknown; try { value = JSON.parse(text) } catch { value = null }
        const parsed = credentialSchema.safeParse(value)
        if (parsed.success && parsed.data.installationId === this.installationId && parsed.data.appId === this.appId) this.credential = parsed.data
      }
    }
    if (!this.credential || this.renew || this.credential.expiresAt < this.now() + 60_000) {
      const result = await this.request('enroll', this.botToken, { installationId: this.installationId, appId: this.appId })
      this.credential = credentialSchema.parse({ instanceId: result.instanceId, token: result.token, expiresAt: result.expiresAt,
        installationId: this.installationId, appId: this.appId })
      atomicWritePrivateFile(path, JSON.stringify(this.credential) + '\n')
      this.renew = false
    }
    const result = await this.request('begin', this.credential.token, { instanceId: this.credential.instanceId })
    return { instanceId: this.credential.instanceId, generation: z.number().int().positive().parse(result.generation) }
  }
  async send(generation: number, sequence: number, snapshot: FleetSnapshot, projectKey?: string) {
    if (!this.credential) throw new FleetSessionExpired('稼働状況の送信認証が未取得です')
    const {currentProject,...publicSnapshot}=snapshot
    const body = { instanceId: this.credential.instanceId, generation, sequence, snapshot:publicSnapshot }
    if (projectKey) {
      try { await this.request('project-report', this.credential.token, {...body, projectKey,currentProject:currentProject??null}); return }
      catch (error) { if (error instanceof FleetSessionExpired) throw error }
    }
    // An older server can still receive the legacy dashboard heartbeat during rollout.
    await this.request('report', this.credential.token, body)
  }
}
