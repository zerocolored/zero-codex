import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { startManagedService, stopManagedService } from './service-control.ts'
import {
  acknowledgeServiceControlPauseIfRequested,
  clearIntentionalServiceStop,
  clearServiceControlPauseRequest,
  createServiceControlPauseRequest,
  intentionalServiceStopIsSet,
  serviceControlPauseAcknowledged,
  writeIntentionalServiceStop,
} from './service-control-state.ts'
import {
  herdrRuntimeFingerprint,
  readPinnedHerdrRuntime,
  writePinnedHerdrRuntime,
  type HerdrRuntimeIdentity,
} from './herdr-runtime.ts'
import { writeGatewayReadiness } from './readiness.ts'

const directories: string[] = []
const processes: Bun.Subprocess[] = []

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null) {
      try { child.kill('SIGKILL') } catch {}
      try { await child.exited } catch {}
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(): { base: string; state: string; project: string } {
  const base = mkdtempSync(join(tmpdir(), 'zerochan-service-control-'))
  directories.push(base)
  const state = join(base, 'state')
  const project = join(base, 'project')
  mkdirSync(state, { mode: 0o700 })
  chmodSync(state, 0o700)
  mkdirSync(project)
  return { base, state, project }
}

const fakeRuntime: HerdrRuntimeIdentity = {
  binary: '/bin/sh',
  binaryDevice: 1,
  binaryInode: 1,
  binaryMode: 0o100755,
  binarySize: 1,
  binaryModifiedMs: 1,
  binaryChangedMs: 1,
  socketPath: '/tmp/not-used.sock',
  socketDevice: 1,
  socketInode: 1,
  paneId: 'wT:p1',
  tabId: 'wT:t1',
  terminalId: 'term_abcdef012345',
  workspaceId: 'wT',
}

function createJobDatabase(
  state: string,
  rows: Array<{ status: 'queued' | 'running' | 'completed'; runtime?: 'codex' }> = [],
): void {
  const database = new Database(join(state, 'jobs.sqlite3'), { create: true })
  database.exec('CREATE TABLE jobs (status TEXT NOT NULL, runtime TEXT)')
  const insert = database.prepare('INSERT INTO jobs (status, runtime) VALUES (?, ?)')
  for (const row of rows) insert.run(row.status, row.runtime ?? 'codex')
  database.close()
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(20)
  expect(existsSync(path)).toBe(true)
}

async function spawnManagedServices(
  state: string,
  base: string,
  options: { acknowledgePause?: boolean } = {},
): Promise<{ gateway: Bun.Subprocess; runner: Bun.Subprocess }> {
  const processLock = join(import.meta.dir, 'process-lock.ts')
  const serviceState = join(import.meta.dir, 'service-control-state.ts')
  const server = join(base, 'server.ts')
  const runner = join(base, 'job-runner.ts')
  const gatewayReady = join(base, 'gateway.ready')
  const runnerReady = join(base, 'runner.ready')
  writeFileSync(server, [
    `import { releaseProcessLock, tryAcquireProcessLock } from ${JSON.stringify(processLock)}`,
    `const lock = ${JSON.stringify(join(state, 'plugin.lock'))}`,
    'const acquired = tryAcquireProcessLock(lock, process.pid)',
    "if (!acquired.acquired) throw new Error('gateway lock unavailable')",
    `await Bun.write(${JSON.stringify(gatewayReady)}, String(process.pid))`,
    'let stopping = false',
    'const stop = () => {',
    '  if (stopping) return',
    '  stopping = true',
    '  releaseProcessLock(lock, acquired.lease)',
    '  process.exit(0)',
    '}',
    "process.on('SIGTERM', stop)",
    "process.on('SIGINT', stop)",
    'await Bun.sleep(60_000)',
    '',
  ].join('\n'))
  const runnerSource = [
    `import { releaseProcessLock, tryAcquireProcessLock } from ${JSON.stringify(processLock)}`,
    `import { acknowledgeServiceControlPauseIfRequested } from ${JSON.stringify(serviceState)}`,
    `const state = ${JSON.stringify(state)}`,
    `const lock = ${JSON.stringify(join(state, 'job-runner.lock', 'pid'))}`,
    `await Bun.write(${JSON.stringify(join(state, 'job-runner.lock', '.keep'))}, '')`,
    'const acquired = tryAcquireProcessLock(lock, process.pid)',
    "if (!acquired.acquired) throw new Error('runner lock unavailable')",
    `await Bun.write(${JSON.stringify(runnerReady)}, String(process.pid))`,
    ...(options.acknowledgePause === false ? [
      'const timer = setInterval(() => {}, 20)',
    ] : [
      'const timer = setInterval(() => {',
      '  try { acknowledgeServiceControlPauseIfRequested(state) } catch {}',
      '}, 20)',
    ]),
    'let stopping = false',
    'const stop = () => {',
    '  if (stopping) return',
    '  stopping = true',
    '  clearInterval(timer)',
    '  releaseProcessLock(lock, acquired.lease)',
    '  process.exit(0)',
    '}',
    "process.on('SIGTERM', stop)",
    "process.on('SIGINT', stop)",
    'await Bun.sleep(60_000)',
    '',
  ].join('\n')
  writeFileSync(runner, runnerSource)
  mkdirSync(join(state, 'job-runner.lock'), { mode: 0o700 })
  const gateway = Bun.spawn([process.execPath, server], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  })
  const worker = Bun.spawn([process.execPath, runner, 'daemon'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  })
  processes.push(gateway, worker)
  await Promise.all([waitFor(gatewayReady), waitFor(runnerReady)])
  return { gateway, runner: worker }
}

