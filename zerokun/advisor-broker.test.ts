import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readProcessIdentity } from './process-tree.ts'
import { signalProcessIfLive } from './process-generation.ts'
import {
  advanceAdvisorReceipt,
  advisorReceiptAlreadyObserved,
  advisorReceiptChallenge,
  assertClaudeSubscriptionLogin,
  brokerEnvironment,
  claudeSubscriptionStatusIsReady,
  createExclusivePrivateFile,
  decodeHerdrReadOutput,
  emptyClaudePrompt,
  extractCompleteClaudeResponse,
  parseFifthAdvisorSendOutcome,
  releaseExclusivePrivateFile,
  runBounded,
  MAX_ADVISOR_PROMPT_BYTES,
} from './advisor-broker.ts'
import { JobStore } from './job-runner.ts'
import { readAdvisorInputSnapshot, type AdvisorInputSnapshot } from './advisor-input.ts'
import {
  advisorRepositoryDigest,
  resolveAdvisorProjectLayout,
  snapshotAdvisorRepository,
} from './advisor-snapshot.ts'
import { nativeAdvisorMarker } from './native-advisor-evidence.ts'
import { createSeatbeltFingerprint } from './seatbelt-fingerprint.ts'
import { requireHerdrRuntime, writePinnedHerdrRuntime } from './herdr-runtime.ts'

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zerochan-advisor-broker-'))
  temporaryDirs.push(dir)
  return dir
}

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['/usr/bin/git', ...args], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: '/usr/bin:/bin', HOME: '/', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

type BrokerFixture = {
  state: string
  repo: string
  jobId: string
  nonce: string
  revisionOne: AdvisorInputSnapshot
  revisionTwo: AdvisorInputSnapshot
  journalRoot: string
  call(
    phase?: 'investigation' | 'design',
    binding?: 'revision-one' | 'revision-two',
  ): Promise<{
    result: Awaited<ReturnType<Client['callTool']>>
    payload: Record<string, unknown>
  }>
  close(): Promise<void>
}

