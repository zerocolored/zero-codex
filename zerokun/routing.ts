/**
 * Select the repository for an inbound Slack conversation.
 *
 * DMs intentionally use the launcher repository. Public/private channels must
 * be explicitly routed so that an access-list entry alone can never make a
 * request run in whichever directory happened to launch the gateway.
 */
export function requireRepoRoute(
  chatId: string,
  configuredRepo: string | undefined,
  dmDefaultRepo: string,
): string {
  if (chatId.startsWith('D')) return dmDefaultRepo
  const configured = configuredRepo?.trim()
  if (!configured) throw new Error(`channel ${chatId} has no configured repo_path`)
  return configured
}

/**
 * A legacy thread already owns the repository captured when it was adopted.
 * Preserve that ownership across the Claude-to-Codex migration, including for
 * DMs; only rows from before repo_path existed may use today's route/default.
 */
export function requireLegacyThreadRepoRoute(
  chatId: string,
  savedRepo: string | undefined,
  configuredRepo: string | undefined,
  dmDefaultRepo: string,
): string {
  const saved = savedRepo?.trim()
  return saved || requireRepoRoute(chatId, configuredRepo, dmDefaultRepo)
}
