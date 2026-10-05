import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { browserDialogCompatibility } from './browser-dialog-compat.ts'
import { homedir } from 'os'
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'path'

/** Use the service selected by this process, never a version remembered by a thread. */
function installedBrowserRuntime(
  overrides: string[], projectRoot: string,
  codexHome: string,
  stagedRoot?: string,
): { client: string; service: string; family: string } | undefined {
  try {
    const config = Bun.TOML.parse(overrides.join('\n')) as any
    if (config.features?.plugins !== true || config.features?.browser_use !== true) return
    const chrome = config.features.browser_use_external === true
      && config.plugins?.['chrome@openai-bundled']?.enabled === true
    const browser = config.features.in_app_browser === true
      && config.plugins?.['browser@openai-bundled']?.enabled === true
    const server = config.mcp_servers?.node_repl
    if ((!chrome && !browser) || server?.enabled !== true) return
    const service = JSON.parse(server.env?.NODE_REPL_TRUSTED_SERVICES ?? '{}').browser
    if (typeof service !== 'string' || !isAbsolute(service)) return
    const staged = stagedRoot && service === join(stagedRoot, 'scripts/browser-service.mjs')
    const home = staged ? realpathSync(stagedRoot) : realpathSync(codexHome)
    const cache = join(home, 'plugins/cache/openai-bundled')
    const parts = relative(cache, service).split(sep)
    if (!staged && (parts.length !== 4 || !['chrome', 'browser'].includes(parts[0]!)
      || !parts[1] || parts[1] === '..' || parts[2] !== 'scripts'
      || parts[3] !== 'browser-service.mjs')) return
    const client = join(dirname(service), 'browser-client.mjs')
    const contains = (parent: string, child: string) => {
      const path = relative(parent, child)
      return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
    }
    const project = realpathSync(projectRoot)
    const runtimeRoot = staged ? home : cache
    if (contains(project, runtimeRoot) || contains(runtimeRoot, project)) return
    // Only describe the host-selected installation or its job-owned copy.
    for (const file of [service, client]) {
      let current = home
      for (const part of ['', ...relative(home, file).split(sep)]) {
        if (part) current = join(current, part)
        const info = lstatSync(current)
        if (info.isSymbolicLink() || realpathSync(current) !== current
          || (info.uid !== 0 && info.uid !== process.getuid?.()) || (info.mode & 0o022) !== 0
          || (current === file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) return
      }
    }
    return { client, service, family: staged ? home : join(cache, parts[0]!) }
  } catch { return undefined }
}

function toml(value: any): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
  return `{${Object.entries(value).filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(',')}}`
}

/** Stage public distribution code outside private agent state. Native review's
 * denied-path summary omits reopened children of CODEX_HOME on resumed turns.
 * Keep private state denied and give this job a read-only runtime copy instead.
 */
export function stageBrowserRuntime(
  overrides: string[], profile: string, projectRoot: string, destination: string,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  onCreated?: (cleanup: () => void) => void,
): string[] {
  const runtime = installedBrowserRuntime(overrides, projectRoot, codexHome)
  if (!runtime) return overrides
  const config = Bun.TOML.parse(overrides.join('\n')) as any
  const filesystem = config.permissions?.[profile]?.filesystem
  if (filesystem?.[runtime.family] !== 'read') return overrides
  const distribution = dirname(dirname(runtime.service))
  if (Object.entries(filesystem).some(([path, access]) => access !== 'read'
    && path.startsWith(runtime.family + sep)
    && (distribution === path || distribution.startsWith(path + sep)
      || path.startsWith(distribution + sep)))) return overrides
  const parent = dirname(destination)
  // Public code must not inherit a private-state denial, nor be writable by
  // sibling jobs through their ordinary project/temp permissions.
  const ancestors = Object.entries(filesystem).filter(([path]) => isAbsolute(path)
    && (destination === path || destination.startsWith(path + sep)))
    .sort(([a], [b]) => b.length - a.length)
  if ((ancestors[0]?.[1] ?? filesystem[':root']) !== 'read') return overrides
  let created = false
  try {
    if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 })
    if (realpathSync(parent) !== parent || lstatSync(parent).uid !== process.getuid?.()
      || (lstatSync(parent).mode & 0o077) !== 0 || existsSync(destination)) return overrides
    mkdirSync(destination, { mode: 0o700 }); created = true
    const identity = lstatSync(destination)
    onCreated?.(() => {
      try {
        if (!existsSync(destination)) return
        const current = lstatSync(destination)
        if (!current.isDirectory() || current.isSymbolicLink()
          || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('runtime identity changed')
        rmSync(destination, { recursive: true, force: true })
      } catch { process.stderr.write('zerochan: public browser runtime cleanup incomplete\n') }
    })
    // These are shipped code/documentation/assets, not profiles, sessions,
    // credentials, user skills, or operator configuration.
    for (const name of ['scripts', 'docs', 'assets', 'node_modules']) {
      const source = join(distribution, name)
      if (!existsSync(source)) continue
      cpSync(source, join(destination, name), {
        recursive: true, dereference: false, errorOnExist: true, force: false,
        filter(path) {
          const info = lstatSync(path)
          if (info.isSymbolicLink() || realpathSync(path) !== path
            || (info.uid !== 0 && info.uid !== process.getuid?.()) || (info.mode & 0o022) !== 0
            || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw new Error('unsafe browser distribution entry')
          return true
        },
      })
    }
    const servicePath = join(destination, 'scripts/browser-service.mjs')
    try {
      const compatibility = browserDialogCompatibility(readFileSync(servicePath, 'utf8'))
      if (compatibility.applied) {
        // Replace atomically: a read-only shipped file is valid, and failed
        // compatibility writes must not discard or truncate the staged code.
        const temporary = `${servicePath}.${randomUUID()}`
        let fd: number | undefined, created = false
        try {
          fd = openSync(temporary, 'wx', 0o600); created = true
          writeFileSync(fd, compatibility.source)
          closeSync(fd); fd = undefined
          renameSync(temporary, servicePath)
        } finally {
          if (fd !== undefined) closeSync(fd)
          if (created) rmSync(temporary, { force: true })
        }
      } else process.stderr.write('zerochan: browser dialog compatibility not applicable to this runtime; official implementation retained\n')
    } catch {
      process.stderr.write('zerochan: browser dialog compatibility unavailable; staged transport retained\n')
    }
    const server = config.mcp_servers.node_repl
    const services = JSON.parse(server.env.NODE_REPL_TRUSTED_SERVICES)
    services.browser = join(destination, 'scripts/browser-service.mjs')
    const updated = { ...config.mcp_servers, node_repl: { ...server, env: { ...server.env,
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify(services),
      NODE_REPL_TRUSTED_CODE_PATHS: [server.env.NODE_REPL_TRUSTED_CODE_PATHS, join(destination, 'scripts')].filter(Boolean).join(delimiter),
    } } }
    const key = `permissions.${profile}.filesystem=`
    return overrides.map(value => value.startsWith('mcp_servers=') ? `mcp_servers=${toml(updated)}`
      : value.startsWith(key + '{') && value.endsWith('}')
        ? value.slice(0, -1) + `,${JSON.stringify(destination)}="read"}` : value)
  } catch {
    if (created) rmSync(destination, { recursive: true, force: true })
    process.stderr.write('zerochan: browser runtime staging unavailable; existing transport retained\n')
    return overrides
  }
}

