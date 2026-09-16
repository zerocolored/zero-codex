import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  extractExecutedCommands,
  findUnverifiedFailureClaims,
} from './unverified-failure-claim'

const temporaryRoots: string[] = []

function logWith(commands: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'zerokun-claim-guard-'))
  temporaryRoots.push(root)
  const path = join(root, 'stdout.log')
  const lines = [
    JSON.stringify({ method: 'thread/started', params: {} }),
    ...commands.map((command, index) => JSON.stringify({
      method: 'item/completed',
      params: { item: { type: 'commandExecution', id: `exec-${index}`, command } },
    })),
    JSON.stringify({ method: 'turn/completed', params: {} }),
  ]
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  return path
}

describe('unverified failure claim guard', () => {
  test('実行ログから commandExecution の command を抜き出す', () => {
    const path = logWith([
      "/bin/zsh -lc 'git status --short'",
      '/bin/zsh -lc "npx dotenvx run --quiet -- bash -c \'curl -s $SUPABASE_URL\'"',
    ])

    const commands = extractExecutedCommands(path)

    expect(commands).toHaveLength(2)
    expect(commands[1]).toContain('dotenvx')
  })

  test('壊れた行や commandExecution 以外を混ぜても落ちない', () => {
    const root = mkdtempSync(join(tmpdir(), 'zerokun-claim-guard-'))
    temporaryRoots.push(root)
    const path = join(root, 'stdout.log')
    writeFileSync(path, [
      'not json at all',
      JSON.stringify({ method: 'item/completed', params: { item: { type: 'reasoning' } } }),
      JSON.stringify({ method: 'item/completed', params: { item: { type: 'commandExecution', command: 'ls' } } }),
      '',
    ].join('\n'), { mode: 0o600 })

    expect(extractExecutedCommands(path)).toEqual(['ls'])
  })

  test('存在しないログは空配列（検査を理由にジョブを落とさない）', () => {
    expect(extractExecutedCommands(join(tmpdir(), 'zerokun-claim-guard-missing.log'))).toEqual([])
  })

  /**
   * 2026-09-16 の実例。
   * 「dotenvx の起動失敗と管理APIの401で止まり、chat_histories への直接問い合わせを
   * 試しませんでした」と回答したが、実行ログ上 dotenvx は 1 度も動いていない。
   * やっていないことを「やって失敗した」と報告した。
   */
  test('dotenvx が失敗したと書いているのに dotenvx を実行していなければ検出する', () => {
    const path = logWith([
      "/bin/zsh -lc 'git status --short'",
      "/bin/zsh -lc 'rg -n supabase src'",
    ])

    const claims = findUnverifiedFailureClaims(
      'dotenvx の起動失敗と管理APIの401で止まり、chat_histories への直接問い合わせを試しませんでした。',
      extractExecutedCommands(path),
    )

    expect(claims.map(claim => claim.mechanism)).toContain('dotenvx')
  })

  test('実際に dotenvx を実行していれば検出しない', () => {
    const path = logWith([
      '/bin/zsh -lc "npx dotenvx run --quiet -- bash -c \'curl -s $SUPABASE_URL/rest/v1/\'"',
    ])

    expect(findUnverifiedFailureClaims(
      'dotenvx の起動に失敗したため取得できませんでした。',
      extractExecutedCommands(path),
    )).toEqual([])
  })

  test('Supabase へ接続できないと書いているのに叩いていなければ検出する', () => {
    const claims = findUnverifiedFailureClaims(
      '本番 Supabase へ接続できませんでした。読み取り接続の復旧が必要です。',
      ["/bin/zsh -lc 'git log --oneline -5'"],
    )

    expect(claims.map(claim => claim.mechanism)).toContain('supabase')
  })

  test('gcloud / Cloud Logging も同じ扱い', () => {
    const claims = findUnverifiedFailureClaims(
      'Cloud Logging を取得できませんでした。',
      ["/bin/zsh -lc 'ls'"],
    )

    expect(claims.map(claim => claim.mechanism)).toContain('gcloud')
  })

  /** 失敗を主張していない普通の回答は素通しする。 */
  test('機構名が出ても失敗を主張していなければ検出しない', () => {
    expect(findUnverifiedFailureClaims(
      'Supabase の chat_histories に文字起こしが入っています。次はそこを見ます。',
      ["/bin/zsh -lc 'ls'"],
    )).toEqual([])
  })

  test('失敗を主張していても機構名が無ければ検出しない（過検出を避ける）', () => {
    expect(findUnverifiedFailureClaims(
      '再現できませんでした。もう少し情報が必要です。',
      ["/bin/zsh -lc 'ls'"],
    )).toEqual([])
  })

  test('空の回答・空のコマンド列で落ちない', () => {
    expect(findUnverifiedFailureClaims('', [])).toEqual([])
    expect(findUnverifiedFailureClaims('Supabase に接続できません', [])).toHaveLength(1)
  })

  test('検出結果には根拠になる文とヒントが入る', () => {
    const [claim] = findUnverifiedFailureClaims(
      'dotenvx の起動に失敗しました。',
      [],
    )

    expect(claim?.mechanism).toBe('dotenvx')
    expect(claim?.evidenceHint).toContain('dotenvx')
    expect(claim?.sentence).toContain('dotenvx')
  })
})

process.on('exit', () => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})
