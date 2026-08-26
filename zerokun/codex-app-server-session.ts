import { lstatSync, realpathSync } from 'fs'
import { isAbsolute, join } from 'path'

export const APP_SERVER_CONTROL_POLL_MS = 100 as const

const MAX_JSON_LINE_CHARS = 32 * 1024 * 1024
const MAX_CONTROL_NOTIFICATION_HISTORY = 4_096
const MAX_ACTIVE_TURN_PROJECTIONS = 16
const MAX_COMPLETED_TURN_PROJECTIONS = 64
const MAX_PENDING_LATE_SUBAGENT_ACTIVITIES = 4_096

export type AppServerTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

export type AppServerTurn = {
  id: string
  status: AppServerTurnStatus
  itemsView: 'notLoaded' | 'summary' | 'full'
  items: Array<Record<string, unknown>>
  error: Record<string, unknown> | null
}

export type AppServerTurnTerminal = {
  threadId: string
  turn: AppServerTurn
  permissionEvidence: AppServerPermissionProbeEvidence
}

export type AppServerNotification = {
  method: string
  params: Record<string, unknown>
  sequence: number
}

export type AppServerRequestReceipt = {
  requestId: number
  result: Record<string, unknown>
}

export type AppServerThreadHandshake = {
  threadId: string
  instructionSources: string[]
  model: string
  modelProvider: string
  source: AppServerSessionSource
}

export type AppServerCommandExecutionEvidence = {
  itemId: string | null
  command: string | null
  cwd: string | null
  source: string | null
  status: string | null
  exitCode: number | null
}

export type AppServerPermissionProbeEvidence = {
  commandCount: 0 | 1 | 2
  firstCommand: AppServerCommandExecutionEvidence | null
  unexpectedItemSeen: boolean
  unexpectedItemType: string | null
}

export function mergeAppServerPermissionProbeEvidence(
  left: AppServerPermissionProbeEvidence,
  right: AppServerPermissionProbeEvidence,
): AppServerPermissionProbeEvidence {
  const firstCommand = left.firstCommand ?? right.firstCommand
  let commandCount: AppServerPermissionProbeEvidence['commandCount']
  if (left.commandCount === 0) {
    commandCount = right.commandCount
  } else if (right.commandCount === 0) {
    commandCount = left.commandCount
  } else if (left.commandCount === 2 || right.commandCount === 2) {
    commandCount = 2
  } else {
    const leftCommand = left.firstCommand
    const rightCommand = right.firstCommand
    const sameCommand = leftCommand !== null && rightCommand !== null
      && leftCommand.itemId !== null
      && leftCommand.itemId === rightCommand.itemId
      && leftCommand.command === rightCommand.command
      && leftCommand.cwd === rightCommand.cwd
      && leftCommand.source === rightCommand.source
      && leftCommand.status === rightCommand.status
      && leftCommand.exitCode === rightCommand.exitCode
    commandCount = sameCommand ? 1 : 2
  }
  return {
    commandCount,
    firstCommand: firstCommand ? { ...firstCommand } : null,
    unexpectedItemSeen: left.unexpectedItemSeen || right.unexpectedItemSeen,
    unexpectedItemType: left.unexpectedItemSeen
      ? left.unexpectedItemType
      : right.unexpectedItemType,
  }
}

export type AppServerSessionSource =
  | 'cli' | 'vscode' | 'exec' | 'appServer' | 'unknown'
  | { custom: string }
  | { subAgent: unknown }

export class AppServerProtocolError extends Error {
  constructor(
    message: string,
    readonly method?: string,
    readonly requestId?: number,
    readonly rpcError?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppServerProtocolError'
  }
}

/** The JSON line may have reached App Server; callers must never resend it automatically. */
export class AppServerAmbiguousRequestError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly requestId: number,
  ) {
    super(message)
    this.name = 'AppServerAmbiguousRequestError'
  }
}

type PendingRequest = {
  method: string
  resolve(value: AppServerRequestReceipt): void
  reject(error: unknown): void
  timer?: ReturnType<typeof setTimeout>
}

type WritableAppServerInput = {
  write(value: string): unknown
  end?(): unknown
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppServerProtocolError(`${label} is not an object`)
  }
  return value as Record<string, unknown>
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new AppServerProtocolError(`${label} is invalid`)
  }
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppServerProtocolError(`${label} is invalid`)
  }
  return value
}

function physicalDirectory(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new AppServerProtocolError(`${label} is invalid`)
  }
  try {
    return realpathSync(value)
  } catch {
    throw new AppServerProtocolError(`${label} cannot be resolved`)
  }
}

function physicalInstructionFile(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new AppServerProtocolError(`${label} is invalid`)
  }
  try {
    const metadata = lstatSync(value)
    const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !owned) {
      throw new Error('not an owned single-link regular file')
    }
    return realpathSync(value)
  } catch {
    throw new AppServerProtocolError(`${label} cannot be verified`)
  }
}

