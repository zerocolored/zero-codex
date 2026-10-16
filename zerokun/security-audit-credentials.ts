import { createHash } from 'crypto'
import { lstatSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { z } from 'zod'
import { ensureManagedDirectory, prepareManagedStateRoot, requireManagedStateRoot } from './managed-path.ts'
import { registeredSlackAppStatePaths, slackAppRegistryRoot } from './slack-app-registry.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { releaseProcessLock, tryAcquireProcessLock } from './process-lock.ts'

type Service = 'semgrep' | 'socket'
export class AuditCredentialConflictError extends Error {}
export const auditCommonSchema = z.object({
  socketOrg: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  socketCredentialDigest: z.string().optional(),
}).strict()
const filename = (service: Service) => `security-audit-${service}-token`

function existingState(path: string): string | null {
  try { lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return requireManagedStateRoot(path)
}

function credentialScope(state: string, home: string): { root: string; legacy: string[] } {
  const physical = requireManagedStateRoot(state)
  const known = [...new Set([join(home, '.codex', 'zerokun'), ...registeredSlackAppStatePaths(home)])]
  // Standalone/custom states are isolated installations, including test fixtures.
  // Only states belonging to this user's registry (or the default state) share credentials.
  if (!known.some(path => resolve(path) === physical || resolve(path) === resolve(state))) {
    return { root: physical, legacy: [] }
  }
  const registry = prepareManagedStateRoot(slackAppRegistryRoot(home))
  const root = ensureManagedDirectory(registry, join(registry, 'security'))
  return { root, legacy: known }
}

/** Shared by all registered Slack apps of the same OS user. Never project-controlled. */
export function auditCredentialState(state: string, home = homedir()): string {
  return credentialScope(state, home).root
}

function withCredentialLock<T>(root: string, action: () => T): T {
  const path = join(root, 'credentials.lock'), deadline = Date.now() + 5000
  for (;;) {
    const attempt = tryAcquireProcessLock(path)
    if (attempt.acquired) {
      try { return action() } finally { releaseProcessLock(path, attempt.lease) }
    }
    if (Date.now() >= deadline || attempt.kind === 'owner-unavailable') {
      throw Error('セキュリティ認証情報を更新中です。少し待って再実行してください。')
    }
    Bun.sleepSync(25)
  }
}

/** Preserve old files; import only an unambiguous registration, without exposing its value. */
export function readAuditCredential(state: string, service: Service, home = homedir()): string | null {
  const scope = credentialScope(state, home)
  const read = (root: string) => readOptionalBoundedOwnerOnlyRegularFile(join(root, filename(service)), 4096)?.trim() || null
  if (!scope.legacy.length) return read(scope.root)
  return withCredentialLock(scope.root, () => {
    const shared = read(scope.root)
    if (shared) return shared
    const candidates = scope.legacy.flatMap(path => {
      const root = existingState(path)
      const token = root ? read(root) : null
      return root && token ? [{ root, token }] : []
    })
    const tokens = [...new Set(candidates.map(candidate => candidate.token))]
    if (tokens.length > 1) throw new AuditCredentialConflictError(`${service === 'socket' ? 'Socket' : 'Semgrep'}の既存登録が複数あります。共通で使うキーをこのMacの非表示入力（zerochan security ${service}-token）で登録し、このスレッドへ「登録した」と返信してください。既存登録は保持しています。キーはSlackへ投稿しないでください。`)
    const token = tokens[0]
    if (!token) return null
    if (service === 'socket') {
      const digest = createHash('sha256').update(token).digest('hex')
      const organizations = candidates.flatMap(candidate => {
        const raw = readOptionalBoundedOwnerOnlyRegularFile(join(candidate.root, 'security-audit-common.json'), 8192)
        if (!raw) return []
        const common = auditCommonSchema.parse(JSON.parse(raw))
        return common.socketCredentialDigest === digest && common.socketOrg ? [common.socketOrg] : []
      })
      const unique = [...new Set(organizations)]
      if (unique.length === 1) atomicWritePrivateFile(join(scope.root, 'security-audit-common.json'), JSON.stringify({
        socketOrg: unique[0], socketCredentialDigest: digest,
      }) + '\n')
    }
    atomicWritePrivateFile(join(scope.root, filename(service)), token + '\n')
    return token
  })
}

export function saveAuditCredential(state: string, service: Service, token: string, home = homedir()): void {
  const root = auditCredentialState(state, home)
  withCredentialLock(root, () => atomicWritePrivateFile(join(root, filename(service)), token + '\n'))
}
