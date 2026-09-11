import { afterEach, describe, expect, test } from 'bun:test'
import type { SocketModeReceiver } from '@slack/bolt'
import type { Server, ServerWebSocket } from 'bun'
import { isTransientNetworkFailure } from '../gate.ts'
import { slackWebClientOptions } from './slack-http.ts'
import {
  createSupervisedSocketModeReceiver,
  slackSocketReconnectDelayMs,
  startSlackSocketWithRetry,
  superviseSlackSocketMode,
  SLACK_SOCKET_STABLE_CONNECTION_MS,
  type SlackSocketSupervisor,
  type SlackSocketSupervisorEvent,
} from './slack-socket-supervisor.ts'

/**
 * The reconnect path exercised end to end against the real SDK: the real
 * SocketModeReceiver, the real SocketModeClient, the real WebClient (whose HTTP
 * transport is the only thing replaced, so the wrapper it throws is the one it
 * builds in production), the real `ws` client, and a local WebSocket server
 * standing in for Slack.
 *
 * Source-string tests cannot see any of this. The review that asked for it is
 * right: the SDK answers a network failure on apps.connections.open by marking
 * it unrecoverable and rethrowing into a promise nobody holds, so a gateway that
 * only stops dying is a gateway that stays up with no connection.
 */

/** A DNS failure as axios reports it; `request` is what makes WebClient wrap it. */
function dnsFailure(): Error {
  return Object.assign(new Error('getaddrinfo ENOTFOUND slack.com'), {
    code: 'ENOTFOUND',
    isAxiosError: true,
    request: {},
  })
}

type Harness = {
  receiver: SocketModeReceiver
  supervisor: SlackSocketSupervisor
  wsServer: Server
  reported: SlackSocketSupervisorEvent[]
  waits: number[]
  received: string[]
  unrecoverable: unknown[]
  /** apps.connections.open calls the SDK actually issued. */
  openCalls: () => number
  /** Last error the SDK handed the supervisor, exactly as it built it. */
  lastConnectError: () => unknown
  live: () => ServerWebSocket<unknown> | null
  deliver: (eventId: string) => void
  setOnline: (value: boolean) => void
  /** Hands out an unreachable WebSocket URL for the next `count` open calls. */
  armDeadSocketOpens: (count: number) => void
  /** Fails apps.connections.open with a Slack error for the next `count` calls. */
  setPlatformError: (value: string | null, count?: number) => void
  /** Fails apps.connections.open at the transport layer for the next `count` calls. */
  setTransportError: (error: (() => Error) | null, count?: number) => void
  /** Answers apps.connections.open with an HTTP status for the next `count` calls. */
  setHttpStatus: (status: number | null, count?: number) => void
  /** Makes the Slack stand-in hang up the moment it has sent `hello`. */
  setDropOnHello: (value: boolean) => void
}

let active: Harness | null = null

