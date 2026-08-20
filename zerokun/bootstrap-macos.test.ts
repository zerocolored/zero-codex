import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('Command Line Tools:')
      expect(result.stdout.toString()).toContain('Claude Code:')
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
  const codexHomeProbe = (report: string) =>
    [
      '#!/bin/sh',
      `printf '%s\\n' "\${CODEX_HOME:-unset}" > '${report}'`,
      `if [ -d "\${CODEX_HOME:-/nonexistent}" ]; then printf 'dir=yes\\n' >> '${report}'; fi`,
      'echo "codex-cli 0.0.0-test"',
      '',
    ].join('\n')

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
      expect(seen[0].startsWith(fakeHome)).toBe(false)
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
      expect(seen[0].startsWith(fakeHome)).toBe(false)
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
      writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\necho "boom" >&2\nexit 3\n', { mode: 0o755 })
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
    expect(script).toContain('brew install gh tmux')
    expect(script).toContain('brew install --cask claude-code codex')
    expect(script).toContain('claude auth login')
    expect(script).toContain('codex login')
    expect(script).toContain('gh auth login')
    expect(script).toContain('zerocolored/zero')
    expect(script).toContain('zerocolored/skills')
    expect(script).toContain('scripts/bootstrap-mac.sh')
    expect(script).toContain('ensure_repo zerocolored/skills "$PROJECT_DIR" develop')
    expect(script).toContain('ensure_repo zerocolored/bsb_front "$PROJECT_DIR/bsb_front" develop')
    expect(script).toContain('zerokun/setup.sh')
    expect(script).toContain('slack-app-manifest.yaml')
    expect(script).toContain('connections:write')
    expect(script).toContain('https://api.slack.com/apps?new_app=1')
    expect(script).toContain('Slack Appの表示名')
    expect(script).toContain('Slack bot username')
    expect(script).toContain('xoxb-[A-Za-z0-9._-]{10,}')
    expect(script).toContain('xapp-[A-Za-z0-9._-]{10,}')
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
      'run_setup() { calls="$calls run_setup"; }',
      'run_project_bootstrap() { calls="$calls run_project_bootstrap"; }',
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
    expect(output).toContain('Claude Codeを利用できます')
    expect(output).toContain('run_setup run_project_bootstrap run_doctor')
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
      'run_setup() { calls="$calls run_setup"; }',
      'run_project_bootstrap() { calls="$calls run_project_bootstrap"; }',
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
    expect(calls).not.toContain('run_project_bootstrap')
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
      '- message.im',
      '- message.channels',
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

  test('launcher and setup use HOME-based project paths instead of one Mac username', () => {
    const launcher = readFileSync(join(root, 'claude-channel.sh'), 'utf8')
    const setup = readFileSync(join(import.meta.dir, 'setup.sh'), 'utf8')
    expect(launcher).toContain('${ZEROKUN_PROJECT_DIR:-$HOME/Desktop/Project/BellSalsesAI}')
    expect(launcher).not.toContain('/Users/zerocolored-macpro-suetsugu')
    expect(setup).toContain('ZEROKUN_PROJECT_DIR')
  })

  test('setup wires a custom project path and preserves an existing token file', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'zerokun-setup-home-'))
    const stateDir = join(fakeHome, '.claude/channels/slack')
    const projectDir = join(fakeHome, 'Work/BellSalesAI custom')
    const tokenFile = join(stateDir, '.env')
    try {
      mkdirSync(join(stateDir, 'owner/claude-config/.git'), { recursive: true })
      mkdirSync(join(stateDir, 'owner/claude-skills/.git'), { recursive: true })
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(tokenFile, 'SLACK_BOT_TOKEN=xoxb-existing\nSLACK_APP_TOKEN=xapp-existing\n')

      const result = Bun.spawnSync(['/bin/bash', join(import.meta.dir, 'setup.sh')], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ZEROKUN_PROJECT_DIR: projectDir,
          ZEROKUN_SKIP_WATCHDOG_LAUNCHD: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode).toBe(0)
      const zshrc = readFileSync(join(fakeHome, '.zshrc'), 'utf8')
      expect(zshrc).toContain(`export ZEROKUN_PROJECT_DIR=${projectDir.replace(' ', '\\ ')}`)
      expect(zshrc).toContain('claude-channel "$ZEROKUN_PROJECT_DIR"')
      expect(readFileSync(tokenFile, 'utf8')).toBe(
        'SLACK_BOT_TOKEN=xoxb-existing\nSLACK_APP_TOKEN=xapp-existing\n',
      )
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
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
})
