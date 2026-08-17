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

  test('setup installs the runner and status CLI', () => {
    const setup = readFileSync(join(import.meta.dir, 'setup.sh'), 'utf8')
    expect(setup).toContain('job-runner.ts')
    expect(setup).toContain('zerokun-jobs')
    expect(setup).toContain('zerokun-queue-policy.md')
  })
})
