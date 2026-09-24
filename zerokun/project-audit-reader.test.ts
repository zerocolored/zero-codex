import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, writeFileSync, rmSync, chmodSync, symlinkSync, linkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { auditDatabaseError, loadAuditEntries, readProjectAudit, type AuditEntry } from './project-audit-reader.ts'

const roots: string[] = []
test('Bun SQLSTATE distinguishes permission, authentication, timeout and generic errors without diagnostics', () => {
  for (const [errno, expected] of [['42501', 'read permission denied'], ['28P01', 'authentication unavailable'],
    ['57014', 'timed out'], ['42P01', 'connection or registered query failed']]) {
    const error = { code: 'ERR_POSTGRES_SERVER_ERROR', errno, message: 'private diagnostic example-password-123' }
    expect(auditDatabaseError(error).message).toContain(expected!)
    expect(auditDatabaseError(error).message).not.toContain('example-password-123')
  }
  expect(auditDatabaseError(null, true).message).toContain('cancelled')
})
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'audit-reader-'))); roots.push(root)
  const path = join(root, 'registry.json')
  const entries = { baseline: { kind: 'snapshot', source: 'historical approval, not current state', data: { included: ['m1'] } } }
  writeFileSync(path, JSON.stringify({ version: 1, projects: [{ root, entries }] }), { mode: 0o600 })
  return { root, path }
}
test('host registry binds private snapshots to the exact project and discovery omits contents', async () => {
  const { root, path } = fixture()
  const entries = loadAuditEntries(root, path)
  expect(loadAuditEntries(realpathSync(tmpdir()), path)).toEqual({})
  expect(await readProjectAudit(entries)).toMatchObject({ available: [{ id: 'baseline', kind: 'snapshot' }] })
  expect(JSON.stringify(await readProjectAudit(entries))).not.toContain('m1')
  expect(await readProjectAudit(entries, 'baseline')).toMatchObject({ data: { included: ['m1'] } })
  await expect(readProjectAudit(entries, '__proto__')).rejects.toThrow('not registered')
})
test('registry rejects writable, symlink and hardlink leaves; missing registry is empty', () => {
  const { root, path } = fixture()
  chmodSync(path, 0o644)
  expect(() => loadAuditEntries(root, path)).toThrow('unsafe')
  chmodSync(path, 0o600)
  const alias = join(root, 'alias.json'); symlinkSync(path, alias)
  expect(() => loadAuditEntries(root, alias)).toThrow()
  const hard = join(root, 'hard.json'); linkSync(path, hard)
  expect(() => loadAuditEntries(root, path)).toThrow('unsafe')
  expect(loadAuditEntries(root, join(root, 'missing.json'))).toEqual({})
})
test('unknown configuration and multiple SQL statements are rejected before authentication', async () => {
  const bad = { kind: 'postgres', source: 'audit', project: 'project-test', secret: 'db-url',
    port: 5433, database: 'test', systemId: '1234567890123456789', sql: 'SELECT 1; COMMIT', maxRows: 1 } as AuditEntry
  let called = false
  await expect(readProjectAudit({ audit: bad }, 'audit', async () => { called = true; return [] })).rejects.toThrow()
  expect(called).toBe(false)
})
test('bounded audit reads preserve provenance and reject truncation rather than claiming completeness', async () => {
  const query: AuditEntry = { kind: 'postgres', source: 'before/after journal', project: 'project-test',
    secret: 'db-url', port: 5433, database: 'test', systemId: '1234567890123456789', sql: 'SELECT status FROM public.journal', maxRows: 1 }
  const entries = { journal: query }
  const value = await readProjectAudit(entries, 'journal', async received => {
    expect(received.sql).toBe(query.sql)
    return [{ status: 'applied', before: { source: 'manual' }, after: { source: 'manual' } }]
  })
  expect(value).toMatchObject({ source: 'before/after journal', kind: 'postgres', data: [{ status: 'applied' }] })
  expect(JSON.stringify(value)).not.toContain('db-url')
  await expect(readProjectAudit(entries, 'journal', async () => [{}, {}])).rejects.toThrow('row limit')
  await expect(readProjectAudit(entries, 'journal', async () => [{ value: 'x'.repeat(2 * 1024 * 1024) }])).rejects.toThrow('size limit')
})
test('registered private evidence redacts credential fields and does not silently rewrite missing expected sets', async () => {
  const entries: Record<string, AuditEntry> = { snapshot: { kind: 'snapshot', source: 'historical record',
    data: { expected: null, observed: ['m1'], password: 'hidden-value', nested: { access_token: 'hidden-value' } } } }
  const result = await readProjectAudit(entries, 'snapshot')
  expect(result).toMatchObject({ data: { expected: null, observed: ['m1'], password: '[redacted]' } })
  expect(JSON.stringify(result)).not.toContain('hidden-value')
})
test('credentials embedded in serialized JSON, authenticated URLs and provenance never reach discovery or results', async () => {
  const entries: Record<string, AuditEntry> = { audit: { kind: 'snapshot',
    source: 'previous connection postgres://operator:example-password-123@localhost/db',
    data: { payload: '{"password":"example-password-123"}',
      url: 'postgres://operator:example-password-123@localhost/db',
      nested: ['https://user:example-password-123@example.invalid/path'],
      reference: 'historical-approval-1' } } }
  for (const selected of [undefined, 'audit']) {
    const result = JSON.stringify(await readProjectAudit(entries, selected))
    expect(result).not.toContain('example-password-123')
    expect(result).toContain('[redacted]')
  }
  expect(await readProjectAudit(entries, 'audit')).toMatchObject({ data: { reference: 'historical-approval-1' } })
})
test('object and serialized provenance use the same sensitive-key classification', async () => {
  for (const key of ['credentials', 'db_password', 'access_token', 'connection_string', 'api_key']) {
    const payload = JSON.stringify({ [key]: 'example-password-123' })
    for (const text of [payload, JSON.stringify(payload)]) {
      const entries: Record<string, AuditEntry> = { audit: { kind: 'snapshot', source: text,
        data: { payload: text, [key]: 'example-password-123' } } }
      for (const id of [undefined, 'audit']) {
        expect(JSON.stringify(await readProjectAudit(entries, id))).not.toContain('example-password-123')
      }
    }
  }
})
