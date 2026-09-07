import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  observeProcessGeneration,
  readProcessIdentity,
  signalProcessIfLive,
  type ProcessIdentity,
} from './process-generation.ts'
import {
  clearAbandonedRunnerLaunchIntent,
  clearRunnerLaunchReceiptAfterReap,
  clearUnspawnedRunnerLaunchIntent,
  prepareRunnerLaunchReceipt,
  readRunnerLaunchReceipt,
  runnerLaunchReceiptPath,
  waitForPublishedRunnerLaunchReceipt,
} from './runner-launch-receipt.ts'

const directories: string[] = []
const processes: ProcessIdentity[] = []

afterEach(async () => {
  for (const identity of processes.splice(0)) {
    signalProcessIfLive(identity, 'SIGTERM')
    await Bun.sleep(25)
    signalProcessIfLive(identity, 'SIGKILL')
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function stateDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label))
  directories.push(root)
  chmodSync(root, 0o700)
  const state = join(root, 'state')
  mkdirSync(state, { mode: 0o700 })
  return state
}

async function waitForExit(identity: ProcessIdentity, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (observeProcessGeneration(identity).status === 'dead') return true
    await Bun.sleep(10)
  }
  return false
}

describe('durable runner launch receipt', () => {
  test('prepared intentはowner-onlyで、live launcherだけが未spawn状態を消せる', () => {
    if (process.platform !== 'darwin') return
    const state = stateDirectory('zerokun-runner-receipt-prepared-')
    const launcher = readProcessIdentity(process.pid)
    expect(launcher).toBeDefined()

    const prepared = prepareRunnerLaunchReceipt(state, launcher!)
    expect(readRunnerLaunchReceipt(state)).toEqual(prepared)
    expect(statSync(runnerLaunchReceiptPath(state)).mode & 0o777).toBe(0o600)
    expect(() => clearAbandonedRunnerLaunchIntent(state, prepared)).toThrow(
      'live runner launcher intent cannot be abandoned',
    )
    expect(clearUnspawnedRunnerLaunchIntent(state, prepared)).toBe(true)
    expect(readRunnerLaunchReceipt(state)).toBeNull()
  })

  test('child helperがexec前に同一PID generationをpublishし、reap後だけ消せる', async () => {
    if (process.platform !== 'darwin') return
    const state = stateDirectory('zerokun-runner-receipt-child-')
    const launcher = readProcessIdentity(process.pid)
    expect(launcher).toBeDefined()
    const prepared = prepareRunnerLaunchReceipt(state, launcher!)
    const helper = join(import.meta.dir, 'runner-launch-receipt.ts')
    const bootstrap = [
      'set -euo pipefail',
      '"$1" --config=/dev/null --no-env-file "$2" publish-child "$3"',
      'exec /bin/sleep 60',
    ].join('\n')
    const child = Bun.spawn([
      '/bin/bash', '--noprofile', '--norc', '-c', bootstrap,
      'receipt-test', process.execPath, helper, state,
    ], {
      detached: true,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ZEROKUN_RUNNER_LAUNCH_INTENT: prepared.intentId },
    })
    let identity = readProcessIdentity(child.pid)
    for (let attempt = 0; attempt < 100 && identity?.pgid !== child.pid; attempt += 1) {
      await Bun.sleep(10)
      identity = readProcessIdentity(child.pid)
    }
    expect(identity?.pgid).toBe(child.pid)
    processes.push(identity!)

    const published = await waitForPublishedRunnerLaunchReceipt(state, {
      intentId: prepared.intentId,
      launcher: prepared.launcher,
      timeoutMs: 2_000,
    })
    if (!published) {
      signalProcessIfLive(identity!, 'SIGKILL')
      await child.exited
      throw new Error(`receipt was not published: ${await new Response(child.stderr).text()}`)
    }
    expect(published.runner.pid).toBe(child.pid)
    expect(() => clearRunnerLaunchReceiptAfterReap(state, published, identity!)).toThrow(
      'cannot be cleared before child reap',
    )

    expect(signalProcessIfLive(identity!, 'SIGTERM')).toBe(true)
    await child.exited
    expect(await waitForExit(identity!)).toBe(true)
    expect(clearRunnerLaunchReceiptAfterReap(state, published, identity!)).toBe(true)
    expect(readRunnerLaunchReceipt(state)).toBeNull()
  })

  test('dead launcherが残したprepared intentだけを次世代が回収できる', async () => {
    if (process.platform !== 'darwin') return
    const state = stateDirectory('zerokun-runner-receipt-abandoned-')
    const script = join(state, 'prepare.ts')
    writeFileSync(script, [
      `import { readProcessIdentity } from ${JSON.stringify(join(import.meta.dir, 'process-generation.ts'))}`,
      `import { prepareRunnerLaunchReceipt } from ${JSON.stringify(join(import.meta.dir, 'runner-launch-receipt.ts'))}`,
      `const identity = readProcessIdentity(process.pid)`,
      `if (!identity) throw new Error('identity unavailable')`,
      `prepareRunnerLaunchReceipt(${JSON.stringify(state)}, identity)`,
    ].join('\n'))
    const creator = Bun.spawn([
      process.execPath, '--config=/dev/null', '--no-env-file', script,
    ], { stdout: 'pipe', stderr: 'pipe' })
    expect(await creator.exited).toBe(0)
    const prepared = readRunnerLaunchReceipt(state)
    if (!prepared || prepared.state !== 'prepared') {
      throw new Error(`prepared receipt missing: ${readFileSync(script, 'utf8')}`)
    }
    expect(observeProcessGeneration(prepared.launcher).status).toBe('dead')
    expect(clearAbandonedRunnerLaunchIntent(state, prepared)).toBe(true)
    expect(readRunnerLaunchReceipt(state)).toBeNull()
    expect(existsSync(runnerLaunchReceiptPath(state))).toBe(false)
  })
})
