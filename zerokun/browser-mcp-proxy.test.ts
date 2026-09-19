import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { redactBrowserText, redactBrowserValue } from './browser-mcp-proxy.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test('ordinary tabs and query navigation remain unchanged', () => {
  const tabs = { tabs: [{ id: 42, title: 'FAQ', url: 'https://example.test/faq?page=2&product=abc#section' }] }
  expect(redactBrowserValue(tabs)).toEqual(tabs)
})

for (const url of [
  'http://localhost:1455/callback?id_token=SYNTHETIC_SECRET&plan_type=test',
  'https://example.test/callback?%69d_token=SYNTHETIC_SECRET',
  'https://example.test/callback?id%255ftoken=SYNTHETIC_SECRET',
  'https://example.test/callback?code=SYNTHETIC_SECRET&code=second',
  'https://example.test/#access_token=SYNTHETIC_SECRET',
  'https://example.test/#/callback?id_token=SYNTHETIC_SECRET',
  'https://example.test/file?sv=1&sig=SYNTHETIC_SECRET&sp=r',
  'https://example.test/file?X-Amz-Signature=SYNTHETIC_SECRET',
  'https://user:SYNTHETIC_SECRET@example.test/path',
  'https://example.test/?redirect=https%3A%2F%2Fother.test%2F%3Fcode%3DSYNTHETIC_SECRET',
  'https://example.test/?redirect=https%3A%2F%2Fuser%3ASYNTHETIC_SECRET%40other.test%2F',
  'https://example.test/?a=https%3A%2F%2Fx.test%2F%3Fq%3D1&b=https%3A%2F%2Fy.test%2F%3Frefresh_token%3DSYNTHETIC_SECRET',
  'https://example.test/#/login?next=https%3A%2F%2Fy.test%2Fcb%3Fclient_secret%3DSYNTHETIC_SECRET',
  'https://example.test/?redirect=https%3A%2F%2Fo.test%2F%23access_token%3DSYNTHETIC_SECRET&x=/a?b=1',
  'https://example.test/?redirect=https%3A%2F%2Fo.test%2Fcb%3Fscope%3Da%2520b%26code%3DSYNTHETIC_SECRET',
  'https://example.test/?redirect=https%3A%2F%2Fo.test%2Fcb%3Fscope%3Da%20b%26code%3DSYNTHETIC_SECRET',
  'https://example.test/?next=%2Fcb%3Fcode%3DSYNTHETIC_SECRET',
  'https://example.test/?next=https%3A%2F%2Fo.test%2F%23!%2Fcb%3Fcode%3DSYNTHETIC_SECRET',
  'https://example.test/?next=/oauth/callback?refresh_token=SYNTHETIC_SECRET&ok=1',
  'https://example.test/?u=https://inner.test/#?code=SYNTHETIC_SECRET',
]) {
  test(`sanitizes synthetic URL variant ${url}`, () => {
    const payload = { content: [{ type: 'text', text: JSON.stringify({ id: 44, url, title: url }) }], structuredContent: { url } }
    const safe = redactBrowserValue(payload)
    expect(JSON.stringify(safe)).not.toContain('SYNTHETIC_SECRET')
    expect(JSON.parse(safe.content[0].text).id).toBe(44)
    expect(JSON.stringify(safe)).not.toContain('second')
  })
}

test('nested JSON escaping and standalone JWT titles are redacted', () => {
  const value = '[{"url":"https:\\/\\/example.test\\/callback?code=SYNTHETIC_SECRET","title":"eyJfake.payload.signature"}]'
  const safe = redactBrowserText(value)
  expect(safe).not.toContain('SYNTHETIC_SECRET')
  expect(safe).not.toContain('eyJfake')
})

test('JWT punctuation and unsigned/JWE suffixes cannot bypass redaction', () => {
  for (const text of ['JWT: eyJfake.payload.signature.', 'JWT: -eyJfake.payload.signature', 'eyJfake.payload.', 'eyJfake.payload.iv.ciphertext.tag']) {
    expect(redactBrowserText(text)).not.toContain('eyJfake')
  }
})

