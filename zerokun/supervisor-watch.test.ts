import { expect, test } from 'bun:test'
import { startProcessPolling, startSupervisorWatch } from './supervisor-watch.ts'
import { processStartKey, type ProcessIdentity, type ProcessGenerationProbe } from './process-generation.ts'

const bootSession = 'BE84ACC3-C5DA-44C5-A307-80213C085F2F'
function identity(pid: number): ProcessIdentity {
  const generation = { bootSession, startSec: 1000 + pid, startUsec: 0 }
  return { pid, ppid: 10, pgid: 10, status: 2, ...generation, started: processStartKey(generation) }
}
const supervisor = identity(10), child = identity(11), descendant = identity(12)
const delay = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
function fixture() {
  let actions = 0, now = 0, output = 0
  let receipt: Record<string, unknown> = { phase: 'active', directChild: child,
    tracked: [supervisor, child] }
  const states = new Map<number, ProcessGenerationProbe>([
    [10, { status: 'alive', identity: supervisor }], [11, { status: 'dead', reason: 'missing' }],
    [12, { status: 'dead', reason: 'missing' }],
  ])
  const stop = startSupervisorWatch({ supervisor, readRegistration: () => receipt,
    observe: value => states.get(value.pid) ?? { status: 'unknown' },
    onStalled: () => { actions++ }, outputRevision: () => output, intervalMs: 1, graceMs: 30, now: () => now })
  return { states, stop, output: () => { output++ }, actions: () => actions, advance: (ms: number) => { now += ms },
    setReceipt: (value: Record<string, unknown>) => { receipt = value } }
}

test('independent periodic watch claims a continuously dead tree exactly once', async () => {
  const f = fixture()
  try { await delay(); f.advance(31); await delay(); expect(f.actions()).toBe(1)
    f.advance(100); await delay(); expect(f.actions()).toBe(1) } finally { f.stop() }
})

test('quiet live child, unknown generation and live descendants are never timed out', async () => {
  for (const mode of ['live', 'unknown', 'descendant'] as const) {
    const f = fixture()
    if (mode === 'live') f.states.set(11, { status: 'alive', identity: child })
    if (mode === 'unknown') f.states.set(11, { status: 'unknown' })
    if (mode === 'descendant') {
      f.states.set(12, { status: 'alive', identity: descendant })
      f.setReceipt({ phase: 'active', directChild: child, tracked: [supervisor, child, descendant] })
    }
    try { await delay(); f.advance(100000); await delay(); expect(f.actions()).toBe(0) }
    finally { f.stop() }
  }
})

test('uncertain observations reset continuous death evidence', async () => {
  const f = fixture()
  try {
    await delay(); f.advance(20); f.states.set(11, { status: 'unknown' }); await delay()
    f.advance(100); f.states.set(11, { status: 'dead', reason: 'missing' }); await delay()
    expect(f.actions()).toBe(0); f.advance(31); await delay(); expect(f.actions()).toBe(1)
  } finally { f.stop() }
})

test('missing receipt, completed cleanup, invalid child and reused supervisor do not authorize recovery', async () => {
  for (const receipt of [{}, { phase: 'cleanup-confirmed', directChild: child, tracked: [supervisor] },
    { phase: 'active', directChild: { pid: 11, started: 'invalid' }, tracked: [supervisor] }]) {
    const f = fixture(); f.setReceipt(receipt)
    try { await delay(); f.advance(100); await delay(); expect(f.actions()).toBe(0) } finally { f.stop() }
  }
  const f = fixture(); f.states.set(10, { status: 'dead', reason: 'reused' })
  try { await delay(); f.advance(100); await delay(); expect(f.actions()).toBe(0) } finally { f.stop() }
})

test('stopped polling has no sleeping continuation to join or late callback', async () => {
  let ticks = 0
  const stop = startProcessPolling(() => { ticks++ }, error => { throw error }, 1)
  await delay(); stop(); const count = ticks; await delay(); expect(ticks).toBe(count)
})


test('continued output drain resets the dead-tree grace', async () => {
  const f = fixture()
  try {
    await delay(); f.advance(31); f.output(); await delay(); expect(f.actions()).toBe(0)
    f.advance(31); f.output(); await delay(); expect(f.actions()).toBe(0)
    f.advance(31); await delay(); expect(f.actions()).toBe(1)
  } finally { f.stop() }
})
