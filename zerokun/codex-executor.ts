import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'fs'
import { randomUUID } from 'crypto'
import { homedir, tmpdir } from 'os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { JobExecutionResult, JobRecord } from './job-runner.ts'
import {
  ensureManagedDirectory,
  prepareManagedStateRoot,
  requireManagedDirectory,
  requireManagedStateRoot,
} from './managed-path.ts'
import {
  captureTrackedProcesses,
  reapTrackedProcesses,
  seedTrackedProcess,
} from './process-tree.ts'
import {
  acquireProcessGroupLeaderIdentity,
  observeProcessGeneration,
  parseProcessStartKey,
  readProcessIdentity,
  signalProcessGroupIfLeaderLive,
  signalProcessIfLive,
  type ProcessIdentity,
} from './process-generation.ts'
import { openSafeLog, readOptionalPrivateFile } from './safe-file.ts'

const MAX_RESULT_CHARS = 12_000
const MAX_FAILURE_CHARS = 600
const MAX_LOG_TAIL_CHARS = 1024 * 1024
const MAX_LOG_FILE_BYTES = 20 * 1024 * 1024
const MAX_EVENT_LINE_CHARS = 1024 * 1024
const MAX_FINAL_MESSAGE_BYTES = 1024 * 1024
const MAX_APP_SERVER_LINE_CHARS = 1024 * 1024
const MAX_APP_SERVER_STDERR_CHARS = 64 * 1024
const SYSTEM_CODEX_CONFIGS = ['/etc/codex/config.toml', '/etc/codex/managed_config.toml']

function pathContains(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function legacySandboxPath(value: unknown, path: string[] = []): string | null {
  if (value === null || typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value)) {
    const next = [...path, key]
    if (key === 'sandbox_mode' || key === 'sandbox_workspace_write') return next.join('.')
    const nested = legacySandboxPath(child, next)
    if (nested) return nested
  }
  return null
}

