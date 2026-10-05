import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { chmodSync, linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readClaudeAnswerFile, sanitizeClaudeAnswer, MAX_CLAUDE_ANSWER_BYTES, ClaudeAnswerPendingError, ClaudeResponseSettling } from './claude-answer-file.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const nonce = '0123456789ABCDEF0123456789ABCDEF'
const marker = `REQUEST_MARKER=${nonce}`
test('credential-free Claude reviews retain exact Unicode and formatting', () => {
  const response = '認証方式（案）：Ａ → Ｂ\nBearer tokens are commonly sent in the Authorization header.\nURL: https://example.test/a%20b'
  expect(sanitizeClaudeAnswer(response)).toEqual({ response, redacted: false })
})
test.each([
  'Bearer capability', 'Authorization: Bearer <token>', 'Bearer a',
  'Authorization: Bearer "synthetic-quoted-value"', "Bearer 'synthetic-quoted-value'",
  'Authorization: Bearer "synthetic-unclosed-value',
  'Authorization: Bearer %22synthetic-credential-value%22',
  'Authorization%3A%20Bearer%20"synthetic-credential-value"',
  'Bearer %2527synthetic-credential-value%2527',
  'Authorization: Bearer `synthetic-credential-value`',
  'Authorization: Bearer {synthetic-credential-value}',
  'Authorization: Bearer [synthetic-credential-value]',
  'Authorization: Bearer (synthetic-credential-value)',
  'password=abcdefghijkl!@synthetic-tail',
  'password="abcdefghijkl with spaces"',
  'password:\nabcdefghijkl!@synthetic-tail',
  'xoxb-1234567890-abcdefghijklmnopqrstuvwxyz',
  'xoxb-1234\u200e567890-abcdefghijklmnopqrstuvwxyz',
  'ｘｏｘｂ-1234567890-abcdefghijklmnopqrstuvwxyz',
  'xoxb%2D1234567890%2Dabcdefghijklmnopqrstuvwxyz',
  'Authorization%3A%20Bearer%20abc',
  'eyJhbGciOiJIUzI1NiJ9.e30.abc',
])('Claude review survives redaction of credential-shaped text: %s', value => {
  const result = sanitizeClaudeAnswer(`Finding before.\n${value}\nFinding after.`)
  expect(result.redacted).toBe(true)
  expect(result.response).toContain('Finding before.\n[credential removed]')
  expect(result.response).toEndWith('\nFinding after.')
  expect(result.response).not.toContain(value)
  expect(sanitizeClaudeAnswer(result.response)).toEqual({ response: result.response, redacted: false })
})
test.each(['PRIVATE KEY', 'RSA PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'RSA  PRIVATE KEY'])('Claude %s redaction removes the body including incomplete and encoded blocks', kind => {
  const key = `-----BEGIN ${kind}-----\nU1lOVEhFVElDX0tFWV9CT0RZ\n-----END ${kind}-----`
  for (const value of [key, encodeURIComponent(key), key.replaceAll('-', '%2D'), key.replaceAll('E', 'Ｅ')]) {
    expect(sanitizeClaudeAnswer(`Before\n${value}\nAfter`)).toEqual({
      response: 'Before\n[credential removed]\nAfter', redacted: true,
    })
  }
  expect(sanitizeClaudeAnswer(`Before\n-----BEGIN ${kind}-----\nU1lOVEhFVElDX0tFWV9CT0RZ`)).toEqual({
    response: 'Before\n[credential removed]', redacted: true,
  })
})
test('PEM header citations do not consume later findings or unrelated encoded URLs', () => {
  const response = 'The guard recognizes `-----BEGIN PRIVATE KEY-----`.\nNext finding remains.\nhttps://example.test/a%20b'
  expect(sanitizeClaudeAnswer(response)).toEqual({ response:
    'The guard recognizes `[credential removed]`.\nNext finding remains.\nhttps://example.test/a%20b', redacted: true })
  expect(sanitizeClaudeAnswer('-----BEGIN PRIVATE KEY-----\nNext finding remains.').response)
    .toBe('[credential removed]\nNext finding remains.')
  expect(sanitizeClaudeAnswer('-----BEGIN PRIVATE KEY-----\nQUJD%2BREV\n-----END PRIVATE KEY-----\nNext finding remains.').response)
    .toBe('[credential removed]\nNext finding remains.')
  expect(sanitizeClaudeAnswer('-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,ABCDEF\n\nU1lOVEhFVElDX0tFWV9CT0RZ\n-----END RSA PRIVATE KEY-----\nNext finding remains.').response)
    .toBe('[credential removed]\nNext finding remains.')
})
test('wrapped Bearer redaction keeps subsequent quoted findings', () => {
  expect(sanitizeClaudeAnswer('Bearer "synthetic-credential"。指摘: "認可チェックが欠落"').response)
    .toBe('[credential removed]。指摘: "認可チェックが欠落"')
  expect(sanitizeClaudeAnswer('Bearer "synthetic-escaped\\"value"。指摘: "認可チェックが欠落"').response)
    .toBe('[credential removed]。指摘: "認可チェックが欠落"')
  for (const value of ['Bearer "aaa" then Bearer "synthetic-credential-value"',
    'Bearer <token> then Authorization: Bearer "synthetic-credential-value"']) {
    expect(sanitizeClaudeAnswer(value).response).toBe('[credential removed] then [credential removed]')
  }
})
test('serialized, single-line and prefixed PEM keys lose their whole payload', () => {
  const payload = 'U1lOVEhFVElDX0tFWV9CT0RZ'
  for (const body of [`\\n${payload}\\n`, ` ${payload} `, `\n> ${payload}\n> `,
    `\n-${payload}\n`, `\n12: ${payload}\n`, '\n> QUJD%2BREV\n',
    ' MIIE... ', '\nMIIE%5Fsynthetic\n']) {
    const result = sanitizeClaudeAnswer(`Finding before.\n"private_key": "-----BEGIN PRIVATE KEY-----${body}-----END PRIVATE KEY-----"\nFinding after.`)
    expect(result.response).toBe('Finding before.\n"private_key": "[credential removed]"\nFinding after.')
  }
  for (const separator of ['\\n', ' ']) {
    expect(sanitizeClaudeAnswer(`-----BEGIN PRIVATE KEY-----${separator}${payload}`).response)
      .toBe('[credential removed]')
  }
  for (const body of [`\nFound in config:\n${payload}\n`, '\nU1lO VEhFVElDX0tFWV9CT0RZ\n',
    '.\nQUJD%2BREV\n']) {
    const result = sanitizeClaudeAnswer(`-----BEGIN PRIVATE KEY-----${body}-----END PRIVATE KEY-----\nNext finding remains.`)
    expect(result.response).toBe('[credential removed]\nNext finding remains.')
  }
  expect(sanitizeClaudeAnswer('Mention -----BEGIN PRIVATE KEY----- then explain why.\nKeep this finding.\nMention -----END PRIVATE KEY-----.').response)
    .toContain('Keep this finding.')
})
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
  for (const width of [10, 14, 18, 19, 25, 42, 50, 80, 120]) {
    const wrapped = line.match(new RegExp(`.{1,${width}}`, 'g'))!.join('\n  ')
    const wrappedMarker = marker.match(new RegExp(`.{1,${width}}`, 'g'))!.join('\n  ')
    expect(readClaudeAnswerFile(f.dir, marker, `⏺ ${wrapped}\n  ${wrappedMarker}\n❯`)?.response).toBe('独立した回答です。')
  }
  expect(() => readClaudeAnswerFile(f.dir, marker, `CLAUDE_ANSWER_SAVED=${nonce} SHA256=\nwrong\n${hash}\n${marker}`)).toThrow()
})

