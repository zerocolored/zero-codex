import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { buildCodexChildEnvironment, buildCodexDeveloperInstructions, buildCodexPermissionOverrides } from './codex-executor.ts'
import { prepareManagedStateRoot, ensureManagedDirectory } from './managed-path.ts'
import type { JobRecord } from './job-runner.ts'
import { registerSlackApp } from './slack-app-registry.ts'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-primary-permissions-')))
  const repo = join(root, 'repo'); mkdirSync(repo)
  const state = prepareManagedStateRoot(join(root, 'state'))
  const scratch = ensureManagedDirectory(state, join(state, 'scratch'))
  const out = ensureManagedDirectory(state, join(state, 'out'))
  const job = { id: 'primary-permissions', repoPath: repo, writeEnabled: true, attachments: [] } as unknown as JobRecord
  const overrides = (write: boolean) => buildCodexPermissionOverrides(job, {
    stateDir: state, scratchDir: scratch, artifactDir: out,
    executionWriteEnabled: write, profile: 'zero_primary_regression',
  })
  return { root, repo, state, scratch, out, job, overrides }
}

test('primary uses ordinary host reads without granting arbitrary host writes; review stays isolated', () => {
  const f = fixture()
  try {
    const parse = (write: boolean) => Bun.TOML.parse(f.overrides(write).join('\n')) as any
    const primary = parse(true).permissions.zero_primary_regression.filesystem
    const review = parse(false).permissions.zero_primary_regression.filesystem
    expect(primary[':root']).toBe('read')
    expect(primary[':minimal']).toBe('read')
    expect(primary[realpathSync(homedir())]).toBeUndefined()
    expect(primary[f.repo]).toBe('write')
    expect(primary[f.state]).toBe('deny')
    expect(primary[realpathSync(process.env.CODEX_HOME || join(homedir(), '.codex'))]).toBe('deny')
    expect(primary[realpathSync(tmpdir())]).toBe('write')
    expect(primary['/private/tmp']).toBe('write')
    expect(review[':minimal']).toBe('read')
    expect(review[':root']).toBeUndefined()
    expect(review[realpathSync(homedir())]).toBe('deny')
    expect(review[f.repo]).toBe('read')
    expect(review[f.state]).toBe('deny')
    expect(review[realpathSync(tmpdir())]).toBe('deny')
  } finally { rmSync(f.root, {recursive:true,force:true}) }
})

test('primary delegates networking to Codex while read-only isolation and host credentials stay protected', () => {
  const f = fixture()
  try {
    const parse = (job = f.job, write = true, browser = true) => (Bun.TOML.parse(buildCodexPermissionOverrides(job, {
      stateDir:f.state,scratchDir:f.scratch,artifactDir:f.out,profile:'zero_integration',
      executionWriteEnabled:write,browserAccessEnabled:browser,
    }).join('\n')) as any).permissions.zero_integration
    expect(parse().network.domains).toEqual({'*': 'allow'})
    expect(parse().filesystem[f.state]).toBe('deny')
    expect(parse().filesystem[join(realpathSync(homedir()),'.claude/channels/slack')]).toBe('deny')
    expect(parse(f.job,false).network.domains['slack.com']).toBe('deny')
    expect(parse({...f.job,writeEnabled:false},false).network.domains['slack.com']).toBe('deny')
    expect(parse({...f.job,writeEnabled:false},false,false).network.enabled).toBe(false)
    const env = buildCodexChildEnvironment({SLACK_BOT_TOKEN:'xoxb-fixture',SLACK_APP_TOKEN:'xapp-fixture',PATH:'/usr/bin'})
    expect(env.SLACK_BOT_TOKEN).toBeUndefined()
    expect(env.SLACK_APP_TOKEN).toBeUndefined()
  } finally {rmSync(f.root,{recursive:true,force:true})}
})

