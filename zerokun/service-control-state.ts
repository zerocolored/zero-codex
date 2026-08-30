import { randomUUID } from 'crypto'
import { rmSync } from 'fs'
import { join } from 'path'
import { requireManagedStateRoot } from './managed-path.ts'
import {
  atomicWritePrivateFile,
  readOptionalBoundedOwnerOnlyRegularFile,
} from './safe-file.ts'

export const SERVICE_CONTROL_PAUSE_REQUEST_FILE = 'service-control-pause-request.json'
export const SERVICE_CONTROL_PAUSE_ACK_FILE = 'service-control-pause-ack.json'
export const SERVICE_STOPPED_FILE = 'service-stopped.json'

type PauseRequest = {
  version: 1
  id: string
  runnerPid: number
}

type PauseAck = PauseRequest & {
  acknowledgedAt: number
}

const REQUEST_KEYS = ['id', 'runnerPid', 'version'] as const
const ACK_KEYS = ['acknowledgedAt', 'id', 'runnerPid', 'version'] as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STOPPED_CONTENT = '{"version":1,"status":"stopped"}\n'

function parseObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error(`${label} is not valid JSON`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function requireKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join('\n') !== [...expected].sort().join('\n')) {
    throw new Error(`${label} has unexpected fields`)
  }
}

function parseRequest(raw: string): PauseRequest {
  const value = parseObject(raw, 'service control pause request')
  requireKeys(value, REQUEST_KEYS, 'service control pause request')
  if (value.version !== 1 || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id)
    || typeof value.runnerPid !== 'number' || !Number.isSafeInteger(value.runnerPid)
    || value.runnerPid <= 1) {
    throw new Error('service control pause request is invalid')
  }
  return value as PauseRequest
}

function parseAck(raw: string): PauseAck {
  const value = parseObject(raw, 'service control pause acknowledgement')
  requireKeys(value, ACK_KEYS, 'service control pause acknowledgement')
  if (value.version !== 1 || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id)
    || typeof value.runnerPid !== 'number' || !Number.isSafeInteger(value.runnerPid)
    || value.runnerPid <= 1 || typeof value.acknowledgedAt !== 'number'
    || !Number.isSafeInteger(value.acknowledgedAt) || value.acknowledgedAt <= 0) {
    throw new Error('service control pause acknowledgement is invalid')
  }
  return value as PauseAck
}

function boundedRead(stateDir: string, basename: string): string | null {
  const root = requireManagedStateRoot(stateDir)
  return readOptionalBoundedOwnerOnlyRegularFile(join(root, basename), 4 * 1024)
}

export function createServiceControlPauseRequest(
  stateDir: string,
  runnerPid: number,
): PauseRequest {
  if (!Number.isSafeInteger(runnerPid) || runnerPid <= 1) {
    throw new Error('service control runner PID is invalid')
  }
  const root = requireManagedStateRoot(stateDir)
  const request: PauseRequest = { version: 1, id: randomUUID(), runnerPid }
  rmSync(join(root, SERVICE_CONTROL_PAUSE_ACK_FILE), { force: true })
  atomicWritePrivateFile(
    join(root, SERVICE_CONTROL_PAUSE_REQUEST_FILE),
    `${JSON.stringify(request)}\n`,
  )
  return request
}

/** Called only at the runner's between-job claim barrier. */
export function acknowledgeServiceControlPauseIfRequested(stateDir: string): boolean {
  const raw = boundedRead(stateDir, SERVICE_CONTROL_PAUSE_REQUEST_FILE)
  if (raw === null) return false
  const request = parseRequest(raw)
  if (request.runnerPid !== process.pid) return false
  const ack: PauseAck = { ...request, acknowledgedAt: Date.now() }
  atomicWritePrivateFile(
    join(requireManagedStateRoot(stateDir), SERVICE_CONTROL_PAUSE_ACK_FILE),
    `${JSON.stringify(ack)}\n`,
  )
  return true
}

export function serviceControlPauseAcknowledged(
  stateDir: string,
  request: PauseRequest,
): boolean {
  const raw = boundedRead(stateDir, SERVICE_CONTROL_PAUSE_ACK_FILE)
  if (raw === null) return false
  const ack = parseAck(raw)
  return ack.id === request.id && ack.runnerPid === request.runnerPid
}

export function clearServiceControlPauseRequest(
  stateDir: string,
  request: PauseRequest,
): void {
  const root = requireManagedStateRoot(stateDir)
  const current = boundedRead(root, SERVICE_CONTROL_PAUSE_REQUEST_FILE)
  if (current !== null && parseRequest(current).id !== request.id) {
    throw new Error('service control pause request changed before cleanup')
  }
  const ack = boundedRead(root, SERVICE_CONTROL_PAUSE_ACK_FILE)
  if (ack !== null && parseAck(ack).id !== request.id) {
    throw new Error('service control pause acknowledgement changed before cleanup')
  }
  rmSync(join(root, SERVICE_CONTROL_PAUSE_ACK_FILE), { force: true })
  rmSync(join(root, SERVICE_CONTROL_PAUSE_REQUEST_FILE), { force: true })
}

export function writeIntentionalServiceStop(stateDir: string): void {
  const root = requireManagedStateRoot(stateDir)
  atomicWritePrivateFile(join(root, SERVICE_STOPPED_FILE), STOPPED_CONTENT)
}

export function intentionalServiceStopIsSet(stateDir: string): boolean {
  const raw = boundedRead(stateDir, SERVICE_STOPPED_FILE)
  return raw === STOPPED_CONTENT
}

export function clearIntentionalServiceStop(stateDir: string): void {
  const root = requireManagedStateRoot(stateDir)
  const raw = boundedRead(root, SERVICE_STOPPED_FILE)
  if (raw === null) return
  if (raw !== STOPPED_CONTENT) throw new Error('intentional service stop marker is invalid')
  rmSync(join(root, SERVICE_STOPPED_FILE), { force: true })
}
