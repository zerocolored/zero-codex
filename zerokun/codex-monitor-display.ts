import type { AppServerNotification } from './codex-app-server-session'
import { containsCredentialMaterial, normalizePublicGuardText } from './public-output-guard'

const MAX_MONITOR_TEXT_CHARS = 600
const MAX_MONITOR_INPUT_CHARS = 8_192
const MAX_TRACKED_MONITOR_ITEMS = 512

const SECRET_PATTERNS = [
  /\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/i,
  /\b(?:xox[baprs]|xapp)-[A-Za-z0-9-]{8,}\b/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|password|secret)\s*[:=]\s*\S+/i,
] as const

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stripUnsafeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ')
}

/**
 * Produce one bounded terminal-safe line. This is deliberately stricter than
 * Slack result sanitization: the monitor is a live glanceable view, not the
 * authoritative answer or diagnostic log.
 */
export function sanitizeMonitorText(
  value: unknown,
  maxChars = MAX_MONITOR_TEXT_CHARS,
): string | null {
  if (typeof value !== 'string' || value.length > MAX_MONITOR_INPUT_CHARS || maxChars < 1) {
    return null
  }
  let text = normalizePublicGuardText(stripUnsafeTerminalText(value)).trim()
  if (!text) return null
  if (containsCredentialMaterial(text) || SECRET_PATTERNS.some(pattern => pattern.test(text))) {
    return null
  }
  if (/(?:\{|\[)\s*"(?:[^"\\]|\\.){1,128}"\s*:/.test(text)) return null
  if (/^(?:\{|\[)/.test(text)) {
    try {
      JSON.parse(text)
      return null
    } catch {}
  }
  text = text
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/[^\s<>"']+/g, '（URLを省略）')
    .replace(
      /(^|[\s=:(,"'`\[])\/(?!\/)[^\s<>"'`)\]}、。！？]*/gm,
      '$1（内部パスを省略）',
    )
    .replace(/(^|[\s=:(,"'`\[])~\/[^\s<>"'`)\]}、。！？]*/gm, '$1（内部パスを省略）')
    .replace(/\b[A-Za-z]:\\[^\s<>"']+/g, '（内部パスを省略）')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '（内部IDを省略）')
    .replace(/\b[0-9a-f]{24,}\b/gi, '（内部IDを省略）')
    .replace(/\b[CUWDT](?=[A-Z0-9]{8,}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/g, '（内部IDを省略）')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '（長い識別子を省略）')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  if (text.length > maxChars) text = `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
  return text
}

type CommandCategory = 'test' | 'quality' | 'build' | 'browser' | 'git' | 'general'

function commandCategory(command: unknown): CommandCategory {
  if (typeof command !== 'string') return 'general'
  const lower = command.toLowerCase()
  if (/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:pytest|unittest|vitest|jest)\b|\b(?:go|cargo|swift)\s+test\b/.test(lower)) return 'test'
  if (/\b(?:tsc|eslint|biome|mypy|ruff|typecheck|lint)\b/.test(lower)) return 'quality'
  if (/\b(?:build|compile)\b/.test(lower)) return 'build'
  if (/\b(?:playwright|browser|chrome|screenshot|curl)\b/.test(lower)) return 'browser'
  if (/(?:^|[;&|]\s*)git\s/.test(lower)) return 'git'
  return 'general'
}

const commandStarted: Record<CommandCategory, string> = {
  test: '› テストを実行しています',
  quality: '› コード品質を確認しています',
  build: '› ビルドを確認しています',
  browser: '› 実際の動作を確認しています',
  git: '› Gitの状態を確認しています',
  general: '› ファイルや設定を確認しています',
}

const commandCompleted: Partial<Record<CommandCategory, string>> = {
  test: '✓ テストが完了しました',
  quality: '✓ コード品質の確認が完了しました',
  build: '✓ ビルド確認が完了しました',
  browser: '✓ 動作確認が完了しました',
}

const commandFailed: Record<CommandCategory, string> = {
  test: '⚠ テストで確認事項が見つかりました',
  quality: '⚠ コード品質の確認で問題が見つかりました',
  build: '⚠ ビルド確認で問題が見つかりました',
  browser: '⚠ 動作確認で問題が見つかりました',
  git: '⚠ Gitの確認で問題が見つかりました',
  general: '⚠ コマンド実行で確認事項が見つかりました',
}

function itemFailed(item: Record<string, unknown>): boolean {
  const status = typeof item.status === 'string' ? item.status.toLowerCase() : ''
  return ['failed', 'error', 'interrupted', 'cancelled', 'canceled'].includes(status)
    || (typeof item.exitCode === 'number' && Number.isFinite(item.exitCode) && item.exitCode !== 0)
}

function itemSucceeded(item: Record<string, unknown>): boolean {
  const status = typeof item.status === 'string' ? item.status.toLowerCase() : ''
  return ['completed', 'success', 'succeeded'].includes(status)
    && !(typeof item.exitCode === 'number' && item.exitCode !== 0)
}

function looksLikeProgressProbe(text: string): boolean {
  return text.includes('[ZERO_PROGRESS_BEGIN:') || text.includes('[ZERO_PROGRESS_END:')
}

type TrackedMonitorItem = {
  kind: 'command' | 'review' | 'tool' | 'file' | 'image'
  category?: CommandCategory | 'browser' | 'tool'
}

function boundedItemId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null
}

/** Stateful, bounded projection from validated App Server notifications. */
export class CodexMonitorDisplay {
  private readonly seenThisTurn = new Set<string>()
  private readonly activeItems = new Map<string, TrackedMonitorItem>()
  private activeTurnId: string | null = null
  private lastLine: string | null = null

  observe(notification: AppServerNotification, parentThreadId: string | null): string[] {
    try {
      if (!parentThreadId || notification.params.threadId !== parentThreadId) return []
      const line = this.project(notification)
      if (!line || line === this.lastLine) return []
      this.lastLine = line
      return [line]
    } catch {
      return []
    }
  }

  private once(key: string, line: string): string | null {
    if (this.seenThisTurn.has(key)) return null
    this.seenThisTurn.add(key)
    return line
  }

  private track(item: Record<string, unknown>, value: TrackedMonitorItem): void {
    const itemId = boundedItemId(item.id)
    if (!itemId || this.activeItems.has(itemId)
      || this.activeItems.size >= MAX_TRACKED_MONITOR_ITEMS) return
    this.activeItems.set(itemId, value)
  }

  private take(item: Record<string, unknown>): TrackedMonitorItem | null {
    const itemId = boundedItemId(item.id)
    if (!itemId) return null
    const tracked = this.activeItems.get(itemId) ?? null
    this.activeItems.delete(itemId)
    return tracked
  }

  private hasActive(kind: TrackedMonitorItem['kind'], category?: TrackedMonitorItem['category']): boolean {
    return [...this.activeItems.values()].some(item => (
      item.kind === kind && (category === undefined || item.category === category)
    ))
  }

  private project(notification: AppServerNotification): string | null {
    if (notification.method === 'turn/started') {
      const turn = plainRecord(notification.params.turn)
      const turnId = boundedItemId(turn?.id)
      if (!turnId) return null
      this.activeTurnId = turnId
      this.activeItems.clear()
      this.seenThisTurn.clear()
      this.lastLine = null
      return '● 作業を開始しました'
    }
    if (!this.activeTurnId) return null
    if (notification.method === 'error') {
      if (notification.params.turnId !== this.activeTurnId || notification.params.willRetry === true) {
        return null
      }
      return this.once('turn-error', '⚠ 処理中に問題が発生しました')
    }
    if (notification.method === 'turn/completed') {
      const turn = plainRecord(notification.params.turn)
      if (turn?.id !== this.activeTurnId) return null
      const status = typeof turn.status === 'string' ? turn.status.toLowerCase() : ''
      const line = status === 'failed'
        ? this.once('turn-failed', '⚠ この段階の処理で問題が発生しました')
        : status === 'interrupted'
          ? this.once('turn-interrupted', '⚠ この段階の作業が中断されました')
          : null
      this.activeItems.clear()
      this.activeTurnId = null
      return line
    }
    if (notification.method !== 'item/started' && notification.method !== 'item/completed') {
      return null
    }
    if (notification.params.turnId !== this.activeTurnId) return null
    const item = plainRecord(notification.params.item)
    if (!item || typeof item.type !== 'string') return null
    const completed = notification.method === 'item/completed'

    if (item.type === 'agentMessage' || item.type === 'agent_message') {
      if (!completed || typeof item.text !== 'string') return null
      if (item.phase === 'commentary') {
        if (looksLikeProgressProbe(item.text)) return null
        const text = sanitizeMonitorText(item.text)
        return text ? `💬 ${text}` : this.once('commentary-redacted', '💬 状況を確認しています')
      }
      if (item.phase === undefined || item.phase === null || item.phase === 'final_answer') {
        return this.once('final-answer', '✓ 回答をまとめました')
      }
      return null
    }

    if (item.type === 'commandExecution') {
      const category = commandCategory(item.command)
      if (!completed) {
        this.track(item, { kind: 'command', category })
        return this.once(`command-start:${category}`, commandStarted[category])
      }
      const tracked = this.take(item)
      if (tracked?.kind !== 'command' || tracked.category !== category) return null
      if (itemFailed(item)) return this.once(`command-failed:${category}`, commandFailed[category])
      const success = commandCompleted[category]
      return success && itemSucceeded(item) && !this.hasActive('command', category)
        ? this.once(`command-complete:${category}`, success)
        : null
    }

    if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') {
      if (!completed) {
        this.track(item, { kind: 'review' })
        return this.once('review-start', '› 補助レビューを進めています')
      }
      const tracked = this.take(item)
      if (tracked?.kind !== 'review') return null
      if (itemFailed(item) || item.kind === 'interrupted') {
        return this.once('review-failed', '⚠ 補助レビューの一部を利用できませんでした')
      }
      const succeeded = item.type === 'subAgentActivity'
        ? item.kind === 'completed'
        : itemSucceeded(item)
      return succeeded && !this.hasActive('review')
        ? this.once('review-complete', '✓ 補助レビューを確認しました')
        : null
    }

    if (item.type === 'mcpToolCall') {
      const descriptor = `${String(item.server ?? '')} ${String(item.tool ?? '')}`.toLowerCase()
      const category = /browser|chrome|playwright|computer/.test(descriptor) ? 'browser' : 'tool'
      if (!completed) {
        this.track(item, { kind: 'tool', category })
        return this.once(
          `${category}-start`,
          category === 'browser' ? '› 画面を確認しています' : '› ツールを使って確認しています',
        )
      }
      const tracked = this.take(item)
      if (tracked?.kind !== 'tool' || tracked.category !== category) return null
      if (itemFailed(item)) {
        return this.once(
          `${category}-failed`,
          category === 'browser' ? '⚠ 画面確認の一部を利用できませんでした' : '⚠ ツール確認の一部を利用できませんでした',
        )
      }
      return category === 'browser' && itemSucceeded(item)
        && !this.hasActive('tool', category)
        ? this.once('browser-complete', '✓ 画面を確認しました')
        : null
    }

    if (item.type === 'fileChange') {
      if (!completed) {
        this.track(item, { kind: 'file' })
        return this.once('files-start', '✎ ファイルを更新しています')
      }
      const tracked = this.take(item)
      if (tracked?.kind !== 'file') return null
      if (itemFailed(item)) {
        return this.once('files-failed', '⚠ ファイル更新で確認事項が見つかりました')
      }
      return itemSucceeded(item) && !this.hasActive('file')
        ? this.once('files-complete', '✓ ファイル更新を確認しました')
        : null
    }

    if (item.type === 'imageView') {
      if (!completed) {
        this.track(item, { kind: 'image' })
        return this.once('image-view', '› 画像を確認しています')
      }
      this.take(item)
    }
    return null
  }
}
