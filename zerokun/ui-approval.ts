import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import type { AdvisorRepositorySnapshot } from './advisor-snapshot.ts'

const UI_APPROVAL_MARKER = 'zerokun_ui_approval'
const UI_RESPONSE_DECISION_MARKER = 'zerokun_ui_response_decision'
const MAX_UI_APPROVAL_TEXT_CHARS = 4_000
const MAX_UI_APPROVAL_PNG_BYTES = 16 * 1024 * 1024
const SCREENSHOT_WIDTH = 1280
const SCREENSHOT_HEIGHT = 720
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const BROWSER_RECEIPT_SUFFIX = '.zerokun-browser-receipt.json'
const MAX_BROWSER_RECEIPT_BYTES = 8 * 1024

type UiApprovalBrowserReceiptPayload = {
  version: 1
  jobId: string
  attemptNonce: string
  phase: 'prepare'
  role: 'before' | 'after'
  imagePath: string
  imageDigest: string
  width: 1280
  height: 720
  createdAt: number
}

type UiApprovalBrowserReceipt = UiApprovalBrowserReceiptPayload & { mac: string }

function browserReceiptPayloadJson(payload: UiApprovalBrowserReceiptPayload): string {
  return JSON.stringify(payload)
}

function requireBrowserReceiptKey(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('browser receipt key is invalid')
  return Buffer.from(value, 'hex')
}

export function uiApprovalBrowserReceiptPath(imagePath: string): string {
  return `${resolve(imagePath)}${BROWSER_RECEIPT_SUFFIX}`
}

export function createUiApprovalBrowserReceipt(input: {
  key: string
  jobId: string
  attemptNonce: string
  role: 'before' | 'after'
  imagePath: string
  imageDigest: string
  createdAt?: number
}): string {
  if (!input.jobId || !/^[0-9a-f]{32}$/.test(input.attemptNonce)
    || !isAbsolute(input.imagePath) || !/^[0-9a-f]{64}$/.test(input.imageDigest)) {
    throw new Error('browser receipt binding is invalid')
  }
  const payload: UiApprovalBrowserReceiptPayload = {
    version: 1,
    jobId: input.jobId,
    attemptNonce: input.attemptNonce,
    phase: 'prepare',
    role: input.role,
    imagePath: resolve(input.imagePath),
    imageDigest: input.imageDigest,
    width: SCREENSHOT_WIDTH,
    height: SCREENSHOT_HEIGHT,
    createdAt: input.createdAt ?? Date.now(),
  }
  if (!Number.isSafeInteger(payload.createdAt) || payload.createdAt <= 0) {
    throw new Error('browser receipt time is invalid')
  }
  const mac = createHmac('sha256', requireBrowserReceiptKey(input.key))
    .update(browserReceiptPayloadJson(payload))
    .digest('hex')
  return `${JSON.stringify({ ...payload, mac })}\n`
}

function readUiApprovalBrowserReceipt(path: string): UiApprovalBrowserReceipt {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const metadata = fstatSync(descriptor)
    const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.nlink !== 1 || !owned
      || (metadata.mode & 0o077) !== 0 || metadata.size < 2
      || metadata.size > MAX_BROWSER_RECEIPT_BYTES) {
      throw new Error('browser receipt is not a bounded owner-only regular file')
    }
    const parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('browser receipt is not an object')
    }
    const record = parsed as Record<string, unknown>
    const expectedKeys = [
      'attemptNonce', 'createdAt', 'height', 'imageDigest', 'imagePath', 'jobId',
      'mac', 'phase', 'role', 'version', 'width',
    ]
    if (Object.keys(record).sort().join(',') !== expectedKeys.sort().join(',')) {
      throw new Error('browser receipt fields are invalid')
    }
    return record as UiApprovalBrowserReceipt
  } finally {
    closeSync(descriptor)
  }
}

