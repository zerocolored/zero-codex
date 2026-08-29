import { afterEach, describe, expect, test } from 'bun:test'
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
