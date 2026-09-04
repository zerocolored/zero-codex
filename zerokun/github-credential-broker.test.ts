import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { resolveAdvisorProjectLayout } from './advisor-snapshot.ts'
import {
  parseGitHubBrokerContext,
  registerGitHubCredentialTools,
} from './github-credential-broker.ts'
import type {
  GitHubPublicationCommands,
  PublicationCommandResult,
} from './github-publication.ts'
import { prepareManagedStateRoot } from './managed-path.ts'

const roots: string[] = []
const FIXTURE_GIT_TIMEOUT_MS = 3_000
const FIXTURE_LIFECYCLE_TIMEOUT_MS = 5_000
const MCP_TOOL_TIMEOUT_MS = 10_000
const COMPOSITE_TEST_TIMEOUT_MS = 60_000

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(repo: string, args: string[]): string {
  const result = Bun.spawnSync(['/usr/bin/git', '-C', repo, ...args], {
    env: {
      PATH: '/usr/bin:/bin', HOME: '/', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    timeout: FIXTURE_GIT_TIMEOUT_MS,
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

async function bounded<T>(label: string, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)),
          FIXTURE_LIFECYCLE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function fixture(withRemote = true) {
  const root = mkdtempSync(join(homedir(), '.zero-github-broker-'))
  chmodSync(root, 0o700)
  roots.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo, { mode: 0o700 })
  git(repo, ['init', '--initial-branch=develop'])
  git(repo, ['config', 'user.name', 'Zero Test'])
  git(repo, ['config', 'user.email', 'zero@example.invalid'])
  writeFileSync(join(repo, 'README.md'), 'fixture\n', { mode: 0o600 })
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'chore: initial'])
  if (withRemote) {
    git(repo, ['remote', 'add', 'origin', 'https://github.com/example/broker-fixture.git'])
  }
  const state = prepareManagedStateRoot(join(root, 'state'))
  const contextDir = join(state, 'advisor-context', 'broker-job')
  mkdirSync(contextDir, { recursive: true, mode: 0o700 })
  const layout = resolveAdvisorProjectLayout(repo)
  const contextPath = join(contextDir, 'context.json')
  writeFileSync(contextPath, `${JSON.stringify({
    version: 4,
    jobId: 'broker-job',
    attemptNonce: 'a'.repeat(32),
    repoPath: realpathSync(repo),
    gitRoots: layout.gitRoots,
    writeEnabled: true,
  })}\n`, { mode: 0o600 })
  return {
    repo,
    state,
    context: parseGitHubBrokerContext(contextPath, state),
    commitSha: git(repo, ['rev-parse', 'HEAD']),
  }
}

function result(exitCode: number, stdout = '', stderr = ''): PublicationCommandResult {
  return { exitCode, stdout, stderr }
}

async function connectedBroker<T>(
  context: ReturnType<typeof parseGitHubBrokerContext>,
  commands: GitHubPublicationCommands,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const server = new McpServer({ name: 'zerochan-github-test', version: '1.0.0' })
  registerGitHubCredentialTools(server, context, commands)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'zerochan-github-test-client', version: '1.0.0' })
  await bounded('broker fixture connection', Promise.all([
    server.connect(serverTransport), client.connect(clientTransport),
  ]))
  try {
    return await action(client)
  } finally {
    await bounded('broker fixture cleanup', (async () => {
      await Promise.allSettled([client.close()])
      // A cancelled client request rejects before the SDK has necessarily
      // finished the corresponding server request chain. Give that chain one
      // event-loop turn to settle before closing the server side of the linked
      // in-memory transport; concurrently closing both ends can strand Bun's
      // test runner under process-heavy suites.
      await Bun.sleep(0)
      await Promise.allSettled([server.close()])
    })())
  }
}

function callBrokerTool(
  client: Client,
  request: Parameters<Client['callTool']>[0],
): ReturnType<Client['callTool']> {
  return client.callTool(request, undefined, { timeout: MCP_TOOL_TIMEOUT_MS })
}

function responseJson(response: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = response.content
  if (!Array.isArray(content) || content[0]?.type !== 'text') {
    throw new Error('broker test response has no text')
  }
  return JSON.parse(content[0].text) as Record<string, unknown>
}

