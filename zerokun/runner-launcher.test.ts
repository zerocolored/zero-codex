import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  observeProcessGeneration,
  readProcessIdentity,
  signalProcessIfLive,
  type ProcessIdentity,
} from './process-generation.ts'
import { readPinnedHerdrRuntime } from './herdr-runtime.ts'
import { releaseProcessLock, tryAcquireProcessLock } from './process-lock.ts'
import { readRunnerLaunchReceipt } from './runner-launch-receipt.ts'

const processes: ProcessIdentity[] = []
const directories: string[] = []

afterEach(async () => {
  for (const processIdentity of processes.splice(0)) {
    signalProcessIfLive(processIdentity, 'SIGTERM')
    await Bun.sleep(50)
    signalProcessIfLive(processIdentity, 'SIGKILL')
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function parentPid(pid: number): number {
  const result = Bun.spawnSync(['/bin/ps', '-o', 'ppid=', '-p', String(pid)], {
    stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return Number(result.stdout.toString().trim())
}

describe('Herdr-owned runner launcher', () => {
  test('startup時にprocess groupが未確立でもexact processをreapしてから再試行する', () => {
    const source = readFileSync(join(import.meta.dir, 'runner-launcher.ts'), 'utf8')
    const helperStart = source.indexOf('async function reapFailedStartup(')
    const helperEnd = source.indexOf('\n}\n\ntry {', helperStart)
    const helper = source.slice(helperStart, helperEnd)

    expect(helperStart).toBeGreaterThan(-1)
    expect(helper).toContain("signalProcessGroupIfLeaderLive(identity, 'SIGKILL')")
    expect(helper).toContain("signalProcessIfLive(identity, 'SIGKILL')")
    expect(helper).toContain('child.exited.then(() => true)')
    const catchStart = source.indexOf('} catch (error) {', helperEnd)
    const retryLog = source.indexOf('job runner startup failed; automatic recovery', catchStart)
    expect(source.indexOf('await reapFailedStartup(daemon, daemonIdentity)', catchStart))
      .toBeLessThan(retryLog)
  })

  test('runnerをlauncherの子として保持しsignalを転送する', async () => {
    if (process.platform !== 'darwin') return
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-runner-launcher-'))
    directories.push(dir)
    chmodSync(dir, 0o700)
    const state = join(dir, 'state')
    mkdirSync(state, { mode: 0o700 })
    const pidFile = join(dir, 'runner.pid')
    const pinObservation = join(dir, 'pin-observation')
    const herdrSocket = join(dir, 'herdr.sock')
    const herdrServer = Bun.listen({
      unix: herdrSocket,
      socket: { data() {} },
    })
    chmodSync(herdrSocket, 0o600)
    const herdr = join(dir, 'herdr')
    writeFileSync(herdr, [
      '#!/bin/sh',
      `printf '%s\\n' ${JSON.stringify(JSON.stringify({
        id: 'test:pane:current',
        result: { pane: {
          pane_id: 'wT:p1',
          tab_id: 'wT:t1',
          terminal_id: 'term_abcdef012345',
          workspace_id: 'wT',
        }, type: 'pane_current' },
      }))}`,
      '',
    ].join('\n'), { mode: 0o700 })
    const runner = join(dir, 'fake-runner.ts')
    writeFileSync(runner, [
      "import { existsSync, writeFileSync } from 'fs'",
      `import { decodeHerdrRuntimeIdentity, writePinnedHerdrRuntime } from ${JSON.stringify(join(import.meta.dir, 'herdr-runtime.ts'))}`,
      "const encoded = process.env.ZEROKUN_LAUNCH_HERDR_RUNTIME",
      "if (!encoded) throw new Error('launch runtime was not passed')",
      `writeFileSync(${JSON.stringify(pinObservation)}, existsSync(${JSON.stringify(join(state, 'herdr-runtime.json'))}) ? 'present' : 'absent')`,
      `writePinnedHerdrRuntime(${JSON.stringify(state)}, decodeHerdrRuntimeIdentity(encoded))`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      "process.on('SIGINT', () => {})",
      "process.on('SIGTERM', () => process.exit(0))",
      'await Bun.sleep(60_000)',
      '',
    ].join('\n'), { mode: 0o700 })
    const launched = Bun.spawn([
      process.execPath, '--config=/dev/null', '--no-env-file',
      join(import.meta.dir, 'runner-launcher.ts'), runner, state, join(state, 'runner.log'),
      join(state, 'job-runner-starter.lock'),
    ], {
      stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        HERDR_ENV: '1',
        HERDR_BIN_PATH: herdr,
        HERDR_SOCKET_PATH: herdrSocket,
        HERDR_PANE_ID: 'wT:p1',
        HERDR_TAB_ID: 'wT:t1',
        HERDR_TERMINAL_ID: 'term_abcdef012345',
        HERDR_WORKSPACE_ID: 'wT',
      },
    })
    const launcherIdentity = readProcessIdentity(launched.pid)
    expect(launcherIdentity).toBeDefined()
    processes.push(launcherIdentity!)
    // A saturated macOS CI runner can take several seconds to schedule the
    // nested Bun process after the preceding process-heavy suite.  Keep this
    // startup wait bounded, but do not turn ordinary scheduler delay into a
    // flaky two-second failure.
    for (let attempt = 0; attempt < 500 && !existsSync(pidFile); attempt += 1) await Bun.sleep(20)
    if (!existsSync(pidFile)) {
      // `Response.text()` waits for EOF.  Stop the owned launcher before
      // draining stderr so a failed startup produces a diagnostic instead of
      // hanging the whole workflow until its 30-minute timeout.
      signalProcessIfLive(launcherIdentity!, 'SIGTERM')
      const exited = await Promise.race([
        launched.exited.then(() => true),
        Bun.sleep(1_000).then(() => false),
      ])
      if (!exited) signalProcessIfLive(launcherIdentity!, 'SIGKILL')
      await launched.exited
      const stderr = await new Response(launched.stderr).text()
      const runnerLog = existsSync(join(state, 'runner.log'))
        ? readFileSync(join(state, 'runner.log'), 'utf8')
        : '(missing)'
      throw new Error(`runner did not publish its PID\nlauncher stderr: ${stderr}\nrunner log: ${runnerLog}`)
    }
    expect(readFileSync(pinObservation, 'utf8')).toBe('absent')
    const pinned = readPinnedHerdrRuntime(state)
    expect(pinned.paneId).toBe('wT:p1')
    expect(pinned.terminalId).toBe('term_abcdef012345')
    const runnerPid = Number(readFileSync(pidFile, 'utf8'))
    expect(parentPid(runnerPid)).toBe(launched.pid)
    expect(signalProcessIfLive(launcherIdentity!, 'SIGTERM')).toBe(true)
    expect(await Promise.race([
      launched.exited.then(() => true),
      Bun.sleep(2_000).then(() => false),
    ])).toBe(true)
    expect(() => process.kill(runnerPid, 0)).toThrow()
    herdrServer.stop(true)
  })

  test('runnerの予期しない終了後に同一launcherが再起動し、意図的停止で終了する', async () => {
    if (process.platform !== 'darwin') return
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-runner-recovery-'))
    directories.push(dir)
    chmodSync(dir, 0o700)
    const state = join(dir, 'state')
    mkdirSync(state, { mode: 0o700 })
    const attemptFile = join(dir, 'attempt')
    const secondPidFile = join(dir, 'second.pid')
    const herdrSocket = join(dir, 'herdr.sock')
    const herdrServer = Bun.listen({
      unix: herdrSocket,
      socket: { data() {} },
    })
    chmodSync(herdrSocket, 0o600)
    const herdr = join(dir, 'herdr')
    writeFileSync(herdr, [
      '#!/bin/sh',
      `printf '%s\\n' ${JSON.stringify(JSON.stringify({
        id: 'test:pane:current',
        result: { pane: {
          pane_id: 'wR:p1',
          tab_id: 'wR:t1',
          terminal_id: 'term_abcdef654321',
          workspace_id: 'wR',
        }, type: 'pane_current' },
      }))}`,
      '',
    ].join('\n'), { mode: 0o700 })
    const runner = join(dir, 'recovering-runner.ts')
    writeFileSync(runner, [
      "import { existsSync, readFileSync, writeFileSync } from 'fs'",
      `const attemptFile = ${JSON.stringify(attemptFile)}`,
      "const previous = existsSync(attemptFile) ? Number(readFileSync(attemptFile, 'utf8')) : 0",
      'const attempt = previous + 1',
      "writeFileSync(attemptFile, String(attempt))",
      'if (attempt === 1) { await Bun.sleep(100); process.exit(23) }',
      `writeFileSync(${JSON.stringify(secondPidFile)}, String(process.pid))`,
      "process.on('SIGTERM', () => process.exit(0))",
      "process.on('SIGINT', () => process.exit(0))",
      'await Bun.sleep(60_000)',
      '',
    ].join('\n'), { mode: 0o700 })
    const launched = Bun.spawn([
      process.execPath, '--config=/dev/null', '--no-env-file',
      join(import.meta.dir, 'runner-launcher.ts'), runner, state, join(state, 'runner.log'),
      join(state, 'job-runner-starter.lock'),
    ], {
      stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        HERDR_ENV: '1',
        HERDR_BIN_PATH: herdr,
        HERDR_SOCKET_PATH: herdrSocket,
        HERDR_PANE_ID: 'wR:p1',
        HERDR_TAB_ID: 'wR:t1',
        HERDR_TERMINAL_ID: 'term_abcdef654321',
        HERDR_WORKSPACE_ID: 'wR',
      },
    })
    const launcherIdentity = readProcessIdentity(launched.pid)
    expect(launcherIdentity).toBeDefined()
    processes.push(launcherIdentity!)
    try {
      for (let attempt = 0; attempt < 500 && !existsSync(secondPidFile); attempt += 1) {
        await Bun.sleep(20)
      }
      if (!existsSync(secondPidFile)) {
        throw new Error(`runner was not restarted\n${readFileSync(join(state, 'runner.log'), 'utf8')}`)
      }
      expect(readFileSync(attemptFile, 'utf8')).toBe('2')
      const secondPid = Number(readFileSync(secondPidFile, 'utf8'))
      const secondIdentity = readProcessIdentity(secondPid)
      expect(secondIdentity).toBeDefined()
      processes.push(secondIdentity!)
      expect(parentPid(secondPid)).toBe(launched.pid)
      expect(readFileSync(join(state, 'runner.log'), 'utf8')).toContain(
        'job runner exited unexpectedly (code 23); automatic recovery will retry',
      )

      expect(signalProcessIfLive(launcherIdentity!, 'SIGTERM')).toBe(true)
      expect(await Promise.race([
        launched.exited.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ])).toBe(true)
      expect(() => process.kill(secondPid, 0)).toThrow()
      await Bun.sleep(400)
      expect(readFileSync(attemptFile, 'utf8')).toBe('2')
    } finally {
      herdrServer.stop(true)
    }
  })

  test('既存runnerのlease中はstandbyし、lease消失後だけ1回起動する', async () => {
    if (process.platform !== 'darwin') return
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-runner-adoption-'))
    directories.push(dir)
    chmodSync(dir, 0o700)
    const state = join(dir, 'state')
    mkdirSync(state, { mode: 0o700 })
    mkdirSync(join(state, 'job-runner.lock'), { mode: 0o700 })
    const runnerLock = join(state, 'job-runner.lock', 'pid')
    const acquired = tryAcquireProcessLock(runnerLock, process.pid)
    expect(acquired.acquired).toBe(true)
    if (!acquired.acquired) throw new Error('test runner lease was not acquired')

    const attemptFile = join(dir, 'attempt')
    const childPidFile = join(dir, 'child.pid')
    const herdrSocket = join(dir, 'herdr.sock')
    const herdrServer = Bun.listen({
      unix: herdrSocket,
      socket: { data() {} },
    })
    chmodSync(herdrSocket, 0o600)
    const herdr = join(dir, 'herdr')
    writeFileSync(herdr, [
      '#!/bin/sh',
      `printf '%s\\n' ${JSON.stringify(JSON.stringify({
        id: 'test:pane:current',
        result: { pane: {
          pane_id: 'wA:p1',
          tab_id: 'wA:t1',
          terminal_id: 'term_abcdef987654',
          workspace_id: 'wA',
        }, type: 'pane_current' },
      }))}`,
      '',
    ].join('\n'), { mode: 0o700 })
    const runner = join(dir, 'adopted-runner.ts')
    writeFileSync(runner, [
      "import { existsSync, readFileSync, writeFileSync } from 'fs'",
      `const attemptFile = ${JSON.stringify(attemptFile)}`,
      "const previous = existsSync(attemptFile) ? Number(readFileSync(attemptFile, 'utf8')) : 0",
      "writeFileSync(attemptFile, String(previous + 1))",
      `writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid))`,
      "process.on('SIGTERM', () => process.exit(0))",
      "process.on('SIGINT', () => process.exit(0))",
      'await Bun.sleep(60_000)',
      '',
    ].join('\n'), { mode: 0o700 })

    const launched = Bun.spawn([
      process.execPath, '--config=/dev/null', '--no-env-file',
      join(import.meta.dir, 'runner-launcher.ts'), runner, state, join(state, 'runner.log'),
      join(state, 'job-runner-starter.lock'),
    ], {
      stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        HERDR_ENV: '1',
        HERDR_BIN_PATH: herdr,
        HERDR_SOCKET_PATH: herdrSocket,
        HERDR_PANE_ID: 'wA:p1',
        HERDR_TAB_ID: 'wA:t1',
        HERDR_TERMINAL_ID: 'term_abcdef987654',
        HERDR_WORKSPACE_ID: 'wA',
      },
    })
    const launcherIdentity = readProcessIdentity(launched.pid)
    expect(launcherIdentity).toBeDefined()
    processes.push(launcherIdentity!)
    let released = false
    try {
      // The persistent launcher may observe and publish the already-live PID,
      // but it must not start a competing child while that exact lease exists.
      await Bun.sleep(750)
      expect(existsSync(attemptFile)).toBe(false)
      expect(releaseProcessLock(runnerLock, acquired.lease)).toBe(true)
      released = true

      for (let attempt = 0; attempt < 250 && !existsSync(childPidFile); attempt += 1) {
        await Bun.sleep(20)
      }
      if (!existsSync(childPidFile)) {
        throw new Error(`replacement runner was not started\n${readFileSync(join(state, 'runner.log'), 'utf8')}`)
      }
      expect(readFileSync(attemptFile, 'utf8')).toBe('1')
      const childPid = Number(readFileSync(childPidFile, 'utf8'))
      expect(parentPid(childPid)).toBe(launched.pid)

      expect(signalProcessIfLive(launcherIdentity!, 'SIGTERM')).toBe(true)
      expect(await Promise.race([
        launched.exited.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ])).toBe(true)
      expect(() => process.kill(childPid, 0)).toThrow()
      await Bun.sleep(400)
      expect(readFileSync(attemptFile, 'utf8')).toBe('1')
    } finally {
      if (!released) releaseProcessLock(runnerLock, acquired.lease)
      herdrServer.stop(true)
    }
  })

  test('launcherが先にSIGKILLされても次世代がpre-lock runnerを安全に回収する', async () => {
    if (process.platform !== 'darwin') return
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-runner-reparent-receipt-'))
    directories.push(dir)
    chmodSync(dir, 0o700)
    const state = join(dir, 'state')
    mkdirSync(state, { mode: 0o700 })
    const runnerPidFile = join(dir, 'runner.pid')
    const attemptFile = join(dir, 'attempt')
    const herdrSocket = join(dir, 'herdr.sock')
    const herdrServer = Bun.listen({ unix: herdrSocket, socket: { data() {} } })
    chmodSync(herdrSocket, 0o600)
    const herdr = join(dir, 'herdr')
    writeFileSync(herdr, [
      '#!/bin/sh',
      `printf '%s\\n' ${JSON.stringify(JSON.stringify({
        id: 'test:pane:current',
        result: { pane: {
          pane_id: 'wP:p1',
          tab_id: 'wP:t1',
          terminal_id: 'term_abcdef111222',
          workspace_id: 'wP',
        }, type: 'pane_current' },
      }))}`,
      '',
    ].join('\n'), { mode: 0o700 })
    const runner = join(dir, 'pre-lock-runner.ts')
    writeFileSync(runner, [
      "import { existsSync, readFileSync, writeFileSync } from 'fs'",
      `const attemptFile = ${JSON.stringify(attemptFile)}`,
      "const previous = existsSync(attemptFile) ? Number(readFileSync(attemptFile, 'utf8')) : 0",
      "writeFileSync(attemptFile, String(previous + 1))",
      `writeFileSync(${JSON.stringify(runnerPidFile)}, String(process.pid))`,
      "process.on('SIGTERM', () => process.exit(0))",
      "process.on('SIGINT', () => process.exit(0))",
      // This fixture must outlive an arbitrary host sleep or scheduler pause;
      // the test owns its exact generation and terminates it explicitly.
      'setInterval(() => {}, 60_000)',
      'await new Promise(() => {})',
      '',
    ].join('\n'), { mode: 0o700 })
    const environment = {
      ...process.env,
      HERDR_ENV: '1',
      HERDR_BIN_PATH: herdr,
      HERDR_SOCKET_PATH: herdrSocket,
      HERDR_PANE_ID: 'wP:p1',
      HERDR_TAB_ID: 'wP:t1',
      HERDR_TERMINAL_ID: 'term_abcdef111222',
      HERDR_WORKSPACE_ID: 'wP',
    }
    const command = [
      process.execPath, '--config=/dev/null', '--no-env-file',
      join(import.meta.dir, 'runner-launcher.ts'), runner, state, join(state, 'runner.log'),
      join(state, 'job-runner-starter.lock'),
    ]
    const first = Bun.spawn(command, {
      stdout: 'pipe', stderr: 'pipe', env: environment,
    })
    const firstIdentity = readProcessIdentity(first.pid)
    expect(firstIdentity).toBeDefined()
    processes.push(firstIdentity!)
    try {
      for (let attempt = 0; attempt < 500 && !existsSync(runnerPidFile); attempt += 1) {
        await Bun.sleep(10)
      }
      expect(existsSync(runnerPidFile)).toBe(true)
      const runnerPid = Number(readFileSync(runnerPidFile, 'utf8'))
      const runnerIdentity = readProcessIdentity(runnerPid)
      expect(runnerIdentity).toBeDefined()
      processes.push(runnerIdentity!)
      expect(readRunnerLaunchReceipt(state)?.state).toBe('published')

      expect(signalProcessIfLive(firstIdentity!, 'SIGKILL')).toBe(true)
      await first.exited

      const second = Bun.spawn(command, {
        stdout: 'pipe', stderr: 'pipe', env: environment,
      })
      const secondIdentity = readProcessIdentity(second.pid)
      expect(secondIdentity).toBeDefined()
      processes.push(secondIdentity!)
      let managedPid = runnerPid
      let managedIdentity = runnerIdentity!
      let adoptedOriginal = false
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const log = existsSync(join(state, 'runner.log'))
          ? readFileSync(join(state, 'runner.log'), 'utf8')
          : ''
        const latestPid = existsSync(runnerPidFile)
          ? Number(readFileSync(runnerPidFile, 'utf8'))
          : runnerPid
        const attempts = Number(readFileSync(attemptFile, 'utf8'))
        if (attempts === 1
          && log.includes(`adopted pre-lock job runner ${runnerPid}`)) {
          adoptedOriginal = true
          break
        }
        if (attempts === 2 && latestPid !== runnerPid) {
          const replacementIdentity = readProcessIdentity(latestPid)
          if (replacementIdentity) {
            managedPid = latestPid
            managedIdentity = replacementIdentity
            processes.push(replacementIdentity)
            break
          }
        }
        await Bun.sleep(10)
      }
      if (adoptedOriginal) {
        expect(observeProcessGeneration(runnerIdentity!).status).toBe('alive')
        expect(readFileSync(attemptFile, 'utf8')).toBe('1')
      } else {
        // macOS may terminate a detached child together with a force-killed
        // parent under host pressure.  A dead published generation is still a
        // safe receipt outcome: the next launcher must replace it exactly once.
        expect(observeProcessGeneration(runnerIdentity!).status).toBe('dead')
        expect(managedPid).not.toBe(runnerPid)
        expect(readFileSync(attemptFile, 'utf8')).toBe('2')
      }
      const receipt = readRunnerLaunchReceipt(state)
      expect(receipt?.state).toBe('published')
      if (receipt?.state === 'published') expect(receipt.runner.pid).toBe(managedPid)

      expect(signalProcessIfLive(secondIdentity!, 'SIGTERM')).toBe(true)
      expect(await Promise.race([
        second.exited.then(() => true),
        Bun.sleep(4_000).then(() => false),
      ])).toBe(true)
      expect(observeProcessGeneration(managedIdentity).status).toBe('dead')
      expect(observeProcessGeneration(runnerIdentity!).status).toBe('dead')
      expect(readRunnerLaunchReceipt(state)).toBeNull()
      expect(['1', '2']).toContain(readFileSync(attemptFile, 'utf8'))
    } finally {
      herdrServer.stop(true)
    }
  })
})
