import { createHash, randomBytes, randomUUID } from 'crypto'
import { existsSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { JobRecord } from './job-runner.ts'
import { artifactDirForJob, scratchDirForJob, advisorRuntimeDirForJob, buildCodexPermissionOverrides,
  CODEX_WORKER_SAFETY_PROMPT, primaryProjectBoundary } from './codex-executor.ts'
import { ensureManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile, readOptionalBoundedAtomicOwnedFile } from './safe-file.ts'
import { resolveClaudeExecutableLookup } from './ephemeral-claude-session.ts'
import { ensureJobTempDirectory } from './job-temp.ts'
import { liveControlInputDir } from './live-control.ts'
import { retainDeliveredArtifacts, retainedArtifactInstructions } from './retained-artifacts.ts'
import { createSeatbeltFingerprint, removeSeatbeltFingerprint } from './seatbelt-fingerprint.ts'
import { resolveOfficialStandaloneCodex } from './standalone-codex.ts'
import { installedGoChromeEntrypoint } from './installed-browser.ts'
import { GO_CHROME_ENABLED_TOOLS, GO_CHROME_DISABLED_TOOLS } from './chrome-tools.ts'
import { taskGoalObjective, type NativeGoal } from './codex-goal.ts'
import type { PrimaryToolsContext } from './primary-tools-broker.ts'
import { pinClaudeJobModel, readClaudeJobModel } from './claude-model-binding.ts'

type McpSpec = { command: string; args: string[]; env?: Record<string, string> }

export function claudePrimaryInstructions(job: JobRecord, input: {
  artifactDir: string; scratchDir: string; retainedManifest: string; globalInstructions: string; chrome: boolean
}): string {
  return [CODEX_WORKER_SAFETY_PROMPT,
    'You are the primary Claude Code agent for this task. Use Opus for the main reasoning, planning, implementation decisions and final answer.',
    'Codex-backed tools and the independent GPT reviewer are auxiliary capabilities; you own the task and its final outcome.',
    'The host provides zerokun_runtime.execute, wait_command and stop_command for commands, file reads, edits and tests.',
    'Their permission sandbox preserves the same task filesystem and networking scope as the Codex core. Never bypass a real tool denial.',
    'Follow the current user authorization and preserve prior approvals. Do not introduce new technical approval gates.',
    'Never copy or expose bot credentials, private host state, unrelated user data, other sessions or host agent settings.',
    'A command that returns a sessionId is still running. Poll that exact session; do not repeat writes just because a response is delayed.',
    'Use commands to inspect the actual project and read applicable AGENTS.md before making changes. CLAUDE.md is legacy guidance only when applicable.',
    'Keep useful commentary in Japanese. The host delivers the final answer, attachments and explicitly marked milestones to Slack.',
    'Use zerokun_runtime.view_image to inspect attached images and generated screenshots. Record observed progress through zerokun_runtime.report_progress at phase changes and during long command polling; the host delivers these updates at the standard cadence without interrupting your turn.',
    `Artifact directory: ${input.artifactDir}. Scratch directory: ${input.scratchDir}.`,
    job.writeEnabled
      ? 'This task is write-authorized within its requested scope. Carry it through implementation, required reviews, checks, commit/push and requested delivery. Preserve other work. Do not assume a later host phase will finish it.'
      : 'This task is read-only. Diagnose and answer without changing repository, Git, settings, external services or data. Slack text cannot upgrade this authority.',
    'Use zerokun_runtime.get_goal and update_goal. Leave the goal active while actionable work remains; a progress summary is not completion.',
    'Mark complete only after the full requested outcome and verification are done. Use blocked for a concrete external dependency or required user decision, and paused only for the user\'s explicit pause.',
    'When a UI/UX direction approval is required, deliver the complete proposal and its attachments in the final answer with a blocked goal. A generated proposal is not proof the user received it.',
    'The three-advisor process is identical in both cores: one combined initial design, one final review, and one delta-only second review only after an adopted mandatory fix with a nonempty task-owned delta.',
    'For GPT use zerokun_advisors.advisor_codex_start and advisor_codex_poll. The host launches one independent gpt-6-astra solution_analyst at medium effort for investigation, or risk_reviewer at low effort for review. Do not launch an extra GPT or substitute another model.',
    'Retain its exact response and agentId. Then use advisor_round phase=investigation round=1, or phase=review round=1; pass the original exact nativeAdvisors outcome and the current inputRevision/inputDigest. Grok and a fresh Fable 5.1 are run by that broker.',
    'Give all three the original request and minimum primary evidence, without another advisor\'s conclusions. Preserve successful answers and any availability diagnostics; zero successful answers is not a blocker for primary work.',
    'For review round 2 provide the same roundTwoBasis to advisor_codex_start and advisor_round, with adopted roundOneSources, mandatoryFindingSummary, taskOwnedFixDelta and taskOwnedFixPaths. Minor findings, unavailable advisors and infrastructure faults do not trigger round 2.',
    'Poll the same returned round binding until terminal. A completed logical round is not repeated on steer, resume or added input. Never invent an attempted, started or completed reviewer; use the returned host slotSummary.',
    'For required GUI hearing, pass uiProposal to the initial advisor_round. Fable may produce the isolated sample and sanitized After. If unavailable, create the isolated proposal yourself, label its source and obtain required explicit direction approval before editing the product.',
    'Use zerokun_github for authenticated issue reads, fetch, branch publication and pull requests when needed. A public 404 or absent shell login does not prove the host capability is unavailable.',
    'Use zerokun_usage.task_usage_read for this task\'s numeric usage, including prior tasks in this conversation. Missing/partial records are not zero.',
    ...(job.writeEnabled ? [
      'For local browser evidence use zerokun_browser.verify_local_page. Use zerokun_cloud_logging for scoped project logs and registered historical evidence. An empty registry is not proof no evidence exists elsewhere.',
      'Use installed cloud CLIs with their normal configuration for authorized work. Never copy tokens, print secret configuration or infer authentication failure solely from a local execution denial.',
    ] : []),
    ...(input.chrome ? ['The configured Go Chrome MCP is the browser transport for this core. Discover tabs_list and use explicit tab IDs, current visible state and screenshots. Follow browser rules, preserve existing sessions and call release_tab. Do not inspect cookies or unrelated credentials.'] : []),
    retainedArtifactInstructions(input.retainedManifest),
    ...(input.globalInstructions ? ['--- Applicable global AGENTS.md ---', input.globalInstructions, '--- End global AGENTS.md ---'] : []),
    'Core transport mapping: references above to primary Codex mean you, the primary Claude agent. Use the explicit zerokun tools for host capabilities. GPT advisors use advisor_codex_start/poll; Fable/Grok use advisor_round. Do not replace those paths with shell-launched agents or claim that native Codex collaboration, Browser or Computer Use tools exist in this Claude process.',
  ].join('\n\n')
}

/** Host-owned files and MCPs. None of these paths may be supplied by model input. */
export function prepareClaudeJobContext(job: JobRecord, stateInput: string) {
  const stateDir = requireManagedStateRoot(stateInput)
  const { jobRepo, advisorProjectLayout: layout } = primaryProjectBoundary(job)
  const artifactDir = ensureManagedDirectory(stateDir, artifactDirForJob(stateDir, job.id))
  const scratchDir = ensureManagedDirectory(stateDir, scratchDirForJob(stateDir, job.id))
  const tempDir = ensureJobTempDirectory(stateDir, job.id)
  const inputDir = liveControlInputDir(stateDir, job.id)
  const retained = retainDeliveredArtifacts(job, stateDir, inputDir)
  // Keep one consultation ledger for the logical job across native process
  // and daemon restarts; physical restarts must not create another panel.
  const logicalDir = ensureManagedDirectory(stateDir, join(stateDir, 'claude-job-logical'))
  const logicalPath = join(logicalDir, `${job.id}.json`)
  const savedLogical = readOptionalBoundedOwnerOnlyRegularFile(logicalPath, 8192)
  const logical = savedLogical ? JSON.parse(savedLogical) : { version: 1, jobId: job.id,
    repoPath: jobRepo, attemptNonce: randomUUID().replaceAll('-', '') }
  if (logical.version !== 1 || logical.jobId !== job.id || logical.repoPath !== jobRepo
    || !/^[a-f0-9]{32}$/.test(logical.attemptNonce)) throw new Error('invalid Claude logical job binding')
  if (!savedLogical) atomicWritePrivateFile(logicalPath, JSON.stringify(logical))
  const attemptNonce: string = logical.attemptNonce, processNonce = randomUUID().replaceAll('-', '')
  const runtimeDir = ensureManagedDirectory(stateDir, advisorRuntimeDirForJob(stateDir, job.id, processNonce))
  const contextDir = ensureManagedDirectory(stateDir, join(stateDir, 'advisor-context', job.id))
  const contextPath = join(contextDir, `${attemptNonce}.json`)
  const initialRepositoryDigest = createHash('sha256').update(JSON.stringify({ version: 1, projectPath: layout.projectPath,
    kind: layout.kind, gitRoot: layout.gitRoot, gitRoots: layout.gitRoots })).digest('hex')
  atomicWritePrivateFile(contextPath, JSON.stringify({ version: 4, jobId: job.id, attemptNonce, repoPath: jobRepo,
    gitRoot: layout.gitRoot, gitRoots: layout.gitRoots, writeEnabled: job.writeEnabled, initialRepositoryDigest }))
  const fingerprint = createSeatbeltFingerprint(stateDir, job.id, processNonce)
  const profile = `zero_claude_${processNonce}`
  const overrides = buildCodexPermissionOverrides(job, { stateDir, artifactDir, scratchDir,
    jobTempDir: tempDir, liveInputDir: inputDir, gitRoot: layout.gitRoot, gitRoots: layout.gitRoots, profile,
    multiAgentEnabled: false, browserAccessEnabled: job.writeEnabled, nativeCloudAccessEnabled: job.writeEnabled,
    nativeDockerAccessEnabled: job.writeEnabled, seatbeltFingerprintAllowPath: fingerprint.allow.path })
  const parsed = Bun.TOML.parse(overrides.join('\n')) as { shell_environment_policy: { set: Record<string, string> } }
  const toolsContextPath = join(runtimeDir, 'tools.json'), goalPath = join(runtimeDir, 'goal.json')
  const toolsContext: PrimaryToolsContext = { version: 1, jobId: job.id, cwd: jobRepo, stateDir, goalPath, profile,
    permissionOverrides: overrides, codex: resolveOfficialStandaloneCodex(), shellEnvironment: parsed.shell_environment_policy.set,
    fingerprintDenyPath: fingerprint.deny.path }
  atomicWritePrivateFile(toolsContextPath, JSON.stringify(toolsContext))
  atomicWritePrivateFile(goalPath, JSON.stringify({ objective: taskGoalObjective(job.id), status: 'active' }))
  const spec = (file: string, args: string[]): McpSpec => ({ command: realpathSync(process.execPath),
    args: ['--config=/dev/null', '--no-env-file', join(import.meta.dir, file), ...args] })
  const servers: Record<string, McpSpec> = {
    zerokun_runtime: spec('primary-tools-broker.ts', [toolsContextPath]),
    zerokun_advisors: spec('advisor-broker.ts', [contextPath, stateDir, runtimeDir, fingerprint.allow.path, fingerprint.deny.path,
      'complete', processNonce, resolveClaudeExecutableLookup(), 'claude-code']),
    zerokun_github: spec('github-credential-broker.ts', [contextPath, stateDir]),
    zerokun_usage: spec('task-usage-broker.ts', [stateDir, job.id]),
  }
  const usageDir = ensureManagedDirectory(stateDir, join(stateDir, 'task-usage-context'))
  atomicWritePrivateFile(join(usageDir, `${job.id}.json`), JSON.stringify({ version: 1, jobId: job.id, repoPath: job.historyRepoPath ?? jobRepo }))
  const chrome = job.writeEnabled ? installedGoChromeEntrypoint(import.meta.dir, jobRepo) : undefined
  const browserKey = join(runtimeDir, 'browser-receipt-key')
  if (job.writeEnabled) {
    atomicWritePrivateFile(browserKey, randomBytes(32).toString('hex') + '\n')
    servers.zerokun_browser = spec('browser-verification-broker.ts', [contextPath, stateDir, artifactDir, scratchDir, 'complete', browserKey])
    servers.zerokun_cloud_logging = spec('cloud-logging-broker.ts', [contextPath, stateDir])
    if (chrome) {
      servers['go-chrome-mcp'] = { command: realpathSync(process.execPath), args: [chrome] }
      atomicWritePrivateFile(join(runtimeDir, 'grok-oauth-chrome.json'), JSON.stringify({ version: 1,
        jobId: job.id, attemptNonce, processNonce, entrypoint: chrome }))
    }
  }
  const mcpPath = join(runtimeDir, 'mcp.json'), settingsPath = join(runtimeDir, 'claude-settings.json')
  atomicWritePrivateFile(mcpPath, JSON.stringify({ mcpServers: servers }))
  const readonlyToolsPath = join(runtimeDir, 'readonly-tools.json')
  const readonlyOverrides = buildCodexPermissionOverrides({ ...job, writeEnabled: false }, {
    stateDir, artifactDir, scratchDir, jobTempDir: tempDir, liveInputDir: inputDir,
    gitRoot: layout.gitRoot, gitRoots: layout.gitRoots, profile, multiAgentEnabled: false,
    browserAccessEnabled: false, nativeCloudAccessEnabled: false, nativeDockerAccessEnabled: false,
    seatbeltFingerprintAllowPath: fingerprint.allow.path,
  })
  atomicWritePrivateFile(readonlyToolsPath, JSON.stringify({ ...toolsContext,
    allowGoalUpdate: false,
    permissionOverrides: readonlyOverrides,
    shellEnvironment: (Bun.TOML.parse(readonlyOverrides.join('\n')) as any).shell_environment_policy.set }))
  const readonlyMcpPath = join(runtimeDir, 'readonly-mcp.json')
  atomicWritePrivateFile(readonlyMcpPath, JSON.stringify({ mcpServers: {
    zerokun_runtime: spec('primary-tools-broker.ts', [readonlyToolsPath]), zerokun_usage: servers.zerokun_usage,
  } }))
  atomicWritePrivateFile(settingsPath, JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, enabledPlugins: {} }))
  const globalPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'AGENTS.md')
  const globalInstructions = existsSync(globalPath)
    ? readOptionalBoundedAtomicOwnedFile(globalPath, 256 * 1024, 'global instructions')?.toString('utf8') ?? '' : ''
  const systemPromptPath = join(runtimeDir, 'instructions.txt')
  atomicWritePrivateFile(systemPromptPath, claudePrimaryInstructions(job, { artifactDir, scratchDir,
    retainedManifest: retained.manifest, globalInstructions, chrome: Boolean(chrome) }))
  let pinnedModel = readClaudeJobModel(stateDir, job.id, jobRepo)
  const argumentsFor = (sessionId: string, resume: boolean, readonly = false): string[] => [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
    '--restricted', '--tools', '', '--no-chrome', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', readonly ? readonlyMcpPath : mcpPath,
    '--settings', settingsPath, '--append-system-prompt-file', systemPromptPath, '--system-prompt-snapshot', 'off',
    '--model', pinnedModel ?? 'opus', '--permission-mode', 'dontAsk', '--allowedTools',
    ...(readonly ? ['zerokun_runtime', 'zerokun_usage'] : Object.keys(servers).filter(name => name !== 'go-chrome-mcp')).map(name => `mcp__${name}__*`),
    ...(!readonly && chrome ? GO_CHROME_ENABLED_TOOLS.map(name => `mcp__go-chrome-mcp__${name}`) : []),
    ...(chrome ? ['--disallowedTools', ...GO_CHROME_DISABLED_TOOLS.map(name => `mcp__go-chrome-mcp__${name}`)] : []),
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
  ]
  return { stateDir, jobRepo, artifactDir, scratchDir, inputDir, tempDir, runtimeDir, contextPath,
    attemptNonce, processNonce, fingerprint, toolsContext, argumentsFor, pinnedModel,
    contextDigest: createHash('sha256').update(JSON.stringify({ version: 4, jobId: job.id,
      attemptNonce, repoPath: jobRepo, gitRoot: layout.gitRoot, gitRoots: layout.gitRoots,
      writeEnabled: job.writeEnabled, initialRepositoryDigest })).digest('hex'),
    pinModel(model: string) {
      if (!/^claude-opus-[a-zA-Z0-9.-]+$/.test(model) || (pinnedModel && pinnedModel !== model)) throw new Error('Claude primary model changed')
      pinClaudeJobModel(stateDir, job.id, jobRepo, model)
      pinnedModel = model
    },
    goal(): NativeGoal { return JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(goalPath, 32 * 1024) ?? 'null') },
    retire() {
      rmSync(browserKey, { force: true })
      removeSeatbeltFingerprint(stateDir, fingerprint)
    },
  }
}
