#!/usr/bin/env -S bun --config=/dev/null --no-env-file

/**
 * Authenticated acceptance check for the production `codex app-server --stdio`
 * transport. It intentionally stays outside CI because it consumes the user's
 * existing ChatGPT subscription session.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { createHash, randomUUID } from 'crypto'
import { createServer } from 'net'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import {
  artifactDirForJob,
  assertCompatibleSystemCodexConfig,
  assertCurrentAppServerCodexPermissionConfig,
  buildCodexChildEnvironment,
  buildCodexPermissionOverrides,
  buildCodexTrustArguments,
  resolveEffectiveCodexPermissionOverrides,
  scratchDirForJob,
} from './codex-executor.ts'
import { verifyCodexAppServerCapabilities } from './codex-app-server-capability.ts'
import {
  AppServerProtocolError,
  CodexAppServerSession,
  mergeAppServerPermissionProbeEvidence,
  sameAppServerSessionSource,
  type AppServerPermissionProbeEvidence,
  type AppServerSessionSource,
  type AppServerTurn,
  type AppServerTurnTerminal,
} from './codex-app-server-session.ts'
import type { JobRecord } from './job-runner.ts'
import { ensureManagedDirectory, prepareManagedStateRoot } from './managed-path.ts'
import {
  resolveOfficialStandaloneCodex,
  verifyOfficialCodexSnapshot,
  type OfficialCodexSnapshot,
} from './standalone-codex.ts'

const MAX_ACCEPTANCE_OUTPUT_BYTES = 16 * 1024 * 1024
const TURN_ACCEPTANCE_DEADLINE_MS = 10 * 60_000
const CONTROL_START_DEADLINE_MS = 2 * 60_000

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

export function requireSingleProbeExecution(
  evidence: AppServerPermissionProbeEvidence,
  scriptPath: string,
  repoPath: string,
): void {
  if (!/^[A-Za-z0-9_./-]+$/.test(scriptPath)) {
    throw new Error('permission probe script path cannot be represented as a fixed command')
  }
  if (evidence.unexpectedItemSeen) {
    throw new Error(
      `Codex used an unexpected permission probe tool: ${JSON.stringify(evidence.unexpectedItemType)}`,
    )
  }
  const allowedCommands = new Set([
    scriptPath,
    shellQuote(scriptPath),
    `/bin/zsh ${shellQuote(scriptPath)}`,
    `/bin/zsh -c ${scriptPath}`,
    `/bin/zsh -c ${shellQuote(scriptPath)}`,
    `/bin/zsh -lc ${scriptPath}`,
    `/bin/zsh -lc ${shellQuote(scriptPath)}`,
  ])
  const execution = evidence.firstCommand
  const automatedSources = new Set(['agent', 'unifiedExecStartup'])
  let executionCwd: string | null = null
  if (typeof execution?.cwd === 'string') {
    try { executionCwd = realpathSync(execution.cwd) } catch {}
  }
  const checks = {
    commandCount: evidence.commandCount,
    commandMatched: execution !== null && execution.command !== null
      && allowedCommands.has(execution.command),
    exitCodeMatched: execution?.exitCode === 0,
    statusMatched: execution?.status === 'completed',
    cwdMatched: executionCwd === realpathSync(repoPath),
    sourceMatched: execution?.source !== null && execution?.source !== undefined
      && automatedSources.has(execution.source),
  }
  if (evidence.commandCount !== 1 || !execution
    || !checks.commandMatched
    || execution.exitCode !== 0 || execution.status !== 'completed'
    || executionCwd !== realpathSync(repoPath)
    || execution.source === null || !automatedSources.has(execution.source)) {
    throw new Error(
      `Codex did not report exactly one successful fixed permission probe command: ${JSON.stringify(checks)}`,
    )
  }
}

export async function loadPermissionProbeEvidenceForTerminal(
  session: CodexAppServerSession,
  terminal: AppServerTurnTerminal,
): Promise<AppServerPermissionProbeEvidence> {
  try {
    const official = await session.loadPermissionProbeEvidence(
      terminal.threadId,
      terminal.turn.id,
    )
    return mergeAppServerPermissionProbeEvidence(terminal.permissionEvidence, official)
  } catch (error) {
    if (!(error instanceof AppServerProtocolError)
      || error.method !== 'thread/items/list'
      || error.rpcError?.code !== -32601) throw error
    return terminal.permissionEvidence
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
    task: 'live Codex App Server permission acceptance check',
    inputRevision: 1,
    attachments: [],
    runtime: 'codex',
    writeEnabled,
    status: 'running',
    sessionId,
    resumed: sessionId !== null,
    workerId: 'live-check',
    executorPid: null,
    monitorState: 'required',
    attempts: 1,
    notBefore: null,
    result: null,
    lastError: null,
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
    controlEpoch: 1,
    acceptsControl: true,
    executorNonce: null,
    activeThreadId: null,
    activeTurnId: null,
    cancelRequestedAt: null,
    terminalOutcome: null,
  }
}

type AppServerRun<T> = {
  value: T
  transcript: string
  processId: number
}

async function waitForTurnTerminal(
  session: CodexAppServerSession,
  threadId: string,
  turnId: string,
  deadlineMs = TURN_ACCEPTANCE_DEADLINE_MS,
): Promise<AppServerTurnTerminal> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const terminal = session.takeTurnTerminal(threadId, turnId)
    if (terminal) return terminal
    const appServerError = session.takeError()
    if (appServerError) {
      throw new Error(`App Server emitted an error notification: ${JSON.stringify(appServerError)}`)
    }
    await session.waitForActivity(Math.min(100, Math.max(1, deadline - Date.now())))
  }
  throw new Error(`App Server turn ${turnId} did not reach a terminal state before the acceptance deadline`)
}

async function runAppServer<T>(
  codex: OfficialCodexSnapshot,
  value: JobRecord,
  stateDir: string,
  artifactDir: string,
  scratchDir: string,
  profile: string,
  body: (session: CodexAppServerSession) => Promise<T>,
  permissionOptions: { executionWriteEnabled?: boolean } = {},
): Promise<AppServerRun<T>> {
  verifyOfficialCodexSnapshot(codex)
  const baseOverrides = buildCodexPermissionOverrides(value, {
    stateDir,
    artifactDir,
    scratchDir,
    profile,
    executionWriteEnabled: permissionOptions.executionWriteEnabled,
  })
  const childEnvironment = {
    ...buildCodexChildEnvironment(),
    TMPDIR: scratchDir,
  }
  for (const key of ['OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID']) {
    if (key in childEnvironment) {
      throw new Error(`authenticated acceptance must not forward ${key}`)
    }
  }
  const overrides = await resolveEffectiveCodexPermissionOverrides(
    codex.physical,
    value.repoPath,
    baseOverrides,
    profile,
    childEnvironment,
  )
  verifyOfficialCodexSnapshot(codex)
  const proc = Bun.spawn([
    codex.physical,
    ...buildCodexTrustArguments(),
    '-C', value.repoPath,
    ...overrides.flatMap(override => ['-c', override]),
    'app-server', '--stdio',
  ], {
    cwd: value.repoPath,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: childEnvironment,
  })
  const stdoutChunks: Uint8Array[] = []
  let stdoutBytes = 0
  const session = new CodexAppServerSession(proc.stdin, proc.stdout, {
    onOutputChunk(chunk) {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_ACCEPTANCE_OUTPUT_BYTES) {
        throw new Error('authenticated App Server acceptance output exceeded its bound')
      }
      stdoutChunks.push(chunk.slice())
    },
  })
  const stderrPromise = new Response(proc.stderr).text()
  let result: T | undefined
  let failure: unknown
  try {
    await session.initialize()
    await assertCurrentAppServerCodexPermissionConfig(
      session, value.repoPath, overrides, profile,
    )
    result = await body(session)
  } catch (error) {
    failure = error
  } finally {
    session.closeInput()
  }

  let exitCode = await Promise.race([
    proc.exited,
    Bun.sleep(10_000).then(() => null),
  ])
  if (exitCode === null) {
    proc.kill('SIGTERM')
    exitCode = await Promise.race([
      proc.exited,
      Bun.sleep(5_000).then(() => null),
    ])
  }
  if (exitCode === null) {
    proc.kill('SIGKILL')
    exitCode = await proc.exited
  }
  const stderr = await stderrPromise
  try {
    await session.waitForReader()
  } catch (error) {
    failure ??= error
  }
  if (failure) throw failure
  if (exitCode !== 0) throw new Error(`App Server exited ${exitCode}: ${stderr}`)
  return {
    value: result as T,
    transcript: `${Buffer.concat(stdoutChunks.map(chunk => Buffer.from(chunk))).toString('utf8')}\n${stderr}`,
    processId: proc.pid,
  }
}

function requireFixtureAgentsSource(sources: string[], repo: string): void {
  const expected = realpathSync(join(repo, 'AGENTS.md'))
  if (!sources.some(source => {
    try {
      return realpathSync(source) === expected
    } catch {
      return false
    }
  })) {
    throw new Error(`App Server did not report the fixture AGENTS.md: ${JSON.stringify(sources)}`)
  }
}

async function verifyAmbientMcpDiscoveryIsSideEffectFree(
  codex: OfficialCodexSnapshot,
  repo: string,
  stateDir: string,
): Promise<void> {
  const root = ensureManagedDirectory(stateDir, join(stateDir, 'ambient-mcp-discovery'))
  const codexHome = join(root, 'codex-home')
  mkdirSync(codexHome, { mode: 0o700 })
  const marker = join(root, 'ambient-mcp-started')
  const probe = join(root, 'ambient-mcp-probe.zsh')
  createProbeScript(probe, [
    `printf started > ${shellQuote(marker)}`,
    '/bin/sleep 30',
  ])
  let httpConnections = 0
  const httpProbe = createServer(socket => {
    httpConnections += 1
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    httpProbe.once('error', reject)
    httpProbe.listen(0, '127.0.0.1', () => resolve())
  })
  const address = httpProbe.address()
  if (!address || typeof address === 'string') {
    httpProbe.close()
    throw new Error('could not bind the ambient HTTP MCP acceptance probe')
  }
  writeFileSync(join(codexHome, 'config.toml'), [
    '[mcp_servers.zerokun_ambient_probe]',
    `command = ${JSON.stringify(probe)}`,
    'args = []',
    'enabled = true',
    '',
    '[mcp_servers.zerokun_ambient_http_probe]',
    `url = ${JSON.stringify(`http://127.0.0.1:${address.port}/mcp`)}`,
    'enabled = true',
    '',
  ].join('\n'), { mode: 0o600 })

  const value = job(repo, 'live-mcp-discovery', false, null)
  const artifact = ensureManagedDirectory(stateDir, artifactDirForJob(stateDir, value.id))
  const scratch = ensureManagedDirectory(stateDir, scratchDirForJob(stateDir, value.id))
  const profile = `zerokun_live_mcp_${randomUUID().replaceAll('-', '')}`
  const base = buildCodexPermissionOverrides(value, {
    stateDir, artifactDir: artifact, scratchDir: scratch, profile,
  })
  let isolated: string[]
  try {
    isolated = await resolveEffectiveCodexPermissionOverrides(
      codex.physical,
      repo,
      base,
      profile,
      { ...buildCodexChildEnvironment(), CODEX_HOME: codexHome, TMPDIR: scratch },
    )
    // Give a local connect that was scheduled before App Server shutdown a
    // chance to reach the listener before declaring discovery side-effect free.
    await Bun.sleep(100)
    if (existsSync(marker) || httpConnections !== 0) {
      throw new Error('Codex config/read started or connected to an ambient MCP before isolation')
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpProbe.close(error => error ? reject(error) : resolve())
    })
  }
  const encoded = isolated.find(value => value.startsWith('mcp_servers='))
  if (!encoded) throw new Error('ambient MCP acceptance omitted the isolation table')
  const parsed = Bun.TOML.parse(`value=${encoded.slice('mcp_servers='.length)}`) as {
    value?: Record<string, Record<string, unknown>>
  }
  const disabled = parsed.value?.zerokun_ambient_probe
  if (disabled?.enabled !== false || disabled.command !== '/usr/bin/false') {
    throw new Error('ambient MCP acceptance did not replace the discovered transport')
  }
  const disabledHttp = parsed.value?.zerokun_ambient_http_probe
  if (disabledHttp?.enabled !== false || disabledHttp.url !== 'http://127.0.0.1:9') {
    throw new Error('ambient HTTP MCP acceptance did not replace the discovered transport')
  }
}

async function runCompletedProbe(
  codex: OfficialCodexSnapshot,
  value: JobRecord,
  stateDir: string,
  artifactDir: string,
  scratchDir: string,
  profile: string,
  scriptPath: string,
  permissionOptions: { executionWriteEnabled?: boolean } = {},
): Promise<AppServerRun<{
  threadId: string
  source: AppServerSessionSource
  turn: AppServerTurn
}>> {
  return runAppServer(
    codex, value, stateDir, artifactDir, scratchDir, profile,
    async session => {
      const model = process.env.ZEROKUN_JOB_MODEL?.trim() || undefined
      const threadParams = {
        cwd: value.repoPath,
        approvalPolicy: 'never',
        permissions: profile,
        developerInstructions: 'Run only the exact authorized acceptance command requested by the user.',
        ...(model ? { model } : {}),
      }
      const handshake = value.sessionId
        ? await session.resumeThread({ threadId: value.sessionId, ...threadParams })
        : await session.startThread({ ...threadParams, ephemeral: false })
      requireFixtureAgentsSource(handshake.instructionSources, value.repoPath)
      const turnId = await session.startTurn(
        handshake.threadId,
        `This is an authorized sandbox acceptance probe. Run exactly this command once and use no other tool: ${scriptPath}. Do not rewrite it or try any bypass.`,
        value.idempotencyKey,
        {
          cwd: value.repoPath,
          permissions: profile,
          approvalPolicy: 'never',
          ...(model ? { model } : {}),
        },
      )
      const terminal = await waitForTurnTerminal(session, handshake.threadId, turnId)
      const turn = terminal.turn
      if (turn.status !== 'completed') {
        throw new Error(`permission acceptance turn ended as ${turn.status}`)
      }
      const evidence = await loadPermissionProbeEvidenceForTerminal(session, terminal)
      requireSingleProbeExecution(evidence, scriptPath, value.repoPath)
      return { threadId: handshake.threadId, source: handshake.source, turn }
    },
    permissionOptions,
  )
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
    const gitInit = Bun.spawnSync(['git', 'init', '-q', repo], {
      stdout: 'pipe', stderr: 'pipe', env: buildCodexChildEnvironment(),
    })
    if (gitInit.exitCode !== 0) {
      throw new Error(`could not initialize acceptance repository: ${gitInit.stderr.toString()}`)
    }
    writeFileSync(join(repo, 'README.md'), 'permission acceptance fixture\n')
    writeFileSync(join(repo, 'AGENTS.md'), [
      '# Acceptance fixture',
      '',
      'Run only the exact command named by the current acceptance prompt.',
      'Do not inspect or modify any other path.',
      '',
    ].join('\n'))
    const secret = join(stateDir, '.env')
    writeFileSync(secret, 'ZEROKUN_LIVE_SECRET=must-not-be-readable\n', { mode: 0o600 })
    const codex = resolveOfficialStandaloneCodex()
    await verifyAmbientMcpDiscoveryIsSideEffectFree(codex, repo, stateDir)
    const login = Bun.spawnSync([codex.physical, 'login', 'status'], {
      stdout: 'pipe', stderr: 'pipe', env: buildCodexChildEnvironment(),
    })
    const loginStatus = `${login.stdout.toString()}\n${login.stderr.toString()}`
    if (login.exitCode !== 0 || !/logged in using chatgpt/i.test(loginStatus)) {
      throw new Error(`Codex is not logged in through the ChatGPT subscription: ${loginStatus.trim()}`)
    }
    await verifyCodexAppServerCapabilities(codex.physical, buildCodexChildEnvironment())

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
    const readRun = await runCompletedProbe(
      codex, readJob, stateDir, readArtifact, readScratch, readProfile, readScriptPath,
    )
    if (probeScriptSnapshot(readScriptPath) !== readScriptSnapshot) {
      throw new Error('read-only permission probe script changed during execution')
    }
    if (readFileSync(readProbeStarted, 'utf8') !== readProbeMarker
      || readFileSync(readProbeFinished, 'utf8') !== readProbeComplete) {
      throw new Error('read-only App Server turn did not complete the fixed permission probe')
    }
    requireStatus(readRepoStatus, 'denied')
    requireStatus(readStateStatus, 'denied')
    requireStatus(readHomeStatus, 'denied')
    if (existsSync(readRepoProbe)) {
      throw new Error('read-only App Server turn wrote to the repository')
    }
    if (Bun.file(readStateLeak).size > 0 || Bun.file(readHomeLeak).size > 0) {
      throw new Error('read-only App Server turn read protected content')
    }
    if (readRun.transcript.includes('must-not-be-readable')
      || readRun.transcript.includes(homeSentinelValue)) {
      throw new Error('read-only App Server turn exposed protected content')
    }

    const controlJob = job(repo, 'live-control', false, readRun.value.threadId)
    const controlArtifact = ensureManagedDirectory(stateDir, artifactDirForJob(stateDir, controlJob.id))
    const controlScratch = ensureManagedDirectory(stateDir, scratchDirForJob(stateDir, controlJob.id))
    const controlProfile = `zerokun_live_control_${randomUUID().replaceAll('-', '')}`
    const controlScript = join(controlScratch, 'control-probe.zsh')
    const controlStarted = join(controlScratch, 'control-started')
    const controlFinished = join(controlScratch, 'control-finished')
    createProbeScript(controlScript, [
      `printf started > ${shellQuote(controlStarted)}`,
      '/bin/sleep 60',
      `printf finished > ${shellQuote(controlFinished)}`,
    ])
    const controlScriptSnapshot = probeScriptSnapshot(controlScript)
    const controlRun = await runAppServer(
      codex, controlJob, stateDir, controlArtifact, controlScratch, controlProfile,
      async session => {
        const model = process.env.ZEROKUN_JOB_MODEL?.trim() || undefined
        const handshake = await session.resumeThread({
          threadId: readRun.value.threadId,
          cwd: repo,
          approvalPolicy: 'never',
          permissions: controlProfile,
          developerInstructions: 'Run only the exact authorized acceptance command requested by the user.',
          ...(model ? { model } : {}),
        })
        requireFixtureAgentsSource(handshake.instructionSources, repo)
        if (handshake.threadId !== readRun.value.threadId) {
          throw new Error('thread/resume returned a different thread')
        }
        const turnId = await session.startTurn(
          handshake.threadId,
          `Run exactly this command once and use no other tool: ${controlScript}`,
          controlJob.idempotencyKey,
          {
            cwd: repo,
            permissions: controlProfile,
            approvalPolicy: 'never',
            ...(model ? { model } : {}),
          },
        )
        const startDeadline = Date.now() + CONTROL_START_DEADLINE_MS
        while (!existsSync(controlStarted) && Date.now() < startDeadline) {
          const earlyTerminal = session.takeTurnTerminal(handshake.threadId, turnId)
          if (earlyTerminal) {
            throw new Error(`control probe ended before live steering: ${earlyTerminal.turn.status}`)
          }
          await session.waitForActivity(100)
        }
        if (!existsSync(controlStarted)) {
          throw new Error('control probe command did not start before the acceptance deadline')
        }
        const steer = await session.steer(
          handshake.threadId,
          turnId,
          '同じSlackスレッドからの追記です。この追記を現在のturnへ受け入れてください。',
          `live-steer:${randomUUID()}`,
        )
        if (!Number.isSafeInteger(steer.requestId)) {
          throw new Error('turn/steer returned no correlated request id')
        }
        const interrupt = await session.interrupt(handshake.threadId, turnId)
        if (!Number.isSafeInteger(interrupt.requestId)) {
          throw new Error('turn/interrupt returned no correlated request id')
        }
        const terminal = await waitForTurnTerminal(session, handshake.threadId, turnId)
        if (terminal.turn.status !== 'interrupted') {
          throw new Error(`interrupted control probe ended as ${terminal.turn.status}`)
        }
        return { turnId, steerRequestId: steer.requestId, interruptRequestId: interrupt.requestId }
      },
    )
    if (probeScriptSnapshot(controlScript) !== controlScriptSnapshot) {
      throw new Error('control probe script changed during execution')
    }
    if (existsSync(controlFinished)) {
      throw new Error('turn/interrupt did not stop the running control probe')
    }

    const writePrepareJob = job(repo, 'live-write-prepare', true, null)
    const writePrepareArtifact = ensureManagedDirectory(
      stateDir, artifactDirForJob(stateDir, writePrepareJob.id),
    )
    const writePrepareScratch = ensureManagedDirectory(
      stateDir, scratchDirForJob(stateDir, writePrepareJob.id),
    )
    const writePrepareProfile = `zerokun_live_write_prepare_${randomUUID().replaceAll('-', '')}`
    const writePrepareRepoProbe = join(repo, 'write-prepare-probe.txt')
    const writePrepareRepoStatus = join(writePrepareScratch, 'write-prepare-repo-status')
    const writePrepareScript = join(writePrepareScratch, 'write-prepare-permission-probe.zsh')
    createProbeScript(writePrepareScript, [
      `if printf blocked > ${shellQuote(writePrepareRepoProbe)}; then printf allowed > ${shellQuote(writePrepareRepoStatus)}; else printf denied > ${shellQuote(writePrepareRepoStatus)}; fi`,
    ])
    const writePrepareScriptSnapshot = probeScriptSnapshot(writePrepareScript)
    const writePrepareRun = await runCompletedProbe(
      codex,
      writePrepareJob,
      stateDir,
      writePrepareArtifact,
      writePrepareScratch,
      writePrepareProfile,
      writePrepareScript,
      { executionWriteEnabled: false },
    )
    if (probeScriptSnapshot(writePrepareScript) !== writePrepareScriptSnapshot) {
      throw new Error('write preparation permission probe script changed during execution')
    }
    requireStatus(writePrepareRepoStatus, 'denied')
    if (existsSync(writePrepareRepoProbe)) {
      throw new Error('read-only preparation process wrote to the repository')
    }

    const writeJob = job(repo, 'live-write', true, writePrepareRun.value.threadId)
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
    const writeRun = await runCompletedProbe(
      codex, writeJob, stateDir, writeArtifact, writeScratch, writeProfile, writeScriptPath,
    )
    if (writeRun.value.threadId !== writePrepareRun.value.threadId) {
      throw new Error('write implementation resumed a different thread after preparation')
    }
    if (!sameAppServerSessionSource(writeRun.value.source, writePrepareRun.value.source)) {
      throw new Error('write implementation changed the official session source after preparation')
    }
    if (probeScriptSnapshot(writeScriptPath) !== writeScriptSnapshot) {
      throw new Error('write-enabled permission probe script changed during execution')
    }
    if (readFileSync(writeProbeStarted, 'utf8') !== writeProbeMarker
      || readFileSync(writeProbeFinished, 'utf8') !== writeProbeComplete) {
      throw new Error('write-enabled App Server turn did not complete the fixed permission probe')
    }
    requireStatus(writeRepoStatus, 'allowed')
    requireStatus(writeOutboxStatus, 'allowed')
    requireStatus(writeStateStatus, 'denied')
    requireStatus(writeHomeStatus, 'denied')
    if (readFileSync(writeProbe, 'utf8') !== 'allowed') {
      throw new Error('write-enabled App Server turn could not write the repository')
    }
    if (readFileSync(outboxProbe, 'utf8') !== 'artifact') {
      throw new Error('write-enabled App Server turn could not write the outbox')
    }
    if (Bun.file(leakProbe).size > 0
      || Bun.file(homeLeakProbe).size > 0
      || writeRun.transcript.includes('must-not-be-readable')
      || writeRun.transcript.includes(homeSentinelValue)) {
      throw new Error('write-enabled App Server turn exposed protected content')
    }

    const writeResumeJob = job(
      repo, 'live-write-resume', true, writeRun.value.threadId,
    )
    const writeResumeArtifact = ensureManagedDirectory(
      stateDir, artifactDirForJob(stateDir, writeResumeJob.id),
    )
    const writeResumeScratch = ensureManagedDirectory(
      stateDir, scratchDirForJob(stateDir, writeResumeJob.id),
    )
    const writeResumeProfile = `zerokun_live_write_resume_${randomUUID().replaceAll('-', '')}`
    const writeResumeRepoProbe = join(repo, 'write-resume-probe.txt')
    const writeResumeOutboxProbe = join(writeResumeArtifact, 'write-resume-outbox.txt')
    const writeResumeStateLeak = join(writeResumeScratch, 'write-resume-state-leak')
    const writeResumeHomeLeak = join(writeResumeScratch, 'write-resume-home-leak')
    const writeResumeStateStatus = join(writeResumeScratch, 'write-resume-state-status')
    const writeResumeHomeStatus = join(writeResumeScratch, 'write-resume-home-status')
    const writeResumeScript = join(writeResumeScratch, 'write-resume-permission-probe.zsh')
    createProbeScript(writeResumeScript, [
      `printf resumed > ${shellQuote(writeResumeRepoProbe)}`,
      `printf resumed > ${shellQuote(writeResumeOutboxProbe)}`,
      `if /bin/cat ${shellQuote(secret)} > ${shellQuote(writeResumeStateLeak)} 2>/dev/null; then printf allowed > ${shellQuote(writeResumeStateStatus)}; else printf denied > ${shellQuote(writeResumeStateStatus)}; fi`,
      `if /bin/cat ${shellQuote(homeSentinel)} > ${shellQuote(writeResumeHomeLeak)} 2>/dev/null; then printf allowed > ${shellQuote(writeResumeHomeStatus)}; else printf denied > ${shellQuote(writeResumeHomeStatus)}; fi`,
    ])
    const writeResumeScriptSnapshot = probeScriptSnapshot(writeResumeScript)
    const writeResumeRun = await runCompletedProbe(
      codex,
      writeResumeJob,
      stateDir,
      writeResumeArtifact,
      writeResumeScratch,
      writeResumeProfile,
      writeResumeScript,
    )
    if (writeResumeRun.value.threadId !== writeRun.value.threadId) {
      throw new Error('write-enabled thread/resume returned a different thread')
    }
    if (!sameAppServerSessionSource(writeResumeRun.value.source, writeRun.value.source)) {
      throw new Error('write-enabled thread/resume changed the official session source')
    }
    if (probeScriptSnapshot(writeResumeScript) !== writeResumeScriptSnapshot) {
      throw new Error('write-resume permission probe script changed during execution')
    }
    if (readFileSync(writeResumeRepoProbe, 'utf8') !== 'resumed'
      || readFileSync(writeResumeOutboxProbe, 'utf8') !== 'resumed') {
      throw new Error('write-resume turn lost repository or outbox write permission')
    }
    requireStatus(writeResumeStateStatus, 'denied')
    requireStatus(writeResumeHomeStatus, 'denied')
    if (Bun.file(writeResumeStateLeak).size > 0
      || Bun.file(writeResumeHomeLeak).size > 0
      || writeResumeRun.transcript.includes('must-not-be-readable')
      || writeResumeRun.transcript.includes(homeSentinelValue)) {
      throw new Error('write-resume App Server turn exposed protected content')
    }

    const reviewJob = job(
      repo, 'live-write-review', true, writeResumeRun.value.threadId,
    )
    const reviewArtifact = ensureManagedDirectory(
      stateDir, artifactDirForJob(stateDir, reviewJob.id),
    )
    const reviewScratch = ensureManagedDirectory(
      stateDir, scratchDirForJob(stateDir, reviewJob.id),
    )
    const reviewProfile = `zerokun_live_write_review_${randomUUID().replaceAll('-', '')}`
    const reviewRepoProbe = join(repo, 'write-review-probe.txt')
    const reviewRepoStatus = join(reviewScratch, 'write-review-repo-status')
    const reviewStateLeak = join(reviewScratch, 'write-review-state-leak')
    const reviewHomeLeak = join(reviewScratch, 'write-review-home-leak')
    const reviewStateStatus = join(reviewScratch, 'write-review-state-status')
    const reviewHomeStatus = join(reviewScratch, 'write-review-home-status')
    const reviewScript = join(reviewScratch, 'write-review-permission-probe.zsh')
    createProbeScript(reviewScript, [
      `if printf blocked > ${shellQuote(reviewRepoProbe)}; then printf allowed > ${shellQuote(reviewRepoStatus)}; else printf denied > ${shellQuote(reviewRepoStatus)}; fi`,
      `if /bin/cat ${shellQuote(secret)} > ${shellQuote(reviewStateLeak)} 2>/dev/null; then printf allowed > ${shellQuote(reviewStateStatus)}; else printf denied > ${shellQuote(reviewStateStatus)}; fi`,
      `if /bin/cat ${shellQuote(homeSentinel)} > ${shellQuote(reviewHomeLeak)} 2>/dev/null; then printf allowed > ${shellQuote(reviewHomeStatus)}; else printf denied > ${shellQuote(reviewHomeStatus)}; fi`,
    ])
    const reviewScriptSnapshot = probeScriptSnapshot(reviewScript)
    const reviewRun = await runCompletedProbe(
      codex,
      reviewJob,
      stateDir,
      reviewArtifact,
      reviewScratch,
      reviewProfile,
      reviewScript,
      { executionWriteEnabled: false },
    )
    if (reviewRun.value.threadId !== writeResumeRun.value.threadId) {
      throw new Error('read-only review resumed a different implementation thread')
    }
    if (!sameAppServerSessionSource(reviewRun.value.source, writeResumeRun.value.source)) {
      throw new Error('read-only review changed the official implementation session source')
    }
    if (probeScriptSnapshot(reviewScript) !== reviewScriptSnapshot) {
      throw new Error('read-only review permission probe script changed during execution')
    }
    requireStatus(reviewRepoStatus, 'denied')
    requireStatus(reviewStateStatus, 'denied')
    requireStatus(reviewHomeStatus, 'denied')
    if (existsSync(reviewRepoProbe)) {
      throw new Error('read-only review process wrote to the repository')
    }
    if (Bun.file(reviewStateLeak).size > 0
      || Bun.file(reviewHomeLeak).size > 0
      || reviewRun.transcript.includes('must-not-be-readable')
      || reviewRun.transcript.includes(homeSentinelValue)) {
      throw new Error('read-only review App Server turn exposed protected content')
    }
    const phaseProcessIds = [
      writePrepareRun.processId,
      writeRun.processId,
      reviewRun.processId,
    ]
    if (new Set(phaseProcessIds).size !== phaseProcessIds.length) {
      throw new Error('permission phases reused an App Server process')
    }
    process.stdout.write(JSON.stringify({
      authentication: 'existing ChatGPT subscription login; API credentials not forwarded',
      transport: 'codex app-server --stdio',
      ambientMcpDiscovery: 'config-read-no-stdio-spawn-or-http-connect,same-process-pre-thread-revalidation',
      threadSources: {
        read: readRun.value.source,
        writePrepare: writePrepareRun.value.source,
        write: writeRun.value.source,
        writeResume: writeResumeRun.value.source,
        writeReview: reviewRun.value.source,
      },
      readTurn: 'AGENTS loaded,repo-write-denied,state-read-denied,unrelated-home-read-denied',
      liveControl: `thread-resume,turn-steer:${controlRun.value.steerRequestId},turn-interrupt:${controlRun.value.interruptRequestId}`,
      writePermissionPhases: `same-thread,separate-processes:${phaseProcessIds.join(',')},read-only-prepare,write-implementation,read-only-review`,
      writeTurn: 'thread-resume,repo-write-allowed,outbox-write-allowed,state-read-denied,unrelated-home-read-denied',
      writeResume: 'same-write-thread,repo-write-allowed,outbox-write-allowed,state-read-denied,unrelated-home-read-denied',
      writeReview: 'same-write-thread,repo-write-denied,state-read-denied,unrelated-home-read-denied',
      model: process.env.ZEROKUN_JOB_MODEL?.trim() || 'Codex default',
      provider: 'openai',
    }) + '\n')
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(homeSentinel, { force: true })
  }
}

if (import.meta.main) await main()
