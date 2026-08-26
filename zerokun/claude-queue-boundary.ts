#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { dirname, join } from 'path'
import {
  environmentForPinnedHerdrRuntime,
  verifyHerdrRuntimeIdentityAsync,
  type HerdrRuntimeIdentity,
} from './herdr-runtime.ts'
import { requireManagedStateRoot } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalPrivateFile } from './safe-file.ts'
import { resolveAdvisorProjectLayout } from './advisor-snapshot.ts'

export const CLAUDE_QUEUE_BOUNDARY_FILE = 'claude-queue-boundary.json' as const

const PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/
const TAB_ID = /^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/
const TERMINAL_ID = /^term_[0-9a-f]+$/
const WORKSPACE_ID = /^w[0-9A-Za-z]+$/
const ATTEMPT_NONCE = /^[0-9a-f]{32}$/

export type ClaudeAgentSnapshot = {
  agent: 'claude'
  nativeSessionId: string
  agentStatus: string
  cwd: string
  paneId: string
  tabId: string
  terminalId: string
  workspaceId: string
  stateChangeSeq: number
}

export type ClaudeTargetIdentity = Omit<ClaudeAgentSnapshot, 'agentStatus'>

type ReadyBoundary = {
  version: 1
  status: 'ready'
  repoRoot: string
  target: ClaudeTargetIdentity
  updatedAt: number
}

type ReadyWithoutClaudeBoundary = {
  version: 1
  status: 'ready-no-target'
  repoRoot: string
  updatedAt: number
}

type NoClaudeActiveBoundary = {
  version: 1
  status: 'job-no-claude'
  jobId: string
  attemptNonce: string
  repoRoot: string
  reason: string
  updatedAt: number
}

type ActiveBoundary = {
  version: 1
  status: 'job-active'
  jobId: string
  attemptNonce: string
  repoRoot: string
  target: ClaudeTargetIdentity
  promptState: 'none' | 'armed' | 'delivered' | 'settled'
  updatedAt: number
}

type ClearIntentBoundary = {
  version: 1
  status: 'clear-intent'
  phase: 'preflight' | 'job-end'
  jobId: string
  attemptNonce: string
  repoRoot: string
  operationId: string
  target: ClaudeTargetIdentity
  updatedAt: number
}

type CancelIntentBoundary = {
  version: 1
  status: 'cancel-intent'
  jobId: string
  attemptNonce: string
  repoRoot: string
  operationId: string
  target: ClaudeTargetIdentity
  updatedAt: number
}

export type ClaudeQueueBoundaryState = ReadyBoundary | ReadyWithoutClaudeBoundary
  | NoClaudeActiveBoundary | ActiveBoundary | ClearIntentBoundary | CancelIntentBoundary

export interface ClaudeHerdrControl {
  listAgents(): Promise<ClaudeAgentSnapshot[]>
  getAgent(paneId: string): Promise<ClaudeAgentSnapshot>
  readVisible(paneId: string): Promise<string>
  clearAgent(paneId: string): Promise<void>
  interruptAgent?(paneId: string): Promise<void>
}

export class ClaudeContextClearPendingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeContextClearPendingError'
  }
}

export class ClaudeJobCancellationRequestedError extends Error {
  constructor(readonly jobId: string) {
    super(`Claude cleanup observed a cancellation request for job ${jobId}`)
    this.name = 'ClaudeJobCancellationRequestedError'
  }
}

type TimingOptions = {
  stableDelayMs?: number
  pollMs?: number
  settleTimeoutMs?: number
  clearConfirmationTimeoutMs?: number
}

type HerdrAgentRecord = {
  agent?: unknown
  agent_session?: { value?: unknown }
  agent_status?: unknown
  cwd?: unknown
  pane_id?: unknown
  tab_id?: unknown
  terminal_id?: unknown
  workspace_id?: unknown
  state_change_seq?: unknown
}

function requireString(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || (pattern && !pattern.test(value))) {
    throw new Error(`invalid ${label}`)
  }
  return value
}

function requireInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`invalid ${label}`)
  return Number(value)
}

function parseAgent(value: HerdrAgentRecord): ClaudeAgentSnapshot {
  if (value.agent !== 'claude') throw new Error('Herdr record is not a Claude agent')
  return {
    agent: 'claude',
    nativeSessionId: requireString(value.agent_session?.value, 'Claude native session'),
    agentStatus: requireString(value.agent_status, 'Claude agent status'),
    cwd: requireString(value.cwd, 'Claude cwd'),
    paneId: requireString(value.pane_id, 'Claude pane ID', PANE_ID),
    tabId: requireString(value.tab_id, 'Claude tab ID', TAB_ID),
    terminalId: requireString(value.terminal_id, 'Claude terminal ID', TERMINAL_ID),
    workspaceId: requireString(value.workspace_id, 'Claude workspace ID', WORKSPACE_ID),
    stateChangeSeq: requireInteger(value.state_change_seq, 'Claude state_change_seq'),
  }
}

function parseTarget(value: unknown): ClaudeTargetIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid Claude queue target')
  }
  const target = value as Record<string, unknown>
  if (target.agent !== 'claude') throw new Error('invalid Claude queue target agent')
  return {
    agent: 'claude',
    nativeSessionId: requireString(target.nativeSessionId, 'stored Claude native session'),
    cwd: requireString(target.cwd, 'stored Claude cwd'),
    paneId: requireString(target.paneId, 'stored Claude pane ID', PANE_ID),
    tabId: requireString(target.tabId, 'stored Claude tab ID', TAB_ID),
    terminalId: requireString(target.terminalId, 'stored Claude terminal ID', TERMINAL_ID),
    workspaceId: requireString(target.workspaceId, 'stored Claude workspace ID', WORKSPACE_ID),
    stateChangeSeq: requireInteger(target.stateChangeSeq, 'stored Claude state_change_seq'),
  }
}