function verifyUiApprovalBrowserReceipt(input: {
  key: string
  jobId: string
  attemptNonce: string
  role: 'before' | 'after'
  imagePath: string
  outbox: string
}): void {
  const imagePath = resolve(input.imagePath)
  assertDirectOwnedRegularFile(imagePath, input.outbox)
  const receiptPath = uiApprovalBrowserReceiptPath(imagePath)
  const receipt = readUiApprovalBrowserReceipt(receiptPath)
  if (receipt.version !== 1 || receipt.jobId !== input.jobId
    || receipt.attemptNonce !== input.attemptNonce || receipt.phase !== 'prepare'
    || receipt.role !== input.role || receipt.imagePath !== imagePath
    || receipt.width !== SCREENSHOT_WIDTH || receipt.height !== SCREENSHOT_HEIGHT
    || !Number.isSafeInteger(receipt.createdAt) || receipt.createdAt <= 0
    || !/^[0-9a-f]{64}$/.test(receipt.imageDigest)
    || !/^[0-9a-f]{64}$/.test(receipt.mac)) {
    throw new Error(`UI/UX approval ${input.role} browser receipt binding is invalid`)
  }
  const digest = createHash('sha256').update(readFileSync(imagePath)).digest('hex')
  if (digest !== receipt.imageDigest) {
    throw new Error(`UI/UX approval ${input.role} browser screenshot changed after capture`)
  }
  const { mac, ...payload } = receipt
  const expected = createHmac('sha256', requireBrowserReceiptKey(input.key))
    .update(browserReceiptPayloadJson(payload))
    .digest()
  const actual = Buffer.from(mac, 'hex')
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new Error(`UI/UX approval ${input.role} browser receipt is unauthenticated`)
  }
}

export function verifyUiApprovalBrowserReceipts(input: {
  key: string
  jobId: string
  attemptNonce: string
  outbox: string
  beforePath: string
  afterPath: string
}): void {
  if (resolve(input.beforePath) === resolve(input.afterPath)) {
    throw new Error('UI/UX approval browser receipts must bind two distinct screenshots')
  }
  verifyUiApprovalBrowserReceipt({ ...input, role: 'before', imagePath: input.beforePath })
  verifyUiApprovalBrowserReceipt({ ...input, role: 'after', imagePath: input.afterPath })
}

export type UiApprovalProposal = {
  text: string
  beforePath: string
  afterPath: string
  repositoryScope: string[]
}

export type CodexPreparationDecision =
  | { kind: 'ready'; approvalDecision?: UiApprovalSemanticDecision }
  | {
      kind: 'approval-required'
      proposal: UiApprovalProposal
      approvalDecision?: UiApprovalSemanticDecision
    }

export type UiApprovalResponseIntent = 'approve' | 'revise' | 'question' | 'reject'
export type UiApprovalRepositoryState = 'unchanged' | 'compatible' | 'conflict'

export type UiApprovalSemanticDecision = {
  version: 1
  attemptNonce: string
  requestId: string
  proposalInputRevision: number
  proposalInputDigest: string
  responseInputRevision: number
  responseInputDigest: string
  responseMessageId: string
  responseAfterPrompt: boolean
  proposalRepositoryDigest: string
  currentRepositoryDigest: string
  intent: UiApprovalResponseIntent
  repositoryState: UiApprovalRepositoryState
}

export type UiApprovalResumeContext = {
  requestId: string
  requestInputRevision: number
  requestInputDigest: string
  responseInputRevision: number
  responseInputDigest: string
  responseMessageId: string
  responseText: string
  responseAfterPrompt: boolean
  repositoryDigest: string
  repositorySnapshot: AdvisorRepositorySnapshot | null
  repositoryScope: string[] | null
  repositoryScopeDigest: string | null
  proposalText: string
}

export type CodexUiApprovalPending = UiApprovalProposal & {
  sessionId: string
  inputRevision: number
  inputDigest: string
  repositoryDigest: string
  repositorySnapshot: AdvisorRepositorySnapshot
  repositoryScope: string[]
  repositoryScopeDigest: string
}

export class CodexUiApprovalRequiredError extends Error {
  constructor(readonly approval: CodexUiApprovalPending) {
    super('UI/UX proposal is ready and requires a same-thread Slack response')
    this.name = 'CodexUiApprovalRequiredError'
  }
}

