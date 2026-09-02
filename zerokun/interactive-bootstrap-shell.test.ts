import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('visible bootstrap shell handoff', () => {
  test('Bunなしのfresh環境でも引数と終了状態を可視terminal相当へ往復する', () => {
    const root = mkdtempSync(join(tmpdir(), 'zerochan-visible-shell-'))
    directories.push(root)
    const sourceRoot = join(root, 'zerokun')
    const output = join(root, 'arguments')
    const fakeOsa = join(root, 'osascript')
    mkdirSync(sourceRoot)
    writeFileSync(join(sourceRoot, 'bootstrap-macos.sh'), [
      '#!/bin/bash',
      '/usr/bin/printf "%s\\n" "$@" > "$VISIBLE_TEST_OUTPUT"',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o700 })
    writeFileSync(fakeOsa, [
      '#!/bin/bash',
      'script="$1"',
      'runner="$2"',
      '[ -s "$script" ] || exit 2',
      '/bin/bash "$runner" >/dev/null 2>&1 &',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o700 })
    const production = readFileSync(join(import.meta.dir, 'interactive-bootstrap.sh'), 'utf8')
    const call = '/usr/bin/osascript "$APPLE_SCRIPT" "$RUNNER" >/dev/null'
    expect(production.split(call)).toHaveLength(2)
    const testable = production.replace(call, `"${fakeOsa}" "$APPLE_SCRIPT" "$RUNNER" >/dev/null`)
    const launcher = join(sourceRoot, 'interactive-bootstrap.sh')
    writeFileSync(launcher, testable, { mode: 0o700 })
    chmodSync(launcher, 0o700)

    const result = Bun.spawnSync([
      '/bin/bash', launcher,
      '--repo-dir', `${root}/repo with spaces`, '--with-slack',
    ], {
      env: { ...process.env, VISIBLE_TEST_OUTPUT: output },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      timeout: 10_000,
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe(
      `--repo-dir\n${root}/repo with spaces\n--with-slack\n`,
    )
  })

  test('shell構文とtoken非引数契約を固定する', () => {
    const source = readFileSync(join(import.meta.dir, 'interactive-bootstrap.sh'), 'utf8')
    const syntax = Bun.spawnSync(['/bin/bash', '-n', join(import.meta.dir, 'interactive-bootstrap.sh')])
    expect(syntax.exitCode).toBe(0)
    expect(source).toContain("/usr/bin/printf '%s\\0'")
    expect(source).toContain('/usr/bin/osascript "$APPLE_SCRIPT" "$RUNNER"')
    expect(source).not.toContain('SLACK_BOT_TOKEN=')
    expect(source).not.toContain('SLACK_APP_TOKEN=')
  })
})
