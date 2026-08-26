import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  installFifthAdvisorHelper,
  resolveFifthAdvisorHelper,
} from './install-fifth-advisor.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), 'zerokun-fifth-advisor-'))
  roots.push(home)
  chmodSync(home, 0o700)
  return home
}

function gitProject(home: string): { project: string; request: string } {
  const project = join(home, 'project')
  const request = join(home, 'request')
  mkdirSync(project, { mode: 0o700 })
  mkdirSync(request, { mode: 0o700 })
  const initialized = Bun.spawnSync(['/usr/bin/git', 'init', '-q', project], {
    env: { PATH: '/usr/bin:/bin', HOME: home }, stdout: 'pipe', stderr: 'pipe',
  })
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString())
  writeFileSync(join(request, 'prompt'), 'Read-only review\n', { mode: 0o600 })
  return { project: realpathSync(project), request: realpathSync(request) }
}

const lifecycleNonce = '0123456789abcdef0123456789abcdef'
const claudeArguments = [
  '--dangerously-skip-permissions',
  '--safe-mode',
  '--no-chrome',
  '--disable-slash-commands',
]

function fakeLifecycle(home: string, project: string): {
  environment: Record<string, string>
  state: string
} {
  const bin = join(home, 'bin')
  mkdirSync(bin, { mode: 0o700 })
  const claude = join(bin, 'claude')
  writeFileSync(claude, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const state = join(home, 'fake-herdr-state.json')
  writeFileSync(state, `${JSON.stringify({
    owned: true,
    agent: true,
    process: true,
    project,
    nonce: lifecycleNonce,
  })}\n`, { mode: 0o600 })
  const herdr = join(bin, 'herdr')
  writeFileSync(herdr, `#!/usr/bin/python3
import json, os, sys
path = os.environ["FAKE_HERDR_STATE"]
with open(path, "r", encoding="utf-8") as handle:
    state = json.load(handle)
args = sys.argv[1:]
workspace = "wOWN"
pane = "wOWN:p1"
tab = "wOWN:t1"
terminal = "term_012345abcdef"
agent_name = "fifth-" + state["nonce"][:20]
label = "fifth-advisor-" + state["nonce"]
def success(result):
    print(json.dumps({"result": result}, sort_keys=True))
    raise SystemExit(0)
def missing(code):
    print(json.dumps({"error": {"code": code}}, sort_keys=True))
    raise SystemExit(1)
def workspace_value(workspace_id, workspace_label):
    return {"workspace_id": workspace_id, "label": workspace_label, "active_tab_id": tab if workspace_id == workspace else "wCALLER:t1", "focused": False, "pane_count": 1, "tab_count": 1, "worktree": None}
if args == ["pane", "current", "--current"]:
    success({"pane": {"workspace_id": "wCALLER", "pane_id": "wCALLER:p1", "terminal_id": "term_cabbe123456"}})
if args == ["workspace", "list"]:
    values = [workspace_value("wCALLER", "caller"), workspace_value("wFOREIGN", "foreign")]
    if state["owned"]:
        values.append(workspace_value(workspace, label))
    success({"workspaces": values})
if args == ["workspace", "get", workspace]:
    if not state["owned"]:
        missing("workspace_not_found")
    success({"workspace": workspace_value(workspace, label)})
if args == ["tab", "list", "--workspace", workspace]:
    success({"tabs": [{"workspace_id": workspace, "tab_id": tab, "focused": False, "pane_count": 1}]})
if args == ["pane", "list", "--workspace", workspace]:
    success({"panes": [{"workspace_id": workspace, "tab_id": tab, "pane_id": pane, "terminal_id": terminal, "cwd": state["project"], "foreground_cwd": state["project"], "focused": False}]})
if args == ["pane", "process-info", "--pane", pane]:
    if not state["owned"]:
        missing("pane_not_found")
    processes = [{"pid": 999992, "argv": ["claude", "--dangerously-skip-permissions", "--safe-mode", "--no-chrome", "--disable-slash-commands"], "argv0": "claude"}] if state["process"] else []
    success({"process_info": {"pane_id": pane, "shell_pid": 999991, "foreground_process_group_id": 999993, "foreground_processes": processes}})
if args == ["agent", "get", agent_name]:
    if not state["owned"] or not state["agent"]:
        missing("agent_not_found")
    success({"agent": {"name": agent_name, "agent": "claude", "workspace_id": workspace, "pane_id": pane, "terminal_id": terminal, "cwd": state["project"], "agent_status": "idle", "interactive_ready": True, "launch_pending": False, "state_change_seq": 1}})
if args == ["agent", "read", agent_name, "--source", "visible", "--lines", "120"]:
    print("❯", flush=True)
    raise SystemExit(0)
if args == ["workspace", "close", workspace]:
    if not state["owned"]:
        missing("workspace_not_found")
    state["owned"] = False
    state["agent"] = False
    state["process"] = False
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(state, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    success({"closed": True})
if args == ["pane", "get", pane]:
    if not state["owned"]:
        missing("pane_not_found")
missing("unsupported_test_command")
`, { mode: 0o700 })
  return {
    state,
    environment: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      HERDR_ENV: '1',
      HERDR_BIN_PATH: herdr,
      ZEROKUN_CLAUDE_BIN_PATH: claude,
      FAKE_HERDR_STATE: state,
    },
  }
}