function publishRuntime(
  state: string,
  runtime = fakeRuntime,
  appId = 'A0123456789',
): void {
  writePinnedHerdrRuntime(state, runtime)
  writeFileSync(
    join(state, 'job-runner.lock', 'runtime'),
    `zerokun-codex-runner-v1:${appId}:fixture:${herdrRuntimeFingerprint(runtime)}\n`,
    { mode: 0o600 },
  )
}

const testHooks = {
  controlRuntime: fakeRuntime,
  verifyControlRuntime: async () => {},
  closeRecordedTab: async () => 'none' as const,
}

describe('zerochan service control state', () => {
  test('runner pause requestは同一PIDだけがackしowned requestだけを消す', () => {
    const { state } = fixture()
    const request = createServiceControlPauseRequest(state, process.pid)
    expect(serviceControlPauseAcknowledged(state, request)).toBe(false)
    expect(acknowledgeServiceControlPauseIfRequested(state)).toBe(true)
    expect(serviceControlPauseAcknowledged(state, request)).toBe(true)
    clearServiceControlPauseRequest(state, request)
    expect(existsSync(join(state, 'service-control-pause-request.json'))).toBe(false)
    expect(existsSync(join(state, 'service-control-pause-ack.json'))).toBe(false)
  })

  test('意図的停止markerはstrict形式で設定・解除する', () => {
    const { state } = fixture()
    expect(intentionalServiceStopIsSet(state)).toBe(false)
    writeIntentionalServiceStop(state)
    expect(intentionalServiceStopIsSet(state)).toBe(true)
    expect(readFileSync(join(state, 'service-stopped.json'), 'utf8'))
      .toBe('{"version":1,"status":"stopped"}\n')
    clearIntentionalServiceStop(state)
    expect(intentionalServiceStopIsSet(state)).toBe(false)
  })
})