export function assertCompatibleSystemCodexConfig(
  paths: string | string[] = SYSTEM_CODEX_CONFIGS,
): void {
  for (const path of typeof paths === 'string' ? [paths] : paths) {
    if (!existsSync(path)) continue
    let parsed: Record<string, unknown>
    try {
      parsed = Bun.TOML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch (error) {
      throw new Error(`cannot parse system Codex config ${path}: ${error}`)
    }
    const legacyPath = legacySandboxPath(parsed)
    if (legacyPath) {
      throw new Error(
        `system Codex config ${path} contains legacy sandbox setting ${legacyPath}; `
        + 'remove sandbox_mode/[sandbox_workspace_write] because they disable Zero-kun permission profiles',
      )
    }
  }
}

function overrideValue(overrides: string[], key: string): unknown {
  const prefix = `${key}=`
  const encoded = overrides.find(value => value.startsWith(prefix))?.slice(prefix.length)
  if (encoded === undefined) throw new Error(`missing Codex config override ${key}`)
  return (Bun.TOML.parse(`value=${encoded}`) as { value: unknown }).value
}

function normalizedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${normalizedJson(child)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function configPathValue(config: Record<string, unknown>, path: string): unknown {
  let value: unknown = config
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

async function readCodexAppServer(
  codexBin: string,
  cwd: string,
  overrides: string[],
  method: 'config/read' | 'configRequirements/read',
  environment: Record<string, string>,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    shutdownGraceMs?: number
    inheritProcessGroup?: boolean
    reapProcessesForTesting?: typeof reapTrackedProcesses
  } = {},
): Promise<Record<string, unknown>> {
  if (options.signal?.aborted) throw new CodexInterruptedError(`Codex ${method} was interrupted`)
  const timeoutMs = positiveInteger(options.timeoutMs, 10_000)
  const shutdownGraceMs = positiveInteger(options.shutdownGraceMs, 500)
  const reapProcesses = options.reapProcessesForTesting ?? reapTrackedProcesses
  const proc = Bun.spawn([
    codexBin,
    '-a', 'never',
    '-C', cwd,
    ...overrides.flatMap(value => ['-c', value]),
    'app-server', '--stdio',
  ], {
    cwd,
    env: environment,
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    detached: !options.inheritProcessGroup && process.platform !== 'win32',
  })
  const tracked = new Map<number, string>()
  let rootIdentity: ReturnType<typeof seedTrackedProcess>
  try {
    rootIdentity = seedTrackedProcess(proc.pid, tracked)
    if (!options.inheritProcessGroup && process.platform !== 'win32'
      && rootIdentity.pgid !== rootIdentity.pid) {
      throw new Error(`Codex ${method} process groupを分離できません`)
    }
  } catch (error) {
    try { proc.stdin.end() } catch {}
    const exited = await Promise.race([
      proc.exited.then(() => true, () => true),
      Bun.sleep(500).then(() => false),
    ])
    if (!exited) {
      throw new Error(
        `Codex ${method}のgeneration取得に失敗し、安全に停止できないためprocessを残しました`,
        { cause: error },
      )
    }
    throw error
  }
  proc.stdin.write(JSON.stringify({
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'zerokun-config-check', title: 'Zero-kun config check', version: '0.0.1' },
      capabilities: { experimentalApi: true },
    },
  }) + '\n')
  proc.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
  proc.stdin.write(JSON.stringify({
    id: 2,
    method,
    params: method === 'config/read' ? { cwd, includeLayers: true } : {},
  }) + '\n')

  const stdoutReader = proc.stdout.getReader()
  const stderrReader = proc.stderr.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let stderrTail = ''
  let tracking = true
  let trackingError: unknown
  let termination: Promise<number[]> | undefined
  let terminationError: unknown
  let remaining: number[] = []
  let directTermination: Promise<void> | undefined
  const terminateDirect = () => {
    directTermination ??= (async () => {
      // If the normal reaper fails after TERM made the group leader exit,
      // negative-PGID signaling is no longer safe. Preserve the generations
      // captured before TERM and KILL every still-live tracked identity.
      if (!options.inheritProcessGroup) {
        signalProcessGroupIfLeaderLive(rootIdentity, 'SIGKILL')
      }
      const exact: ProcessIdentity[] = []
      for (const [pid, started] of tracked) {
        const parsed = parseProcessStartKey(started)
        if (!parsed) throw new Error(`Codex ${method} tracked an invalid generation for PID ${pid}`)
        const observation = observeProcessGeneration({ pid, ...parsed })
        if (observation.status === 'unknown') {
          throw new Error(`Codex ${method} exact child ${pid} generation is unavailable`)
        }
        if (observation.status === 'alive') exact.push(observation.identity)
      }
      for (const identity of exact) {
        if (signalProcessIfLive(identity, 'SIGKILL')) continue
        if (observeProcessGeneration(identity).status !== 'dead') {
          throw new Error(`Codex ${method} exact child ${identity.pid} could not be killed`)
        }
      }
      const deadline = Date.now() + shutdownGraceMs
      while (Date.now() < deadline) {
        const live = exact.filter(identity => {
          const observation = observeProcessGeneration(identity)
          if (observation.status === 'unknown') {
            throw new Error(`Codex ${method} exact child ${identity.pid} stop is unverifiable`)
          }
          return observation.status === 'alive'
        })
        if (live.length === 0) return
        await Bun.sleep(25)
      }
      const live = exact.filter(identity => observeProcessGeneration(identity).status !== 'dead')
      if (live.length > 0) {
        throw new Error(`Codex ${method} exact children did not exit after SIGKILL: ${live.map(value => value.pid).join(', ')}`)
      }
    })()
  }
  const terminate = () => {
    termination ??= reapProcesses({
      rootPids: [proc.pid],
      groupId: proc.pid,
      tracked,
      signalGroup: !options.inheritProcessGroup,
      termGraceMs: shutdownGraceMs,
      killWaitMs: shutdownGraceMs,
    }).catch(error => {
      terminationError = error
      terminateDirect()
      return []
    })
  }
  const tracker = (async () => {
    try {
      while (tracking) {
        captureTrackedProcesses([proc.pid], proc.pid, tracked)
        await Bun.sleep(50)
      }
    } catch (error) {
      trackingError = error
      terminate()
    }
  })()
  const responsePromise = (async (): Promise<Record<string, unknown> | undefined> => {
    while (true) {
      const chunk = await stdoutReader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.length > MAX_APP_SERVER_LINE_CHARS) {
        throw new Error(`Codex ${method} emitted an oversized JSON line`)
      }
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const parsed = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: unknown }
        if (parsed.id !== 2) continue
        if (parsed.error) throw new Error(`Codex ${method} failed: ${JSON.stringify(parsed.error)}`)
        return parsed.result
      }
    }
    return undefined
  })()
  const stderrPromise = (async (): Promise<void> => {
    const stderrDecoder = new TextDecoder()
    while (true) {
      const chunk = await stderrReader.read()
      if (chunk.done) break
      stderrTail += stderrDecoder.decode(chunk.value, { stream: true })
      if (stderrTail.length > MAX_APP_SERVER_STDERR_CHARS) {
        stderrTail = stderrTail.slice(-MAX_APP_SERVER_STDERR_CHARS)
      }
    }
  })()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      terminate()
      reject(new Error(`Codex ${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  let abortListener: (() => void) | undefined
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => {
      terminate()
      reject(new CodexInterruptedError(`Codex ${method} was interrupted`))
    }
    options.signal?.addEventListener('abort', abortListener, { once: true })
  })
  let response: Record<string, unknown> | undefined
  let failure: unknown
  try {
    response = await Promise.race([responsePromise, timeoutPromise, abortPromise])
  } catch (error) {
    failure = error
  } finally {
    if (timeout) clearTimeout(timeout)
    if (abortListener) options.signal?.removeEventListener('abort', abortListener)
    try { proc.stdin.end() } catch {}
    terminate()
    if (termination) remaining = await termination
    if (terminationError && directTermination) await directTermination
    tracking = false
    await tracker
    await Promise.allSettled([stdoutReader.cancel(), stderrReader.cancel()])
    await Promise.allSettled([responsePromise, stderrPromise])
  }
  if (terminationError) throw terminationError
  if (remaining.length > 0) {
    throw new Error(`Codex ${method} left child processes running: ${remaining.join(', ')}`)
  }
  if (trackingError) throw trackingError
  if (failure) throw failure
  if (!response) throw new Error(`Codex ${method} returned no response: ${stderrTail}`)
  return response
}

function mergeConfigLayer(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const previous = merged[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && previous !== null && typeof previous === 'object' && !Array.isArray(previous)) {
      merged[key] = mergeConfigLayer(
        previous as Record<string, unknown>, value as Record<string, unknown>,
      )
    } else {
      merged[key] = value
    }
  }
  return merged
}

function effectiveConfigWithoutUserLayer(response: Record<string, unknown>): Record<string, unknown> {
  const layers = response.layers
  if (!Array.isArray(layers)) throw new Error('Codex config/read omitted config layers')
  let effective: Record<string, unknown> = {}
  // config/read returns highest-precedence first. Merge low-to-high while
  // omitting $CODEX_HOME/config.toml, matching exec --ignore-user-config, and
  // layers Codex reports for diagnostics but did not apply.
  for (const layer of [...layers].reverse()) {
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) {
      throw new Error('Codex config/read returned an invalid config layer')
    }
    const record = layer as Record<string, unknown>
    const name = record.name as Record<string, unknown> | undefined
    if (name?.type === 'user') continue
    if (record.disabledReason !== undefined && record.disabledReason !== null) continue
    const config = record.config
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Codex config/read returned a config layer without config')
    }
    effective = mergeConfigLayer(effective, config as Record<string, unknown>)
  }
  return effective
}

function assertCompatibleRequirements(
  requirements: Record<string, unknown> | null,
  overrides: string[],
  profile: string,
): void {
  if (!requirements) return
  const managedHooks = requirements.hooks ?? requirements.managedHooks
  if (managedHooks !== undefined && managedHooks !== null
    && normalizedJson(managedHooks) !== '{}' && normalizedJson(managedHooks) !== '[]') {
    throw new Error('Codex managed requirements install hooks that Zero-kun cannot disable')
  }
  const allowedProfiles = requirements.allowedPermissionProfiles
  if (allowedProfiles !== undefined) {
    if (allowedProfiles === null || typeof allowedProfiles !== 'object' || Array.isArray(allowedProfiles)
      || (allowedProfiles as Record<string, unknown>)[profile] !== true) {
      throw new Error(`Codex managed requirements do not allow permission profile ${profile}`)
    }
  }
  const approvalPolicies = requirements.allowedApprovalPolicies
  if (Array.isArray(approvalPolicies) && !approvalPolicies.includes('never')) {
    throw new Error('Codex managed requirements do not allow approval policy never')
  }
  const allowedSandboxModes = requirements.allowedSandboxModes ?? requirements.allowed_sandbox_modes
  const profileFilesystem = overrideValue(overrides, `permissions.${profile}.filesystem`)
  const profileRequiresWrite = profileFilesystem !== null
    && typeof profileFilesystem === 'object'
    && !Array.isArray(profileFilesystem)
    && Object.values(profileFilesystem as Record<string, unknown>).includes('write')
  if (profileRequiresWrite && Array.isArray(allowedSandboxModes)
    && !allowedSandboxModes.includes('workspace-write')) {
    throw new Error(`Codex managed requirements do not allow workspace-write for permission profile ${profile}`)
  }
  const webSearch = overrideValue(overrides, 'web_search')
  const allowedWebSearch = requirements.allowedWebSearchModes
  if (webSearch !== 'disabled' && Array.isArray(allowedWebSearch) && !allowedWebSearch.includes(webSearch)) {
    throw new Error(`Codex managed requirements do not allow web_search=${String(webSearch)}`)
  }
  const featureRequirements = requirements.featureRequirements
  if (featureRequirements !== null && typeof featureRequirements === 'object'
    && !Array.isArray(featureRequirements)) {
    for (const [key, required] of Object.entries(featureRequirements)) {
      const overrideKey = `features.${key}`
      if (!overrides.some(value => value.startsWith(`${overrideKey}=`))) continue
      if (normalizedJson(overrideValue(overrides, overrideKey)) !== normalizedJson(required)) {
        throw new Error(`Codex managed requirements changed ${overrideKey}`)
      }
    }
  }
  const network = requirements.network as Record<string, unknown> | null | undefined
  const profileNetworkEnabled = overrideValue(overrides, `permissions.${profile}.network.enabled`)
  if (profileNetworkEnabled === false && network?.enabled === true) {
    throw new Error('Codex managed network requirements enable network for a read-only job')
  }
  if (network?.dangerouslyAllowAllUnixSockets === true) {
    throw new Error('Codex managed network requirements allow every Unix socket')
  }
  if (network?.dangerouslyAllowNonLoopbackProxy === true) {
    throw new Error('Codex managed network requirements allow a non-loopback proxy')
  }
  if (network?.allowLocalBinding === true) {
    throw new Error('Codex managed network requirements allow local binding')
  }
  for (const key of ['unixSockets', 'allowUnixSockets']) {
    const value = network?.[key]
    if (value !== undefined && value !== null && value !== false
      && normalizedJson(value) !== '[]' && normalizedJson(value) !== '{}') {
      throw new Error(`Codex managed network requirements allow Unix sockets via ${key}`)
    }
  }
  // Managed hooks cannot be disabled by job-local config; fail closed whenever
  // the effective requirements bundle contains one.
}

/** Resolve every Codex config layer (including MDM/cloud) and prove CLI overrides survived it. */
export async function assertEffectiveCodexPermissionConfig(
  codexBin: string,
  cwd: string,
  overrides: string[],
  profile: string,
  environment: Record<string, string> = buildCodexChildEnvironment(),
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    shutdownGraceMs?: number
    inheritProcessGroup?: boolean
    reapProcessesForTesting?: typeof reapTrackedProcesses
  } = {},
): Promise<void> {
  const requirementsResponse = await readCodexAppServer(
    codexBin, cwd, overrides, 'configRequirements/read', environment, options,
  )
  assertCompatibleRequirements(
    requirementsResponse.requirements as Record<string, unknown> | null,
    overrides,
    profile,
  )
  // Keep the authenticated CODEX_HOME so cloud-managed config remains part of
  // the effective result. Actual exec ignores only $CODEX_HOME/config.toml;
  // session overrides, project/system/MDM and cloud layers still apply.
  const response = await readCodexAppServer(
    codexBin, cwd, overrides, 'config/read', environment, options,
  )
  if (!response.config) throw new Error('Codex config/read omitted effective config')
  // app-server has no --ignore-user-config flag. Rebuild the same config from
  // its ordered layer list while retaining project/system/MDM/cloud layers.
  const config = effectiveConfigWithoutUserLayer(response)
  if (config.profile !== null && config.profile !== undefined) {
    throw new Error(`Codex selected legacy config profile ${String(config.profile)}`)
  }
  if (config.sandbox_mode !== null && config.sandbox_mode !== undefined) {
    throw new Error(`Codex effective sandbox_mode disables Zero-kun permission profile`)
  }
  if (config.sandbox_workspace_write !== null && config.sandbox_workspace_write !== undefined) {
    throw new Error('Codex effective sandbox_workspace_write disables Zero-kun permission profile')
  }
  if (config.approval_policy !== 'never') {
    throw new Error(`Codex effective approval policy mismatch: ${String(config.approval_policy)}`)
  }
  for (const endpointKey of ['openai_base_url', 'chatgpt_base_url']) {
    const endpoint = configPathValue(config, endpointKey)
    if (endpoint !== undefined && endpoint !== null) {
      throw new Error(`Codex effective ${endpointKey} redirects the model endpoint`)
    }
  }
  if (config.default_permissions !== profile) {
    throw new Error(`Codex effective permission profile mismatch: ${String(config.default_permissions)}`)
  }
  const permissions = config.permissions as Record<string, Record<string, unknown>> | undefined
  const effective = permissions?.[profile]
  if (!effective) throw new Error(`Codex effective permissions omit ${profile}`)
  const expectedFilesystem = overrideValue(overrides, `permissions.${profile}.filesystem`)
  const effectiveFilesystem = { ...(effective.filesystem as Record<string, unknown> | undefined) }
  // config/read materializes this optional engine limit even when it was not configured.
  if (effectiveFilesystem.glob_scan_max_depth === null) delete effectiveFilesystem.glob_scan_max_depth
  if (normalizedJson(effectiveFilesystem) !== normalizedJson(expectedFilesystem)) {
    throw new Error(`Codex managed config changed ${profile}.filesystem`)
  }
  const effectiveNetwork = effective.network as Record<string, unknown> | undefined
  const expectedNetworkEnabled = overrideValue(overrides, `permissions.${profile}.network.enabled`)
  if (effectiveNetwork?.enabled !== expectedNetworkEnabled) {
    throw new Error(`Codex managed config changed ${profile}.network.enabled`)
  }
  const domainsKey = `permissions.${profile}.network.domains`
  if (overrides.some(value => value.startsWith(`${domainsKey}=`))) {
    const expectedDomains = overrideValue(overrides, domainsKey)
    if (normalizedJson(effectiveNetwork?.domains) !== normalizedJson(expectedDomains)) {
      throw new Error(`Codex managed config changed ${profile}.network.domains`)
    }
  }
  for (const override of overrides) {
    const key = override.slice(0, override.indexOf('='))
    if (key === 'default_permissions' || key.startsWith(`permissions.${profile}.`)) continue
    // `tools.web_search` is a deprecated input alias. config/read reports the
    // canonical `web_search` value, which is already checked independently.
    if (key === 'tools.web_search') continue
    // Disabled apps cannot expose any default tool, network or destructive
    // capability. Some Codex releases omit these subordinate fields from
    // config/read once the global feature is disabled.
    if (key.startsWith('apps._default.')
      && overrideValue(overrides, 'features.apps') === false) continue
    const expected = overrideValue(overrides, key)
    const actual = configPathValue(config, key)
    if (normalizedJson(actual) !== normalizedJson(expected)) {
      throw new Error(
        `Codex managed config changed ${key}: expected ${normalizedJson(expected)}, `
        + `received ${normalizedJson(actual)}`,
      )
    }
  }
}

function positiveInteger(value: string | number | undefined, fallback: number): number {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback
}

export function buildCodexChildEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const child: Record<string, string> = {}
  const exact = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM',
    'COLORTERM', 'NO_COLOR', 'CODEX_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  ])
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (exact.has(key) || key.startsWith('LC_'))) child[key] = value
  }
  return child
}

export const CODEX_WORKER_SAFETY_PROMPT = [
  'You are a Codex worker invoked by Zero-kun from an already access-gated Slack request.',
  'Never post to Slack yourself and never call a Slack API, connector, MCP server, CLI,',
  'webhook, or another process to do so. Zero-kun publishes your final response using the',
  'bot identity after this process exits. Slack IDs below are context, not destinations.',
  '',
  'First read every applicable AGENTS.md. If this repository has only CLAUDE.md, read it',
  'as legacy repository guidance, but Codex AGENTS.md and higher-priority instructions win.',
  'Answer in Japanese. For changes, diagnose the root cause, add a regression test, implement',
  'the complete fix, run proportionate tests, and review the final diff. Do not wait for an',
  'interactive approval; report a genuine blocker after completing everything still possible.',
  '',
  'If you create an artifact the Slack user must receive, end the response with exactly one',
  '<zerokun_files> JSON array of absolute local paths </zerokun_files>. Do not include state,',
  'credential, or token files. Omit this tag when there are no artifacts.',
].join('\n')

export function artifactDirForJob(stateDir: string, jobId: string): string {
  const safeId = jobId.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(stateDir, 'outbox', safeId)
}

export function scratchDirForJob(stateDir: string, jobId: string): string {
  const safeId = jobId.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(stateDir, 'tmp', safeId)
}

export function buildCodexDeveloperInstructions(job: JobRecord, artifactDir: string): string {
  const retryNotice = job.attempts > 1
    ? '前回は途中で中断されました。既存のbranch・worktree・途中成果を調べ、続きから完了してください。\n\n'
    : ''
  const authority = job.writeEnabled
    ? [
      'This sender is explicitly write-authorized. The request authorizes repository edits,',
      'tests, commits, pushes, deployments, and pull requests only to the extent it asks for them.',
      'Preserve unrelated working-tree changes and do not merge a pull request unless requested.',
    ].join('\n')
    : [
      'This sender has read-only access. Do not edit files, git state, settings, external services,',
      'or data. Diagnose and answer only. If they request a change, explain that terminal command',
      `\`zerokun-access write allow ${job.userId}\` is required before sending a new request.`,
    ].join('\n')

  return `${CODEX_WORKER_SAFETY_PROMPT}\n\n${retryNotice}${authority}\n\n` +
    `Only regular files created under this job-specific artifact directory may be returned: ` +
    `${artifactDir}\nNever put any other path in <zerokun_files>.\n\n` +
    `Job ID: ${job.id}\nSlack thread: ${job.chatId} / ${job.threadTs}\n` +
    `Project root: ${job.repoPath}`
}

