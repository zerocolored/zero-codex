import { afterEach, expect, test } from 'bun:test'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobStore, publicJobFailureSummary, runQueuedJobs } from './job-runner.ts'
import { CodexCleanupPendingError } from './codex-executor.ts'
import { buildStorageInstructions, isStorageFailure, retainedStorageFailure, STORAGE_FAILURE, STORAGE_FAILURE_MESSAGE } from './storage-failure.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}) })
function fixture(claim = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-storage-'))); roots.push(root)
  const logs = join(root, 'job-logs'); mkdirSync(logs, {mode:0o700})
  const store = new JobStore(join(root, 'jobs.sqlite3'))
  const job = store.enqueue({chatId:'C1',threadTs:'100.001',messageId:'100.001',userId:'U1',
    repoPath:root,task:'build the app',writeEnabled:true}).job
  if (claim) store.claimNext('worker')
  const running = store.get(job.id)!
  const path = join(logs, `${job.id}.resume.stderr.log`)
  return {root,logs,store,job:running,path}
}
const full = "Codex cleanup is pending; retaining supervisor registration: Error: ENOSPC: no space left on device, rename '/private/sensitive.tmp' -> '/private/sensitive'\n"

test('disk-full cause survives monitor loss and durable restart without replay or raw paths', () => {
  const f = fixture()
  writeFileSync(f.path, full, {mode:0o600})
  f.store.close()
  const reopened = new JobStore(join(f.root,'jobs.sqlite3'))
  try {
    expect(reopened.failAfterMonitorLoss(f.job.id,'monitor was lost',f.root)).toBe(true)
    expect(reopened.get(f.job.id)?.lastError).toBe(STORAGE_FAILURE)
    expect(publicJobFailureSummary(reopened.get(f.job.id)!.lastError!)).toBe(STORAGE_FAILURE_MESSAGE)
    expect(reopened.pendingTerminalNotifications()).toHaveLength(1)
    expect(reopened.claimNext('retry')).toBeNull()
    expect(reopened.failAfterMonitorLoss(f.job.id,'duplicate',f.root)).toBe(false)
    expect(reopened.pendingTerminalNotifications()).toHaveLength(1)
  } finally { reopened.close() }
})

test('interrupted write recovery preserves storage cause instead of the uncertain-effects fallback', () => {
  const f=fixture()
  try {
    writeFileSync(f.path, full, {mode:0o600})
    expect(f.store.recoverInterrupted(f.root).failedWrites).toBe(1)
    expect(f.store.get(f.job.id)?.lastError).toBe(STORAGE_FAILURE)
    expect(f.store.get(f.job.id)?.status).toBe('failed')
  } finally { f.store.close() }
})

test('saved fixed storage cause survives absent stderr and monitor recovery', () => {
  const f=fixture()
  try {
    f.store.rememberStorageFailure(f.job.id)
    expect(f.store.failAfterMonitorLoss(f.job.id,'monitor lost',f.root)).toBe(true)
    expect(f.store.get(f.job.id)?.lastError).toBe(STORAGE_FAILURE)
  } finally { f.store.close() }
})

test('worker preserves ENOSPC while cleanup remains pending, then restart emits one safe failure', async () => {
  const f=fixture(false)
  const failure=new CodexCleanupPendingError('Codex supervisor retained uncertain cleanup')
  try {
    await expect(runQueuedJobs({store:f.store,maxJobsPerSession:20,stopWhenIdle:true,
      advisorStateDir:f.root,onLog:()=>{},executor:async () => {
        writeFileSync(f.path,full,{mode:0o600})
        throw failure
      },
    })).rejects.toBe(failure)
    expect(f.store.get(f.job.id)?.status).toBe('running')
    expect(f.store.get(f.job.id)?.lastError).toBe(STORAGE_FAILURE)
    expect(f.store.pendingTerminalNotifications()).toHaveLength(0)
    rmSync(f.path)
    f.store.recoverInterrupted(f.root)
    expect(f.store.get(f.job.id)?.lastError).toBe(STORAGE_FAILURE)
    expect(f.store.pendingTerminalNotifications()).toHaveLength(1)
  } finally { f.store.close() }
})

test('a disk-full write failure stays specific when prior external effects are uncertain', async () => {
  const f = fixture(false)
  f.store.writePhaseMayHaveBeenDelivered = () => true
  try {
    const result = await runQueuedJobs({store:f.store,stopWhenIdle:true,onLog:()=>{},
      advisorStateDir:f.root,executor:async () => { throw Object.assign(Error('write failed'), {code:'ENOSPC'}) },
    })
    expect(result.failed).toBe(1)
    expect(f.store.get(f.job.id)?.status).toBe('failed')
    expect(f.store.get(f.job.id)?.lastError).toBe(STORAGE_FAILURE)
    expect(publicJobFailureSummary(f.store.get(f.job.id)!.lastError!)).toBe(STORAGE_FAILURE_MESSAGE)
    expect(f.store.claimNext('retry')).toBeNull()
    expect(f.store.pendingTerminalNotifications()).toHaveLength(1)
  } finally { f.store.close() }
})

