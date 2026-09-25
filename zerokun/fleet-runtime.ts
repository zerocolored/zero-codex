import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { z } from 'zod'
import { atomicWritePrivateFile, readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'
import { CloudHandoffClient, readCloudConfig } from './cloud-handoff.ts'
import { projectFleetStatus, startFleetReporter, type FleetLocalFacts } from './fleet-status.ts'
import { listRegisteredSlackApps, readRegisteredSlackApp } from './slack-app-registry.ts'

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
export function fleetIsOff(state: string): boolean {
  return existsSync(join(state, 'fleet.off.json'))
    || (!existsSync(join(state, 'fleet.json')) && existsSync(join(state, 'fleet.disabled.json')))
}
type FleetRegistration = z.infer<typeof registrationSchema>
type FleetOptions = {
  teamId?: string; name?: string; home?: string; fetcher?: typeof fetch; now?: () => number
  warn?: (message: string) => void
}
/** Discover references, never duplicate rotating credentials or choose an arbitrary tenant. */
export async function discoverFleetAuth(state: string, teamId: string, home: string, fetcher: typeof fetch): Promise<string> {
  const own = listRegisteredSlackApps(home).find(app => app.stateDir === state)
  const apps = listRegisteredSlackApps(home)
  const candidates = apps.filter(app => existsSync(fleetAuthPath(state, app.appId, home)))
  const scopes = new Map<string, string>()
  for (const app of own && candidates.some(candidate => candidate.appId === own.appId) ? [own] : candidates) {
    const path = fleetAuthPath(state, app.appId, home), auth = readCloudConfig(path)
    const scope = await new CloudHandoffClient(auth, fetcher, path).fleetRpc('context', { p_team: teamId })
    if (scope !== null) scopes.set(`${auth.url}:${z.string().uuid().parse(scope)}`, app.appId)
  }
  if (scopes.size !== 1) throw new Error(scopes.size ? 'ambiguous monitoring account' : 'monitoring authentication unavailable')
  return scopes.values().next().value!
}
export function startConfiguredFleet(state: string, appId: string, project: string, facts: () => FleetLocalFacts, connected: () => boolean,
  options: FleetOptions = {}) {
  if (fleetIsOff(state)) return null
  const home = options.home ?? homedir(), fetcher = options.fetcher ?? fetch
  let config: FleetRegistration | undefined
  let warned = false
  const warn = options.warn ?? (message => process.stderr.write(message + '\n'))
  const client = () => {
    if (!config) throw new Error('monitoring registration pending')
    const authPath = fleetAuthPath(state, config.authAppId, home)
    return new CloudHandoffClient(readCloudConfig(authPath), fetcher, authPath)
  }
  return startFleetReporter({
      now: options.now,
      begin: async () => {
       try {
        if (fleetIsOff(state)) throw new Error('monitoring disabled')
        const installationId = fleetInstallationId(home)
        const text = readOptionalBoundedOwnerOnlyRegularFile(join(state, 'fleet.json'), 4096)
        const saved = text ? registrationSchema.parse(JSON.parse(text)) : undefined
        if (saved && saved.appId !== appId) throw new Error('app mismatch')
        config = saved?.installationId === installationId ? saved : undefined
        if (!config) {
          const teamId = z.string().regex(/^T[A-Z0-9]+$/).parse(options.teamId)
          const authAppId = await discoverFleetAuth(state, teamId, home, fetcher)
          const path = fleetAuthPath(state, authAppId, home)
          const id = await new CloudHandoffClient(readCloudConfig(path), fetcher, path).fleetRpc('register', {
            p_installation: installationId, p_app: appId, p_team: teamId,
            p_name: options.name?.slice(0, 100) || appId,
            p_pc: `${process.platform === 'darwin' ? 'Mac' : 'PC'} ${installationId.slice(0, 8)}`,
          })
          config = registrationSchema.parse({ instanceId: id, installationId, appId, authAppId,
            ...(saved?.projectLabel ? { projectLabel: saved.projectLabel } : {}) })
          if (fleetIsOff(state)) throw new Error('monitoring disabled')
          atomicWritePrivateFile(join(state, 'fleet.json'), JSON.stringify(config) + '\n')
        }
        const result = await client().fleetRpc('begin', { p_id: config.instanceId, p_installation: config.installationId, p_app: appId })
        if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1) throw new Error('registration unavailable')
        warned = false
        return result
       } catch (error) {
         if (!warned) { warned = true; warn('稼働状況の自動登録・接続を再試行します。クラウド認証と接続を確認してください。本体の作業は継続します。') }
         throw error
       }
      },
      snapshot: () => {
        let runnerHealthy = false, paused = true
        try {
          const pulse = JSON.parse(readOptionalBoundedOwnerOnlyRegularFile(join(state, 'fleet-runner.json'), 1024) ?? '{}')
          runnerHealthy = Number.isFinite(pulse.at) && Date.now() - pulse.at >= 0 && Date.now() - pulse.at < 35_000
          paused = pulse.paused !== false
        } catch {}
        return projectFleetStatus(facts(), { project: config?.projectLabel ?? basename(project),
          slackConnected: connected(), runnerHealthy, paused })
      },
      send: async (generation, sequence, snapshot) => {
        if (fleetIsOff(state)) return
        if (!config) throw new Error('monitoring registration pending')
        const result = await client().fleetRpc('report', { p_id: config.instanceId, p_generation: generation, p_sequence: sequence, p_snapshot: snapshot })
        if (result !== true) throw new Error('stale monitoring generation')
      },
    })
}
