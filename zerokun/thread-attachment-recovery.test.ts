import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { JobStore } from './job-runner.ts'
import { loadCachedInboundAttachment } from './inbound-attachment-cache.ts'
import { buildCodexWorkerPrompt } from './codex-executor.ts'
import { recoverThreadAttachments, type PendingThreadAttachment } from './thread-attachment-recovery.ts'

function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'zero-recover-attachments-')))
  const dbPath=join(root,'jobs.sqlite3')
  let store=new JobStore(dbPath)
  const scope={chatId:'C1',threadTs:'1900000000.000001',repoPath:root}
  const base={...scope,userId:'U1',writeEnabled:false}
  const stage=(messageId:string,fileIds:string[]=[],text='再度読んでみて') => {
    store.stageInboundDeliveryAndAdoptSlackThread({...base,messageId,text,fileIds},
      {appId:'A1',initialContextEligible:false})
    return store.claimNextInboundDelivery()!
  }
  const cached=(messageId:string,fileId:string,ordinal:number) => {
    const directory=join(root,'inbox',messageId)
    mkdirSync(directory,{recursive:true,mode:0o700})
    writeFileSync(join(directory,`${fileId}.mp4`),'synthetic audio/video bytes',{mode:0o600})
    return loadCachedInboundAttachment({inboxDir:join(root,'inbox'),messageTs:messageId,fileId,ordinal})!
  }
  return {root,dbPath,scope,base,stage,cached,get store(){return store},
    restart(){store.close();store=new JobStore(dbPath)},
    close(){store.close();rmSync(root,{recursive:true,force:true})}}
}

test('failed intake survives restart and GC; text-only retry recovers original source and ordinal without replay', async () => {
  const f=fixture()
  try {
    const original=f.stage(f.scope.threadTs,['FDONE','FAUDIO'],'これ、音声は聞こえる？')
    f.store.recordInboundDownloadedFile(original.idempotencyKey,f.cached(original.messageId,'FDONE',0))
    const failed=f.store.failInboundDelivery(original.idempotencyKey,'Slack入力の準備を5回試みましたが失敗しました: larger than 50MB')
    expect(f.store.pendingThreadAttachments(f.scope).map(s=>[s.fileId,s.ordinal])).toEqual([['FAUDIO',1]])
    f.restart()
    const retry=f.stage('1900000001.000001')
    let calls=0
    await recoverThreadAttachments({sources:f.store.pendingThreadAttachments(f.scope),messageId:retry.messageId,
      signal:new AbortController().signal,maxBytes:1024,
      download:async source=>{
        calls++
        const file=f.cached(source.sourceMessageId,source.fileId,source.ordinal)
        f.store.recordRecoveredThreadAttachment(retry.idempotencyKey,source,file)
        return file.size
      }})
    expect(calls).toBe(1)
    f.store.releaseInboundDelivery(retry.idempotencyKey)
    f.restart()
    expect(f.store.claimNextInboundDelivery()!.idempotencyKey).toBe(retry.idempotencyKey)
    expect(f.store.recoveredInboundAttachmentPaths(retry.idempotencyKey)).toEqual([
      join(f.root,'inbox',original.messageId,'FAUDIO.mp4')])
    const job=f.store.enqueue({...f.base,messageId:retry.messageId,task:retry.text}).job
    f.store.completeInboundDelivery(retry.idempotencyKey)
    expect(job.task).toBe('再度読んでみて')
    expect(job.attachments).toEqual([])
    expect(job.threadAttachments!.map(a=>[a.sourceMessageId,a.fileId,a.ordinal])).toEqual([
      [original.messageId,'FDONE',0],[original.messageId,'FAUDIO',1]])
    expect(f.store.get(failed)!.status).toBe('failed')
    expect(f.store.pendingThreadAttachments(f.scope)).toEqual([])
    f.restart()
    expect(f.store.get(job.id)!.threadAttachments).toEqual(job.threadAttachments)
    const prompt=buildCodexWorkerPrompt(f.store.get(job.id)!)
    expect(prompt).toContain('FAUDIO.mp4')
    expect(prompt).not.toContain('これ、音声は聞こえる？')
  } finally {f.close()}
})

test('legacy backfill requires accepted intent, preparation failure, exact scope; references survive source GC', () => {
  const f=fixture()
  try {
    const original=f.stage(f.scope.threadTs,['FLEGACY'])
    f.store.failInboundDelivery(original.idempotencyKey,'Slack入力の準備を5回試みましたが失敗しました: larger than 50MB')
    const db=new Database(f.dbPath)
    try {
      db.exec("DELETE FROM pending_thread_attachments; DELETE FROM migration_ledger WHERE name='pending-thread-attachments-v1'")
      db.run(`INSERT INTO slack_thread_reply_intents
        (idempotency_key,chat_id,thread_ts,message_id,user_id,file_ids_json,prompt_version,snapshot_json,input_digest,status,created_at)
        VALUES (?,?,?,?,?,'["FLEGACY"]',1,'{}','digest','ignored',1)`,
      [original.idempotencyKey,original.chatId,original.threadTs,original.messageId,'U1'])
      f.restart()
      expect(f.store.pendingThreadAttachments(f.scope)).toEqual([])
      db.exec("DELETE FROM migration_ledger WHERE name='pending-thread-attachments-v1'; UPDATE slack_thread_reply_intents SET status='addressed',thread_ts='2.0'")
      f.restart()
      expect(f.store.pendingThreadAttachments(f.scope)).toEqual([])
      db.run('UPDATE slack_thread_reply_intents SET thread_ts=?',[f.scope.threadTs])
      db.exec("DELETE FROM migration_ledger WHERE name='pending-thread-attachments-v1'")
      f.restart()
      expect(f.store.pendingThreadAttachments(f.scope).map(s=>s.fileId)).toEqual(['FLEGACY'])
      db.exec('DELETE FROM terminal_notifications; DELETE FROM jobs; DELETE FROM slack_thread_reply_intents')
      f.restart()
      expect(f.store.pendingThreadAttachments(f.scope).map(s=>s.fileId)).toEqual(['FLEGACY'])
      expect(f.store.pendingThreadAttachments({...f.scope,repoPath:'/other'})).toEqual([])
      expect(f.store.pendingThreadAttachments({...f.scope,chatId:'C2'})).toEqual([])
    } finally {db.close()}
  } finally {f.close()}
})

