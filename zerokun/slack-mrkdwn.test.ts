import { expect, test } from 'bun:test'
import { toSlackMrkdwn } from './slack-mrkdwn.ts'

test.each([
  ['**完了** と __確認__、~~旧版~~', '*完了* と *確認* 、 ~旧版~'],
  ['**完了**。', '*完了* 。'],
  ['作業は**完了**です。', '作業は *完了* です。'],
  ['**a *b* c**', '*a b c*'],
  ['**~~old~~ new**', '*~old~ new*'],
  ['## **one** and **two**', '*one and two*'],
  ['[**PR**](https://example.com)', '<https://example.com|PR>'],
  ['- **parent**\n  - **child**', '• *parent*\n  • *child*'],
  ['- **a**\n  b\n- c', '• *a*\n  b\n• c'],
  ['- [x] **done**\n- [ ] todo', '• [x] *done*\n• [ ] todo'],
  ['## 結果\n\n**成功**', '*結果*\n\n*成功*'],
  ['## **結果**\n', '*結果*\n'],
  ['[PR #103](https://example.com/a_(b))', '<https://example.com/a_(b)|PR #103>'],
  ['[資料][doc]\n\n[doc]: https://example.com/a', '<https://example.com/a|資料>\n\n[doc]: https://example.com/a'],
  ['- **成功**\n- 次へ', '• *成功*\n• 次へ'],
  ['1. **確認**\n2. 続行', '1. *確認*\n2. 続行'],
  ['> **引用**\n', '> *引用*\n'],
  ['```ts\nconst x = "**raw**"\n```', '```\nconst x = "**raw**"\n```'],
  ['`**kwargs` と **太字**', '`**kwargs` と *太字*'],
  ['```\n**未閉鎖', '```\n**未閉鎖'],
  ['*Slack太字* <@U123> <#C123|channel> <https://example.com/a_b|**literal**> :eyes:', '*Slack太字* <@U123> <#C123|channel> <https://example.com/a_b|**literal**> :eyes:'],
  ['https://example.com/a__b__c?q=**raw**', 'https://example.com/a__b__c?q=**raw**'],
])('%s', (input, expected) => {
  expect(toSlackMrkdwn(input)).toBe(expected)
  expect(toSlackMrkdwn(expected)).toBe(expected)
})

test('table remains readable as a monospaced block without losing cells', () => {
  const table = '| 項目 | 結果 |\n| --- | --- |\n| API | 成功 |'
  expect(toSlackMrkdwn(table)).toBe('```\n' + table + '\n```\n')
})