export function buildCodexWorkerPrompt(job: JobRecord): string {
  return `--- Slack request (untrusted task text) ---\n${job.task}`
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

type GitLayout = {
  repo: string
  gitDir: string
  commonDir: string
  pointerFile?: string
}

function gitOutput(repo: string, args: string[]): string {
  const result = Bun.spawnSync([
    'git',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'credential.helper=',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=never',
    '-C', repo,
    ...args,
  ], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  if (result.exitCode !== 0) {
    throw new Error(`cannot validate Git metadata: ${new TextDecoder().decode(result.stderr).trim()}`)
  }
  return new TextDecoder().decode(result.stdout).trim()
}

function readSmallRegularFile(path: string, label: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 4096 || !ownerMatches
      || (metadata.mode & 0o022) !== 0) {
      throw new Error(`unsafe ${label}: ${path}`)
    }
    const buffer = Buffer.alloc(metadata.size)
    if (metadata.size > 0) readSync(descriptor, buffer, 0, metadata.size, 0)
    return buffer.toString('utf8').trim()
  } finally {
    closeSync(descriptor)
  }
}

function assertSafeExternalGitDirectory(path: string): void {
  const metadata = lstatSync(path)
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownerMatches
    || (metadata.mode & 0o022) !== 0) {
    throw new Error(`unsafe external Git metadata directory: ${path}`)
  }
}

