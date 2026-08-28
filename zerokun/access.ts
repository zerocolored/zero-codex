#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import {
  chmodSync,
  mkdirSync,
} from 'fs'
import { join } from 'path'
import {
  releaseProcessLock,
  tryAcquireProcessLock,
  type ProcessLockLease,
} from './process-lock.ts'
import { resolveZeroStateDir } from './state-dir.ts'
import { atomicWritePrivateFile, readOptionalPrivateFile } from './safe-file.ts'

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies?: number
}

type ChannelPolicy = { requireMention: true }
type LegacyChannelPolicy = { requireMention?: unknown; allowFrom?: unknown }

export type AccessConfig = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  writeAllowFrom: string[]
  channels: Record<string, ChannelPolicy>
  pending: Record<string, PendingEntry>
  ackReaction?: string
  doneReaction?: string
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export class AccessLockReleaseError extends Error {}

export function accessStateDir(): string {
  return resolveZeroStateDir()
}

function defaults(): AccessConfig {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    writeAllowFrom: [],
    channels: {},
    pending: {},
  }
}

export function readAccess(path = join(accessStateDir(), 'access.json')): AccessConfig {
  try {
    const content = readOptionalPrivateFile(path)
    if (content === null) return defaults()
    const raw = JSON.parse(content) as Partial<AccessConfig> & {
      channels?: Record<string, LegacyChannelPolicy | undefined>
    }
    const allowFrom = new Set(
      Array.isArray(raw.allowFrom)
        ? raw.allowFrom.filter(value => typeof value === 'string' && /^[UW][A-Z0-9]+$/i.test(value))
        : [],
    )
    const channels: Record<string, ChannelPolicy> = {}
    if (raw.channels && typeof raw.channels === 'object' && !Array.isArray(raw.channels)) {
      for (const [channelId, policy] of Object.entries(raw.channels)) {
        if (!/^[CG][A-Z0-9]+$/i.test(channelId)) continue
        channels[channelId.toUpperCase()] = { requireMention: true }
        if (!policy || !Array.isArray(policy.allowFrom)) continue
        // A listed channel user could DM without pairing in the previous
        // release. Preserve that DM permission once while discarding bot ids
        // and the channel restriction itself.
        for (const candidate of policy.allowFrom) {
          if (typeof candidate === 'string' && /^[UW][A-Z0-9]+$/i.test(candidate)) {
            allowFrom.add(candidate.toUpperCase())
          }
        }
      }
    }
    return {
      ...defaults(),
      ...raw,
      allowFrom: [...allowFrom],
      writeAllowFrom: Array.isArray(raw.writeAllowFrom) ? raw.writeAllowFrom : [],
      channels,
      pending: raw.pending && typeof raw.pending === 'object' && !Array.isArray(raw.pending)
        ? raw.pending : {},
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults()
    throw new Error(`access config is unreadable: ${path}: ${error}`)
  }
}

function writeAccessUnlocked(
  access: AccessConfig,
  path: string,
): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  atomicWritePrivateFile(path, JSON.stringify(access, null, 2) + '\n')
  chmodSync(path, 0o600)
}

function withAccessLock<T>(path: string, action: () => T): T {
  const lockFile = `${path}.lock`
  const startedAt = Date.now()
  let lease: ProcessLockLease | undefined
  while (true) {
    const attempt = tryAcquireProcessLock(lockFile)
    if (attempt.acquired) {
      lease = attempt.lease
      break
    }
    if (Date.now() - startedAt >= 5_000) {
      throw new Error(`timed out waiting for access config lock: ${lockFile}`)
    }
    Bun.sleepSync(10)
  }
  try {
    return action()
  } finally {
    if (!releaseProcessLock(lockFile, lease!)) {
      throw new AccessLockReleaseError(`failed to release access config lock: ${lockFile}`)
    }
  }
}

export function mutateAccess<T>(
  mutation: (access: AccessConfig) => T,
  path = join(accessStateDir(), 'access.json'),
): T {
  return withAccessLock(path, () => {
    const access = readAccess(path)
    const result = mutation(access)
    writeAccessUnlocked(access, path)
    return result
  })
}

export function writeAccess(
  access: AccessConfig,
  path = join(accessStateDir(), 'access.json'),
): void {
  withAccessLock(path, () => writeAccessUnlocked(access, path))
}

