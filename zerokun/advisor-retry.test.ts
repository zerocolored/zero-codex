import { expect, test } from 'bun:test'
import { recoverAdvisorSlot } from './advisor-retry.ts'

test.each(['claude', 'grok'] as const)('再試行の結果保存前に中断しても旧失敗を現行結果として残さない: %s', async advisor => {
  let saved: { adopted: boolean; containmentVerified: boolean; promptMayHaveBeenDelivered: boolean; reason: string } | undefined
  let calls = 0
  const failure = { adopted: false, containmentVerified: true, promptMayHaveBeenDelivered: false, reason: 'startup failure' }
  await expect(recoverAdvisorSlot({ advisor,
    beforeRun: () => { saved = undefined },
    run: async () => {
      expect(saved).toBeUndefined()
      if (++calls === 2) throw new Error('interrupted after new process/prompt started')
      return failure
    },
    persist: result => { saved = result },
    beforeRetry: () => { expect(saved).toBe(failure) },
    wait: async () => {},
  })).rejects.toThrow('interrupted after new process/prompt started')
  expect(calls).toBe(2)
  expect(saved).toBeUndefined()
})

test('再試行開始の永続化に失敗した場合は新しいprocessを起動しない', async () => {
  let calls = 0
  await expect(recoverAdvisorSlot({ advisor: 'claude',
    beforeRun: () => { throw new Error('cannot invalidate saved slot') },
    run: async () => { calls++; return { adopted: true } }, persist: () => {},
  })).rejects.toThrow('cannot invalidate saved slot')
  expect(calls).toBe(0)
})

test('一時失敗だけ30秒・60秒後に再取得し結果を毎回保存する', async () => {
  let calls = 0
  const waits: number[] = [], saved: boolean[] = []
  const result = await recoverAdvisorSlot({
    advisor: 'claude', run: async () => ({ adopted: ++calls === 3, containmentVerified: true, promptMayHaveBeenDelivered: false, reason: 'startup failure' }),
    persist: value => { saved.push(value.adopted) }, wait: async ms => { waits.push(ms) },
  })
  expect(result.adopted).toBe(true)
  expect(calls).toBe(3)
  expect(waits).toEqual([30_000, 60_000])
  expect(saved).toEqual([false, false, true])
})

test('成功済み回答は再起動せず再保存する', async () => {
  let calls = 0
  const saved = { adopted: true, response: 'real answer', containmentVerified: true }
  const result = await recoverAdvisorSlot({ advisor: 'grok', saved,
    run: async () => { calls++; return saved }, persist: () => {},
  })
  expect(result).toBe(saved)
  expect(calls).toBe(0)
})

test('認証・設定不備・未回収プロセスは盲目的に再送せず未完了を保つ', async () => {
  for (const failure of [
    { reason: 'Not signed in', containmentVerified: true },
    { reason: 'project is not a Git worktree or pinned workspace', containmentVerified: true },
    { reason: 'timeout', containmentVerified: false },
  ]) {
    let calls = 0
    const result = await recoverAdvisorSlot({ advisor: 'claude',
      run: async () => { calls++; return { adopted: false, ...failure } },
      persist: () => {}, wait: async () => { throw new Error('unexpected retry') },
    })
    expect(calls).toBe(1)
    expect(result.adopted).toBe(false)
  }
})

test('一方の回答は他方が保留中でも直ちに保存される', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const saved: string[] = []
  const fast = recoverAdvisorSlot({ advisor: 'grok',
    run: async () => ({ adopted: true }), persist: () => { saved.push('grok') },
  })
  const slow = recoverAdvisorSlot({ advisor: 'claude',
    run: async () => { await pending; return { adopted: true } }, persist: () => { saved.push('claude') },
  })
  await fast
  expect(saved).toEqual(['grok'])
  release()
  await slow
  expect(saved).toEqual(['grok', 'claude'])
})

test('回復するまで3回を超えて再試行し、tight loopしない', async () => {
  let calls = 0
  const waits: number[] = []
  const result = await recoverAdvisorSlot({ advisor: 'grok',
    run: async () => { calls++; return { adopted: calls === 7, containmentVerified: true, reason: '429' } },
    persist: () => {}, wait: async ms => { waits.push(ms) },
  })
  expect(calls).toBe(7)
  expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000])
  expect(result.adopted).toBe(true)
})

test('Grok認証失敗は回復後に同じslotを取得し、明示中止では再試行しない', async () => {
  let calls = 0
  const controller = new AbortController()
  const error = new Error('cancel')
  await expect(recoverAdvisorSlot({ advisor: 'grok', signal: controller.signal,
    run: async () => { calls++; return { adopted: false, containmentVerified: true, reason: 'Not signed in' } },
    persist: () => {}, wait: async () => { controller.abort(error) },
  })).rejects.toBe(error)
  expect(calls).toBe(1)
  calls = 0
  expect((await recoverAdvisorSlot({ advisor: 'grok',
    run: async () => ({ adopted: ++calls === 5, containmentVerified: true, reason: 'Not signed in' }),
    persist: () => {}, wait: async () => {},
  })).adopted).toBe(true)
  expect(calls).toBe(5)
})


test('Claudeの送達可能性がある失敗と送達不明はfresh再送しない', async () => {
  for (const delivered of [true, undefined]) {
    for (const reason of ['startup failure', 'response missing', 'timeout', 'network error']) {
      let calls = 0
      await recoverAdvisorSlot({ advisor: 'claude',
        run: async () => { calls++; return { adopted: false, containmentVerified: true,
          promptMayHaveBeenDelivered: delivered, reason } },
        persist: () => {}, wait: async () => { throw new Error('must not resend') },
      })
      expect(calls).toBe(1)
    }
  }
})


test('再開時の保存済みClaude送達不明結果も新規起動しない', async () => {
  const saved = { adopted: false, containmentVerified: true, promptMayHaveBeenDelivered: true, reason: 'timeout' }
  let calls = 0
  const result = await recoverAdvisorSlot({ advisor: 'claude', saved,
    run: async () => { calls++; return saved }, persist: () => {},
    wait: async () => { throw new Error('must not resend') },
  })
  expect(result).toBe(saved)
  expect(calls).toBe(0)
})


test('Grokの認証待ちはbackoff中にも通知でき、中止時は新しい実行を開始しない', async () => {
  const controller = new AbortController(); let waiting = false; let retried = false
  await expect(recoverAdvisorSlot({ advisor: 'grok', signal: controller.signal,
    run: async () => ({ adopted: false, containmentVerified: true,
      failure: { advisor: 'grok' as const, cause: 'authentication' as const } }),
    persist: () => {}, onWaiting: () => { waiting = true },
    beforeRetry: () => { retried = true },
    wait: async () => { expect(waiting).toBe(true); controller.abort(new Error('cancel')) },
  })).rejects.toThrow('cancel')
  expect(retried).toBe(false)
})
