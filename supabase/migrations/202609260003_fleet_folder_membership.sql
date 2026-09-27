begin;
-- Folder membership is reported automatically by each authenticated instance.
-- Old admin membership tables are retained only for rollback; these RPCs do not consult them.
create table public.zerochan_fleet_folders (
 instance_id uuid primary key references public.zerochan_fleet_instances(id) on delete cascade,
 startup_folder text not null, current_folder text,
 generation bigint not null, sequence bigint not null
);
alter table public.zerochan_fleet_folders enable row level security;
revoke all on public.zerochan_fleet_folders from public,anon,authenticated;

create function public.zerochan_fleet_folder_valid(value text) returns boolean
language sql immutable set search_path='' as $$
 select value is not null and length(value) between 1 and 100 and value !~ '[[:cntrl:]/\\]' and value=normalize(value,NFC)
$$;
revoke all on function public.zerochan_fleet_folder_valid(text) from public,anon,authenticated;

drop function public.zerochan_fleet_project_report(uuid,text,text,bigint,bigint,jsonb);
create function public.zerochan_fleet_project_report(p_id uuid,p_token text,p_project text,p_generation bigint,p_sequence bigint,p_snapshot jsonb,p_current text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.zerochan_fleet_instances; result jsonb;
begin
 select * into i from public.zerochan_fleet_instances where id=p_id for update;
 if not found or not i.enabled or not exists(select 1 from public.zerochan_fleet_credentials c where c.instance_id=i.id
 and c.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and c.expires_at>now()) then return jsonb_build_object('status',401); end if;
 if not public.zerochan_fleet_folder_valid(p_project) or (p_current is not null and not public.zerochan_fleet_folder_valid(p_current))
 or p_snapshot->>'project' is distinct from p_project then return jsonb_build_object('status',400); end if;
 -- The global dashboard labels the same current folder as the work summary.
 result=public.zerochan_fleet_sender_report(p_id,p_token,p_generation,p_sequence,p_snapshot || jsonb_build_object('project',coalesce(p_current,p_project)));
 if result->>'status'<>'200' then return result; end if;
 insert into public.zerochan_fleet_folders values(p_id,p_project,p_current,p_generation,p_sequence)
 on conflict(instance_id) do update set startup_folder=excluded.startup_folder,current_folder=excluded.current_folder,generation=excluded.generation,sequence=excluded.sequence;
 return jsonb_build_object('status',200);
end $$;

create or replace function public.zerochan_fleet_project_status(p_id uuid,p_token text,p_project text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.zerochan_fleet_instances; rows jsonb;
begin
 select * into i from public.zerochan_fleet_instances where id=p_id and enabled;
 if not found or not exists(select 1 from public.zerochan_fleet_credentials c where c.instance_id=i.id
 and c.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and c.expires_at>now()) then return jsonb_build_object('status',401); end if;
 if not public.zerochan_fleet_folder_valid(p_project) then return jsonb_build_object('status',400); end if;
 -- Bind the request to the caller's automatically reported startup/current folder, not model text.
 if not exists(select 1 from public.zerochan_fleet_folders f where f.instance_id=i.id and f.generation=i.generation and f.sequence=i.sequence
 and p_project in (f.startup_folder,f.current_folder)) then return jsonb_build_object('status',403); end if;
 select coalesce(jsonb_agg(row),'[]'::jsonb) into rows from (
 select jsonb_build_object('id',peer.id,'appId',peer.app_id,'name',peer.name,
 'receivedAt',case when f.generation=peer.generation and f.sequence=peer.sequence then peer.received_at else null end,
 'snapshot',case when f.generation<>peer.generation or f.sequence<>peer.sequence then null
 when coalesce(f.current_folder,f.startup_folder)=p_project then peer.snapshot || jsonb_build_object('project',p_project)
 else peer.snapshot || jsonb_build_object('project',p_project,'state',case when peer.snapshot->>'state'='unknown' then 'unknown' else 'waiting' end,
 'queued',0,'summary',null,'summaryAt',null,'lastAcceptedAt',null) end) as row
 from public.zerochan_fleet_folders f
 join public.zerochan_fleet_instances peer on peer.id=f.instance_id and peer.enabled
 where peer.space_id=i.space_id and peer.team_id=i.team_id and p_project in (f.startup_folder,f.current_folder)
 order by peer.name,peer.id limit 100
 ) allowed;
 return jsonb_build_object('status',200,'projectKey',p_project,'projectName',p_project,'serverTime',clock_timestamp(),'instances',rows);
end $$;
revoke all on function public.zerochan_fleet_project_report(uuid,text,text,bigint,bigint,jsonb,text),public.zerochan_fleet_project_status(uuid,text,text) from public,anon,authenticated;
grant execute on function public.zerochan_fleet_project_report(uuid,text,text,bigint,bigint,jsonb,text),public.zerochan_fleet_project_status(uuid,text,text) to anon;
commit;
