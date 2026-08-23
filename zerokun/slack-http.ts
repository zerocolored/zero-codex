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
  const controller = new AbortController()
  let timedOut = false
  let rejectTimeout: ((error: Error) => void) | undefined
  const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject })
  const interrupted = () => {
    controller.abort()
    rejectTimeout?.(new Error(`${label} aborted`))
  }
  if (parentSignal?.aborted) interrupted()
  else parentSignal?.addEventListener('abort', interrupted, { once: true })
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