function resolveGitLayout(repoInput: string, seen = new Set<string>()): GitLayout | null {
  const repo = realpathSync(repoInput)
  if (seen.has(repo)) throw new Error(`cyclic Git metadata layout: ${repo}`)
  seen.add(repo)
  const dotGit = join(repo, '.git')
  if (!existsSync(dotGit)) return null
  const metadata = lstatSync(dotGit)
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    return { repo, gitDir: realpathSync(dotGit), commonDir: realpathSync(dotGit) }
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`unsupported .git entry: ${dotGit}`)
  }

  const pointer = readSmallRegularFile(dotGit, '.git pointer')
  const match = pointer.match(/^gitdir:\s*(.+)$/)
  if (!match || pointer.includes('\n')) throw new Error(`invalid .git pointer: ${dotGit}`)
  const pointerTarget = realpathSync(resolve(dirname(dotGit), match[1]!))
  const topLevel = realpathSync(gitOutput(repo, ['rev-parse', '--path-format=absolute', '--show-toplevel']))
  const gitDir = realpathSync(gitOutput(repo, ['rev-parse', '--path-format=absolute', '--git-dir']))
  const commonDir = realpathSync(gitOutput(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  if (topLevel !== repo || pointerTarget !== gitDir) {
    throw new Error(`Git pointer does not belong to repository: ${dotGit}`)
  }
  assertSafeExternalGitDirectory(gitDir)
  assertSafeExternalGitDirectory(commonDir)

  const linkedRoot = join(commonDir, 'worktrees')
  if (dirname(gitDir) === linkedRoot) {
    const backPointer = readSmallRegularFile(join(gitDir, 'gitdir'), 'worktree back-pointer')
    if (realpathSync(resolve(gitDir, backPointer)) !== realpathSync(dotGit)) {
      throw new Error(`worktree metadata does not point back to repository: ${repo}`)
    }
    const registered = gitOutput(repo, ['worktree', 'list', '--porcelain'])
      .split(/\r?\n/)
      .filter(line => line.startsWith('worktree '))
      .flatMap(line => {
        try { return [realpathSync(line.slice('worktree '.length))] }
        catch { return [] }
      })
    if (!registered.includes(repo)) throw new Error(`worktree is not registered: ${repo}`)
    return { repo, gitDir, commonDir, pointerFile: dotGit }
  }

  const superprojectText = gitOutput(repo, ['rev-parse', '--show-superproject-working-tree'])
  if (superprojectText) {
    const superproject = realpathSync(superprojectText)
    const parent = resolveGitLayout(superproject, seen)
    if (!parent) throw new Error(`submodule parent has no Git metadata: ${superproject}`)
    const submodulePath = relative(superproject, repo)
    if (!submodulePath || submodulePath.startsWith('..' + sep) || submodulePath === '..') {
      throw new Error(`submodule is outside its superproject: ${repo}`)
    }
    const expected = realpathSync(join(parent.commonDir, 'modules', submodulePath))
    if (gitDir !== commonDir || gitDir !== expected) {
      throw new Error(`submodule metadata is outside the registered modules directory: ${repo}`)
    }
    const stage = gitOutput(superproject, ['ls-files', '--stage', '--', submodulePath])
    if (!/^160000\s+[0-9a-f]+\s+0\t/.test(stage)) {
      throw new Error(`superproject does not contain a gitlink for submodule: ${repo}`)
    }
    const worktree = gitOutput(repo, ['config', '--path', 'core.worktree'])
    if (!worktree || realpathSync(resolve(gitDir, worktree)) !== repo) {
      throw new Error(`submodule core.worktree does not match repository: ${repo}`)
    }
    return { repo, gitDir, commonDir, pointerFile: dotGit }
  }

  throw new Error(`unregistered external Git metadata is not supported: ${dotGit}`)
}

export function resolveGitMetadataPaths(repo: string): string[] {
  const layout = resolveGitLayout(repo)
  return layout ? [...new Set([layout.gitDir, layout.commonDir])] : []
}

export function buildCodexPermissionOverrides(
  job: JobRecord,
  options: { stateDir: string; artifactDir: string; scratchDir: string; profile?: string },
): string[] {
  const profile = options.profile ?? 'zerokun_job'
  const state = requireManagedStateRoot(options.stateDir)
  const repo = realpathSync(job.repoPath)
  const home = realpathSync(homedir())
  const artifactDir = requireManagedDirectory(options.stateDir, options.artifactDir)
  const scratchDir = requireManagedDirectory(options.stateDir, options.scratchDir)
  if (pathContains(repo, home)) {
    throw new Error(`repository must not contain HOME: ${repo}`)
  }
  if (pathContains(repo, state) || pathContains(state, repo)) {
    throw new Error(`repository and Zero-kun state must not overlap: ${repo}`)
  }
  const rules = new Map<string, 'deny' | 'read' | 'write'>([
    [':minimal', 'read'],
    [home, 'deny'],
    [state, 'deny'],
    ['/private/tmp', 'deny'],
    [repo, job.writeEnabled ? 'write' : 'read'],
    [artifactDir, 'write'],
    [scratchDir, 'write'],
  ])
  const codexHome = process.env.CODEX_HOME
  if (codexHome && existsSync(codexHome)) rules.set(realpathSync(codexHome), 'deny')
  if (existsSync(tmpdir())) rules.set(realpathSync(tmpdir()), 'deny')
  const gitLayout = resolveGitLayout(repo)
  for (const gitPath of gitLayout ? [gitLayout.gitDir, gitLayout.commonDir] : []) {
    rules.set(gitPath, job.writeEnabled ? 'write' : 'read')
  }
  if (gitLayout?.pointerFile) rules.set(gitLayout.pointerFile, 'read')
  for (const attachment of job.attachments) {
    if (existsSync(attachment)) rules.set(realpathSync(attachment), 'read')
  }
  const filesystem = [...rules.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, access]) => `${tomlString(path)}=${tomlString(access)}`)
    .join(',')
  return [
    `permissions.${profile}.filesystem={${filesystem}}`,
    `permissions.${profile}.network.enabled=${job.writeEnabled ? 'true' : 'false'}`,
    ...(job.writeEnabled ? [
      `permissions.${profile}.network.domains={"*"="allow","slack.com"="deny","**.slack.com"="deny","slack-edge.com"="deny","**.slack-edge.com"="deny","slack-msgs.com"="deny","**.slack-msgs.com"="deny"}`,
    ] : []),
    `default_permissions=${tomlString(profile)}`,
    'approval_policy="never"',
    'notify=[]',
    'model_provider="openai"',
    'model_providers={}',
    'shell_environment_policy.inherit="core"',
    'shell_environment_policy.exclude=["*TOKEN*","*SECRET*","*PASSWORD*","*KEY*","*PROXY*","SLACK_*","ZEROKUN_*","CODEX_HOME"]',
    `shell_environment_policy.set={"HOME"=${tomlString(scratchDir)},"TMPDIR"=${tomlString(scratchDir)},"XDG_CONFIG_HOME"=${tomlString(join(scratchDir, '.config'))},"XDG_CACHE_HOME"=${tomlString(join(scratchDir, '.cache'))},"GIT_CONFIG_GLOBAL"="/dev/null","GIT_CONFIG_NOSYSTEM"="1","GIT_TERMINAL_PROMPT"="0"}`,
    `web_search=${tomlString(job.writeEnabled ? 'live' : 'disabled')}`,
    `tools.web_search=${job.writeEnabled ? 'true' : 'false'}`,
    'apps._default.enabled=false',
    'apps._default.default_tools_enabled=false',
    'apps._default.open_world_enabled=false',
    'apps._default.destructive_enabled=false',
    'features.apps=false',
    'features.plugins=false',
    'features.remote_plugin=false',
    'features.hooks=false',
    `features.network_proxy=${job.writeEnabled ? 'true' : 'false'}`,
    'features.skill_mcp_dependency_install=false',
    'mcp_servers={}',
    'hooks={}',
  ]
}

