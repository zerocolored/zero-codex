import { subprocessExitCode } from './process-exit-code.ts'

/** A missing JS callback must not keep an already-dead child occupying the queue. */
export async function waitForDirectExit(options: {
  callback: Promise<number>
  state: () => { exitCode: number | null; signalCode: number | string | null; generation: 'alive' | 'dead' | 'unknown' }
  warn: (reason: 'metadata-without-callback' | 'dead-without-exit-status') => void
  pollMs?: number
  deadGraceMs?: number
}): Promise<number> {
  let outcome: { code: number } | { error: unknown } | undefined
  void options.callback.then(code => { outcome = { code } }, error => { outcome = { error } })
  let deadSince: number | undefined
  while (true) {
    if (outcome) {
      if ('error' in outcome) throw outcome.error
      return outcome.code
    }
    const state = options.state()
    // Metadata is written by the subprocess runtime before notifying JS.
    // Check generation too: never retire a live/reused PID based on timing.
    if (state.generation === 'dead') {
      if (state.exitCode !== null || state.signalCode !== null) {
        options.warn('metadata-without-callback')
        return subprocessExitCode(state.exitCode, state.signalCode)
      }
      deadSince ??= Date.now()
      if (Date.now() - deadSince >= (options.deadGraceMs ?? 2_000)) {
        options.warn('dead-without-exit-status')
        // Unknown exit is failure, never fabricated success. Continue normal
        // descendant cleanup so its uncertainty cannot strand the supervisor.
        return 1
      }
    } else {
      deadSince = undefined
    }
    await Bun.sleep(options.pollMs ?? 100)
  }
}
