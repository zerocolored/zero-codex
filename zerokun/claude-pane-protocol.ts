import type { ClaudeExecutableSnapshot } from './claude-executable.ts'
import type { ProcessIdentity } from './process-generation.ts'

export interface ClaudePaneManifest {
  version: 1
  nonce: string
  jobId: string
  cwd: string
  socketPath: string
  registrationPath: string
  executable: ClaudeExecutableSnapshot
  arguments: string[]
  environment: Record<string, string>
  fingerprint?: { allow: string; deny: string }
}

export type ClaudePanePacket =
  | { type: 'hello'; nonce: string; identity: ProcessIdentity }
  | { type: 'start' }
  | { type: 'ready'; identity: ProcessIdentity }
  | { type: 'input'; data: string }
  | { type: 'end-input' }
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'stop' }
  | { type: 'exit'; code: number }
  | { type: 'failure'; message: string }

/** A bounded frame decoder shared by both ends. No shell or terminal parsing. */
export class ClaudePaneFrames {
  private buffered = ''
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  constructor(private receive: (value: ClaudePanePacket) => void, private maxBytes = 12 * 1024 * 1024) {}
  push(bytes: Uint8Array): void {
    this.buffered += this.decoder.decode(bytes, { stream: true })
    let end: number
    while ((end = this.buffered.indexOf('\n')) !== -1) {
      const line = this.buffered.slice(0, end)
      this.buffered = this.buffered.slice(end + 1)
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error('Claude pane frame exceeds limit')
      const packet = JSON.parse(line)
      if (!packet || typeof packet !== 'object' || Array.isArray(packet) || typeof packet.type !== 'string') {
        throw new Error('invalid Claude pane frame')
      }
      this.receive(packet as ClaudePanePacket)
    }
    if (Buffer.byteLength(this.buffered) > this.maxBytes) throw new Error('Claude pane frame exceeds limit')
  }
  finish(): void {
    this.buffered += this.decoder.decode()
    if (this.buffered.length) throw new Error('Claude pane stream ended inside a frame')
  }
}
