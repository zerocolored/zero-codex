import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'fs'
import { join, relative, isAbsolute } from 'path'
import { buildCodexChildEnvironment } from './codex-executor.ts'
import { createHash } from 'crypto'
import { ensureManagedDirectory } from './managed-path.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { tryAcquireProcessLock, releaseProcessLock } from './process-lock.ts'

export type UnityEditorAction = 'open' | 'status'
type Installation = { project: string; editor: string; cli: string }
type Editor = { pid: number; project: string }
type McpState = { connected: boolean; tools: string[]; editorStatus?: unknown }
export interface UnityEditorDependencies {
  resolve(project: string): Promise<Installation>
  editors(): Promise<Editor[]>
  open(installation: Installation): Promise<void>
  inspect(installation: Installation): Promise<McpState>
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function unityProjectVersion(project: string): string {
  const root = realpathSync(project)
  for (const directory of ['Assets', 'Packages', 'ProjectSettings']) {
    const path = realpathSync(join(root, directory))
    if (!inside(root, path) || !statSync(path).isDirectory()) throw new Error('Unity project directories must belong to the current project')
  }
  const path = join(root, 'ProjectSettings', 'ProjectVersion.txt')
  if (!inside(root, realpathSync(path))) throw new Error('Unity version file must belong to the current project')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(fd)
    if (!metadata.isFile() || metadata.size > 16_384) throw new Error('Invalid Unity version file')
    const text = readFileSync(fd, 'utf8')
    const version = /^m_EditorVersion: (\d+\.\d+\.\d+[abfp]\d+)\s*$/m.exec(text)?.[1]
    if (!version) throw new Error('Unity project has no valid m_EditorVersion')
    return version
  } finally { closeSync(fd) }
}

async function command(argv: string[], timeout = 15_000, env = buildCodexChildEnvironment()): Promise<string> {
  const child = Bun.spawn(argv, { cwd: '/', env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`Unity host operation failed (${argv[0]}, exit ${code}): ${stderr.slice(0, 1000)}`)
  if (stdout.length > 2 * 1024 * 1024) throw new Error('Unity host result exceeded its limit')
  return stdout
}

const signatures = new Map<string, string>()
async function signedUnity(path: string): Promise<string> {
  const physical = realpathSync(path)
  const executable = physical.endsWith('.app') ? join(physical, 'Contents/MacOS/Unity') : physical
  const s = statSync(executable)
  const identity = JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs])
  if (signatures.get(physical) !== identity) {
    await command(['/usr/bin/codesign', '--verify', '--strict', '-R',
      '=anchor apple generic and certificate leaf[subject.OU] = "9QW8UQUTAA" and ' +
      (physical.endsWith('.app') ? 'identifier "com.unity3d.UnityEditor5.x"' :
        '(identifier "unity-darwin-arm64" or identifier "unity-darwin-x64")'), physical], 30_000)
    signatures.set(physical, identity)
  }
  return physical
}

// Return only the project argument of actual Editor processes. Do not expose
// arbitrary process argv/environment (which may contain other tasks' secrets).
const EDITORS = `import ctypes,json,subprocess,struct,os
lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
rows=subprocess.check_output(['/bin/ps','-axo','pid=,comm='],text=True).splitlines()
result=[]
for row in rows:
 parts=row.strip().split(None,1)
 if len(parts)!=2 or not parts[1].endswith('/Unity.app/Contents/MacOS/Unity'):continue
 pid=int(parts[0]);size=ctypes.c_size_t(1024*1024);buf=ctypes.create_string_buffer(size.value);mib=(ctypes.c_int*3)(1,49,pid)
 if lib.sysctl(mib,3,buf,ctypes.byref(size),None,0)!=0:
  try:os.kill(pid,0)
  except ProcessLookupError:continue
  raise RuntimeError('Cannot inspect existing Unity Editor; refusing duplicate launch')
 data=buf.raw[:size.value];argc=struct.unpack_from('i',data)[0];offset=data.index(b'\\0',4)+1
 while offset<len(data) and data[offset]==0:offset+=1
 args=[]
 for i in range(argc):
  end=data.index(b'\\0',offset);args.append(data[offset:end].decode('utf-8'));offset=end+1
 for index,arg in enumerate(args):
  if arg.lower()=='-projectpath' and index+1<len(args):
   result.append({'pid':pid,'project':os.path.realpath(args[index+1])});break
  if arg.lower().startswith('-projectpath='):
   result.append({'pid':pid,'project':os.path.realpath(arg.split('=',1)[1])});break
print(json.dumps(result))
`

