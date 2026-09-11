/**
 * Ownership of the Socket Mode connection.
 *
 * @slack/socket-mode answers a closed socket with `delayReconnectAttempt(this.start)`
 * invoked as `cb.apply(this).then(res)` — with no rejection handler — while its
 * `retrieveWSSURL` classifies a transport failure on apps.connections.open as
 * unrecoverable and rethrows. One DNS failure during a reconnect therefore
 * rejects into nobody's hands and schedules nothing further, so the process
 * either dies with the network or lives on holding no connection at all.
 *
 * Bolt never forwards `autoReconnectEnabled`, so the receiver is built here with
 * the SDK's loop switched off. That makes `delayReconnectAttempt` unreachable
 * and turns every close into an observable `disconnected`, leaving this module
 * as the single owner of reconnection.
 *
 * Owner of every connection, including the first: with the SDK's loop gone
 * there is nothing left to absorb a failure that clears by itself, so both the
 * opening attempt and the retry floor that keeps a greet-and-hang-up peer from
 * becoming a hammer live here too.
 */
import { SocketModeReceiver } from '@slack/bolt'
import type { WebClientOptions } from '@slack/web-api'
import { isTransientNetworkFailure, structuredSlackApiErrorCode } from '../gate.ts'

/** @slack/socket-mode's own UnrecoverableSocketModeStartError list. */
const UNRECOVERABLE_SOCKET_START_SLACK_ERRORS = new Set([
  'account_inactive',
  'invalid_auth',
  'not_authed',
  'team_disabled',
  'user_removed_from_team',
])

/**
 * HTTP answers worth waiting out; every other 4xx will say the same thing next
 * time. 421 is in here because it means "wrong connection", and the next
 * attempt opens a new one.
 */
const RETRYABLE_SLACK_HTTP_STATUSES = new Set([408, 421, 425, 429])

/**
 * Whether waiting is pointless.
 *
 * Retrying is the default. With `retryConfig.retries: 0` both a 429 and a
 * response missing its URL surface as a plain Error carrying no code, and the
 * SDK treats both as recoverable today; calling every unfamiliar shape fatal
 * would leave the gateway less available than it was before this change.
 *
 * What is not the default is a transport or HTTP failure that is not the
 * network being gone. An expired certificate, a proxy that answers 403 — the
 * SDK called these unrecoverable and let the process die, and taking ownership
 * of the reconnect means taking ownership of that decision too. Retrying them
 * forever would swap a gateway that dies loudly for one that is up and mute,
 * which is the very failure this module exists to remove.
 */
export function isPermanentSlackSocketConnectFailure(error: unknown): boolean {
  const structured = structuredSlackApiErrorCode(error)
  if (structured !== null) return UNRECOVERABLE_SOCKET_START_SLACK_ERRORS.has(structured)
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; statusCode?: unknown }
  if (candidate.code === 'slack_webapi_request_error') return !isTransientNetworkFailure(error)
  if (candidate.code === 'slack_webapi_http_error') {
    const status = typeof candidate.statusCode === 'number' ? candidate.statusCode : 0
    return status >= 400 && status < 500 && !RETRYABLE_SLACK_HTTP_STATUSES.has(status)
  }
  return false
}

export const SLACK_SOCKET_RECONNECT_BASE_MS = 1_000
export const SLACK_SOCKET_RECONNECT_MAX_MS = 30_000

/**
 * How long a connection must hold before it counts as a real one, chosen to
 * match the backoff ceiling: a link that cannot outlive the longest wait this
 * module would ever impose has not recovered.
 *
 * Reaching it resets the backoff, so an outage that ends cleanly is followed by
 * an immediate reconnect. Falling short of it does not, because a peer that
 * accepts the socket and drops it — Slack asking for a refresh in a loop, a
 * second instance of the app stealing the slot, a middlebox that passes the
 * upgrade and cuts the stream — would otherwise erase the backoff entirely and
 * turn reconnection into an unthrottled hammer on a rate-limited endpoint.
 */
export const SLACK_SOCKET_STABLE_CONNECTION_MS = 30_000

/** 1s, 2s, 4s, 8s, 16s, 30s, 30s… — an outage of any length costs at most 30s. */
export function slackSocketReconnectDelayMs(attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 10)
  return Math.min(
    SLACK_SOCKET_RECONNECT_MAX_MS,
    SLACK_SOCKET_RECONNECT_BASE_MS * 2 ** exponent,
  )
}

/**
 * One attempt plus five retries — about 31s of waiting — for the connection the
 * process starts with.
 *
 * Bounded on purpose. Slack being unreachable at boot stays a fast, loud exit
 * rather than a process that hangs forever pretending to start; what this
 * budget buys is survival of the failures that clear by themselves, which the
 * SDK used to absorb before its own reconnect was switched off.
 */
export const SLACK_SOCKET_START_ATTEMPTS = 6

/**
 * Opens the process's first Socket Mode connection, retrying a failure that can
 * clear on its own.
 *
 * With `autoReconnectEnabled: false` the SDK's `retrieveWSSURL` rethrows
 * everything, so a single `ratelimited` on apps.connections.open or one lost
 * handshake race rejects `start()` outright. Nothing restarts this process —
 * the launcher execs it directly and the watchdog only reports — so without
 * this the gateway would answer a hiccup Slack recovers from in seconds by
 * staying down until a human noticed.
 */
