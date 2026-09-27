begin;
-- Registration is admin-only; sender identity never comes from a heartbeat.
create table public.zerochan_fleet_instances (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 space_id uuid not null references public.zerochan_spaces(id),
 installation_id uuid not null, app_id text not null, team_id text not null,
 name text not null check(length(name) between 1 and 100),
 pc_label text not null check(length(pc_label) between 1 and 100),
 enabled boolean not null default true,
 generation bigint not null default 0, sequence bigint not null default 0,
 received_at timestamptz, snapshot jsonb,
 unique(installation_id,team_id,app_id)
);
alter table public.zerochan_fleet_instances enable row level security;
revoke all on public.zerochan_fleet_instances from public,anon,authenticated;

create function public.zerochan_fleet_begin(p_id uuid,p_installation uuid,p_app text)
returns bigint language plpgsql security definer set search_path='' as $$
declare g bigint;
begin
 update public.zerochan_fleet_instances set generation=generation+1,sequence=0,received_at=null,snapshot=null
 where id=p_id and user_id=auth.uid() and enabled and installation_id=p_installation and app_id=p_app
 returning generation into g;
 if not found then raise exception 'fleet registration unavailable'; end if;
 return g;
end $$;
create function public.zerochan_fleet_report(p_id uuid,p_generation bigint,p_sequence bigint,p_snapshot jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_sequence<1 or p_snapshot is null or jsonb_typeof(p_snapshot)<>'object'
   or octet_length(p_snapshot::text)>4096
   or (select count(*) from jsonb_object_keys(p_snapshot))<>8
   or not p_snapshot ?& array['state','project','queued','lastAcceptedAt','summary','summaryAt','slackConnected','runnerHealthy']
 then raise exception 'invalid fleet snapshot'; end if;
 -- The schema below is intentionally a small public projection, not a log upload.
 if jsonb_typeof(p_snapshot->'state')<>'string' or p_snapshot->>'state' not in ('available','busy','limited','waiting','unknown')
   or jsonb_typeof(p_snapshot->'project')<>'string' or length(p_snapshot->>'project')>100
   or jsonb_typeof(p_snapshot->'queued')<>'number' or (p_snapshot->>'queued')::numeric not between 0 and 1000000
   or jsonb_typeof(p_snapshot->'slackConnected')<>'boolean' or jsonb_typeof(p_snapshot->'runnerHealthy')<>'boolean'
   or jsonb_typeof(p_snapshot->'summary') not in ('string','null') or length(p_snapshot->>'summary')>700
   or jsonb_typeof(p_snapshot->'lastAcceptedAt') not in ('number','null')
   or jsonb_typeof(p_snapshot->'summaryAt') not in ('number','null')
 then raise exception 'invalid fleet fields'; end if;
 if (p_snapshot->>'lastAcceptedAt')::numeric not between 0 and 8640000000000000
   or (p_snapshot->>'summaryAt')::numeric not between 0 and 8640000000000000
   or trunc((p_snapshot->>'queued')::numeric)<>(p_snapshot->>'queued')::numeric
 then raise exception 'invalid fleet values'; end if;
 update public.zerochan_fleet_instances set sequence=p_sequence,snapshot=p_snapshot,received_at=clock_timestamp()
 where id=p_id and user_id=auth.uid() and enabled and generation=p_generation and sequence<p_sequence;
 return found;
end $$;

-- Separate read-only viewer authentication; no handoff rights or admin key.
create table public.zerochan_fleet_viewers (
 space_id uuid primary key references public.zerochan_spaces(id),
 password_hash text not null, gateway_hash text not null
);
create table public.zerochan_fleet_sessions (
 token_hash text primary key, space_id uuid not null references public.zerochan_fleet_viewers(space_id),
 expires_at timestamptz not null
);
create table public.zerochan_fleet_login_attempts (
 space_id uuid not null, ip_hash text not null, window_at timestamptz not null, attempts integer not null,
 primary key(space_id,ip_hash)
);
alter table public.zerochan_fleet_viewers enable row level security;
alter table public.zerochan_fleet_sessions enable row level security;
alter table public.zerochan_fleet_login_attempts enable row level security;
revoke all on public.zerochan_fleet_viewers,public.zerochan_fleet_sessions,public.zerochan_fleet_login_attempts from public,anon,authenticated;

create function public.zerochan_fleet_login(p_space uuid,p_gateway text,p_ip text,p_password text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.zerochan_fleet_viewers; n integer; token text;
begin
 select * into v from public.zerochan_fleet_viewers where space_id=p_space;
 if not found or v.gateway_hash is distinct from encode(extensions.digest(p_gateway,'sha256'),'hex') then return jsonb_build_object('status',503); end if;
 if p_ip is null or p_ip !~ '^[a-f0-9]{64}$' or p_password is null or octet_length(p_password) not between 1 and 72 then return jsonb_build_object('status',400); end if;
 delete from public.zerochan_fleet_login_attempts where window_at<now()-interval '1 day';
 delete from public.zerochan_fleet_sessions where expires_at<now();
 insert into public.zerochan_fleet_login_attempts values(p_space,p_ip,now(),1)
 on conflict(space_id,ip_hash) do update set
 attempts=case when zerochan_fleet_login_attempts.window_at<now()-interval '15 minutes' then 1 else zerochan_fleet_login_attempts.attempts+1 end,
 window_at=case when zerochan_fleet_login_attempts.window_at<now()-interval '15 minutes' then now() else zerochan_fleet_login_attempts.window_at end
 returning attempts into n;
 if n>10 then return jsonb_build_object('status',429); end if;
 if extensions.crypt(p_password,v.password_hash)<>v.password_hash then return jsonb_build_object('status',401); end if;
 token=encode(extensions.gen_random_bytes(32),'hex');
 insert into public.zerochan_fleet_sessions values(encode(extensions.digest(token,'sha256'),'hex'),p_space,now()+interval '7 days');
 return jsonb_build_object('status',200,'token',token);
end $$;
create function public.zerochan_fleet_list(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s uuid; rows jsonb;
begin
 select space_id into s from public.zerochan_fleet_sessions where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and expires_at>now();
 if s is null then return jsonb_build_object('status',401); end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'appId',app_id,'teamId',team_id,'installationId',installation_id,
 'name',name,'pc',pc_label,'receivedAt',received_at,'snapshot',snapshot) order by name,id),'[]'::jsonb)
 into rows from public.zerochan_fleet_instances where space_id=s and enabled;
 return jsonb_build_object('status',200,'serverTime',clock_timestamp(),'instances',rows);
end $$;
create function public.zerochan_fleet_logout(p_token text)
returns void language sql security definer set search_path='' as $$
 delete from public.zerochan_fleet_sessions where token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
$$;
revoke all on function public.zerochan_fleet_begin(uuid,uuid,text),public.zerochan_fleet_report(uuid,bigint,bigint,jsonb),
 public.zerochan_fleet_login(uuid,text,text,text),public.zerochan_fleet_list(text),public.zerochan_fleet_logout(text) from public,anon,authenticated;
grant execute on function public.zerochan_fleet_begin(uuid,uuid,text),public.zerochan_fleet_report(uuid,bigint,bigint,jsonb) to authenticated;
grant execute on function public.zerochan_fleet_login(uuid,text,text,text),public.zerochan_fleet_list(text),public.zerochan_fleet_logout(text) to anon;
commit;
