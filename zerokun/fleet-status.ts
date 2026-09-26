/** Public monitoring contract. Never include prompts, paths, logs or credentials. */
export type FleetState = 'available' | 'busy' | 'limited' | 'waiting' | 'unknown'
export class FleetSessionExpired extends Error {}
export interface FleetSnapshot {
  currentProject?: string | null
  state: FleetState
  project: string
  queued: number
  lastAcceptedAt: number | null
  summary: string | null
  summaryAt: number | null
  slackConnected: boolean
  runnerHealthy: boolean
}
export interface FleetLocalFacts {
  currentProject?: string | null
  occupiedElsewhere?: boolean
  running: number; queued: number; limited: boolean; approval: boolean; deferred: boolean
  lastAcceptedAt: number | null; summary: string | null; summaryAt: number | null
}

/** Only a public milestone, never local filesystem details. Null keeps the heartbeat usable. */
export function fleetSummaryWithoutPaths(text: string | null): string | null {
  // Do not infer path boundaries from the surrounding natural language. In
  // Japanese, an absolute path can directly follow a letter or quotation mark.
  // A slash-bearing milestone falls back to the state label, without affecting Slack.
  if (!text || text.includes('/') || text.includes('\\')) return null
  return text.slice(0, 700)
}

export function projectFleetStatus(facts: FleetLocalFacts, runtime: {
  project: string; slackConnected: boolean; runnerHealthy: boolean; paused: boolean
}): FleetSnapshot {
  const state: FleetState = !runtime.slackConnected || !runtime.runnerHealthy ? 'unknown'
    : facts.limited ? 'limited' : facts.running ? 'busy'
      : runtime.paused || facts.occupiedElsewhere || facts.queued > 0 || facts.deferred ? 'waiting' : 'available'
  return { state, project: runtime.project, queued: facts.queued,
    lastAcceptedAt: facts.lastAcceptedAt,
    summary: facts.running || facts.limited ? facts.summary : facts.approval ? '別タスクの画面案は承認待ちです' : null,
    summaryAt: facts.running || facts.limited ? facts.summaryAt : null,
    slackConnected: runtime.slackConnected, runnerHealthy: runtime.runnerHealthy }
}

/** One in-flight operation, no backlog, finite retry delay; failure never escapes. */
export function startFleetReporter(options: {
  snapshot: () => FleetSnapshot
  begin: () => Promise<number>
  send: (generation: number, sequence: number, snapshot: FleetSnapshot) => Promise<void>
  intervalMs?: number
  now?: () => number
}) {
  let generation: number | undefined
  let sequence = 0, failures = 0, nextAt = 0, stopped = false
  let lastSent = ''
  let pending: Promise<void> | undefined
  const now = options.now ?? Date.now
  const tick = () => {
    if (stopped || pending || (failures > 0 && now() < nextAt)) return pending ?? Promise.resolve()
    pending = Promise.resolve().then(async () => {
      let attempted = false
      try {
        const snapshot = options.snapshot(), serialized = JSON.stringify(snapshot)
        if (now() < nextAt && serialized === lastSent) return
        attempted = true
        generation ??= await options.begin()
        if (stopped) return
        await options.send(generation, ++sequence, snapshot)
        lastSent = serialized
        failures = 0
      } catch (error) {
        if (error instanceof FleetSessionExpired) { generation = undefined; sequence = 0 }
        attempted = true; failures = Math.min(failures + 1, 4)
      }
      finally {
        if (attempted) nextAt = now() + (options.intervalMs ?? 30_000) * 2 ** failures
      }
    }).finally(() => { pending = undefined })
    return pending
  }
  const timer = setInterval(() => { void tick() }, 5000)
  timer.unref?.()
  void tick()
  return { tick, stop() { stopped = true; clearInterval(timer) } }
}
