#!/usr/bin/env -S bun --config=/dev/null --no-env-file

// 実機検証には、検証用ビルドを「アプリケーション」へ置く必要がある。しかし
// そこへの書き込みを job へ直接許すと、Chrome でも Slack でも差し替えられて
// しまう。窓口を通し、対象アプリ・置ける中身・戻せることの3つを固定する。
//
//   ・対象は MANAGED_APPS の名前だけ
//   ・置けるのは、その job 自身が artifact として出した zip だけ(SHA 照合つき)
//   ・既存アプリは消さず退避し、いつでも戻せる。戻すまで次は置けない

import { closeSync, constants, fstatSync, openSync, readSync, writeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, isAbsolute, join, resolve, sep } from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { parseGitHubBrokerContext } from './github-credential-broker.ts'
import { runBoundedHostCommand } from './github-publication.ts'
import { requireManagedStateRoot, prepareManagedStateRoot, ensureManagedDirectory } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalPrivateFile } from './safe-file.ts'
import { tryAcquireProcessLock, releaseProcessLock } from './process-lock.ts'

/** 差し替えを許すアプリ。ここに無い名前は窓口が受け付けない。 */
export const MANAGED_APPS = ['bellMe.app'] as const
export const APPLICATIONS_ROOT = '/Applications'
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024
/**
 * 検証用ビルドは adhoc 署名で出てくる。adhoc は再ビルドのたびに別アプリ扱いに
 * なるため、画面収録などの許可を毎回取り直すことになる。bootstrap が用意した
 * 検証専用の自己署名で上書きすると、利用者の許可は1回で済む。会社の配布用
 * 証明書ではないので、他の Mac では何の効力も持たない。
 */
export const VERIFICATION_SIGNING_IDENTITY = 'zerokun verification (local only)'
// 検証版だけ identifier を変える案は取り下げた(2026-09-29)。許可の行を分けられる
// 一方で、Computer Use が対象を解決できず Invalid app になる。登録し直し・
// 起動中プロセスの終了・置いた後の起動を順に足しても解消しなかった。許可を
// 取り直す手間より、実機を操作できないことの方が高くつく。
const SHA256 = /^[0-9a-f]{64}$/
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

