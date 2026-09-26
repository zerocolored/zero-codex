\set ON_ERROR_STOP on
begin;
insert into public.zerochan_spaces values('70000000-0000-4000-8000-000000000001');
insert into public.zerochan_fleet_projects values
 ('70000000-0000-4000-8000-000000000001',repeat('a',64),'BSB'),
 ('70000000-0000-4000-8000-000000000001',repeat('b',64),'BSB');
insert into public.zerochan_fleet_project_apps values
 ('70000000-0000-4000-8000-000000000001',repeat('a',64),'TTEST','ATEST'),
 ('70000000-0000-4000-8000-000000000001',repeat('a',64),'TTEST','APEER'),
 ('70000000-0000-4000-8000-000000000001',repeat('b',64),'TTEST','AOTHER');
insert into public.zerochan_fleet_instances(id,space_id,installation_id,app_id,team_id,name,pc_label) values
 ('71000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','ATEST','TTEST','caller','PC'),
 ('71000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002','APEER','TTEST','peer','PC'),
 ('71000000-0000-4000-8000-000000000003','70000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000003','AOTHER','TTEST','PRIVATE OTHER','PC');
insert into public.zerochan_fleet_credentials select id,encode(extensions.digest(repeat(right(id::text,1),64),'sha256'),'hex'),now()+interval '1 day' from public.zerochan_fleet_instances where space_id='70000000-0000-4000-8000-000000000001';
set local role anon;
do $$declare r jsonb; s jsonb='{"state":"available","project":"untrusted name","queued":0,"lastAcceptedAt":null,"summary":null,"summaryAt":null,"slackConnected":true,"runnerHealthy":true}';
 caller uuid='71000000-0000-4000-8000-000000000001'; peer uuid='71000000-0000-4000-8000-000000000002'; other uuid='71000000-0000-4000-8000-000000000003';
begin
 perform public.zerochan_fleet_sender_begin(caller,repeat('1',64));
 perform public.zerochan_fleet_sender_begin(peer,repeat('2',64));
 perform public.zerochan_fleet_sender_begin(other,repeat('3',64));
 if public.zerochan_fleet_project_report(caller,repeat('1',64),repeat('b',64),1,1,s)->>'status'<>'403' then raise exception 'forged membership'; end if;
 if public.zerochan_fleet_project_report(caller,repeat('1',64),repeat('a',64),1,1,s)->>'status'<>'200' then raise exception 'caller report'; end if;
 if public.zerochan_fleet_project_report(peer,repeat('2',64),repeat('a',64),1,1,s)->>'status'<>'200' then raise exception 'peer report'; end if;
 if public.zerochan_fleet_project_report(other,repeat('3',64),repeat('b',64),1,1,s||'{"summary":"PRIVATE OTHER"}')->>'status'<>'200' then raise exception 'other report'; end if;
 r=public.zerochan_fleet_project_status(caller,repeat('1',64),repeat('a',64));
 if r->>'status'<>'200' or jsonb_array_length(r->'instances')<>2 or r::text like '%PRIVATE%' then raise exception 'cross-project leak'; end if;
 if public.zerochan_fleet_project_status(caller,repeat('1',64),repeat('b',64))->>'status'<>'403' then raise exception 'project query escalation'; end if;
 if public.zerochan_fleet_project_status(peer,repeat('1',64),repeat('a',64))->>'status'<>'401' then raise exception 'instance token mismatch'; end if;
 if public.zerochan_fleet_project_report(caller,repeat('1',64),repeat('a',64),1,1,s)->>'status'<>'409' then raise exception 'replay'; end if;
 perform public.zerochan_fleet_sender_begin(peer,repeat('2',64));
 r=public.zerochan_fleet_project_status(caller,repeat('1',64),repeat('a',64));
 if exists(select 1 from jsonb_array_elements(r->'instances') x where x->>'appId'='APEER' and x->'snapshot'<>'null'::jsonb) then raise exception 'old generation still active'; end if;
 begin perform * from public.zerochan_fleet_project_apps;raise exception 'membership readable';exception when insufficient_privilege then null;end;
 begin insert into public.zerochan_fleet_project_apps values('70000000-0000-4000-8000-000000000001',repeat('b',64),'TTEST','ATEST');raise exception 'membership writable';exception when insufficient_privilege then null;end;
end $$;
reset role;
update public.zerochan_fleet_credentials set expires_at=now()-interval '1 second' where instance_id='71000000-0000-4000-8000-000000000001';
set local role anon;
do $$begin if public.zerochan_fleet_project_status('71000000-0000-4000-8000-000000000001',repeat('1',64),repeat('a',64))->>'status'<>'401' then raise exception 'expired';end if;end $$;
reset role;
rollback;
