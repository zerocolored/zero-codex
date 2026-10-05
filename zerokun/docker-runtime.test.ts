import { expect, test } from 'bun:test'
import { createServer } from 'net'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { resolveDockerRuntime, type DockerRuntime } from './docker-runtime.ts'
import { buildCodexChildEnvironment, buildCodexPermissionOverrides } from './codex-executor.ts'
import { prepareManagedStateRoot, ensureManagedDirectory } from './managed-path.ts'

async function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/zc-docker-'))
  const socket = join(root, 'engine.sock')
  const server = createServer(c => c.end('docker-fixture'))
  await new Promise<void>(resolve => server.listen(socket, resolve))
  const repo = join(root, 'repo'); mkdirSync(repo)
  const plugins = join(root, 'plugins'); mkdirSync(plugins)
  const state = prepareManagedStateRoot(join(root, 'state'))
  const scratch = ensureManagedDirectory(state, join(state, 'scratch'))
  const out = ensureManagedDirectory(state, join(state, 'out'))
  const job = { id: 'docker', repoPath: repo, writeEnabled: true, attachments: [] } as any
  const runtime: DockerRuntime = { host: `unix://${socket}`, socketPath: socket, pluginDirs: [plugins] }
  const flags = (extra: Record<string, unknown> = {}) => buildCodexPermissionOverrides(job, {
    stateDir: state, scratchDir: scratch, artifactDir: out, executionWriteEnabled: true,
    nativeDockerAccessEnabled: true, dockerRuntime: runtime, profile: 'docker_test', ...extra,
  })
  return { root, socket, server, repo, plugins, state, scratch, out, job, runtime, flags,
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) } }
}

test('resolves selected local context and physical socket without reading Docker auth', async () => {
  const f = await fixture()
  try {
    const alias = join(f.root, 'alias.sock'); symlinkSync(f.socket, alias)
    let observed: Record<string, string> = {}
    const runtime = resolveDockerRuntime({ executable: '/fixture/docker',
      environment: { HOME: f.root, DOCKER_HOST: 'tcp://ignored:2375', DOCKER_CONTEXT: 'selected', DOCKER_CONFIG: '/fixture/config', SECRET: 'must-not-inherit' },
      inspectContext: (_, env) => { observed = env; return `unix://${alias}` }, pluginCandidates: [f.plugins, '/absent/plugin-dir'],
    })
    expect(runtime).toEqual(f.runtime)
    expect(observed.DOCKER_CONTEXT).toBe('selected')
    expect(observed.DOCKER_CONFIG).toBe('/fixture/config')
    expect(observed.SECRET).toBeUndefined()
  } finally { await f.close() }
})

test('explicit host wins over saved context; remote, malformed, missing and non-socket endpoints never fall back', async () => {
  const f = await fixture()
  try {
    const file = join(f.root, 'file'); writeFileSync(file, 'not a socket')
    for (const endpoint of [f.runtime.host, 'tcp://remote:2375', 'ssh://remote', 'unix://relative', `unix://${file}`, `unix://${f.socket}?query`, `unix://${f.root}/../engine.sock`, `unix://${f.root}/missing.sock`]) {
      const runtime = resolveDockerRuntime({ executable: '/fixture/docker', environment: { HOME: f.root, DOCKER_HOST: endpoint },
        inspectContext: () => { throw new Error('must not replace explicit host') }, pluginCandidates: [f.plugins] })
      expect(runtime).toEqual(endpoint === f.runtime.host ? f.runtime : null)
    }
    expect(resolveDockerRuntime({ executable: null })).toBeNull()
    expect(resolveDockerRuntime({ executable: '/fixture/docker', environment: { HOME: f.root }, inspectContext: () => null })).toBeNull()
  } finally { await f.close() }
})

