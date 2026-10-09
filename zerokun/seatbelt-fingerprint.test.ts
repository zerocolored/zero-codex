import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { prepareManagedStateRoot } from './managed-path.ts'
import {
  observeProcessGeneration,
  readProcessIdentity,
  signalProcessIfLive,
} from './process-generation.ts'
import {
  createSeatbeltFingerprint,
  linuxSandboxReceiptPath,
  linuxSandboxScopeUnit,
  processCarriesSeatbeltFingerprint,
  recoverOrphanSeatbeltFingerprints,
  reapSeatbeltFingerprint,
  removeSeatbeltFingerprint,
  sandboxedCommand,
  sandboxedCommandForTags,
  verifySeatbeltFingerprint,
} from './seatbelt-fingerprint.ts'

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function waitFor(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10)
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`)
}

describe('Seatbelt descendant fingerprint', () => {
  test('tagの置換をcleanup evidenceとして受理しない', () => {
    const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-seatbelt-tags-')))
    temporaryDirs.push(root)
    const fingerprint = createSeatbeltFingerprint(root, 'job-1', 'a'.repeat(32))
    expect(() => verifySeatbeltFingerprint(root, fingerprint)).not.toThrow()
    rmSync(fingerprint.allow.path)
    expect(() => verifySeatbeltFingerprint(root, fingerprint)).toThrow()
  })

  test('旧版retirement中断で残ったdeny単独tagをstartup recoveryで除去する', async () => {
    const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-seatbelt-retire-')))
    temporaryDirs.push(root)
    const fingerprint = createSeatbeltFingerprint(root, 'job-retire', 'd'.repeat(32))
    rmSync(fingerprint.allow.path)

    expect(await recoverOrphanSeatbeltFingerprints(root)).toEqual([])
    expect(existsSync(fingerprint.deny.path)).toBe(false)
    expect(await recoverOrphanSeatbeltFingerprints(root)).toEqual([])
  })

  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'setsidしてPID 1へreparentされたsandbox子をkernel signatureで回収する',
    async () => {
      const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-seatbelt-reap-')))
      temporaryDirs.push(root)
      const fingerprint = createSeatbeltFingerprint(root, 'job-2', 'b'.repeat(32))
      const pidPath = join(root, 'escaped.pid')
      const script = [
        'import os,sys,time',
        'pid=os.fork()',
        'if pid:',
        ' open(sys.argv[1],"w").write(str(pid))',
        ' os._exit(0)',
        'os.setsid()',
        'os.close(0);os.close(1);os.close(2)',
        'time.sleep(60)',
      ].join('\n')
      const profile = [
        '(version 1)',
        '(allow default)',
        `(deny file-read-data (literal ${JSON.stringify(fingerprint.deny.path)}))`,
      ].join('\n')
      const earliest = readProcessIdentity(process.pid)
      expect(earliest).toBeDefined()
      const launcher = Bun.spawn([
        '/usr/bin/sandbox-exec', '-p', profile,
        '/usr/bin/python3', '-c', script, pidPath,
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
      expect(await launcher.exited).toBe(0)
      await waitFor(pidPath)
      const escapedPid = Number(readFileSync(pidPath, 'utf8'))
      const escaped = readProcessIdentity(escapedPid)
      expect(escaped).toBeDefined()
      expect(escaped!.ppid).toBe(1)

      const reaped = await reapSeatbeltFingerprint({
        stateDir: root,
        fingerprint,
        earliest: earliest!,
      })
      expect(reaped).toContain(escapedPid)
      expect(observeProcessGeneration(escaped!).status).toBe('dead')
      removeSeatbeltFingerprint(root, fingerprint)
    },
    10_000,
  )

  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'TERM無視のSeatbelt子は通常cleanupで生存し明示force後だけKILLする',
    async () => {
      const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-seatbelt-force-')))
      temporaryDirs.push(root)
      const fingerprint = createSeatbeltFingerprint(root, 'job-force', 'e'.repeat(32))
      const pidPath = join(root, 'ignored-term.pid')
      const readyPath = join(root, 'ignored-term.ready')
      const script = [
        'import os,signal,sys,time',
        'pid=os.fork()',
        'if pid:',
        ' open(sys.argv[1],"w").write(str(pid))',
        ' os._exit(0)',
        'os.setsid()',
        'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
        'open(sys.argv[2],"w").write("ready")',
        'os.close(0);os.close(1);os.close(2)',
        'time.sleep(60)',
      ].join('\n')
      const profile = [
        '(version 1)',
        '(allow default)',
        `(deny file-read-data (literal ${JSON.stringify(fingerprint.deny.path)}))`,
      ].join('\n')
      const earliest = readProcessIdentity(process.pid)
      expect(earliest).toBeDefined()
      const launcher = Bun.spawn([
        '/usr/bin/sandbox-exec', '-p', profile,
        '/usr/bin/python3', '-c', script, pidPath, readyPath,
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
      expect(await launcher.exited).toBe(0)
      await waitFor(pidPath)
      await waitFor(readyPath)
      const escaped = readProcessIdentity(Number(readFileSync(pidPath, 'utf8')))
      expect(escaped).toBeDefined()
      let force = false
      let forced = 0
      let settled = false
      const reaping = reapSeatbeltFingerprint({
        stateDir: root,
        fingerprint,
        earliest: earliest!,
        waitForForce: () => force,
        onForce: () => { forced += 1 },
      }).finally(() => { settled = true })
      try {
        await Bun.sleep(1_500)
        expect(settled).toBe(false)
        expect(observeProcessGeneration(escaped!).status).toBe('alive')
        force = true
        const reaped = await Promise.race([
          reaping,
          Bun.sleep(4_000).then(() => { throw new Error('Seatbelt force cleanup timed out') }),
        ])
        expect(reaped).toContain(escaped!.pid)
        expect(forced).toBe(1)
        expect(observeProcessGeneration(escaped!).status).toBe('dead')
        removeSeatbeltFingerprint(root, fingerprint)
      } finally {
        force = true
        signalProcessIfLive(escaped!, 'SIGKILL')
        await Promise.race([reaping.catch(() => []), Bun.sleep(2_500)])
      }
    },
    10_000,
  )

  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'executor登録前にcrashしたfingerprint子もstartup scanで回収する',
    async () => {
      const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-seatbelt-orphan-')))
      temporaryDirs.push(root)
      const fingerprint = createSeatbeltFingerprint(root, 'job-preflight', 'c'.repeat(32))
      const pidPath = join(root, 'preflight-escaped.pid')
      const script = [
        'import os,sys,time',
        'pid=os.fork()',
        'if pid:',
        ' open(sys.argv[1],"w").write(str(pid))',
        ' os._exit(0)',
        'os.setsid()',
        'os.close(0);os.close(1);os.close(2)',
        'time.sleep(60)',
      ].join('\n')
      const profile = [
        '(version 1)',
        '(allow default)',
        `(deny file-read-data (literal ${JSON.stringify(fingerprint.deny.path)}))`,
      ].join('\n')
      const launcher = Bun.spawn([
        '/usr/bin/sandbox-exec', '-p', profile,
        '/usr/bin/python3', '-c', script, pidPath,
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
      expect(await launcher.exited).toBe(0)
      await waitFor(pidPath)
      const escapedPid = Number(readFileSync(pidPath, 'utf8'))
      const escaped = readProcessIdentity(escapedPid)
      expect(escaped).toBeDefined()

      expect(await recoverOrphanSeatbeltFingerprints(root)).toContain(escapedPid)
      expect(observeProcessGeneration(escaped!).status).toBe('dead')
      expect(existsSync(fingerprint.allow.path)).toBe(false)
      expect(await recoverOrphanSeatbeltFingerprints(root)).toEqual([])
    },
    10_000,
  )

  // ---- Linux (WSL2) -------------------------------------------------------
  // macOS proves "this process carries the attempt policy" from the outside with
  // sandbox_check(). Linux has no equivalent, so the launcher (a) moves itself
  // into a per-attempt systemd scope cgroup before exec (membership is inherited
  // and visible from the outside through cgroup.procs, so reaping works) and
  // (b) installs a Landlock domain that no descendant can drop, proving the
  // obligation from the inside. Both are asserted here with real kernels, not
  // mocks. These run only on Linux; on macOS they are skipped like the
  // Seatbelt cases above are skipped on Linux.
  const linuxOnly = process.platform !== 'linux'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1'

  test('sandboxedCommandはdarwinでsandbox-execを、linuxで専用launcherを前置する', () => {
    const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-sandbox-cmd-')))
    temporaryDirs.push(root)
    const fingerprint = createSeatbeltFingerprint(root, 'job-cmd', 'f'.repeat(32))
    const command = sandboxedCommand(fingerprint, root, ['/bin/echo', 'hi'])
    expect(command.slice(-2)).toEqual(['/bin/echo', 'hi'])
    if (process.platform === 'darwin') {
      expect(command[0]).toBe('/usr/bin/sandbox-exec')
      expect(command[1]).toBe('-p')
      expect(command[2]).toContain(`(deny file-read-data (literal ${JSON.stringify(fingerprint.deny.path)}))`)
    } else if (process.platform === 'linux') {
      expect(command[0]).toBe('/usr/bin/python3')
      expect(command[1]).toBe('-I')
      expect(command[2]).toMatch(/\/linux-sandbox-launcher\.py$/)
      expect(command.slice(3, 7)).toEqual([
        fingerprint.allow.path, fingerprint.deny.path, linuxSandboxReceiptPath(root, fingerprint), '--',
      ])
    } else {
      expect(() => sandboxedCommand(fingerprint, root, ['/bin/echo'])).toThrow()
    }
  })

  // capability probe / advisor broker は tag の path 2 本しか持たない。state dir は tag の
  // 配置（<state>/sandbox-obligations/<job>/<nonce>/{allow,deny}）から一意に決まるので、
  // そこから同じ wrapper を組めることを固定する（darwin では従来の inline と同一）。
  test('sandboxedCommandForTagsはtag pathだけから同じwrapperを組む', () => {
    const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-sandbox-tags-cmd-')))
    temporaryDirs.push(root)
    const fingerprint = createSeatbeltFingerprint(root, 'job-tags', 'e'.repeat(32))
    const tags = { allow: fingerprint.allow.path, deny: fingerprint.deny.path }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(sandboxedCommandForTags(tags, ['/bin/echo', 'hi']))
        .toEqual(sandboxedCommand(fingerprint, root, ['/bin/echo', 'hi']))
    }
    expect(() => sandboxedCommandForTags({ allow: tags.allow, deny: '/elsewhere/deny' }, ['/bin/echo']))
      .toThrow()
    expect(() => sandboxedCommandForTags({ allow: tags.allow, deny: join(root, 'deny') }, ['/bin/echo']))
      .toThrow()
  })

  test.skipIf(linuxOnly)(
    'Linux launcherは専用scope cgroupとLandlock obligationを張り、receiptを書いてからexecする',
    async () => {
      const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-landlock-launch-')))
      temporaryDirs.push(root)
      const fingerprint = createSeatbeltFingerprint(root, 'job-landlock', '1'.repeat(32))
      const unit = linuxSandboxScopeUnit(fingerprint)
      expect(unit).toBe(`zerokun-fp-${'1'.repeat(32)}`)
      // Inside the launched tree: creating a block device is the one filesystem
      // action nothing legitimate needs without CAP_MKNOD. Landlock answers
      // before the capability check, so EACCES means "denied by the obligation"
      // and EPERM means "Landlock allowed it, only the capability is missing".
      const probe = [
        'import errno, json, os, stat, sys',
        'allow_dir, deny_dir = sys.argv[1], sys.argv[2]',
        'def probe(directory):',
        '    try:',
        '        os.mknod(os.path.join(directory, ".probe-%d" % os.getpid()), stat.S_IFBLK | 0o600, 0)',
        '        return "created"',
        '    except OSError as error:',
        '        return errno.errorcode[error.errno]',
        'cgroup = open("/proc/self/cgroup").read().strip().split(":", 2)[2]',
        'nnp = int(open("/proc/self/status").read().split("NoNewPrivs:")[1].split()[0])',
        'leaked = sorted(k for k in os.environ if k.startswith("ZEROKUN_LINUX_SANDBOX_") or k in ("INVOCATION_ID", "XDG_RUNTIME_DIR"))',
        'json.dump({"cgroup": cgroup, "allow": probe(allow_dir), "deny": probe(deny_dir),',
        '           "no_new_privs": nnp, "leaked": leaked, "path": os.environ.get("PATH")}, sys.stdout)',
      ].join('\n')
      const attemptDir = join(fingerprint.allow.path, '..')
      const jobDir = join(attemptDir, '..')
      const child = Bun.spawn(sandboxedCommand(fingerprint, root, [
        '/usr/bin/python3', '-c', probe, attemptDir, jobDir,
      ]), { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' } })
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(await child.exited, stderr).toBe(0)
      const observed = JSON.parse(stdout)
      // The launcher appends its own PID (the child PID, since it execs in place).
      expect(observed.cgroup.endsWith(`/${unit}-${child.pid}.scope`), observed.cgroup).toBe(true)
      expect(observed.allow).toBe('EPERM')
      expect(observed.deny).toBe('EACCES')
      expect(observed.no_new_privs).toBe(1)
      // The caller's environment reaches the command unchanged: nothing the two
      // launcher stages or systemd-run added survives the exec.
      expect(observed.leaked).toEqual([])
      expect(observed.path).toBe('/usr/bin:/bin')
      expect(existsSync(join(attemptDir, `.probe-${child.pid}`))).toBe(false)
      const receipt = JSON.parse(readFileSync(join(linuxSandboxReceiptPath(root, fingerprint), `${child.pid}.json`), 'utf8'))
      expect(receipt.version).toBe(1)
      expect(receipt.unit).toBe(`${unit}-${child.pid}`)
      expect(receipt.cgroup).toBe(observed.cgroup)
      expect(receipt.allowProbe).toBe('EPERM')
      expect(receipt.denyProbe).toBe('EACCES')
      expect(receipt.pid).toBe(child.pid)
      // Nothing was left in the attempt directory: the probe never created a node.
      expect(readdirSync(attemptDir).sort()).toEqual(['allow', 'deny'])
      removeSeatbeltFingerprint(root, fingerprint)
      expect(existsSync(linuxSandboxReceiptPath(root, fingerprint))).toBe(false)
    },
    15_000,
  )

  test.skipIf(linuxOnly)(
    'Linuxでsetsidして再親付けされたsandbox子をcgroup membershipで回収する',
    async () => {
      const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-landlock-reap-')))
      temporaryDirs.push(root)
      const fingerprint = createSeatbeltFingerprint(root, 'job-linux-reap', '2'.repeat(32))
      const pidPath = join(root, 'escaped.pid')
      const script = [
        'import os,sys,time',
        'pid=os.fork()',
        'if pid:',
        ' open(sys.argv[1],"w").write(str(pid))',
        ' os._exit(0)',
        'os.setsid()',
        'os.close(0);os.close(1);os.close(2)',
        'time.sleep(60)',
      ].join('\n')
      const earliest = readProcessIdentity(process.pid)
      expect(earliest).toBeDefined()
      const launcher = Bun.spawn(sandboxedCommand(fingerprint, root, [
        '/usr/bin/python3', '-c', script, pidPath,
      ]), { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' } })
      const stderr = new Response(launcher.stderr).text()
      expect(await launcher.exited, await stderr).toBe(0)
      await waitFor(pidPath)
      const escapedPid = Number(readFileSync(pidPath, 'utf8'))
      const escaped = readProcessIdentity(escapedPid)
      expect(escaped).toBeDefined()
      expect(escaped!.ppid).not.toBe(process.pid)
      expect(processCarriesSeatbeltFingerprint(fingerprint.allow.path, fingerprint.deny.path, escapedPid)).toBe(true)
      expect(processCarriesSeatbeltFingerprint(fingerprint.allow.path, fingerprint.deny.path, process.pid)).toBe(false)

      const reaped = await reapSeatbeltFingerprint({
        stateDir: root,
        fingerprint,
        earliest: earliest!,
      })
      expect(reaped).toContain(escapedPid)
      expect(observeProcessGeneration(escaped!).status).toBe('dead')
      removeSeatbeltFingerprint(root, fingerprint)
    },
    15_000,
  )

  test.skipIf(linuxOnly)(
    'Linuxでexecutor登録前にcrashしたsandbox子もstartup scanで回収する',
    async () => {
      const root = prepareManagedStateRoot(mkdtempSync(join(tmpdir(), 'zero-landlock-orphan-')))
      temporaryDirs.push(root)
      const fingerprint = createSeatbeltFingerprint(root, 'job-linux-orphan', '3'.repeat(32))
      const pidPath = join(root, 'preflight-escaped.pid')
      const script = [
        'import os,sys,time',
        'pid=os.fork()',
        'if pid:',
        ' open(sys.argv[1],"w").write(str(pid))',
        ' os._exit(0)',
        'os.setsid()',
        'os.close(0);os.close(1);os.close(2)',
        'time.sleep(60)',
      ].join('\n')
      const launcher = Bun.spawn(sandboxedCommand(fingerprint, root, [
        '/usr/bin/python3', '-c', script, pidPath,
      ]), { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' } })
      const stderr = new Response(launcher.stderr).text()
      expect(await launcher.exited, await stderr).toBe(0)
      await waitFor(pidPath)
      const escapedPid = Number(readFileSync(pidPath, 'utf8'))
      const escaped = readProcessIdentity(escapedPid)
      expect(escaped).toBeDefined()

      expect(await recoverOrphanSeatbeltFingerprints(root)).toContain(escapedPid)
      expect(observeProcessGeneration(escaped!).status).toBe('dead')
      expect(existsSync(fingerprint.allow.path)).toBe(false)
      expect(await recoverOrphanSeatbeltFingerprints(root)).toEqual([])
    },
    15_000,
  )
})
