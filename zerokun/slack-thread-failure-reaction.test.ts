import { WebClient } from '@slack/web-api'
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore, type SlackThreadFailureReaction } from './job-runner.ts'
import { createSlackThreadFailureReactionApplier, createSlackThreadFailureReactionDrainer } from './slack-thread-failure-reaction.ts'

const roots: string[] = []
const stores: JobStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zero-failure-reaction-'))
  roots.push(root)
  const path = join(root, 'jobs.sqlite3')
  const store = new JobStore(path)
  stores.push(store)
  const candidate = store.stageSlackThreadReplyCandidate({
    chatId: 'C0TEST', threadTs: '1789000000.000001', messageId: '1789000001.000001',
    userId: 'U0TEST', candidateText: '続けて', fileIds: ['F001'], promptVersion: 1,
  })
  const key = candidate.idempotencyKey
  const snapshotJson = '{"version":1,"messages":[]}'
  store.prepareSlackThreadReplyIntent(key, {
    promptVersion: 1, snapshotJson,
    inputDigest: createHash('sha256').update(snapshotJson).digest('hex'),
  })
  store.claimSlackThreadReplyIntent(key)
  const now = Date.now()
  const fail = () => store.deferSlackThreadReplyIntent(key, 'classifier unavailable', now + 60_000, true)
  const recover = (decision: 'addressed' | 'ignored') => {
    store.claimSlackThreadReplyIntent(key, now + 60_001)
    store.completeSlackThreadReplyIntent(key, decision)
  }
  return { root, path, store, key, now, fail, recover }
}
const slackError = (code: string) => ({ data: { error: code } })

