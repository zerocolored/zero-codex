import { homedir, userInfo } from 'os'
import { assertClaudeAuthStatus } from './claude-auth-status.ts'
import { buildCodexChildEnvironment } from './codex-executor.ts'
import { resolveClaudeExecutableLookup } from './ephemeral-claude-session.ts'

/** Keep native subscription/keychain context. Do not copy Slack credentials,
 * API-key overrides, inherited Claude sessions, or arbitrary preload options. */
export function claudeMainlineEnvironment(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const environment = buildCodexChildEnvironment(source)
  environment.HOME ??= homedir()
  environment.USER ??= userInfo().username
  environment.LOGNAME ??= environment.USER
  if (source.__CF_USER_TEXT_ENCODING) environment.__CF_USER_TEXT_ENCODING = source.__CF_USER_TEXT_ENCODING
  environment.CLAUDE_CODE_SDK_READS_SESSION_STATE = '1'
  environment.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
  environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  return environment
}

/** Existing subscription only; this never starts login or changes auth. */
export function assertClaudeMainlineReady(cwd: string): string {
  const executable = resolveClaudeExecutableLookup()
  const result = Bun.spawnSync([executable, 'auth', 'status', '--json'], {
    cwd, env: claudeMainlineEnvironment(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    timeout: 15_000, killSignal: 'SIGKILL',
  })
  assertClaudeAuthStatus({ exitCode: result.exitCode, stdout: result.stdout.toString(),
    stderr: result.stderr.toString(), timedOut: result.signalCode != null })
  return executable
}
