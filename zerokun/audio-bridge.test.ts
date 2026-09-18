import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AUDIO_BRIDGE_DIR, startComputerUseAudioBridge } from './audio-bridge.ts'

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for bridge result')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
}

describe('computer-use audio bridge', () => {
  test('scratch配下のwav要求だけを再生し、範囲外・不正はerror結果にする', async () => {
    const root = mkdtempSync(join(tmpdir(), 'audio-bridge-'))
    const scratch = join(root, 'scratch')
    const artifact = join(root, 'artifact')
    mkdirSync(scratch, { recursive: true })
    mkdirSync(artifact, { recursive: true })
    const wav = join(scratch, 'b03.wav')
    writeFileSync(wav, 'RIFF-fixture')
    const outside = join(root, 'outside.wav')
    writeFileSync(outside, 'RIFF-outside')

    const played: string[] = []
    const bridge = startComputerUseAudioBridge({
      scratchDir: scratch,
      artifactDir: artifact,
      pollMs: 20,
      player: async path => {
        played.push(path)
        return 0
      },
    })
    try {
      const bridgeDir = join(scratch, AUDIO_BRIDGE_DIR)
      // 正常系
      writeFileSync(join(bridgeDir, 'request-ok1.json'), JSON.stringify({ wav }))
      await waitFor(() => played.length === 1)
      await waitFor(() => {
        try {
          return JSON.parse(readFileSync(join(bridgeDir, 'result-ok1.json'), 'utf8')).exitCode === 0
        } catch {
          return false
        }
      })
      const ok = JSON.parse(readFileSync(join(bridgeDir, 'result-ok1.json'), 'utf8'))
      expect(ok.exitCode).toBe(0)
      expect(ok.endedAtMs).toBeGreaterThanOrEqual(ok.startedAtMs)

      // scratch/artifact 外は拒否（symlink での持ち出しも実体で判定）
      const sneaky = join(scratch, 'sneaky.wav')
      symlinkSync(outside, sneaky)
      writeFileSync(join(bridgeDir, 'request-out1.json'), JSON.stringify({ wav: sneaky }))
      await waitFor(() => {
        try {
          return typeof JSON.parse(readFileSync(join(bridgeDir, 'result-out1.json'), 'utf8')).error === 'string'
        } catch {
          return false
        }
      })
      expect(JSON.parse(readFileSync(join(bridgeDir, 'result-out1.json'), 'utf8')).error)
        .toContain('scratch or artifact')

      // 相対パス・非文字列は error
      writeFileSync(join(bridgeDir, 'request-bad1.json'), JSON.stringify({ wav: 'relative.wav' }))
      await waitFor(() => {
        try {
          return typeof JSON.parse(readFileSync(join(bridgeDir, 'result-bad1.json'), 'utf8')).error === 'string'
        } catch {
          return false
        }
      })

      // 再生は正常系の1回だけ（bridge は実体パスで再生する）
      expect(played).toEqual([realpathSync(wav)])
    } finally {
      bridge.stop()
    }
  })
})
