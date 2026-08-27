import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SeatbeltFingerprint } from './seatbelt-fingerprint.ts'

const MAX_GENERATED_TYPE_BYTES = 4 * 1024 * 1024
const GENERATION_TIMEOUT_MS = 30_000

type CapabilityContract = {
  relativePath: string
  required: RegExp[]
}

const CAPABILITY_CONTRACTS: CapabilityContract[] = [
  {
    relativePath: 'InitializeResponse.ts',
    required: [
      /userAgent:\s*string/,
      /codexHome:\s*AbsolutePathBuf/,
      /platformFamily:\s*string/,
      /platformOs:\s*string/,
    ],
  },
  {
    relativePath: 'ClientRequest.ts',
    required: [
      /"method": "thread\/read"/,
      /"method": "thread\/list"/,
      /"method": "thread\/turns\/list"/,
      /"method": "thread\/items\/list"/,
      /"method": "thread\/start"/,
      /"method": "thread\/resume"/,
      /"method": "turn\/start"/,
      /"method": "turn\/steer"/,
      /"method": "turn\/interrupt"/,
    ],
  },
  {
    relativePath: 'v2/Thread.ts',
    required: [
      /parentThreadId:\s*string \| null/,
      /agentRole:\s*string \| null/,
      /cwd:\s*AbsolutePathBuf/,
      /modelProvider:\s*string/,
      /source:\s*SessionSource/,
      /turns:\s*Array<Turn>/,
      /status:\s*ThreadStatus/,
      /canAcceptDirectInput:\s*boolean \| null/,
    ],
  },
  {
    relativePath: 'v2/ThreadStatus.ts',
    required: [/"type": "idle"/, /"type": "active"/],
  },
  {
    relativePath: 'v2/ThreadStartParams.ts',
    required: [
      /cwd\?:\s*string \| null/,
      /approvalPolicy\?:\s*AskForApproval \| null/,
      /permissions\?:\s*string \| null/,
      /developerInstructions\?:\s*string \| null/,
    ],
  },
  {
    relativePath: 'v2/ThreadResumeParams.ts',
    required: [
      /threadId:\s*string/,
      /cwd\?:\s*string \| null/,
      /approvalPolicy\?:\s*AskForApproval \| null/,
      /permissions\?:\s*string \| null/,
      /developerInstructions\?:\s*string \| null/,
    ],
  },
  {
    relativePath: 'v2/ThreadListParams.ts',
    required: [
      /sourceKinds\?:\s*Array<ThreadSourceKind> \| null/,
      /parentThreadId\?:\s*string \| null/,
    ],
  },
  {
    relativePath: 'v2/ThreadSourceKind.ts',
    required: [
      /export type ThreadSourceKind = "cli" \| "vscode" \| "exec" \| "appServer" \| "subAgent" \| "subAgentReview" \| "subAgentCompact" \| "subAgentThreadSpawn" \| "subAgentOther" \| "unknown";/,
    ],
  },
  {
    relativePath: 'v2/ThreadListResponse.ts',
    required: [
      /data:\s*Array<Thread>/,
      /nextCursor:\s*string \| null/,
      /backwardsCursor:\s*string \| null/,
    ],
  },
  {
    relativePath: 'v2/ThreadItem.ts',
    required: [
      /"type": "userMessage"/,
      /clientId:\s*string \| null/,
      /content:\s*Array<UserInput>/,
      /"type": "agentMessage"/,
      /phase:\s*MessagePhase \| null/,
      /"type": "commandExecution"/,
      /command:\s*string/,
      /cwd:\s*LegacyAppPathString/,
      /source:\s*CommandExecutionSource/,
      /status:\s*CommandExecutionStatus/,
      /exitCode:\s*number \| null/,
      /"type": "subAgentActivity"/,
      /kind:\s*SubAgentActivityKind/,
      /agentThreadId:\s*string/,
    ],
  },
  {
    relativePath: 'MessagePhase.ts',
    required: [/"commentary"/, /"final_answer"/],
  },
  {
    relativePath: 'v2/SubAgentActivityKind.ts',
    required: [
      /export type SubAgentActivityKind = "started" \| "interacted" \| "interrupted" \| "completed";/,
    ],
  },
  {
    relativePath: 'v2/ThreadTurnsListParams.ts',
    required: [
      /threadId:\s*string/,
      /cursor\?:\s*string \| null/,
      /limit\?:\s*number \| null/,
      /sortDirection\?:\s*SortDirection \| null/,
      /itemsView\?:\s*TurnItemsView \| null/,
    ],
  },
  {
    relativePath: 'v2/ThreadTurnsListResponse.ts',
    required: [/data:\s*Array<Turn>/, /nextCursor:\s*string \| null/],
  },
  {
    relativePath: 'v2/ThreadItemsListResponse.ts',
    required: [/data:\s*Array<ThreadItemEntry>/, /nextCursor:\s*string \| null/],
  },
  {
    relativePath: 'v2/ThreadItemsListParams.ts',
    required: [
      /threadId:\s*string/,
      /turnId\?:\s*string \| null/,
      /cursor\?:\s*string \| null/,
      /limit\?:\s*number \| null/,
      /sortDirection\?:\s*SortDirection \| null/,
    ],
  },
  {
    relativePath: 'v2/CommandExecutionSource.ts',
    required: [/"agent"/, /"unifiedExecStartup"/, /"userShell"/],
  },
  {
    relativePath: 'v2/ErrorNotification.ts',
    required: [
      /error:\s*TurnError/,
      /willRetry:\s*boolean/,
      /threadId:\s*string/,
      /turnId:\s*string/,
    ],
  },
  {
    relativePath: 'v2/TurnStartParams.ts',
    required: [
      /threadId:\s*string/,
      /clientUserMessageId\?:\s*string \| null/,
      /input:\s*Array<UserInput>/,
      /cwd\?:\s*string \| null/,
      /approvalPolicy\?:\s*AskForApproval \| null/,
      /permissions\?:\s*string \| null/,
    ],
  },
  {
    relativePath: 'v2/TurnSteerParams.ts',
    required: [
      /threadId:\s*string/,
      /expectedTurnId:\s*string/,
      /input:\s*Array<UserInput>/,
      /clientUserMessageId\?:\s*string \| null/,
    ],
  },
  {
    relativePath: 'v2/TurnInterruptParams.ts',
    required: [/threadId:\s*string/, /turnId:\s*string/],
  },
  {
    relativePath: 'v2/TurnStartedNotification.ts',
    required: [/threadId:\s*string/, /turn:\s*Turn/],
  },
  {
    relativePath: 'v2/TurnCompletedNotification.ts',
    required: [/threadId:\s*string/, /turn:\s*Turn/],
  },
  {
    relativePath: 'v2/ItemStartedNotification.ts',
    required: [/threadId:\s*string/, /turnId:\s*string/, /item:\s*ThreadItem/],
  },
  {
    relativePath: 'v2/ItemCompletedNotification.ts',
    required: [/threadId:\s*string/, /turnId:\s*string/, /item:\s*ThreadItem/],
  },
  {
    relativePath: 'v2/Turn.ts',
    required: [
      /id:\s*string/,
      /status:\s*TurnStatus/,
      /itemsView:\s*TurnItemsView/,
      /items:\s*Array<ThreadItem>/,
      /error:\s*TurnError \| null/,
    ],
  },
  {
    relativePath: 'v2/ThreadStartResponse.ts',
    required: [
      /instructionSources:\s*Array<LegacyAppPathString>/,
      /activePermissionProfile:\s*ActivePermissionProfile \| null/,
      /approvalPolicy:\s*AskForApproval/,
      /cwd:\s*AbsolutePathBuf/,
      /thread:\s*Thread/,
      /model:\s*string/,
      /modelProvider:\s*string/,
    ],
  },
  {
    relativePath: 'v2/ThreadResumeResponse.ts',
    required: [
      /instructionSources:\s*Array<LegacyAppPathString>/,
      /activePermissionProfile:\s*ActivePermissionProfile \| null/,
      /approvalPolicy:\s*AskForApproval/,
      /cwd:\s*AbsolutePathBuf/,
      /thread:\s*Thread/,
      /model:\s*string/,
      /modelProvider:\s*string/,
    ],
  },
]

