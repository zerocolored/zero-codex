import { expect, test } from 'bun:test'
import { waitForDirectExit } from './subprocess-exit-wait.ts'

const pending = () => new Promise<number>(() => {})

test('lost callback reconciles a dead child using the actual failure status', async () => {
  const warnings: string[] = []
  expect(await waitForDirectExit({ callback: pending(),
    state: () => ({ exitCode: 17, signalCode: null, generation: 'dead' }),
    warn: reason => warnings.push(reason),
  })).toBe(17)
  expect(warnings).toEqual(['metadata-without-callback'])
})

test('missing exit status never becomes success', async () => {
  expect(await waitForDirectExit({ callback: pending(),
    state: () => ({ exitCode: null, signalCode: null, generation: 'dead' }),
    warn: () => {}, pollMs: 1, deadGraceMs: 2,
  })).toBe(1)
})

test('lost callback preserves signal exit status', async () => {
  expect(await waitForDirectExit({ callback: pending(),
    state: () => ({ exitCode: null, signalCode: 'SIGTERM', generation: 'dead' }),
    warn: () => {},
  })).toBe(143)
})

test('late callback wins during the dead-child status grace period', async () => {
  const callback = Bun.sleep(5).then(() => 29)
  expect(await waitForDirectExit({ callback,
    state: () => ({ exitCode: null, signalCode: null, generation: 'dead' }),
    warn: () => { throw new Error('callback should arrive before reconciliation') },
    pollMs: 1, deadGraceMs: 100,
  })).toBe(29)
})

test('live and unknown generations wait for the real exit callback', async () => {
  for (const generation of ['alive', 'unknown'] as const) {
    let resolve!: (code: number) => void
    const callback = new Promise<number>(r => { resolve = r })
    let settled = false
    const result = waitForDirectExit({ callback,
      state: () => ({ exitCode: null, signalCode: null, generation }),
      warn: () => { throw new Error('must not reconcile') }, pollMs: 1, deadGraceMs: 1,
    }).then(code => { settled = true; return code })
    await Bun.sleep(10)
    expect(settled).toBe(false)
    resolve(23)
    expect(await result).toBe(23)
  }
})