describe('GitHub credential broker', () => {
  test('startupはGitHub remoteや認証を必要とせずtool利用時まで遅延する', async () => {
    const value = fixture(false)
    let invoked = false
    const commands: GitHubPublicationCommands = {
      async runGit() { invoked = true; return result(1) },
      async runGh() { invoked = true; return result(1) },
    }
    await connectedBroker(value.context, commands, async client => {
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name).sort()).toEqual([
        'github_inspect',
        'github_publish_branch',
        'github_pull_request',
        'github_wait_delivery',
      ])
      expect(invoked).toBe(false)
    })
  })

  test('対象外workspace memberのremote不備は選択repositoryの操作を止めない', async () => {
    const value = fixture()
    const unrelated = join(value.repo, '..', 'unrelated-repo')
    mkdirSync(unrelated, { mode: 0o700 })
    git(unrelated, ['init', '--initial-branch=main'])
    const context = {
      ...value.context,
      gitRoots: [realpathSync(unrelated), value.repo],
    }
    let ghCalls = 0
    const commands: GitHubPublicationCommands = {
      async runGit() { return result(1, '', 'unexpected git command') },
      async runGh(args) {
        ghCalls += 1
        if (args[0] === 'repo' && args[1] === 'view') {
          return result(0, JSON.stringify({
            nameWithOwner: 'example/broker-fixture',
            url: 'https://github.com/example/broker-fixture',
            defaultBranchRef: { name: 'develop' },
          }))
        }
        return result(1, '', `unexpected gh command: ${args.join(' ')}`)
      },
    }
    await connectedBroker(context, commands, async client => {
      const response = await callBrokerTool(client, {
        name: 'github_inspect',
        arguments: { repository: 'example/broker-fixture' },
      })
      expect(response.isError).not.toBe(true)
      expect(responseJson(response)).toMatchObject({
        complete: true,
        repository: 'example/broker-fixture',
      })
      expect(ghCalls).toBe(1)
    })
  })

  test('exact commitのnon-force pushをremote照合し再呼出しでは重複送信しない', async () => {
    const value = fixture()
    let remoteHead: string | null = null
    let pushes = 0
    const commands: GitHubPublicationCommands = {
      async runGit(_repo, args) {
        if (args[0] === 'ls-remote') {
          return result(0, remoteHead
            ? `${remoteHead}\trefs/heads/zerochan/direct-workflow\n`
            : '')
        }
        if (args[0] === 'push') {
          pushes += 1
          remoteHead = value.commitSha
          return result(0, 'ok\n')
        }
        return result(1, '', 'unexpected git command')
      },
      async runGh() { return result(1, '', 'unexpected gh command') },
    }
    await connectedBroker(value.context, commands, async client => {
      for (let index = 0; index < 2; index += 1) {
        const response = await callBrokerTool(client, {
          name: 'github_publish_branch',
          arguments: {
            repository: 'example/broker-fixture',
            commitSha: value.commitSha,
            branch: 'zerochan/direct-workflow',
          },
        })
        expect(response.isError).not.toBe(true)
        expect(responseJson(response)).toMatchObject({
          complete: true,
          repository: 'example/broker-fixture',
          branch: 'zerochan/direct-workflow',
          commitSha: value.commitSha,
        })
      }
      expect(pushes).toBe(1)
    })
  })

  test('既存remote branchが古い場合もhost判断で止めずnon-force pushの結果を採用する', async () => {
    const value = fixture()
    const previous = value.commitSha
    writeFileSync(join(value.repo, 'next.txt'), 'next\n', { mode: 0o600 })
    git(value.repo, ['add', 'next.txt'])
    git(value.repo, ['commit', '-m', 'test: advance fixture'])
    const next = git(value.repo, ['rev-parse', 'HEAD'])
    let remoteHead = previous
    let pushes = 0
    const commands: GitHubPublicationCommands = {
      async runGit(_repo, args) {
        if (args[0] === 'ls-remote') {
          return result(0, `${remoteHead}\trefs/heads/zerochan/direct-workflow\n`)
        }
        if (args[0] === 'push') {
          pushes += 1
          expect(args).not.toContain('--force')
          remoteHead = next
          return result(0, 'ok\n')
        }
        return result(1, '', `unexpected git command: ${args.join(' ')}`)
      },
      async runGh() { return result(1, '', 'unexpected gh command') },
    }
    await connectedBroker(value.context, commands, async client => {
      const response = await callBrokerTool(client, {
        name: 'github_publish_branch',
        arguments: {
          repository: 'example/broker-fixture',
          commitSha: next,
          branch: 'zerochan/direct-workflow',
        },
      })
      expect(response.isError).not.toBe(true)
      expect(responseJson(response)).toMatchObject({ complete: true, commitSha: next })
      expect(pushes).toBe(1)
    })
  })

  test('current project外のrepositoryはGitHub command実行前に拒否する', async () => {
    const value = fixture()
    let invoked = false
    const commands: GitHubPublicationCommands = {
      async runGit() { invoked = true; return result(1) },
      async runGh() { invoked = true; return result(1) },
    }
    await connectedBroker(value.context, commands, async client => {
      const response = await callBrokerTool(client, {
        name: 'github_inspect',
        arguments: { repository: 'example/another-repository' },
      })
      expect(response.isError).toBe(true)
      expect(responseJson(response)).toEqual({
        complete: false,
        reason: 'GitHub repository is outside this job',
      })
      expect(invoked).toBe(false)
    })
  })

  test('MCP取消をGitHub commandと待機処理へ伝えて処理を継続しない', async () => {
    const value = fixture()
    const signals: Array<AbortSignal | undefined> = []
    const commands: GitHubPublicationCommands = {
      async runGit() { return result(1, '', 'unexpected git command') },
      async runGh(args, _stdin, signal) {
        signals.push(signal)
        if (args[0] === 'run') return result(0, '[]')
        if (args.some(arg => arg.includes('/check-runs?'))) {
          return result(0, JSON.stringify({ totalCount: 0, checks: [] }))
        }
        if (args.some(arg => arg.includes('/status?'))) return result(0, '[]')
        return result(1, '', `unexpected gh command: ${args.join(' ')}`)
      },
    }
    await connectedBroker(value.context, commands, async client => {
      const controller = new AbortController()
      const pending = client.callTool({
        name: 'github_wait_delivery',
        arguments: {
          repository: 'example/broker-fixture',
          commitSha: value.commitSha,
          maxWaitSeconds: 30,
        },
      }, undefined, { signal: controller.signal, timeout: 5_000 })
      await Bun.sleep(25)
      controller.abort()
      await expect(pending).rejects.toThrow()
      // Client cancellation is observable slightly before the server-side MCP
      // handler's catch/finally chain has quiesced. Do not let fixture teardown
      // race that protocol cleanup.
      await Bun.sleep(0)
      expect(signals.length).toBeGreaterThan(0)
      expect(signals.every(signal => signal instanceof AbortSignal)).toBe(true)
      expect(signals.some(signal => signal?.aborted)).toBe(true)
    })
  })

  test('成功checkがあっても同じcommitのActions run実行中は完了にしない', async () => {
    const value = fixture()
    const commands: GitHubPublicationCommands = {
      async runGit() { return result(1, '', 'unexpected git command') },
      async runGh(args) {
        if (args[0] === 'run' && args[1] === 'list') {
          return result(0, JSON.stringify([{
            databaseId: 11,
            name: 'deploy',
            workflowName: 'deploy',
            status: 'in_progress',
            conclusion: '',
            url: 'https://github.com/example/broker-fixture/actions/runs/11',
            headSha: value.commitSha,
            event: 'push',
          }]))
        }
        if (args[0] === 'api' && args.some(arg => arg.includes('/check-runs?'))) {
          return result(0, JSON.stringify({
            totalCount: 1,
            checks: [{
              id: 12,
              name: 'verify',
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/example/broker-fixture/actions/runs/12',
            }],
          }))
        }
        if (args[0] === 'api' && args.some(arg => arg.includes('/status?'))) {
          return result(0, '[]')
        }
        return result(1, '', `unexpected gh command: ${args.join(' ')}`)
      },
    }
    await connectedBroker(value.context, commands, async client => {
      const response = await callBrokerTool(client, {
        name: 'github_wait_delivery',
        arguments: {
          repository: 'example/broker-fixture',
          commitSha: value.commitSha,
          maxWaitSeconds: 1,
          settleSeconds: 0,
        },
      })
      expect(response.isError).not.toBe(true)
      expect(responseJson(response)).toMatchObject({
        complete: false,
        successful: false,
        runs: [{ status: 'in_progress' }],
        checks: [{ status: 'completed', conclusion: 'success' }],
      })
    })
  })

  test('PR作成の応答消失を照合し、承認・exact head merge・Actions完了まで同じ経路で進める', async () => {
    const value = fixture()
    const mergeSha = 'b'.repeat(40)
    let exists = false
    let merged = false
    let approvedCommit: string | null = null
    let approvals = 0
    let creates = 0
    let merges = 0
    const pullRequest = () => ({
      number: 42,
      url: 'https://github.com/example/broker-fixture/pull/42',
      state: merged ? 'MERGED' : 'OPEN',
      isDraft: false,
      baseRefName: 'develop',
      headRefName: 'zerochan/direct-workflow',
      headRefOid: value.commitSha,
      mergeCommit: merged ? { oid: mergeSha } : null,
      autoMergeRequest: null,
      statusCheckRollup: [{
        name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/example/broker-fixture/actions/runs/1',
      }],
    })
    const commands: GitHubPublicationCommands = {
      async runGit(_repo, args) {
        if (args[0] === 'ls-remote') {
          return result(0, `${value.commitSha}\trefs/heads/zerochan/direct-workflow\n`)
        }
        return result(1, '', `unexpected git command: ${args.join(' ')}`)
      },
      async runGh(args) {
        if (args[0] === 'pr' && args[1] === 'list') {
          return result(0, JSON.stringify(exists ? [pullRequest()] : []))
        }
        if (args[0] === 'pr' && args[1] === 'create') {
          creates += 1
          exists = true
          // Simulate a mutation accepted by GitHub whose response was lost.
          return result(1, '', 'connection closed')
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return result(0, JSON.stringify(pullRequest()))
        }
        if (args[0] === 'api' && args.includes('user')) {
          return result(0, 'zero-reviewer\n')
        }
        if (args[0] === 'api' && args.some(arg => arg.includes('/reviews?'))) {
          return result(0, JSON.stringify(approvedCommit ? [{
            login: 'zero-reviewer', state: 'APPROVED', commitId: approvedCommit,
          }] : []))
        }
        if (args[0] === 'api' && args.includes('event=APPROVE')) {
          approvals += 1
          approvedCommit = args.find(arg => arg.startsWith('commit_id='))?.slice(10) ?? null
          return result(0)
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          merges += 1
          expect(args).toContain('--match-head-commit')
          expect(args[args.indexOf('--match-head-commit') + 1]).toBe(value.commitSha)
          merged = true
          // Merge succeeded remotely even though the CLI lost its response.
          return result(1, '', 'connection closed')
        }
        if (args[0] === 'run' && args[1] === 'list') {
          return result(0, JSON.stringify([{
            databaseId: 1,
            name: 'verify',
            workflowName: 'verify',
            status: 'completed',
            conclusion: 'success',
            url: 'https://github.com/example/broker-fixture/actions/runs/1',
            headSha: mergeSha,
            event: 'pull_request',
          }]))
        }
        if (args[0] === 'api' && args.some(arg => arg.includes('/check-runs?'))) {
          return result(0, JSON.stringify({
            totalCount: 1,
            checks: [{
              id: 1, name: 'verify', status: 'completed', conclusion: 'success',
              url: 'https://github.com/example/broker-fixture/actions/runs/1',
            }],
          }))
        }
        if (args[0] === 'api' && args.some(arg => arg.includes('/status?'))) {
          return result(0, '[]')
        }
        return result(1, '', `unexpected gh command: ${args.join(' ')}`)
      },
    }
    await connectedBroker(value.context, commands, async client => {
      const created = await callBrokerTool(client, {
        name: 'github_pull_request',
        arguments: {
          repository: 'example/broker-fixture',
          action: 'create',
          expectedHeadSha: value.commitSha,
          baseBranch: 'develop',
          headBranch: 'zerochan/direct-workflow',
          title: 'feat: direct workflow',
          body: 'Direct Codex workflow.',
        },
      })
      expect(created.isError).not.toBe(true)
      expect(responseJson(created)).toMatchObject({
        complete: true,
        action: 'create',
        pullRequest: { number: 42, state: 'OPEN', headSha: value.commitSha },
      })

      const approved = await callBrokerTool(client, {
        name: 'github_pull_request',
        arguments: {
          repository: 'example/broker-fixture',
          action: 'approve',
          pullRequestNumber: 42,
          expectedHeadSha: value.commitSha,
        },
      })
      expect(approved.isError).not.toBe(true)

      const mergedResponse = await callBrokerTool(client, {
        name: 'github_pull_request',
        arguments: {
          repository: 'example/broker-fixture',
          action: 'merge',
          pullRequestNumber: 42,
          expectedHeadSha: value.commitSha,
          mergeMethod: 'squash',
        },
      })
      expect(mergedResponse.isError).not.toBe(true)
      expect(responseJson(mergedResponse)).toMatchObject({
        complete: true,
        action: 'merge',
        pullRequest: { number: 42, state: 'MERGED', headSha: value.commitSha },
      })

      const delivery = await callBrokerTool(client, {
        name: 'github_wait_delivery',
        arguments: {
          repository: 'example/broker-fixture',
          commitSha: mergeSha,
          pullRequestNumber: 42,
          maxWaitSeconds: 1,
          settleSeconds: 0,
        },
      })
      expect(delivery.isError).not.toBe(true)
      expect(responseJson(delivery)).toMatchObject({
        complete: true,
        successful: true,
        pullRequest: { state: 'MERGED' },
        serviceReachabilityVerified: false,
      })
      expect({ creates, approvals, merges }).toEqual({ creates: 1, approvals: 1, merges: 1 })
    })
  }, COMPOSITE_TEST_TIMEOUT_MS)
})
