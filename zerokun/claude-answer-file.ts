import { createHash } from 'crypto'
import { lstatSync, realpathSync } from 'fs'
import { join } from 'path'
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'

export const CLAUDE_ANSWER_FILE = 'answer.md'
export const MAX_CLAUDE_ANSWER_BYTES = 4 * 1024 * 1024

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
    if (!terminal[index]!.startsWith('CLAUDE_ANSWER_SAVED=')) continue
    let record = ''
    for (let end = index; end < Math.min(index + 8, terminal.length); end++) {
      record += terminal[end]!.replace(/\s/g, '')
      if (record.length > 160) break
      const match = receiptPattern.exec(record)
      if (match) { records.push({ hash: match[1]!, end }); break }
    }
  }
  // Only a truly empty output may fall back to a complete terminal answer.
  if (!raw && records.length === 0) return null
  if (!raw || records.length !== 1) throw new Error('Claude answer file completion receipt unavailable')
  const receipt = records[0]!
  const hash = receipt.hash
  if (createHash('sha256').update(raw).digest('hex') !== hash) {
    throw new Error('Claude answer file digest mismatch')
  }
  let terminalMarker = false
  for (let index = receipt.end + 1; index < terminal.length; index++) {
    if (!terminal[index]!.startsWith('REQUEST_MARKER=')) continue
    let record = ''
    for (let end = index; end < Math.min(index + 8, terminal.length); end++) {
      record += terminal[end]!.replace(/\s/g, '')
      if (record === marker) { terminalMarker = true; break }
      if (record.length >= marker.length) break
    }
  }
  if (!terminalMarker) throw new Error('Claude answer file terminal marker unavailable')
  const lines = raw.replace(/\r\n/g, '\n').trimEnd().split('\n')
  const begin = `CLAUDE_ANSWER_BEGIN=${nonce}`
  const end = `CLAUDE_ANSWER_END=${nonce}`
  if (lines[0] !== begin || lines.at(-1) !== end
    || lines.filter(line => line === begin || line === end).length !== 2) {
    throw new Error('Claude answer file boundaries mismatch')
  }
  const response = lines.slice(1, -1).join('\n').trim()
  if (!response) throw new Error('Claude answer file is empty')
  return { response, sha256: hash, bytes: Buffer.byteLength(raw) }
}
