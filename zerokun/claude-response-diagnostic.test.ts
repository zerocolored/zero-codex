import { afterEach, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { captureClaudeFailureDiagnostic, saveClaudeResponseDiagnostic, MAX_CLAUDE_DIAGNOSTIC_TRANSCRIPT_BYTES } from './claude-response-diagnostic.ts'
import { analyzeClaudeResponse, extractCompleteClaudeResponse, AdvisorOwnedProcessStillLiveError } from './advisor-broker.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'claude-diagnostic-test-'))
  roots.push(stateDir)
  chmodSync(stateDir, 0o700)
  return { stateDir, directory: join(stateDir, 'journal', 'revision'), attempt: 'a'.repeat(32), reads: [] }
}
const marker = 'REQUEST_MARKER=0123456789ABCDEF0123456789ABCDEF'
const instruction = '応答の最後の独立行に、次のrequest markerをそのまま記載してください。'

test('parser identifies the failed boundary without changing acceptance', () => {
  const envelope = [instruction, marker, '回答内容', marker, '❯'].join('\n')
  expect(analyzeClaudeResponse(envelope, marker)).toMatchObject({ code: 'complete', response: '回答内容', markerLines: [1, 3] })
  for (const [text, code] of [
    ['❯', 'marker-count-mismatch'],
    [[marker, '回答', marker].join('\n'), 'prompt-boundary-mismatch'],
    [[instruction, marker, marker].join('\n'), 'empty-response'],
    [envelope + '\nnew footer text', 'unexpected-trailing-content'],
  ]) {
    expect(analyzeClaudeResponse(text!, marker).code).toBe(code!)
    expect(extractCompleteClaudeResponse(text!, marker)).toBeNull()
  }
})

test('stores terminal content privately with a verifiable receipt, replacing the same attempt', () => {
  const options = fixture()
  const transcript = [instruction, marker, '実際の回答です。', marker, 'unknown footer'].join('\n')
  const { response: _, ...analysis } = analyzeClaudeResponse(transcript, marker)
  const receipt = saveClaudeResponseDiagnostic({ ...options, transcript, reads: [{
    requestedLines: 1200, observedAt: new Date().toISOString(), stateBefore: { status: 'done', sequence: 3 },
    stateAfter: { status: 'done', sequence: 3 }, outcome: analysis.code, analysis,
  }] })
  expect(receipt.status).toBe('saved')
  const path = join(options.stateDir, receipt.path!)
  const content = readFileSync(path, 'utf8')
  expect(createHash('sha256').update(content).digest('hex')).toBe(receipt.sha256!)
  expect(JSON.parse(content)).toMatchObject({ transcript: { text: transcript, truncated: false }, reads: [{ outcome: 'unexpected-trailing-content' }] })
  expect(lstatSync(path).mode & 0o777).toBe(0o600)
  expect(lstatSync(options.directory).mode & 0o777).toBe(0o700)
  expect(saveClaudeResponseDiagnostic({ ...options, transcript: 'later snapshot' }).path).toBe(receipt.path)
  expect(JSON.parse(readFileSync(path, 'utf8')).transcript.text).toBe('later snapshot')
})

test('suppresses credential-bearing output before truncation and redacts common identifying text', () => {
  const options = fixture()
  for (const secret of ['xoxb-' + 'a'.repeat(30), '-----BEGIN PRIVATE KEY-----\nprivate-body\n-----END PRIVATE KEY-----']) {
    const receipt = saveClaudeResponseDiagnostic({ ...options, transcript: 'あ'.repeat(40000) + secret })
    const content = readFileSync(join(options.stateDir, receipt.path!), 'utf8')
    expect(content).not.toContain(secret)
    expect(content).not.toContain('private-body')
    expect(JSON.parse(content).transcript.credentialSuppressed).toBe(true)
  }
  const receipt = saveClaudeResponseDiagnostic({ ...options, transcript: 'https://example.invalid/?key=abc name@example.invalid /Users/someone/project' })
  const text = JSON.parse(readFileSync(join(options.stateDir, receipt.path!), 'utf8')).transcript.text
  expect(text).toBe('[url redacted] [email redacted] /[user]/project')
})