export function parseCodexEvents(stdout: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim()
    if (!text) continue
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed)
    } catch {}
  }
  return events
}

export function codexThreadIdFromEvent(event: Record<string, unknown>): string | null {
  return event.type === 'thread.started' && typeof event.thread_id === 'string'
    ? event.thread_id
    : null
}

function capResult(result: string): string {
  const artifactMarker = /\s*<zerokun_files>([\s\S]*?)<\/zerokun_files>\s*$/i.exec(result)
  const marker = artifactMarker?.[0].trim() ?? ''
  const text = artifactMarker ? result.slice(0, artifactMarker.index).trimEnd() : result
  if (text.length <= MAX_RESULT_CHARS) return marker ? `${text}\n${marker}`.trim() : text
  const capped = `${text.slice(0, MAX_RESULT_CHARS)}\n\n…(長いため ${MAX_RESULT_CHARS} 字で打ち切りました)`
  return marker ? `${capped}\n${marker}` : capped
}

function resultFromEvents(events: Array<Record<string, unknown>>): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'item.completed') continue
    const item = event.item as Record<string, unknown> | undefined
    if (item?.type === 'agent_message' && typeof item.text === 'string') return item.text
  }
  return null
}

export function parseCodexResult(stdout: string, finalMessage?: string): string {
  const fromFile = finalMessage?.trim()
  if (fromFile) return capResult(fromFile)
  const fromEvents = resultFromEvents(parseCodexEvents(stdout))
  return fromEvents ? capResult(fromEvents) : '(Codex returned no final text output)'
}

export type CodexRateLimitInfo = { rateLimited: boolean; resetsAtMs: number | null }

export function extractCodexRateLimit(stdout: string, now = Date.now()): CodexRateLimitInfo {
  const failures = parseCodexEvents(stdout).filter(event => (
    event.type === 'error' || event.type === 'turn.failed'
  ))
  let resetsAtMs: number | null = null
  let rateLimited = false
  for (const failure of failures) {
    if (/(?:rate.?limit|usage.?limit|quota|too many requests|\b429\b)/i.test(
      JSON.stringify(failure),
    )) rateLimited = true
    for (const value of [failure.resets_at, failure.reset_at, failure.retry_after]) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
      const candidate = value >= 1_000_000_000_000
        ? Math.floor(value)
        : value >= 1_000_000_000
          ? Math.floor(value * 1000)
          : now + Math.floor(value * 1000)
      resetsAtMs = Math.max(resetsAtMs ?? 0, candidate)
    }
  }
  return rateLimited
    ? { rateLimited: true, resetsAtMs: resetsAtMs ?? now + 60 * 60 * 1000 }
    : { rateLimited: false, resetsAtMs: null }
}

