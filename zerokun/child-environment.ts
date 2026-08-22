const BASE_KEYS = new Set([
  'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'NO_COLOR',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
])

const UPDATE_KEYS = new Set([
  'ZEROKUN_REPO_DIR', 'ZEROKUN_STATE_DIR', 'ZEROKUN_PROJECT_DIR',
  'ZEROKUN_UPDATE_BRANCH', 'ZEROKUN_UPDATE_WAIT_SECONDS', 'ZEROKUN_SETUP_SCRIPT',
  'ZEROKUN_JOB_RUNNER', 'ZEROKUN_JOB_DB', 'ZEROKUN_TMUX_PATH',
  'ZEROKUN_UPDATE_TESTING', 'ZEROKUN_UPDATE_STARTUP_TIMEOUT_MS',
  'ZEROKUN_UPDATE_HEALTH_TIMEOUT_MS', 'ZEROKUN_LAUNCHCTL_BIN',
])

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
  return {
    ...copyAllowed(source, new Set()),
    HOME: isolatedHome,
    CODEX_HOME: isolatedHome,
    TMPDIR: temporary,
    XDG_CACHE_HOME: `${isolatedHome}/.cache`,
    XDG_CONFIG_HOME: `${isolatedHome}/.config`,
    XDG_DATA_HOME: `${isolatedHome}/.local/share`,
    BUN_INSTALL_CACHE_DIR: `${isolatedHome}/.bun-cache`,
  }
}
