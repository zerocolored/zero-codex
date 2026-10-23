import { homedir } from 'os'
import { join } from 'path'
import { realpathSync } from 'fs'
import type { DelegationContext } from './claude-delegation-broker.ts'
import { ClaudeDelegationError, delegationFailure } from './claude-delegation-attempt.ts'
import { prepareClaudeJobContext } from './claude-job-context.ts'
import { openClaudeHerdrTransport, type ClaudeHerdrTransport } from './claude-herdr-transport.ts'
import { primarySandboxCommand } from './primary-tools-broker.ts'
import { snapshotClaudeExecutable } from './claude-executable.ts'
import { buildCodexChildEnvironment } from './codex-executor.ts'
import { NATIVE_CONFIG_ENV_KEYS, nativeCliShellEnvironment } from './native-cli-environment.ts'

function antigravityEnvironment(environment: Record<string, string>) {
  const result = { ...environment }
  for (const key of NATIVE_CONFIG_ENV_KEYS) delete result[key]
  return { ...result, ...nativeCliShellEnvironment(homedir(), '', true) }
}

/** agy has its own protocol; Claude control_request/control_response must never
 * be sent to it. Successful partial text is not a successful terminal result. */
export class AntigravityResults {
  private buffer = ''
  private decoder = new TextDecoder('utf-8', { fatal: true })
  private initialized = false
  private denied = false
  private workObserved = false
  private conversation?: string
  result?: string
  constructor(private model: string) {}
  push(bytes: Uint8Array) {
    this.buffer += this.decoder.decode(bytes, { stream: true })
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw Error('Antigravity event exceeds limit')
      if (line.trim()) this.event(JSON.parse(line))
    }
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) throw Error('Antigravity event exceeds limit')
  }
  private event(value: any) {
    if (value.event === 'init') {
      if (this.initialized || (this.model !== 'default' && value.init?.model !== this.model)) throw Error('Antigravity model mismatch')
      this.initialized = true
      this.conversation = value.conversation_id
    } else if (value.event === 'step_update') {
      this.workObserved = true
      const error = value.step_update?.tool_info?.error
      if (error && /permission.*(?:denied|failed)|denied.*permission|soft.den/i.test(String(error.message ?? ''))) this.denied = true
    } else if (value.event === 'result') {
      const result = value.result
      if (result?.status !== 'SUCCESS') {
        // Only native terminal errors are classified. Never inspect model text
        // or tool output for authentication, and never replay partially run work.
        const nativeError = typeof result?.error === 'string' ? result.error : ''
        const authentication = /(?:auth(?:entication)?[ _-]*token|not authenticated|authentication (?:required|failed)|failed to read token store)/i.test(nativeError)
        const failure = delegationFailure(authentication ? 'authentication' : 'execution', authentication ? 'authentication' : 'native-error')
        failure.retrySafe = authentication && !this.initialized && !this.workObserved
          && result?.num_turns === 0 && !result?.conversation_id && !result?.response
        throw new ClaudeDelegationError(failure)
      }
      if (!this.initialized || this.result !== undefined || typeof result.response !== 'string'
        || !this.conversation || result.conversation_id !== this.conversation) throw Error('invalid Antigravity result')
      this.result = result.response
    }
  }
  finish() {
    this.buffer += this.decoder.decode()
    if (this.buffer.trim()) this.event(JSON.parse(this.buffer))
    if (this.denied) throw new ClaudeDelegationError(delegationFailure('execution', 'permission-denied'))
    if (this.result === undefined) throw Error('Antigravity exited without a terminal result')
    return this.result
  }
}

/** Native agy (including file tools and spawned processes) stays inside the
 * existing Codex permission sandbox. Only its own subscription runtime gets
 * an additional app-data grant; no host state or Slack credentials are copied. */
export function antigravitySandbox(prepared: ReturnType<typeof prepareClaudeJobContext>, executable: string, model: string, writeEnabled: boolean) {
  const context = prepared.toolsContext
  const parsed = Bun.TOML.parse(context.permissionOverrides.join('\n')) as any
  const profile = parsed.permissions[context.profile]
  const appData = join(homedir(), '.gemini')
  const rules = { ...profile.filesystem, [context.stateDir]: 'deny', [appData]: 'write', [realpathSync(executable)]: 'read' }
  const prefix = `permissions.${context.profile}.filesystem=`
  const overrides = context.permissionOverrides.map(value => value.startsWith(prefix)
    ? prefix + '{' + Object.entries(rules).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(',') + '}'
    : value.startsWith('shell_environment_policy.set=')
      ? 'shell_environment_policy.set={' + Object.entries(antigravityEnvironment(parsed.shell_environment_policy.set)).map(([key, val]) => `${JSON.stringify(key)}=${JSON.stringify(val)}`).join(',') + '}'
      : value)
  // Model inference needs transport even for a read-only project. Project
  // writes remain controlled by the unchanged filesystem rules and plan mode.
  const network = `permissions.${context.profile}.network.enabled=`
  const local = `permissions.${context.profile}.network.allow_local_binding=`
  const domains = `permissions.${context.profile}.network.domains=`
  // A read-only parent may omit domains entirely. Mapping existing entries
  // alone would leave the native inference transport without an allow rule.
  const networkOverrides = !writeEnabled && !overrides.some(value => value.startsWith(domains))
    ? [...overrides, domains + '{}'] : overrides
  const argumentsForAgy = ['--dangerously-skip-permissions', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--disable-slash-commands', ...(!writeEnabled ? ['--mode', 'plan'] : []),
    ...(model === 'default' ? [] : ['--model', model])]
  return primarySandboxCommand({ ...context, permissionOverrides: networkOverrides.map(value =>
    value.startsWith(network) ? network + 'true' : value.startsWith(local) ? local + 'true'
      : value.startsWith(domains) && !writeEnabled ? domains + '{"*"="allow","slack.com"="deny","**.slack.com"="deny","slack-edge.com"="deny","**.slack-edge.com"="deny","slack-msgs.com"="deny","**.slack-msgs.com"="deny"}'
      : value.startsWith('features.network_proxy=') ? 'features.network_proxy=true' : value),
  }, [executable, ...argumentsForAgy], prepared.jobRepo)
}

