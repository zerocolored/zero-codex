#!/usr/bin/env -S bun --config=/dev/null --no-env-file

/**
 * Authenticated acceptance check for the exact named-permission wiring used by
 * `codex exec` and `codex exec resume`. It is intentionally not part of CI:
 * it consumes a real Codex session and therefore requires local authentication.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
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

type Invocation = { exitCode: number; stdout: string; stderr: string }

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

async function invoke(args: string[], prompt: string, scratchDir: string): Promise<Invocation> {
  const codex = Bun.which('codex')
  if (!codex) throw new Error('codex executable is not on PATH')
  const proc = Bun.spawn([codex, ...args], {
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
  const repo = mkdtempSync(join(homedir(), '.zerokun-live-codex-repo-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'zerokun-live-codex-state-'))
  prepareManagedStateRoot(stateDir)
  try {
    mkdirSync(join(repo, '.git'), { mode: 0o700 })
    writeFileSync(join(repo, 'README.md'), 'permission acceptance fixture\n')
    const secret = join(stateDir, '.env')
    writeFileSync(secret, 'ZEROKUN_LIVE_SECRET=must-not-be-readable\n', { mode: 0o600 })

    const readJob = job(repo, 'live-read', false, null)
    const readArtifact = ensureManagedDirectory(stateDir, artifactDirForJob(stateDir, readJob.id))
    const readScratch = ensureManagedDirectory(stateDir, scratchDirForJob(stateDir, readJob.id))
    const readProfile = `zerokun_live_read_${randomUUID().replaceAll('-', '')}`
    const readResult = await invoke(
      argsFor(readJob, stateDir, readArtifact, readScratch, readProfile),
      [
        'This is an authorized sandbox acceptance probe. Use the shell once to attempt both operations,',
        'then report only whether each was allowed or denied; do not try any bypass:',
        `1) printf blocked > ${join(repo, 'read-only-probe.txt')}`,
        `2) cat ${secret}`,
      ].join('\n'),
      readScratch,
    )
    if (readResult.exitCode !== 0) throw new Error(`read exec failed: ${readResult.stderr}`)
    if (Bun.file(join(repo, 'read-only-probe.txt')).size > 0
      || await Bun.file(join(repo, 'read-only-probe.txt')).exists()) {
      throw new Error('read-only codex exec wrote to the repository')
    }
    if (readResult.stdout.includes('must-not-be-readable')) {
      throw new Error('read-only codex exec exposed state content')
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
    const outboxProbe = join(writeArtifact, 'outbox-probe.txt')
    const resumeResult = await invoke(
      argsFor(writeJob, stateDir, writeArtifact, writeScratch, writeProfile, sessionId),
      [
        'Continue the authorized sandbox acceptance probe. Use the shell to perform these exact checks',
        'and report only allowed/denied; do not try any bypass:',
        `1) printf allowed > ${writeProbe}`,
        `2) printf artifact > ${outboxProbe}`,
        `3) if value="$(cat ${secret} 2>/dev/null)"; then printf '%s' "$value" > ${leakProbe}; fi`,
      ].join('\n'),
      writeScratch,
    )
    if (resumeResult.exitCode !== 0) throw new Error(`write resume failed: ${resumeResult.stderr}`)
    if (readFileSync(writeProbe, 'utf8') !== 'allowed') {
      throw new Error('write-enabled codex resume could not write the repository')
    }
    if (readFileSync(outboxProbe, 'utf8') !== 'artifact') {
      throw new Error('write-enabled codex resume could not write the outbox')
    }
    if (await Bun.file(leakProbe).exists()
      || resumeResult.stdout.includes('must-not-be-readable')) {
      throw new Error('write-enabled codex resume exposed state content')
    }
    process.stdout.write(JSON.stringify({
      readExec: 'repo-write-denied,state-read-denied',
      writeResume: 'repo-write-allowed,outbox-write-allowed,state-read-denied',
      sessionId,
    }) + '\n')
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
}

await main()
