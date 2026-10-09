import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { requestAdvisorStop, watchAdvisorStopRequest, waitForAdvisorSettlement } from './advisor-settlement.ts'
import { GROK_REVIEW_TIMEOUT_MS, GROK_OAUTH_TIMEOUT_MS, ADVISOR_SETTLEMENT_TIMEOUT_MS } from './advisor-timeouts.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'zero-advisor-settlement-')); roots.push(stateDir)
  const options = { stateDir, jobId: 'synthetic', attemptNonce: 'a'.repeat(32),
    processNonce: 'b'.repeat(32), contextDigest: 'c'.repeat(64), interrupted: () => false, pollMs: 2, timeoutMs: 2000 }
  const root = join(stateDir, 'advisor-journal', options.jobId, options.attemptNonce)
  const revision = join(root, 'revision-1-' + 'd'.repeat(16)); mkdirSync(revision, { recursive: true, mode: 0o700 })
  const lock = join(root, 'active-round.lock'), journal = join(revision, 'investigation-1.json')
  const record = { version: 2, jobId: options.jobId, attemptNonce: options.attemptNonce,
    processNonce: options.processNonce, contextDigest: options.contextDigest,
    inputRevision: 1, inputDigest: 'd'.repeat(64), phase: 'investigation', round: 1, brokerProcessId: process.pid }
  const write = (status: string) => writeFileSync(journal, JSON.stringify({ ...record, status }), { mode: 0o600 })
  writeFileSync(lock, JSON.stringify(record), { mode: 0o600 }); write('requested')
  return { options, lock, journal, write }
}
test('正常な親ターン終了でも稼働中のadvisorが終端になるまでreapしない', async () => {
  const f = fixture(); let finished = false
  const waiting = waitForAdvisorSettlement(f.options).then(value => { finished = true; return value })
  await Bun.sleep(20); expect(finished).toBe(false)
  f.write('reviewers-completed'); rmSync(f.lock); expect(await waiting).toBe('settled')
})
test('終了済みの欠員は回答を要求せず即settleする', async () => {
  const f = fixture(); f.write('required-reviewer-failed'); rmSync(f.lock)
  expect(await waitForAdvisorSettlement(f.options)).toBe('settled')
})
test('明示キャンセルは稼働中のadvisor待機を解除する', async () => {
  const f = fixture(); let interrupted = false
  const waiting = waitForAdvisorSettlement({ ...f.options, interrupted: () => interrupted })
  await Bun.sleep(10); interrupted = true
  expect(await waiting).toBe('interrupted')
})
test('別generation、壊れた状態、broker終了は本作業を待機させない', async () => {
  const f = fixture()
  expect(await waitForAdvisorSettlement({ ...f.options, processNonce: 'e'.repeat(32) })).toBe('unavailable')
  const validLock = await Bun.file(f.lock).text()
  writeFileSync(f.lock, 'invalid', { mode: 0o600 })
  expect(await waitForAdvisorSettlement(f.options)).toBe('unavailable')
  f.write('requested'); const lock = JSON.parse(validLock); lock.brokerProcessId = 2147483647
  writeFileSync(f.lock, JSON.stringify(lock), { mode: 0o600 })
  expect(await waitForAdvisorSettlement(f.options)).toBe('unavailable')
})
test('明示したprobe期限だけ上限を返し、稼働中processやjournal自体は操作しない', async () => {
  const f = fixture()
  expect(await waitForAdvisorSettlement({ ...f.options, timeoutMs: 5 })).toBe('timeout')
  expect(JSON.parse(await Bun.file(f.journal).text()).status).toBe('requested')
  rmSync(f.lock); expect(await waitForAdvisorSettlement(f.options)).toBe('settled')
})

test('既定待機も期限で終了しlive reviewerやlockを直接変更しない', async () => {
  const f = fixture()
  const originalNow = Date.now
  let finished = false
  try {
    const waiting = waitForAdvisorSettlement({ ...f.options, timeoutMs: undefined })
      .then(value => { finished = true; return value })
    Date.now = () => originalNow() + 3 * 60 * 60_000
    await Bun.sleep(20)
    expect(await waiting).toBe('timeout')
    expect(JSON.parse(await Bun.file(f.journal).text()).status).toBe('requested')
    expect(await Bun.file(f.lock).exists()).toBe(true)
  } finally { Date.now = originalNow }
})

test('親の既定待機はGrokの1時間と認証復旧後の1時間を途中で打ち切らない', async () => {
  const f = fixture()
  const originalNow = Date.now
  let finished = false
  const waiting = waitForAdvisorSettlement({ ...f.options, timeoutMs: undefined })
    .then(value => { finished = true; return value })
  try {
    for (const elapsed of [31 * 60_000, GROK_REVIEW_TIMEOUT_MS,
      2 * GROK_REVIEW_TIMEOUT_MS + GROK_OAUTH_TIMEOUT_MS]) {
      Date.now = () => originalNow() + elapsed
      await Bun.sleep(15)
      expect(finished).toBe(false)
    }
    expect(ADVISOR_SETTLEMENT_TIMEOUT_MS).toBeGreaterThan(
      2 * GROK_REVIEW_TIMEOUT_MS + GROK_OAUTH_TIMEOUT_MS)
    rmSync(f.lock)
    expect(await waiting).toBe('settled')
  } finally {
    rmSync(f.lock, { force: true })
    Date.now = originalNow
    await waiting
  }
})

test.each(['old-generation', 'same-generation'] as const)('新しいactive lockと古いterminal journalが共存しても早期終了しない: %s', async kind => {
  const f = fixture()
  const stale = { ...JSON.parse(await Bun.file(f.journal).text()), status: 'required-reviewer-failed',
    ...(kind === 'old-generation' ? { processNonce: 'e'.repeat(32) } : {}) }
  writeFileSync(f.journal, JSON.stringify(stale), { mode: 0o600 })
  let finished = false
  const waiting = waitForAdvisorSettlement(f.options).then(value => { finished = true; return value })
  await Bun.sleep(15); expect(finished).toBe(false)
  f.write('requested'); await Bun.sleep(15); expect(finished).toBe(false)
  f.write('reviewers-completed'); await Bun.sleep(15); expect(finished).toBe(false)
  rmSync(f.lock); expect(await waiting).toBe('settled')
})


test('親の終端要求は同一claimのbrokerを通知し、cleanupによるlock解放を待つ', async () => {
  const f = fixture(); const watcher = watchAdvisorStopRequest(f.lock, 2)
  try {
    watcher.signal.addEventListener('abort', () => {
      f.write('required-reviewer-failed'); rmSync(f.lock)
    }, { once: true })
    expect(await waitForAdvisorSettlement({ ...f.options, requestStop: true })).toBe('settled')
    expect(watcher.signal.aborted).toBe(true)
  } finally { watcher.close() }
})

test('前roundの停止要求と差し替わったclaimは新しいreviewerを停止しない', async () => {
  const f = fixture(); const old = await Bun.file(f.lock).text()
  requestAdvisorStop(f.lock)
  const next = { ...JSON.parse(old), claimNonce: 'next-round' }
  writeFileSync(f.lock, JSON.stringify(next), { mode: 0o600 })
  const watcher = watchAdvisorStopRequest(f.lock, 2)
  try {
    requestAdvisorStop(f.lock, old)
    await Bun.sleep(10); expect(watcher.signal.aborted).toBe(false)
    requestAdvisorStop(f.lock)
    await Bun.sleep(10); expect(watcher.signal.aborted).toBe(true)
  } finally { watcher.close() }
})
