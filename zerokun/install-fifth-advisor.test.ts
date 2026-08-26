import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { createServer } from 'node:net'
import {
  installFifthAdvisorHelper,
  resolveFifthAdvisorHelper,
} from './install-fifth-advisor.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), 'zerokun-fifth-advisor-'))
  roots.push(home)
  chmodSync(home, 0o700)
  return home
}

describe('fifth-advisor helper installer', () => {
  test('bundled helperをowner-onlyで配置して内容まで固定する', () => {
    const home = fixture()
    const installed = installFifthAdvisorHelper(home)
    expect(installed).toBe(join(realpathSync(home), '.zerokun/runtime/fifth-advisor.py'))
    expect(lstatSync(join(home, '.zerokun')).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(home, '.zerokun/runtime')).mode & 0o777).toBe(0o700)
    expect(lstatSync(installed).mode & 0o777).toBe(0o700)
    expect(readFileSync(installed)).toEqual(readFileSync(join(import.meta.dir, 'fifth-advisor.py')))
    expect(resolveFifthAdvisorHelper(home)).toBe(installed)
  })

  test('改変、hardlink、symlink directoryを拒否する', () => {
    const first = fixture()
    const installed = installFifthAdvisorHelper(first)
    writeFileSync(installed, '# changed\n', { mode: 0o700 })
    expect(() => resolveFifthAdvisorHelper(first)).toThrow('integrity mismatch')

    const second = fixture()
    const linked = installFifthAdvisorHelper(second)
    linkSync(linked, join(second, 'helper-hardlink'))
    expect(() => resolveFifthAdvisorHelper(second)).toThrow('unsafe fifth-advisor file')

    const third = fixture()
    mkdirSync(join(third, '.zerokun'))
    const outside = join(third, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(third, '.zerokun/runtime'))
    expect(() => installFifthAdvisorHelper(third)).toThrow('unsafe fifth-advisor directory')
  })

  test('host共有helperを変更せずZero専用namespaceだけへ配置する', () => {
    const home = fixture()
    const sharedDirectory = join(home, '.codex/herdr')
    mkdirSync(sharedDirectory, { recursive: true, mode: 0o700 })
    chmodSync(join(home, '.codex'), 0o755)
    chmodSync(sharedDirectory, 0o700)
    const sharedHelper = join(sharedDirectory, 'fifth-advisor.py')
    const sentinel = '# host-owned fifth-advisor helper\n'
    writeFileSync(sharedHelper, sentinel, { mode: 0o700 })
    const before = lstatSync(sharedHelper)

    const installed = installFifthAdvisorHelper(home)

    const after = lstatSync(sharedHelper)
    expect(readFileSync(sharedHelper, 'utf8')).toBe(sentinel)
    for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const) {
      expect(after[key]).toBe(before[key])
    }
    expect(installed).toBe(join(realpathSync(home), '.zerokun/runtime/fifth-advisor.py'))
    expect(resolveFifthAdvisorHelper(home)).toBe(installed)
  })

  test('prompt本文をargvへ載せずcurrent Herdr socketのagent.promptへ送る', async () => {
    const home = fixture()
    const project = join(home, 'project')
    const request = join(home, 'request')
    const bin = join(home, 'bin')
    mkdirSync(project, { mode: 0o700 })
    mkdirSync(request, { mode: 0o700 })
    mkdirSync(bin, { mode: 0o700 })
    const gitInit = Bun.spawnSync(['/usr/bin/git', 'init', '-q', project], {
      env: { PATH: '/usr/bin:/bin', HOME: home }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(gitInit.exitCode, gitInit.stderr.toString()).toBe(0)

    const confidential = 'SLACK-CONFIDENTIAL-HERDR-SOCKET-SENTINEL'
    writeFileSync(join(request, 'prompt'), `Review ${confidential}\n`, { mode: 0o600 })
    const cliCapture = join(home, 'herdr-cli-was-executed')
    const fakeHerdr = join(bin, 'herdr')
    writeFileSync(fakeHerdr, '#!/bin/sh\n: > "$HERDR_CLI_CAPTURE"\nexit 99\n', { mode: 0o700 })
    const helper = installFifthAdvisorHelper(home)
    const baseEnvironment = {
      HOME: home,
      PATH: `${dirname(fakeHerdr)}:/usr/bin:/bin`,
      HERDR_ENV: '1',
      HERDR_CLI_CAPTURE: cliCapture,
    }
    const snapshot = Bun.spawnSync([
      '/usr/bin/python3', helper, 'snapshot',
      '--project-root', project, '--request-dir', request,
    ], { env: baseEnvironment, stdout: 'pipe', stderr: 'pipe' })
    expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0)

    const socketPath = join(home, 'herdr.sock')
    let received: Record<string, any> | undefined
    const socketServer = createServer(connection => {
      let buffered = ''
      connection.setEncoding('utf8')
      connection.on('data', chunk => {
        buffered += chunk
        const newline = buffered.indexOf('\n')
        if (newline < 0) return
        received = JSON.parse(buffered.slice(0, newline)) as Record<string, any>
        connection.end(`${JSON.stringify({
          id: received.id,
          result: { type: 'agent_prompted', agent: { pane_id: 'w1:p2' } },
        })}\n`)
      })
    })
    await new Promise<void>((resolve, reject) => {
      socketServer.once('error', reject)
      socketServer.listen(socketPath, resolve)
    })
    chmodSync(socketPath, 0o600)
    const pinnedSocket = lstatSync(socketPath)
    try {
      const child = Bun.spawn([
        '/usr/bin/python3', helper, 'send',
        '--project-root', project, '--request-dir', request, '--target', 'w1:p2',
        '--socket-device', String(pinnedSocket.dev),
        '--socket-inode', String(pinnedSocket.ino),
      ], {
        env: { ...baseEnvironment, HERDR_SOCKET_PATH: socketPath },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(0)
      expect(stdout).toContain('"status": "prompt-started"')
      expect(stdout).not.toContain(confidential)
    } finally {
      await new Promise<void>(resolve => socketServer.close(() => resolve()))
    }
    expect(received).toMatchObject({
      method: 'agent.prompt',
      params: { target: 'w1:p2' },
    })
    expect(received?.params?.text).toContain(confidential)
    expect(received?.params?.text).toMatch(/REQUEST_MARKER=[0-9A-F]{32}/)
    expect(() => lstatSync(cliCapture)).toThrow()
  }, 15_000)

  test('pin後に同じpathのHerdr socketが差し替わればBへ1byteも送らない', async () => {
    const home = fixture()
    const project = join(home, 'project')
    const request = join(home, 'request')
    const bin = join(home, 'bin')
    mkdirSync(project, { mode: 0o700 })
    mkdirSync(request, { mode: 0o700 })
    mkdirSync(bin, { mode: 0o700 })
    const gitInit = Bun.spawnSync(['/usr/bin/git', 'init', '-q', project], {
      env: { PATH: '/usr/bin:/bin', HOME: home }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(gitInit.exitCode, gitInit.stderr.toString()).toBe(0)
    writeFileSync(join(request, 'prompt'), 'Review without misdelivery\n', { mode: 0o600 })
    const fakeHerdr = join(bin, 'herdr')
    writeFileSync(fakeHerdr, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    const helper = installFifthAdvisorHelper(home)
    const baseEnvironment = {
      HOME: home,
      PATH: `${dirname(fakeHerdr)}:/usr/bin:/bin`,
      HERDR_ENV: '1',
    }
    const snapshot = Bun.spawnSync([
      '/usr/bin/python3', helper, 'snapshot',
      '--project-root', project, '--request-dir', request,
    ], { env: baseEnvironment, stdout: 'pipe', stderr: 'pipe' })
    expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0)

    const socketPath = join(home, 'herdr.sock')
    const first = createServer()
    await new Promise<void>((resolve, reject) => {
      first.once('error', reject)
      first.listen(socketPath, resolve)
    })
    chmodSync(socketPath, 0o600)
    const pinned = lstatSync(socketPath)
    await new Promise<void>(resolve => first.close(() => resolve()))
    rmSync(socketPath, { force: true })

    let receivedBytes = 0
    const replacement = createServer(connection => {
      connection.on('data', chunk => { receivedBytes += chunk.length })
    })
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject)
      replacement.listen(socketPath, resolve)
    })
    chmodSync(socketPath, 0o600)
    try {
      const child = Bun.spawn([
        '/usr/bin/python3', helper, 'send',
        '--project-root', project, '--request-dir', request, '--target', 'w1:p2',
        '--socket-device', String(pinned.dev),
        '--socket-inode', String(pinned.ino),
      ], {
        env: { ...baseEnvironment, HERDR_SOCKET_PATH: socketPath },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).then(([exitCode, stdout]) => [exitCode, stdout] as const)
      expect(exitCode).not.toBe(0)
      expect(stdout).not.toContain('prompt-started')
      await Bun.sleep(25)
      expect(receivedBytes).toBe(0)
    } finally {
      await new Promise<void>(resolve => replacement.close(() => resolve()))
    }
  }, 15_000)

  test('matching JSON-RPC errorを明確な未送達拒否として返す', async () => {
    const home = fixture()
    const project = join(home, 'project')
    const request = join(home, 'request')
    const bin = join(home, 'bin')
    mkdirSync(project, { mode: 0o700 })
    mkdirSync(request, { mode: 0o700 })
    mkdirSync(bin, { mode: 0o700 })
    const gitInit = Bun.spawnSync(['/usr/bin/git', 'init', '-q', project], {
      env: { PATH: '/usr/bin:/bin', HOME: home }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(gitInit.exitCode, gitInit.stderr.toString()).toBe(0)
    writeFileSync(join(request, 'prompt'), 'Review this rejection\n', { mode: 0o600 })
    const fakeHerdr = join(bin, 'herdr')
    writeFileSync(fakeHerdr, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    const helper = installFifthAdvisorHelper(home)
    const environment = {
      HOME: home,
      PATH: `${dirname(fakeHerdr)}:/usr/bin:/bin`,
      HERDR_ENV: '1',
    }
    const snapshot = Bun.spawnSync([
      '/usr/bin/python3', helper, 'snapshot',
      '--project-root', project, '--request-dir', request,
    ], { env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0)

    const socketPath = join(home, 'herdr.sock')
    const socketServer = createServer(connection => {
      let buffer = ''
      connection.on('data', chunk => {
        buffer += chunk.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const requestBody = JSON.parse(buffer.slice(0, newline)) as { id: string }
        connection.end(`${JSON.stringify({
          id: requestBody.id,
          error: { code: 'agent_blocked', message: 'target rejected the prompt' },
        })}\n`)
      })
    })
    await new Promise<void>((resolve, reject) => {
      socketServer.once('error', reject)
      socketServer.listen(socketPath, resolve)
    })
    chmodSync(socketPath, 0o600)
    const pinned = lstatSync(socketPath)
    try {
      const child = Bun.spawn([
        '/usr/bin/python3', helper, 'send',
        '--project-root', project, '--request-dir', request, '--target', 'w1:p2',
        '--socket-device', String(pinned.dev),
        '--socket-inode', String(pinned.ino),
      ], {
        env: { ...environment, HERDR_SOCKET_PATH: socketPath },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(6)
      expect(stdout).toContain('"status": "prompt-started"')
      expect(stdout).toContain('"status": "prompt-command-rejected"')
      expect(stdout).not.toContain('target rejected the prompt')
    } finally {
      await new Promise<void>(resolve => socketServer.close(() => resolve()))
    }
  }, 15_000)

  test('未知のmatching success resultを未送達扱いせずambiguousに保つ', async () => {
    const home = fixture()
    const project = join(home, 'project')
    const request = join(home, 'request')
    const bin = join(home, 'bin')
    mkdirSync(project, { mode: 0o700 })
    mkdirSync(request, { mode: 0o700 })
    mkdirSync(bin, { mode: 0o700 })
    const gitInit = Bun.spawnSync(['/usr/bin/git', 'init', '-q', project], {
      env: { PATH: '/usr/bin:/bin', HOME: home }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(gitInit.exitCode, gitInit.stderr.toString()).toBe(0)
    writeFileSync(join(request, 'prompt'), 'Review an unknown success shape\n', { mode: 0o600 })
    const fakeHerdr = join(bin, 'herdr')
    writeFileSync(fakeHerdr, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    const helper = installFifthAdvisorHelper(home)
    const environment = {
      HOME: home,
      PATH: `${dirname(fakeHerdr)}:/usr/bin:/bin`,
      HERDR_ENV: '1',
    }
    const snapshot = Bun.spawnSync([
      '/usr/bin/python3', helper, 'snapshot',
      '--project-root', project, '--request-dir', request,
    ], { env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(snapshot.exitCode, snapshot.stderr.toString()).toBe(0)

    const socketPath = join(home, 'herdr.sock')
    const socketServer = createServer(connection => {
      let buffer = ''
      connection.on('data', chunk => {
        buffer += chunk.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const requestBody = JSON.parse(buffer.slice(0, newline)) as { id: string }
        connection.end(`${JSON.stringify({
          id: requestBody.id,
          result: { type: 'agent_prompt_accepted_v2', queued: true },
        })}\n`)
      })
    })
    await new Promise<void>((resolve, reject) => {
      socketServer.once('error', reject)
      socketServer.listen(socketPath, resolve)
    })
    chmodSync(socketPath, 0o600)
    const pinned = lstatSync(socketPath)
    try {
      const child = Bun.spawn([
        '/usr/bin/python3', helper, 'send',
        '--project-root', project, '--request-dir', request, '--target', 'w1:p2',
        '--socket-device', String(pinned.dev),
        '--socket-inode', String(pinned.ino),
      ], {
        env: { ...environment, HERDR_SOCKET_PATH: socketPath },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(5)
      expect(stdout).toContain('"status": "prompt-started"')
      expect(stdout).toContain('"status": "prompt-command-timeout-or-error"')
      expect(stdout).not.toContain('prompt-command-rejected')
    } finally {
      await new Promise<void>(resolve => socketServer.close(() => resolve()))
    }
  }, 15_000)
})
