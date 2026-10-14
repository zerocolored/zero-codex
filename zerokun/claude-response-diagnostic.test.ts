import { afterEach, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { ClaudeReadError, claudeReadCommandFailure, captureClaudeFailureDiagnostic, saveClaudeResponseDiagnostic, parseClaudeStartupDiagnostic, claudeStartupFailure, MAX_CLAUDE_DIAGNOSTIC_TRANSCRIPT_BYTES } from './claude-response-diagnostic.ts'
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

test('startup diagnostics survive cleanup without terminal text or arbitrary error content', () => {
  const code = parseClaudeStartupDiagnostic('other output\n' + JSON.stringify({
    status: 'ephemeral-claude-startup-failed', code: 'trust-confirmation-timeout',
  }))
  expect(code).toBe('trust-confirmation-timeout')
  expect(parseClaudeStartupDiagnostic(JSON.stringify({
    status: 'ephemeral-claude-startup-failed', code: 'arbitrary private error',
  }))).toBeUndefined()
  expect(parseClaudeStartupDiagnostic('null\n{}\nmalformed')).toBeUndefined()
  const options = fixture()
  const receipt = saveClaudeResponseDiagnostic({ ...options,
    failure: { stage: 'startup', cause: 'timeout', startupCode: code },
  })
  expect(receipt.status).toBe('saved')
  expect(JSON.parse(readFileSync(join(options.stateDir, receipt.path!), 'utf8'))).toMatchObject({
    failure: { stage: 'startup', cause: 'timeout', startupCode: 'trust-confirmation-timeout' },
    transcript: { available: false },
  })
})

test('起動準備の失敗箇所とsnapshot終了状態を秘密本文なしで保存する', () => {
  const options = fixture()
  const receipt = saveClaudeResponseDiagnostic({ ...options,
    failure: { stage: 'startup', cause: 'unknown', operation: 'request-directory' },
    snapshot: { outcome: 'command-failed', exitCode: 7, timedOut: false,
      forcedCleanup: false, outputTruncated: false },
  })
  expect(receipt.status).toBe('saved')
  expect(JSON.parse(readFileSync(join(options.stateDir, receipt.path!), 'utf8'))).toMatchObject({
    failure: { operation: 'request-directory' },
    snapshot: { outcome: 'command-failed', exitCode: 7 },
    transcript: { available: false, text: '' },
  })
})

test('parser reports missing boundaries while accepting complete responses with unfamiliar UI', () => {
  const envelope = [instruction, marker, '回答内容', marker, '❯'].join('\n')
  expect(analyzeClaudeResponse(envelope, marker)).toMatchObject({ code: 'complete', response: '回答内容', markerLines: [1, 3] })
  expect(analyzeClaudeResponse(envelope + '\nnew footer text', marker)).toMatchObject({ code: 'complete', response: '回答内容' })
  for (const [text, code] of [
    ['❯', 'marker-count-mismatch'],
    [[marker, '回答', marker].join('\n'), 'prompt-boundary-mismatch'],
    [[instruction, marker, marker].join('\n'), 'empty-response'],
  ]) {
    expect(analyzeClaudeResponse(text!, marker).code).toBe(code!)
    expect(extractCompleteClaudeResponse(text!, marker)).toBeNull()
  }
})

test.each([false, true])('instruction wrapping is independent of marker wrapping: %s', wrappedMarker => {
  const promptMarker = wrappedMarker ? marker.slice(0, -1) + '\n  ' + marker.slice(-1) : marker
  const transcript = [
    '❯ 接続テスト', '',
    '  応答の最後の独立行に、次のrequest',
    '  markerをそのまま記載してください。',
    '  ' + promptMarker, '', '⏺ 接続確認成功', '', '  ' + marker,
    '✻ Baked for 2s · done 17:21', '❯',
  ].join('\n')
  expect(analyzeClaudeResponse(transcript, marker)).toMatchObject({ code: 'complete', response: '⏺ 接続確認成功' })
  expect(analyzeClaudeResponse(transcript.replace('markerをそのまま', '別の指示をそのまま'), marker).code)
    .toBe('prompt-boundary-mismatch')
  expect(analyzeClaudeResponse(transcript.replace('  応答の最後の独立行に、次のrequest\n', ''), marker).code)
    .toBe('prompt-boundary-mismatch')
  expect(analyzeClaudeResponse(transcript + '\n' + marker, marker).code).toBe('marker-count-mismatch')
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
  expect(JSON.parse(content)).toMatchObject({ transcript: { text: transcript, truncated: false }, reads: [{ outcome: 'complete' }] })
  expect(lstatSync(path).mode & 0o777).toBe(0o600)
  expect(lstatSync(options.directory).mode & 0o777).toBe(0o700)
  expect(saveClaudeResponseDiagnostic({ ...options, transcript: 'later snapshot' }).path).toBe(receipt.path)
  expect(JSON.parse(readFileSync(path, 'utf8')).transcript.text).toBe('later snapshot')
})

test('preserves diagnostic content without credential or identifier rewriting', () => {
  const options = fixture()
  const transcript = 'view bearer vs callback\nhttps://example.test/report#' + 'a'.repeat(64)
    + '\nAuthorization: Bearer synthetic-example\nname@example.test /Users/example/project'
  const receipt = saveClaudeResponseDiagnostic({ ...options, transcript })
  expect(JSON.parse(readFileSync(join(options.stateDir, receipt.path!), 'utf8')).transcript)
    .toMatchObject({ text: transcript, credentialSuppressed: false, sanitized: false })
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

test.each(['before-state', 'transcript', 'after-state'] as const)('capture retains the failing stage %s without raw exception text', async stage => {
  let calls = 0
  const result = await captureClaudeFailureDiagnostic({
    getState: async () => {
      calls++
      if ((calls === 1 && stage === 'before-state') || (calls === 2 && stage === 'after-state')) throw new Error('private exception')
      return { agent_status: 'blocked' }
    },
    readTranscript: async () => { if (stage === 'transcript') throw new Error('private exception'); return 'owned output' },
    matchesIdentity: () => true,
  })
  expect(result.read.failure).toEqual({ stage, kind: 'exception' })
  expect(result.transcript).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('private exception')
})

test('command failures retain only fixed codes and transport metadata', async () => {
  for (const code of ['agent_not_idle', 'private arbitrary server detail']) {
    const diagnostic = claudeReadCommandFailure({ exitCode: 1, timedOut: true, forcedCleanup: true, outputTruncated: true,
      stdout: '', stderr: JSON.stringify({ error: { code, message: 'private stderr detail' } }) })
    const result = await captureClaudeFailureDiagnostic({
      getState: async () => ({ agent_status: 'blocked' }),
      readTranscript: async () => { throw new ClaudeReadError(diagnostic) }, matchesIdentity: () => true,
    })
    expect(result.read.failure).toEqual({ stage: 'transcript', kind: 'command', exitCode: 1,
      timedOut: true, forcedCleanup: true, outputTruncated: true, code: code === 'agent_not_idle' ? code : 'unknown-error' })
    expect(JSON.stringify(result)).not.toContain('private')
  }
})


test('startup UI categories preserve actual unavailability without publishing screen content', () => {
  for (const [code, cause] of [['authentication-ui', 'authentication'], ['rate-limit-ui', 'rate-limit'], ['billing-ui', 'billing']] as const) {
    const parsed = parseClaudeStartupDiagnostic(JSON.stringify({ status: 'ephemeral-claude-startup-failed', code }))
    expect(claudeStartupFailure(parsed)).toEqual({ advisor: 'claude', cause })
  }
  expect(claudeStartupFailure('prohibited-ui')).toBeUndefined()
  expect(claudeStartupFailure(undefined)).toBeUndefined()
  expect(parseClaudeStartupDiagnostic(JSON.stringify({status: 'ephemeral-claude-startup-failed', code: 'private arbitrary UI'}))).toBeUndefined()
})