test('write primary receives exact socket and credential-free plugin config, never host HOME or config', async () => {
  const f = await fixture()
  try {
    const parsed = Bun.TOML.parse(f.flags().join('\n')) as any
    expect(parsed.permissions.docker_test.network.unix_sockets).toEqual({ [f.scratch]: 'allow', [f.socket]: 'allow' })
    const env = parsed.shell_environment_policy.set
    expect(env.DOCKER_HOST).toBe(f.runtime.host)
    expect(env.HOME).toBe(f.scratch)
    expect(env.DOCKER_CONTEXT).toBe('')
    expect(env.DOCKER_CONFIG).toBe(join(f.scratch, '.zero-docker'))
    expect(JSON.parse(readFileSync(join(env.DOCKER_CONFIG, 'config.json'), 'utf8'))).toEqual({ cliPluginsExtraDirs: [f.plugins] })
    expect(parsed.permissions.docker_test.filesystem[f.socket]).toBeUndefined()
  } finally { await f.close() }
})

test('review, browser-only, independent stages and protected sockets do not receive Docker authority', async () => {
  const f = await fixture()
  try {
    for (const extra of [
      { nativeDockerAccessEnabled: false }, { executionWriteEnabled: false },
      { executionWriteEnabled: false, browserAccessEnabled: true, localVerificationEnabled: true },
      { dockerRuntime: null },
      { dockerRuntime: { ...f.runtime, socketPath: join(f.state, 'private.sock') } },
    ]) {
      const parsed = Bun.TOML.parse(f.flags(extra).join('\n')) as any
      expect(parsed.permissions.docker_test.network.unix_sockets[f.socket]).toBeUndefined()
      expect(parsed.shell_environment_policy.set.DOCKER_HOST).toBeUndefined()
      expect(parsed.shell_environment_policy.set.DOCKER_CONFIG).toBeUndefined()
    }
    f.job.writeEnabled = false
    expect((Bun.TOML.parse(f.flags().join('\n')) as any).shell_environment_policy.set.DOCKER_HOST).toBeUndefined()
    expect(existsSync(join(f.scratch, '.zero-docker'))).toBe(false)
  } finally { await f.close() }
})

const codex = Bun.which('codex'), node = Bun.which('node')
test.skipIf(process.platform !== 'darwin' || !codex || !node)('real sandbox connects only selected Docker socket; reviews and unrelated sockets stay denied', async () => {
  const f = await fixture()
  const other = join(f.root, 'unrelated.sock')
  const foreign = createServer(c => c.end('foreign'))
  await new Promise<void>(resolve => foreign.listen(other, resolve))
  try {
    const script = join(f.scratch, 'connect.cjs')
    writeFileSync(script, `const net=require('net');
      const connect=p=>new Promise(resolve=>{const c=net.connect(p);c.on('error',e=>resolve(e.code));c.on('data',b=>resolve(b.toString()));});
      (async()=>console.log(JSON.stringify({engine:await connect(${JSON.stringify(f.socket)}),other:await connect(${JSON.stringify(other)})})))();`)
    for (const write of [true, false]) {
      const flags = f.flags({ executionWriteEnabled: write, browserAccessEnabled: true })
      const env = (Bun.TOML.parse(flags.join('\n')) as any).shell_environment_policy.set
      const child = Bun.spawn([codex!, ...flags.flatMap(v => ['-c', v]), 'sandbox', '-P', 'docker_test', '-C', f.repo, '--',
        '/usr/bin/env', ...Object.entries(env).map(([k,v]) => `${k}=${v}`), node!, script],
        { cwd: f.repo, env: buildCodexChildEnvironment(), stdout: 'pipe', stderr: 'pipe' })
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
      const result = JSON.parse(stdout)
      expect(result.engine).toBe(write ? 'docker-fixture' : 'EPERM')
      expect(result.other).toBe('EPERM')
    }
  } finally { await new Promise<void>(resolve => foreign.close(() => resolve())); await f.close() }
}, 30_000)
