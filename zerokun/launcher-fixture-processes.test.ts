import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import { FIXTURE_PROCESS_DIR, FIXTURE_STOPPING, reapFixtureHandles, recordFixtureProcess, recordedFixtureProcesses, stopRecordedFixtureProcesses, trackFixtureHandle } from './launcher-fixture-processes.ts'
import { observeProcessGeneration, readProcessIdentity, signalProcessIfLive } from './process-generation.ts'

const directories: string[] = []
const handles: Bun.Subprocess[] = []
afterEach(async () => {
  await reapFixtureHandles(handles.splice(0))
  for (const state of directories.splice(0)) {
    writeFileSync(join(state, FIXTURE_STOPPING), '')
    await stopRecordedFixtureProcesses(state)
    rmSync(state, { recursive: true, force: true })
  }
})
function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'owned-launcher-fixture-')); directories.push(state)
  mkdirSync(join(state, FIXTURE_PROCESS_DIR))
  return state
}
function timer(marker = '') {
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', "process.on('SIGTERM', () => {}); await Bun.sleep(30_000)", marker], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  handles.push(trackFixtureHandle(child))
  return child
}

test('same temporary-name argv does not authorize killing an unregistered process', async () => {
  const state = fixture()
  const owned = timer(), unrelated = timer(`unrelated-${basename(state)}-suffix`)
  const unrelatedIdentity = readProcessIdentity(unrelated.pid)!
  recordFixtureProcess(state, owned.pid)
  await stopRecordedFixtureProcesses(state)
  expect(observeProcessGeneration(readProcessIdentity(unrelated.pid)!).status).toBe('alive')
  expect(observeProcessGeneration(unrelatedIdentity).status).toBe('alive')
  await reapFixtureHandles([owned])
  expect(typeof await owned.exited).toBe('number')
})

test('old generation receipt cannot kill a new occupant of the same PID', async () => {
  const state = fixture(), child = timer()
  recordFixtureProcess(state, child.pid)
  const original = recordedFixtureProcesses(state)[0]!
  writeFileSync(join(state, FIXTURE_PROCESS_DIR, readdirSync(join(state, FIXTURE_PROCESS_DIR))[0]!), JSON.stringify({ ...original, startSec: original.startSec - 1 }))
  await stopRecordedFixtureProcesses(state)
  expect(observeProcessGeneration(original).status).toBe('alive')
})

test('TERM-ignoring timer is reaped with no child sleep process', async () => {
  const state = fixture(), child = timer()
  recordFixtureProcess(state, child.pid)
  const identity = recordedFixtureProcesses(state)[0]!
  await Bun.sleep(100)
  signalProcessIfLive(identity, 'SIGTERM')
  await Bun.sleep(30)
  expect(observeProcessGeneration(identity).status).toBe('alive')
  await stopRecordedFixtureProcesses(state)
  await reapFixtureHandles([child])
  expect(observeProcessGeneration(identity).status).toBe('dead')
})

test('bootstrap after cleanup begins exits instead of starting a timer', async () => {
  const state = fixture()
  writeFileSync(join(state, FIXTURE_STOPPING), '')
  const script = join(state, 'late.ts')
  writeFileSync(script, `import { recordFixtureProcess } from ${JSON.stringify(join(import.meta.dir, 'launcher-fixture-processes.ts'))}; recordFixtureProcess(${JSON.stringify(state)}); await Bun.sleep(30_000)`)
  const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'ignore' }); handles.push(trackFixtureHandle(child))
  const exit = await Promise.race([child.exited, Bun.sleep(1_000).then(() => 'timeout')])
  expect(exit).not.toBe('timeout')
  await stopRecordedFixtureProcesses(state)
})

test('late bootstrap cannot recreate a removed fixture directory', async () => {
  const state = fixture(), removed = join(state, 'removed')
  const script = join(state, 'late.ts')
  writeFileSync(script, `import { recordFixtureProcess } from ${JSON.stringify(join(import.meta.dir, 'launcher-fixture-processes.ts'))}; recordFixtureProcess(${JSON.stringify(removed)}); await Bun.sleep(30_000)`)
  const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'ignore' }); handles.push(trackFixtureHandle(child))
  const exit = await Promise.race([child.exited, Bun.sleep(1_000).then(() => 'timeout')])
  expect(exit).not.toBe('timeout')
  expect(existsSync(removed)).toBe(false)
})

