#!/usr/bin/env -S bun --config=/dev/null --no-env-file
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { join } from 'path'
import { requireManagedDirectory, requireManagedStateRoot } from './managed-path.ts'
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { readTaskUsage, type UsageContext } from './task-usage.ts'

export function registerTaskUsageTool(server: McpServer, state: string, context: UsageContext): void {
  server.registerTool('task_usage_read', {
    description: 'Read retained Codex and Claude token usage for this conversation from host records, including older job logs. Call this before saying your own task usage is inaccessible. No raw logs, credentials or arbitrary paths. Omit taskNumbers to list ten recent tasks; select task numbers or paginate with beforeTaskNumber. Missing/partial is never zero. Grok excluded. Counts are not prices or subscription bills.',
    inputSchema: { taskNumbers: z.array(z.number().int().positive()).min(1).max(10).optional(), beforeTaskNumber: z.number().int().positive().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async input => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(readTaskUsage(state, context, input)) }] } }
    catch { return { isError: true, content: [{ type: 'text' as const, text: 'Task usage could not be read within this conversation scope. No broader host access was granted.' }] } }
  })
}
if (import.meta.main) {
  const [stateInput, jobId] = process.argv.slice(2)
  if (!stateInput || !jobId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(jobId) || process.argv.length !== 4) throw Error('invalid usage broker invocation')
  const state = requireManagedStateRoot(stateInput)
  const dir = requireManagedDirectory(state, join(state, 'task-usage-context'))
  const context = JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(join(dir, `${jobId}.json`), 8192) ?? 'null')
  if (!context || context.version !== 1 || context.jobId !== jobId || typeof context.repoPath !== 'string') throw Error('invalid usage context')
  const server = new McpServer({ name: 'zerochan-task-usage', version: '1.0.0' })
  registerTaskUsageTool(server, state, context)
  await server.connect(new StdioServerTransport())
}