test('pending output can complete later without losing the owned answer', () => {
  const f = fixture()
  expect(() => readClaudeAnswerFile(f.dir, marker, '❯')).toThrow(ClaudeAnswerPendingError)
  expect(readClaudeAnswerFile(f.dir, marker, f.terminal())?.response).toBe('独立した回答です。')
})
test('settling requires ten seconds of unchanged evidence and resets on progress', () => {
  const state = new ClaudeResponseSettling()
  expect(state.exhausted('first', 0)).toBe(false)
  expect(state.exhausted('first', 9999)).toBe(false)
  expect(state.exhausted('changed', 10000)).toBe(false)
  expect(state.exhausted('changed', 20000)).toBe(true)
  state.reset()
  expect(state.exhausted('changed', 20001)).toBe(false)
})


test('開始確認期限は接続障害中の時間を含めず連続した観測から数える', () => {
  const settling = new ClaudeResponseSettling(120_000)
  expect(settling.exhausted('same-idle', 0)).toBe(false)
  settling.reset() // a failed transport read breaks continuity
  expect(settling.exhausted('same-idle', 180_000)).toBe(false)
  expect(settling.exhausted('same-idle', 299_999)).toBe(false)
  expect(settling.exhausted('same-idle', 300_000)).toBe(true)
})