afterEach(async () => {
  const harness = active
  active = null
  if (!harness) return
  harness.supervisor.stop()
  await harness.receiver.client.disconnect().catch(() => {})
  harness.wsServer.stop(true)
})

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let elapsed = 0; elapsed < 3_000; elapsed += 1) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function startHarness(options: {
  /** Flips to online after this many backoff sleeps; Infinity keeps it offline. */
  recoverAfterSleeps: number
  onSleep?: (milliseconds: number) => void
  /** Virtual clock, so connection age is decided by the test, not the wall. */
  now?: () => number
}): Harness {
  let liveSocket: ServerWebSocket<unknown> | null = null
  const received: string[] = []
  const reported: SlackSocketSupervisorEvent[] = []
  const waits: number[] = []
  const unrecoverable: unknown[] = []
  let openCalls = 0
  let lastConnectError: unknown = null
  let online = true
  let remainingDeadOpens = 0
  let platformError: string | null = null
  let remainingPlatformErrorOpens = Number.POSITIVE_INFINITY
  let transportError: (() => Error) | null = null
  let remainingTransportErrorOpens = Number.POSITIVE_INFINITY
  let httpStatus: number | null = null
  let remainingHttpStatusOpens = Number.POSITIVE_INFINITY
  let dropOnHello = false

  const wsServer = Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request)
      ? undefined
      : new Response('expected a websocket upgrade', { status: 400 })),
    websocket: {
      open: socket => {
        liveSocket = socket
        socket.send(JSON.stringify({ type: 'hello' }))
        // A peer that greets and hangs up: Slack asking for a refresh in a
        // loop, a rival instance taking the slot, a middlebox cutting the
        // stream right after the upgrade.
        if (dropOnHello) setTimeout(() => socket.close(), 0)
      },
      message: () => {},
      close: socket => { if (liveSocket === socket) liveSocket = null },
    },
  })
  const liveUrl = `ws://127.0.0.1:${wsServer.port}/link`

  const receiver = createSupervisedSocketModeReceiver({
    appToken: 'xapp-test-token',
    clientOptions: {
      ...slackWebClientOptions(5_000),
      // The one seam. Everything above it in the SDK stays real, so the failure
      // the supervisor classifies is the SDK's own WebAPIRequestError.
      adapter: async config => {
        if (!String(config.url ?? '').endsWith('apps.connections.open')) {
          return {
            data: { ok: true }, status: 200, statusText: 'OK',
            headers: {}, config, request: {},
          }
        }
        openCalls += 1
        if (!online) throw dnsFailure()
        if (transportError && remainingTransportErrorOpens > 0) {
          remainingTransportErrorOpens -= 1
          throw transportError()
        }
        if (httpStatus !== null && remainingHttpStatusOpens > 0) {
          remainingHttpStatusOpens -= 1
          return {
            data: {}, status: httpStatus, statusText: 'NG',
            headers: {}, config, request: {},
          }
        }
        if (platformError && remainingPlatformErrorOpens > 0) {
          remainingPlatformErrorOpens -= 1
          return {
            data: { ok: false, error: platformError }, status: 200, statusText: 'OK',
            headers: {}, config, request: {},
          }
        }
        const dead = remainingDeadOpens > 0
        if (dead) remainingDeadOpens -= 1
        return {
          data: { ok: true, url: dead ? 'ws://127.0.0.1:1/unreachable' : liveUrl },
          status: 200, statusText: 'OK', headers: {}, config, request: {},
        }
      },
    },
  })

  // Bolt's own inbound path: the receiver forwards every slack_event to the app.
  receiver.init({
    processEvent: async (event: { body: { event_id?: string } }) => {
      received.push(event.body.event_id ?? 'unknown')
    },
  } as unknown as Parameters<SocketModeReceiver['init']>[0])

  const supervisor = superviseSlackSocketMode({
    connection: receiver.client,
    reconnect: () => receiver.client.start(),
    ...(options.now ? { now: options.now } : {}),
    sleep: async milliseconds => {
      waits.push(milliseconds)
      options.onSleep?.(milliseconds)
      if (waits.length >= options.recoverAfterSleeps) online = true
      // Real time stays at zero, but the loop has to yield the macrotask queue
      // or a retry that never gives up starves `until` and hangs the runner
      // instead of failing it.
      await Bun.sleep(0)
    },
    report: event => {
      reported.push(event)
      if (event.phase === 'retrying' || event.phase === 'unrecoverable') {
        lastConnectError = event.error
      }
    },
    onUnrecoverable: error => { unrecoverable.push(error) },
  })

  const harness: Harness = {
    receiver,
    supervisor,
    wsServer,
    reported,
    waits,
    received,
    unrecoverable,
    openCalls: () => openCalls,
    lastConnectError: () => lastConnectError,
    live: () => liveSocket,
    deliver: eventId => {
      liveSocket?.send(JSON.stringify({
        type: 'events_api',
        envelope_id: eventId,
        payload: { event_id: eventId, event: { type: 'message', text: eventId } },
        accepts_response_payload: false,
      }))
    },
    setOnline: value => { online = value },
    armDeadSocketOpens: count => { remainingDeadOpens = count },
    setPlatformError: (value, count = Number.POSITIVE_INFINITY) => {
      platformError = value
      remainingPlatformErrorOpens = count
    },
    setTransportError: (error, count = Number.POSITIVE_INFINITY) => {
      transportError = error
      remainingTransportErrorOpens = count
    },
    setHttpStatus: (status, count = Number.POSITIVE_INFINITY) => {
      httpStatus = status
      remainingHttpStatusOpens = count
    },
    setDropOnHello: value => { dropOnHello = value },
  }
  active = harness
  return harness
}

