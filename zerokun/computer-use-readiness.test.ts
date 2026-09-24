import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { computerUseReadiness } from './computer-use-readiness.ts'

function fixture(name: string): { root: string; home: string; project: string; app: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), name)))
  const home = join(root, 'codex')
  const project = join(root, 'project')
  const app = join(root, 'ChatGPT.app')
  mkdirSync(home)
  mkdirSync(project)
  return { root, home, project, app }
}

test('未導入のMacでは、導入先とTCCの付け先を名指しで案内する', () => {
  const { root, home, project, app } = fixture('cua-readiness-missing-')
  try {
    const result = computerUseReadiness(home, project, app)
    expect(result.ready).toBe(false)
    const text = result.lines.join('\n')
    expect(text).toContain(join(home, 'computer-use/Codex Computer Use.app'))
    expect(text).toContain(join(app, 'Contents/Resources/cua_node/bin/node_repl'))
    expect(text).toContain('Codex Computer Use')
    // ターミナル・Herdrへ権限を足しても有効にならないことを、案内自体に固定する。
    // 2026-09-25、この誤解で画面収録とアクセシビリティを別プロセスへ付けた。
    expect(text).toContain('ターミナル')
    expect(text).toContain('Herdr')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('native clientが入っていれば導入済みとして、実行時と同じpathを示す', () => {
  const { root, home, project, app } = fixture('cua-readiness-native-')
  const client = join(home, 'computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient')
  mkdirSync(dirname(client), { recursive: true })
  writeFileSync(client, 'fixture', { mode: 0o700 })
  try {
    const result = computerUseReadiness(home, project, app)
    expect(result.ready).toBe(true)
    expect(result.lines.join('\n')).toContain(client)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('ChatGPTアプリ同梱のnode_replだけでも導入済みとして扱う', () => {
  const { root, home, project, app } = fixture('cua-readiness-node-')
  const client = join(app, 'Contents/Resources/cua_node/bin/node_repl')
  mkdirSync(dirname(client), { recursive: true })
  writeFileSync(client, 'fixture', { mode: 0o700 })
  try {
    const result = computerUseReadiness(home, project, app)
    expect(result.ready).toBe(true)
    expect(result.lines.join('\n')).toContain(client)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setup.shは手動ステップでこの検査を実行する', () => {
  const source = readFileSync(join(import.meta.dir, 'setup.sh'), 'utf8')
  expect(source).toContain('zerokun/computer-use-readiness.ts')
})
