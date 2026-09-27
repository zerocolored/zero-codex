begin;
-- Registration is not a project launch. Retain accepted project evidence across
-- legacy begin(), which intentionally clears the latest snapshot/received_at.
alter table public.zerochan_fleet_instances add column project_seen_at timestamptz;

update public.zerochan_fleet_instances i
set project_seen_at=coalesce(i.received_at,clock_timestamp())
where (jsonb_typeof(i.snapshot->'project')='string' and i.snapshot->>'project' !~ '^[[:space:]]*$')
 or exists(select 1 from public.zerochan_fleet_folders f where f.instance_id=i.id
   and (f.startup_folder !~ '^[[:space:]]*$' or f.current_folder !~ '^[[:space:]]*$'))
 or exists(select 1 from public.zerochan_fleet_project_reports r where r.instance_id=i.id
   and jsonb_typeof(r.snapshot->'project')='string' and r.snapshot->>'project' !~ '^[[:space:]]*$');

-- Runs only when the existing authenticated report RPC actually updates a row;
-- rejected credentials, generations and sequences cannot create launch evidence.
create function public.zerochan_fleet_mark_project_seen()
returns trigger language plpgsql set search_path='' as $$
begin
 if new.project_seen_at is null and new.received_at is not null
   and jsonb_typeof(new.snapshot->'project')='string'
   and new.snapshot->>'project' !~ '^[[:space:]]*$' then
  new.project_seen_at=clock_timestamp();
 end if;
 return new;
end $$;
revoke all on function public.zerochan_fleet_mark_project_seen() from public,anon,authenticated;
create trigger zerochan_fleet_project_seen
 before insert or update of snapshot,received_at on public.zerochan_fleet_instances
 for each row execute function public.zerochan_fleet_mark_project_seen();

create or replace function public.zerochan_fleet_list(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s uuid; rows jsonb; hidden bigint;
begin
 select space_id into s from public.zerochan_fleet_sessions
 where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and expires_at>now();
 if s is null then return jsonb_build_object('status',401); end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'appId',app_id,'teamId',team_id,'installationId',installation_id,
   'name',name,'pc',pc_label,'receivedAt',received_at,'snapshot',snapshot) order by name,id)
   filter(where project_seen_at is not null),'[]'::jsonb), count(*) filter(where project_seen_at is null)
 into rows,hidden from public.zerochan_fleet_instances where space_id=s and enabled;
 return jsonb_build_object('status',200,'serverTime',clock_timestamp(),'instances',rows,'hidden',hidden);
end $$;
commit;
