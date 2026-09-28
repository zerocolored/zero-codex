import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { chmodSync, linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readClaudeAnswerFile, MAX_CLAUDE_ANSWER_BYTES } from './claude-answer-file.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const nonce = '0123456789ABCDEF0123456789ABCDEF'
const marker = `REQUEST_MARKER=${nonce}`
function fixture(body = '独立した回答です。') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-answer-')))
  roots.push(dir); chmodSync(dir, 0o700)
  const raw = `CLAUDE_ANSWER_BEGIN=${nonce}\n${body}\nCLAUDE_ANSWER_END=${nonce}\n`
  const path = join(dir, 'answer.md')
  writeFileSync(path, raw, { mode: 0o600 })
  const terminal = (content = raw) => `⏺ CLAUDE_ANSWER_SAVED=${nonce} SHA256=${createHash('sha256').update(content).digest('hex')}\n${marker}\n❯`
  return { dir, raw, path, terminal }
}
test('1500-line answer survives a terminal containing only a digest receipt', () => {
  const body = Array.from({ length: 1500 }, (_, i) => `FAQ ${i + 1}: 条件と例外 ${i + 1}`).join('\n')
  const f = fixture(body)
  expect(readClaudeAnswerFile(f.dir, marker, f.terminal())?.response).toBe(body)
})
test('changed and partially written files never fall through to a terminal answer', () => {
  const f = fixture()
  writeFileSync(f.path, f.raw.slice(0, -20))
  expect(() => readClaudeAnswerFile(f.dir, marker, f.terminal())).toThrow('digest mismatch')
  expect(() => readClaudeAnswerFile(f.dir, marker, 'no receipt')).toThrow('receipt unavailable')
})
test('hash alone cannot accept missing, foreign, repeated or empty boundaries', () => {
  for (const body of ['', 'CLAUDE_ANSWER_BEGIN='+nonce]) {
    const f = fixture(body)
    expect(() => readClaudeAnswerFile(f.dir, marker, f.terminal())).toThrow()
  }
  const f = fixture()
  for (const raw of [f.raw.replace('CLAUDE_ANSWER_END', 'INVALID'), f.raw.replaceAll(nonce, 'F'.repeat(32))]) {
    writeFileSync(f.path, raw)
    expect(() => readClaudeAnswerFile(f.dir, marker, f.terminal(raw))).toThrow('boundaries')
  }
})
test('receipt and final marker must be unique and in order', () => {
  const f = fixture()
  expect(() => readClaudeAnswerFile(f.dir, marker, f.terminal()+'\n'+f.terminal())).toThrow('receipt')
  expect(() => readClaudeAnswerFile(f.dir, marker, f.terminal().replace(marker, ''))).toThrow('terminal marker')
  expect(() => readClaudeAnswerFile(f.dir, marker.replace('0', 'F'), f.terminal())).toThrow()
})
test('unsafe file kinds and access modes are rejected', () => {
  const f = fixture()
  chmodSync(f.path, 0o644)
  expect(() => readClaudeAnswerFile(f.dir, marker, f.terminal())).toThrow()
  chmodSync(f.path, 0o600)
  linkSync(f.path, join(f.dir, 'hardlink'))
  expect(() => readClaudeAnswerFile(f.dir, marker, f.terminal())).toThrow()
  unlinkSync(f.path); symlinkSync(join(f.dir, 'hardlink'), f.path)
  expect(() => readClaudeAnswerFile(f.dir, marker, f.terminal())).toThrow()
})
test('oversized files are rejected before capture, empty legacy output can fall back', () => {
  const f = fixture()
  writeFileSync(f.path, 'a'.repeat(MAX_CLAUDE_ANSWER_BYTES + 1))
  expect(() => readClaudeAnswerFile(f.dir, marker, f.terminal())).toThrow('size bound')
  writeFileSync(f.path, '')
  expect(readClaudeAnswerFile(f.dir, marker, 'legacy terminal')).toBeNull()
  expect(() => readClaudeAnswerFile(f.dir, marker, f.terminal())).toThrow()
})
test('symlink request directory is not a source', () => {
  const f = fixture(); const alias = join(f.dir, 'alias'); symlinkSync(f.dir, alias)
  expect(() => readClaudeAnswerFile(alias, marker, f.terminal())).toThrow()
})

test('real narrow Claude display wraps nonce and SHA across hard lines', () => {
  const f = fixture()
  const hash = createHash('sha256').update(f.raw).digest('hex')
  const line = `CLAUDE_ANSWER_SAVED=${nonce} SHA256=${hash}`
  for (const width of [25, 42, 50, 80, 120]) {
    const wrapped = line.match(new RegExp(`.{1,${width}}`, 'g'))!.join('\n  ')
    const wrappedMarker = marker.match(new RegExp(`.{1,${width}}`, 'g'))!.join('\n  ')
    expect(readClaudeAnswerFile(f.dir, marker, `⏺ ${wrapped}\n  ${wrappedMarker}\n❯`)?.response).toBe('独立した回答です。')
  }
  expect(() => readClaudeAnswerFile(f.dir, marker, `CLAUDE_ANSWER_SAVED=${nonce} SHA256=\nwrong\n${hash}\n${marker}`)).toThrow()
})
