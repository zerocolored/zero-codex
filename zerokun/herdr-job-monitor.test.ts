import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { JobRecord } from './job-runner.ts'
import type { HerdrRuntimeIdentity } from './herdr-runtime.ts'
import {
  appendHerdrJobMonitorChunk,
  appendHerdrJobMonitorStatus,
  buildHerdrMonitorControlEnvironment,
  closeHerdrJobMonitor,
  formatHerdrMonitorLine,
  HERDR_MONITOR_DRAIN_TEXT,
  HERDR_MONITOR_READY_TEXT,
  openHerdrJobMonitor,
  readBoundedHerdrOutput,
  reconcileHerdrJobMonitors,
  retainFailedHerdrJobMonitor,
  stripTerminalControls,
  watchHerdrJobMonitor,
  type HerdrJobMonitorControl,
  type HerdrMonitorPane,
  type HerdrMonitorProcessInfo,
  type HerdrMonitorTab,
} from './herdr-job-monitor.ts'
import { processStartKey, type ProcessIdentity } from './process-generation.ts'
import { completeUtf8PrefixLength } from './herdr-job-monitor-view.ts'
import { atomicWritePrivateFile } from './safe-file.ts'

const directories: string[] = []

test('monitor行は秒までのJST時刻をprefixにする', () => {
  expect(formatHerdrMonitorLine('確認しています', Date.parse('2026-08-29T15:04:05.000Z')))
    .toBe('[00:04:05 JST] 確認しています\n')
  expect(formatHerdrMonitorLine('日付境界の直前', Date.parse('2026-08-29T14:59:59.999Z')))
    .toBe('[23:59:59 JST] 日付境界の直前\n')
  expect(formatHerdrMonitorLine('日付境界', Date.parse('2026-08-29T15:00:00.000Z')))
    .toBe('[00:00:00 JST] 日付境界\n')
})

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'zerochan-monitor-test-'))
  directories.push(directory)
  chmodSync(directory, 0o700)
  const state = join(directory, 'state')
  mkdirSync(state, { mode: 0o700 })
  return state
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (predicate()) return
    await Bun.sleep(20)
  }
  throw new Error('test condition timed out')
}

function runtime(): HerdrRuntimeIdentity {
  return {
    binary: '/usr/bin/true',
    binaryDevice: 1,
    binaryInode: 2,
    binaryMode: 0o100755,
    binarySize: 1,
    binaryModifiedMs: 1,
    binaryChangedMs: 1,
    socketPath: '/tmp/herdr-test.sock',
    socketDevice: 1,
    socketInode: 3,
    paneId: 'wT:p1',
    tabId: 'wT:t1',
    terminalId: 'term_11111111111111',
    workspaceId: 'wT',
  }
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    seq: 7,
    id: 'job-monitor-7',
    idempotencyKey: 'monitor:7',
    chatId: 'C1',
    threadTs: '1800000000.000001',
    messageId: '1800000000.000001',
    userId: 'U1',
    repoPath: '/tmp/project',
    task: '安全に調べる \u001b]0;injected\u0007 \u202Etest',
    attachments: [],
    runtime: 'codex',
    writeEnabled: false,
    status: 'running',
    sessionId: null,
    resumed: false,
    workerId: 'worker',
    executorPid: null,
    monitorState: 'none',
    attempts: 1,
    notBefore: null,
    result: null,
    lastError: null,
    createdAt: 1,
    startedAt: 2,
    finishedAt: null,
    ...overrides,
  }
}

async function sealAndObserveFinalMarker(
  state: string,
  jobId: string,
  control: FakeControl,
): Promise<string> {
  const directory = join(state, 'job-monitors', jobId)
  const marker = HERDR_MONITOR_DRAIN_TEXT
  appendHerdrJobMonitorStatus(state, jobId, marker)
  const epochPath = join(directory, 'status.epoch.json')
  const epoch = JSON.parse(readFileSync(epochPath, 'utf8')) as Record<string, unknown>
  writeFileSync(epochPath, `${JSON.stringify({ ...epoch, sealed: true })}\n`, { mode: 0o600 })
  expect(await control.waitOutput(control.panes[0]!.paneId, marker, 100)).toBe(true)
  return marker
}

const viewerProcess: ProcessIdentity = {
  pid: 4242,
  ppid: 1,
  pgid: 4242,
  status: 2,
  uid: typeof process.getuid === 'function' ? process.getuid() : 501,
  bootSession: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
  startSec: 1_800_000_000,
  startUsec: 123456,
  started: '',
}
viewerProcess.started = processStartKey(viewerProcess)

class FakeControl implements HerdrJobMonitorControl {
  readonly tabs: HerdrMonitorTab[] = []
  readonly panes: HerdrMonitorPane[] = []
  createCalls = 0
  runCalls = 0
  closeCalls = 0
  command = ''
  marker = ''
  process: HerdrMonitorProcessInfo | null = null
  loseCreateResponse = false
  loseRunResponse = false
  suppressReady = false
  suppressDrainMarker = false
  hideMarker = false
  waitFailures = 0
  closeLeavesTab = false
  listFailures = 0
  loseCloseAfterDelivery = false
  failCreateBeforeDelivery = false
  generationStatus: 'alive' | 'dead' | 'unknown' = 'alive'
  autoDrain = true
  generationChecks = 0
  dieAfterGenerationChecks: number | null = null
  readonly lastDrainedGenerations: Partial<Record<'stdout' | 'stderr' | 'status', number>> = {}
  readonly observedMarkers = new Set<string>()
  processInfoCalls = 0
  foreignOnProcessInfoCall: number | null = null
  failProcessInfoOnCall: number | null = null
  shellPidOverride: number | null = null

  verifyRuntime(): void {}
  processGenerationStatus(process: ProcessIdentity): 'alive' | 'dead' | 'unknown' {
    if (process.pid !== viewerProcess.pid || process.started !== viewerProcess.started) return 'dead'
    this.generationChecks += 1
    if (this.dieAfterGenerationChecks !== null
      && this.generationChecks >= this.dieAfterGenerationChecks) {
      this.generationStatus = 'dead'
      if (this.process) this.process.foregroundProcesses = []
    }
    if (this.autoDrain && this.generationStatus === 'alive') this.drainCurrentViewer()
    return this.generationStatus
  }

  async listWorkspaceIds(): Promise<string[]> {
    return [...new Set([
      runtime().workspaceId,
      ...this.tabs.map(tab => tab.workspaceId),
      ...this.panes.map(pane => pane.workspaceId),
    ])]
  }

  async createTab(input: { workspaceId: string; cwd: string; label: string }) {
    this.createCalls += 1
    if (this.failCreateBeforeDelivery) throw new Error('create failed before delivery')
    const number = this.tabs.length + 2
    const tab: HerdrMonitorTab = {
      tabId: `${input.workspaceId}:t${number}`,
      workspaceId: input.workspaceId,
      label: input.label,
      paneCount: 1,
    }
    const pane: HerdrMonitorPane = {
      paneId: `${input.workspaceId}:p${number}`,
      tabId: tab.tabId,
      terminalId: `term_${String(number).repeat(14)}`,
      workspaceId: input.workspaceId,
      cwd: realpathSync(input.cwd),
      foregroundCwd: realpathSync(input.cwd),
    }
    this.tabs.push(tab)
    this.panes.push(pane)
    if (this.loseCreateResponse) throw new Error('response lost after create')
    return { tab, pane }
  }

  async listTabs(workspaceId: string): Promise<HerdrMonitorTab[]> {
    if (this.listFailures > 0) {
      this.listFailures -= 1
      throw new Error('tab list unavailable')
    }
    return this.tabs.filter(tab => tab.workspaceId === workspaceId).map(tab => ({ ...tab }))
  }

