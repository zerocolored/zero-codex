#!/usr/bin/env bun

/**
 * Codex とその通常の子processを同じprocess group内で監督する小さなwrapper。
 * runnerがSIGKILLされてもこのleaderは残り、Codex終了後にbackground子を回収する。
 */

import { randomUUID } from 'crypto'
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

function groupMemberPids(groupId: number): number[] {
  if (process.platform === 'win32') return []
  const result = Bun.spawnSync(
    ['ps', '-ww', '-axo', 'pid=,pgid='],
    { stdout: 'pipe', stderr: 'ignore', detached: true },
  )
  if (result.exitCode !== 0) return []
  return new TextDecoder().decode(result.stdout)
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .filter(match => Number(match[2]) === groupId && Number(match[1]) !== process.pid)
    .map(match => Number(match[1]))
}

function signalMembers(groupId: number, signal: NodeJS.Signals): void {
  for (const pid of groupMemberPids(groupId)) {
    try { process.kill(pid, signal) } catch {}
  }
}

async function reapGroup(groupId: number): Promise<void> {
  signalMembers(groupId, 'SIGTERM')
  const deadline = Date.now() + 1_000
  while (groupMemberPids(groupId).length > 0 && Date.now() < deadline) {
    await Bun.sleep(25)
  }
  signalMembers(groupId, 'SIGKILL')
}

async function main(): Promise<void> {
  const [jobId, registrationPath, codexBin, ...args] = process.argv.slice(2)
  if (!jobId || !registrationPath || !codexBin) {
    throw new Error('usage: codex-supervisor.ts JOB_ID REGISTRATION_PATH CODEX_BIN [ARG ...]')
  }
  const registrationDirectory = lstatSync(dirname(registrationPath))
  const ownerMatches = typeof process.getuid !== 'function'
    || registrationDirectory.uid === process.getuid()
  if (!registrationDirectory.isDirectory() || registrationDirectory.isSymbolicLink()
    || !ownerMatches) {
    throw new Error(`unsafe executor registration directory: ${dirname(registrationPath)}`)
  }
  const temporary = `${registrationPath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify({ jobId, pid: process.pid }), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, registrationPath)
  try {
    const child = Bun.spawn([codexBin, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    // group宛signalはCodexにも届く。wrapper自身は子の終了と後始末を待つ。
    const ignoreUntilChildExit = () => {}
    process.on('SIGINT', ignoreUntilChildExit)
    process.on('SIGTERM', ignoreUntilChildExit)
    const exitCode = await child.exited
    await reapGroup(process.pid)
    process.off('SIGINT', ignoreUntilChildExit)
    process.off('SIGTERM', ignoreUntilChildExit)
    process.exitCode = exitCode
  } finally {
    try {
      const current = JSON.parse(readFileSync(registrationPath, 'utf8')) as { pid?: number }
      if (current.pid === process.pid) rmSync(registrationPath, { force: true })
    } catch {}
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
