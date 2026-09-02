#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { realpathSync } from 'fs'
import { basename, join } from 'path'
import { requireManagedStateRoot } from './managed-path.ts'
import {
  inspectManagedServiceStatus,
  type ManagedServiceStatus,
} from './service-control.ts'

type HerdrStartHooks = {
  inspectStatus?: (stateDir: string) => ManagedServiceStatus
  invoke?: (args: string[]) => Promise<Record<string, unknown>>
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
}

export type HerdrStartResult = {
  status: 'already-running' | 'started'
  workspaceId?: string
  paneId?: string
  gatewayPid?: number
  runnerPid?: number
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
    }
  }
  if (initial.status === 'partial') {
    throw new Error('Zeroちゃんが部分起動状態です。Herdr内で zerochan stop を実行してから再試行してください')
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

  try {
    await invoke(['pane', 'run', paneId, launcher, 'start'])
  } catch (error) {
    throw new Error(`作成したHerdr workspace ${workspaceId}で起動できませんでした: ${error instanceof Error ? error.message : String(error)}`)
  }

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
      }
    }
    if (current.status === 'partial') {
      throw new Error(`Herdr workspace ${workspaceId}でZeroちゃんが部分起動になりました`)
    }
    await (hooks.sleep ?? (milliseconds => Bun.sleep(milliseconds)))(500)
  }
  throw new Error(`Herdr workspace ${workspaceId}でZeroちゃんの起動確認がtimeoutしました`)
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
  process.stdout.write(`   gateway: PID ${result.gatewayPid} / runner: PID ${result.runnerPid}\n`)
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`❌ ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
