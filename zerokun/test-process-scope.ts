import type { Subprocess } from 'bun'

/** Own test children from spawn, before process-generation probes or assertions. */
export class TestProcessScope implements AsyncDisposable {
  private readonly children: Subprocess[] = []

  own<T extends Subprocess>(child: T): T {
    this.children.push(child)
    return child
  }

  async [Symbol.asyncDispose](): Promise<void> {
    // Use retained child handles, not a PID guessed from a failed identity probe.
    // Test fixtures can deliberately ignore SIGTERM; always reap every child.
    const results = await Promise.allSettled(this.children.map(async child => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await child.exited
    }))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'test child cleanup failed')
  }
}