function readGeneratedType(root: string, relativePath: string): string {
  const path = join(root, ...relativePath.split('/'))
  const metadata = lstatSync(path, { bigint: true })
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
    || (typeof process.getuid === 'function' && metadata.uid !== BigInt(process.getuid()))
    || metadata.size < 1n || metadata.size > BigInt(MAX_GENERATED_TYPE_BYTES)) {
    throw new Error(`Codex App Server generated an unsafe type file: ${relativePath}`)
  }
  return readFileSync(path, 'utf8')
}

/** Verify only the protocol surface used by native-advisor publication evidence. */
export function assertCodexAppServerGeneratedCapabilities(outputDir: string): void {
  for (const contract of CAPABILITY_CONTRACTS) {
    const source = readGeneratedType(outputDir, contract.relativePath)
    for (const requirement of contract.required) {
      if (!requirement.test(source)) {
        throw new Error(
          `installed Codex App Server is missing Zeroちゃん capability `
          + `${contract.relativePath}:${requirement.source}`,
        )
      }
    }
  }
}

function capabilityEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const result: Record<string, string> = { NO_COLOR: '1' }
  const allowed = new Set([
    'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'CODEX_HOME',
  ])
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (allowed.has(key) || key.startsWith('LC_'))) result[key] = value
  }
  return result
}

