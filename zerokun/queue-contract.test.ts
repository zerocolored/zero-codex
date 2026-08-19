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
})
