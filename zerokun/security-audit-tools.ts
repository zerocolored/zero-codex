import { createHash, randomUUID } from 'crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  cpSync,
  chmodSync,
  realpathSync,
} from 'fs'
import { join, dirname, basename, resolve, relative } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { installedGoChromeEntrypoint } from './installed-browser.ts'
import { resolveDockerRuntime } from './docker-runtime.ts'
import { ensureManagedDirectory } from './managed-path.ts'
import {
  CodexCleanupPendingError,
  CodexUserCancelledError,
  CodexInterruptedError,
} from './codex-executor.ts'
import {
  atomicWritePrivateFile,
  readOptionalBoundedOwnerOnlyRegularFile,
} from './safe-file.ts'
import {
  auditClean,
  auditCodeReview,
  renderAuditReport,
  type AuditJournal,
  type AuditSettings,
  type AuditStep,
  type AuditFinding,
} from './security-audit.ts'
import { runIsolatedCodexJson } from './slack-thread-intent.ts'

export type AuditToolContext = {
  root: string
  source: string
  repo: string
  stateDir: string
  jobId: string
  settings: AuditSettings
  signal?: AbortSignal
  cancelled?: () => boolean
  progress?: (s: string) => void
  onProcessId?: (pid: number) => void
  onProcessExit?: (code: number) => void
  dockerHost?: string
  /** Host-created fixture only, never read from project configuration. */
  semgrepProbe?: boolean
  socketReceiptPath?: string
}
export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  truncated: boolean
}
const OUTPUT_LIMIT = 12_000_000
const toolsRoot = (c: AuditToolContext) =>
  join(c.stateDir, 'security-audit-tools')
