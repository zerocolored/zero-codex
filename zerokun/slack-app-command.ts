import { homedir } from 'os'
import { WebClient } from '@slack/web-api'
import { bindProjectSlackApp } from './project-channel-config.ts'
import { resolveProjectLayout } from './project-layout.ts'
import { adoptLegacySlackApp, listRegisteredSlackApps, saveNewSlackApp } from './slack-app-registry.ts'
import { verifySlackAppTokenPair } from './slack-app-identity.ts'
import { slackWebClientOptions } from './slack-http.ts'
import { prepareSlackAppState } from './slack-app-state.ts'
import { installAppWatchdog } from './watchdog-profile.ts'
import { join } from 'path'
import { slackAppRegistryRoot } from './slack-app-registry.ts'
import { Database } from 'bun:sqlite'
import { lstatSync, realpathSync } from 'fs'

function existingRoutesBelongToSelectedApp(project: string, selectedId: string, channels: string[], home: string): boolean {
  const expectedProject = realpathSync(project)
  let selectedMatches = false
  for (const app of listRegisteredSlackApps(home)) {
    const path = join(app.stateDir, 'jobs.sqlite3')
    let db: Database | undefined
    try {
      const metadata = lstatSync(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== process.getuid!()) return false
      db = new Database(path, { readonly: true })
      const routes = db.query('SELECT channel_id FROM slack_channel_routes WHERE app_id = ? AND repo_path = ?').all(app.appId, expectedProject) as Array<{ channel_id: string }>
      if (app.appId === selectedId) selectedMatches = channels.every(channel => routes.some(route => route.channel_id === channel))
      else if (routes.some(route => channels.includes(route.channel_id))) return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    } finally { db?.close() }
  }
  return selectedMatches
}

/** Read directly from the user's TTY: no readline history, echo, argv or environment. */
export function terminalInput(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('対話端末で zerochan set slack-app を実行してください。トークンを引数に渡さないでください')
  }
  process.stdout.write(label + ': ')
  return new Promise((resolve, reject) => {
    let value = ''
    let escapeSequence = ''
    let finished = false
    const wasRaw = process.stdin.isRaw
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
      process.removeListener('SIGTERM', onSignal)
      process.removeListener('SIGHUP', onSignal)
      process.removeListener('SIGINT', onSignal)
      process.stdin.setRawMode(wasRaw)
      process.stdin.pause()
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value.trim())
      value = ''
    }
    const onSignal = () => finish(new Error('入力を中止しました'))
    const onEnd = () => finish(new Error('入力端末が閉じられました'))
    const onError = () => finish(new Error('入力端末を読み取れませんでした'))
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        // Terminals may wrap pasted text in bracketed-paste CSI sequences.
        // Consume terminal controls rather than mixing them into credentials.
        if (char === '\u001b') { escapeSequence = char; continue }
        if (escapeSequence) {
          escapeSequence += char
          if (escapeSequence.length === 2 && char !== '[') escapeSequence = ''
          else if (escapeSequence.length > 2 && char >= '@' && char <= '~') escapeSequence = ''
          else if (escapeSequence.length > 32) { finish(new Error('入力端末の制御文字を読み取れません')); return }
          continue
        }
        if (char === '\u0003' || char === '\u0004') { finish(new Error('入力を中止しました')); return }
        if (char === '\r' || char === '\n') { finish(); return }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else if (char >= ' ' && char <= '~') value += char
        if (value.length > 4096) { finish(new Error('入力が長すぎます')); return }
      }
    }
    process.stdin.setRawMode(true)
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.once('error', onError)
    process.on('SIGTERM', onSignal)
    process.on('SIGHUP', onSignal)
    process.on('SIGINT', onSignal)
    process.stdin.resume()
  })
}

async function verifyTokens(botToken: string, appToken: string): Promise<{ appId: string }> {
  const client = new WebClient(botToken, slackWebClientOptions(10_000))
  const identity = await verifySlackAppTokenPair(appToken, {
    authTest: () => client.auth.test({}),
    botsInfo: async bot => ({ app_id: (await client.bots.info({ bot })).bot?.app_id }),
  })
  await new WebClient(appToken, slackWebClientOptions(10_000)).apps.connections.open({})
  return identity
}

export async function runSlackAppCommand(project: string, hooks: {
  home?: string
  input?: (label: string) => Promise<string>
  output?: (text: string) => void
  verify?: (bot: string, app: string) => Promise<{ appId: string }>
  prepare?: typeof prepareSlackAppState
  installWatchdog?: typeof installAppWatchdog
} = {}): Promise<void> {
  const home = hooks.home ?? homedir()
  const input = hooks.input ?? terminalInput
  const output = hooks.output ?? (text => { process.stdout.write(text) })
  adoptLegacySlackApp(home)
  const existing = listRegisteredSlackApps(home)
  existing.forEach((app, index) => output(`${index + 1}: ${app.appId}\n`))
  let selected = existing[0]
  const choice = existing.length ? await input('登録済みアプリの番号、または新規登録は n') : 'n'
  if (choice === 'n') {
    const botToken = await input('Bot Token xoxb-（非表示）')
    const appToken = await input('App-Level Token xapp-（非表示）')
    if (!/^xoxb-[A-Za-z0-9._-]{10,}$/.test(botToken)) throw new Error('Bot Tokenの形式が不正です')
    let identity
    try {
      identity = await (hooks.verify ?? verifyTokens)(botToken, appToken)
    } catch {
      throw new Error('Slack認証を確認できませんでした。トークンの組み合わせ・権限・接続を確認してください（既存設定は変更していません）')
    }
    if (existing.some(app => app.appId === identity.appId)) {
      throw new Error('このアプリは登録済みです。再実行して一覧から選択してください')
    }
    selected = saveNewSlackApp(identity.appId, botToken, appToken, home)
  } else {
    if (!/^[1-9][0-9]*$/.test(choice)) throw new Error('一覧の番号を入力してください')
    selected = existing[Number(choice) - 1]
    if (!selected) throw new Error('一覧の番号を入力してください')
  }
  // Existing legacy installations are adopted in place, not re-provisioned
  // while their gateway may still be running.
  if (selected!.stateDir === join(slackAppRegistryRoot(home), 'states', selected!.appId)) {
    await (hooks.prepare ?? prepareSlackAppState)(selected!.stateDir, selected!.appId)
    ;(hooks.installWatchdog ?? installAppWatchdog)(selected!.stateDir, home)
  }
  output(`Slackアプリ登録: ${selected!.appId}\n`)
  const layout = resolveProjectLayout(project)
  if (layout.kind === 'git-worktree' || layout.kind === 'multi-repo-workspace') {
    bindProjectSlackApp(project, selected!.appId, channels => existingRoutesBelongToSelectedApp(project, selected!.appId, channels, home))
    output('現在のプロジェクトに紐付けました。次に zerochan set slack-channel <channel-id> を実行してください。\n')
  } else {
    output('アプリだけを登録しました。対象プロジェクトで同じコマンドを実行し、一覧から選択してください。\n')
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: zerochan set slack-app（トークンは引数に指定しません）')
    await runSlackAppCommand(process.argv[2]!)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Slackアプリ登録に失敗しました'}\n`)
    process.exitCode = 1
  }
}
