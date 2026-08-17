import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
    expect(script).toContain('zerokun/setup.sh')
    expect(script).toContain('slack-app-manifest.yaml')
    expect(script).toContain('connections:write')
    expect(script).toContain('https://api.slack.com/apps?new_app=1')
    expect(script).toContain('Slack Appの表示名')
    expect(script).toContain('Slack bot username')
    expect(script).toContain('xoxb-[A-Za-z0-9-]{10,}')
    expect(script).toContain('xapp-[A-Za-z0-9-]{10,}')
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
        env: { ...process.env, HOME: fakeHome, ZEROKUN_PROJECT_DIR: projectDir },
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
})
