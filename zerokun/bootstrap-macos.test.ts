import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = join(import.meta.dir, '..')
const bootstrap = join(import.meta.dir, 'bootstrap-macos.sh')

describe('macOS bootstrap', () => {
  test('--help is read-only and documents the one-script setup', () => {
    const result = Bun.spawnSync([bootstrap, '--help'], { stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('bootstrap-macos.sh')
    expect(result.stdout.toString()).toContain('--doctor')
    expect(result.stdout.toString()).toContain('--skip-slack')
    expect(result.stdout.toString()).toContain('--slack-app-name')
    expect(result.stdout.toString()).toContain('--slack-bot-name')
    expect(result.stdout.toString()).toContain('--with-slack')
    expect(result.stdout.toString()).toContain('--slack-only')
  })

  test('--doctor reports installed tool versions without changing HOME', () => {
    if (process.platform !== 'darwin') return
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-doctor-'))
    try {
      const result = Bun.spawnSync([bootstrap, '--doctor'], {
        env: { ...process.env, HOME: fakeHome },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain('Command Line Tools:')
      expect(result.stdout.toString()).toContain('Codex CLI:')
      expect(Bun.spawnSync(['/bin/ls', '-A', fakeHome]).stdout.toString()).toBe('')
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('--doctor fails clearly when required CLIs are missing and stays read-only', () => {
    if (process.platform !== 'darwin') return
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-missing-'))
    try {
      const result = Bun.spawnSync(['/bin/bash', bootstrap, '--doctor'], {
        env: { HOME: fakeHome, PATH: '/usr/bin:/bin' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).toContain('Homebrew:')
      expect(result.stdout.toString()).toContain('未導入')
      expect(Bun.spawnSync(['/bin/ls', '-A', fakeHome]).stdout.toString()).toBe('')
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  // 退避先の後始末が速いので「実行後にHOMEが空か」だけでは、HOME配下に作って
  // すぐ消す実装を見逃す。CODEX_HOMEの実際の行き先を偽codexに報告させて捕まえる。
  // 報告は物理パスで受け取る。mkdtempSyncは /var/folders/... を返すのに
  // スクリプト側は pwd -P で /private/var/folders/... を返すため、
  // 論理パスのままprefix比較すると「HOME配下に作った」場合でも素通りする。
  const codexHomeProbe = (report: string) =>
    [
      '#!/bin/sh',
      'target="${CODEX_HOME:-unset}"',
      'if [ -d "$target" ]; then',
      `  printf '%s\\n' "$(cd "$target" 2>/dev/null && pwd -P)" > '${report}'`,
      `  printf 'dir=yes\\n' >> '${report}'`,
      'else',
      `  printf '%s\\n' "$target" > '${report}'`,
      'fi',
      'echo "codex-cli 0.0.0-test"',
      '',
    ].join('\n')

  // 論理パスと物理パスの両方でHOME配下を否定する。片方だけだと取り落とす。
  const expectOutsideHome = (reported: string, fakeHome: string) => {
    for (const form of new Set([fakeHome, realpathSync(fakeHome)])) {
      expect(reported.startsWith(form)).toBe(false)
    }
  }

  test('--doctor keeps its scratch outside HOME even when TMPDIR points inside HOME', () => {
    if (process.platform !== 'darwin') return
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-tmpdir-'))
    const insideHome = join(fakeHome, '.tmp')
    mkdirSync(insideHome)
    const fakeBin = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-tmpdirbin-'))
    const report = join(fakeBin, 'report.txt')
    try {
      writeFileSync(join(fakeBin, 'codex'), codexHomeProbe(report), { mode: 0o755 })
      const result = Bun.spawnSync([bootstrap, '--doctor'], {
        env: {
          ...process.env,
          HOME: fakeHome,
          TMPDIR: insideHome,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      const seen = readFileSync(report, 'utf8').trim().split('\n')
      // TMPDIRがHOME配下を指していても、退避先はHOMEの外へ逃がす。
      expectOutsideHome(seen[0], fakeHome)
      expect(seen).toContain('dir=yes')
      // HOME配下に存在してよいのは、このテストが用意した .tmp だけ。
      const entries = Bun.spawnSync(['/usr/bin/find', fakeHome, '-mindepth', '1'])
        .stdout.toString()
        .trim()
        .split('\n')
        .filter(Boolean)
      expect(entries).toEqual([insideHome])
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
      rmSync(fakeBin, { recursive: true, force: true })
    }
  })

  test('--doctor still reports every tool when TMPDIR is unusable', () => {
    if (process.platform !== 'darwin') return
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-fallback-'))
    try {
      const result = Bun.spawnSync([bootstrap, '--doctor'], {
        env: { ...process.env, HOME: fakeHome, TMPDIR: '/nonexistent/zerokun-doctor' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('Codex CLI:')
      expect(Bun.spawnSync(['/bin/ls', '-A', fakeHome]).stdout.toString()).toBe('')
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('--doctor removes the scratch directory it used', () => {
    if (process.platform !== 'darwin') return
    const scratchParent = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-scratch-'))
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-home-'))
    try {
      const result = Bun.spawnSync([bootstrap, '--doctor'], {
        env: { ...process.env, HOME: fakeHome, TMPDIR: scratchParent },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      expect(Bun.spawnSync(['/bin/ls', '-A', scratchParent]).stdout.toString()).toBe('')
    } finally {
      rmSync(scratchParent, { recursive: true, force: true })
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('--doctor hands codex a real scratch CODEX_HOME outside HOME', () => {
    if (process.platform !== 'darwin') return
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-codexhome-'))
    const fakeBin = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-codexbin-'))
    const report = join(fakeBin, 'report.txt')
    try {
      writeFileSync(join(fakeBin, 'codex'), codexHomeProbe(report), { mode: 0o755 })
      const result = Bun.spawnSync([bootstrap, '--doctor'], {
        env: { ...process.env, HOME: fakeHome, PATH: `${fakeBin}:${process.env.PATH}` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      const seen = readFileSync(report, 'utf8').trim().split('\n')
      // 実在するディレクトリを渡す。存在しないパスだとcodex側の寛容さ頼みになる。
      expect(seen).toContain('dir=yes')
      expectOutsideHome(seen[0], fakeHome)
      expect(Bun.spawnSync(['/bin/ls', '-A', fakeHome]).stdout.toString()).toBe('')
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
      rmSync(fakeBin, { recursive: true, force: true })
    }
  })

  test('--doctor treats a failing version command as a problem', () => {
    if (process.platform !== 'darwin') return
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-broken-'))
    const fakeBin = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-brokenbin-'))
    try {
      writeFileSync(join(fakeBin, 'codex'), '#!/bin/sh\necho "boom" >&2\nexit 3\n', { mode: 0o755 })
      const result = Bun.spawnSync([bootstrap, '--doctor'], {
        env: { ...process.env, HOME: fakeHome, PATH: `${fakeBin}:${process.env.PATH}` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).toContain('実行失敗')
      expect(Bun.spawnSync(['/bin/ls', '-A', fakeHome]).stdout.toString()).toBe('')
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
      rmSync(fakeBin, { recursive: true, force: true })
    }
  })

  test('--doctor refuses a scratch parent that other local users can write to', () => {
    if (process.platform !== 'darwin') return
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-untrusted-'))
    const fakeBin = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-untrustedbin-'))
    const sharedTmp = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-shared-'))
    const report = join(fakeBin, 'report.txt')
    try {
      // 自分の持ち物でも、他人が書けてstickyでない場所は退避先に使わない。
      // mktempが作った直後にエントリごと差し替えられる余地があるため。
      chmodSync(sharedTmp, 0o777)
      writeFileSync(join(fakeBin, 'codex'), codexHomeProbe(report), { mode: 0o755 })
      const result = Bun.spawnSync([bootstrap, '--doctor'], {
        env: {
          ...process.env,
          HOME: fakeHome,
          TMPDIR: sharedTmp,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      const seen = readFileSync(report, 'utf8').trim().split('\n')
      expect(seen).toContain('dir=yes')
      // 信用できないTMPDIRは使わず、/tmp へ落ちる。
      for (const form of new Set([sharedTmp, realpathSync(sharedTmp)])) {
        expect(seen[0].startsWith(form)).toBe(false)
      }
      expectOutsideHome(seen[0], fakeHome)
      expect(Bun.spawnSync(['/bin/ls', '-A', sharedTmp]).stdout.toString()).toBe('')
    } finally {
      rmSync(sharedTmp, { recursive: true, force: true })
      rmSync(fakeHome, { recursive: true, force: true })
      rmSync(fakeBin, { recursive: true, force: true })
    }
  })

  test('--doctor says so plainly when no scratch parent is usable', () => {
    if (process.platform !== 'darwin') return
    // HOMEが / のとき「HOMEの外」は存在しないので、退避先を作れない。
    const result = Bun.spawnSync([bootstrap, '--doctor'], {
      env: { ...process.env, HOME: '/' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain('一時領域を確保できず未診断')
    // Codex以外の診断は続ける。
    expect(result.stdout.toString()).toContain('Homebrew:')
  })

  test('--doctor refuses to be combined with --slack-only', () => {
    for (const args of [
      ['--doctor', '--slack-only'],
      ['--slack-only', '--doctor'],
    ]) {
      const result = Bun.spawnSync([bootstrap, ...args], { stdout: 'pipe', stderr: 'pipe' })
      expect(result.exitCode).toBe(2)
      expect(result.stderr.toString()).toContain('同時に指定できません')
    }
  })

  test('bootstrap owns dependency installation, login, clone, setup and Slack handoff', () => {
    const script = readFileSync(bootstrap, 'utf8')
    expect(script).toContain('xcode-select --install')
    expect(script).toContain('Homebrew/install/HEAD/install.sh')
    expect(script).toContain('brew install tmux')
    expect(script).toContain('brew install --cask codex')
    expect(script).toContain('https://chatgpt.com/codex/install.sh')
    expect(script).not.toContain('claude auth login')
    expect(script).toContain('codex login')
    expect(script).not.toContain('gh auth login')
    expect(script).toContain('zerocolored/zero')
    expect(script).toContain('ensure_repo zerocolored/zero "$REPO_DIR" codex')
    expect(script).not.toContain('zerocolored/skills')
    expect(script).not.toContain('BellSalesAI')
    expect(script).toContain('zerokun/setup.sh')
    expect(script).toContain('slack-app-manifest.yaml')
    expect(script).toContain('connections:write')
    expect(script).toContain('https://api.slack.com/apps?new_app=1')
    expect(script).toContain('Slack Appの表示名')
    expect(script).toContain('Slack bot username')
    expect(script).toContain('xoxb-[A-Za-z0-9._-]{10,}')
    expect(script).toContain('xapp-[A-Za-z0-9._-]{10,}')
  })

  test('Homebrew版が最低version未満ならCodex公式standaloneへfallbackする', () => {
    const source = readFileSync(bootstrap, 'utf8')
    const functions = source.slice(
      source.indexOf('install_codex_standalone()'),
      source.indexOf('ensure_logins()'),
    )
    const base = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-codex-fallback-'))
    const fakeHome = join(base, 'home')
    const fakeBin = join(base, 'bin')
    mkdirSync(fakeHome)
    mkdirSync(fakeBin)
    writeFileSync(join(fakeBin, 'codex'), '#!/bin/sh\necho "codex-cli 0.147.0"\n', { mode: 0o755 })
    writeFileSync(join(fakeBin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(fakeBin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(fakeBin, 'brew'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const installerSource = join(base, 'official-installer.sh')
    writeFileSync(installerSource, `#!/bin/sh
mkdir -p "$HOME/.local/bin"
printf '%s\\n' '#!/bin/sh' 'echo "codex-cli 0.149.0"' > "$HOME/.local/bin/codex"
chmod 755 "$HOME/.local/bin/codex"
`)
    const fakeCurl = join(fakeBin, 'curl')
    writeFileSync(fakeCurl, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then shift; output="$1"; fi
  shift
done
/bin/cp "$FAKE_CODEX_INSTALLER" "$output"
`, { mode: 0o755 })
    const harness = join(base, 'harness.sh')
    writeFileSync(harness, `#!/bin/bash
set -euo pipefail
MIN_CODEX_VERSION=0.149.0
section() { :; }
ok() { :; }
warn() { :; }
fail() { echo "$1" >&2; exit 1; }
append_profile_block() { :; }
codex_version_number() { codex --version | sed -nE 's/.*[^0-9]([0-9]+\\.[0-9]+\\.[0-9]+).*/\\1/p' | head -n 1; }
version_at_least() {
  local actual="$1" minimum="$2" index left right
  for index in 1 2 3; do
    left="$(printf '%s' "$actual" | cut -d. -f"$index")"
    right="$(printf '%s' "$minimum" | cut -d. -f"$index")"
    case "$left" in ''|*[!0-9]*) return 1 ;; esac
    case "$right" in ''|*[!0-9]*) return 1 ;; esac
    if [ "$left" -gt "$right" ]; then return 0; fi
    if [ "$left" -lt "$right" ]; then return 1; fi
  done
  return 0
}
${functions}
install_cli_tools
codex --version
`)
    chmodSync(harness, 0o700)
    try {
      const result = Bun.spawnSync([harness], {
        env: {
          HOME: fakeHome,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          ZEROKUN_CURL_BIN: fakeCurl,
          FAKE_CODEX_INSTALLER: installerSource,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain('codex-cli 0.149.0')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('単体download bootstrapの再実行は未検証checkout内のvalidatorを直接実行しない', () => {
    const source = readFileSync(bootstrap, 'utf8')
    const validator = source.slice(
      source.indexOf('validate_existing_repo()'),
      source.indexOf('ensure_repo()'),
    )
    expect(validator).toContain('raw.githubusercontent.com/${slug}/${target_branch}/zerokun/validate-update-repo.ts')
    expect(validator).toContain('/usr/bin/mktemp /tmp/zerokun-repo-validator.')
    expect(validator).not.toContain('$target/zerokun/validate-update-repo.ts')
  })

  test('単体download validatorは相対依存なしで既存cloneを検証できる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-standalone-validator-'))
    const repo = join(dir, 'zero')
    const standalone = join(dir, 'validate-update-repo.ts')
    try {
      Bun.spawnSync(['git', 'init', '--initial-branch=codex', repo])
      Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'https://github.com/zerocolored/zero.git'])
      writeFileSync(standalone, readFileSync(join(import.meta.dir, 'validate-update-repo.ts'), 'utf8'))
      const result = Bun.spawnSync(['bun', standalone, repo, 'codex'], {
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('bootstrapはsymlinkまたはhardlink .zprofileを追って外部fileへ追記しない', () => {
    for (const linkKind of ['symlink', 'hardlink'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `zerokun-bootstrap-zprofile-${linkKind}-`))
      const home = join(dir, 'home')
      const external = join(dir, 'external')
      mkdirSync(home)
      writeFileSync(external, 'keep\n')
      if (linkKind === 'symlink') symlinkSync(external, join(home, '.zprofile'))
      else Bun.spawnSync(['/bin/ln', external, join(home, '.zprofile')])
      try {
        const command = [
          'bootstrap_path="$1"',
          'set --',
          'source "$bootstrap_path"',
          'append_profile_block "# test" "do not append"',
        ].join('; ')
        const result = Bun.spawnSync(['/bin/bash', '-c', command, 'bash', bootstrap], {
          env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe',
        })
        expect(result.exitCode).not.toBe(0)
        expect(readFileSync(external, 'utf8')).toBe('keep\n')
        expect(lstatSync(join(home, '.zprofile')).isSymbolicLink()).toBe(linkKind === 'symlink')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  test('GitHub originはslugの部分一致ではなく正規URLだけを受け入れる', () => {
    const command = [
      'bootstrap_path="$1"',
      'set --',
      'source "$bootstrap_path"',
      'remote_matches_slug zerocolored/zero https://github.com/zerocolored/zero.git',
      '! remote_matches_slug zerocolored/zero https://github.com/evil/zerocolored/zero.git',
      '! remote_matches_slug zerocolored/zero git@github.com:evil/zerocolored/zero.git',
    ].join('; ')
    const result = Bun.spawnSync(['/bin/bash', '-c', command, 'bash', bootstrap])
    expect(result.exitCode).toBe(0)
  })

  test('許可channelの初期routeを追加し、既存routeは保持する', () => {
    const state = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-routes-'))
    const project = join(state, 'project')
    mkdirSync(project)
    writeFileSync(join(state, 'access.json'), JSON.stringify({
      channels: { CNEW123: {}, CKEEP123: {} },
    }))
    writeFileSync(join(state, 'routes.json'), JSON.stringify({
      CKEEP123: { repo_path: '/existing/repo', label: 'Existing' },
    }))
    try {
      const command = [
        'bootstrap_path="$1"',
        'target_state="$2"',
        'target_project="$3"',
        'set --',
        'source "$bootstrap_path"',
        'STATE_DIR="$target_state"',
        'PROJECT_DIR="$target_project"',
        'configure_routes_from_access',
      ].join('; ')
      const result = Bun.spawnSync([
        '/bin/bash', '-c', command, 'bash', bootstrap, state, project,
      ], { stdout: 'pipe', stderr: 'pipe' })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      const routes = JSON.parse(readFileSync(join(state, 'routes.json'), 'utf8'))
      expect(routes.CKEEP123.repo_path).toBe('/existing/repo')
      expect(routes.CNEW123.repo_path).toBe(realpathSync(project))
      expect(statSync(join(state, 'routes.json')).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  })

  test('既存cloneの悪性Git helperを実行せずbootstrapを拒否する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-git-config-'))
    const repo = join(dir, 'zero')
    const marker = join(dir, 'helper-executed')
    const helper = join(dir, 'fsmonitor.sh')
    try {
      Bun.spawnSync(['git', 'init', '--initial-branch=codex', repo])
      Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'https://github.com/zerocolored/zero.git'])
      writeFileSync(helper, `#!/bin/bash\ntouch '${marker}'\n`, { mode: 0o700 })
      Bun.spawnSync(['git', '-C', repo, 'config', 'core.fsmonitor', helper])
      const command = [
        'bootstrap_path="$1"',
        'target_repo="$2"',
        'set --',
        'source "$bootstrap_path"',
        'ensure_repo zerocolored/zero "$target_repo" codex',
      ].join('; ')
      const result = Bun.spawnSync([
        '/bin/bash', '-c', command, 'bash', bootstrap, repo,
      ], { stdout: 'pipe', stderr: 'pipe' })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('Git設定またはoriginが安全ではありません')
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('既存main cloneを安全にorigin/codex tracking branchへ移行する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-main-to-codex-'))
    const bare = join(dir, 'remote.git')
    const seed = join(dir, 'seed')
    const repo = join(dir, 'zero')
    const run = (args: string[], cwd?: string) => {
      const result = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      return result.stdout.toString().trim()
    }
    try {
      run(['git', 'init', '--bare', '--initial-branch=main', bare])
      run(['git', 'init', '--initial-branch=main', seed])
      run(['git', 'config', 'user.email', 'test@example.com'], seed)
      run(['git', 'config', 'user.name', 'test'], seed)
      writeFileSync(join(seed, 'version.txt'), 'main\n')
      run(['git', 'add', '.'], seed)
      run(['git', 'commit', '-m', 'main'], seed)
      run(['git', 'remote', 'add', 'origin', bare], seed)
      run(['git', 'push', '-u', 'origin', 'main'], seed)
      run(['git', 'switch', '-c', 'codex'], seed)
      writeFileSync(join(seed, 'version.txt'), 'codex\n')
      run(['git', 'commit', '-am', 'codex'], seed)
      run(['git', 'push', '-u', 'origin', 'codex'], seed)
      run(['git', 'clone', '--branch', 'main', bare, repo])

      const command = [
        'bootstrap_path="$1"',
        'target_repo="$2"',
        'set --',
        'source "$bootstrap_path"',
        'ensure_repo zerocolored/zero "$target_repo" codex',
      ].join('; ')
      const result = Bun.spawnSync([
        '/bin/bash', '-c', command, 'bash', bootstrap, repo,
      ], {
        env: { ...process.env, ZEROKUN_UPDATE_TESTING: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(run(['git', 'branch', '--show-current'], repo)).toBe('codex')
      expect(run(['git', 'rev-parse', 'HEAD'], repo)).toBe(run(['git', 'rev-parse', 'origin/codex'], repo))
      expect(run(['git', 'config', 'branch.codex.remote'], repo)).toBe('origin')
      expect(run(['git', 'config', 'branch.codex.merge'], repo)).toBe('refs/heads/codex')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('dirtyな既存main cloneでは旧branchのsetupへ進まず停止する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-dirty-main-'))
    const repo = join(dir, 'zero')
    try {
      Bun.spawnSync(['git', 'init', '--initial-branch=main', repo])
      Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'https://github.com/zerocolored/zero.git'])
      writeFileSync(join(repo, 'uncommitted.txt'), 'preserve\n')
      const command = [
        'bootstrap_path="$1"',
        'target_repo="$2"',
        'set --',
        'source "$bootstrap_path"',
        'ensure_repo zerocolored/zero "$target_repo" codex',
      ].join('; ')
      const result = Bun.spawnSync([
        '/bin/bash', '-c', command, 'bash', bootstrap, repo,
      ], { stdout: 'pipe', stderr: 'pipe' })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('変更をcommit/stash')
      expect(readFileSync(join(repo, 'uncommitted.txt'), 'utf8')).toBe('preserve\n')
      expect(Bun.spawnSync(['git', '-C', repo, 'branch', '--show-current']).stdout.toString().trim())
        .toBe('main')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('set -uでも変数直後の日本語を変数名として誤解しない', () => {
    const script = readFileSync(bootstrap, 'utf8')
    const unsafeExpansions = script.match(/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/g) ?? []
    expect(unsafeExpansions).toEqual([])
  })

  test('default setup completes before Slack and does not enter Slack configuration', () => {
    const command = [
      'bootstrap_path="$1"',
      'set --',
      'source "$bootstrap_path"',
      'calls=""',
      'require_macos() { calls="$calls require_macos"; }',
      'install_clt() { calls="$calls install_clt"; }',
      'install_homebrew() { calls="$calls install_homebrew"; }',
      'install_cli_tools() { calls="$calls install_cli_tools"; }',
      'ensure_logins() { calls="$calls ensure_logins"; }',
      'install_repositories() { calls="$calls install_repositories"; }',
      'ensure_project_workspace() { calls="$calls ensure_project_workspace"; }',
      'run_setup() { calls="$calls run_setup"; }',
      'run_doctor() { calls="$calls run_doctor"; }',
      'configure_slack() { calls="$calls configure_slack"; }',
      'MODE="install"',
      'WITH_SLACK=0',
      'main',
      'printf "CALLS:%s\\n" "$calls"',
    ].join('; ')
    const result = Bun.spawnSync(['/bin/bash', '-c', command, 'bash', bootstrap], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('Codexを利用できます')
    expect(output).toContain('run_setup run_doctor')
    expect(output).not.toContain('CALLS: configure_slack')
    expect(output.split('CALLS:')[1]).not.toContain('configure_slack')
  })

  test('Slack-only mode skips every core installation step', () => {
    const command = [
      'bootstrap_path="$1"',
      'set --',
      'source "$bootstrap_path"',
      'calls=""',
      'require_macos() { calls="$calls require_macos"; }',
      'install_clt() { calls="$calls install_clt"; }',
      'install_homebrew() { calls="$calls install_homebrew"; }',
      'install_cli_tools() { calls="$calls install_cli_tools"; }',
      'ensure_logins() { calls="$calls ensure_logins"; }',
      'install_repositories() { calls="$calls install_repositories"; }',
      'ensure_project_workspace() { calls="$calls ensure_project_workspace"; }',
      'run_setup() { calls="$calls run_setup"; }',
      'run_doctor() { calls="$calls run_doctor"; }',
      'configure_slack() { calls="$calls configure_slack"; }',
      'MODE="slack-only"',
      'main',
      'printf "CALLS:%s\\n" "$calls"',
    ].join('; ')
    const result = Bun.spawnSync(['/bin/bash', '-c', command, 'bash', bootstrap], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const calls = result.stdout.toString().split('CALLS:')[1]
    expect(result.exitCode).toBe(0)
    expect(calls).toContain('require_macos configure_slack')
    expect(calls).not.toContain('install_clt')
    expect(calls).not.toContain('run_setup')
  })

  test('Slack token input retries and normalizes copied env assignment without exposing it', () => {
    const token = 'xoxb-1234567890-abcdefghijklmnopqrstuvwxyz'
    const command = [
      'bootstrap_path="$1"',
      'set --',
      'source "$bootstrap_path"',
      `exec 3<<< $'wrong\\n  SLACK_BOT_TOKEN="${token}"  '`,
      'read_slack_token xoxb "Bot Token" SLACK_BOT_TOKEN <&3',
      'exec 3<&-',
      'printf "RESULT:%s\\n" "${SLACK_TOKEN_RESULT%%-*}"',
    ].join('; ')
    const result = Bun.spawnSync(['/bin/bash', '-c', command, 'bash', bootstrap], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = result.stdout.toString() + result.stderr.toString()
    expect(result.exitCode).toBe(0)
    expect(output).toContain('もう一度入力')
    expect(output).toContain('RESULT:xoxb')
    expect(output).not.toContain(token)
  })

  test('Slack manifest contains the complete Socket Mode contract', () => {
    const manifest = readFileSync(join(import.meta.dir, 'templates/slack-app-manifest.yaml'), 'utf8')
    for (const expected of [
      'socket_mode_enabled: true',
      'messages_tab_enabled: true',
      'messages_tab_read_only_enabled: false',
      'name: Zero-kun Custom',
      'display_name: zerokun-custom',
      '- app_mention',
      '- member_joined_channel',
      '- message.im',
      '- message.channels',
      '- message.groups',
      '- chat:write',
      '- files:write',
      '- reactions:write',
    ]) expect(manifest).toContain(expected)
    expect(manifest).not.toContain('display_name: ゼロくん')
  })

  test('Slack manifest renderer applies a custom app name and valid bot username', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'zerokun-slack-manifest-'))
    const rendered = join(tempDir, 'manifest.yaml')
    const template = join(import.meta.dir, 'templates/slack-app-manifest.yaml')
    try {
      const command = [
        'bootstrap_path="$1"',
        'template_path="$2"',
        'rendered_path="$3"',
        'set --',
        'source "$bootstrap_path"',
        'SLACK_APP_NAME="ゼロくん-新Mac"',
        'SLACK_BOT_USERNAME="zerokun-new-mac"',
        'render_slack_manifest "$template_path" "$rendered_path"',
      ].join('; ')
      const result = Bun.spawnSync(['/bin/bash', '-c', command, 'bash', bootstrap, template, rendered], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      const manifest = readFileSync(rendered, 'utf8')
      expect(manifest).toContain('name: "ゼロくん-新Mac"')
      expect(manifest).toContain('display_name: zerokun-new-mac')
      expect(manifest).not.toContain('name: Zero-kun Custom')
      expect(manifest).not.toContain('display_name: zerokun-custom')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Slack bot username validation rejects Japanese names before manifest creation', () => {
    const command = [
      'bootstrap_path="$1"',
      'set --',
      'source "$bootstrap_path"',
      'SLACK_APP_NAME="別のゼロくん"',
      'SLACK_BOT_USERNAME="ゼロくん"',
      'validate_slack_names',
    ].join('; ')
    const result = Bun.spawnSync(['/bin/bash', '-c', command, 'bash', bootstrap], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('英小文字・数字・ハイフン・アンダースコア・ピリオド')
  })

  test('launcher and setup use portable paths and keep the default workspace outside the runtime repo', () => {
    const launcher = readFileSync(join(root, 'codex-channel.sh'), 'utf8')
    const setup = readFileSync(join(import.meta.dir, 'setup.sh'), 'utf8')
    expect(launcher).toContain('${ZEROKUN_PROJECT_DIR:-$REPO_DIR}')
    expect(launcher).not.toContain('/Users/zerocolored-macpro-suetsugu')
    expect(setup).toContain('${ZEROKUN_PROJECT_DIR:-$(dirname "$REPO_DIR")/zerokun-workspace}')
    expect(setup).toContain('Slack作業projectはZero-kun本体と別directoryにしてください')
    expect(readFileSync(bootstrap, 'utf8')).not.toContain('BellSalesAI')
    expect(readFileSync(bootstrap, 'utf8')).not.toContain('Muxy')
  })

  test('setup wires a custom project path and preserves an existing token file', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-home-'))
    const stateDir = join(fakeHome, 'Library/Application Support/Zero-kun')
    const projectDir = join(fakeHome, 'Work/BellSalesAI custom')
    const tokenFile = join(stateDir, '.env')
    try {
      mkdirSync(join(stateDir, 'owner/claude-config/.git'), { recursive: true })
      mkdirSync(join(stateDir, 'owner/claude-skills/.git'), { recursive: true })
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(tokenFile, 'SLACK_BOT_TOKEN=xoxb-existing\nSLACK_APP_TOKEN=xapp-existing\n')
      writeFileSync(join(fakeHome, '.zshrc'), 'export EXISTING=1\n', { mode: 0o600 })

      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_PROJECT_DIR: projectDir,
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode).toBe(0)
      const zshrc = readFileSync(join(fakeHome, '.zshrc'), 'utf8')
      expect(zshrc).toContain(`export ZEROKUN_PROJECT_DIR=${projectDir.replace(' ', '\\ ')}`)
      expect(zshrc).toContain(`export ZEROKUN_STATE_DIR=${stateDir.replaceAll(' ', '\\ ')}`)
      expect(zshrc).toContain('codex-channel "$ZEROKUN_PROJECT_DIR"')
      expect(statSync(join(fakeHome, '.zshrc')).mode & 0o777).toBe(0o600)
      expect(readFileSync(
        join(fakeHome, 'Library/LaunchAgents/com.zerokun.watchdog.plist'),
        'utf8',
      )).toContain(`${stateDir}/watchdog.sh`)
      expect(readFileSync(
        join(fakeHome, 'Library/LaunchAgents/com.zerokun.watchdog.plist'),
        'utf8',
      )).toContain(`<string>${stateDir}</string>`)
      expect(readFileSync(tokenFile, 'utf8')).toBe(
        'SLACK_BOT_TOKEN=xoxb-existing\nSLACK_APP_TOKEN=xapp-existing\n',
      )
      const copiedWorker = Bun.spawnSync([
        process.execPath,
        join(stateDir, 'update-request.ts'),
      ], {
        env: { ...process.env, HOME: fakeHome, ZEROKUN_STATE_DIR: stateDir },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(copiedWorker.exitCode).toBe(1)
      expect(copiedWorker.stderr.toString()).toContain('usage: update-request.ts run')
      expect(copiedWorker.stderr.toString()).not.toContain('Cannot find module')
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('setup lock identityは既存symlinkを置換しstate外fileを上書きしない', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-lock-symlink-'))
    const stateDir = join(fakeHome, 'state')
    const projectDir = join(fakeHome, 'project')
    const external = join(fakeHome, 'external-identity')
    try {
      mkdirSync(join(stateDir, 'update.lock'), { recursive: true, mode: 0o700 })
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(external, 'keep-outside-state\n', { mode: 0o644 })
      symlinkSync(external, join(stateDir, 'update.lock/pid.identity'))

      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_PROJECT_DIR: projectDir,
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(readFileSync(external, 'utf8')).toBe('keep-outside-state\n')
      expect(statSync(external).mode & 0o777).toBe(0o644)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('setupはdead PIDのstale update lockを自動回収して再実行できる', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-stale-lock-'))
    const stateDir = join(fakeHome, 'state')
    const projectDir = join(fakeHome, 'project')
    try {
      mkdirSync(join(stateDir, 'update.lock'), { recursive: true, mode: 0o700 })
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(stateDir, 'update.lock/pid'), '99999999\n', { mode: 0o600 })
      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_PROJECT_DIR: projectDir,
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(existsSync(join(stateDir, 'update.lock/pid'))).toBe(false)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('setupはwatchdog plist symlinkを拒否し外部fileを上書きしない', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-plist-symlink-'))
    const stateDir = join(fakeHome, 'state')
    const projectDir = join(fakeHome, 'project')
    const external = join(fakeHome, 'external.plist')
    const plist = join(fakeHome, 'Library/LaunchAgents/com.zerokun.watchdog.plist')
    try {
      mkdirSync(join(fakeHome, 'Library/LaunchAgents'), { recursive: true })
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(external, 'keep-plist\n')
      symlinkSync(external, plist)
      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: { ...process.env, HOME: fakeHome, ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_PROJECT_DIR: projectDir, ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(readFileSync(external, 'utf8')).toBe('keep-plist\n')
      expect(lstatSync(plist).isSymbolicLink()).toBe(true)
    } finally { rmSync(fakeHome, { recursive: true, force: true }) }
  })

  test('setupはsymlink .zshrcを拒否してlinkと外部targetを保持する', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-zshrc-symlink-'))
    const stateDir = join(fakeHome, 'state')
    const projectDir = join(fakeHome, 'project')
    const external = join(fakeHome, 'managed-zshrc')
    const zshrc = join(fakeHome, '.zshrc')
    try {
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(external, 'export KEEP=1\n')
      symlinkSync(external, zshrc)
      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: { ...process.env, HOME: fakeHome, ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_PROJECT_DIR: projectDir, ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(readFileSync(external, 'utf8')).toBe('export KEEP=1\n')
      expect(lstatSync(zshrc).isSymbolicLink()).toBe(true)
    } finally { rmSync(fakeHome, { recursive: true, force: true }) }
  })

  test('setupは不均衡な管理markerで.zshrc原本を変更しない', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-zshrc-marker-'))
    const stateDir = join(fakeHome, 'state')
    const projectDir = join(fakeHome, 'project')
    const zshrc = join(fakeHome, '.zshrc')
    const original = 'export KEEP_BEFORE=1\n# >>> zerokun setup >>>\nexport KEEP_AFTER=1\n'
    try {
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(zshrc, original, { mode: 0o640 })
      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: { ...process.env, HOME: fakeHome, ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_PROJECT_DIR: projectDir, ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(readFileSync(zshrc, 'utf8')).toBe(original)
      expect(statSync(zshrc).mode & 0o777).toBe(0o640)
    } finally { rmSync(fakeHome, { recursive: true, force: true }) }
  })

  test('watchdogのlaunchctl登録失敗後もCLIリンクとzsh aliasを設置する', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-launchctl-failure-'))
    const stateDir = join(fakeHome, '.claude/channels/slack')
    const projectDir = join(fakeHome, 'Work/BellSalesAI')
    const fakeLaunchctl = join(fakeHome, 'launchctl-fails')
    try {
      mkdirSync(join(stateDir, 'owner/claude-config/.git'), { recursive: true })
      mkdirSync(join(stateDir, 'owner/claude-skills/.git'), { recursive: true })
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(fakeLaunchctl, '#!/bin/bash\nexit 42\n', { mode: 0o700 })

      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_PROJECT_DIR: projectDir,
          ZEROKUN_LAUNCHCTL_BIN: fakeLaunchctl,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode).toBe(0)
      expect(result.stderr.toString()).toContain('watchdog のlaunchd登録に失敗')
      expect(existsSync(join(fakeHome, '.local/bin/zerokun-jobs'))).toBe(true)
      expect(readFileSync(join(fakeHome, '.zshrc'), 'utf8')).toContain("alias zerokun=")
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('Claude版runnerを停止し、待機jobをsessionなしのCodex queueへcutoverする', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-cutover-'))
    const stateDir = join(fakeHome, '.claude/channels/slack')
    const projectDir = join(fakeHome, 'Work/BellSalesAI')
    let legacyRunner: Bun.Subprocess | undefined
    let legacyGateway: Bun.Subprocess | undefined
    let codexRunner: Bun.Subprocess | undefined
    try {
      mkdirSync(join(stateDir, 'job-runner.lock'), { recursive: true })
      mkdirSync(projectDir, { recursive: true })
      const legacyPath = join(stateDir, 'job-runner.ts')
      const legacyServer = join(stateDir, 'server.ts')
      writeFileSync(legacyPath, '#!/bin/bash\ntrap "exit 0" TERM INT\nwhile :; do sleep 1; done\n', { mode: 0o700 })
      writeFileSync(legacyServer, '#!/bin/bash\ntrap "exit 0" TERM INT\nwhile :; do sleep 1; done\n', { mode: 0o700 })
      legacyRunner = Bun.spawn(['/bin/bash', legacyPath, 'daemon'], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      })
      legacyGateway = Bun.spawn(['/bin/bash', legacyServer], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      })
      writeFileSync(join(stateDir, 'job-runner.lock/pid'), `${legacyRunner.pid}\n`)
      writeFileSync(join(stateDir, 'plugin.lock'), `${legacyGateway.pid}\n`)

      const dbPath = join(stateDir, 'jobs.sqlite3')
      const legacyDb = new Database(dbPath, { create: true })
      legacyDb.exec(`
        CREATE TABLE jobs (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, idempotency_key TEXT UNIQUE,
          chat_id TEXT, thread_ts TEXT, message_id TEXT, user_id TEXT, repo_path TEXT, task TEXT,
          status TEXT, session_id TEXT, resumed INTEGER, worker_id TEXT, attempts INTEGER,
          result TEXT, last_error TEXT, created_at INTEGER, started_at INTEGER, finished_at INTEGER
        );
        INSERT INTO jobs VALUES (
          1, 'legacy-job', 'C:1', 'C', '1', '1', 'U', '/tmp/project', 'pending',
          'queued', 'claude-session', 0, NULL, 0, NULL, NULL, 1, NULL, NULL
        );
      `)
      legacyDb.close()

      const setup = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_PROJECT_DIR: projectDir,
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(setup.exitCode, setup.stderr.toString()).toBe(0)
      expect(setup.stdout.toString()).toContain('旧job runnerを安全に停止')
      expect(setup.stdout.toString()).toContain('旧Slack gatewayを停止')
      await Promise.all([legacyRunner.exited, legacyGateway.exited])

      const runtimeInfo = Bun.spawnSync([
        process.execPath,
        join(root, 'zerokun/job-runner.ts'),
        'runtime-info',
      ], {
        env: { ...process.env, ZEROKUN_STATE_DIR: stateDir },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(runtimeInfo.exitCode, runtimeInfo.stderr.toString()).toBe(0)
      expect(JSON.parse(runtimeInfo.stdout.toString())).toMatchObject({ runtime: 'codex' })
      const migrated = new Database(dbPath, { readonly: true })
      expect(migrated.query('SELECT runtime, status, session_id FROM jobs WHERE id = ?')
        .get('legacy-job')).toEqual({ runtime: 'codex', status: 'queued', session_id: null })
      migrated.close()

      mkdirSync(join(stateDir, 'update.lock'), { recursive: true })
      writeFileSync(join(stateDir, 'update.lock/pid'), `${process.pid}\n`)
      codexRunner = Bun.spawn([
        process.execPath,
        join(root, 'zerokun/job-runner.ts'),
        'daemon',
      ], {
        env: { ...process.env, ZEROKUN_STATE_DIR: stateDir },
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      })
      for (let index = 0; index < 100; index += 1) {
        if (existsSync(join(stateDir, 'job-runner.lock/runtime'))) break
        await Bun.sleep(20)
      }
      expect(readFileSync(join(stateDir, 'job-runner.lock/runtime'), 'utf8').trim())
        .toBe('zerokun-codex-runner-v1')
    } finally {
      for (const child of [legacyRunner, legacyGateway, codexRunner]) {
        if (!child) continue
        try { child.kill() } catch {}
        try { await child.exited } catch {}
      }
      rmSync(fakeHome, { recursive: true, force: true })
    }
  }, 30_000)
})
