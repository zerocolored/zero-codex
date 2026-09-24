import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { cloudLoggingArguments, readCloudLogs, registerCloudLoggingTool, type CloudLoggingRun } from './cloud-logging-broker.ts'
import { runBoundedHostCommand } from './github-publication.ts'

const query = { project: 'test-project', startTime: '2026-09-21T00:00:00Z', endTime: '2026-09-21T06:00:00Z', limit: 10 }
function row(textPayload = 'Starting new instance') {
  return { logName: 'projects/test-project/logs/run.googleapis.com%2Fvarlog%2Fsystem', timestamp: query.startTime, textPayload }
}

test('valid explicit projects reach host IAM without repository policy configuration', async () => {
  for (const project of ['bsb-staging', 'other-project', 'another-project-123']) {
    const calls: string[][] = []
    const result = await readCloudLogs({ ...query, project }, async args => {
      calls.push(args)
      return { exitCode: 0, stdout: '[]', stderr: '' }
    }) as any
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(`--project=${project}`)
    expect(result.project).toBe(project)
  }
})

test('project and fixed command cannot be replaced by model flags; time and row budgets are bounded', () => {
  const args = cloudLoggingArguments({ ...query, filter: 'resource.type="cloud_run_revision"' })
  expect(args.slice(0, 2)).toEqual(['logging', 'read'])
  expect(args).toContain('--project=test-project')
  expect(args[2]).toContain('timestamp >= "2026-09-21T00:00:00.000Z"')
  expect(args[2]).toContain('resource.type="cloud_run_revision"')
  for (const project of ['', '--project=other-project', 'test-project\n--log-http']) {
    expect(() => cloudLoggingArguments({ ...query, project })).toThrow('explicit valid project ID')
  }
  for (const change of [{ limit: 1001 }, { limit: 0 }, { endTime: '2026-10-01T00:00:00Z' }, { startTime: '--log-http' }, { filter: '\0' }]) {
    expect(() => cloudLoggingArguments({ ...query, ...change })).toThrow()
  }
  expect(args.some(value => value.startsWith('--impersonate'))).toBe(false)
  expect(args.some(value => value.startsWith('--configuration'))).toBe(false)
  for (const filter of [
    'severity=ERROR) OR timestamp >= "2000-01-01T00:00:00Z" OR (severity=ERROR',
    'severity=INFO -- (\n ) OR severity=ERROR OR (severity=INFO -- )\n',
    'textPayload="unterminated',
  ]) expect(() => cloudLoggingArguments({ ...query, filter })).toThrow('filter')
  const nested = cloudLoggingArguments({ ...query, filter: '(severity=ERROR OR textPayload="a ) \\" b")' })
  expect(nested[2]).toContain(') AND ((severity=ERROR OR')
})

test('log output drops foreign projects, redacts credential-shaped text, and marks limit-sized results', async () => {
  const token = 'ya29.' + 'a'.repeat(40)
  const run: CloudLoggingRun = async () => ({ exitCode: 0, stdout: JSON.stringify([
    row(token), row('person@example.invalid'), { ...row(), logName: 'projects/other-project/logs/private' },
  ]), stderr: '' })
  const result = await readCloudLogs({ ...query, limit: 3 }, run) as any
  expect(result.rows).toHaveLength(2)
  expect(result.rows.every((value: any) => value.textPayload === '[redacted]')).toBe(true)
  expect(result.limitReached).toBe(true)
  expect(JSON.stringify(result)).not.toContain(token)
  const empty = await readCloudLogs(query, async () => ({ exitCode: 0, stdout: '[]\n', stderr: '' })) as any
  expect(empty.rows).toEqual([])
  expect(empty.limitReached).toBe(false)
})

