import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { prepareManagedStateRoot, ensureManagedDirectory } from './managed-path.ts'
import { atomicWritePrivateFile } from './safe-file.ts'
import { prepareMeetingContext, readMeetingRecording, readMeetingStatus, type MeetingContext } from './meeting-broker.ts'
import { meetingRecordingDirectories, readMeetingConfig, syncMeetingRecordings, startMeetingSync } from './meeting-client.ts'
import { buildCodexPermissionOverrides } from './codex-executor.ts'
import { liveControlInputDir } from './live-control.ts'
import { resolveOfficialStandaloneCodex } from './standalone-codex.ts'
import type { JobRecord } from './job-runner.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const id = '4beb4076-a742-416e-bdd4-a5b15665f4c0'
const segmentId = '4305b60a-b583-45d9-8aa9-b33656428fab'
const token = 'synthetic-secret-not-to-be-returned-1234567890'
const capability = 'f'.repeat(64)
function fixture(count = 27) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-meeting-test-'))); roots.push(root)
  const state = prepareManagedStateRoot(join(root, 'state'))
  const repo = join(root, 'repo'); mkdirSync(repo)
  const context: MeetingContext = { version: 1, jobId: 'current', repoPath: repo, chatId: 'C1', threadTs: '1.0' }
  prepareMeetingContext(state, { ...context, id: context.jobId })
  atomicWritePrivateFile(join(state, 'meeting.json'), JSON.stringify({ origin: 'https://meeting.example', adminToken: token }))
  const directory = ensureManagedDirectory(state, join(state, 'meetings'))
  const registration = join(directory, `${'a'.repeat(64)}.json`)
  const record = { id, url: `https://meeting.example/room/${id}#${capability}`, expires: 100,
    repo, chat: context.chatId, thread: context.threadTs, requestId: 'original', synced: false }
  atomicWritePrivateFile(registration, JSON.stringify(record))
  const chunks = Array.from({ length: count }, (_, i) => Buffer.from(`recording-chunk-${i}\n`))
  const manifest = { id, project: 'fixture', ended: 123 as number | null, segments: [{ id: segmentId, mime: 'video/webm', count: chunks.length as number | null, state: 'uploaded',
    chunks: chunks.map((b, seq) => ({ seq, hash: createHash('sha256').update(b).digest('hex'), size: b.length })) }] }
  const calls: string[] = []
  let ackStatus = 200, manifestStatus = 200, corrupt = false
  const fetcher = (async (url, options) => {
    expect(options?.redirect).toBe('error')
    expect((options?.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`)
    const path = new URL(String(url)).pathname; calls.push(`${options?.method ?? 'GET'} ${path}`)
    if (path.endsWith('/manifest')) return Response.json(manifest, { status: manifestStatus })
    if (path.endsWith('/received')) return new Response('opaque response', { status: ackStatus })
    const seq = Number(path.split('/').at(-1))
    return new Response(corrupt ? 'broken' : chunks[seq]!)
  }) as typeof fetch
  return { root, state, repo, context, registration, record, chunks, manifest, calls, fetcher,
    ack: (status: number) => { ackStatus = status }, auth: (status: number) => { manifestStatus = status }, corrupt: () => { corrupt = true } }
}

test('configuration and scoped authentication diagnostics never reveal secrets or invitation URLs', async () => {
  const f = fixture()
  const good = await readMeetingStatus(f.state, f.context, { meetingId: id, probeConnection: true }, f.fetcher)
  expect(good).toMatchObject({ configuration: 'ready', connection: 'ok', registration: 'found' })
  for (const forbidden of [token, capability, 'https://meeting.example', f.repo, 'adminToken']) expect(JSON.stringify(good)).not.toContain(forbidden)
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [500, 'service_error']] as const) {
    f.auth(status)
    expect((await readMeetingStatus(f.state, f.context, { probeConnection: true }, f.fetcher)).connection).toBe(code)
  }
  expect((await readMeetingStatus(f.state, f.context, { probeConnection: true }, (async () => { throw Error(token) }) as typeof fetch)).connection).toBe('unreachable')
  rmSync(join(f.state, 'meeting.json'))
  expect((await readMeetingStatus(f.state, f.context)).configuration).toBe('absent')
  atomicWritePrivateFile(join(f.state, 'meeting.json'), JSON.stringify({ origin: token, adminToken: token }))
  expect(() => readMeetingConfig(f.state)).toThrow('Meeting operation: invalid_config')
  expect((await readMeetingStatus(f.state, f.context)).configuration).toBe('invalid')
})

test('unknown UUID and other project/channel/thread registrations never become admin queries', async () => {
  const f = fixture()
  for (const scope of [{ ...f.context, repoPath: '/other' }, { ...f.context, chatId: 'C2' }, { ...f.context, threadTs: '2.0' }]) {
    expect(await readMeetingStatus(f.state, scope, { meetingId: id, probeConnection: true }, f.fetcher)).toMatchObject({ registration: 'not_found', connection: 'not_checked', meetings: [] })
    expect(() => readMeetingRecording(f.state, scope, id)).toThrow('not_found')
  }
  expect(f.calls).toHaveLength(0)
  expect((await readMeetingStatus(f.state, { ...f.context, repoPath: '/worktree', historyRepoPath: f.repo })).registration).toBe('found')
})

test('27 verified chunks stay readable during failed acknowledgement and retry reuses assembled media', async () => {
  const f = fixture(); f.ack(503)
  await expect(syncMeetingRecordings(f.state, f.fetcher)).rejects.toThrow('pending')
  const status = await readMeetingStatus(f.state, f.context)
  expect(status.meetings[0]).toMatchObject({ local: 'verified', chunks: 27, serverAcknowledged: false })
  expect(status.lastErrors[id]).toBe('service_error')
  expect(meetingRecordingDirectories(f.state, f.context)).toHaveLength(1)
  const output = readMeetingRecording(f.state, f.context, id)
  expect(readFileSync(output.files[0]!)).toEqual(Buffer.concat(f.chunks))
  expect(output.files[0]!.startsWith(liveControlInputDir(f.state, f.context.jobId))).toBe(true)
  const original = join(f.state, 'meeting-recordings', id, `${segmentId}.webm`)
  const before = statSync(original).mtimeMs
  f.calls.length = 0; f.ack(200)
  await syncMeetingRecordings(f.state, f.fetcher)
  expect(f.calls).toEqual([`GET /api/rooms/${id}/manifest`, `POST /api/rooms/${id}/received`])
  expect(statSync(original).mtimeMs).toBe(before)
  expect(JSON.parse(readFileSync(f.registration, 'utf8')).synced).toBe(true)
  f.calls.length = 0
  await syncMeetingRecordings(f.state, f.fetcher)
  expect(f.calls).toHaveLength(0)
})

test('same-sized media corruption is refused and rebuilt from retained chunks, not trusted by receipt', async () => {
  const f = fixture(2); f.ack(503)
  await expect(syncMeetingRecordings(f.state, f.fetcher)).rejects.toThrow()
  const path = join(f.state, 'meeting-recordings', id, `${segmentId}.webm`)
  writeFileSync(path, Buffer.alloc(statSync(path).size, 120), { mode: 0o600 })
  expect(() => readMeetingRecording(f.state, f.context, id)).toThrow('local_recording_unavailable')
  expect((await readMeetingStatus(f.state, f.context)).meetings[0]!.local).toBe('not_verified')
  f.calls.length = 0; f.ack(200)
  await syncMeetingRecordings(f.state, f.fetcher)
  expect(f.calls.some(c => c.includes('/chunks/'))).toBe(false)
  expect(readFileSync(readMeetingRecording(f.state, f.context, id).files[0]!)).toEqual(Buffer.concat(f.chunks))
})

test('partial, incomplete, corrupt and mismatched manifests never publish complete recordings', async () => {
  for (const kind of ['partial', 'incomplete', 'corrupt', 'mismatch'] as const) {
    const f = fixture(2)
    if (kind === 'partial') f.manifest.ended = null
    if (kind === 'incomplete') f.manifest.segments[0]!.count = 3
    if (kind === 'corrupt') f.corrupt()
    if (kind === 'mismatch') f.manifest.id = crypto.randomUUID()
    if (kind === 'partial') await syncMeetingRecordings(f.state, f.fetcher)
    else await expect(syncMeetingRecordings(f.state, f.fetcher)).rejects.toThrow()
    expect(existsSync(join(f.state, 'meeting-recordings', id, 'receipt.json'))).toBe(false)
    expect(() => readMeetingRecording(f.state, f.context, id)).toThrow('local_recording_unavailable')
    expect(f.calls.some(c => c.startsWith('POST'))).toBe(false)
  }
})

test('one malformed registry does not block a valid meeting, and a registry symlink is not followed', async () => {
  const f = fixture(1)
  atomicWritePrivateFile(join(f.state, 'meetings', `${'b'.repeat(64)}.json`), '{invalid')
  await syncMeetingRecordings(f.state, f.fetcher)
  expect(readMeetingRecording(f.state, f.context, id).verified).toBe(true)
  rmSync(join(f.state, 'meetings'), { recursive: true })
  symlinkSync(f.repo, join(f.state, 'meetings'))
  await expect(readMeetingStatus(f.state, f.context)).rejects.toThrow()
})

test('the gateway collector starts immediately and records configuration absence without secrets', async () => {
  const f = fixture(); rmSync(join(f.state, 'meeting.json'))
  let warnings = 0
  const stop = startMeetingSync(f.state, () => { warnings++ })
  try {
    await Bun.sleep(20)
    const heartbeat = JSON.parse(readFileSync(join(f.state, 'meeting-sync-status.json'), 'utf8'))
    expect(heartbeat.config).toBe('absent'); expect(heartbeat.completedAt).toBeNumber(); expect(warnings).toBe(0)
    expect(JSON.stringify(heartbeat)).not.toContain(token)
  } finally { stop() }
})

test('real stdio broker serves read-only diagnostics and newly collected media from its fixed host context', async () => {
  const f = fixture(2)
  const client = new Client({ name: 'meeting-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--config=/dev/null', '--no-env-file', join(import.meta.dir, 'meeting-broker.ts'), f.state, f.context.jobId], stderr: 'pipe' })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['meeting_status', 'meeting_recording_read'])
    const before = await client.callTool({ name: 'meeting_status', arguments: { meetingId: id } })
    expect(JSON.stringify(before)).toContain('not_verified')
    await syncMeetingRecordings(f.state, f.fetcher)
    const after = await client.callTool({ name: 'meeting_recording_read', arguments: { meetingId: id } })
    expect(after.isError).not.toBe(true)
    expect(JSON.stringify(after)).not.toContain(token)
    expect(JSON.stringify(after)).toContain('live-input')
  } finally { await client.close(); await transport.close() }
})

test('existing read-only sandbox can read later exported media but cannot read meeting configuration', async () => {
  const f = fixture(2)
  const live = liveControlInputDir(f.state, f.context.jobId)
  const scratch = ensureManagedDirectory(f.state, join(f.state, 'scratch'))
  const out = ensureManagedDirectory(f.state, join(f.state, 'out'))
  const overrides = buildCodexPermissionOverrides({ ...f.context, id: f.context.jobId, writeEnabled: false, attachments: [] } as unknown as JobRecord,
    { stateDir: f.state, liveInputDir: live, scratchDir: scratch, artifactDir: out, profile: 'meeting_read_test', executionWriteEnabled: false })
  await syncMeetingRecordings(f.state, f.fetcher)
  const result = readMeetingRecording(f.state, f.context, id)
  const codex = resolveOfficialStandaloneCodex().physical
  const run = (path: string) => Bun.spawnSync([codex, 'sandbox', '-C', f.repo, ...overrides.flatMap(v => ['-c', v]), '-P', 'meeting_read_test', '--', '/bin/cat', path],
    { cwd: f.repo, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME! }, stdout: 'pipe', stderr: 'pipe' })
  const allowed = run(result.files[0]!)
  expect(allowed.exitCode).toBe(0); expect(Buffer.from(allowed.stdout)).toEqual(Buffer.concat(f.chunks))
  expect(run(join(f.state, 'meeting.json')).exitCode).not.toBe(0)
}, 30_000)
