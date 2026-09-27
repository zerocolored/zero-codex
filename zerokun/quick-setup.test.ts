import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-quick-setup-'))); roots.push(root)
  const repo = join(root, 'zero'); const scripts = join(repo, 'zerokun')
  const home = join(root, 'home'); const bin = join(home, '.local/bin')
  const project = join(root, 'project with spaces'); const mcp = join(root, 'mcp "quoted" \\ path')
  for (const path of [scripts, bin, project, join(mcp, '.git'), join(home, '.codex'), join(home, 'Library/Application Support/Google/Chrome/Default')]) mkdirSync(path, { recursive: true, mode: 0o700 })
  copyFileSync(join(import.meta.dir, 'quick-setup.sh'), join(scripts, 'quick-setup.sh'))
  const log = join(root, 'calls.jsonl')
  const spy = `#!/usr/bin/python3
import json,os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
with open(os.environ['ZERO_QUICK_LOG'],'a') as f: f.write(json.dumps({'name':name,'args':sys.argv[1:],'cwd':os.getcwd(),'path':os.environ.get('PATH')})+'\\n')
if name=='npm':
 if os.environ.get('ZERO_NPM_FAIL')=='1': sys.exit(17)
 if sys.argv[1:2]==['install']: Path('node_modules').mkdir(exist_ok=True)
if name=='codex':
 present=Path(os.environ['CODEX_HOME'])/'mcp-present'
 if sys.argv[1:3]==['mcp','get']: sys.exit(0 if present.exists() else 1)
 if sys.argv[1:3]==['mcp','add']: present.touch()
if name=='sqlite3': sys.exit(1)
if name=='brew': Path(os.environ['ZERO_NODE_INSTALLED']).touch()
if name=='zerochan' and sys.argv[1:3]==['set','slack-channel'] and os.environ.get('ZERO_CHANNEL_FAIL')=='1': sys.exit(12)
if name=='bootstrap' and '--project-dir' in sys.argv:
 Path(sys.argv[sys.argv.index('--project-dir')+1]).mkdir(parents=True,exist_ok=True)
if name=='bootstrap' and '--doctor' in sys.argv and os.environ.get('ZERO_DOCTOR_FAIL')=='1': sys.exit(9)
`
  for (const name of ['bootstrap', 'codex', 'claude', 'grok', 'gh', 'node', 'npm', 'brew', 'zerochan', 'herdr', 'open', 'pbcopy', 'sudo', 'sqlite3']) writeFileSync(join(bin, name), spy, { mode: 0o700 })
  writeFileSync(join(scripts, 'bootstrap-macos.sh'), '#!/bin/bash\nexec "$HOME/.local/bin/bootstrap" "$@"\n')
  writeFileSync(join(mcp, 'mcp-broker.js'), '// synthetic broker\n')
  writeFileSync(join(mcp, 'package.json'), '{}\n')
  const env = { HOME: home, CODEX_HOME: join(home, '.codex'), PATH: '/usr/bin:/bin', GO_CHROME_MCP_DIR: mcp, ZERO_QUICK_LOG: log, ZERO_NODE_INSTALLED: join(root, 'node-installed') }
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { name: string, args: string[], cwd: string, path: string }) : []
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const result = Bun.spawnSync(['/bin/bash', join(scripts, 'quick-setup.sh'), ...args], { cwd: repo, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe' })
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
  }
  const base = ['--project', project, '--skip-codex-config', '--skip-permissions', '--skip-chrome', '--no-wait']
  return { root, repo, home, project, mcp, bin, env, base, run, calls }
}

