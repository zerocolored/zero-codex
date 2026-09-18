import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

// codex のカスタム権限サンドボックスは CoreAudio への mach lookup を封じるため、
// ジョブ内の afplay は AudioQueueStart 失敗（SIGABRT）で必ず落ちる。実機E2Eの
// 音声再生だけを、非サンドボックスのランナー側で肩代わりする file протокол。
//
// ジョブ側: <scratchDir>/zerokun-audio/request-<nonce>.json に {"wav": "<絶対パス>"}
// を書く。ランナーが afplay を実行し、result-<nonce>.json へ
// {"startedAtMs","endedAtMs","exitCode"} または {"error"} を書き戻す。
// wav は scratch / artifact 配下の実ファイルに限定し、引数は一切通さない。

export const AUDIO_BRIDGE_DIR = 'zerokun-audio'
const REQUEST_PATTERN = /^request-([A-Za-z0-9_-]{1,64})\.json$/
const MAX_WAV_BYTES = 64 * 1024 * 1024

export interface AudioBridgePlayer {
  (wavPath: string): Promise<number>
}

const defaultPlayer: AudioBridgePlayer = async wavPath => {
  const child = Bun.spawn(['/usr/bin/afplay', wavPath], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  })
  return await child.exited
}

function pathContainedIn(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

export function startComputerUseAudioBridge(options: {
  scratchDir: string
  artifactDir: string
  player?: AudioBridgePlayer
  pollMs?: number
}): { stop: () => void } {
  const scratchRoot = realpathSync(options.scratchDir)
  const artifactRoot = realpathSync(options.artifactDir)
  const bridgeDir = join(scratchRoot, AUDIO_BRIDGE_DIR)
  mkdirSync(bridgeDir, { recursive: true })
  const player = options.player ?? defaultPlayer
  const handled = new Set<string>()
  let playing = false
  let stopped = false

  const resultPath = (nonce: string) => join(bridgeDir, `result-${nonce}.json`)

  const resolveWav = (raw: unknown): string => {
    if (typeof raw !== 'string' || raw.trim() === '' || !raw.startsWith('/')) {
      throw new Error('wav must be an absolute path string')
    }
    const requested = resolve(raw)
    if (!existsSync(requested)) throw new Error('wav does not exist')
    const physical = realpathSync(requested)
    if (!lstatSync(physical).isFile()) throw new Error('wav is not a regular file')
    if (!pathContainedIn(scratchRoot, physical) && !pathContainedIn(artifactRoot, physical)) {
      throw new Error('wav must live under the attempt scratch or artifact directory')
    }
    if (lstatSync(physical).size > MAX_WAV_BYTES) throw new Error('wav exceeds the size limit')
    return physical
  }

  const tick = async () => {
    if (stopped || playing) return
    let entries: string[]
    try {
      entries = readdirSync(bridgeDir)
    } catch {
      return
    }
    for (const entry of entries.sort()) {
      const match = REQUEST_PATTERN.exec(entry)
      if (!match) continue
      const nonce = match[1]!
      if (handled.has(nonce) || existsSync(resultPath(nonce))) {
        handled.add(nonce)
        continue
      }
      handled.add(nonce)
      playing = true
      const startedAtMs = Date.now()
      try {
        const parsed = JSON.parse(readFileSync(join(bridgeDir, entry), 'utf8')) as { wav?: unknown }
        const wavPath = resolveWav(parsed.wav)
        const exitCode = await player(wavPath)
        writeFileSync(resultPath(nonce), JSON.stringify({
          startedAtMs,
          endedAtMs: Date.now(),
          exitCode,
        }))
      } catch (error) {
        writeFileSync(resultPath(nonce), JSON.stringify({
          startedAtMs,
          endedAtMs: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }))
      } finally {
        playing = false
      }
      break
    }
  }

  const timer = setInterval(() => { void tick() }, options.pollMs ?? 500)
  void tick()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
