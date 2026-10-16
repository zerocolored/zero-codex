import { expect, test } from 'bun:test'
import { join } from 'path'

const shim = join(import.meta.dir, 'sandbox-dns-fallback.cjs')

function runNode(source: string): { stdout: string; stderr: string; code: number } {
  const proc = Bun.spawnSync(['node', '-e', source], { stdout: 'pipe', stderr: 'pipe' })
  return {
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    code: proc.exitCode ?? -1,
  }
}

// ジョブのサンドボックスは mDNSResponder への mach-lookup を塞ぐので、
// getaddrinfo を使う dns.lookup だけが ENOTFOUND になる。ここでは同じ条件を
// 差し替えで作り、DNS へ引き直せることを確かめる。
const withBlockedGetaddrinfo = (body: string) => `
const dns = require('dns')
dns.lookup = (host, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  const error = new Error('simulated sandbox getaddrinfo denial')
  error.code = 'ENOTFOUND'
  process.nextTick(() => done(error))
}
require(${JSON.stringify(shim)})
${body}
`

test('getaddrinfoが塞がれていてもDNSへ引き直す', () => {
  const result = runNode(withBlockedGetaddrinfo(`
    dns.lookup('one.one.one.one', (error, address, family) => {
      console.log(JSON.stringify({ error: error && error.code, address, family }))
    })
  `))
  expect(result.code).toBe(0)
  const parsed = JSON.parse(result.stdout.trim())
  expect(parsed.error).toBeNull()
  expect(parsed.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  expect(parsed.family).toBe(4)
})

test('all指定では引き直した結果も配列で返す', () => {
  const result = runNode(withBlockedGetaddrinfo(`
    dns.lookup('one.one.one.one', { all: true }, (error, entries) => {
      console.log(JSON.stringify({ error: error && error.code, count: entries && entries.length }))
    })
  `))
  expect(result.code).toBe(0)
  const parsed = JSON.parse(result.stdout.trim())
  expect(parsed.error).toBeNull()
  expect(parsed.count).toBeGreaterThan(0)
})

// 引き直しても見つからないホストで別のエラーに差し替えると、呼び出し側の
// 分岐と原因調査が狂う。元の失敗をそのまま返す。
test('本当に存在しないホストは元の失敗をそのまま返す', () => {
  const result = runNode(withBlockedGetaddrinfo(`
    dns.lookup('zerokun-absent-host.invalid', (error, address) => {
      console.log(JSON.stringify({ error: error && error.code, address: address || null }))
    })
  `))
  expect(result.code).toBe(0)
  const parsed = JSON.parse(result.stdout.trim())
  expect(parsed.error).toBe('ENOTFOUND')
  expect(parsed.address).toBeNull()
})

// 名前が引けない系統以外まで握り潰すと、本物の障害が名前解決の失敗に化ける。
test('名前解決以外の失敗は引き直さずそのまま返す', () => {
  const result = runNode(`
const dns = require('dns')
dns.lookup = (host, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  const error = new Error('simulated')
  error.code = 'ECONNREFUSED'
  process.nextTick(() => done(error))
}
require(${JSON.stringify(shim)})
dns.lookup('one.one.one.one', (error, address) => {
  console.log(JSON.stringify({ error: error && error.code, address: address || null }))
})
`)
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout.trim()).error).toBe('ECONNREFUSED')
})

test('preloadしても通常の名前解決とfetchは壊れない', () => {
  const proc = Bun.spawnSync(['node', '--require', shim, '-e', `
    require('dns').lookup('one.one.one.one', (error, address) => {
      console.log(JSON.stringify({ error: error && error.code, ok: Boolean(address) }))
    })
  `], { stdout: 'pipe', stderr: 'pipe' })
  expect(proc.exitCode).toBe(0)
  const parsed = JSON.parse(new TextDecoder().decode(proc.stdout).trim())
  expect(parsed.error).toBeNull()
  expect(parsed.ok).toBe(true)
})
