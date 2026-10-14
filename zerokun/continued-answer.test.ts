import { expect, test } from 'bun:test'
import { ContinuedAnswer } from './continued-answer.ts'
import { ContinuedArtifactMessage } from './continued-artifact-message.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test.each(['blocked', 'paused'])('説明と後続の訂正・待機条件を順番に配送する %s', status => {
  const answer = new ContinuedAnswer()
  answer.observe('登録は接続アプリを用意するためです。', 1)
  answer.observe('補足: 新規環境が必須なのは採用した方式の場合です。', 1)
  answer.observe('担当者の回答待ちです。', 1)
  expect(answer.resolve('担当者の回答待ちです。', 1, status)).toBe(
    '登録は接続アプリを用意するためです。\n\n補足: 新規環境が必須なのは採用した方式の場合です。\n\n担当者の回答待ちです。',
  )
})

test('重複を除去し、最後の訂正の順番を維持する', () => {
  const answer = new ContinuedAnswer()
  for (const text of ['A', 'A', 'B', 'A']) answer.observe(text, 1)
  expect(answer.resolve('A', 1, 'blocked')).toBe('B\n\nA')
})

test('入力revisionが変わると過去の説明を配送しない', () => {
  const answer = new ContinuedAnswer()
  answer.observe('古い質問の回答', 1)
  expect(answer.resolve('新しい回答', 2, 'blocked')).toBe('新しい回答')
  answer.observe('今の質問の回答', 2)
  expect(answer.resolve('今の待機条件', 2, 'blocked')).toBe('今の質問の回答\n\n今の待機条件')
})

test.each(['complete', 'active', 'usageLimited', 'budgetLimited', undefined])(
  '待機以外の状態では最後の結果を優先する %s', status => {
    const answer = new ContinuedAnswer()
    answer.observe('まだ未完了', 1)
    expect(answer.resolve('最新結果', 1, status)).toBe('最新結果')
  },
)

test.each(['<zerokun_files>[]</zerokun_files>', '<zerokun_files>{bad', '<zerokun_files>["/old"]</zerokun_files>'])(
  '添付宣言・撤回・不正宣言を本文保持で復活させない %s', marker => {
    const answer = new ContinuedAnswer()
    answer.observe('旧説明', 1)
    answer.observe(`添付を更新${marker}`, 1)
    answer.observe('待機', 1)
    expect(answer.resolve('最新の添付検証結果', 1, 'blocked')).toBe('旧説明\n\n待機\n\n最新の添付検証結果')
    answer.observe('次の入力', 2)
    expect(answer.resolve('待機', 2, 'blocked')).toBe('次の入力\n\n待機')
  },
)

test('長い古い説明より途中の訂正と最後の待機条件を優先する', () => {
  const answer = new ContinuedAnswer()
  answer.observe('元の質問への説明。' + '説明'.repeat(10_000), 1)
  answer.observe('訂正: 登録は不要でした。', 1)
  answer.observe('別の確認待ちです。', 1)
  const result = answer.resolve('別の確認待ちです。', 1, 'blocked')
  expect(result).toContain('訂正: 登録は不要でした。\n\n別の確認待ちです。')
  expect(result).toContain('元の質問への説明。')
  expect(result).toContain('一部省略')
  expect(result.length).toBeLessThanOrEqual(11_000)
})

test.each([1024 * 1024, 1_500_000])('保持容量を超えても新しい訂正と待機条件を捨てない %s', size => {
  const answer = new ContinuedAnswer()
  answer.observe('旧'.repeat(size), 1)
  answer.observe('訂正: 登録は不要でした。', 1)
  answer.observe('確認待ち', 1)
  const result = answer.resolve('確認待ち', 1, 'blocked')
  expect(result).toContain('訂正: 登録は不要でした。\n\n確認待ち')
  expect(result).toContain('一部省略')
  expect(result.length).toBeLessThanOrEqual(11_000)
})

test('添付の検証・差替え・撤回を通しても添付なしの説明を失わない', () => {
  const root = mkdtempSync(join(tmpdir(), 'continued-answer-'))
  try {
    const path = join(root, 'proposal.txt')
    writeFileSync(path, 'proposal')
    const artifacts = new ContinuedArtifactMessage(root)
    const answer = new ContinuedAnswer()
    const observe = (message: string) => { artifacts.observe(message, 1); answer.observe(message, 1) }
    const resolve = () => answer.resolve(artifacts.resolve('確認待ち', 1, 'blocked'), 1, 'blocked')
    const marker = `<zerokun_files>${JSON.stringify([path])}</zerokun_files>`
    observe('新規登録は共通アプリの準備のためです。')
    observe(`提案です\n${marker}`)
    observe('確認待ち')
    expect(resolve()).toBe(`新規登録は共通アプリの準備のためです。\n\n提案です\n\n確認待ち\n${marker}`)
    writeFileSync(path, 'changed')
    expect(resolve()).toBe('新規登録は共通アプリの準備のためです。\n\n確認待ち')
    observe(`差替え提案です\n${marker}`)
    observe('確認待ち')
    expect(resolve()).toContain('差替え提案です')
    expect(resolve()).not.toContain('\n\n提案です')
    expect(resolve().match(/<zerokun_files>/g)).toHaveLength(1)
    observe('撤回します<zerokun_files>[]</zerokun_files>')
    expect(resolve()).not.toContain('zerokun_files')
    expect(resolve()).toContain('共通アプリの準備')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
