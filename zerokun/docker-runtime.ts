import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'path'
import { ensureManagedDirectory } from './managed-path.ts'
import { atomicWritePrivateFile } from './safe-file.ts'

export interface DockerRuntime {
  host: string
  socketPath: string
  pluginDirs: string[]
}

function physicalSocket(path: string): string | null {
  // Bun/macOS realpath rejects socket leaves with EOPNOTSUPP. Resolve parents
  // and leaf symlinks separately, then require a socket (never a directory).
  for (let links = 0; links < 40; links++) {
    path = join(realpathSync(dirname(path)), basename(path))
    const metadata = lstatSync(path)
    if (!metadata.isSymbolicLink()) return metadata.isSocket() ? path : null
    path = resolve(dirname(path), readlinkSync(path))
  }
  return null
}

/** Read only the selected endpoint, never export Docker config/auth or fall back to another engine. */
export function resolveDockerRuntime(options: {
  environment?: Record<string, string | undefined>
  executable?: string | null
  inspectContext?: (executable: string, environment: Record<string, string>) => string | null
  pluginCandidates?: string[]
} = {}): DockerRuntime | null {
  const source = options.environment ?? process.env
  const home = source.HOME || homedir()
  const executable = options.executable === undefined
    ? Bun.which('docker', { PATH: source.PATH })
      ?? ['/opt/homebrew/bin/docker', '/usr/local/bin/docker', '/usr/bin/docker', join(home, '.docker/bin/docker')]
        .find(path => existsSync(path))
    : options.executable
  if (!executable) return null
  const environment: Record<string, string> = { HOME: home, PATH: source.PATH || '/usr/bin:/bin' }
  for (const key of ['DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST']) {
    if (source[key]) environment[key] = source[key]!
  }
  // Explicit context wins over DOCKER_HOST, matching the Docker CLI.
  const inspect = options.inspectContext ?? ((bin, env) => {
    const result = Bun.spawnSync([bin, 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
      env, cwd: home, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5000,
    })
    return result.exitCode === 0 ? result.stdout.toString().trim() : null
  })
  let endpoint: string | null
  try {
    endpoint = !environment.DOCKER_CONTEXT && environment.DOCKER_HOST
      ? environment.DOCKER_HOST : inspect(executable, environment)
  } catch { return null }
  // Remote engines require a separate task-specific connection; do not silently select local instead.
  if (!endpoint?.startsWith('unix://')) return null
  const socket = endpoint.slice(7)
  if (!isAbsolute(socket) || normalize(socket) !== socket || /[\x00-\x1f\x7f?#]/.test(socket)) return null
  let socketPath: string
  try {
    const physical = physicalSocket(socket)
    if (!physical) return null
    socketPath = physical
  } catch { return null }
  const pluginDirs = new Set<string>()
  for (const candidate of options.pluginCandidates ?? [
    '/Applications/Docker.app/Contents/Resources/cli-plugins',
    '/opt/homebrew/lib/docker/cli-plugins', '/usr/local/lib/docker/cli-plugins',
    '/usr/local/libexec/docker/cli-plugins', '/usr/lib/docker/cli-plugins', '/usr/libexec/docker/cli-plugins',
    join(home, '.docker/cli-plugins'),
  ]) {
    try {
      const physical = realpathSync(candidate)
      if (statSync(physical).isDirectory()) pluginDirs.add(physical)
    } catch { /* Optional installed plugin directory. */ }
  }
  return { host: `unix://${socketPath}`, socketPath, pluginDirs: [...pluginDirs] }
}

/** Preserve Compose/buildx discovery under scratch HOME without copying registry credentials. */
export function prepareDockerConfig(stateDir: string, scratchDir: string, runtime: DockerRuntime): string {
  const directory = ensureManagedDirectory(stateDir, join(scratchDir, '.zero-docker'))
  atomicWritePrivateFile(join(directory, 'config.json'), JSON.stringify({ cliPluginsExtraDirs: runtime.pluginDirs }) + '\n')
  return directory
}
