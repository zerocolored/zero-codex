#!/usr/bin/env -S bun --config=/dev/null --no-env-file
import { createInterface } from 'readline/promises'
import { realpathSync } from 'fs'
import { activateProjectPrimaryCore, projectPrimaryCore, setProjectPrimaryCore } from './project-channel-config.ts'
import { parsePrimaryCore, primaryCoreLabel, type PrimaryCore } from './primary-core.ts'
import { resolveProjectLayout } from './project-layout.ts'
import { assertClaudeMainlineReady } from './claude-mainline-runtime.ts'

export function projectCoreStatus(project: string): string {
  const core = projectPrimaryCore(project)
  return [`主担当の設定: ${primaryCoreLabel(core.desired)}`, `新規依頼の担当: ${primaryCoreLabel(core.active)}`,
    ...(core.desired === core.active ? [] : ['設定の反映: 次の zerochan start から'])].join('\n')
}

/** Explicit start only. Recovery and updater restarts preserve the active core. */
export async function startWithSelectedCore<T>(project: string, start: () => Promise<T>,
  preflight: (cwd: string) => unknown = assertClaudeMainlineReady): Promise<T> {
  const physical = realpathSync(project)
  const selected = projectPrimaryCore(physical).desired
  if (selected === 'claude-code') preflight(physical)
  const result = await start()
  activateProjectPrimaryCore(physical, selected)
  return result
}

export async function selectProjectCore(project: string, argument?: string): Promise<PrimaryCore> {
  const physical = realpathSync(project)
  resolveProjectLayout(physical)
  let selected = argument
  if (selected === undefined) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('zerochan set core codex|claude を指定してください')
    const current = projectPrimaryCore(physical).desired
    const terminal = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = (await terminal.question(`主担当を選択してください（現在: ${primaryCoreLabel(current)}）\n  1. Codex（既定）\n  2. Claude Code（最新Opus）\n番号 [${current === 'codex' ? '1' : '2'}]: `)).trim()
      selected = answer === '' ? current : answer === '1' ? 'codex' : answer === '2' ? 'claude' : answer
    } finally { terminal.close() }
  }
  const core = parsePrimaryCore(selected)
  setProjectPrimaryCore(physical, core)
  return core
}

if (import.meta.main) {
  try {
    const [command, project, value, ...extra] = process.argv.slice(2)
    if (!project || extra.length) throw new Error('usage: core-command.ts set|status|preflight|activate <project> [core]')
    if (command === 'set') {
      const core = await selectProjectCore(project, value)
      process.stdout.write(`主担当を ${primaryCoreLabel(core)} に設定しました。\nzerochan start で新規依頼へ反映します。受付済みの作業は元の担当で継続します。\n`)
    } else if (command === 'status' && value === undefined) {
      process.stdout.write(projectCoreStatus(project) + '\n')
    } else if (command === 'preflight' && value === undefined) {
      const core = projectPrimaryCore(project).desired
      if (core === 'claude-code') assertClaudeMainlineReady(realpathSync(project))
      process.stdout.write(core + '\n')
    } else if (command === 'activate' && value !== undefined) {
      activateProjectPrimaryCore(project, parsePrimaryCore(value))
    } else throw new Error('invalid core command')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : '主担当設定を変更できませんでした'}\n`)
    process.exitCode = 1
  }
}
