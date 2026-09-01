import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import {
  JobStore,
  publishStagedGitHubPublication,
  type JobRecord,
} from './job-runner.ts'
import {
  captureGitHubPublicationBaseline,
  captureGitHubPublicationBaselineForBranches,
  publishGitHubPlan,
  type GitHubPublicationCommands,
  type PublicationCommandResult,
} from './github-publication.ts'
import {
  CodexCleanupPendingError,
  CodexPublicationPreflightRetryError,
  CodexRateLimitError,
  CodexUserCancelledError,
  executeCodexJob,
  type CodexLiveControlHooks,
} from './codex-executor.ts'
import {
  nativeAdvisorMarker,
  nativeAdvisorResponseDigest,
  type NativeAdvisorRoundEvidence,
} from './native-advisor-evidence.ts'
import {
  createDurableThreadHistorySnapshot,
  createThreadHistoryArchive,
} from './thread-history.ts'
import { prepareManagedStateRoot } from './managed-path.ts'
import { readAdvisorInputSnapshot } from './advisor-input.ts'
import {
  advisorRepositoryDigest,
  advisorRepositoryScopeDigest,
  resolveAdvisorProjectLayout,
  snapshotAdvisorRepository,
} from './advisor-snapshot.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function secureRoot(): string {
  const root = mkdtempSync(join(homedir(), '.zero-app-server-executor-'))
  chmodSync(root, 0o700)
  roots.push(root)
  return root
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['/usr/bin/git', '-C', cwd, ...args], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: {
      PATH: '/usr/bin:/bin', HOME: '/', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function publicationCommandResult(
  exitCode: number,
  stdout = '',
  stderr = '',
): PublicationCommandResult {
  return { exitCode, stdout, stderr }
}

function completeFixtureJob(
  store: JobStore,
  job: JobRecord,
  sessionId: string,
  result: string,
): void {
  if (!job.writeEnabled) {
    store.complete(job.id, sessionId, result)
    return
  }
  if (!store.hasStagedExecution(job.id)) {
    const input = readAdvisorInputSnapshot(dirname(store.dbPath), job.id)
    store.ensureExecutionResultStaged(job.id, sessionId, result, {
      version: 1,
      jobId: job.id,
      jobAttempt: job.attempts,
      logicalNonce: '0'.repeat(32),
      inputRevision: input.revision,
      inputDigest: input.digest,
      reviewRound: 1,
      reviewedRepositoryDigest: createHash('sha256').update('fixture-review').digest('hex'),
      baselineDigest: createHash('sha256').update('fixture-baseline').digest('hex'),
      plans: [],
    })
  }
  store.completeStagedExecution(job.id)
}

function cleanupGatePaths(stateDir: string, supervisorPid: number): {
  ready: string
  release: string
} {
  const base = join(stateDir, `.test-cleanup-gate-${supervisorPid}`)
  return { ready: `${base}.ready`, release: `${base}.release` }
}

async function waitForCleanupGate(
  stateDir: string,
  processIds: number[],
  index: number,
): Promise<{ ready: string, release: string }> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const processId = processIds[index]
    if (processId !== undefined) {
      const paths = cleanupGatePaths(stateDir, processId)
      if (existsSync(paths.ready)) return paths
    }
    await Bun.sleep(10)
  }
  throw new Error(`supervisor cleanup gate ${index} did not become ready`)
}

function releaseCleanupGate(paths: { ready: string, release: string }): void {
  if (!existsSync(paths.ready) || existsSync(paths.release)) return
  writeFileSync(paths.release, '', { mode: 0o600, flag: 'wx' })
}

async function waitForPath(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10)
  if (!existsSync(path)) throw new Error(`test path did not appear: ${path}`)
}

async function waitForRpcMethod(path: string, method: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      if (rows.some(line => JSON.parse(line).method === method)) return
    }
    await Bun.sleep(10)
  }
  throw new Error(`RPC method did not appear: ${method}`)
}

async function waitForInterjectionNotification(
  store: JobStore,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const notification = store.pendingInterjectionNotifications()[0]
    if (notification) return notification
    await Bun.sleep(10)
  }
  throw new Error('interjection notification did not become pending')
}

function fakeCodex(root: string): string {
  const executable = join(root, 'codex-fixture')
  writeFileSync(executable, `#!/usr/bin/python3
import json
import hashlib
import os
import re
import signal
import subprocess
import sys
import time

mode = os.environ.get("ZERO_FIXTURE_MODE", "normal")
if mode in ("interrupt-no-terminal-forced", "late-error-after-complete"):
    signal.signal(signal.SIGTERM, lambda _signum, _frame: None)
if mode == "logical-stop-required":
    def logical_stop(_signum, _frame):
        with open(os.environ["ZERO_LOGICAL_STOP_MARKER"], "w", encoding="utf-8") as stream:
            stream.write("term")
        sys.exit(0)
    signal.signal(signal.SIGTERM, logical_stop)
thread_id = "thread-app-server-1"
turn_id = "turn-app-server-1"
turn_count = 0
stage = "complete"
developer_instructions = ""
handshake_method = ""
requested_thread = None
handshake_cwd = ""
permission_profile = ""
steer_client_id = None
progress_probe_count = 0
persisted_items = {}

def observe_emission(value):
    method = value.get("method")
    params = value.get("params", {})
    if method == "turn/started":
        observed_turn = params.get("turn", {})
        observed_turn_id = observed_turn.get("id")
        if observed_turn_id:
            persisted_items[observed_turn_id] = []
    elif method == "item/completed":
        observed_turn_id = params.get("turnId")
        observed_item = params.get("item")
        if observed_turn_id and isinstance(observed_item, dict):
            persisted_items.setdefault(observed_turn_id, []).append(observed_item)
    elif method == "turn/completed":
        observed_turn = params.get("turn", {})
        observed_turn_id = observed_turn.get("id")
        terminal_items = observed_turn.get("items", [])
        if observed_turn_id and terminal_items:
            persisted_items[observed_turn_id] = list(terminal_items)

def emit(value):
    observe_emission(value)
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

def emit_batch(values):
    for value in values:
        observe_emission(value)
    sys.stdout.write("".join(json.dumps(value, ensure_ascii=False) + "\\n" for value in values))
    sys.stdout.flush()

for line in sys.stdin:
    value = json.loads(line)
    method = value.get("method")
    request_id = value.get("id")
    rpc_log = os.environ.get("ZERO_RPC_LOG")
    log_handshakes = os.environ.get("ZERO_LOG_HANDSHAKES") == "1"
    if rpc_log and (method in ("turn/start", "turn/steer", "turn/interrupt", "thread/turns/list", "thread/read", "thread/items/list", "thread/list") or (log_handshakes and method in ("thread/start", "thread/resume"))):
        params = value.get("params", {})
        with open(rpc_log, "a", encoding="utf-8") as stream:
            stream.write(json.dumps({"method": method, "requestId": request_id, "clientUserMessageId": params.get("clientUserMessageId"), "expectedTurnId": params.get("expectedTurnId")}, ensure_ascii=False) + "\\n")
    if method == "initialized":
        continue
    if method == "initialize":
        if mode == "hang-initialize":
            with open(os.environ["ZERO_BLOCKED_MARKER"], "w", encoding="utf-8") as stream:
                stream.write("initialize")
            while True:
                time.sleep(30)
        emit({"id": request_id, "result": {"userAgent": "fixture", "codexHome": "/tmp/codex-home", "platformFamily": "unix", "platformOs": "macos"}})
    elif method in ("thread/start", "thread/resume"):
        params = value.get("params", {})
        if mode == "missing-session-resume" and method == "thread/resume" and params.get("threadId") == "thread-provider-missing":
            emit({"id": request_id, "error": {"code": -32001, "message": "thread not found"}})
            continue
        requested = params.get("threadId")
        cwd = params.get("cwd")
        model = params.get("model") or "gpt-test"
        developer_instructions = params.get("developerInstructions") or ""
        handshake_method = method
        requested_thread = requested
        handshake_cwd = cwd
        permission_profile = params.get("permissions") or ""
        emit({"id": request_id, "result": {"thread": {"id": requested or thread_id, "cwd": cwd, "source": "unknown", "modelProvider": "openai", "status": {"type": "idle"}, "canAcceptDirectInput": True}, "model": model, "modelProvider": "openai", "cwd": cwd, "approvalPolicy": "never", "activePermissionProfile": {"id": params.get("permissions"), "extends": None}, "instructionSources": [cwd + "/AGENTS.md"]}})
    elif method == "turn/start":
        if mode == "hang-turn-start":
            with open(os.environ["ZERO_BLOCKED_MARKER"], "w", encoding="utf-8") as stream:
                stream.write("turn/start")
            while True:
                time.sleep(30)
        turn_params = value.get("params", {})
        if turn_params.get("cwd") != handshake_cwd or turn_params.get("permissions") != permission_profile or turn_params.get("approvalPolicy") != "never":
            emit({"id": request_id, "error": {"code": -32000, "message": "turn permission binding mismatch"}})
            continue
        turn_count += 1
        prompt_items = turn_params.get("input", [])
        phase_prompt = prompt_items[0].get("text", "") if prompt_items else ""
        client_user_message_id = turn_params.get("clientUserMessageId") or ""
        is_legacy_continuation = ":phase:" in client_user_message_id and mode in (
            "defer", "terminal-race",
        )
        if "Zero host interjection response control" in phase_prompt:
            stage = "interjection"
        elif "Host phase: read-only preparation." in phase_prompt:
            stage = "prepare"
        elif "Host phase: write implementation." in phase_prompt:
            stage = "implementation"
        elif "Host phase: read-only review round" in phase_prompt:
            stage = "review"
        else:
            stage = "complete"
        argv_text = "\\n".join(sys.argv[1:])
        repo_access = "write" if json.dumps(handshake_cwd) + '=\\"write\\"' in argv_text else "read"
        phase_log = os.environ.get("ZERO_PHASE_LOG")
        if phase_log and turn_count == 1:
            with open(phase_log, "a", encoding="utf-8") as stream:
                stream.write(stage + "\\t" + str(os.getpid()) + "\\t" + (requested_thread or thread_id) + "\\t" + handshake_method + "\\t" + repo_access + "\\t" + permission_profile + "\\t" + hashlib.sha256(developer_instructions.encode("utf-8")).hexdigest() + "\\n")
        prompt_log = os.environ.get("ZERO_PROMPT_LOG")
        if prompt_log and turn_count == 1:
            with open(prompt_log, "a", encoding="utf-8") as stream:
                stream.write(json.dumps({"stage": stage, "text": phase_prompt}, ensure_ascii=False) + "\\n")
        unique_turn = mode in ("phased", "phased-publication", "phased-publication-targeted", "phased-promotion", "phased-promotion-history-failed", "phased-no-change", "phased-ui-approved", "phased-capacity-review-once", "phased-capacity-implementation-once", "phased-review-fix-three-times", "phased-reprepare-after-review-fix", "phased-native-history-fresh", "phased-native-history-resume", "phased-native-history-resume-unmaterialized", "phased-steer", "phased-late-inbound", "phased-interjection-update", "missing-session-resume", "interjection-answer", "interjection-update", "interjection-late-answer") or is_legacy_continuation
        turn_id = "turn-app-server-" + (stage + "-" + str(os.getpid()) + "-" + str(turn_count) if unique_turn else str(turn_count))
        active_turn = {"id": turn_id, "status": "inProgress", "itemsView": "full", "items": [], "error": None}
        if mode == "terminal-cancel-race":
            emit_batch([
                {"id": request_id, "result": {"turn": active_turn}},
                {"method": "turn/started", "params": {"threadId": requested_thread or thread_id, "turn": active_turn}},
                {"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": "通常完了"}], "error": None}}},
            ])
            continue
        emit({"id": request_id, "result": {"turn": active_turn}})
        emit({"method": "turn/started", "params": {"threadId": requested_thread or thread_id, "turn": active_turn}})
        turn_latch_stage = os.environ.get("ZERO_TURN_LATCH_STAGE")
        if turn_latch_stage == stage:
            turn_latch_ready = os.environ["ZERO_TURN_LATCH_READY"]
            turn_latch_release = os.environ["ZERO_TURN_LATCH_RELEASE"]
            with open(turn_latch_ready, "x", encoding="utf-8") as stream:
                stream.write(stage)
            while not os.path.exists(turn_latch_release):
                time.sleep(0.01)
        fixture_state = os.environ.get("ZERO_INTERJECTION_FIXTURE_STATE")
        if is_legacy_continuation:
            continuation_answers = {
                "defer": "次ターンで追加入力を反映しました",
                "terminal-race": "次ターンで追加入力を反映しました",
            }
            emit({"method": "turn/completed", "params": {"threadId": requested_thread or thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "id": "continued-final", "text": continuation_answers[mode]}], "error": None}}})
        elif mode in ("interjection-answer", "interjection-update", "interjection-late-answer", "phased-interjection-update") and stage == "interjection":
            disposition = "answer-only" if mode in ("interjection-answer", "interjection-late-answer") else "task-update"
            marker = re.search(r"\\[ZERO_THREAD_REPLY_BEGIN:([^:\\]]+):<answer-only\\|task-update>\\]", phase_prompt)
            interjection_id = marker.group(1) if marker else "missing"
            answer = "PDF処理はそのまま続いています 🔎" if disposition == "answer-only" else "追加条件を取り込んで続けます 🛠️"
            message = "[ZERO_THREAD_REPLY_BEGIN:" + interjection_id + ":" + disposition + "]\\n" + answer + "\\n[ZERO_THREAD_REPLY_END:" + interjection_id + "]"
            if fixture_state:
                with open(fixture_state, "w", encoding="utf-8") as stream:
                    stream.write(disposition)
            emit({"method": "turn/completed", "params": {"threadId": requested_thread or thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "id": "interjection-answer", "text": message}], "error": None}}})
        elif mode in ("interjection-answer", "interjection-update"):
            if fixture_state and os.path.exists(fixture_state):
                final = "追加条件を反映して完了しました" if mode == "interjection-update" else "元の作業を完了しました"
                emit({"method": "turn/completed", "params": {"threadId": requested_thread or thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "id": "resumed-final", "text": final}], "error": None}}})
        elif mode in ("phased", "phased-publication", "phased-publication-targeted", "phased-promotion", "phased-promotion-history-failed", "phased-no-change", "phased-ui-approved", "phased-capacity-review-once", "phased-capacity-implementation-once", "phased-review-fix-three-times", "phased-reprepare-after-review-fix", "phased-native-history-fresh", "phased-native-history-resume", "phased-native-history-resume-unmaterialized", "phased-steer", "phased-late-inbound", "phased-interjection-update", "missing-session-resume"):
            if stage == "prepare":
                marker = re.search(r"\\[ZERO_PRE_EDIT_READY:[0-9a-f]{32}:r[0-9]+:[0-9a-f]{64}\\]", phase_prompt)
                action = '<zerokun_work_action>{"kind":"implement","targets":[{"repository":".","baseBranch":"main","mergePullRequest":false,"followupBaseBranch":null}]}</zerokun_work_action>'
                if mode == "phased-reprepare-after-review-fix" and not os.path.exists(os.environ["ZERO_REVIEW_FIXTURE_STATE"]):
                    action = '<zerokun_work_action>{"kind":"no-change"}</zerokun_work_action>'
                if mode == "phased-publication-targeted":
                    action = '<zerokun_work_action>{"kind":"implement","targets":[{"repository":".","baseBranch":"develop","mergePullRequest":true,"followupBaseBranch":"main","waitForChecks":false,"integrationPullRequestBody":"## Summary","followupPullRequestBody":"## Summary","closePullRequestNumbers":[]}]}</zerokun_work_action>'
                if mode == "phased-no-change":
                    action = '<zerokun_work_action>{"kind":"no-change"}</zerokun_work_action>'
                message = "準備完了\\n" + action + "\\n" + (marker.group(0) if marker else "[ZERO_PRE_EDIT_READY:missing:r1:missing]")
                if mode in ("phased-promotion", "phased-promotion-history-failed"):
                    if mode == "phased-promotion-history-failed":
                        required_history = (
                            "--- Prior Slack thread history " in phase_prompt
                            and "develop適用できますか?developからmainへのPRも作っておいて、URLをください。" in phase_prompt
                            and "こちら続きを進めて" in phase_prompt
                        )
                        if not required_history:
                            raise RuntimeError("failed publication continuation history missing")
                    publication = '<zerokun_publication>{"promotions":[{"kind":"promote-current-head","repository":".","baseBranch":"develop","mergePullRequest":true,"followupBaseBranch":"main","waitForChecks":false,"integrationPullRequestBody":"## Summary","followupPullRequestBody":"## Summary","closePullRequestNumbers":[]}]}</zerokun_publication>'
                    scope = '<zerokun_repository_scope>{"repositories":["."]}</zerokun_repository_scope>'
                    action = '<zerokun_work_action>{"kind":"promote-current-head"}</zerokun_work_action>'
                    message = "公開準備完了\\n" + action + "\\n" + publication + "\\n" + scope + "\\n" + (marker.group(0) if marker else "[ZERO_PRE_EDIT_READY:missing:r1:missing]")
                if mode == "phased-ui-approved":
                    action = '<zerokun_work_action>{"kind":"implement","targets":[{"repository":"frontend","baseBranch":"main","mergePullRequest":false,"followupBaseBranch":null}]}</zerokun_work_action>'
                    message = "準備完了\\n" + action + "\\n" + '<zerokun_repository_scope>{"repositories":["frontend"]}</zerokun_repository_scope>\\n' + (marker.group(0) if marker else "[ZERO_PRE_EDIT_READY:missing:r1:missing]")
                    envelope = re.search(r"<zerokun_ui_response_decision>([^\\n]+)</zerokun_ui_response_decision>", phase_prompt)
                    if envelope:
                        semantic = envelope.group(0).replace("<approve|revise|question|reject>", "approve").replace("<unchanged|compatible|conflict>", "unchanged")
                        message = semantic + "\\n" + message
            elif stage == "implementation":
                if mode == "phased-publication":
                    branch_match = re.search(r"Host-assigned feature branch: (zerochan/[0-9a-f]{20})", phase_prompt)
                    if not branch_match:
                        raise RuntimeError("publication branch missing from implementation prompt")
                    branch = branch_match.group(1)
                    subprocess.run(["/usr/bin/git", "-C", handshake_cwd, "switch", "-c", branch], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    with open(os.path.join(handshake_cwd, "published.txt"), "w", encoding="utf-8") as stream:
                        stream.write("reviewed publication\\n")
                    subprocess.run(["/usr/bin/git", "-C", handshake_cwd, "add", "published.txt"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    subprocess.run(["/usr/bin/git", "-C", handshake_cwd, "commit", "-m", "fix: publish exact reviewed commit"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    subprocess.run(["/usr/bin/git", "-C", handshake_cwd, "switch", "main"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if mode == "phased-publication-targeted":
                    binding_lines = [
                        line for line in phase_prompt.splitlines()
                        if line.startswith('{"repository":"."')
                        and '"baseCommit":' in line
                        and '"headBranch":' in line
                    ]
                    if len(binding_lines) != 1:
                        raise RuntimeError("targeted implementation binding missing")
                    binding = json.loads(binding_lines[0])
                    if (
                        binding.get("baseBranch") != "develop"
                        or binding.get("mergePullRequest") is not True
                        or binding.get("followupBaseBranch") != "main"
                    ):
                        raise RuntimeError("targeted implementation binding is invalid")
                    worktree = os.environ["ZERO_ISOLATED_WORKTREE"]
                    subprocess.run([
                        "/usr/bin/git", "-C", handshake_cwd, "worktree", "add", "-b",
                        binding["headBranch"], worktree, binding["baseCommit"],
                    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    try:
                        with open(os.path.join(worktree, "targeted.txt"), "w", encoding="utf-8") as stream:
                            stream.write("reviewed targeted publication\\n")
                        subprocess.run(["/usr/bin/git", "-C", worktree, "add", "targeted.txt"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        subprocess.run(["/usr/bin/git", "-C", worktree, "commit", "-m", "fix: publish from selected develop base"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    finally:
                        subprocess.run(["/usr/bin/git", "-C", handshake_cwd, "worktree", "remove", "--force", worktree], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                marker = re.search(r"\\[ZERO_IMPLEMENTATION_READY:[0-9a-f]{32}:r[0-9]+:[0-9a-f]{64}\\]", phase_prompt)
                message = "実装完了\\n" + (marker.group(0) if marker else "[ZERO_IMPLEMENTATION_READY:missing:r1:missing]")
            elif stage == "review":
                if mode in ("phased-promotion", "phased-promotion-history-failed") and "Host-bound publication-only workflow" not in phase_prompt:
                    raise RuntimeError("publication-only review binding missing")
                review_fix_state = os.environ.get("ZERO_REVIEW_FIXTURE_STATE")
                review_fix_count = 0
                if mode in ("phased-review-fix-three-times", "phased-reprepare-after-review-fix"):
                    if not review_fix_state:
                        raise RuntimeError("review fix fixture state missing")
                    if os.path.exists(review_fix_state):
                        with open(review_fix_state, "r", encoding="utf-8") as stream:
                            review_fix_count = int(stream.read())
                    with open(review_fix_state, "w", encoding="utf-8") as stream:
                        stream.write(str(review_fix_count + 1))
                requires_fix = (
                    mode == "phased-review-fix-three-times" and review_fix_count < 3
                ) or (
                    mode == "phased-reprepare-after-review-fix" and review_fix_count < 1
                )
                if requires_fix:
                    marker = re.search(r"\\[ZERO_REVIEW_FIX_REQUIRED:[0-9a-f]{32}:round-[123]\\]", phase_prompt)
                    message = (marker.group(0) if marker else "[ZERO_REVIEW_FIX_REQUIRED:missing:round-1]") + "\\n修正を続けます"
                else:
                    marker = re.search(r"\\[ZERO_REVIEW_PUBLISH:[0-9a-f]{32}:round-[123]\\]", phase_prompt)
                    message = (marker.group(0) if marker else "[ZERO_REVIEW_PUBLISH:missing:round-1]") + "\\n公開できます"
            else:
                message = "unexpected phase"
            control_log = os.environ.get("ZERO_CONTROL_LOG")
            hold_for_steer = mode == "phased-steer" and stage == "implementation" and control_log and not os.path.exists(control_log)
            hold_for_interjection = mode == "phased-interjection-update" and stage == "implementation" and (not fixture_state or not os.path.exists(fixture_state))
            capacity_state = os.environ.get("ZERO_CAPACITY_FIXTURE_STATE")
            fail_capacity = capacity_state and not os.path.exists(capacity_state) and (
                (mode == "phased-capacity-review-once" and stage == "review") or
                (mode == "phased-capacity-implementation-once" and stage == "implementation")
            )
            if fail_capacity:
                with open(capacity_state, "w", encoding="utf-8") as stream:
                    stream.write(stage)
                failure = {"message": "Selected model is at capacity. Please try a different model.", "codexErrorInfo": None, "additionalDetails": None}
                items = []
                if stage == "implementation":
                    command = {"type": "commandExecution", "id": "capacity-partial-command", "command": "echo changed", "status": "completed", "exitCode": 0}
                    emit({"method": "item/started", "params": {"threadId": requested_thread or thread_id, "turnId": turn_id, "item": command}})
                    items = [command]
                emit({"method": "error", "params": {"threadId": requested_thread or thread_id, "turnId": turn_id, "willRetry": False, "error": failure}})
                emit({"method": "turn/completed", "params": {"threadId": requested_thread or thread_id, "turn": {"id": turn_id, "status": "failed", "itemsView": "full", "items": items, "error": failure}}})
            elif not hold_for_steer and not hold_for_interjection:
                emit({"method": "turn/completed", "params": {"threadId": requested_thread or thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": message}], "error": None}}})
        elif mode in ("normal", "commentary", "interjection-late-answer", "slow", "logical-stop-required", "late-error-after-complete", "late-error-coalesced", "errors-before-terminal-coalesced", "terminal-cancel-race", "large-ledger", "history-authority", "history-missing-final"):
            if mode == "slow":
                time.sleep(0.1)
            if mode == "large-ledger":
                for _index in range(96):
                    subprocess.Popen(["/bin/sleep", "30"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                time.sleep(0.5)
            terminal = {"method": "turn/completed", "params": {"threadId": requested_thread or thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": "通常完了"}], "error": None}}}
            progress_error = {"method": "error", "params": {"threadId": thread_id, "turnId": turn_id, "willRetry": True, "error": {"message": "fixture progress", "codexErrorInfo": None, "additionalDetails": None}}}
            late_error = {"method": "error", "params": {"threadId": thread_id, "turnId": turn_id, "willRetry": False, "error": {"message": "late fixture failure", "codexErrorInfo": None, "additionalDetails": None}}}
            if mode == "commentary":
                emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": {"type": "agentMessage", "id": "commentary-shared", "phase": "commentary", "text": "原因を確認しています 🔎"}}})
                emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": {"type": "agentMessage", "id": "commentary-shared", "phase": "commentary", "text": "修正内容を検証しています 🧪"}}})
            if mode == "late-error-coalesced":
                emit_batch([terminal, late_error])
            elif mode == "errors-before-terminal-coalesced":
                emit_batch([progress_error, progress_error, terminal])
            else:
                emit(terminal)
            if mode == "late-error-after-complete":
                time.sleep(0.2)
                emit(late_error)
        elif mode in ("defer", "terminal-race") and turn_id == "turn-app-server-2":
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": "次ターンで追加入力を反映しました"}], "error": None}}})
        elif mode in ("failed-steer", "failed-turn"):
            if turn_id == "turn-app-server-1":
                emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "failed", "itemsView": "full", "items": [], "error": {"message": "fixture failure"}}}})
            else:
                emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": "失敗後の追加入力を反映しました"}], "error": None}}})
        elif mode == "rate-error":
            failure = {"message": "rate limit 429", "codexErrorInfo": {"retry_after": 1}, "additionalDetails": None}
            emit({"method": "error", "params": {"threadId": thread_id, "turnId": turn_id, "willRetry": False, "error": failure}})
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "failed", "itemsView": "full", "items": [], "error": failure}}})
        elif mode in ("capacity-error", "capacity-after-command", "capacity-error-generic-terminal", "capacity-started-command"):
            failure = {"message": "Selected model is at capacity. Please try a different model.", "codexErrorInfo": None, "additionalDetails": None}
            items = [] if mode == "capacity-error" else [{"type": "commandExecution", "id": "capacity-command", "command": "echo changed", "status": "completed", "exitCode": 0}]
            if mode in ("capacity-error-generic-terminal", "capacity-started-command"):
                items = []
            if mode == "capacity-started-command":
                emit({"method": "item/started", "params": {"threadId": thread_id, "turnId": turn_id, "item": {"type": "commandExecution", "id": "capacity-started-command", "command": "echo changed", "status": "inProgress", "exitCode": None}}})
            emit({"method": "error", "params": {"threadId": thread_id, "turnId": turn_id, "willRetry": False, "error": failure}})
            terminal_failure = {"message": "turn failed", "codexErrorInfo": None, "additionalDetails": None} if mode in ("capacity-error-generic-terminal", "capacity-started-command") else failure
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "failed", "itemsView": "full", "items": items, "error": terminal_failure}}})
        elif mode == "rate-retrying":
            emit({"method": "error", "params": {"threadId": thread_id, "turnId": turn_id, "willRetry": True, "error": {"message": "rate limit 429", "codexErrorInfo": {"retry_after": 1}, "additionalDetails": None}}})
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": "内部retry後に完了"}], "error": None}}})
        elif mode == "error-steer":
            emit({"method": "error", "params": {"threadId": thread_id, "turnId": turn_id, "willRetry": True, "error": {"message": "temporary fixture error", "codexErrorInfo": None, "additionalDetails": None}}})
        elif mode == "summary-stream-no-history":
            emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": {"type": "agentMessage", "text": "履歴不要で完了"}}})
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "summary", "items": [], "error": None}}})
    elif method == "thread/items/list" and mode in ("defer", "terminal-race", "terminal-race-accepted", "terminal-race-accepted-history", "terminal-race-duplicate", "terminal-race-stale-after-user") and value.get("params", {}).get("turnId") == "turn-app-server-1":
        matching = 1 if mode in ("terminal-race-accepted", "terminal-race-accepted-history") else (2 if mode == "terminal-race-duplicate" else 0)
        agent_text = "永続履歴の追記を反映しました" if mode == "terminal-race-accepted-history" else "元ターン完了"
        if mode == "terminal-race-stale-after-user":
            emit({"id": request_id, "result": {"data": [
                {"turnId": turn_id, "item": {"type": "agentMessage", "id": "history-agent-old", "text": "元ターン完了"}},
                {"turnId": turn_id, "item": {"type": "userMessage", "id": "history-user", "clientId": steer_client_id, "content": []}},
            ], "nextCursor": None}})
            continue
        emit({"id": request_id, "result": {"data": [
            *[{"turnId": turn_id, "item": {"type": "userMessage", "id": "history-user-" + str(index), "clientId": steer_client_id, "content": []}} for index in range(matching)],
            {"turnId": turn_id, "item": {"type": "agentMessage", "id": "history-agent", "text": agent_text}},
        ], "nextCursor": None}})
    elif method == "thread/items/list" and mode == "history-authority":
        emit({"id": request_id, "result": {"data": [{
            "turnId": value.get("params", {}).get("turnId"),
            "item": {"type": "agentMessage", "id": "history-authority", "text": "公式journal回答"},
        }], "nextCursor": None}})
    elif method == "thread/items/list" and mode == "history-missing-final":
        emit({"id": request_id, "result": {"data": [{
            "turnId": value.get("params", {}).get("turnId"),
            "item": {"type": "agentMessage", "id": "history-commentary", "phase": "commentary", "text": "確認中"},
        }], "nextCursor": None}})
    elif method == "thread/items/list":
        requested_turn_id = value.get("params", {}).get("turnId")
        emit({"id": request_id, "result": {"data": [
            {"turnId": requested_turn_id, "item": item}
            for item in persisted_items.get(requested_turn_id, [])
        ], "nextCursor": None}})
    elif method == "thread/turns/list" and mode in ("defer", "terminal-race", "terminal-race-stale-after-user"):
        turn_items = [{"type": "agentMessage", "id": "turn-agent", "text": "元ターン完了"}]
        emit({"id": request_id, "result": {"data": [{
            "id": turn_id, "status": "completed", "itemsView": "full",
            "items": turn_items,
            "error": None,
        }], "nextCursor": None}})
    elif method == "thread/read" and mode in ("defer", "terminal-race", "terminal-race-stale-after-user"):
        read_items = [{"type": "agentMessage", "id": "read-agent", "text": "元ターン完了"}]
        emit({"id": request_id, "result": {"thread": {
            "id": thread_id,
            "turns": [{
                "id": turn_id, "status": "completed", "itemsView": "full",
                "items": read_items,
                "error": None,
            }],
        }}})
    elif method in ("thread/turns/list", "thread/read") and mode == "summary-stream-no-history":
        emit({"id": request_id, "error": {"code": -32000, "message": "history must not be requested"}})
    elif method == "thread/turns/list" and mode == "phased-native-history-fresh" and turn_count == 0:
        requested_id = value.get("params", {}).get("threadId") or thread_id
        emit({"id": request_id, "error": {"code": -32600, "message": "thread " + requested_id + " is not materialized yet; thread/turns/list is unavailable before first user message"}})
    elif method == "thread/turns/list" and mode == "phased-native-history-resume-unmaterialized":
        requested_id = value.get("params", {}).get("threadId") or thread_id
        emit({"id": request_id, "error": {"code": -32600, "message": "thread " + requested_id + " is not materialized yet; thread/turns/list is unavailable before first user message"}})
    elif method == "thread/turns/list" and mode == "phased-native-history-resume":
        emit({"id": request_id, "result": {"data": [{
            "id": "historical-parent-turn", "status": "completed",
            "itemsView": "full", "items": [], "error": None,
        }], "nextCursor": None}})
    elif method == "thread/turns/list":
        emit({"id": request_id, "result": {"data": [], "nextCursor": None}})
    elif method == "thread/read":
        emit({"id": request_id, "result": {"thread": {"id": requested_thread or thread_id, "turns": []}}})
    elif method == "thread/list":
        children = [{
            "id": "historical-child", "parentThreadId": requested_thread or thread_id,
        }] if mode == "phased-native-history-resume" else []
        emit({"id": request_id, "result": {"data": children, "nextCursor": None}})
    elif method == "turn/steer":
        if mode in ("interjection-answer", "interjection-update", "interjection-late-answer", "phased-interjection-update"):
            pause_text = value.get("params", {}).get("input", [{}])[0].get("text", "")
            marker = re.search(r"\\[ZERO_INTERJECTION_PAUSED:[^\\]]+\\]", pause_text)
            emit({"id": request_id, "result": {"turnId": value["params"]["expectedTurnId"]}})
            message = "安全な境界で一時停止しました\\n" + (marker.group(0) if marker else "[ZERO_INTERJECTION_PAUSED:missing]")
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "id": "pause-final", "text": message}], "error": None}}})
        elif mode == "progress-collapse":
            progress_text = value.get("params", {}).get("input", [{}])[0].get("text", "")
            marker = re.search(r"\\[ZERO_PROGRESS_BEGIN:([A-F0-9]{24,64})\\]", progress_text)
            if not marker:
                time.sleep(0.15)
                emit({"id": request_id, "result": {"turnId": value["params"]["expectedTurnId"]}})
                continue
            progress_probe_count += 1
            token = marker.group(1)
            status = "古い進捗です" if progress_probe_count == 1 else "最新の状況を確認しています 🔎"
            commentary = {
                "type": "agentMessage",
                "id": "progress-collapse-" + str(progress_probe_count),
                "phase": "commentary",
                "text": "[ZERO_PROGRESS_BEGIN:" + token + "]\\n" + status + "\\n[ZERO_PROGRESS_END:" + token + "]",
            }
            emit({"id": request_id, "result": {"turnId": value["params"]["expectedTurnId"]}})
            if progress_probe_count == 1:
                time.sleep(0.05)
                emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": commentary}})
                continue
            emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": commentary}})
            time.sleep(0.2)
            final_item = {"type": "agentMessage", "id": "progress-collapse-final", "phase": "final_answer", "text": "完了しました ✅"}
            emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": final_item}})
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [commentary, final_item], "error": None}}})
        elif mode == "progress-no-ack":
            continue
        elif mode == "progress-reject-once":
            progress_probe_count += 1
            if progress_probe_count == 1:
                emit({"id": request_id, "error": {"code": -32000, "message": "temporary progress rejection"}})
                continue
            progress_text = value.get("params", {}).get("input", [{}])[0].get("text", "")
            marker = re.search(r"\\[ZERO_PROGRESS_BEGIN:([A-F0-9]{24,64})\\]", progress_text)
            token = marker.group(1) if marker else "MISSINGPROGRESSMARKER000000"
            commentary = {"type": "agentMessage", "id": "progress-retry", "phase": "commentary", "text": "[ZERO_PROGRESS_BEGIN:" + token + "]\\n再試行後も作業を続けています 🛠️\\n[ZERO_PROGRESS_END:" + token + "]"}
            final_item = {"type": "agentMessage", "id": "progress-retry-final", "phase": "final_answer", "text": "進捗再試行後に完了しました ✅"}
            emit({"id": request_id, "result": {"turnId": value["params"]["expectedTurnId"]}})
            emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": commentary}})
            emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": final_item}})
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [commentary, final_item], "error": None}}})
        elif mode in ("progress-late-ack", "progress-final-answer"):
            progress_text = value.get("params", {}).get("input", [{}])[0].get("text", "")
            marker = re.search(r"\\[ZERO_PROGRESS_BEGIN:([A-F0-9]{24,64})\\]", progress_text)
            token = marker.group(1) if marker else "MISSINGPROGRESSMARKER000000"
            marker_text = "[ZERO_PROGRESS_BEGIN:" + token + "]\\n遅い応答でも作業を続けています 🔎\\n[ZERO_PROGRESS_END:" + token + "]"
            if mode == "progress-late-ack":
                time.sleep(0.08)
            emit({"id": request_id, "result": {"turnId": value["params"]["expectedTurnId"]}})
            phase = "final_answer" if mode == "progress-final-answer" else "commentary"
            progress_item = {"type": "agentMessage", "id": mode, "phase": phase, "text": marker_text}
            emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": progress_item}})
            if mode == "progress-late-ack":
                time.sleep(0.1)
                final_item = {"type": "agentMessage", "id": "progress-late-final", "phase": "final_answer", "text": "遅いACKの後も完了しました ✅"}
                emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": final_item}})
                items = [progress_item, final_item]
            else:
                items = [progress_item]
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": items, "error": None}}})
        elif mode == "progress":
            progress_text = value.get("params", {}).get("input", [{}])[0].get("text", "")
            marker = re.search(r"\\[ZERO_PROGRESS_BEGIN:([A-F0-9]{24,64})\\]", progress_text)
            token = marker.group(1) if marker else "MISSINGPROGRESSMARKER000000"
            commentary = {
                "type": "agentMessage",
                "id": "progress-commentary",
                "phase": "commentary",
                "text": "[ZERO_PROGRESS_BEGIN:" + token + "]\\n画面を組み立てて、動作確認へ進んでいます 🛠️\\n[ZERO_PROGRESS_END:" + token + "]",
            }
            emit({"id": request_id, "result": {"turnId": value["params"]["expectedTurnId"]}})
            emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": commentary}})
            time.sleep(0.2)
            final_item = {"type": "agentMessage", "id": "progress-final", "phase": "final_answer", "text": "Hello Worldアプリを作成しました ✅"}
            emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": final_item}})
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [commentary, final_item], "error": None}}})
        elif mode == "phased-steer":
            control_log = os.environ.get("ZERO_CONTROL_LOG")
            if control_log:
                with open(control_log, "a", encoding="utf-8") as stream:
                    stream.write(json.dumps({"method": method, "threadId": value["params"].get("threadId"), "expectedTurnId": value["params"].get("expectedTurnId"), "text": value["params"].get("input", [{}])[0].get("text", "")}, ensure_ascii=False) + "\\n")
            emit({"id": request_id, "result": {"turnId": value["params"]["expectedTurnId"]}})
            marker = re.search(r"\\[ZERO_IMPLEMENTATION_READY:[0-9a-f]{32}:r[0-9]+:[0-9a-f]{64}\\]", phase_prompt)
            message = "書き込みフェーズを停止\\n" + (marker.group(0) if marker else "[ZERO_IMPLEMENTATION_READY:missing:r1:missing]")
            emit({"method": "turn/completed", "params": {"threadId": requested_thread or thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": message}], "error": None}}})
        elif mode == "defer":
            emit({"id": request_id, "error": {"code": -32000, "message": "active turn is not steerable", "data": {"codexErrorInfo": {"activeTurnNotSteerable": {"turnKind": "review"}}}}})
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": "元ターン完了"}], "error": None}}})
        elif mode in ("terminal-race", "terminal-race-accepted", "terminal-race-accepted-history", "terminal-race-duplicate", "terminal-race-stale-after-user", "terminal-race-cancel"):
            steer_client_id = value["params"].get("clientUserMessageId")
            emit({"id": request_id, "error": {"code": -32000, "message": "no active turn for expected id"}})
            if mode == "terminal-race-cancel":
                continue
            time.sleep(1.2)
            matching = 1 if mode == "terminal-race-accepted" else (2 if mode == "terminal-race-duplicate" else 0)
            items = [{"type": "userMessage", "clientId": value["params"].get("clientUserMessageId"), "content": []} for _ in range(matching)]
            items.append({"type": "agentMessage", "text": "元ターン完了"})
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": items, "error": None}}})
        else:
            emit({"id": request_id, "result": {"turnId": value["params"]["expectedTurnId"]}})
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": "追加入力を反映しました"}], "error": None}}})
    elif method == "turn/interrupt":
        emit({"id": request_id, "result": {}})
        if mode not in ("interrupt-no-terminal", "interrupt-no-terminal-forced"):
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "interrupted", "itemsView": "full", "items": [], "error": None}}})
if mode == "interrupt-no-terminal-forced":
    while True:
        time.sleep(30)
if mode == "logical-stop-required":
    while True:
        time.sleep(30)
`, { mode: 0o700 })
  chmodSync(executable, 0o700)
  return executable
}

