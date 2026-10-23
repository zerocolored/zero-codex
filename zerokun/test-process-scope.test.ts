import { expect, test } from 'bun:test'
import { TestProcessScope } from './test-process-scope.ts'
import type { Subprocess } from 'bun'

function spawnFixture(scope: TestProcessScope) {
  return scope.own(Bun.spawn([process.execPath, '--config=/dev/null', '--no-env-file', '-e',
    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', detached: process.platform !== 'win32',
  }))
}

async function ready(child: ReturnType<typeof spawnFixture>) {
  const reader = child.stdout.getReader()
  try { expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready') }
  finally { reader.releaseLock() }
}

test('identity assertion failure still reaps a detached TERM-ignoring test child', async () => {
  let child: Subprocess | undefined
  await expect((async () => {
    await using scope = new TestProcessScope()
    const fixture = spawnFixture(scope)
    child = fixture
    await ready(fixture)
    // Reproduce the pre-body identity assertion that previously leaked children.
    expect(undefined).toBeDefined()
  })()).rejects.toThrow()
  expect(child!.signalCode).toBe('SIGKILL')
  expect(() => process.kill(child!.pid, 0)).toThrow()
})

test('a later spawn failure reaps the earlier child', async () => {
  let child: Subprocess | undefined
  await expect((async () => {
    await using scope = new TestProcessScope()
    const fixture = spawnFixture(scope)
    child = fixture
    await ready(fixture)
    scope.own(Bun.spawn(['/nonexistent-zerochan-test-executable']))
  })()).rejects.toThrow()
  expect(child!.signalCode).toBe('SIGKILL')
  expect(() => process.kill(child!.pid, 0)).toThrow()
})

test('normal scope exit reaps all owned children and preserves an unrelated child', async () => {
  await using unrelatedScope = new TestProcessScope()
  const unrelated = spawnFixture(unrelatedScope)
  await ready(unrelated)
  const children: Subprocess[] = []
  {
    await using scope = new TestProcessScope()
    for (let n = 0; n < 2; n++) {
      const child = spawnFixture(scope)
      children.push(child)
      await ready(child)
    }
  }
  for (const child of children) expect(() => process.kill(child.pid, 0)).toThrow()
  expect(unrelated.exitCode).toBeNull()
  expect(() => process.kill(unrelated.pid, 0)).not.toThrow()
})
