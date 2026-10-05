import { expect, test } from 'bun:test'
import { existsSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { ensureJobTempDirectory, jobTempRoot } from './job-temp.ts'
import { ensureManagedDirectory, prepareManagedStateRoot } from './managed-path.ts'
import { artifactDirForJob, buildCodexChildEnvironment, buildCodexPermissionOverrides, resolveEffectiveCodexPermissionOverrides } from './codex-executor.ts'
import { extractArtifactPaths, sealArtifactResult } from './job-runner.ts'
import { ContinuedArtifactMessage } from './continued-artifact-message.ts'

function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/zc-ipc-test-'))
  const state = prepareManagedStateRoot(join(root, 'long-state-'.repeat(12)))
  const otherState = prepareManagedStateRoot(join(root, 'other-state'))
  const job = { id: 'job-'.repeat(30), repoPath: join(root, 'repo'), writeEnabled: true, attachments: [] } as any
  mkdirSync(job.repoPath)
  const scratch = ensureManagedDirectory(state, join(state, 'scratch'))
  const artifact = ensureManagedDirectory(state, join(state, 'out'))
  const temp = ensureJobTempDirectory(state, job.id)
  const sibling = ensureJobTempDirectory(otherState, job.id)
  return { root, state, otherState, job, scratch, artifact, temp, sibling,
    cleanup() { for (const path of [temp, sibling, root]) rmSync(path, { recursive: true, force: true }) } }
}

test('short physical job temp survives restart and separates app state without moving scratch', () => {
  const f = fixture()
  try {
    expect(Buffer.byteLength(join(f.temp, 'fune-infra-mutation-123456', 'control.sock'))).toBeLessThan(104)
    expect(Buffer.byteLength(join(f.temp, 'tsx-501', '123456.pipe'))).toBeLessThan(104)
    expect(f.temp).not.toBe(f.sibling)
    expect(realpathSync(f.temp)).toBe(f.temp)
    expect(lstatSync(f.temp).mode & 0o777).toBe(0o700)
    writeFileSync(join(f.temp, 'retained.txt'), 'keep across resume')
    expect(ensureJobTempDirectory(f.state, f.job.id)).toBe(f.temp)
    expect(readFileSync(join(f.temp, 'retained.txt'), 'utf8')).toBe('keep across resume')
    for (const executionWriteEnabled of [false, true]) {
      const config = Bun.TOML.parse(buildCodexPermissionOverrides(f.job, {
        stateDir: f.state, scratchDir: f.scratch, artifactDir: f.artifact, jobTempDir: f.temp,
        executionWriteEnabled, profile: 'ipc_test',
      }).join('\n')) as any
      expect(config.shell_environment_policy.set.HOME).toBe(executionWriteEnabled ? realpathSync(homedir()) : f.scratch)
      expect(config.shell_environment_policy.set.TMPDIR).toBe(f.temp)
      expect(config.permissions.ipc_test.filesystem[jobTempRoot()]).toBe(executionWriteEnabled ? 'read' : 'deny')
      expect(config.permissions.ipc_test.filesystem[f.temp]).toBe('write')
      expect(config.permissions.ipc_test.network.unix_sockets).toEqual(executionWriteEnabled ? { [f.temp]: 'allow' } : {})
      expect(config.permissions.ipc_test.network.enabled).toBe(executionWriteEnabled)
    }
  } finally { f.cleanup() }
})

test('unsafe replacement temp is rejected without following links or changing permissions', () => {
  const f = fixture()
  try {
    rmSync(f.temp, { recursive: true })
    symlinkSync(f.sibling, f.temp)
    expect(() => ensureJobTempDirectory(f.state, f.job.id)).toThrow('physically owned')
    rmSync(f.temp)
    mkdirSync(f.temp, { mode: 0o755 })
    chmodSync(f.temp, 0o755)
    expect(() => ensureJobTempDirectory(f.state, f.job.id)).toThrow('physically owned')
    expect(lstatSync(f.temp).mode & 0o777).toBe(0o755)
  } finally { f.cleanup() }
})

