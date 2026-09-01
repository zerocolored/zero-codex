import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { deflateSync } from 'zlib'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  assertUiApprovalReadyMayProceed,
  buildUiApprovalSemanticDecisionTemplate,
  createUiApprovalBrowserReceipt,
  parseCodexPreparationDecision,
  reencodeUiApprovalImages,
  stripUiApprovalPngMetadata,
  uiApprovalBrowserReceiptPath,
  verifyUiApprovalBrowserReceipts,
  type UiApprovalResumeContext,
  type UiApprovalSemanticDecision,
} from './ui-approval.ts'

const temporaryDirectories: string[] = []
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function crcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

const table = crcTable()

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.byteLength)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

function screenshotPng(red: number, withMetadata = true): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1280, 0)
  header.writeUInt32BE(720, 4)
  header[8] = 8
  header[9] = 6
  const row = Buffer.alloc(1 + 1280 * 4)
  for (let offset = 1; offset < row.byteLength; offset += 4) {
    row[offset] = red
    row[offset + 3] = 255
  }
  const raw = Buffer.concat(Array.from({ length: 720 }, () => row))
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    ...(withMetadata ? [chunk('tEXt', Buffer.from('source\0/private/local/path'))] : []),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('Codex UI/UX approval decision contract', () => {
  const nonce = '0123456789abcdef0123456789abcdef'
  const input = { revision: 3, digest: 'a'.repeat(64) }
  const repositorySnapshot: NonNullable<UiApprovalResumeContext['repositorySnapshot']> = {
    version: 2,
    projectPath: '/project',
    kind: 'non-git',
    gitRoot: null,
    gitRoots: [],
    head: null,
    status: '',
    dirty: {},
    repositories: [],
    rootInstructions: {},
  }
  const context = (
    responseText = 'OK実装して',
    snapshot: UiApprovalResumeContext['repositorySnapshot'] = repositorySnapshot,
  ): UiApprovalResumeContext => ({
    requestId: 'approval-request',
    requestInputRevision: 1,
    requestInputDigest: '1'.repeat(64),
    responseInputRevision: 3,
    responseInputDigest: input.digest,
    responseMessageId: '1800000000.000002',
    responseText,
    responseAfterPrompt: true,
    repositoryDigest: 'b'.repeat(64),
    repositorySnapshot: snapshot,
    repositoryScope: null,
    repositoryScopeDigest: null,
    proposalText: '承認待ちの提案です。',
  })
  const semanticDecision = (
    approval: UiApprovalResumeContext,
    currentRepositoryDigest = 'c'.repeat(64),
    intent: UiApprovalSemanticDecision['intent'] = 'approve',
    repositoryState: UiApprovalSemanticDecision['repositoryState'] = 'compatible',
  ): UiApprovalSemanticDecision => ({
    version: 1,
    attemptNonce: nonce,
    requestId: approval.requestId,
    proposalInputRevision: approval.requestInputRevision,
    proposalInputDigest: approval.requestInputDigest,
    responseInputRevision: approval.responseInputRevision,
    responseInputDigest: approval.responseInputDigest,
    responseMessageId: approval.responseMessageId,
    responseAfterPrompt: approval.responseAfterPrompt,
    proposalRepositoryDigest: approval.repositoryScopeDigest ?? approval.repositoryDigest,
    currentRepositoryDigest,
    intent,
    repositoryState,
  })
  const semanticEnvelope = (decision: UiApprovalSemanticDecision): string => (
    `<zerokun_ui_response_decision>${JSON.stringify(decision)}</zerokun_ui_response_decision>`
  )
  const workAction = (
    kind: 'implement' | 'no-change' | 'promote-current-head' = 'implement',
    repositories: string[] = ['.'],
  ) => kind === 'implement'
    ? '<zerokun_work_action>' + JSON.stringify({
        kind,
        targets: repositories.map(repository => ({
          repository,
          baseBranch: 'main',
          mergePullRequest: false,
          followupBaseBranch: null,
        })),
      }) + '</zerokun_work_action>'
    : `<zerokun_work_action>{"kind":"${kind}"}</zerokun_work_action>`

  test('accepts either the exact ready marker or one exact Before/After envelope', () => {
    expect(parseCodexPreparationDecision(
      `調査済みです\n${workAction()}\n[ZERO_PRE_EDIT_READY:${nonce}:r3:${input.digest}]`,
      nonce,
      input,
    )).toEqual({
      kind: 'ready',
      repositoryScope: ['.'],
      workAction: 'implement',
      implementationIntents: [{
        repository: '.',
        baseBranch: 'main',
        mergePullRequest: false,
        followupBaseBranch: null,
      }],
    })

    const decision = parseCodexPreparationDecision([
      `[ZERO_UI_APPROVAL_REQUIRED:${nonce}:r3:${input.digest}]`,
      '情報階層を整理した案です。この方向で進めてよいですか？',
      '<zerokun_ui_approval>{"before":"/private/outbox/before.png","after":"/private/outbox/after.png","repositories":["."]}</zerokun_ui_approval>',
    ].join('\n'), nonce, input)
    expect(decision).toEqual({
      kind: 'approval-required',
      proposal: {
        text: '情報階層を整理した案です。この方向で進めてよいですか？',
        beforePath: '/private/outbox/before.png',
        afterPath: '/private/outbox/after.png',
        repositoryScope: ['.'],
      },
    })
  })

  test('rejects mixed, trailing, exposed, or non-distinct image declarations', () => {
    const marker = `[ZERO_UI_APPROVAL_REQUIRED:${nonce}:r3:${input.digest}]`
    expect(() => parseCodexPreparationDecision([
      marker,
      '提案です /private/outbox/before.png',
      '<zerokun_ui_approval>{"before":"/private/outbox/before.png","after":"/private/outbox/after.png","repositories":["."]}</zerokun_ui_approval>',
    ].join('\n'), nonce, input)).toThrow('must not expose')
    expect(() => parseCodexPreparationDecision([
      marker,
      '提案です',
      '<zerokun_ui_approval>{"before":"/private/outbox/same.png","after":"/private/outbox/same.png","repositories":["."]}</zerokun_ui_approval>',
    ].join('\n'), nonce, input)).toThrow('must be distinct')
    expect(() => parseCodexPreparationDecision([
      marker,
      '提案です',
      '<zerokun_ui_approval>{"before":"/private/outbox/before.png","after":"/private/outbox/after.png","repositories":["."]}</zerokun_ui_approval>',
      'trailing',
    ].join('\n'), nonce, input)).toThrow('omitted its exact')
  })

  test('natural-language meaning comes from one exactly bound Codex decision envelope', () => {
    for (const responseText of ['OK実装して', '承認する']) {
      const approval = context(responseText)
      const decision = semanticDecision(approval)
      expect(parseCodexPreparationDecision([
        semanticEnvelope(decision),
        `調査済みです\n${workAction()}\n[ZERO_PRE_EDIT_READY:${nonce}:r3:${input.digest}]`,
      ].join('\n'), nonce, input, {
        context: approval,
        currentRepositoryDigest: decision.currentRepositoryDigest,
      })).toEqual({
        kind: 'ready',
        repositoryScope: ['.'],
        workAction: 'implement',
        implementationIntents: [{
          repository: '.',
          baseBranch: 'main',
          mergePullRequest: false,
          followupBaseBranch: null,
        }],
        approvalDecision: decision,
      })
    }

    const template = buildUiApprovalSemanticDecisionTemplate({
      attemptNonce: nonce,
      context: context(),
      currentRepositoryDigest: 'c'.repeat(64),
    })
    expect(template).toContain('"intent":"<approve|revise|question|reject>"')
    expect(template).toContain('"repositoryState":"<unchanged|compatible|conflict>"')
  })

  test('proposal repository scope is exact and the semantic decision binds its scoped digest', () => {
    const proposal = [
      `[ZERO_UI_APPROVAL_REQUIRED:${nonce}:r3:${input.digest}]`,
      '対象画面だけを更新する提案です。',
      '<zerokun_ui_approval>{"before":"/private/outbox/before.png","after":"/private/outbox/after.png","repositories":["frontend"]}</zerokun_ui_approval>',
    ].join('\n')
    expect(parseCodexPreparationDecision(
      proposal,
      nonce,
      input,
      undefined,
      ['backend', 'frontend'],
    )).toMatchObject({
      kind: 'approval-required',
      proposal: { repositoryScope: ['frontend'] },
    })
    expect(() => parseCodexPreparationDecision(
      proposal.replace('["frontend"]', '["unknown"]'),
      nonce,
      input,
      undefined,
      ['backend', 'frontend'],
    )).toThrow('repository scope')

    const approval = {
      ...context(),
      repositoryScope: ['frontend'],
      repositoryScopeDigest: 'e'.repeat(64),
    }
    const decision = semanticDecision(approval, 'f'.repeat(64))
    expect(decision.proposalRepositoryDigest).toBe(approval.repositoryScopeDigest)
    expect(parseCodexPreparationDecision([
      semanticEnvelope(decision),
      workAction('implement', ['frontend']),
      '<zerokun_repository_scope>{"repositories":["frontend"]}</zerokun_repository_scope>',
      `[ZERO_PRE_EDIT_READY:${nonce}:r3:${input.digest}]`,
    ].join('\n'), nonce, input, {
      context: approval,
      currentRepositoryDigest: decision.currentRepositoryDigest,
    }, ['backend', 'frontend'])).toMatchObject({ kind: 'ready' })

    expect(parseCodexPreparationDecision([
      semanticEnvelope(decision),
      workAction('implement', ['backend', 'frontend']),
      '<zerokun_repository_scope>{"repositories":["backend","frontend"]}</zerokun_repository_scope>',
      `[ZERO_PRE_EDIT_READY:${nonce}:r3:${input.digest}]`,
    ].join('\n'), nonce, input, {
      context: approval,
      currentRepositoryDigest: decision.currentRepositoryDigest,
    }, ['backend', 'frontend'])).toMatchObject({
      kind: 'ready',
      repositoryScope: ['backend', 'frontend'],
    })

    const expandedApproval = {
      ...approval,
      repositoryScope: ['backend', 'frontend'],
    }
    const expandedDecision = semanticDecision(expandedApproval, 'f'.repeat(64))
    expect(() => parseCodexPreparationDecision([
      semanticEnvelope(expandedDecision),
      workAction('implement', ['frontend']),
      '<zerokun_repository_scope>{"repositories":["frontend"]}</zerokun_repository_scope>',
      `[ZERO_PRE_EDIT_READY:${nonce}:r3:${input.digest}]`,
    ].join('\n'), nonce, input, {
      context: expandedApproval,
      currentRepositoryDigest: expandedDecision.currentRepositoryDigest,
    }, ['backend', 'frontend'])).toThrow('removed a repository')
  })

  test('multi-repository ready decision requires one exact minimal scope', () => {
    const ready = `[ZERO_PRE_EDIT_READY:${nonce}:r3:${input.digest}]`
    expect(() => parseCodexPreparationDecision(
      `準備完了\n${ready}`,
      nonce,
      input,
      undefined,
      ['backend', 'frontend'],
    )).toThrow('repository scope envelope')
    expect(parseCodexPreparationDecision([
      '準備完了',
      workAction('implement', ['frontend']),
      '<zerokun_repository_scope>{"repositories":["frontend"]}</zerokun_repository_scope>',
      ready,
    ].join('\n'), nonce, input, undefined, ['backend', 'frontend'])).toMatchObject({
      kind: 'ready',
      repositoryScope: ['frontend'],
    })
  })

  test('read-only no-changeだけが空のrepository scopeを使える', () => {
    const ready = `[ZERO_PRE_EDIT_READY:${nonce}:r3:${input.digest}]`
    expect(parseCodexPreparationDecision([
      '調査回答は完成しています',
      workAction('no-change'),
      '<zerokun_repository_scope>{"repositories":[]}</zerokun_repository_scope>',
      ready,
    ].join('\n'), nonce, input, undefined, ['backend', 'frontend'])).toEqual({
      kind: 'ready',
      repositoryScope: [],
      workAction: 'no-change',
    })

    expect(() => parseCodexPreparationDecision([
      '<zerokun_work_action>{"kind":"implement","targets":[]}</zerokun_work_action>',
      '<zerokun_repository_scope>{"repositories":[]}</zerokun_repository_scope>',
      ready,
    ].join('\n'), nonce, input, undefined, ['backend', 'frontend'])).toThrow(
      'empty repository scope only for no-change',
    )
    expect(() => parseCodexPreparationDecision([
      workAction('promote-current-head'),
      '<zerokun_repository_scope>{"repositories":[]}</zerokun_repository_scope>',
      ready,
    ].join('\n'), nonce, input, undefined, ['backend', 'frontend'])).toThrow(
      'empty repository scope only for no-change',
    )
  })

  test('publication-only promotionは全対象repositoryと連続branch操作をexact envelopeへ固定する', () => {
    const ready = `[ZERO_PRE_EDIT_READY:${nonce}:r3:${input.digest}]`
    const promotion = '<zerokun_publication>{"promotions":['
      + '{"kind":"promote-current-head","repository":"frontend",'
      + '"baseBranch":"develop","mergePullRequest":true,'
      + '"followupBaseBranch":"main","waitForChecks":false,'
      + '"integrationPullRequestBody":"## Summary\\nreviewed {{COMMIT_SHA}}",'
      + '"followupPullRequestBody":"## Summary\\nrelease {{COMMIT_SHA}}",'
      + '"closePullRequestNumbers":[]}]}</zerokun_publication>'
    expect(parseCodexPreparationDecision([
      workAction('promote-current-head'),
      promotion,
      '<zerokun_repository_scope>{"repositories":["frontend"]}</zerokun_repository_scope>',
      ready,
    ].join('\n'), nonce, input, undefined, ['backend', 'frontend'])).toMatchObject({
      kind: 'ready',
      repositoryScope: ['frontend'],
      workAction: 'promote-current-head',
      publicationIntents: [{
        kind: 'promote-current-head',
        repository: 'frontend',
        baseBranch: 'develop',
        mergePullRequest: true,
        followupBaseBranch: 'main',
        waitForChecks: false,
        integrationPullRequestBody: '## Summary\nreviewed {{COMMIT_SHA}}',
        followupPullRequestBody: '## Summary\nrelease {{COMMIT_SHA}}',
        closePullRequestNumbers: [],
      }],
    })

    expect(() => parseCodexPreparationDecision([
      workAction('promote-current-head'),
      promotion,
      '<zerokun_repository_scope>{"repositories":["backend","frontend"]}</zerokun_repository_scope>',
      ready,
    ].join('\n'), nonce, input, undefined, ['backend', 'frontend'])).toThrow(
      'every selected repository',
    )
  })

  test('Codexがchecks待機・PR本文・obsolete PR closeをpromotionへ固定できる', () => {
    const ready = `[ZERO_PRE_EDIT_READY:${nonce}:r3:${input.digest}]`
    const details = {
      kind: 'promote-current-head',
      repository: 'frontend',
      baseBranch: 'develop',
      mergePullRequest: true,
      followupBaseBranch: 'main',
      waitForChecks: true,
      integrationPullRequestBody: '## Summary\nreviewed {{COMMIT_SHA}}',
      followupPullRequestBody: '## Summary\nrelease reviewed {{COMMIT_SHA}}',
      closePullRequestNumbers: [857],
    }
    const parse = (promotion: Record<string, unknown>) => parseCodexPreparationDecision([
      workAction('promote-current-head'),
      `<zerokun_publication>${JSON.stringify({ promotions: [promotion] })}</zerokun_publication>`,
      '<zerokun_repository_scope>{"repositories":["frontend"]}</zerokun_repository_scope>',
      ready,
    ].join('\n'), nonce, input, undefined, ['frontend'])
    expect(parse(details)).toMatchObject({
      kind: 'ready',
      publicationIntents: [details],
    })
    expect(() => parse({ ...details, closePullRequestNumbers: [857, 857] })).toThrow(
      'publication promotion is invalid',
    )
    expect(() => parse({ ...details, integrationPullRequestBody: '' })).toThrow(
      'publication promotion is invalid',
    )
  })

  test('実装targetにもCodex選択のGitHub公開詳細を保持する', () => {
    const ready = `[ZERO_PRE_EDIT_READY:${nonce}:r3:${input.digest}]`
    const target = {
      repository: 'frontend',
      baseBranch: 'develop',
      mergePullRequest: true,
      followupBaseBranch: 'main',
      waitForChecks: true,
      integrationPullRequestBody: '## Summary\nimplementation {{COMMIT_SHA}}',
      followupPullRequestBody: '## Summary\nrelease {{COMMIT_SHA}}',
      closePullRequestNumbers: [857],
    }
    const decision = parseCodexPreparationDecision([
      `<zerokun_work_action>${JSON.stringify({ kind: 'implement', targets: [target] })}</zerokun_work_action>`,
      '<zerokun_repository_scope>{"repositories":["frontend"]}</zerokun_repository_scope>',
      ready,
    ].join('\n'), nonce, input, undefined, ['frontend'])
    expect(decision).toMatchObject({
      kind: 'ready',
      workAction: 'implement',
      implementationIntents: [target],
    })
  })

  test('host gate accepts a compatible repository change and rejects stale or conflicting meaning', () => {
    const approval = context()
    const decision = semanticDecision(approval)
    expect(() => assertUiApprovalReadyMayProceed({
      context: approval,
      decision,
      currentInputRevision: 3,
      currentInputDigest: input.digest,
      currentRepositoryDigest: decision.currentRepositoryDigest,
    })).not.toThrow()
    expect(() => assertUiApprovalReadyMayProceed({
      context: approval,
      decision: semanticDecision(approval, decision.currentRepositoryDigest, 'question'),
      currentInputRevision: 3,
      currentInputDigest: input.digest,
      currentRepositoryDigest: decision.currentRepositoryDigest,
    })).toThrow('without a bound semantic')
    expect(() => assertUiApprovalReadyMayProceed({
      context: approval,
      decision: semanticDecision(approval, decision.currentRepositoryDigest, 'approve', 'conflict'),
      currentInputRevision: 3,
      currentInputDigest: input.digest,
      currentRepositoryDigest: decision.currentRepositoryDigest,
    })).toThrow('without a bound semantic')
    expect(() => assertUiApprovalReadyMayProceed({
      context: approval,
      decision,
      currentInputRevision: 3,
      currentInputDigest: 'd'.repeat(64),
      currentRepositoryDigest: decision.currentRepositoryDigest,
    })).toThrow('current approved Slack input')
    expect(() => assertUiApprovalReadyMayProceed({
      context: approval,
      decision,
      currentInputRevision: 3,
      currentInputDigest: input.digest,
      currentRepositoryDigest: 'd'.repeat(64),
    })).toThrow('stale')
  })

  test('repository state must match digests and legacy baselines cannot authorize compatibility', () => {
    const approval = context()
    const ready = (decision: UiApprovalSemanticDecision): string => [
      semanticEnvelope(decision),
      workAction(),
      `[ZERO_PRE_EDIT_READY:${nonce}:r3:${input.digest}]`,
    ].join('\n')
    expect(() => parseCodexPreparationDecision(
      ready(semanticDecision(approval, 'c'.repeat(64), 'approve', 'unchanged')),
      nonce,
      input,
      { context: approval, currentRepositoryDigest: 'c'.repeat(64) },
    )).toThrow('repository decision')
    expect(() => parseCodexPreparationDecision(
      ready(semanticDecision(approval, approval.repositoryDigest, 'approve', 'compatible')),
      nonce,
      input,
      { context: approval, currentRepositoryDigest: approval.repositoryDigest },
    )).toThrow('repository decision')

    const legacy = context('承認する', null)
    const legacyDecision = semanticDecision(legacy)
    expect(() => parseCodexPreparationDecision(
      ready(legacyDecision),
      nonce,
      input,
      { context: legacy, currentRepositoryDigest: legacyDecision.currentRepositoryDigest },
    )).toThrow('repository decision')
    expect(() => assertUiApprovalReadyMayProceed({
      context: legacy,
      decision: legacyDecision,
      currentInputRevision: input.revision,
      currentInputDigest: input.digest,
      currentRepositoryDigest: legacyDecision.currentRepositoryDigest,
    })).toThrow('unverifiable')
  })
})