/** Ask the pinned official binary for its current protocol, without auth or a model turn. */
export async function verifyCodexAppServerCapabilities(
  codexBin: string,
  environment: Record<string, string | undefined> = process.env,
  options: { seatbeltFingerprint?: SeatbeltFingerprint } = {},
): Promise<void> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'zerokun-app-server-schema-'))
  chmodSync(temporaryRoot, 0o700)
  const outputDir = join(temporaryRoot, 'types')
  mkdirSync(outputDir, { mode: 0o700 })
  const appServerCommand = [
    codexBin,
    'app-server',
    'generate-ts',
    '--experimental',
    '--out',
    outputDir,
  ]
  const command = options.seatbeltFingerprint
    ? [
      realpathSync('/usr/bin/sandbox-exec'),
      '-p', [
        '(version 1)',
        '(allow default)',
        `(deny file-read-data (literal ${JSON.stringify(options.seatbeltFingerprint.deny.path)}))`,
      ].join('\n'),
      ...appServerCommand,
    ]
    : appServerCommand
  const child = Bun.spawn(command, {
    env: capabilityEnvironment(environment),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const stdoutReader = child.stdout.getReader()
  const stderrReader = child.stderr.getReader()
  const collect = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    maximum: number,
  ): Promise<string> => {
    const chunks: Buffer[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > maximum) throw new Error('Codex App Server capability output exceeded its limit')
        chunks.push(Buffer.from(chunk.value))
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally {
      reader.releaseLock()
    }
  }
  const stdoutPromise = collect(stdoutReader, 64 * 1024)
  const stderrPromise = collect(stderrReader, 64 * 1024)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ kind: 'timeout' }>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), GENERATION_TIMEOUT_MS)
  })
  try {
    const outcome = await Promise.race([
      child.exited.then(exitCode => ({ kind: 'exit' as const, exitCode })),
      timeout,
    ])
    if (timer) clearTimeout(timer)
    if (outcome.kind === 'timeout') {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      const stopped = await Promise.race([
        child.exited.then(() => true, () => true),
        Bun.sleep(2_000).then(() => false),
      ])
      if (!stopped) throw new Error('Codex App Server capability process did not stop')
    }
    const streams = await Promise.race([
      Promise.all([stdoutPromise, stderrPromise]),
      Bun.sleep(2_000).then(() => null),
    ])
    if (!streams) {
      await Promise.allSettled([stdoutReader.cancel(), stderrReader.cancel()])
      await Promise.allSettled([stdoutPromise, stderrPromise])
      throw new Error('Codex App Server capability output remained open after process exit')
    }
    const [stdout, stderr] = streams
    if (timedOut) throw new Error('Codex App Server capability generation timed out')
    const exitCode = outcome.kind === 'exit' ? outcome.exitCode : await child.exited
    if (exitCode !== 0) {
      const detail = `${stderr}\n${stdout}`.trim().slice(-2048)
      throw new Error(
        `Codex App Server capability generation failed (${exitCode})${detail ? `: ${detail}` : ''}`,
      )
    }
    assertCodexAppServerGeneratedCapabilities(outputDir)
  } finally {
    if (timer) clearTimeout(timer)
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}
