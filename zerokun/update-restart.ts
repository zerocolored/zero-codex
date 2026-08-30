#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { createHash } from 'crypto'
import { realpathSync, rmSync } from 'fs'
import { isAbsolute, join } from 'path'
import { buildRuntimeServiceEnvironment } from './child-environment.ts'
import { HERDR_ENVIRONMENT_KEYS } from './herdr-runtime.ts'
import { requireManagedStateRoot } from './managed-path.ts'
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { resolveZeroJobDatabasePath } from './state-dir.ts'

const REQUEST_MAX_BYTES = 128 * 1024
const TOKEN_MAX_BYTES = 256

type RestartRequest = {
  version: 1
  rootRepo: string
  stateDir: string
  projectDir: string
  replaceTokenFile: string
  replaceTokenDigest: string
  release: string
  legacyCutover: boolean
  environment: Record<string, string>
}

const REQUEST_KEYS = [
  'environment', 'legacyCutover', 'projectDir', 'release', 'replaceTokenDigest',
  'replaceTokenFile', 'rootRepo', 'stateDir', 'version',
] as const

function parseRequest(path: string): RestartRequest {
  if (!isAbsolute(path)) throw new Error('restart request path must be absolute')
  const raw = readOptionalBoundedOwnerOnlyRegularFile(path, REQUEST_MAX_BYTES)
  if (raw === null) throw new Error('restart request is missing')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('restart request is invalid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('restart request is invalid')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('\n') !== [...REQUEST_KEYS].sort().join('\n')) {
    throw new Error('restart request has unexpected fields')
  }
  if (record.version !== 1 || typeof record.rootRepo !== 'string'
    || typeof record.stateDir !== 'string' || typeof record.projectDir !== 'string'
    || typeof record.replaceTokenFile !== 'string'
    || typeof record.replaceTokenDigest !== 'string'
    || typeof record.release !== 'string' || typeof record.legacyCutover !== 'boolean'
    || !record.environment || typeof record.environment !== 'object'
    || Array.isArray(record.environment)) {
    throw new Error('restart request fields are invalid')
  }
  if (![record.rootRepo, record.stateDir, record.projectDir, record.replaceTokenFile]
    .every(pathValue => isAbsolute(pathValue))) {
    throw new Error('restart request paths must be absolute')
  }
  if (!/^[0-9a-f]{64}$/.test(record.replaceTokenDigest)
    || !/^[0-9a-f]{40}$/.test(record.release)) {
    throw new Error('restart request digest or release is invalid')
  }
  const environment: Record<string, string> = {}
  let environmentBytes = 0
  for (const [key, environmentValue] of Object.entries(
    record.environment as Record<string, unknown>,
  )) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof environmentValue !== 'string'
      || environmentValue.includes('\0')) {
      throw new Error('restart request environment is invalid')
    }
    environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(environmentValue)
    if (environmentBytes > 64 * 1024) throw new Error('restart request environment is too large')
    environment[key] = environmentValue
  }
  return {
    version: 1,
    rootRepo: record.rootRepo,
    stateDir: record.stateDir,
    projectDir: record.projectDir,
    replaceTokenFile: record.replaceTokenFile,
    replaceTokenDigest: record.replaceTokenDigest,
    release: record.release,
    legacyCutover: record.legacyCutover,
    environment,
  }
}

async function main(): Promise<void> {
  const [requestInput] = process.argv.slice(2)
  if (!requestInput || process.argv.length !== 3) {
    throw new Error('usage: update-restart.ts REQUEST_FILE')
  }
  const request = parseRequest(requestInput)
  const rootRepo = realpathSync(request.rootRepo)
  const stateDir = requireManagedStateRoot(request.stateDir)
  if (request.replaceTokenFile !== join(stateDir, 'replace-token')) {
    throw new Error('restart token path is invalid')
  }
  const projectDir = realpathSync(request.projectDir)
  const token = readOptionalBoundedOwnerOnlyRegularFile(
    request.replaceTokenFile,
    TOKEN_MAX_BYTES,
  )
  if (token === null
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)
    || createHash('sha256').update(token).digest('hex') !== request.replaceTokenDigest) {
    throw new Error('restart token changed or is invalid')
  }

  const dynamicHerdrEnvironment = Object.fromEntries(
    HERDR_ENVIRONMENT_KEYS.flatMap(key => (
      process.env[key] === undefined ? [] : [[key, process.env[key]!]]
    )),
  )
  const environment = {
    ...buildRuntimeServiceEnvironment({
      ...request.environment,
      ...dynamicHerdrEnvironment,
    }),
    ZEROKUN_JOB_DB: resolveZeroJobDatabasePath(stateDir),
    ZEROKUN_REPLACE: '1',
    ZEROKUN_UPDATE_RESTART: '1',
    ZEROKUN_LEGACY_CUTOVER: request.legacyCutover ? '1' : '0',
    ZEROKUN_STATE_DIR: stateDir,
    ZEROKUN_PROJECT_DIR: projectDir,
    ZEROKUN_REPLACE_TOKEN_FILE: request.replaceTokenFile,
    ZEROKUN_RELEASE_COMMIT: request.release,
    ZEROKUN_REPLACE_TOKEN: token,
  }
  rmSync(requestInput)

  const launcher = join(rootRepo, 'codex-channel.sh')
  const child = Bun.spawn([launcher, projectDir], {
    cwd: projectDir,
    env: environment,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const forward = (signal: NodeJS.Signals) => {
    try { child.kill(signal) } catch {}
  }
  const onInt = () => forward('SIGINT')
  const onTerm = () => forward('SIGTERM')
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  try {
    process.exitCode = await child.exited
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`❌ Zeroちゃんの再起動helper: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