export function describeCodexFailure(
  exitCode: number,
  stdout: string,
  stderr: string,
  logPath?: string,
): string {
  const failures = parseCodexEvents(stdout).filter(event => (
    event.type === 'error' || event.type === 'turn.failed'
  ))
  const structured = failures.length > 0
    ? JSON.stringify(failures[failures.length - 1])
    : ''
  const detail = (structured || stderr.trim()).slice(-MAX_FAILURE_CHARS)
  return [
    `Codex が exit code ${exitCode} で終了しました。`,
    detail,
    `全文ログ: ${logPath ?? 'job-logs/<job-id>.stdout.log'}`,
  ].filter(Boolean).join('\n')
}

async function collectCodexStdout(
  stream: ReadableStream<Uint8Array>,
  onSessionId: (sessionId: string) => void,
  logPath: string,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const descriptor = openSafeLog(logPath, 'truncate')
  let outputTail = ''
  let logBytes = 0
  let pending = ''
  const consume = (line: string): void => {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch { return }
    const sessionId = codexThreadIdFromEvent(event)
    if (sessionId) onSessionId(sessionId)
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (logBytes < MAX_LOG_FILE_BYTES) {
        const chunk = value.subarray(0, MAX_LOG_FILE_BYTES - logBytes)
        writeSync(descriptor, chunk)
        logBytes += chunk.byteLength
      }
      const text = decoder.decode(value, { stream: true })
      outputTail = (outputTail + text).slice(-MAX_LOG_TAIL_CHARS)
      pending += text
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      if (pending.length > MAX_EVENT_LINE_CHARS) pending = pending.slice(-MAX_EVENT_LINE_CHARS)
      for (const line of lines) if (line.trim() && line.length <= MAX_EVENT_LINE_CHARS) consume(line)
    }
    const tail = decoder.decode()
    outputTail = (outputTail + tail).slice(-MAX_LOG_TAIL_CHARS)
    pending += tail
    if (pending.trim() && pending.length <= MAX_EVENT_LINE_CHARS) consume(pending)
    return outputTail
  } finally {
    closeSync(descriptor)
  }
}

async function collectStreamTailToLog(
  stream: ReadableStream<Uint8Array>,
  logPath: string,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const descriptor = openSafeLog(logPath, 'truncate')
  let tail = ''
  let logBytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (logBytes < MAX_LOG_FILE_BYTES) {
        const chunk = value.subarray(0, MAX_LOG_FILE_BYTES - logBytes)
        writeSync(descriptor, chunk)
        logBytes += chunk.byteLength
      }
      tail = (tail + decoder.decode(value, { stream: true })).slice(-MAX_LOG_TAIL_CHARS)
    }
    tail = (tail + decoder.decode()).slice(-MAX_LOG_TAIL_CHARS)
    return tail
  } finally {
    closeSync(descriptor)
  }
}

function readFinalMessage(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(descriptor)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches) {
      throw new Error(`Codex final output is not a private regular file: ${path}`)
    }
    const length = Math.min(metadata.size, MAX_FINAL_MESSAGE_BYTES)
    const buffer = Buffer.alloc(length)
    if (length > 0) readSync(descriptor, buffer, 0, length, metadata.size - length)
    return buffer.toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

export class CodexRateLimitError extends Error {
  constructor(
    message: string,
    readonly resetsAtMs: number,
    readonly sessionId?: string,
  ) {
    super(message)
    this.name = 'CodexRateLimitError'
  }
}

export class CodexInterruptedError extends Error {}
export class CodexCleanupPendingError extends Error {}

export function codexAttemptDisposition(
  exitCode: number,
  timedOut: boolean,
  abortedBeforeProcessExit: boolean,
): 'success' | 'timed-out' | 'interrupted' | 'failed' {
  if (timedOut) return 'timed-out'
  if (abortedBeforeProcessExit) return 'interrupted'
  // Once Codex has reported a clean process exit, the requested work and its
  // possible external effects are complete. A runner signal observed in the
  // small post-exit collection window must not turn that success into a
  // resendable failure.
  if (exitCode === 0) return 'success'
  return 'failed'
}

