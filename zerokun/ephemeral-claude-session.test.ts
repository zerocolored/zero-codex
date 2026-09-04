import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'crypto'
import * as fs from 'fs'
import {
  chmodSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { HerdrRuntimeIdentity } from './herdr-runtime.ts'
import {
  EPHEMERAL_CLAUDE_CLOSED_RECEIPT,
  EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE,
  EPHEMERAL_CLAUDE_STATE_ROOT,
  EPHEMERAL_CLAUDE_TRASH_ROOT,
  EphemeralClaudeCleanupPendingError,
  EphemeralClaudeOwnedProcessStillLiveError,
  createEphemeralClaudeRequestDirectory,
  ephemeralClaudeAgentMatches,
  parseEphemeralClaudeClose,
  parseEphemeralClaudeOpen,
  parseEphemeralClaudeProvisionalRecovery,
  parseEphemeralClaudeDeliveryEvidence,
  persistEphemeralClaudeDeliveryEvidence,
  readEphemeralClaudeCleanupReceipt,
  readEphemeralClaudeProvisionalCleanupReceipt,
  readEphemeralClaudeWorkspaceTarget,
  reconcileEphemeralClaudeSessions,
  removeVerifiedEphemeralClaudeRequestDirectory,
  resolveClaudeExecutableLookup,
  type EphemeralClaudeTarget,
} from './ephemeral-claude-session.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixtureState(): string {
  const root = mkdtempSync(join(tmpdir(), 'zerochan-ephemeral-claude-'))
  directories.push(root)
  chmodSync(root, 0o700)
  const state = join(root, 'state')
  mkdirSync(state, { mode: 0o700 })
  return state
}

const lifecycleNonce = '0123456789abcdefabcd0123456789ab'
const target: EphemeralClaudeTarget = {
  target: `fifth-${lifecycleNonce.slice(0, 20)}`,
  workspaceId: 'wABC',
  paneId: 'wABC:p1',
  terminalId: 'term_012345abcdef',
  nativeSession: 'native-session-1',
  stateChangeSeq: 7,
}

const runtime: HerdrRuntimeIdentity = {
  binary: '/usr/local/bin/herdr',
  binaryDevice: 1,
  binaryInode: 2,
  binaryMode: 0o100700,
  binarySize: 3,
  binaryModifiedMs: 4,
  binaryChangedMs: 5,
  socketPath: '/tmp/herdr.sock',
  socketDevice: 6,
  socketInode: 7,
  paneId: 'wCALLER:p1',
  tabId: 'wCALLER:t1',
  terminalId: 'term_cabbe123456',
  workspaceId: 'wCALLER',
}

function request(state: string, overrides: Partial<Parameters<
  typeof createEphemeralClaudeRequestDirectory
>[0]> = {}): string {
  return createEphemeralClaudeRequestDirectory({
    stateDir: state,
    jobId: 'job-123',
    attemptNonce: 'a'.repeat(32),
    inputRevision: 1,
    inputDigest: 'b'.repeat(64),
    phase: 'investigation',
    round: 1,
    ...overrides,
  })
}

function privateFile(path: string, content: string): void {
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 })
}

function workspaceReceipt(projectRoot: string): Record<string, unknown> {
  return {
    version: 2,
    nonce: lifecycleNonce,
    label: `fifth-advisor-${lifecycleNonce}`,
    project_root_dev: 101,
    project_root_ino: 202,
    project_root: projectRoot,
    agent_name: target.target,
    workspace_id: target.workspaceId,
    tab_id: 'wABC:t1',
    pane_id: target.paneId,
    terminal_id: target.terminalId,
  }
}

function cleanupReceipt(): Record<string, unknown> {
  return {
    version: 2,
    nonce: lifecycleNonce,
    status: 'closed-and-verified',
    workspace_id: target.workspaceId,
    pane_id: target.paneId,
    agent_name: target.target,
    close_target_verified: true,
    workspace_absent: true,
    pane_absent: true,
    agent_absent: true,
    caller_restored: false,
    focus_before: 'foreign',
    focus_immediately_before: 'foreign',
    focus_verified: false,
    catalog_restored: false,
    agent_identity_verified: true,
    project_location_verified: false,
    protected_unchanged: false,
    processes_exited: true,
    process_ids: [123, 124],
    process_group_id: 123,
    process_group_ids: [123],
  }
}

