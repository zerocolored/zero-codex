import { createHash } from 'crypto'
import { basename } from 'path'
import { resolveProjectLayout } from './project-layout.ts'
import { projectGitExecutable } from './project-git.ts'

/** Stable cross-PC identity, never an authorization grant. Cloud membership is admin-managed. */
export function fleetProject(project: string): { key: string; label: string } | null {
  try {
    const layout = resolveProjectLayout(project)
    if (!layout.gitRoots.length) return null
    const remotes = layout.gitRoots.map(root => {
      const result = Bun.spawnSync([projectGitExecutable(), '-C', root, 'config', '--get-all', 'remote.origin.url'],
        { stdout: 'pipe', stderr: 'ignore', timeout: 5000 })
      if (result.exitCode !== 0) throw Error('origin unavailable')
      const raw = result.stdout.toString().trim()
      // Closed public identity representation; never hash credentials embedded in a remote URL.
      const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw)
      if (!match) throw Error('unsupported origin')
      return match[1]!.toLowerCase()
    }).sort()
    const key = createHash('sha256').update(JSON.stringify(['zero-fleet-project-v1', ...new Set(remotes)])).digest('hex')
    return { key, label: basename(layout.projectPath).slice(0, 100) }
  } catch { return null }
}
