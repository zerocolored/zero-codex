import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  encodeOfficialCodexSnapshot,
  resolveOfficialStandaloneCodex,
  resolveOfficialStandaloneCodexForTesting,
  verifyEncodedOfficialCodexSnapshot,
  verifyOfficialCodexSnapshotForTesting,
} from './standalone-codex.ts'
import { ensureManagedDirectory, prepareManagedStateRoot } from './managed-path.ts'
import { createSeatbeltFingerprint } from './seatbelt-fingerprint.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'zerokun-official-codex-home-'))
  temporaryRoots.push(temporary)
  const home = realpathSync(temporary)
  const target = process.arch === 'arm64'
    ? 'aarch64-apple-darwin'
    : 'x86_64-apple-darwin'
  const standalone = join(home, '.codex/packages/standalone')
  const release = join(standalone, `releases/0.149.1-${target}`)
  const leaf = join(release, 'bin/codex')
  const current = join(standalone, 'current')
  const logical = join(home, '.local/bin/codex')
  mkdirSync(join(release, 'bin'), { recursive: true, mode: 0o700 })
  mkdirSync(join(home, '.local/bin'), { recursive: true, mode: 0o700 })
  copyFileSync(realpathSync(process.execPath), leaf)
  chmodSync(leaf, 0o700)
  writeFileSync(join(release, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1,
    version: '0.149.1',
    target,
    variant: 'codex',
    entrypoint: 'bin/codex',
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path',
  }), { mode: 0o600 })
  symlinkSync(release, current)
  symlinkSync(join(current, 'bin/codex'), logical)
  return { home, target, standalone, release, leaf, current, logical }
}

function updateFixture(value: ReturnType<typeof fixture>) {
  const release = join(value.standalone, `releases/0.149.2-${value.target}`)
  mkdirSync(join(release, 'bin'), { recursive: true, mode: 0o700 })
  copyFileSync(value.leaf, join(release, 'bin/codex'))
  const manifest = JSON.parse(readFileSync(join(value.release, 'codex-package.json'), 'utf8'))
  writeFileSync(join(release, 'codex-package.json'), JSON.stringify({ ...manifest, version: '0.149.2' }), { mode: 0o600 })
  rmSync(value.current)
  symlinkSync(release, value.current)
  rmSync(value.logical)
  symlinkSync(join(value.current, 'bin/codex'), value.logical)
  return release
}