test('unavailable older file does not fail a new task; model sees retained reference instead of absence', async () => {
  const f=fixture()
  try {
    const original=f.stage(f.scope.threadTs,['FMISSING'])
    f.store.failInboundDelivery(original.idempotencyKey,'download failed')
    const retry=f.stage('1900000001.000001',[],'別の質問です')
    let attempts=0
    await recoverThreadAttachments({sources:f.store.pendingThreadAttachments(f.scope),messageId:retry.messageId,
      signal:new AbortController().signal,maxBytes:1024,download:async()=>{attempts++;throw Error('file_not_found')}})
    expect(attempts).toBe(1)
    const job=f.store.enqueue({...f.base,messageId:retry.messageId,task:retry.text}).job
    f.store.completeInboundDelivery(retry.idempotencyKey)
    f.restart()
    const saved=f.store.get(job.id)!
    expect(saved.status).toBe('queued')
    expect(saved.task).toBe('別の質問です')
    expect(buildCodexWorkerPrompt(saved)).toContain('FMISSING')
    expect(buildCodexWorkerPrompt(saved)).toContain('Do not claim these files were never attached')
    expect(f.store.pendingThreadAttachments(f.scope)).toHaveLength(1)
  } finally {f.close()}
})

test('recovery enforces processing scope, source identity and cancellation; partial results remain durable', async () => {
  const f=fixture()
  try {
    const original=f.stage(f.scope.threadTs,['FA','FB'])
    f.store.failInboundDelivery(original.idempotencyKey,'download failed')
    const retry=f.stage('1900000001.000001')
    const sources=f.store.pendingThreadAttachments(f.scope)
    const first=sources[0]!,file=f.cached(first.sourceMessageId,first.fileId,first.ordinal)
    expect(()=>f.store.recordRecoveredThreadAttachment(retry.idempotencyKey,{...first,repoPath:'/other'},file)).toThrow()
    expect(()=>f.store.recordRecoveredThreadAttachment(retry.idempotencyKey,first,{...file,ordinal:1})).toThrow()
    expect(()=>f.store.recordRecoveredThreadAttachment(retry.idempotencyKey,first,{...file,digest:'0'.repeat(64)})).toThrow()
    const controller=new AbortController()
    await expect(recoverThreadAttachments({sources,messageId:retry.messageId,signal:controller.signal,maxBytes:1024,
      download:async source=>{
        f.store.recordRecoveredThreadAttachment(retry.idempotencyKey,source,file)
        controller.abort();return file.size
      }})).rejects.toThrow('aborted')
    expect(f.store.pendingThreadAttachments(f.scope).map(s=>s.fileId)).toEqual(['FB'])
    expect(f.store.listThreadAttachments(f.scope.chatId,f.scope.threadTs,f.root).map(a=>a.fileId)).toEqual(['FA'])
    f.store.releaseInboundDelivery(retry.idempotencyKey)
    expect(()=>f.store.recordRecoveredThreadAttachment(retry.idempotencyKey,sources[1]!,f.cached(original.messageId,'FB',1))).toThrow()
  } finally {f.close()}
})

test('recovery budget and source timestamp bound work independently of failed downloads', async () => {
  const scope={chatId:'C',threadTs:'1.0',repoPath:'/project'}
  const source:PendingThreadAttachment={...scope,sourceMessageId:'1.0',fileId:'FA',ordinal:0}
  let calls=0
  await recoverThreadAttachments({sources:[source,{...source,fileId:'FB'},{...source,sourceMessageId:'3.0'}],
    messageId:'2.0',signal:new AbortController().signal,maxBytes:20,download:async()=>{calls++;return 20}})
  expect(calls).toBe(1)
})

test('recovery-wide deadline leaves unavailable sources pending and releases the ordinary request', async () => {
  let aborted = false
  await recoverThreadAttachments({sources:[{chatId:'C',threadTs:'1.0',repoPath:'/p',sourceMessageId:'1.0',fileId:'FA',ordinal:0}],
    messageId:'2.0',signal:new AbortController().signal,maxBytes:1024,timeoutMs:10,
    download:async (_source,_budget,signal)=> new Promise<number>((_resolve,reject)=> {
      signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'))},{once:true})
    })})
  expect(aborted).toBe(true)
})