export type AppSwapCommands = {
  run: (argv: readonly string[], signal?: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  sha256: (path: string) => Promise<string>
}

// 起動中のアプリは起動時の identity を保ったままなので、置き換えても解決は
// 旧 ID を返し続ける。LaunchServices へ登録し直しても変わらない。差し替えの
// 前に終了させて、古い identity を持つプロセスを残さない。
async function quitRunningApp(
  commands: AppSwapCommands,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  // 該当が無いときの終了コード1は正常。ここで失敗扱いにしない。
  const pattern = `^${`${APPLICATIONS_ROOT}/${name}/Contents/MacOS/`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  const result = await commands.run(['/usr/bin/pkill', '-f', pattern], signal)
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error('App swap could not stop the running application')
}

// bundle の identifier を差し替えても LaunchServices は古い記録を持ったままで、
// Computer Use は一覧に出たアプリを掴めず Invalid app を返す。置いた直後に
// 登録し直して、記録を実体へ合わせる。
async function refreshLaunchServices(
  commands: AppSwapCommands,
  bundle: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const registered = await commands.run([LSREGISTER, '-f', bundle], signal)
  return registered.exitCode === 0
}

// Computer Use が掴めるのは走っているアプリだけ。差し替えの前に終了させる
// 以上、置いた後は自分で起動し直さないと、掴む相手が居ない状態になる。
async function launchInstalledApp(
  commands: AppSwapCommands,
  bundle: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const launched = await commands.run(['/usr/bin/open', '-g', bundle], signal)
  return launched.exitCode === 0
}

/** 署名できたかを返す。証明書が無い Mac でも差し替えそのものは続ける。 */
async function signForStableIdentity(
  commands: AppSwapCommands,
  bundle: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const available = await commands.run(['/usr/bin/security', 'find-identity', '-p', 'codesigning'], signal)
  if (available.exitCode !== 0 || !available.stdout.includes(VERIFICATION_SIGNING_IDENTITY)) return false
  const signed = await commands.run(
    ['/usr/bin/codesign', '--force', '--deep', '--sign', VERIFICATION_SIGNING_IDENTITY, bundle], signal)
  return signed.exitCode === 0
}

export type AppSwapContext = {
  jobId: string
  artifactDir: string
  backupRoot: string
  /** Host-supplied fixture root only; never taken from MCP input. */
  applicationsRoot?: string
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function managedAppPath(name: string, context?: AppSwapContext): string {
  if (!MANAGED_APPS.includes(name as (typeof MANAGED_APPS)[number])) {
    throw new Error(`App swap is not offered for ${name}`)
  }
  return join(context?.applicationsRoot ?? APPLICATIONS_ROOT, name)
}

/** payload はその job 自身の artifact でなければならない。他所の zip は置かせない。 */
function resolvePayload(context: AppSwapContext, input: string): string {
  if (!isAbsolute(input)) throw new Error('App swap payload path must be absolute')
  const path = resolve(input)
  let physical: string
  try { physical = realpathSync(path) } catch { throw new Error('App swap payload does not exist') }
  if (!contained(realpathSync(context.artifactDir), physical)) {
    throw new Error('App swap payload must be an artifact of this job')
  }
  const stats = lstatSync(physical)
  if (!stats.isFile()) throw new Error('App swap payload must be a regular file')
  if (stats.size <= 0 || stats.size > MAX_PAYLOAD_BYTES) throw new Error('App swap payload size is out of range')
  if (!physical.endsWith('.zip')) throw new Error('App swap payload must be a .zip archive')
  return physical
}

function backupPath(context: AppSwapContext, name: string): string {
  return join(context.backupRoot, name)
}

function bundleVersion(bundle: string): string | null {
  try {
    const plist = join(bundle, 'Contents', 'Info.plist')
    if (!existsSync(plist)) return null
    const proc = Bun.spawnSync(['/usr/bin/defaults', 'read', plist, 'CFBundleShortVersionString'], {
      stdout: 'pipe', stderr: 'pipe',
    })
    const value = new TextDecoder().decode(proc.stdout).trim()
    return value || null
  } catch { return null }
}

function describeInstalled(name: string, context: AppSwapContext): Record<string, unknown> {
  const path = managedAppPath(name, context)
  if (!existsSync(path)) return { app: name, installed: false }
  return {
    app: name,
    installed: true,
    version: bundleVersion(path),
    modifiedAt: new Date(statSync(path).mtimeMs).toISOString(),
  }
}

export function appSwapStatus(context: AppSwapContext): Record<string, unknown> {
  return {
    complete: true,
    applications: MANAGED_APPS.map(name => {
      const backup = backupPath(context, name)
      const held = existsSync(backup) || existsSync(transactionPath(context, name))
      return {
        ...describeInstalled(name, context),
        // 退避があるということは、いま入っているのは検証版。戻す責任が残っている。
        verificationBuildStaged: held,
        ...(held ? { backupVersion: bundleVersion(backup) } : {}),
      }
    }),
  }
}

// Validate names and link targets before ditto can create anything. Framework
// symlinks inside the bundle are normal; escaping links and zip-slip are not.
export const VALIDATE_APP_ARCHIVE = String.raw`
import stat, sys, unicodedata, zipfile
from collections import deque
def key(name):
    return unicodedata.normalize('NFD', name).casefold()
archive, app = sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    entries = z.infolist()
    if len(entries) > 200000 or sum(x.file_size for x in entries) > 8 * 1024**3:
        raise ValueError('archive expansion exceeds limit')
    links = {}
    names = set()
    for entry in entries:
        name = entry.filename.rstrip('/')
        if not name or name.startswith('/') or '\\' in name or any(x in ('', '.', '..') for x in name.split('/')):
            raise ValueError('unsafe archive path')
        metadata = name == '__MACOSX' or name == '__MACOSX/' + app or name.startswith('__MACOSX/' + app + '/')
        if name != app and not name.startswith(app + '/') and not metadata:
            raise ValueError('archive contains another root')
        canonical = key(name)
        if canonical in names:
            raise ValueError('duplicate archive path')
        names.add(canonical)
        kind = stat.S_IFMT(entry.external_attr >> 16)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
            raise ValueError('unsupported archive node')
        if kind == stat.S_IFLNK:
            if metadata: raise ValueError('metadata link')
            if entry.file_size > 4096: raise ValueError('oversized link')
            target = z.read(entry).decode('utf-8')
            if not target or target.startswith('/') or chr(92) in target or chr(0) in target:
                raise ValueError('escaping archive link')
            links[canonical] = key(target)
    for name in names:
        parts = name.split('/')
        if any('/'.join(parts[:i]) in links for i in range(1, len(parts))):
            raise ValueError('archive writes through a link')
    # Resolve links in kernel order: expand symlinks before a following '..'.
    for name, target in links.items():
        resolved = name.split('/')[:-1]
        pending = deque(target.split('/'))
        followed = 0
        while pending:
            part = pending.popleft()
            if part in ('', '.'):
                continue
            if part == '..':
                if len(resolved) <= 1: raise ValueError('escaping archive link')
                resolved.pop()
                continue
            candidate = '/'.join(resolved + [part])
            if candidate in links:
                followed += 1
                if followed > 40: raise ValueError('cyclic or excessive archive links')
                pending.extendleft(reversed(links[candidate].split('/')))
            else:
                resolved.append(part)
        if not resolved or resolved[0] != key(app):
            raise ValueError('escaping archive link')
`

function snapshotPayload(source: string, destination: string): void {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let output: number | undefined
  try {
    const before = fstatSync(input)
    if (!before.isFile() || before.size <= 0 || before.size > MAX_PAYLOAD_BYTES) throw new Error('App swap payload size is out of range')
    output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    const buffer = Buffer.alloc(1024 * 1024)
    let total = 0
    while (true) {
      const count = readSync(input, buffer)
      if (!count) break
      total += count
      if (total > MAX_PAYLOAD_BYTES) throw new Error('App swap payload grew past its limit')
      let offset = 0
      while (offset < count) offset += writeSync(output, buffer, offset, count - offset)
    }
    const after = fstatSync(input)
    if (total !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('App swap payload changed while copying')
  } finally { closeSync(input); if (output !== undefined) closeSync(output) }
}

type BundleIdentity = { dev: number; ino: number; birthtimeMs: number }
type SwapTransaction = { version: 1; original: BundleIdentity | null; verification: BundleIdentity; staging: string }

function bundleIdentity(path: string): BundleIdentity | null {
  try {
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('App swap target must be a physical bundle directory')
    return { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function sameBundle(left: BundleIdentity | null, right: BundleIdentity | null): boolean {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs
}
function transactionPath(context: AppSwapContext, name: string): string {
  return join(context.backupRoot, `${name}.transaction.json`)
}
function readTransaction(context: AppSwapContext, name: string): SwapTransaction | null {
  const text = readOptionalPrivateFile(transactionPath(context, name))
  if (text === null) return null
  const value = JSON.parse(text) as SwapTransaction
  const identity = (x: BundleIdentity | null) => x && [x.dev, x.ino, x.birthtimeMs].every(Number.isFinite)
  if (value.version !== 1 || !identity(value.verification) || (value.original !== null && !identity(value.original))
    || typeof value.staging !== 'string' || basename(value.staging) !== value.staging || !value.staging.startsWith('.staging-')) {
    throw new Error('App swap transaction is invalid; the original application was retained')
  }
  return value
}
async function withSwapLock<T>(context: AppSwapContext, name: string, operation: () => Promise<T>): Promise<T> {
  managedAppPath(name, context)
  const lock = join(context.backupRoot, `${name}.lock`)
  const attempt = tryAcquireProcessLock(lock)
  if (!attempt.acquired) throw new Error('App swap is already in progress; retry after that operation finishes')
  try { return await operation() } finally { releaseProcessLock(lock, attempt.lease) }
}

// Journal precedes every target mutation. rename keeps directory identity, so
// recovery can distinguish our verification bundle from a user's replacement.
async function restoreTransaction(context: AppSwapContext, commands: AppSwapCommands, name: string,
  transaction: SwapTransaction, signal?: AbortSignal): Promise<void> {
  const target = managedAppPath(name, context)
  const backup = backupPath(context, name)
  const staging = join(context.backupRoot, transaction.staging)
  const discard = join(staging, 'discarded.app')
  const current = bundleIdentity(target)
  const held = bundleIdentity(backup)
  if (current && !sameBundle(current, transaction.verification) && !sameBundle(current, transaction.original)) {
    throw new Error('App swap found a different installed application; it and the original backup were retained')
  }
  if (held && !sameBundle(held, transaction.original)) throw new Error('App swap backup changed; retained without modifying it')
  if (transaction.original && !sameBundle(current, transaction.original) && !sameBundle(held, transaction.original)) {
    throw new Error('App swap original backup is unavailable; verification build retained')
  }
  await quitRunningApp(commands, name, signal)
  const unchanged = (before: BundleIdentity | null, after: BundleIdentity | null) => before === null ? after === null : sameBundle(before, after)
  if (!unchanged(current, bundleIdentity(target)) || !unchanged(held, bundleIdentity(backup))) {
    throw new Error('App swap application changed while stopping; retained without modifying it')
  }
  // Recovery writes are synchronous and do not inherit cancellation from a
  // failed install. A crash at either rename can be reconciled by this journal.
  if (sameBundle(current, transaction.verification)) {
    if (existsSync(discard)) throw new Error('App swap recovery destination is occupied')
    renameSync(target, discard)
  }
  if (held && !sameBundle(current, transaction.original)) renameSync(backup, target)
  rmSync(staging, { recursive: true, force: true })
  rmSync(transactionPath(context, name))
}

export async function installVerificationBuild(
  context: AppSwapContext, commands: AppSwapCommands,
  input: { app: string; payload: string; sha256: string }, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return withSwapLock(context, input.app, async () => {
    const name = input.app
    const target = managedAppPath(name, context)
    const backup = backupPath(context, name)
    if (readTransaction(context, name) || existsSync(backup)) {
      throw new Error(`A verification build of ${name} is already staged; restore it before installing another`)
    }
    if (!SHA256.test(input.sha256)) throw new Error('App swap requires a sha256 of the payload')
    const payload = resolvePayload(context, input.payload)
    const staging = mkdtempSync(join(context.backupRoot, '.staging-'))
    let journaled = false
    try {
      const snapshot = join(staging, 'payload.zip')
      snapshotPayload(payload, snapshot)
      if (await commands.sha256(snapshot) !== input.sha256) throw new Error('App swap payload does not match the declared sha256')
      const validated = await commands.run(['/usr/bin/python3', '-I', '-c', VALIDATE_APP_ARCHIVE, snapshot, name], signal)
      if (validated.exitCode !== 0) throw new Error('App swap payload contains unsafe archive entries')
      const extracted = join(staging, 'extracted')
      mkdirSync(extracted, { mode: 0o700 })
      const expanded = await commands.run(['/usr/bin/ditto', '-x', '-k', snapshot, extracted], signal)
      if (expanded.exitCode !== 0) throw new Error('App swap payload could not be expanded')
      // ditto may consume or retain AppleDouble metadata from macOS archives.
      const entries = readdirSync(extracted).filter(entry => entry !== '__MACOSX')
      if (entries.length !== 1 || entries[0] !== name) throw new Error(`App swap payload must contain exactly one ${name} at its root`)
      const staged = join(extracted, name)
      const verification = bundleIdentity(staged)
      if (!verification || !existsSync(join(staged, 'Contents', 'Info.plist'))) throw new Error('App swap payload is not an application bundle')
      await quitRunningApp(commands, name, signal)
      const stableIdentity = await signForStableIdentity(commands, staged, signal)
      const transaction: SwapTransaction = { version: 1, original: bundleIdentity(target), verification, staging: basename(staging) }
      atomicWritePrivateFile(transactionPath(context, name), JSON.stringify(transaction))
      journaled = true
      try {
        if (transaction.original) renameSync(target, backup)
        renameSync(staged, target)
      } catch {
        try { await restoreTransaction(context, commands, name, transaction) } catch {
          throw new Error('App swap could not place the verification build; recovery is pending, original backup retained. Use app_swap_restore')
        }
        throw new Error('App swap could not place the verification build; previous state restored')
      }
      const launchServicesRefreshed = await refreshLaunchServices(commands, target, signal)
      const launched = await launchInstalledApp(commands, target, signal)
      return { complete: true, app: name, installed: describeInstalled(name, context), launchServicesRefreshed, launched,
        previousHeld: existsSync(backup), restoreWith: 'app_swap_restore', stableIdentity,
        ...(stableIdentity ? {} : { permissionNote: 'This build is ad-hoc signed, so screen recording and similar permissions must be granted again for it. Say so when you report a permission prompt.' }) }
    } finally {
      if (!journaled) rmSync(staging, { recursive: true, force: true })
    }
  })
}

export async function restoreInstalledBuild(
  context: AppSwapContext, commands: AppSwapCommands, input: { app: string }, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return withSwapLock(context, input.app, async () => {
    const name = input.app
    const transaction = readTransaction(context, name)
    if (!transaction) {
      if (existsSync(backupPath(context, name))) throw new Error('App swap legacy backup retained; cannot identify the installed verification build')
      return { complete: true, app: name, restored: false, reason: 'no verification build is staged' }
    }
    await restoreTransaction(context, commands, name, transaction, signal)
    const target = managedAppPath(name, context)
    const launchServicesRefreshed = existsSync(target) ? await refreshLaunchServices(commands, target, signal) : false
    return { complete: true, app: name, restored: true, installed: describeInstalled(name, context), launchServicesRefreshed }
  })
}

function toolText(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  }
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return toolText({ complete: false, reason: message.startsWith('App swap') ? message : 'App swap operation failed' }, true)
}

export function registerAppSwapTools(
  server: McpServer,
  context: AppSwapContext,
  commands: AppSwapCommands,
): void {
  server.registerTool('app_swap_status', {
    description: `Report which of ${MANAGED_APPS.join(', ')} is installed in ${APPLICATIONS_ROOT} and whether a verification build is currently staged in place of the operator's own copy.`,
    inputSchema: {},
  }, async () => {
    try { return toolText(appSwapStatus(context)) } catch (error) { return failure(error) }
  })

  server.registerTool('app_swap_install', {
    description: `Put a verification build into ${APPLICATIONS_ROOT} in place of the operator's own copy, setting that copy aside first. The payload must be a .zip this job produced as an artifact, containing exactly one application bundle, and its sha256 must match. Restore with app_swap_restore when the verification is finished; the operator's copy stays on disk until then.`,
    inputSchema: {
      app: z.enum(MANAGED_APPS),
      payload: z.string().min(1).max(4096),
      sha256: z.string().length(64),
    },
  }, async (input, extra) => {
    try { return toolText(await installVerificationBuild(context, commands, input, extra.signal)) }
    catch (error) { return failure(error) }
  })

  server.registerTool('app_swap_restore', {
    description: `Put the operator's own copy of the application back and discard the verification build. Safe to call when nothing is staged.`,
    inputSchema: { app: z.enum(MANAGED_APPS) },
  }, async (input, extra) => {
    try { return toolText(await restoreInstalledBuild(context, commands, input, extra.signal)) }
    catch (error) { return failure(error) }
  })
}

