import { createHash } from 'crypto'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { registerNativeAdvisor, readNativeAdvisorRegistrations, type NativeAdvisorRegistration } from './native-advisor-recovery.ts'
import { nativeAdvisorResponseHasExactMarker, nativeAdvisorResponseDigest } from './native-advisor-evidence.ts'
import { readProcessIdentity, observeProcessGeneration, type ProcessIdentity } from './process-generation.ts'
import type { NativeAdvisorObservation } from './native-advisor-coverage.ts'
import { AdvisorOwnedProcessStillLiveError } from './advisor-broker.ts'

export type HostedNativeOutcome = {
  perspective: 'solution' | 'risk'
  adopted: true
  agentId: string
  response: string
} | { perspective: 'solution' | 'risk'; adopted: false; attempted: true; started: boolean; reason: string }
type Receipt = {
  version: 1
  registrationDigest: string
  status: 'dispatching' | 'running' | 'finished'
  process?: ProcessIdentity
  threadId?: string
  outcome?: HostedNativeOutcome
  containmentFailed?: boolean
}
type Runner = (input: {
  registration: NativeAdvisorRegistration
  onSpawn(pid: number): void
  signal: AbortSignal
}) => Promise<{ exitCode: number; stdout: string; outputTruncated: boolean; forcedCleanup: boolean }>

const pathFor = (contextPath: string, phase: string, round: number) => `${contextPath}.hosted-${phase}-${round}`
const digest = (registration: NativeAdvisorRegistration) => createHash('sha256').update(JSON.stringify(registration)).digest('hex')

/** One host process attempt per logical GPT slot. A lost response is reported
 * unavailable and never repaired by launching a duplicate reviewer. These
 * are standalone GPT threads, not fictional children of a Claude session. */
export class HostedCodexAdvisors {
  private pending = new Map<string, Promise<void>>()
  private controllers = new Map<string, AbortController>()
  private containmentFailure: Error | undefined
  private closed = false
  constructor(private contextPath: string, private attemptNonce: string, private run: Runner) {}

  start(request: Parameters<typeof registerNativeAdvisor>[0]) {
    if (this.containmentFailure) throw this.containmentFailure
    if (this.closed) throw new Error('GPT reviewer broker is closing')
    const registration = registerNativeAdvisor(request)
    const path = pathFor(this.contextPath, registration.phase, registration.round)
    const existing = this.read(registration)
    if (existing) return this.poll(registration.phase as 'investigation' | 'review', registration.round as 1 | 2)
    const receipt: Receipt = { version: 1, registrationDigest: digest(registration), status: 'dispatching' }
    atomicWritePrivateFile(path, JSON.stringify(receipt))
    const controller = new AbortController()
    this.controllers.set(path, controller)
    const task = (async () => {
      let reason = 'GPT reviewer did not produce a verified answer'
      try {
        const result = await this.run({ registration, signal: controller.signal, onSpawn(pid) {
          receipt.process = readProcessIdentity(pid) ?? undefined
          if (!receipt.process) throw new Error('GPT process identity unavailable')
          receipt.status = 'running'
          atomicWritePrivateFile(path, JSON.stringify(receipt))
        } })
        const events = result.stdout.split('\n').filter(Boolean).map(line => {
          try { return JSON.parse(line) } catch { return null }
        }).filter(Boolean)
        const threads = events.filter(event => event.type === 'thread.started')
        const terminal = events.filter(event => ['turn.completed', 'turn.failed'].includes(event.type))
        const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message')
        const response = messages.at(-1)?.item?.text
        if (threads.length === 1 && typeof threads[0].thread_id === 'string'
          && /^[a-f0-9-]{36}$/i.test(threads[0].thread_id)) receipt.threadId = threads[0].thread_id
        if (result.exitCode === 0 && !result.outputTruncated && !result.forcedCleanup
          && receipt.process && receipt.threadId && terminal.length === 1 && terminal[0].type === 'turn.completed'
          && typeof response === 'string' && Buffer.byteLength(response) <= 256 * 1024
          && nativeAdvisorResponseHasExactMarker(response, registration.marker)) {
          receipt.outcome = { perspective: registration.perspective, adopted: true,
            agentId: receipt.threadId, response }
        } else reason = `GPT reviewer unavailable (exit ${result.exitCode}; complete=${terminal.at(-1)?.type === 'turn.completed'}; truncated=${result.outputTruncated}; cleanup=${!result.forcedCleanup})`
      } catch (error) {
        if (error instanceof AdvisorOwnedProcessStillLiveError) {
          this.containmentFailure = error
          receipt.containmentFailed = true
        }
        reason = 'GPT reviewer could not start or complete its isolated read-only execution'
      }
      receipt.outcome ??= { perspective: registration.perspective, adopted: false, attempted: true,
        started: Boolean(receipt.process), reason }
      receipt.status = 'finished'
      atomicWritePrivateFile(path, JSON.stringify(receipt))
    })()
    this.pending.set(path, task)
    void task.finally(() => { this.pending.delete(path); this.controllers.delete(path) }).catch(() => {})
    return { complete: false, phase: registration.phase, round: registration.round,
      inputRevision: registration.inputRevision, inputDigest: registration.inputDigest }
  }

