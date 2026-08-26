import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  copyLiveControlAttachments,
  isSlackInterruptCommand,
  liveControlInputDir,
  normalizeSlackInboundText,
  stripSlackUserMention,
} from './live-control.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'zero-live-control-'))
  chmodSync(root, 0o700)
  roots.push(root)
  return root
}

describe('Slack live control', () => {
  test('完全一致の中止だけをhost interruptとして扱う', () => {
    expect(isSlackInterruptCommand('中止')).toBe(true)
    expect(isSlackInterruptCommand('  　中止  ')).toBe(true)
    expect(isSlackInterruptCommand('  <@U123ABC>　中止  ')).toBe(false)
    expect(isSlackInterruptCommand('やっぱり中止して')).toBe(false)
    expect(isSlackInterruptCommand('中止しないで')).toBe(false)
    expect(stripSlackUserMention('<@U123ABC|zero-chan> 追記', 'U123ABC')).toBe('  追記')
    expect(stripSlackUserMention('<@U999|other> 中止', 'U123ABC')).toBe('<@U999|other> 中止')
    const recovered = normalizeSlackInboundText('<@U123ABC>　中止 ', 'U123ABC', false)
    expect(recovered).toBe('中止')
    expect(isSlackInterruptCommand(recovered)).toBe(true)
    expect(normalizeSlackInboundText('<@U123ABC> 中止', 'U123ABC', true))
      .toBe('中止')
  })

  test('追加添付をjob固有rootへ完全copyして他jobと分離する', () => {
    const stateDir = stateRoot()
    const inbox = join(stateDir, 'inbox', '1')
    mkdirSync(inbox, { recursive: true, mode: 0o700 })
    const source = join(inbox, 'F123.txt')
    writeFileSync(source, 'payload', { mode: 0o600 })
    const [copied] = copyLiveControlAttachments({
      stateDir, jobId: 'job/one', messageId: '1.0001', attachments: [source],
    })
    expect(copied?.startsWith(liveControlInputDir(stateDir, 'job/one'))).toBe(true)
    expect(copied?.includes('job_two')).toBe(false)
  })
})
