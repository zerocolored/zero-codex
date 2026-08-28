import { describe, expect, test } from 'bun:test'
import { requireLegacyThreadRepoRoute, requireRepoRoute } from './routing.ts'

describe('Slack repository routing', () => {
  test('DMはactive zerochan projectを使う', () => {
    expect(requireRepoRoute('D0123456789', undefined, '/default')).toBe('/default')
  })

  test('channelもactive zerochan projectを使い、route設定を要求しない', () => {
    expect(requireRepoRoute('C0123456789', undefined, '/default')).toBe('/default')
    expect(requireRepoRoute('C0123456789', '   ', '/default')).toBe('/default')
  })

  test('旧routes.json相当の値は新しいchannel threadへ影響しない', () => {
    expect(requireRepoRoute('C0123456789', ' /repo/old-route ', '/active')).toBe('/active')
  })

  test('legacy DM threadは現在のlauncher cwdより保存済みrepositoryを優先する', () => {
    expect(requireLegacyThreadRepoRoute(
      'D0123456789',
      '/project/A',
      undefined,
      '/project/B',
    )).toBe('/project/A')
  })

  test('保存repoがないlegacy entryだけ現在のactive projectへfallbackする', () => {
    expect(requireLegacyThreadRepoRoute('D0123456789', undefined, undefined, '/default'))
      .toBe('/default')
    expect(requireLegacyThreadRepoRoute('C0123456789', undefined, '/channel-route', '/default'))
      .toBe('/default')
  })
})
