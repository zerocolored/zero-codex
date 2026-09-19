import { createHash } from 'crypto'
import { realpathSync, readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'

export function watchdogLabel(state: string, home = homedir()): string {
  const physical = realpathSync(state)
  const legacyDefault = resolve(home, '.codex', 'zerokun')
  if (physical === legacyDefault) return 'com.zerokun.watchdog'
  return `com.zerokun.watchdog.${createHash('sha256').update(physical).digest('hex').slice(0, 20)}`
}
export function renderWatchdog(template: string, state: string, legacy: string, home = homedir()): string {
  if (!['0', '1'].includes(legacy)) throw new Error('invalid cutover flag')
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  return template.replace('com.zerokun.watchdog', watchdogLabel(state, home))
    .replaceAll('__STATE_DIR__', escape(realpathSync(state)))
    .replaceAll('__LEGACY_CUTOVER__', legacy)
}

export function installAppWatchdog(state: string, home = homedir(), run = (args: string[]) => Bun.spawnSync(args).exitCode): void {
  if (process.platform !== 'darwin') return
  const label = watchdogLabel(state, home)
  const directory = join(home, 'Library', 'LaunchAgents')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${label}.plist`)
  const template = readFileSync(join(import.meta.dir, 'templates/com.zerokun.watchdog.plist.template'), 'utf8')
  const contents = renderWatchdog(template, state, '0', home)
  const previous = readOptionalBoundedOwnerOnlyRegularFile(path, 64 * 1024)
  const domain = `gui/${process.getuid!()}`
  if (previous === contents && run(['/bin/launchctl', 'print', `${domain}/${label}`]) === 0) return
  atomicWritePrivateFile(path, contents)
  run(['/bin/launchctl', 'bootout', `${domain}/${label}`])
  if (run(['/bin/launchctl', 'bootstrap', domain, path]) !== 0) {
    throw new Error('Slackアプリ登録は保存済みですが、監視サービスの登録に失敗しました。同じアプリを選択して再実行してください')
  }
}
if (import.meta.main) {
  const [command, state, legacy] = process.argv.slice(2)
  if (!state) throw new Error('missing state')
  if (command === 'label') process.stdout.write(watchdogLabel(state))
  else if (command === 'render') process.stdout.write(renderWatchdog(readFileSync(join(import.meta.dir, 'templates/com.zerokun.watchdog.plist.template'), 'utf8'), state, legacy ?? '0'))
  else throw new Error('unknown watchdog command')
}
