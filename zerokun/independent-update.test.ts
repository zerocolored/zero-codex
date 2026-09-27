import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, renameSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { activateRelease, collectIndependentTargets, activateIndependentTargets, readReleaseTransaction, type ActivationHooks, type ReleaseTarget } from './independent-update.ts'
import { readRuntimeRelease, installLegacyCommands, runtimeCommandForState, RELEASE_JOURNAL, type RuntimeRelease } from './runtime-release.ts'
import { slackAppRegistryRoot } from './slack-app-registry.ts'
import { atomicWritePrivateFile } from './safe-file.ts'
import { checkAutomaticUpdate } from './auto-update.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'zero-release-test-'))); roots.push(home)
  const staging = join(home, 'staging'); mkdirSync(staging, { mode: 0o700 })
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: staging, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode) throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
  }
  git('init', '--quiet'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'release')
  const sha = git('rev-parse', 'HEAD')
  const release: RuntimeRelease = { version: 1, sha, path: join(slackAppRegistryRoot(home), 'releases', sha) }
  mkdirSync(join(slackAppRegistryRoot(home), 'releases'), { recursive: true, mode: 0o700 })
  renameSync(staging, release.path)
  atomicWritePrivateFile(join(release.path, '.zerochan-release.json'), JSON.stringify({ version: 1, sha: release.sha, ready: true }))
  const targets: ReleaseTarget[] = ['BSB', 'FUNE', 'PGIT'].map(name => {
    const stateDir = join(home, name); mkdirSync(stateDir, { mode: 0o700 })
    return { stateDir, projectDir: home, oldRoot: join(home, 'old-release'), running: true }
  })
  const events: string[] = []; const locks = new Set<string>()
  const hooks: ActivationHooks = {
    home,
    acquire: state => { if (locks.has(state)) throw new Error('busy'); locks.add(state); return { release() { locks.delete(state) } } },
    observe: t => t,
    drain: async t => { events.push(`drain:${t.stateDir}`) },
    stop: async t => { events.push(`stop:${t.stateDir}`) },
    install: async (t, root) => { events.push(`install:${t.stateDir}:${root}`) },
    start: async (t, root) => { events.push(`start:${t.stateDir}:${root}`) },
    healthy: async t => { events.push(`healthy:${t.stateDir}`) },
  }
  return { home, release, targets, hooks, events, locks }
}

test('BSB running does not delay FUNE/PGIT activation or their queued work', async () => {
  const f = fixture(); let finish!: () => void
  const wait = new Promise<void>(resolve => { finish = resolve })
  f.hooks.drain = async t => { if (t.stateDir === f.targets[0]!.stateDir) await wait }
  const queues = f.targets.map(t => {
    const db = new Database(join(t.stateDir, 'jobs.sqlite3'))
    db.run('CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT)'); db.run("INSERT INTO jobs VALUES (1, 'queued')")
    return db
  })
  f.hooks.healthy = async t => {
    // Actual job claims remain barred during activation. The caller observes
    // readiness; processing resumes after the transaction and lock are gone.
    expect(existsSync(join(t.stateDir, RELEASE_JOURNAL))).toBe(true)
  }
  const work = activateIndependentTargets(f.targets, f.release, f.hooks)
  for (let n = 0; n < 100 && !readRuntimeRelease(f.targets[1]!.stateDir, f.home); n++) await Bun.sleep(5)
  await Bun.sleep(10)
  expect(f.locks.has(f.targets[0]!.stateDir)).toBe(true)
  for (const index of [1, 2]) {
    const state = f.targets[index]!.stateDir
    expect(f.locks.has(state)).toBe(false)
    expect(readRuntimeRelease(state, f.home)?.sha).toBe(f.release.sha)
    expect(existsSync(join(state, RELEASE_JOURNAL))).toBe(false)
    queues[index]!.run("UPDATE jobs SET status='completed' WHERE id=1")
    expect(queues[index]!.query('SELECT status FROM jobs').get()).toEqual({ status: 'completed' })
  }
  expect(readRuntimeRelease(f.targets[0]!.stateDir, f.home)).toBeNull()
  finish(); expect((await work).every(r => r.status === 'fulfilled')).toBe(true)
  queues.forEach(db => db.close())
})

