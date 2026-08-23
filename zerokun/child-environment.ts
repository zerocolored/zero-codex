const BASE_KEYS = new Set([
  'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'NO_COLOR',
])

const RUNTIME_LAUNCH_KEYS = new Set([
  'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'NO_COLOR',
])

const RUNTIME_SERVICE_KEYS = new Set([
  'ZEROKUN_CATCHUP_CHANNELS_PER_SWEEP', 'ZEROKUN_CATCHUP_HISTORY_PAGES_PER_SWEEP',
  'ZEROKUN_CATCHUP_LIMIT', 'ZEROKUN_CATCHUP_PARENT_PAGES_PER_SWEEP',
  'ZEROKUN_CATCHUP_REPLY_PAGES_PER_SWEEP', 'ZEROKUN_CATCHUP_WINDOW_H',
  'ZEROKUN_CODEX_BIN', 'ZEROKUN_GC_INTERVAL_MS', 'ZEROKUN_IDEMPOTENCY_RETENTION_DAYS',
  'ZEROKUN_INBOUND_MAX_ATTEMPTS', 'ZEROKUN_JOB_MODEL',
  'ZEROKUN_JOB_POLL_MS', 'ZEROKUN_JOB_RUNNER', 'ZEROKUN_JOB_TIMEOUT_MS',
  'ZEROKUN_MAX_JOBS_PER_SESSION', 'ZEROKUN_RETENTION_DAYS',
  'ZEROKUN_RUNTIME_LOG_MAX_BYTES', 'ZEROKUN_SLACK_HTTP_TIMEOUT_MS',
  'ZEROKUN_TMUX_SESSION', 'ZEROKUN_UPDATE_REQUEST', 'ZEROKUN_UPDATE_WAIT_SECONDS',
  'ZEROKUN_UPDATE_WORKER_TIMEOUT_MS',
])

const UPDATE_KEYS = new Set([
  'ZEROKUN_REPO_DIR', 'ZEROKUN_STATE_DIR', 'ZEROKUN_PROJECT_DIR',
  'ZEROKUN_LEGACY_CUTOVER',
  'ZEROKUN_CODEX_BIN',
  'ZEROKUN_UPDATE_BRANCH', 'ZEROKUN_UPDATE_WAIT_SECONDS', 'ZEROKUN_SETUP_SCRIPT',
  'ZEROKUN_JOB_RUNNER', 'ZEROKUN_TMUX_PATH',
  'ZEROKUN_UPDATE_STARTUP_TIMEOUT_MS',
  'ZEROKUN_UPDATE_HEALTH_TIMEOUT_MS', 'ZEROKUN_UPDATE_GIT_TIMEOUT_MS',
  'ZEROKUN_UPDATE_VERIFY_TIMEOUT_MS', 'ZEROKUN_UPDATE_SETUP_TIMEOUT_MS',
  'ZEROKUN_UPDATE_WORKER_TIMEOUT_MS', 'ZEROKUN_LAUNCHCTL_BIN',
])

const SLACK_TOKEN_KEYS = new Set(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'])
const RUNTIME_NETWORK_OVERRIDE_KEYS = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'AWS_CA_BUNDLE',
  'GLOBAL_AGENT_HTTP_PROXY', 'npm_config_proxy', 'npm_config_https_proxy',
  'BUN_OPTIONS', 'BUN_CONFIG_PRELOAD', 'NODE_OPTIONS',
])
const TEST_CONTROL_KEYS = new Set([
  'ZEROKUN_UPDATE_TESTING',
  'ZEROKUN_SLACK_IDENTITY_TEST_APP_ID',
  'ZEROKUN_SETUP_TEST_STOP_PROBE',
])

export interface StateSlackTokens {
  SLACK_BOT_TOKEN?: string
  SLACK_APP_TOKEN?: string
}