test('artifacts in new TMPDIR survive continuation and are sealed without accepting another job', () => {
  const f = fixture()
  try {
    const out = ensureManagedDirectory(f.state, artifactDirForJob(f.state, f.job.id))
    const file = join(f.temp, 'report.txt')
    writeFileSync(file, 'synthetic artifact')
    const message = `Result<zerokun_files>${JSON.stringify([file])}</zerokun_files>`
    const continued = new ContinuedArtifactMessage(out, [f.scratch, f.temp])
    continued.observe(message, 1)
    expect(continued.resolve('waiting', 1, 'blocked')).toBe(message)
    const sealed = extractArtifactPaths(sealArtifactResult(f.job, message, f.state)).files
    expect(sealed).toHaveLength(1)
    expect(readFileSync(sealed[0]!, 'utf8')).toBe('synthetic artifact')
    const foreign = join(f.sibling, 'report.txt')
    writeFileSync(foreign, 'foreign')
    expect(() => sealArtifactResult(f.job, `<zerokun_files>${JSON.stringify([foreign])}</zerokun_files>`, f.state)).toThrow('outside')
  } finally { f.cleanup() }
})

test('legacy permission building and outbox sealing neither allocate temp nor depend on unsafe temp', () => {
  const f = fixture()
  try {
    const out = ensureManagedDirectory(f.state, artifactDirForJob(f.state, f.job.id))
    const report = join(out, 'report.txt')
    writeFileSync(report, 'outbox survives OS temp removal')
    const message = `<zerokun_files>${JSON.stringify([report])}</zerokun_files>`
    rmSync(f.temp, { recursive: true })
    buildCodexPermissionOverrides(f.job, {
      stateDir: f.state, scratchDir: f.scratch, artifactDir: out,
    })
    expect(existsSync(f.temp)).toBe(false)
    expect(extractArtifactPaths(sealArtifactResult(f.job, message, f.state)).files).toHaveLength(1)
    expect(existsSync(f.temp)).toBe(false)
    symlinkSync(f.sibling, f.temp)
    expect(extractArtifactPaths(sealArtifactResult(f.job, message, f.state)).files).toHaveLength(1)
    expect(lstatSync(f.temp).isSymbolicLink()).toBe(true)
  } finally { f.cleanup() }
})

const codex = Bun.which('codex'), node = Bun.which('node')
test.skipIf(!codex)('real App Server preserves scoped Unix grants and the offline empty map without a model call', async () => {
  const f = fixture()
  try {
    for (const write of [false, true]) {
      const flags = buildCodexPermissionOverrides(f.job, {
        stateDir: f.state, scratchDir: f.scratch, artifactDir: f.artifact, jobTempDir: f.temp,
        executionWriteEnabled: write, profile: 'ipc_preflight',
      })
      await resolveEffectiveCodexPermissionOverrides(codex!, f.job.repoPath, flags, 'ipc_preflight', buildCodexChildEnvironment())
    }
  } finally { f.cleanup() }
}, 30_000)

