\set ON_ERROR_STOP on
begin;
insert into public.zerochan_spaces values('20000000-0000-4000-8000-000000000001');
insert into public.zerochan_fleet_viewers values('20000000-0000-4000-8000-000000000001','unused',encode(extensions.digest('test-gateway','sha256'),'hex'));
set local role anon;
do $$declare r jsonb; a uuid; b uuid; g bigint; token text=repeat('a',64); s uuid='20000000-0000-4000-8000-000000000001';
 snapshot jsonb='{"state":"available","project":"demo","queued":0,"lastAcceptedAt":null,"summary":null,"summaryAt":null,"slackConnected":true,"runnerHealthy":true}';
begin
 if public.zerochan_fleet_sender_throttle(s,'wrong','test-ip') then raise exception 'bad gateway accepted'; end if;
 for i in 1..60 loop if not public.zerochan_fleet_sender_throttle(s,'test-gateway','test-ip') then raise exception 'premature throttle'; end if; end loop;
 if public.zerochan_fleet_sender_throttle(s,'test-gateway','test-ip') then raise exception 'missing throttle'; end if;
 r=public.zerochan_fleet_sender_enroll(s,'wrong','30000000-0000-4000-8000-000000000001','ATEST','TTEST','test','PC',repeat('a',64));
 if r->>'status'<>'403' then raise exception 'untrusted enrollment'; end if;
 -- Digest computation by caller here is only a fixture: production Worker supplies the hash.
end $$;
reset role;
-- Existing authenticated sender migrates in place, retaining name/owner and history.
insert into auth.users values('50000000-0000-4000-8000-000000000001');
insert into public.zerochan_fleet_instances(user_id,space_id,installation_id,app_id,team_id,name,pc_label,sequence)
 values('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','AOLD','TTEST','Existing name','Existing PC',42);
do $$declare old_id uuid; a jsonb; b jsonb; begin
 select id into old_id from public.zerochan_fleet_instances where app_id='AOLD';
 a=public.zerochan_fleet_sender_enroll('20000000-0000-4000-8000-000000000001','test-gateway','60000000-0000-4000-8000-000000000001','AOLD','TTEST','New name','New PC',encode(extensions.digest(repeat('c',64),'sha256'),'hex'));
 b=public.zerochan_fleet_sender_enroll('20000000-0000-4000-8000-000000000001','test-gateway','60000000-0000-4000-8000-000000000001','AOLD','TTEST','New name','New PC',encode(extensions.digest(repeat('d',64),'sha256'),'hex'));
 if (a->>'instanceId')::uuid<>old_id or a->>'instanceId'<>b->>'instanceId' then raise exception 'identity replaced'; end if;
 if not exists(select 1 from public.zerochan_fleet_instances where id=old_id and name='Existing name' and pc_label='Existing PC' and sequence=42 and user_id='50000000-0000-4000-8000-000000000001') then raise exception 'legacy data changed'; end if;
 if public.zerochan_fleet_sender_begin(old_id,repeat('c',64))->>'status'<>'401' then raise exception 'old token accepted'; end if;
 if public.zerochan_fleet_sender_begin(old_id,repeat('d',64))->>'status'<>'200' then raise exception 'rotated token rejected'; end if;
end $$;
select encode(extensions.digest(repeat('a',64),'sha256'),'hex') as token_hash \gset
set local role anon;
select public.zerochan_fleet_sender_enroll('20000000-0000-4000-8000-000000000001','test-gateway','30000000-0000-4000-8000-000000000001','ATEST','TTEST','test','PC', :'token_hash')->>'instanceId' as instance \gset
select set_config('test.instance', :'instance', true);
do $$declare a uuid=current_setting('test.instance')::uuid; r jsonb; g bigint; token text=repeat('a',64);
 snapshot jsonb='{"state":"available","project":"demo","queued":0,"lastAcceptedAt":null,"summary":null,"summaryAt":null,"slackConnected":true,"runnerHealthy":true}';
begin
 if public.zerochan_fleet_sender_begin(a,repeat('b',64))->>'status'<>'401' then raise exception 'wrong token'; end if;
 r=public.zerochan_fleet_sender_begin(a,token); g=(r->>'generation')::bigint;
 if r->>'status'<>'200' then raise exception 'begin'; end if;
 if public.zerochan_fleet_sender_report(a,token,g,1,snapshot)->>'status'<>'200' then raise exception 'report'; end if;
 if public.zerochan_fleet_sender_report(a,token,g,1,snapshot)->>'status'<>'409' then raise exception 'replay'; end if;
 if public.zerochan_fleet_sender_report(a,token,g,2,snapshot||'{"extra":"secret"}'::jsonb)->>'status'<>'400' then raise exception 'extra field'; end if;
 if public.zerochan_fleet_sender_report(a,token,g,2,snapshot||'{"queued":0.5}'::jsonb)->>'status'<>'400' then raise exception 'fraction'; end if;
 if public.zerochan_fleet_sender_report(a,token,g,2,snapshot||'{"summary":42}'::jsonb)->>'status'<>'400' then raise exception 'summary type'; end if;
 if public.zerochan_fleet_sender_begin('40000000-0000-4000-8000-000000000001',token)->>'status'<>'401' then raise exception 'foreign instance'; end if;
 perform public.zerochan_fleet_sender_begin(a,token);
 if public.zerochan_fleet_sender_report(a,token,g,2,snapshot)->>'status'<>'409' then raise exception 'stale generation'; end if;
 if public.zerochan_fleet_list(token)->>'status'<>'401' then raise exception 'viewer access'; end if;
 begin perform * from public.zerochan_fleet_credentials; raise exception 'credential readable'; exception when insufficient_privilege then null; end;
 begin perform public.zerochan_fleet_begin(a,'30000000-0000-4000-8000-000000000001','ATEST'); raise exception 'legacy access'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$begin
 if (select user_id from public.zerochan_fleet_instances where id=current_setting('test.instance')::uuid) is not null then raise exception 'auth user required'; end if;
end $$;
update public.zerochan_fleet_credentials set expires_at=now()-interval '1 second' where instance_id= :'instance';
set local role anon;
do $$begin if public.zerochan_fleet_sender_begin(current_setting('test.instance')::uuid,repeat('a',64))->>'status'<>'401' then raise exception 'expired accepted'; end if; end $$;
reset role;
update public.zerochan_fleet_instances set enabled=false where id= :'instance';
set local role anon;
select public.zerochan_fleet_sender_enroll('20000000-0000-4000-8000-000000000001','test-gateway','30000000-0000-4000-8000-000000000001','ATEST','TTEST','test','PC', :'token_hash')->>'status' as disabled_status \gset
reset role;
select set_config('test.disabled', :'disabled_status', true);
do $$begin if current_setting('test.disabled')<>'403' then raise exception 'revived disabled registration'; end if; end $$;
rollback;
