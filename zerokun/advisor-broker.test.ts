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
  waitForClaudeSubscriptionLogin,
  brokerEnvironment,
  claudeSendRejectedBeforeInput,
  claudeContainmentFailureStatus,
  AdvisorContainmentError,
  AdvisorOwnedProcessStillLiveError,
  claudeStartRemainsUnconfirmed,
  CLAUDE_START_CONFIRMATION_MS,
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
  CLAUDE_OPEN_TIMEOUT_MS,
  recoverFifthAdvisorSendOutcome,
  GROK_OAUTH_TIMEOUT_MS,
  GROK_REVIEW_TIMEOUT_MS,
  MAX_ADVISOR_PROMPT_BYTES,
} from './advisor-broker.ts'
import { JobStore } from './job-runner.ts'
import { collectHostAdvisorCoverage } from './codex-executor.ts'
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
  readInterruptedAdvisorSlots,
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
  prepareNative(binding?: AdvisorInputSnapshot): Promise<Record<string, unknown>>
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
      primaryEvidence?: string
      uiProposal?: { comparison: string; beforeKind: "actual" | "synthetic" | "unavailable"; beforeImage?: string }
      retryUnavailable?: boolean
      inputUpdateIsRecoveryOnly?: boolean
      nativeAgentId?: string
      nativeResponse?: string
      reviewWorktrees?: string[]
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
  restart(): Promise<void>
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
import hashlib, json, os, signal, subprocess, sys, time, traceback
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
    return {"name": state["agent_name"], "agent": "claude", "agent_session": {"agent": "claude", "kind": "native", "source": "session", "value": None if state.get("late_native_session") and not state.get("visible_observed") else "fixture-native-session"}, "workspace_id": workspace, "pane_id": pane, "tab_id": tab, "terminal_id": terminal, "cwd": state["project"], "agent_status": state["agent_status"], "interactive_ready": True, "launch_pending": False, "state_change_seq": state["state_change_seq"]}
if args == ["pane", "current", "--current"]:
    if state.get("prompt") and state.get("connection_failures", 0) > 0:
        state["connection_failures"] -= 1
        save()
        missing("fixture_connection_unavailable")
    success({"pane": {"workspace_id": caller_workspace, "pane_id": caller_pane, "tab_id": caller_tab, "terminal_id": caller_terminal}})
if args == ["workspace", "list"]:
    values = [caller_value()]
    if state["owned"]:
        values.append(workspace_value())
    success({"workspaces": values})