function fixture(
  mode: 'normal' | 'steer' | 'interrupt' | 'interrupt-no-terminal'
    | 'interjection-answer' | 'interjection-update' | 'interjection-late-answer'
    | 'interrupt-no-terminal-forced' | 'defer' | 'terminal-race'
    | 'terminal-race-accepted' | 'terminal-race-accepted-history'
    | 'terminal-race-duplicate' | 'terminal-race-stale-after-user' | 'terminal-race-cancel'
    | 'failed-steer' | 'failed-turn'
    | 'error-steer' | 'rate-error' | 'rate-retrying' | 'capacity-error'
    | 'capacity-after-command' | 'capacity-error-generic-terminal'
    | 'capacity-started-command' | 'phased' | 'phased-publication'
    | 'phased-publication-targeted' | 'phased-promotion'
    | 'phased-no-change'
    | 'phased-ui-approved'
    | 'phased-capacity-review-once'
    | 'phased-capacity-implementation-once'
    | 'phased-review-fix-three-times'
    | 'phased-reprepare-after-review-fix'
    | 'phased-native-history-fresh' | 'phased-native-history-resume'
    | 'phased-native-history-resume-unmaterialized' | 'phased-steer'
    | 'phased-promotion-history-failed'
    | 'phased-interjection-update' | 'missing-session-resume'
    | 'phased-late-inbound' | 'summary-stream-no-history' | 'logical-stop-required'
    | 'late-error-after-complete' | 'late-error-coalesced'
    | 'errors-before-terminal-coalesced' | 'terminal-cancel-race'
    | 'large-ledger' | 'hang-initialize' | 'hang-turn-start'
    | 'history-authority' | 'history-missing-final' | 'progress' | 'progress-no-ack'
    | 'progress-collapse' | 'progress-late-ack' | 'progress-final-answer'
    | 'progress-reject-once',
  writeEnabled = false,
  task = '最初の依頼',
) {
  const root = secureRoot()
  const repo = join(root, 'project')
  mkdirSync(repo, { recursive: true, mode: 0o700 })
  writeFileSync(join(repo, 'AGENTS.md'), '# fixture project instructions\n', { mode: 0o600 })
  const state = prepareManagedStateRoot(join(root, 'state'))
  const logDir = join(state, 'job-logs')
  mkdirSync(logDir, { mode: 0o700 })
  const store = new JobStore(join(state, 'jobs.sqlite3'))
  store.enqueue({
    chatId: 'C0123456789',
    threadTs: '1800000000.000100',
    messageId: '1800000000.000100',
    userId: 'UROOT',
    repoPath: repo,
    task,
    writeEnabled,
  })
  const initialJob = store.claimNext('serial-worker')!
  let job = initialJob
  if (mode === 'phased-native-history-resume'
    || mode === 'phased-native-history-resume-unmaterialized'
    || mode === 'phased-promotion-history-failed') {
    if (mode === 'phased-promotion-history-failed') {
      store.fail(initialJob.id, 'local Git config contains a setting that is unsafe for host publication')
    } else {
      completeFixtureJob(store, initialJob, 'thread-app-server-1', '過去ジョブ完了')
    }
    store.enqueue({
      chatId: initialJob.chatId,
      threadTs: initialJob.threadTs,
      messageId: '1800000000.000200',
      userId: 'UROOT',
      repoPath: repo,
      task: mode === 'phased-promotion-history-failed'
        ? 'こちら続きを進めて'
        : '同じSlackスレッドから再開する依頼',
      writeEnabled,
    })
    job = store.claimNext('serial-worker')!
  }
  let staged = false
  const stageRequestedControl = () => {
    if (staged || ![
      'interjection-answer', 'interjection-update',
      'steer', 'interrupt', 'interrupt-no-terminal', 'interrupt-no-terminal-forced',
      'defer', 'terminal-race', 'terminal-race-accepted',
      'terminal-race-accepted-history', 'terminal-race-duplicate',
      'terminal-race-stale-after-user',
      'terminal-race-cancel', 'error-steer',
      'terminal-cancel-race',
    ].includes(mode)) return
    staged = true
    const target = store.liveControlTarget(job.chatId, job.threadTs)
    if (!target) throw new Error('live control target disappeared')
    if (mode === 'interjection-answer' || mode === 'interjection-update') {
      store.stageLiveInterjection(target, {
        chatId: job.chatId,
        threadTs: job.threadTs,
        messageId: '1800000000.000200',
        userId: 'UOTHER',
        task: mode === 'interjection-answer'
          ? '今はどこまで進んでいますか？'
          : '追加で上限を120秒に変えてください',
      })
      return
    }
    store.stageLiveControl(target, {
      chatId: job.chatId,
      threadTs: job.threadTs,
      messageId: mode === 'interrupt' || mode === 'interrupt-no-terminal'
        || mode === 'interrupt-no-terminal-forced'
        || mode === 'terminal-cancel-race'
        ? '1800000000.000300' : '1800000000.000200',
      userId: 'UOTHER',
      task: mode === 'interrupt' || mode === 'interrupt-no-terminal'
        || mode === 'interrupt-no-terminal-forced'
        || mode === 'terminal-cancel-race'
        ? '中止' : '別ユーザーからの追加入力',
      kind: mode === 'interrupt' || mode === 'interrupt-no-terminal'
        || mode === 'interrupt-no-terminal-forced'
        || mode === 'terminal-cancel-race' ? 'interrupt' : 'steer',
    })
  }
  const hooks: CodexLiveControlHooks = {
    next: () => store.nextReadyLiveInput(job.id, job.controlEpoch),
    nextInterjection: () => store.nextPendingInterjection(job.id, job.controlEpoch),
    bindTurn: (executorNonce, threadId, turnId) => {
      store.bindAppServerTurn(
        job.id, job.workerId!, job.controlEpoch, executorNonce, threadId, turnId,
      )
    },
    beginInitialDispatch: ({
      executorNonce, threadId, requestId, inputRevision, inputDigest,
    }) => (
      store.beginInitialTurnDispatch({
        jobId: job.id,
        attempt: job.attempts,
        epoch: job.controlEpoch,
        executorNonce,
        threadId,
        requestId,
        inputRevision,
        inputDigest,
      })
    ),
    acknowledgeInitialDispatch: ({ executorNonce, threadId, turnId, requestId }) => {
      store.acknowledgeInitialTurnDispatch({
        jobId: job.id,
        workerId: job.workerId!,
        attempt: job.attempts,
        epoch: job.controlEpoch,
        executorNonce,
        threadId,
        turnId,
        requestId,
      })
      stageRequestedControl()
    },
    initialDispatchAmbiguous: (requestId, error) => store.markInitialTurnDispatchAmbiguous({
      jobId: job.id,
      attempt: job.attempts,
      requestId,
      error,
    }),
    initialDispatchRejected: (requestId, error) => store.markInitialTurnDispatchRejected({
      jobId: job.id,
      attempt: job.attempts,
      requestId,
      error,
    }),
    preparePhaseDispatch: ({
      phaseSequence, stage, logicalNonce, threadId, inputRevision, inputDigest,
    }) => store.prepareAppServerPhaseDispatch({
      jobId: job.id,
      attempt: job.attempts,
      epoch: job.controlEpoch,
      phaseSequence,
      stage,
      logicalNonce,
      threadId,
      inputRevision,
      inputDigest,
    }),
    beginPhaseDispatch: ({
      phaseSequence, logicalNonce, threadId, requestId, inputRevision, inputDigest,
    }) => store.beginAppServerPhaseDispatch({
      jobId: job.id,
      attempt: job.attempts,
      epoch: job.controlEpoch,
      phaseSequence,
      logicalNonce,
      threadId,
      requestId,
      inputRevision,
      inputDigest,
    }),
    acknowledgePhaseDispatch: ({
      phaseSequence, logicalNonce, threadId, turnId, requestId,
    }) => store.acknowledgeAppServerPhaseDispatch({
      jobId: job.id,
      workerId: job.workerId!,
      attempt: job.attempts,
      epoch: job.controlEpoch,
      phaseSequence,
      logicalNonce,
      threadId,
      turnId,
      requestId,
    }),
    phaseDispatchAmbiguous: (phaseSequence, requestId, error) => (
      store.markAppServerPhaseDispatchAmbiguous({
        jobId: job.id,
        attempt: job.attempts,
        phaseSequence,
        requestId,
        error,
      })
    ),
    phaseDispatchRejected: (phaseSequence, requestId, error) => (
      store.markAppServerPhaseDispatchRejected({
        jobId: job.id,
        attempt: job.attempts,
        phaseSequence,
        requestId,
        error,
      })
    ),
    sealPhaseResult: ({ logicalNonce, threadId, inputRevision, inputDigest, execution }) => (
      store.sealAppServerPhaseResult({
        jobId: job.id,
        epoch: job.controlEpoch,
        logicalNonce,
        threadId,
        inputRevision,
        inputDigest,
        execution,
      })
    ),
    beginDispatch: ({ control, executorNonce, threadId, turnId, requestId }) => {
      if (control.kind === 'interjection') {
        if (!turnId) throw new Error('interjection pause omitted its active turn')
        store.beginInterjectionPause({
          interjectionId: control.id,
          jobId: job.id,
          epoch: job.controlEpoch,
          executorNonce,
          threadId,
          turnId,
          requestId,
        })
        return
      }
      store.beginControlDispatch({
        controlId: control.id,
        jobId: job.id,
        epoch: job.controlEpoch,
        executorNonce,
        threadId,
        turnId,
        requestId,
      })
    },
    acknowledge: (control, requestId: number, turnId: string) => {
      if (control.kind === 'interjection') {
        store.acknowledgeInterjectionPause(control.id, requestId, turnId)
        return
      }
      store.acknowledgeControl(control.id, requestId, turnId)
    },
    ambiguous: (control, error) => {
      if (control.kind === 'interjection') {
        store.markInterjectionAmbiguous(control.id, error)
        return
      }
      store.markControlAmbiguous(control.id, error)
    },
    deferToNextTurn: (control, requestId, executorNonce, threadId, turnId, error) => (
      control.kind === 'interjection'
        ? store.deferInterjectionPause({
          interjectionId: control.id,
          requestId,
          executorNonce,
          threadId,
          turnId,
          error,
        })
        : store.deferControlToNextTurn({
          controlId: control.id,
          requestId,
          executorNonce,
          threadId,
          turnId,
          error,
        })
    ),
    finishTurn: ({
      executorNonce, threadId, turnId, retainInput, rateLimitResumeAt,
    }) => store.finishAppServerTurn({
      jobId: job.id,
      epoch: job.controlEpoch,
      executorNonce,
      threadId,
      turnId,
      retainInput,
      rateLimitResumeAt,
    }),
    recordRateLimit: ({ executorNonce, threadId, turnId, resumeAt }) => (
      store.recordAppServerRateLimit({
        jobId: job.id,
        epoch: job.controlEpoch,
        executorNonce,
        threadId,
        turnId,
        resumeAt,
      })
    ),
    prepareInterjectionAnswer: ({ interjection, logicalNonce, threadId }) => (
      store.prepareInterjectionAnswer({
        interjectionId: interjection.id,
        jobId: job.id,
        epoch: job.controlEpoch,
        logicalNonce,
        threadId,
      })
    ),
    beginInterjectionAnswer: ({ interjection, logicalNonce, threadId, requestId }) => (
      store.beginInterjectionAnswer({
        interjectionId: interjection.id,
        jobId: job.id,
        epoch: job.controlEpoch,
        logicalNonce,
        threadId,
        requestId,
      })
    ),
    acknowledgeInterjectionAnswer: ({
      interjection, logicalNonce, threadId, turnId, requestId,
    }) => store.acknowledgeInterjectionAnswer({
      interjectionId: interjection.id,
      jobId: job.id,
      workerId: job.workerId!,
      epoch: job.controlEpoch,
      logicalNonce,
      threadId,
      turnId,
      requestId,
    }),
    rejectInterjectionAnswer: ({
      interjection, logicalNonce, threadId, requestId, error,
    }) => store.rejectInterjectionAnswer({
      interjectionId: interjection.id,
      logicalNonce,
      threadId,
      requestId,
      error,
    }),
    stageInterjectionAnswer: ({
      interjection, logicalNonce, threadId, turnId, disposition, answer,
    }) => store.stageInterjectionAnswer({
        interjectionId: interjection.id,
        jobId: job.id,
        epoch: job.controlEpoch,
        logicalNonce,
        threadId,
        turnId,
        disposition,
        answer,
      }),
    interjectionDelivered: interjection => store.interjectionIsDelivered(interjection.id),
    promoteInterjection: interjection => store.promoteDeliveredInterjection(interjection.id),
    cancellationRequested: () => store.get(job.id)?.cancelRequestedAt != null,
  }
  return { root, repo, state, logDir, store, job, hooks, executable: fakeCodex(root) }
}

