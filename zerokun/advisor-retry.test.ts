import { expect, test } from 'bun:test'
import { recoverAdvisorSlot } from './advisor-retry.ts'

test('一時失敗だけ30秒・60秒後に再取得し結果を毎回保存する', async () => {
  let calls = 0
  const waits: number[] = [], saved: boolean[] = []
  const result = await recoverAdvisorSlot({
    advisor: 'claude', run: async () => ({ adopted: ++calls === 3, containmentVerified: true, reason: 'response missing' }),
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

test('3回失敗しても成功へ変換せず返し、tight loopしない', async () => {
  let calls = 0
  const waits: number[] = []
  const result = await recoverAdvisorSlot({ advisor: 'grok',
    run: async () => { calls++; return { adopted: false, containmentVerified: true, reason: '429' } },
    persist: () => {}, wait: async ms => { waits.push(ms) },
  })
  expect(calls).toBe(3)
  expect(waits).toEqual([30_000, 60_000])
  expect(result.adopted).toBe(false)
})
