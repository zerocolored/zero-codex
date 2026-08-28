/**
 * Select the repository for an inbound Slack conversation.
 *
 * Every new Slack thread uses the physical Git project selected by the most
 * recent `zerochan` launch. `configuredRepo` remains in the function shape so
 * older migration callers can be upgraded without reading routes.json, but it
 * intentionally has no effect on new work.
 */
export function requireRepoRoute(
  _chatId: string,
  _configuredRepo: string | undefined,
  activeProjectRepo: string,
): string {
  const active = activeProjectRepo.trim()
  if (!active) throw new Error('active zerochan project is unavailable')
  return active
}

/**
 * A legacy thread already owns the repository captured when it was adopted.
 * Preserve that ownership across the Claude-to-Codex migration. Only rows
 * from before repo_path existed may use today's active zerochan project; old
 * routes.json values no longer redirect new or legacy-unpinned work.
 */
export function requireLegacyThreadRepoRoute(
  chatId: string,
  savedRepo: string | undefined,
  _configuredRepo: string | undefined,
  activeProjectRepo: string,
): string {
  const saved = savedRepo?.trim()
  return saved || requireRepoRoute(chatId, undefined, activeProjectRepo)
}
