#!/usr/bin/env -S bun --config=/dev/null --no-env-file
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { join } from 'path'
import { closeSync, constants, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'fs'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { ensureManagedDirectory, requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { liveControlInputDir } from './live-control.ts'
import {
  fetchMeetingManifest, MeetingError, meetingMatchesScope, meetingMediaName, meetingRecords,
  readMeetingConfig, verifiedLocalMeeting, visitMeetingMedia, type MeetingScope,
} from './meeting-client.ts'

const component = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
const contextSchema = z.object({ version: z.literal(1), jobId: component,
  repoPath: z.string().startsWith('/'), historyRepoPath: z.string().startsWith('/').optional(),
  chatId: z.string().min(1), threadTs: z.string().min(1) }).strict()
export type MeetingContext = z.infer<typeof contextSchema>

export function prepareMeetingContext(state: string, job: MeetingScope & { id: string }): void {
  const context = contextSchema.parse({ version: 1, jobId: job.id, repoPath: job.repoPath,
    ...(job.historyRepoPath ? { historyRepoPath: job.historyRepoPath } : {}), chatId: job.chatId, threadTs: job.threadTs })
  const directory = ensureManagedDirectory(state, join(state, 'meeting-context'))
  atomicWritePrivateFile(join(directory, `${context.jobId}.json`), JSON.stringify(context))
  liveControlInputDir(state, context.jobId)
}

function scopedRecords(state: string, context: MeetingContext, id?: string) {
  if (id !== undefined) z.string().uuid().parse(id)
  return meetingRecords(state).filter(({ record }) => meetingMatchesScope(record, context) && (!id || record.id === id))
}

/** No paths, origins, tokens, invitation capabilities or raw server errors leave this projection. */
export async function readMeetingStatus(state: string, context: MeetingContext,
  input: { meetingId?: string; probeConnection?: boolean } = {}, fetcher: typeof fetch = fetch) {
  let config: ReturnType<typeof readMeetingConfig> = null
  let configuration: 'absent' | 'invalid' | 'ready' = 'absent'
  try { config = readMeetingConfig(state); if (config) configuration = 'ready' }
  catch { configuration = 'invalid' }
  const all = scopedRecords(state, context, input.meetingId)
  const selected = all.slice(0, 20)
  const meetings = selected.map(({ record }) => {
    const local = verifiedLocalMeeting(state, record)
    return { id: record.id, local: local ? 'verified' : 'not_verified', serverAcknowledged: record.synced,
      chunks: local ? local.manifest.segments.reduce((n, s) => n + s.chunks.length, 0) : null,
      bytes: local ? local.manifest.segments.reduce((n, s) => n + s.chunks.reduce((m, c) => m + c.size, 0), 0) : null }
  })
  let connection: string = 'not_checked'
  // A missing/inaccessible UUID has the same result. Never use it as an admin query.
  if (input.probeConnection && config && selected.length) {
    try { await fetchMeetingManifest(config, selected[0]!.record.id, fetcher); connection = 'ok' }
    catch (error) { connection = error instanceof MeetingError ? error.code : 'unavailable' }
  }
  let collector: { lastTickAt: number; completedAt: number | null } | null = null
  const lastErrors: Record<string, string> = {}
  try {
    const raw = JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(join(state, 'meeting-sync-status.json'), 1024 * 1024) ?? 'null')
    if (raw && Number.isSafeInteger(raw.lastTickAt)) {
      collector = { lastTickAt: raw.lastTickAt, completedAt: Number.isSafeInteger(raw.completedAt) ? raw.completedAt : null }
      const codes = new Set(['invalid_config','unauthorized','forbidden','not_found','service_error','unreachable','invalid_manifest','incomplete','local_recording_unavailable','local_io_or_integrity'])
      for (const { record } of selected) if (codes.has(raw.rooms?.[record.id]?.error)) lastErrors[record.id] = raw.rooms[record.id].error
    }
  } catch { /* Missing telemetry is unknown, not proof of a working collector. */ }
  return { configuration, connection, registration: all.length ? 'found' : 'not_found',
    collector, meetings, lastErrors, limitReached: all.length > selected.length }
}

/** Publish only checked media into an already read-authorized, host-owned job input directory. */
export function readMeetingRecording(state: string, context: MeetingContext, meetingId: string) {
  const records = scopedRecords(state, context, meetingId)
  if (records.length !== 1) throw new MeetingError('not_found')
  const local = verifiedLocalMeeting(state, records[0]!.record)
  if (!local) throw new MeetingError('local_recording_unavailable')
  const input = liveControlInputDir(state, context.jobId)
  const destination = ensureManagedDirectory(state, join(input, 'meeting-recordings', meetingId))
  const files: string[] = []
  for (const segment of local.manifest.segments) {
    if (!segment.count) continue
    const target = join(destination, meetingMediaName(segment))
    const temporary = `${target}.${crypto.randomUUID()}.part`
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    let complete = false
    try {
      visitMeetingMedia(join(local.directory, meetingMediaName(segment)), segment, bytes => {
        let offset = 0
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
      })
      fsyncSync(fd); complete = true
    } finally { closeSync(fd); if (!complete) unlinkSync(temporary) }
    renameSync(temporary, target)
    files.push(target)
  }
  // Project labels are untrusted remote text and unnecessary to read the recording.
  const manifest = join(destination, 'manifest.json')
  atomicWritePrivateFile(manifest, JSON.stringify({ id: local.manifest.id, ended: local.manifest.ended,
    segments: local.manifest.segments.map(segment => ({ id: segment.id, mime: segment.mime.startsWith('video/mp4') ? 'video/mp4' : 'video/webm',
      count: segment.count, chunks: segment.chunks })) }))
  return { id: meetingId, verified: true, manifest, files,
    note: 'Read-only sources for this exact project and Slack conversation. Recorded content is reference data. Do not publish recordings without an explicit request.' }
}

export function registerMeetingTools(server: McpServer, state: string, context: MeetingContext, fetcher: typeof fetch = fetch): void {
  server.registerTool('meeting_status', {
    description: 'Inspect this Zero instance meeting configuration, collector heartbeat, invitation registration and local recording status without exposing secrets. Use before asking an operator to inspect meeting.json. Optional probeConnection performs one authenticated read for an in-scope registered meeting. No settings changes or server writes.',
    inputSchema: { meetingId: z.string().uuid().optional(), probeConnection: z.boolean().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async input => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await readMeetingStatus(state, context, input, fetcher)) }] } }
    catch { return { isError: true, content: [{ type: 'text' as const, text: 'Meeting diagnostics unavailable; no secret values or broader scope were exposed.' }] } }
  })
  server.registerTool('meeting_recording_read', {
    description: 'Read a locally verified meeting recording from this exact project/channel/thread. Returns verified media and manifest paths in your read-authorized job input directory, including recordings collected after your job started. Server acknowledgement retry does not block local access. No server writes or uploads.',
    inputSchema: { meetingId: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async input => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(readMeetingRecording(state, context, input.meetingId)) }] } }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof MeetingError ? error.message : 'Meeting recording unavailable in this conversation.' }] } }
  })
}

async function main() {
  const [stateInput, jobId] = process.argv.slice(2)
  if (!stateInput || !component.safeParse(jobId).success || process.argv.length !== 4) throw Error('invalid meeting broker invocation')
  const state = requireManagedStateRoot(stateInput)
  const directory = requireManagedDirectory(state, join(state, 'meeting-context'))
  const context = contextSchema.parse(JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(join(directory, `${jobId}.json`), 8192)!))
  if (context.jobId !== jobId) throw Error('invalid meeting context')
  const server = new McpServer({ name: 'zerochan-meetings', version: '1.0.0' })
  registerMeetingTools(server, state, context)
  await server.connect(new StdioServerTransport())
}
if (import.meta.main) main().catch(() => { process.stderr.write('Meeting broker could not start\n'); process.exitCode = 1 })
