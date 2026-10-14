import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HostedCodexAdvisors, hostedAdvisorObservations } from './hosted-codex-advisor.ts'
import { AdvisorOwnedProcessStillLiveError } from './advisor-broker.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(mode: 'complete' | 'missing-marker' | 'failed' | 'truncated' | 'crashed') {
  const root = mkdtempSync(join(tmpdir(), 'zero-hosted-codex-')); roots.push(root)
  const contextPath = join(root, 'context.json'), attemptNonce = 'a'.repeat(32)
  let launches = 0
  const run = async ({ registration, onSpawn }: Parameters<ConstructorParameters<typeof HostedCodexAdvisors>[2]>[0]) => {
    launches += 1; onSpawn(process.pid)
    if (mode === 'crashed') await new Promise(() => {})
    return { exitCode: mode === 'failed' ? 1 : 0, forcedCleanup: false, outputTruncated: mode === 'truncated',
      stdout: [{ type: 'thread.started', thread_id: 'a1111111-1111-4111-8111-111111111111' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'Independent advice.\n' + (mode === 'missing-marker' ? '' : registration.marker) } },
        { type: mode === 'failed' ? 'turn.failed' : 'turn.completed' }].map(value => JSON.stringify(value)).join('\n') }
  }
  const request = { contextPath, attemptNonce, phase: 'investigation' as const, round: 1 as const,
    inputRevision: 1, inputDigest: 'b'.repeat(64), request: 'Read-only design of synthetic feature.' }
  return { contextPath, attemptNonce, request, run, advisor: new HostedCodexAdvisors(contextPath, attemptNonce, run), launches: () => launches }
}
test('one real host receipt binds native outcome, role, effort and original input across repeated calls', async () => {
  const f = fixture('complete')
  await f.advisor.start(f.request)
  const result = await f.advisor.poll('investigation', 1, 20)
  expect(result.complete).toBe(true)
  expect(result.nativeAdvisors![0]!.adopted).toBe(true)
  await f.advisor.start({ ...f.request, request: 'changed request', inputRevision: 2, inputDigest: 'c'.repeat(64) })
  expect(f.launches()).toBe(1)
  expect((await f.advisor.poll('investigation', 1)).inputRevision).toBe(1)
  await expect(f.advisor.verify('investigation', 1, result.nativeAdvisors)).resolves.toBeUndefined()
  const reordered = Object.fromEntries(Object.entries(result.nativeAdvisors![0]!).reverse())
  await expect(f.advisor.verify('investigation', 1, [reordered])).resolves.toBeUndefined()
  await expect(f.advisor.verify('investigation', 1, [{ ...reordered, response: 'forged' }])).rejects.toThrow('exact')
  expect(hostedAdvisorObservations(f.contextPath, f.attemptNonce)[0]!.state).toBe('response-obtained')
})
for (const mode of ['missing-marker', 'failed', 'truncated'] as const) test(`${mode} is unavailable rather than fabricated advisor success`, async () => {
  const f = fixture(mode); await f.advisor.start(f.request)
  const result = await f.advisor.poll('investigation', 1, 20)
  expect(result).toMatchObject({ complete: true, nativeAdvisors: [{ adopted: false, attempted: true, started: true }] })
  expect(hostedAdvisorObservations(f.contextPath, f.attemptNonce)[0]!.state).toBe('started-no-response')
})
test('broker restart after dispatch never creates a second reviewer', async () => {
  const f = fixture('crashed'); await f.advisor.start(f.request)
  const replacement = new HostedCodexAdvisors(f.contextPath, f.attemptNonce, f.run)
  const result = await replacement.start(f.request)
  expect(result).toMatchObject({ complete: true, nativeAdvisors: [{ adopted: false, started: true }] })
  expect(f.launches()).toBe(1)
})

test('observed live-process cleanup failure is not downgraded to an unavailable advisor', async () => {
  const f = fixture('complete')
  const advisor = new HostedCodexAdvisors(f.contextPath, f.attemptNonce, async ({ onSpawn }) => {
    onSpawn(process.pid)
    throw new AdvisorOwnedProcessStillLiveError('synthetic cleanup failure')
  })
  await advisor.start(f.request)
  await expect(advisor.poll('investigation', 1, 20)).rejects.toBeInstanceOf(AdvisorOwnedProcessStillLiveError)
  await expect(advisor.close()).rejects.toBeInstanceOf(AdvisorOwnedProcessStillLiveError)
  const replacement = new HostedCodexAdvisors(f.contextPath, f.attemptNonce, f.run)
  await expect(replacement.poll('investigation', 1)).rejects.toBeInstanceOf(AdvisorOwnedProcessStillLiveError)
  expect(f.launches()).toBe(0)
})
