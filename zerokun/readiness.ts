import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export interface GatewayReadiness {
  runtime: 'codex'
  pid: number
  connectedAt: number
  release: string
}

export function readGatewayReadiness(path: string): GatewayReadiness | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<GatewayReadiness>
    if (value.runtime !== 'codex' || !Number.isInteger(value.pid) || Number(value.pid) <= 0
      || !Number.isFinite(value.connectedAt) || typeof value.release !== 'string'
      || !value.release.trim()) return null
    return value as GatewayReadiness
  } catch {
    return null
  }
}

export function writeGatewayReadiness(path: string, release: string, pid = process.pid): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({
      runtime: 'codex',
      pid,
      connectedAt: Date.now(),
      release: release.trim() || 'unknown',
    } satisfies GatewayReadiness), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function clearGatewayReadiness(path: string, pid = process.pid): void {
  const current = readGatewayReadiness(path)
  if (!current || current.pid === pid) rmSync(path, { force: true })
}
