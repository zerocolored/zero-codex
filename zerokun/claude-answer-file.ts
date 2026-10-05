import { createHash } from 'crypto'
import { lstatSync, realpathSync } from 'fs'
import { join } from 'path'
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { containsCredentialMaterial, normalizePublicGuardText, redactCredentialMaterial } from './public-output-guard.ts'

function decodeCredentialText(value: string): string {
  let decoded = value
  for (let round = 0; round < 4 && decoded.includes('%'); round += 1) {
    const next = normalizePublicGuardText(decoded.replace(/(?:%[0-9a-f]{2})+/gi, run => {
      try { return decodeURIComponent(run) } catch {
        return run.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      }
    }))
    if (next === decoded) break
    decoded = next
  }
  return decoded
}

/** Credential-shaped prose must not discard an otherwise complete review. */
export function sanitizeClaudeAnswer(response: string): { response: string; redacted: boolean } {
  const normalized = normalizePublicGuardText(response)
  const keyHeader = /-----(?:BEGIN|END)[ \t]+(?:[A-Z]+[ \t]+)*PRIVATE[ \t]+KEY-----/i
  // Decode only credential-bearing lines; unrelated encoded URLs stay intact.
  let pemPayload = false
  let sanitized = normalized.split('\n').map(line => {
    const decoded = decodeCredentialText(line)
    const isPayload = pemPayload && /^[ \t]*(?:[A-Za-z0-9+/=_.-]+|Proc-Type:.*|DEK-Info:.*)?[ \t\r]*$/i.test(decoded)
    pemPayload = /-----BEGIN[ \t]+(?:[A-Z]+[ \t]+)*PRIVATE[ \t]+KEY-----/i.test(decoded) || isPayload
    return isPayload || keyHeader.test(decoded) || containsCredentialMaterial(decoded)
      || /\bBearer\s+["'`<([{]/i.test(decoded) ? decoded : line
  }).join('\n')
  const replacement = '[credential removed]'
  // Serialized JSON, single-line PEM, and quoted/diff payloads are still keys.
  // Preserve intervening prose when BEGIN and END are merely cited separately.
  sanitized = sanitized.replace(/-----BEGIN[ \t]+(?:[A-Z]+[ \t]+)*PRIVATE[ \t]+KEY-----([\s\S]*?)-----END[ \t]+(?:[A-Z]+[ \t]+)*PRIVATE[ \t]+KEY-----/gi,
    (block, body: string, offset: number, text: string) => {
      const payload = decodeCredentialText(body).replace(/\\r\\n|\\n|\\r/g, '\n')
        .replace(/^[ \t]*(?:(?:[>+|]|-(?!-)|\d+:)[ \t]*)+/gm, '')
        .replace(/^[ \t]*(?:Proc-Type:|DEK-Info:)[^\r\n]*/gim, '')
        .split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      const prefix = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset).trim()
      const standalone = /^(?:(?:[>+|]|-|\d+:)\s*)*$/.test(prefix)
      const hasKeyBytes = payload.some(line => /[A-Za-z0-9+/=_.-]{16,}/.test(line))
      return standalone || hasKeyBytes || payload.every(line => /^[A-Za-z0-9+/=_.-]+$/.test(line))
        ? replacement : block
    })
  // A header mentioned in prose is not an unterminated key extending to EOF.
  // Consume the header and contiguous PEM payload, including legacy PEM metadata.
  const privateKey = /-----BEGIN[ \t]+(?:[A-Z]+[ \t]+)*PRIVATE[ \t]+KEY-----[ \t]*(?:(?:\r?\n|\\r\\n|\\n)[ \t]*(?:[A-Za-z0-9+/=_.-]+|Proc-Type:[^\r\n]*|DEK-Info:[^\r\n]*|(?=\r?\n))[ \t]*(?=\r?\n|\\r\\n|\\n|$|["']))*(?:[A-Za-z0-9+/=_.-]{16,}(?=[ \t]*(?:$|["'])))?/gi
  sanitized = sanitized.replace(privateKey, replacement)
  // Prefix-only guard matches must not retain a wrapped value or password tail.
  sanitized = sanitized.replace(/\b(?:Authorization\s*:\s*)?Bearer\s+(?:"(?:\\.|[^"\\\r\n])*(?:"|$)|'(?:\\.|[^'\\\r\n])*(?:'|$)|`(?:\\.|[^`\\\r\n])*(?:`|$)|<[^>\r\n]*(?:>|$)|\([^\)\r\n]*(?:\)|$)|\[[^\]\r\n]*(?:\]|$)|\{[^}\r\n]*(?:}|$))/gim, replacement)
  sanitized = sanitized.replace(/(?:password|passwd|api[_-]?key|access[_-]?key|secret|token)\s*[:=]\s*[^\r\n]*/gi,
    value => containsCredentialMaterial(value) ? replacement : value)
  if (sanitized === normalized && !containsCredentialMaterial(normalized)) return { response, redacted: false }
  return { response: redactCredentialMaterial(sanitized, replacement), redacted: true }
}

export const CLAUDE_ANSWER_FILE = 'answer.md'
export const MAX_CLAUDE_ANSWER_BYTES = 4 * 1024 * 1024
// JSON can expand one source byte to six (control-character escapes), plus
// the other advisors and ledger fields. Use the same bound on every restore.
export const MAX_ADVISOR_RESPONSE_CACHE_BYTES = 16 * MAX_CLAUDE_ANSWER_BYTES

export class ClaudeAnswerPendingError extends Error {
  readonly progressDigest: string
  constructor(message: string, raw: string | null) {
    super(message)
    this.progressDigest = createHash('sha256').update(raw ?? '').digest('hex')
  }
}

/** Let stable incomplete output settle without resending or waiting an hour. */
export class ClaudeResponseSettling {
  private key: string | undefined
  private since = 0
  constructor(private readonly durationMs = 10_000) {}
  reset(): void { this.key = undefined }
  exhausted(key: string, now: number): boolean {
    if (key !== this.key) { this.key = key; this.since = now }
    return now - this.since >= this.durationMs
  }
}

/** A fixed caller-owned output bound to the one-time send and terminal digest.
 * Never searches sessions or combines partial terminal snapshots.
 */
export function readClaudeAnswerFile(requestDir: string, marker: string, transcript: string): {
  response: string
  sha256: string
  bytes: number
} | null {
  if (!/^REQUEST_MARKER=[A-F0-9]{32}$/.test(marker)) throw new Error('invalid Claude answer request marker')
  const before = lstatSync(requestDir)
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077) !== 0
    || (process.getuid && before.uid !== process.getuid()) || realpathSync(requestDir) !== requestDir) {
    throw new Error('unsafe Claude answer directory')
  }
  const raw = readOptionalBoundedOwnerOnlyRegularFile(join(requestDir, CLAUDE_ANSWER_FILE), MAX_CLAUDE_ANSWER_BYTES)
  const after = lstatSync(requestDir)
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
    || before.uid !== after.uid || realpathSync(requestDir) !== requestDir) {
    throw new Error('Claude answer directory changed during read')
  }
  const nonce = marker.slice('REQUEST_MARKER='.length)
  const terminal = transcript.replace(/\r/g, '').split('\n').map(line => line.trim().replace(/^⏺\s*/, ''))
  // Claude renders hard line breaks even in recent-unwrapped on narrow panes.
  // Fold only bounded protocol records, never the answer body or snapshots.
  const records: { hash: string, end: number }[] = []
  const receiptPattern = new RegExp(`^CLAUDE_ANSWER_SAVED=${nonce}SHA256=([a-f0-9]{64})$`)
  for (let index = 0; index < terminal.length; index++) {
    if (!terminal[index] || (!terminal[index]!.startsWith('CLAUDE_ANSWER_SAVED=')
      && !'CLAUDE_ANSWER_SAVED='.startsWith(terminal[index]!))) continue
    let record = ''
    for (let end = index; end < Math.min(index + 32, terminal.length); end++) {
      record += terminal[end]!.replace(/\s/g, '')
      if (record.length > 160) break
      const match = receiptPattern.exec(record)
      if (match) { records.push({ hash: match[1]!, end }); break }
    }
  }
  // Only a truly empty output may fall back to a complete terminal answer.
  if (!raw && records.length === 0) return null
  if (!raw || records.length !== 1) throw new ClaudeAnswerPendingError('Claude answer file completion receipt unavailable', raw)
  const receipt = records[0]!
  const hash = receipt.hash
  if (createHash('sha256').update(raw).digest('hex') !== hash) {
    throw new ClaudeAnswerPendingError('Claude answer file digest mismatch', raw)
  }
  let terminalMarker = false
  for (let index = receipt.end + 1; index < terminal.length; index++) {
    if (!terminal[index] || (!terminal[index]!.startsWith('REQUEST_MARKER=')
      && !'REQUEST_MARKER='.startsWith(terminal[index]!))) continue
    let record = ''
    for (let end = index; end < Math.min(index + 32, terminal.length); end++) {
      record += terminal[end]!.replace(/\s/g, '')
      if (record === marker) { terminalMarker = true; break }
      if (record.length >= marker.length) break
    }
  }
  if (!terminalMarker) throw new ClaudeAnswerPendingError('Claude answer file terminal marker unavailable', raw)
  const lines = raw.replace(/\r\n/g, '\n').trimEnd().split('\n')
  const begin = `CLAUDE_ANSWER_BEGIN=${nonce}`
  const end = `CLAUDE_ANSWER_END=${nonce}`
  if (lines[0] !== begin || lines.at(-1) !== end
    || lines.filter(line => line === begin || line === end).length !== 2) {
    throw new ClaudeAnswerPendingError('Claude answer file boundaries mismatch', raw)
  }
  const response = lines.slice(1, -1).join('\n').trim()
  if (!response) throw new ClaudeAnswerPendingError('Claude answer file is empty', raw)
  return { response, sha256: hash, bytes: Buffer.byteLength(raw) }
}
