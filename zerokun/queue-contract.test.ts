import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(import.meta.dir, '..')

describe('Zero-kun queue wiring', () => {
  test('Slack MCP exposes enqueue_job backed by the installed runner', () => {
    const server = readFileSync(join(root, 'server.ts'), 'utf8')
    expect(server).toContain("name: 'enqueue_job'")
    expect(server).toContain("join(STATE_DIR, 'job-runner.ts')")
    expect(server).toContain("JOB_RUNNER_FILE, 'enqueue'")
  })

  test('thread handler routes implementation work through enqueue_job exactly once', () => {
    const skill = readFileSync(join(root, 'skills/threads/SKILL.md'), 'utf8')
    expect(skill).toContain('Call `enqueue_job` exactly once')
    expect(skill).toContain('Do not also investigate, edit files')
    expect(skill).toContain('mcp__slack-channel__enqueue_job')
  })

  test('Slack launcher starts the persistent runner before Claude', () => {
    const launcher = readFileSync(join(root, 'claude-channel.sh'), 'utf8')
    expect(launcher).toContain('start_job_runner')
    expect(launcher).toContain('zerokun-queue-policy.md')
    expect(launcher).toContain('HEAVY_INPUTS+=("$QUEUE_POLICY")')
    expect(launcher.indexOf('start_job_runner')).toBeLessThan(
      launcher.lastIndexOf('exec caffeinate -dimsu'),
    )
  })

  test('launcher denies the owner-token Slack MCP on every claude it execs', () => {
    const launcher = readFileSync(join(root, 'claude-channel.sh'), 'utf8')
    expect(launcher).toContain("DENY_ARGS=(--disallowed-tools 'mcp__claude_ai_Slack*'")
    // bridge モードと plugin モードの両方の起動行に渡っていること。
    // 片方だけだと、その経路のサブエージェントが本人名義で投稿できてしまう。
    const execLines = launcher.split('\n').filter((line) => line.includes('"${DENY_ARGS[@]}"'))
    expect(execLines.length).toBe(2)
    // DENY_ARGS は if/else の外で無条件に定義されていること(set -u で未定義参照は即死)。
    expect(launcher.indexOf('DENY_ARGS=(')).toBeLessThan(launcher.indexOf('if [ "$CHANNEL" ='))
  })

  test('launcher starts Claude with max effort on every execution path', () => {
    const launcher = readFileSync(join(root, 'claude-channel.sh'), 'utf8')
    // bridgeモードとpluginモードの両方。片方だけだと起動方法によってeffortが変わる。
    const effortArgs = launcher.split('\n').filter((line) => line.includes('--effort max'))
    expect(effortArgs.length).toBe(2)
  })

  test('thread handler forbids putting Slack-post instructions into the job task', () => {
    const skill = readFileSync(join(root, 'skills/threads/SKILL.md'), 'utf8')
    expect(skill).toContain('Never tell the worker to post to Slack in `task`')
  })

  test('setup installs the runner and status CLI', () => {
    const setup = readFileSync(join(import.meta.dir, 'setup.sh'), 'utf8')
    expect(setup).toContain('job-runner.ts')
    expect(setup).toContain('zerokun-jobs')
    expect(setup).toContain('zerokun-queue-policy.md')
    expect(setup).toContain('zerokun-update')
    expect(setup).toContain('watchdog.sh')
    expect(setup).toContain('com.zerokun.watchdog.plist')
    expect(setup).toContain('ZEROKUN_LAUNCHCTL_BIN')
    expect(setup).toContain('bootstrap "gui/$(id -u)"')
  })

  test('updater is wired to all three repositories and restarts both processes', () => {
    const updater = readFileSync(join(import.meta.dir, 'update.ts'), 'utf8')
    expect(updater).toContain("'claude-config'")
    expect(updater).toContain("'claude-skills'")
    expect(updater).toContain("'origin/main'")
    expect(updater).toContain('job-runner.lock')
    expect(updater).toContain('dangerously-load-development-channels server:slack-channel')
    expect(updater).toContain('bootstrap-macos.sh')
  })

  test('Slack update skill uses the dedicated request tool without entering the job queue', () => {
    const server = readFileSync(join(root, 'server.ts'), 'utf8')
    const skill = readFileSync(join(root, 'skills/zerokun-update/SKILL.md'), 'utf8')
    const setup = readFileSync(join(import.meta.dir, 'setup.sh'), 'utf8')
    const queuePolicy = readFileSync(join(import.meta.dir, 'templates/zerokun-queue-policy.md'), 'utf8')
    expect(server).toContain("name: 'request_update'")
    expect(skill).toContain('name: zerokun-update')
    expect(skill).toContain('mcp__slack-channel__request_update')
    expect(skill).toContain('`enqueue_job`を呼ばない')
    expect(setup).toContain('update-request.ts')
    expect(setup).toContain('skills/zerokun-update')
    expect(setup).toContain('rm -f "$HOME/.claude/skills/update-zerokun"')
    expect(queuePolicy).toContain('`request_update`')
    expect(queuePolicy).toContain('`enqueue_job`を呼ばない')
  })

  test('design and implementation reach the worker, and the worker is told to run /dev', () => {
    const queuePolicy = readFileSync(join(import.meta.dir, 'templates/zerokun-queue-policy.md'), 'utf8')
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')

    // policy は「/dev を実行するのは worker 側」と宣言していたが、その worker に
    // /dev を起動させる指示が job-runner 側に無く、宣言が配線されていなかった。
    // 実測 2026-08-20: job-logs 18 件すべてで Skill 呼び出し 0 件。
    expect(queuePolicy).toContain('`/dev`のフルサイクルが必須')
    expect(runner).toContain('WORKER_DEV_SKILL_PROMPT')
    expect(runner).toContain("'--append-system-prompt', systemPrompt,")

    // 設計だけの依頼が worker に届かないと、/dev の最初のフェーズ(設計)が
    // スレッド担当の即答に置き換わる。
    expect(queuePolicy).toContain('設計・仕様決定')
  })

  test('Slack へ出る文面は、目的が1行目で分かり、依頼は箇条書きになる', () => {
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    const skill = readFileSync(join(root, 'skills/threads/SKILL.md'), 'utf8')

    // worker 報告もスレッド担当の返信も、読み手にとっては同じ「ゼロくんの発言」。
    // 片方だけ直しても体験は揃わないので両方で固定する。
    for (const text of [runner, skill]) {
      // 1行目で「これは自分の操作が要る話か」が分かること。
      // 依頼は箇条書き。無いなら「なし」と書かせる（無言だと依頼と読まれる）。
      expect(text).toContain('やってほしいこと')
      expect(text).toContain('なし')
      // 提案には案ごとの根拠を必須にする。根拠の無い案の羅列は「それっぽい話」に
      // なるだけで選べない。測っていない案は正直に未計測と書かせ、数字を捏造させない。
      expect(text).toContain('提案')
      expect(text).toContain('根拠')
      expect(text).toContain('未計測（推測）')
      // Slack は * 1個が太字。** は書式にならずアスタリスクがそのまま出る。
      expect(text).toContain('SINGLE asterisk')
      // 1行目は絵文字で挟んだ見出しだけの行。本文は2行目から。
      expect(text).toContain('✅完了✅')
      expect(text).toContain('✋要確認✋')
      expect(text).toContain('🛑未完了🛑')
      expect(text).toContain('💬回答💬')
      expect(text).toContain('💡提案💡')
      // 読み手が何もしない文を消す最終パス。実例で落ちたのが下の2つ。
      expect(text).toMatch(/I lost the thread history|I did not touch the code/)
      expect(text).toMatch(/inventory of what shipped/)
      // 行動リストはコードブロック、説明リストは行頭ラベル。コードブロック内では
      // Slack が inline 書式を描画しないので、バッククォートを持ち込ませない。
      expect(text).toContain('code block')
      expect(text).toContain('承認の場所')
      // 読み手が動かせない内部値を並べない。詳細は PR 本文へ。
      expect(text).toMatch(/session IDs, file paths, function names, commit hashes/)
    }
  })
})
