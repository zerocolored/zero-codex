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
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { homedir, tmpdir } from 'os'

// walkExecutable() rejects world-writable ancestors; Linux's /tmp is 1777, so
// fixtures live under $HOME there (macOS's per-user $TMPDIR is 0700).
const temporaryParent = process.platform === 'linux' ? homedir() : tmpdir()
import { join } from 'path'
import {
  encodeOfficialCodexSnapshot,
  officialStandaloneTarget,
  resolveOfficialStandaloneCodex,
  resolveOfficialStandaloneCodexForTesting,
  verifyEncodedOfficialCodexSnapshot,
} from './standalone-codex.ts'

// The official standalone layout is asserted for real on both kernels.
const noOfficialRuntime = process.platform !== 'darwin' && process.platform !== 'linux'
import { ensureManagedDirectory, prepareManagedStateRoot } from './managed-path.ts'
import { createSeatbeltFingerprint } from './seatbelt-fingerprint.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const temporary = mkdtempSync(join(temporaryParent, '.zerokun-official-codex-home-'))
  temporaryRoots.push(temporary)
  const home = realpathSync(temporary)
  // The official installer uses the same 2-link layout on Linux with the musl
  // target (x86_64-unknown-linux-musl, verified on WSL2 with codex 0.162.0).
  const target = officialStandaloneTarget()
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

describe('official standalone Codex trust boundary', () => {
  test.skipIf(noOfficialRuntime)('公式installerの固定2-link layoutを解決する', () => {
    const value = fixture()
    const resolved = resolveOfficialStandaloneCodexForTesting(value.home)
    expect(resolved.physical).toBe(value.leaf)
    expect(resolved.packageVersion).toBe('0.149.1')
    expect(resolved.nodes.filter(node => node.kind === 'symlink').map(node => node.path))
      .toEqual([value.logical, value.current])
  })

  test('platformごとの公式standalone targetはinstallerの命名と一致する', () => {
    const expected = process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
      : process.platform === 'linux'
        ? (process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl')
        : null
    if (expected === null) {
      expect(() => officialStandaloneTarget()).toThrow('Codex official standalone runtime')
    } else {
      expect(officialStandaloneTarget()).toBe(expected)
    }
  })

  test.skipIf(noOfficialRuntime)('direct linkや余分なlink hopを拒否する', () => {
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

  test.skipIf(noOfficialRuntime)('古い・不一致・追加field付きmanifestを拒否する', () => {
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

  test.skipIf(process.platform !== 'linux')('ELF以外のexecutableとhardlink executableを拒否する', () => {
    const notElf = fixture()
    // A Mach-O header must not pass as a Linux native binary.
    writeFileSync(notElf.leaf, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]), {
      mode: 0o700,
    })
    expect(() => resolveOfficialStandaloneCodexForTesting(notElf.home)).toThrow('native binary')

    const script = fixture()
    writeFileSync(script.leaf, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    expect(() => resolveOfficialStandaloneCodexForTesting(script.home)).toThrow('native binary')

    const hardlinked = fixture()
    const sibling = join(hardlinked.release, 'bin/codex-copy')
    rmSync(hardlinked.leaf)
    copyFileSync(realpathSync(process.execPath), sibling)
    chmodSync(sibling, 0o700)
    linkSync(sibling, hardlinked.leaf)
    expect(() => resolveOfficialStandaloneCodexForTesting(hardlinked.home)).toThrow()
  })

  test.skipIf(noOfficialRuntime)('snapshotの改変をproduction resolverで拒否する', () => {
    const actual = resolveOfficialStandaloneCodex()
    const tampered = { ...actual, packageVersion: '999.0.0' }
    expect(() => verifyEncodedOfficialCodexSnapshot(encodeOfficialCodexSnapshot(tampered)))
      .toThrow('changed after it was verified')
  })

  test.skipIf(noOfficialRuntime
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'supervisorは公式snapshotを再検証して実体を起動する',
    async () => {
      const root = mkdtempSync(join(temporaryParent, '.zerokun-official-supervisor-'))
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

  test.skipIf(noOfficialRuntime)(
    'supervisorはsnapshotなし・改変snapshotをregistration前にfail-closeする',
    async () => {
      const root = mkdtempSync(join(temporaryParent, '.zerokun-official-supervisor-reject-'))
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
