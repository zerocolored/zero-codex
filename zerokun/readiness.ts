import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, isAbsolute } from 'path'

export interface GatewayReadiness {
  runtime: 'codex'
  pid: number
  connectedAt: number
  release: string
  projectDir: string
  channelRoutingVersion?: 1
  slackAppId?: string
}

export function readGatewayReadiness(path: string): GatewayReadiness | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<GatewayReadiness>
    if (value.runtime !== 'codex' || !Number.isInteger(value.pid) || Number(value.pid) <= 0
      || !Number.isFinite(value.connectedAt) || typeof value.release !== 'string'
      || !value.release.trim() || typeof value.projectDir !== 'string'
      || !isAbsolute(value.projectDir) || !value.projectDir.trim()) return null
    const routeFields = value.channelRoutingVersion !== undefined || value.slackAppId !== undefined
    if (routeFields && (value.channelRoutingVersion !== 1
      || typeof value.slackAppId !== 'string'
      || !/^A[A-Z0-9]+$/.test(value.slackAppId))) return null
    return value as GatewayReadiness
  } catch {
    return null
  }
}

export function writeGatewayReadiness(
  path: string,
  release: string,
  pid = process.pid,
  projectDir = process.cwd(),
  slackAppId: string,
): void {
  if (!isAbsolute(projectDir) || !projectDir.trim()) {
    throw new Error('gateway project directory must be an absolute path')
  }
  const appId = slackAppId.trim().toUpperCase()
  if (!/^A[A-Z0-9]+$/.test(appId)) throw new Error('gateway Slack app ID is invalid')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({
      runtime: 'codex',
      pid,
      connectedAt: Date.now(),
      release: release.trim() || 'unknown',
      projectDir,
      channelRoutingVersion: 1,
      slackAppId: appId,
    } satisfies GatewayReadiness), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function gatewaySupportsSharedChannelRoutes(
  path: string,
  pid: number,
  slackAppId: string,
): boolean {
  const current = readGatewayReadiness(path)
  return current?.pid === pid
    && current.channelRoutingVersion === 1
    && current.slackAppId === slackAppId.trim().toUpperCase()
}

export function clearGatewayReadiness(path: string, pid = process.pid): void {
  const current = readGatewayReadiness(path)
  if (!current || current.pid === pid) rmSync(path, { force: true })
}

if (import.meta.main) {
  const [command, path, pidRaw, appId, ...extra] = process.argv.slice(2)
  if (command !== 'can-share' || !path || !pidRaw || !appId || extra.length > 0) {
    process.stderr.write('usage: readiness.ts can-share <path> <pid> <slack-app-id>\n')
    process.exitCode = 2
  } else {
    const pid = Number(pidRaw)
    if (!Number.isSafeInteger(pid) || pid <= 0
      || !gatewaySupportsSharedChannelRoutes(path, pid, appId)) process.exitCode = 1
  }
}
