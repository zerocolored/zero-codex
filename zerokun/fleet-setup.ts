import { existsSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { listRegisteredSlackApps } from './slack-app-registry.ts'
import { fleetAuthPath, fleetInstallationId, fleetIsOff, registrationSchema } from './fleet-runtime.ts'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { CloudHandoffClient, readCloudConfig } from './cloud-handoff.ts'

export async function configureFleet(command: string, state: string, args: string[]) {
  const path = join(state, 'fleet.json')
  if (command === 'identity' && !args.length) {
    console.log(`PC installation ID: ${fleetInstallationId()}`)
    return
  }
  if (command === 'status' && !args.length) {
    if (fleetIsOff(state)) { console.log('稼働状況の送信: 無効'); return }
    const raw = readOptionalBoundedOwnerOnlyRegularFile(path, 4096)
    if (!raw) { console.log('稼働状況の送信: 起動時に自動登録（登録済みSlackアプリ認証を使用。cloud loginは不要）'); return }
    const config = registrationSchema.parse(JSON.parse(raw))
    console.log(`稼働状況の送信: 設定済み\nSlack App: ${config.appId}\nInstance: ${config.instanceId}\nPC identity: ${config.installationId === fleetInstallationId() ? '一致' : '別PCの設定・再登録が必要'}`)
    console.log(config.transport === 'slack' ? '送信認証: Slackから自動発行（cloud loginは不要）' : '送信認証: 旧方式（次回起動時にSlack認証へ移行）')
    return
  }
  if (command === 'off' && !args.length) {
    atomicWritePrivateFile(join(state, 'fleet.off.json'), '{}\n')
    if (existsSync(path)) renameSync(path, join(state, 'fleet.disabled.json'))
    console.log('送信を無効にしました。稼働中の監視送信は次回の送信確認から停止します。')
    return
  }
  if (command === 'register' && args.length === 2) {
    const app = listRegisteredSlackApps().find(app => app.stateDir === state)
    if (!app) throw new Error('Slack app registration required')
    const config = registrationSchema.parse({ instanceId: args[0], authAppId: args[1], appId: app.appId, installationId: fleetInstallationId() })
    const authPath = fleetAuthPath(state, config.authAppId)
    const auth = readCloudConfig(authPath)
    // Read-only authentication check. Do not start a generation while another sender is running.
    await new CloudHandoffClient(auth, fetch, authPath).authenticatedUserId()
    atomicWritePrivateFile(path, JSON.stringify(config) + '\n')
    if (existsSync(join(state, 'fleet.off.json'))) unlinkSync(join(state, 'fleet.off.json'))
    console.log('稼働状況の送信を登録しました。管理者のDB登録と、作業終了後の再起動で有効になります。クラウド引き継ぎの有効・無効は変更していません。')
    return
  }
  throw new Error('Usage: zerochan fleet identity|status|off|register <instance-id> <auth-app-id>')
}
if (import.meta.main) {
  const [command, state, ...args] = process.argv.slice(2)
  if (!command || !state) throw new Error('fleet command and state required')
  configureFleet(command, state, args).catch(() => {
    console.error('稼働状況の設定に失敗しました。登録ID・Slackアプリ登録・クラウド認証を確認してください。認証情報をチャットへ貼る必要はありません。')
    process.exitCode = 1
  })
}
