import { expect, test } from 'bun:test'
import { loginCloud } from './cloud-setup.ts'

test('login uses the member auth endpoint and returns a separately stored session', async () => {
  const session = await loginCloud('https://example.supabase.co', 'sb_publishable_fixture', 'machine@example.invalid', 'fixture-password',
    (async (url, init) => {
      expect(String(url)).toBe('https://example.supabase.co/auth/v1/token?grant_type=password')
      expect(init?.redirect).toBe('error')
      expect(JSON.parse(String(init?.body))).toEqual({ email: 'machine@example.invalid', password: 'fixture-password' })
      return Response.json({ access_token: 'fixture-access-token-only', refresh_token: 'fixture-refresh-token-only',
        expires_in: 3600, user: { id: '11111111-1111-4111-8111-111111111111' } })
    }) as typeof fetch)
  expect(session.userId).toBe('11111111-1111-4111-8111-111111111111')
  expect(session.config.expiresAt).toBeGreaterThan(Date.now())
})
test('administrator keys cannot be supplied to machine enrollment', async () => {
  let requests = 0
  await expect(loginCloud('https://example.supabase.co', 'sb_secret_fixture', 'x', 'y',
    (async () => { requests++; return new Response('') }) as typeof fetch)).rejects.toThrow('publishable')
  expect(requests).toBe(0)
})
test('provider diagnostic bodies cannot leak through login failures', async () => {
  await expect(loginCloud('https://example.supabase.co', 'sb_publishable_fixture', 'x', 'y',
    (async () => new Response('sensitive-provider-content', { status: 401 })) as typeof fetch))
    .rejects.toThrow('Supabase login failed (HTTP 401)')
})
test('invalid sessions are rejected without returning provider data', async () => {
  await expect(loginCloud('https://example.supabase.co', 'sb_publishable_fixture', 'x', 'y',
    (async () => Response.json({ secret: 'sensitive-provider-content' })) as typeof fetch))
    .rejects.toThrow('invalid session')
})
