import { chmodSync, readFileSync, lstatSync, readlinkSync, symlinkSync } from 'fs'
import { join } from 'path'
import { requireManagedStateRoot } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { installUpdateRequestRuntime } from './update-runtime.ts'
import { JobStore } from './job-runner.ts'

/** Initialize only the new App's state, not the user's shell or global helpers. */
export function prepareSlackAppState(stateDir: string, appId: string, sourceDir = import.meta.dir): void {
  const state = requireManagedStateRoot(stateDir)
  const marker = join(state, 'app-state-prepared.json')
  const previous = readOptionalBoundedOwnerOnlyRegularFile(marker, 1024)
  if (previous !== null) {
    if (JSON.parse(previous).appId !== appId) throw new Error('保存先のSlackアプリが一致しません')
    return
  }
  const access = join(state, 'access.json')
  if (readOptionalBoundedOwnerOnlyRegularFile(access, 1024 * 1024) === null) {
    atomicWritePrivateFile(access, readFileSync(join(sourceDir, 'templates/access.json.example')))
  }
  installUpdateRequestRuntime(sourceDir, state)
  for (const name of ['job-runner.ts', 'codex-executor.ts']) {
    const destination = join(state, name)
    const target = join(sourceDir, name)
    let existing
    try { existing = lstatSync(destination) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (existing) {
      if (!existing.isSymbolicLink() || readlinkSync(destination) !== target) {
        throw new Error('アプリの実行ファイルが既存の別ファイルと重なっています。既存ファイルを保持しました')
      }
    } else symlinkSync(target, destination)
  }
  atomicWritePrivateFile(join(state, 'watchdog.sh'), readFileSync(join(sourceDir, 'watchdog.sh')))
  chmodSync(join(state, 'watchdog.sh'), 0o700)
  const store = new JobStore(join(state, 'jobs.sqlite3'))
  try { store.initializeSlackCatchupFloorIfPristine(appId, Date.now()) }
  finally { store.close() }
  atomicWritePrivateFile(marker, JSON.stringify({ version: 1, appId }) + '\n')
}
