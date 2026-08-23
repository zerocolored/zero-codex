export interface ProcessIdentity {
  pid: number
  ppid: number
  pgid: number
  started: string
}

const decoder = new TextDecoder()
const MAX_TRACKED_PROCESSES = 4_096

export function readProcessTable(): ProcessIdentity[] {
  if (process.platform === 'win32') return []
  const result = Bun.spawnSync(
    ['/bin/ps', '-ww', '-axo', 'pid=,ppid=,pgid=,lstart='],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  if (result.exitCode !== 0) throw new Error('process tableを取得できません')
  const scannerPid = result.pid
  return decoder.decode(result.stdout)
    .split('\n')
    .map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      started: match[4]!,
    }))
    .filter(entry => entry.pid !== scannerPid)
}

export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  return readProcessTable().find(entry => entry.pid === pid)
}

export function processIdentityIsLive(expected: ProcessIdentity): boolean {
  const current = readProcessIdentity(expected.pid)
  return current?.started === expected.started && current.pgid === expected.pgid
}

export function captureTrackedProcesses(
  rootPids: Iterable<number>,
  groupId: number,
  tracked: Map<number, string>,
  excludePids: ReadonlySet<number> = new Set(),
): ProcessIdentity[] {
  const table = readProcessTable()
  updateTrackedProcesses(table, rootPids, groupId, tracked, excludePids)
  return table
}

export function updateTrackedProcesses(
  table: readonly ProcessIdentity[],
  rootPids: Iterable<number>,
  groupId: number,
  tracked: Map<number, string>,
  excludePids: ReadonlySet<number> = new Set(),
): void {
  const current = new Map(table.map(entry => [entry.pid, entry.started]))
  const requestedRoots = new Set(rootPids)
  // Keep only live identities. Besides bounding the map by concurrent
  // processes (rather than lifetime churn), this prevents a recycled PID from
  // remaining a parent root. Requested roots retain their original identity
  // even after exit so a recycled numeric PID can never be adopted later.
  for (const [pid, started] of tracked) {
    if (current.get(pid) !== started && !requestedRoots.has(pid)) tracked.delete(pid)
  }
  for (const rootPid of requestedRoots) {
    if (!tracked.has(rootPid)) tracked.set(rootPid, current.get(rootPid) ?? '')
  }
  const roots = new Set<number>()
  for (const [pid, started] of tracked) {
    if (started !== '' && current.get(pid) === started) roots.add(pid)
  }
  // A numeric PGID can be reused after its leader exits. Only use the group as
  // a discovery root while the recorded leader identity is still alive.
  const groupStarted = tracked.get(groupId)
  const groupIsLive = (roots.has(groupId) && current.has(groupId))
    || (groupStarted !== undefined && current.get(groupId) === groupStarted)
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

function liveTrackedPids(
  tracked: ReadonlyMap<number, string>,
  excludePids: ReadonlySet<number>,
): number[] {
  const current = new Map(readProcessTable().map(entry => [entry.pid, entry.started]))
  return [...tracked]
    .filter(([pid, started]) => !excludePids.has(pid) && current.get(pid) === started)
    .map(([pid]) => pid)
}

function signalProcessGroup(groupId: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') return
  try { process.kill(-groupId, signal) } catch {}
}

function signalPids(pids: Iterable<number>, signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try { process.kill(pid, signal) } catch {}
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
}): Promise<number[]> {
  const exclude = options.excludePids ?? new Set<number>()
  const initialTable = captureTrackedProcesses(
    options.rootPids, options.groupId, options.tracked, exclude,
  )
  const groupStarted = options.tracked.get(options.groupId)
  const maySignalGroup = options.signalGroup !== false
    && groupStarted !== undefined
    && initialTable.some(entry => entry.pid === options.groupId && entry.started === groupStarted)
  if (maySignalGroup) signalProcessGroup(options.groupId, 'SIGTERM')
  signalPids(liveTrackedPids(options.tracked, exclude), 'SIGTERM')

  const termDeadline = Date.now() + (options.termGraceMs ?? 1_000)
  let live = liveTrackedPids(options.tracked, exclude)
  while (live.length > 0 && Date.now() < termDeadline) {
    await Bun.sleep(25)
    captureTrackedProcesses(options.rootPids, options.groupId, options.tracked, exclude)
    live = liveTrackedPids(options.tracked, exclude)
  }
  if (live.length === 0) return []

  if (maySignalGroup && live.includes(options.groupId)) {
    signalProcessGroup(options.groupId, 'SIGKILL')
  }
  signalPids(live, 'SIGKILL')
  const killDeadline = Date.now() + (options.killWaitMs ?? 1_000)
  while (live.length > 0 && Date.now() < killDeadline) {
    await Bun.sleep(25)
    captureTrackedProcesses(options.rootPids, options.groupId, options.tracked, exclude)
    live = liveTrackedPids(options.tracked, exclude)
  }
  return live
}