if len(args) >= 2 and args[:2] == ["workspace", "create"]:
    if state.get("create_failures", 0) > 0:
        state["create_failures"] -= 1
        save()
        missing("fixture_transient_create_failure")
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
    if state.get("startup_audit_drift"):
        with open(os.path.join(state["project"], ".env.audit-fixture"), "w") as handle:
            handle.write("synthetic concurrent startup metadata")
    state["claude_args"] = args[args.index("--") + 1:]
    child = subprocess.Popen(
        [claude, *state["claude_args"]],
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
if len(args) == 7 and args[:2] == ["agent", "read"] and args[4] == "visible" and state.get("prompt") and state.get("visible_read_error"):
    print(json.dumps({"error": {"code": state["visible_read_error"], "message": "synthetic fallback read failure"}}), file=sys.stderr)
    raise SystemExit(1)
if len(args) == 7 and args[:2] == ["agent", "read"] and state.get("prompt") and state.get("failure_screen_failures", 0) > 0:
    state["failure_screen_failures"] -= 1
    if state["failure_screen_failures"] == 0:
        state["agent_status"] = "done"
        state["state_change_seq"] += 1
    save()
    print(json.dumps({"error": {"code": "timeout", "message": "synthetic observation failure"}}), file=sys.stderr)
    raise SystemExit(1)
if len(args) == 7 and args[:2] == ["agent", "read"] and args[3:6] == ["--source", "visible", "--lines"]:
    state["visible_observed"] = True
    save()
    print(state.get("blocked_screen", "Do you want to proceed?\\n❯ 1. Yes\\n  2. No") if state.get("prompt") and state.get("agent_status") == "blocked" else "❯", flush=True)
    raise SystemExit(0)
if len(args) == 7 and args[:2] == ["agent", "read"] and args[3:6] == ["--source", "recent-unwrapped", "--lines"]:
    prompt = state.get("prompt")
    state["response_reads"] = state.get("response_reads", 0) + 1
    save()
    if state.get("read_error"):
        print(json.dumps({"error": {"code": "agent_not_idle", "message": "private transport detail"}}), file=sys.stderr)
        raise SystemExit(1)
    if state.get("agent_status") == "blocked":
        print(state.get("blocked_screen", "Do you want to proceed?\\n❯ 1. Yes\\n  2. No"), flush=True)
        raise SystemExit(0)
    if state.get("change_during_read") and not state.get("read_changed"):
        state["read_changed"] = True
        state["state_change_seq"] += 1
        save()
    if not isinstance(prompt, str) or state.get("answer_missing"):
        print("❯", flush=True)
    else:
        if state.get("git_audit_failure"):
            head = os.path.join(state["project"], ".git", "HEAD")
            if os.path.isfile(head):
                os.rename(head, head + ".audit-fixture")
        if state.get("audit_drift"):
            with open(os.path.join(state["project"], ".env.audit-fixture"), "w") as handle:
                handle.write("synthetic concurrent runtime metadata")
        marker = next((line for line in reversed(prompt.splitlines()) if line.startswith("REQUEST_MARKER=")), "")
        if state.get("ui_artifacts"):
            prefix_ui = "Host-owned artifact root: "
            ui_root = json.loads(next(line[len(prefix_ui):] for line in prompt.splitlines() if line.startswith(prefix_ui)))
            state["ui_root"] = ui_root
            save()
            with open(os.path.join(ui_root, "prototype", "index.html"), "w") as handle:
                handle.write("<!doctype html><title>Fable fixture</title><h1>Synthetic design</h1>")
            ppm = os.path.join(ui_root, "runtime", "test.ppm")
            with open(ppm, "wb") as handle:
                handle.write(b"P6\\n1280 720\\n255\\n" + bytes([60, 70, 80]) * (1280 * 720))
            subprocess.run(["/usr/bin/sips", "-s", "format", "png", ppm, "--out", os.path.join(ui_root, "evidence", "after.png")], stdout=subprocess.DEVNULL, check=True)
        if state.get("answer_file_lines"):
            prefix = "The sole exception to the file-write prohibition is this caller-created file: "
            output = json.loads(next(line[len(prefix):] for line in prompt.splitlines() if line.startswith(prefix)))
            nonce = marker.split("=", 1)[1]
            body = state.get("answer_body", "\\n".join("synthetic FAQ %d" % i for i in range(1, state["answer_file_lines"] + 1)))
            raw = "CLAUDE_ANSWER_BEGIN=" + nonce + "\\n" + body + "\\nCLAUDE_ANSWER_END=" + nonce + "\\n"
            with open(output, "w", encoding="utf-8") as handle:
                handle.write(raw)
            os.chmod(output, 0o600)
            digest = hashlib.sha256(raw.encode()).hexdigest()
            if state.get("answer_file_corrupt") or state["response_reads"] <= state.get("answer_file_corrupt_reads", 0):
                with open(output, "a") as handle:
                    handle.write("partial replacement")
            if state["response_reads"] <= state.get("answer_file_receipt_delay_reads", 0):
                print("❯")
                raise SystemExit(0)
            print("CLAUDE_ANSWER_SAVED=" + nonce + " SHA256=" + digest)
            print(marker)
            print("❯")
        elif state.get("response_capture"):
            capture = state["response_capture"]
            print(capture.replace(state["capture_marker"], marker))
        else:
            print(prompt.rstrip("\\n"))
            print(state.get("answer_body", "Claude independent review completed"))
            print(marker)
            print("❯")
    raise SystemExit(0)
if args == ["pane", "process-info", "--pane", pane]:
    if not state["owned"]:
        missing("pane_not_found")
    if not state["process"]:
        success({"process_info": {"pane_id": pane, "shell_pid": 999991, "foreground_process_group_id": 999991, "foreground_processes": [{"pid": 999991, "argv0": "zsh"}]}})
    process_pid = state["process_pid"]
    process_group_id = state["process_group_id"]
    processes = [{"pid": process_pid, "argv": ["claude", *state["claude_args"]], "argv0": "claude"}] if state["process"] else []
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
    if state.get("git_audit_failure"):
        head = os.path.join(state["project"], ".git", "HEAD")
        if os.path.isfile(head + ".audit-fixture"):
            os.rename(head + ".audit-fixture", head)
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
  claudeSendError?: string
  claudeDelayedStart?: boolean
  claudeNeverStarts?: boolean
  claudeBlocked?: boolean
  claudeBlockedRecovers?: boolean
  claudeReadError?: boolean
  claudeAuthReadyFile?: string
  claudeAuthConfigurationAfterReady?: boolean
  grokDelaySeconds?: number
  onPendingResult?: (payload: Record<string, unknown>) => void
  snapshotDepthOverflow?: boolean
  developerShimCollision?: boolean
  transientProbeDenial?: boolean
  onExternalPrompt?: (count: number, repo: string) => void
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
  if (options.snapshotDepthOverflow) {
    mkdirSync(join(repo, ...Array.from({ length: 66 }, () => 'deep')), { recursive: true })
  }

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
        if (options.claudeSendError === 'agent_not_ready') {
          stateValue.prompt_count = Number(stateValue.prompt_count ?? 0) + 1
          writeFileSync(fakeHerdrState, JSON.stringify(stateValue), { mode: 0o600 })
          client.write(`${JSON.stringify({ id: request.id, error: { code: options.claudeSendError, message: 'private rejection detail' } })}\n`)
          client.end()
          return
        }
        stateValue.transport_prompt = request.params.text
        const instructionPath = request.params.text.match(/^Read and carry out my task instructions in ("[^\n]+")\. Save/)
        stateValue.prompt = instructionPath
          ? readFileSync(JSON.parse(instructionPath[1]!), 'utf8') : request.params.text
        const deliveredPrompt = stateValue.prompt
        stateValue.state_change_seq = 2
        stateValue.agent_status = 'done'
        stateValue.prompt_count = Number(stateValue.prompt_count ?? 0) + 1
        stateValue.answer_missing = Number(stateValue.prompt_count) <= (options.claudeFailures ?? 0)
        if (options.claudeBlocked) {
          stateValue.agent_status = 'blocked'
          stateValue.read_error = options.claudeReadError ?? false
          if (options.claudeBlockedRecovers) setTimeout(() => {
            const recovered = JSON.parse(readFileSync(fakeHerdrState, 'utf8'))
            if (!recovered.owned) return
            recovered.agent_status = 'done'
            recovered.state_change_seq += 1
            recovered.read_error = false
            writeFileSync(fakeHerdrState, JSON.stringify(recovered), { mode: 0o600 })
          }, 7000)
        }
        if (options.claudeDelayedStart || options.claudeNeverStarts) {
          stateValue.prompt = null
          stateValue.state_change_seq = 1
          stateValue.agent_status = 'idle'
          if (!options.claudeNeverStarts) setTimeout(() => {
            const delayed = JSON.parse(readFileSync(fakeHerdrState, 'utf8'))
            if (!delayed.owned) return
            delayed.prompt = deliveredPrompt
            delayed.state_change_seq = 2
            delayed.agent_status = 'done'
            writeFileSync(fakeHerdrState, JSON.stringify(delayed), { mode: 0o600 })
          }, 7000)
        }
        writeFileSync(fakeHerdrState, `${JSON.stringify(stateValue)}\n`, { mode: 0o600 })
        options.onExternalPrompt?.(Number(stateValue.prompt_count), repo)
        client.write(`${JSON.stringify({
          id: request.id,
          ...(options.claudeSendError
            ? { error: { code: options.claudeSendError, message: 'private transport detail' } }
            : { result: { type: 'agent_prompt', status: 'done' } }),
        })}\n`)
        client.end()
      },
    },
  })
  chmodSync(socketPath, 0o600)
  writeFileSync(claude, options.externalSuccess ? [
    '#!/bin/sh',
    'if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then',
    ...(options.claudeAuthReadyFile ? [
      "  if [ ! -f '" + options.claudeAuthReadyFile.replaceAll("'", "'\\''") + "' ]; then",
      '    printf \'%s\\n\' \'{"loggedIn":false}\'',
      '    exit 0',
      '  fi',
    ] : []),
    options.claudeAuthConfigurationAfterReady
      ? '  printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"console","apiProvider":"firstParty","subscriptionType":"max"}\''
      : '  printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\'',
    '  exit 0',
    'fi',
    'exec /bin/sleep 300',
    '',
  ].join('\n') : [
    '#!/bin/sh',
    'printf \'%s\\n\' \'Payment Required\' >&2',
    'exit 1',
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
      `  usleep(${options.grokDelaySeconds === undefined ? 300000 : Math.max(0, Math.floor(options.grokDelaySeconds)) * 1_000_000});`,
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
    ZERO_CODEX_TESTING: '1',
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
  const preload = join(root, 'developer-shim-collision.ts')
  if (options.developerShimCollision) {
    // Reproduce Bun's inode-cache collision for Apple's hardlinked shims.
    // Exercise the real broker/helper lifecycle with only path resolution faulted.
    writeFileSync(preload, `import * as fs from 'node:fs';
import { mock } from 'bun:test';
const original = fs.realpathSync;
mock.module('fs', () => ({ ...fs, realpathSync: (path, ...args) =>
  path === '/usr/bin/python3' ? '/usr/bin/git' : original(path, ...args) }));
`, { mode: 0o600 })
  }
  const createTransport = () => new StdioClientTransport({
    command: process.execPath,
    args: [
      '--config=/dev/null', '--no-env-file',
      ...(options.developerShimCollision ? ['--preload', preload] : []),
      realpathSync(join(import.meta.dir, 'advisor-broker.ts')),
      contextPath, state, runtimeDir, fingerprint.allow.path, fingerprint.deny.path,
      'complete', nonce, claudePhysical,
    ],
    cwd: repo,
    env: environment,
    stderr: 'pipe',
  })
  let transport = createTransport()
  let brokerStderr = ''
  transport.stderr?.on('data', chunk => { brokerStderr += String(chunk) })
  let client = new Client({ name: 'zerochan-advisor-broker-test', version: '1.0.0' })
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
    async prepareNative(binding = revisionTwo) {
      const result = await client.callTool({ name: 'advisor_native_prepare', arguments: {
        phase: 'investigation', round: 1, inputRevision: binding.revision,
        inputDigest: binding.digest, request: 'Independent synthetic source review.',
      } })
      const block = (result.content as Array<{ type: string; text?: string }>).find(value => value.type === 'text')
      if (!block?.text) throw new Error('native registration missing')
      return JSON.parse(block.text) as Record<string, unknown>
    },
    async restart() {
      await client.close()
      transport = createTransport()
      client = new Client({ name: 'zerochan-advisor-broker-test', version: '1.0.0' })
      await client.connect(transport)
    },
    ...(options.externalSuccess ? {
      externalEvidence: { fakeHerdrState },
    } : {}),
    async call(
      phase = 'investigation',
      binding: 'revision-one' | 'revision-two' | AdvisorInputSnapshot = 'revision-one',
      nativeMode: 'adopted' | 'unavailable' = 'adopted',
      round: 1 | 2 | 3 = 1,
      overrides: {
        primaryEvidence?: string
      uiProposal?: { comparison: string; beforeKind: "actual" | "synthetic" | "unavailable"; beforeImage?: string }
      retryUnavailable?: boolean
        inputUpdateIsRecoveryOnly?: boolean
        nativeAgentId?: string
      nativeResponse?: string
      reviewWorktrees?: string[]
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
            primaryEvidence: overrides.primaryEvidence ?? 'bounded primary evidence',
            ...(overrides.uiProposal ? { uiProposal: overrides.uiProposal } : {}),
            ...(overrides.reviewWorktrees ? { reviewWorktrees: overrides.reviewWorktrees } : {}),
            ...(overrides.retryUnavailable ? { retryUnavailable: true } : {}),
            ...(overrides.inputUpdateIsRecoveryOnly ? { inputUpdateIsRecoveryOnly: true } : {}),
            ...(overrides.roundTwoBasis ? { roundTwoBasis: overrides.roundTwoBasis } : {}),
            nativeAdvisors: nativeMode === 'adopted'
              ? [
                {
                  perspective: expectedPerspective,
                  agentId: overrides.nativeAgentId ?? `/root/native-${expectedPerspective}`,
                  response: overrides.nativeResponse ?? responseFor(expectedPerspective),
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
            inputRevision: payload.inputRevision ?? selectedInput.revision,
            inputDigest: payload.inputDigest ?? selectedInput.digest,
            ...(typeof payload.receipt === 'string' ? { receipt: payload.receipt } : {}),
          },
        })
        block = result.content.find(value => value.type === 'text')
        if (!block || block.type !== 'text') throw new Error('advisor broker omitted poll result')
        payload = JSON.parse(block.text) as Record<string, unknown>
        if (payload.pending === true) options.onPendingResult?.(payload)
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
    retainedClaude?: Record<string, unknown>
    continuation?: boolean
    continuationReviewWorktrees?: string[]
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
  const requestRaw = JSON.stringify({ phase, round: 1,
    ...(options.continuationReviewWorktrees ? { reviewWorktrees: options.continuationReviewWorktrees } : {}),
    inputRevision: input.revision, inputDigest: input.digest,
    primaryEvidence: 'bounded primary evidence',
    nativeAdvisors: [{ perspective, agentId: `/root/native-${perspective}`, response: options.nativeResponse }],
  })
  if (options.continuation) writeFileSync(`${journalPath}.request`, requestRaw, { mode: 0o600 })
  writeFileSync(journalPath, `${JSON.stringify({
    ...(options.continuation ? { continuationRequestDigest: createHash('sha256').update(requestRaw).digest('hex') } : {}),
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
    ...(options.retainedClaude ? { claude: options.retainedClaude } : {}),
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

  test('Claude実コマンドのexit 1 JSONがstructured authentication failureになる', async () => {
    const root = fixtureDir()
    const executable = join(root, 'claude')
    writeFileSync(executable, '#!/bin/sh\n/bin/sleep 0.2\nprintf \'%s\\n\' \'{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\'\nexit 1\n', { mode: 0o700 })
    await expect(assertClaudeSubscriptionLogin({ ...brokerEnvironment(), ZEROKUN_CLAUDE_BIN_PATH: executable }))
      .rejects.toMatchObject({ failure: { advisor: 'claude', cause: 'authentication' } })
  })

  test('prompt-startedのexact markerだけを送達可能として分類する', () => {
    const marker = 'REQUEST_MARKER=' + 'A'.repeat(32)
    expect(parseFifthAdvisorSendOutcome(JSON.stringify({ status: 'prompt-started', marker, state_change_seq: 42 })))
      .toEqual({ kind: 'possibly-delivered', marker, stateChangeSeq: 42, sendStatus: 'unconfirmed' })
    expect(parseFifthAdvisorSendOutcome([
      JSON.stringify({ status: 'prompt-started', marker }),
      JSON.stringify({ status: 'prompt-command-rejected' }),
    ].join('\n'))).toEqual({ kind: 'possibly-delivered', marker, sendStatus: 'unconfirmed' })
    expect(parseFifthAdvisorSendOutcome([
      JSON.stringify({ status: 'prompt-started', marker }),
      JSON.stringify({ status: 'prompt-command-timeout-or-error' }),
    ].join('\n'))).toEqual({ kind: 'possibly-delivered', marker, sendStatus: 'transport-error' })
    expect(parseFifthAdvisorSendOutcome([
      JSON.stringify({ status: 'prompt-started', marker }),
      JSON.stringify({ status: 'prompt-command-returned', returncode: 0 }),
    ].join('\n'))).toEqual({ kind: 'possibly-delivered', marker, sendStatus: 'accepted' })
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

  test('確定した送信前拒否だけを曖昧なtransport失敗から区別する', () => {
    const marker = 'REQUEST_MARKER=' + 'A'.repeat(32)
    for (const code of ['agent_not_ready', 'agent_blocked', 'empty_agent_prompt', 'timeout', 'agent_prompt_stalled', 'agent_prompt_failed', 'unknown-error']) {
      const outcome = parseFifthAdvisorSendOutcome([
        JSON.stringify({ status: 'prompt-started', marker }),
        JSON.stringify({ status: 'prompt-command-returned', returncode: 1, code }),
      ].join('\n'))
      expect(outcome).toMatchObject({ sendStatus: 'rejected', sendCode: code })
      expect(claudeSendRejectedBeforeInput(outcome)).toBe(['agent_not_ready', 'agent_blocked', 'empty_agent_prompt'].includes(code))
    }
  })

  test('開始未確認の上限は未送信の証明にせず、稼働・依頼echo・入力中を打ち切らない', () => {
    const marker = 'REQUEST_MARKER=' + 'A'.repeat(32)
    expect(claudeStartRemainsUnconfirmed(CLAUDE_START_CONFIRMATION_MS - 1, false, '❯', marker)).toBe(false)
    expect(claudeStartRemainsUnconfirmed(CLAUDE_START_CONFIRMATION_MS, false, '❯', marker)).toBe(true)
    expect(claudeStartRemainsUnconfirmed(CLAUDE_START_CONFIRMATION_MS, true, '❯', marker)).toBe(false)
    expect(claudeStartRemainsUnconfirmed(CLAUDE_START_CONFIRMATION_MS, false, `${marker}\n❯`, marker)).toBe(false)
    expect(claudeStartRemainsUnconfirmed(CLAUDE_START_CONFIRMATION_MS, false, `${marker.slice(0, -1)}\n${marker.slice(-1)}\n❯`, marker)).toBe(false)
    expect(claudeStartRemainsUnconfirmed(CLAUDE_START_CONFIRMATION_MS, false, '❯ review draft', marker)).toBe(false)
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

  test('モデル回答は時間で打ち切らず起動helperだけ有限timeoutを持つ', () => {
    expect(GROK_REVIEW_TIMEOUT_MS).toBeUndefined()
    expect(CLAUDE_HELPER_TIMEOUT_MS).toBe(140_000)
    const helper = readFileSync(join(import.meta.dir, 'fifth-advisor.py'), 'utf8')
    const seconds = (name: string) => Number(helper.match(new RegExp(`^${name} = ([0-9]+)$`, 'm'))![1])
    const startup = seconds('CLAUDE_START_PROCESS_TIMEOUT_SECONDS')
      + 2 * seconds('CLAUDE_SETTLE_TIMEOUT_SECONDS')
      + seconds('CLAUDE_PROCESS_SETTLE_TIMEOUT_SECONDS')
    expect(CLAUDE_OPEN_TIMEOUT_MS).toBeGreaterThan(startup * 1_000 + CLAUDE_HELPER_TIMEOUT_MS)
    expect(CLAUDE_OPEN_TIMEOUT_MS).toBeLessThanOrEqual(15 * 60 * 1_000)
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
    expect(observed).toMatchObject({
      complete: false,
      waitingForAdvisors: false,
      attemptsFinished: true,
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
    expect(allAdvisorAttemptsAdopted([], grok, claude)).toBe(false)
    expect(allAdvisorAttemptsAdopted([{}], grok, claude)).toBe(false)
    expect(allAdvisorAttemptsAdopted([{ adopted: true }], [], claude)).toBe(false)
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

  test('回答0件を正確に保持し試行終了後は主処理へ待機を要求しない', async () => {
    const fixture = await brokerFixture()
    try {
      const { result, payload } = await fixture.call(
        'investigation', 'revision-two', 'unavailable',
      )
      expect(result.isError).not.toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        allAdopted: false,
        roundTerminal: true,
        waitingForAdvisors: false,
        attemptsFinished: true,
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

  const replayDirectory = process.env.ZERO_CLAUDE_REPLAY_DIRECTORY
  const replayCaptures = replayDirectory
    ? readdirSync(replayDirectory).filter(name => name.startsWith('claude-response-') && name.endsWith('.json'))
      .map(name => ({ name, text: JSON.parse(readFileSync(join(replayDirectory, name), 'utf8')).transcript.text as string }))
    : [{ name: 'recorded-ui-shape', text: [
      '依頼本文', '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      'REQUEST_MARKER=0123456789ABCDEF0123456789ABCDEF',
      '⏺ 原文条件を項目別に照合し、同一回答を修復して再検品します。',
      'REQUEST_MARKER=0123456789ABCDEF0123456789ABCDEF',
      '✻ Cogitated for 2m 7s · done 6:41 AM', '────',
      '❯\u00a0本番ジョブのログで工程2と3の件数差を確認して', '────',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n') }, { name: 'live-wrapped-instruction-unwrapped-marker', text: [
      '❯ 接続テスト', '', '  応答の最後の独立行に、次のrequest',
      '  markerをそのまま記載してください。',
      '  REQUEST_MARKER=0123456789ABCDEF0123456789ABCDEF',
      '⏺ 接続確認成功',
      '  REQUEST_MARKER=0123456789ABCDEF0123456789ABCDEF',
      '✻ Baked for 2s · done 17:21', '────', '❯', '────',
    ].join('\n') }]

  test.each(replayCaptures)('保存済みClaude回答を取得・保存・完了判定・再起動後再利用まで通す $name', async capture => {
    const marker = capture.text.match(/REQUEST_MARKER=[A-F0-9]{32}/)![0]
    const expected = capture.text.split(marker)[1]!.trim()
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const statePath = fixture.externalEvidence!.fakeHerdrState
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      state.response_capture = capture.text
      state.capture_marker = marker
      writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 })
      const first = await fixture.call('investigation', 'revision-two')
      expect(first.result.isError).not.toBe(true)
      expect(first.payload).toMatchObject({ complete: true, allAdopted: true,
        claude: { adopted: true, response: expected, cleanupVerified: true },
        slotSummary: { responsesObtained: 3 } })
      const revision = `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`
      const journalPath = join(fixture.journalRoot, revision, 'investigation-1.json')
      expect(JSON.parse(readFileSync(journalPath, 'utf8')).status).toBe('completed')
      const cache = readFileSync(`${journalPath}.responses`, 'utf8')
      expect(JSON.parse(cache).claude.response).toBe(expected)
      const diagnostics = readdirSync(join(fixture.journalRoot, revision)).filter(name => name.startsWith('claude-response-'))
      expect(diagnostics).toHaveLength(1)
      const diagnostic = JSON.parse(readFileSync(join(fixture.journalRoot, revision, diagnostics[0]!), 'utf8'))
      expect(diagnostic.reads.at(-1).outcome).toBe('complete')
      await fixture.restart()
      expect((await fixture.call('investigation', 'revision-two')).payload).toMatchObject({ complete: true })
      expect(readFileSync(`${journalPath}.responses`, 'utf8')).toBe(cache)
      const finished = JSON.parse(readFileSync(statePath, 'utf8'))
      expect(finished.prompt_count).toBe(1)
      expect(finished.close_count).toBe(1)
      expect(finished.owned).toBe(false)
    } finally { await fixture.close() }
  }, 30_000)

  test.each([false, true])('Claudeの恒常blockedは画面を保存し1時間待たず一度の送信とcleanupで終える（read error=%s）', async readError => {
    const fixture = await brokerFixture({ externalSuccess: true, claudeBlocked: true, claudeReadError: readError })
    try {
      const result = await fixture.call('investigation', 'revision-two')
      expect(result.payload).toMatchObject({ allAdopted: false, claude: {
        adopted: false, promptMayHaveBeenDelivered: true, cleanupVerified: true, failure: { cause: 'response' },
      } })
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(1)
      expect(state.close_count).toBe(1)
      expect(state.owned).toBe(false)
      expect(state.response_reads).toBeGreaterThan(1)
      const directory = join(fixture.journalRoot, `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`)
      const name = readdirSync(directory).find(name => name.startsWith('claude-response-'))!
      const diagnostic = JSON.parse(readFileSync(join(directory, name), 'utf8'))
      expect(diagnostic.transcript.text).toContain('Do you want to proceed?')
      expect(diagnostic.reads.at(-1)).toMatchObject({ source: readError ? 'visible' : 'recent-unwrapped', stateBefore: { status: 'blocked' } })
      if (readError) expect(diagnostic.reads).toContainEqual(expect.objectContaining({
        outcome: 'read-failed', failure: expect.objectContaining({ stage: 'transcript', kind: 'command', exitCode: 1, code: 'agent_not_idle' }),
      }))
      expect(JSON.stringify(diagnostic)).not.toContain('private transport detail')
      expect(JSON.stringify(result.payload)).not.toContain('Do you want to proceed?')
    } finally { await fixture.close() }
  }, 50_000)

  test('一過性blockedは勝手に入力せず回復後に同じ依頼の完全回答を取得する', async () => {
    const fixture = await brokerFixture({ externalSuccess: true, claudeBlocked: true, claudeBlockedRecovers: true })
    try {
      const result = await fixture.call('investigation', 'revision-two')
      expect(result.payload).toMatchObject({ allAdopted: true, claude: { adopted: true, cleanupVerified: true } })
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(1)
      expect(state.close_count).toBe(1)
    } finally { await fixture.close() }
  }, 50_000)

  test('Claudeの明示的な送信拒否は1時間待たず原因保存とowned cleanupを行う', async () => {
    const fixture = await brokerFixture({ externalSuccess: true, claudeSendError: 'agent_not_ready' })
    try {
      const first = await fixture.call('investigation', 'revision-two')
      expect(first.payload).toMatchObject({ allAdopted: false,
        claude: { adopted: false, cleanupVerified: true, failure: { cause: 'startup' } } })
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(1)
      expect(state.owned).toBe(false)
      const revision = `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`
      const directory = join(fixture.journalRoot, revision)
      const name = readdirSync(directory).find(name => name.startsWith('claude-response-'))!
      const diagnostic = JSON.parse(readFileSync(join(directory, name), 'utf8'))
      expect(diagnostic.failure).toMatchObject({ stage: 'send', cause: 'startup' })
      expect(diagnostic.sendCode).toBe('agent_not_ready')
      expect(diagnostic.sendStatus).toBe('rejected')
      expect(JSON.stringify(first.payload)).not.toContain('private rejection detail')
    } finally { await fixture.close() }
  }, 30_000)

  test('Claudeのstalled応答後も同じ依頼の完全回答を回収し再送しない', async () => {
    const fixture = await brokerFixture({ externalSuccess: true, claudeSendError: 'agent_prompt_stalled', claudeDelayedStart: true })
    try {
      const first = await fixture.call('investigation', 'revision-two')
      expect(first.payload).toMatchObject({ allAdopted: true, claude: { adopted: true, cleanupVerified: true } })
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(1)
      expect(state.close_count).toBe(1)
      const revision = `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`
      const directory = join(fixture.journalRoot, revision)
      const name = readdirSync(directory).find(name => name.startsWith('claude-response-'))!
      const diagnostic = JSON.parse(readFileSync(join(directory, name), 'utf8'))
      expect(diagnostic.failure).toBeUndefined()
      expect(diagnostic.sendCode).toBe('agent_prompt_stalled')
    } finally { await fixture.close() }
  }, 50_000)

  test('空画面のまま開始しないClaudeは回答待ち1時間に入らず送信可能性を保持して終了する', async () => {
    const fixture = await brokerFixture({ externalSuccess: true, claudeNeverStarts: true })
    try {
      const first = await fixture.call('investigation', 'revision-two')
      expect(first.payload).toMatchObject({ allAdopted: false, claude: {
        adopted: false, executionState: 'start-unconfirmed', promptMayHaveBeenDelivered: true,
        cleanupVerified: true, failure: { cause: 'startup' },
      } })
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(1)
      expect(state.close_count).toBe(1)
      expect(state.owned).toBe(false)
      await fixture.restart()
      const replay = await fixture.call('investigation', 'revision-two')
      expect(replay.payload).toMatchObject({ allAdopted: false })
      expect(JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8')).prompt_count).toBe(1)
    } finally { await fixture.close() }
  }, 160_000)

  test('Claude送信後の回答不足は再送せずGrok回答と診断を保存する', async () => {
    const fixture = await brokerFixture({ externalSuccess: true, claudeFailures: 2 })
    try {
      const first = await fixture.call('investigation', 'revision-two')
      expect(first.payload).toMatchObject({ allAdopted: false,
        claude: { adopted: false, promptMayHaveBeenDelivered: true },
        slotSummary: { responsesObtained: 2 } })
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(1)
      expect(state.close_count).toBe(1)
      expect(state.owned).toBe(false)
      const revision = `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`
      const saved = JSON.parse(readFileSync(join(fixture.journalRoot, revision, 'investigation-1.json.responses'), 'utf8'))
      expect(saved.grok[0].adopted).toBe(true)
      expect(saved.claude.responseDiagnostic.status).toBe('saved')
      const journalPath = join(fixture.journalRoot, revision, 'investigation-1.json')
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
      saved.finishedAt -= 31_000
      journal.startedAt -= 31_000
      journal.finishedAt -= 31_000
      const cache = JSON.stringify(saved)
      journal.responseCacheDigest = createHash('sha256').update(cache).digest('hex')
      const durable = JSON.stringify(journal)
      writeFileSync(`${journalPath}.responses`, cache, { mode: 0o600 })
      writeFileSync(journalPath, durable, { mode: 0o600 })
      const retry = await fixture.call('investigation', 'revision-two', 'adopted', 1, { retryUnavailable: true })
      expect(retry.payload).toMatchObject({ retryable: false, attemptsFinished: true })
      expect(readFileSync(journalPath, 'utf8')).toBe(durable)
      expect(readFileSync(`${journalPath}.responses`, 'utf8')).toBe(cache)
      const changed = await fixture.call('investigation', 'revision-two', 'adopted', 1,
        { retryUnavailable: true, primaryEvidence: 'different evidence' })
      expect(changed.result.isError).toBe(true)
      expect(changed.payload.reason).toContain('question changed')
      expect(JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8')).prompt_count).toBe(1)
    } finally { await fixture.close() }
  }, 30_000)

  test('Fable GUI artifacts survive broker restart without repeating the advisor and cannot be requested in review', async () => {
    const fixture = await brokerFixture({ externalSuccess: true, writeEnabled: true })
    let artifactRoot: string | undefined
    try {
      const path = fixture.externalEvidence!.fakeHerdrState
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ui_artifacts: true }), { mode: 0o600 })
      const uiProposal = { comparison: 'Synthetic settings, light theme, scroll 0, no focus', beforeKind: 'synthetic' as const }
      const result = await fixture.call('investigation', 'revision-two', 'adopted', 1, { uiProposal })
      artifactRoot = JSON.parse(readFileSync(path, 'utf8')).ui_root
      expect(result.payload.claude).toMatchObject({ adopted: true, cleanupVerified: true,
        uiArtifacts: { status: 'produced', producer: 'claude-fable-5-1' } })
      const artifacts = result.payload.claude.uiArtifacts
      expect(existsSync(artifacts.afterPath)).toBe(true)
      expect(existsSync(artifacts.prototypePath)).toBe(true)
      await fixture.restart()
      const replay = await fixture.call('investigation', 'revision-two', 'adopted', 1, { uiProposal })
      expect(replay.payload.claude.uiArtifacts).toEqual(artifacts)
      const review = await fixture.call('review', 'revision-two', 'adopted', 1, { uiProposal })
      expect(review.result.isError).toBe(true)
      expect(review.payload.reason).toContain('initial-design')
      const final = JSON.parse(readFileSync(path, 'utf8'))
      expect(final.prompt_count).toBe(1)
      expect(final.close_count).toBe(1)
    } finally {
      await fixture.close()
      if (artifactRoot) rmSync(artifactRoot, { recursive: true, force: true })
    }
  }, 30_000)

  test('起動途中の未確定native sessionを記録せずready後のsessionで送信する', async () => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const path = fixture.externalEvidence!.fakeHerdrState
      const initial = JSON.parse(readFileSync(path, 'utf8'))
      initial.late_native_session = true
      writeFileSync(path, JSON.stringify(initial), { mode: 0o600 })
      const result = await fixture.call('investigation', 'revision-two')
      expect(result.payload).toMatchObject({ allAdopted: true, claude: { adopted: true } })
      const final = JSON.parse(readFileSync(path, 'utf8'))
      expect(final.prompt_count).toBe(1)
      expect(final.close_count).toBe(1)
    } finally { await fixture.close() }
  }, 30_000)

  test('回答read中のstate変化は同じClaudeの次の安定回答を待つ', async () => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const path = fixture.externalEvidence!.fakeHerdrState
      const initial = JSON.parse(readFileSync(path, 'utf8'))
      initial.change_during_read = true
      writeFileSync(path, JSON.stringify(initial), { mode: 0o600 })
      const result = await fixture.call('investigation', 'revision-two')
      expect(result.payload).toMatchObject({ allAdopted: true, claude: { adopted: true } })
      const final = JSON.parse(readFileSync(path, 'utf8'))
      expect(final.read_changed).toBe(true)
      expect(final.prompt_count).toBe(1)
      expect(final.close_count).toBe(1)
    } finally { await fixture.close() }
  }, 30_000)

  test.each([{ corrupt: false, lines: 1500 }, { corrupt: false, lines: 20000 }, { corrupt: false, lines: 150000 }, { corrupt: true, lines: 1500 }])('Claude answer file collects long payloads and rejects changes: %j', async ({ corrupt, lines }) => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const path = fixture.externalEvidence!.fakeHerdrState
      const initial = JSON.parse(readFileSync(path, 'utf8'))
      initial.answer_file_lines = lines
      initial.answer_file_corrupt = corrupt
      writeFileSync(path, JSON.stringify(initial), { mode: 0o600 })
      const result = await fixture.call('investigation', 'revision-two')
      expect(result.payload.claude.adopted).toBe(!corrupt)
      expect(result.payload.claude.cleanupVerified).toBe(true)
      if (!corrupt) {
        const expected = Array.from({ length: lines }, (_, i) => `synthetic FAQ ${i + 1}`).join('\n')
        expect(result.payload.claude.response).toBe(expected)
        const artifact = JSON.parse(readFileSync(join(fixture.state, result.payload.claude.answerArtifact.path), 'utf8'))
        expect(artifact.response).toBe(expected)
        const journalPath = join(fixture.journalRoot,
          `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`, 'investigation-1.json')
        const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
        expect(readInterruptedAdvisorSlots(journalPath, journal).claude?.response).toBe(expected)
        await fixture.restart()
        const replay = await fixture.call('investigation', 'revision-two')
        expect(replay.payload.claude.response).toBe(expected)
      }
      const after = JSON.parse(readFileSync(path, 'utf8'))
      expect(after.prompt_count).toBe(1)
      expect(after.close_count).toBe(1)
      expect(after.owned).toBe(false)
    } finally { await fixture.close() }
  }, 40_000)

  test.each(['file', 'terminal'])('Claude credential-shaped review is adopted, sanitized and restored: %s', async source => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const path = fixture.externalEvidence!.fakeHerdrState
      const initial = JSON.parse(readFileSync(path, 'utf8'))
      const token = 'xoxb-1234567890-abcdefghijklmnopqrstuvwxyz'
      const prose = Array.from({ length: 1500 }, (_, i) => `Finding ${i + 1}`).join('\n')
      const body = `${prose}\nBearer capability\nAuthorization: Bearer <token>\nAuthorization: Bearer %22synthetic-encoded-credential%22\n${token}\n-----BEGIN%20PRIVATE%20KEY-----\nU1lOVEhFVElDX0tFWV9CT0RZ\n-----END%20PRIVATE%20KEY-----\nFinal finding.`
      initial.answer_body = body
      if (source === 'file') initial.answer_file_lines = 1
      writeFileSync(path, JSON.stringify(initial), { mode: 0o600 })
      const result = await fixture.call('investigation', 'revision-two')
      expect(result.payload.claude).toMatchObject({ adopted: true, responseRedacted: true, cleanupVerified: true })
      const response = result.payload.claude.response
      expect(response).toStartWith(prose)
      expect(response).toEndWith('Final finding.')
      expect(response).toContain('[credential removed]')
      expect(response).not.toContain(token)
      expect(response).not.toContain('U1lOVEhFVElDX0tFWV9CT0RZ')
      const journalPath = join(fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`, 'investigation-1.json')
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
      expect(journal.claude.responseDigest).toBe(createHash('sha256').update(response).digest('hex'))
      expect(readInterruptedAdvisorSlots(journalPath, journal).claude?.response).toBe(response)
      const diagnostic = readFileSync(join(fixture.state, result.payload.claude.responseDiagnostic.path), 'utf8')
      const persisted = [diagnostic, JSON.stringify(result.payload), readFileSync(`${journalPath}.responses`, 'utf8'), readFileSync(`${journalPath}.slots`, 'utf8')]
      if (source === 'file') {
        const raw = readFileSync(join(fixture.state, result.payload.claude.answerArtifact.path), 'utf8')
        persisted.push(raw)
        const artifact = JSON.parse(raw)
        const nonce = artifact.marker.slice('REQUEST_MARKER='.length)
        const original = `CLAUDE_ANSWER_BEGIN=${nonce}\n${body}\nCLAUDE_ANSWER_END=${nonce}\n`
        expect(artifact).toMatchObject({ response, redacted: true,
          responseSha256: journal.claude.responseDigest, responseBytes: Buffer.byteLength(response),
          sha256: createHash('sha256').update(original).digest('hex'), bytes: Buffer.byteLength(original) })
      }
      for (const raw of persisted) {
        expect(raw).not.toContain(token)
        expect(raw).not.toContain('synthetic-encoded-credential')
        expect(raw).not.toContain('U1lOVEhFVElDX0tFWV9CT0RZ')
      }
      await fixture.restart()
      const replay = await fixture.call('investigation', 'revision-two')
      expect(replay.payload.claude).toMatchObject({ adopted: true, response, responseRedacted: true })
      const after = JSON.parse(readFileSync(path, 'utf8'))
      expect(after.prompt_count).toBe(1)
      expect(after.close_count).toBe(1)
      expect(after.owned).toBe(false)
    } finally { await fixture.close() }
  }, 40_000)

  test.each(['answer_file_receipt_delay_reads', 'answer_file_corrupt_reads'])('Claude file completion settles across polls without another prompt: %s', async field => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const path = fixture.externalEvidence!.fakeHerdrState
      const initial = JSON.parse(readFileSync(path, 'utf8'))
      initial.answer_file_lines = 1500
      initial[field] = 3
      writeFileSync(path, JSON.stringify(initial), { mode: 0o600 })
      const result = await fixture.call('investigation', 'revision-two')
      expect(result.payload.claude.adopted).toBe(true)
      expect(result.payload.claude.response.split('\n')).toHaveLength(1500)
      expect(result.payload.claude.cleanupVerified).toBe(true)
      const after = JSON.parse(readFileSync(path, 'utf8'))
      expect(after.response_reads).toBeGreaterThan(3)
      expect(after.prompt_count).toBe(1)
      expect(after.close_count).toBe(1)
    } finally { await fixture.close() }
  }, 40_000)

  test.each(['audit_drift', 'startup_audit_drift', 'git_audit_failure'])('Claude実回答は並行metadata変化 %s で破棄せず一度の起動で3回答を保存する', async drift => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const path = fixture.externalEvidence!.fakeHerdrState
      const state = JSON.parse(readFileSync(path, 'utf8'))
      state[drift] = true
      writeFileSync(path, JSON.stringify(state), { mode: 0o600 })
      const result = await fixture.call('investigation', 'revision-two')
      expect(result.payload).toMatchObject({ complete: true, allAdopted: true,
        slotSummary: { responsesObtained: 3 } })
      const after = JSON.parse(readFileSync(path, 'utf8'))
      expect(after.prompt_count).toBe(1)
      expect(after.close_count).toBe(1)
      expect(after.owned).toBe(false)
      const revision = `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`
      const cache = JSON.parse(readFileSync(join(fixture.journalRoot, revision, 'investigation-1.json.responses'), 'utf8'))
      expect(cache.claude.adopted).toBe(true)
      expect(cache.claude.cleanupWarnings.length).toBeGreaterThan(0)
      expect(existsSync(join(fixture.state, 'advisor-ephemeral', fixture.jobId, fixture.nonce, revision, 'investigation-1'))).toBe(false)
      if (drift === 'git_audit_failure') {
        expect(existsSync(join(fixture.repo, '.git', 'HEAD'))).toBe(true)
      } else {
        expect(existsSync(join(fixture.repo, '.env.audit-fixture'))).toBe(true)
      }
      const replay = await fixture.call('investigation', 'revision-two')
      expect(replay.payload).toMatchObject({ complete: true, slotSummary: { responsesObtained: 3 } })
      expect(JSON.parse(readFileSync(path, 'utf8')).prompt_count).toBe(1)
    } finally { await fixture.close() }
  }, 40_000)

  test('Claude workspace作成前の失敗も残留requestで再試行を妨げない', async () => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const path = fixture.externalEvidence!.fakeHerdrState
      const state = JSON.parse(readFileSync(path, 'utf8'))
      state.create_failures = 1
      writeFileSync(path, JSON.stringify(state), { mode: 0o600 })
      const result = await fixture.call('investigation', 'revision-two')
      expect(result.payload).toMatchObject({ complete: true, allAdopted: true,
        slotSummary: { responsesObtained: 3 } })
      const after = JSON.parse(readFileSync(path, 'utf8'))
      expect(after.create_failures).toBe(0)
      expect(after.prompt_count).toBe(1)
      expect(after.owned).toBe(false)
    } finally { await fixture.close() }
  }, 180_000)

  test('native欠員を復旧すると成功済みGrokとClaudeを再起動しない', async () => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const first = await fixture.call('investigation', 'revision-two', 'unavailable')
      expect(first.payload).toMatchObject({ complete: false, slotSummary: { responsesObtained: 2 } })
      const path = join(fixture.journalRoot, `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`, 'investigation-1.json')
      const cache = JSON.parse(readFileSync(`${path}.responses`, 'utf8'))
      cache.finishedAt -= 31_000
      // Simulate PR34's incorrectly completed cache and journal as well.
      cache.complete = true
      const raw = JSON.stringify(cache)
      writeFileSync(`${path}.responses`, raw, { mode: 0o600 })
      const journal = JSON.parse(readFileSync(path, 'utf8'))
      journal.status = 'reviewers-completed'
      journal.responseCacheDigest = createHash('sha256').update(raw).digest('hex')
      writeFileSync(path, JSON.stringify(journal), { mode: 0o600 })
      const retry = await fixture.call('investigation', 'revision-two', 'adopted', 1, { retryUnavailable: true })
      expect(retry.payload).toMatchObject({ complete: true, allAdopted: true })
      const after = JSON.parse(readFileSync(`${path}.responses`, 'utf8'))
      expect(after.grok).toEqual(cache.grok)
      expect(after.claude).toEqual(cache.claude)
      expect(JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8')).prompt_count).toBe(1)
    } finally { await fixture.close() }
  }, 20_000)

  test.each([false, true])('復旧予算は同じ入力または中断由来の新入力でリセットできない: %s', async interruptionRecovery => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      await fixture.call('investigation', 'revision-two', 'unavailable')
      const path = join(fixture.journalRoot, `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`, 'investigation-1.json')
      const restored = fixture.stageRevision('認証を復旧しました')
      const cache = JSON.parse(readFileSync(`${path}.responses`, 'utf8'))
      cache.finishedAt -= 31_000
      cache.retryCount = 3
      if (!interruptionRecovery) {
        cache.recoveryInputRevision = restored.revision
        cache.recoveryInputDigest = restored.digest
      }
      const raw = JSON.stringify(cache)
      writeFileSync(`${path}.responses`, raw, { mode: 0o600 })
      const journal = JSON.parse(readFileSync(path, 'utf8'))
      journal.interruptionRecovery = interruptionRecovery
      journal.responseCacheDigest = createHash('sha256').update(raw).digest('hex')
      writeFileSync(path, JSON.stringify(journal), { mode: 0o600 })
      const retry = await fixture.call('investigation', 'revision-two', 'adopted', 1,
        { retryUnavailable: true, inputUpdateIsRecoveryOnly: true })
      expect(retry.payload).toMatchObject({ complete: false, retryable: false, retryBudgetExhausted: true })
      expect(readFileSync(`${path}.responses`, 'utf8')).toBe(raw)
      expect(JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8')).prompt_count).toBe(1)
    } finally { await fixture.close() }
  }, 20_000)

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
      expect(result.isError).not.toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        roundTerminal: true,
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

  test('macOS shimのrealpathがGitへ衝突してもPython helperを起動し回収する', async () => {
    const fixture = await brokerFixture({ externalSuccess: true, developerShimCollision: true })
    try {
      const { payload } = await fixture.call('investigation', 'revision-two')
      expect(payload.claude).toMatchObject({ adopted: true, executionState: 'response-obtained', cleanupVerified: true })
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(1)
      expect(state.close_count).toBe(1)
      expect(state.owned).toBe(false)
    } finally { await fixture.close() }
  }, 30_000)

  test('起動前snapshotが失敗してもClaudeを一度起動・回収してowned workspaceを閉じる', async () => {
    const fixture = await brokerFixture({ externalSuccess: true, snapshotDepthOverflow: true })
    try {
      const { payload } = await fixture.call('investigation', 'revision-two')
      expect(payload.claude).toMatchObject({ adopted: true, executionState: 'response-obtained', cleanupVerified: true })
      const claude = payload.claude as { responseDiagnostic: { path: string }, cleanupWarnings: string[] }
      expect(claude.cleanupWarnings).toContain('initial repository metadata snapshot was unavailable')
      const diagnostic = JSON.parse(readFileSync(join(fixture.state, claude.responseDiagnostic.path), 'utf8'))
      expect(diagnostic.snapshot).toMatchObject({ outcome: 'command-failed' })
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(1)
      expect(state.close_count).toBe(1)
      expect(state.owned).toBe(false)
    } finally { await fixture.close() }
  }, 30_000)

  test('単一workflowはsnapshot不能な大型dirty fileでもreviewer transportを止めない', async () => {
    const fixture = await brokerFixture()
    try {
      const oversized = join(fixture.repo, 'large-untracked.bin')
      writeFileSync(oversized, '', { mode: 0o600 })
      truncateSync(oversized, 65 * 1024 * 1024)
      const { result, payload } = await fixture.call('investigation', 'revision-two')
      expect(result.isError).not.toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        roundTerminal: true,
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
      expect(retry.payload).toMatchObject({ complete: false, humanActionRequired: true })
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

  for (const designState of ['absent', 'malformed'] as const) {
    test(`継続jobは初期設計ledgerが${designState}でも最終3者を一度だけ起動する`, async () => {
      const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
      try {
        const revisionRoot = join(fixture.journalRoot,
          `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`)
        if (designState === 'malformed') {
          mkdirSync(revisionRoot, { recursive: true, mode: 0o700 })
          writeFileSync(join(revisionRoot, 'investigation-1.json'), '{broken', { mode: 0o600 })
        }
        const review = await fixture.call('review', 'revision-two')
        expect(review.result.isError).not.toBe(true)
        expect(review.payload).toMatchObject({
          complete: true,
          initialDesignStatus: 'not-recorded-this-attempt',
          slotSummary: { total: 3, started: 3, responsesObtained: 3 },
        })
        expect(review.payload.initialDesignWarning).toContain('final review only')
        const journalPath = join(revisionRoot, 'review-1.json')
        const before = readFileSync(journalPath, 'utf8')
        const repeated = await fixture.call('review', 'revision-two')
        expect(repeated.payload).toMatchObject({
          initialDesignStatus: 'not-recorded-this-attempt',
          slotSummary: { total: 3, started: 3, responsesObtained: 3 },
        })
        expect(readFileSync(journalPath, 'utf8')).toBe(before)
        if (designState === 'absent') expect(existsSync(join(revisionRoot, 'investigation-1.json'))).toBe(false)
        else expect(readFileSync(join(revisionRoot, 'investigation-1.json'), 'utf8')).toBe('{broken')
      } finally { await fixture.close() }
    }, 20_000)
  }

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

  test('新規attemptのpollとcold retryは未開始を返し通常開始で3回答を取得できる', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      const poll = await fixture.poll('investigation', 'revision-one')
      expect(poll.result.isError).not.toBe(true)
      expect(poll.payload).toMatchObject({ complete: false, notStarted: true,
        inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest })
      const retry = await fixture.call('investigation', 'revision-two', 'adopted', 1,
        { retryUnavailable: true, inputUpdateIsRecoveryOnly: true })
      expect(retry.result.isError).not.toBe(true)
      expect(retry.payload).toMatchObject({ complete: false, notStarted: true })
      const review = await fixture.poll('review', 'revision-two')
      expect(review.payload).toMatchObject({ complete: false, notStarted: true })
      expect(String(review.payload.nextAction)).toContain('Review-1 does not require an attempt-local initial-design round')
      expect(String(review.payload.nextAction)).not.toContain('investigation before review-1')
      expect(String(review.payload.nextAction)).toContain('mandatory fix delta')
      expect((await fixture.call('investigation', 'revision-two')).payload).toMatchObject({ complete: true })
      expect((await fixture.poll('investigation', 'revision-two')).payload).toMatchObject({ complete: true })
    } finally { await fixture.close() }
  }, 30_000)

  test('部分的な保存記録は未開始とせず上書きしない', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      const root = join(fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`)
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const path = join(root, 'investigation-1.json.responses')
      writeFileSync(path, '{"preserved":true}', { mode: 0o600 })
      const poll = await fixture.poll('investigation', 'revision-two')
      expect(poll.payload.notStarted).not.toBe(true)
      const retry = await fixture.call('investigation', 'revision-two', 'adopted', 1,
        { retryUnavailable: true })
      expect(retry.payload.notStarted).not.toBe(true)
      expect(readFileSync(path, 'utf8')).toBe('{"preserved":true}')
    } finally { await fixture.close() }
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

  test('欠員roundの受領記録から取得済み指摘の必須修正だけをround 2で検証できる', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      await fixture.call('investigation', 'revision-two')
      const path = fixture.externalEvidence!.fakeHerdrState
      const state = JSON.parse(readFileSync(path, 'utf8'))
      state.answer_file_lines = 1500
      state.answer_file_corrupt = true
      writeFileSync(path, JSON.stringify(state), { mode: 0o600 })
      const first = await fixture.call('review', 'revision-two', 'adopted', 1, { reviewWorktrees: ['.'] })
      expect(first.result.isError).not.toBe(true)
      expect(first.payload).toMatchObject({ complete: false, roundTerminal: true, allAdopted: false,
        slotSummary: { responsesObtained: 2 }, claude: { adopted: false } })
      expect(first.payload.nextRetryAt).toBeUndefined()
      expect(first.payload.pollObservedAt).toBeGreaterThan(0)
      const repeated = await fixture.call('review', 'revision-two')
      expect(repeated.payload).toMatchObject({ complete: false, alreadyObserved: true })
      const after = JSON.parse(readFileSync(path, 'utf8'))
      expect(after.prompt_count).toBe(2)
      after.answer_file_corrupt = false
      writeFileSync(path, JSON.stringify(after), { mode: 0o600 })
      writeFileSync(join(fixture.repo, 'round-two-fix.ts'), 'export const fixed = true\n')
      const second = await fixture.call('review', 'revision-two', 'adopted', 2, {
        nativeAgentId: '/root/native-partial-risk-r2',
        roundTwoBasis: {
          roundOneSources: ['native'], mandatoryFindingSummary: '主要処理の不具合',
          taskOwnedFixDelta: '主要処理の必須修正',
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
        },
      })
      expect(second.payload).toMatchObject({ complete: true, allAdopted: true })
    } finally { await fixture.close() }
  }, 80_000)

  test('linked worktreeだけの修正でも保存したround 1から外部round 2を完了する', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      writeFileSync(join(fixture.repo, '.gitignore'), '.worktrees/\n')
      git(['add', '.gitignore'], fixture.repo)
      git(['commit', '-qm', 'ignore worktrees'], fixture.repo)
      git(['worktree', 'add', '-qb', 'task', '.worktrees/task'], fixture.repo)
      expect((await fixture.call('investigation', 'revision-two')).payload.complete).toBe(true)
      const first = await fixture.call('review', 'revision-two', 'adopted', 1,
        { reviewWorktrees: ['.worktrees/task'] })
      expect(first.payload).toMatchObject({ complete: true, slotSummary: { responsesObtained: 3 } })
      writeFileSync(join(fixture.repo, '.worktrees/task/fix.ts'), 'export const fixed = true\n')
      // Restart proves the selected scope comes from the durable baseline, not process state.
      await fixture.restart()
      const second = await fixture.call('review', 'revision-two', 'adopted', 2, {
        nativeAgentId: '/root/native-linked-risk-r2',
        roundTwoBasis: {
          roundOneSources: ['native'], mandatoryFindingSummary: '主要処理の不具合',
          taskOwnedFixDelta: 'linked worktree内の処理を修正',
          taskOwnedFixPaths: [{ repository: '.worktrees/task', path: 'fix.ts' }],
        },
      })
      expect(second.payload).toMatchObject({ complete: true, round: 2,
        slotSummary: { responsesObtained: 3 } })
    } finally { await fixture.close() }
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
      expect((await fixture.call('review', 'revision-two', 'adopted', 1, { reviewWorktrees: ['.'] })).payload)
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
      expect(String(wrongOwnedPath.payload.reason)).toContain('non-empty')
      writeFileSync(join(fixture.repo, 'another-task.ts'), 'export const foreign = true\n')
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
      expect(roundTwo.payload).toMatchObject({ complete: true, round: 2, slotSummary: { responsesObtained: 3 } })
      expect(readFileSync(join(fixture.repo, 'another-task.ts'), 'utf8')).toBe('export const foreign = true\n')
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

  test('review第2回はrepository変化でも回答を配送しcold retryも外部再起動しない', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true,
      onExternalPrompt: (count, repo) => {
        if (count === 3) writeFileSync(join(repo, 'parallel-work.txt'), 'concurrent work\n')
      },
    })
    try {
      expect((await fixture.call('investigation', 'revision-two')).payload.complete).toBe(true)
      expect((await fixture.call('review', 'revision-two')).payload.complete).toBe(true)
      writeFileSync(join(fixture.repo, 'round-two-fix.ts'), 'export const fix = true\n')
      const overrides = { nativeAgentId: '/root/native-risk-r2', roundTwoBasis: {
        roundOneSources: ['native'] as Array<'native'>,
        mandatoryFindingSummary: '主要導線の不具合', taskOwnedFixDelta: '回帰を修正',
        taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
      } }
      const round = await fixture.call('review', 'revision-two', 'adopted', 2, overrides)
      expect(round.payload).toMatchObject({ complete: true, round: 2,
        repositoryDeltaStable: false, repositoryAssessmentRequired: true,
        slotSummary: { responsesObtained: 3 } })
      const journalPath = join(fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`, 'review-2.json')
      const cacheBefore = readFileSync(`${journalPath}.responses`, 'utf8')
      const original = JSON.parse(readFileSync(journalPath, 'utf8'))
      // Exact pre-fix failure: all responses exist, only repository drift
      // caused a failed terminal journal and no delivery receipt.
      const legacy = { ...original, status: 'required-reviewer-failed',
        receiptIssuedAt: undefined, receiptDigest: undefined, pollObservedAt: undefined,
        receiptAcknowledgement: undefined }
      writeFileSync(journalPath, JSON.stringify(legacy), { mode: 0o600 })
      await fixture.restart()
      writeFileSync(`${journalPath}.responses`, cacheBefore + ' ', { mode: 0o600 })
      const corrupt = await fixture.call('review', 'revision-two', 'adopted', 2,
        { ...overrides, retryUnavailable: true })
      expect(corrupt.payload.complete).toBe(false)
      expect(corrupt.payload.grok).toBeUndefined()
      writeFileSync(`${journalPath}.responses`, cacheBefore, { mode: 0o600 })
      const recovered = await fixture.call('review', 'revision-two', 'adopted', 2,
        { ...overrides, retryUnavailable: true })
      expect(recovered.payload).toMatchObject({ complete: true, restoredSavedResponses: true,
        repositoryDeltaStable: false, repositoryAssessmentRequired: true,
        grok: [{ adopted: true }], claude: { adopted: true } })
      expect(recovered.payload.grok).toEqual(round.payload.grok)
      expect(recovered.payload.claude).toEqual(round.payload.claude)
      expect(readFileSync(`${journalPath}.responses`, 'utf8')).toBe(cacheBefore)
      await fixture.restart()
      const polled = await fixture.poll('review', 'revision-two', 2)
      expect(polled.payload).toMatchObject({ complete: true, alreadyObserved: true,
        restoredSavedResponses: true, repositoryDeltaStable: false })
      expect(polled.payload.grok).toEqual(round.payload.grok)
      // Interrupted older generations omitted the after-observation. Missing
      // metadata must not make the same bound answers inaccessible either.
      writeFileSync(journalPath, JSON.stringify({ ...legacy,
        repositoryDeltaCurrentDigestAfter: undefined }), { mode: 0o600 })
      await fixture.restart()
      const withoutAfter = await fixture.call('review', 'revision-two', 'adopted', 2,
        { ...overrides, retryUnavailable: true })
      expect(withoutAfter.payload).toMatchObject({ complete: true, restoredSavedResponses: true,
        repositoryDeltaStable: false, repositoryAssessmentRequired: true })
      expect(withoutAfter.payload.grok).toEqual(round.payload.grok)
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(3)
      expect(readFileSync(join(fixture.repo, 'parallel-work.txt'), 'utf8')).toBe('concurrent work\n')
      // Recovery must not turn a foreign/tampered binding into valid feedback.
      const tampered = JSON.parse(readFileSync(journalPath, 'utf8'))
      tampered.roundTwoBasis.reviewOneJournalDigest = '0'.repeat(64)
      writeFileSync(journalPath, JSON.stringify(tampered), { mode: 0o600 })
      expect((await fixture.poll('review', 'revision-two', 2)).result.isError).toBe(true)
    } finally { await fixture.close() }
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

  test('review round 1後のコミット済み修正を同じ第2reviewへ結合し再起動後も回答を保持する', async () => {
    const fixture = await brokerFixture({ writeEnabled: true, externalSuccess: true })
    try {
      expect((await fixture.call('investigation', 'revision-two')).payload)
        .toMatchObject({ complete: true, round: 1 })
      expect((await fixture.call('review', 'revision-two')).payload)
        .toMatchObject({ complete: true, round: 1 })
      writeFileSync(join(fixture.repo, 'round-two-fix.ts'), 'committed\n')
      git(['add', 'round-two-fix.ts'], fixture.repo)
      git(['commit', '-qm', 'concurrent commit'], fixture.repo)
      // Production regression: the primary commits a valid fix before R2.
      // Generated files and a changed instruction file must not become review scope.
      for (let index = 0; index < 205; index++) {
        writeFileSync(join(fixture.repo, `generated-${index}.js`), 'unrelated build output\n')
      }
      writeFileSync(join(fixture.repo, 'AGENTS.md'), 'updated workspace instructions\n')
      const roundTwo = await fixture.call('review', 'revision-two', 'adopted', 2, {
        nativeAgentId: '/root/native-risk-r2-after-head-move',
        roundTwoBasis: {
          roundOneSources: ['native'],
          mandatoryFindingSummary: '主要導線で再現する不具合',
          taskOwnedFixDelta: '対象処理を修正',
          taskOwnedFixPaths: [{ repository: '.', path: 'round-two-fix.ts' }],
        },
      })
      expect(roundTwo.payload).toMatchObject({ complete: true, round: 2,
        grok: [{ adopted: true }], claude: { adopted: true } })
      const journalPath = join(fixture.journalRoot,
        `revision-${fixture.revisionTwo.revision}-${fixture.revisionTwo.digest.slice(0, 16)}`, 'review-2.json')
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
      expect(journal.roundTwoBasis.taskOwnedFixPaths).toEqual([{ repository: '.', path: 'round-two-fix.ts' }])
      expect(journal.roundTwoBasis.changedRepositoryCount).toBe(1)
      await fixture.restart()
      const polled = await fixture.poll('review', 'revision-two', 2)
      expect(polled.payload).toMatchObject({ complete: true, alreadyObserved: true })
      expect(polled.payload.grok).toEqual(roundTwo.payload.grok)
      expect(polled.payload.claude).toEqual(roundTwo.payload.claude)
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(3)
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

  test('終了済みの初期設計欠員は最終レビューの試行を妨げない', async () => {
    const fixture = await brokerFixture({ writeEnabled: true })
    try {
      const initial = await fixture.call('investigation', 'revision-two', 'unavailable')
      expect(initial.payload).toMatchObject({ attemptsFinished: true, allAdopted: false })
      const review = await fixture.call('review', 'revision-two', 'unavailable')
      expect(review.payload).toMatchObject({ attemptsFinished: true, phase: 'review' })
      expect(review.payload.claude).toMatchObject({ attempted: true })
    } finally { await fixture.close() }
  }, 20_000)

  test.each(['round', 'poll', 'new-input', 'startup'] as const)('送信前中断はモデルのretry指定なしでClaudeだけ続行する: %s', async entry => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const nativeResponse = `solution response\n${nativeAdvisorMarker(fixture.nonce,
        fixture.revisionTwo.revision, fixture.revisionTwo.digest, 'investigation', 1, 'solution')}`
      const armed = armRetiredRequestedRound(fixture, fixture.revisionTwo,
        { version: 9, nativeResponse, continuation: true, persistClaudeOutcome: false })
      expect(finalizeRetiredAdvisorRounds(fixture.state)).toEqual({ finalized: 1 })
      const binding = entry === 'new-input' ? fixture.stageRevision('続けてください。最新制約を守ってください') : fixture.revisionTwo
      await fixture.restart()
      if (entry === 'startup') {
        const deadline = Date.now() + 15_000
        while (JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8')).prompt_count === 0 && Date.now() < deadline) await Bun.sleep(50)
        expect(JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8')).prompt_count).toBe(1)
      }
      let result = entry === 'poll'
        ? await fixture.poll('investigation', binding)
        : await fixture.call('investigation', binding)
      while (result.payload.pending === true || result.payload.receiptRequired === true) {
        result = await fixture.poll('investigation', fixture.revisionTwo)
      }
      expect(result.payload.claude).toMatchObject({ adopted: true, executionState: 'response-obtained' })
      expect(result.payload.grok).toMatchObject([{ adopted: false, executionState: 'start-unconfirmed' }])
      if (entry === 'new-input') expect(result.payload).toMatchObject({ staleInput: true, inputRevision: fixture.revisionTwo.revision })
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(1)
      if (entry === 'new-input') expect(state.prompt).toContain('最新制約を守ってください')
      expect(state.close_count).toBe(1)
      expect(JSON.parse(readFileSync(armed.journalPath, 'utf8')).retryCount).toBe(1)
      await fixture.restart()
      await fixture.call('investigation', binding)
      expect(JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8')).prompt_count).toBe(1)
    } finally { await fixture.close() }
  }, 30_000)

  test.each(['finished-failure', 'delivery-possible', 'changed-request', 'saved-peer'] as const)('自動続行の送信境界と取得済み回答を保持する: %s', async scenario => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const nativeResponse = `solution response\n${nativeAdvisorMarker(fixture.nonce,
        fixture.revisionTwo.revision, fixture.revisionTwo.digest, 'investigation', 1, 'solution')}`
      const armed = armRetiredRequestedRound(fixture, fixture.revisionTwo,
        { version: 9, nativeResponse, continuation: true, persistClaudeOutcome: false })
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
      const savedPeer = { adopted: true, attempted: true, perspective: 'solution',
        executionState: 'response-obtained', containmentVerified: true,
        processId: 42424, response: 'keep exact acquired answer' }
      if (scenario === 'finished-failure' || scenario === 'saved-peer') {
        writeFileSync(`${armed.journalPath}.slots`, JSON.stringify({
          contextDigest: fixture.contextDigest, phase: 'investigation', round: 1,
          inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest,
          evidenceDigest: journal.primaryEvidenceDigest,
          ...(scenario === 'saved-peer' ? { grok: [savedPeer] } : { claude: {
            attempted: true, adopted: false, required: true, lifecycle: 'ephemeral-v2',
            executionState: 'unavailable-before-start', workspaceCreationAttempted: false,
            freshEphemeral: false, cleanupVerified: false, containmentVerified: true,
            promptMayHaveBeenDelivered: false, reason: 'real preflight failure',
            failure: { advisor: 'claude', cause: 'startup' },
          } }),
        }), { mode: 0o600 })
      }
      if (scenario === 'delivery-possible') persistAdvisorClaudeCleanupOutcome(fixture.state, {
        jobId: fixture.jobId, attemptNonce: fixture.nonce,
        inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest,
        inputDigestPrefix: fixture.revisionTwo.digest.slice(0, 16), phase: 'investigation', round: 1,
        workspaceCreationAttempted: true, freshEphemeral: true, cleanupVerified: true,
        cleanupStatus: 'closed-and-verified', cleanupReceiptDigest: 'c'.repeat(64),
        promptMayHaveBeenDelivered: true,
      })
      finalizeRetiredAdvisorRounds(fixture.state)
      if (scenario === 'changed-request') writeFileSync(`${armed.journalPath}.request`, '{}', { mode: 0o600 })
      await fixture.restart()
      const result = await fixture.call('investigation', 'revision-two')
      expect(JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8')).prompt_count)
        .toBe(scenario === 'saved-peer' ? 1 : 0)
      if (scenario === 'saved-peer') expect(result.payload.grok).toEqual([savedPeer])
      if (scenario === 'finished-failure') expect(result.payload.claude.failure.cause).toBe('startup')
      if (scenario === 'delivery-possible') expect(result.payload.claude.promptMayHaveBeenDelivered).toBe(true)
    } finally { await fixture.close() }
  }, 30_000)

  test.each([false, true])('続行の起動前検証失敗をpollと再起動でループしない: startup=%s', async startup => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const nativeResponse = `solution response\n${nativeAdvisorMarker(fixture.nonce,
        fixture.revisionTwo.revision, fixture.revisionTwo.digest, 'investigation', 1, 'solution')}`
      const armed = armRetiredRequestedRound(fixture, fixture.revisionTwo,
        { version: 9, nativeResponse, continuation: true, continuationReviewWorktrees: ['missing-worktree'] })
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
      const savedPeer = { adopted: true, attempted: true, perspective: 'solution',
        executionState: 'response-obtained', containmentVerified: true,
        processId: 42424, response: 'saved peer answer even when continuation fails' }
      writeFileSync(`${armed.journalPath}.slots`, JSON.stringify({
        contextDigest: fixture.contextDigest, phase: 'investigation', round: 1,
        inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest,
        evidenceDigest: journal.primaryEvidenceDigest, grok: [savedPeer],
      }), { mode: 0o600 })
      finalizeRetiredAdvisorRounds(fixture.state)
      if (startup) await fixture.restart()
      for (let n = 0; n < 2; n++) {
        const result = await fixture.call('investigation', 'revision-two')
        expect(result.payload).toMatchObject({ continuationUnavailable: true, attemptsFinished: true, retryable: false,
          phase: 'investigation', round: 1, inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest })
        expect(result.payload.native).toBeArray()
        expect(result.payload.grok).toEqual([savedPeer])
        expect(result.payload.claude.failure.cause).toBe('interrupted')
        expect(JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8')).prompt_count).toBe(0)
        expect(existsSync(`${armed.journalPath}.continuation-unavailable`)).toBe(true)
        await fixture.restart()
      }
    } finally { await fixture.close() }
  }, 15_000)

  test('初回中断で回答cacheがなくても未取得外部枠を再起動して3回答揃える', async () => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const nativeResponse = `solution response\n${nativeAdvisorMarker(fixture.nonce,
        fixture.revisionTwo.revision, fixture.revisionTwo.digest, 'investigation', 1, 'solution')}`
      const armed = armRetiredRequestedRound(fixture, fixture.revisionTwo, { version: 9, nativeResponse })
      expect(finalizeRetiredAdvisorRounds(fixture.state)).toEqual({ finalized: 1 })
      expect(existsSync(`${armed.journalPath}.responses`)).toBe(false)
      const interrupted = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
      const savedGrok = { adopted: true, attempted: true, perspective: 'solution',
        executionState: 'response-obtained', containmentVerified: true,
        processId: 42424, response: 'durable Grok answer before interruption' }
      writeFileSync(`${armed.journalPath}.slots`, JSON.stringify({
        contextDigest: fixture.contextDigest, phase: 'investigation', round: 1,
        inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest,
        evidenceDigest: interrupted.primaryEvidenceDigest, grok: [savedGrok],
      }), { mode: 0o600 })
      const oldCache = { contextDigest: fixture.contextDigest, phase: 'investigation', round: 1,
        inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest,
        evidenceDigest: interrupted.primaryEvidenceDigest, complete: false, finishedAt: Date.now() - 31_000,
        native: interrupted.native, grok: [], claude: interrupted.claude }
      const staleCacheRaw = JSON.stringify(oldCache)
      writeFileSync(`${armed.journalPath}.responses`, staleCacheRaw, { mode: 0o600 })
      interrupted.responseCacheDigest = createHash('sha256').update(staleCacheRaw).digest('hex')
      const interruptedRaw = JSON.stringify(interrupted)
      writeFileSync(armed.journalPath, interruptedRaw, { mode: 0o600 })
      const oldReceiptPath = join(fixture.state, 'advisor-retirement', fixture.jobId, fixture.nonce, `${fixture.nonce}.json`)
      const oldReceipt = JSON.parse(readFileSync(oldReceiptPath, 'utf8'))
      oldReceipt.terminalJournalDigest = createHash('sha256').update(interruptedRaw).digest('hex')
      writeFileSync(oldReceiptPath, JSON.stringify(oldReceipt), { mode: 0o600 })
      const polled = await fixture.call('investigation', 'revision-two')
      expect(polled.payload).toMatchObject({ recoveredAfterInterruption: true,
        interrupted: true, retryable: true, attemptsFinished: false,
        slotSummary: { responsesObtained: 2 } })
      expect(polled.payload.grok).toEqual([savedGrok])
      const early = await fixture.call('investigation', 'revision-two', 'adopted', 1,
        { retryUnavailable: true, inputUpdateIsRecoveryOnly: true })
      expect(early.payload).toMatchObject({ complete: false, waitingForAdvisors: true, retryable: true })
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
      journal.startedAt -= 31_000
      journal.finishedAt -= 31_000
      oldCache.finishedAt -= 31_000
      const oldCacheRaw = JSON.stringify(oldCache)
      writeFileSync(`${armed.journalPath}.responses`, oldCacheRaw, { mode: 0o600 })
      journal.responseCacheDigest = createHash('sha256').update(oldCacheRaw).digest('hex')
      const raw = JSON.stringify(journal)
      writeFileSync(armed.journalPath, raw, { mode: 0o600 })
      const receiptPath = join(fixture.state, 'advisor-retirement', fixture.jobId, fixture.nonce, `${fixture.nonce}.json`)
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      receipt.terminalJournalDigest = createHash('sha256').update(raw).digest('hex')
      writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
      const recoveryInput = fixture.stageRevision('接続を復旧しました。同じ依頼を再開して')
      const continued = await fixture.call('investigation', recoveryInput)
      expect(continued.payload).toMatchObject({ reusedPriorPhase: true, retryable: true,
        attemptsFinished: false, inputRevision: fixture.revisionTwo.revision,
        inputDigest: fixture.revisionTwo.digest, scopeAssessmentRequired: true })
      const retry = await fixture.call('investigation', 'revision-two', 'adopted', 1, { retryUnavailable: true, inputUpdateIsRecoveryOnly: true })
      expect(retry.payload).toMatchObject({ complete: true, allAdopted: true })
      expect(retry.payload.grok).toEqual([savedGrok])
      expect(JSON.parse(readFileSync(`${armed.journalPath}.responses`, 'utf8')))
        .toMatchObject({ retryCount: 1, interruptionRecovery: true,
          recoveryInputRevision: recoveryInput.revision, recoveryInputDigest: recoveryInput.digest })
      expect(JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8')).prompt_count).toBe(1)
    } finally { await fixture.close() }
  }, 20_000)

  test.each(['startup', 'timeout', 'response'] as const)('終了済みClaude失敗を中断・再起動後にも保持する: %s', async cause => {
    const fixture = await brokerFixture()
    try {
      const nativeResponse = `solution response\n${nativeAdvisorMarker(fixture.nonce,
        fixture.revisionTwo.revision, fixture.revisionTwo.digest, 'investigation', 1, 'solution')}`
      const armed = armRetiredRequestedRound(fixture, fixture.revisionTwo, { version: 9, nativeResponse })
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
      const claude = { attempted: true, adopted: false, required: true, lifecycle: 'ephemeral-v2',
        workspaceCreationAttempted: true, freshEphemeral: true, cleanupVerified: true,
        cleanupStatus: 'closed-and-verified', cleanupReceiptDigest: 'a'.repeat(64),
        containmentVerified: true, promptMayHaveBeenDelivered: true,
        executionState: 'start-unconfirmed', reason: `original ${cause} failure`,
        failure: { advisor: 'claude', cause },
        responseDiagnostic: { status: 'saved', path: 'diagnostic.json', sha256: 'd'.repeat(64) } }
      const slots = { contextDigest: fixture.contextDigest, phase: 'investigation', round: 1,
        inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest,
        evidenceDigest: journal.primaryEvidenceDigest, claude }
      for (const invalid of [
        { ...slots, evidenceDigest: 'f'.repeat(64) },
        { ...slots, claude: { ...claude, cleanupVerified: false } },
        { ...slots, claude: { ...claude, containmentStatus: 'owned-process-still-live' } },
        { ...slots, claude: { ...claude, failure: { advisor: 'claude', cause: 'untrusted' } } },
      ]) {
        writeFileSync(`${armed.journalPath}.slots`, JSON.stringify(invalid), { mode: 0o600 })
        expect(readInterruptedAdvisorSlots(armed.journalPath, journal).claude).toBeUndefined()
      }
      writeFileSync(`${armed.journalPath}.slots`, JSON.stringify(slots), { mode: 0o600 })
      finalizeRetiredAdvisorRounds(fixture.state)
      const terminal = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
      expect(terminal.claude.failure).toEqual(claude.failure)
      expect(terminal.claude.responseDigest).toBeUndefined()
      expect(terminal.claude.responseDiagnostic).toEqual(claude.responseDiagnostic)
      expect(terminal.claude.reasonDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(terminal.claude.reason).toBeUndefined()
      // The terminal journal remains authoritative even if its optional slot
      // cache is no longer available after retirement.
      if (cause === 'timeout') rmSync(`${armed.journalPath}.slots`)
      const coverage = collectHostAdvisorCoverage(fixture.state, fixture.jobId, fixture.nonce, true)
      expect(coverage?.phases[0]?.failures).toContainEqual({ advisor: 'claude', cause })
      for (let restart = 0; restart < 2; restart++) {
        const result = await fixture.poll('investigation', 'revision-two')
        expect(result.payload.claude).toMatchObject({ adopted: false, failure: claude.failure,
          responseDiagnostic: claude.responseDiagnostic })
        expect(result.payload.slotSummary.responsesObtained).toBe(1)
        await fixture.restart()
      }
      if (cause === 'timeout') {
        const current = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
        current.startedAt -= 31_000
        current.finishedAt -= 31_000
        const raw = JSON.stringify(current)
        writeFileSync(armed.journalPath, raw, { mode: 0o600 })
        const receiptPath = join(fixture.state, 'advisor-retirement', fixture.jobId, fixture.nonce, `${fixture.nonce}.json`)
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
        receipt.terminalJournalDigest = createHash('sha256').update(raw).digest('hex')
        writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
        const retried = await fixture.call('investigation', 'revision-two', 'adopted', 1,
          { retryUnavailable: true, inputUpdateIsRecoveryOnly: true })
        expect(retried.payload.claude, JSON.stringify(retried.payload)).toMatchObject({ adopted: false, failure: claude.failure,
          responseDiagnostic: claude.responseDiagnostic })
        const after = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
        expect(after.claude.reasonDigest).toBe(terminal.claude.reasonDigest)
      }
    } finally { await fixture.close() }
  }, 20_000)

  test('再試行開始journalの保存直後に中断しても再利用Claudeの原因と診断を保持する', async () => {
    const fixture = await brokerFixture()
    try {
      const retainedClaude = { attempted: true, adopted: false, required: true, lifecycle: 'ephemeral-v2',
        workspaceCreationAttempted: true, freshEphemeral: true, cleanupVerified: true,
        cleanupStatus: 'closed-and-verified', cleanupReceiptDigest: 'c'.repeat(64),
        containmentVerified: true, promptMayHaveBeenDelivered: true,
        executionState: 'start-unconfirmed', reasonDigest: 'e'.repeat(64),
        failure: { advisor: 'claude', cause: 'timeout' },
        responseDiagnostic: { status: 'saved', path: 'diagnostic.json', sha256: 'd'.repeat(64) } }
      const armed = armRetiredRequestedRound(fixture, fixture.revisionTwo,
        { version: 9, persistClaudeOutcome: false, retainedClaude })
      persistAdvisorClaudeCleanupOutcome(fixture.state, {
        jobId: fixture.jobId, attemptNonce: fixture.nonce,
        inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest,
        inputDigestPrefix: fixture.revisionTwo.digest.slice(0, 16), phase: 'investigation', round: 1,
        workspaceCreationAttempted: true, freshEphemeral: true, cleanupVerified: true,
        cleanupStatus: 'closed-and-verified', cleanupReceiptDigest: 'c'.repeat(64),
        promptMayHaveBeenDelivered: true,
      })
      expect(existsSync(`${armed.journalPath}.slots`)).toBe(false)
      finalizeRetiredAdvisorRounds(fixture.state)
      expect(JSON.parse(readFileSync(armed.journalPath, 'utf8')).claude).toEqual(retainedClaude)
      await fixture.restart()
      expect((await fixture.poll('investigation', 'revision-two')).payload.claude)
        .toMatchObject({ failure: retainedClaude.failure, responseDiagnostic: retainedClaude.responseDiagnostic })
    } finally { await fixture.close() }
  }, 20_000)

  test('古い未送達失敗cacheが再試行の送達可能性を上書きしない', async () => {
    const fixture = await brokerFixture()
    try {
      const armed = armRetiredRequestedRound(fixture, fixture.revisionTwo,
        { version: 9, persistClaudeOutcome: false })
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
      writeFileSync(`${armed.journalPath}.slots`, JSON.stringify({
        contextDigest: fixture.contextDigest, phase: 'investigation', round: 1,
        inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest,
        evidenceDigest: journal.primaryEvidenceDigest,
        claude: { attempted: true, adopted: false, required: true, lifecycle: 'ephemeral-v2',
          workspaceCreationAttempted: false, freshEphemeral: false, cleanupVerified: false,
          containmentVerified: true, promptMayHaveBeenDelivered: false,
          executionState: 'unavailable-before-start', reason: 'first startup failed',
          failure: { advisor: 'claude', cause: 'startup' } },
      }), { mode: 0o600 })
      persistAdvisorClaudeCleanupOutcome(fixture.state, {
        jobId: fixture.jobId, attemptNonce: fixture.nonce,
        inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest,
        inputDigestPrefix: fixture.revisionTwo.digest.slice(0, 16), phase: 'investigation', round: 1,
        workspaceCreationAttempted: true, freshEphemeral: true, cleanupVerified: true,
        cleanupStatus: 'closed-and-verified', cleanupReceiptDigest: 'c'.repeat(64),
        promptMayHaveBeenDelivered: true,
      })
      finalizeRetiredAdvisorRounds(fixture.state)
      const terminal = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
      expect(terminal.claude).toMatchObject({ promptMayHaveBeenDelivered: true,
        cleanupReceiptDigest: 'c'.repeat(64), adopted: false })
      expect(readInterruptedAdvisorSlots(armed.journalPath, terminal).claude).toBeUndefined()
      await fixture.restart()
      const polled = await fixture.poll('investigation', 'revision-two')
      expect(polled.payload.claude).toMatchObject({ promptMayHaveBeenDelivered: true,
        cleanupReceiptDigest: 'c'.repeat(64), failure: { cause: 'interrupted' } })
    } finally { await fixture.close() }
  }, 20_000)

  test.each(['claude', 'both', 'both-current', 'wrong-binding'] as const)('中断時の保存回答を通常pollで回収する: %s', async saved => {
    const fixture = await brokerFixture()
    try {
      const armed = armRetiredRequestedRound(fixture, fixture.revisionTwo, { version: 9 })
      if (saved !== 'both-current') finalizeRetiredAdvisorRounds(fixture.state)
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
      const both = saved === 'both' || saved === 'both-current'
      const claude = { attempted: true, adopted: true, required: true, lifecycle: 'ephemeral-v2',
        workspaceCreationAttempted: true, freshEphemeral: true, cleanupVerified: true,
        cleanupStatus: 'closed-and-verified', cleanupReceiptDigest: 'a'.repeat(64),
        containmentVerified: true, promptMayHaveBeenDelivered: true,
        executionState: 'response-obtained', response: 'saved Claude answer' }
      const grok = [{ attempted: true, adopted: true, containmentVerified: true,
        perspective: 'solution', executionState: 'response-obtained', processId: 42424,
        response: 'saved Grok answer' }]
      writeFileSync(`${armed.journalPath}.slots`, JSON.stringify({
        contextDigest: fixture.contextDigest, phase: 'investigation', round: 1,
        inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest,
        evidenceDigest: saved === 'wrong-binding' ? 'f'.repeat(64) : journal.primaryEvidenceDigest,
        claude, ...(both ? { grok } : {}),
      }), { mode: 0o600 })
      if (saved === 'both-current') {
        finalizeRetiredAdvisorRounds(fixture.state)
        const terminal = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
        expect(terminal.claude.adopted).toBe(true)
        expect(terminal.grok[0].adopted).toBe(true)
      }
      const latest = saved === 'both-current' ? fixture.revisionTwo : fixture.stageRevision('別の質問も確認してください')
      if (saved === 'both-current') {
        const first = await fixture.poll('investigation', 'revision-two')
        expect(first.payload.receiptRequired).toBe(true)
        await fixture.restart()
      }
      const result = saved === 'both-current'
        ? await fixture.poll('investigation', 'revision-two')
        : await fixture.call('investigation', 'revision-two')
      expect(result.payload).toMatchObject({
        ...(saved === 'both-current' ? { restoredSavedResponses: true } : {
          recoveredAfterInterruption: true, retryable: !both,
          scopeAssessmentRequired: true, currentInputRevision: latest.revision,
        }),
        inputUnchanged: saved === 'both-current',
        slotSummary: { responsesObtained: both ? 3 : saved === 'claude' ? 2 : 1 } })
      expect(result.payload.complete).toBe(saved === 'both-current')
      expect(result.payload.claude.adopted).toBe(saved !== 'wrong-binding')
      const coverage = collectHostAdvisorCoverage(fixture.state, fixture.jobId, fixture.nonce, true)
      expect(coverage?.phases[0]?.responsesObtained).toBe(both ? 3 : saved === 'claude' ? 2 : 1)
      expect(coverage?.phases[0]?.failures?.every(f => f.cause === 'interrupted')).toBe(true)
      expect(existsSync(armed.lockPath)).toBe(false)
    } finally { await fixture.close() }
  }, 15_000)

  test('中断を繰り返しても同一roundのdurable復旧上限を新入力で解除しない', async () => {
    const fixture = await brokerFixture()
    try {
      const armed = armRetiredRequestedRound(fixture, fixture.revisionTwo, { version: 9 })
      finalizeRetiredAdvisorRounds(fixture.state)
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
      journal.retryCount = 3
      const raw = JSON.stringify(journal)
      writeFileSync(armed.journalPath, raw, { mode: 0o600 })
      const receiptPath = join(fixture.state, 'advisor-retirement', fixture.jobId, fixture.nonce, `${fixture.nonce}.json`)
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      receipt.terminalJournalDigest = createHash('sha256').update(raw).digest('hex')
      writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
      fixture.stageRevision('同じ依頼を続けて')
      const retried = await fixture.call('investigation', 'revision-two', 'adopted', 1,
        { retryUnavailable: true, inputUpdateIsRecoveryOnly: true })
      expect(retried.payload).toMatchObject({ interrupted: true, retryable: false,
        attemptsFinished: true, retryBudgetExhausted: true })
      expect(existsSync(armed.lockPath)).toBe(false)
    } finally { await fixture.close() }
  }, 15_000)

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

  test('retirement後の置換lockは削除せず、終了済み試行の再起動もしない', async () => {
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
        claude: { failure: { advisor: 'claude', cause: 'interrupted' } },
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

  test('送達済みClaudeの中断原因を復旧後も保持し再送しない', async () => {
    const fixture = await brokerFixture({ externalSuccess: true })
    try {
      const nativeResponse = `solution response\n${nativeAdvisorMarker(fixture.nonce,
        fixture.revisionTwo.revision, fixture.revisionTwo.digest, 'investigation', 1, 'solution')}`
      const armed = armRetiredRequestedRound(fixture, fixture.revisionTwo,
        { version: 9, nativeResponse, persistClaudeOutcome: false })
      persistAdvisorClaudeCleanupOutcome(fixture.state, {
        jobId: fixture.jobId, attemptNonce: fixture.nonce,
        inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest,
        inputDigestPrefix: fixture.revisionTwo.digest.slice(0, 16), phase: 'investigation', round: 1,
        workspaceCreationAttempted: true, freshEphemeral: true, cleanupVerified: true,
        cleanupStatus: 'closed-and-verified', cleanupReceiptDigest: 'c'.repeat(64),
        promptMayHaveBeenDelivered: true,
      })
      expect(finalizeRetiredAdvisorRounds(fixture.state)).toEqual({ finalized: 1 })
      const recovered = await fixture.call('investigation', 'revision-two')
      expect(recovered.payload).toMatchObject({ claude: {
        promptMayHaveBeenDelivered: true, failure: { advisor: 'claude', cause: 'interrupted' },
      } })
      const journal = JSON.parse(readFileSync(armed.journalPath, 'utf8'))
      journal.startedAt -= 31_000
      journal.finishedAt -= 31_000
      const raw = JSON.stringify(journal)
      writeFileSync(armed.journalPath, raw, { mode: 0o600 })
      const receiptPath = join(fixture.state, 'advisor-retirement', fixture.jobId, fixture.nonce, `${fixture.nonce}.json`)
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      receipt.terminalJournalDigest = createHash('sha256').update(raw).digest('hex')
      writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
      const retried = await fixture.call('investigation', 'revision-two', 'adopted', 1,
        { retryUnavailable: true, inputUpdateIsRecoveryOnly: true })
      expect(retried.payload.claude).toMatchObject({
        promptMayHaveBeenDelivered: true, failure: { advisor: 'claude', cause: 'interrupted' },
      })
      expect(JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8')).prompt_count).toBe(0)
      await fixture.restart()
      const polled = await fixture.call('investigation', 'revision-two')
      expect(polled.payload.claude).toMatchObject({ failure: { advisor: 'claude', cause: 'interrupted' } })
    } finally { await fixture.close() }
  }, 20_000)

  test('Claudeは末尾が完全一致の空promptだけreadyと判定する', () => {
    expect(emptyClaudePrompt('previous output\n❯\n')).toBe(true)
    // Claude Code 2.1.27x は空の入力行に薄いプレースホルダを重ね、区切りに NBSP を使う
    // （2026-09-16 に v2.1.273 実機で採取: '❯\u00a0Try "fix lint errors"'）。
    // プレースホルダは入力が空のときにしか表示されないので、これも空として扱う。
    expect(emptyClaudePrompt('previous output\n❯\u00a0Try "fix lint errors"\n')).toBe(true)
    expect(emptyClaudePrompt('previous output\n❯ Try "explain this codebase"\n')).toBe(true)
    expect(emptyClaudePrompt('previous output\n❯ Try "fix lint errors" draft\n')).toBe(false)
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

    // Claude Code 2.1.273 は回答完了後の空プロンプトにプレースホルダを重ね、
    // 区切りに NBSP を使う（'❯\u00a0Try "fix lint errors"'、2026-09-16 実機採取）。
    // これを端末装飾として認めないと、完全な回答が届いていても
    // 「complete marked response was unavailable」で全滅する。
    expect(extractCompleteClaudeResponse([
      '依頼本文',
      '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      marker,
      '独立したレビュー結果です。',
      marker,
      '\u2500\u2500\u2500\u2500',
      '❯\u00a0Try "fix lint errors"',
      '\u2500\u2500\u2500\u2500',
      '⏵⏵ bypass permissions on',
    ].join('\n'), marker)).toBe('独立したレビュー結果です。')

    // 2.1.273 の footer は「· ← for agents」で終わり、末尾の /rc が無い
    // （2026-09-16 に tmux 実描画から採取。旧regexは /rc 必須で全滅していた）。
    expect(extractCompleteClaudeResponse([
      '依頼本文',
      '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      marker,
      '⏺ 2',
      marker,
      '✻ Churned for 1s · done 18:09',
      '\u2500\u2500\u2500\u2500',
      '❯',
      '\u2500\u2500\u2500\u2500',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n'), marker)).toBe('⏺ 2')

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
    ].join('\n'), marker)).toBe('途中回答です。')

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
      ].join('\n'), marker)).toBe('回答です。')
    }
  })

  test('実測狭幅prompt echoはinstructionとmarkerの折返しを独立して採択する', () => {
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
    }), marker)).toBe(response)
    expect(extractCompleteClaudeResponse(envelope({
      prompt: [instruction, markerHead, markerTail],
    }), marker)).toBe(response)
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
      .toBe(response)
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