test('handle reap has a deadline instead of waiting forever', async () => {
  const never = { exitCode: null, signalCode: null, kill: () => {}, exited: new Promise(() => {}) } as unknown as Bun.Subprocess
  await expect(reapFixtureHandles([never], 30)).rejects.toThrow('reap timed out')
})

test('registered child is recovered after its producer has exited', async () => {
  const state = fixture(), childScript = join(state, 'child.ts'), producerScript = join(state, 'producer.ts')
  const ready = join(state, 'child-ready')
  const release = join(state, 'producer-release')
  const registerImport = `import { recordFixtureProcess } from ${JSON.stringify(join(import.meta.dir, 'launcher-fixture-processes.ts'))};`
  writeFileSync(childScript, `${registerImport} import { writeFileSync } from 'fs'; recordFixtureProcess(${JSON.stringify(state)}); process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(ready)}, 'ready'); await Bun.sleep(30_000)`)
  writeFileSync(producerScript, `${registerImport} import { existsSync } from 'fs'; recordFixtureProcess(${JSON.stringify(state)}); const child = Bun.spawn([process.execPath, ${JSON.stringify(childScript)}], {stdin:'ignore', stdout:'ignore', stderr:'ignore', detached:true}); recordFixtureProcess(${JSON.stringify(state)}, child.pid); const deadline = Date.now() + 2000; while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) await Bun.sleep(10); process.exit(existsSync(${JSON.stringify(release)}) ? 0 : 1)`)
  const producer = Bun.spawn([process.execPath, producerScript], { stdout: 'ignore', stderr: 'ignore' }); handles.push(trackFixtureHandle(producer))
  const deadline = Date.now() + 2000
  while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10)
  expect(existsSync(ready)).toBe(true)
  const identities = recordedFixtureProcesses(state)
  expect(identities.length).toBe(2)
  expect(identities.every(identity => observeProcessGeneration(identity).status === 'alive')).toBe(true)
  writeFileSync(release, '')
  expect(await producer.exited).toBe(0)
  // --no-orphans may reap the child first. Without it, the ledger must recover
  // the orphan; in both modes no producer handle is needed to finish cleanup.
  writeFileSync(join(state, FIXTURE_STOPPING), '')
  await stopRecordedFixtureProcesses(state)
  expect(recordedFixtureProcesses(state).every(identity => observeProcessGeneration(identity).status === 'dead')).toBe(true)
})

// 2026-09-14: 一時directory名をargvに持つだけのprocessを掃除対象にする実装が
// 二度書かれ、二度とも無関係なprocessを巻き込む形だった。台帳が唯一の停止根拠で
// あることを、実装が戻された瞬間に赤くなる形で固定する。
test('launcher fixtureはcommand textから停止対象を選ばない', () => {
  const launcher = readFileSync(join(import.meta.dir, 'launcher.test.ts'), 'utf8')
  const ledger = readFileSync(join(import.meta.dir, 'launcher-fixture-processes.ts'), 'utf8')
  expect(launcher).toContain("from './launcher-fixture-processes.ts'")
  // 許すのは `/bin/ps -o <fmt>= -p <pid>` の単一PID再照合だけ。
  // process表を丸ごと引く手段は、外部commandでもこのrepo自身のAPIでも拒む。
  // readProcessTable() は proc_listallpids のラッパ(process-generation.ts)で、
  // launcher.test.ts は既に同じmoduleからimportしているため1語で到達できる。
  expect(launcher).not.toContain('strayPids')
  expect(launcher).not.toContain('reapFixtureDirectory')
  expect(launcher).not.toMatch(
    /pgrep|pkill|killall|readProcessTable|proc_listallpids|-xo|-ax|-ef|ps -A|ps -e/,
  )
  expect(ledger).toContain('Never discover kill targets by command text')
})