test('one failed activation does not roll back a successful peer or discard intake', async () => {
  const f = fixture(); const bad = f.targets[0]!
  const db = new Database(join(bad.stateDir, 'jobs.sqlite3'))
  db.run('CREATE TABLE jobs(id INTEGER PRIMARY KEY, status TEXT)')
  f.hooks.start = async (t, root) => {
    if (t === bad && root === f.release.path) { db.run("INSERT INTO jobs VALUES(1,'queued')"); throw new Error('candidate unhealthy') }
  }
  const result = await activateIndependentTargets(f.targets, f.release, f.hooks)
  expect(result.map(r => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
  expect(readRuntimeRelease(bad.stateDir, f.home)).toBeNull()
  expect(db.query('SELECT * FROM jobs').all()).toEqual([{ id: 1, status: 'queued' }]); db.close()
  expect(f.locks.size).toBe(0)
})

test('same release does not acquire lock or restart; stopped instance remains stopped', async () => {
  const f = fixture(); const t = { ...f.targets[0]!, running: false }
  expect(await activateRelease(t, f.release, f.hooks)).toBe('updated')
  expect(f.events.some(e => e.startsWith('start:'))).toBe(false)
  f.hooks.acquire = () => { throw new Error('same SHA must not pause queue') }
  expect(await activateRelease(t, f.release, f.hooks)).toBe('current')
})

test('crash recovery only touches the recorded instance and keeps unfinished recovery durable', async () => {
  const f = fixture(); const t = f.targets[0]!
  atomicWritePrivateFile(join(t.stateDir, RELEASE_JOURNAL), JSON.stringify({ version: 1, target: t, previous: null, candidate: f.release, phase: 'activated' }))
  f.hooks.install = async () => { throw new Error('disk unavailable') }
  await expect(activateRelease(t, f.release, f.hooks)).rejects.toThrow('disk unavailable')
  expect(readReleaseTransaction(t.stateDir, f.home)?.phase).toBe('rolling-back')
  expect(f.events.every(e => e.includes(t.stateDir))).toBe(true)
  f.hooks.install = async () => {}
  expect(await activateRelease(t, f.release, f.hooks)).toBe('recovered')
  expect(readReleaseTransaction(t.stateDir, f.home)).toBeNull()
})

test('independent automatic pending/failure state cannot suppress another app', async () => {
  const f = fixture(); const root = slackAppRegistryRoot(f.home)
  let calls = 0
  for (const t of f.targets) {
    const result = await checkAutomaticUpdate({ root, stateDir: t.stateDir, independent: true,
      detect: async () => f.release.sha,
      enqueue: async () => {
        calls++; atomicWritePrivateFile(join(t.stateDir, 'update-request.json'), JSON.stringify({ id: 'pending' }))
        return { accepted: true, request: { id: 'pending' } }
      },
    })
    expect(result).toBe('scheduled')
  }
  expect(calls).toBe(3)
})

test('waiting intent is durable without blocking control/intake via a transaction journal', async () => {
  const f = fixture(); const t = f.targets[0]!
  let finish!: () => void
  f.hooks.drain = () => new Promise(resolve => { finish = resolve })
  const pending = activateRelease(t, f.release, f.hooks)
  await Bun.sleep(5)
  expect(existsSync(join(t.stateDir, RELEASE_JOURNAL))).toBe(false)
  expect(readReleaseTransaction(t.stateDir, f.home)?.phase).toBe('waiting')
  finish(); await pending
  expect(existsSync(join(t.stateDir, 'release-target.json'))).toBe(false)
})

test('a cancelled drain releases only its own barrier without stopping a service', async () => {
  const f = fixture(); const t = f.targets[0]!
  f.hooks.drain = async () => { throw new Error('cancelled') }
  await expect(activateRelease(t, f.release, f.hooks)).rejects.toThrow('cancelled')
  expect(f.events).toEqual([])
  expect(f.locks.size).toBe(0)
  expect(readReleaseTransaction(t.stateDir, f.home)).toBeNull()
})

test('legacy CLI basename survives dispatch without modifying the old checkout', () => {
  const f = fixture(); const t = f.targets[0]!
  mkdirSync(t.oldRoot, { mode: 0o700 })
  const script = '#!/bin/bash\nprintf "%s:%s" "$(basename "$0")" "$1"\n'
  writeFileSync(join(t.oldRoot, 'codex-channel.sh'), script)
  atomicWritePrivateFile(join(t.stateDir, 'legacy-runtime.json'), JSON.stringify({ version: 1, path: t.oldRoot }))
  // An automatic update of a different app may not have prepared this state.
  for (const command of ['zerochan', 'zerokun', 'codex-channel']) {
    const path = runtimeCommandForState(t.stateDir, f.release.path, command)
    const child = Bun.spawnSync(['/bin/bash', path, 'status'], { stdout: 'pipe', stderr: 'pipe' })
    expect(child.exitCode).toBe(0); expect(child.stdout.toString()).toBe(`${command}:status`)
  }
  expect(readFileSync(join(t.oldRoot, 'codex-channel.sh'), 'utf8')).toBe(script)
})

test('candidate loss after activation does not prevent rollback to the retained runtime', async () => {
  const f = fixture(); const t = f.targets[0]!
  atomicWritePrivateFile(join(t.stateDir, RELEASE_JOURNAL), JSON.stringify({ version: 1, target: t, previous: null, candidate: f.release, phase: 'activated' }))
  rmSync(f.release.path, { recursive: true })
  expect(await activateRelease(t, f.release, f.hooks)).toBe('recovered')
  expect(f.events).toContain(`start:${t.stateDir}:${t.oldRoot}`)
  expect(readReleaseTransaction(t.stateDir, f.home)).toBeNull()
})

test('live storage migration retains its lease after the updater is killed', async () => {
  const { tryAcquireProcessLock, releaseProcessLock } = await import('./process-lock.ts')
  const { readProcessIdentity, signalProcessGroupIfLeaderLive } = await import('./process-generation.ts')
  const f = fixture(); const t = f.targets[0]!
  mkdirSync(join(t.oldRoot, 'zerokun'), { recursive: true, mode: 0o700 })
  const ready = join(f.home, 'migration-ready')
  writeFileSync(join(t.oldRoot, 'zerokun/job-runner.ts'), `import {writeFileSync} from 'fs'; writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},1000)`)
  const caller = join(f.home, 'caller.ts')
  writeFileSync(caller, `import {runInstanceMigrationForTests} from ${JSON.stringify(join(import.meta.dir, 'update.ts'))}; await runInstanceMigrationForTests(${JSON.stringify(t)})`)
  const parent = Bun.spawn([process.execPath, '--config=/dev/null', '--no-env-file', caller], { stdout: 'pipe', stderr: 'pipe' })
  let leader: ReturnType<typeof readProcessIdentity> = null
  try {
    for (let n = 0; n < 300 && !existsSync(ready); n++) await Bun.sleep(10)
    expect(existsSync(ready)).toBe(true)
    const identity = JSON.parse(readFileSync(join(t.stateDir, 'update.lock/pid.identity'), 'utf8'))
    leader = readProcessIdentity(identity.delegate.pid)
    expect(leader).not.toBeNull()
    parent.kill('SIGKILL'); await parent.exited
    const attempt = tryAcquireProcessLock(join(t.stateDir, 'update.lock/pid'))
    if (attempt.acquired) releaseProcessLock(join(t.stateDir, 'update.lock/pid'), attempt.lease)
    expect(attempt.acquired).toBe(false)
  } finally {
    if (leader) signalProcessGroupIfLeaderLive(leader, 'SIGKILL')
    try { parent.kill('SIGKILL') } catch {}
    await parent.exited
    for (let n = 0; n < 100; n++) {
      const attempt = tryAcquireProcessLock(join(t.stateDir, 'update.lock/pid'))
      if (attempt.acquired) { releaseProcessLock(join(t.stateDir, 'update.lock/pid'), attempt.lease); break }
      await Bun.sleep(20)
    }
  }
}, 10_000)

test('new target supersedes an interrupted older drain; recover-only never activates waiting intent', async () => {
  const f = fixture(); const t = f.targets[0]!
  const staging = join(f.home, 'second')
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode) throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
  }
  git(f.home, 'clone', '--no-local', f.release.path, staging)
  git(staging, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'new target')
  const sha = git(staging, 'rev-parse', 'HEAD')
  const newer: RuntimeRelease = { version: 1, sha, path: join(slackAppRegistryRoot(f.home), 'releases', sha) }
  renameSync(staging, newer.path)
  atomicWritePrivateFile(join(newer.path, '.zerochan-release.json'), JSON.stringify({ version: 1, sha, ready: true }))
  const intent = { version: 1, target: t, previous: null, candidate: f.release, phase: 'waiting' }
  atomicWritePrivateFile(join(t.stateDir, 'release-target.json'), JSON.stringify(intent))
  expect(await activateRelease(t, newer, f.hooks, true)).toBe('recovered')
  expect(f.events).toEqual([])
  atomicWritePrivateFile(join(t.stateDir, 'release-target.json'), JSON.stringify(intent))
  expect(await activateRelease(t, newer, f.hooks)).toBe('updated')
  expect(readRuntimeRelease(t.stateDir, f.home)?.sha).toBe(sha)
})

