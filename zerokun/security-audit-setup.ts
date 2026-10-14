import { createHash } from 'crypto'
import { lstatSync, readFileSync } from 'fs'
import { join, resolve, relative, dirname } from 'path'
import { z } from 'zod'
import { auditSettingsSchema, auditProjectKey, auditClean, type AuditSettings } from './security-audit.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { ensureManagedDirectory } from './managed-path.ts'
import { checkAuditInterrupted, discoverAuditAuthentication } from './security-audit-tools.ts'

export class AuditSetupRequiredError extends Error {
  constructor(public readonly prompt: string, public readonly inputRevision: number) { super('security audit setup requires a same-thread reply') }
}
export type AuditE2E = { kind: 'playwright'; entry: string } | { kind: 'node'; entry: string; cwd: string }
/** Read bounded source data, never import executable configuration or follow a symlink. */
function sourceText(root: string, name: string): string | null {
  if (name.startsWith('/') || name.split('/').some(part => part === '..' || (part.startsWith('.') && part !== '.'))) return null
  const path = resolve(root, name)
  if (relative(root, path).startsWith('..')) return null
  for (let p = path; p !== root; p = dirname(p)) {
    try { if (lstatSync(p).isSymbolicLink()) return null } catch { return null }
  }
  try { const s = lstatSync(path); return s.isFile() && s.size < 200_000 ? readFileSync(path, 'utf8') : null } catch { return null }
}
export function discoverAuditE2E(repo: string): { e2e?: AuditE2E; port?: number; note: string } {
  let pkg: { scripts?: Record<string, unknown> } = {}
  try { pkg = JSON.parse(sourceText(repo, 'package.json') ?? '{}') } catch {}
  const value = pkg?.scripts?.['test:e2e'] ?? pkg?.scripts?.e2e
  const script = typeof value === 'string' ? value.trim() : undefined
  const rootConfigs = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs']
    .map(ext => `playwright.config.${ext}`).filter(path => sourceText(repo, path) !== null)
  const playwright = (entry: string) => {
    const text = sourceText(repo, entry)!
    const ports = [...new Set([...text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g)]
      .map(x => Number(x[1])).filter(x => x >= 1024 && x <= 65535))]
    return { e2e: {kind: 'playwright' as const, entry}, ...(ports.length === 1 ? {port: ports[0]} : {}),
      note: 'project-selected Playwright configuration' }
  }
  // Literal command adapters only. Never evaluate a shell string or substitute a nested service.
  if (script) {
    const direct = /^node\s+([\w./-]+\.(?:cjs|mjs|js))$/.exec(script)
    const nested = /^(?:pnpm|npm)\s+(?:-C|--prefix)\s+([\w./-]+)\s+(?:exec\s+)?node\s+([\w./-]+\.(?:cjs|mjs|js))$/.exec(script)
    const cwd = nested?.[1] ?? '.', entry = nested?.[2] ?? direct?.[1]
    if (entry && !cwd.startsWith('/') && !entry.startsWith('/')
      && !cwd.split('/').includes('..') && !entry.split('/').includes('..')
      && sourceText(repo, join(cwd, entry)) !== null) {
      return {e2e: {kind: 'node', entry, cwd}, note: 'root package E2E script'}
    }
    const pw = /^(?:npx\s+|pnpm\s+exec\s+)?playwright\s+test(?:\s+--config(?:=|\s+)([\w./-]+))?$/.exec(script)
    const explicit = pw?.[1]
    if (explicit && /(?:^|\/)playwright\.config\.(?:ts|js|mts|mjs|cts|cjs)$/.test(explicit)
      && sourceText(repo, explicit) !== null) return playwright(explicit)
    if (pw && !explicit && rootConfigs.length === 1) return playwright(rootConfigs[0]!)
    return {note: 'プロジェクトのE2Eスクリプトを検出しましたが、隔離実行できる入口を確定できません。配下の別サービスのテストでは代用しません。'}
  }
  if (rootConfigs.length === 1) return playwright(rootConfigs[0]!)
  return {note: rootConfigs.length > 1 ? 'ルートに複数のE2E設定があり実行入口を確定できません。'
    : '対象プロジェクトのE2E実行入口がありません。配下の別サービスの設定では代用しません。'}
}
const commonSchema = z.object({
  socketOrg: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  socketCredentialDigest: z.string().optional(),
}).strict()
function projectSettings(state: string, repo: string): Partial<AuditSettings> {
  return JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(
    join(state, 'security-audit-settings', auditProjectKey(repo) + '.json'), 30000,
  ) ?? '{}')
}
function commonSettings(state: string): Partial<AuditSettings> {
  const common = commonSchema.parse(JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(
    join(state, 'security-audit-common.json'), 8192,
  ) ?? '{}'))
  const token = readOptionalBoundedOwnerOnlyRegularFile(join(state, 'security-audit-socket-token'), 4096)?.trim()
  return token && common.socketCredentialDigest === createHash('sha256').update(token).digest('hex')
    ? { socketOrg: common.socketOrg } : {}
}
export function loadAuditSettings(state: string, repo: string): AuditSettings {
  return auditSettingsSchema.parse({ ...commonSettings(state), ...projectSettings(state, repo) })
}
export function saveAuditSettings(state: string, repo: string, settings: AuditSettings): void {
  const root = ensureManagedDirectory(state, join(state, 'security-audit-settings'))
  const saved = { ...auditSettingsSchema.parse(settings) }
  // An inherited organization must remain linked to its credential, not become a stale project override.
  if (!projectSettings(state, repo).socketOrg && saved.socketOrg === commonSettings(state).socketOrg) delete saved.socketOrg
  atomicWritePrivateFile(join(root, auditProjectKey(repo) + '.json'), JSON.stringify(saved) + '\n')
}
function saveSocketOrganization(state: string, slug: string): void {
  const token = readOptionalBoundedOwnerOnlyRegularFile(join(state, 'security-audit-socket-token'), 4096)?.trim()
  if (!token) throw Error('Socket credential unavailable')
  atomicWritePrivateFile(join(state, 'security-audit-common.json'), JSON.stringify({
    socketOrg: slug, socketCredentialDigest: createHash('sha256').update(token).digest('hex'),
  }) + '\n')
}
export async function discoverSocketOrganization(state: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const token = readOptionalBoundedOwnerOnlyRegularFile(join(state, 'security-audit-socket-token'), 4096)?.trim()
  if (!token) return []
  const response = await fetcher('https://api.socket.dev/v0/organizations', {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) { await response.body?.cancel(); throw Error(`Socket組織確認: HTTP ${response.status}`) }
  const reader = response.body?.getReader()
  if (!reader) throw Error('Socket organization response absent')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 100000) throw Error('Socket organization response too large')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const entries = Object.values(data.organizations ?? data)
  const slugs = [...new Set(entries.flatMap((v: any) =>
    typeof v?.slug === 'string' && /^[a-zA-Z0-9_-]+$/.test(v.slug) ? [v.slug as string] : [],
  ))].sort()
  if (slugs.length === 1) saveSocketOrganization(state, slugs[0]!)
  return slugs
}
export type AuditSetupReply = { text: string; writeEnabled: boolean; revision: number;
  sourceJobId?: string; sourceControlId?: string; restrictionsOnly?: boolean }