type Fixtures = {
  executable?: () => string
  prepare?: typeof prepareClaudeJobContext
  command?: typeof antigravitySandbox
  transport?: typeof openClaudeHerdrTransport
}
export async function runAntigravityDelegation(context: DelegationContext, id: string,
  request: { model: string; prompt: string }, signal: AbortSignal, fixtures: Fixtures = {}): Promise<string> {
  let prepared: ReturnType<typeof prepareClaudeJobContext> | undefined
  let transport: ClaudeHerdrTransport | undefined
  let failure: ReturnType<typeof delegationFailure> | undefined
  let result = '', stage: 'preparation' | 'startup' | 'dispatch' | 'execution' = 'preparation'
  const abort = () => { void transport?.close().catch(() => {}) }
  try {
    signal.throwIfAborted()
    const executable = (fixtures.executable ?? (() => {
      const path = Bun.which('agy')
      if (!path) throw new ClaudeDelegationError(delegationFailure('preparation', 'cli-missing'))
      return snapshotClaudeExecutable(path).physical
    }))()
    const job = { ...context.job, id: `delegate-${id}`, sessionId: null }
    prepared = (fixtures.prepare ?? prepareClaudeJobContext)(job, context.stateDir,
      { model: request.model, parentJobId: context.job.id })
    const command = (fixtures.command ?? antigravitySandbox)(prepared, executable, request.model, context.job.writeEnabled)
    stage = 'startup'; signal.throwIfAborted()
    transport = await (fixtures.transport ?? openClaudeHerdrTransport)({ stateDir: context.stateDir,
      jobId: job.id, sequence: job.seq, cwd: prepared.jobRepo, executable: command[0]!, arguments: command.slice(1),
      providerLabel: 'Antigravity', environment: antigravityEnvironment({ ...buildCodexChildEnvironment(), ...prepared.toolsContext.shellEnvironment }),
      signal, fingerprint: { allow: prepared.fingerprint.allow.path, deny: prepared.fingerprint.deny.path } })
    signal.addEventListener('abort', abort, { once: true }); signal.throwIfAborted()
    const parser = new AntigravityResults(request.model)
    stage = 'dispatch'
    await transport.input.write(JSON.stringify({ event: 'user', message: { content: [
      'You are an Antigravity worker delegated by the primary assistant. Implement only the assigned subtask. You are not alone in the repository: preserve concurrent changes.',
      'Read applicable AGENTS.md. Do not delegate again, change host settings, read credentials or unrelated sessions, send messages, commit, push or publish. Parent owns review, integration and delivery.',
      'Your native tools run inside the parent project permission sandbox. Preserve native permission decisions; never bypass soft-denied tools. Report incomplete operations explicitly.',
      context.job.writeEnabled ? 'Project edits in the assigned scope are authorized.' : 'This task is read-only. Do not change project or external state.',
      `Shared artifacts: ${prepared.artifactDir}. Shared scratch: ${prepared.scratchDir}.`,
      request.prompt,
    ].join('\n\n') } }) + '\n')
    await transport.input.end()
    stage = 'execution'
    for await (const bytes of transport.output) { signal.throwIfAborted(); parser.push(bytes) }
    const code = await transport.exited
    if (code !== 0) throw new ClaudeDelegationError(delegationFailure(stage, 'native-error'))
    result = parser.finish()
  } catch (error) {
    failure = error instanceof ClaudeDelegationError ? error.failure : delegationFailure(stage,
      signal.aborted ? 'cancelled' : stage === 'preparation' ? 'preparation' : stage === 'startup' ? 'startup'
        : stage === 'dispatch' ? 'delivery-unknown' : 'protocol')
  } finally {
    signal.removeEventListener('abort', abort)
    try { await transport?.close(); prepared?.retire(); if (failure) failure.cleanupVerified = true }
    catch { failure = delegationFailure('cleanup', 'cleanup') }
  }
  if (failure) throw new ClaudeDelegationError({ ...failure, reason: failure.reason.replaceAll('Claude', 'Antigravity') })
  return result
}
