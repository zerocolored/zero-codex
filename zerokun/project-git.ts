#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { lstatSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute } from 'path'

function candidateGitExecutable(input: string): string {
  if (!isAbsolute(input) || input.length > 1_024 || /[\r\n\0]/.test(input)) {
    throw new Error('candidate Git path is invalid')
  }
  let physical: string
  try {
    physical = realpathSync(input)
  } catch {
    throw new Error('candidate Git path is unavailable')
  }
  if (physical !== input || basename(physical) !== 'git') {
    throw new Error('candidate Git path is not physical')
  }
  const trustedBin = dirname(physical)
  const candidateRoot = dirname(trustedBin)
  const systemTemporary = realpathSync('/tmp')
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const executable = lstatSync(physical)
  const bin = lstatSync(trustedBin)
  const root = lstatSync(candidateRoot)
  const ownerMatches = (actual: number) => uid === undefined || actual === uid
  if (dirname(candidateRoot) !== systemTemporary
    || !/^zerokun-update-candidate-[A-Za-z0-9]+$/.test(basename(candidateRoot))
    || !root.isDirectory() || root.isSymbolicLink() || !ownerMatches(root.uid)
    || (root.mode & 0o777) !== 0o700
    || !bin.isDirectory() || bin.isSymbolicLink() || !ownerMatches(bin.uid)
    || (bin.mode & 0o777) !== 0o500
    || !executable.isFile() || executable.isSymbolicLink() || executable.nlink !== 1
    || !ownerMatches(executable.uid) || (executable.mode & 0o777) !== 0o500) {
    throw new Error('candidate Git staging identity is invalid')
  }
  return physical
}

export function projectGitExecutable(
  environment: Record<string, string | undefined> = process.env,
): string {
  const candidate = environment.ZERO_CODEX_CANDIDATE_GIT
  const candidateMode = environment.ZERO_CODEX_CANDIDATE_SANDBOX === '1'
    && environment.CODEX_SANDBOX === 'seatbelt'
  if (candidate === undefined && !candidateMode) return '/usr/bin/git'
  if (!candidate || !candidateMode) {
    throw new Error('candidate Git requires the verified Codex sandbox')
  }
  return candidateGitExecutable(candidate)
}