export function browserRuntimeContext(
  overrides: string[], projectRoot: string,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  stagedRoot?: string,
): string {
  const runtime = installedBrowserRuntime(overrides, projectRoot, codexHome, stagedRoot)
  if (!runtime) return ''
  const { client, service } = runtime
  const config = Bun.TOML.parse(overrides.join('\n')) as any
  const filesystem = config.permissions?.[config.default_permissions]?.filesystem
  if (filesystem?.[client] === 'deny' || filesystem?.[service] === 'deny') return ''
  return [
      '', 'Current official Browser/Chrome runtime (resolved for this execution):',
      `Browser client module: ${JSON.stringify(client)}`,
      'This is host-provided runtime code. Use its existing read-only permission; do not',
      'modify the runtime or inspect private agent state, credentials, or browser profiles.',
      'This path matches the browser service configured for this process and supersedes',
      'versioned browser-client imports in resumed history. Do not reuse an older cache path.',
      'Follow the current installed browser instructions. If no skill is listed, bootstrap',
      'through node_repl with the returned handle (setup does not create a global agent):',
      `const { setupBrowserRuntime } = await import(${JSON.stringify(client)});`,
      'const agent = await setupBrowserRuntime();',
      'Select the requested browser through agent.browsers.get(), then read that',
      'browser.documentation() before operating it. Reuse working handles.',
      'For browser screenshots, emit one PNG or JPEG per node_repl call using nodeRepl.emitImage().',
      'The host captures up to four emitted images, validates them, and attaches them to Slack.',
      'These emitted images need no filesystem save or zerokun_files declaration from you.',
      'Do not write screenshot bytes into private state, outbox, or scratch to deliver them.',
      'If image emission fails, report the error; do not claim an image was delivered.',
      'A missing old module is not evidence of lost browser login. If an old import fails,',
      'use the current module above before declaring Chrome unavailable. If the current',
      'module or its service disappeared during this execution, report that concrete error;',
      'do not restore old plugin files, change trust settings, or ask for a website relogin.',
      'Preserve website approvals, explicit browser selection, and native permission decisions.',
      'Inspect the destination and previous effects before retrying any external write.',
      'A click can open a JavaScript dialog before the click response times out. On a click',
      'timeout, inspect that exact tab with getJsDialog() before repeating the click or',
      'switching to app-wide Computer Use. Handle an observed dialog only when the user',
      'authorized its effect, then verify the target page. A timeout is not proof of rejection.',
      'If a previous execution already lost its connection behind a dialog, a whole-app',
      'read denial does not prohibit a narrower read of the authorized site. When supported,',
      'open a fresh tab at the same previously observed URL and inspect saved state there.',
      'Keep the original tab and unsaved work; do not replay publication or other writes',
      'until their previous effects and the intended saved content have been verified.',
  ].join('\n')
}
