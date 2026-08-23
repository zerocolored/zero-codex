#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { processLockOwnerMatches } from './process-lock.ts'

const [lockFile, pidText, pattern] = process.argv.slice(2)
const pid = Number(pidText)
if (!lockFile || !Number.isInteger(pid) || pid <= 0 || !pattern) process.exit(2)
const javascriptPattern = pattern.replaceAll('[[:space:]]', '\\s')
process.exit(processLockOwnerMatches(lockFile, pid, new RegExp(javascriptPattern)) ? 0 : 1)
