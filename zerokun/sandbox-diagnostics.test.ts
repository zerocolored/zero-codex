import { expect, test } from 'bun:test'
import { join } from 'path'

const preload = join(import.meta.dir, 'sandbox-diagnostics.cjs')

function runNode(source: string, env?: Record<string, string>) {
  const proc = Bun.spawnSync(['node', '--require', preload, '-e', source], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  return {
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    code: proc.exitCode ?? -1,
  }
}

// 箱が塞いだ connect は EPERM としてしか見えず、「宛先が落ちている」と
// 読み違える。何が塞いでいるかを1行出す。
test('塞がれたconnectに、箱が原因だと分かる説明を出す', () => {
  const result = runNode(`
    const net = require('net')
    const socket = new net.Socket()
    socket.connect(443, '203.0.113.1')
    socket.on('error', () => {})
    process.nextTick(() => socket.emit('error', Object.assign(new Error('x'), { code: 'EPERM', syscall: 'connect' })))
    setTimeout(() => process.exit(0), 200)
  `)
  expect(result.stderr).toContain('[zerokun] connect EPERM')
  expect(result.stderr).toContain('only through its own proxy')
  expect(result.stderr).toContain('not by the remote host')
})

test('プロキシが設定されていれば、その事実も出す', () => {
  const result = runNode(`
    const net = require('net')
    const socket = new net.Socket()
    socket.connect(443, '203.0.113.1')
    socket.on('error', () => {})
    process.nextTick(() => socket.emit('error', Object.assign(new Error('x'), { code: 'EPERM', syscall: 'connect' })))
    setTimeout(() => process.exit(0), 200)
  `, { HTTPS_PROXY: 'http://127.0.0.1:8080' })
  expect(result.stderr).toContain('set via HTTPS_PROXY')
})

// 本物の接続拒否まで箱のせいにすると、原因調査が狂う。
test('ECONNREFUSEDには何も言わない', () => {
  const result = runNode(`
    const net = require('net')
    const socket = new net.Socket()
    socket.connect(443, '203.0.113.1')
    socket.on('error', () => {})
    process.nextTick(() => socket.emit('error', Object.assign(new Error('x'), { code: 'ECONNREFUSED', syscall: 'connect' })))
    setTimeout(() => process.exit(0), 200)
  `)
  expect(result.stderr).not.toContain('[zerokun]')
})

test('同じ原因を何度も繰り返さない', () => {
  const result = runNode(`
    const net = require('net')
    for (let i = 0; i < 3; i += 1) {
      const socket = new net.Socket()
      socket.connect(443, '203.0.113.1')
      socket.on('error', () => {})
      process.nextTick(() => socket.emit('error', Object.assign(new Error('x'), { code: 'EPERM', syscall: 'connect' })))
    }
    setTimeout(() => process.exit(0), 200)
  `)
  expect(result.stderr.split('[zerokun] connect EPERM').length - 1).toBe(1)
})

test('実行できないバイナリにも、パスが読めない可能性を出す', () => {
  const result = runNode(`
    require('child_process').spawnSync('/zerokun-absent/tool', [])
    setTimeout(() => process.exit(0), 200)
  `)
  // ENOENT のときは何も言わない。EPERM/EACCES のときだけ。
  expect(result.stderr).not.toContain('[zerokun] spawn ENOENT')
})

test('通常の通信は壊れない', () => {
  const result = runNode(`
    const net = require('net')
    const server = net.createServer(socket => socket.end())
    server.listen(0, '127.0.0.1', () => {
      const socket = new net.Socket()
      socket.connect(server.address().port, '127.0.0.1', () => {
        console.log('connected')
        socket.destroy(); server.close(); process.exit(0)
      })
      socket.on('error', e => { console.log('ERR', e.code); process.exit(1) })
    })
  `)
  expect(result.code).toBe(0)
  expect(result.stdout.trim()).toBe('connected')
})