function parseBoundary(raw: string): ClaudeQueueBoundaryState {
  if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('Claude queue boundary is too large')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new Error('Claude queue boundary is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claude queue boundary must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== 1) throw new Error('unsupported Claude queue boundary version')
  const updatedAt = requireInteger(record.updatedAt, 'Claude boundary updatedAt')
  if (record.status === 'ready-no-target') return {
    version: 1,
    status: 'ready-no-target',
    repoRoot: requireString(record.repoRoot, 'ready Claude repository root'),
    updatedAt,
  }
  if (record.status === 'job-no-claude') return {
    version: 1,
    status: 'job-no-claude',
    jobId: requireString(record.jobId, 'Claude boundary job ID'),
    attemptNonce: requireString(record.attemptNonce, 'Claude attempt nonce', ATTEMPT_NONCE),
    repoRoot: requireString(record.repoRoot, 'Claude repository root'),
    reason: requireString(record.reason, 'Claude skip reason'),
    updatedAt,
  }
  const target = parseTarget(record.target)
  if (record.status === 'ready') return {
    version: 1,
    status: 'ready',
    repoRoot: requireString(record.repoRoot, 'ready Claude repository root'),
    target,
    updatedAt,
  }
  const common = {
    version: 1 as const,
    jobId: requireString(record.jobId, 'Claude boundary job ID'),
    attemptNonce: requireString(record.attemptNonce, 'Claude attempt nonce', ATTEMPT_NONCE),
    repoRoot: requireString(record.repoRoot, 'Claude repository root'),
    target,
    updatedAt,
  }
  if (record.status === 'job-active') {
    if (!['none', 'armed', 'delivered', 'settled'].includes(String(record.promptState))) {
      throw new Error('invalid Claude prompt state')
    }
    return {
      ...common,
      status: 'job-active',
      promptState: record.promptState as ActiveBoundary['promptState'],
    }
  }
  if (record.status === 'clear-intent') {
    if (record.phase !== 'preflight' && record.phase !== 'job-end') {
      throw new Error('invalid Claude clear phase')
    }
    return {
      ...common,
      status: 'clear-intent',
      phase: record.phase,
      operationId: requireString(record.operationId, 'Claude clear operation ID'),
    }
  }
  if (record.status === 'cancel-intent') return {
    ...common,
    status: 'cancel-intent',
    operationId: requireString(record.operationId, 'Claude cancel operation ID'),
  }
  throw new Error('invalid Claude queue boundary status')
}

function boundaryPath(stateDirInput: string): { stateDir: string; path: string } {
  const stateDir = requireManagedStateRoot(stateDirInput)
  return { stateDir, path: join(stateDir, CLAUDE_QUEUE_BOUNDARY_FILE) }
}

export function readClaudeQueueBoundary(
  stateDirInput: string,
): ClaudeQueueBoundaryState | null {
  const { path } = boundaryPath(stateDirInput)
  const raw = readOptionalPrivateFile(path)
  return raw === null ? null : parseBoundary(raw)
}

function writeBoundary(stateDirInput: string, state: ClaudeQueueBoundaryState): void {
  const { path } = boundaryPath(stateDirInput)
  atomicWritePrivateFile(path, `${JSON.stringify(state)}\n`)
}

function targetOf(agent: ClaudeAgentSnapshot): ClaudeTargetIdentity {
  const { agentStatus: _agentStatus, ...target } = agent
  return target
}

export function sameClaudeSlot(
  left: ClaudeTargetIdentity,
  right: ClaudeTargetIdentity,
): boolean {
  return left.agent === 'claude' && right.agent === 'claude'
    && left.cwd === right.cwd
    && left.paneId === right.paneId
    && left.tabId === right.tabId
    && left.terminalId === right.terminalId
    && left.workspaceId === right.workspaceId
}

export function sameClaudeOccupant(
  left: ClaudeTargetIdentity,
  right: ClaudeTargetIdentity,
): boolean {
  return sameClaudeSlot(left, right) && left.nativeSessionId === right.nativeSessionId
}

function sameClaudeSnapshot(
  left: ClaudeTargetIdentity,
  right: ClaudeTargetIdentity,
): boolean {
  return sameClaudeOccupant(left, right) && left.stateChangeSeq === right.stateChangeSeq
}

export function emptyClaudePrompt(value: string): boolean {
  const normalized = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
  const lines = normalized.split('\n').map(line => line.trim())
  let lastPrompt = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('❯')) lastPrompt = index
  }
  if (lastPrompt < 0 || lines[lastPrompt] !== '❯') return false
  const tailIsOnlyKnownStatus = lines.slice(lastPrompt + 1).every(line => (
    line === ''
    || /^[─━═╌╍┄┅┈┉]+$/.test(line)
    || /^⏵⏵\s/.test(line)
    || /^(?:✔\s|new task\?|\/rc\b)/i.test(line)
  ))
  if (!tailIsOnlyKnownStatus) return false

  // `visible` includes old conversation text. Plain words such as "rate
  // limit" or "permission required" in an earlier answer are not evidence
  // of a current modal. Restrict modal checks to compact, structurally exact
  // fragments immediately above the final prompt. This also rejects clipped
  // surveys/approvals whose choices have scrolled out of the viewport, while
  // leaving ordinary historical discussion outside the active region alone.
  const activePrefixLines = lines.slice(Math.max(0, lastPrompt - 8), lastPrompt)
  const activePrefix = activePrefixLines.join('\n')
  const hasInteractiveFragment = /How is Claude doing this session\?/i.test(activePrefix)
    || activePrefixLines.some(line => (
      /^(?:[0-3]:\s*(?:Bad|Fine|Good|Dismiss)|Allow this action|Do you want to proceed|transcript sharing)$/i
        .test(line)
      || /^(?:permission (?:required|request)|requires? permission)\b/i.test(line)
    ))
  return !hasInteractiveFragment
}

