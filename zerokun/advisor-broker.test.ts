import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readProcessIdentity } from './process-tree.ts'
import { signalProcessIfLive } from './process-generation.ts'
import {
  advanceAdvisorReceipt,
  allAdvisorAttemptsAdopted,
  advisorReceiptAlreadyObserved,
  advisorReceiptChallenge,
  advisorPrompt,
  assertClaudeSubscriptionLogin,
  brokerEnvironment,
  claudeSubscriptionStatusIsReady,
  createExclusivePrivateFile,
  decodeHerdrReadOutput,
  emptyClaudePrompt,
  executeGrokPanelWithRecovery,
  extractCompleteClaudeResponse,
  classifyGrokAuthState,
  grokAuthRecoveryTransitionIsSafe,
  grokOAuthCompletionOutput,
  grokReviewerAuthRequired,
  parseFifthAdvisorSendOutcome,
  releaseExclusivePrivateFile,
  requiredAdvisorPhases,
  runBounded,
  summarizeAdvisorSlots,
  CLAUDE_HELPER_TIMEOUT_MS,
  GROK_OAUTH_TIMEOUT_MS,
  GROK_REVIEW_TIMEOUT_MS,
  MAX_ADVISOR_PROMPT_BYTES,
} from './advisor-broker.ts'
import { JobStore } from './job-runner.ts'
import { readAdvisorInputSnapshot, type AdvisorInputSnapshot } from './advisor-input.ts'
import {
  advisorRepositoryDigest,
  resolveAdvisorProjectLayout,
  snapshotAdvisorRepository,
} from './advisor-snapshot.ts'
import { nativeAdvisorMarker, nativeAdvisorResponseDigest, nativeAdvisorResponseTransportDigest } from './native-advisor-evidence.ts'
import {
  threeAdvisorRepositoryDeltaDigest,
  threeAdvisorTaskOwnedFixPathsDigest,
} from './advisor-journal.ts'
import { createSeatbeltFingerprint } from './seatbelt-fingerprint.ts'
import { requireHerdrRuntime, writePinnedHerdrRuntime } from './herdr-runtime.ts'
import { installFifthAdvisorHelper } from './install-fifth-advisor.ts'
import { installGrokReviewer } from './install-grok-reviewer.ts'
import {
  finalizeRetiredAdvisorRounds,
  persistAdvisorClaudeCleanupOutcome,
  recordAdvisorExecutorRetirement,
} from './advisor-round-recovery.ts'

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zerochan-advisor-broker-'))
  temporaryDirs.push(dir)
  return dir
}

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['/usr/bin/git', ...args], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: '/usr/bin:/bin', HOME: '/', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

type BrokerFixture = {
  state: string
  repo: string
  jobId: string
  nonce: string
  revisionOne: AdvisorInputSnapshot
  revisionTwo: AdvisorInputSnapshot
  journalRoot: string
  contextDigest: string
  fingerprint: ReturnType<typeof createSeatbeltFingerprint>
  externalEvidence?: {
    fakeHerdrState: string
  }
  call(
    phase?: 'investigation' | 'design' | 'review',
    binding?: 'revision-one' | 'revision-two' | AdvisorInputSnapshot,
    nativeMode?: 'adopted' | 'unavailable',
    round?: 1 | 2 | 3,
    overrides?: {
      retryUnavailable?: boolean
      inputUpdateIsRecoveryOnly?: boolean
      nativeAgentId?: string
      roundTwoBasis?: {
        roundOneSources: Array<'native' | 'grok' | 'claude'>
        mandatoryFindingSummary: string
        taskOwnedFixDelta: string
        taskOwnedFixPaths: Array<{ repository: string, path: string }>
      }
    },
  ): Promise<{
    result: Awaited<ReturnType<Client['callTool']>>
    payload: Record<string, unknown>
  }>
  stageRevision(task: string): AdvisorInputSnapshot
  poll(
    phase: 'investigation' | 'review',
    binding: 'revision-one' | 'revision-two' | AdvisorInputSnapshot,
    round?: 1 | 2,
  ): Promise<{
    result: Awaited<ReturnType<Client['callTool']>>
    payload: Record<string, unknown>
  }>
  close(): Promise<void>
}

function successfulFakeHerdr(
  binary: string,
  statePath: string,
  project: string,
  claude: string,
  transientProbeDenial = false,
): void {
  writeFileSync(statePath, `${JSON.stringify({
    owned: false,
    agent: false,
    process: false,
    project,
    label: null,
    agent_name: null,
    state_change_seq: 1,
    agent_status: 'idle',
    prompt: null,
    process_pid: null,
    process_group_id: null,
    prompt_count: 0,
    close_count: 0,
  })}\n`, { mode: 0o600 })
  writeFileSync(binary, `#!/usr/bin/python3
import json, os, signal, subprocess, sys, time, traceback
path = ${JSON.stringify(statePath)}
claude = ${JSON.stringify(claude)}
def record_fixture_failure(kind, value, tb):
    with open(path + ".errors", "a", encoding="utf-8") as handle:
        traceback.print_exception(kind, value, tb, file=handle)
    sys.__excepthook__(kind, value, tb)
sys.excepthook = record_fixture_failure
with open(path, "r", encoding="utf-8") as handle:
    state = json.load(handle)
args = sys.argv[1:]
workspace = "wOWN"
pane = "wOWN:p1"
tab = "wOWN:t1"
terminal = "term_012345abcdef"
caller_workspace = "wT"
caller_pane = "wT:p2"
caller_tab = "wT:t3"
caller_terminal = "term_abcdef012345"
def save():
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(state, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
def success(result):
    print(json.dumps({"result": result}, sort_keys=True))
    raise SystemExit(0)
def missing(code):
    print(json.dumps({"error": {"code": code}}, sort_keys=True))
    raise SystemExit(1)
def caller_value():
    return {"workspace_id": caller_workspace, "label": "caller", "active_tab_id": caller_tab, "focused": True, "pane_count": 1, "tab_count": 1, "worktree": None}
def workspace_value():
    return {"workspace_id": workspace, "label": state["label"], "active_tab_id": tab, "focused": False, "pane_count": 1, "tab_count": 1, "worktree": None}
def agent_value():
    return {"name": state["agent_name"], "agent": "claude", "agent_session": {"agent": "claude", "kind": "native", "source": "session", "value": "fixture-native-session"}, "workspace_id": workspace, "pane_id": pane, "tab_id": tab, "terminal_id": terminal, "cwd": state["project"], "agent_status": state["agent_status"], "interactive_ready": True, "launch_pending": False, "state_change_seq": state["state_change_seq"]}
if args == ["pane", "current", "--current"]:
    success({"pane": {"workspace_id": caller_workspace, "pane_id": caller_pane, "tab_id": caller_tab, "terminal_id": caller_terminal}})
if args == ["workspace", "list"]:
    values = [caller_value()]
    if state["owned"]:
        values.append(workspace_value())
    success({"workspaces": values})
if len(args) >= 2 and args[:2] == ["workspace", "create"]:
    state["project"] = args[args.index("--cwd") + 1]
    state["label"] = args[args.index("--label") + 1]
    state["owned"] = True
    save()
    success({"workspace": workspace_value(), "tab": {"workspace_id": workspace, "tab_id": tab, "focused": False, "pane_count": 1}, "root_pane": {"workspace_id": workspace, "tab_id": tab, "pane_id": pane, "terminal_id": terminal, "cwd": state["project"], "foreground_cwd": state["project"], "focused": False}})
if args == ["workspace", "get", workspace]:
    if not state["owned"]:
        missing("workspace_not_found")
    success({"workspace": workspace_value()})
if args == ["tab", "list", "--workspace", workspace]:
    if not state["owned"]:
        missing("workspace_not_found")
    success({"tabs": [{"workspace_id": workspace, "tab_id": tab, "focused": False, "pane_count": 1}]})
if args == ["pane", "list", "--workspace", workspace]:
    if not state["owned"]:
        missing("workspace_not_found")
    success({"panes": [{"workspace_id": workspace, "tab_id": tab, "pane_id": pane, "terminal_id": terminal, "cwd": state["project"], "foreground_cwd": state["project"], "focused": False}]})
if len(args) >= 3 and args[:2] == ["agent", "start"]:
    if not state["owned"]:
        missing("workspace_not_found")
    state["agent_name"] = args[2]
    state["agent"] = True
    state["process"] = True
    state["state_change_seq"] = 1
    state["agent_status"] = "idle"
    state["prompt"] = None
    child = subprocess.Popen(
        [claude, "--dangerously-skip-permissions", "--safe-mode", "--no-chrome", "--disable-slash-commands", "--model=claude-fable-5-1"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    state["process_pid"] = child.pid
    state["process_group_id"] = os.getpgid(child.pid)
    save()
    success({"started": True})
if len(args) == 3 and args[:2] == ["agent", "get"]:
    if not state["owned"] or not state["agent"] or args[2] != state["agent_name"]:
        missing("agent_not_found")
    success({"agent": agent_value()})
if len(args) == 7 and args[:2] == ["agent", "read"] and args[3:6] == ["--source", "visible", "--lines"]:
    print("❯", flush=True)
    raise SystemExit(0)
if len(args) == 7 and args[:2] == ["agent", "read"] and args[3:6] == ["--source", "recent-unwrapped", "--lines"]:
    prompt = state.get("prompt")
    if not isinstance(prompt, str) or state.get("answer_missing"):
        print("❯", flush=True)
    else:
        marker = next((line for line in reversed(prompt.splitlines()) if line.startswith("REQUEST_MARKER=")), "")
        print(prompt.rstrip("\\n"))
        print("Claude independent review completed")
        print(marker)
        print("❯")
    raise SystemExit(0)
if args == ["pane", "process-info", "--pane", pane]:
    if not state["owned"]:
        missing("pane_not_found")
    process_pid = state["process_pid"]
    process_group_id = state["process_group_id"]
    processes = [{"pid": process_pid, "argv": ["claude", "--dangerously-skip-permissions", "--safe-mode", "--no-chrome", "--disable-slash-commands", "--model=claude-fable-5-1"], "argv0": "claude"}] if state["process"] else []
    success({"process_info": {"pane_id": pane, "shell_pid": process_pid, "foreground_process_group_id": process_group_id, "foreground_processes": processes}})
if args == ["workspace", "close", workspace]:
    if not state["owned"]:
        missing("workspace_not_found")
    process_group_id = state.get("process_group_id")
    if isinstance(process_group_id, int):
        try:
            os.killpg(process_group_id, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 1.0
        probe_denial_pending = ${transientProbeDenial ? 'True' : 'False'}
        while time.monotonic() < deadline:
            try:
                if probe_denial_pending:
                    probe_denial_pending = False
                    raise PermissionError("fixture transient group probe")
                os.killpg(process_group_id, 0)
            except ProcessLookupError:
                break
            except PermissionError:
                # Darwin can temporarily deny a group probe while the killed
                # orphan is being reaped. Like the production helper, wait;
                # EPERM is not proof of either successful close or failure.
                pass
            time.sleep(0.01)
        else:
            try:
                os.killpg(process_group_id, signal.SIGKILL)
            except ProcessLookupError:
                pass
    state["owned"] = False
    state["agent"] = False
    state["process"] = False
    state["close_count"] += 1
    save()
    success({"closed": True})
if args == ["pane", "get", pane]:
    if not state["owned"]:
        missing("pane_not_found")
    success({"pane": {"workspace_id": workspace, "tab_id": tab, "pane_id": pane, "terminal_id": terminal}})
missing("unsupported_test_command")
`, { mode: 0o700 })
}

