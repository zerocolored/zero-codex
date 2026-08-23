#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { closeSync, lstatSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, join } from 'path'
import { requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { openSafeLog } from './safe-file.ts'

const [runnerInput, stateInput, logInput] = process.argv.slice(2)
if (!runnerInput || !stateInput || !logInput) {
  throw new Error('usage: runner-launcher.ts RUNNER STATE_DIR LOG_PATH')
}
if (![runnerInput, stateInput, logInput].every(isAbsolute)) {
  throw new Error('runner launcher paths must be absolute')
}

const runner = realpathSync(runnerInput)
const stateDir = requireManagedStateRoot(stateInput)
const logParent = realpathSync(dirname(logInput))
requireManagedDirectory(stateDir, logParent)
const logPath = join(logParent, basename(logInput))
const runnerMetadata = lstatSync(runner)
if (!runnerMetadata.isFile() || runnerMetadata.isSymbolicLink()) {
  throw new Error(`job runner is not a regular file: ${runner}`)
}

// Open the managed log before detaching so the child never evaluates a shell
// redirection and never follows a user-controlled log symlink.
const logDescriptor = openSafeLog(logPath, 'append')
let daemon: ReturnType<typeof Bun.spawn>
try {
  daemon = Bun.spawn([
    '/usr/bin/caffeinate', '-dimsu', process.execPath,
    '--config=/dev/null', '--no-env-file', runner, 'daemon',
  ], {
    stdin: 'ignore',
    stdout: logDescriptor,
    stderr: logDescriptor,
    detached: process.platform !== 'win32',
    env: process.env,
  })
} catch (error) {
  closeSync(logDescriptor)
  throw error
}
closeSync(logDescriptor)

daemon.unref()
process.stdout.write(`${daemon.pid}\n`)
