import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { parseStateSlackTokens } from './child-environment.ts'

const CUTOVER_MARKER = 'zerokun-codex-legacy-cutover-v1'

function physicalPathWithMissingSuffix(input: string): string {
  const normalized = resolve(input)
  let ancestor = normalized
  const suffix: string[] = []
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return normalized
    suffix.unshift(basename(ancestor))
    ancestor = parent
  }
  try {
    return join(realpathSync(ancestor), ...suffix)
  } catch {
    return normalized
  }
}

function ownedRegularFile(path: string): boolean {
  try {
    const metadata = lstatSync(path)
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
      && (typeof process.getuid !== 'function' || metadata.uid === process.getuid())
  } catch {
    return false
  }
}

function validSlackEnvironment(stateDir: string): boolean {
  const path = join(stateDir, '.env')
  if (!ownedRegularFile(path)) return false
  try {
    const content = readFileSync(path, 'utf8')
    const tokens = parseStateSlackTokens(content)
    return content.length > 0 && Boolean(tokens.SLACK_BOT_TOKEN && tokens.SLACK_APP_TOKEN)
  } catch {
    return false
  }
}

function validCutoverMarker(stateDir: string): boolean {
  const path = join(stateDir, '.codex-legacy-cutover')
  if (!ownedRegularFile(path)) return false
  try {
    const physicalState = realpathSync(stateDir)
    return readFileSync(path, 'utf8') === `${CUTOVER_MARKER}\n${physicalState}\n`
  } catch {
    return false
  }
}

function requireEstablishedLegacyCutover(stateDir: string, legacyState: string): void {
  let selectedPhysical: string
  try {
    const metadata = lstatSync(stateDir)
    const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownerMatches) throw new Error()
    selectedPhysical = realpathSync(stateDir)
  } catch {
    throw new Error(`legacy cutover state does not exist or is unsafe: ${stateDir}`)
  }
  if (!validSlackEnvironment(stateDir)) {
    throw new Error(`legacy cutover state has no valid Slack App tokens: ${stateDir}`)
  }
  if (validCutoverMarker(stateDir)) return
  try {
    if (realpathSync(legacyState) === selectedPhysical) return
  } catch {}
  throw new Error(`legacy cutover state is not established: ${stateDir}`)
}

export function resolveZeroStateDir(
  environment: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  const codexState = join(home, '.codex', 'zerokun')
  const configured = environment.ZEROKUN_STATE_DIR
  const legacyState = join(home, '.claude', 'channels', 'slack')
  const cutover = environment.ZEROKUN_LEGACY_CUTOVER ?? '0'
  if (cutover !== '0' && cutover !== '1') {
    throw new Error('ZEROKUN_LEGACY_CUTOVER must be 0 or 1')
  }
  if (cutover === '1') {
    const selected = configured ?? codexState
    requireEstablishedLegacyCutover(selected, legacyState)
    return selected
  }
  if (!configured) return codexState
  // A physical state that completed a legacy cutover remains legacy even if
  // ~/.claude was later removed. Never let a stale flag=0 adopt its old App.
  if (validCutoverMarker(configured)) return codexState
  const configuredLogical = resolve(configured)
  const configuredPhysical = physicalPathWithMissingSuffix(configured)
  const legacyPhysical = physicalPathWithMissingSuffix(legacyState)
  const selectsLegacy = configuredLogical === resolve(legacyState)
    || configuredLogical.endsWith('/.claude/channels/slack')
    || configuredPhysical === legacyPhysical
    || configuredPhysical.endsWith('/.claude/channels/slack')
  if (selectsLegacy) return codexState
  return configured
}

/** Keep every runtime/update SQLite path inside the selected physical state root. */
export function resolveZeroJobDatabasePath(
  stateDir: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  const statePhysical = physicalPathWithMissingSuffix(stateDir)
  const expectedPhysical = physicalPathWithMissingSuffix(join(stateDir, 'jobs.sqlite3'))
  const candidatePhysical = physicalPathWithMissingSuffix(
    environment.ZEROKUN_JOB_DB ?? join(stateDir, 'jobs.sqlite3'),
  )
  const child = relative(statePhysical, candidatePhysical)
  if (!child || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(child) || candidatePhysical !== expectedPhysical) {
    throw new Error(`ZEROKUN_JOB_DB must be the selected state's jobs.sqlite3: ${stateDir}`)
  }
  return candidatePhysical
}