test('scheme-less tab titles cannot retain signed query values', () => {
  const title = 'file.pdf?rsct=application/pdf&sig=SYNTHETIC_SECRET&sv=1'
  const safe = redactBrowserValue({ title })
  expect(safe.title).not.toContain('SYNTHETIC_SECRET')
  expect(safe.title).toContain('rsct=application/pdf')
  expect(redactBrowserText('example.test/?redirect=https%3A%2F%2Fother.test%2F%3Fcode%3DSYNTHETIC_SECRET')).not.toContain('SYNTHETIC_SECRET')
})

test('image bytes and ordinary Japanese text remain unchanged', () => {
  const value = {content:[{type:'image',mimeType:'image/png',data:'aGVsbG8='},{type:'text',text:'全角ＡＢＣ・ｶﾅをそのまま表示'}]}
  expect(redactBrowserValue(value)).toEqual(value)
})

test('excessive nesting is not passed through as unsanitized JSON text', () => {
  expect(() => redactBrowserText('['.repeat(70) + '"test"' + ']'.repeat(70))).toThrow('nesting limit')
})

for (const frame of ['bad SYNTHETIC_SECRET', '[{"result":"SYNTHETIC_SECRET"}]', '"SYNTHETIC_SECRET"', 'null']) {
test(`invalid child frame is withheld: ${frame}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-browser-invalid-'))
  roots.push(root)
  const childPath = join(root, 'child.mjs')
  writeFileSync(childPath, `console.log(${JSON.stringify(frame)}); setInterval(()=>{},1000);`)
  const proxy = spawn('node', [join(import.meta.dir, 'browser-mcp-proxy.mjs'), childPath], { stdio: 'pipe' })
  let output = ''
  proxy.stdout.on('data', chunk => { output += chunk })
  proxy.stderr.on('data', chunk => { output += chunk })
  try {
    const exit = await Promise.race([new Promise(resolve => proxy.on('exit', resolve)), Bun.sleep(3000).then(()=>'timeout')])
    expect(exit).toBe(1)
    expect(output).not.toContain('SYNTHETIC_SECRET')
    expect(output).toContain('raw output was withheld')
  } finally { proxy.kill('SIGKILL') }
})
}

test('long punctuation and JWT-like text are processed without quadratic retries', () => {
  const started = performance.now()
  redactBrowserText('?'.repeat(200000) + '-eyJ'.repeat(200000))
  expect(performance.now() - started).toBeLessThan(2000)
})

test('client EOF allows the final child response to flush', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-browser-eof-'))
  roots.push(root)
  const childPath = join(root, 'child.mjs')
  writeFileSync(childPath, `process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{complete:true}})),30));`)
  const proxy = spawn('node', [join(import.meta.dir, 'browser-mcp-proxy.mjs'), childPath], { stdio: 'pipe' })
  let output = ''
  proxy.stdout.on('data', chunk => { output += chunk })
  const exited = new Promise(resolve => proxy.on('exit', resolve))
  try {
    proxy.stdin.end()
    expect(await Promise.race([exited,Bun.sleep(4000).then(()=>'timeout')])).toBe(0)
    expect(JSON.parse(output).result.complete).toBe(true)
  } finally { proxy.kill('SIGKILL') }
})

test('child crash closes proxy even while client stdin stays open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-browser-crash-'))
  roots.push(root)
  const childPath = join(root, 'child.mjs')
  writeFileSync(childPath, 'process.exit(7)')
  const proxy = spawn('node', [join(import.meta.dir, 'browser-mcp-proxy.mjs'), childPath], { stdio: 'pipe' })
  try {
    expect(await Promise.race([new Promise(resolve=>proxy.on('exit',resolve)),Bun.sleep(3000).then(()=>'timeout')])).toBe(7)
  } finally { proxy.kill('SIGKILL') }
})

test('SIGTERM reaps the owned child even when it ignores TERM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-browser-signal-'))
  roots.push(root)
  const childPath = join(root, 'child.mjs')
  writeFileSync(childPath, `process.on('SIGTERM',()=>{}); console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{pid:process.pid}})); setInterval(()=>{},1000);`)
  const proxy = spawn('node', [join(import.meta.dir, 'browser-mcp-proxy.mjs'), childPath], { stdio: 'pipe' })
  const exited = new Promise(resolve => proxy.on('exit', resolve))
  try {
    const output = await Promise.race([new Promise<string>(resolve=>proxy.stdout.once('data',chunk=>resolve(String(chunk)))), Bun.sleep(3000).then(()=>{throw new Error('startup timeout')})])
    const pid = JSON.parse(output).result.pid
    proxy.kill('SIGTERM')
    expect(await Promise.race([exited,Bun.sleep(4000).then(()=>'timeout')])).toBe(0)
    expect(()=>process.kill(pid,0)).toThrow()
  } finally { proxy.kill('SIGKILL') }
}, 7000)

test('TERM cleanup also reaps a same-group descendant after direct child exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-browser-descendant-'))
  roots.push(root)
  const childPath = join(root, 'child.mjs')
  writeFileSync(childPath, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
child.on('message',()=>console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{pid:child.pid}})));
`)
  const proxy = spawn('node', [join(import.meta.dir, 'browser-mcp-proxy.mjs'), childPath], { stdio: 'pipe' })
  const exited = new Promise(resolve => proxy.on('exit', resolve))
  let pid: number | undefined
  try {
    const output = await Promise.race([new Promise<string>(resolve=>proxy.stdout.once('data',chunk=>resolve(String(chunk)))), Bun.sleep(3000).then(()=>{throw new Error('startup timeout')})])
    pid = JSON.parse(output).result.pid
    proxy.kill('SIGTERM')
    expect(await Promise.race([exited,Bun.sleep(4000).then(()=>'timeout')])).toBe(0)
    let live = true
    for (let i=0;i<20;i++) {
      try { process.kill(pid!,0) } catch { live=false;break }
      await Bun.sleep(50)
    }
    expect(live).toBe(false)
  } finally {
    proxy.kill('SIGKILL')
    if(pid) { try { process.kill(pid,'SIGKILL') } catch {} }
  }
}, 8000)

