#!/usr/bin/env -S bun --config=/dev/null --no-env-file

import { inspectManagedServiceStatus } from './service-control.ts'
import { resolveZeroStateDir } from './state-dir.ts'

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
    process.stderr.write('⚠️ Zeroちゃんは部分起動状態です。zerochan stop の後に zerochan start を実行してください。\n')
    process.stderr.write(`   gateway: ${current.gatewayPid ? `PID ${current.gatewayPid}` : '停止'} / runner: ${current.runnerPid ? `PID ${current.runnerPid}` : '停止'}\n`)
    process.exit(1)
  }
  process.stdout.write('✅ Zeroちゃんは稼働中です。\n')
  process.stdout.write(`   gateway: PID ${current.gatewayPid} / runner: PID ${current.runnerPid}\n`)
}

if (import.meta.main) main()