function environment(c: AuditToolContext, extra: Record<string, string> = {}) {
  const home = join(c.root, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/opt/homebrew/bin',
    HOME: home,
    TMPDIR: c.root,
    LANG: 'en_US.UTF-8',
    CI: 'true',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    NO_COLOR: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    ...(existsSync('/etc/ssl/cert.pem')
      ? {
          SSL_CERT_FILE: '/etc/ssl/cert.pem',
          REQUESTS_CA_BUNDLE: '/etc/ssl/cert.pem',
        }
      : {}),
    ...extra,
  }
}
export function checkAuditInterrupted(c: {
  signal?: AbortSignal
  cancelled?: () => boolean
}): void {
  if (c.cancelled?.()) throw new CodexUserCancelledError()
  if (c.signal?.aborted)
    throw new CodexInterruptedError('audit worker interrupted')
}
/** Every subprocess has bounded output/time, a separate process group, and a persisted executor PID. */
export async function auditCommand(
  args: string[],
  cwd: string,
  c: AuditToolContext,
  options: {
    timeoutMs?: number
    env?: Record<string, string>
    sandbox?: boolean
    input?: string
    localPort?: number
    offline?: boolean
  } = {},
): Promise<CommandResult> {
  checkAuditInterrupted(c)
  let dockerEnvironment: Record<string, string> = {}
  if (basename(args[0]!) === 'docker') {
    const host = c.dockerHost ?? resolveDockerRuntime()?.host
    if (!host) throw Error('Selected local Docker engine is unavailable')
    dockerEnvironment = { DOCKER_HOST: host }
  }
  const runtime = realpathSync(mkdtempSync('/tmp/za-'))
  chmodSync(runtime, 0o700)
  let argv = args
  if (options.sandbox) {
    mkdirSync(toolsRoot(c), { recursive: true, mode: 0o700 })
    if (process.platform === 'darwin') {
      const quote = (s: string) =>
        JSON.stringify(existsSync(s) ? realpathSync(s) : s)
      const profile = join(runtime, 'scanner.sb')
      // The tools may read installed runtimes, but not the user's home or real checkout.
      const executable = Bun.which(args[0]!) ?? args[0]!
      const physical = existsSync(executable)
        ? realpathSync(executable)
        : executable
      const ancestors = new Set<string>()
      // Java's NOFOLLOW_LINKS realpath calls readlink on parent directories.
      // macOS requires read-data for that operation even for a non-symlink.
      // Exact directory literals permit traversal/listing, never child contents.
      for (const allowed of [
        c.source,
        c.root,
        toolsRoot(c),
        dirname(physical),
      ]) {
        let parent = dirname(allowed)
        while (parent !== dirname(parent)) {
          ancestors.add(parent)
          parent = dirname(parent)
        }
      }
      writeFileSync(
        profile,
        `(version 1) (allow default)
        (deny file-write*)
        (allow file-write* (subpath ${quote(runtime)}) (subpath ${quote(c.root)}) (literal "/dev/null"))
        (deny file-read* (subpath ${quote(homedir())}) (subpath ${quote(c.stateDir)}) (subpath ${quote(c.repo)}))
        (allow file-read* (subpath ${quote(c.source)}) (subpath ${quote(c.root)}) (subpath ${quote(toolsRoot(c))}) (subpath ${quote(dirname(physical))}))
        (allow file-read-metadata file-read-data ${[...ancestors].map((p) => `(literal ${quote(p)})`).join(' ')})
        ${options.offline ? `(deny network-outbound) ${options.localPort ? `(allow network-outbound (remote tcp "localhost:${options.localPort}"))` : ''}` : ''}`,
        { mode: 0o600 },
      )
      argv = ['/usr/bin/sandbox-exec', '-f', profile, ...args]
    } else {
      const bwrap = Bun.which('bwrap')
      if (!bwrap)
        throw Error('scanner isolation requires bubblewrap on this host')
      argv = [
        bwrap,
        '--die-with-parent',
        '--ro-bind',
        '/',
        '/',
        '--tmpfs',
        homedir(),
        '--tmpfs',
        c.repo,
        '--tmpfs',
        c.stateDir,
        '--bind',
        runtime,
        runtime,
        '--bind',
        c.root,
        c.root,
        '--ro-bind',
        toolsRoot(c),
        toolsRoot(c),
        ...(options.offline ? ['--unshare-net'] : []),
        '--ro-bind',
        c.source,
        c.source,
        '--chdir',
        cwd,
        ...args,
      ]
    }
  }
  const registration = join(
    ensureManagedDirectory(c.stateDir, join(c.stateDir, 'executors')),
    `${c.jobId}.json`,
  )
  const proc = Bun.spawn(
    [
      process.execPath,
      '--config=/dev/null',
      '--no-env-file',
      join(import.meta.dir, 'security-audit-supervisor.ts'),
      c.jobId,
      registration,
      ...argv,
    ],
    {
      cwd,
      env: environment(c, {
        TMPDIR: runtime,
        MAC_CHROMIUM_TMPDIR: runtime,
        // JVM user.home is derived from the OS account, not HOME. Keep CodeQL's
        // pack/cache lookup inside the same scratch home as every other tool.
        JAVA_TOOL_OPTIONS: `-Djava.io.tmpdir=${runtime} -Duser.home=${JSON.stringify(join(c.root, 'home'))}`,
        ...dockerEnvironment,
        ...options.env,
      }),
      stdin: options.input === undefined ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    },
  )
  let registered = false,
    truncated = false,
    timedOut = false,
    stopping = false
  const stop = () => {
    if (proc.exitCode !== null || stopping) return
    stopping = true
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {}
    // The supervisor retains the group and generation ledger while reaping descendants.
  }
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(),
      parts: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > OUTPUT_LIMIT) {
          truncated = true
          stop()
        } else parts.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(parts).toString('utf8')
  }
  const timer = setTimeout(
    () => {
      timedOut = true
      stop()
    },
    options.timeoutMs ?? 30 * 60_000,
  )
  const poll = setInterval(() => {
    if (c.cancelled?.()) stop()
  }, 1000)
  c.signal?.addEventListener('abort', stop, { once: true })
  try {
    c.onProcessId?.(proc.pid)
    registered = true
    if (options.input !== undefined) {
      ;(proc.stdin as import('bun').FileSink).write(options.input)
      ;(proc.stdin as import('bun').FileSink).end()
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      read(proc.stdout),
      read(proc.stderr),
      proc.exited,
    ])
    if (exitCode === 86)
      throw new CodexCleanupPendingError(
        'scanner supervision/cleanup is pending',
      )
    checkAuditInterrupted(c)
    return {
      stdout,
      stderr: timedOut ? 'command timeout' : stderr,
      exitCode: timedOut ? 124 : exitCode,
      truncated,
    }
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
    c.signal?.removeEventListener('abort', stop)
    if (proc.exitCode === null) {
      stop()
      await proc.exited
    }
    if (proc.exitCode !== 86) rmSync(runtime, { recursive: true, force: true })
    if (registered) c.onProcessExit?.(proc.exitCode ?? 1)
  }
}
async function checked(
  args: string[],
  cwd: string,
  c: AuditToolContext,
  options: Parameters<typeof auditCommand>[3] = {},
): Promise<CommandResult> {
  const r = await auditCommand(args, cwd, c, options)
  if (r.exitCode !== 0 || r.truncated)
    throw Error(
      `${basename(args[0]!)} failed (${r.exitCode}${r.truncated ? ', output limit' : ''}): ${auditClean(r.stderr).slice(0, 1200)}`,
    )
  return r
}
async function pnpmBinary(c: AuditToolContext): Promise<string> {
  const manifest = join(c.source, 'package.json')
  const declared = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).packageManager : undefined
  const version = typeof declared === 'string'
    ? /^pnpm@(\d+\.\d+\.\d+)(?:\+sha\d+\.[a-f0-9]+)?$/.exec(declared)?.[1]
    : undefined
  if (declared && String(declared).startsWith('pnpm@') && !version)
    throw Error('pnpm packageManager must specify a release version')
  const install = join(toolsRoot(c), `pnpm-${version ?? '10'}`)
  const exe = join(install, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  if (!existsSync(exe))
    await checked(['npm', 'install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', `pnpm@${version ?? '10'}`], c.root, c)
  return exe
}
async function releaseAsset(
  repo: string,
  tag: string,
  pattern: RegExp,
  c: AuditToolContext,
): Promise<string> {
  const headers = {
    'User-Agent': 'zerochan-security-audit',
    Accept: 'application/vnd.github+json',
  }
  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases/${tag === 'latest' ? 'latest' : `tags/${tag}`}`,
    { headers, signal: AbortSignal.timeout(30000) },
  )
  if (!response.ok)
    throw Error(`official release lookup failed (${response.status})`)
  const release = (await response.json()) as {
    assets: Array<{
      name: string
      browser_download_url: string
      digest?: string
      size: number
    }>
  }
  const asset = release.assets.find((a) => pattern.test(a.name))
  if (!asset || asset.size > 2_000_000_000)
    throw Error('compatible official release asset unavailable')
  const dir = toolsRoot(c)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, asset.name)
  const url = new URL(asset.browser_download_url)
  if (
    url.origin !== 'https://github.com' ||
    !url.pathname.startsWith(`/${repo}/releases/download/`)
  )
    throw Error('unexpected release origin')
  let expected = asset.digest?.replace(/^sha256:/, '')
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    const checksum = release.assets.find((a) => /checksums?\.txt$/.test(a.name))
    if (!checksum) throw Error('release checksum unavailable')
    const checkUrl = new URL(checksum.browser_download_url)
    if (
      checkUrl.origin !== 'https://github.com' ||
      !checkUrl.pathname.startsWith(`/${repo}/releases/download/`)
    )
      throw Error('unexpected checksum origin')
    const cr = await fetch(checkUrl, { signal: AbortSignal.timeout(30000) })
    if (!cr.ok) throw Error('checksum download failed')
    expected = (await cr.text())
      .split('\n')
      .find((line) => line.trim().endsWith(asset.name))
      ?.split(/\s+/)[0]
  }
  if (!expected || !/^[a-f0-9]{64}$/.test(expected))
    throw Error('release checksum invalid')
  if (
    existsSync(path) &&
    createHash('sha256').update(readFileSync(path)).digest('hex') === expected
  )
    return path
  const body = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!body.ok || !body.body) throw Error('release download failed')
  const sink = Bun.file(`${path}.partial`).writer()
  let size = 0
  const digest = createHash('sha256')
  try {
    for await (const bytes of body.body) {
      size += bytes.length
      if (size > 2_000_000_000) throw Error('release size exceeded')
      digest.update(bytes)
      sink.write(bytes)
    }
    await sink.end()
    if (digest.digest('hex') !== expected)
      throw Error('release checksum mismatch')
    await Bun.write(path, Bun.file(`${path}.partial`))
    chmodSync(path, 0o600)
    return path
  } finally {
    try {
      await sink.end()
    } catch {}
    rmSync(`${path}.partial`, { force: true })
  }
}
async function binary(
  name: 'semgrep' | 'trivy' | 'gitleaks',
  c: AuditToolContext,
): Promise<string> {
  const root = toolsRoot(c)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const installed = Bun.which(name, { PATH: process.env.PATH })
  if (installed && name !== 'trivy' && name !== 'semgrep') return installed
  if (name === 'semgrep') {
    const python = join(root, 'semgrep', 'bin', 'python'),
      exe = join(root, 'semgrep', 'bin', 'semgrep')
    if (!existsSync(exe)) {
      await checked(['python3', '-m', 'venv', join(root, 'semgrep')], root, c)
      await checked(
        [
          python,
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          'semgrep',
        ],
        root,
        c,
      )
    }
    return exe
  }
  const os =
    process.platform === 'darwin'
      ? name === 'trivy'
        ? 'macOS'
        : 'darwin'
      : 'Linux'
  const arch = process.arch === 'arm64' ? 'ARM64' : '64bit'
  const exe = join(
    root,
    name === 'trivy' ? 'trivy-0.69.3' : 'gitleaks',
    '' + name,
  )
  if (existsSync(exe)) return exe
  const pattern =
    name === 'trivy'
      ? new RegExp(`^trivy_0\\.69\\.3_${os}-${arch}\\.tar\\.gz$`)
      : new RegExp(
          `^gitleaks_.*_${process.platform === 'darwin' ? 'darwin' : 'linux'}_${process.arch === 'arm64' ? 'arm64' : 'x64'}\\.tar\\.gz$`,
        )
  const archive = await releaseAsset(
    name === 'trivy' ? 'aquasecurity/trivy' : 'gitleaks/gitleaks',
    name === 'trivy' ? 'v0.69.3' : 'latest',
    pattern,
    c,
  )
  mkdirSync(dirname(exe), { recursive: true, mode: 0o700 })
  await checked(['tar', '-xzf', archive, '-C', dirname(exe), name], root, c)
  return exe
}
function value(o: unknown, key: string): string {
  return o &&
    typeof o === 'object' &&
    typeof (o as Record<string, unknown>)[key] === 'string'
    ? (o as Record<string, string>)[key]!
    : ''
}
const severity = (input: string = 'info'): AuditFinding['severity'] => {
  const lower = String(input).toLowerCase()
  const v =
    (
      {
        moderate: 'medium',
        error: 'high',
        warning: 'medium',
        note: 'info',
      } as Record<string, string>
    )[lower] ?? lower
  return ['critical', 'high', 'medium', 'low', 'info'].includes(v.toLowerCase())
    ? (v.toLowerCase() as AuditFinding['severity'])
    : 'info'
}
const finding = (
  title: string,
  location: string,
  evidence: string,
  recommendation: string,
  level = 'info',
): AuditFinding => ({
  title: auditClean(String(title)).slice(0, 500),
  location: auditClean(String(location)).slice(0, 1000),
  evidence: auditClean(String(evidence)).slice(0, 6000),
  recommendation: auditClean(String(recommendation)).slice(0, 4000),
  severity: severity(level),
})
export function auditTargetAllows(target: string, candidate: string): boolean {
  try {
    const base = new URL(target),
      url = new URL(candidate),
      path = base.pathname.replace(/\/$/, '')
    return (
      base.origin === url.origin &&
      (url.pathname === path || url.pathname.startsWith(path + '/'))
    )
  } catch {
    return false
  }
}
export function zapScopeFiles(
  target: string,
  probe?: { url: string; pattern: string },
): {
  context: string
  hook: string
  script: string
} {
  const u = new URL(target),
    path = u.pathname.replace(/\/$/, '')
  const pattern =
    '^' +
    String.raw`(?![^?#]*(?:\x25|\x5c|/\x2e{1,2}(?:/|[?#]|$)))` +
    (u.origin + path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '(?:[/?].*)?$'
  const xml = (s: string) =>
    s.replace(
      /[<>&"']/g,
      (c) =>
        ({
          '<': '&lt;',
          '>': '&gt;',
          '&': '&amp;',
          '"': '&quot;',
          "'": '&apos;',
        })[c]!,
    )
  return {
    context: `<?xml version="1.0"?><configuration><context><name>audit</name><desc>Project-scoped audit</desc><inscope>true</inscope><incregexes>${xml(pattern)}</incregexes></context></configuration>`,
    hook:
      "def zap_started(zap, target):\n    zap.script.load('audit-auth', 'httpsender', 'ECMAScript : Graal.js', '/zap/wrk/auth.js')\n    zap.script.enable('audit-auth')\n" +
      (probe
        ? `    try:\n        zap.core.access_url(${JSON.stringify(probe.url)}, followredirects=False)\n    except Exception:\n        pass\n`
        : '') +
      // Packaged baseline scans rewrite /app to the origin root before calling
      // the spider. Keep the authorized path instead of widening the context.
      `\ndef zap_spider(zap, target):\n    return zap, ${JSON.stringify(target)}\n` +
      `\ndef zap_active_scan(zap, target, policy):\n    return zap, ${JSON.stringify(target)}, policy\n`,
    script: `function sendingRequest(msg,initiator,helper){
      var uri=msg.getRequestHeader().getURI(),port=uri.getPort();if(port<0)port=String(uri.getScheme())==='https'?443:80;
      var raw=String(uri.getEscapedPath());
      msg.getRequestHeader().setHeader('Cookie',null);
      if(raw.indexOf('%')>=0||raw.indexOf(String.fromCharCode(92))>=0||raw.split('/').some(function(part){return part==='.'||part==='..'}))return;
      var path=String(uri.getPath()),prefix=${JSON.stringify(path)};
      msg.getRequestHeader().setHeader('Cookie',null);
      if(String(uri.getScheme())===${JSON.stringify(u.protocol.slice(0, -1))}&&String(uri.getHost())===${JSON.stringify(u.hostname)}&&port===${Number(u.port) || (u.protocol === 'https:' ? 443 : 80)}&&(path===prefix||path.indexOf(prefix+'/')===0)){
        var cookie=Java.type('java.lang.System').getenv('ZERO_AUDIT_COOKIE');if(cookie)msg.getRequestHeader().setHeader('Cookie',cookie);
      }
    }\nfunction responseReceived(msg,initiator,helper){
      ${
        probe
          ? `var expected=Java.type('java.lang.System').getenv('ZERO_AUDIT_COOKIE');
      if(expected&&String(msg.getRequestHeader().getHeader('Cookie'))===String(expected)&&String(msg.getRequestHeader().getURI().getEscapedURI())===${JSON.stringify(probe.url)}&&msg.getResponseHeader().getStatusCode()>=200&&msg.getResponseHeader().getStatusCode()<300&&String(msg.getResponseBody()).indexOf(${JSON.stringify(probe.pattern)})>=0){
        Java.type('java.nio.file.Files').writeString(Java.type('java.nio.file.Paths').get('/zap/wrk/auth-confirmed'),'confirmed');
      }`
          : ''
      }
    }\n`,
  }
}
export async function cleanupAuditZap(c: AuditToolContext): Promise<void> {
  try {
    await cleanupAuditZapContainer(c)
  } catch (error) {
    if (error instanceof CodexCleanupPendingError) throw error
    // Connection/context resolution can fail before docker is spawned. This is
    // still unverified cleanup, never a settled scanner failure.
    throw new CodexCleanupPendingError('ZAP container cleanup could not be verified')
  }
}
async function cleanupAuditZapContainer(c: AuditToolContext): Promise<void> {
  const clean = { ...c, signal: undefined, cancelled: undefined }
  const inspected = await auditCommand(
    [
      'docker',
      'container',
      'inspect',
      `zero-audit-${c.jobId}`,
      '--format',
      '{{.Id}} {{index .Config.Labels "zerochan.audit.job"}}',
    ],
    c.root,
    clean,
    { timeoutMs: 30000 },
  )
  if (inspected.exitCode !== 0) {
    if (/No such (?:container|object)/i.test(inspected.stderr)) return
    throw new CodexCleanupPendingError(
      'ZAP container cleanup could not be verified',
    )
  }
  const [id, job] = inspected.stdout.trim().split(/\s+/)
  if (!id || !/^([a-f0-9]{64})$/.test(id) || job !== c.jobId)
    throw new CodexCleanupPendingError('ZAP container ownership mismatch')
  const removed = await auditCommand(
    ['docker', 'rm', '-f', id],
    c.root,
    clean,
    { timeoutMs: 30000 },
  )
  if (
    removed.exitCode !== 0 &&
    !/No such (?:container|object)/i.test(removed.stderr)
  )
    throw new CodexCleanupPendingError('ZAP container cleanup pending')
}
export function redactAuditCookies(text: string, cookies: Array<{ value: string }>): string {
  const values = [...new Set(cookies.map(cookie => cookie.value).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
  if (!values.length) return text
  // One pass avoids empty-string expansion and re-redacting replacement text.
  const pattern = values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return text.replace(new RegExp(pattern, 'g'), '[認証情報を除去]')
}
async function verifyAuthentication(
  c: AuditToolContext,
  cookies: Awaited<ReturnType<typeof chromeCookies>>,
): Promise<boolean> {
  if (
    !c.settings.targetUrl ||
    !c.settings.authenticatedPath ||
    !c.settings.loggedInPattern ||
    !cookies.length
  )
    return false
  const url = new URL(c.settings.authenticatedPath, c.settings.targetUrl)
  if (!auditTargetAllows(c.settings.targetUrl, url.href))
    throw Error('authentication probe is outside the authorized target')
  const response = await fetch(url, {
    headers: { Cookie: cookies.map((v) => `${v.name}=${v.value}`).join('; ') },
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    return false
  }
  const reader = response.body.getReader()
  let text = '',
    size = 0
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 200000) return false
      text += decoder.decode(value, { stream: true })
    }
    return text.includes(c.settings.loggedInPattern)
  } finally {
    await reader.cancel()
  }
}
function codeqlSeverity(run: any, result: any): string {
  const rules = run.tool?.driver?.rules ?? []
  const rule =
    rules.find((r: any) => r.id === result.ruleId) ?? rules[result.ruleIndex]
  const score = Number(rule?.properties?.['security-severity'])
  if (Number.isFinite(score) && score > 0)
    return score >= 9
      ? 'critical'
      : score >= 7
        ? 'high'
        : score >= 4
          ? 'medium'
          : 'low'
  return result.level ?? rule?.defaultConfiguration?.level ?? 'warning'
}
/** Decode only structural fields; scanner snippets, secret values and HTTP headers never enter a report. */
export function scannerFindings(tool: string, data: any): AuditFinding[] {
  const out: AuditFinding[] = []
  const valid =
    tool === 'semgrep'
      ? Array.isArray(data?.results)
      : tool === 'trivy'
        ? data?.SchemaVersion !== undefined
        : tool === 'gitleaks'
          ? Array.isArray(data)
          : tool === 'codeql'
            ? Array.isArray(data?.runs)
            : tool === 'pnpm'
              ? data?.advisories && typeof data.advisories === 'object' && !Array.isArray(data.advisories) &&
                data?.metadata?.vulnerabilities && typeof data.metadata.vulnerabilities === 'object'
            : tool === 'npm'
              ? data?.vulnerabilities &&
                typeof data.vulnerabilities === 'object'
              : tool === 'zap'
                ? Array.isArray(data?.site)
                : data && typeof data === 'object' && !Array.isArray(data)
  if (!valid) throw Error(`${tool} result schema invalid`)
  if (tool === 'semgrep')
    for (const r of data.results ?? [])
      out.push(
        finding(
          r.check_id,
          `${r.path}:${r.start?.line}`,
          'Rule matched; source snippets and interpolated messages withheld to protect secrets.',
          r.extra?.metadata?.references?.join('\n') ?? '',
          r.extra?.metadata?.impact ?? r.extra?.severity,
        ),
      )
  if (tool === 'trivy')
    for (const r of data.Results ?? []) {
      for (const v of r.Vulnerabilities ?? [])
        out.push(
          finding(
            `${v.VulnerabilityID} ${v.PkgName}`,
            r.Target,
            `Installed: ${v.InstalledVersion}`,
            `Fixed: ${v.FixedVersion ?? 'not available'}; ${v.PrimaryURL ?? ''}`,
            v.Severity,
          ),
        )
      for (const v of r.Misconfigurations ?? [])
        out.push(
          finding(
            v.Title ?? v.ID,
            r.Target,
            v.Message ?? '',
            v.Resolution ?? '',
            v.Severity,
          ),
        )
      for (const v of r.Licenses ?? [])
        out.push(
          finding(
            `License: ${v.Name ?? 'unknown'}`,
            r.Target,
            `Package: ${v.PkgName ?? ''}; category: ${v.Category ?? 'unclassified'}; confidence: ${v.Confidence ?? 'unknown'}`,
            '利用条件・配布方針への適合を確認してください。',
            v.Severity ?? 'info',
          ),
        )
      for (const v of r.Secrets ?? [])
        out.push(
          finding(
            v.Title ?? v.RuleID,
            `${r.Target}:${v.StartLine}`,
            'Secret detector matched; value withheld.',
            '失効・ローテーションと管理方法を確認してください。',
            v.Severity,
          ),
        )
    }
  if (tool === 'gitleaks')
    for (const r of Array.isArray(data) ? data : [])
      out.push(
        finding(
          r.Description ?? r.RuleID,
          `${r.File}:${r.StartLine}`,
          `Rule: ${r.RuleID}; commit: ${r.Commit ?? 'working tree'}`,
          '秘密値を確認・失効し、secret storeへ移してください。',
          'high',
        ),
      )
  if (tool === 'codeql')
    for (const run of data.runs ?? [])
      for (const r of run.results ?? [])
        out.push(
          finding(
            r.ruleId ?? 'CodeQL',
            `${r.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? ''}:${r.locations?.[0]?.physicalLocation?.region?.startLine ?? ''}`,
            r.message?.text ?? '',
            'CodeQL rule documentationを参照してください。',
            codeqlSeverity(run, r),
          ),
        )
  if (tool === 'bun audit')
    for (const [name, items] of Object.entries(data)) {
      if (!Array.isArray(items)) throw Error('Bun audit schema invalid')
      for (const r of items)
        out.push(
          finding(
            r.title ?? name,
            name,
            `Affected: ${r.vulnerable_versions}`,
            r.url ?? '',
            r.severity,
          ),
        )
    }
  if (tool === 'socket') {
    if (
      data.ok !== true ||
      typeof data.data?.healthy !== 'boolean' ||
      !data.data.alerts ||
      typeof data.data.alerts !== 'object'
    )
      throw Error('Socket final report schema invalid')
    const report = data.data
    const visit = (node: any, keys: string[]) => {
      if (
        node &&
        typeof node === 'object' &&
        typeof node.type === 'string' &&
        typeof node.policy === 'string'
      ) {
        out.push(
          finding(
            node.type,
            keys.slice(0, -1).join(' / '),
            `Policy: ${node.policy}; manifests: ${JSON.stringify(node.manifest ?? [])}`,
            String(node.url ?? 'Socket policy/reportを参照してください。'),
            node.policy === 'error'
              ? 'high'
              : node.policy === 'warn'
                ? 'medium'
                : 'info',
          ),
        )
        return
      }
      if (!node || typeof node !== 'object')
        throw Error('Socket alert schema invalid')
      for (const [key, value] of Object.entries(node))
        visit(value, [...keys, key])
    }
    visit(report.alerts, [])
    if (!report.healthy && !out.length)
      throw Error('Socket unhealthy report has no decoded alerts')
  }
  if (tool === 'npm')
    for (const [name, r] of Object.entries(data.vulnerabilities ?? {}) as Array<
      [string, any]
    >)
      out.push(
        finding(
          name,
          (r.nodes ?? []).join(', '),
          `Affected: ${r.range}; direct: ${r.isDirect}`,
          `Fix available: ${JSON.stringify(r.fixAvailable)}`,
          r.severity,
        ),
      )
  if (tool === 'pnpm')
    if (data.error || !['info', 'low', 'moderate', 'high', 'critical'].every(key =>
      Number.isInteger(data.metadata.vulnerabilities[key]) && data.metadata.vulnerabilities[key] >= 0))
      throw Error('pnpm result schema invalid')
  if (tool === 'pnpm')
    for (const r of Object.values(data.advisories) as any[]) {
      if (!r || typeof r.module_name !== 'string' || typeof r.title !== 'string' || !Array.isArray(r.findings))
        throw Error('pnpm advisory schema invalid')
      out.push(finding(r.title, r.module_name,
        `Affected: ${r.vulnerable_versions ?? 'unknown'}; paths: ${r.findings.flatMap((f: any) => f.paths ?? []).join(', ')}`,
        `Patched: ${r.patched_versions ?? 'not available'}; ${r.url ?? ''}`, r.severity))
    }
  if (tool === 'zap')
    for (const site of data.site ?? [])
      for (const r of site.alerts ?? [])
        out.push(
          finding(
            r.alert ?? r.name,
            site['@name'] ?? '',
            `Rule ${r.pluginid}; instances: ${r.instances?.length ?? 0}`,
            String(r.solution ?? '').replace(/<[^>]*>/g, ''),
            ['info', 'low', 'medium', 'high'][Number(r.riskcode)],
          ),
        )
  return out
}
async function chromeCookies(c: AuditToolContext): Promise<
  Array<{
    name: string
    value: string
    domain: string
    path: string
    expires: number
    httpOnly: boolean
    secure: boolean
    sameSite: 'Strict' | 'Lax' | 'None'
  }>
> {
  const target = c.settings.targetUrl
  if (!target) return []
  const entry = installedGoChromeEntrypoint(
    dirname(fileURLToPath(import.meta.url)),
    c.repo,
  )
  if (!entry) throw Error('authenticated Chrome broker unavailable')
  const transport = new StdioClientTransport({
    command: 'node',
    args: [entry],
    stderr: 'ignore',
  })
  const client = new Client({ name: 'zerochan-audit-auth', version: '1' })
  try {
    await client.connect(transport)
    // MCP initialization can precede the broker's asynchronous hub connection.
    let result = await client.callTool(
      { name: 'cookies_get', arguments: { url: target } },
      undefined,
      { timeout: 30000 },
    )
    for (let attempt = 0; attempt < 20 && result.isError; attempt++) {
      const startup = (result.content as any[]).some(
        (v) =>
          v.type === 'text' &&
          String(v.text).startsWith('Error: Not connected to hub.'),
      )
      if (!startup) break
      await new Promise((resolve) => setTimeout(resolve, 250))
      result = await client.callTool(
        { name: 'cookies_get', arguments: { url: target } },
        undefined,
        { timeout: 30000 },
      )
    }
    if (result.isError) throw Error('Chrome cookie acquisition failed')
    const text = (result.content as any[])
      .filter((x) => x.type === 'text')
      .map((x) => x.text)
      .join('\n')
    const data = JSON.parse(text),
      cookies = Array.isArray(data) ? data : data.cookies
    if (!Array.isArray(cookies))
      throw Error('Chrome returned an unsupported cookie envelope')
    const host = new URL(target).hostname
    return cookies
      .filter(
        (v) =>
          typeof v.name === 'string' &&
          typeof v.value === 'string' &&
          typeof v.domain === 'string' &&
          (host === v.domain.replace(/^\./, '') ||
            host.endsWith('.' + v.domain.replace(/^\./, ''))),
      )
      .map((v) => ({
        name: v.name,
        value: v.value,
        domain: v.domain,
        path: v.path ?? '/',
        expires: v.expires ?? v.expirationDate ?? -1,
        httpOnly: !!v.httpOnly,
        secure: !!v.secure,
        sameSite: ['Strict', 'strict'].includes(v.sameSite)
          ? 'Strict'
          : ['None', 'no_restriction'].includes(v.sameSite)
            ? 'None'
            : 'Lax',
      }))
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
  }
}
async function authenticatedBrowser(
  c: AuditToolContext,
): Promise<{ note: string; ok: boolean; findings: AuditFinding[] }> {
  if (c.settings.authentication === 'none')
    return {
      ok: true,
      note: '認証を必要としない対象として設定されています。実cookieは取得しません。',
      findings: [],
    }
  if (!c.settings.targetUrl)
    return {
      note: '検査先URLなし。認証付きブラウザ確認は未実施。',
      ok: false,
      findings: [],
    }
  const cookies = await chromeCookies(c)
  if (!(await verifyAuthentication(c, cookies)))
    return {
      note: '認証済みprobe未確認。認証領域を検査済みと扱いません。',
      ok: false,
      findings: [],
    }
  const install = join(toolsRoot(c), 'trusted-playwright'),
    entry = join(install, 'node_modules', 'playwright', 'index.mjs')
  if (!existsSync(entry))
    await checked(
      [
        'npm',
        'install',
        '--prefix',
        install,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        'playwright',
      ],
      c.root,
      c,
    )
  const script = join(c.root, 'authenticated-browser.mjs')
  writeFileSync(
    script,
    `import {chromium} from ${JSON.stringify(entry)};
const input=JSON.parse(await new Promise(resolve=>{let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>data+=d);process.stdin.on('end',()=>resolve(data))}));
const browser=await chromium.launch({channel:'chrome'});
try{const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
 await context.addCookies(input.cookies);
 const allowed=input.urls;
 await context.route('**/*',route=>{const u=new URL(route.request().url()),base=new URL(input.target),prefix=base.pathname.endsWith('/')?base.pathname.slice(0,-1):base.pathname;
  return ['GET','HEAD'].includes(route.request().method())&&u.origin===base.origin&&(u.pathname===prefix||u.pathname.startsWith(prefix+'/'))?route.continue():route.abort();});
 await context.routeWebSocket('**/*',socket=>socket.close());
 const page=await context.newPage();const results=[];
 for(const url of allowed){const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});results.push({url,status:response?.status()??null,authenticated:(await page.locator('body').innerText()).includes(input.pattern)});}
 console.log(JSON.stringify({results}));
}finally{await browser.close()}`,
    { mode: 0o600 },
  )
  const target = c.settings.targetUrl,
    auth = new URL(c.settings.authenticatedPath!, target).href
  const result = await auditCommand(['node', script], c.root, c, {
    sandbox: true,
    input: JSON.stringify({
      cookies,
      target,
      urls: [auth],
      pattern: c.settings.loggedInPattern,
    }),
  })
  if (result.exitCode !== 0 || result.truncated) {
    let detail = result.stderr
    for (const cookie of cookies)
      detail = detail.replaceAll(cookie.value, '[認証情報を除去]')
    throw Error(
      'host-managed authenticated Chrome check failed: ' +
        auditClean(detail).slice(-2400),
    )
  }
  const parsed = JSON.parse(result.stdout)
  if (!Array.isArray(parsed.results) || parsed.results.length !== 1)
    throw Error('authenticated browser result invalid')
  const ok = parsed.results.every(
    (r: any) => r.status >= 200 && r.status < 300 && r.authenticated === true,
  )
  return {
    ok,
    findings: ok
      ? []
      : [
          finding(
            '認証付きChrome確認が失敗',
            '設定された認証確認ページ',
            '認証済み応答をChromeで確認できませんでした。',
            'セッション・ページ・期待条件を確認してください。',
            'medium',
          ),
        ],
    note: `ホスト管理のChromeで認証確認ページをGET確認: ${ok ? '成功' : '失敗'}。任意の既存テストへ実cookieを渡していません。全ページの操作網羅性は未検証。`,
  }
}
export function auditPlaywrightConfigs(source: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || /^(?:node_modules|\.git|\.worktrees)$/.test(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/^playwright\.config\.(?:ts|js|mts|mjs|cts|cjs)$/.test(entry.name)) found.push(relative(source, path))
    }
  }
  walk(source)
  const roots = found.filter(path => dirname(path) === '.')
  return (roots.length ? roots : found).sort()
}

async function preparePlaywrightDependencies(work: string, configPath: string, c: AuditToolContext): Promise<string> {
  if (existsSync(join(work, 'pnpm-lock.yaml'))) {
    const exe = await pnpmBinary(c)
    await checked(['node', exe, 'install', '--frozen-lockfile', '--ignore-scripts', '--config.ignore-pnpmfile=true', '--config.manage-package-manager-versions=false'], work, c, { sandbox: true })
  } else {
    const npm = Bun.which('npm', { PATH: process.env.PATH })
    if (!npm) throw Error('npm unavailable for isolated E2E dependencies')
    await checked(
    [
      npm,
      existsSync(join(work, 'package-lock.json')) ? 'ci' : 'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    work,
    c,
    { sandbox: true },
    )
  }
  const configDir = join(work, dirname(configPath))
  const cli = [join(configDir, 'node_modules', '@playwright', 'test', 'cli.js'), join(work, 'node_modules', '@playwright', 'test', 'cli.js')].find(path => existsSync(path))
  if (!cli)
    throw Error('existing application does not provide @playwright/test')
  return cli
}

async function playwright(
  number: number,
  c: AuditToolContext,
): Promise<{
  result: CommandResult
  version: string
  note: string
  findings: AuditFinding[]
  incomplete: boolean
}> {
  const configs = auditPlaywrightConfigs(c.source)
  if (!configs.length)
    throw Error(
      'Playwright設定がありません。テスト不足は工程1のコードレビューに記載します。',
    )
  if (configs.length !== 1)
    throw Error(`複数のPlaywright設定があります。検査対象をまとめるroot設定が必要です: ${configs.join(', ')}`)
  const work = join(c.root, `e2e-${number}`)
  if (existsSync(work))
    throw Error('既存のE2E実行領域があります。副作用を確認せず再実行しません。')
  cpSync(c.source, work, { recursive: true, force: false, errorOnExist: true })
  const cli = await preparePlaywrightDependencies(work, configs[0]!, c)
  const configDir = join(work, dirname(configs[0]!))
  const version = (await checked(['node', cli, '--version'], work, c, { sandbox: true })).stdout.trim()
  const config = join(configDir, 'zero-audit.playwright.config.ts')
  writeFileSync(
    config,
    `import original from ${JSON.stringify('./' + basename(configs[0]!))};
export default {...original,reporter:[['json']],outputDir:'zero-audit-results',
 use:{...original.use,browserName:'chromium',channel:'chrome',storageState:{cookies:[],origins:[]},trace:'off',video:'off',screenshot:'off'},
 projects:original.projects?.map(p=>({...p,use:{...original.use,...p.use,browserName:'chromium',channel:'chrome',storageState:{cookies:[],origins:[]},trace:'off',video:'off',screenshot:'off'}}))};`,
    { mode: 0o600, flag: 'wx' },
  )
  const localPort = c.settings.e2ePort
  // Project-authored code never receives real session credentials or outbound network.
  const result = await auditCommand(
    ['node', cli, 'test', '--config', config],
    work,
    c,
    { sandbox: true, offline: true, localPort },
  )
  const authNote =
    `Config: ${configs[0]}; local port: ${localPort ?? 'unset'}; platform: ${process.platform}\n` +
    '既存E2Eは実認証情報を渡さず、設定済みローカルtest portだけへの通信で実行。認証付き本番確認はホスト管理の別工程。'
  let note = authNote,
    findings: AuditFinding[] = [],
    incomplete = !localPort || process.platform !== 'darwin'
  if (result.stdout.trim()) {
    const parsed = JSON.parse(result.stdout)
    note += `\nPlaywright stats: ${JSON.stringify(parsed.stats)}`
    const visit = (s: any) => {
      for (const spec of s.specs ?? [])
        for (const test of spec.tests ?? [])
          if (test.status !== 'expected')
            findings.push(
              finding(
                spec.title,
                `${spec.file}:${spec.line}`,
                `status=${test.status}`,
                '既存テストと対象実装を確認してください。',
                'medium',
              ),
            )
      for (const suite of s.suites ?? []) visit(suite)
    }
    visit(parsed)
    if (!parsed.stats || !Array.isArray(parsed.suites))
      throw Error('Playwright result schema invalid')
    if (!(Number(parsed.stats.expected) + Number(parsed.stats.unexpected) + Number(parsed.stats.flaky) > 0)) {
      incomplete = true
      note += '\n実行されたテストがありません。検査済みとして扱いません。'
    }
    if (Number(parsed.stats?.skipped) > 0) {
      incomplete = true
      note += '\nスキップされたケースは検査済みとして扱いません。'
    }
  } else
    throw Error(
      'Playwright structured results unavailable: ' +
        auditClean(result.stderr).slice(-1800),
    )
  return { result, version, note, findings, incomplete }
}
async function dependencyAudit(
  c: AuditToolContext,
  step: AuditStep,
): Promise<AuditStep> {
  const manifests: string[] = [],
    unsupported: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (
        [
          'package-lock.json',
          'npm-shrinkwrap.json',
          'bun.lock',
          'bun.lockb',
          'pnpm-lock.yaml',
          'requirements.txt',
        ].includes(e.name)
      )
        manifests.push(p)
      else if (
        [
          'yarn.lock',
          'poetry.lock',
          'Cargo.lock',
          'Gemfile.lock',
          'go.sum',
          'composer.lock',
        ].includes(e.name)
      )
        unsupported.push(relative(c.source, p))
    }
  }
  walk(c.source)
  manifests.sort()
  let incomplete = unsupported.length > 0
  let evidenceCount = 0
  const digest = createHash('sha256'),
    notes: string[] = []
  step.tool = 'dependency audit'
  step.scope = manifests.map((p) => relative(c.source, p)).join(', ')
  step.version = '各manifestの実行結果を参照'
  for (const manifest of manifests) {
    const name = basename(manifest),
      dir = dirname(manifest)
    try {
      let tool: string, argv: string[], version: string
      if (name === 'requirements.txt') {
        tool = 'pip-audit'
        const root = join(toolsRoot(c), 'pip-audit'),
          exe = join(root, 'bin', 'pip-audit')
        if (!existsSync(exe)) {
          await checked(['python3', '-m', 'venv', root], c.root, c)
          await checked(
            [join(root, 'bin', 'pip'), 'install', 'pip-audit'],
            c.root,
            c,
          )
        }
        argv = [exe, '-r', manifest, '-f', 'json', '--no-deps', '--disable-pip']
        version = (await checked([exe, '--version'], c.root, c)).stdout.trim()
        incomplete = true
        notes.push(
          `${relative(c.source, manifest)}: listed requirementsのみ。任意のbuild hookを実行しないため、未列挙の推移的依存は未検証。`,
        )
      } else if (name === 'pnpm-lock.yaml') {
        tool = 'pnpm'
        const exe = await pnpmBinary({ ...c, source: dir })
        argv = ['node', exe, 'audit', '--json', '--config.ignore-scripts=true', '--config.ignore-pnpmfile=true', '--config.manage-package-manager-versions=false']
        version = (await checked(['node', exe, '--version'], c.root, c)).stdout.trim()
      } else if (name.startsWith('bun.lock')) {
        tool = 'bun audit'
        argv = [process.execPath, 'audit', '--json']
        version = Bun.version
      } else {
        tool = 'npm'
        argv = ['npm', 'audit', '--json', '--ignore-scripts']
        version = (await checked(['npm', '--version'], c.root, c)).stdout.trim()
      }
      const r = await auditCommand(argv, dir, c, { sandbox: true })
      if (r.stdout) { digest.update(r.stdout); evidenceCount++ }
      if (r.truncated || ![0, 1].includes(r.exitCode) || !r.stdout.trim())
        throw Error(`${tool} failed (${r.exitCode}): ${auditClean(r.stderr).slice(0, 1200)}`)
      const data = JSON.parse(r.stdout)
      if (tool === 'pip-audit') {
        if (!Array.isArray(data.dependencies))
          throw Error('pip-audit schema invalid')
        for (const dep of data.dependencies)
          for (const v of dep.vulns ?? [])
            step.findings.push(
              finding(
                v.id,
                `${relative(c.source, manifest)}: ${dep.name}`,
                `Version: ${dep.version}`,
                `Fix versions: ${(v.fix_versions ?? []).join(', ')}`,
                'medium',
              ),
            )
      } else step.findings.push(...scannerFindings(tool, data))
      notes.push(
        `${relative(c.source, manifest)}: ${tool} ${version}; exit=${r.exitCode}`,
      )
    } catch (error) {
      if (
        error instanceof CodexCleanupPendingError ||
        error instanceof CodexUserCancelledError ||
        error instanceof CodexInterruptedError
      )
        throw error
      incomplete = true
      notes.push(
        `${relative(c.source, manifest)}: ${auditClean(error instanceof Error ? error.message : 'failed')}`,
      )
    }
  }
  if (unsupported.length)
    notes.push('この工程の対応外lockfile: ' + unsupported.join(', '))
  if (!manifests.length) notes.push('対応する依存manifestなし。検査未実施。')
  return {
    ...step,
    status:
      incomplete || !manifests.length
        ? 'unavailable'
        : step.findings.length
          ? 'findings'
          : 'completed',
    note: notes.join('\n'),
    evidenceDigest: evidenceCount ? digest.digest('hex') : null,
    finishedAt: Date.now(),
  }
}
export function assertSemgrepCodeResult(data: any): void {
  if (data?.engine_requested !== 'PRO' || !Array.isArray(data?.paths?.scanned)
    || data.paths.scanned.length === 0 || !Array.isArray(data?.results)
    || !Array.isArray(data?.interfile_languages_used) || !data.interfile_languages_used.length)
    throw Error('Semgrep Code Pro/cross-file execution evidence is missing; CE fallback is not accepted')
}

async function semgrepRepository(c: AuditToolContext): Promise<string> {
  if (c.settings.semgrepRepo) return c.settings.semgrepRepo
  const r = await auditCommand(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    'config', '--get', 'remote.origin.url'], c.repo, c, { timeoutMs: 30000 })
  const match = r.stdout.trim().match(/^(?:https:\/\/[^/@]+\/|git@[^:]+:)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/)
  if (r.exitCode || !match) throw Error('Semgrep project identity unavailable; configure semgrep-repo OWNER/REPO')
  return match[1]!
}