describe('classifier failure reaction outbox', () => {
  test('normal ignored, lease waiting and hand-off retry do not create failure reactions', async () => {
    const f = fixture()
    expect(f.store.claimSlackThreadReplyIntent(f.key)).toBeNull()
    const calls: number[] = []
    const drain = createSlackThreadFailureReactionDrainer({ store: f.store, apply: async r => { calls.push(r.desired) } })
    await drain()
    f.store.deferSlackThreadReplyIntent(f.key, 'Slack replies/owned method budget exhausted', Date.now() + 30_000, false)
    await drain()
    expect(calls).toEqual([])
    f.store.claimSlackThreadReplyIntent(f.key, Date.now() + 30_001)
    f.store.completeSlackThreadReplyIntent(f.key, 'ignored')
    await drain()
    expect(calls).toEqual([])
    const g = fixture()
    g.store.completeSlackThreadReplyIntent(g.key, 'addressed')
    g.store.deferSlackThreadReplyIntent(g.key, 'handoff unconfirmed', Date.now() + 30_000, true)
    expect(g.store.listDueSlackThreadFailureReactions()).toEqual([])
  })

  for (const decision of ['addressed', 'ignored'] as const) {
    test(`failure preserves input and retry, then ${decision} removes only the recorded failure`, async () => {
      const f = fixture()
      const calls: number[] = []
      const drain = createSlackThreadFailureReactionDrainer({ store: f.store, apply: async r => { calls.push(r.desired) } })
      expect(f.fail()).toBe(true)
      await drain()
      f.fail()
      await drain()
      expect(calls).toEqual([1])
      expect(f.store.getSlackThreadReplyIntent(f.key)).toMatchObject({
        candidateText: '続けて', fileIds: ['F001'], status: 'pending', notBefore: f.now + 60_000,
      })
      f.recover(decision)
      await drain()
      expect(calls).toEqual([1, 0])
      expect(f.store.listDueSlackThreadFailureReactions()).toEqual([])
      expect(f.store.getSlackThreadReplyIntent(f.key)?.status).toBe(decision)
      expect(f.store.hasDurableEvent(f.key)).toBe(decision === 'ignored')
    })
  }

  test('add failure survives restart and already_reacted is idempotent', async () => {
    const f = fixture()
    f.fail()
    let now = f.now
    let attempts = 0
    const first = createSlackThreadFailureReactionDrainer({ store: f.store, now: () => now, apply: async () => {
      attempts++; throw slackError('ratelimited')
    } })
    await first()
    await first()
    expect(attempts).toBe(1)
    stores.splice(stores.indexOf(f.store), 1)
    f.store.close()
    const reopened = new JobStore(f.path)
    stores.push(reopened)
    now += 30_001
    const next = createSlackThreadFailureReactionDrainer({ store: reopened, now: () => now, apply: async () => {
      attempts++; throw slackError('already_reacted')
    } })
    await next()
    await next()
    expect(attempts).toBe(2)
    expect(reopened.listDueSlackThreadFailureReactions(now)).toEqual([])
  })

  test('ignored tombstone does not hide cleanup; removal failures retry after restart', async () => {
    const f = fixture()
    f.fail()
    let now = f.now
    const applied: number[] = []
    const drain = createSlackThreadFailureReactionDrainer({ store: f.store, now: () => now, apply: async r => {
      applied.push(r.desired)
      if (!r.desired) throw slackError('internal_error')
    } })
    await drain()
    f.recover('ignored')
    await drain()
    expect(f.store.listDueSlackThreadReplyIntents(now)).toEqual([])
    expect(f.store.hasDurableEvent(f.key)).toBe(true)
    stores.splice(stores.indexOf(f.store), 1)
    f.store.close()
    const reopened = new JobStore(f.path)
    stores.push(reopened)
    now += 30_001
    const next = createSlackThreadFailureReactionDrainer({ store: reopened, now: () => now, apply: async r => {
      applied.push(r.desired); throw slackError('no_reaction')
    } })
    await next()
    expect(applied).toEqual([1, 0, 0])
    expect(reopened.listDueSlackThreadFailureReactions(now)).toEqual([])
  })

  test('late add success cannot acknowledge a newer remove; overlapping drains join', async () => {
    const f = fixture()
    f.fail()
    let release!: () => void
    const pending = new Promise<void>(r => { release = r })
    const calls: number[] = []
    const drain = createSlackThreadFailureReactionDrainer({ store: f.store, apply: async r => {
      calls.push(r.desired)
      if (r.desired) await pending
    } })
    const first = drain()
    const second = drain()
    expect(first).toBe(second)
    f.recover('addressed')
    // Classification and durable admission settle even while Slack is stuck.
    expect(f.store.getSlackThreadReplyIntent(f.key)?.status).toBe('addressed')
    release()
    await first
    expect(calls).toEqual([1, 0])
    expect(f.store.listDueSlackThreadFailureReactions()).toEqual([])
  })

  test('late add failure cannot postpone cleanup and missing add needs idempotent remove', async () => {
    const f = fixture()
    f.fail()
    const calls: number[] = []
    const drain = createSlackThreadFailureReactionDrainer({ store: f.store, apply: async r => {
      calls.push(r.desired)
      if (r.desired) { f.recover('ignored'); throw slackError('timeout') }
      throw slackError('no_reaction')
    } })
    await drain()
    expect(calls).toEqual([1, 0])
    expect(f.store.listDueSlackThreadFailureReactions()).toEqual([])
  })

  test('GC retains ignored intents until the failed reaction has been removed', async () => {
    const f = fixture()
    f.fail()
    f.recover('ignored')
    const options = { stateDir: f.root, now: Date.now() + 10_000, retentionMs: 1, tombstoneRetentionMs: 2 }
    f.store.pruneSettled(options)
    expect(f.store.getSlackThreadReplyIntent(f.key)?.status).toBe('ignored')
    expect(f.store.listDueSlackThreadFailureReactions()).toHaveLength(1)
    await createSlackThreadFailureReactionDrainer({ store: f.store, apply: async () => {} })()
    f.store.pruneSettled(options)
    expect(f.store.getSlackThreadReplyIntent(f.key)).toBeNull()
  })

  test('GC keeps addressed delivery dedup while cleanup is pending, then prunes both', async () => {
    const f = fixture()
    f.fail()
    f.recover('addressed')
    f.store.recordDeliveryTombstone(f.key)
    const options = { stateDir: f.root, now: Date.now() + 10_000, retentionMs: 1, tombstoneRetentionMs: 2 }
    f.store.pruneSettled(options)
    expect(f.store.hasDurableEvent(f.key)).toBe(true)
    expect(f.store.listDueSlackThreadReplyIntents(options.now)).toEqual([])
    await createSlackThreadFailureReactionDrainer({ store: f.store, apply: async () => {} })()
    f.store.pruneSettled(options)
    expect(f.store.getSlackThreadReplyIntent(f.key)).toBeNull()
    expect(f.store.hasDurableEvent(f.key)).toBe(false)
    expect(f.store.listDueSlackThreadReplyIntents(options.now)).toEqual([])
  })

  test('deleted message finishes add/remove without permanent API retries', async () => {
    const f = fixture()
    f.fail()
    const calls: number[] = []
    let now = f.now
    const drain = createSlackThreadFailureReactionDrainer({ store: f.store, now: () => now, apply: async r => {
      calls.push(r.desired); throw slackError('message_not_found')
    } })
    await drain()
    now += 60_001
    f.fail()
    await drain()
    expect(calls).toEqual([1])
    f.recover('addressed')
    await drain()
    await drain()
    expect(calls).toEqual([1, 0])
    expect(f.store.listDueSlackThreadFailureReactions(now)).toEqual([])
  })

  test('crash after Slack add before receipt replays safely, and after recovery still removes', async () => {
    const f = fixture()
    f.fail()
    const unacknowledged = f.store.listDueSlackThreadFailureReactions()[0]!
    expect(unacknowledged.desired).toBe(1)
    stores.splice(stores.indexOf(f.store), 1)
    f.store.close()
    const reopened = new JobStore(f.path)
    stores.push(reopened)
    reopened.claimSlackThreadReplyIntent(f.key, f.now + 60_001)
    reopened.completeSlackThreadReplyIntent(f.key, 'ignored')
    reopened.settleSlackThreadFailureReaction(unacknowledged)
    const calls: SlackThreadFailureReaction[] = []
    await createSlackThreadFailureReactionDrainer({ store: reopened, apply: async r => { calls.push(r) } })()
    expect(calls.map(r => r.desired)).toEqual([0])
    expect(reopened.listDueSlackThreadFailureReactions()).toEqual([])
  })
})