test('unfinished automatic activation observes cooldown and saves its request identity', () => {
  const f = fixture(); const t = f.targets[0]!
  atomicWritePrivateFile(join(t.stateDir, 'release-target.json'), JSON.stringify({ version: 1, target: t, previous: null, candidate: f.release, phase: 'waiting' }))
  const script = join(f.home, 'scheduler.ts')
  writeFileSync(script, `import {checkAutomaticUpdate} from ${JSON.stringify(join(import.meta.dir, 'auto-update.ts'))};
let calls=0; const options={root:${JSON.stringify(slackAppRegistryRoot(f.home))},stateDir:${JSON.stringify(t.stateDir)},independent:true,now:()=>100,detect:async()=>{throw Error('no remote needed')},enqueue:async()=>{calls++;return {accepted:true,request:{id:'saved'}}}};
const first=await checkAutomaticUpdate(options);const second=await checkAutomaticUpdate(options); console.log(JSON.stringify({first,second,calls}));`)
  const result = Bun.spawnSync([process.execPath, '--config=/dev/null', '--no-env-file', script], { env: { HOME: f.home, PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toEqual({ first: 'scheduled', second: 'not-due', calls: 1 })
  expect(JSON.parse(readFileSync(join(t.stateDir, 'auto-update-check.json'), 'utf8')).pendingId).toBe('saved')
})

test('manual request overrides an inherited instance-only update scope', async () => {
  const { requestUpdate, runUpdateWorker } = await import('./update-request.ts')
  const f = fixture(); const t = f.targets[0]!
  const receipt = join(f.home, 'scope'); const updater = join(f.home, 'fake-update.ts')
  writeFileSync(updater, `import {writeFileSync} from 'fs';writeFileSync(${JSON.stringify(receipt)},process.env.ZEROKUN_UPDATE_SCOPE??'missing')`)
  const pending = await requestUpdate({ chatId: 'C123', threadTs: '1.1', userId: 'U123', messageId: '1.2' }, {
    stateDir: t.stateDir, isWorkerRunning: () => false, isUpdateRunning: () => false, launchWorker: () => {},
  })
  const old = process.env.ZEROKUN_UPDATE_SCOPE; process.env.ZEROKUN_UPDATE_SCOPE = 'instance'
  try {
    const result = await runUpdateWorker(pending.request.id, { stateDir: t.stateDir, updaterPath: updater, notify: async () => {} })
    expect(result.success).toBe(true)
    expect(readFileSync(receipt, 'utf8')).toBe('all')
  } finally { if (old === undefined) delete process.env.ZEROKUN_UPDATE_SCOPE; else process.env.ZEROKUN_UPDATE_SCOPE = old }
})

test('a corrupt app journal is isolated during inventory and other apps still activate', async () => {
  const f = fixture(); const bad = f.targets[0]!
  atomicWritePrivateFile(join(bad.stateDir, RELEASE_JOURNAL), '{invalid')
  const inventory = collectIndependentTargets(f.targets.map(t => t.stateDir), state => {
    readReleaseTransaction(state, f.home)
    return f.targets.find(t => t.stateDir === state)
  })
  expect(inventory.unavailable).toHaveLength(1)
  expect(inventory.targets).toHaveLength(2)
  expect((await activateIndependentTargets(inventory.targets, f.release, f.hooks)).every(r => r.status === 'fulfilled')).toBe(true)
  expect(readFileSync(join(bad.stateDir, RELEASE_JOURNAL), 'utf8')).toBe('{invalid')
})

test('legacy request workers select the published independent controller', async () => {
  const { resolveUpdateController } = await import('./update-controller.ts')
  const f = fixture()
  const fallback = join(f.home, 'legacy/zerokun/update.ts')
  expect(resolveUpdateController(fallback, f.home)).toBe(fallback)
  atomicWritePrivateFile(join(slackAppRegistryRoot(f.home), 'update-controller.json'), JSON.stringify({ version: 1, sha: f.release.sha }))
  expect(resolveUpdateController(fallback, f.home)).toBe(join(f.release.path, 'zerokun/update.ts'))
  atomicWritePrivateFile(join(f.release.path, '.zerochan-release.json'), JSON.stringify({ version: 1, sha: f.release.sha, ready: false }))
  expect(() => resolveUpdateController(fallback, f.home)).toThrow('未検証')
})

test('state-only rollback installation preserves the frozen worker even when controller candidate is gone', async () => {
  const { runInstanceMigrationForTests } = await import('./update.ts')
  const f = fixture(); const t = f.targets[0]!
  mkdirSync(join(t.oldRoot, 'zerokun'), { recursive: true, mode: 0o700 })
  writeFileSync(join(t.oldRoot, 'zerokun/job-runner.ts'), 'process.exit(0)\n')
  writeFileSync(join(t.oldRoot, 'zerokun/codex-executor.ts'), '// old executor\n')
  writeFileSync(join(t.oldRoot, 'zerokun/watchdog.sh'), '#!/bin/bash\nexit 0\n')
  writeFileSync(join(t.stateDir, 'update-request.ts'), '// retained frozen worker\n')
  atomicWritePrivateFile(join(slackAppRegistryRoot(f.home), 'update-controller.json'), JSON.stringify({ version: 1, sha: f.release.sha }))
  rmSync(f.release.path, { recursive: true })
  const script = join(f.home, 'restore.ts')
  writeFileSync(script, `import {runInstanceMigrationForTests} from ${JSON.stringify(join(import.meta.dir, 'update.ts'))};await runInstanceMigrationForTests(${JSON.stringify(t)})`)
  const result = Bun.spawn([process.execPath, '--config=/dev/null', '--no-env-file', script], { env: { HOME: f.home, PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' })
  expect(await result.exited, await new Response(result.stderr).text()).toBe(0)
  expect(readFileSync(join(t.stateDir, 'update-request.ts'), 'utf8')).toBe('// retained frozen worker\n')
  expect(readFileSync(join(t.stateDir, 'watchdog.sh'), 'utf8')).toBe('#!/bin/bash\nexit 0\n')
})

test('a pinned app is not blocked by a different legacy checkout transaction', async () => {
  const { assertSharedSourceReady } = await import('./shared-update.ts')
  const f = fixture(); const t = f.targets[0]!
  await activateRelease(t, f.release, f.hooks)
  atomicWritePrivateFile(join(slackAppRegistryRoot(f.home), 'shared-update-owner.json'), JSON.stringify({ owner: { stateDir: t.stateDir } }))
  expect(() => assertSharedSourceReady(t.stateDir, f.home)).not.toThrow()
})
