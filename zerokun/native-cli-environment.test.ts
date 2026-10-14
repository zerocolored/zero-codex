import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { nativeCliShellEnvironment } from './native-cli-environment.ts'
import { buildCodexChildEnvironment, buildCodexPermissionOverrides } from './codex-executor.ts'
import { ensureManagedDirectory, prepareManagedStateRoot } from './managed-path.ts'

test('native configuration discovery works for an unknown CLI without copying its credentials', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-cli-env-')))
  try {
    const home = join(root, 'home'), scratch = join(root, 'scratch'), config = join(root, 'custom-config')
    for (const dir of [home, scratch, config]) mkdirSync(dir)
    writeFileSync(join(home, '.unlisted-cli'), 'home-fixture')
    writeFileSync(join(config, 'unlisted-cli'), 'xdg-fixture')
    const source = { XDG_CONFIG_HOME: config, SLACK_BOT_TOKEN: 'must-not-inherit', UNKNOWN_SECRET: 'must-not-inherit' }
    const primary = nativeCliShellEnvironment(home, scratch, true, source)
    const run = (env: Record<string, string>) => Bun.spawnSync(['/bin/sh', '-c',
      'set -eu; cat "$HOME/.unlisted-cli"; cat "$XDG_CONFIG_HOME/unlisted-cli"'], { env, stdout: 'pipe', stderr: 'pipe' })
    const found = run(primary)
    expect(found.exitCode).toBe(0)
    expect(found.stdout.toString()).toBe('home-fixturexdg-fixture')
    expect(primary.SLACK_BOT_TOKEN).toBeUndefined()
    expect(primary.UNKNOWN_SECRET).toBeUndefined()
    expect(run(nativeCliShellEnvironment(home, scratch, false, source)).exitCode).not.toBe(0)
    expect(nativeCliShellEnvironment(home, scratch, true, {})).toEqual({ HOME: home })
    expect(readFileSync(join(home, '.unlisted-cli'), 'utf8')).toBe('home-fixture')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('generated primary settings retain native paths while read-only stages remain isolated and primary escalation is possible', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-cli-profile-')))
  const previous = process.env.XDG_CONFIG_HOME
  try {
    const repo = join(root, 'repo'); mkdirSync(repo)
    const config = join(root, 'config'); mkdirSync(config)
    process.env.XDG_CONFIG_HOME = config
    const state = prepareManagedStateRoot(join(root, 'state'))
    const scratch = ensureManagedDirectory(state, join(state, 'scratch'))
    const out = ensureManagedDirectory(state, join(state, 'out'))
    for (const primary of [true, false]) {
      const settings = Bun.TOML.parse(buildCodexPermissionOverrides({ id: 'native-cli', repoPath: repo,
        writeEnabled: true, attachments: [] } as any, { stateDir: state, scratchDir: scratch,
        artifactDir: out, executionWriteEnabled: primary, profile: 'native_cli' }).join('\n')) as any
      expect(settings.shell_environment_policy.set.HOME).toBe(primary ? realpathSync(homedir()) : scratch)
      expect(settings.shell_environment_policy.set.XDG_CONFIG_HOME).toBe(primary ? config : join(scratch, '.config'))
      expect(settings.permissions.native_cli.filesystem[state]).toBe(primary ? 'read' : 'deny')
      expect(settings.permissions.native_cli.filesystem[realpathSync(homedir())]).toBe(primary ? undefined : 'deny')
      expect(settings.approval_policy).toBe(primary ? 'on-request' : 'never')
      expect(settings.approvals_reviewer).toBe(primary ? 'auto_review' : undefined)
      expect(settings.features.exec_permission_approvals).toBe(primary)
    }
    const child = buildCodexChildEnvironment({ HOME: homedir(), XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: '/synthetic/state', SLACK_BOT_TOKEN: 'do-not-copy', SUPABASE_ACCESS_TOKEN: 'do-not-copy' })
    expect(child.XDG_CONFIG_HOME).toBe(config)
    expect(child.XDG_STATE_HOME).toBe('/synthetic/state')
    expect(child.SLACK_BOT_TOKEN).toBeUndefined()
    expect(child.SUPABASE_ACCESS_TOKEN).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})


test.skipIf(process.platform !== 'darwin' || !Bun.which('codex'))('primary base sandbox denies project Slack routing writes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-routing-profile-')))
  try {
    const repo = join(root, 'repo'); mkdirSync(repo)
    const routing = join(repo, '.zerochan'); mkdirSync(routing)
    const state = prepareManagedStateRoot(join(root, 'state'))
    const scratch = ensureManagedDirectory(state, join(state, 'scratch'))
    const out = ensureManagedDirectory(state, join(state, 'out'))
    const flags = buildCodexPermissionOverrides({ id: 'native-routing', repoPath: repo,
      writeEnabled: true, attachments: [] } as any, { stateDir: state, scratchDir: scratch,
      artifactDir: out, executionWriteEnabled: true, multiAgentEnabled: false, profile: 'native_routing' })
    const probe = Bun.spawnSync([Bun.which('codex')!, ...flags.flatMap(value => ['-c', value]),
      'sandbox', '-P', 'native_routing', '-C', repo, '--', '/bin/sh', '-c',
      'touch ./allowed && touch ./.zerochan/forged'], {
      cwd: repo, env: buildCodexChildEnvironment(), stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    })
    expect(existsSync(join(repo, 'allowed'))).toBe(true)
    expect(existsSync(join(routing, 'forged'))).toBe(false)
    expect(probe.exitCode).not.toBe(0)
    expect(probe.stderr.toString()).toContain('Operation not permitted')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