test('a reaction 429 rejects promptly while the independent admission client proceeds', async () => {
  const f = fixture()
  f.fail()
  let reactionCalls = 0
  let contextCalls = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/reactions.add') {
      reactionCalls++
      return new Response('', { status: 429, headers: { 'retry-after': '60' } })
    }
    contextCalls++
    return Response.json({ ok: true, messages: [] })
  } })
  try {
    const slackApiUrl = `http://127.0.0.1:${server.port}/`
    const apply = createSlackThreadFailureReactionApplier('fixture-token', { slackApiUrl, timeout: 500 })
    const admission = new WebClient('fixture-token', { slackApiUrl, timeout: 500, retryConfig: { retries: 0 } })
    const drain = createSlackThreadFailureReactionDrainer({ store: f.store, apply })
    const started = Date.now()
    const [result] = await Promise.all([
      admission.conversations.replies({ channel: 'C0TEST', ts: '1789000000.000001' }), drain(),
    ])
    expect(result.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(reactionCalls).toBe(1)
    expect(contextCalls).toBe(1)
    expect(f.store.getSlackThreadReplyIntent(f.key)?.status).toBe('pending')
    expect(f.store.listDueSlackThreadFailureReactions(Date.now() + 31_000)).toHaveLength(1)
  } finally { server.stop(true) }
}, 3_000)