export function buildUiApprovalSemanticDecisionTemplate(input: {
  attemptNonce: string
  context: UiApprovalResumeContext
  currentRepositoryDigest: string
}): string {
  if (!/^[0-9a-f]{32}$/.test(input.attemptNonce)
    || !/^[0-9a-f]{64}$/.test(input.currentRepositoryDigest)) {
    throw new Error('UI/UX semantic decision template binding is invalid')
  }
  const proposalRepositoryDigest = uiApprovalBoundRepositoryDigest(input.context)
  return `<${UI_RESPONSE_DECISION_MARKER}>${JSON.stringify({
    version: 1,
    attemptNonce: input.attemptNonce,
    requestId: input.context.requestId,
    proposalInputRevision: input.context.requestInputRevision,
    proposalInputDigest: input.context.requestInputDigest,
    responseInputRevision: input.context.responseInputRevision,
    responseInputDigest: input.context.responseInputDigest,
    responseMessageId: input.context.responseMessageId,
    responseAfterPrompt: input.context.responseAfterPrompt,
    proposalRepositoryDigest,
    currentRepositoryDigest: input.currentRepositoryDigest,
    intent: '<approve|revise|question|reject>',
    repositoryState: '<unchanged|compatible|conflict>',
  })}</${UI_RESPONSE_DECISION_MARKER}>`
}

