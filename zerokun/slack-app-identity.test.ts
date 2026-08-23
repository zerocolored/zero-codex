import { describe, expect, test } from 'bun:test'
import {
  appIdFromAppToken,
  slackTokenPairRuntimeIdentity,
  verifySlackAppTokenPair,
} from './slack-app-identity.ts'

describe('Slack App token identity', () => {
  test('xapp tokenからApp IDを取り出し、同じBot Appだけを許可する', async () => {
    const appToken = 'xapp-1-A0123456789-abcdefghijklmnopqrstuvwxyz'
    expect(appIdFromAppToken(appToken)).toBe('A0123456789')
    await expect(verifySlackAppTokenPair(appToken, {
      authTest: async () => ({ app_id: 'A0123456789', user_id: 'U0123456789' }),
      botsInfo: async () => { throw new Error('not needed') },
    })).resolves.toEqual({ appId: 'A0123456789', botUserId: 'U0123456789' })
  })

  test('auth.testにApp IDが無ければbot_idを引き、別App tokenとの混在を拒否する', async () => {
    const api = {
      authTest: async () => ({ bot_id: 'B0123456789', user_id: 'U0123456789' }),
      botsInfo: async () => ({ app_id: 'AOLDAPP123' }),
    }
    await expect(verifySlackAppTokenPair(
      'xapp-1-ANEWAPP123-abcdefghijklmnopqrstuvwxyz',
      api,
    )).rejects.toThrow('different Slack Apps')
  })

  test('App IDを含まない曖昧なxapp tokenを拒否する', () => {
    expect(() => appIdFromAppToken('xapp-not-enough-information'))
      .toThrow('valid Slack App ID')
  })

  test('同じApp IDでもBotまたはApp tokenのrotationを別identityとする', () => {
    const appToken = 'xapp-1-A0123456789-abcdefghijklmnopqrstuvwxyz'
    const first = slackTokenPairRuntimeIdentity('xoxb-first-token-1234567890', appToken)
    const rotatedBot = slackTokenPairRuntimeIdentity('xoxb-second-token-1234567890', appToken)
    const rotatedApp = slackTokenPairRuntimeIdentity(
      'xoxb-first-token-1234567890',
      'xapp-1-A0123456789-zyxwvutsrqponmlkjihgfedcba',
    )
    expect(first).toStartWith('A0123456789:')
    expect(rotatedBot).not.toBe(first)
    expect(rotatedApp).not.toBe(first)
  })
})
