import { existsSync, lstatSync, realpathSync, symlinkSync, renameSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { ensureManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { slackAppRegistryRoot } from './slack-app-registry.ts'

export interface RuntimeRelease { version: 1; sha: string; path: string }
export const RELEASE_PIN = 'runtime-release.json'
export const RELEASE_JOURNAL = 'release-transaction.json'
export function releaseIdentity(value: unknown, home = homedir()): RuntimeRelease {
  const r = value as RuntimeRelease
  if (!r || r.version !== 1 || !/^[a-f0-9]{40}$/.test(r.sha)
    || r.path !== join(slackAppRegistryRoot(home), 'releases', r.sha)) throw new Error('更新releaseのidentityが不正です')
  return r
}
export function validateRelease(value: unknown, home = homedir()): RuntimeRelease {
  const r = releaseIdentity(value, home)
  if (realpathSync(r.path) !== r.path) throw new Error('更新releaseのphysical pathが不正です')
  const stat = lstatSync(r.path)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) {
    throw new Error('更新releaseのdirectoryが安全ではありません')
  }
  const manifest = readOptionalBoundedOwnerOnlyRegularFile(join(r.path, '.zerochan-release.json'), 8192)
  const m = manifest && JSON.parse(manifest)
  if (m?.version !== 1 || m.sha !== r.sha || m.ready !== true) throw new Error('更新releaseは未検証です')
  const head = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', 'rev-parse', 'HEAD'], { cwd: r.path, stdout: 'pipe', stderr: 'pipe' })
  const clean = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', 'diff', '--quiet', 'HEAD', '--'], { cwd: r.path, stdout: 'pipe', stderr: 'pipe' })
  if (head.exitCode !== 0 || head.stdout.toString().trim() !== r.sha || clean.exitCode !== 0) throw new Error('実行releaseのcommitまたは内容が変化しています')
  return r
}
export function readRuntimeRelease(state: string, home = homedir()): RuntimeRelease | null {
  const raw = readOptionalBoundedOwnerOnlyRegularFile(join(state, RELEASE_PIN), 8192)
  return raw === null ? null : validateRelease(JSON.parse(raw), home)
}
export function writeRuntimeRelease(state: string, release: RuntimeRelease, home = homedir()): void {
  requireManagedStateRoot(state)
  atomicWritePrivateFile(join(state, RELEASE_PIN), JSON.stringify(validateRelease(release, home)) + '\n')
}
export function runtimeRootForState(state: string, fallback: string): string {
  const pinned = readRuntimeRelease(state)
  if (pinned) return pinned.path
  const legacy = readOptionalBoundedOwnerOnlyRegularFile(join(state, 'legacy-runtime.json'), 8192)
  if (legacy !== null) {
    const value = JSON.parse(legacy)
    if (value.version !== 1 || typeof value.path !== 'string' || realpathSync(value.path) !== value.path) throw new Error('旧runtimeのidentityが不正です')
    return value.path
  }
  const installed = join(state, 'job-runner.ts')
  if (existsSync(installed)) {
    const runner = realpathSync(installed)
    if (!runner.endsWith('/zerokun/job-runner.ts')) throw new Error('既存runnerの配置が不正です')
    return dirname(dirname(runner))
  }
  return realpathSync(fallback)
}
/** Helpers belong to the code version; a peer must never replace their bytes. */
export function releaseRuntimeRelative(root = dirname(import.meta.dir)): string {
  const raw = readOptionalBoundedOwnerOnlyRegularFile(join(root, '.zerochan-release.json'), 8192)
  if (raw === null) return '.zerokun/runtime'
  const m = JSON.parse(raw)
  if (m.version !== 1 || !/^[a-f0-9]{40}$/.test(m.sha)) throw new Error('release manifestが不正です')
  return `.zerokun/runtime/releases/${m.sha}`
}
export function installLegacyCommands(state: string, root: string): void {
  requireManagedStateRoot(state)
  const directory = ensureManagedDirectory(state, join(state, 'legacy-commands'))
  for (const name of ['zerochan', 'zerokun', 'codex-channel']) {
    const path = join(directory, name)
    if (existsSync(path)) {
      if (realpathSync(path) !== join(root, 'codex-channel.sh')) throw new Error('旧commandの参照先が変わっています')
      continue
    }
    try { symlinkSync(join(root, 'codex-channel.sh'), path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || realpathSync(path) !== join(root, 'codex-channel.sh')) throw error
    }
  }
}
export function runtimeCommandForState(state: string, fallback: string, name: string): string {
  if (!['zerochan', 'zerokun', 'codex-channel'].includes(name)) throw new Error('不明なcommand名です')
  const root = runtimeRootForState(state, fallback)
  const pinned = readRuntimeRelease(state)
  if (!pinned) installLegacyCommands(state, root)
  const command = pinned
    ? join(root, '.release-bin', name) : join(state, 'legacy-commands', name)
  if (realpathSync(command) !== join(root, 'codex-channel.sh')) throw new Error('commandとruntimeの参照先が一致しません')
  return command
}
if (import.meta.main) {
  const [state, fallback, name] = process.argv.slice(2)
  if (!state || !fallback) throw new Error('usage: runtime-release.ts <state> <fallback> [command]')
  process.stdout.write((name ? runtimeCommandForState(state, fallback, name) : runtimeRootForState(state, fallback)) + '\n')
}
