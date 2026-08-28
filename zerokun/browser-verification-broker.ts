#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { randomUUID } from 'crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
} from 'fs'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'http'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  ensureManagedDirectory,
  requireManagedDirectory,
  requireManagedStateRoot,
} from './managed-path.ts'
import { captureTrackedProcesses, reapTrackedProcesses, seedTrackedProcess } from './process-tree.ts'
import { containsCredentialMaterial } from './public-output-guard.ts'
import { atomicWritePrivateFile } from './safe-file.ts'

const CHROME_APPLICATION = '/Applications/Google Chrome.app'
const CHROME_EXECUTABLE = `${CHROME_APPLICATION}/Contents/MacOS/Google Chrome`
const CHROME_IDENTIFIER = 'com.google.Chrome'
const CHROME_TEAM_IDENTIFIER = 'EQHXZ8M8AV'
const MAX_CONTEXT_BYTES = 256 * 1024
const MAX_HTTP_BYTES = 2 * 1024 * 1024
const MAX_BROWSER_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024
const SCREENSHOT_WIDTH = 1280
const SCREENSHOT_HEIGHT = 720
const SCREENSHOT_DEADLINE_MS = 30_000
const EXITED_SCREENSHOT_GRACE_MS = 2_000
const STREAM_FLUSH_GRACE_MS = 5_000

type BrowserContext = {
  version: 3
  jobId: string
  attemptNonce: string
  repoPath: string
  writeEnabled: boolean
}

export type LocalPageAddress = {
  url: URL
  origin: string
  port: number
}

export type PngDimensions = { width: number; height: number }

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function readBoundedPrivateFile(path: string, maximum: number): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(descriptor)
    const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.nlink !== 1 || !owned
      || (metadata.mode & 0o077) !== 0 || metadata.size > maximum) {
      throw new Error(`unsafe browser broker input file: ${path}`)
    }
    const bytes = Buffer.alloc(metadata.size)
    if (bytes.length > 0) readSync(descriptor, bytes, 0, bytes.length, 0)
    return bytes.toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

