#!/usr/bin/env bun

import { closeSync, writeSync } from 'fs'
import { dirname } from 'path'
import { requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { openSafeLog } from './safe-file.ts'

const [stateDir, logPath] = process.argv.slice(2)
if (!stateDir || !logPath) throw new Error('usage: safe-log-sink.ts STATE_DIR LOG_PATH')
requireManagedStateRoot(stateDir)
requireManagedDirectory(stateDir, dirname(logPath))
const descriptor = openSafeLog(logPath, 'append')
try {
  for await (const chunk of Bun.stdin.stream()) writeSync(descriptor, chunk)
} finally {
  closeSync(descriptor)
}
