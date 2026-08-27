import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  assertCodexAppServerGeneratedCapabilities,
  verifyCodexAppServerCapabilities,
} from './codex-app-server-capability.ts'
import { prepareManagedStateRoot } from './managed-path.ts'
import { observeProcessGeneration, readProcessIdentity } from './process-generation.ts'
import {
  createSeatbeltFingerprint,
  reapSeatbeltFingerprint,
  removeSeatbeltFingerprint,
} from './seatbelt-fingerprint.ts'

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'zero-app-server-capability-'))
  temporaryDirs.push(root)
  const files: Record<string, string> = {
    'InitializeResponse.ts': [
      'userAgent: string',
      'codexHome: AbsolutePathBuf',
      'platformFamily: string',
      'platformOs: string',
    ].join('\n'),
    'ClientRequest.ts': [
      '"method": "thread/read"',
      '"method": "thread/list"',
      '"method": "thread/turns/list"',
      '"method": "thread/items/list"',
      '"method": "thread/start"',
      '"method": "thread/resume"',
      '"method": "turn/start"',
      '"method": "turn/steer"',
      '"method": "turn/interrupt"',
    ].join(' | '),
    'v2/Thread.ts': [
      'parentThreadId: string | null',
      'agentRole: string | null',
      'cwd: AbsolutePathBuf',
      'modelProvider: string',
      'source: SessionSource',
      'turns: Array<Turn>',
      'status: ThreadStatus',
      'canAcceptDirectInput: boolean | null',
    ].join('\n'),
    'v2/ThreadStatus.ts': '"type": "idle" | "type": "active"',
    'v2/ThreadStartParams.ts': [
      'cwd?: string | null',
      'approvalPolicy?: AskForApproval | null',
      'permissions?: string | null',
      'developerInstructions?: string | null',
    ].join('\n'),
    'v2/ThreadResumeParams.ts': [
      'threadId: string',
      'cwd?: string | null',
      'approvalPolicy?: AskForApproval | null',
      'permissions?: string | null',
      'developerInstructions?: string | null',
    ].join('\n'),
    'v2/ThreadListParams.ts': [
      'sourceKinds?: Array<ThreadSourceKind> | null',
      'parentThreadId?: string | null',
    ].join('\n'),
    'v2/ThreadSourceKind.ts': 'export type ThreadSourceKind = "cli" | "vscode" | "exec" | "appServer" | "subAgent" | "subAgentReview" | "subAgentCompact" | "subAgentThreadSpawn" | "subAgentOther" | "unknown";',
    'v2/ThreadListResponse.ts': [
      'data: Array<Thread>',
      'nextCursor: string | null',
      'backwardsCursor: string | null',
    ].join('\n'),
    'v2/ThreadItem.ts': [
      '"type": "userMessage"',
      'clientId: string | null',
      'content: Array<UserInput>',
      '"type": "agentMessage"',
      'phase: MessagePhase | null',
      '"type": "commandExecution"',
      'command: string',
      'cwd: LegacyAppPathString',
      'source: CommandExecutionSource',
      'status: CommandExecutionStatus',
      'exitCode: number | null',
      '"type": "subAgentActivity"',
      'kind: SubAgentActivityKind',
      'agentThreadId: string',
    ].join('\n'),
    'MessagePhase.ts': '"commentary" | "final_answer"',
    'v2/SubAgentActivityKind.ts': 'export type SubAgentActivityKind = "started" | "interacted" | "interrupted";',
    'v2/ThreadTurnsListParams.ts': [
      'threadId: string',
      'cursor?: string | null',
      'limit?: number | null',
      'sortDirection?: SortDirection | null',
      'itemsView?: TurnItemsView | null',
    ].join('\n'),
    'v2/ThreadTurnsListResponse.ts': 'data: Array<Turn>, nextCursor: string | null',
    'v2/ThreadItemsListResponse.ts': 'data: Array<ThreadItemEntry>, nextCursor: string | null',
    'v2/ThreadItemsListParams.ts': [
      'threadId: string',
      'turnId?: string | null',
      'cursor?: string | null',
      'limit?: number | null',
      'sortDirection?: SortDirection | null',
    ].join('\n'),
    'v2/CommandExecutionSource.ts': '"agent" | "unifiedExecStartup" | "userShell"',
    'v2/ErrorNotification.ts': [
      'error: TurnError',
      'willRetry: boolean',
      'threadId: string',
      'turnId: string',
    ].join('\n'),
    'v2/TurnStartParams.ts': [
      'threadId: string',
      'clientUserMessageId?: string | null',
      'input: Array<UserInput>',
      'cwd?: string | null',
      'approvalPolicy?: AskForApproval | null',
      'permissions?: string | null',
    ].join('\n'),
    'v2/TurnSteerParams.ts': [
      'threadId: string',
      'expectedTurnId: string',
      'input: Array<UserInput>',
      'clientUserMessageId?: string | null',
    ].join('\n'),
    'v2/TurnInterruptParams.ts': 'threadId: string, turnId: string',
    'v2/TurnStartedNotification.ts': 'threadId: string, turn: Turn',
    'v2/TurnCompletedNotification.ts': 'threadId: string, turn: Turn',
    'v2/ItemStartedNotification.ts': 'threadId: string, turnId: string, item: ThreadItem',
    'v2/ItemCompletedNotification.ts': 'threadId: string, turnId: string, item: ThreadItem',
    'v2/Turn.ts': [
      'id: string',
      'status: TurnStatus',
      'itemsView: TurnItemsView',
      'items: Array<ThreadItem>',
      'error: TurnError | null',
    ].join('\n'),
    'v2/ThreadStartResponse.ts': [
      'instructionSources: Array<LegacyAppPathString>',
      'activePermissionProfile: ActivePermissionProfile | null',
      'approvalPolicy: AskForApproval',
      'cwd: AbsolutePathBuf',
      'thread: Thread',
      'model: string',
      'modelProvider: string',
    ].join('\n'),
    'v2/ThreadResumeResponse.ts': [
      'instructionSources: Array<LegacyAppPathString>',
      'activePermissionProfile: ActivePermissionProfile | null',
      'approvalPolicy: AskForApproval',
      'cwd: AbsolutePathBuf',
      'thread: Thread',
      'model: string',
      'modelProvider: string',
    ].join('\n'),
  }
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, { mode: 0o600 })
  }
  return root
}

