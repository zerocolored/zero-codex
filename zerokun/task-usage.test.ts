import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { captureClaudeUsage, CodexUsageTracker, createUsageRecorder, ownedClaudeUsageSession, readTaskUsage } from './task-usage.ts'
import { readProcessIdentity } from './process-generation.ts'
import { registerTaskUsageTool } from './task-usage-broker.ts'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'zero-usage-test-')); roots.push(state); chmodSync(state, 0o700)
  const db = new Database(join(state, 'jobs.sqlite3'))
  db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY, seq INTEGER, chat_id TEXT, thread_ts TEXT, repo_path TEXT, status TEXT, created_at INTEGER)')
  for (const row of [ ['old', 1, 'chat', 'thread', '/repo'], ['current', 2, 'chat', 'thread', '/repo'],
    ['foreign-chat', 3, 'other', 'thread', '/repo'], ['foreign-thread', 4, 'chat', 'other', '/repo'], ['foreign-repo', 5, 'chat', 'thread', '/other'] ]) {
    db.run("INSERT INTO jobs VALUES(?,?,?,?,?,'completed',123)", row)
  }
  db.close(); chmodSync(join(state, 'jobs.sqlite3'), 0o600)
  mkdirSync(join(state, 'job-logs'), { mode: 0o700 })
  return { state, context: { jobId: 'current', repoPath: '/repo' } }
}
const counts = (input: number, output = 10, cached = 20) => ({ inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteInputTokens: 0, reasoningOutputTokens: Math.min(output, 2) })
const started = (thread = 'root', turn = 'turn') => ({ method: 'turn/started', params: { threadId: thread, turn: { id: turn } } })
const ended = (thread = 'root', turn = 'turn') => ({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn } } })
const usage = (input = 100, thread = 'root', turn = 'turn', last = counts(input)) => ({ method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId: turn, tokenUsage: { total: counts(input), last } } })
function log(state: string, id: string, events: unknown[], stage = 'new') {
  writeFileSync(join(state, 'job-logs', `${id}.${stage}.stdout.log`), events.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
}

test('past logs supply numeric usage without opening private state to the agent', () => {
  const f = fixture()
  log(f.state, 'old', [started(), usage(), usage(150, 'root', 'turn', counts(50, 0, 0)), ended()])
  const result = readTaskUsage(f.state, f.context, { taskNumbers: [1] })
  expect(result.jobs[0]!.codex.status).toBe('reported')
  expect(result.jobs[0]!.codex.tokens?.inputTokens).toBe(150)
  expect(result.jobs[0]!.codex.tokens?.outputTokens).toBe(10)
  expect(result.jobs[0]!.claude.status).toBe('unavailable')
  expect(result.jobs[0]!.claude.tokens).toBeNull()
  expect(JSON.stringify(result)).not.toContain(f.state)
})

test('resume snapshots, repeated notifications and repeated attempt logs never multiply usage', () => {
  const f = fixture()
  const events = [usage(1000, 'root', 'prior'), started('root', 'next'),
    usage(1100, 'root', 'next', counts(100, 0, 0)), usage(1100, 'root', 'next', counts(100, 0, 0)), ended('root', 'next')]
  log(f.state, 'current', events)
  log(f.state, 'current', events, 'retry')
  const result = readTaskUsage(f.state, f.context).jobs[0]!.codex
  expect(result.measuredTurns).toBe(1)
  expect(result.tokens?.inputTokens).toBe(100)
})

test('numeric ledger preserves primary and child turns independently of truncated raw logs', () => {
  const f = fixture()
  const recorder = createUsageRecorder(f.state, 'old', 'attempt', 'gpt-6-astra', 'old.new.stdout.log')
  for (const event of [started(), usage(), ended(), started('child','child-turn'), usage(40,'child','child-turn'), ended('child','child-turn')]) recorder.observe(event)
  recorder.close()
  log(f.state, 'old', [started(), usage(9999)])
  const result = readTaskUsage(f.state, f.context, { taskNumbers: [1] }).jobs[0]!.codex
  expect(result.tokens?.inputTokens).toBe(140)
  expect(result.byModel.map(r => r.model).sort()).toEqual(['gpt-6-astra','unknown'])
  expect(result.status).toBe('reported')
  const raw = readFileSync(join(f.state,'task-usage','old','attempt.json'),'utf8')
  expect(raw).not.toContain('command')
})

test('missing terminal, malformed counters and log truncation remain partial; missing is not zero', () => {
  const f = fixture()
  log(f.state, 'old', [started(), usage()])
  expect(readTaskUsage(f.state, f.context, { taskNumbers: [1] }).jobs[0]!.codex.status).toBe('partial')
  log(f.state, 'old', [started(), usage(), { ...usage(), params: { ...usage().params, tokenUsage: { total: counts(-1), last: counts(1) } } }, ended()])
  expect(readTaskUsage(f.state, f.context, { taskNumbers: [1] }).jobs[0]!.codex.status).toBe('partial')
  const current = readTaskUsage(f.state, f.context, { taskNumbers: [2] }).jobs[0]!.codex
  expect(current.status).toBe('unavailable'); expect(current.tokens).toBeNull()
  log(f.state, 'old', [started(), usage(), ended()])
  writeFileSync(join(f.state,'job-logs','old.new.stdout.log.tail.json'), JSON.stringify({ prefixTruncated:true, latestSegment:0 }), {mode:0o600})
  expect(readTaskUsage(f.state, f.context, { taskNumbers: [1] }).jobs[0]!.codex.status).toBe('partial')
})

test('conversation and project scope cannot be expanded through task numbers or context', () => {
  const f = fixture()
  for (const seq of [3,4,5,999]) expect(() => readTaskUsage(f.state, f.context, {taskNumbers:[seq]})).toThrow()
  expect(() => readTaskUsage(f.state, {...f.context, repoPath:'/other'})).toThrow()
  expect(() => readTaskUsage(f.state, {...f.context, jobId:'missing'})).toThrow()
})

test('symlink and hardlink source logs never expose or count their contents', () => {
  for (const link of [symlinkSync, linkSync]) {
    const f = fixture(), secret = join(f.state,'secret')
    writeFileSync(secret, [started(), usage(999), ended()].map(e => JSON.stringify(e)).join('\n'),{mode:0o600})
    link(secret,join(f.state,'job-logs','old.new.stdout.log'))
    expect(readTaskUsage(f.state,f.context,{taskNumbers:[1]}).jobs[0]!.codex.tokens).toBeNull()
  }
})

test('MCP returns only projected usage and no raw transcript or secret-shaped errors', async () => {
  const f=fixture(), server=new McpServer({name:'usage-test',version:'1'}), client=new Client({name:'test',version:'1'})
  log(f.state,'old',[started(), {method:'item/completed',params:{item:{aggregatedOutput:'SECRET-MUST-NOT-ESCAPE'}}},usage(),ended()])
  registerTaskUsageTool(server,f.state,f.context)
  const [a,b]=InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a),server.connect(b)])
  try {
    const result=await client.callTool({name:'task_usage_read',arguments:{taskNumbers:[1]}})
    expect(result.isError).not.toBe(true); expect(JSON.stringify(result)).toContain('inputTokens')
    expect(JSON.stringify(result)).not.toContain('SECRET-MUST-NOT-ESCAPE')
    const denied=await client.callTool({name:'task_usage_read',arguments:{taskNumbers:[3]}})
    expect(denied.isError).toBe(true);expect(JSON.stringify(denied)).not.toContain(f.state)
  } finally {await client.close();await server.close()}
})

