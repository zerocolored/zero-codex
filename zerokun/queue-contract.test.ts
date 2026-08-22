import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(import.meta.dir, '..')

describe('Zero-kun Codex wiring', () => {
  test('standalone gateway persists authorized Slack events directly to SQLite', () => {
    const server = readFileSync(join(root, 'server.ts'), 'utf8')
    expect(server).toContain("import { JobStore, updateIsRunning, updateTransactionPending } from './zerokun/job-runner.ts'")
    expect(server).toContain('const result = jobStore.enqueue({')
    expect(server).toContain('rememberDelivered(key)')
    expect(server.indexOf('jobStore.enqueue({')).toBeLessThan(
      server.indexOf('rememberDelivered(key)', server.indexOf('jobStore.enqueue({')),
    )
    expect(server).not.toContain("method: 'notifications/claude/channel',\n    params: { content")
  })

  test('gateway downloads attachments before enqueue and records thread ownership in DB', () => {
    const server = readFileSync(join(root, 'server.ts'), 'utf8')
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    expect(server).toContain('await downloadInboundFiles')
    expect(server.indexOf('await downloadInboundFiles')).toBeLessThan(server.indexOf('jobStore.enqueue({'))
    expect(runner).toContain('CREATE TABLE IF NOT EXISTS slack_threads')
    expect(runner).toContain('INSERT INTO slack_threads')
  })

  test('worker runtime is Codex exec/resume and never invokes Claude', () => {
    const runner = readFileSync(join(import.meta.dir, 'job-runner.ts'), 'utf8')
    const executor = readFileSync(join(import.meta.dir, 'codex-executor.ts'), 'utf8')
    expect(runner).toContain('executeCodexJob(job')
    expect(executor).toContain("'exec'")
    expect(executor).toContain("...(resumed && sessionId ? ['resume', sessionId] : [])")
    expect(executor).toContain("'--ignore-user-config'")
    expect(executor).not.toContain("'claude'")
  })

  test('read and write authorization map to separate Codex sandboxes', () => {
    const server = readFileSync(join(root, 'server.ts'), 'utf8')
    const executor = readFileSync(join(import.meta.dir, 'codex-executor.ts'), 'utf8')
    expect(server).toContain('writeAllowFrom')
    expect(server).toContain('writeEnabled')
    expect(executor).toContain("[':minimal', 'read']")
    expect(executor).not.toContain("extends=${tomlString(job.writeEnabled")
    expect(executor).toContain('permissions.${profile}.network.enabled=')
    expect(executor).toContain('default_permissions=')
    expect(executor).not.toContain("'-s'")
    expect(executor).toContain('Never post to Slack yourself')
    expect(executor).toContain('for (const writeEnabled of [false, true])')
  })

  test('launcher starts runner then standalone gateway, without Claude development channels', () => {
    const launcher = readFileSync(join(root, 'codex-channel.sh'), 'utf8')
    expect(launcher).toContain('start_job_runner')
    expect(launcher).toContain('bun "$REPO_DIR/server.ts"')
    expect(launcher.indexOf('start_job_runner')).toBeLessThan(
      launcher.lastIndexOf('exec caffeinate -dimsu'),
    )
    expect(launcher).not.toContain('dangerously-load-development-channels')
    expect(launcher).not.toContain('command -v claude')
  })

  test('setup requires Codex and installs every runtime companion', () => {
    const setup = readFileSync(join(import.meta.dir, 'setup.sh'), 'utf8')
    for (const expected of [
      'zerokun_require_codex_version',
      'codex-version.sh',
      'job-runner.ts',
      'codex-executor.ts',
      'state-dir.ts',
      'zerokun-access',
      'codex-channel',
      'zerokun-update',
      'watchdog.sh',
    ]) expect(setup).toContain(expected)
    expect(setup).not.toContain('command -v claude')
    expect(setup).not.toContain('claude-config')
    expect(setup).not.toContain('claude-skills')
  })

  test('self update follows the codex branch and restarts gateway without TUI confirmation', () => {
    const updater = readFileSync(join(import.meta.dir, 'update.ts'), 'utf8')
    expect(updater).toContain("ZEROKUN_UPDATE_BRANCH ?? 'codex'")
    expect(updater).toContain("join(options.rootRepo, 'codex-channel.sh')")
    expect(updater).toContain("join(stateDir, 'plugin.lock')")
    expect(updater).not.toContain('Enter\\s+to\\s+confirm')
    expect(updater).not.toContain('dangerously-load-development-channels')
  })

  test('explicit update request bypasses the normal FIFO to avoid self-deadlock', () => {
    const server = readFileSync(join(root, 'server.ts'), 'utf8')
    expect(server).toContain('isExplicitUpdateRequest(text)')
    expect(server).toContain('await enqueueUpdate(')
    const updateBranch = server.indexOf('isExplicitUpdateRequest(text)')
    const normalInboundFifo = server.indexOf('jobStore.stageInboundDelivery({', updateBranch)
    expect(updateBranch).toBeGreaterThan(-1)
    expect(updateBranch).toBeLessThan(normalInboundFifo)
  })
})