  private registration(phase: 'investigation' | 'review', round: 1 | 2) {
    const value = readNativeAdvisorRegistrations(this.contextPath, this.attemptNonce)
      .find(value => value.phase === phase && value.round === round)
    if (!value) throw new Error('GPT slot has not been started')
    return value
  }
  private read(registration: NativeAdvisorRegistration): Receipt | undefined {
    const text = readOptionalBoundedOwnerOnlyRegularFile(pathFor(this.contextPath, registration.phase, registration.round), 512 * 1024)
    if (!text) return
    const value = JSON.parse(text) as Receipt
    if (value.version !== 1 || value.registrationDigest !== digest(registration)
      || !['dispatching', 'running', 'finished'].includes(value.status)) throw new Error('GPT execution receipt is invalid')
    if (value.status === 'finished' && (!value.outcome || value.outcome.perspective !== registration.perspective)) throw new Error('GPT result receipt is incomplete')
    if (value.outcome?.adopted && (!value.process || value.threadId !== value.outcome.agentId
      || !nativeAdvisorResponseHasExactMarker(value.outcome.response, registration.marker))) throw new Error('GPT answer receipt is invalid')
    return value
  }
  async poll(phase: 'investigation' | 'review', round: 1 | 2, waitMs = 0) {
    if (this.containmentFailure) throw this.containmentFailure
    const registration = this.registration(phase, round), path = pathFor(this.contextPath, phase, round)
    const pending = this.pending.get(path)
    if (pending && waitMs > 0) await Promise.race([pending, Bun.sleep(Math.min(30_000, waitMs))])
    const receipt = this.read(registration)
    if (!receipt) throw new Error('GPT execution receipt is missing')
    if (receipt.containmentFailed) throw new AdvisorOwnedProcessStillLiveError('GPT reviewer cleanup requires host containment')
    const outcome = receipt.outcome ?? (!this.pending.has(path) ? {
      perspective: registration.perspective, adopted: false as const, attempted: true as const,
      started: Boolean(receipt.process), reason: 'GPT broker restarted after dispatch; original outcome is unavailable and the slot will not be repeated',
    } : undefined)
    return { complete: Boolean(outcome), phase, round, inputRevision: registration.inputRevision,
      inputDigest: registration.inputDigest, ...(outcome ? { nativeAdvisors: [outcome] } : {}) }
  }
  async verify(phase: 'investigation' | 'review', round: 1 | 2, supplied: unknown): Promise<void> {
    const actual = await this.poll(phase, round)
    const expected = actual.nativeAdvisors?.[0]
    const value = Array.isArray(supplied) && supplied.length === 1 ? supplied[0] : undefined
    if (!actual.complete || !expected || !value || typeof value !== 'object'
      || Object.entries(expected).some(([key, entry]) => value[key] !== entry)) {
      throw new Error('Use the exact completed host GPT outcome; model text cannot attest a hosted reviewer')
    }
  }
  async close(): Promise<void> {
    this.closed = true
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.allSettled(this.pending.values())
    if (this.containmentFailure) throw this.containmentFailure
  }
}

export async function waitForHostedCodexAdvisors(contextPath: string, attemptNonce: string,
  interrupted: () => boolean, timeoutMs = 60 * 60 * 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!interrupted()) {
    const running = readNativeAdvisorRegistrations(contextPath, attemptNonce, () => {}).some(registration => {
      try {
        const text = readOptionalBoundedOwnerOnlyRegularFile(pathFor(contextPath, registration.phase, registration.round), 512 * 1024)
        const receipt = text ? JSON.parse(text) as Receipt : null
        return receipt?.version === 1 && receipt.registrationDigest === digest(registration)
          && receipt.status !== 'finished' && receipt.process
          && observeProcessGeneration(receipt.process).status === 'alive'
      } catch { return false }
    })
    if (!running || Date.now() >= deadline) return
    await Bun.sleep(500)
  }
}

export function hostedAdvisorObservations(contextPath: string, attemptNonce: string): NativeAdvisorObservation[] {
  return readNativeAdvisorRegistrations(contextPath, attemptNonce, () => {}).flatMap(registration => {
    try {
      const text = readOptionalBoundedOwnerOnlyRegularFile(pathFor(contextPath, registration.phase, registration.round), 512 * 1024)
      const receipt = text ? JSON.parse(text) as Receipt : null
      if (!receipt || receipt.version !== 1 || receipt.registrationDigest !== digest(registration)) return []
      const valid = receipt.status === 'finished' && receipt.process && receipt.outcome?.adopted
        && receipt.threadId === receipt.outcome.agentId
        && nativeAdvisorResponseHasExactMarker(receipt.outcome.response, registration.marker)
      return [{ attemptNonce, inputRevision: registration.inputRevision, inputDigest: registration.inputDigest,
        phase: registration.phase, round: registration.round, perspective: registration.perspective,
        state: valid ? 'response-obtained' : receipt.process ? 'started-no-response' : 'unavailable-before-start',
        ...(valid && receipt.outcome?.adopted ? { threadId: receipt.threadId,
          responseDigest: nativeAdvisorResponseDigest(receipt.outcome.response) } : {}) } as NativeAdvisorObservation]
    } catch { return [] }
  })
}