function exactProposalEnvelope(
  value: string,
  attemptNonce: string,
  input: { revision: number; digest: string },
  availableRepositories: readonly string[],
): UiApprovalProposal | null {
  const normalized = value.replace(/\r\n/g, '\n').trim()
  const first = `[ZERO_UI_APPROVAL_REQUIRED:${attemptNonce}:r${input.revision}:${input.digest}]`
  if (!normalized.startsWith(`${first}\n`)) return null
  const rest = normalized.slice(first.length + 1)
  const marker = new RegExp(
    `<${UI_APPROVAL_MARKER}>([\\s\\S]*?)<\\/${UI_APPROVAL_MARKER}>\\s*$`,
    'i',
  ).exec(rest)
  if (!marker || marker.index <= 0) {
    throw new Error('Codex UI/UX proposal omitted its exact host-only image envelope')
  }
  const text = rest.slice(0, marker.index).trim()
  if (!text || text.length > MAX_UI_APPROVAL_TEXT_CHARS || /\[ZERO_/i.test(text)) {
    throw new Error('Codex UI/UX proposal text is empty or invalid')
  }
  let parsed: unknown
  try { parsed = JSON.parse(marker[1]!.trim()) } catch {
    throw new Error('Codex UI/UX proposal image envelope is invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codex UI/UX proposal image envelope must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'after,before,repositories'
    || typeof record.before !== 'string' || typeof record.after !== 'string'
    || !isAbsolute(record.before) || !isAbsolute(record.after)
    || !Array.isArray(record.repositories) || record.repositories.length === 0
    || record.repositories.some(value => typeof value !== 'string' || !value
      || value.length > 32_768 || isAbsolute(value))) {
    throw new Error(
      'Codex UI/UX proposal must declare two absolute image paths and repository scope',
    )
  }
  const repositoryScope = record.repositories as string[]
  if (JSON.stringify(repositoryScope) !== JSON.stringify([...repositoryScope].sort())
    || new Set(repositoryScope).size !== repositoryScope.length
    || repositoryScope.some(value => !availableRepositories.includes(value))) {
    throw new Error('Codex UI/UX proposal repository scope is invalid')
  }
  const beforePath = resolve(record.before)
  const afterPath = resolve(record.after)
  if (beforePath === afterPath) {
    throw new Error('Codex UI/UX proposal Before and After images must be distinct')
  }
  if (text.includes(record.before) || text.includes(record.after)) {
    throw new Error('Codex UI/UX proposal text must not expose local image paths')
  }
  return { text, beforePath, afterPath, repositoryScope }
}

function uiApprovalBoundRepositoryDigest(context: UiApprovalResumeContext): string {
  const hasScope = Array.isArray(context.repositoryScope)
  const hasScopeDigest = typeof context.repositoryScopeDigest === 'string'
  if (hasScope !== hasScopeDigest) {
    throw new Error('UI/UX approval repository scope binding is incomplete')
  }
  return hasScopeDigest ? context.repositoryScopeDigest! : context.repositoryDigest
}

export function parseCodexPreparationDecision(
  value: string,
  attemptNonce: string,
  input: { revision: number; digest: string },
  approval?: {
    context: UiApprovalResumeContext
    currentRepositoryDigest: string
  },
  availableRepositories: readonly string[] = ['.'],
): CodexPreparationDecision {
  let normalized = value.replace(/\r\n/g, '\n').trim()
  let approvalDecision: UiApprovalSemanticDecision | undefined
  const decisionPattern = new RegExp(
    `^<${UI_RESPONSE_DECISION_MARKER}>([^\n]+)<\/${UI_RESPONSE_DECISION_MARKER}>\n`,
  )
  const decisionMatch = decisionPattern.exec(normalized)
  if (approval) {
    if (!decisionMatch) {
      throw new Error('Codex UI/UX response omitted its exact semantic decision envelope')
    }
    if (new RegExp(`<${UI_RESPONSE_DECISION_MARKER}>`, 'g').test(
      normalized.slice(decisionMatch[0].length),
    )) {
      throw new Error('Codex UI/UX response duplicated its semantic decision envelope')
    }
    let parsed: unknown
    try { parsed = JSON.parse(decisionMatch[1]!) } catch {
      throw new Error('Codex UI/UX semantic decision envelope is invalid JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Codex UI/UX semantic decision envelope must be an object')
    }
    const record = parsed as Record<string, unknown>
    const expectedKeys = [
      'version', 'attemptNonce', 'requestId', 'proposalInputRevision',
      'proposalInputDigest', 'responseInputRevision', 'responseInputDigest',
      'responseMessageId', 'responseAfterPrompt', 'proposalRepositoryDigest', 'currentRepositoryDigest',
      'intent', 'repositoryState',
    ]
    if (Object.keys(record).sort().join(',') !== expectedKeys.sort().join(',')) {
      throw new Error('Codex UI/UX semantic decision fields are invalid')
    }
    const context = approval.context
    if (record.version !== 1 || record.attemptNonce !== attemptNonce
      || record.requestId !== context.requestId
      || record.proposalInputRevision !== context.requestInputRevision
      || record.proposalInputDigest !== context.requestInputDigest
      || record.responseInputRevision !== context.responseInputRevision
      || record.responseInputDigest !== context.responseInputDigest
      || record.responseMessageId !== context.responseMessageId
      || record.responseAfterPrompt !== context.responseAfterPrompt
      || record.proposalRepositoryDigest !== uiApprovalBoundRepositoryDigest(context)
      || record.currentRepositoryDigest !== approval.currentRepositoryDigest
      || !['approve', 'revise', 'question', 'reject'].includes(String(record.intent))
      || !['unchanged', 'compatible', 'conflict'].includes(String(record.repositoryState))) {
      throw new Error('Codex UI/UX semantic decision binding is invalid')
    }
    const repositoryUnchanged = record.proposalRepositoryDigest
      === record.currentRepositoryDigest
    if ((record.repositoryState === 'unchanged') !== repositoryUnchanged
      || (!repositoryUnchanged && context.repositorySnapshot === null
        && record.repositoryState !== 'conflict')) {
      throw new Error('Codex UI/UX semantic repository decision is invalid')
    }
    approvalDecision = record as UiApprovalSemanticDecision
    normalized = normalized.slice(decisionMatch[0].length).trim()
  } else if (decisionMatch || new RegExp(`<${UI_RESPONSE_DECISION_MARKER}>`).test(normalized)) {
    throw new Error('Codex emitted an unexpected UI/UX semantic decision envelope')
  }
  const ready = `[ZERO_PRE_EDIT_READY:${attemptNonce}:r${input.revision}:${input.digest}]`
  if (normalized.split('\n').at(-1) === ready) {
    if (normalized.includes(`[ZERO_UI_APPROVAL_REQUIRED:${attemptNonce}:`)
      || new RegExp(`<${UI_APPROVAL_MARKER}>`, 'i').test(normalized)) {
      throw new Error('Codex preparation mixed ready and UI/UX approval envelopes')
    }
    if (approvalDecision && (approvalDecision.intent !== 'approve'
      || approvalDecision.repositoryState === 'conflict')) {
      throw new Error('Codex UI/UX semantic decision does not authorize implementation')
    }
    return { kind: 'ready', ...(approvalDecision ? { approvalDecision } : {}) }
  }
  const proposal = exactProposalEnvelope(
    normalized,
    attemptNonce,
    input,
    availableRepositories,
  )
  if (!proposal) {
    throw new Error('Codex preparation omitted its exact current-input decision envelope')
  }
  if (approvalDecision && approvalDecision.intent === 'approve'
    && approvalDecision.repositoryState !== 'conflict') {
    throw new Error('Codex requested another UI/UX approval despite an implementable approval')
  }
  return {
    kind: 'approval-required',
    proposal,
    ...(approvalDecision ? { approvalDecision } : {}),
  }
}

/** The model decides meaning; the host still enforces exact message/input/repository bindings. */
export function assertUiApprovalReadyMayProceed(input: {
  context?: UiApprovalResumeContext
  decision?: UiApprovalSemanticDecision
  currentInputRevision: number
  currentInputDigest: string
  currentRepositoryDigest: string
}): void {
  if (!input.context) return
  if (!input.decision || input.decision.intent !== 'approve'
    || input.decision.repositoryState === 'conflict'
    || !input.context.responseAfterPrompt || !input.decision.responseAfterPrompt) {
    throw new Error(
      'Codex attempted to implement without a bound semantic UI/UX approval',
    )
  }
  if (input.context.responseInputRevision !== input.currentInputRevision
    || input.context.responseInputDigest !== input.currentInputDigest
    || input.decision.responseInputRevision !== input.currentInputRevision
    || input.decision.responseInputDigest !== input.currentInputDigest) {
    throw new Error(
      'Codex attempted to implement without the current approved Slack input',
    )
  }
  if (input.decision.requestId !== input.context.requestId
    || input.decision.responseMessageId !== input.context.responseMessageId
    || input.decision.proposalRepositoryDigest !== uiApprovalBoundRepositoryDigest(input.context)
    || input.decision.currentRepositoryDigest !== input.currentRepositoryDigest) {
    throw new Error('Codex attempted to reuse a stale UI/UX semantic decision')
  }
  const repositoryUnchanged = input.decision.proposalRepositoryDigest
    === input.decision.currentRepositoryDigest
  if ((input.decision.repositoryState === 'unchanged') !== repositoryUnchanged
    || (!repositoryUnchanged && input.context.repositorySnapshot === null)) {
    throw new Error(
      'Codex attempted to implement from an unverifiable UI/UX repository decision',
    )
  }
}

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

const PNG_CRC_TABLE = crcTable()

function pngCrc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Validate the browser screenshot and remove every non-visual metadata chunk. */
export function stripUiApprovalPngMetadata(input: Buffer): Buffer {
  if (input.byteLength === 0 || input.byteLength > MAX_UI_APPROVAL_PNG_BYTES
    || !input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('UI/UX approval image is not a bounded PNG')
  }
  const kept: Buffer[] = [PNG_SIGNATURE]
  let offset = PNG_SIGNATURE.length
  let ihdr = false
  let idat = false
  let iend = false
  while (offset < input.byteLength) {
    if (input.byteLength - offset < 12) throw new Error('UI/UX approval PNG is truncated')
    const length = input.readUInt32BE(offset)
    if (length > MAX_UI_APPROVAL_PNG_BYTES || offset + 12 + length > input.byteLength) {
      throw new Error('UI/UX approval PNG chunk is invalid')
    }
    const typeBytes = input.subarray(offset + 4, offset + 8)
    const type = typeBytes.toString('ascii')
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('UI/UX approval PNG chunk type is invalid')
    const data = input.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = input.readUInt32BE(offset + 8 + length)
    if (pngCrc32(Buffer.concat([typeBytes, data])) !== expectedCrc) {
      throw new Error('UI/UX approval PNG checksum is invalid')
    }
    if (type === 'IHDR') {
      if (ihdr || offset !== PNG_SIGNATURE.length || length !== 13
        || data.readUInt32BE(0) !== SCREENSHOT_WIDTH
        || data.readUInt32BE(4) !== SCREENSHOT_HEIGHT) {
        throw new Error('UI/UX approval PNG must be a 1280x720 browser screenshot')
      }
      ihdr = true
    } else if (type === 'IDAT') {
      if (!ihdr || iend) throw new Error('UI/UX approval PNG chunk order is invalid')
      idat = true
    } else if (type === 'IEND') {
      if (!ihdr || !idat || iend || length !== 0) {
        throw new Error('UI/UX approval PNG terminator is invalid')
      }
      iend = true
    } else if (type[0] === type[0]!.toUpperCase() && !['PLTE'].includes(type)) {
      throw new Error(`UI/UX approval PNG contains an unsupported critical chunk: ${type}`)
    }
    // Preserve pixel-bearing chunks only. Color profile, text, EXIF, time,
    // and other ancillary metadata cannot reach Slack.
    if (['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS'].includes(type)) {
      kept.push(input.subarray(offset, offset + 12 + length))
    }
    offset += 12 + length
    if (iend) break
  }
  if (!ihdr || !idat || !iend || offset !== input.byteLength) {
    throw new Error('UI/UX approval PNG structure is incomplete')
  }
  return Buffer.concat(kept)
}

function assertDirectOwnedRegularFile(path: string, directory: string): void {
  if (!isAbsolute(path)
    || realpathSync(dirname(resolve(path))) !== realpathSync(directory)) {
    throw new Error('UI/UX approval image must be directly inside the job outbox')
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const metadata = fstatSync(descriptor)
    const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.nlink !== 1 || !owned || metadata.size === 0
      || metadata.size > MAX_UI_APPROVAL_PNG_BYTES) {
      throw new Error('UI/UX approval image is not a safe regular file')
    }
  } finally {
    closeSync(descriptor)
  }
}

function reencodeUiApprovalPng(source: string, outbox: string, role: 'before' | 'after'): string {
  assertDirectOwnedRegularFile(source, outbox)
  const decoded = join(outbox, `.ui-approval-${role}-${randomUUID()}.decoded.png`)
  const result = Bun.spawnSync(
    ['/usr/bin/sips', '-s', 'format', 'png', source, '--out', decoded],
    { stdout: 'ignore', stderr: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C' } },
  )
  if (result.exitCode !== 0) {
    rmSync(decoded, { force: true })
    throw new Error(`UI/UX approval ${role} image could not be decoded`)
  }
  try {
    assertDirectOwnedRegularFile(decoded, outbox)
    const stripped = stripUiApprovalPngMetadata(readFileSync(decoded))
    const digest = createHash('sha256').update(stripped).digest('hex')
    // Every proposal round gets its own sealed source name even when (most
    // commonly for Before) the pixels match a prior round. Slack delivery
    // receipts are bound to the sealed path, so reusing a content-addressed
    // path here would silently omit that image from a revised proposal.
    const output = join(
      outbox,
      `ui-approval-${role}-${randomUUID()}-${digest.slice(0, 32)}.png`,
    )
    try {
      const metadata = lstatSync(output)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || !readFileSync(output).equals(stripped)) {
        throw new Error(`UI/UX approval ${role} sealed source conflicts`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      writeFileSync(output, stripped, { flag: 'wx', mode: 0o600 })
      chmodSync(output, 0o600)
    }
    return output
  } finally {
    rmSync(decoded, { force: true })
  }
}

export function reencodeUiApprovalImages(input: {
  outbox: string
  beforePath: string
  afterPath: string
}): { beforePath: string; afterPath: string } {
  const outbox = resolve(input.outbox)
  realpathSync(outbox)
  const beforePath = reencodeUiApprovalPng(input.beforePath, outbox, 'before')
  const afterPath = reencodeUiApprovalPng(input.afterPath, outbox, 'after')
  if (createHash('sha256').update(readFileSync(beforePath)).digest('hex')
    === createHash('sha256').update(readFileSync(afterPath)).digest('hex')) {
    throw new Error('UI/UX approval Before and After images are identical')
  }
  return { beforePath, afterPath }
}
