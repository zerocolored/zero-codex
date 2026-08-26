import { afterEach, describe, expect, test } from 'bun:test'
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
import { join } from 'path'
import { JobStore, type JobControlRecord } from './job-runner.ts'
import {
  CodexCleanupPendingError,
  CodexRateLimitError,
  CodexUserCancelledError,
  executeCodexJob,
  type CodexLiveControlHooks,
} from './codex-executor.ts'
import { prepareManagedStateRoot } from './managed-path.ts'

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

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

def emit_batch(values):
    sys.stdout.write("".join(json.dumps(value, ensure_ascii=False) + "\\n" for value in values))
    sys.stdout.flush()

for line in sys.stdin:
    value = json.loads(line)
    method = value.get("method")
    request_id = value.get("id")
    rpc_log = os.environ.get("ZERO_RPC_LOG")
    if rpc_log and method in ("turn/start", "turn/steer", "turn/interrupt", "thread/turns/list", "thread/read", "thread/items/list"):
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
        if "Host phase: read-only preparation." in phase_prompt:
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
        turn_id = "turn-app-server-" + (stage + "-" + str(os.getpid()) + "-" + str(turn_count) if mode in ("phased", "phased-steer", "phased-late-inbound") else str(turn_count))
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
        if mode in ("phased", "phased-steer", "phased-late-inbound"):
            if stage == "prepare":
                marker = re.search(r"\\[ZERO_PRE_EDIT_READY:[0-9a-f]{32}:r[0-9]+:[0-9a-f]{64}\\]", phase_prompt)
                message = "準備完了\\n" + (marker.group(0) if marker else "[ZERO_PRE_EDIT_READY:missing:r1:missing]")
            elif stage == "implementation":
                marker = re.search(r"\\[ZERO_IMPLEMENTATION_READY:[0-9a-f]{32}:r[0-9]+:[0-9a-f]{64}\\]", phase_prompt)
                message = "実装完了\\n" + (marker.group(0) if marker else "[ZERO_IMPLEMENTATION_READY:missing:r1:missing]")
            elif stage == "review":
                marker = re.search(r"\\[ZERO_REVIEW_PUBLISH:[0-9a-f]{32}:round-[123]\\]", phase_prompt)
                message = (marker.group(0) if marker else "[ZERO_REVIEW_PUBLISH:missing:round-1]") + "\\n公開できます"
            else:
                message = "unexpected phase"
            control_log = os.environ.get("ZERO_CONTROL_LOG")
            hold_for_steer = mode == "phased-steer" and stage == "implementation" and control_log and not os.path.exists(control_log)
            if not hold_for_steer:
                emit({"method": "turn/completed", "params": {"threadId": requested_thread or thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": message}], "error": None}}})
        elif mode in ("normal", "slow", "logical-stop-required", "late-error-after-complete", "late-error-coalesced", "errors-before-terminal-coalesced", "terminal-cancel-race", "large-ledger"):
            if mode == "slow":
                time.sleep(0.1)
            if mode == "large-ledger":
                for _index in range(96):
                    subprocess.Popen(["/bin/sleep", "30"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                time.sleep(0.5)
            terminal = {"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": "通常完了"}], "error": None}}}
            progress_error = {"method": "error", "params": {"threadId": thread_id, "turnId": turn_id, "willRetry": True, "error": {"message": "fixture progress", "codexErrorInfo": None, "additionalDetails": None}}}
            late_error = {"method": "error", "params": {"threadId": thread_id, "turnId": turn_id, "willRetry": False, "error": {"message": "late fixture failure", "codexErrorInfo": None, "additionalDetails": None}}}
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
        elif mode == "failed-steer":
            if turn_id == "turn-app-server-1":
                emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "failed", "itemsView": "full", "items": [], "error": {"message": "fixture failure"}}}})
            else:
                emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": "失敗後の追加入力を反映しました"}], "error": None}}})
        elif mode == "rate-error":
            emit({"method": "error", "params": {"threadId": thread_id, "turnId": turn_id, "willRetry": False, "error": {"message": "rate limit 429", "codexErrorInfo": {"retry_after": 1}, "additionalDetails": None}}})
        elif mode == "rate-retrying":
            emit({"method": "error", "params": {"threadId": thread_id, "turnId": turn_id, "willRetry": True, "error": {"message": "rate limit 429", "codexErrorInfo": {"retry_after": 1}, "additionalDetails": None}}})
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "full", "items": [{"type": "agentMessage", "text": "内部retry後に完了"}], "error": None}}})
        elif mode == "error-steer":
            emit({"method": "error", "params": {"threadId": thread_id, "turnId": turn_id, "willRetry": True, "error": {"message": "temporary fixture error", "codexErrorInfo": None, "additionalDetails": None}}})
        elif mode == "summary-stream-no-history":
            emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": {"type": "agentMessage", "text": "履歴不要で完了"}}})
            emit({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "itemsView": "summary", "items": [], "error": None}}})
    elif method == "thread/items/list" and mode in ("defer", "terminal-race", "terminal-race-accepted", "terminal-race-accepted-history", "terminal-race-duplicate", "terminal-race-stale-after-user"):
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
    elif method in ("thread/turns/list", "thread/read", "thread/items/list") and mode == "summary-stream-no-history":
        emit({"id": request_id, "error": {"code": -32000, "message": "history must not be requested"}})
    elif method == "turn/steer":
        if mode == "phased-steer":
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
    | 'interrupt-no-terminal-forced' | 'defer' | 'terminal-race'
    | 'terminal-race-accepted' | 'terminal-race-accepted-history'
    | 'terminal-race-duplicate' | 'terminal-race-stale-after-user' | 'terminal-race-cancel'
    | 'failed-steer'
    | 'error-steer' | 'rate-error' | 'rate-retrying' | 'phased' | 'phased-steer'
    | 'phased-late-inbound' | 'summary-stream-no-history' | 'logical-stop-required'
    | 'late-error-after-complete' | 'late-error-coalesced'
    | 'errors-before-terminal-coalesced' | 'terminal-cancel-race'
    | 'large-ledger' | 'hang-initialize' | 'hang-turn-start',
  writeEnabled = false,
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
    task: '最初の依頼',
    writeEnabled,
  })
  const job = store.claimNext('serial-worker')!
  let staged = false
  const stageRequestedControl = () => {
    if (staged || ![
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
    next: () => store.nextReadyControl(job.id, job.controlEpoch),
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
    sealPhaseResult: ({ logicalNonce, threadId, inputRevision, inputDigest }) => (
      store.sealAppServerPhaseResult({
        jobId: job.id,
        epoch: job.controlEpoch,
        logicalNonce,
        threadId,
        inputRevision,
        inputDigest,
      })
    ),
    beginDispatch: ({ control, executorNonce, threadId, turnId, requestId }) => {
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
    acknowledge: (control: JobControlRecord, requestId: number, turnId: string) => {
      store.acknowledgeControl(control.id, requestId, turnId)
    },
    ambiguous: (control, error) => store.markControlAmbiguous(control.id, error),
    deferToNextTurn: (control, requestId, executorNonce, threadId, turnId, error) => (
      store.deferControlToNextTurn({
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
    cancellationRequested: () => store.get(job.id)?.cancelRequestedAt != null,
  }
  return { root, repo, state, logDir, store, job, hooks, executable: fakeCodex(root) }
}

describe('production App Server executor', () => {
  test('accepted terminal後は論理終了signalでApp Serverを閉じる', async () => {
    const value = fixture('logical-stop-required')
    const marker = join(value.root, 'logical-stop.marker')
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: {
        ZERO_FIXTURE_MODE: 'logical-stop-required',
        ZERO_LOGICAL_STOP_MARKER: marker,
      },
      liveControls: value.hooks,
    })
    expect(result).toEqual({ sessionId: 'thread-app-server-1', result: '通常完了' })
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
    const value = fixture('phased', true)
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
        ZERO_FIXTURE_MODE: 'phased',
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

    expect(result).toEqual({ sessionId: 'thread-app-server-1', result: '公開できます' })
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

    expect(result).toEqual({ sessionId: 'thread-app-server-1', result: '公開できます' })
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

    expect(result).toEqual({ sessionId: 'thread-app-server-1', result: '公開できます' })
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

  test('summary terminalでもstream済み最終回答があれば履歴RPCへ依存しない', async () => {
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
    expect(rpc.map(value => value.method)).toEqual(['turn/start'])
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
    const result = await executeCodexJob(value.job, {
      codexBinForTesting: value.executable,
      logDir: value.logDir,
      stateDir: value.state,
      skipEffectiveConfigCheck: true,
      extraEnvironment: { ZERO_FIXTURE_MODE: 'steer' },
      liveControls: value.hooks,
    })
    expect(result.result).toBe('追加入力を反映しました')
    expect(value.store.listJobControls(value.job.id)).toHaveLength(1)
    expect(value.store.listJobControls(value.job.id)[0]).toMatchObject({
      userId: 'UOTHER', kind: 'steer', status: 'observed',
    })
    value.store.close()
  })

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
      'turn/start', 'turn/steer', 'thread/items/list', 'thread/turns/list',
      'thread/read', 'turn/start',
    ])
    expect(rpc[1].clientUserMessageId).toBe(rpc[5].clientUserMessageId)
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
      'turn/start', 'turn/steer', 'thread/items/list',
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
      'turn/start', 'turn/steer', 'thread/items/list',
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
      'turn/start', 'turn/steer', 'thread/items/list', 'thread/turns/list', 'thread/read',
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
      liveControls: value.hooks,
    })
    expect(result.result).toBe('失敗後の追加入力を反映しました')
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
})
