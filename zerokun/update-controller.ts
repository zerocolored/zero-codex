import { homedir } from 'os'
import { join } from 'path'
import { realpathSync } from 'fs'
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'

// Keep this wire result in a companion already copied by older installers.
export const UPDATE_DEFERRED_EXIT_CODE = 75

/** The frozen request worker can outlive a gateway from the legacy checkout. */
export function resolveUpdateController(fallback: string, home = homedir()): string {
  const registry = join(realpathSync(home), '.codex', 'zerochan-apps')
  const raw = readOptionalBoundedOwnerOnlyRegularFile(join(registry, 'update-controller.json'), 8192)
  if (raw === null) return fallback
  const record = JSON.parse(raw)
  if (record.version !== 1 || !/^[a-f0-9]{40}$/.test(record.sha)) throw new Error('更新controllerのidentityが不正です')
  const root = join(registry, 'releases', record.sha)
  if (realpathSync(root) !== root) throw new Error('更新controllerのpathが不正です')
  const manifest = readOptionalBoundedOwnerOnlyRegularFile(join(root, '.zerochan-release.json'), 8192)
  const published = manifest && JSON.parse(manifest)
  if (published?.sha !== record.sha || published.ready !== true) throw new Error('更新controllerは未検証です')
  return join(root, 'zerokun', 'update.ts')
}
