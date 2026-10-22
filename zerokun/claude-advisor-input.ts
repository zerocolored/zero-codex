import { createHash, randomBytes } from 'crypto'
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readSync, rmSync } from 'fs'
import { extname, join, resolve } from 'path'
import type { AdvisorInputSnapshot } from './advisor-input.ts'
import { requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { MAX_SLACK_ATTACHMENT_BYTES, MAX_SLACK_THREAD_ATTACHMENT_BYTES } from './slack-attachment-limits.ts'
import { writeAllSync } from './inbound-attachment-cache.ts'

export const CLAUDE_INPUT_FILE = /^attachment-[0-9a-f]{64}(?:\.[a-z0-9]{1,10})?$/

/** Copy only host-recorded inputs into the already authorized answer directory.
 * Never authorize the whole inbox/state root or change account permissions.
 */
export function prepareClaudeAdvisorInput(stateDir: string, requestDir: string,
  input: AdvisorInputSnapshot, additionalAttachments: string[] = []): {
    input: AdvisorInputSnapshot; rewriteText: (text: string) => string
  } {
  const state = requireManagedStateRoot(stateDir)
  requireManagedDirectory(state, requestDir)
  const copies = new Map<string, string>()
  let total = 0
  for (const source of new Set([...input.entries.flatMap(entry => entry.attachments), ...additionalAttachments])) {
    const path = resolve(source)
    // The host input ledger already selected these attachments. Their storage
    // location is not an authorization boundary: handoff restores them outside
    // the state directory, and future transports may use another location.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let temporary: string | undefined
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
        || before.size > MAX_SLACK_ATTACHMENT_BYTES || (total += before.size) > MAX_SLACK_THREAD_ATTACHMENT_BYTES) {
        throw new Error('Claude attachment metadata or size is unsafe')
      }
      temporary = join(requestDir, `.attachment-${randomBytes(16).toString('hex')}.partial`)
      const output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024)
      let received = 0
      try {
        for (;;) {
          const count = readSync(fd, chunk, 0, chunk.length, null)
          if (count === 0) break
          received += count
          if (received > before.size || received > MAX_SLACK_ATTACHMENT_BYTES) {
            throw new Error('Claude attachment grew while copying')
          }
          const bytes = chunk.subarray(0, count)
          hash.update(bytes)
          writeAllSync(output, bytes)
        }
      } finally { closeSync(output) }
      const after = fstatSync(fd), leaf = lstatSync(path)
      if (before.dev !== leaf.dev || before.ino !== leaf.ino || leaf.isSymbolicLink()
        || before.size !== received || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('Claude attachment changed while copying')
      }
      const extension = extname(path).toLowerCase()
      const name = `attachment-${hash.digest('hex')}`
        + (/^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '')
      const destination = join(requestDir, name)
      // Publish without replacing an existing leaf, then remove the temporary link.
      if (![...copies.values()].includes(destination)) linkSync(temporary, destination)
      rmSync(temporary)
      temporary = undefined
      copies.set(source, destination)
    } finally {
      closeSync(fd)
      if (temporary) rmSync(temporary, { force: true })
    }
  }
  // Keep the canonical revision/digest: only the advisor's read locations change.
  const remap = (text: string) => {
    for (const [source, destination] of [...copies].sort((a, b) => b[0].length - a[0].length)) {
      text = text.split(source).join(destination)
    }
    return text
  }
  return { rewriteText: remap, input: { ...input, transcript: remap(input.transcript), entries: input.entries.map(entry => ({
    ...entry, task: remap(entry.task), attachments: entry.attachments.map(path => copies.get(path)!),
  })) } }
}