function intentReceipt(projectRoot: string): Record<string, unknown> {
  return {
    version: 2,
    nonce: lifecycleNonce,
    label: `fifth-advisor-${lifecycleNonce}`,
    agent_name: target.target,
    project_root: projectRoot,
    project_root_dev: 101,
    project_root_ino: 202,
    caller: {
      workspace_id: 'wCALLER',
      pane_id: 'wCALLER:p1',
      terminal_id: 'term_cabbe123456',
    },
    baseline_workspace_ids: ['wCALLER'],
  }
}

function writeLifecycleRecords(requestDir: string, projectRoot: string, closed: boolean): string {
  privateFile(join(requestDir, 'ephemeral-session-intent.json'), `${JSON.stringify(
    intentReceipt(projectRoot),
  )}\n`)
  privateFile(join(requestDir, 'ephemeral-workspace-receipt.json'), `${JSON.stringify(
    workspaceReceipt(projectRoot),
  )}\n`)
  if (!closed) return ''
  const raw = `${JSON.stringify(cleanupReceipt())}\n`
  privateFile(join(requestDir, EPHEMERAL_CLAUDE_CLOSED_RECEIPT), raw)
  return raw
}

describe('ephemeral Claude lifecycle state', () => {
  test('sanitized PATHでもaccount HOMEのClaude lookupを安全に解決する', () => {
    const home = mkdtempSync(join(tmpdir(), 'zerochan-claude-home-'))
    directories.push(home)
    chmodSync(home, 0o700)
    mkdirSync(join(home, '.local'), { mode: 0o700 })
    mkdirSync(join(home, '.local', 'bin'), { mode: 0o700 })
    const claude = join(home, '.local', 'bin', 'claude')
    writeFileSync(claude, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const which = spyOn(Bun, 'which').mockReturnValue(null)
    try {
      expect(resolveClaudeExecutableLookup({ homeDirectory: home })).toBe(claude)
    } finally {
      which.mockRestore()
    }
  })

  test('helper open/closeはexactなfresh workspace identityだけを受理する', () => {
    const opened = parseEphemeralClaudeOpen(`${JSON.stringify({
      status: 'ephemeral-claude-ready',
      target: target.target,
      workspace_id: target.workspaceId,
      pane_id: target.paneId,
      terminal_id: target.terminalId,
      native_session: target.nativeSession,
      state_change_seq: target.stateChangeSeq,
    })}\n`)
    expect(opened).toEqual(target)
    expect(() => parseEphemeralClaudeOpen([
      JSON.stringify({ status: 'ephemeral-claude-ready' }),
      JSON.stringify({ status: 'ephemeral-claude-ready' }),
    ].join('\n'))).toThrow()
    expect(() => parseEphemeralClaudeOpen(JSON.stringify({
      status: 'ephemeral-claude-ready',
      target: target.target,
      workspace_id: target.workspaceId,
      pane_id: target.paneId,
      terminal_id: target.terminalId,
      native_session: target.nativeSession,
      state_change_seq: -1,
    }))).toThrow()

    expect(() => parseEphemeralClaudeClose(JSON.stringify({
      status: 'ephemeral-workspace-closed',
      workspace_id: target.workspaceId,
      pane_id: target.paneId,
      agent_name: target.target,
    }), target)).not.toThrow()
    expect(() => parseEphemeralClaudeClose(JSON.stringify({
      status: 'ephemeral-workspace-closed',
      workspace_id: 'wFOREIGN',
      pane_id: target.paneId,
      agent_name: target.target,
    }), target)).toThrow()
  })

  test('safe-modeを含むsame occupantだけを追跡する', () => {
    const agent = {
      agent: 'claude',
      agent_session: { value: target.nativeSession },
      cwd: '/repo',
      pane_id: target.paneId,
      terminal_id: target.terminalId,
      workspace_id: target.workspaceId,
      state_change_seq: 8,
    }
    expect(ephemeralClaudeAgentMatches(agent, target, '/repo')).toBe(true)
    expect(ephemeralClaudeAgentMatches({ ...agent, pane_id: 'wABC:p2' }, target, '/repo'))
      .toBe(false)
    expect(ephemeralClaudeAgentMatches({ ...agent, cwd: '/foreign' }, target, '/repo'))
      .toBe(false)
    expect(ephemeralClaudeAgentMatches({ ...agent, agent_session: null }, {
      ...target, nativeSession: 'N/A:safe-mode',
    }, '/repo')).toBe(true)
  })

  test('workspaceとclosed receiptはproject/identity/exact absenceを固定する', () => {
    const state = fixtureState()
    const requestDir = request(state)
    const projectRoot = dirname(state)
    const raw = writeLifecycleRecords(requestDir, projectRoot, true)
    expect(readEphemeralClaudeWorkspaceTarget(requestDir, projectRoot)).toEqual({
      ...target,
      nativeSession: 'N/A:safe-mode',
      stateChangeSeq: 0,
    })
    expect(readEphemeralClaudeCleanupReceipt(requestDir, {
      ...target, nativeSession: 'N/A:safe-mode', stateChangeSeq: 0,
    })).toEqual({
      status: 'closed-and-verified',
      digest: createHash('sha256').update(raw).digest('hex'),
    })
    expect(() => readEphemeralClaudeWorkspaceTarget(requestDir, '/different')).toThrow()
    writeFileSync(join(requestDir, EPHEMERAL_CLAUDE_CLOSED_RECEIPT), `${JSON.stringify({
      ...cleanupReceipt(), processes_exited: false,
    })}\n`, { mode: 0o600 })
    expect(() => readEphemeralClaudeCleanupReceipt(requestDir, target)).toThrow()
  })

  test('request bindingはowner-onlyで一意、unsafe pathは拒否する', () => {
    const state = fixtureState()
    const requestDir = request(state)
    expect(lstatSync(requestDir).mode & 0o777).toBe(0o700)
    expect(() => request(state)).toThrow(EphemeralClaudeCleanupPendingError)
    expect(() => request(state, { jobId: 'bad/job' })).toThrow()
    expect(() => request(state, { attemptNonce: 'x' })).toThrow()
    expect(() => request(state, { inputDigest: 'x' })).toThrow()
  })

  test('send receiptはintentに結び付けてdurable journalへ冪等保存する', () => {
    const state = fixtureState()
    const projectRoot = dirname(state)
    const delivered = request(state)
    privateFile(join(delivered, 'ephemeral-session-intent.json'), `${JSON.stringify(
      intentReceipt(projectRoot),
    )}\n`)
    privateFile(join(delivered, 'ephemeral-send-receipt.json'), `${JSON.stringify({
      version: 2,
      nonce: lifecycleNonce,
      target: target.target,
      marker: `REQUEST_MARKER=${'A'.repeat(32)}`,
      status: 'delivery-possible',
    })}\n`)
    persistEphemeralClaudeDeliveryEvidence(state, delivered)
    persistEphemeralClaudeDeliveryEvidence(state, delivered)
    const evidencePath = join(
      state, 'advisor-journal', 'job-123', 'a'.repeat(32),
      EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE,
    )
    const firstEvidence = readFileSync(evidencePath, 'utf8')
    const firstEvidenceMetadata = lstatSync(evidencePath)
    expect(readdirSync(dirname(evidencePath))).toEqual([
      EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE,
    ])

    const laterRound = request(state, { phase: 'design' })
    privateFile(join(laterRound, 'ephemeral-session-intent.json'), `${JSON.stringify(
      intentReceipt(projectRoot),
    )}\n`)
    privateFile(join(laterRound, 'ephemeral-send-receipt.json'), `${JSON.stringify({
      version: 2,
      nonce: lifecycleNonce,
      target: target.target,
      marker: `REQUEST_MARKER=${'B'.repeat(32)}`,
      status: 'delivery-possible',
    })}\n`)
    persistEphemeralClaudeDeliveryEvidence(state, laterRound)
    expect(readFileSync(evidencePath, 'utf8')).toBe(firstEvidence)
    expect(lstatSync(evidencePath).ino).toBe(firstEvidenceMetadata.ino)

    const invalid = request(state, { jobId: 'job-invalid' })
    privateFile(join(invalid, 'ephemeral-session-intent.json'), `${JSON.stringify(
      intentReceipt(projectRoot),
    )}\n`)
    privateFile(join(invalid, 'ephemeral-send-receipt.json'), `${JSON.stringify({
      version: 2,
      nonce: 'f'.repeat(32),
      target: target.target,
      marker: `REQUEST_MARKER=${'A'.repeat(32)}`,
      status: 'delivery-possible',
    })}\n`)
    expect(() => persistEphemeralClaudeDeliveryEvidence(state, invalid))
      .toThrow(EphemeralClaudeCleanupPendingError)
  })

  test('初回file fsync失敗後のretryは既存latchのfileと親directoryを再同期する', () => {
    const state = fixtureState()
    const projectRoot = dirname(state)
    const requestDir = request(state, { jobId: 'job-file-sync-retry' })
    privateFile(join(requestDir, 'ephemeral-session-intent.json'), `${JSON.stringify(
      intentReceipt(projectRoot),
    )}\n`)
    privateFile(join(requestDir, 'ephemeral-send-receipt.json'), `${JSON.stringify({
      version: 2,
      nonce: lifecycleNonce,
      target: target.target,
      marker: `REQUEST_MARKER=${'D'.repeat(32)}`,
      status: 'delivery-possible',
    })}\n`)
    const evidencePath = join(
      state, 'advisor-journal', 'job-file-sync-retry', 'a'.repeat(32),
      EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE,
    )
    const original = fs.fsyncSync
    let failed = false
    const firstSync = spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      if (!failed && fstatSync(descriptor).isFile()) {
        failed = true
        throw new Error('injected file fsync failure')
      }
      original(descriptor)
    })
    try {
      expect(() => persistEphemeralClaudeDeliveryEvidence(state, requestDir))
        .toThrow(EphemeralClaudeCleanupPendingError)
    } finally {
      firstSync.mockRestore()
    }
    expect(failed).toBe(true)
    expect(existsSync(evidencePath)).toBe(true)
    expect(existsSync(requestDir)).toBe(true)

    let fileSyncs = 0
    let directorySyncs = 0
    const retrySync = spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      const metadata = fstatSync(descriptor)
      if (metadata.isFile()) fileSyncs += 1
      if (metadata.isDirectory()) directorySyncs += 1
      original(descriptor)
    })
    try {
      persistEphemeralClaudeDeliveryEvidence(state, requestDir)
    } finally {
      retrySync.mockRestore()
    }
    expect(fileSyncs).toBeGreaterThanOrEqual(1)
    expect(directorySyncs).toBeGreaterThanOrEqual(1)
    expect(parseEphemeralClaudeDeliveryEvidence(
      readFileSync(evidencePath, 'utf8'), 'job-file-sync-retry', 'a'.repeat(32),
    ).status).toBe('delivery-possible')
  })

  test('初回parent fsync失敗後のretryは既存latchをdurableにする', () => {
    const state = fixtureState()
    const projectRoot = dirname(state)
    const requestDir = request(state, { jobId: 'job-parent-sync-retry' })
    privateFile(join(requestDir, 'ephemeral-session-intent.json'), `${JSON.stringify(
      intentReceipt(projectRoot),
    )}\n`)
    privateFile(join(requestDir, 'ephemeral-send-receipt.json'), `${JSON.stringify({
      version: 2,
      nonce: lifecycleNonce,
      target: target.target,
      marker: `REQUEST_MARKER=${'E'.repeat(32)}`,
      status: 'delivery-possible',
    })}\n`)
    const original = fs.fsyncSync
    let fileWasSynchronized = false
    let failed = false
    const firstSync = spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      const metadata = fstatSync(descriptor)
      if (metadata.isFile()) fileWasSynchronized = true
      if (fileWasSynchronized && metadata.isDirectory() && !failed) {
        failed = true
        throw new Error('injected parent fsync failure')
      }
      original(descriptor)
    })
    try {
      expect(() => persistEphemeralClaudeDeliveryEvidence(state, requestDir))
        .toThrow(EphemeralClaudeCleanupPendingError)
    } finally {
      firstSync.mockRestore()
    }
    expect(failed).toBe(true)
    expect(existsSync(requestDir)).toBe(true)
    expect(() => persistEphemeralClaudeDeliveryEvidence(state, requestDir)).not.toThrow()
  })

  test('既存valid latchでも非private attempt rootは保持してfail closedにする', () => {
    const state = fixtureState()
    const projectRoot = dirname(state)
    const first = request(state, { jobId: 'job-unsafe-attempt-root' })
    privateFile(join(first, 'ephemeral-session-intent.json'), `${JSON.stringify(
      intentReceipt(projectRoot),
    )}\n`)
    privateFile(join(first, 'ephemeral-send-receipt.json'), `${JSON.stringify({
      version: 2,
      nonce: lifecycleNonce,
      target: target.target,
      marker: `REQUEST_MARKER=${'F'.repeat(32)}`,
      status: 'delivery-possible',
    })}\n`)
    persistEphemeralClaudeDeliveryEvidence(state, first)
    const evidencePath = join(
      state, 'advisor-journal', 'job-unsafe-attempt-root', 'a'.repeat(32),
      EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE,
    )
    const before = lstatSync(evidencePath)
    chmodSync(dirname(evidencePath), 0o755)

    const retry = request(state, { jobId: 'job-unsafe-attempt-root', phase: 'design' })
    privateFile(join(retry, 'ephemeral-session-intent.json'), `${JSON.stringify(
      intentReceipt(projectRoot),
    )}\n`)
    privateFile(join(retry, 'ephemeral-send-receipt.json'), `${JSON.stringify({
      version: 2,
      nonce: lifecycleNonce,
      target: target.target,
      marker: `REQUEST_MARKER=${'0'.repeat(32)}`,
      status: 'delivery-possible',
    })}\n`)
    expect(() => persistEphemeralClaudeDeliveryEvidence(state, retry))
      .toThrow(EphemeralClaudeCleanupPendingError)
    expect(lstatSync(evidencePath).ino).toBe(before.ino)
    expect(existsSync(retry)).toBe(true)
    chmodSync(dirname(evidencePath), 0o700)
  })

  test('既存のinvalid delivery latchは上書き修復せずrequestを保持する', () => {
    const state = fixtureState()
    const projectRoot = dirname(state)
    const requestDir = request(state, { jobId: 'job-conflict' })
    privateFile(join(requestDir, 'ephemeral-session-intent.json'), `${JSON.stringify(
      intentReceipt(projectRoot),
    )}\n`)
    privateFile(join(requestDir, 'ephemeral-send-receipt.json'), `${JSON.stringify({
      version: 2,
      nonce: lifecycleNonce,
      target: target.target,
      marker: `REQUEST_MARKER=${'C'.repeat(32)}`,
      status: 'delivery-possible',
    })}\n`)
    const evidencePath = join(
      state, 'advisor-journal', 'job-conflict', 'a'.repeat(32),
      EPHEMERAL_CLAUDE_DELIVERY_EVIDENCE,
    )
    mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o700 })
    privateFile(evidencePath, 'invalid')
    const before = lstatSync(evidencePath)
    expect(() => persistEphemeralClaudeDeliveryEvidence(state, requestDir))
      .toThrow(EphemeralClaudeCleanupPendingError)
    expect(readFileSync(evidencePath, 'utf8')).toBe('invalid')
    expect(lstatSync(evidencePath).ino).toBe(before.ino)
    expect(existsSync(requestDir)).toBe(true)
  })

  test('delivery evidence parserはexact canonical v1 bindingだけを受理する', () => {
    const jobId = 'job-123'
    const attemptNonce = 'a'.repeat(32)
    const valid = {
      version: 1,
      status: 'delivery-possible',
      jobId,
      attemptNonce,
      receiptDigest: 'b'.repeat(64),
    } as const
    const canonical = `${JSON.stringify(valid)}\n`
    expect(parseEphemeralClaudeDeliveryEvidence(canonical, jobId, attemptNonce)).toEqual(valid)

    const invalid = [
      JSON.stringify(valid),
      `${JSON.stringify({ ...valid, extra: true })}\n`,
      `${JSON.stringify({ ...valid, version: '1' })}\n`,
      `${JSON.stringify({ ...valid, status: 'delivered' })}\n`,
      `${JSON.stringify({ ...valid, jobId: 'other-job' })}\n`,
      `${JSON.stringify({ ...valid, attemptNonce: 'c'.repeat(32) })}\n`,
      `${JSON.stringify({ ...valid, receiptDigest: 'B'.repeat(64) })}\n`,
      `${JSON.stringify(valid, null, 2)}\n`,
      `{"version":2,"version":1,"status":"delivery-possible","jobId":"${jobId}",`
        + `"attemptNonce":"${attemptNonce}","receiptDigest":"${'b'.repeat(64)}"}\n`,
      'x'.repeat(4 * 1024 + 1),
    ]
    for (const raw of invalid) {
      expect(() => parseEphemeralClaudeDeliveryEvidence(raw, jobId, attemptNonce)).toThrow()
    }
  })

  test('verified requestはatomic tombstone経由で消し、unexpected/symlink/hardlinkを保持する', () => {
    const state = fixtureState()
    const clean = request(state)
    privateFile(join(clean, 'prompt'), 'read only\n')
    removeVerifiedEphemeralClaudeRequestDirectory(state, clean)
    expect(existsSync(clean)).toBe(false)
    expect(existsSync(join(state, EPHEMERAL_CLAUDE_TRASH_ROOT))).toBe(false)

    const unexpected = request(state, { round: 2 })
    privateFile(join(unexpected, 'unexpected'), 'no')
    expect(() => removeVerifiedEphemeralClaudeRequestDirectory(state, unexpected))
      .toThrow(EphemeralClaudeCleanupPendingError)
    expect(existsSync(unexpected)).toBe(true)

    const linked = request(state, { round: 3 })
    const outside = join(dirname(state), 'outside')
    privateFile(outside, 'outside')
    symlinkSync(outside, join(linked, 'prompt'))
    expect(() => removeVerifiedEphemeralClaudeRequestDirectory(state, linked)).toThrow()
    unlinkForTest(join(linked, 'prompt'))
    privateFile(join(linked, 'prompt'), 'linked')
    linkSync(join(linked, 'prompt'), join(dirname(state), 'hardlink'))
    expect(() => removeVerifiedEphemeralClaudeRequestDirectory(state, linked)).toThrow()
    expect(existsSync(linked)).toBe(true)
  })

  test('startup reconcileはpre-openとclosed tombstoneをhelperなしで回収する', async () => {
    const state = fixtureState()
    const unopened = request(state)
    const trash = join(state, EPHEMERAL_CLAUDE_TRASH_ROOT, `closed-${'c'.repeat(32)}`)
    mkdirSync(trash, { recursive: true, mode: 0o700 })
    privateFile(join(trash, 'prompt'), 'partial purge\n')
    const result = await reconcileEphemeralClaudeSessions({ stateDir: state, runtime }, {
      resolveHelper: () => { throw new Error('helper must not be resolved') },
      resolveClaudeLookup: () => { throw new Error('Claude must not be resolved') },
      verifyRuntime: async () => { throw new Error('runtime must not be checked') },
    })
    expect(result).toEqual({ closed: 0, discardedBeforeOpen: 1 })
    expect(existsSync(unopened)).toBe(false)
    expect(existsSync(join(state, EPHEMERAL_CLAUDE_TRASH_ROOT))).toBe(false)
  })

  test('途中publicationのowner-only stagingだけを捨ててFIFO復旧を続ける', async () => {
    const state = fixtureState()
    const safe = request(state)
    const stagedName = '.ephemeral-session-intent.json.pending'
    privateFile(join(safe, stagedName), '{"partial":')
    const recovered = await reconcileEphemeralClaudeSessions({ stateDir: state, runtime }, {
      resolveHelper: () => { throw new Error('helper must not be resolved') },
      resolveClaudeLookup: () => { throw new Error('Claude must not be resolved') },
      verifyRuntime: async () => { throw new Error('runtime must not be checked') },
    })
    expect(recovered).toEqual({ closed: 0, discardedBeforeOpen: 1 })
    expect(existsSync(safe)).toBe(false)

    const unsafe = request(state, { round: 2 })
    const outside = join(dirname(state), 'unsafe-stage')
    privateFile(outside, 'do not delete')
    symlinkSync(outside, join(unsafe, stagedName))
    await expect(reconcileEphemeralClaudeSessions({ stateDir: state, runtime }, {
      resolveHelper: () => { throw new Error('helper must not be resolved') },
      resolveClaudeLookup: () => { throw new Error('Claude must not be resolved') },
      verifyRuntime: async () => { throw new Error('runtime must not be checked') },
    })).rejects.toThrow(EphemeralClaudeCleanupPendingError)
    expect(existsSync(unsafe)).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('do not delete')
  })

  test('closed receiptもlive absenceを再close確認し、workspace receiptだけならexact closeする', async () => {
    const state = fixtureState()
    const projectRoot = dirname(state)
    const closed = request(state)
    writeLifecycleRecords(closed, projectRoot, true)
    const closePending = request(state, { phase: 'design' })
    writeLifecycleRecords(closePending, projectRoot, false)
    privateFile(join(closePending, 'ephemeral-send-receipt.json'), `${JSON.stringify({
      version: 2,
      nonce: lifecycleNonce,
      target: target.target,
      marker: `REQUEST_MARKER=${'A'.repeat(32)}`,
      status: 'delivery-possible',
    })}\n`)
    const commands: string[] = []
    let runtimeChecks = 0
    const result = await reconcileEphemeralClaudeSessions({ stateDir: state, runtime }, {
      resolveHelper: () => '/fixture/helper',
      resolveClaudeLookup: () => '/usr/local/bin/claude',
      verifyRuntime: async () => { runtimeChecks += 1 },
      runHelper: async (_helper, command, _projectRoot, requestDir) => {
        commands.push(`${command}:${requestDir.endsWith('design-1') ? 'design' : 'investigation'}`)
        if (command === 'close') {
          const alreadyClosed = existsSync(join(requestDir, EPHEMERAL_CLAUDE_CLOSED_RECEIPT))
          if (!alreadyClosed) {
            const raw = `${JSON.stringify(cleanupReceipt())}\n`
            privateFile(join(requestDir, EPHEMERAL_CLAUDE_CLOSED_RECEIPT), raw)
          }
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({
              status: alreadyClosed
                ? 'ephemeral-workspace-already-closed'
                : 'ephemeral-workspace-closed',
              workspace_id: target.workspaceId,
              pane_id: target.paneId,
              agent_name: target.target,
            })}\n`,
            stderr: '',
          }
        }
        return { exitCode: 0, stdout: '{"status":"snapshot-unchanged"}\n', stderr: '' }
      },
    })
    expect(result).toEqual({ closed: 2, discardedBeforeOpen: 0 })
    expect(commands.sort()).toEqual([
      'close:investigation',
      'close:design',
    ].sort())
    expect(runtimeChecks).toBe(4)
    expect(existsSync(join(state, EPHEMERAL_CLAUDE_STATE_ROOT))).toBe(false)
  })

  test('close/identity不成立ではreceiptを保持してFIFOをfail closedにする', async () => {
    const state = fixtureState()
    const projectRoot = dirname(state)
    const closePending = request(state)
    writeLifecycleRecords(closePending, projectRoot, false)
    await expect(reconcileEphemeralClaudeSessions({ stateDir: state, runtime }, {
      resolveHelper: () => '/fixture/helper',
      resolveClaudeLookup: () => '/usr/local/bin/claude',
      verifyRuntime: async () => {},
      runHelper: async () => ({ exitCode: 3, stdout: '', stderr: 'not closed' }),
    })).rejects.toThrow(EphemeralClaudeCleanupPendingError)
    expect(existsSync(closePending)).toBe(true)
  })

  test('owned Claude processの生存が明示された場合だけ専用例外に分類する', async () => {
    const state = fixtureState()
    const projectRoot = dirname(state)
    const live = request(state)
    writeLifecycleRecords(live, projectRoot, false)
    await expect(reconcileEphemeralClaudeSessions({ stateDir: state, runtime }, {
      resolveHelper: () => '/fixture/helper',
      resolveClaudeLookup: () => '/usr/local/bin/claude',
      verifyRuntime: async () => {},
      runHelper: async () => ({
        exitCode: 3,
        stdout: '',
        stderr: 'ephemeral Claude process survived workspace cleanup',
      }),
    })).rejects.toBeInstanceOf(EphemeralClaudeOwnedProcessStillLiveError)
    expect(existsSync(live)).toBe(true)
  })

  test('cleanup後もdelivery evidenceが不正ならrequestを消さない', async () => {
    const state = fixtureState()
    const projectRoot = dirname(state)
    const closePending = request(state, { jobId: 'job-invalid-delivery' })
    writeLifecycleRecords(closePending, projectRoot, false)
    privateFile(join(closePending, 'ephemeral-send-receipt.json'), `${JSON.stringify({
      version: 2,
      nonce: 'f'.repeat(32),
      target: target.target,
      marker: `REQUEST_MARKER=${'A'.repeat(32)}`,
      status: 'delivery-possible',
    })}\n`)
    await expect(reconcileEphemeralClaudeSessions({ stateDir: state, runtime }, {
      resolveHelper: () => '/fixture/helper',
      resolveClaudeLookup: () => '/usr/local/bin/claude',
      verifyRuntime: async () => {},
      runHelper: async (_helper, command, _projectRoot, requestDir) => {
        if (command !== 'close') throw new Error('unexpected helper command')
        privateFile(
          join(requestDir, EPHEMERAL_CLAUDE_CLOSED_RECEIPT),
          `${JSON.stringify(cleanupReceipt())}\n`,
        )
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            status: 'ephemeral-workspace-closed',
            workspace_id: target.workspaceId,
            pane_id: target.paneId,
            agent_name: target.target,
          })}\n`,
          stderr: '',
        }
      },
    })).rejects.toThrow(EphemeralClaudeCleanupPendingError)
    expect(existsSync(closePending)).toBe(true)
  })

  test('workspace receipt前のcrashはnonce label限定recover後だけ回収する', async () => {
    const state = fixtureState()
    const projectRoot = dirname(state)
    const intentOnly = request(state, { phase: 'review' })
    privateFile(join(intentOnly, 'ephemeral-session-intent.json'), `${JSON.stringify(
      intentReceipt(projectRoot),
    )}\n`)
    const commands: string[] = []
    const result = await reconcileEphemeralClaudeSessions({ stateDir: state, runtime }, {
      resolveHelper: () => '/fixture/helper',
      resolveClaudeLookup: () => '/usr/local/bin/claude',
      verifyRuntime: async () => {},
      runHelper: async (_helper, command, _projectRoot, requestDir) => {
        commands.push(command)
        if (command === 'recover') {
          const receipt = {
            version: 2,
            nonce: lifecycleNonce,
            workspace_id: null,
            status: 'provisional-workspace-not-created',
            workspace_absent: true,
            label_absent: true,
            caller_restored: false,
            catalog_restored: false,
            project_location_verified: false,
            protected_unchanged: false,
          }
          const receiptPath = join(requestDir, EPHEMERAL_CLAUDE_CLOSED_RECEIPT)
          const alreadyReconciled = existsSync(receiptPath)
          if (!alreadyReconciled) privateFile(receiptPath, `${JSON.stringify(receipt)}\n`)
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({
              status: alreadyReconciled
                ? 'ephemeral-provisional-already-reconciled'
                : 'ephemeral-provisional-reconciled',
              workspace_id: null,
            })}\n`,
            stderr: '',
          }
        }
        return { exitCode: 0, stdout: '{"status":"snapshot-unchanged"}\n', stderr: '' }
      },
    })
    expect(result).toEqual({ closed: 1, discardedBeforeOpen: 0 })
    expect(commands).toEqual(['recover'])
    expect(existsSync(intentOnly)).toBe(true)
    const repeated = await reconcileEphemeralClaudeSessions({ stateDir: state, runtime }, {
      resolveHelper: () => '/fixture/helper',
      resolveClaudeLookup: () => '/usr/local/bin/claude',
      verifyRuntime: async () => {},
      runHelper: async (_helper, command) => {
        expect(command).toBe('recover')
        return {
          exitCode: 0,
          stdout: '{"status":"ephemeral-provisional-already-reconciled","workspace_id":null}\n',
          stderr: '',
        }
      },
    })
    expect(repeated).toEqual({ closed: 1, discardedBeforeOpen: 0 })
    expect(existsSync(intentOnly)).toBe(true)

    expect(() => parseEphemeralClaudeProvisionalRecovery(
      '{"status":"ephemeral-provisional-reconciled","workspace_id":"foreign"}\n',
    )).toThrow()

    const receiptDir = request(state, { phase: 'design' })
    privateFile(join(receiptDir, 'ephemeral-session-intent.json'), `${JSON.stringify(
      intentReceipt(projectRoot),
    )}\n`)
    privateFile(join(receiptDir, EPHEMERAL_CLAUDE_CLOSED_RECEIPT), `${JSON.stringify({
      version: 2,
      nonce: lifecycleNonce,
      workspace_id: null,
      status: 'provisional-workspace-not-created',
      workspace_absent: true,
      label_absent: true,
      caller_restored: false,
      catalog_restored: false,
      project_location_verified: false,
      protected_unchanged: false,
    })}\n`)
    expect(readEphemeralClaudeProvisionalCleanupReceipt(receiptDir).status)
      .toBe('provisional-workspace-not-created')
  })
})

function unlinkForTest(path: string): void {
  rmSync(path, { force: true })
}
