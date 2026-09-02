import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { chmodSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore } from './job-runner.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; store: JobStore } {
  const root = mkdtempSync(join(tmpdir(), 'zero-thread-intent-store-'))
  chmodSync(root, 0o700)
  roots.push(root)
  return { root, store: new JobStore(join(root, 'jobs.sqlite3')) }
}

function stage(
  store: JobStore,
  messageId: string,
  threadTs = '1789000000.000001',
  chatId = 'C0THREAD1',
  promptVersion = 1,
) {
  const snapshotJson = JSON.stringify({ version: 1, messages: [{
    speaker: 'candidate', text: messageId, attachmentCount: 0, candidate: true,
  }] })
  return store.stageSlackThreadReplyIntent({
    chatId,
    threadTs,
    messageId,
    userId: 'U0ALICE',
    promptVersion,
    snapshotJson,
    inputDigest: createHash('sha256').update(snapshotJson).digest('hex'),
    createdAt: 1_789_000_100_000,
  })
}

describe('durable Slack thread reply intent ledger', () => {
  test('raw candidateは文脈取得前から永続化され、snapshot準備後だけclaimできる', () => {
    const { root, store } = fixture()
    const now = Date.now()
    const candidate = store.stageSlackThreadReplyCandidate({
      chatId: 'C0THREAD1',
      threadTs: '1789000000.000001',
      messageId: '1789000001.000001',
      userId: 'U0ALICE',
      promptVersion: 1,
      candidateText: 'この続き、進めて',
      fileIds: ['F001'],
      createdAt: now,
      notBefore: now + 750,
    })
    expect(candidate.snapshotJson).toBe('')
    expect(candidate.candidateText).toBe('この続き、進めて')
    expect(candidate.fileIds).toEqual(['F001'])
    expect(store.claimSlackThreadReplyIntent(candidate.idempotencyKey, now + 1_000)).toBeNull()
    expect(store.listDueSlackThreadReplyIntents(now + 1_000))
      .toHaveLength(1)
    store.close()

    const reopened = new JobStore(join(root, 'jobs.sqlite3'))
    const snapshotJson = JSON.stringify({ version: 1, messages: [{
      speaker: 'candidate', text: 'この続き、進めて', attachmentCount: 1, candidate: true,
    }] })
    reopened.prepareSlackThreadReplyIntent(candidate.idempotencyKey, {
      promptVersion: 1,
      snapshotJson,
      inputDigest: createHash('sha256').update(snapshotJson).digest('hex'),
    })
    expect(reopened.claimSlackThreadReplyIntent(candidate.idempotencyKey, now + 1_001)?.status)
      .toBe('processing')
    reopened.close()
  })

  test('duplicate経路と再起動で最初のsnapshotと決定を再利用する', () => {
    const { root, store } = fixture()
    const messageId = '1789000001.000001'
    const first = stage(store, messageId)
    const duplicate = stage(store, messageId)
    expect(duplicate.inputDigest).toBe(first.inputDigest)

    const claimed = store.claimSlackThreadReplyIntent(first.idempotencyKey, 1_789_000_200_000)
    expect(claimed?.status).toBe('processing')
    store.completeSlackThreadReplyIntent(first.idempotencyKey, 'addressed', 1_789_000_200_100)
    expect(store.hasDurableEvent(first.idempotencyKey)).toBe(false)
    store.close()

    const reopened = new JobStore(join(root, 'jobs.sqlite3'))
    expect(reopened.getSlackThreadReplyIntent(first.idempotencyKey)?.status).toBe('addressed')
    expect(reopened.claimSlackThreadReplyIntent(first.idempotencyKey)?.status).toBe('addressed')
    reopened.close()
  })

  test('prompt更新後も既存candidateを詰ませず最初のsnapshotを完了できる', () => {
    const { store } = fixture()
    const messageId = '1789000001.000001'
    const original = stage(store, messageId, undefined, undefined, 1)
    const afterUpgrade = stage(store, messageId, undefined, undefined, 2)
    expect(afterUpgrade.promptVersion).toBe(1)
    expect(afterUpgrade.inputDigest).toBe(original.inputDigest)
    expect(store.claimSlackThreadReplyIntent(original.idempotencyKey)).not.toBeNull()
    expect(store.completeSlackThreadReplyIntent(
      original.idempotencyKey,
      'addressed',
    ).status).toBe('addressed')
    store.close()
  })

  test('not-addressedは同一transactionで外部副作用なしのdurable tombstoneになる', () => {
    const { store } = fixture()
    const intent = stage(store, '1789000001.000001')
    expect(store.claimSlackThreadReplyIntent(intent.idempotencyKey)).not.toBeNull()
    const completed = store.completeSlackThreadReplyIntent(intent.idempotencyKey, 'ignored')
    expect(completed.status).toBe('ignored')
    expect(store.hasDurableEvent(intent.idempotencyKey)).toBe(true)
    expect(() => store.completeSlackThreadReplyIntent(intent.idempotencyKey, 'addressed')).toThrow()
    store.close()
  })

  test('同一threadはSlack順を守り、別threadの分類は塞がない', () => {
    const { store } = fixture()
    const first = stage(store, '1789000001.000001')
    const second = stage(store, '1789000002.000001')
    const other = stage(
      store,
      '1789000101.000001',
      '1789000100.000001',
      'C0THREAD2',
    )
    expect(store.claimSlackThreadReplyIntent(first.idempotencyKey)).not.toBeNull()
    expect(store.claimSlackThreadReplyIntent(second.idempotencyKey)).toBeNull()
    expect(store.claimSlackThreadReplyIntent(other.idempotencyKey)).not.toBeNull()
    store.completeSlackThreadReplyIntent(first.idempotencyKey, 'ignored')
    expect(store.claimSlackThreadReplyIntent(second.idempotencyKey)).not.toBeNull()
    store.close()
  })

  test('後発が先にstageされても、先発が揃えばSlack timestamp順を追い越さない', () => {
    const { store } = fixture()
    const second = stage(store, '1789000002.000001')
    const first = stage(store, '1789000001.000001')
    expect(store.claimSlackThreadReplyIntent(second.idempotencyKey)).toBeNull()
    expect(store.claimSlackThreadReplyIntent(first.idempotencyKey)).not.toBeNull()
    store.completeSlackThreadReplyIntent(first.idempotencyKey, 'ignored')
    expect(store.claimSlackThreadReplyIntent(second.idempotencyKey)).not.toBeNull()
    store.close()
  })

  test('addressed後にpolicy dropのtombstoneを記録すれば後続を解放する', () => {
    const { store } = fixture()
    const first = stage(store, '1789000001.000001')
    const second = stage(store, '1789000002.000001')
    expect(store.claimSlackThreadReplyIntent(first.idempotencyKey)).not.toBeNull()
    store.completeSlackThreadReplyIntent(first.idempotencyKey, 'addressed')
    expect(store.claimSlackThreadReplyIntent(second.idempotencyKey)).toBeNull()
    store.recordDeliveryTombstone(first.idempotencyKey)
    expect(store.claimSlackThreadReplyIntent(second.idempotencyKey)).not.toBeNull()
    store.close()
  })

  test('classifier障害はaccept/ignoreにせずbackoff後に同じsnapshotを再claimする', () => {
    const { store } = fixture()
    const intent = stage(store, '1789000001.000001')
    const now = Date.now()
    const claimed = store.claimSlackThreadReplyIntent(intent.idempotencyKey, now)
    expect(claimed?.attempts).toBe(1)
    expect(store.retrySlackThreadReplyIntent(
      intent.idempotencyKey,
      'Selected model is at capacity',
      now + 30_000,
    )).toBe(true)
    expect(store.claimSlackThreadReplyIntent(intent.idempotencyKey, now + 10_000)).toBeNull()
    const retried = store.claimSlackThreadReplyIntent(intent.idempotencyKey, now + 30_001)
    expect(retried?.attempts).toBe(2)
    expect(retried?.snapshotJson).toBe(intent.snapshotJson)
    expect(store.listDueSlackThreadReplyIntents(now + 30_001)
      .some(candidate => candidate.idempotencyKey === intent.idempotencyKey)).toBe(false)
    store.close()
  })

  test('未判定candidateがあればcatch-up初期化で履歴を飛ばさない', () => {
    const { store } = fixture()
    stage(store, '1789000001.000001')
    expect(store.initializeSlackCatchupFloorIfPristine(
      'A0123456789',
      1_789_000_200_000,
    )).toEqual({ created: false, floorMs: null })
    store.close()
  })
})