async function brokerFixture(options: {
  writeEnabled?: boolean
  externalSuccess?: boolean
  claudeFailures?: number
  transientProbeDenial?: boolean
} = {}): Promise<BrokerFixture> {
  const root = fixtureDir()
  chmodSync(root, 0o700)
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  mkdirSync(join(root, 'repo'), { mode: 0o700 })
  const state = realpathSync(join(root, 'state'))
  const repo = realpathSync(join(root, 'repo'))
  const runtimeDir = join(state, 'advisor-runtime')
  mkdirSync(runtimeDir, { mode: 0o700 })
  git(['init', '-q'], repo)
  git(['config', 'user.name', 'Zero Test'], repo)
  git(['config', 'user.email', 'zero-test@example.invalid'], repo)
  writeFileSync(join(repo, 'README.md'), 'fixture\n', { mode: 0o600 })
  git(['add', 'README.md'], repo)
  git(['commit', '-qm', 'test fixture'], repo)

  const binary = join(root, 'herdr')
  const fakeHerdrState = join(root, 'fake-herdr-state.json')
  const claude = join(root, 'claude')
  if (!options.externalSuccess) {
    writeFileSync(binary, [
      '#!/bin/sh',
      `printf '%s\\n' ${JSON.stringify(JSON.stringify({
        id: 'fixture',
        result: { pane: {
          pane_id: 'wT:p2',
          tab_id: 'wT:t3',
          terminal_id: 'term_012345abcdef',
          workspace_id: 'wT',
        } },
      }))}`,
      '',
    ].join('\n'), { mode: 0o700 })
  }
  const socketPath = join(root, 'herdr.sock')
  let socketBuffer = Buffer.alloc(0)
  const socket = Bun.listen({
    unix: socketPath,
    socket: {
      data(client, chunk) {
        if (!options.externalSuccess) return
        socketBuffer = Buffer.concat([socketBuffer, Buffer.from(chunk)])
        const newline = socketBuffer.indexOf(0x0a)
        if (newline < 0) return
        const request = JSON.parse(socketBuffer.subarray(0, newline).toString('utf8')) as {
          id: string
          params: { text: string }
        }
        socketBuffer = socketBuffer.subarray(newline + 1)
        const stateValue = JSON.parse(readFileSync(fakeHerdrState, 'utf8')) as Record<string, unknown>
        stateValue.prompt = request.params.text
        stateValue.state_change_seq = 2
        stateValue.agent_status = 'done'
        stateValue.prompt_count = Number(stateValue.prompt_count ?? 0) + 1
        stateValue.answer_missing = Number(stateValue.prompt_count) <= (options.claudeFailures ?? 0)
        writeFileSync(fakeHerdrState, `${JSON.stringify(stateValue)}\n`, { mode: 0o600 })
        client.write(`${JSON.stringify({
          id: request.id,
          result: { type: 'agent_prompt', status: 'done' },
        })}\n`)
        client.end()
      },
    },
  })
  chmodSync(socketPath, 0o600)
  writeFileSync(claude, options.externalSuccess ? [
    '#!/bin/sh',
    'if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then',
    '  printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\'',
    '  exit 0',
    'fi',
    'exec /bin/sleep 300',
    '',
  ].join('\n') : [
    '#!/bin/sh',
    'printf \'%s\\n\' \'{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","subscriptionType":null}\'',
    '',
  ].join('\n'), { mode: 0o700 })
  if (options.externalSuccess) {
    successfulFakeHerdr(binary, fakeHerdrState, repo, realpathSync(claude), options.transientProbeDenial)
  }
  // Keep broker tests independent from the developer account's live Grok
  // subscription. The pinned reviewer bundle is still exercised, but its
  // fixture executable exits before any model/network call.
  const fixtureHome = join(root, 'home')
  const fixtureGrokRoot = join(fixtureHome, '.grok')
  const fixtureGrokBin = join(fixtureGrokRoot, 'bin')
  const fixtureGrokDownloads = join(fixtureGrokRoot, 'downloads')
  mkdirSync(fixtureGrokBin, { recursive: true, mode: 0o700 })
  mkdirSync(fixtureGrokDownloads, { mode: 0o700 })
  chmodSync(fixtureHome, 0o700)
  chmodSync(fixtureGrokRoot, 0o700)
  chmodSync(fixtureGrokBin, 0o700)
  chmodSync(fixtureGrokDownloads, 0o700)
  const fixtureGrokName = process.arch === 'arm64'
    ? 'grok-macos-aarch64'
    : 'grok-macos-x86_64'
  const fixtureGrokExecutable = join(fixtureGrokDownloads, fixtureGrokName)
  if (options.externalSuccess) {
    const source = join(root, 'fixture-grok.c')
    writeFileSync(source, [
      '#include <stdio.h>',
      '#include <stdlib.h>',
      '#include <string.h>',
      '#include <unistd.h>',
      'int main(void) {',
      '  usleep(300000);',
      '  printf("Grok independent review completed pid=%d\\n", getpid());',
      '  return 0;',
      '}',
      '',
    ].join('\n'), { mode: 0o600 })
    const compiled = Bun.spawnSync([
      '/usr/bin/clang', '-O0', '-o', fixtureGrokExecutable, source,
    ], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString())
    chmodSync(fixtureGrokExecutable, 0o700)
  } else {
    writeFileSync(fixtureGrokExecutable, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  }
  symlinkSync(`../downloads/${fixtureGrokName}`, join(fixtureGrokBin, 'grok'))
  writeFileSync(join(fixtureGrokRoot, 'auth.json'), '{"fixture":true}\n', { mode: 0o600 })
  installGrokReviewer(fixtureHome)
  if (options.externalSuccess) installFifthAdvisorHelper(fixtureHome)
  const claudePhysical = realpathSync(claude)
  const environment = {
    HOME: fixtureHome,
    PATH: `/usr/bin:/bin`,
    HERDR_ENV: '1',
    HERDR_BIN_PATH: binary,
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: 'wOLD:p1',
    HERDR_TAB_ID: 'wOLD:t1',
    HERDR_WORKSPACE_ID: 'wOLD',
  }
  writePinnedHerdrRuntime(state, requireHerdrRuntime(environment))

  const store = new JobStore(join(state, 'jobs.sqlite3'))
  const job = store.enqueue({
    chatId: 'C0123456789',
    threadTs: '1800000000.000100',
    messageId: '1800000000.000100',
    userId: 'U_FIRST',
    repoPath: repo,
    task: '最初の依頼',
    writeEnabled: options.writeEnabled ?? false,
  }).job
  const revisionOne = readAdvisorInputSnapshot(state, job.id)
  const target = store.liveControlTarget(job.chatId, job.threadTs)
  if (!target) throw new Error('queued broker fixture did not expose live control')
  expect(store.stageLiveControl(target, {
    chatId: job.chatId,
    threadTs: job.threadTs,
    messageId: '1800000000.000200',
    userId: 'U_DIFFERENT',
    task: '同じスレッドの別ユーザーから追記',
    kind: 'steer',
  })).toBe('staged')
  const revisionTwo = readAdvisorInputSnapshot(state, job.id)
  let stagedRevision = 2

  const nonce = 'a'.repeat(32)
  const layout = resolveAdvisorProjectLayout(repo)
  const context = {
    version: 4,
    jobId: job.id,
    attemptNonce: nonce,
    repoPath: realpathSync(repo),
    gitRoot: layout.gitRoot,
    gitRoots: layout.gitRoots,
    writeEnabled: options.writeEnabled ?? false,
    initialRepositoryDigest: advisorRepositoryDigest(snapshotAdvisorRepository(layout)),
  }
  const contextRoot = join(state, 'advisor-context', job.id)
  mkdirSync(contextRoot, { recursive: true, mode: 0o700 })
  const contextPath = join(contextRoot, `${nonce}.json`)
  writeFileSync(contextPath, `${JSON.stringify(context)}\n`, { mode: 0o600 })
  const contextDigest = createHash('sha256').update(JSON.stringify(context)).digest('hex')
  const fingerprint = createSeatbeltFingerprint(state, job.id, nonce)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--config=/dev/null', '--no-env-file', realpathSync(join(import.meta.dir, 'advisor-broker.ts')),
      contextPath, state, runtimeDir, fingerprint.allow.path, fingerprint.deny.path,
      'complete', nonce, claudePhysical,
    ],
    cwd: repo,
    env: environment,
    stderr: 'pipe',
  })
  let brokerStderr = ''
  transport.stderr?.on('data', chunk => { brokerStderr += String(chunk) })
  const client = new Client({ name: 'zerochan-advisor-broker-test', version: '1.0.0' })
  try {
    await client.connect(transport)
  } catch (error) {
    store.close()
    socket.stop(true)
    throw new Error(`${error}${brokerStderr ? `\n${brokerStderr}` : ''}`)
  }
  const journalRoot = join(state, 'advisor-journal', job.id, nonce)
  return {
    state,
    repo,
    jobId: job.id,
    nonce,
    revisionOne,
    revisionTwo,
    journalRoot,
    contextDigest,
    fingerprint,
    ...(options.externalSuccess ? {
      externalEvidence: { fakeHerdrState },
    } : {}),
    async call(
      phase = 'investigation',
      binding: 'revision-one' | 'revision-two' | AdvisorInputSnapshot = 'revision-one',
      nativeMode: 'adopted' | 'unavailable' = 'adopted',
      round: 1 | 2 | 3 = 1,
      overrides: {
        retryUnavailable?: boolean
        inputUpdateIsRecoveryOnly?: boolean
        nativeAgentId?: string
        roundTwoBasis?: {
          roundOneSources: Array<'native' | 'grok' | 'claude'>
          mandatoryFindingSummary: string
          taskOwnedFixDelta: string
          taskOwnedFixPaths: Array<{ repository: string, path: string }>
        }
      } = {},
    ) {
      const selectedInput = typeof binding === 'object'
        ? binding
        : binding === 'revision-one' ? revisionOne : revisionTwo
      const expectedPerspective = phase === 'review' ? 'risk' : 'solution'
      const responseFor = (perspective: 'solution' | 'risk') => [
        `${perspective} response`,
        nativeAdvisorMarker(
          nonce, selectedInput.revision, selectedInput.digest, phase, round, perspective,
        ),
      ].join('\n')
      let result: Awaited<ReturnType<Client['callTool']>>
      try {
        result = await client.callTool({
          name: 'advisor_round',
          arguments: {
            phase,
            round,
            inputRevision: selectedInput.revision,
            inputDigest: selectedInput.digest,
            primaryEvidence: 'bounded primary evidence',
            ...(overrides.retryUnavailable ? { retryUnavailable: true } : {}),
            ...(overrides.inputUpdateIsRecoveryOnly ? { inputUpdateIsRecoveryOnly: true } : {}),
            ...(overrides.roundTwoBasis ? { roundTwoBasis: overrides.roundTwoBasis } : {}),
            nativeAdvisors: nativeMode === 'adopted'
              ? [
                {
                  perspective: expectedPerspective,
                  agentId: overrides.nativeAgentId ?? `/root/native-${expectedPerspective}`,
                  response: responseFor(expectedPerspective),
                },
              ]
              : [
                {
                  perspective: expectedPerspective, attempted: true, adopted: false,
                  started: false,
                  reason: `native ${expectedPerspective} slot could not start`,
                },
              ],
          },
        })
      } catch (error) {
        throw new Error(`${error}${brokerStderr ? `\n${brokerStderr}` : ''}`)
      }
      let block = result.content.find(value => value.type === 'text')
      if (!block || block.type !== 'text') throw new Error('advisor broker omitted text result')
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(block.text) as Record<string, unknown>
      } catch {
        payload = { rawError: block.text }
      }
      while (payload.pending === true || payload.receiptRequired === true) {
        result = await client.callTool({
          name: 'advisor_round_poll',
          arguments: {
            phase,
            round,
            inputRevision: selectedInput.revision,
            inputDigest: selectedInput.digest,
            ...(typeof payload.receipt === 'string' ? { receipt: payload.receipt } : {}),
          },
        })
        block = result.content.find(value => value.type === 'text')
        if (!block || block.type !== 'text') throw new Error('advisor broker omitted poll result')
        payload = JSON.parse(block.text) as Record<string, unknown>
      }
      if (existsSync(fakeHerdrState + '.errors')) {
        throw new Error(`Fake Herdr failed: ${readFileSync(fakeHerdrState + '.errors', 'utf8')}`)
      }
      return { result, payload }
    },
    stageRevision(task: string) {
      stagedRevision += 1
      const staged = store.stageLiveControl(target, {
        chatId: job.chatId,
        threadTs: job.threadTs,
        messageId: `1800000000.${String(stagedRevision).padStart(6, '0')}`,
        userId: 'U_DIFFERENT',
        task,
        kind: 'steer',
      })
      if (staged !== 'staged') throw new Error(`broker fixture input was not staged: ${staged}`)
      return readAdvisorInputSnapshot(state, job.id)
    },
    async poll(
      phase: 'investigation' | 'review',
      binding: 'revision-one' | 'revision-two' | AdvisorInputSnapshot,
      round: 1 | 2 = 1,
    ) {
      const selectedInput = typeof binding === 'object'
        ? binding
        : binding === 'revision-one' ? revisionOne : revisionTwo
      const result = await client.callTool({
        name: 'advisor_round_poll',
        arguments: {
          phase,
          round,
          inputRevision: selectedInput.revision,
          inputDigest: selectedInput.digest,
        },
      })
      const block = result.content.find(value => value.type === 'text')
      if (!block || block.type !== 'text') throw new Error('advisor broker omitted poll result')
      return { result, payload: JSON.parse(block.text) as Record<string, unknown> }
    },
    async close() {
      try { await client.close() } finally {
        if (options.externalSuccess && existsSync(fakeHerdrState)) {
          try {
            const current = JSON.parse(readFileSync(fakeHerdrState, 'utf8')) as {
              process_group_id?: number
            }
            if (Number.isSafeInteger(current.process_group_id)
              && Number(current.process_group_id) > 1) {
              try { process.kill(-Number(current.process_group_id), 'SIGKILL') } catch {}
            }
          } catch {}
        }
        store.close()
        socket.stop(true)
      }
    },
  }
}

function armRetiredRequestedRound(
  fixture: BrokerFixture,
  input: AdvisorInputSnapshot,
  options: {
    persistClaudeOutcome?: boolean
    version?: 8 | 9
    phase?: 'investigation' | 'review'
    nativeResponse?: string
  } = {},
): { journalPath: string; lockPath: string } {
  const version = options.version ?? 8
  const phase = options.phase ?? 'investigation'
  const perspective = phase === 'review' ? 'risk' : 'solution'
  const revisionRoot = join(
    fixture.journalRoot,
    `revision-${input.revision}-${input.digest.slice(0, 16)}`,
  )
  mkdirSync(revisionRoot, { recursive: true, mode: 0o700 })
  const repositoryDigest = advisorRepositoryDigest(
    snapshotAdvisorRepository(resolveAdvisorProjectLayout(fixture.repo)),
  )
  const startedAt = Date.now() - 10
  const brokerProcessId = 4242
  const journalPath = join(revisionRoot, `${phase}-1.json`)
  const lockPath = join(fixture.journalRoot, 'active-round.lock')
  writeFileSync(journalPath, `${JSON.stringify({
    version,
    ...(version === 9 ? { advisorPolicy: 'three-phase-specific-conditional-final-v2' } : {}),
    status: 'requested',
    jobId: fixture.jobId,
    phase,
    round: 1,
    attemptNonce: fixture.nonce,
    contextDigest: fixture.contextDigest,
    processNonce: fixture.nonce,
    inputRevision: input.revision,
    inputDigest: input.digest,
    repositoryDigest,
    repositoryDigestBefore: repositoryDigest,
    repositoryObservation: 'not-required-in-unified-workflow',
    brokerProcessId,
    primaryEvidenceDigest: options.nativeResponse
      ? createHash('sha256').update('bounded primary evidence').digest('hex') : '5'.repeat(64),
    native: version === 9
      ? [{
        perspective, attempted: true, adopted: true,
        agentId: `/root/native-${perspective}`,
        responseDigest: options.nativeResponse ? nativeAdvisorResponseDigest(options.nativeResponse) : '1'.repeat(64),
        responseTransportDigest: options.nativeResponse ? nativeAdvisorResponseTransportDigest(options.nativeResponse) : '2'.repeat(64),
      }]
      : [{
        perspective: 'solution', attempted: true, adopted: true,
        agentId: '/root/native-solution', responseDigest: '1'.repeat(64),
        responseTransportDigest: '2'.repeat(64),
      },
      {
        perspective: 'risk', attempted: true, adopted: true,
        agentId: '/root/native-risk', responseDigest: '3'.repeat(64),
        responseTransportDigest: '4'.repeat(64),
      }],
    startedAt,
  })}\n`, { mode: 0o600 })
  writeFileSync(lockPath, `${JSON.stringify({
    version: 2,
    jobId: fixture.jobId,
    attemptNonce: fixture.nonce,
    contextDigest: fixture.contextDigest,
    processNonce: fixture.nonce,
    phase,
    round: 1,
    inputRevision: input.revision,
    inputDigest: input.digest,
    brokerProcessId,
    startedAt,
  })}\n`, { mode: 0o600 })
  if (options.persistClaudeOutcome !== false) {
    persistAdvisorClaudeCleanupOutcome(fixture.state, {
      jobId: fixture.jobId,
      attemptNonce: fixture.nonce,
      inputRevision: input.revision,
      inputDigest: input.digest,
      inputDigestPrefix: input.digest.slice(0, 16),
      phase,
      round: 1,
      workspaceCreationAttempted: false,
      freshEphemeral: false,
      cleanupVerified: false,
      promptMayHaveBeenDelivered: false,
    })
  }
  recordAdvisorExecutorRetirement({
    stateDir: fixture.state,
    jobId: fixture.jobId,
    attemptNonce: fixture.nonce,
    contextDigest: fixture.contextDigest,
    fingerprint: fixture.fingerprint,
    supervisor: {
      pid: 9876,
      pgid: 9876,
      started: 'fixture-generation',
      bootSession: 'fixture-boot',
      startSec: 1,
      startUsec: 0,
    },
  })
  return { journalPath, lockPath }
}

