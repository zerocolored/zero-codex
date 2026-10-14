import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { UnityEditorRuntime, listUnityEditors, unityProjectVersion, unityMcpReadiness, type UnityEditorDependencies } from './unity-editor-runtime.ts'
import { prepareManagedStateRoot } from './managed-path.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/zero-unity-test-')); roots.push(root)
  const project = join(root, 'project with spaces'); mkdirSync(project)
  for (const name of ['Assets', 'Packages', 'ProjectSettings']) mkdirSync(join(project, name))
  const versionPath = join(project, 'ProjectSettings/ProjectVersion.txt')
  writeFileSync(versionPath, 'm_EditorVersion: 6000.3.26f1\n')
  const calls = { resolve: 0, open: 0, inspect: 0 }, live: { pid: number; project: string }[] = []
  let connected = false
  const deps: UnityEditorDependencies = {
    async resolve(value) { calls.resolve++; expect(value).toBe(project); return { project, editor: '/installed/Unity.app', cli: '/installed/unity' } },
    async editors() { return live },
    async open(value) { expect(value.project).toBe(project); calls.open++ },
    async inspect(value) { expect(value.project).toBe(project); calls.inspect++; return { connected, tools: connected ? ['editor_status'] : [] } },
  }
  return { root, project, versionPath, calls, live, deps, connect: () => { connected = true } }
}

