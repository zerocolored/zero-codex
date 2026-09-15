import { execFileSync } from 'child_process'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { isAbsolute, join, relative } from 'path'
import { assertDescriptorStillNamesPath } from './safe-file.ts'

const KEY_FILE = '.env.keys'
const MAX_BYTES = 64 * 1024
export type LocalSettingsStatus = 'ready' | 'missing' | 'unavailable'
function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}
export function localRepositoryIdentity(root: string): string {
  return git(root, ['remote', 'get-url', 'origin']).replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
}

/** Local runtime provisioning, never part of a handoff packet. Only the
 * receiver's matching checkout is a credential source. No values are logged,
 * parsed into prompts, or returned. Existing workspace settings are preserved. */
export function provisionLocalWorkspaceSettings(source: string, destination: string): LocalSettingsStatus {
  let input: number | undefined
  let output: number | undefined
  let temporary: string | undefined
  try {
    source = realpathSync(source); destination = realpathSync(destination)
    if (source === destination) {
      try { return lstatSync(join(source, KEY_FILE)).isFile() ? 'ready' : 'unavailable' } catch { return 'missing' }
    }
    if (localRepositoryIdentity(source) !== localRepositoryIdentity(destination)) return 'unavailable'
    // Legacy linked worktrees share their common Git directory. Do not mutate
    // another checkout's exclude settings while provisioning a dedicated clone.
    const common = realpathSync(git(destination, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
    const commonRelative = relative(destination, common)
    if (commonRelative === '..' || commonRelative.startsWith('../') || isAbsolute(commonRelative)) return 'unavailable'
    // Never place credentials at a versioned path, even with an ignore rule.
    if (git(destination, ['ls-files', '--', KEY_FILE])) return 'unavailable'
    const target = join(destination, KEY_FILE)
    try {
      const existing = lstatSync(target)
      if (!existing.isFile() || existing.nlink !== 1 || existing.uid !== process.getuid?.()) return 'unavailable'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // Repository-owned ignore rules may change. A local rule keeps the key
    // out of git add, status and cloud capture without modifying tracked files.
    const exclude = git(destination, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])
    const excludeFd = openSync(exclude, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try {
      if (!fstatSync(excludeFd).isFile() || fstatSync(excludeFd).nlink !== 1) return 'unavailable'
      // check-ignore includes existing repo rules; avoid appending on every resume.
      let ignored = false
      try { ignored = git(destination, ['check-ignore', '--', KEY_FILE]) === KEY_FILE } catch { /* add local rule */ }
      if (!ignored) writeFileSync(excludeFd, `\n/${KEY_FILE}\n`)
    } finally { closeSync(excludeFd) }
    // A tracked .gitignore negation can override info/exclude. Never expose
    // a newly copied credential to git add in that configuration.
    if (git(destination, ['check-ignore', '--', KEY_FILE]) !== KEY_FILE) return 'unavailable'
    try { lstatSync(target); return 'ready' } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try { input = openSync(join(source, KEY_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
    const stat = fstatSync(input)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > MAX_BYTES) return 'unavailable'
    // Read opaque bounded bytes through a verified descriptor; the source's
    // permissions and content are never changed.
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    try {
      let size = 0
      while (size < bytes.length) {
        const n = readSync(input, bytes, size, bytes.length - size, null)
        if (!n) break
        size += n
      }
      if (size > MAX_BYTES) return 'unavailable'
      assertDescriptorStillNamesPath(input, join(source, KEY_FILE))
      temporary = join(destination, `.env.keys.${randomUUID()}.tmp`)
      output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      writeFileSync(output, bytes.subarray(0, size))
      fsyncSync(output)
      // Publish only complete bytes, without replacing an existing setting.
      linkSync(temporary, target)
    } finally { bytes.fill(0) }
    return 'ready'
  } catch {
    // Infrastructure/provisioning failure must not prevent unrelated work.
    // The executor receives a value-free diagnostic and must preflight dotenvx
    // before any authenticated API operation, rather than guessing key expiry.
    return 'unavailable'
  } finally {
    if (input !== undefined) closeSync(input)
    if (output !== undefined) closeSync(output)
    if (temporary !== undefined) unlinkSync(temporary)
  }
}