export function createHostAppSwapCommands(): AppSwapCommands {
  return {
    run: async (argv, signal) => {
      const result = await runBoundedHostCommand(argv, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        undefined, signal, COMMAND_TIMEOUT_MS)
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    },
    sha256: async path => {
      const proc = Bun.spawnSync(['/usr/bin/shasum', '-a', '256', path], { stdout: 'pipe', stderr: 'pipe' })
      if (proc.exitCode !== 0) throw new Error('App swap could not read the payload')
      return new TextDecoder().decode(proc.stdout).trim().split(/\s+/)[0] ?? ''
    },
  }
}

async function main(): Promise<void> {
  const [contextPath, stateInput, artifactInput] = process.argv.slice(2)
  if (!contextPath || !stateInput || !artifactInput || process.argv.length !== 5) {
    throw new Error('Invalid app swap broker invocation')
  }
  const context = parseGitHubBrokerContext(contextPath, stateInput)
  if (!context.writeEnabled) throw new Error('App swap broker requires an authorized job')
  const stateDir = requireManagedStateRoot(stateInput)
  const artifactDir = realpathSync(artifactInput)
  if (!contained(stateDir, artifactDir)) throw new Error('App swap artifact directory is outside managed state')
  // /Applications is shared by all project states on this host.
  const hostState = prepareManagedStateRoot(join(homedir(), '.zerokun'))
  const backupRoot = ensureManagedDirectory(hostState, join(hostState, 'app-swap'))
  const server = new McpServer({ name: 'zerochan-app-swap', version: '1.0.0' })
  registerAppSwapTools(server, { jobId: context.jobId, artifactDir, backupRoot }, createHostAppSwapCommands())
  await server.connect(new StdioServerTransport())
}

if (import.meta.main) main().catch(error => {
  process.stderr.write(`Zeroちゃん app swap broker: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
