import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { ClaudeProgress } from './claude-progress.ts'
import { atomicWritePrivateFile } from './safe-file.ts'

test('actual progress obeys cadence, user-control priority, publication retry and freshness', () => {
  const root = mkdtempSync('/tmp/zero-progress-'), path = join(root, 'progress.json')
  try {
    let accepts = false, begins = 0
    const reports: number[] = []
    const progress = new ClaudeProgress({ jobId: 'fixture', attempt: 1, path, activatedAt: 1000,
      schedule: { firstMs: 10, secondMs: 30, thirdMs: 60, repeatMs: 60 },
      begin: () => { begins++; return true }, publish: report => { if (accepts) reports.push(report.slot); return accepts } })
    atomicWritePrivateFile(path, JSON.stringify({ text: '確認した結果と次の作業', updatedAt: 1001 }))
    progress.tick(false, 1009); progress.tick(true, 1010)
    expect(begins).toBe(0)
    progress.tick(false, 1010); accepts = true; progress.tick(false, 1011)
    expect(reports).toEqual([])
    progress.tick(false, 2010)
    expect(reports).toEqual([17])
    progress.tick(false, 3010)
    expect(reports).toEqual([17])
    atomicWritePrivateFile(path, JSON.stringify({ text: '次の確認も完了', updatedAt: 3000 }))
    progress.tick(false, 3010)
    expect(reports).toEqual([17, 34])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
