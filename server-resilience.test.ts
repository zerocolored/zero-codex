import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const server = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')

describe('Slack bridge resilience wiring', () => {
  test('Slack接続後にchannelとDMの起動時catch-upを一度開始する', () => {
    expect(server).toContain('async function catchupSweep()')
    expect(server).toContain("types: 'im'")
    expect(server).toContain('client.conversations.history')
    expect(server).toContain('planCatchupSweep(history, delivered')
    expect(server).toContain('const result = await gate(')
    expect(server).toContain('const handedOver = await deliver(')
    expect(server.indexOf('await slackApp.start()')).toBeLessThan(server.indexOf('void catchupSweep()'))
  })

  test('plugin lockはPIDだけでなくserver.tsのprocess identityを照合する', () => {
    expect(server).toContain("from './plugin-lock.ts'")
    expect(server).toContain('claimPluginLock(LOCK_FILE, STATE_DIR)')
  })
})
