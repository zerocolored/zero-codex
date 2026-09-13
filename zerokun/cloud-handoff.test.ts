import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CloudHandoffClient, CLOUD_WAIT_MESSAGE, digestBytes, type CloudHandoff } from './cloud-handoff.ts'
import { JobStore } from './job-runner.ts'
import { buildCodexWorkerPrompt } from './codex-executor.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const h: CloudHandoff = { id: '11111111-1111-4111-8111-111111111111',
  space_id: '22222222-2222-4222-8222-222222222222', owner_id: '33333333-3333-4333-8333-333333333333',
  epoch: 1, slack_team_id: 'T1', channel_id: 'C1', thread_ts: '1.0', state: 'saving',
  checkpoint_key: null, checkpoint_digest: null, checkpoint_bytes: null, reset_at: null, updated_at: new Date(0).toISOString() }
test('observed quota survives a runner crash before cloud park', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-crash-test-')); roots.push(root)
  const path = join(root, 'jobs.sqlite3')
  let store = new JobStore(path)
  store.enqueue({ chatId: 'C1', threadTs: '1.0', messageId: '1.0', userId: 'U1', repoPath: root, task: 'task', writeEnabled: true })
  const job = store.claimNext('worker')!
  store.bindCloudHandoff(job.id, h.id, h.epoch, JSON.stringify({ ...h, state: 'active' }))
  store.recordCloudQuotaDetected(job.id, 123456)
  store.close(); store = new JobStore(path)
  expect(store.recoverInterrupted().requeued).toBe(1)
  expect(store.get(job.id)?.status).toBe('queued')
  expect(store.cloudHandoff(job.id)?.state).toBe('saving')
  expect(store.cloudHandoff(job.id)?.resetAt).toBe(123456)
  expect(store.claimNext('worker')).toBeNull()
  store.close()
})
test('pending import holds later same-thread execution but not unrelated work', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-fifo-test-')); roots.push(root)
  const store = new JobStore(join(root, 'jobs.sqlite3'))
  store.stageCloudControl({ channel: 'C1', thread: '1.0', message: '2.0', user: 'U1', bot: 'UBOT', project: root, writeEnabled: true, action: 'handoff' })
  const later = store.enqueue({ chatId: 'C1', threadTs: '1.0', messageId: '3.0', userId: 'U1', repoPath: root, task: 'later', writeEnabled: true })
  expect(store.hasEarlierPendingCloudControl('C1', '1.0', '3.0')).toBe(true)
  expect(store.hasEarlierPendingCloudControl('C1', '1.0', '2.0')).toBe(false)
  expect(store.claimNext('worker')).toBeNull()
  store.enqueue({ chatId: 'C2', threadTs: '1.0', messageId: '4.0', userId: 'U1', repoPath: root, task: 'unrelated', writeEnabled: true })
  expect(store.claimNext('worker')?.chatId).toBe('C2')
  expect(store.get(later.job.id)?.status).toBe('queued')
  store.close()
})
test('cloud parked jobs remain unclaimable after clock advance and database reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-wait-test-')); roots.push(root)
  mkdirSync(join(root, 'repo'))
  const path = join(root, 'state', 'jobs.sqlite3')
  let store = new JobStore(path)
  store.enqueue({ chatId: 'C1', threadTs: '1.0', messageId: '1.0', userId: 'U1',
    repoPath: join(root, 'repo'), task: 'task', writeEnabled: false })
  const job = store.claimNext('test')!
  const executionJob = { ...job, historyRepoPath: job.repoPath, repoPath: join(root, 'owned-workspace') }
  expect(() => buildCodexWorkerPrompt(executionJob, undefined, undefined, store.threadHistorySnapshot(job.id))).not.toThrow()
  expect(() => buildCodexWorkerPrompt({ ...executionJob, historyRepoPath: '/unrelated' }, undefined, undefined,
    store.threadHistorySnapshot(job.id))).toThrow('binding changed')
  store.bindCloudHandoff(job.id, h.id, h.epoch, JSON.stringify(h))
  store.recordCloudContext(job.id, 'message-1', '調査済み。未公開コミットはfeatureブランチに保持。')
  store.recordCloudContext(job.id, 'message-1', 'duplicate must not replace the captured output')
  expect(store.cloudHistory(job.id)).toContain('未公開コミットはfeatureブランチに保持')
  expect(store.cloudHistory(job.id)).not.toContain('duplicate must not')
  const resetAt = Date.now() + 3_600_000
  store.parkCloudHandoff(job.id, 'quota', resetAt)
  expect(store.countActive()).toBe(0)
  expect(store.activeCounts()).toEqual({ queued: 0, running: 0 })
  expect(store.claimNext('test', 1, Date.now() + 100000000)).toBeNull()
  store.close(); store = new JobStore(path)
  store.parkCloudHandoff(job.id, 'retry')
  expect(store.cloudHandoff(job.id)?.resetAt).toBe(resetAt)
  expect(store.claimableHeadId(Date.now() + 100000000)).toBeNull()
  expect(store.cloudHistory(job.id)).toContain('未公開コミットはfeatureブランチに保持')
  store.recordCloudCheckpoint(job.id, JSON.stringify({ ...h, state: 'waiting' }), '/local/checkpoint', CLOUD_WAIT_MESSAGE)
  store.recordCloudCheckpoint(job.id, JSON.stringify({ ...h, state: 'waiting' }), '/local/checkpoint', CLOUD_WAIT_MESSAGE)
  expect(store.pendingStatusNotifications().filter(n => n.payload === CLOUD_WAIT_MESSAGE)).toHaveLength(1)
  expect(store.cloudHandoff(job.id)?.state).toBe('waiting')
  expect(store.claimNext('test', 1, Date.now() + 100000000)).toBeNull()
  store.close()
})
test('preparation outage defers an unstarted job instead of failing it or consuming an attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-prepare-test-')); roots.push(root)
  mkdirSync(join(root, 'repo'))
  const store = new JobStore(join(root, 'state', 'jobs.sqlite3'))
  store.enqueue({ chatId: 'C1', threadTs: '1.0', messageId: '1.0', userId: 'U1',
    repoPath: join(root, 'repo'), task: 'task', writeEnabled: true })
  const job = store.claimNext('worker')!
  expect(store.deferCloudPreparation(job.id, 'worker')).toBe(true)
  expect(store.get(job.id)?.status).toBe('queued')
  expect(store.get(job.id)?.attempts).toBe(0)
  expect(store.claimNext('worker')).toBeNull()
  expect(store.pendingStatusNotifications()).toHaveLength(1)
  expect(store.claimNext('worker', 1, Date.now() + 120_000)?.id).toBe(job.id)
  store.close()
})
test('explicit handoff control survives gateway restart and is delivered once', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-control-test-')); roots.push(root)
  const path = join(root, 'jobs.sqlite3')
  let store = new JobStore(path)
  const input = { channel: 'C1', thread: '1.0', message: '2.0', user: 'U1', bot: 'UBOT',
    project: join(root, 'repo'), writeEnabled: false, action: 'handoff' as const }
  store.stageCloudControl(input)
  store.stageCloudControl(input)
  expect(store.hasDurableEvent('C1:2.0')).toBe(true)
  store.close(); store = new JobStore(path)
  expect(store.pendingCloudControls()).toEqual([{ eventId: 'C1:2.0', input }])
  expect(store.hasDurableEvent('C1:2.0')).toBe(true)
  store.retryCloudControl('C1:2.0', input)
  expect(store.pendingCloudControls()).toEqual([])
  expect(store.pendingCloudControls(Date.now() + 120_000)).toHaveLength(1)
  store.finishCloudControl('C1:2.0')
  expect(store.hasDurableEvent('C1:2.0')).toBe(true)
  expect(store.pendingCloudControls(Date.now() + 120_000)).toEqual([])
  store.close()
})
test('upload retry verifies immutable bytes before publishing ready', async () => {
  const calls: string[] = []
  const bytes = Buffer.from('{"version":1}')
  const client = new CloudHandoffClient({ version: 1, url: 'https://example.supabase.co', publishableKey: 'public-fixture-key-only', accessToken: 'fixture-access-token-only' },
    (async (input, init) => {
      const path = new URL(String(input)).pathname
      calls.push(`${init?.method}:${path}`)
      if (path.includes('/rpc/')) return Response.json({ ...h, state: 'waiting' })
      if (init?.method === 'POST') return new Response('already exists', { status: 409 })
      return new Response(bytes)
    }) as typeof fetch)
  expect((await client.publish(h, bytes, null)).state).toBe('waiting')
  expect(calls.length).toBe(3)
  expect(calls[1]).toContain(digestBytes(bytes))
  expect(calls[2]).toContain('/rpc/zerochan_checkpoint')
})
test('corrupt upload cannot publish ready', async () => {
  let published = false
  const client = new CloudHandoffClient({ version: 1, url: 'https://example.supabase.co', publishableKey: 'public-fixture-key-only', accessToken: 'fixture-access-token-only' },
    (async (input, init) => {
      if (String(input).includes('/rpc/')) { published = true; return Response.json(h) }
      return init?.method === 'POST' ? new Response('') : new Response('wrong')
    }) as typeof fetch)
  await expect(client.publish(h, Buffer.from('valid'), null)).rejects.toThrow('digest')
  expect(published).toBe(false)
})
test('import enqueue and owner binding commit atomically and duplicate events do not enqueue again', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-import-test-')); roots.push(root)
  mkdirSync(join(root, 'repo'))
  const store = new JobStore(join(root, 'state', 'jobs.sqlite3'))
  const input = { chatId: 'C1', threadTs: '1.0', messageId: '2.0', userId: 'U1',
    repoPath: join(root, 'repo'), task: 'resume', writeEnabled: false }
  const first = store.enqueueCloudImport(input, h.id, 2, JSON.stringify({ ...h, epoch: 2, state: 'active' }))
  const second = store.enqueueCloudImport(input, h.id, 2, JSON.stringify({ ...h, epoch: 2, state: 'active' }))
  expect(second.job.id).toBe(first.job.id)
  expect(second.duplicate).toBe(true)
  expect(store.cloudHandoff(first.job.id)?.epoch).toBe(2)
  expect(store.claimNext('worker')?.resumed).toBe(false)
  store.close()
})
