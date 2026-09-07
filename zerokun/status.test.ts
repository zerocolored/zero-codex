import { describe, expect, test } from 'bun:test'
import { partialServiceStatusMessage } from './status.ts'

describe('Zero-kun service status guidance', () => {
  test('gatewayだけ稼働中ならrunnerの自動復旧と緊急手順を示す', () => {
    const message = partialServiceStatusMessage({
      gatewayPid: 123,
      launcherPid: 789,
    })

    expect(message).toContain('処理担当は自動復旧中')
    expect(message).toContain('zerochan stop --force')
    expect(message).toContain('zerochan start')
    expect(message).not.toContain('zerochan stop の後')
  })

  test('gateway停止を含む部分起動はforce stopを使う復旧手順を示す', () => {
    const message = partialServiceStatusMessage({
      runnerPid: 456,
    })

    expect(message).toContain('部分起動状態')
    expect(message).toContain('zerochan stop --force')
    expect(message).toContain('zerochan start')
    expect(message).not.toContain('zerochan stop の後')
  })

  test('launcherだけ欠落した場合は稼働中processを止めない再構築手順を示す', () => {
    const message = partialServiceStatusMessage({
      gatewayPid: 123,
      runnerPid: 456,
    })

    expect(message).toContain('自動復旧機構が停止')
    expect(message).toContain('現在の処理は稼働中')
    expect(message).toContain('zerochan start')
    expect(message).not.toContain('zerochan stop --force')
  })

  test('runnerとlauncherの両方が停止している場合は自動復旧中と表示しない', () => {
    const message = partialServiceStatusMessage({ gatewayPid: 123 })

    expect(message).toContain('部分起動状態')
    expect(message).toContain('zerochan stop --force')
    expect(message).not.toContain('自動復旧中')
  })
})
