import { expect, test } from 'bun:test'
import { observeClaudeStartupSnapshot, AdvisorOwnedProcessStillLiveError } from './advisor-broker.ts'

test.each([
  { exitCode: 1, timedOut: false, forcedCleanup: false, outputTruncated: false },
  { exitCode: null, timedOut: true, forcedCleanup: true, outputTruncated: false },
  { exitCode: 0, timedOut: false, forcedCleanup: false, outputTruncated: true },
])('snapshot補助処理の失敗後もstartupへ進める: %j', async result => {
  let calls = 0
  const diagnostic = await observeClaudeStartupSnapshot(async () => { calls++; return result })
  expect(diagnostic).toEqual({ outcome: 'command-failed', ...result })
  expect(calls).toBe(1)
})

test('snapshot例外の秘密本文を返さず、確認されたowned process残存だけは停止する', async () => {
  expect(await observeClaudeStartupSnapshot(async () => { throw new Error('private diagnostic') }))
    .toEqual({ outcome: 'exception' })
  const hazard = new AdvisorOwnedProcessStillLiveError('owned process remains live')
  await expect(observeClaudeStartupSnapshot(async () => { throw hazard })).rejects.toBe(hazard)
})

test('snapshot成功を成功として記録する', async () => {
  expect(await observeClaudeStartupSnapshot(async () => ({ exitCode: 0, timedOut: false,
    forcedCleanup: false, outputTruncated: false }))).toMatchObject({ outcome: 'completed', exitCode: 0 })
})
