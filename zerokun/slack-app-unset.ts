import { homedir } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import { readProjectChannelConfig, unsetProjectSlackApp } from './project-channel-config.ts'
import { listRegisteredSlackApps, withSlackAppRegistryLock } from './slack-app-registry.ts'

export function detachedProjectStatus(project: string): string | null {
  if (existsSync(join(project, '.zerochan', 'slack-app-unset.json'))) {
    return 'Slackアプリ: 解除処理中（新規受付停止）\nzerochan unset slack-app を再実行してください。\n'
  }
  if (readProjectChannelConfig(project).slackAppId !== null) return null
  return 'Slackアプリ: 未設定（解除済み）\nSlackチャンネル: 未設定\n再接続: zerochan set slack-app → zerochan set slack-channel <channel-id>\n'
}

export function runUnsetSlackApp(project: string, home = homedir()): string {
  withSlackAppRegistryLock(home, () => unsetProjectSlackApp(project, listRegisteredSlackApps(home)))
  return 'このプロジェクトのSlackアプリ・チャンネル紐付けを解除しました。\n新規依頼の受付は停止しました。受付済みの作業・結果通知・停止操作は継続します。\nアプリ登録・トークン・履歴・他のプロジェクトは保持しています。\n再接続: zerochan set slack-app → zerochan set slack-channel <channel-id>\n'
}

if (import.meta.main) {
  try {
    const [command, project, ...extra] = process.argv.slice(2)
    if (!project || extra.length || !['unset', 'status'].includes(command!)) throw new Error('usage: slack-app-unset.ts unset|status <project>')
    const result = command === 'unset' ? runUnsetSlackApp(project) : detachedProjectStatus(project)
    if (result === null) process.exitCode = 3 // Continue normal status resolution.
    else process.stdout.write(result)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Slackアプリの解除に失敗しました'}\n`)
    process.exitCode = 1
  }
}
