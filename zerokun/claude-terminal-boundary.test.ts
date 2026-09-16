import { expect, test } from 'bun:test'
import { extractCompleteClaudeResponse } from './advisor-broker.ts'

const marker = 'REQUEST_MARKER=0123456789ABCDEF0123456789ABCDEF'
const answer = '⏺ 原文条件を項目別に照合し、対象回答を修復して再検品します。'
const envelope = (tail: string[]) => [
  '依頼本文', '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
  marker, answer, marker, ...tail,
].join('\n')
test('request-bound complete answers are independent of terminal UI formatting', () => {
  for (const tail of [
    [], ['✻ Cogitated for 2m 7s · done 6:41 AM', '────', '❯\u00a0本番ジョブのログを確認して', '────'],
    ['新しいバージョンの表示', '❯ 複数行の提案', '続き', '? for shortcuts'],
    ['✻ New activity · done 19:32', '✔ Update installed', '/rc'],
  ]) {
    expect(extractCompleteClaudeResponse(envelope(tail), marker)).toBe(answer)
    expect(extractCompleteClaudeResponse(envelope(tail).replaceAll('\n', '\r\n'), marker)).toBe(answer)
  }
})
test('missing, foreign and ambiguous request markers are not answers to this request', () => {
  expect(extractCompleteClaudeResponse(envelope([]), marker.replace('0', 'F'))).toBeNull()
  expect(extractCompleteClaudeResponse(envelope([marker]), marker)).toBeNull()
  expect(extractCompleteClaudeResponse(envelope([]).replace(answer + '\n' + marker, answer), marker)).toBeNull()
})
