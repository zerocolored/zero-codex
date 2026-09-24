import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { CloudLoggingRun } from './cloud-logging-broker.ts'

export type CloudRunQuery = { project: string; region: string; service: string; revision?: string }
const NAME = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const REGION = /^[a-z]+-[a-z]+[1-9][0-9]?$/
const FORMAT = 'json(kind,metadata.name,metadata.labels,spec.template.metadata.name,spec.template.metadata.annotations,spec.template.spec.containerConcurrency,spec.template.spec.timeoutSeconds,spec.template.spec.containers,spec.containerConcurrency,spec.timeoutSeconds,spec.containers,metadata.annotations,status.latestReadyRevisionName,status.latestCreatedRevisionName,status.traffic)'

export function cloudRunArguments(query: CloudRunQuery): string[] {
  if (!PROJECT.test(query.project) || !REGION.test(query.region)
    || !NAME.test(query.service) || (query.revision !== undefined && !NAME.test(query.revision))) {
    throw new Error('Cloud Run requires explicit valid project, region, service and optional revision names')
  }
  return ['run', query.revision ? 'revisions' : 'services', 'describe', query.revision ?? query.service,
    `--project=${query.project}`, `--region=${query.region}`, '--platform=managed', `--format=${FORMAT}`, '--quiet']
}

const object = (value: unknown): Record<string, any> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
)
const name = (value: unknown): string | undefined => typeof value === 'string' && NAME.test(value) ? value : undefined
const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
// Only reviewed, non-secret feature switches have publishable values. Unknown
// settings remain hidden even when they happen to contain digits or booleans.
const BOOLEAN_SETTINGS = new Set([
  'SEMANTIC_SEARCH', 'SCORED_CAND_PREFILTER', 'KEYWORD_PER_SURFACE', 'SEMANTIC_CONCEPT_CANON',
  'NATURAL_QUERY_REWRITE', 'SEARCH_SHIP_ROLE', 'SEARCH_ANCHOR_RELAX', 'SEARCH_BOILERPLATE',
  'CHAT_ANSWER', 'SEARCH_LIKE_ANY', 'SEARCH_QUERY_PLAN', 'SEARCH_RETRY_AFTER_TIMEOUT',
  'SEARCH_EXACT_PHRASE', 'EVENT_WRITE_MAINTENANCE', 'SEARCH_EMAIL_TOPIC',
  'SEARCH_BODY_SIMPLE_FTS', 'SEARCH_BODY_SIMPLE_FTS_RETRY_SUPPRESS',
])
function environment(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 1000).map(raw => {
    const row = object(raw)
    const key = typeof row.name === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/.test(row.name) ? row.name : '[redacted]'
    if (row.valueFrom !== undefined) return { name: key, source: 'reference', value: '[redacted]' }
    const safe = BOOLEAN_SETTINGS.has(key) && typeof row.value === 'string'
      && /^(?:0|1|true|false|on|off|enabled|disabled)$/.test(row.value)
    return { name: key, source: 'literal', value: safe ? row.value : '[redacted]' }
  })
}
function scaling(value: unknown): Record<string, string> {
  const annotations = object(value)
  const result: Record<string, string> = {}
  for (const key of ['autoscaling.knative.dev/minScale', 'autoscaling.knative.dev/maxScale',
    'run.googleapis.com/minScale', 'run.googleapis.com/maxScale']) {
    if (typeof annotations[key] === 'string' && /^\d{1,6}$/.test(annotations[key])) result[key] = annotations[key]
  }
  for (const key of ['run.googleapis.com/cpu-throttling', 'run.googleapis.com/startup-cpu-boost']) {
    if (annotations[key] === 'true' || annotations[key] === 'false') result[key] = annotations[key]
  }
  return result
}
function configuration(spec: Record<string, any>): unknown {
  return {
    timeoutSeconds: integer(spec.timeoutSeconds), containerConcurrency: integer(spec.containerConcurrency),
    containers: (Array.isArray(spec.containers) ? spec.containers : []).slice(0, 10).map(raw => {
      const container = object(raw)
      const limits = object(object(container.resources).limits)
      const resources: Record<string, string> = {}
      for (const key of ['cpu', 'memory']) {
        if (typeof limits[key] === 'string' && /^\d+(?:\.\d+)?(?:m|Ki|Mi|Gi|Ti)?$/.test(limits[key])) resources[key] = limits[key]
      }
      return { name: name(container.name), resources, environment: environment(container.env) }
    }),
  }
}

