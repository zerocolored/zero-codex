import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  armClaudeAdvisorPrompt,
  assertClaudeQueueReady,
  ClaudeContextClearPendingError,
  emptyClaudePrompt,
  finalizeClaudeQueueJob,
  cancelClaudeQueueJob,
  prepareClaudeAdvisorTarget,
  readClaudeQueueBoundary,
  reconcileClaudeQueueBoundary,
  recordClaudeAdvisorDelivered,
  recordClaudeAdvisorRejected,
  recordClaudeAdvisorSettled,
  type ClaudeAgentSnapshot,
  type ClaudeHerdrControl,
} from './claude-queue-boundary.ts'
import type { HerdrRuntimeIdentity } from './herdr-runtime.ts'

const temporaryDirs: string[] = []

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(): { state: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'zerochan-claude-boundary-'))
  temporaryDirs.push(root)
  chmodSync(root, 0o700)
  const state = join(root, 'state')
  const repo = join(root, 'repo')
  mkdirSync(state, { mode: 0o700 })
  mkdirSync(repo, { mode: 0o700 })
  const initialized = Bun.spawnSync(['git', 'init', '--initial-branch=main', repo], {
    stdout: 'pipe', stderr: 'pipe',
  })
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString())
  return { state, repo: realpathSync(repo) }
}

const runtime: HerdrRuntimeIdentity = {
  binary: '/usr/bin/false',
  binaryDevice: 1,
  binaryInode: 1,
  binaryMode: 0o100700,
  binarySize: 1,
  binaryModifiedMs: 1,
  binaryChangedMs: 1,
  socketPath: '/tmp/not-used.sock',
  socketDevice: 1,
  socketInode: 1,
  paneId: 'wT:p1',
  tabId: 'wT:t1',
  terminalId: 'term_111111',
  workspaceId: 'wT',
}

class FakeClaudeControl implements ClaudeHerdrControl {
  agent: ClaudeAgentSnapshot
  visible = 'Claude Code\n❯\n⏵⏵ bypass permissions on'
  clearCalls = 0
  interruptCalls = 0
  interruptMode: 'success' | 'throw' = 'success'
  clearMode: 'success' | 'change-then-throw' | 'throw' = 'success'
  advanceSequenceOnClear = true

  constructor(cwd: string) {
    this.agent = {
      agent: 'claude',
      nativeSessionId: 'session-1',
      agentStatus: 'done',
      cwd,
      paneId: 'wT:p2',
      tabId: 'wT:t2',
      terminalId: 'term_222222',
      workspaceId: 'wT',
      stateChangeSeq: 10,
    }
  }

  async listAgents(): Promise<ClaudeAgentSnapshot[]> {
    return [{ ...this.agent }]
  }

  async getAgent(): Promise<ClaudeAgentSnapshot> {
    return { ...this.agent }
  }

  async readVisible(): Promise<string> {
    return this.visible
  }

  async clearAgent(): Promise<void> {
    this.clearCalls += 1
    if (this.clearMode !== 'throw') {
      const number = Number(this.agent.nativeSessionId.split('-').at(-1)) + 1
      this.agent.nativeSessionId = `session-${number}`
      if (this.advanceSequenceOnClear) this.agent.stateChangeSeq += 2
      this.agent.agentStatus = 'done'
      this.visible = 'Claude Code welcome\n❯\n⏵⏵ bypass permissions on'
    }
    if (this.clearMode !== 'success') throw new Error('simulated Herdr transport loss')
  }

  async interruptAgent(): Promise<void> {
    this.interruptCalls += 1
    if (this.interruptMode === 'throw') throw new Error('simulated interrupt transport loss')
    this.agent.stateChangeSeq += 1
    this.agent.agentStatus = 'done'
    this.visible = 'Claude interrupted\n❯\n⏵⏵ bypass permissions on'
  }
}

const timing = {
  stableDelayMs: 0,
  pollMs: 0,
  settleTimeoutMs: 20,
  clearConfirmationTimeoutMs: 20,
}

