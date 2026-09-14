import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { CloudHandoffClient, CloudHandoffError, digestBytes, handoffSchema, readCloudConfig } from './cloud-handoff.ts'
import { CloudCheckpointBlockedError, HandoffCoordinator, writeCheckpoint } from './handoff-coordinator.ts'
import { captureAttachment, captureRepository, restoreRepository, type HandoffPackage } from './handoff-package.ts'
import { ensureWorkspacePin, resolveProjectLayout } from './project-layout.ts'
import type { JobRecord, JobStore } from './job-runner.ts'
import { localRepositoryIdentity, provisionLocalWorkspaceSettings } from './local-workspace-settings.ts'

type Workspace = { epoch: number; project: string; repositories: Array<{ root: string; name: string; base: string }> }
export type CloudControl = { channel: string; thread: string; message: string; user: string;
  bot: string; project: string; writeEnabled: boolean; action: 'handoff' | 'continue' }
const CONTINUATION_INSTRUCTIONS = '\n\n# Managed continuation workspace\nThis task already has dedicated worktrees prepared from fetched integration commits. Continue in these worktrees and branches; do not create, move, delete or edit other worktrees. Preserve uncommitted work for handoff. Do not commit cloud credentials or host state.\n'
export class CloudPreparationError extends Error {
  constructor(readonly permanent = false) { super(permanent
    ? 'このスレッドの所有状態または作業場所の設定により開始できません。引き継ぎ先への「引き継いで」、元の担当への「続けて」、またはリポジトリ設定を確認してください。'
    : 'cloud workspace preparation is pending; local task preserved') }
}
export class CloudControlUnavailableError extends Error {}
function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}

/** Cloud use is explicit per installation; merely updating does not upload
 * historical jobs, credentials or existing shared checkout changes. */
