import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CloudHandoffClient, type CloudHandoff } from './cloud-handoff.ts'
import { HandoffCoordinator, type HandoffJournal } from './handoff-coordinator.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const handoff: CloudHandoff = {
  id: '11111111-1111-4111-8111-111111111111', space_id: '22222222-2222-4222-8222-222222222222',
  owner_id: '33333333-3333-4333-8333-333333333333', epoch: 1, slack_team_id: 'T1',
  channel_id: 'C1', thread_ts: '1.0', state: 'saving', checkpoint_key: null,
  checkpoint_digest: null, checkpoint_bytes: null, reset_at: null, updated_at: new Date(0).toISOString(),
}
function fixture(remote: CloudHandoff) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-coordinator-')); roots.push(root)
  const calls: string[] = []
  const journal: HandoffJournal = {
    binding: () => ({ state: 'saving', receipt: JSON.stringify(handoff), packagePath: null }),
    bind: () => { calls.push('bind') }, park: () => { calls.push('park') },
    published: () => { calls.push('published') }, transferred: () => { calls.push('transferred') },
  }
  const client = new CloudHandoffClient({ version: 1, url: 'https://example.supabase.co',
    publishableKey: 'public-fixture-key-only', accessToken: 'fixture-access-token-only' },
  (async (_, init) => {
    calls.push(init?.method ?? 'GET')
    return Response.json([remote])
  }) as typeof fetch)
  return { coordinator: new HandoffCoordinator(client, journal, root), calls }
}
test('lost publish acknowledgement followed by takeover retires old save without uploading or capturing', async () => {
  const { coordinator, calls } = fixture({ ...handoff, epoch: 2, state: 'active',
    owner_id: '44444444-4444-4444-8444-444444444444' })
  await coordinator.pause('job', null, async () => { calls.push('quiesce') }, async () => {
    throw new Error('must not capture old work')
  })
  expect(calls).toEqual(['quiesce', 'park', 'GET', 'transferred'])
})
test('same-epoch owner mismatch does not pretend a transfer completed', async () => {
  const { coordinator, calls } = fixture({ ...handoff, owner_id: '44444444-4444-4444-8444-444444444444' })
  await expect(coordinator.pause('job', null, async () => {}, async () => {
    throw new Error('must not capture')
  })).rejects.toThrow('ownership changed')
  expect(calls).toEqual(['park', 'GET'])
})
test('failed writer shutdown cannot park or publish a checkpoint', async () => {
  const { coordinator, calls } = fixture(handoff)
  await expect(coordinator.pause('job', null, async () => { throw new Error('writer live') }, async () => {
    throw new Error('must not capture')
  })).rejects.toThrow('writer live')
  expect(calls).toEqual([])
})

test('quota reset is persisted before the first network request and retained across retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-reset-')); roots.push(root)
  let resetAt: number | null = null
  const journal: HandoffJournal = {
    binding: () => ({ state: 'saving', receipt: JSON.stringify(handoff), packagePath: null, resetAt }),
    park: (_id, reset) => { resetAt = reset }, bind() {}, published() {}, transferred() {},
  }
  const client = new CloudHandoffClient({ version: 1, url: 'https://example.supabase.co',
    publishableKey: 'public-fixture-key-only', accessToken: 'fixture-access-token-only' },
  (async () => { expect(resetAt).toBe(4_000_000_000_000); throw new Error('offline') }) as typeof fetch)
  const capture = async () => { throw new Error('must not capture before RPC') }
  await expect(new HandoffCoordinator(client, journal, root).pause('job', 4_000_000_000_000, async () => {}, capture)).rejects.toThrow('offline')
  await expect(new HandoffCoordinator(client, journal, root).pause('job', null, async () => {}, capture)).rejects.toThrow('offline')
  expect(resetAt).toBe(4_000_000_000_000)
})
