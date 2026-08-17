import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { waitForStableHealth } from './update'

const tempDirs: string[] = []
const updater = join(import.meta.dir, 'update.ts')

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function command(args: string[], cwd?: string) {
  const result = Bun.spawnSync(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Zero Test',
      GIT_AUTHOR_EMAIL: 'zero@example.test',
      GIT_COMMITTER_NAME: 'Zero Test',
      GIT_COMMITTER_EMAIL: 'zero@example.test',
    },
  })
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

function must(args: string[], cwd?: string): string {
  const result = command(args, cwd)
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(' ')} failed:\n${result.stdout}${result.stderr}`)
  }
  return result.stdout.trim()
}

interface FixtureRepo {
  local: string
  seed: string
}

function makeRepo(base: string, name: string): FixtureRepo {
  const bare = join(base, `${name}.git`)
  const seed = join(base, `${name}-seed`)
  const local = join(base, name)
  mkdirSync(seed)
  must(['git', 'init', '--bare', '--initial-branch=main', bare])
  must(['git', 'init', '--initial-branch=main'], seed)
  writeFileSync(join(seed, 'version.txt'), 'v1\n')
  must(['git', 'add', 'version.txt'], seed)
  must(['git', 'commit', '-m', 'v1'], seed)
  must(['git', 'remote', 'add', 'origin', bare], seed)
  must(['git', 'push', '-u', 'origin', 'main'], seed)
  must(['git', 'clone', bare, local])
  return { local, seed }
}

function publish(repo: FixtureRepo, version: string) {
  writeFileSync(join(repo.seed, 'version.txt'), `${version}\n`)
  must(['git', 'add', 'version.txt'], repo.seed)
  must(['git', 'commit', '-m', version], repo.seed)
  must(['git', 'push', 'origin', 'main'], repo.seed)
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'zerokun-update-test-'))
  tempDirs.push(base)
  const zero = makeRepo(base, 'zero')
  const ownerDir = join(base, 'owner')
  mkdirSync(ownerDir)
  const config = makeRepo(base, 'claude-config-source')
  const skills = makeRepo(base, 'claude-skills-source')
  must(['git', 'clone', must(['git', '-C', config.local, 'remote', 'get-url', 'origin']), join(ownerDir, 'claude-config')])
  must(['git', 'clone', must(['git', '-C', skills.local, 'remote', 'get-url', 'origin']), join(ownerDir, 'claude-skills')])
  publish(zero, 'v2')
  publish(config, 'v2')
  publish(skills, 'v2')

  const stateDir = join(base, 'state')
  const projectDir = join(base, 'project')
  mkdirSync(stateDir)
  mkdirSync(projectDir)
  const setup = join(base, 'setup.sh')
  writeFileSync(setup, '#!/usr/bin/env bash\nset -eu\nprintf setup-ran > "$ZEROKUN_STATE_DIR/setup.marker"\n')
  chmodSync(setup, 0o755)

  return { base, zero, ownerDir, stateDir, projectDir, setup }
}

function runUpdater(f: ReturnType<typeof fixture>) {
  return Bun.spawnSync([process.execPath, updater, '--skip-tests', '--no-restart'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ZEROKUN_UPDATE_TESTING: '1',
      ZEROKUN_REPO_DIR: f.zero.local,
      ZEROKUN_OWNER_DIR: f.ownerDir,
      ZEROKUN_STATE_DIR: f.stateDir,
      ZEROKUN_PROJECT_DIR: f.projectDir,
      ZEROKUN_SETUP_SCRIPT: f.setup,
    },
  })
}

describe('zerokun-update', () => {
  test('一瞬だけ起動したprocessを成功扱いせず、3回連続healthyまで待つ', async () => {
    const observations = [true, false, true, true, true]
    let checks = 0

    await waitForStableHealth({
      observe: () => observations[checks++] ?? false,
      requiredConsecutive: 3,
      maxChecks: 6,
      sleep: async () => {},
    })

    expect(checks).toBe(5)
  })

  test('bot・bridge・runnerが安定しなければ再起動失敗にする', async () => {
    await expect(waitForStableHealth({
      observe: () => false,
      requiredConsecutive: 2,
      maxChecks: 3,
      sleep: async () => {},
    })).rejects.toThrow('安定稼働を確認できません')
  })

  test('3リポを事前検査してからmainへfast-forwardしsetupを実行する', () => {
    const f = fixture()
    must(['git', 'switch', '-c', 'merged-feature'], f.zero.local)

    const result = runUpdater(f)
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(f.zero.local, 'version.txt'), 'utf8')).toBe('v2\n')
    expect(readFileSync(join(f.ownerDir, 'claude-config/version.txt'), 'utf8')).toBe('v2\n')
    expect(readFileSync(join(f.ownerDir, 'claude-skills/version.txt'), 'utf8')).toBe('v2\n')
    expect(must(['git', 'branch', '--show-current'], f.zero.local)).toBe('main')
    expect(readFileSync(join(f.stateDir, 'setup.marker'), 'utf8')).toBe('setup-ran')
  })

  test('1リポでもdirtyなら全リポを更新せず停止する', () => {
    const f = fixture()
    writeFileSync(join(f.ownerDir, 'claude-config/local.txt'), 'do not overwrite\n')
    const before = must(['git', 'rev-parse', 'HEAD'], f.zero.local)

    const result = runUpdater(f)
    expect(result.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(result.stderr)).toContain('未コミット変更')
    expect(must(['git', 'rev-parse', 'HEAD'], f.zero.local)).toBe(before)
    expect(() => readFileSync(join(f.stateDir, 'setup.marker'))).toThrow()
  })

  test('origin/mainに入っていない作業ブランチでは停止する', () => {
    const f = fixture()
    must(['git', 'switch', '-c', 'unmerged-work'], f.zero.local)
    writeFileSync(join(f.zero.local, 'local-work.txt'), 'work\n')
    must(['git', 'add', 'local-work.txt'], f.zero.local)
    must(['git', 'commit', '-m', 'local work'], f.zero.local)

    const result = runUpdater(f)
    expect(result.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(result.stderr)).toContain('origin/mainへ未反映')
    expect(must(['git', 'branch', '--show-current'], f.zero.local)).toBe('unmerged-work')
  })

  test('実行中jobがあれば更新前に停止する', () => {
    const f = fixture()
    const fakeRunner = join(f.stateDir, 'job-runner.ts')
    writeFileSync(
      fakeRunner,
      '#!/usr/bin/env bash\nprintf \'[{"status":"running"}]\\n\'\n',
    )
    chmodSync(fakeRunner, 0o755)

    const result = Bun.spawnSync(
      [process.execPath, updater, '--skip-tests', '--no-restart'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          ZEROKUN_UPDATE_TESTING: '1',
          ZEROKUN_REPO_DIR: f.zero.local,
          ZEROKUN_OWNER_DIR: f.ownerDir,
          ZEROKUN_STATE_DIR: f.stateDir,
          ZEROKUN_PROJECT_DIR: f.projectDir,
          ZEROKUN_SETUP_SCRIPT: f.setup,
          ZEROKUN_UPDATE_WAIT_SECONDS: '0',
        },
      },
    )
    expect(result.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(result.stderr)).toContain('実行中job')
    expect(() => readFileSync(join(f.stateDir, 'setup.marker'))).toThrow()
  })
})
