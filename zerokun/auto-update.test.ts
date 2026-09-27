import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AUTO_UPDATE_INTERVAL_MS, automaticUpdateRecipient, checkAutomaticUpdate, configureAutomaticUpdates, automaticUpdatesEnabled, remoteUpdateHead } from './auto-update.ts'
import { requestUpdate, runUpdateWorker, resumePendingUpdateWorker } from './update-request.ts'
import { tryAcquireProcessLock, releaseProcessLock } from './process-lock.ts'
import { withUpdateTestPolicy } from './update.ts'

const roots: string[] = []
function temp() { const root = mkdtempSync(join(tmpdir(), 'zero-auto-test-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test('shared scheduler checks once per interval and opt-out persists', async () => {
  const root = temp(); let checks = 0; let now = 0
  const options = { root, stateDir: root, now: () => now,
    detect: async () => { checks++; return undefined },
    enqueue: async () => { throw new Error('must not enqueue') } }
  expect(await checkAutomaticUpdate(options)).toBe('current')
  expect(await checkAutomaticUpdate(options)).toBe('not-due')
  now += AUTO_UPDATE_INTERVAL_MS
  expect(await checkAutomaticUpdate(options)).toBe('current')
  configureAutomaticUpdates(root, false)
  expect(automaticUpdatesEnabled(root)).toBe(false)
  now += AUTO_UPDATE_INTERVAL_MS
  expect(await checkAutomaticUpdate(options)).toBe('disabled')
  expect(checks).toBe(2)
})

test('two apps cannot schedule twice; durable pending survives restart and interval', async () => {
  const root = temp(); const stateDir = temp(); let calls = 0; let now = 100
  let unblock!: () => void
  const wait = new Promise<void>(resolve => { unblock = resolve })
  const options = { root, stateDir, now: () => now,
    detect: async () => { await wait; return 'a'.repeat(40) },
    enqueue: async () => { calls++; writeFileSync(join(stateDir, 'update-request.json'), JSON.stringify({ id: 'one' }), { mode: 0o600 }); return { accepted: true, request: { id: 'one' } } } }
  const first = checkAutomaticUpdate(options)
  expect(await checkAutomaticUpdate({ ...options, stateDir: temp() })).toBe('busy')
  unblock(); expect(await first).toBe('scheduled')
  now += AUTO_UPDATE_INTERVAL_MS * 4
  expect(await checkAutomaticUpdate(options)).toBe('pending')
  expect(calls).toBe(1)
})

test('network failure backs off without poisoning normal work', async () => {
  const root = temp(); let calls = 0
  const options = { root, stateDir: root, now: () => 100,
    detect: async () => { calls++; throw new Error('offline') },
    enqueue: async () => { throw new Error('unexpected') } }
  await expect(checkAutomaticUpdate(options)).rejects.toThrow('offline')
  expect(await checkAutomaticUpdate(options)).toBe('not-due')
  expect(calls).toBe(1)
})

test('manual updater lock prevents automatic polling and enqueue', async () => {
  const root = temp(); const path = join(root, 'shared-update.lock'); const lock = tryAcquireProcessLock(path)
  expect(lock.acquired).toBe(true)
  try {
    expect(await checkAutomaticUpdate({ root, stateDir: root,
      detect: async () => { throw new Error('no fetch while updating') },
      enqueue: async () => { throw new Error('no duplicate update') },
    })).toBe('busy')
  } finally { if (lock.acquired) releaseProcessLock(path, lock.lease) }
})

test('off during remote check prevents update reservation', async () => {
  const root = temp()
  expect(await checkAutomaticUpdate({ root, stateDir: root,
    detect: async () => { configureAutomaticUpdates(root, false); return 'a'.repeat(40) },
    enqueue: async () => { throw new Error('disabled') },
  })).toBe('disabled')
})

test('failed version is not retried and notified repeatedly; newer version is scheduled', async () => {
  const root = temp(); const stateDir = temp(); let now = AUTO_UPDATE_INTERVAL_MS * 2; let sha = 'a'.repeat(40); let attempts = 0
  writeFileSync(join(root, 'auto-update-check.json'), JSON.stringify({ pendingState: stateDir, pendingId: 'old', checkedAt: 1, targetSha: sha }), { mode: 0o600 })
  writeFileSync(join(stateDir, 'update-request.json'), JSON.stringify({ id: 'old', outcome: { success: false, completedAt: 2, notifiedAt: 3 } }), { mode: 0o600 })
  const options = { root, stateDir, now: () => now, detect: async () => sha,
    enqueue: async () => { attempts++; return { accepted: true, request: { id: 'new' } } },
  }
  expect(await checkAutomaticUpdate(options)).toBe('failed-version')
  now += AUTO_UPDATE_INTERVAL_MS
  expect(await checkAutomaticUpdate(options)).toBe('failed-version')
  expect(attempts).toBe(0)
  now += AUTO_UPDATE_INTERVAL_MS; sha = 'b'.repeat(40)
  expect(await checkAutomaticUpdate(options)).toBe('scheduled')
  expect(attempts).toBe(1)
})

test('automatic request retains manual outcome awaiting notification', async () => {
  const stateDir = temp(); const launched: string[] = []
  const options = { stateDir, isWorkerRunning: () => false, isUpdateRunning: () => false,
    launchWorker: (request: { id: string }) => { launched.push(request.id) },
  }
  const manual = await requestUpdate({ chatId: 'C123', threadTs: '123.45', userId: 'U123', messageId: '123.46' }, options)
  await runUpdateWorker(manual.request.id, { stateDir, executeUpdater: async () => 0, maxNotifyAttempts: 1,
    notify: async () => { throw new Error('offline') },
  })
  const result = await requestUpdate({ source: 'automatic', chatId: 'C999', threadTs: '', userId: '', messageId: 'auto' }, options)
  expect(result.accepted).toBe(false)
  expect(result.request.id).toBe(manual.request.id)
  expect(launched).toEqual([manual.request.id, manual.request.id])
})

test('failed SHA persists during cooldown even if manual request replaces its outcome', async () => {
  const root = temp(); const stateDir = temp(); const sha = 'a'.repeat(40); let now = 100
  writeFileSync(join(root, 'auto-update-check.json'), JSON.stringify({ pendingState: stateDir, pendingId: 'old', checkedAt: 1, targetSha: sha }), { mode: 0o600 })
  writeFileSync(join(stateDir, 'update-request.json'), JSON.stringify({ id: 'old', outcome: { success: false, completedAt: 90, notifiedAt: 91 } }), { mode: 0o600 })
  const options = { root, stateDir, now: () => now, detect: async () => sha,
    enqueue: async () => { throw new Error('must not repeat failed version') },
  }
  expect(await checkAutomaticUpdate(options)).toBe('not-due')
  writeFileSync(join(stateDir, 'update-request.json'), JSON.stringify({ id: 'manual' }), { mode: 0o600 })
  now += AUTO_UPDATE_INTERVAL_MS
  expect(await checkAutomaticUpdate(options)).toBe('failed-version')
})

test('another app recovers the originating app durable worker instead of blocking forever', async () => {
  const root = temp(); const original = temp(); const other = temp(); const recovered: string[] = []
  const pending = await requestUpdate({ source: 'automatic', chatId: 'C123', threadTs: '', userId: '', messageId: 'auto:old' }, {
    stateDir: original, isWorkerRunning: () => false, isUpdateRunning: () => false, launchWorker: () => {},
  })
  writeFileSync(join(root, 'auto-update-check.json'), JSON.stringify({ pendingState: original, pendingId: pending.request.id, checkedAt: 1 }), { mode: 0o600 })
  const result = await checkAutomaticUpdate({ root, stateDir: other, now: () => AUTO_UPDATE_INTERVAL_MS * 2,
    detect: async () => { throw new Error('do not schedule another update') },
    enqueue: async () => { throw new Error('do not schedule another update') },
    recoverPending: state => {
      resumePendingUpdateWorker({ stateDir: state, isWorkerRunning: () => false, isUpdateRunning: () => false,
        launchWorker: request => { expect(request.id).toBe(pending.request.id); recovered.push(state) },
      })
    },
  })
  expect(result).toBe('pending')
  expect(recovered).toEqual([original])
})

test('automatic request survives worker restart and sends outcome without rerunning update', async () => {
  const stateDir = temp(); let runs = 0; const messages: string[] = []
  const result = await requestUpdate({ source: 'automatic', chatId: 'U123', threadTs: '', userId: '', messageId: 'auto:one' }, {
    stateDir, isWorkerRunning: () => false, isUpdateRunning: () => false, launchWorker: () => {},
  })
  const options = { stateDir, executeUpdater: async () => { runs++; return 0 },
    notify: async (request: any, text: string) => { expect(request.source).toBe('automatic'); expect(request.threadTs).toBe(''); messages.push(text) },
  }
  expect((await runUpdateWorker(result.request.id, options)).success).toBe(true)
  expect(messages).toEqual(['最新版の自動アップデートが完了しました'])
  expect(runs).toBe(1)
  await runUpdateWorker(result.request.id, options)
  expect(runs).toBe(1)
  expect(messages).toHaveLength(1)
})

test('public CLI persists off/on across processes without project or tokens', () => {
  const home = temp(); const command = join(home, 'zerochan')
  symlinkSync(join(import.meta.dir, '..', 'codex-channel.sh'), command)
  const run = (value: string) => {
    const result = Bun.spawnSync(['bash', command, 'auto-update', value], {
      cwd: home, env: { HOME: home, PATH: process.env.PATH! }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    return result.stdout.toString()
  }
  expect(run('off')).toContain('無効')
  expect(run('status')).toContain('無効')
  expect(run('on')).toContain('有効')
  expect(run('status')).toContain('有効')
})

test('automatic DM failure is terminal without changing failed updater outcome', async () => {
  const stateDir = temp(); let runs = 0
  const pending = await requestUpdate({ source: 'automatic', chatId: 'U123', threadTs: '', userId: '', messageId: 'auto:failure' }, {
    stateDir, isWorkerRunning: () => false, isUpdateRunning: () => false, launchWorker: () => {},
  })
  const executeUpdater = async () => { runs++; return 9 }
  expect((await runUpdateWorker(pending.request.id, { stateDir, executeUpdater, maxNotifyAttempts: 1,
    notify: async () => { throw new Error('offline') },
  })).notificationSent).toBe(false)
  let text = ''
  expect((await runUpdateWorker(pending.request.id, { stateDir, executeUpdater,
    notify: async (_, value) => { text = value },
  })).notificationSkipped).toBe(true)
  expect(runs).toBe(1)
  expect(text).toBe('')
  expect(resumePendingUpdateWorker({ stateDir, isWorkerRunning: () => false, launchWorker: () => { throw new Error('must not launch') } })).toBe(false)
})

test('automatic recipients never fall back to channel IDs', () => {
  expect(automaticUpdateRecipient([])).toBe('')
  expect(automaticUpdateRecipient(['C123', 'G123'])).toBe('')
  expect(automaticUpdateRecipient(['', 'U123', 'U456'])).toBe('U123')
  expect(automaticUpdateRecipient(['W123'])).toBe('W123')
})

test('real notification path addresses personal DM without a thread or channel fallback', async () => {
  const stateDir = temp()
  writeFileSync(join(stateDir, '.env'), 'SLACK_BOT_TOKEN=xoxb-0123456789abcdef\nSLACK_APP_TOKEN=xapp-1-A0TESTAPP-1234567890abcdef\n')
  const pending = await requestUpdate({ source: 'automatic', chatId: 'U123', threadTs: '', userId: '', messageId: 'auto:api' }, {
    stateDir, isWorkerRunning: () => false, isUpdateRunning: () => false, launchWorker: () => {},
  })
  const originalFetch = globalThis.fetch; const messages: any[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    const endpoint = String(url)
    if (endpoint.endsWith('chat.postMessage')) messages.push(JSON.parse(init.body))
    return Response.json(endpoint.endsWith('auth.test')
      ? { ok: true, app_id: 'A0TESTAPP', bot_id: 'B0TESTBOT', user_id: 'U0TESTBOT' }
      : endpoint.endsWith('bots.info') ? { ok: true, bot: { app_id: 'A0TESTAPP' } } : { ok: true })
  }) as typeof fetch
  try {
    expect((await runUpdateWorker(pending.request.id, { stateDir, executeUpdater: async () => 0 })).notificationSent).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0].channel).toBe('U123')
    expect(messages[0].thread_ts).toBeUndefined()
  } finally { globalThis.fetch = originalFetch }
})

