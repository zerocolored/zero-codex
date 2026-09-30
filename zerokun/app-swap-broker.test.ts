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
function harness(options: { payloadSha?: string; failPlace?: boolean; identityAvailable?: boolean } = {}): Harness {
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
      if (tool === '/usr/bin/security') {
        return {
          exitCode: 0,
          stdout: options.identityAvailable === false ? '0 valid identities found'
            : '1) ABC "zerokun verification (local only)"',
          stderr: '',
        }
      }
      if (tool === '/usr/bin/codesign') return { exitCode: 0, stdout: '', stderr: '' }
      if (String(tool).endsWith('/lsregister')) return { exitCode: 0, stdout: '', stderr: '' }
      if (tool === '/usr/bin/pkill') return { exitCode: 1, stdout: '', stderr: '' }
      if (tool === '/usr/bin/open') return { exitCode: 0, stdout: '', stderr: '' }
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

// adhoc のままだと再ビルドごとに別アプリ扱いになり、画面収録などの許可を
// 毎回取り直すことになる。置く前に安定した署名へ付け替える。
function installOriginal(h: Harness): string {
  const installed = join(h.root, 'Applications', APP)
  mkdirSync(join(installed, 'Contents'), { recursive: true })
  writeFileSync(join(installed, 'Contents', 'Info.plist'), 'original')
  return installed
}

test('置く前に検証用の署名へ付け替える', async () => {
  const h = harness()
  installOriginal(h)
  await installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h), sha256: 'a'.repeat(64) })
  const signIndex = h.calls.findIndex(call => call[0] === '/usr/bin/codesign')
  const placeIndex = h.calls.findIndex(call => call[0] === '/bin/mv')
  expect(signIndex).toBeGreaterThanOrEqual(0)
  expect(signIndex).toBeLessThan(placeIndex)
  expect(h.calls[signIndex]).toContain('zerokun verification (local only)')
})

test('証明書が無いMacでも差し替えは続き、許可が要ることを伝える', async () => {
  const h = harness({ identityAvailable: false })
  installOriginal(h)
  const result = await installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h), sha256: 'a'.repeat(64) })
  expect(result.complete).toBe(true)
  expect(result.stableIdentity).toBe(false)
  expect(String(result.permissionNote)).toContain('granted again')
  expect(h.calls.some(call => call[0] === '/usr/bin/codesign')).toBe(false)
})




// identifier を書き換えても LaunchServices が古い記録を持つと、Computer Use は
// 一覧に出たアプリを掴めず Invalid app を返す。置いた実体で登録し直す。
test('置いた後にLaunchServicesへ登録し直す', async () => {
  const h = harness()
  installOriginal(h)
  const result = await installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h), sha256: 'a'.repeat(64) })
  expect(result.launchServicesRefreshed).toBe(true)
  const registerIndex = h.calls.findIndex(call => String(call[0]).endsWith('/lsregister'))
  const placeIndex = h.calls.map(call => call[0]).lastIndexOf('/bin/mv')
  expect(registerIndex).toBeGreaterThan(placeIndex)
  // staging ではなく、置いた先を登録する。
  expect(h.calls[registerIndex]![2]).toBe(join(APPLICATIONS_ROOT, APP))
})

test('戻したあとも登録し直す', async () => {
  const h = harness()
  installOriginal(h)
  await installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h), sha256: 'a'.repeat(64) })
  const before = h.calls.filter(call => String(call[0]).endsWith('/lsregister')).length
  const restored = await restoreInstalledBuild(h.context, h.commands, { app: APP })
  expect(restored.launchServicesRefreshed).toBe(true)
  expect(h.calls.filter(call => String(call[0]).endsWith('/lsregister')).length).toBe(before + 1)
})

// 起動中のアプリは起動時の identity を保つ。残したまま置き換えると、解決が
// 旧 ID を返し続け、Computer Use から掴めない。
test('差し替える前に起動中のアプリを終了させる', async () => {
  const h = harness()
  installOriginal(h)
  await installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h), sha256: 'a'.repeat(64) })
  const quitIndex = h.calls.findIndex(call => call[0] === '/usr/bin/pkill')
  const placeIndex = h.calls.findIndex(call => call[0] === '/bin/mv')
  expect(quitIndex).toBeGreaterThanOrEqual(0)
  expect(quitIndex).toBeLessThan(placeIndex)
})

test('戻す前にも終了させる', async () => {
  const h = harness()
  installOriginal(h)
  await installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h), sha256: 'a'.repeat(64) })
  const before = h.calls.filter(call => call[0] === '/usr/bin/pkill').length
  await restoreInstalledBuild(h.context, h.commands, { app: APP })
  expect(h.calls.filter(call => call[0] === '/usr/bin/pkill').length).toBe(before + 1)
})

// 差し替え前に終了させる以上、置いた後に起動し直さないと Computer Use が
// 掴む相手が居ない。登録し直した後に起動しないと、古い記録のまま立ち上がる。
test('置いて登録し直した後に起動する', async () => {
  const h = harness()
  installOriginal(h)
  const result = await installVerificationBuild(h.context, h.commands,
    { app: APP, payload: payload(h), sha256: 'a'.repeat(64) })
  expect(result.launched).toBe(true)
  const openIndex = h.calls.findIndex(call => call[0] === '/usr/bin/open')
  const registerIndex = h.calls.findIndex(call => String(call[0]).endsWith('/lsregister'))
  expect(registerIndex).toBeGreaterThanOrEqual(0)
  expect(openIndex).toBeGreaterThan(registerIndex)
  expect(h.calls[openIndex]![2]).toBe(join(APPLICATIONS_ROOT, APP))
})