test('送信stdout喪失は同じreceipt markerへ復旧しjournal障害でも取得を続ける', () => {
  const marker = `REQUEST_MARKER=${'A'.repeat(32)}`
  for (const stdout of ['', JSON.stringify({ status: 'prompt-started', marker, state_change_seq: 42 })]) {
    const warnings: unknown[] = []
    const outcome = recoverFifthAdvisorSendOutcome(stdout, () => ({ marker, stateChangeSeq: 42 }),
      () => { throw new Error('fsync failed') }, error => warnings.push(error))
    expect(outcome).toMatchObject({ kind: 'possibly-delivered', marker, stateChangeSeq: 42 })
    expect(warnings).toHaveLength(1)
  }
  expect(recoverFifthAdvisorSendOutcome('', () => undefined,
    () => { throw new Error('must not persist absent receipt') }, () => {}))
    .toEqual({ kind: 'unconfirmed' })
})

test('live processの証拠を後続の診断・close・監査失敗で弱めない', () => {
  let status: string | undefined
  for (const error of [new AdvisorOwnedProcessStillLiveError('observed live'),
    new AdvisorContainmentError('diagnostic unavailable'), new Error('close unavailable'),
    new Error('audit unavailable')]) {
    status = claudeContainmentFailureStatus(status, error)
    expect(status).toBe('owned-process-still-live')
  }
  expect(claudeContainmentFailureStatus(undefined, new Error('unverified')))
    .toBe('unverified-bounded-residual')
})


