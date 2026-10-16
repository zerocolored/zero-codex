import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

test.skipIf(process.platform !== 'darwin')('回答統合だけ大きいJSON出力を許しrouting上限とprocess cleanupを維持する', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'answer-output-')))
  try {
    const target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    const standalone = join(root, '.codex/packages/standalone')
    const release = join(standalone, `releases/0.160.0-${target}`)
    const binary = join(release, 'bin/codex')
    mkdirSync(join(release, 'bin'), { recursive: true, mode: 0o700 })
    mkdirSync(join(root, '.local/bin'), { recursive: true, mode: 0o700 })
    const compiled = Bun.spawnSync(['/usr/bin/clang', '-x', 'c', '-', '-o', binary], {
      stdin: Buffer.from(`
        #include <stdio.h>
        #include <string.h>
        #include <unistd.h>
        int main(int argc,char **argv) {
          int c = getchar(); int n = c == 'L' ? 70000 : 12000;
          while (getchar() != EOF) {}
          if(c == 'T') { sleep(60); return 0; }
          if(c == 'U') { fputs(${JSON.stringify(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'usage limit private-diagnostic-value'}})+'\n')},stdout); fputs("usage limit private-diagnostic-value",stderr); return 1; }
          if(c == 'F') { fputs(${JSON.stringify(JSON.stringify({type:'error',message:'429 too many requests private-diagnostic-value'})+'\n')},stdout); fputs("user authentication quota sample text",stderr); return 1; }
          if(c == 'A') { fputs(${JSON.stringify(JSON.stringify({type:'error',message:'401 unauthorized private-diagnostic-value'})+'\n')},stdout); fputs("user authentication quota sample text",stderr); return 1; }
          if(c == 'D') { fputs(${JSON.stringify(JSON.stringify({type:'error',message:'ENOSPC private-diagnostic-value'})+'\n')},stdout); fputs("user authentication quota sample text",stderr); return 1; }
          for(int i=1;i+1<argc;i++) if(!strcmp(argv[i], "--output-last-message")) {
            FILE *f=fopen(argv[i+1],"w"); if(!f) return 3;
            fputs("{\\\"answer\\\":\\\"",f);
            for(int j=0;j<n;j++) fputc('a',f);
            fputs("\\\"}",f); fclose(f);
          }
          return 0;
        }`), stdout: 'pipe', stderr: 'pipe',
    })
    expect(compiled.exitCode).toBe(0)
    chmodSync(binary, 0o700)
    writeFileSync(join(release, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version: '0.160.0', target,
      variant: 'codex', entrypoint: 'bin/codex', resourcesDir: 'codex-resources', pathDir: 'codex-path' }), { mode: 0o600 })
    symlinkSync(release, join(standalone, 'current'))
    symlinkSync(join(standalone, 'current/bin/codex'), join(root, '.local/bin/codex'))
    const harness = join(root, 'harness.ts')
    writeFileSync(harness, `
      import {runIsolatedCodexJson,runSlackThreadIntentClassifier} from ${JSON.stringify(new URL('./slack-thread-intent.ts', import.meta.url).pathname)};
      const results=[];
      for(const [prompt,purpose] of [['small',undefined],['small','answer-consolidation'],['Large','answer-consolidation']]) {
        let pid=0,exits=0;
        try {
          const result=await runIsolatedCodexJson(prompt,{}, {purpose, onProcessId:p=>pid=p,onProcessExit:()=>exits++});
          results.push({accepted:true,length:JSON.parse(result).answer.length,exits});
        } catch {results.push({accepted:false,exits});}
        try {process.kill(pid,0); throw Error('owned process survived');} catch(e) {if(e.code!=='ESRCH') throw e;}
      }
      const failures=[];
      for(const prompt of ['F','A','D']) {
        let pid=0,exits=0;
        try {await runIsolatedCodexJson(prompt,{}, {purpose:'model-selection',onProcessId:p=>pid=p,onProcessExit:()=>exits++});throw Error('must fail');}
        catch(e) {failures.push({reason:e.reason,retryable:e.retryable,exits,leaked:JSON.stringify(e).includes('private-diagnostic-value')});}
        try {process.kill(pid,0); throw Error('owned process survived');} catch(e) {if(e.code!=='ESRCH') throw e;}
      }
      const threadFailures=[];
      for(const prompt of ['F','A','D','U','T']) {
        let pid=0,exits=0;
        try {await runIsolatedCodexJson(prompt,{}, {purpose:'thread-intent',timeoutMs:100,onProcessId:p=>pid=p,onProcessExit:()=>exits++});throw Error('must fail');}
        catch(e) {threadFailures.push({reason:e.reason,name:e.name,exits,leaked:(String(e)+JSON.stringify(e)).includes('private-diagnostic-value')});}
        try {process.kill(pid,0); throw Error('owned process survived');} catch(e) {if(e.code!=='ESRCH') throw e;}
      }
      let invalidReason;
      try {await runSlackThreadIntentClassifier('{}');} catch(e) {invalidReason=e.reason;}
      console.log(JSON.stringify({results,failures,threadFailures,invalidReason}));
    `, { mode: 0o600 })
    const child = Bun.spawn([process.execPath, '--no-env-file', harness], { cwd: root,
      env: { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: tmpdir() }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(JSON.parse(stdout).results).toEqual([
      {accepted:false,exits:1}, {accepted:true,length:12000,exits:1}, {accepted:false,exits:1},
    ])
    expect(JSON.parse(stdout).failures).toEqual([
      {reason:'throttled',retryable:true,exits:1,leaked:false},
      {reason:'authentication',retryable:false,exits:1,leaked:false},
      {reason:'disk-full',retryable:false,exits:1,leaked:false},
    ])
    expect(JSON.parse(stdout).threadFailures).toEqual([
      {reason:'throttled',name:'SlackThreadIntentRuntimeError',exits:1,leaked:false},
      {reason:'authentication',name:'SlackThreadIntentRuntimeError',exits:1,leaked:false},
      {reason:'disk-full',name:'SlackThreadIntentRuntimeError',exits:1,leaked:false},
      {reason:'unclassified',name:'SlackThreadIntentRuntimeError',exits:1,leaked:false},
      {reason:'transport',name:'SlackThreadIntentRuntimeError',exits:1,leaked:false},
    ])
    expect(JSON.parse(stdout).invalidReason).toBe('invalid-output')
  } finally { rmSync(root, {recursive:true,force:true}) }
}, 30000)