test('Claude capture is bound to exact session and deduplicates message fragments', () => {
  const f=fixture(), home=join(f.state,'claude'), session='12345678-1234-1234-1234-123456789abc'
  mkdirSync(join(home,'projects','-repo'),{recursive:true,mode:0o700})
  const event={type:'assistant',sessionId:session,message:{id:'msg-1',model:'claude-fable-5-1',content:'DO-NOT-RETURN',usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:30,cache_creation_input_tokens:40}}}
  writeFileSync(join(home,'projects','-repo',`${session}.jsonl`),[event,event,{...event,sessionId:'other',message:{...event.message,id:'msg-2'}}].map(v=>JSON.stringify(v)).join('\n'),{mode:0o600})
  captureClaudeUsage(f.state,'old','attempt',session,'/repo',home)
  const result=readTaskUsage(f.state,f.context,{taskNumbers:[1]}).jobs[0]!.claude
  expect(result.status).toBe('reported');expect(result.tokens).toEqual({input:10,output:20,cacheRead:30,cacheWrite:40})
  expect(JSON.stringify(result)).not.toContain('DO-NOT-RETURN')
  captureClaudeUsage(f.state,'current','attempt','N/A:safe-mode','/repo',home)
  expect(readTaskUsage(f.state,f.context,{taskNumbers:[2]}).jobs[0]!.claude.tokens).toBeNull()
})

test('recording writer failure is visible as partial after recovery', () => {
  let fail=true, saved:any
  const tracker=new CodexUsageTracker('gpt-6-astra', doc=>{if(fail)throw Error('disk full');saved=doc})
  try{tracker.observe(started())}catch{tracker.markPartial()}
  fail=false;tracker.observe(usage());tracker.observe(ended());tracker.close()
  expect(saved.partial).toBe(true);expect(saved.turns).toHaveLength(1)
})