test('native request登録はMCP再起動を跨いで同じ依頼・identityを返す', async () => {
  const fixture = await brokerFixture()
  try {
    const stale = await fixture.prepareNative(fixture.revisionOne)
    expect(stale.staleInput).toBe(true)
    const first = await fixture.prepareNative()
    expect(first.taskName).toMatch(/^zero_native_[a-f0-9]{32}$/)
    expect(first.prompt).toContain(String(first.marker))
    await fixture.restart()
    const restored = await fixture.prepareNative()
    expect(restored).toEqual(first)
  } finally { await fixture.close() }
}, 30_000)


test('追加指示後も登録済みGPT回答の元のbindingを保存し再起動後も取得済みと扱う', async () => {
  const fixture = await brokerFixture({ externalSuccess: true })
  try {
    const registered = await fixture.prepareNative()
    const newer = fixture.stageRevision('追加の受入条件。元のレビュー回答も保持する。')
    const preparedAgain = await fixture.prepareNative(newer)
    expect(preparedAgain.marker).toBe(registered.marker)
    const answer = `Original independent findings.\n${registered.marker}`
    const { result, payload } = await fixture.call('investigation', newer, 'adopted', 1, {
      nativeAgentId: String(registered.agentPath), nativeResponse: answer,
    })
    expect(result.isError).not.toBe(true)
    expect(payload).toMatchObject({ allAdopted: true, scopeAssessmentRequired: true,
      inputRevision: newer.revision, slotSummary: { responsesObtained: 3 },
      native: [{ adopted: true, inputRevision: fixture.revisionTwo.revision,
        inputDigest: fixture.revisionTwo.digest, responseDigest: nativeAdvisorResponseDigest(answer) }] })
    await fixture.restart()
    const restored = await fixture.call('investigation', newer, 'adopted', 1, {
      nativeAgentId: String(registered.agentPath), nativeResponse: answer,
    })
    expect(restored.payload).toMatchObject({ allAdopted: true, scopeAssessmentRequired: true,
      native: [{ inputRevision: fixture.revisionTwo.revision, inputDigest: fixture.revisionTwo.digest }] })
  } finally { await fixture.close() }
}, 30_000)

