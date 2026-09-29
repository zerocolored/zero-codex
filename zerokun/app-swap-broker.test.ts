import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  APPLICATIONS_ROOT,
  MANAGED_APPS,
  appSwapStatus,
  installVerificationBuild,
  restoreInstalledBuild,
  type AppSwapCommands,
  type AppSwapContext,
} from './app-swap-broker.ts'

const APP = MANAGED_APPS[0]

type Harness = {
  context: AppSwapContext
  commands: AppSwapCommands
  root: string
  calls: string[][]
}

// 実機の /Applications は触らない。mv / rm / ditto を受け取って、その場で
// 同じ効果を作る。窓口が「何を・どの順で」やるかだけを検査する。
function harness(options: { payloadSha?: string; failPlace?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'zerokun-app-swap-'))
  const applications = join(root, 'Applications')
  const artifactDir = join(root, 'artifacts')
  const backupRoot = join(root, 'app-swap')
  for (const dir of [applications, artifactDir, backupRoot]) mkdirSync(dir, { recursive: true })
  const calls: string[][] = []
  const rewrite = (path: string) => (
    path === join(APPLICATIONS_ROOT, APP) ? join(applications, APP) : path
  )
  const commands: AppSwapCommands = {
    run: async argv => {
      calls.push([...argv])
      const [tool, ...rest] = argv
      if (tool === '/usr/bin/ditto') {
        const [, , , , destination] = argv
        const bundle = join(destination!, APP)
        mkdirSync(join(bundle, 'Contents'), { recursive: true })
        writeFileSync(join(bundle, 'Contents', 'Info.plist'), 'verification')
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (tool === '/bin/mv') {
        const [from, to] = rest.map(rewrite)
        if (options.failPlace && String(to).endsWith(`${APP}`) && String(from).includes('.staging-')) {
          return { exitCode: 1, stdout: '', stderr: 'denied' }
        }
        mkdirSync(join(String(to), 'Contents'), { recursive: true })
        writeFileSync(join(String(to), 'Contents', 'Info.plist'),
          readFileSync(join(String(from), 'Contents', 'Info.plist'), 'utf8'))
        rmSync(String(from), { recursive: true, force: true })
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (tool === '/bin/rm') {
        rmSync(rewrite(String(rest[1])), { recursive: true, force: true })
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' }
    },
    sha256: async () => options.payloadSha ?? 'a'.repeat(64),
  }
  return { context: { jobId: 'job', artifactDir, backupRoot }, commands, root, calls }
}

function payload(harnessed: Harness, name = 'build.zip'): string {
  const path = join(harnessed.context.artifactDir, name)
  writeFileSync(path, 'zip')
  return path
}

test('成果物でないzipは受け付けない', async () => {
  const h = harness()
  const outside = join(h.root, 'elsewhere.zip')
  writeFileSync(outside, 'zip')
  await expect(installVerificationBuild(h.context, h.commands,
    { app: APP, payload: outside, sha256: 'a'.repeat(64) }))
    .rejects.toThrow('must be an artifact of this job')
})

test('sha256が一致しないzipは置かない', async () => {
  const h = harness({ payloadSha: 'b'.repeat(64) })
  await expect(installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h), sha256: 'a'.repeat(64) }))
    .rejects.toThrow('does not match the declared sha256')
  expect(h.calls).toHaveLength(0)
})

test('対象外のアプリは差し替えられない', async () => {
  const h = harness()
  await expect(installVerificationBuild(h.context, h.commands,
    { app: 'Google Chrome.app', payload: payload(h), sha256: 'a'.repeat(64) }))
    .rejects.toThrow('not offered')
})

// 既存を消してしまうと戻せない。退避してから置く順序を守る。
test('既存アプリは消さずに退避してから置く', async () => {
  const h = harness()
  const installed = join(h.root, 'Applications', APP)
  mkdirSync(join(installed, 'Contents'), { recursive: true })
  writeFileSync(join(installed, 'Contents', 'Info.plist'), 'original')

  const result = await installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h), sha256: 'a'.repeat(64) })
  expect(result.complete).toBe(true)

  const moves = h.calls.filter(call => call[0] === '/bin/mv')
  expect(moves).toHaveLength(2)
  expect(moves[0]![2]).toBe(join(h.context.backupRoot, APP))
  expect(readFileSync(join(h.context.backupRoot, APP, 'Contents', 'Info.plist'), 'utf8')).toBe('original')
  expect(readFileSync(join(installed, 'Contents', 'Info.plist'), 'utf8')).toBe('verification')
  expect(h.calls.some(call => call[0] === '/bin/rm')).toBe(false)
})

test('置くのに失敗したら退避を戻す', async () => {
  const h = harness({ failPlace: true })
  const installed = join(h.root, 'Applications', APP)
  mkdirSync(join(installed, 'Contents'), { recursive: true })
  writeFileSync(join(installed, 'Contents', 'Info.plist'), 'original')

  await expect(installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h), sha256: 'a'.repeat(64) }))
    .rejects.toThrow('could not place the verification build')
  expect(readFileSync(join(installed, 'Contents', 'Info.plist'), 'utf8')).toBe('original')
  expect(existsSync(join(h.context.backupRoot, APP))).toBe(false)
})

// 二重に置くと、退避した本物を検証版で上書きして永久に失う。
test('戻す前にもう一度置くことはできない', async () => {
  const h = harness()
  const installed = join(h.root, 'Applications', APP)
  mkdirSync(join(installed, 'Contents'), { recursive: true })
  writeFileSync(join(installed, 'Contents', 'Info.plist'), 'original')
  await installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h), sha256: 'a'.repeat(64) })

  await expect(installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h, 'second.zip'), sha256: 'a'.repeat(64) }))
    .rejects.toThrow('already staged')
})

test('戻すと本物が返り、退避は残らない', async () => {
  const h = harness()
  const installed = join(h.root, 'Applications', APP)
  mkdirSync(join(installed, 'Contents'), { recursive: true })
  writeFileSync(join(installed, 'Contents', 'Info.plist'), 'original')
  await installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h), sha256: 'a'.repeat(64) })

  const restored = await restoreInstalledBuild(h.context, h.commands, { app: APP })
  expect(restored.restored).toBe(true)
  expect(readFileSync(join(installed, 'Contents', 'Info.plist'), 'utf8')).toBe('original')
  expect(existsSync(join(h.context.backupRoot, APP))).toBe(false)
})

test('何も置いていないときの復元は失敗にしない', async () => {
  const h = harness()
  const restored = await restoreInstalledBuild(h.context, h.commands, { app: APP })
  expect(restored.complete).toBe(true)
  expect(restored.restored).toBe(false)
})

// 戻し忘れた実機を見つけられないと、本番を見ているつもりで検証版を触る。
test('statusは検証版が残っているかを示す', async () => {
  const h = harness()
  expect((appSwapStatus(h.context).applications as Array<Record<string, unknown>>)[0]!
    .verificationBuildStaged).toBe(false)
  mkdirSync(join(h.context.backupRoot, APP, 'Contents'), { recursive: true })
  expect((appSwapStatus(h.context).applications as Array<Record<string, unknown>>)[0]!
    .verificationBuildStaged).toBe(true)
})