export async function listUnityEditors(): Promise<Editor[]> {
  // Host discovery must not import Python modules from the writable project,
  // user site, or environment. Only the fixed stdlib script executes here.
  return JSON.parse(await command(['/usr/bin/python3', '-I', '-c', EDITORS], 15_000,
    { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' })) as Editor[]
}

const dependencies: UnityEditorDependencies = {
  async resolve(project) {
    if (process.platform !== 'darwin') throw new Error('Unity native launch currently requires macOS')
    const version = unityProjectVersion(project)
    const editor = await signedUnity(`/Applications/Unity/Hub/Editor/${version}/Unity.app`)
    const cli = Bun.which('unity')
    if (!cli) throw new Error('Unity CLI is not installed')
    return { project: realpathSync(project), editor, cli: await signedUnity(cli) }
  },
  editors: listUnityEditors,
  async open({ editor, project }) {
    // Explicit handoff: the user's Editor outlives the command and job. Never
    // make it a descendant of the sandbox command reaper, or close other apps.
    await command(['/usr/bin/open', '-n', '-a', editor, '--args', '-projectPath', project])
  },
  async inspect({ cli, project }) {
    const client = new Client({ name: 'zerochan-unity-readiness', version: '1.0.0' })
    const transport = new StdioClientTransport({ command: cli, args: ['mcp', '--project-path', project],
      // Project selection is explicit; do not inherit the project's cwd as
      // an implicit CLI configuration or executable lookup location.
      cwd: '/', env: buildCodexChildEnvironment(), stderr: 'ignore' })
    try {
      await client.connect(transport, { timeout: 10_000 })
      const result = await client.listTools({}, { timeout: 10_000 })
      const tools = result.tools.some(tool => tool.name === 'editor_status') ? ['editor_status'] : []
      // Only a fixed read-only Editor operation is exposed on the host. Do not
      // forward arbitrary MCP tools, eval code, paths, shell commands or URLs.
      if (!tools.includes('editor_status')) return { connected: false, tools }
      const status = await client.callTool({ name: 'editor_status', arguments: {} }, undefined, { timeout: 10_000 })
      return { tools, ...unityMcpReadiness(status, project) }
    } finally { await client.close() }
  },
}

/** Validate the response's project as well as transport success, and expose
 * only readiness fields, never arbitrary log text or credential material. */
export function unityMcpReadiness(result: any, project: string): Omit<McpState, 'tools'> {
  if (result?.isError === true) return { connected: false }
  const candidates = [result?.structuredContent]
  for (const block of result?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length <= 1024 * 1024) {
      try { candidates.push(JSON.parse(block.text)) } catch { /* Not a structured status. */ }
    }
  }
  for (const value of candidates) for (const status of [value, value?.data, value?.result]) {
    if (!status || typeof status.projectPath !== 'string' || !isAbsolute(status.projectPath)
      || status.projectPath.length > 4096) continue
    let matches = false
    try { matches = realpathSync(status.projectPath) === realpathSync(project) } catch {}
    if (!matches) throw new Error('Unity MCP returned a different project; no connection was accepted')
    return { connected: true, editorStatus: {
      projectPath: project,
      status: ['ready', 'compiling', 'reloading', 'playing', 'busy', 'blocked_by_dialog'].includes(status.status) ? status.status : undefined,
      compiling: typeof status.compiling === 'boolean' ? status.compiling : undefined,
      domainReloadInProgress: typeof status.domainReloadInProgress === 'boolean' ? status.domainReloadInProgress : undefined,
      playMode: ['playing', 'paused', 'stopped'].includes(status.playMode) ? status.playMode : undefined,
      unityVersion: typeof status.unityVersion === 'string' && /^\d+\.\d+\.\d+[abfp]\d+$/.test(status.unityVersion) ? status.unityVersion : undefined,
    } }
  }
  return { connected: false }
}

/** A narrow host capability, not an unsandboxed shell or project .mcp loader. */
export class UnityEditorRuntime {
  private pending: Promise<unknown> | undefined
  private pendingAction: UnityEditorAction | undefined
  private openedAt = 0
  private closing = false
  constructor(private project: string, private allowed: boolean, private deps = dependencies, private stateDir?: string) {}

  async run(action: UnityEditorAction): Promise<unknown> {
    if (this.closing) throw new Error('Unity integration is closing')
    if (!this.allowed) throw new Error('Unity native integration is unavailable in read-only tasks')
    // Coalesce concurrent calls within this broker, including an uncertain
    // launch response. Existing process inspection also covers later jobs.
    if (this.pending) {
      if (action === 'status' || this.pendingAction === 'open') return this.pending
      await this.pending
      return this.run(action)
    }
    const request = this.locked(action)
    this.pending = request
    this.pendingAction = action
    try { return await request } finally { this.pending = undefined; this.pendingAction = undefined }
  }

  async close(): Promise<void> {
    this.closing = true
    try { await this.pending } catch { /* The caller receives the operation error. */ }
    // Each inspect owns and closes its MCP transport. The user-facing Editor
    // is an intentional LaunchServices handoff, not a broker child to reap.
  }

  private async locked(action: UnityEditorAction) {
    if (!this.stateDir) return this.perform(action)
    const root = ensureManagedDirectory(this.stateDir, join(this.stateDir, 'unity-editor'))
    const key = createHash('sha256').update(this.project).digest('hex')
    const lock = join(root, key + '.lock'), receipt = join(root, key + '.json')
    const attempt = tryAcquireProcessLock(lock)
    if (!attempt.acquired) return { status: 'busy', connected: false, project: this.project,
      next: 'Another request is checking or opening this project. Poll status; do not launch another Editor.' }
    try {
      const text = readOptionalBoundedOwnerOnlyRegularFile(receipt, 4096)
      if (text) {
        const saved = JSON.parse(text)
        if (saved.project === this.project && Number.isFinite(saved.openedAt)) this.openedAt = saved.openedAt
      }
      return await this.perform(action, () => atomicWritePrivateFile(receipt,
        JSON.stringify({ project: this.project, openedAt: this.openedAt })))
    } finally { releaseProcessLock(lock, attempt.lease) }
  }

  private async perform(action: UnityEditorAction, beforeLaunch?: () => void) {
    const installation = await this.deps.resolve(this.project)
    let editors = (await this.deps.editors()).filter(editor => editor.project === installation.project)
    let launched = false
    if (this.closing) throw new Error('Unity integration is closing')
    if (action === 'open' && editors.length === 0 && Date.now() - this.openedAt > 30_000) {
      this.openedAt = Date.now()
      beforeLaunch?.()
      await this.deps.open(installation)
      launched = true
      editors = (await this.deps.editors()).filter(editor => editor.project === installation.project)
    }
    if (this.closing) throw new Error('Unity integration is closing')
    const mcp = await this.deps.inspect(installation)
    return { project: installation.project, editorPids: editors.map(editor => editor.pid), launched,
      status: mcp.connected ? 'connected' : editors.length || launched ? 'starting' : 'not-running',
      ...mcp,
      ...(!mcp.connected ? { next: 'Poll status while Unity imports. Inspect the visible Editor for license, software terms, package or compile errors; do not infer readiness from open exit or folder existence. Software terms require the user’s decision.' } : {}),
      editorLifetime: 'The Editor stays open after this job; this tool never closes an existing Editor.' }
  }
}