function writeLifecycleIntent(request: string, project: string): void {
  const projectMetadata = lstatSync(project)
  writeFileSync(join(request, 'ephemeral-session-intent.json'), `${JSON.stringify({
    version: 2,
    nonce: lifecycleNonce,
    label: `fifth-advisor-${lifecycleNonce}`,
    agent_name: `fifth-${lifecycleNonce.slice(0, 20)}`,
    project_root: project,
    project_root_dev: projectMetadata.dev,
    project_root_ino: projectMetadata.ino,
    caller: {
      workspace_id: 'wCALLER',
      pane_id: 'wCALLER:p1',
      terminal_id: 'term_cabbe123456',
    },
    baseline_workspace_ids: ['wCALLER'],
  })}\n`, { mode: 0o600 })
}

function writeLifecycleWorkspace(
  request: string,
  project: string,
  claude: string,
  includeAgentReceipt = true,
): void {
  const projectMetadata = lstatSync(project)
  writeFileSync(join(request, 'ephemeral-workspace-receipt.json'), `${JSON.stringify({
    version: 2,
    start_state_protocol: 'durable-agent-start-intent-v1',
    nonce: lifecycleNonce,
    label: `fifth-advisor-${lifecycleNonce}`,
    project_root_dev: projectMetadata.dev,
    project_root_ino: projectMetadata.ino,
    project_root: project,
    agent_name: `fifth-${lifecycleNonce.slice(0, 20)}`,
    workspace_id: 'wOWN',
    tab_id: 'wOWN:t1',
    pane_id: 'wOWN:p1',
    terminal_id: 'term_012345abcdef',
  })}\n`, { mode: 0o600 })
  if (!includeAgentReceipt) return
  writeFileSync(join(request, 'ephemeral-agent-start-intent.json'), `${JSON.stringify({
    version: 2,
    nonce: lifecycleNonce,
    agent_name: `fifth-${lifecycleNonce.slice(0, 20)}`,
    workspace_id: 'wOWN',
    pane_id: 'wOWN:p1',
    status: 'start-will-be-attempted',
  })}\n`, { mode: 0o600 })
  const agentPath = join(request, 'ephemeral-agent-receipt.json')
  const written = Bun.spawnSync(['/usr/bin/python3', '-c', [
    'import json,os,stat,sys',
    'def metadata(path):',
    ' value=os.lstat(path)',
    ' return {"kind":"symlink" if stat.S_ISLNK(value.st_mode) else "regular","file_type":stat.S_IFMT(value.st_mode),"mode":stat.S_IMODE(value.st_mode),"uid":value.st_uid,"gid":value.st_gid,"nlink":value.st_nlink,"size":value.st_size,"dev":value.st_dev,"ino":value.st_ino,"rdev":value.st_rdev,"mtime_ns":value.st_mtime_ns,"ctime_ns":value.st_ctime_ns}',
    'destination,lookup,nonce=sys.argv[1:4]',
    'resolved=os.path.realpath(lookup)',
    'identity={"lookup_path":lookup,"lookup_metadata":metadata(lookup),"resolved_path":resolved,"resolved_metadata":metadata(resolved)}',
    `receipt={"version":2,"nonce":nonce,"agent_name":"fifth-"+nonce[:20],"workspace_id":"wOWN","pane_id":"wOWN:p1","terminal_id":"term_012345abcdef","native_session":"N/A:safe-mode","state_change_seq":1,"shell_pid":999991,"claude_pid":999992,"process_group_id":999993,"process_ids":[999991,999992],"argv":["claude",${claudeArguments.map(value => JSON.stringify(value)).join(',')}],"argv0":"claude","executable":identity}`,
    'descriptor=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)',
    'try:',
    ' data=(json.dumps(receipt,sort_keys=True)+"\\n").encode("utf-8")',
    ' os.write(descriptor,data)',
    ' os.fsync(descriptor)',
    'finally:',
    ' os.close(descriptor)',
  ].join('\n'), agentPath, claude, lifecycleNonce], { stdout: 'pipe', stderr: 'pipe' })
  if (written.exitCode !== 0) throw new Error(written.stderr.toString())
}

