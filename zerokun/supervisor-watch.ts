import { observeProcessGeneration, parseProcessStartKey, type ProcessIdentity } from './process-generation.ts'

/** No wall-clock limit on live work: only a proven, continuously empty tree stalls. */
export function startSupervisorWatch(options: {
  supervisor: ProcessIdentity
  readRegistration: () => Record<string, unknown> | null
  onStalled: () => void
  outputRevision?: () => number
  observe?: typeof observeProcessGeneration
  intervalMs?: number
  graceMs?: number
  now?: () => number
}): () => void {
  const observe = options.observe ?? observeProcessGeneration
  const now = options.now ?? Date.now
  let deadSince: number | undefined
  let childKey: string | undefined
  let outputRevision = options.outputRevision?.() ?? 0
  let stopped = false
  const emptyTree = (): string | undefined => {
    if (observe(options.supervisor).status !== 'alive') return undefined
    // The caller verifies owner-only receipt, job, exact supervisor and policy.
    const receipt = options.readRegistration()
    if (!receipt || receipt.phase !== 'active') return undefined
    const child = receipt.directChild as { pid?: unknown; started?: unknown } | undefined
    if (!child || !Number.isSafeInteger(child.pid) || Number(child.pid) <= 1
      || child.pid === options.supervisor.pid || typeof child.started !== 'string') return undefined
    const generation = parseProcessStartKey(child.started)
    if (!generation || generation.bootSession !== options.supervisor.bootSession
      || generation.startSec < options.supervisor.startSec
      || (generation.startSec === options.supervisor.startSec
        && generation.startUsec < options.supervisor.startUsec)) return undefined
    if (observe({ pid: Number(child.pid), ...generation }).status !== 'dead') return undefined
    if (!Array.isArray(receipt.tracked)) return undefined
    for (const entry of receipt.tracked) {
      if (!entry || !Number.isSafeInteger(entry.pid) || entry.pid <= 1
        || typeof entry.started !== 'string') return undefined
      if (entry.pid === options.supervisor.pid && entry.started === options.supervisor.started) continue
      const pinned = parseProcessStartKey(entry.started)
      if (!pinned || observe({ pid: entry.pid, ...pinned }).status !== 'dead') return undefined
    }
    return `${child.pid}:${child.started}`
  }
  const stop = (): void => { stopped = true; clearInterval(timer) }
  const tick = (): void => {
    if (stopped) return
    try {
      const revision = options.outputRevision?.() ?? 0
      if (revision !== outputRevision) {
        outputRevision = revision
        deadSince = undefined
        childKey = undefined
      }
      const key = emptyTree()
      if (key === undefined) { deadSince = undefined; childKey = undefined; return }
      if (key !== childKey) { childKey = key; deadSince = now(); return }
      deadSince ??= now()
      if (now() - deadSince < (options.graceMs ?? 30_000)) return
      // Close the observation-to-action edge with the same verified receipt
      // and freshly observed process generations. Never signal a child PID.
      if (emptyTree() !== key) { deadSince = undefined; childKey = undefined; return }
      stop()
      options.onStalled()
    } catch {
      // Missing/unsafe/changing evidence is uncertainty, not permission to kill.
      deadSince = undefined
      childKey = undefined
    }
  }
  const timer = setInterval(tick, options.intervalMs ?? 5_000)
  timer.unref()
  return stop
}

/** Synchronous table scans can be stopped without awaiting a sleeping tracker. */
export function startProcessPolling(check: () => void, onError: (error: unknown) => void,
  intervalMs: number): () => void {
  let stopped = false
  const tick = (): void => {
    if (stopped) return
    try { check() } catch (error) { stopped = true; clearInterval(timer); onError(error) }
  }
  const timer = setInterval(tick, intervalMs)
  tick()
  return () => { stopped = true; clearInterval(timer) }
}
