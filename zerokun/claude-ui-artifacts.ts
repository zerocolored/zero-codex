import { createHash, randomUUID } from 'crypto'
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { createServer } from 'net'
import { z } from 'zod'
import { ensureManagedDirectory } from './managed-path.ts'
import { containsCredentialMaterial } from './public-output-guard.ts'
import { reencodeBrowserScreenshot } from './ui-approval.ts'

/** Inputs describe the comparison, never grant paths or permissions. */
export const claudeUiProposalSchema = z.object({
  comparison: z.string().trim().min(1).max(8_000),
  beforeKind: z.enum(['actual', 'synthetic', 'unavailable']),
  beforeImage: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/).max(200).optional(),
}).strict().refine(value => value.beforeKind !== 'actual' || !!value.beforeImage,
  'An actual Before requires a sanitized PNG in this job outbox')
export type ClaudeUiProposal = z.infer<typeof claudeUiProposalSchema>
export type ClaudeUiWorkspace = {
  version: 1; root: string; dev: number; ino: number; port: number
  width: 1280; height: 720
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function readArtifact(path: string, max: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.size < 1 || st.size > max) {
      throw new Error('Fable artifact is not a bounded owned regular file')
    }
    const bytes = readFileSync(fd)
    if (bytes.length !== st.size) throw new Error('Fable artifact changed during read')
    return bytes
  } finally { closeSync(fd) }
}

function sanitizePng(bytes: Buffer, width: number, height: number): Buffer {
  // The decoder reopens its source by path. Never hand it a reviewer-writable path.
  const sourceDir = realpathSync(mkdtempSync(join(tmpdir(), 'zero-fable-decode-')))
  chmodSync(sourceDir, 0o700)
  try {
    const source = join(sourceDir, 'input.png')
    writeFileSync(source, bytes, { flag: 'wx', mode: 0o600 })
    return reencodeBrowserScreenshot({ source, sourceDir, digest: digest(bytes), width, height })
  } finally { rmSync(sourceDir, { recursive: true, force: true }) }
}

