const decoder = new TextDecoder()

const DEFAULT_TMUX_COMMAND_TIMEOUT_MS = 4_000
const TMUX_COMMAND_OUTPUT_LIMIT = 1024 * 1024

export interface TmuxCommandResult {
  exitCode: number | null
  signalCode: string | null
  stdout: string
  stderr: string
}

function tmuxFailure(result: TmuxCommandResult, operation: string): Error {
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n')
  const outcome = result.signalCode
    ? `signal ${result.signalCode}`
    : `exit ${String(result.exitCode)}`
  return new Error(`tmux ${operation}に失敗しました (${outcome})${detail ? `\n${detail}` : ''}`)
}

export function runTmuxCommand(
  tmux: string,
  args: string[],
  options: {
    capture?: boolean
    env?: Record<string, string | undefined>
    timeoutMs?: number
  } = {},
): TmuxCommandResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TMUX_COMMAND_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('tmux command timeoutが不正です')
  }
  const capture = options.capture === true
  const result = Bun.spawnSync([tmux, ...args], {
    env: options.env ?? process.env,
    stdin: 'ignore',
    // Detached tmux servers may briefly retain inherited descriptors. Commands
    // whose output is irrelevant must not wait for those descriptors to close.
    stdout: capture ? 'pipe' : 'ignore',
    stderr: capture ? 'pipe' : 'ignore',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: TMUX_COMMAND_OUTPUT_LIMIT,
  })
  return {
    exitCode: result.exitCode,
    signalCode: result.signalCode ?? null,
    stdout: result.stdout ? decoder.decode(result.stdout).trim() : '',
    stderr: result.stderr ? decoder.decode(result.stderr).trim() : '',
  }
}

export function requireTmuxCommand(
  tmux: string,
  args: string[],
  options: Parameters<typeof runTmuxCommand>[2] = {},
): string {
  const result = runTmuxCommand(tmux, args, options)
  if (result.exitCode !== 0) {
    throw tmuxFailure(result, args[0] ?? 'command')
  }
  return result.stdout
}

export function tmuxSessionExists(
  tmux: string,
  session: string,
  options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): boolean {
  const result = runTmuxCommand(tmux, ['has-session', '-t', session], {
    ...options,
    capture: true,
  })
  if (result.exitCode === 0) return true
  if (result.exitCode === 1 && result.signalCode === null) return false
  throw tmuxFailure(result, 'has-session')
}
