import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerSlackApp } from './slack-app-registry.ts'
import { auditCredentialState, readAuditCredential, saveAuditCredential } from './security-audit-credentials.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'audit-shared-')); roots.push(home)
  const a = join(home, 'a'), b = join(home, 'b')
  for (const state of [a, b]) mkdirSync(state, { mode: 0o700 })
  registerSlackApp('AFIRST', a, home); registerSlackApp('ASECOND', b, home)
  return { home, a, b }
}
const put = (state: string, name: string, token: string) => writeFileSync(join(state, `security-audit-${name}-token`), token, { mode: 0o600 })

test('another registered app imports old credentials once and rotation wins over preserved old files', () => {
  const {home,a,b} = fixture()
  for (const service of ['semgrep','socket'] as const) {
    put(a, service, `synthetic-${service}`)
    expect(readAuditCredential(b, service, home)).toBe(`synthetic-${service}`)
    expect(readAuditCredential(a, service, home)).toBe(`synthetic-${service}`)
    expect(existsSync(join(b, `security-audit-${service}-token`))).toBe(false)
    saveAuditCredential(b, service, 'synthetic-rotated', home)
    expect(readAuditCredential(a, service, home)).toBe('synthetic-rotated')
    expect(readFileSync(join(a, `security-audit-${service}-token`), 'utf8')).toBe(`synthetic-${service}`)
  }
  const root = auditCredentialState(a, home)
  expect(lstatSync(root).mode & 0o777).toBe(0o700)
  expect(lstatSync(join(root,'security-audit-socket-token')).mode & 0o777).toBe(0o600)
})

test('conflicting old registrations require an explicit common registration, equal copies do not', () => {
  const {home,a,b} = fixture()
  put(a,'socket','synthetic-one'); put(b,'socket','synthetic-two')
  expect(() => readAuditCredential(b,'socket',home)).toThrow('既存登録が複数')
  const root = auditCredentialState(a,home)
  expect(existsSync(join(root,'security-audit-socket-token'))).toBe(false)
  saveAuditCredential(b,'socket','synthetic-selected',home)
  expect(readAuditCredential(a,'socket',home)).toBe('synthetic-selected')
  put(a,'semgrep','same-synthetic'); put(b,'semgrep','same-synthetic')
  expect(readAuditCredential(b,'semgrep',home)).toBe('same-synthetic')
})

test('Socket organization migrates only with a matching token digest', () => {
  const {home,a,b} = fixture(), token = 'synthetic-socket'
  put(a,'socket',token)
  const common = {socketOrg:'fixture-org',socketCredentialDigest:createHash('sha256').update(token).digest('hex')}
  writeFileSync(join(a,'security-audit-common.json'),JSON.stringify(common),{mode:0o600})
  readAuditCredential(b,'socket',home)
  expect(JSON.parse(readFileSync(join(auditCredentialState(b,home),'security-audit-common.json'),'utf8'))).toEqual(common)
})

test('unregistered custom states remain isolated from the actual user and other installations', () => {
  const {home,a} = fixture(), standalone=join(home,'standalone')
  mkdirSync(standalone,{mode:0o700})
  saveAuditCredential(a,'socket','shared-synthetic',home)
  expect(readAuditCredential(standalone,'socket',home)).toBeNull()
  expect(readAuditCredential(standalone,'socket')).toBeNull()
})

test('unsafe legacy and shared credential files are rejected without following links', () => {
  const {home,a,b} = fixture(), outside=join(home,'outside')
  writeFileSync(outside,'synthetic-secret',{mode:0o600})
  symlinkSync(outside,join(a,'security-audit-socket-token'))
  expect(() => readAuditCredential(b,'socket',home)).toThrow()
  const root=auditCredentialState(a,home)
  symlinkSync(outside,join(root,'security-audit-semgrep-token'))
  expect(() => readAuditCredential(b,'semgrep',home)).toThrow()
  expect(readFileSync(outside,'utf8')).toBe('synthetic-secret')
})

test('new registrations are shared even when no legacy token exists; default state also shares', () => {
  const {home,a,b}=fixture(), standard=join(home,'.codex','zerokun')
  mkdirSync(standard,{mode:0o700})
  expect(readAuditCredential(a,'semgrep',home)).toBeNull()
  saveAuditCredential(a,'semgrep','new-synthetic',home)
  expect(readAuditCredential(b,'semgrep',home)).toBe('new-synthetic')
  expect(readAuditCredential(standard,'semgrep',home)).toBe('new-synthetic')
})

test('simultaneous app startup imports one complete registration', async () => {
  const {home,a,b}=fixture()
  put(a,'socket','sktsec_concurrent_synthetic')
  const script=join(home,'concurrent.ts')
  writeFileSync(script, `import { readAuditCredential } from ${JSON.stringify(join(import.meta.dir,'security-audit-credentials.ts'))};
if(readAuditCredential(process.argv[2]!, 'socket')!=='sktsec_concurrent_synthetic')process.exit(1);`,{mode:0o600})
  const children=[a,b,a,b].map(state=>Bun.spawn([process.execPath,'--config=/dev/null','--no-env-file',script,state],{env:{...process.env,HOME:home},stdout:'pipe',stderr:'pipe'}))
  const results=await Promise.all(children.map(async child=>({exit:await child.exited,out:await new Response(child.stdout).text(),err:await new Response(child.stderr).text()})))
  expect(results).toEqual(Array.from({length:4},()=>({exit:0,out:'',err:''})))
  expect(readAuditCredential(b,'socket',home)).toBe('sktsec_concurrent_synthetic')
},10000)

