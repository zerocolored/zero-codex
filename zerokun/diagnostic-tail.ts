import { ftruncateSync, writeSync } from 'fs'

/** Two private, fixed-size segments: retain at least the last segment's worth
 * of bytes without unbounded logs or rewriting a megabyte on every chunk. */
export class DiagnosticTail {
  private slot = 0
  private offset = 0
  private totalBytes = 0
  private readonly starts = [0, 0]

  constructor(private readonly descriptors: readonly [number, number], private readonly limit = 1024 * 1024) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid diagnostic tail limit')
  }

  write(value: Uint8Array): void {
    let consumed = 0
    while (consumed < value.byteLength) {
      if (this.offset === this.limit) {
        this.slot = 1 - this.slot
        this.offset = 0
        this.starts[this.slot] = this.totalBytes
        ftruncateSync(this.descriptors[this.slot]!, 0)
      }
      const count = Math.min(value.byteLength - consumed, this.limit - this.offset)
      const written = writeSync(this.descriptors[this.slot]!, value, consumed, count, this.offset)
      if (written === 0) throw new Error('diagnostic tail write made no progress')
      this.offset += written
      this.totalBytes += written
      consumed += written
    }
  }

  summary() {
    return { totalBytes: this.totalBytes, segmentLimit: this.limit, latestSegment: this.slot,
      segmentStartBytes: [...this.starts] }
  }
}
