\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values('10000000-0000-0000-0000-000000000001'),('10000000-0000-0000-0000-000000000002');
insert into public.zerochan_spaces(id) values('20000000-0000-0000-0000-000000000001'),('20000000-0000-0000-0000-000000000002');
insert into public.zerochan_fleet_instances(id,user_id,space_id,installation_id,app_id,team_id,name,pc_label) values
 ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','ATEST','TTEST','Test','Test PC'),
 ('30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000002','AOTHER','TOTHER','Other space','Other PC');
insert into public.zerochan_fleet_viewers values('20000000-0000-0000-0000-000000000001',extensions.crypt('test-only-password',extensions.gen_salt('bf')),encode(extensions.digest('test-only-gateway','sha256'),'hex'));
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
do $$declare g bigint; accepted boolean;
begin
 g=public.zerochan_fleet_begin('30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','ATEST');
 accepted=public.zerochan_fleet_report('30000000-0000-0000-0000-000000000001',g,2,'{"state":"available","project":"demo","queued":0,"lastAcceptedAt":null,"summary":null,"summaryAt":null,"slackConnected":true,"runnerHealthy":true}');
 if not accepted then raise exception 'report failed'; end if;
 begin perform public.zerochan_fleet_report('30000000-0000-0000-0000-000000000001',g,3,'{"state":"busy","project":"demo","queued":0,"lastAcceptedAt":1e100,"summary":null,"summaryAt":null,"slackConnected":true,"runnerHealthy":true}');raise exception 'invalid date accepted';
 exception when raise_exception then if sqlerrm<>'invalid fleet values' then raise; end if; end;
 begin perform public.zerochan_fleet_report('30000000-0000-0000-0000-000000000001',g,3,'{"state":null,"project":"demo","queued":0,"lastAcceptedAt":null,"summary":null,"summaryAt":null,"slackConnected":true,"runnerHealthy":true}');raise exception 'invalid state accepted';
 exception when raise_exception then if sqlerrm<>'invalid fleet fields' then raise; end if; end;
 if public.zerochan_fleet_report('30000000-0000-0000-0000-000000000001',g,1,'{"state":"busy","project":"demo","queued":0,"lastAcceptedAt":null,"summary":null,"summaryAt":null,"slackConnected":true,"runnerHealthy":true}') then raise exception 'out of order accepted'; end if;
 perform public.zerochan_fleet_begin('30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','ATEST');
 if public.zerochan_fleet_report('30000000-0000-0000-0000-000000000001',g,3,'{"state":"busy","project":"demo","queued":0,"lastAcceptedAt":null,"summary":null,"summaryAt":null,"slackConnected":true,"runnerHealthy":true}') then raise exception 'old generation accepted'; end if;
 begin perform * from public.zerochan_fleet_instances; raise exception 'table readable'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
do $$begin
 begin perform public.zerochan_fleet_begin('30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','ATEST');raise exception 'identity spoof accepted';
 exception when raise_exception then if sqlerrm<>'fleet registration unavailable' then raise; end if; end;
end $$;
set local role anon;
do $$declare r jsonb; token text;
begin
 if public.zerochan_fleet_login('20000000-0000-0000-0000-000000000001',null,repeat('a',64),'test-only-password')->>'status'<>'503' then raise exception 'null gateway accepted'; end if;
 if public.zerochan_fleet_login('20000000-0000-0000-0000-000000000001','test-only-gateway',repeat('a',64),repeat('x',73))->>'status'<>'400' then raise exception 'bcrypt truncation allowed'; end if;
 if public.zerochan_fleet_list('invalid')->>'status'<>'401' then raise exception 'anonymous read'; end if;
 r=public.zerochan_fleet_login('20000000-0000-0000-0000-000000000001','test-only-gateway',repeat('a',64),'test-only-password');
 token=r->>'token';if r->>'status'<>'200' then raise exception 'login failed';end if;
 if jsonb_array_length(public.zerochan_fleet_list(token)->'instances')<>1 then raise exception 'list failed';end if;
 perform public.zerochan_fleet_logout(token);
 if public.zerochan_fleet_list(token)->>'status'<>'401' then raise exception 'logout failed';end if;
 for i in 1..10 loop perform public.zerochan_fleet_login('20000000-0000-0000-0000-000000000001','test-only-gateway',repeat('b',64),'wrong');end loop;
 if public.zerochan_fleet_login('20000000-0000-0000-0000-000000000001','test-only-gateway',repeat('b',64),'test-only-password')->>'status'<>'429' then raise exception 'throttle failed';end if;
 begin perform public.zerochan_fleet_begin('30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','ATEST');raise exception 'viewer wrote';exception when insufficient_privilege then null;end;
end $$;
rollback;