  async listPanes(workspaceId: string): Promise<HerdrMonitorPane[]> {
    return this.panes.filter(pane => pane.workspaceId === workspaceId).map(pane => ({ ...pane }))
  }

  async runPane(paneId: string, command: string): Promise<void> {
    this.runCalls += 1
    this.command = command
    const pane = this.panes.find(value => value.paneId === paneId)!
    const manifest = JSON.parse(readFileSync(join(pane.cwd, 'manifest.json'), 'utf8')) as {
      jobId: string
      operationId: string
    }
    this.marker = HERDR_MONITOR_READY_TEXT
    if (!this.suppressReady) {
      writeFileSync(join(pane.cwd, 'ready.json'), `${JSON.stringify({
        version: 1,
        jobId: manifest.jobId,
        operationId: manifest.operationId,
        process: viewerProcess,
      })}\n`, { mode: 0o600 })
      this.process = {
        paneId,
        shellPid: this.shellPidOverride ?? viewerProcess.pid,
        foregroundProcesses: [{
          pid: viewerProcess.pid,
          argv: [
            realpathSync(process.execPath),
            '--config=/dev/null',
            '--no-env-file',
            realpathSync(join(import.meta.dir, 'herdr-job-monitor-view.ts')),
          ],
          cwd: pane.cwd,
        }],
      }
    }
    if (this.loseRunResponse) throw new Error('response lost after run')
  }

  drainDirectory(directory: string): void {
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
      jobId: string
      operationId: string
    }
    const streams = Object.fromEntries(['stdout', 'stderr', 'status'].map(kind => {
      const epoch = JSON.parse(
        readFileSync(join(directory, `${kind}.epoch.json`), 'utf8'),
      ) as { generation: number }
      this.lastDrainedGenerations[kind as 'stdout' | 'stderr' | 'status'] = epoch.generation
      return [kind, {
        generation: epoch.generation,
        offset: statSync(join(directory, `${kind}.${epoch.generation}.feed`)).size,
      }]
    }))
    writeFileSync(join(directory, 'progress.json'), `${JSON.stringify({
      version: 1,
      jobId: manifest.jobId,
      operationId: manifest.operationId,
      process: viewerProcess,
      streams,
      updatedAt: Date.now(),
    })}\n`, { mode: 0o600 })
  }

  private drainCurrentViewer(): void {
    const pane = this.process
      ? this.panes.find(value => value.paneId === this.process!.paneId)
      : undefined
    if (pane) this.drainDirectory(pane.cwd)
  }

  async waitOutput(_paneId: string, marker: string): Promise<boolean> {
    if (this.waitFailures > 0) {
      this.waitFailures -= 1
      throw new Error('wait output unavailable')
    }
    if (marker === HERDR_MONITOR_DRAIN_TEXT || marker === '表示を終了します') {
      if (this.suppressDrainMarker) return false
      if (this.autoDrain && this.generationStatus === 'alive') this.drainCurrentViewer()
      const pane = this.panes.find(value => value.paneId === _paneId)
      if (pane) {
        const epoch = JSON.parse(readFileSync(
          join(pane.cwd, 'status.epoch.json'),
          'utf8',
        )) as { generation: number }
        const content = readFileSync(
          join(pane.cwd, `status.${epoch.generation}.feed`),
          'utf8',
        )
        if (content.includes(marker)) this.observedMarkers.add(marker)
      }
      return this.observedMarkers.has(marker)
    }
    return !this.suppressReady && !this.hideMarker && marker === this.marker
  }

  async processInfo(paneId: string): Promise<HerdrMonitorProcessInfo> {
    this.processInfoCalls += 1
    if (this.failProcessInfoOnCall === this.processInfoCalls) {
      throw new Error('process-info unavailable')
    }
    if (this.foreignOnProcessInfoCall === this.processInfoCalls) {
      const pane = this.panes.find(value => value.paneId === paneId)
      if (!pane) throw new Error('pane is absent')
      this.process = {
        paneId,
        shellPid: 9999,
        foregroundProcesses: [{
          pid: 9999,
          argv: ['/usr/bin/foreign-command'],
          cwd: pane.cwd,
        }],
      }
    }
    if (!this.process) {
      if (!this.panes.some(pane => pane.paneId === paneId)) throw new Error('pane is absent')
      return { paneId, shellPid: 101, foregroundProcesses: [] }
    }
    if (this.process.paneId !== paneId) throw new Error('viewer is absent')
    return structuredClone(this.process)
  }

  async closeTab(tabId: string): Promise<void> {
    this.closeCalls += 1
    if (this.closeLeavesTab) throw new Error('close response failed before delivery')
    const index = this.tabs.findIndex(tab => tab.tabId === tabId)
    if (index >= 0) this.tabs.splice(index, 1)
    for (let pane = this.panes.length - 1; pane >= 0; pane -= 1) {
      if (this.panes[pane]!.tabId === tabId) this.panes.splice(pane, 1)
    }
    this.generationStatus = 'dead'
    if (this.process) this.process.foregroundProcesses = []
    if (this.loseCloseAfterDelivery) {
      this.listFailures += 1
      throw new Error('close response lost after delivery')
    }
  }
}

