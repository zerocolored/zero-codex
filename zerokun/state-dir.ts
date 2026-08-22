import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export function resolveZeroStateDir(
  environment: Record<string, string | undefined> = process.env,
  home = homedir(),
  exists: (path: string) => boolean = existsSync,
): string {
  if (environment.ZEROKUN_STATE_DIR) return environment.ZEROKUN_STATE_DIR
  if (environment.SLACK_STATE_DIR) return environment.SLACK_STATE_DIR
  const legacy = join(home, '.claude', 'channels', 'slack')
  const configuredLegacy = ['jobs.sqlite3', '.env', 'access.json']
    .some(name => exists(join(legacy, name)))
  return configuredLegacy ? legacy : join(home, '.codex', 'zerokun')
}
