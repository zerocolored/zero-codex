import {
  observeProcessGeneration,
  parseProcessStartKey,
  processIdentityIsLive,
  readProcessIdentity,
  readProcessTable,
  signalProcessGroupIfLeaderLive,
  signalProcessIfLive,
  type ProcessIdentity,
} from './process-generation.ts'

export {
  processIdentityIsLive,
  readProcessIdentity,
  readProcessTable,
  type ProcessIdentity,
}

export const MAX_TRACKED_PROCESSES = 4_096
export const MAX_EXECUTOR_REGISTRATION_BYTES = 512 * 1024

type ProcessGenerationObserver = typeof observeProcessGeneration

/**
 * Keep the durable recovery ledger aligned with the exact generations that
 * remain pinned by the live tracker. Confirmed-dead non-root generations no
 * longer require cleanup and retaining them forever would turn process churn
 * into an implicit lifetime limit for an otherwise unbounded job.
 */
export function synchronizeTrackedProcessLedger(
  tracked: ReadonlyMap<number, string>,
  ledger: Map<string, { pid: number; started: string }>,
): void {
  const currentKeys = new Set<string>()
  for (const [pid, started] of tracked) currentKeys.add(`${pid}:${started}`)
  for (const key of ledger.keys()) {
    if (!currentKeys.has(key)) ledger.delete(key)
  }
  for (const [pid, started] of tracked) {
    ledger.set(`${pid}:${started}`, { pid, started })
  }
  if (ledger.size > MAX_TRACKED_PROCESSES) {
    throw new Error(`追跡process数が上限${MAX_TRACKED_PROCESSES}を超えました`)
  }
}

/**
 * Pin a freshly spawned PID to its exact Darwin generation before it can
 * receive work. Callers use this as the root of every later table scan; an
 * unreadable root is cleanup uncertainty, never an empty wildcard.
 */
export function seedTrackedProcess(
  pid: number,
  tracked: Map<number, string>,
): ProcessIdentity {
  const identity = readProcessIdentity(pid)
  if (!identity) throw new Error(`spawned process ${pid}のgenerationを取得できません`)
  const existing = tracked.get(pid)
  if (existing !== undefined && existing !== identity.started) {
    throw new Error(`spawned process ${pid}のgenerationが既存追跡情報と一致しません`)
  }
  tracked.set(pid, identity.started)
  return identity
}

export function captureTrackedProcesses(
  rootPids: Iterable<number>,
  groupId: number,
  tracked: Map<number, string>,
  excludePids: ReadonlySet<number> = new Set(),
  generationObserver: ProcessGenerationObserver = observeProcessGeneration,
): ProcessIdentity[] {
  const table = readProcessTable()
  updateTrackedProcesses(
    table,
    rootPids,
    groupId,
    tracked,
    excludePids,
    generationObserver,
  )
  return table
}

export function updateTrackedProcesses(
  table: readonly ProcessIdentity[],
  rootPids: Iterable<number>,
  groupId: number,
  tracked: Map<number, string>,
  excludePids: ReadonlySet<number> = new Set(),
  generationObserver: ProcessGenerationObserver = observeProcessGeneration,
): void {
  const current = new Map(table.map(entry => [entry.pid, entry]))
  const requestedRoots = new Set(rootPids)
  const observed = new Map<number, ProcessIdentity>()
  // libproc may omit a live PID from one table scan. Absence is therefore not
  // death: re-probe every pinned generation directly before forgetting it.
  // Requested roots retain their original identity after exit so a recycled
  // numeric PID can never become a root.
  for (const [pid, started] of tracked) {
    const listed = current.get(pid)
    if (listed?.started === started) {
      observed.set(pid, listed)
      continue
    }
    const expected = expectedIdentity(pid, started)
    if (!expected) throw new Error(`process ${pid}のgenerationが不正です`)
    const direct = generationObserver(expected)
    if (direct.status === 'unknown') {
      // A short-lived child can disappear between the process-table scan and
      // its direct generation probe. Keep the exact pinned generation so the
      // next live scan can decide it, but do not use an unverified PID as a
      // discovery root. Strict cleanup re-probes every retained identity and
      // still fails closed if the generation remains unknown.
      continue
    }
    if (direct.status === 'alive') {
      observed.set(pid, direct.identity)
    } else if (!requestedRoots.has(pid)) {
      tracked.delete(pid)
    }
  }
  for (const rootPid of requestedRoots) {
    if (tracked.has(rootPid)) continue
    const identity = current.get(rootPid) ?? readProcessIdentity(rootPid)
    if (!identity) {
      throw new Error(`追跡root process ${rootPid}のgenerationを取得できません`)
    }
    tracked.set(rootPid, identity.started)
    observed.set(rootPid, identity)
  }
  const roots = new Set<number>()
  for (const [pid, identity] of observed) {
    if (tracked.get(pid) === identity.started) roots.add(pid)
  }
  // A numeric PGID can be reused after its leader exits. Only use the group as
  // a discovery root while the exact recorded leader generation is live.
  const groupStarted = tracked.get(groupId)
  const listedGroupLeader = observed.get(groupId)
  const groupLeader = listedGroupLeader?.pgid === groupId
    && listedGroupLeader.started === groupStarted
    ? listedGroupLeader
    : undefined
  const groupIsLive = groupLeader !== undefined
  let changed = true
  while (changed) {
    changed = false
    for (const entry of table) {
      if (excludePids.has(entry.pid) || tracked.has(entry.pid)) continue
      if ((groupIsLive && entry.pgid === groupId) || roots.has(entry.ppid)) {
        tracked.set(entry.pid, entry.started)
        if (tracked.size > MAX_TRACKED_PROCESSES) {
          throw new Error(`追跡process数が上限${MAX_TRACKED_PROCESSES}を超えました`)
        }
        roots.add(entry.pid)
        changed = true
      }
    }
  }
}

