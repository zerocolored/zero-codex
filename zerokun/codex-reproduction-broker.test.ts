import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { CodexReproductions, reproductionRequest, type ReproductionContext } from './codex-reproduction-broker.ts'
import { prepareManagedStateRoot, ensureManagedDirectory } from './managed-path.ts'
import { runBounded } from './advisor-broker.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-reproduction-test-'))); roots.push(root)
  const stateDir = prepareManagedStateRoot(join(root, 'state'))
  const repo = join(root, 'repo'); mkdirSync(repo)
  const id = 'job', scratchDir = ensureManagedDirectory(stateDir, join(stateDir, 'tmp', id)), artifactDir = ensureManagedDirectory(stateDir, join(stateDir, 'outbox', id)), liveInputDir = ensureManagedDirectory(stateDir, join(stateDir, 'live-input', id))
  const context = { version: 1, stateDir, scratchDir, artifactDir, liveInputDir, fingerprintAllowPath: '', job: { id, repoPath: repo, writeEnabled: true, attachments: [] } } as ReproductionContext
  const request = join(scratchDir, 'prompt.txt'); writeFileSync(request, 'Exact original request: view bearer vs callback; Authorization: Bearer synthetic-example.\n', { mode: 0o600 })
  return { context, request, workspace: scratchDir }
}
test('独立execへ原文bytesを渡し、完了記録を再利用して二重実行しない', async () => {
  const f = fixture(); let count = 0, final = ''
  const runs = new CodexReproductions(f.context, async (_ctx, _cwd, path) => { final = path; return { argv: ['fake-codex'], environment: {} } }, async (_argv, options) => {
    count++; expect(Buffer.from(options.stdin!).toString()).toBe('Exact original request: view bearer vs callback; Authorization: Bearer synthetic-example.\n')
    writeFileSync(final, 'Finished', { mode: 0o600 })
    return { exitCode: 0, stdout: '{"type":"thread.started"}\n', stderr: '', timedOut: false, forcedCleanup: false, outputTruncated: false }
  })
  const started = runs.start(f.request, f.workspace); await runs.settled()
  expect(runs.poll(started.id).status).toBe('completed')
  expect(runs.start(f.request, f.workspace).status).toBe('completed'); expect(count).toBe(1)
  const receipt = JSON.parse(readFileSync(started.receiptPath, 'utf8'))
  expect(receipt.comparisonVerified).toBe(false)
  expect(receipt.promptSha256).toBe(createHash('sha256').update(readFileSync(f.request)).digest('hex'))
  await runs.close()
})
test('exit0でも最終回答欠落を完了としない', async () => {
  const f = fixture()
  const runs = new CodexReproductions(f.context, async () => ({ argv: ['fake'], environment: {} }), async () => ({ exitCode: 0, stdout: '{"type":"thread.started"}', stderr: '', timedOut: false, forcedCleanup: false, outputTruncated: false }))
  const started = runs.start(f.request, f.workspace); await runs.settled(); expect(runs.poll(started.id).status).toBe('failed'); await runs.close()
})
test('兄弟jobのprompt、workspace、symlinkを拒否する', () => {
  const f = fixture(), other = ensureManagedDirectory(f.context.stateDir, join(f.context.stateDir, 'tmp', 'other'))
  expect(() => reproductionRequest(f.context, f.request, other)).toThrow()
  const foreign = join(other, 'prompt'); writeFileSync(foreign, 'x', { mode: 0o600 })
  expect(() => reproductionRequest(f.context, foreign, f.workspace)).toThrow()
  const link = join(f.workspace, 'link'); symlinkSync(foreign, link)
  expect(() => reproductionRequest(f.context, link, f.workspace)).toThrow()
})
test('取消は起動済みowned processを終了・回収する', async () => {
  const controller = new AbortController()
  const result = runBounded([process.execPath, '-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, terminationGraceMs: 50 })
  setTimeout(() => controller.abort(), 100)
  const ran = await result
  expect(ran.exitCode).not.toBe(0); expect(ran.timedOut).toBe(false)
}, 10000)
test('exit callback欠落でも実際の終了と終了コードを観測して無期限待機を解消する', async () => {
  const result = await runBounded(['/bin/sh', '-c', 'sleep 0.1; printf done; exit 7'], {
    exitCallbackForTesting: () => new Promise(() => {}),
  })
  expect(result.exitCode).toBe(7)
  expect(result.stdout).toBe('done')
  expect(result.timedOut).toBe(false)
}, 5_000)

test('実行要求を子へ渡す前にowned processを保存し、保存失敗時には要求を実行しない', async () => {
  const f = fixture(), touched = join(f.workspace, 'must-not-exist')
  let pid = 0
  await expect(runBounded(['/bin/sh'], {
    stdin: `printf unsafe > ${JSON.stringify(touched)}\n`,
    onSpawn: value => { pid = value; throw new Error('fixture persistence failure') },
    terminationGraceMs: 20,
  })).rejects.toThrow('identity could not be tracked')
  expect(pid).toBeGreaterThan(1)
  const { readProcessIdentity } = await import('./process-generation.ts')
  expect(readProcessIdentity(pid)).toBeUndefined()
  expect(existsSync(touched)).toBe(false)
})
test('host最終出力はモデル可書込outboxを使わず、broker再起動後も同一実行を再利用する', async () => {
  const f = fixture(); let final = ''
  const command = async (_ctx: ReproductionContext, _cwd: string, path: string) => { final = path; expect(path.startsWith(join(f.context.stateDir, 'reproductions'))).toBe(true); return { argv: ['fake'], environment: {} } }
  const run = async () => { writeFileSync(final, 'verified', { mode: 0o600 }); return { exitCode: 0, stdout: '{"type":"thread.started"}', stderr: '', timedOut: false, forcedCleanup: false, outputTruncated: false } }
  const first = new CodexReproductions(f.context, command, run)
  const started = first.start(f.request, f.workspace); await first.settled(); await first.close()
  expect(started.finalPath.startsWith(f.context.liveInputDir)).toBe(true)
  const second = new CodexReproductions(f.context, async () => { throw new Error('must not run twice') })
  expect(second.start(f.request, f.workspace).status).toBe('completed'); await second.close()
})
test('broker取消でも子を回収し、中断記録を保持する', async () => {
  const f = fixture()
  const runs = new CodexReproductions(f.context, async () => ({ argv: [process.execPath, '-e', 'process.stdin.resume();setInterval(()=>{},1000)'], environment: {} }))
  const started = runs.start(f.request, f.workspace)
  await Bun.sleep(100)
  const lock = join(f.context.stateDir, 'reproductions', f.context.job.id, started.id, 'process.lock')
  const identity = JSON.parse(readFileSync(lock + '.identity', 'utf8'))
  expect(identity.delegate.pid).not.toBe(process.pid)
  expect(identity.delegate.groupId).toBe(identity.delegate.pid)
  expect(identity.delegate.bootSession).toBeDefined()
  await runs.close(); expect(runs.poll(started.id).status).toBe('interrupted')
  expect(existsSync(lock)).toBe(false)
}, 10000)
test('確認されたowned子孫残存は通常失敗にせず、後続実行と正常closeを拒否する', async () => {
  const { AdvisorOwnedProcessStillLiveError } = await import('./advisor-broker.ts')
  const f = fixture()
  const runs = new CodexReproductions(f.context, async () => ({ argv: ['fake'], environment: {} }), async () => { throw new AdvisorOwnedProcessStillLiveError('synthetic remaining process') })
  const started = runs.start(f.request, f.workspace)
  await expect(runs.settled()).rejects.toBeInstanceOf(AdvisorOwnedProcessStillLiveError)
  expect(() => runs.poll(started.id)).toThrow(AdvisorOwnedProcessStillLiveError)
  expect(() => runs.start(f.request, f.workspace)).toThrow()
  await expect(runs.close()).rejects.toBeInstanceOf(AdvisorOwnedProcessStillLiveError)
})
test('診断書込み失敗でも確認済み子孫残存の封じ込め状態を失わない', async () => {
  const { AdvisorOwnedProcessStillLiveError } = await import('./advisor-broker.ts')
  const f = fixture(); let hostFinal = ''
  const runs = new CodexReproductions(f.context, async (_ctx, _cwd, path) => { hostFinal = path; return { argv: ['fake'], environment: {} } }, async () => {
    mkdirSync(join(hostFinal, '..', 'startup-error.json'))
    throw new AdvisorOwnedProcessStillLiveError('synthetic remaining process')
  })
  const started = runs.start(f.request, f.workspace)
  await expect(runs.settled()).rejects.toBeInstanceOf(AdvisorOwnedProcessStillLiveError)
  expect(() => runs.poll(started.id)).toThrow(AdvisorOwnedProcessStillLiveError)
  expect(() => runs.start(f.request, f.workspace)).toThrow()
  await expect(runs.close()).rejects.toBeInstanceOf(AdvisorOwnedProcessStillLiveError)
})
test('正常終了後は1時間deadlineを残さず呼出し元processも終了する', async () => {
  const module = new URL('./advisor-broker.ts', import.meta.url).pathname
  const code = `import {runBounded} from ${JSON.stringify(module)}; const r=await runBounded(['/bin/sleep','0.2'],{timeoutMs:3600000});process.exitCode=r.exitCode`
  const process = Bun.spawn([Bun.which('bun')!, '--config=/dev/null', '--no-env-file', '-e', code], { stdout: 'ignore', stderr: 'ignore' })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([process.exited, new Promise<string>(resolve => { timer = setTimeout(() => resolve('caller-still-live'), 5000) })])
    expect(outcome).toBe(0)
  } finally { if (timer) clearTimeout(timer); if (process.exitCode === null) { process.kill(); await process.exited } }
}, 10000)
test('preflightの子孫残存も封じ込め失敗とし、同一executorのbroker再起動後も新しい依頼を止める', async () => {
  const { CodexOwnedProcessStillLiveError } = await import('./codex-executor.ts')
  const { AdvisorOwnedProcessStillLiveError } = await import('./advisor-broker.ts')
  const f = fixture()
  const first = new CodexReproductions(f.context, async () => { throw new CodexOwnedProcessStillLiveError('synthetic preflight residual') })
  const started = first.start(f.request, f.workspace)
  await expect(first.settled()).rejects.toBeInstanceOf(AdvisorOwnedProcessStillLiveError)
  expect(() => first.poll(started.id)).toThrow(AdvisorOwnedProcessStillLiveError)
  const second = new CodexReproductions(f.context, async () => { throw new Error('must not execute') })
  writeFileSync(f.request, 'Different request', { mode: 0o600 })
  expect(() => second.start(f.request, f.workspace)).toThrow('requires host containment')
  await second.close(); await expect(first.close()).rejects.toBeInstanceOf(AdvisorOwnedProcessStillLiveError)
})
