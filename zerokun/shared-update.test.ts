import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { coordinateSharedUpdate, type SharedUpdateHooks } from './shared-update.ts'

test('all peers drain and stop before code changes, resume before locks release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-shared-update-'))
  const events: string[] = []
  const hooks: SharedUpdateHooks = {
    acquire: state => { events.push(`lock:${state}`); return { release: () => { events.push(`unlock:${state}`) } } },
    drain: async peer => { events.push(`drain:${peer.stateDir}`) },
    stop: async peer => { events.push(`stop:${peer.stateDir}`) },
    restart: async peer => { events.push(`start:${peer.stateDir}`) },
  }
  try {
    await coordinateSharedUpdate(root, [{ stateDir: 'b', projectDir: 'pb' }, { stateDir: 'a', projectDir: 'pa' }], hooks, async () => { events.push('update') })
    expect(events).toEqual(['lock:a', 'lock:b', 'drain:a', 'drain:b', 'stop:a', 'stop:b', 'update', 'start:a', 'start:b', 'unlock:b', 'unlock:a'])
    expect(existsSync(join(root, 'shared-update-peers.json'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('failed update resumes peers; failed resume persists intent and retry recovers without updating', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-shared-update-'))
  let starts = 0
  let failStart = true
  const hooks: SharedUpdateHooks = {
    acquire: () => ({ release() {} }), drain: async () => {}, stop: async () => {},
    restart: async () => { starts++; if (failStart) throw new Error('fixture restart failure') },
  }
  try {
    await expect(coordinateSharedUpdate(root, [{ stateDir: 'a', projectDir: 'pa' }], hooks, async () => { throw new Error('fixture update failure') })).rejects.toThrow('再起動記録')
    expect(existsSync(join(root, 'shared-update-peers.json'))).toBe(true)
    failStart = false
    let updated = false
    await expect(coordinateSharedUpdate(root, [], hooks, async () => { updated = true })).rejects.toThrow('復旧しました')
    expect(updated).toBe(false)
    expect(starts).toBe(2)
    expect(existsSync(join(root, 'shared-update-peers.json'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('stopped apps are locked but never started; source recovery precedes peer restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-shared-update-'))
  const events: string[] = []
  let restartFails = true
  const hooks: SharedUpdateHooks = {
    acquire: state => { events.push(`lock:${state}`); return { release() {} } },
    drain: async () => {}, stop: async peer => { events.push(`stop:${peer.stateDir}`) },
    restart: async peer => { events.push(`restart:${peer.stateDir}`); if (restartFails) throw new Error('fixture') },
    recover: async () => { events.push('recover-source') },
    validate: peer => { expect(peer.stateDir).toBe('active') },
  }
  try {
    await expect(coordinateSharedUpdate(root, [
      { stateDir: 'inactive', projectDir: 'p', running: false },
      { stateDir: 'active', projectDir: 'p' },
    ], hooks, async () => {})).rejects.toThrow('再起動記録')
    expect(events).toContain('lock:inactive')
    expect(events).not.toContain('stop:inactive')
    expect(events).not.toContain('restart:inactive')
    restartFails = false
    events.length = 0
    await expect(coordinateSharedUpdate(root, [], hooks, async () => {})).rejects.toThrow('復旧しました')
    expect(events).toEqual(['lock:active', 'stop:active', 'recover-source', 'restart:active'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('peer that starts during inventory is observed under lock and stopped before source switch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-shared-update-'))
  const events: string[] = []
  try {
    await coordinateSharedUpdate(root, [{ stateDir: 'a', projectDir: 'old', running: false }], {
      acquire: () => { events.push('locked'); return { release() {} } },
      observe: peer => { expect(events).toEqual(['locked']); return { ...peer, projectDir: 'current', running: true } },
      drain: async () => {},
      stop: async peer => { expect(peer.projectDir).toBe('current'); events.push('stopped') },
      restart: async peer => { expect(peer.projectDir).toBe('current'); events.push('restarted') },
    }, async () => { expect(events).toEqual(['locked', 'stopped']); events.push('updated') })
    expect(events).toEqual(['locked', 'stopped', 'updated', 'restarted'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('lock release failure does not prevent releasing the other app locks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-shared-update-'))
  const released: string[] = []
  try {
    await expect(coordinateSharedUpdate(root, ['a', 'b'].map(stateDir => ({ stateDir, projectDir: 'p', running: false })), {
      acquire: state => ({ release() { released.push(state); if (state === 'b') throw new Error('fixture') } }),
      drain: async () => {}, stop: async () => {}, restart: async () => {},
    }, async () => {})).rejects.toThrow('lock')
    expect(released).toEqual(['b', 'a'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a no-op recovery does not stop, restart or rewrite peer runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-shared-update-'))
  const events: string[] = []
  try {
    await coordinateSharedUpdate(root, [{ stateDir: 'a', projectDir: 'p', running: true }, { stateDir: 'b', projectDir: 'p', running: false }], {
      deferStop: true, acquire: () => ({ release() {} }), drain: async () => {},
      stop: async () => { events.push('stop') }, restart: async () => { events.push('start') },
      refresh: async peer => { events.push(`refresh:${peer.stateDir}`) },
    }, async () => { events.push('no-op') })
    expect(events).toEqual(['no-op'])
    expect(existsSync(join(root, 'shared-update-peers.json'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('recovery persists the live project observed under lock rather than an obsolete project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-shared-update-'))
  const hooks: SharedUpdateHooks = {
    acquire: () => ({ release() {} }), drain: async () => {}, stop: async () => {},
    restart: async () => { throw new Error('fixture restart failed') },
  }
  try {
    await expect(coordinateSharedUpdate(root, [{ stateDir: 'a', projectDir: 'old' }], hooks, async () => {})).rejects.toThrow('再起動記録')
    const resumed: string[] = []
    await expect(coordinateSharedUpdate(root, [], {
      ...hooks, observe: peer => ({ ...peer, projectDir: 'new', running: true }),
      restart: async peer => { resumed.push(peer.projectDir) },
    }, async () => {})).rejects.toThrow('復旧しました')
    expect(resumed).toEqual(['new'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