describe('production App Server executor', () => {
  for (const shouldResume of [false, true]) {
    test(`${shouldResume ? 'native resume' : 'fresh physical session'}の履歴注入を一意にする`, async () => {
      const value = fixture('normal')
      const promptLog = join(value.root, `history-${shouldResume ? 'resume' : 'fresh'}.log`)
      const job = {
        ...value.job,
        seq: 2,
        sessionId: shouldResume ? 'thread-existing' : null,
        resumed: shouldResume,
      }
      const threadHistory = createDurableThreadHistorySnapshot({
        jobId: job.id,
        attempt: job.attempts,
        chatId: job.chatId,
        threadTs: job.threadTs,
        repoPath: job.repoPath,
        currentJobSeq: job.seq,
        createdAt: Date.now(),
        archives: [createThreadHistoryArchive({
          jobId: 'prior-job',
          jobSeq: 1,
          chatId: job.chatId,
          threadTs: job.threadTs,
          repoPath: job.repoPath,
          outcome: 'completed',
          finishedAt: Date.now() - 1,
          events: [{ order: 0, kind: 'result', text: '再利用する論理履歴' }],
        })],
      })
      const result = await executeCodexJob(job, {
        codexBinForTesting: value.executable,
        logDir: value.logDir,
        stateDir: value.state,
        skipEffectiveConfigCheck: true,
        extraEnvironment: {
          ZERO_FIXTURE_MODE: 'normal',
          ZERO_PROMPT_LOG: promptLog,
        },
        liveControls: value.hooks,
        threadHistory,
      })
      expect(result.sessionId).toBe(shouldResume ? 'thread-existing' : 'thread-app-server-1')
      const prompt = (JSON.parse(readFileSync(promptLog, 'utf8').trim()) as { text: string }).text
      expect(prompt.includes('Prior Slack thread history')).toBe(!shouldResume)
      expect(prompt.includes('再利用する論理履歴')).toBe(!shouldResume)
      value.store.close()
    }, 30_000)
  }

  test('root commentaryを監視表示とdurable Slack handoffへ同じ順序で渡す', async () => {
    const value = fixture('commentary')
    const monitorMessages: string[] = []
    const commentary: Array<{ sourceKey: string; text: string }> = []
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'commentary' },
      onMonitorMessage: message => { monitorMessages.push(message) },
      onCommentaryMessage: event => { commentary.push(event) },
      liveControls: value.hooks,
    })
    expect(result).toEqual({ sessionId: 'thread-app-server-1', result: '通常完了' })
    expect(commentary.map(event => event.text)).toEqual([
      '💬 原因を確認しています 🔎',
      '💬 修正内容を検証しています 🧪',
    ])
    expect(commentary.every(event => /^[0-9a-f]{64}$/.test(event.sourceKey))).toBe(true)
    expect(new Set(commentary.map(event => event.sourceKey)).size).toBe(2)
    expect(monitorMessages).toEqual([
      '● 作業を開始しました',
      '💬 原因を確認しています 🔎',
      '💬 修正内容を検証しています 🧪',
    ])
    value.store.close()
  }, 15_000)

  test('accepted terminal後は論理終了signalでApp Serverを閉じる', async () => {
    const value = fixture('logical-stop-required')
    const marker = join(value.root, 'logical-stop.marker')
    const monitorMessages: string[] = []
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'logical-stop-required',
        ZERO_LOGICAL_STOP_MARKER: marker,
      },
      onMonitorMessage: message => { monitorMessages.push(message) },
      liveControls: value.hooks,
    })
    expect(result).toEqual({ sessionId: 'thread-app-server-1', result: '通常完了' })
    expect(monitorMessages).toEqual(['● 作業を開始しました'])
    expect(readFileSync(marker, 'utf8')).toBe('term')
    value.store.close()
  }, 15_000)

  test('accepted terminal後のbound errorを成功へ昇格しない', async () => {
    const value = fixture('late-error-after-complete')
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'late-error-after-complete' },
      liveControls: value.hooks,
    })).rejects.toThrow('after the accepted terminal')
    value.store.close()
  }, 15_000)

  test('failed turnの安全な監視表示を例外経路でもflushする', async () => {
    const value = fixture('failed-turn')
    const monitorMessages: string[] = []
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'failed-turn' },
      onMonitorMessage: message => { monitorMessages.push(message) },
      liveControls: value.hooks,
    })).rejects.toThrow('fixture failure')
    expect(monitorMessages).toEqual([
      '● 作業を開始しました',
      '⚠ この段階の処理で問題が発生しました',
    ])
    expect(monitorMessages.join('\n')).not.toContain('fixture failure')
    expect(monitorMessages.join('\n')).not.toContain('jsonrpc')
    value.store.close()
  }, 15_000)

  test('同一stdout chunkのterminal後bound errorも到着順で拒否する', async () => {
    const value = fixture('late-error-coalesced')
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'late-error-coalesced' },
      liveControls: value.hooks,
    })).rejects.toThrow('after the accepted terminal')
    value.store.close()
  }, 15_000)

  test('同一stdout chunkのterminal前errorは順序を保ってprogressとして扱う', async () => {
    const value = fixture('errors-before-terminal-coalesced')
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'errors-before-terminal-coalesced' },
      liveControls: value.hooks,
    })
    expect(result.result).toBe('通常完了')
    value.store.close()
  }, 15_000)

  for (const mode of ['hang-initialize', 'hang-turn-start'] as const) {
    test(`${mode}待機中もexact中止で即時回収する`, async () => {
      const value = fixture(mode)
      const marker = join(value.root, `${mode}.marker`)
      const startedAt = Date.now()
      const execution = executeCodexJob(value.job, {
        codexBinForTesting: value.executable,
        logDir: value.logDir,
        stateDir: value.state,
        skipEffectiveConfigCheck: true,
        extraEnvironment: {
          ZERO_FIXTURE_MODE: mode,
          ZERO_BLOCKED_MARKER: marker,
        },
        supervisorCleanupGraceMs: 2_000,
        liveControls: value.hooks,
      })
      await waitForPath(marker)
      const target = value.store.interruptControlTarget(value.job.chatId, value.job.threadTs)
      expect(target).not.toBeNull()
      expect(value.store.stageLiveControl(target!, {
        chatId: value.job.chatId,
        threadTs: value.job.threadTs,
        messageId: `cancel-${mode}`,
        userId: 'UOTHER',
        task: '中止',
        kind: 'interrupt',
      })).toBe('staged')
      await expect(execution).rejects.toBeInstanceOf(CodexUserCancelledError)
      expect(Date.now() - startedAt).toBeLessThan(5_000)
      expect(existsSync(join(value.state, 'executors', `${value.job.id}.json`))).toBe(false)
      value.store.close()
    }, 15_000)
  }

  test('4KiB超のdurable process ledgerも通常終了時に検証できる', async () => {
    const value = fixture('large-ledger')
    const processIds: number[] = []
    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'large-ledger',
        ZEROKUN_SUPERVISOR_TEST_CLEANUP_GATE: '1',
      },
      onProcessId: pid => { processIds.push(pid) },
      liveControls: value.hooks,
    })
    const gate = await waitForCleanupGate(value.state, processIds, 0)
    try {
      const registration = join(value.state, 'executors', `${value.job.id}.json`)
      expect(statSync(registration).size).toBeGreaterThan(4_096)
    } finally {
      releaseCleanupGate(gate)
    }
    await expect(execution).resolves.toEqual({
      sessionId: 'thread-app-server-1', result: '通常完了',
    })
    value.store.close()
  }, 30_000)

  test('write jobを同じthreadの別RO→RW→ROプロセスで完了する', async () => {
    const value = fixture('phased-publication', true)
    git(value.repo, ['init', '--initial-branch=main'])
    git(value.repo, ['config', 'user.email', 'zero@example.invalid'])
    git(value.repo, ['config', 'user.name', 'Zero Test'])
    git(value.repo, ['config', 'remote.origin.url', 'https://github.com/example/phased-permissions.git'])
    git(value.repo, ['add', 'AGENTS.md'])
    git(value.repo, ['commit', '-m', 'chore: initial'])
    const baseline = captureGitHubPublicationBaseline(value.repo, [value.repo])
    const phaseLog = join(value.root, 'phase-processes.log')
    const processIds: number[] = []
    const sessionIds: string[] = []
    const gates: string[] = []
    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-publication',
        ZERO_PHASE_LOG: phaseLog,
        ZEROKUN_SUPERVISOR_TEST_CLEANUP_GATE: '1',
      },
      supervisorCleanupGraceMs: 25,
      phaseGateForTesting: {
        validatePreparation: () => { gates.push('prepare') },
        validateReview: (_input, _digest, round) => { gates.push(`review-${round}`) },
      },
      onProcessId: processId => { processIds.push(processId) },
      onSessionId: sessionId => { sessionIds.push(sessionId) },
      liveControls: value.hooks,
      publicationBaselineForTesting: baseline,
    })
    const heldPhaseCounts: number[] = []
    const gatesToRelease: Array<{ ready: string, release: string }> = []
    try {
      for (let index = 0; index < 3; index += 1) {
        const gate = await waitForCleanupGate(value.state, processIds, index)
        gatesToRelease.push(gate)
        // Exceed the legacy parent deadline by several multiples. A normal
        // phase must remain on this exact supervisor and must not spawn the
        // following permission phase until self-confirm is released.
        await Bun.sleep(100)
        heldPhaseCounts.push(processIds.length)
        releaseCleanupGate(gate)
      }
    } finally {
      for (const gate of gatesToRelease) releaseCleanupGate(gate)
    }
    const result = await execution

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    expect(result.publication).toMatchObject({
      jobId: value.job.id,
      jobAttempt: value.job.attempts,
      inputRevision: 1,
      plans: [expect.objectContaining({ repositorySlug: 'example/phased-permissions' })],
    })
    expect(value.store.hasGitHubPublicationCheckpoint(value.job.id)).toBe(true)
    expect(value.store.hasStagedExecution(value.job.id)).toBe(true)
    expect(gates).toEqual(['prepare', 'review-1'])
    expect(processIds).toHaveLength(3)
    expect(new Set(processIds).size).toBe(3)
    expect(sessionIds).toEqual([
      'thread-app-server-1',
      'thread-app-server-1',
      'thread-app-server-1',
    ])
    const phaseRows = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t'))
    expect(phaseRows.map(row => row[0])).toEqual(['prepare', 'implementation', 'review'])
    expect(phaseRows.map(row => row[2])).toEqual([
      'thread-app-server-1',
      'thread-app-server-1',
      'thread-app-server-1',
    ])
    expect(phaseRows.map(row => row[3])).toEqual([
      'thread/start',
      'thread/resume',
      'thread/resume',
    ])
    expect(phaseRows.map(row => row[4])).toEqual(['read', 'write', 'read'])
    expect(new Set(phaseRows.map(row => row[5])).size).toBe(3)
    expect(new Set(phaseRows.map(row => row[6])).size).toBe(1)
    expect(heldPhaseCounts).toEqual([1, 2, 3])
    expect(value.store.get(value.job.id)?.acceptsControl).toBe(false)
    value.store.close()
  }, 30_000)

  test('非空review済みcommitをatomic sealからhost push・PR receipt・terminal完了まで通す', async () => {
    const value = fixture('phased-publication', true)
    git(value.repo, ['init', '--initial-branch=main'])
    git(value.repo, ['config', 'user.email', 'zero@example.invalid'])
    git(value.repo, ['config', 'user.name', 'Zero Test'])
    git(value.repo, ['config', 'remote.origin.url', 'https://github.com/example/integration.git'])
    git(value.repo, ['add', 'AGENTS.md'])
    git(value.repo, ['commit', '-m', 'chore: initial'])
    const baseline = captureGitHubPublicationBaseline(value.repo, [value.repo])
    const execution = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'phased-publication' },
      phaseGateForTesting: {},
      liveControls: value.hooks,
      publicationBaselineForTesting: baseline,
    })
    expect(execution.publication?.plans).toHaveLength(1)
    const plan = execution.publication!.plans[0]!
    expect(git(value.repo, ['branch', '--show-current'])).toBe('main')
    expect(git(value.repo, ['rev-parse', `refs/heads/${plan.headBranch}`])).toBe(plan.commitSha)
    expect(value.store.hasStagedExecution(value.job.id)).toBe(true)

    let remoteHead: string | null = null
    let pullRequestExists = false
    let pushes = 0
    let creates = 0
    const commands: GitHubPublicationCommands = {
      async runGit(_repository, args) {
        if (args[0] === 'ls-remote') {
          const ref = args.at(-1)
          if (ref === `refs/heads/${plan.baseBranch}`) {
            return publicationCommandResult(0, `${plan.initialHead}\t${ref}\n`)
          }
          return publicationCommandResult(
            0,
            remoteHead ? `${remoteHead}\trefs/heads/${plan.headBranch}\n` : '',
          )
        }
        if (args[0] === 'push') {
          pushes += 1
          remoteHead = plan.commitSha
          return publicationCommandResult(0, 'ok')
        }
        throw new Error(`unexpected Git command: ${args.join(' ')}`)
      },
      async runGh(args) {
        if (args.includes('GET')) {
          return publicationCommandResult(0, pullRequestExists ? JSON.stringify([{
            number: 61,
            html_url: 'https://github.com/example/integration/pull/61',
            state: 'open',
            merged_at: null,
            head: {
              ref: plan.headBranch,
              sha: plan.commitSha,
              repo: { full_name: plan.repositorySlug },
            },
            base: { ref: plan.baseBranch, repo: { full_name: plan.repositorySlug } },
          }]) : '[]')
        }
        if (args.includes('POST')) {
          creates += 1
          pullRequestExists = true
          return publicationCommandResult(0, '{}')
        }
        throw new Error(`unexpected gh command: ${args.join(' ')}`)
      },
    }
    await publishStagedGitHubPublication(value.store, value.job.id, {
      commands,
      retryMsForTesting: 1,
    })
    value.store.completeStagedExecution(value.job.id)
    expect(value.store.get(value.job.id)).toMatchObject({ status: 'completed' })
    expect(value.store.get(value.job.id)?.result).toContain(
      'https://github.com/example/integration/pull/61',
    )
    expect(pushes).toBe(1)
    expect(creates).toBe(1)
    value.store.close()
  }, 30_000)

  test('Codex選択develop baseを無関係な共有checkoutから隔離実装しmain向けPRまで公開する', async () => {
    const value = fixture(
      'phased-publication-targeted',
      true,
      'developを起点に実装し、developへ適用後にmain向けPRを作成してください',
    )
    const phaseLog = join(value.root, 'targeted-publication-phases.log')
    const isolatedWorktree = join(value.root, 'targeted-publication-worktree')
    git(value.repo, ['init', '--initial-branch=main'])
    git(value.repo, ['config', 'user.email', 'zero@example.invalid'])
    git(value.repo, ['config', 'user.name', 'Zero Test'])
    git(value.repo, [
      'config', 'remote.origin.url', 'https://github.com/example/targeted-publication.git',
    ])
    git(value.repo, ['add', 'AGENTS.md'])
    git(value.repo, ['commit', '-m', 'chore: initial'])
    const mainHead = git(value.repo, ['rev-parse', 'HEAD'])
    git(value.repo, ['switch', '-c', 'develop'])
    writeFileSync(join(value.repo, 'develop.txt'), 'selected implementation base\n')
    git(value.repo, ['add', 'develop.txt'])
    git(value.repo, ['commit', '-m', 'chore: prepare develop'])
    const developHead = git(value.repo, ['rev-parse', 'HEAD'])
    git(value.repo, ['update-ref', 'refs/remotes/origin/main', mainHead])
    git(value.repo, ['update-ref', 'refs/remotes/origin/develop', developHead])
    git(value.repo, ['switch', '-c', 'feat/unrelated-shared-checkout'])
    writeFileSync(join(value.repo, 'unrelated.txt'), 'keep unrelated checkout\n')
    git(value.repo, ['add', 'unrelated.txt'])
    git(value.repo, ['commit', '-m', 'feat: unrelated concurrent work'])
    const unrelatedHead = git(value.repo, ['rev-parse', 'HEAD'])
    const baseline = captureGitHubPublicationBaselineForBranches(value.repo, [{
      gitRoot: value.repo,
      baseBranch: 'develop',
    }])

    const execution = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-publication-targeted',
        ZERO_PHASE_LOG: phaseLog,
        ZERO_ISOLATED_WORKTREE: isolatedWorktree,
      },
      phaseGateForTesting: {},
      liveControls: value.hooks,
      publicationBaselineForTesting: baseline,
    })

    expect(readFileSync(phaseLog, 'utf8').trim().split('\n').map(line => line.split('\t')[0]))
      .toEqual(['prepare', 'implementation', 'review'])
    expect(git(value.repo, ['branch', '--show-current']))
      .toBe('feat/unrelated-shared-checkout')
    expect(git(value.repo, ['rev-parse', 'HEAD'])).toBe(unrelatedHead)
    expect(git(value.repo, ['status', '--porcelain'])).toBe('')
    expect(existsSync(isolatedWorktree)).toBe(false)
    expect(execution.publication?.plans).toHaveLength(1)
    const plan = execution.publication!.plans[0]!
    expect(plan).toMatchObject({
      baseBranch: 'develop',
      initialHead: developHead,
      promotion: {
        sourceBranch: plan.headBranch,
        sourceHead: plan.commitSha,
        followupBaseBranch: 'main',
        followupInitialHead: mainHead,
      },
    })
    expect(git(value.repo, ['merge-base', unrelatedHead, plan.commitSha])).toBe(developHead)
    expect(git(value.repo, ['merge-base', '--is-ancestor', developHead, plan.commitSha])).toBe('')

    const integrationMergeHead = 'c'.repeat(40)
    const remoteHeads = new Map<string, string | null>([
      [plan.headBranch, null],
      ['develop', developHead],
      ['main', mainHead],
    ])
    let integrationExists = false
    let integrationMerged = false
    let releaseExists = false
    let integrationBody: string | null = null
    let releaseBody: string | null = null
    let integrationMergeRequests = 0
    let releaseMergeRequests = 0
    const prRecord = (
      number: number,
      headBranch: string,
      headSha: string,
      baseBranch: string,
      merged = false,
      body: string | null = null,
    ) => ({
      number,
      html_url: `https://github.com/${plan.repositorySlug}/pull/${number}`,
      state: merged ? 'closed' : 'open',
      merged_at: merged ? '2026-09-01T00:00:00Z' : null,
      merge_commit_sha: merged ? integrationMergeHead : null,
      body,
      head: {
        ref: headBranch,
        sha: headSha,
        repo: { full_name: plan.repositorySlug },
      },
      base: { ref: baseBranch, repo: { full_name: plan.repositorySlug } },
    })
    const commands: GitHubPublicationCommands = {
      async runGit(_repository, args) {
        if (args[0] === 'ls-remote') {
          const ref = String(args.at(-1))
          const branch = ref.replace(/^refs\/heads\//, '')
          const head = remoteHeads.get(branch) ?? null
          return publicationCommandResult(0, head ? `${head}\t${ref}\n` : '')
        }
        if (args[0] === 'push') {
          remoteHeads.set(plan.headBranch, plan.commitSha)
          return publicationCommandResult(0, 'ok')
        }
        throw new Error(`unexpected targeted publication Git command: ${args.join(' ')}`)
      },
      async runGh(args, stdin) {
        const command = args.join(' ')
        if (command.includes('/compare/')) {
          const prepared = /\/compare\/([0-9a-f]+)\.\.\./.exec(command)?.[1]
          return publicationCommandResult(0, JSON.stringify({
            status: 'ahead',
            ahead_by: 1,
            behind_by: 0,
            base_commit: { sha: prepared },
            merge_base_commit: { sha: prepared },
          }))
        }
        if (args.includes('GET') && command.endsWith(`repos/${plan.repositorySlug}`)) {
          return publicationCommandResult(0, JSON.stringify({
            allow_merge_commit: true,
            allow_squash_merge: true,
            allow_rebase_merge: true,
          }))
        }
        if (args.includes('GET')
          && command.endsWith(`repos/${plan.repositorySlug}/pulls/91`)) {
          return publicationCommandResult(0, JSON.stringify({
            ...prRecord(
              91, plan.headBranch, plan.commitSha, 'develop', integrationMerged,
              integrationBody,
            ),
            draft: false,
            mergeable: true,
            mergeable_state: 'clean',
          }))
        }
        if (args.includes('GET') && command.includes('/pulls?')) {
          if (command.includes('base=develop')) {
            return publicationCommandResult(0, JSON.stringify(integrationExists
              ? [prRecord(
                91, plan.headBranch, plan.commitSha, 'develop', integrationMerged,
                integrationBody,
              )]
              : []))
          }
          if (command.includes('base=main')) {
            return publicationCommandResult(0, JSON.stringify(releaseExists
              ? [prRecord(92, 'develop', integrationMergeHead, 'main', false, releaseBody)]
              : []))
          }
        }
        if (args.includes('POST') && command.includes('/pulls')) {
          const request = JSON.parse(stdin ?? '{}') as {
            base?: string
            head?: string
            body?: string
          }
          if (request.base === 'develop') {
            expect(request.head).toBe(plan.headBranch)
            integrationExists = true
            integrationBody = request.body ?? null
          } else if (request.base === 'main') {
            expect(request.head).toBe('develop')
            releaseExists = true
            releaseBody = request.body ?? null
          } else {
            throw new Error(`unexpected targeted publication PR base: ${request.base}`)
          }
          return publicationCommandResult(0, '{}')
        }
        if (args.includes('PUT') && command.includes('/pulls/91/merge')) {
          integrationMergeRequests += 1
          integrationMerged = true
          remoteHeads.set('develop', integrationMergeHead)
          return publicationCommandResult(0, '{}')
        }
        if (args.includes('PUT') && command.includes('/pulls/92/merge')) {
          releaseMergeRequests += 1
          return publicationCommandResult(0, '{}')
        }
        throw new Error(`unexpected targeted publication gh command: ${command}`)
      },
    }
    const receipt = await publishGitHubPlan(plan, commands)
    expect(receipt).toMatchObject({
      pullRequestUrl: `https://github.com/${plan.repositorySlug}/pull/91`,
      followupPullRequestUrl: `https://github.com/${plan.repositorySlug}/pull/92`,
    })
    expect(integrationMergeRequests).toBe(1)
    expect(releaseMergeRequests).toBe(0)
    expect(git(value.repo, ['branch', '--show-current']))
      .toBe('feat/unrelated-shared-checkout')
    expect(git(value.repo, ['rev-parse', 'HEAD'])).toBe(unrelatedHead)
    value.store.close()
  }, 30_000)

  test('既存commitのbranch promotionはwrite phaseを再実行せずprepareからreviewへ直接固定する', async () => {
    const value = fixture(
      'phased-promotion',
      true,
      '現在のcommitをdevelopへ適用し、developからmainへのPRを作成してください',
    )
    const phaseLog = join(value.root, 'promotion-phases.log')
    git(value.repo, ['init', '--initial-branch=main'])
    git(value.repo, ['config', 'user.email', 'zero@example.invalid'])
    git(value.repo, ['config', 'user.name', 'Zero Test'])
    git(value.repo, ['config', 'remote.origin.url', 'https://github.com/example/promotion-e2e.git'])
    git(value.repo, ['config', 'core.hooksPath', '.husky/_'])
    git(value.repo, ['add', 'AGENTS.md'])
    git(value.repo, ['commit', '-m', 'chore: initial'])
    git(value.repo, ['switch', '-c', 'feature/approved-ui'])
    writeFileSync(join(value.repo, 'approved.txt'), 'already reviewed\n')
    git(value.repo, ['add', 'approved.txt'])
    git(value.repo, ['commit', '-m', 'feat: approved UI'])
    const sourceHead = git(value.repo, ['rev-parse', 'HEAD'])
    const baseline = captureGitHubPublicationBaseline(value.repo, [value.repo])
    const developHead = 'a'.repeat(40)
    const mainHead = 'b'.repeat(40)
    const commands: GitHubPublicationCommands = {
      async runGit(_repository, args) {
        expect(args[0]).toBe('ls-remote')
        const ref = args.at(-1)
        if (ref === 'refs/heads/develop') {
          return publicationCommandResult(0, `${developHead}\t${ref}\n`)
        }
        if (ref === 'refs/heads/main') {
          return publicationCommandResult(0, `${mainHead}\t${ref}\n`)
        }
        throw new Error(`unexpected promotion ref: ${ref}`)
      },
      async runGh() {
        throw new Error('publication-only binding must not mutate GitHub before review')
      },
    }
    const execution = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-promotion',
        ZERO_PHASE_LOG: phaseLog,
      },
      phaseGateForTesting: {},
      liveControls: value.hooks,
      publicationBaselineForTesting: baseline,
      publicationCommandsForTesting: commands,
    })
    expect(execution.publication?.plans).toHaveLength(1)
    expect(execution.publication?.plans[0]).toMatchObject({
      baseBranch: 'develop',
      commitSha: sourceHead,
      initialHead: developHead,
      promotion: {
        sourceBranch: 'feature/approved-ui',
        sourceHead,
        followupBaseBranch: 'main',
        followupInitialHead: mainHead,
      },
    })
    const phaseRows = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t'))
    expect(phaseRows.map(row => row[0])).toEqual(['prepare', 'review'])
    expect(phaseRows.map(row => row[4])).toEqual(['read', 'read'])
    expect(git(value.repo, ['branch', '--show-current'])).toBe('feature/approved-ui')
    expect(git(value.repo, ['status', '--porcelain'])).toBe('')
    expect(value.store.hasGitHubPublicationCheckpoint(value.job.id)).toBe(true)
    expect(value.store.hasStagedExecution(value.job.id)).toBe(true)
    const plan = execution.publication!.plans[0]!
    const integrationMergeHead = 'c'.repeat(40)
    const remoteHeads = new Map<string, string | null>([
      [plan.headBranch, null],
      ['develop', developHead],
      ['main', mainHead],
    ])
    let integrationExists = false
    let integrationMerged = false
    let releaseExists = false
    let integrationBody: string | null = null
    let releaseBody: string | null = null
    let integrationMergeRequests = 0
    let releaseMergeRequests = 0
    const prRecord = (
      number: number,
      headBranch: string,
      headSha: string,
      baseBranch: string,
      merged = false,
      body: string | null = null,
    ) => ({
      number,
      html_url: `https://github.com/${plan.repositorySlug}/pull/${number}`,
      state: merged ? 'closed' : 'open',
      merged_at: merged ? '2026-09-01T00:00:00Z' : null,
      merge_commit_sha: merged ? integrationMergeHead : null,
      body,
      head: {
        ref: headBranch,
        sha: headSha,
        repo: { full_name: plan.repositorySlug },
      },
      base: { ref: baseBranch, repo: { full_name: plan.repositorySlug } },
    })
    const publishCommands: GitHubPublicationCommands = {
      async runGit(_repository, args) {
        if (args[0] === 'ls-remote') {
          const ref = String(args.at(-1))
          const branch = ref.replace(/^refs\/heads\//, '')
          const head = remoteHeads.get(branch) ?? null
          return publicationCommandResult(0, head ? `${head}\t${ref}\n` : '')
        }
        if (args[0] === 'push') {
          remoteHeads.set(plan.headBranch, plan.commitSha)
          return publicationCommandResult(0, 'ok')
        }
        throw new Error(`unexpected publication Git command: ${args.join(' ')}`)
      },
      async runGh(args, stdin) {
        const command = args.join(' ')
        if (command.includes('/compare/')) {
          const prepared = /\/compare\/([0-9a-f]+)\.\.\./.exec(command)?.[1]
          return publicationCommandResult(0, JSON.stringify({
            status: 'ahead', ahead_by: 1, behind_by: 0,
            base_commit: { sha: prepared }, merge_base_commit: { sha: prepared },
          }))
        }
        if (args.includes('GET') && command.endsWith(`repos/${plan.repositorySlug}`)) {
          return publicationCommandResult(0, JSON.stringify({
            allow_merge_commit: true,
            allow_squash_merge: true,
            allow_rebase_merge: true,
          }))
        }
        if (args.includes('GET')
          && command.endsWith(`repos/${plan.repositorySlug}/pulls/81`)) {
          return publicationCommandResult(0, JSON.stringify({
            ...prRecord(
              81, plan.headBranch, plan.commitSha, 'develop', integrationMerged,
              integrationBody,
            ),
            draft: false,
            mergeable: true,
            mergeable_state: 'clean',
          }))
        }
        if (args.includes('GET') && command.includes('/pulls?')) {
          if (command.includes('base=develop')) {
            return publicationCommandResult(0, JSON.stringify(integrationExists
              ? [prRecord(
                81, plan.headBranch, plan.commitSha, 'develop', integrationMerged,
                integrationBody,
              )]
              : []))
          }
          if (command.includes('base=main')) {
            return publicationCommandResult(0, JSON.stringify(releaseExists
              ? [prRecord(82, 'develop', integrationMergeHead, 'main', false, releaseBody)]
              : []))
          }
        }
        if (args.includes('POST') && command.includes('/pulls')) {
          const request = JSON.parse(stdin ?? '{}') as { base?: string, body?: string }
          if (request.base === 'develop') {
            integrationExists = true
            integrationBody = request.body ?? null
          } else if (request.base === 'main') {
            releaseExists = true
            releaseBody = request.body ?? null
          }
          else throw new Error(`unexpected publication PR base: ${request.base}`)
          return publicationCommandResult(0, '{}')
        }
        if (args.includes('PUT') && command.includes('/pulls/81/merge')) {
          integrationMergeRequests += 1
          integrationMerged = true
          remoteHeads.set('develop', integrationMergeHead)
          return publicationCommandResult(0, '{}')
        }
        if (args.includes('PUT') && command.includes('/pulls/82/merge')) {
          releaseMergeRequests += 1
          return publicationCommandResult(0, '{}')
        }
        throw new Error(`unexpected publication gh command: ${command}`)
      },
    }
    value.store.close()
    const reopened = new JobStore(join(value.state, 'jobs.sqlite3'))
    await publishStagedGitHubPublication(reopened, value.job.id, {
      commands: publishCommands,
      retryMsForTesting: 1,
    })
    reopened.completeStagedExecution(value.job.id)
    expect(reopened.get(value.job.id)?.result).toContain(
      `https://github.com/${plan.repositorySlug}/pull/81`,
    )
    expect(reopened.get(value.job.id)?.result).toContain(
      `https://github.com/${plan.repositorySlug}/pull/82`,
    )
    expect(integrationMergeRequests).toBe(1)
    expect(releaseMergeRequests).toBe(0)
    reopened.close()
  }, 30_000)

  test('promotion準備中のGitHub通信失敗はterminal化せず再開可能に分類する', async () => {
    const value = fixture(
      'phased-promotion',
      true,
      '現在のcommitをdevelopへ適用し、developからmainへのPRを作成してください',
    )
    git(value.repo, ['init', '--initial-branch=main'])
    git(value.repo, ['config', 'user.email', 'zero@example.invalid'])
    git(value.repo, ['config', 'user.name', 'Zero Test'])
    git(value.repo, ['config', 'remote.origin.url', 'https://github.com/example/preflight.git'])
    git(value.repo, ['add', 'AGENTS.md'])
    git(value.repo, ['commit', '-m', 'chore: initial'])
    git(value.repo, ['switch', '-c', 'feature/already-reviewed'])
    const baseline = captureGitHubPublicationBaseline(value.repo, [value.repo])

    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'phased-promotion' },
      phaseGateForTesting: {},
      liveControls: value.hooks,
      publicationBaselineForTesting: baseline,
      publicationCommandsForTesting: {
        async runGit() {
          return publicationCommandResult(1, '', 'network is unreachable')
        },
        async runGh() {
          throw new Error('preflight failure must not mutate GitHub')
        },
      },
    })).rejects.toEqual(expect.objectContaining<Partial<CodexPublicationPreflightRetryError>>({
      name: 'CodexPublicationPreflightRetryError',
      category: 'network',
    }))
    expect(value.store.get(value.job.id)?.status).toBe('running')
    expect(value.store.hasStagedExecution(value.job.id)).toBe(false)
    value.store.close()
  }, 30_000)

  test('失敗済み公開依頼を同一threadの履歴からCodexが再開する', async () => {
    const value = fixture(
      'phased-promotion-history-failed',
      true,
      'develop適用できますか？developからmainへのPRも作っておいて、URLをください。',
    )
    git(value.repo, ['init', '--initial-branch=main'])
    git(value.repo, ['config', 'user.email', 'zero@example.invalid'])
    git(value.repo, ['config', 'user.name', 'Zero Test'])
    git(value.repo, ['config', 'remote.origin.url', 'https://github.com/example/resumed-promotion.git'])
    git(value.repo, ['add', 'AGENTS.md'])
    git(value.repo, ['commit', '-m', 'chore: initial'])
    git(value.repo, ['switch', '-c', 'feature/resumed-publication'])
    writeFileSync(join(value.repo, 'resumed.txt'), 'reviewed before the first failure\n')
    git(value.repo, ['add', 'resumed.txt'])
    git(value.repo, ['commit', '-m', 'feat: resumable publication'])
    const sourceHead = git(value.repo, ['rev-parse', 'HEAD'])
    const baseline = captureGitHubPublicationBaseline(value.repo, [value.repo])
    const developHead = 'd'.repeat(40)
    const mainHead = 'e'.repeat(40)
    expect(value.job.task).toBe('こちら続きを進めて')
    expect(value.job.resumed).toBe(false)
    expect(value.store.threadHistorySnapshot(value.job.id).transcript).toContain(
      'develop適用できますか?developからmainへのPRも作っておいて、URLをください。',
    )
    const execution = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'phased-promotion-history-failed' },
      phaseGateForTesting: {},
      liveControls: value.hooks,
      threadHistory: value.store.threadHistorySnapshot(value.job.id),
      publicationBaselineForTesting: baseline,
      publicationCommandsForTesting: {
        async runGit(_repository, args) {
          const ref = String(args.at(-1))
          if (ref === 'refs/heads/develop') {
            return publicationCommandResult(0, `${developHead}\t${ref}\n`)
          }
          if (ref === 'refs/heads/main') {
            return publicationCommandResult(0, `${mainHead}\t${ref}\n`)
          }
          throw new Error(`unexpected resumed promotion ref: ${ref}`)
        },
        async runGh() {
          throw new Error('resumed promotion must not mutate GitHub before review')
        },
      },
    })
    expect(execution.publication?.plans[0]).toMatchObject({
      baseBranch: 'develop',
      commitSha: sourceHead,
      promotion: {
        sourceBranch: 'feature/resumed-publication',
        sourceHead,
        followupBaseBranch: 'main',
        followupInitialHead: mainHead,
      },
    })
    expect(value.store.hasGitHubPublicationCheckpoint(value.job.id)).toBe(true)
    expect(value.store.hasStagedExecution(value.job.id)).toBe(true)
    value.store.close()
  }, 30_000)

  test('明示的no-changeだけがcommit 0件を成功させGitHub操作なしと記録する', async () => {
    const value = fixture('phased-no-change', true)
    const phaseLog = join(value.root, 'no-change-phases.log')
    git(value.repo, ['init', '--initial-branch=main'])
    git(value.repo, ['config', 'user.email', 'zero@example.invalid'])
    git(value.repo, ['config', 'user.name', 'Zero Test'])
    git(value.repo, ['config', 'remote.origin.url', 'https://github.com/example/no-change.git'])
    git(value.repo, ['add', 'AGENTS.md'])
    git(value.repo, ['commit', '-m', 'chore: initial'])
    const baseline = captureGitHubPublicationBaseline(value.repo, [value.repo])
    const execution = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-no-change',
        ZERO_PHASE_LOG: phaseLog,
      },
      phaseGateForTesting: {},
      liveControls: value.hooks,
      publicationBaselineForTesting: baseline,
    })
    expect(execution.publication?.plans).toEqual([])
    const phases = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t')[0])
    expect(phases).toEqual(['prepare', 'review'])
    value.store.completeStagedExecution(value.job.id)
    expect(value.store.get(value.job.id)?.result).toBe('公開できます')
    value.store.close()
  }, 30_000)

  test('implement宣言でreview済みcommitが0件ならno-changeへ黙って降格しない', async () => {
    const value = fixture('phased', true)
    git(value.repo, ['init', '--initial-branch=main'])
    git(value.repo, ['config', 'user.email', 'zero@example.invalid'])
    git(value.repo, ['config', 'user.name', 'Zero Test'])
    git(value.repo, ['config', 'remote.origin.url', 'https://github.com/example/empty-implementation.git'])
    git(value.repo, ['add', 'AGENTS.md'])
    git(value.repo, ['commit', '-m', 'chore: initial'])
    const baseline = captureGitHubPublicationBaseline(value.repo, [value.repo])
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'phased' },
      phaseGateForTesting: {},
      liveControls: value.hooks,
      publicationBaselineForTesting: baseline,
    })).rejects.toThrow(
      'implementation produced no reviewed commit; preparation did not authorize no-change',
    )
    expect(value.store.hasStagedExecution(value.job.id)).toBe(false)
    value.store.close()
  }, 30_000)

  test('実装後reviewのmodel capacityは実装を繰り返さず同じ工程から自動再開する', async () => {
    const value = fixture('phased-capacity-review-once', true)
    const phaseLog = join(value.root, 'capacity-review-phases.log')
    const capacityState = join(value.root, 'capacity-review-once.state')
    const commentary: string[] = []

    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-capacity-review-once',
        ZERO_PHASE_LOG: phaseLog,
        ZERO_CAPACITY_FIXTURE_STATE: capacityState,
      },
      phaseGateForTesting: {},
      transientRetryDelayMsForTesting: 1,
      onMonitorMessage: () => { throw new Error('monitor output unavailable') },
      onCommentaryMessage: event => { commentary.push(event.text) },
      liveControls: value.hooks,
    })

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    const stages = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t')[0])
    expect(stages).toEqual(['prepare', 'implementation', 'review', 'review'])
    expect(stages.filter(stage => stage === 'implementation')).toHaveLength(1)
    expect(commentary).toContain(
      '⏸ 利用中のモデルが混雑しています。作業内容を保持したまま自動再開します。',
    )
    expect(readFileSync(capacityState, 'utf8')).toBe('review')
    value.store.close()
  }, 30_000)

  test('implementation中のmodel capacityは既存変更を保持してreviewへ進みwriteを再送しない', async () => {
    const value = fixture('phased-capacity-implementation-once', true)
    const phaseLog = join(value.root, 'capacity-implementation-phases.log')
    const capacityState = join(value.root, 'capacity-implementation-once.state')
    const commentary: string[] = []

    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-capacity-implementation-once',
        ZERO_PHASE_LOG: phaseLog,
        ZERO_CAPACITY_FIXTURE_STATE: capacityState,
      },
      phaseGateForTesting: {},
      transientRetryDelayMsForTesting: 1,
      onCommentaryMessage: event => { commentary.push(event.text) },
      liveControls: value.hooks,
    })

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    const stages = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t')[0])
    expect(stages).toEqual(['prepare', 'implementation', 'review'])
    expect(stages.filter(stage => stage === 'implementation')).toHaveLength(1)
    expect(commentary).toContain(
      '⏸ 利用中のモデルが混雑しました。現在の変更を保持し、再開後は確認工程から続けます。',
    )
    expect(readFileSync(capacityState, 'utf8')).toBe('implementation')
    value.store.close()
  }, 30_000)

  test('Codexが3回必須修正を判断してもhost上限で止めず4回目のreviewまで継続する', async () => {
    const value = fixture('phased-review-fix-three-times', true)
    const phaseLog = join(value.root, 'unbounded-review-phases.log')
    const promptLog = join(value.root, 'unbounded-review-prompts.log')
    const reviewState = join(value.root, 'unbounded-review.state')

    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-review-fix-three-times',
        ZERO_PHASE_LOG: phaseLog,
        ZERO_PROMPT_LOG: promptLog,
        ZERO_REVIEW_FIXTURE_STATE: reviewState,
      },
      phaseGateForTesting: {},
      liveControls: value.hooks,
    })

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    const stages = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t')[0])
    expect(stages).toEqual([
      'prepare',
      'implementation', 'review',
      'implementation', 'review',
      'implementation', 'review',
      'implementation', 'review',
    ])
    const reviewRounds = readFileSync(promptLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { stage: string, text: string })
      .filter(entry => entry.stage === 'review')
      .map(entry => /Host phase: read-only review round ([0-9]+)\./.exec(entry.text)?.[1])
    expect(reviewRounds).toEqual(['1', '2', '3', '3'])
    expect(readFileSync(reviewState, 'utf8')).toBe('4')
    value.store.close()
  }, 45_000)

  test('no-change reviewで修正が必要になったら失敗せずCodexのprepare判断へ戻る', async () => {
    const value = fixture('phased-reprepare-after-review-fix', true)
    const phaseLog = join(value.root, 'reprepare-after-review-phases.log')
    const reviewState = join(value.root, 'reprepare-after-review.state')

    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-reprepare-after-review-fix',
        ZERO_PHASE_LOG: phaseLog,
        ZERO_REVIEW_FIXTURE_STATE: reviewState,
      },
      phaseGateForTesting: {},
      liveControls: value.hooks,
    })

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    const stages = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t')[0])
    expect(stages).toEqual(['prepare', 'review', 'prepare', 'implementation', 'review'])
    expect(readFileSync(reviewState, 'utf8')).toBe('2')
    value.store.close()
  }, 30_000)

  test('prepare turn中に共有repositoryのclean HEADが進んでもCodex判断を破棄せず公開へ進む', async () => {
    const value = fixture('phased-publication', true)
    git(value.repo, ['init', '--initial-branch=main'])
    git(value.repo, ['config', 'user.email', 'zero@example.invalid'])
    git(value.repo, ['config', 'user.name', 'Zero Test'])
    git(value.repo, [
      'config', 'remote.origin.url', 'https://github.com/example/concurrent-prepare.git',
    ])
    git(value.repo, ['add', 'AGENTS.md'])
    git(value.repo, ['commit', '-m', 'chore: initial'])
    const initialHead = git(value.repo, ['rev-parse', 'HEAD'])
    const baseline = captureGitHubPublicationBaseline(value.repo, [value.repo])
    const processIds: number[] = []
    const phaseLog = join(value.root, 'concurrent-repository-phases.log')
    const concurrentPath = join(value.repo, 'concurrent-change.txt')
    const turnReady = join(value.root, 'prepare-turn.ready')
    const turnRelease = join(value.root, 'prepare-turn.release')
    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-publication',
        ZERO_PHASE_LOG: phaseLog,
        ZERO_TURN_LATCH_STAGE: 'prepare',
        ZERO_TURN_LATCH_READY: turnReady,
        ZERO_TURN_LATCH_RELEASE: turnRelease,
      },
      phaseGateForTesting: {},
      onProcessId: processId => { processIds.push(processId) },
      liveControls: value.hooks,
      publicationBaselineForTesting: baseline,
    })
    await waitForPath(turnReady)
    writeFileSync(concurrentPath, 'changed while prepare was running\n', { mode: 0o600 })
    git(value.repo, ['add', 'concurrent-change.txt'])
    git(value.repo, ['commit', '-m', 'chore: concurrent local work'])
    const concurrentHead = git(value.repo, ['rev-parse', 'HEAD'])
    expect(concurrentHead).not.toBe(initialHead)
    expect(git(value.repo, ['status', '--porcelain'])).toBe('')
    Object.assign(baseline, captureGitHubPublicationBaseline(value.repo, [value.repo]))
    writeFileSync(turnRelease, '', { mode: 0o600, flag: 'wx' })
    const result = await execution
    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    expect(readFileSync(concurrentPath, 'utf8')).toBe('changed while prepare was running\n')
    expect(readFileSync(phaseLog, 'utf8').trim().split('\n').map(line => line.split('\t')[0]))
      .toEqual(['prepare', 'implementation', 'review'])
    expect(processIds).toHaveLength(3)
    expect(value.store.get(value.job.id)?.attempts).toBe(1)
    expect(value.store.get(value.job.id)?.repositoryDriftRetries).toBe(0)
    expect(value.store.writePhaseMayHaveBeenDelivered(value.job.id)).toBe(true)
    const plan = result.publication?.plans[0]
    expect(plan?.initialHead).toBe(concurrentHead)
    expect(git(value.repo, [
      'merge-base', '--is-ancestor', concurrentHead, plan!.commitSha,
    ])).toBe('')
    value.store.close()
  }, 15_000)

  test('UI承認済みmulti-repo jobは対象外repoの同時更新でprepareへ戻らない', async () => {
    const value = fixture('phased-ui-approved', true)
    const makeRepository = (name: string): string => {
      const repository = join(value.repo, name)
      mkdirSync(repository)
      git(repository, ['init', '-q'])
      git(repository, ['config', 'user.name', 'Zero Test'])
      git(repository, ['config', 'user.email', 'zero@example.invalid'])
      writeFileSync(join(repository, 'tracked.txt'), `${name}\n`, { mode: 0o600 })
      git(repository, ['add', '.'])
      git(repository, ['commit', '-qm', 'initial'])
      return repository
    }
    const backend = makeRepository('backend')
    makeRepository('frontend')
    const layout = resolveAdvisorProjectLayout(value.repo)
    const proposalSnapshot = snapshotAdvisorRepository(layout)
    const inputSnapshot = readAdvisorInputSnapshot(value.state, value.job.id)
    const phaseLog = join(value.root, 'scoped-ui-phases.log')
    let processExits = 0

    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-ui-approved',
        ZERO_PHASE_LOG: phaseLog,
      },
      phaseGateForTesting: {},
      uiApproval: {
        requestId: 'ui-scope-request',
        requestInputRevision: inputSnapshot.revision,
        requestInputDigest: inputSnapshot.digest,
        responseInputRevision: inputSnapshot.revision,
        responseInputDigest: inputSnapshot.digest,
        responseMessageId: '1800000000.000200',
        responseText: '承認する',
        responseAfterPrompt: true,
        repositoryDigest: advisorRepositoryDigest(proposalSnapshot),
        repositorySnapshot: proposalSnapshot,
        repositoryScope: ['frontend'],
        repositoryScopeDigest: advisorRepositoryScopeDigest(
          proposalSnapshot,
          ['frontend'],
        ),
        proposalText: 'frontendの待機画面を更新します。',
      },
      onProcessExit: () => {
        processExits += 1
        if (processExits === 1) {
          writeFileSync(join(backend, 'tracked.txt'), 'concurrent backend change\n', {
            mode: 0o600,
          })
        } else if (processExits === 3) {
          writeFileSync(join(backend, 'tracked.txt'), 'backend changed during review\n', {
            mode: 0o600,
          })
        }
      },
      liveControls: value.hooks,
    })

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    const stages = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t')[0])
    expect(stages).toEqual(['prepare', 'implementation', 'review'])
    expect(stages.filter(stage => stage === 'prepare')).toHaveLength(1)
    expect(processExits).toBe(3)
    value.store.close()
  }, 30_000)

  test('UI承認済みjobもprepare後の対象repo更新をCodexへ委ね同じturnを継続する', async () => {
    const value = fixture('phased-ui-approved', true)
    const makeRepository = (name: string): string => {
      const repository = join(value.repo, name)
      mkdirSync(repository)
      git(repository, ['init', '-q'])
      git(repository, ['config', 'user.name', 'Zero Test'])
      git(repository, ['config', 'user.email', 'zero@example.invalid'])
      writeFileSync(join(repository, 'tracked.txt'), `${name}\n`, { mode: 0o600 })
      git(repository, ['add', '.'])
      git(repository, ['commit', '-qm', 'initial'])
      return repository
    }
    makeRepository('backend')
    const frontend = makeRepository('frontend')
    const layout = resolveAdvisorProjectLayout(value.repo)
    const proposalSnapshot = snapshotAdvisorRepository(layout)
    const inputSnapshot = readAdvisorInputSnapshot(value.state, value.job.id)
    const phaseLog = join(value.root, 'scoped-ui-target-drift-phases.log')
    let processExits = 0

    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-ui-approved',
        ZERO_PHASE_LOG: phaseLog,
      },
      phaseGateForTesting: {},
      uiApproval: {
        requestId: 'ui-target-drift-request',
        requestInputRevision: inputSnapshot.revision,
        requestInputDigest: inputSnapshot.digest,
        responseInputRevision: inputSnapshot.revision,
        responseInputDigest: inputSnapshot.digest,
        responseMessageId: '1800000000.000201',
        responseText: '承認する',
        responseAfterPrompt: true,
        repositoryDigest: advisorRepositoryDigest(proposalSnapshot),
        repositorySnapshot: proposalSnapshot,
        repositoryScope: ['frontend'],
        repositoryScopeDigest: advisorRepositoryScopeDigest(
          proposalSnapshot,
          ['frontend'],
        ),
        proposalText: 'frontendの待機画面を更新します。',
      },
      onProcessExit: () => {
        processExits += 1
        if (processExits === 1) {
          writeFileSync(join(frontend, 'tracked.txt'), 'concurrent frontend change\n', {
            mode: 0o600,
          })
        }
      },
      liveControls: value.hooks,
    })

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    const stages = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t')[0])
    expect(stages).toEqual(['prepare', 'implementation', 'review'])
    expect(stages.filter(stage => stage === 'prepare')).toHaveLength(1)
    expect(readFileSync(join(frontend, 'tracked.txt'), 'utf8'))
      .toBe('concurrent frontend change\n')
    expect(value.store.get(value.job.id)?.attempts).toBe(1)
    expect(value.store.writePhaseMayHaveBeenDelivered(value.job.id)).toBe(true)
    value.store.close()
  }, 30_000)

  test('fresh Slack jobは未materialize履歴APIを呼ばず空baselineでpublication gateを通す', async () => {
    const value = fixture('phased-native-history-fresh', true)
    const rpcLog = join(value.root, 'native-history-fresh-rpc.log')
    const gateStages: string[] = []
    expect(value.job).toMatchObject({ seq: 1, sessionId: null, resumed: false })

    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-native-history-fresh',
        ZERO_RPC_LOG: rpcLog,
        ZERO_LOG_HANDSHAKES: '1',
      },
      phaseGateForTesting: {},
      nativeAdvisorHistoryFixtureForTesting: async evidence => {
        gateStages.push(evidence.stage)
        expect(evidence.parentThreadId).toBe('thread-app-server-1')
        expect(evidence.parentChildBaseline).toEqual([])
        expect(evidence.parentTurnBaseline).toEqual([])
        expect(evidence.parentTurnIds).toHaveLength(evidence.stage === 'prepare' ? 1 : 3)
        const parentTurns = evidence.parentTurnIds.map(id => ({
          id,
          status: 'completed',
          itemsView: 'full',
          items: [],
          error: null,
        }))
        const parent = {
          id: evidence.parentThreadId,
          parentThreadId: null,
          cwd: evidence.repoPath,
          source: evidence.parentSource,
        }
        return {
          rounds: [],
          readForTesting: async (method, params) => {
            if (method === 'thread/list') return { data: [], nextCursor: null }
            if (method === 'thread/read') {
              return {
                thread: params.includeTurns === true
                  ? { ...parent, turns: parentTurns }
                  : parent,
              }
            }
            if (method === 'thread/turns/list') {
              return { data: parentTurns, nextCursor: null }
            }
            const selected = parentTurns.find(turn => turn.id === params.turnId)
            return {
              data: (selected?.items ?? []).map(item => ({ turnId: params.turnId, item })),
              nextCursor: null,
            }
          },
        }
      },
      liveControls: value.hooks,
    })

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    expect(gateStages).toEqual(['prepare', 'review'])
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rpc.filter(entry => entry.method === 'thread/start')).toHaveLength(1)
    expect(rpc.filter(entry => entry.method === 'thread/resume')).toHaveLength(2)
    expect(rpc.filter(entry => entry.method === 'turn/start')).toHaveLength(3)
    expect(rpc.filter(entry => entry.method === 'thread/list')).toHaveLength(0)
    expect(rpc.filter(entry => entry.method === 'thread/turns/list')).toHaveLength(0)
    completeFixtureJob(value.store, value.job, result.sessionId, result.result)
    expect(value.store.get(value.job.id)?.status).toBe('completed')
    value.store.close()
  }, 30_000)

  test('同じSlack threadの再開jobは過去親turnを継承してnative履歴gateを通す', async () => {
    const value = fixture('phased-native-history-resume', true)
    const rpcLog = join(value.root, 'native-history-resume-rpc.log')
    const gateStages: string[] = []
    expect(value.job).toMatchObject({
      seq: 2,
      sessionId: 'thread-app-server-1',
      resumed: true,
    })

    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-native-history-resume',
        ZERO_RPC_LOG: rpcLog,
        ZERO_LOG_HANDSHAKES: '1',
      },
      phaseGateForTesting: {},
      nativeAdvisorHistoryFixtureForTesting: async evidence => {
        gateStages.push(evidence.stage)
        expect(evidence.parentThreadId).toBe('thread-app-server-1')
        expect(evidence.parentChildBaseline).toEqual(['historical-child'])
        expect(evidence.parentTurnBaseline).toEqual([{
          id: 'historical-parent-turn', status: 'completed',
        }])
        expect(evidence.parentTurnIds).toHaveLength(evidence.stage === 'prepare' ? 1 : 3)

        const phase = evidence.stage === 'prepare' ? 'investigation' : 'review'
        const childSpecs = (['solution', 'risk'] as const).map(perspective => ({
          id: `${evidence.stage}-${perspective}-child`,
          perspective,
          role: perspective === 'solution' ? 'solution_analyst' : 'risk_reviewer',
        }))
        const response = (perspective: 'solution' | 'risk') => (
          `${perspective} ${evidence.stage} response\n${nativeAdvisorMarker(
            evidence.attemptNonce,
            evidence.input.revision,
            evidence.input.digest,
            phase,
            evidence.reviewRound,
            perspective,
          )}`
        )
        const rounds: NativeAdvisorRoundEvidence[] = [{
          inputRevision: evidence.input.revision,
          inputDigest: evidence.input.digest,
          phase,
          round: evidence.reviewRound,
          native: childSpecs.map(child => ({
            perspective: child.perspective,
            agentId: child.id,
            responseDigest: nativeAdvisorResponseDigest(response(child.perspective)),
          })),
        }]
        const parentTurns = [
          {
            id: 'historical-parent-turn', status: 'completed',
            itemsView: 'full', items: [], error: null,
          },
          ...evidence.parentTurnIds.map((id, index) => ({
            id,
            status: 'completed',
            itemsView: 'full',
            items: index === evidence.parentTurnIds.length - 1
              ? childSpecs.map(child => ({
                type: 'subAgentActivity',
                id: `${child.id}-activity`,
                kind: 'started',
                agentThreadId: child.id,
              }))
              : [],
            error: null,
          })),
        ]
        const metadata = new Map<string, Record<string, unknown>>([
          [evidence.parentThreadId, {
            id: evidence.parentThreadId,
            parentThreadId: null,
            cwd: evidence.repoPath,
            source: evidence.parentSource,
          }],
          ['historical-child', {
            id: 'historical-child',
            parentThreadId: evidence.parentThreadId,
            cwd: evidence.repoPath,
            source: { subAgent: { thread_spawn: {
              parent_thread_id: evidence.parentThreadId,
              depth: 1,
              agent_role: 'solution_analyst',
            } } },
            agentRole: 'solution_analyst',
          }],
          ...childSpecs.map(child => [child.id, {
            id: child.id,
            parentThreadId: evidence.parentThreadId,
            cwd: evidence.repoPath,
            source: { subAgent: { thread_spawn: {
              parent_thread_id: evidence.parentThreadId,
              depth: 1,
              agent_role: child.role,
            } } },
            agentRole: child.role,
          }] as [string, Record<string, unknown>]),
        ])
        const turns = new Map<string, Array<Record<string, unknown>>>([
          [evidence.parentThreadId, parentTurns],
          ['historical-child', []],
          ...childSpecs.map(child => [child.id, [
            ...parentTurns.map(turn => ({ ...turn, items: [] })),
            {
              id: `${child.id}-owned-turn`,
              status: 'completed',
              itemsView: 'full',
              items: [{
                type: 'agentMessage',
                id: `${child.id}-final`,
                phase: 'final_answer',
                text: response(child.perspective),
              }],
              error: null,
            },
          ]] as [string, Array<Record<string, unknown>>]),
        ])
        const directChildren = [
          { id: 'historical-child', parentThreadId: evidence.parentThreadId },
          ...childSpecs.map(child => ({
            id: child.id, parentThreadId: evidence.parentThreadId,
          })),
        ]
        const readForTesting = async (
          method: 'thread/read' | 'thread/list' | 'thread/turns/list' | 'thread/items/list',
          params: Record<string, unknown>,
        ): Promise<Record<string, unknown>> => {
          const threadId = String(params.threadId ?? '')
          if (method === 'thread/list') {
            return {
              data: params.parentThreadId === evidence.parentThreadId ? directChildren : [],
              nextCursor: null,
            }
          }
          const thread = metadata.get(threadId)
          if (!thread) throw new Error(`fixture omitted native thread ${threadId}`)
          const threadTurns = turns.get(threadId) ?? []
          if (method === 'thread/read') {
            return {
              thread: params.includeTurns === true
                ? { ...thread, turns: threadTurns }
                : thread,
            }
          }
          if (method === 'thread/turns/list') {
            return { data: threadTurns, nextCursor: null }
          }
          const selected = threadTurns.find(turn => turn.id === params.turnId)
          const items = Array.isArray(selected?.items) ? selected.items : []
          return {
            data: items.map(item => ({ turnId: params.turnId, item })),
            nextCursor: null,
          }
        }

        return { rounds, readForTesting }
      },
      liveControls: value.hooks,
    })

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    expect(gateStages).toEqual(['prepare', 'review'])
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const firstTurnStart = rpc.findIndex(entry => entry.method === 'turn/start')
    const turnBaseline = rpc.findIndex(entry => entry.method === 'thread/turns/list')
    expect(firstTurnStart).toBeGreaterThan(turnBaseline)
    expect(turnBaseline).toBeGreaterThanOrEqual(0)
    expect(rpc.filter(entry => entry.method === 'thread/turns/list')).toHaveLength(1)
    expect(rpc.filter(entry => entry.method === 'thread/resume')).toHaveLength(3)
    completeFixtureJob(value.store, value.job, result.sessionId, result.result)
    expect(value.store.get(value.job.id)?.status).toBe('completed')
    value.store.close()
  }, 30_000)

  test('resume threadの未materialize履歴はwarningへ弱めてprimary結果を公開する', async () => {
    const value = fixture('phased-native-history-resume-unmaterialized', true)
    const rpcLog = join(value.root, 'native-history-resume-unmaterialized-rpc.log')
    let gateCalls = 0
    const warnings: string[] = []
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-native-history-resume-unmaterialized',
        ZERO_RPC_LOG: rpcLog,
        ZERO_LOG_HANDSHAKES: '1',
      },
      phaseGateForTesting: {},
      nativeAdvisorHistoryFixtureForTesting: async () => {
        gateCalls += 1
        throw new Error('publication gate must not run')
      },
      onStderrChunk: value => warnings.push(Buffer.from(value).toString('utf8')),
      liveControls: value.hooks,
    })
    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    expect(gateCalls).toBe(2)
    expect(warnings.join('')).toContain('[Zero advisor warning] parent-turn-baseline')
    expect(warnings.join('')).toContain('[Zero advisor warning] preparation-history')
    expect(warnings.join('')).toContain('[Zero advisor warning] review-history')
    expect(warnings.join('')).not.toContain('publication gate must not run')
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rpc.filter(entry => entry.method === 'thread/resume')).toHaveLength(3)
    expect(rpc.filter(entry => entry.method === 'thread/turns/list')).toHaveLength(1)
    expect(rpc.filter(entry => entry.method === 'turn/start')).toHaveLength(3)
    expect(value.store.get(value.job.id)?.status).toBe('running')
    value.store.close()
  }, 30_000)

  test('native履歴fixtureはproduction executorの検証を置換できない', async () => {
    const value = fixture('phased-native-history-resume', true)
    await expect(executeCodexJob(value.job, {
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      nativeAdvisorHistoryFixtureForTesting: async () => {
        throw new Error('fixture callback must not run')
      },
      liveControls: value.hooks,
    })).rejects.toThrow(
      'nativeAdvisorHistoryFixtureForTesting cannot replace production advisor verification',
    )
    value.store.close()
  })

  test('再開jobのnative履歴不一致はwarningに閉じてprimary結果を公開する', async () => {
    const value = fixture('phased-native-history-resume', true)
    let gateCalls = 0
    const warnings: string[] = []
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'phased-native-history-resume' },
      phaseGateForTesting: {},
      nativeAdvisorHistoryFixtureForTesting: async evidence => {
        gateCalls += 1
        return {
          rounds: [],
          readForTesting: async method => (
            method === 'thread/read'
              ? { thread: {
                id: evidence.parentThreadId,
                parentThreadId: null,
                cwd: evidence.repoPath,
                source: evidence.parentSource,
                turns: [],
              } }
              : { data: [], nextCursor: null }
          ),
        }
      },
      onStderrChunk: value => warnings.push(Buffer.from(value).toString('utf8')),
      liveControls: value.hooks,
    })
    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    expect(gateCalls).toBe(2)
    expect(warnings.join('')).toContain('[Zero advisor warning] preparation-history')
    expect(warnings.join('')).toContain('[Zero advisor warning] review-history')
    expect(warnings.join('')).not.toContain('omitted completed turn')
    expect(value.store.get(value.job.id)?.status).toBe('running')
    value.store.close()
  }, 30_000)

  test('read-only質問は補助レビュー履歴を照合できなくてもprimary回答を返す', async () => {
    const value = fixture('normal', false)
    const warnings: string[] = []
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'normal' },
      nativeAdvisorHistoryFixtureForTesting: async () => {
        throw new Error('saved advisor history is unavailable')
      },
      onStderrChunk: value => warnings.push(Buffer.from(value).toString('utf8')),
      liveControls: value.hooks,
    })
    expect(result).toEqual({ sessionId: 'thread-app-server-1', result: '通常完了' })
    expect(warnings.join('')).toContain('[Zero advisor warning] completion-history')
    expect(warnings.join('')).not.toContain('saved advisor history is unavailable')
    expect(value.store.get(value.job.id)?.status).toBe('running')
    value.store.close()
  }, 15_000)

  test('write jobの消失resume先は初回prepare未送達ならcold startして履歴を一度だけ注入する', async () => {
    const value = fixture('missing-session-resume', true)
    const rpcLog = join(value.root, 'missing-session-rpc.log')
    const promptLog = join(value.root, 'missing-session-prompts.log')
    const resumedJob = {
      ...value.job,
      seq: 2,
      sessionId: 'thread-provider-missing',
      resumed: true,
    }
    const threadHistory = createDurableThreadHistorySnapshot({
      jobId: resumedJob.id,
      attempt: resumedJob.attempts,
      chatId: resumedJob.chatId,
      threadTs: resumedJob.threadTs,
      repoPath: resumedJob.repoPath,
      currentJobSeq: resumedJob.seq,
      createdAt: Date.now(),
      archives: [createThreadHistoryArchive({
        jobId: 'prior-write-job',
        jobSeq: 1,
        chatId: resumedJob.chatId,
        threadTs: resumedJob.threadTs,
        repoPath: resumedJob.repoPath,
        outcome: 'completed',
        finishedAt: Date.now() - 1,
        events: [{ order: 0, kind: 'result', text: '前回の実装結果を引き継ぐ' }],
      })],
    })
    let resets = 0
    const result = await executeCodexJob(resumedJob, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'missing-session-resume',
        ZERO_RPC_LOG: rpcLog,
        ZERO_PROMPT_LOG: promptLog,
        ZERO_LOG_HANDSHAKES: '1',
      },
      phaseGateForTesting: {},
      onSessionReset: () => { resets += 1 },
      liveControls: value.hooks,
      threadHistory,
    })

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    expect(resets).toBe(1)
    const methods = readFileSync(rpcLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line).method)
      .filter(method => method === 'thread/start' || method === 'thread/resume')
    expect(methods).toEqual([
      'thread/resume', 'thread/start', 'thread/resume', 'thread/resume',
    ])
    const prompts = readFileSync(promptLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { stage: string, text: string })
    expect(prompts.map(prompt => prompt.stage)).toEqual(['prepare', 'implementation', 'review'])
    expect(prompts[0]!.text).toContain('Prior Slack thread history')
    expect(prompts[0]!.text).toContain('前回の実装結果を引き継ぐ')
    expect(prompts.slice(1).every(prompt => !prompt.text.includes('Prior Slack thread history')))
      .toBe(true)
    value.store.close()
  }, 30_000)

  test('prepare完了後のdurable中止はwrite supervisorを起動しない', async () => {
    const value = fixture('phased', true)
    const processIds: number[] = []
    let staged = false
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'phased' },
      phaseGateForTesting: {
        validatePreparation: () => {
          const target = value.store.interruptControlTarget(
            value.job.chatId,
            value.job.threadTs,
          )
          if (!target) throw new Error('pre-write interrupt target disappeared')
          expect(value.store.stageLiveControl(target, {
            chatId: value.job.chatId,
            threadTs: value.job.threadTs,
            messageId: '1800000000.000150',
            userId: 'UOTHER',
            task: '中止',
            kind: 'interrupt',
          })).toBe('staged')
          staged = true
        },
      },
      onProcessId: processId => { processIds.push(processId) },
      liveControls: value.hooks,
    })).rejects.toBeInstanceOf(CodexUserCancelledError)
    expect(staged).toBe(true)
    expect(processIds).toHaveLength(1)
    expect(existsSync(join(value.state, 'executors', `${value.job.id}.json`))).toBe(false)
    value.store.close()
  }, 15_000)

  test('write phase中の別user返信を同じturnへsteerしてRO準備から再開する', async () => {
    const value = fixture('phased-steer', true)
    const phaseLog = join(value.root, 'steered-phase-processes.log')
    const controlLog = join(value.root, 'steered-controls.log')
    const promptLog = join(value.root, 'steered-prompts.log')
    const processIds: number[] = []
    const gates: string[] = []
    let staged = false
    const acknowledgePhase = value.hooks.acknowledgePhaseDispatch!
    value.hooks.acknowledgePhaseDispatch = options => {
      acknowledgePhase(options)
      if (!staged && options.phaseSequence === 1) {
        staged = true
        const target = value.store.liveControlTarget(value.job.chatId, value.job.threadTs)
        if (!target) throw new Error('phased live control target disappeared')
        expect(value.store.stageLiveControl(target, {
          chatId: value.job.chatId,
          threadTs: value.job.threadTs,
          messageId: '1800000000.000900',
          userId: 'UOTHER',
          writeEnabled: false,
          task: '別fileも削除して',
          kind: 'steer',
        })).toBe('staged')
      }
    }

    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-steer',
        ZERO_PHASE_LOG: phaseLog,
        ZERO_CONTROL_LOG: controlLog,
        ZERO_PROMPT_LOG: promptLog,
      },
      phaseGateForTesting: {
        validatePreparation: input => {
          gates.push(`prepare-r${input.revision}`)
          if (input.revision === 2) {
            expect(input.entries.map(entry => entry.userId)).toEqual(['UROOT', 'UOTHER'])
            expect(input.entries.map(entry => entry.writeEnabled)).toEqual([true, false])
            expect(input.transcript).toContain('Sender: UOTHER')
            expect(input.transcript).toContain('別fileも削除して')
          }
        },
        validateReview: (input, _digest, round) => {
          gates.push(`review-r${input.revision}-${round}`)
          expect(input.entries.map(entry => entry.userId)).toEqual(['UROOT', 'UOTHER'])
          expect(input.transcript).toContain('別fileも削除して')
        },
      },
      onProcessId: processId => { processIds.push(processId) },
      liveControls: value.hooks,
    })

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    expect(gates).toEqual(['prepare-r1', 'prepare-r2', 'review-r2-1'])
    expect(processIds).toHaveLength(5)
    expect(new Set(processIds).size).toBe(5)
    const phaseRows = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t'))
    expect(phaseRows.map(row => row[0])).toEqual([
      'prepare', 'implementation', 'prepare', 'implementation', 'review',
    ])
    expect(phaseRows.map(row => row[2])).toEqual(Array(5).fill('thread-app-server-1'))
    expect(phaseRows.map(row => row[3])).toEqual([
      'thread/start', 'thread/resume', 'thread/resume', 'thread/resume', 'thread/resume',
    ])
    expect(phaseRows.map(row => row[4])).toEqual(['read', 'write', 'read', 'write', 'read'])
    const controls = readFileSync(controlLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(controls).toHaveLength(1)
    expect(controls[0]).toMatchObject({
      method: 'turn/steer',
      threadId: 'thread-app-server-1',
    })
    expect(controls[0].expectedTurnId).toContain('turn-app-server-implementation-')
    expect(controls[0].text).toContain('write-phase preemption')
    expect(controls[0].text).not.toContain('UOTHER')
    expect(controls[0].text).not.toContain('別fileも削除して')
    const prompts = readFileSync(promptLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const implementationPrompts = prompts.filter(value => value.stage === 'implementation')
    expect(implementationPrompts).toHaveLength(2)
    expect(implementationPrompts[0].text).not.toContain('UOTHER')
    expect(implementationPrompts[1].text).toContain('Sender: UOTHER')
    expect(implementationPrompts[1].text).toContain('別fileも削除して')
    expect(value.store.listJobControls(value.job.id)).toHaveLength(1)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      userId: 'UOTHER', writeEnabled: false, kind: 'steer', status: 'observed', inputRevision: 2,
    })
    expect(value.store.get(value.job.id)?.acceptsControl).toBe(false)
    value.store.close()
  }, 30_000)

  test('write phaseを退役してread-onlyで回答後に配送済み更新だけをfresh準備から再開する', async () => {
    const value = fixture('phased-interjection-update', true)
    const phaseLog = join(value.root, 'interjection-write-phases.log')
    const promptLog = join(value.root, 'interjection-write-prompts.log')
    const fixtureState = join(value.root, 'interjection-write.state')
    const processIds: number[] = []
    const gates: string[] = []
    let staged = false
    const acknowledgePhase = value.hooks.acknowledgePhaseDispatch!
    value.hooks.acknowledgePhaseDispatch = options => {
      acknowledgePhase(options)
      if (staged || options.phaseSequence !== 1) return
      staged = true
      const target = value.store.liveControlTarget(value.job.chatId, value.job.threadTs)
      if (!target) throw new Error('write interjection target disappeared')
      expect(value.store.stageLiveInterjection(target, {
        chatId: value.job.chatId,
        threadTs: value.job.threadTs,
        messageId: '1800000000.000910',
        userId: 'UOTHER',
        writeEnabled: false,
        task: '追加で上限を120秒に変えてください',
      })).toBe('staged')
    }
    const promoteAnswer = value.hooks.promoteInterjection!
    value.hooks.promoteInterjection = interjection => {
      expect(value.store.interjectionIsDelivered(interjection.id)).toBe(true)
      return promoteAnswer(interjection)
    }

    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-interjection-update',
        ZERO_PHASE_LOG: phaseLog,
        ZERO_PROMPT_LOG: promptLog,
        ZERO_INTERJECTION_FIXTURE_STATE: fixtureState,
      },
      phaseGateForTesting: {
        validatePreparation: input => {
          gates.push(`prepare-r${input.revision}`)
          if (input.revision === 2) {
            expect(input.transcript).toContain('追加で上限を120秒に変えてください')
          }
        },
        validateReview: (input, _digest, round) => {
          gates.push(`review-r${input.revision}-${round}`)
          expect(input.transcript).toContain('追加で上限を120秒に変えてください')
        },
      },
      onProcessId: processId => { processIds.push(processId) },
      liveControls: value.hooks,
    })

    const notification = await waitForInterjectionNotification(value.store)
    expect(value.store.get(value.job.id)?.inputRevision).toBe(1)
    expect(value.store.listJobControls(value.job.id)).toHaveLength(0)
    expect(value.store.listJobInterjections(value.job.id)[0]).toMatchObject({
      status: 'answered',
      disposition: 'task-update',
    })
    value.store.markInterjectionNotificationDelivered(notification.id)
    const result = await execution

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    expect(gates).toEqual(['prepare-r1', 'prepare-r2', 'review-r2-1'])
    expect(processIds).toHaveLength(6)
    expect(new Set(processIds).size).toBe(6)
    const phases = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t'))
    expect(phases.map(row => row[0])).toEqual([
      'prepare', 'implementation', 'interjection',
      'prepare', 'implementation', 'review',
    ])
    expect(phases.map(row => row[2])).toEqual(Array(6).fill('thread-app-server-1'))
    expect(phases.map(row => row[3])).toEqual([
      'thread/start', 'thread/resume', 'thread/resume',
      'thread/resume', 'thread/resume', 'thread/resume',
    ])
    expect(phases.map(row => row[4])).toEqual([
      'read', 'write', 'read', 'read', 'write', 'read',
    ])
    const prompts = readFileSync(promptLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { stage: string, text: string })
    const implementations = prompts.filter(prompt => prompt.stage === 'implementation')
    expect(implementations).toHaveLength(2)
    expect(implementations[0]!.text).not.toContain('追加で上限を120秒に変えてください')
    expect(implementations[1]!.text).toContain('追加で上限を120秒に変えてください')
    expect(prompts.find(prompt => prompt.stage === 'interjection')?.text)
      .toContain('追加で上限を120秒に変えてください')
    expect(value.store.get(value.job.id)?.inputRevision).toBe(2)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      kind: 'steer',
      status: 'observed',
      inputRevision: 2,
      task: '追加で上限を120秒に変えてください',
    })
    expect(value.store.listJobInterjections(value.job.id)[0]).toMatchObject({
      status: 'promoted',
      disposition: 'task-update',
    })
    value.store.close()
  }, 30_000)

  test('write terminal境界の未処理Slack返信をdrain後にfresh RO準備から再開する', async () => {
    const value = fixture('phased-late-inbound', true)
    const phaseLog = join(value.root, 'late-inbound-phase-processes.log')
    const processIds: number[] = []
    const gates: string[] = []
    let stagedAtTerminal = false
    const finishTurn = value.hooks.finishTurn
    value.hooks.finishTurn = options => {
      if (!finishTurn) throw new Error('finishTurn fixture hook is missing')
      if (stagedAtTerminal || !options.turnId.includes('implementation')) {
        return finishTurn(options)
      }
      stagedAtTerminal = true
      value.store.stageInboundDelivery({
        chatId: value.job.chatId,
        threadTs: value.job.threadTs,
        messageId: '1800000000.000950',
        userId: 'UOTHER',
        repoPath: value.job.repoPath,
        text: 'terminal直前に別fileも変更して',
        writeEnabled: false,
      })
      const barrier = finishTurn(options)
      expect(barrier).toMatchObject({ pending: 0, pendingInbound: 1 })
      expect(value.store.get(value.job.id)?.activeTurnId).toBe(options.turnId)

      // Model the gateway drain that races with the terminal barrier: the
      // inbound row becomes canonical live control before the executor polls
      // the same terminal receipt again.
      const inbound = value.store.claimNextInboundDelivery()!
      const target = value.store.liveControlTarget(inbound.chatId, inbound.threadTs)!
      expect(value.store.stageLiveControl(target, {
        chatId: inbound.chatId,
        threadTs: inbound.threadTs,
        messageId: inbound.messageId,
        userId: inbound.userId,
        writeEnabled: inbound.writeEnabled,
        task: inbound.text,
        kind: 'steer',
      })).toBe('staged')
      value.store.completeInboundDelivery(inbound.idempotencyKey)
      return barrier
    }

    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'phased-late-inbound',
        ZERO_PHASE_LOG: phaseLog,
      },
      phaseGateForTesting: {
        validatePreparation: input => {
          gates.push(`prepare-r${input.revision}`)
          if (input.revision === 2) {
            expect(input.entries.map(entry => entry.userId)).toEqual(['UROOT', 'UOTHER'])
            expect(input.transcript).toContain('terminal直前に別fileも変更して')
          }
        },
        validateReview: (input, _digest, round) => {
          gates.push(`review-r${input.revision}-${round}`)
        },
      },
      onProcessId: processId => { processIds.push(processId) },
      liveControls: value.hooks,
    })

    expect(result).toMatchObject({ sessionId: 'thread-app-server-1', result: '公開できます' })
    expect(stagedAtTerminal).toBe(true)
    expect(gates).toEqual(['prepare-r1', 'prepare-r2', 'review-r2-1'])
    expect(processIds).toHaveLength(5)
    expect(new Set(processIds).size).toBe(5)
    expect(readFileSync(phaseLog, 'utf8').trim().split('\n').map(line => line.split('\t')[0]))
      .toEqual(['prepare', 'implementation', 'prepare', 'implementation', 'review'])
    expect(value.store.listJobControls(value.job.id)).toEqual([
      expect.objectContaining({
        userId: 'UOTHER', kind: 'steer', status: 'observed', inputRevision: 2,
      }),
    ])
    value.store.close()
  }, 30_000)

  test('旧1ms job timeout指定を越えてもApp Server jobを中断しない', async () => {
    const value = fixture('normal')
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'slow' },
      timeoutMs: 1,
      liveControls: value.hooks,
    })
    expect(result).toEqual({ sessionId: 'thread-app-server-1', result: '通常完了' })
    expect(value.store.get(value.job.id)?.acceptsControl).toBe(false)
    value.store.close()
  })

  test('summary terminalのstream済み最終回答も公式item journalで照合する', async () => {
    const value = fixture('summary-stream-no-history')
    const rpcLog = join(value.root, 'summary-stream-rpc.log')
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'summary-stream-no-history',
        ZERO_RPC_LOG: rpcLog,
      },
      liveControls: value.hooks,
    })
    expect(result).toEqual({ sessionId: 'thread-app-server-1', result: '履歴不要で完了' })
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rpc.map(value => value.method)).toEqual(['turn/start', 'thread/items/list'])
    value.store.close()
  })

  test('terminal本文ではなくsupported item journal本文だけを公開する', async () => {
    const value = fixture('history-authority')
    const rpcLog = join(value.root, 'history-authority-rpc.log')
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'history-authority',
        ZERO_RPC_LOG: rpcLog,
      },
      liveControls: value.hooks,
    })
    expect(result).toEqual({
      sessionId: 'thread-app-server-1', result: '公式journal回答',
    })
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rpc.map(value => value.method)).toEqual(['turn/start', 'thread/items/list'])
    value.store.close()
  })

  test('terminalにfinalがあってもsupported item journalのfinal欠落は公開しない', async () => {
    const value = fixture('history-missing-final')
    const rpcLog = join(value.root, 'history-missing-final-rpc.log')
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'history-missing-final',
        ZERO_RPC_LOG: rpcLog,
      },
      liveControls: value.hooks,
    })).rejects.toThrow('item journal did not provide a final persisted answer')
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rpc.map(value => value.method)).toEqual(['turn/start', 'thread/items/list'])
    value.store.close()
  })

  test('初回JSON write直前にinput revisionが進んだら未送信attemptを捨てて再読する', async () => {
    const value = fixture('normal')
    const begin = value.hooks.beginInitialDispatch
    let attempts = 0
    let loginChecks = 0
    value.hooks.beginInitialDispatch = options => {
      attempts += 1
      if (attempts === 1) return 'input-changed'
      return begin(options)
    }
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'normal' },
      subscriptionLoginCheckForTesting: () => { loginChecks += 1 },
      liveControls: value.hooks,
    })
    expect(attempts).toBe(2)
    expect(loginChecks).toBe(2)
    expect(result).toEqual({ sessionId: 'thread-app-server-1', result: '通常完了' })
    value.store.close()
  })

  test('同じthreadの別user返信をactive turnへsteerする', async () => {
    const value = fixture('steer')
    const processIds: number[] = []
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'steer' },
      onProcessId: processId => { processIds.push(processId) },
      liveControls: value.hooks,
    })
    expect(result.result).toBe('追加入力を反映しました')
    expect(processIds).toHaveLength(1)
    expect(value.store.listJobControls(value.job.id)).toHaveLength(1)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      userId: 'UOTHER', kind: 'steer', status: 'observed',
    })
    value.store.close()
  })

  test('同じthreadの質問へ先に回答してから元のtaskを同じCodex threadで再開する', async () => {
    const value = fixture('interjection-answer')
    const fixtureState = join(value.root, 'interjection-answer.state')
    const promptLog = join(value.root, 'interjection-answer-prompts.log')
    const phaseLog = join(value.root, 'interjection-answer-phases.log')
    const rpcLog = join(value.root, 'interjection-answer-rpc.log')
    const deliveryTrace: string[] = []
    const stageAnswer = value.hooks.stageInterjectionAnswer!
    const answerDelivered = value.hooks.interjectionDelivered!
    const promoteAnswer = value.hooks.promoteInterjection!
    value.hooks.stageInterjectionAnswer = options => {
      const disposition = stageAnswer(options)
      if (disposition === 'staged') deliveryTrace.push('staged')
      return disposition
    }
    value.hooks.interjectionDelivered = interjection => {
      const delivered = answerDelivered(interjection)
      if (delivered && !deliveryTrace.includes('delivered')) deliveryTrace.push('delivered')
      return delivered
    }
    value.hooks.promoteInterjection = interjection => {
      expect(answerDelivered(interjection)).toBe(true)
      deliveryTrace.push('promoted')
      return promoteAnswer(interjection)
    }

    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'interjection-answer',
        ZERO_INTERJECTION_FIXTURE_STATE: fixtureState,
        ZERO_PROMPT_LOG: promptLog,
        ZERO_PHASE_LOG: phaseLog,
        ZERO_RPC_LOG: rpcLog,
      },
      liveControls: value.hooks,
    })

    const notification = await waitForInterjectionNotification(value.store)
    expect(value.store.get(value.job.id)?.inputRevision).toBe(1)
    expect(value.store.listJobControls(value.job.id)).toHaveLength(0)
    expect(value.store.listJobInterjections(value.job.id)[0]).toMatchObject({
      status: 'answered',
      disposition: 'answer-only',
    })
    deliveryTrace.push('delivered')
    value.store.markInterjectionNotificationDelivered(notification.id)
    const result = await execution

    expect(result).toEqual({
      sessionId: 'thread-app-server-1',
      result: '元の作業を完了しました',
    })
    expect(readFileSync(fixtureState, 'utf8')).toBe('answer-only')
    expect(value.store.get(value.job.id)?.inputRevision).toBe(1)
    expect(value.store.listJobControls(value.job.id)).toHaveLength(0)
    expect(value.store.listJobInterjections(value.job.id)).toHaveLength(1)
    expect(value.store.listJobInterjections(value.job.id)[0]).toMatchObject({
      userId: 'UOTHER',
      task: '今はどこまで進んでいますか？',
      disposition: 'answer-only',
      answer: 'PDF処理はそのまま続いています 🔎',
      status: 'promoted',
    })
    expect(deliveryTrace).toEqual(['staged', 'delivered', 'promoted'])
    const prompts = readFileSync(promptLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { stage: string, text: string })
    expect(prompts.map(prompt => prompt.stage)).toEqual([
      'complete', 'interjection', 'complete',
    ])
    expect(prompts[0]!.text).not.toContain('今はどこまで進んでいますか？')
    expect(prompts[1]!.text).toContain('今はどこまで進んでいますか？')
    expect(prompts[2]!.text).not.toContain('今はどこまで進んでいますか？')
    const phases = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t'))
    expect(phases.map(row => row[0])).toEqual(['complete', 'interjection', 'complete'])
    expect(phases.map(row => row[3])).toEqual(['thread/start', 'thread/resume', 'thread/resume'])
    expect(new Set(phases.map(row => row[2])).size).toBe(1)
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { method: string })
    expect(rpc.filter(row => row.method === 'turn/start')).toHaveLength(3)
    expect(rpc.filter(row => row.method === 'turn/steer')).toHaveLength(1)
    value.store.close()
  }, 30_000)

  test('同じthreadの連続質問をSlack配送順に回答してから元taskを一度だけ再開する', async () => {
    const value = fixture('interjection-answer')
    const fixtureState = join(value.root, 'interjection-fifo.state')
    const promptLog = join(value.root, 'interjection-fifo-prompts.log')
    const phaseLog = join(value.root, 'interjection-fifo-phases.log')
    const rpcLog = join(value.root, 'interjection-fifo-rpc.log')
    const processIds: number[] = []

    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'interjection-answer',
        ZERO_INTERJECTION_FIXTURE_STATE: fixtureState,
        ZERO_PROMPT_LOG: promptLog,
        ZERO_PHASE_LOG: phaseLog,
        ZERO_RPC_LOG: rpcLog,
      },
      onProcessId: processId => { processIds.push(processId) },
      liveControls: value.hooks,
    })

    const firstNotification = await waitForInterjectionNotification(value.store)
    const target = value.store.liveControlTarget(value.job.chatId, value.job.threadTs)
    if (!target) throw new Error('second interjection target disappeared')
    expect(value.store.stageLiveInterjection(target, {
      chatId: value.job.chatId,
      threadTs: value.job.threadTs,
      messageId: '1800000000.000201',
      userId: 'UANOTHER',
      task: '続けて、完了までの見込みも教えてください',
    })).toBe('staged')
    expect(value.store.pendingInterjectionNotifications().map(row => row.id))
      .toEqual([firstNotification.id])

    value.store.markInterjectionNotificationDelivered(firstNotification.id)
    const secondNotification = await waitForInterjectionNotification(value.store)
    expect(secondNotification.id).not.toBe(firstNotification.id)
    expect(secondNotification.interjection.messageId).toBe('1800000000.000201')
    value.store.markInterjectionNotificationDelivered(secondNotification.id)

    const result = await execution
    expect(result).toEqual({
      sessionId: 'thread-app-server-1',
      result: '元の作業を完了しました',
    })
    expect(processIds).toHaveLength(4)
    expect(new Set(processIds).size).toBe(4)
    expect(value.store.get(value.job.id)?.inputRevision).toBe(1)
    expect(value.store.listJobControls(value.job.id)).toHaveLength(0)
    expect(value.store.listJobInterjections(value.job.id)).toMatchObject([
      { messageId: '1800000000.000200', status: 'promoted', disposition: 'answer-only' },
      { messageId: '1800000000.000201', status: 'promoted', disposition: 'answer-only' },
    ])
    const prompts = readFileSync(promptLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { stage: string, text: string })
    expect(prompts.map(prompt => prompt.stage)).toEqual([
      'complete', 'interjection', 'interjection', 'complete',
    ])
    expect(prompts[1]!.text).toContain('今はどこまで進んでいますか？')
    expect(prompts[1]!.text).not.toContain('完了までの見込み')
    expect(prompts[2]!.text).toContain('完了までの見込み')
    const phases = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t'))
    expect(phases.map(row => row[0])).toEqual([
      'complete', 'interjection', 'interjection', 'complete',
    ])
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { method: string })
    expect(rpc.filter(row => row.method === 'turn/start')).toHaveLength(4)
    expect(rpc.filter(row => row.method === 'turn/steer')).toHaveLength(1)
    value.store.close()
  }, 30_000)

  test('pause terminal時に受信処理中の次質問があってもdrain後にFIFO回答して元taskを再開する', async () => {
    const value = fixture('interjection-answer')
    const fixtureState = join(value.root, 'interjection-inbound-race.state')
    const phaseLog = join(value.root, 'interjection-inbound-race-phases.log')
    const finishTurn = value.hooks.finishTurn
    let stagedInbound = false
    value.hooks.finishTurn = options => {
      if (!finishTurn) throw new Error('finishTurn fixture hook is missing')
      if (stagedInbound) return finishTurn(options)
      stagedInbound = true
      expect(value.store.stageInboundDelivery({
        chatId: value.job.chatId,
        threadTs: value.job.threadTs,
        messageId: '1800000000.000201',
        userId: 'UANOTHER',
        repoPath: value.job.repoPath,
        text: '続けて、完了までの見込みも教えてください',
        writeEnabled: false,
      })).toBe(true)
      const barrier = finishTurn(options)
      expect(barrier).toMatchObject({ pendingInbound: 1 })
      expect(value.store.get(value.job.id)?.activeTurnId).toBe(options.turnId)

      const inbound = value.store.claimNextInboundDelivery()
      if (!inbound) throw new Error('fixture inbound delivery was not claimed')
      const target = value.store.liveControlTarget(inbound.chatId, inbound.threadTs)
      if (!target) throw new Error('fixture live target disappeared')
      expect(value.store.stageLiveInterjection(target, {
        chatId: inbound.chatId,
        threadTs: inbound.threadTs,
        messageId: inbound.messageId,
        userId: inbound.userId,
        task: inbound.text,
      })).toBe('staged')
      value.store.completeInboundDelivery(inbound.idempotencyKey)
      return barrier
    }

    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'interjection-answer',
        ZERO_INTERJECTION_FIXTURE_STATE: fixtureState,
        ZERO_PHASE_LOG: phaseLog,
      },
      liveControls: value.hooks,
    })

    const first = await waitForInterjectionNotification(value.store)
    expect(first.interjection.messageId).toBe('1800000000.000200')
    value.store.markInterjectionNotificationDelivered(first.id)
    const second = await waitForInterjectionNotification(value.store)
    expect(second.interjection.messageId).toBe('1800000000.000201')
    value.store.markInterjectionNotificationDelivered(second.id)

    expect(await execution).toEqual({
      sessionId: 'thread-app-server-1',
      result: '元の作業を完了しました',
    })
    expect(value.store.listJobInterjections(value.job.id)).toMatchObject([
      { messageId: '1800000000.000200', status: 'promoted', disposition: 'answer-only' },
      { messageId: '1800000000.000201', status: 'promoted', disposition: 'answer-only' },
    ])
    const phases = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t'))
    expect(phases.map(row => row[0])).toEqual([
      'complete', 'interjection', 'interjection', 'complete',
    ])
    value.store.close()
  }, 30_000)

  test('同じthreadの更新依頼は回答をSlackへ届けた後だけtaskへ昇格して再開する', async () => {
    const value = fixture('interjection-update')
    const fixtureState = join(value.root, 'interjection-update.state')
    const promptLog = join(value.root, 'interjection-update-prompts.log')
    const phaseLog = join(value.root, 'interjection-update-phases.log')
    const rpcLog = join(value.root, 'interjection-update-rpc.log')
    const deliveryTrace: string[] = []
    const stageAnswer = value.hooks.stageInterjectionAnswer!
    const answerDelivered = value.hooks.interjectionDelivered!
    const promoteAnswer = value.hooks.promoteInterjection!
    value.hooks.stageInterjectionAnswer = options => {
      const disposition = stageAnswer(options)
      if (disposition === 'staged') deliveryTrace.push('staged')
      return disposition
    }
    value.hooks.interjectionDelivered = interjection => {
      const delivered = answerDelivered(interjection)
      if (delivered && !deliveryTrace.includes('delivered')) deliveryTrace.push('delivered')
      return delivered
    }
    value.hooks.promoteInterjection = interjection => {
      expect(answerDelivered(interjection)).toBe(true)
      deliveryTrace.push('promoted')
      return promoteAnswer(interjection)
    }

    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'interjection-update',
        ZERO_INTERJECTION_FIXTURE_STATE: fixtureState,
        ZERO_PROMPT_LOG: promptLog,
        ZERO_PHASE_LOG: phaseLog,
        ZERO_RPC_LOG: rpcLog,
      },
      liveControls: value.hooks,
    })

    const notification = await waitForInterjectionNotification(value.store)
    expect(value.store.get(value.job.id)?.inputRevision).toBe(1)
    expect(value.store.listJobControls(value.job.id)).toHaveLength(0)
    expect(value.store.listJobInterjections(value.job.id)[0]).toMatchObject({
      status: 'answered',
      disposition: 'task-update',
    })
    deliveryTrace.push('delivered')
    value.store.markInterjectionNotificationDelivered(notification.id)
    const result = await execution

    expect(result).toEqual({
      sessionId: 'thread-app-server-1',
      result: '追加条件を反映して完了しました',
    })
    expect(readFileSync(fixtureState, 'utf8')).toBe('task-update')
    expect(value.store.get(value.job.id)?.inputRevision).toBe(2)
    expect(value.store.listJobControls(value.job.id)).toHaveLength(1)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      userId: 'UOTHER',
      task: '追加で上限を120秒に変えてください',
      kind: 'steer',
      status: 'observed',
      inputRevision: 2,
    })
    expect(value.store.listJobInterjections(value.job.id)[0]).toMatchObject({
      disposition: 'task-update',
      answer: '追加条件を取り込んで続けます 🛠️',
      status: 'promoted',
    })
    expect(deliveryTrace).toEqual(['staged', 'delivered', 'promoted'])
    const prompts = readFileSync(promptLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { stage: string, text: string })
    expect(prompts.map(prompt => prompt.stage)).toEqual([
      'complete', 'interjection', 'complete',
    ])
    expect(prompts[0]!.text).not.toContain('追加で上限を120秒に変えてください')
    expect(prompts[1]!.text).toContain('追加で上限を120秒に変えてください')
    expect(prompts[2]!.text).toContain('追加で上限を120秒に変えてください')
    const phases = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t'))
    expect(phases.map(row => row[0])).toEqual(['complete', 'interjection', 'complete'])
    expect(phases.map(row => row[3])).toEqual(['thread/start', 'thread/resume', 'thread/resume'])
    expect(new Set(phases.map(row => row[2])).size).toBe(1)
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { method: string })
    expect(rpc.filter(row => row.method === 'turn/start')).toHaveLength(3)
    expect(rpc.filter(row => row.method === 'turn/steer')).toHaveLength(1)
    value.store.close()
  }, 30_000)

  test('task-update回答の配送直後にexact中止されたら通常failureではなくcancelとして終了する', async () => {
    const value = fixture('interjection-update')
    const fixtureState = join(value.root, 'interjection-cancel-race.state')
    const promoteAnswer = value.hooks.promoteInterjection!
    let cancelledBeforePromotion = false
    value.hooks.promoteInterjection = interjection => {
      if (!cancelledBeforePromotion) {
        cancelledBeforePromotion = true
        const target = value.store.liveControlTarget(value.job.chatId, value.job.threadTs)
        if (!target) throw new Error('interjection cancellation target disappeared')
        expect(value.store.stageLiveControl(target, {
          chatId: value.job.chatId,
          threadTs: value.job.threadTs,
          messageId: '1800000000.000299',
          userId: 'UANOTHER',
          task: '中止',
          kind: 'interrupt',
        })).toBe('staged')
      }
      return promoteAnswer(interjection)
    }

    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'interjection-update',
        ZERO_INTERJECTION_FIXTURE_STATE: fixtureState,
      },
      liveControls: value.hooks,
    })

    const notification = await waitForInterjectionNotification(value.store)
    value.store.markInterjectionNotificationDelivered(notification.id)
    await expect(execution).rejects.toBeInstanceOf(CodexUserCancelledError)
    expect(cancelledBeforePromotion).toBe(true)
    expect(value.store.get(value.job.id)?.cancelRequestedAt).not.toBeNull()
    value.store.close()
  }, 30_000)

  test('元turnがterminal済みのlate質問へ回答して完了済みtaskを再実行しない', async () => {
    const value = fixture('interjection-late-answer')
    const phaseLog = join(value.root, 'late-interjection-phases.log')
    const rpcLog = join(value.root, 'late-interjection-rpc.log')
    const processIds: number[] = []
    let staged = false
    const finishTurn = value.hooks.finishTurn!
    value.hooks.finishTurn = options => {
      if (!staged) {
        staged = true
        expect(value.store.stageInboundDelivery({
          chatId: value.job.chatId,
          threadTs: value.job.threadTs,
          messageId: '1800000000.000920',
          userId: 'UOTHER',
          repoPath: value.job.repoPath,
          text: '完了した内容を一言で教えてください',
          writeEnabled: false,
        })).toBe(true)
        const inbound = value.store.claimNextInboundDelivery()
        if (!inbound) throw new Error('late interjection inbound was not claimed')
        const target = value.store.liveControlTarget(inbound.chatId, inbound.threadTs)
        if (!target) throw new Error('late interjection target disappeared')
        expect(value.store.stageLiveInterjection(target, {
          chatId: inbound.chatId,
          threadTs: inbound.threadTs,
          messageId: inbound.messageId,
          userId: inbound.userId,
          task: inbound.text,
        })).toBe('staged')
        const barrier = finishTurn(options)
        expect(barrier).toMatchObject({ pendingInbound: 1 })
        expect(value.store.get(value.job.id)?.activeTurnId).toBe(options.turnId)
        value.store.completeInboundDelivery(inbound.idempotencyKey)
        return barrier
      }
      return finishTurn(options)
    }

    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'interjection-late-answer',
        ZERO_PHASE_LOG: phaseLog,
        ZERO_RPC_LOG: rpcLog,
      },
      onProcessId: processId => { processIds.push(processId) },
      liveControls: value.hooks,
    })

    const notification = await waitForInterjectionNotification(value.store)
    expect(value.store.listJobInterjections(value.job.id)[0]).toMatchObject({
      status: 'answered',
      disposition: 'answer-only',
    })
    value.store.markInterjectionNotificationDelivered(notification.id)
    const result = await execution

    expect(result).toEqual({ sessionId: 'thread-app-server-1', result: '通常完了' })
    expect(processIds).toHaveLength(2)
    expect(new Set(processIds).size).toBe(2)
    const phases = readFileSync(phaseLog, 'utf8').trim().split('\n')
      .map(line => line.split('\t'))
    expect(phases.map(row => row[0])).toEqual(['complete', 'interjection'])
    expect(phases.map(row => row[3])).toEqual(['thread/start', 'thread/resume'])
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { method: string })
    expect(rpc.filter(row => row.method === 'turn/start')).toHaveLength(2)
    expect(rpc.filter(row => row.method === 'turn/steer')).toHaveLength(0)
    expect(value.store.get(value.job.id)?.inputRevision).toBe(1)
    expect(value.store.listJobControls(value.job.id)).toHaveLength(0)
    expect(value.store.listJobInterjections(value.job.id)[0]?.status).toBe('promoted')
    value.store.close()
  }, 30_000)

  test('定期進捗を新turnではなく同じactive turnへsteerしてcommentaryから公開する', async () => {
    const value = fixture('progress')
    const rpcLog = join(value.root, 'progress-rpc.log')
    const reports: Array<{ slot: number; elapsedMs: number; text: string }> = []
    const activatedAtMs = Date.now()
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'progress',
        ZERO_RPC_LOG: rpcLog,
      },
      progressActivatedAtMs: activatedAtMs,
      progressScheduleForTesting: {
        firstMs: 10,
        secondMs: 1_000,
        thirdMs: 2_000,
        repeatMs: 1_000,
      },
      onProgressProbeStarted: () => true,
      onProgressProbeSuperseded: () => {},
      onProgressReport: report => { reports.push(report); return true },
      liveControls: value.hooks,
    })

    expect(result).toEqual({
      sessionId: 'thread-app-server-1',
      result: 'Hello Worldアプリを作成しました ✅',
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      slot: 0,
      text: '画面を組み立てて、動作確認へ進んでいます 🛠️',
    })
    expect(reports[0]!.elapsedMs).toBeGreaterThanOrEqual(10)
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rpc.map(value => value.method)).toEqual([
      'turn/start', 'turn/steer', 'thread/items/list',
    ])
    expect(rpc.filter(value => value.method === 'turn/start')).toHaveLength(1)
    expect(rpc.filter(value => value.method === 'turn/steer')).toHaveLength(1)
    expect(rpc[1]).toMatchObject({
      method: 'turn/steer',
      expectedTurnId: 'turn-app-server-1',
    })
    value.store.close()
  }, 15_000)

  test('進捗ACKがtimeout後に届いても本体turnは正常完了する', async () => {
    const value = fixture('progress-late-ack')
    const reports: string[] = []
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'progress-late-ack' },
      progressActivatedAtMs: Date.now(),
      progressScheduleForTesting: {
        firstMs: 10, secondMs: 1_000, thirdMs: 2_000, repeatMs: 1_000,
      },
      progressSteerTimeoutMsForTesting: 20,
      onProgressProbeStarted: () => true,
      onProgressProbeSuperseded: () => {},
      onProgressReport: report => { reports.push(report.text); return true },
      liveControls: value.hooks,
    })
    expect(result.result).toBe('遅いACKの後も完了しました ✅')
    expect(reports).toEqual(['遅い応答でも作業を続けています 🔎'])
    value.store.close()
  }, 15_000)

  test('相関済み進捗rejectは同じdurable slotとclient idで再試行する', async () => {
    const value = fixture('progress-reject-once')
    const rpcLog = join(value.root, 'progress-reject-rpc.log')
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'progress-reject-once',
        ZERO_RPC_LOG: rpcLog,
      },
      progressActivatedAtMs: Date.now(),
      progressScheduleForTesting: {
        firstMs: 10, secondMs: 1_000, thirdMs: 2_000, repeatMs: 1_000,
      },
      progressProbeRetryMsForTesting: 10,
      onProgressProbeStarted: () => true,
      onProgressProbeSuperseded: () => {},
      onProgressReport: () => true,
      liveControls: value.hooks,
    })
    expect(result.result).toBe('進捗再試行後に完了しました ✅')
    const steers = readFileSync(rpcLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line))
      .filter(row => row.method === 'turn/steer')
    expect(steers).toHaveLength(2)
    expect(steers[0].clientUserMessageId).toBe(steers[1].clientUserMessageId)
    value.store.close()
  }, 15_000)

  test('進捗outbox staging失敗ではslotを進めず同じreportを再試行する', async () => {
    const value = fixture('progress')
    let stagingCalls = 0
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'progress' },
      progressActivatedAtMs: Date.now(),
      progressScheduleForTesting: {
        firstMs: 10, secondMs: 1_000, thirdMs: 2_000, repeatMs: 1_000,
      },
      progressPublishRetryMsForTesting: 10,
      onProgressProbeStarted: () => true,
      onProgressProbeSuperseded: () => {},
      onProgressReport: () => {
        stagingCalls += 1
        if (stagingCalls === 1) throw new Error('fixture sqlite busy')
        return true
      },
      liveControls: value.hooks,
    })
    expect(result.result).toBe('Hello Worldアプリを作成しました ✅')
    expect(stagingCalls).toBe(2)
    value.store.close()
  }, 15_000)

  test('進捗確認がfinal answerでturnを閉じた場合は完了として公開しない', async () => {
    const value = fixture('progress-final-answer')
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'progress-final-answer' },
      progressActivatedAtMs: Date.now(),
      progressScheduleForTesting: {
        firstMs: 10, secondMs: 1_000, thirdMs: 2_000, repeatMs: 1_000,
      },
      onProgressProbeStarted: () => true,
      onProgressProbeSuperseded: () => {},
      onProgressReport: () => true,
      liveControls: value.hooks,
    })).rejects.toThrow('progress status check terminated the active task turn')
    value.store.close()
  }, 15_000)

  test('進捗steerのACK待ち中でも同じthreadの中止を即時処理する', async () => {
    const value = fixture('progress-no-ack')
    const rpcLog = join(value.root, 'progress-no-ack-rpc.log')
    const startedAt = Date.now()
    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'progress-no-ack',
        ZERO_RPC_LOG: rpcLog,
      },
      progressActivatedAtMs: startedAt,
      progressScheduleForTesting: {
        firstMs: 10,
        secondMs: 1_000,
        thirdMs: 2_000,
        repeatMs: 1_000,
      },
      onProgressProbeStarted: () => true,
      onProgressProbeSuperseded: () => {},
      onProgressReport: () => true,
      liveControls: value.hooks,
    })
    await waitForRpcMethod(rpcLog, 'turn/steer')
    const target = value.store.interruptControlTarget(value.job.chatId, value.job.threadTs)
    expect(target).not.toBeNull()
    expect(value.store.stageLiveControl(target!, {
      chatId: value.job.chatId,
      threadTs: value.job.threadTs,
      messageId: 'progress-cancel',
      userId: 'UOTHER',
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')
    await expect(execution).rejects.toBeInstanceOf(CodexUserCancelledError)
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line).method))
      .toEqual(['turn/start', 'turn/steer', 'turn/interrupt'])
    value.store.cancel(value.job.id)
    value.store.close()
  }, 15_000)

  test('user返信の後に古い進捗を連投せず最新cadenceだけを公開する', async () => {
    const value = fixture('progress-collapse')
    const rpcLog = join(value.root, 'progress-collapse-rpc.log')
    const reports: Array<{ slot: number; elapsedMs: number; text: string }> = []
    // Keep activation in the near future so process startup cannot skip the
    // first synthetic cadence boundary on a slower CI host.
    const activatedAtMs = Date.now() + 3_000
    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'progress-collapse',
        ZERO_RPC_LOG: rpcLog,
      },
      progressActivatedAtMs: activatedAtMs,
      progressScheduleForTesting: {
        firstMs: 10,
        secondMs: 150,
        thirdMs: 5_000,
        repeatMs: 1_000,
      },
      onProgressProbeStarted: () => true,
      onProgressProbeSuperseded: () => {},
      onProgressReport: report => { reports.push(report); return true },
      liveControls: value.hooks,
    })
    await waitForRpcMethod(rpcLog, 'turn/steer')
    const target = value.store.liveControlTarget(value.job.chatId, value.job.threadTs)
    expect(target).not.toBeNull()
    expect(value.store.stageLiveControl(target!, {
      chatId: value.job.chatId,
      threadTs: value.job.threadTs,
      messageId: 'progress-user-steer',
      userId: 'UOTHER',
      task: 'そのまま続けて',
      kind: 'steer',
    })).toBe('staged')
    await expect(execution).resolves.toEqual({
      sessionId: 'thread-app-server-1',
      result: '完了しました ✅',
    })
    expect(reports.map(report => ({ slot: report.slot, text: report.text }))).toEqual([{
      slot: 1,
      text: '最新の状況を確認しています 🔎',
    }])
    expect(reports[0]!.elapsedMs).toBeGreaterThanOrEqual(150)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      kind: 'steer', status: 'observed', userId: 'UOTHER',
    })
    const methods = readFileSync(rpcLog, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line).method)
    expect(methods.filter(method => method === 'turn/start')).toHaveLength(1)
    expect(methods.filter(method => method === 'turn/steer')).toHaveLength(3)
    value.store.close()
  }, 15_000)

  test('同じthreadの中止をturn/interruptへ送りinterrupted terminalを要求する', async () => {
    const value = fixture('interrupt')
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'interrupt' },
      liveControls: value.hooks,
    })).rejects.toBeInstanceOf(CodexUserCancelledError)
    value.store.cancel(value.job.id)
    expect(value.store.get(value.job.id)).toMatchObject({
      status: 'failed', terminalOutcome: 'cancelled', acceptsControl: false,
    })
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      kind: 'interrupt', status: 'observed',
    })
    value.store.close()
  })

  test('terminalと同時にreadyの中止は未送信のままobservedにしない', async () => {
    const value = fixture('terminal-cancel-race')
    const rpcLog = join(value.root, 'terminal-cancel-race-rpc.log')
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'terminal-cancel-race',
        ZERO_RPC_LOG: rpcLog,
      },
      liveControls: value.hooks,
    })).rejects.toBeInstanceOf(CodexUserCancelledError)
    expect(readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line).method))
      .toEqual(['turn/start'])
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      kind: 'interrupt',
      status: 'ready',
      requestId: null,
      dispatchedAt: null,
      acknowledgedAt: null,
    })
    value.store.cancel(value.job.id)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      kind: 'interrupt',
      status: 'superseded',
      requestId: null,
      observedAt: null,
      lastError: expect.stringContaining('turn/interrupt was not dispatched'),
    })
    value.store.close()
  }, 15_000)

  test('中止ack後にterminalが欠落してもbounded graceでprocessを回収する', async () => {
    const value = fixture('interrupt-no-terminal')
    const processIds: number[] = []
    const exits: number[] = []
    const startedAt = Date.now()
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'interrupt-no-terminal',
        ZEROKUN_SUPERVISOR_TEST_CHILD_GRACE_MS: '100',
      },
      cancellationTerminalGraceMs: 100,
      supervisorCleanupGraceMs: 3_000,
      onProcessId: pid => { processIds.push(pid) },
      onProcessExit: code => { exits.push(code) },
      liveControls: value.hooks,
    })).rejects.toBeInstanceOf(CodexUserCancelledError)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(processIds).toHaveLength(1)
    expect(exits).toHaveLength(1)
    expect(() => process.kill(processIds[0]!, 0)).toThrow()
    value.store.cancel(value.job.id)
    expect(value.store.get(value.job.id)).toMatchObject({
      status: 'failed', terminalOutcome: 'cancelled', acceptsControl: false,
    })
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      kind: 'interrupt', status: 'acknowledged',
    })
    value.store.close()
  })

  test('中止ack後のhost強制回収が安全に完了すれば後続FIFOを止めない', async () => {
    const value = fixture('interrupt-no-terminal-forced')
    const next = value.store.enqueue({
      chatId: 'C0123456789',
      threadTs: '1800000000.000900',
      messageId: '1800000000.000900',
      userId: 'UNEXT',
      repoPath: value.job.repoPath,
      task: '次の依頼',
      writeEnabled: false,
    }).job
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'interrupt-no-terminal-forced',
        // The supervisor cannot self-confirm before the executor's shorter
        // grace expires, forcing the parent-owned exact-generation reaper.
        ZEROKUN_SUPERVISOR_TEST_CHILD_GRACE_MS: '5000',
      },
      cancellationTerminalGraceMs: 50,
      supervisorCleanupGraceMs: 100,
      liveControls: value.hooks,
    })).rejects.toBeInstanceOf(CodexUserCancelledError)
    const registration = join(value.state, 'executors', `${value.job.id}.json`)
    expect(existsSync(registration)).toBe(false)
    value.store.cancel(value.job.id)
    expect(value.store.claimNext('same-serial-worker')?.id).toBe(next.id)
    value.store.close()
  }, 15_000)

  test('terminal後の同じthread中止をcleanup待機へ割り込ませてFIFOを安全に開く', async () => {
    const value = fixture('normal')
    const processIds: number[] = []
    const next = value.store.enqueue({
      chatId: 'C0123456789',
      threadTs: '1800000000.001100',
      messageId: '1800000000.001100',
      userId: 'UNEXT',
      repoPath: value.job.repoPath,
      task: '次の依頼',
      writeEnabled: false,
    }).job
    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'normal',
        ZEROKUN_SUPERVISOR_TEST_CLEANUP_GATE: '1',
      },
      supervisorCleanupGraceMs: 50,
      onProcessId: pid => { processIds.push(pid) },
      liveControls: value.hooks,
    })
    await waitForCleanupGate(value.state, processIds, 0)
    const target = value.store.interruptControlTarget(value.job.chatId, value.job.threadTs)
    expect(target).not.toBeNull()
    expect(value.store.stageLiveControl(target!, {
      chatId: value.job.chatId,
      threadTs: value.job.threadTs,
      messageId: '1800000000.001000',
      userId: 'UOTHER',
      task: '中止',
      kind: 'interrupt',
    })).toBe('staged')
    await expect(execution).rejects.toBeInstanceOf(CodexUserCancelledError)
    const registration = join(value.state, 'executors', `${value.job.id}.json`)
    expect(existsSync(registration)).toBe(false)
    expect(() => process.kill(processIds[0]!, 0)).toThrow()
    value.store.cancel(value.job.id)
    expect(value.store.claimNext('same-serial-worker')?.id).toBe(next.id)
    value.store.close()
  }, 15_000)

  test('terminal後のrunner abortはbounded回収しても成功やFIFO進行へ昇格しない', async () => {
    const value = fixture('normal')
    const controller = new AbortController()
    const processIds: number[] = []
    value.store.enqueue({
      chatId: 'C0123456789',
      threadTs: '1800000000.001300',
      messageId: '1800000000.001300',
      userId: 'UNEXT',
      repoPath: value.job.repoPath,
      task: '次の依頼',
      writeEnabled: false,
    })
    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'normal',
        ZEROKUN_SUPERVISOR_TEST_CLEANUP_GATE: '1',
      },
      supervisorCleanupGraceMs: 50,
      signal: controller.signal,
      onProcessId: pid => { processIds.push(pid) },
      liveControls: value.hooks,
    })
    await waitForCleanupGate(value.state, processIds, 0)
    controller.abort()
    await expect(execution).rejects.toBeInstanceOf(CodexCleanupPendingError)
    const registration = join(value.state, 'executors', `${value.job.id}.json`)
    expect(existsSync(registration)).toBe(true)
    expect(JSON.parse(readFileSync(registration, 'utf8')).phase).toBe('active')
    expect(() => process.kill(processIds[0]!, 0)).toThrow()
    expect(value.store.claimNext('same-serial-worker')).toBeNull()
    value.store.close()
  }, 15_000)

  test('supervisor exit時にself-confirm receiptが欠ければ待ち続けず公開を止める', async () => {
    const value = fixture('normal')
    const processIds: number[] = []
    value.store.enqueue({
      chatId: 'C0123456789',
      threadTs: '1800000000.001500',
      messageId: '1800000000.001500',
      userId: 'UNEXT',
      repoPath: value.job.repoPath,
      task: '次の依頼',
      writeEnabled: false,
    })
    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'normal',
        ZEROKUN_SUPERVISOR_TEST_CLEANUP_GATE: '1',
      },
      onProcessId: pid => { processIds.push(pid) },
      liveControls: value.hooks,
    })
    await waitForCleanupGate(value.state, processIds, 0)
    process.kill(processIds[0]!, 'SIGKILL')
    await expect(execution).rejects.toBeInstanceOf(CodexCleanupPendingError)
    const registration = join(value.state, 'executors', `${value.job.id}.json`)
    expect(existsSync(registration)).toBe(true)
    expect(JSON.parse(readFileSync(registration, 'utf8')).phase).toBe('active')
    expect(value.store.claimNext('same-serial-worker')).toBeNull()
    value.store.close()
  }, 15_000)

  test('supervisor retained-stateは内部通知からbounded recoveryへ入りFIFOを無音停止しない', async () => {
    const value = fixture('normal')
    const processIds: number[] = []
    const startedAt = Date.now()
    const execution = executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'normal',
        ZEROKUN_SUPERVISOR_TEST_FORCE_RETAIN_AFTER_CHILD_EXIT: '1',
      },
      supervisorCleanupGraceMs: 50,
      onProcessId: pid => { processIds.push(pid) },
      liveControls: value.hooks,
    })

    await expect(execution).rejects.toBeInstanceOf(CodexCleanupPendingError)

    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(processIds).toHaveLength(1)
    expect(() => process.kill(processIds[0]!, 0)).toThrow()
    const registration = join(value.state, 'executors', `${value.job.id}.json`)
    expect(JSON.parse(readFileSync(registration, 'utf8'))).toMatchObject({
      phase: 'active',
      cleanupPending: true,
    })
    value.store.close()
  }, 15_000)

  test('active turnがsteer不能なら同じ返信を次turnへ一度だけ繰り越す', async () => {
    const value = fixture('defer')
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'defer' },
      liveControls: value.hooks,
    })
    expect(result.result).toBe('次ターンで追加入力を反映しました')
    expect(value.store.listJobControls(value.job.id)).toHaveLength(1)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      userId: 'UOTHER', kind: 'steer', status: 'observed',
    })
    value.store.close()
  })

  test('turn terminalと競合した非構造steer拒否は同じ返信を次turnへ一度だけ繰り越す', async () => {
    const value = fixture('terminal-race')
    const rpcLog = join(value.root, 'terminal-race-rpc.log')
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'terminal-race', ZERO_RPC_LOG: rpcLog },
      liveControls: value.hooks,
    })
    expect(result.result).toBe('次ターンで追加入力を反映しました')
    expect(value.store.listJobControls(value.job.id)).toHaveLength(1)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      userId: 'UOTHER', kind: 'steer', status: 'observed', inputRevision: 2,
    })
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rpc.map(value => value.method)).toEqual([
      'turn/start', 'turn/steer', 'thread/items/list', 'turn/start',
      'thread/items/list',
    ])
    expect(rpc[1].clientUserMessageId).toBe(rpc[3].clientUserMessageId)
    expect(rpc[1].expectedTurnId).toBe('turn-app-server-1')
    value.store.close()
  }, 30_000)

  test('steer拒否でもofficial historyに一度あれば再送せずobservedにする', async () => {
    const value = fixture('terminal-race-accepted')
    const rpcLog = join(value.root, 'terminal-race-accepted-rpc.log')
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'terminal-race-accepted', ZERO_RPC_LOG: rpcLog,
      },
      liveControls: value.hooks,
    })
    expect(result.result).toBe('元ターン完了')
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rpc.map(value => value.method)).toEqual([
      'turn/start', 'turn/steer', 'thread/items/list', 'thread/items/list',
    ])
    expect(value.store.listJobControls(value.job.id)).toHaveLength(1)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      status: 'observed', inputRevision: 2,
    })
    value.store.close()
  }, 30_000)

  test('full terminalにsteerが無くても永続item履歴に一度あれば再送しない', async () => {
    const value = fixture('terminal-race-accepted-history')
    const rpcLog = join(value.root, 'terminal-race-accepted-history-rpc.log')
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'terminal-race-accepted-history', ZERO_RPC_LOG: rpcLog,
      },
      liveControls: value.hooks,
    })
    expect(result.result).toBe('永続履歴の追記を反映しました')
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rpc.map(value => value.method)).toEqual([
      'turn/start', 'turn/steer', 'thread/items/list', 'thread/items/list',
    ])
    expect(value.store.listJobControls(value.job.id)).toHaveLength(1)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      status: 'observed', inputRevision: 2,
    })
    value.store.close()
  }, 30_000)

  test('steer拒否後のofficial historyに同じclient IDが重複したらfail-closeする', async () => {
    const value = fixture('terminal-race-duplicate')
    const rpcLog = join(value.root, 'terminal-race-duplicate-rpc.log')
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'terminal-race-duplicate', ZERO_RPC_LOG: rpcLog,
      },
      liveControls: value.hooks,
    })).rejects.toThrow('appeared more than once')
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rpc.map(value => value.method)).toEqual([
      'turn/start', 'turn/steer', 'thread/items/list',
    ])
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({ status: 'ambiguous' })
    value.store.close()
  }, 30_000)

  test('steerより前の旧回答しか永続化されていなければ公開せずfail-closeする', async () => {
    const value = fixture('terminal-race-stale-after-user')
    const rpcLog = join(value.root, 'terminal-race-stale-after-user-rpc.log')
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'terminal-race-stale-after-user', ZERO_RPC_LOG: rpcLog,
      },
      liveControls: value.hooks,
    })).rejects.toThrow('without a following final response')
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rpc.map(value => value.method)).toEqual([
      'turn/start', 'turn/steer', 'thread/items/list',
    ])
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({ status: 'ambiguous' })
    value.store.close()
  }, 30_000)

  test('steer拒否のterminal待ち中でもexact中止だけはturn/interruptへ割り込ませる', async () => {
    const value = fixture('terminal-race-cancel')
    const rpcLog = join(value.root, 'terminal-race-cancel-rpc.log')
    const beginDispatch = value.hooks.beginDispatch
    let stagedCancel = false
    value.hooks.beginDispatch = options => {
      beginDispatch(options)
      if (stagedCancel || options.control.kind !== 'steer') return
      stagedCancel = true
      const target = value.store.liveControlTarget(value.job.chatId, value.job.threadTs)!
      expect(value.store.stageLiveControl(target, {
        chatId: value.job.chatId,
        threadTs: value.job.threadTs,
        messageId: 'terminal-race-cancel-stop',
        userId: 'UOTHER',
        writeEnabled: false,
        task: '中止',
        kind: 'interrupt',
      })).toBe('staged')
    }
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'terminal-race-cancel', ZERO_RPC_LOG: rpcLog,
      },
      liveControls: value.hooks,
    })).rejects.toBeInstanceOf(CodexUserCancelledError)
    const rpc = readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rpc.map(value => value.method)).toEqual([
      'turn/start', 'turn/steer', 'turn/interrupt',
    ])
    value.store.cancel(value.job.id)
    expect(value.store.listJobControls(value.job.id).map(control => control.status)).toEqual([
      'ambiguous', 'observed',
    ])
    value.store.close()
  }, 30_000)

  test('turn失敗と競合した同thread返信を孤立させず次turnで処理する', async () => {
    const value = fixture('failed-steer')
    const processIds: number[] = []
    const finishTurn = value.hooks.finishTurn
    let staged = false
    value.hooks.finishTurn = options => {
      if (!staged) {
        staged = true
        const target = value.store.liveControlTarget(value.job.chatId, value.job.threadTs)!
        expect(value.store.stageLiveControl(target, {
          chatId: value.job.chatId,
          threadTs: value.job.threadTs,
          messageId: '1800000000.000200',
          userId: 'UOTHER',
          task: '別ユーザーからの追加入力',
          kind: 'steer',
        })).toBe('staged')
      }
      return finishTurn(options)
    }
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'failed-steer' },
      onProcessId: processId => { processIds.push(processId) },
      liveControls: value.hooks,
    })
    expect(result.result).toBe('失敗後の追加入力を反映しました')
    expect(processIds).toHaveLength(1)
    expect(value.store.listJobControls(value.job.id)).toHaveLength(1)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      userId: 'UOTHER', kind: 'steer', status: 'observed',
    })
    value.store.close()
  })

  test('途中error通知と競合した同thread返信もactive turnへ一度だけsteerする', async () => {
    const value = fixture('error-steer')
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'error-steer' },
      liveControls: value.hooks,
    })
    expect(result.result).toBe('追加入力を反映しました')
    expect(value.store.listJobControls(value.job.id)).toHaveLength(1)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      userId: 'UOTHER', kind: 'steer', status: 'observed',
    })
    value.store.close()
  })

  test('uncorrelated rate-limit通知をrunner crash前にdurable化する', async () => {
    const value = fixture('rate-error')
    await expect(executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'rate-error' },
      liveControls: value.hooks,
    })).rejects.toBeInstanceOf(CodexRateLimitError)
    expect(value.store.get(value.job.id)).toMatchObject({
      status: 'running',
      sessionId: 'thread-app-server-1',
      acceptsControl: true,
      notBefore: expect.any(Number),
    })
    expect(value.store.recoverInterrupted()).toEqual({
      requeued: 1, failedWrites: 0, failedUncertain: 0,
    })
    expect(value.store.get(value.job.id)?.status).toBe('queued')
    value.store.close()
  }, 15_000)

  test('willRetry中のrate-limit通知はhost requeueせず同じturnのterminalを待つ', async () => {
    const value = fixture('rate-retrying')
    let hostRequeues = 0
    const recordRateLimit = value.hooks.recordRateLimit
    value.hooks.recordRateLimit = options => {
      hostRequeues += 1
      recordRateLimit(options)
    }
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'rate-retrying' },
      liveControls: value.hooks,
    })
    expect(result).toEqual({
      sessionId: 'thread-app-server-1', result: '内部retry後に完了',
    })
    expect(hostRequeues).toBe(0)
    expect(value.store.get(value.job.id)).toMatchObject({
      status: 'running', notBefore: null, acceptsControl: false,
    })
    value.store.close()
  })

  test('model capacity terminalは副作用のないfull turnだけ同じsessionで再開可能にする', async () => {
    for (const [mode, safe] of [
      ['capacity-error', true],
      ['capacity-after-command', false],
      ['capacity-error-generic-terminal', true],
      ['capacity-started-command', false],
    ] as const) {
      const value = fixture(mode, true)
      let caught: unknown
      try {
        await executeCodexJob(value.job, {
          codexBinForTesting: value.executable,
          logDir: value.logDir,
          stateDir: value.state,
          skipEffectiveConfigCheck: true,
          extraEnvironment: { ZERO_FIXTURE_MODE: mode },
          liveControls: value.hooks,
        })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(CodexRateLimitError)
      const rateLimitError = caught as CodexRateLimitError
      expect(rateLimitError.reason).toBe('capacity')
      expect(rateLimitError.safeToRetryAfterDelivery).toBe(safe)
      expect(rateLimitError.sessionId).toBe('thread-app-server-1')
      expect(rateLimitError.stage).toBe('complete')
      expect(rateLimitError.phaseSequence).toBe(0)
      value.store.close()
    }
  }, 30_000)
})