function expectedIdentity(pid: number, started: string): ProcessIdentity | undefined {
  const generation = parseProcessStartKey(started)
  if (!generation) return undefined
  return {
    pid,
    ppid: 0,
    pgid: 0,
    status: 0,
    ...generation,
    started,
  }
}

function liveTrackedIdentities(
  tracked: ReadonlyMap<number, string>,
  excludePids: ReadonlySet<number>,
  generationObserver: ProcessGenerationObserver = observeProcessGeneration,
): ProcessIdentity[] {
  const live: ProcessIdentity[] = []
  for (const [pid, started] of tracked) {
    if (excludePids.has(pid) || !started) continue
    const expected = expectedIdentity(pid, started)
    if (!expected) throw new Error(`process ${pid}のgenerationが不正です`)
    const observation = generationObserver(expected)
    if (observation.status === 'unknown') {
      throw new Error(`process ${pid}のgenerationを確認できません`)
    }
    if (observation.status === 'alive') live.push(observation.identity)
  }
  return live
}

function signalGroupLeader(
  expectedLeader: ProcessIdentity | undefined,
  signal: NodeJS.Signals,
  generationObserver: ProcessGenerationObserver = observeProcessGeneration,
): boolean {
  if (!expectedLeader) return false
  const observation = generationObserver(expectedLeader)
  if (observation.status === 'unknown') {
    throw new Error(`process group ${expectedLeader.pid}のgenerationを確認できません`)
  }
  if (observation.status === 'alive') {
    return signalProcessGroupIfLeaderLive(expectedLeader, signal)
  }
  return false
}

function signalIdentities(
  identities: Iterable<ProcessIdentity>,
  signal: NodeJS.Signals,
  generationObserver: ProcessGenerationObserver = observeProcessGeneration,
): void {
  for (const identity of identities) {
    if (signalProcessIfLive(identity, signal)) continue
    const observation = generationObserver(identity)
    if (observation.status === 'unknown') {
      throw new Error(`process ${identity.pid}のgenerationを確認できません`)
    }
  }
}

export async function reapTrackedProcesses(options: {
  rootPids: Iterable<number>
  groupId: number
  tracked: Map<number, string>
  excludePids?: ReadonlySet<number>
  termGraceMs?: number
  killWaitMs?: number
  signalGroup?: boolean
  /** Normal cleanup waits without a wall-clock limit until explicit force is requested. */
  waitForForce?: () => boolean
  /** Records that live exact generations reached the bounded KILL phase. */
  onForce?: () => void
  /** Deterministic process-generation probe used only by contract tests. */
  generationObserver?: ProcessGenerationObserver
}): Promise<number[]> {
  const exclude = options.excludePids ?? new Set<number>()
  const generationObserver = options.generationObserver ?? observeProcessGeneration
  const initialTable = captureTrackedProcesses(
    options.rootPids,
    options.groupId,
    options.tracked,
    exclude,
    generationObserver,
  )
  const groupStarted = options.tracked.get(options.groupId)
  const groupLeader = groupStarted
    ? initialTable.find(entry => entry.pid === options.groupId && entry.started === groupStarted)
    : undefined
  const termGroupSignaled = options.signalGroup !== false
    && signalGroupLeader(groupLeader, 'SIGTERM', generationObserver)
  signalIdentities(
    liveTrackedIdentities(options.tracked, exclude, generationObserver)
      .filter(identity => !termGroupSignaled || identity.pgid !== options.groupId),
    'SIGTERM',
    generationObserver,
  )

  let live = liveTrackedIdentities(options.tracked, exclude, generationObserver)
  if (options.waitForForce) {
    while (live.length > 0 && !options.waitForForce()) {
      await Bun.sleep(25)
      captureTrackedProcesses(
        options.rootPids,
        options.groupId,
        options.tracked,
        exclude,
        generationObserver,
      )
      live = liveTrackedIdentities(options.tracked, exclude, generationObserver)
    }
  } else {
    const termDeadline = Date.now() + (options.termGraceMs ?? 1_000)
    while (live.length > 0 && Date.now() < termDeadline) {
      await Bun.sleep(25)
      captureTrackedProcesses(
        options.rootPids,
        options.groupId,
        options.tracked,
        exclude,
        generationObserver,
      )
      live = liveTrackedIdentities(options.tracked, exclude, generationObserver)
    }
  }
  if (live.length === 0) return []

  options.onForce?.()
  // TERM-time observations are never reused for delayed KILL. Both helpers
  // perform a fresh microsecond-generation read immediately before signaling.
  const killGroupSignaled = options.signalGroup !== false
    && signalGroupLeader(groupLeader, 'SIGKILL', generationObserver)
  signalIdentities(
    live.filter(identity => !killGroupSignaled || identity.pgid !== options.groupId),
    'SIGKILL',
    generationObserver,
  )
  const killDeadline = Date.now() + (options.killWaitMs ?? 1_000)
  while (live.length > 0 && Date.now() < killDeadline) {
    await Bun.sleep(25)
    captureTrackedProcesses(
      options.rootPids,
      options.groupId,
      options.tracked,
      exclude,
      generationObserver,
    )
    live = liveTrackedIdentities(options.tracked, exclude, generationObserver)
  }
  return live.map(identity => identity.pid)
}
