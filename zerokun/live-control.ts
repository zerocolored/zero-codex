import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  renameSync,
  rmSync,
} from 'fs'
import { basename, join } from 'path'
import { randomBytes } from 'crypto'
import {
  ensureManagedDirectory,
  requireManagedDirectory,
  requireManagedStateRoot,
} from './managed-path.ts'

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

function safeComponent(value: string, label: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '_')
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error(`${label} is invalid`)
  }
  return normalized
}

export function liveControlInputDir(stateDirInput: string, jobId: string): string {
  const stateDir = requireManagedStateRoot(stateDirInput)
  const root = ensureManagedDirectory(stateDir, join(stateDir, 'live-input'))
  return ensureManagedDirectory(stateDir, join(root, safeComponent(jobId, 'job id')))
}

/** Only this complete Slack message is a deterministic host-side cancel. */
export function isSlackInterruptCommand(text: string): boolean {
  return text.normalize('NFKC').trim() === '中止'
}

/** Strip only Zeroちゃん's plain or labelled mention; other mentions remain user input. */
export function stripSlackUserMention(text: string, userId: string | undefined): string {
  if (!userId || !/^[A-Z0-9]+$/i.test(userId)) return text
  return text.replace(new RegExp(`<@${userId}(?:\\|[^>]*)?>`, 'gi'), ' ')
}

/** Socket events and recovery polls must classify the same visible message identically. */
export function normalizeSlackInboundText(
  text: string,
  botUserId: string | undefined,
  _isDirectMessage: boolean,
): string {
  // Slack can preserve an explicit app mention even inside an IM.  The
  // address itself is redundant there, but it must still be removed before
  // exact host-side commands such as `<@BOT> 中止` are classified.
  return stripSlackUserMention(text, botUserId).trim()
}

/**
 * Give an already-running App Server a stable per-job read root. Copying is
 * complete before the control row becomes ready, so Codex never observes a
 * partial attachment and cannot read another job's inbox.
 */
export function copyLiveControlAttachments(options: {
  stateDir: string
  jobId: string
  messageId: string
  attachments: string[]
}): string[] {
  const stateDir = requireManagedStateRoot(options.stateDir)
  const root = liveControlInputDir(stateDir, options.jobId)
  const messageDir = ensureManagedDirectory(
    stateDir,
    join(root, safeComponent(options.messageId, 'Slack message id')),
  )
  requireManagedDirectory(stateDir, messageDir)
  return options.attachments.map((source, index) => {
    const sourceMetadata = lstatSync(source)
    const ownerMatches = typeof process.getuid !== 'function'
      || sourceMetadata.uid === process.getuid()
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()
      || sourceMetadata.nlink !== 1 || !ownerMatches
      || sourceMetadata.size < 0 || sourceMetadata.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`unsafe live control attachment: ${source}`)
    }
    const name = `${String(index).padStart(3, '0')}-${safeComponent(basename(source), 'attachment')}`
    const destination = join(messageDir, name)
    try {
      const current = lstatSync(destination)
      const currentOwner = typeof process.getuid !== 'function' || current.uid === process.getuid()
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || !currentOwner || current.size !== sourceMetadata.size) {
        throw new Error(`unsafe existing live control attachment: ${destination}`)
      }
      return destination
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = join(
      messageDir,
      `.${name}.partial-${process.pid}-${randomBytes(6).toString('hex')}`,
    )
    try {
      copyFileSync(source, temporary, constants.COPYFILE_EXCL)
      chmodSync(temporary, 0o600)
      const copied = lstatSync(temporary)
      const copiedOwner = typeof process.getuid !== 'function' || copied.uid === process.getuid()
      if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1
        || !copiedOwner || copied.size !== sourceMetadata.size) {
        throw new Error(`live control attachment copy is invalid: ${temporary}`)
      }
      renameSync(temporary, destination)
      return destination
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  })
}
