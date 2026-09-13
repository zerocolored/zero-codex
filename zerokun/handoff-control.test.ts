import { expect, test } from 'bun:test'
import { explicitlyAddressedHandoff, handoffControl } from './handoff-control.ts'
test('explicit control is bound to the mentioned bot ID, not its display name', () => {
  expect(explicitlyAddressedHandoff('<@U123> 引き継いで', 'U123')).toBe(true)
  expect(explicitlyAddressedHandoff('<@U123> 引き継いで', 'U456')).toBe(false)
  expect(explicitlyAddressedHandoff('<@U123> <@U456> 引き継いで', 'U123')).toBe(false)
  expect(explicitlyAddressedHandoff('Zeroちゃん 引き継いで', 'U123')).toBe(false)
  expect(explicitlyAddressedHandoff('<@U123> 引き継いでと言われた', 'U123')).toBe(false)
  expect(handoffControl('続けて')).toBe('continue')
  expect(handoffControl('続けてはいけない')).toBeNull()
})
