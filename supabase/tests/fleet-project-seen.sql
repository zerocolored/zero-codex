\set ON_ERROR_STOP on
-- Disposable DB only, after migrations through 202609260003 (not 202609270001).
insert into auth.users values('10000000-0000-0000-0000-000000000077');
insert into public.zerochan_spaces values('20000000-0000-0000-0000-000000000077');
insert into public.zerochan_fleet_viewers values('20000000-0000-0000-0000-000000000077',extensions.crypt('fixture-password',extensions.gen_salt('bf')),encode(extensions.digest('fixture-gateway','sha256'),'hex'));
insert into public.zerochan_fleet_instances(id,user_id,space_id,installation_id,app_id,team_id,name,pc_label,snapshot,received_at)
select ('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'10000000-0000-0000-0000-000000000077','20000000-0000-0000-0000-000000000077',
 ('40000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'ATEST','TTEST','Test '||n,'PC '||n,
 case when n=771 then '{"project":"demo"}'::jsonb when n=772 then '{"project":""}'::jsonb when n=773 then '{"project":" \t "}'::jsonb else null end,
 case when n in(771,772,773) then now()-interval '2 days' else null end
from generate_series(771,777) n;
-- Historical whitespace-only folder membership must not count as project evidence.
insert into public.zerochan_fleet_folders values('30000000-0000-0000-0000-000000000773','   ',E'\t',1,1);
-- Accepted folder history remains useful even after legacy begin cleared snapshot.
insert into public.zerochan_fleet_folders values('30000000-0000-0000-0000-000000000774','demo',null,1,1);
insert into public.zerochan_fleet_project_reports values('30000000-0000-0000-0000-000000000775',repeat('a',64),1,1,'{"project":"old-demo"}',now()-interval '2 days');
\ir ../migrations/202609270001_fleet_project_seen.sql
begin;
do $$begin
 if (select count(*) from public.zerochan_fleet_instances where project_seen_at is not null)<>3 then raise exception 'backfill must include valid snapshots/folders/old reports only'; end if;
end $$;
-- Viewer: no launch evidence, including an empty historical report, stays hidden.
set local role anon;
do $$declare t text; r jsonb; begin
 t=public.zerochan_fleet_login('20000000-0000-0000-0000-000000000077','fixture-gateway',repeat('a',64),'fixture-password')->>'token';
 r=public.zerochan_fleet_list(t);
 if jsonb_array_length(r->'instances')<>3 or (r->>'hidden')::int<>4 then raise exception 'wrong initial visibility %',r;end if;
 if public.zerochan_fleet_list('invalid')->>'status'<>'401' then raise exception 'unauthenticated list';end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000077',true);
do $$declare g bigint; begin
 g=public.zerochan_fleet_begin('30000000-0000-0000-0000-000000000776','40000000-0000-0000-0000-000000000776','ATEST');
 if not public.zerochan_fleet_report('30000000-0000-0000-0000-000000000776',g,1,'{"state":"available","project":"demo","queued":0,"lastAcceptedAt":null,"summary":null,"summaryAt":null,"slackConnected":true,"runnerHealthy":true}') then raise exception 'legacy report';end if;
 perform public.zerochan_fleet_begin('30000000-0000-0000-0000-000000000776','40000000-0000-0000-0000-000000000776','ATEST');
end $$;
reset role;
do $$begin
 if not exists(select 1 from public.zerochan_fleet_instances where id='30000000-0000-0000-0000-000000000776' and project_seen_at is not null and snapshot is null and received_at is null) then raise exception 'restart lost launch evidence';end if;
end $$;
insert into public.zerochan_fleet_credentials values('30000000-0000-0000-0000-000000000777',encode(extensions.digest(repeat('c',64),'sha256'),'hex'),now()+interval '1 day');
set local role anon;
do $$declare g bigint; snap jsonb; r jsonb; begin
 g=(public.zerochan_fleet_sender_begin('30000000-0000-0000-0000-000000000777',repeat('c',64))->>'generation')::bigint;
 snap='{"state":"available","project":"demo","queued":0,"lastAcceptedAt":null,"summary":null,"summaryAt":null,"slackConnected":true,"runnerHealthy":true}';
 r=public.zerochan_fleet_sender_report('30000000-0000-0000-0000-000000000777',repeat('d',64),g,1,snap);
 if r->>'status'='200' then raise exception 'bad credential accepted';end if;
 r=public.zerochan_fleet_sender_report('30000000-0000-0000-0000-000000000777',repeat('c',64),g-1,1,snap);
 if r->>'status'='200' then raise exception 'bad generation accepted';end if;
end $$;
reset role;
do $$begin
 if exists(select 1 from public.zerochan_fleet_instances where id='30000000-0000-0000-0000-000000000777' and project_seen_at is not null) then raise exception 'rejected report marked launched';end if;
end $$;
set local role anon;
do $$declare g bigint; snap jsonb; r jsonb; t text; begin
 g=(public.zerochan_fleet_sender_begin('30000000-0000-0000-0000-000000000777',repeat('c',64))->>'generation')::bigint;
 snap='{"state":"available","project":"demo","queued":0,"lastAcceptedAt":null,"summary":null,"summaryAt":null,"slackConnected":true,"runnerHealthy":true}';
 r=public.zerochan_fleet_project_report('30000000-0000-0000-0000-000000000777',repeat('c',64),'demo',g,1,snap,null);
 if r->>'status'<>'200' then raise exception 'folder report rejected %',r;end if;
 perform public.zerochan_fleet_sender_begin('30000000-0000-0000-0000-000000000777',repeat('c',64));
 t=public.zerochan_fleet_login('20000000-0000-0000-0000-000000000077','fixture-gateway',repeat('b',64),'fixture-password')->>'token';
 r=public.zerochan_fleet_list(t);
 if jsonb_array_length(r->'instances')<>5 or (r->>'hidden')::int<>2 then raise exception 'reports/restart/same app different PC not retained %',r;end if;
 begin perform * from public.zerochan_fleet_instances;raise exception 'viewer table read';exception when insufficient_privilege then null;end;
end $$;
reset role;
-- Disabled rows do not contribute either visible or hidden counts.
update public.zerochan_fleet_instances set enabled=false where id in ('30000000-0000-0000-0000-000000000771','30000000-0000-0000-0000-000000000772');
set local role anon;
do $$declare r jsonb; t text;begin
 t=public.zerochan_fleet_login('20000000-0000-0000-0000-000000000077','fixture-gateway',repeat('e',64),'fixture-password')->>'token';r=public.zerochan_fleet_list(t);
 if jsonb_array_length(r->'instances')<>4 or (r->>'hidden')::int<>1 then raise exception 'disabled leaked';end if;
end $$;
rollback;
-- Remove fixture data so the other SQL suites can run on the migrated database.
delete from public.zerochan_fleet_instances where space_id='20000000-0000-0000-0000-000000000077';
delete from public.zerochan_fleet_viewers where space_id='20000000-0000-0000-0000-000000000077';
delete from public.zerochan_spaces where id='20000000-0000-0000-0000-000000000077';
delete from auth.users where id='10000000-0000-0000-0000-000000000077';
