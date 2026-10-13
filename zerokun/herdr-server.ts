import { spawn } from 'child_process'
import { closeSync, lstatSync, realpathSync } from 'fs'
import { connect } from 'net'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { currentHerdrBinary, type HerdrRuntimeIdentity } from './herdr-runtime.ts'
import { openSafeLog } from './safe-file.ts'
import { releaseProcessLock, tryAcquireProcessLock } from './process-lock.ts'

/** Probe the exact saved endpoint. An unresponsive listener is not a dead server. */
export async function herdrSocketAvailable(path: string): Promise<boolean> {
  try {
    const node = lstatSync(path)
    if (!node.isSocket() || node.uid !== process.getuid?.() || (node.mode & 0o022)) {
      throw new Error('Herdr socket is not an owned private socket')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Herdr socket probe timed out')) }, 1000)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true) })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer); socket.destroy()
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(false)
      else reject(error)
    })
  })
}

/** Recover the original standard session, never fall back to the focused/default session. */
export function recoveryServerEnvironment(runtime: HerdrRuntimeIdentity, source = process.env): Record<string, string> {
  const directory = dirname(runtime.socketPath)
  let configDirectory = directory
  let session: string | undefined
  if (basename(dirname(directory)) === 'sessions') {
    session = basename(directory)
    configDirectory = dirname(dirname(directory))
    if (!/^[A-Za-z0-9_.-]+$/.test(session)) throw new Error('invalid saved Herdr session')
  }
  if (basename(runtime.socketPath) !== 'herdr.sock' || basename(configDirectory) !== 'herdr') {
    throw new Error('custom Herdr socket requires its original server to be started')
  }
  const home = source.HOME ?? homedir()
  const environment: Record<string, string> = {
    HOME: home, USER: source.USER ?? source.LOGNAME ?? '', LOGNAME: source.LOGNAME ?? source.USER ?? '',
    SHELL: source.SHELL ?? '/bin/zsh', LANG: source.LANG ?? 'en_US.UTF-8', TERM: 'xterm-256color',
    PATH: `${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    XDG_CONFIG_HOME: dirname(configDirectory), HERDR_SOCKET_PATH: runtime.socketPath,
  }
  if (session) environment.HERDR_SESSION = session
  return environment
}

/** Called only with all service processes stopped and the App mutation lock held. */
export async function ensureHerdrServer(runtime: HerdrRuntimeIdentity): Promise<void> {
  if (await herdrSocketAvailable(runtime.socketPath)) return
  const directory = dirname(runtime.socketPath)
  const node = lstatSync(directory)
  if (!node.isDirectory() || node.isSymbolicLink() || node.uid !== process.getuid?.()
    || (node.mode & 0o022) || realpathSync(directory) !== directory) {
    throw new Error('Herdr server directory cannot be verified')
  }
  // Multiple Apps may share this endpoint. Serialize their cold launches too.
  const lockPath = join(directory, 'zerochan-server-start.lock')
  const lock = tryAcquireProcessLock(lockPath)
  if (!lock.acquired) throw new Error('Herdr server startup is already in progress')
  try {
    if (await herdrSocketAvailable(runtime.socketPath)) return
    const environment = recoveryServerEnvironment(runtime)
    const binary = currentHerdrBinary(runtime, environment)
    const log = openSafeLog(join(directory, 'zerochan-server-start.log'), 'append')
    let child
    try {
      child = spawn(binary, ['server'], {
        cwd: directory, env: environment, detached: true, stdio: ['ignore', log, log],
      })
    } finally { closeSync(log) }
    let spawnError: Error | undefined
    child.on('error', error => { spawnError = error })
    // Successful headless servers intentionally outlive the watchdog process.
    child.unref()
    for (let check = 0; check < 100; check++) {
      if (spawnError) throw spawnError
      if (await herdrSocketAvailable(runtime.socketPath)) return
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Herdr server exited before startup')
      await Bun.sleep(100)
    }
    // Do not stop an existing/other server. Only the unready child we spawned.
    child.kill('SIGKILL')
    await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()) })
    throw new Error('Herdr server startup timed out')
  } finally { releaseProcessLock(lockPath, lock.lease) }
}