test('integration authorization distinguishes product tests, host delivery and missing evidence', () => {
  const f = fixture()
  try {
    expect(Bun.spawnSync(['git','init','-q',f.repo]).exitCode).toBe(0)
    const write = buildCodexDeveloperInstructions(f.job,f.out)
    const read = buildCodexDeveloperInstructions({...f.job,writeEnabled:false},f.out)
    for (const instructions of [write,read]) {
      expect(instructions).toContain('Never deliver this assistant\'s replies, progress, or completion notifications')
      expect(instructions).toContain('Never obtain or reuse the host assistant\'s Slack credentials')
      expect(instructions).not.toContain('Never post to Slack yourself')
    }
    expect(write).toContain('approvals already received for that same scope')
    expect(write).toContain('do not add a separate Zero upload, deployment, credential-use, or external-service approval gate')
    expect(write).toContain('inspect the destination and previous effects before retrying a write')
    expect(write).toContain('Codex native Auto-review handles eligible permission requests')
    expect(write).toContain('not a pending user dialog')
    expect(write).toContain('Other native MCP elicitation requests are answered with action=cancel')
    expect(write).toContain('exact reply containing the host-issued confirmation code')
    expect(write).toContain('does not mean the user declined, and does not approve the operation')
    expect(write).toContain('a generic Slack reply can answer an unsupported native confirmation')
    expect(write).not.toContain('Do not construct direct Slack API')
    expect(write).not.toContain('Existing Slack network restrictions')
    expect(write).toContain('An empty audit registry proves only that no evidence is registered there')
    expect(write).toContain('do not prescribe a different environment without an observed requirement')
    expect(write).toContain('A blocked integration check does not block independent authorized implementation')
    expect(write).toContain('This replaces the old generated Managed continuation workspace instruction')
    expect(read).not.toContain('do not add a separate Zero upload')
    expect(read).not.toContain('create a new task branch')
    expect(read).toContain('Do not edit files, Git, settings, external services, or data')
  } finally {rmSync(f.root,{recursive:true,force:true})}
})

test('a custom CODEX_HOME does not expose the default Codex private directory', () => {
  const f = fixture()
  const previous = process.env.CODEX_HOME
  const custom = join(f.root, 'custom-codex'); mkdirSync(custom)
  try {
    process.env.CODEX_HOME = custom
    const fs = (Bun.TOML.parse(f.overrides(true).join('\n')) as any).permissions.zero_primary_regression.filesystem
    expect(fs[custom]).toBe('deny')
    const standard = join(homedir(), '.codex')
    if (existsSync(standard)) expect(fs[realpathSync(standard)]).toBe('deny')
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    rmSync(f.root, {recursive:true,force:true})
  }
})