function requireUserId(value: string | undefined): string {
  if (!value || !/^[UW][A-Z0-9]+$/i.test(value)) {
    throw new Error(`invalid Slack user ID: ${value ?? ''}`)
  }
  return value.toUpperCase()
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

export function approvePairing(
  code: string,
  options: { stateDir?: string; now?: number } = {},
): { senderId: string; chatId: string } {
  if (!code) throw new Error('pairing code is required')
  const dir = options.stateDir ?? accessStateDir()
  const path = join(dir, 'access.json')
  const result = mutateAccess(access => {
    const pending = access.pending[code.toLowerCase()]
    if (!pending) throw new Error(`pairing code not found: ${code}`)
    if (pending.expiresAt < (options.now ?? Date.now())) {
      delete access.pending[code.toLowerCase()]
      return { expired: true as const, senderId: '', chatId: '' }
    }
    addUnique(access.allowFrom, pending.senderId)
    delete access.pending[code.toLowerCase()]
    return { expired: false as const, senderId: pending.senderId, chatId: pending.chatId }
  }, path)
  if (result.expired) throw new Error(`pairing code expired: ${code}`)
  if (!/^[A-Z][A-Z0-9]+$/.test(result.senderId)) throw new Error('invalid Slack sender ID')
  const approvedDir = join(dir, 'approved')
  mkdirSync(approvedDir, { recursive: true, mode: 0o700 })
  atomicWritePrivateFile(join(approvedDir, result.senderId), `${result.chatId}\n`)
  return { senderId: result.senderId, chatId: result.chatId }
}

/** Record channel membership for restart catch-up without exposing a policy. */
export function rememberChannel(
  channelIdInput: string,
  path = join(accessStateDir(), 'access.json'),
): boolean {
  if (!/^[CG][A-Z0-9]+$/i.test(channelIdInput)) {
    throw new Error(`invalid Slack channel ID: ${channelIdInput}`)
  }
  const channelId = channelIdInput.toUpperCase()
  if (readAccess(path).channels[channelId]) return false
  return mutateAccess(access => {
    if (access.channels[channelId]) return false
    access.channels[channelId] = { requireMention: true }
    return true
  }, path)
}

function usage(): string {
  return [
    'usage:',
    '  zerochan-access status',
    '  zerochan-access pair <code>',
    '  zerochan-access allow|deny <user-id>',
    '  zerochan-access write allow|deny <user-id>',
    '  zerochan-access policy pairing|allowlist|disabled',
  ].join('\n')
}

async function runCli(args = process.argv.slice(2)): Promise<void> {
  const dir = accessStateDir()
  const path = join(dir, 'access.json')
  const [command = 'status', subcommand, first] = args

  if (command === 'status') {
    const access = readAccess(path)
    process.stdout.write(`${JSON.stringify({
      dmPolicy: access.dmPolicy,
      allowFrom: access.allowFrom,
      writeAllowFrom: access.writeAllowFrom,
      knownChannels: Object.keys(access.channels).sort(),
      pendingCodes: Object.keys(access.pending),
    }, null, 2)}\n`)
    return
  }
  if (command === 'pair') {
    const result = approvePairing(subcommand ?? '', { stateDir: dir })
    process.stdout.write(`paired ${result.senderId}; write access is still disabled\n`)
    return
  }
  if (command === 'allow' || command === 'deny') {
    const userId = requireUserId(subcommand)
    mutateAccess(access => {
      access.allowFrom = command === 'allow'
        ? [...new Set([...access.allowFrom, userId])]
        : access.allowFrom.filter(value => value !== userId)
    }, path)
    process.stdout.write(`${command === 'allow' ? 'allowed' : 'denied'} ${userId}\n`)
    return
  }
  if (command === 'write' && (subcommand === 'allow' || subcommand === 'deny')) {
    const userId = requireUserId(first)
    mutateAccess(access => {
      access.writeAllowFrom = subcommand === 'allow'
        ? [...new Set([...access.writeAllowFrom, userId])]
        : access.writeAllowFrom.filter(value => value !== userId)
    }, path)
    process.stdout.write(`write ${subcommand === 'allow' ? 'allowed' : 'denied'} ${userId}\n`)
    return
  }
  if (command === 'policy') {
    if (!['pairing', 'allowlist', 'disabled'].includes(subcommand ?? '')) {
      throw new Error('policy must be pairing, allowlist, or disabled')
    }
    const policy = subcommand as AccessConfig['dmPolicy']
    mutateAccess(access => { access.dmPolicy = policy }, path)
    process.stdout.write(`dm policy: ${policy}\n`)
    return
  }
  throw new Error(usage())
}

if (import.meta.main) {
  runCli().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`)
    process.exitCode = 1
  })
}
