#!/usr/bin/env bun

import { adoptLegacyProcessIdentity } from './process-lock.ts'

const [lockFile, pidText, ...fragments] = process.argv.slice(2)
const pid = Number(pidText)
if (!lockFile || !Number.isInteger(pid) || pid <= 0 || fragments.length === 0) process.exit(2)
adoptLegacyProcessIdentity(lockFile, pid, fragments)
