import { createHash } from 'crypto'
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
  type AuditSettings,
  type AuditStep,
  type AuditFinding,
} from './security-audit.ts'

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
        (allow file-read-metadata ${[...ancestors].map((p) => `(literal ${quote(p)})`).join(' ')})
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
        JAVA_TOOL_OPTIONS: `-Djava.io.tmpdir=${runtime}`,
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
      `${basename(args[0]!)} failed (${r.exitCode}${r.truncated ? ', output limit' : ''})`,
    )
  return r
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
  name: 'semgrep' | 'codeql' | 'trivy' | 'gitleaks',
  c: AuditToolContext,
): Promise<string> {
  const root = toolsRoot(c)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const installed = Bun.which(name)
  if (installed && name !== 'trivy' && name !== 'codeql') return installed
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
  if (name === 'codeql') {
    const exe = join(root, 'codeql', 'codeql')
    if (existsSync(exe)) return exe
    const os =
      process.platform === 'darwin'
        ? 'osx64'
        : process.platform === 'linux' && process.arch === 'x64'
          ? 'linux64'
          : null
    if (!os)
      throw Error('CodeQL has no configured native bundle for this platform')
    const archive = await releaseAsset(
      'github/codeql-cli-binaries',
      'latest',
      new RegExp(`^codeql-${os}\\.zip$`),
      c,
    )
    await checked(['unzip', '-q', '-o', archive, '-d', root], root, c)
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
        : ''),
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
  const configs = readdirSync(c.source)
    .sort()
    .filter((n) => /^playwright\.config\.(?:ts|js|mts|mjs|cts|cjs)$/.test(n))
  if (!configs.length)
    throw Error(
      'Playwright設定がありません。テスト不足は工程1のコードレビューに記載します。',
    )
  const work = join(c.root, `e2e-${number}`)
  if (existsSync(work))
    throw Error('既存のE2E実行領域があります。副作用を確認せず再実行しません。')
  cpSync(c.source, work, { recursive: true, force: false, errorOnExist: true })
  const npm = Bun.which('npm')
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
  const cli = join(work, 'node_modules', '@playwright', 'test', 'cli.js')
  if (!existsSync(cli))
    throw Error('existing application does not provide @playwright/test')
  const version = (
    await checked(['node', cli, '--version'], work, c, { sandbox: true })
  ).stdout.trim()
  const config = join(work, 'zero-audit.playwright.config.ts')
  writeFileSync(
    config,
    `import original from './${configs[0]}';
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
          'requirements.txt',
        ].includes(e.name)
      )
        manifests.push(p)
      else if (
        [
          'pnpm-lock.yaml',
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
      digest.update(r.stdout)
      if (r.truncated || ![0, 1].includes(r.exitCode))
        throw Error(`${tool} failed (${r.exitCode})`)
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
    evidenceDigest: digest.digest('hex'),
    finishedAt: Date.now(),
  }
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
    if (number === 1 || number === 12) {
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
      const exe = await binary('semgrep', c)
      step.version = (
        await checked([exe, '--version'], c.root, c)
      ).stdout.trim()
      step.scope =
        'p/default + p/security-audit + p/secrets; Community Edition rules'
      result = await auditCommand(
        [
          exe,
          'scan',
          '--config',
          'p/default',
          '--config',
          'p/security-audit',
          '--config',
          'p/secrets',
          '--metrics',
          'off',
          '--json',
          c.source,
        ],
        c.source,
        c,
        { sandbox: true },
      )
    }
    if (number === 7) {
      step.tool = 'codeql'
      if (!c.settings.codeqlLicensed)
        throw Error(
          'CodeQL利用条件の確認が未設定です（codeqlLicensed）。未実施として記録します。',
        )
      const exe = await binary('codeql', c)
      step.version = String(
        JSON.parse(
          (await checked([exe, 'version', '--format=json'], c.root, c)).stdout,
        ).version,
      )
      const all: string[] = []
      const walk = (p: string) => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(p, e.name))
          else all.push(e.name)
        }
      }
      walk(c.source)
      const supported = [
        ['javascript-typescript', /\.[cm]?[jt]sx?$/],
        ['python', /\.py$/],
        ['go', /\.go$/],
        ['java-kotlin', /\.(?:java|kt)$/],
        ['csharp', /\.cs$/],
        ['cpp', /\.(?:c|cc|cpp|h|hpp)$/],
        ['ruby', /\.rb$/],
        ['swift', /\.swift$/],
      ] as const
      const langs = supported
        .filter(([, pattern]) => all.some((n) => pattern.test(n)))
        .map(([name]) => name)
      if (!langs.length) throw Error('CodeQL対応言語がありません')
      step.scope =
        langs
          .map(
            (lang) =>
              `${lang} (build-mode=${['go', 'swift'].includes(lang) ? 'autobuild' : 'none'})`,
          )
          .join(', ') + '; security-and-quality query suites'
      for (const lang of langs) {
        const db = join(c.root, `codeql-${lang}`),
          sarif = join(c.root, `codeql-${lang}.sarif`),
          pack =
            lang === 'javascript-typescript'
              ? 'javascript'
              : lang === 'java-kotlin'
                ? 'java'
                : lang
        await checked(
          [
            exe,
            'database',
            'create',
            db,
            '--language',
            lang,
            '--source-root',
            c.source,
            '--build-mode',
            ['go', 'swift'].includes(lang) ? 'autobuild' : 'none',
          ],
          c.root,
          c,
          { sandbox: true },
        )
        result = await checked(
          [
            exe,
            'database',
            'analyze',
            db,
            `codeql/${pack}-queries:codeql-suites/${pack}-security-and-quality.qls`,
            '--download',
            '--format=sarif-latest',
            `--output=${sarif}`,
          ],
          c.root,
          c,
          { sandbox: true },
        )
        step.findings.push(
          ...scannerFindings('codeql', JSON.parse(readFileSync(sarif, 'utf8'))),
        )
      }
    }
    if (number === 8) {
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
    if (number === 9) {
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
      if (existsSync(output))
        step.findings.push(
          ...scannerFindings(
            'gitleaks',
            JSON.parse(readFileSync(output, 'utf8')),
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
        if (existsSync(path))
          step.findings.push(
            ...scannerFindings(
              'gitleaks',
              JSON.parse(readFileSync(path, 'utf8')),
            ),
          )
        if (r.exitCode > 1) throw Error('Gitleaks history scan failed')
      } else {
        step.note = 'Git履歴を取得できませんでした。ディレクトリ検査のみ。'
        step.status = 'unavailable'
      }
    }
    if (number === 10) {
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
      result = await auditCommand(
        [
          exe,
          'scan',
          'create',
          '--org',
          c.settings.socketOrg,
          '--repo',
          `audit-${createHash('sha256').update(c.repo).digest('hex').slice(0, 16)}`,
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
      const created = JSON.parse(result.stdout),
        scanId = created.ok === true ? created.data?.id : undefined
      if (typeof scanId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(scanId))
        throw Error('Socket scan ID unavailable')
      step.note = `Socket scan: ${scanId}`
      result = await auditCommand(
        [
          exe,
          'scan',
          'report',
          scanId,
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
    if (number === 11) {
      step.tool = 'zap'
      if (!c.settings.targetUrl) throw Error('本番/検査対象URLが未指定です')
      const target = new URL(c.settings.targetUrl)
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
        if (c.settings.authentication !== 'none') {
          authenticated = existsSync(join(zapDir, 'auth-confirmed'))
          step.note += authenticated
            ? '\nZAP自身が認証probeの期待応答を確認しました。全ページの認証維持は保証しません。'
            : '\nZAP経由の認証probeを確認できませんでした。公開検査の結果だけを保持します。'
        }
        const report = join(zapDir, 'report.json')
        if (!existsSync(report)) throw Error('ZAP report unavailable')
        step.findings = scannerFindings(
          'zap',
          JSON.parse(readFileSync(report, 'utf8')),
        )
      } finally {
        await cleanupAuditZap(c)
        rmSync(zapDir, { recursive: true, force: true })
      }
      for (const v of cookies) {
        result.stdout = result.stdout.replaceAll(v.value, '[認証情報を除去]')
        result.stderr = result.stderr.replaceAll(v.value, '[認証情報を除去]')
      }
      if (!authenticated) step.status = 'unavailable'
    }
    if (!result) throw Error('unsupported audit step')
    step.exitCode = result.exitCode
    step.evidenceDigest = createHash('sha256')
      .update(result.stdout)
      .digest('hex')
    if (number === 6) {
      try {
        const data = JSON.parse(result.stdout)
        step.findings.push(...scannerFindings(step.tool, data))
        if (
          number === 6 &&
          (data.errors?.length || data.paths?.skipped?.length)
        ) {
          step.note += `\nSemgrep errors: ${data.errors?.length ?? 0}; skipped: ${data.paths?.skipped?.length ?? 0}`
          step.status = 'unavailable'
        }
      } catch {
        throw Error('scanner structured output is invalid')
      }
    }
    if (number === 10) {
      const data = JSON.parse(result.stdout)
      step.findings.push(...scannerFindings('socket', data))
      step.note += `\nScan: ${auditClean(String(data.data?.scanId ?? 'unavailable'))}; healthy=${data.data?.healthy}`
    }
    const accepted =
      number === 11 ? [0, 1, 2] : [5, 9, 10].includes(number) ? [0, 1] : [0]
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
    if (number === 9) {
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
