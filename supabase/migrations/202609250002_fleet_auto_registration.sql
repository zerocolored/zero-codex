begin;
-- A PC authenticates once. Monitoring-only senders keep their existing scope;
-- registration grants no handoff or administrative rights.
create table public.zerochan_fleet_senders (
 user_id uuid not null references auth.users(id),
 space_id uuid not null references public.zerochan_spaces(id),
 team_id text not null,
 enabled boolean not null default true,
 primary key(user_id,space_id,team_id)
);
alter table public.zerochan_fleet_senders enable row level security;
revoke all on public.zerochan_fleet_senders from public,anon,authenticated;
insert into public.zerochan_fleet_senders(user_id,space_id,team_id)
 select distinct user_id,space_id,team_id from public.zerochan_fleet_instances where enabled;

create function public.zerochan_fleet_context(p_team text)
returns uuid language plpgsql security definer set search_path='' as $$
declare spaces uuid[];
begin
 select array_agg(distinct space_id) into spaces from (
   select space_id from public.zerochan_fleet_senders where user_id=auth.uid() and enabled and team_id=p_team
   union
   select space_id from public.zerochan_members where user_id=auth.uid() and enabled and slack_team_id=p_team
 ) scopes;
 if coalesce(cardinality(spaces),0)=0 then return null; end if;
 if cardinality(spaces)<>1 then raise exception 'ambiguous monitoring space'; end if;
 return spaces[1];
end $$;

create function public.zerochan_fleet_register(p_installation uuid,p_app text,p_team text,p_name text,p_pc text)
returns uuid language plpgsql security definer set search_path='' as $$
declare s uuid; r public.zerochan_fleet_instances;
begin
 s=public.zerochan_fleet_context(p_team);
 if s is null then raise exception 'monitoring authentication not enrolled'; end if;
 if p_installation is null or p_app is null or p_app !~ '^A[A-Z0-9]{1,63}$'
   or p_team is null or p_team !~ '^T[A-Z0-9]{1,63}$'
   or p_name is null or length(p_name) not between 1 and 100
   or p_pc is null or length(p_pc) not between 1 and 100
 then raise exception 'invalid monitoring identity'; end if;
 insert into public.zerochan_fleet_instances(user_id,space_id,installation_id,app_id,team_id,name,pc_label)
 values(auth.uid(),s,p_installation,p_app,p_team,p_name,p_pc)
 on conflict(installation_id,team_id,app_id) do nothing;
 select * into strict r from public.zerochan_fleet_instances
 where installation_id=p_installation and team_id=p_team and app_id=p_app;
 -- Never steal a registration, reset its generation, or revive an admin-disabled row.
 if r.user_id<>auth.uid() or r.space_id<>s or not r.enabled then
   raise exception 'monitoring registration unavailable';
 end if;
 return r.id;
end $$;
revoke all on function public.zerochan_fleet_context(text),public.zerochan_fleet_register(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.zerochan_fleet_context(text),public.zerochan_fleet_register(uuid,text,text,text,text) to authenticated;
commit;
