import { expect, test } from 'bun:test'
import { randomBytes } from 'crypto'
import { CLOUD_CHUNK_BYTES, CloudHandoffClient, CloudHandoffError, cloudFailureReason, digestBytes, type CloudHandoff } from './cloud-handoff.ts'

const h: CloudHandoff = { id: '11111111-1111-4111-8111-111111111111',
  space_id: '22222222-2222-4222-8222-222222222222', owner_id: '33333333-3333-4333-8333-333333333333',
  epoch: 2, slack_team_id: 'T1', channel_id: 'C1', thread_ts: '1.0', state: 'saving',
  checkpoint_key: null, checkpoint_digest: null, checkpoint_bytes: null, reset_at: null, updated_at: new Date(0).toISOString() }
const config = { version: 1 as const, url: 'https://example.supabase.co', publishableKey: 'public-fixture', accessToken: 'access-fixture' }

function storage() {
  const objects = new Map<string, Buffer>()
  let publications = 0, maxUpload = 0
  const client = new CloudHandoffClient(config, (async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.includes('/rpc/')) {
      publications++
      const p = JSON.parse(String(init?.body))
      return Response.json({ ...h, state: 'waiting', checkpoint_key: p.p_key, checkpoint_digest: p.p_digest, checkpoint_bytes: p.p_bytes })
    }
    const key = path.split('zerochan-handoffs/')[1]!
    if (init?.method === 'POST') {
      const body = Buffer.from(init.body as Uint8Array)
      maxUpload = Math.max(maxUpload, body.length)
      if (body.length > 5 * 1024 * 1024) return Response.json({ code: 'EntityTooLarge' }, { status: 400 })
      if (objects.has(key)) return Response.json({ code: 'ResourceAlreadyExists' }, { status: 409 })
      objects.set(key, body)
      return new Response('')
    }
    return objects.has(key) ? new Response(objects.get(key)) : new Response('missing', { status: 404 })
  }) as typeof fetch)
  return { client, objects, counts: () => ({ publications, maxUpload }) }
}

test('incompressible large checkpoints roundtrip under a per-object limit and survive duplicate uploads', async () => {
  const fixture = storage()
  const bytes = randomBytes(CLOUD_CHUNK_BYTES * 3 + 19)
  const ready = await fixture.client.publish(h, bytes, null)
  expect(fixture.counts().maxUpload).toBeLessThan(5 * 1024 * 1024)
  expect(fixture.objects.size).toBe(5)
  expect(Buffer.from(await fixture.client.download(ready))).toEqual(bytes)
  const again = await fixture.client.publish(h, bytes, null)
  expect(again.checkpoint_key).toBe(ready.checkpoint_key)
  expect(fixture.objects.size).toBe(5)
  expect(Buffer.from(await fixture.client.download(again))).toEqual(bytes)
})

test('legacy raw JSON remains readable without requiring a manifest', async () => {
  const fixture = storage(), bytes = Buffer.from('{"version":1,"history":"legacy"}')
  const ready = await fixture.client.publish(h, bytes, null)
  expect(fixture.objects.size).toBe(1)
  expect(Buffer.from(await fixture.client.download(ready))).toEqual(bytes)
})

test('upload rejection remains the cause when readback also fails; provider text is never exposed', async () => {
  let published = false
  const client = new CloudHandoffClient(config, (async (url, init) => {
    if (String(url).includes('/rpc/')) published = true
    return init?.method === 'POST'
      ? Response.json({ code: 'EntityTooLarge', message: 'private-provider-diagnostic', statusCode: '413' }, { status: 400 })
      : Response.json({ code: 'NoSuchKey' }, { status: 404 })
  }) as typeof fetch)
  try { await client.publish(h, Buffer.from('fixture'), null); throw Error('expected upload failure') }
  catch (error) {
    expect(error).toBeInstanceOf(CloudHandoffError)
    expect(error).toMatchObject({ status: 400, operation: 'upload', providerCode: 'EntityTooLarge' })
    expect(cloudFailureReason(error)).toBe('cloud-upload:HTTP-400:EntityTooLarge')
    expect(String(error)).not.toContain('private-provider-diagnostic')
  }
  expect(published).toBe(false)
})

test('missing or corrupt chunk cannot be imported and malformed totals fail before fetching chunks', async () => {
  const f = storage(), bytes = Buffer.alloc(CLOUD_CHUNK_BYTES * 2, 42)
  const ready = await f.client.publish(h, bytes, null)
  const manifest = JSON.parse(f.objects.get(ready.checkpoint_key!)!.toString())
  const prefix = ready.checkpoint_key!.slice(0, ready.checkpoint_key!.lastIndexOf('/') + 1)
  const key = prefix + manifest.chunks[0].digest + '.json'
  const original = f.objects.get(key)!
  f.objects.delete(key)
  await expect(f.client.download(ready)).rejects.toThrow('download')
  f.objects.set(key, Buffer.alloc(original.length, 32))
  await expect(f.client.download(ready)).rejects.toThrow('chunk digest')
  f.objects.set(key, original)
  manifest.bytes++
  const malformed = Buffer.from(JSON.stringify(manifest))
  f.objects.set(ready.checkpoint_key!, malformed)
  await expect(f.client.download({ ...ready, checkpoint_bytes: malformed.length, checkpoint_digest: digestBytes(malformed) }))
    .rejects.toThrow('manifest size mismatch')
})

test('partial large uploads never publish a ready checkpoint and resume with the same immutable pieces', async () => {
  const f = storage(), original = f.client
  const bytes = randomBytes(CLOUD_CHUNK_BYTES * 2)
  // A readback failure occurs before the manifest/state publication.
  const verify = original['downloadKey'].bind(original)
  let attempts = 0
  original['downloadKey'] = async (key, size) => { if (++attempts === 2) throw new CloudHandoffError(503, 'download'); return verify(key, size) }
  await expect(original.publish(h, bytes, null)).rejects.toThrow('503')
  expect(f.counts().publications).toBe(0)
  original['downloadKey'] = verify
  const ready = await original.publish(h, bytes, null)
  expect(Buffer.from(await original.download(ready))).toEqual(bytes)
  expect(f.counts().publications).toBe(1)
})