test('custom Slack states stay private and TMPDIR cannot grant arbitrary host writes', () => {
  const f = fixture()
  const fakeHome = join(f.root, 'home'); mkdirSync(fakeHome)
  const otherState = prepareManagedStateRoot(join(f.root, 'other-state'))
  const ordinaryBin = join(fakeHome, 'ordinary-bin'); mkdirSync(ordinaryBin)
  const privateCodex = join(f.root, 'private-codex'); mkdirSync(privateCodex)
  const codexAlias = join(fakeHome, 'codex-alias'); symlinkSync(privateCodex, codexAlias)
  try {
    registerSlackApp('ATESTPRIVATE', otherState, fakeHome)
    const staleState = prepareManagedStateRoot(join(f.root, 'deleted-state'))
    registerSlackApp('ASTALE', staleState, fakeHome)
    rmSync(staleState, {recursive:true})
    const macUserRoot = dirname(realpathSync(tmpdir()))
    for (const temp of [fakeHome, otherState, f.state, join(fakeHome, '.codex'), privateCodex, macUserRoot, join(macUserRoot, 'C')]) {
      const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', `
        import {buildCodexPermissionOverrides} from ${JSON.stringify(join(import.meta.dir, 'codex-executor.ts'))};
        const flags=buildCodexPermissionOverrides(${JSON.stringify({id:'private-state-probe', repoPath:f.repo, writeEnabled:true, attachments:[]})},${JSON.stringify({stateDir:f.state,scratchDir:f.scratch,artifactDir:f.out,executionWriteEnabled:true,profile:'zero_primary_regression'})});
        console.log(JSON.stringify(Bun.TOML.parse(flags.join('\\n'))));
      `], {env:{...process.env,HOME:fakeHome,TMPDIR:temp,CODEX_HOME:codexAlias,PATH:`${otherState}/bin:${privateCodex}/bin:${ordinaryBin}:relative::/usr/bin:/bin`},stdout:'pipe',stderr:'pipe'})
      expect(child.exitCode).toBe(0)
      const parsed = JSON.parse(child.stdout.toString())
      const fs = parsed.permissions.zero_primary_regression.filesystem
      expect(fs[otherState]).toBe('deny')
      expect(fs[staleState]).toBe('deny')
      if (existsSync(temp)) expect(fs[realpathSync(temp)]).not.toBe('write')
      expect(fs[privateCodex]).toBe('deny')
      expect(fs[codexAlias]).toBe('deny')
      expect(fs[join(fakeHome, '.codex')]).toBe('deny')
      expect(fs[join(fakeHome, '.claude/channels/slack')]).toBe('deny')
      expect(fs[join(fakeHome, '.zerochan-workspaces')]).toBe('deny')
      expect(fs[f.state]).toBe('deny')
      expect(fs[fakeHome]).not.toBe('write')
      expect(parsed.shell_environment_policy.set.PATH).toBe(`${ordinaryBin}:/usr/bin:/bin`)
    }
  } finally {
    rmSync(f.root, {recursive:true,force:true})
  }
})

test('private PATH and cloud prefixes are removed while core commands remain available', () => {
  const f = fixture()
  try {
    const flags = buildCodexPermissionOverrides(f.job, {
      stateDir:f.state,scratchDir:f.scratch,artifactDir:f.out,
      executionWriteEnabled:true,toolchainPath:`${f.state}/bin:relative:`,
      nativeCloudAccessEnabled:true,
      googleCloudRuntime:{bin:join(f.state,'bin'),config:null,readPaths:[]},
    })
    const policy = (Bun.TOML.parse(flags.join('\n')) as any).shell_environment_policy.set
    expect(policy.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
  } finally { rmSync(f.root, {recursive:true,force:true}) }
})

const codex = Bun.which('codex')
const node = Bun.which('node')
const macosRuntime = process.platform === 'darwin' && codex && node

test.skipIf(!macosRuntime)('real Codex sandbox transfers synthetic upload bytes while read-only networking stays denied', async () => {
  const f = fixture()
  const received: string[] = []
  const server = Bun.listen({
    hostname: '127.0.0.1', port: 0,
    socket: {
      data(socket, data) { received.push(data.toString()); socket.end('accepted') },
    },
  })
  try {
    const script = join(f.scratch, 'upload.cjs')
    writeFileSync(script, `
      const net = require('node:net');
      const socket = net.connect(${server.port}, '127.0.0.1');
      socket.setTimeout(3000, () => { socket.destroy(); process.exit(2); });
      socket.on('error', () => process.exit(3));
      socket.on('connect', () => socket.write('synthetic-upload'));
      let reply = '';
      socket.on('data', data => { reply += data; });
      socket.on('end', () => process.exit(reply === 'accepted' ? 0 : 4));
    `)
    for (const write of [false, true]) {
      const flags = buildCodexPermissionOverrides(f.job, {
        stateDir: f.state, scratchDir: f.scratch, artifactDir: f.out,
        profile: 'zero_upload_probe', executionWriteEnabled: write,
        browserAccessEnabled: false, multiAgentEnabled: false,
      })
      const child = Bun.spawn([
        codex!, ...flags.flatMap(v => ['-c', v]), 'sandbox',
        '-P', 'zero_upload_probe', '-C', f.repo, '--', node!, script,
      ], { env: buildCodexChildEnvironment(), stdout: 'pipe', stderr: 'pipe', timeout: 8_000 })
      const [exitCode] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(exitCode).toBe(write ? 0 : 3)
      expect(received.join('')).toBe(write ? 'synthetic-upload' : '')
    }
  } finally {
    server.stop(true)
    rmSync(f.root, { recursive: true, force: true })
  }
}, 20_000)

test.skipIf(!macosRuntime)('real Codex sandbox permits Node PATH lookup after a login shell and protects host state', () => {
  const f = fixture()
  const homeFixture = realpathSync(mkdtempSync(join(homedir(), '.zero-primary-test-')))
  try {
    const init = Bun.spawnSync(['/usr/bin/git', 'init', '-q', f.repo])
    expect(init.exitCode).toBe(0)
    writeFileSync(join(f.repo, 'tracked.txt'), 'synthetic')
    expect(Bun.spawnSync(['/usr/bin/git', '-C', f.repo, 'add', 'tracked.txt']).exitCode).toBe(0)
    writeFileSync(join(f.state, 'private-sentinel'), 'synthetic-private')
    writeFileSync(join(homeFixture, 'readable'), 'synthetic-home')
    // An ungranted PATH component reproduces libuv's EPERM before it gets to
    // the real git. No binary or real credential is read from this directory.
    const lookup = join(homeFixture, 'toolchain'); mkdirSync(lookup)
    // Node resolves every parent of its entrypoint. Keep minimal-runtime
    // traversal even for scratch nested beneath a private, denied state root.
    const script = join(f.scratch, 'probe.cjs')
    writeFileSync(script, `
      const {execFileSync}=require('node:child_process');
      const fs=require('node:fs');
      process.env.PATH=${JSON.stringify(lookup)}+':'+process.env.PATH;
      const tracked=execFileSync('git',['ls-files'],{encoding:'utf8'}).trim();
      let stateDenied=false, unrelatedWriteDenied=false;
      try { fs.readFileSync(${JSON.stringify(join(f.state, 'private-sentinel'))}); } catch(e) {stateDenied=['EPERM','EACCES'].includes(e.code);}
      try { fs.writeFileSync(${JSON.stringify(join(homeFixture, 'must-not-write'))},'no'); } catch(e) {unrelatedWriteDenied=['EPERM','EACCES'].includes(e.code);}
      console.log(JSON.stringify({tracked,stateDenied,unrelatedWriteDenied,homeRead:fs.readFileSync(${JSON.stringify(join(homeFixture, 'readable'))},'utf8')}));
    `)
    const flags = f.overrides(true)
    const policy = (Bun.TOML.parse(flags.join('\n')) as any).shell_environment_policy.set
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
    const result = Bun.spawnSync([
      codex!, ...flags.flatMap(v => ['-c', v]), 'sandbox', '-P', 'zero_primary_regression', '-C', f.repo, '--',
      '/usr/bin/env', ...Object.entries(policy).map(([k,v]) => `${k}=${v}`),
      '/bin/zsh', '-lc', `${quote(node!)} ${quote(script)}`,
    ], {cwd:f.repo,env:buildCodexChildEnvironment(),stdout:'pipe',stderr:'pipe',timeout:30_000})
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).not.toContain('Operation not permitted')
    expect(JSON.parse(result.stdout.toString().trim())).toEqual({tracked:'tracked.txt',stateDenied:true,unrelatedWriteDenied:true,homeRead:'synthetic-home'})
  } finally {
    rmSync(homeFixture, {recursive:true,force:true})
    rmSync(f.root, {recursive:true,force:true})
  }
}, 40_000)

test('primary network delegation does not enable networking or approvals for read-only stages', () => {
  const f = fixture()
  try {
    for (const writeAuthorized of [true, false]) {
      for (const executionWriteEnabled of [true, false]) {
        const config = Bun.TOML.parse(buildCodexPermissionOverrides(
          {...f.job, writeEnabled: writeAuthorized}, {
            stateDir: f.state, scratchDir: f.scratch, artifactDir: f.out,
            profile: 'zero_network_delegation', executionWriteEnabled,
            browserAccessEnabled: false,
          },
        ).join('\n')) as any
        const primary = writeAuthorized && executionWriteEnabled
        expect(config.features.network_proxy).toBe(executionWriteEnabled)
        expect(config.approval_policy).toBe(primary ? 'on-request' : 'never')
        expect(config.approvals_reviewer).toBe(primary ? 'auto_review' : undefined)
        expect(config.permissions.zero_network_delegation.network.enabled).toBe(executionWriteEnabled)
      }
    }
  } finally { rmSync(f.root, {recursive:true, force:true}) }
})
