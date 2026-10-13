import { afterEach, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { connect } from 'net'
import { ensureHerdrServer, herdrSocketAvailable, recoveryServerEnvironment } from './herdr-server.ts'
import type { HerdrRuntimeIdentity } from './herdr-runtime.ts'

const roots: string[] = []
const sockets: string[] = []
afterEach(async () => {
  for (const path of sockets.splice(0)) {
    await new Promise<void>(resolve => {
      const socket = connect(path, () => socket.end('stop'))
      socket.on('error', () => resolve()); socket.on('close', () => resolve())
    })
    for (let i = 0; i < 30 && await herdrSocketAvailable(path); i++) await Bun.sleep(50)
    expect(await herdrSocketAvailable(path)).toBe(false)
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(): HerdrRuntimeIdentity {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-cold-herdr-'))); roots.push(root)
  const directory = join(root, 'herdr'); mkdirSync(directory, { mode: 0o700 })
  const binary = join(root, 'fake-herdr')
  writeFileSync(binary, `#!${process.execPath}\nimport { appendFileSync, chmodSync } from 'fs';
if (process.argv[2] !== 'server') process.exit(2);
appendFileSync('starts', 'start\\n');
Bun.listen({unix: process.env.HERDR_SOCKET_PATH, socket: {data(s,d) { if (d.toString()==='stop') process.exit(0) }}});
chmodSync(process.env.HERDR_SOCKET_PATH, 0o600);`, { mode: 0o700 })
  const stat = lstatSync(binary)
  return { binary, binaryDevice: stat.dev, binaryInode: stat.ino, binaryMode: stat.mode,
    binarySize: stat.size, binaryModifiedMs: stat.mtimeMs, binaryChangedMs: stat.ctimeMs,
    socketPath: join(directory, 'herdr.sock'), socketDevice: 1, socketInode: 1,
    workspaceId: 'wOLD', tabId: 'wOLD:t1', paneId: 'wOLD:p1', terminalId: 'term_012345abcdef' }
}

test('missing socket cold-starts one persistent server and concurrent Apps reuse it', async () => {
  const runtime = fixture(); sockets.push(runtime.socketPath)
  expect(await herdrSocketAvailable(runtime.socketPath)).toBe(false)
  const results = await Promise.allSettled([ensureHerdrServer(runtime), ensureHerdrServer(runtime)])
  expect(results.some(result => result.status === 'fulfilled')).toBe(true)
  await ensureHerdrServer(runtime)
  expect(await herdrSocketAvailable(runtime.socketPath)).toBe(true)
  expect(readFileSync(join(runtime.socketPath, '..', 'starts'), 'utf8')).toBe('start\n')
})

test('stale socket recovers but regular or unowned endpoints are never overwritten', async () => {
  const runtime = fixture()
  const server = Bun.listen({ unix: runtime.socketPath, socket: {data() {}} })
  chmodSync(runtime.socketPath, 0o600)
  server.stop(true)
  sockets.push(runtime.socketPath)
  await ensureHerdrServer(runtime)
  expect(await herdrSocketAvailable(runtime.socketPath)).toBe(true)
  const other = fixture()
  writeFileSync(other.socketPath, 'do not replace', { mode: 0o600 })
  await expect(ensureHerdrServer(other)).rejects.toThrow('socket')
  expect(readFileSync(other.socketPath, 'utf8')).toBe('do not replace')
})

test('cold launch restores saved session context without inherited pane or credential environment', () => {
  const runtime = fixture()
  const env = recoveryServerEnvironment(runtime, { HOME: '/home/example', HERDR_SESSION: 'foreign', SLACK_BOT_TOKEN: 'not-forwarded' })
  expect(env.HERDR_SESSION).toBeUndefined()
  expect(env.SLACK_BOT_TOKEN).toBeUndefined()
  expect(env.HERDR_PANE_ID).toBeUndefined()
  expect(env.HERDR_SOCKET_PATH).toBe(runtime.socketPath)
  const named = recoveryServerEnvironment({ ...runtime, socketPath: join(runtime.socketPath, '..', 'sessions', 'work.project', 'herdr.sock') })
  expect(named.HERDR_SESSION).toBe('work.project')
  expect(named.XDG_CONFIG_HOME).toBe(env.XDG_CONFIG_HOME)
})