describe('Herdr job monitor', () => {
  test('DB arm callbackが失敗したらHerdrへ一度もmutationしない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job({ monitorState: 'preparing' })

    await expect(openHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      job: record,
      beforeFirstHerdrMutation: () => { throw new Error('DB arm failed') },
      control,
    })).rejects.toThrow('DB arm failed')

    expect(control.createCalls).toBe(0)
    expect(control.runCalls).toBe(0)
    expect(control.closeCalls).toBe(0)
    expect(existsSync(join(state, 'job-monitors', record.id, 'manifest.json'))).toBe(true)
  })

  test('required obligationのmonitor root欠落を空集合として扱わない', async () => {
    const state = fixtureDirectory()
    const record = job()

    await expect(reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'running' }),
      listMonitorObligations: () => [{
        id: record.id,
        status: 'running',
        state: 'required',
      }],
      control: new FakeControl(),
    })).rejects.toThrow(`required monitor state directory is missing for ${record.id}`)
  })

  test('required obligationの個別directory欠落を検知する', async () => {
    const state = fixtureDirectory()
    const record = job()
    mkdirSync(join(state, 'job-monitors'), { mode: 0o700 })

    await expect(reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'running' }),
      listMonitorObligations: () => [{
        id: record.id,
        status: 'running',
        state: 'required',
      }],
      control: new FakeControl(),
    })).rejects.toThrow(`required monitor directory is missing for ${record.id}`)
  })

  test('required jobのopenは欠落したmonitorを再作成しない', async () => {
    const state = fixtureDirectory()
    const record = job({ monitorState: 'required' })
    const control = new FakeControl()

    await expect(openHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      job: record,
      control,
    })).rejects.toThrow(`required monitor directory is missing for ${record.id}`)

    expect(control.createCalls).toBe(0)
    expect(control.runCalls).toBe(0)
  })

  test('required obligationの空directoryを未初期化残骸として回収しない', async () => {
    const state = fixtureDirectory()
    const record = job({ monitorState: 'required' })
    mkdirSync(join(state, 'job-monitors', record.id), { recursive: true, mode: 0o700 })

    await expect(reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'running' }),
      listMonitorObligations: () => [{
        id: record.id,
        status: 'running',
        state: 'required',
      }],
      control: new FakeControl(),
    })).rejects.toThrow(`required monitor manifest is missing for ${record.id}`)

    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(true)
  })

  test('binding未作成のpreparingだけを外部操作なしでunarmできる', async () => {
    const state = fixtureDirectory()
    const record = job({ monitorState: 'preparing' })
    let obligations = [{
      id: record.id,
      status: 'running' as const,
      state: 'preparing' as const,
    }]
    const control = new FakeControl()

    const result = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'running' }),
      listMonitorObligations: () => obligations,
      recoverMissingBindingAfterExecutorsStopped: () => {
        obligations = []
        return 'unarmed'
      },
      control,
    })

    expect(result).toEqual({ retained: 0, closed: 0, retainedJobIds: [] })
    expect(control.createCalls).toBe(0)
    expect(control.closeCalls).toBe(0)
  })

  test('staged resultのmonitor消失状態はroot欠落でもadvisor cleanupを拒否する', async () => {
    const state = fixtureDirectory()
    const record = job({ monitorState: 'lost-staged' })

    await expect(reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'running' }),
      listMonitorObligations: () => [{
        id: record.id,
        status: 'running',
        state: 'lost-staged',
      }],
      control: new FakeControl(),
    })).rejects.toThrow('remains blocked after losing its Herdr monitor')
  })

  test('同じcontrol planeなら別paneから既存monitorをreconcileできる', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    const launchRuntime = runtime()
    await openHerdrJobMonitor({ stateDir: state, runtime: launchRuntime, job: record, control })
    const restartedRuntime: HerdrRuntimeIdentity = {
      ...launchRuntime,
      paneId: 'wT:p9',
      tabId: 'wT:t9',
      terminalId: 'term_99999999999999',
    }

    const result = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: restartedRuntime,
      getJob: () => ({ status: 'queued' }),
      control,
    })

    expect(result).toEqual({ retained: 1, closed: 0, retainedJobIds: [record.id] })
    expect(control.createCalls).toBe(1)
  })

  test('pane shell PIDが別でもforegroundが一意なviewerならactiveにできる', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.shellPidOverride = 31337
    const record = job()

    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })

    expect(control.process).toMatchObject({
      shellPid: 31337,
      foregroundProcesses: [{ pid: viewerProcess.pid }],
    })
  })

  test('socket世代が変わったcontrol planeでは既存monitorを採択しない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    const launchRuntime = runtime()
    await openHerdrJobMonitor({ stateDir: state, runtime: launchRuntime, job: record, control })

    await expect(openHerdrJobMonitor({
      stateDir: state,
      runtime: { ...launchRuntime, socketInode: launchRuntime.socketInode + 1 },
      job: record,
      control,
    })).rejects.toThrow(`existing monitor does not match job ${record.id}`)
    expect(control.createCalls).toBe(1)
  })

  test('close時にmonitor stateが消失していたら成功扱いしない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    await expect(closeHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: job().id,
      outcome: 'failed',
      control,
    })).rejects.toThrow('monitor state disappeared before close')
    expect(control.closeCalls).toBe(0)
  })

  test('manifest確立前のcrash残骸を外部操作なしで回収して同jobを一度だけ開始する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    const root = join(state, 'job-monitors')
    const directory = join(root, record.id)
    mkdirSync(root, { mode: 0o700 })
    mkdirSync(directory, { mode: 0o700 })
    writeFileSync(
      join(directory, 'manifest.json.tmp-42-00000000-0000-4000-8000-000000000000'),
      '{',
      { mode: 0o600 },
    )

    const reconciled = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'queued' }),
      control,
    })
    expect(reconciled).toEqual({ retained: 0, closed: 0, retainedJobIds: [] })
    expect(control.createCalls).toBe(0)
    expect(control.closeCalls).toBe(0)

    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    expect(control.createCalls).toBe(1)
    expect(control.runCalls).toBe(1)
  })

  test('atomic retire後のpartial trashをstartupで回収しcloseを再送しない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const retiredRoot = join(state, 'job-monitors-closed')
    const retired = join(retiredRoot, `${job().id}.${'a'.repeat(32)}`)
    mkdirSync(retiredRoot, { mode: 0o700 })
    mkdirSync(retired, { mode: 0o700 })
    writeFileSync(join(retired, 'stdout.0.feed'), 'partial retired state\n', { mode: 0o600 })

    const reconciled = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => null,
      control,
    })
    expect(reconciled).toEqual({ retained: 0, closed: 0, retainedJobIds: [] })
    expect(control.closeCalls).toBe(0)
    expect(existsSync(retired)).toBe(false)
  })

  test('専用tabを一度だけ作り、taskをcommandへ入れず、terminal確定後に閉じる', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })

    expect(control.createCalls).toBe(1)
    expect(control.runCalls).toBe(1)
    expect(control.command).toContain('exec /usr/bin/env -i PATH=/usr/bin:/bin TERM=dumb')
    expect(control.command).not.toContain(record.task)
    expect(control.tabs[0]?.label).toBe('Zeroちゃん #7')
    expect(control.tabs[0]?.tabId).not.toBe(runtime().tabId)

    appendHerdrJobMonitorChunk(
      state,
      record.id,
      'stdout',
      Buffer.from('visible\u001b[31mred\u001b[0m\n'),
    )
    appendHerdrJobMonitorStatus(state, record.id, '処理中')
    appendHerdrJobMonitorStatus(
      state,
      record.id,
      '確認先 /Users/example/project Authorization: Bearer abcdefghijklmnop',
    )
    expect(readFileSync(join(state, 'job-monitors', record.id, 'stdout.0.feed'), 'utf8'))
      .toContain('visible')
    const status = readFileSync(
      join(state, 'job-monitors', record.id, 'status.0.feed'),
      'utf8',
    )
    expect(status).toContain('依頼内容を受け取りました')
    expect(status).not.toContain(record.task)
    expect(status).toContain('処理中')
    expect(status).not.toContain('[Zeroちゃん]')
    expect(status.trimEnd().split('\n').every(line => (
      /^\[(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d JST\] /.test(line)
    ))).toBe(true)
    expect(status).toContain('詳細を安全のため省略しました')
    expect(status).not.toContain('/Users/example/project')
    expect(status).not.toContain('abcdefghijklmnop')
    appendHerdrJobMonitorStatus(
      state,
      record.id,
      '失敗として確定します: {"jsonrpc":"2.0","turnId":"internal"}',
    )
    const statusAfterJson = readFileSync(
      join(state, 'job-monitors', record.id, 'status.0.feed'),
      'utf8',
    )
    expect(statusAfterJson).toContain('詳細を安全のため省略しました')
    expect(statusAfterJson).not.toContain('jsonrpc')
    expect(statusAfterJson).not.toContain('turnId')

    await closeHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      outcome: 'completed',
      control,
    })
    expect(control.closeCalls).toBe(1)
    expect(control.tabs).toHaveLength(0)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(false)
  })

  test('UI/UX承認待ちへparkしたqueued jobはwaiting表示を確定して監視tabを閉じる', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })

    const reconciled = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({
        status: 'queued',
        uiApprovalRequestId: 'approval-request-id',
      }),
      control,
    })

    expect(reconciled).toEqual({ retained: 0, closed: 1, retainedJobIds: [] })
    expect(control.closeCalls).toBe(1)
    expect(control.tabs).toHaveLength(0)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(false)
  })

  test('create/runの応答喪失後はexact bindingとreceiptで採択し再送しない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.loseCreateResponse = true
    control.loseRunResponse = true
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    expect(control.createCalls).toBe(1)
    expect(control.runCalls).toBe(1)
  })

  test('create intent後にprocessが落ちても既存tabを採択しcreateを再送しない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.loseCreateResponse = true
    control.listFailures = 1
    const record = job()
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('response lost after create')
    expect(control.createCalls).toBe(1)
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    expect(control.createCalls).toBe(1)
    expect(control.runCalls).toBe(1)
  })

  test('create intentがdelivery前に落ちた場合もcreateを自動再送しない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.failCreateBeforeDelivery = true
    const record = job()
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('create failed before delivery')
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('binding is ambiguous')
    expect(control.createCalls).toBe(1)
    control.generationStatus = 'dead'
    await closeHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      outcome: 'failed',
      control,
    })
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(false)
  })

  test('run deliveryが曖昧なら再送せずrun-intentでfail closedにする', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.loseRunResponse = true
    control.suppressReady = true
    const record = job()
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('receipt is missing')
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('receipt is missing')
    expect(control.runCalls).toBe(1)
  })

  test('run-intentでcrashしてもdurable receiptからviewerをstartup reconcileで採択する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.waitFailures = 1
    control.hideMarker = true
    const record = job()
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('wait output unavailable')
    expect(control.runCalls).toBe(1)
    const reconciled = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'queued' }),
      control,
    })
    expect(reconciled).toEqual({
      retained: 1,
      closed: 0,
      retainedJobIds: [record.id],
    })
    expect(control.runCalls).toBe(1)
    const manifest = JSON.parse(readFileSync(
      join(state, 'job-monitors', record.id, 'manifest.json'),
      'utf8',
    )) as { phase: string }
    expect(manifest.phase).toBe('active')
  })

  test('create-intent response lossはstartupでexact tabを採択しcreateを再送しない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.loseCreateResponse = true
    control.listFailures = 1
    const record = job()
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('response lost after create')

    const reconciled = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'queued' }),
      control,
    })
    expect(reconciled).toEqual({
      retained: 1,
      closed: 0,
      retainedJobIds: [record.id],
    })
    expect(control.createCalls).toBe(1)
    expect(control.runCalls).toBe(1)
  })

  test('tab-created crashはstartupで同じpaneへviewerを一度だけ起動する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.loseCreateResponse = true
    control.listFailures = 1
    const record = job()
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('response lost after create')
    const manifestPath = join(state, 'job-monitors', record.id, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.phase = 'tab-created'
    manifest.tabId = control.tabs[0]!.tabId
    manifest.paneId = control.panes[0]!.paneId
    manifest.terminalId = control.panes[0]!.terminalId
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 })

    const reconciled = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'queued' }),
      control,
    })
    expect(reconciled.retainedJobIds).toEqual([record.id])
    expect(control.createCalls).toBe(1)
    expect(control.runCalls).toBe(1)
  })

  test('rate-limit相当のqueued jobはtabを保持し中止確定後だけreconcileで閉じる', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const retained = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'queued' }),
      control,
    })
    expect(retained).toEqual({
      retained: 1,
      closed: 0,
      retainedJobIds: [record.id],
    })
    expect(control.closeCalls).toBe(0)

    const closed = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'failed', terminalOutcome: 'cancelled' }),
      control,
    })
    expect(closed).toEqual({ retained: 0, closed: 1, retainedJobIds: [] })
    expect(control.closeCalls).toBe(1)
  })

  test('non-terminal jobのactive viewer消失はtabを閉じずstartupをfail closedにする', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.generationStatus = 'dead'
    control.process!.foregroundProcesses = []

    await expect(reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'queued' }),
      control,
    })).rejects.toBeInstanceOf(Error)
    expect(control.closeCalls).toBe(0)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(true)
  })

  test('startupもrequired monitor消失jobを自動terminal化せずfail closedにする', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.tabs.splice(0)
    control.panes.splice(0)
    control.generationStatus = 'dead'
    control.process!.foregroundProcesses = []
    const recovered: Array<{ jobId: string; status: string }> = []

    await expect(reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'running' }),
      recoverMissingBindingAfterExecutorsStopped: (jobId, observedStatus) => {
        recovered.push({ jobId, status: observedStatus })
        return 'terminalized'
      },
      control,
    })).rejects.toThrow('before its final output was observed')

    expect(recovered).toEqual([])
    expect(control.closeCalls).toBe(0)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(true)
  })

  test('terminal DBでもclose-intent前のmonitor消失はcallbackで回収しない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.tabs.splice(0)
    control.panes.splice(0)
    control.generationStatus = 'dead'
    control.process!.foregroundProcesses = []

    await expect(reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'completed' }),
      recoverMissingBindingAfterExecutorsStopped: () => 'terminalized',
      control,
    })).rejects.toThrow('before its final output was observed')
    expect(control.closeCalls).toBe(0)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(true)
  })

  test('close応答が不成立ならstateを保持しexact binding確認後だけ再試行する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.closeLeavesTab = true
    await expect(closeHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      outcome: 'failed',
      control,
    })).rejects.toThrow('binding moved or changed')
    expect(existsSync(join(state, 'job-monitors', record.id, 'manifest.json'))).toBe(true)
    control.closeLeavesTab = false
    await closeHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      outcome: 'failed',
      control,
    })
    expect(control.closeCalls).toBe(2)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(false)
  })

  test('run-intent close失敗後にpaneがforeign processへ変われば再closeしない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.loseRunResponse = true
    control.suppressReady = true
    const record = job()
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('receipt is missing')
    control.closeLeavesTab = true
    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })).rejects.toThrow('binding moved or changed')
    expect(control.closeCalls).toBe(1)

    control.process = {
      paneId: control.panes[0]!.paneId,
      shellPid: 9999,
      foregroundProcesses: [{
        pid: 9999,
        argv: ['/usr/bin/foreign-command'],
        cwd: control.panes[0]!.cwd,
      }],
    }
    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })).rejects.toThrow('occupied before close')
    expect(control.closeCalls).toBe(1)
  })

  test('close-intent fsync直後にpaneが置換されたら破壊的closeを送らない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.loseRunResponse = true
    control.suppressReady = true
    const record = job()
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('receipt is missing')
    control.foreignOnProcessInfoCall = 2

    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })).rejects.toThrow('occupied immediately before close')
    expect(control.closeCalls).toBe(0)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(true)
  })

  test('pre-active viewerがdrain marker後にdeadでもexact空paneだけを閉じる', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.waitFailures = 1
    control.hideMarker = true
    const record = job()
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('wait output unavailable')
    const directory = join(state, 'job-monitors', record.id)
    await sealAndObserveFinalMarker(state, record.id, control)
    control.drainDirectory(directory)
    control.generationStatus = 'dead'
    control.process!.foregroundProcesses = []

    control.closeLeavesTab = true
    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })).rejects.toThrow('binding moved or changed')
    control.closeLeavesTab = false
    await closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })
    expect(control.closeCalls).toBe(2)
    expect(existsSync(directory)).toBe(false)
  })

  test('pre-active dead viewerのclose応答喪失後もrestart reconcileでstateを完了する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.waitFailures = 1
    control.hideMarker = true
    const record = job()
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('wait output unavailable')
    const directory = join(state, 'job-monitors', record.id)
    await sealAndObserveFinalMarker(state, record.id, control)
    control.drainDirectory(directory)
    control.generationStatus = 'dead'
    control.process!.foregroundProcesses = []
    control.loseCloseAfterDelivery = true

    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })).rejects.toThrow('tab list unavailable')
    expect(existsSync(join(directory, 'manifest.json'))).toBe(true)

    control.loseCloseAfterDelivery = false
    const reconciled = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'failed' }),
      control,
    })
    expect(reconciled).toEqual({ retained: 0, closed: 1, retainedJobIds: [] })
    expect(control.closeCalls).toBe(1)
    expect(existsSync(directory)).toBe(false)
  })

  test('pre-active dead viewerは全feed ACKとexact空paneでもmarkerなしならcloseしない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    control.waitFailures = 1
    control.hideMarker = true
    const record = job()
    await expect(openHerdrJobMonitor({
      stateDir: state, runtime: runtime(), job: record, control,
    })).rejects.toThrow('wait output unavailable')
    const directory = join(state, 'job-monitors', record.id)
    control.drainDirectory(directory)
    control.generationStatus = 'dead'
    control.process!.foregroundProcesses = []

    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })).rejects.toThrow('lacks a sealed final marker')
    expect(control.closeCalls).toBe(0)
    expect(existsSync(directory)).toBe(true)
  })

  test('close delivery後のcrashはclose-intentとtab不在からcleanupを完了する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.loseCloseAfterDelivery = true
    await expect(closeHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      outcome: 'completed',
      control,
    })).rejects.toThrow('tab list unavailable')
    control.loseCloseAfterDelivery = false
    await closeHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      outcome: 'completed',
      control,
    })
    expect(control.closeCalls).toBe(1)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(false)
  })

  test('final marker seal後close-intent前の失敗をrestart reconcileで再開する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.processInfoCalls = 0
    control.failProcessInfoOnCall = 2

    await expect(closeHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      outcome: 'completed',
      control,
    })).rejects.toThrow('process-info unavailable')
    const directory = join(state, 'job-monitors', record.id)
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
      phase: string
    }
    const statusEpoch = JSON.parse(
      readFileSync(join(directory, 'status.epoch.json'), 'utf8'),
    ) as { sealed: boolean }
    expect(manifest.phase).toBe('active')
    expect(statusEpoch.sealed).toBe(true)

    const reconciled = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'completed' }),
      control,
    })
    expect(reconciled).toEqual({ retained: 0, closed: 1, retainedJobIds: [] })
    expect(control.closeCalls).toBe(1)
    expect(existsSync(directory)).toBe(false)
  })

  test('terminal時でもclose-intent前にactive tabが消失したらcleanupしない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.tabs.splice(0)
    control.panes.splice(0)
    control.generationStatus = 'dead'
    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })).rejects.toThrow('before a durable close intent')
    expect(control.closeCalls).toBe(0)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(true)
  })

  test('monitor paneが別workspaceへ移動していたらabsent扱いせずfail closedにする', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const tab = control.tabs[0]!
    const pane = control.panes[0]!
    tab.workspaceId = 'wMoved'
    tab.tabId = 'wMoved:t9'
    pane.workspaceId = 'wMoved'
    pane.tabId = tab.tabId
    pane.paneId = 'wMoved:p9'
    control.generationStatus = 'dead'
    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })).rejects.toThrow('binding moved or changed')
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(true)
  })

  test('viewerがdeadでfinal marker未観測ならfeed ACK済みでもcloseしない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const directory = join(state, 'job-monitors', record.id)
    const marker = HERDR_MONITOR_DRAIN_TEXT
    appendHerdrJobMonitorStatus(state, record.id, marker)
    const epochPath = join(directory, 'status.epoch.json')
    const epoch = JSON.parse(readFileSync(epochPath, 'utf8')) as Record<string, unknown>
    writeFileSync(epochPath, `${JSON.stringify({ ...epoch, sealed: true })}\n`, { mode: 0o600 })
    control.drainDirectory(directory)
    control.generationStatus = 'dead'
    control.suppressDrainMarker = true
    control.process!.foregroundProcesses = []
    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })).rejects.toThrow('did not observe final monitor output')
    expect(control.closeCalls).toBe(0)
  })

  test('viewerがfinal markerを観測後にdeadならexact空paneをcloseできる', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const directory = join(state, 'job-monitors', record.id)
    await sealAndObserveFinalMarker(state, record.id, control)
    control.drainDirectory(directory)
    control.generationStatus = 'dead'
    control.process!.foregroundProcesses = []
    await closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })
    expect(control.closeCalls).toBe(1)
  })

  test('64KiBを超えるstatus feedでも末尾marker観測後のdead viewerをcloseできる', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const directory = join(state, 'job-monitors', record.id)
    const filler = 'あ '.repeat(900)
    for (let index = 0; index < 40; index += 1) {
      appendHerdrJobMonitorStatus(state, record.id, `${index}:${filler}`)
    }
    expect(statSync(join(directory, 'status.0.feed')).size).toBeGreaterThan(64 * 1024)
    await sealAndObserveFinalMarker(state, record.id, control)
    control.drainDirectory(directory)
    control.generationStatus = 'dead'
    control.process!.foregroundProcesses = []

    await closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'completed', control,
    })
    expect(control.closeCalls).toBe(1)
    expect(existsSync(directory)).toBe(false)
  })

  test('viewerがdeadで未読feedが残る場合はexact paneでもcloseしない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    await sealAndObserveFinalMarker(state, record.id, control)
    control.drainDirectory(join(state, 'job-monitors', record.id))
    control.autoDrain = false
    appendHerdrJobMonitorChunk(state, record.id, 'stdout', Buffer.from('not-yet-rendered\n'))
    control.generationStatus = 'dead'
    control.process!.foregroundProcesses = []
    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })).rejects.toThrow('undrained output')
    expect(control.closeCalls).toBe(0)
  })

  test('viewer generationがunknownならtabをcloseしない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.generationStatus = 'unknown'
    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })).rejects.toThrow('state is unknown')
    expect(control.closeCalls).toBe(0)
  })

  test('dead viewerのpaneが別processへ置換済みならcloseしない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    await sealAndObserveFinalMarker(state, record.id, control)
    control.drainDirectory(join(state, 'job-monitors', record.id))
    control.generationStatus = 'dead'
    control.process!.foregroundProcesses = [{
      pid: 9999,
      argv: ['/usr/bin/other'],
      cwd: control.panes[0]!.cwd,
    }]
    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'failed', control,
    })).rejects.toThrow('was replaced before close')
    expect(control.closeCalls).toBe(0)
  })

  test('final feedをviewerがackする前に停止したらtabを閉じない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.autoDrain = false
    control.dieAfterGenerationChecks = control.generationChecks + 3
    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'completed', control,
    })).rejects.toThrow('stopped before draining')
    expect(control.closeCalls).toBe(0)
  })

  test('viewer ACK後もHerdr paneがfinal markerを観測できなければcloseしない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.suppressDrainMarker = true
    await expect(closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'completed', control,
    })).rejects.toThrow('did not observe final monitor output')
    expect(control.closeCalls).toBe(0)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(true)
    control.suppressDrainMarker = false
    await closeHerdrJobMonitor({
      stateDir: state, runtime: runtime(), jobId: record.id, outcome: 'completed', control,
    })
    expect(control.closeCalls).toBe(1)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(false)
  })

  test('実行中にmonitor tabが消失したらhealth watcherが検知する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const abort = new AbortController()
    const watching = watchHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      signal: abort.signal,
      intervalMs: 10,
      control,
    })
    await Bun.sleep(15)
    control.tabs.splice(0)
    control.panes.splice(0)
    await expect(watching).rejects.toThrow('binding is ambiguous')
    abort.abort()
  })

  test('viewer processがliveでもheartbeatが前進しなければ検知する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.autoDrain = false
    const progressPath = join(state, 'job-monitors', record.id, 'progress.json')
    const progress = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>
    progress.updatedAt = 1
    writeFileSync(progressPath, `${JSON.stringify(progress)}\n`, { mode: 0o600 })
    const abort = new AbortController()
    await expect(watchHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      signal: abort.signal,
      intervalMs: 10,
      progressGraceMs: 20,
      control,
    })).rejects.toThrow('heartbeat is unavailable')
    abort.abort()
  })

  test('fresh timestampでもcurrent feed generation未確認ならhealthyにしない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.autoDrain = false
    const directory = join(state, 'job-monitors', record.id)
    writeFileSync(join(directory, 'stdout.1.feed'), 'next generation\n', { mode: 0o600 })
    const epochPath = join(directory, 'stdout.epoch.json')
    const epoch = JSON.parse(readFileSync(epochPath, 'utf8')) as Record<string, unknown>
    epoch.generation = 1
    writeFileSync(epochPath, `${JSON.stringify(epoch)}\n`, { mode: 0o600 })
    const progressPath = join(directory, 'progress.json')
    const progress = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>
    progress.updatedAt = Date.now()
    writeFileSync(progressPath, `${JSON.stringify(progress)}\n`, { mode: 0o600 })

    const abort = new AbortController()
    await expect(watchHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      signal: abort.signal,
      intervalMs: 10,
      progressGraceMs: 20,
      control,
    })).rejects.toThrow('heartbeat is unavailable')
    abort.abort()
  })

  test('再開時のactive monitorはfresh heartbeat確認前に採択しない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    control.autoDrain = false
    const progressPath = join(state, 'job-monitors', record.id, 'progress.json')
    const progress = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>
    progress.updatedAt = 1
    writeFileSync(progressPath, `${JSON.stringify(progress)}\n`, { mode: 0o600 })

    await expect(openHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      job: record,
      progressGraceMs: 20,
      control,
    })).rejects.toThrow('heartbeat is unavailable')
    await expect(reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'queued' }),
      progressGraceMs: 20,
      control,
    })).rejects.toThrow('heartbeat is unavailable')
  })

  test('drain済みfeedだけをrotationし未読出力を捨てない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const directory = join(state, 'job-monitors', record.id)
    appendHerdrJobMonitorChunk(
      state,
      record.id,
      'stdout',
      Buffer.alloc(20 * 1024 * 1024 - 1024, 0x78),
    )
    await expect(Promise.resolve().then(() => appendHerdrJobMonitorChunk(
      state,
      record.id,
      'stdout',
      Buffer.alloc(2048, 0x79),
    ))).rejects.toThrow('before the viewer drained it')
    control.drainDirectory(directory)
    appendHerdrJobMonitorChunk(
      state,
      record.id,
      'stdout',
      Buffer.alloc(2048, 0x79),
    )
    const epoch = JSON.parse(readFileSync(join(directory, 'stdout.epoch.json'), 'utf8')) as {
      generation: number
      rotating: boolean
      droppedBytes: number
    }
    expect(epoch.generation).toBe(1)
    expect(epoch.rotating).toBe(false)
    expect(epoch.droppedBytes).toBeGreaterThan(0)
    expect(statSync(join(directory, `stdout.${epoch.generation}.feed`)).size)
      .toBeLessThanOrEqual(20 * 1024 * 1024)
    const rotatedPrefix = readFileSync(
      join(directory, `stdout.${epoch.generation}.feed`),
    ).subarray(0, 160).toString('utf8')
    expect(rotatedPrefix).toMatch(
      /^\n\[(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d JST\] stdout の表示上限に達したため古い出力を省略しました\n/,
    )
    expect(rotatedPrefix).not.toContain('[Zeroちゃん')
    // Keep the acknowledged old path until the viewer has observed the new
    // epoch; this closes the epoch-read/feed-open race.
    expect(existsSync(join(directory, 'stdout.0.feed'))).toBe(true)
    control.drainDirectory(directory)
    appendHerdrJobMonitorChunk(state, record.id, 'stdout', Buffer.from('after-ack\n'))
    expect(existsSync(join(directory, 'stdout.0.feed'))).toBe(false)
  })

  test('feed上限末尾の未完UTF-8を次generationへcarryしてcontinuationを失わない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const directory = join(state, 'job-monitors', record.id)
    const limit = 20 * 1024 * 1024
    const initial = Buffer.alloc(limit, 0x78)
    initial[initial.byteLength - 1] = 0xe3
    appendHerdrJobMonitorChunk(state, record.id, 'stdout', initial)
    const progressPath = join(directory, 'progress.json')
    const progress = JSON.parse(readFileSync(progressPath, 'utf8')) as {
      streams: { stdout: { generation: number; offset: number } }
      updatedAt: number
    }
    progress.streams.stdout = { generation: 0, offset: limit - 1 }
    progress.updatedAt = Date.now()
    writeFileSync(progressPath, `${JSON.stringify(progress)}\n`, { mode: 0o600 })

    appendHerdrJobMonitorChunk(
      state,
      record.id,
      'stdout',
      Buffer.from([0x81, 0x82]),
    )
    const epoch = JSON.parse(readFileSync(join(directory, 'stdout.epoch.json'), 'utf8')) as {
      generation: number
      droppedBytes: number
    }
    expect(epoch).toMatchObject({ generation: 1, droppedBytes: limit - 1 })
    const rotated = readFileSync(join(directory, 'stdout.1.feed'))
    expect(rotated.subarray(-3).toString('utf8')).toBe('あ')
  })

  test('carry済みgenerationのpointer更新前crashでもdroppedBytesを過大計上しない', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const directory = join(state, 'job-monitors', record.id)
    const limit = 20 * 1024 * 1024
    const initial = Buffer.alloc(limit, 0x78)
    initial[initial.byteLength - 1] = 0xe3
    appendHerdrJobMonitorChunk(state, record.id, 'stdout', initial)
    const progressPath = join(directory, 'progress.json')
    const progress = JSON.parse(readFileSync(progressPath, 'utf8')) as {
      streams: { stdout: { generation: number; offset: number } }
      updatedAt: number
    }
    progress.streams.stdout = { generation: 0, offset: limit - 1 }
    progress.updatedAt = Date.now()
    writeFileSync(progressPath, `${JSON.stringify(progress)}\n`, { mode: 0o600 })
    writeFileSync(
      join(directory, 'stdout.1.feed'),
      Buffer.concat([Buffer.from('[rotation]\n'), Buffer.from([0xe3, 0x81, 0x82])]),
      { mode: 0o600 },
    )

    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const epoch = JSON.parse(readFileSync(join(directory, 'stdout.epoch.json'), 'utf8')) as {
      generation: number
      droppedBytes: number
    }
    expect(epoch).toMatchObject({ generation: 1, droppedBytes: limit - 1 })
  })

  test('rotation file完成後epoch更新前のcrashを新generationへ回復する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const directory = join(state, 'job-monitors', record.id)
    writeFileSync(
      join(directory, 'stdout.1.feed'),
      '[Zeroちゃん] recovered staged generation\nnext chunk\n',
      { mode: 0o600 },
    )

    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const epoch = JSON.parse(readFileSync(join(directory, 'stdout.epoch.json'), 'utf8')) as {
      generation: number
    }
    expect(epoch.generation).toBe(1)
    expect(readFileSync(join(directory, 'stdout.1.feed'), 'utf8')).toContain('next chunk')
    expect(existsSync(join(directory, 'stdout.0.feed'))).toBe(true)
    appendHerdrJobMonitorChunk(state, record.id, 'stdout', Buffer.from('after-recovery\n'))
    expect(existsSync(join(directory, 'stdout.0.feed'))).toBe(false)
  })

  test('terminal startup reconcileもstaged generationをdrainしてから閉じる', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const directory = join(state, 'job-monitors', record.id)
    writeFileSync(join(directory, 'stdout.1.feed'), 'staged terminal output\n', { mode: 0o600 })

    const result = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'completed' }),
      control,
    })
    expect(result).toEqual({ retained: 0, closed: 1, retainedJobIds: [] })
    expect(control.lastDrainedGenerations.stdout).toBe(1)
    expect(control.closeCalls).toBe(1)
    expect(existsSync(directory)).toBe(false)
  })

  test('rotation途中のpartial tempだけなら現generationを保持して除去する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const directory = join(state, 'job-monitors', record.id)
    const temporary = join(
      directory,
      'stdout.1.feed.tmp-123-00000000-0000-4000-8000-000000000000',
    )
    writeFileSync(temporary, 'partial', { mode: 0o600 })

    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const epoch = JSON.parse(readFileSync(join(directory, 'stdout.epoch.json'), 'utf8')) as {
      generation: number
    }
    expect(epoch.generation).toBe(0)
    expect(existsSync(join(directory, 'stdout.0.feed'))).toBe(true)
    expect(existsSync(temporary)).toBe(false)
  })

  test('旧in-place rotationのcrash stateは推測で解除せずfail closedにする', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job()
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const epochPath = join(state, 'job-monitors', record.id, 'stdout.epoch.json')
    const epoch = JSON.parse(readFileSync(epochPath, 'utf8')) as Record<string, unknown>
    epoch.rotating = true
    writeFileSync(epochPath, `${JSON.stringify(epoch)}\n`, { mode: 0o600 })

    await expect(openHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      job: record,
      control,
    })).rejects.toThrow('unfinished legacy rotation')
  })

  test('失敗monitorはdrain後にtabを残し、次queue用obligationだけをretireする', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job({ status: 'failed', terminalOutcome: 'failed', lastError: 'private detail' })
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const retired: string[] = []

    const disposition = await retainFailedHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      publicReason: '補助レビューの回答と保存履歴を照合できませんでした。',
      onMonitorRetired: id => { retired.push(id) },
      control,
    })

    expect(disposition).toBe('retained')
    expect(control.closeCalls).toBe(0)
    expect(control.tabs).toHaveLength(1)
    expect(retired).toEqual([record.id])
    const directory = join(state, 'job-monitors', record.id)
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
      phase: string
    }
    expect(manifest.phase).toBe('retained-failure')
    const statusEpoch = JSON.parse(
      readFileSync(join(directory, 'status.epoch.json'), 'utf8'),
    ) as { generation: number; sealed: boolean }
    const status = readFileSync(
      join(directory, `status.${statusEpoch.generation}.feed`),
      'utf8',
    )
    expect(statusEpoch.sealed).toBe(true)
    expect(status).toContain('補助レビューの回答と保存履歴を照合できませんでした。')
    expect(status).toContain('確認用にこのタブを残します')
    expect(status).not.toContain('private detail')

    const restarted = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'failed' }),
      control,
    })
    expect(restarted).toEqual({ retained: 1, closed: 0, retainedJobIds: [] })
    expect(control.closeCalls).toBe(0)
  })

  test('DB失敗確定直後の再起動はactive monitorをretained failureへ収束する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job({ status: 'failed', terminalOutcome: 'failed' })
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    let retired = 0

    const result = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'failed', terminalOutcome: 'failed' }),
      publicFailureReason: () => '補助レビューの回答と保存履歴を照合できませんでした。',
      onMonitorRetired: () => { retired += 1 },
      control,
    })

    expect(result).toEqual({ retained: 1, closed: 0, retainedJobIds: [] })
    expect(retired).toBe(1)
    expect(control.closeCalls).toBe(0)
    const manifest = JSON.parse(readFileSync(
      join(state, 'job-monitors', record.id, 'manifest.json'),
      'utf8',
    )) as { phase: string }
    expect(manifest.phase).toBe('retained-failure')
  })

  test('旧版がsealしたfinal markerからの再起動も失敗tab保持へ収束する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job({ status: 'failed', terminalOutcome: 'failed' })
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const directory = join(state, 'job-monitors', record.id)
    const legacyMarker = '表示を終了します'
    appendFileSync(join(directory, 'status.0.feed'), `[Zeroちゃん] ${legacyMarker}\n`)
    const epochPath = join(directory, 'status.epoch.json')
    const epoch = JSON.parse(readFileSync(epochPath, 'utf8')) as Record<string, unknown>
    writeFileSync(epochPath, `${JSON.stringify({ ...epoch, sealed: true })}\n`, { mode: 0o600 })
    control.drainDirectory(directory)

    const result = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'failed', terminalOutcome: 'failed' }),
      publicFailureReason: () => '内部処理でエラーが発生しました。',
      control,
    })

    expect(result).toEqual({ retained: 1, closed: 0, retainedJobIds: [] })
    expect(control.closeCalls).toBe(0)
    const manifest = JSON.parse(readFileSync(
      join(directory, 'manifest.json'),
      'utf8',
    )) as { phase: string }
    expect(manifest.phase).toBe('retained-failure')
  })

  test('旧prefixと現行final markerからの再起動も失敗tab保持へ収束する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job({
      id: 'legacy-prefix-current-marker',
      status: 'failed',
      terminalOutcome: 'failed',
    })
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    const directory = join(state, 'job-monitors', record.id)
    appendFileSync(
      join(directory, 'status.0.feed'),
      `[Zeroちゃん] ${HERDR_MONITOR_DRAIN_TEXT}\n`,
    )
    const epochPath = join(directory, 'status.epoch.json')
    const epoch = JSON.parse(readFileSync(epochPath, 'utf8')) as Record<string, unknown>
    writeFileSync(epochPath, `${JSON.stringify({ ...epoch, sealed: true })}\n`, { mode: 0o600 })
    control.drainDirectory(directory)

    const result = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'failed', terminalOutcome: 'failed' }),
      publicFailureReason: () => '内部処理でエラーが発生しました。',
      control,
    })

    expect(result).toEqual({ retained: 1, closed: 0, retainedJobIds: [] })
    expect(control.closeCalls).toBe(0)
    const manifest = JSON.parse(readFileSync(
      join(directory, 'manifest.json'),
      'utf8',
    )) as { phase: string }
    expect(manifest.phase).toBe('retained-failure')
  })

  test('確認済みの失敗tabを利用者が閉じたらstateだけを回収する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job({ status: 'failed', terminalOutcome: 'failed' })
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    await retainFailedHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      publicReason: '内部処理でエラーが発生しました。',
      control,
    })
    control.tabs.splice(0)
    control.panes.splice(0)
    control.generationStatus = 'dead'
    if (control.process) control.process.foregroundProcesses = []
    let retired = 0

    const result = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'failed' }),
      onMonitorRetired: () => { retired += 1 },
      control,
    })

    expect(result).toEqual({ retained: 0, closed: 1, retainedJobIds: [] })
    expect(retired).toBe(1)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(false)
  })

  test('確認済み失敗tabのviewer停止後はtabを操作せずstateだけを回収する', async () => {
    const state = fixtureDirectory()
    const control = new FakeControl()
    const record = job({ status: 'failed', terminalOutcome: 'failed' })
    await openHerdrJobMonitor({ stateDir: state, runtime: runtime(), job: record, control })
    await retainFailedHerdrJobMonitor({
      stateDir: state,
      runtime: runtime(),
      jobId: record.id,
      publicReason: '内部処理でエラーが発生しました。',
      control,
    })
    control.generationStatus = 'dead'
    control.process!.foregroundProcesses = [{
      pid: 9001,
      argv: ['/bin/zsh'],
      cwd: control.panes[0]!.cwd,
    }]
    let retired = 0

    const result = await reconcileHerdrJobMonitors({
      stateDir: state,
      runtime: runtime(),
      getJob: () => ({ status: 'failed' }),
      onMonitorRetired: () => { retired += 1 },
      control,
    })

    expect(result).toEqual({ retained: 0, closed: 1, retainedJobIds: [] })
    expect(retired).toBe(1)
    expect(control.closeCalls).toBe(0)
    expect(control.tabs).toHaveLength(1)
    expect(existsSync(join(state, 'job-monitors', record.id))).toBe(false)
  })

  test('terminal injectionとbidi制御文字を表示前に除去する', () => {
    expect(stripTerminalControls(
      'a\u001b]0;title\u0007b\u001b[31mc\u001b[0m\u061C\u200E\u200F\u202Ed\u0001',
    )).toBe('abcd')
  })

  test('UTF-8途中byteはterminalへ書くまでread offsetとしてACKしない', () => {
    expect(completeUtf8PrefixLength(Buffer.from([0xe3, 0x81]))).toBe(0)
    expect(completeUtf8PrefixLength(Buffer.from([0xe3, 0x81, 0x82]))).toBe(3)
    expect(completeUtf8PrefixLength(Buffer.from('ascii'))).toBe(5)
  })

  test('Herdr control-plane childへSlack tokenやagent環境を渡さない', () => {
    const environment = buildHerdrMonitorControlEnvironment(runtime(), {
      HOME: '/Users/tester',
      USER: 'tester',
      LOGNAME: 'tester',
      SLACK_BOT_TOKEN: 'xoxb-secret',
      SLACK_APP_TOKEN: 'xapp-secret',
      CODEX_HOME: '/private/codex',
      CLAUDE_CONFIG_DIR: '/private/claude',
    })
    expect(environment.HOME).toBe('/Users/tester')
    expect(environment.HERDR_SOCKET_PATH).toBe(runtime().socketPath)
    expect(environment.SLACK_BOT_TOKEN).toBeUndefined()
    expect(environment.SLACK_APP_TOKEN).toBeUndefined()
    expect(environment.CODEX_HOME).toBeUndefined()
    expect(environment.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  test('Herdr control outputは全量buffer化前に上限超過を拒否する', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(8, 0x61))
        controller.enqueue(Buffer.alloc(8, 0x62))
        controller.close()
      },
    })
    await expect(readBoundedHerdrOutput(stream, 12)).rejects.toThrow('exceeded its bound')
  })

  test.skipIf(process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    '実viewerはterminal write完了後のoffsetをprogressへ記録する', async () => {
    const state = fixtureDirectory()
    const directory = join(state, 'job-monitors', 'real-viewer')
    mkdirSync(join(state, 'job-monitors'), { mode: 0o700 })
    mkdirSync(directory, { mode: 0o700 })
    const operationId = '0123456789abcdef0123456789abcdef'
    writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify({
      version: 1,
      jobId: 'real-viewer',
      seq: 11,
      operationId,
      phase: 'run-intent',
    })}\n`, { mode: 0o600 })
    for (const kind of ['status', 'stdout', 'stderr']) {
      writeFileSync(join(directory, `${kind}.epoch.json`), `${JSON.stringify({
        version: 1,
        generation: 0,
        rotating: false,
        sealed: false,
        droppedBytes: 0,
      })}\n`, { mode: 0o600 })
      writeFileSync(join(directory, `${kind}.0.feed`), '', { mode: 0o600 })
    }
    const child = Bun.spawn([
      process.execPath,
      '--config=/dev/null',
      '--no-env-file',
      join(import.meta.dir, 'herdr-job-monitor-view.ts'),
    ], {
      cwd: directory,
      env: { PATH: '/usr/bin:/bin', TERM: 'dumb' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let stdout = ''
    let stderr = ''
    const collect = async (stream: ReadableStream<Uint8Array>, target: 'stdout' | 'stderr') => {
      const text = await new Response(stream).text()
      if (target === 'stdout') stdout = text
      else stderr = text
    }
    const output = Promise.all([
      collect(child.stdout, 'stdout'),
      collect(child.stderr, 'stderr'),
    ])
    try {
      await waitUntil(() => existsSync(join(directory, 'ready.json'))
        && existsSync(join(directory, 'progress.json')))
      appendFileSync(join(directory, 'stdout.0.feed'), Buffer.from([0xe3, 0x81]))
      await Bun.sleep(150)
      const partialProgress = JSON.parse(readFileSync(
        join(directory, 'progress.json'),
        'utf8',
      )) as { streams: { stdout: { offset: number } } }
      expect(partialProgress.streams.stdout.offset).toBe(0)
      appendFileSync(join(directory, 'stdout.0.feed'), Buffer.from([0x82]))
      await waitUntil(() => {
        const progress = JSON.parse(readFileSync(
          join(directory, 'progress.json'),
          'utf8',
        )) as { streams: { stdout: { offset: number } } }
        return progress.streams.stdout.offset === 3
      })
      const stdoutValue = 'visible\u001b[31m-red\u001b[0m\n'
      const stderrValue = 'warning-line\n'
      appendFileSync(join(directory, 'stdout.0.feed'), stdoutValue)
      appendFileSync(
        join(directory, 'stderr.0.feed'),
        Buffer.concat([Buffer.from(stderrValue), Buffer.from([0xe3, 0x81])]),
      )
      await waitUntil(() => {
        const progress = JSON.parse(readFileSync(
          join(directory, 'progress.json'),
          'utf8',
        )) as { streams: { stdout: { offset: number }; stderr: { offset: number } } }
        return progress.streams.stdout.offset === 3 + Buffer.byteLength(stdoutValue)
          && progress.streams.stderr.offset === Buffer.byteLength(stderrValue)
      })
      const stderrEpochPath = join(directory, 'stderr.epoch.json')
      const stderrEpoch = JSON.parse(readFileSync(stderrEpochPath, 'utf8')) as Record<string, unknown>
      stderrEpoch.sealed = true
      atomicWritePrivateFile(stderrEpochPath, `${JSON.stringify(stderrEpoch)}\n`)
      await waitUntil(() => {
        const progress = JSON.parse(readFileSync(
          join(directory, 'progress.json'),
          'utf8',
        )) as { streams: { stderr: { offset: number } } }
        return progress.streams.stderr.offset === Buffer.byteLength(stderrValue) + 2
      })
      appendFileSync(
        join(directory, 'status.0.feed'),
        formatHerdrMonitorLine(HERDR_MONITOR_DRAIN_TEXT, Date.parse('2026-08-29T15:04:05.000Z')),
      )
      for (const kind of ['stdout', 'status']) {
        const path = join(directory, `${kind}.epoch.json`)
        const epoch = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        epoch.sealed = true
        atomicWritePrivateFile(path, `${JSON.stringify(epoch)}\n`)
      }
      await waitUntil(() => {
        const progress = JSON.parse(readFileSync(
          join(directory, 'progress.json'),
          'utf8',
        )) as { streams: Record<string, { offset: number }> }
        return ['stdout', 'stderr', 'status'].every(kind => (
          progress.streams[kind]!.offset === statSync(join(directory, `${kind}.0.feed`)).size
        ))
      })
      const frozenProgress = readFileSync(join(directory, 'progress.json'), 'utf8')
      await Bun.sleep(1_200)
      expect(readFileSync(join(directory, 'progress.json'), 'utf8')).toBe(frozenProgress)
    } finally {
      child.kill('SIGTERM')
      await child.exited
      await output
    }
    expect(stdout.startsWith('\x1b[3J\x1b[2J\x1b[H')).toBe(true)
    expect(stdout).toMatch(
      new RegExp(`\\[(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d JST\\] ${HERDR_MONITOR_READY_TEXT}`),
    )
    expect(stdout).not.toContain('[Zeroちゃん]')
    expect(stdout).not.toContain(operationId)
    expect(stdout).not.toContain('ZEROCHAN_MONITOR_')
    expect(stdout).toContain('あ')
    expect(stdout).toContain('visible-red')
    expect(stdout).not.toContain('\u001b[31m')
    expect(stderr).toContain('warning-line')
    expect(stderr).toContain('\uFFFD')
    },
    15_000,
  )
})
