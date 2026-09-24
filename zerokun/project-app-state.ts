import { homedir } from 'os'
import { readProjectChannelConfig } from './project-channel-config.ts'
import { readRegisteredSlackApp } from './slack-app-registry.ts'
import { legacyCutoverForState } from './state-dir.ts'

/** Project binding wins over stale shell exports. Unbound legacy projects keep their state. */
export function resolveProjectAppState(project: string, fallbackState: string, home = homedir()): string {
  const appId = readProjectChannelConfig(project).slackAppId
  if (!appId) return fallbackState
  const app = readRegisteredSlackApp(appId, home)
  if (!app) throw new Error(`Slackアプリ ${appId} はこのPCに未登録です。zerochan set slack-app で登録してください`)
  return app.stateDir
}

if (import.meta.main) {
  try {
    const [project, fallbackState, ...extra] = process.argv.slice(2)
    if (!project || !fallbackState || extra.length) throw new Error('usage: project-app-state.ts <project> <fallback-state>')
    process.stdout.write((project === 'cutover' ? legacyCutoverForState(fallbackState) : resolveProjectAppState(project, fallbackState)) + '\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Slackアプリ設定を読み取れません'}\n`)
    process.exitCode = 1
  }
}
