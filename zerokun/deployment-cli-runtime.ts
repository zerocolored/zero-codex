import { lstatSync, readlinkSync, realpathSync, symlinkSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'
import { requireManagedDirectory } from './managed-path.ts'

export type DeploymentCliConfig = { name: 'railway' | 'wrangler'; directory: string }

/** Resolve only configuration directories; never read, copy or export token bytes. */
export function resolveDeploymentCliConfigs(options: {
  home?: string
  xdgConfigHome?: string
  platform?: string
} = {}): DeploymentCliConfig[] {
  const home = options.home ?? homedir()
  const xdg = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME
    ?? join(home, (options.platform ?? process.platform) === 'darwin' ? 'Library/Preferences' : '.config')
  const configs: DeploymentCliConfig[] = []
  for (const name of ['railway', 'wrangler'] as const) {
    // Wrangler gives the legacy HOME directory priority over its XDG directory.
    const candidates = [join(home, `.${name}`), ...(name === 'wrangler' && isAbsolute(xdg)
      ? [join(xdg, '.wrangler')] : [])]
    for (const directory of candidates) {
      try {
        const metadata = lstatSync(directory)
        if (!metadata.isDirectory() || metadata.isSymbolicLink()
          || metadata.uid !== process.getuid?.() || (metadata.mode & 0o022) !== 0) break
        configs.push({ name, directory: realpathSync(directory) })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') break
      }
    }
  }
  return configs
}

/** Native CLIs retain their own refresh/locking behavior through a narrow link.
 * Existing job files are never replaced, and operator HOME is never inherited. */
export function linkDeploymentCliConfig(state: string, scratch: string, config: DeploymentCliConfig): boolean {
  requireManagedDirectory(state, scratch)
  const destination = join(scratch, `.${config.name}`)
  try {
    symlinkSync(config.directory, destination, 'dir')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return lstatSync(destination).isSymbolicLink() && readlinkSync(destination) === config.directory
  }
}
