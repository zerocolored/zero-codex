import { join } from 'path'
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { observeProcessGeneration, readProcessIdentity } from './process-generation.ts'

/** A successful parent turn must not reap a still-working reviewer. This is
 * lifecycle draining, not a response quorum: a terminal unavailable outcome
 * settles immediately, and cancellation/infrastructure failure never blocks. */
export async function waitForAdvisorSettlement(options: {
  stateDir: string
  jobId: string
  attemptNonce: string
  processNonce: string
  contextDigest: string
  interrupted: () => boolean
  timeoutMs?: number
  pollMs?: number
}): Promise<'settled' | 'interrupted' | 'unavailable' | 'timeout'> {
  const root = join(options.stateDir, 'advisor-journal',
    options.jobId.replace(/[^A-Za-z0-9._-]/g, '_'), options.attemptNonce)
  const deadline = Date.now() + (options.timeoutMs ?? 80 * 60_000)
  let broker: ReturnType<typeof readProcessIdentity>
  while (true) {
    if (options.interrupted()) return 'interrupted'
    try {
      const raw = readOptionalBoundedOwnerOnlyRegularFile(join(root, 'active-round.lock'), 64 * 1024)
      if (!raw) return 'settled'
      const lock = JSON.parse(raw)
      if (lock.version !== 2 || lock.jobId !== options.jobId
        || lock.attemptNonce !== options.attemptNonce || lock.processNonce !== options.processNonce
        || lock.contextDigest !== options.contextDigest
        || !Number.isSafeInteger(lock.inputRevision) || lock.inputRevision < 1
        || !/^[0-9a-f]{64}$/.test(lock.inputDigest)
        || !['investigation', 'design', 'review'].includes(lock.phase)
        || ![1, 2, 3].includes(lock.round)
        || !Number.isSafeInteger(lock.brokerProcessId) || lock.brokerProcessId <= 1) return 'unavailable'
      // The lock is acquired before the requested journal is rewritten. An
      // older terminal journal (even from this same generation) is therefore
      // not settlement evidence. Drain until the exact active claim releases.
      broker ??= readProcessIdentity(lock.brokerProcessId)
      if (!broker || broker.pid !== lock.brokerProcessId
        || observeProcessGeneration(broker).status !== 'alive') return 'unavailable'
    } catch { return 'unavailable' }
    if (Date.now() >= deadline) return 'timeout'
    await Bun.sleep(Math.min(options.pollMs ?? 500, Math.max(1, deadline - Date.now())))
  }
}
