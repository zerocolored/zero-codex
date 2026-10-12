import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { assertProjectSlackAppAttached, readProjectChannelConfig } from './project-channel-config.ts'
import { readRegisteredSlackApp } from './slack-app-registry.ts'
import { legacyCutoverForState } from './state-dir.ts'

/** Project binding wins over stale shell exports. Unbound legacy projects keep their state. */
export function resolveProjectAppState(project: string, fallbackState: string, home = homedir()): string {
  assertProjectSlackAppAttached(project)
  const appId = readProjectChannelConfig(project).slackAppId
  if (!appId) return fallbackState
  const app = readRegisteredSlackApp(appId, home)
  if (!app) throw new Error(`Slackアプリ ${appId} はこのPCに未登録です。zerochan set slack-app で登録してください`)
  return app.stateDir
}

/** A pre-disconnect runtime cannot honor the reconnect intake boundary. Keep
 * its service pin intact and use the normal updater before starting it. */
export function assertProjectRuntimeCompatible(project: string, runtimeRoot: string): void {
  const config = readProjectChannelConfig(project)
  if (config.slackAcceptAfter !== undefined
    && !existsSync(join(runtimeRoot, 'zerokun', 'slack-project-admission.ts'))) {
    throw new Error('このアプリの実行版はSlackアプリの再接続に未対応です。このプロジェクトで zerochan update を実行してから、もう一度起動してください（設定は保持しています）')
  }
}

if (import.meta.main) {
  try {
    const [project, fallbackState, ...extra] = process.argv.slice(2)
    if (project === 'check-runtime' && fallbackState && extra.length === 1) {
      assertProjectRuntimeCompatible(fallbackState, extra[0]!)
      process.exit(0)
    }
    if (!project || !fallbackState || extra.length) throw new Error('usage: project-app-state.ts <project> <fallback-state>')
    process.stdout.write((project === 'cutover' ? legacyCutoverForState(fallbackState) : resolveProjectAppState(project, fallbackState)) + '\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Slackアプリ設定を読み取れません'}\n`)
    process.exitCode = 1
  }
}
