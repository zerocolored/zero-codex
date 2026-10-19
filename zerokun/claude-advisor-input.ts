import { createHash } from 'crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from 'fs'
import { extname, join, resolve } from 'path'
import type { AdvisorInputSnapshot } from './advisor-input.ts'
import { requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'

export const CLAUDE_INPUT_FILE = /^attachment-[0-9a-f]{64}(?:\.[a-z0-9]{1,10})?$/
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const MAX_TOTAL_BYTES = 100 * 1024 * 1024

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
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
        || before.size > MAX_ATTACHMENT_BYTES || (total += before.size) > MAX_TOTAL_BYTES) {
        throw new Error('Claude attachment metadata or size is unsafe')
      }
      const bytes = readFileSync(fd)
      const after = fstatSync(fd), leaf = lstatSync(path)
      if (before.dev !== leaf.dev || before.ino !== leaf.ino || leaf.isSymbolicLink()
        || before.size !== bytes.length || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('Claude attachment changed while copying')
      }
      const extension = extname(path).toLowerCase()
      const name = `attachment-${createHash('sha256').update(bytes).digest('hex')}`
        + (/^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '')
      const destination = join(requestDir, name)
      if (![...copies.values()].includes(destination)) writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
      copies.set(source, destination)
    } finally { closeSync(fd) }
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
