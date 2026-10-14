import type { JobStore, JobRecord } from './job-runner.ts'
import type { CodexLiveControlHooks } from './codex-executor.ts'

/** Both primary transports use the same queue-owner transactions. */
export function createPrimaryLiveControlHooks(store: JobStore, job: JobRecord): CodexLiveControlHooks {
  return {
    recordGoalStatus: status => store.recordTaskGoalStatus(job.id, status),
    next: () => store.nextReadyLiveInput(job.id, job.controlEpoch),
    nextInterjection: () => store.nextPendingInterjection(job.id, job.controlEpoch),
    bindTurn: (executorNonce, threadId, turnId) => store.bindAppServerTurn(
      job.id,
      job.workerId!,
      job.controlEpoch,
      executorNonce,
      threadId,
      turnId,
    ),
    bindNativeTurn: (nonce, threadId, parentTurnId, turnId) => (
      store.bindNativeAppServerTurn(
        job.id, job.workerId!, job.controlEpoch, nonce, threadId, parentTurnId, turnId,
      )
    ),
    beginInitialDispatch: ({
      executorNonce, threadId, requestId, inputRevision, inputDigest,
    }) => (
      store.beginInitialTurnDispatch({
        jobId: job.id,
        attempt: job.attempts,
        epoch: job.controlEpoch,
        executorNonce,
        threadId,
        requestId,
        inputRevision,
        inputDigest,
      })
    ),
    acknowledgeInitialDispatch: ({
      executorNonce, threadId, turnId, requestId,
    }) => store.acknowledgeInitialTurnDispatch({
      jobId: job.id,
      workerId: job.workerId!,
      attempt: job.attempts,
      epoch: job.controlEpoch,
      executorNonce,
      threadId,
      turnId,
      requestId,
    }),
    initialDispatchAmbiguous: (requestId, error) => (
      store.markInitialTurnDispatchAmbiguous({
        jobId: job.id,
        attempt: job.attempts,
        requestId,
        error,
      })
    ),
    initialDispatchRejected: (requestId, error) => (
      store.markInitialTurnDispatchRejected({
        jobId: job.id,
        attempt: job.attempts,
        requestId,
        error,
      })
    ),
    preparePhaseDispatch: ({
      phaseSequence, stage, logicalNonce, threadId, inputRevision, inputDigest,
    }) => store.prepareAppServerPhaseDispatch({
      jobId: job.id,
      attempt: job.attempts,
      epoch: job.controlEpoch,
      phaseSequence,
      stage,
      logicalNonce,
      threadId,
      inputRevision,
      inputDigest,
    }),
    beginPhaseDispatch: ({
      phaseSequence, logicalNonce, threadId, requestId,
      inputRevision, inputDigest,
    }) => store.beginAppServerPhaseDispatch({
      jobId: job.id,
      attempt: job.attempts,
      epoch: job.controlEpoch,
      phaseSequence,
      logicalNonce,
      threadId,
      requestId,
      inputRevision,
      inputDigest,
    }),
    acknowledgePhaseDispatch: ({
      phaseSequence, logicalNonce, threadId, turnId, requestId,
    }) => store.acknowledgeAppServerPhaseDispatch({
      jobId: job.id,
      workerId: job.workerId!,
      attempt: job.attempts,
      epoch: job.controlEpoch,
      phaseSequence,
      logicalNonce,
      threadId,
      turnId,
      requestId,
    }),
    phaseDispatchAmbiguous: (phaseSequence, requestId, error) => (
      store.markAppServerPhaseDispatchAmbiguous({
        jobId: job.id,
        attempt: job.attempts,
        phaseSequence,
        requestId,
        error,
      })
    ),
    phaseDispatchRejected: (phaseSequence, requestId, error) => (
      store.markAppServerPhaseDispatchRejected({
        jobId: job.id,
        attempt: job.attempts,
        phaseSequence,
        requestId,
        error,
      })
    ),
    sealPhaseResult: ({
      logicalNonce, threadId, inputRevision, inputDigest, execution,
    }) => (
      store.sealAppServerPhaseResult({
        jobId: job.id,
        epoch: job.controlEpoch,
        logicalNonce,
        threadId,
        inputRevision,
        inputDigest,
        execution,
      })
    ),
    beginDispatch: ({
      control, executorNonce, threadId, turnId, requestId,
    }) => {
      if (control.kind === 'interjection') {
        if (!turnId) throw new Error('interjection pause omitted its active turn')
        store.beginInterjectionPause({
          interjectionId: control.id,
          jobId: job.id,
          epoch: job.controlEpoch,
          executorNonce,
          threadId,
          turnId,
          requestId,
        })
        return
      }
      store.beginControlDispatch({
        controlId: control.id,
        jobId: job.id,
        epoch: job.controlEpoch,
        executorNonce,
        threadId,
        turnId,
        requestId,
      })
    },
    acknowledge: (control, requestId, turnId) => {
      if (control.kind === 'interjection') {
        store.acknowledgeInterjectionPause(control.id, requestId, turnId)
        return
      }
      store.acknowledgeControl(control.id, requestId, turnId)
    },
    ambiguous: (control, error) => {
      if (control.kind === 'interjection') {
        store.markInterjectionAmbiguous(control.id, error)
        return
      }
      store.markControlAmbiguous(control.id, error)
    },
    deferToNextTurn: (
      control, requestId, executorNonce, threadId, turnId, error,
    ) => {
      if (control.kind === 'interjection') {
        store.deferInterjectionPause({
          interjectionId: control.id,
          requestId,
          executorNonce,
          threadId,
          turnId,
          error,
        })
        return
      }
      store.deferControlToNextTurn({
        controlId: control.id,
        requestId,
        executorNonce,
        threadId,
        turnId,
        error,
      })
    },
    finishTurn: ({
      executorNonce, threadId, turnId, retainInput, rateLimitResumeAt,
      rateLimitReason, rateLimitSafeToReplay,
    }) => store.finishAppServerTurn({
      jobId: job.id,
      epoch: job.controlEpoch,
      executorNonce,
      threadId,
      turnId,
      retainInput,
      rateLimitResumeAt,
      rateLimitReason,
      rateLimitSafeToReplay,
    }),
    recordRateLimit: ({ executorNonce, threadId, turnId, resumeAt }) => (
      store.recordAppServerRateLimit({
        jobId: job.id,
        epoch: job.controlEpoch,
        executorNonce,
        threadId,
        turnId,
        resumeAt,
      })
    ),
    prepareInterjectionAnswer: ({ interjection, logicalNonce, threadId }) => (
      store.prepareInterjectionAnswer({
        interjectionId: interjection.id,
        jobId: job.id,
        epoch: job.controlEpoch,
        logicalNonce,
        threadId,
      })
    ),
    beginInterjectionAnswer: ({
      interjection, logicalNonce, threadId, requestId,
    }) => store.beginInterjectionAnswer({
      interjectionId: interjection.id,
      jobId: job.id,
      epoch: job.controlEpoch,
      logicalNonce,
      threadId,
      requestId,
    }),
    acknowledgeInterjectionAnswer: ({
      interjection, logicalNonce, threadId, turnId, requestId,
    }) => store.acknowledgeInterjectionAnswer({
      interjectionId: interjection.id,
      jobId: job.id,
      workerId: job.workerId!,
      epoch: job.controlEpoch,
      logicalNonce,
      threadId,
      turnId,
      requestId,
    }),
    rejectInterjectionAnswer: ({
      interjection, logicalNonce, threadId, requestId, error,
    }) => store.rejectInterjectionAnswer({
      interjectionId: interjection.id,
      logicalNonce,
      threadId,
      requestId,
      error,
    }),
    retryInterjectionAnswer: ({ interjection, logicalNonce, threadId, turnId }) => (
      store.retryInterjectionAnswer({
        interjectionId: interjection.id, jobId: job.id, epoch: job.controlEpoch,
        logicalNonce, threadId, turnId,
      })
    ),
    stageInterjectionAnswer: ({
      interjection, logicalNonce, threadId, turnId, disposition, answer,
    }) => store.stageInterjectionAnswer({
      interjectionId: interjection.id,
      jobId: job.id,
      epoch: job.controlEpoch,
      logicalNonce,
      threadId,
      turnId,
      disposition,
      answer,
    }),
    interjectionDelivered: interjection => (
      store.interjectionIsDelivered(interjection.id)
    ),
    promoteInterjection: interjection => (
      store.promoteDeliveredInterjection(interjection.id)
    ),
    cancellationRequested: () => store.get(job.id)?.cancelRequestedAt != null,

  }
}