function visibleText(value: unknown): string {
  const result = (value as { result?: Record<string, unknown> })?.result
  for (const candidate of [result?.content, result?.text, result?.output, result?.data]) {
    if (typeof candidate === 'string') return candidate
  }
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

async function runHerdr(
  runtime: HerdrRuntimeIdentity,
  args: string[],
  label: string,
  timeoutMs = 130_000,
): Promise<string> {
  const source = {
    HOME: homedir(),
    PATH: `${dirname(runtime.binary)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'en_US.UTF-8',
    TERM: 'dumb',
  }
  const environment = environmentForPinnedHerdrRuntime(runtime, source)
  await verifyHerdrRuntimeIdentityAsync(runtime, environment)
  const child = Bun.spawn([runtime.binary, ...args], {
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ kind: 'timeout' }>(resolve => {
    timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })
  const outcome = await Promise.race([
    child.exited.then(exitCode => ({ kind: 'exit' as const, exitCode })),
    timeout,
  ])
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  if (outcome.kind === 'timeout') {
    try { child.kill('SIGTERM') } catch {}
    let stopped = false
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      child.exited.then(() => { stopped = true }),
      new Promise<void>(resolve => { stopTimer = setTimeout(resolve, 2_000) }),
    ])
    if (stopTimer !== undefined) clearTimeout(stopTimer)
    if (!stopped) {
      try { child.kill('SIGKILL') } catch {}
      let killTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        child.exited.then(() => { stopped = true }),
        new Promise<void>(resolve => { killTimer = setTimeout(resolve, 1_000) }),
      ])
      if (killTimer !== undefined) clearTimeout(killTimer)
    }
    if (stopped) await Promise.allSettled([stdout, stderr])
    if (!stopped) throw new Error(`${label} timed out and its client process did not stop`)
    throw new Error(`${label} timed out`)
  }
  const [stdoutText, stderrText] = await Promise.all([stdout, stderr])
  if (Buffer.byteLength(stdoutText) > 512 * 1024 || Buffer.byteLength(stderrText) > 64 * 1024) {
    throw new Error(`${label} output exceeded the managed limit`)
  }
  if (outcome.exitCode !== 0) {
    throw new Error(`${label} failed (${outcome.exitCode}): ${stderrText.slice(-2_000)}`)
  }
  return stdoutText
}

function parseEnvelope(value: string, label: string): unknown {
  try { return JSON.parse(value) } catch { throw new Error(`${label} returned invalid JSON`) }
}

export function createClaudeHerdrControl(
  runtime: HerdrRuntimeIdentity,
): ClaudeHerdrControl {
  return {
    async listAgents() {
      const raw = parseEnvelope(
        await runHerdr(runtime, ['agent', 'list'], 'Herdr agent list'),
        'Herdr agent list',
      )
      const agents = (raw as { result?: { agents?: HerdrAgentRecord[] } })?.result?.agents
      if (!Array.isArray(agents)) throw new Error('Herdr agent list omitted agents')
      return agents.filter(agent => agent.agent === 'claude').map(parseAgent)
    },
    async getAgent(paneId) {
      if (!PANE_ID.test(paneId)) throw new Error('invalid Claude pane target')
      const raw = parseEnvelope(
        await runHerdr(runtime, ['agent', 'get', paneId], 'Herdr agent get'),
        'Herdr agent get',
      )
      const agent = (raw as { result?: { agent?: HerdrAgentRecord } })?.result?.agent
      if (!agent) throw new Error('Herdr agent get omitted agent')
      return parseAgent(agent)
    },
    async readVisible(paneId) {
      if (!PANE_ID.test(paneId)) throw new Error('invalid Claude pane target')
      const raw = await runHerdr(
        runtime,
        ['agent', 'read', paneId, '--source', 'visible', '--lines', '120'],
        'Herdr visible read',
      )
      let parsed: unknown = raw
      try { parsed = JSON.parse(raw) } catch {}
      return visibleText(parsed)
    },
    async clearAgent(paneId) {
      if (!PANE_ID.test(paneId)) throw new Error('invalid Claude pane target')
      await runHerdr(runtime, [
        'agent', 'prompt', paneId, '/clear', '--wait', '--until', 'idle', '--until', 'done',
        '--timeout', '120000',
      ], 'Herdr Claude /clear', 130_000)
    },
    async interruptAgent(paneId) {
      if (!PANE_ID.test(paneId)) throw new Error('invalid Claude pane target')
      await runHerdr(
        runtime,
        ['agent', 'send-keys', paneId, 'ctrl+c'],
        'Herdr Claude interrupt',
        30_000,
      )
    },
  }
}

function isSettled(agent: ClaudeAgentSnapshot): boolean {
  return agent.agentStatus === 'idle' || agent.agentStatus === 'done'
}

async function stableEmptyAgent(
  control: ClaudeHerdrControl,
  expected: ClaudeTargetIdentity,
  stableDelayMs: number,
  requireExactSequence: boolean,
): Promise<ClaudeAgentSnapshot> {
  const firstBefore = await control.getAgent(expected.paneId)
  const firstBeforeTarget = targetOf(firstBefore)
  const firstVisible = await control.readVisible(expected.paneId)
  const firstAfter = await control.getAgent(expected.paneId)
  const firstAfterTarget = targetOf(firstAfter)
  if (!sameClaudeOccupant(expected, firstBeforeTarget)
    || (requireExactSequence && !sameClaudeSnapshot(expected, firstBeforeTarget))
    || !sameClaudeSnapshot(firstBeforeTarget, firstAfterTarget)
    || !isSettled(firstBefore)
    || !isSettled(firstAfter)
    || !emptyClaudePrompt(firstVisible)) {
    throw new Error('Claude is not settled at an empty prompt')
  }
  if (stableDelayMs > 0) await Bun.sleep(stableDelayMs)
  const secondBefore = await control.getAgent(expected.paneId)
  const secondBeforeTarget = targetOf(secondBefore)
  const secondVisible = await control.readVisible(expected.paneId)
  const secondAfter = await control.getAgent(expected.paneId)
  const secondAfterTarget = targetOf(secondAfter)
  if (!sameClaudeSnapshot(firstAfterTarget, secondBeforeTarget)
    || !sameClaudeSnapshot(secondBeforeTarget, secondAfterTarget)
    || !isSettled(secondBefore)
    || !isSettled(secondAfter)
    || !emptyClaudePrompt(secondVisible)) {
    throw new Error('Claude empty prompt did not remain stable')
  }
  return secondAfter
}

async function confirmNewCleanSession(
  control: ClaudeHerdrControl,
  previous: ClaudeTargetIdentity,
  options: TimingOptions,
): Promise<ClaudeAgentSnapshot> {
  // `/clear` is part of the logical job boundary. Production must wait for a
  // verifiable new Claude session without a wall-clock limit; tests may inject
  // a finite deadline to exercise failure paths.
  const deadline = options.clearConfirmationTimeoutMs === undefined
    ? null
    : Date.now() + options.clearConfirmationTimeoutMs
  const pollMs = options.pollMs ?? 250
  let lastError = 'Claude session did not change'
  while (deadline === null || Date.now() < deadline) {
    try {
      const current = await control.getAgent(previous.paneId)
      const target = targetOf(current)
      if (!sameClaudeSlot(previous, target)) {
        throw new Error('Claude pane occupant changed while confirming /clear')
      }
      // Herdr can replace Claude's native session without incrementing the
      // lifecycle sequence when `/clear` is issued at an already-empty prompt.
      // A new native session is the context-generation receipt; require the
      // sequence not to move backwards and then prove that exact new snapshot
      // remains settled and empty.
      if (target.nativeSessionId !== previous.nativeSessionId
        && target.stateChangeSeq >= previous.stateChangeSeq) {
        return await stableEmptyAgent(
          control,
          target,
          options.stableDelayMs ?? 1_000,
          true,
        )
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (pollMs > 0) await Bun.sleep(pollMs)
  }
  throw new Error(`Claude /clear could not be confirmed: ${lastError}`)
}

function readyState(agent: ClaudeAgentSnapshot, repoRoot: string): ReadyBoundary {
  return {
    version: 1,
    status: 'ready',
    repoRoot,
    target: targetOf(agent),
    updatedAt: Date.now(),
  }
}

function readyWithoutClaudeState(repoRoot: string): ReadyWithoutClaudeBoundary {
  return {
    version: 1,
    status: 'ready-no-target',
    repoRoot,
    updatedAt: Date.now(),
  }
}

function noClaudeActiveState(
  jobId: string,
  attemptNonce: string,
  repoRoot: string,
  reason: string,
): NoClaudeActiveBoundary {
  return {
    version: 1,
    status: 'job-no-claude',
    jobId,
    attemptNonce,
    repoRoot,
    reason,
    updatedAt: Date.now(),
  }
}

function activeState(
  jobId: string,
  attemptNonce: string,
  repoRoot: string,
  agent: ClaudeAgentSnapshot,
  promptState: ActiveBoundary['promptState'],
): ActiveBoundary {
  return {
    version: 1,
    status: 'job-active',
    jobId,
    attemptNonce,
    repoRoot,
    target: targetOf(agent),
    promptState,
    updatedAt: Date.now(),
  }
}

function clearIntent(
  phase: ClearIntentBoundary['phase'],
  jobId: string,
  attemptNonce: string,
  repoRoot: string,
  target: ClaudeTargetIdentity,
): ClearIntentBoundary {
  return {
    version: 1,
    status: 'clear-intent',
    phase,
    jobId,
    attemptNonce,
    repoRoot,
    operationId: randomUUID(),
    target,
    updatedAt: Date.now(),
  }
}

function cancelIntent(
  jobId: string,
  attemptNonce: string,
  repoRoot: string,
  target: ClaudeTargetIdentity,
): CancelIntentBoundary {
  return {
    version: 1,
    status: 'cancel-intent',
    jobId,
    attemptNonce,
    repoRoot,
    operationId: randomUUID(),
    target,
    updatedAt: Date.now(),
  }
}

async function clearAndRecord(
  stateDir: string,
  control: ClaudeHerdrControl,
  intent: ClearIntentBoundary,
  options: TimingOptions,
): Promise<ClaudeAgentSnapshot> {
  // Herdr has no compare-and-send flag. Recheck the exact session, sequence,
  // settled state and empty prompt before recording any send intent. A failed
  // recheck is therefore known-unsent and may be retried safely. Once the
  // durable intent exists, any crash is ambiguous and reconciliation must
  // never resend the fixed slash command. The advisor pane must remain
  // dedicated to Zero while the daemon runs; this narrows but cannot
  // atomically remove the remaining sub-command race against manual input.
  await stableEmptyAgent(control, intent.target, 0, true)
  writeBoundary(stateDir, intent)
  let commandError: unknown
  try {
    await control.clearAgent(intent.target.paneId)
  } catch (error) {
    commandError = error
  }
  let clean: ClaudeAgentSnapshot
  try {
    clean = await confirmNewCleanSession(control, intent.target, options)
  } catch (confirmationError) {
    if (commandError) {
      throw new Error(
        `Claude /clear command failed (${commandError}) and its new session is unconfirmed: `
          + String(confirmationError),
      )
    }
    throw confirmationError
  }
  writeBoundary(stateDir, readyState(clean, intent.repoRoot))
  return clean
}

async function reconcileIntent(
  stateDir: string,
  control: ClaudeHerdrControl,
  intent: ClearIntentBoundary,
  options: TimingOptions,
): Promise<boolean> {
  try {
    const clean = await confirmNewCleanSession(control, intent.target, options)
    writeBoundary(stateDir, readyState(clean, intent.repoRoot))
    return true
  } catch {
    return false
  }
}

export async function prepareClaudeAdvisorTarget(options: {
  stateDir: string
  runtime: HerdrRuntimeIdentity
  jobId: string
  attemptNonce: string
  repoRoot: string
  control?: ClaudeHerdrControl
  timing?: TimingOptions
}): Promise<{ target?: ClaudeAgentSnapshot; reason?: string; skipped?: true }> {
  const stateDir = requireManagedStateRoot(options.stateDir)
  const control = options.control ?? createClaudeHerdrControl(options.runtime)
  const timing = options.timing ?? {}
  let boundary = readClaudeQueueBoundary(stateDir)
  if (boundary?.status === 'job-no-claude') {
    if (boundary.jobId !== options.jobId || boundary.repoRoot !== options.repoRoot) {
      throw new ClaudeContextClearPendingError(
        `Claude skip boundary belongs to unfinished job ${boundary.jobId}`,
      )
    }
    return { reason: boundary.reason, skipped: true }
  }
  if (boundary?.status === 'clear-intent') {
    const recovered = await reconcileIntent(stateDir, control, boundary, timing)
    if (!recovered) {
      throw new ClaudeContextClearPendingError(
        `Claude /clear is still unconfirmed for job ${boundary.jobId}`,
      )
    }
    boundary = readClaudeQueueBoundary(stateDir)
  }
  if (boundary?.status === 'cancel-intent') {
    throw new ClaudeContextClearPendingError(
      `Claude cancellation is still unconfirmed for job ${boundary.jobId}`,
    )
  }

  if (boundary?.status === 'job-active') {
    if (boundary.jobId !== options.jobId || boundary.repoRoot !== options.repoRoot) {
      throw new ClaudeContextClearPendingError(
        `Claude remains reserved by unfinished job ${boundary.jobId}`,
      )
    }
    if (boundary.promptState === 'armed' || boundary.promptState === 'delivered') {
      return {
        reason: boundary.promptState === 'armed'
          ? 'the prior Claude prompt has an ambiguous delivery boundary'
          : 'the prior Claude prompt has not reached a settled checkpoint',
      }
    }
    try {
      const stable = boundary.promptState === 'settled'
        ? await waitForJobClaudeToSettle(
            control, boundary.target, timing, boundary.jobId,
          )
        : await stableEmptyAgent(
            control,
            boundary.target,
            timing.stableDelayMs ?? 1_000,
            false,
          )
      const continued = activeState(
        options.jobId,
        options.attemptNonce,
        options.repoRoot,
        stable,
        boundary.promptState,
      )
      writeBoundary(stateDir, continued)
      return { target: stable }
    } catch (error) {
      return { reason: `reserved Claude is not ready: ${error}` }
    }
  }

  const agents = await control.listAgents()
  const candidates = agents.filter(agent => {
    if (agent.paneId === options.runtime.paneId || agent.terminalId === options.runtime.terminalId) {
      return false
    }
    try {
      const layout = resolveAdvisorProjectLayout(agent.cwd)
      return (layout.gitRoot ?? layout.projectPath) === options.repoRoot
    } catch { return false }
  })
  if (boundary?.status === 'ready') {
    // A completed job's receipt proves that its exact Claude generation was
    // cleared. If that pane was later closed, it no longer owns queue state:
    // re-enumerate the current candidates and apply the normal 0/1/many rule.
    // A still-present binding is different. Preserve the dedicated-pane
    // contract by requiring its exact clean generation; a reused pane or
    // manual sequence change remains a fail-closed boundary.
    const priorBindings = agents.filter(agent => (
      agent.paneId === boundary.target.paneId
      || agent.terminalId === boundary.target.terminalId
    ))
    if (priorBindings.length > 1) {
      throw new ClaudeContextClearPendingError(
        'the previously cleared Claude advisor binding is ambiguous',
      )
    }
    let priorClean: ClaudeAgentSnapshot | undefined
    if (priorBindings.length === 1) {
      const prior = priorBindings[0]!
      if (!sameClaudeSnapshot(boundary.target, targetOf(prior))) {
        throw new ClaudeContextClearPendingError(
          'the previously cleared Claude advisor identity changed before the next job',
        )
      }
      try {
        priorClean = await stableEmptyAgent(
          control,
          boundary.target,
          timing.stableDelayMs ?? 1_000,
          true,
        )
      } catch (error) {
        throw new ClaudeContextClearPendingError(
          `the previously cleared Claude advisor is no longer clean: ${error}`,
        )
      }
    }
    if (boundary.repoRoot === options.repoRoot && priorClean
      && candidates.length === 1
      && sameClaudeSnapshot(boundary.target, targetOf(candidates[0]!))) {
      writeBoundary(stateDir, activeState(
        options.jobId, options.attemptNonce, options.repoRoot, priorClean, 'none',
      ))
      return { target: priorClean }
    }
    // A route change may use another dedicated Claude pane. Keep the old pane
    // proven clean when it still exists, then enroll the unique current pane
    // with its own preflight clear below. The same re-enumeration also handles
    // a prior pane that was closed after its job-end clear was confirmed.
  }
  if (candidates.length !== 1) {
    const reason = `eligible Claude count is ${candidates.length}`
    writeBoundary(stateDir, noClaudeActiveState(
      options.jobId, options.attemptNonce, options.repoRoot, reason,
    ))
    return { reason, skipped: true }
  }
  const candidate = candidates[0]!

  try {
    const stable = await stableEmptyAgent(
      control,
      targetOf(candidate),
      timing.stableDelayMs ?? 1_000,
      true,
    )
    const clean = await clearAndRecord(
      stateDir,
      control,
      clearIntent(
        'preflight', options.jobId, options.attemptNonce, options.repoRoot, targetOf(stable),
      ),
      timing,
    )
    writeBoundary(stateDir, activeState(
      options.jobId, options.attemptNonce, options.repoRoot, clean, 'none',
    ))
    return { target: clean }
  } catch (error) {
    const current = readClaudeQueueBoundary(stateDir)
    if (current?.status === 'clear-intent' && current.phase === 'preflight') {
      throw new ClaudeContextClearPendingError(
        `Claude preflight /clear is unconfirmed for job ${current.jobId}: ${error}`,
      )
    }
    return { reason: `Claude preflight was skipped: ${error}` }
  }
}

export async function assertClaudeQueueReady(options: {
  stateDir: string
  runtime: HerdrRuntimeIdentity
  continuingJobId?: string
  control?: ClaudeHerdrControl
  timing?: TimingOptions
}): Promise<void> {
  const stateDir = requireManagedStateRoot(options.stateDir)
  const boundary = readClaudeQueueBoundary(stateDir)
  if (!boundary) return
  if (boundary.status === 'ready-no-target') return
  if ((boundary.status === 'job-active' || boundary.status === 'job-no-claude')
    && options.continuingJobId !== undefined
    && boundary.jobId === options.continuingJobId) return
  if (boundary.status !== 'ready') {
    throw new ClaudeContextClearPendingError(
      `Claude queue boundary is ${boundary.status}; no new Codex job may start`,
    )
  }
  const control = options.control ?? createClaudeHerdrControl(options.runtime)
  const agents = await control.listAgents()
  const priorBindings = agents.filter(agent => (
    agent.paneId === boundary.target.paneId
    || agent.terminalId === boundary.target.terminalId
  ))
  if (priorBindings.length === 0) return
  if (priorBindings.length !== 1
    || !sameClaudeSnapshot(boundary.target, targetOf(priorBindings[0]!))) {
    throw new ClaudeContextClearPendingError(
      'the cleared Claude advisor identity changed before queue claim',
    )
  }
  try {
    await stableEmptyAgent(
      control,
      boundary.target,
      options.timing?.stableDelayMs ?? 1_000,
      true,
    )
  } catch (error) {
    throw new ClaudeContextClearPendingError(
      `the cleared Claude advisor changed before queue claim: ${error}`,
    )
  }
}

export function armClaudeAdvisorPrompt(
  stateDirInput: string,
  jobId: string,
  attemptNonce: string,
  target: ClaudeAgentSnapshot,
): void {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const boundary = readClaudeQueueBoundary(stateDir)
  if (boundary?.status !== 'job-active'
    || boundary.jobId !== jobId
    || boundary.attemptNonce !== attemptNonce
    || !sameClaudeSnapshot(boundary.target, targetOf(target))) {
    throw new Error('Claude queue reservation changed before prompt delivery')
  }
  if (boundary.promptState !== 'none' && boundary.promptState !== 'settled') {
    throw new Error('a prior Claude prompt has not reached a settled checkpoint')
  }
  writeBoundary(stateDir, { ...boundary, promptState: 'armed', updatedAt: Date.now() })
}

export function recordClaudeAdvisorDelivered(
  stateDirInput: string,
  jobId: string,
  attemptNonce: string,
): void {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const boundary = readClaudeQueueBoundary(stateDir)
  if (boundary?.status !== 'job-active'
    || boundary.jobId !== jobId
    || boundary.attemptNonce !== attemptNonce
    || boundary.promptState !== 'armed') {
    throw new Error('Claude prompt delivery boundary changed before checkpoint')
  }
  writeBoundary(stateDir, { ...boundary, promptState: 'delivered', updatedAt: Date.now() })
}

export function recordClaudeAdvisorRejected(
  stateDirInput: string,
  jobId: string,
  attemptNonce: string,
  target: ClaudeAgentSnapshot,
): void {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const boundary = readClaudeQueueBoundary(stateDir)
  if (boundary?.status !== 'job-active'
    || boundary.jobId !== jobId
    || boundary.attemptNonce !== attemptNonce
    || boundary.promptState !== 'armed'
    || !sameClaudeSnapshot(boundary.target, targetOf(target))) {
    throw new Error('Claude rejection boundary changed before the known-unsent checkpoint')
  }
  // The Herdr socket returned a matching structured rejection while the exact
  // occupant and state sequence remained at a stable empty prompt.  No Claude
  // turn exists to settle, so this round can safely release its armed state.
  writeBoundary(stateDir, {
    ...boundary,
    target: targetOf(target),
    promptState: 'settled',
    updatedAt: Date.now(),
  })
}

export function recordClaudeAdvisorSettled(
  stateDirInput: string,
  jobId: string,
  target: ClaudeAgentSnapshot,
): void {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const boundary = readClaudeQueueBoundary(stateDir)
  if (boundary?.status !== 'job-active' || boundary.jobId !== jobId
    || boundary.promptState !== 'delivered'
    || !sameClaudeOccupant(boundary.target, targetOf(target))) {
    throw new Error('Claude queue reservation changed before settled checkpoint')
  }
  writeBoundary(stateDir, {
    ...boundary,
    target: targetOf(target),
    promptState: 'settled',
    updatedAt: Date.now(),
  })
}

async function waitForJobClaudeToSettle(
  control: ClaudeHerdrControl,
  expected: ClaudeTargetIdentity,
  options: TimingOptions,
  jobId: string,
  cancelRequested?: () => boolean,
): Promise<ClaudeAgentSnapshot> {
  // Production has no logical job deadline. Tests may inject a finite bound
  // to exercise failure handling without changing the runtime contract.
  const deadline = options.settleTimeoutMs === undefined
    ? null
    : Date.now() + options.settleTimeoutMs
  const pollMs = options.pollMs ?? 2_000
  let lastError = 'Claude has not reached a stable empty prompt'
  while (deadline === null || Date.now() < deadline) {
    if (cancelRequested?.()) throw new ClaudeJobCancellationRequestedError(jobId)
    const current = await control.getAgent(expected.paneId)
    const target = targetOf(current)
    if (!sameClaudeOccupant(expected, target)) {
      throw new Error('Claude occupant changed before job-end clear')
    }
    if (isSettled(current)) {
      try {
        const settled = await stableEmptyAgent(
          control,
          target,
          options.stableDelayMs ?? 1_000,
          true,
        )
        if (cancelRequested?.()) throw new ClaudeJobCancellationRequestedError(jobId)
        return settled
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        const after = await control.getAgent(expected.paneId)
        if (!sameClaudeOccupant(expected, targetOf(after))) {
          throw new Error('Claude occupant changed while waiting for its empty prompt')
        }
        if (!isSettled(after) && after.agentStatus !== 'working') {
          throw new Error(`Claude is blocked in state ${after.agentStatus}`)
        }
      }
    }
    if (!isSettled(current) && current.agentStatus !== 'working') {
      throw new Error(`Claude is blocked in state ${current.agentStatus}`)
    }
    if (pollMs > 0) await Bun.sleep(pollMs)
  }
  throw new Error(`Claude did not become stably idle before the injected test deadline: ${lastError}`)
}

async function waitForCancelledClaudeToSettle(
  control: ClaudeHerdrControl,
  expected: ClaudeTargetIdentity,
  options: TimingOptions,
): Promise<ClaudeAgentSnapshot> {
  const deadline = options.settleTimeoutMs === undefined
    ? null
    : Date.now() + options.settleTimeoutMs
  const pollMs = options.pollMs ?? 2_000
  while (deadline === null || Date.now() < deadline) {
    const current = await control.getAgent(expected.paneId)
    if (!sameClaudeOccupant(expected, targetOf(current))) {
      throw new Error('Claude occupant changed while confirming cancellation')
    }
    if (isSettled(current)) {
      return stableEmptyAgent(
        control,
        targetOf(current),
        options.stableDelayMs ?? 1_000,
        true,
      )
    }
    if (current.agentStatus !== 'working' && current.agentStatus !== 'blocked') {
      throw new Error(`Claude cancellation reached unsafe state ${current.agentStatus}`)
    }
    if (pollMs > 0) await Bun.sleep(pollMs)
  }
  throw new Error('Claude cancellation did not settle before the injected test deadline')
}

async function clearCancelledClaude(
  stateDir: string,
  control: ClaudeHerdrControl,
  boundary: Pick<CancelIntentBoundary, 'jobId' | 'attemptNonce' | 'repoRoot'>,
  settled: ClaudeAgentSnapshot,
  timing: TimingOptions,
): Promise<void> {
  await clearAndRecord(
    stateDir,
    control,
    clearIntent(
      'job-end',
      boundary.jobId,
      boundary.attemptNonce,
      boundary.repoRoot,
      targetOf(settled),
    ),
    timing,
  )
}

/**
 * Stop the exact reserved Claude occupant after an exact Slack cancellation.
 * The Ctrl-C intent is durable before the key is sent and is never replayed
 * after an ambiguous crash boundary.
 */
export async function cancelClaudeQueueJob(options: {
  stateDir: string
  runtime: HerdrRuntimeIdentity
  jobId: string
  control?: ClaudeHerdrControl
  timing?: TimingOptions
}): Promise<void> {
  const stateDir = requireManagedStateRoot(options.stateDir)
  const control = options.control ?? createClaudeHerdrControl(options.runtime)
  const timing = options.timing ?? {}
  const boundary = readClaudeQueueBoundary(stateDir)
  if (!boundary || boundary.status === 'ready-no-target') return
  // A ready receipt belongs to a prior job. The cancelled job has not reserved
  // Claude yet, so it must neither revalidate nor touch that prior pane.
  if (boundary.status === 'ready') return
  if (boundary.jobId !== options.jobId) {
    throw new ClaudeContextClearPendingError(
      `Claude boundary belongs to unfinished job ${boundary.jobId}`,
    )
  }
  if (boundary.status === 'job-no-claude') {
    writeBoundary(stateDir, readyWithoutClaudeState(boundary.repoRoot))
    return
  }
  if (boundary.status === 'clear-intent') {
    if (await reconcileIntent(stateDir, control, boundary, timing)) return
    throw new ClaudeContextClearPendingError(
      `Claude /clear remains unconfirmed for cancelled job ${boundary.jobId}`,
    )
  }
  if (boundary.status === 'cancel-intent') {
    let current: ClaudeAgentSnapshot
    try {
      current = await control.getAgent(boundary.target.paneId)
    } catch (error) {
      throw new ClaudeContextClearPendingError(
        `Claude cancellation identity is unavailable for job ${boundary.jobId}: ${error}`,
      )
    }
    const currentTarget = targetOf(current)
    if (!sameClaudeOccupant(boundary.target, currentTarget)) {
      // A durable cancel intent is never replayed.  The only safe recovery
      // after an operator follows the runbook (manual Ctrl-C, then /clear) is
      // a new native session in the exact same Herdr slot that remains at an
      // empty prompt for two snapshots.  This is a receipt for the manual
      // cleanup, not permission to send another key or command.
      if (sameClaudeSlot(boundary.target, currentTarget)
        && currentTarget.nativeSessionId !== boundary.target.nativeSessionId) {
        try {
          const manuallyCleared = await stableEmptyAgent(
            control,
            currentTarget,
            timing.stableDelayMs ?? 1_000,
            true,
          )
          writeBoundary(stateDir, readyState(manuallyCleared, boundary.repoRoot))
          return
        } catch (error) {
          throw new ClaudeContextClearPendingError(
            `Claude manual cancellation cleanup is unconfirmed for job ${boundary.jobId}: ${error}`,
          )
        }
      }
      throw new ClaudeContextClearPendingError(
        `Claude occupant changed after cancellation intent for job ${boundary.jobId}`,
      )
    }
    if (!isSettled(current)
      && current.agentStatus !== 'working'
      && current.agentStatus !== 'blocked') {
      throw new ClaudeContextClearPendingError(
        `Claude cancellation reached unsafe state ${current.agentStatus} for job ${boundary.jobId}`,
      )
    }
    let settled: ClaudeAgentSnapshot
    try {
      settled = isSettled(current)
        ? await stableEmptyAgent(
            control,
            targetOf(current),
            timing.stableDelayMs ?? 1_000,
            true,
          )
        : await waitForCancelledClaudeToSettle(control, boundary.target, timing)
    } catch (error) {
      throw new ClaudeContextClearPendingError(
        `Claude cancellation remains pending for job ${boundary.jobId}; it was not resent: ${error}`,
      )
    }
    await clearCancelledClaude(stateDir, control, boundary, settled, timing)
    return
  }

  let current = await control.getAgent(boundary.target.paneId)
  if (!sameClaudeOccupant(boundary.target, targetOf(current))) {
    throw new ClaudeContextClearPendingError(
      `Claude occupant changed before cancellation for job ${boundary.jobId}`,
    )
  }
  if (isSettled(current)) {
    const settled = await stableEmptyAgent(
      control,
      targetOf(current),
      timing.stableDelayMs ?? 1_000,
      false,
    )
    await clearCancelledClaude(stateDir, control, boundary, settled, timing)
    return
  }
  if (current.agentStatus !== 'working' && current.agentStatus !== 'blocked') {
    throw new ClaudeContextClearPendingError(
      `Claude is in unsafe cancellation state ${current.agentStatus}`,
    )
  }
  if (!control.interruptAgent) {
    throw new ClaudeContextClearPendingError('Claude interrupt transport is unavailable')
  }
  const intent = cancelIntent(
    boundary.jobId,
    boundary.attemptNonce,
    boundary.repoRoot,
    targetOf(current),
  )
  writeBoundary(stateDir, intent)
  current = await control.getAgent(intent.target.paneId)
  if (!sameClaudeOccupant(intent.target, targetOf(current))) {
    throw new ClaudeContextClearPendingError(
      `Claude occupant changed before interrupt delivery for job ${intent.jobId}`,
    )
  }
  if (isSettled(current)) {
    const settled = await stableEmptyAgent(
      control,
      targetOf(current),
      timing.stableDelayMs ?? 1_000,
      true,
    )
    await clearCancelledClaude(stateDir, control, intent, settled, timing)
    return
  }
  if (current.agentStatus !== 'working' && current.agentStatus !== 'blocked') {
    throw new ClaudeContextClearPendingError(
      `Claude changed to unsafe cancellation state ${current.agentStatus}`,
    )
  }
  let interruptError: unknown
  try {
    await control.interruptAgent(intent.target.paneId)
  } catch (error) {
    interruptError = error
  }
  if (interruptError) {
    current = await control.getAgent(intent.target.paneId)
    if (!sameClaudeOccupant(intent.target, targetOf(current))) {
      throw new ClaudeContextClearPendingError(
        `Claude interrupt delivery is ambiguous for job ${intent.jobId}; it was not resent: `
          + String(interruptError),
      )
    }
    if (!isSettled(current)
      && current.agentStatus !== 'working'
      && current.agentStatus !== 'blocked') {
      throw new ClaudeContextClearPendingError(
        `Claude interrupt reached unsafe state ${current.agentStatus} for job ${intent.jobId}`,
      )
    }
  }
  let settled: ClaudeAgentSnapshot
  try {
    settled = await waitForCancelledClaudeToSettle(control, intent.target, timing)
  } catch (error) {
    throw new ClaudeContextClearPendingError(
      `Claude cancellation remains pending for job ${intent.jobId}; it was not resent: ${error}`,
    )
  }
  await clearCancelledClaude(stateDir, control, intent, settled, timing)
}

export async function finalizeClaudeQueueJob(options: {
  stateDir: string
  runtime: HerdrRuntimeIdentity
  jobId: string
  control?: ClaudeHerdrControl
  timing?: TimingOptions
  cancelRequested?: () => boolean
}): Promise<void> {
  const stateDir = requireManagedStateRoot(options.stateDir)
  const control = options.control ?? createClaudeHerdrControl(options.runtime)
  const timing = options.timing ?? {}
  const throwIfCancelled = (): void => {
    if (options.cancelRequested?.()) {
      throw new ClaudeJobCancellationRequestedError(options.jobId)
    }
  }
  let boundary: ClaudeQueueBoundaryState | null
  try {
    boundary = readClaudeQueueBoundary(stateDir)
  } catch (error) {
    throw new ClaudeContextClearPendingError(`Claude queue boundary cannot be read: ${error}`)
  }
  if (!boundary) {
    throw new ClaudeContextClearPendingError(
      `Claude reservation is missing for job ${options.jobId}`,
    )
  }
  if (boundary.status === 'ready-no-target') return
  if (boundary.status === 'job-no-claude') {
    if (boundary.jobId !== options.jobId) {
      throw new ClaudeContextClearPendingError(
        `Claude skip boundary belongs to unfinished job ${boundary.jobId}`,
      )
    }
    writeBoundary(stateDir, readyWithoutClaudeState(boundary.repoRoot))
    return
  }
  if (boundary.status === 'ready') {
    try {
      await stableEmptyAgent(
        control,
        boundary.target,
        timing.stableDelayMs ?? 1_000,
        true,
      )
      return
    } catch (error) {
      throw new ClaudeContextClearPendingError(
        `the cleared Claude advisor changed before job completion: ${error}`,
      )
    }
  }
  if (boundary.jobId !== options.jobId) {
    throw new ClaudeContextClearPendingError(
      `Claude boundary belongs to unfinished job ${boundary.jobId}`,
    )
  }
  if (boundary.status === 'clear-intent') {
    const confirmed = await reconcileIntent(stateDir, control, boundary, timing)
    if (confirmed) return
    throw new ClaudeContextClearPendingError(
      `Claude /clear remains unconfirmed for job ${boundary.jobId}; it was not resent`,
    )
  }
  if (boundary.status === 'cancel-intent') {
    throw new ClaudeContextClearPendingError(
      `Claude cancellation remains unconfirmed for job ${boundary.jobId}; it was not resent`,
    )
  }
  try {
    if (boundary.promptState === 'armed') {
      throwIfCancelled()
      const current = await control.getAgent(boundary.target.paneId)
      const currentTarget = targetOf(current)
      if (!sameClaudeSlot(boundary.target, currentTarget)) {
        throw new Error('Claude slot changed after ambiguous prompt delivery')
      }
      if (currentTarget.nativeSessionId === boundary.target.nativeSessionId) {
        throw new Error(
          'Claude prompt delivery is ambiguous; stop the daemon, settle the dedicated pane, '
          + 'send /clear manually, then run recover-interrupted',
        )
      }
      const manuallyCleared = await stableEmptyAgent(
        control,
        currentTarget,
        timing.stableDelayMs ?? 1_000,
        true,
      )
      throwIfCancelled()
      writeBoundary(stateDir, readyState(manuallyCleared, boundary.repoRoot))
      return
    }
    throwIfCancelled()
    const settled = boundary.promptState === 'none'
      ? await stableEmptyAgent(
          control,
          boundary.target,
          timing.stableDelayMs ?? 1_000,
          false,
        )
      : await waitForJobClaudeToSettle(
          control,
          boundary.target,
          timing,
          boundary.jobId,
          options.cancelRequested,
        )
    throwIfCancelled()
    await clearAndRecord(
      stateDir,
      control,
      clearIntent(
        'job-end', boundary.jobId, boundary.attemptNonce,
        boundary.repoRoot, targetOf(settled),
      ),
      timing,
    )
    throwIfCancelled()
  } catch (error) {
    if (error instanceof ClaudeJobCancellationRequestedError) throw error
    throw new ClaudeContextClearPendingError(
      `Claude context cleanup is pending for job ${boundary.jobId}: ${error}`,
    )
  }
}

export async function reconcileClaudeQueueBoundary(options: {
  stateDir: string
  runtime: HerdrRuntimeIdentity
  control?: ClaudeHerdrControl
  timing?: TimingOptions
  cancelRequested?: (jobId: string) => boolean
}): Promise<void> {
  let state: ClaudeQueueBoundaryState | null
  try {
    state = readClaudeQueueBoundary(options.stateDir)
  } catch (error) {
    throw new ClaudeContextClearPendingError(`Claude queue boundary cannot be read: ${error}`)
  }
  if (!state || state.status === 'ready' || state.status === 'ready-no-target') return
  if (state.status === 'clear-intent') {
    const control = options.control ?? createClaudeHerdrControl(options.runtime)
    const confirmed = await reconcileIntent(
      options.stateDir,
      control,
      state,
      options.timing ?? {},
    )
    if (confirmed) return
    throw new ClaudeContextClearPendingError(
      `Claude /clear remains unconfirmed for job ${state.jobId}; startup will not resend it`,
    )
  }
  if (state.status === 'cancel-intent') {
    await cancelClaudeQueueJob({
      stateDir: options.stateDir,
      runtime: options.runtime,
      jobId: state.jobId,
      control: options.control,
      timing: options.timing,
    })
    return
  }
  if (options.cancelRequested?.(state.jobId)) {
    await cancelClaudeQueueJob({
      stateDir: options.stateDir,
      runtime: options.runtime,
      jobId: state.jobId,
      control: options.control,
      timing: options.timing,
    })
    return
  }
  try {
    await finalizeClaudeQueueJob({
      stateDir: options.stateDir,
      runtime: options.runtime,
      jobId: state.jobId,
      control: options.control,
      timing: options.timing,
      cancelRequested: options.cancelRequested
        ? () => options.cancelRequested!(state!.jobId)
        : undefined,
    })
  } catch (error) {
    if (!(error instanceof ClaudeJobCancellationRequestedError)) throw error
    await cancelClaudeQueueJob({
      stateDir: options.stateDir,
      runtime: options.runtime,
      jobId: state.jobId,
      control: options.control,
      timing: options.timing,
    })
  }
}
