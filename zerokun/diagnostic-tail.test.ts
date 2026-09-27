import { test, expect } from 'bun:test'
import { mkdtempSync, openSync, closeSync, readFileSync, statSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DiagnosticTail } from './diagnostic-tail.ts'
import { removeSettledJobState } from './state-maintenance.ts'

test('20MiB超でも障害直前を有界な2segmentへ保存する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-diagnostic-tail-'))
  const paths = [join(dir, 'tail-0'), join(dir, 'tail-1')]
  const fds = paths.map(path => openSync(path, 'w', 0o600)) as [number, number]
  try {
    const tail = new DiagnosticTail(fds)
    tail.write(new Uint8Array(21 * 1024 * 1024 + 123).fill(65))
    tail.write(new TextEncoder().encode('\nterminal-failure-evidence\n'))
    const info = tail.summary()
    expect(info.totalBytes).toBe(21 * 1024 * 1024 + 123 + 27)
    expect(readFileSync(paths[info.latestSegment]!, 'utf8')).toEndWith('terminal-failure-evidence\n')
    for (const path of paths) {
      expect(statSync(path).size).toBeLessThanOrEqual(1024 * 1024)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  } finally {
    fds.forEach(closeSync)
    rmSync(dir, { recursive: true })
  }
})

test('chunkとsegmentの境界を跨いでもbyte順と最新segmentを復元できる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-diagnostic-tail-'))
  const paths = [join(dir, 'tail-0'), join(dir, 'tail-1')]
  const fds = paths.map(path => openSync(path, 'w', 0o600)) as [number, number]
  try {
    const tail = new DiagnosticTail(fds, 8)
    tail.write(Buffer.from('0123456'))
    tail.write(Buffer.from('789abcdef'))
    tail.write(Buffer.from('ghij'))
    const info = tail.summary()
    expect(info).toEqual({ totalBytes: 20, segmentLimit: 8, latestSegment: 0, segmentStartBytes: [16, 8] })
    expect(readFileSync(paths[1]!, 'utf8') + readFileSync(paths[0]!, 'utf8')).toBe('89abcdefghij')
  } finally {
    fds.forEach(closeSync)
    rmSync(dir, { recursive: true })
  }
})

test('ジョブ保存期限でtailも削除し他ジョブのtailは保持する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-diagnostic-tail-'))
  try {
    const logs = join(dir, 'job-logs')
    mkdirSync(logs, { mode: 0o700 })
    for (const suffix of ['tail-0.log', 'tail-1.log', 'tail.json']) {
      writeFileSync(join(logs, `done.resume.stdout.log.${suffix}`), 'test', { mode: 0o600 })
      writeFileSync(join(logs, `active.resume.stdout.log.${suffix}`), 'test', { mode: 0o600 })
    }
    expect(removeSettledJobState({ stateDir: dir, jobIds: ['done'], attachmentPaths: [], stillReferencedAttachments: new Set() })).toBe(3)
    for (const suffix of ['tail-0.log', 'tail-1.log', 'tail.json']) {
      expect(existsSync(join(logs, `done.resume.stdout.log.${suffix}`))).toBe(false)
      expect(existsSync(join(logs, `active.resume.stdout.log.${suffix}`))).toBe(true)
    }
  } finally { rmSync(dir, { recursive: true }) }
})
