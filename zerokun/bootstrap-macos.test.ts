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

function setupTestPath(fakeHome: string, botAppId?: string): string {
  const fakeBin = join(fakeHome, 'zerokun-test-bin')
  const localBin = join(fakeHome, '.local', 'bin')
  mkdirSync(fakeBin, { recursive: true })
  mkdirSync(localBin, { recursive: true })
  writeFileSync(join(localBin, 'codex'), '#!/bin/bash\necho "codex-cli 0.149.1"\n', {
    mode: 0o700,
  })
  const configuredAppId = join(fakeHome, '.zerokun-test-bot-app-id')
  if (botAppId) writeFileSync(configuredAppId, `${botAppId}\n`, { mode: 0o600 })
  else rmSync(configuredAppId, { force: true })
  writeFileSync(join(fakeBin, 'bun'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'if [[ "$*" == *"slack-app-identity.ts verify-file"* ]]; then',
    '  env_file="${@: -1}"',
    "  app_token=\"$(/usr/bin/sed -n 's/^SLACK_APP_TOKEN=//p' \"$env_file\")\"",
    "  app_id=\"$(printf '%s\\n' \"$app_token\" | /usr/bin/sed -E 's/^xapp-([0-9]+-)?(A[A-Z0-9]+)-.*/\\2/')\"",
    '  bot_app_id="$app_id"',
    '  [ ! -f "$HOME/.zerokun-test-bot-app-id" ] || bot_app_id="$(/bin/cat "$HOME/.zerokun-test-bot-app-id")"',
    '  if [ -z "$app_id" ] || [ "$app_id" != "$bot_app_id" ]; then',
    '    echo "Slack App token identity verification failed: different Slack Apps" >&2',
    '    exit 1',
    '  fi',
    '  echo "Slack App token identity: verified"',
    '  exit 0',
    'fi',
    'if [[ "$*" == *"codex-executor.ts verify-system-config"* ]]; then',
    '  exit 0',
    'fi',
    'if [[ "$*" == *"standalone-codex.ts version"* ]]; then',
    '  echo "0.149.1"',
    '  exit 0',
    'fi',
    'if [[ "$*" == *"update.ts --setup-supervisor"* ]]; then',
    `  exec ${JSON.stringify(process.execPath)} --config=/dev/null --no-env-file -e ${JSON.stringify(`import { runStandaloneSetupForTests } from ${JSON.stringify(join(import.meta.dir, 'update.ts'))}; await runStandaloneSetupForTests()`)}`,
    'fi',
    `exec ${JSON.stringify(process.execPath)} "$@"`,
    '',
  ].join('\n'), { mode: 0o700 })
  return `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`
}

function localRemoteGitTestPath(base: string, bare: string): string {
  const fakeBin = join(base, 'zerokun-test-git-bin')
  mkdirSync(fakeBin, { recursive: true })
  const realGit = Bun.which('git') ?? '/usr/bin/git'
  writeFileSync(join(fakeBin, 'git'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'args=()',
    'needs_rewrite=0',
    'for arg in "$@"; do',
    '  [ "$arg" != "fetch" ] && [ "$arg" != "clone" ] || needs_rewrite=1',
    '  if [ "$arg" = "protocol.file.allow=never" ]; then',
    '    args+=("protocol.file.allow=always")',
    '  else',
    '    args+=("$arg")',
    '  fi',
    'done',
    'if [ "$needs_rewrite" = "1" ]; then',
    `  exec ${JSON.stringify(realGit)} -c ${JSON.stringify(`url.file://${bare}.insteadOf=https://github.com/zerocolored/zero-codex.git`)} "\${args[@]}"`,
    'fi',
    `exec ${JSON.stringify(realGit)} "\${args[@]}"`,
    '',
  ].join('\n'), { mode: 0o700 })
  return `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`
}

function validatorCurlTestBin(base: string): string {
  const fakeBin = join(base, 'zerokun-test-curl-bin')
  mkdirSync(fakeBin, { recursive: true })
  const fakeCurl = join(fakeBin, 'curl')
  const validator = join(import.meta.dir, 'validate-update-repo.ts')
  writeFileSync(fakeCurl, [
    '#!/bin/bash',
    'set -euo pipefail',
    'output=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--output" ]; then shift; output="$1"; fi',
    '  shift',
    'done',
    '[ -n "$output" ]',
    `/bin/cp ${JSON.stringify(validator)} "$output"`,
    '',
  ].join('\n'), { mode: 0o700 })
  return fakeCurl
}

