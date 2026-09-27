import { afterEach, describe, expect, test, spyOn } from 'bun:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore, SlackChannelRouteRequiredError } from './job-runner.ts'
import {
  mutateProjectChannelConfig,
  projectChannelStatus,
  projectChannelConfigPath,
  readProjectChannelConfig,
  bindProjectSlackApp,
  switchProjectSlackApp,
} from './project-channel-config.ts'
import { resolveZeroJobDatabasePath } from './state-dir.ts'

const APP_ID = 'A0123456789'
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function fixture(): { root: string; state: string; projectA: string; projectB: string } {
  const root = mkdtempSync(join(tmpdir(), 'zerochan-project-routes-'))
  temporaryDirectories.push(root)
  const state = join(root, 'state')
  const projectA = join(root, 'project-a')
  const projectB = join(root, 'project-b')
  mkdirSync(state, { mode: 0o700 })
  for (const project of [projectA, projectB]) {
    mkdirSync(project)
    const result = Bun.spawnSync(['/usr/bin/git', 'init', '-q', project], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  }
  return {
    root,
    state: realpathSync(state),
    projectA: realpathSync(projectA),
    projectB: realpathSync(projectB),
  }
}

function gitStatus(project: string): string {
  return Bun.spawnSync(['/usr/bin/git', '-C', project, 'status', '--short'], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  }).stdout.toString()
}