async function brokerFixture(): Promise<BrokerFixture> {
  const root = fixtureDir()
  chmodSync(root, 0o700)
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  mkdirSync(join(root, 'repo'), { mode: 0o700 })
  const state = realpathSync(join(root, 'state'))
  const repo = realpathSync(join(root, 'repo'))
  const runtimeDir = join(state, 'advisor-runtime')
  mkdirSync(runtimeDir, { mode: 0o700 })
  git(['init', '-q'], repo)
  git(['config', 'user.name', 'Zero Test'], repo)
  git(['config', 'user.email', 'zero-test@example.invalid'], repo)
  writeFileSync(join(repo, 'README.md'), 'fixture\n', { mode: 0o600 })
  git(['add', 'README.md'], repo)
  git(['commit', '-qm', 'test fixture'], repo)

  const socketPath = join(root, 'herdr.sock')
  const socket = Bun.listen({ unix: socketPath, socket: { data() {} } })
  chmodSync(socketPath, 0o600)
  const binary = join(root, 'herdr')
  writeFileSync(binary, [
    '#!/bin/sh',
    `printf '%s\\n' ${JSON.stringify(JSON.stringify({
      id: 'fixture',
      result: { pane: {
        pane_id: 'wT:p2',
        tab_id: 'wT:t3',
        terminal_id: 'term_012345abcdef',
        workspace_id: 'wT',
      } },
    }))}`,
    '',
  ].join('\n'), { mode: 0o700 })
  const environment = {
    HOME: homedir(),
    PATH: `/usr/bin:/bin`,
    HERDR_ENV: '1',
    HERDR_BIN_PATH: binary,
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: 'wOLD:p1',
    HERDR_TAB_ID: 'wOLD:t1',
    HERDR_WORKSPACE_ID: 'wOLD',
  }
  writePinnedHerdrRuntime(state, requireHerdrRuntime(environment))

  const store = new JobStore(join(state, 'jobs.sqlite3'))
  const job = store.enqueue({
    chatId: 'C0123456789',
    threadTs: '1800000000.000100',
    messageId: '1800000000.000100',
    userId: 'U_FIRST',
    repoPath: repo,
    task: '最初の依頼',
    writeEnabled: false,
  }).job
  const revisionOne = readAdvisorInputSnapshot(state, job.id)
  const target = store.liveControlTarget(job.chatId, job.threadTs)
  if (!target) throw new Error('queued broker fixture did not expose live control')
  expect(store.stageLiveControl(target, {
    chatId: job.chatId,
    threadTs: job.threadTs,
    messageId: '1800000000.000200',
    userId: 'U_DIFFERENT',
    task: '同じスレッドの別ユーザーから追記',
    kind: 'steer',
  })).toBe('staged')
  const revisionTwo = readAdvisorInputSnapshot(state, job.id)

  const nonce = 'a'.repeat(32)
  const layout = resolveAdvisorProjectLayout(repo)
  const contextPath = join(state, 'context.json')
  writeFileSync(contextPath, `${JSON.stringify({
    version: 4,
    jobId: job.id,
    attemptNonce: nonce,
    repoPath: realpathSync(repo),
    gitRoot: layout.gitRoot,
    gitRoots: layout.gitRoots,
    writeEnabled: false,
    initialRepositoryDigest: advisorRepositoryDigest(snapshotAdvisorRepository(layout)),
  })}\n`, { mode: 0o600 })
  const fingerprint = createSeatbeltFingerprint(state, job.id, nonce)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--config=/dev/null', '--no-env-file', realpathSync(join(import.meta.dir, 'advisor-broker.ts')),
      contextPath, state, runtimeDir, fingerprint.allow.path, fingerprint.deny.path,
    ],
    cwd: repo,
    env: environment,
    stderr: 'pipe',
  })
  let brokerStderr = ''
  transport.stderr?.on('data', chunk => { brokerStderr += String(chunk) })
  const client = new Client({ name: 'zerochan-advisor-broker-test', version: '1.0.0' })
  try {
    await client.connect(transport)
  } catch (error) {
    store.close()
    socket.stop(true)
    throw new Error(`${error}${brokerStderr ? `\n${brokerStderr}` : ''}`)
  }
  const journalRoot = join(state, 'advisor-journal', job.id, nonce)
  return {
    state,
    repo,
    jobId: job.id,
    nonce,
    revisionOne,
    revisionTwo,
    journalRoot,
    async call(phase = 'investigation', binding = 'revision-one') {
      const selectedInput = binding === 'revision-one' ? revisionOne : revisionTwo
      const responseFor = (perspective: 'solution' | 'risk') => [
        `${perspective} response`,
        nativeAdvisorMarker(
          nonce, selectedInput.revision, selectedInput.digest, phase, 1, perspective,
        ),
      ].join('\n')
      let result: Awaited<ReturnType<Client['callTool']>>
      try {
        result = await client.callTool({
          name: 'advisor_round',
          arguments: {
            phase,
            round: 1,
            inputRevision: selectedInput.revision,
            inputDigest: selectedInput.digest,
            primaryEvidence: 'bounded primary evidence',
            nativeAdvisors: [
              { perspective: 'solution', agentId: '/root/native-solution', response: responseFor('solution') },
              { perspective: 'risk', agentId: '/root/native-risk', response: responseFor('risk') },
            ],
          },
        })
      } catch (error) {
        throw new Error(`${error}${brokerStderr ? `\n${brokerStderr}` : ''}`)
      }
      let block = result.content.find(value => value.type === 'text')
      if (!block || block.type !== 'text') throw new Error('advisor broker omitted text result')
      let payload = JSON.parse(block.text) as Record<string, unknown>
      while (payload.pending === true || payload.receiptRequired === true) {
        result = await client.callTool({
          name: 'advisor_round_poll',
          arguments: {
            phase,
            round: 1,
            inputRevision: selectedInput.revision,
            inputDigest: selectedInput.digest,
            ...(typeof payload.receipt === 'string' ? { receipt: payload.receipt } : {}),
          },
        })
        block = result.content.find(value => value.type === 'text')
        if (!block || block.type !== 'text') throw new Error('advisor broker omitted poll result')
        payload = JSON.parse(block.text) as Record<string, unknown>
      }
      return { result, payload }
    },
    async close() {
      try { await client.close() } finally {
        store.close()
        socket.stop(true)
      }
    },
  }
}

