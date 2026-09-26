begin;
-- Admin-owned project identities and app membership. Reporter self-registration grants NO project membership.
create table public.zerochan_fleet_projects (
 space_id uuid not null references public.zerochan_spaces(id), project_key text not null check(project_key ~ '^[a-f0-9]{64}$'),
 name text not null check(length(name) between 1 and 100), primary key(space_id,project_key)
);
create table public.zerochan_fleet_project_apps (
 space_id uuid not null, project_key text not null, team_id text not null, app_id text not null,
 primary key(space_id,project_key,team_id,app_id),
 foreign key(space_id,project_key) references public.zerochan_fleet_projects(space_id,project_key) on delete cascade
);
create table public.zerochan_fleet_project_reports (
 instance_id uuid not null references public.zerochan_fleet_instances(id) on delete cascade,
 project_key text not null, generation bigint not null, sequence bigint not null,
 snapshot jsonb not null, received_at timestamptz not null, primary key(instance_id,project_key)
);
alter table public.zerochan_fleet_projects enable row level security;
alter table public.zerochan_fleet_project_apps enable row level security;
alter table public.zerochan_fleet_project_reports enable row level security;
revoke all on public.zerochan_fleet_projects,public.zerochan_fleet_project_apps,public.zerochan_fleet_project_reports from public,anon,authenticated;

create function public.zerochan_fleet_project_report(p_id uuid,p_token text,p_project text,p_generation bigint,p_sequence bigint,p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.zerochan_fleet_instances; result jsonb;
begin
 select * into i from public.zerochan_fleet_instances where id=p_id for update;
 if not found or not i.enabled or not exists(select 1 from public.zerochan_fleet_credentials c where c.instance_id=i.id
 and c.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and c.expires_at>now()) then return jsonb_build_object('status',401); end if;
 if not exists(select 1 from public.zerochan_fleet_project_apps a where a.space_id=i.space_id and a.project_key=p_project and a.team_id=i.team_id and a.app_id=i.app_id)
 then return jsonb_build_object('status',403); end if;
 -- Existing sender validation is the canonical snapshot contract. This also advances the shared generation/sequence.
 result=public.zerochan_fleet_sender_report(p_id,p_token,p_generation,p_sequence,p_snapshot);
 if result->>'status'<>'200' then return result; end if;
 insert into public.zerochan_fleet_project_reports values(p_id,p_project,p_generation,p_sequence,p_snapshot,clock_timestamp())
 on conflict(instance_id,project_key) do update set generation=excluded.generation,sequence=excluded.sequence,snapshot=excluded.snapshot,received_at=excluded.received_at;
 return jsonb_build_object('status',200);
end $$;

create function public.zerochan_fleet_project_status(p_id uuid,p_token text,p_project text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.zerochan_fleet_instances; label text; rows jsonb;
begin
 select * into i from public.zerochan_fleet_instances where id=p_id and enabled;
 if not found or not exists(select 1 from public.zerochan_fleet_credentials c where c.instance_id=i.id
 and c.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and c.expires_at>now()) then return jsonb_build_object('status',401); end if;
 if not exists(select 1 from public.zerochan_fleet_project_apps a where a.space_id=i.space_id and a.project_key=p_project and a.team_id=i.team_id and a.app_id=i.app_id)
 then return jsonb_build_object('status',403); end if;
 select name into label from public.zerochan_fleet_projects where space_id=i.space_id and project_key=p_project;
 select coalesce(jsonb_agg(row),'[]'::jsonb) into rows from (
 select jsonb_build_object('id',peer.id,'appId',peer.app_id,'name',peer.name,
 'receivedAt',case when r.generation=peer.generation and r.sequence=peer.sequence then r.received_at else null end,
 'snapshot',case when r.generation=peer.generation and r.sequence=peer.sequence then r.snapshot else null end) as row
 from public.zerochan_fleet_project_reports r
 join public.zerochan_fleet_instances peer on peer.id=r.instance_id and peer.enabled
 join public.zerochan_fleet_project_apps a on a.space_id=peer.space_id and a.team_id=peer.team_id and a.app_id=peer.app_id and a.project_key=r.project_key
 where peer.space_id=i.space_id and r.project_key=p_project
 order by peer.name,peer.id limit 100
 ) allowed;
 return jsonb_build_object('status',200,'projectKey',p_project,'projectName',label,'serverTime',clock_timestamp(),'instances',rows);
end $$;
revoke all on function public.zerochan_fleet_project_report(uuid,text,text,bigint,bigint,jsonb),public.zerochan_fleet_project_status(uuid,text,text) from public,anon,authenticated;
grant execute on function public.zerochan_fleet_project_report(uuid,text,text,bigint,bigint,jsonb),public.zerochan_fleet_project_status(uuid,text,text) to anon;
commit;
