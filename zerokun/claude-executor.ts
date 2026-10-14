import { randomUUID } from 'crypto'
import { closeSync, writeSync } from 'fs'
import { join } from 'path'
import type { JobRecord, JobExecutionResult, JobLiveInputRecord, JobInterjectionRecord } from './job-runner.ts'
import {
  executeCodexJob, buildCodexWorkerPrompt, buildCodexInterjectionPrompt, parseCodexInterjectionReply,
  CodexInterruptedError, CodexUserCancelledError, CodexInputChangedBeforeDispatchError,
  CodexCleanupPendingError, CodexInterjectionFormatError, CodexRateLimitError, collectHostAdvisorCoverage,
} from './codex-executor.ts'
import { ClaudeControlSession, ClaudeDeliveryUnknownError, claudeAssistantText, claudeResult } from './claude-control-session.ts'
import { openClaudeHerdrTransport, type ClaudeHerdrTransport } from './claude-herdr-transport.ts'
import { prepareClaudeJobContext } from './claude-job-context.ts'
import { assertClaudeMainlineReady } from './claude-mainline-runtime.ts'
import { readAdvisorInputSnapshot, type AdvisorInputSnapshot } from './advisor-input.ts'
import { parseSlackUpdateCommentary } from './codex-monitor-display.ts'
import { waitForAdvisorSettlement } from './advisor-settlement.ts'
import { ensureManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { openSafeLog, atomicWritePrivateFile } from './safe-file.ts'
import { assertDurableThreadHistorySnapshot } from './thread-history.ts'
import { hostedAdvisorObservations, waitForHostedCodexAdvisors } from './hosted-codex-advisor.ts'
import { ClaudeTurnFailure } from './claude-turn-failure.ts'
import { ClaudePrimaryUsage } from './claude-primary-usage.ts'
import { ClaudeProgress } from './claude-progress.ts'
import { ContinuedArtifactMessage } from './continued-artifact-message.ts'
import { previousThreadArtifactRoots } from './artifact-source.ts'

type Options = Parameters<typeof executeCodexJob>[1]
type Context = ReturnType<typeof prepareClaudeJobContext>
type Fixtures = {
  context?: (job: JobRecord, state: string) => Context
  executable?: (cwd: string) => string
  transport?: typeof openClaudeHerdrTransport
  settlement?: typeof waitForAdvisorSettlement
}

/** Native Claude is only the primary model/turn transport. Queue admission,
 * durable controls, read-only interjections, artifacts and publication retain
 * the same host ledger used by Codex. There is never an automatic core fallback. */
export async function executeClaudeJob(job: JobRecord, options: Options, fixtures: Fixtures = {}): Promise<JobExecutionResult> {
  if (job.runtime !== 'claude-code') throw new Error('Claude executor cannot run a job assigned to another core')
  const controls = options.liveControls
  if (!controls?.preparePhaseDispatch || !controls.beginPhaseDispatch || !controls.acknowledgePhaseDispatch
    || !controls.phaseDispatchAmbiguous || !controls.sealPhaseResult) throw new Error('Claude requires durable live-control hooks')
  if (!options.stateDir) throw new Error('Claude requires managed state')
  if (options.threadHistory) assertDurableThreadHistorySnapshot(options.threadHistory, {
    jobId: job.id, attempt: job.attempts, chatId: job.chatId, threadTs: job.threadTs,
    repoPath: job.historyRepoPath ?? job.repoPath, currentJobSeq: job.seq,
  })
  const stateDir = requireManagedStateRoot(options.stateDir)
  const executable = (fixtures.executable ?? assertClaudeMainlineReady)(job.repoPath)
  const context = (fixtures.context ?? prepareClaudeJobContext)(job, stateDir)
  const usage = new ClaudePrimaryUsage(stateDir, job.id, context.processNonce)
  const threadId = job.sessionId ?? randomUUID()
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error('invalid Claude session binding')
  ensureManagedDirectory(stateDir, options.logDir)
  const log = openSafeLog(join(options.logDir, `${job.id}-${job.attempts}-claude.jsonl`), 'append')
  let transport: ClaudeHerdrTransport | undefined, session: ClaudeControlSession | undefined
  let resumed = Boolean(job.sessionId), readonlyProcess = false, phaseSequence = 0, activeTurn: string | undefined
  let snapshot = readAdvisorInputSnapshot(stateDir, job.id)
  let resultText: string | undefined
  let interruptedTurn = false
  let pendingInterrupt: JobLiveInputRecord | undefined
  const milestones = new Set<string>()
  const continuedArtifacts = new ContinuedArtifactMessage(context.artifactDir,
    [context.scratchDir, context.tempDir, ...previousThreadArtifactRoots(job, stateDir)])
  const progress = new ClaudeProgress({ jobId: job.id, attempt: job.attempts,
    path: context.toolsContext.goalPath + '.progress', activatedAt: options.progressActivatedAtMs ?? Date.now(),
    schedule: options.progressScheduleForTesting, begin: options.onProgressProbeStarted, publish: options.onProgressReport })
  const abort = () => {
    if (controls.cancellationRequested()) throw new CodexUserCancelledError()
    if (options.signal?.aborted) throw new CodexInterruptedError('Claude job was interrupted')
  }
  const settle = () => (fixtures.settlement ?? waitForAdvisorSettlement)({
    stateDir, jobId: job.id, attemptNonce: context.attemptNonce, processNonce: context.processNonce,
    contextDigest: context.contextDigest,
    interrupted: () => options.signal?.aborted === true || controls.cancellationRequested(),
  })
  const closeProcess = async () => {
    if (!transport) return
    // External advisor work must settle before its MCP parent is retired.
    if (!readonlyProcess) {
      await settle()
      await waitForHostedCodexAdvisors(context.contextPath, context.attemptNonce,
        () => options.signal?.aborted === true || controls.cancellationRequested())
    }
    try { await session?.endInput() } catch { /* Reap through the recorded transport identity. */ }
    try { await transport.close() }
    catch (error) { throw new CodexCleanupPendingError(`Claude process cleanup pending: ${error}`) }
    await session?.close()
    transport = undefined; session = undefined
  }
  const openProcess = async (readonly: boolean) => {
    if (session && readonlyProcess === readonly) return
    await closeProcess(); abort()
    readonlyProcess = readonly
    transport = await (fixtures.transport ?? openClaudeHerdrTransport)({
      stateDir, jobId: job.id, sequence: job.seq, cwd: context.jobRepo, executable,
      arguments: context.argumentsFor(threadId, resumed, readonly),
      fingerprint: { allow: context.fingerprint.allow.path, deny: context.fingerprint.deny.path },
      signal: options.signal, onProcessId: options.onProcessId, onProcessExit: options.onProcessExit,
      onStderr: options.onStderrChunk,
    })
    session = new ClaudeControlSession(transport.input, transport.output, threadId, {
      expectedModel: context.pinnedModel,
      onEvent(event) {
        writeSync(log, JSON.stringify(event) + '\n')
        usage.observe(event)
        if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') context.pinModel(event.model)
      },
    })
    await session.initialize()
  }
  const prompt = (input: AdvisorInputSnapshot, continuation = false) => [
    continuation ? 'Continue this same task and retain prior work, approvals and advisor attempts. Do not restart the workflow.' : '',
    `Trusted host binding: job=${job.id}; inputRevision=${input.revision}; inputDigest=${input.digest}; attemptNonce=${context.attemptNonce}.`,
    buildCodexWorkerPrompt(job, input, undefined, !job.sessionId && phaseSequence === 0 ? options.threadHistory : undefined),
  ].filter(Boolean).join('\n\n')
  const resetGoal = () => atomicWritePrivateFile(context.toolsContext.goalPath,
    JSON.stringify({ ...context.goal(), status: 'active' }))

  const send = async (text: string, kind: 'initial' | 'phase' | 'control' | 'interjection',
    input?: JobLiveInputRecord): Promise<void> => {
    const messageId = randomUUID()
    let requestId: number | undefined
    const interjection = kind === 'interjection' ? input as JobInterjectionRecord : undefined
    if (kind === 'phase') {
      const disposition = controls.preparePhaseDispatch!({ phaseSequence, stage: 'prepare', logicalNonce: context.attemptNonce,
        threadId, inputRevision: snapshot.revision, inputDigest: snapshot.digest })
      if (disposition === 'cancelled') throw new CodexUserCancelledError()
      if (disposition === 'input-changed') throw new CodexInputChangedBeforeDispatchError()
    } else if (interjection) {
      const disposition = controls.prepareInterjectionAnswer({ interjection, logicalNonce: context.attemptNonce, threadId })
      if (disposition === 'cancelled') throw new CodexUserCancelledError()
      if (disposition === 'input-changed') throw new CodexInputChangedBeforeDispatchError()
    }
    try {
      usage.begin()
      await session!.sendUser({ messageId, content: text, beforeWrite(id) {
        requestId = id
        const base = { threadId, requestId: id, inputRevision: snapshot.revision, inputDigest: snapshot.digest }
        const disposition = kind === 'initial'
          ? controls.beginInitialDispatch({ ...base, executorNonce: context.attemptNonce })
          : kind === 'phase'
          ? controls.beginPhaseDispatch!({ ...base, logicalNonce: context.attemptNonce, phaseSequence })
          : interjection ? controls.beginInterjectionAnswer({ interjection, logicalNonce: context.attemptNonce, threadId, requestId: id })
          : controls.beginDispatch({ control: input!, executorNonce: context.attemptNonce, threadId, requestId: id })
        if (disposition === 'cancelled') throw new CodexUserCancelledError()
        if (disposition === 'input-changed' || disposition === 'pending-inbound') throw new CodexInputChangedBeforeDispatchError()
      } })
    } catch (error) {
      if (requestId !== undefined && error instanceof ClaudeDeliveryUnknownError) {
        if (kind === 'initial') controls.initialDispatchAmbiguous(requestId, error.message)
        else if (kind === 'phase') controls.phaseDispatchAmbiguous!(phaseSequence, requestId, error.message)
        else controls.ambiguous(input!, error.message)
      }
      throw error
    }
    if (requestId === undefined) throw new Error('Claude dispatch has no durable request')
    // initialize alone does not create a persisted native conversation. Do not
    // poison future resume with a UUID that never received a user-message ACK.
    options.onSessionId?.(threadId)
    resumed = true
    activeTurn = messageId
    if (kind === 'initial') controls.acknowledgeInitialDispatch({ executorNonce: context.attemptNonce, threadId, turnId: messageId, requestId })
    else if (kind === 'phase') controls.acknowledgePhaseDispatch!({ phaseSequence, logicalNonce: context.attemptNonce, threadId, turnId: messageId, requestId })
    else if (interjection) controls.acknowledgeInterjectionAnswer({ interjection, logicalNonce: context.attemptNonce, threadId, turnId: messageId, requestId })
    else {
      controls.acknowledge(input!, requestId, messageId)
      controls.bindTurn(context.attemptNonce, threadId, messageId)
    }
  }

  const receive = async (interjection?: JobInterjectionRecord): Promise<ReturnType<typeof claudeResult>> => {
    let interruptDeadline: number | undefined
    const failure = new ClaudeTurnFailure()
    while (true) {
      if (options.signal?.aborted) throw new CodexInterruptedError('Claude job was interrupted')
      if (!interjection) progress.tick(Boolean(controls.next() || controls.cancellationRequested() || pendingInterrupt || interruptedTurn))
      const event = await session!.nextEvent(100)
      if (event) {
        failure.observe(event)
        const text = claudeAssistantText(event)
        if (text && !interjection) {
          options.onHandoffContext?.(`${threadId}:${String(event.uuid ?? activeTurn)}`, text)
          options.onMonitorMessage?.(text)
          const milestone = parseSlackUpdateCommentary(text)
          const key = milestone ? `${snapshot.revision}:${milestone.kind}` : ''
          if (milestone && !milestones.has(key)) {
            options.onCommentaryMessage?.({ sourceKey: `${threadId}:${activeTurn}:${key}`, text: `💬 ${milestone.text}`,
              inputRevision: snapshot.revision, milestoneKind: milestone.kind })
            milestones.add(key)
          }
        }
        const terminal = claudeResult(event)
        if (terminal && !session!.model) throw new Error('Claude did not announce its primary Opus model')
        const retry = terminal ? failure.terminal(event) : null
        if (retry && !controls.cancellationRequested()) {
          if (retry.reason === 'rate-limit') options.onCloudQuotaDetected?.(retry.resumeAt)
          controls.finishTurn({ executorNonce: context.attemptNonce, threadId, turnId: activeTurn!, retainInput: true,
            rateLimitResumeAt: retry.resumeAt, rateLimitReason: retry.reason, rateLimitSafeToReplay: false })
          activeTurn = undefined
          throw new CodexRateLimitError('Claude authoritative failed turn will resume from its preserved session',
            retry.resumeAt, threadId, retry.reason, false, 'complete', phaseSequence)
        }
        if (terminal) return terminal
      }
      if (interruptDeadline !== undefined && Date.now() >= interruptDeadline) {
        throw new Error('Claude did not produce a terminal after interrupt; delivery remains unknown')
      }
      if (pendingInterrupt || interruptedTurn) continue
      const next = controls.next()
      if (!next) {
        if (controls.cancellationRequested()) throw new CodexUserCancelledError()
        continue
      }
      // A question-answer turn remains read-only and is never replaced by a
      // later steer. Cancellation may still preempt it.
      if (interjection && next.kind !== 'interrupt') continue
      if (next.kind === 'steer') {
        // Native replay ACK is not proof of an active-turn steer. Interrupt,
        // observe the terminal, then deliver the still-ready control once.
        await session!.request({ subtype: 'interrupt' })
        interruptedTurn = true
      } else {
        try {
          const response = await session!.request({ subtype: 'interrupt' }, requestId => {
            controls.beginDispatch({ control: next, executorNonce: context.attemptNonce, threadId,
              turnId: activeTurn!, requestId })
          })
          controls.acknowledge(next, response.requestId, activeTurn!)
          pendingInterrupt = next
        } catch (error) {
          if (error instanceof ClaudeDeliveryUnknownError) controls.ambiguous(next, error.message)
          throw error
        }
      }
      interruptDeadline = Date.now() + (options.cancellationTerminalGraceMs ?? 30_000)
    }
  }
  const finish = async () => {
    while (true) {
      const barrier = controls.finishTurn({ executorNonce: context.attemptNonce, threadId, turnId: activeTurn!, retainInput: true })
      if (barrier.cancelled) throw new CodexUserCancelledError()
      if (!barrier.pendingInbound) break
      abort(); await Bun.sleep(100)
    }
    activeTurn = undefined; pendingInterrupt = undefined; interruptedTurn = false
  }
  const answerQuestion = async (interjection: JobInterjectionRecord) => {
    await openProcess(true)
    while (true) {
      abort()
      await send(buildCodexInterjectionPrompt(job, interjection, context.attemptNonce), 'interjection', interjection)
      const terminal = await receive(interjection)
      abort()
      if (terminal?.kind !== 'success') throw new Error('Claude interjection did not complete')
      let reply: ReturnType<typeof parseCodexInterjectionReply>
      try { reply = parseCodexInterjectionReply(terminal.text, interjection.id) }
      catch (error) {
        if (!(error instanceof CodexInterjectionFormatError)) throw error
        const retry = controls.retryInterjectionAnswer({ interjection, logicalNonce: context.attemptNonce, threadId, turnId: activeTurn! })
        if (retry === 'cancelled') throw new CodexUserCancelledError()
        activeTurn = undefined
        await Bun.sleep(Math.min(1_000, Math.max(100, retry)))
        continue
      }
      const staged = controls.stageInterjectionAnswer({ interjection, logicalNonce: context.attemptNonce, threadId,
        turnId: activeTurn!, ...reply })
      if (staged === 'cancelled') throw new CodexUserCancelledError()
      activeTurn = undefined
      await closeProcess()
      while (!controls.interjectionDelivered(interjection)) { abort(); await Bun.sleep(100) }
      return controls.promoteInterjection(interjection)
    }
  }

  try {
    abort()
    await openProcess(false)
    while (true) {
      snapshot = readAdvisorInputSnapshot(stateDir, job.id)
      try { await send(prompt(snapshot), 'initial'); break }
      catch (error) { if (!(error instanceof CodexInputChangedBeforeDispatchError)) throw error; abort(); await Bun.sleep(100) }
    }
    while (true) {
      if (activeTurn) {
        const terminal = await receive()
        abort()
        if (terminal?.kind === 'failed' || (terminal?.kind === 'cancelled' && !pendingInterrupt && !interruptedTurn)) {
          throw new Error('Claude returned an unsuccessful task terminal; no automatic replay was performed')
        }
        resultText = terminal?.kind === 'success' && !pendingInterrupt && !interruptedTurn ? terminal.text : undefined
        if (resultText) continuedArtifacts.observe(resultText, snapshot.revision)
        const retireInterruptedProcess = Boolean(pendingInterrupt || interruptedTurn)
        await finish()
        // A completed MCP call may have returned a still-running command
        // session. Retire its process tree before a steered task can proceed.
        if (retireInterruptedProcess) await closeProcess()
        phaseSequence += 1
      }
      abort()
      const question = controls.nextInterjection()
      if (question) {
        const disposition = await answerQuestion(question)
        if (disposition === 'task-update') { resultText = undefined; resetGoal() }
        continue
      }
      const next = controls.next()
      if (next?.kind === 'interrupt') throw new CodexUserCancelledError()
      if (next?.kind === 'steer') {
        await openProcess(false); resetGoal()
        snapshot = readAdvisorInputSnapshot(stateDir, job.id, next.inputRevision)
        await send(prompt(snapshot, true), 'control', next)
        resultText = undefined
        continue
      }
      if (next?.kind === 'interjection') continue
      const goal = context.goal()
      if (!goal || !['active', 'paused', 'blocked', 'complete'].includes(goal.status)) throw new Error('Claude goal state unavailable')
      controls.recordGoalStatus?.(goal.status)
      if (resultText && goal.status !== 'active') {
        const finalInput = readAdvisorInputSnapshot(stateDir, job.id)
        // Do not seal an answer for input that was never delivered to Claude.
        if (finalInput.revision === snapshot.revision && finalInput.digest === snapshot.digest) {
          await closeProcess()
          abort()
          let execution: JobExecutionResult = { sessionId: threadId,
            result: continuedArtifacts.resolve(resultText, snapshot.revision, goal.status),
            ...(goal.status !== 'complete' ? { taskGoalStatus: goal.status } : {}),
            advisorCoverage: collectHostAdvisorCoverage(stateDir, job.id, context.attemptNonce,
              hostedAdvisorObservations(context.contextPath, context.attemptNonce)) }
          if (options.finalizeSuccessfulResult) execution = options.finalizeSuccessfulResult(execution)
          const seal = controls.sealPhaseResult!({ logicalNonce: context.attemptNonce, threadId,
            inputRevision: finalInput.revision, inputDigest: finalInput.digest, execution })
          if (seal === 'cancelled') throw new CodexUserCancelledError()
          if (seal === 'sealed') return execution
          // An inbound notification may still be hydrating. Do not replay
          // completed work while waiting for its durable control to appear.
          await Bun.sleep(100)
          continue
        }
      }
      await openProcess(false)
      snapshot = readAdvisorInputSnapshot(stateDir, job.id)
      resetGoal()
      try { await send(prompt(snapshot, true), 'phase') }
      catch (error) { if (!(error instanceof CodexInputChangedBeforeDispatchError)) throw error; abort(); await Bun.sleep(100) }
    }
  } finally {
    try { await closeProcess(); context.retire() }
    finally { usage.close(); closeSync(log) }
  }
}
