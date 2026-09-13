import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { CloudHandoffClient, CLOUD_WAIT_MESSAGE, handoffSchema, type CloudHandoff } from './cloud-handoff.ts'
import { decodePackage, encodePackage, type HandoffPackage } from './handoff-package.ts'

export interface HandoffJournal {
  binding(jobId: string): { state: string; receipt: string; packagePath: string | null; resetAt?: number | null } | null
  bind(jobId: string, h: CloudHandoff): void
  park(jobId: string, resetAt: number | null): void
  published(jobId: string, h: CloudHandoff, path: string, message: string): void
  transferred(jobId: string, h: CloudHandoff): void
}
export class CloudCheckpointBlockedError extends Error {
  constructor() { super('checkpoint capture requires local file inspection') }
}

export function writeCheckpoint(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
  const parent = openSync(dirname(path), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}

/** Network failures never release the local wait flag. Retries publish the
 * already-frozen bytes, rather than resnapshotting a potentially changed repo. */
export class HandoffCoordinator {
  constructor(private readonly cloud: CloudHandoffClient, private readonly journal: HandoffJournal,
    private readonly checkpointRoot: string) {}

  async claim(jobId: string, channel: string, thread: string): Promise<void> {
    const current = this.journal.binding(jobId)
    if (current && current.state !== 'active') throw new Error('job is waiting for explicit handoff control')
    const h = await this.cloud.claim(channel, thread)
    this.journal.bind(jobId, h)
  }

  async pause(jobId: string, resetAt: number | null, quiesce: () => Promise<void>,
    capture: () => Promise<HandoffPackage>): Promise<void> {
    const binding = this.journal.binding(jobId)
    if (!binding) throw new Error('cloud owner binding missing')
    await quiesce()
    resetAt ??= binding.resetAt ?? null
    this.journal.park(jobId, resetAt)
    let h = handoffSchema.parse(JSON.parse(binding.receipt))
    const remote = await this.cloud.find(h.channel_id, h.thread_ts)
    if (remote && remote.id === h.id && remote.epoch > h.epoch) {
      // Publication may have succeeded even when its response was lost. A
      // later epoch is authoritative: never republish or run the old writer.
      this.journal.transferred(jobId, remote)
      return
    }
    if (!remote || remote.owner_id !== h.owner_id || remote.epoch !== h.epoch) throw new Error('cloud ownership changed')
    h = remote
    if (h.state !== 'waiting') h = await this.cloud.saving(h, resetAt)
    const path = join(this.checkpointRoot, `${h.id}-${h.epoch}.json`)
    // The local durable package survives upload failure and process restart.
    let bytes: Uint8Array
    try { bytes = readFileSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { bytes = encodePackage(await capture()) } catch { throw new CloudCheckpointBlockedError() }
      writeCheckpoint(path, bytes)
    }
    try { decodePackage(bytes) } catch { throw new CloudCheckpointBlockedError() }
    const ready = await this.cloud.publish(h, bytes, resetAt ?? (h.reset_at ? Date.parse(h.reset_at) : null))
    this.journal.published(jobId, ready, path, CLOUD_WAIT_MESSAGE)
  }

  async acquire(channel: string, thread: string, eventId: string,
    preflight: (packet: HandoffPackage) => Promise<void>,
    restoreAndRecord: (h: CloudHandoff, packet: HandoffPackage) => Promise<void>): Promise<CloudHandoff> {
    const h = await this.cloud.find(channel, thread)
    if (!h || !['waiting', 'importing', 'active'].includes(h.state)) throw new Error('no waiting handoff exists')
    const packet = decodePackage(await this.cloud.download(h))
    // Repository availability is checked before transferring execution rights.
    await preflight(packet)
    const owned = await this.cloud.take(h, eventId)
    // This callback must use an import receipt and an idempotent enqueue key.
    // A crash leaves state importing; it does not grant the previous PC rights.
    await restoreAndRecord(owned, packet)
    return this.cloud.activate(owned)
  }
}
