#!/usr/bin/env -S bun --config=/dev/null --no-env-file

// 実機検証には、検証用ビルドを「アプリケーション」へ置く必要がある。しかし
// そこへの書き込みを job へ直接許すと、Chrome でも Slack でも差し替えられて
// しまう。窓口を通し、対象アプリ・置ける中身・戻せることの3つを固定する。
//
//   ・対象は MANAGED_APPS の名前だけ
//   ・置けるのは、その job 自身が artifact として出した zip だけ(SHA 照合つき)
//   ・既存アプリは消さず退避し、いつでも戻せる。戻すまで次は置けない

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'fs'
import { basename, isAbsolute, join, resolve, sep } from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { parseGitHubBrokerContext } from './github-credential-broker.ts'
import { runBoundedHostCommand } from './github-publication.ts'
import { requireManagedStateRoot } from './managed-path.ts'

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
const SHA256 = /^[0-9a-f]{64}$/
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000

export type AppSwapCommands = {
  run: (argv: readonly string[], signal?: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  sha256: (path: string) => Promise<string>
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
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function managedAppPath(name: string): string {
  if (!MANAGED_APPS.includes(name as (typeof MANAGED_APPS)[number])) {
    throw new Error(`App swap is not offered for ${name}`)
  }
  return join(APPLICATIONS_ROOT, name)
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

function describeInstalled(name: string): Record<string, unknown> {
  const path = managedAppPath(name)
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
      const held = existsSync(backup)
      return {
        ...describeInstalled(name),
        // 退避があるということは、いま入っているのは検証版。戻す責任が残っている。
        verificationBuildStaged: held,
        ...(held ? { backupVersion: bundleVersion(backup) } : {}),
      }
    }),
  }
}

export async function installVerificationBuild(
  context: AppSwapContext,
  commands: AppSwapCommands,
  input: { app: string; payload: string; sha256: string },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const name = input.app
  const target = managedAppPath(name)
  const backup = backupPath(context, name)
  if (existsSync(backup)) {
    throw new Error(`A verification build of ${name} is already staged; restore it before installing another`)
  }
  if (!SHA256.test(input.sha256)) throw new Error('App swap requires a sha256 of the payload')
  const payload = resolvePayload(context, input.payload)
  const actual = await commands.sha256(payload)
  if (actual !== input.sha256) throw new Error('App swap payload does not match the declared sha256')

  const staging = join(context.backupRoot, `.staging-${name}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  // ditto は .app の属性と署名を保ったまま展開する。unzip では壊れる。
  const expanded = await commands.run(['/usr/bin/ditto', '-x', '-k', payload, staging], signal)
  if (expanded.exitCode !== 0) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error('App swap payload could not be expanded')
  }
  const bundles = readdirSync(staging).filter(entry => entry === name)
  if (bundles.length !== 1) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`App swap payload must contain exactly one ${name} at its root`)
  }
  const staged = join(staging, name)
  if (!lstatSync(staged).isDirectory() || !existsSync(join(staged, 'Contents', 'Info.plist'))) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error('App swap payload is not an application bundle')
  }

  // 置く前に署名する。置いた後だと、許可の無い状態のアプリが一瞬でも
  // 「アプリケーション」に居ることになる。
  const stableIdentity = await signForStableIdentity(commands, staged, signal)

  // 既存は消さずに退避する。ここで失敗したら何も置かない。
  if (existsSync(target)) {
    const moved = await commands.run(['/bin/mv', target, backup], signal)
    if (moved.exitCode !== 0) {
      rmSync(staging, { recursive: true, force: true })
      throw new Error('App swap could not set the existing application aside')
    }
  }
  const placed = await commands.run(['/bin/mv', staged, target], signal)
  rmSync(staging, { recursive: true, force: true })
  if (placed.exitCode !== 0) {
    // 置けなかったら退避を戻し、元の状態へ確実に帰す。
    if (existsSync(backup)) await commands.run(['/bin/mv', backup, target], signal)
    throw new Error('App swap could not place the verification build')
  }
  return {
    complete: true,
    app: name,
    installed: describeInstalled(name),
    previousHeld: existsSync(backup),
    restoreWith: 'app_swap_restore',
    stableIdentity,
    ...(stableIdentity ? {} : {
      permissionNote: 'This build is ad-hoc signed, so screen recording and similar permissions must be granted again for it. Say so when you report a permission prompt.',
    }),
  }
}

export async function restoreInstalledBuild(
  context: AppSwapContext,
  commands: AppSwapCommands,
  input: { app: string },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const name = input.app
  const target = managedAppPath(name)
  const backup = backupPath(context, name)
  if (!existsSync(backup)) {
    return { complete: true, app: name, restored: false, reason: 'no verification build is staged' }
  }
  if (existsSync(target)) {
    const discarded = await commands.run(['/bin/rm', '-rf', target], signal)
    if (discarded.exitCode !== 0) throw new Error('App swap could not remove the verification build')
  }
  const moved = await commands.run(['/bin/mv', backup, target], signal)
  if (moved.exitCode !== 0) throw new Error('App swap could not restore the original application')
  return { complete: true, app: name, restored: true, installed: describeInstalled(name) }
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
  // 退避先は job ごとではなく1か所。job が変わっても、戻していない実機を見つけられる。
  const backupRoot = join(stateDir, 'app-swap')
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 })
  const server = new McpServer({ name: 'zerochan-app-swap', version: '1.0.0' })
  registerAppSwapTools(server, { jobId: context.jobId, artifactDir, backupRoot }, createHostAppSwapCommands())
  await server.connect(new StdioServerTransport())
}

if (import.meta.main) main().catch(error => {
  process.stderr.write(`Zeroちゃん app swap broker: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