describe('zerochan stop/start', () => {
  test('stopはidle ack後だけ停止しqueued jobと意図的停止状態を保持する', async () => {
    const { base, state } = fixture()
    createJobDatabase(state, [{ status: 'queued' }])
    const services = await spawnManagedServices(state, base)
    const result = await stopManagedService(dirname(import.meta.dir), state, testHooks)
    expect(result.status).toBe('stopped')
    expect(await services.gateway.exited).toBe(0)
    expect(await services.runner.exited).toBe(0)
    const database = new Database(join(state, 'jobs.sqlite3'), { readonly: true })
    expect(database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'",
    ).get()?.count).toBe(1)
    database.close()
    expect(intentionalServiceStopIsSet(state)).toBe(true)
    expect(readPinnedHerdrRuntime(state)).toEqual(fakeRuntime)
  })

  test('stopはrunning jobがあればprocessへsignalせず拒否する', async () => {
    const { base, state } = fixture()
    createJobDatabase(state, [{ status: 'running' }])
    const services = await spawnManagedServices(state, base)
    await expect(stopManagedService(dirname(import.meta.dir), state, testHooks))
      .rejects.toThrow('実行中のタスクが1件')
    expect(services.gateway.exitCode).toBeNull()
    expect(services.runner.exitCode).toBeNull()
    expect(intentionalServiceStopIsSet(state)).toBe(false)
  })

  test('stopは更新前runnerがack非対応でも凍結境界で安全に停止する', async () => {
    const { base, state } = fixture()
    createJobDatabase(state, [{ status: 'queued' }])
    const services = await spawnManagedServices(state, base, { acknowledgePause: false })
    const result = await stopManagedService(dirname(import.meta.dir), state, {
      ...testHooks,
      pauseTimeoutMs: 100,
    })
    expect(result.status).toBe('stopped')
    expect(await services.gateway.exited).toBe(0)
    expect(await services.runner.exited).toBe(0)
    const database = new Database(join(state, 'jobs.sqlite3'), { readonly: true })
    expect(database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'",
    ).get()?.count).toBe(1)
    database.close()
    expect(intentionalServiceStopIsSet(state)).toBe(true)
  })

  test('startは回収不能な旧runtime tabを上書きせず新規起動しない', async () => {
    const { state, project } = fixture()
    let started = false
    await expect(startManagedService(
      dirname(import.meta.dir),
      state,
      project,
      'A0123456789',
      {
        ...testHooks,
        closeRecordedTab: async () => 'retained',
        startBot: async () => {
          started = true
          throw new Error('must not start')
        },
      },
    )).rejects.toThrow('既存runtime tabを安全に回収できない')
    expect(started).toBe(false)
  })

  test('startは停止markerを消しgateway/runnerの安定起動を返す', async () => {
    const { base, state, project } = fixture()
    createJobDatabase(state)
    writeIntentionalServiceStop(state)
    let services: Awaited<ReturnType<typeof spawnManagedServices>> | undefined
    const release = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: dirname(import.meta.dir), stdout: 'pipe', stderr: 'pipe',
    }).stdout.toString().trim()
    const result = await startManagedService(
      dirname(import.meta.dir),
      state,
      project,
      'A0123456789',
      {
        ...testHooks,
        startBot: async options => {
          options.onRuntimeSelected?.(fakeRuntime)
        services = await spawnManagedServices(state, base)
        publishRuntime(state)
        writeGatewayReadiness(
          join(state, 'gateway-ready.json'),
          release,
          services.gateway.pid,
          project,
          'A0123456789',
        )
        return { paneId: 'wT:pR', gatewayPid: services.gateway.pid, runtime: fakeRuntime }
      },
      },
    )
    expect(result.status).toBe('started')
    expect(result.paneId).toBe('wT:pR')
    expect(result.gatewayPid).toBe(services!.gateway.pid)
    expect(result.runnerPid).toBe(services!.runner.pid)
    expect(intentionalServiceStopIsSet(state)).toBe(false)
  })

  test('startは稼働中serviceのSlack App identity不一致を共有しない', async () => {
    const { base, state, project } = fixture()
    createJobDatabase(state)
    const services = await spawnManagedServices(state, base)
    publishRuntime(state, fakeRuntime, 'A9999999999')
    const release = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: dirname(import.meta.dir), stdout: 'pipe', stderr: 'pipe',
    }).stdout.toString().trim()
    writeGatewayReadiness(
      join(state, 'gateway-ready.json'),
      release,
      services.gateway.pid,
      project,
      'A9999999999',
    )
    await expect(startManagedService(
      dirname(import.meta.dir),
      state,
      project,
      'A0123456789',
      testHooks,
    )).rejects.toThrow('Slack App identity')
    expect(services.gateway.exitCode).toBeNull()
    expect(services.runner.exitCode).toBeNull()
  })

  test('start失敗時は今回publishしたgenerationだけを完全停止する', async () => {
    const { base, state, project } = fixture()
    createJobDatabase(state)
    let services: Awaited<ReturnType<typeof spawnManagedServices>> | undefined
    const release = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: dirname(import.meta.dir), stdout: 'pipe', stderr: 'pipe',
    }).stdout.toString().trim()
    await expect(startManagedService(
      dirname(import.meta.dir),
      state,
      project,
      'A0123456789',
      {
        ...testHooks,
        pauseTimeoutMs: 1_000,
        startBot: async options => {
          options.onRuntimeSelected?.(fakeRuntime)
          services = await spawnManagedServices(state, base)
          publishRuntime(state)
          writeGatewayReadiness(
            join(state, 'gateway-ready.json'),
            release,
            services.gateway.pid,
            project,
            'A0123456789',
          )
          throw new Error('fixture startup failure')
        },
      },
    )).rejects.toThrow('fixture startup failure')
    expect(await services!.gateway.exited).toBe(0)
    expect(await services!.runner.exited).toBe(0)
    expect(intentionalServiceStopIsSet(state)).toBe(true)
  })
})