function parseContext(pathInput: string, stateDir: string): BrowserContext {
  if (!isAbsolute(pathInput)) throw new Error('browser context path must be absolute')
  const path = resolve(pathInput)
  if (!contained(stateDir, path)) throw new Error('browser context is outside managed state')
  let value: unknown
  try { value = JSON.parse(readBoundedPrivateFile(path, MAX_CONTEXT_BYTES)) } catch (error) {
    throw new Error(`browser context is invalid: ${error}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('browser context must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 3 || typeof record.jobId !== 'string' || record.jobId.length < 1
    || typeof record.attemptNonce !== 'string' || !/^[0-9a-f]{32}$/.test(record.attemptNonce)
    || typeof record.repoPath !== 'string' || !isAbsolute(record.repoPath)
    || typeof record.writeEnabled !== 'boolean') {
    throw new Error('browser context fields are invalid')
  }
  return {
    version: 3,
    jobId: record.jobId,
    attemptNonce: record.attemptNonce,
    repoPath: realpathSync(record.repoPath),
    writeEnabled: record.writeEnabled,
  }
}

export function parseLocalPageAddress(value: string): LocalPageAddress {
  if (!value || value.length > 2_048 || /[\0\r\n]/.test(value)
    || containsCredentialMaterial(value)) {
    throw new Error('local browser URL is empty or invalid')
  }
  let url: URL
  try { url = new URL(value) } catch {
    throw new Error('local browser URL is invalid')
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.hash || !url.port) {
    throw new Error('local browser URL must be an explicit localhost HTTP port without credentials or a fragment')
  }
  const port = Number(url.port)
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error('local browser URL port must be between 1024 and 65535')
  }
  return { url, origin: url.origin, port }
}

export function parsePngDimensions(bytes: Uint8Array): PngDimensions {
  const view = Buffer.from(bytes)
  const magic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (view.length < 33 || !view.subarray(0, 8).equals(magic)
    || view.readUInt32BE(8) !== 13 || view.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('browser screenshot is not a valid PNG header')
  }
  const width = view.readUInt32BE(16)
  const height = view.readUInt32BE(20)
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) {
    throw new Error('browser screenshot dimensions are invalid')
  }
  return { width, height }
}

function chromeExecutable(): string {
  const lexical = resolve(CHROME_EXECUTABLE)
  const metadata = lstatSync(lexical)
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o002) !== 0
    || (metadata.mode & 0o111) === 0) {
    throw new Error('Google Chrome executable is unsafe or unavailable')
  }
  const verification = Bun.spawnSync([
    // Verify the signed executable and its nested framework requirement. A
    // strict bundle-wide verification also rejects benign FinderInfo xattrs
    // added by macOS, even though the executable still satisfies Google's
    // designated requirement.
    '/usr/bin/codesign', '--verify', CHROME_EXECUTABLE,
  ], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
  if (verification.exitCode !== 0) throw new Error('Google Chrome code signature is invalid')
  const details = Bun.spawnSync([
    '/usr/bin/codesign', '-d', '--verbose=4', CHROME_APPLICATION,
  ], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000 })
  const output = `${details.stdout.toString()}\n${details.stderr.toString()}`
  if (details.exitCode !== 0 || !output.split(/\r?\n/).includes(`Identifier=${CHROME_IDENTIFIER}`)
    || !output.split(/\r?\n/).includes(`TeamIdentifier=${CHROME_TEAM_IDENTIFIER}`)) {
    throw new Error('Google Chrome signer identity is not trusted')
  }
  return realpathSync(lexical)
}

function localRequestOptions(address: LocalPageAddress, path: string, headers: IncomingHttpHeaders) {
  const selectedHeaders: Record<string, string> = {
    host: address.url.host,
    accept: typeof headers.accept === 'string' ? headers.accept : 'text/html,*/*;q=0.8',
    'accept-language': typeof headers['accept-language'] === 'string'
      ? headers['accept-language'] : 'ja,en;q=0.8',
    'accept-encoding': 'identity',
    'user-agent': typeof headers['user-agent'] === 'string'
      ? headers['user-agent'] : 'ZerochanLocalBrowser/1.0',
  }
  return {
    hostname: '127.0.0.1',
    port: address.port,
    path,
    method: 'GET',
    headers: selectedHeaders,
  }
}

async function readLocalHttpPage(address: LocalPageAddress): Promise<{
  status: number
  contentType: string
  body: string
}> {
  return await new Promise((resolvePromise, reject) => {
    const request = httpRequest(localRequestOptions(
      address, `${address.url.pathname}${address.url.search}`, {},
    ), response => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400) {
        response.resume()
        reject(new Error('local browser preflight does not follow redirects'))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      response.on('data', chunk => {
        const bytes = Buffer.from(chunk)
        total += bytes.length
        if (total > MAX_HTTP_BYTES) {
          request.destroy(new Error('local browser response exceeds the size limit'))
          return
        }
        chunks.push(bytes)
      })
      response.on('end', () => {
        if (status < 200 || status >= 300) {
          reject(new Error(`local browser preflight returned HTTP ${status}`))
          return
        }
        const rawContentType = response.headers['content-type']
        const contentType = Array.isArray(rawContentType)
          ? rawContentType.join(', ') : String(rawContentType ?? '')
        resolvePromise({ status, contentType, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.setTimeout(10_000, () => request.destroy(new Error('local browser preflight timed out')))
    request.on('error', reject)
    request.end()
  })
}

function responseHeaderValue(value: string | string[] | undefined): string | string[] | undefined {
  if (value === undefined) return undefined
  return value
}

async function startSameOriginProxy(address: LocalPageAddress): Promise<{
  server: Server
  port: number
  stats: () => { total: number; allowed: number; blocked: number }
}> {
  let totalRequests = 0
  let allowedRequests = 0
  let blockedRequests = 0
  const block = (socketOrResponse: { end: () => unknown }) => {
    blockedRequests += 1
    try { socketOrResponse.end() } catch {}
  }
  const server = createServer((incoming, outgoing) => {
    totalRequests += 1
    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
      outgoing.statusCode = 405
      block(outgoing)
      return
    }
    let requested: URL
    try { requested = new URL(incoming.url ?? '', address.origin) } catch {
      outgoing.statusCode = 400
      block(outgoing)
      return
    }
    if (requested.origin !== address.origin) {
      outgoing.statusCode = 403
      block(outgoing)
      return
    }
    allowedRequests += 1
    const forwarded = httpRequest(
      localRequestOptions(address, `${requested.pathname}${requested.search}`, incoming.headers),
      response => {
        const status = response.statusCode ?? 502
        const location = response.headers.location
        if (status >= 300 && status < 400 && location) {
          let redirect: URL
          try { redirect = new URL(location, requested) } catch {
            outgoing.statusCode = 502
            response.resume()
            block(outgoing)
            return
          }
          if (redirect.origin !== address.origin) {
            outgoing.statusCode = 502
            response.resume()
            block(outgoing)
            return
          }
        }
        outgoing.statusCode = status
        for (const header of [
          'cache-control', 'content-encoding', 'content-language', 'content-length',
          'content-security-policy', 'content-type', 'etag', 'expires', 'last-modified',
          'location', 'referrer-policy', 'vary', 'x-content-type-options',
        ]) {
          const value = responseHeaderValue(response.headers[header])
          if (value !== undefined) outgoing.setHeader(header, value)
        }
        response.pipe(outgoing)
      },
    )
    forwarded.setTimeout(10_000, () => forwarded.destroy(new Error('local proxy request timed out')))
    forwarded.on('error', () => {
      if (!outgoing.headersSent) outgoing.statusCode = 502
      outgoing.end()
    })
    forwarded.end()
  })
  server.on('connect', (_request, socket) => {
    totalRequests += 1
    block(socket)
  })
  server.on('upgrade', (_request, socket) => {
    totalRequests += 1
    block(socket)
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
  const listening = server.address()
  if (!listening || typeof listening === 'string') {
    server.close()
    throw new Error('local browser proxy did not bind a TCP port')
  }
  return {
    server,
    port: listening.port,
    stats: () => ({
      total: totalRequests,
      allowed: allowedRequests,
      blocked: blockedRequests,
    }),
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolvePromise, reject) => {
    server.close(error => error ? reject(error) : resolvePromise())
    server.closeAllConnections?.()
  })
}

async function collectStream(stream: ReadableStream<Uint8Array>, maximum: number): Promise<{
  text: string
  truncated: boolean
}> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const bytes = Buffer.from(chunk.value)
      if (total + bytes.length > maximum) {
        const remaining = Math.max(0, maximum - total)
        if (remaining > 0) chunks.push(bytes.subarray(0, remaining))
        total = maximum
        truncated = true
      } else {
        chunks.push(bytes)
        total += bytes.length
      }
    }
  } finally {
    reader.releaseLock()
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated }
}

async function captureChromeScreenshot(input: {
  chrome: string
  repoPath: string
  stateDir: string
  scratchDir: string
  artifactDir: string
  address: LocalPageAddress
  expectedText: string
}): Promise<{
  screenshotPath: string
  width: number
  height: number
  renderedTextMatched: true
  browserForcedCleanup: boolean
  blockedRequestCount: number
  allowedRequestCount: number
  totalRequestCount: number
}> {
  const runRoot = ensureManagedDirectory(
    input.stateDir,
    join(input.scratchDir, `browser-${randomUUID().replaceAll('-', '')}`),
  )
  const runMetadata = lstatSync(runRoot)
  const profile = ensureManagedDirectory(input.stateDir, join(runRoot, 'profile'))
  const temporaryScreenshot = join(runRoot, 'screenshot.png')
  const proxy = await startSameOriginProxy(input.address)
  let browserForcedCleanup = false
  try {
    let resolveExit!: (value: number) => void
    const exited = new Promise<number>(resolvePromise => { resolveExit = resolvePromise })
    const child = Bun.spawn([
      input.chrome,
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-background-networking',
      '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync',
      '--hide-scrollbars', '--metrics-recording-only', '--mute-audio', '--no-first-run',
      '--safebrowsing-disable-auto-update', '--force-device-scale-factor=1',
      `--user-data-dir=${profile}`,
      `--window-size=${SCREENSHOT_WIDTH},${SCREENSHOT_HEIGHT}`,
      '--dump-dom',
      `--screenshot=${temporaryScreenshot}`,
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      // Keep the exact verified origin direct. Chrome's implicit loopback
      // bypass is first removed, then restored only for this host and port;
      // every external origin and every other loopback port still reaches
      // the deny-by-default proxy.
      `--proxy-bypass-list=<-loopback>;${input.address.url.hostname}:${input.address.port}`,
      input.address.url.toString(),
    ], {
      cwd: input.repoPath,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: runRoot,
        TMPDIR: runRoot,
        LANG: 'en_US.UTF-8',
      },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      detached: process.platform !== 'win32',
      onExit(_process, exitCode, signalCode) {
        resolveExit(exitCode ?? (signalCode ? 128 : 1))
      },
    })
    const tracked = new Map<number, string>()
    try {
      const rootIdentity = seedTrackedProcess(child.pid, tracked)
      if (process.platform !== 'win32' && rootIdentity.pgid !== rootIdentity.pid) {
        throw new Error('local browser process group is not isolated')
      }
    } catch (error) {
      try { child.kill('SIGKILL') } catch {}
      await Promise.race([exited.catch(() => 1), Bun.sleep(1_000)])
      throw error
    }
    const stdout = collectStream(child.stdout, MAX_BROWSER_OUTPUT_BYTES)
    const stderr = collectStream(child.stderr, MAX_BROWSER_OUTPUT_BYTES)
    let tracking = true
    let trackingError: unknown
    const tracker = (async () => {
      try {
        while (tracking) {
          captureTrackedProcesses([child.pid], child.pid, tracked)
          await Bun.sleep(25)
        }
      } catch (error) {
        trackingError = error
      }
    })()
    const deadline = Date.now() + SCREENSHOT_DEADLINE_MS
    let screenshotReady = false
    let stableSize = -1
    let stableObservations = 0
    let rootExitObservedAt: number | undefined
    let rootExitCode: number | undefined
    let monitorError: unknown
    try {
      while (Date.now() < deadline) {
        if (existsSync(temporaryScreenshot)) {
          const metadata = lstatSync(temporaryScreenshot)
          if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
            && metadata.size > 32 && metadata.size <= MAX_SCREENSHOT_BYTES) {
            if (metadata.size === stableSize) stableObservations += 1
            else {
              stableSize = metadata.size
              stableObservations = 1
            }
            if (stableObservations >= 3) {
              screenshotReady = true
              break
            }
          }
        }
        if (rootExitObservedAt === undefined) {
          const outcome = await Promise.race([
            exited.then(exitCode => ({ kind: 'exit' as const, exitCode })),
            Bun.sleep(100).then(() => ({ kind: 'wait' as const })),
          ])
          if (outcome.kind === 'exit') {
            rootExitObservedAt = Date.now()
            rootExitCode = outcome.exitCode
          }
        } else {
          // On macOS the root process can finish before a tracked helper has
          // completed the asynchronous screenshot write. Preserve a bounded
          // grace period before reaping the exact isolated process group.
          if (Date.now() - rootExitObservedAt >= EXITED_SCREENSHOT_GRACE_MS) break
          await Bun.sleep(100)
        }
      }
      // Chrome writes the PNG atomically before its --dump-dom stdout has
      // necessarily drained. Prefer a natural exit and keep a bounded flush
      // window before terminating an otherwise long-lived helper group.
      if (screenshotReady) {
        await Promise.race([exited.catch(() => 1), Bun.sleep(STREAM_FLUSH_GRACE_MS)])
      }
    } catch (error) {
      monitorError = error
    } finally {
      tracking = false
      await tracker
      const remaining = await reapTrackedProcesses({
        rootPids: [child.pid],
        groupId: child.pid,
        tracked,
        termGraceMs: 2_000,
        killWaitMs: 1_000,
        onForce: () => { browserForcedCleanup = true },
      })
      if (remaining.length > 0) {
        throw new Error(`local browser descendants remain: ${remaining.join(', ')}`)
      }
    }
    if (trackingError) throw new Error(`local browser tracking failed: ${trackingError}`)
    if (monitorError) throw monitorError
    const [stdoutResult, stderrResult] = await Promise.all([stdout, stderr])
    if (!screenshotReady) {
      const diagnosticSource = `${stdoutResult.text}\n${stderrResult.text}`
      const diagnostics = [
        'ERR_PROXY_CONNECTION_FAILED', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_REFUSED',
        'profile in use', 'ProcessSingleton', 'Trace/breakpoint trap',
      ].filter(marker => diagnosticSource.includes(marker)).join(',') || 'none'
      throw new BrowserScreenshotTimeoutError(
        'local browser did not produce a screenshot before timeout '
        + `(exit=${rootExitCode ?? 'running'}, diagnostics=${diagnostics})`,
      )
    }
    if (stdoutResult.truncated || stderrResult.truncated) {
      throw new Error('local browser output exceeded the size limit')
    }
    if (containsCredentialMaterial(stdoutResult.text)) {
      throw new Error('local browser rendered DOM contains protected credential material')
    }
    if (!stdoutResult.text.includes(input.expectedText)) {
      const diagnostics = [
        'ERR_PROXY_CONNECTION_FAILED', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_REFUSED',
        'chrome://new-tab-page', 'about:blank',
      ].filter(marker => stdoutResult.text.includes(marker)).join(',') || 'none'
      throw new Error(
        'local browser rendered DOM did not contain the expected text '
        + `(stdout-bytes=${Buffer.byteLength(stdoutResult.text)}, blocked=${proxy.stats().blocked}, diagnostics=${diagnostics})`,
      )
    }
    const proxyStats = proxy.stats()
    const screenshotBytes = readFileSync(temporaryScreenshot)
    if (screenshotBytes.length > MAX_SCREENSHOT_BYTES) {
      throw new Error('local browser screenshot exceeds the size limit')
    }
    const dimensions = parsePngDimensions(screenshotBytes)
    if (dimensions.width !== SCREENSHOT_WIDTH || dimensions.height !== SCREENSHOT_HEIGHT) {
      throw new Error('local browser screenshot dimensions do not match the fixed viewport')
    }
    const screenshotName = `browser-${Date.now()}-${randomUUID().slice(0, 8)}.png`
    const screenshotPath = join(input.artifactDir, screenshotName)
    if (existsSync(screenshotPath)) throw new Error('local browser screenshot path already exists')
    atomicWritePrivateFile(screenshotPath, screenshotBytes)
    chmodSync(screenshotPath, 0o600)
    return {
      screenshotPath,
      ...dimensions,
      renderedTextMatched: true,
      browserForcedCleanup,
      blockedRequestCount: proxyStats.blocked,
      allowedRequestCount: proxyStats.allowed,
      totalRequestCount: proxyStats.total,
    }
  } finally {
    let closeError: unknown
    try { await closeServer(proxy.server) } catch (error) { closeError = error }
    try {
      const current = lstatSync(runRoot)
      if (!current.isDirectory() || current.isSymbolicLink()
        || current.dev !== runMetadata.dev || current.ino !== runMetadata.ino
        || !contained(input.scratchDir, runRoot)) {
        throw new Error('local browser runtime directory changed before cleanup')
      }
      rmSync(runRoot, { recursive: true, force: false })
    } catch (error) {
      throw new Error(`local browser runtime cleanup failed: ${error}`)
    }
    if (closeError) throw new Error(`local browser proxy cleanup failed: ${closeError}`)
  }
}

class BrowserScreenshotTimeoutError extends Error {
  override name = 'BrowserScreenshotTimeoutError'
}

export async function verifyLocalPage(input: {
  repoPath: string
  stateDir: string
  scratchDir: string
  artifactDir: string
  url: string
  expectedText: string
}) {
  if (!input.expectedText || input.expectedText.length > 512 || /[\0\r\n]/.test(input.expectedText)
    || containsCredentialMaterial(input.expectedText)) {
    throw new Error('expected browser text is empty or invalid')
  }
  const address = parseLocalPageAddress(input.url)
  const http = await readLocalHttpPage(address)
  if (containsCredentialMaterial(http.body)) {
    throw new Error('local HTTP response contains protected credential material')
  }
  if (!http.body.includes(input.expectedText)) {
    throw new Error('local HTTP response did not contain the expected text')
  }
  const chrome = chromeExecutable()
  let browser: Awaited<ReturnType<typeof captureChromeScreenshot>>
  let browserRetryCount = 0
  try {
    browser = await captureChromeScreenshot({ ...input, address, chrome })
  } catch (error) {
    if (!(error instanceof BrowserScreenshotTimeoutError)) throw error
    // Chrome can occasionally stall while initializing a brand-new profile.
    // Retry exactly once with another owner-only profile after the first
    // isolated process group and proxy have been fully cleaned up.
    browserRetryCount = 1
    browser = await captureChromeScreenshot({ ...input, address, chrome })
  }
  return {
    complete: true,
    http: { status: http.status, contentType: http.contentType },
    renderedTextMatched: browser.renderedTextMatched,
    screenshotPath: browser.screenshotPath,
    viewport: { width: browser.width, height: browser.height },
    browserForcedCleanup: browser.browserForcedCleanup,
    browserRetryCount,
    // Chrome may attempt updater/telemetry origins even with background
    // networking disabled. The same-origin proxy rejects every such request;
    // the count is containment evidence, not an application failure signal.
    blockedCrossOriginRequestCount: browser.blockedRequestCount,
    proxiedSameOriginRequestCount: browser.allowedRequestCount,
    totalProxyRequestCount: browser.totalRequestCount,
  }
}

function toolText(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  }
}

async function main(): Promise<void> {
  const [contextInput, stateInput, artifactInput, scratchInput, phaseInput] = process.argv.slice(2)
  if (!contextInput || !stateInput || !artifactInput || !scratchInput
    || !['implementation', 'review', 'complete'].includes(phaseInput ?? '')) {
    throw new Error(
      'usage: browser-verification-broker.ts CONTEXT STATE_DIR ARTIFACT_DIR SCRATCH_DIR [implementation|review|complete]',
    )
  }
  const stateDir = requireManagedStateRoot(stateInput)
  const context = parseContext(contextInput, stateDir)
  if (!context.writeEnabled) throw new Error('local browser verification requires a write-authorized job')
  const safeId = context.jobId.replace(/[^A-Za-z0-9._-]/g, '_')
  const artifactDir = requireManagedDirectory(stateDir, artifactInput)
  const scratchDir = requireManagedDirectory(stateDir, scratchInput)
  if (artifactDir !== realpathSync(join(stateDir, 'outbox', safeId))
    || scratchDir !== realpathSync(join(stateDir, 'tmp', safeId))) {
    throw new Error('local browser directories do not match the bound job')
  }
  const server = new McpServer({ name: 'zerochan-browser-verifier', version: '1.0.0' })
  server.registerTool('verify_local_page', {
    description: 'Verify an already-running localhost web page in a fresh signed Google Chrome profile. Only the exact loopback origin is reachable. Returns HTTP, rendered-DOM, fixed-viewport PNG, blocked-request, and cleanup evidence.',
    inputSchema: {
      url: z.string().max(2_048).describe('Exact http://127.0.0.1:<port>/ or http://localhost:<port>/ URL.'),
      expectedText: z.string().min(1).max(512).describe('Text that must appear in both the HTTP response and Chrome-rendered DOM.'),
    },
  }, async ({ url, expectedText }) => {
    try {
      return toolText(await verifyLocalPage({
        repoPath: context.repoPath,
        stateDir,
        scratchDir,
        artifactDir,
        url,
        expectedText,
      }))
    } catch (error) {
      return toolText({ complete: false, reason: String(error) }, true)
    }
  })
  await server.connect(new StdioServerTransport())
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`Zeroちゃん browser verifier: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
