import { describe, expect, test } from 'bun:test'
import {
  containsCredentialMaterial,
  normalizeImplementationGuardText,
  normalizePublicGuardText,
  redactCredentialMaterial,
} from './public-output-guard.ts'
import {
  UTS39_ASCII_SKELETON_GROUPS,
  UTS39_ASCII_SKELETON_SOURCE_COUNT,
  UTS39_CONFUSABLES_SHA256,
  UTS39_CONFUSABLES_VERSION,
} from './uts39-ascii-skeleton.ts'

describe('public credential guard', () => {
  test('advisorとSlackで共通のcredential形式を不可視文字込みで検出する', () => {
    for (const value of [
      'xapp-1-A1234567890-abcdefghijklmnopqrstuvwxyz',
      'xoxc-1234567890-abcdefghijklmnopqrstuvwxyz',
      'xoxe-1234567890-abcdefghijklmnopqrstuvwxyz',
      'xoxb-\u200E1234567890-abcdefghijklmnopqrstuvwxyz',
      'xapp-\u00AD1-A1234567890-abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234\u3164567890-abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234\uFE0F567890-abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234\u034F567890-abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234\u{E0100}567890-abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234\u0600567890-abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234\u0007567890-abcdefghijklmnopqrstuvwxyz',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.1234567890-._~+',
      'Authorization: Bearer short',
      'Bearer a',
      'Bearer abc',
      'Bearer auth-token-secret',
      'Bearer token-abc123',
      'Bearer header.payload',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
      'eyJhbGciOiJIUzI1NiJ9.e30.abc',
      'xoxb%2D1234567890%2Dabcdefghijklmnopqrstuvwxyz',
      '%78%6F%78%62%2D1234567890%2Dabcdefghijklmnopqrstuvwxyz',
      'Authorization%3A%20Bearer%20abc',
      'xoxb%252525252D1234567890%252525252Dabcdefghijklmnopqrstuvwxyz',
    ]) {
      expect(containsCredentialMaterial(value)).toBe(true)
      expect(redactCredentialMaterial(value, '[redacted]')).toBe('[redacted]')
    }
  })

  test('一般説明はcredentialと誤判定しない', () => {
    for (const value of [
      'Bearer認証はAuthorization headerで使われます。',
      'Bearer tokens are commonly sent in the Authorization header.',
    ]) {
      expect(containsCredentialMaterial(value)).toBe(false)
      expect(redactCredentialMaterial(value, '[redacted]')).toBe(value)
    }
  })

  test('不可視文字と非テキスト制御文字を公開判定前に除く', () => {
    expect(normalizePublicGuardText(
      'a\u0600b\u061Cc\u200Fd\u202Ee\u2066f\uFEFFg\u3164h\uFE0Fi\u034Fj\u{E0100}k\u0007l',
    )).toBe('abcdefghijkl')
    expect(normalizePublicGuardText('line 1\n\tline 2')).toBe('line 1\n\tline 2')
  })

  test('pinしたUnicode UTS #39 ASCII skeletonを決定的に適用する', () => {
    expect(UTS39_CONFUSABLES_VERSION).toBe('17.0.0')
    expect(UTS39_CONFUSABLES_SHA256).toBe(
      '091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a',
    )
    expect([...UTS39_ASCII_SKELETON_GROUPS]
      .reduce((count, [, sources]) => count + [...sources].length, 0))
      .toBe(UTS39_ASCII_SKELETON_SOURCE_COUNT)
    expect(UTS39_ASCII_SKELETON_SOURCE_COUNT).toBe(1553)
    const mismatches = UTS39_ASCII_SKELETON_GROUPS.flatMap(([target, sources]) => (
      [...sources]
        .filter(source => (
          normalizeImplementationGuardText(source)
            !== normalizeImplementationGuardText(target)
        ))
        .map(source => `${source}->${target}`)
    ))
    expect(mismatches).toEqual([])
    expect(normalizeImplementationGuardText('Cοdex Cоdex')).toBe('Codex Codex')
    expect(normalizeImplementationGuardText('Coԁex')).toBe('Codex')
    expect(normalizeImplementationGuardText('Clаude Code')).toBe('Claude Code')
    expect(normalizeImplementationGuardText('Grоk')).toBe('Grok')
    expect(normalizeImplementationGuardText('rncp')).toBe('rncp')
    expect(normalizeImplementationGuardText('OpenAl')).toBe('OpenAl')
    expect(normalizeImplementationGuardText('通常の公開本文')).toBe('通常の公開本文')
  })
})
