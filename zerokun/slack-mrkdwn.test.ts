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
  ['*Slack太字* <@U123> <#C123|channel> <https://example.com/a_b|**literal**> :eyes:', '*Slack太字* <@U123> <#C123|channel> <https://example.com/a_b|**literal**> :eyes:'],
  ['https://example.com/a__b__c?q=**raw**', 'https://example.com/a__b__c?q=**raw**'],
])('%s', (input, expected) => {
  expect(toSlackMrkdwn(input)).toBe(expected)
  expect(toSlackMrkdwn(expected)).toBe(expected)
})

test('tables become labelled rows with rendered emphasis and links', () => {
  const table = '| 項目 | 結果 |\n| --- | --- |\n| API | **成功** |\n| UI | [結果](https://example.com) |'
  const result = '• 項目: API\n  結果: *成功*\n\n• 項目: UI\n  結果: <https://example.com|結果>\n'
  expect(toSlackMrkdwn(table)).toBe(result)
  expect(toSlackMrkdwn(result)).toBe(result)
})

test.each(['```', '```markdown', '```text', '~~~md'])('tables inside %s also become ordinary lists', fence => {
  const closing = fence.startsWith('~') ? '~~~' : '```'
  const table = '| A | B |\n| - | - |\n| a\\|b | **成功** |'
  const result = toSlackMrkdwn(`${fence}\n${table}\n${closing}`)
  expect(result).toBe('• A: a|b\n  B: *成功*\n')
  expect(result).not.toContain('```')
  expect(result).not.toContain('**')
})

test('empty and duplicate headers/cells and header-only tables retain their positions', () => {
  expect(toSlackMrkdwn('| A | A | |\n| - | - | - |\n| one | | three |'))
    .toBe('• A: one\n  A: \n  列3: three\n')
  expect(toSlackMrkdwn('| A | B |\n| - | - |')).toBe('• A\n• B\n')
})

test('surplus cells are retained instead of being truncated to the header width', () => {
  expect(toSlackMrkdwn('| A | B |\n| - | - |\n| x\\|y | two | **three** | four |'))
    .toBe('• A: x|y\n  B: two\n  列3: *three*\n  列4: four\n')
})

test('emphasis next to Japanese text has Slack-compatible boundaries in every column', () => {
  expect(toSlackMrkdwn('| 状態 |\n| - |\n| **成功**です。 | 確認は**完了**。 |'))
    .toBe('• 状態: *成功* です。\n  列2: 確認は *完了* 。\n')
})

test.each([
  ['```ts\nconst x = "**raw**"\n```', 'const x = "**raw**"'],
  ['`**kwargs` と **太字**', '**kwargs と *太字*'],
  ['```\n**未閉鎖', '**未閉鎖'],
  ['    # comment\n    a * b * c', '# comment\na * b * c'],
  ['実行: `bun test`', '実行: bun test'],
  ['```\n<@U123> & <!here>\n```', '&lt;@U123&gt; &amp; &lt;!here&gt;'],
  ['`<https://example.com|literal>`', '&lt;https://example.com|literal&gt;'],
])('code loses formatting without reinterpreting literal content: %s', (input, expected) => {
  expect(toSlackMrkdwn(input)).toBe(expected)
})

test('fenced tables do not activate mentions previously protected by code', () => {
  const result = toSlackMrkdwn('```md\n| A | B |\n| - | - |\n| <@U123> | [資料](https://example.com) |\n```')
  expect(result).toContain('&lt;@U123&gt;')
  expect(result).not.toContain('<@U123>')
  expect(result).toContain('<https://example.com|資料>')
})

test('ordinary tables also retain their former code-block mention protection', () => {
  expect(toSlackMrkdwn('| <@U123> |\n| - |\n| <!here> | <#C123> |'))
    .toBe('• &lt;@U123&gt;: &lt;!here&gt;\n  列2: &lt;#C123&gt;\n')
})

test('code spans in fenced cells are escaped exactly once, including surplus cells', () => {
  const result = toSlackMrkdwn('```md\n| A | B |\n| - | - |\n| `<@U123>` | <!here> | `<#C123>` |\n```')
  expect(result).toBe('• A: &lt;@U123&gt;\n  B: &lt;!here&gt;\n  列3: &lt;#C123&gt;\n')
})

test('prose immediately following a table does not become a labelled row', () => {
  expect(toSlackMrkdwn('| A | B |\n| - | - |\n| x | y |\n続きは**こちら**です。'))
    .toBe('• A: x\n  B: y\n\n続きは *こちら* です。\n')
})

test('header-only tables retain their labels when followed immediately by prose', () => {
  const input = '| A | B |\n| - | - |\n続き'
  const expected = '• A\n• B\n\n続き\n'
  expect(toSlackMrkdwn(input)).toBe(expected)
  expect(toSlackMrkdwn('```md\n' + input + '\n```')).toBe(expected)
})

test('relative file links lose inline code without discarding their destination', () => {
  expect(toSlackMrkdwn('[`a.ts`](zerokun/a.ts)')).toBe('[a.ts](zerokun/a.ts)')
  expect(toSlackMrkdwn('[`a.ts`](file:///tmp/a.ts)')).toBe('[a.ts](file:///tmp/a.ts)')
})

test('nested fences are removed without rendering source as Markdown', () => {
  expect(toSlackMrkdwn('````markdown\n```sh\n# comment\n```\n````')).toBe('# comment')
  expect(toSlackMrkdwn('````markdown\n```md\n| A | B |\n| - | - |\n| x | **y** |\n```\n````'))
    .toBe('• A: x\n  B: *y*\n')
})

test('quoted/nested tables and following paragraphs are retained', () => {
  const result = toSlackMrkdwn('> | A | B |\n> | - | - |\n> | x | **y** |\n\n後続の説明')
  expect(result).toContain('> • A: x\n>   B: *y*')
  expect(result).toContain('後続の説明')
})
