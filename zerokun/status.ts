#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { inspectManagedServiceStatus } from './service-control.ts'
import { resolveZeroStateDir } from './state-dir.ts'

type PartialServiceStatus = {
  gatewayPid?: number
  runnerPid?: number
  launcherPid?: number
}

export function partialServiceStatusMessage(current: PartialServiceStatus): string {
  if (current.gatewayPid && !current.runnerPid && current.launcherPid) {
    return '⚠️ Zeroちゃんの処理担当は自動復旧中です。'
      + 'しばらく待ってから再確認してください。'
      + '復旧しない場合は zerochan stop --force の後に '
      + 'zerochan start を実行してください。'
  }
  if (current.gatewayPid && current.runnerPid && !current.launcherPid) {
    return '⚠️ Zeroちゃんの自動復旧機構が停止しています。'
      + '現在の処理は稼働中です。zerochan start を実行すると、'
      + 'gatewayと処理中タスクを止めずに自動復旧機構だけを再構築します。'
  }
  return '⚠️ Zeroちゃんは部分起動状態です。'
    + '復旧するには zerochan stop --force の後に '
    + 'zerochan start を実行してください。'
}

function fail(message: string): never {
  process.stderr.write(`❌ ${message}\n`)
  process.exit(1)
}

function main(): void {
  if (process.argv.length !== 2) {
    process.stderr.write('usage: zerokun-status\n')
    process.exit(2)
  }
  let current: ReturnType<typeof inspectManagedServiceStatus>
  try {
    current = inspectManagedServiceStatus(resolveZeroStateDir())
  } catch (error) {
    fail(`稼働状態を確認できません: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (current.status === 'stopped') {
    process.stdout.write('⏹️ Zeroちゃんは停止中です。\n')
    return
  }
  if (current.status === 'partial') {
    process.stderr.write(`${partialServiceStatusMessage(current)}\n`)
    process.stderr.write(`   gateway: ${current.gatewayPid ? `PID ${current.gatewayPid}` : '停止'} / runner: ${current.runnerPid ? `PID ${current.runnerPid}` : '停止'} / recovery: ${current.launcherPid ? `PID ${current.launcherPid}` : '停止'}\n`)
    process.exit(1)
  }
  process.stdout.write('✅ Zeroちゃんは稼働中です。\n')
  process.stdout.write(`   gateway: PID ${current.gatewayPid} / runner: PID ${current.runnerPid} / recovery: PID ${current.launcherPid}\n`)
}

if (import.meta.main) main()