test('ordinary text, another job, old attempts and unsafe diagnostic files cannot change the cause', () => {
  const f=fixture()
  try {
    writeFileSync(f.path,'user requested ENOSPC reproduction\n'+JSON.stringify({type:'agentMessage',message:full}),{mode:0o600})
    writeFileSync(join(f.logs,'another-job.resume.stderr.log'),full,{mode:0o600})
    expect(retainedStorageFailure(f.root,f.job)).toBeNull()
    writeFileSync(f.path,full)
    utimesSync(f.path,new Date(0),new Date(0))
    expect(retainedStorageFailure(f.root,f.job)).toBeNull()
    rmSync(f.path)
    symlinkSync(join(f.logs,'another-job.resume.stderr.log'),f.path)
    expect(retainedStorageFailure(f.root,f.job)).toBeNull()
    rmSync(f.path)
    linkSync(join(f.logs,'another-job.resume.stderr.log'),f.path)
    expect(retainedStorageFailure(f.root,f.job)).toBeNull()
    expect(f.store.failAfterMonitorLoss(f.job.id,'monitor genuinely lost',f.root)).toBe(true)
    expect(f.store.get(f.job.id)?.lastError).toBe('monitor genuinely lost')
  } finally { f.store.close() }
})

test('bounded tail handles large logs and ignores a partial first record', () => {
  const f=fixture()
  try {
    writeFileSync(f.path,'x'.repeat(100_000)+'\n'+full,{mode:0o600})
    expect(retainedStorageFailure(f.root,f.job)).toBe(STORAGE_FAILURE)
    writeFileSync(f.path,full+'x'.repeat(100_000))
    expect(retainedStorageFailure(f.root,f.job)).toBeNull()
    expect(retainedStorageFailure(f.root,{id:'../foreign',startedAt:0})).toBeNull()
    expect(retainedStorageFailure(f.root,{id:f.job.id,startedAt:null})).toBeNull()
  } finally {f.store.close()}
})

test('fixed safe messages classify real OS failures and exact monitor loss', () => {
  expect(isStorageFailure(Object.assign(Error('write failed'),{code:'ENOSPC'}))).toBe(true)
  expect(isStorageFailure(Object.assign(Error('write failed'),{code:'SQLITE_FULL'}))).toBe(true)
  expect(isStorageFailure(Object.assign(Error("ENOENT: no such file or directory, open '/tmp/ENOSPC/input'"),{code:'ENOENT'}))).toBe(false)
  expect(isStorageFailure(Object.assign(Error('No space left on device'),{code:'EACCES'}))).toBe(false)
  expect(isStorageFailure("ENOENT: no such file, open '/tmp/ENOSPC/input'")).toBe(false)
  expect(isStorageFailure('user quoted ENOSPC: disk full')).toBe(false)
  expect(publicJobFailureSummary('user quoted ENOSPC: disk full')).not.toBe(STORAGE_FAILURE_MESSAGE)
  expect(isStorageFailure(Error('database or disk is full'))).toBe(true)
  expect(isStorageFailure('Error: ENOSPC: no space left on device')).toBe(true)
  expect(publicJobFailureSummary('ENOSPC: secret path /private/example')).toBe(STORAGE_FAILURE_MESSAGE)
  const monitor='監視タブが失われたため、安全に処理状態を復旧できませんでした。実行プロセスの停止を確認して、この依頼を失敗として終了しました。必要なら再送してください。'
  expect(publicJobFailureSummary(monitor)).toBe(monitor)
  expect(publicJobFailureSummary(monitor+' secret')).not.toContain('secret')
})

test('build guidance includes current capacity without making telemetry or cleanup an execution gate', () => {
  const f=fixture()
  try {
    expect(buildStorageInstructions(f.root)).toContain('filesystem free space')
    expect(buildStorageInstructions(f.root)).toContain('do not duplicate generated Unity Library')
    expect(buildStorageInstructions(f.root)).toContain('Preserve source edits')
    expect(buildStorageInstructions(join(f.root,'missing'))).not.toContain('filesystem free space')
    expect(buildStorageInstructions(join(f.root,'missing'))).toContain('Before large builds')
  } finally { f.store.close() }
})
