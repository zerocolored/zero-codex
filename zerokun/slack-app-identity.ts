#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { createHash } from 'crypto'
import { parseStateSlackTokens } from './child-environment.ts'
import { readOptionalPrivateFile } from './safe-file.ts'
import { slackWebClientOptions } from './slack-http.ts'

export interface SlackIdentityApi {
  authTest(): Promise<{ app_id?: string; bot_id?: string; user_id?: string }>
  botsInfo(bot: string): Promise<{ app_id?: string }>
}

export function appIdFromAppToken(token: string): string {
  // Slack's current app-level token examples are xapp-1-A012...-...; older
  // SDK examples omit the numeric version. Both still carry the owning App ID.
  const match = /^xapp-(?:[0-9]+-)?(A[A-Z0-9]+)-[A-Za-z0-9._-]{10,}$/.exec(token)
  if (!match) throw new Error('SLACK_APP_TOKEN does not contain a valid Slack App ID')
  return match[1]!
}

/** Non-secret identity for exact token-pair rotation detection. */
export function slackTokenPairRuntimeIdentity(botToken: string, appToken: string): string {
  const appId = appIdFromAppToken(appToken)
  const fingerprint = createHash('sha256')
    .update(`${botToken.length}:`)
    .update(botToken)
    .update(`${appToken.length}:`)
    .update(appToken)
    .digest('hex')
  return `${appId}:${fingerprint}`
}

export async function verifySlackAppTokenPair(
  appToken: string,
  api: SlackIdentityApi,
): Promise<{ appId: string; botUserId?: string }> {
  const expectedAppId = appIdFromAppToken(appToken)
  const auth = await api.authTest()
  let botAppId = auth.app_id
  if (!botAppId && auth.bot_id) botAppId = (await api.botsInfo(auth.bot_id)).app_id
  if (!botAppId) throw new Error('Slack Bot token App ID could not be verified')
  if (botAppId !== expectedAppId) {
    throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN belong to different Slack Apps')
  }
  return { appId: botAppId, botUserId: auth.user_id }
}

async function verifyFile(path: string): Promise<void> {
  const tokens = parseStateSlackTokens(readOptionalPrivateFile(path) ?? '')
  if (!tokens.SLACK_BOT_TOKEN || !tokens.SLACK_APP_TOKEN) {
    throw new Error(`Slack tokens are missing: ${path}`)
  }
  const { WebClient } = await import('@slack/web-api')
  const client = new WebClient(tokens.SLACK_BOT_TOKEN, slackWebClientOptions(10_000))
  await verifySlackAppTokenPair(tokens.SLACK_APP_TOKEN, {
    authTest: () => client.auth.test({}),
    botsInfo: async bot => {
      const result = await client.bots.info({ bot })
      return { app_id: result.bot?.app_id }
    },
  })
}

if (import.meta.main) {
  const command = process.argv[2]
  if (process.argv.length !== 4
    || (command !== 'verify-file' && command !== 'runtime-id-file')) {
    process.stderr.write(
      'usage: slack-app-identity.ts <verify-file|runtime-id-file> <state-env-file>\n',
    )
    process.exit(2)
  }
  try {
    if (command === 'verify-file') {
      await verifyFile(process.argv[3]!)
      process.stdout.write('Slack App token identity: verified\n')
    } else {
      const tokens = parseStateSlackTokens(readOptionalPrivateFile(process.argv[3]!) ?? '')
      if (!tokens.SLACK_BOT_TOKEN || !tokens.SLACK_APP_TOKEN) {
        throw new Error('Slack token pair is missing')
      }
      process.stdout.write(
        `${slackTokenPairRuntimeIdentity(tokens.SLACK_BOT_TOKEN, tokens.SLACK_APP_TOKEN)}\n`,
      )
    }
  } catch (error) {
    process.stderr.write(`Slack App token identity verification failed: ${error}\n`)
    process.exit(1)
  }
}
