import { randomUUID } from 'crypto'
import { realpathSync } from 'fs'
import { basename, join } from 'path'
import {
  environmentForPinnedHerdrRuntime, parseHerdrRuntimeIdentity,
  requireHerdrRuntime, verifyHerdrRuntimeIdentityAsync,
  type HerdrRuntimeIdentity,
} from './herdr-runtime.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'

export const RECOVERY_WORKSPACE_FILE = 'service-recovery-workspace.json'

type Hooks = {
  verify?: (runtime: HerdrRuntimeIdentity) => Promise<void>
  invoke?: (args: string[]) => Promise<any>
  capture?: (runtime: HerdrRuntimeIdentity) => HerdrRuntimeIdentity
}

class RecoveryWorkspaceChanged extends Error {}

export function missingPane(error: unknown): boolean {
  return /"code"\s*:\s*"(?:pane_not_found|tab_not_found|workspace_not_found|terminal_not_found)"/.test(String(error))
}

/** Never select a focused/neighboring pane. Reuse our receipt or create a new workspace. */
export async function recoveryControlRuntime(
  stateDir: string,
  projectDir: string,
  previous: HerdrRuntimeIdentity,
  hooks: Hooks = {},
): Promise<HerdrRuntimeIdentity> {
  const verify = hooks.verify ?? (runtime => verifyHerdrRuntimeIdentityAsync(
    runtime, environmentForPinnedHerdrRuntime(runtime),
  ))
  const path = join(stateDir, RECOVERY_WORKSPACE_FILE)
  const raw = readOptionalBoundedOwnerOnlyRegularFile(path, 16 * 1024)
  const capture = hooks.capture ?? (runtime => requireHerdrRuntime(environmentForPinnedHerdrRuntime(runtime)))
  const captureExact = (runtime: HerdrRuntimeIdentity): HerdrRuntimeIdentity => {
    const current = capture(runtime)
    if (current.socketPath !== previous.socketPath || current.workspaceId !== runtime.workspaceId
      || current.paneId !== runtime.paneId || current.tabId !== runtime.tabId
      || current.terminalId !== runtime.terminalId) throw new RecoveryWorkspaceChanged('recovery workspace identity changed')
    return current
  }
  if (raw !== null) {
    const saved = JSON.parse(raw)
    const runtime = parseHerdrRuntimeIdentity(saved.runtime)
    if (saved.version !== 1) throw new Error('recovery workspace receipt version is invalid')
    // A later supported start can select another project/control plane. The
    // old workspace is no longer ours to operate on; leave it untouched and
    // allocate a new control root for the current pinned service.
    if (saved.projectDir === projectDir && runtime.socketPath === previous.socketPath) {
      try {
        await verify(runtime)
        return captureExact(runtime)
      } catch (error) {
        if (!missingPane(error) && !(error instanceof RecoveryWorkspaceChanged)) throw error
      }
    }
  }

  // Even if the old service pane survives, keep the recovery control in a
  // separate root. Failed runtime tabs can then be retired without deleting
  // the control pane needed by the next attempt.
  try { await verify(previous) }
  catch (error) { if (!missingPane(error)) throw error }

  const environment = environmentForPinnedHerdrRuntime(previous)
  const invoke = hooks.invoke ?? (async (args: string[]) => {
    const child = Bun.spawn([environment.HERDR_BIN_PATH!, ...args], {
      env: environment, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 30_000)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      if (code !== 0) throw new Error(`Herdr recovery create failed: ${stderr.slice(-2000)}`)
      return JSON.parse(stdout)
    } finally { clearTimeout(timer) }
  })
  const label = `Zeroちゃん ${basename(projectDir)} recovery-${randomUUID().slice(0, 8)}`
  const envelope = await invoke(['workspace', 'create', '--cwd', projectDir, '--label', label, '--no-focus'])
  const { workspace, tab, root_pane: pane } = envelope?.result ?? {}
  if (workspace?.label !== label || workspace?.pane_count !== 1 || workspace?.tab_count !== 1
    || tab?.workspace_id !== workspace.workspace_id || pane?.workspace_id !== workspace.workspace_id
    || pane?.tab_id !== tab.tab_id || typeof pane?.cwd !== 'string'
    || typeof pane.pane_id !== 'string' || pane.pane_id.split(':')[0] !== workspace.workspace_id
    || typeof tab.tab_id !== 'string' || tab.tab_id.split(':')[0] !== workspace.workspace_id
    || realpathSync(pane.cwd) !== projectDir || pane.agent || pane.agent_session) {
    throw new Error('Herdr recovery workspace response is inconsistent')
  }
  const provisional = parseHerdrRuntimeIdentity({
    ...previous, workspaceId: workspace.workspace_id, tabId: tab.tab_id,
    paneId: pane.pane_id, terminalId: pane.terminal_id,
  })
  // Persist create identity before another observation can fail. The next tick
  // resumes this exact workspace rather than accumulating failed attempts.
  atomicWritePrivateFile(path, JSON.stringify({ version: 1, projectDir, label, runtime: provisional }) + '\n')
  const runtime = captureExact(provisional)
  await verify(runtime)
  return runtime
}
