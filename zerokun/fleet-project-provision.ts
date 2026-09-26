#!/usr/bin/env -S bun --config=/dev/null --no-env-file
import {listRegisteredSlackApps} from './slack-app-registry.ts'
import {readLastConnectedProject} from './project-selection.ts'
import {fleetProject} from './fleet-project.ts'

/** Administrator-only SQL proposal from confirmed local app/project bindings; never executes SQL or reads tokens. */
export function fleetProjectProvisionSql(): string {
  const statements=['begin;']
  for(const app of listRegisteredSlackApps()) {
    const last=readLastConnectedProject(app.stateDir)
    const project=last?fleetProject(last.projectDir):null
    if(!project)continue
    const label=project.label.replaceAll("'","''")
    statements.push(`insert into public.zerochan_fleet_projects(space_id,project_key,name) select distinct space_id,'${project.key}','${label}' from public.zerochan_fleet_instances where app_id='${app.appId}' and enabled on conflict do nothing;`)
    statements.push(`insert into public.zerochan_fleet_project_apps(space_id,project_key,team_id,app_id) select distinct space_id,'${project.key}',team_id,app_id from public.zerochan_fleet_instances where app_id='${app.appId}' and enabled on conflict do nothing;`)
  }
  return [...statements,'commit;'].join('\n')
}
if(import.meta.main)console.log(fleetProjectProvisionSql())