test('safe-mode session fallback requires the exact live PID, generation, cwd and recent runtime record', () => {
  const f=fixture(), home=join(f.state,'claude'), session='12345678-1234-1234-1234-123456789abc'
  mkdirSync(join(home,'sessions'),{recursive:true,mode:0o700})
  const identity=readProcessIdentity(process.pid)!
  const path=join(home,'sessions',`${process.pid}.json`)
  const metadata={pid:process.pid,cwd:'/repo',sessionId:session,startedAt:Date.now()}
  writeFileSync(path,JSON.stringify(metadata),{mode:0o600})
  expect(ownedClaudeUsageSession(home,'/repo',identity)).toBe(session)
  expect(ownedClaudeUsageSession(home,'/other',identity)).toBeUndefined()
  expect(ownedClaudeUsageSession(home,'/repo',{...identity,startSec:identity.startSec-1})).toBeUndefined()
  writeFileSync(path,JSON.stringify({...metadata,startedAt:0}),{mode:0o600})
  expect(ownedClaudeUsageSession(home,'/repo',identity)).toBeUndefined()
})

test('counter resets remain partial rather than producing an apparently complete amount', () => {
  const f=fixture()
  log(f.state,'old',[started(),usage(100),usage(50),ended()])
  const result=readTaskUsage(f.state,f.context,{taskNumbers:[1]}).jobs[0]!.codex
  expect(result.status).toBe('partial');expect(result.tokens?.inputTokens).toBe(100)
})

test('a second app state cannot see the first app even when the conversation labels match', () => {
  const a=fixture(), b=fixture()
  log(a.state,'old',[started(),usage(500),ended()])
  expect(readTaskUsage(b.state,b.context,{taskNumbers:[1]}).jobs[0]!.codex.tokens).toBeNull()
})

test('an old log attempt is included beside a new numeric ledger without recounting its matching log', () => {
  const f=fixture()
  log(f.state,'old',[started('root','earlier'),usage(100,'root','earlier'),ended('root','earlier')],'before-update')
  const recorder=createUsageRecorder(f.state,'old','attempt','gpt-6-astra','old.after-update.stdout.log')
  const events=[started('root','later'),usage(150,'root','later',counts(50,0,0)),ended('root','later')]
  for(const event of events)recorder.observe(event)
  recorder.close();log(f.state,'old',events,'after-update')
  const result=readTaskUsage(f.state,f.context,{taskNumbers:[1]}).jobs[0]!.codex
  expect(result.status).toBe('reported');expect(result.measuredTurns).toBe(2);expect(result.tokens?.inputTokens).toBe(150)
})

test('a malformed Claude usage message preserves known counts but prevents a complete total', () => {
  const f=fixture(), home=join(f.state,'claude'), session='12345678-1234-1234-1234-123456789abc'
  mkdirSync(join(home,'projects','-repo'),{recursive:true,mode:0o700})
  const good={type:'assistant',sessionId:session,message:{id:'msg-1',model:'claude-fable-5-1',usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:30,cache_creation_input_tokens:40}}}
  const bad={...good,message:{...good.message,id:'msg-2',usage:{input_tokens:25}}}
  const second={...good,message:{...good.message,id:'msg-3'}}
  writeFileSync(join(home,'projects','-repo',`${session}.jsonl`),[good,null,bad,second].map(v=>JSON.stringify(v)).join('\n'),{mode:0o600})
  captureClaudeUsage(f.state,'old','attempt',session,'/repo',home)
  const result=readTaskUsage(f.state,f.context,{taskNumbers:[1]}).jobs[0]!.claude
  expect(result.status).toBe('partial');expect(result.tokens?.input).toBe(20)
})

test('the real stdio broker binds its host context and serves usage to a read-only client', async () => {
  const f=fixture()
  mkdirSync(join(f.state,'task-usage-context'),{mode:0o700})
  writeFileSync(join(f.state,'task-usage-context','current.json'),JSON.stringify({version:1,...f.context}),{mode:0o600})
  log(f.state,'old',[started(),usage(),ended()])
  const client=new Client({name:'usage-stdio-test',version:'1'})
  const transport=new StdioClientTransport({command:process.execPath,args:['--config=/dev/null','--no-env-file',join(import.meta.dir,'task-usage-broker.ts'),f.state,'current'],stderr:'pipe'})
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map(t=>t.name)).toEqual(['task_usage_read'])
    const result=await client.callTool({name:'task_usage_read',arguments:{taskNumbers:[1]}})
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result)).toContain('inputTokens')
    expect(JSON.stringify(result)).not.toContain(f.state)
  } finally {await client.close();await transport.close()}
})