async function semgrepCodeScan(c: AuditToolContext): Promise<{ result: CommandResult; version: string }> {
  const token = readOptionalBoundedOwnerOnlyRegularFile(join(c.stateDir, 'security-audit-semgrep-token'), 4096)?.trim()
  if (!token) throw Error('Semgrep Code credential unavailable; configure semgrep-token')
  const exe = await binary('semgrep', c)
  const env = { SEMGREP_APP_TOKEN: token, SEMGREP_REPO_NAME: await semgrepRepository(c) }
  const version = (await checked([exe, '--version'], c.root, c)).stdout.trim()
  // Use the managed engine belonging to this CLI version. Installation also validates entitlement.
  const install = await auditCommand([exe, 'install-semgrep-pro'], c.root, c, { env })
  if (install.exitCode || install.truncated) throw Error(`Semgrep Code Pro installation/authentication failed (exit=${install.exitCode})`)
  // Standalone policy scans fetch the account's Code rules without uploading findings/source snippets.
  const result = await auditCommand([exe, 'scan', '--config', 'policy', '--pro',
    ...(c.semgrepProbe ? ['--config', join(c.source, 'probe-rules.yml')] : []),
    '--metrics', 'off', '--disable-version-check', '--json', c.source], c.source, c,
    { sandbox: true, env })
  result.stdout = result.stdout.replaceAll(token, '[認証情報を除去]')
  // Diagnostics can echo credentials; publish only the exit status for this authenticated CLI.
  result.stderr = result.exitCode ? `Semgrep Code scan failed (exit=${result.exitCode})` : ''
  return { result, version }
}

