#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { realpathSync } from 'fs'

// Keep this validator dependency-free: fresh-Mac bootstrap downloads it as a
// single reviewed file before it trusts or executes anything from an existing
// checkout.
const decoder = new TextDecoder()

function gitConfigOverrides(): string[] {
  return [
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'credential.helper=',
    'core.sshCommand=/usr/bin/false',
    'protocol.allow=never',
    'protocol.https.allow=always',
    'protocol.file.allow=never',
  ]
}

function git(repo: string, args: string[], allowExitOne = false): string {
  const result = Bun.spawnSync([
    '/usr/bin/git', ...gitConfigOverrides().flatMap(value => ['-c', value]), '-C', repo, ...args,
  ], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      SSH_ASKPASS: '/usr/bin/false',
      GIT_PAGER: 'cat',
    },
  })
  if (allowExitOne && result.exitCode === 1) return ''
  if (result.exitCode !== 0) {
    throw new Error(decoder.decode(result.stderr).trim() || `git ${args.join(' ')} failed`)
  }
  return decoder.decode(result.stdout).trim()
}

function values(repo: string, key: string): string[] {
  return git(repo, ['config', '--local', '--no-includes', '--null', '--get-all', key], true)
    .split('\0').filter(Boolean)
}

function requireOnly(repo: string, key: string, expected: string): void {
  const actual = values(repo, key)
  if (actual.length !== 1 || actual[0] !== expected) {
    throw new Error(`local Git config is unsafe: ${key}`)
  }
}

function validateLocalConfig(repo: string, branch: string): void {
  const entries = git(repo, ['config', '--local', '--no-includes', '--null', '--list'])
    .split('\0').filter(Boolean)
  const allow = [
    /^core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)$/i,
    /^remote\.origin\.(?:url|fetch)$/i,
    /^branch\..+\.(?:remote|merge)$/i,
    /^user\.(?:name|email)$/i,
  ]
  for (const entry of entries) {
    const key = entry.split(/\n|=/, 1)[0] ?? ''
    if (!allow.some(pattern => pattern.test(key))) {
      throw new Error(`local Git config contains disallowed key: ${key}`)
    }
  }
  requireOnly(repo, 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
  // Bootstrap/update commands use an explicit origin and target ref. An
  // unrelated feature branch may safely track a differently named base branch.
  // Its inert tracking metadata must not prevent validating the target branch.
  const hasTargetTracking = values(repo, `branch.${branch}.remote`).length > 0
    || values(repo, `branch.${branch}.merge`).length > 0
  if (hasTargetTracking) {
    requireOnly(repo, `branch.${branch}.remote`, 'origin')
    requireOnly(repo, `branch.${branch}.merge`, `refs/heads/${branch}`)
  }
}

const [path, branch = 'main'] = process.argv.slice(2)
if (!path) throw new Error('usage: validate-update-repo.ts REPOSITORY [BRANCH]')
const repo = realpathSync(path)
validateLocalConfig(repo, branch)
const origin = git(repo, ['remote', 'get-url', 'origin'])
if (origin !== 'https://github.com/zerocolored/zero-codex.git'
  && origin !== 'https://github.com/zerocolored/zero-codex') {
  throw new Error(`origin is not the public Codex HTTPS URL: ${origin}`)
}