describe('project-local Slack channel routes', () => {
  function switchFixture() {
    const f = fixture()
    mkdirSync(join(f.root, 'next'), { mode: 0o700 })
    const next = realpathSync(join(f.root, 'next'))
    const apps = [{ appId: APP_ID, stateDir: f.state }, { appId: 'ANEW', stateDir: next }]
    bindProjectSlackApp(f.projectA, APP_ID)
    mutateProjectChannelConfig({ operation: 'set', repoPath: f.projectA, stateDir: f.state, appId: APP_ID, channelId: 'CSWITCH' })
    mutateProjectChannelConfig({ operation: 'set', repoPath: f.projectB, stateDir: f.state, appId: APP_ID, channelId: 'COTHER' })
    return { ...f, next, apps }
  }
  test('explicit App switch preserves channels, other projects, and is idempotent', () => {
    const f = switchFixture()
    const history = new JobStore(join(f.state, 'jobs.sqlite3'))
    history.resolveOrAdoptSlackThreadRoute({ appId: APP_ID, chatId: 'CSWITCH', threadTs: '1800000000.000100', defaultRepoPath: f.projectA, adoptedFromTs: '1800000000.000100' })
    history.close()
    switchProjectSlackApp(f.projectA, 'ANEW', f.apps)
    switchProjectSlackApp(f.projectA, 'ANEW', f.apps)
    expect(readProjectChannelConfig(f.projectA)).toEqual({ version: 1, slackAppId: 'ANEW', slackChannels: ['CSWITCH'] })
    const old = new JobStore(join(f.state, 'jobs.sqlite3')), next = new JobStore(join(f.next, 'jobs.sqlite3'))
    expect(old.resolveSlackChannelRoute(APP_ID, 'CSWITCH')).toBeNull()
    expect(old.resolveSlackChannelRoute(APP_ID, 'COTHER')).toBe(f.projectB)
    expect(next.resolveSlackChannelRoute('ANEW', 'CSWITCH')).toBe(f.projectA)
    expect(old.resolveOrAdoptSlackThreadRoute({ appId: APP_ID, chatId: 'CSWITCH', threadTs: '1800000000.000100', defaultRepoPath: f.projectB, adoptedFromTs: '1800000000.000200' }).repoPath).toBe(f.projectA)
    old.close(); next.close()
    expect(existsSync(join(f.projectA, '.zerochan', 'slack-app-switch.json'))).toBe(false)
  })
  test('two processes selecting different Apps serialize without losing channels', async () => {
    const f = switchFixture()
    const children = [APP_ID, 'ANEW'].map(id => Bun.spawn([process.execPath, '-e',
      `import {switchProjectSlackApp} from ${JSON.stringify(import.meta.dir + '/project-channel-config.ts')}; switchProjectSlackApp(${JSON.stringify(f.projectA)},${JSON.stringify(id)},${JSON.stringify(f.apps)});`,
    ], { stdout: 'pipe', stderr: 'pipe' }))
    for (const child of children) expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
    const config = readProjectChannelConfig(f.projectA)
    expect(config.slackChannels).toEqual(['CSWITCH'])
    for (const app of f.apps) {
      const store = new JobStore(join(app.stateDir, 'jobs.sqlite3'))
      expect(store.resolveSlackChannelRoute(app.appId, 'CSWITCH')).toBe(config.slackAppId === app.appId ? f.projectA : null)
      store.close()
    }
  })
  test('process exit after destination commit leaves a recoverable durable journal', () => {
    const f = switchFixture()
    const script = `
      import {switchProjectSlackApp} from ${JSON.stringify(import.meta.dir + '/project-channel-config.ts')};
      import {JobStore} from ${JSON.stringify(import.meta.dir + '/job-runner.ts')};
      const original=JobStore.prototype.syncSlackChannelRoutes;
      JobStore.prototype.syncSlackChannelRoutes=function(input){const r=original.call(this,input);if(input.appId==='ANEW')process.exit(99);return r};
      switchProjectSlackApp(${JSON.stringify(f.projectA)},'ANEW',${JSON.stringify(f.apps)});
    `
    expect(Bun.spawnSync([process.execPath, '-e', script]).exitCode).toBe(99)
    expect(existsSync(join(f.projectA, '.zerochan', 'slack-app-switch.json'))).toBe(true)
    switchProjectSlackApp(f.projectA, 'ANEW', f.apps)
    expect(readProjectChannelConfig(f.projectA).slackAppId).toBe('ANEW')
    expect(existsSync(join(f.projectA, '.zerochan', 'slack-app-switch.json'))).toBe(false)
    const old = new JobStore(join(f.state, 'jobs.sqlite3')), next = new JobStore(join(f.next, 'jobs.sqlite3'))
    expect(old.resolveSlackChannelRoute(APP_ID, 'CSWITCH')).toBeNull()
    expect(next.resolveSlackChannelRoute('ANEW', 'CSWITCH')).toBe(f.projectA)
    old.close(); next.close()
  })
  test('switch with no channels needs no manual unset', () => {
    const f = switchFixture()
    mutateProjectChannelConfig({ operation: 'unset', repoPath: f.projectA, stateDir: f.state, appId: APP_ID })
    switchProjectSlackApp(f.projectA, 'ANEW', f.apps)
    expect(readProjectChannelConfig(f.projectA)).toEqual({ version: 1, slackAppId: 'ANEW', slackChannels: [] })
  })
  test('destination conflict changes neither configuration nor old routes', () => {
    const f = switchFixture()
    const next = new JobStore(join(f.next, 'jobs.sqlite3'))
    next.syncSlackChannelRoutes({ appId: 'ANEW', repoPath: f.projectB, channelIds: ['CSWITCH'] }); next.close()
    expect(() => switchProjectSlackApp(f.projectA, 'ANEW', f.apps)).toThrow('already connected')
    expect(readProjectChannelConfig(f.projectA).slackAppId).toBe(APP_ID)
    const old = new JobStore(join(f.state, 'jobs.sqlite3'))
    expect(old.resolveSlackChannelRoute(APP_ID, 'CSWITCH')).toBe(f.projectA); old.close()
  })
  test('synchronous failure restores both indexes and original binding', () => {
    const f = switchFixture()
    const baseline = new JobStore(join(f.state, 'jobs.sqlite3'))
    const beforeRoutes = baseline.listSlackChannelRoutes(APP_ID)
    baseline.close()
    const original = JobStore.prototype.syncSlackChannelRoutes
    let failed = false
    const spy = spyOn(JobStore.prototype, 'syncSlackChannelRoutes').mockImplementation(function(input) {
      if (input.appId === 'ANEW' && !failed) { failed = true; throw new Error('injected destination write failure') }
      return original.call(this, input)
    })
    try { expect(() => switchProjectSlackApp(f.projectA, 'ANEW', f.apps)).toThrow('injected') }
    finally { spy.mockRestore() }
    expect(readProjectChannelConfig(f.projectA).slackAppId).toBe(APP_ID)
    const old = new JobStore(join(f.state, 'jobs.sqlite3')), next = new JobStore(join(f.next, 'jobs.sqlite3'))
    expect(old.resolveSlackChannelRoute(APP_ID, 'CSWITCH')).toBe(f.projectA)
    expect(old.listSlackChannelRoutes(APP_ID)).toEqual(beforeRoutes)
    expect(next.resolveSlackChannelRoute('ANEW', 'CSWITCH')).toBeNull()
    old.close(); next.close()
    expect(existsSync(join(f.projectA, '.zerochan', 'slack-app-switch.json'))).toBe(false)
  })
  test('failure after destination insertion restores its previous implicit routing mode', () => {
    const f = switchFixture()
    const original = JobStore.prototype.syncSlackChannelRoutes
    let failed = false
    const spy = spyOn(JobStore.prototype, 'syncSlackChannelRoutes').mockImplementation(function(input) {
      const result = original.call(this, input)
      if (input.appId === 'ANEW' && !failed) { failed = true; throw new Error('injected after commit') }
      return result
    })
    try { expect(() => switchProjectSlackApp(f.projectA, 'ANEW', f.apps)).toThrow('after commit') }
    finally { spy.mockRestore() }
    const next = new JobStore(join(f.next, 'jobs.sqlite3'))
    expect(next.slackChannelRoutingIsExplicit('ANEW')).toBe(false)
    expect(next.resolveOrAdoptSlackThreadRoute({ appId: 'ANEW', chatId: 'CLEGACY', threadTs: '1800000000.000100', defaultRepoPath: f.projectB, adoptedFromTs: '1800000000.000100' }).repoPath).toBe(f.projectB)
    next.close()
    expect(readProjectChannelConfig(f.projectA).slackAppId).toBe(APP_ID)
  })
  for (const direction of ['forward', 'rollback'] as const) {
    test(`interrupted ${direction} journal recovers before a new selection`, () => {
      const f = switchFixture()
      const before = readProjectChannelConfig(f.projectA)
      const old = new JobStore(join(f.state, 'jobs.sqlite3'))
      old.syncSlackChannelRoutes({ appId: APP_ID, repoPath: f.projectA, channelIds: [] }); old.close()
      writeFileSync(join(f.projectA, '.zerochan', 'slack-app-switch.json'), JSON.stringify({
        version: 1, direction, before, targetAppId: 'ANEW',
        routes: [{ ...f.apps[0], channels: ['CSWITCH'] }, { ...f.apps[1], channels: [] }],
      }), { mode: 0o600 })
      const extra = join(f.root, 'extra'); mkdirSync(extra, { mode: 0o700 })
      const apps = [...f.apps, { appId: 'AEXTRA', stateDir: realpathSync(extra) }]
      expect(() => mutateProjectChannelConfig({ operation: 'set', repoPath: f.projectA, appId: APP_ID, stateDir: f.state, channelId: 'CUNEXPECTED' })).toThrow('再実行')
      switchProjectSlackApp(f.projectA, 'ANEW', apps)
      expect(readProjectChannelConfig(f.projectA)).toEqual({ version: 1, slackAppId: 'ANEW', slackChannels: ['CSWITCH'] })
      const next = new JobStore(join(f.next, 'jobs.sqlite3'))
      expect(next.resolveSlackChannelRoute('ANEW', 'CSWITCH')).toBe(f.projectA); next.close()
      expect(existsSync(join(f.projectA, '.zerochan', 'slack-app-switch.json'))).toBe(false)
    })
  }
  test('App binding survives channel writes and rejects accidental cross-App routes', () => {
    const { state, projectA } = fixture()
    bindProjectSlackApp(projectA, APP_ID)
    mutateProjectChannelConfig({ operation: 'set', repoPath: projectA, stateDir: state, appId: APP_ID, channelId: 'C123456' })
    expect(readProjectChannelConfig(projectA).slackAppId).toBe(APP_ID)
    expect(() => mutateProjectChannelConfig({ operation: 'sync', repoPath: projectA, stateDir: state, appId: 'AOTHER' })).toThrow('一致しません')
    expect(() => bindProjectSlackApp(projectA, 'AOTHER')).toThrow('別のSlackアプリ')
    mutateProjectChannelConfig({ operation: 'unset', repoPath: projectA, stateDir: state, appId: APP_ID })
    expect(readProjectChannelConfig(projectA)).toEqual({ version: 1, slackChannels: [], slackAppId: APP_ID })
  })
  test('channel名・DM ID・不正IDをproject設定として受け付けない', () => {
    const { state, projectA } = fixture()
    for (const channelId of ['#general', 'D0123456789', 'U0123456789']) {
      expect(() => mutateProjectChannelConfig({
        operation: 'set', repoPath: projectA, stateDir: state, appId: APP_ID, channelId,
      })).toThrow('SlackチャンネルIDが不正')
    }
    expect(existsSync(join(projectA, '.zerochan'))).toBe(false)
  })

  test('setはproject-local configをsorted保存しGit worktreeをdirtyにしない', () => {
    const { state, projectA } = fixture()
    mutateProjectChannelConfig({
      operation: 'set', repoPath: projectA, stateDir: state, appId: APP_ID,
      channelId: 'cbbbbbbbbbb',
    })
    mutateProjectChannelConfig({
      operation: 'set', repoPath: projectA, stateDir: state, appId: APP_ID,
      channelId: 'CAAAAAAAAAA',
    })

    expect(readProjectChannelConfig(projectA)).toEqual({
      version: 1,
      slackChannels: ['CAAAAAAAAAA', 'CBBBBBBBBBB'],
    })
    expect(JSON.parse(readFileSync(projectChannelConfigPath(projectA), 'utf8')))
      .toEqual({ version: 1, slackChannels: ['CAAAAAAAAAA', 'CBBBBBBBBBB'] })
    expect(gitStatus(projectA)).toBe('')
  })

  test('unsetはchannel IDなしでprojectの紐付けをすべて解除する', () => {
    const { state, projectA } = fixture()
    for (const channelId of ['CBBBBBBBBBB', 'CAAAAAAAAAA']) {
      mutateProjectChannelConfig({
        operation: 'set', repoPath: projectA, stateDir: state, appId: APP_ID, channelId,
      })
    }

    const config = mutateProjectChannelConfig({
      operation: 'unset', repoPath: projectA, stateDir: state, appId: APP_ID,
    })

    expect(config.slackChannels).toEqual([])
    expect(readProjectChannelConfig(projectA).slackChannels).toEqual([])
    const store = new JobStore(resolveZeroJobDatabasePath(state))
    try {
      expect(store.resolveSlackChannelRoute(APP_ID, 'CAAAAAAAAAA')).toBeNull()
      expect(store.resolveSlackChannelRoute(APP_ID, 'CBBBBBBBBBB')).toBeNull()
    } finally {
      store.close()
    }
  })

  test('multi-repo workspaceは親のlocal設定へ保存し、子repositoryをdirtyにしない', () => {
    const { root, state } = fixture()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const members = ['backend', 'frontend', 'meeting-app'].map(name => {
      const repository = join(workspace, name)
      mkdirSync(repository)
      const result = Bun.spawnSync(['/usr/bin/git', 'init', '-q', repository], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      return repository
    })
    const config = mutateProjectChannelConfig({
      operation: 'set', repoPath: workspace, stateDir: state, appId: APP_ID,
      channelId: 'C0123456789',
    })
    expect(config.slackChannels).toEqual(['C0123456789'])
    expect(existsSync(join(workspace, '.zerochan', 'workspace.json'))).toBe(true)
    expect(readProjectChannelConfig(workspace).slackChannels).toEqual(['C0123456789'])
    for (const member of members) expect(gitStatus(member)).toBe('')
    const status = projectChannelStatus({ repoPath: workspace, stateDir: state, appId: APP_ID })
    expect(status).toContain('repositories: backend, frontend, meeting-app')
  })

  test('同じchannelの別project claimとforeign unsetを拒否する', () => {
    const { state, projectA, projectB } = fixture()
    mutateProjectChannelConfig({
      operation: 'set', repoPath: projectA, stateDir: state, appId: APP_ID,
      channelId: 'C0123456789',
    })
    expect(() => mutateProjectChannelConfig({
      operation: 'set', repoPath: projectB, stateDir: state, appId: APP_ID,
      channelId: 'C0123456789',
    })).toThrow('already connected')
    expect(() => mutateProjectChannelConfig({
      operation: 'unset', repoPath: projectB, stateDir: state, appId: APP_ID,
      channelId: 'C0123456789',
    })).toThrow('belongs to another project')

    const store = new JobStore(resolveZeroJobDatabasePath(state))
    try {
      expect(store.resolveSlackChannelRoute(APP_ID, 'C0123456789')).toBe(projectA)
    } finally {
      store.close()
    }
    expect(readProjectChannelConfig(projectB).slackChannels).toEqual([])
  })

  test('既存threadはunsetと別project再登録後も最初のprojectへ固定する', () => {
    const { state, projectA, projectB } = fixture()
    mutateProjectChannelConfig({
      operation: 'set', repoPath: projectA, stateDir: state, appId: APP_ID,
      channelId: 'C0123456789',
    })
    const store = new JobStore(resolveZeroJobDatabasePath(state))
    try {
      expect(store.resolveOrAdoptSlackThreadRoute({
        appId: APP_ID,
        chatId: 'C0123456789',
        threadTs: '1800000000.000100',
        defaultRepoPath: projectB,
        adoptedFromTs: '1800000000.000100',
      }).repoPath).toBe(projectA)
    } finally {
      store.close()
    }

    mutateProjectChannelConfig({
      operation: 'unset', repoPath: projectA, stateDir: state, appId: APP_ID,
      channelId: 'C0123456789',
    })
    mutateProjectChannelConfig({
      operation: 'set', repoPath: projectB, stateDir: state, appId: APP_ID,
      channelId: 'C0123456789',
    })

    const reopened = new JobStore(resolveZeroJobDatabasePath(state))
    try {
      expect(reopened.resolveOrAdoptSlackThreadRoute({
        appId: APP_ID,
        chatId: 'C0123456789',
        threadTs: '1800000000.000100',
        defaultRepoPath: projectB,
        adoptedFromTs: '1800000000.000200',
      }).repoPath).toBe(projectA)
      expect(reopened.resolveOrAdoptSlackThreadRoute({
        appId: APP_ID,
        chatId: 'C0123456789',
        threadTs: '1800000000.000300',
        defaultRepoPath: projectA,
        adoptedFromTs: '1800000000.000300',
      }).repoPath).toBe(projectB)
    } finally {
      reopened.close()
    }
  })

  test('routeが0件なら従来fallback、1件以上なら未設定channelだけfail-closed、DMはdefault', () => {
    const { state, projectA, projectB } = fixture()
    const store = new JobStore(resolveZeroJobDatabasePath(state))
    try {
      expect(store.resolveOrAdoptSlackThreadRoute({
        appId: APP_ID,
        chatId: 'C0000000001',
        threadTs: '1800000001.000100',
        defaultRepoPath: projectA,
        adoptedFromTs: '1800000001.000100',
      }).repoPath).toBe(projectA)
      store.syncSlackChannelRoutes({
        appId: APP_ID, repoPath: projectB, channelIds: ['C0000000002'],
      })
      expect(() => store.resolveOrAdoptSlackThreadRoute({
        appId: APP_ID,
        chatId: 'C0000000003',
        threadTs: '1800000001.000200',
        defaultRepoPath: projectA,
        adoptedFromTs: '1800000001.000200',
      })).toThrow(SlackChannelRouteRequiredError)
      expect(store.resolveOrAdoptSlackThreadRoute({
        appId: APP_ID,
        chatId: 'D0000000001',
        threadTs: '1800000001.000300',
        defaultRepoPath: projectA,
        adoptedFromTs: '1800000001.000300',
      }).repoPath).toBe(projectA)
      store.syncSlackChannelRoutes({ appId: APP_ID, repoPath: projectB, channelIds: [] })
      expect(store.slackChannelRoutingIsExplicit(APP_ID)).toBe(true)
      expect(() => store.resolveOrAdoptSlackThreadRoute({
        appId: APP_ID,
        chatId: 'C0000000004',
        threadTs: '1800000001.000400',
        defaultRepoPath: projectA,
        adoptedFromTs: '1800000001.000400',
      })).toThrow(SlackChannelRouteRequiredError)
    } finally {
      store.close()
    }
  })

  test('2 processの同時setはexact 1 projectだけがchannelを取得する', async () => {
    const { state, projectA, projectB } = fixture()
    const script = join(import.meta.dir, 'project-channel-config.ts')
    const children = [projectA, projectB].map(project => Bun.spawn([
      process.execPath, '--config=/dev/null', '--no-env-file', script,
      'set', project, state, APP_ID, 'C0999999999',
    ], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }))
    const results = await Promise.all(children.map(async child => ({
      exitCode: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })))
    expect(results.map(result => result.exitCode).sort()).toEqual([0, 1])
    const winner = results[0]!.exitCode === 0 ? projectA : projectB
    const store = new JobStore(resolveZeroJobDatabasePath(state))
    try {
      expect(store.resolveSlackChannelRoute(APP_ID, 'C0999999999')).toBe(winner)
    } finally {
      store.close()
    }
  })

  test('symlink .zerochanとhardlink configを拒否する', () => {
    const { root, state, projectA } = fixture()
    const external = join(root, 'external')
    mkdirSync(external)
    symlinkSync(external, join(projectA, '.zerochan'))
    expect(() => mutateProjectChannelConfig({
      operation: 'set', repoPath: projectA, stateDir: state, appId: APP_ID,
      channelId: 'C0123456789',
    })).toThrow('安全でない.zerochan')
    rmSync(join(projectA, '.zerochan'))

    mkdirSync(join(projectA, '.zerochan'), { mode: 0o700 })
    writeFileSync(join(projectA, '.zerochan', '.gitignore'), '*\n', { mode: 0o600 })
    const linked = join(root, 'linked-config')
    writeFileSync(linked, '{"version":1,"slackChannels":[]}\n', { mode: 0o600 })
    linkSync(linked, projectChannelConfigPath(projectA))
    chmodSync(linked, 0o600)
    expect(() => mutateProjectChannelConfig({
      operation: 'set', repoPath: projectA, stateDir: state, appId: APP_ID,
      channelId: 'C0123456789',
    })).toThrow('unsafe managed file')
  })

  test('crash journalを冪等回復し、空syncではlocal configを作らない', () => {
    const { state, projectA } = fixture()
    writeFileSync(join(state, 'channel-route-transaction.json'), JSON.stringify({
      version: 1,
      operation: 'sync',
      appId: APP_ID,
      repoPath: projectA,
      beforeChannels: [],
      afterChannels: [],
      createdAt: Date.now(),
    }), { mode: 0o600 })
    expect(projectChannelStatus({ repoPath: projectA, stateDir: state, appId: APP_ID }))
      .toContain('Slackチャンネル: 未設定')
    expect(existsSync(join(state, 'channel-route-transaction.json'))).toBe(false)
    expect(existsSync(join(projectA, '.zerochan'))).toBe(false)
  })

  test('statusはlocalにないlive routeも隠さず表示する', () => {
    const { state, projectA } = fixture()
    mutateProjectChannelConfig({
      operation: 'set', repoPath: projectA, stateDir: state, appId: APP_ID,
      channelId: 'C0123456789',
    })
    writeFileSync(projectChannelConfigPath(projectA), JSON.stringify({
      version: 1, slackChannels: [],
    }), { mode: 0o600 })

    const status = projectChannelStatus({ repoPath: projectA, stateDir: state, appId: APP_ID })
    expect(status).toContain('Slackチャンネル: 未設定')
    expect(status).toContain('local設定にない稼働routing: C0123456789')
  })

  test('tracked .zerochanはjournal作成前に拒否し他projectをlockoutしない', () => {
    const { state, projectA, projectB } = fixture()
    mkdirSync(join(projectA, '.zerochan'), { mode: 0o700 })
    writeFileSync(projectChannelConfigPath(projectA), JSON.stringify({
      version: 1, slackChannels: [],
    }), { mode: 0o600 })
    const tracked = Bun.spawnSync([
      '/usr/bin/git', '-C', projectA, 'add', '-f', '.zerochan/config.json',
    ], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    expect(tracked.exitCode, tracked.stderr.toString()).toBe(0)

    expect(() => mutateProjectChannelConfig({
      operation: 'set', repoPath: projectA, stateDir: state, appId: APP_ID,
      channelId: 'C0111111111',
    })).toThrow('.zerochanはlocal専用')
    expect(existsSync(join(state, 'channel-route-transaction.json'))).toBe(false)

    expect(mutateProjectChannelConfig({
      operation: 'set', repoPath: projectB, stateDir: state, appId: APP_ID,
      channelId: 'C0222222222',
    }).slackChannels).toEqual(['C0222222222'])
  })
})
