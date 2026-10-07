import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeUiProposalSchema, createClaudeUiWorkspace, collectClaudeUiArtifacts, type ClaudeUiWorkspace } from './claude-ui-artifacts.ts'
import { advisorPrompt } from './advisor-broker.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
test('missing Before preserves the requested comparison and explicitly degrades the effective evidence', async () => {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'zero-ui-missing-')))
  roots.push(stateDir)
  const proposal = { comparison: 'Current inbox, light, scroll zero', beforeKind: 'actual' as const, beforeImage: 'missing.png' }
  const workspace = await createClaudeUiWorkspace({ stateDir, jobId: 'test-job', proposal })
  roots.push(workspace.root)
  expect(workspace.beforeWarning).toBe('missing-before-image')
  expect(existsSync(join(workspace.root, 'input/before.png'))).toBe(false)
  expect(JSON.parse(readFileSync(join(workspace.root, 'input/comparison.json'), 'utf8'))).toMatchObject({
    beforeKind: 'unavailable', requestedComparison: proposal, warning: 'missing-before-image',
  })
})

test('a symlink Before is rejected without treating it as missing or reading its target', async () => {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'zero-ui-unsafe-')))
  roots.push(stateDir)
  mkdirSync(join(stateDir, 'outbox/test-job'), { recursive: true, mode: 0o700 })
  symlinkSync('/nonexistent-target', join(stateDir, 'outbox/test-job/before.png'))
  await expect(createClaudeUiWorkspace({ stateDir, jobId: 'test-job', proposal: {
    comparison: 'Current inbox', beforeKind: 'actual', beforeImage: 'before.png',
  } })).rejects.toThrow()
})
async function fixture() {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'zero-ui-artifact-test-')))
  chmodSync(stateDir, 0o700); roots.push(stateDir)
  const workspace = await createClaudeUiWorkspace({ stateDir, jobId: 'test-job', proposal: {
    comparison: 'Synthetic settings screen, dark theme, scroll 0, no focus', beforeKind: 'synthetic',
  } })
  roots.push(workspace.root)
  writeFileSync(join(workspace.root, 'prototype', 'index.html'), '<!doctype html><title>Settings</title><h1>Settings</h1>', { mode: 0o600 })
  return { workspace, stateDir, jobId: 'test-job' }
}
function png(workspace: ClaudeUiWorkspace, width = 1280) {
  const ppm = join(workspace.root, 'runtime', 'test.ppm')
  writeFileSync(ppm, Buffer.concat([Buffer.from(`P6\n${width} 720\n255\n`), Buffer.alloc(width * 720 * 3, 96)]))
  const result = Bun.spawnSync(['/usr/bin/sips', '-s', 'format', 'png', ppm, '--out', join(workspace.root, 'evidence', 'after.png')], { stdout: 'ignore', stderr: 'pipe' })
  expect(result.exitCode).toBe(0)
}

test('GUI prompt permits Fable sample/capture while ordinary advice remains read-only', async () => {
  const { workspace } = await fixture()
  const context = { version: 4 as const, jobId: 'test-job', attemptNonce: 'a'.repeat(32), repoPath: '/project', gitRoot: '/project', gitRoots: ['/project'], writeEnabled: true, initialRepositoryDigest: 'b'.repeat(64) }
  const input = { revision: 1, digest: 'c'.repeat(64), transcript: 'Make the settings clearer' } as Parameters<typeof advisorPrompt>[1]
  expect(advisorPrompt(context, input, 'investigation', 1, 'evidence', workspace)).toContain('prototype/index.html')
  expect(advisorPrompt(context, input, 'investigation', 1, 'evidence', workspace)).not.toContain('すべてのfile writeを行わない')
  expect(advisorPrompt(context, input, 'review', 1, 'evidence')).toContain('すべてのfile writeを行わない')
  expect(claudeUiProposalSchema.safeParse({ comparison: 'test', beforeKind: 'actual' }).success).toBe(false)
  expect(claudeUiProposalSchema.safeParse({ comparison: 'test', beforeKind: 'actual', beforeImage: '../private.png' }).success).toBe(false)
})

test.skipIf(process.platform !== 'darwin')('collects a decoded fixed-size PNG with Fable provenance and retains the prototype', async () => {
  const input = await fixture(); png(input.workspace)
  const result = collectClaudeUiArtifacts(input)
  expect(result).toMatchObject({ status: 'produced', producer: 'claude-fable-5-1', width: 1280, height: 720, requiresPrimaryVisualInspection: true })
  expect(existsSync(result.prototypePath)).toBe(true)
  expect(readFileSync(result.afterPath).subarray(1, 4).toString()).toBe('PNG')
  expect(result.afterPath.startsWith(input.stateDir)).toBe(true)
  expect(result.prototypePath.startsWith(input.stateDir)).toBe(false)
})

test.skipIf(process.platform !== 'darwin')('rejects malformed images, mismatched geometry and symlink outputs', async () => {
  const input = await fixture()
  const output = join(input.workspace.root, 'evidence', 'after.png')
  writeFileSync(output, 'not png')
  expect(() => collectClaudeUiArtifacts(input)).toThrow()
  png(input.workspace, 640)
  expect(() => collectClaudeUiArtifacts(input)).toThrow('dimensions')
  rmSync(output); symlinkSync(join(input.workspace.root, 'prototype', 'index.html'), output)
  expect(() => collectClaudeUiArtifacts(input)).toThrow()
})

test('does not traverse a replaced artifact directory', async () => {
  const input = await fixture()
  const evidence = join(input.workspace.root, 'evidence')
  rmSync(evidence, { recursive: true }); symlinkSync(input.stateDir, evidence)
  expect(() => collectClaudeUiArtifacts(input)).toThrow('directory is unsafe')
  mkdirSync(join(input.stateDir, 'other'), { mode: 0o700 })
})