function bootstrapWithTestCurl(base: string): string {
  const fakeCurl = validatorCurlTestBin(base)
  const patched = join(base, 'bootstrap-macos.test-copy.sh')
  writeFileSync(
    patched,
    readFileSync(bootstrap, 'utf8').replaceAll('/usr/bin/curl', fakeCurl),
    { mode: 0o700 },
  )
  return patched
}

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
    expect(script).toContain('isolated_network_command "$(command -v brew)" install tmux')
    expect(script).not.toContain('install --cask codex')
    expect(script).toContain('standalone_codex="$HOME/.local/bin/codex"')
    expect(script).toContain('secure_standalone_codex()')
    expect(script).toContain('standalone = os.path.join(home, ".codex", "packages", "standalone")')
    expect(script).toContain("permissions & 8#22")
    expect(script).toContain('expected_header = b"\\xcf\\xfa\\xed\\xfe')
    expect(script).toContain('expected_keys = {"layoutVersion"')
    expect(script).toContain('https://chatgpt.com/codex/install.sh')
    expect(script).not.toContain('claude auth login')
    expect(script).toContain('"$standalone_codex" login')
    expect(script).not.toContain('gh auth login')
    expect(script).toContain('zerocolored/zero-codex')
    expect(script).toContain('ensure_repo zerocolored/zero-codex "$REPO_DIR" main')
    expect(script).toContain('clone直後のGit設定またはoriginを独立検証できません')
    expect(script).toContain('/usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin')
    expect(script).toContain('DEFAULT_REPO_DIR="$HOME/Desktop/Project/zero-codex"')
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
    const setup = readFileSync(join(import.meta.dir, 'setup.sh'), 'utf8')
    expect(setup.indexOf('RUNNER_PID="$(read_lock_pid'))
      .toBeLessThan(setup.indexOf('GATEWAY_PID="$(read_lock_pid'))
  })

  test('Homebrew版が存在してもowner-onlyなCodex公式standaloneを配置する', () => {
    const source = readFileSync(bootstrap, 'utf8')
    const functions = source.slice(
      source.indexOf('secure_download()'),
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
/bin/cp ${JSON.stringify(installerSource)} "$output"
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
codex_version_number() { "\${1:-codex}" --version | sed -nE 's/.*[^0-9]([0-9]+\\.[0-9]+\\.[0-9]+).*/\\1/p' | head -n 1; }
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
${functions.replaceAll('/usr/bin/curl', fakeCurl)}
secure_standalone_codex() { [ -x "$HOME/.local/bin/codex" ]; }
install_cli_tools
codex --version
`)
    chmodSync(harness, 0o700)
    try {
      const result = Bun.spawnSync([harness], {
        env: {
          HOME: fakeHome,
          PATH: `${fakeBin}:/usr/bin:/bin`,
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

  test.skipIf(process.platform !== 'darwin')(
    'standalone検証は安全なrelease配下のnative実体だけを許可する',
    () => {
      const source = readFileSync(bootstrap, 'utf8')
      const functions = source.slice(
        source.indexOf('bootstrap_safe_directory_chain()'),
        source.indexOf('install_codex_standalone()'),
      )
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-secure-codex-')))
      const fakeHome = join(base, 'home')
      const localBin = join(fakeHome, '.local/bin')
      const target = process.arch === 'arm64'
        ? 'aarch64-apple-darwin'
        : 'x86_64-apple-darwin'
      const standalone = join(fakeHome, '.codex/packages/standalone')
      const release = join(standalone, `releases/0.149.0-${target}`)
      mkdirSync(localBin, { recursive: true })
      mkdirSync(join(release, 'bin'), { recursive: true })
      const native = join(release, 'bin/codex')
      const cpu = process.arch === 'arm64'
        ? [0x0c, 0x00, 0x00, 0x01]
        : [0x07, 0x00, 0x00, 0x01]
      writeFileSync(native, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, ...cpu]), { mode: 0o700 })
      writeFileSync(join(release, 'codex-package.json'), JSON.stringify({
        layoutVersion: 1,
        version: '0.149.0',
        target,
        variant: 'codex',
        entrypoint: 'bin/codex',
        resourcesDir: 'codex-resources',
        pathDir: 'codex-path',
      }), { mode: 0o600 })
      symlinkSync(release, join(standalone, 'current'))
      symlinkSync(join(standalone, 'current/bin/codex'), join(localBin, 'codex'))
      const harness = join(base, 'harness.sh')
      writeFileSync(harness, `#!/bin/bash\nset -euo pipefail\nMIN_CODEX_VERSION=0.149.0\n${functions}\nsecure_standalone_codex\n`)
      chmodSync(harness, 0o700)
      try {
        const accepted = Bun.spawnSync([harness], {
          env: { HOME: realpathSync(fakeHome), PATH: '/usr/bin:/bin' },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(accepted.exitCode, accepted.stderr.toString()).toBe(0)
        rmSync(join(localBin, 'codex'))
        symlinkSync(native, join(localBin, 'codex'))
        const rejected = Bun.spawnSync([harness], {
          env: { HOME: realpathSync(fakeHome), PATH: '/usr/bin:/bin' },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(rejected.exitCode).not.toBe(0)
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    },
  )

  test('単体download bootstrapの再実行は未検証checkout内のvalidatorを直接実行しない', () => {
    const source = readFileSync(bootstrap, 'utf8')
    const validator = source.slice(
      source.indexOf('validate_existing_repo()'),
      source.indexOf('ensure_repo()'),
    )
    expect(validator).toContain('raw.githubusercontent.com/${slug}/${target_branch}/zerokun/validate-update-repo.ts')
    expect(validator).toContain('/usr/bin/mktemp -d /tmp/zerokun-repo-validator.')
    expect(validator).not.toContain('$SCRIPT_DIR/validate-update-repo.ts')
    expect(validator).not.toContain('$target/zerokun/validate-update-repo.ts')
  })

  test('単体bootstrapは同じ一時directoryの悪性validatorを無視する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-adjacent-validator-'))
    const standaloneDir = join(dir, 'standalone')
    const temp = join(dir, 'tmp')
    const repo = join(dir, 'repo')
    const marker = join(dir, 'malicious-validator-executed')
    mkdirSync(standaloneDir, { mode: 0o700 })
    mkdirSync(temp, { mode: 0o700 })
    try {
      Bun.spawnSync(['git', 'init', '--initial-branch=main', repo])
      Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'https://github.com/zerocolored/zero-codex.git'])
      const fakeCurl = validatorCurlTestBin(dir)
      const standalone = join(standaloneDir, 'bootstrap-macos.sh')
      writeFileSync(
        standalone,
        readFileSync(bootstrap, 'utf8').replaceAll('/usr/bin/curl', fakeCurl),
        { mode: 0o700 },
      )
      writeFileSync(
        join(standaloneDir, 'validate-update-repo.ts'),
        `await Bun.write(${JSON.stringify(marker)}, 'executed')\n`,
        { mode: 0o600 },
      )
      const command = [
        'bootstrap_path="$1"',
        'target_repo="$2"',
        'set --',
        'source "$bootstrap_path"',
        'validate_existing_repo zerocolored/zero-codex "$target_repo" main',
      ].join('; ')
      const result = Bun.spawnSync([
        '/bin/bash', '-c', command, 'bash', standalone, repo,
      ], {
        env: { ...process.env, TMPDIR: temp },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(existsSync(marker)).toBe(false)
      expect(Bun.spawnSync(['/bin/ls', '-A', temp]).stdout.toString()).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('secure_downloadはambient curl設定・proxy環境を継承しない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-curl-env-'))
    const fakeHome = join(dir, 'home')
    const report = join(dir, 'curl-report')
    const output = join(dir, 'download')
    const fakeCurl = join(dir, 'curl')
    mkdirSync(fakeHome)
    writeFileSync(join(fakeHome, '.curlrc'), 'insecure\nproxy = https://attacker.invalid\n')
    writeFileSync(fakeCurl, [
      '#!/bin/bash',
      'set -euo pipefail',
      `printf '%s|%s|%s\n' "\${HOME-unset}" "\${HTTPS_PROXY-unset}" "$1" > ${JSON.stringify(report)}`,
      'target=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--output" ]; then shift; target="$1"; fi',
      '  shift',
      'done',
      ': > "$target"',
      '',
    ].join('\n'), { mode: 0o700 })
    try {
      const source = readFileSync(bootstrap, 'utf8')
      const secureDownload = source.slice(
        source.indexOf('secure_download()'),
        source.indexOf('install_homebrew()'),
      ).replaceAll('/usr/bin/curl', fakeCurl)
      const harness = join(dir, 'harness.sh')
      writeFileSync(harness, [
        '#!/bin/bash',
        'set -euo pipefail',
        secureDownload,
        `secure_download ${JSON.stringify(output)} https://example.com/file`,
        '',
      ].join('\n'), { mode: 0o700 })
      const result = Bun.spawnSync([harness], {
        env: { ...process.env, HOME: fakeHome, HTTPS_PROXY: 'https://attacker.invalid' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(readFileSync(report, 'utf8').trim()).toBe('unset|unset|-q')
      expect(existsSync(output)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('二段目installerもambient proxy・CA・Git configを継承しない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-second-stage-env-'))
    const fakeHome = join(dir, 'home')
    const report = join(dir, 'report')
    const probe = join(dir, 'probe.sh')
    mkdirSync(fakeHome)
    writeFileSync(join(fakeHome, '.curlrc'), 'insecure\nproxy = https://attacker.invalid\n')
    writeFileSync(probe, [
      '#!/bin/bash',
      'set -euo pipefail',
      `printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\\n' \\
        "$HOME" "\${HTTPS_PROXY-unset}" "\${SSL_CERT_FILE-unset}" \\
        "\${GIT_CONFIG_COUNT-unset}" "\${CODEX_NON_INTERACTIVE-unset}" \\
        "$(/usr/bin/stat -f '%Lp' "$CURL_HOME")" "$(/bin/ls -A "$CURL_HOME")" \\
        "$(/usr/bin/stat -f '%Lp' "$XDG_CONFIG_HOME")" "$(/bin/ls -A "$XDG_CONFIG_HOME")" \\
        > ${JSON.stringify(report)}`,
      '',
    ].join('\n'), { mode: 0o700 })
    try {
      const source = readFileSync(bootstrap, 'utf8')
      const isolatedCommand = source.slice(
        source.indexOf('isolated_network_command()'),
        source.indexOf('install_homebrew()'),
      )
      const harness = join(dir, 'harness.sh')
      writeFileSync(harness, [
        '#!/bin/bash',
        'set -euo pipefail',
        'fail() { echo "$1" >&2; exit 1; }',
        isolatedCommand,
        `isolated_network_command CODEX_NON_INTERACTIVE=true ${JSON.stringify(probe)}`,
        '',
      ].join('\n'), { mode: 0o700 })
      const result = Bun.spawnSync([harness], {
        env: {
          ...process.env,
          HOME: fakeHome,
          HTTPS_PROXY: 'https://attacker.invalid',
          SSL_CERT_FILE: join(dir, 'attacker-ca.pem'),
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'url.https://attacker.invalid/.insteadOf',
          GIT_CONFIG_VALUE_0: 'https://github.com/',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(readFileSync(report, 'utf8').trim()).toBe(
        `${fakeHome}|unset|unset|unset|true|700||700|`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('単体download validatorは相対依存なしで既存cloneを検証できる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-standalone-validator-'))
    const repo = join(dir, 'zero')
    const standalone = join(dir, 'validate-update-repo.ts')
    try {
      Bun.spawnSync(['git', 'init', '--initial-branch=main', repo])
      Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'https://github.com/zerocolored/zero-codex.git'])
      writeFileSync(standalone, readFileSync(join(import.meta.dir, 'validate-update-repo.ts'), 'utf8'))
      const result = Bun.spawnSync(['bun', standalone, repo, 'main'], {
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
      'remote_matches_slug zerocolored/zero-codex https://github.com/zerocolored/zero-codex.git',
      '! remote_matches_slug zerocolored/zero-codex https://github.com/evil/zerocolored/zero-codex.git',
      '! remote_matches_slug zerocolored/zero-codex git@github.com:evil/zerocolored/zero-codex.git',
    ].join('; ')
    const result = Bun.spawnSync(['/bin/bash', '-c', command, 'bash', bootstrap])
    expect(result.exitCode).toBe(0)
  })

  test('safe_gitはambient Git config injectionを継承しない', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-git-env-'))
    try {
      const command = [
        'bootstrap_path="$1"',
        'set --',
        'source "$bootstrap_path"',
        'if safe_git config --get url.https://attacker.invalid/repo.git.insteadOf; then exit 90; fi',
      ].join('; ')
      const result = Bun.spawnSync(['/bin/bash', '-c', command, 'bash', bootstrap], {
        env: {
          ...process.env,
          HOME: fakeHome,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'url.https://attacker.invalid/repo.git.insteadOf',
          GIT_CONFIG_VALUE_0: 'https://github.com/zerocolored/zero-codex.git',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).not.toContain('zero-codex')
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
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
      Bun.spawnSync(['git', 'init', '--initial-branch=main', repo])
      Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'https://github.com/zerocolored/zero-codex.git'])
      writeFileSync(helper, `#!/bin/bash\ntouch '${marker}'\n`, { mode: 0o700 })
      Bun.spawnSync(['git', '-C', repo, 'config', 'core.fsmonitor', helper])
      const command = [
        'bootstrap_path="$1"',
        'target_repo="$2"',
        'set --',
        'source "$bootstrap_path"',
        'ensure_repo zerocolored/zero-codex "$target_repo" main',
      ].join('; ')
      const patchedBootstrap = bootstrapWithTestCurl(dir)
      const result = Bun.spawnSync([
        '/bin/bash', '-c', command, 'bash', patchedBootstrap, repo,
      ], { stdout: 'pipe', stderr: 'pipe' })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('Git設定またはoriginが安全ではありません')
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('既存main cloneを安全にorigin/mainへfast-forwardする', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-main-fast-forward-'))
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
      mkdirSync(join(seed, 'zerokun'), { recursive: true })
      writeFileSync(join(seed, 'zerokun', 'setup.sh'), '# safe update delegate\n--setup-supervisor\n')
      writeFileSync(join(seed, 'version.txt'), 'main-v1\n')
      run(['git', 'add', '.'], seed)
      run(['git', 'commit', '-m', 'main v1'], seed)
      run(['git', 'remote', 'add', 'origin', bare], seed)
      run(['git', 'push', '-u', 'origin', 'main'], seed)
      run(['git', 'clone', '--branch', 'main', bare, repo])
      writeFileSync(join(seed, 'version.txt'), 'main-v2\n')
      run(['git', 'commit', '-am', 'main v2'], seed)
      run(['git', 'push', 'origin', 'main'], seed)
      run(['git', 'remote', 'set-url', 'origin', 'https://github.com/zerocolored/zero-codex.git'], repo)

      const command = [
        'bootstrap_path="$1"',
        'target_repo="$2"',
        'set --',
        'source "$bootstrap_path"',
        'ensure_repo zerocolored/zero-codex "$target_repo" main',
      ].join('; ')
      const fakePath = localRemoteGitTestPath(dir, bare)
      const fakeGitPath = join(fakePath.split(':')[0]!, 'git')
      const fakeCurlPath = validatorCurlTestBin(dir)
      const patchedBootstrap = join(dir, 'bootstrap-macos.sh')
      writeFileSync(
        patchedBootstrap,
        readFileSync(bootstrap, 'utf8')
          .replaceAll('/usr/bin/git', fakeGitPath)
          .replaceAll('/usr/bin/curl', fakeCurlPath),
        { mode: 0o700 },
      )
      const result = Bun.spawnSync([
        '/bin/bash', '-c', command, 'bash', patchedBootstrap, repo,
      ], {
        env: { ...process.env, PATH: fakePath },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(run(['git', 'branch', '--show-current'], repo)).toBe('main')
      expect(run(['git', 'rev-parse', 'HEAD'], repo)).toBe(run(['git', 'rev-parse', 'origin/main'], repo))
      expect(run(['git', 'config', 'branch.main.remote'], repo)).toBe('origin')
      expect(run(['git', 'config', 'branch.main.merge'], repo)).toBe('refs/heads/main')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('atomic setup delegate前の既存cloneはfetchせず別repo-dirを要求する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-old-checkout-'))
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
      writeFileSync(join(seed, 'version.txt'), 'old-v1\n')
      run(['git', 'add', '.'], seed)
      run(['git', 'commit', '-m', 'old v1'], seed)
      run(['git', 'remote', 'add', 'origin', bare], seed)
      run(['git', 'push', '-u', 'origin', 'main'], seed)
      run(['git', 'clone', '--branch', 'main', bare, repo])
      const originalHead = run(['git', 'rev-parse', 'HEAD'], repo)
      writeFileSync(join(seed, 'version.txt'), 'new-v2\n')
      run(['git', 'commit', '-am', 'new v2'], seed)
      run(['git', 'push', 'origin', 'main'], seed)
      run(['git', 'remote', 'set-url', 'origin', 'https://github.com/zerocolored/zero-codex.git'], repo)

      const command = [
        'bootstrap_path="$1"',
        'target_repo="$2"',
        'set --',
        'source "$bootstrap_path"',
        'ensure_repo zerocolored/zero-codex "$target_repo" main',
      ].join('; ')
      const fakePath = localRemoteGitTestPath(dir, bare)
      const fakeGitPath = join(fakePath.split(':')[0]!, 'git')
      const fakeCurlPath = validatorCurlTestBin(dir)
      const patchedBootstrap = join(dir, 'bootstrap-macos.sh')
      writeFileSync(
        patchedBootstrap,
        readFileSync(bootstrap, 'utf8')
          .replaceAll('/usr/bin/git', fakeGitPath)
          .replaceAll('/usr/bin/curl', fakeCurlPath),
        { mode: 0o700 },
      )
      const result = Bun.spawnSync([
        '/bin/bash', '-c', command, 'bash', patchedBootstrap, repo,
      ], {
        env: { ...process.env, PATH: fakePath },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('空の別directoryを--repo-dir')
      expect(run(['git', 'rev-parse', 'HEAD'], repo)).toBe(originalHead)
      expect(run(['git', 'rev-parse', 'refs/remotes/origin/main'], repo)).toBe(originalHead)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('dirtyな既存main cloneでは旧branchのsetupへ進まず停止する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zerokun-bootstrap-dirty-main-'))
    const repo = join(dir, 'zero')
    try {
      Bun.spawnSync(['git', 'init', '--initial-branch=main', repo])
      Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'https://github.com/zerocolored/zero-codex.git'])
      writeFileSync(join(repo, 'uncommitted.txt'), 'preserve\n')
      const command = [
        'bootstrap_path="$1"',
        'target_repo="$2"',
        'set --',
        'source "$bootstrap_path"',
        'ensure_repo zerocolored/zero-codex "$target_repo" main',
      ].join('; ')
      const patchedBootstrap = bootstrapWithTestCurl(dir)
      const result = Bun.spawnSync([
        '/bin/bash', '-c', command, 'bash', patchedBootstrap, repo,
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
    expect(calls).toContain('configure_slack run_setup')
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
    expect(setup).toContain('/usr/bin/env -i')
    expect(setup).toContain('BUN_INSTALL_CACHE_DIR="$INSTALL_ENV_ROOT/bun-cache"')
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
      writeFileSync(tokenFile, 'SLACK_BOT_TOKEN=xoxb-existing-not-a-real-token\nSLACK_APP_TOKEN=xapp-1-A0123456789-existing-not-a-real-token\n')
      writeFileSync(join(fakeHome, '.zshrc'), 'export EXISTING=1\n', { mode: 0o600 })

      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_PROJECT_DIR: projectDir,
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
          PATH: setupTestPath(fakeHome),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode).toBe(0)
      expect(result.stderr.toString()).not.toContain('No such file or directory')
      const zshrc = readFileSync(join(fakeHome, '.zshrc'), 'utf8')
      expect(zshrc).toContain(`export ZEROKUN_PROJECT_DIR=${projectDir.replace(' ', '\\ ')}`)
      expect(zshrc).toContain(
        `export ZEROKUN_STATE_DIR=${realpathSync(stateDir).replaceAll(' ', '\\ ')}`,
      )
      expect(zshrc).toContain('export ZEROKUN_LEGACY_CUTOVER=0')
      expect(zshrc).toContain('codex-channel "$ZEROKUN_PROJECT_DIR"')
      expect(statSync(join(fakeHome, '.zshrc')).mode & 0o777).toBe(0o600)
      expect(readFileSync(
        join(fakeHome, 'Library/LaunchAgents/com.zerokun.watchdog.plist'),
        'utf8',
      )).toContain(`${realpathSync(stateDir)}/watchdog.sh`)
      expect(readFileSync(
        join(fakeHome, 'Library/LaunchAgents/com.zerokun.watchdog.plist'),
        'utf8',
      )).toContain(`<string>${realpathSync(stateDir)}</string>`)
      expect(readFileSync(tokenFile, 'utf8')).toBe(
        'SLACK_BOT_TOKEN=xoxb-existing-not-a-real-token\nSLACK_APP_TOKEN=xapp-1-A0123456789-existing-not-a-real-token\n',
      )
      const copiedWorker = Bun.spawnSync([
        process.execPath,
        '--no-install',
        join(stateDir, 'update-request.ts'),
      ], {
        cwd: projectDir,
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
          PATH: setupTestPath(fakeHome),
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
          PATH: setupTestPath(fakeHome),
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
    let claudeParent: Bun.Subprocess | undefined
    try {
      mkdirSync(join(stateDir, 'owner/claude-config/.git'), { recursive: true })
      mkdirSync(join(stateDir, 'owner/claude-skills/.git'), { recursive: true })
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(stateDir, '.env'), 'LEGACY_SENTINEL=keep\n')
      writeFileSync(fakeLaunchctl, '#!/bin/bash\nexit 42\n', { mode: 0o700 })
      claudeParent = Bun.spawn([
        '/bin/bash', '-c',
        'exec -a "claude --dangerously-load-development-channels server:slack-channel" /bin/sleep 30',
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })

      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_STATE_DIR: `${join(fakeHome, '.claude/channels/../channels/slack')}//`,
          ZEROKUN_LEGACY_CUTOVER: '0',
          SLACK_STATE_DIR: stateDir,
          ZEROKUN_PROJECT_DIR: projectDir,
          ZEROKUN_LAUNCHCTL_BIN: fakeLaunchctl,
          PATH: setupTestPath(fakeHome),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode).toBe(0)
      expect(result.stderr.toString()).toContain('watchdog のlaunchd登録に失敗')
      expect(existsSync(join(fakeHome, '.local/bin/zerokun-jobs'))).toBe(true)
      expect(readFileSync(join(fakeHome, '.zshrc'), 'utf8')).toContain("alias zerokun=")
      expect(readFileSync(join(stateDir, '.env'), 'utf8')).toBe('LEGACY_SENTINEL=keep\n')
      expect(existsSync(join(fakeHome, '.codex/zerokun/.env'))).toBe(true)
      expect(() => process.kill(claudeParent!.pid, 0)).not.toThrow()
    } finally {
      if (claudeParent) {
        try { claudeParent.kill() } catch {}
      }
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('存在しない標準legacy stateのcutoverは作成やClaude親停止より前に拒否する', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-missing-cutover-'))
    const stateDir = join(fakeHome, '.claude/channels/slack')
    const projectDir = join(fakeHome, 'project')
    let claudeParent: Bun.Subprocess | undefined
    try {
      claudeParent = Bun.spawn([
        '/bin/bash', '-c',
        'exec -a "claude --dangerously-load-development-channels server:slack-channel" /bin/sleep 30',
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_LEGACY_CUTOVER: '1',
          ZEROKUN_PROJECT_DIR: projectDir,
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('legacy cutover state')
      expect(existsSync(stateDir)).toBe(false)
      expect(() => process.kill(claudeParent!.pid, 0)).not.toThrow()
    } finally {
      if (claudeParent) {
        try { claudeParent.kill() } catch {}
      }
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('重複行で実効tokenが空になるlegacy .envはClaude親停止より前に拒否する', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-empty-cutover-'))
    const stateDir = join(fakeHome, '.claude/channels/slack')
    let claudeParent: Bun.Subprocess | undefined
    try {
      mkdirSync(stateDir, { recursive: true })
      const ambiguousEnvironment = [
        'SLACK_BOT_TOKEN=xoxb-valid-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-A0123456789-valid-not-a-real-token',
        'SLACK_BOT_TOKEN=',
        'SLACK_APP_TOKEN=',
        '',
      ].join('\n')
      writeFileSync(join(stateDir, '.env'), ambiguousEnvironment, { mode: 0o600 })
      claudeParent = Bun.spawn([
        '/bin/bash', '-c',
        'exec -a "claude --dangerously-load-development-channels server:slack-channel" /bin/sleep 30',
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_LEGACY_CUTOVER: '1',
          ZEROKUN_PROJECT_DIR: join(fakeHome, 'project'),
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('legacy cutover state')
      expect(readFileSync(join(stateDir, '.env'), 'utf8')).toBe(ambiguousEnvironment)
      expect(() => process.kill(claudeParent!.pid, 0)).not.toThrow()
    } finally {
      if (claudeParent) {
        try { claudeParent.kill() } catch {}
      }
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('異なるSlack Appのtoken pairはcutover停止境界より前に拒否する', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-token-mismatch-cutover-'))
    const stateDir = join(fakeHome, '.claude/channels/slack')
    const stopProbe = join(fakeHome, 'cutover-stop-reached')
    let claudeParent: Bun.Subprocess | undefined
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, '.env'), [
        'SLACK_BOT_TOKEN=xoxb-valid-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-ANEWAPP123-abcdefghijklmnopqrstuvwxyz',
        '',
      ].join('\n'), { mode: 0o600 })
      claudeParent = Bun.spawn([
        '/bin/bash', '-c',
        'exec -a "claude --dangerously-load-development-channels server:slack-channel" /bin/sleep 30',
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_LEGACY_CUTOVER: '1',
          PATH: setupTestPath(fakeHome, 'AOLDAPP123'),
          ZEROKUN_PROJECT_DIR: join(fakeHome, 'project'),
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('different Slack Apps')
      expect(existsSync(stopProbe)).toBe(false)
      expect(existsSync(join(stateDir, '.codex-legacy-cutover'))).toBe(false)
      expect(() => process.kill(claudeParent!.pid, 0)).not.toThrow()
    } finally {
      if (claudeParent) {
        try { claudeParent.kill() } catch {}
      }
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('通常の再setupも異なるSlack App tokenをgateway停止前に拒否する', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-token-mismatch-normal-'))
    const stateDir = join(fakeHome, '.codex/zerokun')
    const stopProbe = join(fakeHome, 'normal-stop-reached')
    let gateway: Bun.Subprocess | undefined
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, '.env'), [
        'SLACK_BOT_TOKEN=xoxb-valid-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-ANEWAPP123-abcdefghijklmnopqrstuvwxyz',
        '',
      ].join('\n'), { mode: 0o600 })
      const server = join(stateDir, 'server.ts')
      writeFileSync(server, '#!/bin/bash\nwhile :; do sleep 1; done\n', { mode: 0o700 })
      gateway = Bun.spawn(['/bin/bash', server], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      })
      writeFileSync(join(stateDir, 'plugin.lock'), `${gateway.pid}\n`, { mode: 0o600 })
      const started = Bun.spawnSync(['/bin/ps', '-o', 'lstart=', '-p', String(gateway.pid)], {
        stdout: 'pipe',
      }).stdout.toString().trim()
      writeFileSync(join(stateDir, 'plugin.lock.identity'), JSON.stringify({
        pid: gateway.pid, started, nonce: '12345678-1234-4123-8123-123456789abc',
      }), { mode: 0o600 })

      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_STATE_DIR: stateDir,
          PATH: setupTestPath(fakeHome, 'AOLDAPP123'),
          ZEROKUN_PROJECT_DIR: join(fakeHome, 'project'),
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('different Slack Apps')
      expect(result.stderr.toString()).toContain('processは停止しません')
      expect(existsSync(stopProbe)).toBe(false)
      expect(() => process.kill(gateway!.pid, 0)).not.toThrow()
    } finally {
      if (gateway) {
        try { gateway.kill() } catch {}
      }
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('legacy DB symlinkはClaude親停止より前に拒否する', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-db-symlink-cutover-'))
    const stateDir = join(fakeHome, '.claude/channels/slack')
    const externalDb = join(fakeHome, 'external.sqlite3')
    const stopProbe = join(fakeHome, 'cutover-stop-reached')
    let claudeParent: Bun.Subprocess | undefined
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, '.env'), [
        'SLACK_BOT_TOKEN=xoxb-valid-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-A0123456789-not-a-real-token',
        '',
      ].join('\n'), { mode: 0o600 })
      writeFileSync(externalDb, 'preserve', { mode: 0o600 })
      symlinkSync(externalDb, join(stateDir, 'jobs.sqlite3'))
      claudeParent = Bun.spawn([
        '/bin/bash', '-c',
        'exec -a "claude --dangerously-load-development-channels server:slack-channel" /bin/sleep 30',
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_LEGACY_CUTOVER: '1',
          PATH: setupTestPath(fakeHome),
          ZEROKUN_PROJECT_DIR: join(fakeHome, 'project'),
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('unsafe SQLite file')
      expect(readFileSync(externalDb, 'utf8')).toBe('preserve')
      expect(existsSync(stopProbe)).toBe(false)
      expect(() => process.kill(claudeParent!.pid, 0)).not.toThrow()
    } finally {
      if (claudeParent) {
        try { claudeParent.kill() } catch {}
      }
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('初回cutover markerにより.claude alias削除後もphysical stateで再setupできる', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-established-cutover-'))
    const physicalClaude = join(fakeHome, 'config/claude-home')
    const physicalState = join(physicalClaude, 'channels/slack')
    const logicalState = join(fakeHome, '.claude/channels/slack')
    const projectDir = join(fakeHome, 'project')
    try {
      mkdirSync(physicalState, { recursive: true })
      mkdirSync(projectDir, { recursive: true })
      symlinkSync(physicalClaude, join(fakeHome, '.claude'))
      writeFileSync(join(physicalState, '.env'), [
        'SLACK_BOT_TOKEN=xoxb-established-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-A0123456789-established-not-a-real-token',
        '',
      ].join('\n'), { mode: 0o600 })
      const baseEnvironment = {
        ...process.env,
        HOME: fakeHome,
        ZEROKUN_LEGACY_CUTOVER: '1',
        PATH: setupTestPath(fakeHome),
        ZEROKUN_PROJECT_DIR: projectDir,
        ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
      }
      const first = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: { ...baseEnvironment, ZEROKUN_STATE_DIR: logicalState },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(first.exitCode, first.stderr.toString()).toBe(0)
      expect(readFileSync(join(physicalState, '.codex-legacy-cutover'), 'utf8'))
        .toBe(`zerokun-codex-legacy-cutover-v1\n${realpathSync(physicalState)}\n`)

      rmSync(join(fakeHome, '.claude'))
      const second = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: { ...baseEnvironment, ZEROKUN_STATE_DIR: physicalState },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(second.exitCode, second.stderr.toString()).toBe(0)
      expect(readFileSync(join(fakeHome, '.zshrc'), 'utf8'))
        .toContain(`export ZEROKUN_STATE_DIR=${realpathSync(physicalState)}`)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('drain中にrunnerが自発終了しても古いPIDへsignalせずsetupを完了する', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-runner-self-exit-'))
    const stateDir = join(fakeHome, '.claude/channels/slack')
    const projectDir = join(fakeHome, 'project')
    let legacyRunner: Bun.Subprocess | undefined
    try {
      mkdirSync(join(stateDir, 'job-runner.lock'), { recursive: true })
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(stateDir, '.env'), [
        'SLACK_BOT_TOKEN=xoxb-self-exit-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-A0123456789-self-exit-not-a-real-token',
        '',
      ].join('\n'), { mode: 0o600 })
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
          1, 'self-exit-job', 'C:self-exit', 'C', '1', '1', 'U', '/tmp/project', 'pending',
          'running', 'claude-session', 0, 'legacy-worker', 1, NULL, NULL, 1, 2, NULL
        );
      `)
      legacyDb.close()
      const legacyPath = join(stateDir, 'job-runner.ts')
      const updateScript = [
        'import { Database } from "bun:sqlite"',
        `const db = new Database(${JSON.stringify(dbPath)})`,
        'db.run("UPDATE jobs SET status = ? WHERE id = ?", ["queued", "self-exit-job"])',
        'db.close()',
      ].join('; ')
      writeFileSync(legacyPath, [
        '#!/bin/bash',
        'sleep 3',
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(updateScript)}`,
        'exit 0',
        '',
      ].join('\n'), { mode: 0o700 })
      legacyRunner = Bun.spawn(['/bin/bash', legacyPath, 'daemon'], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      })
      writeFileSync(join(stateDir, 'job-runner.lock/pid'), `${legacyRunner.pid}\n`)

      const setup = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          PATH: setupTestPath(fakeHome),
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_LEGACY_CUTOVER: '1',
          ZEROKUN_PROJECT_DIR: projectDir,
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
          ZEROKUN_SETUP_DRAIN_SECONDS: '10',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(setup.exitCode, setup.stderr.toString()).toBe(0)
      expect(setup.stdout.toString()).toContain('▶ Codex版standalone setup')
      expect(await legacyRunner.exited).toBe(0)
    } finally {
      if (legacyRunner) {
        try { legacyRunner.kill() } catch {}
        try { await legacyRunner.exited } catch {}
      }
      rmSync(fakeHome, { recursive: true, force: true })
    }
  }, 30_000)

  test('Claude版runnerを停止し、待機jobをsessionなしのCodex queueへcutoverする', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-cutover-'))
    const stateDir = join(fakeHome, '.claude/channels/slack')
    const projectDir = join(fakeHome, 'Work/BellSalesAI')
    let legacyRunner: Bun.Subprocess | undefined
    let legacyGateway: Bun.Subprocess | undefined
    try {
      mkdirSync(join(stateDir, 'job-runner.lock'), { recursive: true })
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(stateDir, '.env'), [
        'SLACK_BOT_TOKEN=xoxb-cutover-not-a-real-token',
        'SLACK_APP_TOKEN=xapp-1-A0123456789-cutover-not-a-real-token',
        '',
      ].join('\n'), { mode: 0o600 })
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
          ZEROKUN_STATE_DIR: `${join(fakeHome, '.claude/channels/../channels/slack')}/`,
          ZEROKUN_LEGACY_CUTOVER: '1',
          PATH: setupTestPath(fakeHome),
          ZEROKUN_PROJECT_DIR: projectDir,
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(setup.exitCode, setup.stderr.toString()).toBe(0)
      expect(setup.stdout.toString()).toContain('▶ Codex版standalone setup')
      await Promise.all([legacyRunner.exited, legacyGateway.exited])

      const runtimeInfo = Bun.spawnSync([
        process.execPath,
        join(root, 'zerokun/job-runner.ts'),
        'runtime-info',
      ], {
        env: {
          ...process.env,
          ZEROKUN_STATE_DIR: stateDir,
          ZEROKUN_LEGACY_CUTOVER: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(runtimeInfo.exitCode, runtimeInfo.stderr.toString()).toBe(0)
      expect(JSON.parse(runtimeInfo.stdout.toString())).toMatchObject({ runtime: 'codex' })
      const migrated = new Database(dbPath, { readonly: true })
      expect(migrated.query('SELECT runtime, status, session_id FROM jobs WHERE id = ?')
        .get('legacy-job')).toEqual({ runtime: 'codex', status: 'queued', session_id: null })
      migrated.close()

    } finally {
      for (const child of [legacyRunner, legacyGateway]) {
        if (!child) continue
        try { child.kill() } catch {}
        try { await child.exited } catch {}
      }
      rmSync(fakeHome, { recursive: true, force: true })
    }
  }, 30_000)
})
