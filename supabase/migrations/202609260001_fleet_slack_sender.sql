begin;
-- Reporting-only identities need no Supabase Auth user; existing ownership is retained.
alter table public.zerochan_fleet_instances alter column user_id drop not null;
create table public.zerochan_fleet_credentials (
 instance_id uuid primary key references public.zerochan_fleet_instances(id) on delete cascade,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'), expires_at timestamptz not null
);
create table public.zerochan_fleet_enrollment_attempts (
 space_id uuid not null, ip_hash text not null, window_at timestamptz not null, attempts integer not null,
 primary key(space_id,ip_hash)
);
alter table public.zerochan_fleet_credentials enable row level security;
alter table public.zerochan_fleet_enrollment_attempts enable row level security;
revoke all on public.zerochan_fleet_credentials,public.zerochan_fleet_enrollment_attempts from public,anon,authenticated;

create function public.zerochan_fleet_sender_throttle(p_space uuid,p_gateway text,p_ip text)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer; h text;
begin
 if not exists(select 1 from public.zerochan_fleet_viewers where space_id=p_space
   and gateway_hash=encode(extensions.digest(p_gateway,'sha256'),'hex')) then return false; end if;
 if p_ip is null or length(p_ip)>100 then return false; end if;
 h=encode(extensions.hmac(p_ip,p_gateway,'sha256'),'hex');
 delete from public.zerochan_fleet_enrollment_attempts where window_at<now()-interval '1 day';
 insert into public.zerochan_fleet_enrollment_attempts values(p_space,h,now(),1)
 on conflict(space_id,ip_hash) do update set
 attempts=case when zerochan_fleet_enrollment_attempts.window_at<now()-interval '15 minutes' then 1 else zerochan_fleet_enrollment_attempts.attempts+1 end,
 window_at=case when zerochan_fleet_enrollment_attempts.window_at<now()-interval '15 minutes' then now() else zerochan_fleet_enrollment_attempts.window_at end
 returning attempts into n;
 return n<=60;
end $$;

-- Called only by the trusted Worker after Slack identity verification.
create function public.zerochan_fleet_sender_enroll(p_space uuid,p_gateway text,p_installation uuid,p_app text,p_team text,p_name text,p_pc text,p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.zerochan_fleet_instances; deadline timestamptz=now()+interval '30 days';
begin
 if not exists(select 1 from public.zerochan_fleet_viewers where space_id=p_space
   and gateway_hash=encode(extensions.digest(p_gateway,'sha256'),'hex')) then return jsonb_build_object('status',403); end if;
 if p_installation is null or p_app is null or p_app !~ '^A[A-Z0-9]{1,63}$'
   or p_team is null or p_team !~ '^T[A-Z0-9]{1,63}$' or p_hash is null or p_hash !~ '^[a-f0-9]{64}$'
   or p_name is null or length(p_name) not between 1 and 100 or p_pc is null or length(p_pc) not between 1 and 100
 then return jsonb_build_object('status',400); end if;
 insert into public.zerochan_fleet_instances(space_id,installation_id,app_id,team_id,name,pc_label)
 values(p_space,p_installation,p_app,p_team,p_name,p_pc)
 on conflict(installation_id,team_id,app_id) do nothing;
 select * into strict r from public.zerochan_fleet_instances
 where installation_id=p_installation and team_id=p_team and app_id=p_app for update;
 if r.space_id<>p_space or not r.enabled then return jsonb_build_object('status',403); end if;
 insert into public.zerochan_fleet_credentials values(r.id,p_hash,deadline)
 on conflict(instance_id) do update set token_hash=excluded.token_hash,expires_at=excluded.expires_at;
 return jsonb_build_object('status',200,'instanceId',r.id,'expiresAt',extract(epoch from deadline)*1000);
end $$;

create function public.zerochan_fleet_sender_begin(p_id uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g bigint;
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then return jsonb_build_object('status',401); end if;
 update public.zerochan_fleet_instances i set generation=generation+1,sequence=0
 where i.id=p_id and i.enabled and exists(select 1 from public.zerochan_fleet_credentials c
   where c.instance_id=i.id and c.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and c.expires_at>now())
 returning generation into g;
 if not found then return jsonb_build_object('status',401); end if;
 return jsonb_build_object('status',200,'generation',g);
end $$;

create function public.zerochan_fleet_sender_report(p_id uuid,p_token text,p_generation bigint,p_sequence bigint,p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then return jsonb_build_object('status',401); end if;
 -- Row lock serializes revocation/enrollment and reporting for this identity.
 perform 1 from public.zerochan_fleet_instances i where i.id=p_id and i.enabled and exists(
 select 1 from public.zerochan_fleet_credentials c where c.instance_id=i.id
 and c.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and c.expires_at>now()) for update;
 if not found then return jsonb_build_object('status',401); end if;
 if p_generation is null or p_sequence is null or p_sequence<1 or p_snapshot is null or jsonb_typeof(p_snapshot)<>'object'
 then return jsonb_build_object('status',400); end if;
 if octet_length(p_snapshot::text)>4096 or (select count(*) from jsonb_object_keys(p_snapshot))<>8
 or not p_snapshot ?& array['state','project','queued','lastAcceptedAt','summary','summaryAt','slackConnected','runnerHealthy']
 then return jsonb_build_object('status',400); end if;
 if jsonb_typeof(p_snapshot->'state')<>'string' or p_snapshot->>'state' not in ('available','busy','limited','waiting','unknown')
 or jsonb_typeof(p_snapshot->'project')<>'string' or length(p_snapshot->>'project')>100
 or jsonb_typeof(p_snapshot->'queued')<>'number'
 or jsonb_typeof(p_snapshot->'slackConnected')<>'boolean' or jsonb_typeof(p_snapshot->'runnerHealthy')<>'boolean'
 or jsonb_typeof(p_snapshot->'summary') not in ('string','null') or length(p_snapshot->>'summary')>700
 or jsonb_typeof(p_snapshot->'lastAcceptedAt') not in ('number','null') or jsonb_typeof(p_snapshot->'summaryAt') not in ('number','null')
 then return jsonb_build_object('status',400); end if;
 if (p_snapshot->>'queued')::numeric not between 0 and 1000000
 or trunc((p_snapshot->>'queued')::numeric)<>(p_snapshot->>'queued')::numeric
 or (p_snapshot->>'lastAcceptedAt')::numeric not between 0 and 8640000000000000
 or (p_snapshot->>'summaryAt')::numeric not between 0 and 8640000000000000
 then return jsonb_build_object('status',400); end if;
 update public.zerochan_fleet_instances set sequence=p_sequence,snapshot=p_snapshot,received_at=clock_timestamp()
 where id=p_id and generation=p_generation and sequence<p_sequence;
 if not found then return jsonb_build_object('status',409); end if;
 return jsonb_build_object('status',200);
end $$;
revoke all on function public.zerochan_fleet_sender_throttle(uuid,text,text),
 public.zerochan_fleet_sender_enroll(uuid,text,uuid,text,text,text,text,text),
 public.zerochan_fleet_sender_begin(uuid,text),public.zerochan_fleet_sender_report(uuid,text,bigint,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.zerochan_fleet_sender_throttle(uuid,text,text),
 public.zerochan_fleet_sender_enroll(uuid,text,uuid,text,text,text,text,text),
 public.zerochan_fleet_sender_begin(uuid,text),public.zerochan_fleet_sender_report(uuid,text,bigint,bigint,jsonb) to anon;
commit;