export async function describeCloudRun(query: CloudRunQuery, run: CloudLoggingRun, signal?: AbortSignal): Promise<unknown> {
  const response = await run(cloudRunArguments(query), signal)
  if (response.timedOut) throw new Error('Cloud Run description timed out')
  if (response.exitCode !== 0) {
    if (/PERMISSION_DENIED|permission denied/i.test(response.stderr)) throw new Error('Host gcloud lacks Cloud Run read permission for this resource')
    if (/invalid_grant|reauthentication|login|credentials/i.test(response.stderr)) throw new Error('Host gcloud authentication needs operator renewal')
    if (/NOT_FOUND|not found/i.test(response.stderr)) throw new Error('Cloud Run resource was not found in the requested project and region')
    throw new Error('Host Cloud Run description failed')
  }
  let raw: Record<string, any>
  try { raw = object(JSON.parse(response.stdout)) } catch { throw new Error('Cloud Run returned invalid JSON') }
  const metadata = object(raw.metadata)
  const labels = object(metadata.labels)
  if (metadata.name !== (query.revision ?? query.service)
    || raw.kind !== (query.revision ? 'Revision' : 'Service')
    || labels['cloud.googleapis.com/location'] !== query.region
    || (query.revision && labels['serving.knative.dev/service'] !== query.service)) {
    throw new Error('Cloud Run returned a different resource or invalid description')
  }
  const spec = object(raw.spec)
  const template = object(spec.template)
  const status = object(raw.status)
  return {
    project: query.project, region: query.region, service: query.service, revision: query.revision,
    configurationSource: query.revision ? 'revision' : 'service-template',
    templateRevision: name(object(template.metadata).name),
    latestReadyRevision: name(status.latestReadyRevisionName), latestCreatedRevision: name(status.latestCreatedRevisionName),
    traffic: (Array.isArray(status.traffic) ? status.traffic : []).slice(0, 100).map(raw => {
      const row = object(raw)
      return { revision: name(row.revisionName), percent: typeof row.percent === 'number' && row.percent <= 100 ? integer(row.percent) : undefined,
        latestRevision: typeof row.latestRevision === 'boolean' ? row.latestRevision : undefined }
    }),
    serviceScaling: query.revision ? undefined : scaling(metadata.annotations),
    revisionScaling: scaling(query.revision ? metadata.annotations : object(template.metadata).annotations),
    configuration: configuration(query.revision ? spec : object(template.spec)),
    note: 'Read-only host IAM result. Service templates may differ from revisions serving traffic; describe each serving revision explicitly before concluding live settings. Omitted fields are unspecified, not zero. Secrets, reference identifiers and unreviewed environment values are redacted.',
  }
}

export function registerCloudRunTool(server: McpServer, run: CloudLoggingRun): void {
  server.registerTool('cloud_run_describe', {
    description: 'Read Cloud Run service configuration and traffic with host gcloud authentication. Supply explicit project, region and service. Set revision to inspect a serving revision: the default service template may not be live. Returns limits/scaling and conservatively redacted environment settings. A browser Console permission error does not imply this host IAM path is unavailable. No IAM, login, deployment or configuration writes.',
    inputSchema: { project: z.string(), region: z.string(), service: z.string(), revision: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async (query, extra) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await describeCloudRun(query, run, extra.signal)) }] } }
    catch (error) {
      const message = error instanceof Error ? error.message : ''
      const safe = /^(?:Cloud Run|Host gcloud|Host Cloud Run)/.test(message)
      return { isError: true, content: [{ type: 'text' as const, text: safe ? message : 'Cloud Run operation failed' }] }
    }
  })
}
