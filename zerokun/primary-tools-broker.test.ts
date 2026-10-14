import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { buildCodexPermissionOverrides } from './codex-executor.ts'
import { ensureManagedDirectory, prepareManagedStateRoot } from './managed-path.ts'
import { resolveOfficialStandaloneCodex } from './standalone-codex.ts'
import { PrimaryToolRuntime, type PrimaryToolsContext } from './primary-tools-broker.ts'
import type { JobRecord } from './job-runner.ts'

const roots: string[] = [], runtimes: PrimaryToolRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(writeEnabled: boolean) {
  const root = realpathSync(mkdtempSync('/tmp/zero-primary-tools-test-')); roots.push(root)
  const repo = join(root, 'repo'); mkdirSync(repo)
  const stateDir = prepareManagedStateRoot(join(root, 'state'))
  const scratchDir = ensureManagedDirectory(stateDir, join(stateDir, 'scratch'))
  const artifactDir = ensureManagedDirectory(stateDir, join(stateDir, 'outbox'))
  const contextDir = ensureManagedDirectory(stateDir, join(stateDir, 'context'))
  const job = { id: 'primary-tools-test', repoPath: repo, writeEnabled, attachments: [] } as JobRecord
  const profile = 'zero_primary_tools_test'
  const overrides = buildCodexPermissionOverrides(job, {
    stateDir, scratchDir, artifactDir, profile, browserAccessEnabled: false,
    multiAgentEnabled: false, nativeCloudAccessEnabled: false, nativeDockerAccessEnabled: false,
  })
  const config = Bun.TOML.parse(overrides.join('\n')) as any
  const context: PrimaryToolsContext = { version: 1, jobId: job.id, cwd: repo, stateDir,
    goalPath: join(contextDir, 'goal.json'), codex: resolveOfficialStandaloneCodex(), profile,
    permissionOverrides: overrides, shellEnvironment: config.shell_environment_policy.set }
  const runtime = new PrimaryToolRuntime(context); runtimes.push(runtime)
  return { root, repo, stateDir, runtime }
}

test.skipIf(process.platform !== 'darwin')('Claude host tools enforce read-only repository and private state under the real Codex sandbox', async () => {
  const f = fixture(false)
  writeFileSync(join(f.repo, 'visible.txt'), 'synthetic-readable')
  const read = await f.runtime.execute({ command: 'cat visible.txt', yieldMs: 5_000 })
  expect(read.exitCode).toBe(0)
  expect(read.output).toContain('synthetic-readable')
  const write = await f.runtime.execute({ command: 'echo changed > forbidden.txt', yieldMs: 5_000 })
  expect(write.exitCode).not.toBe(0)
  expect(existsSync(join(f.repo, 'forbidden.txt'))).toBe(false)
  writeFileSync(join(f.stateDir, 'synthetic-private'), 'private-fixture-only')
  const denied = await f.runtime.execute({ command: 'cat ../state/synthetic-private', yieldMs: 5_000 })
  expect(denied.exitCode).not.toBe(0)
  expect(denied.output).not.toContain('private-fixture-only')
}, 15_000)

test.skipIf(process.platform !== 'darwin')('authorized edits succeed while host state remains immutable', async () => {
  const f = fixture(true)
  const edit = await f.runtime.execute({ command: 'echo implementation > result.txt', yieldMs: 5_000 })
  expect(edit.exitCode).toBe(0)
  expect(readFileSync(join(f.repo, 'result.txt'), 'utf8').trim()).toBe('implementation')
  const denied = await f.runtime.execute({ command: 'echo forged > ../state/forbidden', yieldMs: 5_000 })
  expect(denied.exitCode).not.toBe(0)
  expect(existsSync(join(f.stateDir, 'forbidden'))).toBe(false)
}, 15_000)

test.skipIf(process.platform !== 'darwin')('long command is polled with stdin without relaunch and can be stopped', async () => {
  const f = fixture(true)
  const command = await f.runtime.execute({ command: 'read value; print -r -- "$value"; sleep 30', yieldMs: 0 })
  expect(command.sessionId).toBeString()
  const polled = await f.runtime.poll({ id: command.sessionId!, input: 'SINGLE\n', yieldMs: 200 })
  expect(polled.output.trim()).toBe('SINGLE')
  expect(polled.sessionId).toBe(command.sessionId)
  await f.runtime.stop(command.sessionId!)
  await expect(f.runtime.poll({ id: command.sessionId! })).rejects.toThrow('unknown command')
}, 10_000)

test('goal state survives a broker replacement and requires explicit completion', () => {
  const f = fixture(false)
  expect(f.runtime.readGoal().status).toBe('active')
  f.runtime.updateGoal('blocked', 'Synthetic external dependency')
  const replacement = new PrimaryToolRuntime(f.runtime.context); runtimes.push(replacement)
  expect(replacement.readGoal().status).toBe('blocked')
  replacement.updateGoal('active', 'Dependency resolved')
  expect(f.runtime.readGoal().status).toBe('active')
  replacement.updateGoal('complete', 'All synthetic acceptance checks passed')
  expect(f.runtime.readGoal().status).toBe('complete')
})

test.skipIf(process.platform !== 'darwin')('image inspection uses the real task sandbox and rejects non-images and private state', async () => {
  const f = fixture(false)
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1kAAAAASUVORK5CYII=', 'base64')
  writeFileSync(join(f.repo, 'pixel.png'), image)
  const result = await f.runtime.viewImage('pixel.png')
  expect(result.content[0]!.mimeType).toBe('image/png')
  expect(Buffer.from(result.content[0]!.data, 'base64')).toEqual(image)
  writeFileSync(join(f.repo, 'text.txt'), 'not-an-image')
  await expect(f.runtime.viewImage('text.txt')).rejects.toThrow('supported image')
  writeFileSync(join(f.stateDir, 'pixel.png'), image)
  await expect(f.runtime.viewImage('../state/pixel.png')).rejects.toThrow('inaccessible')
  writeFileSync(join(f.repo, 'oversized.png'), Buffer.concat([image, Buffer.alloc(5 * 1024 * 1024)]))
  await expect(f.runtime.viewImage('oversized.png')).rejects.toThrow('oversized')
}, 15_000)