/** Parse the official v2 SessionSource union used by thread/start and thread/read. */
export function parseAppServerSessionSource(
  value: unknown,
  label = 'App Server session source',
): AppServerSessionSource {
  if (typeof value === 'string'
    && ['cli', 'vscode', 'exec', 'appServer', 'unknown'].includes(value)) {
    return value as AppServerSessionSource
  }
  if (typeof value === 'string') {
    throw new AppServerProtocolError(`${label} is invalid`)
  }
  const source = record(value, label)
  const keys = Object.keys(source)
  if (keys.length !== 1) throw new AppServerProtocolError(`${label} is invalid`)
  if (keys[0] === 'custom' && typeof source.custom === 'string'
    && source.custom.length > 0 && source.custom.length <= 1_024) {
    return { custom: source.custom }
  }
  if (keys[0] === 'subAgent') {
    const subAgent = source.subAgent
    if (['review', 'compact', 'memory_consolidation'].includes(String(subAgent))) {
      return { subAgent }
    }
    const descriptor = record(subAgent, `${label}.subAgent`)
    const descriptorKeys = Object.keys(descriptor)
    if (descriptorKeys.length === 1 && descriptorKeys[0] === 'other'
      && typeof descriptor.other === 'string' && descriptor.other.length <= 1_024) {
      return { subAgent: { other: descriptor.other } }
    }
    if (descriptorKeys.length === 1 && descriptorKeys[0] === 'thread_spawn') {
      const spawn = record(descriptor.thread_spawn, `${label}.subAgent.thread_spawn`)
      if (typeof spawn.parent_thread_id === 'string'
        && /^[A-Za-z0-9._:-]{1,256}$/.test(spawn.parent_thread_id)
        && Number.isSafeInteger(spawn.depth) && Number(spawn.depth) >= 1) {
        return { subAgent: { thread_spawn: { ...spawn } } }
      }
    }
  }
  throw new AppServerProtocolError(`${label} is invalid`)
}

function normalizedSource(value: AppServerSessionSource): string {
  if (typeof value === 'string') return JSON.stringify(value)
  const [key] = Object.keys(value)
  const child = value[key as keyof typeof value]
  if (!child || typeof child !== 'object' || Array.isArray(child)) {
    return JSON.stringify(value)
  }
  return JSON.stringify({ [key!]: Object.fromEntries(
    Object.entries(child as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
  ) })
}

export function sameAppServerSessionSource(
  left: AppServerSessionSource,
  right: AppServerSessionSource,
): boolean {
  return normalizedSource(left) === normalizedSource(right)
}

function parseTurn(value: unknown): AppServerTurn {
  const turn = record(value, 'App Server turn')
  const status = turn.status
  if (!['completed', 'interrupted', 'failed', 'inProgress'].includes(String(status))) {
    throw new AppServerProtocolError('App Server turn status is invalid')
  }
  if (!Array.isArray(turn.items)) {
    throw new AppServerProtocolError('App Server turn items are invalid')
  }
  const itemsView = turn.itemsView
  if (!['notLoaded', 'summary', 'full'].includes(String(itemsView))) {
    throw new AppServerProtocolError('App Server turn itemsView is invalid')
  }
  const error = turn.error === null || turn.error === undefined
    ? null
    : record(turn.error, 'App Server turn error')
  return {
    id: identifier(turn.id, 'App Server turn id'),
    status: status as AppServerTurnStatus,
    itemsView: itemsView as AppServerTurn['itemsView'],
    items: turn.items.map((item, index) => record(item, `App Server turn item ${index}`)),
    error,
  }
}

export function appServerFinalMessage(turn: AppServerTurn): string | null {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index]!
    if (isFinalAppServerAgentMessage(item)) {
      return item.text
    }
  }
  return null
}

export function isFinalAppServerAgentMessage(
  item: Record<string, unknown>,
): item is Record<string, unknown> & {
  text: string
} {
  if (item.type !== 'agentMessage' && item.type !== 'agent_message') return false
  if (typeof item.text !== 'string' || !item.text.trim()) return false
  // App Server 0.149.x distinguishes interim commentary from final text, but
  // the official schema explicitly keeps null for providers/legacy models
  // that do not emit a phase. Preserve that compatibility without publishing
  // an explicitly-labelled commentary item as the Slack answer.
  return item.phase === undefined || item.phase === null || item.phase === 'final_answer'
}

export function textInput(text: string): Array<Record<string, unknown>> {
  return [{ type: 'text', text, text_elements: [] }]
}

function mergeTurnItems(
  turn: AppServerTurn,
  observed: Array<Record<string, unknown>>,
  clientUserMessageId?: string,
): AppServerTurn {
  const relevant = (
    items: readonly Record<string, unknown>[],
  ): { users: Array<Record<string, unknown>>; agent: Record<string, unknown> | null } => {
    const users: Array<Record<string, unknown>> = []
    let agent: Record<string, unknown> | null = null
    for (const item of items) {
      if (item.type === 'agentMessage' || item.type === 'agent_message') {
        if (isFinalAppServerAgentMessage(item)) agent = item
        continue
      }
      if (item.type !== 'userMessage' && item.type !== 'user_message') continue
      const clientId = item.clientId ?? item.client_id
      if (typeof clientId !== 'string' || !clientId || clientId.length > 8_192) continue
      if (clientUserMessageId !== undefined && clientId !== clientUserMessageId) continue
      users.push(item.clientId === clientId
        ? { type: item.type, clientId }
        : { type: item.type, client_id: clientId })
    }
    return { users, agent }
  }
  const official = relevant(turn.items)
  const streamed = relevant(observed)
  const users = official.users.length > 0 ? official.users : streamed.users
  const agent = official.agent ?? streamed.agent
  return {
    ...turn,
    itemsView: turn.itemsView,
    items: [...users, ...(agent ? [agent] : [])],
  }
}

/**
 * Reduce an ordered official turn history to the evidence for one rejected
 * steer. A terminal notification can contain a valid final answer from before
 * the rejected steer became durable, so it must never be merged here. Only a
 * final agent item after the exact client-ID-bearing user item proves that the
 * steer was incorporated.
 *
 * Two matching user items are enough to retain duplicate evidence while
 * keeping arbitrarily long item journals bounded.
 */
