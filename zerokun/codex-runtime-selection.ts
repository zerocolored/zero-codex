/**
 * Zeroちゃんのprimary Codex runtime selection.
 *
 * Keep this in release code instead of environment or user Codex config so
 * every installed machine starts the same primary workflow. Advisor model
 * roles are also release-owned so host role defaults cannot retain old effort.
 */
import { lstatSync, realpathSync } from 'fs'
import { join } from 'path'

export const ZEROCHAN_PRIMARY_CODEX_MODEL = 'gpt-6-astra' as const
export const ZEROCHAN_PRIMARY_CODEX_REASONING_EFFORT = 'medium' as const

export function zerochanAdvisorRoleOverrides(): string[] {
  const directory = join(realpathSync(import.meta.dir), 'agents')
  const directoryMetadata = lstatSync(directory)
  if (!directoryMetadata.isDirectory() || (directoryMetadata.mode & 0o022) !== 0
    || (directoryMetadata.uid !== 0 && directoryMetadata.uid !== process.getuid?.())) {
    throw new Error('Zerochan advisor role directory is unsafe')
  }
  return ['solution_analyst', 'risk_reviewer'].map(role => {
    const path = join(directory, `${role}.toml`)
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o022) !== 0
      || (metadata.uid !== 0 && metadata.uid !== process.getuid?.())) {
      throw new Error('Zerochan advisor role configuration is unsafe')
    }
    return `agents.${role}.config_file=${JSON.stringify(path)}`
  })
}
