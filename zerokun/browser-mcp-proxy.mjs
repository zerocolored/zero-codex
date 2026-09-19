import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Redact at the MCP boundary, not after Codex has received (and persisted) it.
// This does not inspect cookies or change any URL in the user's browser.
const sensitiveKey = /(?:token|secret|password|passwd|signature|credential|assertion|authorization|api.?key|access.?key)|^(?:code|state|session_state|nonce|code_verifier|device_code|SAMLResponse|SAMLRequest|RelayState|jwt|otp|oobCode|sig|ticket|key)$/i
function redactJwtCandidate(candidate) {
  const parts = candidate.split('.')
  if (parts.length < 3) return candidate
  // Splitting once avoids retrying a long candidate at every '-eyJ'. A token
  // followed by punctuation (or a JWE suffix) is still authentication data.
  if (/(?:^|-)eyJ[A-Za-z0-9_-]*$/.test(parts[0])
    && /^[A-Za-z0-9_-]+$/.test(parts[1])) return '[authentication value omitted]'
  return candidate
}

function decoded(value) {
  for (let i = 0; i < 4; i++) {
    try {
      const next = decodeURIComponent(value)
      if (next === value) break
      value = next
    } catch { break }
  }
  return value
}

function secretFragment(value, depth) {
  const route = value.startsWith('/') ? value.indexOf('?') : -1
  return secretParameters(route >= 0 ? value.slice(route + 1) : value, depth)
}

function secretParameters(value, depth = 0) {
  if (!value) return false
  if (depth > 8) return true
  // Parse BEFORE decoding values: an embedded URL's ?/& must not change the
  // outer parameter boundaries or hide earlier/later parameters.
  const params = new URLSearchParams(value)
  return [...params].some(([key, val]) => {
    if (sensitiveKey.test(decoded(key))) return true
    const inner = decoded(val)
    // Decoding a nested URL can introduce spaces inside a harmless value.
    // Inspect assignments independently so a later secret is not truncated,
    // including relative callback paths and hashbang routes.
    for (const match of inner.matchAll(/(?:^|[?&#])([^\s=?&#"'<>`\\]{1,256})=/g)) {
      if (sensitiveKey.test(decoded(match[1]))) return true
    }
    for (const match of inner.matchAll(/https?:\/\/[^\s<>"'`\\]+/gi)) {
      try {
        const url = new URL(match[0])
        if (url.username || url.password
          || secretParameters(url.search.slice(1), depth + 1)
          || secretFragment(url.hash.slice(1), depth + 1)) return true
      } catch { return true }
    }
    return false
  })
}

export function redactBrowserText(text, depth = 0) {
  if (depth > 64) throw new Error('Browser response nesting limit exceeded')
  // JSON is frequently nested inside content[].text. Parse it first so escaped
  // slashes and unicode query separators cannot bypass URL parsing.
  if (/^\s*[\[{]/.test(text)) {
    let parsed
    try { parsed = JSON.parse(text) } catch { /* plain text */ }
    if (parsed !== undefined) return JSON.stringify(redactBrowserValue(parsed, depth + 1))
  }
  return text.replace(/https?:\/\/[^\s<>"'`\\]+/gi, raw => {
    try {
      const url = new URL(raw)
      const auth = !!url.username || !!url.password
      const query = secretParameters(url.search.slice(1))
      const fragment = secretFragment(url.hash.slice(1), 0)
      if (!auth && !query && !fragment) return raw
      url.username = ''
      url.password = ''
      // Preserve ordinary navigation parameters, but never publish a partial
      // signed/authentication URL when any of its parameters are sensitive.
      if (query) url.search = ''
      if (fragment) url.hash = ''
      return url.href
    } catch { return '[invalid browser URL omitted]' }
  })
    // Chrome can use a scheme-less/truncated URL as the tab title. That is not
    // parseable as a URL, but query assignments still must not expose values.
    .replace(/([?&#])([^\s=?&#"'<>`\\]{1,256})=([^\s&#"'<>`\\]*)/g, (whole, delimiter, key, value) => (
      sensitiveKey.test(decoded(key).replace(/^amp;/, '')) || secretParameters(`${key}=${value}`)
        ? `${delimiter}${key}=[authentication value omitted]` : whole
    ))
    .replace(/[A-Za-z0-9_.-]+/g, redactJwtCandidate)
}

export function redactBrowserValue(value, depth = 0) {
  if (depth > 64) throw new Error('Browser response nesting limit exceeded')
  if (typeof value === 'string') return redactBrowserText(value, depth)
  if (Array.isArray(value)) return value.map(item => redactBrowserValue(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactBrowserText(key, depth), redactBrowserValue(item, depth + 1),
    ]))
  }
  return value
}

export function runBrowserProxy(entrypoint) {
  const child = spawn(process.execPath, [entrypoint], {
    stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  })
  let buffer = ''
  let closing = false
  let draining = false
  let timer
  const signalChild = signal => {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal) } catch { /* already gone */ }
  }
  const close = () => {
    if (closing) return
    closing = true
    if (timer) clearTimeout(timer)
    process.stdin.unpipe(child.stdin)
    process.stdin.pause()
    child.stdin.destroy()
    signalChild('SIGTERM')
    timer = setTimeout(() => signalChild('SIGKILL'), 1500)
    timer.unref()
  }
  const invalid = () => {
    process.stderr.write('Browser MCP returned an invalid response; raw output was withheld.\n')
    process.exitCode = 1
    close()
  }
  process.stdin.pipe(child.stdin)
  const drainAndClose = () => {
    if (closing || draining) return
    draining = true
    process.stdin.unpipe(child.stdin)
    process.stdin.pause()
    // EOF is graceful: let in-flight responses flush before escalating.
    child.stdin.end()
    timer = setTimeout(close, 1500)
    timer.unref()
  }
  process.stdin.on('end', drainAndClose)
  child.stdin.on('error', drainAndClose)
  // Diagnostics can include callback URLs. Never relay the raw child stderr.
  child.stderr.resume()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    if (closing) return
    buffer += chunk
    if (buffer.length > 64 * 1024 * 1024) { invalid(); return }
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          invalid(); return
        }
        // Routing IDs/methods are protocol identity, not browser content.
        const safe = { ...message }
        for (const field of ['result', 'error', 'params']) {
          if (field in safe) safe[field] = redactBrowserValue(safe[field])
        }
        if (!process.stdout.write(JSON.stringify(safe) + '\n')) {
          child.stdout.pause()
          process.stdout.once('drain', () => child.stdout.resume())
        }
      } catch { invalid(); return }
    }
  })
  child.on('error', () => {
    process.stderr.write('Browser MCP could not be started.\n')
    process.exitCode = 1
    close()
  })
  child.on('close', code => {
    // The direct child can exit on TERM while a same-group descendant ignores
    // it and has already closed its pipes. Do not cancel its final cleanup.
    if (closing) signalChild('SIGKILL')
    if (timer) clearTimeout(timer)
    process.stdin.unpipe(child.stdin)
    process.stdin.destroy()
    if (buffer.trim() && !closing) process.exitCode = 1
    if (code && !closing) process.exitCode = code
  })
  process.stdout.on('error', close)
  process.on('SIGTERM', close)
  process.on('SIGINT', close)
  process.on('SIGHUP', close)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    process.stderr.write('Usage: browser-mcp-proxy.mjs <browser entrypoint>\n')
    process.exitCode = 2
  } else runBrowserProxy(process.argv[2])
}
