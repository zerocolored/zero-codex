'use strict'
// ジョブのサンドボックスでは mDNSResponder への mach-lookup が塞がれており、
// getaddrinfo を使う dns.lookup だけが ENOTFOUND で落ちる。DNS へ直接引く
// dns.resolve4/6 は通るので、lookup が名前解決できなかったときだけ引き直す。
// fetch/undici も net.connect も入口は dns.lookup なので、ここを直せば
// ジョブ内のあらゆる Node クライアントがそのまま外へ出られる。
const dns = require('dns')
const { promisify } = require('util')

const originalLookup = dns.lookup
// ホスト名が引けなかったことを示す系統だけを引き直す。接続拒否や
// タイムアウトまで握り潰すと、本物の障害が名前解決の失敗に化ける。
const RESOLVER_UNAVAILABLE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENOTSUP', 'EPERM', 'EACCES'])

function normalizeOptions(options) {
  if (typeof options === 'number') return { family: options }
  if (options && typeof options === 'object') return options
  return {}
}

function resolveAll(hostname, family) {
  const queries = []
  if (family !== 6) {
    queries.push(dns.promises.resolve4(hostname).then(
      addresses => addresses.map(address => ({ address, family: 4 })),
      () => [],
    ))
  }
  if (family !== 4) {
    queries.push(dns.promises.resolve6(hostname).then(
      addresses => addresses.map(address => ({ address, family: 6 })),
      () => [],
    ))
  }
  return Promise.all(queries).then(groups => groups.flat())
}

function patchedLookup(hostname, options, callback) {
  const done = typeof options === 'function' ? options : callback
  if (typeof done !== 'function') return originalLookup.apply(this, arguments)
  const settings = typeof options === 'function' ? {} : normalizeOptions(options)
  return originalLookup.call(this, hostname, settings, (error, address, family) => {
    if (!error) return done(error, address, family)
    if (!RESOLVER_UNAVAILABLE.has(error.code)) return done(error)
    resolveAll(hostname, settings.family).then(entries => {
      // 引き直しても見つからないなら、元の失敗をそのまま返す。別の
      // エラーに差し替えると呼び出し側の分岐と原因調査が狂う。
      if (entries.length === 0) return done(error)
      if (settings.all) return done(null, entries)
      done(null, entries[0].address, entries[0].family)
    }, () => done(error))
  })
}

// util.promisify(dns.lookup) は custom symbol を見る。付け替えないと
// dns.promises 側と挙動が割れる。
patchedLookup[promisify.custom] = (hostname, options) => new Promise((resolve, reject) => {
  const settings = normalizeOptions(options)
  patchedLookup(hostname, settings, (error, address, family) => {
    if (error) return reject(error)
    resolve(settings.all ? address : { address, family })
  })
})

dns.lookup = patchedLookup
dns.promises.lookup = patchedLookup[promisify.custom]