test('登録済みGPT回答を新しい入力markerへ書き換えて渡した場合は採択しない', async () => {
  const fixture = await brokerFixture()
  try {
    await fixture.prepareNative()
    const newer = fixture.stageRevision('別の要件を追加')
    const result = await fixture.call('investigation', newer)
    expect(result.result.isError).toBe(true)
    expect(result.payload.reason).toContain('round marker')
  } finally { await fixture.close() }
}, 30_000)


test('同じClaudeの接続確認が連続失敗しても再送やcloseをせず完全回答を回収する', async () => {
  const fixture = await brokerFixture({ externalSuccess: true })
  try {
    const path = fixture.externalEvidence!.fakeHerdrState
    const initial = JSON.parse(readFileSync(path, 'utf8'))
    initial.connection_failures = 4
    writeFileSync(path, JSON.stringify(initial), { mode: 0o600 })
    const result = await fixture.call('investigation', 'revision-two')
    expect(result.payload).toMatchObject({ allAdopted: true, claude: { adopted: true, cleanupVerified: true } })
    const final = JSON.parse(readFileSync(path, 'utf8'))
    expect(final.connection_failures).toBe(0)
    expect(final.prompt_count).toBe(1)
    expect(final.close_count).toBe(1)
    expect(final.owned).toBe(false)
  } finally { await fixture.close() }
}, 60_000)