function projectClientTurnHistory(
  turn: AppServerTurn,
  clientUserMessageId: string,
): AppServerTurn {
  const users: Array<Record<string, unknown>> = []
  let matchingUserSeen = false
  let postUserAgent: Record<string, unknown> | null = null
  for (const item of turn.items) {
    if (item.type === 'userMessage' || item.type === 'user_message') {
      const clientId = item.clientId ?? item.client_id
      if (clientId !== clientUserMessageId) continue
      matchingUserSeen = true
      // A later duplicate invalidates the exact-once proof. Resetting here
      // also prevents an agent between duplicates from being paired with the
      // later occurrence.
      postUserAgent = null
      if (users.length < 2) {
        users.push(item.clientId === clientId
          ? { type: item.type, clientId }
          : { type: item.type, client_id: clientId })
      }
      continue
    }
    if (matchingUserSeen && isFinalAppServerAgentMessage(item)) {
      postUserAgent = item
    }
  }
  return {
    ...turn,
    items: [...users, ...(postUserAgent ? [postUserAgent] : [])],
  }
}

type ObservedTurnProjection = {
  lastAgentMessage: Record<string, unknown> | null
  permissionEvidence: AppServerPermissionProbeEvidence
  pendingSubAgentActivityIds: Set<string>
}

function emptyPermissionProbeEvidence(): AppServerPermissionProbeEvidence {
  return {
    commandCount: 0,
    firstCommand: null,
    unexpectedItemSeen: false,
    unexpectedItemType: null,
  }
}

function observePermissionProbeItem(
  evidence: AppServerPermissionProbeEvidence,
  item: Record<string, unknown>,
): void {
  const allowedItemTypes = new Set([
    'userMessage', 'agentMessage', 'plan', 'reasoning', 'commandExecution',
  ])
  const itemType = item.type
  if (typeof itemType !== 'string' || !allowedItemTypes.has(itemType)) {
    if (!evidence.unexpectedItemSeen) {
      evidence.unexpectedItemSeen = true
      evidence.unexpectedItemType = typeof itemType === 'string'
        && itemType.length <= 256 ? itemType : null
    }
    return
  }
  if (itemType !== 'commandExecution') return
  evidence.commandCount = evidence.commandCount === 0 ? 1 : 2
  if (evidence.firstCommand !== null) return
  const boundedString = (value: unknown): string | null => (
    typeof value === 'string' && value.length <= 8_192 ? value : null
  )
  evidence.firstCommand = {
    itemId: boundedString(item.id),
    command: boundedString(item.command),
    cwd: boundedString(item.cwd),
    source: boundedString(item.source),
    status: boundedString(item.status),
    exitCode: typeof item.exitCode === 'number' && Number.isSafeInteger(item.exitCode)
      ? item.exitCode
      : null,
  }
}

function permissionProbeEvidenceFromItems(
  items: readonly Record<string, unknown>[],
): AppServerPermissionProbeEvidence {
  const evidence = emptyPermissionProbeEvidence()
  for (const item of items) observePermissionProbeItem(evidence, item)
  return evidence
}

function turnProjectionKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`
}

function knownSubAgentActivityKind(value: unknown): boolean {
  // 0.149.x exposes the first three values; current App Server also exposes
  // `completed` for successful children whose item/completed may follow the
  // parent terminal. Exact item identity, rather than kind alone, is the late
  // notification authority.
  return value === 'started' || value === 'interacted'
    || value === 'interrupted' || value === 'completed'
}

/**
 * One ordered JSON-RPC writer and one stdout reader for a single supervised
 * `codex app-server --stdio` process. It never retries a request after write.
 */
export class CodexAppServerSession {
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notifications: AppServerNotification[] = []
  private readonly controlledThreadIds = new Set<string>()
  private readonly turnProjections = new Map<string, ObservedTurnProjection>()
  private readonly sealedTurnProjections = new Map<string, ObservedTurnProjection>()
  private readonly lateSubAgentActivities = new Map<string, Set<string>>()
  private pendingSubAgentActivityCount = 0
  private readonly completedTurnProjectionKeys = new Set<string>()
  private notificationSequence = 0
  private readonly notificationWaiters = new Set<() => void>()
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private buffer = ''
  private readerFailure: unknown
  private readerClosed = false
  private inputClosed = false
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly readerTask: Promise<void>

  constructor(
    private readonly input: WritableAppServerInput,
    output: ReadableStream<Uint8Array>,
    private readonly options: {
      onOutputChunk?(value: Uint8Array): void
      onNotification?(notification: AppServerNotification): void
    } = {},
  ) {
    this.reader = output.getReader()
    this.readerTask = this.readLoop()
  }

  private wakeNotificationWaiters(): void {
    for (const wake of this.notificationWaiters) wake()
    this.notificationWaiters.clear()
  }

  private rejectPending(error: unknown): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new AppServerAmbiguousRequestError(
        `Codex ${pending.method} ended without a correlated response: ${String(error)}`,
        pending.method,
        id,
      ))
    }
    this.pending.clear()
  }

  private beginTurnProjection(params: Record<string, unknown>): void {
    const threadId = identifier(params.threadId, 'turn/started thread id')
    const turn = parseTurn(params.turn)
    const key = turnProjectionKey(threadId, turn.id)
    if (this.completedTurnProjectionKeys.has(key) || this.sealedTurnProjections.has(key)) {
      throw new AppServerProtocolError('App Server reused a completed turn id')
    }
    if (this.turnProjections.has(key)) {
      throw new AppServerProtocolError('App Server repeated turn/started for an active turn')
    }
    if (this.turnProjections.size >= MAX_ACTIVE_TURN_PROJECTIONS) {
      throw new AppServerProtocolError('App Server opened too many concurrent turn projections')
    }
    this.turnProjections.set(key, {
      lastAgentMessage: null,
      permissionEvidence: emptyPermissionProbeEvidence(),
      pendingSubAgentActivityIds: new Set(),
    })
  }

  private retainsControlNotifications(threadId: string): boolean {
    // Unit transports that feed notifications directly have no handshake and
    // therefore retain their observed turns. Production binds the one parent
    // thread returned by thread/start or thread/resume; descendant turns are
    // observed for ordering but never accumulate in parent control history.
    return this.controlledThreadIds.size === 0 || this.controlledThreadIds.has(threadId)
  }

  private rememberCompletedTurnProjection(key: string): void {
    this.completedTurnProjectionKeys.add(key)
    while (this.completedTurnProjectionKeys.size > MAX_COMPLETED_TURN_PROJECTIONS) {
      const oldest = this.completedTurnProjectionKeys.values().next().value
      if (typeof oldest !== 'string') break
      this.completedTurnProjectionKeys.delete(oldest)
    }
  }

  private observeStartedItem(params: Record<string, unknown>): void {
    const threadId = identifier(params.threadId, 'item/started thread id')
    const turnId = identifier(params.turnId, 'item/started turn id')
    const key = turnProjectionKey(threadId, turnId)
    const projection = this.turnProjections.get(key)
    if (!projection) {
      throw new AppServerProtocolError('App Server started an item before turn/started')
    }
    const item = record(params.item, 'item/started item')
    if (item.type !== 'subAgentActivity') return
    const itemId = identifier(item.id, 'item/started subAgentActivity id')
    if (projection.pendingSubAgentActivityIds.has(itemId)) {
      throw new AppServerProtocolError('App Server repeated item/started for a subAgentActivity')
    }
    if (this.pendingSubAgentActivityCount >= MAX_PENDING_LATE_SUBAGENT_ACTIVITIES) {
      throw new AppServerProtocolError('App Server opened too many subAgentActivity items')
    }
    projection.pendingSubAgentActivityIds.add(itemId)
    this.pendingSubAgentActivityCount += 1
  }

  private observeCompletedItem(params: Record<string, unknown>): void {
    const threadId = identifier(params.threadId, 'item/completed thread id')
    const turnId = identifier(params.turnId, 'item/completed turn id')
    const key = turnProjectionKey(threadId, turnId)
    const projection = this.turnProjections.get(key)
    const item = record(params.item, 'item/completed item')
    if (!projection) {
      // Codex may attribute a successful child-agent lifecycle completion to
      // its parent after that parent's terminal notification. Accept only the
      // exact activity observed before the terminal; an age-based parent
      // tombstone would either reject a valid long-delayed completion or admit
      // an unrelated forged completion.
      if (item.type === 'subAgentActivity' && knownSubAgentActivityKind(item.kind)) {
        const itemId = identifier(item.id, 'late subAgentActivity id')
        const pending = this.lateSubAgentActivities.get(key)
        if (pending?.delete(itemId)) {
          this.pendingSubAgentActivityCount -= 1
          if (pending.size === 0) this.lateSubAgentActivities.delete(key)
          return
        }
      }
      throw new AppServerProtocolError('App Server completed an item before turn/started')
    }
    if (item.type === 'subAgentActivity') {
      const itemId = identifier(item.id, 'item/completed subAgentActivity id')
      if (projection.pendingSubAgentActivityIds.delete(itemId)) {
        this.pendingSubAgentActivityCount -= 1
      }
    }
    observePermissionProbeItem(projection.permissionEvidence, item)
    if (item.type === 'agentMessage' || item.type === 'agent_message') {
      if (isFinalAppServerAgentMessage(item)) projection.lastAgentMessage = item
      return
    }
    // User-message evidence is loaded from the authoritative paginated APIs
    // only when a rejected steer must be reconciled. Keeping every streamed
    // user item here would reintroduce a turn-length-dependent memory bound.
  }

  private sealTurnProjection(params: Record<string, unknown>): void {
    const threadId = identifier(params.threadId, 'turn/completed thread id')
    const turn = parseTurn(params.turn)
    if (turn.status === 'inProgress') {
      throw new AppServerProtocolError('turn/completed contained an in-progress turn')
    }
    const key = turnProjectionKey(threadId, turn.id)
    if (this.sealedTurnProjections.has(key) || this.completedTurnProjectionKeys.has(key)) {
      throw new AppServerProtocolError('App Server repeated turn/completed')
    }
    const projection = this.turnProjections.get(key) ?? {
      lastAgentMessage: null,
      permissionEvidence: emptyPermissionProbeEvidence(),
      pendingSubAgentActivityIds: new Set<string>(),
    }
    this.turnProjections.delete(key)
    if (this.retainsControlNotifications(threadId)) {
      if (this.sealedTurnProjections.size >= MAX_CONTROL_NOTIFICATION_HISTORY) {
        throw new AppServerProtocolError('App Server sealed turn projection history exceeded its bound')
      }
      this.sealedTurnProjections.set(key, projection)
    } else {
      this.rememberCompletedTurnProjection(key)
    }
    if (projection.pendingSubAgentActivityIds.size > 0) {
      this.lateSubAgentActivities.set(key, projection.pendingSubAgentActivityIds)
    }
  }

  private takeTurnProjection(
    threadId: string,
    turnId: string,
  ): ObservedTurnProjection {
    const key = turnProjectionKey(threadId, turnId)
    const projection = this.sealedTurnProjections.get(key)
    if (!projection) {
      throw new AppServerProtocolError('App Server turn terminal projection was not sealed')
    }
    this.sealedTurnProjections.delete(key)
    this.rememberCompletedTurnProjection(key)
    return projection
  }

  private consumeLine(line: string): void {
    let parsed: Record<string, unknown>
    try {
      parsed = record(JSON.parse(line), 'App Server JSON line')
    } catch (error) {
      throw new AppServerProtocolError(`App Server emitted invalid JSON: ${error}`)
    }
    if (typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id)
      if (!pending) {
        throw new AppServerProtocolError(`App Server returned unknown request id ${parsed.id}`)
      }
      let rpcError: Record<string, unknown> | null = null
      let result: Record<string, unknown> | null = null
      if (parsed.error !== undefined && parsed.error !== null) {
        rpcError = record(parsed.error, `App Server ${pending.method} error`)
      } else {
        result = record(parsed.result ?? {}, 'App Server result')
      }
      this.pending.delete(parsed.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (rpcError) {
        pending.reject(new AppServerProtocolError(
          `Codex ${pending.method} failed: ${JSON.stringify(rpcError)}`,
          pending.method,
          parsed.id,
          rpcError,
        ))
        return
      }
      pending.resolve({ requestId: parsed.id, result: result! })
      return
    }
    if (parsed.id !== undefined) {
      throw new AppServerProtocolError('App Server response id is not numeric')
    }
    if (typeof parsed.method !== 'string' || !parsed.method) {
      throw new AppServerProtocolError('App Server notification method is invalid')
    }
    // Any server-initiated request requires interactive authority that this
    // unattended Slack worker deliberately does not have.
    if ('id' in parsed) {
      throw new AppServerProtocolError(`unexpected App Server request: ${parsed.method}`)
    }
    const notification = {
      method: parsed.method,
      params: record(parsed.params ?? {}, `App Server ${parsed.method} params`),
      sequence: ++this.notificationSequence,
    }
    if (notification.method === 'turn/started') {
      this.beginTurnProjection(notification.params)
    } else if (notification.method === 'item/started') {
      this.observeStartedItem(notification.params)
    } else if (notification.method === 'item/completed') {
      this.observeCompletedItem(notification.params)
    } else if (notification.method === 'turn/completed') {
      this.sealTurnProjection(notification.params)
    }
    const isTurnControlNotification = notification.method === 'turn/started'
      || notification.method === 'turn/completed'
      || notification.method === 'error'
    const retainTurnControl = !isTurnControlNotification
      || this.retainsControlNotifications(
        identifier(notification.params.threadId, `${notification.method} thread id`),
      )
    if ((notification.method === 'turn/started'
        || notification.method === 'turn/completed'
        || notification.method === 'error')
      && retainTurnControl) {
      this.notifications.push(notification)
      if (this.notifications.length > MAX_CONTROL_NOTIFICATION_HISTORY) {
        throw new AppServerProtocolError('App Server control notification history exceeded its bound')
      }
    }
    this.options.onNotification?.(notification)
    this.wakeNotificationWaiters()
  }

  private async readLoop(): Promise<void> {
    try {
      while (true) {
        const chunk = await this.reader.read()
        if (chunk.done) break
        this.options.onOutputChunk?.(chunk.value)
        this.buffer += this.decoder.decode(chunk.value, { stream: true })
        if (this.buffer.length > MAX_JSON_LINE_CHARS) {
          throw new AppServerProtocolError('App Server emitted an oversized JSON line')
        }
        const lines = this.buffer.split(/\r?\n/)
        this.buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          this.consumeLine(line)
        }
      }
      this.buffer += this.decoder.decode()
      if (this.buffer.trim()) this.consumeLine(this.buffer)
    } catch (error) {
      this.readerFailure = error
    } finally {
      this.readerClosed = true
      this.rejectPending(this.readerFailure ?? 'stdout closed')
      this.wakeNotificationWaiters()
      this.reader.releaseLock()
    }
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    options: {
      timeoutMs?: number
      beforeWrite?(requestId: number): void
    } = {},
  ): Promise<AppServerRequestReceipt> {
    if (this.readerFailure) throw this.readerFailure
    if (this.readerClosed || this.inputClosed) {
      throw new AppServerProtocolError(`Codex ${method} cannot be sent after stream close`)
    }
    const requestId = this.nextRequestId++
    const line = `${JSON.stringify({ id: requestId, method, params })}\n`
    const response = new Promise<AppServerRequestReceipt>((resolve, reject) => {
      const pending: PendingRequest = { method, resolve, reject }
      const timeoutMs = options.timeoutMs
      if (timeoutMs !== undefined) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
          throw new AppServerProtocolError(`invalid timeout for ${method}`)
        }
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return
          reject(new AppServerAmbiguousRequestError(
            `Codex ${method} response was not observed within ${timeoutMs}ms`,
            method,
            requestId,
          ))
        }, timeoutMs)
      }
      this.pending.set(requestId, pending)
    })
    try {
      options.beforeWrite?.(requestId)
    } catch (error) {
      const pending = this.pending.get(requestId)
      if (pending?.timer) clearTimeout(pending.timer)
      this.pending.delete(requestId)
      throw error
    }
    try {
      this.input.write(line)
    } catch (error) {
      const pending = this.pending.get(requestId)
      if (pending?.timer) clearTimeout(pending.timer)
      this.pending.delete(requestId)
      throw new AppServerAmbiguousRequestError(
        `Codex ${method} write is ambiguous: ${error}`,
        method,
        requestId,
      )
    }
    return response
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.readerClosed || this.inputClosed) {
      throw new AppServerProtocolError(`Codex ${method} cannot be sent after stream close`)
    }
    this.input.write(`${JSON.stringify({ method, params })}\n`)
  }

  async initialize(timeoutMs = 15_000): Promise<void> {
    const response = await this.request('initialize', {
      clientInfo: { name: 'zerochan-slack', title: 'Zeroちゃん', version: '0.0.1' },
      capabilities: { experimentalApi: true },
    }, { timeoutMs })
    const result = response.result
    nonEmptyString(result.userAgent, 'initialize userAgent')
    nonEmptyString(result.platformFamily, 'initialize platformFamily')
    nonEmptyString(result.platformOs, 'initialize platformOs')
    if (typeof result.codexHome !== 'string' || !isAbsolute(result.codexHome)) {
      throw new AppServerProtocolError('initialize codexHome is invalid')
    }
    this.notify('initialized', {})
  }

  private threadHandshake(
    method: 'thread/start' | 'thread/resume',
    result: Record<string, unknown>,
    expected: Record<string, unknown>,
  ): AppServerThreadHandshake {
    const thread = record(result.thread, `${method} thread`)
    const threadId = identifier(thread.id, `${method} id`)
    const expectedCwd = physicalDirectory(expected.cwd, `${method} requested cwd`)
    if (physicalDirectory(result.cwd, `${method} cwd`) !== expectedCwd) {
      throw new AppServerProtocolError(`${method} returned a different cwd`)
    }
    if (physicalDirectory(thread.cwd, `${method} thread cwd`) !== expectedCwd) {
      throw new AppServerProtocolError(`${method} thread returned a different cwd`)
    }
    if (method === 'thread/resume'
      && identifier(expected.threadId, 'thread/resume requested id') !== threadId) {
      throw new AppServerProtocolError('thread/resume returned a different thread id')
    }
    const status = record(thread.status, `${method} thread status`)
    if (status.type !== 'idle' || Object.keys(status).some(key => key !== 'type')) {
      throw new AppServerProtocolError(`${method} did not return an idle thread`)
    }
    if (thread.canAcceptDirectInput !== true) {
      throw new AppServerProtocolError(`${method} did not allow direct turn input`)
    }
    if (result.approvalPolicy !== 'never') {
      throw new AppServerProtocolError(`${method} did not preserve approvalPolicy=never`)
    }
    const active = record(result.activePermissionProfile, `${method} active permission profile`)
    if (active.id !== expected.permissions) {
      throw new AppServerProtocolError(`${method} activated a different permission profile`)
    }
    if (!(active.extends === null || typeof active.extends === 'string')) {
      throw new AppServerProtocolError(`${method} returned invalid permission profile provenance`)
    }
    const model = nonEmptyString(result.model, `${method} model`)
    if (expected.model !== undefined && expected.model !== null && model !== expected.model) {
      throw new AppServerProtocolError(`${method} activated a different model`)
    }
    const modelProvider = nonEmptyString(result.modelProvider, `${method} model provider`)
    if (modelProvider !== 'openai'
      || nonEmptyString(thread.modelProvider, `${method} thread model provider`) !== modelProvider) {
      throw new AppServerProtocolError(`${method} activated an unexpected model provider`)
    }
    const source = parseAppServerSessionSource(thread.source, `${method} thread source`)
    if (typeof source === 'object' && 'subAgent' in source) {
      throw new AppServerProtocolError(`${method} returned a subagent thread source`)
    }
    if (!Array.isArray(result.instructionSources)
      || result.instructionSources.some(value => typeof value !== 'string')) {
      throw new AppServerProtocolError(`${method} returned invalid instruction sources`)
    }
    const instructionSources = result.instructionSources as string[]
    const expectedAgents = physicalInstructionFile(
      join(expectedCwd, 'AGENTS.md'),
      `${method} requested project AGENTS.md`,
    )
    const loadedExpectedAgents = instructionSources.some(path => {
      try {
        return physicalInstructionFile(path, `${method} instruction source`) === expectedAgents
      } catch {
        return false
      }
    })
    if (!loadedExpectedAgents) {
      throw new AppServerProtocolError(`${method} did not load the requested project AGENTS.md`)
    }
    return { threadId, instructionSources, model, modelProvider, source }
  }

  async startThread(
    params: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<AppServerThreadHandshake> {
    const response = await this.request('thread/start', params, { timeoutMs })
    const handshake = this.threadHandshake('thread/start', response.result, params)
    this.controlledThreadIds.add(handshake.threadId)
    return handshake
  }

  async resumeThread(
    params: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<AppServerThreadHandshake> {
    const response = await this.request('thread/resume', params, { timeoutMs })
    const handshake = this.threadHandshake('thread/resume', response.result, params)
    this.controlledThreadIds.add(handshake.threadId)
    return handshake
  }

  async startTurn(
    threadId: string,
    text: string,
    clientUserMessageId: string,
    options: {
      cwd: string
      permissions: string
      approvalPolicy: 'never'
      model?: string
      timeoutMs?: number
      beforeWrite?(requestId: number): void
    },
  ): Promise<string> {
    const baseline = this.notificationSequence
    const response = await this.request('turn/start', {
      threadId,
      clientUserMessageId,
      input: textInput(text),
      cwd: options.cwd,
      permissions: options.permissions,
      approvalPolicy: options.approvalPolicy,
      ...(options.model ? { model: options.model } : {}),
    }, { timeoutMs: options.timeoutMs ?? 30_000, beforeWrite: options.beforeWrite })
    const turn = parseTurn(response.result.turn)
    if (turn.status !== 'inProgress') {
      throw new AppServerProtocolError('turn/start did not create an in-progress turn')
    }
    const deadline = Date.now() + (options.timeoutMs ?? 30_000)
    while (true) {
      for (let index = 0; index < this.notifications.length; index += 1) {
        const notification = this.notifications[index]!
        if (notification.sequence <= baseline || notification.method !== 'turn/started') continue
        const params = notification.params
        if (params.threadId !== threadId) continue
        const started = parseTurn(params.turn)
        if (started.id !== turn.id || started.status !== 'inProgress') continue
        this.notifications.splice(index, 1)
        return turn.id
      }
      if (Date.now() >= deadline) {
        throw new AppServerAmbiguousRequestError(
          'Codex turn/start response lacked a correlated turn/started notification',
          'turn/start',
          response.requestId,
        )
      }
      await this.waitForActivity(Math.min(APP_SERVER_CONTROL_POLL_MS, deadline - Date.now()))
    }
  }

  async steer(
    threadId: string,
    turnId: string,
    text: string,
    clientUserMessageId: string,
    options: { timeoutMs?: number; beforeWrite?(requestId: number): void } = {},
  ): Promise<AppServerRequestReceipt> {
    const response = await this.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      clientUserMessageId,
      input: textInput(text),
    }, { timeoutMs: options.timeoutMs ?? 15_000, beforeWrite: options.beforeWrite })
    if (identifier(response.result.turnId, 'turn/steer turn id') !== turnId) {
      throw new AppServerProtocolError('turn/steer acknowledged a different turn')
    }
    return response
  }

  async interrupt(
    threadId: string,
    turnId: string,
    options: { timeoutMs?: number; beforeWrite?(requestId: number): void } = {},
  ): Promise<AppServerRequestReceipt> {
    return this.request('turn/interrupt', { threadId, turnId }, {
      timeoutMs: options.timeoutMs ?? 15_000,
      beforeWrite: options.beforeWrite,
    })
  }

  takeTurnTerminal(threadId: string, turnId: string): AppServerTurnTerminal | null {
    for (let index = 0; index < this.notifications.length; index += 1) {
      const notification = this.notifications[index]!
      if (notification.method !== 'turn/completed') continue
      const params = notification.params
      if (params.threadId !== threadId) continue
      const turn = parseTurn(params.turn)
      if (turn.id !== turnId || turn.status === 'inProgress') continue
      this.notifications.splice(index, 1)
      const observed = this.takeTurnProjection(threadId, turnId)
      return {
        threadId,
        turn: mergeTurnItems(turn, observed.lastAgentMessage ? [observed.lastAgentMessage] : []),
        permissionEvidence: mergeAppServerPermissionProbeEvidence(
          observed.permissionEvidence,
          permissionProbeEvidenceFromItems(turn.items),
        ),
      }
    }
    return null
  }

  async loadFullTurn(
    threadIdInput: string,
    turn: AppServerTurn,
    options: { timeoutMs?: number; clientUserMessageId?: string } = {},
  ): Promise<AppServerTurn> {
    const threadId = identifier(threadIdInput, 'thread/items/list thread id')
    const timeoutMs = options.timeoutMs ?? 30_000
    const clientUserMessageId = options.clientUserMessageId
    if (clientUserMessageId !== undefined
      && (!clientUserMessageId || clientUserMessageId.length > 8_192)) {
      throw new AppServerProtocolError('turn evidence client user message id is invalid')
    }
    const observedItems = turn.items
    const observedFallbackItems = clientUserMessageId === undefined
      ? observedItems
      : []
    const completeProjection = (official: AppServerTurn): AppServerTurn => ({
      ...(clientUserMessageId === undefined
        ? mergeTurnItems(official, observedFallbackItems)
        : projectClientTurnHistory(official, clientUserMessageId)),
      itemsView: 'full',
    })
    const matchingClientUsers = (candidate: AppServerTurn): number => (
      clientUserMessageId === undefined
        ? 0
        : candidate.items.filter(item => (
            (item.type === 'userMessage' || item.type === 'user_message')
            && (item.clientId === clientUserMessageId
              || item.client_id === clientUserMessageId)
          )).length
    )
    let matchingClientEvidenceSeen = false
    const rememberMatchingClientUsers = (candidate: AppServerTurn): number => {
      const matching = matchingClientUsers(candidate)
      if (matching > 0) matchingClientEvidenceSeen = true
      return matching
    }
    const isSufficientProjection = (candidate: AppServerTurn): boolean => {
      if (clientUserMessageId === undefined) {
        return appServerFinalMessage(candidate) !== null
      }
      const matching = rememberMatchingClientUsers(candidate)
      return matching > 1
        || (matching === 1 && appServerFinalMessage(candidate) !== null)
    }
    const unsupported = (error: unknown, method: string): boolean => (
      error instanceof AppServerProtocolError
      && error.method === method
      && error.rpcError?.code === -32601
    )
    const loadItemHistory = async (): Promise<AppServerTurn | null> => {
      let items: Array<Record<string, unknown>> = []
      const seenCursors = new Set<string>()
      let cursor: string | null = null
      try {
        while (true) {
          const response = await this.request('thread/items/list', {
            threadId,
            turnId: turn.id,
            cursor,
            limit: 100,
            sortDirection: 'asc',
          }, { timeoutMs })
          const data = response.result.data
          if (!Array.isArray(data)) {
            throw new AppServerProtocolError('thread/items/list data is invalid')
          }
          const pageItems: Array<Record<string, unknown>> = []
          for (let index = 0; index < data.length; index += 1) {
            const entry = record(data[index], `thread/items/list entry ${index}`)
            if (identifier(entry.turnId, 'thread/items/list turn id') !== turn.id) {
              throw new AppServerProtocolError('thread/items/list returned an item from another turn')
            }
            pageItems.push(record(entry.item, `thread/items/list item ${index}`))
          }
          const combined: AppServerTurn = {
            ...turn,
            itemsView: 'full',
            items: [...items, ...pageItems],
          }
          items = clientUserMessageId === undefined
            ? mergeTurnItems(combined, []).items
            : projectClientTurnHistory(combined, clientUserMessageId).items
          const nextCursor = response.result.nextCursor
          if (nextCursor === null) {
            return completeProjection({ ...turn, itemsView: 'full', items })
          }
          if (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 8_192
            || seenCursors.has(nextCursor)) {
            throw new AppServerProtocolError('thread/items/list cursor is invalid')
          }
          seenCursors.add(nextCursor)
          cursor = nextCursor
        }
      } catch (error) {
        if (unsupported(error, 'thread/items/list')) return null
        throw error
      }
    }
    if (clientUserMessageId === undefined && turn.itemsView === 'full') {
      const projected = completeProjection(turn)
      if (isSufficientProjection(projected)) return projected
    }
    // `thread/items/list` is the complete ordered journal. Consult it before
    // broader snapshots for normal completion and rejected-steer
    // reconciliation. A real item-journal failure must not be hidden by a
    // stale turn projection.
    const itemHistory = await loadItemHistory()
    if (itemHistory && isSufficientProjection(itemHistory)) return itemHistory
    let persistedFallback: AppServerTurn | null = null
    try {
      const seenCursors = new Set<string>()
      let cursor: string | null = null
      let targetNeedsFallback = false
      while (true) {
        const response = await this.request('thread/turns/list', {
          threadId,
          cursor,
          limit: 100,
          sortDirection: 'desc',
          itemsView: 'full',
        }, { timeoutMs })
        const data = response.result.data
        if (!Array.isArray(data)) {
          throw new AppServerProtocolError('thread/turns/list data is invalid')
        }
        for (let index = 0; index < data.length; index += 1) {
          const candidate = parseTurn(data[index])
          if (candidate.id === turn.id) {
            if (candidate.itemsView === 'full') {
              const projected = completeProjection(candidate)
              if (clientUserMessageId !== undefined && isSufficientProjection(projected)) {
                return projected
              }
              if (clientUserMessageId === undefined && isSufficientProjection(projected)) {
                persistedFallback = projected
              }
              // Some App Server versions materialize a turn as `full` before
              // its client-ID-bearing user item or final agent message appears
              // there. Reconcile once more through the remaining official
              // history views instead of resending or dropping an answer.
              targetNeedsFallback = true
              break
            }
            targetNeedsFallback = true
            break
          }
        }
        if (targetNeedsFallback) break
        const nextCursor = response.result.nextCursor
        if (nextCursor === null) break
        if (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 8_192
          || seenCursors.has(nextCursor)) {
          throw new AppServerProtocolError('thread/turns/list cursor is invalid')
        }
        seenCursors.add(nextCursor)
        cursor = nextCursor
      }
    } catch (error) {
      if (!unsupported(error, 'thread/turns/list')) throw error
    }
    try {
      const response = await this.request('thread/read', {
        threadId,
        includeTurns: true,
      }, { timeoutMs })
      const thread = record(response.result.thread, 'thread/read thread')
      if (identifier(thread.id, 'thread/read thread id') !== threadId) {
        throw new AppServerProtocolError('thread/read returned a different thread')
      }
      if (!Array.isArray(thread.turns)) {
        throw new AppServerProtocolError('thread/read turns are invalid')
      }
      const candidate = thread.turns.map(parseTurn).find(value => value.id === turn.id)
      if (candidate?.itemsView === 'full') {
        const projected = completeProjection(candidate)
        // thread/read is the final authoritative view after the bounded item
        // and turn paginations. For a rejected steer, a full turn with no
        // matching client ID is a definite absence (the caller may safely
        // defer it once); a matching ID is the definite applied case.
        if (clientUserMessageId !== undefined) {
          const matching = rememberMatchingClientUsers(projected)
          if (matching === 0 && matchingClientEvidenceSeen) {
            throw new AppServerProtocolError(
              'App Server persisted the rejected steer without a following final response',
            )
          }
          if (matching === 0 || matching > 1 || appServerFinalMessage(projected) !== null) {
            return projected
          }
          throw new AppServerProtocolError(
            'App Server persisted the rejected steer without a following final response',
          )
        }
        if (isSufficientProjection(projected)) {
          return projected
        }
        return persistedFallback ?? projected
      }
    } catch (error) {
      if (!unsupported(error, 'thread/read')) throw error
    }
    if (clientUserMessageId === undefined && persistedFallback) return persistedFallback
    if (clientUserMessageId !== undefined && matchingClientEvidenceSeen) {
      throw new AppServerProtocolError(
        'App Server persisted the rejected steer without a following final response',
      )
    }
    throw new AppServerProtocolError('App Server did not provide full persisted turn history')
  }

  async loadPermissionProbeEvidence(
    threadIdInput: string,
    turnIdInput: string,
    timeoutMs = 30_000,
  ): Promise<AppServerPermissionProbeEvidence> {
    const threadId = identifier(threadIdInput, 'thread/items/list thread id')
    const turnId = identifier(turnIdInput, 'thread/items/list turn id')
    const evidence = emptyPermissionProbeEvidence()
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    while (true) {
      const response = await this.request('thread/items/list', {
        threadId,
        turnId,
        cursor,
        limit: 100,
        sortDirection: 'asc',
      }, { timeoutMs })
      const data = response.result.data
      if (!Array.isArray(data)) {
        throw new AppServerProtocolError('thread/items/list data is invalid')
      }
      for (let index = 0; index < data.length; index += 1) {
        const entry = record(data[index], `thread/items/list entry ${index}`)
        if (identifier(entry.turnId, 'thread/items/list turn id') !== turnId) {
          throw new AppServerProtocolError('thread/items/list returned an item from another turn')
        }
        const item = record(entry.item, `thread/items/list item ${index}`)
        observePermissionProbeItem(evidence, item)
      }
      const nextCursor = response.result.nextCursor
      if (nextCursor === null) return evidence
      if (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 8_192
        || seenCursors.has(nextCursor)) {
        throw new AppServerProtocolError('thread/items/list cursor is invalid')
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }
  }

  takeError(): Record<string, unknown> | null {
    const index = this.notifications.findIndex(value => value.method === 'error')
    if (index < 0) return null
    return this.notifications.splice(index, 1)[0]!.params
  }

  async waitForActivity(delayMs: number = APP_SERVER_CONTROL_POLL_MS): Promise<void> {
    if (this.readerFailure) throw this.readerFailure
    if (this.readerClosed) throw new AppServerProtocolError('App Server stdout closed before turn terminal')
    await new Promise<void>(resolve => {
      const wake = () => {
        clearTimeout(timer)
        this.notificationWaiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, delayMs)
      this.notificationWaiters.add(wake)
    })
    if (this.readerFailure) throw this.readerFailure
  }

  closeInput(): void {
    if (this.inputClosed) return
    this.inputClosed = true
    this.input.end?.()
  }

  async waitForReader(): Promise<void> {
    await this.readerTask
    if (this.readerFailure) throw this.readerFailure
  }
}
