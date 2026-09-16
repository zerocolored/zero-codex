import { createHash } from 'crypto'
import { lstatSync } from 'fs'
import { join, relative, sep } from 'path'
import { ensureManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { atomicWritePrivateFile } from './safe-file.ts'
import { containsCredentialMaterial } from './public-output-guard.ts'

export const MAX_CLAUDE_DIAGNOSTIC_TRANSCRIPT_BYTES = 64 * 1024
export const MAX_CLAUDE_DIAGNOSTIC_FILE_BYTES = 512 * 1024

export type ClaudeResponseAnalysis = {
  response: string | null
  code: 'complete' | 'invalid-marker' | 'marker-count-mismatch'
    | 'prompt-boundary-mismatch' | 'empty-response' | 'unexpected-trailing-content'
  markerLines: number[]
  exactOccurrences: number
  wrappedMarkerPairs: number[]
}

export type ClaudeDiagnosticRead = {
  requestedLines: number
  observedAt: string
  stateBefore: { status?: string; sequence?: number }
  stateAfter?: { status?: string; sequence?: number }
  outcome: ClaudeResponseAnalysis['code'] | 'state-changed' | 'identity-changed' | 'read-failed' | 'failure-snapshot'
  analysis?: Omit<ClaudeResponseAnalysis, 'response'>
}

/** Capture a failing nonterminal turn too, without treating it as an answer. */
export async function captureClaudeFailureDiagnostic<T extends { agent_status?: string; state_change_seq?: number }>(options: {
  getState: () => Promise<T>
  readTranscript: () => Promise<string>
  matchesIdentity: (state: T) => boolean
  onError?: (error: unknown) => void
}): Promise<{ read: ClaudeDiagnosticRead; transcript?: string }> {
  const read: ClaudeDiagnosticRead = {
    requestedLines: 1200, observedAt: new Date().toISOString(), stateBefore: {}, outcome: 'read-failed',
  }
  try {
    const before = await options.getState()
    read.stateBefore = { status: before.agent_status, sequence: before.state_change_seq }
    if (!options.matchesIdentity(before)) { read.outcome = 'identity-changed'; return { read } }
    const transcript = await options.readTranscript()
    const after = await options.getState()
    read.stateAfter = { status: after.agent_status, sequence: after.state_change_seq }
    if (!options.matchesIdentity(after)) { read.outcome = 'identity-changed'; return { read } }
    read.outcome = before.state_change_seq === after.state_change_seq && before.agent_status === after.agent_status
      ? 'failure-snapshot' : 'state-changed'
    return { read, transcript }
  } catch (error) {
    // Let the owner retain a containment failure without leaking transport
    // error text into the document or throwing past workspace cleanup.
    try { options.onError?.(error) } catch {}
    return { read }
  }
}

export type ClaudeDiagnosticReceipt = {
  status: 'saved' | 'unavailable'
  path?: string
  sha256?: string
}

/** Local evidence only: never include the document in an MCP response or Slack. */
export function saveClaudeResponseDiagnostic(options: {
  stateDir: string
  directory: string
  attempt: string
  reads: ClaudeDiagnosticRead[]
  transcript?: string
  transcriptReadIndex?: number
  phase?: string
  round?: number
}): ClaudeDiagnosticReceipt {
  try {
    if (!/^[a-f0-9]{32}$/.test(options.attempt)) return { status: 'unavailable' }
    const state = requireManagedStateRoot(options.stateDir)
    const directory = ensureManagedDirectory(options.stateDir, options.directory)
    // Existing managed children may be readable by others; diagnostics may not.
    let current = state
    for (const component of relative(state, directory).split(sep).filter(Boolean)) {
      current = join(current, component)
      if ((lstatSync(current).mode & 0o077) !== 0) return { status: 'unavailable' }
    }
    const original = options.transcript ?? ''
    // Suppress the whole transcript if a credential is detected, including
    // private-key bodies. Analyze first; redaction must not alter parser verdicts.
    const suppressed = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.test(original)
      || containsCredentialMaterial(original)
    const sanitized = suppressed ? '[transcript withheld: credential material]' : original
      .replace(/https?:\/\/[^\s<>"'`]+/gi, '[url redacted]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
      .replace(/\/(?:Users|home)\/[^/\s]+/g, '/[user]')
    const bytes = Buffer.from(sanitized, 'utf8')
    // Keep both boundaries: prompt echo at the start, terminal footer at the end.
    const truncated = bytes.length > MAX_CLAUDE_DIAGNOSTIC_TRANSCRIPT_BYTES
    const half = MAX_CLAUDE_DIAGNOSTIC_TRANSCRIPT_BYTES / 2 - 64
    const text = truncated
      ? `${bytes.subarray(0, half).toString('utf8')}\n[diagnostic middle omitted]\n${bytes.subarray(-half).toString('utf8')}`
      : sanitized
    const document = `${JSON.stringify({
      version: 1,
      capturedAt: new Date().toISOString(),
      source: 'herdr-recent-unwrapped',
      scope: 'bounded-terminal-snapshot-not-full-session',
      phase: options.phase,
      round: options.round,
      reads: options.reads.slice(-3),
      transcript: {
        available: options.transcript !== undefined,
        readIndex: options.transcriptReadIndex,
        originalBytes: Buffer.byteLength(original),
        storedBytes: Buffer.byteLength(text),
        truncated,
        credentialSuppressed: suppressed,
        sanitized: text !== original,
        text,
      },
    })}\n`
    if (Buffer.byteLength(document) > MAX_CLAUDE_DIAGNOSTIC_FILE_BYTES) return { status: 'unavailable' }
    const path = join(directory, `claude-response-${options.attempt}.json`)
    atomicWritePrivateFile(path, document)
    return {
      status: 'saved',
      path: relative(state, path),
      sha256: createHash('sha256').update(document).digest('hex'),
    }
  } catch {
    // Diagnostics must never bypass cleanup or turn an advisor failure into a
    // task failure. Do not include exception text (which may contain output).
    return { status: 'unavailable' }
  }
}