describe('Socket Mode reconnection ownership', () => {
  test('接続取得がnetwork断で失敗しても、復旧後に再接続して受信を再開する', async () => {
    const h = startHarness({ recoverAfterSleeps: 2 })

    await h.receiver.client.start()
    h.supervisor.arm()
    h.deliver('env-1')
    await until(() => h.received.length === 1, 'the first event')
    expect(h.received).toEqual(['env-1'])
    const openedBeforeLoss = h.openCalls()

    // The laptop drops Wi-Fi: the socket dies and every new connection attempt
    // fails at DNS until the network comes back.
    h.setOnline(false)
    h.live()?.close()
    await until(() => h.waits.length >= 2, 'two backoff sleeps')
    await h.supervisor.settled()

    // 1. The gateway reconnected on its own. Without an owner the SDK stops
    //    after the first failure and never tries again.
    expect(h.supervisor.connected).toBe(true)
    expect(h.openCalls() - openedBeforeLoss).toBe(3)
    expect(h.reported.map(event => event.phase))
      .toEqual(['lost', 'retrying', 'retrying', 'reconnected'])

    // 2. Recovery is bounded, so an outage of any length costs at most one
    //    capped backoff.
    expect(h.waits).toEqual([1_000, 2_000])
    expect(Math.max(...h.waits)).toBeLessThanOrEqual(30_000)

    // 3. The failure the SDK actually produced is the wrapper shape the review
    //    called out: no `cause`, the errno parked on `original`.
    const connectError = h.lastConnectError() as {
      code?: string
      original?: { code?: string }
    }
    expect(connectError.code).toBe('slack_webapi_request_error')
    expect('cause' in (connectError as object)).toBe(false)
    expect(connectError.original?.code).toBe('ENOTFOUND')
    expect(isTransientNetworkFailure(connectError)).toBe(true)

    // 4. Inbound delivery resumed on the new connection.
    await until(() => h.live() !== null, 'the replacement socket')
    h.deliver('env-2')
    await until(() => h.received.length === 2, 'the event after recovery')
    expect(h.received).toEqual(['env-1', 'env-2'])
  })

  test('接続取得は成功してもhandshakeが落ちる経路で再接続を二重に走らせない', async () => {
    const h = startHarness({ recoverAfterSleeps: Infinity })

    await h.receiver.client.start()
    h.supervisor.arm()
    const openedBeforeLoss = h.openCalls()

    // apps.connections.open succeeds but the socket it points at refuses the
    // handshake: start() rejects with no error at all *and* the permanent
    // disconnected listener fires. Both must drive one attempt, not two.
    h.armDeadSocketOpens(2)
    h.live()?.close()
    await until(() => h.waits.length >= 2, 'two backoff sleeps')
    await h.supervisor.settled()

    expect(h.supervisor.connected).toBe(true)
    expect(h.openCalls() - openedBeforeLoss).toBe(3)
    expect(h.reported.map(event => event.phase))
      .toEqual(['lost', 'retrying', 'retrying', 'reconnected'])
    expect(h.unrecoverable).toHaveLength(0)
  })

  test('Slackが拒否する資格情報は待っても直らないので再試行せず落とす', async () => {
    const h = startHarness({ recoverAfterSleeps: Infinity })

    await h.receiver.client.start()
    h.supervisor.arm()
    h.setPlatformError('invalid_auth')
    h.live()?.close()
    await until(() => h.unrecoverable.length === 1, 'the unrecoverable report')
    await h.supervisor.settled()

    expect(h.reported.map(event => event.phase)).toEqual(['lost', 'unrecoverable'])
    expect(h.waits).toEqual([])
    expect(h.supervisor.connected).toBe(false)
  })

  test('待っても直らないtransport不調も諦める。無通信のまま生き続けない', async () => {
    // Owning the reconnect means owning the decision to stop. The SDK called
    // these unrecoverable and the process died; retrying them forever would
    // trade a gateway that dies loudly for one that is up and mute, which is
    // the failure this whole change exists to remove.
    const h = startHarness({ recoverAfterSleeps: Infinity })

    await h.receiver.client.start()
    h.supervisor.arm()
    h.setTransportError(() => Object.assign(new Error('certificate has expired'), {
      code: 'CERT_HAS_EXPIRED', isAxiosError: true, request: {},
    }))
    h.live()?.close()
    await until(() => h.unrecoverable.length === 1, 'the unrecoverable report')
    await h.supervisor.settled()

    expect(h.reported.map(event => event.phase)).toEqual(['lost', 'unrecoverable'])
    expect(h.waits).toEqual([])
    const error = h.lastConnectError() as { code?: string; original?: { code?: string } }
    expect(error.code).toBe('slack_webapi_request_error')
    expect(error.original?.code).toBe('CERT_HAS_EXPIRED')
  })

  test('Slackが恒久的に拒むHTTPエラーは諦める', async () => {
    const h = startHarness({ recoverAfterSleeps: Infinity })

    await h.receiver.client.start()
    h.supervisor.arm()
    // A proxy that refuses the call outright will refuse the next one too.
    h.setHttpStatus(403)
    h.live()?.close()
    await until(() => h.unrecoverable.length === 1, 'the unrecoverable report')
    await h.supervisor.settled()

    expect(h.reported.map(event => event.phase)).toEqual(['lost', 'unrecoverable'])
    expect(h.waits).toEqual([])
  })

  // Slack having a bad minute is not a reason to stop being a gateway. 421 is
  // here because the spec says to retry a misdirected request on a fresh
  // connection, which is exactly what the next attempt opens.
  for (const status of [421, 429, 503]) {
    test(`一時的なHTTP ${status}は待って張り直す`, async () => {
      const h = startHarness({ recoverAfterSleeps: Infinity })

      await h.receiver.client.start()
      h.supervisor.arm()
      h.setHttpStatus(status, 2)
      h.live()?.close()
      await until(() => h.waits.length >= 2, `two backoff sleeps after ${status}`)
      await h.supervisor.settled()

      expect(h.supervisor.connected).toBe(true)
      expect(h.unrecoverable).toHaveLength(0)
      expect(h.waits).toEqual([1_000, 2_000])
      expect(h.reported.map(event => event.phase))
        .toEqual(['lost', 'retrying', 'retrying', 'reconnected'])
    })
  }

  // Codes a link in trouble produces and a healthy one does not. Reading either
  // as a permanent fault would end the gateway on exactly the conditions it is
  // supposed to ride out: axios reports its own request timeout as
  // ECONNABORTED rather than ETIMEDOUT, and a refused connection is what a
  // restarting proxy or a Slack edge in rotation answers with.
  for (const code of ['ECONNABORTED', 'ECONNREFUSED']) {
    test(`${code}はnetwork断として扱い、諦めない`, async () => {
      const h = startHarness({ recoverAfterSleeps: Infinity })

      await h.receiver.client.start()
      h.supervisor.arm()
      h.setTransportError(() => Object.assign(new Error(`${code} happened`), {
        code, isAxiosError: true, request: {},
      }), 2)
      h.live()?.close()
      await until(() => h.waits.length >= 2, `two backoff sleeps after ${code}`)
      await h.supervisor.settled()

      expect(h.supervisor.connected).toBe(true)
      expect(h.unrecoverable).toHaveLength(0)
      expect(h.waits).toEqual([1_000, 2_000])
      expect(isTransientNetworkFailure(h.lastConnectError())).toBe(true)
    })
  }

  test('shutdownはbackoff待機中でも再接続を止める', async () => {
    const h = startHarness({
      recoverAfterSleeps: Infinity,
      onSleep: () => { active?.supervisor.stop() },
    })

    await h.receiver.client.start()
    h.supervisor.arm()
    const openedBeforeLoss = h.openCalls()
    h.setOnline(false)
    h.live()?.close()
    await until(() => h.waits.length === 1, 'the first backoff sleep')
    await h.supervisor.settled()

    expect(h.openCalls() - openedBeforeLoss).toBe(1)
    expect(h.reported.map(event => event.phase)).toEqual(['lost', 'retrying'])
  })

  test('hello直後に切られ続けても再接続に下限が掛かり、安定後の切断だけ即座に張り直す', async () => {
    let clock = 0
    const h = startHarness({
      recoverAfterSleeps: Infinity,
      now: () => clock,
      // 2回待たせたらpeerを正常化して、storm側の観測を閉じる。
      onSleep: () => {
        if ((active?.waits.length ?? 0) >= 2) active?.setDropOnHello(false)
      },
    })

    await h.receiver.client.start()
    h.supervisor.arm()
    const openedBefore = h.openCalls()

    // 接続自体は毎回成立するが、helloの直後に落ちる。成功をそのままbackoffの
    // リセットとして扱うと、この経路だけ待機が消えてapps.connections.openを
    // 無制限に叩き続ける（実測: 500msで381回）。
    h.setDropOnHello(true)
    h.live()?.close()
    await until(
      () => h.waits.length >= 2 && h.supervisor.connected,
      'a connection that holds after two floored retries',
    )
    await h.supervisor.settled()

    // 短命サイクルは「成功」に数えないので、下限が一周ごとに効く。
    expect(h.waits).toEqual([1_000, 2_000])
    expect(h.openCalls() - openedBefore).toBe(3)

    // それでも、本当に保っていた接続が切れたときは待たずに張り直す。
    // ここを失うとbaseの一律5秒より遅い復旧になる。
    clock += SLACK_SOCKET_STABLE_CONNECTION_MS
    await until(() => h.live() !== null, 'the held socket')
    h.live()?.close()
    await until(() => h.openCalls() - openedBefore === 4, 'the immediate reconnect')
    await h.supervisor.settled()

    expect(h.waits).toEqual([1_000, 2_000])
    expect(h.supervisor.connected).toBe(true)
  })

  test('起動時の一過性失敗は有界に再試行し、恒久的な拒否は即座に諦める', async () => {
    const h = startHarness({ recoverAfterSleeps: Infinity })
    const startWaits: number[] = []
    const retries: { attempt: number; delayMs: number }[] = []
    const startOnce = (): Promise<void> => startSlackSocketWithRetry({
      start: async () => { await h.receiver.client.start() },
      sleep: async milliseconds => { startWaits.push(milliseconds) },
      report: event => { retries.push({ attempt: event.attempt, delayMs: event.delayMs }) },
    })

    // Slackが拒否する資格情報は待っても直らない。従来どおり即座に投げ返す。
    h.setPlatformError('invalid_auth')
    await expect(startOnce()).rejects.toThrow()
    expect(startWaits).toEqual([])
    expect(h.openCalls()).toBe(1)

    // ratelimitedは数秒で解ける。autoReconnectEnabled:falseのSDKはこれも即throw
    // するので、ここで諦めるとexit(1)でgatewayは死んだままになる。
    h.setPlatformError('ratelimited', 1)
    await startOnce()
    h.supervisor.arm()

    expect(retries).toEqual([{ attempt: 1, delayMs: 1_000 }])
    expect(startWaits).toEqual([1_000])
    expect(h.openCalls()).toBe(3)
    expect(h.supervisor.connected).toBe(true)
    expect(h.reported).toEqual([])

    h.deliver('env-1')
    await until(() => h.received.length === 1, 'the first event after a retried start')
    expect(h.received).toEqual(['env-1'])
  })

  test('起動リトライ中の切断を接続成立後の切断と取り違えて二重に張らない', async () => {
    const h = startHarness({ recoverAfterSleeps: Infinity })
    const startWaits: number[] = []

    // 1回目はURLは取れるがhandshakeが落ちる。SDKはdisconnectedを出してから
    // start()をrejectするので、そのcloseがarm()まで残ると、生きている接続の
    // 上にもう1本開いてしまう。
    h.armDeadSocketOpens(1)
    await startSlackSocketWithRetry({
      start: async () => { await h.receiver.client.start() },
      sleep: async milliseconds => { startWaits.push(milliseconds) },
      report: () => {},
    })
    h.supervisor.arm()

    expect(startWaits).toEqual([1_000])
    expect(h.openCalls()).toBe(2)
    // arm()は同期でreport({phase:'lost'})を出すので、これで二重接続が捕まる。
    expect(h.reported).toEqual([])
    expect(h.supervisor.connected).toBe(true)

    h.deliver('env-1')
    await until(() => h.received.length === 1, 'the first event after a retried start')
    expect(h.received).toEqual(['env-1'])
  })

  test('backoffは1秒から倍増して30秒で頭打ちになる', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(slackSocketReconnectDelayMs))
      .toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  })
})
