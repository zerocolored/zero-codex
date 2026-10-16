import { afterEach, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAdvisorInputSnapshot } from './advisor-input.ts'
import { prepareClaudeAdvisorInput } from './claude-advisor-input.ts'
import { createEphemeralClaudeRequestDirectory, discardUnopenedEphemeralClaudeRequestDirectory } from './ephemeral-claude-session.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'claude-input-'))); roots.push(state)
  mkdirSync(join(state, 'inbox'), { mode: 0o700 })
  const source = join(state, 'inbox', 'image.png')
  writeFileSync(source, 'synthetic attachment', { mode: 0o600 })
  const request = createEphemeralClaudeRequestDirectory({ stateDir: state, jobId: 'job',
    attemptNonce: 'a'.repeat(32), inputRevision: 1, inputDigest: 'b'.repeat(64), phase: 'review', round: 1 })
  const input = (paths = [source]) => createAdvisorInputSnapshot({ id: 'job', message_id: 'message',
    user_id: 'user', task: `Review ${source}`, input_revision: 1, attachments_json: JSON.stringify(paths) }, [])
  return { state, source, request, input }
}

test('添付だけを許可済みrequestへコピーし、元入力digestを保ったまま参照先を変更する', () => {
  const f = fixture(), original = f.input()
  const result = prepareClaudeAdvisorInput(f.state, f.request, original)
  const copy = result.input.entries[0]!.attachments[0]!
  expect(copy.startsWith(f.request + '/attachment-')).toBe(true)
  expect(readFileSync(copy, 'utf8')).toBe('synthetic attachment')
  expect(result.input.digest).toBe(original.digest)
  expect(result.input.transcript).not.toContain(f.source)
  expect(result.rewriteText(`Evidence: ${f.source}`)).toBe(`Evidence: ${copy}`)
  expect(original.transcript).toContain(f.source)
  discardUnopenedEphemeralClaudeRequestDirectory(f.state, f.request)
  expect(existsSync(f.request)).toBe(false)
  expect(existsSync(f.source)).toBe(true)
})

test('同一内容を重複保存せず、追記添付も同じ専用領域へ渡す', () => {
  const f = fixture(), second = join(f.state, 'inbox', 'second.png')
  writeFileSync(second, 'synthetic attachment', { mode: 0o600 })
  const result = prepareClaudeAdvisorInput(f.state, f.request, f.input(), [second])
  expect(result.rewriteText(second)).toBe(result.input.entries[0]!.attachments[0]!)
})

test.each(['outside', 'symlink', 'hardlink', 'directory'])('不正な添付はコピー前に拒否する: %s', kind => {
  const f = fixture()
  let source = join(f.state, 'inbox', 'unsafe')
  if (kind === 'outside') { source = join(f.state, 'auth.json'); writeFileSync(source, 'synthetic') }
  if (kind === 'symlink') symlinkSync(f.source, source)
  if (kind === 'hardlink') linkSync(f.source, source)
  if (kind === 'directory') mkdirSync(source)
  expect(() => prepareClaudeAdvisorInput(f.state, f.request, f.input([source]))).toThrow()
})