describe('advisor broker boundaries', () => {
  test('Claude認証preflightへOSユーザー文脈を渡しAPI credentialは継承しない', async () => {
    const root = fixtureDir()
    const fakeClaude = join(root, 'claude')
    writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ -n "${USER:-}" ] && [ "$USER" = "${LOGNAME:-}" ] && [ -n "${SHELL:-}" ] && [ -n "${TMPDIR:-}" ]; then',
      '  printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\'',
      'else',
      '  printf \'%s\\n\' \'{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","subscriptionType":null}\'',
      'fi',
      '',
    ].join('\n'), { mode: 0o700 })

    const environment = {
      ...brokerEnvironment(),
      ZEROKUN_CLAUDE_BIN_PATH: fakeClaude,
    }
    expect(environment.USER).toBe(environment.LOGNAME)
    expect(environment.USER).not.toBe('')
    expect(environment.SHELL).not.toBe('')
    expect(environment.TMPDIR).not.toBe('')
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
    expect(environment.XAI_API_KEY).toBeUndefined()
    await expect(assertClaudeSubscriptionLogin(environment)).resolves.toBeUndefined()

    const missingUserContext = { ...environment }
    delete missingUserContext.USER
    delete missingUserContext.LOGNAME
    delete missingUserContext.SHELL
    delete missingUserContext.TMPDIR
    await expect(assertClaudeSubscriptionLogin(missingUserContext)).rejects.toThrow(
      'first-party subscription',
    )
  })

  test('Claudeはfirst-party subscription statusだけを実行時に受理する', () => {
    expect(claudeSubscriptionStatusIsReady({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'max',
    })).toBe(true)
    for (const invalid of [
      { loggedIn: false, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' },
      { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', subscriptionType: 'api' },
      { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'thirdParty', subscriptionType: 'max' },
      { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: '' },
    ]) expect(claudeSubscriptionStatusIsReady(invalid)).toBe(false)
  })

  test('prompt-startedのexact markerだけを送達可能として分類する', () => {
    const marker = 'REQUEST_MARKER=' + 'A'.repeat(32)
    expect(parseFifthAdvisorSendOutcome([
      JSON.stringify({ status: 'prompt-started', marker }),
      JSON.stringify({ status: 'prompt-command-rejected' }),
    ].join('\n'))).toEqual({ kind: 'possibly-delivered', marker })
    expect(parseFifthAdvisorSendOutcome([
      JSON.stringify({ status: 'prompt-started', marker }),
      JSON.stringify({ status: 'prompt-command-timeout-or-error' }),
    ].join('\n'))).toEqual({ kind: 'possibly-delivered', marker })
    expect(parseFifthAdvisorSendOutcome(
      JSON.stringify({ status: 'prompt-command-rejected' }),
    )).toEqual({ kind: 'unconfirmed' })
    expect(parseFifthAdvisorSendOutcome([
      JSON.stringify({ status: 'prompt-started', marker }),
      JSON.stringify({ status: 'prompt-started', marker }),
    ].join('\n'))).toEqual({ kind: 'unconfirmed' })
    expect(parseFifthAdvisorSendOutcome(
      JSON.stringify({ status: 'prompt-started', marker: 'REQUEST_MARKER=bad' }),
    )).toEqual({ kind: 'unconfirmed' })
  })

  test('reviewer promptはstdinだけで渡しprocess argvへ載せない', async () => {
    const confidential = 'SLACK-CONFIDENTIAL-ARGV-SENTINEL'
    const result = await runBounded([
      '/usr/bin/python3', '-c',
      'import json,sys; print(json.dumps({"argv":sys.argv[1:],"stdin":sys.stdin.read()}))',
      'fixed-argument',
    ], {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      stdin: confidential,
    })
    expect(result.exitCode).toBe(0)
    const observed = JSON.parse(result.stdout) as { argv: string[]; stdin: string }
    expect(observed).toEqual({ argv: ['fixed-argument'], stdin: confidential })
    expect(observed.argv.join(' ')).not.toContain(confidential)
  })

  test('全reviewer transportは共通2MiB byte境界を使う', async () => {
    const exact = new Uint8Array(MAX_ADVISOR_PROMPT_BYTES)
    const result = await runBounded([
      '/usr/bin/python3', '-c', 'import sys; print(len(sys.stdin.buffer.read()))',
    ], { cwd: '/', env: { PATH: '/usr/bin:/bin' }, stdin: exact })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(String(MAX_ADVISOR_PROMPT_BYTES))
    await expect(runBounded([
      '/usr/bin/python3', '-c', 'import sys; sys.stdin.buffer.read()',
    ], {
      cwd: '/', env: { PATH: '/usr/bin:/bin' },
      stdin: new Uint8Array(MAX_ADVISOR_PROMPT_BYTES + 1),
    })).rejects.toThrow('shared transport byte limit')
  })

  test('reviewer processはwhole-job deadlineなしで自然終了まで待つ', async () => {
    const startedAt = Date.now()
    const result = await runBounded([
      '/bin/sh', '-c', '/bin/sleep 0.15; printf completed',
    ], {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toBe('completed')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
  })

  test.skipIf(process.platform === 'win32')(
    'reviewer正常回答後のTERM無視子をforce回収した事実を成功として隠さない',
    async () => {
      const dir = fixtureDir()
      const script = join(dir, 'forced-descendant.py')
      const pidFile = join(dir, 'descendant.pid')
      writeFileSync(script, `import os, signal, time
child = os.fork()
if child == 0:
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    devnull = os.open('/dev/null', os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    while True:
        time.sleep(30)
with open(os.environ['DESCENDANT_PID_FILE'], 'w', encoding='utf-8') as stream:
    stream.write(str(child))
time.sleep(0.3)
print('review complete')
`)
      chmodSync(script, 0o700)
      const result = await runBounded(['/usr/bin/python3', script], {
        env: { PATH: '/usr/bin:/bin', DESCENDANT_PID_FILE: pidFile },
        terminationGraceMs: 100,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('review complete')
      expect(result.timedOut).toBe(false)
      expect(result.forcedCleanup).toBe(true)
      expect(readProcessIdentity(Number(readFileSync(pidFile, 'utf8')))).toBeUndefined()
    },
    5_000,
  )

  test('reviewer出力がmanaged上限を超えた事実を黙って採択しない', async () => {
    const exact = await runBounded([
      '/usr/bin/python3', '-c', 'import sys; sys.stdout.write("x" * 262144)',
    ], { cwd: '/', env: { PATH: '/usr/bin:/bin' } })
    expect(exact.exitCode).toBe(0)
    expect(exact.outputTruncated).toBe(false)
    expect(Buffer.byteLength(exact.stdout)).toBe(256 * 1024)
    const result = await runBounded([
      '/usr/bin/python3', '-c', 'import sys; sys.stdout.write("x" * 262145)',
    ], { cwd: '/', env: { PATH: '/usr/bin:/bin' } })
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.outputTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBe(256 * 1024)
  })

  test('terminal reviewer結果はexact receiptまたは同一bindingの次pollでcompletedになる', () => {
    const token = 'a'.repeat(64)
    const base = { status: 'reviewers-completed', finishedAt: 100 }
    const issued = advanceAdvisorReceipt(base, undefined, 101, () => token)
    expect(issued).toMatchObject({
      kind: 'issued', receipt: token,
      journal: { status: 'reviewers-completed', receiptIssuedAt: 101, receipt: token },
    })
    if (issued.kind !== 'issued') throw new Error('receipt was not issued')
    expect(advanceAdvisorReceipt(issued.journal, 'b'.repeat(64), 102)).toEqual({ kind: 'invalid' })
    const completed = advanceAdvisorReceipt(issued.journal, token, 102)
    expect(completed).toMatchObject({
      kind: 'completed', pollObservedAt: 102,
      journal: {
        status: 'completed',
        receiptIssuedAt: 101,
        receiptAcknowledgement: 'exact-echo',
        pollObservedAt: 102,
      },
    })
    if (completed.kind !== 'completed') throw new Error('receipt was not acknowledged')
    expect(completed.journal.receipt).toBeUndefined()
    expect(completed.journal.receiptDigest).toMatch(/^[0-9a-f]{64}$/)
    const duplicatePoll = advanceAdvisorReceipt(issued.journal, undefined, 103)
    expect(duplicatePoll).toMatchObject({
      kind: 'completed',
      journal: {
        status: 'completed',
        receiptAcknowledgement: 'bound-repoll',
        pollObservedAt: 103,
      },
    })
  })

  test('receipt challengeは大型advisor回答を再掲せず単発ackを指示する', () => {
    const challenge = advisorReceiptChallenge({
      phase: 'investigation',
      round: 1,
      inputRevision: 2,
      inputDigest: 'd'.repeat(64),
      receipt: 'e'.repeat(64),
    })
    expect(challenge).toEqual({
      complete: false,
      receiptRequired: true,
      phase: 'investigation',
      round: 1,
      inputRevision: 2,
      inputDigest: 'd'.repeat(64),
      receipt: 'e'.repeat(64),
      nextAction: 'Call advisor_round_poll exactly once with this receipt and the same binding; do not batch or parallelize polls.',
    })
    expect(challenge.grok).toBeUndefined()
    expect(challenge.claude).toBeUndefined()
    expect(challenge.allAdopted).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(challenge))).toBeLessThan(1024)
  })

  test('completed後の重複pollは大型advisor回答を再掲しない', () => {
    const observed = advisorReceiptAlreadyObserved({
      phase: 'investigation',
      round: 1,
      inputRevision: 2,
      inputDigest: 'f'.repeat(64),
      pollObservedAt: 123,
    })
    expect(observed).toEqual({
      complete: true,
      alreadyObserved: true,
      phase: 'investigation',
      round: 1,
      inputRevision: 2,
      inputDigest: 'f'.repeat(64),
      pollObservedAt: 123,
    })
    expect(observed.grok).toBeUndefined()
    expect(observed.claude).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(observed))).toBeLessThan(1024)
  })

  test('別ユーザーの同一thread追記で旧revisionになったnative調査をstale journalへ固定する', async () => {
    const fixture = await brokerFixture()
    try {
      const { result, payload } = await fixture.call()
      expect(result.isError).toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        staleInput: true,
        journaledStaleInput: true,
        inputRevision: fixture.revisionOne.revision,
        inputDigest: fixture.revisionOne.digest,
        currentInputRevision: fixture.revisionTwo.revision,
        currentInputDigest: fixture.revisionTwo.digest,
      })
      const path = join(
        fixture.journalRoot,
        `revision-${fixture.revisionOne.revision}-${fixture.revisionOne.digest.slice(0, 16)}`,
        'investigation-1.json',
      )
      const journal = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      expect(journal).toMatchObject({
        version: 7,
        status: 'stale-input',
        inputRevision: fixture.revisionOne.revision,
        inputDigest: fixture.revisionOne.digest,
      })
      expect(journal.grok).toEqual([])
      expect(journal.claude).toMatchObject({ attempted: false, adopted: false })
      expect((journal.native as Array<Record<string, unknown>>).every(entry => (
        typeof entry.responseTransportDigest === 'string'
        && /^[0-9a-f]{64}$/.test(entry.responseTransportDigest)
      ))).toBe(true)
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('read-only jobのstale designはphase検証で拒否してjournalを作らない', async () => {
    const fixture = await brokerFixture()
    try {
      const { result, payload } = await fixture.call('design')
      expect(result.isError).toBe(true)
      expect(payload).toMatchObject({ complete: false, reason: 'phase design is not required for this job' })
      expect(readdirSync(fixture.journalRoot)).toEqual([])
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('初回入力がrevision 2でもpre-edit advisor pair前のrepository変更を拒否する', async () => {
    const fixture = await brokerFixture()
    try {
      writeFileSync(join(fixture.repo, 'README.md'), 'edited before investigation\n', { mode: 0o600 })
      const { result, payload } = await fixture.call('investigation', 'revision-two')
      expect(result.isError).toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        reason: 'the first investigation/design pair must complete before repository changes',
      })
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('active round中のstale入力は二重journal化せずuncertainで閉じる', async () => {
    const fixture = await brokerFixture()
    try {
      writeFileSync(join(fixture.journalRoot, 'active-round.lock'), 'occupied\n', { mode: 0o600 })
      const { result, payload } = await fixture.call()
      expect(result.isError).toBe(true)
      expect(payload).toMatchObject({
        complete: false,
        uncertain: true,
        reason: 'another advisor round is already active for this attempt',
      })
      expect(readdirSync(fixture.journalRoot)).toEqual(['active-round.lock'])
    } finally {
      await fixture.close()
    }
  }, 15_000)

  test('Claudeは末尾が完全一致の空promptだけreadyと判定する', () => {
    expect(emptyClaudePrompt('previous output\n❯\n')).toBe(true)
    expect(emptyClaudePrompt('previous output\n❯ typed draft\n')).toBe(false)
    expect(emptyClaudePrompt('How is Claude doing this session?\n0: Dismiss\n❯')).toBe(false)
    expect(emptyClaudePrompt('Allow this action\n❯')).toBe(false)
  })

  test('Herdr agent readのJSON envelopeをpane本文へ展開する', () => {
    const content = 'previous output\n❯\n⏵⏵ bypass permissions on'
    expect(decodeHerdrReadOutput(JSON.stringify({ result: { content } }))).toBe(content)
    expect(emptyClaudePrompt(decodeHerdrReadOutput(JSON.stringify({
      result: { content },
    })))).toBe(true)
  })

  test('Claude回答はprompt echoと最終独立markerの完全envelopeだけを採択する', () => {
    const marker = 'REQUEST_MARKER=0123456789ABCDEF0123456789ABCDEF'
    expect(extractCompleteClaudeResponse([
      '依頼本文',
      '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      marker,
      '独立したレビュー結果です。',
      '二行目です。',
      marker,
      '❯',
      '⏵⏵ bypass permissions on',
    ].join('\n'), marker)).toBe('独立したレビュー結果です。\n二行目です。')

    expect(extractCompleteClaudeResponse([
      '依頼本文',
      '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      marker,
      `本文中に ${marker} を含めます。`,
      marker,
      '❯',
    ].join('\n'), marker)).toBeNull()

    expect(extractCompleteClaudeResponse([
      '依頼本文',
      '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      marker,
      '途中回答です。',
      marker,
      'marker後にも回答を続けます。',
    ].join('\n'), marker)).toBeNull()

    expect(extractCompleteClaudeResponse([
      '依頼本文',
      '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      marker,
      '最終markerがありません。',
    ].join('\n'), marker)).toBeNull()

    expect(extractCompleteClaudeResponse([
      '依頼本文',
      marker,
      '回答内だけにmarkerが二つあります。',
      marker,
      '❯',
    ].join('\n'), marker)).toBeNull()

    for (const continuation of ['· continuation', '✻ continuation']) {
      expect(extractCompleteClaudeResponse([
        '依頼本文',
        '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
        marker,
        '回答です。',
        marker,
        continuation,
      ].join('\n'), marker)).toBeNull()
    }
  })

  test('Claude 2.1.246以降の固定bypass footerだけを既知chromeとして採択する', () => {
    const marker = 'REQUEST_MARKER=0123456789ABCDEF0123456789ABCDEF'
    const instruction = '応答の最後の独立行に、次のrequest markerをそのまま記載してください。'
    const response = '独立したレビュー結果です。'
    const envelope = (...footer: string[]) => [
      '依頼本文',
      instruction,
      marker,
      response,
      marker,
      '❯',
      ...footer,
    ].join('\n')

    for (const footer of [
      '⏵⏵ bypass permissions on',
      '⏵⏵ bypass permissions on · /rc',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · /rc',
      `⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents${' '.repeat(96)}/rc`,
    ]) {
      expect(extractCompleteClaudeResponse(envelope(footer), marker)).toBe(response)
    }

    for (const footer of [
      '⏵⏵ bypass permissions on (shift+tab to toggle) · /rc',
      '⏵⏵ bypass permissions on (shift＋tab to cycle) · /rc',
      '⏵⏵ bypass permissions on (shift+tab to cycle · /rc',
      '⏵⏵ bypass permissions on [shift+tab to cycle] · /rc',
      '⏵⏵ bypass permissions on (shift+tab to cycle) /rc',
      '⏵⏵ bypass permissions on (shift+tab to cycle) extra',
      '⏵⏵ bypass permissions off (shift+tab to cycle) · /rc',
      '⏵⏵ bypass permissions on · marker後にも回答を続けます。',
      'Allow this action',
      'Do you want to proceed',
      '/rc',
    ]) {
      expect(extractCompleteClaudeResponse(envelope(footer), marker)).toBeNull()
    }

    expect(extractCompleteClaudeResponse(envelope(
      '⏵⏵ bypass permissions on (shift+tab to cycle) ·',
      '/rc',
    ), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope(
      'marker後にも回答を続けます。',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · /rc',
    ), marker)).toBeNull()
  })

  test('Claude 2.1.247の狭幅固定bypass footerだけを既知chromeとして採択する', () => {
    const marker = 'REQUEST_MARKER=ABCDEF0123456789ABCDEF0123456789'
    const instruction = '応答の最後の独立行に、次のrequest markerをそのまま記載してください。'
    const response = '独立したレビュー結果です。'
    const clippedFooter = `\u23F5\u23F5 bypass permissions on (shift+tab to${'\u0020'.repeat(5)}\u00B7`
    const envelope = (...chrome: string[]) => [
      '依頼本文',
      instruction,
      marker,
      response,
      marker,
      ...chrome,
    ].join('\n')

    expect(extractCompleteClaudeResponse(envelope(
      '✻ Churned for 22s · done 14:22',
      '────────────────',
      '❯',
      '────────────────',
      `${clippedFooter}   `,
    ), marker)).toBe(response)

    for (const footer of [
      `\u23F5\u23F5 bypass permissions on (shift+tab to${'\u0020'.repeat(4)}\u00B7`,
      `\u23F5\u23F5 bypass permissions on (shift+tab to${'\u0020'.repeat(6)}\u00B7`,
      '\u23F5\u23F5 bypass permissions on (shift+tab to\t\t\u00B7',
      `\u23F5\u23F5 bypass permissions on (shift+tab to${'\u00A0'.repeat(5)}\u00B7`,
      `\u23F5\u23F5 bypass permissions on (shift+tab to${'\u0020'.repeat(5)}\u2022`,
      '\u23F5\u23F5 bypass permissions on (shift+tab to',
      `\u23F5\u23F5 bypass permissions on (shift+tab${'\u0020'.repeat(5)}\u00B7`,
      `\u23F5\u23F5 bypass permissions on (shift+tab to cycle)${'\u0020'.repeat(5)}\u00B7`,
      `${clippedFooter} /rc`,
      `${clippedFooter} marker後にも回答を続けます。`,
      `\u23F5\u23F5 bypass permissions off (shift+tab to${'\u0020'.repeat(5)}\u00B7`,
    ]) {
      expect(extractCompleteClaudeResponse(envelope(footer), marker)).toBeNull()
    }

    expect(extractCompleteClaudeResponse(envelope(
      clippedFooter,
      'marker後にも回答を続けます。',
    ), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope(
      'marker後にも回答を続けます。',
      clippedFooter,
    ), marker)).toBeNull()
  })

  test('Claude 2.1.247の更新案内付き固定footerを二行のterminal chromeとして採択する', () => {
    const marker = 'REQUEST_MARKER=FEDCBA9876543210FEDCBA9876543210'
    const response = '独立したレビュー結果です。'
    const updateFooter = `⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents${' '.repeat(24)}✔ Update installed · Restart to update`
    const envelope = (...footer: string[]) => [
      '依頼本文',
      '応答の最後の独立行に、次のrequest markerをそのまま記載してください。',
      marker,
      response,
      marker,
      '✻ Crunched for 18s · done 7:18',
      '────────────────',
      '❯',
      '────────────────',
      ...footer,
    ].join('\n')

    expect(extractCompleteClaudeResponse(envelope(updateFooter, '/rc'), marker)).toBe(response)
    expect(extractCompleteClaudeResponse(envelope(updateFooter), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope(updateFooter, '/clear'), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope(
      updateFooter.replace('Restart to update', 'Click to update'),
      '/rc',
    ), marker)).toBeNull()
  })

  test('Claude 2.1.247の実測狭幅prompt echoだけを固定envelopeとして採択する', () => {
    const marker = 'REQUEST_MARKER=3CC556E85A172CDBDF0101C7C293A2F6'
    const instruction = '応答の最後の独立行に、次のrequest markerをそのまま記載してください。'
    const instructionHead = '応答の最後の独立行に、次のrequest'
    const instructionTail = 'markerをそのまま記載してください。'
    const markerHead = marker.slice(0, -1)
    const markerTail = marker.slice(-1)
    const response = '独立したレビュー結果です。\n二行目です。'
    const clippedFooter = `\u23F5\u23F5 bypass permissions on (shift+tab to${'\u0020'.repeat(5)}\u00B7`
    const chrome = [
      '✻ Baked for 25s · done 15:05',
      '────────────────',
      '❯',
      '────────────────',
      clippedFooter,
    ]
    const wrappedPrompt = [instructionHead, instructionTail, markerHead, markerTail]
    const envelope = ({
      prompt = wrappedPrompt,
      body = response.split('\n'),
      final = [marker],
      tail = chrome,
    }: {
      prompt?: string[]
      body?: string[]
      final?: string[]
      tail?: string[]
    } = {}) => ['依頼本文', ...prompt, ...body, ...final, ...tail].join('\n')

    expect(`${instructionHead} ${instructionTail}`).toBe(instruction)
    expect(markerHead.length).toBe(marker.length - 1)
    expect(markerTail.length).toBe(1)
    expect(extractCompleteClaudeResponse(envelope(), marker)).toBe(response)
    expect(extractCompleteClaudeResponse(envelope().replaceAll('\n', '\r\n'), marker))
      .toBe(response)

    for (const prompt of [
      [instructionHead, instructionTail, marker.slice(0, -2), marker.slice(-2)],
      [instructionHead, instructionTail, marker.slice(0, 20), marker.slice(20)],
      [instructionHead, instructionTail, markerHead, '', markerTail],
      [instructionHead, instructionTail, `${markerHead}X`, markerTail],
      [instructionHead, instructionTail, markerHead, `${markerTail}X`],
      [`${instructionHead}X`, instructionTail, markerHead, markerTail],
      [instructionHead, `${instructionTail}X`, markerHead, markerTail],
      [instructionTail, instructionHead, markerHead, markerTail],
    ]) {
      expect(extractCompleteClaudeResponse(envelope({ prompt }), marker)).toBeNull()
    }

    expect(extractCompleteClaudeResponse(envelope({
      prompt: [instructionHead, instructionTail, marker],
    }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({
      prompt: [instruction, markerHead, markerTail],
    }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({
      final: [markerHead, markerTail],
    }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({ body: [] }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({
      body: [response, markerHead, markerTail],
    }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({
      body: [`本文中に ${marker} を含めます。`],
    }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({
      prompt: [...wrappedPrompt, ...wrappedPrompt],
    }), marker)).toBeNull()
    expect(extractCompleteClaudeResponse(envelope({ tail: ['marker後にも回答を続けます。'] }), marker))
      .toBeNull()
    expect(extractCompleteClaudeResponse([
      '依頼本文', instruction, marker, response, markerHead, markerTail, marker, ...chrome,
    ].join('\n'), marker)).toBeNull()

    const nonProductionMarker = 'NOT_A_PRODUCTION_MARKER'
    expect(extractCompleteClaudeResponse([
      '依頼本文',
      instructionHead,
      instructionTail,
      nonProductionMarker.slice(0, -1),
      nonProductionMarker.slice(-1),
      response,
      nonProductionMarker,
      ...chrome,
    ].join('\n'), nonProductionMarker)).toBeNull()
  })

  test('Claude 2.1.247の固定done clockだけをactivity chromeとして採択する', () => {
    const marker = 'REQUEST_MARKER=FEDCBA9876543210FEDCBA9876543210'
    const instruction = '応答の最後の独立行に、次のrequest markerをそのまま記載してください。'
    const response = '独立したレビュー結果です。'
    const envelope = (...chrome: string[]) => [
      '依頼本文',
      instruction,
      marker,
      response,
      marker,
      ...chrome,
      '────────────────',
      '❯',
      '────────────────',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · /rc',
    ].join('\n')

    for (const activity of [
      '✻ Churned for 23s',
      '✻ Churned for 23s · done 12:26',
      '✻ Worked for 1m 5s · done 09:05',
      '✻ Worked for 3m 0s · done 12:40',
      '✻ Worked for 1h 2m 3s · done 9:05',
      '✻ Worked for 1h 0m 0s · done 12:40',
      '✻ Baked for 1d 0h 0m · done 13:27',
      '✻ Brewed for 1s · done 13:27',
      '✻ Cogitated for 1s · done 13:27',
      '✻ Cooked for 1s · done 13:27',
      '✻ Crunched for 1s · done 13:27',
      '✻ Sautéed for 5m 45s · done 13:27',
      '✳ Worked for 1s · done 0:00',
      '✢ Worked for 1s · done 23:59',
    ]) {
      expect(extractCompleteClaudeResponse(envelope(activity), marker)).toBe(response)
    }

    for (const activity of [
      '✻ Churned for 23s · esc to interrupt',
      '✻ Churned for 23s · done',
      '✻ Churned for 23s · Done 12:26',
      '✻ Churned for 23s · done 24:00',
      '✻ Churned for 23s · done 12:60',
      '✻ Churned for 23s · done 12:6',
      '✻ Churned for 23s · done 12:26:00',
      '✻ Churned for 23s · done 12:26 PM',
      '✻ Churned for 23s · done 12:26 extra',
      '✻ Churned for 0s · done 12:26',
      '✻ Worked for 0m 5s · done 12:26',
      '✻ Worked for 1m 00s · done 12:26',
      '✻ Worked for 3m 60s · done 12:26',
      '✻ Worked for 1h 60m 0s · done 12:26',
      '✻ Worked for 1h 00m 0s · done 12:26',
      '✻ Worked for 60s · done 12:26',
      '✻ Worked for 60m 0s · done 12:26',
      '✻ Worked for 1h 5s · done 12:26',
      '✻ Worked for 24h 0m 0s · done 12:26',
      '✻ Worked for 1d 24h 0m · done 12:26',
      '✻ Worked for 1d 0h 60m · done 12:26',
      '✻ Worked for 1d 0h 0m 0s · done 12:26',
      '✻ continuation for 1s · done 12:26',
      '✻ Wait for 5s · done 12:26',
      '✻ Churning for 23s · done 12:26',
      '✻ Braised for 1s · done 12:26',
      '✻ continuation for 1s',
      '✻ Wait for 5s',
      '✻ Churning for 23s',
      '✻ Worked for 1s',
      '✳ Churned for 23s',
      '✻ Churned for 24s',
      '✔ Churned for 23s · done 12:26',
      '· done 12:26',
    ]) {
      expect(extractCompleteClaudeResponse(envelope(activity), marker)).toBeNull()
    }

    expect(extractCompleteClaudeResponse(envelope(
      '✻ Churned for 23s · done 12:26',
      'marker後にも回答を続けます。',
    ), marker)).toBeNull()
  })

  test('同一roundのexclusive claimは重複作成できずidentity一致時だけ解放する', () => {
    const dir = fixtureDir()
    const path = join(dir, 'active.lock')
    const identity = createExclusivePrivateFile(path, 'first\n')
    expect(identity).not.toBeNull()
    expect(createExclusivePrivateFile(path, 'second\n')).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('first\n')
    releaseExclusivePrivateFile(path, identity!)
    expect(existsSync(path)).toBe(false)
  })

  test.skipIf(process.platform === 'win32')(
    'direct child終了後にdetached descendantがpipeを保持してもboundedに戻る',
    async () => {
      const dir = fixtureDir()
      const script = join(dir, 'pipe-holder.py')
      const pidFile = join(dir, 'child.pid')
      mkdirSync(dir, { recursive: true })
      writeFileSync(script, `import os, time
child = os.fork()
if child == 0:
    os.setsid()
    time.sleep(30)
    os._exit(0)
with open(os.environ['CHILD_PID_FILE'], 'w', encoding='utf-8') as handle:
    handle.write(str(child))
os._exit(0)
`)
      chmodSync(script, 0o700)
      const started = Date.now()
      let childIdentity: ReturnType<typeof readProcessIdentity>
      try {
        const result = await runBounded(['/usr/bin/python3', script], {
          env: { PATH: '/usr/bin:/bin', CHILD_PID_FILE: pidFile },
          timeoutMs: 500,
        })
        expect(result.timedOut).toBe(true)
        expect(Date.now() - started).toBeLessThan(5_000)
        childIdentity = readProcessIdentity(Number(readFileSync(pidFile, 'utf8')))
      } finally {
        if (existsSync(pidFile)) {
          childIdentity = readProcessIdentity(Number(readFileSync(pidFile, 'utf8')))
          if (childIdentity) signalProcessIfLive(childIdentity, 'SIGKILL')
        }
      }
    },
    8_000,
  )

  test.skipIf(process.platform === 'win32')(
    'outer timeoutでもGrok supervisorがsignalを子へ届けprocess groupとrun auth領域を回収する',
    async () => {
      const dir = fixtureDir()
      chmodSync(dir, 0o700)
      const reviewerRoot = join(dir, 'reviewer')
      const runRoot = join(reviewerRoot, 'run.fixture')
      const script = join(dir, 'signal-tree.c')
      const pidFile = join(dir, 'tree.pids')
      const termFile = join(dir, 'term.received')
      mkdirSync(runRoot, { recursive: true, mode: 0o700 })
      chmodSync(reviewerRoot, 0o700)
      chmodSync(runRoot, 0o700)
      writeFileSync(join(runRoot, 'owner.pid'), `${process.pid}\n`, { mode: 0o600 })
      const pinnedProgram = join(runRoot, 'official-grok')
      writeFileSync(script, String.raw`
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static void handled(int signum) {
  (void)signum;
  const char *path = getenv("TERM_FILE");
  if (!path) return;
  int descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (descriptor >= 0) {
    (void)write(descriptor, "received\n", 9);
    close(descriptor);
  }
}

int main(void) {
  signal(SIGTERM, handled);
  pid_t child = fork();
  if (child < 0) return 91;
  if (child == 0) for (;;) pause();
  const char *pid_path = getenv("PID_FILE");
  FILE *output = pid_path ? fopen(pid_path, "w") : NULL;
  if (!output) return 92;
  fprintf(output, "%d %d\n", getpid(), child);
  fclose(output);
  for (;;) pause();
}
`)
      const compiled = Bun.spawnSync(['/usr/bin/cc', '-Os', '-o', pinnedProgram, script], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      })
      expect(compiled.exitCode, compiled.stderr.toString()).toBe(0)
      chmodSync(pinnedProgram, 0o700)
      const runtime = join(import.meta.dir, 'grok-reviewer', 'reviewer-runtime.py')
      const started = Date.now()
      const result = await runBounded([
        '/usr/bin/python3', '-I', runtime, 'run', reviewerRoot, runRoot, '--',
        realpathSync(pinnedProgram),
      ], {
        env: {
          PATH: '/usr/bin:/bin',
          PID_FILE: pidFile,
          TERM_FILE: termFile,
        },
        timeoutMs: 1_000,
        terminationGraceMs: 5_000,
      })
      expect(result.timedOut, JSON.stringify(result)).toBe(true)
      expect(Date.now() - started).toBeLessThan(6_500)
      expect(readFileSync(termFile, 'utf8')).toBe('received\n')
      const pids = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number)
      expect(pids).toHaveLength(2)
      for (const pid of pids) expect(readProcessIdentity(pid)).toBeUndefined()
      expect(existsSync(runRoot)).toBe(false)
      expect(readdirSync(reviewerRoot).filter(name => name.startsWith('run.'))).toEqual([])
    },
    8_000,
  )
})
