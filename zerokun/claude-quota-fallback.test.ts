import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { withClaudeQuotaFallback, FABLE_ADVISOR_MODEL, OPUS_ADVISOR_MODEL } from './claude-quota-fallback.ts'
import { claudeRequestQuota } from './claude-response-diagnostic.ts'

const marker = 'REQUEST_MARKER=0123456789ABCDEF0123456789ABCDEF'
const capture = (quota: string) => `❯ Read the task\n${marker}\n⎿ You've reached your ${quota} limit.\n❯`
const rejected = { adopted: false, quotaScope: 'fable', cleanupVerified: true, containmentVerified: true,
  model: FABLE_ADVISOR_MODEL, failure: { advisor: 'claude', cause: 'rate-limit' } }

test('only explicit native current-turn Fable quota authorizes switching', () => {
  expect(claudeRequestQuota(capture('Fable'), marker)).toBe('fable')
  for (const quota of ['weekly', 'Opus', 'usage', 'weekly Fable']) {
    expect(claudeRequestQuota(capture(quota), marker)).toBe('other')
  }
  expect(claudeRequestQuota(capture('Fable').replace('⎿', '⏺'), marker)).toBeUndefined()
  expect(claudeRequestQuota(capture('Fable') + '\n' + marker, marker)).toBeUndefined()
})

test.each([true, false])('Fable rejection retries Opus once; result survives recreation (success=%s)', async adopted => {
  const root = mkdtempSync(join(tmpdir(), 'opus-fallback-test-'))
  try {
    const models: string[] = []
    let retires = 0
    const options = { path: join(root, 'fallback'), retire: () => { retires++ },
      run: async (model: string) => {
        models.push(model)
        if (model === FABLE_ADVISOR_MODEL) return rejected
        expect(JSON.parse(readFileSync(join(root, 'fallback'), 'utf8')).status).toBe('claimed')
        return { adopted, model, quotaScope: adopted ? undefined : 'fable', response: adopted ? 'complete answer' : undefined }
      } }
    const result = await withClaudeQuotaFallback(options)
    expect(models).toEqual([FABLE_ADVISOR_MODEL, OPUS_ADVISOR_MODEL])
    expect(retires).toBe(1)
    expect(result).toMatchObject({ adopted, fallbackFrom: FABLE_ADVISOR_MODEL, model: OPUS_ADVISOR_MODEL })
    expect(await withClaudeQuotaFallback(options)).toEqual(result)
    expect(models).toHaveLength(2)
  } finally { rmSync(root, { recursive: true }) }
})

test.each(['retire', 'run', 'after-delivery'])('interruption at %s never replays an Opus attempt', async point => {
  const root = mkdtempSync(join(tmpdir(), 'opus-fallback-test-'))
  try {
    const models: string[] = []
    const options = { path: join(root, 'fallback'),
      retire: () => { if (point === 'retire') throw new Error('interruption') },
      run: async (model: string) => {
        models.push(model)
        if (model === FABLE_ADVISOR_MODEL) return rejected
        throw new Error(point)
      } }
    await expect(withClaudeQuotaFallback(options)).rejects.toThrow()
    const before = [...models]
    const result = await withClaudeQuotaFallback(options)
    expect(result).toMatchObject({ adopted: false, failure: { cause: 'interrupted' }, promptMayHaveBeenDelivered: true })
    expect(models).toEqual(before)
  } finally { rmSync(root, { recursive: true }) }
})

test.each([{ adopted: true }, { quotaScope: 'other' }, { quotaScope: undefined },
  { cleanupVerified: false }, { containmentVerified: false }])('no fallback for accepted answer, non-Fable quota or uncontained attempt: %j', async change => {
  const root = mkdtempSync(join(tmpdir(), 'opus-fallback-test-'))
  try {
    let runs = 0
    const result = { ...rejected, ...change }
    expect(await withClaudeQuotaFallback({ path: join(root, 'fallback'), run: async () => { runs++; return result },
      retire: () => { throw new Error('unexpected retirement') } })).toEqual(result)
    expect(runs).toBe(1)
  } finally { rmSync(root, { recursive: true }) }
})
