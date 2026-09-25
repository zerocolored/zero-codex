\set ON_ERROR_STOP on
begin;
insert into auth.users values('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002');
insert into public.zerochan_spaces values('20000000-0000-4000-8000-000000000001'),('20000000-0000-4000-8000-000000000002');
insert into public.zerochan_fleet_senders(user_id,space_id,team_id) values
 ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','TTEST'),
 ('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','TTEST');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$declare a uuid; b uuid; c uuid; g bigint;
begin
 a=public.zerochan_fleet_register('30000000-0000-4000-8000-000000000001','ANEW','TTEST','New','PC1');
 if a<>public.zerochan_fleet_register('30000000-0000-4000-8000-000000000001','ANEW','TTEST','Changed','PC2') then raise exception 'duplicate'; end if;
 b=public.zerochan_fleet_register('30000000-0000-4000-8000-000000000002','ANEW','TTEST','New','PC2');
 c=public.zerochan_fleet_register('30000000-0000-4000-8000-000000000001','ANEXT','TTEST','Next','PC1');
 if a=b or a=c or b=c then raise exception 'identity collision'; end if;
 g=public.zerochan_fleet_begin(a,'30000000-0000-4000-8000-000000000001','ANEW');
 if not public.zerochan_fleet_report(a,g,1,'{"state":"unknown","project":"test","queued":0,"lastAcceptedAt":null,"summary":null,"summaryAt":null,"slackConnected":false,"runnerHealthy":false}') then raise exception 'report failed'; end if;
 if public.zerochan_fleet_context('TOTHER') is not null then raise exception 'wrong team'; end if;
 begin perform public.zerochan_fleet_register('30000000-0000-4000-8000-000000000001','ANEW','TOTHER','New','PC1'); raise exception 'unscoped accepted';
 exception when raise_exception then if sqlerrm<>'monitoring authentication not enrolled' then raise; end if; end;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$begin
 begin perform public.zerochan_fleet_register('30000000-0000-4000-8000-000000000001','ANEW','TTEST','Steal','PC1'); raise exception 'stolen';
 exception when raise_exception then if sqlerrm<>'monitoring registration unavailable' then raise; end if; end;
end $$;
reset role;
do $$begin if (select name from public.zerochan_fleet_instances where app_id='ANEW' and pc_label='PC1')<>'New' then raise exception 'renamed'; end if; end $$;
update public.zerochan_fleet_instances set enabled=false where app_id='ANEXT';
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$begin
 begin perform public.zerochan_fleet_register('30000000-0000-4000-8000-000000000001','ANEXT','TTEST','Revive','PC1'); raise exception 'revived';
 exception when raise_exception then if sqlerrm<>'monitoring registration unavailable' then raise; end if; end;
end $$;
set local role anon;
do $$begin
 begin perform public.zerochan_fleet_register('30000000-0000-4000-8000-000000000001','AX','TTEST','Anonymous','PC'); raise exception 'anonymous write';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
-- An enrolled handoff identity needs no per-instance enrollment; a disabled
-- member cannot use this route. Multiple spaces for one team are not guessed.
delete from public.zerochan_fleet_senders where user_id='10000000-0000-4000-8000-000000000002';
insert into public.zerochan_members(user_id,space_id,slack_team_id,slack_bot_id)
 values('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','TTEST','UBOT');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$begin
 if public.zerochan_fleet_context('TTEST')<>'20000000-0000-4000-8000-000000000002'::uuid then raise exception 'member scope missing'; end if;
end $$;
reset role;
update public.zerochan_members set enabled=false;
set local role authenticated;
do $$begin if public.zerochan_fleet_context('TTEST') is not null then raise exception 'disabled member accepted'; end if; end $$;
reset role;
insert into public.zerochan_fleet_senders(user_id,space_id,team_id) values
 ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','TTEST');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$begin
 begin perform public.zerochan_fleet_context('TTEST'); raise exception 'ambiguous space accepted';
 exception when raise_exception then if sqlerrm<>'ambiguous monitoring space' then raise; end if; end;
end $$;
rollback;
