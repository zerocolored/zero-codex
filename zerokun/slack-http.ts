import type { IncomingMessage } from 'http'
import { request as httpsRequest } from 'https'

export const DEFAULT_SLACK_HTTP_TIMEOUT_MS = 120_000

export function slackHttpTimeoutMs(value = process.env.ZEROKUN_SLACK_HTTP_TIMEOUT_MS): number {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed >= 100 ? parsed : DEFAULT_SLACK_HTTP_TIMEOUT_MS
}

export function slackWebClientOptions(timeout = slackHttpTimeoutMs()): {
  timeout: number
  retryConfig: { retries: number }
} {
  return { timeout, retryConfig: { retries: 0 } }
}

function requireSlackDownloadUrl(value: string | URL): URL {
  const url = value instanceof URL ? value : new URL(value)
  if (url.protocol !== 'https:'
    || (url.hostname !== 'slack.com' && !url.hostname.endsWith('.slack.com'))) {
    throw new Error(`refusing non-Slack attachment URL: ${url.hostname}`)
  }
  return url
}

export function requireSlackUploadUrl(value: string | URL): URL {
  const url = requireSlackDownloadUrl(value)
  if (url.username || url.password) throw new Error('refusing credentialed Slack upload URL')
  return url
}

/**
 * Upload bytes directly to Slack's pre-signed external upload URL without
 * inheriting host proxy settings. Redirects are rejected because replaying a
 * non-idempotent body to another destination would make delivery ambiguous.
 */
export async function postDirectSlackUpload(
  input: string | URL,
  data: Uint8Array,
  beforeRequestWrite: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = requireSlackUploadUrl(input)
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.byteLength),
      },
      rejectUnauthorized: true,
      signal,
    }, resolve)
    request.once('error', reject)
    try {
      // Node does not flush this request until write/end/flushHeaders. Keep the
      // durable at-most-once checkpoint in the same synchronous stack directly
      // before the first operation that may emit HTTP bytes.
      beforeRequestWrite()
      request.end(data)
    } catch (error) {
      request.destroy()
      reject(error)
    }
  })
  let received = 0
  for await (const value of response) {
    received += Buffer.byteLength(value)
    if (received > 1024 * 1024) {
      response.destroy()
      throw new Error('Slack upload response is too large')
    }
  }
  if (response.statusCode !== 200) {
    throw new Error(`Slack external upload failed: HTTP ${response.statusCode ?? 'unknown'}`)
  }
}

/**
 * Download through Node's direct HTTPS transport, which does not consume
 * HTTP(S)_PROXY. TLS verification is forced on even if state tuning contains
 * NODE_TLS_REJECT_UNAUTHORIZED=0. Redirects remain restricted to Slack hosts.
 */
export async function openDirectSlackDownload(
  input: string | URL,
  botToken: string,
  signal?: AbortSignal,
  redirects = 3,
): Promise<IncomingMessage> {
  const url = requireSlackDownloadUrl(input)
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${botToken}` },
      rejectUnauthorized: true,
      signal,
    }, resolve)
    request.once('error', reject)
    request.end()
  })
  const location = response.headers.location
  if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
    response.resume()
    if (redirects <= 0) throw new Error('too many Slack attachment redirects')
    return openDirectSlackDownload(new URL(location, url), botToken, signal, redirects - 1)
  }
  return response
}

export async function postDirectSlackApi(
  method: string,
  botToken: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok?: boolean; error?: string }> {
  if (!/^[a-z][a-zA-Z.]+$/.test(method)) throw new Error(`invalid Slack API method: ${method}`)
  const payload = Buffer.from(JSON.stringify(body))
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(new URL(`https://slack.com/api/${method}`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(payload.byteLength),
      },
      rejectUnauthorized: true,
      signal,
    }, resolve)
    request.once('error', reject)
    request.end(payload)
  })
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    response.resume()
    throw new Error(`Slack ${method} failed: HTTP ${response.statusCode ?? 'unknown'}`)
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const value of response) {
    const chunk = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
    received += chunk.byteLength
    if (received > 1024 * 1024) {
      response.destroy()
      throw new Error(`Slack ${method} response is too large`)
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok?: boolean; error?: string }
}

export async function withSlackDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeout = slackHttpTimeoutMs(),
  label = 'Slack request',
  parentSignal?: AbortSignal,
): Promise<T> {
  // A pre-aborted parent must not start a request with external effects.
  if (parentSignal?.aborted) throw new Error(`${label} aborted`)
  const controller = new AbortController()
  let timedOut = false
  let rejectTimeout: ((error: Error) => void) | undefined
  const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject })
  const interrupted = () => {
    controller.abort()
    rejectTimeout?.(new Error(`${label} aborted`))
  }
  parentSignal?.addEventListener('abort', interrupted, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    rejectTimeout?.(new Error(`${label} timed out after ${timeout}ms`))
  }, timeout)
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise])
  } catch (error) {
    if (timedOut) throw new Error(`${label} timed out after ${timeout}ms`)
    throw error
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', interrupted)
    controller.abort()
  }
}

/**
 * Run a non-cooperative Slack side effect exactly once. Once the operation has
 * started, its terminal result must be observed so the caller can durably
 * checkpoint success before honoring a shutdown signal. WebClient supplies
 * the network deadline for these SDK calls.
 */
export async function completeSlackSideEffect<T>(
  operation: () => Promise<T>,
  label = 'Slack side effect',
  parentSignal?: AbortSignal,
): Promise<T> {
  if (parentSignal?.aborted) throw new Error(`${label} aborted before start`)
  return operation()
}