export async function runAuditTool(
  number: number,
  c: AuditToolContext,
): Promise<AuditStep> {
  const step: AuditStep = {
    number,
    status: 'running',
    tool: '',
    version: 'unknown',
    scope: 'source snapshot',
    note: '',
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    findings: [],
    evidenceDigest: null,
  }
  let result: CommandResult | undefined
  const evidence = createHash('sha256')
  let evidenceRecorded = false
  const readEvidence = (path: string): string => {
    const raw = readFileSync(path, 'utf8')
    evidence.update(`${basename(path)}\0${Buffer.byteLength(raw)}\0`).update(raw)
    evidenceRecorded = true
    return raw
  }
  const stageRoot = join(c.root, `stage-${number}`)
  mkdirSync(stageRoot, { recursive: true, mode: 0o700 })
  const stageSource = join(stageRoot, 'source')
  if (!existsSync(stageSource))
    cpSync(c.source, stageSource, {
      recursive: true,
      errorOnExist: true,
      force: false,
    })
  c = { ...c, root: stageRoot, source: stageSource }
  const output = join(c.root, `tool-${number}.json`)
  try {
    if (number === 1 || number === 11) {
      step.tool = 'Playwright channel=chrome'
      let auth: { ok: boolean; note: string; findings: AuditFinding[] }
      try {
        auth = await authenticatedBrowser(c)
      } catch (error) {
        if (
          error instanceof CodexCleanupPendingError ||
          error instanceof CodexUserCancelledError ||
          error instanceof CodexInterruptedError
        )
          throw error
        auth = {
          ok: false,
          note: '認証確認は実行できませんでした。既存E2Eは別途実行します。',
          findings: [],
        }
      }
      step.note = auth.note
      step.findings = auth.findings
      const p = await playwright(number, c)
      result = p.result
      step.version = p.version
      step.note += '\n' + p.note
      step.findings.push(...p.findings)
      if (p.incomplete || !auth.ok) step.status = 'unavailable'
    }
    if (number === 5) return await dependencyAudit(c, step)
    if (number === 6) {
      step.tool = 'semgrep'
      const scan = await semgrepCodeScan(c)
      result = scan.result
      step.version = scan.version
      step.scope = 'Semgrep Code / Pro cross-file engine / configured Code policy; local scan'
    }
    if (number === 7) {
      step.tool = 'trivy'
      const exe = await binary('trivy', c)
      step.version = (
        await checked([exe, '--version'], c.root, c)
      ).stdout.trim()
      if (!/^Version: 0\.69\.3\s*$/m.test(step.version))
        throw Error(
          'Trivy version must be exactly 0.69.3; refusing other version',
        )
      step.scope =
        'filesystem: vuln,misconfig,secret,license; configured container images'
      result = await auditCommand(
        [
          exe,
          'fs',
          '--scanners',
          'vuln,misconfig,secret,license',
          '--format',
          'json',
          '--cache-dir',
          join(c.root, 'trivy-cache'),
          c.source,
        ],
        c.root,
        c,
        { sandbox: true },
      )
      step.findings.push(...scannerFindings('trivy', JSON.parse(result.stdout)))
      for (const image of c.settings.images) {
        try {
          const r = await checked(
            [
              exe,
              'image',
              '--image-src',
              'remote',
              '--scanners',
              'vuln,secret,license',
              '--format',
              'json',
              '--cache-dir',
              join(c.root, 'trivy-cache'),
              image,
            ],
            c.root,
            c,
            { sandbox: true },
          )
          step.findings.push(...scannerFindings('trivy', JSON.parse(r.stdout)))
        } catch (error) {
          if (
            error instanceof CodexCleanupPendingError ||
            error instanceof CodexUserCancelledError ||
            error instanceof CodexInterruptedError
          )
            throw error
          step.status = 'unavailable'
          step.note += `\nImage ${image}: 検査失敗。filesystemの結果は保持。`
        }
      }
    }
    if (number === 8) {
      step.tool = 'gitleaks'
      const exe = await binary('gitleaks', c)
      step.version = (await checked([exe, 'version'], c.root, c)).stdout.trim()
      step.scope = 'snapshot directory + Git history when available'
      result = await auditCommand(
        [
          exe,
          'dir',
          c.source,
          '--redact=100',
          '--report-format=json',
          `--report-path=${output}`,
        ],
        c.root,
        c,
        { sandbox: true },
      )
      if (!existsSync(output)) throw Error('Gitleaks directory report unavailable')
      step.findings.push(
          ...scannerFindings(
            'gitleaks',
            JSON.parse(readEvidence(output)),
          ),
        )
      const history = join(c.root, 'history.git'),
        cloned = await auditCommand(
          [
            'git',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.fsmonitor=false',
            'clone',
            '--bare',
            '--no-hardlinks',
            c.repo,
            history,
          ],
          c.root,
          c,
        )
      if (cloned.exitCode === 0) {
        const path = join(c.root, 'history-leaks.json')
        const r = await auditCommand(
          [
            exe,
            'git',
            history,
            '--redact=100',
            '--report-format=json',
            `--report-path=${path}`,
          ],
          c.root,
          c,
          { sandbox: true },
        )
        if (!existsSync(path)) throw Error('Gitleaks history report unavailable')
        step.findings.push(
            ...scannerFindings(
              'gitleaks',
              JSON.parse(readEvidence(path)),
            ),
          )
        step.note += `\nGit history scan: exit=${r.exitCode}`
        if (r.truncated || ![0, 1].includes(r.exitCode)) throw Error('Gitleaks history scan failed')
      } else {
        step.note = 'Git履歴を取得できませんでした。ディレクトリ検査のみ。'
        step.status = 'unavailable'
      }
    }
    if (number === 9) {
      step.tool = 'socket'
      const token = readOptionalBoundedOwnerOnlyRegularFile(
        join(c.stateDir, 'security-audit-socket-token'),
        4096,
      )?.trim()
      if (!token) throw Error('Socket credential unavailable')
      if (!c.settings.socketOrg)
        throw Error('Socket organization is not configured')
      const install = join(toolsRoot(c), 'socket'),
        exe = join(install, 'node_modules', '.bin', 'socket')
      if (!existsSync(exe))
        await checked(
          [
            'npm',
            'install',
            '--prefix',
            install,
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            'socket',
          ],
          c.root,
          c,
        )
      step.version = (
        await checked([exe, '--version'], c.root, c)
      ).stdout.trim()
      const receiptPath = c.socketReceiptPath ?? join(c.root, 'socket-scan.json')
      const receiptText = readOptionalBoundedOwnerOnlyRegularFile(receiptPath, 4096)
      const receipt = receiptText ? JSON.parse(receiptText) : null
      let scanId: string | undefined
      if (receipt) {
        if (receipt.org !== c.settings.socketOrg || typeof receipt.scanId !== 'string'
          || !/^[a-zA-Z0-9-]{1,100}$/.test(receipt.scanId))
          throw Error('Socket scan creation was interrupted or scope changed; a new audit request is required (not replayed)')
        scanId = receipt.scanId
      } else {
        atomicWritePrivateFile(receiptPath, JSON.stringify({ org: c.settings.socketOrg, scanId: null }))
      result = await auditCommand(
        [
          exe,
          'scan',
          'create',
          '--org',
          c.settings.socketOrg,
          '--repo',
          `audit-${c.socketReceiptPath ? 'preflight-' : ''}${createHash('sha256').update(c.repo).digest('hex').slice(0, 16)}`,
          '--no-set-as-alerts-page',
          '--no-interactive',
          '--json',
          c.source,
        ],
        c.root,
        c,
        { sandbox: true, env: { SOCKET_CLI_API_TOKEN: token } },
      )
      if (result.exitCode !== 0 || result.truncated)
        throw Error('Socket scan creation failed')
      const created = JSON.parse(result.stdout.replaceAll(token, '[認証情報を除去]'))
      scanId = created.ok === true ? created.data?.id : undefined
      if (typeof scanId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(scanId))
        throw Error('Socket scan ID unavailable')

        atomicWritePrivateFile(receiptPath, JSON.stringify({ org: c.settings.socketOrg, scanId }))
      }
      step.note = `Socket scan: ${scanId}`
      result = await auditCommand(
        [
          exe,
          'scan',
          'report',
          scanId!,
          '--org',
          c.settings.socketOrg,
          '--fold',
          'none',
          '--report-level',
          'defer',
          '--license',
          '--no-interactive',
          '--json',
        ],
        c.root,
        c,
        { sandbox: true, env: { SOCKET_CLI_API_TOKEN: token } },
      )
      result.stdout = result.stdout.replaceAll(token, '[認証情報を除去]')
      result.stderr = result.stderr.replaceAll(token, '[認証情報を除去]')
      step.note +=
        '\nSocketの構造化結果を取得。作成したscanの識別子と評価は結果欄を参照。'
    }
    if (number === 10) {
      step.tool = 'zap'
      if (!c.settings.targetUrl) throw Error('本番/検査対象URLが未指定です')
      const target = new URL(c.settings.targetUrl)
      const docker = resolveDockerRuntime()
      if (!docker) throw Error('Selected local Docker engine is unavailable')
      c = { ...c, dockerHost: docker.host }
      step.scope = `${target.origin}${target.pathname}; ${c.settings.activeScan ? 'active' : 'passive baseline'}`
      if (!Bun.which('docker'))
        throw Error(
          'Docker unavailable; Docker Desktop installation/start is required',
        )
      await checked(
        ['docker', 'info', '--format', '{{.ServerVersion}}'],
        c.root,
        c,
        { timeoutMs: 30000 },
      )
      const image = 'ghcr.io/zaproxy/zaproxy:stable'
      await checked(['docker', 'pull', image], c.root, c)
      const digest = (
        await checked(
          [
            'docker',
            'image',
            'inspect',
            image,
            '--format',
            '{{index .RepoDigests 0}}',
          ],
          c.root,
          c,
        )
      ).stdout.trim()
      if (!/^ghcr\.io\/zaproxy\/zaproxy@sha256:[a-f0-9]{64}$/.test(digest))
        throw Error('ZAP image digest unavailable')
      step.version = digest
      let cookies: Awaited<ReturnType<typeof chromeCookies>> = []
      if (c.settings.authentication !== 'none') {
        try {
          cookies = await chromeCookies(c)
        } catch {
          step.note =
            'Chromeの認証取得が利用できません。公開領域の検査のみ実行します。'
        }
      }
      const cookie = cookies.map((v) => `${v.name}=${v.value}`).join('; ')
      step.note +=
        c.settings.authentication === 'none'
          ? '認証不要の公開対象として検査します。cookie取得・認証確認は行いません。'
          : cookie
            ? 'Chromeの対象URL用cookieをメモリ内で引き渡しました。認証の維持/網羅性は別途確認が必要です。'
            : '認証cookieなし。認証領域は検査できていません。'
      const zapDir = join(c.root, 'zap')
      mkdirSync(zapDir, { mode: 0o700 })
      const args = [
        'docker',
        'run',
        '--rm',
        '--name',
        `zero-audit-${c.jobId}`,
        '--workdir',
        '/zap/wrk',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '-v',
        `${zapDir}:/zap/wrk:rw`,
      ]
      let probe: { url: string; pattern: string } | undefined
      if (
        c.settings.authentication !== 'none' &&
        c.settings.authenticatedPath &&
        c.settings.loggedInPattern
      ) {
        try {
          const url = new URL(c.settings.authenticatedPath, target)
          if (auditTargetAllows(target.href, url.href))
            probe = { url: url.href, pattern: c.settings.loggedInPattern }
          else
            step.note +=
              '\n認証probeが対象範囲外のため、公開検査のみ続行します。'
        } catch {
          step.note += '\n認証probeの設定が不正なため、公開検査のみ続行します。'
        }
      }
      const scoped = zapScopeFiles(target.href, probe)
      writeFileSync(join(zapDir, 'scope.context'), scoped.context, {
        mode: 0o600,
      })
      writeFileSync(join(zapDir, 'hook.py'), scoped.hook, { mode: 0o600 })
      writeFileSync(join(zapDir, 'auth.js'), scoped.script, { mode: 0o600 })
      args.push(
        '-e',
        'HOME=/zap/wrk',
        '--user',
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '-e',
        'ZERO_AUDIT_COOKIE',
        '--label',
        `zerochan.audit.job=${c.jobId}`,
      )
      args.push(
        digest,
        c.settings.activeScan ? 'zap-full-scan.py' : 'zap-baseline.py',
        '-t',
        target.href,
        '-n',
        '/zap/wrk/scope.context',
        '--hook',
        '/zap/wrk/hook.py',
        '-J',
        'report.json',
        '-z',
        '-dir /zap/wrk/zap-home',
      )
      let authenticated = c.settings.authentication === 'none'
      try {
        result = await auditCommand(args, c.root, c, {
          env: cookie ? { ZERO_AUDIT_COOKIE: cookie } : {},
        })
        step.exitCode = result.exitCode
        result.stdout = redactAuditCookies(result.stdout, cookies)
        result.stderr = redactAuditCookies(result.stderr, cookies)
        if (c.settings.authentication !== 'none') {
          authenticated = existsSync(join(zapDir, 'auth-confirmed'))
          step.note += authenticated
            ? '\nZAP自身が認証probeの期待応答を確認しました。全ページの認証維持は保証しません。'
            : '\nZAP経由の認証probeを確認できませんでした。公開検査の結果だけを保持します。'
        }
        const report = join(zapDir, 'report.json')
        if (!existsSync(report)) throw Error(`ZAP report unavailable (exit=${result.exitCode}): ${auditClean(result.stderr + '\n' + result.stdout).slice(-2400)}`)
        step.findings = scannerFindings(
          'zap',
          JSON.parse(readEvidence(report)),
        )
      } finally {
        await cleanupAuditZap(c)
        rmSync(zapDir, { recursive: true, force: true })
      }
      if (!authenticated) step.status = 'unavailable'
    }
    if (!result) throw Error('unsupported audit step')
    step.exitCode = result.exitCode
    step.evidenceDigest = evidenceRecorded ? evidence.digest('hex')
      : result.stdout ? createHash('sha256').update(result.stdout).digest('hex') : null
    if (number === 6) {
      try {
        const data = JSON.parse(result.stdout)
        assertSemgrepCodeResult(data)
        step.findings.push(...scannerFindings(step.tool, data))
        if (
          number === 6 &&
          (data.errors?.length || data.paths?.skipped?.length)
        ) {
          step.note += `\nSemgrep errors: ${data.errors?.length ?? 0}; skipped: ${data.paths?.skipped?.length ?? 0}`
          for (const error of (data.errors ?? []).slice(0, 50)) {
            const kind = typeof error.type === 'string' ? error.type : Array.isArray(error.type) ? error.type[0] : 'unknown'
            step.note += `\n${auditClean(String(kind)).slice(0, 100)}: ${auditClean(String(error.path ?? 'unknown path')).slice(0, 1000)} (code=${Number(error.code)})`
          }
          step.status = 'unavailable'
        }
      } catch {
        throw Error('scanner structured output is invalid')
      }
    }
    if (number === 9) {
      const data = JSON.parse(result.stdout)
      step.findings.push(...scannerFindings('socket', data))
      step.note += `\nScan: ${auditClean(String(data.data?.scanId ?? 'unavailable'))}; healthy=${data.data?.healthy}`
    }
    const accepted =
      number === 10 ? [0, 1, 2] : [5, 8, 9].includes(number) ? [0, 1] : [0]
    if (!['unavailable', 'failed'].includes(step.status))
      step.status =
        result.truncated || !accepted.includes(result.exitCode)
          ? 'failed'
          : step.findings.length
            ? 'findings'
            : 'completed'
    if (step.status === 'failed')
      step.note += `\nexit=${result.exitCode}; ${auditClean(result.stderr).slice(0, 1200)}`
  } catch (error) {
    if (
      error instanceof CodexCleanupPendingError ||
      error instanceof CodexUserCancelledError ||
      error instanceof CodexInterruptedError
    )
      throw error
    step.status = 'unavailable'
    step.note += `\n${auditClean(error instanceof Error ? error.message : 'tool unavailable')}`
  } finally {
    if (number === 8) {
      for (const path of [
        join(c.root, 'history.git'),
        output,
        join(c.root, 'history-leaks.json'),
      ])
        rmSync(path, { recursive: true, force: true })
    }
  }
  step.finishedAt = Date.now()
  return step
}

