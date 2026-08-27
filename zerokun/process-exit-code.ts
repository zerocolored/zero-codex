import { constants } from 'os'

/** Normalize Bun subprocess exits, whose signalCode is a signal name on macOS. */
export function subprocessExitCode(
  exitCode: number | null | undefined,
  signalCode: number | string | null | undefined,
): number {
  if (Number.isInteger(exitCode) && Number(exitCode) >= 0 && Number(exitCode) <= 255) {
    return Number(exitCode)
  }
  const signalNumber = typeof signalCode === 'number'
    ? signalCode
    : typeof signalCode === 'string'
      ? (constants.signals as Record<string, number>)[signalCode]
      : undefined
  if (!Number.isInteger(signalNumber) || Number(signalNumber) < 1
    || Number(signalNumber) > 127) return 1
  return 128 + Number(signalNumber)
}