export class CloudRuntime {
  readonly coordinator: HandoffCoordinator
  private readonly saves = new Map<string, Promise<void>>()
  constructor(private readonly store: JobStore, private readonly stateDir: string,
    readonly client: CloudHandoffClient, private readonly workspaceBase?: string) {
    this.coordinator = new HandoffCoordinator(client, {
      binding: id => store.cloudHandoff(id),
      bind: (id, h) => store.bindCloudHandoff(id, h.id, h.epoch, JSON.stringify(h)),
      park: (id, resetAt) => store.parkCloudHandoff(id, 'usage limit; explicit user instruction required', resetAt),
      published: (id, h, path, message) => store.recordCloudCheckpoint(id, JSON.stringify(h), path, message),
      transferred: (id, h) => store.retireCloudSave(id, h.epoch),
    }, join(stateDir, 'cloud-checkpoints'))
  }
  static configured(store: JobStore, stateDir: string): CloudRuntime | null {
    const path = join(stateDir, 'cloud-auth.json')
    return existsSync(path) ? new CloudRuntime(store, stateDir, new CloudHandoffClient(readCloudConfig(path), fetch, path)) : null
  }
  private workspacePath(id: string): string { return join(this.stateDir, 'cloud-workspaces', `${id}.json`) }
  private workspaceRoot(): string {
    return this.workspaceBase ?? join(homedir(), '.zerochan-workspaces', digestBytes(Buffer.from(this.stateDir)).slice(0, 24))
  }
  async prepare(job: JobRecord): Promise<void> {
    try { await this.prepareOwned(job) } catch (error) {
      if (error instanceof CloudPreparationError) throw error
      throw new CloudPreparationError(error instanceof CloudHandoffError && error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408)
    }
  }
  private async prepareOwned(job: JobRecord): Promise<void> {
    await this.coordinator.claim(job.id, job.chatId, job.threadTs)
    const binding = this.store.cloudHandoff(job.id)!
    const h = handoffSchema.parse(JSON.parse(binding.receipt))
    const receipt = this.workspacePath(h.id)
    if (existsSync(receipt)) {
      const existing = JSON.parse(readFileSync(receipt, 'utf8')) as Workspace
      if (existing.epoch !== h.epoch) throw new CloudPreparationError(true)
      this.prepareWorkspaceMetadata(existing)
      return
    }
    // A unique new worktree owns the task's changes. Never capture a dirty
    // shared checkout and infer that all its changes belong to this job.
    const layout = resolveProjectLayout(job.repoPath)
    if (!layout.gitRoots.length) throw new CloudPreparationError(true)
    const attempt = crypto.randomUUID()
    const project = join(this.workspaceRoot(), `${h.id}-${attempt}`, 'project')
    mkdirSync(project, { recursive: true, mode: 0o700 })
    const repositories: Workspace['repositories'] = []
    for (const source of layout.gitRoots) {
      const name = basename(source)
      const root = join(project, name)
      const branches = git(source, ['ls-remote', '--heads', 'origin', 'develop', 'main', 'master'])
      const branch = ['develop', 'main', 'master'].find(value => branches.includes(`refs/heads/${value}`))
      if (!branch) throw new CloudPreparationError(true)
      git(source, ['fetch', 'origin', branch])
      const base = git(source, ['rev-parse', 'FETCH_HEAD'])
      // Multi-repository execution expects ordinary repository members, not
      // linked .git files pointing outside the managed project.
      git(source, ['clone', '--no-checkout', '--no-hardlinks', '--', source, root])
      git(root, ['remote', 'set-url', 'origin', git(source, ['remote', 'get-url', 'origin'])])
      git(root, ['switch', '-c', `zerochan/${h.id}/${attempt}/${name}`, base])
      repositories.push({ root, name, base })
    }
    const instructions = layout.rootInstructionPaths.filter(p => basename(p) === 'AGENTS.md')
      .map(p => readFileSync(p, 'utf8')).join('\n\n')
    writeCheckpoint(join(project, 'AGENTS.md'), Buffer.from(instructions + CONTINUATION_INSTRUCTIONS))
    const workspace = { epoch: h.epoch, project, repositories }
    this.prepareWorkspaceMetadata(workspace)
    writeCheckpoint(receipt, Buffer.from(JSON.stringify(workspace)))
  }
  executionJob(job: JobRecord): JobRecord {
    const binding = this.store.cloudHandoff(job.id)
    if (!binding) return job
    const workspace = JSON.parse(readFileSync(this.workspacePath(binding.cloudId), 'utf8')) as Workspace
    const context = join(workspace.project, 'HANDOFF.md')
    const repoPath = realpathSync(workspace.repositories.length === 1 ? workspace.repositories[0]!.root : workspace.project)
    // Conversation routing is logical; a native Codex session belongs to one
    // physical cwd. Unknown legacy bindings and imports must start fresh with
    // durable thread history, not resume the old session at a new directory.
    const resumed = job.resumed && job.sessionId !== null
      && this.store.sessionWorkspace(job.sessionId) === repoPath
    if (job.sessionId !== null && !resumed) this.store.clearSession(job.id)
    // Runs on every dispatch, including legacy workspace reuse and imports.
    // Never persist host credentials or source paths in cloud workspace receipts.
    const settings: string[] = []
    try {
      const sources = new Map<string, string>()
      for (const root of resolveProjectLayout(job.repoPath).gitRoots) {
        try { sources.set(localRepositoryIdentity(root), root) } catch { /* no configured origin */ }
      }
      for (const repository of workspace.repositories) {
        let status = 'unavailable'
        try {
          const source = sources.get(localRepositoryIdentity(repository.root))
          if (source) status = provisionLocalWorkspaceSettings(source, repository.root)
        } catch { /* an unrelated member must not prevent the others from preparing */ }
        settings.push(`${repository.name}: ${status}`)
      }
    } catch { settings.push('local settings unavailable') }
    const settingsInstructions = '\n\n# Host-local environment settings\n'
      + settings.join('\n')
      + '\nOnly this PC\'s .env.keys is provisioned locally; it is never uploaded. Existing workspace keys are preserved. '
      + 'Ready means a local file exists, not that decryption or API authentication succeeded. '
      + 'For dotenvx projects, use dotenvx run --strict for commands requiring decrypted settings; verify required variables without printing their values before API calls. '
      + 'MISSING_PRIVATE_KEY or decryption failure is local configuration failure, not evidence of API key expiry. '
      + 'Do not call authenticated APIs with absent or still-encrypted credentials, request key rotation, read keys into the conversation, or bypass strict loading. '
      + 'Missing/unavailable settings do not prevent unrelated local investigation; report the concrete local configuration requirement if needed.\n'
    return { ...job, historyRepoPath: job.repoPath,
      repoPath, resumed, sessionId: resumed ? job.sessionId : null,
      task: job.task + CONTINUATION_INSTRUCTIONS + settingsInstructions,
      attachments: [...new Set([...job.attachments, ...(existsSync(context) ? [context] : [])])] }
  }
  private prepareWorkspaceMetadata(workspace: Workspace): void {
    if (workspace.repositories.length > 1) {
      const layout = resolveProjectLayout(workspace.project)
      const expected = workspace.repositories.map(r => realpathSync(r.root)).sort()
      if (JSON.stringify([...layout.gitRoots].sort()) !== JSON.stringify(expected)) {
        throw new Error('cloud workspace repositories changed; existing work preserved')
      }
      ensureWorkspacePin(layout)
    }
  }
  async pause(job: JobRecord, resetAt: number | undefined): Promise<void> {
    const pending = this.saves.get(job.id)
    if (pending) return pending
    const operation = this.pauseOwned(job, resetAt)
    this.saves.set(job.id, operation)
    try { await operation } catch (error) {
      if (error instanceof CloudCheckpointBlockedError) this.store.blockCloudSave(job.id)
      throw error
    } finally { this.saves.delete(job.id) }
  }
  private async pauseOwned(job: JobRecord, resetAt: number | undefined): Promise<void> {
    if (this.store.cloudHandoff(job.id)?.state === 'waiting') return
    await this.coordinator.pause(job.id, resetAt ?? null, async () => {
      if (this.store.get(job.id)?.executorPid !== null) throw new Error('executor is still registered')
    }, async () => {
      const binding = this.store.cloudHandoff(job.id)!
      const workspace = JSON.parse(readFileSync(this.workspacePath(binding.cloudId), 'utf8')) as Workspace
      const inheritedPath = join(workspace.project, 'HANDOFF.md')
      const inherited = existsSync(inheritedPath)
        ? Buffer.from(captureAttachment(workspace.project, inheritedPath, 'HANDOFF.md').data, 'base64').toString('utf8')
        : ''
      const history = [inherited, this.store.cloudHistory(job.id)].filter(Boolean).join('\n\n')
      const attachments = [...new Set([...job.attachments, ...(job.threadAttachments ?? []).map(a => a.path)])]
      const packet: HandoffPackage = { version: 1, task: job.task, history,
        repositories: workspace.repositories.map(r => captureRepository(r.root, r.name, r.base)),
        attachments: attachments.map((path, i) => captureAttachment(path.startsWith(`${workspace.project}/`)
          ? workspace.project : this.stateDir, path, `attachments/${i}-${basename(path)}`)),
        notes: ['Continue the same task. Inspect already-applied effects before further actions. Do not replay GitHub, Slack, deployment or database operations blindly.',
          'Unpublished commit changes are included in the base-to-index patch; sourceHead records provenance, not a portable Codex session ID.'] }
      return packet
    })
  }