export async function startSlackSocketWithRetry(options: {
  start: () => Promise<unknown>
  sleep: (milliseconds: number) => Promise<void>
  report: (event: { attempt: number; delayMs: number; error: unknown }) => void
  attempts?: number
  isPermanent?: (error: unknown) => boolean
  delayMs?: (attempt: number) => number
}): Promise<void> {
  const attempts = options.attempts ?? SLACK_SOCKET_START_ATTEMPTS
  const isPermanent = options.isPermanent ?? isPermanentSlackSocketConnectFailure
  const delayMs = options.delayMs ?? slackSocketReconnectDelayMs
  for (let attempt = 1; ; attempt += 1) {
    try {
      await options.start()
      return
    } catch (error) {
      // A credential Slack refuses cannot be waited out, and the budget must
      // end somewhere; both mean the caller's fail-fast path.
      if (attempt >= attempts || isPermanent(error)) throw error
      const wait = delayMs(attempt)
      options.report({ attempt, delayMs: wait, error })
      await options.sleep(wait)
    }
  }
}

/**
 * The receiver the gateway runs on. Tests build the same one, so
 * `autoReconnectEnabled: false` is covered by behaviour rather than by reading
 * this file as text.
 *
 * `installerOptions.clientOptions` is how Bolt normally hands the app's client
 * options down to Socket Mode; passing them here is mandatory, because omitting
 * them silently restores the SDK default of a hundred internal retries and
 * hides an outage from this supervisor for hours.
 */
export function createSupervisedSocketModeReceiver(options: {
  appToken: string
  clientOptions: WebClientOptions
}): SocketModeReceiver {
  return new SocketModeReceiver({
    appToken: options.appToken,
    autoReconnectEnabled: false,
    installerOptions: { clientOptions: options.clientOptions },
  })
}

/** The slice of SocketModeClient this module drives; structurally satisfied by it. */
export interface SupervisedSocketModeConnection {
  on(event: 'connected' | 'disconnected', listener: () => void): unknown
}

export type SlackSocketSupervisorEvent =
  | { phase: 'lost' }
  | { phase: 'retrying'; attempt: number; delayMs: number; error: unknown }
  | { phase: 'reconnected'; attempt: number }
  | { phase: 'unrecoverable'; error: unknown }

export interface SlackSocketSupervisor {
  /** Take ownership once the process's first connection is live. */
  arm(): void
  /** Shutdown. Idempotent; a sleeping retry stops at its next wake. */
  stop(): void
  readonly connected: boolean
  /** Resolves once the reconnect loop is idle. Test-facing. */
  settled(): Promise<void>
}

export function superviseSlackSocketMode(options: {
  connection: SupervisedSocketModeConnection
  reconnect: () => Promise<unknown>
  sleep: (milliseconds: number) => Promise<void>
  report: (event: SlackSocketSupervisorEvent) => void
  onUnrecoverable: (error: unknown) => void
  isPermanent?: (error: unknown) => boolean
  delayMs?: (attempt: number) => number
  now?: () => number
}): SlackSocketSupervisor {
  const isPermanent = options.isPermanent ?? isPermanentSlackSocketConnectFailure
  const delayMs = options.delayMs ?? slackSocketReconnectDelayMs
  const now = options.now ?? Date.now
  let armed = false
  let stopped = false
  let looping = false
  let connected = false
  let closedDuringAttempt = false
  let running: Promise<void> | null = null
  // Survives `loop` returning, so a cycle that connects and dies young carries
  // its backoff into the next one instead of starting over at zero.
  let attempt = 0
  let connectedSince: number | null = null

  async function loop(): Promise<void> {
    looping = true
    try {
      while (!stopped) {
        // The floor. `attempt` is non-zero only when the previous cycle failed
        // or held the socket for less than SLACK_SOCKET_STABLE_CONNECTION_MS,
        // so a connection that had actually recovered is still re-established
        // with no delay at all.
        if (attempt > 0) {
          await options.sleep(delayMs(attempt))
          if (stopped) return
        }
        attempt += 1
        const wait = delayMs(attempt)
        closedDuringAttempt = false
        try {
          await options.reconnect()
          if (stopped) return
          // The socket can close again while this attempt is in flight. That
          // `disconnected` has no other owner, so it is consumed here instead
          // of leaving a connection everyone believes is live.
          if (closedDuringAttempt) {
            closedDuringAttempt = false
            connectedSince = null
            options.report({ phase: 'lost' })
            continue
          }
          connected = true
          options.report({ phase: 'reconnected', attempt })
          return
        } catch (error) {
          connected = false
          connectedSince = null
          if (stopped) return
          if (isPermanent(error)) {
            options.report({ phase: 'unrecoverable', error })
            options.onUnrecoverable(error)
            return
          }
          options.report({ phase: 'retrying', attempt, delayMs: wait, error })
        }
      }
    } finally {
      looping = false
      running = null
    }
  }

  function wake(): void {
    if (stopped || looping) return
    options.report({ phase: 'lost' })
    running = loop()
  }

  // Subscribed from construction so a close racing the very first connection is
  // not lost; `armed` decides only whether it may open a reconnect yet.
  options.connection.on('disconnected', () => {
    if (stopped) return
    connected = false
    const since = connectedSince
    connectedSince = null
    // Only a connection that proved itself buys an immediate retry.
    if (since !== null && now() - since >= SLACK_SOCKET_STABLE_CONNECTION_MS) attempt = 0
    if (!armed || looping) {
      closedDuringAttempt = true
      return
    }
    wake()
  })

  // `hello`. A stashed close older than this belongs to an attempt that already
  // failed and was retried, so keeping it would make `arm` open a second socket
  // on top of the live one.
  options.connection.on('connected', () => {
    if (stopped) return
    closedDuringAttempt = false
    connectedSince = now()
  })

  return {
    arm(): void {
      if (stopped) return
      armed = true
      connected = true
      if (!closedDuringAttempt) return
      closedDuringAttempt = false
      connected = false
      connectedSince = null
      wake()
    },
    stop(): void { stopped = true },
    get connected(): boolean { return connected },
    settled: async (): Promise<void> => { await running },
  }
}