/** Reject ambiguous or malformed token assignments so every consumer uses one App identity. */
export function parseStateSlackTokens(content: string): StateSlackTokens {
  const assignments = new Map<string, string[]>()
  for (const line of content.split('\n')) {
    const match = line.match(/^(SLACK_BOT_TOKEN|SLACK_APP_TOKEN)=(.*)$/)
    if (!match) continue
    const values = assignments.get(match[1]) ?? []
    values.push(match[2])
    assignments.set(match[1], values)
  }
  const result: StateSlackTokens = {}
  for (const [key, prefix] of [
    ['SLACK_BOT_TOKEN', 'xoxb'],
    ['SLACK_APP_TOKEN', 'xapp'],
  ] as const) {
    const values = assignments.get(key) ?? []
    if (values.length === 0) continue
    if (values.length !== 1 || !new RegExp(`^${prefix}-[A-Za-z0-9._-]{10,}$`).test(values[0]!)) {
      throw new Error(`${key} must have exactly one valid ${prefix}- assignment`)
    }
    result[key] = values[0]
  }
  return result
}

/**
 * Load runtime settings while making the selected state's Slack App tokens
 * authoritative. Stale shell/tmux/launchd tokens must never redirect a new
 * Codex state back to another machine's Slack App.
 */
export function applyStateEnvironment(
  content: string,
  environment: Record<string, string | undefined> = process.env,
): void {
  for (const key of SLACK_TOKEN_KEYS) delete environment[key]
  for (const key of RUNTIME_NETWORK_OVERRIDE_KEYS) delete environment[key]
  for (const key of TEST_CONTROL_KEYS) delete environment[key]
  const tokens = parseStateSlackTokens(content)
  for (const line of content.split('\n')) {
    const match = line.match(/^(\w+)=(.*)$/)
    if (!match) continue
    const [key, value] = [match[1], match[2]]
    if (!SLACK_TOKEN_KEYS.has(key) && !RUNTIME_NETWORK_OVERRIDE_KEYS.has(key)
      && !TEST_CONTROL_KEYS.has(key)
      && environment[key] === undefined) {
      environment[key] = value
    }
  }
  Object.assign(environment, tokens)
}

function copyAllowed(
  source: Record<string, string | undefined>,
  extra: Set<string>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (BASE_KEYS.has(key) || extra.has(key) || key.startsWith('LC_'))) {
      result[key] = value
    }
  }
  return result
}

/** Minimal environment for a detached tmux pane; selected state settings are added explicitly. */
export function buildRuntimeLaunchEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (RUNTIME_LAUNCH_KEYS.has(key) || key.startsWith('LC_'))) {
      result[key] = value
    }
  }
  if (source.HOME) result.HOME = source.HOME
  return result
}

/** Runtime tuning accepted by gateway/runner after control-flow paths have been fixed explicitly. */
export function buildRuntimeServiceEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return {
    ...buildRuntimeLaunchEnvironment(source),
    ...copyAllowed(source, RUNTIME_SERVICE_KEYS),
  }
}

/** Environment for the trusted updater process. Credentials and arbitrary inherited variables are excluded. */
export function buildUpdaterEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const result = copyAllowed(source, UPDATE_KEYS)
  if (source.HOME) result.HOME = source.HOME
  return result
}

/** Environment for code checked out from the candidate commit. It receives an isolated HOME. */
export function buildCandidateEnvironment(
  isolatedHome: string,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const temporary = `${isolatedHome}/tmp`
  const inherited = copyAllowed(source, new Set())
  return {
    ...inherited,
    HOME: isolatedHome,
    CODEX_HOME: isolatedHome,
    TMPDIR: temporary,
    XDG_CACHE_HOME: `${isolatedHome}/.cache`,
    XDG_CONFIG_HOME: `${isolatedHome}/.config`,
    XDG_DATA_HOME: `${isolatedHome}/.local/share`,
    BUN_INSTALL_CACHE_DIR: `${isolatedHome}/.bun-cache`,
  }
}
