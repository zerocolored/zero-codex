#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { realpathSync } from 'fs'
import { basename, join } from 'path'
import { requireManagedStateRoot } from './managed-path.ts'
import {
  inspectManagedServiceStatus,
  startManagedService,
  type ManagedServiceStatus,
} from './service-control.ts'
import {
  environmentForPinnedHerdrRuntime,
  readPinnedHerdrRuntime,
  verifyHerdrRuntimeIdentityAsync,
} from './herdr-runtime.ts'
import { readGatewayReadiness } from './readiness.ts'

type HerdrStartHooks = {
  inspectStatus?: (stateDir: string) => ManagedServiceStatus
  invoke?: (args: string[]) => Promise<Record<string, unknown>>
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
  cleanupTimeoutMs?: number
  repairMissingLauncher?: (input: {
    rootRepo: string
    stateDir: string
    projectDir: string
  }) => Promise<ManagedServiceStatus>
}

async function closeFailedStartWorkspace(input: {
  workspaceId: string
  stateDir: string
  invoke: (args: string[]) => Promise<Record<string, unknown>>
  inspect: (stateDir: string) => ManagedServiceStatus
  sleep: (milliseconds: number) => Promise<void>
  timeoutMs: number
}): Promise<void> {
  // workspace.create returned this exact identity during this invocation. Do
  // not rediscover by label or close a tab/pane that may have moved meanwhile.
  await input.invoke(['workspace', 'close', input.workspaceId])

  const maxChecks = Math.max(1, Math.ceil(input.timeoutMs / 100))
  let lastStatus: ManagedServiceStatus | undefined
  let lastError: unknown
  for (let check = 0; check < maxChecks; check += 1) {
    try {
      lastStatus = input.inspect(input.stateDir)
      lastError = undefined
      if (lastStatus.status === 'stopped') return
    } catch (error) {
      lastError = error
    }
    if (check + 1 < maxChecks) await input.sleep(100)
  }
  if (lastError) {
    throw new Error(
      `workspace close後のservice停止確認に失敗しました: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
  }
  throw new Error(
    'workspace close後もZeroちゃんのprocessが残っています'
    + (lastStatus
      ? ` (gateway=${lastStatus.gatewayPid ?? 'none'}, runner=${lastStatus.runnerPid ?? 'none'}, launcher=${lastStatus.launcherPid ?? 'none'})`
      : ''),
  )
}

export type HerdrStartResult = {
  status: 'already-running' | 'started'
  workspaceId?: string
  paneId?: string
  gatewayPid?: number
  runnerPid?: number
  launcherPid?: number
}

const IDENTIFIERS = {
  workspace: /^w[0-9A-Za-z]+$/,
  tab: /^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/,
  pane: /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/,
  terminal: /^term_[0-9a-f]+$/,
}

function requiredIdentifier(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Herdr ${label}が不正です`)
  }
  return value
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Herdr ${label}がありません`)
  }
  return value as Record<string, unknown>
}

function commandEnvironment(): Record<string, string> {
  const home = process.env.HOME
  if (!home) throw new Error('HOMEがありません')
  const user = process.env.USER ?? process.env.LOGNAME
  if (!user) throw new Error('USERがありません')
  return {
    HOME: home,
    USER: user,
    LOGNAME: process.env.LOGNAME ?? user,
    SHELL: process.env.SHELL ?? '/bin/zsh',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    PATH: `${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'C.UTF-8',
  }
}

function productionInvoker(herdrBinary: string): (args: string[]) => Promise<Record<string, unknown>> {
  return async args => {
    const child = Bun.spawn([herdrBinary, ...args], {
      env: commandEnvironment(),
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, 30_000)
    let stdout: string
    let stderr: string
    let exitCode: number
    try {
      const [stdoutBuffer, stderrBuffer, exited] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).arrayBuffer(),
        child.exited,
      ])
      stdout = Buffer.from(stdoutBuffer).toString('utf8')
      stderr = Buffer.from(stderrBuffer).toString('utf8')
      exitCode = exited
    } finally {
      clearTimeout(timer)
    }
    if (stdout.length > 1024 * 1024 || stderr.length > 1024 * 1024) {
      throw new Error('Herdr command outputが上限を超えました')
    }
    if (exitCode !== 0) {
      throw new Error(`Herdr ${args.slice(0, 2).join(' ')}に失敗しました: ${stderr.trim().slice(-1_000)}`)
    }
    let value: unknown
    try { value = JSON.parse(stdout) } catch { throw new Error('Herdrが不正なJSONを返しました') }
    return requiredRecord(value, 'response')
  }
}

function resolveHerdrBinary(): string {
  const selected = process.env.HERDR_BIN_PATH || Bun.which('herdr')
  if (!selected) throw new Error('herdr が見つかりません')
  return realpathSync(selected)
}

async function repairMissingLauncher(input: {
  rootRepo: string
  stateDir: string
  projectDir: string
}): Promise<ManagedServiceStatus> {
  const readiness = readGatewayReadiness(join(input.stateDir, 'gateway-ready.json'))
  if (!readiness || typeof readiness.slackAppId !== 'string') {
    throw new Error('稼働中gatewayのSlack App identityを確認できません')
  }
  const pinned = readPinnedHerdrRuntime(input.stateDir)
  await startManagedService(
    input.rootRepo,
    input.stateDir,
    input.projectDir,
    readiness.slackAppId,
    {
      controlRuntime: pinned,
      verifyControlRuntime: runtime => verifyHerdrRuntimeIdentityAsync(
        runtime,
        environmentForPinnedHerdrRuntime(runtime),
      ),
    },
  )
  return inspectManagedServiceStatus(input.stateDir)
}