describe('Claude queue boundary', () => {
  test('status barがpromptより下でも空promptを検出し、dialogやdraftは拒否する', () => {
    expect(emptyClaudePrompt('old output\n❯\n⏵⏵ bypass permissions on')).toBe(true)
    expect(emptyClaudePrompt('old answer discussed rate limit and permission required\n❯\n⏵⏵ bypass permissions on')).toBe(true)
    expect(emptyClaudePrompt('old output\n❯\nstatus bar')).toBe(false)
    expect(emptyClaudePrompt('old output\n❯ draft\nstatus bar')).toBe(false)
    expect(emptyClaudePrompt('How is Claude doing this session?\n1: Bad\n2: Fine\n3: Good\n0: Dismiss\n❯')).toBe(false)
    expect(emptyClaudePrompt('How is Claude doing this session?\n0: Dismiss\n❯')).toBe(false)
    expect(emptyClaudePrompt('Allow this action\n❯')).toBe(false)
    expect(emptyClaudePrompt('old output\n❯\nUnknown question\n1: Yes  2: No')).toBe(false)
  })

  test('job固有Claude reservationが無ければterminal化を拒否する', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    await expect(finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-1', control, timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(control.clearCalls).toBe(0)
  })

  test('visible read中にClaude sequenceが進んだらstable emptyとして採択しない', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-sequence-race',
      attemptNonce: 'd'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    await finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-sequence-race', control, timing,
    })
    const clearCalls = control.clearCalls
    const originalRead = control.readVisible.bind(control)
    let advanced = false
    control.readVisible = async () => {
      const visible = await originalRead()
      if (!advanced) {
        advanced = true
        control.agent.stateChangeSeq += 1
        control.agent.agentStatus = 'working'
      }
      return visible
    }

    await expect(assertClaudeQueueReady({ stateDir: state, runtime, control, timing }))
      .rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(control.clearCalls).toBe(clearCalls)
  })

  test('2回目のvisible read中にClaude sequenceが進んでもstable emptyとして採択しない', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-second-sequence-race',
      attemptNonce: 'e'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    await finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-second-sequence-race', control, timing,
    })
    const clearCalls = control.clearCalls
    const originalRead = control.readVisible.bind(control)
    let reads = 0
    control.readVisible = async () => {
      const visible = await originalRead()
      reads += 1
      if (reads === 2) {
        control.agent.stateChangeSeq += 1
        control.agent.agentStatus = 'working'
      }
      return visible
    }

    await expect(assertClaudeQueueReady({ stateDir: state, runtime, control, timing }))
      .rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(reads).toBe(2)
    expect(control.clearCalls).toBe(clearCalls)
  })

  test('Claude候補なしはjob単位でbest-effort skipを固定し次jobだけ再探索する', async () => {
    const { state, repo } = fixture()
    const absentControl = new FakeClaudeControl(repo)
    absentControl.listAgents = async () => []

    const skipped = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-no-claude',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control: absentControl,
      timing,
    })
    expect(skipped).toMatchObject({ skipped: true, reason: 'eligible Claude count is 0' })
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'job-no-claude', jobId: 'job-no-claude',
    })
    await expect(assertClaudeQueueReady({ stateDir: state, runtime, control: absentControl, timing }))
      .rejects.toBeInstanceOf(ClaudeContextClearPendingError)

    const newlyAppearedControl = new FakeClaudeControl(repo)
    const repeated = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-no-claude',
      attemptNonce: 'b'.repeat(32),
      repoRoot: repo,
      control: newlyAppearedControl,
      timing,
    })
    expect(repeated.skipped).toBe(true)
    expect(newlyAppearedControl.clearCalls).toBe(0)

    await finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-no-claude', control: absentControl, timing,
    })
    expect(readClaudeQueueBoundary(state)?.status).toBe('ready-no-target')
    await assertClaudeQueueReady({ stateDir: state, runtime, control: absentControl, timing })

    const next = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-with-claude',
      attemptNonce: 'c'.repeat(32),
      repoRoot: repo,
      control: newlyAppearedControl,
      timing,
    })
    expect(next.target).toBeDefined()
    expect(newlyAppearedControl.clearCalls).toBe(1)
  })

  test('rate-limit再開は同じjobのClaude無しskip境界を維持して再claimできる', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    control.listAgents = async () => []
    const skipped = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-rate-limit-skip',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    expect(skipped.skipped).toBe(true)
    await expect(assertClaudeQueueReady({
      stateDir: state,
      runtime,
      continuingJobId: 'job-rate-limit-skip',
      control,
      timing,
    })).resolves.toBeUndefined()
    await expect(assertClaudeQueueReady({
      stateDir: state,
      runtime,
      continuingJobId: 'different-job',
      control,
      timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
  })

  test('Claude候補が複数なら任意選択もclearもせずjob単位でskipする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const second = {
      ...control.agent,
      agent: 'claude-second',
      nativeSessionId: 'session-second',
      paneId: 'wT:p3',
      tabId: 'wT:t3',
      terminalId: 'term_333333',
      stateChangeSeq: 20,
    }
    control.listAgents = async () => [{ ...control.agent }, { ...second }]

    const skipped = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-multiple-claude',
      attemptNonce: 'f'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    expect(skipped).toMatchObject({ skipped: true, reason: 'eligible Claude count is 2' })
    expect(control.clearCalls).toBe(0)
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'job-no-claude',
      jobId: 'job-multiple-claude',
      reason: 'eligible Claude count is 2',
    })

    await finalizeClaudeQueueJob({
      stateDir: state,
      runtime,
      jobId: 'job-multiple-claude',
      control,
      timing,
    })
    expect(control.clearCalls).toBe(0)
    expect(readClaudeQueueBoundary(state)?.status).toBe('ready-no-target')
  })

  test('空promptへのclearでsequence不変でも新sessionと安定空promptをreceiptにする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    control.advanceSequenceOnClear = false
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    expect(prepared.target).toMatchObject({ nativeSessionId: 'session-2', stateChangeSeq: 10 })
    await finalizeClaudeQueueJob({ stateDir: state, runtime, jobId: 'job-1', control, timing })
    expect(control.clearCalls).toBe(2)
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'ready', target: { nativeSessionId: 'session-3', stateChangeSeq: 10 },
    })
  })

  test('初回はpreflight clearし、task prompt後はjob-end clear確認までreadyに戻さない', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    expect(prepared.target, prepared.reason).toBeDefined()
    expect(prepared.target?.nativeSessionId).toBe('session-2')
    expect(control.clearCalls).toBe(1)
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'job-active', jobId: 'job-1', promptState: 'none',
    })

    armClaudeAdvisorPrompt(state, 'job-1', 'a'.repeat(32), prepared.target!)
    recordClaudeAdvisorDelivered(state, 'job-1', 'a'.repeat(32))
    control.agent.stateChangeSeq += 2
    recordClaudeAdvisorSettled(state, 'job-1', control.agent)
    await finalizeClaudeQueueJob({ stateDir: state, runtime, jobId: 'job-1', control, timing })

    expect(control.clearCalls).toBe(2)
    expect(control.agent.nativeSessionId).toBe('session-3')
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'ready', target: { nativeSessionId: 'session-3' },
    })
  })

  test('中止は予約済みworking ClaudeへCtrl-Cを一度だけ送りsettle後にclearする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-cancel',
      attemptNonce: 'c'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(state, 'job-cancel', 'c'.repeat(32), prepared.target!)
    recordClaudeAdvisorDelivered(state, 'job-cancel', 'c'.repeat(32))
    control.agent.agentStatus = 'working'
    control.agent.stateChangeSeq += 1

    await cancelClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-cancel', control, timing,
    })

    expect(control.interruptCalls).toBe(1)
    expect(control.clearCalls).toBe(2)
    expect(readClaudeQueueBoundary(state)).toMatchObject({ status: 'ready' })
  })

  test('cancel intent永続化後にoccupantが変わったらCtrl-Cを送らずfail-closeする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-cancel-toctou',
      attemptNonce: '7'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(state, 'job-cancel-toctou', '7'.repeat(32), prepared.target!)
    recordClaudeAdvisorDelivered(state, 'job-cancel-toctou', '7'.repeat(32))
    control.agent.agentStatus = 'working'
    control.agent.stateChangeSeq += 1
    const originalGet = control.getAgent.bind(control)
    let reads = 0
    control.getAgent = async () => {
      reads += 1
      if (reads === 2) control.agent.nativeSessionId = 'replacement-session'
      return originalGet()
    }

    await expect(cancelClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-cancel-toctou', control, timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(reads).toBe(2)
    expect(control.interruptCalls).toBe(0)
    expect(control.clearCalls).toBe(1)
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'cancel-intent', jobId: 'job-cancel-toctou',
    })
  })

  test('startup reconcileはdurable中止flagを見て通常settleでなくClaude cancelへ進む', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-startup-cancel',
      attemptNonce: '2'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(state, 'job-startup-cancel', '2'.repeat(32), prepared.target!)
    recordClaudeAdvisorDelivered(state, 'job-startup-cancel', '2'.repeat(32))
    control.agent.agentStatus = 'working'
    control.agent.stateChangeSeq += 1

    await reconcileClaudeQueueBoundary({
      stateDir: state,
      runtime,
      control,
      timing,
      cancelRequested: jobId => jobId === 'job-startup-cancel',
    })

    expect(control.interruptCalls).toBe(1)
    expect(control.clearCalls).toBe(2)
    expect(readClaudeQueueBoundary(state)).toMatchObject({ status: 'ready' })
  })

  test('中止時に予約済みClaudeが既にidleならキーを送らずclearする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-idle-cancel',
      attemptNonce: 'd'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })

    await cancelClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-idle-cancel', control, timing,
    })

    expect(control.interruptCalls).toBe(0)
    expect(control.clearCalls).toBe(2)
    expect(readClaudeQueueBoundary(state)).toMatchObject({ status: 'ready' })
  })

  test('予約前の中止は前jobのready Claude paneを再検証も操作もしない', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'prior-job',
      attemptNonce: '1'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    await finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'prior-job', control, timing,
    })
    const clears = control.clearCalls
    control.agent.nativeSessionId = 'unrelated-new-session'
    control.agent.agentStatus = 'working'

    await cancelClaudeQueueJob({
      stateDir: state, runtime, jobId: 'cancelled-before-reserve', control, timing,
    })

    expect(control.clearCalls).toBe(clears)
    expect(control.interruptCalls).toBe(0)
    expect(readClaudeQueueBoundary(state)).toMatchObject({ status: 'ready' })
  })

  test('Ctrl-C送達が曖昧なら再送もclearもせずcancel intentでfail-closeする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-ambiguous-cancel',
      attemptNonce: 'e'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(state, 'job-ambiguous-cancel', 'e'.repeat(32), prepared.target!)
    recordClaudeAdvisorDelivered(state, 'job-ambiguous-cancel', 'e'.repeat(32))
    control.agent.agentStatus = 'working'
    control.agent.stateChangeSeq += 1
    control.interruptMode = 'throw'

    await expect(cancelClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-ambiguous-cancel', control, timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(control.interruptCalls).toBe(1)
    expect(control.clearCalls).toBe(1)
    expect(readClaudeQueueBoundary(state)).toMatchObject({ status: 'cancel-intent' })

    await expect(cancelClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-ambiguous-cancel', control, timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(control.interruptCalls).toBe(1)
    expect(control.clearCalls).toBe(1)
  })

  test('cancel intent crashは同じslotのmanual Ctrl-Cと/clear receiptだけで復旧する', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-cancel-manual-recovery',
      attemptNonce: '6'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(
      state,
      'job-cancel-manual-recovery',
      '6'.repeat(32),
      prepared.target!,
    )
    recordClaudeAdvisorDelivered(state, 'job-cancel-manual-recovery', '6'.repeat(32))
    control.agent.agentStatus = 'working'
    control.agent.stateChangeSeq += 1
    control.interruptMode = 'throw'
    await expect(cancelClaudeQueueJob({
      stateDir: state,
      runtime,
      jobId: 'job-cancel-manual-recovery',
      control,
      timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(control.interruptCalls).toBe(1)
    expect(readClaudeQueueBoundary(state)).toMatchObject({ status: 'cancel-intent' })

    const clearCalls = control.clearCalls
    control.agent.nativeSessionId = 'manual-cancel-clear-session'
    control.agent.stateChangeSeq += 2
    control.agent.agentStatus = 'done'
    control.visible = 'Claude manually interrupted and cleared\n❯\n⏵⏵ bypass permissions on'
    await cancelClaudeQueueJob({
      stateDir: state,
      runtime,
      jobId: 'job-cancel-manual-recovery',
      control,
      timing,
    })
    expect(control.interruptCalls).toBe(1)
    expect(control.clearCalls).toBe(clearCalls)
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'ready', target: { nativeSessionId: 'manual-cancel-clear-session' },
    })
  })

  test('cancel intent再開はCtrl-Cを再送せず同じoccupantのsettleを待ってclearする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-cancel-recovery',
      attemptNonce: 'f'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(state, 'job-cancel-recovery', 'f'.repeat(32), prepared.target!)
    recordClaudeAdvisorDelivered(state, 'job-cancel-recovery', 'f'.repeat(32))
    control.agent.agentStatus = 'working'
    control.agent.stateChangeSeq += 1
    control.interruptMode = 'throw'
    await expect(cancelClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-cancel-recovery', control, timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(control.interruptCalls).toBe(1)

    const originalGet = control.getAgent.bind(control)
    let reads = 0
    control.getAgent = async () => {
      reads += 1
      if (reads >= 3) {
        control.agent.agentStatus = 'done'
        control.visible = 'Claude interrupted after restart\n❯\n⏵⏵ bypass permissions on'
      }
      return originalGet()
    }
    await cancelClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-cancel-recovery', control, timing,
    })
    expect(control.interruptCalls).toBe(1)
    expect(control.clearCalls).toBe(2)
    expect(readClaudeQueueBoundary(state)).toMatchObject({ status: 'ready' })
  })

  test('rate-limit再開は同じjobのactive Claude reservationだけを通す', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-rate-limit-active',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    await expect(assertClaudeQueueReady({
      stateDir: state,
      runtime,
      continuingJobId: 'job-rate-limit-active',
      control,
      timing,
    })).resolves.toBeUndefined()
    await expect(assertClaudeQueueReady({
      stateDir: state,
      runtime,
      continuingJobId: 'different-job',
      control,
      timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
  })

  test('前jobのclean receiptが不変なら次jobのpreflight clearを省略する', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const first = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(state, 'job-1', 'a'.repeat(32), first.target!)
    recordClaudeAdvisorDelivered(state, 'job-1', 'a'.repeat(32))
    control.agent.stateChangeSeq += 2
    recordClaudeAdvisorSettled(state, 'job-1', control.agent)
    await finalizeClaudeQueueJob({ stateDir: state, runtime, jobId: 'job-1', control, timing })
    expect(control.clearCalls).toBe(2)

    const second = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-2',
      attemptNonce: 'b'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    expect(second.target?.nativeSessionId).toBe('session-3')
    expect(control.clearCalls).toBe(2)
  })

  test('前jobのcleared pane消失後はclaimを塞がず候補0件として入力なしでskipする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-before-pane-close',
      attemptNonce: '1'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    await finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-before-pane-close', control, timing,
    })
    const clearCalls = control.clearCalls
    let staleGets = 0
    control.listAgents = async () => []
    control.getAgent = async () => {
      staleGets += 1
      throw new Error('closed pane must not be queried')
    }

    await assertClaudeQueueReady({ stateDir: state, runtime, control, timing })
    const next = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-after-pane-close',
      attemptNonce: '2'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    expect(next).toMatchObject({ skipped: true, reason: 'eligible Claude count is 0' })
    expect(control.clearCalls).toBe(clearCalls)
    expect(staleGets).toBe(0)
  })

  test('前jobのclean receipt後に候補が複数なら旧paneを再clearせずjob単位でskipする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-before-multiple',
      attemptNonce: '3'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    await finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-before-multiple', control, timing,
    })
    const clearCalls = control.clearCalls
    const second: ClaudeAgentSnapshot = {
      ...control.agent,
      nativeSessionId: 'second-session',
      paneId: 'wT:p3',
      tabId: 'wT:t3',
      terminalId: 'term_333333',
      stateChangeSeq: 30,
    }
    control.listAgents = async () => [{ ...control.agent }, { ...second }]

    await assertClaudeQueueReady({ stateDir: state, runtime, control, timing })
    const next = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-after-multiple',
      attemptNonce: '4'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    expect(next).toMatchObject({ skipped: true, reason: 'eligible Claude count is 2' })
    expect(control.clearCalls).toBe(clearCalls)
  })

  test('前jobのcleared pane消失後に一意な新paneがあればpreflight clearして採択する', async () => {
    const { state, repo } = fixture()
    const oldControl = new FakeClaudeControl(repo)
    await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-before-replacement',
      attemptNonce: '5'.repeat(32),
      repoRoot: repo,
      control: oldControl,
      timing,
    })
    await finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-before-replacement', control: oldControl, timing,
    })

    const replacement = new FakeClaudeControl(repo)
    replacement.agent = {
      ...replacement.agent,
      nativeSessionId: 'replacement-1',
      paneId: 'wT:p3',
      tabId: 'wT:t3',
      terminalId: 'term_333333',
      stateChangeSeq: 30,
    }
    await assertClaudeQueueReady({ stateDir: state, runtime, control: replacement, timing })
    const next = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-after-replacement',
      attemptNonce: '6'.repeat(32),
      repoRoot: repo,
      control: replacement,
      timing,
    })
    expect(next.target).toMatchObject({
      paneId: 'wT:p3', nativeSessionId: 'session-2', stateChangeSeq: 32,
    })
    expect(replacement.clearCalls).toBe(1)
  })

  test('clear送達後のtransport failureも再送せず同じ呼出しで新sessionを確認する', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(state, 'job-1', 'a'.repeat(32), prepared.target!)
    recordClaudeAdvisorDelivered(state, 'job-1', 'a'.repeat(32))
    control.agent.stateChangeSeq += 2
    recordClaudeAdvisorSettled(state, 'job-1', control.agent)
    control.clearMode = 'change-then-throw'

    await finalizeClaudeQueueJob({ stateDir: state, runtime, jobId: 'job-1', control, timing })
    expect(control.clearCalls).toBe(2)
    expect(readClaudeQueueBoundary(state)?.status).toBe('ready')
  })

  test('clear送達を証明できない場合は再送せずjob boundaryをblockする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(state, 'job-1', 'a'.repeat(32), prepared.target!)
    recordClaudeAdvisorDelivered(state, 'job-1', 'a'.repeat(32))
    control.agent.stateChangeSeq += 2
    recordClaudeAdvisorSettled(state, 'job-1', control.agent)
    control.clearMode = 'throw'

    await expect(finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-1', control, timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    const callsAtFailure = control.clearCalls
    await expect(finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-1', control, timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(control.clearCalls).toBe(callsAtFailure)
    expect(readClaudeQueueBoundary(state)?.status).toBe('clear-intent')
  })

  test('preflight clear送達後のtransport failureも同じ呼出しで証明して継続する', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    control.clearMode = 'change-then-throw'
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    expect(prepared.target).toBeDefined()
    expect(control.clearCalls).toBe(1)
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'job-active', jobId: 'job-1',
    })
  })

  test('未送達か不明なpreflight clearも再試行せずqueueをblockする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    control.clearMode = 'throw'
    await expect(prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    const callsAtFailure = control.clearCalls
    await expect(prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(control.clearCalls).toBe(callsAtFailure)
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'clear-intent', phase: 'preflight',
    })
  })

  test('送信直前recheck失敗はknown-unsentとしてintentを残さず安全に再試行する', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const originalRead = control.readVisible.bind(control)
    let reads = 0
    control.readVisible = async () => {
      reads += 1
      return reads === 3 ? 'Claude Code\n❯ draft' : originalRead()
    }

    const first = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    expect(first.target).toBeUndefined()
    expect(first.reason).toContain('preflight was skipped')
    expect(control.clearCalls).toBe(0)
    expect(readClaudeQueueBoundary(state)).toBeNull()

    control.readVisible = originalRead
    const retried = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    expect(retried.target).toBeDefined()
    expect(control.clearCalls).toBe(1)
  })

  test('delivered Claudeのidle表示が一時的に未描画でもstable emptyまでpollする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(state, 'job-1', 'a'.repeat(32), prepared.target!)
    recordClaudeAdvisorDelivered(state, 'job-1', 'a'.repeat(32))
    control.agent.stateChangeSeq += 2
    const originalRead = control.readVisible.bind(control)
    let reads = 0
    control.readVisible = async () => {
      reads += 1
      return reads === 1 ? 'Claude response finishing its redraw' : originalRead()
    }

    await finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-1', control,
      timing: { ...timing, settleTimeoutMs: 100 },
    })
    expect(reads).toBeGreaterThan(1)
    expect(control.clearCalls).toBe(2)
    expect(readClaudeQueueBoundary(state)?.status).toBe('ready')
  })

  test('arm後に送達checkpointが無ければ次roundも自動clearも行わない', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(state, 'job-1', 'a'.repeat(32), prepared.target!)
    const callsBeforeBoundary = control.clearCalls

    const nextRound = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'b'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    expect(nextRound.target).toBeUndefined()
    expect(nextRound.reason).toContain('ambiguous delivery')
    await expect(finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-1', control, timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(control.clearCalls).toBe(callsBeforeBoundary)
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'job-active', promptState: 'armed',
    })
  })

  test('structured拒否と同じstable snapshotならarmedを既知未送達として解放する', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const nonce = '3'.repeat(32)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-known-rejection',
      attemptNonce: nonce,
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(state, 'job-known-rejection', nonce, prepared.target!)
    recordClaudeAdvisorRejected(
      state,
      'job-known-rejection',
      nonce,
      control.agent,
    )
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'job-active', promptState: 'settled',
    })

    const next = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-known-rejection',
      attemptNonce: nonce,
      repoRoot: repo,
      control,
      timing,
    })
    expect(next.target).toMatchObject({ paneId: control.agent.paneId })
    await finalizeClaudeQueueJob({
      stateDir: state,
      runtime,
      jobId: 'job-known-rejection',
      control,
      timing,
    })
    expect(readClaudeQueueBoundary(state)?.status).toBe('ready')
  })

  test('armed crashは同じslotのmanual /clear後だけreadyへ復旧する', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-armed-manual-clear',
      attemptNonce: '8'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(
      state, 'job-armed-manual-clear', '8'.repeat(32), prepared.target!,
    )
    const clearCalls = control.clearCalls
    control.agent.nativeSessionId = 'manual-clear-session'
    control.agent.stateChangeSeq += 2
    control.agent.agentStatus = 'done'
    control.visible = 'Claude manually cleared\n❯\n⏵⏵ bypass permissions on'

    await finalizeClaudeQueueJob({
      stateDir: state,
      runtime,
      jobId: 'job-armed-manual-clear',
      control,
      timing,
    })
    expect(control.clearCalls).toBe(clearCalls)
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'ready', target: { nativeSessionId: 'manual-clear-session' },
    })
  })

  test('startup settle中に中止flagが立ったらCtrl-Cへ切替えてclearする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-startup-late-cancel',
      attemptNonce: '9'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(
      state, 'job-startup-late-cancel', '9'.repeat(32), prepared.target!,
    )
    recordClaudeAdvisorDelivered(state, 'job-startup-late-cancel', '9'.repeat(32))
    control.agent.agentStatus = 'working'
    control.agent.stateChangeSeq += 1
    let cancelChecks = 0

    await reconcileClaudeQueueBoundary({
      stateDir: state,
      runtime,
      control,
      timing,
      cancelRequested: jobId => {
        expect(jobId).toBe('job-startup-late-cancel')
        cancelChecks += 1
        return cancelChecks >= 2
      },
    })
    expect(cancelChecks).toBeGreaterThanOrEqual(2)
    expect(control.interruptCalls).toBe(1)
    expect(control.clearCalls).toBe(2)
    expect(readClaudeQueueBoundary(state)).toMatchObject({ status: 'ready' })
  })

  test('settled後の同一occupant sequence前進は最新空promptを再固定してclearする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    armClaudeAdvisorPrompt(state, 'job-1', 'a'.repeat(32), prepared.target!)
    recordClaudeAdvisorDelivered(state, 'job-1', 'a'.repeat(32))
    control.agent.stateChangeSeq += 2
    recordClaudeAdvisorSettled(state, 'job-1', control.agent)
    control.agent.stateChangeSeq += 2
    const callsBeforeBoundary = control.clearCalls

    await finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-1', control, timing,
    })
    expect(control.clearCalls).toBe(callsBeforeBoundary + 1)
    expect(readClaudeQueueBoundary(state)?.status).toBe('ready')
  })

  test('Claude未使用でも同一occupantのsequence前進は最新空promptへ再固定してclearする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    const callsBeforeBoundary = control.clearCalls
    control.agent.stateChangeSeq += 1

    await finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-1', control, timing,
    })
    expect(control.clearCalls).toBe(callsBeforeBoundary + 1)
    expect(readClaudeQueueBoundary(state)?.status).toBe('ready')
  })

  test('ready receipt後のmanual利用は次job claim前にfail-closedする', async () => {
    const { state, repo } = fixture()
    const control = new FakeClaudeControl(repo)
    const prepared = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })
    await finalizeClaudeQueueJob({ stateDir: state, runtime, jobId: 'job-1', control, timing })
    expect(prepared.target).toBeDefined()
    expect(control.clearCalls).toBe(2)
    expect(control.agent.nativeSessionId).toBe('session-3')
    const clearCalls = control.clearCalls
    control.agent.stateChangeSeq += 2

    await expect(assertClaudeQueueReady({ stateDir: state, runtime, control, timing }))
      .rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    await expect(prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-2',
      attemptNonce: 'b'.repeat(32),
      repoRoot: repo,
      control,
      timing,
    })).rejects.toBeInstanceOf(ClaudeContextClearPendingError)
    expect(control.clearCalls).toBe(clearCalls)
  })

  test('route変更時は旧paneのclean receiptを保持確認して新repo paneをpreflightする', async () => {
    const { state, repo } = fixture()
    const oldControl = new FakeClaudeControl(repo)
    const first = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-a',
      attemptNonce: 'a'.repeat(32),
      repoRoot: repo,
      control: oldControl,
      timing,
    })
    expect(first.target).toBeDefined()
    await finalizeClaudeQueueJob({
      stateDir: state, runtime, jobId: 'job-a', control: oldControl, timing,
    })

    const repoBInput = join(repo, '..', 'repo-b')
    mkdirSync(repoBInput, { mode: 0o700 })
    const initialized = Bun.spawnSync(['git', 'init', '--initial-branch=main', repoBInput], {
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(initialized.exitCode).toBe(0)
    const repoB = realpathSync(repoBInput)
    const nextAgent: ClaudeAgentSnapshot = {
      ...oldControl.agent,
      nativeSessionId: 'route-b-session-1',
      cwd: repoB,
      paneId: 'wT:p3',
      tabId: 'wT:t3',
      terminalId: 'term_333333',
      stateChangeSeq: 30,
    }
    let newPaneClears = 0
    const multiControl: ClaudeHerdrControl = {
      async listAgents() { return [{ ...oldControl.agent }, { ...nextAgent }] },
      async getAgent(paneId) {
        if (paneId === oldControl.agent.paneId) return { ...oldControl.agent }
        if (paneId === nextAgent.paneId) return { ...nextAgent }
        throw new Error('unknown test pane')
      },
      async readVisible() { return 'Claude Code\n❯\n⏵⏵ bypass permissions on' },
      async clearAgent(paneId) {
        if (paneId !== nextAgent.paneId) throw new Error('old clean pane must not be cleared again')
        newPaneClears += 1
        nextAgent.nativeSessionId = 'route-b-session-2'
        nextAgent.stateChangeSeq += 2
      },
    }

    const second = await prepareClaudeAdvisorTarget({
      stateDir: state,
      runtime,
      jobId: 'job-b',
      attemptNonce: 'b'.repeat(32),
      repoRoot: repoB,
      control: multiControl,
      timing,
    })
    expect(second.target).toMatchObject({
      cwd: repoB, paneId: 'wT:p3', nativeSessionId: 'route-b-session-2',
    })
    expect(newPaneClears).toBe(1)
    expect(readClaudeQueueBoundary(state)).toMatchObject({
      status: 'job-active', repoRoot: repoB, jobId: 'job-b',
    })
  })
})
