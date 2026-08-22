import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const LAUNCHER = join(dirname(import.meta.dir), 'codex-channel.sh')
const temporaryDirs: string[] = []
const processes: Bun.Subprocess[] = []

afterEach(() => {
  for (const process of processes.splice(0)) {
    try { process.kill() } catch {}
  }
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zerokun-codex-launcher-'))
  temporaryDirs.push(dir)
  return dir
}

function startGateway(state: string): Bun.Subprocess {
  const server = join(state, 'server.ts')
  writeFileSync(server, '#!/bin/bash\nsleep 30\n')
  chmodSync(server, 0o700)
  const process = Bun.spawn(['/bin/bash', server], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  })
  processes.push(process)
  writeFileSync(join(state, 'plugin.lock'), `${process.pid}\n`)
  const started = Bun.spawnSync(['/bin/ps', '-o', 'lstart=', '-p', String(process.pid)], {
    stdout: 'pipe',
  }).stdout.toString().trim()
  writeFileSync(join(state, 'plugin.lock.identity'), JSON.stringify({
    pid: process.pid, started, nonce: 'launcher-test',
  }))
  return process
}

async function runLauncher(state: string, env: Record<string, string>) {
  const fakeBin = join(state, 'bin')
  mkdirSync(fakeBin, { recursive: true })
  for (const command of ['bun', 'caffeinate']) {
    const path = join(fakeBin, command)
    writeFileSync(path, [
      '#!/bin/bash',
      '[ -z "${FAKE_BUN_LOG:-}" ] || printf "%s\\n" "$*" >> "$FAKE_BUN_LOG"',
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(path, 0o700)
  }
  const codex = join(fakeBin, 'codex')
  writeFileSync(codex, `#!/bin/bash
if [ "\${FAKE_BARE_VERSION:-0}" = "1" ]; then
  echo "\${FAKE_CODEX_VERSION:-0.149.0}"
else
  echo "codex-cli \${FAKE_CODEX_VERSION:-0.149.0}"
fi
`)
  chmodSync(codex, 0o700)
  const process = Bun.spawn(['/bin/bash', LAUNCHER, state], {
    env: {
      ...processEnvWithout('ZEROKUN_REPLACE_TOKEN'),
      HOME: state,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      ZEROKUN_CODEX_BIN: codex,
      ZEROKUN_STATE_DIR: state,
      ...env,
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, output: `${stdout}\n${stderr}` }
}

function processEnvWithout(key: string): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (name !== key && value !== undefined) environment[name] = value
  }
  return environment
}

describe('codex-channel.sh replacement guard', () => {
  test('Codex 0.149.0未満をjob受付前に拒否する', async () => {
    const state = fixture()
    const result = await runLauncher(state, {
      FAKE_CODEX_VERSION: '0.148.9',
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('0.149.0 以上')
  })

  test('prefixなしのCodex semverも正しく検出する', async () => {
    const state = fixture()
    const result = await runLauncher(state, {
      FAKE_BARE_VERSION: '1',
      FAKE_CODEX_VERSION: '0.149.0',
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.output).not.toContain('0.149.0 以上が必要')
  })

  test('ZEROKUN_REPLACE=1だけでは稼働中gatewayを停止しない', async () => {
    const state = fixture()
    const gateway = startGateway(state)
    await Bun.sleep(100)
    const result = await runLauncher(state, {
      ZEROKUN_REPLACE: '1',
      ZEROKUN_REPLACE_TOKEN_FILE: join(state, 'replace-token'),
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('有効なワンタイムトークンがありません')
    expect(gateway.killed).toBe(false)
  })

  test('不一致tokenでは停止しない', async () => {
    const state = fixture()
    const gateway = startGateway(state)
    writeFileSync(join(state, 'replace-token'), 'correct')
    await Bun.sleep(100)
    const result = await runLauncher(state, {
      ZEROKUN_REPLACE: '1',
      ZEROKUN_REPLACE_TOKEN: 'wrong',
      ZEROKUN_REPLACE_TOKEN_FILE: join(state, 'replace-token'),
    })
    expect(result.exitCode).toBe(1)
    expect(gateway.killed).toBe(false)
  })

  test('一致するone-time tokenだけがdry-run入れ替えを許可し、tokenを消す', async () => {
    const state = fixture()
    const gateway = startGateway(state)
    const tokenFile = join(state, 'replace-token')
    writeFileSync(tokenFile, 'one-time')
    await Bun.sleep(100)
    const result = await runLauncher(state, {
      ZEROKUN_REPLACE: '1',
      ZEROKUN_REPLACE_TOKEN: 'one-time',
      ZEROKUN_REPLACE_TOKEN_FILE: tokenFile,
      ZEROKUN_DRY_RUN: '1',
    })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('ワンタイムトークンを確認しました')
    expect(existsSync(tokenFile)).toBe(false)
    expect(gateway.killed).toBe(false)
  })

  test('親updaterのone-time tokenだけがjournal保持中のrestartを許可する', async () => {
    const state = fixture()
    const tokenFile = join(state, 'replace-token')
    const bunLog = join(state, 'bun.log')
    writeFileSync(join(state, 'update-transaction.json'), '{}')
    writeFileSync(tokenFile, 'restart-once')
    const result = await runLauncher(state, {
      ZEROKUN_UPDATE_RESTART: '1',
      ZEROKUN_REPLACE_TOKEN: 'restart-once',
      ZEROKUN_REPLACE_TOKEN_FILE: tokenFile,
      ZEROKUN_DRY_RUN: '1',
      FAKE_BUN_LOG: bunLog,
    })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('自己更新restartのワンタイムトークンを確認しました')
    expect(existsSync(tokenFile)).toBe(false)
    expect(readFileSync(bunLog, 'utf8')).not.toContain('recover-only')
  })

  test('tokenなしではjournalを無視できずrecover-onlyを呼ぶ', async () => {
    const state = fixture()
    const bunLog = join(state, 'bun.log')
    writeFileSync(join(state, 'update-transaction.json'), '{}')
    const result = await runLauncher(state, {
      ZEROKUN_UPDATE_RESTART: '1',
      ZEROKUN_DRY_RUN: '1',
      FAKE_BUN_LOG: bunLog,
    })
    expect(result.output).toContain('未完了の自己更新を検出しました')
    expect(readFileSync(bunLog, 'utf8')).toContain('recover-only')
  })

  test('candidateのCodex version検査が失敗してもjournal recoveryを先に呼ぶ', async () => {
    const state = fixture()
    const bunLog = join(state, 'bun.log')
    writeFileSync(join(state, 'update-transaction.json'), '{}')
    const result = await runLauncher(state, {
      FAKE_CODEX_VERSION: '0.1.0',
      ZEROKUN_DRY_RUN: '1',
      FAKE_BUN_LOG: bunLog,
    })
    expect(result.exitCode).toBe(1)
    expect(readFileSync(bunLog, 'utf8')).toContain('update.ts --recover-only')
    expect(result.output.indexOf('未完了の自己更新'))
      .toBeLessThan(result.output.indexOf('0.149.0 以上'))
  })
})
