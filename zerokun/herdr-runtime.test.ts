import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  decodeHerdrRuntimeIdentity,
  encodeHerdrRuntimeIdentity,
  herdrControlPlaneFingerprint,
  herdrRuntimeFingerprint,
  readPinnedHerdrRuntime,
  requireHerdrRuntime,
  verifyHerdrRuntimeIdentity,
  verifyHerdrRuntimeIdentityAsync,
  writePinnedHerdrRuntime,
} from './herdr-runtime.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(): {
  environment: Record<string, string>
  setMode(mode: 'normal' | 'hang' | 'huge'): void
  stop(): void
} {
  const directory = mkdtempSync(join(tmpdir(), 'zerochan-herdr-runtime-'))
  directories.push(directory)
  chmodSync(directory, 0o700)
  const socketPath = join(directory, 'herdr.sock')
  const server = Bun.listen({ unix: socketPath, socket: { data() {} } })
  chmodSync(socketPath, 0o600)
  const binary = join(directory, 'herdr')
  const modePath = join(directory, 'mode')
  writeFileSync(modePath, 'normal\n', { mode: 0o600 })
  writeFileSync(binary, [
    '#!/bin/sh',
    `IFS= read -r mode < ${JSON.stringify(modePath)}`,
    'if [ "$mode" = hang ]; then exec /bin/sleep 10; fi',
    'if [ "$mode" = huge ]; then exec /usr/bin/yes X; fi',
    `printf '%s\\n' ${JSON.stringify(JSON.stringify({
      id: 'fixture',
      result: { pane: {
        pane_id: 'wT:p2',
        tab_id: 'wT:t3',
        terminal_id: 'term_012345abcdef',
        workspace_id: 'wT',
      } },
    }))}`,
    '',
  ].join('\n'), { mode: 0o700 })
  return {
    environment: {
      PATH: '/usr/bin:/bin',
      HERDR_ENV: '1',
      HERDR_BIN_PATH: binary,
      HERDR_SOCKET_PATH: socketPath,
      // Stale aliases are intentionally ignored; pane current is canonical.
      HERDR_PANE_ID: 'wOLD:p1',
      HERDR_TAB_ID: 'wOLD:t1',
      HERDR_WORKSPACE_ID: 'wOLD',
    },
    setMode: mode => writeFileSync(modePath, `${mode}\n`, { mode: 0o600 }),
    stop: () => server.stop(true),
  }
}

describe('Herdr runtime binding', () => {
  test('Herdr外の起動をfail closedにする', () => {
    expect(() => requireHerdrRuntime({ PATH: '/usr/bin:/bin' }))
      .toThrow('Herdr内から起動')
  })

  test('current paneを正本にsocketとterminal identityを固定する', () => {
    const value = fixture()
    try {
      const identity = requireHerdrRuntime(value.environment)
      expect(identity.paneId).toBe('wT:p2')
      expect(identity.tabId).toBe('wT:t3')
      expect(identity.terminalId).toBe('term_012345abcdef')
      expect(identity.workspaceId).toBe('wT')
      expect(identity.socketInode).toBeGreaterThan(0)
      expect(() => verifyHerdrRuntimeIdentity(identity, value.environment)).not.toThrow()
      expect(() => verifyHerdrRuntimeIdentity(
        { ...identity, terminalId: 'term_replaced' },
        value.environment,
      )).toThrow('identity changed')
      writeFileSync(value.environment.HERDR_BIN_PATH!, '#!/bin/sh\nexit 9\n', { mode: 0o700 })
      expect(() => verifyHerdrRuntimeIdentity(identity, value.environment))
        .toThrow('identity changed')
    } finally {
      value.stop()
    }
  })

  test('launcherのidentityをowner-only stateへ固定してjob時に再利用する', () => {
    const value = fixture()
    try {
      const state = join(directories[directories.length - 1]!, 'state')
      mkdirSync(state, { mode: 0o700 })
      const identity = requireHerdrRuntime(value.environment)
      writePinnedHerdrRuntime(state, identity)
      const pinned = readPinnedHerdrRuntime(state)
      expect(pinned).toEqual(identity)
      expect(herdrRuntimeFingerprint(pinned)).toHaveLength(64)
      expect(herdrControlPlaneFingerprint(pinned)).toHaveLength(64)
      expect(decodeHerdrRuntimeIdentity(encodeHerdrRuntimeIdentity(identity))).toEqual(identity)
      expect(() => verifyHerdrRuntimeIdentity(pinned, value.environment)).not.toThrow()
    } finally {
      value.stop()
    }
  })

  test('Herdr currentが停止してもasync検証はevent loopを止めず期限内にfail closedする', async () => {
    const value = fixture()
    try {
      const identity = requireHerdrRuntime(value.environment)
      value.setMode('hang')
      let heartbeats = 0
      const heartbeat = setInterval(() => { heartbeats += 1 }, 10)
      const startedAt = Date.now()
      try {
        await expect(verifyHerdrRuntimeIdentityAsync(identity, value.environment, 100))
          .rejects.toThrow('timed out')
      } finally {
        clearInterval(heartbeat)
      }
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(heartbeats).toBeGreaterThanOrEqual(3)
    } finally {
      value.stop()
    }
  })

  test('Herdr currentの巨大出力を上限で打ち切る', async () => {
    const value = fixture()
    try {
      const identity = requireHerdrRuntime(value.environment)
      value.setMode('huge')
      const startedAt = Date.now()
      await expect(verifyHerdrRuntimeIdentityAsync(identity, value.environment, 2_000))
        .rejects.toThrow('excessive output')
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    } finally {
      value.stop()
    }
  })
})