test.skipIf(process.platform !== 'darwin')('host process discovery cannot import project or PYTHONPATH modules', async () => {
  const f = fixture(), marker = join(f.root, 'unexpected-python-import')
  for (const name of ['ctypes.py', 'json.py', 'subprocess.py', 'struct.py']) {
    writeFileSync(join(f.project, name), `open(${JSON.stringify(marker)}, 'w').write('project code executed')\nraise RuntimeError('untrusted project module')\n`)
  }
  const source = `import {listUnityEditors} from ${JSON.stringify(join(import.meta.dir, 'unity-editor-runtime.ts'))}; console.log(JSON.stringify(await listUnityEditors()))`
  const child = Bun.spawn([process.execPath, '--config=/dev/null', '--no-env-file', '-e', source], {
    cwd: f.project, env: { ...process.env, PYTHONPATH: f.project }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(error).toBe(''); expect(code).toBe(0)
  expect(Array.isArray(JSON.parse(output))).toBe(true)
  expect(existsSync(marker)).toBe(false)
}, 20_000)

test.skipIf(process.platform !== 'darwin')('real process discovery recognizes lowercase and inline Unity project arguments', async () => {
  const f = fixture(), executable = join(f.root, 'Unity.app/Contents/MacOS/Unity')
  mkdirSync(join(f.root, 'Unity.app/Contents/MacOS'), { recursive: true })
  const source = join(f.root, 'fixture.c')
  writeFileSync(source, '#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n')
  const compiler = Bun.spawn(['/usr/bin/cc', source, '-o', executable], { stdout: 'ignore', stderr: 'pipe' })
  const compilerError = await new Response(compiler.stderr).text()
  expect(compilerError).toBe(''); expect(await compiler.exited).toBe(0)
  for (const args of [['-projectpath', f.project], [`-projectPath=${f.project}`]]) {
    const child = Bun.spawn([executable, ...args], { stdout: 'ignore', stderr: 'ignore' })
    try {
      const found = (await listUnityEditors()).find(editor => editor.pid === child.pid)
      expect(found?.project).toBe(f.project)
      const runtime = new UnityEditorRuntime(f.project, true, { ...f.deps, editors: listUnityEditors })
      expect(await runtime.run('open')).toMatchObject({ launched: false, editorPids: [child.pid] })
      expect(f.calls.open).toBe(0)
      await runtime.close()
    } finally { child.kill(); await child.exited }
  }
}, 30_000)

test('Unity versions come from the pinned project, including future installed versions', () => {
  const f = fixture()
  expect(unityProjectVersion(f.project)).toBe('6000.3.26f1')
  writeFileSync(f.versionPath, 'm_EditorVersion: 7000.2.0b3\r\n')
  expect(unityProjectVersion(f.project)).toBe('7000.2.0b3')
  for (const value of ['../../Other.app', '6000.3.26f1 -executeMethod Inject', '']) {
    writeFileSync(f.versionPath, `m_EditorVersion: ${value}\n`)
    expect(() => unityProjectVersion(f.project)).toThrow('valid m_EditorVersion')
  }
})
test('Unity project metadata cannot redirect host reads outside the project', () => {
  const f = fixture(), outside = join(f.root, 'outside.txt')
  writeFileSync(outside, 'm_EditorVersion: 6000.3.26f1\n')
  rmSync(f.versionPath); symlinkSync(outside, f.versionPath)
  expect(() => unityProjectVersion(f.project)).toThrow('belong to the current project')
  rmSync(join(f.project, 'Assets'), { recursive: true }); symlinkSync(f.root, join(f.project, 'Assets'))
  expect(() => unityProjectVersion(f.project)).toThrow('belong to the current project')
})
test('read-only and legacy contexts cannot reach any native operation', async () => {
  const f = fixture(), runtime = new UnityEditorRuntime(f.project, false, f.deps)
  await expect(runtime.run('open')).rejects.toThrow('read-only')
  await expect(runtime.run('status')).rejects.toThrow('read-only')
  expect(f.calls).toEqual({ resolve: 0, open: 0, inspect: 0 })
})
test('status never launches and an open success is not MCP readiness', async () => {
  const f = fixture(), runtime = new UnityEditorRuntime(f.project, true, f.deps)
  expect(await runtime.run('status')).toMatchObject({ status: 'not-running', connected: false })
  expect(f.calls.open).toBe(0)
  expect(await runtime.run('open')).toMatchObject({ status: 'starting', connected: false, launched: true })
  expect(f.calls.open).toBe(1)
  await runtime.run('open')
  expect(f.calls.open).toBe(1)
})
test('same-project Editor is reused; other Editors are never closed or mistaken for this project', async () => {
  const f = fixture(), runtime = new UnityEditorRuntime(f.project, true, f.deps)
  f.live.push({ pid: 101, project: f.root }, { pid: 102, project: f.project })
  expect(await runtime.run('open')).toMatchObject({ editorPids: [102], launched: false, connected: false })
  expect(f.calls.open).toBe(0)
  f.connect()
  expect(await runtime.run('status')).toMatchObject({ status: 'connected', connected: true, editorPids: [102] })
})
test('concurrent launch calls are coalesced and uncertain launches are not repeated by a replacement broker', async () => {
  const f = fixture(), state = prepareManagedStateRoot(join(f.root, 'state'))
  const runtime = new UnityEditorRuntime(f.project, true, f.deps, state)
  const results = await Promise.all([runtime.run('open'), runtime.run('open')])
  expect(results[0]).toEqual(results[1]); expect(f.calls.open).toBe(1)
  await new UnityEditorRuntime(f.project, true, f.deps, state).run('open')
  expect(f.calls.open).toBe(1)
})
test('a failed or timed-out launch is not automatically repeated', async () => {
  const f = fixture(), state = prepareManagedStateRoot(join(f.root, 'state'))
  f.deps.open = async () => { f.calls.open++; throw new Error('uncertain open timeout') }
  await expect(new UnityEditorRuntime(f.project, true, f.deps, state).run('open')).rejects.toThrow('timeout')
  await new UnityEditorRuntime(f.project, true, f.deps, state).run('open')
  expect(f.calls.open).toBe(1)
})
test('installation or process inspection failure never launches', async () => {
  const f = fixture()
  f.deps.editors = async () => { throw new Error('process inspection failed') }
  await expect(new UnityEditorRuntime(f.project, true, f.deps).run('open')).rejects.toThrow('inspection')
  expect(f.calls.open).toBe(0)
})
test('MCP readiness requires the actual project response and filters unrelated fields', () => {
  const f = fixture()
  const value = { projectPath: f.project, status: 'ready', compiling: false, secret: 'synthetic-not-returned' }
  const response = { content: [{ type: 'text', text: JSON.stringify(value) }] }
  const ready = unityMcpReadiness(response, f.project)
  expect(ready.connected).toBe(true)
  expect(JSON.stringify(ready)).not.toContain('synthetic-not-returned')
  expect(unityMcpReadiness({ ...response, isError: true }, f.project).connected).toBe(false)
  expect(unityMcpReadiness({ content: [{ type: 'text', text: 'connected' }] }, f.project).connected).toBe(false)
  expect(() => unityMcpReadiness({ structuredContent: { ...value, projectPath: f.root } }, f.project)).toThrow('different project')
  expect(unityMcpReadiness({ structuredContent: { data: value } }, f.project).connected).toBe(true)
  for (const projectPath of ['.', '', 'relative/path']) {
    expect(unityMcpReadiness({ structuredContent: { ...value, projectPath } }, f.project).connected).toBe(false)
  }
  const malformed = unityMcpReadiness({ structuredContent: { ...value,
    status: { secret: 'synthetic-sensitive' }, compiling: 'synthetic-sensitive',
    domainReloadInProgress: { secret: 'synthetic-sensitive' }, playMode: 'synthetic-sensitive',
    unityVersion: 'synthetic-sensitive',
  } }, f.project)
  expect(JSON.stringify(malformed)).not.toContain('synthetic-sensitive')
  expect(malformed.connected).toBe(true)
})

test('an open requested during a status check launches once instead of being swallowed', async () => {
  const f = fixture(), runtime = new UnityEditorRuntime(f.project, true, f.deps)
  const status = runtime.run('status')
  const open = runtime.run('open')
  const duplicate = runtime.run('open')
  expect(await status).toMatchObject({ launched: false })
  expect(await open).toMatchObject({ launched: true })
  await duplicate
  expect(f.calls.open).toBe(1)
})

test('closing a broker during installation discovery prevents a later native launch', async () => {
  const f = fixture()
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const resolve = f.deps.resolve
  f.deps.resolve = async project => { await ready; return resolve(project) }
  const runtime = new UnityEditorRuntime(f.project, true, f.deps)
  const pending = runtime.run('open')
  const closed = runtime.close()
  release()
  await expect(pending).rejects.toThrow('closing')
  await closed
  expect(f.calls.open).toBe(0)
  await expect(runtime.run('status')).rejects.toThrow('closing')
})
