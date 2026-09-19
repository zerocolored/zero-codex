import { createHash } from 'crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'fs'
import { resolveArtifactSource } from './artifact-source.ts'

/** Only explicit attachment declarations are retained; prose is not an approval classifier. */
export class ContinuedArtifactMessage {
  private pending?: { message: string; revision: number; files: Array<{ path: string; digest: string }> }

  constructor(private readonly outbox: string, private readonly additionalRoots: readonly string[] = []) {}

  private fingerprint(path: string): string {
    path = resolveArtifactSource(path, [this.outbox, ...this.additionalRoots])
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 50 * 1024 * 1024) {
        throw new Error('invalid attachment')
      }
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(64 * 1024)
      let total = 0
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, null)
        if (count === 0) break
        total += count
        if (total > 50 * 1024 * 1024) throw new Error('attachment grew beyond limit')
        hash.update(buffer.subarray(0, count))
      }
      return hash.digest('hex')
    } finally { closeSync(fd) }
  }

  observe(message: string, revision: number): void {
    if (this.pending?.revision !== revision) this.pending = undefined
    const opening = /<zerokun_files>/i.exec(message)
    if (!opening) return
    // Even an empty/malformed new declaration replaces the old one, never resurrect it.
    this.pending = undefined
    const marker = /^<zerokun_files>([\s\S]*?)<\/zerokun_files>\s*$/i.exec(message.slice(opening.index))
    if (!marker || message.length > 64 * 1024) return
    try {
      const files: unknown = JSON.parse(marker[1]!)
      if (!Array.isArray(files) || files.length === 0 || files.length > 10
        || !files.every(path => typeof path === 'string')) return
      const retained = [...new Set(files as string[])].flatMap(path => {
        try { return [{ path, digest: this.fingerprint(path) }] } catch { return [] }
      })
      if (retained.length > 0) this.pending = { message, revision, files: retained }
    } catch { /* Invalid declarations are handled by the normal final delivery path. */ }
  }

  resolve(finalMessage: string, revision: number, goalStatus: string | undefined): string {
    // The current answer always wins when it declares, replaces, or withdraws attachments.
    if (/<zerokun_files>/i.test(finalMessage) || !['blocked', 'paused'].includes(goalStatus ?? '')
      || !this.pending || this.pending.revision !== revision) return finalMessage
    try {
      if (this.pending.files.some(file => this.fingerprint(file.path) !== file.digest)) return finalMessage
    } catch { return finalMessage }
    // Preserve the actual question and explanation, not just the image paths.
    return this.pending.message
  }
}