test('Claude認証確認は未loginから回復するまで再確認しloginやpromptは送らない', async () => {
  const root = fixtureDir()
  const executable = join(root, 'claude')
  const marker = join(root, 'ready')
  const calls = join(root, 'calls')
  writeFileSync(executable, '#!/usr/bin/python3\nimport os,sys,time\ntime.sleep(0.2)\nassert sys.argv[1:] == ["auth","status","--json"]\nwith open(' + JSON.stringify(calls) + ',"a") as f: f.write("check\\n")\nprint(\'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\' if os.path.exists(' + JSON.stringify(marker) + ') else \'{"loggedIn":false}\')\n', { mode: 0o700 })
  let waits = 0
  await waitForClaudeSubscriptionLogin({ ...brokerEnvironment(), ZEROKUN_CLAUDE_BIN_PATH: executable }, {
    wait: async () => { if (++waits === 4) writeFileSync(marker, 'ready') },
  })
  expect(waits).toBe(4)
  expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(5)
}, 15_000)


test('blocked状態の両画面読取りが連続失敗しても接続回復まで同じClaudeを保持する', async () => {
  const fixture = await brokerFixture({ externalSuccess: true, claudeBlocked: true })
  try {
    const path = fixture.externalEvidence!.fakeHerdrState
    const initial = JSON.parse(readFileSync(path, 'utf8'))
    initial.failure_screen_failures = 8
    writeFileSync(path, JSON.stringify(initial), { mode: 0o600 })
    const result = await fixture.call('investigation', 'revision-two')
    expect(result.payload).toMatchObject({ allAdopted: true, claude: { adopted: true, cleanupVerified: true } })
    const final = JSON.parse(readFileSync(path, 'utf8'))
    expect(final.failure_screen_failures).toBe(0)
    expect(final.prompt_count).toBe(1)
    expect(final.close_count).toBe(1)
  } finally { await fixture.close() }
}, 60_000)


