'use strict'
// サンドボックスが塞いだ結果は errno としてしか見えない。EPERM や EACCES の
// 数字から「箱の何が塞いでいるか」は推理できず、原因を人に尋ねる依頼で
// 止まっていた。既知の形に当てはまったときだけ、何が塞いでいるかを1行
// stderr へ出す。errorオブジェクトは書き換えない(テストの期待値を壊すため)。
const net = require('net')

const announced = new Set()
function announce(key, lines) {
  if (announced.has(key)) return
  announced.add(key)
  for (const line of lines) {
    try { process.stderr.write(`[zerokun] ${line}\n`) } catch { /* stderr が閉じていても本筋を止めない */ }
  }
}

function proxyState() {
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
  const present = names.filter(name => typeof process.env[name] === 'string' && process.env[name] !== '')
  return present.length > 0 ? `set via ${present.join(', ')}` : 'not set in this process'
}

const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function connect(...args) {
  const socket = originalConnect.apply(this, args)
  this.once('error', error => {
    if (!error || (error.code !== 'EPERM' && error.code !== 'EACCES')) return
    if (error.syscall !== 'connect') return
    announce('connect-denied', [
      `connect ${error.code}: this sandbox permits outbound connections only through its own proxy.`,
      `Proxy environment is ${proxyState()}.`,
      'A client that dials the address directly is denied by the sandbox, not by the remote host.',
      'Use a client that honours the proxy environment (curl, or undici EnvHttpProxyAgent) instead of',
      'reporting the destination as unreachable.',
    ])
  })
  return socket
}

// 実行できないバイナリも errno でしか分からない。許可されたパスの外に
// あるのか、そもそも無いのかで打つ手が違う。
const childProcess = require('child_process')
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[name]
  if (typeof original !== 'function') continue
  childProcess[name] = function wrapped(command, ...rest) {
    const explain = error => {
      if (!error || (error.code !== 'EPERM' && error.code !== 'EACCES')) return
      announce(`spawn-denied:${String(command)}`, [
        `spawn ${error.code} for ${String(command)}: the sandbox denies reading or executing that path.`,
        'Paths outside this job\'s workspace, scratch and toolchain roots are not readable here.',
        'Check whether another copy of the tool exists on PATH before reporting it as missing.',
      ])
    }
    const result = original.call(this, command, ...rest)
    if (result && typeof result.once === 'function') result.once('error', explain)
    else if (result && result.error) explain(result.error)
    return result
  }
}