describe('quick setup', () => {
  test('fresh PATHでCLIを解決しrepo/projectを両bootstrapへ引き継ぐ', () => {
    const f = fixture()
    const result = f.run([...f.base, '--channel', 'C123', '--skip-go-chrome-mcp'])
    expect(result.code).toBe(0)
    const calls = f.calls()
    const bootstrap = calls.filter(c => c.name === 'bootstrap')
    expect(bootstrap).toHaveLength(2)
    for (const call of bootstrap) {
      expect(call.args).toContain('--repo-dir'); expect(call.args).toContain(f.repo)
      expect(call.args).toContain('--project-dir'); expect(call.args).toContain(f.project)
    }
    expect(calls.find(c => c.name === 'zerochan' && c.args[0] === 'start')?.cwd).toBe(f.project)
  })
  test('invalid projectは導入や設定変更前に拒否する', () => {
    const f = fixture()
    const invalid = join(f.root, 'not-directory'); writeFileSync(invalid, 'keep')
    expect(f.run(['--project', invalid]).code).toBe(1)
    expect(f.calls()).toEqual([])
  })
  test('project省略時もbootstrap既定の新規workspaceから起動する', () => {
    const f = fixture()
    const expected = join(f.root, 'zerokun-workspace')
    expect(f.run(['--skip-codex-config', '--skip-permissions', '--skip-chrome', '--skip-go-chrome-mcp', '--skip-slack', '--no-wait']).code).toBe(0)
    expect(f.calls().find(c => c.name === 'bootstrap')?.args).toContain(expected)
    expect(f.calls().find(c => c.name === 'zerochan' && c.args[0] === 'start')?.cwd).toBe(expected)
  })
  test('channel紐付け失敗を成功扱いして起動しない', () => {
    const f = fixture()
    expect(f.run([...f.base, '--channel', 'C123', '--skip-go-chrome-mcp'], { ZERO_CHANNEL_FAIL: '1' }).code).toBe(1)
    expect(f.calls().some(c => c.name === 'zerochan' && c.args[0] === 'start')).toBe(false)
  })
  test('doctorは拡張未読込みでもclipboard/open/MCP登録/設定writeを行わない', () => {
    const f = fixture()
    writeFileSync(join(f.home, '.claude.json'), '{"custom":"preserve"}')
    expect(f.run(['--doctor', '--no-wait']).code).toBe(0)
    expect(f.calls().filter(c => ['pbcopy', 'open', 'sudo', 'npm', 'brew', 'zerochan'].includes(c.name))).toEqual([])
    expect(f.calls().some(c => c.name === 'codex' && c.args[1] === 'add')).toBe(false)
    expect(readFileSync(join(f.home, '.claude.json'), 'utf8')).toBe('{"custom":"preserve"}')
    expect(readdirSync(f.home).some(n => n.startsWith('.claude.json.backup-'))).toBe(false)
  })
  test('doctorのbootstrapは呼び出し元PATHのまま診断する', () => {
    const f = fixture()
    expect(f.run(['--doctor', '--skip-permissions', '--skip-chrome', '--skip-go-chrome-mcp']).code).toBe(0)
    expect(f.calls().find(c => c.name === 'bootstrap')?.path).toBe('/usr/bin:/bin')
  })
  test('doctorはproject scopeだけのMCPをglobal登録済みと誤認しない', () => {
    const f = fixture()
    writeFileSync(join(f.home, '.claude.json'), JSON.stringify({ projects: { '/p': { mcpServers: { 'go-chrome-mcp': {} } } } }))
    const result = f.run(['--doctor', '--skip-permissions', '--skip-chrome'])
    expect(result.code).toBe(0)
    expect(result.output).toContain('Claude Code: 未登録')
  })
  test('policy書込みだけで拡張の強制導入成功と断定しない', () => {
    const f = fixture()
    const result = f.run([...f.base.filter(arg => arg !== '--skip-chrome'), '--skip-go-chrome-mcp', '--force-extensions'])
    expect(result.code).toBe(0)
    expect(result.output).not.toContain('Chrome再起動で入ります')
    expect(result.output).toContain('強制導入の適用は未確認')
  })
  test('doctorはbootstrap診断の失敗をexit statusに保持する', () => {
    const f = fixture()
    expect(f.run(['--doctor', '--no-wait'], { ZERO_DOCTOR_FAIL: '1' }).code).toBe(1)
    expect(f.calls().some(c => ['open', 'pbcopy', 'zerochan'].includes(c.name))).toBe(false)
  })
  test.each([false, true])('npm失敗時は両MCP設定を書かず起動しない: existing=%s', existing => {
    const f = fixture()
    if (existing) mkdirSync(join(f.mcp, 'node_modules'))
    expect(f.run(f.base, { ZERO_NPM_FAIL: '1' }).code).toBe(1)
    expect(existsSync(join(f.home, '.claude.json'))).toBe(false)
    expect(f.calls().some(c => c.name === 'codex' || c.name === 'zerochan')).toBe(false)
  })
  test('不正なChrome拡張IDは副作用前に拒否する', () => {
    const f = fixture()
    expect(f.run(['--chrome-extension', 'invalid;https://example.invalid']).code).toBe(2)
    expect(f.calls()).toEqual([])
  })
  test.each([0, 1])('unpacked拡張は有効状態も検証する: state=%s', state => {
    const f = fixture()
    writeFileSync(join(f.home, 'Library/Application Support/Google/Chrome/Default/Secure Preferences'),
      JSON.stringify({ extensions: { settings: { example: { path: f.mcp, location: 4, state } } } }))
    const result = f.run(['--doctor', '--skip-permissions', '--skip-chrome'])
    expect(result.code).toBe(0)
    expect(result.output.includes('Chrome拡張: 読み込み済み')).toBe(state === 1)
    expect(f.calls().some(c => c.name === 'pbcopy')).toBe(false)
  })
  test('MCP登録は他設定とbackupを保持し特殊文字pathをargvとして渡す', () => {
    const f = fixture()
    const before = JSON.stringify({ custom: 'preserve', mcpServers: { other: { command: 'other' } } })
    writeFileSync(join(f.home, '.claude.json'), before)
    const outside = join(f.root, 'old-backup'); writeFileSync(outside, 'untouched')
    symlinkSync(outside, join(f.home, '.claude.json.bak'))
    expect(f.run(f.base).code).toBe(0)
    const after = JSON.parse(readFileSync(join(f.home, '.claude.json'), 'utf8'))
    expect(after.custom).toBe('preserve'); expect(after.mcpServers.other).toEqual({ command: 'other' })
    expect(after.mcpServers['go-chrome-mcp'].args).toEqual([join(f.mcp, 'mcp-broker.js')])
    expect(statSync(join(f.home, '.claude.json')).mode & 0o777).toBe(0o600)
    const backup = readdirSync(f.home).find(n => n.startsWith('.claude.json.backup-'))!
    expect(readFileSync(join(f.home, backup), 'utf8')).toBe(before)
    expect(statSync(join(f.home, backup)).mode & 0o777).toBe(0o600)
    expect(readFileSync(outside, 'utf8')).toBe('untouched')
    expect(f.calls().find(c => c.name === 'codex' && c.args[1] === 'add')?.args).toEqual(['mcp', 'add', 'go-chrome-mcp', '--', 'node', join(f.mcp, 'mcp-broker.js')])
    expect(f.run(f.base).code).toBe(0)
    expect(f.calls().filter(c => c.name === 'codex' && c.args[1] === 'add')).toHaveLength(1)
    expect(readdirSync(f.home).filter(n => n.startsWith('.claude.json.backup-'))).toHaveLength(1)
  })
  test('force extensionsは個別IDを追加し既存policy全体を削除しない', () => {
    const f = fixture()
    expect(f.run([...f.base.filter(arg => arg !== '--skip-chrome'), '--skip-go-chrome-mcp', '--force-extensions']).code).toBe(0)
    const writes = f.calls().filter(c => c.name === 'sudo' && c.args[1] === 'write')
    expect(writes).toHaveLength(2)
    for (const call of writes) expect(call.args).toContain('-array-add')
    expect(f.calls().some(c => c.args.includes('delete'))).toBe(false)
  })
  test('既存MCP entryのdisabledや独自transportを両hostで保持する', () => {
    const f = fixture()
    const before = JSON.stringify({ mcpServers: { 'go-chrome-mcp': { type: 'http', url: 'https://example.invalid/mcp', enabled: false } } })
    writeFileSync(join(f.home, '.claude.json'), before)
    writeFileSync(join(f.home, '.codex/mcp-present'), '')
    expect(f.run(f.base).code).toBe(0)
    expect(readFileSync(join(f.home, '.claude.json'), 'utf8')).toBe(before)
    expect(f.calls().some(c => c.name === 'codex' && c.args[1] === 'add')).toBe(false)
  })
  test('本人操作が未確認の拡張を最後の案内にも残す', () => {
    const f = fixture()
    const result = f.run(f.base)
    expect(result.code).toBe(0)
    expect(result.output.split('== 残りの手動作業 ==')[1]).toContain('未確認: go-chrome-mcp拡張')
  })
  test('Claude設定symlinkは参照先を書き換えず拒否する', () => {
    const f = fixture(); const outside = join(f.root, 'outside.json')
    writeFileSync(outside, '{}'); symlinkSync(outside, join(f.home, '.claude.json'))
    expect(f.run(f.base).code).toBe(1)
    expect(readFileSync(outside, 'utf8')).toBe('{}')
    expect(f.calls().some(c => c.name === 'codex')).toBe(false)
  })
  test('不足Node runtimeは導入後にだけMCP登録へ進む', () => {
    const f = fixture(); const setup = join(f.root, 'bash-env')
    writeFileSync(setup, `command() { if [[ "$1" == -v && ( "$2" == node || "$2" == npm ) && ! -f "$ZERO_NODE_INSTALLED" ]]; then return 1; fi; builtin command "$@"; }\n`)
    expect(f.run(f.base, { BASH_ENV: setup }).code).toBe(0)
    const calls = f.calls(); expect(calls.find(c => c.name === 'brew')?.args).toEqual(['install', 'node'])
    expect(calls.findIndex(c => c.name === 'brew')).toBeLessThan(calls.findIndex(c => c.name === 'codex'))
  })
})