test('registered cross-app status, initialization and authenticated adapters share credentials in an isolated HOME', async () => {
  const {home,a,b}=fixture()
  const script=join(home,'integration.ts')
  const code = `
import { mkdirSync, writeFileSync, unlinkSync } from 'fs'; import { join } from 'path';
import { securityAuditConfig } from ${JSON.stringify(join(import.meta.dir,'security-audit-config.ts'))};
import { AuditSetupRequiredError, initializeAudit, loadAuditSettings, saveAuditSettings } from ${JSON.stringify(join(import.meta.dir,'security-audit-setup.ts'))};
import { auditSettingsSchema } from ${JSON.stringify(join(import.meta.dir,'security-audit.ts'))};
import { readAuditCredential, saveAuditCredential } from ${JSON.stringify(join(import.meta.dir,'security-audit-credentials.ts'))};
import { runAuditTool } from ${JSON.stringify(join(import.meta.dir,'security-audit-tools.ts'))};
const home=${JSON.stringify(home)}, a=${JSON.stringify(a)}, b=${JSON.stringify(b)};
const repo=join(home,'repo'), other=join(home,'other'), work=join(home,'work');
for (const p of [repo,other,work]) mkdirSync(p,{mode:0o700});
writeFileSync(join(repo,'hello.js'),'console.log("hello")');
writeFileSync(join(repo,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0'}));
saveAuditSettings(a,other,auditSettingsSchema.parse({targetUrl:'https://first.test/',authentication:'required',activeScan:true}));
writeFileSync(join(b,'security-audit-semgrep-token'),'conflicting-synthetic',{mode:0o600});
try { await initializeAudit({id:'conflict',repoPath:repo,inputRevision:1},b,[]); throw Error('conflict accepted'); } catch(error) { if(!(error instanceof AuditSetupRequiredError)||!error.prompt.includes('既存登録が複数'))throw error; }
unlinkSync(join(b,'security-audit-semgrep-token'));
const initial=await initializeAudit({id:'shared',repoPath:repo,inputRevision:1},b,[{text:'URL: https://example.test/\\n認証: 公開・未ログイン範囲',writeEnabled:true,revision:1}],{organizations:async()=>{throw Error('must inherit org')}});
if(initial.socketOrg!=='fixture-org'||initial.targetUrl!=='https://example.test/'||initial.authentication!=='none'||initial.activeScan) throw Error('scope leak or missing organization');
if(loadAuditSettings(b,other).targetUrl) throw Error('cross-app target leaked');
await securityAuditConfig([b,repo,'status']);
const tools=join(b,'security-audit-tools');
const semgrep=join(tools,'semgrep/bin'), socket=join(tools,'socket/node_modules/.bin');
for(const p of [semgrep,socket]) mkdirSync(p,{recursive:true,mode:0o700});
writeFileSync(join(semgrep,'semgrep'),${JSON.stringify(`#!/usr/bin/env node
const a=process.argv.slice(2);if(a[0]==='--version'){console.log('fixture');process.exit(0)}
if(process.env.SEMGREP_APP_TOKEN!=='synthetic-semgrep')process.exit(88);
if(a[0]==='install-semgrep-pro')process.exit(0);
if(a[0]!=='scan'||!a.includes('--pro')||!a.includes('policy'))process.exit(87);
console.log(JSON.stringify({engine_requested:'PRO',paths:{scanned:['hello.js']},interfile_languages_used:['js'],results:[],errors:[]}));
`)},{mode:0o700});
writeFileSync(join(socket,'socket'),${JSON.stringify(`#!/usr/bin/env node
const a=process.argv.slice(2);if(a[0]==='--version'){console.log('fixture');process.exit(0)}
if(process.env.SOCKET_CLI_API_TOKEN!=='sktsec_synthetic_shared')process.exit(88);
if(a[1]==='create')console.log(JSON.stringify({ok:true,data:{id:'shared-scan'}}));
else if(a[1]==='report')console.log(JSON.stringify({ok:true,data:{healthy:true,scanId:'shared-scan',alerts:{}}}));
else process.exit(87);
`)},{mode:0o700});
const context={root:work,source:repo,repo,stateDir:b,jobId:'shared',settings:{...initial,semgrepRepo:'fixture/repo'}};
for(const n of [6,9]) {const result=await runAuditTool(n,context);if(result.status!=='completed')throw Error('adapter '+n+': '+result.note);}
saveAuditCredential(a,'socket','sktsec_rotated_synthetic');
if(loadAuditSettings(b,repo).socketOrg)throw Error('old organization survived rotation');
console.log('CROSS_APP_STATUS_SETUP_ADAPTERS_OK');
`
  put(a,'semgrep','synthetic-semgrep'); put(a,'socket','sktsec_synthetic_shared')
  writeFileSync(join(a,'security-audit-common.json'),JSON.stringify({socketOrg:'fixture-org',socketCredentialDigest:createHash('sha256').update('sktsec_synthetic_shared').digest('hex')}),{mode:0o600})
  writeFileSync(script,code,{mode:0o600})
  const child=Bun.spawn([process.execPath,'--config=/dev/null','--no-env-file',script],{env:{...process.env,HOME:home},stdout:'pipe',stderr:'pipe'})
  const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  expect({exit,err}).toEqual({exit:0,err:''})
  expect(out).toContain('"semgrepCredentialPresent": true')
  expect(out).toContain('"socketCredentialPresent": true')
  expect(out).toContain('CROSS_APP_STATUS_SETUP_ADAPTERS_OK')
  expect(out).not.toContain('sktsec_synthetic_shared')
}, 30000)
