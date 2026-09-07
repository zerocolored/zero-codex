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
import {
  inspectManagedServiceStatus,
  startManagedService,
  stopManagedService,
} from './service-control.ts'
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
import {
  observeProcessGeneration,
  readProcessIdentity,
  signalProcessIfLive,
  type ProcessIdentity,
} from './process-generation.ts'

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

async function spawnManagedLauncher(
  state: string,
  base: string,
  label = 'initial',
): Promise<Bun.Subprocess> {
  const processLock = join(import.meta.dir, 'process-lock.ts')
  const launcherDir = join(base, `launcher-${label}`)
  const launcher = join(launcherDir, 'runner-launcher.ts')
  const ready = join(launcherDir, 'ready')
  mkdirSync(launcherDir, { recursive: true })
  writeFileSync(launcher, [
    `import { releaseProcessLock, tryAcquireProcessLock } from ${JSON.stringify(processLock)}`,
    `const lock = ${JSON.stringify(join(state, 'job-runner-starter.lock'))}`,
    'const acquired = tryAcquireProcessLock(lock, process.pid)',
    "if (!acquired.acquired) throw new Error('launcher lock unavailable')",
    `await Bun.write(${JSON.stringify(ready)}, String(process.pid))`,
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
  const child = Bun.spawn([process.execPath, launcher], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  })
  processes.push(child)
  await waitFor(ready)
  return child
}

async function spawnManagedServices(
  state: string,
  base: string,
  options: {
    acknowledgePause?: boolean
    detachedDescendantPidFile?: string
  } = {},
): Promise<{ gateway: Bun.Subprocess; runner: Bun.Subprocess; launcher: Bun.Subprocess }> {
  const processLock = join(import.meta.dir, 'process-lock.ts')
  const serviceState = join(import.meta.dir, 'service-control-state.ts')
  const server = join(base, 'server.ts')
  const runner = join(base, 'job-runner.ts')
  const gatewayReady = join(base, 'gateway.ready')
  const runnerReady = join(base, 'runner.ready')
  const descendantScript = join(base, 'runner-descendant.ts')
  if (options.detachedDescendantPidFile) {
    writeFileSync(descendantScript, [
      "import { writeFileSync } from 'fs'",
      "const grandchild = Bun.spawn(['/bin/sleep', '60'], {",
      "  detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',",
      '})',
      `writeFileSync(${JSON.stringify(options.detachedDescendantPidFile)}, JSON.stringify({`,
      '  child: process.pid, grandchild: grandchild.pid,',
      '}))',
      "process.on('SIGTERM', () => {})",
      'await Bun.sleep(60_000)',
      '',
    ].join('\n'))
  }
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
    ...(options.detachedDescendantPidFile ? [
      `const descendant = Bun.spawn([process.execPath, ${JSON.stringify(descendantScript)}], {`,
      "  detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',",
      '})',
      `while (!Bun.file(${JSON.stringify(options.detachedDescendantPidFile)}).size) {`,
      '  await Bun.sleep(10)',
      '}',
    ] : []),
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
  const launcher = await spawnManagedLauncher(state, base)
  return { gateway, runner: worker, launcher }
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
  test('statusは停止・稼働・部分起動をprocess generationで区別する', async () => {
    const { base, state } = fixture()
    expect(inspectManagedServiceStatus(state)).toEqual({ status: 'stopped' })

    const services = await spawnManagedServices(state, base)
    expect(inspectManagedServiceStatus(state)).toEqual({
      status: 'running',
      gatewayPid: services.gateway.pid,
      runnerPid: services.runner.pid,
      launcherPid: services.launcher.pid,
    })

    services.runner.kill('SIGTERM')
    expect(await services.runner.exited).toBe(0)
    expect(inspectManagedServiceStatus(state)).toEqual({
      status: 'partial',
      gatewayPid: services.gateway.pid,
      runnerPid: undefined,
      launcherPid: services.launcher.pid,
    })
  })

  test.skipIf(process.platform === 'win32')(
    'statusとforce stopはlock前にreparentしたreceipt runnerを追跡して回収する',
    async () => {
      const { base, state } = fixture()
      createJobDatabase(state)
      const runner = join(base, 'receipt-job-runner.ts')
      const launcher = join(base, 'receipt-runner-launcher.ts')
      const pidFile = join(base, 'receipt-runner.pid')
      const processGeneration = join(import.meta.dir, 'process-generation.ts')
      const launchReceipt = join(import.meta.dir, 'runner-launch-receipt.ts')
      writeFileSync(runner, "process.on('SIGTERM', () => {})\nawait Bun.sleep(60_000)\n")
      writeFileSync(launcher, [
        "import { writeFileSync } from 'fs'",
        `import { acquireProcessGroupLeaderIdentity, readProcessIdentity } from ${JSON.stringify(processGeneration)}`,
        `import { prepareRunnerLaunchReceipt, publishRunnerLaunchReceipt } from ${JSON.stringify(launchReceipt)}`,
        'const [runner, stateDir] = process.argv.slice(2)',
        'const launcherIdentity = readProcessIdentity(process.pid)',
        "if (!launcherIdentity) throw new Error('launcher identity unavailable')",
        'const intent = prepareRunnerLaunchReceipt(stateDir!, launcherIdentity)',
        'const daemon = Bun.spawn([process.execPath, runner!, "daemon"], {',
        "  detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',",
        '})',
        'daemon.unref()',
        'const daemonIdentity = await acquireProcessGroupLeaderIdentity(daemon.pid)',
        "if (!daemonIdentity) throw new Error('runner identity unavailable')",
        'publishRunnerLaunchReceipt(stateDir!, intent.intentId, daemonIdentity)',
        `writeFileSync(${JSON.stringify(pidFile)}, String(daemon.pid))`,
        'process.exit(0)',
        '',
      ].join('\n'))

      const owner = Bun.spawn([process.execPath, launcher, runner, state], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
      })
      processes.push(owner)
      await waitFor(pidFile)
      expect(await owner.exited).toBe(0)
      const runnerPid = Number(readFileSync(pidFile, 'utf8'))
      const runnerIdentity = readProcessIdentity(runnerPid)
      try {
        expect(inspectManagedServiceStatus(state)).toEqual(runnerIdentity
          ? { status: 'partial', runnerPid }
          : { status: 'partial' })
        const result = await stopManagedService(
          dirname(import.meta.dir),
          state,
          {
            ...testHooks,
            recoverForcedJobs: async () => ({ completed: 0, failed: 0, queued: 0 }),
          },
          { force: true },
        )
        expect(result.status).toBe('stopped')
        expect(readProcessIdentity(runnerPid)).toBeUndefined()
        expect(existsSync(join(state, 'job-runner-launch.json'))).toBe(false)
        expect(inspectManagedServiceStatus(state)).toEqual({ status: 'stopped' })
      } finally {
        if (runnerIdentity && observeProcessGeneration(runnerIdentity).status === 'alive') {
          signalProcessIfLive(runnerIdentity, 'SIGKILL')
        }
      }
    },
  )

  test.skipIf(process.platform === 'win32')(
    '通常stopもdead launcherのprepared receiptをpartialとして回収する',
    async () => {
      const { base, state } = fixture()
      createJobDatabase(state)
      const launcher = join(base, 'prepared-runner-launcher.ts')
      const launchReceipt = join(import.meta.dir, 'runner-launch-receipt.ts')
      const processGeneration = join(import.meta.dir, 'process-generation.ts')
      writeFileSync(launcher, [
        `import { readProcessIdentity } from ${JSON.stringify(processGeneration)}`,
        `import { prepareRunnerLaunchReceipt } from ${JSON.stringify(launchReceipt)}`,
        'const stateDir = process.argv[2]!',
        'const identity = readProcessIdentity(process.pid)',
        "if (!identity) throw new Error('launcher identity unavailable')",
        'prepareRunnerLaunchReceipt(stateDir, identity)',
        'process.exit(0)',
        '',
      ].join('\n'))
      const owner = Bun.spawn([process.execPath, launcher, state], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
      })
      processes.push(owner)
      expect(await owner.exited).toBe(0)

      expect(inspectManagedServiceStatus(state)).toEqual({ status: 'partial' })
      const result = await stopManagedService(dirname(import.meta.dir), state, testHooks)
      expect(result.status).toBe('stopped')
      expect(existsSync(join(state, 'job-runner-launch.json'))).toBe(false)
      expect(inspectManagedServiceStatus(state)).toEqual({ status: 'stopped' })
    },
  )

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
    let refusal: unknown
    try {
      await stopManagedService(dirname(import.meta.dir), state, testHooks)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(Error)
    const message = (refusal as Error).message
    expect(message).toContain('実行中のタスクが1件')
    expect(message).toContain('zerochan stop --force')
    expect(message).toContain('履歴とCodexセッションは保持')
    expect(message).toContain('完了済みの変更や外部操作は元に戻りません')
    expect(services.gateway.exitCode).toBeNull()
    expect(services.runner.exitCode).toBeNull()
    expect(intentionalServiceStopIsSet(state)).toBe(false)
  })

  test('stop --forceはrunning jobがあってもexact serviceを停止しqueued jobを保持する', async () => {
    const { base, state } = fixture()
    createJobDatabase(state, [{ status: 'running' }, { status: 'queued' }])
    const services = await spawnManagedServices(state, base)
    const result = await stopManagedService(dirname(import.meta.dir), state, {
      ...testHooks,
      recoverForcedJobs: async ({ stateDir }) => {
        const database = new Database(join(stateDir, 'jobs.sqlite3'))
        database.run("UPDATE jobs SET status = 'completed' WHERE status = 'running'")
        const queued = database.query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'",
        ).get()?.count ?? 0
        database.close()
        return { completed: 1, failed: 0, queued }
      },
    }, { force: true })
    expect(result.status).toBe('stopped')
    await Promise.all([services.gateway.exited, services.runner.exited])
    expect(inspectManagedServiceStatus(state)).toEqual({ status: 'stopped' })
    const database = new Database(join(state, 'jobs.sqlite3'), { readonly: true })
    expect(database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'",
    ).get()?.count).toBe(1)
    database.close()
    expect(intentionalServiceStopIsSet(state)).toBe(true)
  })

  test('stop --forceは回収失敗時もservice停止markerを残して自動再起動を防ぐ', async () => {
    const { base, state } = fixture()
    createJobDatabase(state, [{ status: 'running' }])
    const services = await spawnManagedServices(state, base)
    await expect(stopManagedService(dirname(import.meta.dir), state, {
      ...testHooks,
      recoverForcedJobs: async () => { throw new Error('fixture recovery failure') },
    }, { force: true })).rejects.toThrow('service本体は停止しました')
    await Promise.all([services.gateway.exited, services.runner.exited])
    expect(inspectManagedServiceStatus(state)).toEqual({ status: 'stopped' })
    expect(intentionalServiceStopIsSet(state)).toBe(true)
  })

  test.skipIf(process.platform === 'win32' || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'stop --forceはdetached publication相当の子孫をoffline回収前に停止する',
    async () => {
      const { base, state } = fixture()
      createJobDatabase(state, [{ status: 'running' }])
      const pidFile = join(base, 'runner-descendants.json')
      const services = await spawnManagedServices(state, base, {
        detachedDescendantPidFile: pidFile,
      })
      await waitFor(pidFile)
      const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as {
        child: number
        grandchild: number
      }
      const identities = [pids.child, pids.grandchild]
        .map(pid => readProcessIdentity(pid))
        .filter((value): value is ProcessIdentity => value !== null)
      expect(identities).toHaveLength(2)
      try {
        const result = await stopManagedService(dirname(import.meta.dir), state, {
          ...testHooks,
          recoverForcedJobs: async ({ stateDir }) => {
            expect(identities.map(identity => observeProcessGeneration(identity).status))
              .toEqual(['dead', 'dead'])
            const database = new Database(join(stateDir, 'jobs.sqlite3'))
            database.run("UPDATE jobs SET status = 'completed' WHERE status = 'running'")
            database.close()
            return { completed: 1, failed: 0, queued: 0 }
          },
        }, { force: true })
        expect(result.status).toBe('stopped')
        await Promise.all([services.gateway.exited, services.runner.exited])
        expect(identities.map(identity => observeProcessGeneration(identity).status))
          .toEqual(['dead', 'dead'])
      } finally {
        for (const identity of identities) signalProcessIfLive(identity, 'SIGKILL')
      }
    },
  )

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

  test('startは停止markerを消しgateway/runner/launcherの安定起動を返す', async () => {
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
    expect(result.launcherPid).toBe(services!.launcher.pid)
    expect(intentionalServiceStopIsSet(state)).toBe(false)
  })

  test('別projectからのstartもgatewayとrunnerを止めず欠落したlauncherだけを再構築する', async () => {
    const { base, state, project } = fixture()
    const callerProject = join(base, 'caller-project')
    mkdirSync(callerProject)
    createJobDatabase(state)
    const services = await spawnManagedServices(state, base)
    publishRuntime(state)
    const release = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: dirname(import.meta.dir), stdout: 'pipe', stderr: 'pipe',
    }).stdout.toString().trim()
    writeGatewayReadiness(
      join(state, 'gateway-ready.json'),
      release,
      services.gateway.pid,
      project,
      'A0123456789',
    )
    services.launcher.kill('SIGTERM')
    expect(await services.launcher.exited).toBe(0)
    expect(inspectManagedServiceStatus(state)).toMatchObject({
      status: 'partial',
      gatewayPid: services.gateway.pid,
      runnerPid: services.runner.pid,
    })

    let rebuilt: Bun.Subprocess | undefined
    const result = await startManagedService(
      dirname(import.meta.dir),
      state,
      callerProject,
      'A0123456789',
      {
        ...testHooks,
        startBot: async () => { throw new Error('full service must not restart') },
        startRunnerLauncher: async () => {
          rebuilt = await spawnManagedLauncher(state, base, 'rebuilt')
          const identity = readProcessIdentity(rebuilt.pid)
          if (!identity) throw new Error('rebuilt launcher identity unavailable')
          return { pid: rebuilt.pid, identity }
        },
      },
    )

    expect(result).toEqual({
      status: 'already-running',
      gatewayPid: services.gateway.pid,
      runnerPid: services.runner.pid,
      launcherPid: rebuilt!.pid,
    })
    expect(services.gateway.exitCode).toBeNull()
    expect(services.runner.exitCode).toBeNull()
    expect(rebuilt!.exitCode).toBeNull()
  })

  test('launcher修復の安定確認中にrunnerが正当に世代交代しても新PIDを返す', async () => {
    const { base, state, project } = fixture()
    createJobDatabase(state)
    const services = await spawnManagedServices(state, base)
    publishRuntime(state)
    const release = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: dirname(import.meta.dir), stdout: 'pipe', stderr: 'pipe',
    }).stdout.toString().trim()
    writeGatewayReadiness(
      join(state, 'gateway-ready.json'),
      release,
      services.gateway.pid,
      project,
      'A0123456789',
    )
    services.launcher.kill('SIGTERM')
    expect(await services.launcher.exited).toBe(0)

    let rebuilt: Bun.Subprocess | undefined
    let replacement: Bun.Subprocess | undefined
    let sleepCount = 0
    const result = await startManagedService(
      dirname(import.meta.dir),
      state,
      project,
      'A0123456789',
      {
        ...testHooks,
        startRunnerLauncher: async () => {
          rebuilt = await spawnManagedLauncher(state, base, 'replacement-supervisor')
          const identity = readProcessIdentity(rebuilt.pid)
          if (!identity) throw new Error('replacement launcher identity unavailable')
          return { pid: rebuilt.pid, identity }
        },
        sleep: async () => {
          sleepCount += 1
          if (sleepCount === 1) {
            services.runner.kill('SIGTERM')
            expect(await services.runner.exited).toBe(0)
            rmSync(join(base, 'runner.ready'), { force: true })
            replacement = Bun.spawn([
              process.execPath, join(base, 'job-runner.ts'), 'daemon',
            ], {
              stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
            })
            processes.push(replacement)
            await waitFor(join(base, 'runner.ready'))
          }
          await Bun.sleep(5)
        },
      },
    )

    expect(replacement).toBeDefined()
    expect(result).toEqual({
      status: 'already-running',
      gatewayPid: services.gateway.pid,
      runnerPid: replacement!.pid,
      launcherPid: rebuilt!.pid,
    })
    expect(inspectManagedServiceStatus(state)).toEqual({
      status: 'running',
      gatewayPid: services.gateway.pid,
      runnerPid: replacement!.pid,
      launcherPid: rebuilt!.pid,
    })
  })

  test('launcher修復後のhealth失敗は新launcherだけを回収し既存serviceを保持する', async () => {
    const { base, state, project } = fixture()
    createJobDatabase(state)
    const services = await spawnManagedServices(state, base)
    publishRuntime(state)
    const release = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: dirname(import.meta.dir), stdout: 'pipe', stderr: 'pipe',
    }).stdout.toString().trim()
    writeGatewayReadiness(
      join(state, 'gateway-ready.json'),
      release,
      services.gateway.pid,
      project,
      'A0123456789',
    )
    services.launcher.kill('SIGTERM')
    expect(await services.launcher.exited).toBe(0)

    let rebuilt: Bun.Subprocess | undefined
    await expect(startManagedService(
      dirname(import.meta.dir),
      state,
      project,
      'A0123456789',
      {
        ...testHooks,
        startRunnerLauncher: async () => {
          rebuilt = await spawnManagedLauncher(state, base, 'failed-health')
          writeGatewayReadiness(
            join(state, 'gateway-ready.json'),
            release,
            services.gateway.pid,
            base,
            'A0123456789',
          )
          const identity = readProcessIdentity(rebuilt.pid)
          if (!identity) throw new Error('failed-health launcher identity unavailable')
          return { pid: rebuilt.pid, identity }
        },
        sleep: async () => {},
        runnerLauncherCleanupGraceMs: 100,
      },
    )).rejects.toThrow('安定稼働を確認できません')

    expect(await rebuilt!.exited).toBe(0)
    expect(existsSync(join(state, 'job-runner-starter.lock'))).toBe(false)
    expect(services.gateway.exitCode).toBeNull()
    expect(services.runner.exitCode).toBeNull()
    expect(inspectManagedServiceStatus(state)).toEqual({
      status: 'partial',
      gatewayPid: services.gateway.pid,
      runnerPid: services.runner.pid,
    })
  })

  test('production再構築は既存gateway/runnerを保持してlauncher lockをpublishする', async () => {
    const { base, state, project } = fixture()
    const root = join(base, 'runtime-root')
    const runtimeDir = join(root, 'zerokun')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'job-runner.ts'), '// fixture runner\n')
    const processLock = join(import.meta.dir, 'process-lock.ts')
    writeFileSync(join(runtimeDir, 'runner-launcher.ts'), [
      `import { releaseProcessLock, tryAcquireProcessLock } from ${JSON.stringify(processLock)}`,
      'const starterLock = process.argv[5]!',
      'const acquired = tryAcquireProcessLock(starterLock, process.pid)',
      "if (!acquired.acquired) throw new Error('launcher lock unavailable')",
      'const stop = () => { releaseProcessLock(starterLock, acquired.lease); process.exit(0) }',
      "process.on('SIGTERM', stop)",
      "process.on('SIGINT', stop)",
      'await Bun.sleep(60_000)',
      '',
    ].join('\n'))
    createJobDatabase(state)
    const services = await spawnManagedServices(state, base)
    publishRuntime(state)
    const release = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: dirname(import.meta.dir), stdout: 'pipe', stderr: 'pipe',
    }).stdout.toString().trim()
    writeGatewayReadiness(
      join(state, 'gateway-ready.json'),
      release,
      services.gateway.pid,
      project,
      'A0123456789',
    )
    services.launcher.kill('SIGTERM')
    expect(await services.launcher.exited).toBe(0)
    let rebuiltIdentity: ProcessIdentity | undefined
    try {
      const result = await startManagedService(
        root,
        state,
        project,
        'A0123456789',
        testHooks,
      )
      expect(result.status).toBe('already-running')
      expect(result.gatewayPid).toBe(services.gateway.pid)
      expect(result.runnerPid).toBe(services.runner.pid)
      expect(result.launcherPid).toBeGreaterThan(0)
      rebuiltIdentity = readProcessIdentity(result.launcherPid!)
      expect(rebuiltIdentity).toBeDefined()
      expect(inspectManagedServiceStatus(state)).toEqual({
        status: 'running',
        gatewayPid: services.gateway.pid,
        runnerPid: services.runner.pid,
        launcherPid: result.launcherPid,
      })
    } finally {
      if (rebuiltIdentity) {
        signalProcessIfLive(rebuiltIdentity, 'SIGTERM')
        for (let attempt = 0; attempt < 100
          && observeProcessGeneration(rebuiltIdentity).status === 'alive'; attempt += 1) {
          await Bun.sleep(10)
        }
        if (observeProcessGeneration(rebuiltIdentity).status === 'alive') {
          signalProcessIfLive(rebuiltIdentity, 'SIGKILL')
        }
      }
    }
  })

  test.skipIf(process.platform === 'win32')(
    'launcher再構築失敗はTERMを先行しdetached runner treeと両leaseを回収する',
    async () => {
      const { base, state, project } = fixture()
      const root = join(base, 'failed-repair-root')
      const runtimeDir = join(root, 'zerokun')
      const processLock = join(import.meta.dir, 'process-lock.ts')
      const runnerReady = join(base, 'failed-repair-runner.ready')
      const pidFile = join(base, 'failed-repair-pids.json')
      const termMarker = join(base, 'failed-repair-launcher.term')
      mkdirSync(runtimeDir, { recursive: true })
      writeFileSync(join(runtimeDir, 'job-runner.ts'), [
        "import { writeFileSync } from 'fs'",
        `import { tryAcquireProcessLock } from ${JSON.stringify(processLock)}`,
        `const lock = ${JSON.stringify(join(state, 'job-runner.lock', 'pid'))}`,
        'const acquired = tryAcquireProcessLock(lock, process.pid)',
        "if (!acquired.acquired) throw new Error('runner lock unavailable')",
        "const grandchild = Bun.spawn(['/bin/sleep', '60'], {",
        "  detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',",
        '})',
        `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({`,
        '  runner: process.pid, grandchild: grandchild.pid,',
        '}))',
        `writeFileSync(${JSON.stringify(runnerReady)}, 'ready')`,
        "process.on('SIGTERM', () => {})",
        "process.on('SIGINT', () => {})",
        'await Bun.sleep(60_000)',
        '',
      ].join('\n'))
      writeFileSync(join(runtimeDir, 'runner-launcher.ts'), [
        "import { writeFileSync } from 'fs'",
        'const runner = process.argv[2]!',
        'const daemon = Bun.spawn([process.execPath, runner, "daemon"], {',
        "  detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',",
        '})',
        'let stopping = false',
        "process.on('SIGTERM', () => {",
        '  if (stopping) return',
        '  stopping = true',
        `  writeFileSync(${JSON.stringify(termMarker)}, 'term-first')`,
        "  try { process.kill(-daemon.pid, 'SIGTERM') } catch {}",
        '  void daemon.exited.then(() => process.exit(0))',
        '})',
        'await Bun.sleep(60_000)',
        '',
      ].join('\n'))

      createJobDatabase(state)
      const services = await spawnManagedServices(state, base)
      publishRuntime(state)
      const release = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
        cwd: dirname(import.meta.dir), stdout: 'pipe', stderr: 'pipe',
      }).stdout.toString().trim()
      writeGatewayReadiness(
        join(state, 'gateway-ready.json'),
        release,
        services.gateway.pid,
        project,
        'A0123456789',
      )
      services.launcher.kill('SIGTERM')
      expect(await services.launcher.exited).toBe(0)

      let verifyCount = 0
      await expect(startManagedService(
        root,
        state,
        project,
        'A0123456789',
        {
          ...testHooks,
          verifyControlRuntime: async () => {
            verifyCount += 1
            if (verifyCount !== 2) return
            services.runner.kill('SIGTERM')
            expect(await services.runner.exited).toBe(0)
          },
          sleep: milliseconds => Bun.sleep(Math.min(milliseconds, 10)),
          runnerLauncherStartTimeoutMs: 500,
          runnerLauncherCleanupGraceMs: 100,
        },
      )).rejects.toThrow('runner launcher再構築')

      expect(existsSync(termMarker)).toBe(true)
      expect(readFileSync(termMarker, 'utf8')).toBe('term-first')
      const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as {
        runner: number
        grandchild: number
      }
      const identities = [pids.runner, pids.grandchild]
        .map(pid => readProcessIdentity(pid))
        .filter((value): value is ProcessIdentity => value !== undefined)
      // readProcessIdentity returns undefined only after the exact generations
      // are gone; lock disappearance independently proves lease cleanup.
      expect(identities).toHaveLength(0)
      expect(existsSync(join(state, 'job-runner-starter.lock'))).toBe(false)
      expect(existsSync(join(state, 'job-runner.lock', 'pid'))).toBe(false)
      expect(inspectManagedServiceStatus(state)).toEqual({
        status: 'partial', gatewayPid: services.gateway.pid,
      })
    },
  )

  test.skipIf(process.platform === 'win32')(
    'launcherが先に終了しlock前にreparentしたrunnerもreceipt世代で回収する',
    async () => {
      const { base, state, project } = fixture()
      const root = join(base, 'reparented-repair-root')
      const runtimeDir = join(root, 'zerokun')
      const pidFile = join(base, 'reparented-runner.pid')
      const launcherPidFile = join(base, 'failed-launcher.pid')
      const processGeneration = join(import.meta.dir, 'process-generation.ts')
      const launchReceipt = join(import.meta.dir, 'runner-launch-receipt.ts')
      mkdirSync(runtimeDir, { recursive: true })
      writeFileSync(join(runtimeDir, 'job-runner.ts'), [
        "import { writeFileSync } from 'fs'",
        "process.on('SIGTERM', () => {})",
        'await Bun.sleep(60_000)',
        '',
      ].join('\n'))
      writeFileSync(join(runtimeDir, 'runner-launcher.ts'), [
        "import { writeFileSync } from 'fs'",
        `import { acquireProcessGroupLeaderIdentity, readProcessIdentity } from ${JSON.stringify(processGeneration)}`,
        `import { prepareRunnerLaunchReceipt, publishRunnerLaunchReceipt } from ${JSON.stringify(launchReceipt)}`,
        'const [runner, stateDir] = process.argv.slice(2)',
        'const launcherIdentity = readProcessIdentity(process.pid)',
        "if (!launcherIdentity) throw new Error('launcher identity unavailable')",
        'const intent = prepareRunnerLaunchReceipt(stateDir!, launcherIdentity)',
        'const daemon = Bun.spawn([process.execPath, runner, "daemon"], {',
        "  detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',",
        '})',
        'daemon.unref()',
        'const daemonIdentity = await acquireProcessGroupLeaderIdentity(daemon.pid)',
        "if (!daemonIdentity) throw new Error('runner identity unavailable')",
        'publishRunnerLaunchReceipt(stateDir!, intent.intentId, daemonIdentity)',
        `writeFileSync(${JSON.stringify(pidFile)}, String(daemon.pid))`,
        `writeFileSync(${JSON.stringify(launcherPidFile)}, String(process.pid))`,
        'process.exit(17)',
        '',
      ].join('\n'))

      createJobDatabase(state)
      const services = await spawnManagedServices(state, base)
      publishRuntime(state)
      const release = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
        cwd: dirname(import.meta.dir), stdout: 'pipe', stderr: 'pipe',
      }).stdout.toString().trim()
      writeGatewayReadiness(
        join(state, 'gateway-ready.json'),
        release,
        services.gateway.pid,
        project,
        'A0123456789',
      )
      services.launcher.kill('SIGTERM')
      expect(await services.launcher.exited).toBe(0)

      let verifyCount = 0
      await expect(startManagedService(
        root,
        state,
        project,
        'A0123456789',
        {
          ...testHooks,
          verifyControlRuntime: async () => {
            verifyCount += 1
            if (verifyCount !== 2) return
            services.runner.kill('SIGTERM')
            expect(await services.runner.exited).toBe(0)
          },
          sleep: milliseconds => Bun.sleep(Math.min(milliseconds, 10)),
          runnerLauncherStartTimeoutMs: 1_000,
          runnerLauncherCleanupGraceMs: 100,
        },
      )).rejects.toThrow('runner launcher再構築processが終了しました')

      const runnerPid = Number(readFileSync(pidFile, 'utf8'))
      const failedLauncherPid = Number(readFileSync(launcherPidFile, 'utf8'))
      expect(runnerPid).not.toBe(failedLauncherPid)
      expect(readProcessIdentity(runnerPid)).toBeUndefined()
      expect(existsSync(join(state, 'job-runner-starter.lock'))).toBe(false)
      expect(existsSync(join(state, 'job-runner.lock', 'pid'))).toBe(false)
      expect(existsSync(join(state, 'job-runner-launch.json'))).toBe(false)
      expect(inspectManagedServiceStatus(state)).toEqual({
        status: 'partial', gatewayPid: services.gateway.pid,
      })
    },
  )

  test.skipIf(process.platform === 'win32')(
    'launcher死亡後もprepared intentを取消して遅延publisherのrunner起動を防ぐ',
    async () => {
      const { base, state, project } = fixture()
      const root = join(base, 'delayed-publication-root')
      const runtimeDir = join(root, 'zerokun')
      const childPidFile = join(base, 'delayed-publisher.pid')
      const lateRunnerMarker = join(base, 'late-runner.started')
      const processGeneration = join(import.meta.dir, 'process-generation.ts')
      const launchReceipt = join(import.meta.dir, 'runner-launch-receipt.ts')
      mkdirSync(runtimeDir, { recursive: true })
      writeFileSync(join(runtimeDir, 'job-runner.ts'), [
        "import { writeFileSync } from 'fs'",
        `import { readProcessIdentity } from ${JSON.stringify(processGeneration)}`,
        `import { publishRunnerLaunchReceipt } from ${JSON.stringify(launchReceipt)}`,
        'const [stateDir, intentId] = process.argv.slice(2)',
        `writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid))`,
        'await Bun.sleep(350)',
        'const identity = readProcessIdentity(process.pid)',
        "if (!identity) throw new Error('delayed publisher identity unavailable')",
        'publishRunnerLaunchReceipt(stateDir!, intentId!, identity)',
        `writeFileSync(${JSON.stringify(lateRunnerMarker)}, 'started')`,
        'await Bun.sleep(60_000)',
        '',
      ].join('\n'))
      writeFileSync(join(runtimeDir, 'runner-launcher.ts'), [
        `import { readProcessIdentity } from ${JSON.stringify(processGeneration)}`,
        `import { prepareRunnerLaunchReceipt } from ${JSON.stringify(launchReceipt)}`,
        'const [runner, stateDir] = process.argv.slice(2)',
        'const launcherIdentity = readProcessIdentity(process.pid)',
        "if (!launcherIdentity) throw new Error('launcher identity unavailable')",
        'const intent = prepareRunnerLaunchReceipt(stateDir!, launcherIdentity)',
        'Bun.spawn([process.execPath, runner!, stateDir!, intent.intentId], {',
        "  detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',",
        '})',
        `while (!Bun.file(${JSON.stringify(childPidFile)}).size) await Bun.sleep(5)`,
        'process.exit(17)',
        '',
      ].join('\n'))

      createJobDatabase(state)
      const services = await spawnManagedServices(state, base)
      publishRuntime(state)
      const release = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
        cwd: dirname(import.meta.dir), stdout: 'pipe', stderr: 'pipe',
      }).stdout.toString().trim()
      writeGatewayReadiness(
        join(state, 'gateway-ready.json'),
        release,
        services.gateway.pid,
        project,
        'A0123456789',
      )
      services.launcher.kill('SIGTERM')
      expect(await services.launcher.exited).toBe(0)

      let verifyCount = 0
      await expect(startManagedService(
        root,
        state,
        project,
        'A0123456789',
        {
          ...testHooks,
          verifyControlRuntime: async () => {
            verifyCount += 1
            if (verifyCount !== 2) return
            services.runner.kill('SIGTERM')
            expect(await services.runner.exited).toBe(0)
          },
          sleep: milliseconds => Bun.sleep(Math.min(milliseconds, 10)),
          runnerLauncherStartTimeoutMs: 1_000,
          runnerLauncherCleanupGraceMs: 100,
        },
      )).rejects.toThrow('runner launcher再構築processが終了しました')

      const childPid = Number(readFileSync(childPidFile, 'utf8'))
      await Bun.sleep(500)
      expect(existsSync(lateRunnerMarker)).toBe(false)
      expect(readProcessIdentity(childPid)).toBeUndefined()
      expect(existsSync(join(state, 'job-runner-launch.json'))).toBe(false)
      expect(existsSync(join(state, 'job-runner-starter.lock'))).toBe(false)
      expect(existsSync(join(state, 'job-runner.lock', 'pid'))).toBe(false)
      expect(inspectManagedServiceStatus(state)).toEqual({
        status: 'partial', gatewayPid: services.gateway.pid,
      })
    },
  )

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