test.skipIf(process.platform !== 'darwin' || !codex || !node)('real sandbox allows dynamic job IPC but restricts sibling writes/connects and retains read isolation outside primary', async () => {
  const f = fixture()
  const foreign = await import('node:net')
  const hostSocket = join(f.root, 'host.sock'), siblingSocket = join(f.sibling, 'other.sock')
  const ownSocket = join(f.temp, 'own.sock')
  const socketPaths = [hostSocket, siblingSocket, ownSocket]
  const servers = socketPaths.map(() => foreign.createServer(client => client.end('synthetic')))
  try {
    await Promise.all(servers.map((server, i) => new Promise<void>((resolve, reject) => {
      server.on('error', reject); server.listen(socketPaths[i]!, resolve)
    })))
    writeFileSync(join(f.sibling, 'private'), 'synthetic other job')
    symlinkSync(f.sibling, join(f.temp, 'alias'))
    symlinkSync(hostSocket, join(f.temp, 'host-alias.sock'))
    const script = join(f.scratch, 'ipc.cjs')
    writeFileSync(script, `
      const net=require('node:net'),fs=require('node:fs');
      const denied=action=>{try{action();return false}catch(e){return ['EPERM','EACCES'].includes(e.code)}};
      const connectDenied=path=>new Promise(resolve=>{const c=net.connect(path);c.on('error',e=>resolve(['EPERM','EACCES'].includes(e.code)));c.on('connect',()=>{c.destroy();resolve(false)})});
      (async()=>{
        const dir=fs.mkdtempSync(process.env.TMPDIR+'/fune-infra-mutation-'),path=dir+'/control.sock';
        if(process.env.PROBE_OFFLINE==='1') {
          const server=net.createServer();
          const bind=await new Promise(resolve=>{server.on('error',e=>resolve(['EPERM','EACCES'].includes(e.code)));server.listen(path,()=>server.close(()=>resolve(false)))});
          console.log(JSON.stringify({bind,connect:await connectDenied(${JSON.stringify(ownSocket)})}));return;
        }
        const server=net.createServer(s=>s.end('pong'));
        await new Promise((resolve,reject)=>{server.on('error',reject);server.listen(path,resolve)});
        const pong=await new Promise((resolve,reject)=>{const c=net.connect(path);c.on('data',b=>resolve(b.toString()));c.on('error',reject)});
        await new Promise(resolve=>server.close(resolve));
        const sibling=${JSON.stringify(f.sibling)};
        console.log(JSON.stringify({pong,
          read:denied(()=>fs.readFileSync(sibling+'/private')),
          write:denied(()=>fs.writeFileSync(sibling+'/new','no')),
          unlink:denied(()=>fs.unlinkSync(sibling+'/other.sock')),
          alias:denied(()=>fs.readFileSync(process.env.TMPDIR+'/alias/private')),
          aliasConnect:await connectDenied(process.env.TMPDIR+'/alias/other.sock'),
          hostAliasConnect:await connectDenied(process.env.TMPDIR+'/host-alias.sock'),
          sibling:await connectDenied(sibling+'/other.sock'),
          host:await connectDenied(${JSON.stringify(hostSocket)})}));
      })().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
    `)
    for (const mode of ['offline', 'local', 'write']) {
      const flags = buildCodexPermissionOverrides(f.job, {
        stateDir: f.state, scratchDir: f.scratch, artifactDir: f.artifact, jobTempDir: f.temp,
        executionWriteEnabled: mode === 'write', localVerificationEnabled: mode === 'local', profile: 'ipc_test',
      })
      const policy = (Bun.TOML.parse(flags.join('\n')) as any).shell_environment_policy.set
      const result = Bun.spawnSync([codex!, ...flags.flatMap(v => ['-c', v]),
        'sandbox', '-P', 'ipc_test', '-C', f.job.repoPath, '--',
        '/usr/bin/env', ...Object.entries(policy).map(([k, v]) => `${k}=${v}`), `PROBE_OFFLINE=${mode === 'offline' ? '1' : '0'}`, node!, script,
      ], { env: buildCodexChildEnvironment(), stdout: 'pipe', stderr: 'pipe', timeout: 15_000 })
      expect({ exit: result.exitCode, error: result.stderr.toString() }).toEqual({ exit: 0, error: '' })
      expect(JSON.parse(result.stdout.toString())).toEqual(mode === 'offline' ? { bind: true, connect: true }
        : { pong: 'pong', read: mode !== 'write', write: true, unlink: true, alias: mode !== 'write', aliasConnect: true, hostAliasConnect: true, sibling: true, host: true })
    }
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    f.cleanup()
  }
}, 40_000)