/** Actual tiny executions, isolated from project code and existing E2E scripts. */
export async function runAuditProbe(
  number: number,
  original: AuditToolContext,
  model = runIsolatedCodexJson,
): Promise<AuditStep> {
  checkAuditInterrupted(original)
  if (!Number.isInteger(number) || number < 1 || number > 12) throw Error('unknown availability stage')
  const root = mkdtempSync(join(original.root, `probe-${number}-`))
  chmodSync(root, 0o700)
  const source = join(root, 'source')
  mkdirSync(source, { mode: 0o700 })
  const put = (name: string, value: string) => {
    mkdirSync(dirname(join(source, name)), { recursive: true, mode: 0o700 })
    writeFileSync(join(source, name), value, { mode: 0o600 })
  }
  put('hello.js', 'export const hello = "Hello World";\n')
  const c: AuditToolContext = { ...original, root, source, progress: undefined }
  let step: AuditStep = { number, tool: 'availability probe', version: '1', scope: 'host-owned synthetic fixture',
    status: 'completed', note: '', startedAt: Date.now(), finishedAt: null, exitCode: null,
    findings: [], evidenceDigest: null }
  const reasons: string[] = []
  const attempt = async (label: string, fn: () => Promise<void>) => {
    checkAuditInterrupted(c)
    try { await fn() } catch (error) {
      if (error instanceof CodexCleanupPendingError || error instanceof CodexUserCancelledError || error instanceof CodexInterruptedError) throw error
      reasons.push(`${label}: ${auditClean(error instanceof Error ? error.message : 'unavailable').slice(0, 1500)}`)
    }
  }
  const accept = (result: AuditStep) => {
    step = { ...result, number, scope: 'host-owned synthetic fixture' }
    if (!['completed', 'findings'].includes(result.status)) throw Error(result.note || `${result.tool}: ${result.status}`)
  }
  const syntheticJournal: AuditJournal = { version: 2, jobId: c.jobId, repoPath: source,
    sessionId: randomUUID(), createdAt: Date.now(), revision: 'synthetic', files: ['hello.js'], omitted: [],
    steps: [], result: null, reportDigest: null }
  let retainForCleanup = false
  try {
  if (number <= 4) await attempt('Codex', async () => {
    accept(await auditCodeReview(number, syntheticJournal, c, model))
  })
  if (number === 1 || number === 11) {
    await attempt('E2E configuration', async () => {
      const configs = auditPlaywrightConfigs(original.source)
      if (configs.length !== 1 || !original.settings.e2ePort)
        throw Error('one Playwright configuration and e2e-port are required')
      if (process.platform !== 'darwin') throw Error('isolated local-port E2E execution requires macOS')
      // Resolve the target's exact dependencies without importing its config or starting its server/tests.
      const work = join(root, 'e2e-dependencies')
      cpSync(original.source, work, { recursive: true, force: false, errorOnExist: true })
      const cli = await preparePlaywrightDependencies(work, configs[0]!, c)
      const configDir = join(work, dirname(configs[0]!)), testDir = join(configDir, 'zero-audit-preflight')
      mkdirSync(testDir, { mode: 0o700 })
      const config = join(configDir, 'zero-audit-preflight.config.mjs')
      writeFileSync(config, "export default {testDir:'./zero-audit-preflight',reporter:[['json']],workers:1,use:{browserName:'chromium',channel:'chrome'}};\n", { mode: 0o600, flag: 'wx' })
      writeFileSync(join(testDir, 'hello.spec.mjs'), "import {test,expect} from '@playwright/test';test('Hello World',async({page})=>{await page.setContent('<h1>Hello World</h1>');await expect(page.locator('h1')).toHaveText('Hello World')});\n", { mode: 0o600, flag: 'wx' })
      const r = await checked(['node', cli, 'test', '--config', config], work, c, { sandbox: true, offline: true, timeoutMs: 60000 })
      const data = JSON.parse(r.stdout)
      if (data.stats?.expected !== 1 || data.stats?.unexpected !== 0 || data.stats?.skipped !== 0) throw Error('target Playwright Hello World did not pass')
      step.evidenceDigest = createHash('sha256').update(r.stdout).digest('hex')

    })
    await attempt('Chrome Hello World', async () => {
      const install = join(toolsRoot(c), 'trusted-playwright'), entry = join(install, 'node_modules/playwright/index.mjs')
      if (!existsSync(entry)) await checked(['npm', 'install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', 'playwright'], root, c)
      const script = join(root, 'hello-chrome.mjs')
      writeFileSync(script, `import {chromium} from ${JSON.stringify(entry)};
const browser=await chromium.launch({channel:'chrome'});try{const page=await browser.newPage();await page.setContent('<h1>Hello World</h1>');if(await page.locator('h1').innerText()!=='Hello World')throw Error('assertion failed');console.log(JSON.stringify({passed:1}));}finally{await browser.close()}`, { mode: 0o600 })
      const r = await checked(['node', script], root, c, { sandbox: true, offline: true, timeoutMs: 60000 })
      if (JSON.parse(r.stdout).passed !== 1) throw Error('Chrome assertion did not pass')
      step.evidenceDigest = createHash('sha256').update(r.stdout).digest('hex')
    })
    await attempt('Target authentication', async () => {
      if (!c.settings.authentication) throw Error('auth required|none must be configured')
      const auth = await authenticatedBrowser(c)
      if (!auth.ok) throw Error(auth.note)
    })
  }
  if (number === 5) await attempt('Dependency backends', async () => {
    const names = new Set<string>()
    const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name)); else names.add(e.name)
    } }
    walk(original.source)
    const kinds = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'requirements.txt'].filter(n => names.has(n))
    if (!kinds.length) throw Error('supported dependency lockfile/requirements unavailable')
    const unsupported = ['yarn.lock', 'poetry.lock', 'Cargo.lock', 'Gemfile.lock', 'go.sum', 'composer.lock'].filter(n => names.has(n))
    if (unsupported.length) reasons.push(`dependency audit unsupported: ${unsupported.join(', ')}`)
    for (const kind of kinds) await attempt(kind, async () => {
      const dir = join(source, kind.replaceAll('.', '-')); mkdirSync(dir, { mode: 0o700 })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'zero-audit-fixture', version: '1.0.0', private: true, dependencies: { 'is-number': '7.0.0' } }), { mode: 0o600 })
      if (kind === 'requirements.txt') {
        const install = join(toolsRoot(c), 'pip-audit'), exe = join(install, 'bin/pip-audit')
        if (!existsSync(exe)) {
          await checked(['python3', '-m', 'venv', install], root, c)
          await checked([join(install, 'bin/pip'), 'install', 'pip-audit'], root, c)
        }
        writeFileSync(join(dir, kind), 'six==1.17.0\n', { mode: 0o600 })
        const r = await auditCommand([exe, '-r', join(dir, kind), '-f', 'json', '--no-deps', '--disable-pip'], dir, c, { sandbox: true })
        if (r.truncated || ![0, 1].includes(r.exitCode) || !Array.isArray(JSON.parse(r.stdout).dependencies)) throw Error('pip-audit fixture failed')
      } else {
        const command = kind === 'pnpm-lock.yaml'
          ? ['node', await pnpmBinary(original), 'install', '--lockfile-only', '--ignore-scripts', '--config.ignore-pnpmfile=true', '--config.manage-package-manager-versions=false']
          : kind.startsWith('bun.lock') ? [process.execPath, 'install', '--lockfile-only', '--ignore-scripts']
          : ['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']
        await checked(command, dir, c, { sandbox: true })
        accept(await dependencyAudit({ ...c, source: dir }, { ...step, findings: [] }))
      }
    })
  })
  if (number === 6) await attempt('Semgrep Code', async () => {
    c.settings = { ...c.settings, semgrepRepo: await semgrepRepository(original) }
    const policyRoot = join(root, 'policy-check'); mkdirSync(policyRoot, { mode: 0o700 })
    // A local probe rule must not hide an empty/unavailable account policy.
    accept(await runAuditTool(6, { ...c, root: policyRoot }))
    put('entry.js', 'import {consume} from "./sink.js"; consume(source());\n')
    put('sink.js', 'export function consume(value) { sink(value); }\n')
    put('safe.js', 'import {consume} from "./sink.js"; consume(clean(source()));\n')
    put('probe-rules.yml', 'rules:\n  - id: zero-probe-crossfile\n    languages: [javascript]\n    message: synthetic cross-file probe\n    severity: ERROR\n    mode: taint\n    pattern-sources:\n      - pattern: source()\n    pattern-sinks:\n      - pattern: sink(...)\n    pattern-sanitizers:\n      - pattern: clean(...)\n')
    accept(await runAuditTool(6, { ...c, semgrepProbe: true }))
    if (!step.findings.some(f => f.title.endsWith('zero-probe-crossfile') && f.location.includes('sink.js')))
      throw Error('known cross-file finding was not detected')
  })
  if (number === 7) await attempt('Trivy', async () => {
    put('Dockerfile', 'FROM alpine:3.20\nUSER root\n')
    // Never scan configured real images before the ready notification.
    accept(await runAuditTool(7, { ...c, settings: { ...c.settings, images: c.settings.images.length ? ['busybox:1.37.0'] : [] } }))
    for (const image of c.settings.images) await attempt('Image availability', async () => {
      // Match Trivy's isolated remote source: host-only Docker images are not reachable there.
      const remote = await auditCommand(['docker', 'manifest', 'inspect', image], root, c, { timeoutMs: 60000 })
      if (remote.exitCode || remote.truncated || JSON.parse(remote.stdout)?.schemaVersion !== 2)
        throw Error('configured image registry metadata unavailable; local-only images are not supported by isolated Trivy')
    })
  })
  if (number === 8) await attempt('Gitleaks', async () => {
    put('fixture.env', 'api_key="' + 'aB3dE5fG7hI9jK1mN3pQ5rS7tU9vW1xY' + '"\n')
    for (const args of [['init'], ['add', '.'], ['commit', '-m', 'synthetic fixture']])
      await checked(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Audit Fixture', '-c', 'user.email=fixture@example.invalid', ...args], source, c)
    accept(await runAuditTool(8, { ...c, repo: source }))
    if (!step.findings.length) throw Error('known synthetic secret was not detected')
    const head = await auditCommand(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'rev-parse', '--verify', 'HEAD'], original.repo, c)
    if (head.exitCode) throw Error('target Git history unavailable')
  })
  if (number === 9) await attempt('Socket scan/report', async () => {
    put('package.json', JSON.stringify({ name: 'zero-audit-preflight', version: '1.0.0', private: true, dependencies: { 'is-number': '7.0.0' } }))
    accept(await runAuditTool(9, { ...c, socketReceiptPath: join(original.root, 'preflight-socket.json') }))
  })
  if (number === 10) {
    await attempt('ZAP target configuration', async () => {
      if (!c.settings.targetUrl || !c.settings.authentication) throw Error('target URL and authentication mode are required')
      if (c.settings.authentication === 'required' && (!c.settings.authenticatedPath || !c.settings.loggedInPattern)) throw Error('authenticated target probe is missing')
    })
    await attempt('ZAP Hello World', async () => {
      const docker = resolveDockerRuntime()
      if (!docker) throw Error('Selected local Docker engine is unavailable')
      c.dockerHost = docker.host
      const marker = join(original.root, 'preflight-zap-owned')
      if (existsSync(marker)) await cleanupAuditZap(c)
      await checked(['docker', 'info', '--format', '{{.ServerVersion}}'], root, c, { timeoutMs: 30000 })
      const image = 'ghcr.io/zaproxy/zaproxy:stable'
      await checked(['docker', 'pull', image], root, c)
      const site = join(root, 'site'); mkdirSync(site, { mode: 0o700 })
      writeFileSync(join(site, 'index.html'), '<h1>Hello World</h1>', { mode: 0o600 })
      atomicWritePrivateFile(marker, 'owned\n')
      try {
        const command = 'python3 -m http.server 8765 --bind 127.0.0.1 --directory /zap/wrk/site >/zap/wrk/http.log 2>&1 & ' +
          (c.settings.activeScan ? 'zap-full-scan.py' : 'zap-baseline.py -m 1') + ' -t http://127.0.0.1:8765/ -J report.json -z "-dir /zap/wrk/zap-home"'
        const r = await auditCommand(['docker', 'run', '--rm', '--name', `zero-audit-${c.jobId}`,
          '--label', `zerochan.audit.job=${c.jobId}`, '--cap-drop=ALL', '--security-opt=no-new-privileges',
          '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '-e', 'HOME=/zap/wrk',
          '-v', `${root}:/zap/wrk:rw`, '--workdir', '/zap/wrk', image, 'sh', '-c', command], root, c)
        if (r.truncated || ![0, 1, 2].includes(r.exitCode)) throw Error(`ZAP fixture scan failed (exit=${r.exitCode})`)
        const raw = readFileSync(join(root, 'report.json'), 'utf8'), data = JSON.parse(raw)
        scannerFindings('zap', data)
        if (!data.site.length) throw Error('ZAP did not scan the synthetic site')
        step.evidenceDigest = createHash('sha256').update(raw).digest('hex')
        step.exitCode = r.exitCode
      } finally { await cleanupAuditZap(c); rmSync(marker, { force: true }) }
    })
  }
  if (number === 12) await attempt('Report compiler', async () => {
    syntheticJournal.steps = [{ ...step, status: 'completed' }]
    const raw = renderAuditReport(syntheticJournal), path = join(root, 'probe-report.md')
    atomicWritePrivateFile(path, raw)
    const copy = readOptionalBoundedOwnerOnlyRegularFile(path, 1_000_000)
    if (copy !== raw || !copy.includes('セキュリティ検査レポート')) throw Error('report roundtrip failed')
    step.evidenceDigest = createHash('sha256').update(raw).digest('hex')
  })
  return { ...step, number, status: reasons.length ? 'unavailable' : 'completed', findings: [],
    note: reasons.length ? reasons.join('\n') : '設定確認と小規模な実行確認に成功しました。本コードの検査結果ではありません。', finishedAt: Date.now() }
  } catch (error) {
    retainForCleanup = error instanceof CodexCleanupPendingError
    throw error
  } finally {
    if (!retainForCleanup) rmSync(root, { recursive: true, force: true })
  }
}
