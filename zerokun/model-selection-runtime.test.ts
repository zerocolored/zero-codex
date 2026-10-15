import { expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectModelSelectionDiagnostic, ModelSelectionRuntimeError, modelSelectionProcessFailure, modelSelectionRetryDelay } from './model-selection-runtime.ts'
import { JobStore, publicJobFailureSummary, runQueuedJobs } from './job-runner.ts'

test.each([
  ['connection reset; private-value', 'transport', true],
  ['429 too many requests; private-value', 'throttled', true],
  ['503 overloaded; private-value', 'capacity', true],
  ['unrecognized runtime fault; private-value', 'unclassified', true],
  ['401 unauthorized; private-value', 'authentication', false],
  ['insufficient_quota; private-value', 'quota', true],
  ['ENOSPC no space left; private-value', 'disk-full', false],
  ['unexpected argument --private-value', 'configuration', false],
] as const)('classifies process failure without exposing stderr: %s', (diagnostic,reason,retryable)=>{
  const error=modelSelectionProcessFailure(1,diagnostic);
  expect(error.reason).toBe(reason);expect(error.retryable).toBe(retryable);
  expect(error.message).not.toContain('private-value');expect(JSON.stringify(error)).not.toContain('private-value');
  const summary=publicJobFailureSummary(error.message);
  expect(summary).not.toContain('モデル指定');expect(summary).not.toContain('private-value');
  if(reason==='authentication')expect(summary).toContain('認証');
});

test('input check backoff is capped and does not exhaust a transient outage',()=>{
  expect([0,1,2,3,1000].map(modelSelectionRetryDelay)).toEqual([5000,15000,30000,60000,60000]);
});

test('input check outage releases the worker, retains the same job, and recovers without a failure notification',async()=>{
  const root=mkdtempSync(join(tmpdir(),'model-check-queue-'));const store=new JobStore(join(root,'jobs.sqlite3'));
  const now=Date.now();setSystemTime(now);
  try {
    const input={chatId:'C0123456789',threadTs:'1800000000.000100',messageId:'1800000000.000100',userId:'U0123456789',repoPath:'/tmp/project',task:'Solで調べて',writeEnabled:false};
    const first=store.enqueue(input).job;
    const other=store.enqueue({...input,threadTs:'1800000000.000200',messageId:'1800000000.000200',task:'別の依頼'}).job;
    const stats=await runQueuedJobs({store,maxJobsPerSession:5,pollMs:1,stopWhenIdle:true,
      executor:async job=>{if(job.id===first.id)throw new ModelSelectionRuntimeError('transport');return {sessionId:'other',result:'完了'};}});
    expect(stats).toMatchObject({completed:1,failed:0});
    expect(store.get(first.id)).toMatchObject({status:'queued',terminalOutcome:null,notBefore:now+60000,task:input.task});
    expect(store.get(other.id)?.status).toBe('completed');expect(store.terminalNotificationCount()).toBe(1);
    setSystemTime(now+60001);
    const recovered=await runQueuedJobs({store,maxJobsPerSession:5,pollMs:1,stopWhenIdle:true,
      executor:async job=>{expect(job.id).toBe(first.id);expect(job.task).toBe(input.task);return {sessionId:'recovered',result:'再開完了'};}});
    expect(recovered).toMatchObject({completed:1,failed:0});expect(store.get(first.id)?.status).toBe('completed');
  } finally {setSystemTime();store.close();rmSync(root,{recursive:true,force:true});}
});


test('only structured native errors classify the cause, not echoed prompt or assistant content',async()=>{
 const lines=[
  'user authentication 401 sample',
  JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'authentication 401 quota ENOSPC'}}),
  JSON.stringify({type:'error',message:'503 overloaded'}),
  JSON.stringify({type:'turn.failed',error:{message:'connection reset'}}),
 ].join('\n');
 const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from(lines));c.close();}});
 const diagnostic=await collectModelSelectionDiagnostic(stream);
 expect(diagnostic).toBe('connection reset');
 expect(modelSelectionProcessFailure(1,diagnostic).reason).toBe('transport');
});
