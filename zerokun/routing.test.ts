import { describe, expect, test } from 'bun:test'
import { requireLegacyThreadRepoRoute, requireRepoRoute } from './routing.ts'

describe('Slack repository routing', () => {
  test('DMだけがlauncher repositoryを既定値として使う', () => {
    expect(requireRepoRoute('D0123456789', undefined, '/default')).toBe('/default')
  })

  test('channelは明示したrepo_pathが無ければ実行を拒否する', () => {
    expect(() => requireRepoRoute('C0123456789', undefined, '/default')).toThrow(
      'channel C0123456789 has no configured repo_path',
    )
    expect(() => requireRepoRoute('C0123456789', '   ', '/default')).toThrow()
  })

  test('channelは明示したrepo_pathだけを選ぶ', () => {
    expect(requireRepoRoute('C0123456789', ' /repo/project ', '/default')).toBe('/repo/project')
  })

  test('legacy DM threadは現在のlauncher cwdより保存済みrepositoryを優先する', () => {
    expect(requireLegacyThreadRepoRoute(
      'D0123456789',
      '/project/A',
      undefined,
      '/project/B',
    )).toBe('/project/A')
  })

  test('保存repoがないlegacy entryだけ現在のDM default/channel routeへfallbackする', () => {
    expect(requireLegacyThreadRepoRoute('D0123456789', undefined, undefined, '/default'))
      .toBe('/default')
    expect(requireLegacyThreadRepoRoute('C0123456789', undefined, '/channel-route', '/default'))
      .toBe('/channel-route')
  })
})
