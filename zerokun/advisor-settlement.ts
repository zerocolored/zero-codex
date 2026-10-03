import { join } from 'path'
import { createHash } from 'crypto'
import { lstatSync } from 'fs'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { observeProcessGeneration, readProcessIdentity } from './process-generation.ts'

// A stop request is tied to the exact active claim, never a PID or next round.
export function requestAdvisorStop(lockPath: string, expectedRaw?: string): void {
  const raw = readOptionalBoundedOwnerOnlyRegularFile(lockPath, 64 * 1024)
  if (!raw || (expectedRaw !== undefined && raw !== expectedRaw)) return
  const stat = lstatSync(lockPath)
  atomicWritePrivateFile(`${lockPath}.stop`, JSON.stringify({
    version: 1, dev: stat.dev, ino: stat.ino,
    digest: createHash('sha256').update(raw).digest('hex'),
  }))
}

export function watchAdvisorStopRequest(lockPath: string, pollMs = 500): {
  signal: AbortSignal; close(): void
} {
  const controller = new AbortController()
  const raw = readOptionalBoundedOwnerOnlyRegularFile(lockPath, 64 * 1024)
  const stat = lstatSync(lockPath)
  const digest = createHash('sha256').update(raw ?? '').digest('hex')
  const timer = setInterval(() => {
    try {
      const request = JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(`${lockPath}.stop`, 4096) ?? 'null')
      if (request?.version === 1 && request.dev === stat.dev && request.ino === stat.ino
        && request.digest === digest) controller.abort(new Error('parent turn finished; advisor unavailable'))
    } catch { /* Invalid or unavailable requests never authorize another target. */ }
  }, pollMs)
  timer.unref()
  return { signal: controller.signal, close: () => clearInterval(timer) }
}

export const ADVISOR_SETTLEMENT_TIMEOUT_MS = 30 * 60_000

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
  requestStop?: boolean
  timeoutMs?: number
  pollMs?: number
}): Promise<'settled' | 'interrupted' | 'unavailable' | 'timeout'> {
  const root = join(options.stateDir, 'advisor-journal',
    options.jobId.replace(/[^A-Za-z0-9._-]/g, '_'), options.attemptNonce)
  const deadline = Date.now() + (options.timeoutMs ?? ADVISOR_SETTLEMENT_TIMEOUT_MS)
  let stopRequested = false
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
      if (options.requestStop && !stopRequested) {
        requestAdvisorStop(join(root, 'active-round.lock'), raw)
        stopRequested = true
      }
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