test('未loginの待機理由をpollへ返し、認証回復後に同じroundだけを開始する', async () => {
  const ready = join(fixtureDir(), 'authenticated')
  let notified = false
  const fixture = await brokerFixture({ externalSuccess: true, claudeAuthReadyFile: ready,
    onPendingResult: payload => {
      if (!payload.waitingForAuthentication) return
      expect(payload.waitingForAuthentication).toContainEqual(expect.objectContaining({ advisor: 'claude', cause: 'authentication' }))
      const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
      expect(state.prompt_count).toBe(0)
      expect(state.owned).toBe(false)
      notified = true
      writeFileSync(ready, 'synthetic readiness', { mode: 0o600 })
    },
  })
  try {
    expect((await fixture.call('investigation', 'revision-two')).payload).toMatchObject({ allAdopted: true })
    expect(notified).toBe(true)
    const state = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
    expect(state.prompt_count).toBe(1)
    expect(state.close_count).toBe(1)
  } finally { await fixture.close() }
}, 60_000)


test('blockedの主読取りtimeoutをfallback読取りの非対応errorで上書きしない', async () => {
  const fixture = await brokerFixture({ externalSuccess: true, claudeBlocked: true })
  try {
    const path = fixture.externalEvidence!.fakeHerdrState
    const initial = JSON.parse(readFileSync(path, 'utf8'))
    initial.failure_screen_failures = 3
    initial.visible_read_error = 'invalid_params'
    writeFileSync(path, JSON.stringify(initial), { mode: 0o600 })
    expect((await fixture.call('investigation', 'revision-two')).payload).toMatchObject({ allAdopted: true })
    const final = JSON.parse(readFileSync(path, 'utf8'))
    expect(final.failure_screen_failures).toBe(0)
    expect(final.prompt_count).toBe(1)
    expect(final.close_count).toBe(1)
  } finally { await fixture.close() }
}, 60_000)

test('認証待ち後の終端設定errorはGrok待機中のpollへ古い認証待ちを残さない', async () => {
  const ready = join(fixtureDir(), 'authenticated')
  let notified = false, cleared = false
  const fixture = await brokerFixture({ externalSuccess: true, claudeAuthReadyFile: ready,
    claudeAuthConfigurationAfterReady: true, grokDelaySeconds: 45,
    onPendingResult: payload => {
      if (payload.waitingForAuthentication) {
        notified = true
        writeFileSync(ready, 'synthetic readiness', { mode: 0o600 })
      } else if (notified) cleared = true
    },
  })
  try {
    expect((await fixture.call('investigation', 'revision-two')).payload).toMatchObject({
      claude: { adopted: false, failure: { cause: 'configuration' } },
    })
    expect(notified).toBe(true)
    expect(cleared).toBe(true)
    const final = JSON.parse(readFileSync(fixture.externalEvidence!.fakeHerdrState, 'utf8'))
    expect(final.prompt_count).toBe(0)
    expect(final.owned).toBe(false)
  } finally { await fixture.close() }
}, 65_000)