describe('fifth-advisor helper installer', () => {
  test('bundled helperをowner-onlyで配置して内容まで固定する', () => {
    const home = fixture()
    const installed = installFifthAdvisorHelper(home)
    expect(installed).toBe(join(realpathSync(home), '.zerokun/runtime/fifth-advisor.py'))
    expect(lstatSync(join(home, '.zerokun')).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(home, '.zerokun/runtime')).mode & 0o777).toBe(0o700)
    expect(lstatSync(installed).mode & 0o777).toBe(0o700)
    expect(readFileSync(installed)).toEqual(readFileSync(join(import.meta.dir, 'fifth-advisor.py')))
    expect(resolveFifthAdvisorHelper(home)).toBe(installed)
  })

  test('receiptは完全なstaging fileからno-replace公開し途中crashを回収する', () => {
    const home = fixture()
    const { project, request } = gitProject(home)
    const helper = installFifthAdvisorHelper(home)
    const crash = Bun.spawnSync(['/usr/bin/python3', '-c', [
      'import importlib.util,os,sys',
      'helper,request=sys.argv[1:3]',
      'spec=importlib.util.spec_from_file_location("fifth_advisor_under_test",helper)',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'module._rename_staged_record_no_replace=lambda *_args: os._exit(77)',
      'descriptor=os.open(request,os.O_RDONLY)',
      'module._exclusive_json_record(descriptor,module.SESSION_INTENT_NAME,{"partial":True})',
    ].join('\n'), helper, request], {
      env: { HOME: home, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(crash.exitCode).toBe(77)
    const staged = join(request, '.ephemeral-session-intent.json.pending')
    expect(existsSync(staged)).toBe(true)
    expect(lstatSync(staged).mode & 0o777).toBe(0o600)
    expect(lstatSync(staged).nlink).toBe(1)
    expect(existsSync(join(request, 'ephemeral-session-intent.json'))).toBe(false)

    const snapshot = Bun.spawnSync([
      '/usr/bin/python3', helper, 'snapshot',
      '--project-root', project, '--request-dir', request,
    ], {
      env: { HOME: home, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0)
    expect(existsSync(staged)).toBe(false)
    const snapshotPath = join(request, 'protected-snapshot.json')
    const original = readFileSync(snapshotPath)

    const duplicate = Bun.spawnSync(['/usr/bin/python3', '-c', [
      'import importlib.util,os,sys',
      'helper,request=sys.argv[1:3]',
      'spec=importlib.util.spec_from_file_location("fifth_advisor_under_test",helper)',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'descriptor=os.open(request,os.O_RDONLY)',
      'try:',
      ' module._exclusive_json_record(descriptor,module.SNAPSHOT_NAME,{"replace":True})',
      'finally:',
      ' os.close(descriptor)',
    ].join('\n'), helper, request], {
      env: { HOME: home, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(duplicate.exitCode).not.toBe(0)
    expect(readFileSync(snapshotPath)).toEqual(original)
    expect(existsSync(join(request, '.protected-snapshot.json.pending'))).toBe(false)
  })

  test('改変、hardlink、symlink directoryを拒否する', () => {
    const first = fixture()
    const installed = installFifthAdvisorHelper(first)
    writeFileSync(installed, '# changed\n', { mode: 0o700 })
    expect(() => resolveFifthAdvisorHelper(first)).toThrow('integrity mismatch')

    const second = fixture()
    const linked = installFifthAdvisorHelper(second)
    linkSync(linked, join(second, 'helper-hardlink'))
    expect(() => resolveFifthAdvisorHelper(second)).toThrow('unsafe fifth-advisor file')

    const third = fixture()
    mkdirSync(join(third, '.zerokun'))
    const outside = join(third, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(third, '.zerokun/runtime'))
    expect(() => installFifthAdvisorHelper(third)).toThrow('unsafe fifth-advisor directory')
  })

  test('host共有helperを変更せずZero専用namespaceだけへ配置する', () => {
    const home = fixture()
    const sharedDirectory = join(home, '.codex/herdr')
    mkdirSync(sharedDirectory, { recursive: true, mode: 0o700 })
    chmodSync(join(home, '.codex'), 0o755)
    chmodSync(sharedDirectory, 0o700)
    const sharedHelper = join(sharedDirectory, 'fifth-advisor.py')
    const sentinel = '# host-owned fifth-advisor helper\n'
    writeFileSync(sharedHelper, sentinel, { mode: 0o700 })
    const before = lstatSync(sharedHelper)

    const installed = installFifthAdvisorHelper(home)

    const after = lstatSync(sharedHelper)
    expect(readFileSync(sharedHelper, 'utf8')).toBe(sentinel)
    for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const) {
      expect(after[key]).toBe(before[key])
    }
    expect(installed).toBe(join(realpathSync(home), '.zerokun/runtime/fifth-advisor.py'))
    expect(resolveFifthAdvisorHelper(home)).toBe(installed)
  })

  test('snapshot/verifyはrepositoryを変更せずprotected metadata差だけを拒否する', () => {
    const home = fixture()
    const { project, request } = gitProject(home)
    const helper = installFifthAdvisorHelper(home)
    const environment = { HOME: home, PATH: '/usr/bin:/bin' }
    const snapshot = Bun.spawnSync([
      '/usr/bin/python3', helper, 'snapshot',
      '--project-root', project, '--request-dir', request,
    ], { env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0)
    expect(snapshot.stdout.toString()).toContain('snapshot-recorded')
    const verify = Bun.spawnSync([
      '/usr/bin/python3', helper, 'verify',
      '--project-root', project, '--request-dir', request,
    ], { env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(verify.exitCode, verify.stderr.toString()).toBe(0)
    expect(verify.stdout.toString()).toContain('snapshot-unchanged')

    mkdirSync(join(project, '.credentials'), { mode: 0o700 })
    const changed = Bun.spawnSync([
      '/usr/bin/python3', helper, 'verify',
      '--project-root', project, '--request-dir', request,
    ], { env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(changed.exitCode).toBe(4)
    expect(changed.stdout.toString()).toContain('protected-metadata-changed')
  })

  test('fresh lifecycle以外のtarget指定やownedでないsendを受け付けない', () => {
    const home = fixture()
    const { project, request } = gitProject(home)
    const helper = installFifthAdvisorHelper(home)
    const environment = { HOME: home, PATH: '/usr/bin:/bin', HERDR_ENV: '1' }
    const snapshot = Bun.spawnSync([
      '/usr/bin/python3', helper, 'snapshot',
      '--project-root', project, '--request-dir', request,
    ], { env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(snapshot.exitCode).toBe(0)

    const arbitrary = Bun.spawnSync([
      '/usr/bin/python3', helper, 'send',
      '--project-root', project, '--request-dir', request, '--target', 'w1:p2',
    ], { env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(arbitrary.exitCode).not.toBe(0)
    expect(arbitrary.stdout.toString()).not.toContain('prompt-started')

    const notOwned = Bun.spawnSync([
      '/usr/bin/python3', helper, 'send',
      '--project-root', project, '--request-dir', request,
    ], { env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(notOwned.exitCode).not.toBe(0)
    expect(notOwned.stdout.toString()).not.toContain('prompt-started')
  })

  test('openはHerdr外ではworkspaceを作成せずfail closedにする', () => {
    const home = fixture()
    const { project, request } = gitProject(home)
    const helper = installFifthAdvisorHelper(home)
    const snapshot = Bun.spawnSync([
      '/usr/bin/python3', helper, 'snapshot',
      '--project-root', project, '--request-dir', request,
    ], { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' })
    expect(snapshot.exitCode).toBe(0)
    const opened = Bun.spawnSync([
      '/usr/bin/python3', helper, 'open',
      '--project-root', project, '--request-dir', request,
    ], { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' })
    expect(opened.exitCode).toBe(3)
    expect(opened.stdout.toString()).not.toContain('ephemeral-claude-ready')
  })

  test('agent_not_ready後に既trustのempty ready promptへ到達したClaudeを受理する', () => {
    const helper = realpathSync(join(import.meta.dir, 'fifth-advisor.py'))
    const program = [
      'import importlib.util,json,sys',
      'spec=importlib.util.spec_from_file_location("fifth_advisor",sys.argv[1])',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'workspace={"agent_name":"fifth-test","workspace_id":"wOWN","pane_id":"wOWN:p1","terminal_id":"term_012345abcdef","project_root":"/tmp/project"}',
      'ready={"name":"fifth-test","agent":"claude","workspace_id":"wOWN","pane_id":"wOWN:p1","terminal_id":"term_012345abcdef","cwd":"/tmp/project","agent_status":"idle","interactive_ready":True,"launch_pending":False,"state_change_seq":7}',
      'module._agent_information=lambda target: ({},dict(ready))',
      'module._read_visible=lambda target: "❯\\n"',
      'module.time.sleep=lambda seconds: None',
      'module._settle_after_trust=lambda target,workspace: (_ for _ in ()).throw(AssertionError("trust path must not run"))',
      'resolved=module._settle_after_agent_not_ready("fifth-test",workspace)',
      'print(json.dumps({"status":resolved["agent_status"],"sequence":resolved["state_change_seq"]},sort_keys=True))',
    ].join('\n')
    const result = Bun.spawnSync(['/usr/bin/python3', '-c', program, helper], {
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({ sequence: 7, status: 'idle' })
  })

  test('agent_not_ready後のblocked launchはexact trust検査へだけ渡す', () => {
    const helper = realpathSync(join(import.meta.dir, 'fifth-advisor.py'))
    const program = [
      'import importlib.util,json,sys',
      'spec=importlib.util.spec_from_file_location("fifth_advisor",sys.argv[1])',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'workspace={"agent_name":"fifth-test","workspace_id":"wOWN","pane_id":"wOWN:p1","terminal_id":"term_012345abcdef","project_root":"/tmp/project"}',
      'blocked={"name":"fifth-test","agent":"claude","workspace_id":"wOWN","pane_id":"wOWN:p1","terminal_id":"term_012345abcdef","cwd":"/tmp/project","agent_status":"blocked","interactive_ready":False,"launch_pending":True,"state_change_seq":8}',
      'module._agent_information=lambda target: ({},dict(blocked))',
      'module._settle_after_trust=lambda target,workspace: {"path":"strict-trust"}',
      'resolved=module._settle_after_agent_not_ready("fifth-test",workspace)',
      'print(json.dumps(resolved,sort_keys=True))',
    ].join('\n')
    const result = Bun.spawnSync(['/usr/bin/python3', '-c', program, helper], {
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({ path: 'strict-trust' })
  })

  test('Claude 2.1.246の警告付きtrust画面だけを完全一致で受理する', () => {
    const helper = realpathSync(join(import.meta.dir, 'fifth-advisor.py'))
    const program = [
      'import importlib.util,json,sys',
      'spec=importlib.util.spec_from_file_location("fifth_advisor",sys.argv[1])',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'root="/tmp/project"',
      'screen="\\n".join([',
      ' "Accessing workspace:",',
      ' root,',
      ' "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what\'s in this folder first.",',
      ' "Claude Code\'ll be able to read, edit, and execute files here.",',
      ' "Security guide",',
      ' "❯ 1. Yes, I trust this folder",',
      ' "  2. No, exit",',
      ' "Enter to confirm · Esc to cancel",',
      '])',
      'print(json.dumps({"exact":module._strict_trust_screen(screen,root),"changed":module._strict_trust_screen(screen.replace("Security guide","Security overview"),root)},sort_keys=True))',
    ].join('\n')
    const result = Bun.spawnSync(['/usr/bin/python3', '-c', program, helper], {
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({ changed: false, exact: true })
  })

  test('trust確認直後に同じblocked画面が残ってもEnterを再送せずreadyを待つ', () => {
    const helper = realpathSync(join(import.meta.dir, 'fifth-advisor.py'))
    const program = [
      'import importlib.util,json,sys,types',
      'spec=importlib.util.spec_from_file_location("fifth_advisor",sys.argv[1])',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'workspace={"agent_name":"fifth-test","workspace_id":"wOWN","pane_id":"wOWN:p1","terminal_id":"term_012345abcdef","project_root":"/tmp/project"}',
      'blocked={"name":"fifth-test","agent":"claude","workspace_id":"wOWN","pane_id":"wOWN:p1","terminal_id":"term_012345abcdef","cwd":"/tmp/project","agent_status":"blocked","interactive_ready":False,"launch_pending":True,"state_change_seq":8}',
      'ready={"name":"fifth-test","agent":"claude","workspace_id":"wOWN","pane_id":"wOWN:p1","terminal_id":"term_012345abcdef","cwd":"/tmp/project","agent_status":"idle","interactive_ready":True,"launch_pending":False,"state_change_seq":9}',
      'screen="\\n".join(["Accessing workspace:","/tmp/project","Quick safety check: Is this a project you created or one you trust?","❯ 1. Yes, I trust this folder","  2. No, exit","Enter to confirm · Esc to cancel"])',
      'agents=iter([blocked,blocked,blocked,ready])',
      'screens=iter([screen,screen,screen])',
      'calls=[]',
      'module._agent_information=lambda target: ({},dict(next(agents)))',
      'module._read_visible=lambda target: next(screens)',
      'module._run_herdr=lambda args: (calls.append(list(args)) or types.SimpleNamespace(returncode=0))',
      'module.time.sleep=lambda seconds: None',
      'module.time.monotonic=lambda: 0.0',
      'resolved=module._settle_after_trust("fifth-test",workspace)',
      'print(json.dumps({"status":resolved["agent_status"],"calls":calls},sort_keys=True))',
    ].join('\n')
    const result = Bun.spawnSync(['/usr/bin/python3', '-c', program, helper], {
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({
      calls: [['agent', 'send-keys', 'fifth-test', 'Enter']],
      status: 'idle',
    })
  })

  test('trust確認後の別blocked画面には追加キーを送らずfail closedにする', () => {
    const helper = realpathSync(join(import.meta.dir, 'fifth-advisor.py'))
    const program = [
      'import importlib.util,json,sys,types',
      'spec=importlib.util.spec_from_file_location("fifth_advisor",sys.argv[1])',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'workspace={"agent_name":"fifth-test","workspace_id":"wOWN","pane_id":"wOWN:p1","terminal_id":"term_012345abcdef","project_root":"/tmp/project"}',
      'blocked={"name":"fifth-test","agent":"claude","workspace_id":"wOWN","pane_id":"wOWN:p1","terminal_id":"term_012345abcdef","cwd":"/tmp/project","agent_status":"blocked","interactive_ready":False,"launch_pending":True,"state_change_seq":8}',
      'changed=dict(blocked,state_change_seq=9)',
      'screen="\\n".join(["Accessing workspace:","/tmp/project","Quick safety check: Is this a project you created or one you trust?","❯ 1. Yes, I trust this folder","  2. No, exit","Enter to confirm · Esc to cancel"])',
      'agents=iter([blocked,blocked,changed])',
      'screens=iter([screen,screen,"WARNING: Claude Code running in Bypass Permissions mode"])',
      'calls=[]',
      'module._agent_information=lambda target: ({},dict(next(agents)))',
      'module._read_visible=lambda target: next(screens)',
      'module._run_herdr=lambda args: (calls.append(list(args)) or types.SimpleNamespace(returncode=0))',
      'module.time.sleep=lambda seconds: None',
      'module.time.monotonic=lambda: 0.0',
      'error=None',
      'try: module._settle_after_trust("fifth-test",workspace)',
      'except module.UnsafeRequest as caught: error=str(caught)',
      'print(json.dumps({"error":error,"calls":calls},sort_keys=True))',
    ].join('\n')
    const result = Bun.spawnSync(['/usr/bin/python3', '-c', program, helper], {
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({
      calls: [['agent', 'send-keys', 'fifth-test', 'Enter']],
      error: 'ephemeral Claude reached another blocked startup UI',
    })
  })

  test('sendは本文をprocess argvへ載せずowner-only Herdr socketへ1回だけ送る', async () => {
    const home = fixture()
    const { project, request } = gitProject(home)
    const confidential = 'READ-ONLY-SLACK-ARGV-SENTINEL-7F81A4E2'
    writeFileSync(join(request, 'prompt'), `${confidential}\n`, { mode: 0o600 })
    const helper = installFifthAdvisorHelper(home)
    const lifecycle = fakeLifecycle(home, project)
    const socketPath = join(realpathSync(home), 'herdr.sock')
    const requestLog = join(home, 'socket-request.json')
    const ready = join(home, 'socket-ready')
    const serverCode = [
      'import json,os,socket,sys,time',
      'socket_path,request_log,ready=sys.argv[1:4]',
      'server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)',
      'server.bind(socket_path)',
      'os.chmod(socket_path,0o600)',
      'server.listen(1)',
      'descriptor=os.open(ready,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)',
      'os.close(descriptor)',
      'connection,_=server.accept()',
      'raw=bytearray()',
      'while b"\\n" not in raw:',
      ' chunk=connection.recv(65536)',
      ' if not chunk: raise SystemExit(2)',
      ' raw.extend(chunk)',
      ' if len(raw)>4*1024*1024: raise SystemExit(3)',
      'line,separator,trailing=bytes(raw).partition(b"\\n")',
      'if separator!=b"\\n" or trailing: raise SystemExit(4)',
      'request=json.loads(line)',
      'descriptor=os.open(request_log,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)',
      'os.write(descriptor,line+b"\\n")',
      'os.fsync(descriptor)',
      'os.close(descriptor)',
      'time.sleep(1)',
      'response={"id":request["id"],"result":{"type":"agent_prompt","status":"idle"}}',
      'connection.sendall((json.dumps(response,separators=(",",":"))+"\\n").encode())',
      'connection.close()',
      'server.close()',
    ].join('\n')
    const server = Bun.spawn([
      '/usr/bin/python3', '-c', serverCode, socketPath, requestLog, ready,
    ], { env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' })
    const serverStdout = new Response(server.stdout).text()
    const serverStderr = new Response(server.stderr).text()
    let serverExpectedToComplete = false
    try {
      const readyDeadline = Date.now() + 5_000
      while (!existsSync(ready) && Date.now() < readyDeadline) await Bun.sleep(10)
      expect(existsSync(ready)).toBe(true)
      lifecycle.environment.HERDR_SOCKET_PATH = socketPath
      const snapshot = Bun.spawnSync([
        '/usr/bin/python3', helper, 'snapshot',
        '--project-root', project, '--request-dir', request,
      ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
      expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0)
      writeLifecycleIntent(request, project)
      writeLifecycleWorkspace(request, project, lifecycle.environment.ZEROKUN_CLAUDE_BIN_PATH!)

      const sent = Bun.spawn([
        '/usr/bin/python3', helper, 'send',
        '--project-root', project, '--request-dir', request, '--owned',
      ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
      const sentStdout = new Response(sent.stdout).text()
      const sentStderr = new Response(sent.stderr).text()
      const requestDeadline = Date.now() + 5_000
      while (!existsSync(requestLog) && Date.now() < requestDeadline) await Bun.sleep(10)
      if (!existsSync(requestLog)) {
        const exitCode = await sent.exited
        throw new Error(
          `helper did not reach Herdr socket (exit=${exitCode}): `
          + `${await sentStdout}${await sentStderr}`,
        )
      }
      serverExpectedToComplete = true
      const processes = Bun.spawnSync(['/bin/ps', '-axo', 'command='], {
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(processes.exitCode).toBe(0)
      expect(processes.stdout.toString()).not.toContain(confidential)
      expect(await sent.exited).toBe(0)
      expect(await sentStdout).toContain('prompt-started')
      expect(await sentStderr).toBe('')

      const observed = JSON.parse(readFileSync(requestLog, 'utf8')) as {
        method: string
        params: { target: string, text: string, wait: { until: string[], timeout_ms: number } }
      }
      expect(observed.method).toBe('agent.prompt')
      expect(observed.params.target).toBe(`fifth-${lifecycleNonce.slice(0, 20)}`)
      expect(observed.params.text).toContain(confidential)
      expect(observed.params.wait).toEqual({
        until: ['idle', 'done', 'blocked'],
        timeout_ms: 120_000,
      })
    } finally {
      const settled = await Promise.race([
        server.exited,
        Bun.sleep(1_000).then(() => null),
      ])
      if (settled === null && server.exitCode === null) server.kill('SIGKILL')
      const exitCode = await server.exited
      const stderr = await serverStderr
      await serverStdout
      if (serverExpectedToComplete) expect(exitCode, stderr).toBe(0)
    }
  }, 15_000)

  test('exact closeはforeign workspaceとprotected差を監査値に留め再実行可能にする', () => {
    const home = fixture()
    const { project, request } = gitProject(home)
    const helper = installFifthAdvisorHelper(home)
    const lifecycle = fakeLifecycle(home, project)
    const snapshot = Bun.spawnSync([
      '/usr/bin/python3', helper, 'snapshot',
      '--project-root', project, '--request-dir', request,
    ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
    expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0)
    writeLifecycleIntent(request, project)
    const claude = lifecycle.environment.ZEROKUN_CLAUDE_BIN_PATH!
    writeLifecycleWorkspace(request, project, claude)
    mkdirSync(join(project, '.credentials'), { mode: 0o700 })

    const closed = Bun.spawnSync([
      '/usr/bin/python3', helper, 'close',
      '--project-root', project, '--request-dir', request,
    ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
    expect(closed.exitCode, closed.stderr.toString()).toBe(0)
    expect(closed.stdout.toString()).toContain('ephemeral-workspace-closed')
    const receipt = JSON.parse(readFileSync(
      join(request, 'ephemeral-session-closed.json'),
      'utf8',
    )) as Record<string, unknown>
    expect(receipt).toMatchObject({
      status: 'closed-and-verified',
      close_target_verified: true,
      workspace_absent: true,
      pane_absent: true,
      agent_absent: true,
      catalog_restored: false,
      protected_unchanged: false,
      processes_exited: true,
    })
    expect(JSON.parse(readFileSync(lifecycle.state, 'utf8')).owned).toBe(false)

    // Simulate a process crash after Herdr accepted the close but before the
    // durable receipt became observable. Exact recorded identity absence must
    // be enough to recreate the receipt without touching foreign workspaces.
    rmSync(join(request, 'ephemeral-session-closed.json'))
    const crashRecovered = Bun.spawnSync([
      '/usr/bin/python3', helper, 'close',
      '--project-root', project, '--request-dir', request,
    ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
    expect(crashRecovered.exitCode, crashRecovered.stderr.toString()).toBe(0)
    expect(crashRecovered.stdout.toString()).toContain('ephemeral-workspace-already-closed')

    const repeated = Bun.spawnSync([
      '/usr/bin/python3', helper, 'close',
      '--project-root', project, '--request-dir', request,
    ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
    expect(repeated.exitCode, repeated.stderr.toString()).toBe(0)
    expect(repeated.stdout.toString()).toContain('ephemeral-workspace-already-closed')
  })

  test('workspace receipt後・agent start前のcrashを存在時も既消失時も冪等回収する', () => {
    for (const workspaceInitiallyPresent of [true, false]) {
      const home = fixture()
      const { project, request } = gitProject(home)
      const helper = installFifthAdvisorHelper(home)
      const lifecycle = fakeLifecycle(home, project)
      const snapshot = Bun.spawnSync([
        '/usr/bin/python3', helper, 'snapshot',
        '--project-root', project, '--request-dir', request,
      ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
      expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0)
      writeLifecycleIntent(request, project)
      writeLifecycleWorkspace(
        request,
        project,
        lifecycle.environment.ZEROKUN_CLAUDE_BIN_PATH!,
        false,
      )
      const state = JSON.parse(readFileSync(lifecycle.state, 'utf8')) as Record<string, unknown>
      state.owned = workspaceInitiallyPresent
      state.agent = false
      state.process = false
      writeFileSync(lifecycle.state, `${JSON.stringify(state)}\n`, { mode: 0o600 })

      const closed = Bun.spawnSync([
        '/usr/bin/python3', helper, 'close',
        '--project-root', project, '--request-dir', request,
      ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
      expect(closed.exitCode, closed.stderr.toString()).toBe(0)
      expect(closed.stdout.toString()).toContain(
        workspaceInitiallyPresent
          ? 'ephemeral-workspace-closed'
          : 'ephemeral-workspace-already-closed',
      )
      const receipt = JSON.parse(readFileSync(
        join(request, 'ephemeral-session-closed.json'),
        'utf8',
      )) as Record<string, unknown>
      expect(receipt).toMatchObject({
        status: 'closed-and-verified',
        workspace_absent: true,
        pane_absent: true,
        agent_absent: true,
        processes_exited: true,
      })
    }
  })

  test('workspace/start receiptの途中publicationを捨ててexact cleanupへ進む', () => {
    {
      const home = fixture()
      const { project, request } = gitProject(home)
      const helper = installFifthAdvisorHelper(home)
      const lifecycle = fakeLifecycle(home, project)
      const snapshot = Bun.spawnSync([
        '/usr/bin/python3', helper, 'snapshot',
        '--project-root', project, '--request-dir', request,
      ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
      expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0)
      writeLifecycleIntent(request, project)
      const staged = join(request, '.ephemeral-workspace-receipt.json.pending')
      writeFileSync(staged, '{"version":', { mode: 0o600 })
      const state = JSON.parse(readFileSync(lifecycle.state, 'utf8')) as Record<string, unknown>
      state.agent = false
      state.process = false
      writeFileSync(lifecycle.state, `${JSON.stringify(state)}\n`, { mode: 0o600 })

      const recovered = Bun.spawnSync([
        '/usr/bin/python3', helper, 'recover',
        '--project-root', project, '--request-dir', request,
      ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
      expect(recovered.exitCode, recovered.stderr.toString()).toBe(0)
      expect(recovered.stdout.toString()).toContain('ephemeral-provisional-reconciled')
      expect(existsSync(staged)).toBe(false)
      expect(JSON.parse(readFileSync(lifecycle.state, 'utf8')).owned).toBe(false)
    }

    {
      const home = fixture()
      const { project, request } = gitProject(home)
      const helper = installFifthAdvisorHelper(home)
      const lifecycle = fakeLifecycle(home, project)
      const snapshot = Bun.spawnSync([
        '/usr/bin/python3', helper, 'snapshot',
        '--project-root', project, '--request-dir', request,
      ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
      expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0)
      writeLifecycleIntent(request, project)
      writeLifecycleWorkspace(
        request,
        project,
        lifecycle.environment.ZEROKUN_CLAUDE_BIN_PATH!,
        false,
      )
      const staged = join(request, '.ephemeral-agent-start-intent.json.pending')
      writeFileSync(staged, '{"version":', { mode: 0o600 })
      const state = JSON.parse(readFileSync(lifecycle.state, 'utf8')) as Record<string, unknown>
      state.agent = false
      state.process = false
      writeFileSync(lifecycle.state, `${JSON.stringify(state)}\n`, { mode: 0o600 })

      const closed = Bun.spawnSync([
        '/usr/bin/python3', helper, 'close',
        '--project-root', project, '--request-dir', request,
      ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
      expect(closed.exitCode, closed.stderr.toString()).toBe(0)
      expect(closed.stdout.toString()).toContain('ephemeral-workspace-closed')
      expect(existsSync(staged)).toBe(false)
      expect(JSON.parse(readFileSync(lifecycle.state, 'utf8')).owned).toBe(false)
    }
  })

  test('provisional recoverはnonce labelだけを閉じforeign差があっても冪等に完了する', () => {
    const home = fixture()
    const { project, request } = gitProject(home)
    const helper = installFifthAdvisorHelper(home)
    const lifecycle = fakeLifecycle(home, project)
    const snapshot = Bun.spawnSync([
      '/usr/bin/python3', helper, 'snapshot',
      '--project-root', project, '--request-dir', request,
    ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
    expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0)
    writeLifecycleIntent(request, project)
    rmSync(project, { recursive: true, force: true })

    const recovered = Bun.spawnSync([
      '/usr/bin/python3', helper, 'recover',
      '--project-root', project, '--request-dir', request,
    ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
    expect(recovered.exitCode, recovered.stderr.toString()).toBe(0)
    expect(recovered.stdout.toString()).toContain('ephemeral-provisional-reconciled')
    const receipt = JSON.parse(readFileSync(
      join(request, 'ephemeral-session-closed.json'),
      'utf8',
    )) as Record<string, unknown>
    expect(receipt).toMatchObject({
      status: 'provisional-workspace-closed',
      close_target_verified: true,
      workspace_absent: true,
      label_absent: true,
      catalog_restored: false,
      project_location_verified: false,
      protected_unchanged: false,
    })

    const repeated = Bun.spawnSync([
      '/usr/bin/python3', helper, 'recover',
      '--project-root', project, '--request-dir', request,
    ], { env: lifecycle.environment, stdout: 'pipe', stderr: 'pipe' })
    expect(repeated.exitCode, repeated.stderr.toString()).toBe(0)
    expect(repeated.stdout.toString()).toContain('ephemeral-provisional-already-reconciled')
  })
})