describe('Codex App Server capability gate', () => {
  test('native advisor verificationが使う公式protocol surfaceを受理する', () => {
    expect(() => assertCodexAppServerGeneratedCapabilities(fixture())).not.toThrow()
  })

  test('paginationまたはsubagent fieldが欠けたreleaseをfail-closeする', () => {
    const root = fixture()
    writeFileSync(join(root, 'v2/ThreadItemsListResponse.ts'), 'data: Array<ThreadItemEntry>')
    expect(() => assertCodexAppServerGeneratedCapabilities(root)).toThrow('nextCursor')
  })

  test('遅延subagent照合に必要なactivity kindを欠くreleaseをfail-closeする', () => {
    const root = fixture()
    writeFileSync(join(root, 'v2/SubAgentActivityKind.ts'), '"started" | "interacted"')
    expect(() => assertCodexAppServerGeneratedCapabilities(root)).toThrow('interrupted')
  })

  test('direct-child全列挙に必要なsource kind集合の増減をfail-closeする', () => {
    const root = fixture()
    writeFileSync(
      join(root, 'v2/ThreadSourceKind.ts'),
      'export type ThreadSourceKind = "cli" | "vscode" | "exec" | "appServer" | "subAgent" | "subAgentReview" | "subAgentCompact" | "subAgentThreadSpawn" | "subAgentOther" | "futureSubAgent" | "unknown";',
    )
    expect(() => assertCodexAppServerGeneratedCapabilities(root)).toThrow('ThreadSourceKind')
  })

  test('userMessage clientIdを履歴へ残さないreleaseをfail-closeする', () => {
    const root = fixture()
    const path = join(root, 'v2/ThreadItem.ts')
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('clientId: string | null', ''),
      { mode: 0o600 },
    )
    expect(() => assertCodexAppServerGeneratedCapabilities(root)).toThrow('clientId')
  })

  test('agentMessage phaseを区別できないreleaseをfail-closeする', () => {
    const root = fixture()
    writeFileSync(join(root, 'MessagePhase.ts'), '"final_answer"')
    expect(() => assertCodexAppServerGeneratedCapabilities(root)).toThrow('commentary')
  })

  test.skipIf(process.platform !== 'darwin'
    || process.env.ZERO_CODEX_CANDIDATE_SANDBOX === '1')(
    'generate-ts親終了後にdetached子がpipeを保持してもboundedに失敗しfingerprintで回収できる',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'zero-app-server-pipe-holder-'))
      temporaryDirs.push(root)
      const state = prepareManagedStateRoot(join(root, 'state'))
      const pidFile = join(root, 'holder.pid')
      const executable = join(root, 'codex')
      writeFileSync(executable, `#!/usr/bin/python3
import os
import time

child = os.fork()
if child == 0:
    os.setsid()
    grandchild = os.fork()
    if grandchild > 0:
        os._exit(0)
    with open(${JSON.stringify(pidFile)}, "w", encoding="ascii") as output:
        output.write(str(os.getpid()))
        output.flush()
        os.fsync(output.fileno())
    time.sleep(30)
    os._exit(0)
os.waitpid(child, 0)
`, { mode: 0o700 })
      chmodSync(executable, 0o700)
      const earliest = readProcessIdentity(process.pid)
      expect(earliest).not.toBeNull()
      const fingerprint = createSeatbeltFingerprint(
        state,
        'capability-pipe-holder',
        'a'.repeat(32),
      )
      let holder = null as ReturnType<typeof readProcessIdentity>
      try {
        await expect(verifyCodexAppServerCapabilities(executable, {
          HOME: root,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        }, { seatbeltFingerprint: fingerprint })).rejects.toThrow(
          'output remained open after process exit',
        )
        const pid = Number(readFileSync(pidFile, 'utf8'))
        holder = readProcessIdentity(pid)
        expect(holder).not.toBeNull()
        expect(holder && observeProcessGeneration(holder).status).toBe('alive')
      } finally {
        const reaped = await reapSeatbeltFingerprint({
          stateDir: state,
          fingerprint,
          earliest: earliest ?? undefined,
          excludePids: new Set([process.pid]),
        })
        if (holder) {
          expect(reaped).toContain(holder.pid)
          expect(observeProcessGeneration(holder).status).toBe('dead')
        }
        removeSeatbeltFingerprint(state, fingerprint)
      }
    },
  )
})
