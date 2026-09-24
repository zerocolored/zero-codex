import { existsSync, lstatSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'

export interface GoogleCloudRuntime {
  bin: string
  readPaths: string[]
  config: string | null
}

/** Resolve the installed CLI and its normal configuration, without reading credentials. */
export function resolveGoogleCloudRuntime(options: {
  home?: string
  path?: string
  config?: string
  /** Fixture override for installations discoverable even with a minimal daemon PATH. */
  installedCandidates?: string[]
} = {}): GoogleCloudRuntime | null {
  const home = options.home ?? homedir()
  const executable = Bun.which('gcloud', { PATH: options.path ?? process.env.PATH })
    ?? (options.installedCandidates ?? [
      '/opt/homebrew/bin/gcloud', '/usr/local/bin/gcloud', '/usr/bin/gcloud',
      join(home, 'google-cloud-sdk/bin/gcloud'),
    ]).find(candidate => existsSync(candidate))
  if (!executable) return null
  const physical = realpathSync(executable)
  const sdk = dirname(dirname(physical))
  // Grant the SDK, not an arbitrary wrapper's parent or the whole user HOME.
  if (!existsSync(join(sdk, 'lib/gcloud.py')) || !lstatSync(physical).isFile()) return null
  const readPaths = new Set([sdk])
  // Homebrew's bin symlink traverses Caskroom before reaching share/google-cloud-sdk.
  // macOS checks that intermediate path too. The canonical bin is also put first
  // in PATH, so ordinary `gcloud` does not depend on the alias chain.
  for (const prefix of ['/opt/homebrew', '/usr/local']) {
    for (const name of ['gcloud-cli', 'google-cloud-sdk']) {
      const cask = join(prefix, 'Caskroom', name)
      if (executable.startsWith(`${prefix}/`) && existsSync(cask)) readPaths.add(cask)
    }
  }
  const configInput = options.config ?? process.env.CLOUDSDK_CONFIG
    ?? join(home, '.config/gcloud')
  let config: string | null = null
  if (isAbsolute(configInput) && existsSync(configInput)) {
    const candidate = realpathSync(configInput)
    // Do not interpret a malformed config override as a grant to all HOME/root.
    if (candidate !== '/' && candidate !== realpathSync(home)
      && lstatSync(candidate).isDirectory()) config = candidate
  }
  return { bin: join(sdk, 'bin'), readPaths: [...readPaths].map(path => resolve(path)), config }
}
