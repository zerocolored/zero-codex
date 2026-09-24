import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { cloudRunArguments, describeCloudRun, registerCloudRunTool } from './cloud-run-reader.ts'

const query = { project: 'test-project', region: 'asia-northeast1', service: 'test-web' }
function fixture() {
  return { kind: 'Service', metadata: { name: query.service, labels: { 'cloud.googleapis.com/location': query.region },
    annotations: { 'run.googleapis.com/minScale': '1', custom: 'hidden' } },
  spec: { template: { metadata: { name: 'test-web-new', annotations: { 'autoscaling.knative.dev/maxScale': '5' } }, spec: {
    timeoutSeconds: 300, containerConcurrency: 80, containers: [{ name: 'web', resources: { limits: { cpu: '1', memory: '512Mi' } },
      env: [{ name: 'SEMANTIC_SEARCH', value: '1' }, { name: 'AUTH_PASSWORD', value: 'numeric-secret' },
        { name: 'UNKNOWN_KEY', value: '123456' }, { name: 'SEARCH_SHIP_ROLE', valueFrom: { secretKeyRef: { name: 'secret-reference', key: 'latest' } } }],
      args: ['private-argument'], command: ['private-command'], image: 'private-image' }, { name: 'sidecar', env: [] }],
  } } }, status: { latestReadyRevisionName: 'test-web-new', traffic: [{ revisionName: 'test-web-old', percent: 90, url: 'private-url' }, { revisionName: 'test-web-new', percent: 10 }] } }
}
const response = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })

test('Cloud Run command is fixed and target inputs cannot inject flags or alternate operations', () => {
  expect(cloudRunArguments(query).slice(0, 4)).toEqual(['run', 'services', 'describe', 'test-web'])
  expect(cloudRunArguments({ ...query, revision: 'test-web-old' }).slice(0, 4)).toEqual(['run', 'revisions', 'describe', 'test-web-old'])
  for (const field of ['project', 'region', 'service', 'revision']) {
    for (const value of ['', '--log-http', 'name\n--configuration=other', 'a/b', 'a'.repeat(65)]) {
      expect(() => cloudRunArguments({ ...query, [field]: value })).toThrow('explicit valid')
    }
  }
})

test('descriptions expose actual traffic separately from template and project secret-free configuration', async () => {
  const result = await describeCloudRun(query, async () => response(fixture())) as any
  expect(result.configurationSource).toBe('service-template')
  expect(result.traffic).toEqual([{ revision: 'test-web-old', percent: 90 }, { revision: 'test-web-new', percent: 10 }])
  expect(result.serviceScaling).toEqual({ 'run.googleapis.com/minScale': '1' })
  expect(result.revisionScaling).toEqual({ 'autoscaling.knative.dev/maxScale': '5' })
  expect(result.configuration.containers).toHaveLength(2)
  expect(result.configuration.containers[0].resources).toEqual({ cpu: '1', memory: '512Mi' })
  expect(result.configuration.containers[0].environment[0].value).toBe('1')
  for (const secret of ['numeric-secret', '123456', 'secret-reference', 'private-argument', 'private-command', 'private-image', 'private-url']) {
    expect(JSON.stringify(result)).not.toContain(secret)
  }
})

test('arbitrary structured values cannot escape, and omitted settings do not become zero', async () => {
  const raw: any = fixture()
  raw.spec.template.spec = { containers: [{ resources: { limits: { cpu: { password: 'hidden' } } }, env: [
    { name: 'SEMANTIC_SEARCH', value: { token: 'hidden' } }, { name: 'AUTH_PASSWORD', value: '1' },
    { name: 'UNKNOWN_KEY', value: 'true' }, { name: 'SEMANTIC_SEARCH', value: 'Bearer hidden' },
  ] }] }
  const result = await describeCloudRun(query, async () => response(raw)) as any
  expect(result.configuration.timeoutSeconds).toBeUndefined()
  expect(result.configuration.containerConcurrency).toBeUndefined()
  expect(result.configuration.containers[0].resources).toEqual({})
  expect(result.configuration.containers[0].environment.every((row: any) => row.value === '[redacted]')).toBe(true)
  expect(JSON.stringify(result)).not.toContain('hidden')
})

test('revision belongs to the requested service and its own settings are returned', async () => {
  const raw: any = fixture()
  raw.kind = 'Revision'; raw.metadata.name = 'test-web-old'
  raw.metadata.labels['serving.knative.dev/service'] = query.service
  raw.spec = { ...raw.spec.template.spec, timeoutSeconds: 60 }
  const target = { ...query, revision: 'test-web-old' }
  expect((await describeCloudRun(target, async () => response(raw)) as any).configuration.timeoutSeconds).toBe(60)
  raw.metadata.labels['serving.knative.dev/service'] = 'other-web'
  await expect(describeCloudRun(target, async () => response(raw))).rejects.toThrow('different resource')
})

test('bad shapes and resource mismatches fail instead of masquerading as empty settings', async () => {
  for (const raw of [[], null, {}, { ...fixture(), kind: 'Revision' }, { ...fixture(), metadata: { name: 'other-web' } }]) {
    await expect(describeCloudRun(query, async () => response(raw))).rejects.toThrow('different resource')
  }
})

test('MCP validates inputs and distinguishes IAM, auth, timeout and missing resources without raw diagnostics', async () => {
  let answer = response(fixture()) as any
  let calls = 0
  const server = new McpServer({ name: 'cloud-run-test', version: '1' })
  registerCloudRunTool(server, async (_, signal) => { calls++; expect(signal).toBeDefined(); return answer })
  const client = new Client({ name: 'test-client', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(a), server.connect(b)])
  try {
    expect((await client.listTools()).tools[0].annotations?.readOnlyHint).toBe(true)
    expect((await client.callTool({ name: 'cloud_run_describe', arguments: {} })).isError).toBe(true)
    expect(calls).toBe(0)
    expect((await client.callTool({ name: 'cloud_run_describe', arguments: query })).isError).not.toBe(true)
    for (const [stderr, message] of [['PERMISSION_DENIED private-account', 'lacks Cloud Run read permission'],
      ['invalid_grant private-account', 'authentication needs operator renewal'], ['NOT_FOUND private-account', 'was not found']]) {
      answer = { exitCode: 1, stdout: '', stderr }
      const result = await client.callTool({ name: 'cloud_run_describe', arguments: query })
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain(message)
      expect(JSON.stringify(result)).not.toContain('private-account')
    }
    for (const failure of [{ exitCode: 0, stdout: '{', stderr: '' }, { ...response({}), timedOut: true }]) {
      answer = failure
      expect((await client.callTool({ name: 'cloud_run_describe', arguments: query })).isError).toBe(true)
    }
  } finally { await client.close(); await Bun.sleep(0); await server.close() }
})
