import { mkdirSync, renameSync, existsSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import { Writable } from 'stream'
import { z } from 'zod'
import { CloudHandoffClient, readCloudConfig, type CloudConfig } from './cloud-handoff.ts'
import { writeCheckpoint } from './handoff-coordinator.ts'

/** Credentials go directly from an interactive terminal to Supabase. They are
 * never command arguments, environment variables, model input or log output. */
export async function loginCloud(url: string, key: string, email: string, password: string,
  fetcher: typeof fetch = fetch): Promise<{ config: CloudConfig; userId: string }> {
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url)) throw new Error('Supabase project URL is invalid')
  if (!key.startsWith('sb_publishable_')) throw new Error('Use a Supabase publishable key, never a secret/service-role key')
  const response = await fetcher(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Supabase login failed (HTTP ${response.status})`) }
  const result = z.object({ access_token: z.string().min(20), refresh_token: z.string().min(10),
    expires_in: z.number().positive(), user: z.object({ id: z.string().uuid() }) }).safeParse(await response.json())
  if (!result.success) throw new Error('Supabase login returned an invalid session')
  return { userId: result.data.user.id, config: { version: 1, url, publishableKey: key,
    accessToken: result.data.access_token, refreshToken: result.data.refresh_token,
    expiresAt: Date.now() + result.data.expires_in * 1000 } }
}

async function prompt(label: string, secret = false): Promise<string> {
  process.stdout.write(label)
  const output = new Writable({ write(chunk, _encoding, done) {
    if (!secret) process.stdout.write(chunk)
    done()
  } })
  const input = createInterface({ input: process.stdin, output, terminal: true })
  try {
    return await new Promise<string>((resolve, reject) => {
      input.once('SIGINT', () => reject(new Error('Login cancelled')))
      input.once('close', () => reject(new Error('Terminal input closed')))
      input.question('', value => resolve(value))
    })
  } finally { input.close(); if (secret) process.stdout.write('\n') }
}

async function main(): Promise<void> {
  const [command, stateDir] = process.argv.slice(2)
  if (!stateDir || !['login', 'activate', 'status'].includes(command ?? '')) throw new Error('Usage: zerochan cloud login|activate|status')
  const active = join(stateDir, 'cloud-auth.json')
  const pending = join(stateDir, 'cloud-auth.pending.json')
  if (command === 'login') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Cloud login requires an interactive terminal')
    if (existsSync(active) || existsSync(pending)) throw new Error('Cloud credentials already exist; existing identity was preserved')
    const url = (await prompt('Supabase project URL: ')).trim()
    const key = (await prompt('Publishable key (sb_publishable_...): ')).trim()
    const email = (await prompt('このPC専用のSupabase Authメールアドレス: ')).trim()
    const password = await prompt('Supabase Authパスワード（非表示）: ', true)
    const session = await loginCloud(url, key, email, password)
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    writeCheckpoint(pending, Buffer.from(JSON.stringify(session.config)))
    console.log(`認証を保存しました。まだ引き継ぎ機能は有効化していません。\n登録用user_id: ${session.userId}\n管理者がこのPCのSlack Bot IDとの対応を登録した後、zerochan cloud activate を実行してください。`)
    return
  }
  const path = command === 'activate' && existsSync(pending) ? pending : active
  const client = new CloudHandoffClient(readCloudConfig(path), fetch, path)
  const member = await client.member()
  if (command === 'activate' && path === pending) renameSync(pending, active)
  console.log(`クラウド接続: 正常\nSlack team: ${member.slack_team_id}\nSlack bot: ${member.slack_bot_id}\n${command === 'activate' ? 'zerochan stop → zerochan start で有効化してください。' : ''}`)
}

if (import.meta.main) main().catch(() => {
  // Never relay a provider response or schema failure containing session data.
  console.error('Cloud setup failed. Check the project URL, publishable key, login and member registration. Existing credentials were preserved.')
  process.exitCode = 1
})