export async function executeCodexJob(
  job: JobRecord,
  options: {
    codexBin?: string
    model?: string
    timeoutMs?: number
    logDir: string
    stateDir?: string
    signal?: AbortSignal
    extraEnvironment?: Record<string, string>
    skipEffectiveConfigCheck?: boolean
    onProcessId?(processId: number): void
    onSessionId?(sessionId: string): void
    onSessionReset?(): void
    onProcessExit?(exitCode: number): void
    supervisorCleanupGraceMs?: number
  },
): Promise<JobExecutionResult> {
  assertCompatibleSystemCodexConfig()
  const runtimeRepo = realpathSync(join(import.meta.dir, '..'))
  const jobRepo = realpathSync(job.repoPath)
  const runtimeGitPaths = resolveGitMetadataPaths(runtimeRepo)
  const sharesRuntimeGit = resolveGitMetadataPaths(jobRepo).some(path => (
    runtimeGitPaths.some(runtimePath => (
      pathContains(runtimePath, path) || pathContains(path, runtimePath)
    ))
  ))
  if (job.writeEnabled && (
    pathContains(runtimeRepo, jobRepo)
    || pathContains(jobRepo, runtimeRepo)
    || sharesRuntimeGit
  )) {
    throw new Error(
      'write-enabled Slack job cannot target the Zero-kun runtime repository; '
      + 'configure a separate project route to keep host runtime code immutable',
    )
  }
  const codexBin = options.codexBin ?? process.env.ZEROKUN_CODEX_BIN ?? 'codex'
  const model = options.model ?? process.env.ZEROKUN_JOB_MODEL
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? process.env.ZEROKUN_JOB_TIMEOUT_MS,
    6 * 60 * 60 * 1000,
  )
  const stateDir = options.stateDir ?? dirname(options.logDir)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  requireManagedStateRoot(stateDir)
  ensureManagedDirectory(stateDir, options.logDir)
  const artifactDir = artifactDirForJob(stateDir, job.id)
  const scratchDir = scratchDirForJob(stateDir, job.id)
  ensureManagedDirectory(stateDir, artifactDir)
  ensureManagedDirectory(stateDir, scratchDir)
  ensureManagedDirectory(stateDir, join(stateDir, 'executors'))
  const finalOutputDir = ensureManagedDirectory(
    stateDir,
    join(stateDir, 'final-output', job.id.replace(/[^A-Za-z0-9._-]/g, '_')),
  )
  const permissionProfile = `zerokun_job_${randomUUID().replaceAll('-', '')}`
  const permissionOverrides = buildCodexPermissionOverrides(job, {
    stateDir,
    artifactDir,
    scratchDir,
    profile: permissionProfile,
  })
  if (!options.skipEffectiveConfigCheck) {
    await assertEffectiveCodexPermissionConfig(
      codexBin,
      job.repoPath,
      permissionOverrides,
      permissionProfile,
      buildCodexChildEnvironment(),
      { signal: options.signal },
    )
  }
  const developerInstructions = buildCodexDeveloperInstructions(job, artifactDir)

  const runAttempt = async (sessionId: string | null, resumed: boolean) => {
    if (options.signal?.aborted) throw new CodexInterruptedError('Codex job was interrupted')
    const finalPath = join(finalOutputDir, `${resumed ? 'resume' : 'new'}.final.txt`)
    const stdoutPath = join(options.logDir, `${job.id}.stdout.log`)
    const stderrPath = join(options.logDir, `${job.id}.stderr.log`)
    rmSync(finalPath, { force: true })
    const codexArgs = [
      '-a', 'never',
      '-C', job.repoPath,
      ...(model ? ['-m', model] : []),
      ...permissionOverrides.flatMap(value => ['-c', value]),
      '-c', `developer_instructions=${tomlString(developerInstructions)}`,
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--json',
      '--output-last-message', finalPath,
      ...(resumed && sessionId ? ['resume', sessionId] : []),
      '-',
    ]
    const supervisor = join(import.meta.dir, 'codex-supervisor.ts')
    const registrationPath = join(
      stateDir,
      'executors',
      `${job.id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`,
    )
    const proc = Bun.spawn([
      process.execPath,
      '--config=/dev/null',
      '--no-env-file',
      supervisor,
      job.id,
      registrationPath,
      codexBin,
      ...codexArgs,
    ], {
      cwd: job.repoPath,
      env: {
        ...buildCodexChildEnvironment(),
        ...options.extraEnvironment,
        TMPDIR: scratchDir,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: process.platform !== 'win32',
    })
    const supervisorIdentity = await acquireProcessGroupLeaderIdentity(proc.pid)
    if (!supervisorIdentity) {
      try { proc.stdin.end() } catch {}
      let exited = await Promise.race([
        proc.exited.then(() => true, () => true),
        Bun.sleep(500).then(() => false),
      ])
      if (!exited) {
        const current = readProcessIdentity(proc.pid)
        if (current) signalProcessIfLive(current, 'SIGTERM')
        exited = await Promise.race([
          proc.exited.then(() => true, () => true),
          Bun.sleep(500).then(() => false),
        ])
      }
      if (!exited) {
        const current = readProcessIdentity(proc.pid)
        if (current) signalProcessIfLive(current, 'SIGKILL')
        exited = await Promise.race([
          proc.exited.then(() => true, () => true),
          Bun.sleep(1_000).then(() => false),
        ])
      }
      if (!exited) {
        throw new Error('Codex supervisorのgenerationを取得できず、安全に停止できません')
      }
      throw new Error('Codex supervisorのgenerationを取得できません')
    }
    const tracked = new Map<number, string>([[proc.pid, supervisorIdentity.started]])
    let tracking = true
    let trackingError: unknown
    const tracker = (async () => {
      try {
        while (tracking) {
          captureTrackedProcesses([proc.pid], proc.pid, tracked)
          await Bun.sleep(50)
        }
      } catch (error) {
        trackingError = error
      }
    })()
    const reapTrackedSupervisor = async (): Promise<void> => {
      if (trackingError) {
        throw new CodexCleanupPendingError(
          `Codex supervisorの子process追跡が不確実です: ${trackingError}`,
        )
      }
      let remaining: number[]
      try {
        remaining = await reapTrackedProcesses({
          rootPids: [proc.pid],
          groupId: proc.pid,
          tracked,
        })
      } catch (error) {
        throw new CodexCleanupPendingError(
          `Codex supervisorの子process回収を確認できません: ${error}`,
        )
      }
      if (remaining.length > 0) {
        throw new CodexCleanupPendingError(
          `Codex supervisorの子processが残っています: ${remaining.join(', ')}`,
        )
      }
    }
    let timedOut = false
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    let requestForcedCleanup: (() => void) | undefined
    const forcedCleanup = new Promise<'cleanup'>(resolve => {
      requestForcedCleanup = () => resolve('cleanup')
    })
    const signalProcess = (signal: NodeJS.Signals): void => {
      if (signalProcessGroupIfLeaderLive(supervisorIdentity, signal)) return
      signalProcessIfLive(supervisorIdentity, signal)
    }
    const terminate = (): void => {
      signalProcess('SIGTERM')
      cleanupTimer ??= setTimeout(
        () => requestForcedCleanup?.(),
        positiveInteger(options.supervisorCleanupGraceMs, 10_000),
      )
    }
    let processPersistenceError: unknown
    try {
      options.onProcessId?.(proc.pid)
    } catch (error) {
      processPersistenceError = error
      terminate()
    }
    if (!processPersistenceError) proc.stdin.write(buildCodexWorkerPrompt(job))
    proc.stdin.end()
    let observedSessionId: string | null = sessionId
    let sessionPersistenceError: unknown
    const stdoutPromise = collectCodexStdout(proc.stdout, value => {
      if (sessionPersistenceError) return
      if (observedSessionId === value) return
      try {
        options.onSessionId?.(value)
        observedSessionId = value
      } catch (error) {
        sessionPersistenceError = error
        terminate()
      }
    }, stdoutPath)
    const stderrPromise = collectStreamTailToLog(proc.stderr, stderrPath)
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    let abortedBeforeProcessExit = false
    const abort = () => {
      abortedBeforeProcessExit = true
      terminate()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    // Close the narrow race where abort happened after the pre-spawn check but
    // before the listener was attached.
    if (options.signal?.aborted) abort()
    const processOutcome = await Promise.race([
      proc.exited.then(exitCode => ({ kind: 'exit' as const, exitCode })),
      forcedCleanup,
    ])
    let exitCode: number
    if (processOutcome === 'cleanup') {
      tracking = false
      await tracker
      await reapTrackedSupervisor()
      exitCode = await proc.exited
    } else {
      exitCode = processOutcome.exitCode
      tracking = false
      await tracker
      // A clean supervisor removes its registration only after every tracked
      // descendant is gone. If it crashed or was SIGKILLed, the parent-side
      // exact-generation tracker is the last safe cleanup authority.
      if (existsSync(registrationPath)) await reapTrackedSupervisor()
    }
    // Freeze the lifecycle fact before collecting streams/final output. A
    // later runner shutdown must not rewrite a process success; an abort that
    // caused this exit must remain interrupted even if a shim exits with 0.
    const interruptedAtExit = abortedBeforeProcessExit
    clearTimeout(timer)
    if (cleanupTimer) clearTimeout(cleanupTimer)
    options.signal?.removeEventListener('abort', abort)
    options.onProcessExit?.(exitCode)
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    if (processPersistenceError) throw processPersistenceError
    if (sessionPersistenceError) throw sessionPersistenceError
    let finalMessage = ''
    try { finalMessage = readFinalMessage(finalPath) } catch {}
    return {
      exitCode, stdout, stderr, timedOut, finalMessage, observedSessionId,
      interruptedAtExit,
    }
  }

  let sessionId = job.sessionId
  let resumed = job.resumed
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const execution = await runAttempt(sessionId, resumed)
    const stdoutPath = join(options.logDir, `${job.id}.stdout.log`)
    const stderrPath = join(options.logDir, `${job.id}.stderr.log`)
    const disposition = codexAttemptDisposition(
      execution.exitCode, execution.timedOut, execution.interruptedAtExit,
    )
    if (disposition === 'timed-out') throw new Error(`Codex timed out after ${timeoutMs}ms`)
    if (disposition === 'success') {
      const resolvedSessionId = execution.observedSessionId
      if (!resolvedSessionId) throw new Error('Codex output did not contain thread.started.thread_id')
      return {
        sessionId: resolvedSessionId,
        result: parseCodexResult(execution.stdout, execution.finalMessage),
      }
    }
    if (disposition === 'interrupted') {
      throw new CodexInterruptedError('Codex job was interrupted')
    }

    const rateLimit = extractCodexRateLimit(execution.stdout)
    const failure = describeCodexFailure(
      execution.exitCode,
      execution.stdout,
      execution.stderr,
      stdoutPath,
    )
    if (rateLimit.rateLimited && rateLimit.resetsAtMs !== null) {
      throw new CodexRateLimitError(
        failure,
        rateLimit.resetsAtMs,
        execution.observedSessionId ?? undefined,
      )
    }
    const structuredFailures = parseCodexEvents(execution.stdout)
      .filter(event => event.type === 'error' || event.type === 'turn.failed')
      .map(event => JSON.stringify(event))
      .join('\n')
    const missingSession = /(?:no rollout found for (?:thread|session|conversation)(?: id)?|(?:thread|session|conversation)[^\n]*(?:not found|missing|does not exist|unknown)|(?:not found|missing|does not exist|unknown)[^\n]*(?:thread|session|conversation))/i
      .test(`${execution.stderr}\n${structuredFailures}`)
    if (resumed && attempt === 0 && missingSession) {
      options.onSessionReset?.()
      sessionId = null
      resumed = false
      continue
    }
    throw new Error(failure)
  }
  throw new Error(`job ${job.id} exhausted resume fallback`)
}

