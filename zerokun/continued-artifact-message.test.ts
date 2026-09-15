import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ContinuedArtifactMessage } from './continued-artifact-message.ts'

test('native継続の待機終了で提案本文と添付を保持し置換・撤回・古い入力を区別する', () => {
  const root = mkdtempSync(join(tmpdir(), 'continued-artifacts-'))
  try {
    const before = join(root, 'before.png'), after = join(root, 'after.png')
    writeFileSync(before, 'before'); writeFileSync(after, 'after')
    const proposal = `比較案です。この方向で実装してよいですか？\n<zerokun_files>${JSON.stringify([before, after])}</zerokun_files>`
    const capture = new ContinuedArtifactMessage(root)
    capture.observe(proposal, 1)
    capture.observe('承認待ちです', 1)
    expect(capture.resolve('保持しました', 1, 'blocked')).toBe(proposal)
    expect(capture.resolve('保持しました', 1, 'paused')).toBe(proposal)
    expect(capture.resolve('完了しました', 1, 'complete')).toBe('完了しました')
    expect(capture.resolve('新しい指示', 2, 'blocked')).toBe('新しい指示')
    writeFileSync(after, 'changed')
    expect(capture.resolve('待機', 1, 'blocked')).toBe('待機')
    const replacement = proposal.replace('比較案です', '修正版です')
    capture.observe(replacement, 1)
    expect(capture.resolve('待機', 1, 'blocked')).toBe(replacement)
    capture.observe('撤回します<zerokun_files>[]</zerokun_files>', 1)
    expect(capture.resolve('待機', 1, 'blocked')).toBe('待機')
    capture.observe(replacement, 1)
    capture.observe('不正<zerokun_files>{oops', 1)
    expect(capture.resolve('待機', 1, 'blocked')).toBe('待機')
    capture.observe(replacement, 1)
    capture.observe('追記', 2)
    expect(capture.resolve('待機', 2, 'blocked')).toBe('待機')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
