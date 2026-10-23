import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolveProjectLayout } from './project-layout.ts'
import { projectGitExecutable } from './project-git.ts'

const execute = promisify(execFile)
export type TaskStartSyncResult = { repository: string; branch: string; remote: string; sourceBranch: string; integrationBranch: string; commit: string }

/** Complete before either primary executor starts. Never stash/reset or switch
 * a shared checkout. Git itself preserves unrelated dirty files and rejects
 * updates which would overwrite them. Do not expose credential-bearing stderr. */
export async function synchronizeTaskRepository(repository: string, signal?: AbortSignal, preferredBase?: string): Promise<TaskStartSyncResult | null> {
  const git = async (...args: string[]) => {
    try {
      const { stdout } = await execute(projectGitExecutable(), [
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        '-c', 'submodule.recurse=false', '-C', repository, ...args,
      ], { encoding: 'utf8', signal, timeout: 120_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' } })
      return stdout.trim()
    } catch (error) {
      if (signal?.aborted) throw error
      throw new Error(`タスク開始前のGit同期に失敗しました（${repository} / ${args[0]}）。通信・認証、未コミット変更、競合状態を確認してください。作業は開始していません。`)
    }
  }
  const remotes = (await git('remote')).split('\n').filter(Boolean)
  if (!remotes.length) return null // A local-only repository has no remote version.
  const branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD')
  const pending = await git('ls-files', '--unmerged')
  if (pending) throw new Error(`タスク開始前のGit同期: ${repository} に未解消の競合があります。作業は開始していません。`)
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    if (existsSync(await git('rev-parse', '--path-format=absolute', '--git-path', marker))) {
      throw new Error(`タスク開始前のGit同期: ${repository} に未完了のmerge/rebase等があります。既存の変更を保持して解消してから再開してください。作業は開始していません。`)
    }
  }
  // for-each-ref handles branches without an upstream without treating a
  // normal new task branch as a Git failure.
  const tracking = (await git('for-each-ref', '--format=%(upstream:remotename)%09%(upstream:remoteref)', `refs/heads/${branch}`)).split('\t')
  const remote = tracking[0] && tracking[0] !== '.' ? tracking[0] : remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : ''
  if (!remote) throw new Error(`タスク開始前のGit同期: ${repository} の追跡remoteを特定できません。作業は開始していません。`)
  // Query the server, not potentially stale local origin/* refs. Existing
  // branches retain their upstream; new branches use the remote default.
  const heads = await git('ls-remote', '--symref', '--', remote, 'HEAD', 'refs/heads/*')
  const defaultBranch = preferredBase ?? /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(heads)?.[1]
    ?? ['develop', 'main', 'master'].find(name => heads.split('\n').some(line => line.endsWith(`\trefs/heads/${name}`))) ?? ''
  let sourceBranch = tracking[1]?.startsWith('refs/heads/') ? tracking[1].slice(11) : ''
  if (!sourceBranch || !heads.split('\n').some(line => line.endsWith(`\trefs/heads/${sourceBranch}`))) {
    sourceBranch = defaultBranch
  }
  if (!sourceBranch || !heads.split('\n').some(line => line.endsWith(`\trefs/heads/${sourceBranch}`))) {
    throw new Error(`タスク開始前のGit同期: ${repository} の取得元branchがリモートにありません。作業は開始していません。`)
  }
  // Merge preserves unpublished local commits; explicitly disable user
  // autostash/rebase settings. A conflict stops execution and remains intact.
  const integrationBranch = preferredBase ?? (['develop', 'main', 'master'].includes(sourceBranch) ? sourceBranch : defaultBranch)
  if (!integrationBranch || !heads.split('\n').some(line => line.endsWith(`\trefs/heads/${integrationBranch}`))) {
    throw new Error(`タスク開始前のGit同期: ${repository} の統合先branchを確認できません。作業は開始していません。`)
  }
  await git('pull', '--no-rebase', '--no-edit', '--no-autostash', '--ff', '--', remote, sourceBranch)
  if (integrationBranch !== sourceBranch) {
    await git('pull', '--no-rebase', '--no-edit', '--no-autostash', '--ff', '--', remote, integrationBranch)
  }
  return { repository, branch, remote, sourceBranch, integrationBranch, commit: await git('rev-parse', 'HEAD') }
}

export async function synchronizeTaskProject(job: { repoPath: string; writeEnabled: boolean; gitIntegrationBranches?: Record<string, string> }, signal?: AbortSignal): Promise<TaskStartSyncResult[]> {
  // Read-only authorization must never mutate the user's checkout.
  if (!job.writeEnabled) return []
  const results: TaskStartSyncResult[] = []
  for (const repository of resolveProjectLayout(job.repoPath).gitRoots) {
    const result = await synchronizeTaskRepository(repository, signal, job.gitIntegrationBranches?.[repository])
    if (result) results.push(result)
  }
  return results
}
