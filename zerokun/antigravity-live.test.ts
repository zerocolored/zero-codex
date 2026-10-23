import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { JobStore } from './job-runner.ts'
import { runAntigravityDelegation } from './antigravity-delegation-attempt.ts'

// Explicit opt-in: consumes the existing Antigravity subscription. This checks
// the real native protocol + permission sandbox, not the production Herdr UI.
for (const writeEnabled of [false, true]) test.skipIf(process.env.ZERO_AGY_LIVE !== '1')(`installed Antigravity responds within inherited sandbox (write=${writeEnabled})`, async () => {
  const root = realpathSync(mkdtempSync('/tmp/zero-agy-live-'))
  const stateDir = join(root, 'state'), repo = join(root, 'repo')
  mkdirSync(stateDir, { mode: 0o700 }); mkdirSync(repo)
  const store = new JobStore(join(stateDir, 'jobs.sqlite3'))
  store.enqueue({ repoPath: repo, chatId: 'C', threadTs: '1800000000.1', messageId: '1800000000.1', userId: 'U', task: 'native protocol probe', writeEnabled })
  const job = store.claimNext('test')!
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 90_000)
  try {
    const result = await runAntigravityDelegation({ version: 1, stateDir, job }, 'b'.repeat(64),
      { model: 'gemini-3.8-flash-low', prompt: writeEnabled ? 'Using your native file-writing tool, create agy-proof.txt in the current project directory containing exactly ANTIGRAVITY_FILE_OK. Do not run commands or any other tools. After saving it, reply with exactly ANTIGRAVITY_OK.' : 'Reply with exactly ANTIGRAVITY_OK. Do not use tools.' }, controller.signal, {
        transport: async options => {
          const child = Bun.spawn([options.executable, ...options.arguments], { cwd: options.cwd, env: options.environment,
            stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
          // Consume diagnostics without exposing account/configuration output.
          const stderr = new Response(child.stderr).text()
          return { input: { write: async s => { child.stdin.write(s); await child.stdin.flush() }, end: async () => { child.stdin.end() } },
            output: child.stdout, exited: child.exited, identity: {} as any, pane: {} as any,
            close: async () => { if (child.exitCode === null) child.kill(); await child.exited; await stderr } }
        },
      })
    expect(result.trim()).toBe('ANTIGRAVITY_OK')
    if (writeEnabled) expect(readFileSync(join(repo, 'agy-proof.txt'), 'utf8').trim()).toBe('ANTIGRAVITY_FILE_OK')
  } finally { clearTimeout(timeout); store.close(); rmSync(root, { recursive: true, force: true }) }
}, 100_000)
