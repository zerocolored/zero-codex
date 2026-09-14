/** Test-only ownership ledger. Never discover kill targets by command text. */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { observeProcessGeneration, readProcessIdentity, signalProcessIfLive, type ProcessIdentity } from './process-generation.ts'

export const FIXTURE_PROCESS_DIR = 'fixture-processes'
export const FIXTURE_STOPPING = 'fixture-stopping'
const handleGenerations = new WeakMap<Bun.Subprocess, ProcessIdentity>()

export function trackFixtureHandle(child: Bun.Subprocess): Bun.Subprocess {
  const identity = readProcessIdentity(child.pid)
  if (identity) handleGenerations.set(child, identity)
  return child
}

export function recordFixtureProcess(state: string, target: number | Bun.Subprocess = process.pid): void {
  const pid = typeof target === 'number' ? target : target.pid
  const identity = readProcessIdentity(pid)
  if (!identity) throw new Error('fixture process identity unavailable')
  if (typeof target !== 'number') handleGenerations.set(target, identity)
  const file = join(state, FIXTURE_PROCESS_DIR, `${pid}-${identity.startSec}-${identity.startUsec}.json`)
  // The test creates the registry before spawning. Do not recreate a deleted
  // fixture: a late bootstrap must fail/exit rather than create a new orphan.
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(identity), { flag: 'wx', mode: 0o600 })
  renameSync(temporary, file)
  if (existsSync(join(state, FIXTURE_STOPPING))) signalProcessIfLive(identity, 'SIGKILL')
}

export function recordedFixtureProcesses(state: string): ProcessIdentity[] {
  const directory = join(state, FIXTURE_PROCESS_DIR)
  return readdirSync(directory).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as ProcessIdentity)
}

export async function stopRecordedFixtureProcesses(state: string, pid?: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  do {
    const identities = recordedFixtureProcesses(state).filter(identity => pid === undefined || identity.pid === pid)
    for (const identity of identities) signalProcessIfLive(identity, 'SIGKILL')
    // Re-read after terminating producers; children can register while their
    // producer exits. The stopping marker handles bootstraps that arrive later.
    const remaining = recordedFixtureProcesses(state).filter(identity => pid === undefined || identity.pid === pid)
      .filter(identity => observeProcessGeneration(identity).status !== 'dead')
    if (!remaining.length) return
    await Bun.sleep(20)
  } while (Date.now() < deadline)
  throw new Error('owned fixture process cleanup timed out; fixture retained')
}

export async function reapFixtureHandles(children: Bun.Subprocess[], timeoutMs = 2_000): Promise<void> {
  for (const child of children) {
    const identity = handleGenerations.get(child)
    if (identity) signalProcessIfLive(identity, 'SIGKILL')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(children.map(child => child.exited)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture child reap timed out')), timeoutMs) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}