test('bounds multibyte evidence preserving both ends, and distinguishes absent output', () => {
  const options = fixture()
  const receipt = saveClaudeResponseDiagnostic({ ...options, transcript: 'START' + 'あ'.repeat(70000) + 'END' })
  const saved = JSON.parse(readFileSync(join(options.stateDir, receipt.path!), 'utf8')).transcript
  expect(saved.truncated).toBe(true)
  expect(saved.storedBytes).toBeLessThanOrEqual(MAX_CLAUDE_DIAGNOSTIC_TRANSCRIPT_BYTES)
  expect(saved.text.startsWith('START')).toBe(true)
  expect(saved.text.endsWith('END')).toBe(true)
  const absent = saveClaudeResponseDiagnostic(options)
  expect(JSON.parse(readFileSync(join(options.stateDir, absent.path!), 'utf8')).transcript.available).toBe(false)
})

test('unsafe or unwritable storage is a fixed nonthrowing failure', () => {
  const options = fixture()
  symlinkSync(tmpdir(), join(options.stateDir, 'journal'))
  expect(saveClaudeResponseDiagnostic({ ...options, transcript: 'evidence' })).toEqual({ status: 'unavailable' })
  expect(saveClaudeResponseDiagnostic({ ...options, attempt: '../escape' })).toEqual({ status: 'unavailable' })
  rmSync(join(options.stateDir, 'journal'))
  saveClaudeResponseDiagnostic(options)
  chmodSync(options.directory, 0o755)
  expect(saveClaudeResponseDiagnostic(options)).toEqual({ status: 'unavailable' })
})

test.each(['blocked', 'unknown', 'working'])('failed %s turn captures its owned screen without a completed answer', async status => {
  const snapshot = await captureClaudeFailureDiagnostic({
    getState: async () => ({ agent_status: status, state_change_seq: 1, owned: true }),
    readTranscript: async () => 'synthetic failure screen',
    matchesIdentity: state => state.owned,
  })
  expect(snapshot).toMatchObject({ transcript: 'synthetic failure screen', read: { outcome: 'failure-snapshot', stateBefore: { status } } })
  const options = fixture()
  const receipt = saveClaudeResponseDiagnostic({ ...options, reads: [snapshot.read], transcript: snapshot.transcript, transcriptReadIndex: 0 })
  expect(receipt.status).toBe('saved')
  expect(JSON.parse(readFileSync(join(options.stateDir, receipt.path!), 'utf8')).transcript.readIndex).toBe(0)
})

test('failure capture discards foreign output and records transport failure without throwing', async () => {
  let gets = 0
  const foreign = await captureClaudeFailureDiagnostic({
    getState: async () => ({ agent_status: 'unknown', owned: ++gets === 1 }),
    readTranscript: async () => 'must not persist', matchesIdentity: state => state.owned,
  })
  expect(foreign.read.outcome).toBe('identity-changed')
  expect(foreign.transcript).toBeUndefined()
  const failed = await captureClaudeFailureDiagnostic({
    getState: async () => ({ agent_status: 'blocked' }),
    readTranscript: async () => { throw new Error('sensitive transport error') }, matchesIdentity: () => true,
  })
  expect(failed.read.outcome).toBe('read-failed')
  expect(JSON.stringify(failed)).not.toContain('sensitive')
})

test('failure capture preserves owned-process containment evidence while allowing cleanup', async () => {
  const error = new AdvisorOwnedProcessStillLiveError('synthetic diagnostic subprocess still live')
  let containmentFailure: unknown
  let cleanupReached = false
  const result = await captureClaudeFailureDiagnostic({
    getState: async () => { throw error },
    readTranscript: async () => 'unused', matchesIdentity: () => true,
    onError: observed => { containmentFailure = observed },
  }).finally(() => { cleanupReached = true })
  expect(containmentFailure).toBe(error)
  expect(cleanupReached).toBe(true)
  expect(result.read.outcome).toBe('read-failed')
  expect(JSON.stringify(result)).not.toContain(error.message)
})
