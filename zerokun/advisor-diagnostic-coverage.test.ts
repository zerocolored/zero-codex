import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { assertRequiredAdvisorRounds, collectHostAdvisorCoverage } from './codex-executor.ts'
import { observeNativeAdvisorCoverage } from './native-advisor-coverage.ts'
import { nativeAdvisorMarker } from './native-advisor-evidence.ts'
import { enforceHostAdvisorCoverage } from './job-runner.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'advisor-diagnostic-coverage-'))
  roots.push(state)
  const job = { id: 'diagnostic-coverage', writeEnabled: false }
  const nonce = 'a'.repeat(32)
  const digest = 'b'.repeat(64)
  const input = { revision: 1, digest }
  const root = join(state, 'advisor-journal', job.id, nonce, `revision-1-${digest.slice(0, 16)}`)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const journal = {
    version: 9, advisorPolicy: 'three-phase-specific-conditional-final-v2',
    status: 'completed', phase: 'investigation', round: 1,
    attemptNonce: nonce, contextDigest: digest, inputRevision: 1, inputDigest: digest,
    repositoryDigest: digest, repositoryDigestBefore: digest, repositoryDigestAfter: digest,
    brokerProcessId: 101, primaryEvidenceDigest: digest,
    startedAt: 1, finishedAt: 2, receiptIssuedAt: 3, pollObservedAt: 4, receiptDigest: digest,
    native: [{ attempted: true, adopted: true, perspective: 'solution',
      agentId: '/root/solution', responseDigest: digest, responseTransportDigest: digest,
      executionState: 'response-obtained' }],
    grok: [{ attempted: true, adopted: true, perspective: 'solution',
      processId: 102, containmentVerified: true, responseDigest: digest,
      executionState: 'response-obtained' }],
    claude: { attempted: true, required: true, lifecycle: 'ephemeral-v2', adopted: true,
      workspaceCreationAttempted: true, freshEphemeral: true, cleanupVerified: true,
      containmentVerified: true, promptMayHaveBeenDelivered: true,
      cleanupStatus: 'closed-and-verified', cleanupReceiptDigest: digest,
      responseDigest: digest, executionState: 'response-obtained' },
  }
  const journalPath = join(root, 'investigation-1.json')
  writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 })
  // Neither diagnostics nor future auxiliary files are round journals. Their
  // contents deliberately cannot be parsed, and the auxiliary link is dangling.
  for (const name of [`claude-response-${'c'.repeat(32)}.json`, 'future-runtime-note.json',
    'investigation-1.json.responses', 'investigation-1.json.slots']) {
    writeFileSync(join(root, name), 'opaque auxiliary data', { mode: 0o600 })
  }
  symlinkSync(join(root, 'does-not-exist'), join(root, 'z-auxiliary-link'))
  const rounds = () => assertRequiredAdvisorRounds(job, state, digest, nonce, input, digest, digest)
  const marker = nativeAdvisorMarker(nonce, 1, digest, 'investigation', 1, 'solution')
  const child = {
    id: 'solution-thread', parentThreadId: 'parent', cwd: state, agentRole: 'solution_analyst',
    source: { subAgent: { thread_spawn: {
      parent_thread_id: 'parent', agent_role: 'solution_analyst', agent_path: '/root/solution',
    } } },
    turns: [{ id: 'turn', status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: `Review.\n${marker}` }] },
      { type: 'agentMessage', phase: 'final_answer', text: `Independent answer.\n${marker}` },
    ] }],
  }
  const observe = (available: boolean) => observeNativeAdvisorCoverage({
    attemptNonce: nonce, parentThreadId: 'parent', repoPath: state,
    parentChildBaseline: [], rounds: rounds(),
    read: async method => !available ? undefined
      : method === 'thread/list' ? { data: [child], nextCursor: null } : { thread: child },
  })
  return { state, job, nonce, journal, journalPath, rounds, observe }
}

test('Claude診断ログが同居しても実回答観測からSlack最終報告まで3/3で通過する', async () => {
  const f = fixture()
  expect(f.rounds()).toHaveLength(1)
  const observations = await f.observe(true)
  expect(observations.map(value => value.state)).toEqual(['response-obtained'])
  const coverage = collectHostAdvisorCoverage(f.state, f.job.id, f.nonce, observations)
  expect(coverage?.phases[0]).toMatchObject({ total: 3, responsesObtained: 3, startUnconfirmed: 0 })
  const result = enforceHostAdvisorCoverage('設計確認の回答を取得しました。', coverage, 'result')
  expect(result).toContain('起動3/3・回答3/3')
  expect(result).not.toContain('GPT:')
  expect(result).not.toContain('未完了')
})

test('診断ログを無視しても未取得の実回答を成功に変えない', async () => {
  const f = fixture()
  const coverage = collectHostAdvisorCoverage(f.state, f.job.id, f.nonce, await f.observe(false))
  expect(coverage?.phases[0]).toMatchObject({ responsesObtained: 2, startUnconfirmed: 1 })
})

test('採択するround journal自体の別nonceやsymlinkは引き続き拒否する', () => {
  const f = fixture()
  writeFileSync(f.journalPath, JSON.stringify({ ...f.journal, attemptNonce: 'f'.repeat(32) }))
  expect(f.rounds).toThrow()
  rmSync(f.journalPath)
  symlinkSync(join(f.state, 'missing'), f.journalPath)
  expect(f.rounds).toThrow()
})