export const AUDIT_ANSWER_VERSION = 3
/** Only explicit answer lines grant a network scope. Repository strings and model inference never do. */
export function applyAuditSetupAnswer(settings: AuditSettings, text: string, organizations: string[]): AuditSettings {
  const next = { ...settings }
  const modes = new Set<'required' | 'none'>()
  let fenced = false, deniesRequired = false
  const lines = auditClean(text).split('\n').flatMap(s => {
    const line = s.trim()
    const inline = /^(?:URL[：:]\s*)?(<https?:\/\/[^<>]+>|https?:\/\/[^\s<>]+)\s+(.+)$/.exec(line)
    return inline ? [inline[1]!, inline[2]!] : [line]
  })
  for (const line of lines) {
    if (/^```/.test(line)) { fenced = !fenced; continue }
    if (fenced || /^>/.test(line)) continue
    const answerLine = line.replace(/^URL[：:]\s*/i, '')
    const slackLink = /^<(https?:\/\/[^<>\s|]+)(?:\|[^<>\r\n]*)?>$/.exec(answerLine)
    // Slack's displayed label is not the authorized destination; use only its actual URL.
    const url = /^(https?:\/\/[^\s<>|]+)$/.exec(slackLink?.[1] ?? answerLine)?.[1]
    if (url) {
      try {
        const u = new URL(url)
        if (!u.username && !u.password && !u.hash && !u.search) {
          next.targetUrl = u.href; next.activeScan = false
          // A different site cannot inherit proof of authentication from an older site.
          if (next.targetUrl !== settings.targetUrl) { delete next.authenticatedPath; delete next.loggedInPattern; delete next.authenticationProbe }
        }
      } catch { /* malformed input remains unanswered */ }
    }
    const auth = line.normalize('NFKC').replace(/^認証:\s*/, '').replace(/[。.]$/, '').trim()
    // Whole affirmative utterances only: never grant scope from a quoted,
    // conditional, negative or interrogative mention of login.
    if (/^(?:公開|公開・未ログイン範囲|未ログイン範囲|認証不要|none)(?:です|でお願いします)?$/.test(auth)) modes.add('none')
    if (/^(?:(?:ログイン|サインイン)(?:後)?(?:も含(?:む|めて)|まで|必須)|(?:ログイン|サインイン)後(?:の(?:画面|ページ|範囲))?も(?:検査|確認)(?:して|する)|required)(?:です|お願いします|ください)?$/.test(auth)) modes.add('required')
    if (/(?:ログイン|サインイン|認証).*(?:含めない|含まない|除外|除く|しない|不要)/.test(auth) && !modes.has('none')) deniesRequired = true
    const path = /^確認パス[：:]\s*(\/[^\s]*)$/.exec(line)?.[1]
    if (path && !path.startsWith('//') && !/[?#]/.test(path)) next.authenticatedPath = path
    const pattern = /^確認文言[：:]\s*(.{1,200})$/.exec(line)?.[1]
    if (pattern) next.loggedInPattern = pattern
    const org = line.replace(/^Socket(?:組織)?[：:]\s*/i, '')
    if (organizations.includes(org)) next.socketOrg = org
  }
  if (modes.size === 1) next.authentication = [...modes][0]
  else if (modes.size > 1) delete next.authentication
  if (deniesRequired) delete next.authentication
  return auditSettingsSchema.parse(next)
}
export async function initializeAudit(
  job: { id: string; repoPath: string; inputRevision: number }, state: string, replies: AuditSetupReply[],
  options: { organizations?: typeof discoverSocketOrganization; authentication?: typeof discoverAuditAuthentication;
    signal?: AbortSignal; cancelled?: () => boolean; onProcessId?: (pid: number) => void; onProcessExit?: (code: number) => void } = {},
): Promise<AuditSettings> {
  checkAuditInterrupted(options)
  const root = ensureManagedDirectory(state, join(state, 'security-audit-initializations'))
  // job IDs come from the durable queue. Do not allow callers to choose a path outside that journal.
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(job.id)) throw Error('invalid audit job identity')
  const path = join(root, job.id + '.json')
  const recordSchema = z.object({ parserVersion: z.number().int().default(1), repoPath: z.string(), appliedRevision: z.number().int(), ready: z.boolean(), settings: auditSettingsSchema,
    inheritedControls: z.array(z.string()).default([]) }).strict()
  const saved = readOptionalBoundedOwnerOnlyRegularFile(path, 30000)
  const prior = saved ? recordSchema.parse(JSON.parse(saved)) : null
  if (prior && prior.repoPath !== job.repoPath) throw Error('audit initialization repository changed')
  if (prior?.ready && prior.appliedRevision === job.inputRevision) return prior.settings
  let settings = loadAuditSettings(state, job.repoPath)
  let organizations: string[] = [], orgError = ''
  if (!settings.socketOrg) {
    try {
      organizations = await (options.organizations ?? discoverSocketOrganization)(state)
      settings = loadAuditSettings(state, job.repoPath)
      if (organizations.length === 1) settings.socketOrg = organizations[0]
    } catch { orgError = 'Socketの組織を自動確認できませんでした。接続・権限の復旧後、このスレッドへ返信すると再確認します。' }
  }
  checkAuditInterrupted(options)
  const discovery = discoverAuditE2E(job.repoPath)
  // Re-discover on every request; never keep a removed or unrelated service's E2E entry.
  settings.e2e = discovery.e2e
  if (!settings.e2ePort && discovery.port) settings.e2ePort = discovery.port
  const replay = prior && !prior.ready && prior.parserVersion < AUDIT_ANSWER_VERSION
  const historical = replies.filter(r => r.sourceJobId && r.sourceJobId !== job.id)
  const current = replies.filter(r => !r.sourceJobId || r.sourceJobId === job.id).sort((a, b) => a.revision - b.revision)
  const inheritedControls = new Set(prior?.inheritedControls ?? [])
  // History is already ordered by the store. Its revisions belong to other
  // jobs and must never be compared with this job's revision or sorted across jobs.
  for (const reply of [...(!prior || replay ? historical : []), ...current]) {
    const inherited = !!reply.sourceJobId && reply.sourceJobId !== job.id
    if (!reply.writeEnabled || (!inherited && (reply.revision <= (replay ? 0 : prior?.appliedRevision ?? 0) || reply.revision > job.inputRevision))) continue
    const next = applyAuditSetupAnswer(settings, reply.text, organizations)
    if (inherited && reply.sourceControlId) inheritedControls.add(reply.sourceControlId)
    // A coding task is not an audit target grant. Retain its explicit narrowing
    // of an existing login grant, but never infer a URL, organization or new scope.
    if (reply.restrictionsOnly) {
      if (settings.authentication === 'required' && next.authentication !== 'required') {
        if (next.authentication === 'none') settings.authentication = 'none'
        else delete settings.authentication
      }
      continue
    }
    if (next.socketOrg && organizations.includes(next.socketOrg)) saveSocketOrganization(state, next.socketOrg)
    settings = next
  }
  checkAuditInterrupted(options)
  const needs: string[] = []
  if (!settings.targetUrl) needs.push('検査してよいWeb環境を「URL: https://対象のアドレス」の形で教えてください。')
  if (!settings.authentication) needs.push('Web検査の範囲を「認証: 公開・未ログイン範囲」または「認証: ログイン後も含む」で教えてください。')
  if (settings.authentication === 'required' && settings.targetUrl) {
    const found = await (options.authentication ?? discoverAuditAuthentication)(job, state, settings, options)
    checkAuditInterrupted(options)
    if (found.status === 'verified') {
      settings.authenticatedPath = found.path
      settings.authenticationProbe = found.kind
      settings.loggedInPattern = found.pattern
    } else {
      // Keep explicit/custom probe candidates for the next attempt. They are
      // not proof of readiness; this job remains parked until reverified.
      needs.push(found.status === 'no-session'
        ? 'ログイン後まで検査する指示は受け付けました。このMacのChromeで対象サイトへログインし、このスレッドへ「ログインした」と返信してください。確認ページは自動で探します。パスワードやcookieは投稿しないでください。'
        : 'ログイン後まで検査する指示は受け付けましたが、Chromeとの接続または認証状態の自動確認が成立していません。対象サイトをこのMacのChromeで開き、ログイン状態をご確認のうえ、このスレッドへ返信してください。確認ページは自動で再探索します。検査はまだ開始していません。')
    }
  }
  saveAuditSettings(state, job.repoPath, settings)
  const socketToken = readOptionalBoundedOwnerOnlyRegularFile(join(state, 'security-audit-socket-token'), 4096)?.trim()
  if (!settings.socketOrg && socketToken) needs.push(organizations.length
    ? 'Socketの組織候補から使う組織を「Socket: 組織名」で教えてください: ' + organizations.join(' / ') : orgError || 'このSocketキーで利用できる組織が見つかりません。権限の復旧後、このスレッドへ返信してください。')
  for (const [service, name] of [['Semgrep', 'semgrep'], ['Socket', 'socket']] as const) {
    if (!readOptionalBoundedOwnerOnlyRegularFile(join(state, `security-audit-${name}-token`), 4096)?.trim()) {
      needs.push(`${service}の接続が未登録です。このMacの非表示入力（zerochan security ${name}-token）で一度だけ登録後、このスレッドへ「登録した」と返信してください。キーはSlackへ投稿しないでください。`)
    }
  }
  atomicWritePrivateFile(path, JSON.stringify({ parserVersion: AUDIT_ANSWER_VERSION, repoPath: job.repoPath, appliedRevision: job.inputRevision, ready: needs.length === 0, settings, inheritedControls: [...inheritedControls] }) + '\n')
  if (needs.length) throw new AuditSetupRequiredError(
    'セキュリティ検査の初期設定を進めています。共通設定とプロジェクト構成を確認しました。次の不足分だけ、このスレッドへ返信してください。\n'
    + needs.map(x => '・' + x).join('\n')
    + '\n回答は保存し、同じ依頼から利用可能チェックを再開します。検査の再依頼は不要です。', job.inputRevision,
  )
  return settings
}