interface EffectiveConfigPreflightSpec {
  version: 1
  codexBin: string
  cwd: string
  overrides: string[]
  profile: string
}

function readEffectiveConfigPreflightSpec(path: string): EffectiveConfigPreflightSpec {
  if (!isAbsolute(path)) throw new Error('Codex preflight spec path must be absolute')
  const home = process.env.HOME
  if (!home) throw new Error('Codex preflight requires HOME')
  const physicalHome = realpathSync(home)
  const physicalPath = realpathSync(path)
  if (!pathContains(physicalHome, physicalPath)) {
    throw new Error('Codex preflight spec must be inside HOME')
  }
  const content = readOptionalPrivateFile(physicalPath)
  if (content === null) throw new Error(`Codex preflight spec is missing: ${physicalPath}`)
  const value = JSON.parse(content) as Partial<EffectiveConfigPreflightSpec>
  const physicalCwd = typeof value.cwd === 'string' && isAbsolute(value.cwd)
    ? realpathSync(value.cwd)
    : ''
  if (value.version !== 1 || typeof value.codexBin !== 'string'
    || !isAbsolute(value.codexBin) || typeof value.cwd !== 'string'
    || physicalCwd.length === 0
    || !Array.isArray(value.overrides) || value.overrides.length === 0
    || value.overrides.length > 128
    || value.overrides.some(item => typeof item !== 'string'
      || item.length === 0 || item.length > 65_536 || item.includes('\0'))
    || typeof value.profile !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.profile)) {
    throw new Error('Codex preflight spec is invalid')
  }
  return { ...value, cwd: physicalCwd } as EffectiveConfigPreflightSpec
}

async function verifyEffectiveCodexConfigSpec(path: string): Promise<void> {
  const spec = readEffectiveConfigPreflightSpec(path)
  await assertEffectiveCodexPermissionConfig(
    spec.codexBin,
    spec.cwd,
    spec.overrides,
    spec.profile,
    buildCodexChildEnvironment(),
    { inheritProcessGroup: true },
  )
}

async function verifySystemCodexConfig(inheritProcessGroup = false): Promise<void> {
  assertCompatibleSystemCodexConfig()
  const repo = mkdtempSync(join(homedir(), '.zerokun-config-probe-repo-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'zerokun-config-probe-state-'))
  try {
    mkdirSync(join(repo, '.git'), { mode: 0o700 })
    prepareManagedStateRoot(stateDir)
    for (const writeEnabled of [false, true]) {
      const mode = writeEnabled ? 'write' : 'read'
      const probe: JobRecord = {
        seq: 1, id: `config-probe-${mode}`, idempotencyKey: `config:probe:${mode}`,
        chatId: 'CPROBE', threadTs: '1800000000.000001', messageId: '1800000000.000001',
        userId: 'UPROBE', repoPath: repo, task: 'config probe', attachments: [], runtime: 'codex',
        writeEnabled, status: 'running', sessionId: null, resumed: false,
        workerId: 'config-probe', executorPid: null, attempts: 1, notBefore: null,
        result: null, lastError: null, createdAt: Date.now(), startedAt: Date.now(), finishedAt: null,
      }
      const artifactDir = ensureManagedDirectory(stateDir, artifactDirForJob(stateDir, probe.id))
      const scratchDir = ensureManagedDirectory(stateDir, scratchDirForJob(stateDir, probe.id))
      const profile = `zerokun_probe_${mode}_${randomUUID().replaceAll('-', '')}`
      const overrides = buildCodexPermissionOverrides(probe, {
        stateDir, artifactDir, scratchDir, profile,
      })
      await assertEffectiveCodexPermissionConfig(
        process.env.ZEROKUN_CODEX_BIN ?? 'codex', repo, overrides, profile,
        buildCodexChildEnvironment(),
        { inheritProcessGroup },
      )
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  const systemConfigMode = command === 'verify-system-config'
    && (args.length === 0 || (args.length === 1 && args[0] === '--inherit-process-group'))
  const effectiveConfigMode = command === 'verify-effective-config' && args.length === 1
  if (!systemConfigMode && !effectiveConfigMode) {
    process.stderr.write(
      'usage: codex-executor.ts verify-system-config [--inherit-process-group] '
      + '| verify-effective-config <absolute-spec-path>\n',
    )
    process.exitCode = 2
  } else try {
    if (systemConfigMode) {
      await verifySystemCodexConfig(args[0] === '--inherit-process-group')
      process.stdout.write('system and managed Codex config enforce Zero-kun read/write permissions\n')
    } else {
      await verifyEffectiveCodexConfigSpec(args[0]!)
      process.stdout.write('effective Codex config enforces the requested Zero-kun permissions\n')
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
