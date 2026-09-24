import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { z } from 'zod'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { CloudHandoffClient, readCloudConfig } from './cloud-handoff.ts'
import { projectFleetStatus, startFleetReporter, type FleetLocalFacts } from './fleet-status.ts'
import { readRegisteredSlackApp } from './slack-app-registry.ts'

export const registrationSchema = z.object({
  instanceId: z.string().uuid(), installationId: z.string().uuid(), appId: z.string().regex(/^A[A-Z0-9]+$/),
  projectLabel: z.string().min(1).max(100).optional(),
  authAppId: z.string().regex(/^A[A-Z0-9]+$/).optional(),
}).strict()
/** A machine-local random identity, not a hostname or an OS username. */
export function fleetInstallationId(home = homedir()): string {
  const root = join(home, '.codex', 'zerochan-fleet')
  const path = join(root, 'installation.json')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (!existsSync(path)) {
    try { writeFileSync(path, JSON.stringify({ id: crypto.randomUUID() }), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  return z.object({ id: z.string().uuid() }).parse(JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(path, 1024)!)).id
}
export function fleetAuthPath(state: string, authAppId?: string, home = homedir()): string {
  if (!authAppId) return join(state, 'fleet-auth.json')
  const app = readRegisteredSlackApp(authAppId, home)
  if (!app) throw new Error('Monitoring authentication app is not registered')
  // Share the SAME session file and refresh lock; never copy rotating refresh tokens.
  const active = join(app.stateDir, 'cloud-auth.json')
  return existsSync(active) ? active : join(app.stateDir, 'cloud-auth.pending.json')
}
export function startFleetRunnerPulse(state: string, paused: () => boolean) {
  const path = join(state, 'fleet-runner.json')
  const write = () => { try {
    if (existsSync(join(state, 'fleet.json'))) atomicWritePrivateFile(path, JSON.stringify({ at: Date.now(), paused: paused() }))
  } catch { /* Monitoring never stops the runner. */ } }
  write()
  const timer = setInterval(write, 10_000); timer.unref()
  return () => { clearInterval(timer); try { if (existsSync(path)) atomicWritePrivateFile(path, JSON.stringify({ at: 0, paused: true })) } catch {} }
}
export function startConfiguredFleet(state: string, appId: string, project: string, facts: () => FleetLocalFacts, connected: () => boolean) {
  try {
    const text = readOptionalBoundedOwnerOnlyRegularFile(join(state, 'fleet.json'), 4096)
    if (!text) return null
    const config = registrationSchema.parse(JSON.parse(text))
    if (config.appId !== appId) throw new Error('app mismatch')
    if (config.installationId !== fleetInstallationId()) throw new Error('registration belongs to another PC')
    // Monitoring auth is explicitly installed separately from handoff activation.
    const client = () => {
      // cloud activate can rename pending -> active while other apps keep running.
      const authPath = fleetAuthPath(state, config.authAppId)
      return new CloudHandoffClient(readCloudConfig(authPath), fetch, authPath)
    }
    return startFleetReporter({
      begin: async () => {
        const result = await client().fleetRpc('begin', { p_id: config.instanceId, p_installation: config.installationId, p_app: appId })
        if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1) throw new Error('registration unavailable')
        return result
      },
      snapshot: () => {
        let runnerHealthy = false, paused = true
        try {
          const pulse = JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(join(state, 'fleet-runner.json'), 1024) ?? '{}')
          runnerHealthy = Number.isFinite(pulse.at) && Date.now() - pulse.at >= 0 && Date.now() - pulse.at < 35_000
          paused = pulse.paused !== false
        } catch {}
        return projectFleetStatus(facts(), { project: config.projectLabel ?? basename(project),
          slackConnected: connected(), runnerHealthy, paused })
      },
      send: async (generation, sequence, snapshot) => {
        const result = await client().fleetRpc('report', { p_id: config.instanceId, p_generation: generation, p_sequence: sequence, p_snapshot: snapshot })
        if (result !== true) throw new Error('stale monitoring generation')
      },
    })
  } catch { process.stderr.write('稼働状況ページの送信設定を読み込めません。本体の作業は継続します。\n'); return null }
}
