\set ON_ERROR_STOP on
begin;
insert into public.zerochan_spaces values('70000000-0000-4000-8000-000000000001'),('70000000-0000-4000-8000-000000000002');
insert into public.zerochan_fleet_instances(id,space_id,installation_id,app_id,team_id,name,pc_label) values
 ('71000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','ATEST','TTEST','caller','PC'),
 ('71000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002','APEER','TTEST','peer','PC'),
 ('71000000-0000-4000-8000-000000000003','70000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000003','AOTHER','TTEST','OTHER-ONLY','PC'),
 ('71000000-0000-4000-8000-000000000004','70000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000004','ATEAM','TFOREIGN','FOREIGN TEAM','PC'),
 ('71000000-0000-4000-8000-000000000005','70000000-0000-4000-8000-000000000002','72000000-0000-4000-8000-000000000005','ASPACE','TTEST','FOREIGN SPACE','PC');
insert into public.zerochan_fleet_credentials select id,encode(extensions.digest(repeat(right(id::text,1),64),'sha256'),'hex'),now()+interval '1 day' from public.zerochan_fleet_instances where id::text like '71000000%';
set local role anon;
do $$declare r jsonb; s jsonb='{"state":"available","project":"BSB","queued":0,"lastAcceptedAt":null,"summary":null,"summaryAt":null,"slackConnected":true,"runnerHealthy":true}';
 caller uuid='71000000-0000-4000-8000-000000000001'; peer uuid='71000000-0000-4000-8000-000000000002'; other uuid='71000000-0000-4000-8000-000000000003';
 x integer; pid uuid;
begin
 for x in 1..5 loop
  pid=('71000000-0000-4000-8000-00000000000'||x)::uuid;
  perform public.zerochan_fleet_sender_begin(pid,repeat(x::text,64));
 end loop;
 -- No admin membership rows are ever inserted: authenticated reports establish folder membership.
 if public.zerochan_fleet_project_report(caller,repeat('1',64),'BSB',1,1,s)->>'status'<>'200' then raise exception 'automatic caller report'; end if;
 if public.zerochan_fleet_project_report(peer,repeat('2',64),'BSB',1,1,s||'{"state":"busy","queued":7,"summary":"OTHER PRIVATE","summaryAt":100,"lastAcceptedAt":100}', 'Other')->>'status'<>'200' then raise exception 'peer current report'; end if;
 if public.zerochan_fleet_project_report(other,repeat('3',64),'Other',1,1,s||'{"project":"Other"}')->>'status'<>'200' then raise exception 'other report'; end if;
 for x in 4..5 loop
  pid=('71000000-0000-4000-8000-00000000000'||x)::uuid;
  perform public.zerochan_fleet_project_report(pid,repeat(x::text,64),'BSB',1,1,s);
 end loop;
 r=public.zerochan_fleet_project_status(caller,repeat('1',64),'BSB');
 if r->>'status'<>'200' or jsonb_array_length(r->'instances')<>2 or r::text like '%PRIVATE%' or r::text like '%FOREIGN%' or r::text like '%OTHER-ONLY%' then raise exception 'cross-folder boundary'; end if;
 if not exists(select 1 from jsonb_array_elements(r->'instances') row where row->>'appId'='APEER' and row->'snapshot'->>'state'='waiting' and row->'snapshot'->>'queued'='0' and row->'snapshot'->'lastAcceptedAt'='null'::jsonb) then raise exception 'redacted occupancy'; end if;
 r=public.zerochan_fleet_project_status(peer,repeat('2',64),'Other');
 if jsonb_array_length(r->'instances')<>2 or r::text not like '%OTHER PRIVATE%' then raise exception 'current-folder match'; end if;
 if public.zerochan_fleet_project_status(caller,repeat('1',64),'Other')->>'status'<>'403' then raise exception 'unrelated request'; end if;
 if public.zerochan_fleet_project_status(peer,repeat('1',64),'BSB')->>'status'<>'401' then raise exception 'instance token mismatch'; end if;
 if public.zerochan_fleet_project_report(caller,repeat('1',64),'BSB',1,1,s)->>'status'<>'409' then raise exception 'replay'; end if;
 if public.zerochan_fleet_project_report(caller,repeat('1',64),'/private/BSB',1,2,s)->>'status'<>'400' then raise exception 'path accepted'; end if;
 if public.zerochan_fleet_project_report(peer,repeat('2',64),'BSB',1,2,s,null)->>'status'<>'200' then raise exception 'clear current'; end if;
 r=public.zerochan_fleet_project_status(other,repeat('3',64),'Other');
 if jsonb_array_length(r->'instances')<>1 then raise exception 'completed current retained'; end if;
 perform public.zerochan_fleet_sender_begin(peer,repeat('2',64));
 r=public.zerochan_fleet_project_status(caller,repeat('1',64),'BSB');
 if exists(select 1 from jsonb_array_elements(r->'instances') row where row->>'appId'='APEER' and row->'snapshot'<>'null'::jsonb) then raise exception 'old generation still active'; end if;
 -- Legacy heartbeat cannot borrow an old folder metadata sequence.
 perform public.zerochan_fleet_sender_report(peer,repeat('2',64),2,1,s);
 r=public.zerochan_fleet_project_status(caller,repeat('1',64),'BSB');
 if exists(select 1 from jsonb_array_elements(r->'instances') row where row->>'appId'='APEER' and row->'snapshot'<>'null'::jsonb) then raise exception 'legacy details leaked'; end if;
 begin perform * from public.zerochan_fleet_folders;raise exception 'folder table readable';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$declare r jsonb; s jsonb='{"state":"busy","project":"BSB","queued":0,"lastAcceptedAt":null,"summary":"Current Other work","summaryAt":null,"slackConnected":true,"runnerHealthy":true}'; begin
 r=public.zerochan_fleet_project_report('71000000-0000-4000-8000-000000000002',repeat('2',64),'BSB',2,2,s,'Other');
 if r->>'status'<>'200' or (select snapshot->>'project' from public.zerochan_fleet_instances where id='71000000-0000-4000-8000-000000000002')<>'Other' then raise exception 'dashboard work folder label mismatch'; end if;
end $$;
update public.zerochan_fleet_credentials set expires_at=now()-interval '1 second' where instance_id='71000000-0000-4000-8000-000000000001';
set local role anon;
do $$begin if public.zerochan_fleet_project_status('71000000-0000-4000-8000-000000000001',repeat('1',64),'BSB')->>'status'<>'401' then raise exception 'expired';end if;end $$;
reset role;
rollback;