  async receive(input: CloudControl): Promise<void> {
    if (this.store.cloudControlHasImported(input.channel, input.message)) return
    const member = await this.client.member()
    if (member.slack_bot_id !== input.bot) throw new CloudControlUnavailableError('このPCのクラウド登録とSlackアプリが一致しません。接続設定を確認してください。')
    const waiting = await this.client.find(input.channel, input.thread)
    if (!waiting) {
      this.store.finishCloudControlWithMessage(input, 'このスレッドには引き継ぎ可能な保存データがありません。元の担当が作業状態を保存してから、もう一度指示してください。')
      return
    }
    if (input.action === 'continue' && waiting.owner_id !== member.user_id) {
      this.store.retireCloudThread(waiting.id, waiting.epoch)
      return
    }
    if (waiting.state === 'saving' && waiting.owner_id === member.user_id
      && this.store.retryBlockedCloudSave(waiting.id)) {
      this.store.finishCloudControlWithMessage(input, 'ローカルに保持した作業状態の保存を再試行します。保存が完了してから再開・引き継ぎできます。')
      return
    }
    if (waiting.owner_id === member.user_id && waiting.reset_at && Date.parse(waiting.reset_at) > Date.now()
      && waiting.state === 'waiting') {
      this.store.finishCloudControlWithMessage(input, 'まだ利用上限の解除前です。解除後に「続けて」と指示してください。別の担当へ引き継ぐこともできます。')
      return
    }
    if (waiting.state === 'active') {
      try { await this.client.take(waiting, `${input.channel}:${input.message}`) } catch (error) {
        // Only an already committed exact event may recover the gap between
        // cloud activation and durable local enqueue. A new request cannot
        // take a currently executing thread.
        if (error instanceof CloudHandoffError && error.status === 400) {
          this.store.finishCloudControlWithMessage(input, '元の担当が現在作業中のため、まだ引き継げません。作業状態が保存されてから、もう一度指示してください。')
          return
        }
        throw error
      }
    }
    const layout = resolveProjectLayout(input.project)
    const sources = new Map(layout.gitRoots.map(root => [git(root, ['remote', 'get-url', 'origin'])
      .replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, ''), root]))
    const expectedEpoch = waiting.state === 'waiting' ? waiting.epoch + 1 : waiting.epoch
    let prepared: { workspace: Workspace; attachments: string[] } | null = null
    await this.coordinator.acquire(input.channel, input.thread, `${input.channel}:${input.message}`, async packet => {
      for (const repo of packet.repositories) {
        const source = sources.get(repo.remote.replace(/\.git$/, ''))
        if (!source) throw new CloudControlUnavailableError('引き継ぎ元と同じリポジトリがこのPCに設定されていません。リポジトリを用意してから、もう一度引き継ぎを指示してください。')
        try { git(source, ['cat-file', '-e', `${repo.base}^{commit}`]) } catch {
          git(source, ['fetch', 'origin', repo.base])
        }
      }
      // Finish all potentially rejecting Git/attachment restoration BEFORE
      // changing cloud ownership. A bad patch cannot strand importing state.
      const receipt = join(this.stateDir, 'cloud-imports', `${digestBytes(Buffer.from(`${input.channel}:${input.message}`))}.json`)
      let workspace: Workspace
      const existing = existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) as Workspace : null
      if (existing && existing.epoch === expectedEpoch) {
        workspace = existing
      } else {
        const project = join(this.workspaceRoot(), `${waiting.id}-import-${crypto.randomUUID()}`, 'project')
        mkdirSync(project, { recursive: true, mode: 0o700 })
        const repositories = packet.repositories.map(repo => {
          const root = join(project, repo.name)
          try {
            restoreRepository(root, repo, sources.get(repo.remote.replace(/\.git$/, ''))!)
            captureRepository(root, repo.name, repo.base)
          } catch {
            throw new CloudControlUnavailableError('保存済みの変更を復元できませんでした。元の担当の所有権と保存データは保持しています。対象リポジトリと保存データの確認が必要です。')
          }
          git(root, ['switch', '-c', `zerochan/${waiting.id}/handoff-${expectedEpoch}`])
          return { root, name: repo.name, base: repo.base }
        })
        workspace = { epoch: expectedEpoch, project, repositories }
        const instructions = layout.rootInstructionPaths.filter(p => basename(p) === 'AGENTS.md')
          .map(p => readFileSync(p, 'utf8')).join('\n\n')
        writeCheckpoint(join(project, 'AGENTS.md'), Buffer.from(instructions + CONTINUATION_INSTRUCTIONS))
      }
      this.prepareWorkspaceMetadata(workspace)
      const attachments = packet.attachments.map(file => {
        const path = join(workspace.project, '.handoff-input', file.path)
        const data = Buffer.from(file.data, 'base64')
        if (!existsSync(path)) writeCheckpoint(path, data)
        else if (digestBytes(readFileSync(path)) !== file.digest) throw new Error('restored attachment changed; existing file preserved')
        return path
      })
      const contextPath = join(workspace.project, 'HANDOFF.md')
      writeCheckpoint(contextPath, Buffer.from(`# Task handoff\n\n${packet.task}\n\n${packet.history}\n\n${packet.notes.join('\n')}\n`))
      writeCheckpoint(receipt, Buffer.from(JSON.stringify(workspace)))
      prepared = { workspace, attachments }
    }, async (h, packet) => {
      if (!prepared || prepared.workspace.epoch !== h.epoch) throw new Error('prepared import epoch changed')
      writeCheckpoint(this.workspacePath(h.id), Buffer.from(JSON.stringify(prepared.workspace)))
      // Activate before enqueue; a crash is recovered by the same event ID.
      const active = await this.client.activate(h)
      this.store.enqueueCloudImport({ chatId: input.channel, threadTs: input.thread, messageId: input.message,
        userId: input.user, repoPath: input.project, writeEnabled: input.writeEnabled,
        task: `同じSlackスレッドの処理を引き継いで続けてください。作業場所にあるHANDOFF.mdを読み、既存の変更と実行済み操作を確認して残作業から進めてください。新規の依頼として設計をやり直さないでください。\n\n元の依頼:\n${packet.task}`,
        attachments: prepared.attachments }, h.id, active.epoch, JSON.stringify(active))
    })
  }
}
