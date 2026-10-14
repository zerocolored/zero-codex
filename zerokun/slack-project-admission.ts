import { lstatSync } from 'fs'
import { join } from 'path'
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { isSlackInterruptCommand, normalizeSlackInboundText } from './live-control.ts'

/** The early audience gate lets stop requests reach exact job/epoch validation.
 * This exemption does not itself authorize or enqueue a stop. */
export function isSlackProjectStop(text: string, botUserId?: string, isDM = false): boolean {
  return isSlackInterruptCommand(normalizeSlackInboundText(text, botUserId, isDM))
}

export class SlackProjectDisconnectedError extends Error {
  constructor() {
    super('このプロジェクトのSlackアプリは未設定です。zerochan set slack-app で接続してください。')
    this.name = 'SlackProjectDisconnectedError'
  }
}

/** Read only local, non-secret policy. Missing configuration retains legacy behavior.
 * An atomic config replacement is the admission boundary across all app processes;
 * already durable deliveries never pass through this check again.
 */
export function assertSlackProjectAdmission(repoPath: string, messageTs: string, options: { allowDisconnectedStop?: boolean } = {}): void {
  const dir = join(repoPath, '.zerochan')
  try {
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
      throw new Error('プロジェクトのSlack受付設定を安全に読み取れません')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (readOptionalBoundedOwnerOnlyRegularFile(join(dir, 'slack-app-unset.json'), 32 * 1024) !== null && !options.allowDisconnectedStop) {
    throw new SlackProjectDisconnectedError()
  }
  const raw = readOptionalBoundedOwnerOnlyRegularFile(join(dir, 'config.json'), 16 * 1024)
  if (raw === null) return
  const config = JSON.parse(raw)
  if (config.slackAppId === null && !options.allowDisconnectedStop) throw new SlackProjectDisconnectedError()
  if (config.slackAcceptAfter !== undefined) {
    if (!Number.isSafeInteger(config.slackAcceptAfter) || config.slackAcceptAfter <= 0) {
      throw new Error('プロジェクトのSlack受付時刻が不正です')
    }
    const timestamp = Number(messageTs) * 1000
    if (!Number.isFinite(timestamp) || timestamp < config.slackAcceptAfter) {
      throw new SlackProjectDisconnectedError()
    }
  }
}