describe('UI/UX approval screenshot sealing', () => {
  test('accepts only authenticated browser receipts bound to job, phase, role, and pixels', () => {
    const outbox = mkdtempSync(join(tmpdir(), 'zero-ui-receipts-'))
    temporaryDirectories.push(outbox)
    const before = join(outbox, 'before.png')
    const after = join(outbox, 'after.png')
    writeFileSync(before, screenshotPng(20), { mode: 0o600 })
    writeFileSync(after, screenshotPng(80), { mode: 0o600 })
    const key = '1'.repeat(64)
    const jobId = 'browser-receipt-job'
    const attemptNonce = '2'.repeat(32)
    for (const [role, path] of [['before', before], ['after', after]] as const) {
      const receiptPath = uiApprovalBrowserReceiptPath(path)
      writeFileSync(receiptPath, createUiApprovalBrowserReceipt({
        key,
        jobId,
        attemptNonce,
        role,
        imagePath: path,
        imageDigest: createHash('sha256').update(readFileSync(path)).digest('hex'),
      }), { mode: 0o600 })
      chmodSync(receiptPath, 0o600)
    }
    expect(() => verifyUiApprovalBrowserReceipts({
      key,
      jobId,
      attemptNonce,
      outbox,
      beforePath: before,
      afterPath: after,
    })).not.toThrow()

    writeFileSync(after, screenshotPng(90), { mode: 0o600 })
    expect(() => verifyUiApprovalBrowserReceipts({
      key,
      jobId,
      attemptNonce,
      outbox,
      beforePath: before,
      afterPath: after,
    })).toThrow('changed after capture')
  })

  test('validates 1280x720 pixels and strips local metadata', () => {
    const input = screenshotPng(20)
    const output = stripUiApprovalPngMetadata(input)
    expect(output.subarray(0, 8)).toEqual(signature)
    expect(output.includes(Buffer.from('/private/local/path'))).toBe(false)
    expect(output.includes(Buffer.from('tEXt'))).toBe(false)
    expect(output.readUInt32BE(16)).toBe(1280)
    expect(output.readUInt32BE(20)).toBe(720)

    const corrupted = Buffer.from(input)
    corrupted[corrupted.byteLength - 1] ^= 1
    expect(() => stripUiApprovalPngMetadata(corrupted)).toThrow('checksum')
  })

  test('decodes both direct outbox files and rejects a symlink or identical pair', () => {
    const outbox = mkdtempSync(join(tmpdir(), 'zero-ui-approval-'))
    temporaryDirectories.push(outbox)
    const before = join(outbox, 'before.png')
    const after = join(outbox, 'after.png')
    writeFileSync(before, screenshotPng(20))
    writeFileSync(after, screenshotPng(80))
    const sealed = reencodeUiApprovalImages({ outbox, beforePath: before, afterPath: after })
    expect(sealed.beforePath).not.toBe(sealed.afterPath)
    expect(stripUiApprovalPngMetadata(readFileSync(sealed.beforePath)).byteLength).toBeGreaterThan(0)

    const revisedRound = reencodeUiApprovalImages({
      outbox,
      beforePath: before,
      afterPath: after,
    })
    expect(revisedRound.beforePath).not.toBe(sealed.beforePath)
    expect(revisedRound.afterPath).not.toBe(sealed.afterPath)
    expect(readFileSync(revisedRound.beforePath)).toEqual(readFileSync(sealed.beforePath))
    expect(readFileSync(revisedRound.afterPath)).toEqual(readFileSync(sealed.afterPath))

    const link = join(outbox, 'link.png')
    symlinkSync(before, link)
    expect(() => reencodeUiApprovalImages({ outbox, beforePath: link, afterPath: after }))
      .toThrow()
    expect(() => reencodeUiApprovalImages({ outbox, beforePath: before, afterPath: before }))
      .toThrow('identical')
  })
})
