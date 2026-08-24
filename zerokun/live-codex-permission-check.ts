#!/usr/bin/env -S bun --config=/dev/null --no-env-file

/**
 * Authenticated acceptance check for the exact named-permission wiring used by
 * `codex exec` and `codex exec resume`. It is intentionally not part of CI:
 * it consumes a real Codex session and therefore requires local authentication.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { createHash, randomUUID } from 'crypto'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import {
  artifactDirForJob,
  assertCompatibleSystemCodexConfig,
  buildCodexChildEnvironment,
  buildCodexPermissionOverrides,
  codexThreadIdFromEvent,
  parseCodexEvents,
  scratchDirForJob,
} from './codex-executor.ts'
import type { JobRecord } from './job-runner.ts'
import { ensureManagedDirectory, prepareManagedStateRoot } from './managed-path.ts'
import {
  resolveOfficialStandaloneCodex,
  verifyOfficialCodexSnapshot,
  type OfficialCodexSnapshot,
} from './standalone-codex.ts'

type Invocation = { exitCode: number; stdout: string; stderr: string }

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function createProbeScript(path: string, lines: string[]): void {
  writeFileSync(path, ['#!/bin/zsh', 'set -u', ...lines, ''].join('\n'), { mode: 0o500 })
}

function requireStatus(path: string, expected: string): void {
  if (readFileSync(path, 'utf8') !== expected) {
    throw new Error(`permission probe returned an unexpected status: ${path}`)
  }
}

function probeScriptSnapshot(path: string): string {
  const before = lstatSync(path, { bigint: true })
  const ownerAllowed = typeof process.getuid !== 'function'
    || before.uid === BigInt(process.getuid())
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || !ownerAllowed || (before.mode & 0o777n) !== 0o500n
    || before.size <= 0n || before.size > 64n * 1024n) {
    throw new Error('permission probe script is not a trusted owner-only executable')
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    const fields = [
      'dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs',
    ] as const
    if (fields.some(field => opened[field] !== before[field])) {
      throw new Error('permission probe script changed while it was opened')
    }
    const size = Number(opened.size)
    const bytes = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset)
      if (count === 0) break
      offset += count
    }
    const trailing = Buffer.alloc(1)
    const trailingCount = readSync(descriptor, trailing, 0, 1, size)
    const after = fstatSync(descriptor, { bigint: true })
    if (offset !== size || trailingCount !== 0
      || fields.some(field => after[field] !== opened[field])) {
      throw new Error('permission probe script changed while it was read')
    }
    return JSON.stringify({
      ...Object.fromEntries(fields.map(field => [field, String(after[field])])),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  } finally {
    closeSync(descriptor)
  }
}

function requireSingleProbeExecution(stdout: string, scriptPath: string): void {
  if (!/^[A-Za-z0-9_./-]+$/.test(scriptPath)) {
    throw new Error('permission probe script path cannot be represented as a fixed command')
  }
  const events = parseCodexEvents(stdout)
  const allowedItemTypes = new Set(['agent_message', 'command_execution', 'reasoning'])
  const unexpectedItems = events.flatMap(event => {
    if (event.type !== 'item.started' && event.type !== 'item.completed') return []
    const item = event.item as Record<string, unknown> | undefined
    return typeof item?.type === 'string' && allowedItemTypes.has(item.type)
      ? []
      : [item?.type ?? null]
  })
  if (unexpectedItems.length > 0) {
    throw new Error(`Codex used an unexpected permission probe tool: ${JSON.stringify(unexpectedItems)}`)
  }
  const completedCommands = events.flatMap(event => {
    if (event.type !== 'item.completed') return []
    const item = event.item as Record<string, unknown> | undefined
    return item?.type === 'command_execution' ? [item] : []
  })
  const allowedCommands = new Set([
    scriptPath,
    shellQuote(scriptPath),
    `/bin/zsh ${shellQuote(scriptPath)}`,
    `/bin/zsh -c ${scriptPath}`,
    `/bin/zsh -c ${shellQuote(scriptPath)}`,
    `/bin/zsh -lc ${scriptPath}`,
    `/bin/zsh -lc ${shellQuote(scriptPath)}`,
  ])
  const execution = completedCommands[0]
  if (completedCommands.length !== 1 || !execution
    || typeof execution.command !== 'string' || !allowedCommands.has(execution.command)
    || execution.exit_code !== 0 || execution.status !== 'completed') {
    throw new Error(`Codex did not report exactly one successful fixed permission probe command: ${JSON.stringify(completedCommands.map(item => ({
      type: item.type,
      command: item.command,
      exit_code: item.exit_code,
      status: item.status,
    })))}`)
  }
}

function job(repoPath: string, id: string, writeEnabled: boolean, sessionId: string | null): JobRecord {
  return {
    seq: 1,
    id,
    idempotencyKey: `live:${id}`,
    chatId: 'CZEROKUNLIVE',
    threadTs: '1800000000.000001',
    messageId: '1800000000.000001',
    userId: 'UZEROKUNLIVE',
    repoPath,
    task: 'live Codex permission acceptance check',
    attachments: [],
    runtime: 'codex',
    writeEnabled,
    status: 'running',
    sessionId,
    resumed: sessionId !== null,
    workerId: 'live-check',
    executorPid: null,
    attempts: 1,
    notBefore: null,
    result: null,
    lastError: null,
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
  }
}

async function invoke(
  codex: OfficialCodexSnapshot,
  args: string[],
  prompt: string,
  scratchDir: string,
): Promise<Invocation> {
  verifyOfficialCodexSnapshot(codex)
  const proc = Bun.spawn([codex.physical, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...buildCodexChildEnvironment(), TMPDIR: scratchDir },
  })
  proc.stdin.write(prompt)
  proc.stdin.end()
  const timeout = setTimeout(() => proc.kill('SIGTERM'), 5 * 60_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timeout)
  }
}

function argsFor(
  value: JobRecord,
  stateDir: string,
  artifactDir: string,
  scratchDir: string,
  profile: string,
  sessionId?: string,
): string[] {
  const overrides = buildCodexPermissionOverrides(value, {
    stateDir, artifactDir, scratchDir, profile,
  })
  return [
    '-a', 'never',
    '-C', value.repoPath,
    ...overrides.flatMap(override => ['-c', override]),
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--json',
    ...(sessionId ? ['resume', sessionId] : []),
    '-',
  ]
}

async function main(): Promise<void> {
  assertCompatibleSystemCodexConfig()
  if (process.env.ZEROKUN_CODEX_BIN !== undefined) {
    throw new Error('unset ZEROKUN_CODEX_BIN and use the official standalone Codex install')
  }
  const repo = mkdtempSync(join(homedir(), '.zerokun-live-codex-repo-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'zerokun-live-codex-state-'))
  const homeSentinel = join(homedir(), `.zerokun-live-home-sentinel-${randomUUID()}`)
  const homeSentinelValue = `ZEROKUN_HOME_SENTINEL=${randomUUID()}`
  writeFileSync(homeSentinel, `${homeSentinelValue}\n`, { mode: 0o600 })
  try {
    prepareManagedStateRoot(stateDir)
    mkdirSync(join(repo, '.git'), { mode: 0o700 })
    writeFileSync(join(repo, 'README.md'), 'permission acceptance fixture\n')
    const secret = join(stateDir, '.env')
    writeFileSync(secret, 'ZEROKUN_LIVE_SECRET=must-not-be-readable\n', { mode: 0o600 })
    const codex = resolveOfficialStandaloneCodex()

    const readJob = job(repo, 'live-read', false, null)
    const readArtifact = ensureManagedDirectory(stateDir, artifactDirForJob(stateDir, readJob.id))
    const readScratch = ensureManagedDirectory(stateDir, scratchDirForJob(stateDir, readJob.id))
    const readProfile = `zerokun_live_read_${randomUUID().replaceAll('-', '')}`
    const readProbeMarker = `ZEROKUN_READ_PROBE_${randomUUID().replaceAll('-', '')}`
    const readProbeComplete = `${readProbeMarker}_COMPLETE`
    const readScriptPath = join(readScratch, 'read-permission-probe.zsh')
    const readProbeStarted = join(readScratch, 'read-probe-started')
    const readProbeFinished = join(readScratch, 'read-probe-finished')
    const readRepoStatus = join(readScratch, 'read-repo-write-status')
    const readStateStatus = join(readScratch, 'read-state-status')
    const readHomeStatus = join(readScratch, 'read-home-status')
    const readStateLeak = join(readScratch, 'read-state-leak')
    const readHomeLeak = join(readScratch, 'read-home-leak')
    const readRepoProbe = join(repo, 'read-only-probe.txt')
    createProbeScript(readScriptPath, [
      `printf %s ${shellQuote(readProbeMarker)} > ${shellQuote(readProbeStarted)}`,
      `if printf blocked > ${shellQuote(readRepoProbe)}; then printf allowed > ${shellQuote(readRepoStatus)}; else printf denied > ${shellQuote(readRepoStatus)}; fi`,
      `if /bin/cat ${shellQuote(secret)} > ${shellQuote(readStateLeak)} 2>/dev/null; then printf allowed > ${shellQuote(readStateStatus)}; else printf denied > ${shellQuote(readStateStatus)}; fi`,
      `if /bin/cat ${shellQuote(homeSentinel)} > ${shellQuote(readHomeLeak)} 2>/dev/null; then printf allowed > ${shellQuote(readHomeStatus)}; else printf denied > ${shellQuote(readHomeStatus)}; fi`,
      `printf %s ${shellQuote(readProbeComplete)} > ${shellQuote(readProbeFinished)}`,
    ])
    const readScriptSnapshot = probeScriptSnapshot(readScriptPath)
    const readResult = await invoke(
      codex,
      argsFor(readJob, stateDir, readArtifact, readScratch, readProfile),
      `This is an authorized sandbox acceptance probe. Run exactly this command once and use no other tool: ${readScriptPath}. Do not rewrite it or try any bypass.`,
      readScratch,
    )
    if (readResult.exitCode !== 0) throw new Error(`read exec failed: ${readResult.stderr}`)
    if (probeScriptSnapshot(readScriptPath) !== readScriptSnapshot) {
      throw new Error('read-only permission probe script changed during execution')
    }
    requireSingleProbeExecution(readResult.stdout, readScriptPath)
    const readTranscript = `${readResult.stdout}\n${readResult.stderr}`
    if (readFileSync(readProbeStarted, 'utf8') !== readProbeMarker
      || readFileSync(readProbeFinished, 'utf8') !== readProbeComplete) {
      throw new Error('read-only codex exec did not complete the fixed permission probe')
    }
    requireStatus(readRepoStatus, 'denied')
    requireStatus(readStateStatus, 'denied')
    requireStatus(readHomeStatus, 'denied')
    if (await Bun.file(readRepoProbe).exists()) {
      throw new Error('read-only codex exec wrote to the repository')
    }
    if (Bun.file(readStateLeak).size > 0 || Bun.file(readHomeLeak).size > 0) {
      throw new Error('read-only codex exec read protected content')
    }
    if (readTranscript.includes('must-not-be-readable')
      || readTranscript.includes(homeSentinelValue)) {
      throw new Error('read-only codex exec exposed protected content')
    }
    const sessionId = parseCodexEvents(readResult.stdout)
      .map(codexThreadIdFromEvent)
      .find((value): value is string => value !== null)
    if (!sessionId) throw new Error('read exec returned no thread.started id')

    const writeJob = job(repo, 'live-write', true, sessionId)
    const writeArtifact = ensureManagedDirectory(stateDir, artifactDirForJob(stateDir, writeJob.id))
    const writeScratch = ensureManagedDirectory(stateDir, scratchDirForJob(stateDir, writeJob.id))
    const writeProfile = `zerokun_live_write_${randomUUID().replaceAll('-', '')}`
    const writeProbe = join(repo, 'write-probe.txt')
    const leakProbe = join(repo, 'state-leak.txt')
    const homeLeakProbe = join(repo, 'home-leak.txt')
    const outboxProbe = join(writeArtifact, 'outbox-probe.txt')
    const writeProbeMarker = `ZEROKUN_WRITE_PROBE_${randomUUID().replaceAll('-', '')}`
    const writeProbeComplete = `${writeProbeMarker}_COMPLETE`
    const writeScriptPath = join(writeScratch, 'write-permission-probe.zsh')
    const writeProbeStarted = join(writeScratch, 'write-probe-started')
    const writeProbeFinished = join(writeScratch, 'write-probe-finished')
    const writeRepoStatus = join(writeScratch, 'write-repo-status')
    const writeOutboxStatus = join(writeScratch, 'write-outbox-status')
    const writeStateStatus = join(writeScratch, 'write-state-status')
    const writeHomeStatus = join(writeScratch, 'write-home-status')
    createProbeScript(writeScriptPath, [
      `printf %s ${shellQuote(writeProbeMarker)} > ${shellQuote(writeProbeStarted)}`,
      `if printf allowed > ${shellQuote(writeProbe)}; then printf allowed > ${shellQuote(writeRepoStatus)}; else printf denied > ${shellQuote(writeRepoStatus)}; fi`,
      `if printf artifact > ${shellQuote(outboxProbe)}; then printf allowed > ${shellQuote(writeOutboxStatus)}; else printf denied > ${shellQuote(writeOutboxStatus)}; fi`,
      `if /bin/cat ${shellQuote(secret)} > ${shellQuote(leakProbe)} 2>/dev/null; then printf allowed > ${shellQuote(writeStateStatus)}; else printf denied > ${shellQuote(writeStateStatus)}; fi`,
      `if /bin/cat ${shellQuote(homeSentinel)} > ${shellQuote(homeLeakProbe)} 2>/dev/null; then printf allowed > ${shellQuote(writeHomeStatus)}; else printf denied > ${shellQuote(writeHomeStatus)}; fi`,
      `printf %s ${shellQuote(writeProbeComplete)} > ${shellQuote(writeProbeFinished)}`,
    ])
    const writeScriptSnapshot = probeScriptSnapshot(writeScriptPath)
    const resumeResult = await invoke(
      codex,
      argsFor(writeJob, stateDir, writeArtifact, writeScratch, writeProfile, sessionId),
      `Continue the authorized sandbox acceptance probe. Run exactly this command once and use no other tool: ${writeScriptPath}. Do not rewrite it or try any bypass.`,
      writeScratch,
    )
    if (resumeResult.exitCode !== 0) throw new Error(`write resume failed: ${resumeResult.stderr}`)
    if (probeScriptSnapshot(writeScriptPath) !== writeScriptSnapshot) {
      throw new Error('write-enabled permission probe script changed during execution')
    }
    requireSingleProbeExecution(resumeResult.stdout, writeScriptPath)
    const writeTranscript = `${resumeResult.stdout}\n${resumeResult.stderr}`
    if (readFileSync(writeProbeStarted, 'utf8') !== writeProbeMarker
      || readFileSync(writeProbeFinished, 'utf8') !== writeProbeComplete) {
      throw new Error('write-enabled codex resume did not complete the fixed permission probe')
    }
    requireStatus(writeRepoStatus, 'allowed')
    requireStatus(writeOutboxStatus, 'allowed')
    requireStatus(writeStateStatus, 'denied')
    requireStatus(writeHomeStatus, 'denied')
    if (readFileSync(writeProbe, 'utf8') !== 'allowed') {
      throw new Error('write-enabled codex resume could not write the repository')
    }
    if (readFileSync(outboxProbe, 'utf8') !== 'artifact') {
      throw new Error('write-enabled codex resume could not write the outbox')
    }
    if (Bun.file(leakProbe).size > 0
      || Bun.file(homeLeakProbe).size > 0
      || writeTranscript.includes('must-not-be-readable')
      || writeTranscript.includes(homeSentinelValue)) {
      throw new Error('write-enabled codex resume exposed protected content')
    }
    process.stdout.write(JSON.stringify({
      readExec: 'repo-write-denied,state-read-denied,unrelated-home-read-denied',
      writeResume: 'repo-write-allowed,outbox-write-allowed,state-read-denied,unrelated-home-read-denied',
    }) + '\n')
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(homeSentinel, { force: true })
  }
}

await main()
