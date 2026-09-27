import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { Database } from 'bun:sqlite'
import {
  JobStore,
  runQueuedJobs,
  type JobRecord,
  finalizeSuccessfulExecution,
} from './job-runner.ts'
import {
  executeSecurityAudit,
  auditClean,
  copyAuditReportForFollowup,
  type AuditStep,
} from './security-audit.ts'
import {
  auditCommand,
  checkAuditInterrupted,
  auditTargetAllows,
  scannerFindings,
  zapScopeFiles,
  type AuditToolContext,
} from './security-audit-tools.ts'
import {
  separateSecurityWorkflow,
  classifyFleetRequest,
} from './fleet-query.ts'
import { containsCredentialMaterial } from './public-output-guard.ts'
import {
  CodexInterruptedError,
  CodexUserCancelledError,
  buildCodexDeveloperInstructions,
} from './codex-executor.ts'

const roots: string[] = []
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'security-audit-test-'))
  roots.push(root)
  const repo = join(root, 'repo'),
    state = join(root, 'state')
  mkdirSync(repo, { mode: 0o700 })
  mkdirSync(state, { mode: 0o700 })
  writeFileSync(join(repo, 'app.ts'), 'export const app = "fixture"\n')
  const store = new JobStore(join(state, 'jobs.sqlite'))
  const job = store.enqueue({
    chatId: 'C1',
    threadTs: '1.1',
    messageId: '1.2',
    userId: 'U1',
    repoPath: repo,
    task: 'セキュリティチェックして',
    workflow: 'security-audit',
    writeEnabled: true,
  }).job
  return { root, repo, state, store, job }
}
function result(number: number): AuditStep {
  return {
    number,
    status: 'completed',
    tool: `tool${number}`,
    version: 'fixture1',
    scope: 'fixture',
    note: '',
    startedAt: 1,
    finishedAt: 2,
    exitCode: 0,
    findings: [],
    evidenceDigest: null,
  }
}
const model = async (prompt: string) => {
  expect(prompt).toContain('SECURITY AUDIT')
  expect(prompt).toContain('No edits')
  expect(prompt).toContain('untrusted evidence')
  return JSON.stringify({ findings: [], note: 'fixture source reviewed' })
}
describe('security audit workflow', () => {
  test('daemon interruption preserves audit queue while explicit cancellation stays distinct', async () => {
    const { store, job } = fixture()
    const controller = new AbortController()
    controller.abort()
    expect(() => checkAuditInterrupted({ signal: controller.signal })).toThrow(
      CodexInterruptedError,
    )
    expect(() =>
      checkAuditInterrupted({
        signal: controller.signal,
        cancelled: () => true,
      }),
    ).toThrow(CodexUserCancelledError)
    try {
      const stats = await runQueuedJobs({
        store,
        maxJobsPerSession: 1,
        pollMs: 1,
        stopWhenIdle: true,
        executor: async () => {
          throw new CodexInterruptedError('worker stopping')
        },
      })
      expect(stats.failed).toBe(0)
      expect(store.get(job.id)?.status).toBe('queued')
      expect(store.get(job.id)?.workflow).toBe('security-audit')
    } finally {
      store.close()
    }
  })
  test('unverified prior report does not authorize inferred remediation or block unrelated work', () => {
    const { store, job, state } = fixture()
    try {
      const instructions = buildCodexDeveloperInstructions(
        { ...job, workflow: 'work', auditReportUnavailable: true },
        join(state, 'outbox', job.id),
      )
      expect(instructions).toContain('ask the user to reattach it')
      expect(instructions).toContain('unrelated work may proceed')
    } finally {
      store.close()
    }
  })
  test('Semgrep messages cannot leak secrets and scanner severity is retained', () => {
    const results = scannerFindings('semgrep', {
      results: [
        {
          check_id: 'secret-rule',
          path: 'token.ts',
          start: { line: 1 },
          extra: {
            severity: 'ERROR',
            message: 'private fixture arbitrary secret',
          },
        },
      ],
    })
    expect(results[0]?.severity).toBe('high')
    expect(JSON.stringify(results)).not.toContain(
      'private fixture arbitrary secret',
    )
    expect(
      scannerFindings('codeql', {
        runs: [
          {
            tool: {
              driver: {
                rules: [
                  { id: 'unsafe', properties: { 'security-severity': '9.8' } },
                ],
              },
            },
            results: [{ ruleId: 'unsafe', message: { text: 'finding' } }],
          },
        ],
      })[0]?.severity,
    ).toBe('critical')
    expect(
      scannerFindings('codeql', {
        runs: [
          {
            tool: {
              driver: {
                rules: [
                  { id: 'unsafe', defaultConfiguration: { level: 'warning' } },
                ],
              },
            },
            results: [{ ruleId: 'unsafe' }],
          },
        ],
      })[0]?.severity,
    ).toBe('medium')
  })
  test('Socket unfolded report counts every nested alert leaf', () => {
    const findings = scannerFindings('socket', {
      ok: true,
      data: {
        healthy: false,
        scanId: 'fixture',
        alerts: {
          npm: {
            demo: {
              '1.0': {
                'package-lock.json': {
                  a: {
                    type: 'malware',
                    policy: 'error',
                    url: 'https://example.test/a',
                    manifest: 'package-lock.json',
                  },
                  b: {
                    type: 'license',
                    policy: 'warn',
                    url: 'https://example.test/b',
                    manifest: 'package-lock.json',
                  },
                },
              },
            },
          },
        },
      },
    })
    expect(findings).toHaveLength(2)
    expect(() =>
      scannerFindings('socket', { ok: false, error: 'failed' }),
    ).toThrow()
  })
  test('ZAP sender strips cookies for traversal and foreign targets', () => {
    const script = zapScopeFiles('https://example.com/app').script
    for (const path of [
      '/app/ok',
      '/app/../admin',
      '/app/%2e%2e/admin',
      '/app/\\admin',
      '/outside',
    ]) {
      let cookie: string | null = 'old'
      const uri = {
        getPort: () => 443,
        getScheme: () => 'https',
        getHost: () => 'example.com',
        getEscapedPath: () => path,
        getPath: () => new URL('https://example.com' + path).pathname,
      }
      const header = {
        getURI: () => uri,
        setHeader: (_name: string, value: string | null) => {
          cookie = value
        },
      }
      const send = new Function('Java', script + ';return sendingRequest')({
        type: () => ({ getenv: () => 'synthetic-cookie' }),
      })
      send({ getRequestHeader: () => header }, null, null)
      expect(cookie).toBe(path === '/app/ok' ? 'synthetic-cookie' : null)
    }
  })
  test('audit is read-only, durable, and never resumes a development session', () => {
    const { store, job } = fixture()
    try {
      expect(job.workflow).toBe('security-audit')
      expect(job.writeEnabled).toBe(false)
      expect(
        store
          .pendingStatusNotifications()
          .filter((n) => n.payload.includes('13工程')),
      ).toHaveLength(1)
      expect(
        store.statusNotificationDeliverable(
          store.pendingStatusNotifications()[0]!.id,
        ),
      ).toBe(true)
      const claimed = store.claimNext('test')!
      expect(claimed.sessionId).toBeNull()
      expect(claimed.resumed).toBe(false)
      expect(store.recoverInterrupted().requeued).toBe(1)
      expect(store.get(job.id)?.status).toBe('queued')
      expect(store.claimNext('test2')?.workflow).toBe('security-audit')
    } finally {
      store.close()
    }
  })
  test('security route persists through legacy CHECK migration, without losing fleet rows', () => {
    const { store, state, repo } = fixture()
    store.close()
    const path = join(state, 'jobs.sqlite'),
      db = new Database(path)
    db.exec(
      "DROP TABLE fleet_queries; CREATE TABLE fleet_queries(idempotency_key TEXT PRIMARY KEY,chat_id TEXT NOT NULL,thread_ts TEXT NOT NULL,repo_path TEXT NOT NULL,project_key TEXT,input TEXT NOT NULL,route TEXT NOT NULL CHECK(route IN ('work','fleet-status')),created_at INTEGER NOT NULL,completed_at INTEGER);",
    )
    db.run(
      "INSERT INTO fleet_queries VALUES('old','C','1',?,'repo','status','fleet-status',1,NULL)",
      [repo],
    )
    db.close()
    const next = new JobStore(path)
    try {
      next.stageInboundDelivery({
        chatId: 'C2',
        threadTs: '2.1',
        messageId: '2.2',
        userId: 'U1',
        repoPath: repo,
        text: 'scan',
        fileIds: ['F1'],
      })
      const input = next.claimNextInboundDelivery()!
      next.stageFleetRoute(input, 'security-audit', null)
      expect(next.fleetQueryRoute(input.idempotencyKey)).toBe('security-audit')
      expect(next.pendingFleetQueries().map((r) => r.key)).toContain('old')
    } finally {
      next.close()
    }
  })
  test('13 stages settle, missing scanners remain visible, report retry does not rerun tools', async () => {
    const { job, state, repo, store } = fixture()
    const calls: number[] = []
    writeFileSync(join(repo, '.env'), 'PRIVATE_TOKEN=not-for-the-model')
    writeFileSync(join(repo, 'token.ts'), 'export const tokenService = 1')
    writeFileSync(
      join(repo, 'credentials.service.ts'),
      'export const credentialsService = 1',
    )
    const secretFiles = [
      'auth.json',
      'secrets.yaml',
      'tokens.json',
      'service.credentials.json',
      'webhook-secret.yml',
    ]
    for (const name of secretFiles)
      writeFileSync(join(repo, name), 'fixture-sensitive-value-never-read')
    symlinkSync('/etc', join(repo, 'foreign'))
    const tool = async (n: number) => {
      calls.push(n)
      return n === 7
        ? {
            ...result(n),
            status: 'unavailable' as const,
            note: 'license not configured',
          }
        : n === 8
          ? {
              ...result(n),
              status: 'findings' as const,
              findings: [
                {
                  title: 'CVE fixture',
                  severity: 'high' as const,
                  location: 'package.json',
                  evidence: 'fixture evidence',
                  recommendation: 'update after explicit request',
                },
              ],
            }
          : result(n)
    }
    try {
      const run = await executeSecurityAudit(job, {
        stateDir: state,
        tool,
        model: async (prompt, ...rest) => {
          expect(prompt).not.toContain('fixture-sensitive-value-never-read')
          return model(prompt)
        },
      })
      expect(calls).toEqual([1, 5, 6, 7, 8, 9, 10, 11, 12])
      const journal = JSON.parse(
        readFileSync(
          join(state, 'security-audits', job.id, 'journal.json'),
          'utf8',
        ),
      )
      expect(journal.steps).toHaveLength(13)
      expect(journal.steps[6].status).toBe('unavailable')
      const file = JSON.parse(
        run.result.match(/<zerokun_files>(.*?)<\/zerokun_files>/s)![1]!,
      )[0]
      const report = readFileSync(file, 'utf8')
      expect(report).toContain('CVE fixture')
      expect(report).toContain('license not configured')
      expect(report).not.toContain('not-for-the-model')
      expect(report).toContain('.env: protected')
      for (const name of secretFiles)
        expect(report).toContain(name + ': protected')
      expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toBe(
        'export const app = "fixture"\n',
      )
      expect(
        await executeSecurityAudit(job, { stateDir: state, tool, model }),
      ).toEqual(run)
      expect(calls).toHaveLength(9)
      expect(report).not.toContain('token.ts: protected')
      expect(report).not.toContain('credentials.service.ts: protected')
      expect(existsSync(join(state, 'security-audits', job.id, 'source'))).toBe(
        false,
      )
      expect(finalizeSuccessfulExecution(job, run, state).result).toContain(
        '<zerokun_files>',
      )
      const followup = {
        ...job,
        id: randomUUID(),
        seq: job.seq + 1,
        workflow: 'work' as const,
        writeEnabled: true,
      }
      const copy = copyAuditReportForFollowup(followup, state, job.id)
      expect(readFileSync(copy, 'utf8')).toBe(report)
      expect(
        buildCodexDeveloperInstructions(
          { ...followup, auditReportPath: copy },
          join(state, 'outbox', followup.id),
        ),
      ).toContain('host-verified security report')
      expect(() =>
        copyAuditReportForFollowup(
          { ...followup, repoPath: '/foreign' },
          state,
          job.id,
        ),
      ).toThrow('scope')
    } finally {
      store.close()
    }
  }, 20000)
  test('a running step from a crash is not replayed, and later steps still run', async () => {
    const { job, state, store } = fixture()
    try {
      await executeSecurityAudit(job, {
        stateDir: state,
        model,
        tool: async (n) => result(n),
      })
      const path = join(state, 'security-audits', job.id, 'journal.json'),
        j = JSON.parse(readFileSync(path, 'utf8'))
      j.steps = j.steps.slice(0, 11)
      j.steps[10].status = 'running'
      j.result = null
      j.reportDigest = null
      writeFileSync(path, JSON.stringify(j), { mode: 0o600 })
      const calls: number[] = []
      await executeSecurityAudit(job, {
        stateDir: state,
        model,
        tool: async (n) => {
          calls.push(n)
          return result(n)
        },
      })
      expect(calls).toEqual([12])
      expect(JSON.parse(readFileSync(path, 'utf8')).steps[10].status).toBe(
        'interrupted',
      )
    } finally {
      store.close()
    }
  }, 20000)
  test('report routing does not steer across audit/development; interrupts retain host route', async () => {
    expect(separateSecurityWorkflow('security-audit', 'work', false)).toBe(true)
    expect(separateSecurityWorkflow('work', 'security-audit', false)).toBe(true)
    expect(separateSecurityWorkflow('work', 'work', false)).toBe(false)
    expect(separateSecurityWorkflow('work', 'security-audit', true)).toBe(false)
    expect(
      await classifyFleetRequest(
        '上のレポートを修正して',
        'audit report',
        async (prompt) => {
          expect(prompt).toContain('FIX findings')
          return '{"route":"work"}'
        },
      ),
    ).toBe('work')
    await expect(
      classifyFleetRequest(
        'scan',
        '',
        async () => '{"route":"security-audit","project":"foreign"}',
      ),
    ).rejects.toThrow('route')
  })
  test('structured secret findings and Socket credentials cannot leak in reports', () => {
    const secret = 'sktsec_' + 'testvalue'.repeat(5) + '_api'
    expect(containsCredentialMaterial(secret)).toBe(true)
    expect(auditClean(secret)).not.toContain(secret)
    expect(
      auditClean('{"client_secret":"arbitrary-fixture-value"}'),
    ).not.toContain('arbitrary-fixture-value')
    const parsed = scannerFindings('gitleaks', [
      {
        RuleID: 'secret',
        File: 'app.ts',
        StartLine: 2,
        Secret: secret,
        Match: secret,
        Description: 'secret match',
      },
    ])
    expect(JSON.stringify(parsed)).not.toContain(secret)
    expect(parsed[0]?.location).toBe('app.ts:2')
  })
  test('package findings are counted and malformed output cannot become a clean scan', () => {
    const f = scannerFindings('bun audit', {
      demo: [
        {
          title: 'fixture advisory',
          severity: 'moderate',
          vulnerable_versions: '<2',
          url: 'https://example.test/advisory',
        },
      ],
    })
    expect(f).toHaveLength(1)
    expect(f[0]?.severity).toBe('medium')
    expect(() => scannerFindings('semgrep', { error: 'failed' })).toThrow(
      'schema',
    )
    expect(() => scannerFindings('zap', {})).toThrow('schema')
  })
  test('ZAP credentials are confined to exact origin and authorized path, never a hostname substring', () => {
    expect(
      auditTargetAllows(
        'https://example.com/app',
        'https://example.com/app/page',
      ),
    ).toBe(true)
    for (const u of [
      'https://example.com.evil.test/app',
      'https://evil-example.com/app',
      'http://example.com/app',
      'https://example.com:444/app',
      'https://example.com/apple',
    ])
      expect(auditTargetAllows('https://example.com/app', u)).toBe(false)
    const files = zapScopeFiles('https://example.com/app')
    expect(files.script).toContain('getHost())==="example.com"')
    expect(files.script).toContain('port===443')
    expect(files.context).toContain('incregexes')
  })
  test('Trivy license-only results remain visible', () => {
    const findings = scannerFindings('trivy', {
      SchemaVersion: 2,
      Results: [
        {
          Target: 'package-lock.json',
          Licenses: [
            {
              Name: 'GPL-3.0',
              PkgName: 'fixture',
              Category: 'restricted',
              Confidence: 1,
            },
          ],
        },
      ],
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.title).toBe('License: GPL-3.0')
  })
  test('followup report lookup is bound to project and Slack thread', () => {
    const { store, job, repo } = fixture()
    try {
      store.claimNext('fixture')
      store.complete(job.id, 'fixture-session', 'report')
      const next = {
        ...job,
        id: randomUUID(),
        seq: job.seq + 1,
        workflow: 'work' as const,
      }
      expect(store.previousSecurityAudit(next)).toBe(job.id)
      expect(
        store.previousSecurityAudit({ ...next, threadTs: 'foreign' }),
      ).toBeNull()
      expect(
        store.previousSecurityAudit({ ...next, repoPath: repo + '-foreign' }),
      ).toBeNull()
    } finally {
      store.close()
    }
  })
  test('scanner cannot write snapshot, journal, or shared executables', async () => {
    if (process.platform !== 'darwin' && !Bun.which('bwrap')) return
    const { job, state, repo, store } = fixture(),
      audit = join(state, 'audit'),
      run = join(audit, 'stage-1'),
      shared = join(state, 'security-audit-tools')
    mkdirSync(run, { recursive: true, mode: 0o700 })
    mkdirSync(shared, { mode: 0o700 })
    const paths = [
      join(repo, 'app.ts'),
      join(audit, 'journal.json'),
      join(shared, 'scanner'),
    ]
    for (const p of paths) writeFileSync(p, 'unchanged', { mode: 0o600 })
    symlinkSync(paths[0]!, join(run, 'scanner.sb'))
    const privatePath = join(state, 'private-fixture.json')
    writeFileSync(privatePath, 'fixture private data', { mode: 0o600 })
    const ctx: AuditToolContext = {
      root: run,
      source: repo,
      repo,
      stateDir: state,
      jobId: job.id,
      settings: { activeScan: false, codeqlLicensed: false, images: [] },
    }
    try {
      const script = `const fs=require('fs');console.log(JSON.stringify({writes:${JSON.stringify(paths)}.map(p=>{try{fs.writeFileSync(p,'tampered');return false}catch{return true}}),privateReadBlocked:(()=>{try{fs.readFileSync(${JSON.stringify(privatePath)});return false}catch{return true}})()}))`
      const result = await auditCommand(
        [process.execPath, '-e', script],
        run,
        ctx,
        { sandbox: true, offline: true },
      )
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        writes: [true, true, true],
        privateReadBlocked: true,
      })
      for (const p of paths) expect(readFileSync(p, 'utf8')).toBe('unchanged')
    } finally {
      store.close()
    }
  }, 15000)
  test('subprocess capture is finite and isolated from host secrets', async () => {
    const { job, state, repo, root, store } = fixture(),
      run = join(state, 'run')
    mkdirSync(run, { mode: 0o700 })
    const ctx: AuditToolContext = {
      root: run,
      source: repo,
      repo,
      stateDir: state,
      jobId: job.id,
      settings: { activeScan: false, codeqlLicensed: false, images: [] },
    }
    try {
      const r = await auditCommand(
        [
          process.execPath,
          '-e',
          'console.log(process.env.SECRET_AUDIT_SENTINEL ?? "absent")',
        ],
        root,
        ctx,
      )
      expect(r.exitCode).toBe(0)
      expect(r.stdout.trim()).toBe('absent')
      const timed = await auditCommand(
        [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        root,
        ctx,
        { timeoutMs: 300 },
      )
      expect(timed.exitCode).toBe(124)
    } finally {
      store.close()
    }
  }, 15000)
})
