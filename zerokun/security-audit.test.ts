import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  realpathSync,
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
  snapshotAuditSource,
  type AuditStep,
} from './security-audit.ts'
import {
  auditCommand,
  runAuditTool,
  checkAuditInterrupted,
  auditTargetAllows,
  scannerFindings,
  auditPlaywrightConfigs,
  cleanupAuditZap,
  redactAuditCookies,
  zapScopeFiles,
  type AuditToolContext,
} from './security-audit-tools.ts'
import {
  separateSecurityWorkflow,
  classifyFleetRequest,
} from './fleet-query.ts'
import { containsCredentialMaterial } from './public-output-guard.ts'
import { readOwnerOnlyOutput } from './slack-thread-intent.ts'
import {
  CodexInterruptedError,
  CodexCleanupPendingError,
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
test('audit output accepts real review sizes while classifier and confidentiality limits remain enforced', () => {
  const { root, store } = fixture()
  try {
    const path = join(root, 'response.json')
    const large = JSON.stringify({ findings: [], note: '監査結果'.repeat(1000) })
    writeFileSync(path, large, { mode: 0o600 })
    expect(() => readOwnerOnlyOutput(path)).toThrow('unsafe')
    expect(readOwnerOnlyOutput(path, 1_000_000)).toBe(large)
    writeFileSync(path, 'x'.repeat(1_000_001))
    expect(() => readOwnerOnlyOutput(path, 1_000_000)).toThrow('unsafe')
    expect(() => readOwnerOnlyOutput(path, Number.MAX_SAFE_INTEGER)).toThrow('limit')
    const link = join(root, 'response-link.json')
    symlinkSync(path, link)
    expect(() => readOwnerOnlyOutput(link, 1_000_000)).toThrow('unsafe')
  } finally { store.close() }
})

test('transient source review failure is retried without replaying scanners or duplicating findings', async () => {
  const { state, store, job } = fixture()
  let calls = 0
  const stages: number[] = []
  try {
    await executeSecurityAudit(job, { stateDir: state, tool: async n => { stages.push(n); return result(n) }, model: async (_prompt, _schema, options) => {
      expect(options?.purpose).toBe('security-audit')
      if (++calls === 1) throw Error('temporary model failure')
      return JSON.stringify({ findings: [{ title: 'fixture', severity: 'low', location: 'app.ts:1', evidence: 'synthetic evidence', recommendation: 'review fixture' }], note: '' })
    } })
    const journal = JSON.parse(readFileSync(join(state, 'security-audits', job.id, 'journal.json'), 'utf8'))
    expect(calls).toBe(5)
    expect(stages).toEqual([1, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(journal.steps[0].status).toBe('findings')
    expect(journal.steps[0].findings).toHaveLength(1)
    expect(journal.steps[0].note).toContain('app.ts:1: attempt 1/2: temporary model failure')
  } finally { store.close() }
})

test('persistent source review failure remains incomplete with bounded diagnostic evidence', async () => {
  const { state, store, job } = fixture()
  let calls = 0
  try {
    await executeSecurityAudit(job, { stateDir: state, tool: async n => result(n), model: async () => {
      calls++
      throw Error('Authorization: Bearer fixture-sensitive-value')
    } })
    const raw = readFileSync(join(state, 'security-audits', job.id, 'journal.json'), 'utf8')
    const journal = JSON.parse(raw)
    expect(calls).toBe(8)
    expect(raw).not.toContain('fixture-sensitive-value')
    expect(journal.steps.slice(0, 4).every((s: AuditStep) => s.status === 'failed' && s.note.includes('attempt 2/2'))).toBe(true)
  } finally { store.close() }
})

test('oversized generated lines reach every review within the complete UTF-8 prompt budget without gaps', async () => {
  const { state, repo, store, job } = fixture()
  const lines = ['日本語😀"\\\t'.repeat(16000), 'second'.repeat(20000), 'export const tail = 1']
  writeFileSync(join(repo, 'app.ts'), lines.join('\n'))
  const parts: Array<{ file: string; start: number; text: string; offsetUtf16?: number }> = []
  try {
    await executeSecurityAudit(job, { stateDir: state, tool: async n => result(n), model: async prompt => {
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(100_000)
      const part = JSON.parse(prompt.split('\nSource: ')[1]!)
      expect(part.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
      parts.push(part)
      return JSON.stringify({ findings: [], note: '' })
    } })
    const journal = JSON.parse(readFileSync(join(state, 'security-audits', job.id, 'journal.json'), 'utf8'))
    expect(journal.steps.slice(0, 4).every((s: AuditStep) => s.status === 'completed')).toBe(true)
    expect(parts.length % 4).toBe(0)
    const perStage = parts.length / 4
    expect(perStage).toBeGreaterThan(3)
    for (let n = 0; n < 4; n++) {
      const stage = parts.slice(n * perStage, (n + 1) * perStage)
      expect(stage.map(p => p.text).join('')).toBe(auditClean(lines.map((line, i) => `${i + 1}: ${line}\n`).join('')))
      for (const line of [1, 2]) {
        let offset = 0
        for (const part of stage.filter(p => p.start === line)) {
          expect(part.offsetUtf16).toBe(offset)
          offset += part.text.length
        }
      }
    }
  } finally { store.close() }
}, 20000)

test('pnpm advisories retain dependency paths and malformed responses cannot pass as clean', () => {
  const clean = { advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }
  expect(scannerFindings('pnpm', clean)).toEqual([])
  expect(scannerFindings('pnpm', { ...clean, advisories: { 1: { module_name: 'fixture', title: 'fixture vulnerability', severity: 'moderate', vulnerable_versions: '<2', patched_versions: '>=2', findings: [{ paths: ['worker>fixture'] }] } } })[0]).toMatchObject({ location: 'fixture', severity: 'medium', evidence: 'Affected: <2; paths: worker>fixture' })
  for (const invalid of [{}, { error: 'registry unavailable' }, { advisories: [] }, { ...clean, advisories: { bad: {} } }])
    expect(() => scannerFindings('pnpm', invalid)).toThrow('schema')
})

test('Playwright discovery supports workspaces without following unrelated checkouts or symlinks', () => {
  const { repo, store } = fixture()
  try {
    for (const dir of ['packages/web', '.worktrees/other', 'node_modules/fixture']) {
      mkdirSync(join(repo, dir), { recursive: true })
      writeFileSync(join(repo, dir, 'playwright.config.ts'), 'export default {}')
    }
    symlinkSync(join(repo, 'packages'), join(repo, 'linked-packages'))
    expect(auditPlaywrightConfigs(repo)).toEqual(['packages/web/playwright.config.ts'])
    writeFileSync(join(repo, 'playwright.config.mjs'), 'export default {}')
    expect(auditPlaywrightConfigs(repo)).toEqual(['playwright.config.mjs'])
  } finally { store.close() }
})

test('audit Docker commands retain the selected engine under an isolated HOME', async () => {
  const { root, repo, state, store, job } = fixture()
  try {
    const executable = join(root, 'docker')
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n%s\\n" "$DOCKER_HOST" "$HOME"\n', { mode: 0o700 })
    const r = await auditCommand([executable], root, { root, source: repo, repo, stateDir: state, jobId: job.id,
      settings: { activeScan: false, codeqlLicensed: false, images: [] }, dockerHost: 'unix:///fixture/selected.sock' })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.split('\n')).toEqual(['unix:///fixture/selected.sock', join(root, 'home'), ''])
  } finally { store.close() }
})

test('unreachable Docker remains cleanup pending and empty cookies cannot expand diagnostics', async () => {
  const { root, repo, state, store, job } = fixture()
  const previousHost = process.env.DOCKER_HOST, previousContext = process.env.DOCKER_CONTEXT
  try {
    delete process.env.DOCKER_CONTEXT
    process.env.DOCKER_HOST = `unix://${root}/absent-docker.sock`
    await expect(cleanupAuditZap({ root, source: repo, repo, stateDir: state, jobId: job.id,
      settings: { activeScan: false, codeqlLicensed: false, images: [] } })).rejects.toBeInstanceOf(CodexCleanupPendingError)
    expect(redactAuditCookies('exit=1; diagnostic', [{ value: '' }])).toBe('exit=1; diagnostic')
    expect(redactAuditCookies('a.b a x 1', [{ value: '' }, { value: 'a' }, { value: 'a.b' }, { value: '1' }]))
      .toBe('[認証情報を除去] [認証情報を除去] x [認証情報を除去]')
    expect(redactAuditCookies('fixture', [{ value: 'fixture' }, { value: '認' }])).toBe('[認証情報を除去]')
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = previousHost
    if (previousContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = previousContext
    store.close()
  }
})

test('Gitleaks exit zero without its structured report is never a clean scan', async () => {
  const { root, repo, state, store, job } = fixture()
  const priorPath = process.env.PATH
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gitleaks'), '#!/bin/sh\nif [ "$1" = version ]; then echo fixture; fi\nexit 0\n', { mode: 0o700 })
    process.env.PATH = `${bin}:${priorPath ?? '/usr/bin:/bin'}`
    const s = await runAuditTool(9, { root, source: repo, repo, stateDir: state, jobId: job.id,
      settings: { activeScan: false, codeqlLicensed: false, images: [] } })
    expect(s.status).toBe('unavailable')
    expect(s.note).toContain('Gitleaks directory report unavailable')
    expect(s.evidenceDigest).toBeNull()
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    store.close()
  }
})

test('an E2E runner that exits zero with no executed tests remains incomplete', async () => {
  const { root, repo, state, store, job } = fixture()
  const priorPath = process.env.PATH
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    process.env.PATH = `${bin}:${priorPath ?? '/usr/bin:/bin'}`
    writeFileSync(join(repo, 'playwright.config.mjs'), 'export default {}')
    const cliDir = join(repo, 'node_modules/@playwright/test')
    mkdirSync(cliDir, { recursive: true })
    writeFileSync(join(cliDir, 'cli.js'), `console.log(process.argv.includes('--version') ? 'fixture' : JSON.stringify({suites:[],stats:{expected:0,unexpected:0,flaky:0,skipped:0}}))`)
    const s = await runAuditTool(12, { root, source: repo, repo, stateDir: state, jobId: job.id,
      settings: { activeScan: false, codeqlLicensed: false, images: [], authentication: 'none', e2ePort: 3100 } })
    expect(s.exitCode).toBe(0)
    expect(s.status).toBe('unavailable')
    expect(s.note).toContain('実行されたテストがありません')
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    store.close()
  }
})

test('ZAP hooks restore the authorized subpath after packaged scans replace it with the root', () => {
  const { root, store } = fixture()
  try {
    const path = join(root, 'hook.py')
    writeFileSync(path, zapScopeFiles('https://example.test/allowed/app?fixture=1').hook)
    const r = Bun.spawnSync(['python3', '-c',
      `import runpy,sys\nh=runpy.run_path(sys.argv[1])\nassert h['zap_spider']('client','https://example.test/') == ('client','https://example.test/allowed/app?fixture=1')\nassert h['zap_active_scan']('client','https://example.test/','policy') == ('client','https://example.test/allowed/app?fixture=1','policy')`, path], { stdout: 'pipe', stderr: 'pipe' })
    expect(r.stderr.toString()).toBe('')
    expect(r.exitCode).toBe(0)
  } finally { store.close() }
})
test('cleanup failure is retained even when interruption is also requested', async () => {
  const { job, state, store } = fixture()
  const controller = new AbortController()
  try {
    await expect(executeSecurityAudit(job, { stateDir: state, signal: controller.signal, model: async () => {
      controller.abort()
      throw new CodexCleanupPendingError('fixture process group still live')
    } })).rejects.toBeInstanceOf(CodexCleanupPendingError)
  } finally { store.close() }
})
test('snapshot follows Git inventory, preserves tracked edits and excludes nested repositories', async () => {
  const { repo, state, store } = fixture()
  const put = (name: string, content = 'export const value = 1') => {
    const path = join(repo, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
    expect(run.exitCode).toBe(0)
  }
  try {
    git('init', '-q')
    git('config', 'core.precomposeunicode', 'true')
    put('tracked-ignored.ts')
    const unicodeName = 'か\u3099.ts'
    put(unicodeName)
    git('add', 'app.ts', 'tracked-ignored.ts', unicodeName)
    put('.gitignore', 'generated/\ntracked-ignored.ts\n')
    put('app.ts', 'export const edited = true')
    put('space name.ts')
    put('line\nbreak.ts')
    put('generated/ignored.ts')
    put('.worktrees/other/app.ts')
    git('-C', '.worktrees/other', 'init', '-q')
    put('real-nested/app.ts')
    git('-C', 'real-nested', 'init', '-q')
    put('nested/.git', 'gitdir: /unread-target')
    put('nested/app.ts')
    put('.env', 'DO_NOT_COPY=fixture')
    symlinkSync(join(repo, 'app.ts'), join(repo, 'linked.ts'))
    const source = join(state, 'source')
    mkdirSync(source, { mode: 0o700 })
    const snapshot = await snapshotAuditSource(repo, source, { stateDir: state, root: state, source, repo, settings: {}, jobId: 'fixture' } as AuditToolContext)
    expect(snapshot.files).toEqual(['.gitignore', 'app.ts', 'line\nbreak.ts', 'space name.ts', 'tracked-ignored.ts', unicodeName])
    expect(readFileSync(join(source, 'app.ts'), 'utf8')).toBe('export const edited = true')
    expect(snapshot.omitted.some(x => x.startsWith('nested: nested repository'))).toBe(true)
    expect(existsSync(join(source, 'generated'))).toBe(false)
  } finally { store.close() }
})

test('legacy audit resumes original cache indices and filters scanner input without changing source', async () => {
  const { job, state, repo, store } = fixture()
  const controller = new AbortController()
  const root = join(state, 'security-audits', job.id)
  try {
    await expect(executeSecurityAudit(job, { stateDir: state, signal: controller.signal, model: async () => {
      controller.abort(); throw new DOMException('interrupted', 'AbortError')
    } })).rejects.toBeInstanceOf(CodexInterruptedError)
    const path = join(root, 'journal.json')
    const journal = JSON.parse(readFileSync(path, 'utf8'))
    journal.files = ['.worktrees/other/app.ts', 'a.ts', 'b.ts', 'nested/other.ts']
    journal.omitted = ['nested/.git: protected/generated directory or file']
    for (const file of journal.files) {
      mkdirSync(join(root, 'source', file, '..'), { recursive: true })
      writeFileSync(join(root, 'source', file), `export const original = ${JSON.stringify(file)}\n`, { mode: 0o600 })
    }
    writeFileSync(path, JSON.stringify(journal), { mode: 0o600 })
    const finding = (title: string) => ({ title, severity: 'low', location: 'a.ts:1', evidence: 'fixture evidence', recommendation: 'review fixture' })
    writeFileSync(join(root, 'review-1', '0.json'), JSON.stringify({ findings: [finding('excluded finding')], note: '' }), { mode: 0o600 })
    writeFileSync(join(root, 'review-1', '1.json'), JSON.stringify({ findings: [finding('retained finding')], note: '' }), { mode: 0o600 })
    const cacheBefore = readFileSync(join(root, 'review-1', '1.json'), 'utf8')
    writeFileSync(join(repo, 'app.ts'), 'changed after original snapshot')
    const prompts: string[] = [], calls: number[] = []
    await executeSecurityAudit(job, { stateDir: state, model: async prompt => {
      prompts.push(prompt)
      expect(prompt).not.toContain('.worktrees')
      expect(prompt).not.toContain('nested/other.ts')
      expect(prompt).not.toContain('changed after original snapshot')
      return model(prompt)
    }, tool: async (n, ctx) => {
      calls.push(n)
      expect(ctx.source).toBe(realpathSync(join(root, 'selected-source')))
      expect(existsSync(join(ctx.source, '.worktrees'))).toBe(false)
      expect(existsSync(join(ctx.source, 'nested'))).toBe(false)
      expect(readFileSync(join(ctx.source, 'a.ts'), 'utf8')).toContain('original')
      expect(existsSync(join(root, 'source', '.worktrees/other/app.ts'))).toBe(true)
      expect(readFileSync(join(root, 'review-1', '1.json'), 'utf8')).toBe(cacheBefore)
      return result(n)
    } })
    expect(prompts).toHaveLength(7)
    expect(prompts[0]).toContain('"file":"b.ts"')
    expect(calls).toEqual([1, 5, 6, 7, 8, 9, 10, 11, 12])
    const final = JSON.parse(readFileSync(path, 'utf8'))
    expect(final.files).toEqual(journal.files)
    expect(final.steps).toHaveLength(13)
    expect(final.steps[0].status).toBe('findings')
    expect(final.steps[0].findings.map((x: { title: string }) => x.title)).toEqual(['retained finding'])
    expect(existsSync(join(root, 'selected-source'))).toBe(false)
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toBe('changed after original snapshot')
  } finally { store.close() }
})

test('interrupted E2E is not repeated while its code review remains resumable', async () => {
  const { job, state, store } = fixture()
  const controller = new AbortController(), calls: number[] = []
  const root = join(state, 'security-audits', job.id)
  try {
    await expect(executeSecurityAudit(job, { stateDir: state, model, signal: controller.signal, tool: async n => {
      calls.push(n)
      mkdirSync(join(root, 'stage-1'), { mode: 0o700 })
      controller.abort(); checkAuditInterrupted({ signal: controller.signal }); return result(n)
    } })).rejects.toBeInstanceOf(CodexInterruptedError)
    let modelCalls = 0
    await executeSecurityAudit(job, { stateDir: state, model: async prompt => { modelCalls++; return model(prompt) }, tool: async n => { calls.push(n); return result(n) } })
    expect(calls).toEqual([1, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(modelCalls).toBe(3)
    const journal = JSON.parse(readFileSync(join(root, 'journal.json'), 'utf8'))
    expect(journal.steps[0].note).toContain('not replayed')
    expect(journal.steps[0].status).toBe('interrupted')
  } finally { store.close() }
})

for (const interruptedStage of [2, 3, 4]) test(`code review ${interruptedStage} resumes instead of being skipped`, async () => {
  const { job, state, store } = fixture()
  const controller = new AbortController()
  let stage = 0, called = 0
  try {
    await expect(executeSecurityAudit(job, { stateDir: state, signal: controller.signal, progress: text => { stage = Number(text.split('/')[0]) }, tool: async n => result(n), model: async prompt => {
      if (stage === interruptedStage) { controller.abort(); throw new DOMException('interrupted', 'AbortError') }
      return model(prompt)
    } })).rejects.toBeInstanceOf(CodexInterruptedError)
    await executeSecurityAudit(job, { stateDir: state, tool: async n => result(n), model: async prompt => { called++; return model(prompt) } })
    expect(called).toBe(5 - interruptedStage)
    const journal = JSON.parse(readFileSync(join(state, 'security-audits', job.id, 'journal.json'), 'utf8'))
    expect(journal.steps).toHaveLength(13)
    expect(journal.steps[interruptedStage - 1].status).toBe('completed')
  } finally { store.close() }
})
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
      const script = `const fs=require('fs');console.log(JSON.stringify({writes:${JSON.stringify(paths)}.map(p=>{try{fs.writeFileSync(p,'tampered');return false}catch{return true}}),privateReadBlocked:(()=>{try{fs.readFileSync(${JSON.stringify(privatePath)});return false}catch{return true}})(),parentReadlink:(()=>{try{fs.readlinkSync(${JSON.stringify(state)});return 'symlink'}catch(e){return e.code}})()}))`
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
        parentReadlink: 'EINVAL',
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
