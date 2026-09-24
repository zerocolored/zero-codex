import { homedir } from 'os'
import { join } from 'path'
import { installedComputerUseClient, installedComputerUseNodeRepl } from './installed-computer-use.ts'

const APPLICATION_ROOT = '/Applications/ChatGPT.app'

/**
 * setup.shがComputer Useの前提を報告するためだけの読み取り検査。
 * 判定はcodex-executorが実際に採用する2経路と同じ関数で行い、案内と実行の食い違いを防ぐ。
 * macOSの「画面収録」「アクセシビリティ」はTCC側にあり、ここからは付与も確認もできない。
 */
export function computerUseReadiness(
  codexHome: string,
  projectRoot: string,
  applicationRoot = APPLICATION_ROOT,
): { ready: boolean; lines: string[] } {
  const bundled = join(applicationRoot, 'Contents/Resources/cua_node/bin/node_repl')
  const native = installedComputerUseClient(codexHome, projectRoot)
  if (native) return { ready: true, lines: [`  4. Computer Use: 導入済み (${native})`] }
  if (installedComputerUseNodeRepl(projectRoot, bundled, applicationRoot)) {
    return { ready: true, lines: [`  4. Computer Use: 導入済み (${bundled})`] }
  }
  return {
    ready: false,
    lines: [
      '  4. Computer Use(画面操作)を使う場合だけ、ChatGPTデスクトップアプリを導入します。',
      '     このMacでは次のどちらも見つかりませんでした:',
      `       ${join(codexHome, 'computer-use/Codex Computer Use.app')}`,
      `       ${bundled}`,
      '     導入後、システム設定 → プライバシーとセキュリティ の「画面収録」と',
      '     「アクセシビリティ」で Codex Computer Use を許可します。',
      '     ターミナルやHerdrへ同じ権限を足してもComputer Useは有効になりません。',
    ],
  }
}

if (import.meta.main) {
  const projectRoot = process.argv[2]
  if (process.argv.length !== 3 || !projectRoot) {
    process.stderr.write('usage: computer-use-readiness.ts <project-dir>\n')
    process.exitCode = 1
  } else {
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
    process.stdout.write(`${computerUseReadiness(codexHome, projectRoot).lines.join('\n')}\n`)
  }
}
