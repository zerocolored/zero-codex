import { subprocessExitCode } from './process-exit-code.ts'

/** A missing JS callback must not keep an already-dead child occupying the queue. */
export async function waitForDirectExit(options: {
  callback: Promise<number>
  state: () => { exitCode: number | null; signalCode: number | string | null; generation: 'alive' | 'dead' | 'unknown' }
  warn: (reason: 'metadata-without-callback' | 'dead-without-exit-status') => void
  pollMs?: number
  deadGraceMs?: number
}): Promise<number> {
  // Resolve directly from the exit callback, independently of the periodic
  // probe. A suspended sleep/continuation must not also suspend exit delivery.
  return new Promise<number>((resolve, reject) => {
    let done = false
    let deadSince: number | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    const finish = (code: number): void => {
      if (done) return
      done = true
      clearInterval(timer)
      resolve(code)
    }
    const fail = (error: unknown): void => {
      if (done) return
      done = true
      clearInterval(timer)
      reject(error)
    }
    const probe = (): void => {
      if (done) return
      try {
        const state = options.state()
        if (state.generation !== 'dead') {
          deadSince = undefined
          return
        }
        if (state.exitCode !== null || state.signalCode !== null) {
          options.warn('metadata-without-callback')
          finish(subprocessExitCode(state.exitCode, state.signalCode))
          return
        }
        deadSince ??= Date.now()
        if (Date.now() - deadSince >= (options.deadGraceMs ?? 2_000)) {
          options.warn('dead-without-exit-status')
          finish(1) // Unknown exit is never fabricated success.
        }
      } catch (error) { fail(error) }
    }
    void options.callback.then(finish, fail)
    timer = setInterval(probe, options.pollMs ?? 100)
    // Let an already delivered callback win before the first metadata probe.
    queueMicrotask(probe)
  })
}