test('CLI failures never expose raw account or authentication diagnostics', async () => {
  for (const failure of [
    { exitCode: 1, stderr: 'PERMISSION_DENIED person@example.invalid', stdout: '' },
    { exitCode: 1, stderr: 'Reauthentication https://private.invalid/login', stdout: '' },
    { exitCode: 0, stderr: '', stdout: 'not json' },
    { exitCode: 0, stderr: '', stdout: '{}', timedOut: true },
  ]) {
    try { await readCloudLogs(query, async () => failure); throw new Error('unexpected success') } catch (error) {
      expect(String(error)).not.toContain('person@example.invalid')
      expect(String(error)).not.toContain('private.invalid')
      expect(String(error)).not.toContain('unexpected success')
    }
  }
})

test('structured messages, arbitrary payloads and nonnumeric metrics cannot escape the output projection', async () => {
  const secret = 'opaqueCredential123456'
  const raw = [
    { ...row(), textPayload: { token: secret }, jsonPayload: { message: { token: secret }, durationMs: { password: secret }, count: 42, other: secret }, httpRequest: { latency: secret, requestUrl: secret }, surprise: secret },
    { ...row(), jsonPayload: { message: JSON.stringify({ password: secret }), durationMs: 9.36 } },
  ]
  const result = await readCloudLogs(query, async () => ({ exitCode: 0, stdout: JSON.stringify(raw), stderr: '' })) as any
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(result.rows[0].jsonPayload).toEqual({ count: 42 })
  expect(result.rows[0].httpRequest).toEqual({})
  expect(result.rows[1].jsonPayload).toEqual({ message: '[redacted]', durationMs: 9.36 })
})

test('MCP requires explicit query and uses actual IAM denial instead of a repository allowlist', async () => {
  let denied = false
  const calls: string[][] = []
  const server = new McpServer({ name: 'cloud-test', version: '1' })
  registerCloudLoggingTool(server, async (args, signal) => {
    expect(signal).toBeDefined(); calls.push(args)
    if (denied) return { exitCode: 1, stdout: '', stderr: 'PERMISSION_DENIED person@example.invalid' }
    return { exitCode: 0, stdout: JSON.stringify([row()]), stderr: '' }
  })
  const client = new Client({ name: 'cloud-client', version: '1' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(left), server.connect(right)])
  try {
    expect((await client.listTools()).tools.map(value => value.name)).toEqual(['cloud_logging_read'])
    for (const missing of [{}, { project: query.project }, { ...query, project: '--log-http' },
      { ...query, startTime: undefined }, { ...query, endTime: undefined }]) {
      const invalid = await client.callTool({ name: 'cloud_logging_read', arguments: missing })
      expect(invalid.isError).toBe(true)
    }
    expect(calls).toHaveLength(0)
    const result = await client.callTool({ name: 'cloud_logging_read', arguments: query })
    expect(result.isError).not.toBe(true); expect(calls).toHaveLength(1)
    denied = true
    const rejected = await client.callTool({ name: 'cloud_logging_read', arguments: query })
    expect(rejected.isError).toBe(true); expect(calls).toHaveLength(2)
    expect(JSON.stringify(rejected)).toContain('Host gcloud lacks Cloud Logging read permission')
    expect(JSON.stringify(rejected)).not.toContain('person@example.invalid')
  } finally { await client.close(); await Bun.sleep(0); await server.close() }
})

test('host command adapter bounds output and terminates timed-out or cancelled processes', async () => {
  const env = { PATH: '/usr/bin:/bin', HOME: '/var/empty' }
  const timeout = await runBoundedHostCommand(['/bin/sleep', '30'], env, undefined, undefined, 40, '/')
  expect(timeout.timedOut).toBe(true)
  const controller = new AbortController()
  const cancelled = runBoundedHostCommand(['/bin/sleep', '30'], env, undefined, controller.signal, 5000, '/')
  controller.abort()
  await expect(cancelled).rejects.toThrow('interrupted')
  await expect(runBoundedHostCommand([process.execPath, '-e', 'process.stdout.write("x".repeat(3*1024*1024))'], env, undefined, undefined, 5000, '/')).rejects.toThrow('output exceeded')
}, 20_000)