export async function createClaudeUiWorkspace(input: {
  stateDir: string; jobId: string; proposal: ClaudeUiProposal; projectRoots?: string[]
}): Promise<ClaudeUiWorkspace> {
  const proposal = claudeUiProposalSchema.parse(input.proposal)
  if (containsCredentialMaterial(proposal.comparison)) throw new Error('UI comparison contains credential material')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zero-fable-gui-')))
  chmodSync(root, 0o700)
  const protectedRoots = [input.stateDir, ...(input.projectRoots ?? []),
    process.env.CODEX_HOME ?? join(homedir(), '.codex'), join(homedir(), '.claude'), join(homedir(), '.agents')]
  if (protectedRoots.some(parent => {
    const physical = (() => { try { return realpathSync(parent) } catch { return resolve(parent) } })()
    const child = relative(physical, root)
    return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
  })) {
    rmSync(root, { recursive: true, force: true })
    throw new Error('OS temporary directory is inside protected project/configuration state')
  }
  try {
  for (const name of ['input', 'prototype', 'evidence', 'runtime']) mkdirSync(join(root, name), { mode: 0o700 })
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('preview port unavailable')); return }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
  if (proposal.beforeImage) {
    const outbox = ensureManagedDirectory(input.stateDir, join(input.stateDir, 'outbox', input.jobId))
    const source = join(outbox, proposal.beforeImage)
    const bytes = readArtifact(source, 16 * 1024 * 1024)
    const png = sanitizePng(bytes, 1280, 720)
    writeFileSync(join(root, 'input', 'before.png'), png, { flag: 'wx', mode: 0o600 })
  }
  writeFileSync(join(root, 'input', 'comparison.json'), JSON.stringify(proposal), { flag: 'wx', mode: 0o600 })
  const st = lstatSync(root)
  return { version: 1, root, dev: st.dev, ino: st.ino, port, width: 1280, height: 720 }
  } catch (error) {
    // No reviewer has received this root yet.
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

export function claudeUiInstructions(workspace: ClaudeUiWorkspace): string {
  return [
    'GUI初期設計のUIデザイン、frontend-only sample、After画像はClaude Fable 5.1が担当してください。',
    `Host-owned artifact root: ${JSON.stringify(workspace.root)}`,
    'input/comparison.json と、存在する場合は input/before.png が比較契約です。入力は変更しないでください。',
    'prototype、evidence、runtimeだけにtask-directedな書込みを許可します。通常のtool-managed runtimeは利用できます。',
    'prototype/index.html に自己完結した画面sampleを作成してください。synthetic dataだけを使い、依存導入はしないでください。',
    `導入済みbrowser/toolchain/fontでsampleを実際に開き、${workspace.width}x${workspace.height}、DPR 1でevidence/after.pngへ撮影してください。`,
    `previewは http://127.0.0.1:${workspace.port} の固定portでprototypeだけをserveし、networkはこのloopback originだけに限定してください。`,
    'browser profile/cache/tempはruntimeへ置いてください。既存browser/session、秘密、個人情報、認証、実API/DB/課金/公開/外部serviceにはアクセスしないでください。',
    'repositoryとGitはread-onlyです。task外file、agent設定の読取り、再委任、package installを禁止します。',
    '比較契約のstate、theme、scroll、focusを合わせてください。Afterは本番未接続のconceptです。',
    '回答前に自分で起動したpreview/browser processを終了してください。runtime residueだけを失敗扱いしないでください。',
    '回答には選んだUI、変更点、未実装箇所、実際に使った撮影commandとprocess終了結果を記載してください。',
    '撮影に失敗してもデザインsampleと理由を返してください。未生成画像を作成済みと報告しないでください。',
  ].join('\n')
}

/** Keep the isolated prototype for the hearing; return only a decoded, sealed image. */
export function collectClaudeUiArtifacts(input: {
  workspace: ClaudeUiWorkspace; stateDir: string; jobId: string
}) {
  const { workspace } = input
  const st = lstatSync(workspace.root)
  if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== workspace.dev || st.ino !== workspace.ino) {
    throw new Error('Fable artifact root identity changed')
  }
  for (const name of ['prototype', 'evidence']) {
    const child = lstatSync(join(workspace.root, name))
    if (!child.isDirectory() || child.isSymbolicLink() || child.uid !== process.getuid?.()) throw new Error('Fable output directory is unsafe')
  }
  const samplePath = join(workspace.root, 'prototype', 'index.html')
  const sample = readArtifact(samplePath, 2 * 1024 * 1024)
  const html = sample.toString('utf8')
  if (containsCredentialMaterial(html) || /(?:\b(?:src|href|action)\s*=\s*["']|\burl\(\s*["']?)(?:https?:\/\/|\/\/|file:|ftp:)/i.test(html)) {
    throw new Error('Fable sample contains credentials or an external resource; primary must inspect it')
  }
  const sourceDir = join(workspace.root, 'evidence')
  const source = join(sourceDir, 'after.png')
  const bytes = readArtifact(source, 16 * 1024 * 1024)
  const sanitized = sanitizePng(bytes, workspace.width, workspace.height)
  const outbox = ensureManagedDirectory(input.stateDir, join(input.stateDir, 'outbox', input.jobId))
  const afterPath = join(outbox, `fable-after-${randomUUID()}.png`)
  writeFileSync(afterPath, sanitized, { flag: 'wx', mode: 0o600 })
  return {
    status: 'produced' as const, producer: 'claude-fable-5-1' as const,
    prototypePath: samplePath, prototypeSha256: digest(sample), afterPath, afterSha256: digest(sanitized),
    width: workspace.width, height: workspace.height, isolatedRoot: workspace.root,
    rootIdentity: { dev: workspace.dev, ino: workspace.ino },
    requiresPrimaryVisualInspection: true,
    cleanup: 'Retained for hearing. After the task, remove only this owned root after rechecking device/inode and stopping owned preview/browser processes.',
  }
}