describe('advisor broker boundaries', () => {
  test('Grok authは内容を読まずsafe presence/absenceとrecovery transitionを分類する', () => {
    const home = fixtureDir()
    chmodSync(home, 0o700)
    const absentDirectory = classifyGrokAuthState(home)
    expect(absentDirectory.kind).toBe('absent-safe')

    const grok = join(home, '.grok')
    mkdirSync(grok, { mode: 0o700 })
    const absentFile = classifyGrokAuthState(home)
    expect(absentFile.kind).toBe('absent-safe')

    const auth = join(grok, 'auth.json')
    writeFileSync(auth, '{"fixture":"first"}\n', { mode: 0o600 })
    const present = classifyGrokAuthState(home)
    expect(present.kind).toBe('present-safe')
    expect(grokAuthRecoveryTransitionIsSafe(absentFile, present)).toBe(true)

    writeFileSync(auth, '{"fixture":"second-and-changed"}\n', { mode: 0o600 })
    const refreshed = classifyGrokAuthState(home)
    expect(refreshed.kind).toBe('present-safe')
    expect(grokAuthRecoveryTransitionIsSafe(present, refreshed)).toBe(true)

    chmodSync(auth, 0o644)
    expect(classifyGrokAuthState(home).kind).toBe('unsafe')
  })

  test('Grok auth recoveryはexact marker+78とfixed completionだけを採択する', () => {
    const exact = {
      exitCode: 78,
      stdout: '',
      stderr: 'GROK_REVIEWER_AUTH_REQUIRED\n',
      timedOut: false,
      forcedCleanup: false,
      outputTruncated: false,
    }
    expect(grokReviewerAuthRequired(exact)).toBe(true)
    for (const candidate of [
      { ...exact, exitCode: 1 },
      { ...exact, stdout: 'extra' },
      { ...exact, stderr: 'GROK_REVIEWER_AUTH_REQUIRED' },
      { ...exact, stderr: 'GROK_REVIEWER_AUTH_REQUIRED\nextra\n' },
      { ...exact, timedOut: true },
      { ...exact, forcedCleanup: true },
      { ...exact, outputTruncated: true },
    ]) expect(grokReviewerAuthRequired(candidate)).toBe(false)

    expect(grokOAuthCompletionOutput([
      '{"status":"oauth-browser-opened"}',
      '{"status":"oauth-login-complete"}',
      '',
    ].join('\n'))).toBe(true)
    expect(grokOAuthCompletionOutput('{"status":"oauth-login-complete"}\n')).toBe(false)
    expect(grokOAuthCompletionOutput([
      '{"status":"oauth-browser-opened"}',
      '{"status":"oauth-login-complete","url":"forbidden"}',
    ].join('\n'))).toBe(false)
    expect(GROK_OAUTH_TIMEOUT_MS).toBe(600_000)
  })

  test('Claude認証preflightへOSユーザー文脈を渡しAPI credentialは継承しない', async () => {
    const root = fixtureDir()
    const fakeClaude = join(root, 'claude')
    writeFileSync(fakeClaude, [
      '#!/bin/sh',
      // Keep the fixture alive long enough for runBounded to record its process generation.
      '/bin/sleep 0.2',
      'if [ -n "${USER:-}" ] && [ "$USER" = "${LOGNAME:-}" ] && [ -n "${SHELL:-}" ] && [ -n "${TMPDIR:-}" ]; then',
      '  printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\'',
      'else',
      '  printf \'%s\\n\' \'{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","subscriptionType":null}\'',
      'fi',
      '',
    ].join('\n'), { mode: 0o700 })

    const environment = {
      ...brokerEnvironment(),
      ZEROKUN_CLAUDE_BIN_PATH: fakeClaude,
    }
    expect(environment.USER).toBe(environment.LOGNAME)
    expect(environment.USER).not.toBe('')
    expect(environment.SHELL).not.toBe('')
    expect(environment.TMPDIR).not.toBe('')
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
    expect(environment.XAI_API_KEY).toBeUndefined()
    await expect(assertClaudeSubscriptionLogin(environment)).resolves.toBeUndefined()

    const missingUserContext = { ...environment }
    delete missingUserContext.USER
    delete missingUserContext.LOGNAME
    delete missingUserContext.SHELL
    delete missingUserContext.TMPDIR
    await expect(assertClaudeSubscriptionLogin(missingUserContext)).rejects.toThrow(
      'first-party subscription',
    )
  })

  test('Claudeはfirst-party subscription statusだけを実行時に受理する', () => {
    expect(claudeSubscriptionStatusIsReady({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'max',
    })).toBe(true)
    for (const invalid of [
      { loggedIn: false, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' },
      { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', subscriptionType: 'api' },
      { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'thirdParty', subscriptionType: 'max' },
      { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: '' },
    ]) expect(claudeSubscriptionStatusIsReady(invalid)).toBe(false)
  })

  test('prompt-startedのexact markerだけを送達可能として分類する', () => {
    const marker = 'REQUEST_MARKER=' + 'A'.repeat(32)
    expect(parseFifthAdvisorSendOutcome(JSON.stringify({ status: 'prompt-started', marker, state_change_seq: 42 })))
      .toEqual({ kind: 'possibly-delivered', marker, stateChangeSeq: 42 })
    expect(parseFifthAdvisorSendOutcome([
      JSON.stringify({ status: 'prompt-started', marker }),
      JSON.stringify({ status: 'prompt-command-rejected' }),
    ].join('\n'))).toEqual({ kind: 'possibly-delivered', marker })
    expect(parseFifthAdvisorSendOutcome([
      JSON.stringify({ status: 'prompt-started', marker }),
      JSON.stringify({ status: 'prompt-command-timeout-or-error' }),
    ].join('\n'))).toEqual({ kind: 'possibly-delivered', marker })
    expect(parseFifthAdvisorSendOutcome(
      JSON.stringify({ status: 'prompt-command-rejected' }),
    )).toEqual({ kind: 'unconfirmed' })
    expect(parseFifthAdvisorSendOutcome([
      JSON.stringify({ status: 'prompt-started', marker }),
      JSON.stringify({ status: 'prompt-started', marker }),
    ].join('\n'))).toEqual({ kind: 'unconfirmed' })
    expect(parseFifthAdvisorSendOutcome(
      JSON.stringify({ status: 'prompt-started', marker: 'REQUEST_MARKER=bad' }),
    )).toEqual({ kind: 'unconfirmed' })
  })

  test('reviewer promptはstdinだけで渡しprocess argvへ載せない', async () => {
    const confidential = 'SLACK-CONFIDENTIAL-ARGV-SENTINEL'
    const result = await runBounded([
      '/usr/bin/python3', '-c',
      'import json,sys; print(json.dumps({"argv":sys.argv[1:],"stdin":sys.stdin.read()}))',
      'fixed-argument',
    ], {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      stdin: confidential,
    })
    expect(result.exitCode).toBe(0)
    const observed = JSON.parse(result.stdout) as { argv: string[]; stdin: string }
    expect(observed).toEqual({ argv: ['fixed-argument'], stdin: confidential })
    expect(observed.argv.join(' ')).not.toContain(confidential)
  })

  test('全reviewer transportは共通2MiB byte境界を使う', async () => {
    const exact = new Uint8Array(MAX_ADVISOR_PROMPT_BYTES)
    const result = await runBounded([
      '/usr/bin/python3', '-c', 'import sys; print(len(sys.stdin.buffer.read()))',
    ], { cwd: '/', env: { PATH: '/usr/bin:/bin' }, stdin: exact })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(String(MAX_ADVISOR_PROMPT_BYTES))
    await expect(runBounded([
      '/usr/bin/python3', '-c', 'import sys; sys.stdin.buffer.read()',
    ], {
      cwd: '/', env: { PATH: '/usr/bin:/bin' },
      stdin: new Uint8Array(MAX_ADVISOR_PROMPT_BYTES + 1),
    })).rejects.toThrow('shared transport byte limit')
  })

  test('reviewer processはwhole-job deadlineなしで自然終了まで待つ', async () => {
    const startedAt = Date.now()
    const result = await runBounded([
      '/bin/sh', '-c', '/bin/sleep 0.15; printf completed',
    ], {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toBe('completed')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
  })

  test('trackerの一時失敗は最終reapが空ならreviewer結果を失敗へ昇格しない', async () => {
    const result = await runBounded([
      '/usr/bin/python3', '-c', 'print("review complete")',
    ], {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      captureProcessesForTesting: () => {
        throw new Error('fixture tracker read failed')
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('review complete')
    expect(result.trackingWarning).toContain('temporarily unavailable')
  })

  test.skipIf(process.platform === 'win32')(
    '初回generation固定に失敗してもgroup-aware reapを通して子processを残さない',
    async () => {
      const dir = fixtureDir()
      const pidFile = join(dir, 'startup-child.pid')
      const script = join(dir, 'startup-child.sh')
      writeFileSync(script, [
        '#!/bin/sh',
        '/bin/sleep 30 &',
        `printf '%s' "$!" > ${JSON.stringify(pidFile)}`,
        'wait',
        '',
      ].join('\n'), { mode: 0o700 })
      await expect(runBounded(['/bin/sh', script], {
        cwd: '/',
        env: { PATH: '/usr/bin:/bin' },
        terminationGraceMs: 100,
        seedProcessForTesting: () => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
          throw new Error('fixture seed failure')
        },
      })).rejects.toThrow('identity could not be tracked')
      const descendant = Number(readFileSync(pidFile, 'utf8'))
      expect(Number.isSafeInteger(descendant)).toBe(true)
      expect(readProcessIdentity(descendant)).toBeUndefined()
    },
    5_000,
  )

  test('外部reviewerの各起動境界は有限timeoutを持つ', () => {
    expect(GROK_REVIEW_TIMEOUT_MS).toBe(60 * 60 * 1_000)
    expect(CLAUDE_HELPER_TIMEOUT_MS).toBe(140_000)
  })

  test.skipIf(process.platform === 'win32')(
    'reviewer正常回答後のTERM無視子をforce回収した事実を成功として隠さない',
    async () => {
      const dir = fixtureDir()
      const script = join(dir, 'forced-descendant.py')
      const pidFile = join(dir, 'descendant.pid')
      writeFileSync(script, `import os, signal, time
child = os.fork()
if child == 0:
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    devnull = os.open('/dev/null', os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    while True:
        time.sleep(30)
with open(os.environ['DESCENDANT_PID_FILE'], 'w', encoding='utf-8') as stream:
    stream.write(str(child))
time.sleep(0.3)
print('review complete')
`)
      chmodSync(script, 0o700)
      const result = await runBounded(['/usr/bin/python3', script], {
        env: { PATH: '/usr/bin:/bin', DESCENDANT_PID_FILE: pidFile },
        terminationGraceMs: 100,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('review complete')
      expect(result.timedOut).toBe(false)
      expect(result.forcedCleanup).toBe(true)
      expect(readProcessIdentity(Number(readFileSync(pidFile, 'utf8')))).toBeUndefined()
    },
    5_000,
  )

  test('reviewer出力がmanaged上限を超えた事実を黙って採択しない', async () => {
    const exact = await runBounded([
      '/usr/bin/python3', '-c', 'import sys; sys.stdout.write("x" * 262144)',
    ], { cwd: '/', env: { PATH: '/usr/bin:/bin' } })
    expect(exact.exitCode).toBe(0)
    expect(exact.outputTruncated).toBe(false)
    expect(Buffer.byteLength(exact.stdout)).toBe(256 * 1024)
    const result = await runBounded([
      '/usr/bin/python3', '-c', 'import sys; sys.stdout.write("x" * 262145)',
    ], { cwd: '/', env: { PATH: '/usr/bin:/bin' } })
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.outputTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBe(256 * 1024)
  })

  test('terminal reviewer結果はexact receiptまたは同一bindingの次pollでcompletedになる', () => {
    const token = 'a'.repeat(64)
    const base = { status: 'reviewers-completed', finishedAt: 100 }
    const issued = advanceAdvisorReceipt(base, undefined, 101, () => token)
    expect(issued).toMatchObject({
      kind: 'issued', receipt: token,
      journal: { status: 'reviewers-completed', receiptIssuedAt: 101, receipt: token },
    })
    if (issued.kind !== 'issued') throw new Error('receipt was not issued')
    expect(advanceAdvisorReceipt(issued.journal, 'b'.repeat(64), 102)).toEqual({ kind: 'invalid' })
    const completed = advanceAdvisorReceipt(issued.journal, token, 102)
    expect(completed).toMatchObject({
      kind: 'completed', pollObservedAt: 102,
      journal: {
        status: 'completed',
        receiptIssuedAt: 101,
        receiptAcknowledgement: 'exact-echo',
        pollObservedAt: 102,
      },
    })
    if (completed.kind !== 'completed') throw new Error('receipt was not acknowledged')
    expect(completed.journal.receipt).toBeUndefined()
    expect(completed.journal.receiptDigest).toMatch(/^[0-9a-f]{64}$/)
    const duplicatePoll = advanceAdvisorReceipt(issued.journal, undefined, 103)
    expect(duplicatePoll).toMatchObject({
      kind: 'completed',
      journal: {
        status: 'completed',
        receiptAcknowledgement: 'bound-repoll',
        pollObservedAt: 103,
      },
    })
  })

  test('receipt challengeは大型advisor回答を再掲せず単発ackを指示する', () => {
    const challenge = advisorReceiptChallenge({
      phase: 'investigation',
      round: 1,
      inputRevision: 2,
      inputDigest: 'd'.repeat(64),
      receipt: 'e'.repeat(64),
    })
    expect(challenge).toEqual({
      complete: false,
      receiptRequired: true,
      phase: 'investigation',
      round: 1,
      inputRevision: 2,
      inputDigest: 'd'.repeat(64),
      receipt: 'e'.repeat(64),
      nextAction: 'Call advisor_round_poll exactly once with this receipt and the same binding; do not batch or parallelize polls.',
    })
    expect(challenge.grok).toBeUndefined()
    expect(challenge.claude).toBeUndefined()
    expect(challenge.allAdopted).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(challenge))).toBeLessThan(1024)
  })

  test('completed後の重複pollは大型advisor回答を再掲しない', () => {
    const slotSummary = summarizeAdvisorSlots([
      { perspective: 'solution', adopted: true },
      { perspective: 'risk', adopted: true },
    ], [
      { perspective: 'solution', adopted: false, executionState: 'start-unconfirmed' },
      { perspective: 'risk', adopted: false, executionState: 'start-unconfirmed' },
    ], { adopted: false, workspaceCreationAttempted: false })
    const observed = advisorReceiptAlreadyObserved({
      phase: 'investigation',
      round: 1,
      inputRevision: 2,
      inputDigest: 'f'.repeat(64),
      pollObservedAt: 123,
      slotSummary,
    })
    expect(observed).toEqual({
      complete: false,
      alreadyObserved: true,
      phase: 'investigation',
      round: 1,
      inputRevision: 2,
      inputDigest: 'f'.repeat(64),
      pollObservedAt: 123,
      slotSummary,
    })
    expect(observed.grok).toBeUndefined()
    expect(observed.claude).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(observed))).toBeLessThan(1024)
  })

  test('allAdoptedはnative採択数0・1・2を含む全5slotを数える', () => {
    const grok = [{ adopted: true }, { adopted: true }]
    const claude = { adopted: true }
    expect(allAdvisorAttemptsAdopted(
      [{ adopted: true }, { adopted: true }], grok, claude,
    )).toBe(true)
    expect(allAdvisorAttemptsAdopted(
      [{ adopted: true }, { adopted: false }], grok, claude,
    )).toBe(false)
    expect(allAdvisorAttemptsAdopted(
      [{ adopted: false }, { adopted: false }], grok, claude,
    )).toBe(false)
    expect(allAdvisorAttemptsAdopted(
      [{ adopted: true }, { adopted: true }], [{ adopted: false }, { adopted: true }], claude,
    )).toBe(false)
  })

  test('slotSummaryは未起動・起動未確認・起動済み・回答取得を混同しない', () => {
    const summary = summarizeAdvisorSlots([
      { perspective: 'solution', adopted: true },
      {
        perspective: 'risk', adopted: false, started: true,
        executionState: 'started-no-response',
      },
    ], [
      {
        perspective: 'solution', adopted: false,
        executionState: 'unavailable-before-start',
      },
      {
        perspective: 'risk', adopted: false,
        executionState: 'start-unconfirmed',
      },
    ], {
      adopted: false,
      workspaceCreationAttempted: false,
      executionState: 'unavailable-before-start',
    })
    expect(summary).toEqual({
      total: 5,
      started: 2,
      responsesObtained: 1,
      startedNoResponse: 1,
      startUnconfirmed: 1,
      unavailableBeforeStart: 2,
      slots: [
        { slot: 'codex-solution', state: 'response-obtained' },
        { slot: 'codex-risk', state: 'started-no-response' },
        { slot: 'grok-solution', state: 'unavailable-before-start' },
        { slot: 'grok-risk', state: 'start-unconfirmed' },
        { slot: 'claude', state: 'unavailable-before-start' },
      ],
    })
    const workspaceOnly = summarizeAdvisorSlots([], [], {
      adopted: false,
      workspaceCreationAttempted: true,
      freshEphemeral: true,
      promptMayHaveBeenDelivered: false,
      executionState: 'start-unconfirmed',
    })
    expect(workspaceOnly.slots.at(-1)).toEqual({
      slot: 'claude', state: 'start-unconfirmed',
    })
    expect(workspaceOnly.started).toBe(0)
    expect(workspaceOnly.startUnconfirmed).toBe(1)
  })

  test('単一workflowは初期設計と最終reviewだけを各1回使う', () => {
    expect(requiredAdvisorPhases(true, 'complete')).toEqual(['investigation', 'review'])
    expect(requiredAdvisorPhases(false, 'complete')).toEqual(['investigation'])
    expect(requiredAdvisorPhases(true, 'prepare')).toEqual([
      'investigation', 'design', 'review',
    ])
  })

  test('最終review round 2 promptは必須修正deltaと直接回帰だけへ限定する', () => {
    const prompt = advisorPrompt({
      version: 4,
      jobId: 'job-1',
      attemptNonce: 'a'.repeat(32),
      repoPath: '/tmp/example',
      gitRoot: '/tmp/example',
      gitRoots: ['/tmp/example'],
      writeEnabled: true,
      initialRepositoryDigest: 'b'.repeat(64),
    }, {
      revision: 2,
      digest: 'c'.repeat(64),
      transcript: 'current task',
      entries: [],
    }, 'review', 2, 'bounded delta evidence')
    expect(prompt).toContain('最終レビューround 2')
    expect(prompt).toContain('task-owned修正差分')
    expect(prompt).toContain('回帰だけ')
    expect(prompt).toContain('元実装全体の再レビュー')
  })

  test('Claude cleanup receiptはcallerのproperty挿入順によらず再送可能', () => {
    const state = fixtureDir()
    chmodSync(state, 0o700)
    const common = {
      jobId: 'job-order-fixture',
      attemptNonce: 'a'.repeat(32),
      inputRevision: 1,
      inputDigest: 'b'.repeat(64),
      inputDigestPrefix: 'b'.repeat(16),
      phase: 'investigation' as const,
      round: 1 as const,
    }
    persistAdvisorClaudeCleanupOutcome(state, {
      ...common,
      workspaceCreationAttempted: true,
      freshEphemeral: true,
      cleanupVerified: true,
      cleanupStatus: 'closed-and-verified',
      cleanupReceiptDigest: 'c'.repeat(64),
      promptMayHaveBeenDelivered: true,
    })
    expect(() => persistAdvisorClaudeCleanupOutcome(state, {
      promptMayHaveBeenDelivered: true,
      cleanupReceiptDigest: 'c'.repeat(64),
      cleanupStatus: 'closed-and-verified',
      cleanupVerified: true,
      freshEphemeral: true,
      workspaceCreationAttempted: true,
      ...common,
    })).not.toThrow()
  })

  test('別ユーザーの同一thread追記で旧revisionになったnative調査をstale journalへ固定する', async () => {
    const fixture = await brokerFixture()
    try {
      const { result, payload } = await fixture.call()
      expect(result.isError).toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        staleInput: true,
        journaledStaleInput: true,
        inputRevision: fixture.revisionOne.revision,
        inputDigest: fixture.revisionOne.digest,
        currentInputRevision: fixture.revisionTwo.revision,
        currentInputDigest: fixture.revisionTwo.digest,
      })
      const path = join(
        fixture.journalRoot,
        `revision-${fixture.revisionOne.revision}-${fixture.revisionOne.digest.slice(0, 16)}`,
        'investigation-1.json',
      )
      const journal = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      expect(journal).toMatchObject({
        version: 9,
        advisorPolicy: 'three-phase-specific-conditional-final-v2',
        status: 'stale-input',
        inputRevision: fixture.revisionOne.revision,
        inputDigest: fixture.revisionOne.digest,
      })
      expect(journal.grok).toEqual([
        expect.objectContaining({
          perspective: 'solution', attempted: true, adopted: false,
          executionState: 'start-unconfirmed',
        }),
      ])
      expect(journal.claude).toMatchObject({
        attempted: true,
        required: true,
        lifecycle: 'ephemeral-v2',
        adopted: false,
        executionState: 'unavailable-before-start',
      })
      expect(journal.slotSummary).toMatchObject({
        total: 3,
        started: 1,
        responsesObtained: 1,
        startUnconfirmed: 1,
        unavailableBeforeStart: 1,
      })
      expect((journal.native as Array<Record<string, unknown>>).every(entry => (
        typeof entry.responseTransportDigest === 'string'
        && /^[0-9a-f]{64}$/.test(entry.responseTransportDigest)
      ))).toBe(true)
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('native成功数0でもphase別slotのattempted unavailableをversion 9へ固定する', async () => {
    const fixture = await brokerFixture()
    try {
      const { payload } = await fixture.call('investigation', 'revision-one', 'unavailable')
      expect(payload).toMatchObject({
        complete: false,
        staleInput: true,
        journaledStaleInput: true,
      })
      const path = join(
        fixture.journalRoot,
        `revision-${fixture.revisionOne.revision}-${fixture.revisionOne.digest.slice(0, 16)}`,
        'investigation-1.json',
      )
      const journal = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      expect(journal.version).toBe(9)
      expect(journal.native).toEqual([
        expect.objectContaining({ perspective: 'solution', attempted: true, adopted: false }),
      ])
      expect((journal.native as Array<Record<string, unknown>>).every(entry => (
        typeof entry.reasonDigest === 'string'
        && /^[0-9a-f]{64}$/.test(entry.reasonDigest)
        && entry.responseDigest === undefined
      ))).toBe(true)
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('外部model起動未確認とnative未起動を3枠成功と誤報せずroundは完了する', async () => {
    const fixture = await brokerFixture()
    try {
      const { result, payload } = await fixture.call(
        'investigation', 'revision-two', 'unavailable',
      )
      expect(result.isError).toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        allAdopted: false,
        advisorUnavailable: expect.any(Array),
        slotSummary: {
          total: 3,
          started: 0,
          responsesObtained: 0,
          startUnconfirmed: 1,
          unavailableBeforeStart: 2,
        },
      })
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('Claude復旧receipt不一致でも元の未完了roundをrequestedで破壊しない', async () => {
    const fixture = await brokerFixture({ externalSuccess: true, claudeFailures: 1 })
    try {
      const first = await fixture.call('investigation', 'revision-two')
      expect(first.payload.complete).toBe(false)
      const revision = `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`
      const journalPath = join(fixture.journalRoot, revision, 'investigation-1.json')
      const cache = JSON.parse(readFileSync(`${journalPath}.responses`, 'utf8'))
      cache.finishedAt -= 31_000
      const raw = JSON.stringify(cache)
      writeFileSync(`${journalPath}.responses`, raw, { mode: 0o600 })
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
      journal.responseCacheDigest = createHash('sha256').update(raw).digest('hex')
      writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 })
      const cleanupPath = join(fixture.state, 'advisor-round-cleanup', fixture.jobId, fixture.nonce, revision, 'investigation-1.json')
      const cleanup = JSON.parse(readFileSync(cleanupPath, 'utf8'))
      cleanup.cleanupReceiptDigest = 'f'.repeat(64)
      writeFileSync(cleanupPath, JSON.stringify(cleanup), { mode: 0o600 })
      const retry = await fixture.call('investigation', 'revision-two', 'adopted', 1, { retryUnavailable: true })
      expect(retry.payload).toMatchObject({ complete: false, waitingForAdvisors: true, retryable: false })
      expect(JSON.parse(readFileSync(journalPath, 'utf8')).status).toBe('required-reviewer-failed')
      expect(JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8')).prompt_count).toBe(1)
    } finally { await fixture.close() }
  }, 20_000)

  test('Claudeだけ2回未回収でも取得済み回答を保持し3回目で同じroundを完了する', async () => {
    const fixture = await brokerFixture({ externalSuccess: true, claudeFailures: 2 })
    try {
      const journalPath = join(fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`,
        'investigation-1.json')
      const first = await fixture.call('investigation', 'revision-two')
      expect(first.payload.complete).toBe(false)
      expect(first.payload.slotSummary).toMatchObject({ responsesObtained: 2 })
      const firstGrok = JSON.stringify(first.payload.grok)
      const early = await fixture.call('investigation', 'revision-two', 'adopted', 1, { retryUnavailable: true })
      expect(early.payload).toMatchObject({ complete: false, retryable: true })
      expect(JSON.parse(readFileSync(journalPath, 'utf8')).status).toBe('required-reviewer-failed')
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt === 1) fixture.stageRevision('ログインを復旧しました。依頼内容は変更せず再開してください。')
        // Simulate elapsed recovery backoff without adding a minute to the suite.
        const cache = JSON.parse(readFileSync(`${journalPath}.responses`, 'utf8'))
        cache.finishedAt -= 31_000
        const raw = JSON.stringify(cache)
        writeFileSync(`${journalPath}.responses`, raw, { mode: 0o600 })
        const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
        journal.responseCacheDigest = createHash('sha256').update(raw).digest('hex')
        writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 })
        const retry = await fixture.call('investigation', 'revision-two', 'adopted', 1,
          { retryUnavailable: true, inputUpdateIsRecoveryOnly: attempt === 1 })
        expect(JSON.stringify(retry.payload.grok)).toBe(firstGrok)
        expect(retry.payload.complete).toBe(attempt === 1)
        expect(retry.payload.slotSummary).toMatchObject({ responsesObtained: attempt === 1 ? 3 : 2 })
      }
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(3)
      expect(state.close_count).toBe(3)
      expect(state.owned).toBe(false)
    } finally { await fixture.close() }
  }, 45_000)

  test('broker正常系はGrok 1件とfresh Claude 1件を実起動して3/3を記録する', async () => {
    const fixture = await brokerFixture({ externalSuccess: true, transientProbeDenial: true })
    try {
      const { result, payload } = await fixture.call('investigation', 'revision-two')
      expect(result.isError).not.toBe(true)
      expect(payload).toMatchObject({
        complete: true,
        allAdopted: true,
        slotSummary: {
          total: 3,
          started: 3,
          responsesObtained: 3,
          startUnconfirmed: 0,
          unavailableBeforeStart: 0,
        },
        claude: {
          adopted: true,
          executionState: 'response-obtained',
          workspaceCreationAttempted: true,
          freshEphemeral: true,
          cleanupVerified: true,
          cleanupStatus: 'closed-and-verified',
        },
      })
      const grok = payload.grok as Array<Record<string, unknown>>
      expect(grok).toHaveLength(1)
      expect(grok.every(entry => (
        entry.adopted === true && entry.executionState === 'response-obtained'
      ))).toBe(true)
      const journalPath = join(
        fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`,
        'investigation-1.json',
      )
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>
      expect(journal).toMatchObject({
        version: 9,
        advisorPolicy: 'three-phase-specific-conditional-final-v2',
        status: 'completed',
        slotSummary: { total: 3, started: 3, responsesObtained: 3 },
      })
      const journalGrok = journal.grok as Array<Record<string, unknown>>
      expect(new Set(journalGrok.map(entry => entry.processId)).size).toBe(1)
      const modelPids = grok.map(entry => {
        const match = /pid=([1-9][0-9]*)/.exec(String(entry.response ?? ''))
        return match ? Number(match[1]) : Number.NaN
      })
      expect(modelPids.every(Number.isSafeInteger)).toBe(true)
      expect(new Set(modelPids).size).toBe(1)
      const evidence = fixture.externalEvidence
      expect(evidence).toBeDefined()
      const claudeState = JSON.parse(readFileSync(evidence!.fakeHerdrState, 'utf8')) as {
        owned: boolean
        agent: boolean
        process: boolean
        prompt_count: number
        close_count: number
        process_pid: number
        process_group_id: number
      }
      expect(claudeState).toMatchObject({
        owned: false,
        agent: false,
        process: false,
        prompt_count: 1,
        close_count: 1,
      })
      expect(() => process.kill(claudeState.process_pid, 0)).toThrow()
      expect(() => process.kill(-claudeState.process_group_id, 0)).toThrow()
    } finally {
      await fixture.close()
    }
  }, 30_000)

  test('期限切れGrokはphase内OAuthを1回だけ行い該当slotだけ再実行する', async () => {
    const attempts = new Map<string, number>()
    let recoveries = 0
    const present: ReturnType<typeof classifyGrokAuthState> = {
      kind: 'present-safe', home: '/fixture',
    }
    const outcomes = await executeGrokPanelWithRecovery({
      perspective: 'solution',
      initialAuth: present,
      runAttempt: async perspective => {
        const attempt = (attempts.get(perspective) ?? 0) + 1
        attempts.set(perspective, attempt)
        return perspective === 'solution' && attempt === 1
          ? { perspective, authRequired: true as const, adopted: false }
          : { perspective, adopted: true }
      },
      runRecovery: async () => {
        recoveries += 1
        return { recovered: true, reason: 'fixture', state: present }
      },
      unavailable: (perspective, reason) => ({ perspective, adopted: false, reason }),
    })
    expect(recoveries).toBe(1)
    expect(attempts).toEqual(new Map([['solution', 2]]))
    expect(outcomes).toEqual([
      {
        perspective: 'solution', adopted: true,
        authenticationRecoveryAttempted: true,
      },
    ])
  })

  test('Grok OAuth回復予算は最終reviewの複数roundで共有し失敗時も再消費しない', async () => {
    const present: ReturnType<typeof classifyGrokAuthState> = {
      kind: 'present-safe', home: '/fixture',
    }
    let claimed = false
    let recoveries = 0
    const claimRecovery = () => {
      if (claimed) return false
      claimed = true
      return true
    }
    const run = () => executeGrokPanelWithRecovery({
      perspective: 'risk' as const,
      initialAuth: present,
      runAttempt: async perspective => ({
        perspective, authRequired: true as const, adopted: false,
      }),
      runRecovery: async () => {
        recoveries += 1
        return { recovered: false, reason: 'fixture recovery failed' }
      },
      unavailable: (perspective, reason) => ({ perspective, adopted: false, reason }),
      claimRecovery,
    })
    expect(await run()).toEqual([expect.objectContaining({
      authenticationRecoveryAttempted: true,
    })])
    expect(await run()).toEqual([expect.not.objectContaining({
      authenticationRecoveryAttempted: true,
    })])
    expect(recoveries).toBe(1)
  })

  test('OAuth claimのI/O例外はGrok欠員へ閉じて並行phaseをrejectしない', async () => {
    let attempts = 0
    let recoveries = 0
    const outcomes = await executeGrokPanelWithRecovery({
      perspective: 'risk',
      initialAuth: { kind: 'absent-safe', home: '/fixture' },
      runAttempt: async perspective => {
        attempts += 1
        return { perspective, adopted: true }
      },
      runRecovery: async () => {
        recoveries += 1
        return { recovered: true, reason: 'must not run' }
      },
      unavailable: (perspective, reason) => ({ perspective, adopted: false, reason }),
      claimRecovery: () => { throw new Error('fixture I/O failure') },
    })
    expect(attempts).toBe(0)
    expect(recoveries).toBe(0)
    expect(outcomes).toEqual([expect.objectContaining({
      perspective: 'risk',
      adopted: false,
      reason: 'Grok OAuth recovery was already attempted for this advisor phase',
    })])
  })

  test('Grok auth不在からの回復成功も回復試行済みとして記録する', async () => {
    const present: ReturnType<typeof classifyGrokAuthState> = {
      kind: 'present-safe', home: '/fixture',
    }
    let claims = 0
    const outcomes = await executeGrokPanelWithRecovery({
      perspective: 'solution',
      initialAuth: { kind: 'absent-safe', home: '/fixture' },
      runAttempt: async perspective => ({ perspective, adopted: true }),
      runRecovery: async () => ({ recovered: true, reason: 'fixture', state: present }),
      unavailable: (perspective, reason) => ({ perspective, adopted: false, reason }),
      claimRecovery: () => { claims += 1; return true },
    })
    expect(claims).toBe(1)
    expect(outcomes).toEqual([{
      perspective: 'solution', adopted: true, authenticationRecoveryAttempted: true,
    }])
  })

  test('read-only jobのstale designはphase検証で拒否してjournalを作らない', async () => {
    const fixture = await brokerFixture()
    try {
      const { result, payload } = await fixture.call('design')
      expect(result.isError).toBe(true)
      expect(String(payload.rawError)).toContain('Invalid option')
      expect(readdirSync(fixture.journalRoot)).toEqual([])
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('単一workflowでは事前のrepository変更をhost gateにせずpanel結果を返す', async () => {
    const fixture = await brokerFixture()
    try {
      writeFileSync(join(fixture.repo, 'README.md'), 'edited before investigation\n', { mode: 0o600 })
      const { result, payload } = await fixture.call('investigation', 'revision-two')
      expect(result.isError).toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        allAdopted: false,
        advisorUnavailable: expect.any(Array),
        slotSummary: {
          total: 3,
          started: 1,
          responsesObtained: 1,
        },
      })
      expect(payload.repositoryUnchanged).toBeUndefined()
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('単一workflowはsnapshot不能な大型dirty fileでもreviewer transportを止めない', async () => {
    const fixture = await brokerFixture()
    try {
      const oversized = join(fixture.repo, 'large-untracked.bin')
      writeFileSync(oversized, '', { mode: 0o600 })
      truncateSync(oversized, 65 * 1024 * 1024)
      const { result, payload } = await fixture.call('investigation', 'revision-two')
      expect(result.isError).toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        allAdopted: false,
        advisorUnavailable: expect.arrayContaining([
          expect.objectContaining({ advisor: 'grok' }),
          expect.objectContaining({ advisor: 'claude' }),
        ]),
        slotSummary: { total: 3, responsesObtained: 1 },
      })
      expect(payload.repositoryUnchanged).toBeUndefined()
      const journal = JSON.parse(readFileSync(join(
        fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`,
        'investigation-1.json',
      ), 'utf8')) as Record<string, unknown>
      expect(journal.repositoryObservation).toBe('not-required-in-unified-workflow')
      const journalPath = join(fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`, 'investigation-1.json')
      const cache = JSON.parse(readFileSync(`${journalPath}.responses`, 'utf8'))
      expect(cache.retryRepositoryDigest).toBeUndefined()
      cache.finishedAt -= 31_000
      const raw = JSON.stringify(cache)
      writeFileSync(`${journalPath}.responses`, raw, { mode: 0o600 })
      journal.responseCacheDigest = createHash('sha256').update(raw).digest('hex')
      writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 })
      const retry = await fixture.call('investigation', 'revision-two', 'adopted', 1, { retryUnavailable: true })
      expect(retry.payload.slotSummary).toMatchObject({ total: 3, responsesObtained: 1 })
      expect(String(retry.payload.reason)).not.toContain('not available for this retry')
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('単一write workflowは実装差分後のreviewを初期phaseの再実行なしで通す', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      const initial = await fixture.call('investigation', 'revision-two')
      expect(initial.result.isError).not.toBe(true)
      expect(initial.payload).toMatchObject({ complete: true })
      writeFileSync(join(fixture.repo, 'README.md'), 'implemented change\n', { mode: 0o600 })
      const review = await fixture.call('review', 'revision-two')
      expect(review.result.isError).not.toBe(true)
      expect(review.payload).toMatchObject({
        complete: true,
      })
      expect(review.payload.repositoryUnchanged).toBeUndefined()
      expect(existsSync(join(
        fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`,
        'review-1.json',
      ))).toBe(true)
    } finally {
      await fixture.close()
    }
  }, 20_000)

  test('単一write workflowはSlack追記後のreviewを新revisionで直接通す', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      const initial = await fixture.call('investigation', 'revision-one')
      expect(initial.payload).toMatchObject({ complete: false, staleInput: true })
      const review = await fixture.call('review', 'revision-two')
      expect(review.result.isError).not.toBe(true)
      expect(review.payload).toMatchObject({
        complete: true,
        inputRevision: fixture.revisionTwo.revision,
        slotSummary: { total: 3, responsesObtained: 3 },
      })
    } finally {
      await fixture.close()
    }
  }, 20_000)

  test('単一workflowは初期phase前のreviewを外部起動前に拒否する', async () => {
    const fixture = await brokerFixture({ writeEnabled: true })
    try {
      const review = await fixture.call('review', 'revision-two')
      expect(review.result.isError).toBe(true)
      expect(review.payload).toMatchObject({
        complete: false,
        reason: 'the attempt-wide initial-design advisor phase has not completed',
      })
      expect(readdirSync(fixture.journalRoot)).toEqual([])
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('単一workflowはrevisionが進んでも同じphaseを再起動しない', async () => {
    const fixture = await brokerFixture({ writeEnabled: true })
    try {
      const initial = await fixture.call('investigation', 'revision-one')
      expect(initial.payload).toMatchObject({ complete: false, staleInput: true })
      const repeated = await fixture.call('investigation', 'revision-two')
      expect(repeated.result.isError).not.toBe(true)
      expect(repeated.payload).toMatchObject({
        complete: false,
        reusedPriorPhase: true,
        priorStatus: 'stale-input',
        inputRevision: fixture.revisionOne.revision,
        inputDigest: fixture.revisionOne.digest,
      })
      const phaseJournals = readdirSync(fixture.journalRoot)
        .flatMap(name => readdirSync(join(fixture.journalRoot, name))
          .filter(entry => entry === 'investigation-1.json'))
      expect(phaseJournals).toHaveLength(1)
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('旧unified workflowのversion 8初期設計を更新後も再利用する', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      expect((await fixture.call('investigation', 'revision-two')).payload)
        .toMatchObject({ complete: true })
      const revisionRoot = join(
        fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`,
      )
      const journalPath = join(revisionRoot, 'investigation-1.json')
      const current = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>
      writeFileSync(journalPath, `${JSON.stringify({
        ...current,
        version: 8,
        advisorPolicy: undefined,
        native: (['solution', 'risk'] as const).map((perspective, index) => ({
          attempted: true, adopted: false, perspective,
          reasonDigest: String(index + 1).repeat(64),
          executionState: 'unavailable-before-start',
        })),
        grok: (['solution', 'risk'] as const).map((perspective, index) => ({
          attempted: true, adopted: false, perspective, containmentVerified: true,
          reasonDigest: String(index + 3).repeat(64),
          executionState: 'unavailable-before-start',
        })),
      })}\n`, { mode: 0o600 })

      const repeated = await fixture.call('investigation', 'revision-one')
      expect(repeated.result.isError).not.toBe(true)
      expect(repeated.payload).toMatchObject({
        complete: false,
        reusedPriorPhase: true,
        inputRevision: fixture.revisionTwo.revision,
      })
    } finally {
      await fixture.close()
    }
  }, 20_000)

  test('legacy investigation単体を初期設計完了として再利用しない', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      expect((await fixture.call('investigation', 'revision-two')).payload)
        .toMatchObject({ complete: true })
      const revisionRoot = join(
        fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`,
      )
      const journalPath = join(revisionRoot, 'investigation-1.json')
      const current = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>
      const unavailableClaude = current.claude
      writeFileSync(journalPath, `${JSON.stringify({
        ...current,
        version: 8,
        advisorPolicy: undefined,
        repositoryObservation: 'observed',
        native: (['solution', 'risk'] as const).map((perspective, index) => ({
          attempted: true, adopted: false, perspective,
          reasonDigest: String(index + 1).repeat(64),
          executionState: 'unavailable-before-start',
        })),
        grok: (['solution', 'risk'] as const).map((perspective, index) => ({
          attempted: true, adopted: false, perspective, containmentVerified: true,
          reasonDigest: String(index + 3).repeat(64),
          executionState: 'unavailable-before-start',
        })),
        claude: unavailableClaude,
      })}\n`, { mode: 0o600 })

      const repeated = await fixture.call('investigation', 'revision-one')
      expect(repeated.result.isError).toBe(true)
      expect(String(repeated.payload.reason)).toContain('ledger is inconsistent')
    } finally {
      await fixture.close()
    }
  }, 20_000)

  test('completed fast pathでもattempt全体の同一round重複を拒否する', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      expect((await fixture.call('investigation', 'revision-two')).payload)
        .toMatchObject({ complete: true })
      const sourceRoot = join(
        fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`,
      )
      const duplicateRoot = join(
        fixture.journalRoot,
        `revision-${fixture.revisionOne.revision}-${fixture.revisionOne.digest.slice(0, 16)}`,
      )
      mkdirSync(duplicateRoot, { recursive: true, mode: 0o700 })
      const journal = JSON.parse(
        readFileSync(join(sourceRoot, 'investigation-1.json'), 'utf8'),
      ) as Record<string, unknown>
      writeFileSync(join(duplicateRoot, 'investigation-1.json'), `${JSON.stringify({
        ...journal,
        inputRevision: fixture.revisionOne.revision,
        inputDigest: fixture.revisionOne.digest,
      })}\n`, { mode: 0o600 })

      const poll = await fixture.poll('investigation', 'revision-two')
      expect(poll.result.isError).toBe(true)
      expect(String(poll.payload.reason)).toContain('ledger is inconsistent')
      const repeated = await fixture.call('investigation', 'revision-two')
      expect(repeated.result.isError).toBe(true)
      expect(String(repeated.payload.reason)).toContain('ledger is inconsistent')
    } finally {
      await fixture.close()
    }
  }, 20_000)

  test('単一workflowは最終reviewもattempt全体で一度だけ実行する', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      expect((await fixture.call('investigation', 'revision-two')).payload)
        .toMatchObject({ complete: true })
      expect((await fixture.call('review', 'revision-two')).payload)
        .toMatchObject({ complete: true })
      const repeated = await fixture.call('review', 'revision-one')
      expect(repeated.result.isError).not.toBe(true)
      expect(repeated.payload).toMatchObject({
        complete: true,
        reusedPriorPhase: true,
        inputRevision: fixture.revisionTwo.revision,
      })
      const reviewJournals = readdirSync(fixture.journalRoot)
        .filter(name => name.startsWith('revision-'))
        .flatMap(name => readdirSync(join(fixture.journalRoot, name))
          .filter(entry => entry === 'review-1.json'))
      expect(reviewJournals).toHaveLength(1)
    } finally {
      await fixture.close()
    }
  }, 60_000)

  test('単一workflowは条件付きreview round 2だけを一度許可し不正roundを起動前に拒否する', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      const design = await fixture.call('design', 'revision-two')
      expect(design.result.isError).toBe(true)
      expect(String(design.payload.rawError)).toContain('Invalid option')
      const investigationTwo = await fixture.call('investigation', 'revision-two', 'adopted', 2)
      expect(investigationTwo.result.isError).toBe(true)
      const reviewThree = await fixture.call('review', 'revision-two', 'adopted', 3)
      expect(reviewThree.result.isError).toBe(true)

      const roundTwoBeforeRoundOne = await fixture.call('review', 'revision-two', 'adopted', 2, {
        nativeAgentId: '/root/native-risk-r2',
        roundTwoBasis: {
          roundOneSources: ['native'],
          mandatoryFindingSummary: '主要導線で再現する不具合',
          taskOwnedFixDelta: '対象処理と回帰テストを修正',
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
        },
      })
      expect(roundTwoBeforeRoundOne.result.isError).toBe(true)
      expect(String(roundTwoBeforeRoundOne.payload.reason)).toContain('round 1')

      expect((await fixture.call('investigation', 'revision-two')).payload)
        .toMatchObject({ complete: true })
      expect((await fixture.call('review', 'revision-two')).payload)
        .toMatchObject({ complete: true })
      const missingBasis = await fixture.call('review', 'revision-two', 'adopted', 2, {
        nativeAgentId: '/root/native-risk-r2',
      })
      expect(missingBasis.result.isError).toBe(true)
      expect(String(missingBasis.payload.reason)).toContain('requires')
      const whitespaceBasis = await fixture.call('review', 'revision-two', 'adopted', 2, {
        nativeAgentId: '/root/native-risk-r2',
        roundTwoBasis: {
          roundOneSources: ['native'],
          mandatoryFindingSummary: ' \n\t',
          taskOwnedFixDelta: ' \n\t',
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
        },
      })
      expect(whitespaceBasis.result.isError).toBe(true)
      const descriptionOnlyDelta = await fixture.call(
        'review', 'revision-two', 'adopted', 2,
        {
          nativeAgentId: '/root/native-risk-r2-no-delta',
          roundTwoBasis: {
            roundOneSources: ['native'],
            mandatoryFindingSummary: '主要導線で再現する不具合',
            taskOwnedFixDelta: '実際にはrepositoryを変更していない説明文だけの修正',
            taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
          },
        },
      )
      expect(descriptionOnlyDelta.result.isError).toBe(true)
      expect(String(descriptionOnlyDelta.payload.reason)).toContain('host-observed non-empty')
      writeFileSync(
        join(fixture.repo, 'round-two-fix.ts'),
        'export const reviewedFix = true\n',
      )
      const wrongOwnedPath = await fixture.call('review', 'revision-two', 'adopted', 2, {
        nativeAgentId: '/root/native-risk-r2-wrong-path',
        roundTwoBasis: {
          roundOneSources: ['native'],
          mandatoryFindingSummary: '主要導線で再現する不具合',
          taskOwnedFixDelta: '対象処理と回帰テストを修正',
          taskOwnedFixPaths: [{ repository: '.', path: 'another-task.ts' }],
        },
      })
      expect(wrongOwnedPath.result.isError).toBe(true)
      expect(String(wrongOwnedPath.payload.reason)).toContain('do not exactly match')
      writeFileSync(join(fixture.repo, 'another-task.ts'), 'export const foreign = true\n')
      const omittedForeignPath = await fixture.call('review', 'revision-two', 'adopted', 2, {
        nativeAgentId: '/root/native-risk-r2-omitted-path',
        roundTwoBasis: {
          roundOneSources: ['native'],
          mandatoryFindingSummary: '主要導線で再現する不具合',
          taskOwnedFixDelta: '対象処理と回帰テストを修正',
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
        },
      })
      expect(omittedForeignPath.result.isError).toBe(true)
      expect(String(omittedForeignPath.payload.reason)).toContain('do not exactly match')
      rmSync(join(fixture.repo, 'another-task.ts'))
      const reusedNative = await fixture.call('review', 'revision-two', 'adopted', 2, {
        roundTwoBasis: {
          roundOneSources: ['native'],
          mandatoryFindingSummary: '主要導線で再現する不具合',
          taskOwnedFixDelta: '対象処理と回帰テストを修正',
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
        },
      })
      expect(reusedNative.result.isError).toBe(true)
      expect(String(reusedNative.payload.reason)).toContain('fresh native advisor')
      const roundTwo = await fixture.call('review', 'revision-two', 'adopted', 2, {
        nativeAgentId: '/root/native-risk-r2',
        roundTwoBasis: {
          roundOneSources: ['native'],
          mandatoryFindingSummary: '主要導線で再現する不具合',
          taskOwnedFixDelta: '対象処理と回帰テストを修正',
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
        },
      })
      expect(roundTwo.payload).toMatchObject({ complete: true, round: 2 })
      const repeated = await fixture.call('review', 'revision-one', 'adopted', 2, {
        nativeAgentId: '/root/native-risk-r2-second',
        roundTwoBasis: {
          roundOneSources: ['native'],
          mandatoryFindingSummary: '同じ必須指摘',
          taskOwnedFixDelta: '同じ修正差分',
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
        },
      })
      expect(repeated.payload).toMatchObject({ complete: true, reusedPriorPhase: true, round: 2 })
    } finally {
      await fixture.close()
    }
  }, 60_000)

  test('必須修正後の新しいinput revisionでreview round 2を一度だけ実行する', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      expect((await fixture.call('investigation', 'revision-two')).payload)
        .toMatchObject({ complete: true })
      expect((await fixture.call('review', 'revision-two')).payload)
        .toMatchObject({ complete: true, round: 1 })

      writeFileSync(
        join(fixture.repo, 'round-two-fix.ts'),
        'export const reviewedFix = true\n',
      )
      const fixedInput = fixture.stageRevision('最終reviewの必須指摘を修正した')
      expect(fixedInput.revision).toBeGreaterThan(fixture.revisionTwo.revision)
      const roundTwo = await fixture.call('review', fixedInput, 'adopted', 2, {
        nativeAgentId: '/root/native-risk-after-fix',
        roundTwoBasis: {
          roundOneSources: ['native'],
          mandatoryFindingSummary: '主要導線で再現する不具合',
          taskOwnedFixDelta: '対象処理と直接回帰テストを修正',
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
        },
      })
      expect(roundTwo.payload).toMatchObject({
        complete: true,
        round: 2,
        inputRevision: fixedInput.revision,
        inputDigest: fixedInput.digest,
      })

      const repeated = await fixture.call('review', fixedInput, 'adopted', 2, {
        nativeAgentId: '/root/native-risk-after-fix-second',
        roundTwoBasis: {
          roundOneSources: ['native'],
          mandatoryFindingSummary: '同じ必須指摘',
          taskOwnedFixDelta: '同じ修正差分',
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
        },
      })
      expect(repeated.payload).toMatchObject({
        complete: true,
        alreadyObserved: true,
        round: 2,
        inputRevision: fixedInput.revision,
      })

      const reviewJournals = readdirSync(fixture.journalRoot)
        .filter(name => name.startsWith('revision-'))
        .flatMap(name => readdirSync(join(fixture.journalRoot, name))
          .filter(entry => entry === 'review-1.json' || entry === 'review-2.json'))
      expect(reviewJournals.sort()).toEqual(['review-1.json', 'review-2.json'])
    } finally {
      await fixture.close()
    }
  }, 60_000)

  test('review round 1後のHEAD移動はdirty path申告だけでtask-owned fixにしない', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      expect((await fixture.call('investigation', 'revision-two')).payload)
        .toMatchObject({ complete: true, round: 1 })
      expect((await fixture.call('review', 'revision-two')).payload)
        .toMatchObject({ complete: true, round: 1 })
      writeFileSync(join(fixture.repo, 'round-two-fix.ts'), 'committed\n')
      git(['add', 'round-two-fix.ts'], fixture.repo)
      git(['commit', '-qm', 'concurrent commit'], fixture.repo)
      writeFileSync(join(fixture.repo, 'round-two-fix.ts'), 'dirty after commit\n')
      const roundTwo = await fixture.call('review', 'revision-two', 'adopted', 2, {
        nativeAgentId: '/root/native-risk-r2-after-head-move',
        roundTwoBasis: {
          roundOneSources: ['native'],
          mandatoryFindingSummary: '主要導線で再現する不具合',
          taskOwnedFixDelta: '対象処理を修正',
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
        },
      })
      expect(roundTwo.result.isError).toBe(true)
      expect(String(roundTwo.payload.reason)).toContain('complete path-level')
    } finally {
      await fixture.close()
    }
  }, 60_000)

  test('current-policy review第2回をlegacy review第1回へ結合しない', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      expect((await fixture.call('investigation', 'revision-two')).payload)
        .toMatchObject({ complete: true })
      expect((await fixture.call('review', 'revision-two')).payload)
        .toMatchObject({ complete: true })
      const revisionRoot = join(
        fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`,
      )
      const path = join(revisionRoot, 'review-1.json')
      const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      writeFileSync(path, `${JSON.stringify({
        ...current,
        version: 8,
        advisorPolicy: undefined,
        native: (['solution', 'risk'] as const).map((perspective, index) => ({
          attempted: true, adopted: false, perspective,
          reasonDigest: String(index + 1).repeat(64),
          executionState: 'unavailable-before-start',
        })),
        grok: (['solution', 'risk'] as const).map((perspective, index) => ({
          attempted: true, adopted: false, perspective, containmentVerified: true,
          reasonDigest: String(index + 3).repeat(64),
          executionState: 'unavailable-before-start',
        })),
      })}\n`, { mode: 0o600 })

      const roundTwo = await fixture.call('review', 'revision-two', 'adopted', 2, {
        nativeAgentId: '/root/native-risk-r2',
        roundTwoBasis: {
          roundOneSources: ['native'],
          mandatoryFindingSummary: '主要導線で再現する不具合',
          taskOwnedFixDelta: '対象処理と回帰テストを修正',
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
        },
      })
      expect(roundTwo.result.isError).toBe(true)
      expect(String(roundTwo.payload.reason)).toContain('round 1')
    } finally {
      await fixture.close()
    }
  }, 25_000)

  test('中断回収はshapeだけのreview第2回を先行reviewなしでterminal化しない', async () => {
    const fixture = await brokerFixture({ writeEnabled: true })
    try {
      const input = fixture.revisionTwo
      const revisionRoot = join(
        fixture.journalRoot,
        `revision-${input.revision}-${input.digest.slice(0, 16)}`,
      )
      mkdirSync(revisionRoot, { recursive: true, mode: 0o700 })
      const repositoryDigest = advisorRepositoryDigest(
        snapshotAdvisorRepository(resolveAdvisorProjectLayout(fixture.repo)),
      )
      const startedAt = Date.now()
      const common = {
        version: 9,
        advisorPolicy: 'three-phase-specific-conditional-final-v2',
        status: 'requested',
        jobId: fixture.jobId,
        attemptNonce: fixture.nonce,
        contextDigest: fixture.contextDigest,
        processNonce: fixture.nonce,
        phase: 'review',
        round: 2,
        inputRevision: input.revision,
        inputDigest: input.digest,
        repositoryDigest,
        repositoryDigestBefore: repositoryDigest,
        repositoryDeltaCurrentDigest: '8'.repeat(64),
        brokerProcessId: 4242,
        primaryEvidenceDigest: '5'.repeat(64),
        native: [{
          perspective: 'risk', attempted: true, adopted: true,
          agentId: '/root/native-risk-r2', responseDigest: '1'.repeat(64),
          responseTransportDigest: '2'.repeat(64), executionState: 'response-obtained',
        }],
        roundTwoBasis: {
          reviewOneJournalDigest: '3'.repeat(64),
          mandatoryFindingDigest: '4'.repeat(64),
          repositoryBaselineDigest: '7'.repeat(64),
          repositoryCurrentDigest: '8'.repeat(64),
          changedRepositoryCount: 1,
          taskOwnedFixDeltaDigest: threeAdvisorRepositoryDeltaDigest(
            '7'.repeat(64), '8'.repeat(64), 1,
          ),
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
          taskOwnedFixPathCount: 1,
          taskOwnedFixPathsDigest: threeAdvisorTaskOwnedFixPathsDigest([
            { repository: '.', path: 'round-two-fix.ts' },
          ]),
          roundOneSources: ['native'],
          roundOneResponseDigests: { native: '6'.repeat(64) },
        },
        startedAt,
      }
      writeFileSync(join(revisionRoot, 'review-2.json'), `${JSON.stringify(common)}\n`, {
        mode: 0o600,
      })
      writeFileSync(join(fixture.journalRoot, 'active-round.lock'), `${JSON.stringify({
        version: 2,
        jobId: fixture.jobId,
        attemptNonce: fixture.nonce,
        contextDigest: fixture.contextDigest,
        processNonce: fixture.nonce,
        phase: 'review',
        round: 2,
        inputRevision: input.revision,
        inputDigest: input.digest,
        brokerProcessId: 4242,
        startedAt,
      })}\n`, { mode: 0o600 })

      expect(() => recordAdvisorExecutorRetirement({
        stateDir: fixture.state,
        jobId: fixture.jobId,
        attemptNonce: fixture.nonce,
        contextDigest: fixture.contextDigest,
        fingerprint: fixture.fingerprint,
        supervisor: {
          pid: 9876, pgid: 9876, started: 'fixture-generation',
          bootSession: 'fixture-boot', startSec: 1, startUsec: 0,
        },
      })).toThrow('not bound to one completed current-policy round 1')
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('active round中のstale入力は二重journal化せずuncertainで閉じる', async () => {
    const fixture = await brokerFixture()
    try {
      writeFileSync(join(fixture.journalRoot, 'active-round.lock'), 'occupied\n', { mode: 0o600 })
      const { result, payload } = await fixture.call()
      expect(result.isError).toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        uncertain: true,
        reason: 'another advisor round is already active for this attempt',
      })
      expect(readdirSync(fixture.journalRoot)).toEqual(['active-round.lock'])
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('verified executor retirement後はrequested roundをterminal化して新broker memoryなしでpollできる', async () => {
    const fixture = await brokerFixture()
    try {
      const input = fixture.revisionTwo
      const revisionRoot = join(
        fixture.journalRoot,
        `revision-${input.revision}-${input.digest.slice(0, 16)}`,
      )
      mkdirSync(revisionRoot, { recursive: true, mode: 0o700 })
      const repositoryDigest = advisorRepositoryDigest(
        snapshotAdvisorRepository(resolveAdvisorProjectLayout(fixture.repo)),
      )
      const startedAt = Date.now() - 10
      const brokerProcessId = 4242
      const native = [
        {
          perspective: 'solution', attempted: true, adopted: true,
          agentId: '/root/native-solution', responseDigest: '1'.repeat(64),
          responseTransportDigest: '2'.repeat(64),
        },
        {
          perspective: 'risk', attempted: true, adopted: true,
          agentId: '/root/native-risk', responseDigest: '3'.repeat(64),
          responseTransportDigest: '4'.repeat(64),
        },
      ]
      writeFileSync(join(revisionRoot, 'investigation-1.json'), `${JSON.stringify({
        version: 8,
        status: 'requested',
        jobId: fixture.jobId,
        phase: 'investigation',
        round: 1,
        attemptNonce: fixture.nonce,
        contextDigest: fixture.contextDigest,
        processNonce: fixture.nonce,
        inputRevision: input.revision,
        inputDigest: input.digest,
        repositoryDigest,
        repositoryDigestBefore: repositoryDigest,
        repositoryObservation: 'not-required-in-unified-workflow',
        brokerProcessId,
        primaryEvidenceDigest: '5'.repeat(64),
        native,
        startedAt,
      })}\n`, { mode: 0o600 })
      writeFileSync(join(fixture.journalRoot, 'active-round.lock'), `${JSON.stringify({
        version: 2,
        jobId: fixture.jobId,
        attemptNonce: fixture.nonce,
        contextDigest: fixture.contextDigest,
        processNonce: fixture.nonce,
        phase: 'investigation',
        round: 1,
        inputRevision: input.revision,
        inputDigest: input.digest,
        brokerProcessId,
        startedAt,
      })}\n`, { mode: 0o600 })
      persistAdvisorClaudeCleanupOutcome(fixture.state, {
        jobId: fixture.jobId,
        attemptNonce: fixture.nonce,
        inputRevision: input.revision,
        inputDigest: input.digest,
        inputDigestPrefix: input.digest.slice(0, 16),
        phase: 'investigation',
        round: 1,
        workspaceCreationAttempted: false,
        freshEphemeral: false,
        cleanupVerified: false,
        promptMayHaveBeenDelivered: false,
      })
      expect(recordAdvisorExecutorRetirement({
        stateDir: fixture.state,
        jobId: fixture.jobId,
        attemptNonce: fixture.nonce,
        contextDigest: fixture.contextDigest,
        fingerprint: fixture.fingerprint,
        supervisor: {
          pid: 9876,
          pgid: 9876,
          started: 'fixture-generation',
          bootSession: 'fixture-boot',
          startSec: 1,
          startUsec: 0,
        },
      })).toMatchObject({ recorded: true, processNonce: fixture.nonce })
      expect(finalizeRetiredAdvisorRounds(fixture.state)).toEqual({ finalized: 1 })
      expect(existsSync(join(fixture.journalRoot, 'active-round.lock'))).toBe(false)
      let journal = JSON.parse(
        readFileSync(join(revisionRoot, 'investigation-1.json'), 'utf8'),
      ) as Record<string, unknown>
      expect(journal).toMatchObject({
        status: 'required-reviewer-failed',
        recoveredAfterInterruption: true,
        inputUnchanged: true,
      })
      expect((journal.grok as Array<Record<string, unknown>>).every(value => (
        value.adopted === false && value.containmentVerified === true
        && value.executionState === 'start-unconfirmed'
      ))).toBe(true)
      expect(journal.claude).toMatchObject({
        adopted: false,
        executionState: 'unavailable-before-start',
        workspaceCreationAttempted: false,
        containmentVerified: true,
      })

      const { result, payload } = await fixture.call('investigation', 'revision-two')
      expect(result.isError).not.toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        recoveredAfterInterruption: true,
        slotSummary: {
          total: 5,
          started: 2,
          responsesObtained: 2,
          startUnconfirmed: 2,
          unavailableBeforeStart: 1,
        },
      })
      journal = JSON.parse(
        readFileSync(join(revisionRoot, 'investigation-1.json'), 'utf8'),
      ) as Record<string, unknown>
      expect(journal.status).toBe('required-reviewer-failed')
      expect(journal.receiptAcknowledgement).toBeUndefined()
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('初回中断で回答cacheがなくても終了確認後に外部枠を再取得できる', async () => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const nativeResponse = `solution response\n${nativeAdvisorMarker(fixture.nonce,
        fixture.revisionTwo.revision, fixture.revisionTwo.digest, 'investigation', 1, 'solution')}`
      const armed = armRetiredRequestedRound(fixture, fixture.revisionTwo, { version: 9, nativeResponse })
      fixture.stageRevision('接続を復旧しました。元の依頼内容は変更せず再開してください。')
      expect(finalizeRetiredAdvisorRounds(fixture.state)).toEqual({ finalized: 1 })
      expect(existsSync(`${armed.journalPath}.responses`)).toBe(false)
      const early = await fixture.call('investigation', 'revision-two', 'adopted', 1,
        { retryUnavailable: true, inputUpdateIsRecoveryOnly: true })
      expect(early.payload).toMatchObject({ complete: false, retryable: true })
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
      journal.startedAt -= 31_000
      journal.finishedAt -= 31_000
      const raw = JSON.stringify(journal)
      writeFileSync(armed.journalPath, raw, { mode: 0o600 })
      const receiptPath = join(fixture.state, 'advisor-retirement', fixture.jobId, fixture.nonce, `${fixture.nonce}.json`)
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      receipt.terminalJournalDigest = createHash('sha256').update(raw).digest('hex')
      writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
      const retry = await fixture.call('investigation', 'revision-two', 'adopted', 1, { retryUnavailable: true, inputUpdateIsRecoveryOnly: true })
      expect(retry.payload).toMatchObject({ complete: true, slotSummary: { responsesObtained: 3 } })
    } finally { await fixture.close() }
  }, 20_000)

  test('version 9 requested roundの中断復旧はphase別Grok 1枠とtotal 3を維持する', async () => {
    const fixture = await brokerFixture()
    try {
      const armed = armRetiredRequestedRound(
        fixture,
        fixture.revisionTwo,
        { version: 9 },
      )
      expect(finalizeRetiredAdvisorRounds(fixture.state)).toEqual({ finalized: 1 })
      expect(existsSync(armed.lockPath)).toBe(false)
      let journal = JSON.parse(readFileSync(armed.journalPath, 'utf8')) as Record<string, unknown>
      expect(journal).toMatchObject({
        version: 9,
        advisorPolicy: 'three-phase-specific-conditional-final-v2',
        status: 'required-reviewer-failed',
        recoveredAfterInterruption: true,
      })
      expect((journal.native as Array<Record<string, unknown>>).map(value => value.perspective))
        .toEqual(['solution'])
      expect((journal.grok as Array<Record<string, unknown>>).map(value => value.perspective))
        .toEqual(['solution'])

      const { result, payload } = await fixture.call('investigation', 'revision-two')
      expect(result.isError).not.toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        recoveredAfterInterruption: true,
        slotSummary: {
          total: 3,
          started: 1,
          responsesObtained: 1,
          startUnconfirmed: 1,
          unavailableBeforeStart: 1,
        },
      })
      journal = JSON.parse(readFileSync(armed.journalPath, 'utf8')) as Record<string, unknown>
      expect(journal.status).toBe('required-reviewer-failed')
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('version 9 review中断復旧はriskのGrok 1枠だけを記録する', async () => {
    const fixture = await brokerFixture({ writeEnabled: true })
    try {
      const armed = armRetiredRequestedRound(
        fixture,
        fixture.revisionTwo,
        { version: 9, phase: 'review' },
      )
      expect(finalizeRetiredAdvisorRounds(fixture.state)).toEqual({ finalized: 1 })
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8')) as Record<string, unknown>
      expect(journal).toMatchObject({
        version: 9,
        advisorPolicy: 'three-phase-specific-conditional-final-v2',
        phase: 'review',
        status: 'required-reviewer-failed',
      })
      expect((journal.native as Array<Record<string, unknown>>).map(value => value.perspective))
        .toEqual(['risk'])
      expect((journal.grok as Array<Record<string, unknown>>).map(value => value.perspective))
        .toEqual(['risk'])
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('retired stale roundの入力更新後も同じphaseを再起動せず再利用する', async () => {
    const fixture = await brokerFixture()
    try {
      const armed = armRetiredRequestedRound(fixture, fixture.revisionOne)
      expect(finalizeRetiredAdvisorRounds(fixture.state)).toEqual({ finalized: 1 })
      expect(existsSync(armed.lockPath)).toBe(false)
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8')) as Record<string, unknown>
      expect(journal).toMatchObject({
        status: 'stale-input',
        recoveredAfterInterruption: true,
        inputUnchanged: false,
      })

      writeFileSync(join(fixture.repo, 'README.md'), 'changed after stale recovery\n', { mode: 0o600 })
      const { result, payload } = await fixture.call('investigation', 'revision-two')
      expect(result.isError).not.toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        reusedPriorPhase: true,
        priorStatus: 'stale-input',
        inputRevision: fixture.revisionOne.revision,
      })
      expect(payload.repositoryUnchanged).toBeUndefined()
      expect(existsSync(armed.lockPath)).toBe(false)
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('retirement receipt後にactive lockのinodeが置換されたら削除せずfail closedにする', async () => {
    const fixture = await brokerFixture()
    try {
      const armed = armRetiredRequestedRound(fixture, fixture.revisionTwo)
      const content = readFileSync(armed.lockPath, 'utf8')
      rmSync(armed.lockPath)
      writeFileSync(armed.lockPath, content, { mode: 0o600 })
      expect(() => finalizeRetiredAdvisorRounds(fixture.state)).toThrow(
        'advisor active claim changed before recovered release',
      )
      expect(existsSync(armed.lockPath)).toBe(true)
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8')) as Record<string, unknown>
      expect(journal).toMatchObject({
        status: 'required-reviewer-failed',
        recoveredAfterInterruption: true,
      })
      const { payload } = await fixture.call('investigation', 'revision-two')
      expect(payload).toMatchObject({
        complete: false,
        reusedPriorPhase: true,
        priorStatus: 'required-reviewer-failed',
      })
      expect(existsSync(armed.lockPath)).toBe(true)
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('Claude request未回収は既定で保留しcontinuation modeでは明示残存としてterminal化する', async () => {
    const fixture = await brokerFixture()
    try {
      const armed = armRetiredRequestedRound(
        fixture, fixture.revisionTwo, { persistClaudeOutcome: false },
      )
      const requestDir = join(
        fixture.state, 'advisor-ephemeral', fixture.jobId, fixture.nonce,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`,
        'investigation-1',
      )
      mkdirSync(requestDir, { recursive: true, mode: 0o700 })
      expect(() => finalizeRetiredAdvisorRounds(fixture.state)).toThrow(
        'retired advisor Claude workspace cleanup is still pending',
      )
      expect(existsSync(requestDir)).toBe(true)
      expect(existsSync(armed.lockPath)).toBe(true)
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8')) as Record<string, unknown>
      expect(journal.status).toBe('requested')
      expect(finalizeRetiredAdvisorRounds(fixture.state, {
        allowUnverifiedClaudeResidual: true,
      })).toEqual({ finalized: 1 })
      expect(existsSync(requestDir)).toBe(true)
      expect(existsSync(armed.lockPath)).toBe(false)
      expect(JSON.parse(readFileSync(armed.journalPath, 'utf8'))).toMatchObject({
        status: 'required-reviewer-failed',
        claude: {
          adopted: false,
          executionState: 'start-unconfirmed',
          workspaceCreationAttempted: true,
          cleanupVerified: false,
          cleanupStatus: 'unverified-after-retirement',
          containmentVerified: false,
        },
      })
      const recovered = await fixture.call('investigation', 'revision-two')
      expect(recovered.result.isError).not.toBe(true)
      expect(recovered.payload).toMatchObject({
        complete: false,
        recoveredAfterInterruption: true,
        slotSummary: {
          total: 5,
          started: 2,
          responsesObtained: 2,
          startUnconfirmed: 3,
        },
      })
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('送達receiptだけのcapacity中断はClaudeのmodel起動を推測しない', async () => {
    const fixture = await brokerFixture()
    try {
      const armed = armRetiredRequestedRound(
        fixture, fixture.revisionTwo, { persistClaudeOutcome: false },
      )
      const requestDir = join(
        fixture.state, 'advisor-ephemeral', fixture.jobId, fixture.nonce,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`,
        'investigation-1',
      )
      mkdirSync(requestDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(requestDir, 'ephemeral-send-receipt.json'), '{}\n', { mode: 0o600 })
      expect(finalizeRetiredAdvisorRounds(fixture.state, {
        allowUnverifiedClaudeResidual: true,
      })).toEqual({ finalized: 1 })
      expect(existsSync(armed.lockPath)).toBe(false)
      const recovered = await fixture.call('investigation', 'revision-two')
      expect(recovered.result.isError).not.toBe(true)
      expect(recovered.payload).toMatchObject({
        complete: false,
        recoveredAfterInterruption: true,
        slotSummary: {
          total: 5,
          started: 2,
          responsesObtained: 2,
          startUnconfirmed: 3,
        },
      })
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('Claudeは末尾が完全一致の空promptだけreadyと判定する', () => {
    expect(emptyClaudePrompt('previous output\n❯\n')).toBe(true)
    expect(emptyClaudePrompt('previous output\n❯ typed draft\n')).toBe(false)
    expect(emptyClaudePrompt('How is Claude doing this session?\n0: Dismiss\n❯')).toBe(false)
    expect(emptyClaudePrompt('Allow this action\n❯')).toBe(false)
  })

  test('Herdr agent readのJSON envelopeをpane本文へ展開する', () => {
    const content = 'previous output\n❯\n⏵⏵ bypass permissions on'
    expect(decodeHerdrReadOutput(JSON.stringify({ result: { content } }))).toBe(content)
    expect(emptyClaudePrompt(decodeHerdrReadOutput(JSON.stringify({
      result: { content },
    })))).toBe(true)
  })

  test('Claude回答はprompt echoと最終独立markerの完全envelopeだけを採択する', () => {
    const marker = 'REQUEST_MARKER=0123456789ABCDEF0123456789ABCDEF'
    expect(extractCompleteClaudeResponse([
      '依頼本文',
      '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      marker,
      '独立したレビュー結果です。',
      '二行目です。',
      marker,
      '❯',
      '⏵⏵ bypass permissions on',
    ].join('\n'), marker)).toBe('独立したレビュー結果です。\n二行目です。')

    expect(extractCompleteClaudeResponse([
      '依頼本文',
      '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      marker,
      `本文中に ${marker} を含めます。`,
      marker,
      '❯',
    ].join('\n'), marker)).toBeNull()

    expect(extractCompleteClaudeResponse([
      '依頼本文',
      '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      marker,
      '途中回答です。',
      marker,
      'marker後にも回答を続けます。',
    ].join('\n'), marker)).toBeNull()

    expect(extractCompleteClaudeResponse([
      '依頼本文',
      '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      marker,
      '最終markerがありません。',
    ].join('\n'), marker)).toBeNull()

    expect(extractCompleteClaudeResponse([
      '依頼本文',
      marker,
      '回答内だけにmarkerが二つあります。',
      marker,
      '❯',
    ].join('\n'), marker)).toBeNull()

    for (const continuation of ['· continuation', '✻ continuation']) {
      expect(extractCompleteClaudeResponse([
        '依頼本文',
        '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
        marker,
        '回答です。',
        marker,
        continuation,
      ].join('\n'), marker)).toBeNull()
    }
  })

  test('Claude 2.1.246以降の固定bypass footerだけを既知chromeとして採択する', () => {
    const marker = 'REQUEST_MARKER=0123456789ABCDEF0123456789ABCDEF'
    const instruction = '応答の最後の独立行に、次のrequest markerをそのまま記載してください。'
    const response = '独立したレビュー結果です。'
    const envelope = (...footer: string[]) => [
      '依頼本文',
      instruction,
      marker,
      response,
      marker,
      '❯',
      ...footer,
    ].join('\n')

    for (const footer of [
      '⏵⏵ bypass permissions on',
      '⏵⏵ bypass permissions on · /rc',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · /rc',
      `⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents${' '.repeat(96)}/rc`,
    ]) {
      expect(extractCompleteClaudeResponse(envelope(footer), marker)).toBe(response)
    }

    for (const footer of [
      '⏵⏵ bypass permissions on (shift+tab to toggle) · /rc',
      '⏵⏵ bypass permissions on (shift＋tab to cycle) · /rc',
      '⏵⏵ bypass permissions on (shift+tab to cycle · /rc',
      '⏵⏵ bypass permissions on [shift+tab to cycle] · /rc',
      '⏵⏵ bypass permissions on (shift+tab to cycle) /rc',
      '⏵⏵ bypass permissions on (shift+tab to cycle) extra',
      '⏵⏵ bypass permissions off (shift+tab to cycle) · /rc',
      '⏵⏵ bypass permissions on · marker後にも回答を続けます。',
      'Allow this action',
      'Do you want to proceed',
      '/rc',
    ]) {
      expect(extractCompleteClaudeResponse(envelope(footer), marker)).toBeNull()
    }

    expect(extractCompleteClaudeResponse(envelope(
      '⏵⏵ bypass permissions on (shift+tab to cycle) ·',
      '/rc',
    ), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope(
      'marker後にも回答を続けます。',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · /rc',
    ), marker)).toBeNull()
  })

  test('Claude 2.1.247の狭幅固定bypass footerだけを既知chromeとして採択する', () => {
    const marker = 'REQUEST_MARKER=ABCDEF0123456789ABCDEF0123456789'
    const instruction = '応答の最後の独立行に、次のrequest markerをそのまま記載してください。'
    const response = '独立したレビュー結果です。'
    const clippedFooter = `\u23F5\u23F5 bypass permissions on (shift+tab to${'\u0020'.repeat(5)}\u00B7`
    const envelope = (...chrome: string[]) => [
      '依頼本文',
      instruction,
      marker,
      response,
      marker,
      ...chrome,
    ].join('\n')

    expect(extractCompleteClaudeResponse(envelope(
      '✻ Churned for 22s · done 14:22',
      '────────────────',
      '❯',
      '────────────────',
      `${clippedFooter}   `,
    ), marker)).toBe(response)

    for (const footer of [
      `\u23F5\u23F5 bypass permissions on (shift+tab to${'\u0020'.repeat(4)}\u00B7`,
      `\u23F5\u23F5 bypass permissions on (shift+tab to${'\u0020'.repeat(6)}\u00B7`,
      '\u23F5\u23F5 bypass permissions on (shift+tab to\t\t\u00B7',
      `\u23F5\u23F5 bypass permissions on (shift+tab to${'\u00A0'.repeat(5)}\u00B7`,
      `\u23F5\u23F5 bypass permissions on (shift+tab to${'\u0020'.repeat(5)}\u2022`,
      '\u23F5\u23F5 bypass permissions on (shift+tab to',
      `\u23F5\u23F5 bypass permissions on (shift+tab${'\u0020'.repeat(5)}\u00B7`,
      `\u23F5\u23F5 bypass permissions on (shift+tab to cycle)${'\u0020'.repeat(5)}\u00B7`,
      `${clippedFooter} /rc`,
      `${clippedFooter} marker後にも回答を続けます。`,
      `\u23F5\u23F5 bypass permissions off (shift+tab to${'\u0020'.repeat(5)}\u00B7`,
    ]) {
      expect(extractCompleteClaudeResponse(envelope(footer), marker)).toBeNull()
    }

    expect(extractCompleteClaudeResponse(envelope(
      clippedFooter,
      'marker後にも回答を続けます。',
    ), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope(
      'marker後にも回答を続けます。',
      clippedFooter,
    ), marker)).toBeNull()
  })

  test('Claude 2.1.247の更新案内付き固定footerを二行のterminal chromeとして採択する', () => {
    const marker = 'REQUEST_MARKER=FEDCBA9876543210FEDCBA9876543210'
    const response = '独立したレビュー結果です。'
    const updateFooter = `⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents${' '.repeat(24)}✔ Update installed · Restart to update`
    const envelope = (...footer: string[]) => [
      '依頼本文',
      '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      marker,
      response,
      marker,
      '✻ Crunched for 18s · done 7:18',
      '────────────────',
      '❯',
      '────────────────',
      ...footer,
    ].join('\n')

    expect(extractCompleteClaudeResponse(envelope(updateFooter, '/rc'), marker)).toBe(response)
    expect(extractCompleteClaudeResponse(envelope(updateFooter), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope(updateFooter, '/clear'), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope(
      updateFooter.replace('Restart to update', 'Click to update'),
      '/rc',
    ), marker)).toBeNull()
  })

  test('Claude 2.1.247の実測狭幅prompt echoだけを固定envelopeとして採択する', () => {
    const marker = 'REQUEST_MARKER=3CC556E85A172CDBDF0101C7C293A2F6'
    const instruction = '応答の最後の独立行に、次のrequest markerをそのまま記載してください。'
    const instructionHead = '応答の最後の独立行に、次のrequest'
    const instructionTail = 'markerをそのまま記載してください。'
    const markerHead = marker.slice(0, -1)
    const markerTail = marker.slice(-1)
    const response = '独立したレビュー結果です。\n二行目です。'
    const clippedFooter = `\u23F5\u23F5 bypass permissions on (shift+tab to${'\u0020'.repeat(5)}\u00B7`
    const chrome = [
      '✻ Baked for 25s · done 15:05',
      '────────────────',
      '❯',
      '────────────────',
      clippedFooter,
    ]
    const wrappedPrompt = [instructionHead, instructionTail, markerHead, markerTail]
    const envelope = ({
      prompt = wrappedPrompt,
      body = response.split('\n'),
      final = [marker],
      tail = chrome,
    }: {
      prompt?: string[]
      body?: string[]
      final?: string[]
      tail?: string[]
    } = {}) => ['依頼本文', ...prompt, ...body, ...final, ...tail].join('\n')

    expect(`${instructionHead} ${instructionTail}`).toBe(instruction)
    expect(markerHead.length).toBe(marker.length - 1)
    expect(markerTail.length).toBe(1)
    expect(extractCompleteClaudeResponse(envelope(), marker)).toBe(response)
    expect(extractCompleteClaudeResponse(envelope().replaceAll('\n', '\r\n'), marker))
      .toBe(response)

    for (const prompt of [
      [instructionHead, instructionTail, marker.slice(0, -2), marker.slice(-2)],
      [instructionHead, instructionTail, marker.slice(0, 20), marker.slice(20)],
      [instructionHead, instructionTail, markerHead, '', markerTail],
      [instructionHead, instructionTail, `${markerHead}X`, markerTail],
      [instructionHead, instructionTail, markerHead, `${markerTail}X`],
      [`${instructionHead}X`, instructionTail, markerHead, markerTail],
      [instructionHead, `${instructionTail}X`, markerHead, markerTail],
      [instructionTail, instructionHead, markerHead, markerTail],
    ]) {
      expect(extractCompleteClaudeResponse(envelope({ prompt }), marker)).toBeNull()
    }

    expect(extractCompleteClaudeResponse(envelope({
      prompt: [instructionHead, instructionTail, marker],
    }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({
      prompt: [instruction, markerHead, markerTail],
    }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({
      final: [markerHead, markerTail],
    }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({ body: [] }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({
      body: [response, markerHead, markerTail],
    }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({
      body: [`本文中に ${marker} を含めます。`],
    }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({
      prompt: [...wrappedPrompt, ...wrappedPrompt],
    }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({ tail: ['marker後にも回答を続けます。'] }), marker))
      .toBeNull()
    expect(extractCompleteClaudeResponse([
      '依頼本文', instruction, marker, response, markerHead, markerTail, marker, ...chrome,
    ].join('\n'), marker)).toBeNull()

    const nonProductionMarker = 'NOT_A_PRODUCTION_MARKER'
    expect(extractCompleteClaudeResponse([
      '依頼本文',
      instructionHead,
      instructionTail,
      nonProductionMarker.slice(0, -1),
      nonProductionMarker.slice(-1),
      response,
      nonProductionMarker,
      ...chrome,
    ].join('\n'), nonProductionMarker)).toBeNull()
  })

  test('Claude 2.1.247の固定done clockだけをactivity chromeとして採択する', () => {
    const marker = 'REQUEST_MARKER=FEDCBA9876543210FEDCBA9876543210'
    const instruction = '応答の最後の独立行に、次のrequest markerをそのまま記載してください。'
    const response = '独立したレビュー結果です。'
    const envelope = (...chrome: string[]) => [
      '依頼本文',
      instruction,
      marker,
      response,
      marker,
      ...chrome,
      '────────────────',
      '❯',
      '────────────────',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · /rc',
    ].join('\n')

    for (const activity of [
      '✻ Churned for 23s',
      '✻ Churned for 23s · done 12:26',
      '✻ Worked for 1m 5s · done 09:05',
      '✻ Worked for 3m 0s · done 12:40',
      '✻ Worked for 1h 2m 3s · done 9:05',
      '✻ Worked for 1h 0m 0s · done 12:40',
      '✻ Baked for 1d 0h 0m · done 13:27',
      '✻ Brewed for 1s · done 13:27',
      '✻ Cogitated for 1s · done 13:27',
      '✻ Cooked for 1s · done 13:27',
      '✻ Crunched for 1s · done 13:27',
      '✻ Sautéed for 5m 45s · done 13:27',
      '✳ Worked for 1s · done 0:00',
      '✢ Worked for 1s · done 23:59',
    ]) {
      expect(extractCompleteClaudeResponse(envelope(activity), marker)).toBe(response)
    }

    for (const activity of [
      '✻ Churned for 23s · esc to interrupt',
      '✻ Churned for 23s · done',
      '✻ Churned for 23s · Done 12:26',
      '✻ Churned for 23s · done 24:00',
      '✻ Churned for 23s · done 12:60',
      '✻ Churned for 23s · done 12:6',
      '✻ Churned for 23s · done 12:26:00',
      '✻ Churned for 23s · done 12:26 PM',
      '✻ Churned for 23s · done 12:26 extra',
      '✻ Churned for 0s · done 12:26',
      '✻ Worked for 0m 5s · done 12:26',
      '✻ Worked for 1m 00s · done 12:26',
      '✻ Worked for 3m 60s · done 12:26',
      '✻ Worked for 1h 60m 0s · done 12:26',
      '✻ Worked for 1h 00m 0s · done 12:26',
      '✻ Worked for 60s · done 12:26',
      '✻ Worked for 60m 0s · done 12:26',
      '✻ Worked for 1h 5s · done 12:26',
      '✻ Worked for 24h 0m 0s · done 12:26',
      '✻ Worked for 1d 24h 0m · done 12:26',
      '✻ Worked for 1d 0h 60m · done 12:26',
      '✻ Worked for 1d 0h 0m 0s · done 12:26',
      '✻ continuation for 1s · done 12:26',
      '✻ Wait for 5s · done 12:26',
      '✻ Churning for 23s · done 12:26',
      '✻ Braised for 1s · done 12:26',
      '✻ continuation for 1s',
      '✻ Wait for 5s',
      '✻ Churning for 23s',
      '✻ Worked for 1s',
      '✳ Churned for 23s',
      '✻ Churned for 24s',
      '✔ Churned for 23s · done 12:26',
      '· done 12:26',
    ]) {
      expect(extractCompleteClaudeResponse(envelope(activity), marker)).toBeNull()
    }

    expect(extractCompleteClaudeResponse(envelope(
      '✻ Churned for 23s · done 12:26',
      'marker後にも回答を続けます。',
    ), marker)).toBeNull()
  })

  test('同一roundのexclusive claimは重複作成できずidentity一致時だけ解放する', () => {
    const dir = fixtureDir()
    const path = join(dir, 'active.lock')
    const identity = createExclusivePrivateFile(path, 'first\n')
    expect(identity).not.toBeNull()
    expect(createExclusivePrivateFile(path, 'second\n')).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('first\n')
    releaseExclusivePrivateFile(path, identity!)
    expect(existsSync(path)).toBe(false)
  })

  test.skipIf(process.platform === 'win32')(
    'direct child終了後にdetached descendantがpipeを保持してもboundedに戻る',
    async () => {
      const dir = fixtureDir()
      const script = join(dir, 'pipe-holder.py')
      const pidFile = join(dir, 'child.pid')
      mkdirSync(dir, { recursive: true })
      writeFileSync(script, `import os, time
child = os.fork()
if child == 0:
    os.setsid()
    time.sleep(30)
    os._exit(0)
with open(os.environ['CHILD_PID_FILE'], 'w', encoding='utf-8') as handle:
    handle.write(str(child))
os._exit(0)
`)
      chmodSync(script, 0o700)
      const started = Date.now()
      let childIdentity: ReturnType<typeof readProcessIdentity>
      try {
        const result = await runBounded(['/usr/bin/python3', script], {
          env: { PATH: '/usr/bin:/bin', CHILD_PID_FILE: pidFile },
          timeoutMs: 500,
        })
        expect(result.timedOut).toBe(true)
        expect(Date.now() - started).toBeLessThan(5_000)
        childIdentity = readProcessIdentity(Number(readFileSync(pidFile, 'utf8')))
      } finally {
        if (existsSync(pidFile)) {
          childIdentity = readProcessIdentity(Number(readFileSync(pidFile, 'utf8')))
          if (childIdentity) signalProcessIfLive(childIdentity, 'SIGKILL')
        }
      }
    },
    8_000,
  )

  test.skipIf(process.platform === 'win32')(
    'outer timeoutでもGrok supervisorがsignalを子へ届けprocess groupとrun auth領域を回収する',
    async () => {
      const dir = fixtureDir()
      chmodSync(dir, 0o700)
      const reviewerRoot = join(dir, 'reviewer')
      const runRoot = join(reviewerRoot, 'run.fixture')
      const script = join(dir, 'signal-tree.c')
      const pidFile = join(dir, 'tree.pids')
      const termFile = join(dir, 'term.received')
      mkdirSync(runRoot, { recursive: true, mode: 0o700 })
      chmodSync(reviewerRoot, 0o700)
      chmodSync(runRoot, 0o700)
      writeFileSync(join(runRoot, 'owner.pid'), `${process.pid}\n`, { mode: 0o600 })
      const pinnedProgram = join(runRoot, 'official-grok')
      writeFileSync(script, String.raw`
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static void handled(int signum) {
  (void)signum;
  const char *path = getenv("TERM_FILE");
  if (!path) return;
  int descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (descriptor >= 0) {
    (void)write(descriptor, "received\n", 9);
    close(descriptor);
  }
}

int main(void) {
  signal(SIGTERM, handled);
  pid_t child = fork();
  if (child < 0) return 91;
  if (child == 0) for (;;) pause();
  const char *pid_path = getenv("PID_FILE");
  FILE *output = pid_path ? fopen(pid_path, "w") : NULL;
  if (!output) return 92;
  fprintf(output, "%d %d\n", getpid(), child);
  fclose(output);
  for (;;) pause();
}
`)
      const compiled = Bun.spawnSync(['/usr/bin/cc', '-Os', '-o', pinnedProgram, script], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      })
      expect(compiled.exitCode, compiled.stderr.toString()).toBe(0)
      chmodSync(pinnedProgram, 0o700)
      const runtime = join(import.meta.dir, 'grok-reviewer', 'reviewer-runtime.py')
      const started = Date.now()
      const result = await runBounded([
        '/usr/bin/python3', '-I', runtime, 'run', reviewerRoot, runRoot, '--',
        realpathSync(pinnedProgram),
      ], {
        env: {
          PATH: '/usr/bin:/bin',
          PID_FILE: pidFile,
          TERM_FILE: termFile,
        },
        timeoutMs: 1_000,
        terminationGraceMs: 5_000,
      })
      expect(result.timedOut, JSON.stringify(result)).toBe(true)
      expect(Date.now() - started).toBeLessThan(6_500)
      expect(readFileSync(termFile, 'utf8')).toBe('received\n')
      const pids = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number)
      expect(pids).toHaveLength(2)
      for (const pid of pids) expect(readProcessIdentity(pid)).toBeUndefined()
      expect(existsSync(runRoot)).toBe(false)
      expect(readdirSync(reviewerRoot).filter(name => name.startsWith('run.'))).toEqual([])
    },
    8_000,
  )
})
