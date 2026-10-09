import { lstatSync, realpathSync } from 'fs'
import { isAbsolute } from 'path'
import { resolveClaudeExecutableLookup } from './ephemeral-claude-session.ts'

/** Pin the installed native executable for one launch, without a version allowlist. */
export interface ClaudeExecutableSnapshot {
  physical: string
  device: number
  inode: number
  mode: number
  size: number
  modifiedMs: number
  changedMs: number
}

export function snapshotClaudeExecutable(path = resolveClaudeExecutableLookup()): ClaudeExecutableSnapshot {
  const physical = realpathSync(path)
  const info = lstatSync(physical)
  if (!info.isFile() || !(info.mode & 0o111) || (info.mode & 0o022)) {
    throw new Error('Claude executable must be an executable regular file without shared write access')
  }
  return { physical, device: info.dev, inode: info.ino, mode: info.mode, size: info.size,
    modifiedMs: info.mtimeMs, changedMs: info.ctimeMs }
}

export function verifyClaudeExecutable(snapshot: ClaudeExecutableSnapshot): void {
  if (!snapshot || typeof snapshot.physical !== 'string' || !isAbsolute(snapshot.physical)) {
    throw new Error('invalid Claude executable snapshot')
  }
  const current = snapshotClaudeExecutable(snapshot.physical)
  for (const key of Object.keys(current) as Array<keyof ClaudeExecutableSnapshot>) {
    if (current[key] !== snapshot[key]) throw new Error('Claude executable changed before launch')
  }
}

export function decodeClaudeExecutableSnapshot(encoded: string): ClaudeExecutableSnapshot {
  if (encoded.length > 16_384) throw new Error('invalid Claude executable snapshot size')
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as ClaudeExecutableSnapshot
  verifyClaudeExecutable(value)
  return value
}
