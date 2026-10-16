#!/usr/bin/env -S bun --config=/dev/null --no-env-file
import { auditCredentialState, readAuditCredential, saveAuditCredential } from './security-audit-credentials.ts'
import { loadAuditSettings, saveAuditSettings } from './security-audit-setup.ts'
import { realpathSync } from 'fs'
import { join } from 'path'
import { auditProjectKey, auditSettingsSchema } from './security-audit.ts'
import {
  prepareManagedStateRoot,
  ensureManagedDirectory,
} from './managed-path.ts'
import {
  atomicWritePrivateFile,
} from './safe-file.ts'
import { terminalInput } from './slack-app-command.ts'

export async function securityAuditConfig(args: string[]): Promise<void> {
  const [stateInput, projectInput, command, ...values] = args
  if (!stateInput || !projectInput) throw Error('state/project required')
  const state = prepareManagedStateRoot(stateInput),
    project = realpathSync(projectInput)
  const root = ensureManagedDirectory(
    state,
    join(state, 'security-audit-settings'),
  )
  const path = join(root, `${auditProjectKey(project)}.json`)
  if (command === 'socket-token' || command === 'semgrep-token') {
    if (values.length)
      throw Error('トークンを引数へ渡さないでください。対話端末で入力します。')
    const semgrep = command === 'semgrep-token'
    const token = await terminalInput(`${semgrep ? 'Semgrep' : 'Socket'} API token（非表示）`)
    if (semgrep ? !/^[a-zA-Z0-9_.-]{16,2048}$/.test(token) : !/^sktsec_[A-Za-z0-9_-]+$/.test(token))
      throw Error('API token format invalid')
    saveAuditCredential(state, semgrep ? 'semgrep' : 'socket', token)
    process.stdout.write(auditCredentialState(state) === state
      ? 'この独立した保存先へ認証情報を保存しました（値は表示しません）。\n'
      : '認証情報を保存しました。このMacの同じユーザーの全Zeroちゃん・全プロジェクトで共用します（値は表示しません）。\n')
    return
  }
  const settings = loadAuditSettings(state, project)
  if (command === 'status') {
    process.stdout.write(
      JSON.stringify(
        {
          ...Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'codeqlLicensed')),
          semgrepCredentialPresent: readAuditCredential(state, 'semgrep') !== null,
          socketCredentialPresent:
            readAuditCredential(state, 'socket') !== null,
        },
        null,
        2,
      ) + '\n',
    )
    return
  }
  if (command === 'target' && values.length === 1) {
    const url = new URL(values[0]!)
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw Error('対象URLが不正です')
    settings.targetUrl = url.href
    settings.activeScan = false
  } else if (
    command === 'active' &&
    values.length === 1 &&
    ['on', 'off'].includes(values[0]!)
  ) {
    if (!settings.targetUrl) throw Error('先にtargetで対象を指定してください')
    settings.activeScan = values[0] === 'on'
  } else if (
    command === 'auth' &&
    values.length === 1 &&
    ['required', 'none'].includes(values[0]!)
  ) {
    settings.authentication = values[0] as 'required' | 'none'
  } else if (command === 'e2e-port' && values.length === 1) {
    settings.e2ePort = Number(values[0])
  } else if (command === 'socket-org' && values.length === 1) {
    settings.socketOrg = values[0]
  } else if (command === 'semgrep-repo' && values.length === 1) {
    settings.semgrepRepo = values[0]
  } else if (command === 'auth-probe' && values.length === 2) {
    settings.authenticatedPath = values[0]
    settings.loggedInPattern = values[1]
  } else if (command === 'image' && values.length === 1) {
    settings.images = [...new Set([...settings.images, values[0]!])]
  } else
    throw Error(
      '使い方: zerochan security status | target URL | active on|off | auth required|none | e2e-port PORT | auth-probe PATH LOGGED_IN_PATTERN | socket-org ORG | socket-token | semgrep-repo OWNER/REPO | semgrep-token | image IMAGE',
    )
  if (command === 'socket-org') {
    atomicWritePrivateFile(path, JSON.stringify(auditSettingsSchema.parse(settings)) + '\n')
  } else saveAuditSettings(state, project, settings)
  process.stdout.write('このプロジェクトの検査設定を保存しました。\n')
}
if (import.meta.main)
  securityAuditConfig(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      String(error instanceof Error ? error.message : '設定に失敗しました') +
        '\n',
    )
    process.exitCode = 1
  })
