import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { deflateSync } from 'zlib'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  assertUiApprovalReadyMayProceed,
  createUiApprovalBrowserReceipt,
  isExplicitUiApprovalResponse,
  parseCodexPreparationDecision,
  reencodeUiApprovalImages,
  stripUiApprovalPngMetadata,
  uiApprovalBrowserReceiptPath,
  verifyUiApprovalBrowserReceipts,
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

  test('accepts either the exact ready marker or one exact Before/After envelope', () => {
    expect(parseCodexPreparationDecision(
      `調査済みです\n[ZERO_PRE_EDIT_READY:${nonce}:r3:${input.digest}]`,
      nonce,
      input,
    )).toEqual({ kind: 'ready' })

    const decision = parseCodexPreparationDecision([
      `[ZERO_UI_APPROVAL_REQUIRED:${nonce}:r3:${input.digest}]`,
      '情報階層を整理した案です。この方向で進めてよいですか？',
      '<zerokun_ui_approval>{"before":"/private/outbox/before.png","after":"/private/outbox/after.png"}</zerokun_ui_approval>',
    ].join('\n'), nonce, input)
    expect(decision).toEqual({
      kind: 'approval-required',
      proposal: {
        text: '情報階層を整理した案です。この方向で進めてよいですか？',
        beforePath: '/private/outbox/before.png',
        afterPath: '/private/outbox/after.png',
      },
    })
  })

  test('rejects mixed, trailing, exposed, or non-distinct image declarations', () => {
    const marker = `[ZERO_UI_APPROVAL_REQUIRED:${nonce}:r3:${input.digest}]`
    expect(() => parseCodexPreparationDecision([
      marker,
      '提案です /private/outbox/before.png',
      '<zerokun_ui_approval>{"before":"/private/outbox/before.png","after":"/private/outbox/after.png"}</zerokun_ui_approval>',
    ].join('\n'), nonce, input)).toThrow('must not expose')
    expect(() => parseCodexPreparationDecision([
      marker,
      '提案です',
      '<zerokun_ui_approval>{"before":"/private/outbox/same.png","after":"/private/outbox/same.png"}</zerokun_ui_approval>',
    ].join('\n'), nonce, input)).toThrow('must be distinct')
    expect(() => parseCodexPreparationDecision([
      marker,
      '提案です',
      '<zerokun_ui_approval>{"before":"/private/outbox/before.png","after":"/private/outbox/after.png"}</zerokun_ui_approval>',
      'trailing',
    ].join('\n'), nonce, input)).toThrow('omitted its exact')
  })

  test('only an unconditional same-message answer is classified as explicit approval', () => {
    expect(isExplicitUiApprovalResponse('はい')).toBe(true)
    expect(isExplicitUiApprovalResponse('<@U0123456789> この方向で進めてください。')).toBe(true)
    expect(isExplicitUiApprovalResponse('はい、ただし色は変えて')).toBe(false)
    expect(isExplicitUiApprovalResponse('これで大丈夫？')).toBe(false)
    expect(isExplicitUiApprovalResponse('OK', true)).toBe(false)
  })

  test('host gate requires the current explicit response and unchanged repository', () => {
    const context = {
      requestId: 'approval-request',
      requestInputRevision: 1,
      requestInputDigest: 'a'.repeat(64),
      responseInputRevision: 2,
      responseMessageId: '1800000000.000002',
      responseText: 'はい',
      explicitApproval: true,
      repositoryDigest: 'b'.repeat(64),
    }
    expect(() => assertUiApprovalReadyMayProceed({
      context,
      currentInputRevision: 2,
      currentRepositoryDigest: 'b'.repeat(64),
    })).not.toThrow()
    expect(() => assertUiApprovalReadyMayProceed({
      context: { ...context, explicitApproval: false },
      currentInputRevision: 2,
      currentRepositoryDigest: 'b'.repeat(64),
    })).toThrow('without an explicit')
    expect(() => assertUiApprovalReadyMayProceed({
      context,
      currentInputRevision: 3,
      currentRepositoryDigest: 'b'.repeat(64),
    })).toThrow('current-input')
    expect(() => assertUiApprovalReadyMayProceed({
      context,
      currentInputRevision: 2,
      currentRepositoryDigest: 'c'.repeat(64),
    })).toThrow('repository changed')
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