describe('official standalone Codex trust boundary', () => {
  test.skipIf(process.platform !== 'darwin')('公式installerの固定2-link layoutを解決する', () => {
    const value = fixture()
    const resolved = resolveOfficialStandaloneCodexForTesting(value.home)
    expect(resolved.physical).toBe(value.leaf)
    expect(resolved.packageVersion).toBe('0.149.1')
    expect(resolved.nodes.filter(node => node.kind === 'symlink').map(node => node.path))
      .toEqual([value.logical, value.current])
  })

  test.skipIf(process.platform !== 'darwin')('direct linkや余分なlink hopを拒否する', () => {
    const direct = fixture()
    rmSync(direct.logical)
    symlinkSync(direct.leaf, direct.logical)
    expect(() => resolveOfficialStandaloneCodexForTesting(direct.home)).toThrow('symlink layout')

    const extra = fixture()
    const intermediary = join(extra.home, '.local/bin/codex-entry')
    rmSync(extra.logical)
    symlinkSync(join(extra.current, 'bin/codex'), intermediary)
    symlinkSync(intermediary, extra.logical)
    expect(() => resolveOfficialStandaloneCodexForTesting(extra.home)).toThrow('symlink layout')
  })

  test.skipIf(process.platform !== 'darwin')('古い・不一致・追加field付きmanifestを拒否する', () => {
    for (const mutate of [
      (manifest: Record<string, unknown>) => { manifest.version = '0.148.9' },
      (manifest: Record<string, unknown>) => { manifest.target = 'wrong-target' },
      (manifest: Record<string, unknown>) => { manifest.unexpected = true },
    ]) {
      const value = fixture()
      const path = join(value.release, 'codex-package.json')
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      mutate(manifest)
      writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 })
      expect(() => resolveOfficialStandaloneCodexForTesting(value.home)).toThrow('manifest')
    }
  })

  test.skipIf(process.platform !== 'darwin')('別CPUのMach-Oとhardlink executableを拒否する', () => {
    const wrongCpu = fixture()
    const otherCpu = process.arch === 'arm64'
      ? [0x07, 0x00, 0x00, 0x01]
      : [0x0c, 0x00, 0x00, 0x01]
    writeFileSync(wrongCpu.leaf, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, ...otherCpu]), {
      mode: 0o700,
    })
    expect(() => resolveOfficialStandaloneCodexForTesting(wrongCpu.home)).toThrow('native binary')

    const hardlinked = fixture()
    const sibling = join(hardlinked.release, 'bin/codex-copy')
    rmSync(hardlinked.leaf)
    copyFileSync(realpathSync(process.execPath), sibling)
    chmodSync(sibling, 0o700)
    linkSync(sibling, hardlinked.leaf)
    expect(() => resolveOfficialStandaloneCodexForTesting(hardlinked.home)).toThrow()
  })

  test.skipIf(process.platform !== 'darwin')('snapshotの改変をproduction resolverで拒否する', () => {
    const actual = resolveOfficialStandaloneCodex()
    const tampered = { ...actual, packageVersion: '999.0.0' }
    expect(() => verifyEncodedOfficialCodexSnapshot(encodeOfficialCodexSnapshot(tampered)))
      .toThrow('changed after it was verified')
  })

  test.skipIf(process.platform !== 'darwin')('公式更新と同一target link再作成でも実行中の物理releaseを維持する', () => {
    const value = fixture()
    const pinned = resolveOfficialStandaloneCodexForTesting(value.home)
    for (const [path, target] of [[value.logical, join(value.current, 'bin/codex')], [value.current, value.release]]) {
      rmSync(path!)
      // A task also survives the installer's interval between unlink and rename.
      expect(verifyOfficialCodexSnapshotForTesting(pinned, value.home).physical).toBe(value.leaf)
      symlinkSync(target!, path!)
    }
    expect(verifyOfficialCodexSnapshotForTesting(pinned, value.home)).toEqual(pinned)
    const latest = updateFixture(value)
    expect(verifyOfficialCodexSnapshotForTesting(pinned, value.home)).toEqual(pinned)
    expect(resolveOfficialStandaloneCodexForTesting(value.home).physical).toBe(join(latest, 'bin/codex'))
    // Serialized object key order is not part of executable identity.
    const reordered = JSON.parse(JSON.stringify(pinned, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).reverse()) : item))
    expect(verifyOfficialCodexSnapshotForTesting(reordered, value.home)).toEqual(pinned)
    rmSync(value.release, { recursive: true })
    expect(() => verifyOfficialCodexSnapshotForTesting(pinned, value.home)).toThrow()
  })

  test.skipIf(process.platform !== 'darwin')('更新後も固定binary・manifest・親directoryの改変を拒否する', () => {
    const mutations: Array<(value: ReturnType<typeof fixture>) => void> = [
      value => { writeFileSync(value.leaf, readFileSync(value.leaf)) },
      value => { const copy = value.leaf + '.copy'; copyFileSync(value.leaf, copy); renameSync(copy, value.leaf) },
      value => { chmodSync(value.leaf, 0o777) },
      value => { linkSync(value.leaf, value.leaf + '.link') },
      value => { const path = join(value.release, 'codex-package.json'); writeFileSync(path, readFileSync(path)) },
      value => { chmodSync(join(value.release, 'bin'), 0o777) },
      value => { const path = join(value.release, 'bin'); renameSync(path, path + '-old'); symlinkSync(path + '-old', path) },
      value => { const path = join(value.release, 'bin'); renameSync(path, path + '-old'); mkdirSync(path, { mode: 0o700 }); renameSync(join(path + '-old', 'codex'), value.leaf) },
    ]
    for (const mutate of mutations) {
      const value = fixture()
      const pinned = resolveOfficialStandaloneCodexForTesting(value.home)
      updateFixture(value)
      mutate(value)
      expect(() => verifyOfficialCodexSnapshotForTesting(pinned, value.home)).toThrow()
    }
  })

  test.skipIf(process.platform !== 'darwin')('固定snapshotのpath・node列・identity・余分fieldの偽装を拒否する', () => {
    const value = fixture()
    const pinned = resolveOfficialStandaloneCodexForTesting(value.home)
    updateFixture(value)
    const mutations: Array<(snapshot: typeof pinned) => void> = [
      snapshot => { snapshot.physical = '/usr/bin/true' },
      snapshot => { snapshot.logical += '-other' },
      snapshot => { snapshot.releaseDir += '-other' },
      snapshot => { snapshot.packageVersion = '999.0.0' },
      snapshot => { snapshot.nodes.pop() },
      snapshot => { snapshot.nodes.splice(-1, 0, snapshot.nodes.at(-1)!) },
      snapshot => { snapshot.nodes.reverse() },
      snapshot => { snapshot.nodes[0]!.identity.ino = '9999999' },
      snapshot => { (snapshot.nodes[0]!.identity as any).ino = 1 },
      snapshot => { snapshot.nodes.find(node => node.kind === 'symlink')!.resolvedTarget = '/usr/bin/true' },
      snapshot => { snapshot.nodes.find(node => node.kind === 'symlink')!.target = '/usr/bin/true' },
      snapshot => { snapshot.resolutionPaths.pop() },
      snapshot => { (snapshot as any).extra = true },
      snapshot => { (snapshot.manifestIdentity as any).extra = true },
    ]
    for (const mutate of mutations) {
      const forged = structuredClone(pinned)
      mutate(forged)
      expect(() => verifyOfficialCodexSnapshotForTesting(forged, value.home)).toThrow()
    }
  })

  test.skipIf(process.platform !== 'darwin')('更新後のencoded snapshotでsupervisorが旧物理releaseを起動する', async () => {
    const value = fixture()
    const pinned = resolveOfficialStandaloneCodexForTesting(value.home)
    updateFixture(value)
    const state = prepareManagedStateRoot(join(value.home, 'state'))
    ensureManagedDirectory(state, join(state, 'executors'))
    const registration = join(state, 'executors', 'pinned-version.json')
    const fingerprint = createSeatbeltFingerprint(state, 'pinned-version', 'e'.repeat(32))
    const result = Bun.spawn([
      process.execPath, '--config=/dev/null', '--no-env-file', join(import.meta.dir, 'codex-supervisor.ts'),
      'pinned-version', registration,
      '--seatbelt-fingerprint', fingerprint.allow.path, fingerprint.deny.path,
      '--official-codex-snapshot', encodeOfficialCodexSnapshot(pinned), '--', pinned.physical,
      '--config=/dev/null', '--no-env-file', '-e', 'console.log(process.execPath)',
    ], { cwd: value.home, env: { ...process.env, HOME: value.home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true })
    const [code, stdout, stderr] = await Promise.all([result.exited, new Response(result.stdout).text(), new Response(result.stderr).text()])
    expect(code, stderr).toBe(0)
    expect(stdout.trim()).toBe(pinned.physical)
    expect(JSON.parse(readFileSync(registration, 'utf8')).phase).toBe('cleanup-confirmed')
  }, 15_000)

  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'supervisorは公式snapshotを再検証して実体を起動する',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'zerokun-official-supervisor-'))
      temporaryRoots.push(root)
      const state = prepareManagedStateRoot(join(root, 'state'))
      ensureManagedDirectory(state, join(state, 'executors'))
      const registration = join(state, 'executors', 'official-version.json')
      const fingerprint = createSeatbeltFingerprint(state, 'official-version', 'd'.repeat(32))
      const actual = resolveOfficialStandaloneCodex()
      const supervisor = Bun.spawn([
        process.execPath,
        '--config=/dev/null',
        '--no-env-file',
        join(import.meta.dir, 'codex-supervisor.ts'),
        'official-version',
        registration,
        '--seatbelt-fingerprint', fingerprint.allow.path, fingerprint.deny.path,
        '--official-codex-snapshot',
        encodeOfficialCodexSnapshot(actual),
        '--',
        actual.physical,
        '--version',
      ], {
        cwd: root,
        env: process.env,
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        detached: true,
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        supervisor.exited,
        new Response(supervisor.stdout).text(),
        new Response(supervisor.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(0)
      expect(stdout).toContain(`codex-cli ${actual.packageVersion}`)
      expect(existsSync(registration)).toBe(true)
      expect(JSON.parse(readFileSync(registration, 'utf8'))).toMatchObject({
        version: 4,
        phase: 'cleanup-confirmed',
        jobId: 'official-version',
        fingerprint,
      })
    },
    15_000,
  )

  test.skipIf(process.platform !== 'darwin')(
    'supervisorはsnapshotなし・改変snapshotをregistration前にfail-closeする',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'zerokun-official-supervisor-reject-'))
      temporaryRoots.push(root)
      const marker = join(root, 'child-started')
      const fake = join(root, 'fake-codex')
      writeFileSync(fake, `#!/bin/sh\nprintf started > ${JSON.stringify(marker)}\n`, { mode: 0o700 })
      const supervisorPath = join(import.meta.dir, 'codex-supervisor.ts')
      const actual = resolveOfficialStandaloneCodex()
      const bad = encodeOfficialCodexSnapshot({ ...actual, packageVersion: '999.0.0' })
      for (const command of [
        ['--', fake],
        ['--official-codex-snapshot', bad, '--', fake],
      ]) {
        const registration = join(root, `executor-${Math.random()}.json`)
        const result = Bun.spawnSync([
          process.execPath,
          '--config=/dev/null',
          '--no-env-file',
          supervisorPath,
          'rejected',
          registration,
          ...command,
        ], {
          cwd: root,
          env: process.env,
          stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        })
        expect(result.exitCode).not.toBe(0)
        expect(existsSync(registration)).toBe(false)
        expect(existsSync(marker)).toBe(false)
      }
    },
  )
})
