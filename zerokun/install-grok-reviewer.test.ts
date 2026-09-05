import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installGrokReviewer } from './install-grok-reviewer.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function mode(path: string): number {
  return lstatSync(path).mode & 0o777
}

function fixture(): { home: string; auth: string; physicalGrok: string; reviewRoot: string } {
  const home = mkdtempSync(join(tmpdir(), 'zerokun-grok-reviewer-'))
  temporaryRoots.push(home)
  chmodSync(home, 0o700)
  const bin = join(home, '.grok', 'bin')
  const downloads = join(home, '.grok', 'downloads')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  mkdirSync(downloads, { mode: 0o700 })
  chmodSync(join(home, '.grok'), 0o700)
  chmodSync(bin, 0o700)
  chmodSync(downloads, 0o700)
  const officialName = process.arch === 'arm64'
    ? 'grok-macos-aarch64'
    : 'grok-macos-x86_64'
  const physicalGrok = join(downloads, officialName)
  const reviewRoot = join(home, 'review-project')
  mkdirSync(reviewRoot, { mode: 0o700 })
  const source = join(home, 'fixture-grok.c')
  writeFileSync(source, String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  const char *home = getenv("HOME");
  const char *grok_home = getenv("GROK_HOME");
  const char *path = getenv("PATH");
  printf("HOME=%s\n", home ? home : "");
  printf("GROK_HOME=%s\n", grok_home ? grok_home : "");
  printf("PATH=%s\n", path ? path : "");
  printf("SELF=%s\n", argv[0]);
  printf("ARGS=");
  for (int index = 1; index < argc; index++) printf(" <%s>", argv[index]);
  printf("\n");
  for (int index = 2; index < argc; index++) {
    if (strcmp(argv[index - 1], "--prompt-file") != 0) continue;
    struct stat info;
    if (stat(argv[index], &info) != 0) return 91;
    FILE *prompt = fopen(argv[index], "rb");
    if (!prompt) return 92;
    char prefix[19] = {0};
    size_t prefix_length = fread(prefix, 1, 18, prompt);
    unsigned long long bytes = prefix_length;
    while (fgetc(prompt) != EOF) bytes++;
    fclose(prompt);
    printf("PROMPT_BYTES=%llu\n", bytes);
    printf("PROMPT_MODE=%o\n", info.st_mode & 0777);
    printf("PROMPT_LINKS=%u\n", (unsigned int)info.st_nlink);
    if (strncmp(prefix, "PROCESS-TABLE-HOLD", 18) == 0) sleep(2);
  }
  if (grok_home) {
    char sandbox[4096];
    if (snprintf(sandbox, sizeof(sandbox), "%s/sandbox.toml", grok_home) > 0) {
      FILE *input = fopen(sandbox, "rb");
      if (input) {
        int character;
        while ((character = fgetc(input)) != EOF) fputc(character, stdout);
        fclose(input);
      }
    }
  }
  return 0;
}
`, { mode: 0o600 })
  const compiled = Bun.spawnSync(['/usr/bin/cc', '-Os', '-o', physicalGrok, source], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString())
  rmSync(source, { force: true })
  chmodSync(physicalGrok, 0o700)
  symlinkSync(`../downloads/${officialName}`, join(bin, 'grok'))
  const auth = join(home, '.grok', 'auth.json')
  writeFileSync(auth, '{"fixture":true}\n', { mode: 0o600 })
  return { home, auth, physicalGrok, reviewRoot }
}

function reviewSync(
  launcher: string,
  prompt: string | Uint8Array,
  env: Record<string, string>,
) {
  const input = join(env.HOME!, `.review-stdin-${randomUUID()}`)
  writeFileSync(input, prompt, { mode: 0o600 })
  try {
    return Bun.spawnSync([launcher, '-p'], {
      env,
      stdin: Bun.file(input),
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } finally {
    rmSync(input, { force: true })
  }
}

function compileFixtureProgram(home: string, output: string, sourceText: string): void {
  const source = join(home, `.fixture-${randomUUID()}.c`)
  writeFileSync(source, sourceText, { mode: 0o600 })
  try {
    const compiled = Bun.spawnSync(['/usr/bin/cc', '-Os', '-o', output, source], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString())
    chmodSync(output, 0o700)
  } finally {
    rmSync(source, { force: true })
  }
}

describe('dedicated Grok reviewer installer', () => {
  test('Grok 1.0.5のexact未認証診断だけをcleanup後のmarker+78へ変換する', () => {
    const { home, reviewRoot, physicalGrok } = fixture()
    const launcher = installGrokReviewer(home)
    compileFixtureProgram(home, physicalGrok, String.raw`
#include <stdio.h>
int main(void) {
  fputs("Not signed in. To authenticate without a browser, run: grok login --device-code Alternatively, set the XAI_API_KEY environment variable or run \x60grok login\x60 on a machine with a browser.\n", stderr);
  return 1;
}
`)
    const result = reviewSync(launcher, 'auth boundary review', {
      HOME: home,
      PATH: '/usr/bin:/bin',
      ZEROKUN_GROK_REVIEW_ROOT: reviewRoot,
    })
    expect(result.exitCode).toBe(78)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toBe('GROK_REVIEWER_AUTH_REQUIRED\n')
    expect(readdirSync(join(home, '.grok-reviewer')).filter(name => name.startsWith('run.')))
      .toEqual([])
  })

  test('childが予約markerまたはexit 78を偽装してもOAuth recovery triggerへしない', () => {
    const { home, reviewRoot, physicalGrok } = fixture()
    const launcher = installGrokReviewer(home)
    compileFixtureProgram(home, physicalGrok, String.raw`
#include <stdio.h>
int main(void) {
  fputs("GROK_REVIEWER_AUTH_REQUIRED\n", stderr);
  return 78;
}
`)
    const result = reviewSync(launcher, 'collision review', {
      HOME: home,
      PATH: '/usr/bin:/bin',
      ZEROKUN_GROK_REVIEW_ROOT: reviewRoot,
    })
    expect(result.exitCode).toBe(70)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toBe('Grok reviewer child used a reserved protocol value.\n')
  })

  test('official downloads symlinkを受け入れowner-onlyに配置してrunを片付ける', () => {
    const { home } = fixture()
    mkdirSync(join(home, '.grok-reviewer'), { mode: 0o755 })

    const launcher = installGrokReviewer(home)

    expect(launcher).toBe(join(realpathSync(home), '.grok-reviewer', 'bin', 'grok'))
    expect(mode(join(home, '.grok-reviewer'))).toBe(0o700)
    expect(mode(join(home, '.grok-reviewer', 'bin'))).toBe(0o700)
    expect(mode(launcher)).toBe(0o700)
    expect(mode(join(home, '.grok-reviewer', 'bin', 'reviewer-runtime.py'))).toBe(0o700)
    expect(mode(join(home, '.grok-reviewer', 'bin', 'oauth-login-runtime.py'))).toBe(0o700)
    expect(mode(join(home, '.grok-reviewer', 'bin', 'grok-login-oauth'))).toBe(0o700)
    expect(mode(join(home, '.grok-reviewer', 'grok-identity.json'))).toBe(0o600)
    expect(mode(join(home, '.grok-reviewer', 'config.toml'))).toBe(0o600)
    expect(mode(join(home, '.grok-reviewer', 'sandbox.toml'))).toBe(0o600)
    expect(mode(join(home, '.grok-reviewer', 'requirements.toml'))).toBe(0o600)
    expect(readFileSync(join(home, '.grok-reviewer', 'config.toml'), 'utf8'))
      .toContain('default = "grok-4.6"')
    expect(readFileSync(join(home, '.grok-reviewer', 'requirements.toml'), 'utf8'))
      .toContain('disable_api_key_auth = true')
    const oauthLauncher = readFileSync(
      join(home, '.grok-reviewer', 'bin', 'grok-login-oauth'), 'utf8',
    )
    expect(oauthLauncher).not.toContain('__GROK_REAL_BIN_SH__')
    expect(oauthLauncher).not.toContain('__USER_HOME_SH__')
    const identity = JSON.parse(readFileSync(
      join(home, '.grok-reviewer', 'grok-identity.json'), 'utf8',
    )) as Record<string, unknown>
    expect(identity).toMatchObject({ version: 1, path: realpathSync(join(home, '.grok', 'bin', 'grok')) })
    expect(identity.sha256).toBe(createHash('sha256')
      .update(readFileSync(realpathSync(join(home, '.grok', 'bin', 'grok')))).digest('hex'))

    const result = Bun.spawnSync([launcher, '--version'], {
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toContain('ARGS= <--no-auto-update> <--version>')
    expect(result.stdout.toString()).toMatch(/SELF=.*\.grok-reviewer\/run\.[^/]+\/official-grok/)
    expect(readdirSync(join(home, '.grok-reviewer')).filter(name => name.startsWith('run.')))
      .toEqual([])
  })

  test('auth.json未作成でも固定OAuth helperを導入できる', () => {
    const { home, auth } = fixture()
    rmSync(auth)
    expect(() => installGrokReviewer(home)).not.toThrow()
    expect(existsSync(join(home, '.grok-reviewer', 'bin', 'grok-login-oauth'))).toBe(true)
    expect(existsSync(join(home, '.grok-reviewer', 'grok-identity.json'))).toBe(true)
  })

  test('単発reviewへ再委任・web・write禁止と隔離環境を強制する', () => {
    const { home, reviewRoot } = fixture()
    const launcher = installGrokReviewer(home)

    const result = reviewSync(launcher, 'independent review', {
      HOME: home,
      PATH: '/usr/bin:/bin',
      CLAUDE_CONFIG_DIR: '/must-not-inherit',
      ZEROKUN_GROK_REVIEW_ROOT: reviewRoot,
    })
    const output = result.stdout.toString()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(output).toContain('<--no-subagents>')
    expect(output).toContain('<--disable-web-search>')
    expect(output).toContain('<--permission-mode> <dontAsk>')
    expect(output).toContain('<--sandbox> <reviewer>')
    expect(output).toContain('<--tools> <read_file,grep,list_dir>')
    expect(output).not.toContain('independent review')
    expect(output).toContain('<--prompt-file>')
    expect(output).toMatch(/GROK_HOME=.*\.grok-reviewer\/run\.[^/]+\/user-home\/\.grok/)
    expect(output).toMatch(/HOME=.*\.grok-reviewer\/run\.[^/]+\/user-home/)
    expect(output).toMatch(
      /^PATH=.*\.grok-reviewer\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m,
    )
    expect(output).toContain('extends = "strict"')
    expect(output).toContain(
      `restrict_network = ${process.platform === 'darwin' ? 'false' : 'true'}`,
    )
    expect(output).toMatch(new RegExp(
      `read_only = \\[${JSON.stringify(realpathSync(reviewRoot)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
        + `, ".*\\.grok-reviewer/run\\.[^/]+/workspace"\\]`,
    ))
    expect(output).toContain(`${realpathSync(reviewRoot)}/**/.env.*`)
    expect(output).not.toContain('__ZEROKUN_')
    expect(output).toContain('<--deny> <Read(~/**)>')
    expect(output).not.toContain('/must-not-inherit')
    expect(readdirSync(join(home, '.grok-reviewer')).filter(name => name.startsWith('run.')))
      .toEqual([])
  })

  test('multi-repo workspaceはinner sandboxのread rootをmemberだけに絞る', () => {
    const { home, reviewRoot } = fixture()
    const launcher = installGrokReviewer(home)
    const members = ['backend', 'frontend'].map(name => {
      const member = join(reviewRoot, name)
      mkdirSync(join(member, '.git'), { recursive: true })
      return realpathSync(member)
    }).sort()
    const contract = join(home, 'workspace-review-scope.json')
    const fingerprintRoot = join(home, 'workspace-fingerprint')
    mkdirSync(fingerprintRoot, { mode: 0o700 })
    const allow = join(fingerprintRoot, 'allow')
    const deny = join(fingerprintRoot, 'deny')
    writeFileSync(allow, 'allow\n', { mode: 0o600 })
    writeFileSync(deny, 'deny\n', { mode: 0o600 })
    writeFileSync(contract, `${JSON.stringify({
      version: 2,
      reviewRoot: realpathSync(reviewRoot),
      members,
    })}\n`, { mode: 0o600 })

    const result = reviewSync(launcher, 'independent workspace review', {
      HOME: home,
      PATH: '/usr/bin:/bin',
      ZEROKUN_GROK_REVIEW_ROOT: reviewRoot,
      ZEROKUN_GROK_REVIEW_SCOPE_FILE: contract,
      ...(process.platform === 'darwin' ? {
        ZEROKUN_SEATBELT_FINGERPRINT_ALLOW: realpathSync(allow),
        ZEROKUN_SEATBELT_FINGERPRINT_DENY: realpathSync(deny),
      } : {}),
    })
    const output = result.stdout.toString()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(output).toContain(
      `read_only = [${members.map(value => JSON.stringify(value)).join(', ')}, `,
    )
    expect(output).not.toContain(`read_only = [${JSON.stringify(realpathSync(reviewRoot))}, `)
    if (process.platform === 'darwin') {
      expect(output).toContain(`  ${JSON.stringify(realpathSync(deny))},`)
    }
    expect(readdirSync(join(home, '.grok-reviewer')).filter(name => name.startsWith('run.')))
      .toEqual([])
  })

  test('通常fileへ差し替えたGrok wrapperを公式launcherとして採択しない', () => {
    const { home } = fixture()
    const logical = join(home, '.grok', 'bin', 'grok')
    rmSync(logical)
    writeFileSync(logical, '#!/bin/sh\nexec /tmp/unofficial-grok "$@"\n', { mode: 0o700 })
    const launcher = installGrokReviewer(home)

    const result = Bun.spawnSync([launcher, '--version'], {
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('Grok Build')
  })

  test('official形のsymlink先でも非Mach-O wrapperへ差し替えたら起動しない', () => {
    const { home, physicalGrok } = fixture()
    const launcher = installGrokReviewer(home)
    writeFileSync(physicalGrok, '#!/bin/sh\nexit 0\n', { mode: 0o700 })

    const result = Bun.spawnSync([launcher, '--version'], {
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout.toString()).not.toContain('ARGS=')
  })

  test('stdin promptはSlack本文をprocess argvへ載せずowner-only fileから公式--prompt-fileへ渡す', () => {
    const { home, reviewRoot } = fixture()
    const launcher = installGrokReviewer(home)
    const confidentialBody = 'confidential Slack fixture body'
    const result = reviewSync(launcher, confidentialBody, {
      HOME: home,
      PATH: '/usr/bin:/bin',
      ZEROKUN_GROK_REVIEW_ROOT: reviewRoot,
    })
    const output = result.stdout.toString()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(output).toContain('<--prompt-file>')
    expect(output).toMatch(/<[^>]+\.grok-reviewer\/run\.[^/]+\/workspace\/review-prompt>/)
    expect(output).toMatch(new RegExp(`PROMPT_BYTES=\\s*${Buffer.byteLength(confidentialBody)}(?:\\s|$)`))
    expect(output).toContain('PROMPT_MODE=600')
    expect(output).toContain('PROMPT_LINKS=1')
    expect(output).not.toContain(confidentialBody)
    expect(readdirSync(join(home, '.grok-reviewer')).filter(name => name.startsWith('run.')))
      .toEqual([])
  })

  test('並列review起動を直列化しowner receipt前crashのrunも自動回収する', async () => {
    const { home, reviewRoot } = fixture()
    const launcher = installGrokReviewer(home)
    const reviewerRoot = join(home, '.grok-reviewer')
    const ownerless = join(reviewerRoot, 'run.ownerless-fixture')
    mkdirSync(ownerless, { mode: 0o700 })

    const children = [0, 1].map(index => {
      const child = Bun.spawn([launcher, '-p'], {
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin',
        ZEROKUN_GROK_REVIEW_ROOT: reviewRoot,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      })
      child.stdin.write(`parallel independent review ${index}`)
      child.stdin.end()
      return child
    })
    const results = await Promise.all(children.map(async child => ({
      exitCode: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })))
    expect(results).toEqual([
      { exitCode: 0, stderr: '' },
      { exitCode: 0, stderr: '' },
    ])
    expect(readdirSync(reviewerRoot).filter(name => name.startsWith('run.'))).toEqual([])
  })

  test('job fingerprintをGrok自身のinner reviewer profileへ組み込む', () => {
    if (process.platform !== 'darwin') return
    const { home, reviewRoot } = fixture()
    const launcher = installGrokReviewer(home)
    const fingerprintRoot = join(home, 'fingerprint')
    mkdirSync(fingerprintRoot, { mode: 0o700 })
    const allow = join(fingerprintRoot, 'allow')
    const deny = join(fingerprintRoot, 'deny')
    writeFileSync(allow, 'allow\n', { mode: 0o600 })
    writeFileSync(deny, 'deny\n', { mode: 0o600 })
    const physicalAllow = realpathSync(allow)
    const physicalDeny = realpathSync(deny)
    const result = reviewSync(launcher, 'independent review', {
      HOME: home,
      PATH: '/usr/bin:/bin',
      ZEROKUN_GROK_REVIEW_ROOT: reviewRoot,
      ZEROKUN_SEATBELT_FINGERPRINT_ALLOW: physicalAllow,
      ZEROKUN_SEATBELT_FINGERPRINT_DENY: physicalDeny,
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toContain(
      `read_only = [${JSON.stringify(realpathSync(reviewRoot))}, ${JSON.stringify(realpathSync(fingerprintRoot))}, `,
    )
    expect(result.stdout.toString()).toContain(`  ${JSON.stringify(physicalDeny)},`)

    const invalid = reviewSync(launcher, 'independent review', {
      HOME: home,
      PATH: '/usr/bin:/bin',
      ZEROKUN_GROK_REVIEW_ROOT: reviewRoot,
      ZEROKUN_SEATBELT_FINGERPRINT_ALLOW: physicalDeny,
      ZEROKUN_SEATBELT_FINGERPRINT_DENY: physicalDeny,
    })
    expect(invalid.exitCode).toBe(126)
  })

  test('旧inline promptと空・NUL・過大stdinを本文を表示せず拒否する', () => {
    const { home, reviewRoot } = fixture()
    const launcher = installGrokReviewer(home)
    const environment = {
      HOME: home,
      PATH: '/usr/bin:/bin',
      ZEROKUN_GROK_REVIEW_ROOT: reviewRoot,
    }
    const inlineBody = 'must-never-enter-process-argv'
    const inline = Bun.spawnSync([launcher, '-p', inlineBody], {
      env: environment, stdout: 'pipe', stderr: 'pipe',
    })
    expect(inline.exitCode).toBe(64)
    expect(inline.stderr.toString()).not.toContain(inlineBody)

    for (const invalid of [
      '',
      new Uint8Array([0]),
      new Uint8Array([0xc3, 0x28]),
      new Uint8Array(2 * 1024 * 1024 + 1),
    ]) {
      const result = reviewSync(launcher, invalid, environment)
      expect(result.exitCode).toBe(64)
      expect(result.stdout.toString() + result.stderr.toString()).not.toContain(inlineBody)
    }
    expect(readdirSync(join(home, '.grok-reviewer')).filter(name => name.startsWith('run.')))
      .toEqual([])
  }, 15_000)

  test('実行中launcher・supervisor・公式childのprocess argvへstdin本文を残さない', async () => {
    const { home, reviewRoot } = fixture()
    const launcher = installGrokReviewer(home)
    const confidential = 'PROCESS-TABLE-HOLD-SLACK-ARGV-SENTINEL'
    const child = Bun.spawn([launcher, '-p'], {
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin',
        ZEROKUN_GROK_REVIEW_ROOT: reviewRoot,
      },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    child.stdin.write(confidential)
    child.stdin.end()

    const reviewerRoot = join(home, '.grok-reviewer')
    let childReceipt = ''
    const receiptDeadline = Date.now() + 5_000
    while (!childReceipt && Date.now() < receiptDeadline) {
      for (const entry of readdirSync(reviewerRoot).filter(name => name.startsWith('run.'))) {
        const candidate = join(reviewerRoot, entry, 'child.pgid')
        if (existsSync(candidate)) childReceipt = candidate
      }
      if (!childReceipt) await Bun.sleep(20)
    }
    expect(childReceipt).not.toBe('')
    const table = Bun.spawnSync(['/bin/ps', '-axo', 'pid=,ppid=,command='], {
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(table.exitCode, table.stderr.toString()).toBe(0)
    const rows = table.stdout.toString().split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : []
    })
    const descendants = new Set([child.pid])
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) {
        if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
          descendants.add(row.pid)
          changed = true
        }
      }
    }
    const commands = rows.filter(row => descendants.has(row.pid)).map(row => row.command)
    expect(commands.length).toBeGreaterThanOrEqual(2)
    expect(commands.join('\n')).not.toContain(confidential)

    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ])
    expect(exitCode, stderr).toBe(0)
    expect(readdirSync(reviewerRoot).filter(name => name.startsWith('run.'))).toEqual([])
  }, 10_000)

  test('login authが利用不能でもbest-effort reviewer bundleを導入する', () => {
    const first = fixture()
    chmodSync(first.auth, 0o640)
    expect(() => installGrokReviewer(first.home)).not.toThrow()

    const second = fixture()
    linkSync(second.auth, join(second.home, 'auth-hardlink'))
    expect(() => installGrokReviewer(second.home)).not.toThrow()
  })
})