test('real stdio boundary handles text, structured results, errors and notifications without leaking diagnostics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zero-browser-proxy-'))
  roots.push(root)
  const childPath = join(root, 'child.mjs')
  writeFileSync(childPath, `
import { createInterface } from 'node:readline';
createInterface({input: process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 const url='http://localhost:1455/callback?id_token=SYNTHETIC_SECRET';
 console.error(url);
 console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{data:url}}));
 const result=request.id===2 ? {error:{code:-32000,message:url}} : {result:{content:[{type:'text',text:JSON.stringify({tabs:[{id:55,title:'Test',url}]})}],structuredContent:{url}}};
 console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,...result}));
});
`)
  const proxy = spawn('node', [join(import.meta.dir, 'browser-mcp-proxy.mjs'), childPath], { stdio: 'pipe' })
  let output = '', stderr = ''
  const exited = new Promise<number | null>(resolve => proxy.on('exit', resolve))
  proxy.stderr.on('data', chunk => { stderr += chunk })
  const complete = new Promise<void>(resolve => proxy.stdout.on('data', chunk => {
    output += chunk
    if (output.trim().split('\n').length === 4) resolve()
  }))
  try {
    proxy.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'tabs_list'}})+'\n')
    proxy.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'navigate'}})+'\n')
    await Promise.race([complete, Bun.sleep(3000).then(() => { throw new Error('proxy response timeout') })])
    expect(output + stderr).not.toContain('SYNTHETIC_SECRET')
    const rows = output.trim().split('\n').map(line => JSON.parse(line))
    expect(rows.filter(row => 'id' in row).map(row => row.id)).toEqual([1, 2])
    expect(rows[1].result.structuredContent.url).toBe('http://localhost:1455/callback')
    proxy.stdin.end()
    expect(await Promise.race([exited, Bun.sleep(3000).then(() => 'timeout')])).toBe(0)
  } finally { proxy.kill('SIGKILL') }
})