test('scheduler never recovers a skipped automatic notification', async () => {
  const root = temp(); const completedAt = Date.now()
  writeFileSync(join(root, 'auto-update-check.json'), JSON.stringify({ pendingState: root, pendingId: 'skip', checkedAt: completedAt }))
  writeFileSync(join(root, 'update-request.json'), JSON.stringify({ id: 'skip', source: 'automatic', outcome: { success: true, completedAt, notificationSkippedAt: completedAt } }))
  expect(await checkAutomaticUpdate({ root, stateDir: root, now: () => completedAt + 1,
    detect: async () => { throw new Error('not due') }, enqueue: async () => { throw new Error('not due') },
    recoverPending: () => { throw new Error('must not recover') },
  })).toBe('not-due')
})

for (const chatId of ['', 'C123', 'G123']) test(`automatic update without DM (${chatId}) completes silently and durably`, async () => {
  const stateDir = temp(); let runs = 0; let sent = 0
  const input = { source: 'automatic' as const, chatId, threadTs: '', userId: '', messageId: 'auto:silent' }
  const settings = { stateDir, isWorkerRunning: () => false, isUpdateRunning: () => false, launchWorker: () => {} }
  const pending = await requestUpdate(input, settings)
  const options = { stateDir, executeUpdater: async () => { runs++; return 0 }, notify: async () => { sent++ } }
  expect(await runUpdateWorker(pending.request.id, options)).toEqual({ success: true, exitCode: 0, notificationSent: false, notificationSkipped: true })
  await runUpdateWorker(pending.request.id, options)
  expect(runs).toBe(1); expect(sent).toBe(0)
  expect(resumePendingUpdateWorker(settings)).toBe(false)
  expect((await requestUpdate(input, settings)).duplicate).toBe(true)
  expect((await requestUpdate({ ...input, messageId: 'auto:next' }, settings)).accepted).toBe(true)
})

test('real local git remote: only clean main behind remote is scheduled', async () => {
  const root = temp(); const remote = join(root, 'remote'); const local = join(root, 'local'); const writer = join(root, 'writer')
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(0)
    return result.stdout.toString().trim()
  }
  git(root, 'init', '--bare', '--initial-branch=main', remote)
  git(root, 'clone', remote, writer)
  git(writer, 'config', 'user.name', 'Test'); git(writer, 'config', 'user.email', 'test@example.invalid')
  git(writer, 'commit', '--allow-empty', '-m', 'first'); git(writer, 'push', 'origin', 'main')
  git(root, 'clone', remote, local)
  expect(await withUpdateTestPolicy(() => remoteUpdateHead(local))).toBeUndefined()
  git(writer, 'commit', '--allow-empty', '-m', 'second'); git(writer, 'push', 'origin', 'main')
  expect(await withUpdateTestPolicy(() => remoteUpdateHead(local))).toBe(git(writer, 'rev-parse', 'HEAD'))
  writeFileSync(join(local, 'user-work'), 'preserve')
  await expect(withUpdateTestPolicy(() => remoteUpdateHead(local))).rejects.toThrow('未コミット変更')
  expect(git(local, 'status', '--porcelain')).toContain('user-work')
})