export async function startZeroInHerdrWorkspace(
  rootRepoInput: string,
  stateDirInput: string,
  projectDirInput: string,
  hooks: HerdrStartHooks = {},
): Promise<HerdrStartResult> {
  const rootRepo = realpathSync(rootRepoInput)
  const stateDir = requireManagedStateRoot(stateDirInput)
  const projectDir = realpathSync(projectDirInput)
  const launcher = realpathSync(join(rootRepo, 'codex-channel.sh'))
  const inspect = hooks.inspectStatus ?? inspectManagedServiceStatus
  const initial = inspect(stateDir)
  if (initial.status === 'running') {
    return {
      status: 'already-running',
      gatewayPid: initial.gatewayPid,
      runnerPid: initial.runnerPid,
      launcherPid: initial.launcherPid,
    }
  }
  if (initial.status === 'partial') {
    if (initial.gatewayPid && initial.runnerPid && !initial.launcherPid) {
      const repaired = await (
        hooks.repairMissingLauncher ?? repairMissingLauncher
      )({ rootRepo, stateDir, projectDir })
      if (repaired.status !== 'running') {
        throw new Error('Zeroちゃんの自動復旧機構を再構築できませんでした')
      }
      return {
        status: 'already-running',
        gatewayPid: repaired.gatewayPid,
        runnerPid: repaired.runnerPid,
        launcherPid: repaired.launcherPid,
      }
    }
    throw new Error('Zeroちゃんが部分起動状態です。zerochan stop --force の後に zerochan start を実行してください')
  }

  const invoke = hooks.invoke ?? productionInvoker(resolveHerdrBinary())
  const label = `Zeroちゃん ${basename(projectDir)}`
  const envelope = await invoke([
    'workspace', 'create', '--cwd', projectDir, '--label', label, '--focus',
  ])
  const result = requiredRecord(envelope.result, 'workspace create result')
  const workspace = requiredRecord(result.workspace, 'workspace')
  const tab = requiredRecord(result.tab, 'tab')
  const pane = requiredRecord(result.root_pane, 'root pane')
  const workspaceId = requiredIdentifier(
    workspace.workspace_id,
    IDENTIFIERS.workspace,
    'workspace ID',
  )
  const tabId = requiredIdentifier(tab.tab_id, IDENTIFIERS.tab, 'tab ID')
  const paneId = requiredIdentifier(pane.pane_id, IDENTIFIERS.pane, 'pane ID')
  requiredIdentifier(pane.terminal_id, IDENTIFIERS.terminal, 'terminal ID')
  if (workspace.label !== label || workspace.pane_count !== 1 || workspace.tab_count !== 1
    || tab.workspace_id !== workspaceId || tabId.split(':')[0] !== workspaceId
    || pane.workspace_id !== workspaceId || pane.tab_id !== tabId
    || typeof pane.cwd !== 'string' || realpathSync(pane.cwd) !== projectDir
    || Object.hasOwn(pane, 'agent') || Object.hasOwn(pane, 'agent_session')) {
    throw new Error(`Herdrが要求と異なるworkspaceを作成しました (${workspaceId})`)
  }

  const sleep = hooks.sleep ?? (milliseconds => Bun.sleep(milliseconds))
  try {
    await invoke(['pane', 'run', paneId, launcher, 'start'])

    const deadline = Date.now() + (hooks.timeoutMs ?? 90_000)
    while (Date.now() <= deadline) {
      const current = inspect(stateDir)
      if (current.status === 'running') {
        return {
          status: 'started',
          workspaceId,
          paneId,
          gatewayPid: current.gatewayPid,
          runnerPid: current.runnerPid,
          launcherPid: current.launcherPid,
        }
      }
      await sleep(500)
    }
    throw new Error(`Herdr workspace ${workspaceId}でZeroちゃんの起動確認がtimeoutしました`)
  } catch (error) {
    let cleanupFailure = ''
    try {
      await closeFailedStartWorkspace({
        workspaceId,
        stateDir,
        invoke,
        inspect,
        sleep,
        timeoutMs: hooks.cleanupTimeoutMs ?? 10_000,
      })
    } catch (cleanupError) {
      cleanupFailure = `\n起動失敗後のworkspace/process回収にも失敗しました: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}${cleanupFailure}`)
  }
}

async function main(): Promise<void> {
  const [rootRepo, stateDir, projectDir, ...extra] = process.argv.slice(2)
  if (!rootRepo || !stateDir || !projectDir || extra.length > 0) {
    process.stderr.write('usage: herdr-start.ts ROOT_REPO STATE_DIR PROJECT_DIR\n')
    process.exitCode = 2
    return
  }
  const result = await startZeroInHerdrWorkspace(rootRepo, stateDir, projectDir)
  if (result.status === 'already-running') {
    process.stdout.write('✅ Zeroちゃんは既に稼働中です。\n')
  } else {
    process.stdout.write(`✅ Herdr workspace ${result.workspaceId}でZeroちゃんを起動しました。\n`)
  }
  process.stdout.write(`   gateway: PID ${result.gatewayPid} / runner: PID ${result.runnerPid} / recovery: PID ${result.launcherPid}\n`)
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`❌ ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
